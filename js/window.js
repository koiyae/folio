// Daylight through a window, off to one side of the book.
//
// A distant spot light stands in for the window: its cookie (a canvas drawn here) is the window's pattern —
// the bright panes, the dark bars of the frame, and whatever moves in front of it — so the pattern falls
// across the pages, bent over their curve, and a turning leaf casts its shadow through it. A softer copy of
// the pattern lies on the wall beside the book.
//
// SunWindow  — sunlight, warm at the ends of the day and near white at noon (time of day, or the clock),
//              with leaves swaying in front of the glass.
// RainWindow — soft overcast light, cool, the frame's shadow blurred to nothing; raindrops collect on the
//              glass and run down it, each a small shadow with a point of light in its middle. Now and then
//              lightning.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './anim.js';
import { LightSource, kelvinColor, noise1 } from './lighting.js';

const G = 512; // cookie resolution
const WIN = { x0: 0.2, x1: 0.8, y0: 0.12, y1: 0.88 }; // the window inside the cookie (fits its circle)

/** Draw `fn` (which paints shapes in `color`) as a blurred shadow, so edges are soft (works everywhere). */
function blurred(ctx, blur, color, fn) {
  const OFF = 4000;
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = OFF;
  ctx.translate(-OFF, 0);
  ctx.fillStyle = color;
  fn(ctx);
  ctx.restore();
}

function windowShape(ctx, inset = 0) {
  const x0 = (WIN.x0 + inset) * G;
  const y0 = (WIN.y0 + inset) * G;
  ctx.fillRect(x0, y0, (WIN.x1 - WIN.x0 - 2 * inset) * G, (WIN.y1 - WIN.y0 - 2 * inset) * G);
}
function frameBars(ctx) {
  // one upright, two transoms
  const cx = (WIN.x0 + WIN.x1) / 2;
  ctx.fillRect((cx - 0.016) * G, WIN.y0 * G, 0.032 * G, (WIN.y1 - WIN.y0) * G);
  for (const f of [0.36, 0.64]) {
    const y = lerp(WIN.y0, WIN.y1, f);
    ctx.fillRect(WIN.x0 * G, (y - 0.013) * G, (WIN.x1 - WIN.x0) * G, 0.026 * G);
  }
}

class WindowLight extends LightSource {
  constructor(app, id) {
    super(app, id);
    this.startTime = 2.5;
    this.endTime = 5;
    this.outTime = 3;
    this.fps = 20;
    this.flash = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = G;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.NoColorSpace;
    this.wallCanvas = document.createElement('canvas');
    this.wallCanvas.width = 120;
    this.wallCanvas.height = 150;
    this.wallCtx = this.wallCanvas.getContext('2d');
    this.wallT = -1;
    this.drawT = -1;
    this.spot = new THREE.SpotLight(0xffffff, 0, 0, 0.3, 0, 0);
    this.spot.map = this.tex;
    this.spot.castShadow = true;
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.radius = 3;
    this.spot.shadow.blurSamples = 10;
    this.spot.shadow.bias = -0.0006;
    this.group.add(this.spot);
    app.scene.add(this.spot.target);
    this._c = new THREE.Color();
    this.side = -1;
    this.offset = 0;
  }

  /** Elevation (radians) of the light above the page. */
  get elevation() {
    return 0.6;
  }

  place(L) {
    const side = this.s.side >= 0 ? 1 : -1;
    this.side = side;
    this.L = L;
    const el = this.elevation;
    const dir = new THREE.Vector3()
      .addScaledVector(L.R, side * Math.cos(el) * 0.86)
      .addScaledVector(L.N, Math.sin(el))
      .addScaledVector(L.U, Math.cos(el) * 0.34)
      .normalize();
    const D = 160 * L.s;
    const off = this.offset * L.edge;
    this.spot.target.position.copy(L.center).addScaledVector(L.R, off);
    this.spot.target.updateMatrixWorld();
    this.spot.position.copy(this.spot.target.position).addScaledVector(dir, D);
    this.spot.angle = Math.atan((1.5 * L.span) / D);
    this.spot.shadow.camera.near = D * 0.7;
    this.spot.shadow.camera.far = D * 1.35;
  }

