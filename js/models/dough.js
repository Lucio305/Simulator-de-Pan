// Masa / pan: el modelo protagonista del juego.
// Una única malla deformable (icoesfera soldada, ~15k vértices). Cada vértice tiene una dirección
// unitaria fija; su posición se recalcula (solo cuando algo cambia) a partir de una forma analítica
// + parámetros: volumen, hidratación, amasado, horneado, greñas, abolladuras...
// El microrrelieve (burbujas, ampollas, craquelado, harina) se hace en el shader por píxel.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, smoothstep, makeRng, noise3, fbm3, makeCanvasTexture, makeHighlighter } from '../core/utils.js';
import { SIZES } from '../core/layout.js';

const DETAIL = 38;        // subdivisión de la icoesfera (≈15k vértices)
const TOP_BIAS = 0.62;    // transformación conforme: concentra vértices en la mitad superior
const MAX_SEEDS = 600;
const MAX_DENTS = 12;
const SESAME_TOAST = new THREE.Color(0x9a5a22);
const DEFORM_KEYS = ['squash', 'stretch', 'stretchDir', 'rise', 'inTin']; // no cambian el color en crudo
// Parámetros que cambian poco a poco (fermentar, hornear...): se reconstruyen a ritmo limitado.
const SLOW_KEYS = new Set(['mix', 'smoothness', 'hydration', 'rise', 'collapse', 'bake', 'flour']);
const SHAPES = ['shaggy', 'ball', 'boule', 'baguette', 'loaf'];
const TOPPINGS = ['none', 'flour', 'sesame', 'poppy', 'eggwash'];
const TIN = { a: SIZES.tin.length / 2 - 0.003, c: SIZES.tin.width / 2 - 0.003, rim: SIZES.tin.height }; // interior del molde

/** 'eggwash+sesame' o ['eggwash', 'sesame'] → {flour, egg, seeds}; null si no es válida. */
function parseTopping(name) {
  const parts = Array.isArray(name) ? name : String(name ?? 'none').split('+');
  if (!parts.length || !parts.every((t) => TOPPINGS.includes(t))) return null;
  return {
    flour: parts.includes('flour'), egg: parts.includes('eggwash'),
    seeds: parts.includes('poppy') ? 'poppy' : parts.includes('sesame') ? 'sesame' : null,
  };
}

// Rampa de horneado (albedo sRGB): cruda → dorada → tostada → quemada. Algo más oscura y saturada
// que el color percibido porque la cocina está muy iluminada y ACES aclara/desatura las luces.
const RAMP_HEX = [0xe2c99e, 0xdfbf88, 0xcf9a58, 0xa46331, 0x6d3e21, 0x3a2213, 0x1d130d];
const RAMP_AT = [0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.4];
const RAMP = new Float32Array(RAMP_HEX.length * 3); // en espacio lineal (atributo de color)
RAMP_HEX.forEach((h, i) => { const c = new THREE.Color(h); RAMP[i * 3] = c.r; RAMP[i * 3 + 1] = c.g; RAMP[i * 3 + 2] = c.b; });

/** Color lineal de la rampa para un nivel de horneado b (0..1.4). */
function sampleRamp(b, out, o) {
  b = b < 0 ? 0 : b > 1.4 ? 1.4 : b;
  const k = b >= 1.25 ? 5 : Math.min(4, Math.floor(b / 0.25));
  const t = (b - RAMP_AT[k]) / (RAMP_AT[k + 1] - RAMP_AT[k]);
  const a = k * 3, c = a + 3;
  out[o] = RAMP[a] + (RAMP[c] - RAMP[a]) * t;
  out[o + 1] = RAMP[a + 1] + (RAMP[c + 1] - RAMP[a + 1]) * t;
  out[o + 2] = RAMP[a + 2] + (RAMP[c + 2] - RAMP[a + 2]) * t;
}

/** Igual que sampleRamp pero devuelve un color CSS sRGB (para la textura de la miga). */
function rampCss(b, mul = 1) {
  const tmp = [0, 0, 0];
  sampleRamp(b, tmp, 0);
  const c = new THREE.Color(tmp[0] * mul, tmp[1] * mul, tmp[2] * mul);
  return `#${c.getHexString()}`;
}

// ---------------------------------------------------------------------------------------------
// Topología compartida (todas las masas usan la misma malla base)
// ---------------------------------------------------------------------------------------------
let TOPO = null;
function getTopology() {
  if (TOPO) return TOPO;
  let g = new THREE.IcosahedronGeometry(1, DETAIL);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const src = g.getAttribute('position').array;
  const count = src.length / 3;
  const dir = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    let x = src[i * 3], y = src[i * 3 + 1], z = src[i * 3 + 2];
    const l = Math.hypot(x, y, z);
    x /= l; y /= l; z /= l;
    // Möbius (proyección estereográfica escalada): más vértices arriba, donde se mira.
    const h = Math.hypot(x, z);
    if (1 + y > 1e-7 && h > 1e-9) {
      const r = (TOP_BIAS * h) / (1 + y), r2 = r * r;
      const nh = (2 * r) / (1 + r2);
      x *= nh / h; z *= nh / h; y = (1 - r2) / (1 + r2);
    }
    dir[i * 3] = x; dir[i * 3 + 1] = y; dir[i * 3 + 2] = z;
  }
  TOPO = { count, index: Uint32Array.from(g.getIndex().array), dir };
  g.dispose();
  return TOPO;
}

/** Normales suaves ponderadas por área (sin reservar memoria). */
function computeNormals(pos, index, out) {
  out.fill(0);
  for (let t = 0, l = index.length; t < l; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const abx = pos[b] - pos[a], aby = pos[b + 1] - pos[a + 1], abz = pos[b + 2] - pos[a + 2];
    const acx = pos[c] - pos[a], acy = pos[c + 1] - pos[a + 1], acz = pos[c + 2] - pos[a + 2];
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0, l = out.length; i < l; i += 3) {
    const x = out[i], y = out[i + 1], z = out[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    out[i] = x * k; out[i + 1] = y * k; out[i + 2] = z * k;
  }
}

// ---------------------------------------------------------------------------------------------
// Formas base (origen = centro de la base, apoyadas en y = 0)
// ---------------------------------------------------------------------------------------------
// Perfil de revolución "superelipse": huella (a, c, e1) + perfil vertical con exponentes distintos
// arriba (pTop) y abajo (pBot). bulge = barriga de gota apoyada en el tercio inferior.
const PROFILES = {
  ball: { a: 0.074, c: 0.074, e1: 2, yMid: 0.037, hTop: 0.058, hBot: 0.05, pTop: 2.15, pBot: 2.5, bulge: 0.035, k: 0.012 },
  boule: { a: 0.091, c: 0.091, e1: 2, yMid: 0.016, hTop: 0.042, hBot: 0.03, pTop: 2.4, pBot: 2.6, bulge: 0.02, k: 0.009 },
  loaf: { a: TIN.a, c: TIN.c, e1: 7, yMid: 0.036, hTop: 0.026, hBot: 0.042, pTop: 2.7, pBot: 7, bulge: 0, k: 0.005 },
};
const LOAF_H0 = PROFILES.loaf.yMid + PROFILES.loaf.hTop; // altura del molde a rise = 1

/** Suelo suave C1: plano en y=0, transición redondeada de anchura k. */
function softFloor(y, k) {
  if (y >= k) return y;
  if (y <= -k) return 0;
  return ((y + k) * (y + k)) / (4 * k);
}

/** Punto de una forma de perfil (bola, hogaza, molde) para la dirección unitaria w. */
function profilePoint(wx, wy, wz, s, out) {
  const h = Math.sqrt(wx * wx + wz * wz);
  let qx = 0, qz = 0;
  if (h > 1e-9) {
    const ux = wx / h, uz = wz / h;
    const k = s.e1 === 2 ? 1 : Math.pow(Math.pow(Math.abs(ux), s.e1) + Math.pow(Math.abs(uz), s.e1), -1 / s.e1);
    qx = ux * k; qz = uz * k;
  }
  const p = wy >= 0 ? s.pTop : s.pBot;
  const k2 = Math.pow(Math.pow(h, p) + Math.pow(Math.abs(wy), p), -1 / p);
  const rho = h * k2, sv = wy * k2;
  const bul = 1 + s.bulge * Math.exp(-((sv + 0.3) * (sv + 0.3)) / 0.2);
  out[0] = s.a * rho * qx * bul;
  out[1] = softFloor(s.yMid + sv * (sv >= 0 ? s.hTop : s.hBot), s.k);
  out[2] = s.c * rho * qz * bul;
}

// Barra: cápsula a lo largo de X, sección aplanada, puntas afiladas apoyadas en la encimera.
const BAGUETTE = { L: SIZES.dough.baguetteLength / 2, R: 0.034, hTop: 0.034, hBot: 0.028, yc: 0.019 };
/** Punto de la barra para la dirección unitaria w (x = wx a lo largo, sección según el ángulo en YZ). */
function baguettePoint(wx, wy, wz, out) {
  const u = wx;
  const r = Math.sqrt(Math.max(1e-12, wy * wy + wz * wz));
  const cy = wy / r, cz = wz / r; // ángulo alrededor del eje X
  const au = Math.abs(u);
  const t = Math.pow(Math.max(0, 1 - au * au * au * au), 0.36); // estrechamiento de las puntas
  // sección: superelipse más llena arriba
  const p = cy >= 0 ? 2.25 : 2.6;
  const kk = Math.pow(Math.pow(Math.abs(cy), p) + Math.pow(Math.abs(cz), p), -1 / p);
  const sy = cy * kk, sz = cz * kk;
  const yc = BAGUETTE.yc * Math.sqrt(t);
  out[0] = BAGUETTE.L * u * (1 - 0.015 * au);
  out[1] = softFloor(yc + sy * t * (sy >= 0 ? BAGUETTE.hTop : BAGUETTE.hBot), 0.007 * t + 0.001);
  out[2] = BAGUETTE.R * sz * t;
}

// Masa desgreñada: unión suave de bolas (radial desde un centro). Dos estados: suelta y cohesionada.
const SHAGGY_C = [0, 0.032, 0];
const SHAGGY_BLOBS = [
  [-0.03, 0.026, -0.012, 0.04], [0.031, 0.022, 0.016, 0.037], [0.004, 0.026, -0.036, 0.034],
  [0.006, 0.048, 0.004, 0.033], [-0.014, 0.02, 0.033, 0.032], [0.026, 0.03, -0.026, 0.026],
];
/** Distancia radial (desde SHAGGY_C) a la unión suave de bolas; cohesionada = bolas juntas y más gordas. */
function shaggyPoint(wx, wy, wz, cohesive, out) {
  const pull = cohesive ? 0.42 : 1, grow = cohesive ? 0.017 : 0, k = cohesive ? 0.03 : 0.011;
  let best = -1;
  for (let b = 0; b < SHAGGY_BLOBS.length; b++) {
    const B = SHAGGY_BLOBS[b];
    // o = centro del rayo - centro de la bola (acercada al centro según `pull`)
    const ox = (SHAGGY_C[0] - B[0]) * pull, oy = (SHAGGY_C[1] - B[1]) * pull, oz = (SHAGGY_C[2] - B[2]) * pull;
    const r = B[3] + grow;
    const bb = wx * ox + wy * oy + wz * oz;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const disc = bb * bb - cc;
    const t = disc >= 0 ? -bb + Math.sqrt(disc) : -bb - 2 * Math.sqrt(-disc);
    if (best < 0) best = t;
    else { // unión suave (smooth max polinómico)
      const hh = Math.max(k - Math.abs(t - best), 0) / k;
      best = Math.max(t, best) + hh * hh * k * 0.25;
    }
  }
  best = Math.max(best, 0.012);
  out[0] = SHAGGY_C[0] + wx * best;
  out[1] = softFloor(SHAGGY_C[1] + wy * best, 0.01);
  out[2] = SHAGGY_C[2] + wz * best;
}

// Caché de formas base (compartida entre instancias): posiciones, normales y ruidos por vértice.
const SHAPE_CACHE = {};
let SHAGGY_NOISE = null;

/** Campos de ruido por vértice, normalizados a media 0 y desviación 1 (salvo los "ridge"). */
function buildNoise(sample, n) {
  const f = { nL: new Float32Array(n), nM: new Float32Array(n), nR: new Float32Array(n), nF: new Float32Array(n), nFl: new Float32Array(n) };
  const q = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    sample(i, q);
    const [x, y, z] = q;
    f.nL[i] = fbm3(x * 1.7 + 11.3, y * 1.7 + 2.1, z * 1.7 + 5.7, 3);
    f.nM[i] = fbm3(x * 4.6 + 3.3, y * 4.6 + 17.9, z * 4.6 + 1.1, 3);
    f.nR[i] = 1 - Math.abs(2 * fbm3(x * 3.6 + 7.7, y * 3.6 + 0.3, z * 3.6 + 9.1, 2) - 1);
    f.nF[i] = noise3(x * 21 + 1.9, y * 21 + 4.4, z * 21 + 8.8);
    f.nFl[i] = fbm3(x * 2.6 + 21.1, y * 2.6 + 6.6, z * 2.6 + 3.3, 3);
  }
  for (const k of ['nL', 'nM', 'nF', 'nFl']) {
    const a = f[k];
    let m = 0, v = 0;
    for (let i = 0; i < n; i++) m += a[i];
    m /= n;
    for (let i = 0; i < n; i++) v += (a[i] - m) * (a[i] - m);
    const s = 1 / (Math.sqrt(v / n) || 1);
    for (let i = 0; i < n; i++) a[i] = (a[i] - m) * s;
  }
  return f;
}

