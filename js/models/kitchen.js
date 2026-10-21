// Cocina mediterránea procedural: habitación, isla, mueble del fondo, columna del horno,
// nevera retro, estantes con tarros, ventana con paisaje, lámparas y ajuste de las luces.
// Todo se construye en código. Las piezas estáticas se agrupan por material y se fusionan
// en una sola malla por material (clase Batch); lo repetido usa InstancedMesh.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ROOM, COUNTER, BACK_RUN, WINDOW, OVEN, FRIDGE } from '../core/layout.js';
import { clamp, damp, makeRng, makeCanvasTexture } from '../core/utils.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

// --- Medidas propias de la cocina (las compartidas vienen de layout.js) ---
const TOP = COUNTER.topY;                 // 0.92: encimeras
const BACK = ROOM.backZ;                  // cara interior del muro del fondo
const WALL_T = 0.24;                      // muro grueso: ventana con alféizar profundo
const PLINTH = 0.1;                       // altura del zócalo
const FRONT_T = 0.02;                     // grosor de puertas y cajones
const SHELF = { y: [1.5, 1.88], t: 0.035, d: 0.24 };
const SHELF_L = [-2.8, -1.62];
const SHELF_R = [0.56, OVEN.column.minX];
const CLOCK_POS = new V3(0.29, 1.86, BACK);
const PENDANT_X = [-0.86, 0, 0.86];
const PENDANT_Y = 1.9;                    // borde inferior de las pantallas
const SHADE_R = 0.15;                     // radio de las pantallas
const SINK = { x0: -1.08, x1: -0.32, z0: -1.53, z1: -0.965 };
const HOB = { x: 0.95, z: -1.3 };
const WIN = {
  x0: WINDOW.centerX - WINDOW.width / 2, x1: WINDOW.centerX + WINDOW.width / 2,
  y0: WINDOW.centerY - WINDOW.height / 2, y1: WINDOW.centerY + WINDOW.height / 2,
};
const BACKDROP = { x0: -4.2, w: 7, y0: -0.6, h: 4.2, z: -3.2 };
const FLOOR_HEX = 0.115;                  // radio de las baldosas hexagonales
const TO_SUN = new V3(-0.36, 0.36, -0.86).normalize(); // hacia el sol: mañana, entra por la ventana
const SIZES_TEX = { plaster: 1.6, oak: 1.1, stone: 0.9 };

const COLORS = {
  sage: 0x93a487, teal: 0x2d5b58, brass: 0xd9ae64, steel: 0xe2e4e7, copper: 0xdc8c5e,
  iron: 0x22201e, dark: 0x15120f, fridge: 0xf2e3bf, enamel: 0xf5efe3, porcelain: 0xf7f3ec,
  terracotta: 0xc8754c, soil: 0x3a2a1f, straw: 0xd8b56c, bark: 0x7a6a58,
};

// ---------------------------------------------------------------------------
// Utilidades de geometría
// ---------------------------------------------------------------------------
const _p = new V3(), _s = new V3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _c = new THREE.Color();

/** Matriz a partir de posición, rotación XYZ (radianes) y escala. */
function M(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  return new THREE.Matrix4().compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}
const mul = (a, b) => new THREE.Matrix4().multiplyMatrices(a, b);

const KEEP_ATTR = new Set(['position', 'normal', 'uv', 'color']);

/**
 * Acumula geometrías estáticas por clave de material y al final crea una malla fusionada por
 * clave (una llamada de dibujo por material). Cada pieza lleva color por vértice.
 */
class Batch {
  constructor() { this.parts = new Map(); }

  add(key, geo, matrix = null, { color = 0xffffff, uv = null } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    for (const name of Object.keys(g.attributes)) if (!KEEP_ATTR.has(name)) g.deleteAttribute(name);
    const n = g.attributes.position.count;
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    if (uv) uv(g);
    _c.set(color);
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.clearGroups();
    g.morphAttributes = {};
    if (!this.parts.has(key)) this.parts.set(key, []);
    this.parts.get(key).push(g);
  }

  build(materials, parent, { noCast, noReceive }) {
    for (const [key, list] of this.parts) {
      const geo = mergeGeometries(list, false);
      list.forEach((g) => g.dispose());
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, materials[key]);
      mesh.name = `kitchen-${key}`;
      mesh.castShadow = !noCast.has(key);
      mesh.receiveShadow = !noReceive.has(key);
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
    }
    this.parts.clear();
  }
}

/** UV planares según la normal dominante de cada triángulo, en metros / tamaño de textura. */
function boxUV(su = 1, sv = su) {
  return (g) => {
    const p = g.attributes.position.array, uv = g.attributes.uv.array;
    for (let i = 0, nt = p.length / 9; i < nt; i++) {
      const o = i * 9;
      const ax = p[o + 3] - p[o], ay = p[o + 4] - p[o + 1], az = p[o + 5] - p[o + 2];
      const bx = p[o + 6] - p[o], by = p[o + 7] - p[o + 1], bz = p[o + 8] - p[o + 2];
      const nx = Math.abs(ay * bz - az * by), ny = Math.abs(az * bx - ax * bz), nz = Math.abs(ax * by - ay * bx);
      for (let k = 0; k < 3; k++) {
        const x = p[o + k * 3], y = p[o + k * 3 + 1], z = p[o + k * 3 + 2], t = (i * 3 + k) * 2;
        if (ny >= nx && ny >= nz) { uv[t] = x / su; uv[t + 1] = -z / sv; }
        else if (nx >= nz) { uv[t] = z / su; uv[t + 1] = y / sv; }
        else { uv[t] = x / su; uv[t + 1] = y / sv; }
      }
    }
  };
}

/** Remapea las UV (0..1) de una geometría a un rectángulo [u0,v0]-[u1,v1] de un atlas. */
function atlasUV(u0, v0, u1, v1) {
  return (g) => {
    const uv = g.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = u0 + uv[i] * (u1 - u0);
      uv[i + 1] = v0 + uv[i + 1] * (v1 - v0);
    }
  };
}

/** Perfil de torno [r, y] → LatheGeometry. */
const lathe = (pts, seg = 24) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);

/** Rectángulo redondeado centrado (Shape o Path). */
function roundRect(w, h, r, path = new THREE.Shape()) {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y); path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r); path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h); path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r); path.quadraticCurveTo(x, y, x + r, y);
  return path;
}

/** Añade una caja definida por sus límites (x0..x1, y0..y1, z0..z1). */
function addBox(B, key, x0, x1, y0, y1, z0, z1, opts) {
  B.add(key, new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), M((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), opts);
}
/** Tubo entre puntos (CatmullRom). */
function tube(points, radius, seg = 24, radial = 6) {
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map((p) => new V3(...p))), seg, radius, radial, false);
}

// ---------------------------------------------------------------------------
// Texturas procedurales (canvas)
// ---------------------------------------------------------------------------
const smooth = (t) => t * t * (3 - 2 * t);

/** Ruido de valor periódico (enlosable) de w×h, valores 0..1. */
function tileNoise(w, h, cx, cy, octaves, seed) {
  const rng = makeRng(seed);
  const out = new Float32Array(w * h);
  let amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const nx = cx << o, ny = cy << o;
    const lat = new Float32Array(nx * ny);
    for (let i = 0; i < lat.length; i++) lat[i] = rng();
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * ny, y0 = Math.floor(fy), ty = smooth(fy - y0);
      const r0 = (y0 % ny) * nx, r1 = ((y0 + 1) % ny) * nx;
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * nx, x0 = Math.floor(fx), tx = smooth(fx - x0), x1 = (x0 + 1) % nx;
        const a = lat[r0 + x0] + (lat[r0 + x1] - lat[r0 + x0]) * tx;
        const b = lat[r1 + x0] + (lat[r1 + x1] - lat[r1 + x0]) * tx;
        out[y * w + x] += (a + (b - a) * ty) * amp;
      }
    }
    norm += amp; amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Rellena el canvas píxel a píxel: fn(i, rgb) escribe el color del píxel i. */
function putPixels(ctx, w, h, fn) {
  const img = ctx.createImageData(w, h), d = img.data, rgb = [0, 0, 0];
  for (let i = 0, n = w * h; i < n; i++) {
    fn(i, rgb);
    d[i * 4] = rgb[0]; d[i * 4 + 1] = rgb[1]; d[i * 4 + 2] = rgb[2]; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

const rgba = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;

/** Línea ondulada horizontal (vetas de madera). */
function wavyLine(c, x0, x1, y, amp, freq, phase, step = 12) {
  c.beginPath();
  c.moveTo(x0, y + Math.sin(x0 * freq + phase) * amp);
  for (let x = x0 + step; x <= x1 + step; x += step) {
    c.lineTo(x, y + Math.sin(x * freq + phase) * amp + Math.sin(x * freq * 2.7 + phase * 1.3) * amp * 0.35);
  }
  c.stroke();
}

function plasterTextures() {
  const S = 512, n1 = tileNoise(S, S, 4, 4, 5, 11), n2 = tileNoise(S, S, 64, 64, 2, 12);
  const opts = { repeat: [1, 1] };
  const map = makeCanvasTexture(S, S, (c) => putPixels(c, S, S, (i, o) => {
    const v = (n1[i] - 0.5) * 20 + (n2[i] - 0.5) * 8;
    o[0] = 236 + v; o[1] = 224 + v; o[2] = 204 + v * 1.15;
  }), opts);
  const bump = makeCanvasTexture(S, S, (c) => putPixels(c, S, S, (i, o) => {
    o[0] = o[1] = o[2] = 128 + (n1[i] - 0.5) * 80 + (n2[i] - 0.5) * 120;
  }), { ...opts, srgb: false });
  return { map, bump };
}

function floorTextures() {
  const s = FLOOR_HEX, nI = 8, nJ = 7, sq3 = Math.sqrt(3);
  const Wt = 1.5 * s * nI, Ht = sq3 * s * nJ;
  const rng = makeRng(5);
  const tiles = [];
  for (let i = 0; i < nI; i++) {
    for (let j = 0; j < nJ; j++) {
      tiles.push({ x: 1.5 * s * i, y: sq3 * s * (j + (i % 2) * 0.5), tone: rng(), wear: rng(), seed: (rng() * 1e9) | 0 });
    }
  }
  const palette = [[178, 104, 72], [164, 94, 64], [190, 120, 84], [152, 88, 62], [196, 132, 96], [172, 110, 78], [140, 82, 58]];
  const hexPath = (c, cx, cy, r, ky) => {
    c.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      c[k ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a) * ky);
    }
    c.closePath();
  };
  const draw = (mode) => (c, w, h) => {
    const kx = w / Wt, ky = h / Ht, r = (s - 0.0055) * kx, ar = ky / kx;
    c.fillStyle = mode === 'color' ? '#c2ae92' : mode === 'rough' ? '#ececec' : '#2a2a2a';
    c.fillRect(0, 0, w, h);
    for (const t of tiles) {
      for (const ox of [-Wt, 0, Wt]) {
        for (const oy of [-Ht, 0, Ht]) {
          const cx = (t.x + ox) * kx, cy = (t.y + oy) * ky;
          if (cx < -r * 1.2 || cx > w + r * 1.2 || cy < -r * 1.2 || cy > h + r * 1.2) continue;
          const tr = makeRng(t.seed);
          c.save();
          hexPath(c, cx, cy, r, ar);
          if (mode === 'color') {
            const a = palette[(t.tone * palette.length) | 0], j = (tr() - 0.5) * 14;
            const g = c.createRadialGradient(cx - r * 0.2, cy - r * 0.25, r * 0.1, cx, cy, r * 1.05);
            g.addColorStop(0, rgba(a[0] + 10 + j, a[1] + 8 + j, a[2] + 6 + j));
            g.addColorStop(1, rgba(a[0] - 16 + j, a[1] - 12 + j, a[2] - 8 + j));
            c.fillStyle = g; c.fill(); c.clip();
            for (let k = 0; k < 18; k++) { // manchas de cocción
              const dark = tr() < 0.55;
              c.fillStyle = dark ? rgba(90, 40, 20, 0.05 + tr() * 0.08) : rgba(240, 190, 140, 0.05 + tr() * 0.07);
              c.beginPath();
              c.ellipse(cx + (tr() - 0.5) * r * 1.8, cy + (tr() - 0.5) * r * 1.8, r * (0.1 + tr() * 0.35), r * (0.06 + tr() * 0.2), tr() * 3, 0, TAU);
              c.fill();
            }
            if (t.wear > 0.6) { // velo de cal
              c.fillStyle = rgba(245, 230, 210, 0.08 + tr() * 0.08);
              c.beginPath(); c.ellipse(cx + (tr() - 0.5) * r, cy + (tr() - 0.5) * r, r * 0.6, r * 0.3, tr() * 3, 0, TAU); c.fill();
            }
            for (let k = 0; k < 10; k++) {
              c.fillStyle = rgba(250, 235, 215, 0.35);
              c.fillRect(cx + (tr() - 0.5) * r * 1.6, cy + (tr() - 0.5) * r * 1.6, 1.2, 1.2);
            }
            c.lineWidth = r * 0.07; c.strokeStyle = rgba(110, 50, 25, 0.25); // canto gastado
            hexPath(c, cx, cy, r, ar); c.stroke();
          } else if (mode === 'rough') {
            const g0 = 120 + t.wear * 40;
            c.fillStyle = rgba(g0, g0, g0);
            c.fill(); c.clip();
            for (let k = 0; k < 10; k++) {
              const v = 100 + tr() * 90;
              c.fillStyle = rgba(v, v, v, 0.35);
              c.beginPath(); c.ellipse(cx + (tr() - 0.5) * r * 1.6, cy + (tr() - 0.5) * r * 1.6, r * 0.3, r * 0.18, tr() * 3, 0, TAU); c.fill();
            }
          } else {
            const g = c.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
            g.addColorStop(0, '#d8d8d8'); g.addColorStop(1, '#8a8a8a');
            c.fillStyle = g; c.fill(); c.clip();
            for (let k = 0; k < 14; k++) {
              const v = 150 + tr() * 100;
              c.fillStyle = rgba(v, v, v, 0.3);
              c.beginPath(); c.arc(cx + (tr() - 0.5) * r * 1.6, cy + (tr() - 0.5) * r * 1.6, r * (0.04 + tr() * 0.12), 0, TAU); c.fill();
            }
          }
          c.restore();
        }
      }
    }
  };
  const o = { repeat: [1, 1], anisotropy: 8 };
  return {
    size: [Wt, Ht],
    map: makeCanvasTexture(1024, 1024, draw('color'), o),
    rough: makeCanvasTexture(512, 512, draw('rough'), { ...o, srgb: false }),
    bump: makeCanvasTexture(512, 512, draw('bump'), { ...o, srgb: false }),
  };
}

/**
 * Encimera de taco de roble (canto): listones estrechos a lo largo de X, tramos con empalmes
 * dentados, vetas finas y motas. La textura cubre toda la cara superior (1024² sobre 2.6 × 0.9 m).
 */
