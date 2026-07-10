// Applies the edit ops to the original PDF bytes with pdf-lib and returns new bytes.
// All op coordinates are pre-computed in PDF user space (see app.js), so this file
// only needs to draw — no viewport math beyond the shared `placeBox` helper.

const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ' +
  '‘’“”•–—˜™š›œžŸ';

export function winAnsiOk(text) {
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x09) continue;
    if (c >= 0x20 && c <= 0x7e) continue;
    if (c >= 0xa0 && c <= 0xff) continue;
    if (WINANSI_EXTRA.includes(ch)) continue;
    return false;
  }
  return true;
}

const STD_MAP = {
  helv: 'Helvetica', helvB: 'HelveticaBold', helvI: 'HelveticaOblique', helvBI: 'HelveticaBoldOblique',
  times: 'TimesRoman', timesB: 'TimesRomanBold', timesI: 'TimesRomanItalic', timesBI: 'TimesRomanBoldItalic',
  cour: 'Courier', courB: 'CourierBold', courI: 'CourierOblique', courBI: 'CourierBoldOblique',
};

// Convert a screen-axis-aligned box (normalized viewport coords, scale 1) into a
// pdf-lib placement: anchor point + rotation that keeps content upright on screen.
// Returns {x, y, w, h, rot} where (x,y) is where pdf-lib should anchor the
// *bottom-left corner* of the drawn box.
export function placeBox(viewport1, nx, ny, nw, nh) {
  const rot = ((viewport1.rotation % 360) + 360) % 360;
  const [x, y] = viewport1.convertToPdfPoint(nx, ny + nh); // screen bottom-left corner
  return { x, y, w: nw, h: nh, rot };
}

// Axis-aligned rectangle in PDF space from a screen box (for white-outs).
export function pdfRect(viewport1, nx, ny, nw, nh) {
  const [x1, y1] = viewport1.convertToPdfPoint(nx, ny);
  const [x2, y2] = viewport1.convertToPdfPoint(nx + nw, ny + nh);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x1 - x2), h: Math.abs(y1 - y2) };
}

function col(rgbArr) {
  const { rgb } = PDFLib;
  return rgb(rgbArr[0] / 255, rgbArr[1] / 255, rgbArr[2] / 255);
}

// state: {pdfBytes, ops, pages:[{viewport1}], fontBytes}
// acquireUnicodeFont: async () => Uint8Array | null  (null = user cancelled)
export async function exportPdf(state, acquireUnicodeFont) {
  const { PDFDocument, StandardFonts, degrees } = PDFLib;

  const uniOps = state.ops.filter(op =>
    (op.type === 'edit' || op.type === 'add') && !winAnsiOk(op.text));
  const needsUni = uniOps.length > 0;

  let uniBytes = null;
  if (needsUni) {
    // hand the actual non-WinAnsi characters to the picker so it can verify
    // the chosen font really covers them
    const uniChars = [...new Set(uniOps.flatMap(op => [...op.text].filter(ch => !winAnsiOk(ch))))].join('');
    uniBytes = await acquireUnicodeFont(uniChars);
    if (!uniBytes) return null; // cancelled
    state.fontBytes = uniBytes;
  }

  const doc = await PDFDocument.load(state.pdfBytes, { updateMetadata: false });
  const pages = doc.getPages();

  let uniFont = null;
  if (needsUni) {
    doc.registerFontkit(window.fontkit);
    uniFont = await doc.embedFont(uniBytes, { subset: true });
  }
  const stdCache = new Map();
  const imgCache = new Map();
  const font = async (op) => {
    if (!winAnsiOk(op.text)) return uniFont;
    const key = op.font || 'helv';
    if (!stdCache.has(key))
      stdCache.set(key, await doc.embedFont(StandardFonts[STD_MAP[key] || 'Helvetica']));
    return stdCache.get(key);
  };

  for (const op of state.ops) {
    const page = pages[op.page];
    const vp1 = state.pages[op.page].viewport1;
    if (!page || !vp1) continue;

    if (op.type === 'rect') {
      const r = pdfRect(vp1, op.nx, op.ny, op.nw, op.nh);
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: col(op.bg) });

    } else if (op.type === 'image') {
      const p = placeBox(vp1, op.nx, op.ny, op.nw, op.nh);
      if (!imgCache.has(op.dataUrl)) {
        const bytes = dataUrlBytes(op.dataUrl);
        imgCache.set(op.dataUrl, op.dataUrl.startsWith('data:image/jpeg')
          ? await doc.embedJpg(bytes)   // photos keep their JPEG encoding
          : await doc.embedPng(bytes));
      }
      page.drawImage(imgCache.get(op.dataUrl), {
        x: p.x, y: p.y, width: p.w, height: p.h, rotate: degrees(p.rot),
      });

    } else if (op.type === 'edit') {
      const f = await font(op);
      const size = op.size;
      const asc = op.asc, desc = op.desc;      // em fractions, desc <= 0
      const rad = op.angle * Math.PI / 180;    // raw text angle in PDF space
      const dirX = Math.cos(rad), dirY = Math.sin(rad);
      const upX = -dirY, upY = dirX;
      const newW = f.widthOfTextAtSize(op.text, size);
      // pad the cover box a little: ascender/descender tips sit exactly on the
      // font's asc/desc lines and would otherwise leave 1px slivers behind
      const padA = 0.06 * size, padD = 0.10 * size, padL = 1.5;
      const boxW = Math.max(op.len, newW) + 2 * padL;
      const boxH = (asc - desc) * size + padA + padD;
      // rectangle origin: baseline start pushed down past the descender line
      const ox = op.bx + upX * (desc * size - padD) - dirX * padL;
      const oy = op.by + upY * (desc * size - padD) - dirY * padL;
      page.drawRectangle({
        x: ox, y: oy, width: boxW, height: boxH,
        color: col(op.bg), rotate: degrees(op.angle),
      });
      if (op.text.trim())
        page.drawText(op.text, {
          x: op.bx, y: op.by, size, font: f, color: col(op.fg), rotate: degrees(op.angle),
        });

    } else if (op.type === 'add') {
      const f = await font(op);
      const lineH = op.size * 1.25;
      // first baseline sits ~0.97em below the visual top of the box (see app.js)
      const rot = ((vp1.rotation % 360) + 360) % 360;
      const [bx, by] = vp1.convertToPdfPoint(op.nx, op.ny + op.size * 0.97);
      page.drawText(op.text, {
        x: bx, y: by, size: op.size, font: f, color: col(op.fg),
        rotate: degrees(rot), lineHeight: lineH,
      });
    }
  }

  return await doc.save();
}

function dataUrlBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
