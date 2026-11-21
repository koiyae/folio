// Reading lights. One light at a time lights the reading: a candle, an oil lamp, a banker's lamp, a fire
// off to one side, a sunny window or a rainy one. Each is a finished scene (its colour, its movement, how far
// the room dims) with a few settings kept inside what that real source can do: warmth (or time of day),
// brightness, side, liveliness. Every light is also a sitting timer — the candle burns down, the oil runs low,
// the fire sinks to embers, the sun's patch crosses the book, the rain eases — or burns open-ended where that
// is true to the source (lamps, windows).
//
// The manager owns the sitting (start, add time, switch light mid-sitting, put out), mixes the room's own
// lights toward each source's mood, drives the CSS layers behind the 3D canvas (a dimmed room, a pool of
// warm light, a window's pattern on the wall, a lightning flash), and keeps the settings.

import * as THREE from 'three';
import { clamp, lerp } from './anim.js';

// ------------------------------------------------------------------ colour of light
// Hand-tuned linear colours for paper (black-body hues, desaturated the way a page under them reads).
const KELVIN = [
  [1500, [1.0, 0.46, 0.16]],
  [1900, [1.0, 0.62, 0.3]],
  [2200, [1.0, 0.68, 0.38]],
  [2700, [1.0, 0.76, 0.52]],
  [3200, [1.0, 0.82, 0.64]],
  [4000, [1.0, 0.89, 0.78]],
  [5000, [1.0, 0.95, 0.9]],
  [5600, [1.0, 0.98, 0.96]],
  [6500, [0.94, 0.97, 1.0]],
  [7500, [0.86, 0.92, 1.0]],
];
export function kelvinColor(k, out = new THREE.Color()) {
  if (k <= KELVIN[0][0]) return out.setRGB(...KELVIN[0][1]);
  for (let i = 1; i < KELVIN.length; i++) {
    const [k1, c1] = KELVIN[i];
    if (k <= k1) {
      const [k0, c0] = KELVIN[i - 1];
      const t = (k - k0) / (k1 - k0);
      return out.setRGB(lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t));
    }
  }
  return out.setRGB(...KELVIN[KELVIN.length - 1][1]);
}

