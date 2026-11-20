// Import PDFs into the library and export them back out with annotations flattened in.

import { openPdf, readMeta, readOutline, renderPageToCanvas, analyseCover, canvasToBlob } from './pdfdoc.js';
import { chooseLook } from './textures.js';
import { bookDims } from './book3d.js';
import { INKS } from './ink.js';
import * as store from './store.js';

function newId() {
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Import files one at a time (keeps memory low on iPad).
 * @returns {Promise<{added: object[], skipped: string[], failed: string[]}>}
 */
export async function importFiles(files, existing, onProgress) {
  const added = [];
  const skipped = [];
  const failed = [];
  const known = new Set(existing.map((m) => m.fingerprint).filter(Boolean));
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    if (!/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
      skipped.push(file.name);
      continue;
    }
    onProgress && onProgress(i, list.length, file.name);
    let doc = null;
    try {
      const buf = await file.arrayBuffer();
      doc = await openPdf(buf);
      const fp = `${(doc.fingerprints && doc.fingerprints[0]) || ''}:${file.size}`;
      if (known.has(fp)) {
        skipped.push(file.name);
        continue;
      }
      const m = await readMeta(doc, file.name);
      const outline = await readOutline(doc);
      const coverW = 720;
      const cover = await renderPageToCanvas(doc, 1, coverW, Math.round(coverW / m.aspect));
      const analysis = analyseCover(cover);
      const coverBlob = await canvasToBlob(cover, 'image/jpeg', 0.86);
      cover.width = cover.height = 1;
      const id = newId();
      const meta = {
        id,
        title: m.title,
        author: m.author,
        pages: m.pages,
        aspect: m.aspect,
        pageW: m.pageW,
        pageH: m.pageH,
        size: file.size,
        fileName: file.name,
        addedAt: Date.now() + i,
        openedAt: 0,
        spread: 0,
        bookmarks: [],
        outline: outline.slice(0, 400),
        fingerprint: fp,
        look: chooseLook(id, m.title, analysis),
      };
      await store.addBook(meta, new Blob([buf], { type: 'application/pdf' }), coverBlob);
      known.add(fp);
      added.push(meta);
    } catch (err) {
      console.error('import failed', file.name, err);
      failed.push(file.name);
    } finally {
      if (doc) doc.destroy();
    }
  }
  return { added, skipped, failed };
}

/** Map a point in the book's page box (u across, v down) to PDF user space for this page. */
function boxToPdf(u, v, page, boxAspect) {
  const crop = page.getCropBox();
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  // size of the page as displayed (rotation applied)
  const vw = rot % 180 === 0 ? crop.width : crop.height;
  const vh = rot % 180 === 0 ? crop.height : crop.width;
  // the page was fitted (letterboxed) into the box when rendered
  const pageAspect = vw / vh;
  let fw = 1;
  let fh = 1;
  if (pageAspect > boxAspect) fh = boxAspect / pageAspect;
  else fw = pageAspect / boxAspect;
  const pu = (u - (1 - fw) / 2) / fw;
  const pv = (v - (1 - fh) / 2) / fh;
  let X;
  let Y;
  switch (rot) {
    case 90:
      X = crop.x + pv * crop.width;
      Y = crop.y + pu * crop.height;
      break;
    case 180:
      X = crop.x + crop.width - pu * crop.width;
      Y = crop.y + pv * crop.height;
      break;
    case 270:
      X = crop.x + crop.width - pv * crop.width;
      Y = crop.y + crop.height - pu * crop.height;
      break;
    default:
      X = crop.x + pu * crop.width;
      Y = crop.y + crop.height - pv * crop.height;
  }
  return { X, Y, boxW: vw / fw };
}

export async function exportAnnotated(meta) {
  const { PDFDocument, rgb, BlendMode, LineCapStyle } = await import('../vendor/pdf-lib/pdf-lib.esm.min.js');
  const blob = await store.getFile(meta.id);
  if (!blob) throw new Error('The PDF file is missing.');
  const bytes = await blob.arrayBuffer();
  const marks = await store.getMarks(meta.id);
  const d = bookDims(meta.pages, meta.aspect);
  const boxAspect = d.Wp / d.Hp;
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  let count = 0;
  for (const [pageNum, strokes] of marks) {
    if (pageNum < 1 || pageNum > pdf.getPageCount()) continue;
    const page = pdf.getPage(pageNum - 1);
    for (const s of strokes) {
      const ink = INKS[s.tool] || INKS.yellow;
      const p = s.pts;
      if (p.length < 2) continue;
      let path = '';
      let boxW = 1;
      for (let i = 0; i < p.length; i += 2) {
        const q = boxToPdf(p[i], p[i + 1], page, boxAspect);
        boxW = q.boxW;
        // drawSvgPath draws relative to (0,0) with y pointing down → negate Y
        path += `${i ? 'L' : 'M'}${q.X.toFixed(2)} ${(-q.Y).toFixed(2)} `;
      }
      if (p.length === 2) {
        const q = boxToPdf(p[0] + 0.0005, p[1], page, boxAspect);
        path += `L${q.X.toFixed(2)} ${(-q.Y).toFixed(2)}`;
      }
      page.drawSvgPath(path, {
        x: 0,
        y: 0,
        borderColor: rgb(ink.rgb[0] / 255, ink.rgb[1] / 255, ink.rgb[2] / 255),
        borderWidth: s.w * boxW,
        borderOpacity: ink.alpha,
        borderLineCap: LineCapStyle.Round,
        blendMode: s.tool === 'pen' ? BlendMode.Normal : BlendMode.Multiply,
      });
      count++;
    }
  }
  const out = await pdf.save();
  const base = (meta.fileName || meta.title || 'book').replace(/\.pdf$/i, '');
  return { blob: new Blob([out], { type: 'application/pdf' }), name: `${base} (annotated).pdf`, count };
}
