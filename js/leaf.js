// A single leaf (two pages) as a deformable sheet.
//
// The sheet's cross-section is a chain hinged at the gutter. Its angle along the width blends between
// lying on the right stack (t = 0) and lying on the left stack (t = 1), plus a bend term (tip leading or
// trailing the turn). On top of that sits an analytic developable roll — the corner curl that follows a
// drag — rolled about a tilted fold line through a pivot, applied outward from the stack only.

import * as THREE from 'three';
import { stackProfile } from './book3d.js';

export const NX = 44;
export const NY = 22;
const NC = 72;

// ------------------------------------------------------------------ stack surface tables
/** Angle of a stack's top surface at regular arc-length steps (what a resting leaf follows). */
export function surfaceTable(h, o, Wp) {
  const prof = stackProfile(h, o, Wp);
  const ang = new Float32Array(NC);
  const ds = Wp / NC;
  const steps = 900;
  const dx = (Wp * 1.25) / steps;
  let s = 0;
  let x = 0;
  let z = prof(0);
  let seg = 0;
  let target = 0.5 * ds;
  for (let i = 0; i < steps && seg < NC; i++) {
    const x1 = x + dx;
    const z1 = prof(x1);
    const l = Math.hypot(dx, z1 - z);
    const a = Math.atan2(z1 - z, dx);
    while (seg < NC && s + l >= target) {
      ang[seg++] = a;
      target = (seg + 0.5) * ds;
    }
    s += l;
    x = x1;
    z = z1;
  }
  while (seg < NC) ang[seg++] = 0;
  return { prof, ang, h, o };
}

// ------------------------------------------------------------------ material
const blankWhite = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
})();
export const clearInk = (() => {
  const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1);
  t.needsUpdate = true;
  return t;
})();

/**
 * Paper. Physically based and rough, with what makes a page read as paper rather than card:
 *  - show-through: the other side's print, mirrored and soft, darkens this side by ≈6 % (book stock is
 *    ≈90–95 % opaque), rising to ≈13 % while the leaf is in the air;
 *  - transmission: light reaching the far face comes through the sheet, filtered by both prints, so a lifted
 *    page glows and shows its back mirrored;
 *  - fibre and formation in the albedo, the paper's tooth as a normal map, ink a little smoother than paper;
 *  - a gutter that dives into the spine (wide shade + narrow crease) with warm light bounced off the facing page;
 *  - grain that lives mostly in the shadows.
 */
export function makePageMaterial(paper) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0,
    side: THREE.DoubleSide,
    normalMap: paper.normal,
    normalScale: new THREE.Vector2(0.16, 0.16),
  });
  const u = {
    mapFront: { value: blankWhite },
    mapBack: { value: blankWhite },
    inkFront: { value: clearInk },
    inkBack: { value: clearInk },
    paperFibre: { value: paper.fibre },
    paperRepeat: { value: paper.repeat }, // shared: set per book so fibres stay round
    paperTint: { value: new THREE.Color(0xe9e8e4) },
    turnLift: { value: 0 }, // sin(π·t): 0 lying on a stack, 1 standing up
    transmit: { value: 0.34 }, // diffuse transmittance of the sheet
  };
  mat.userData.u = u;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPageUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvPageUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D mapFront;
uniform sampler2D mapBack;
uniform sampler2D inkFront;
uniform sampler2D inkBack;
uniform sampler2D paperFibre;
uniform vec2 paperRepeat;
uniform vec3 paperTint;
uniform float turnLift;
uniform float transmit;
varying vec2 vPageUv;
// the other side of the sheet, in its own page coordinates
vec3 folioOther(vec2 uv, float bias) {
  return gl_FrontFacing ? texture2D(mapBack, uv, bias).rgb : texture2D(mapFront, uv, bias).rgb;
}
vec4 folioOtherInk(vec2 uv) {
  return gl_FrontFacing ? texture2D(inkBack, uv) : texture2D(inkFront, uv);
}
float folioHash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}`,
      )
      .replace(
        '#include <map_fragment>',
        `vec2 puv = gl_FrontFacing ? vPageUv : vec2(1.0 - vPageUv.x, vPageUv.y);
vec2 ouv = vec2(1.0 - puv.x, puv.y); // this spot, seen from the other side
vec3 pg = gl_FrontFacing ? texture2D(mapFront, puv).rgb : texture2D(mapBack, puv).rgb;
vec4 ink = gl_FrontFacing ? texture2D(inkFront, puv) : texture2D(inkBack, puv);
// show-through: soft, mirrored, subtractive (ink behind absorbs, it never lightens this side)
vec3 ghost = (
    folioOther(ouv, 2.5)
  + folioOther(ouv + vec2( 0.004,  0.003), 2.5)
  + folioOther(ouv + vec2(-0.0035, 0.004), 2.5)
  + folioOther(ouv + vec2( 0.003, -0.004), 2.5)
  + folioOther(ouv + vec2(-0.004, -0.003), 2.5)) * 0.2;