// ------------------------------------------------------------------ noise
export function hash1(n) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}
export function noise1(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

// ------------------------------------------------------------------ the lights on offer
// settings: [min, max, default]. timer: true → also open-ended (∞). verbs for the readout and the toast.
export const LIGHTS = {
  candle: {
    label: 'Candle',
    note: 'A pillar candle beside the book. It burns down over the sitting and flickers when a page turns.',
    warmth: [1700, 2100, 1900],
    brightness: [0.6, 1.4, 1],
    liveliness: [0, 1.5, 1],
    side: 1,
    open: false,
    off: 'Put it out',
    ended: 'The candle burned down',
    out: 'Candle out',
  },
  oil: {
    label: 'Oil lamp',
    note: 'A glass oil lamp: a steadier, brighter flame behind its chimney. The oil level drops as you read.',
    warmth: [1800, 2300, 2050],
    brightness: [0.6, 1.4, 1],
    liveliness: [0, 1.5, 0.6],
    side: 1,
    open: false,
    off: 'Turn down the wick',
    ended: 'The lamp ran dry',
    out: 'Lamp out',
  },
  desk: {
    label: "Banker's lamp",
    note: 'A green glass shade throws a steady pool of warm light across the spread.',
    warmth: [2400, 3200, 2700],
    brightness: [0.45, 1.3, 1],
    liveliness: null,
    side: 1,
    open: true,
    off: 'Switch off',
    ended: 'The lamp switched off',
    out: 'Lamp off',
  },
  fire: {
    label: 'Fireside',
    note: 'A fire just out of view: big, slow, warm light from one side. It sinks to embers as you read.',
    warmth: [1700, 2300, 1950],
    brightness: [0.5, 1.4, 1],
    liveliness: [0, 1.5, 1],
    side: -1,
    open: false,
    off: 'Let it die',
    ended: 'The fire burned down to embers',
    out: 'Fire out',
  },
  sun: {
    label: 'Sunny window',
    note: 'Sun through a window, leaves moving in the breeze. With a timer the patch of sun crosses the book.',
    time: [7, 20, 16.5],
    brightness: [0.5, 1.3, 1],
    liveliness: [0, 1.5, 0.8],
    side: -1,
    open: true,
    off: 'Draw the curtain',
    ended: 'The sun moved on',
    out: 'Curtain drawn',
  },
  rain: {
    label: 'Rainy window',
    note: 'Soft grey daylight with rain running down the glass. With a timer, the rain eases off.',
    warmth: [5600, 7500, 6500],
    brightness: [0.5, 1.3, 1],
    liveliness: [0, 1.5, 0.8],
    side: -1,
    open: true,
    off: 'Draw the curtain',
    ended: 'The rain stopped',
    out: 'Curtain drawn',
  },
};

const LS_KEY = 'folio.light.v1';
function defaults() {
  const s = {};
  for (const [id, L] of Object.entries(LIGHTS)) {
    s[id] = { side: L.side };
    if (L.warmth) s[id].warmth = L.warmth[2];
    if (L.time) {
      s[id].time = L.time[2];
      s[id].clock = false;
    }
    s[id].brightness = L.brightness[2];
    if (L.liveliness) s[id].liveliness = L.liveliness[2];
  }
  return { choice: 'candle', settings: s };
}

// ------------------------------------------------------------------ base for the new lights
/**
 * Timeline shared by the lights: off → starting → on → ending → out → off. `level` follows it as the
 * light's own envelope (0…1); `dim` is how far the room has gone over to this light's mood.
 * Subclasses set startTime / endTime / outTime and implement step(dt, camera), place(L), applySettings(s);
 * they describe the room through `room` and may offer `glow(camera, w, h)` and `wall`.
 */
export class LightSource {
  constructor(app, id) {
    this.app = app;
    this.id = id;
    this.group = new THREE.Group();
    this.group.name = id;
    this.group.visible = false;
    app.scene.add(this.group);
    this.state = 'off';
    this.stateT = 0;
    this.duration = 0;
    this.elapsed = 0;
    this.level = 0;
    this.dim = 0;
    this.time = 0;
    this.startTime = 1.2;
    this.endTime = 3;
    this.outTime = 3;
    this.fps = 30;
    this.onDone = null;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.s = {};
  }
  get isBurning() {
    return this.state === 'starting' || this.state === 'on';
  }
  get active() {
    return this.state !== 'off';
  }
  get remaining() {
    return this.duration === Infinity ? Infinity : Math.max(0, this.duration - this.elapsed);
  }
  get progress() {
    return this.duration === Infinity || !this.duration ? 0 : clamp(this.elapsed / this.duration, 0, 1);
  }
  /** Liveliness after the system's "reduce motion". */
  get lively() {
    const l = this.s.liveliness ?? 1;
    return this.reduced ? Math.min(l, 0.3) : l;
  }

  start(seconds) {
    this.duration = seconds;
    this.elapsed = 0;
    this.state = 'starting';
    this.stateT = 0;
    this.group.visible = true;
    this.onStart && this.onStart();
  }
  addTime(seconds) {
    if (this.isBurning && this.duration !== Infinity) this.duration += seconds;
  }
  /** reason: 'snuffed' | 'closed' | 'switch' (another light takes over; no report). */
  stop(reason = 'snuffed') {
    if (!this.isBurning && this.state !== 'ending') return;
    this.endReason = reason;
    this.toOut();
  }
  toOut() {
    this.state = 'out';
    this.stateT = 0;
    const reason = this.endReason || 'done';
    this.endReason = null;
    if (reason !== 'switch' && this.onDone) this.onDone({ reason, minutes: Math.round(this.elapsed / 60) });
  }

  update(dt, camera) {
    if (this.state === 'off' && this.level <= 0 && this.dim <= 0) return false;
    this.time += dt;
    this.stateT += dt;
    if (this.state === 'starting') {
      this.elapsed += dt;
      if (this.stateT >= this.startTime) {
        this.state = 'on';
        this.stateT = 0;
      }
    } else if (this.state === 'on') {
      this.elapsed += dt;
      if (this.elapsed >= this.duration) {
        this.state = 'ending';
        this.stateT = 0;
      }
    } else if (this.state === 'ending') {
      if (this.stateT >= this.endTime) {
        this.endReason = 'done';
        this.toOut();
      }
    } else if (this.state === 'out' && this.stateT >= this.outTime) {
      this.state = 'off';
      this.stateT = 0;
    }
    const on = this.state === 'starting' || this.state === 'on' || this.state === 'ending';
    const dimTarget = on ? 1 : 0;
    this.dim += (dimTarget - this.dim) * (1 - Math.exp(-dt * (dimTarget > this.dim ? 1.5 : 1.0)));
    if (!on && this.dim < 0.004) this.dim = 0;
    this.step(dt, camera);
    if (this.state === 'off' && this.level <= 0.001 && this.dim === 0) {
      this.level = 0;
      this.group.visible = false;
      this.hide && this.hide();
    }
    return true;
  }
}

// ------------------------------------------------------------------ the manager
export class Lighting {
  constructor(app, factories) {
    this.app = app;
    this.factories = factories; // id → (app) => source
    this.sources = {};
    this.current = null;
    this.sittingStart = null;
    this.load();
    this.dimEl = document.getElementById('room-dim');
    this.glowEl = document.getElementById('room-glow');
    this.flashEl = document.getElementById('room-flash');
    this.wallEl = document.getElementById('room-wall');
    this.wallCtx = this.wallEl ? this.wallEl.getContext('2d') : null;
    this.baseAmbient = app.ambient.color.clone();
    this.baseFill = app.fill.color.clone();
    this.baseKey = app.key.color.clone();
    this._c = new THREE.Color();
    document.addEventListener('visibilitychange', () => {
      // a sitting keeps time while the app is in the background
      const s = this.current;
      if (document.hidden) this.hiddenAt = performance.now();
      else if (this.hiddenAt && s && s.isBurning) s.elapsed += (performance.now() - this.hiddenAt) / 1000;
    });
  }

  load() {
    const d = defaults();
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved) {
        if (LIGHTS[saved.choice]) d.choice = saved.choice;
        for (const id in d.settings) Object.assign(d.settings[id], (saved.settings || {})[id] || {});
      }
    } catch {
      /* defaults */
    }
    this.store = d;
  }
  save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.store));
    } catch {
      /* not remembered */
    }
  }
  get choice() {
    return this.store.choice;
  }
  settings(id = this.choice) {
    return this.store.settings[id];
  }
  setChoice(id) {
    if (!LIGHTS[id]) return;
    this.store.choice = id;
    this.save();
  }
  set(id, key, value) {
    this.store.settings[id][key] = value;
    this.save();
    const s = this.sources[id];
    if (s) s.applySettings(this.store.settings[id]);
    this.app.invalidate();
  }
  resetSettings(id) {
    this.store.settings[id] = defaults().settings[id];
    this.save();
    const s = this.sources[id];
    if (s) s.applySettings(this.store.settings[id]);
  }

  source(id) {
    if (!this.sources[id]) {
      const s = this.factories[id](this.app);
      s.onDone = (info) => this.onSourceDone(s, info);
      s.applySettings(this.store.settings[id]);
      this.sources[id] = s;
    }
    return this.sources[id];
  }

  /** The light currently lit (or burning out), if any. */
  get lit() {
    return this.current && this.current.isBurning ? this.current : null;
  }
  get anyActive() {
    return Object.values(this.sources).some((s) => s.active);
  }

  /** Light the chosen light for `minutes` (Infinity: open-ended). */
  start(id, minutes) {
    if (!this.app.reader.isOpen) return;
    this.setChoice(id);
    const sec = minutes === Infinity ? Infinity : minutes * 60;
    if (this.current && this.current.isBurning) this.current.stop('switch');
    else this.sittingStart = this.app.reader.s;
    const s = this.source(id);
    s.start(sec);
    this.current = s;
    this.app.invalidate();
  }

  /** Change the light in the middle of a sitting: the new one takes over the time left. */
  switchTo(id) {
    const cur = this.lit;
    this.setChoice(id);
    if (!cur || cur.id === id) return;
    const left = cur.remaining;
    const elapsed = cur.elapsed;
    cur.stop('switch');
    const s = this.source(id);
    const lightsOpen = LIGHTS[id].open;
    // a light that cannot burn open-ended gets 25 minutes when it takes over an open-ended sitting
    s.start(left === Infinity && !lightsOpen ? 25 * 60 : left === Infinity ? Infinity : left + elapsed);
    s.elapsed = left === Infinity ? 0 : elapsed;
    this.current = s;
    this.app.invalidate();
  }

  addTime(minutes) {
    if (this.lit) this.lit.addTime(minutes * 60);
  }
  stop(reason = 'snuffed') {
    if (this.current) this.current.stop(reason);
  }
  gust(dir, strength) {
    for (const s of Object.values(this.sources)) if (s.active && s.gust) s.gust(dir, strength);
  }

  onSourceDone(s, { reason, minutes }) {
    const app = this.app;
    const r = app.reader;
    const pages = r.isOpen && this.sittingStart != null ? Math.max(0, r.s - this.sittingStart) * 2 : 0;
    this.sittingStart = null;
    const L = LIGHTS[s.id];
    const pp = `${pages} page${pages === 1 ? '' : 's'}`;
    const mins = `${Math.max(1, minutes)} min`;
    if (reason === 'done') app.ui.toast(`${L.ended} · ${mins} · ${pp}`, 4200);
    else if (reason !== 'closed' || minutes >= 1) app.ui.toast(`${L.out} · ${mins} · ${pp}`, 3000);
    app.ui.syncLight(this);
  }

  /** Where things stand around the open book (from the reader, every frame a light is active). */
  place(L) {
    for (const s of Object.values(this.sources)) if (s.active) s.place(L);
  }

  // ---------------------------------------------------------------- frame
  /** Returns the frame rate the lights need when nothing else moves (0: none). */
  update(dt, camera) {
    let fps = 0;
    for (const s of Object.values(this.sources)) if (s.update(dt, camera)) fps = Math.max(fps, s.fps);
    this.apply(camera);
    return fps;
  }

  /** Mix the room's lights and the CSS layers toward the active sources. */
  apply(camera) {
    const app = this.app;
    const b = app.lightBase;
    let amb = 1;
    let key = 1;
    let fill = 1;
    let paperRake = 1;
    const ambC = this._c.copy(this.baseAmbient);
    const fillC = app.fill.color.copy(this.baseFill);
    app.key.color.copy(this.baseKey);
    let strongest = null;
    for (const s of Object.values(this.sources)) {
      if (s.dim <= 0) continue;
      const R = s.room;
      amb *= lerp(1, R.ambient, s.dim);
      key *= lerp(1, R.key, s.dim);
      fill *= lerp(1, R.fill, s.dim);
      paperRake *= lerp(1, R.rake ?? R.key, s.dim);
      if (R.tint) {
        ambC.lerp(R.tint, s.dim * 0.85);
        fillC.lerp(R.tint, s.dim * 0.6);
      }
      if (!strongest || s.dim > strongest.dim) strongest = s;
    }
    app.ambient.intensity = b.ambient * amb;
    app.ambient.color.copy(ambC);
    app.key.intensity = b.key * key;
    app.fill.intensity = b.fill * fill;
    app.onRoomLight(paperRake, amb);

    // CSS: the room behind the book
    const dark = app.theme === 'dark';
    if (strongest) {
      const css = strongest.css || {};
      const d = strongest.dim;
      const ds = this.dimEl.style;
      ds.setProperty('--d1', css.dim1 || 'rgba(26,18,10,0.34)');
      ds.setProperty('--d2', css.dim2 || 'rgba(14,9,4,0.5)');
      ds.setProperty('--dx', css.dimX || '50%');
      ds.opacity = (d * (css.dimAmount ?? 1) * (dark ? 0.25 : 1)).toFixed(3);
      const g = strongest.glow ? strongest.glow(camera, app.width, app.height) : null;
      const gs = this.glowEl.style;
      if (g && g.opacity > 0.001) {
        gs.setProperty('--gx', `${g.x.toFixed(1)}px`);
        gs.setProperty('--gy', `${g.y.toFixed(1)}px`);
        gs.setProperty('--g1', g.c1);
        gs.setProperty('--g2', g.c2);
        gs.setProperty('--gr', `${g.r || 30}vmin`);
        gs.opacity = (g.opacity * (dark ? 1.2 : 1)).toFixed(3);
      } else gs.opacity = '0';
      this.flashEl.style.opacity = (strongest.flash || 0).toFixed(3);
      this.drawWall(strongest.wall ? strongest.wall(camera, app.width, app.height) : null, dark);
    } else {
      this.dimEl.style.opacity = '0';
      this.glowEl.style.opacity = '0';
      this.flashEl.style.opacity = '0';
      this.drawWall(null);
    }
  }

  /** A window's light on the wall: its pattern, skewed into a patch beside the book. */
  drawWall(w, dark) {
    const el = this.wallEl;
    if (!el) return;
    if (!w || w.opacity <= 0.002) {
      if (this.wallShown) {
        this.wallCtx.clearRect(0, 0, el.width, el.height);
        el.style.opacity = '0';
        this.wallShown = false;
      }
      return;
    }
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const W = Math.round(window.innerWidth * dpr);
    const H = Math.round(window.innerHeight * dpr);
    if (el.width !== W || el.height !== H) {
      el.width = W;
      el.height = H;
    }
    const ctx = this.wallCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // the patch: a parallelogram (the window seen slant on the wall)
    const [ax, ay, bx, by, cx, cy] = w.quad; // corner, along-x corner, along-y corner (CSS px)
    ctx.setTransform(((bx - ax) * dpr) / w.image.width, ((by - ay) * dpr) / w.image.width, ((cx - ax) * dpr) / w.image.height, ((cy - ay) * dpr) / w.image.height, ax * dpr, ay * dpr);
    ctx.globalAlpha = 1;
    ctx.drawImage(w.image, 0, 0);
    el.style.opacity = (w.opacity * (dark ? 0.35 : 1)).toFixed(3);
    el.style.setProperty('--wall-tint', w.tint || 'rgb(255,236,200)');
    this.wallShown = true;
  }
}
