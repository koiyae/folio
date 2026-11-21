// A fire just out of view to one side: large, low, warm light. It moves slower and wider than a candle —
// several layers of slow noise, now and then a log settling with a brief flare — and the room around goes
// dark and warm. The light comes in low from the side and a little from in front, so a turning leaf throws
// a long shadow and the book's own shadow sways on the wall behind. Put out, it sinks to embers and fades.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './anim.js';
import { LightSource, kelvinColor, noise1 } from './lighting.js';

const FIRE_E = 2.9; // irradiance where the light faces the page squarely (the key is 2.1)

export class Fireside extends LightSource {
  constructor(app) {
    super(app, 'fire');
    this.startTime = 3.5; // a fire takes a moment to catch
    this.endTime = 7;
    this.outTime = 5;
    this.room = { ambient: 0.38, key: 0.22, fill: 0.16, rake: 0.25, tint: new THREE.Color(1.0, 0.72, 0.5) };
    this.css = { dim1: 'rgba(30,14,4,0.42)', dim2: 'rgba(12,5,1,0.62)', dimAmount: 1 };
    this.flick = 1;
    this.flare = 0;
    this.nextFlare = 8;
    this.k = 1950;
    this._c = new THREE.Color();
    this.sun = new THREE.DirectionalLight(0xffffff, 0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.radius = 9;
    this.sun.shadow.blurSamples = 12;
    this.sun.shadow.bias = -0.0008;
    this.group.add(this.sun);
    app.scene.add(this.sun.target);
    this.screenX = 0;
  }

  applySettings(s) {
    this.s = { ...s };
    this.k = s.warmth;
  }

  place(L) {
    const side = this.s.side >= 0 ? 1 : -1;
    // low and to the side, a little in front of the book
    const dir = new THREE.Vector3().addScaledVector(L.R, side * 0.86).addScaledVector(L.N, 0.32).addScaledVector(L.U, -0.25).normalize();
    const D = 90 * L.s;
    this.sun.target.position.copy(L.center);
    this.sun.position.copy(L.center).addScaledVector(dir, D);
    this.group.position.set(0, 0, 0);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    const r = (L.span + 4 * L.s) * 1.15;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = D * 0.4;
    cam.far = D * 1.9;
    cam.updateProjectionMatrix();
    this.side = side;
  }

  step(dt) {
    const st = this.state;
    const t = this.time;
    const live = this.lively;
    // how much fire there is
    let body = 0;
    if (st === 'starting') body = smoothstep(0, this.startTime, this.stateT) * 0.9 + 0.1 * Math.min(1, this.stateT);
    else if (st === 'on') body = 1;
    else if (st === 'ending') body = 1 - 0.75 * smoothstep(0, this.endTime, this.stateT);
    else if (st === 'out') body = 0.25 * (1 - smoothstep(0, this.outTime, this.stateT));
    const sink = 1;
    // flicker: big slow swells, a restless middle, a little quick shiver
    const n = (a, f, o) => a * (noise1(t * f + o) - 0.5);
    let f = 1 + live * (n(0.34, 0.33, 0) + n(0.24, 1.05, 11) + n(0.12, 2.6, 23) + n(0.06, 5.4, 37));
    // a log settles now and then: a flare that dies away
    this.nextFlare -= dt * Math.max(0.2, live);
    if (this.nextFlare <= 0 && st === 'on') {
      this.flare = 0.35 + Math.random() * 0.25;
      this.nextFlare = 14 + Math.random() * 28;
    }
    this.flare *= Math.exp(-dt / 1.6);
    f += this.flare * live;
    this.flick = f;
    this.level = body;
    const embers = clamp(1 - body * sink, 0, 1); // the lower it burns, the redder
    kelvinColor(lerp(this.k, 1550, embers * 0.8), this._c);
    this.sun.color.copy(this._c);
    this.sun.intensity = FIRE_E * body * sink * f * this.s.brightness;
    this.dimShift = embers;
  }

  hide() {
    this.sun.intensity = 0;
  }

  /** Firelight on the wall, coming in from the screen's edge on the fire's side. */
  glow(camera, w, h) {
    if (this.level <= 0.01) return null;
    const x = this.side > 0 ? w * 1.02 : -w * 0.02;
    return { x, y: h * 0.78, opacity: clamp(this.level * this.flick, 0, 1.3) * 0.55 * this.s.brightness, c1: 'rgba(255,150,60,0.95)', c2: 'rgba(255,120,40,0.5)', r: 75 };
  }
}
