// The shelf: one row of books, spines to camera, the selected book turned face-out and pulled forward.

import * as THREE from 'three';
import { BookModel, bookDims, makeBookMaterials, SHELF_SCALE } from './book3d.js';
import {
  canvasTexture,
  makeClothCoverCanvas,
  makeImageCoverCanvas,
  makeSpineCanvas,
} from './textures.js';
import { clamp, smoothDamp, smoothstep } from './anim.js';
import * as store from './store.js';

export const SHELF_Z = -36; // spine plane
const FACE_PULL = 5; // face-out book comes forward this much
const SPINE_GAP = 0.36;
const FACE_GAP = 0.7;
const S = SHELF_SCALE;

export class Shelf {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'shelf';
    app.scene.add(this.group);
    this.entries = [];
    this.p = 0; // continuous position (book index at centre)
    this.pTarget = 0;
    this.pv = { v: 0 };
    this.dragging = false;
    this.gliding = false;
    this.wheelTimer = 0;
    this.lastStep = 0;
    this.openGap = 0; // 0..1 how far the neighbours are pushed apart for an open book
    this.openGapWidth = 0; // world units each side
    this.hiddenEntry = null;
    this.selected = -1;
    this.onSelect = null;
    this.ghosts = [];
    this.raycaster = new THREE.Raycaster();
  }

  // ------------------------------------------------------------------ building
  async setBooks(metas, selectId) {
    for (const e of this.entries) this.disposeEntry(e);
    this.entries = [];
    this.clearGhosts();
    for (const meta of metas) this.entries.push(this.buildEntry(meta));
    let idx = Math.max(0, this.entries.findIndex((e) => e.meta.id === selectId));
    if (!this.entries.length) {
      this.buildGhosts();
      idx = 0;
    }
    this.p = this.pTarget = idx;
    this.selected = -1;
    // settle yaws immediately
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      e.yaw = i === idx ? 0 : Math.PI / 2;
    }
    this.update(0, true);
  }

  buildEntry(meta) {
    const app = this.app;
    const d = bookDims(meta.pages, meta.aspect);
    const look = meta.look;
    const arc = d.T + 0.35;
    const spineCanvas = makeSpineCanvas(meta, look, arc, d.Hc);
    const tex = {
      cover: app.shared.blankCover,
      spine: canvasTexture(spineCanvas, { aniso: app.maxAniso }),
      endpaper: app.shared.endpaper,
      coverWeave: app.shared.weaveCover,
      spineWeave: app.shared.weaveSpine,
    };
    const mats = makeBookMaterials(look, tex, app.shared);
    mats.cover.color = new THREE.Color(look.cloth); // until the real cover texture exists
    mats.cover.map = null;
    const model = new BookModel(d, mats, { withLeftStack: false });
    model.set(Math.PI, 0, 0);
    const slot = new THREE.Group();
    slot.scale.setScalar(S);
    model.group.position.copy(d.center).multiplyScalar(-1);
    slot.add(model.group);
    this.group.add(slot);
    const e = { meta, d, look, tex, mats, model, slot, yaw: Math.PI / 2, yawV: { v: 0 }, coverState: 'none', x: 0, z: SHELF_Z };
    for (const m of model.pickables()) m.userData.entry = e;
    return e;
  }

  buildGhosts() {
    // A quiet row of blank volumes for an empty library.
    const metas = [];
    for (let i = 0; i < 9; i++) {
      metas.push({ pages: 160 + ((i * 97) % 300), aspect: 0.66 + (i % 3) * 0.03 });
    }
    for (let i = 0; i < metas.length; i++) {
      const d = bookDims(metas[i].pages, metas[i].aspect);
      const tone = [0xdcd9d1, 0xd5d1c8, 0xe0ddd5, 0xd2cec4][i % 4];
      const mat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.92 });
      const mats = { cover: mat, back: mat, cloth: mat, endpaper: mat, spine: mat, paper: mat, edge: mat };
      const model = new BookModel(d, mats, { withLeftStack: false });
      model.set(Math.PI, 0, 0);
      const slot = new THREE.Group();
      slot.scale.setScalar(S);
      model.group.position.copy(d.center).multiplyScalar(-1);
      slot.add(model.group);
      slot.rotation.y = Math.PI / 2;
      this.group.add(slot);
      this.ghosts.push({ slot, model, d, mat });
    }
    let x = 0;
    const widths = this.ghosts.map((g) => g.d.T * S + SPINE_GAP);
    const total = widths.reduce((a, b) => a + b, 0);
    x = -total / 2;
    this.ghosts.forEach((g, i) => {
      g.slot.position.set(x + widths[i] / 2, 0, SHELF_Z - (g.d.closedW * S) / 2);
      x += widths[i];
    });
  }

  clearGhosts() {
    for (const g of this.ghosts) {
      this.group.remove(g.slot);
      g.model.dispose();
      g.mat.dispose();
    }
    this.ghosts = [];
  }

  disposeEntry(e) {
    this.group.remove(e.slot);
    e.model.dispose();
    for (const k of ['cover', 'back', 'cloth', 'spine']) e.mats[k].dispose();
    e.tex.spine.dispose();
    if (e.coverTex) e.coverTex.dispose();
  }

  /** Re-render the generated textures of one book (after title/look edits). */
  refreshEntry(meta) {
    const i = this.entries.findIndex((e) => e.meta.id === meta.id);
    if (i < 0) return;
    const e = this.entries[i];
    e.meta = meta;
    e.look = meta.look;
    const spineCanvas = makeSpineCanvas(meta, meta.look, e.d.T + 0.35, e.d.Hc);
    e.tex.spine.dispose();
    e.tex.spine = canvasTexture(spineCanvas, { aniso: this.app.maxAniso });
    e.mats.spine.map = e.tex.spine;
    e.mats.spine.needsUpdate = true;
    const cloth = new THREE.Color(meta.look.cloth);
    e.mats.back.color.copy(cloth);
    e.mats.cloth.color.copy(cloth).multiplyScalar(0.86);
    this.releaseCover(e);
    this.ensureCover(e);
  }

  // ------------------------------------------------------------------ covers (lazy)
  ensureCover(e) {
    if (e.coverState !== 'none') return;
    e.coverState = 'loading';
    const finish = (canvas) => {
      if (e.coverState !== 'loading') return;
      e.coverTex = canvasTexture(canvas, { aniso: this.app.maxAniso });
      e.mats.cover.map = e.coverTex;
      e.mats.cover.color.set(0xffffff);
      e.mats.cover.needsUpdate = true;
      e.coverState = 'ready';
      this.app.invalidate();
    };
    const boardAspect = e.d.Wc / e.d.Hc;
    if (e.look.coverMode === 'image') {
      store
        .getCover(e.meta.id)
        .then((blob) => (blob ? createImageBitmap(blob) : null))
        .then((img) => {
          if (img) {
            finish(makeImageCoverCanvas(img, boardAspect));
            img.close && img.close();
          } else finish(makeClothCoverCanvas(e.meta, e.look, boardAspect));
        })
        .catch(() => finish(makeClothCoverCanvas(e.meta, e.look, boardAspect)));
    } else {
      finish(makeClothCoverCanvas(e.meta, e.look, boardAspect));
    }
  }

  releaseCover(e) {
    if (e.coverTex) e.coverTex.dispose();
    e.coverTex = null;
    e.mats.cover.map = null;
    e.mats.cover.color.set(e.look.cloth);
    e.mats.cover.needsUpdate = true;
    e.coverState = 'none';
  }

  // ------------------------------------------------------------------ navigation
  get count() {
    return this.entries.length;
  }

  select(i, { instant = false } = {}) {
    if (!this.entries.length) return;
    i = clamp(Math.round(i), 0, this.entries.length - 1);
    this.pTarget = i;
    this.gliding = true;
    if (instant) {
      this.p = i;
      this.pv.v = 0;
    }
    this.app.invalidate();
  }

  step(dir) {
    const t = performance.now();
    if (t - this.lastStep < 150) return;
    this.lastStep = t;
    this.select(Math.round(this.pTarget) + dir);
  }

  wheel(delta) {
    if (!this.entries.length) return;
    this.gliding = false;
    this.pTarget = clamp(this.pTarget + delta * 0.0042, -0.35, this.entries.length - 1 + 0.35);
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.select(Math.round(this.pTarget));
    }, 140);
    this.app.invalidate();
  }

  dragStart() {
    this.dragging = true;
    this.dragP0 = this.pTarget;
    this.gliding = false;
  }

  dragMove(dxPx) {
    if (!this.dragging) return;
    const worldPerPx = this.app.worldPerPx(SHELF_Z);
    const pitch = 3.06; // world units per spine
    this.pTarget = clamp(this.dragP0 - (dxPx * worldPerPx) / pitch, -0.45, this.entries.length - 1 + 0.45);
    this.app.invalidate();
  }

  dragEnd(vxPx) {
    if (!this.dragging) return;
    this.dragging = false;
    const worldPerPx = this.app.worldPerPx(SHELF_Z);
    const fling = (-vxPx * worldPerPx) / 3.06; // books per second
    this.select(Math.round(this.pTarget + fling * 0.22));
  }

  // ------------------------------------------------------------------ frame
  update(dt, force = false) {
    const n = this.entries.length;
    if (!n) return false;
    let moving = force;
    const before = this.p;
    if (dt > 0) this.p = smoothDamp(this.p, this.pTarget, this.pv, this.dragging ? 0.06 : this.gliding ? 0.22 : 0.12, dt);
    if (Math.abs(this.p - before) > 1e-5) moving = true;
    if (Math.abs(this.p - this.pTarget) < 0.0005 && Math.abs(this.pv.v) < 0.001) {
      this.p = this.pTarget;
      this.gliding = false;
    }
    const pc = clamp(this.p, 0, n - 1);

    // selection follows the nearest book
    const sel = clamp(Math.round(pc), 0, n - 1);
    if (sel !== this.selected) {
      this.selected = sel;
      this.onSelect && this.onSelect(this.entries[sel], sel);
    }

    // yaws: face-out amount from distance to the continuous position
    const smoothT = this.gliding ? 0.36 : this.dragging ? 0.12 : 0.2;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      const f = smoothstep(0, 1, clamp(1 - Math.abs(i - pc), 0, 1));
      const target = (Math.PI / 2) * (1 - f);
      const prev = e.yaw;
      e.yaw = dt > 0 ? smoothDamp(e.yaw, target, e.yawV, smoothT, dt) : target;
      if (Math.abs(e.yaw - prev) > 1e-5) moving = true;
      // lazily hold covers for books near the centre
      const dist = Math.abs(i - pc);
      if (dist < 4.5) this.ensureCover(e);
      else if (dist > 8 && e.coverState === 'ready') this.releaseCover(e);
    }

    // footprints
    let x = 0;
    const centers = new Array(n);
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      const c = Math.cos(e.yaw);
      const s = Math.sin(e.yaw);
      const face = c; // 1 when face-out
      const w = (Math.abs(c) * e.d.closedW + Math.abs(s) * e.d.T) * S + SPINE_GAP + (FACE_GAP - SPINE_GAP) * face;
      centers[i] = x + w / 2;
      x += w;
      e.footprint = w;
    }
    const i0 = Math.floor(pc);
    const i1 = Math.min(n - 1, i0 + 1);
    const fr = pc - i0;
    const cx = centers[i0] + (centers[i1] - centers[i0]) * fr;
    const gap = this.openGapWidth * this.openGap;
    for (let i = 0; i < n; i++) {
      const e = this.entries[i];
      let xi = centers[i] - cx;
      if (gap > 0 && i !== sel) xi += i < sel ? -gap : gap;
      const face = Math.cos(e.yaw);
      // the front-most face of every book sits on the shelf line (spines, or the cover when face-out);
      // the slot pivots at the book's centre, so step back by the rotated half-depth
      const halfDepth = (Math.abs(Math.sin(e.yaw)) * e.d.closedW + Math.abs(face) * e.d.T) * 0.5 * S;
      e.x = xi;
      e.z = SHELF_Z + FACE_PULL * Math.max(0, face) - halfDepth;
      e.slot.position.set(xi, 0, e.z);
      e.slot.rotation.y = e.yaw;
      e.slot.visible = e !== this.hiddenEntry;
    }
    return moving || this.dragging;
  }

  // ------------------------------------------------------------------ picking
  pick(ndc) {
    if (!this.entries.length) return null;
    this.raycaster.setFromCamera(ndc, this.app.camera);
    const objs = [];
    for (const e of this.entries) if (e.slot.visible) objs.push(...e.model.pickables());
    const hit = this.raycaster.intersectObjects(objs, false)[0];
    return hit ? { entry: hit.object.userData.entry, object: hit.object, point: hit.point } : null;
  }

  /** Screen-space rectangle of the selected book's front cover. */
  coverRect(e) {
    if (!e) return null;
    const d = e.d;
    const pts = [];
    const v = new THREE.Vector3();
    for (const sx of [d.jb, d.jb + d.Wc])
      for (const sy of [-d.Hc / 2, d.Hc / 2]) {
        v.set(sx, sy, d.tp + d.bt);
        e.model.group.localToWorld(v);
        v.project(this.app.camera);
        pts.push(v.clone());
      }
    const W = this.app.width;
    const H = this.app.height;
    const xs = pts.map((p) => (p.x * 0.5 + 0.5) * W);
    const ys = pts.map((p) => (-p.y * 0.5 + 0.5) * H);
    return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
  }

  entryIndex(e) {
    return this.entries.indexOf(e);
  }
}
