// The marks a reader leaves in a book: the ribbon and the flags.
//
// The ribbon is your place. A silk ribbon fixed at the head of the spine lies in the book where you are reading
// and hangs out at its tail. Turning pages carries it along; jumping elsewhere (a flag, the contents, a page
// number) leaves it where you were, like a finger kept in the book, and tapping it takes you back.
//
// Flags are sticky index flags on the pages you marked: one for each leaf with ink on it (in its ink's colour,
// translucent plastic) and one for each bookmarked spread (red paper). They stick out of the head of the book, on
// the shelf and in the reader, each at its own place along the edge so they don't hide one another.

import * as THREE from 'three';
import { stackProfile } from './book3d.js';
import { MARKER_COLORS, PEN_COLORS, TOOL_KIND, INKS } from './ink.js';
import { hexToRgb, luminance } from './textures.js';

export const FLAG = { W: 1.05, H: 1.5, STUCK: 0.62, T: 0.035, LIFT: 0.55 };
export const BOOKMARK_TONE = '#cf4a2d';
const PHI = 0.6180339887;

// ------------------------------------------------------------------ which flags a book has
/** Where along the head edge (0 gutter … 1 fore-edge) a leaf's flag sits: spread out, the same every time. */
const slot = (k, off) => 0.3 + 0.58 * ((((k + 1) * PHI + off) % 1 + 1) % 1);

/**
 * The flags of a book: [{ key, kind: 'ink' | 'bookmark', k (leaf), page, spread (to open), tone, front, u }].
 * Ink flags come from meta.inkPages ([[page, tone]], kept up to date by the reader); one per leaf.
 */
export function flagsOf(meta) {
  const pages = meta.pages || 1;
  const leaves = Math.max(1, Math.ceil(pages / 2));
  const out = [];
  const seen = new Set();
  for (const [page, tone] of meta.inkPages || []) {
    if (!(page >= 1 && page <= pages)) continue;
    const k = Math.floor((page - 1) / 2);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ key: 'i' + k, kind: 'ink', k, page, spread: Math.floor(page / 2), tone, front: page % 2 === 1, u: slot(k, 0) });
  }
  for (const s of meta.bookmarks || []) {
    if (!(s >= 0 && s <= leaves)) continue;
    const k = s < leaves ? s : leaves - 1;
    out.push({ key: 'b' + s, kind: 'bookmark', k, page: Math.max(1, Math.min(pages, 2 * s)), spread: s, tone: BOOKMARK_TONE, front: s < leaves, u: slot(k, 0.5) });
  }
  return out.sort((a, b) => a.k - b.k || (a.kind < b.kind ? -1 : 1));
}

const sameRgb = (a, b) => a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
// pens write dark: their flags are the same hue, light enough to read as a flag
const PEN_FLAGS = { ink: '#7186cc', black: '#8e8c86', red: '#de6656', blue: '#5c93e2', green: '#55ad7f' };

/** The flag colour for a page's strokes: its most used ink (highlighters count a little more). */
function toneOf(strokes) {
  const count = new Map();
  for (const s of strokes) {
    const kind = TOOL_KIND[s.tool] || 'marker';
    const rgb = s.c || (INKS[s.tool] || INKS.yellow).rgb;
    let hex;
    if (kind === 'pen') {
      const p = PEN_COLORS.find((c) => sameRgb(c.rgb, rgb));
      hex = PEN_FLAGS[p ? p.id : 'ink'];
    } else {
      const m = MARKER_COLORS.find((c) => sameRgb(c.rgb, rgb));
      hex = m ? m.ui : '#f4e400';
    }
    count.set(hex, (count.get(hex) || 0) + (kind === 'pen' ? 1 : 1.5));
  }
  let best = '#f4e400';
  let n = -1;
  for (const [h, c] of count) if (c > n) [best, n] = [h, c];
  return best;
}

