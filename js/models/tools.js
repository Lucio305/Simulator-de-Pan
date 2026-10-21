// Utensilios de cocina, todos procedurales: báscula, bol, cuchara de madera, paño de cuadros,
// tabla de amasar, bandeja de horno, molde, cuchilla de greñar, cuchillo de pan y rejilla.
// Cada utensilio se coloca en coordenadas de mundo según layout.js y expone una API pequeña
// (show / hide / setHighlight + acciones animadas) que usan las etapas del juego.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { animate, ease } from '../core/anim.js';
import { clamp, lerp, smoothstep, makeRng, noise3, fbm3, makeCanvasTexture, makeHighlighter } from '../core/utils.js';
import { SPOTS, SIZES, COUNTER } from '../core/layout.js';

const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const v2 = (x, y) => new THREE.Vector2(x, y);
const qAxis = (axis, angle) => new THREE.Quaternion().setFromAxisAngle(axis, angle);
/** Producto de cuaterniones q0 * q1 * ... (el último es el primero en aplicarse). */
const qMul = (...qs) => qs.reduce((acc, q) => acc.multiply(q), new THREE.Quaternion());
/** Máximo suave (redondea la unión de dos contornos). */
const smoothMax = (a, b, k) => (a + b + Math.sqrt((a - b) * (a - b) + k * k)) / 2;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ---------------------------------------------------------------------------
// Utilidades de geometría y escena
// ---------------------------------------------------------------------------

/** Rectángulo de esquinas redondeadas centrado en el origen (plano XY). */
function roundedRect(w, h, r, path = new THREE.Shape()) {
  const x = -w / 2, y = -h / 2;
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x + w, y + h - r);
  path.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  path.lineTo(x + r, y + h);
  path.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x, y + r);
  path.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

/** UV plano a partir de x/y (geometrías construidas en el plano XY, antes de tumbarlas). */
function planarUV(geo, w, h) {
  const p = geo.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = p.getX(i) / w + 0.5;
    uv[i * 2 + 1] = p.getY(i) / h + 0.5;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/** Etiqueta las mallas con userData.tool y configura sus sombras. */
function finishMeshes(root, tool, cast = true, receive = true) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.tool = tool;
    o.castShadow = cast;
    o.receiveShadow = receive;
  });
}

const _box = new THREE.Box3();
/**
 * Pose de reposo: `obj` con la rotación q, apoyado sobre la encimera en (x, z).
 * Supone que el padre de `obj` no está transformado (el grupo de utensilios).
 */
function restingPose(obj, q, x, z, surfaceY = COUNTER.topY) {
  obj.position.set(x, 0, z);
  obj.quaternion.copy(q);
  obj.updateMatrixWorld(true);
  _box.setFromObject(obj, true);
  return { position: new THREE.Vector3(x, surfaceY - _box.min.y + 0.0003, z), quaternion: q.clone() };
}

/**
 * Lleva `obj` desde su pose actual a la del objetivo (o a la que devuelva una función, que puede
 * cambiar en vivo) siguiendo un arco. Devuelve la promesa cancelable de animate().
 */
function poseTween(obj, target, { duration = 0.7, arc = 0.1, easing = ease.inOutCubic } = {}) {
  const p0 = obj.position.clone(), q0 = obj.quaternion.clone();
  const get = typeof target === 'function' ? target : () => target;
  return animate({
    duration, ease: easing,
    onUpdate: (t, raw) => {
      const tg = get();
      obj.position.lerpVectors(p0, tg.position, t);
      obj.position.y += Math.sin(Math.PI * raw) * arc;
      obj.quaternion.slerpQuaternions(q0, tg.quaternion, t);
    },
  });
}

/** Base común: objeto en el mundo, grupo visual (lo que se resalta) y API show/hide/setHighlight. */
function baseTool(name, object, visual) {
  const hl = makeHighlighter(visual);
  return {
    name, object,
    show() { object.visible = true; },
    hide() { object.visible = false; },
    setHighlight(on) { hl.set(!!on); },
    _update(dt) { hl.update(dt); },
  };
}

// ---------------------------------------------------------------------------
// Texturas procedurales
// ---------------------------------------------------------------------------

/**
 * Evalúa fn(u, v) en una rejilla gruesa y devuelve un muestreador bilineal (u, v ∈ [0, 1]).
 * Así las texturas grandes no calculan ruido en cada píxel.
 */
function coarseField(gw, gh, fn) {
  const row = gw + 1, g = new Float32Array(row * (gh + 1));
  for (let j = 0; j <= gh; j++) for (let i = 0; i <= gw; i++) g[j * row + i] = fn(i / gw, j / gh);
  return (u, v) => {
    const x = clamp(u) * gw, y = clamp(v) * gh;
    const i = Math.min(gw - 1, x | 0), j = Math.min(gh - 1, y | 0);
    const fx = x - i, fy = y - j, k = j * row + i;
    return lerp(lerp(g[k], g[k + 1], fx), lerp(g[k + row], g[k + row + 1], fx), fy);
  };
}

/** Veta de madera clara y neutra (periódica en v); cada pieza la tiñe con material.color. */
function woodGrainTexture() {
  const W = 512, H = 128;
  const ring = (a, r, z) => [Math.cos(a * TAU) * r + z, Math.sin(a * TAU) * r];
  const warp = coarseField(48, 32, (u, v) => noise3(u * 3, ...ring(v, 0.8, 3)));
  const fibers = coarseField(24, H, (u, v) => noise3(u * 4, ...ring(v, 22, 40)));
  return makeCanvasTexture(W, H, (c) => {
    const img = c.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      const v = y / H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const n = warp(u, v);
        const t = v * 9 + n * 1.6;
        const ring5 = Math.pow(1 - Math.abs((t - Math.floor(t)) * 2 - 1), 5);
        const k = clamp(0.18 + ring5 * 0.5 + (fibers(u, v) - 0.5) * 0.45 + (n - 0.5) * 0.3);
        const i = (y * W + x) * 4;
        d[i] = 240 - 92 * k; d[i + 1] = 216 - 100 * k; d[i + 2] = 180 - 102 * k; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  });
}

/** Tabla de acacia: tablillas encoladas a lo largo de x, centro desgastado y marcas de cuchillo. */
function boardTextures() {
  const W = 1024, H = 736;
  const rng = makeRng(17);
  const palette = [[186, 126, 72], [156, 98, 54], [124, 76, 42], [200, 146, 88], [170, 110, 60], [140, 88, 48]];
  const strips = [];
  let acc = 0, last = -1;
  while (acc < 1) {
    let c = Math.floor(rng() * palette.length);
    if (c === last) c = (c + 1) % palette.length;
    last = c;
    const w = 0.1 + rng() * 0.08;
    const seed = 10 + Math.floor(rng() * 900);
    strips.push({
      v0: acc, v1: Math.min(1, acc + w), col: palette[c],
      warp: coarseField(48, 96, (u, v) => noise3(u * 2.2, v * 7, seed)),
      fiber: coarseField(24, H, (u, v) => noise3(u * 5, v * 300, seed + 5)),
    });
    acc += w;
  }
  const map = makeCanvasTexture(W, H, (c) => {
    const img = c.createImageData(W, H), d = img.data;
    let s = 0;
    for (let y = 0; y < H; y++) {
      const v = y / H;
      while (s < strips.length - 1 && strips[s].v1 < v) s++;
      const st = strips[s];
      const joint = Math.min(v - st.v0, st.v1 - v) * H;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        const n = st.warp(u, v);
        const t = v * 64 + n * 4.5;
        const ring = Math.pow(1 - Math.abs((t - Math.floor(t)) * 2 - 1), 6);
        const k = clamp(0.25 + ring * 0.45 + (st.fiber(u, v) - 0.5) * 0.55 + (n - 0.5) * 0.4);
        // centro más claro (raspado y enharinado mil veces) y bordes más aceitados
        const du = (u - 0.5) * 1.5, dv = (v - 0.5) * 1.1;
        const wear = Math.max(0, 1 - Math.sqrt(du * du + dv * dv) * 1.5);
        const edge = 1 - smoothstep(0, 0.035, Math.min(u, 1 - u, v, 1 - v));
        let shade = (1 - k * 0.36) * (1 - edge * 0.22);
        if (joint < 1.1) shade *= 0.74;
        const i = (y * W + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const base = st.col[ch] * shade;
          d[i + ch] = clamp(lerp(base, base * 0.75 + 62, wear * 0.3), 0, 255);
        }
        d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    // marcas de cuchillo y rasguños finos
    c.lineCap = 'round';
    for (let k = 0; k < 90; k++) {
      const x = W * (0.15 + rng() * 0.7), y = H * (0.15 + rng() * 0.7);
      const a = rng() * Math.PI, len = 10 + rng() * 60;
      c.strokeStyle = rng() < 0.5 ? 'rgba(255,236,205,0.10)' : 'rgba(60,32,14,0.10)';
      c.lineWidth = 0.6 + rng() * 0.9;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      c.stroke();
    }
  }, { anisotropy: 8 });
  const rough = makeCanvasTexture(256, 184, (c, w, h) => {
    const img = c.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const du = (x / w - 0.5) * 1.5, dv = (y / h - 0.5) * 1.1;
        const wear = Math.max(0, 1 - Math.sqrt(du * du + dv * dv) * 1.5);
        const g = 255 * clamp(0.66 + wear * 0.2 + (noise3(x * 0.08, y * 0.08, 4) - 0.5) * 0.12);
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false });
  return { map, rough };
}

/** Harina sobre la tabla: prioridad de cobertura (R), variación de tono (G) y grano del polvo (B). */
function flourFieldTexture() {
  const W = 512, H = 368;
  const cloudF = coarseField(64, 46, (u, v) => fbm3(u * 7, v * 5, 3, 4));
  const toneF = coarseField(128, 92, (u, v) => fbm3(u * 30, v * 30, 8, 2));
  return makeCanvasTexture(W, H, (c) => {
    const img = c.createImageData(W, H), d = img.data;
    const rng = makeRng(5);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const du = (u - 0.5) * 1.39, dv = v - 0.5;
        const center = 1 - smoothstep(0.05, 0.62, Math.sqrt(du * du + dv * dv));
        const grain = rng();
        const f = clamp(center * 0.55 + (cloudF(u, v) - 0.5) * 0.9 + 0.22 + (grain - 0.5) * 0.28);
        const i = (y * W + x) * 4;
        d[i] = f * 255; d[i + 1] = 200 + 55 * toneF(u, v); d[i + 2] = rng() * 255; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false });
}

/** Vichy (gingham) tejido con dobladillo cosido: 1024 px = 0,45 m. */
function ginghamTexture() {
  const S = 1024, checks = 32, cell = S / checks, hem = 18;
  return makeCanvasTexture(S, S, (c) => {
    const img = c.createImageData(S, S), d = img.data;
    const rng = makeRng(9);
    const rowN = Float32Array.from({ length: S }, () => rng());
    const colN = Float32Array.from({ length: S }, () => rng());
    const white = [247, 243, 235], red = [190, 34, 48], pink = mix3(white, red, 0.5);
    for (let y = 0; y < S; y++) {
      const cy = Math.floor(y / cell) & 1;
      for (let x = 0; x < S; x++) {
        const cx = Math.floor(x / cell) & 1;
        // vichy: urdimbre roja en columnas impares, trama roja en filas impares (mezcla = rosa)
        const col = cx && cy ? red : cx || cy ? pink : white;
        // ligamento tafetán (hilos de 2 px) solo como variación suave de luminancia + slubs
        const warpUp = (((x >> 1) + (y >> 1)) & 1) === 0;
        const along = warpUp ? (y & 1) : (x & 1);
        let shade = (warpUp ? 1 : 0.95) * (0.98 + along * 0.02);
        shade *= 1 + (rowN[y] - 0.5) * 0.05 + (colN[x] - 0.5) * 0.05;
        // dobladillo: tela doble y algo más oscura en el borde
        const e = Math.min(x, y, S - 1 - x, S - 1 - y);
        if (e < hem) shade *= e < 2 ? 0.8 : 0.93;
        const i = (y * S + x) * 4;
        d[i] = clamp(col[0] * shade, 0, 255);
        d[i + 1] = clamp(col[1] * shade, 0, 255);
        d[i + 2] = clamp(col[2] * shade, 0, 255);
        d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    // pespunte del dobladillo
    c.strokeStyle = 'rgba(150,30,40,0.85)';
    c.lineWidth = 1.6;
    c.setLineDash([7, 5]);
    c.strokeRect(hem - 5, hem - 5, S - 2 * (hem - 5), S - 2 * (hem - 5));
  }, { anisotropy: 8 });
}

/** Relieve del tejido (se repite: 64 px = 32 hilos). */
function weaveBumpTexture() {
  return makeCanvasTexture(64, 64, (c, w, h) => {
    const img = c.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const warpUp = (((x >> 1) + (y >> 1)) & 1) === 0;
        const along = warpUp ? (y & 1) : (x & 1);
        const g = 150 + (warpUp ? 60 : 0) + along * 30;
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false, repeat: [16, 16] });
}

/** Acero pavonado con pátina de horno (UV plano sobre la bandeja). */
function trayTextures() {
  const W = 512, H = 356;
  const blotF = coarseField(96, 67, (u, v) => fbm3(u * 6, v * 4.2, 2, 4));
  const bronzeF = coarseField(48, 34, (u, v) => fbm3(u * 3 + 7, v * 3, 9, 3));
  const rng = makeRng(31);
  const map = makeCanvasTexture(W, H, (c) => {
    const img = c.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const u = x / W, v = y / H;
        const blot = blotF(u, v);
        const fine = rng();
        const edge = 1 - smoothstep(0.02, 0.09, Math.min(u, 1 - u, v, 1 - v));
        const k = clamp((blot - 0.45) * 2.2 + edge * 0.6);
        const bronze = smoothstep(0.62, 0.8, bronzeF(u, v)) * 0.5;
        const i = (y * W + x) * 4;
        const base = 58 - k * 26 + (fine - 0.5) * 8;
        d[i] = base + bronze * 26; d[i + 1] = base - 3 + bronze * 12; d[i + 2] = base - 6; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    c.lineCap = 'round';
    for (let k = 0; k < 60; k++) {
      const x = W * (0.1 + rng() * 0.8), y = H * (0.1 + rng() * 0.8), a = rng() * Math.PI, len = 8 + rng() * 50;
      c.strokeStyle = 'rgba(170,170,165,0.10)';
      c.lineWidth = 0.5 + rng() * 0.6;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); c.stroke();
    }
  });
  const rough = makeCanvasTexture(256, 178, (c, w, h) => {
    const img = c.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = 255 * clamp(0.62 - (blotF(x / w, y / h) - 0.45) * 0.7);
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = g; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false });
  return { map, rough };
}

/** Papel de horno: tono crema con pliegues suaves. */
function parchmentTexture() {
  return makeCanvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#ecdcbc';
    c.fillRect(0, 0, w, h);
    const rng = makeRng(12);
    for (let k = 0; k < 26; k++) {
      const x = rng() * w, y = rng() * h, a = rng() * Math.PI, len = 40 + rng() * 140;
      c.strokeStyle = rng() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(150,120,80,0.16)';
      c.lineWidth = 0.8 + rng() * 1.5;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); c.stroke();
    }
  });
}

