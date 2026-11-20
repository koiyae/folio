// Annotations: freehand highlighter (pink / yellow, multiplied like real ink) and pen strokes, stored in
// page-relative coordinates (u across, v down from the top), rendered into per-page overlay textures.

import * as THREE from 'three';
import * as store from './store.js';

export const INKS = {
  pink: { rgb: [255, 150, 200], alpha: 0.48, width: 21 / 1024, ui: '#ff5fa8', label: 'Pink highlighter' },
  yellow: { rgb: [255, 240, 130], alpha: 0.8, width: 21 / 1024, ui: '#f4e400', label: 'Yellow highlighter' },
  pen: { rgb: [30, 28, 52], alpha: 0.96, width: 2.4 / 1024, ui: '#1e1c34', label: 'Pen' },
};

const OVERLAY_W = 1024;

export class InkLayer {
  constructor(bookId, pageAspect, onTexture) {
    this.bookId = bookId;
    this.aspect = pageAspect; // width / height of the page box
    this.marks = new Map(); // page → strokes[]
    this.layers = new Map(); // page → { canvas, ctx, tex, dirty }
    this.undoStack = [];
    this.live = null; // { page, stroke }
    this.saveTimers = new Map();
    this.onTexture = onTexture; // (page) => void — tell the reader a texture appeared / changed
  }

  async load() {
    this.marks = await store.getMarks(this.bookId);
  }

  count() {
    let n = 0;
    for (const s of this.marks.values()) n += s.length;
    return n;
  }

  pagesWithMarks() {
    return [...this.marks.keys()].filter((p) => this.marks.get(p).length).sort((a, b) => a - b);
  }

  /** Overlay texture for a page, or null when the page has no ink. */
  texture(page) {
    const strokes = this.marks.get(page);
    const live = this.live && this.live.page === page;
    if ((!strokes || !strokes.length) && !live) {
      const l = this.layers.get(page);
      if (l) {
        l.tex.dispose();
        this.layers.delete(page);
      }
      return null;
    }
    let l = this.layers.get(page);
    if (!l) {
      const canvas = document.createElement('canvas');
      canvas.width = OVERLAY_W;
      canvas.height = Math.round(OVERLAY_W / this.aspect);
      const ctx = canvas.getContext('2d');
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      l = { canvas, ctx, tex, dirty: true };
      this.layers.set(page, l);
    }
    if (l.dirty) this.redraw(page);
    return l.tex;
  }

  redraw(page) {
    const l = this.layers.get(page);
    if (!l) return;
    const { ctx, canvas } = l;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const strokes = this.marks.get(page) || [];
    for (const s of strokes) drawStroke(ctx, s, canvas.width, canvas.height);
    if (this.live && this.live.page === page) drawStroke(ctx, this.live.stroke, canvas.width, canvas.height);
    l.dirty = false;
    l.tex.needsUpdate = true;
  }

  invalidate(page) {
    const l = this.layers.get(page);
    if (l) l.dirty = true;
    this.onTexture && this.onTexture(page);
  }

  // -------------------------------------------------------------- drawing
  begin(page, tool, u, v) {
    const ink = INKS[tool];
    this.live = { page, stroke: { tool, w: ink.width, pts: [round4(u), round4(v)] } };
    this.invalidate(page);
  }

  extend(u, v) {
    if (!this.live) return;
    const pts = this.live.stroke.pts;
    const lu = pts[pts.length - 2];
    const lv = pts[pts.length - 1];
    const du = u - lu;
    const dv = (v - lv) / this.aspect;
    if (du * du + dv * dv < 0.0016 * 0.0016) return;
    pts.push(round4(u), round4(v));
    this.invalidate(this.live.page);
  }

  end() {
    if (!this.live) return;
    const { page, stroke } = this.live;
    this.live = null;
    if (stroke.pts.length === 2) stroke.pts.push(stroke.pts[0] + 0.0005, stroke.pts[1]); // a dot
    const list = this.marks.get(page) || [];
    list.push(stroke);
    this.marks.set(page, list);
    this.undoStack.push({ type: 'add', page, stroke });
    this.invalidate(page);
    this.save(page);
  }