function butcherTextures() {
  const W = 1024, H = 1024, N = 30, rng = makeRng(21);
  const tones = [[186, 132, 82], [170, 118, 72], [200, 148, 96], [158, 108, 66], [192, 140, 88], [176, 124, 76], [208, 158, 106], [164, 114, 70]];
  const strips = [];
  for (let i = 0; i < N; i++) {
    const segs = [];
    for (let x = -rng() * 260; x < W;) {
      const len = 110 + rng() * 210;
      segs.push({ x, len, tone: tones[(rng() * tones.length) | 0], j: (rng() - 0.5) * 14, seed: (rng() * 1e9) | 0 });
      x += len;
    }
    strips.push(segs);
  }
  const map = makeCanvasTexture(W, H, (c) => {
    const sh = H / N;
    strips.forEach((segs, i) => {
      const y0 = i * sh;
      for (const s of segs) {
        const r = makeRng(s.seed), [cr, cg, cb] = s.tone, j = s.j;
        c.fillStyle = rgba(cr + j, cg + j * 0.9, cb + j * 0.7);
        c.fillRect(s.x, y0, s.len, sh);
        c.save(); c.beginPath(); c.rect(s.x, y0, s.len, sh); c.clip();
        for (let k = 0; k < 3; k++) { // bandas de madera tardía
          c.strokeStyle = rgba(120, 70, 30, 0.08 + r() * 0.08); c.lineWidth = 2 + r() * 4;
          wavyLine(c, s.x - 10, s.x + s.len + 10, y0 + r() * sh, 0.5 + r() * 2, 0.008 + r() * 0.01, r() * 10, 10);
        }
        for (let k = 0; k < 22; k++) { // vetas finas
          c.strokeStyle = rgba(86, 46, 18, 0.07 + r() * 0.18); c.lineWidth = 0.5 + r() * 0.9;
          wavyLine(c, s.x - 10, s.x + s.len + 10, y0 + r() * sh, 0.2 + r() * 0.9, 0.01 + r() * 0.02, r() * 10, 8);
        }
        for (let k = 0; k < 6; k++) { // motas claras del roble
          c.fillStyle = rgba(255, 226, 180, 0.14 + r() * 0.12);
          c.beginPath(); c.ellipse(s.x + r() * s.len, y0 + r() * sh, 3 + r() * 8, 0.6 + r() * 0.8, 0, 0, TAU); c.fill();
        }
        const g = c.createLinearGradient(0, y0, 0, y0 + sh); // canto ligeramente sombreado
        g.addColorStop(0, 'rgba(60,30,10,0.16)'); g.addColorStop(0.2, 'rgba(0,0,0,0)'); g.addColorStop(0.85, 'rgba(255,235,200,0.05)'); g.addColorStop(1, 'rgba(60,30,10,0.18)');
        c.fillStyle = g; c.fillRect(s.x, y0, s.len, sh);
        c.restore();
        c.strokeStyle = 'rgba(80,44,18,0.2)'; c.lineWidth = 0.8; // empalme dentado
        c.beginPath();
        for (let t = 0; t <= 6; t++) c.lineTo(s.x + (t % 2 ? 1.6 : -1.6), y0 + (t / 6) * sh);
        c.stroke();
      }
      c.fillStyle = 'rgba(70,38,14,0.4)'; c.fillRect(0, y0, W, 1); // línea de cola
    });
    for (let k = 0; k < 40; k++) { // pátina de uso (zonas más oscuras y aceitadas)
      const x = rng() * W, y = rng() * H, rr = 40 + rng() * 120;
      const g = c.createRadialGradient(x, y, 0, x, y, rr);
      g.addColorStop(0, rgba(90, 50, 20, 0.05)); g.addColorStop(1, 'rgba(90,50,20,0)');
      c.fillStyle = g; c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    for (let k = 0; k < 120; k++) { // marcas de cuchillo muy suaves
      c.strokeStyle = rgba(255, 236, 210, 0.05 + rng() * 0.06); c.lineWidth = 0.6;
      const x = rng() * W, y = rng() * H, a = rng() * Math.PI, l = 5 + rng() * 25;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l * 2.8); c.stroke();
    }
  }, { repeat: [1, 1], anisotropy: 8 });
  const src = map.image;
  const rough = makeCanvasTexture(512, 512, (c, w, h) => {
    c.filter = 'grayscale(1) invert(1) contrast(0.45) brightness(1.1)';
    c.drawImage(src, 0, 0, w, h);
  }, { repeat: [1, 1], srgb: false });
  const bump = makeCanvasTexture(W, H, (c, w, h) => {
    c.filter = 'grayscale(1) contrast(1.6)';
    c.drawImage(src, 0, 0, w, h);
  }, { repeat: [1, 1], srgb: false, anisotropy: 8 });
  return { map, rough, bump };
}

/** Madera de roble genérica (baldas, vigas, utensilios). Vetas a lo largo de U. */
function oakTexture() {
  const S = 512, rng = makeRng(33), n = tileNoise(S, S, 2, 16, 3, 34);
  return makeCanvasTexture(S, S, (c) => {
    putPixels(c, S, S, (i, o) => { const v = (n[i] - 0.5) * 26; o[0] = 200 + v; o[1] = 154 + v * 0.9; o[2] = 104 + v * 0.7; });
    for (let k = 0; k < 120; k++) {
      c.strokeStyle = rgba(110, 66, 30, 0.05 + rng() * 0.12); c.lineWidth = 0.6 + rng() * 1.6;
      const y = rng() * S, ph = rng() * 10;
      for (const oy of [-S, 0, S]) wavyLine(c, -10, S + 10, y + oy, 1 + rng() * 3, (TAU / S) * (1 + ((rng() * 3) | 0)), ph, 8);
    }
    for (let k = 0; k < 60; k++) {
      c.fillStyle = rgba(255, 230, 190, 0.12);
      c.beginPath(); c.ellipse(rng() * S, rng() * S, 4 + rng() * 9, 0.8, 0, 0, TAU); c.fill();
    }
  }, { repeat: [1, 1] });
}

/** Piedra caliza cálida (encimera del fondo, alféizar, mortero). */
function stoneTexture() {
  const S = 512, rng = makeRng(41), n1 = tileNoise(S, S, 3, 3, 5, 42), n2 = tileNoise(S, S, 48, 48, 2, 43);
  return makeCanvasTexture(S, S, (c) => {
    putPixels(c, S, S, (i, o) => {
      const v = (n1[i] - 0.5) * 22 + (n2[i] - 0.5) * 10;
      o[0] = 238 + v; o[1] = 230 + v; o[2] = 216 + v * 1.2;
    });
    for (let k = 0; k < 160; k++) {
      c.fillStyle = rgba(150, 128, 100, 0.12 + rng() * 0.2);
      c.beginPath(); c.ellipse(rng() * S, rng() * S, 0.8 + rng() * 2.6, 0.6 + rng() * 1.4, rng() * 3, 0, TAU); c.fill();
    }
  }, { repeat: [1, 1] });
}

/** Relieve ondulado de los azulejos hechos a mano. */
function tileBumpTexture() {
  const S = 128, n = tileNoise(S, S, 3, 3, 3, 51);
  return makeCanvasTexture(S, S, (c) => putPixels(c, S, S, (i, o) => { o[0] = o[1] = o[2] = 70 + n[i] * 130; }), { srgb: false });
}

/** Paisaje mediterráneo pintado que se ve por la ventana. */
function backdropTexture() {
  const W = 1024, H = 640;
  return makeCanvasTexture(W, H, (c) => {
    const rng = makeRng(77);
    const X = (wx) => ((wx - BACKDROP.x0) / BACKDROP.w) * W;
    const Y = (wy) => H * (1 - (wy - BACKDROP.y0) / BACKDROP.h);
    const sky = c.createLinearGradient(0, 0, 0, Y(1.15));
    sky.addColorStop(0, '#79b3e3'); sky.addColorStop(0.45, '#a9d1ee'); sky.addColorStop(0.85, '#e4eef0'); sky.addColorStop(1, '#fbf0dc');
    c.fillStyle = sky; c.fillRect(0, 0, W, H);
    const sun = c.createRadialGradient(X(-2.9), Y(3.0), 0, X(-2.9), Y(3.0), W * 0.5);
    sun.addColorStop(0, 'rgba(255,252,236,1)'); sun.addColorStop(0.18, 'rgba(255,246,222,0.75)'); sun.addColorStop(1, 'rgba(255,240,215,0)');
    c.fillStyle = sun; c.fillRect(0, 0, W, H);
    // nubes suaves
    for (let k = 0; k < 10; k++) {
      const cx = rng() * W, cy = Y(2.05 + rng() * 1.3), s = 26 + rng() * 40;
      for (let m = 0; m < 9; m++) {
        const px = cx + (rng() - 0.5) * s * 4, py = cy + (rng() - 0.5) * s * 0.7, pr = s * (0.6 + rng() * 0.8);
        const g = c.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g; c.beginPath(); c.arc(px, py, pr, 0, TAU); c.fill();
      }
    }
    const ridge = (base, amp, color, seed, freq = 1) => {
      const r = makeRng(seed);
      const ph = [r() * 10, r() * 10, r() * 10];
      c.fillStyle = color; c.beginPath(); c.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) {
        const t = x / W;
        c.lineTo(x, base - amp * (0.55 * Math.sin(t * 5 * freq + ph[0]) + 0.3 * Math.sin(t * 13 * freq + ph[1]) + 0.15 * Math.sin(t * 31 * freq + ph[2])));
      }
      c.lineTo(W, H); c.closePath(); c.fill();
    };
    ridge(Y(1.68), 26, '#b4c7c9', 1, 0.8);       // montañas lejanas en la bruma
    ridge(Y(1.56), 20, '#9db7a5', 2);
    // pueblo blanco en la ladera
    const houses = [];
    for (let k = 0; k < 34; k++) {
      const x = X(-3.2 + rng() * 3.9), base = Y(1.4 + rng() * 0.16);
      houses.push({ x, base, w: 14 + rng() * 22, h: 10 + rng() * 14, roof: rng() < 0.75 });
    }
    houses.sort((a, b) => a.base - b.base);
    ridge(Y(1.45), 14, '#8fa784', 3, 1.3);
    for (const hs of houses) {
      c.fillStyle = '#f6f0e6'; c.fillRect(hs.x, hs.base - hs.h, hs.w, hs.h);
      c.fillStyle = 'rgba(160,150,140,0.35)'; c.fillRect(hs.x + hs.w * 0.7, hs.base - hs.h, hs.w * 0.3, hs.h);
      if (hs.roof) {
        c.fillStyle = '#c8724a'; c.beginPath();
        c.moveTo(hs.x - 2, hs.base - hs.h); c.lineTo(hs.x + hs.w * 0.5, hs.base - hs.h - 6); c.lineTo(hs.x + hs.w + 2, hs.base - hs.h); c.fill();
      }
      c.fillStyle = '#5f7f9a'; c.fillRect(hs.x + hs.w * 0.25, hs.base - hs.h * 0.6, 3, 4);
    }
    // campanario
    const tx = X(-1.55), tb = Y(1.47);
    c.fillStyle = '#f3ece1'; c.fillRect(tx, tb - 62, 16, 62);
    c.fillStyle = '#c8724a'; c.beginPath(); c.moveTo(tx - 2, tb - 62); c.lineTo(tx + 8, tb - 78); c.lineTo(tx + 18, tb - 62); c.fill();
    c.fillStyle = '#6d6a66'; c.beginPath(); c.arc(tx + 8, tb - 50, 4, Math.PI, 0); c.fillRect(tx + 4, tb - 50, 8, 6); c.fill();
    // olivares y cipreses
    ridge(Y(1.3), 10, '#7f9a64', 4, 1.6);
    for (let k = 0; k < 70; k++) {
      const x = rng() * W, y = Y(1.18 + rng() * 0.16);
      c.fillStyle = rng() < 0.5 ? '#6f8a5a' : '#879c6c';
      c.beginPath(); c.ellipse(x, y, 7 + rng() * 6, 5 + rng() * 3, 0, 0, TAU); c.fill();
    }
    for (let k = 0; k < 16; k++) {
      const x = X(-3.5 + rng() * 5.5), y = Y(1.15 + rng() * 0.25), hh = 50 + rng() * 60, ww = 8 + rng() * 5;
      c.fillStyle = '#2f4a30'; c.beginPath(); c.ellipse(x, y - hh / 2, ww, hh / 2, 0, 0, TAU); c.fill();
      c.fillStyle = 'rgba(120,150,90,0.35)'; c.beginPath(); c.ellipse(x - ww * 0.35, y - hh / 2, ww * 0.4, hh * 0.42, 0, 0, TAU); c.fill();
    }
    // jardín cercano
    const near = c.createLinearGradient(0, Y(1.15), 0, H);
    near.addColorStop(0, '#7d9b52'); near.addColorStop(1, '#4f6e35');
    c.fillStyle = near; c.fillRect(0, Y(1.12), W, H);
    for (let k = 0; k < 80; k++) {
      const x = rng() * W, y = Y(0.6 + rng() * 0.55);
      c.fillStyle = ['#5d7d40', '#6f8f4b', '#88a65c', '#4c6a33'][(rng() * 4) | 0];
      c.beginPath(); c.arc(x, y, 14 + rng() * 26, 0, TAU); c.fill();
    }
    // muro encalado del patio con macetas
    c.fillStyle = '#f2ebde'; c.fillRect(0, Y(0.98), W, Y(0.7) - Y(0.98));
    c.fillStyle = '#d8cdbd'; c.fillRect(0, Y(0.98), W, 5);
    for (let k = 0; k < 9; k++) {
      const x = X(-3.4 + k * 0.62 + rng() * 0.2), y = Y(0.98);
      c.fillStyle = '#c4683f'; c.beginPath(); c.moveTo(x - 12, y); c.lineTo(x + 12, y); c.lineTo(x + 9, y + 20); c.lineTo(x - 9, y + 20); c.fill();
      c.fillStyle = rng() < 0.5 ? '#d9455a' : '#e86a8a';
      for (let m = 0; m < 6; m++) { c.beginPath(); c.arc(x + (rng() - 0.5) * 26, y - 6 - rng() * 12, 4, 0, TAU); c.fill(); }
    }
    // limonero en primer plano (derecha)
    const lx = X(0.15), ly = Y(1.55);
    for (let k = 0; k < 120; k++) {
      const a = rng() * TAU, d = Math.sqrt(rng()) * 120;
      c.fillStyle = ['#3e5f2c', '#4f7536', '#5f8a40'][(rng() * 3) | 0];
      c.beginPath(); c.ellipse(lx + Math.cos(a) * d * 1.2, ly + Math.sin(a) * d * 0.8, 10, 5, a, 0, TAU); c.fill();
    }
    for (let k = 0; k < 22; k++) {
      const a = rng() * TAU, d = Math.sqrt(rng()) * 105;
      c.fillStyle = '#f4d24a'; c.beginPath(); c.ellipse(lx + Math.cos(a) * d * 1.2, ly + Math.sin(a) * d * 0.8, 6, 4.5, 0.4, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,220,0.6)'; c.beginPath(); c.arc(lx + Math.cos(a) * d * 1.2 - 2, ly + Math.sin(a) * d * 0.8 - 1.5, 1.6, 0, TAU); c.fill();
    }
  }, { anisotropy: 4 });
}

/** Esfera del reloj de pared. */
function clockTexture() {
  return makeCanvasTexture(512, 512, (c, w) => {
    const r = w / 2;
    const g = c.createRadialGradient(r, r, r * 0.2, r, r, r);
    g.addColorStop(0, '#fbf5e6'); g.addColorStop(0.85, '#f1e6cc'); g.addColorStop(1, '#dccaa4');
    c.fillStyle = g; c.fillRect(0, 0, w, w);
    c.translate(r, r);
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * TAU, big = i % 5 === 0;
      c.save(); c.rotate(a);
      c.fillStyle = '#2b2622';
      c.fillRect(-(big ? 4 : 1.5), -r * 0.93, big ? 8 : 3, big ? r * 0.09 : r * 0.04);
      c.restore();
    }
    c.fillStyle = '#2b2622'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = 'bold 54px Georgia, "Times New Roman", serif';
    for (let i = 1; i <= 12; i++) {
      const a = (i / 12) * TAU;
      c.fillText(String(i), Math.sin(a) * r * 0.7, -Math.cos(a) * r * 0.7 + 3);
    }
    c.fillStyle = '#8a4b2c'; c.font = '600 24px Georgia, serif';
    c.fillText('PANADERÍA', 0, r * 0.32);
    c.fillStyle = '#6b5d4e'; c.font = 'italic 18px Georgia, serif';
    c.fillText('desde 1952', 0, r * 0.42);
  });
}

