// Annotations: freehand highlighters (multiplied like real ink) and a pen, stored in page-relative
// coordinates (u across, v down from the top), rendered into per-page overlay textures.
//
// Strokes carry everything needed to draw them, so changing the tool settings later never changes old marks:
//   { tool, pts: [u, v, …], w (base width, fraction of page width), c: [r, g, b], a (alpha),
//     tip: 'round' | 'chisel', wf: [width factor per point] }
// Strokes saved before pressure existed have only { tool, w, pts } and draw as they always did.
//
// Every stroke is drawn as the union of simple polygons with one winding (capsules for a round tip, swept
// nib rectangles for a chisel) filled once with the nonzero rule — so a stroke never darkens where it
// overlaps itself, and the very same outlines go into the exported PDF.

import * as THREE from 'three';
import * as store from './store.js';

// ------------------------------------------------------------------ inks & settings
export const PEN_COLORS = [
  { id: 'ink', rgb: [30, 28, 52], name: 'Blue-black' },
  { id: 'black', rgb: [24, 23, 22], name: 'Black' },
  { id: 'red', rgb: [172, 36, 34], name: 'Red' },
  { id: 'blue', rgb: [28, 68, 168], name: 'Blue' },
  { id: 'green', rgb: [26, 104, 70], name: 'Green' },
];
// alpha is per colour: under multiply a pale yellow needs more ink than a pink to read the same
export const MARKER_COLORS = [
  { id: 'yellow', rgb: [255, 240, 130], a: 0.8, ui: '#f4e400', name: 'Yellow' },
  { id: 'pink', rgb: [255, 150, 200], a: 0.48, ui: '#ff5fa8', name: 'Pink' },
  { id: 'green', rgb: [176, 238, 142], a: 0.62, ui: '#5fd35a', name: 'Green' },
  { id: 'blue', rgb: [150, 208, 255], a: 0.55, ui: '#3fa9f5', name: 'Blue' },
  { id: 'orange', rgb: [255, 186, 104], a: 0.6, ui: '#ff9a2e', name: 'Orange' },
  { id: 'violet', rgb: [208, 176, 255], a: 0.55, ui: '#a77bff', name: 'Violet' },
];

// legacy look of strokes saved without their own colour
export const INKS = {
  pink: { rgb: [255, 150, 200], alpha: 0.48, width: 21 / 1024 },
  yellow: { rgb: [255, 240, 130], alpha: 0.8, width: 21 / 1024 },
  pen: { rgb: [30, 28, 52], alpha: 0.96, width: 2.4 / 1024 },
};

export const TOOL_KIND = { pen: 'pen', pink: 'marker', yellow: 'marker' };
const BASE_W = { pen: 2.4 / 1024, marker: 21 / 1024 };
// ranges for the settings sliders (size is a multiple of the base width)
export const RANGES = {
  pen: { size: [0.4, 3.5] },
  marker: { size: [0.5, 1.8], opacity: [0.4, 1.25] },
  eraser: { size: [0.5, 3] },
};

const DEFAULTS = {
  pen: { color: 'ink', size: 1, pressure: 0.75, smooth: 0.3 },
  pink: { color: 'pink', size: 1, pressure: 0.35, opacity: 1, tip: 'chisel', smooth: 0.35 },
  yellow: { color: 'yellow', size: 1, pressure: 0.35, opacity: 1, tip: 'chisel', smooth: 0.35 },
  eraser: { size: 1 },
};
const LS_KEY = 'folio.ink.v1';

class InkSettings {
  constructor() {
    this.v = structuredClone(DEFAULTS);
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved) for (const t in DEFAULTS) Object.assign(this.v[t], saved[t] || {});
    } catch {
      /* private mode or corrupt — defaults */
    }
    this.listeners = new Set();
  }
  get(tool) {
    return this.v[tool] || this.v.yellow;
  }
  set(tool, key, value) {
    this.v[tool][key] = value;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.v));
    } catch {
      /* not persisted this time */
    }
    for (const f of this.listeners) f(tool, key, value);
  }
  reset(tool) {
    for (const k in DEFAULTS[tool]) this.set(tool, k, DEFAULTS[tool][k]);
  }
  onChange(f) {
    this.listeners.add(f);
  }
  markerColor(tool) {
    const id = this.get(tool).color;
    return MARKER_COLORS.find((c) => c.id === id) || MARKER_COLORS[0];
  }
  penColor() {
    const id = this.v.pen.color;
    return PEN_COLORS.find((c) => c.id === id) || PEN_COLORS[0];
  }
}
export const inkSettings = new InkSettings();

