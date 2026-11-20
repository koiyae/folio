// Screen-space magnifying lens (post-process): the scene is drawn into a supersampled target and a
// fullscreen pass bulges a circle around the pointer, with a thin black/white ring.

import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uMouse;
uniform float uMag;
uniform float uRadius;
uniform float uFalloff;
uniform float uAspect;
uniform float uBarrel;
uniform float uRing;
void main() {
  vec2 c = uMouse;
  vec2 d = vUv - c;
  d.x *= uAspect;
  float dist = length(d);
  float inner = uRadius - uFalloff;
  float amt = dist < inner ? 1.0 : dist < uRadius ? 1.0 - smoothstep(0.0, 1.0, (dist - inner) / max(uFalloff, 1e-5)) : 0.0;
  float barrel = 1.0 + uBarrel * amt * dist * dist;
  float k = (1.0 - uMag * amt) * barrel;
  d.x /= uAspect;
  vec4 col = texture2D(tDiffuse, c + d * k);
  float ri = uRadius - uRing * 0.5;
  float ro = uRadius + uRing * 0.5;
  float aa = uRadius * 0.02;
  float ring = smoothstep(ri - aa, ri, dist) * (1.0 - smoothstep(ro, ro + aa, dist));
  float wi = ri + uRing * 0.7;
  float white = smoothstep(wi - aa * 0.5, wi, dist) * (1.0 - smoothstep(ro - aa * 0.5, ro, dist));
  vec3 ringCol = mix(vec3(0.0), vec3(1.0), white * 0.8);
  col.rgb = mix(col.rgb, ringCol, ring);
  col.a = max(col.a, ring);
  gl_FragColor = col;
  #include <colorspace_fragment>
}
`;

export class Magnifier {
  constructor() {
    this.enabled = false;
    this.mouse = new THREE.Vector2(0.5, 0.5);
    this.target = new THREE.Vector2(0.5, 0.5);
    this.rt = new THREE.WebGLRenderTarget(4, 4, { samples: 4, type: THREE.UnsignedByteType });
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        tDiffuse: { value: this.rt.texture },
        uMouse: { value: this.mouse },
        uMag: { value: 0.308 },
        uRadius: { value: 0.31 },
        uFalloff: { value: 0.022 },
        uAspect: { value: 1 },
        uBarrel: { value: -0.57 },
        uRing: { value: 0.006 },
      },
      depthTest: false,
      depthWrite: false,
      transparent: false,
      blending: THREE.NoBlending,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  setSize(w, h, dpr, maxTex) {
    const bw = w * dpr;
    const bh = h * dpr;
    const ss = Math.min(2, maxTex / Math.max(bw, bh));
    this.rt.setSize(Math.round(bw * ss), Math.round(bh * ss));
    this.mat.uniforms.uAspect.value = w / h;
    // radius relative to the shorter side, like the reference lens
    this.mat.uniforms.uRadius.value = w >= h ? 0.31 : 0.31 * (w / h) * 0.95;
  }

  /** Pointer position in CSS pixels. */
  point(x, y, w, h) {
    this.target.set(x / w, 1 - y / h);
  }

  update(dt) {
    const k = 1 - Math.exp(-dt * 18);
    const before = this.mouse.clone();
    this.mouse.lerp(this.target, k);
    return before.distanceToSquared(this.mouse) > 1e-9;
  }

  render(renderer, scene, camera) {
    const prevClear = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearAlpha(0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearAlpha(prevClear);
    renderer.clear();
    renderer.render(this.scene, this.cam);
  }
}