/** Atlas de notas de la nevera: dibujo infantil, receta y postal. */
function notesTexture() {
  return makeCanvasTexture(512, 256, (c) => {
    // dibujo infantil (0..170)
    c.fillStyle = '#fbfaf6'; c.fillRect(0, 0, 170, 256);
    c.lineCap = 'round'; c.lineWidth = 5;
    c.strokeStyle = '#f2b51c'; c.beginPath(); c.arc(45, 50, 20, 0, TAU); c.stroke();
    for (let i = 0; i < 8; i++) { const a = (i / 8) * TAU; c.beginPath(); c.moveTo(45 + Math.cos(a) * 28, 50 + Math.sin(a) * 28); c.lineTo(45 + Math.cos(a) * 40, 50 + Math.sin(a) * 40); c.stroke(); }
    c.fillStyle = '#d99a4e'; c.beginPath(); c.ellipse(95, 160, 58, 34, 0, 0, TAU); c.fill();
    c.strokeStyle = '#8a5424'; c.lineWidth = 4;
    for (let i = -1; i <= 1; i++) { c.beginPath(); c.moveTo(80 + i * 22, 138); c.lineTo(98 + i * 22, 150); c.stroke(); }
    c.strokeStyle = '#3b2a1f'; c.lineWidth = 3;
    c.beginPath(); c.arc(95, 170, 14, 0.2, Math.PI - 0.2); c.stroke();
    c.fillStyle = '#3b2a1f'; c.beginPath(); c.arc(84, 160, 3, 0, TAU); c.arc(106, 160, 3, 0, TAU); c.fill();
    c.fillStyle = '#d23f4f'; c.font = 'bold 22px "Comic Sans MS", cursive, sans-serif'; c.textAlign = 'center';
    c.fillText('¡PAN!', 120, 60);
    c.fillStyle = '#3a6fb0'; c.font = 'bold 18px "Comic Sans MS", cursive, sans-serif';
    c.fillText('para mamá', 85, 230);
    // receta (172..340)
    c.fillStyle = '#fffaf0'; c.fillRect(172, 0, 168, 256);
    c.strokeStyle = 'rgba(80,130,190,0.35)'; c.lineWidth = 1;
    for (let y = 60; y < 256; y += 26) { c.beginPath(); c.moveTo(176, y); c.lineTo(336, y); c.stroke(); }
    c.strokeStyle = 'rgba(210,80,80,0.5)'; c.beginPath(); c.moveTo(192, 0); c.lineTo(192, 256); c.stroke();
    c.fillStyle = '#2a3550'; c.textAlign = 'left';
    c.font = 'italic bold 22px Georgia, serif'; c.fillText('Pan de pueblo', 198, 40);
    c.font = 'italic 17px Georgia, serif';
    ['500 g harina', '350 ml agua', '10 g sal', '7 g levadura', 'reposar 1 h'].forEach((t, i) => c.fillText(t, 198, 82 + i * 26));
    // postal (342..512)
    const sea = c.createLinearGradient(0, 0, 0, 256);
    sea.addColorStop(0, '#7cc0e8'); sea.addColorStop(0.55, '#bfe2f2'); sea.addColorStop(0.56, '#2f7fb5'); sea.addColorStop(1, '#1d5f8f');
    c.fillStyle = sea; c.fillRect(342, 0, 170, 256);
    c.fillStyle = '#ffd25c'; c.beginPath(); c.arc(470, 60, 22, 0, TAU); c.fill();
    c.fillStyle = '#ffffff';
    [[352, 120, 40, 30], [390, 110, 30, 40], [420, 125, 44, 25]].forEach(([x, y, w, h]) => c.fillRect(x, y, w, h));
    c.fillStyle = '#2f6fa8'; c.beginPath(); c.arc(405, 110, 15, Math.PI, 0); c.fill();
    c.fillStyle = '#ffffff'; c.font = 'bold 20px Georgia, serif'; c.textAlign = 'center';
    c.fillText('Saludos', 427, 200); c.fillText('desde el mar', 427, 226);
  });
}

/** Etiquetas de papel kraft para los tarros (atlas 2×4). */
const JAR_WORDS = ['HARINA', 'PASTA', 'ALUBIAS', 'LENTEJAS', 'ARROZ', 'GARBANZOS', 'CAFÉ', 'AZÚCAR'];
function labelsTexture() {
  return makeCanvasTexture(512, 256, (c) => {
    JAR_WORDS.forEach((word, i) => {
      const x = (i % 2) * 256, y = ((i / 2) | 0) * 64;
      c.fillStyle = '#dcc49b'; c.fillRect(x, y, 256, 64);
      c.strokeStyle = '#6b4a2a'; c.lineWidth = 2; c.strokeRect(x + 6, y + 6, 244, 52);
      c.fillStyle = '#3a2516'; c.font = 'bold 30px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(word, x + 128, y + 34);
    });
  });
}

/** Contenidos de los tarros (atlas 4×2 de 128 px). */
function contentsTexture() {
  return makeCanvasTexture(512, 256, (c) => {
    const rng = makeRng(61);
    const cell = (i, base, draw) => {
      const x = (i % 4) * 128, y = ((i / 4) | 0) * 128;
      c.save(); c.beginPath(); c.rect(x, y, 128, 128); c.clip();
      c.fillStyle = base; c.fillRect(x, y, 128, 128);
      draw(x, y); c.restore();
    };
    const many = (x, y, n, fn) => { for (let k = 0; k < n; k++) fn(x + rng() * 128, y + rng() * 128); };
    cell(0, '#f3efe6', (x, y) => many(x, y, 400, (px, py) => { c.fillStyle = rgba(220, 212, 196, 0.5); c.fillRect(px, py, 1.5, 1.5); }));
    cell(1, '#c98f3a', (x, y) => many(x, y, 90, (px, py) => {
      c.save(); c.translate(px, py); c.rotate(rng() * Math.PI);
      c.fillStyle = '#ecc06a'; c.fillRect(-11, -4, 22, 8);
      c.fillStyle = '#b07a2c'; c.fillRect(-11, -1, 22, 2); c.restore();
    }));
    cell(2, '#4a1712', (x, y) => many(x, y, 120, (px, py) => {
      c.fillStyle = rng() < 0.5 ? '#8c2c22' : '#a5382c'; c.beginPath(); c.ellipse(px, py, 7, 4.5, rng() * 3, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,220,200,0.35)'; c.beginPath(); c.arc(px - 2, py - 1.5, 1.5, 0, TAU); c.fill();
    }));
    cell(3, '#7a5228', (x, y) => many(x, y, 420, (px, py) => {
      c.fillStyle = ['#a8743c', '#8f6230', '#b8854a'][(rng() * 3) | 0]; c.beginPath(); c.ellipse(px, py, 3.2, 2.6, rng() * 3, 0, TAU); c.fill();
    }));
    cell(4, '#e9e3d6', (x, y) => many(x, y, 360, (px, py) => {
      c.fillStyle = rng() < 0.5 ? '#fbf8f1' : '#d8d0c0'; c.beginPath(); c.ellipse(px, py, 3.5, 1.4, rng() * 3, 0, TAU); c.fill();
    }));
    cell(5, '#b38a52', (x, y) => many(x, y, 140, (px, py) => {
      const g = c.createRadialGradient(px - 1.5, py - 1.5, 0.5, px, py, 6);
      g.addColorStop(0, '#f0d29c'); g.addColorStop(1, '#c49a5e');
      c.fillStyle = g; c.beginPath(); c.arc(px, py, 5.5, 0, TAU); c.fill();
    }));
    cell(6, '#2b190e', (x, y) => many(x, y, 150, (px, py) => {
      c.save(); c.translate(px, py); c.rotate(rng() * 3);
      c.fillStyle = '#5a3420'; c.beginPath(); c.ellipse(0, 0, 5.5, 4, 0, 0, TAU); c.fill();
      c.strokeStyle = '#25140a'; c.lineWidth = 1; c.beginPath(); c.moveTo(-4, 0); c.lineTo(4, 0); c.stroke(); c.restore();
    }));
    cell(7, '#f6f4ef', (x, y) => many(x, y, 300, (px, py) => { c.fillStyle = rng() < 0.5 ? '#ffffff' : '#dedad2'; c.fillRect(px, py, 2.2, 2.2); }));
  });
}

/** Lomo de libro de tela: bandas doradas y ligera curvatura. */
function bookTexture() {
  return makeCanvasTexture(64, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#c9c9c9'); g.addColorStop(0.3, '#ffffff'); g.addColorStop(1, '#bdbdbd');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = '#f3d27a';
    [20, 30, 222, 232].forEach((y) => c.fillRect(0, y, w, 4));
    c.fillStyle = 'rgba(255,240,200,0.9)'; c.fillRect(w * 0.3, 70, w * 0.4, 70);
  });
}

/** Plato pintado a mano (limones y borde azul cobalto). */
function plateTexture() {
  return makeCanvasTexture(256, 256, (c, w) => {
    const r = w / 2;
    c.fillStyle = '#f7f2e6'; c.fillRect(0, 0, w, w);
    c.translate(r, r);
    c.strokeStyle = '#1f4f9a'; c.lineWidth = 14; c.beginPath(); c.arc(0, 0, r - 12, 0, TAU); c.stroke();
    c.lineWidth = 3; c.beginPath(); c.arc(0, 0, r - 28, 0, TAU); c.stroke();
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      c.fillStyle = '#e7b52c'; c.beginPath(); c.arc(Math.cos(a) * (r - 38), Math.sin(a) * (r - 38), 3.5, 0, TAU); c.fill();
    }
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * TAU + 0.4;
      c.save(); c.rotate(a);
      c.fillStyle = '#4f8a3a'; c.beginPath(); c.ellipse(28, 10, 18, 7, 0.6, 0, TAU); c.fill();
      c.fillStyle = '#f2c933'; c.beginPath(); c.ellipse(26, -12, 20, 14, 0.2, 0, TAU); c.fill();
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.beginPath(); c.ellipse(20, -16, 6, 3, 0.2, 0, TAU); c.fill();
      c.restore();
    }
    c.fillStyle = '#1f4f9a'; c.beginPath(); c.arc(0, 0, 9, 0, TAU); c.fill();
  });
}

/** Saco de arpillera con sello "HARINA"; la franja inferior (v<0.12) es la harina de la boca. */
function burlapTexture() {
  return makeCanvasTexture(512, 256, (c, w, h) => {
    const rng = makeRng(71);
    c.fillStyle = '#b89a6a'; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 3) { c.fillStyle = rgba(120 + rng() * 60, 95 + rng() * 45, 60 + rng() * 30, 0.35); c.fillRect(x, 0, 1.6, h); }
    for (let y = 0; y < h; y += 3) { c.fillStyle = rgba(210, 185, 140, 0.25 + rng() * 0.2); c.fillRect(0, y, w, 1.4); }
    c.save(); c.translate(w * 0.25, h * 0.52); c.scale(1, 1.2);
    c.fillStyle = 'rgba(150,40,30,0.8)'; c.font = 'bold 34px Georgia, serif'; c.textAlign = 'center';
    c.fillText('HARINA', 0, 0);
    c.font = 'bold 15px Georgia, serif'; c.fillText('DE TRIGO · 25 kg', 0, 22);
    c.strokeStyle = 'rgba(150,40,30,0.7)'; c.lineWidth = 2.5; c.strokeRect(-72, -34, 144, 66);
    c.restore();
    c.fillStyle = '#f6f2ea'; c.fillRect(0, h * 0.88, w, h * 0.12);
    for (let k = 0; k < 300; k++) { c.fillStyle = rgba(225, 218, 205, 0.6); c.fillRect(rng() * w, h * 0.88 + rng() * h * 0.12, 2, 2); }
  });
}

/** Azulejo pintado a mano (cenefa): rosetón azul cobalto y cuartos de flor ocre en las esquinas. */
function azulejoTexture() {
  return makeCanvasTexture(256, 256, (c, w) => {
    const r = w / 2, blue = '#24519b', ochre = '#d89a34';
    c.fillStyle = '#f7f0e1'; c.fillRect(0, 0, w, w);
    c.filter = 'blur(0.7px)';
    for (const [x, y] of [[0, 0], [w, 0], [0, w], [w, w]]) {
      c.fillStyle = ochre; c.beginPath(); c.arc(x, y, w * 0.17, 0, TAU); c.fill();
      c.strokeStyle = blue; c.lineWidth = 7; c.beginPath(); c.arc(x, y, w * 0.25, 0, TAU); c.stroke();
    }
    c.translate(r, r);
    for (let i = 0; i < 8; i++) {
      c.rotate(TAU / 8);
      c.fillStyle = blue; c.beginPath(); c.ellipse(0, -r * 0.4, r * 0.11, r * 0.27, 0, 0, TAU); c.fill();
      c.fillStyle = '#3f8f8a'; c.beginPath(); c.arc(0, -r * 0.72, r * 0.05, 0, TAU); c.fill();
    }
    c.fillStyle = ochre; c.beginPath(); c.arc(0, 0, r * 0.17, 0, TAU); c.fill();
    c.fillStyle = blue; c.beginPath(); c.arc(0, 0, r * 0.07, 0, TAU); c.fill();
  });
}

/** Sombras de contacto difusas (blanco + alfa): rectángulo, círculo y rectángulo suave (paredes). */
function contactShadowTexture() {
  return makeCanvasTexture(384, 128, (c) => {
    c.filter = 'blur(11px)';
    c.fillStyle = '#ffffff';
    c.fillRect(26, 26, 76, 76);
    c.beginPath(); c.arc(192, 64, 32, 0, TAU); c.fill();
    c.globalAlpha = 0.45;
    c.fillRect(282, 26, 76, 76);
  });
}

/** Paño de lino crudo con rayas rojas y azules cerca de los bajos (v a lo largo del paño). */
function towelTexture() {
  return makeCanvasTexture(128, 256, (c, w, h) => {
    const rng = makeRng(131);
    c.fillStyle = '#efe5d3'; c.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 2) { c.fillStyle = rgba(200, 185, 160, 0.12 + rng() * 0.12); c.fillRect(x, 0, 1, h); }
    for (let y = 0; y < h; y += 2) { c.fillStyle = rgba(255, 250, 240, 0.1 + rng() * 0.1); c.fillRect(0, y, w, 1); }
    for (const y0 of [h * 0.06, h * 0.86]) {
      c.fillStyle = 'rgba(178,48,44,0.9)'; c.fillRect(0, y0, w, 9);
      c.fillStyle = 'rgba(40,70,140,0.85)'; c.fillRect(0, y0 + 14, w, 3); c.fillRect(0, y0 - 7, w, 3);
    }
  });
}

/** Haz de luz: degradado a lo largo (v) con rayas suaves (u). */
function shaftTexture() {
  return makeCanvasTexture(128, 256, (c, w, h) => {
    const rng = makeRng(81);
    for (let x = 0; x < w; x++) {
      const v = 0.55 + 0.45 * Math.sin(x * 0.21 + Math.sin(x * 0.05) * 3) * (0.6 + rng() * 0.4);
      const g = c.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgba(255, 255, 255, 0));
      g.addColorStop(0.08, rgba(255, 255, 255, v));
      g.addColorStop(1, rgba(255, 255, 255, 0));
      c.fillStyle = g; c.fillRect(x, 0, 1, h);
    }
  });
}

function makeTextures() {
  const plaster = plasterTextures();
  const floor = floorTextures();
  const butcher = butcherTextures();
  return {
    plaster, floor, butcher,
    oak: oakTexture(), stone: stoneTexture(), tileBump: tileBumpTexture(), backdrop: backdropTexture(),
    clock: clockTexture(), notes: notesTexture(), labels: labelsTexture(), contents: contentsTexture(),
    book: bookTexture(), plate: plateTexture(), burlap: burlapTexture(), shaft: shaftTexture(),
    azulejo: azulejoTexture(), contact: contactShadowTexture(), towel: towelTexture(),
  };
}

