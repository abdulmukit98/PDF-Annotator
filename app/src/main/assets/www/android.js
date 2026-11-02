'use strict';
/**
 * Android glue: connects the app to MainActivity through the "Android"
 * JavaScript interface.
 *
 *   Open:  A.openDocument()  -> system picker -> __android.opened(name)
 *          -> fetch /doc/current.pdf -> PdfAnnotator.openFile(file, target)
 *   Save:  A.beginSave(mode, name) -> __android.saveReady(ok)
 *          -> A.saveChunk(...) x N, A.finishSave() -> __android.saveDone(ok)
 */
(() => {
  // Older WebViews (before Chrome 86) lack replaceChildren.
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function (...nodes) {
      while (this.firstChild) this.removeChild(this.firstChild);
      this.append(...nodes);
    };
  }

  const A = window.Android;
  if (!A) return;                         // not running inside the Android app

  const CHUNK = 384 * 1024;               // bytes per call into Java (~512 KB as base64)
  let waiter = null;                      // the save currently in progress

  const toBase64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };

  /** Send bytes to Android. mode: 'inplace' (overwrite the opened file) or 'copy' (ask where to save). */
  function nativeWrite(bytes, mode, name) {
    return new Promise((resolve, reject) => {
      waiter = {
        ready(ok, msg) {
          if (!ok) {
            const err = new Error(msg || 'Save failed');
            if (msg === 'cancelled') err.code = 'declined';
            reject(err);
            return;
          }
          try {
            for (let i = 0; i < bytes.length; i += CHUNK) A.saveChunk(toBase64(bytes.subarray(i, i + CHUNK)));
            A.finishSave();
          } catch (e) { reject(e); }
        },
        done(ok, msg) { if (ok) resolve(); else reject(new Error(msg || 'Save failed')); }
      };
      A.beginSave(mode, name);
    });
  }

  // Called by MainActivity.
  window.__android = {
    async opened(name) {
      try {
        const res = await fetch('/doc/current.pdf?t=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const file = new File([await res.arrayBuffer()], name, { type: 'application/pdf' });
        window.PdfAnnotator.openFile(file, { kind: 'host', write: (bytes) => nativeWrite(bytes, 'inplace', name) });
      } catch (e) {
        console.error(e);
        document.getElementById('empty').textContent = 'Could not read that file.';
        document.getElementById('empty').hidden = false;
      }
    },
    saveReady(ok, msg) { if (waiter) waiter.ready(ok, msg); },
    saveDone(ok, msg) { if (waiter) waiter.done(ok, msg); }
  };

  // Hooks used by the app (see "HOSTS" in the documentation at the top of index.html).
  window.PdfAnnotator.host = {
    openDialog: () => A.openDocument(),
    saveCopy: (bytes, name) => nativeWrite(bytes, 'copy', name)
  };

  A.ready();
})();
