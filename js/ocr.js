// On-device OCR for scanned pages (tesseract.js). Nothing ever leaves the
// device: the engine, wasm core and language models are all vendored and
// lazy-loaded from this site on first use.
import { t } from './i18n.js';

const CONF_MIN = 35;          // drop lines tesseract itself doubts
const OCR_TARGET_PX = 2200;   // render width used for recognition

let ctx = null;               // { state, toast, injectRuns(ps, runs), norm360 }
let worker = null;
let workerLangs = '';
let queue = [];
let active = null;            // ps currently being recognized
let scriptLoaded = null;

export function initOcr(appCtx) {
  ctx = appCtx;
  const modal = document.getElementById('ocrModal');
  document.getElementById('ocrEn').addEventListener('click', () => chooseLangs(['eng']));
  document.getElementById('ocrZhEn').addEventListener('click', () => chooseLangs(['chi_sim', 'eng']));
  modal.querySelector('.modal-close').addEventListener('click', () => { modal.hidden = true; });
}

export function resetOcr() {
  queue = [];
  // language is chosen per document — a Chinese scan after an English one
  // must not silently inherit the eng model
  if (ctx) ctx.state.ocrLangs = null;
  // keep the worker warm across documents; recognition of a stale page is
  // prevented by the pdfDoc identity check in pump()
}

// renderPage calls this for every page once it is on screen
export function ocrPageHook(ps) {
  if (!ps.runs || ps.runs.length > 0) return;
  const st = ps.ocr?.status;
  if (st === 'done') {
    if (ps.ocr.lines.length) injectOcrRuns(ps);
    else showPill(ps, t('ocr.pillEmpty'), true); // clickable: retry with another language
    return;
  }
  if (st === 'running') { showPill(ps, t('ocr.running', { p: ps.ocr.progress || 0 }), false); return; }
  if (st === 'pending') { showPill(ps, t('ocr.loading'), false); return; }
  if (st === 'failed') { showPill(ps, t('ocr.fail'), true); return; }
  if (ctx.state.ocrLangs) enqueue(ps);
  else showPill(ps, t('ocr.pill'), true);
}

// edit-tool click on a page with no text layer
export function ocrEditClick(ps) {
  if (ps.ocr?.status === 'done' || ps.ocr?.status === 'running') return;
  if (ctx.state.ocrLangs) { enqueue(ps); return; }
  openOcrModal();
}

export function openOcrModal() {
  document.getElementById('ocrModal').hidden = false;
}

function chooseLangs(langs) {
  document.getElementById('ocrModal').hidden = true;
  ctx.state.ocrLangs = langs;
  const key = langs.join('+');
  for (const ps of ctx.state.pages)
    if (ps.rendered && ps.runs && ps.runs.length === 0
        && (!ps.ocr || ps.ocr.langKey !== key)) {
      ps.ocr = null; // language changed (or first run): recognize afresh
      enqueue(ps);
    }
}

/* ---------- queue ---------- */

function enqueue(ps) {
  if (ps.ocr && ps.ocr.status !== 'idle' && ps.ocr.status !== 'failed') return;
  ps.ocr = { status: 'pending', lines: [], progress: 0, langKey: ctx.state.ocrLangs.join('+') };
  showPill(ps, t('ocr.loading'), false);
  if (!queue.includes(ps)) queue.push(ps);
  pump();
}

async function pump() {
  if (active || !queue.length) return;
  const ps = queue.shift();
  const doc = ctx.state.pdfDoc;
  active = ps;
  ps.ocr.status = 'running';
  try {
    const lines = await recognizePage(ps, ctx.state.ocrLangs, p => {
      ps.ocr.progress = p;
      showPill(ps, t('ocr.running', { p }), false);
    });
    if (ctx.state.pdfDoc !== doc) return; // document changed mid-flight
    ps.ocr = { status: 'done', lines, progress: 100, langKey: ps.ocr.langKey };
    removePill(ps);
    if (ps.rendered) {
      if (lines.length) {
        injectOcrRuns(ps);
        ctx.toast(t('ocr.done'));
      } else {
        showPill(ps, t('ocr.pillEmpty'), true, 'ocr.pillEmpty');
      }
    }
  } catch (e) {
    console.error(e);
    if (ctx.state.pdfDoc === doc) {
      ps.ocr = { status: 'failed', lines: [], langKey: ps.ocr.langKey };
      showPill(ps, t('ocr.fail'), true, 'ocr.fail');
      ctx.toast(t('ocr.fail'));
    }
  } finally {
    active = null;
    pump();
  }
}

/* ---------- recognition ---------- */

function loadScript(src) {
  scriptLoaded ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => {
      scriptLoaded = null; // allow a retry on the next attempt
      s.remove();
      reject(new Error(`failed to load ${src}`));
    };
    document.head.append(s);
  });
  return scriptLoaded;
}

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerLangs === key) return worker;
  if (worker) { try { await worker.terminate(); } catch { /* already dead */ } worker = null; }
  await loadScript(new URL('vendor/ocr/tesseract.min.js', document.baseURI).toString());
  worker = await Tesseract.createWorker(langs, 1, {
    workerPath: new URL('vendor/ocr/worker.min.js', document.baseURI).toString(),
    corePath: new URL('vendor/ocr/tesseract-core-simd-lstm.wasm.js', document.baseURI).toString(),
    langPath: new URL('vendor/ocr/lang', document.baseURI).toString(),
    gzip: false,
    logger: m => {
      if (active && m.status === 'recognizing text') {
        active.ocr.progress = Math.round(m.progress * 100);
        showPill(active, t('ocr.running', { p: active.ocr.progress }), false);
      }
    },
  });
  workerLangs = key;
  return worker;
}