// ---------------------------------------------------------------------------
// Materiales (compartidos; una malla fusionada por clave)
// ---------------------------------------------------------------------------
function makeMaterials(T) {
  // envMapIntensity < 1 en superficies mates: el entorno RoomEnvironment aplana mucho la luz
  const std = (o) => new THREE.MeshStandardMaterial({ envMapIntensity: o.metalness ? 1 : 0.38, ...o });
  const phys = (o) => new THREE.MeshPhysicalMaterial({ envMapIntensity: 0.7, ...o });
  return {
    plaster: std({ map: T.plaster.map, bumpMap: T.plaster.bump, bumpScale: 1.4, roughness: 0.95 }),
    ceiling: std({ map: T.plaster.map, color: 0xfffaf3, roughness: 0.95 }),
    floor: std({ map: T.floor.map, roughnessMap: T.floor.rough, bumpMap: T.floor.bump, bumpScale: 2.2, roughness: 1 }),
    butcher: phys({
      map: T.butcher.map, roughnessMap: T.butcher.rough, bumpMap: T.butcher.bump, bumpScale: 0.8,
      roughness: 1, clearcoat: 0.22, clearcoatRoughness: 0.45,
    }),
    oak: std({ map: T.oak, vertexColors: true, roughness: 0.62 }),
    stone: std({ map: T.stone, color: 0xf0e4d2, roughness: 0.36 }),
    sage: std({ color: COLORS.sage, roughness: 0.5 }),
    teal: std({ color: COLORS.teal, roughness: 0.42 }),
    brass: std({ color: COLORS.brass, metalness: 1, roughness: 0.3 }),
    steel: std({ color: COLORS.steel, metalness: 1, roughness: 0.22 }),
    copper: std({ color: COLORS.copper, metalness: 1, roughness: 0.3 }),
    iron: std({ color: COLORS.iron, metalness: 0.5, roughness: 0.5 }),
    dark: std({ color: COLORS.dark, roughness: 0.92 }),
    ceramic: phys({ vertexColors: true, roughness: 0.22, clearcoat: 0.7, clearcoatRoughness: 0.1 }),
    satin: std({ vertexColors: true, roughness: 0.45 }),
    matte: std({ vertexColors: true, roughness: 0.88 }),
    terracotta: std({ map: T.plaster.map, vertexColors: true, roughness: 0.92 }),
    fridge: phys({ color: COLORS.fridge, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.12 }),
    enamel: phys({ color: COLORS.enamel, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 0.45 }),
    shadeInner: std({ color: 0xfff8ee, emissive: 0xffd49a, emissiveIntensity: 0.7, roughness: 0.6, side: THREE.BackSide }),
    bulb: std({ color: 0xffffff, emissive: 0xffe1b0, emissiveIntensity: 5 }),
    glass: phys({ color: 0xffffff, roughness: 0.03, transparent: true, opacity: 0.12, depthWrite: false }),
    jarGlass: phys({ color: 0xf2fbf7, roughness: 0.04, transparent: true, opacity: 0.26, depthWrite: false, clearcoat: 1 }),
    contents: std({ map: T.contents, roughness: 0.8 }),
    labels: std({ map: T.labels, roughness: 0.85 }),
    notes: std({ map: T.notes, roughness: 0.85 }),
    books: std({ map: T.book, vertexColors: true, roughness: 0.78 }),
    plates: phys({ map: T.plate, roughness: 0.22, clearcoat: 0.7 }),
    burlap: std({ map: T.burlap, roughness: 0.97 }),
    clockFace: std({ map: T.clock, roughness: 0.55 }),
    tile: phys({ color: 0xffffff, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.06, bumpMap: T.tileBump, bumpScale: 3, envMapIntensity: 1 }),
    azulejo: phys({ map: T.azulejo, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06, bumpMap: T.tileBump, bumpScale: 3, envMapIntensity: 1 }),
    contact: new THREE.MeshBasicMaterial({
      map: T.contact, color: 0x3a2516, transparent: true, opacity: 0.55, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    leaf: std({ side: THREE.DoubleSide, roughness: 0.62 }),
    towel: std({ map: T.towel, side: THREE.DoubleSide, roughness: 0.95 }),
  };
}

// Mallas fusionadas que no proyectan / no reciben sombra.
const NO_CAST = new Set(['floor', 'glass', 'jarGlass', 'bulb', 'shadeInner', 'enamel', 'notes', 'labels', 'clockFace', 'contact']);
const NO_RECEIVE = new Set(['bulb', 'shadeInner', 'glass', 'jarGlass', 'contact']);

// ---------------------------------------------------------------------------
// Piezas comunes
// ---------------------------------------------------------------------------
function makeCommonGeos() {
  return {
    knob: lathe([[0, 0], [0.006, 0], [0.0062, 0.012], [0.011, 0.017], [0.0145, 0.024], [0.0135, 0.031], [0.008, 0.035], [0, 0.0355]], 16).rotateX(HALF_PI),
    post: new THREE.CylinderGeometry(0.0045, 0.0052, 0.028, 10).rotateX(HALF_PI).translate(0, 0, 0.014),
  };
}

/** Tirador: 'knob' (pomo) o 'bar' (barra con dos patas). Local: frente del panel en z = t. */
function addHandle(B, G, h, m, t) {
  if (h.type === 'knob') {
    B.add('brass', G.knob, mul(m, M(h.x ?? 0, h.y ?? 0, t)));
  } else if (h.type === 'bar') {
    const len = h.len ?? 0.14, x = h.x ?? 0, y = h.y ?? 0;
    B.add('brass', G.post, mul(m, M(x - len / 2 + 0.014, y, t)));
    B.add('brass', G.post, mul(m, M(x + len / 2 - 0.014, y, t)));
    B.add('brass', new THREE.CapsuleGeometry(0.0058, len - 0.012, 4, 10), mul(m, M(x, y, t + 0.028, 0, 0, HALF_PI)));
  }
}

/**
 * Frente estilo shaker (tablero + marco) en el plano local XY mirando a +z, con su cara
 * trasera en z=0. Los frentes bajos son lisos con canto redondeado.
 */
function addFront(B, G, key, w, h, m, handle = null) {
  const gap = 0.003;
  w -= gap * 2; h -= gap * 2;
  if (h < 0.15 || w < 0.15) {
    B.add(key, new RoundedBoxGeometry(w, h, FRONT_T, 1, 0.004), mul(m, M(0, 0, FRONT_T / 2)));
  } else {
    const f = Math.min(0.06, Math.min(w, h) * 0.2), tb = 0.011, tf = FRONT_T - tb;
    B.add(key, new RoundedBoxGeometry(w, h, tb, 1, 0.002), mul(m, M(0, 0, tb / 2)));
    for (const s of [-1, 1]) {
      B.add(key, new RoundedBoxGeometry(f, h, tf, 1, 0.003), mul(m, M(s * (w - f) / 2, 0, tb + tf / 2)));
      B.add(key, new RoundedBoxGeometry(w - 2 * f + 0.002, f, tf, 1, 0.003), mul(m, M(0, s * (h - f) / 2, tb + tf / 2)));
    }
  }
  if (handle) addHandle(B, G, handle, m, FRONT_T);
}

/**
 * Módulo de frentes entre x0..x1 (en el sistema local `m`): 'd3' = tres cajones,
 * 'dd' = cajón + puerta, 'door2' = dos puertas. knob = lado del pomo de la puerta.
 */
function addBay(B, G, key, x0, x1, y0, y1, m, type, knob = 1) {
  const w = x1 - x0, cx = (x0 + x1) / 2;
  const front = (yb, yt, handle) => addFront(B, G, key, w, yt - yb, mul(m, M(cx, (yb + yt) / 2, 0)), handle);
  const bar = (hgt, len = Math.min(0.2, w * 0.4)) => ({ type: 'bar', y: hgt > 0.22 ? hgt / 2 - 0.07 : 0, len });
  if (type === 'd3') {
    const a = y1 - 0.17, b = a - 0.25;
    front(a, y1, bar(0.17)); front(b, a, bar(0.25)); front(y0, b, bar(b - y0));
  } else if (type === 'dd') {
    const a = y1 - 0.17;
    front(a, y1, bar(0.17));
    front(y0, a, { type: 'knob', x: knob * (w / 2 - 0.05), y: (a - y0) / 2 - 0.07 });
  } else if (type === 'door2') {
    const hw = w / 2;
    for (const s of [-1, 1]) {
      addFront(B, G, key, hw, y1 - y0, mul(m, M(cx + s * hw / 2, (y0 + y1) / 2, 0)), { type: 'knob', x: -s * (hw / 2 - 0.045), y: (y1 - y0) / 2 - 0.07 });
    }
  }
}

// ---------------------------------------------------------------------------
// Habitación
// ---------------------------------------------------------------------------
function buildRoom(B, T) {
  const { minX, maxX, backZ, frontZ, height } = ROOM;
  const len = frontZ - backZ, midZ = (frontZ + backZ) / 2;
  const [fw, fh] = T.floor.size;
  B.add('floor', new THREE.PlaneGeometry(maxX - minX, len).rotateX(-HALF_PI), M(0, 0, midZ), { uv: boxUV(fw, fh) });

  // Muro del fondo con hueco de ventana y aristas redondeadas (cal)
  const shape = new THREE.Shape()
    .moveTo(minX - 0.2, -0.2).lineTo(maxX + 0.2, -0.2).lineTo(maxX + 0.2, height + 0.2).lineTo(minX - 0.2, height + 0.2).lineTo(minX - 0.2, -0.2);
  shape.holes.push(new THREE.Path().moveTo(WIN.x0, WIN.y0).lineTo(WIN.x0, WIN.y1).lineTo(WIN.x1, WIN.y1).lineTo(WIN.x1, WIN.y0).lineTo(WIN.x0, WIN.y0));
  const bev = 0.03;
  const wall = new THREE.ExtrudeGeometry(shape, {
    depth: WALL_T - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev, bevelSegments: 4, curveSegments: 1,
  });
  const pu = boxUV(SIZES_TEX.plaster);
  B.add('plaster', wall, M(0, 0, backZ - WALL_T + bev), { uv: pu });
  B.add('plaster', new THREE.PlaneGeometry(len, height), M(minX, height / 2, midZ, 0, HALF_PI, 0), { uv: pu });
  B.add('plaster', new THREE.PlaneGeometry(len, height), M(maxX, height / 2, midZ, 0, -HALF_PI, 0), { uv: pu });
  B.add('ceiling', new THREE.PlaneGeometry(maxX - minX + 0.4, len), M(0, height, midZ, HALF_PI, 0, 0), { uv: pu });

  // Rodapié de barro y vigas de madera
  const tc = COLORS.terracotta;
  addBox(B, 'terracotta', minX, minX + 0.014, 0, 0.09, backZ, frontZ, { color: tc });
  addBox(B, 'terracotta', maxX - 0.014, maxX, 0, 0.09, backZ, frontZ, { color: tc });
  addBox(B, 'terracotta', minX, BACK_RUN.minX, 0, 0.09, backZ, backZ + 0.014, { color: tc });
  for (const z of [0.42, 1.62, 2.82]) {
    B.add('oak', new RoundedBoxGeometry(maxX - minX, 0.17, 0.14, 2, 0.012), M(0, height - 0.085, z), { uv: boxUV(SIZES_TEX.oak), color: 0xb48f66 });
  }
}

// ---------------------------------------------------------------------------
// Isla de trabajo
// ---------------------------------------------------------------------------
/** UV de la encimera: la textura cubre toda la cara superior; cantos = continuación de los listones. */
function butcherUV(g) {
  const { width, depth } = COUNTER, x0 = COUNTER.x - width / 2, z0 = COUNTER.z - depth / 2;
  const p = g.attributes.position.array, uv = g.attributes.uv.array, n = g.attributes.normal.array;
  for (let i = 0; i < p.length / 3; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const nx = Math.abs(n[i * 3]), ny = Math.abs(n[i * 3 + 1]), nz = Math.abs(n[i * 3 + 2]);
    const u = (x - x0) / width, v = 1 - (z - z0) / depth, d = (TOP - y);
    if (ny >= nx && ny >= nz) { uv[i * 2] = u; uv[i * 2 + 1] = v; }
    else if (nz >= nx) { uv[i * 2] = u; uv[i * 2 + 1] = z > 0 ? d * 0.5 : 1 - d * 0.5; }
    else { uv[i * 2] = x < 0 ? 0.003 + d * 0.02 : 0.997 - d * 0.02; uv[i * 2 + 1] = v; }
  }
}

function buildIsland(B, G) {
  const { width, depth, thickness, x: cx, z: cz } = COUNTER;
  B.add('butcher', new RoundedBoxGeometry(width, thickness, depth, 3, 0.007), M(cx, TOP - thickness / 2, cz), { uv: butcherUV });

  const bx = 1.2, bz = 0.34, y0 = PLINTH, y1 = TOP - thickness;
  addBox(B, 'teal', cx - bx, cx + bx, y0, y1, cz - bz, cz + bz);
  addBox(B, 'dark', cx - bx + 0.05, cx + bx - 0.05, 0, y0, cz - bz + 0.05, cz + bz - 0.05);
  const bays = [[-1.2, -0.6, 'd3'], [-0.6, 0, 'dd', -1], [0, 0.6, 'dd', 1], [0.6, 1.2, 'd3']];
  for (const side of [1, -1]) {
    const m = M(cx, 0, cz + side * bz, 0, side > 0 ? 0 : Math.PI, 0);
    for (const [a, b, type, k] of bays) addBay(B, G, 'teal', a, b, y0, y1, m, type, k);
  }
  for (const s of [-1, 1]) {
    addFront(B, G, 'teal', 2 * bz, y1 - y0, M(cx + s * bx, (y0 + y1) / 2, cz, 0, s * HALF_PI, 0));
  }
}

// ---------------------------------------------------------------------------
// Mueble del fondo: bajos, encimera de piedra, fregadero, fuego decorativo
// ---------------------------------------------------------------------------
function buildBackRun(B, G) {
  const { minX, maxX, frontZ } = BACK_RUN;
  const carcZ = frontZ - FRONT_T, colX = OVEN.column.minX, ct = 0.04;
  addBox(B, 'sage', minX, SINK.x0, PLINTH, TOP - ct, BACK, carcZ);
  addBox(B, 'sage', SINK.x1, colX, PLINTH, TOP - ct, BACK, carcZ);
  addBox(B, 'sage', SINK.x0, SINK.x1, PLINTH, 0.68, BACK, carcZ);
  addBox(B, 'dark', minX, colX, 0, PLINTH, BACK, carcZ - 0.05);
  // Encimera de piedra (con hueco para el fregadero)
  const su = boxUV(SIZES_TEX.stone), cz1 = frontZ + 0.025;
  B.add('stone', new RoundedBoxGeometry(SINK.x0 - minX, ct, cz1 - BACK, 2, 0.006), M((minX + SINK.x0) / 2, TOP - ct / 2, (BACK + cz1) / 2), { uv: su });
  B.add('stone', new RoundedBoxGeometry(colX - SINK.x1, ct, cz1 - BACK, 2, 0.006), M((SINK.x1 + colX) / 2, TOP - ct / 2, (BACK + cz1) / 2), { uv: su });
  addBox(B, 'stone', SINK.x0, SINK.x1, TOP - ct, TOP, BACK, SINK.z0, { uv: su });

  const m = M(0, 0, carcZ);
  const y0 = PLINTH, y1 = TOP - ct;
  const bays = [[-2.9, -2.3, 'd3'], [-2.3, -1.7, 'dd', 1], [-1.7, -1.1, 'dd', -1], [-0.3, 0.3, 'dd', 1], [0.3, 0.95, 'd3'], [0.95, 1.55, 'dd', -1]];
  for (const [a, b, type, k] of bays) addBay(B, G, 'sage', a, b, y0, y1, m, type, k);
  addBay(B, G, 'sage', -1.1, -0.3, y0, 0.665, m, 'door2');
  addBox(B, 'sage', maxX, colX, y0, y1, carcZ, frontZ - 0.004);

  buildSink(B);
  buildHob(B);
}

function buildSink(B) {
  const w = SINK.x1 - SINK.x0, d = SINK.z1 - SINK.z0, cx = (SINK.x0 + SINK.x1) / 2, cz = (SINK.z0 + SINK.z1) / 2;
  const shape = roundRect(w, d, 0.03);
  shape.holes.push(roundRect(w - 0.07, d - 0.07, 0.05, new THREE.Path()));
  const tub = new THREE.ExtrudeGeometry(shape, { depth: 0.23, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelOffset: -0.008, bevelSegments: 3, curveSegments: 6 });
  tub.rotateX(-HALF_PI);
  const white = COLORS.porcelain;
  B.add('ceramic', tub, M(cx, 0.69, cz), { color: white });
  B.add('ceramic', new THREE.ShapeGeometry(roundRect(w - 0.07, d - 0.07, 0.05), 6).rotateX(-HALF_PI), M(cx, 0.715, cz), { color: white });
  B.add('steel', new THREE.CylinderGeometry(0.032, 0.032, 0.004, 24), M(cx, 0.717, cz - 0.04));
  B.add('dark', new THREE.CylinderGeometry(0.02, 0.02, 0.004, 20), M(cx, 0.718, cz - 0.04));
  // Grifo de latón de cuello de cisne con dos llaves
  const fx = cx, fz = BACK + 0.045;
  B.add('brass', new THREE.CylinderGeometry(0.026, 0.03, 0.03, 24), M(fx, TOP + 0.015, fz));
  B.add('brass', tube([[0, 0, 0], [0, 0.22, 0], [0, 0.335, 0.045], [0, 0.345, 0.13], [0, 0.3, 0.2], [0, 0.25, 0.215]], 0.011, 40, 12), M(fx, TOP + 0.02, fz));
  B.add('brass', new THREE.CylinderGeometry(0.014, 0.012, 0.03, 16), M(fx, TOP + 0.255, fz + 0.215));
  for (const s of [-1, 1]) {
    B.add('brass', new THREE.CylinderGeometry(0.012, 0.012, 0.09, 12), M(fx + s * 0.05, TOP + 0.06, fz, 0, 0, HALF_PI));
    B.add('brass', new THREE.CylinderGeometry(0.016, 0.02, 0.05, 16), M(fx + s * 0.1, TOP + 0.03, fz));
    for (const a of [0, HALF_PI]) B.add('brass', new THREE.CapsuleGeometry(0.005, 0.05, 3, 8), M(fx + s * 0.1, TOP + 0.064, fz, a, 0, HALF_PI));
  }
}

function buildHob(B) {
  const { x, z } = HOB, w = 0.58, d = 0.5, y = TOP + 0.004;
  B.add('steel', new RoundedBoxGeometry(w, 0.008, d, 2, 0.003), M(x, y, z));
  const burners = [[-0.14, -0.11, 1], [0.14, -0.11, 0.8], [-0.14, 0.12, 0.85], [0.14, 0.12, 1.1]];
  for (const [bx, bz, s] of burners) {
    B.add('iron', new THREE.CylinderGeometry(0.05 * s, 0.054 * s, 0.012, 28), M(x + bx, y + 0.01, z + bz));
    B.add('brass', new THREE.CylinderGeometry(0.038 * s, 0.04 * s, 0.008, 28), M(x + bx, y + 0.019, z + bz));
    B.add('iron', new THREE.CylinderGeometry(0.03 * s, 0.034 * s, 0.008, 28), M(x + bx, y + 0.026, z + bz));
  }
  // Parrillas de hierro fundido
  const gy = y + 0.042;
  for (const sx of [-1, 1]) {
    const gx = x + sx * 0.145;
    for (const s of [-1, 1]) {
      B.add('iron', new RoundedBoxGeometry(0.012, 0.014, d - 0.04, 1, 0.003), M(gx + s * 0.13, gy, z));
      B.add('iron', new RoundedBoxGeometry(0.27, 0.014, 0.012, 1, 0.003), M(gx, gy, z + s * 0.23));
    }
    for (const bz of [-0.11, 0.12]) {
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI;
        B.add('iron', new RoundedBoxGeometry(0.2, 0.012, 0.01, 1, 0.003), M(gx, gy + 0.002, z + bz, 0, a, 0));
      }
    }
    for (const s of [-1, 1]) B.add('iron', new THREE.CylinderGeometry(0.006, 0.006, 0.03, 8), M(gx + s * 0.12, gy - 0.02, z + s * 0.2));
  }
  // Mandos
  for (let k = 0; k < 4; k++) {
    B.add('iron', new THREE.CylinderGeometry(0.017, 0.019, 0.022, 20), M(x - 0.21 + k * 0.14, y + 0.015, z + d / 2 - 0.03));
    B.add('steel', new THREE.BoxGeometry(0.006, 0.006, 0.026), M(x - 0.21 + k * 0.14, y + 0.028, z + d / 2 - 0.03));
  }
  // Cafetera italiana (octogonal) sobre el fuego delantero izquierdo
  const mx = x - 0.14, mz = z + 0.12, my = gy + 0.008;
  B.add('steel', lathe([[0, 0], [0.043, 0], [0.047, 0.006], [0.041, 0.075], [0.03, 0.088], [0.035, 0.094], [0.045, 0.1], [0.037, 0.178], [0.039, 0.182], [0.03, 0.19], [0.012, 0.2], [0, 0.202]], 8), M(mx, my, mz, 0, Math.PI / 8, 0));
  B.add('iron', tube([[0.038, 0.17, 0], [0.07, 0.165, 0], [0.085, 0.14, 0], [0.075, 0.11, 0], [0.04, 0.105, 0]], 0.007, 16, 6), M(mx, my, mz, 0, -0.5, 0));
  B.add('iron', new THREE.SphereGeometry(0.009, 10, 8), M(mx, my + 0.205, mz));
  B.add('steel', new THREE.ConeGeometry(0.012, 0.04, 8), M(mx - 0.035, my + 0.17, mz - 0.02, 0, 0, Math.PI * 0.65));
}

// ---------------------------------------------------------------------------
// Columna del horno (hueco exacto para oven.js)
// ---------------------------------------------------------------------------
function buildOvenColumn(B, G) {
  const { minX, maxX, frontZ, depth, height } = OVEN.column;
  const backZ = frontZ - depth, carcZ = frontZ - FRONT_T;
  const nx0 = OVEN.front.x - OVEN.width / 2, nx1 = OVEN.front.x + OVEN.width / 2;
  const ny0 = OVEN.front.y - OVEN.height / 2, ny1 = OVEN.front.y + OVEN.height / 2, nz = frontZ - 0.58;
  addBox(B, 'sage', minX, nx0, PLINTH, height - 0.04, backZ, carcZ);
  addBox(B, 'sage', nx1, maxX, PLINTH, height - 0.04, backZ, carcZ);
  addBox(B, 'sage', nx0, nx1, PLINTH, ny0, backZ, carcZ);
  addBox(B, 'sage', nx0, nx1, ny1, height - 0.04, backZ, carcZ);
  addBox(B, 'dark', minX + 0.03, maxX - 0.03, 0, PLINTH, backZ, carcZ - 0.05);
  // Marco del hueco al ras de los frentes
  addBox(B, 'sage', minX, nx0, ny0, ny1, carcZ, frontZ);
  addBox(B, 'sage', nx1, maxX, ny0, ny1, carcZ, frontZ);
  // Interior oscuro del hueco
  const e = 0.001;
  B.add('dark', new THREE.PlaneGeometry(nx1 - nx0, ny1 - ny0), M(OVEN.front.x, OVEN.front.y, nz + e));
  B.add('dark', new THREE.PlaneGeometry(frontZ - nz, ny1 - ny0), M(nx0 + e, OVEN.front.y, (frontZ + nz) / 2, 0, HALF_PI, 0));
  B.add('dark', new THREE.PlaneGeometry(frontZ - nz, ny1 - ny0), M(nx1 - e, OVEN.front.y, (frontZ + nz) / 2, 0, -HALF_PI, 0));
  B.add('dark', new THREE.PlaneGeometry(nx1 - nx0, frontZ - nz), M(OVEN.front.x, ny0 + e, (frontZ + nz) / 2, -HALF_PI, 0, 0));
  B.add('dark', new THREE.PlaneGeometry(nx1 - nx0, frontZ - nz), M(OVEN.front.x, ny1 - e, (frontZ + nz) / 2, HALF_PI, 0, 0));
  // Cajón inferior, puerta superior y cornisa
  const cx = (minX + maxX) / 2, w = maxX - minX;
  addFront(B, G, 'sage', w, ny0 - PLINTH, M(cx, (PLINTH + ny0) / 2, carcZ), { type: 'bar', y: (ny0 - PLINTH) / 2 - 0.08, len: 0.3 });
  addFront(B, G, 'sage', w, height - 0.04 - ny1, M(cx, (ny1 + height - 0.04) / 2, carcZ), { type: 'bar', y: -(height - 0.04 - ny1) / 2 + 0.08, len: 0.3 });
  B.add('sage', new RoundedBoxGeometry(w + 0.03, 0.04, depth + 0.02, 2, 0.008), M(cx, height - 0.02, backZ + (depth + 0.02) / 2));
}

/** Paño colgado de la barra del cajón bajo el horno: cara delantera larga, vuelta y caída trasera. */
function buildTowel(B) {
  const ny0 = OVEN.front.y - OVEN.height / 2;
  const barY = ny0 - 0.08, barZ = OVEN.column.frontZ + 0.028, r = 0.0095;
  const w = 0.24, front = 0.34, back = 0.1, wrap = Math.PI * r, total = front + wrap + back;
  const g = new THREE.PlaneGeometry(w, 1, 10, 36);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), s = (p.getY(i) + 0.5) * total;
    let y, z;
    if (s < front) { // caída delantera con pliegues suaves que crecen hacia abajo
      const d = front - s, fold = Math.min(1, d / 0.12);
      y = barY - d; z = barZ + r + fold * (0.004 * Math.sin(x * 46 + 1.3) + 0.003 * Math.sin(x * 97)) + d * 0.02;
    } else if (s < front + wrap) {
      const a = (s - front) / r;
      y = barY + r * Math.sin(a); z = barZ + r * Math.cos(a);
    } else {
      y = barY - (s - front - wrap); z = barZ - r;
    }
    p.setXYZ(i, x * (1 + Math.max(0, front - s) * 0.08), y, z);
  }
  g.computeVertexNormals();
  B.add('towel', g, M(OVEN.front.x - 0.07, 0, 0));
}