vec4 oInk = folioOtherInk(ouv);
ghost *= mix(vec3(1.0), oInk.rgb, oInk.a);
float ghostK = 0.06 + 0.07 * turnLift;
vec3 col = pg * mix(vec3(1.0), ghost, ghostK);
col *= mix(vec3(1.0), ink.rgb, ink.a);
float fib = texture2D(paperFibre, vPageUv * paperRepeat).r;
vec3 paperCol = paperTint * (0.955 + 0.09 * fib);
col *= paperCol;
float folioLum = dot(pg, vec3(0.2126, 0.7152, 0.0722));
// the gutter: a wide shade and a narrow crease where the sheet dives into the spine
float sc = vPageUv.x;
float gBand = 1.0 - smoothstep(0.0, 0.14, sc);
float gCore = 1.0 - smoothstep(0.0, 0.045, sc);
float gShade = min(0.6, 0.2 * gBand * gBand + 0.36 * gCore * gCore * gCore);
col *= 1.0 - gShade;
// a faint shade along the fore-edge, where the sheet turns away from the light
col *= mix(0.92, 1.0, smoothstep(1.0, 0.965, sc));
diffuseColor.rgb *= col;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * mix(0.74, 1.0, smoothstep(0.12, 0.6, folioLum)); // ink is a touch smoother`,
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  // light arriving on the far face comes through the sheet
  vec3 tN = normalize(geometryNormal);
  vec3 tLight = vec3(0.0);
  #if NUM_DIR_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
    tLight += directionalLights[ i ].color * max(0.0, -dot(tN, directionalLights[ i ].direction));
  }
  #pragma unroll_loop_end
  #endif
  #if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    vec3 tlv = pointLights[ i ].position - geometryPosition;
    float tld = length(tlv);
    tLight += pointLights[ i ].color * getDistanceAttenuation(tld, pointLights[ i ].distance, pointLights[ i ].decay) * max(0.0, -dot(tN, tlv / tld));
  }
  #pragma unroll_loop_end
  #endif
  vec3 thru = paperCol * pg * folioOther(ouv, 0.6) * mix(vec3(1.0), oInk.rgb, oInk.a) * (1.0 - gShade);
  reflectedLight.directDiffuse += tLight * thru * (transmit * RECIPROCAL_PI);
  // warm light bounced off the facing page into the gutter, more where the sheet curls away from view
  float curlLift = pow(clamp(1.0 - abs(dot(tN, geometryViewDir)), 0.0, 1.0), 1.5);
  float gFall = pow(1.0 - smoothstep(0.0, 0.23, sc), 0.85);
  reflectedLight.indirectDiffuse += (reflectedLight.directDiffuse + reflectedLight.indirectDiffuse) * vec3(1.0, 0.96, 0.92) * gFall * (0.8 + 0.6 * curlLift) * 0.16;
}`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
  // grain, coloured and mostly in the shadows
  vec2 gc = gl_FragCoord.xy;
  vec3 grain = vec3(folioHash(gc), folioHash(gc + 17.31), folioHash(gc + 41.77)) - 0.5;
  float gLum = dot(outgoingLight, vec3(0.2126, 0.7152, 0.0722));
  outgoingLight += grain * (0.3 + 0.7 * (1.0 - smoothstep(0.3, 1.2, gLum))) * 0.04;
}
#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'folio-paper-2';
  return mat;
}

// ------------------------------------------------------------------ leaf
const chainX = new Float32Array(NC + 1);
const chainZ = new Float32Array(NC + 1);
const chainTX = new Float32Array(NC + 1);
const chainTZ = new Float32Array(NC + 1);
let rollAlong = new Float32Array(512);
let rollOut = new Float32Array(512);

export class Leaf {
  constructor(material) {
    const nv = (NX + 1) * (NY + 1);
    this.pos = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const idx = [];
    for (let j = 0; j <= NY; j++)
      for (let i = 0; i <= NX; i++) {
        const k = j * (NX + 1) + i;
        uv[k * 2] = i / NX;
        uv[k * 2 + 1] = j / NY;
      }
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const a = j * (NX + 1) + i;
        const b = a + 1;
        const c = a + NX + 1;
        const d = c + 1;
        idx.push(a, b, d, a, d, c);
      }
    const g = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(this.pos, 3);
    pa.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa);
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    g.setIndex(idx);
    this.geometry = g;
    this.material = material;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.userData.leaf = this;

    this.k = -1; // leaf index in the book
    this.t = 0; // 0 resting right … 1 resting left
    this.bend = 0; // + tip leads the turn, − tip trails
    this.eps = 0.01; // layer lift above the stack
    this.curl = { amount: 0, power: 0.86, span: 32.4, angle: 0, pivotU: 0.74, pivotV: 0.5 };
    this.sig = '';
  }

  setPages(front, back, inkFront, inkBack) {
    const u = this.material.userData.u;
    u.mapFront.value = front || blankWhite;
    u.mapBack.value = back || blankWhite;
    u.inkFront.value = inkFront || clearInk;
    u.inkBack.value = inkBack || clearInk;
  }

  /** Recompute the sheet. env: { Wp, Hp, tabR, tabL } */
  deform(env, force = false) {
    const c = this.curl;
    const sig = `${this.t.toFixed(5)}|${this.bend.toFixed(4)}|${this.eps}|${c.amount.toFixed(4)}|${c.angle.toFixed(4)}|${c.pivotU}|${c.pivotV}|${env.tabR.h.toFixed(5)}|${env.tabR.o.toFixed(4)}|${env.tabL.h.toFixed(5)}`;
    if (!force && sig === this.sig) return false;
    this.sig = sig;
    this.material.userData.u.turnLift.value = Math.sin(Math.PI * Math.min(1, Math.max(0, this.t)));
    const { Wp, Hp, tabR, tabL } = env;
    const t = this.t;
    const ds = Wp / NC;
    let x = 0;
    let z = (1 - t) * tabR.prof(0) + t * tabL.prof(0) + this.eps;
    chainX[0] = x;
    chainZ[0] = z;
    for (let i = 0; i < NC; i++) {
      const s = (i + 0.5) / NC;
      let a = (1 - t) * tabR.ang[i] + t * (Math.PI - tabL.ang[i]);
      a += this.bend * Math.pow(s, 1.6);
      x += ds * Math.cos(a);
      z += ds * Math.sin(a);
      const floor = (x >= 0 ? tabR.prof(x) : tabL.prof(-x)) + this.eps;
      if (z < floor) z = floor;
      chainX[i + 1] = x;
      chainZ[i + 1] = z;
    }
    for (let i = 0; i <= NC; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(NC, i + 1);
      let tx = chainX[b] - chainX[a];
      let tz = chainZ[b] - chainZ[a];
      const l = Math.hypot(tx, tz) || 1;
      chainTX[i] = tx / l;
      chainTZ[i] = tz / l;
    }
    const lift = t < 0.5 ? 1 : -1;

    // roll table
    const curling = c.amount > 0.002;
    let step = 1;
    let dxr = 1;
    let dyr = 0;
    let px = 0;
    let py = 0;
    if (curling) {
      step = c.span / 64;
      const maxXi = Math.hypot(Wp, Hp) + step * 2;
      const n = Math.ceil(maxXi / step) + 2;
      if (rollAlong.length < n + 1) {
        rollAlong = new Float32Array(n + 1);
        rollOut = new Float32Array(n + 1);
      }
      rollAlong[0] = 0;
      rollOut[0] = 0;
      for (let k = 1; k <= n; k++) {
        const sm = (k - 0.5) * step;
        const a = Math.min(c.amount * Math.pow(sm / c.span, c.power), Math.PI);
        rollAlong[k] = rollAlong[k - 1] + Math.cos(a) * step;
        rollOut[k] = rollOut[k - 1] + Math.sin(a) * step;
      }
      dxr = Math.cos(c.angle);
      dyr = Math.sin(c.angle);
      px = c.pivotU * Wp;
      py = (c.pivotV - 0.5) * Hp;
    }

    const P = this.pos;
    let v = 0;
    for (let j = 0; j <= NY; j++) {
      const y0 = (j / NY - 0.5) * Hp;
      for (let i = 0; i <= NX; i++) {
        const x0 = (i / NX) * Wp;
        let xl = x0;
        let yl = y0;
        let out = 0;
        if (curling) {
          const xi = (x0 - px) * dxr + (y0 - py) * dyr;
          if (xi > 0) {
            const f = xi / step;
            const k0 = Math.floor(f);
            const fr = f - k0;
            const along = rollAlong[k0] + (rollAlong[k0 + 1] - rollAlong[k0]) * fr;
            out = rollOut[k0] + (rollOut[k0 + 1] - rollOut[k0]) * fr;
            xl = x0 + dxr * (along - xi);
            yl = y0 + dyr * (along - xi);
          }
        }
        // base chain at xl
        let f = (xl / Wp) * NC;
        if (f < 0) f = 0;
        if (f > NC) f = NC;
        const i0 = Math.min(NC - 1, Math.floor(f));
        const fr = f - i0;
        const bx = chainX[i0] + (chainX[i0 + 1] - chainX[i0]) * fr;
        const bz = chainZ[i0] + (chainZ[i0 + 1] - chainZ[i0]) * fr;
        const tx = chainTX[i0] + (chainTX[i0 + 1] - chainTX[i0]) * fr;
        const tz = chainTZ[i0] + (chainTZ[i0 + 1] - chainTZ[i0]) * fr;
        const nx = -tz * lift;
        const nz = tx * lift;
        P[v++] = bx + nx * out;
        P[v++] = yl;
        P[v++] = bz + nz * out;
      }
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    return true;
  }
}
