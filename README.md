# PDF Annotator for Android

The PDF Annotator app as an Android app (APK): pen, line, rectangle, text notes,
text highlight, area highlight, eraser, 60-colour palette, undo/redo, bookmarks,
and saving your changes **into the PDF file itself**. It works fully offline.

Made for Android 8 to 14. Tested design target: Realme C25Y (Android 11, 6.5" screen).

## Get the APK (pick one way)

### A. Without installing anything on your PC (GitHub, free)
1. Create a free account at github.com and make a new repository.
2. Upload everything from this folder to it (keep the folder structure, including the
   hidden `.github` folder), or use `git push`.
3. Open the repository's **Actions** tab, choose **Build APK**, click **Run workflow**.
4. When it finishes (about 5 minutes), open the run and download **pdf-annotator-apk**.
   Unzip it to get `app-debug.apk`.

### B. With Android Studio
1. Install Node.js LTS (nodejs.org) and Android Studio (developer.android.com/studio).
2. In this folder run `npm install` (downloads pdf.js and pdf-lib into the app).
3. Open this folder in Android Studio and wait for Gradle sync (it downloads what it needs).
4. Menu **Build > Build App Bundle(s) / APK(s) > Build APK(s)**.
5. The file is `app/build/outputs/apk/debug/app-debug.apk`.

### C. Command line
Needs Node.js, JDK 17, the Android SDK (platform 34) and Gradle 8.5:

    npm install
    gradle assembleDebug

## Install on the phone
1. Copy `app-debug.apk` to the phone (USB cable, Bluetooth, Google Drive, WhatsApp to yourself...).
2. Open it from the Files app. If asked, allow installing apps from that source, then tap Install.
   If Play Protect warns about an unknown app, choose Install anyway. The app is signed
   with a debug key because it is built for personal use.

## Using it on the phone
- **Open PDF** shows Android's file picker. Choose a file from Downloads, Documents, etc.
  You can also open a PDF from a file manager or Chrome with **Open with > PDF Annotator**.
- The toolbar scrolls sideways. Tools: Scroll, Select, Pen, Line, Rectangle, Text,
  Highlight, Area, Eraser. **More colours** opens the full palette.
- One finger draws with the selected tool. Use the **Scroll** tool to move around with one
  finger, or use **two fingers** to pan and pinch-zoom with any tool.
- Text notes: tap, type, then tap somewhere else to finish.
- **Save** writes your changes into the same PDF. **Save copy** creates a new file where you choose.
  Some places (certain cloud storage apps, or files opened from some other apps) do not
  allow overwriting. If Save says so, use **Save copy**.
- Annotations are real PDF annotations, so other PDF readers show them. When you reopen
  the file here, you can still erase them (and move, resize or recolour text notes).
- Keep a backup of important PDFs: Save replaces the file you opened.
- Unsaved work is kept as a draft and comes back if you reopen the same file.

## If something goes wrong
- **White screen or buttons missing:** update *Android System WebView* and *Google Chrome*
  in the Play Store, then restart the app.
- **Save fails:** use **Save copy**.
- **Text note shows `?`:** note text is saved with the Helvetica font, which has Latin-1
  characters only (no Bengali, Chinese, etc.).
- **Gradle "SDK location not found":** create `local.properties` with
  `sdk.dir=C\:\\Users\\YOU\\AppData\\Local\\Android\\Sdk` (Android Studio does this for you).

## Project layout

    app/src/main/java/.../MainActivity.java   WebView host, file picker, saving (Storage Access Framework)
    app/src/main/assets/www/index.html        the app's page (documentation at the top)
    app/src/main/assets/www/app.js            the app's code
    app/src/main/assets/www/android.js        connects the app to MainActivity
    app/src/main/assets/www/vendor/           pdf.js and pdf-lib (filled by `npm install`)
    scripts/prepare-vendor.js                 copies the libraries after `npm install`
    .github/workflows/build-apk.yml           cloud build

How it works: the app runs in a WebView and is served from a private address inside the
APK, so no internet is needed. The opened PDF is streamed to the page; saving sends the
new PDF back in pieces and MainActivity writes it to the file Android gave access to.
No storage permission is needed because Android's own file picker grants access to the
chosen file only.

To change the app name or icon, edit `res/values/strings.xml` and
`res/drawable/ic_foreground.xml`. To change the application id, edit `app/build.gradle`.