// ---------------------------------------------------------------------------
// Nevera retro con imanes y notas
// ---------------------------------------------------------------------------
function buildFridge(B) {
  const { minX, maxX, frontZ, height } = FRIDGE;
  const w = maxX - minX, cx = (minX + maxX) / 2, bodyZ0 = BACK + 0.02, bodyZ1 = frontZ - 0.06;
  B.add('fridge', new RoundedBoxGeometry(w, height - 0.12, bodyZ1 - bodyZ0, 5, 0.09), M(cx, 0.12 + (height - 0.12) / 2, (bodyZ0 + bodyZ1) / 2));
  const split = 1.42;
  B.add('fridge', new RoundedBoxGeometry(w - 0.012, height - 0.035 - split, 0.07, 4, 0.033), M(cx, (split + height - 0.035) / 2, frontZ - 0.035));
  B.add('fridge', new RoundedBoxGeometry(w - 0.012, split - 0.006 - 0.135, 0.07, 4, 0.033), M(cx, (0.135 + split - 0.006) / 2, frontZ - 0.035));
  // Patas cromadas y tiradores verticales
  for (const sx of [-1, 1]) for (const sz of [0, 1]) {
    B.add('steel', new THREE.CylinderGeometry(0.018, 0.012, 0.12, 12), M(cx + sx * (w / 2 - 0.08), 0.06, bodyZ0 + 0.08 + sz * 0.38));
  }
  const hx = minX + 0.07;
  for (const [ya, yb] of [[split + 0.08, split + 0.32], [split - 0.48, split - 0.06]]) {
    B.add('steel', new THREE.CapsuleGeometry(0.013, yb - ya, 4, 12), M(hx, (ya + yb) / 2, frontZ + 0.04));
    for (const y of [ya, yb]) B.add('steel', new RoundedBoxGeometry(0.034, 0.03, 0.045, 2, 0.008), M(hx, y, frontZ + 0.018));
  }
  B.add('steel', new RoundedBoxGeometry(w - 0.16, 0.014, 0.008, 2, 0.003), M(cx + 0.03, split - 0.1, frontZ + 0.003));
  // Imanes (cerámica brillante)
  const magnets = [[-0.215, 1.3, 0xd23f4f], [0.025, 1.24, 0x3a7bc8], [0.245, 1.05, 0xf2c230], [-0.135, 0.92, 0x5c9a4a], [0.175, 1.7, 0xe07b39], [-0.045, 1.79, 0x2f8f8a]];
  for (const [dx, y, col] of magnets) {
    B.add('ceramic', new THREE.CylinderGeometry(0.016, 0.017, 0.012, 20).rotateX(HALF_PI), M(cx + dx, y, frontZ + 0.006), { color: col });
  }
  B.add('ceramic', new THREE.SphereGeometry(0.022, 16, 12), M(cx + 0.125, 1.33, frontZ + 0.012, 0, 0, 0.5, 1.3, 1, 0.55), { color: 0xf5d33a });
  // Notas (atlas: dibujo, receta, postal)
  const notes = [
    { cell: [0, 170], dx: -0.155, y: 1.1, w: 0.15, h: 0.225, rz: 0.05 },
    { cell: [172, 340], dx: 0.105, y: 1.22, w: 0.14, h: 0.21, rz: -0.06 },
    { cell: [342, 512], dx: -0.025, y: 1.7, w: 0.15, h: 0.225, rz: 0.04 },
  ];
  for (const n of notes) {
    B.add('notes', new THREE.PlaneGeometry(n.w, n.h), M(cx + n.dx, n.y, frontZ + 0.0015, 0, 0, n.rz), { uv: atlasUV(n.cell[0] / 512, 0, n.cell[1] / 512, 1) });
  }
}

// ---------------------------------------------------------------------------
// Ventana (marco, cristal, alféizar de piedra, paisaje exterior)
// ---------------------------------------------------------------------------
function buildWindow(B, group, T) {
  const { x0, x1, y0, y1 } = WIN, xm = (x0 + x1) / 2;
  const zf = BACK - 0.14, fd = 0.07, k = 'sage';
  addBox(B, k, x0, x0 + 0.055, y0, y1, zf - fd, zf);
  addBox(B, k, x1 - 0.055, x1, y0, y1, zf - fd, zf);
  addBox(B, k, x0, x1, y1 - 0.055, y1, zf - fd, zf);
  addBox(B, k, x0, x1, y0, y0 + 0.06, zf - fd, zf + 0.01);
  // Dos hojas con tres cristales cada una
  const sy0 = y0 + 0.06, sy1 = y1 - 0.055, sz0 = zf - 0.055, sz1 = zf + 0.004;
  for (const [a, b] of [[x0 + 0.055, xm], [xm, x1 - 0.055]]) {
    addBox(B, k, a, a + 0.048, sy0, sy1, sz0, sz1);
    addBox(B, k, b - 0.048, b, sy0, sy1, sz0, sz1);
    addBox(B, k, a, b, sy1 - 0.048, sy1, sz0, sz1);
    addBox(B, k, a, b, sy0, sy0 + 0.068, sz0, sz1);
    const gy0 = sy0 + 0.068, gy1 = sy1 - 0.048;
    for (const t of [1 / 3, 2 / 3]) {
      const y = gy0 + (gy1 - gy0) * t;
      B.add(k, new RoundedBoxGeometry(b - a - 0.09, 0.02, 0.03, 2, 0.006), M((a + b) / 2, y, zf - 0.025));
    }
  }
  B.add('glass', new THREE.PlaneGeometry(x1 - x0 - 0.11, y1 - y0 - 0.11), M(xm, (y0 + y1) / 2 + 0.003, zf - 0.03));
  // Falleba de latón
  B.add('brass', new THREE.CylinderGeometry(0.007, 0.007, 0.5, 10), M(xm + 0.03, (y0 + y1) / 2, zf + 0.012));
  B.add('brass', new THREE.CapsuleGeometry(0.008, 0.07, 4, 8), M(xm + 0.03, (y0 + y1) / 2 - 0.02, zf + 0.03, HALF_PI * 0.2, 0, -0.3));
  // Alféizar de piedra
  const sillD = BACK + 0.04 - zf; // desde el marco hasta 4 cm fuera del muro
  B.add('stone', new RoundedBoxGeometry(x1 - x0 + 0.16, 0.045, sillD, 2, 0.01), M(xm, y0, zf + sillD / 2), { uv: boxUV(SIZES_TEX.stone) });
  // Paisaje pintado al fondo (sin sombras, sin tono-mapeo para que se vea luminoso)
  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(BACKDROP.w, BACKDROP.h),
    new THREE.MeshBasicMaterial({ map: T.backdrop, toneMapped: false, fog: false }),
  );
  backdrop.position.set(BACKDROP.x0 + BACKDROP.w / 2, BACKDROP.y0 + BACKDROP.h / 2, BACKDROP.z);
  backdrop.name = 'kitchen-backdrop';
  group.add(backdrop);
}

