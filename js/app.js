// Nib — a tiny PDF editor that lives in your browser.
// Rendering: pdf.js · Writing: pdf-lib · Everything stays on this device.

import * as pdfjsLib from '../vendor/pdf.min.mjs';
import { t, getLang, setLang, applyLang, store } from './i18n.js';
import { initSignature, pickSignature } from './signature.js';
import { exportPdf, winAnsiOk } from './export.js';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  new URL('../vendor/pdf.worker.min.mjs', import.meta.url).toString();

const PDFJS_OPTS = {
  cMapUrl: new URL('../vendor/cmaps/', import.meta.url).toString(),
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/standard_fonts/', import.meta.url).toString(),
  wasmUrl: new URL('../vendor/wasm/', import.meta.url).toString(),
  iccUrl: new URL('../vendor/iccs/', import.meta.url).toString(),
};

const $ = s => document.querySelector(s);
const viewerEl = $('#viewer'), pagesEl = $('#pages'), dropEl = $('#drop'), dropCard = $('#dropCard');

const state = {
  pdfBytes: null,          // original file bytes (Uint8Array, never mutated)
  pdfDoc: null,            // pdf.js document
  fileName: 'document.pdf',
  scale: 1,
  pages: [],               // per-page: {num, viewport1, viewport, el, canvas, overlay, textLayerDiv,
                           //            textDivs, items, styles, runs, rendered, outputScale}
  ops: [],                 // edit operations, chronological (z-order)
  undoStack: [],           // {kind:'add'|'del'|'mod', op, index?, before?, after?}
  redoStack: [],
  tool: 'select',
  selected: null,          // selected op
  fontBytes: null,         // user-provided unicode font
  dirty: false,
  pendingSig: null,        // signature waiting for placement {dataUrl,width,height}
};

window.nib = { state, openBytes, exportBytes, setTool, getRuns: p => state.pages[p]?.runs };

/* =============== helpers =============== */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function norm360(d) { return ((d % 360) + 360) % 360; }

// [r,g,b] 0-255 → css
const css = c => `rgb(${c[0]},${c[1]},${c[2]})`;

const FONT_CSS = {
  helv: 'Helvetica, Arial, sans-serif', times: 'Georgia, "Times New Roman", serif', cour: '"Courier New", monospace',
};
function fontCss(key = 'helv') {
  const base = key.startsWith('times') ? FONT_CSS.times : key.startsWith('cour') ? FONT_CSS.cour : FONT_CSS.helv;
  const w = key.includes('B') ? '700' : '400';
  const style = key.includes('I') ? 'italic' : 'normal';
  return { family: base, weight: w, style };
}

/* =============== document loading =============== */

async function openFile(file) {
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, file.name);
  } catch (e) {
    console.error(e);
    toast(t('toast.loadfail'));
  }
}

// Cheap scan for an /Encrypt entry; confirmed with a pdf-lib probe (pdf.js opens
// owner-password PDFs fine, but pdf-lib would throw at export — reject early).
function looksEncrypted(bytes) {
  const pat = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74]; // "/Encrypt"
  outer: for (let i = 0, n = bytes.length - 8; i < n; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let j = 1; j < 8; j++) if (bytes[i + j] !== pat[j]) continue outer;
    return true;
  }
  return false;
}

async function openBytes(bytes, name) {
  if (state.dirty && !confirm(t('confirm.discard'))) return;
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS }).promise;
  } catch (e) {
    toast(/password/i.test(String(e)) ? t('toast.encrypted') : t('toast.loadfail'));
    return;
  }
  if (looksEncrypted(bytes)) {
    try {
      await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    } catch {
      doc.loadingTask?.destroy();
      toast(t('toast.encrypted'));
      return;
    }
  }
  // reset — free the previous document's worker memory
  state.pdfDoc?.loadingTask?.destroy();
  state.pdfBytes = bytes;
  state.pdfDoc = doc;
  state.fileName = name || 'document.pdf';
  state.ops = []; state.undoStack = []; state.redoStack = [];
  state.selected = null; state.dirty = false; state.pendingSig = null;
  state.pages = [];
  pagesEl.innerHTML = '';

  const first = await doc.getPage(1);
  const vw1 = first.getViewport({ scale: 1 });
  const avail = viewerEl.clientWidth - 88;
  state.scale = Math.min(1.6, Math.max(0.5, avail / vw1.width));
  if (state.scale > 1 && state.scale < 1.12) state.scale = 1; // prefer crisp 100%

  const defW = Math.floor(vw1.width * state.scale), defH = Math.floor(vw1.height * state.scale);
  for (let i = 0; i < doc.numPages; i++) state.pages.push(makePageShell(i, defW, defH));
  dropEl.hidden = true;
  pagesEl.hidden = false;
  for (const b of document.querySelectorAll('.tool, #zoomIn, #zoomOut, #zoomPct, #saveBtn')) b.disabled = false;
  updateZoomLabel(); updateUndoButtons();
  setTool('select');
  observer.disconnect();
  for (const p of state.pages) observer.observe(p.el);
}

