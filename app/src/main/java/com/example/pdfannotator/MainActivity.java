package com.example.pdfannotator;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the PDF Annotator web app in a WebView.
 *
 * - The app's files live in assets/www and are served from a private https
 *   address (WebViewAssetLoader), so no internet access is needed.
 * - The opened PDF is streamed to the page at /doc/current.pdf.
 * - Files are opened and saved through Android's Storage Access Framework
 *   (the system file picker), so the app needs no storage permission.
 * - The page talks to this class through the "Android" JavaScript interface
 *   (see assets/www/android.js).
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final int REQ_OPEN = 1;
    private static final int REQ_CREATE = 2;

    private WebView web;
    private WebViewAssetLoader loader;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private Uri currentUri;                 // the PDF that is open (save-in-place target)
    private String currentName = "document.pdf";
    private Uri pendingOpen;                // a PDF requested before the page finished loading
    private boolean pageReady = false;

    private Uri saveUri;                    // where the next save goes
    private ByteArrayOutputStream saveBuf;  // bytes received from the page, written in one go at the end

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);   // chrome://inspect works for debug builds
        }

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage: drafts and bookmarks
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);               // the app handles pinch-zoom itself
        s.setBuiltInZoomControls(false);

        loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/doc/", this::serveDocument)
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !HOST.equals(request.getUrl().getHost());   // never leave the app
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("https://" + HOST + "/assets/www/index.html");

        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onDestroy() {
        io.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** "Open with" from another app. */
    private void handleIntent(Intent intent) {
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            openUri(intent.getData(), false);
        }
    }

    /** Remember the chosen PDF and tell the page to load it. */
    private void openUri(Uri uri, boolean persist) {
        if (persist) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (Exception ignored) {
                // some providers do not offer persistable grants; the current session still works
            }
        }
        currentUri = uri;
        currentName = displayName(uri);
        if (pageReady) notifyOpened(); else pendingOpen = uri;
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                String n = c.getString(0);
                if (n != null && !n.isEmpty()) return n;
            }
        } catch (Exception ignored) {
            // fall through to the default name
        }
        return "document.pdf";
    }

    /** Streams the current PDF to the page (GET /doc/current.pdf). */
    private WebResourceResponse serveDocument(String path) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        try {
            InputStream in = currentUri == null ? null : getContentResolver().openInputStream(currentUri);
            if (in != null) return new WebResourceResponse("application/pdf", null, 200, "OK", headers, in);
        } catch (Exception ignored) {
            // fall through to 404
        }
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers,
                new ByteArrayInputStream(new byte[0]));
    }

    // ---- calls into the page -------------------------------------------------------------

    private void callJs(String js) {
        runOnUiThread(() -> web.evaluateJavascript(js, null));
    }

    private void notifyOpened() {
        callJs("window.__android && window.__android.opened(" + JSONObject.quote(currentName) + ")");
    }

    private void saveReady(boolean ok, String message) {
        callJs("window.__android && window.__android.saveReady(" + ok + "," + JSONObject.quote(message) + ")");
    }

    private void saveDone(boolean ok, String message) {
        callJs("window.__android && window.__android.saveDone(" + ok + "," + JSONObject.quote(message) + ")");
    }

    // ---- results from the system file picker -------------------------------------------

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        boolean ok = resultCode == RESULT_OK && data != null && data.getData() != null;
        if (requestCode == REQ_OPEN && ok) {
            openUri(data.getData(), true);
        } else if (requestCode == REQ_CREATE) {
            if (ok) {
                saveUri = data.getData();
                saveReady(true, "");
            } else {
                saveReady(false, "cancelled");
            }
        }
    }

    // ---- methods the page can call -------------------------------------------------------

    private class Bridge {
        /** The page finished loading and can receive a file. */
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                pageReady = true;
                if (pendingOpen != null) {
                    pendingOpen = null;
                    notifyOpened();
                }
            });
        }

        /** Show the system file picker to choose a PDF. */
        @JavascriptInterface
        public void openDocument() {
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/pdf");
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
                startActivityForResult(i, REQ_OPEN);
            });
        }

        /**
         * Start a save. mode "inplace" overwrites the opened file; mode "copy"
         * asks the user where to save a new file. The page is told through
         * saveReady() when it may send the bytes.
         */
        @JavascriptInterface
        public void beginSave(String mode, String name) {
            runOnUiThread(() -> {
                saveBuf = new ByteArrayOutputStream();
                if ("inplace".equals(mode)) {
                    if (currentUri == null) {
                        saveReady(false, "No file is open.");
                    } else {
                        saveUri = currentUri;
                        saveReady(true, "");
                    }
                } else {
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("application/pdf");
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    startActivityForResult(i, REQ_CREATE);
                }
            });
        }

        /** One piece of the PDF, base64 encoded. */
        @JavascriptInterface
        public void saveChunk(String base64) {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            saveBuf.write(bytes, 0, bytes.length);
        }

        /** All pieces sent: write them to the chosen file. */
        @JavascriptInterface
        public void finishSave() {
            final Uri target = saveUri;
            final ByteArrayOutputStream data = saveBuf;
            io.execute(() -> {
                try (OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                    if (out == null) throw new IOException("Android could not open the file for writing.");
                    data.writeTo(out);
                    out.flush();
                    saveDone(true, "");
                } catch (SecurityException e) {
                    saveDone(false, "Android did not allow writing to this file. Use \"Save copy\" instead.");
                } catch (Exception e) {
                    saveDone(false, String.valueOf(e.getMessage()));
                }
            });
        }
    }
}
