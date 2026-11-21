// Folio — app bootstrap: renderer, scene, lights, camera framing, input routing, library state.

import * as THREE from 'three';
import { Shelf, SHELF_Z } from './shelf.js';
import { Reader } from './reader.js';
import { Candle, CANDLE_DIM } from './candle.js';
import { setPaperRoomLight } from './leaf.js';
import { setBindingRoomLight, setDefaultBinding } from './binding.js';
import { restyleBookMaterials } from './book3d.js';
import { UI } from './ui.js';
import { Magnifier } from './magnifier.js';
import * as store from './store.js';
import { importFiles, exportAnnotated } from './library.js';
import {
  makeGrainTexture,
  makeDeferredPaperTextures,
  makePageEdgeTexture,
  luminance,
} from './textures.js';
import { clamp, lerp } from './anim.js';

const DEG = Math.PI / 180;
const FOV = 18;
const SORTS = [
  { key: 'added', label: 'FULL LIBRARY · ADDED' },
  { key: 'title', label: 'FULL LIBRARY · TITLE' },
  { key: 'author', label: 'FULL LIBRARY · AUTHOR' },
  { key: 'recent', label: 'FULL LIBRARY · RECENT' },
];
const THEMES = ['light', 'dark', 'color'];

function pref(key, fallback) {
  try {
    const v = localStorage.getItem('folio.' + key);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function setPref(key, value) {
  try {
    localStorage.setItem('folio.' + key, value);
  } catch {}
}

class App {
  constructor() {
    this.canvas = document.getElementById('stage');
    this.isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
    this.penSeen = false;
    this.metas = [];
    this.sort = pref('sort', 'added');
    this.theme = pref('theme', 'light');
    this.dirty = 3;
    this.lastT = performance.now() / 1000;
    this.pending = null;
    this.clock = 0; // app time in seconds (scaled), drives every animation
    this.timeScale = 1; // debugging: < 1 for slow motion
    this.tapMs = 450; // longest press that still counts as a tap
  }

  async init() {
    // canvas text needs the faces loaded before any spine / cover is drawn
    await Promise.all([
      document.fonts.load('400 40px "Instrument Serif"'),
      document.fonts.load('italic 400 40px "Instrument Serif"'),
      document.fonts.load('400 20px "IBM Plex Mono"'),
      document.fonts.load('500 20px "Inter"'),
    ]).catch(() => {});

    this.initRenderer();
    this.initScene();
    this.ui = new UI(this);
    this.shelf = new Shelf(this);
    this.reader = new Reader(this);
    this.candle = new Candle(this);
    this.candle.onDone = (info) => this.onSittingDone(info);
    this.glowEl = document.getElementById('candle-glow');
    this.dimEl = document.getElementById('candle-dim');
    this.magnifier = new Magnifier();
    this.shelf.onSelect = (e) => this.onSelect(e);
    this.ui.setTheme(this.theme, null);
    this.ui.setSortLabel(SORTS.find((s) => s.key === this.sort)?.label || SORTS[0].label);
    this.resize();
    this.bindInput();
    await this.loadLibrary();
    store.persist();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ================================================================= renderer & scene
  initRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.setClearColor(0x000000, 0);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.VSMShadowMap;
    r.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = r;
    this.maxAniso = Math.min(8, r.capabilities.getMaxAnisotropy());
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.ui && this.ui.toast('Graphics were reset — reload if the shelf looks empty');
    });
  }

  initScene() {
    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1200);
    this.cameraBase = new THREE.Vector3(0, 0, 54);

    this.ambient = new THREE.AmbientLight(0xf1f3f9, 1.15); // a touch cool, like daylight from the room
    scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xfffaf4, 2.1);
    key.castShadow = true;
    // VSM: soft blurred silhouettes like the reference; 1024² keeps the blur pass cheap on tablets
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 8;
    key.shadow.blurSamples = 12;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    this.key = key;
    this.keyDir = new THREE.Vector3(-0.09, 0.2, 1).normalize();
    scene.add(key);
    scene.add(key.target);
    const fill = new THREE.DirectionalLight(0xe9eefc, 0.55);
    this.fill = fill;
    // the room's own light levels; a burning candle dims them
    this.lightBase = { ambient: 1.15, key: 2.1, fill: 0.55 };
    fill.position.set(40, 8, 30);
    scene.add(fill);

    // the wall behind the books only shows shadows
    this.shadowMat = new THREE.ShadowMaterial({ color: 0x0a0a12, opacity: 0.3 });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(900, 600), this.shadowMat);
    wall.position.z = -54.5;
    wall.receiveShadow = true;
    scene.add(wall);
    this.wall = wall;

    // shared textures / materials
    const edge = makePageEdgeTexture();
    const grain = makeGrainTexture();
    const paper = makeDeferredPaperTextures();
    setTimeout(() => paper.fill(), 1500);
    paper.repeat = new THREE.Vector2(6, 9);
    this.shared = {
      grain,
      paper,
      edgeMat: new THREE.MeshLambertMaterial({ map: edge, color: 0xffffff }),
      paperMat: new THREE.MeshLambertMaterial({ color: 0xedece7 }),
    };
    // stack edges should never z-fight with the leaves resting on them
    this.shared.paperMat.polygonOffset = true;
    this.shared.paperMat.polygonOffsetFactor = 2;
    this.shared.paperMat.polygonOffsetUnits = 2;
  }

  get width() {
    return this.w || window.innerWidth;
  }
  get height() {
    return this.h || window.innerHeight;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // framing: books ≈ 64 % of the height, but always show a few volumes either side
    const tanH = Math.tan((FOV * DEG) / 2);
    const bookH = 24.3 * 0.8;
    const aspect = w / h;
    const dH = bookH / (0.64 * 2 * tanH);
    const minW = aspect < 0.8 ? 27 : 34;
    const dW = minW / (2 * tanH * aspect);
    const dist = Math.max(dH, dW);
    const centerPx = h * 0.515;
    const yOff = ((centerPx - h / 2) / h) * 2 * tanH * dist;
    this.cameraBase.set(0, yOff, SHELF_Z + dist);
    this.camera.position.copy(this.cameraBase);
    this.camera.updateProjectionMatrix();
    // shadow camera covers what is visible on the wall
    const wallDist = this.cameraBase.z + 54.5;
    const visH = 2 * tanH * wallDist;
    const visW = visH * aspect;
    const sc = this.key.shadow.camera;
    const half = Math.max(visW, visH) / 2 + 8;
    sc.left = -half;
    sc.right = half;
    sc.top = half;
    sc.bottom = -half;
    sc.near = 1;
    sc.far = 260;
    sc.updateProjectionMatrix();
    this.key.target.position.set(0, yOff, -45);
    this.key.position.copy(this.key.target.position).addScaledVector(this.keyDir, 120);
    this.magnifier && this.magnifier.setSize(w, h, this.renderer.getPixelRatio(), this.renderer.capabilities.maxTextureSize);
    if (this.ui) this.ui.measureTitles();
    if (this.reader) this.reader.resize();
    this.invalidate();
  }

  worldPerPx(z) {
    const dist = this.cameraBase.z - z;
    return (2 * Math.tan((FOV * DEG) / 2) * dist) / this.height;
  }

  invalidate() {
    this.dirty = Math.max(this.dirty, 2);
  }

  // ================================================================= library
  async loadLibrary(selectId) {
    this.metas = await store.listBooks();
    const sorted = this.sortedMetas();
    if (!selectId) {
      const recent = [...this.metas].sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0];
      selectId = recent ? recent.id : null;
    }
    await this.shelf.setBooks(sorted, selectId);
    this.ui.setTitles(sorted);
    this.ui.setCount(sorted.length);
    if (!sorted.length) this.ui.setNow(null);
    this.invalidate();
  }

  sortedMetas() {
    const m = [...this.metas];
    const by = (f) => (a, b) => f(a).localeCompare(f(b), undefined, { sensitivity: 'base', numeric: true });
    switch (this.sort) {
      case 'title':
        m.sort(by((x) => x.title.replace(/^(the|a|an)\s+/i, '')));
        break;
      case 'author':
        m.sort(by((x) => (x.author || '~') + x.title));
        break;
      case 'recent':
        m.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0) || b.addedAt - a.addedAt);
        break;
      default:
        m.sort((a, b) => a.addedAt - b.addedAt);
    }
    return m;
  }

  currentMeta() {
    if (this.reader.isOpen) return this.reader.meta;
    const e = this.shelf.entries[this.shelf.selected];
    return e ? e.meta : null;
  }

  onSelect(entry) {
    this.ui.setNow(entry.meta);
    if (this.theme === 'color') this.ui.setTheme('color', entry.look);
    this.ui.hidePills();
    this.hoverPills = false;
  }

  async cycleSort() {
    const i = SORTS.findIndex((s) => s.key === this.sort);
    const next = SORTS[(i + 1) % SORTS.length];
    this.sort = next.key;
    setPref('sort', this.sort);
    this.ui.setSortLabel(next.label);
    if (this.reader.isOpen) {
      this.libraryDirty = true;
      return;
    }
    const cur = this.currentMeta();
    await this.loadLibrary(cur && cur.id);
  }

  cycleTheme() {
    const i = THEMES.indexOf(this.theme);
    this.theme = THEMES[(i + 1) % THEMES.length];
    setPref('theme', this.theme);
    const e = this.shelf.entries[this.shelf.selected];
    this.ui.setTheme(this.theme, this.reader.isOpen ? this.reader.entry.look : e && e.look);
    this.shadowMat.opacity = this.theme === 'light' ? 0.3 : this.theme === 'dark' ? 0.7 : 0.5;
    this.lightBase.ambient = this.theme === 'dark' ? 1.0 : 1.15;
    this.invalidate();
  }

  selectBook(id) {
    if (this.reader.isOpen) return;
    const i = this.shelf.entries.findIndex((e) => e.meta.id === id);
    if (i >= 0) this.shelf.select(i);
  }

  openSelected() {
    if (this.reader.isOpen || !this.shelf.entries.length) return;
    const e = this.shelf.entries[this.shelf.selected];
    if (!e) return;
    this.ui.closePanel();
    if (Math.abs(this.shelf.p - this.shelf.selected) > 0.02 || Math.abs(e.yaw) > 0.05) {
      // let the book finish turning face-out first
      this.pending = { id: e.meta.id };
      this.shelf.select(this.shelf.selected);
      return;
    }
    this.reader.open(e);
  }

  openBookById(id, page) {
    const meta = this.metas.find((m) => m.id === id);
    if (!meta) return;
    if (this.reader.isOpen) {
      if (this.reader.meta.id === id) {
        if (page) this.reader.goToPage(page);
        return;
      }
      this.pending = { id, page };
      this.reader.close();
      return;
    }
    if (page) meta.spread = clamp(Math.floor(page / 2), 0, Math.ceil(meta.pages / 2));
    this.pending = { id };
    this.selectBook(id);
  }

  async onReaderClosed(entry) {
    if (this.magnifier.enabled) this.toggleMagnifier();
    if (this.theme === 'color') this.ui.setTheme('color', this.shelf.entries[this.shelf.selected]?.look);
    if (this.pending && this.pending.remove) {
      const meta = this.pending.remove;
      this.pending = null;
      this.removeBook(meta);
      return;
    }
    if (this.libraryDirty) {
      // books were added or the order changed while reading
      this.libraryDirty = false;
      await this.loadLibrary(entry && entry.meta.id);
    }
    if (this.pending && this.pending.id) {
      const { id, page } = this.pending;
      this.pending = null;
      this.openBookById(id, page);
    }
  }

  async updateMeta(meta, { retexture = false } = {}) {
    await store.putBook(meta);
    if (retexture) {
      this.shelf.refreshEntry(meta);
      this.ui.setTitles(this.shelf.entries.map((e) => e.meta));
      this.ui.setNow(meta);
    }
    this.invalidate();
  }

  setLook(meta, patch) {
    const look = { ...meta.look, ...patch };
    if (patch.cloth) {
      const dark = luminance(look.cloth) < 0.3;
      look.ink = dark ? '#efebe2' : '#1f1d1a';
      if (dark && luminance(look.accent) < 0.3) look.accent = '#d9ab5f';
      if (!dark && luminance(look.accent) > 0.4) look.accent = '#1d1b19';
    }
    meta.look = look;
    const e = this.shelf.entries.find((x) => x.meta.id === meta.id);
    if (e) e.look = look;
    this.updateMeta(meta, { retexture: true });
    if (this.theme === 'color') this.ui.setTheme('color', look);
  }

  /** Bind every book in cloth or leather, and new books too. */
  async setMaterialAll(kind) {
    setDefaultBinding(kind);
    for (const meta of this.metas) {
      if ((meta.look.material || 'cloth') === kind) continue;
      meta.look = { ...meta.look, material: kind };
      const e = this.shelf.entries.find((x) => x.meta.id === meta.id);
      if (e) {
        e.meta = meta;
        e.look = meta.look;
        restyleBookMaterials(e.mats, meta.look);
      }
      await store.putBook(meta);
    }
    this.invalidate();
  }

  async removeBook(meta) {
    if (this.reader.isOpen && this.reader.meta.id === meta.id) {
      this.pending = { remove: meta };
      this.reader.close();
      return;
    }
    await store.deleteBook(meta.id);
    const idx = this.shelf.selected;
    this.metas = this.metas.filter((m) => m.id !== meta.id);
    const sorted = this.sortedMetas();
    const next = sorted[Math.min(idx, sorted.length - 1)];
    await this.loadLibrary(next && next.id);
    this.ui.toast('Removed from the shelf');
  }

  async exportBook(meta) {
    try {
      this.ui.toast('Preparing the PDF…', 6000);
      const { blob, name, count } = await exportAnnotated(meta);
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare && this.isTouch && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: meta.title }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
      }
      this.ui.toast(count ? `Exported with ${count} mark${count === 1 ? '' : 's'}` : 'Exported (no marks yet)');
    } catch (err) {
      console.error(err);
      this.ui.toast('Export failed: ' + (err.message || err));
    }
  }

  pickFiles() {
    const input = document.getElementById('file-input');
    input.value = '';
    input.click();
  }

  async addFiles(files) {
    if (this.importing) return;
    this.importing = true;
    try {
      const res = await importFiles(files, this.metas, (i, n, name) =>
        this.ui.toast(n > 1 ? `Adding ${i + 1} of ${n} — ${name}` : `Adding ${name}`, 60000),
      );
      const parts = [];
      if (res.added.length) parts.push(`Added ${res.added.length}`);
      if (res.skipped.length) parts.push(`${res.skipped.length} skipped`);
      if (res.failed.length) parts.push(`${res.failed.length} could not be read`);
      this.ui.toast(parts.join(' · ') || 'Nothing added');
      if (res.added.length && !this.reader.isOpen) {
        this.metas = await store.listBooks();
        await this.loadLibrary(res.added[res.added.length - 1].id);
      } else if (res.added.length) {
        this.metas = await store.listBooks();
        this.libraryDirty = true;
      }
    } finally {
      this.importing = false;
    }
  }

  toggleMagnifier() {
    this.magnifier.enabled = !this.magnifier.enabled;
    if (this.magnifier.enabled) this.magnifier.point(this.width / 2, this.height / 2, this.width, this.height);
    this.ui.setMagnifier(this.magnifier.enabled);
    this.invalidate();
  }

  // ================================================================= input
  bindInput() {
    const c = this.canvas;
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    const input = document.getElementById('file-input');
    input.addEventListener('change', () => {
      if (input.files && input.files.length) this.addFiles([...input.files]);
    });

    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.lastT = performance.now() / 1000;
        this.invalidate();
      }
    });

    // drag & drop
    let dragDepth = 0;
    const drop = document.getElementById('drop');
    window.addEventListener('dragenter', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      dragDepth++;
      drop.hidden = false;
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) drop.hidden = true;
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      drop.hidden = true;
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) this.addFiles(files);
    });
  }

  ndc(x, y) {
    return new THREE.Vector2((x / this.width) * 2 - 1, -(y / this.height) * 2 + 1);
  }

  onPointerDown(e) {
    this.canvas.setPointerCapture?.(e.pointerId);
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    if (this.ui.panelMode && e.pointerType !== 'mouse') this.ui.closePanel();
    if (this.reader.isOpen) this.ui.closePopovers();
    if (this.magnifier.enabled && this.reader.isOpen && e.pointerType === 'touch' && !this.reader.tool) {
      this.lens = { id: e.pointerId };
      this.magnifier.point(e.clientX, e.clientY - 70, this.width, this.height);
      this.invalidate();
      return;
    }
    if (this.reader.isOpen) {
      this.reader.pointerDown(e);
      return;
    }
    this.shelfPointer = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, lx: e.clientX, lt: performance.now(), vx: 0, type: e.pointerType };
  }

  onPointerMove(e) {
    if (this.magnifier.enabled && this.reader.isOpen) {
      if (this.lens && this.lens.id === e.pointerId) {
        this.magnifier.point(e.clientX, e.clientY - 70, this.width, this.height);
        this.invalidate();
        return;
      }
      if (e.pointerType === 'mouse') {
        this.magnifier.point(e.clientX, e.clientY, this.width, this.height);
        this.invalidate();
      }
    }
    if (this.reader.isOpen) {
      this.reader.pointerMove(e);
      return;
    }
    const sp = this.shelfPointer;
    if (sp && sp.id === e.pointerId) {
      const dx = e.clientX - sp.x0;
      const now = performance.now();
      const dt = Math.max(1, now - sp.lt);
      sp.vx = sp.vx * 0.5 + (((e.clientX - sp.lx) / dt) * 1000) * 0.5;
      sp.lx = e.clientX;
      sp.lt = now;
      if (!sp.moved && Math.abs(dx) > 6) {
        sp.moved = true;
        this.shelf.dragStart();
        this.ui.hidePills();
      }
      if (sp.moved) this.shelf.dragMove(dx);
      return;
    }
    if (e.pointerType === 'mouse' && !e.buttons) this.shelfHover(e.clientX, e.clientY);
  }

  onPointerUp(e) {
    if (this.lens && this.lens.id === e.pointerId) {
      this.lens = null;
      return;
    }
    if (this.reader.isOpen) {
      this.reader.pointerUp(e);
      return;
    }
    const sp = this.shelfPointer;
    if (!sp || sp.id !== e.pointerId) return;
    this.shelfPointer = null;
    if (sp.moved) {
      this.shelf.dragEnd(performance.now() - sp.lt > 80 ? 0 : sp.vx);
      return;
    }
    if (e.type === 'pointercancel') return;
    // tap / click on the shelf
    const hit = this.shelf.pick(this.ndc(e.clientX, e.clientY));
    if (!hit) {
      this.ui.hidePills();
      return;
    }
    const i = this.shelf.entryIndex(hit.entry);
    if (i === this.shelf.selected && Math.abs(hit.entry.yaw) < 0.3) {
      if (sp.type === 'mouse') this.openSelected();
      else if (this.ui.pillsVisible()) this.ui.hidePills();
      else this.showPillsFor(hit.entry);
    } else {
      this.shelf.select(i);
    }
  }

  shelfHover(x, y) {
    const hit = this.shelf.pick(this.ndc(x, y));
    this.canvas.style.cursor = hit ? 'pointer' : 'default';
    const sel = this.shelf.entries[this.shelf.selected];
    const over = hit && hit.entry === sel && Math.abs(sel.yaw) < 0.2;
    if (over && !this.hoverPills) this.showPillsFor(sel);
    else if (!over && this.hoverPills) {
      this.ui.hidePills();
      this.hoverPills = false;
    }
  }

  showPillsFor(entry) {
    const r = this.shelf.coverRect(entry);
    if (!r) return;
    this.ui.showPills((r.left + r.right) / 2, (r.top + r.bottom) / 2);
    this.hoverPills = true;
  }

  onWheel(e) {
    e.preventDefault();
    if (this.reader.isOpen) {
      this.reader.wheel(e);
      return;
    }
    this.ui.hidePills();
    this.hoverPills = false;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    this.shelf.wheel(e.deltaMode === 1 ? d * 30 : d);
  }

  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape' && !document.getElementById('goto').hidden) {
      this.ui.toggleGoto(false);
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('candle-pop').hidden) {
      this.ui.toggleCandlePop(false);
      return;
    }
    if (e.key === 'Escape' && !document.getElementById('ink-pop').hidden) {
      this.ui.toggleInkPop(false);
      return;
    }
    if (e.key === 'Escape' && this.ui.panelMode) {
      this.ui.closePanel();
      return;
    }
    if (this.reader.isOpen) {
      if (e.key === 'm') {
        this.toggleMagnifier();
        e.preventDefault();
        return;
      }
      if (e.key === 'c') {
        this.ui.toggleCandlePop();
        e.preventDefault();
        return;
      }
      if (this.reader.key(e)) e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowRight':
        this.shelf.step(1);
        e.preventDefault();
        break;
      case 'ArrowLeft':
        this.shelf.step(-1);
        e.preventDefault();
        break;
      case 'Enter':
      case ' ':
        this.openSelected();
        e.preventDefault();
        break;
      case 'd':
        this.ui.openDetails(this.currentMeta());
        break;
      case 'i':
        this.ui.openIndex();
        break;
      case 'o':
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          this.pickFiles();
        }
        break;
    }
  }

  /** The room dims while the candle burns, and its light pools on the wall behind the book. */
  applyCandleLight() {
    const c = this.candle;
    const dim = c.dim;
    const b = this.lightBase;
    this.ambient.intensity = b.ambient * lerp(1, CANDLE_DIM.ambient, dim);
    this.key.intensity = b.key * lerp(1, CANDLE_DIM.key, dim);
    this.fill.intensity = b.fill * lerp(1, CANDLE_DIM.fill, dim);
    setPaperRoomLight(this.shared.paper, lerp(1, CANDLE_DIM.key, dim));
    setBindingRoomLight(lerp(1, CANDLE_DIM.ambient, dim));
    this.dimEl.style.opacity = (dim * (this.theme === 'dark' ? 0.25 : 1)).toFixed(3);
    if (c.group.visible && c.size > 0.01) {
      const p = c.screenFlame(this.camera, this.width, this.height);
      const a = clamp(c.size, 0, 1) * c.flick * (this.theme === 'dark' ? 0.5 : 0.42);
      const st = this.glowEl.style;
      st.setProperty('--gx', `${p.x.toFixed(1)}px`);
      st.setProperty('--gy', `${p.y.toFixed(1)}px`);
      st.opacity = a.toFixed(3);
    } else this.glowEl.style.opacity = '0';
  }

  /** Called when the candle goes out — burned down, put out, or the book was closed. */
  onSittingDone({ reason, minutes }) {
    const r = this.reader;
    const pages = r.isOpen && this.sittingStart != null ? Math.max(0, r.s - this.sittingStart) * 2 : this.sittingPages || 0;
    this.sittingStart = null;
    const pp = `${pages} page${pages === 1 ? '' : 's'}`;
    const mins = `${Math.max(1, minutes)} min`;
    if (reason === 'done') this.ui.toast(`The candle burned down · ${mins} · ${pp}`, 4200);
    else this.ui.toast(`Candle out · ${mins} · ${pp}`, 3000);
    this.ui.syncCandle(this.candle);
  }

  lightCandle(minutes) {
    if (!this.reader.isOpen) return;
    this.sittingStart = this.reader.s;
    this.candle.ignite(minutes);
    this.ui.syncCandle(this.candle);
  }

  /** Debug/testing: step the simulation by `sec` seconds without waiting for frames. */
  advance(sec, step = 1 / 60) {
    const n = Math.max(1, Math.round(sec / step));
    for (let i = 0; i < n; i++) {
      const dt = sec / n;
      this.clock += dt;
      this.shelf.update(dt);
      this.reader.update(dt, this.clock);
      this.candle.update(dt, this.camera);
      this.applyCandleLight();
    }
    this.invalidate();
  }

  // ================================================================= loop
  frame(tms) {
    requestAnimationFrame((t) => this.frame(t));
    if (document.hidden) return;
    const t = tms / 1000;
    const dt = Math.min(0.05, Math.max(0, t - this.lastT)) * this.timeScale;
    this.lastT = t;
    this.clock += dt;

    let busy = false;
    if (this.shelf.update(dt)) busy = true;
    if (this.reader.update(dt, this.clock)) busy = true;
    if (this.magnifier.enabled && this.magnifier.update(dt)) busy = true;
    const candleBusy = this.candle.update(dt, this.camera);
    this.applyCandleLight();
    if (this.candle.isBurning && t - (this.candleUiT || 0) > 0.5) {
      this.candleUiT = t;
      this.ui.syncCandle(this.candle);
    }

    // pending open once the shelf has settled
    if (this.pending && this.pending.id && !this.pending.page && !this.reader.isOpen) {
      const e = this.shelf.entries[this.shelf.selected];
      if (e && e.meta.id === this.pending.id && Math.abs(this.shelf.p - this.shelf.selected) < 0.02 && Math.abs(e.yaw) < 0.04) {
        this.pending = null;
        this.reader.open(e);
      }
    }

    // titles follow the shelf
    this.ui.updateTitles(this.shelf.p, this.shelf.selected);
    if (this.hoverPills && busy && !this.reader.isOpen) {
      const sel = this.shelf.entries[this.shelf.selected];
      if (sel) this.showPillsFor(sel);
    }

    // camera: zoom/pan while reading
    const cam = this.camera;
    const z = this.reader.isOpen ? this.reader.zoom : 1;
    const px = this.reader.isOpen ? this.reader.pan.x : 0;
    const py = this.reader.isOpen ? this.reader.pan.y : 0;
    if (cam.zoom !== z || cam.position.x !== this.cameraBase.x + px || cam.position.y !== this.cameraBase.y + py) {
      cam.zoom = z;
      cam.position.set(this.cameraBase.x + px, this.cameraBase.y + py, this.cameraBase.z);
      cam.updateProjectionMatrix();
      busy = true;
    }
    // softer shadows on the shelf, crisper ones under a turning leaf
    const wantRadius = this.reader.isOpen && this.reader.phase === 'reading' ? 3 : 8;
    if (this.key.shadow.radius !== wantRadius) {
      this.key.shadow.radius += (wantRadius - this.key.shadow.radius) * Math.min(1, dt * 4);
      if (Math.abs(this.key.shadow.radius - wantRadius) < 0.05) this.key.shadow.radius = wantRadius;
      busy = true;
    }

    if (busy) this.dirty = Math.max(this.dirty, 2);
    // a flame alone needs no more than 30 frames a second (kinder to the battery during a long sitting)
    if (candleBusy && !busy && this.dirty === 0 && t - (this.lastRenderT || 0) >= 1 / 31) this.dirty = 1;
    if (this.dirty > 0) {
      this.lastRenderT = t;
      this.dirty--;
      if (this.magnifier.enabled && this.reader.isOpen) this.magnifier.render(this.renderer, this.scene, cam);
      else this.renderer.render(this.scene, cam);
    }
  }
}

const app = new App();
window.folio = app;
app.init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<p style="position:fixed;left:16px;bottom:60px;font:12px monospace">Could not start: ${String(err.message || err)}</p>`);
});

// Offline support. Service workers need a secure context (https:// or localhost); add ?dev to the URL
// while editing the app so a cached copy never shadows your changes.
if ('serviceWorker' in navigator && window.isSecureContext && !new URLSearchParams(location.search).has('dev')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
