// Utilidades compartidas: matemáticas, ruido procedural y texturas generadas con canvas.
import * as THREE from 'three';

export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp((v - a) / (b - a));
export const remap = (v, a1, b1, a2, b2) => lerp(a2, b2, invLerp(a1, b1, v));
export const smoothstep = (a, b, v) => { const t = invLerp(a, b, v); return t * t * (3 - 2 * t); };
/** Amortiguación exponencial independiente del framerate. */
export const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));
export const degToRad = (d) => (d * Math.PI) / 180;

/** Generador pseudoaleatorio con semilla (mulberry32). */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Ruido de valor 3D (suave, determinista) ---
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);
/** Ruido de valor en [0,1]. */
export function noise3(x, y, z = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}
/** Ruido fractal (fbm) en [0,1]. */
export function fbm3(x, y, z = 0, octaves = 4) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) { sum += amp * noise3(x * freq, y * freq, z * freq); norm += amp; amp *= 0.5; freq *= 2; }
  return sum / norm;
}

/**
 * Crea una CanvasTexture dibujando con `draw(ctx, w, h)`.
 * @param {{repeat?: [number, number], srgb?: boolean, anisotropy?: number}} opts
 *   srgb=true para texturas de color (map), false para datos (roughnessMap, bumpMap...).
 */
export function makeCanvasTexture(w, h, draw, { repeat, srgb = true, anisotropy = 4 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(repeat[0], repeat[1]); }
  tex.needsUpdate = true;
  return tex;
}

/** Recorre los materiales de un objeto (útil para resaltar o atenuar). */
export function forEachMaterial(root, fn) {
  root.traverse((o) => {
    if (!o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => fn(m, o));
  });
}

/**
 * Resalta un objeto con un pulso emisivo suave. Devuelve una función update(dt) que hay
 * que llamar cada frame mientras dure; setHighlight(false) restaura los valores originales.
 */
export function makeHighlighter(root, color = 0xffc56b) {
  const saved = new Map();
  let on = false, time = 0;
  const target = new THREE.Color(color);
  return {
    set(v) {
      if (v === on) return;
      on = v;
      forEachMaterial(root, (m) => {
        if (!m.emissive) return;
        if (on) { if (!saved.has(m)) saved.set(m, { c: m.emissive.clone(), i: m.emissiveIntensity }); }
        else if (saved.has(m)) { const s = saved.get(m); m.emissive.copy(s.c); m.emissiveIntensity = s.i; }
      });
    },
    update(dt) {
      if (!on) return;
      time += dt;
      const k = 0.18 + 0.14 * Math.sin(time * 5);
      forEachMaterial(root, (m) => { if (m.emissive && saved.has(m)) { m.emissive.copy(target); m.emissiveIntensity = k; } });
    },
    get active() { return on; },
  };
}

/** "1 h 05 min" / "45 min" / "3 min 20 s" a partir de minutos simulados. */
export function formatMinutes(min) {
  if (min < 10 && min % 1 !== 0) {
    // Redondea los segundos totales primero: 0,995 min es «1 min 00 s», no «60 s».
    const sec = Math.round(min * 60);
    const m = Math.floor(sec / 60), s = sec % 60;
    if (sec < 600) return m > 0 ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`;
  }
  const total = Math.round(min);
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}