const observer = new IntersectionObserver(entries => {
  for (const en of entries)
    if (en.isIntersecting) {
      const idx = Number(en.target.dataset.page);
      renderPage(idx).catch(e => { console.error(e); toast(t('toast.loadfail')); });
    }
}, { root: viewerEl, rootMargin: '900px 0px' });

function makePageShell(i, defW, defH) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = i;
  el.style.width = `${defW}px`;
  el.style.height = `${defH}px`;
  pagesEl.append(el);
  return { num: i + 1, el, rendered: false, rendering: false };
}

async function renderPage(i) {
  const ps = state.pages[i];
  if (!ps || ps.rendered || ps.rendering) return;
  ps.rendering = true;
  const gen = ps.gen || 0;       // bumped by rerenderAll; stale results are discarded
  const scale = state.scale;
  let stale = false;
  try {
    const page = await state.pdfDoc.getPage(ps.num);
    ps.page = page;
    ps.viewport1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale });
    const el = ps.el;

    const outputScale = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await page.render({
      canvasContext: ctx, viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null,
    }).promise;

    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    const textContent = await page.getTextContent({ includeMarkedContent: false });

    if ((ps.gen || 0) !== gen || state.scale !== scale) { stale = true; return; }

    ps.viewport = viewport;
    ps.outputScale = outputScale;
    ps.items = textContent.items;
    ps.styles = textContent.styles;
    el.style.width = `${Math.floor(viewport.width)}px`;
    el.style.height = `${Math.floor(viewport.height)}px`;
    el.style.setProperty('--scale-factor', viewport.scale);

    const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: textLayerDiv, viewport });
    const overlay = document.createElement('div');
    overlay.className = 'overlay';

    el.replaceChildren(canvas, textLayerDiv, overlay);
    await tl.render();
    if ((ps.gen || 0) !== gen) { stale = true; return; }

    ps.textDivs = tl.textDivs;
    ps.canvas = canvas; ps.overlay = overlay; ps.textLayerDiv = textLayerDiv;
    ps.runs = buildRuns(ps);
    ps.rendered = true;
    renderOpsForPage(i);
  } finally {
    ps.rendering = false;
    if (stale && !ps.rendered) renderPage(i).catch(console.error);
  }
}

function rerenderAll() {
  for (const ps of state.pages) {
    ps.gen = (ps.gen || 0) + 1;
    ps.rendered = false;
    if (ps.viewport1) {
      const vp = ps.viewport1;
      ps.el.style.width = `${Math.floor(vp.width * state.scale)}px`;
      ps.el.style.height = `${Math.floor(vp.height * state.scale)}px`;
    }
    ps.el.replaceChildren();
  }
  observer.disconnect();
  for (const p of state.pages) observer.observe(p.el);
}

/* =============== text runs (merge fragmented items) =============== */

function buildRuns(ps) {
  const { items, styles, viewport1 } = ps;
  const R = norm360(viewport1.rotation);
  const runs = [];
  const runOfItem = new Map();
  let cur = null;

  items.forEach((it, idx) => {
    if (!it.str || !it.str.length) { cur = null; return; }
    // Whitespace-only items (often synthesized with huge advances) would wreck
    // run geometry — skip them; the gap heuristic below re-inserts real spaces.
    if (!it.str.trim()) return;
    const tr = it.transform;
    const size = Math.hypot(tr[2], tr[3]);
    if (size < 0.1) { cur = null; return; }
    const angle = Math.atan2(tr[1], tr[0]) * 180 / Math.PI;
    // screen-space angle: page rotation R (cw) minus the text's own angle (ccw)
    const screenAngle = norm360(R - angle);
    const editable = screenAngle < 1 || screenAngle > 359;
    const rad = angle * Math.PI / 180;
    const dir = [Math.cos(rad), Math.sin(rad)];
    const start = [tr[4], tr[5]];
    const adv = it.width || 0; // advance along dir, user-space units
    const end = [start[0] + dir[0] * adv, start[1] + dir[1] * adv];
    const st = styles[it.fontName] || {};

    let joined = false;
    if (cur && cur.editable === editable && Math.abs(cur.angle - angle) < 0.5
        && Math.abs(cur.size - size) < Math.max(0.5, cur.size * 0.12)) {
      // perpendicular offset between baselines
      const dx = start[0] - cur.end[0], dy = start[1] - cur.end[1];
      const perp = Math.abs(-dir[1] * dx + dir[0] * dy);
      const gap = dir[0] * dx + dir[1] * dy;
      if (perp < cur.size * 0.25 && gap > -cur.size * 0.5 && gap < cur.size * 0.75) {
        if (gap > cur.size * 0.16 && !cur.text.endsWith(' ') && !it.str.startsWith(' '))
          cur.text += ' ';
        cur.text += it.str;
        cur.end = end;
        cur.itemIdxs.push(idx);
        joined = true;
      }
    }
    if (!joined) {
      cur = {
        id: runs.length, itemIdxs: [idx], text: it.str,
        start, end, size, angle, editable,
        asc: st.ascent || 0.9, desc: (st.descent && st.descent < 0) ? st.descent : -0.22,
        fontName: it.fontName,
      };
      runs.push(cur);
    }
    runOfItem.set(idx, cur.id);
  });

  for (const r of runs) r.len = Math.hypot(r.end[0] - r.start[0], r.end[1] - r.start[1]);
  ps.runOfItem = runOfItem;
  return runs;
}