// ---------------------------------------------------------------------------
// Báscula digital
// ---------------------------------------------------------------------------

// Segmentos de cada carácter del display (a arriba, b/c derecha, d abajo, e/f izquierda, g centro)
const SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
  6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', E: 'afged', r: 'eg', ' ': '',
};

/** "1 254 g" con espacio fino como separador de miles. */
export function formatGrams(grams) {
  const n = Math.round(Number.isFinite(grams) ? grams : 0);
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${n < 0 ? '-' : ''}${s} g`;
}

/** Celdas del display de 4 dígitos para un número de gramos. */
function lcdCells(grams) {
  const n = Math.round(Number.isFinite(grams) ? grams : 0);
  if (n > 9999 || n < -999) return [' ', 'E', 'r', 'r'];
  const chars = String(Math.abs(n)).split('');
  if (n < 0) chars.unshift('-');
  while (chars.length < 4) chars.unshift(' ');
  return chars;
}

function drawSegDigit(c, x, y, w, h, t, segs) {
  const gap = 1.6, l = x + t / 2, r = x + w - t / 2, top = y + t / 2, mid = y + h / 2, bot = y + h - t / 2;
  const H = (yy, x0, x1) => [[x0 + gap, yy], [x0 + gap + t / 2, yy - t / 2], [x1 - gap - t / 2, yy - t / 2], [x1 - gap, yy], [x1 - gap - t / 2, yy + t / 2], [x0 + gap + t / 2, yy + t / 2]];
  const V = (xx, y0, y1) => [[xx, y0 + gap], [xx + t / 2, y0 + gap + t / 2], [xx + t / 2, y1 - gap - t / 2], [xx, y1 - gap], [xx - t / 2, y1 - gap - t / 2], [xx - t / 2, y0 + gap + t / 2]];
  const shapes = { a: H(top, l, r), g: H(mid, l, r), d: H(bot, l, r), f: V(l, top, mid), b: V(r, top, mid), e: V(l, mid, bot), c: V(r, mid, bot) };
  for (const s of segs) {
    const p = shapes[s];
    c.beginPath();
    c.moveTo(p[0][0], p[0][1]);
    for (let k = 1; k < p.length; k++) c.lineTo(p[k][0], p[k][1]);
    c.closePath();
    c.fill();
  }
}

/** Dibuja el LCD (fondo verdoso retroiluminado, segmentos "fantasma" y dígitos oscuros). */
function drawLcd(c, W, H, cells) {
  const g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#c6d2b2');
  g.addColorStop(1, '#a8b794');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  const v = c.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.62);
  v.addColorStop(0, 'rgba(255,255,240,0.18)');
  v.addColorStop(1, 'rgba(40,50,30,0.22)');
  c.fillStyle = v;
  c.fillRect(0, 0, W, H);
  const cw = 50, ch = 86, th = 10, top = 21;
  const xs = [28, 92, 170, 234]; // hueco fino entre millares y centenas
  c.save();
  c.transform(1, 0, -0.1, 1, 0.1 * (top + ch), 0); // cursiva de display
  c.fillStyle = 'rgba(38,52,30,0.07)';
  for (const x of xs) drawSegDigit(c, x, top, cw, ch, th, SEGMENTS[8]);
  c.fillStyle = '#1c2618';
  cells.forEach((ch0, k) => drawSegDigit(c, xs[k], top, cw, ch, th, SEGMENTS[ch0] ?? ''));
  c.restore();
  c.fillStyle = '#1c2618';
  c.font = 'bold 44px sans-serif';
  c.textBaseline = 'alphabetic';
  c.fillText('g', 308, top + ch - 4);
  c.font = 'bold 15px sans-serif';
  c.fillStyle = 'rgba(28,38,24,0.75)';
  c.fillText('▸0◂', 304, 34);
}

/** Panel frontal de cristal oscuro con el marco del LCD y los rótulos de los botones. */
function scalePanelTexture() {
  const W = 512, H = 100;
  return makeCanvasTexture(W, H, (c) => {
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#2c2e31');
    g.addColorStop(1, '#141517');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,255,255,0.05)';
    c.fillRect(0, 0, W, H * 0.35);
    // marco del display
    c.strokeStyle = 'rgba(205,210,214,0.6)';
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(W / 2 - 121, H / 2 - 41, 242, 82, 9);
    c.stroke();
    // rótulos junto a los botones (los botones físicos quedan encima de los círculos)
    const bl = ((0.076 - 0.055) / 0.152) * W, br = ((0.076 + 0.055) / 0.152) * W;
    c.strokeStyle = 'rgba(220,224,228,0.55)';
    c.lineWidth = 1.5;
    for (const bx of [bl, br]) { c.beginPath(); c.arc(bx, H / 2, 23, 0, TAU); c.stroke(); }
    c.fillStyle = 'rgba(230,232,235,0.85)';
    c.font = 'bold 15px sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('TARA', br - 56, H / 2);
    // icono de encendido
    const px = bl + 50, py = H / 2;
    c.strokeStyle = 'rgba(230,232,235,0.85)';
    c.lineWidth = 2.2;
    c.beginPath(); c.arc(px, py + 1, 8, -Math.PI * 0.32, Math.PI * 1.32); c.stroke();
    c.beginPath(); c.moveTo(px, py - 10); c.lineTo(px, py); c.stroke();
  });
}

function buildScale() {
  const object = new THREE.Group();
  object.name = 'scale';
  object.position.copy(SPOTS.scale);
  const visual = new THREE.Group();
  object.add(visual);

  // Cuerpo blanco: rectángulo redondeado extruido con bisel; el plato queda centrado en el origen
  const bodyH = 0.022, bev = 0.0045, bw = 0.19, z0 = -0.095, z1 = 0.13, cr = 0.03;
  const bodyGeo = new THREE.ExtrudeGeometry(roundedRect(bw - 2 * bev, z1 - z0 - 2 * bev, cr - bev), {
    depth: bodyH - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 4, curveSegments: 10,
  });
  bodyGeo.rotateX(-Math.PI / 2);
  bodyGeo.translate(0, bev, (z0 + z1) / 2);
  const body = new THREE.Mesh(bodyGeo, new THREE.MeshPhysicalMaterial({
    color: 0xf4f2ed, roughness: 0.34, clearcoat: 0.6, clearcoatRoughness: 0.18, envMapIntensity: 0.6,
  }));
  visual.add(body);

  // Pie del plato y plato de acero cepillado (anillos concéntricos en v del torno)
  const plateTop = SIZES.scaleHeight;
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.054, plateTop - 0.0035 - bodyH, 40),
    new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.5, envMapIntensity: 0.5 }),
  );
  pedestal.position.y = bodyH + (plateTop - 0.0035 - bodyH) / 2;
  visual.add(pedestal);
  const py = plateTop - 0.0035;
  const platePts = [v2(0, py), v2(0.08, py), v2(0.0838, py + 0.0003), v2(0.0853, py + 0.0013), v2(0.0855, py + 0.0024), v2(0.0846, py + 0.0032), v2(0.0826, plateTop)];
  for (let k = 1; k <= 24; k++) platePts.push(v2(0.0826 * (1 - k / 24), plateTop));
  const brushed = makeCanvasTexture(4, 256, (c, w, h) => {
    const rng = makeRng(77);
    let g = 0.3;
    for (let y = 0; y < h; y++) {
      g = clamp(g + (rng() - 0.5) * 0.12, 0.18, 0.42);
      c.fillStyle = `rgb(0,${Math.round(g * 255)},0)`;
      c.fillRect(0, y, w, 1);
    }
  }, { srgb: false });
  const plate = new THREE.Mesh(new THREE.LatheGeometry(platePts, 72), new THREE.MeshStandardMaterial({
    color: 0xdfe2e5, metalness: 1, roughness: 1, roughnessMap: brushed,
  }));
  visual.add(plate);

  // Panel frontal (cristal oscuro) + LCD + botones
  const panelW = 0.152, panelD = 0.03, panelZ = 0.107;
  const panelGeo = planarUV(new THREE.ShapeGeometry(roundedRect(panelW, panelD, 0.006), 6), panelW, panelD);
  panelGeo.rotateX(-Math.PI / 2);
  const panel = new THREE.Mesh(panelGeo, new THREE.MeshPhysicalMaterial({
    map: scalePanelTexture(), roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.8,
  }));
  panel.position.set(0, bodyH + 0.0004, panelZ);
  visual.add(panel);

  const lcdTex = makeCanvasTexture(384, 128, () => {});
  const lcdCtx = lcdTex.image.getContext('2d');
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.068, 0.0226).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({
    map: lcdTex, emissiveMap: lcdTex, emissive: 0xffffff, emissiveIntensity: 0.55, roughness: 0.22, envMapIntensity: 0.5,
  }));
  lcd.position.set(0, bodyH + 0.0008, panelZ);
  visual.add(lcd);

  const btnGeo = new THREE.LatheGeometry([v2(0.0056, 0), v2(0.0055, 0.0006), v2(0.0049, 0.0012), v2(0.0034, 0.0016), v2(0, 0.0018)], 24);
  const buttons = new THREE.InstancedMesh(btnGeo, new THREE.MeshPhysicalMaterial({ color: 0xc9ccd0, roughness: 0.3, clearcoat: 0.5, envMapIntensity: 0.6 }), 2);
  const m = new THREE.Matrix4();
  [-0.055, 0.055].forEach((x, k) => buttons.setMatrixAt(k, m.makeTranslation(x, bodyH + 0.0004, panelZ)));
  visual.add(buttons);

  finishMeshes(visual, 'scale');
  lcd.castShadow = panel.castShadow = buttons.castShadow = false;

  const plateAnchor = new THREE.Object3D();
  plateAnchor.name = 'scale.plate';
  plateAnchor.position.y = plateTop;
  object.add(plateAnchor);

  let reading = NaN, shown = '';
  const tool = {
    ...baseTool('scale', object, visual),
    anchors: { plate: plateAnchor },
    /** Último valor mostrado (gramos). */
    get reading() { return reading; },
    /** Texto del display ("1 254 g"). */
    get text() { return shown; },
    /**
     * Muestra un peso en el LCD. Solo se redibuja si el texto cambia.
     * @param {number} grams
     */
    setReading(grams) {
      const text = formatGrams(grams);
      reading = Math.round(Number.isFinite(grams) ? grams : 0);
      if (text === shown) return;
      shown = text;
      drawLcd(lcdCtx, 384, 128, lcdCells(grams));
      lcdTex.needsUpdate = true;
    },
  };
  tool.setReading(0);
  return tool;
}

// ---------------------------------------------------------------------------
// Bol de gres esmaltado
// ---------------------------------------------------------------------------

const COBALT_DEEP = [20, 40, 104], COBALT_MID = [36, 72, 152], COBALT_LIGHT = [96, 128, 188];
const GLAZE_TAN = [192, 160, 116], CREAM = [242, 234, 216], CREAM_SHADE = [228, 216, 192], BISQUE = [176, 150, 118];

/**
 * Texturas del bol pintadas sobre el perfil del torno (u = vuelta, v = punto del perfil).
 * T = longitud de arco de cada punto del perfil, Rp = su radio, z = longitudes de las zonas.
 */
function bowlTextures(T, Rp, z) {
  const n = T.length;
  const atV = (arr, v) => {
    const f = clamp(v) * (n - 1), j = Math.min(n - 2, Math.floor(f));
    return lerp(arr[j], arr[j + 1], f - j);
  };
  const tAtV = (v) => atV(T, v);
  const W = 640, H = 1024;
  const rng = makeRng(3);
  // borde del esmalte junto al pie, con alguna gota que baja
  const drips = Array.from({ length: 11 }, () => ({ u: rng(), w: 0.006 + rng() * 0.012, l: 0.0015 + rng() * 0.0035 }));
  const glazeEdgeAt = (u) => {
    const a = u * TAU;
    let e = z.foot + 0.0048 + 0.0014 * (noise3(Math.cos(a) * 3, Math.sin(a) * 3, 5) - 0.5) * 2;
    for (const dr of drips) {
      let du = Math.abs(u - dr.u);
      du = Math.min(du, 1 - du);
      if (du < dr.w) e -= dr.l * Math.sqrt(1 - (du / dr.w) ** 2);
    }
    return Math.max(z.foot + 0.0009, e);
  };
  const edges = Float32Array.from({ length: W }, (_, x) => glazeEdgeAt(x / W));
  const rowT = Float32Array.from({ length: H }, (_, y) => tAtV(1 - (y + 0.5) / H));
  // ruido periódico en u (alrededor del bol) evaluado en rejillas gruesas; t normalizado en [0, 1]
  const tMax = T[n - 1];
  const around = (u, r, z) => [Math.cos(u * TAU) * r + z, Math.sin(u * TAU) * r];
  const mottF = coarseField(64, 160, (u, tn) => noise3(...around(u, 2.2, 0), tn * tMax * 35));
  const streakF = coarseField(256, 32, (u, tn) => noise3(...around(u, 18, 0), tn * tMax * 6));
  const innerF = coarseField(64, 160, (u, tn) => noise3(...around(u, 3, 11), tn * tMax * 25));
  const bandC = Float32Array.from({ length: W }, (_, x) => 0.012 + 0.0007 * (noise3(...around(x / W, 4, 0), 9) - 0.5) * 2);
  const bandW = Float32Array.from({ length: W }, (_, x) => 0.0019 + 0.0004 * (noise3(...around(x / W, 7, 0), 2) - 0.5) * 2);

  const map = makeCanvasTexture(W, H, (c) => {
    const img = c.createImageData(W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      const t = rowT[y], tn = t / tMax;
      for (let x = 0; x < W; x++) {
        const u = x / W;
        let col;
        if (t < z.rimA) {
          const e = edges[x];
          if (t < e) {
            col = mix3(BISQUE, [150, 124, 96], rng() * 0.6);
          } else {
            col = mix3(COBALT_DEEP, COBALT_MID, clamp(0.4 + (mottF(u, tn) - 0.5) * 0.9 + (streakF(u, tn) - 0.5) * 0.6));
            const pool = 1 - smoothstep(0, 0.005, t - e);
            col = mix3(col, [14, 26, 70], pool * 0.55);
            col = mix3(col, COBALT_LIGHT, smoothstep(z.rimA - 0.018, z.rimA, t) * 0.6);
          }
        } else if (t < z.rimB) {
          const k = (t - z.rimA) / (z.rimB - z.rimA);
          col = k < 0.5 ? mix3(COBALT_LIGHT, GLAZE_TAN, smoothstep(0.08, 0.5, k)) : mix3(GLAZE_TAN, CREAM, smoothstep(0.5, 0.92, k));
        } else {
          const di = t - z.rimB;
          col = mix3(CREAM, CREAM_SHADE, clamp(0.3 + (innerF(u, tn) - 0.5) * 1.2));
          // banda azul pintada a mano bajo el borde
          const bw = bandW[x];
          const band = 1 - smoothstep(bw * 0.6, bw, Math.abs(di - bandC[x]));
          col = mix3(col, COBALT_MID, band * 0.9);
          const pool = smoothstep(z.wallEnd - 0.03, z.wallEnd, t);
          col = mix3(col, [222, 206, 176], pool * 0.35);
        }
        const i = (y * W + x) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
    // motas de hierro del gres: tamaño en metros y densidad según la superficie real de cada fila
    const rowR = Float32Array.from({ length: H }, (_, y) => atV(Rp, 1 - (y + 0.5) / H));
    const rowA = Float32Array.from({ length: H }, (_, y) => rowR[y] * Math.abs(rowT[Math.min(H - 1, y + 1)] - rowT[Math.max(0, y - 1)]) / 2);
    const maxA = Math.max(...rowA);
    for (let placed = 0, tries = 0; placed < 1500 && tries < 20000; tries++) {
      const y = Math.floor(rng() * H);
      if (rowR[y] < 0.012 || rng() * maxA > rowA[y]) continue;
      placed++;
      const size = 0.0004 + rng() * 0.0008;
      const rx = clamp((size * W) / (TAU * rowR[y]), 0.4, 6), ry = clamp((size * rowR[y]) / Math.max(1e-6, rowA[y]), 0.4, 6);
      c.fillStyle = `rgba(${90 + rng() * 30},${58 + rng() * 20},${36 + rng() * 14},${0.35 + rng() * 0.45})`;
      c.beginPath();
      c.ellipse(rng() * W, y + rng(), rx, ry, 0, 0, TAU);
      c.fill();
    }
  }, { anisotropy: 8 });

  // R = clearcoat (esmalte), G = rugosidad
  const DW = 256, DH = 512;
  const data = makeCanvasTexture(DW, DH, (c) => {
    const img = c.createImageData(DW, DH), d = img.data;
    for (let y = 0; y < DH; y++) {
      const t = tAtV(1 - (y + 0.5) / DH);
      for (let x = 0; x < DW; x++) {
        const glazed = t >= z.rimA || t >= edges[Math.floor((x / DW) * W)];
        const brk = t > z.rimA && t < z.rimB ? 1 - Math.abs((t - z.rimA) / (z.rimB - z.rimA) - 0.5) * 2 : 0;
        const i = (y * DW + x) * 4;
        d[i] = glazed ? 255 - brk * 60 : 0;
        d[i + 1] = glazed ? 255 * (0.26 + brk * 0.12 + rng() * 0.04) : 255 * 0.86;
        d[i + 2] = 0;
        d[i + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }, { srgb: false });

  // anillos de torneado (relieve muy suave en las paredes)
  const bump = makeCanvasTexture(4, 1024, (c, w, h) => {
    for (let y = 0; y < h; y++) {
      const t = tAtV(1 - (y + 0.5) / h);
      const onWall = (t > z.foot + 0.008 && t < z.rimA - 0.004) || (t > z.rimB + 0.004 && t < z.wallEnd - 0.006);
      const g = 128 + (onWall ? 70 * Math.sin((t * TAU) / 0.0066) * (0.55 + 0.45 * noise3(t * 60, 1, 2)) : 0);
      c.fillStyle = `rgb(${g},${g},${g})`;
      c.fillRect(0, y, w, 1);
    }
  }, { srgb: false });
  return { map, data, bump };
}

function buildBowl() {
  const { rimRadius: R, height: H, baseRadius: B, wall: W } = SIZES.bowl;
  const c0 = W + 0.002; // fondo interior = origen de los contenidos
  // exterior algo más abombado que el interior (contrato de layout para el interior)
  const rOut = (y) => B + (R - B) * Math.pow(clamp(y / H), 0.56);
  const rIn = (y) => B + (R - B) * Math.pow(clamp((y - c0) / H), 0.7) - W;
  // labio redondeado: semicircunferencia entre pared exterior e interior, con la cima en y = H
  let rad = 0.0045;
  for (let k = 0; k < 4; k++) rad = (rOut(H - rad) - rIn(H - rad)) / 2;
  const yTop = H - rad, xc = (rOut(yTop) + rIn(yTop)) / 2;

  const pts = [];
  // fondo rebajado + anillo de apoyo sin esmaltar
  [[0, 0.0026], [0.03, 0.0026], [0.051, 0.0024], [0.0555, 0.0017], [0.0578, 0.0006], [0.0605, 0], [0.0665, 0],
    [0.069, 0.0006], [0.0706, 0.0019], [0.0716, 0.0036], [0.0748, 0.0047]].forEach(([x, y]) => pts.push(v2(x, y)));
  const iFoot = pts.length - 1;
  const n = 30;
  for (let k = 0; k <= n; k++) {
    const y = 0.0058 + (yTop - 0.0058) * Math.pow(k / n, 1.3);
    pts.push(v2(rOut(y), y));
  }
  const iRimA = pts.length - 1;
  for (let k = 1; k < 14; k++) {
    const a = (Math.PI * k) / 14;
    pts.push(v2(xc + rad * Math.cos(a), yTop + rad * Math.sin(a)));
  }
  const iRimB = pts.length;
  for (let k = 0; k <= n; k++) {
    const y = c0 + 0.0002 + (yTop - c0 - 0.0002) * Math.pow(1 - k / n, 1.5);
    pts.push(v2(rIn(y), y));
  }
  const iWallEnd = pts.length - 1;
  const r0 = B - W;
  pts.push(v2(r0 - 0.0007, W + 0.0011), v2(r0 - 0.0022, W + 0.0002), v2(r0 - 0.0045, W), v2(0.035, W), v2(0, W));

  const T = [0];
  for (let j = 1; j < pts.length; j++) T.push(T[j - 1] + pts[j].distanceTo(pts[j - 1]));
  const tex = bowlTextures(T, pts.map((p) => p.x), { foot: T[iFoot], rimA: T[iRimA], rimB: T[iRimB], wallEnd: T[iWallEnd] });

  const object = new THREE.Group();
  object.name = 'bowl';
  const visual = new THREE.Group();
  object.add(visual);
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 80), new THREE.MeshPhysicalMaterial({
    map: tex.map, roughness: 1, roughnessMap: tex.data, metalness: 0,
    clearcoat: 0.8, clearcoatMap: tex.data, clearcoatRoughness: 0.08,
    bumpMap: tex.bump, bumpScale: 0.14, envMapIntensity: 0.5,
  }));
  visual.add(mesh);
  finishMeshes(visual, 'bowl');

  const contents = new THREE.Object3D();
  contents.name = 'bowl.contents';
  contents.position.set(0, c0, 0);
  const rim = new THREE.Object3D();
  rim.name = 'bowl.rim';
  rim.position.set(0, H, 0);
  object.add(contents, rim);

  return {
    ...baseTool('bowl', object, visual),
    anchors: { contents, rim },
    /** Radio interior a la altura y medida desde anchors.contents (m). */
    innerRadiusAt: (y) => B + (R - B) * Math.pow(clamp(y / H), 0.7) - W,
    /** Radio del centro del labio (donde apoya el paño). */
    rimRadius: xc,
    /** Radio exterior a la altura y del bol (origen = fondo exterior), incluido el labio. */
    outerRadiusAt: (y) => (y <= yTop ? rOut(Math.max(0, y)) : xc + Math.sqrt(Math.max(0, rad * rad - (y - yTop) ** 2))),
  };
}

// ---------------------------------------------------------------------------
// Cuchara de madera
// ---------------------------------------------------------------------------

/** Cuchara tallada: secciones elípticas a lo largo de x, cazoleta cóncava. Origen = centro de la cazoleta. */
function spoonGeometry() {
  const L = 0.3, N = 84, M = 28, ORIGIN = 0.044;
  const pos = [], uv = [], idx = [];
  for (let i = 0; i < N; i++) {
    const x = L * (0.5 - 0.5 * Math.cos((Math.PI * i) / (N - 1)));
    const eb = (x - 0.043) / 0.043;
    const bowlW = eb < 1 ? 0.031 * Math.sqrt(Math.max(0, 1 - eb * eb)) : 0;
    let handleW = (0.0062 + 0.0058 * smoothstep(0.1, 0.27, x)) * smoothstep(0.05, 0.082, x);
    const ce = (x - 0.272) / 0.028;
    if (ce > 0) handleW *= Math.sqrt(Math.max(0, 1 - ce * ce));
    const hw = Math.max(0, smoothMax(bowlW, handleW, 0.006) - 0.003);
    const ht = lerp(0.0029, 0.0052, smoothstep(0.07, 0.15, x)) * Math.sqrt(clamp(x / 0.006)) * Math.sqrt(clamp((L - x) / 0.006));
    const ed = (x - 0.044) / 0.036;
    const dish = ed * ed < 1 ? 0.0105 * Math.pow(1 - ed * ed, 0.8) : 0;
    const yc = 0.0075 * smoothstep(0.07, 0.17, x);
    for (let j = 0; j <= M; j++) {
      const a = (j / M) * TAU, co = Math.cos(a), si = Math.sin(a);
      pos.push(x - ORIGIN, yc + ht * si - dish * (1 - co * co), hw * co);
      uv.push(x / L, j / M);
    }
  }
  for (let i = 0; i < N - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * (M + 1) + j, b = a + M + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // costura: promedia las normales de la primera y la última columna
  const nrm = geo.attributes.normal, tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const a = i * (M + 1), b = a + M;
    tmp.fromBufferAttribute(nrm, a).add(tmp2.fromBufferAttribute(nrm, b)).normalize();
    nrm.setXYZ(a, tmp.x, tmp.y, tmp.z);
    nrm.setXYZ(b, tmp.x, tmp.y, tmp.z);
  }
  return geo;
}

function buildSpoon(group, woodTex, bowlTool) {
  const object = new THREE.Group();
  object.name = 'spoon';
  const visual = new THREE.Group();
  object.add(visual);
  const mesh = new THREE.Mesh(spoonGeometry(), new THREE.MeshStandardMaterial({ map: woodTex, color: 0xe2b27a, roughness: 0.55, envMapIntensity: 0.4 }));
  visual.add(mesh);
  finishMeshes(visual, 'spoon');
  const scoop = new THREE.Object3D();
  scoop.name = 'spoon.scoop';
  object.add(scoop);
  group.add(object);

  // Reposo: tumbada, con la cazoleta y el extremo del mango tocando la encimera
  const pitch = -0.055;
  const yaw = -0.1;
  const qRest = qMul(qAxis(UP, yaw), qAxis(Z_AXIS, pitch));
  const mid = new THREE.Vector3(0.105, 0, 0).applyQuaternion(qRest);
  const rest = restingPose(object, qRest, SPOTS.spoonRest.x - mid.x, SPOTS.spoonRest.z - mid.z);
  object.position.copy(rest.position);
  object.quaternion.copy(rest.quaternion);

  let state = 'home'; // home | entering | stirring | leaving
  let anim = null, angle = 0, depth = 0.5, trackBowl = null;
  const fixedBowl = new THREE.Vector3();
  const pose = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  const tmpW = new THREE.Vector3(), out = new THREE.Vector3(), tan = new THREE.Vector3();
  const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3(), basis = new THREE.Matrix4();

  // Pose de remover: la cazoleta gira dentro del bol y el mango se inclina hacia fuera, como sujeta por una mano
  function stirPose() {
    if (trackBowl) trackBowl.getWorldPosition(tmpW); else tmpW.copy(fixedBowl);
    const { wall } = SIZES.bowl;
    const r = 0.07 - 0.006 * depth;
    const y = lerp(0.086, wall + 0.047, depth);
    out.set(Math.cos(angle), 0, -Math.sin(angle));
    tan.set(-Math.sin(angle), 0, -Math.cos(angle));
    pose.position.copy(tmpW).addScaledVector(out, r);
    pose.position.y += y;
    group.worldToLocal(pose.position);
    const lean = 0.6, drag = 0.22;
    ax.copy(UP).multiplyScalar(Math.cos(lean)).addScaledVector(out, Math.sin(lean)).addScaledVector(tan, -Math.sin(drag)).normalize();
    ay.copy(tan).addScaledVector(ax, -tan.dot(ax)).normalize();
    az.crossVectors(ax, ay);
    pose.quaternion.setFromRotationMatrix(basis.makeBasis(ax, ay, az));
    return pose;
  }
  const applyStir = () => {
    const p = stirPose();
    object.position.copy(p.position);
    object.quaternion.copy(p.quaternion);
  };

  const base = baseTool('spoon', object, visual);
  return {
    ...base,
    anchors: { scoop },
    /** true mientras está dentro del bol (entrando o removiendo). */
    get isStirring() { return state === 'entering' || state === 'stirring'; },
    /**
     * Mete la cuchara en el bol (o la devuelve a su sitio). Animado e interrumpible.
     * @param {boolean} active
     * @param {THREE.Vector3} [bowlWorldPos] origen del bol (fondo exterior); por defecto sigue a tools.bowl
     */
    setStirring(active, bowlWorldPos) {
      const inside = state === 'entering' || state === 'stirring';
      if (active) {
        trackBowl = bowlWorldPos ? null : bowlTool.object;
        if (bowlWorldPos) fixedBowl.set(bowlWorldPos.x, bowlWorldPos.y, bowlWorldPos.z);
        if (inside) return;
        anim?.cancel();
        state = 'entering';
        const a = (anim = poseTween(object, stirPose, { duration: 0.75, arc: 0.12 }));
        a.then((ok) => { if (ok && anim === a) { state = 'stirring'; anim = null; } });
      } else {
        if (!inside) return;
        anim?.cancel();
        state = 'leaving';
        const a = (anim = poseTween(object, rest, { duration: 0.7, arc: 0.1 }));
        a.then((ok) => { if (ok && anim === a) { state = 'home'; anim = null; } });
      }
    },
    /**
     * Ángulo de giro alrededor del bol y profundidad (0 = cerca del borde, 1 = cerca del fondo).
     * 0 rad = lado +x del bol; al aumentar gira en sentido antihorario visto desde arriba y la
     * cazoleta empuja en ese sentido.
     * @param {number} radians
     * @param {number} [depth01=0.5]
     */
    setStirAngle(radians, depth01 = 0.5) {
      if (Number.isFinite(radians)) angle = radians;
      if (Number.isFinite(depth01)) depth = clamp(depth01);
      if (state === 'stirring') applyStir();
    },
    /** Vuelve a su sitio sin animación. */
    reset() {
      anim?.cancel();
      anim = null;
      state = 'home';
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
    },
    _update(dt) {
      base._update(dt);
      if (state === 'stirring' && trackBowl) applyStir();
    },
  };
}

// ---------------------------------------------------------------------------
// Paño de cocina (vichy) que se despliega sobre el bol
// ---------------------------------------------------------------------------

const CLOTH = {
  size: 0.45, segs: 128, ringsIn: 12, ringsOut: 30, thick: 0.0016, hover: 0.08, sag: 0.014, folds: 9, foldMax: 0.032,
  layer: 0.002, lutStep: 0.001, lutN: 260, hang: 1.38,
};

/** Caja mullida (paño doblado): caja subdividida proyectada sobre una caja redondeada y abombada. */
function pillowGeometry(w, h, d, r, puff) {
  const g = new THREE.BoxGeometry(w, h, d, 10, 2, 18);
  const p = g.attributes.position, nrm = g.attributes.normal;
  const v = new THREE.Vector3(), inner = new THREE.Vector3();
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    inner.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz));
    v.sub(inner).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
    v.multiplyScalar(r).add(inner);
    if (v.y > 0) v.y += puff * (1 - (v.x / (w / 2)) ** 2) * (1 - (v.z / (d / 2)) ** 2);
    p.setXYZ(i, v.x, v.y + h / 2, v.z);
  }
  return g;
}

/**
 * Malla polar del paño (cuadrado en el espacio de la tela): un anillo cae justo sobre el borde del bol
 * (radio rc) y los anillos se aprietan donde la tela se dobla, así el borde no queda dentado.
 */
function clothGeometry(S, rc) {
  const { segs, ringsIn, ringsOut } = CLOTH;
  const rings = ringsIn + ringsOut + 1;
  const pos = [], uv = [], idx = [];
  for (let k = 0; k < segs; k++) {
    const th = (k / segs) * TAU, c = Math.cos(th), sn = Math.sin(th);
    const edge = S / 2 / Math.max(Math.abs(c), Math.abs(sn));
    for (let j = 0; j < rings; j++) {
      const r = j <= ringsIn ? rc * (j / ringsIn) : rc + (edge - rc) * Math.pow((j - ringsIn) / ringsOut, 1.6);
      pos.push(r * c, 0, r * sn);
      uv.push((r * c) / S + 0.5, 0.5 - (r * sn) / S);
    }
  }
  for (let k = 0; k < segs; k++) {
    const k2 = (k + 1) % segs;
    for (let j = 0; j < rings - 1; j++) {
      const a = k * rings + j, b = k2 * rings + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.userData.rings = rings;
  return geo;
}

function buildCloth(ctx, group, bowlTool) {
  const S = CLOTH.size;
  const tex = ginghamTexture();
  const weave = weaveBumpTexture();
  const makeMat = (map) => new THREE.MeshPhysicalMaterial({
    map, roughness: 0.92, bumpMap: weave, bumpScale: 0.6,
    sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xfff4f0), side: THREE.DoubleSide, envMapIntensity: 0.35,
  });

  const object = new THREE.Group();
  object.name = 'cloth';
  group.add(object);

  // Paño doblado en octavos (0,1125 × 0,225 m): la cara de arriba enseña una esquina con dobladillo
  const foldedTex = tex.clone();
  foldedTex.repeat.set(0.25, 0.5);
  foldedTex.offset.set(0.75, 0);
  foldedTex.needsUpdate = true;
  const foldedH = 0.016;
  const folded = new THREE.Mesh(pillowGeometry(S / 4, foldedH, S / 2, 0.0075, 0.0025), makeMat(foldedTex));
  folded.material.side = THREE.FrontSide;
  object.add(folded);

  // Paño desplegable: malla polar cuya forma calcula el código (doblado, cayendo, puesto)
  const geo = clothGeometry(S, bowlTool.rimRadius);
  const drape = new THREE.Mesh(geo, makeMat(tex));
  drape.visible = false;
  drape.frustumCulled = false;
  object.add(drape);
  finishMeshes(object, 'cloth');

  const pos = geo.attributes.position;
  const N = pos.count;
  const mx = new Float32Array(N), mz = new Float32Array(N), mr = new Float32Array(N);
  const fold1 = new Uint8Array(N), fold2 = new Uint8Array(N), fold3 = new Uint8Array(N);
  const wrinkle = new Float32Array(N), foldWave = new Float32Array(N);
  let rMax = 0;
  for (let i = 0; i < N; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    mx[i] = x; mz[i] = z; mr[i] = Math.hypot(x, z);
    rMax = Math.max(rMax, mr[i]);
    fold1[i] = x < -1e-6 ? 1 : 0;
    fold2[i] = z < -1e-6 ? 1 : 0;
    fold3[i] = Math.abs(x) < S / 4 - 1e-6 ? 1 : 0;
    wrinkle[i] = (fbm3(x * 22, z * 22, 3, 3) - 0.5) * 2;
    const th = Math.atan2(z, x);
    // ondas de los pliegues: lóbulos redondeados hacia fuera y surcos más marcados hacia dentro
    const c = Math.cos(CLOTH.folds * th + 1.3 * Math.sin(2 * th + 0.7) + 0.8 * Math.sin(3 * th + 2.1) + mr[i] * 12);
    foldWave[i] = (Math.pow((c + 1) / 2, 1.6) * 2 - 0.75) * (0.75 + 0.5 * noise3(Math.cos(th) * 1.6, Math.sin(th) * 1.6, 7));
  }

  // Perfil de caída por fuera del borde (rho, y) en función de la tela que sobra más allá del borde
  const lutR = new Float32Array(CLOTH.lutN), lutY = new Float32Array(CLOTH.lutN);
  const st = { bowl: null, floor: 0, top: 0, rc: 0.145, bulge: 0, mode: 'rest', dirty: false };
  function buildLut() {
    let x = st.rc, y = st.top;
    const floorTop = st.floor + CLOTH.thick;
    for (let k = 0; k < CLOTH.lutN; k++) {
      lutR[k] = x; lutY[k] = y;
      let phi = CLOTH.hang * (1 - Math.exp(-(k * CLOTH.lutStep) / 0.01));
      const h = y - floorTop;
      if (h < 0.012) phi *= Math.pow(clamp(h / 0.012), 0.6);
      x += Math.cos(phi) * CLOTH.lutStep;
      y -= Math.sin(phi) * CLOTH.lutStep;
    }
  }

  /** Posición final del vértice i sobre el bol (coordenadas del bol). */
  function drapeAt(i, out) {
    const r = mr[i];
    if (r <= st.rc) {
      const q2 = (r / st.rc) ** 2;
      const sag = CLOTH.sag * (1 - smoothstep(0, 0.02, st.bulge));
      const y = st.top - sag * (1 - q2) + st.bulge * Math.pow(1 - q2, 1.3) + wrinkle[i] * 0.0011 * (1 - q2 * q2);
      return out.set(mx[i], y, mz[i]);
    }
    const s = r - st.rc, f = s / CLOTH.lutStep;
    const k = Math.min(CLOTH.lutN - 2, Math.floor(f)), t = Math.min(1, f - k);
    const rho = lerp(lutR[k], lutR[k + 1], t);
    let y = lerp(lutY[k], lutY[k + 1], t);
    // la tela que sobra (más en las esquinas) forma pliegues: amplitud según el exceso de perímetro
    const excess = Math.max(0, r / rho - 1);
    const A = Math.min(CLOTH.foldMax, (1.6 * rho * Math.sqrt(excess)) / CLOTH.folds) * smoothstep(0.014, 0.05, s);
    const onFloor = y < st.floor + CLOTH.thick + 0.004;
    if (onFloor) y += Math.max(0, foldWave[i]) * A * 0.5;
    else y += foldWave[i] * A * 0.3;
    // sin atravesar el bol (ni la báscula de debajo)
    const minR = y > 0 ? bowlTool.outerRadiusAt(y) + CLOTH.thick + 0.0015 : 0.156;
    const rr = smoothMax(rho + A * foldWave[i], minR, 0.004);
    return out.set((mx[i] / r) * rr, y, (mz[i] / r) * rr);
  }

  // Pliegue alrededor de una recta paralela a z (eje 'z') o a x (eje 'x') a altura hy
  const hinge = (p, axis, at, hy, alpha) => {
    const u = (axis === 'z' ? p.x : p.z) - at, w = p.y - hy;
    const c = Math.cos(-alpha), s = Math.sin(-alpha);
    const u2 = u * c - w * s, w2 = u * s + w * c;
    if (axis === 'z') p.x = at + u2; else p.z = at + u2;
    p.y = hy + w2;
  };
  const L = CLOTH.layer, P = { x: 0, y: 0, z: 0 };
  const tmpA = new Float32Array(N * 3);
  /** Escribe el paño doblado/desdoblando (ángulos de los 3 pliegues), centrado y con la base en baseY. */
  function writeFolded(a1, a2, a3, baseY) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < N; i++) {
      P.x = mx[i]; P.y = 0; P.z = mz[i];
      if (fold1[i]) hinge(P, 'z', 0, L / 2, a1);
      if (fold2[i]) hinge(P, 'x', 0, L * 1.5, a2);
      if (fold3[i]) hinge(P, 'z', S / 4, L * 3.5, a3);
      tmpA[i * 3] = P.x; tmpA[i * 3 + 1] = P.y; tmpA[i * 3 + 2] = P.z;
      if (P.x < x0) x0 = P.x; if (P.x > x1) x1 = P.x;
      if (P.z < z0) z0 = P.z; if (P.z > z1) z1 = P.z;
    }
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    for (let i = 0; i < N; i++) pos.setXYZ(i, tmpA[i * 3] - cx, tmpA[i * 3 + 1] + baseY, tmpA[i * 3 + 2] - cz);
    commit();
  }
  const D = new THREE.Vector3();
  // retardo de cada vértice según cuánto sobresale del borde (0 dentro, 1 en las esquinas)
  const overhang = (i) => clamp((mr[i] - st.rc) / (rMax - st.rc));
  /**
   * Mezcla vértice a vértice entre `from` (array) y la forma destino; `spread` > 0 retrasa los bordes,
   * `spread` < 0 los adelanta.
   */
  function writeBlend(from, toFn, t, spread, easing) {
    const sp = Math.abs(spread);
    for (let i = 0; i < N; i++) {
      const o = overhang(i);
      const delay = sp * (spread > 0 ? o : 1 - o);
      const e = easing(clamp((t - delay) / (1 - sp)));
      toFn(i, D);
      pos.setXYZ(i, lerp(from[i * 3], D.x, e), lerp(from[i * 3 + 1], D.y, e), lerp(from[i * 3 + 2], D.z, e));
    }
    commit();
  }
  function writeDrape() {
    for (let i = 0; i < N; i++) { drapeAt(i, D); pos.setXYZ(i, D.x, D.y, D.z); }
    commit();
  }
  const rings = geo.userData.rings, nrm = () => geo.attributes.normal;
  const avg = new THREE.Vector3(), tmpN = new THREE.Vector3();
  function commit() {
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    // el centro de la malla polar repite el vértice: una sola normal promediada
    avg.set(0, 0, 0);
    for (let k = 0; k < CLOTH.segs; k++) avg.add(tmpN.fromBufferAttribute(nrm(), k * rings));
    avg.normalize();
    for (let k = 0; k < CLOTH.segs; k++) nrm().setXYZ(k * rings, avg.x, avg.y, avg.z);
    geo.computeBoundingSphere();
  }
  const flatAt = (baseY) => (i, out) => out.set(mx[i], baseY, mz[i]);

  // Reposo del paño doblado
  const qRest = qAxis(UP, 0.28);
  const rest = restingPose(object, qRest, SPOTS.clothRest.x, SPOTS.clothRest.z);
  object.position.copy(rest.position);
  object.quaternion.copy(rest.quaternion);

  const hlFolded = makeHighlighter(folded), hlDrape = makeHighlighter(drape);
  let seq = 0, anim = null, covering = false;
  const run = (a) => (anim = a);
  const stop = () => { anim?.cancel(); anim = null; };
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion();

  /** Pose (en el grupo de utensilios) del paño doblado flotando sobre el bol. */
  function hoverPose(bowlObj) {
    const p = bowlObj.localToWorld(tmpV.set(0, baseY(), 0)).clone();
    group.worldToLocal(p);
    bowlObj.getWorldQuaternion(tmpQ);
    const q = group.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(tmpQ);
    return { position: p, quaternion: q };
  }
  function attachDrapeTo(parent) {
    parent.add(drape);
    drape.position.set(0, 0, 0);
    drape.quaternion.identity();
    drape.scale.set(1, 1, 1);
  }
  function prepareBowl(bowlObj) {
    st.bowl = bowlObj;
    bowlObj.getWorldPosition(tmpV);
    const s = bowlObj.getWorldScale(new THREE.Vector3()).y || 1;
    // ¿qué hay debajo? si el bol está sobre la báscula, la tela cae hasta la encimera
    const below = (COUNTER.topY - tmpV.y) / s;
    st.floor = below <= 0 && below > -0.06 ? below : 0;
    st.rc = bowlTool.rimRadius;
    st.top = SIZES.bowl.height + CLOTH.thick;
    buildLut();
  }
  const baseY = () => SIZES.bowl.height + CLOTH.hover;

  return {
    ...baseTool('cloth', object, folded),
    /** Malla del paño extendido (vive dentro del bol mientras lo tapa). */
    drape,
    /** true desde cover() hasta que uncover() termina. */
    get isCovering() { return covering; },
    /** Altura actual del abombamiento (m). */
    get bulge() { return st.bulge; },
    setHighlight(on) { hlFolded.set(!!on); hlDrape.set(!!on); },
    /**
     * Despliega el paño sobre el bol: lo levanta, lo desdobla en el aire y lo deja caer sobre el borde.
     * @param {THREE.Object3D} [bowlObject=tools.bowl.object]
     * @returns {Promise<boolean>} false si se interrumpe
     */
    async cover(bowlObject = bowlTool.object) {
      const token = ++seq;
      stop();
      if (!bowlObject?.isObject3D) return false;
      if (covering && drape.visible && st.bowl === bowlObject && st.mode === 'draped') return true;
      covering = true;
      prepareBowl(bowlObject);
      ctx.audio?.play('whoosh', { volume: 0.35 });
      if (!drape.visible) {
        if (!(await run(poseTween(object, hoverPose(bowlObject), { duration: 0.7, arc: 0.1 }))) || token !== seq) return false;
        folded.visible = false;
        attachDrapeTo(bowlObject);
        drape.visible = true;
        st.mode = 'folded';
        writeFolded(Math.PI, Math.PI, Math.PI, baseY());
        // desdoblar: primero el último pliegue
        const seg = (t, a, b) => ease.inOutCubic(clamp((t - a) / (b - a)));
        ctx.audio?.play('cloth', { volume: 0.7 });
        if (!(await run(animate({
          duration: 0.85, ease: ease.linear,
          onUpdate: (t) => writeFolded(Math.PI * (1 - seg(t, 0.62, 1)), Math.PI * (1 - seg(t, 0.3, 0.68)), Math.PI * (1 - seg(t, 0, 0.36)), baseY()),
        }))) || token !== seq) return false;
      }
      // cae plano hasta apoyarse en el borde y después la tela que sobra cuelga (las esquinas al final)
      st.mode = 'falling';
      const from = Float32Array.from(pos.array);
      if (!(await run(animate({ duration: 0.42, ease: ease.linear, onUpdate: (t) => writeBlend(from, flatAt(st.top + 0.004), t, 0.12, ease.inQuad) }))) || token !== seq) return false;
      const landed = Float32Array.from(pos.array);
      if (!(await run(animate({ duration: 0.85, ease: ease.linear, onUpdate: (t) => writeBlend(landed, drapeAt, t, 0.26, ease.outCubic) }))) || token !== seq) return false;
      ctx.audio?.play('cloth', { volume: 0.5, rate: 0.9 });
      st.mode = 'draped';
      writeDrape();
      anim = null;
      return true;
    },
    /**
     * Retira el paño: lo levanta desde el centro, lo dobla en el aire y lo devuelve a su sitio.
     * @returns {Promise<boolean>} false si se interrumpe
     */
    async uncover() {
      const token = ++seq;
      stop();
      if (!covering) return true;
      ctx.audio?.play('cloth', { volume: 0.6 });
      if (drape.visible && st.bowl) {
        // las esquinas suben primero hasta quedar plano sobre el borde y luego se eleva entero
        st.mode = 'lifting';
        const from = Float32Array.from(pos.array);
        if (!(await run(animate({ duration: 0.6, ease: ease.linear, onUpdate: (t) => writeBlend(from, flatAt(st.top + 0.02), t, -0.3, ease.inOutSine) }))) || token !== seq) return false;
        const flat = Float32Array.from(pos.array);
        if (!(await run(animate({ duration: 0.4, ease: ease.linear, onUpdate: (t) => writeBlend(flat, flatAt(baseY()), t, 0, ease.inOutCubic) }))) || token !== seq) return false;
        const seg = (t, a, b) => ease.inOutCubic(clamp((t - a) / (b - a)));
        if (!(await run(animate({
          duration: 0.8, ease: ease.linear,
          onUpdate: (t) => writeFolded(Math.PI * seg(t, 0, 0.38), Math.PI * seg(t, 0.32, 0.68), Math.PI * seg(t, 0.64, 1), baseY()),
        }))) || token !== seq) return false;
        const hp = hoverPose(st.bowl);
        object.position.copy(hp.position);
        object.quaternion.copy(hp.quaternion);
        drape.visible = false;
        attachDrapeTo(object);
        folded.visible = true;
      }
      st.mode = 'rest';
      ctx.audio?.play('whoosh', { volume: 0.3 });
      if (!(await run(poseTween(object, rest, { duration: 0.7, arc: 0.1 }))) || token !== seq) return false;
      covering = false;
      anim = null;
      return true;
    },
    /**
     * Abombamiento del centro del paño (la masa que sube lo empuja).
     * @param {number} h metros (≈0–0,05)
     */
    setBulge(h) {
      const v = clamp(Number.isFinite(h) ? h : 0, 0, 0.08);
      if (Math.abs(v - st.bulge) < 2e-4 && (v > 0 || st.bulge === 0)) return; // cambios invisibles: no recalcula
      st.bulge = v;
      st.dirty = true;
    },
    /** Paño doblado en su sitio, sin animación. */
    reset() {
      seq++;
      stop();
      covering = false;
      st.mode = 'rest';
      st.bulge = 0;
      drape.visible = false;
      attachDrapeTo(object);
      folded.visible = true;
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
    },
    _update(dt) {
      hlFolded.update(dt);
      hlDrape.update(dt);
      if (st.dirty && st.mode === 'draped') writeDrape();
      if (st.mode === 'draped' || st.mode === 'rest') st.dirty = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Tabla de amasar
// ---------------------------------------------------------------------------

function buildBoard() {
  const { width: W, depth: D, thickness: T } = SIZES.board;
  const object = new THREE.Group();
  object.name = 'board';
  object.position.copy(SPOTS.board);
  const visual = new THREE.Group();
  object.add(visual);
  const tex = boardTextures();

  const bev = 0.004, cr = 0.024, holeX = W / 2 - 0.042, holeR = 0.011;
  const outline = (inset) => {
    const s = roundedRect(W - 2 * inset, D - 2 * inset, cr - inset);
    s.holes.push(new THREE.Path().absarc(holeX, 0, holeR + inset, 0, TAU, true));
    return s;
  };
  const geo = new THREE.ExtrudeGeometry(outline(bev), {
    depth: T - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 3, curveSegments: 14,
  });
  planarUV(geo, W, D);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bev, 0);
  const wood = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex.map, roughness: 1, roughnessMap: tex.rough, bumpMap: tex.map, bumpScale: 0.25, envMapIntensity: 0.4,
  }));
  visual.add(wood);
  finishMeshes(visual, 'board');

  // Harina espolvoreada: capa transparente cuyo alcance crece con uFlour
  const flourUniform = { value: 0 };
  const flourMat = new THREE.MeshStandardMaterial({
    color: 0xfbf8f1, map: flourFieldTexture(), roughness: 1, transparent: true, depthWrite: false, envMapIntensity: 0.3,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  flourMat.onBeforeCompile = (shader) => {
    shader.uniforms.uFlour = flourUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uFlour;\nvoid main() {')
      .replace('#include <map_fragment>', `
        vec4 flourField = texture2D( map, vMapUv );
        float flourThr = 1.0 - uFlour;
        diffuseColor.rgb *= mix( 0.9, 1.0, flourField.g );
        float flourCover = smoothstep( flourThr - 0.06, flourThr + 0.16, flourField.r );
        diffuseColor.a *= flourCover * mix( 0.5 + 0.4 * flourCover, 1.0, flourField.b ) * smoothstep( 0.0, 0.1, uFlour ) * 0.86;
      `);
  };
  const flourGeo = planarUV(new THREE.ShapeGeometry(outline(0.012), 10), W, D);
  flourGeo.rotateX(-Math.PI / 2);
  const flour = new THREE.Mesh(flourGeo, flourMat);
  flour.position.y = T + 0.0005;
  flour.visible = false;
  flour.userData.tool = 'board';
  flour.receiveShadow = true;
  flour.renderOrder = 1;
  object.add(flour);

  const top = new THREE.Object3D();
  top.name = 'board.top';
  top.position.y = T;
  object.add(top);

  let amount = 0;
  return {
    ...baseTool('board', object, visual),
    anchors: { top },
    /** Cantidad de harina actual (0–1). */
    get flour() { return amount; },
    /**
     * Espolvorea harina sobre la tabla (0 = limpia, 1 = bien enharinada).
     * @param {number} amount01
     */
    setFlour(amount01) {
      amount = clamp(Number.isFinite(amount01) ? amount01 : 0);
      flourUniform.value = amount;
      flour.visible = amount > 0.001;
    },
  };
}

// ---------------------------------------------------------------------------
// Bandeja y molde (chapa: perfil barrido a lo largo de un rectángulo redondeado)
// ---------------------------------------------------------------------------

/**
 * Barre un perfil [[o, y], ...] (o = separación hacia fuera respecto al rectángulo base) alrededor de un
 * rectángulo redondeado de semiejes (hw, hd) y radio r, y le añade el fondo a la altura del primer punto.
 * Devuelve la geometría y el número de puntos del perfil (para colorear por zonas).
 */
function sweptPan(hw, hd, r, profile, { cornerSegs = 7, colorOf = null, uvSize = null } = {}) {
  const ring = [];
  const corners = [[hw - r, hd - r], [-(hw - r), hd - r], [-(hw - r), -(hd - r)], [hw - r, -(hd - r)]];
  corners.forEach(([cx, cz], q) => {
    for (let k = 0; k <= cornerSegs; k++) {
      const a = ((q + k / cornerSegs) * Math.PI) / 2;
      ring.push([cx, cz, Math.cos(a), Math.sin(a)]);
    }
  });
  const np = profile.length, nr = ring.length;
  const pos = [], idx = [], col = [];
  for (const [cx, cz, nx, nz] of ring) {
    profile.forEach(([o, y], j) => {
      pos.push(cx + (r + o) * nx, y, cz + (r + o) * nz);
      if (colorOf) col.push(...colorOf(j));
    });
  }
  for (let i = 0; i < nr; i++) {
    const i2 = (i + 1) % nr;
    for (let j = 0; j < np - 1; j++) {
      const a = i * np + j, b = i2 * np + j;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const wall = new THREE.BufferGeometry();
  wall.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  wall.setIndex(idx);
  // fondo
  const [o0, y0] = profile[0];
  const floor = new THREE.ShapeGeometry(roundedRect(2 * (hw + o0), 2 * (hd + o0), r + o0), cornerSegs);
  floor.rotateX(-Math.PI / 2);
  floor.translate(0, y0, 0);
  floor.deleteAttribute('uv');
  floor.deleteAttribute('normal');
  if (colorOf) {
    const c0 = colorOf(0), fc = [];
    for (let i = 0; i < floor.attributes.position.count; i++) fc.push(...c0);
    floor.setAttribute('color', new THREE.Float32BufferAttribute(fc, 3));
    wall.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }
  const geo = mergeGeometries([wall, floor]);
  geo.computeVertexNormals();
  if (uvSize) {
    const p = geo.attributes.position, uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / uvSize[0] + 0.5; uv[i * 2 + 1] = 0.5 - p.getZ(i) / uvSize[1]; }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  return geo;
}

/** Puntos de un borde enrollado (círculo de radio rr centrado en (oc, yc)) entre dos ángulos en grados. */
const rolledRim = (oc, yc, rr, fromDeg, toDeg, steps) => Array.from({ length: steps + 1 }, (_, k) => {
  const a = THREE.MathUtils.degToRad(lerp(fromDeg, toDeg, k / steps));
  return [oc + rr * Math.cos(a), yc + rr * Math.sin(a)];
});

function buildTray() {
  const { width: W, depth: D } = SIZES.tray;
  const object = new THREE.Group();
  object.name = 'tray';
  object.position.copy(SPOTS.tray);
  const visual = new THREE.Group();
  object.add(visual);
  const floorY = 0.0012;
  const profile = [[-0.004, floorY], [-0.0016, floorY + 0.0002], [0, 0.0028], [0.003, 0.0085], [0.0065, 0.0145], [0.0088, 0.0172],
    ...rolledRim(0.0122, 0.0172, 0.0032, 160, -145, 12)];
  const ext = 0.0154;
  const tex = trayTextures();
  const geo = sweptPan(W / 2 - ext, D / 2 - ext, 0.012, profile, { uvSize: [W, D] });
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    map: tex.map, roughnessMap: tex.rough, roughness: 1, metalness: 0.6, side: THREE.DoubleSide, envMapIntensity: 0.8,
  }));
  visual.add(mesh);
  finishMeshes(visual, 'tray');

  // Papel de horno: algo arrugado y con las esquinas levantadas
  const pw = W - 2 * ext - 0.022, pd = D - 2 * ext - 0.02;
  const pgeo = new THREE.PlaneGeometry(pw, pd, 28, 20).rotateX(-Math.PI / 2);
  const pp = pgeo.attributes.position;
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i), z = pp.getZ(i);
    const cx = Math.abs(x) / (pw / 2), cz = Math.abs(z) / (pd / 2);
    const corner = smoothstep(0.82, 1, cx) * smoothstep(0.7, 1, cz);
    const edge = Math.max(smoothstep(0.9, 1, cx), smoothstep(0.88, 1, cz));
    const y = 0.0005 + (fbm3(x * 40, z * 40, 4, 3) - 0.35) * 0.0016 + corner * 0.006 + edge * 0.0015;
    pp.setY(i, Math.max(0.0003, y));
  }
  pgeo.computeVertexNormals();
  const parchment = new THREE.Mesh(pgeo, new THREE.MeshStandardMaterial({ map: parchmentTexture(), roughness: 0.72, side: THREE.DoubleSide, envMapIntensity: 0.4 }));
  parchment.position.y = floorY;
  parchment.visible = false;
  parchment.userData.tool = 'tray';
  parchment.receiveShadow = true;
  object.add(parchment);

  const top = new THREE.Object3D();
  top.name = 'tray.top';
  top.position.y = floorY;
  object.add(top);

  let anim = null, hasPaper = false;
  return {
    ...baseTool('tray', object, visual),
    anchors: { top },
    /** Altura del fondo sobre la encimera (m). */
    floorY,
    /** true si lleva papel de horno. */
    get hasParchment() { return hasPaper; },
    /**
     * Pone o quita el papel de horno (cae con suavidad al ponerlo).
     * @param {boolean} on
     */
    setParchment(on) {
      hasPaper = !!on;
      anim?.cancel();
      parchment.visible = hasPaper;
      top.position.y = floorY + (hasPaper ? 0.0006 : 0);
      if (!hasPaper) { parchment.position.y = floorY; return; }
      anim = animate({ duration: 0.4, ease: ease.outCubic, onUpdate: (t) => { parchment.position.y = floorY + (1 - t) * 0.03; } });
    },
  };
}

function buildTin(trayTool) {
  const { length: Lx, width: Wz, height: Hy } = SIZES.tin;
  const object = new THREE.Group();
  object.name = 'tin';
  object.position.copy(SPOTS.tray);
  object.visible = false;
  const visual = new THREE.Group();
  object.add(visual);
  const floorY = 0.0015, flare = 0.0075, rr = 0.003;
  const wallTop = floorY + Hy - rr;
  const wall = [[0.0012, 0.015], [0.003, 0.035], [0.0048, 0.055], [0.0066, 0.075], [flare, wallTop - 0.002]];
  const rim = rolledRim(flare + rr, wallTop, rr, 170, -140, 9);
  const profile = [[-0.004, floorY], [-0.0015, floorY + 0.0003], [0, floorY + 0.0018], ...wall, ...rim];
  const coat = [0.028, 0.028, 0.032], steel = [0.3, 0.3, 0.31];
  const firstRim = profile.length - rim.length;
  const geo = sweptPan((Lx - 2 * flare) / 2, (Wz - 2 * flare) / 2, 0.012, profile, { colorOf: (j) => (j >= firstRim + 1 ? steel : coat) });
  const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
    vertexColors: true, metalness: 0.3, roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.3, side: THREE.DoubleSide, envMapIntensity: 0.8,
  }));
  visual.add(mesh);
  finishMeshes(visual, 'tin');
  const inside = new THREE.Object3D();
  inside.name = 'tin.inside';
  inside.position.y = floorY;
  object.add(inside);
  const base = baseTool('tin', object, visual);
  return {
    ...base,
    anchors: { inside },
    /** Lo muestra; si está en su sitio y la bandeja está visible, se apoya sobre la bandeja. */
    show() {
      const atHome = Math.hypot(object.position.x - SPOTS.tray.x, object.position.z - SPOTS.tray.z) < 0.002;
      if (atHome && object.parent === trayTool.object.parent) {
        const onTray = trayTool.object.visible;
        object.position.set(SPOTS.tray.x, SPOTS.tray.y + (onTray ? trayTool.anchors.top.position.y : 0), SPOTS.tray.z);
      }
      base.show();
    },
  };
}

// ---------------------------------------------------------------------------
// Cuchilla de greñar (lame) y cuchillo de pan
// ---------------------------------------------------------------------------

function buildLame(group, woodTex) {
  const object = new THREE.Group();
  object.name = 'lame';
  const visual = new THREE.Group();
  object.add(visual);
  const axisY = 0.011;
  // mango de madera torneado a lo largo de x (-0,15 … -0,035)
  const prof = [[0, 0], [0.0032, 0.0003], [0.0049, 0.0017], [0.0057, 0.0045], [0.0061, 0.012], [0.0061, 0.04], [0.0057, 0.07],
    [0.005, 0.095], [0.0046, 0.108], [0.0044, 0.1135], [0.0036, 0.115], [0, 0.1155]].map(([r, y]) => v2(r, y));
  const handleGeo = new THREE.LatheGeometry(prof, 22).rotateZ(-Math.PI / 2).translate(-0.1505, axisY, 0);
  const handle = new THREE.Mesh(handleGeo, new THREE.MeshStandardMaterial({ map: woodTex, color: 0xb8794a, roughness: 0.5, envMapIntensity: 0.4 }));
  // metal: casquillo, varilla y hoja de doble filo ensartada (con su ranura)
  const blade = roundedRect(0.043, 0.022, 0.0022);
  const slot = new THREE.Path();
  slot.moveTo(-0.0135, -0.0013).lineTo(0.0135, -0.0013).absarc(0.0135, 0, 0.0013, -Math.PI / 2, Math.PI / 2, false)
    .lineTo(-0.0135, 0.0013).absarc(-0.0135, 0, 0.0013, Math.PI / 2, Math.PI * 1.5, false);
  blade.holes.push(slot);
  const bladeGeo = new THREE.ExtrudeGeometry(blade, { depth: 0.0003, bevelEnabled: false, curveSegments: 6 });
  bladeGeo.translate(-0.0215, axisY, -0.00015);
  const ferrule = new THREE.CylinderGeometry(0.0047, 0.0047, 0.007, 20).rotateZ(Math.PI / 2).translate(-0.0365, axisY, 0);
  const stem = new THREE.CylinderGeometry(0.0011, 0.0011, 0.036, 8).rotateZ(Math.PI / 2).translate(-0.018, axisY, 0);
  const metalGeo = mergeGeometries([bladeGeo, ferrule.toNonIndexed(), stem.toNonIndexed()]);
  const metal = new THREE.Mesh(metalGeo, new THREE.MeshStandardMaterial({ color: 0xd3d7da, metalness: 1, roughness: 0.2 }));
  visual.add(handle, metal);
  finishMeshes(visual, 'lame');
  const tip = new THREE.Object3D();
  tip.name = 'lame.tip';
  object.add(tip);
  group.add(object);

  // reposo: tumbada, mango hacia +x, un poco girada para que la hoja apoye
  const qRest = qMul(qAxis(UP, Math.PI - 0.06), qAxis(X_AXIS, -Math.PI / 2), qAxis(X_AXIS, 0.5));
  const rest = restingPose(object, qRest, SPOTS.knifeRest.x - 0.075, SPOTS.knifeRest.z - 0.011);
  object.position.copy(rest.position);
  object.quaternion.copy(rest.quaternion);

  // agarre para greñar: mango levantado ~24° por detrás de la punta y hoja algo inclinada (para la "oreja")
  const qHeld = qMul(qAxis(Z_AXIS, -0.42), qAxis(X_AXIS, 0.35));
  const target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
  let mode = 'home', anim = null;
  const stop = () => { anim?.cancel(); anim = null; };

  return {
    ...baseTool('lame', object, visual),
    anchors: { tip },
    /**
     * Sujeta la cuchilla con la punta de la hoja en worldPos. Con yaw = 0 la hoja avanza hacia +x
     * (dirección de corte = (cos yaw, 0, −sin yaw)); el mango queda detrás y levantado.
     * La primera llamada desde el reposo hace una transición corta; las siguientes son inmediatas.
     * @param {THREE.Vector3} worldPos
     * @param {number} yawRadians
     */
    setPose(worldPos, yawRadians = 0) {
      if (!worldPos || !Number.isFinite(worldPos.x + worldPos.y + worldPos.z)) return;
      target.position.set(worldPos.x, worldPos.y, worldPos.z);
      group.worldToLocal(target.position);
      target.quaternion.copy(qAxis(UP, Number.isFinite(yawRadians) ? yawRadians : 0)).multiply(qHeld);
      if (mode !== 'held') {
        stop();
        mode = 'held';
        const a = (anim = poseTween(object, () => target, { duration: 0.35, arc: 0.04 }));
        a.then(() => { if (anim === a) anim = null; });
      } else if (!anim) {
        object.position.copy(target.position);
        object.quaternion.copy(target.quaternion);
      }
    },
    /** Vuelve a su sitio. @returns {Promise<boolean>} */
    async goHome() {
      stop();
      mode = 'returning';
      const a = (anim = poseTween(object, rest, { duration: 0.55, arc: 0.06 }));
      const ok = await a;
      if (ok && anim === a) { mode = 'home'; anim = null; }
      return ok;
    },
    /** A su sitio sin animación. */
    reset() {
      stop();
      mode = 'home';
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
    },
  };
}

/** Hoja de sierra: filo festoneado (dientes visibles en la silueta), punta redondeada. Origen = centro del filo. */
function breadKnifeGeometries() {
  const x0 = -0.105, x1 = 0.105, hgt = 0.028, pitch = 0.0055, depth = 0.0015;
  const s = new THREE.Shape();
  s.moveTo(x0, hgt);
  s.lineTo(x0, 0.0008);
  let x = x0;
  while (x + pitch <= x1 - 0.02) {
    s.quadraticCurveTo(x + pitch / 2, depth * 2, x + pitch, 0);
    x += pitch;
  }
  s.quadraticCurveTo(x1 + 0.001, 0.0005, x1, 0.011);
  s.quadraticCurveTo(x1 - 0.003, hgt - 0.0005, x1 - 0.032, hgt);
  s.lineTo(x0, hgt);
  const blade = new THREE.ExtrudeGeometry(s, { depth: 0.0011, bevelEnabled: true, bevelThickness: 0.00025, bevelSize: 0.0002, bevelSegments: 1, curveSegments: 3 });
  blade.translate(0, 0, -0.00055);
  const bolster = new RoundedBoxGeometry(0.012, 0.03, 0.0068, 2, 0.002).translate(x0 - 0.006, 0.0148, 0);
  const rivets = [0.035, 0.07, 0.105].map((d) => new THREE.CylinderGeometry(0.0021, 0.0021, 0.0132, 12).rotateX(Math.PI / 2).translate(x0 - 0.012 - d, 0.0142, 0).toNonIndexed());
  const steel = mergeGeometries([blade, bolster.index ? bolster.toNonIndexed() : bolster, ...rivets]);
  // mango: perfil con barriga, extruido con bisel grande (sección ovalada)
  const hx0 = x0 - 0.012, hx1 = x0 - 0.135;
  const hs = new THREE.Shape();
  hs.moveTo(hx0, 0.003);
  hs.quadraticCurveTo((hx0 + hx1) / 2, -0.004, hx1 + 0.006, 0.0035);
  hs.quadraticCurveTo(hx1 - 0.001, 0.005, hx1, 0.014);
  hs.quadraticCurveTo(hx1 - 0.001, 0.0255, hx1 + 0.007, 0.0262);
  hs.quadraticCurveTo((hx0 + hx1) / 2, 0.0285, hx0, 0.0265);
  hs.lineTo(hx0, 0.003);
  const handle = new THREE.ExtrudeGeometry(hs, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.0034, bevelSize: 0.0026, bevelSegments: 4, curveSegments: 10 });
  handle.translate(0, 0, -0.003);
  const hp = handle.attributes.position, huv = handle.attributes.uv;
  for (let i = 0; i < hp.count; i++) huv.setXY(i, (hp.getX(i) - hx1) / 0.14, (hp.getY(i) + hp.getZ(i) * 0.6) / 0.04 + 0.2);
  return { steel, handle };
}

function buildBreadKnife(ctx, group, woodTex) {
  const object = new THREE.Group();
  object.name = 'breadKnife';
  const visual = new THREE.Group();
  object.add(visual);
  const g = breadKnifeGeometries();
  const steel = new THREE.Mesh(g.steel, new THREE.MeshStandardMaterial({ color: 0xb9bdc1, metalness: 1, roughness: 0.3 }));
  const handle = new THREE.Mesh(g.handle, new THREE.MeshStandardMaterial({ map: woodTex, color: 0x6e4630, roughness: 0.45, envMapIntensity: 0.4 }));
  visual.add(steel, handle);
  finishMeshes(visual, 'breadKnife');
  const edge = new THREE.Object3D();
  edge.name = 'breadKnife.edge';
  object.add(edge);
  group.add(object);

  // reposo: tumbado delante de la tabla, mango a la derecha, filo hacia el fondo
  const qRest = qMul(qAxis(UP, Math.PI + 0.03), qAxis(X_AXIS, -Math.PI / 2), qAxis(X_AXIS, -0.1));
  const rest = restingPose(object, qRest, SPOTS.knifeRest.x + 0.205, SPOTS.knifeRest.z + 0.003);
  object.position.copy(rest.position);
  object.quaternion.copy(rest.quaternion);

  let seq = 0, anim = null;
  const stop = () => { anim?.cancel(); anim = null; };
  const run = (a) => (anim = a);

  return {
    ...baseTool('breadKnife', object, visual),
    anchors: { edge },
    /**
     * Corta una pieza: se coloca encima, sierra adelante y atrás mientras baja `height` y sale por arriba.
     * La hoja va a lo largo del eje local X girado `yaw` (mango hacia −X), en vertical, filo abajo.
     * @param {THREE.Vector3} worldTopPos punto superior de la pieza donde entra el filo
     * @param {number} height cuánto baja (alto de la pieza, m)
     * @param {number} yawRadians
     * @returns {Promise<boolean>} false si se interrumpe
     */
    async slice(worldTopPos, height = 0.08, yawRadians = 0) {
      if (!worldTopPos || !Number.isFinite(worldTopPos.x + worldTopPos.y + worldTopPos.z)) return false;
      const token = ++seq;
      stop();
      const top = group.worldToLocal(new THREE.Vector3(worldTopPos.x, worldTopPos.y, worldTopPos.z));
      const h = clamp(Number.isFinite(height) ? height : 0.08, 0.005, 0.3);
      const q = qAxis(UP, Number.isFinite(yawRadians) ? yawRadians : 0);
      const along = X_AXIS.clone().applyQuaternion(q);
      const amp = 0.045, lift = 0.012;
      const start = { position: top.clone().addScaledVector(along, amp), quaternion: q };
      start.position.y += lift;
      if (!(await run(poseTween(object, start, { duration: 0.6, arc: 0.08 }))) || token !== seq) return false;
      const duration = clamp(1.3 + h * 16, 1.6, 3.4), freq = 2.1;
      let lastSign = 1;
      const rock = new THREE.Quaternion();
      ctx.audio?.play('cut', { volume: 0.5 });
      if (!(await run(animate({
        duration, ease: ease.linear,
        onUpdate: (t) => {
          const ph = t * duration * freq * TAU;
          const k = ease.inOutSine(t);
          object.position.copy(top).addScaledVector(along, amp * Math.cos(ph) * (1 - 0.3 * t));
          object.position.y = top.y + lift - (h + lift - 0.002) * k;
          object.quaternion.copy(q).multiply(rock.setFromAxisAngle(Z_AXIS, 0.05 * Math.sin(ph)));
          const sgn = Math.sign(Math.sin(ph)) || lastSign;
          if (sgn !== lastSign) { lastSign = sgn; ctx.audio?.play('cut', { volume: 0.35, rate: 0.85 + Math.random() * 0.3 }); }
        },
      }))) || token !== seq) return false;
      const out = { position: object.position.clone(), quaternion: q };
      out.position.y = top.y + 0.05;
      const ok = await run(poseTween(object, out, { duration: 0.45, arc: 0 }));
      if (token === seq) anim = null;
      return ok && token === seq;
    },
    /** Vuelve a su sitio. @returns {Promise<boolean>} */
    async goHome() {
      const token = ++seq;
      stop();
      const ok = await run(poseTween(object, rest, { duration: 0.6, arc: 0.08 }));
      if (token === seq) anim = null;
      return ok && token === seq;
    },
    /** A su sitio sin animación. */
    reset() {
      seq++;
      stop();
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
    },
  };
}

// ---------------------------------------------------------------------------
// Rejilla de enfriar (una sola geometría fusionada)
// ---------------------------------------------------------------------------

function rackGeometry(W, D, frameY, wireR, frameR) {
  const parts = [];
  // marco
  const cr = 0.016, pts = [];
  const cs = [[W / 2 - cr, D / 2 - cr], [-(W / 2 - cr), D / 2 - cr], [-(W / 2 - cr), -(D / 2 - cr)], [W / 2 - cr, -(D / 2 - cr)]];
  cs.forEach(([cx, cz], q) => {
    for (let k = 0; k <= 4; k++) {
      const a = ((q + k / 4) * Math.PI) / 2;
      pts.push(new THREE.Vector3(cx + cr * Math.cos(a), frameY, cz + cr * Math.sin(a)));
    }
  });
  parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, 'centripetal'), 160, frameR, 8, true));
  // varillas transversales que sostienen la rejilla
  for (const z of [-0.075, 0.075]) parts.push(new THREE.CylinderGeometry(frameR * 0.9, frameR * 0.9, W - 0.004, 8, 1, true).rotateZ(Math.PI / 2).translate(0, frameY, z));
  // rejilla de varillas finas apoyadas encima
  const wy = frameY + frameR + wireR * 0.8;
  for (let x = -W / 2 + cr + 0.004; x <= W / 2 - cr - 0.002; x += 0.0125) {
    parts.push(new THREE.CylinderGeometry(wireR, wireR, D - 0.003, 6, 1, true).rotateX(Math.PI / 2).translate(x, wy, 0));
  }
  // patas: dos U de alambre bajo los lados cortos
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 - 0.045);
    const leg = [[-D / 2 + 0.002, frameY], [-D / 2 + 0.012, frameR + 0.0012], [-D / 2 + 0.03, frameR], [D / 2 - 0.03, frameR], [D / 2 - 0.012, frameR + 0.0012], [D / 2 - 0.002, frameY]]
      .map(([z, y]) => new THREE.Vector3(x, y, z));
    parts.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(leg, false, 'centripetal'), 40, frameR, 8, false));
  }
  return { geo: mergeGeometries(parts), topY: wy + wireR };
}

function buildCoolingRack() {
  const object = new THREE.Group();
  object.name = 'coolingRack';
  object.position.copy(SPOTS.coolingRack);
  object.visible = false;
  const visual = new THREE.Group();
  object.add(visual);
  const { geo, topY } = rackGeometry(0.42, 0.28, 0.014, 0.0015, 0.0022);
  visual.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xe8e9eb, metalness: 1, roughness: 0.16 })));
  finishMeshes(visual, 'coolingRack');
  const top = new THREE.Object3D();
  top.name = 'coolingRack.top';
  top.position.y = topY;
  object.add(top);
  return { ...baseTool('coolingRack', object, visual), anchors: { top } };
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------

/**
 * Crea todos los utensilios en sus sitios (coordenadas de mundo de layout.js).
 * El bol empieza sobre el plato de la báscula; molde y rejilla empiezan ocultos.
 * @param {{engine?: any, scene?: THREE.Scene, audio?: any, particles?: any}} ctx
 * @returns {{group: THREE.Group, bowl: object, spoon: object, cloth: object, board: object, scale: object,
 *   tray: object, tin: object, lame: object, breadKnife: object, coolingRack: object,
 *   update: (dt: number, elapsed: number) => void}}
 */
export function createTools(ctx) {
  ctx = ctx ?? {};
  const group = new THREE.Group();
  group.name = 'tools';
  const woodTex = woodGrainTexture();

  const scale = buildScale();
  const bowl = buildBowl();
  scale.anchors.plate.add(bowl.object);
  const board = buildBoard();
  const tray = buildTray();
  const tin = buildTin(tray);
  const coolingRack = buildCoolingRack();
  group.add(scale.object, board.object, tray.object, tin.object, coolingRack.object);
  const spoon = buildSpoon(group, woodTex, bowl);
  const cloth = buildCloth(ctx, group, bowl);
  const lame = buildLame(group, woodTex);
  const breadKnife = buildBreadKnife(ctx, group, woodTex);

  const all = [scale, bowl, spoon, cloth, board, tray, tin, lame, breadKnife, coolingRack];
  return {
    group, bowl, spoon, cloth, board, scale, tray, tin, lame, breadKnife, coolingRack,
    /** Avanza resaltados y estados internos. Nunca lanza (y un dt inválido no contamina el estado). */
    update(dt, elapsed) {
      const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      const el = Number.isFinite(elapsed) ? elapsed : 0;
      for (const t of all) {
        try { t._update(d, el); } catch (e) { console.error(e); }
      }
    },
  };
}
