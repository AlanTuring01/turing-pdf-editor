// Signature modal: draw / type / upload → trimmed transparent PNG data-URL.
import { t } from './i18n.js';

const TYPE_FONTS = [
  '"Snell Roundhand", "Savoye LET", "Apple Chancery", "Brush Script MT", "Segoe Script", cursive',
  '"Didot", "Bodoni 72", "Playfair Display", Georgia, serif',
];

let pad, ctx, drawing = false, strokes = [], stroke = null, ink = '#1b1b1f';
let uploadImg = null;      // HTMLImageElement of the uploaded picture
let typeFontIdx = 0;
let resolvePick = null;
let notify = null;         // toast fn, injected by initSignature

function el(id) { return document.getElementById(id); }

function setTab(name) {
  for (const b of el('sigTabs').querySelectorAll('button'))
    b.classList.toggle('active', b.dataset.tab === name);
  el('sigTabDraw').hidden = name !== 'draw';
  el('sigTabType').hidden = name !== 'type';
  el('sigTabUpload').hidden = name !== 'upload';
  if (name === 'type') renderTypePreviews();
}

function activeTab() {
  return el('sigTabs').querySelector('button.active').dataset.tab;
}

/* ---------- draw pad ---------- */

function setupPad() {
  pad = el('sigPad');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = pad.clientWidth || 540, h = pad.clientHeight || 200;
  pad.width = Math.round(w * dpr);
  pad.height = Math.round(h * dpr);
  ctx = pad.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  redrawPad();
}

function padPos(e) {
  const r = pad.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function redrawPad() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.clearRect(0, 0, pad.width / dpr, pad.height / dpr);
  for (const s of strokes) drawStroke(ctx, s);
}

function drawStroke(c, s) {
  if (s.pts.length < 2) {
    const p = s.pts[0];
    c.fillStyle = s.ink;
    c.beginPath(); c.arc(p.x, p.y, s.w / 2, 0, Math.PI * 2); c.fill();
    return;
  }
  c.strokeStyle = s.ink;
  c.lineWidth = s.w;
  c.beginPath();
  c.moveTo(s.pts[0].x, s.pts[0].y);
  for (let i = 1; i < s.pts.length - 1; i++) {
    const mx = (s.pts[i].x + s.pts[i + 1].x) / 2, my = (s.pts[i].y + s.pts[i + 1].y) / 2;
    c.quadraticCurveTo(s.pts[i].x, s.pts[i].y, mx, my);
  }
  const last = s.pts[s.pts.length - 1];
  c.lineTo(last.x, last.y);
  c.stroke();
}

function wirePad() {
  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    try { pad.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    drawing = true;
    stroke = { pts: [padPos(e)], ink, w: 2.4 };
    strokes.push(stroke);
    redrawPad();
  });
  pad.addEventListener('pointermove', e => {
    if (!drawing) return;
    stroke.pts.push(padPos(e));
    redrawPad();
  });
  const up = () => { drawing = false; stroke = null; };
  pad.addEventListener('pointerup', up);
  pad.addEventListener('pointercancel', up);
}

/* ---------- type tab ---------- */

function renderTypePreviews() {
  const name = el('sigText').value.trim() || 'Alan Turing';
  const box = el('sigPreviews');
  box.innerHTML = '';
  TYPE_FONTS.forEach((font, i) => {
    const card = document.createElement('div');
    card.className = 'sig-preview' + (i === typeFontIdx ? ' active' : '');
    const cv = renderTypeCanvas(name, font, 42);
    card.append(cv);
    card.addEventListener('click', () => { typeFontIdx = i; renderTypePreviews(); });
    box.append(card);
  });
}

function renderTypeCanvas(text, font, px) {
  const cv = document.createElement('canvas');
  const c = cv.getContext('2d');
  c.font = `${px}px ${font}`;
  const m = c.measureText(text);
  cv.width = Math.ceil(m.width + px * 0.6);
  cv.height = Math.ceil(px * 1.8);
  const c2 = cv.getContext('2d');
  c2.font = `${px}px ${font}`;
  c2.fillStyle = '#1b1b1f';
  c2.textBaseline = 'middle';
  c2.fillText(text, px * 0.3, cv.height / 2);
  return cv;
}