  cancel() {
    if (!this.live) return;
    const p = this.live.page;
    this.live = null;
    this.invalidate(p);
  }

  /** Remove every stroke touched by an eraser at (u, v). Returns the number removed. */
  eraseAt(page, u, v, radius = 0.018) {
    const list = this.marks.get(page);
    if (!list || !list.length) return 0;
    const a = this.aspect;
    const keep = [];
    let removed = 0;
    for (const s of list) {
      if (hitStroke(s, u, v / a, radius + s.w / 2, a)) {
        this.undoStack.push({ type: 'remove', page, stroke: s });
        removed++;
      } else keep.push(s);
    }
    if (removed) {
      this.marks.set(page, keep);
      this.invalidate(page);
      this.save(page);
    }
    return removed;
  }

  clearPage(page) {
    const list = this.marks.get(page);
    if (!list || !list.length) return;
    for (const s of list) this.undoStack.push({ type: 'remove', page, stroke: s });
    this.marks.set(page, []);
    this.invalidate(page);
    this.save(page);
  }

  undo() {
    const op = this.undoStack.pop();
    if (!op) return null;
    const list = this.marks.get(op.page) || [];
    if (op.type === 'add') {
      const i = list.lastIndexOf(op.stroke);
      if (i >= 0) list.splice(i, 1);
    } else list.push(op.stroke);
    this.marks.set(op.page, list);
    this.invalidate(op.page);
    this.save(op.page);
    return op.page;
  }

  save(page) {
    clearTimeout(this.saveTimers.get(page));
    this.saveTimers.set(
      page,
      setTimeout(() => {
        store.putMarks(this.bookId, page, this.marks.get(page) || []).catch((e) => console.warn('save marks', e));
      }, 350),
    );
  }

  dispose() {
    for (const l of this.layers.values()) l.tex.dispose();
    this.layers.clear();
    // flush pending saves
    for (const [page, t] of this.saveTimers) {
      clearTimeout(t);
      store.putMarks(this.bookId, page, this.marks.get(page) || []).catch(() => {});
    }
    this.saveTimers.clear();
  }
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

export function drawStroke(ctx, s, W, H) {
  const ink = INKS[s.tool] || INKS.yellow;
  const p = s.pts;
  ctx.save();
  ctx.globalAlpha = ink.alpha;
  ctx.strokeStyle = `rgb(${ink.rgb.join(',')})`;
  ctx.lineWidth = Math.max(1, s.w * W);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p[0] * W, p[1] * H);
  if (p.length <= 4) ctx.lineTo(p[p.length - 2] * W, p[p.length - 1] * H);
  else {
    for (let i = 2; i < p.length - 2; i += 2) {
      const mx = ((p[i] + p[i + 2]) / 2) * W;
      const my = ((p[i + 1] + p[i + 3]) / 2) * H;
      ctx.quadraticCurveTo(p[i] * W, p[i + 1] * H, mx, my);
    }
    ctx.lineTo(p[p.length - 2] * W, p[p.length - 1] * H);
  }
  ctx.stroke();
  ctx.restore();
}

function hitStroke(s, u, vy, r, aspect) {
  const p = s.pts;
  const r2 = r * r;
  for (let i = 0; i < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1] / aspect;
    if (i + 2 >= p.length) {
      const dx = u - ax;
      const dy = vy - ay;
      if (dx * dx + dy * dy <= r2) return true;
      break;
    }
    const bx = p[i + 2];
    const by = p[i + 3] / aspect;
    const vx = bx - ax;
    const vy2 = by - ay;
    const L = vx * vx + vy2 * vy2 || 1e-9;
    let t = ((u - ax) * vx + (vy - ay) * vy2) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = u - (ax + vx * t);
    const dy = vy - (ay + vy2 * t);
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}