// ---------------------------------------------------------------------------
// Azulejos del frontal (InstancedMesh, hechos a mano: color, inclinación y relieve variables)
// ---------------------------------------------------------------------------
function buildTiles(B, group, mats) {
  const pitch = 0.096, size = 0.0925, th = 0.009, rows = 6;
  const xa = BACK_RUN.minX, xb = OVEN.column.minX;
  const sillBottom = WIN.y0 - 0.0225, sillL = WIN.x0 - 0.085, sillR = WIN.x1 + 0.085;
  const rng = makeRng(91);
  const plain = [], deco = [];
  for (let r = 0; r < rows; r++) {
    const yb = TOP + r * pitch, yc = yb + pitch / 2;
    const spans = yb < sillBottom ? [[xa, xb]] : [[xa, sillL], [sillR, xb]];
    for (const [a, b] of spans) {
      for (let x = a; x < b - 0.015; x += pitch) {
        const w = Math.min(pitch, b - x);
        (r === rows - 1 ? deco : plain).push({ x: x + w / 2, y: yc, sx: (w - (pitch - size)) / size });
      }
    }
    B.add('matte', new THREE.PlaneGeometry(spans.length > 1 ? sillL - xa : xb - xa, pitch), M(((spans.length > 1 ? sillL : xb) + xa) / 2, yc, BACK + 0.0015), { color: 0xd9d1c1 });
    if (spans.length > 1) B.add('matte', new THREE.PlaneGeometry(xb - sillR, pitch), M((xb + sillR) / 2, yc, BACK + 0.0015), { color: 0xd9d1c1 });
  }
  const geo = new RoundedBoxGeometry(size, size, th, 1, 0.0035);
  const m = new THREE.Matrix4(), col = new THREE.Color();
  const make = (items, mat, color, name) => {
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((t, i) => {
      const k = 1 + (rng() - 0.5) * 0.03;
      m.compose(
        _p.set(t.x + (rng() - 0.5) * 0.002, t.y + (rng() - 0.5) * 0.002, BACK + 0.002 + th / 2 + (rng() - 0.5) * 0.002),
        _q.setFromEuler(_e.set((rng() - 0.5) * 0.06, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.02)),
        _s.set(t.sx * k, k, 1),
      );
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, color(col));
    });
    mesh.name = name;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  // Zellige color crema con variación de tono por pieza; cenefa de azulejos pintados arriba
  make(plain, mats.tile, (c) => c.setHSL(0.09 + rng() * 0.04, 0.25 + rng() * 0.3, rng() < 0.15 ? 0.8 + rng() * 0.04 : 0.86 + rng() * 0.08, THREE.SRGBColorSpace), 'kitchen-tiles');
  make(deco, mats.azulejo, (c) => c.setHSL(0.1, 0.2, 0.92 + rng() * 0.08, THREE.SRGBColorSpace), 'kitchen-azulejos');
}

/** Sombras de contacto suaves (planos con alfa) que asientan muebles y objetos. */
function buildContactShadows(B) {
  const third = 1 / 3, box = atlasUV(0, 0, third, 1), round = atlasUV(third, 0, 2 * third, 1), soft = atlasUV(2 * third, 0, 1, 1);
  const floor = (x, z, w, d, uv) => B.add('contact', new THREE.PlaneGeometry(w, d).rotateX(-HALF_PI), M(x, 0.002, z), { uv });
  const wall = (x, y, w, h, uv, z = BACK + 0.0012) => B.add('contact', new THREE.PlaneGeometry(w, h), M(x, y, z), { uv });
  const top = (x, z, r) => B.add('contact', new THREE.PlaneGeometry(r * 2, r * 2).rotateX(-HALF_PI), M(x, TOP + 0.0012, z), { uv: round });
  floor(COUNTER.x, COUNTER.z, 2.85, 1.05, box);
  floor((BACK_RUN.minX + OVEN.column.minX) / 2, BACK_RUN.frontZ - 0.02, 4.75, 0.42, box);
  floor((OVEN.column.minX + FRIDGE.maxX) / 2, OVEN.column.frontZ - 0.02, 1.9, 0.42, box);
  for (const z of [-0.22, 0.2]) floor(-1.55, z, 0.62, 0.62, round);
  floor(ROOM.minX + 0.38, BACK + 0.42, 0.95, 0.95, round);
  floor(-2.5, -0.72, 0.75, 0.75, round);
  for (const [a, b] of [SHELF_L, SHELF_R]) wall((a + b) / 2, SHELF.y[1] - 0.02, b - a + 0.14, 0.22, soft);
  wall(CLOCK_POS.x + 0.01, CLOCK_POS.y - 0.025, 0.4, 0.4, soft);
  for (const [x, z, r] of [[-2.68, BACK + 0.22, 0.13], [-2.3, BACK + 0.22, 0.12], [0.42, BACK + 0.22, 0.1], [1.4, BACK + 0.22, 0.06], [1.48, BACK + 0.29, 0.07]]) top(x, z, r);
}

// ---------------------------------------------------------------------------
// Hojas (todas las plantas y la espiga comparten un InstancedMesh)
// ---------------------------------------------------------------------------
class LeafSet {
  constructor() { this.items = []; }
  /** Hoja con base en `pos`, apuntando a `dir`, con la cara hacia `up`. */
  add(pos, dir, up, len, width, color) {
    const y = dir.clone().normalize();
    const z = up.clone().addScaledVector(y, -up.dot(y));
    if (z.lengthSq() < 1e-6) z.set(0, 0, 1).addScaledVector(y, -y.z);
    z.normalize();
    const x = new V3().crossVectors(y, z);
    const m = new THREE.Matrix4().makeBasis(x, y, z).scale(new V3(width, len, width));
    m.setPosition(pos);
    this.items.push({ m, color: new THREE.Color(color) });
  }
  build(mat) {
    const g = new THREE.PlaneGeometry(1, 1, 2, 4).translate(0, 0.5, 0);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i), x = p.getX(i);
      const wdt = Math.sin(Math.PI * Math.pow(t, 0.8));
      p.setX(i, x * wdt);
      p.setZ(i, -Math.abs(x * wdt) * 0.35 - t * t * 0.25);
    }
    g.computeVertexNormals();
    const mesh = new THREE.InstancedMesh(g, mat, this.items.length);
    this.items.forEach((it, i) => { mesh.setMatrixAt(i, it.m); mesh.setColorAt(i, it.color); });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'kitchen-leaves';
    return mesh;
  }
}

const UP = new V3(0, 1, 0);
const greenish = (rng, h = 0.27, s = 0.45, l = 0.32) => new THREE.Color().setHSL(h + (rng() - 0.5) * 0.04, s + (rng() - 0.5) * 0.15, l + (rng() - 0.5) * 0.1, THREE.SRGBColorSpace);

/** Maceta de barro (con plato y tierra). */
function addPot(B, x, y, z, r, h, color = COLORS.terracotta) {
  B.add('terracotta', lathe([[0, 0], [r * 0.72, 0], [r * 0.74, 0.004], [r * 0.95, h * 0.8], [r * 1.04, h * 0.82], [r * 1.05, h], [r * 0.93, h], [r * 0.92, h * 0.86], [0, h * 0.86]], 24), M(x, y, z), { color });
  B.add('matte', new THREE.CircleGeometry(r * 0.92, 20).rotateX(-HALF_PI), M(x, y + h * 0.84, z), { color: COLORS.soil });
}

/** Mata de hierbas: tallos que salen de la tierra con hojas alternas. */
function addHerb(B, L, rng, { x, y, z, stems, height, leafLen, leafW, leaves, hue = 0.27, light = 0.33, stemCol = 0x5b7a3a }) {
  for (let s = 0; s < stems; s++) {
    const a = rng() * TAU, lean = 0.15 + rng() * 0.35, hgt = height * (0.7 + rng() * 0.3);
    const top = new V3(x + Math.cos(a) * lean * hgt, y + hgt, z + Math.sin(a) * lean * hgt);
    const base = new V3(x + Math.cos(a) * 0.01, y, z + Math.sin(a) * 0.01);
    B.add('matte', tube([base.toArray(), base.clone().lerp(top, 0.5).add(new V3(0, 0.01, 0)).toArray(), top.toArray()], 0.0018, 6, 4), null, { color: stemCol });
    for (let k = 0; k < leaves; k++) {
      const t = 0.25 + (k / leaves) * 0.75, pos = base.clone().lerp(top, t);
      const ang = a + k * 2.4 + rng() * 0.4, out = new V3(Math.cos(ang), 0.5 + rng() * 0.6, Math.sin(ang));
      const sz = 1 - t * 0.45;
      L.add(pos, out, UP, leafLen * sz, leafW * sz, greenish(rng, hue, 0.45, light));
    }
  }
}