  /** The window's patch on the wall: beyond the book, on the side away from the window. */
  wall(camera, w, h) {
    if (this.dim <= 0.01) return null;
    const away = -this.side;
    const drift = this.offset * 0.08 * w;
    const cx = w / 2 + away * w * 0.33 + drift;
    const pw = w * 0.36;
    const ph = h * 0.5;
    const skew = away * pw * 0.32;
    const ax = cx - pw / 2;
    const ay = h * 0.08;
    return {
      image: this.wallImage(),
      quad: [ax, ay, ax + pw, ay + skew * 0.25, ax + skew, ay + ph],
      opacity: this.level * this.wallAmount,
    };
  }

  /** A small, soft copy of the cookie for the wall: neutral grey where there is no light (soft-light blend). */
  wallImage() {
    if (this.time - this.wallT < 0.1 && this.wallT >= 0) return this.wallCanvas;
    this.wallT = this.time;
    const c = this.wallCtx;
    const W = this.wallCanvas.width;
    const H = this.wallCanvas.height;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = 'rgb(128,128,128)';
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.6;
    c.drawImage(this.canvas, WIN.x0 * G, WIN.y0 * G, (WIN.x1 - WIN.x0) * G, (WIN.y1 - WIN.y0) * G, 0, 0, W, H);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'multiply';
    c.fillStyle = this.wallTint;
    c.fillRect(0, 0, W, H);
    c.globalCompositeOperation = 'source-over';
    return this.wallCanvas;
  }

  hide() {
    this.spot.intensity = 0;
  }
}

// =============================================================== sun
export class SunWindow extends WindowLight {
  constructor(app) {
    super(app, 'sun');
    this.room = { ambient: 0.72, key: 0.2, fill: 0.55, rake: 0.35, tint: new THREE.Color(0.86, 0.92, 1.0) };
    this.css = { dim1: 'rgba(40,46,62,0.10)', dim2: 'rgba(18,22,34,0.26)', dimAmount: 1 };
    this.wallAmount = 0.9;
    this.wallTint = 'rgb(255,236,205)';
    // clusters of leaves hanging into the top corner of the window, and a few lower down
    const r = mulberry(7);
    this.leaves = [];
    for (let i = 0; i < 16; i++) {
      const top = i < 11;
      const cx = top ? lerp(0.08, 0.62, r()) : lerp(0.05, 0.3, r());
      const cy = top ? lerp(0.02, 0.32, r()) : lerp(0.35, 0.7, r());
      const n = 5 + Math.floor(r() * 7);
      const leaves = [];
      for (let k = 0; k < n; k++) leaves.push({ dx: (r() - 0.5) * 0.13, dy: (r() - 0.5) * 0.1, a: r() * Math.PI, l: 0.022 + r() * 0.03, w: 0.5 + r() * 0.3, seed: r() * 50 });
      this.leaves.push({ cx, cy, leaves, seed: r() * 100, amp: 0.008 + r() * 0.016 });
    }
  }

  applySettings(s) {
    this.s = { ...s };
    this.drawT = -1;
  }

  get hour() {
    if (this.s.clock) {
      const d = new Date();
      const h = d.getHours() + d.getMinutes() / 60;
      return h < 7 || h > 20 ? 19.5 : h;
    }
    return this.s.time ?? 16.5;
  }
  get elevation() {
    const h = this.hour;
    return Math.max(0.1, 1.08 * Math.sin((Math.PI * (h - 6)) / 14));
  }

