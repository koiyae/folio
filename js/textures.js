// Procedural canvas textures: cloth weave, spines, typeset cloth covers, image covers, endpapers,
// page edges, paper. Everything is generated — no bitmap assets.

import * as THREE from 'three';
import { hash01, rng, clamp } from './anim.js';

export const FONTS = {
  serif: '"Instrument Serif", "Iowan Old Style", Georgia, serif',
  mono: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
  sans: '"Inter", -apple-system, "Helvetica Neue", Arial, sans-serif',
};

// Binding cloths, sampled from the kinds of colours seen on the reference shelf.
export const CLOTHS = [
  '#c3263c', // signal red
  '#3f434b', // slate
  '#8b8580', // warm grey
  '#4d5140', // olive
  '#d6be74', // ochre
  '#2c56a3', // cobalt
  '#6b2238', // oxblood
  '#cbb48e', // sand
  '#a8815e', // tan
  '#27282c', // ink
  '#2b3fb4', // ultramarine
  '#76726e', // stone
  '#2f4a3d', // forest
  '#d8a2b0', // rose
  '#e4e0d6', // bone
];

// ---------------------------------------------------------------- colour helpers
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function mixHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i] - v) * t));
}
function hexToHsl(hex) {
  let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** Turn an arbitrary colour into something that reads as bookcloth. */
export function clothify(hex) {
  const [h, s, l] = hexToHsl(hex);
  return hslToHex(h, clamp(s * 0.85, 0.04, 0.62), clamp(l, 0.16, 0.74));
}

/** Choose the binding look for a book. */
export function chooseLook(id, title, analysis) {
  const r = rng(hash01(id + title));
  let cloth;
  if (analysis && analysis.designed && (analysis.edge || analysis.dominant)) {
    cloth = clothify(analysis.edge || analysis.dominant);
  } else {
    cloth = CLOTHS[Math.floor(hash01(title || id, 7) * CLOTHS.length)];
  }
  const dark = luminance(cloth) < 0.3;
  const foils = dark ? ['#d9ab5f', '#e2c48a', '#f0ece2', '#e58a6a', '#9fd0c0'] : ['#1d1b19', '#7a1f2b', '#1f3b7a', '#1d1b19'];
  const accent = foils[Math.floor(r() * foils.length)];
  const ink = dark ? '#efebe2' : '#1f1d1a';
  const styles = ['serif', 'serif', 'mono', 'sans'];
  const motifs = ['rings', 'grid', 'waves', 'stack', 'orbit'];
  return {
    cloth,
    ink,
    accent,
    spineStyle: styles[Math.floor(r() * styles.length)],
    motif: motifs[Math.floor(r() * motifs.length)],
    coverMode: analysis && analysis.designed ? 'image' : 'cloth',
    endTint: mixHex('#d9d6ce', cloth, 0.12),
    endInk: mixHex('#8d877e', cloth, 0.25),
  };
}

/** Palette for the "color" theme, derived from the selected book. */
export function themePalette(look) {
  // background: the cloth, deepened; ink: the book's foil when it reads on that ground
  const [h, s] = hexToHsl(look.cloth);
  const bg = hslToHex(h, clamp(s, 0.08, 0.35), 0.17);
  const foil = look.accent && luminance(look.accent) > 0.3 ? look.accent : null;
  const fg = foil || hslToHex(h, clamp(s + 0.15, 0.25, 0.6), 0.78);
  return { bg, fg };
}

// ---------------------------------------------------------------- texture helpers
export function canvasTexture(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.needsUpdate = true;
  return t;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

let grainCanvasCache = null;
function grainCanvas() {
  if (grainCanvasCache) return grainCanvasCache;
  const c = makeCanvas(128, 128);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(128, 128);
  const r = rng(0.4242);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + r() * 55;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainCanvasCache = c;
  return c;
}

/** Overlay a fine woven texture onto a canvas (adds the cloth feel to flat colour). */
function clothOverlay(ctx, w, h, strength = 0.07) {
  const pat = ctx.createPattern(weaveColorCanvas(), 'repeat');
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = pat;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

let weaveColorCache = null;
function weaveColorCanvas() {
  if (weaveColorCache) return weaveColorCache;
  const N = 64;
  const P = 4;
  const c = makeCanvas(N, N);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(N, N);
  const r = rng(0.1337);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = (Math.floor(x / P) + Math.floor(y / P)) % 2;
      const fx = (x % P) / P;
      const fy = (y % P) / P;
      const bump = cell ? Math.sin(Math.PI * fy) : Math.sin(Math.PI * fx);
      const v = 150 + bump * 90 + r() * 15;
      const i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  weaveColorCache = c;
  return c;
}

/** Tangent-space normal map of a plain weave. */
export function makeWeaveNormalTexture() {
  const N = 128;
  const P = 4;
  const c = makeCanvas(N, N);
  const ctx = c.getContext('2d');
  const hgt = new Float32Array(N * N);
  const r = rng(0.777);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = (Math.floor(x / P) + Math.floor(y / P)) % 2;
      const fx = (x % P) / P;
      const fy = (y % P) / P;
      hgt[y * N + x] = (cell ? Math.sin(Math.PI * fy) : Math.sin(Math.PI * fx)) * 0.8 + r() * 0.2;
    }
  }
  const img = ctx.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const hL = hgt[y * N + ((x - 1 + N) % N)];
      const hR = hgt[y * N + ((x + 1) % N)];
      const hU = hgt[((y - 1 + N) % N) * N + x];
      const hD = hgt[((y + 1) % N) * N + x];
      let nx = (hL - hR) * 1.2;
      let ny = (hD - hU) * 1.2;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * N + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = canvasTexture(c, { srgb: false, repeat: [1, 1] });
  return t;
}

export function makeGrainTexture() {
  return canvasTexture(grainCanvas(), { srgb: false, repeat: [1, 1] });
}

/** Leaf edges seen from the head, tail and fore-edge: fine lines of paper. */
export function makePageEdgeTexture() {
  const c = makeCanvas(8, 256);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e3e2dc';
  ctx.fillRect(0, 0, 8, 256);
  const r = rng(0.31);
  for (let y = 0; y < 256; y += 3) {
    const a = 0.26 + r() * 0.26;
    ctx.fillStyle = `rgba(118,110,98,${a})`;
    ctx.fillRect(0, y + (r() < 0.3 ? 1 : 0), 8, 1);
    if (r() < 0.25) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(0, y + 2, 8, 1);
    }
  }
  const t = canvasTexture(c, { repeat: [1, 1] });
  t.magFilter = THREE.LinearFilter;
  return t;
}