// Union bbox of a run's spans in normalized (scale-1) page coords.
function runNRect(ps, run) {
  const pr = ps.el.getBoundingClientRect();
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
  for (const idx of run.itemIdxs) {
    const div = ps.textDivs[idx];
    if (!div) continue;
    const r = div.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    x1 = Math.min(x1, r.left - pr.left); y1 = Math.min(y1, r.top - pr.top);
    x2 = Math.max(x2, r.right - pr.left); y2 = Math.max(y2, r.bottom - pr.top);
  }
  if (x2 < x1) return null;
  const s = state.scale;
  return { nx: x1 / s, ny: y1 / s, nw: (x2 - x1) / s, nh: (y2 - y1) / s };
}

// Map a pdf.js font to one of the 14 standard fonts.
function stdFontKey(ps, run) {
  const st = ps.styles[run.fontName] || {};
  let base = 'helv';
  if (st.fontFamily === 'serif') base = 'times';
  else if (st.fontFamily === 'monospace') base = 'cour';
  let name = '';
  try { name = ps.page.commonObjs.get(run.fontName)?.name || ''; } catch { /* not resolved */ }
  if (/times|georgia|garamond|book/i.test(name)) base = 'times';
  if (/courier|mono/i.test(name)) base = 'cour';
  const b = /bold|black|heavy|semib/i.test(name);
  const i = /italic|oblique/i.test(name);
  return base + (b && i ? 'BI' : b ? 'B' : i ? 'I' : '');
}

/* =============== canvas color sampling =============== */

function sampleColors(ps, nrect) {
  const fallback = { bg: [255, 255, 255], fg: [17, 24, 39] };
  try {
    const k = state.scale * ps.outputScale;
    const pad = Math.round(3 * ps.outputScale);
    const x = Math.max(0, Math.floor(nrect.nx * k) - pad), y = Math.max(0, Math.floor(nrect.ny * k) - pad);
    const w = Math.min(ps.canvas.width - x, Math.ceil(nrect.nw * k) + 2 * pad);
    const h = Math.min(ps.canvas.height - y, Math.ceil(nrect.nh * k) + 2 * pad);
    if (w < 4 || h < 4) return fallback;
    const d = ps.canvas.getContext('2d').getImageData(x, y, w, h).data;
    const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    // Background = average of the border ring (glyphs live in the interior).
    let br = 0, bgSum = [0, 0, 0], bn = 0;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const ring = px < pad || py < pad || px >= w - pad || py >= h - pad;
        if (!ring) continue;
        const i = (py * w + px) * 4;
        bgSum[0] += d[i]; bgSum[1] += d[i + 1]; bgSum[2] += d[i + 2];
        br += lum(i); bn++;
      }
    }
    if (!bn) return fallback;
    const bg = bgSum.map(v => Math.round(v / bn));
    const bgLum = br / bn;

    // Foreground = interior pixel most distant in luminance from the background.
    let fg = null, best = 0;
    for (let py = pad; py < h - pad; py++) {
      for (let px = pad; px < w - pad; px++) {
        const i = (py * w + px) * 4;
        const dist = Math.abs(lum(i) - bgLum);
        if (dist > best) { best = dist; fg = [d[i], d[i + 1], d[i + 2]]; }
      }
    }
    if (!fg || best < 40) fg = bgLum > 128 ? [17, 24, 39] : [245, 245, 245];
    return { bg, fg };
  } catch {
    return fallback;
  }
}

/* =============== ops & undo =============== */

function pushAction(a) { state.undoStack.push(a); state.redoStack = []; state.dirty = true; updateUndoButtons(); }

function addOp(op) { state.ops.push(op); pushAction({ kind: 'add', op }); renderOpsForPage(op.page); }

function deleteOp(op) {
  const i = state.ops.indexOf(op);
  if (i < 0) return;
  state.ops.splice(i, 1);
  pushAction({ kind: 'del', op, index: i });
  if (state.selected === op) state.selected = null;
  op._el = null;
  renderOpsForPage(op.page);
}

function modOp(op, changes) {
  const before = {};
  for (const k of Object.keys(changes)) before[k] = op[k];
  Object.assign(op, changes);
  pushAction({ kind: 'mod', op, before, after: { ...changes } });
  renderOpsForPage(op.page);
}

function undo() {
  const a = state.undoStack.pop();
  if (!a) return;
  if (a.kind === 'add') { state.ops.splice(state.ops.indexOf(a.op), 1); if (state.selected === a.op) state.selected = null; }
  else if (a.kind === 'del') state.ops.splice(a.index, 0, a.op);
  else Object.assign(a.op, a.before);
  state.redoStack.push(a);
  state.dirty = state.undoStack.length > 0;
  renderOpsForPage(a.op.page); updateUndoButtons();
}