/** meta.inkPages from a book's marks (Map page → strokes). */
export function inkPagesOf(marks) {
  const out = [];
  for (const [page, strokes] of marks) if (strokes && strokes.length) out.push([page, toneOf(strokes)]);
  return out.sort((a, b) => a[0] - b[0]);
}

// ------------------------------------------------------------------ the ribbon's colour
export const RIBBONS = [
  { hex: '#7d1f2d', name: 'Burgundy' },
  { hex: '#c49b47', name: 'Gold' },
  { hex: '#24355f', name: 'Navy' },
  { hex: '#2f5739', name: 'Green' },
  { hex: '#e7ddc6', name: 'Ivory' },
];

/**
 * The ribbon's colour (look.ribbon, or the classic burgundy — gold on very dark or red bindings, so it still
 * shows); null: no ribbon.
 */
export function ribbonColor(look) {
  if (look && look.ribbon === 'none') return null;
  if (look && look.ribbon && /^#/.test(look.ribbon)) return look.ribbon;
  const [r, g, b] = hexToRgb((look && look.cloth) || '#888888').map((v) => v / 255);
  const L = luminance((look && look.cloth) || '#888888');
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const reddish = max === r && max - min > 0.18 && g < r * 0.75 && b < r * 0.8;
  if (L < 0.06 || reddish) return '#c49b47';
  return '#7d1f2d';
}

// ------------------------------------------------------------------ flag meshes
const FLAG_GEO = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const matCache = new Map();
function flagMaterial(tone, kind) {
  const key = kind + tone;
  if (!matCache.has(key)) {
    const paper = kind === 'bookmark';
    matCache.set(
      key,
      new THREE.MeshStandardMaterial({ color: tone, roughness: paper ? 0.8 : 0.38, metalness: 0, transparent: !paper, opacity: paper ? 1 : 0.9 }),
    );
  }
  return matCache.get(key);
}

export function makeFlagMesh(flag) {
  const m = new THREE.Mesh(FLAG_GEO, flagMaterial(flag.tone, flag.kind));
  m.matrixAutoUpdate = false;
  m.castShadow = true;
  m.renderOrder = 3;
  m.userData.flag = flag;
  m.userData.lift = 0;
  return m;
}

/**
 * Place a flag: P on the page's head edge; T across the page (away from the gutter), U out of the head, N = T×U
 * (all unit vectors in the parent's frame); `side` +1 when it is stuck on the page N faces, −1 on the other.
 * It sticks STUCK down onto the page and H out. (N is never flipped: a mirrored box shows its inside.)
 */
export function flagMatrix(out, P, T, U, N, lift = 0, side = 1) {
  const { W, H, STUCK, T: th } = FLAG;
  const L = STUCK + H;
  const off = (th / 2 + 0.006) * side;
  const b = STUCK - lift;
  out.set(
    T.x * W, U.x * L, N.x * th, P.x - U.x * b + N.x * off,
    T.y * W, U.y * L, N.y * th, P.y - U.y * b + N.y * off,
    T.z * W, U.z * L, N.z * th, P.z - U.z * b + N.z * off,
    0, 0, 0, 1,
  );
  return out;
}

const _c = new THREE.Vector3();
/**
 * The part of a flag that sticks out, on screen: { l, r, t, b, z } (z: depth, for the front-most). `above`: how
 * far above the page's edge it starts counting (a shut book's boards stand a little higher than its pages).
 */
export function flagScreenBox(matrixWorld, camera, W, H, above = 0) {
  const y0 = (FLAG.STUCK + above) / (FLAG.STUCK + FLAG.H);
  let l = Infinity;
  let r = -Infinity;
  let t = Infinity;
  let b = -Infinity;
  let z = 0;
  for (const [x, y] of [[-0.5, y0], [0.5, y0], [-0.5, 1], [0.5, 1]]) {
    _c.set(x, y, 0).applyMatrix4(matrixWorld).project(camera);
    const sx = (_c.x * 0.5 + 0.5) * W;
    const sy = (-_c.y * 0.5 + 0.5) * H;
    l = Math.min(l, sx);
    r = Math.max(r, sx);
    t = Math.min(t, sy);
    b = Math.max(b, sy);
    z += _c.z / 4;
  }
  return { l, r, t, b, z };
}

/**
 * Of `items` ({ box }), the one a tap at (x, y) is on: inside its box grown by `pad` px (but never below it —
 * below a flag is its page or its book), the front-most.
 */
export function pickBox(items, x, y, pad = 8) {
  let best = null;
  let bestD = Infinity;
  for (const it of items) {
    const bx = it.box;
    if (!bx || x < bx.l - pad || x > bx.r + pad || y < bx.t - pad || y > bx.b) continue;
    const cx = (bx.l + bx.r) / 2;
    const cy = (bx.t + bx.b) / 2;
    // nearest centre, then the front-most
    const d = Math.hypot(x - cx, (y - cy) * 0.5) + bx.z * 4;
    if (d < bestD) [best, bestD] = [it, d];
  }
  return best;
}

// ------------------------------------------------------------------ flags of a closed book (the shelf)
const _m = new THREE.Matrix4();
const _P = new THREE.Vector3();
const AX = { T: new THREE.Vector3(1, 0, 0), U: new THREE.Vector3(0, 1, 0), N: new THREE.Vector3(0, 0, 1) };

/** Where a closed book's leaf lies (book frame): leaf 0 just under the front cover, at z = tp. */
export function closedLeafZ(d, k) {
  return (d.tp * (d.leaves - k - 0.5)) / d.leaves;
}

/**
 * The flags of a book standing shut, merged into one mesh (one draw call a book). `lifted`: the key of a flag
 * raised for a tap. Returns { mesh, items: [{ flag, matrix (book frame) }] }.
 */
export function shelfFlagMesh(d, flags, lifted = null) {
  if (!flags.length) return null;
  const pos = [];
  const nor = [];
  const col = [];
  const idx = [];
  const gp = FLAG_GEO.attributes.position;
  const gn = FLAG_GEO.attributes.normal;
  const gi = FLAG_GEO.index.array;
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  const color = new THREE.Color();
  const items = [];
  for (const f of flags) {
    _P.set(f.u * d.Wp, d.Hp / 2, closedLeafZ(d, f.k));
    const lift = f.key === lifted ? FLAG.LIFT : 0;
    const m = flagMatrix(new THREE.Matrix4(), _P, AX.T, AX.U, AX.N, lift, f.front ? 1 : -1);
    items.push({ flag: f, matrix: m });
    nm.getNormalMatrix(m);
    color.set(f.tone);
    const base = pos.length / 3;
    for (let i = 0; i < gp.count; i++) {
      v.fromBufferAttribute(gp, i).applyMatrix4(m);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      nor.push(v.x, v.y, v.z);
      col.push(color.r, color.g, color.b);
    }
    for (const i of gi) idx.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  const mesh = new THREE.Mesh(g, SHELF_FLAG_MAT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, items };
}
const SHELF_FLAG_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.48, metalness: 0 });

