// Partículas: harina, chorros de polvo, vapor, humo, destellos, migas y motas de polvo en la luz.
// Dos nubes de puntos reutilizables (mezcla normal y aditiva) con un shader propio: sprites redondos
// y suaves, tamaño en metros con perspectiva, color y alfa por partícula. Simulación en CPU.
import * as THREE from 'three';
import { COUNTER } from './core/layout.js';
import { clamp, makeRng, smoothstep } from './core/utils.js';

const KIND = { PUFF: 0, STREAM: 1, STEAM: 2, SMOKE: 3, SPARKLE: 4, CRUMB: 5, MOTE: 6 };
const STYLE = { SOFT: 0, BILLOW: 1, BEAD: 2, STAR: 3 };
const NORMAL_CAPACITY = 2400;
const ADDITIVE_CAPACITY = 600;
const GRAVITY = 9.8;
const STEAM_DEFAULTS = { rate: 20, spread: 0.05, rise: 0.35, size: 0.06, color: 0xf4f2ee };
const SMOKE_DEFAULTS = { rate: 15, spread: 0.05, rise: 0.22, size: 0.07, color: 0x2e2a27 };
const SMOKE_HAZE = [0.13, 0.13, 0.145]; // gris azulado (lineal) al que tiende el humo al diluirse
// Corriente de aire suave de la cocina: inclina un poco el vapor y el humo.
const DRAFT_X = 0.018, DRAFT_Z = 0.006;

const VERTEX = /* glsl */`
uniform float uProjScale; // altura del buffer en px / (2·tan(fov/2))
uniform float uMaxPoint;
attribute vec4 aColor;    // rgb lineal + alfa
attribute float aSize;    // diámetro en metros
attribute vec3 aMisc;     // semilla, estilo, rotación
varying vec4 vColor;
varying vec3 vMisc;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mv.z, 1e-3);
  float px = aSize * uProjScale / dist;
  float a = aColor.a * smoothstep(0.05, 0.2, dist); // se desvanece pegado a la cámara
  // por debajo de 1.5 px se conserva la energía en vez de parpadear
  if (px < 1.5) { a *= px * px / 2.25; px = 1.5; }
  gl_PointSize = min(px, uMaxPoint);
  gl_Position = projectionMatrix * mv;
  if (a < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // invisible: fuera del recorte
  vColor = vec4(aColor.rgb, a);
  vMisc = aMisc;
}`;