function buildPlants(B, L) {
  const rng = makeRng(101);
  // Alféizar: albahaca y romero
  const sillY = WIN.y0 + 0.0225, sz = BACK - 0.05;
  addPot(B, WIN.x0 + 0.17, sillY, sz, 0.055, 0.1);
  addHerb(B, L, rng, { x: WIN.x0 + 0.17, y: sillY + 0.085, z: sz, stems: 6, height: 0.13, leafLen: 0.045, leafW: 0.03, leaves: 6, hue: 0.28, light: 0.36 });
  addPot(B, WIN.x1 - 0.15, sillY, sz, 0.05, 0.095, 0xb9653f);
  addHerb(B, L, rng, { x: WIN.x1 - 0.15, y: sillY + 0.08, z: sz, stems: 9, height: 0.2, leafLen: 0.026, leafW: 0.005, leaves: 12, hue: 0.33, light: 0.27, stemCol: 0x6a6040 });
  // Potos colgante en la balda superior izquierda
  const py = SHELF.y[1] + SHELF.t, px = -2.0, pz = BACK + 0.12;
  addPot(B, px, py, pz, 0.065, 0.11, 0xd9cdb8);
  const vines = [[-0.12, 0.42], [0.03, 0.3], [0.15, 0.38], [-0.04, 0.22], [0.09, 0.5]];
  for (const [dx, drop] of vines) {
    const pts = [
      new V3(px + dx * 0.3, py + 0.11, pz), new V3(px + dx * 0.7, py + 0.08, pz + 0.1),
      new V3(px + dx, py - 0.03, BACK + SHELF.d + 0.03), new V3(px + dx * 1.3, py - drop * 0.6, BACK + SHELF.d + 0.05),
      new V3(px + dx * 1.5, py - drop, BACK + SHELF.d + 0.035),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    B.add('matte', new THREE.TubeGeometry(curve, 20, 0.002, 4), null, { color: 0x5e7c37 });
    const n = Math.round(drop * 28);
    for (let k = 0; k < n; k++) {
      const t = 0.1 + (k / n) * 0.9, pos = curve.getPoint(t);
      const side = k % 2 ? 1 : -1;
      const dir = new V3(side * 0.7, -0.2 + rng() * 0.4, 0.6 + rng() * 0.3);
      const col = greenish(rng, 0.25 + rng() * 0.03, 0.5, 0.33 + rng() * 0.08);
      L.add(pos, dir, new V3(0, 0.6, 1), 0.05 + rng() * 0.02, 0.04 + rng() * 0.015, col);
    }
  }
  for (let k = 0; k < 14; k++) {
    const a = rng() * TAU;
    L.add(new V3(px + Math.cos(a) * 0.02, py + 0.1, pz + Math.sin(a) * 0.02), new V3(Math.cos(a), 0.9, Math.sin(a)), UP, 0.06, 0.045, greenish(rng, 0.26, 0.5, 0.33));
  }
  // Tomillo en la balda inferior derecha
  addPot(B, 1.47, SHELF.y[0] + SHELF.t, BACK + 0.12, 0.045, 0.08);
  addHerb(B, L, rng, { x: 1.47, y: SHELF.y[0] + SHELF.t + 0.07, z: BACK + 0.12, stems: 10, height: 0.1, leafLen: 0.012, leafW: 0.007, leaves: 9, hue: 0.25, light: 0.3, stemCol: 0x6c5a3c });
  // Olivo en maceta grande en la esquina izquierda
  const ox = ROOM.minX + 0.38, oz = BACK + 0.42;
  addPot(B, ox, 0, oz, 0.23, 0.42, 0xc06a42);
  const trunkTop = new V3(ox + 0.05, 1.05, oz + 0.02);
  B.add('matte', tube([[ox, 0.35, oz], [ox - 0.03, 0.6, oz + 0.02], [ox + 0.04, 0.85, oz - 0.01], trunkTop.toArray()], 0.03, 20, 8), null, { color: COLORS.bark });
  const branches = [[0.38, 1.62, 0.12], [-0.28, 1.58, 0.18], [0.06, 1.86, -0.04], [0.3, 1.38, 0.34], [-0.22, 1.34, -0.12],
    [-0.04, 1.5, 0.38], [0.2, 1.75, -0.12], [-0.34, 1.78, -0.02], [0.42, 1.28, -0.05]];
  for (const [bx, by, bz] of branches) {
    const end = new V3(ox + bx, by, oz + bz);
    const mid = trunkTop.clone().lerp(end, 0.5).add(new V3((rng() - 0.5) * 0.08, 0.06, (rng() - 0.5) * 0.08));
    const curve = new THREE.CatmullRomCurve3([trunkTop, mid, end]);
    B.add('matte', new THREE.TubeGeometry(curve, 12, 0.011, 6), null, { color: COLORS.bark });
    for (let k = 0; k < 120; k++) {
      const t = 0.35 + rng() * 0.65, spread = 0.08 + t * 0.14;
      const pos = curve.getPoint(t).add(new V3((rng() - 0.5) * spread * 2, (rng() - 0.5) * spread * 1.4, (rng() - 0.5) * spread * 2));
      const dir = new V3(rng() - 0.5, rng() * 0.7 - 0.2, rng() - 0.5);
      const c = new THREE.Color().setHSL(0.19 + rng() * 0.05, 0.16 + rng() * 0.12, 0.33 + rng() * 0.16, THREE.SRGBColorSpace);
      L.add(pos, dir, UP, 0.06 + rng() * 0.025, 0.014, c);
    }
  }
}

// ---------------------------------------------------------------------------
// Baldas, tarros, libros, vajilla, barra de utensilios
// ---------------------------------------------------------------------------
function addJar(B, x, y, z, r, h, content, fill, label) {
  B.add('jarGlass', lathe([[0, 0.001], [r - 0.006, 0], [r, 0.006], [r, h * 0.84], [r * 0.9, h * 0.9], [r * 0.82, h * 0.92], [r * 0.82, h]], 28), M(x, y, z));
  const ch = (h * 0.84) * fill;
  const cu = (content % 4) / 4, cv = 1 - (((content / 4) | 0) + 1) / 2;
  B.add('contents', new THREE.CylinderGeometry(r - 0.004, r - 0.004, ch, 24), M(x, y + 0.003 + ch / 2, z), { uv: atlasUV(cu, cv, cu + 0.25, cv + 0.5) });
  B.add('oak', lathe([[0, h + 0.03], [r * 0.86, h + 0.03], [r * 0.88, h + 0.026], [r * 0.88, h - 0.002], [r * 0.8, h - 0.002]], 24), M(x, y, z), { color: 0xc49b6c });
  if (label != null) {
    const lu = (label % 2) / 2, lv = 1 - (((label / 2) | 0) + 1) / 4;
    B.add('labels', new THREE.CylinderGeometry(r + 0.0015, r + 0.0015, 0.05, 16, 1, true, -0.62, 1.24), M(x, y + h * 0.42, z), { uv: atlasUV(lu, lv, lu + 0.5, lv + 0.25) });
  }
}

function addPlateStack(B, x, y, z, r, n, color) {
  const g = lathe([[0, 0], [r * 0.6, 0], [r * 0.64, 0.005], [r * 0.96, 0.016], [r, 0.019], [r * 0.97, 0.021], [r * 0.6, 0.009], [0, 0.009]], 32);
  for (let i = 0; i < n; i++) B.add('ceramic', g, M(x + (i % 2) * 0.002, y + i * 0.0145, z), { color });
}

function addBowl(B, x, y, z, r, h, color, key = 'ceramic') {
  const g = lathe([[0, 0], [r * 0.5, 0], [r * 0.52, 0.004], [r * 0.85, h * 0.5], [r, h], [r * 0.95, h], [r * 0.8, h * 0.52], [r * 0.45, h * 0.12], [0, h * 0.12]], 28);
  B.add(key, g, M(x, y, z), { color });
}

function addMug(B, x, y, z, color, rot = 0) {
  const r = 0.038, h = 0.09;
  B.add('ceramic', lathe([[0, 0], [r * 0.9, 0], [r, 0.008], [r, h], [r - 0.004, h], [r - 0.004, 0.01], [0, 0.01]], 24), M(x, y, z), { color });
  B.add('ceramic', new THREE.TorusGeometry(0.022, 0.006, 8, 16, Math.PI), M(x + Math.cos(rot) * r, y + h / 2, z - Math.sin(rot) * r, 0, rot, -HALF_PI), { color });
}

function addJug(B, x, y, z, h, color) {
  B.add('ceramic', lathe([[0, 0], [h * 0.3, 0], [h * 0.34, h * 0.05], [h * 0.36, h * 0.35], [h * 0.26, h * 0.7], [h * 0.22, h * 0.86], [h * 0.25, h], [h * 0.22, h], [h * 0.19, h * 0.86], [h * 0.2, h * 0.7], [0, h * 0.7]], 24), M(x, y, z), { color });
  B.add('ceramic', new THREE.TorusGeometry(h * 0.2, h * 0.035, 8, 16, Math.PI * 1.1), M(x + h * 0.3, y + h * 0.6, z, 0, 0, -HALF_PI - 0.1), { color });
}

function buildShelves(B) {
  const ou = boxUV(SIZES_TEX.oak), rng = makeRng(111);
  for (const [a, b] of [SHELF_L, SHELF_R]) {
    for (const y of SHELF.y) {
      B.add('oak', new RoundedBoxGeometry(b - a, SHELF.t, SHELF.d, 2, 0.006), M((a + b) / 2, y + SHELF.t / 2, BACK + SHELF.d / 2), { uv: ou, color: 0xe2c49c });
      for (const x of [a + 0.12, b - 0.12]) { // escuadras de latón
        B.add('brass', new THREE.BoxGeometry(0.012, 0.11, 0.006), M(x, y - 0.055, BACK + 0.003));
        B.add('brass', new THREE.BoxGeometry(0.012, 0.006, SHELF.d - 0.04), M(x, y - 0.003, BACK + (SHELF.d - 0.04) / 2));
        B.add('brass', new THREE.BoxGeometry(0.01, 0.006, 0.17), M(x, y - 0.055, BACK + 0.07, Math.PI / 4.4, 0, 0));
      }
    }
  }
  const zc = BACK + SHELF.d / 2 + 0.01;
  // Izquierda abajo: tarros de despensa
  const y0 = SHELF.y[0] + SHELF.t;
  const jars = [[-2.69, 0.064, 0.24, 0, 0.82, 0], [-2.54, 0.054, 0.27, 1, 0.86, 1], [-2.4, 0.055, 0.2, 2, 0.74, 2], [-2.265, 0.05, 0.18, 3, 0.7, 3], [-2.125, 0.05, 0.22, 4, 0.8, 4], [-1.985, 0.058, 0.2, 5, 0.66, 5]];
  for (const [x, r, h, c, f, l] of jars) addJar(B, x, y0, zc, r, h, c, f, l);
  addBowl(B, -1.79, y0, zc, 0.085, 0.06, 0x2f6aa3);
  addBowl(B, -1.79, y0 + 0.045, zc, 0.075, 0.055, 0xf0e8d8);
  addBowl(B, -1.79, y0 + 0.088, zc, 0.066, 0.05, 0xd9894f);
  // Izquierda arriba: libros de cocina, potos (en buildPlants) y jarra
  const y1 = SHELF.y[1] + SHELF.t;
  const bookCols = [0x8c2f2a, 0x2e4a6b, 0xc59a45, 0x3f6a4a, 0xe8dcc4, 0x7a3b5a, 0xa7552f, 0x37474f];
  let bx = SHELF_L[0] + 0.03;
  bookCols.forEach((col, i) => {
    const t = 0.024 + rng() * 0.022, h = 0.2 + rng() * 0.07, d = 0.15 + rng() * 0.04;
    const lean = i === bookCols.length - 1 ? -0.18 : 0;
    B.add('books', new RoundedBoxGeometry(t, h, d, 1, 0.003), M(bx + t / 2 + (lean ? 0.03 : 0), y1 + h / 2 - (lean ? 0.004 : 0), BACK + 0.03 + d / 2, 0, 0, lean), { color: col });
    bx += t + 0.002;
  });
  B.add('books', new RoundedBoxGeometry(0.2, 0.03, 0.15, 1, 0.003), M(bx + 0.16, y1 + 0.015, zc, 0, 0.1, 0), { color: 0x6a8f6b });
  B.add('books', new RoundedBoxGeometry(0.17, 0.025, 0.13, 1, 0.003), M(bx + 0.16, y1 + 0.0425, zc, 0, -0.06, 0), { color: 0xd4b06a });
  addJug(B, -1.74, y1, zc, 0.17, 0xf1e9da);
  // Derecha abajo: pilas de platos, cuencos y tazas (tomillo en buildPlants)
  addPlateStack(B, 0.72, y0, zc - 0.005, 0.11, 7, 0xf7f3ea);
  addPlateStack(B, 0.95, y0, zc - 0.005, 0.085, 6, 0x9dc3c1);
  [[1.12, 0xd9894f, 0.5], [1.22, 0xf2e8d5, 0.3], [1.32, 0x2f6aa3, 0.7]].forEach(([x, col, r]) => addMug(B, x, y0, zc, col, r));
  // Derecha arriba: platos pintados apoyados en la pared y tarros de café y azúcar
  for (const [x, rz] of [[0.74, 0.04], [1.0, -0.05]]) {
    const base = mul(M(x, y1 + 0.116, BACK + 0.045), M(0, 0, 0, HALF_PI - 0.2, 0, rz));
    B.add('ceramic', lathe([[0, 0], [0.07, 0], [0.074, 0.004], [0.112, 0.016], [0.118, 0.02], [0.114, 0.022], [0.074, 0.009], [0, 0.009]], 32), mul(base, M(0, -0.012, 0)), { color: 0xf7f2e6 });
    B.add('plates', new THREE.CircleGeometry(0.104, 32).rotateX(-HALF_PI), mul(base, M(0, 0.0092, 0)));
  }
  addJar(B, 1.23, y1, zc, 0.055, 0.19, 6, 0.7, 6);
  addJar(B, 1.38, y1, zc, 0.055, 0.17, 7, 0.75, 7);
  addBowl(B, 1.52, y1, zc, 0.06, 0.05, 0xd9894f);
}

/** Barra de latón con utensilios colgados (cazo, varillas, cazos de cobre, espátula). */
function buildRail(B) {
  const y = 1.34, z = BACK + 0.045, xa = SHELF_R[0] + 0.1, xb = SHELF_R[1] - 0.08;
  B.add('brass', new THREE.CylinderGeometry(0.0075, 0.0075, xb - xa, 12), M((xa + xb) / 2, y, z, 0, 0, HALF_PI));
  for (const x of [xa, xb]) {
    B.add('brass', new THREE.SphereGeometry(0.011, 12, 8), M(x, y, z));
    B.add('brass', new THREE.CylinderGeometry(0.005, 0.005, 0.045, 8), M(x, y, BACK + 0.022, HALF_PI, 0, 0));
    B.add('brass', new THREE.CylinderGeometry(0.018, 0.018, 0.006, 16), M(x, y, BACK + 0.003, HALF_PI, 0, 0));
  }
  const hook = tube([[0, -0.002, -0.011], [0, 0.011, -0.006], [0, 0.012, 0.006], [0, 0, 0.011], [0, -0.025, 0.01], [0, -0.045, 0.004], [0, -0.054, 0.009], [0, -0.05, 0.016]], 0.0018, 24, 5);
  const hooks = [0.74, 0.88, 1.03, 1.2, 1.36];
  hooks.forEach((x) => B.add('steel', hook, M(x, y, z)));
  const hy = y - 0.054, hz = z + 0.009;
  // Cazo (acero)
  {
    const x = hooks[0];
    B.add('steel', new THREE.TorusGeometry(0.008, 0.002, 6, 12), M(x, hy - 0.002, hz));
    B.add('steel', new THREE.CapsuleGeometry(0.0045, 0.21, 3, 8), M(x, hy - 0.12, hz + 0.004));
    const r = 0.042;
    const pts = [];
    for (let i = 0; i <= 10; i++) { const a = (i / 10) * HALF_PI; pts.push([Math.sin(a) * r, -Math.cos(a) * r]); }
    for (let i = 10; i >= 0; i--) { const a = (i / 10) * HALF_PI; pts.push([Math.sin(a) * (r - 0.002), -Math.cos(a) * (r - 0.002) + 0.0005]); }
    B.add('steel', lathe(pts, 24), M(x, hy - 0.26, hz + 0.03, -HALF_PI + 0.25, 0, 0));
  }
  // Varillas
  {
    const x = hooks[1];
    B.add('steel', new THREE.TorusGeometry(0.007, 0.002, 6, 12), M(x, hy - 0.002, hz));
    B.add('oak', new THREE.CapsuleGeometry(0.011, 0.09, 4, 12), M(x, hy - 0.065, hz), { color: 0xb88a58 });
    const loop = tube([[0.006, 0, 0], [0.024, -0.05, 0], [0.034, -0.11, 0], [0.022, -0.16, 0], [0, -0.176, 0], [-0.022, -0.16, 0], [-0.034, -0.11, 0], [-0.024, -0.05, 0], [-0.006, 0, 0]], 0.0012, 40, 4);
    for (let k = 0; k < 4; k++) B.add('steel', loop, M(x, hy - 0.115, hz, 0, (k * Math.PI) / 4, 0));
  }
  // Cazos de cobre colgados del mango (fondo hacia la cocina)
  for (const [x, r] of [[hooks[2], 0.075], [hooks[4], 0.058]]) {
    const h = r * 0.8;
    const body = lathe([[0, 0], [r * 0.9, 0], [r, r * 0.12], [r, h], [r - 0.003, h], [r - 0.003, 0.004], [0, 0.004]], 32);
    const cy = hy - 0.13 - r;
    B.add('copper', body, M(x, cy, hz + 0.02 + h, -HALF_PI, 0, 0));
    B.add('brass', new RoundedBoxGeometry(0.018, 0.13, 0.006, 1, 0.002), M(x, hy - 0.068, hz + 0.016));
    B.add('brass', new THREE.TorusGeometry(0.008, 0.0025, 6, 12), M(x, hy - 0.002, hz));
  }
  // Espátula de madera
  {
    const x = hooks[3];
    B.add('iron', new THREE.TorusGeometry(0.01, 0.002, 6, 12), M(x, hy - 0.006, hz));
    B.add('oak', new THREE.CapsuleGeometry(0.007, 0.18, 4, 8), M(x, hy - 0.11, hz), { color: 0xc9a074 });
    B.add('oak', new RoundedBoxGeometry(0.06, 0.09, 0.008, 2, 0.004), M(x, hy - 0.25, hz), { color: 0xc9a074 });
  }
}

// ---------------------------------------------------------------------------
// Decoración: mortero, espigas, botes, tablas, taburetes, saco, frutero de la isla
// ---------------------------------------------------------------------------
function buildDecor(B, L) {
  const rng = makeRng(121);
  const zb = BACK + 0.22;
  // Jarra con espigas de trigo (tema del pan)
  const jx = -2.68;
  addJug(B, jx, TOP, zb, 0.2, 0xe9e1cf);
  for (let k = 0; k < 11; k++) {
    const a = (k / 11) * TAU + rng() * 0.3, lean = 0.12 + rng() * 0.12, len = 0.3 + rng() * 0.05;
    const base = new V3(jx + Math.cos(a) * 0.01, TOP + 0.14, zb + Math.sin(a) * 0.01);
    const tip = base.clone().add(new V3(Math.cos(a) * lean, 1, Math.sin(a) * lean * 0.6).normalize().multiplyScalar(len));
    B.add('matte', tube([base.toArray(), base.clone().lerp(tip, 0.5).toArray(), tip.toArray()], 0.0016, 6, 4), null, { color: COLORS.straw });
    const dir = tip.clone().sub(base).normalize();
    for (let j = 0; j < 14; j++) {
      const t = j / 14, pos = tip.clone().addScaledVector(dir, -0.06 + t * 0.06);
      const side = j % 2 ? 1 : -1, sideV = new V3(-dir.z, 0, dir.x).normalize().multiplyScalar(side * 0.6);
      const c = new THREE.Color().setHSL(0.11 + rng() * 0.02, 0.55, 0.55 + rng() * 0.08, THREE.SRGBColorSpace);
      L.add(pos, dir.clone().add(sideV), new V3(0, 0, 1), 0.016, 0.008, c);
    }
  }
  // Mortero de piedra con mano
  const mx = -2.3;
  B.add('stone', lathe([[0, 0], [0.06, 0], [0.068, 0.01], [0.07, 0.06], [0.064, 0.075], [0.058, 0.075], [0.055, 0.06], [0.04, 0.03], [0, 0.025]], 28), M(mx, TOP, zb), { uv: boxUV(SIZES_TEX.stone) });
  B.add('oak', new THREE.CapsuleGeometry(0.013, 0.11, 4, 12), M(mx + 0.02, TOP + 0.1, zb, 0, 0, -0.5), { color: 0xa47a52 });
  // Bote de utensilios de madera y tablas apoyadas en los azulejos
  const ux = 0.42;
  B.add('ceramic', lathe([[0, 0], [0.055, 0], [0.058, 0.01], [0.06, 0.16], [0.064, 0.17], [0.058, 0.17], [0.054, 0.02], [0, 0.02]], 24), M(ux, TOP, zb), { color: 0x3f7f8c });
  [[-0.015, 0.008, 0.25, -0.12], [0.015, -0.01, 0.27, 0.1], [0.0, 0.015, 0.24, 0.03]].forEach(([dx, dz, l, rz], i) => {
    B.add('oak', new THREE.CapsuleGeometry(0.0065, l, 3, 8), M(ux + dx, TOP + 0.03 + l / 2, zb + dz, 0, 0, rz), { color: 0xc9a074 });
    const tip = M(ux + dx - Math.sin(rz) * (l + 0.02), TOP + 0.04 + l + 0.02, zb + dz, 0, 0, rz);
    if (i === 1) B.add('oak', new RoundedBoxGeometry(0.05, 0.07, 0.008, 2, 0.004), tip, { color: 0xc9a074 });
    else B.add('oak', new THREE.SphereGeometry(0.025, 14, 10), mul(tip, M(0, 0, 0, 0, 0, 0, 1, 1.25, 0.45)), { color: 0xc9a074 });
  });
  B.add('oak', new THREE.CylinderGeometry(0.16, 0.16, 0.022, 40), M(0.13, TOP + 0.16, BACK + 0.05, HALF_PI - 0.2, 0, 0.05), { uv: boxUV(SIZES_TEX.oak), color: 0xd0a774 });
  B.add('oak', new RoundedBoxGeometry(0.24, 0.36, 0.02, 2, 0.008), M(0.2, TOP + 0.18, BACK + 0.065, -0.2, 0, -0.05), { uv: boxUV(SIZES_TEX.oak), color: 0xb98d5f });
  // Molinillo y salero junto al fuego
  B.add('oak', lathe([[0, 0], [0.026, 0], [0.028, 0.02], [0.022, 0.06], [0.026, 0.12], [0.02, 0.15], [0.012, 0.165], [0.006, 0.175], [0, 0.175]], 16), M(1.4, TOP, zb), { color: 0x7a4f2e });
  B.add('ceramic', lathe([[0, 0], [0.034, 0], [0.04, 0.03], [0.036, 0.06], [0.02, 0.07], [0, 0.07]], 20), M(1.48, TOP, zb + 0.07), { color: 0xf2ece0 });
  // Frutero pequeño en el extremo izquierdo de la isla (x < -1.15)
  const fx = -1.225, fz = 0.3;
  addBowl(B, fx, TOP, fz, 0.068, 0.04, 0xffffff, 'oak');
  const lemon = lathe(Array.from({ length: 13 }, (_, i) => {
    const t = i / 12, a = t * Math.PI;
    return [Math.sin(a) * 0.026 * (1 - 0.15 * Math.pow(Math.cos(a), 8)) + 0.0001, -Math.cos(a) * 0.034];
  }), 16);
  [[-0.022, 0.03, -0.012, 0.3, 0.2], [0.02, 0.03, 0.01, -0.4, 1.4], [0.0, 0.055, -0.004, 0.2, 2.4]].forEach(([dx, dy, dz, rx, ry]) => {
    B.add('satin', lemon, M(fx + dx, TOP + dy, fz + dz, HALF_PI + rx, ry, 0), { color: 0xf3cf38 });
  });
  B.add('matte', new THREE.PlaneGeometry(0.03, 0.05).translate(0, 0.025, 0), M(fx + 0.01, TOP + 0.08, fz, -0.8, 0.5, 0), { color: 0x4f7a34 });
  // Taburetes en el extremo izquierdo de la isla
  for (const sz of [-0.22, 0.2]) {
    const sx = -1.55, sy = 0.66;
    B.add('oak', lathe([[0, 0], [0.16, 0], [0.172, 0.012], [0.172, 0.03], [0.16, 0.04], [0, 0.04]], 32), M(sx, sy - 0.04, sz), { uv: boxUV(SIZES_TEX.oak), color: 0xc49563 });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * TAU + Math.PI / 4;
      B.add('iron', tube([[Math.cos(a) * 0.1, sy - 0.04, Math.sin(a) * 0.1], [Math.cos(a) * 0.15, 0.25, Math.sin(a) * 0.15], [Math.cos(a) * 0.17, 0.0, Math.sin(a) * 0.17]], 0.0085, 10, 6), M(sx, 0, sz));
    }
    B.add('iron', new THREE.TorusGeometry(0.152, 0.007, 6, 32), M(sx, 0.24, sz, HALF_PI, 0, 0));
  }
  // Saco de harina en el suelo
  const sx = -2.5, szz = -0.72;
  const prof = [[0, 0], [0.12, 0], [0.17, 0.03], [0.19, 0.14], [0.185, 0.28], [0.16, 0.36], [0.15, 0.4], [0.17, 0.42], [0.175, 0.44], [0.15, 0.445], [0.14, 0.43], [0.13, 0.415]];
  const sack = lathe(prof, 32);
  const sp = sack.attributes.position, suv = sack.attributes.uv;
  for (let i = 0; i < sp.count; i++) {
    const x = sp.getX(i), y = sp.getY(i), z = sp.getZ(i), a = Math.atan2(z, x);
    const bump = 1 + 0.05 * Math.sin(a * 5 + y * 20) * Math.sin(y * 9) + 0.03 * Math.sin(a * 11 - y * 31);
    sp.setXYZ(i, x * bump * (z > 0 ? 1 : 0.85), y * (1 - 0.04 * Math.cos(a * 3)), z * bump);
    suv.setY(i, 0.12 + suv.getY(i) * 0.88);
  }
  sack.computeVertexNormals();
  B.add('burlap', sack, M(sx, 0, szz, 0, -0.4, 0));
  const flourTop = new THREE.SphereGeometry(0.135, 24, 8, 0, TAU, 0, 0.5).scale(1, 0.5, 1);
  B.add('burlap', flourTop, M(sx, 0.36, szz), { uv: atlasUV(0.1, 0.0, 0.9, 0.1) });
}