// ------------------------------------------------------------------ the ribbon
const ribbonMats = new Map();
function ribbonMaterial(hex) {
  if (!ribbonMats.has(hex)) {
    const c = new THREE.Color(hex);
    ribbonMats.set(
      hex,
      new THREE.MeshPhysicalMaterial({
        color: c,
        roughness: 0.52,
        metalness: 0,
        sheen: 1,
        sheenRoughness: 0.32,
        sheenColor: c.clone().lerp(new THREE.Color(0xffffff), 0.45),
        side: THREE.DoubleSide,
      }),
    );
  }
  return ribbonMats.get(hex);
}

export const RIBBON_W = 0.46;

/**
 * A ribbon: a strip three vertices wide along a path, its end cut in a V. update(points, sides) takes the path's
 * centre points and, at each, the direction across the ribbon (unit vectors).
 */
export class Ribbon {
  constructor(hex, n = 24) {
    this.n = n;
    const rows = n + 1;
    this.pos = new Float32Array(rows * 3 * 3);
    const uv = new Float32Array(rows * 3 * 2);
    const idx = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j;
        const b = a + 1;
        const c = a + 3;
        const e = c + 1;
        idx.push(a, c, b, b, c, e);
      }
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(rows * 3 * 3), 3));
    g.setIndex(idx);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, ribbonMaterial(hex));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.points = [];
  }

  setColor(hex) {
    this.mesh.material = ribbonMaterial(hex);
  }

  /** points: n+1 Vector3 along the ribbon (start … end); sides: unit vectors across it; width in world units. */
  update(points, sides, width = RIBBON_W) {
    const n = this.n;
    const P = this.pos;
    const h = width / 2;
    const notch = width * 0.55;
    this.points = points;
    for (let i = 0; i <= n; i++) {
      const c = points[i];
      const s = sides[i];
      let cx = c.x;
      let cy = c.y;
      let cz = c.z;
      if (i === n) {
        // the V cut: the middle falls back along the ribbon
        const p = points[n - 1];
        const l = c.distanceTo(p) || 1;
        cx -= ((c.x - p.x) / l) * notch;
        cy -= ((c.y - p.y) / l) * notch;
        cz -= ((c.z - p.z) / l) * notch;
      }
      const o = i * 9;
      P[o] = c.x - s.x * h;
      P[o + 1] = c.y - s.y * h;
      P[o + 2] = c.z - s.z * h;
      P[o + 3] = cx;
      P[o + 4] = cy;
      P[o + 5] = cz;
      P[o + 6] = c.x + s.x * h;
      P[o + 7] = c.y + s.y * h;
      P[o + 8] = c.z + s.z * h;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** Where a shut book's ribbon leaves it (book frame): under the tail of the text block, near the spine. */
export function shelfRibbonExit(d, s, out) {
  const zr = THREE.MathUtils.clamp((d.tp * (d.leaves - s)) / d.leaves, 0.18, d.tp - 0.18);
  return out.set(0.7, -d.Hc / 2, zr);
}

/**
 * A ribbon on the shelf (world): from under its book (E, world) across the plank toward you and over its front
 * edge, hanging a little. y: the plank's top; front: its front edge's z; drop: how far it hangs (0: no plank —
 * it lies on the line and stops short). `sway`: ±1, which way it drifts.
 */
export function layShelfRibbon(r, E, y, front, drop, sway = 1) {
  const n = r.n;
  const pts = [];
  const sides = [];
  const X = new THREE.Vector3(1, 0, 0);
  const flat = drop > 0 ? n - 6 : n;
  const zEnd = drop > 0 ? front - 0.1 : front - 0.4;
  const yy = y + 0.012;
  const z0 = Math.min(E.z, zEnd - 0.2);
  for (let i = 0; i <= flat; i++) {
    const t = i / flat;
    pts.push(new THREE.Vector3(E.x + sway * 0.22 * Math.sin(t * 2.6), yy, z0 + (zEnd - z0) * t));
  }
  if (drop > 0) {
    const x = pts[pts.length - 1].x;
    pts.push(new THREE.Vector3(x, yy - 0.035, front + 0.035));
    pts.push(new THREE.Vector3(x, yy - 0.15, front + 0.07));
    for (let i = 1; i <= 4; i++) pts.push(new THREE.Vector3(x + sway * 0.03 * i, yy - 0.15 - ((drop - 0.15) * i) / 4, front + 0.075));
  }
  for (let i = 0; i <= n; i++) sides.push(X);
  r.update(pts, sides, RIBBON_W * 0.9);
}

/** Height of a stack's layer `frac` (0 bottom … 1 top) at distance x from the gutter, and its slope there. */
export function layerAt(h, o, Wp, frac, x) {
  const prof = stackProfile(h, o, Wp);
  const z = frac * prof(x);
  const dz = (frac * (prof(x + 0.05) - prof(Math.max(0, x - 0.05)))) / (x > 0.05 ? 0.1 : 0.05 + x);
  return { z, dz };
}