function redo() {
  const a = state.redoStack.pop();
  if (!a) return;
  if (a.kind === 'add') state.ops.push(a.op);
  else if (a.kind === 'del') { state.ops.splice(state.ops.indexOf(a.op), 1); if (state.selected === a.op) state.selected = null; }
  else Object.assign(a.op, a.after);
  state.undoStack.push(a);
  state.dirty = true;
  renderOpsForPage(a.op.page); updateUndoButtons();
}

function updateUndoButtons() {
  $('#undoBtn').disabled = !state.undoStack.length;
  $('#redoBtn').disabled = !state.redoStack.length;
}

/* =============== op DOM rendering =============== */

function renderOpsForPage(i) {
  const ps = state.pages[i];
  if (!ps || !ps.rendered) return;
  // Remove only op elements — a live inline editor (.edit-input/.text-editor/
  // .mini-bar) must survive, or committing edit A would destroy editor B.
  for (const child of [...ps.overlay.children])
    if (child.classList.contains('ob') || child.classList.contains('rect-preview')) child.remove();
  const s = state.scale;
  for (const op of state.ops) {
    if (op.page !== i) continue;
    const el = document.createElement('div');
    el.className = 'ob';
    el.style.left = `${op.nx * s}px`;
    el.style.top = `${op.ny * s}px`;
    el.style.width = `${op.nw * s}px`;
    el.style.height = `${op.nh * s}px`;

    if (op.type === 'image') {
      el.classList.add('ob-img');
      const img = document.createElement('img');
      img.src = op.dataUrl;
      img.draggable = false;
      el.append(img);
    } else if (op.type === 'rect') {
      el.classList.add('ob-rect');
      el.style.background = css(op.bg);
    } else if (op.type === 'edit') {
      el.classList.add('ob-edit');
      el.style.background = css(op.bg);
      el.style.color = css(op.fg);
      const f = fontCss(op.font);
      el.style.fontFamily = f.family;
      el.style.fontWeight = f.weight;
      el.style.fontStyle = f.style;
      el.style.fontSize = `${op.size * s}px`;
      el.style.paddingLeft = '1px';
      el.textContent = op.text;
    } else if (op.type === 'add') {
      el.classList.add('ob-text');
      el.style.color = css(op.fg);
      el.style.fontFamily = fontCss(op.font).family;
      el.style.fontSize = `${op.size * s}px`;
      el.style.lineHeight = `${op.size * 1.25 * s}px`;
      el.style.width = 'auto';
      el.style.height = 'auto';
      el.textContent = op.text;
    }
    if (op === state.selected) selectDecorate(el, op);
    wireOpEl(el, op);
    ps.overlay.append(el);
    op._el = el;
    el._op = op;
  }
}

function selectDecorate(el, op) {
  el.classList.add('selected');
  if (op.type === 'image' || op.type === 'rect') {
    for (const pos of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = `handle ${pos}`;
      h.dataset.handle = pos;
      el.append(h);
    }
  }
}

function select(op) {
  if (state.selected === op) return;
  const prev = state.selected;
  state.selected = op;
  if (prev) renderOpsForPage(prev.page);
  if (op && (!prev || op.page !== prev.page)) renderOpsForPage(op.page);
}