// ---------------------------------------------------------------------------
// Reloj de pared (agujas animadas con setClock)
// ---------------------------------------------------------------------------
function buildClock(B, group, mats) {
  const { x, y, z } = CLOCK_POS, r = 0.145;
  B.add('iron', new THREE.CylinderGeometry(r, r, 0.035, 48), M(x, y, z + 0.0175, HALF_PI, 0, 0));
  B.add('brass', new THREE.TorusGeometry(r - 0.003, 0.009, 10, 48), M(x, y, z + 0.037));
  B.add('clockFace', new THREE.CircleGeometry(r - 0.008, 48), M(x, y, z + 0.0355));
  B.add('brass', new THREE.SphereGeometry(0.008, 12, 8), M(x, y, z + 0.044));
  const hand = (len, wid) => {
    const s = new THREE.Shape();
    s.moveTo(-wid, -0.018); s.lineTo(wid, -0.018); s.lineTo(wid * 0.55, len * 0.9); s.lineTo(0, len); s.lineTo(-wid * 0.55, len * 0.9); s.lineTo(-wid, -0.018);
    return new THREE.ExtrudeGeometry(s, { depth: 0.0015, bevelEnabled: false });
  };
  const hour = new THREE.Mesh(hand(0.075, 0.0055), mats.iron);
  const minute = new THREE.Mesh(hand(0.112, 0.0038), mats.iron);
  hour.position.set(x, y, z + 0.038);
  minute.position.set(x, y, z + 0.0405);
  hour.name = 'kitchen-clock-hour'; minute.name = 'kitchen-clock-minute';
  group.add(hour, minute);
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// Lámparas colgantes
// ---------------------------------------------------------------------------
function buildPendants(B) {
  const k = SHADE_R / 0.176;
  const prof = [[0.176, 0], [0.173, 0.012], [0.16, 0.05], [0.136, 0.098], [0.1, 0.142], [0.062, 0.172], [0.036, 0.19], [0.03, 0.205]].map(([r, y]) => [r * k, y * k]);
  const outer = lathe(prof, 40);
  const inner = lathe(prof.map(([r, y]) => [r * 0.965, y + 0.003]), 40);
  for (const x of PENDANT_X) {
    const y = PENDANT_Y;
    B.add('enamel', outer, M(x, y, 0));
    B.add('shadeInner', inner, M(x, y, 0));
    const top = 0.2 * k;
    B.add('brass', new THREE.TorusGeometry(SHADE_R - 0.001, 0.004, 6, 48), M(x, y, 0, HALF_PI, 0, 0));
    B.add('brass', lathe([[0.03, 0], [0.032, 0.035], [0.018, 0.055], [0.009, 0.065], [0, 0.065]], 20), M(x, y + top, 0));
    B.add('brass', new THREE.CylinderGeometry(0.016, 0.016, 0.05, 16), M(x, y + top - 0.045, 0));
    B.add('bulb', new THREE.SphereGeometry(0.038, 20, 14), M(x, y + 0.075, 0));
    B.add('iron', new THREE.CylinderGeometry(0.0035, 0.0035, ROOM.height - (y + top + 0.06), 6), M(x, (ROOM.height + y + top + 0.06) / 2, 0));
    B.add('brass', new THREE.CylinderGeometry(0.05, 0.055, 0.03, 24), M(x, ROOM.height - 0.015, 0));
  }
}

// ---------------------------------------------------------------------------
// Haces de luz por la ventana (aditivos, muy sutiles)
// ---------------------------------------------------------------------------
function buildLightShafts(group, T) {
  const dir = TO_SUN.clone().negate(), len = 3.2, zf = BACK - 0.14;
  const c = [[WIN.x0 + 0.06, WIN.y0 + 0.07], [WIN.x1 - 0.06, WIN.y0 + 0.07], [WIN.x1 - 0.06, WIN.y1 - 0.06], [WIN.x0 + 0.06, WIN.y1 - 0.06]]
    .map(([x, y]) => new V3(x, y, zf));
  const pos = [], uv = [];
  const quad = (a, b) => { // cara entre las aristas que salen de a y b
    const a2 = a.clone().addScaledVector(dir, len), b2 = b.clone().addScaledVector(dir, len);
    pos.push(...a.toArray(), ...b.toArray(), ...b2.toArray(), ...a.toArray(), ...b2.toArray(), ...a2.toArray());
    uv.push(0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0);
  };
  for (let i = 0; i < 4; i++) quad(c[i], c[(i + 1) % 4]);
  for (const t of [0.33, 0.66]) quad(c[0].clone().lerp(c[1], t), c[3].clone().lerp(c[2], t)); // láminas interiores
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Se desvanece cerca de la cámara para no velar los primeros planos
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: T.shaft }, color: { value: new THREE.Color(0xffd9a3) }, opacity: { value: 0.11 } },
    vertexShader: `varying vec2 vUv; varying float vDepth;
      void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `uniform sampler2D map; uniform vec3 color; uniform float opacity; varying vec2 vUv; varying float vDepth;
      void main() {
        float edge = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
        gl_FragColor = vec4(color, texture2D(map, vUv).a * opacity * edge * smoothstep(0.9, 2.2, vDepth));
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'kitchen-light-shafts';
  mesh.renderOrder = 2;
  group.add(mesh);
}

// ---------------------------------------------------------------------------
// Luces
// ---------------------------------------------------------------------------
/** Ajusta la cámara de sombras del sol a la caja de la habitación vista desde la luz. */
function fitSunShadow(sun) {
  const cam = new THREE.OrthographicCamera();
  cam.position.copy(sun.position);
  cam.lookAt(sun.target.position);
  cam.updateMatrixWorld();
  const inv = cam.matrixWorldInverse;
  const box = new THREE.Box3(new V3(ROOM.minX, 0, BACK - WALL_T), new V3(ROOM.maxX, ROOM.height, ROOM.frontZ));
  const min = new V3(Infinity, Infinity, Infinity), max = new V3(-Infinity, -Infinity, -Infinity), v = new V3();
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(inv);
    min.min(v); max.max(v);
  }
  const sc = sun.shadow.camera;
  sc.left = min.x - 0.05; sc.right = max.x + 0.05; sc.bottom = min.y - 0.05; sc.top = max.y + 0.05;
  sc.near = Math.max(0.1, -max.z - 0.5); sc.far = -min.z + 0.5;
  sc.updateProjectionMatrix();
}

function setupLights(ctx, group) {
  const lights = {};
  const engineLights = ctx.engine?.lights;
  if (engineLights?.sun) {
    const sun = engineLights.sun;
    // Sol de mañana bajo y cálido que entra por la ventana desde la izquierda
    sun.color.set(0xffd6a0);
    sun.intensity = 6.5;
    sun.target.position.set(-0.1, TOP, 0);
    sun.position.copy(sun.target.position).addScaledVector(TO_SUN, 9);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.025;
    fitSunShadow(sun);
    lights.sun = sun;
  }
  if (engineLights?.hemi) {
    const hemi = engineLights.hemi;
    hemi.color.set(0xfff0dc);
    hemi.groundColor.set(0xb58463);
    hemi.intensity = 0.42;
    lights.hemi = hemi;
  }
  // Lámparas: focos cálidos hacia la isla (solo el central con sombra)
  lights.pendants = PENDANT_X.map((x, i) => {
    const spot = new THREE.SpotLight(0xffc98c, i === 1 ? 2.3 : 1.1, 0, i === 1 ? 1.05 : 0.9, 0.9, 2);
    spot.position.set(x, PENDANT_Y + 0.075, 0);
    spot.target.position.set(x, TOP, 0);
    if (i === 1) {
      spot.castShadow = true;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.camera.near = 0.1;
      spot.shadow.camera.far = 2.5;
      spot.shadow.bias = -0.0006;
      spot.shadow.normalBias = 0.01;
    }
    group.add(spot, spot.target);
    return spot;
  });
  // Resplandor del horno (0 hasta que el juego lo encienda)
  const glow = new THREE.PointLight(0xff7a2e, 0, 3.5, 2);
  glow.position.set(OVEN.front.x, OVEN.front.y - 0.12, OVEN.front.z + 0.45);
  group.add(glow);
  lights.ovenGlow = glow;
  return lights;
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------
/**
 * Crea la cocina completa (habitación, muebles, decoración y luces) en coordenadas de mundo.
 * Ajusta además el sol/hemisferio del motor, la exposición y el fondo de la escena.
 * @param {{engine?: object, scene?: THREE.Scene, renderer?: THREE.WebGLRenderer}} ctx
 * @returns {{group: THREE.Group, update(dt: number, elapsed: number): void,
 *   setClock(minutesOfDay: number): void, setOvenGlow(level01: number): void,
 *   lights: {sun?: THREE.DirectionalLight, hemi?: THREE.HemisphereLight, pendants: THREE.SpotLight[], ovenGlow: THREE.PointLight}}}
 */
export function createKitchen(ctx = {}) {
  const group = new THREE.Group();
  group.name = 'kitchen';
  const T = makeTextures();
  const mats = makeMaterials(T);
  const G = makeCommonGeos();
  const B = new Batch();
  const L = new LeafSet();

  buildRoom(B, T);
  buildIsland(B, G);
  buildBackRun(B, G);
  buildOvenColumn(B, G);
  buildTowel(B);
  buildFridge(B);
  buildWindow(B, group, T);
  buildTiles(B, group, mats);
  buildShelves(B);
  buildRail(B);
  buildPlants(B, L);
  buildDecor(B, L);
  buildPendants(B);
  buildContactShadows(B);
  buildLightShafts(group, T);
  const hands = buildClock(B, group, mats);
  B.build(mats, group, { noCast: NO_CAST, noReceive: NO_RECEIVE });
  group.add(L.build(mats.leaf));

  const lights = setupLights(ctx, group);
  if (ctx.renderer) ctx.renderer.toneMappingExposure = 0.95;
  const scene = ctx.scene ?? ctx.engine?.scene;
  if (scene) scene.background = new THREE.Color(0xe9dcc8);

  // Estado animado
  let clockTarget = 9 * 60 + 30, clockShown = clockTarget;
  let glowTarget = 0, glowLevel = 0;
  const applyClock = (min) => {
    hands.minute.rotation.z = -((min % 60) / 60) * TAU;
    hands.hour.rotation.z = -((min % 720) / 720) * TAU;
  };
  applyClock(clockShown);

  return {
    group,
    lights,
    /** Avanza animaciones suaves (agujas del reloj, resplandor del horno). Nunca lanza. */
    update(dt, elapsed = 0) {
      try {
        const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
        if (Math.abs(clockTarget - clockShown) > 1e-3) {
          clockShown = Math.abs(clockTarget - clockShown) > 720 ? clockTarget : damp(clockShown, clockTarget, 6, d);
          applyClock(clockShown);
        }
        glowLevel = damp(glowLevel, glowTarget, 4, d);
        const flicker = glowLevel > 0.01 ? 1 + 0.04 * Math.sin(elapsed * 9.1) * Math.sin(elapsed * 3.7) : 1;
        lights.ovenGlow.intensity = glowLevel * 2.6 * flicker;
      } catch { /* la cocina es decorativa: nunca interrumpe el bucle */ }
    },
    /** Pone el reloj de pared en `minutesOfDay` (0..1440, se admiten valores mayores). */
    setClock(minutesOfDay) {
      if (Number.isFinite(minutesOfDay)) clockTarget = Math.max(0, minutesOfDay);
    },
    /** Luz anaranjada delante del horno: 0 = apagada, 1 = horno a tope. */
    setOvenGlow(level01) {
      if (Number.isFinite(level01)) glowTarget = clamp(level01, 0, 1);
    },
  };
}
