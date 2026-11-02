(() => {
'use strict';

/* ===================== 1. CONFIG & STATE ===================== */

/** Tunable constants. */
const CFG = {
  minScale: 0.5, maxScale: 4, zoomStep: 0.25,
  maxDpr: 2,                 // cap pixel ratio: higher values cause lag
  rootMargin: '800px 0px',   // render pages this far outside the viewport
  rerenderDelay: 150,        // ms to wait after zoom before sharp re-render
  eraseTolerancePx: 6,       // extra hit area for the eraser (screen px)
  highlightColor: '#ffeb3b',   // colour selected when a highlight tool is chosen
  swatches: ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#000000', '#ffeb3b', '#76ff03', '#ff80ab', '#40c4ff']
};

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'vendor/pdf.worker.min.js';

/**
 * @typedef {{type:'pen',color:string,width:number,points:{x:number,y:number}[]}} PenAnn
 * @typedef {{type:'line'|'rect',color:string,width:number,x1:number,y1:number,x2:number,y2:number}} ShapeAnn
 * @typedef {{type:'text',color:string,width:number,size:number,x:number,y:number,text:string}} TextAnn
 *   (x, y) is the top-left corner; `width` is only used as eraser hit thickness.
 * @typedef {PenAnn|ShapeAnn|TextAnn} Annotation   All values are in PDF units.
 */

/** Single source of truth for the app. */
const state = {
  doc: null, bytes: null, fileName: 'document.pdf', fileKey: '', scale: 1,
  target: null,   // where Save writes: { kind: 'path', path } (desktop) or { kind: 'handle', handle } (browser)
  dirty: false,   // unsaved changes since opening / last save
  tool: 'pen', color: '#e53935', width: 4,
  /** @type {Array<{num:number,el:HTMLElement,canvas:HTMLCanvasElement,overlay:HTMLCanvasElement,w:number,h:number,task:any,token:number,rendered:boolean}>} */
  pages: [],
  /** @type {Map<number, Annotation[]>} page number to annotations */
  annotations: new Map(),
  undo: [], redo: [],
  /** @type {{id:number,page:number,label:string}[]} */
  bookmarks: [],
  current: 1,
  /** @type {{page:number,ann:TextAnn}|null} text note chosen with the Select tool */
  selected: null,
  hlPad: 2.5   // extra text-highlight height above and below each line, in mm
};
const visible = new Set();   // pages currently near the viewport

const $ = (id) => document.getElementById(id);
const ui = {
  viewer: $('viewer'), pages: $('pages'), empty: $('empty'),
  pageNo: $('pageNo'), pageCount: $('pageCount'), zoomLbl: $('zoomLbl'),
  undo: $('undo'), redo: $('redo'), preview: $('preview'),
  side: $('side'), bmList: $('bmList')
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const MM = 72 / 25.4;   // PDF units (points) per millimetre

/* ===================== 2. GEOMETRY HELPERS ===================== */

/** Distance from point p to the segment a-b. */
function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* Text metrics shared by the editor, the renderer and the eraser. */
const TEXT_LH = 1.25;                                   // line height multiplier
const measureCtx = document.createElement('canvas').getContext('2d');
const textFont = (size) => `${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;

/** Split text into lines and measure each line's width (PDF units). */
function measureLines(text, size) {
  measureCtx.font = textFont(size);
  const lines = text.split('\n');
  return { lines, widths: lines.map((l) => measureCtx.measureText(l).width) };
}

/** Break an annotation into line segments for eraser hit-testing. */
function segmentsOf(a) {
  if (a.type === 'text') {   // one mid-line segment per text line
    return measureLines(a.text, a.size).widths.map((w, i) => {
      const y = a.y + (i + 0.5) * a.size * TEXT_LH;
      return [{ x: a.x, y }, { x: a.x + w, y }];
    });
  }
  if (a.type === 'pen') {
    return a.points.length === 1
      ? [[a.points[0], a.points[0]]]
      : a.points.slice(1).map((pt, i) => [a.points[i], pt]);
  }
  const p1 = { x: a.x1, y: a.y1 }, p2 = { x: a.x2, y: a.y1 };
  const p3 = { x: a.x2, y: a.y2 }, p4 = { x: a.x1, y: a.y2 };
  return a.type === 'line' ? [[p1, p3]] : [[p1, p2], [p2, p3], [p3, p4], [p4, p1]];
}

/* ===================== 3. DRAWING ===================== */

/** Draw one annotation. The context is already scaled to PDF units. */
function drawAnnotation(ctx, a) {
  if (a.type === 'text') return drawText(ctx, a);
  if (a.type === 'hl' || a.type === 'area') return drawHighlight(ctx, a);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = a.color; ctx.lineWidth = a.width;
  ctx.beginPath();
  if (a.type === 'pen') {
    ctx.moveTo(a.points[0].x, a.points[0].y);
    if (a.points.length === 1) ctx.lineTo(a.points[0].x, a.points[0].y); // dot
    for (let i = 1; i < a.points.length; i++) ctx.lineTo(a.points[i].x, a.points[i].y);
  } else if (a.type === 'line') {
    ctx.moveTo(a.x1, a.y1); ctx.lineTo(a.x2, a.y2);
  } else {
    ctx.rect(Math.min(a.x1, a.x2), Math.min(a.y1, a.y2), Math.abs(a.x2 - a.x1), Math.abs(a.y2 - a.y1));
  }
  ctx.stroke();
}

/** Draw a text note, one line at a time (middle baseline matches the editor). */
function drawText(ctx, a) {
  ctx.font = textFont(a.size); ctx.fillStyle = a.color;
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  a.text.split('\n').forEach((line, i) => ctx.fillText(line, a.x, a.y + (i + 0.5) * a.size * TEXT_LH));
}

/** Is the point inside the rectangle (corners x1,y1,x2,y2), with tolerance? */
function inRect(pt, x1, y1, x2, y2, tol) {
  return pt.x >= Math.min(x1, x2) - tol && pt.x <= Math.max(x1, x2) + tol &&
         pt.y >= Math.min(y1, y2) - tol && pt.y <= Math.max(y1, y2) + tol;
}

/** Eraser hit-test: filled for highlights, near-the-line for everything else. */
function hitTest(a, pt, tol) {
  if (a.type === 'area') return inRect(pt, a.x1, a.y1, a.x2, a.y2, tol);
  if (a.type === 'hl') return a.rects.some((r) => inRect(pt, r.x, r.y, r.x + r.w, r.y + r.h, tol));
  return segmentsOf(a).some(([s, e]) => distToSegment(pt, s, e) <= a.width / 2 + tol);
}

/** Paint a text highlight (many rects) or an area highlight (one rect), translucent. */
function drawHighlight(ctx, a) {
  const rects = a.type === 'hl' ? a.rects
    : [{ x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) }];
  ctx.save(); ctx.globalAlpha = 0.8; ctx.fillStyle = a.color;
  ctx.beginPath();                      // one path: overlapping rectangles are filled once
  rects.forEach((r) => ctx.rect(r.x, r.y, r.w, r.h));
  ctx.fill();
  ctx.restore();
}

/**
 * Rectangle covering the fraction f0..f1 of a text item's width, including
 * a little ascender/descender room. Works for rotated pages via the vectors
 * stored in the item (O = origin, u = direction, h = up vector, w = width).
 * `pad` adds extra height above and below the line (PDF units; 1 mm = 2.835).
 */
function rectFor(it, f0, f1, pad = 0) {
  const hl = Math.hypot(it.h.x, it.h.y) || 1;               // font height in PDF units
  const lo = -0.22 - pad / hl, hi = 0.92 + pad / hl;         // below / above the baseline
  const xs = [], ys = [];
  for (const f of [f0, f1]) {
    const x = it.O.x + it.u.x * it.w * f, y = it.O.y + it.u.y * it.w * f;
    for (const k of [lo, hi]) { xs.push(x + it.h.x * k); ys.push(y + it.h.y * k); }
  }
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Read a page's text positions (PDF units, scale 1) once, for the Highlight tool. */
async function loadText(p) {
  if (p.text || p.textBusy || !state.doc) return;
  p.textBusy = true;
  try {
    const page = await state.doc.getPage(p.num);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    p.text = tc.items.filter((it) => it.str && it.str.trim() && it.width > 0).map((it) => {
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      const len = Math.hypot(t[0], t[1]) || 1;
      const item = { O: { x: t[4], y: t[5] }, u: { x: t[0] / len, y: t[1] / len }, h: { x: t[2], y: t[3] }, w: it.width, n: it.str.length };
      item.box = rectFor(item, 0, 1);
      return item;
    });
  } catch (e) { console.error(e); p.text = []; }
  finally { p.textBusy = false; }
}

/** Distance from a point to a rectangle (0 when inside). */
function distToBox(pt, r) {
  return Math.hypot(Math.max(r.x - pt.x, 0, pt.x - (r.x + r.w)), Math.max(r.y - pt.y, 0, pt.y - (r.y + r.h)));
}

/**
 * Join the pieces that lie on the same text line into one continuous rectangle,
 * so the spaces between words are covered and the highlight has no gaps.
 * Two pieces share a line when their baselines are less than half a font height apart.
 * @param {{it: object, r: {x:number,y:number,w:number,h:number}}[]} parts   in reading order
 */
function mergeLines(parts) {
  const lines = [];
  for (const { it, r } of parts) {
    const fs = Math.hypot(it.h.x, it.h.y) || 1;               // font height of this piece
    const last = lines[lines.length - 1];
    if (last) {
      const d = Math.abs((it.O.x - last.O.x) * it.h.x / fs + (it.O.y - last.O.y) * it.h.y / fs);   // baseline distance
      if (d < Math.min(fs, last.fs) * 0.5) {
        const x0 = Math.min(last.x, r.x), y0 = Math.min(last.y, r.y);
        last.w = Math.max(last.x + last.w, r.x + r.w) - x0; last.h = Math.max(last.y + last.h, r.y + r.h) - y0;
        last.x = x0; last.y = y0;
        continue;
      }
    }
    lines.push({ ...r, O: it.O, fs });
  }
  return lines.map(({ x, y, w, h }) => ({ x, y, w, h }));
}

/** Rectangles for the text between two points on a page, in reading order. */
function selectText(p, a, b) {
  const items = p.text;
  if (!items || !items.length) return [];
  const nearest = (pt) => {
    let best = 0, bd = Infinity;
    items.forEach((it, i) => { const d = distToBox(pt, it.box); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  let i0 = nearest(a), i1 = nearest(b), s = a, e = b;
  if (i0 > i1) { [i0, i1] = [i1, i0]; [s, e] = [e, s]; }
  // fraction of an item's width at a point, snapped to a character boundary
  const frac = (it, pt) => clamp(Math.round(((pt.x - it.O.x) * it.u.x + (pt.y - it.O.y) * it.u.y) / it.w * it.n) / it.n, 0, 1);
  const parts = [];
  for (let i = i0; i <= i1; i++) {
    const it = items[i];
    let f0 = i === i0 ? frac(it, s) : 0, f1 = i === i1 ? frac(it, e) : 1;
    if (i0 === i1 && f0 > f1) [f0, f1] = [f1, f0];
    if (f1 > f0) parts.push({ it, r: rectFor(it, f0, f1, state.hlPad * MM) });
  }
  return mergeLines(parts);   // one continuous rectangle per line
}

/** Bounding box of a text note in PDF units. */
function textBounds(a) {
  const { lines, widths } = measureLines(a.text, a.size);
  return { x: a.x, y: a.y, w: Math.max(...widths), h: lines.length * a.size * TEXT_LH };
}

/** Dashed frame plus a resize handle around the selected note. */
function drawSelection(ctx, a) {
  const b = textBounds(a), u = 1 / state.scale, pad = 3 * u;   // u = one screen pixel
  ctx.save();
  ctx.strokeStyle = '#2f6fed'; ctx.fillStyle = '#2f6fed'; ctx.lineWidth = 1.5 * u;
  ctx.setLineDash([4 * u, 3 * u]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  ctx.setLineDash([]);
  ctx.fillRect(b.x + b.w + pad - 5 * u, b.y + b.h + pad - 5 * u, 10 * u, 10 * u);
  ctx.restore();
}

/** Redraw a page's overlay: stored annotations plus an optional live preview. */
function drawOverlay(p, preview) {
  if (!p.rendered) return;
  const c = p.overlay, ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const hctx = p.hl.getContext('2d');                     // highlights live on their own layer
  hctx.setTransform(1, 0, 0, 1, 0, 0);
  hctx.clearRect(0, 0, c.width, c.height);
  const k = c.width / p.w;                       // bitmap px per PDF unit
  ctx.setTransform(k, 0, 0, k, 0, 0);
  hctx.setTransform(k, 0, 0, k, 0, 0);
  const list = state.annotations.get(p.num) || [];
  const target = (a) => (a.type === 'hl' || a.type === 'area' ? hctx : ctx);
  list.forEach((a) => { if (a !== editingAnn) drawAnnotation(target(a), a); });   // hide note being edited
  if (preview && preview.type) drawAnnotation(target(preview), preview);               // drag/erase gestures have no type
  const sel = state.selected;
  if (sel && sel.page === p.num && sel.ann !== editingAnn && list.includes(sel.ann)) drawSelection(ctx, sel.ann);
}

/* ===================== 4. PAGE RENDERING ===================== */

/** Apply the current zoom to a page placeholder's CSS size. */
function sizePage(p) {
  p.el.style.width = p.w * state.scale + 'px';
  p.el.style.height = p.h * state.scale + 'px';
}

/** Render a page into an off-screen canvas, then swap it in (no flicker). */
async function renderPage(p) {
  const token = ++p.token;
  if (p.task) p.task.cancel();
  const page = await state.doc.getPage(p.num);
  if (token !== p.token) return;
  const dpr = Math.min(window.devicePixelRatio || 1, CFG.maxDpr);
  const base = page.getViewport({ scale: 1 });
  if (base.width !== p.w || base.height !== p.h) { p.w = base.width; p.h = base.height; sizePage(p); }
  const vp = page.getViewport({ scale: state.scale * dpr });
  const buf = document.createElement('canvas');
  buf.width = Math.floor(vp.width); buf.height = Math.floor(vp.height);
  const task = page.render({ canvasContext: buf.getContext('2d'), viewport: vp });
  p.task = task;
  try { await task.promise; }
  catch (e) { if (e && e.name !== 'RenderingCancelledException') console.error(e); return; }
  if (token !== p.token) return;
  p.task = null;
  for (const c of [p.canvas, p.hl, p.overlay]) { c.width = buf.width; c.height = buf.height; }
  p.canvas.getContext('2d').drawImage(buf, 0, 0);
  p.rendered = true;
  drawOverlay(p);
  loadText(p);                      // text positions for the Highlight tool
}

/** Free a page's memory when it scrolls far out of view. */
function releasePage(p) {
  p.token++;
  if (p.task) { p.task.cancel(); p.task = null; }
  p.canvas.width = p.canvas.height = p.overlay.width = p.overlay.height = p.hl.width = p.hl.height = 0;
  p.rendered = false;
  p.text = null;                    // free the text positions too
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = state.pages[+e.target.dataset.n - 1];
    if (e.isIntersecting) { visible.add(p); renderPage(p); }
    else { visible.delete(p); releasePage(p); }
  }
}, { root: ui.viewer, rootMargin: CFG.rootMargin });

/** Create one placeholder per page; real rendering happens lazily. */
function buildPages(firstW, firstH) {
  observer.disconnect(); visible.clear();
  ui.pages.replaceChildren(); state.pages = [];
  for (let n = 1; n <= state.doc.numPages; n++) {
    const el = document.createElement('div');
    el.className = 'page'; el.dataset.n = n;
    const canvas = document.createElement('canvas');
    const overlay = document.createElement('canvas'); overlay.className = 'ov';
    const hl = document.createElement('canvas'); hl.className = 'hl';   // highlight layer
    el.append(canvas, hl, overlay);
    const p = { num: n, el, canvas, hl, overlay, w: firstW, h: firstH, task: null, token: 0, rendered: false };
    sizePage(p); attachDrawing(p);
    state.pages.push(p); ui.pages.append(el);
    observer.observe(el);
  }
  ui.pageCount.textContent = '/ ' + state.doc.numPages;
  ui.pageNo.max = state.doc.numPages;
}

/** Change zoom, keeping the reading position; sharp re-render is debounced. */
let zoomTimer = 0;
function setScale(s) {
  s = clamp(s, CFG.minScale, CFG.maxScale);
  if (!state.doc || s === state.scale) return;
  const ratio = ui.viewer.scrollTop / (ui.viewer.scrollHeight || 1);
  state.scale = s;
  state.pages.forEach(sizePage);                 // canvases stretch via CSS meanwhile
  ui.viewer.scrollTop = ratio * ui.viewer.scrollHeight;
  ui.zoomLbl.textContent = Math.round(s * 100) + '%';
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => visible.forEach(renderPage), CFG.rerenderDelay);
}

function fitWidth() {
  if (state.doc) setScale((ui.viewer.clientWidth - 32) / state.pages[0].w);
}

/** Scroll so that page n is at the top. */
function goToPage(n) {
  n = clamp(Math.round(n) || 1, 1, state.pages.length);
  if (state.pages[n - 1]) ui.viewer.scrollTop = state.pages[n - 1].el.offsetTop - 8;
}

/** Track which page the reader is on (throttled with rAF). */
let scrollRaf = 0;
ui.viewer.addEventListener('scroll', () => {
  if (scrollRaf || !state.pages.length) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const y = ui.viewer.scrollTop + ui.viewer.clientHeight / 3;
    let cur = 1;
    for (const p of state.pages) { if (p.el.offsetTop <= y) cur = p.num; else break; }
    state.current = cur;
    if (document.activeElement !== ui.pageNo) ui.pageNo.value = cur;
  });
});

/* Two-finger pinch zooms (anchored under the fingers) and a two-finger drag pans, in every tool. */
let pinch = null;
const touchInfo = (t) => ({
  d: Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY),
  x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2
});
ui.viewer.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && state.doc) { state.pinching = true; pinch = touchInfo(e.touches); }
}, { passive: true });
ui.viewer.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const now = touchInfo(e.touches), r = ui.viewer.getBoundingClientRect();
  const docX = (ui.viewer.scrollLeft + pinch.x - r.left) / state.scale;   // document point that was under the fingers
  const docY = (ui.viewer.scrollTop + pinch.y - r.top) / state.scale;
  setScale(state.scale * now.d / pinch.d);
  ui.viewer.scrollLeft = docX * state.scale - (now.x - r.left);
  ui.viewer.scrollTop = docY * state.scale - (now.y - r.top);
  pinch = now;
}, { passive: false });
const endPinch = (e) => {
  if (e.touches.length < 2) pinch = null;
  if (e.touches.length === 0) state.pinching = false;
};
ui.viewer.addEventListener('touchend', endPinch);
ui.viewer.addEventListener('touchcancel', endPinch);

/* ===================== 5. POINTER INPUT ===================== */

/** Wire up drawing gestures on a page's overlay canvas. */
function attachDrawing(p) {
  const c = p.overlay;
  let cur = null, raf = 0;
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) / state.scale, y: (e.clientY - r.top) / state.scale };
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; drawOverlay(p, cur); }); };

  c.addEventListener('pointerdown', (e) => {
    if (state.tool === 'hand' || e.button !== 0 || state.pinching || (e.pointerType === 'touch' && !e.isPrimary)) return;
    c.setPointerCapture(e.pointerId);
    const pt = pos(e);
    if (state.tool === 'select') { cur = beginSelect(p, pt); drawOverlay(p, cur); return; }
    if (state.tool === 'text') { e.preventDefault(); openTextEditor(p, pt, hitText(p, pt)); return; }
    if (state.tool === 'eraser') { cur = { erasing: true }; eraseAt(p, pt); return; }
    const base = { type: state.tool, color: state.color, width: state.width };
    if (state.tool === 'highlight') cur = { type: 'hl', color: state.color, width: 0, start: pt, rects: [] };
    else cur = state.tool === 'pen'
      ? { ...base, points: [pt] }
      : { ...base, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y };
    schedule();
  });

  c.addEventListener('pointermove', (e) => {
    if (!cur) return;
    if (state.pinching) {                // a second finger arrived: cancel the stroke, let the pinch work
      if (cur.drag) Object.assign(cur.ann, cur.before);
      cur = null; drawOverlay(p); return;
    }
    const co = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of (co.length ? co : [e])) {
      const pt = pos(ev);
      if (cur.drag) dragNote(p, cur, pt);
      else if (cur.erasing) eraseAt(p, pt);
      else if (cur.type === 'hl') cur.rects = selectText(p, cur.start, pt);
      else if (cur.type === 'pen') cur.points.push(pt);
      else { cur.x2 = pt.x; cur.y2 = pt.y; }
    }
    if (!cur.erasing) schedule();
  });

  const finish = () => {
    if (!cur) return;
    const a = cur; cur = null;
    if (a.drag) { endNoteDrag(p, a); return; }
    if (a.erasing) return;
    if (a.type === 'hl') {               // text highlight: keep only if it covers text
      delete a.start;
      if (a.rects.length) commit(p.num, a); else drawOverlay(p);
      return;
    }
    const tiny = a.type !== 'pen' && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 1;
    if (tiny) drawOverlay(p); else commit(p.num, a);
  };
  c.addEventListener('pointerup', finish);
  c.addEventListener('pointercancel', finish);
}

/** Cancels or commits the open text editor, if any. */
let closeTextEditor = null;
/** The note currently open in the editor (hidden from the canvas meanwhile). */
let editingAnn = null;

/** Copy of the editable fields of a note, for undo history. */
const snap = (a) => ({ x: a.x, y: a.y, size: a.size, width: a.width, text: a.text });

/** Top-most text note under a point, or null. */
function hitText(p, pt) {
  const list = state.annotations.get(p.num) || [], tol = CFG.eraseTolerancePx / state.scale;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].type !== 'text') continue;
    const b = textBounds(list[i]);
    if (pt.x >= b.x - tol && pt.x <= b.x + b.w + tol && pt.y >= b.y - tol && pt.y <= b.y + b.h + tol) return list[i];
  }
  return null;
}

/** Is the point on the resize handle (bottom-right corner) of a note? */
function nearCorner(a, pt) {
  const b = textBounds(a), r = 12 / state.scale;
  return Math.abs(pt.x - (b.x + b.w)) <= r && Math.abs(pt.y - (b.y + b.h)) <= r;
}

/** Deselect the current note and repaint its page. */
function clearSelection() {
  const s = state.selected;
  state.selected = null;
  if (s && state.pages[s.page - 1]) drawOverlay(state.pages[s.page - 1]);
}

/**
 * Select-tool pointer down: pick a note and return the drag gesture
 * (move or resize), or null when empty space was clicked (deselects).
 */
function beginSelect(p, pt) {
  const prev = state.selected;
  if (prev && prev.page === p.num && nearCorner(prev.ann, pt)) {
    return { drag: 'resize', ann: prev.ann, before: snap(prev.ann), startW: textBounds(prev.ann).w, moved: false };
  }
  const ann = hitText(p, pt);
  state.selected = ann ? { page: p.num, ann } : null;
  if (prev && prev.page !== p.num) drawOverlay(state.pages[prev.page - 1]);
  if (!ann) return null;
  return {
    drag: 'move', ann, before: snap(ann), start: pt, moved: false,
    grab: { x: pt.x - ann.x, y: pt.y - ann.y }, wasSelected: !!prev && prev.ann === ann
  };
}

/** Update a note live while dragging (move) or dragging the handle (resize). */
function dragNote(p, g, pt) {
  const a = g.ann;
  if (g.drag === 'move') {
    if (!g.moved && Math.hypot(pt.x - g.start.x, pt.y - g.start.y) * state.scale < 3) return; // ignore tiny jitter
    g.moved = true;
    a.x = clamp(pt.x - g.grab.x, 0, p.w - 10);
    a.y = clamp(pt.y - g.grab.y, 0, p.h - 10);
  } else {
    g.moved = true;
    a.size = a.width = clamp(g.before.size * Math.max(pt.x - a.x, 5) / g.startW, 6, 300);
  }
}

/** Finish a drag: record history, or treat a click on a selected note as edit. */
function endNoteDrag(p, g) {
  if (g.moved) {
    pushHistory({ op: 'modify', page: p.num, ann: g.ann, before: g.before, after: snap(g.ann) });
    persist(); drawOverlay(p);
  } else if (g.drag === 'move' && g.wasSelected) {
    openTextEditor(p, null, g.ann);
  }
}

/** Apply an edited text: delete if emptied, record history if changed. */
function commitTextEdit(p, ann, text) {
  const list = state.annotations.get(p.num);
  if (!text) {
    const i = list.indexOf(ann);
    list.splice(i, 1);
    if (state.selected && state.selected.ann === ann) state.selected = null;
    pushHistory({ op: 'remove', page: p.num, ann, index: i });
  } else if (text !== ann.text) {
    const before = { text: ann.text };
    ann.text = text;
    pushHistory({ op: 'modify', page: p.num, ann, before, after: { text } });
  }
  drawOverlay(p); persist();
}

/**
 * Open an inline editor at a point on a page. Blur or Ctrl+Enter saves,
 * Esc cancels. Empty text is discarded.
 * @param {object} p   page record
 * @param {{x:number,y:number}|null} pt   position in PDF units (ignored when editing)
 * @param {TextAnn} [existing]   edit this note instead of creating a new one
 */
function openTextEditor(p, pt, existing) {
  if (closeTextEditor) closeTextEditor();
  const size = existing ? existing.size : 12 + state.width * 1.5;
  const color = existing ? existing.color : state.color;
  if (existing) { pt = { x: existing.x, y: existing.y }; editingAnn = existing; drawOverlay(p); }
  const ta = document.createElement('textarea');
  ta.className = 'note'; ta.setAttribute('wrap', 'off'); ta.spellcheck = false;
  ta.setAttribute('aria-label', 'Text note');
  Object.assign(ta.style, {
    left: pt.x * state.scale + 'px', top: pt.y * state.scale + 'px',
    color, fontSize: size * state.scale + 'px'
  });
  const fit = () => {                      // grow the box with the content
    const { lines, widths } = measureLines(ta.value || ' ', size);
    ta.style.width = (Math.max(...widths) + size * 2) * state.scale + 'px';
    ta.style.height = lines.length * size * TEXT_LH * state.scale + 'px';
  };
  let done = false;
  const finish = (save = true) => {
    if (done) return;
    done = true; closeTextEditor = null;
    const text = ta.value.replace(/\s+$/, '');
    ta.remove();
    editingAnn = null;
    if (existing) { if (save) commitTextEdit(p, existing, text); else drawOverlay(p); }
    else if (save && text) commit(p.num, { type: 'text', color, width: size, size, x: pt.x, y: pt.y, text });
  };
  closeTextEditor = finish;
  ta.addEventListener('input', fit);
  ta.addEventListener('blur', () => finish());
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') finish(false);
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(); }
  });
  if (existing) ta.value = existing.text;
  fit(); p.el.append(ta);
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);        // after pointerdown finishes moving focus
}

/** Remove the top-most annotation under the pointer (undoable). */
function eraseAt(p, pt) {
  const list = state.annotations.get(p.num) || [];
  const tol = CFG.eraseTolerancePx / state.scale;
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (hitTest(a, pt, tol)) {
      list.splice(i, 1);
      pushHistory({ op: 'remove', page: p.num, ann: a, index: i });
      drawOverlay(p); persist();
      return;
    }
  }
}

/* ===================== 6. HISTORY ===================== */

function pushHistory(entry) { state.undo.push(entry); state.redo.length = 0; syncHistoryButtons(); }

/** Store a finished annotation. */
function commit(pageNum, ann) {
  if (!state.annotations.has(pageNum)) state.annotations.set(pageNum, []);
  state.annotations.get(pageNum).push(ann);
  pushHistory({ op: 'add', page: pageNum, ann });
  drawOverlay(state.pages[pageNum - 1]); persist();
}

/** Apply an entry forwards (redo) or backwards (undo). */
function applyEntry(entry, undoing) {
  if (entry.op === 'modify') {                     // move / resize / text edit
    Object.assign(entry.ann, undoing ? entry.before : entry.after);
    drawOverlay(state.pages[entry.page - 1]); persist();
    return;
  }
  const list = state.annotations.get(entry.page) || (state.annotations.set(entry.page, []), state.annotations.get(entry.page));
  const adding = (entry.op === 'add') !== undoing;
  if (adding) { entry.op === 'remove' ? list.splice(entry.index, 0, entry.ann) : list.push(entry.ann); }
  else { const i = list.indexOf(entry.ann); if (i > -1) list.splice(i, 1); }
  drawOverlay(state.pages[entry.page - 1]); persist();
}

function undo() { const e = state.undo.pop(); if (e) { applyEntry(e, true); state.redo.push(e); syncHistoryButtons(); } }
function redo() { const e = state.redo.pop(); if (e) { applyEntry(e, false); state.undo.push(e); syncHistoryButtons(); } }
function syncHistoryButtons() { ui.undo.disabled = !state.undo.length; ui.redo.disabled = !state.redo.length; }

/* ===================== 7. BOOKMARKS & STORAGE ===================== */

const storeKey = () => 'pdfann:' + state.fileKey;

/** Save annotations and bookmarks. Storage can fail (quota/private mode). */
function persist() {
  state.dirty = true;
  try {
    localStorage.setItem(storeKey(), JSON.stringify({
      bookmarks: state.bookmarks, annotations: [...state.annotations]
    }));
  } catch (e) { /* non-fatal: work simply will not survive a reload */ }
}

/** Restore saved data for the current file, if any. */
/** Restore the draft for the current file; otherwise use annotations read from the PDF itself. */
function restore(embedded = new Map()) {
  state.bookmarks = []; state.annotations = embedded;
  try {
    const raw = localStorage.getItem(storeKey());
    if (!raw) return;
    const d = JSON.parse(raw);
    state.bookmarks = d.bookmarks || [];
    if (d.annotations) state.annotations = new Map(d.annotations);   // an unsaved draft is newer than the file
  } catch (e) { /* ignore corrupt data */ }
}

function renderBookmarks() {
  ui.bmList.replaceChildren();
  [...state.bookmarks].sort((a, b) => a.page - b.page).forEach((b) => {
    const li = document.createElement('li');
    const go = document.createElement('button');
    go.className = 'go'; go.textContent = `p.${b.page} · ${b.label}`;
    go.addEventListener('click', () => goToPage(b.page));
    const del = document.createElement('button');
    del.textContent = '×'; del.setAttribute('aria-label', 'Delete bookmark');
    del.addEventListener('click', () => {
      state.bookmarks = state.bookmarks.filter((x) => x.id !== b.id);
      persist(); renderBookmarks();
    });
    li.append(go, del); ui.bmList.append(li);
  });
}

function addBookmark() {
  if (!state.doc) return;
  const name = $('bmName').value.trim();
  state.bookmarks.push({ id: Date.now(), page: state.current, label: name || 'Page ' + state.current });
  $('bmName').value = '';
  persist(); renderBookmarks();
}

/* ===================== 8. UI WIRING ===================== */

/** Open a PDF File object. */
async function openFile(file, target = null) {
  try {
    ui.empty.textContent = 'Loading\u2026'; ui.empty.hidden = false;
    let bytes = new Uint8Array(await file.arrayBuffer());
    let embedded = new Map();
    try {                          // pull out annotations this app saved earlier, so they can be erased
      const r = await extractOwnAnnotations(bytes);
      bytes = r.bytes; embedded = r.annotations;
    } catch (e) { console.warn('Could not scan the PDF for saved annotations:', e); }
    if (state.doc) state.doc.destroy();
    state.doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;   // pdf.js takes ownership of its copy
    state.fileKey = file.name + ':' + file.size;
    state.bytes = bytes; state.fileName = file.name; state.target = target;
    state.undo = []; state.redo = []; state.selected = null; syncHistoryButtons();
    restore(embedded); renderBookmarks(); state.dirty = false;
    const first = (await state.doc.getPage(1)).getViewport({ scale: 1 });
    state.scale = clamp((ui.viewer.clientWidth - 32) / first.width, CFG.minScale, 1.5);
    ui.zoomLbl.textContent = Math.round(state.scale * 100) + '%';
    ui.empty.hidden = true;
    buildPages(first.width, first.height);
    ui.viewer.scrollTop = 0;
  } catch (e) {
    console.error(e);
    ui.empty.hidden = false;
    ui.empty.textContent = 'Could not open that file. Is it a valid PDF?';
  }
}

/** Select a drawing tool and update button states. */
function setTool(t) {
  if (t !== 'select') clearSelection();
  const hl = (x) => x === 'highlight' || x === 'area';
  if (hl(t) && !hl(state.tool)) { state.penColor = state.color; setColor(CFG.highlightColor); }
  else if (!hl(t) && hl(state.tool)) setColor(state.penColor);
  $('hlGroup').hidden = t !== 'highlight';          // height slider only for text highlight
  state.tool = t; ui.pages.dataset.tool = t;
  document.querySelectorAll('#tools button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
}

/** Keep the width preview in step with colour and width. */
function syncPreview() {
  ui.preview.style.height = state.width + 'px';
  ui.preview.style.background = state.color;
  $('widthOut').textContent = state.width;
}

function setColor(c) { state.color = c; $('color').value = c; syncPreview(); }

// Toolbar
$('file').addEventListener('change', (e) => { if (e.target.files[0]) openFile(e.target.files[0]); e.target.value = ''; });
document.querySelectorAll('#tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('color').addEventListener('input', (e) => pickColor(e.target.value));
$('width').addEventListener('input', (e) => { state.width = +e.target.value; syncPreview(); });
$('hlPad').addEventListener('input', (e) => {
  state.hlPad = +e.target.value;
  $('hlPadOut').textContent = '+' + state.hlPad + ' mm';
});
CFG.swatches.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw'; b.style.background = c; b.setAttribute('aria-label', 'Colour ' + c);
  b.addEventListener('click', () => pickColor(c));
  $('swatches').append(b);
});
/** Colour chosen by the user. With the Select tool it also recolours the selected note. */
function pickColor(c) {
  setColor(c);
  const s = state.selected;
  if (s && state.tool === 'select' && s.ann.color !== c) {
    const before = { color: s.ann.color };
    s.ann.color = c;
    pushHistory({ op: 'modify', page: s.page, ann: s.ann, before, after: { color: c } });
    drawOverlay(state.pages[s.page - 1]); persist();
  }
}

/** 60-colour palette (rows: greys, vivid, bright, dark, pastel, light pastel). */
const PALETTE = [
  '#000000', '#212121', '#424242', '#616161', '#757575', '#9e9e9e', '#bdbdbd', '#e0e0e0', '#f5f5f5', '#ffffff',
  '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3', '#03a9f4', '#00bcd4', '#009688', '#4caf50',
  '#8bc34a', '#cddc39', '#ffeb3b', '#ffc107', '#ff9800', '#ff5722', '#795548', '#607d8b', '#b71c1c', '#880e4f',
  '#4a148c', '#311b92', '#1a237e', '#0d47a1', '#01579b', '#006064', '#004d40', '#1b5e20', '#33691e', '#827717',
  '#ffcdd2', '#f8bbd0', '#e1bee7', '#d1c4e9', '#c5cae9', '#bbdefb', '#b3e5fc', '#b2ebf2', '#b2dfdb', '#c8e6c9',
  '#dcedc8', '#f0f4c3', '#fff9c4', '#ffecb3', '#ffe0b2', '#ffccbc', '#d7ccc8', '#cfd8dc', '#fff176', '#ffee58'
];
const pal = $('palette'), palBtn = $('palBtn');
function closePalette() { pal.hidden = true; palBtn.setAttribute('aria-expanded', 'false'); }
PALETTE.forEach((c) => {
  const b = document.createElement('button');
  b.className = 'sw'; b.style.background = c; b.title = c; b.setAttribute('aria-label', 'Colour ' + c);
  b.addEventListener('click', () => { pickColor(c); closePalette(); });
  pal.append(b);
});
palBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!pal.hidden) return closePalette();
  const r = palBtn.getBoundingClientRect();
  pal.hidden = false;
  pal.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pal.offsetWidth - 8)) + 'px';
  pal.style.top = r.bottom + 6 + 'px';
  palBtn.setAttribute('aria-expanded', 'true');
});
document.addEventListener('click', (e) => { if (!pal.hidden && !pal.contains(e.target)) closePalette(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePalette(); });

ui.undo.addEventListener('click', undo);
ui.redo.addEventListener('click', redo);
$('zoomIn').addEventListener('click', () => setScale(state.scale + CFG.zoomStep));
$('zoomOut').addEventListener('click', () => setScale(state.scale - CFG.zoomStep));
$('fit').addEventListener('click', fitWidth);
ui.pageNo.addEventListener('change', () => goToPage(+ui.pageNo.value));
$('bmToggle').addEventListener('click', () => ui.side.classList.toggle('open'));
$('bmAdd').addEventListener('click', addBookmark);

// Keyboard shortcuts (ignored while typing in a field)
document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'color') return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); savePdf(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const map = { h: 'hand', v: 'select', p: 'pen', l: 'line', r: 'rect', t: 'text', m: 'highlight', a: 'area', e: 'eraser' };
    if (map[k]) setTool(map[k]);
  }
});

/* ===================== 9. PDF ANNOTATIONS: WRITE, READ BACK, SAVE ===================== */

/** Private annotation key marking annotations written by this app. Value: base64 JSON of the model. */
const APP_KEY = 'PdfAnnotatorData';

const b64e = (s) => { let bin = ''; new TextEncoder().encode(s).forEach((b) => { bin += String.fromCharCode(b); }); return btoa(bin); };
const b64d = (s) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const round2 = (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);   // JSON replacer
const n2 = (n) => Math.round(n * 100) / 100;                                       // compact numbers

/** '#rrggbb' to [r, g, b] in 0..1. */
function rgb01(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round((v / 255) * 1000) / 1000);
}

/** Bounding box [x0, y0, x1, y1] of points, grown by pad. */
function boundsOf(pts, pad = 0) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
}

/**
 * Add one model annotation to a pdf-lib page as a REAL PDF annotation
 * (Ink, Line, Square, Highlight or FreeText) with its own appearance stream,
 * so other readers show it and can edit it. The model is also stored under
 * APP_KEY so this app can read it back losslessly.
 * @param {object} pdf       pdf-lib document
 * @param {object} page      pdf-lib page
 * @param {object} vp        pdf.js viewport at scale 1 (maps app units to PDF user space)
 * @param {Annotation} a     the annotation
 * @param {object|null} font embedded Helvetica (needed for text notes)
 */
function addAnnotation(pdf, page, vp, a, font) {
  const { PDFString, PDFHexString } = PDFLib;
  const ctx = pdf.context;
  const pt = (x, y) => { const [px, py] = vp.convertToPdfPoint(x, y); return { x: px, y: py }; };
  const f = (p) => `${n2(p.x)} ${n2(p.y)}`;
  const col = rgb01(a.color), [r, g, b] = col;
  const stroke = `${n2(a.width)} w 1 J 1 j ${r} ${g} ${b} RG`;      // round caps and joins
  let subtype, rect, content, extra = {}, resources = {};

  if (a.type === 'pen') {
    const pts = a.points.map((q) => pt(q.x, q.y));
    subtype = 'Ink'; rect = boundsOf(pts, a.width / 2 + 1);
    extra = { InkList: [pts.flatMap((p) => [n2(p.x), n2(p.y)])], BS: { W: a.width } };
    content = `${stroke} ${f(pts[0])} m ${pts.map((p) => `${f(p)} l`).join(' ')} S`;
  } else if (a.type === 'line') {
    const p1 = pt(a.x1, a.y1), p2 = pt(a.x2, a.y2);
    subtype = 'Line'; rect = boundsOf([p1, p2], a.width / 2 + 1);
    extra = { L: [n2(p1.x), n2(p1.y), n2(p2.x), n2(p2.y)], BS: { W: a.width } };
    content = `${stroke} ${f(p1)} m ${f(p2)} l S`;
  } else if (a.type === 'rect') {
    const c = [[a.x1, a.y1], [a.x2, a.y1], [a.x2, a.y2], [a.x1, a.y2]].map(([x, y]) => pt(x, y));
    const d = a.width / 2 + 1;
    subtype = 'Square'; rect = boundsOf(c, d);
    extra = { RD: [d, d, d, d], BS: { W: a.width } };                // RD = border room around the real corners
    content = `${stroke} ${f(c[0])} m ${f(c[1])} l ${f(c[2])} l ${f(c[3])} l h S`;
  } else if (a.type === 'hl' || a.type === 'area') {
    const rs = a.type === 'hl' ? a.rects
      : [{ x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) }];
    const quads = [], paths = [], all = [];
    for (const q of rs) {
      const tl = pt(q.x, q.y), tr = pt(q.x + q.w, q.y), bl = pt(q.x, q.y + q.h), br = pt(q.x + q.w, q.y + q.h);
      quads.push(...[tl.x, tl.y, tr.x, tr.y, bl.x, bl.y, br.x, br.y].map(n2));
      paths.push(`${f(tl)} m ${f(tr)} l ${f(br)} l ${f(bl)} l h`);
      all.push(tl, tr, bl, br);
    }
    subtype = 'Highlight'; rect = boundsOf(all);
    extra = { QuadPoints: quads, CA: 0.8 };
    resources = { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: 0.8, CA: 0.8 } } };
    content = `/GS0 gs ${r} ${g} ${b} rg ${paths.join(' ')} f`;        // one fill: overlaps are not doubled
  } else if (a.type === 'text') {
    const lines = a.text.split('\n');
    const W = Math.max(...measureLines(a.text, a.size).widths), H = lines.length * a.size * TEXT_LH;
    subtype = 'FreeText';
    rect = boundsOf([pt(a.x, a.y), pt(a.x + W, a.y), pt(a.x, a.y + H), pt(a.x + W, a.y + H)], 2);
    const rot = (vp.rotation * Math.PI) / 180, cs = n2(Math.cos(rot)), sn = n2(Math.sin(rot));
    const ops = lines.map((line, i) => {
      const t = line.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');          // Helvetica covers Latin-1 only
      if (!t) return '';
      const o = pt(a.x, a.y + (i + 0.5) * a.size * TEXT_LH + 0.35 * a.size);   // baseline of this line
      return `${cs} ${sn} ${-sn} ${cs} ${n2(o.x)} ${n2(o.y)} Tm ${font.encodeText(t).toString()} Tj`;
    });
    content = `BT /Helv ${n2(a.size)} Tf ${r} ${g} ${b} rg ${ops.join(' ')} ET`;
    resources = { Font: { Helv: font.ref } };
    extra = {
      Contents: PDFHexString.fromText(a.text), BS: { W: 0 },
      DA: PDFString.of(`/Helv ${n2(a.size)} Tf ${r} ${g} ${b} rg`)
    };
  } else {
    return;
  }

  const ap = ctx.register(ctx.stream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: rect.map(n2), Resources: resources
  }));
  const annot = ctx.obj({
    Type: 'Annot', Subtype: subtype, Rect: rect.map(n2), F: 4, C: col,
    T: PDFString.of('PDF Annotator'), AP: { N: ap },
    [APP_KEY]: PDFString.of(b64e(JSON.stringify(a, round2))),
    ...extra
  });
  page.node.addAnnot(ctx.register(annot));
}

/** Build the PDF to save: the clean bytes plus every current annotation as real PDF annotations. */
async function buildAnnotatedPdf() {
  const { PDFDocument, StandardFonts } = PDFLib;
  const pdf = await PDFDocument.load(state.bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  let font = null;
  for (const [num, list] of state.annotations) {
    if (!list.length || !pages[num - 1]) continue;
    const vp = (await state.doc.getPage(num)).getViewport({ scale: 1 });
    for (const a of list) {
      if (a.type === 'text' && !font) font = await pdf.embedFont(StandardFonts.Helvetica);
      addAnnotation(pdf, pages[num - 1], vp, a, font);
    }
  }
  return pdf.save();
}

/**
 * Find annotations written by this app (they carry APP_KEY), remove them from
 * the PDF and return them as model objects. Annotations made by other tools
 * are left untouched. Resolves to { bytes, annotations: Map(page -> model[]) }.
 * `bytes` is the input itself when nothing was found.
 */
async function extractOwnAnnotations(bytes) {
  const { PDFDocument, PDFName, PDFDict, PDFRef } = PDFLib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = pdf.context, key = PDFName.of(APP_KEY);
  const found = new Map();
  let removed = 0;
  pdf.getPages().forEach((page, i) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep = [];
    for (let j = 0; j < annots.size(); j++) {
      const ref = annots.get(j);
      const dict = ctx.lookupMaybe(ref, PDFDict);
      const mark = dict && dict.get(key);
      let model = null;
      try { model = mark ? JSON.parse(b64d(mark.decodeText())) : null; } catch (e) { model = null; }
      if (!model || !model.type) { keep.push(ref); continue; }
      if (!found.has(i + 1)) found.set(i + 1, []);
      found.get(i + 1).push(model);
      const ap = dict.lookupMaybe(PDFName.of('AP'), PDFDict);
      const n = ap && ap.get(PDFName.of('N'));
      const res = n instanceof PDFRef && ctx.lookup(n).dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      const fonts = res && res.lookupMaybe(PDFName.of('Font'), PDFDict);
      const helv = fonts && fonts.get(PDFName.of('Helv'));
      if (helv instanceof PDFRef) ctx.delete(helv);    // the font we embedded for text notes
      if (n instanceof PDFRef) ctx.delete(n);          // drop the orphaned appearance stream
      if (ref instanceof PDFRef) ctx.delete(ref);
      removed++;
    }
    if (keep.length === annots.size()) return;
    if (keep.length) page.node.set(PDFName.of('Annots'), ctx.obj(keep));
    else page.node.delete(PDFName.of('Annots'));
  });
  return { bytes: removed ? await pdf.save() : bytes, annotations: found };
}

/* --- Saving and opening (UI) --- */

/** Short status message next to the Save buttons. */
function notify(msg) {
  const el = $('status');
  el.textContent = msg;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => { el.textContent = ''; }, 6000);   // messages fade away
}

/**
 * Hand a file to the user: through the host's `downloads` capability when
 * available (hosted preview), otherwise a normal browser download.
 */
async function deliver(bytes, filename) {
  const host = window.PdfAnnotator && window.PdfAnnotator.host;
  if (host && host.saveCopy) return host.saveCopy(bytes, filename);       // wrapper app (e.g. Android)
  const blob = new Blob([bytes], { type: 'application/pdf' });
  let dl = null;
  try { dl = window.claude ? await window.claude.use('downloads') : null; } catch (e) { dl = null; }
  if (dl) { await dl.save({ filename, data: blob }); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Write bytes back to the file that was opened (desktop path or browser file handle). */
async function writeBack(target, bytes) {
  if (target.kind === 'host') { await target.write(bytes); return; }   // wrapper app (e.g. Android)
  if (target.kind === 'path') { await window.desktop.saveFile(target.path, bytes); return; }
  const h = target.handle, opts = { mode: 'readwrite' };
  if ((await h.queryPermission(opts)) !== 'granted' && (await h.requestPermission(opts)) !== 'granted') {
    throw new Error('permission to write the file was denied');
  }
  const w = await h.createWritable();
  await w.write(bytes);
  await w.close();
}

/**
 * Save button (asCopy = false): write into the opened file when possible,
 * otherwise download a copy with the same name. "Save copy" always downloads.
 */
async function savePdf(asCopy = false) {
  if (!state.bytes) return notify('Open a PDF first.');
  if (closeTextEditor) closeTextEditor();            // include a note still being typed
  const inPlace = !asCopy && !!state.target;
  if (inPlace && !state.dirty) return notify('No changes to save.');
  const buttons = [$('save'), $('saveCopy')];
  buttons.forEach((b) => { b.disabled = true; });
  notify('Preparing PDF\u2026');
  try {
    const bytes = await buildAnnotatedPdf();
    const name = /\.pdf$/i.test(state.fileName) ? state.fileName : state.fileName + '.pdf';
    if (inPlace) {
      await writeBack(state.target, bytes);
      try { localStorage.removeItem(storeKey()); } catch (e) { /* ignore */ }
      state.fileKey = state.fileName + ':' + bytes.length;   // the file on disk now has this size
      persist(); state.dirty = false;                        // keep the draft (bookmarks) under the new key
      notify('Saved changes to ' + name);
    } else {
      await deliver(bytes, name);
      notify(asCopy ? 'Saved a copy: ' + name
        : 'Downloaded ' + name + '. This page can\u2019t overwrite the original; use the desktop app or Chrome/Edge to save in place.');
    }
  } catch (e) {
    if (e && e.code === 'declined') notify('Save cancelled.');
    else { console.error(e); notify('Could not save: ' + ((e && e.message) || 'unknown error') + '. Try "Save copy".'); }
  } finally { buttons.forEach((b) => { b.disabled = false; }); }
}

/** Open PDF button: native dialog (desktop), file picker with write access (Chromium), or a plain input. */
async function pickAndOpen() {
  const host = window.PdfAnnotator && window.PdfAnnotator.host;
  if (host && host.openDialog) return host.openDialog();               // wrapper app (e.g. Android)
  if (window.desktop && window.desktop.openDialog) return window.desktop.openDialog();
  if (window.showOpenFilePicker) {
    try {
      const [h] = await window.showOpenFilePicker({ types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }] });
      return openFile(await h.getFile(), { kind: 'handle', handle: h });
    } catch (e) {
      if (e && e.name === 'AbortError') return;      // user cancelled; anything else (e.g. blocked in a frame) falls through
    }
  }
  $('file').click();
}

$('save').addEventListener('click', () => savePdf(false));
$('saveCopy').addEventListener('click', () => savePdf(true));
$('openBtn').addEventListener('click', pickAndOpen);

/** Hook for host apps (e.g. the desktop wrapper): open a File, optionally with a save target. */
window.PdfAnnotator = { openFile };

setTool('pen'); syncPreview();
})();