  /** The cookie: sunlit panes, the frame's bars, leaves moving in the breeze. */
  draw() {
    const ctx = this.ctx;
    const t = this.time;
    const live = this.lively;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, G, G);
    blurred(ctx, 6, '#fff', (c) => windowShape(c));
    blurred(ctx, 4, '#000', frameBars);
    // leaves: dark, not quite opaque (light slips through), edges soft
    for (const cl of this.leaves) {
      const sx = live * (cl.amp * Math.sin(t * 0.9 + cl.seed) + 0.012 * (noise1(t * 0.45 + cl.seed) - 0.5));
      const sy = live * 0.006 * (noise1(t * 0.6 + cl.seed * 2) - 0.5);
      // one path per cluster, filled once (one blur per cluster, not per leaf)
      blurred(ctx, 5, 'rgba(0,0,0,0.82)', (c) => {
        c.beginPath();
        for (const lf of cl.leaves) {
          const flutter = live * 0.35 * (noise1(t * 1.7 + lf.seed) - 0.5);
          const x = (WIN.x0 + (cl.cx + lf.dx + sx) * (WIN.x1 - WIN.x0)) * G;
          const y = (WIN.y0 + (cl.cy + lf.dy + sy) * (WIN.y1 - WIN.y0)) * G;
          const xx = this.side > 0 ? G - x : x; // the tree is on the window's outer side
          const rot = lf.a + flutter;
          c.moveTo(xx + Math.cos(rot) * lf.l * G, y + Math.sin(rot) * lf.l * G); // the ellipse's own start point
          c.ellipse(xx, y, lf.l * G, lf.l * lf.w * G, rot, 0, Math.PI * 2);
        }
        c.fill('nonzero');
      });
    }
    this.tex.needsUpdate = true;
  }

  step(dt) {
    const st = this.state;
    let body = 0;
    if (st === 'starting') body = smoothstep(0, this.startTime, this.stateT);
    else if (st === 'on') body = 1;
    else if (st === 'ending') body = 1 - smoothstep(0.4, 1, this.stateT / this.endTime);
    else if (st === 'out') body = 0;
    this.level += (body - this.level) * (1 - Math.exp(-dt * 3));
    if (body === 0 && this.level < 0.003) this.level = 0;
    // the patch of sun crosses the book (with a timer), drifting away from the window
    this.offset = this.side * 0.1; // the patch of sun, a little toward the window
    const h = this.hour;
    const el = this.elevation;
    const k = lerp(2600, 5600, smoothstep(0.08, 0.75, el));
    kelvinColor(k, this._c);
    this.spot.color.copy(this._c);
    const E = (1.25 + 1.15 * smoothstep(0.08, 0.7, el)) * this.s.brightness;
    this.spot.intensity = E * this.level;
    // the sky's light in the room: cool at noon, warmer late in the day
    this.room.tint.setRGB(lerp(1.0, 0.86, smoothstep(0.1, 0.6, el)), lerp(0.86, 0.92, smoothstep(0.1, 0.6, el)), lerp(0.78, 1.0, smoothstep(0.1, 0.6, el)));
    this.wallTint = `rgb(255,${Math.round(lerp(214, 240, smoothstep(0.1, 0.6, el)))},${Math.round(lerp(170, 215, smoothstep(0.1, 0.6, el)))})`;
    // redraw the cookie as the leaves move (or once, when still)
    const live = this.lively;
    if (this.drawT < 0 || (live > 0.01 && this.time - this.drawT > 1 / 22)) {
      this.drawT = this.time;
      this.draw();
    }
    this.fps = live > 0.01 ? 20 : st === 'starting' || st === 'ending' ? 30 : 4;
    this._hour = h;
  }
}

// =============================================================== rain
export class RainWindow extends WindowLight {
  constructor(app) {
    super(app, 'rain');
    this.room = { ambient: 0.62, key: 0.16, fill: 0.45, rake: 0.3, tint: new THREE.Color(0.82, 0.88, 1.0) };
    this.css = { dim1: 'rgba(18,24,34,0.22)', dim2: 'rgba(8,12,20,0.42)', dimAmount: 0.95 };
    this.wallAmount = 0.6;
    this.wallTint = 'rgb(222,232,255)';
    this.spot.shadow.radius = 12;
    this.drops = [];
    this.spawnAcc = 0;
    this.nextBolt = 40 + Math.random() * 50;
    this.bolt = null;
    this.k = 6500;
  }

  applySettings(s) {
    this.s = { ...s };
    this.k = s.warmth;
  }

  get elevation() {
    return 0.55;
  }