/** A blank sheet with faint text blocks — stands in for a page while it renders, and for fanned leaves. */
export function makePaperCanvas(aspect = 0.7, seed = 0.5, lines = true) {
  const w = 256;
  const h = Math.round(w / aspect);
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fbfbf9';
  ctx.fillRect(0, 0, w, h);
  if (lines) {
    const r = rng(seed);
    ctx.fillStyle = 'rgba(40,36,30,0.10)';
    const m = w * 0.13;
    let y = h * 0.1;
    while (y < h * 0.88) {
      if (r() < 0.12) {
        y += 9;
        continue;
      }
      const len = (w - 2 * m) * (r() < 0.15 ? 0.3 + r() * 0.5 : 0.92 + r() * 0.08);
      ctx.fillRect(m, y, len, 2.2);
      y += 6.2;
    }
  }
  return c;
}

// ---------------------------------------------------------------- endpaper
export function makeEndpaperTexture(look) {
  const N = 512;
  const cell = 64;
  const c = makeCanvas(N, N);
  const ctx = c.getContext('2d');
  ctx.fillStyle = look.endTint || '#d9d6ce';
  ctx.fillRect(0, 0, N, N);
  const r = rng(hash01(look.cloth, 3));
  ctx.strokeStyle = look.endInk || '#8d877e';
  ctx.lineCap = 'butt';
  const radii = [cell * 0.18, cell * 0.5, cell * 0.82];
  for (let gy = 0; gy < N / cell; gy++) {
    for (let gx = 0; gx < N / cell; gx++) {
      const x = gx * cell;
      const y = gy * cell;
      const flip = r() < 0.5;
      ctx.lineWidth = 3.2;
      for (const rad of radii) {
        ctx.beginPath();
        if (flip) {
          ctx.arc(x, y, rad, 0, Math.PI / 2);
          ctx.moveTo(x + cell - rad, y + cell);
          ctx.arc(x + cell, y + cell, rad, Math.PI, Math.PI * 1.5);
        } else {
          ctx.arc(x + cell, y, rad, Math.PI / 2, Math.PI);
          ctx.moveTo(x + rad, y + cell);
          ctx.arc(x, y + cell, rad, 0, -Math.PI / 2, true);
        }
        ctx.stroke();
      }
    }
  }
  clothOverlay(ctx, N, N, 0.05);
  return canvasTexture(c, { repeat: [1, 1] });
}