async function recognizePage(ps, langs, onProgress) {
  // dedicated high-res render so OCR quality is independent of the zoom level
  const scale = Math.min(4, Math.max(1.5, OCR_TARGET_PX / ps.viewport1.width));
  const vp = ps.page.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = Math.floor(vp.width);
  cv.height = Math.floor(vp.height);
  await ps.page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

  const w = await getWorker(langs);
  onProgress(0);
  const res = await w.recognize(cv, {}, { blocks: true, text: false });

  const lines = [];
  for (const block of res.data.blocks || [])
    for (const par of block.paragraphs || [])
      for (const ln of par.lines || []) {
        const text = (ln.text || '').replace(/\s+$/, '');
        if (!text.trim() || ln.confidence < CONF_MIN) continue;
        const bb = ln.bbox;
        const baseY = ln.baseline?.y0 ?? bb.y1;
        // geometry in image px → PDF user space (convertToPdfPoint handles rotation)
        const [bx, by] = vp.convertToPdfPoint(bb.x0 - 2, baseY);
        const [x1, y1] = vp.convertToPdfPoint(bb.x0, bb.y0);
        const [x2, y2] = vp.convertToPdfPoint(bb.x1, bb.y1);
        const ascPx = Math.max(4, baseY - bb.y0);
        const descPx = Math.max(1, bb.y1 - baseY);
        const sizePx = Math.max(6, ascPx / 0.86);
        lines.push({
          text,
          conf: Math.round(ln.confidence),
          start: [bx, by],
          len: (bb.x1 - bb.x0 + 4) / scale,
          size: sizePx / scale,
          asc: ascPx / sizePx,
          desc: -(descPx / sizePx),
          bbox: {
            x: Math.min(x1, x2), y: Math.min(y1, y2),
            w: Math.abs(x2 - x1), h: Math.abs(y2 - y1),
          },
        });
      }
  return lines;
}

/* ---------- turning OCR lines into editable runs ---------- */

function injectOcrRuns(ps) {
  if (!ps.textLayerDiv) return;
  const stamp = `${ps.ocr.langKey}:${ps.ocr.lines.length}`;
  if (ps._ocrLayer === ps.textLayerDiv && ps._ocrStamp === stamp) return;
  for (const old of ps.textLayerDiv.querySelectorAll('.ocr-span')) old.remove();
  ps._ocrLayer = ps.textLayerDiv;
  ps._ocrStamp = stamp;
  const R = ctx.norm360(ps.viewport1.rotation);
  ps.runs = ps.ocr.lines.map((ln, i) => ({
    id: i,
    itemIdxs: [],
    text: ln.text,
    start: ln.start,
    end: [ln.start[0], ln.start[1]],
    len: ln.len,
    size: ln.size,
    angle: R,           // screen-upright on a page rotated by R
    editable: true,
    asc: ln.asc,
    desc: ln.desc,
    fontName: null,
    ocr: true,
    nrect: nrectOf(ps, ln),
  }));

  for (const run of ps.runs) {
    const span = document.createElement('span');
    span.className = 'ocr-span';
    span.textContent = run.text;
    const s = ps.viewport.scale;
    span.style.left = `${run.nrect.nx * s}px`;
    span.style.top = `${run.nrect.ny * s}px`;
    span.style.width = `${run.nrect.nw * s}px`;
    span.style.height = `${run.nrect.nh * s}px`;
    span.style.fontSize = `${Math.max(6, run.nrect.nh * 0.8 * s)}px`;
    span._run = run;
    span._ps = ps;
    ps.textLayerDiv.append(span);
  }
}

function nrectOf(ps, ln) {
  const [ax, ay] = ps.viewport1.convertToViewportPoint(ln.bbox.x, ln.bbox.y);
  const [cx2, cy2] = ps.viewport1.convertToViewportPoint(ln.bbox.x + ln.bbox.w, ln.bbox.y + ln.bbox.h);
  return {
    nx: Math.min(ax, cx2), ny: Math.min(ay, cy2),
    nw: Math.abs(cx2 - ax), nh: Math.abs(cy2 - ay),
  };
}

/* ---------- pill UI ---------- */

function showPill(ps, label, clickable, i18nKey) {
  let pill = ps.el.querySelector('.ocr-pill');
  if (!pill) {
    pill = document.createElement('button');
    pill.className = 'ocr-pill';
    // swallow pointerdown too — otherwise sign/white-out actions fire underneath
    pill.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); });
    pill.addEventListener('click', e => {
      e.stopPropagation();
      if (!pill.disabled) openOcrModal();
    });
    ps.el.append(pill);
  }
  pill.textContent = label;
  pill.disabled = !clickable;
  // static labels follow live 中/EN toggles via the data-i18n mechanism
  if (i18nKey || clickable) pill.dataset.i18n = i18nKey || 'ocr.pill';
  else delete pill.dataset.i18n;
}

function removePill(ps) {
  ps.el.querySelector('.ocr-pill')?.remove();
}