function getShape(key) {
  if (SHAPE_CACHE[key]) return SHAPE_CACHE[key];
  const { count: n, dir, index } = getTopology();
  const pos = new Float32Array(n * 3);
  const out = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const wx = dir[i * 3], wy = dir[i * 3 + 1], wz = dir[i * 3 + 2];
    if (key === 'baguette') baguettePoint(wx, wy, wz, out);
    else if (key === 'shaggy0' || key === 'shaggy1') shaggyPoint(wx, wy, wz, key === 'shaggy1', out);
    else profilePoint(wx, wy, wz, PROFILES[key], out);
    pos[i * 3] = out[0]; pos[i * 3 + 1] = out[1]; pos[i * 3 + 2] = out[2];
  }
  // la base exactamente en y = 0
  let minY = Infinity, top = 0;
  for (let i = 1; i < pos.length; i += 3) minY = Math.min(minY, pos[i]);
  for (let i = 1; i < pos.length; i += 3) { pos[i] -= minY; top = Math.max(top, pos[i]); }
  const nrm = new Float32Array(n * 3);
  computeNormals(pos, index, nrm);
  let noise;
  if (key.startsWith('shaggy')) {
    // el ruido de la masa desgreñada va anclado a la dirección (no cambia al mezclar)
    SHAGGY_NOISE ??= buildNoise((i, q) => { q[0] = dir[i * 3] * 0.95; q[1] = dir[i * 3 + 1] * 0.95; q[2] = dir[i * 3 + 2] * 0.95; }, n);
    noise = SHAGGY_NOISE;
  } else {
    noise = buildNoise((i, q) => { q[0] = pos[i * 3] / 0.07; q[1] = pos[i * 3 + 1] / 0.07; q[2] = pos[i * 3 + 2] / 0.07; }, n);
  }
  SHAPE_CACHE[key] = { pos, nrm, ...noise, top };
  return SHAPE_CACHE[key];
}

/** Calcula en segundo plano (ratos libres) las formas que aún no estén en caché. */
let warmScheduled = false;
function warmShapes() {
  if (warmScheduled || typeof window === 'undefined') return;
  warmScheduled = true;
  const queue = ['shaggy1', 'ball', 'boule', 'baguette', 'loaf'];
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
  const next = () => {
    const key = queue.shift();
    if (!key) return;
    getShape(key);
    idle(next);
  };
  idle(next);
}

function makeBaseBuffers(n) {
  return {
    pos: new Float32Array(n * 3), nrm: new Float32Array(n * 3), nL: new Float32Array(n), nM: new Float32Array(n),
    nR: new Float32Array(n), nF: new Float32Array(n), nFl: new Float32Array(n), top: 0.1,
  };
}

/** out = a·(1-t) + b·t para todos los campos de una forma base (normales renormalizadas). */
function blendBase(a, b, t, out) {
  const s = 1 - t;
  for (const k of ['pos', 'nL', 'nM', 'nR', 'nF', 'nFl']) {
    const A = a[k], B = b[k], O = out[k];
    for (let i = 0, l = O.length; i < l; i++) O[i] = A[i] * s + B[i] * t;
  }
  const A = a.nrm, B = b.nrm, O = out.nrm;
  for (let i = 0, l = O.length; i < l; i += 3) {
    const x = A[i] * s + B[i] * t, y = A[i + 1] * s + B[i + 1] * t, z = A[i + 2] * s + B[i + 2] * t;
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    O[i] = x * k; O[i + 1] = y * k; O[i + 2] = z * k;
  }
  out.top = a.top * s + b.top * t;
  return out;
}