// ---------------------------------------------------------------- text helpers
function drawSpaced(ctx, text, x, y, spacing) {
  if (!spacing) {
    ctx.fillText(text, x, y);
    return;
  }
  // assumes textAlign = 'left'
  let cx = x;
  for (const ch of text) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}
function spacedWidth(ctx, text, spacing) {
  if (!spacing) return ctx.measureText(text).width;
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return w - spacing;
}
function wrapLines(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function ellipsize(ctx, text, maxW, spacing = 0) {
  if (spacedWidth(ctx, text, spacing) <= maxW) return text;
  let t = text;
  while (t.length > 1 && spacedWidth(ctx, t + '…', spacing) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/** Small library mark: two leaning spines in a rounded frame. */
function drawMark(ctx, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.2, size * 0.075);
  const s = size / 2;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.stroke();
  // open-book glyph
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.36);
  ctx.quadraticCurveTo(-s * 0.32, -s * 0.5, -s * 0.58, -s * 0.36);
  ctx.lineTo(-s * 0.58, s * 0.36);
  ctx.quadraticCurveTo(-s * 0.32, s * 0.22, 0, s * 0.38);
  ctx.quadraticCurveTo(s * 0.32, s * 0.22, s * 0.58, s * 0.36);
  ctx.lineTo(s * 0.58, -s * 0.36);
  ctx.quadraticCurveTo(s * 0.32, -s * 0.5, 0, -s * 0.36);
  ctx.lineTo(0, s * 0.38);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------- spine
export function makeSpineCanvas(meta, look, spineWorldW, spineWorldH) {
  const H = 1024;
  const W = Math.max(72, Math.round((H * spineWorldW) / spineWorldH));
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = look.cloth;
  ctx.fillRect(0, 0, W, H);
  // gentle highlight down the middle of the rounded spine
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.10)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0.10)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  clothOverlay(ctx, W, H, 0.08);

  const inkCol = look.ink;
  const titleCol = look.spineStyle === 'serif' && luminance(look.cloth) < 0.3 ? look.accent : inkCol;
  const markSize = Math.min(W * 0.42, 44);
  const markY = H - markSize * 1.6;
  drawMark(ctx, W / 2, markY, markSize, titleCol);

  const title = (meta.title || 'Untitled').trim();
  const author = (meta.author || '').trim();
  const style = look.spineStyle;

  ctx.save();
  ctx.translate(W / 2, 0);
  ctx.rotate(Math.PI / 2);
  // rotated space: x runs down the spine (0 → H), y runs across (−W/2 … W/2), letter tops face +canvas-x
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const top = H * 0.055;
  const bottom = markY - markSize * 1.1;
  let cursor = top;

  // author
  if (author) {
    const aSize = Math.min(W * 0.2, 24);
    let spacing = 0;
    if (style === 'mono') {
      ctx.font = `400 ${aSize * 0.92}px ${FONTS.mono}`;
      spacing = aSize * 0.06;
    } else if (style === 'sans') {
      ctx.font = `500 ${aSize * 0.9}px ${FONTS.sans}`;
      spacing = aSize * 0.04;
    } else ctx.font = `italic 400 ${aSize * 1.08}px ${FONTS.serif}`;
    ctx.fillStyle = inkCol;
    const txt = ellipsize(ctx, style === 'serif' ? author : author.toUpperCase(), H * 0.26, spacing);
    drawSpaced(ctx, txt, cursor, 0, spacing);
    cursor += spacedWidth(ctx, txt, spacing) + H * 0.05;
  }

  // title
  const avail = bottom - cursor;
  const maxSize = W * (style === 'sans' ? 0.42 : 0.5);
  let size = maxSize;
  let spacing = 0;
  const setFont = (sz) => {
    if (style === 'mono') {
      ctx.font = `400 ${sz * 0.82}px ${FONTS.mono}`;
      spacing = sz * 0.08;
    } else if (style === 'sans') {
      ctx.font = `500 ${sz * 0.9}px ${FONTS.sans}`;
      spacing = sz * 0.06;
    } else {
      ctx.font = `400 ${sz}px ${FONTS.serif}`;
      spacing = 0;
    }
  };
  const tText = style === 'serif' ? title : title.toUpperCase();
  setFont(size);
  let w = spacedWidth(ctx, tText, spacing);
  if (w > avail) {
    size = Math.max(W * 0.22, size * (avail / w));
    setFont(size);
    w = spacedWidth(ctx, tText, spacing);
  }
  ctx.fillStyle = titleCol;
  if (w <= avail) {
    // centre the title in the remaining run
    const x0 = cursor + (avail - w) / 2;
    drawSpaced(ctx, tText, x0, 0, spacing);
  } else {
    // two lines, or ellipsis on very thin spines
    const twoLines = W > 90 && /\s/.test(tText);
    if (twoLines) {
      const sz2 = Math.min(maxSize * 0.62, W * 0.3);
      setFont(sz2);
      const words = tText.split(/\s+/);
      let best = 1;
      let bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) {
        const a = words.slice(0, i).join(' ');
        const b = words.slice(i).join(' ');
        const d = Math.abs(spacedWidth(ctx, a, spacing) - spacedWidth(ctx, b, spacing));
        if (d < bestDiff) {
          bestDiff = d;
          best = i;
        }
      }
      const l1 = ellipsize(ctx, words.slice(0, best).join(' '), avail, spacing);
      const l2 = ellipsize(ctx, words.slice(best).join(' '), avail, spacing);
      const lh = sz2 * 1.05;
      drawSpaced(ctx, l1, cursor + (avail - spacedWidth(ctx, l1, spacing)) / 2, -lh / 2, spacing);
      drawSpaced(ctx, l2, cursor + (avail - spacedWidth(ctx, l2, spacing)) / 2, lh / 2, spacing);
    } else {
      const t = ellipsize(ctx, tText, avail, spacing);
      drawSpaced(ctx, t, cursor + (avail - spacedWidth(ctx, t, spacing)) / 2, 0, spacing);
    }
  }
  ctx.restore();
  return c;
}

