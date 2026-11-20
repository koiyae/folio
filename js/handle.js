// Grab-and-turn controller for a book: drag to rotate it like an object, fling it, let it settle.
//
// Rotation is accumulated as a quaternion turned about *screen* axes (horizontal drag spins about the
// vertical axis, vertical drag tips about the horizontal one), so it never inverts when the book is upside
// down. Numbers follow the reference controller: 0.01125 rad/px on touch (×0.75 with a mouse), fling
// capped at 0.42 rad/frame and decaying ×0.95 per frame, then a delayed ease back to rest.

import * as THREE from 'three';

const AX = new THREE.Vector3(1, 0, 0);
const AY = new THREE.Vector3(0, 1, 0);
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _target = new THREE.Quaternion();
const IDENTITY = new THREE.Quaternion();
const SENS = 0.01125;
const MAX_W = 0.42 * 60; // rad/s

/** The part of q that is a pure turn about the vertical axis (swing–twist decomposition). */
function twistY(q, out) {
  out.set(0, q.y, 0, q.w);
  const l = Math.hypot(out.y, out.w);
  if (l < 1e-6) return out.identity();
  out.y /= l;
  out.w /= l;
  return out;
}

export class RotationHandle {
  /**
   * @param {object} o
   * @param {'pitch'|'all'|'none'} o.settle  what to undo after letting go: only the tilt (keep the spin),
   *        everything, or nothing.
   * @param {number} o.delayMouse / o.delayTouch  seconds before settling starts
   * @param {number} o.settleTime  smoothing time of the settle
   */
  constructor({ settle = 'pitch', delayMouse = 2, delayTouch = 0.6, settleTime = 0.9 } = {}) {
    this.q = new THREE.Quaternion();
    this.w = new THREE.Vector2(); // angular velocity, rad/s (x: about screen X, y: about screen Y)
    this.dragW = new THREE.Vector2();
    this.spin = 0; // smoothed yaw speed, drives the cover flaps
    this.dragging = false;
    this.settleMode = settle;
    this.delayMouse = delayMouse;
    this.delayTouch = delayTouch;
    this.settleTime = settleTime;
    this.settleAt = Infinity;
    this.homeOnce = false;
    this.moved = 0;
    this.track = [];
  }

  /** True while anything is moving (drag, fling, settling). */
  get busy() {
    return this.dragging || this.w.lengthSq() > 1e-6 || this.settleAt !== Infinity;
  }

  /** How far from rest, in radians. */
  get angle() {
    return 2 * Math.acos(Math.min(1, Math.abs(this.q.w)));
  }

  rotate(ax, ay) {
    _qa.setFromAxisAngle(AX, ax);
    _qb.setFromAxisAngle(AY, ay);
    this.q.premultiply(_qa).premultiply(_qb).normalize();
  }

  begin(x, y, type, t) {
    this.dragging = true;
    this.type = type;
    this.lx = x;
    this.ly = y;
    this.lt = t;
    this.moved = 0;
    this.track = [{ x, y, t }];
    this.w.set(0, 0);
    this.dragW.set(0, 0);
    this.settleAt = Infinity;
    this.homeOnce = false;
  }

  move(x, y, t) {
    if (!this.dragging) return;
    const s = SENS * (this.type === 'touch' ? 1 : 0.75);
    const dx = x - this.lx;
    const dy = y - this.ly;
    const dt = Math.max(1, t - this.lt) / 1000;
    this.lx = x;
    this.ly = y;
    this.lt = t;
    this.moved += Math.hypot(dx, dy);
    this.rotate(dy * s, dx * s);
    this.dragW.set((dy * s) / dt, (dx * s) / dt);
    this.track.push({ x, y, t });
    while (this.track.length > 2 && t - this.track[0].t > 90) this.track.shift();
  }

  /** Let go: fling with the recent hand speed, then settle after a pause. */
  end(t, clock) {
    if (!this.dragging) return;
    this.dragging = false;
    const s = SENS * (this.type === 'touch' ? 1 : 0.75);
    const a = this.track[0];
    const b = this.track[this.track.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt > 0.008 && t - b.t < 80) {
      this.w.set(((b.y - a.y) * s) / dt, ((b.x - a.x) * s) / dt);
      const m = this.w.length();
      if (m > MAX_W) this.w.multiplyScalar(MAX_W / m);
    } else this.w.set(0, 0);
    this.dragW.set(0, 0);
    this.scheduleSettle(clock);
  }

  scheduleSettle(clock) {
    if (this.settleMode === 'none') {
      this.settleAt = Infinity;
      return;
    }
    this.settleAt = clock + (this.type === 'touch' ? this.delayTouch : this.delayMouse);
  }

  /** Ease all the way back to rest now (or instantly). */
  home(clock, instant = false) {
    this.dragging = false;
    this.w.set(0, 0);
    if (instant) {
      this.q.identity();
      this.settleAt = Infinity;
      this.spin = 0;
      return;
    }
    if (this.angle < 1e-4) return;
    this.homeOnce = true;
    this.settleAt = clock;
  }

  update(dt, clock) {
    if (dt <= 0) return false;
    let changed = false;
    if (!this.dragging) {
      if (this.w.lengthSq() > 1e-6) {
        this.rotate(this.w.x * dt, this.w.y * dt);
        this.w.multiplyScalar(Math.pow(0.95, dt * 60));
        if (this.w.lengthSq() < 1e-6) this.w.set(0, 0);
        changed = true;
      }
      if (clock >= this.settleAt) {
        if (this.homeOnce || this.settleMode === 'all') _target.identity();
        else twistY(this.q, _target);
        const k = 1 - Math.exp(-dt / Math.max(0.05, this.homeOnce ? 0.22 : this.settleTime * 0.4));
        this.q.slerp(_target, k);
        if (this.q.angleTo(_target) < 2e-3) {
          this.q.copy(_target);
          this.settleAt = Infinity;
          this.homeOnce = false;
          if (this.q.angleTo(IDENTITY) < 1e-4) this.q.identity();
        }
        changed = true;
      }
    }
    const target = this.dragging ? this.dragW.y : this.w.y;
    const before = this.spin;
    this.spin += (target - this.spin) * (1 - Math.exp(-11 * dt));
    if (Math.abs(this.spin) < 1e-3 && target === 0) this.spin = 0;
    if (Math.abs(this.spin - before) > 1e-4) changed = true;
    return changed;
  }
}