const FRAGMENT = /* glsl */`
varying vec4 vColor;
varying vec3 vMisc;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0; // y hacia abajo
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float style = vMisc.y, seed = vMisc.x;
  vec3 col = vColor.rgb;
  float a;
  if (style < 0.5) {
    // disco suave
    a = (1.0 - r2) * (1.0 - r2);
  } else if (style < 1.5) {
    // nube: caída gaussiana cuya densidad modula un ruido (sin borde visible)
    vec2 q = rot2(vMisc.z) * p;
    float n = vnoise(q * 2.2 + seed * 71.0) * 0.6 + vnoise(q * 4.9 + seed * 37.0) * 0.4;
    float fall = (exp(-r2 * 3.0) - 0.05) / 0.95;
    a = clamp(fall * (0.4 + 1.2 * n * n), 0.0, 1.0);
    col *= 0.92 + 0.14 * n;
  } else if (style < 2.5) {
    // grano sólido: contorno irregular y luz falsa desde arriba
    float ang = atan(p.y, p.x);
    float rr = 0.8 + 0.12 * sin(ang * 3.0 + seed * 40.0) + 0.07 * sin(ang * 5.0 + seed * 17.0);
    float r = sqrt(r2);
    a = 1.0 - smoothstep(rr - 0.14, rr, r);
    vec3 nrm = normalize(vec3(p.x, -p.y, 1.3 * sqrt(max(0.0, 1.0 - r2 / (rr * rr)))));
    float lam = clamp(dot(nrm, vec3(-0.33, 0.74, 0.58)), 0.0, 1.0);
    col *= 0.42 + 0.78 * lam;
  } else {
    // destello: núcleo + cuatro rayos
    vec2 q = rot2(vMisc.z) * p;
    float core = exp(-r2 * 20.0);
    float rays = exp(-abs(q.x) * 26.0) * (1.0 - abs(q.y)) + exp(-abs(q.y) * 26.0) * (1.0 - abs(q.x));
    a = clamp(core + rays * 0.75 + exp(-r2 * 5.0) * 0.3, 0.0, 1.0);
    col = mix(col, vec3(max(col.r, 1.0) * 1.4), core * 0.55);
  }
  gl_FragColor = vec4(col, vColor.a * a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Lee un punto {x,y,z} o [x,y,z] en `out`. Devuelve false si no es válido. */
function readVec(v, out) {
  if (!v) return false;
  const x = v.x ?? v[0], y = v.y ?? v[1], z = v.z ?? v[2];
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  out.set(x, y, z);
  return true;
}

/** Conjunto de partículas con almacenamiento compacto (las vivas ocupan [0, count)). */
class Pool {
  constructor(capacity, blending, sorted) {
    this.capacity = capacity;
    this.sorted = sorted;
    this.count = 0;
    // estado de simulación
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.rgb = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);  // arrastre; en chorros: segundos entre granos; en migas: >0 = en reposo
    this.lift = new Float32Array(capacity);  // velocidad vertical objetivo o gravedad, según el tipo
    this.floor = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.style = new Uint8Array(capacity);
    this.owner = new Int32Array(capacity);
    this.vectors = [this.pos, this.vel, this.rgb];
    this.scalars = [this.age, this.life, this.size0, this.size1, this.alpha0, this.seed, this.rot, this.spin,
      this.drag, this.lift, this.floor, this.kind, this.style, this.owner];
    // valores visuales del frame (no se intercambian: se recalculan siempre)
    this.outSize = new Float32Array(capacity);
    this.outAlpha = new Float32Array(capacity);
    this.outRgb = new Float32Array(capacity * 3);
    this.depth = new Float32Array(capacity);
    this.order = new Int32Array(capacity);

    const geometry = new THREE.BufferGeometry();
    const attr = (name, size) => {
      const a = new THREE.BufferAttribute(new Float32Array(capacity * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, a);
      return a;
    };
    this.gPos = attr('position', 3);
    this.gColor = attr('aColor', 4);
    this.gSize = attr('aSize', 1);
    this.gMisc = attr('aMisc', 3);
    this.attributes = [this.gPos, this.gColor, this.gSize, this.gMisc];
    geometry.setDrawRange(0, 0);

    this.uniforms = { uProjScale: { value: 800 }, uMaxPoint: { value: 256 } };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      transparent: true, depthWrite: false, depthTest: true, blending,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10; // después del resto de transparentes (cristales)
    this.points.visible = false;
    this.points.name = blending === THREE.AdditiveBlending ? 'particles-additive' : 'particles-normal';
  }

  /** Reserva una partícula; devuelve su índice o -1 si el conjunto está lleno. */
  spawn(kind, style) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.kind[i] = kind; this.style[i] = style;
    this.age[i] = 0; this.rot[i] = 0; this.spin[i] = 0; this.drag[i] = 0; this.lift[i] = 0;
    this.floor[i] = -Infinity; this.owner[i] = -1; this.alpha0[i] = 1;
    this.vel.fill(0, i * 3, i * 3 + 3);
    return i;
  }

  /** Elimina la partícula i moviendo la última a su hueco. */
  kill(i) {
    const j = --this.count;
    if (i === j) return;
    for (const a of this.vectors) { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; }
    for (const a of this.scalars) a[i] = a[j];
  }

  /** Copia el estado visible a los buffers de GPU (de atrás hacia delante si hace falta). */
  upload(camera) {
    const n = this.count;
    this.points.visible = n > 0;
    if (n === 0) return;
    const { order, depth, pos } = this;
    for (let k = 0; k < n; k++) order[k] = k;
    if (this.sorted && camera && n > 1) {
      const e = camera.matrixWorld.elements;
      const cx = e[12], cy = e[13], cz = e[14], fx = -e[8], fy = -e[9], fz = -e[10];
      for (let k = 0; k < n; k++) {
        depth[k] = (pos[k * 3] - cx) * fx + (pos[k * 3 + 1] - cy) * fy + (pos[k * 3 + 2] - cz) * fz;
      }
      order.subarray(0, n).sort((a, b) => depth[b] - depth[a]);
    }
    const gp = this.gPos.array, gc = this.gColor.array, gs = this.gSize.array, gm = this.gMisc.array;
    const { outRgb, outAlpha, outSize, seed, style, rot } = this;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      gp[k * 3] = pos[i * 3]; gp[k * 3 + 1] = pos[i * 3 + 1]; gp[k * 3 + 2] = pos[i * 3 + 2];
      gc[k * 4] = outRgb[i * 3]; gc[k * 4 + 1] = outRgb[i * 3 + 1]; gc[k * 4 + 2] = outRgb[i * 3 + 2];
      gc[k * 4 + 3] = outAlpha[i];
      gs[k] = outSize[i];
      gm[k * 3] = seed[i]; gm[k * 3 + 1] = style[i]; gm[k * 3 + 2] = rot[i];
    }
    for (const a of this.attributes) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    this.points.geometry.setDrawRange(0, n);
  }
}

/**
 * Crea el sistema de partículas de la cocina. Añade `group` a la escena y llama a `update(dt)` cada frame.
 * Las posiciones son de mundo (el grupo debe colgar directamente de la escena).
 * @param {{engine?: any, camera?: THREE.Camera, renderer?: THREE.WebGLRenderer}} [ctx]
 */
export function createParticles(ctx = {}) {
  const group = new THREE.Group();
  group.name = 'particles';
  const normal = new Pool(NORMAL_CAPACITY, THREE.NormalBlending, true);
  const additive = new Pool(ADDITIVE_CAPACITY, THREE.AdditiveBlending, false);
  group.add(normal.points, additive.points);

  const rng = makeRng(20261021);
  const rand = (a, b) => a + (b - a) * rng();
  const amount = ctx.engine?.quality === 'low' ? 0.6 : 1; // menos partículas en calidad baja
  const emitters = new Set();
  const moteSets = new Map();
  let moteId = 0, time = 0, warned = false, maxPoint = 0;
  const tmpColor = new THREE.Color(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const bufferSize = new THREE.Vector2();

  // Escala de proyección por render: sigue al tamaño del lienzo, al fov y al zoom sin más avisos.
  const onBeforeRender = (renderer, scene, camera) => {
    if (!maxPoint) {
      const gl = renderer.getContext();
      maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)?.[1] || 256;
    }
    const rt = renderer.getRenderTarget();
    const h = rt ? rt.height : renderer.getDrawingBufferSize(bufferSize).y;
    const scale = camera.isPerspectiveCamera ? camera.projectionMatrix.elements[5] * h * 0.5 : h;
    for (const pool of [normal, additive]) {
      pool.uniforms.uProjScale.value = scale;
      pool.uniforms.uMaxPoint.value = maxPoint;
    }
  };
  normal.points.onBeforeRender = onBeforeRender;
  additive.points.onBeforeRender = onBeforeRender;

  /** Color de entrada (número, cadena o THREE.Color) con una variación de brillo. */
  function setColor(pool, i, color, jitter = 0.05, gain = 1) {
    const k = gain * (1 - jitter + 2 * jitter * rng());
    pool.rgb[i * 3] = color.r * k; pool.rgb[i * 3 + 1] = color.g * k; pool.rgb[i * 3 + 2] = color.b * k;
  }
  function parseColor(c, fallback) {
    try { return tmpColor.set(c ?? fallback).clone(); } catch { return new THREE.Color(fallback); }
  }
  const count = (n, def, max) => Math.round(clamp(Number.isFinite(n) ? n : def, 0, max) * amount);
  const num = (v, def) => (Number.isFinite(v) ? v : def);

  // ---------- Emisión de cada tipo ----------

  function spawnStream(em, pre) {
    const i = normal.spawn(KIND.STREAM, STYLE.SOFT);
    if (i < 0) return;
    const { from, to } = em;
    const r = rng() * 0.0035, a = rng() * Math.PI * 2;
    const x = from.x + Math.cos(a) * r, y = from.y, z = from.z + Math.sin(a) * r;
    // caída parabólica que acaba en `to`; gravedad algo suavizada para que el chorro se vea continuo
    const h = y - to.y, u = 0.1, gEff = 4;
    let T = h > 0 ? (-u + Math.sqrt(u * u + 2 * gEff * h)) / gEff : em.life * 0.6;
    T = clamp(T * rand(0.94, 1.06), 0.05, em.life);
    const g = Math.max(1.5, (2 * (h - u * T)) / (T * T));
    const spreadXZ = 0.004 + 0.035 * Math.max(0, h);
    const tx = to.x + (rng() - 0.5) * spreadXZ, tz = to.z + (rng() - 0.5) * spreadXZ;
    const vx = (tx - x) / T, vy = (to.y - y + 0.5 * g * T * T) / T, vz = (tz - z) / T;
    // estado exacto tras `pre` segundos de vuelo (gravedad incluida): granos equiespaciados
    normal.pos[i * 3] = x + vx * pre;
    normal.pos[i * 3 + 1] = y + vy * pre - 0.5 * g * pre * pre;
    normal.pos[i * 3 + 2] = z + vz * pre;
    normal.vel[i * 3] = vx; normal.vel[i * 3 + 1] = vy - g * pre; normal.vel[i * 3 + 2] = vz;
    normal.age[i] = pre;
    normal.lift[i] = g;
    normal.drag[i] = 1 / Math.max(1, em.rate * amount); // separación temporal entre granos
    normal.life[i] = T;
    normal.size0[i] = em.size * rand(0.7, 1.3);
    normal.alpha0[i] = rand(0.65, 0.95);
    normal.seed[i] = rng();
    setColor(normal, i, em.color, 0.06);
  }

  function spawnVapor(em, pre) {
    const smoke = em.kind === KIND.SMOKE;
    const i = normal.spawn(em.kind, STYLE.BILLOW);
    if (i < 0) return;
    const r = Math.sqrt(rng()) * em.spread, a = rng() * Math.PI * 2;
    normal.pos[i * 3] = em.pos.x + Math.cos(a) * r;
    normal.pos[i * 3 + 1] = em.pos.y + rng() * 0.01;
    normal.pos[i * 3 + 2] = em.pos.z + Math.sin(a) * r;
    normal.vel[i * 3] = (rng() - 0.5) * 0.03;
    normal.vel[i * 3 + 1] = em.rise * 0.15; // nace casi quieto y acelera al flotar
    normal.vel[i * 3 + 2] = (rng() - 0.5) * 0.03;
    normal.lift[i] = em.rise * rand(0.8, 1.2);
    normal.drag[i] = smoke ? 1.4 : 1.8;
    normal.life[i] = smoke ? rand(2.2, 3.2) : rand(1.0, 1.7);
    normal.size0[i] = em.size * rand(0.35, 0.6);
    normal.size1[i] = em.size * (smoke ? rand(3.0, 4.0) : rand(1.7, 2.4));
    normal.alpha0[i] = smoke ? rand(0.6, 0.75) : rand(0.45, 0.6);
    normal.seed[i] = rng();
    normal.rot[i] = rng() * Math.PI * 2;
    normal.spin[i] = (rng() - 0.5) * 1.0;
    setColor(normal, i, em.color, 0.05, smoke ? 1 : 1.25); // el vapor dispersa luz: blanco algo «HDR»
    advance(normal, i, pre);
  }

  /** Adelanta una partícula recién nacida una fracción del frame (emisión continua sin saltos). */
  function advance(pool, i, t) {
    if (t <= 0) return;
    pool.age[i] = t;
    for (let c = 0; c < 3; c++) pool.pos[i * 3 + c] += pool.vel[i * 3 + c] * t;
  }

  function makeEmitter(kind, spawnFn, props) {
    const em = { kind, spawnFn, rate: 0, acc: rng(), active: true, ...props };
    emitters.add(em);
    return em;
  }

  function runEmitters(dt) {
    for (const em of emitters) {
      if (!em.active) { emitters.delete(em); continue; }
      em.acc += em.rate * amount * dt;
      const n = Math.min(Math.floor(em.acc), 200);
      em.acc -= Math.floor(em.acc);
      for (let k = 0; k < n; k++) em.spawnFn(em, dt * ((k + rng()) / n));
    }
  }

  // ---------- Simulación ----------

  function simulate(pool, dt) {
    const { pos, vel, age, life, kind } = pool;
    let i = 0;
    while (i < pool.count) {
      age[i] += dt;
      const t = age[i] / life[i];
      if (t >= 1 || !stepParticle(pool, i, dt, Math.max(0, t))) { pool.kill(i); continue; }
      if (kind[i] !== KIND.CRUMB) { // las migas integran su posición al rebotar
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      i++;
    }
  }

  /** Avanza la velocidad/aspecto de una partícula. Devuelve false si debe morir. */
  function stepParticle(p, i, dt, t) {
    const i3 = i * 3, v = p.vel, s0 = p.size0[i], a0 = p.alpha0[i];
    let size = s0, alpha = a0, haze = 0;
    switch (p.kind[i]) {
      case KIND.PUFF: {
        relax(v, i3, DRAFT_X * 0.4, p.lift[i], DRAFT_Z * 0.4, p.drag[i], dt);
        size = s0 + (p.size1[i] - s0) * (1 - (1 - t) * (1 - t));
        alpha = a0 * smoothstep(0, 0.08, t) * Math.pow(1 - t, 1.6);
        p.rot[i] += p.spin[i] * dt;
        break;
      }
      case KIND.STREAM: {
        v[i3 + 1] -= p.lift[i] * dt;
        // desenfoque de movimiento aproximado: cada grano cubre el hueco hasta el siguiente
        // (velocidad / ritmo de emisión, guardado en drag) y se aclara al estirarse
        const speed = Math.hypot(v[i3], v[i3 + 1], v[i3 + 2]);
        size = Math.max(s0 * (1 + 0.3 * t), 2 * speed * p.drag[i]);
        alpha = a0 * Math.pow(s0 / size, 0.6) * smoothstep(0, 0.06, t) * (1 - smoothstep(0.86, 1, t));
        break;
      }
      case KIND.STEAM:
      case KIND.SMOKE: {
        const sd = p.seed[i] * 40, w = 0.035 * (0.4 + t), age = p.age[i];
        relax(v, i3,
          DRAFT_X * (0.3 + t) + Math.sin(age * 1.9 + sd) * w,
          p.lift[i] * (1 - 0.55 * t),
          DRAFT_Z * (0.3 + t) + Math.cos(age * 1.5 + sd * 0.7) * w,
          p.drag[i], dt);
        size = s0 + (p.size1[i] - s0) * (1 - Math.pow(1 - t, 1.7));
        alpha = a0 * smoothstep(0, 0.1, t) * (1 - t);
        p.rot[i] += p.spin[i] * dt;
        if (p.kind[i] === KIND.SMOKE) haze = 0.8 * Math.pow(t, 0.7); // el humo denso se diluye en neblina gris
        break;
      }
      case KIND.SPARKLE: {
        relax(v, i3, 0, p.lift[i], 0, p.drag[i], dt);
        const pop = smoothstep(0, 0.1, t), sd = p.seed[i];
        const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(p.age[i] * (13 + sd * 11) + sd * 40));
        size = s0 * (0.35 + 0.65 * pop) * (1 - 0.45 * t);
        alpha = a0 * pop * Math.pow(1 - t, 1.2) * twinkle;
        p.rot[i] += p.spin[i] * dt;
        break;
      }
      case KIND.CRUMB: {
        stepCrumb(p, i, dt);
        alpha = a0 * (1 - smoothstep(0.78, 1, t));
        break;
      }
      case KIND.MOTE: {
        const set = moteSets.get(p.owner[i]);
        if (!set || (set.target === 0 && set.level <= 0.001)) return false;
        alpha = a0 * set.level * stepMote(p, i, set);
        break;
      }
      default:
        return false;
    }
    p.outSize[i] = size;
    p.outAlpha[i] = alpha;
    for (let c = 0; c < 3; c++) p.outRgb[i3 + c] = p.rgb[i3 + c] + (SMOKE_HAZE[c] - p.rgb[i3 + c]) * haze;
    return true;
  }

  /** La velocidad tiende a (tx, ty, tz) con una constante `k` (arrastre del aire). */
  function relax(v, i3, tx, ty, tz, k, dt) {
    const f = Math.exp(-k * dt);
    v[i3] = tx + (v[i3] - tx) * f;
    v[i3 + 1] = ty + (v[i3 + 1] - ty) * f;
    v[i3 + 2] = tz + (v[i3 + 2] - tz) * f;
  }

  function stepCrumb(p, i, dt) {
    const i3 = i * 3, v = p.vel, pos = p.pos, floor = p.floor[i];
    if (p.drag[i] > 0) return; // en las migas, drag > 0 marca que ya reposan
    v[i3 + 1] -= GRAVITY * dt;
    pos[i3] += v[i3] * dt; pos[i3 + 1] += v[i3 + 1] * dt; pos[i3 + 2] += v[i3 + 2] * dt;
    p.rot[i] += p.spin[i] * dt;
    if (pos[i3 + 1] < floor) {
      pos[i3 + 1] = floor;
      if (Math.abs(v[i3 + 1]) < 0.3) {
        v[i3] = v[i3 + 1] = v[i3 + 2] = 0;
        p.drag[i] = 1; // marca de reposo
      } else {
        v[i3 + 1] = -v[i3 + 1] * 0.32;
        v[i3] *= 0.55; v[i3 + 2] *= 0.55;
      }
    }
  }

  /** Deriva lenta por un campo de flujo suave, dando la vuelta dentro de la caja. Devuelve el fundido de borde. */
  function stepMote(p, i, set) {
    const i3 = i * 3, pos = p.pos, v = p.vel, sd = p.seed[i] * 30;
    const x = pos[i3], y = pos[i3 + 1], z = pos[i3 + 2];
    v[i3] = 0.006 * Math.sin(y * 7 + time * 0.21 + sd) + 0.004 * Math.sin(z * 5 + time * 0.13);
    v[i3 + 1] = 0.004 * Math.sin(x * 6 + time * 0.17 + sd * 0.6) + 0.0012;
    v[i3 + 2] = 0.005 * Math.sin(x * 4 + y * 3 + time * 0.19 + sd * 0.4);
    const { min, max } = set.box;
    let edge = 1;
    for (let c = 0; c < 3; c++) {
      const lo = min.getComponent(c), hi = max.getComponent(c), span = hi - lo;
      let q = pos[i3 + c];
      if (q < lo) q += span; else if (q > hi) q -= span;
      pos[i3 + c] = q;
      const m = Math.max(1e-4, Math.min(0.15, span * 0.2));
      edge = Math.min(edge, smoothstep(0, m, q - lo), smoothstep(0, m, hi - q));
    }
    const twinkle = 0.55 + 0.45 * Math.sin(time * (0.5 + p.seed[i]) + sd * 2);
    return edge * twinkle;
  }

  /** Emisor continuo de vapor o humo con su handle. */
  function vaporHandle(kind, pos, opts, def) {
    opts = opts ?? {};
    const em = makeEmitter(kind, spawnVapor, {
      pos: new THREE.Vector3(), color: parseColor(opts.color, def.color),
      spread: num(opts.spread, def.spread), rise: num(opts.rise, def.rise), size: Math.max(0, num(opts.size, def.size)),
    });
    em.active = readVec(pos, em.pos);
    em.rate = Math.max(0, num(opts.rate, def.rate));
    return {
      setRate(r) { if (Number.isFinite(r)) em.rate = Math.max(0, r); },
      setPosition(v) { readVec(v, em.pos); },
      stop() { em.active = false; },
      get active() { return em.active; },
    };
  }

  // ---------- API ----------

  return {
    group,

    /**
     * Avanza la simulación y sube los buffers. Nunca lanza.
     * @param {number} dt segundos
     */
    update(dt) {
      try {
        dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
        time += dt;
        for (const [id, set] of moteSets) {
          set.level += (set.target - set.level) * (1 - Math.exp(-set.fadeRate * dt));
          if (set.target === 0 && set.level <= 0.001) moteSets.delete(id);
        }
        runEmitters(dt);
        simulate(normal, dt);
        simulate(additive, dt);
        const camera = ctx.camera ?? ctx.engine?.camera;
        normal.upload(camera);
        additive.upload(camera);
      } catch (e) {
        if (!warned) { warned = true; console.error('particles.update', e); }
      }
    },

    /**
     * Nube que estalla hacia fuera, frena y cae despacio (harina al caer, polvo...). `rise` > 0 la hace subir (vapor).
     * @param {THREE.Vector3} pos
     * @param {{color?: THREE.ColorRepresentation, count?: number, spread?: number, size?: number, life?: number, rise?: number}} [opts]
     */
    puff(pos, opts) {
      let { color = 0xffffff, count: n = 40, spread = 0.08, size = 0.02, life = 1.2, rise = 0 } = opts ?? {};
      if (!readVec(pos, tmpA)) return;
      const c = parseColor(color, 0xffffff);
      spread = num(spread, 0.08); size = Math.max(0, num(size, 0.02)); life = Math.max(0.1, num(life, 1.2)); rise = num(rise, 0);
      for (let k = 0, total = count(n, 40, 400); k < total; k++) {
        const i = normal.spawn(KIND.PUFF, STYLE.BILLOW);
        if (i < 0) break;
        // dirección aleatoria hacia fuera y algo hacia arriba
        let dx = rng() * 2 - 1, dy = Math.abs(rng() * 2 - 1) * 0.8 + 0.12, dz = rng() * 2 - 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const speed = spread * rand(2.2, 5.2), r0 = spread * 0.25 * Math.cbrt(rng());
        normal.pos[i * 3] = tmpA.x + dx * r0;
        normal.pos[i * 3 + 1] = tmpA.y + dy * r0 * 0.6;
        normal.pos[i * 3 + 2] = tmpA.z + dz * r0;
        normal.vel[i * 3] = dx * speed; normal.vel[i * 3 + 1] = dy * speed; normal.vel[i * 3 + 2] = dz * speed;
        normal.drag[i] = rand(4.2, 5.6);
        normal.lift[i] = rise > 0 ? rise * rand(0.7, 1.3) : -rand(0.012, 0.04);
        normal.life[i] = life * rand(0.7, 1.3);
        normal.size0[i] = size * rand(0.7, 1.3);
        normal.size1[i] = normal.size0[i] * (rise > 0 ? rand(2.6, 3.4) : rand(2.3, 3.2));
        normal.alpha0[i] = rise > 0 ? rand(0.35, 0.5) : rand(0.45, 0.7);
        normal.seed[i] = rng();
        normal.rot[i] = rng() * Math.PI * 2;
        normal.spin[i] = (rng() - 0.5) * 1.6;
        setColor(normal, i, c, 0.05);
      }
    },

    /**
     * Chorro continuo de partículas que cae de `from` a `to` describiendo una parábola.
     * @param {THREE.Vector3} from
     * @param {THREE.Vector3} to
     * @param {{color?: THREE.ColorRepresentation, rate?: number, size?: number, life?: number}} [opts]
     *   rate en partículas/s (120), size en m (0.006), life = tiempo máximo de caída (0.6 s)
     * @returns {{setFrom(v): void, setTo(v): void, setRate(r: number): void, stop(): void, readonly active: boolean}}
     */
    stream(from, to, opts) {
      const { color = 0xf4efe6, rate = 120, size = 0.006, life = 0.6 } = opts ?? {};
      const em = makeEmitter(KIND.STREAM, spawnStream, {
        from: new THREE.Vector3(), to: new THREE.Vector3(), color: parseColor(color, 0xf4efe6),
        size: Math.max(0, num(size, 0.006)), life: Math.max(0.05, num(life, 0.6)),
      });
      em.active = readVec(from, em.from) && readVec(to, em.to);
      em.rate = Math.max(0, num(rate, 120));
      return {
        setFrom(v) { readVec(v, em.from); },
        setTo(v) { readVec(v, em.to); },
        setRate(r) { if (Number.isFinite(r)) em.rate = Math.max(0, r); },
        stop() { em.active = false; },
        get active() { return em.active; },
      };
    },

    /**
     * Vapor que sube, se expande, deriva y se desvanece (pan recién horneado, agua caliente).
     * @param {THREE.Vector3} pos
     * @param {{rate?: number, spread?: number, rise?: number, size?: number, color?: THREE.ColorRepresentation}} [opts]
     *   por defecto rate 20/s, spread 0.05, rise 0.35 m/s, size 0.06
     * @returns {{setRate(r: number): void, setPosition(v): void, stop(): void, readonly active: boolean}}
     */
    steam(pos, opts) { return vaporHandle(KIND.STEAM, pos, opts, STEAM_DEFAULTS); },

    /**
     * Humo oscuro y lento (pan quemándose). Mismas opciones que steam(); por defecto rate 15/s, rise 0.22, size 0.07.
     * @param {THREE.Vector3} pos
     * @returns {{setRate(r: number): void, setPosition(v): void, stop(): void, readonly active: boolean}}
     */
    smoke(pos, opts) { return vaporHandle(KIND.SMOKE, pos, opts, SMOKE_DEFAULTS); },

    /**
     * Destellos aditivos que saltan y titilan (celebración, azúcar al sol).
     * @param {THREE.Vector3} pos
     * @param {{color?: THREE.ColorRepresentation, count?: number, spread?: number, size?: number, life?: number}} [opts]
     */
    sparkle(pos, opts) {
      let { color = 0xffd27a, count: n = 24, spread = 0.05, size = 0.022, life = 1.1 } = opts ?? {};
      if (!readVec(pos, tmpA)) return;
      // ACES desatura los colores intensos: se satura antes para que el dorado siga siéndolo
      const c = parseColor(color, 0xffd27a);
      const luma = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.setRGB(...[c.r, c.g, c.b].map((x) => Math.max(0, luma + (x - luma) * 1.7)), THREE.LinearSRGBColorSpace);
      spread = num(spread, 0.05); size = Math.max(0, num(size, 0.022)); life = Math.max(0.1, num(life, 1.1));
      for (let k = 0, total = count(n, 24, 200); k < total; k++) {
        const i = additive.spawn(KIND.SPARKLE, STYLE.STAR);
        if (i < 0) break;
        let dx = rng() * 2 - 1, dy = rng() * 2 - 0.6, dz = rng() * 2 - 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        const speed = rand(0.2, 0.55) * (spread / 0.05), r0 = spread * 0.4 * Math.cbrt(rng());
        additive.pos[i * 3] = tmpA.x + dx * r0;
        additive.pos[i * 3 + 1] = tmpA.y + dy * r0;
        additive.pos[i * 3 + 2] = tmpA.z + dz * r0;
        additive.vel[i * 3] = dx * speed; additive.vel[i * 3 + 1] = dy * speed; additive.vel[i * 3 + 2] = dz * speed;
        additive.drag[i] = rand(2.8, 4);
        additive.lift[i] = -rand(0.02, 0.06);
        additive.life[i] = life * rand(0.65, 1.25);
        additive.size0[i] = size * rand(0.55, 1.2);
        additive.alpha0[i] = rand(0.85, 1);
        additive.seed[i] = rng();
        additive.rot[i] = rng() * Math.PI;
        additive.spin[i] = (rng() - 0.5) * 3;
        setColor(additive, i, c, 0.12, 1.1);
      }
    },

    /**
     * Migas que saltan, rebotan en `floorY` y se desvanecen (al cortar el pan).
     * @param {THREE.Vector3} pos
     * @param {{count?: number, color?: THREE.ColorRepresentation, floorY?: number, spread?: number, size?: number, life?: number}} [opts]
     *   floorY por defecto = encimera (COUNTER.topY)
     */
    crumbs(pos, opts) {
      let { count: n = 30, color = 0xc8955a, floorY, spread = 0.03, size = 0.005, life = 2.8 } = opts ?? {};
      if (!readVec(pos, tmpA)) return;
      const c = parseColor(color, 0xc8955a);
      const crust = c.clone().multiplyScalar(0.45), crumb = new THREE.Color(0xf3e2bd);
      const floor = Math.min(num(floorY, COUNTER.topY), tmpA.y);
      spread = num(spread, 0.03); size = Math.max(0, num(size, 0.005)); life = Math.max(0.3, num(life, 2.8));
      for (let k = 0, total = count(n, 30, 300); k < total; k++) {
        const i = normal.spawn(KIND.CRUMB, STYLE.BEAD);
        if (i < 0) break;
        const a = rng() * Math.PI * 2, hs = rand(0.12, 0.6);
        normal.pos[i * 3] = tmpA.x + (rng() - 0.5) * spread;
        normal.pos[i * 3 + 1] = tmpA.y + rng() * 0.01;
        normal.pos[i * 3 + 2] = tmpA.z + (rng() - 0.5) * spread;
        normal.vel[i * 3] = Math.cos(a) * hs;
        normal.vel[i * 3 + 1] = rand(0.3, 1.1);
        normal.vel[i * 3 + 2] = Math.sin(a) * hs;
        normal.size0[i] = size * rand(0.5, 1.4);
        normal.floor[i] = floor + normal.size0[i] * 0.35;
        normal.life[i] = life * rand(0.8, 1.2);
        normal.alpha0[i] = 1;
        normal.seed[i] = rng();
        normal.rot[i] = rng() * Math.PI * 2;
        normal.spin[i] = (rng() - 0.5) * 20;
        // mezcla: trozos de corteza oscura y de miga clara
        const m = rng();
        tmpColor.copy(c);
        if (m < 0.3) tmpColor.lerp(crust, rand(0.3, 0.8)); else if (m > 0.75) tmpColor.lerp(crumb, rand(0.4, 0.9));
        setColor(normal, i, tmpColor, 0.06);
      }
    },

    /**
     * Motas de polvo/harina flotando muy despacio dentro de `box` (en la luz de la ventana).
     * @param {THREE.Box3} box
     * @param {number} [n=120]
     * @returns {{setOpacity(v01: number): void, stop(fadeSeconds?: number): void}}
     */
    motes(box, n = 120) {
      const inert = { setOpacity() {}, stop() {} };
      if (!box?.min || !box?.max || !readVec(box.min, tmpA) || !readVec(box.max, tmpB)) return inert;
      const b = new THREE.Box3(tmpA.clone().min(tmpB), tmpA.clone().max(tmpB));
      if (b.isEmpty()) return inert;
      const id = ++moteId;
      const set = { box: b, level: 0, target: 1, fadeRate: 0.8 };
      moteSets.set(id, set);
      const warm = new THREE.Color(0xfff1d6);
      for (let k = 0, total = count(n, 120, 400); k < total; k++) {
        const i = additive.spawn(KIND.MOTE, STYLE.SOFT);
        if (i < 0) break;
        additive.pos[i * 3] = rand(b.min.x, b.max.x);
        additive.pos[i * 3 + 1] = rand(b.min.y, b.max.y);
        additive.pos[i * 3 + 2] = rand(b.min.z, b.max.z);
        additive.life[i] = Infinity;
        additive.owner[i] = id;
        additive.size0[i] = rand(0.0018, 0.0042);
        additive.alpha0[i] = rand(0.25, 0.6);
        additive.seed[i] = rng();
        setColor(additive, i, warm, 0.1, 1.5);
      }
      return {
        setOpacity(v) { if (Number.isFinite(v) && set.target !== 0) set.target = clamp(v, 0.001, 1); },
        stop(fade = 1.2) { set.target = 0; set.fadeRate = 4 / Math.max(0.05, num(fade, 1.2)); },
      };
    },

    /** Elimina todas las partículas y detiene los emisores (sus handles siguen siendo seguros). */
    clear() {
      for (const em of emitters) em.active = false;
      emitters.clear();
      moteSets.clear();
      normal.count = 0;
      additive.count = 0;
      normal.points.visible = additive.points.visible = false;
    },

    /** Recuento de partículas vivas (depuración y pruebas). */
    stats() {
      return { normal: normal.count, additive: additive.count, emitters: emitters.size, motes: moteSets.size };
    },
  };
}