// ---------------------------------------------------------------- covers
function hingeGroove(ctx, W, H) {
  // the crease a few millimetres in from the spine on a case binding
  const x = W * 0.045;
  const g = ctx.createLinearGradient(x - W * 0.02, 0, x + W * 0.025, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.45, 'rgba(0,0,0,0.16)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W * 0.09, H);
}

function drawMotif(ctx, look, W, H, seed) {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = look.accent;
  ctx.fillStyle = look.accent;
  const cx = W * 0.5;
  const cy = H * 0.55;
  switch (look.motif) {
    case 'rings': {
      ctx.lineWidth = Math.max(1.5, W * 0.0035);
      const n = 7 + Math.floor(r() * 5);
      for (let i = 0; i < n; i++) {
        const rad = W * (0.06 + i * 0.026);
        ctx.beginPath();
        ctx.arc(cx + (i - n / 2) * W * 0.008, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
      break;
    }
    case 'grid': {
      const cols = 9;
      const rows = 13;
      const gap = W * 0.042;
      const ox = cx - ((cols - 1) * gap) / 2;
      const oy = cy - ((rows - 1) * gap) / 2;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const big = r() < 0.12;
          if (r() < 0.08) continue;
          ctx.beginPath();
          ctx.arc(ox + x * gap, oy + y * gap, big ? W * 0.009 : W * 0.0035, 0, Math.PI * 2);
          ctx.fill();
        }
      break;
    }
    case 'waves': {
      ctx.lineWidth = Math.max(1.5, W * 0.003);
      const n = 16;
      const amp = W * 0.02 + r() * W * 0.02;
      const freq = 2 + r() * 2;
      for (let i = 0; i < n; i++) {
        const y = H * 0.36 + i * H * 0.022;
        ctx.beginPath();
        for (let x = W * 0.16; x <= W * 0.84; x += 4) {
          const yy = y + Math.sin((x / W) * Math.PI * freq + i * 0.35) * amp * Math.sin((x / W) * Math.PI);
          if (x === W * 0.16) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      break;
    }
    case 'stack': {
      const n = 14;
      const h = H * 0.011;
      for (let i = 0; i < n; i++) {
        const len = W * (0.2 + r() * 0.42);
        const x = cx - len / 2 + (r() - 0.5) * W * 0.06;
        ctx.fillRect(x, H * 0.4 + i * h * 2.1, len, h);
      }
      break;
    }
    default: {
      // orbit: dots on an ellipse with a centre
      ctx.lineWidth = Math.max(1.2, W * 0.0028);
      ctx.beginPath();
      ctx.ellipse(cx, cy, W * 0.26, W * 0.1, -0.35, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(cx, cy, W * 0.16, W * 0.27, 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, W * 0.025, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/** A typeset cloth cover for PDFs whose first page is not a designed cover. */
export function makeClothCoverCanvas(meta, look, aspect /* W/H of the board */) {
  const W = 768;
  const H = Math.round(W / aspect);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.fillStyle = look.cloth;
  ctx.fillRect(0, 0, W, H);
  clothOverlay(ctx, W, H, 0.09);
  const title = (meta.title || 'Untitled').trim();
  const author = (meta.author || '').trim();
  const m = W * 0.1;
  const titleCol = luminance(look.cloth) < 0.3 ? look.accent : look.ink;

  // title block, top-left
  ctx.fillStyle = titleCol;
  ctx.textBaseline = 'alphabetic';
  let size = W * 0.074;
  ctx.font = `400 ${size}px ${FONTS.serif}`;
  let lines = wrapLines(ctx, title, W * 0.56);
  while (lines.length > 5 && size > W * 0.045) {
    size *= 0.9;
    ctx.font = `400 ${size}px ${FONTS.serif}`;
    lines = wrapLines(ctx, title, W * 0.6);
  }
  lines = lines.slice(0, 6);
  let y = m + size;
  for (const l of lines) {
    ctx.fillText(l, m, y);
    y += size * 1.02;
  }
  ctx.fillRect(m, y - size * 0.45, W * 0.07, Math.max(2, W * 0.003));

  drawMotif(ctx, look, W, H, hash01(title, 11));

  // author, bottom-left
  if (author) {
    ctx.fillStyle = titleCol;
    ctx.font = `italic 400 ${W * 0.05}px ${FONTS.serif}`;
    const al = wrapLines(ctx, author, W * 0.6).slice(0, 2);
    let ay = H - m - (al.length - 1) * W * 0.055;
    for (const l of al) {
      ctx.fillText(l, m, ay);
      ay += W * 0.055;
    }
  }
  // corner mark
  drawMark(ctx, W - m * 0.95, m * 0.95, W * 0.07, titleCol);
  hingeGroove(ctx, W, H);
  return c;
}

/** Cover from the PDF's own first page (cover-fit onto the board). */
export function makeImageCoverCanvas(image, aspect) {
  const W = 768;
  const H = Math.round(W / aspect);
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  const iw = image.width;
  const ih = image.height;
  const s = Math.max(W / iw, H / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(image, (W - dw) / 2, (H - dh) / 2, dw, dh);
  clothOverlay(ctx, W, H, 0.05);
  hingeGroove(ctx, W, H);
  return c;
}