  draw(dt) {
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, G, G);
    // overcast: bright panes, soft frame
    blurred(ctx, 22, 'rgb(205,205,205)', (c) => windowShape(c, 0.01));
    blurred(ctx, 16, 'rgba(0,0,0,0.55)', frameBars);
    // drops on the glass: a soft shadow ring with a point of light in the middle; runners leave a trail
    const x0 = WIN.x0 * G;
    const y0 = WIN.y0 * G;
    const ww = (WIN.x1 - WIN.x0) * G;
    const hh = (WIN.y1 - WIN.y0) * G;
    for (const d of this.drops) {
      const x = x0 + d.x * ww;
      const y = y0 + d.y * hh;
      const rr = d.r * G;
      ctx.fillStyle = `rgba(0,0,0,${0.32 * d.a})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rr, rr * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(255,255,255,${0.75 * d.a})`;
      ctx.beginPath();
      ctx.ellipse(x - rr * 0.15, y + rr * 0.2, rr * 0.38, rr * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      if (d.vy > 0) {
        ctx.fillStyle = `rgba(0,0,0,${0.12 * d.a})`;
        ctx.fillRect(x - rr * 0.35, y - d.trail * hh, rr * 0.7, d.trail * hh);
      }
    }
    this.tex.needsUpdate = true;
  }

  stepDrops(dt) {
    const live = this.lively;
    const st = this.state;
    // the rain eases off over the sitting, and stops at the end
    // drops keep coming while the curtains are open; closed, the last ones run off
    const rate = (6 + 30 * live) * (st === 'starting' || st === 'on' ? 1 : 0);
    this.spawnAcc += rate * dt;
    while (this.spawnAcc > 1) {
      this.spawnAcc -= 1;
      if (this.drops.length < 170) this.drops.push({ x: Math.random(), y: Math.random() * 0.95, r: 0.003 + Math.pow(Math.random(), 3) * 0.009, a: 0, vy: 0, trail: 0, life: 25 + Math.random() * 40, age: 0 });
    }
    for (const d of this.drops) {
      d.age += dt;
      d.a = Math.min(1, d.a + dt * 3) * (d.age > d.life ? Math.max(0, 1 - (d.age - d.life) / 3) : 1);
      // big drops let go and run, swallowing what they meet
      if (d.vy === 0 && d.r > 0.0085 && Math.random() < dt * 0.25 * (0.3 + live)) d.vy = 0.05 + Math.random() * 0.06;
      if (d.vy > 0) {
        d.y += d.vy * dt * (0.6 + 0.8 * noise1(d.age * 3 + d.x * 50));
        d.trail = Math.min(0.2, d.trail + d.vy * dt * 0.6);
        d.x += (noise1(d.age * 2 + d.y * 30) - 0.5) * dt * 0.01;
        if (d.y > 1.02) d.age = d.life + 3;
      }
    }
    this.drops = this.drops.filter((d) => d.age < d.life + 3);
  }

  step(dt) {
    const st = this.state;
    let body = 0;
    if (st === 'starting') body = smoothstep(0, this.startTime, this.stateT);
    else if (st === 'on') body = 1;
    else if (st === 'ending') body = 1 + 0.25 * smoothstep(0, 0.5, this.stateT / this.endTime) - 1.25 * smoothstep(0.55, 1, this.stateT / this.endTime);
    this.level += (body - this.level) * (1 - Math.exp(-dt * 2.5));
    if (body === 0 && this.level < 0.003) this.level = 0;
    this.offset = -this.side * 0.05;
    kelvinColor(this.k, this._c);
    this.spot.color.copy(this._c);
    // lightning, now and then (never with "reduce motion")
    const live = this.lively;
    this.flash = 0;
    if (st === 'on' && live > 0.25 && !this.reduced) {
      this.nextBolt -= dt * live;
      if (this.nextBolt <= 0) {
        this.bolt = { t: 0 };
        this.nextBolt = 50 + Math.random() * 90;
      }
    }
    let boltK = 0;
    if (this.bolt) {
      const b = (this.bolt.t += dt);
      // a double flicker, then it's gone
      boltK = b < 0.07 ? 1 : b < 0.16 ? 0.15 : b < 0.24 ? 0.7 : Math.max(0, 0.7 - (b - 0.24) * 3);
      if (b > 0.6) this.bolt = null;
    }
    this.flash = boltK * 0.5;
    this.spot.intensity = (1.35 * this.s.brightness * this.level) * (1 + 2.2 * boltK);
    this.stepDrops(dt);
    if (this.drawT < 0 || this.time - this.drawT > 1 / 20) {
      this.drawT = this.time;
      this.draw(dt);
    }
    this.fps = 20;
  }
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