/**
 * Pencil pressure (0…1) → width factor. Apple Pencil writing pressure sits around 0.2–0.45; a light touch
 * draws a hairline, a firm press about twice the set width. `sens` blends from even (0) to fully pressure-led.
 */
export function pressureFactor(kind, p, sens) {
  if (p == null) return 1;
  const q = Math.pow(Math.min(1, Math.max(0, p)), 0.8);
  const f = kind === 'pen' ? Math.min(2.2, 0.15 + 2.0 * q) : Math.min(1.45, 0.55 + 0.95 * q);
  return 1 + (f - 1) * sens;
}

/** A new stroke for `tool` with the current settings. */
export function makeStroke(tool, settings = inkSettings) {
  const kind = TOOL_KIND[tool] || 'marker';
  const st = settings.get(tool);
  if (kind === 'pen') {
    const col = settings.penColor();
    return { tool, c: col.rgb, a: 0.96, w: round5(BASE_W.pen * st.size), tip: 'round', pts: [], wf: [] };
  }
  const col = settings.markerColor(tool);
  return {
    tool,
    c: col.rgb,
    a: round2(Math.min(1, col.a * st.opacity)),
    w: round5(BASE_W.marker * st.size),
    tip: st.tip,
    pts: [],
    wf: [],
  };
}

// ------------------------------------------------------------------ overlay layers
const OVERLAY_W = 1024;

