// pdf.js wrapper: open documents, render pages to canvases through a single serial queue
// (keeps memory flat on iPad), read metadata/outline, analyse cover colours.

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';

const DOC_OPTS = {
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  isEvalSupported: false,
  disableAutoFetch: true,
  enableXfa: false,
};

export async function openPdf(bytes) {
  // pdf.js transfers (detaches) the buffer it is given, so hand it a copy.
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  const task = pdfjsLib.getDocument({ data, ...DOC_OPTS });
  return task.promise;
}

export async function readMeta(doc, fileName) {
  let title = '';
  let author = '';
  try {
    const md = await doc.getMetadata();
    const info = md && md.info ? md.info : {};
    title = (info.Title || '').trim();
    author = (info.Author || '').trim();
    if (md && md.metadata) {
      title = title || (md.metadata.get('dc:title') || '').trim();
      author = author || (md.metadata.get('dc:creator') || '').toString().trim();
    }
  } catch {}
  const clean = (s) => s.replace(/\s+/g, ' ').replace(/^untitled$/i, '').trim();
  title = clean(title);
  author = clean(author);
  // Titles like "Microsoft Word - foo.docx" or file paths are useless — prefer the file name.
  // "Author - Title.pdf" is a common naming scheme
  const base = (fileName || '').replace(/\.pdf$/i, '').replace(/_/g, ' ').trim();
  const named = base.match(/^(.{2,60}?)\s+[-–—]\s+(.{2,})$/);
  const looksLikeFile = /\.(docx?|pdf|tex|indd|pages|html?|txt|rtf|odt|md|qxd)$/i.test(title) || /^(microsoft word|untitled|document\d*$)/i.test(title);
  if (!title || looksLikeFile || title.length < 2) {
    if (named) {
      title = named[2].trim();
      if (!author) author = named[1].trim();
    } else title = prettyFileName(fileName);
  } else if (!author && named) {
    const a = named[2].trim().toLowerCase();
    const b = title.toLowerCase();
    if (a.startsWith(b.slice(0, 8)) || b.startsWith(a.slice(0, 8))) author = named[1].trim();
  }
  const page1 = await doc.getPage(1);
  const vp = page1.getViewport({ scale: 1 });
  return { title, author, pages: doc.numPages, aspect: vp.width / vp.height, pageW: vp.width, pageH: vp.height };
}

export function prettyFileName(name = 'Untitled') {
  return (
    name
      .replace(/\.pdf$/i, '')
      .replace(/[_]+/g, ' ')
      .replace(/\s*-\s*/g, ' – ')
      .replace(/\s+/g, ' ')
      .trim() || 'Untitled'
  );
}

export async function readOutline(doc) {
  try {
    const outline = await doc.getOutline();
    if (!outline) return [];
    const out = [];
    const walk = async (items, depth) => {
      for (const it of items) {
        if (out.length > 400) return;
        let page = null;
        try {
          let dest = it.dest;
          if (typeof dest === 'string') dest = await doc.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            page = typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
          }
        } catch {}
        out.push({ title: (it.title || '').trim(), page, depth });
        if (it.items && it.items.length && depth < 3) await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
    return out.filter((o) => o.title);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------
// Serial render queue. Every page render goes through here so only one big canvas exists at a time.

class RenderQueue {
  constructor() {
    this.jobs = [];
    this.running = false;
  }
  push(job) {
    // job: { key, priority, run: async () => any, resolve, reject, cancelled }
    const existing = this.jobs.find((j) => j.key === job.key);
    if (existing) {
      existing.priority = Math.min(existing.priority, job.priority);
      return existing.promise;
    }
    job.promise = new Promise((res, rej) => {
      job.resolve = res;
      job.reject = rej;
    });
    this.jobs.push(job);
    this.pump();
    return job.promise;
  }
  cancelWhere(pred) {
    this.jobs = this.jobs.filter((j) => {
      if (pred(j)) {
        j.reject(new Error('cancelled'));
        return false;
      }
      return true;
    });
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length) {
      this.jobs.sort((a, b) => a.priority - b.priority);
      const job = this.jobs.shift();
      try {
        job.resolve(await job.run());
      } catch (e) {
        job.reject(e);
      }
      // yield to the frame loop between renders
      await new Promise((r) => setTimeout(r, 0));
    }
    this.running = false;
  }
}

export const renderQueue = new RenderQueue();

/**
 * Render a page into a canvas whose size fits `boxW × boxH` (the book's page box, so pages of
 * other sizes are letterboxed on paper instead of stretched).
 */
export async function renderPageToCanvas(doc, pageNum, boxW, boxH, { background = '#ffffff' } = {}) {
  const page = await doc.getPage(pageNum);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(boxW / vp1.width, boxH / vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(boxW);
  canvas.height = Math.round(boxH);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const ox = Math.round((canvas.width - vp.width) / 2);
  const oy = Math.round((canvas.height - vp.height) / 2);
  ctx.save();
  ctx.translate(ox, oy);
  await page.render({ canvasContext: ctx, viewport: vp, intent: 'display', annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  ctx.restore();
  page.cleanup();
  return canvas;
}

// ---------------------------------------------------------------------------------------------
// Colour analysis of the cover

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

/**
 * Decide whether page 1 is a designed cover (full-bleed colour/imagery) or a plain title page,
 * and pick colours for the cloth binding.
 */
export function analyseCover(canvas) {
  const w = 48;
  const h = Math.max(8, Math.round((canvas.height / canvas.width) * w));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  let inked = 0;
  let satSum = 0;
  const buckets = new Map();
  let edge = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const [hh, s, l] = rgbToHsl(r, g, b);
      satSum += s;
      if (l < 0.86 || s > 0.25) inked++;
      if (x < 4) {
        edge[0] += r;
        edge[1] += g;
        edge[2] += b;
        edge[3]++;
      }
      // coarse colour buckets for a dominant colour
      const key = `${Math.round(r / 32)},${Math.round(g / 32)},${Math.round(b / 32)}`;
      const bk = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, s: 0 };
      bk.n++;
      bk.r += r;
      bk.g += g;
      bk.b += b;
      bk.s += s;
      buckets.set(key, bk);
    }
  }
  const total = w * h;
  const inkFrac = inked / total;
  const meanSat = satSum / total;
  const designed = inkFrac > 0.5 || (meanSat > 0.2 && inkFrac > 0.3);
  // dominant non-white bucket, weighted by saturation so a coloured block beats grey text
  let best = null;
  let bestScore = -1;
  for (const bk of buckets.values()) {
    const r = bk.r / bk.n;
    const g = bk.g / bk.n;
    const b = bk.b / bk.n;
    const [, s, l] = rgbToHsl(r, g, b);
    if (l > 0.9) continue;
    const score = bk.n * (0.35 + s);
    if (score > bestScore) {
      bestScore = score;
      best = [r, g, b];
    }
  }
  const edgeColor = edge[3] ? [edge[0] / edge[3], edge[1] / edge[3], edge[2] / edge[3]] : best;
  const hex = (rgb) => (rgb ? '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') : null);
  return { designed, inkFrac, meanSat, dominant: hex(best), edge: hex(edgeColor) };
}

export async function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.86) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), type, quality));
}
