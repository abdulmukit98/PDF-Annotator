'use strict';
/**
 * Copies the PDF libraries from node_modules into the app's assets so the app
 * works fully offline. Runs automatically after `npm install`.
 * pdf.js uses its "legacy" build, which also runs on older Android WebViews.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'app', 'src', 'main', 'assets', 'www', 'vendor');
fs.mkdirSync(out, { recursive: true });

const pick = (...candidates) => {
  for (const c of candidates) {
    const p = path.join(root, 'node_modules', c);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('Not found in node_modules: ' + candidates.join(' or '));
};

const files = [
  [pick('pdfjs-dist/legacy/build/pdf.min.js', 'pdfjs-dist/build/pdf.min.js'), 'pdf.min.js'],
  [pick('pdfjs-dist/legacy/build/pdf.worker.min.js', 'pdfjs-dist/build/pdf.worker.min.js'), 'pdf.worker.min.js'],
  [pick('pdf-lib/dist/pdf-lib.min.js'), 'pdf-lib.min.js']
];
for (const [from, to] of files) {
  fs.copyFileSync(from, path.join(out, to));
  console.log('vendor:', to);
}