function wireOpEl(el, op) {
  el.addEventListener('pointerdown', e => {
    if (state.tool !== 'select') return;
    e.preventDefault(); e.stopPropagation();
    select(op);

    const ps = state.pages[op.page];
    const handle = e.target.dataset?.handle;
    const startX = e.clientX, startY = e.clientY;
    const orig = { nx: op.nx, ny: op.ny, nw: op.nw, nh: op.nh, bx: op.bx, by: op.by };
    const s = state.scale;
    const pw = ps.viewport1.width, ph = ps.viewport1.height;
    let moved = false;

    const onMove = ev => {
      const dx = (ev.clientX - startX) / s, dy = (ev.clientY - startY) / s;
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      moved = true;
      if (!handle) {
        // keep at least ~12 normalized px of the object inside the page
        const ew = Math.max(op.nw || 24, 24), eh = Math.max(op.nh || 16, 16);
        op.nx = Math.min(Math.max(orig.nx + dx, 12 - ew), pw - 12);
        op.ny = Math.min(Math.max(orig.ny + dy, 12 - eh), ph - 12);
      } else {
        resizeWith(op, orig, handle, dx, dy);
      }
      positionOpEl(el, op);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      if (moved) {
        const after = { nx: op.nx, ny: op.ny, nw: op.nw, nh: op.nh };
        if (op.type === 'edit') {
          // keep the PDF-space baseline in sync with the on-screen box,
          // otherwise the export would draw the edit at its original spot
          const [ux1, uy1] = ps.viewport1.convertToPdfPoint(orig.nx, orig.ny);
          const [ux2, uy2] = ps.viewport1.convertToPdfPoint(op.nx, op.ny);
          after.bx = orig.bx + (ux2 - ux1);
          after.by = orig.by + (uy2 - uy1);
        }
        Object.assign(op, orig);
        modOp(op, after);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  el.addEventListener('dblclick', e => {
    e.stopPropagation();
    if (op.type === 'add') startTextEditor(op.page, null, op);
    else if (op.type === 'edit') reeditRun(op);
  });
}

function positionOpEl(el, op) {
  const s = state.scale;
  el.style.left = `${op.nx * s}px`;
  el.style.top = `${op.ny * s}px`;
  if (op.type !== 'add') {
    el.style.width = `${op.nw * s}px`;
    el.style.height = `${op.nh * s}px`;
  }
}

function resizeWith(op, orig, handle, dx, dy) {
  const keepAspect = op.type === 'image';
  let { nx, ny, nw, nh } = orig;
  if (handle.includes('e')) nw = Math.max(8, orig.nw + dx);
  if (handle.includes('s')) nh = Math.max(8, orig.nh + dy);
  if (handle.includes('w')) { nw = Math.max(8, orig.nw - dx); nx = orig.nx + orig.nw - nw; }
  if (handle.includes('n')) { nh = Math.max(8, orig.nh - dy); ny = orig.ny + orig.nh - nh; }
  if (keepAspect) {
    const k = Math.max(nw / orig.nw, nh / orig.nh);
    nw = orig.nw * k; nh = orig.nh * k;
    if (handle.includes('w')) nx = orig.nx + orig.nw - nw;
    if (handle.includes('n')) ny = orig.ny + orig.nh - nh;
  }
  Object.assign(op, { nx, ny, nw, nh });
}

/* =============== tools =============== */

function setTool(name) {
  state.tool = name;
  for (const b of document.querySelectorAll('.tool'))
    b.classList.toggle('active', b.dataset.tool === name);
  document.body.className = `mode-${name}`;
  if (name !== 'select') select(null);
  if (name !== 'sign') state.pendingSig = null;
}

// --- edit existing text ---

function findRunFromSpan(span) {
  for (const ps of state.pages) {
    if (!ps.textDivs) continue;
    const idx = ps.textDivs.indexOf(span);
    if (idx >= 0) {
      const runId = ps.runOfItem.get(idx);
      if (runId === undefined) return null;
      return { ps, run: ps.runs[runId] };
    }
  }
  return null;
}

function beginRunEdit(ps, run) {
  if (!run.editable) { toast(t('toast.rotated')); return; }
  const pageIdx = Number(ps.el.dataset.page);
  const prevOp = state.ops.find(o => o.type === 'edit' && o.page === pageIdx && o.runId === run.id);
  const nrect = prevOp ? { nx: prevOp.nx, ny: prevOp.ny, nw: prevOp.nw, nh: prevOp.nh } : runNRect(ps, run);
  if (!nrect) return;
  const colors = prevOp ? { bg: prevOp.bg, fg: prevOp.fg } : sampleColors(ps, nrect);
  const fontKey = prevOp ? prevOp.font : stdFontKey(ps, run);

  const s = state.scale;
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.value = prevOp ? prevOp.text : run.text;
  input.title = t('edit.hint');
  input.style.left = `${nrect.nx * s - 2}px`;
  input.style.top = `${nrect.ny * s - 2}px`;
  input.style.minWidth = `${nrect.nw * s + 12}px`;
  input.style.width = `${Math.max(nrect.nw * s + 12, 60)}px`;
  input.style.height = `${nrect.nh * s + 4}px`;
  input.style.fontSize = `${run.size * s}px`;
  const f = fontCss(fontKey);
  input.style.fontFamily = f.family;
  input.style.fontWeight = f.weight;
  input.style.fontStyle = f.style;
  input.style.background = css(colors.bg);
  input.style.color = css(colors.fg);
  ps.overlay.append(input);
  input.focus();
  input.select();
  input.addEventListener('input', () => {
    input.style.width = `${Math.max(input.scrollWidth + 8, nrect.nw * s + 12)}px`;
  });

  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    input.remove();
    if (!commit) return;
    const text = input.value.replace(/\t/g, ' ');
    if (text === (prevOp ? prevOp.text : run.text)) return;   // no change
    if (prevOp) {
      if (text === run.text || text === '') { deleteOp(prevOp); toast(t('toast.emptyRestored')); }
      else modOp(prevOp, { text });
      return;
    }
    if (text === '') return;
    addOp({
      type: 'edit', page: pageIdx, runId: run.id, text,
      nx: nrect.nx, ny: nrect.ny, nw: nrect.nw, nh: nrect.nh,
      bx: run.start[0], by: run.start[1], len: run.len,
      size: run.size, angle: run.angle, asc: run.asc, desc: run.desc,
      font: fontKey, bg: colors.bg, fg: colors.fg,
      origText: run.text,
    });
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function reeditRun(op) {
  const ps = state.pages[op.page];
  if (!ps || !ps.rendered) return;
  const run = ps.runs[op.runId];
  if (run) beginRunEdit(ps, run);
}

// --- add text ---

function startTextEditor(pageIdx, atNPoint, existingOp) {
  const ps = state.pages[pageIdx];
  if (!ps || !ps.rendered) return;
  const s = state.scale;
  const op = existingOp || null;
  const nx = op ? op.nx : atNPoint.nx, ny = op ? op.ny : atNPoint.ny;
  let size = op ? op.size : 14;
  let color = op ? op.fg : [17, 24, 39];

  const ed = document.createElement('div');
  ed.className = 'text-editor';
  try { ed.contentEditable = 'plaintext-only'; } catch { ed.contentEditable = 'true'; }
  ed.style.left = `${nx * s - 3}px`;
  ed.style.top = `${ny * s - 2}px`;
  ed.style.fontSize = `${size * s}px`;
  ed.style.lineHeight = `${size * 1.25 * s}px`;
  ed.style.fontFamily = fontCss('helv').family;
  ed.style.color = css(color);
  ed.textContent = op ? op.text : '';
  if (op && op._el) op._el.style.visibility = 'hidden';

  const bar = document.createElement('div');
  bar.className = 'mini-bar';
  bar.style.left = `${nx * s - 3}px`;
  bar.style.top = `${ny * s - 40}px`;
  const sizeInput = document.createElement('input');
  sizeInput.type = 'number'; sizeInput.min = 6; sizeInput.max = 96; sizeInput.value = size;
  const label = document.createElement('span');
  label.textContent = t('text.size');
  bar.append(label, sizeInput);
  for (const c of [[17, 24, 39], [29, 78, 216], [220, 38, 38]]) {
    const dot = document.createElement('button');
    dot.className = 'color-dot' + (css(c) === css(color) ? ' active' : '');
    dot.style.background = css(c);
    dot.addEventListener('pointerdown', e => e.preventDefault()); // keep focus in editor
    dot.addEventListener('click', () => {
      color = c;
      ed.style.color = css(c);
      for (const d of bar.querySelectorAll('.color-dot')) d.classList.toggle('active', d === dot);
    });
    bar.append(dot);
  }
  sizeInput.addEventListener('pointerdown', e => e.stopPropagation());
  sizeInput.addEventListener('input', () => {
    size = Math.min(96, Math.max(6, Number(sizeInput.value) || size));
    ed.style.fontSize = `${size * s}px`;
    ed.style.lineHeight = `${size * 1.25 * s}px`;
  });

  ps.overlay.append(ed, bar);
  ed.focus();
  if (op) {
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }

  let done = false;
  const finish = commit => {
    if (done) return;
    done = true;
    const text = ed.textContent.replace(/ /g, ' ').replace(/\t/g, ' ').replace(/\n+$/, '');
    ed.remove(); bar.remove();
    if (op && op._el) op._el.style.visibility = '';
    if (!commit) { if (op) renderOpsForPage(pageIdx); return; }
    if (op) {
      if (!text.trim()) deleteOp(op);
      else modOp(op, { text, size, fg: color });
    } else if (text.trim()) {
      addOp({ type: 'add', page: pageIdx, text, nx, ny, nw: 0, nh: 0, size, fg: color, font: 'helv' });
    }
    setTool('select');
  };
  ed.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finish(true);
  });
  ed.addEventListener('blur', e => {
    // ignore blur caused by the mini-bar
    setTimeout(() => { if (!done && document.activeElement !== ed && !bar.contains(document.activeElement)) finish(true); }, 0);
  });
}

// --- white-out drag & sign placement & page-level clicks ---

function pageFromEvent(e) {
  const el = e.target.closest('.page');
  return el ? state.pages[Number(el.dataset.page)] : null;
}

function nPoint(ps, e) {
  const r = ps.el.getBoundingClientRect();
  const nx = (e.clientX - r.left) / state.scale, ny = (e.clientY - r.top) / state.scale;
  return {
    nx: Math.min(Math.max(nx, 0), ps.viewport1.width),
    ny: Math.min(Math.max(ny, 0), ps.viewport1.height),
  };
}

function wireViewer() {
  viewerEl.addEventListener('pointerdown', e => {
    const ps = pageFromEvent(e);
    if (!ps || !ps.rendered) return;
    const pageIdx = Number(ps.el.dataset.page);

    if (state.tool === 'select') {
      if (!e.target.closest('.ob')) select(null);
      return;
    }

    if (state.tool === 'edit') {
      if (e.target.closest('.edit-input')) return;
      const ob = e.target.closest('.ob-edit');
      if (ob && ob._op) { e.preventDefault(); reeditRun(ob._op); return; }
      const span = e.target.closest('.textLayer span');
      if (span) {
        const hit = findRunFromSpan(span);
        if (hit) { e.preventDefault(); beginRunEdit(hit.ps, hit.run); }
      }
      return;
    }

    if (state.tool === 'text') {
      if (e.target.closest('.text-editor') || e.target.closest('.mini-bar')) return;
      e.preventDefault();
      startTextEditor(pageIdx, nPoint(ps, e), null);
      return;
    }

    if (state.tool === 'sign') {
      if (!state.pendingSig) return;
      e.preventDefault();
      const sig = state.pendingSig;
      const pt = nPoint(ps, e);
      const pageW = ps.viewport.width / state.scale;
      const nw = Math.min(180, pageW * 0.4);
      const nh = nw * sig.height / sig.width;
      const op = {
        type: 'image', page: pageIdx, dataUrl: sig.dataUrl,
        nx: pt.nx - nw / 2, ny: pt.ny - nh / 2, nw, nh,
      };
      addOp(op);
      setTool('select');
      select(op);
      renderOpsForPage(pageIdx);
      return;
    }

    if (state.tool === 'white') {
      e.preventDefault();
      const start = nPoint(ps, e);
      const s = state.scale;
      const prev = document.createElement('div');
      prev.className = 'rect-preview';
      ps.overlay.append(prev);
      const onMove = ev => {
        const cur = nPoint(ps, ev);
        const nx = Math.min(start.nx, cur.nx), ny = Math.min(start.ny, cur.ny);
        const nw = Math.abs(cur.nx - start.nx), nh = Math.abs(cur.ny - start.ny);
        Object.assign(prev.style, { left: `${nx * s}px`, top: `${ny * s}px`, width: `${nw * s}px`, height: `${nh * s}px` });
        prev._n = { nx, ny, nw, nh };
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        const n = prev._n;
        prev.remove();
        if (n && n.nw > 3 && n.nh > 3) {
          const colors = sampleColors(ps, n);
          addOp({ type: 'rect', page: pageIdx, ...n, bg: colors.bg });
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
  });
}

/* =============== unicode font acquisition =============== */

const CJK_PREFS = [
  /Arial Unicode/i, /DengXian/i, /SimHei/i, /Noto Sans CJK/i, /Noto Sans SC/i,
  /Source Han Sans/i, /WenQuanYi/i, /Hiragino Sans GB/i, /Heiti SC/i, /Songti SC/i,
  /PingFang/i, /Microsoft YaHei/i, /SimSun/i,
];

// True if the font file actually has glyphs for every char in sample —
// fontkit silently maps missing codepoints to glyph 0 (tofu), so embedding
// alone is not a sufficient check.
function fontCovers(bytes, sample) {
  try {
    const fk = window.fontkit.create(bytes);
    return [...new Set([...sample])].slice(0, 80)
      .every(ch => fk.hasGlyphForCodePoint(ch.codePointAt(0)));
  } catch {
    return false;
  }
}

function acquireUnicodeFont(sample = '测试中文Ab') {
  if (state.fontBytes && fontCovers(state.fontBytes, sample))
    return Promise.resolve(state.fontBytes);
  return new Promise(resolve => {
    const modal = $('#fontModal');
    const status = $('#fontStatus');
    status.textContent = '';
    modal.hidden = false;
    let settled = false;
    const settle = v => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      cleanup();
      resolve(v);
    };

    const testEmbed = async bytes => {
      if (!fontCovers(bytes, sample)) throw new Error('missing glyphs');
      const doc = await PDFLib.PDFDocument.create();
      doc.registerFontkit(window.fontkit);
      const f = await doc.embedFont(bytes, { subset: true });
      f.widthOfTextAtSize([...sample].slice(0, 20).join('') || 'Ab', 10);
      return true;
    };

    const onLocal = async () => {
      if (!window.queryLocalFonts) { status.textContent = t('font.fail'); return; }
      status.textContent = t('font.scanning');
      try {
        const fonts = await window.queryLocalFonts();
        const ranked = [];
        for (const pref of CJK_PREFS)
          for (const f of fonts)
            if (pref.test(f.fullName || f.family) && /regular|normal|^((?!bold|italic|light|thin).)*$/i.test(f.style || ''))
              ranked.push(f);
        for (const f of ranked.slice(0, 24)) {
          try {
            const blob = await f.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            await testEmbed(bytes);
            toast(t('toast.fontEmbedded', { name: f.fullName || f.family }));
            settle(bytes);
            return;
          } catch { /* ttc or unusable — try next */ }
        }
        status.textContent = t('font.fail');
      } catch {
        status.textContent = t('font.fail');
      }
    };

    const onPickChange = async () => {
      const file = $('#fontInput').files[0];
      $('#fontInput').value = '';
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await testEmbed(bytes);
        toast(t('toast.fontEmbedded', { name: file.name }));
        settle(bytes);
      } catch {
        status.textContent = t('font.fail');
      }
    };
    const onPick = () => $('#fontInput').click();
    const onClose = () => settle(null);

    const cleanup = () => {
      $('#fontLocalBtn').removeEventListener('click', onLocal);
      $('#fontPickBtn').removeEventListener('click', onPick);
      $('#fontInput').removeEventListener('change', onPickChange);
      $('#fontModal .modal-close').removeEventListener('click', onClose);
    };
    $('#fontLocalBtn').addEventListener('click', onLocal);
    $('#fontPickBtn').addEventListener('click', onPick);
    $('#fontInput').addEventListener('change', onPickChange);
    $('#fontModal .modal-close').addEventListener('click', onClose);
  });
}

/* =============== export =============== */

async function exportBytes() {
  return await exportPdf(state, acquireUnicodeFont);
}

let exporting = false;
async function download() {
  if (!state.pdfBytes || exporting) return;
  if (!state.ops.length) { toast(t('toast.nothingToSave')); return; }
  exporting = true;
  const btn = $('#saveBtn');
  btn.disabled = true;
  btn.querySelector('span').textContent = t('saving');
  try {
    const bytes = await exportBytes();
    if (!bytes) { toast(t('toast.exportCancel')); return; }
    const name = state.fileName.replace(/\.pdf$/i, '') + '-edited.pdf';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    state.dirty = false;
    toast(t('toast.saved', { name }));
  } catch (e) {
    console.error(e);
    toast(String(e.message || e));
  } finally {
    exporting = false;
    btn.disabled = false;
    btn.querySelector('span').textContent = t('download');
  }
}

/* =============== zoom =============== */

let zoomTimer = null;
function setScale(s) {
  state.scale = Math.min(3, Math.max(0.4, Math.round(s * 100) / 100));
  updateZoomLabel();
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(rerenderAll, 140);
}
function updateZoomLabel() { $('#zoomPct').textContent = `${Math.round(state.scale * 100)}%`; }
function fitWidth() {
  const ps = state.pages[0];
  if (!ps || !ps.viewport1) return;
  setScale(Math.min(1.6, Math.max(0.4, (viewerEl.clientWidth - 88) / ps.viewport1.width)));
}

/* =============== boot =============== */

function wireUI() {
  // theme override via ?theme= or localStorage (handy for screenshots)
  const theme = new URLSearchParams(location.search).get('theme') || store.get('nib.theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

  applyLang();
  $('#langToggle').addEventListener('click', () => setLang(getLang() === 'zh' ? 'en' : 'zh'));

  for (const b of document.querySelectorAll('.tool'))
    b.addEventListener('click', async () => {
      if (b.dataset.tool === 'sign') {
        setTool('sign');
        const sig = await pickSignature();
        if (!sig) { setTool('select'); return; }
        state.pendingSig = sig;
        toast(t('toast.placeSign'), 4000);
      } else setTool(b.dataset.tool);
    });

  $('#openBtn').addEventListener('click', () => $('#fileInput').click());
  $('#browseBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', () => {
    const f = $('#fileInput').files[0];
    $('#fileInput').value = '';
    if (f) openFile(f);
  });
  $('#sampleBtn').addEventListener('click', async () => {
    try {
      const res = await fetch('assets/sample.pdf');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await openBytes(new Uint8Array(await res.arrayBuffer()), 'sample.pdf');
    } catch (e) {
      console.error(e);
      toast(t('toast.loadfail'));
    }
  });

  $('#zoomIn').addEventListener('click', () => setScale(state.scale + 0.1));
  $('#zoomOut').addEventListener('click', () => setScale(state.scale - 0.1));
  $('#zoomPct').addEventListener('click', fitWidth);
  $('#undoBtn').addEventListener('click', undo);
  $('#redoBtn').addEventListener('click', redo);
  $('#saveBtn').addEventListener('click', download);

  // drag & drop anywhere
  for (const ev of ['dragover', 'drop']) window.addEventListener(ev, e => e.preventDefault());
  window.addEventListener('dragover', () => dropCard.classList.add('over'));
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) dropCard.classList.remove('over'); });
  window.addEventListener('drop', e => {
    dropCard.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find(f2 => /\.pdf$/i.test(f2.name) || f2.type === 'application/pdf');
    if (f) openFile(f);
  });

  window.addEventListener('keydown', e => {
    // while a modal is open, only Escape (to close it) is handled
    const sigOpen = !$('#sigModal').hidden, fontOpen = !$('#fontModal').hidden;
    if (sigOpen || fontOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (sigOpen) document.querySelector('[data-close="sigModal"]').click();
        else $('#fontModal .modal-close').click();
      }
      return;
    }
    const inField = /^(input|textarea)$/i.test(e.target.tagName) || e.target.isContentEditable;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { if (!inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); } return; }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      // commit any in-progress inline edit first, then export on the next tick
      if (inField) { e.target.blur(); setTimeout(download, 60); }
      else download();
      return;
    }
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); $('#fileInput').click(); return; }
    if (inField) return;
    if (!state.pdfDoc) return;
    if (e.key === 'Escape') setTool('select');
    else if (e.key === 'Backspace' || e.key === 'Delete') { if (state.selected) { e.preventDefault(); deleteOp(state.selected); } }
    else if (e.key === 'v' || e.key === 'V') setTool('select');
    else if (e.key === 'e' || e.key === 'E') setTool('edit');
    else if (e.key === 't' || e.key === 'T') setTool('text');
    else if (e.key === 's' || e.key === 'S') document.querySelector('[data-tool="sign"]').click();
    else if (e.key === 'w' || e.key === 'W') setTool('white');
    else if (e.key === '+' || e.key === '=') setScale(state.scale + 0.1);
    else if (e.key === '-') setScale(state.scale - 0.1);
  });

  window.addEventListener('beforeunload', e => {
    if (state.dirty) { e.preventDefault(); e.returnValue = t('unload.warn'); }
  });

  window.addEventListener('resize', () => { /* keep layout; user can hit fit-width */ });

  initSignature(toast);
  wireViewer();
}

wireUI();