/* ---------- upload tab ---------- */

function wireUpload() {
  const zone = el('sigUploadZone');
  const input = el('sigFileInput');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) loadUpload(f);
  });
  input.addEventListener('change', () => { if (input.files[0]) loadUpload(input.files[0]); input.value = ''; });
}

function loadUpload(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    uploadImg = img;
    const zone = el('sigUploadZone');
    zone.innerHTML = '';
    zone.append(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (notify) notify(t('sig.uploadHint'));
  };
  img.src = url;
}

/* ---------- output ---------- */

function trimCanvas(cv) {
  const c = cv.getContext('2d');
  const { width, height } = cv;
  if (!width || !height) return null;
  const data = c.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad2 = 4;
  minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2);
  maxX = Math.min(width - 1, maxX + pad2); maxY = Math.min(height - 1, maxY + pad2);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(cv, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function buildResult() {
  const tab = activeTab();
  let cv = null;
  if (tab === 'draw') {
    if (!strokes.length) return null;
    cv = trimCanvas(pad);
  } else if (tab === 'type') {
    const name = el('sigText').value.trim();
    if (!name) return null;
    cv = trimCanvas(renderTypeCanvas(name, TYPE_FONTS[typeFontIdx], 96));
  } else if (tab === 'upload') {
    if (!uploadImg) return null;
    const max = 1600;
    const k = Math.min(1, max / Math.max(uploadImg.naturalWidth, uploadImg.naturalHeight));
    const raw = document.createElement('canvas');
    raw.width = Math.round(uploadImg.naturalWidth * k);
    raw.height = Math.round(uploadImg.naturalHeight * k);
    const c = raw.getContext('2d');
    c.drawImage(uploadImg, 0, 0, raw.width, raw.height);
    if (el('sigRemoveWhite').checked) {
      const im = c.getImageData(0, 0, raw.width, raw.height);
      const d = im.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum > 235) d[i + 3] = 0;
        else if (lum > 200) d[i + 3] = Math.round(d[i + 3] * (235 - lum) / 35);
      }
      c.putImageData(im, 0, 0);
    }
    cv = trimCanvas(raw);
  }
  if (!cv) return null;
  return { dataUrl: cv.toDataURL('image/png'), width: cv.width, height: cv.height };
}

/* ---------- public API ---------- */

export function initSignature(toast) {
  notify = toast;
  wireUpload();
  el('sigTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if (b) setTab(b.dataset.tab);
  });
  el('sigClear').addEventListener('click', () => { strokes = []; redrawPad(); });
  el('sigText').addEventListener('input', renderTypePreviews);
  for (const dot of document.querySelectorAll('#sigTabDraw .color-dot')) {
    dot.addEventListener('click', () => {
      ink = dot.dataset.ink;
      for (const d of document.querySelectorAll('#sigTabDraw .color-dot')) d.classList.toggle('active', d === dot);
    });
  }
  el('sigUse').addEventListener('click', () => {
    const res = buildResult();
    if (!res) { toast(t('sig.empty')); return; }
    el('sigModal').hidden = true;
    if (resolvePick) { resolvePick(res); resolvePick = null; }
  });
  for (const b of document.querySelectorAll('[data-close="sigModal"]')) {
    b.addEventListener('click', () => {
      el('sigModal').hidden = true;
      if (resolvePick) { resolvePick(null); resolvePick = null; }
    });
  }
}

// Opens the modal; resolves with {dataUrl,width,height} or null if cancelled.
export function pickSignature() {
  return new Promise(resolve => {
    if (resolvePick) resolvePick(null); // cancel any earlier, still-pending pick
    resolvePick = resolve;
    el('sigModal').hidden = false;
    setupPad();
    if (!pad.dataset.wired) { wirePad(); pad.dataset.wired = '1'; }
  });
}