function copyBase(src, out) {
  for (const k of ['pos', 'nrm', 'nL', 'nM', 'nR', 'nF', 'nFl']) out[k].set(src[k]);
  out.top = src.top;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Material: MeshPhysicalMaterial + microrrelieve procedural en el fragment shader
// ---------------------------------------------------------------------------------------------
const GLSL_PARS = /* glsl */`
uniform float uBake;
uniform float uRough;
uniform float uWet;
uniform float uGloss;
uniform float uFlourTop;
varying vec3 vRest;
varying vec2 vMask;
float dHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float dNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dHash(i), dHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(dHash(i + vec3(0.0, 1.0, 0.0)), dHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(dHash(i + vec3(0.0, 0.0, 1.0)), dHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(dHash(i + vec3(0.0, 1.0, 1.0)), dHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
// Ampollas: una burbuja redonda (casquete esférico) por celda, en dominio girado para no ver la rejilla.
const mat3 dRot = mat3(0.788, 0.461, -0.408, -0.351, 0.884, 0.309, 0.505, -0.077, 0.86);
float dBlister(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float h = dHash(i);
  vec3 c = 0.35 + 0.3 * vec3(dHash(i + 17.3), dHash(i + 41.7), dHash(i + 5.9));
  float r = 0.16 + 0.14 * dHash(i + 7.1);
  float d = length(f - c) / r;
  return step(0.5, h) * sqrt(max(0.0, 1.0 - d * d));
}
// Microrrelieve en metros (x) + términos para el color: y = manchas, z = ampollas, w = grietas.
vec4 doughMicro(vec3 p, float crust, float groove, float lod) {
  vec3 q = dRot * p;
  float a = dNoise(q * 380.0);
  float b = dNoise(q * 1050.0 + 3.7) * lod + 0.5 * (1.0 - lod);
  float c = dNoise(dRot * q * 300.0 + 11.3);
  float ridge = 1.0 - abs(c * 2.0 - 1.0);
  // cruda: burbujitas bajo la piel; poco amasada = piel rasgada
  float hRaw = (a * 0.5 + b * 0.5) * (0.000015 + 0.00005 * uRough) - pow(ridge, 8.0) * 0.00008 * uRough;
  // corteza: ampollas redondas de dos tamaños + craquelado fino
  float blis = (dBlister(q * 520.0) + 0.6 * dBlister(dRot * q * 900.0 + 2.3)) * lod * (1.0 - groove);
  float crack = pow(ridge, 16.0) * (1.0 - groove) * lod;
  float hCrust = blis * 0.00014 + a * 0.0001 - crack * 0.00005;
  // interior de la greña: superficie rasgada, fibrosa
  float torn = (dNoise(q * vec3(700.0, 260.0, 700.0) + 5.1) - 0.5) * 0.0004 * groove;
  return vec4(mix(hRaw, hCrust, crust) + torn, a, min(blis, 1.0), crack);
}
vec3 doughPerturb(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

const GLSL_COLOR = /* glsl */`
float dCrust = smoothstep(0.22, 0.85, uBake);
float dGroove = clamp(vMask.y, 0.0, 1.0);
vec3 dPx = dFdx(vRest), dPy = dFdy(vRest);
float dFw = length(dPx) + length(dPy);
float dLod = 1.0 - smoothstep(0.0005, 0.0016, dFw);
vec4 dM0 = doughMicro(vRest, dCrust, dGroove, dLod);
vec2 dHdxy = vec2(doughMicro(vRest + dPx, dCrust, dGroove, dLod).x - dM0.x,
                  doughMicro(vRest + dPy, dCrust, dGroove, dLod).x - dM0.x);
float dGrain = mix(0.5, dNoise(vRest * 2400.0), dLod);
diffuseColor.rgb *= 1.0 + dCrust * ((dM0.y - 0.5) * 0.2 - dM0.z * 0.18 + dM0.w * 0.05);
diffuseColor.rgb *= 1.0 + (1.0 - dCrust) * (dM0.y - 0.5) * 0.05;
float dF = clamp(vMask.x, 0.0, 1.0);
float dFlour = smoothstep(0.05, 0.95, dF + ((dM0.y - 0.5) * 0.7 + (dGrain - 0.5) * 0.8) * dF);
vec3 dFlourCol = mix(vec3(0.9, 0.88, 0.84), vec3(0.74, 0.6, 0.44), smoothstep(0.75, 1.4, uBake));
// cobertura de harina: al hornearse toma algo del color de la corteza y deja ver la corteza debajo
dFlourCol = mix(dFlourCol, diffuseColor.rgb, 0.35 * smoothstep(0.2, 0.8, uBake) * uFlourTop);
diffuseColor.rgb = mix(diffuseColor.rgb, dFlourCol * (0.94 + dGrain * 0.12), dFlour * mix(0.85, 0.65, uFlourTop));
`;

const GLSL_ROUGH = /* glsl */`
float dRawR = clamp(0.44 + uRough * 0.3 - uWet * 0.12, 0.25, 0.9);
float dR = mix(dRawR, 0.78 - dM0.z * 0.22, dCrust);
dR = mix(dR, 0.42 + dCrust * 0.1, uGloss);
dR = mix(dR, 0.85, dGroove * dCrust);
dR = mix(dR, 0.97, dFlour);
roughnessFactor = clamp(dR + (dGrain - 0.5) * 0.06, 0.08, 1.0);
`;

function createDoughMaterial(uniforms) {
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true, roughness: 0.6, metalness: 0,
    sheen: 1, sheenColor: new THREE.Color(0xf3d7b0), sheenRoughness: 0.45,
    envMapIntensity: 0.6,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aRest;\nattribute vec2 aMask;\nvarying vec3 vRest;\nvarying vec2 vMask;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = aRest;\nvMask = aMask;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + GLSL_PARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + GLSL_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + GLSL_ROUGH)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = doughPerturb(-vViewPosition, normal, dHdxy, faceDirection);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= mix(1.0, 0.25, dCrust) * (1.0 - dFlour * 0.5);\n#endif');
  };
  m.customProgramCacheKey = () => 'dough-v1';
  return m;
}

// ---------------------------------------------------------------------------------------------
// Corte: contorno de la sección (plano x = 0) y textura de miga
// ---------------------------------------------------------------------------------------------
/** Interseca la malla con el plano x = 0 y devuelve el lazo cerrado más largo como [z, y, z, y...]. */
function sliceOutline(pos, index) {
  const n = pos.length / 3;
  const edgePt = new Map();
  const pts = [];
  const segs = [];
  const pointOn = (a, b) => {
    const key = a < b ? a * n + b : b * n + a;
    let id = edgePt.get(key);
    if (id !== undefined) return id;
    const xa = pos[a * 3], xb = pos[b * 3];
    const t = xa / (xa - xb);
    pts.push(pos[a * 3 + 2] + (pos[b * 3 + 2] - pos[a * 3 + 2]) * t, pos[a * 3 + 1] + (pos[b * 3 + 1] - pos[a * 3 + 1]) * t);
    id = pts.length / 2 - 1;
    edgePt.set(key, id);
    return id;
  };
  for (let t = 0, l = index.length; t < l; t += 3) {
    const a = index[t], b = index[t + 1], c = index[t + 2];
    const sa = pos[a * 3] >= 0, sb = pos[b * 3] >= 0, sc = pos[c * 3] >= 0;
    if (sa === sb && sb === sc) continue;
    const e = [];
    if (sa !== sb) e.push(pointOn(a, b));
    if (sb !== sc) e.push(pointOn(b, c));
    if (sc !== sa) e.push(pointOn(c, a));
    if (e.length === 2) segs.push(e[0], e[1]);
  }
  const np = pts.length / 2;
  const adj = new Int32Array(np * 2).fill(-1);
  const link = (p, q) => { if (adj[p * 2] < 0) adj[p * 2] = q; else adj[p * 2 + 1] = q; };
  for (let s = 0; s < segs.length; s += 2) { link(segs[s], segs[s + 1]); link(segs[s + 1], segs[s]); }
  const seen = new Uint8Array(np);
  let best = [];
  for (let s = 0; s < np; s++) {
    if (seen[s]) continue;
    const loop = [];
    let prev = -1, cur = s;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      loop.push(cur);
      const nx = adj[cur * 2] !== prev ? adj[cur * 2] : adj[cur * 2 + 1];
      prev = cur; cur = nx;
    }
    if (loop.length > best.length) best = loop;
  }
  // simplifica: descarta puntos a menos de 0,7 mm del anterior
  const out = [];
  for (const id of best) {
    const z = pts[id * 2], y = pts[id * 2 + 1];
    const l = out.length;
    if (l && Math.hypot(z - out[l - 2], y - out[l - 1]) < 0.0007) continue;
    out.push(z, y);
  }
  return out;
}

/**
 * Pinta la miga (color en `c`, altura en `hc`) dentro del contorno `poly` (px, [x, y, x, y...]).
 * crumb = {openness, density, gumminess, tunnels}; crustPx = grosor de la corteza en px.
 */
function paintCrumb(c, hc, S, poly, crumb, bake, crustPx, seed) {
  const rng = makeRng(seed);
  const open = clamp(crumb.openness ?? 0.5), dens = clamp(crumb.density ?? 0.5);
  const gum = clamp(crumb.gumminess ?? 0), tun = clamp(crumb.tunnels ?? 0);
  const path = new Path2D();
  for (let i = 0; i < poly.length; i += 2) (i ? path.lineTo(poly[i], poly[i + 1]) : path.moveTo(poly[i], poly[i + 1]));
  path.closePath();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
    minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
  }
  const W = maxX - minX, H = maxY - minY, M = Math.max(W, H);
  const edgeDist = (x, y) => {
    let d = Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length;
      const ax = poly[i], ay = poly[i + 1], dx = poly[j] - ax, dy = poly[j + 1] - ay;
      const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
      d = Math.min(d, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return d;
  };
  const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const rgba = (a, al = 1) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;
  const crumbRgb = mix([241, 227, 197], [188, 178, 158], gum * 0.85);
  const shadeRgb = mix([168, 136, 92], [128, 118, 102], gum);

  // fondo (fuera del contorno = color de corteza para que el mipmap no sangre)
  c.fillStyle = rampCss(bake, 0.85);
  c.fillRect(0, 0, S, S);
  hc.fillStyle = '#808080';
  hc.fillRect(0, 0, S, S);
  c.save(); hc.save();
  c.clip(path); hc.clip(path);
  c.fillStyle = rgba(crumbRgb);
  c.fillRect(0, 0, S, S);

  // variación suave del color y tono dorado junto a la corteza
  for (let i = 0; i < 36; i++) {
    const x = minX + rng() * W, y = minY + rng() * H, r = (0.1 + rng() * 0.25) * M;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const tone = rng() < 0.5 ? '130,100,60' : '255,250,232';
    g.addColorStop(0, `rgba(${tone},0.07)`); g.addColorStop(1, `rgba(${tone},0)`);
    c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  c.lineJoin = hc.lineJoin = 'round';
  c.strokeStyle = 'rgba(222,178,110,0.22)'; c.lineWidth = crustPx * 6; c.stroke(path);

  // textura fina: poros y fibras de gluten estiradas hacia arriba
  const pores = Math.round(3200 * (1.1 - 0.5 * gum));
  for (let i = 0; i < pores; i++) {
    const x = minX + rng() * W, y = minY + rng() * H;
    const r = 0.5 + rng() * rng() * 2.2 * (1 - 0.5 * dens);
    c.fillStyle = rgba(shadeRgb, 0.16 + rng() * 0.3);
    c.beginPath(); c.ellipse(x, y, r, r * (1 + rng() * 0.7), (rng() - 0.5) * 0.8, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(255,251,240,0.35)';
    c.beginPath(); c.arc(x - r * 0.4, y - r * 0.5, r * 0.45, 0, Math.PI * 2); c.fill();
    hc.fillStyle = 'rgba(30,30,30,0.5)';
    hc.beginPath(); hc.arc(x, y, r, 0, Math.PI * 2); hc.fill();
  }

  // alveolos: forma irregular, interior en sombra, pared superior iluminada
  const blob = (ctx, x, y, r, asp, rot, irr, k) => {
    const n = k.length;
    const pt = (i) => {
      const a = (i / n) * Math.PI * 2, rr = r * (1 + (k[i % n] - 0.5) * irr);
      const px = Math.cos(a) * rr * asp, py = Math.sin(a) * rr;
      return [x + px * Math.cos(rot) - py * Math.sin(rot), y + px * Math.sin(rot) + py * Math.cos(rot)];
    };
    ctx.beginPath();
    let [px, py] = pt(0);
    const [sx, sy] = pt(n - 1);
    ctx.moveTo((px + sx) / 2, (py + sy) / 2);
    for (let i = 0; i < n; i++) {
      const [nx, ny] = pt(i + 1);
      ctx.quadraticCurveTo(px, py, (px + nx) / 2, (py + ny) / 2);
      px = nx; py = ny;
    }
    ctx.closePath();
  };
  const drawHole = (x, y, r, asp, rot, irr) => {
    const k = Array.from({ length: 8 + Math.floor(rng() * 4) }, () => rng());
    // interior: la pared de arriba queda en sombra (voladizo), la de abajo recibe luz
    const g = c.createLinearGradient(x, y - r, x, y + r);
    g.addColorStop(0, rgba(mix(shadeRgb, [70, 54, 36], 0.45)));
    g.addColorStop(0.45, rgba(shadeRgb));
    g.addColorStop(1, rgba(mix(shadeRgb, crumbRgb, 0.75)));
    c.fillStyle = g;
    blob(c, x, y, r, asp, rot, irr, k); c.fill();
    // borde de la pared de abajo iluminado (línea fina clara)
    c.save();
    blob(c, x, y, r, asp, rot, irr, k); c.clip();
    c.strokeStyle = 'rgba(255,250,236,0.55)'; c.lineWidth = Math.max(0.8, r * 0.14);
    blob(c, x, y - r * 0.1, r, asp, rot, irr, k); c.stroke();
    c.restore();
    hc.fillStyle = '#1a1a1a';
    blob(hc, x, y, r, asp, rot, irr, k); hc.fill();
  };
  const holes = Math.round(lerp(170, 120, open) * (1.3 - 0.8 * dens) * (1 - 0.45 * gum));
  const rMax = M * lerp(0.016, 0.07, open) * (1 - 0.45 * dens) * (1 - 0.55 * gum);
  const rMin = Math.max(1.2, rMax * 0.1);
  for (let i = 0; i < holes; i++) {
    const r = rMin + (rMax - rMin) * Math.pow(rng(), 2.4 - open);
    const x = minX + rng() * W, y = minY + rng() * H;
    if (!c.isPointInPath(path, x, y)) continue;
    if (edgeDist(x, y) < crustPx * 1.8 + r * 1.1) continue;
    const yy = (y - minY) / H;
    const squash = gum > 0.3 && yy > 0.6 ? 0.45 : 1; // la base gomosa queda apelmazada
    const asp = gum > 0.3 ? 1.4 + rng() * 0.6 : 0.65 + rng() * 0.5; // hacia arriba por el empuje del horno
    drawHole(x, y, r * squash, asp, (rng() - 0.5) * 0.9, 0.3 + open * 0.7);
  }
  // túneles (sobrefermentado): cavidades grandes bajo la corteza superior
  const nT = Math.round(tun * 3.4);
  for (let i = 0, tries = 0; i < nT && tries < 40; tries++) {
    const r = M * (0.05 + rng() * 0.05) * (0.6 + tun * 0.5);
    const x = minX + W * (0.2 + rng() * 0.6), y = minY + H * (0.16 + rng() * 0.22);
    if (!c.isPointInPath(path, x, y) || edgeDist(x, y) < crustPx * 1.5 + r * 0.8) continue;
    drawHole(x, y, r, 1.9 + rng() * 0.8, (rng() - 0.5) * 0.4, 0.55);
    i++;
  }
  // línea gomosa: banda densa y algo brillante cerca de la base
  if (gum > 0.05) {
    const y = minY + H * 0.8;
    const g = c.createLinearGradient(0, y - H * 0.16, 0, y + H * 0.14);
    g.addColorStop(0, 'rgba(146,136,118,0)'); g.addColorStop(0.5, `rgba(146,136,118,${0.75 * gum})`); g.addColorStop(1, 'rgba(146,136,118,0)');
    c.fillStyle = g; c.fillRect(0, y - H * 0.16, S, H * 0.3);
    c.strokeStyle = `rgba(250,245,235,${0.25 * gum})`; c.lineWidth = 1;
    for (let i = 0; i < 14; i++) {
      const yy = y + (rng() - 0.5) * H * 0.12;
      c.beginPath(); c.moveTo(minX, yy);
      c.bezierCurveTo(minX + W * 0.3, yy + (rng() - 0.5) * 8, minX + W * 0.7, yy + (rng() - 0.5) * 8, maxX, yy); c.stroke();
    }
  }
  // corteza: banda de grosor irregular, más oscura por fuera
  const crust = [[0.55, 0.8, 2.6, 0.35], [0.85, 0.72, 1.7, 0.9], [1.15, 0.62, 0.9, 1]];
  for (const [bk, mul, wk, al] of crust) {
    c.fillStyle = rampCss(Math.min(1.4, bake * bk), mul);
    c.globalAlpha = al;
    for (let i = 0; i < poly.length; i += 2) {
      const j = (i + 2) % poly.length;
      const steps = Math.max(1, Math.ceil(Math.hypot(poly[j] - poly[i], poly[j + 1] - poly[i + 1]) / 1.5));
      for (let k = 0; k < steps; k++) {
        const t = k / steps, x = poly[i] + (poly[j] - poly[i]) * t, y = poly[i + 1] + (poly[j + 1] - poly[i + 1]) * t;
        const r = crustPx * wk * 0.5 * (0.8 + 0.4 * noise3(x * 0.08, y * 0.08, bk * 10));
        c.beginPath(); c.arc(x, y, Math.max(0.6, r), 0, Math.PI * 2); c.fill();
      }
    }
  }
  c.globalAlpha = 1;
  hc.strokeStyle = '#a0a0a0'; hc.lineWidth = crustPx * 2; hc.stroke(path);
  c.restore(); hc.restore();
}

// ---------------------------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------------------------
const DEFAULTS = {
  shape: 'shaggy', mix: 0, smoothness: 0, hydration: 0.65, rise: 1, collapse: 0,
  squash: 0, stretch: 0, bake: 0, flour: 0, inTin: false,
};

/**
 * Crea la masa / pan deformable.
 * @param {{engine?: object, scene?: THREE.Scene, particles?: object, audio?: object}} ctx
 * @returns {object} API: { group, mesh, update(dt, elapsed), set(params), params, morphTo(shape, duration),
 *   dent(localPoint, opts), addScore(points, opts), clearScores(), setTopping(name), setCut(open01, crumb),
 *   getTopY(), getSize(), setHighlight(on), reset(), topping, isCut }
 */
export function createDough(ctx = {}) {
  const topo = getTopology();
  const n = topo.count;
  const index = topo.index;

  // --- geometría propia (atributos dinámicos) ---
  const geometry = new THREE.BufferGeometry();
  const posArr = new Float32Array(n * 3), nrmArr = new Float32Array(n * 3), colArr = new Float32Array(n * 3);
  const restArr = new Float32Array(n * 3), maskArr = new Float32Array(n * 2);
  const dyn = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setAttribute('position', dyn(posArr, 3));
  geometry.setAttribute('normal', dyn(nrmArr, 3));
  geometry.setAttribute('color', dyn(colArr, 3));
  geometry.setAttribute('aRest', dyn(restArr, 3));
  geometry.setAttribute('aMask', dyn(maskArr, 2));
  geometry.boundingBox = new THREE.Box3();
  geometry.boundingSphere = new THREE.Sphere();
  const dispArr = new Float32Array(n);  // desplazamiento (convexidad) para el color
  const grooveArr = new Float32Array(n); // interior del corte
  const earArr = new Float32Array(n);    // labio ("oreja") del corte

  const uniforms = {
    uBake: { value: 0 }, uRough: { value: 1 }, uWet: { value: 0 }, uGloss: { value: 0 }, uFlourTop: { value: 0 },
  };
  const material = createDoughMaterial(uniforms);

  const group = new THREE.Group();
  group.name = 'dough';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'dough-body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.dough = 'body';
  group.add(mesh);

  // sombra de contacto suave (ancla la masa a la superficie)
  const contactTex = makeCanvasTexture(128, 128, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.7)'); g.addColorStop(0.75, 'rgba(255,255,255,0.2)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, { srgb: false });
  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x1c130c, alphaMap: contactTex, transparent: true, opacity: 0.25, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  );
  contact.position.y = 0.0006;
  contact.renderOrder = 1;
  contact.name = 'dough-contact';
  group.add(contact);

  // --- estado ---
  const params = { ...DEFAULTS, stretchDir: new THREE.Vector2(1, 0) };
  let dirty = true;                    // cambio inmediato (gestos, forma, cortes...)
  let slowDirty = false;               // cambio gradual pendiente (se aplica como mucho cada minInterval)
  let sinceBuild = 0;                  // segundos desde la última reconstrucción
  let minInterval = 1 / 30;            // ver setRebuildRate()
  let colorDirty = true;               // el color no depende de amasar/estirar en crudo
  const baseOwned = makeBaseBuffers(n); // mezcla actual (transformación / desgreñada)
  let morphFrom = null;                // instantánea al empezar morphTo
  let morph = null;                    // {t, e, dur, resolve, from}
  let baseRef = null;                  // forma base usada en el último rebuild
  let lastBaseKey = '';
  let restDirty = true;

  const scores = [];                   // {pts: number[] (x,z base), depth, width, len, cum: number[]}
  let scoresDirty = false;
  let sD = null, sT = null, sPx = null, sPz = null, sK = null; // por vértice

  const dents = [];
  let topping = 'none';
  let tops = parseTopping('none');
  let seeds = null;                    // {mesh, tri: Uint32Array, bary: Float32Array, rot, scale, count}
  let seedsDirty = false;

  const size = new THREE.Vector3(0.1, 0.1, 0.1);
  let topY = 0.1;
  let hScale = 1;                      // escala horizontal del último rebuild (para addScore)
  let elapsedT = 0;
  const jiggle = { v: 0, x: 0 };
  let errorLogged = false;
  const highlighter = makeHighlighter(group);

  // corte
  const cut = { active: false, open: 0, crumb: { openness: 0.55, density: 0.45, gumminess: 0, tunnels: 0 }, crumbDirty: true, bakeDrawn: -1 };
  let cutParts = null;

  // ---------- forma base actual ----------
  function shapeBase(shape) {
    if (shape !== 'shaggy') return getShape(shape);
    const m = clamp(params.mix);
    if (m <= 0) return getShape('shaggy0');
    if (m >= 1) return getShape('shaggy1');
    return null; // necesita mezcla
  }

  function currentBase() {
    const target = params.shape;
    let tgt = shapeBase(target);
    if (!tgt) tgt = blendBase(getShape('shaggy0'), getShape('shaggy1'), smoothstep(0, 1, params.mix), baseOwned);
    if (!morph) return tgt;
    const t = morph.t;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    morph.e = e;
    if (tgt === baseOwned) { // la desgreñada mezclada ya ocupa baseOwned: se copia antes
      morph.tmp ??= makeBaseBuffers(n);
      copyBase(baseOwned, morph.tmp);
      tgt = morph.tmp;
    }
    return blendBase(morphFrom, tgt, e, baseOwned);
  }

  // ---------- cortes (greñas) ----------
  function precomputeScores(base) {
    sD ??= new Float32Array(n); sT ??= new Float32Array(n);
    sPx ??= new Float32Array(n); sPz ??= new Float32Array(n); sK ??= new Uint8Array(n);
    sD.fill(9);
    if (!scores.length) return;
    const P = base.pos, N = base.nrm, minY = base.top * 0.3;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      if (N[j + 1] < 0.08 || P[j + 1] < minY) continue;
      const x = P[j], z = P[j + 2];
      let best = 9, bestT = 0, bpx = 0, bpz = 0, bk = 0;
      for (let k = 0; k < scores.length; k++) {
        const s = scores[k];
        if (x < s.minX - 0.03 || x > s.maxX + 0.03 || z < s.minZ - 0.03 || z > s.maxZ + 0.03) continue;
        const pts = s.pts;
        for (let q = 0; q + 3 < pts.length; q += 2) {
          const ax = pts[q], az = pts[q + 1], bx = pts[q + 2], bz = pts[q + 3];
          const dx = bx - ax, dz = bz - az;
          const L2 = dx * dx + dz * dz || 1e-12;
          const t = clamp(((x - ax) * dx + (z - az) * dz) / L2);
          const cx = ax + dx * t - x, cz = az + dz * t - z;
          const d = Math.sqrt(cx * cx + cz * cz);
          if (d < Math.abs(best)) {
            const L = Math.sqrt(L2);
            const ux = dx / L, uz = dz / L;
            const side = ux * (z - az) - uz * (x - ax);
            best = side >= 0 ? d : -d;
            bestT = (s.cum[q / 2] + t * L) / s.len;
            bpx = -uz; bpz = ux; bk = k;
          }
        }
      }
      if (best < 8) {
        sD[i] = best;
        sT[i] = Math.pow(Math.sin(Math.PI * clamp(bestT)), 0.55);
        sPx[i] = bpx; sPz[i] = bpz; sK[i] = bk;
      }
    }
  }

  // ---------- reconstrucción ----------
  const tmpC = new Float32Array(3);
  function rebuild() {
    const p = params;
    const base = currentBase();
    const baseKey = `${p.shape}|${morph ? 'm' : ''}|${p.shape === 'shaggy' ? p.mix.toFixed(4) : ''}`;
    const baseChanged = base !== baseRef || base === baseOwned || baseKey !== lastBaseKey;
    baseRef = base; lastBaseKey = baseKey;
    if (scores.length && (scoresDirty || baseChanged)) { precomputeScores(base); scoresDirty = false; }
    if (baseChanged || restDirty) { restArr.set(base.pos); geometry.attributes.aRest.needsUpdate = true; restDirty = false; }

    const BP = base.pos, BN = base.nrm, nL = base.nL, nM = base.nM, nR = base.nR, nF = base.nF, nFl = base.nFl;
    const mixv = clamp(p.mix), smooth = clamp(p.smoothness), bake = clamp(p.bake, 0, 1.4), col = clamp(p.collapse);
    const rough = Math.max(1 - smooth, (1 - mixv) * 0.85);
    const shagBoost = p.shape === 'shaggy' ? 1.35 - 0.35 * mixv : 1;
    const ampL = (0.0006 * (p.shape === 'loaf' ? 0.5 : 1) + 0.0048 * Math.pow(rough, 1.2)) * shagBoost;
    const ampM = 0.0009 * rough * shagBoost;
    const ampT = 0.0042 * rough * rough * shagBoost;
    const crustT = smoothstep(0.3, 0.9, bake);
    const ampB = 0.0002 * crustT * (tops.egg ? 0.5 : 1);
    const ampW = 0.004 * col;
    const baseTop = base.top || 0.1;

    // forma de molde (pared vertical + cúpula): peso según la forma actual / transformación
    const me = morph ? morph.e ?? 0 : 1;
    const wLoaf = p.shape === 'loaf' ? me : (morph && morph.from === 'loaf' ? 1 - me : 0);
    const rise = Math.max(0.3, p.rise);
    const Ht = LOAF_H0 * Math.pow(rise, 0.85);
    const hd = clamp(Ht - (TIN.rim - 0.008), 0.026, 0.05);
    const hw = Math.max(0.005, Ht - hd);
    const yMidL = PROFILES.loaf.yMid, hTopL = PROFILES.loaf.hTop;

    // escalas globales (volumen ~ rise; la masa húmeda se aplana; colapso; amasado)
    const wet = clamp((p.hydration - 0.65) / 0.2, -0.6, 1.2);
    // la hogaza crece más hacia arriba (bola tensa): mismo volumen, menos anchura
    const wBoule = p.shape === 'boule' ? me : (morph && morph.from === 'boule' ? 1 - me : 0);
    const rH = lerp(Math.pow(rise, lerp(0.36, 0.24, wBoule)), 1, wLoaf), rV = Math.pow(rise, lerp(0.28, 0.52, wBoule));
    const hydH = lerp(1 + 0.13 * wet, 1, wLoaf), hydV = lerp(1 - 0.24 * wet, 1, wLoaf);
    const sq = clamp(p.squash), st = clamp(p.stretch);
    const qV = 1 - 0.5 * sq, qH = 1 / Math.sqrt(qV);
    const eF = 1 + 0.6 * st, eB = 1 + 0.18 * st, eT = 1 / Math.sqrt((eF + eB) / 2);
    const sdx = p.stretchDir.x, sdz = p.stretchDir.y;
    const Hs = rH * hydH * qH * (1 + 0.15 * col);
    hScale = Hs;
    const inTin = !!p.inTin;

    // apertura de los cortes con el horno (y un poco nada más cortar)
    const open = Math.max(0.12, smoothstep(0.04, 0.42, bake) * (1 - 0.75 * col));
    const hasScores = scores.length > 0 && sD;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const bx = BP[j], by = BP[j + 1], bz = BP[j + 2];
      const nx = BN[j], ny = BN[j + 1], nz = BN[j + 2];
      const fk = by >= 0.012 ? 1 : (by / 0.012) * (by / 0.012); // la base queda plana
      const r = nR[i];
      const r4 = r * r * r * r;
      let d = ampL * nL[i] + ampM * nM[i] - ampT * r4 * r4 + ampB * nF[i];
      if (ampW > 0) { // arrugas del colapso, sobre todo arriba
        const up = ny > 0 ? ny : 0;
        d += ampW * up * (0.6 * nM[i] - r * r * r * r * r * r * 1.4);
      }
      d *= fk;
      let lx = 0, lz = 0, gm = 0, ear = 0;
      if (hasScores && sD[i] < 8) {
        const sc = scores[sK[i]];
        const tau = sT[i];
        const W = sc.width * 0.5 * (1 + 2.0 * open), D = sc.depth * tau * (0.85 + 0.75 * open);
        const s = sD[i], as = s < 0 ? -s : s;
        if (as < W) {
          const q = as / W;
          const prof = 1 - Math.pow(q, 2 + 1.4 * open);
          d -= D * prof;
          gm = prof * tau;
        }
        // oreja: el labio de un lado se levanta y vuela sobre el corte
        const es = s > 0 ? (s - W * 0.8) / (W * 0.55) : (-s - W * 0.9) / (W * 0.45);
        const e = Math.exp(-es * es) * open * tau * (s > 0 ? 1 : 0.3);
        d += e * D * 0.5;
        const shift = e * W * (s > 0 ? 0.45 : 0.1);
        lx = -sPx[i] * shift * (s > 0 ? 1 : -1);
        lz = -sPz[i] * shift * (s > 0 ? 1 : -1);
        ear = s > 0 ? e : e * 0.5;
      }
      dispArr[i] = d; grooveArr[i] = gm; earArr[i] = ear;
      let x = bx + nx * d + lx, y = by + ny * d, z = bz + nz * d + lz;
      if (y < 0) y = 0;

      // perfil de molde: paredes que crecen + cúpula
      if (wLoaf > 0) {
        const yl = y < yMidL ? (y / yMidL) * hw : hw + ((y - yMidL) / hTopL) * hd;
        y = lerp(y * rV, yl, wLoaf);
      } else {
        y *= rV;
      }
      y *= hydV;
      // colapso: la parte alta se hunde, la base se escurre
      let hr = y / (baseTop * rV);
      if (col > 0) { y *= 1 - col * (0.2 + 0.2 * clamp(hr)); }
      y *= qV;
      // horizontal
      let hk = Hs * (col > 0 ? 1 + 0.08 * col * (1 - clamp(hr)) : 1);
      if (sq > 0) hk *= 1 + 0.07 * sq * Math.sin(Math.PI * clamp(hr));
      x *= hk; z *= hk;
      if (st > 0) {
        let a = x * sdx + z * sdz, pp = -x * sdz + z * sdx;
        a *= a > 0 ? eF : eB; pp *= eT;
        y *= eT;
        x = a * sdx - pp * sdz; z = a * sdz + pp * sdx;
      }
      // molde: paredes rígidas y "seta" por encima del borde
      if (wLoaf > 0 && Ht > TIN.rim) {
        const k = smoothstep(TIN.rim - 0.004, TIN.rim + 0.012, y) * wLoaf;
        x *= 1 + 0.03 * k; z *= 1 + 0.06 * k;
      }
      if (inTin) {
        const k = smoothstep(TIN.rim - 0.002, TIN.rim + 0.01, y);
        const flare = 0.0055 * (1 - clamp(y / TIN.rim)); // las paredes del molde se abren hacia arriba: abajo es más estrecho
        const la = TIN.a - flare + 0.005 * k, lc = TIN.c - flare + 0.005 * k;
        if (x > la) x = la; else if (x < -la) x = -la;
        if (z > lc) z = lc; else if (z < -lc) z = -lc;
      }
      posArr[j] = x; posArr[j + 1] = y; posArr[j + 2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    minY = 0;

    // abolladuras (espacio final; hunden, así que la caja sigue valiendo)
    for (const dt of dents) {
      const amp = dt.amp;
      if (amp <= 0) continue;
      const r2 = dt.r * dt.r, lim = r2 * 5;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const dx = posArr[j] - dt.x, dy = posArr[j + 1] - dt.y, dz = posArr[j + 2] - dt.z;
        const dd = dx * dx + dy * dy + dz * dz;
        if (dd > lim) continue;
        const g = Math.exp((-3 * dd) / r2);
        const ring = Math.sqrt(dd) / dt.r - 1.25;
        const w = amp * (g - 0.16 * Math.exp(-ring * ring * 5));
        posArr[j] += dt.nx * w; posArr[j + 1] = Math.max(0, posArr[j + 1] + dt.ny * w); posArr[j + 2] += dt.nz * w;
      }
    }

    computeNormals(posArr, index, nrmArr);

    // ---------- color por vértice + máscaras (harina, interior del corte) ----------
    const eggT = tops.egg ? 1 : 0;
    const flourAmt = Math.max(clamp(p.flour), p.shape === 'shaggy' ? (1 - mixv) * 0.8 : 0);
    const flourTop = tops.flour ? 0.38 : 0; // cobertura: un velo, no manchas
    const rawW = 1 - smoothstep(0.05, 0.35, bake);
    const wetGrey = clamp(wet) * 0.3 * rawW;
    const needColor = colorDirty || bake > 0.02 || !!morph;
    colorDirty = false;
    for (let i = 0, j = 0, m = 0; needColor && i < n; i++, j += 3, m += 2) {
      const y = posArr[j + 1];
      const ny = nrmArr[j + 1];
      const top = clamp(ny * 0.5 + 0.5);
      const hr = y / (maxY || 1);
      // exposición al calor: arriba y en los relieves más oscuro; abajo y en el molde más claro
      let expo = 0.6 + 0.42 * top * top + 0.16 * hr + clamp(dispArr[i] * 120, -0.12, 0.12);
      if (ny < -0.6) expo *= 0.72;
      if (wLoaf > 0 && y < TIN.rim && ny < 0.6) expo = lerp(expo, expo * 0.8, wLoaf);
      expo += earArr[i] * 0.7;
      const gm = grooveArr[i] * open;
      // harina (se calcula antes: aísla y la corteza queda más pálida debajo)
      let fm = 0;
      if (flourAmt > 0) {
        const cov = flourAmt * (0.3 + 0.7 * top * top);
        const u = clamp(0.5 + nFl[i] * 0.25);
        fm = smoothstep(1 - cov - 0.3, 1 - cov + 0.3, u) * flourAmt * (1 - clamp(gm * 2.5));
      }
      if (flourTop > 0) {
        // espolvoreado: más en la corona, moteado fino (ruido de alta frecuencia) y nada en las greñas
        const cov = flourTop * (0.15 + 0.85 * top * top * top);
        const sp = clamp(0.5 + (0.8 * nF[i] + 0.25 * nFl[i]) * 0.3);
        fm = Math.max(fm, cov * (0.75 + 1.1 * sp) * (1 - clamp(gm * 2.5)));
      }
      let b = bake * expo * (1 + 0.03 * nM[i]) * (1 - 0.28 * fm);
      b = lerp(b, bake * (0.45 + 0.3 * (1 - grooveArr[i])), clamp(gm * 1.3));
      if (eggT) b *= 1.14;
      sampleRamp(b, tmpC, 0);
      const ao = 1 - (1 - rawW) * (clamp(-dispArr[i] * 90, 0, 0.35) + 0.25 * gm * (1 - grooveArr[i]));
      let cr = tmpC[0] * ao, cg = tmpC[1] * ao, cb = tmpC[2] * ao;
      // masa cruda: más gris si está húmeda, algo moteada si está poco mezclada
      if (rawW > 0) {
        const cav = clamp(dispArr[i] * 160, -0.5, 0.3) * rawW;
        const mott = (1 + (nL[i] * 0.02 + nM[i] * 0.015) * (0.4 + rough)) * (1 + cav * 0.35);
        cr = lerp(cr, 0.72, wetGrey) * mott; cg = lerp(cg, 0.7, wetGrey) * mott; cb = lerp(cb, 0.64, wetGrey) * mott;
        // corte recién hecho: el fondo del tajo queda en sombra y se lee como un corte (solo en crudo)
        const gk = grooveArr[i];
        if (gk > 0) { const k = 1 - 0.34 * rawW * gk * gk; cr *= k; cg *= k; cb *= k; }
      }
      if (eggT) { // huevo: más saturado y brillante; en crudo, amarillento
        const l = 0.3 * cr + 0.59 * cg + 0.11 * cb;
        cr = l + (cr - l) * 1.12; cg = l + (cg - l) * 1.12; cb = Math.max(0, l + (cb - l) * 1.12);
        cr = lerp(cr, 0.86, 0.35 * rawW); cg = lerp(cg, 0.6, 0.35 * rawW); cb = lerp(cb, 0.2, 0.35 * rawW);
      }
      colArr[j] = cr; colArr[j + 1] = cg; colArr[j + 2] = cb;
      maskArr[m] = fm; maskArr[m + 1] = grooveArr[i] * open;
    }

    // bounding volumes (frustum culling y raycast)
    geometry.boundingBox.min.set(minX, minY, minZ);
    geometry.boundingBox.max.set(maxX, maxY, maxZ);
    geometry.boundingBox.getBoundingSphere(geometry.boundingSphere);
    size.set(maxX - minX, maxY - minY, maxZ - minZ);
    topY = maxY;
    const at = geometry.attributes;
    at.position.needsUpdate = true; at.normal.needsUpdate = true;
    if (needColor) { at.color.needsUpdate = true; at.aMask.needsUpdate = true; }

    // uniformes del shader
    uniforms.uBake.value = bake;
    uniforms.uRough.value = rough;
    uniforms.uWet.value = wet;
    uniforms.uGloss.value = eggT;
    uniforms.uFlourTop.value = tops.flour ? 1 : 0;
    const sheen = lerp(0.55, 0.25, crustT);
    material.sheen = sheen;
    if (cutParts) { cutParts.L.mat.sheen = sheen; cutParts.R.mat.sheen = sheen; }

    contact.scale.set(size.x * 0.95, 1, size.z * 0.95); // línea de contacto, no un disco alrededor
    contact.position.x = (minX + maxX) / 2; contact.position.z = (minZ + maxZ) / 2;

    if (seeds && seeds.mesh.visible) { if (seedsDirty) placeSeeds(); updateSeeds(); }
    if (cut.active) { buildCutCaps(); applyCutPose(); }
  }

  // ---------- semillas ----------
  const seedGeos = {};
  function seedGeometry(kind) {
    if (seedGeos[kind]) return seedGeos[kind];
    let g;
    if (kind === 'sesame') {
      g = new THREE.SphereGeometry(1, 8, 6);
      const a = g.attributes.position;
      for (let i = 0; i < a.count; i++) {
        const x = a.getX(i);
        a.setXYZ(i, x * 0.0017, a.getY(i) * 0.00045, a.getZ(i) * 0.00095 * (1 - 0.35 * Math.max(0, x)));
      }
      g.computeVertexNormals();
    } else {
      g = new THREE.SphereGeometry(0.00062, 6, 4);
    }
    seedGeos[kind] = g;
    return g;
  }
  const seedMat = new THREE.MeshStandardMaterial({ color: 0xf1e3c2, roughness: 0.5 });

  function ensureSeeds() {
    if (seeds) return seeds;
    const im = new THREE.InstancedMesh(seedGeometry('sesame'), seedMat, MAX_SEEDS);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.userData.dough = 'seeds';
    im.name = 'dough-seeds';
    mesh.add(im);
    seeds = { mesh: im, tri: new Uint32Array(MAX_SEEDS * 3), bary: new Float32Array(MAX_SEEDS * 3), rot: new Float32Array(MAX_SEEDS), scale: new Float32Array(MAX_SEEDS), count: 0 };
    return seeds;
  }

  /** Reparte semillas sobre los triángulos de arriba (ponderado por área), fuera de los cortes. */
  function placeSeeds() {
    seedsDirty = false;
    const s = ensureSeeds();
    const kind = tops.seeds;
    const want = kind === 'poppy' ? 600 : 340;
    const rng = makeRng(kind === 'poppy' ? 77 : 31);
    const tris = [], cum = [];
    let acc = 0;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      const ny = (nrmArr[a * 3 + 1] + nrmArr[b * 3 + 1] + nrmArr[c * 3 + 1]) / 3;
      if (ny < 0.38) continue;
      if (maskArr[a * 2 + 1] + maskArr[b * 2 + 1] + maskArr[c * 2 + 1] > 0.15) continue;
      const abx = posArr[b * 3] - posArr[a * 3], abz = posArr[b * 3 + 2] - posArr[a * 3 + 2];
      const acx = posArr[c * 3] - posArr[a * 3], acz = posArr[c * 3 + 2] - posArr[a * 3 + 2];
      const area = Math.abs(abx * acz - abz * acx) * (0.4 + ny * ny);
      acc += area; tris.push(t); cum.push(acc);
    }
    let k = 0;
    for (; k < want && tris.length; k++) {
      const r = rng() * acc;
      let lo = 0, hi = cum.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
      const t = tris[lo];
      let u = rng(), v = rng();
      if (u + v > 1) { u = 1 - u; v = 1 - v; }
      s.tri[k * 3] = index[t]; s.tri[k * 3 + 1] = index[t + 1]; s.tri[k * 3 + 2] = index[t + 2];
      s.bary[k * 3] = 1 - u - v; s.bary[k * 3 + 1] = u; s.bary[k * 3 + 2] = v;
      s.rot[k] = rng() * Math.PI * 2;
      s.scale[k] = 0.8 + rng() * 0.4;
    }
    s.count = k;
    s.mesh.count = k;
  }

  function updateSeeds() {
    const s = seeds, arr = s.mesh.instanceMatrix.array;
    for (let k = 0; k < s.count; k++) {
      const a = s.tri[k * 3] * 3, b = s.tri[k * 3 + 1] * 3, c = s.tri[k * 3 + 2] * 3;
      const wa = s.bary[k * 3], wb = s.bary[k * 3 + 1], wc = s.bary[k * 3 + 2];
      let nx = nrmArr[a] * wa + nrmArr[b] * wb + nrmArr[c] * wc;
      let ny = nrmArr[a + 1] * wa + nrmArr[b + 1] * wb + nrmArr[c + 1] * wc;
      let nz = nrmArr[a + 2] * wa + nrmArr[b + 2] * wb + nrmArr[c + 2] * wc;
      const nl = 1 / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      const px = posArr[a] * wa + posArr[b] * wb + posArr[c] * wc + nx * 0.0002;
      const py = posArr[a + 1] * wa + posArr[b + 1] * wb + posArr[c + 1] * wc + ny * 0.0002;
      const pz = posArr[a + 2] * wa + posArr[b + 2] * wb + posArr[c + 2] * wc + nz * 0.0002;
      // base tangente estable + giro aleatorio
      let tx, ty, tz;
      if (Math.abs(ny) < 0.9) { tx = nz; ty = 0; tz = -nx; } else { tx = 0; ty = -nz; tz = ny; }
      const tl = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1);
      tx *= tl; ty *= tl; tz *= tl;
      const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      const cs = Math.cos(s.rot[k]), sn = Math.sin(s.rot[k]);
      const xx = tx * cs + bx * sn, xy = ty * cs + by * sn, xz = tz * cs + bz * sn;
      const zx = xy * nz - xz * ny, zy = xz * nx - xx * nz, zz = xx * ny - xy * nx;
      // dentro de una greña abierta no hay semillas (es masa nueva)
      const gm = maskArr[s.tri[k * 3] * 2 + 1] + maskArr[s.tri[k * 3 + 1] * 2 + 1] + maskArr[s.tri[k * 3 + 2] * 2 + 1];
      const sc = s.scale[k] * (1 - smoothstep(0.15, 0.6, gm)), o = k * 16;
      arr[o] = xx * sc; arr[o + 1] = xy * sc; arr[o + 2] = xz * sc; arr[o + 3] = 0;
      arr[o + 4] = nx * sc; arr[o + 5] = ny * sc; arr[o + 6] = nz * sc; arr[o + 7] = 0;
      arr[o + 8] = zx * sc; arr[o + 9] = zy * sc; arr[o + 10] = zz * sc; arr[o + 11] = 0;
      arr[o + 12] = px; arr[o + 13] = py; arr[o + 14] = pz; arr[o + 15] = 1;
    }
    s.mesh.instanceMatrix.needsUpdate = true;
    // semillas tostadas con el horno
    const b = clamp(params.bake, 0, 1.4);
    if (tops.seeds === 'poppy') seedMat.color.setHex(0x2b2d36);
    else seedMat.color.setHex(0xe9d6ae).lerp(SESAME_TOAST, smoothstep(0.15, 1.0, b));
    if (cutParts) syncCutSeeds();
  }

  // ---------- corte en dos mitades ----------
  function ensureCutParts() {
    if (cutParts) return cutParts;
    const mk = (sign) => {
      const mat = createDoughMaterial(uniforms);
      mat.clearcoat = material.clearcoat; mat.clearcoatRoughness = material.clearcoatRoughness; mat.sheen = material.sheen;
      const local = new THREE.Plane(new THREE.Vector3(sign, 0, 0), 0);
      const plane = local.clone();
      mat.clippingPlanes = [plane];
      mat.clipShadows = true;
      const pivot = new THREE.Group();
      const half = new THREE.Mesh(geometry, mat);
      half.castShadow = true; half.receiveShadow = true;
      half.userData.dough = 'half';
      half.name = sign < 0 ? 'dough-half-left' : 'dough-half-right';
      const sync = () => { plane.copy(local).applyMatrix4(half.matrixWorld); };
      half.onBeforeRender = sync;
      half.onBeforeShadow = sync;
      pivot.add(half);
      group.add(pivot);
      pivot.visible = false;
      const cap = new THREE.Mesh(new THREE.BufferGeometry(), null);
      cap.rotation.y = sign < 0 ? Math.PI / 2 : -Math.PI / 2;
      if (sign < 0) cap.scale.x = -1;
      cap.castShadow = false; cap.receiveShadow = true;
      cap.userData.dough = 'cap';
      half.add(cap);
      const sd = new THREE.InstancedMesh(seedGeometry('sesame'), seedMat, MAX_SEEDS);
      sd.count = 0; sd.frustumCulled = false; sd.visible = false;
      half.add(sd);
      const shadow = new THREE.Mesh(contact.geometry, contact.material);
      shadow.renderOrder = 1;
      half.add(shadow);
      return { pivot, half, mat, plane, local, sync, cap, seeds: sd, shadow };
    };
    const S = 512;
    const cv = document.createElement('canvas'); cv.width = cv.height = S;
    const hv = document.createElement('canvas'); hv.width = hv.height = S;
    const map = new THREE.CanvasTexture(cv); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
    const bump = new THREE.CanvasTexture(hv);
    const capMat = new THREE.MeshStandardMaterial({ map, bumpMap: bump, bumpScale: 2.5, roughness: 0.92 });
    cutParts = { L: mk(-1), R: mk(1), S, cv, hv, map, bump, capMat, capGeo: null };
    cutParts.L.cap.material = capMat; cutParts.R.cap.material = capMat;
    return cutParts;
  }

  function buildCutCaps() {
    const cp = ensureCutParts();
    const outline = sliceOutline(posArr, index);
    if (outline.length < 6) return;
    let minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < outline.length; i += 2) {
      minZ = Math.min(minZ, outline[i]); maxZ = Math.max(maxZ, outline[i]);
      minY = Math.min(minY, outline[i + 1]); maxY = Math.max(maxY, outline[i + 1]);
    }
    const L = Math.max(maxZ - minZ, maxY - minY) * 1.06;
    const zc = (minZ + maxZ) / 2, yc = (minY + maxY) / 2;
    const shape = new THREE.Shape();
    for (let i = 0; i < outline.length; i += 2) (i ? shape.lineTo(outline[i], outline[i + 1]) : shape.moveTo(outline[i], outline[i + 1]));
    const g = new THREE.ShapeGeometry(shape, 1);
    const pa = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < pa.count; i++) uv.setXY(i, (pa.getX(i) - zc) / L + 0.5, (pa.getY(i) - yc) / L + 0.5);
    g.computeBoundingSphere();
    cp.capGeo?.dispose();
    cp.capGeo = g;
    cp.L.cap.geometry = g; cp.R.cap.geometry = g;
    // la textura se repinta al cambiar la miga o el horneado
    if (cut.crumbDirty || Math.abs(cut.bakeDrawn - params.bake) > 0.02) {
      const S = cp.S;
      const poly = [];
      for (let i = 0; i < outline.length; i += 2) poly.push(((outline[i] - zc) / L + 0.5) * S, (1 - ((outline[i + 1] - yc) / L + 0.5)) * S);
      const b = clamp(params.bake, 0, 1.4);
      const crustM = lerp(0.0012, 0.0062, smoothstep(0.2, 1.3, b));
      paintCrumb(cp.cv.getContext('2d'), cp.hv.getContext('2d'), S, poly, cut.crumb, b, (crustM / L) * S, 1234);
      cp.map.needsUpdate = true; cp.bump.needsUpdate = true;
      cp.capMat.roughness = lerp(0.92, 0.62, clamp(cut.crumb.gumminess ?? 0));
      cut.crumbDirty = false; cut.bakeDrawn = params.bake;
    }
  }

  function syncCutSeeds() {
    const cp = cutParts;
    if (!cp || !seeds) return;
    const src = seeds.mesh.instanceMatrix.array;
    const visible = seeds.mesh.visible && cut.active;
    for (const side of [cp.L, cp.R]) {
      side.seeds.geometry = seeds.mesh.geometry;
      side.seeds.visible = visible;
      if (!visible) continue;
      const dst = side.seeds.instanceMatrix.array;
      let c = 0;
      for (let k = 0; k < seeds.count; k++) {
        const x = src[k * 16 + 12];
        if ((side === cp.L) !== (x < 0)) continue;
        for (let q = 0; q < 16; q++) dst[c * 16 + q] = src[k * 16 + q];
        c++;
      }
      side.seeds.count = c;
      side.seeds.instanceMatrix.needsUpdate = true;
    }
  }

  function applyCutPose() {
    const cp = cutParts;
    if (!cp) return;
    const o = cut.open;
    const { min, max } = geometry.boundingBox;
    for (const [side, sign] of [[cp.L, -1], [cp.R, 1]]) {
      side.pivot.visible = cut.active;
      side.pivot.position.set(sign * 0.04 * o, 0, min.z);
      side.pivot.rotation.y = sign * 0.7 * o;
      side.half.position.set(0, 0, -min.z);
      // sombra de contacto de cada mitad (media huella)
      const hx = sign < 0 ? -min.x : max.x;
      side.shadow.position.set(sign * hx * 0.5, 0.0006, (min.z + max.z) / 2);
      side.shadow.scale.set(hx, 1, max.z - min.z);
    }
    mesh.visible = !cut.active;
    contact.visible = !cut.active;
  }

  function syncPlanes() {
    if (!cutParts || !cut.active) return;
    for (const side of [cutParts.L, cutParts.R]) { side.half.updateWorldMatrix(true, false); side.sync(); }
  }

  // ---------- API ----------
  function set(next = {}) {
    if (!next || typeof next !== 'object') return api;
    for (const k of Object.keys(next)) {
      const v = next[k];
      if (k === 'shape') {
        if (!SHAPES.includes(v) || v === params.shape) continue;
        finishMorph(false);
        params.shape = v; seedsDirty = true; scoresDirty = true;
      } else if (k === 'stretchDir') {
        if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !(v.x || v.y)) continue;
        const l = Math.hypot(v.x, v.y);
        if (Math.abs(v.x / l - params.stretchDir.x) < 1e-6 && Math.abs(v.y / l - params.stretchDir.y) < 1e-6) continue;
        params.stretchDir.set(v.x / l, v.y / l);
      } else if (k === 'inTin') {
        if (params.inTin === !!v) continue;
        params.inTin = !!v;
      } else if (k in DEFAULTS && Number.isFinite(v)) {
        if (params[k] === v) continue;
        params[k] = v;
      } else continue;
      if (!DEFORM_KEYS.includes(k)) colorDirty = true;
      if (SLOW_KEYS.has(k)) slowDirty = true; else dirty = true;
    }
    return api;
  }

  /** Reconstruye ya si hay cualquier cambio pendiente. */
  function flush() {
    if (!dirty && !slowDirty) return;
    dirty = false; slowDirty = false; sinceBuild = 0;
    rebuild();
  }

  function finishMorph(ok) {
    if (!morph) return;
    const r = morph.resolve;
    morph = null;
    r?.(ok);
  }

  /**
   * Transforma la masa hacia otra forma base en `duration` segundos.
   * @param {'shaggy'|'ball'|'boule'|'baguette'|'loaf'} shape
   * @returns {Promise<boolean>} true al terminar; false si se interrumpe.
   */
  function morphTo(shape, duration = 1.2) {
    if (!SHAPES.includes(shape)) return Promise.resolve(false);
    if (shape === params.shape && !morph) return Promise.resolve(true);
    // instantánea de la forma actual (incluida una transformación a medias)
    morphFrom ??= makeBaseBuffers(n);
    copyBase(currentBase(), morphFrom);
    const from = morph ? morph.from : params.shape;
    finishMorph(false);
    params.shape = shape;
    dirty = true;
    if (!(duration > 0)) { seedsDirty = true; colorDirty = true; return Promise.resolve(true); }
    return new Promise((resolve) => { morph = { t: 0, dur: duration, resolve, from }; });
  }

  /**
   * Abolladura gaussiana que se recupera exponencialmente (prueba del dedo, presiones al amasar).
   * @param {THREE.Vector3} localPoint punto en coordenadas locales del grupo
   */
  function dent(localPoint, { radius = 0.03, depth = 0.012, recovery = 1.5 } = {}) {
    if (!localPoint) return;
    flush();
    // dirección de empuje = normal del vértice más cercano
    let best = 0, bd = Infinity;
    for (let j = 0; j < posArr.length; j += 3) {
      const dx = posArr[j] - localPoint.x, dy = posArr[j + 1] - localPoint.y, dz = posArr[j + 2] - localPoint.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = j; }
    }
    dents.push({
      x: localPoint.x, y: localPoint.y, z: localPoint.z,
      nx: -nrmArr[best], ny: -nrmArr[best + 1], nz: -nrmArr[best + 2],
      r: Math.max(0.004, radius), depth, k: recovery > 0 && Number.isFinite(recovery) ? 3 / recovery : 0, age: 0, amp: 0,
    });
    if (dents.length > MAX_DENTS) dents.shift();
    if (params.bake < 0.2) jiggle.v += 2.2 * clamp(depth / 0.012, 0, 2);
    dirty = true;
  }

  /**
   * Añade un corte (greña) como polilínea en XZ local (metros).
   * @param {THREE.Vector2[]} points
   */
  function addScore(points, { depth = 0.008, width = 0.006 } = {}) {
    if (!Array.isArray(points) || points.length < 2) return;
    // a espacio de la forma base (sin la escala horizontal actual) y remuestreado
    const raw = points.filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y)).map((q) => [q.x / hScale, q.y / hScale]);
    if (raw.length < 2) return;
    const pts = [raw[0][0], raw[0][1]];
    for (let i = 1; i < raw.length; i++) {
      const l = pts.length;
      if (Math.hypot(raw[i][0] - pts[l - 2], raw[i][1] - pts[l - 1]) >= 0.004 || i === raw.length - 1) pts.push(raw[i][0], raw[i][1]);
    }
    if (pts.length < 4) return;
    const cum = [0];
    let len = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (i) { len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); cum.push(len); }
      minX = Math.min(minX, pts[i]); maxX = Math.max(maxX, pts[i]);
      minZ = Math.min(minZ, pts[i + 1]); maxZ = Math.max(maxZ, pts[i + 1]);
    }
    if (len < 0.004) return;
    scores.push({ pts, cum, len, depth: Math.max(0, depth), width: Math.max(0.001, width), minX, maxX, minZ, maxZ });
    if (scores.length > 255) scores.shift();
    scoresDirty = true; colorDirty = true; dirty = true;
  }

  function clearScores() {
    scores.length = 0;
    if (sD) sD.fill(9);
    colorDirty = true; dirty = true;
  }

  /**
   * Cobertura: 'none' | 'flour' | 'sesame' | 'poppy' | 'eggwash'. Se pueden combinar con '+'
   * (p. ej. 'eggwash+sesame': barniz de huevo con semillas) o pasando un array.
   */
  function setTopping(name) {
    const t = parseTopping(name);
    if (!t) return;
    tops = t;
    topping = Array.isArray(name) ? name.join('+') : String(name);
    if (t.seeds) {
      const s = ensureSeeds();
      s.mesh.geometry = seedGeometry(t.seeds);
      seedMat.roughness = t.seeds === 'poppy' ? 0.55 : 0.45;
      s.mesh.visible = true;
      seedsDirty = true;
    } else if (seeds) {
      seeds.mesh.visible = false;
      syncCutSeeds();
    }
    // huevo: barniz brillante (capa clearcoat)
    const coat = t.egg ? 0.5 : 0;
    for (const m of [material, cutParts?.L.mat, cutParts?.R.mat]) {
      if (!m || m.clearcoat === coat) continue;
      if ((m.clearcoat > 0) !== (coat > 0)) m.needsUpdate = true;
      m.clearcoat = coat; m.clearcoatRoughness = 0.3;
    }
    colorDirty = true; dirty = true;
  }

  /**
   * Corta el pan por el plano local X = 0 y separa las mitades (open01 = 0 → entero).
   * @param {number} open01
   * @param {{openness?: number, density?: number, gumminess?: number, tunnels?: number}} [crumb]
   */
  function setCut(open01, crumb) {
    if (crumb && typeof crumb === 'object') {
      Object.assign(cut.crumb, crumb);
      cut.crumbDirty = true;
    }
    cut.open = clamp(Number(open01) || 0);
    const active = cut.open > 0;
    if (active && !cut.active) {
      ensureCutParts();
      cut.active = true;
      if (dirty || slowDirty) flush(); else buildCutCaps();
      syncCutSeeds();
    } else if (!active && cut.active) {
      cut.active = false;
      syncCutSeeds();
    } else if (active && cut.crumbDirty) {
      buildCutCaps();
    }
    applyCutPose();
    syncPlanes();
  }

  function reset() {
    finishMorph(false);
    Object.assign(params, DEFAULTS);
    params.stretchDir.set(1, 0);
    scores.length = 0; if (sD) sD.fill(9);
    dents.length = 0;
    setTopping('none');
    setCut(0);
    highlighter.set(false);
    jiggle.v = 0; jiggle.x = 0;
    mesh.scale.set(1, 1, 1);
    colorDirty = true; dirty = true;
  }

  function update(dt = 0, elapsed) {
    try {
      dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      elapsedT = Number.isFinite(elapsed) ? elapsed : elapsedT + dt;
      if (morph) {
        morph.t = Math.min(1, morph.t + dt / morph.dur);
        dirty = true;
        if (morph.t >= 1) { finishMorph(true); seedsDirty = true; colorDirty = true; }
      }
      for (let i = dents.length - 1; i >= 0; i--) {
        const d = dents[i];
        d.age += dt;
        const press = smoothstep(0, 0.07, d.age);
        const amp = d.depth * press * Math.exp(-d.k * Math.max(0, d.age - 0.07));
        if (Math.abs(amp - d.amp) > 1e-6) dirty = true;
        d.amp = amp;
        if (d.age > 0.07 && amp < 0.00015) { dents.splice(i, 1); dirty = true; }
      }
      sinceBuild += dt;
      if (dirty || (slowDirty && sinceBuild >= minInterval)) flush();
      // masa viva: respiración sutil + gelatina al tocarla
      const alive = 1 - smoothstep(0.05, 0.25, params.bake);
      jiggle.v += (-140 * jiggle.x - 7 * jiggle.v) * dt;
      jiggle.x += jiggle.v * dt;
      if (Math.abs(jiggle.x) < 1e-5 && Math.abs(jiggle.v) < 1e-4) { jiggle.x = 0; jiggle.v = 0; }
      const breath = alive * 0.004 * Math.sin(elapsedT * 1.4);
      const j = (breath + jiggle.x * 0.03 * alive) * (cut.active ? 0 : 1);
      mesh.scale.set(1 - j * 0.5, 1 + j, 1 - j * 0.5);
      syncPlanes();
      highlighter.update(dt);
    } catch (e) {
      if (!errorLogged) { errorLogged = true; console.error('[dough]', e); }
    }
  }

  const api = {
    group, mesh, params, update, set, morphTo, dent, addScore, clearScores, setTopping, setCut, reset,
    /** Altura local de la parte más alta. Con fresh=false no fuerza los cambios graduales pendientes (lecturas por frame). */
    getTopY: (fresh = true) => { if (fresh || dirty) flush(); return topY; },
    /** Tamaño actual {x, y, z} en metros (pan entero). */
    getSize: (fresh = true) => { if (fresh || dirty) flush(); return { x: size.x, y: size.y, z: size.z }; },
    /** Ritmo máximo (veces por segundo) al que se aplican los cambios graduales; 0 = cada frame. */
    setRebuildRate: (hz) => { minInterval = hz > 0 ? 1 / hz : 0; },
    /** Pulso emisivo para indicar que se puede interactuar. */
    setHighlight: (on) => highlighter.set(!!on),
    get topping() { return topping; },
    get isCut() { return cut.active; },
  };
  rebuild();
  dirty = false;
  slowDirty = false;
  warmShapes();
  return api;
}