export class InkLayer {
  constructor(bookId, pageAspect, onTexture) {
    this.bookId = bookId;
    this.aspect = pageAspect; // width / height of the page box
    this.marks = new Map(); // page → strokes[]
    this.layers = new Map(); // page → { canvas, ctx, base, bctx, tex, dirty, baseDirty }
    this.undoStack = [];
    this.live = null; // { page, stroke, kind, sens, k, su, sv, sp, ru, rv, rp }
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
      const mk = () => {
        const c = document.createElement('canvas');
        c.width = OVERLAY_W;
        c.height = Math.round(OVERLAY_W / this.aspect);
        return c;
      };
      const canvas = mk();
      const base = mk();
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      l = { canvas, ctx: canvas.getContext('2d'), base, bctx: base.getContext('2d'), tex, dirty: true, baseDirty: true };
      this.layers.set(page, l);
    }
    if (l.dirty) this.redraw(page);
    return l.tex;
  }

  redraw(page) {
    const l = this.layers.get(page);
    if (!l) return;
    const { ctx, canvas, base, bctx } = l;
    const W = canvas.width;
    const H = canvas.height;
    if (l.baseDirty) {
      bctx.clearRect(0, 0, W, H);
      for (const s of this.marks.get(page) || []) drawStroke(bctx, s, W, H);
      l.baseDirty = false;
    }
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(base, 0, 0);
    if (this.live && this.live.page === page) drawStroke(ctx, this.live.stroke, W, H);
    l.dirty = false;
    l.tex.needsUpdate = true;
  }

  /** `strokes`: the committed marks changed too (not just the stroke being drawn). */
  invalidate(page, strokes = true) {
    const l = this.layers.get(page);
    if (l) {
      l.dirty = true;
      if (strokes) l.baseDirty = true;
    }
    this.onTexture && this.onTexture(page);
  }

  // -------------------------------------------------------------- drawing
  /** p: pen pressure 0…1, or null for fingers and mice (even weight). */
  begin(page, tool, u, v, p = null) {
    const stroke = makeStroke(tool);
    const kind = TOOL_KIND[tool] || 'marker';
    const st = inkSettings.get(tool);
    this.live = {
      page,
      stroke,
      kind,
      sens: p == null ? 0 : st.pressure,
      k: st.smooth || 0,
      su: u,
      sv: v,
      sp: p,
      ru: u,
      rv: v,
      rp: p,
    };
    this.push(u, v, p);
    this.invalidate(page, false);
  }

  push(u, v, p) {
    const L = this.live;
    L.stroke.pts.push(round4(u), round4(v));
    L.stroke.wf.push(round2(pressureFactor(L.kind, p, L.sens)));
  }

  extend(u, v, p = null) {
    const L = this.live;
    if (!L) return;
    L.ru = u;
    L.rv = v;
    L.rp = p;
    // steadiness: the drawn point trails the pencil a little, ironing out tremor
    const f = 1 - 0.82 * L.k;
    L.su += (u - L.su) * f;
    L.sv += (v - L.sv) * f;
    if (p != null) L.sp = L.sp == null ? p : L.sp + (p - L.sp) * 0.5; // pressure is jittery; always calm it
    const pts = L.stroke.pts;
    const du = L.su - pts[pts.length - 2];
    const dv = (L.sv - pts[pts.length - 1]) / this.aspect;
    if (du * du + dv * dv < 0.0011 * 0.0011) {
      // too close for a new point, but let the pressure through (pressing harder in place)
      if (p != null) L.stroke.wf[L.stroke.wf.length - 1] = round2(pressureFactor(L.kind, L.sp, L.sens));
      return;
    }
    this.push(L.su, L.sv, L.sp);
    this.invalidate(L.page, false);
  }

  end() {
    const L = this.live;
    if (!L) return;
    const { page, stroke } = L;
    // catch up with where the pencil actually lifted
    const pts = stroke.pts;
    const du = L.ru - pts[pts.length - 2];
    const dv = (L.rv - pts[pts.length - 1]) / this.aspect;
    if (du * du + dv * dv > 0.0006 * 0.0006) this.push(L.ru, L.rv, L.sp);
    this.live = null;
    if (pts.length === 2) {
      // a dot
      pts.push(round4(pts[0] + 0.0005), pts[1]);
      stroke.wf.push(stroke.wf[0]);
    }
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
    this.invalidate(p, false);
  }

  /** Remove every stroke touched by an eraser at (u, v). Returns the number removed. */
  eraseAt(page, u, v, radius = 0.018 * inkSettings.get('eraser').size) {
    const list = this.marks.get(page);
    if (!list || !list.length) return 0;
    const a = this.aspect;
    const keep = [];
    let removed = 0;
    for (const s of list) {
      if (hitStroke(s, u, v / a, radius + (s.w * maxOf(s.wf)) / 2, a)) {
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

function round2(x) {
  return Math.round(x * 100) / 100;
}
function round4(x) {
  return Math.round(x * 10000) / 10000;
}
function round5(x) {
  return Math.round(x * 100000) / 100000;
}
function maxOf(a) {
  if (!a || !a.length) return 1;
  let m = 0;
  for (const x of a) if (x > m) m = x;
  return m;
}

// ------------------------------------------------------------------ geometry
/** Colour, alpha and tip of a stroke (falling back to the old fixed inks). */
export function strokeLook(s) {
  const legacy = INKS[s.tool] || INKS.yellow;
  return {
    rgb: s.c || legacy.rgb,
    alpha: s.a ?? legacy.alpha,
    tip: s.tip || 'round',
    kind: TOOL_KIND[s.tool] || 'marker',
  };
}

const NIB_ANGLE = (-72 * Math.PI) / 180; // a chisel held the usual way: broad edge steep, leaning right
const NIB_THIN = 0.2; // nib thickness / nib length

/**
 * The stroke smoothed into a dense polyline in a W×H box: midpoint quadratics through the samples (as the
 * strokes have always been drawn), each split into short pieces, with interpolated half-widths.
 */
function strokePath(s, W, H) {
  const p = s.pts;
  const n = p.length / 2;
  const wf = s.wf;
  const r0 = (Math.max(s.w * W, 0.9) / 2);
  const X = (i) => p[2 * i] * W;
  const Y = (i) => p[2 * i + 1] * H;
  const R = (i) => r0 * (wf && wf[i] != null ? wf[i] : 1);
  const xs = [X(0)];
  const ys = [Y(0)];
  const rs = [R(0)];
  if (n === 1) return { xs, ys, rs };
  const quad = (ax, ay, ar, cx, cy, cr, bx, by, br) => {
    const len = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy);
    const steps = Math.max(1, Math.min(12, Math.ceil(len / 2.5)));
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const a = (1 - t) * (1 - t);
      const b = 2 * t * (1 - t);
      const c = t * t;
      xs.push(a * ax + b * cx + c * bx);
      ys.push(a * ay + b * cy + c * by);
      rs.push(a * ar + b * cr + c * br);
    }
  };
  if (n === 2) {
    xs.push(X(1));
    ys.push(Y(1));
    rs.push(R(1));
    return { xs, ys, rs };
  }
  let ax = X(0);
  let ay = Y(0);
  let ar = R(0);
  for (let i = 1; i < n - 1; i++) {
    const bx = (X(i) + X(i + 1)) / 2;
    const by = (Y(i) + Y(i + 1)) / 2;
    const br = (R(i) + R(i + 1)) / 2;
    quad(ax, ay, ar, X(i), Y(i), R(i), bx, by, br);
    ax = bx;
    ay = by;
    ar = br;
  }
  xs.push(X(n - 1));
  ys.push(Y(n - 1));
  rs.push(R(n - 1));
  return { xs, ys, rs };
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  return a / 2;
}
function orient(poly) {
  // every piece wound the same way, so the nonzero fill is their union
  if (signedArea(poly) < 0) {
    const out = new Array(poly.length);
    for (let i = 0, n = poly.length / 2; i < n; i++) {
      out[2 * i] = poly[2 * (n - 1 - i)];
      out[2 * i + 1] = poly[2 * (n - 1 - i) + 1];
    }
    return out;
  }
  return poly;
}
function arcSteps(r) {
  return Math.max(2, Math.min(9, Math.ceil(Math.sqrt(r) * 2.2)));
}
function circlePoly(x, y, r) {
  const n = arcSteps(r) * 2 + 2;
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    out.push(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  return out;
}
/** Hull of two discs: half a circle round each end joined by straight sides. */
function capsulePoly(ax, ay, ar, bx, by, br) {
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  if (L + Math.min(ar, br) <= Math.max(ar, br) + 1e-6) return ar > br ? circlePoly(ax, ay, ar) : circlePoly(bx, by, br);
  const ang = Math.atan2(dy, dx);
  const out = [];
  const sb = arcSteps(br);
  for (let k = 0; k <= sb; k++) {
    const a = ang - Math.PI / 2 + (k / sb) * Math.PI;
    out.push(bx + Math.cos(a) * br, by + Math.sin(a) * br);
  }
  const sa = arcSteps(ar);
  for (let k = 0; k <= sa; k++) {
    const a = ang + Math.PI / 2 + (k / sa) * Math.PI;
    out.push(ax + Math.cos(a) * ar, ay + Math.sin(a) * ar);
  }
  return out;
}
/** Convex hull (monotone chain) of a handful of points, as a flat array. */
function hull(pts) {
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [];
  for (const q of pts) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const q = pts[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  const out = [];
  for (const q of lo.concat(up)) out.push(q[0], q[1]);
  return out;
}
function nibCorners(x, y, r) {
  const ex = Math.cos(NIB_ANGLE) * r;
  const ey = Math.sin(NIB_ANGLE) * r;
  const tx = -ey * NIB_THIN;
  const ty = ex * NIB_THIN;
  return [
    [x + ex + tx, y + ey + ty],
    [x + ex - tx, y + ey - ty],
    [x - ex - tx, y - ey - ty],
    [x - ex + tx, y - ey + ty],
  ];
}

/** The stroke as polygons (flat [x, y, …] arrays in a W×H box), all wound the same way. */
export function strokePolygons(s, W, H) {
  const { xs, ys, rs } = strokePath(s, W, H);
  const tip = strokeLook(s).tip;
  const polys = [];
  const n = xs.length;
  if (tip === 'chisel') {
    if (n === 1) polys.push(hull(nibCorners(xs[0], ys[0], rs[0])));
    for (let i = 0; i + 1 < n; i++) polys.push(hull(nibCorners(xs[i], ys[i], rs[i]).concat(nibCorners(xs[i + 1], ys[i + 1], rs[i + 1]))));
  } else {
    if (n === 1) polys.push(circlePoly(xs[0], ys[0], rs[0]));
    for (let i = 0; i + 1 < n; i++) polys.push(capsulePoly(xs[i], ys[i], rs[i], xs[i + 1], ys[i + 1], rs[i + 1]));
  }
  return polys.map(orient);
}

export function drawStroke(ctx, s, W, H) {
  const look = strokeLook(s);
  if (!s.pts || s.pts.length < 2) return;
  const polys = strokePolygons(s, W, H);
  ctx.save();
  ctx.globalAlpha = look.alpha;
  ctx.fillStyle = `rgb(${look.rgb.join(',')})`;
  ctx.beginPath();
  for (const q of polys) {
    ctx.moveTo(q[0], q[1]);
    for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
    ctx.closePath();
  }
  ctx.fill('nonzero');
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
