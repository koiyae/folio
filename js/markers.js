// Flags: a paper index flag sticks out of the head of the book for every spread you bookmarked (only those —
// highlights and pen notes get none). They show on the shelf and in the reader, each at its own place along the
// edge so they don't hide one another; tapping one twice goes to its page.

import * as THREE from 'three';
import { stackProfile } from './book3d.js';

export const FLAG = { W: 1.05, H: 1.5, STUCK: 0.62, T: 0.035, LIFT: 0.55 };
export const BOOKMARK_TONE = '#cf4a2d';
const PHI = 0.6180339887;

// ------------------------------------------------------------------ which flags a book has
/** Where along the head edge (0 gutter … 1 fore-edge) a leaf's flag sits: spread out, the same every time. */
const slot = (k, off) => 0.3 + 0.58 * ((((k + 1) * PHI + off) % 1 + 1) % 1);

/** The flags of a book, one per bookmarked spread: [{ key, kind, k (leaf), page, spread (to open), tone, front, u }]. */
export function flagsOf(meta) {
  const pages = meta.pages || 1;
  const leaves = Math.max(1, Math.ceil(pages / 2));
  const out = [];
  for (const s of meta.bookmarks || []) {
    if (!(s >= 0 && s <= leaves)) continue;
    const k = s < leaves ? s : leaves - 1;
    out.push({ key: 'b' + s, kind: 'bookmark', k, page: Math.max(1, Math.min(pages, 2 * s)), spread: s, tone: BOOKMARK_TONE, front: s < leaves, u: slot(k, 0.5) });
  }
  return out.sort((a, b) => a.k - b.k);
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

/** Height of a stack's layer `frac` (0 bottom … 1 top) at distance x from the gutter, and its slope there. */
export function layerAt(h, o, Wp, frac, x) {
  const prof = stackProfile(h, o, Wp);
  const z = frac * prof(x);
  const dz = (frac * (prof(x + 0.05) - prof(Math.max(0, x - 0.05)))) / (x > 0.05 ? 0.1 : 0.05 + x);
  return { z, dz };
}
