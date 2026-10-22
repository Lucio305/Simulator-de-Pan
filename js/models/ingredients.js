// Ingredientes del pan: seis recipientes con personalidad sobre la isla (bolsa de harina, jarra de
// agua, tarro de levadura, salero de cerámica, tarro de azúcar y botella de aceite), su coreografía de
// vertido con chorros propios y lo que va cayendo dentro del bol antes de convertirse en masa.
// Todo es procedural: geometrías de torno y de barrido, y etiquetas pintadas en canvas.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, smoothstep, damp, makeRng, noise3, fbm3, makeCanvasTexture, makeHighlighter } from '../core/utils.js';
import { SPOTS, SIZES, CAMERAS } from '../core/layout.js';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const GRAVITY = 9.8;
const BOWL = SIZES.bowl;
const UP = new THREE.Vector3(0, 1, 0);
/** Dirección horizontal del vertido: de izquierda a derecha y un pelín hacia la cámara. */
const POUR_DIR = new THREE.Vector3(1, 0, 0.18).normalize();
const POUR_YAW = Math.atan2(-POUR_DIR.z, POUR_DIR.x);           // giro que apunta el +X local hacia POUR_DIR
const TILT_AXIS = new THREE.Vector3().crossVectors(UP, POUR_DIR).normalize();
const TRAVEL_TIME = 1.0;                                         // s: de casa a encima del bol
const TILT_TIME = 0.5;                                           // s: base para inclinar (+ según el ángulo)
const UNTILT_TIME = 0.25;                                        // s: al soltar se endereza deprisa
const DEFAULT_TARGET = SPOTS.scale.clone().add(new THREE.Vector3(0, SIZES.scaleHeight + BOWL.wall + 0.002, 0));

const SANS_BLACK = '"Arial Black", "Arial Bold", Arial, Helvetica, sans-serif';
const SANS = 'Arial, Helvetica, sans-serif';
const SERIF = 'Georgia, "Times New Roman", Times, serif';

/** Datos de juego de cada ingrediente (capacidad = lo que trae el recipiente lleno). */
const ITEM_DEFS = {
  flour: { label: 'Harina de fuerza', unit: 'g', maxRate: 110, capacity: 1000, sound: 'pour-powder' },
  water: { label: 'Agua', unit: 'ml', maxRate: 70, capacity: 800, sound: 'pour-liquid' },
  yeast: { label: 'Levadura seca', unit: 'g', maxRate: 2.5, capacity: 100, sound: 'pour-powder' },
  salt: { label: 'Sal', unit: 'g', maxRate: 3, capacity: 250, sound: 'pour-powder' },
  sugar: { label: 'Azúcar', unit: 'g', maxRate: 8, capacity: 500, sound: 'pour-powder' },
  oil: { label: 'Aceite de oliva', unit: 'ml', maxRate: 10, capacity: 400, sound: 'pour-liquid' },
};

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const v2 = (x, y) => new THREE.Vector2(x, y);
const easeInOut = (t) => 0.5 - 0.5 * Math.cos(Math.PI * clamp(t));

function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/** Radio interior del bol a la altura y (0 = fondo interior), según el contrato. */
const bowlInnerR = (y) => BOWL.baseRadius + (BOWL.rimRadius - BOWL.baseRadius) * Math.pow(clamp(y / BOWL.height), 0.7) - BOWL.wall;
const BOWL_INNER_H = BOWL.height - BOWL.wall;
/** Altura de la pared interior del bol a la distancia r del eje (0 en el fondo plano). */
function bowlWallY(r) {
  const k = (r + BOWL.wall - BOWL.baseRadius) / (BOWL.rimRadius - BOWL.baseRadius);
  return k <= 0 ? 0 : Math.min(BOWL_INNER_H, BOWL.height * Math.pow(k, 1 / 0.7));
}

/**
 * Vidrio sin `transmission`: casi transparente de frente, más opaco en los bordes (Fresnel)
 * y con los brillos sin atenuar, para que lea como cristal grueso.
 */
function glassMaterial({ color = 0xffffff, opacity = 0.12, edge = 0.5, map = null, roughness = 0.05, side = THREE.FrontSide, envMapIntensity = 1.2 } = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color, map, roughness, metalness: 0, transparent: true, opacity, depthWrite: false, side,
    clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uEdge = { value: edge };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uEdge;\nvoid main() {')
      .replace('#include <opaque_fragment>', `
        float glassFres = 1.0 - abs(dot(normalize(vViewPosition), normal));
        float glassSpec = dot(totalSpecular, vec3(0.3333));
        diffuseColor.a = clamp(diffuseColor.a + uEdge * glassFres * glassFres + glassSpec * 0.7, 0.0, 1.0);
        #include <opaque_fragment>`);
  };
  return mat;
}

/** Torno con coordenada v proporcional a la altura (para etiquetas y marcas). */
function lathe(points, segments, phiStart, uvHeight) {
  const g = new THREE.LatheGeometry(points, segments, phiStart);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setY(i, p.getY(i) / uvHeight);
  return g;
}

/**
 * Perfil cerrado de un recipiente con grosor: exterior (de abajo arriba) → borde redondeado → interior.
 * @returns {{profile: THREE.Vector2[], inner: THREE.Vector2[], outerCount: number}} `inner` va de abajo arriba.
 */
function shellProfile(outer, t, tb) {
  const pts = outer.map(([r, y]) => v2(r, y));
  const n = pts.length;
  const inner = [];
  for (let i = n - 1; i >= 1; i--) {
    const a = pts[i - 1], b = pts[Math.min(n - 1, i + 1)];
    const tx = b.x - a.x, ty = b.y - a.y, len = Math.hypot(tx, ty) || 1;
    inner.push(v2(Math.max(0, pts[i].x - (ty / len) * t), Math.max(tb, pts[i].y + (tx / len) * t)));
  }
  inner.push(v2(0, tb));
  const rim = pts[n - 1];
  const lip = [v2(rim.x - t * 0.12, rim.y + t * 0.38), v2(rim.x - t * 0.5, rim.y + t * 0.52), v2(rim.x - t * 0.88, rim.y + t * 0.38)];
  return { profile: [...pts, ...lip, ...inner], inner: inner.slice().reverse(), outerCount: n + lip.length };
}

/** Promedia las normales de la costura de un torno (columnas primera y última). */
function weldLatheSeam(geo, rows, segments) {
  const nrm = geo.attributes.normal;
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let j = 0; j < rows; j++) {
    const a = j, b = segments * rows + j;
    v.fromBufferAttribute(nrm, a).add(w.fromBufferAttribute(nrm, b)).normalize();
    nrm.setXYZ(a, v.x, v.y, v.z);
    nrm.setXYZ(b, v.x, v.y, v.z);
  }
}

/**
 * Contorno de rectángulo redondeado (planta XZ) muestreado por longitud de arco. Empieza en el
 * centro de la cara trasera y recorre izquierda → frente → derecha. Cada punto: {x, z, nx, nz, s, u}.
 */
function roundedRectPath(a, b, rc, n) {
  const ea = a - rc, eb = b - rc, q = (Math.PI / 2) * rc;
  const corner = (cx, cz, a0) => (t) => { const ang = a0 - (t * Math.PI) / 2; return [cx + Math.cos(ang) * rc, cz + Math.sin(ang) * rc, Math.cos(ang), Math.sin(ang)]; };
  const segs = [
    [ea, (t) => [-t * ea, -b, 0, -1]],
    [q, corner(-ea, -eb, -Math.PI / 2)],
    [2 * eb, (t) => [-a, -eb + t * 2 * eb, -1, 0]],
    [q, corner(-ea, eb, Math.PI)],
    [2 * ea, (t) => [-ea + t * 2 * ea, b, 0, 1]],
    [q, corner(ea, eb, Math.PI / 2)],
    [2 * eb, (t) => [a, eb - t * 2 * eb, 1, 0]],
    [q, corner(ea, -eb, 0)],
    [ea, (t) => [ea - t * ea, -b, 0, -1]],
  ];
  const P = segs.reduce((s, [len]) => s + len, 0);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    let s = (i / n) * P, k = 0;
    const s0 = s;
    while (k < segs.length - 1 && s > segs[k][0]) { s -= segs[k][0]; k++; }
    const [x, z, nx, nz] = segs[k][1](clamp(s / segs[k][0]));
    pts.push({ x, z, nx, nz, s: s0, u: i / n });
  }
  const sFront = segs.slice(0, 4).reduce((s, [len]) => s + len, 0) + ea;    // centro del frente
  const sLeft = segs.slice(0, 2).reduce((s, [len]) => s + len, 0) + eb;     // centro del lateral izquierdo
  const sRight = segs.slice(0, 6).reduce((s, [len]) => s + len, 0) + eb;    // centro del lateral derecho
  return { pts, P, sFront, sLeft, sRight };
}

/**
 * Barrido de un contorno cerrado a lo largo de un perfil. `vertex(p, j)` devuelve [x, y, z, u, v].
 * `flip` invierte la orientación de las caras.
 */
function sweepGeometry(path, rows, vertex, flip = false) {
  const cols = path.length;
  const pos = new Float32Array(cols * rows * 3), uv = new Float32Array(cols * rows * 2);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const [x, y, z, u, v] = vertex(path[i], j);
      const k = i * rows + j;
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      uv[k * 2] = u; uv[k * 2 + 1] = v;
    }
  }
  const idx = [];
  for (let i = 0; i < cols - 1; i++) {
    for (let j = 0; j < rows - 1; j++) {
      const a = i * rows + j, b = (i + 1) * rows + j, c = b + 1, d = a + 1;
      if (flip) idx.push(a, d, b, b, d, c); else idx.push(a, b, d, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/** Disco polar (centro + anillos) con posiciones a rellenar; útil para superficies que cambian. */
function polarDisc(rings, segs, colorSize) {
  const n = 1 + rings * segs;
  const t = new Float32Array(n), ang = new Float32Array(n);
  for (let i = 1; i <= rings; i++) {
    for (let j = 0; j < segs; j++) { const k = 1 + (i - 1) * segs + j; t[k] = i / rings; ang[k] = (j / segs) * TAU; }
  }
  const idx = [];
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = 1 + (i - 1) * segs + j, b = 1 + (i - 1) * segs + ((j + 1) % segs);
      idx.push(a, b, a + segs, b, b + segs, a + segs);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * colorSize).fill(1), colorSize).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  return { geometry: geo, t, ang, n };
}

// ---------------------------------------------------------------------------
// Texturas pintadas en canvas
// ---------------------------------------------------------------------------

/** Escribe `text` centrado, comprimiéndolo en horizontal si no cabe en `maxW`. */
function fitText(g, text, x, y, maxW, font, align = 'center') {
  g.font = font;
  g.textAlign = align;
  g.textBaseline = 'alphabetic';
  const w = g.measureText(text).width;
  const sx = w > maxW ? maxW / w : 1;
  g.save();
  g.translate(x, y);
  g.scale(sx, 1);
  g.fillText(text, 0, 0);
  g.restore();
}

function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Textura de grano repetible (polvo, cristales o gránulos alargados). */
function grainTexture(base, colors, { count = 2000, min = 1, max = 2, seed = 1, repeat = 3, shape = 'dot', srgb = true } = {}) {
  return makeCanvasTexture(256, 256, (g, w, h) => {
    const rnd = makeRng(seed);
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < count; i++) {
      const x = rnd() * w, y = rnd() * h, r = lerp(min, max, rnd() ** 1.5), rot = rnd() * TAU;
      const color = colors[(rnd() * colors.length) | 0];
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = x + ox * w, cy = y + oy * h;
          if (cx < -r * 3 || cx > w + r * 3 || cy < -r * 3 || cy > h + r * 3) continue;
          g.save();
          g.translate(cx, cy);
          g.rotate(rot);
          g.fillStyle = color;
          g.beginPath();
          if (shape === 'crystal') g.rect(-r, -r * 0.8, r * 2, r * 1.6);
          else if (shape === 'rod') g.ellipse(0, 0, r * 1.7, r * 0.75, 0, 0, TAU);
          else g.arc(0, 0, r, 0, TAU);
          g.fill();
          if (shape === 'crystal') { g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(-r * 0.7, -r * 0.6, r * 0.8, r * 0.45); }
          g.restore();
        }
      }
    }
  }, { repeat: [repeat, repeat], srgb });
}

/** Vetas verticales suaves (alphaMap de la cortina de harina que cae). */
function streakTexture() {
  return makeCanvasTexture(128, 256, (g, w, h) => {
    const rnd = makeRng(13);
    g.fillStyle = '#a8a8a8';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 260; i++) {
      const x = rnd() * w, y = rnd() * h, rw = 2 + rnd() * 7, rh = 8 + rnd() * 36, v = Math.round(90 + rnd() * 165);
      for (const ox of [-w, 0, w]) {
        for (const oy of [-h, 0, h]) {
          if (x + ox < -rw || x + ox > w + rw || y + oy < -rh || y + oy > h + rh) continue;
          g.save();
          g.translate(x + ox, y + oy);
          g.scale(rw, rh);
          const grd = g.createRadialGradient(0, 0, 0, 0, 0, 1);
          grd.addColorStop(0, `rgba(${v},${v},${v},0.9)`);
          grd.addColorStop(1, `rgba(${v},${v},${v},0)`);
          g.fillStyle = grd;
          g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
          g.restore();
        }
      }
    }
  }, { srgb: false, repeat: [2, 1] });
}

/** Mapa de normales de ondas suaves y repetibles (superficies de agua). */
function rippleTexture() {
  const waves = [[1, 2, 0.5], [3, -1, 1.3], [-2, 3, 2.1], [4, 1, 0.2], [-3, -4, 3.3], [5, -2, 1.1]];
  return makeCanvasTexture(128, 128, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let dx = 0, dy = 0;
        for (const [kx, ky, ph] of waves) {
          const c = Math.cos(TAU * ((kx * x) / w + (ky * y) / h) + ph) / Math.hypot(kx, ky);
          dx += kx * c; dy += ky * c;
        }
        const nx = -dx * 0.12, ny = -dy * 0.12, inv = 1 / Math.hypot(nx, ny, 1);
        const i = (y * w + x) * 4;
        img.data[i] = (nx * inv * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
        img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { repeat: [2, 2], srgb: false });
}

/** Espiga de trigo (dibujada hacia -y desde su base). */
function drawWheatEar(g, x, y, len, ang, fill = '#d6a23c', ink = '#8a5a1c') {
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.strokeStyle = ink;
  g.lineCap = 'round';
  g.lineWidth = len * 0.03;
  g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(len * 0.04, -len * 0.5, 0, -len * 0.9); g.stroke();
  const n = 6;
  for (let i = 0; i < n; i++) {
    const gy = -len * (0.42 + (i / n) * 0.5), sc = 1 - i * 0.06;
    for (const s of [-1, 1]) {
      g.save();
      g.translate(s * len * 0.05 * sc, gy);
      g.rotate(s * 0.5);
      g.beginPath(); g.ellipse(0, 0, len * 0.048 * sc, len * 0.09 * sc, 0, 0, TAU);
      g.fillStyle = fill; g.fill();
      g.lineWidth = len * 0.012; g.stroke();
      g.beginPath(); g.moveTo(0, -len * 0.08 * sc); g.lineTo(s * len * 0.05, -len * 0.26 * sc);
      g.lineWidth = len * 0.008; g.stroke();
      g.restore();
    }
  }
  g.beginPath(); g.ellipse(0, -len * 0.96, len * 0.04, len * 0.08, 0, 0, TAU);
  g.fillStyle = fill; g.fill(); g.lineWidth = len * 0.012; g.stroke();
  g.restore();
}

/** Ramita de olivo con aceitunas (centrada en x, y). */
function drawOliveBranch(g, x, y, len) {
  g.save();
  g.translate(x, y);
  g.strokeStyle = '#5a4526';
  g.lineWidth = len * 0.018;
  g.lineCap = 'round';
  g.beginPath(); g.moveTo(-len / 2, len * 0.05); g.quadraticCurveTo(0, -len * 0.12, len / 2, -len * 0.02); g.stroke();
  const greens = ['#4f6b2a', '#6d8a3a', '#3f5a22'];
  for (let i = 0; i < 9; i++) {
    const t = i / 8, px = lerp(-len / 2, len / 2, t), py = len * 0.05 * (1 - t) - len * 0.07 * Math.sin(Math.PI * t);
    const s = i % 2 ? 1 : -1;
    g.save();
    g.translate(px, py);
    g.rotate(s * 0.75 + (t - 0.5) * 0.4);
    g.beginPath(); g.ellipse(0, s * len * 0.075, len * 0.028, len * 0.08, 0, 0, TAU);
    g.fillStyle = greens[i % 3]; g.fill();
    g.restore();
  }
  for (const [ox, oy] of [[-0.12, 0.1], [0.02, 0.13], [0.16, 0.09]]) {
    g.beginPath(); g.ellipse(ox * len, oy * len, len * 0.045, len * 0.06, 0.3, 0, TAU);
    g.fillStyle = '#3b3a1c'; g.fill();
    g.beginPath(); g.ellipse(ox * len - len * 0.012, oy * len - len * 0.018, len * 0.012, len * 0.016, 0.3, 0, TAU);
    g.fillStyle = 'rgba(255,255,230,0.55)'; g.fill();
  }
  g.restore();
}

/** Pan de molde en miniatura con greñas (icono de etiqueta). */
function drawLoaf(g, x, y, w) {
  g.save();
  g.translate(x, y);
  g.fillStyle = '#b8682a';
  g.strokeStyle = '#5a2e10';
  g.lineWidth = w * 0.05;
  g.beginPath();
  g.moveTo(-w / 2, w * 0.25);
  g.bezierCurveTo(-w * 0.55, -w * 0.35, w * 0.55, -w * 0.35, w / 2, w * 0.25);
  g.closePath();
  g.fill(); g.stroke();
  g.strokeStyle = '#f2c48a';
  g.lineWidth = w * 0.045;
  for (const ox of [-0.22, 0, 0.22]) { g.beginPath(); g.moveTo((ox - 0.08) * w, -w * 0.02); g.lineTo((ox + 0.08) * w, -w * 0.12); g.stroke(); }
  g.restore();
}

/** Florecilla de cinco pétalos pintada a pincel (cerámica). */
function drawFlower(g, x, y, r, color) {
  g.fillStyle = color;
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * TAU - Math.PI / 2;
    g.beginPath(); g.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.42, r * 0.28, a, 0, TAU); g.fill();
  }
  g.beginPath(); g.arc(x, y, r * 0.22, 0, TAU); g.fillStyle = '#e8b33a'; g.fill();
}

/** Bolsa de papel kraft: fibras, vuelta del borde enharinada y etiqueta impresa. */
function paintFlourBag(m) {
  const W = 1024, H = 512;
  return makeCanvasTexture(W, H, (g) => {
    const rnd = makeRng(11);
    g.fillStyle = '#b98a59';
    g.fillRect(0, 0, W, H);
    const img = g.getImageData(0, 0, W, H), d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const n = (rnd() - 0.5) * 16 + (noise3(x * 0.06, y * 0.5, 1) - 0.5) * 20 + (noise3(x * 0.01, y * 0.02, 2) - 0.5) * 18;
        d[i] += n; d[i + 1] += n * 0.88; d[i + 2] += n * 0.7;
      }
    }
    g.putImageData(img, 0, 0);
    // vuelta del borde e interior: cara clara del papel con polvo de harina
    const yCuff = (1 - m.vCuff) * H, yRim = (1 - m.vRim) * H;
    g.fillStyle = 'rgba(222,190,146,0.6)';
    g.fillRect(0, 0, W, yCuff);
    for (let i = 0; i < 2600; i++) {
      const y = Math.pow(rnd(), 1.6) * yCuff, x = rnd() * W;
      g.fillStyle = `rgba(250,246,236,${0.25 + rnd() * 0.5})`;
      g.beginPath(); g.arc(x, y, 0.6 + rnd() * 1.8, 0, TAU); g.fill();
    }
    g.fillStyle = 'rgba(248,244,234,0.55)';
    g.fillRect(0, yRim - 3, W, 6);
    g.fillStyle = 'rgba(248,244,234,0.35)';
    g.fillRect(0, 0, W, yRim - 3);
    // costura vertical trasera y sombra del fuelle
    g.fillStyle = 'rgba(90,60,30,0.25)';
    g.fillRect(0, yCuff, 5, H - yCuff);
    g.fillRect(W - 5, yCuff, 5, H - yCuff);

    // marco en milímetros: x desde el centro de una cara, y hacia arriba desde la base (se dibuja en -y)
    const kx = W / (m.P * 1000), ky = H / (m.L * 1000);
    const face = (s, fn) => { g.save(); g.setTransform(kx, 0, 0, ky, (s / m.P) * W, (1 - m.v0) * H); fn(); g.restore(); };

    face(m.sFront, () => {
      roundRectPath(g, -47, -141, 94, 117, 5);
      g.fillStyle = '#f4ecd8'; g.fill();
      g.strokeStyle = '#a8262b'; g.lineWidth = 1.3;
      roundRectPath(g, -44, -138, 88, 111, 3.5); g.stroke();
      g.lineWidth = 0.5;
      roundRectPath(g, -42.2, -136.2, 84.4, 107.4, 2.8); g.stroke();
      g.fillStyle = '#1e3557';
      fitText(g, 'MOLINO  LA  ESPIGA', 0, -127, 66, `bold 5.4px ${SANS}`);
      g.fillStyle = '#a8262b';
      fitText(g, 'HARINA', 0, -101, 80, `900 25px ${SANS_BLACK}`);
      g.fillStyle = '#1e3557';
      fitText(g, 'DE FUERZA', 0, -88, 74, `bold 12.5px ${SERIF}`);
      // gavilla de trigo
      for (const [ang, ox] of [[-0.38, -3], [0.38, 3], [-0.14, -1], [0.14, 1], [0, 0]]) drawWheatEar(g, ox, -47, 34, ang);
      g.fillStyle = '#a8262b';
      g.fillRect(-7, -54, 14, 4);
      // banda inferior
      g.fillStyle = '#1e3557';
      g.fillRect(-42.2, -46, 84.4, 17.5);
      g.fillStyle = '#ffffff';
      fitText(g, '1 kg', 0, -32.5, 30, `900 13px ${SANS_BLACK}`);
      fitText(g, 'TRIGO', -30, -38.5, 18, `bold 4.2px ${SANS}`);
      fitText(g, '100 %', -30, -33, 18, `bold 4.2px ${SANS}`);
      fitText(g, 'ESPECIAL', 30, -38.5, 20, `bold 4.2px ${SANS}`);
      fitText(g, 'PAN', 30, -33, 18, `bold 4.2px ${SANS}`);
    });
    // laterales: texto vertical impreso en tinta roja
    for (const [s, text] of [[m.sLeft, 'HARINA DE TRIGO'], [m.sRight, 'IDEAL PARA PAN']]) {
      face(s, () => {
        g.save();
        g.translate(0, -80);
        g.rotate(-Math.PI / 2);
        g.fillStyle = 'rgba(150,34,38,0.9)';
        fitText(g, text, 0, 4, 100, `bold 11px ${SANS}`);
        g.restore();
      });
    }
    // dorso: bloque de texto
    face(0, () => {
      g.fillStyle = 'rgba(40,30,25,0.75)';
      fitText(g, 'Ingredientes: harina de trigo.', 0, -110, 80, `bold 5px ${SANS}`);
      g.fillStyle = 'rgba(40,30,25,0.45)';
      for (let i = 0; i < 9; i++) g.fillRect(-40, -100 + i * 6, 60 + ((i * 37) % 20), 1.6);
    });
  });
}

/** Marcas de medida en rojo de una jarra de vidrio (la base es vidrio casi transparente). */
function paintJugMarks(fill, uvHeight, radius) {
  return makeCanvasTexture(1024, 512, (g, w, h) => {
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(0, 0, w, h);
    const ky = h / uvHeight, kx = w / (TAU * radius), X0 = w * 0.25;
    g.fillStyle = 'rgba(200,58,36,0.95)';
    g.strokeStyle = g.fillStyle;
    g.lineCap = 'round';
    for (let ml = 50; ml <= 1000; ml += 50) {
      const y = fill.heightForVolume(ml * 1e-6);
      if (y > uvHeight * 0.95) break;
      const Y = h - y * ky, major = ml % 250 === 0;
      g.lineWidth = (major ? 0.0012 : 0.0008) * ky;
      g.beginPath();
      g.moveTo(X0 - 0.014 * kx, Y);
      g.lineTo(X0 + (major ? 0.004 : -0.004) * kx, Y);
      g.stroke();
      if (major) {
        g.save();
        g.translate(X0 + 0.008 * kx, Y + 0.0028 * ky);
        g.scale(kx / ky, 1);
        g.font = `bold ${0.0078 * ky}px ${SANS}`;
        g.textAlign = 'left';
        g.fillText(ml === 1000 ? '1 L' : String(ml), 0, 0);
        g.restore();
      }
    }
    g.save();
    g.translate(X0 - 0.007 * kx, h - (fill.heightForVolume(0.00102) + 0.004) * ky);
    g.scale(kx / ky, 1);
    g.font = `bold ${0.007 * ky}px ${SANS}`;
    g.textAlign = 'center';
    g.fillText('ml', 0, 0);
    g.restore();
  });
}

/** Etiqueta envolvente del tarro de levadura (u = vuelta completa, frente en u = 0.5). */
function paintYeastLabel(radius, height) {
  const C = TAU * radius * 1000, LH = height * 1000;
  return makeCanvasTexture(1024, 256, (g, w, h) => {
    const kx = w / C, ky = h / LH;
    g.fillStyle = '#f2bb2a';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#b8231d';
    g.fillRect(0, 0, w, 3.4 * ky);
    g.fillRect(0, h - 3.4 * ky, w, 3.4 * ky);
    g.fillStyle = '#fff3d0';
    g.fillRect(0, 3.4 * ky, w, 0.7 * ky);
    g.fillRect(0, h - 4.1 * ky, w, 0.7 * ky);
    g.setTransform(kx, 0, 0, ky, w / 2, h / 2);
    g.fillStyle = '#4a2810';
    fitText(g, 'de panadería', 0, -8.6, 40, `italic bold 5px ${SERIF}`);
    g.fillStyle = '#b8231d';
    fitText(g, 'LEVADURA', 0, 4.6, 52, `900 13px ${SANS_BLACK}`);
    g.fillStyle = '#4a2810';
    fitText(g, 'SECA', 0, 12.2, 34, `900 7px ${SANS_BLACK}`);
    drawLoaf(g, -42, 3, 20);
    drawWheatEar(g, 40, 10, 22, 0.25);
    drawWheatEar(g, 46, 10, 22, -0.1);
    fitText(g, '100 g', -70, 2, 20, `bold 6px ${SANS}`);
    fitText(g, 'Activa en 10 min', 72, 2, 30, `bold 4px ${SANS}`);
  });
}

/** Esmalte del salero: blanco roto, pie sin esmaltar, bandas azul cobalto, "SAL" y florecillas. */
function paintSaltPot(radius, uvHeight) {
  const C = TAU * radius * 1000;
  return makeCanvasTexture(1024, 256, (g, w, h) => {
    const rnd = makeRng(21);
    const kx = w / C, ky = h / (uvHeight * 1000);
    const Y = (mm) => h - mm * ky;
    g.fillStyle = '#f6f2ea';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) {
      g.fillStyle = `rgba(120,90,60,${0.06 + rnd() * 0.12})`;
      g.beginPath(); g.arc(rnd() * w, rnd() * h, 0.5 + rnd(), 0, TAU); g.fill();
    }
    g.fillStyle = '#cfae86';
    g.fillRect(0, Y(6), w, h - Y(6));
    const cobalt = '#1f4c9e';
    const band = (y0, y1, wob) => {
      g.beginPath();
      for (let x = 0; x <= w; x += 8) g.lineTo(x, Y(y1 + Math.sin(x * 0.05) * wob));
      for (let x = w; x >= 0; x -= 8) g.lineTo(x, Y(y0 + Math.sin(x * 0.07 + 1) * wob));
      g.closePath();
      g.fill();
    };
    g.fillStyle = cobalt;
    band(57, 63, 0.35);
    band(52.2, 53.2, 0.2);
    band(9.5, 13.5, 0.3);
    band(15.6, 16.4, 0.2);
    g.setTransform(kx, 0, 0, ky, w / 2, Y(0));
    g.fillStyle = cobalt;
    const letters = ['S', 'A', 'L'];
    letters.forEach((c, i) => fitText(g, c, (i - 1) * 15.5, -26, 20, `bold 23px ${SERIF}`));
    for (const x of [-34, 34, -62, 62, -92, 92, 118]) {
      drawFlower(g, x, -36, 5.2, cobalt);
      g.fillStyle = '#3f7a3a';
      for (const s of [-1, 1]) { g.beginPath(); g.ellipse(x + s * 5.5, -30, 3.2, 1.3, s * 0.5, 0, TAU); g.fill(); }
    }
    for (let x = -120; x < 120; x += 9) { g.fillStyle = cobalt; g.beginPath(); g.arc(x, -21, 0.9, 0, TAU); g.fill(); }
    // franja superior lisa: el interior del salero mapea aquí
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f6f2ea';
    g.fillRect(0, 0, w, 4);
  });
}

/** Etiqueta de papel antigua con esquinas recortadas para el tarro de azúcar. */
function paintSugarLabel(widthMm, heightMm) {
  return makeCanvasTexture(512, 256, (g, w, h) => {
    const kx = w / widthMm, ky = h / heightMm;
    g.setTransform(kx, 0, 0, ky, w / 2, h / 2);
    const shape = (a, b, c) => {
      g.beginPath();
      g.moveTo(-a + c, -b);
      g.lineTo(a - c, -b);
      g.arc(a, -b, c, Math.PI, Math.PI / 2, true);
      g.lineTo(a, b - c);
      g.arc(a, b, c, -Math.PI / 2, Math.PI, true);
      g.lineTo(-a + c, b);
      g.arc(-a, b, c, 0, -Math.PI / 2, true);
      g.lineTo(-a, -b + c);
      g.arc(-a, -b, c, Math.PI / 2, 0, true);
      g.closePath();
    };
    const a = widthMm / 2 - 1, b = heightMm / 2 - 1;
    shape(a, b, 5);
    g.fillStyle = '#f6eed6';
    g.fill();
    g.strokeStyle = '#2f3b2b';
    g.lineWidth = 0.9;
    shape(a - 2.2, b - 2.2, 4);
    g.stroke();
    g.lineWidth = 0.35;
    shape(a - 3.4, b - 3.4, 3.4);
    g.stroke();
    g.fillStyle = '#2b2b2b';
    fitText(g, 'AZÚCAR', 0, 4.2, 48, `bold 12.5px ${SERIF}`);
    g.strokeStyle = '#8a6b2a';
    g.lineWidth = 0.6;
    for (const s of [-1, 1]) {
      g.beginPath(); g.moveTo(s * 6, -9.5); g.quadraticCurveTo(s * 15, -12.5, s * 24, -9.5); g.stroke();
    }
    g.beginPath(); g.arc(0, -9.8, 1.1, 0, TAU); g.fillStyle = '#8a6b2a'; g.fill();
    g.fillStyle = '#4a4a40';
    fitText(g, 'blanquilla · 500 g', 0, 11.5, 40, `italic 4.6px ${SERIF}`);
  });
}

/** Etiqueta de la botella de aceite (parte alta del lienzo) y collarín del cuello (parte baja). */
function paintOilLabel(widthMm, heightMm) {
  return makeCanvasTexture(512, 1024, (g, w, h) => {
    const mainH = h * 0.7, kx = w / widthMm, ky = mainH / heightMm;
    g.fillStyle = '#f2e8cc';
    g.fillRect(0, 0, w, mainH);
    g.setTransform(kx, 0, 0, ky, w / 2, mainH / 2);
    const a = widthMm / 2, b = heightMm / 2;
    g.strokeStyle = '#33481c';
    g.lineWidth = 1.2;
    g.strokeRect(-a + 4, -b + 3, 2 * a - 8, 2 * b - 6);
    g.lineWidth = 0.4;
    g.strokeRect(-a + 5.6, -b + 4.6, 2 * a - 11.2, 2 * b - 9.2);
    drawOliveBranch(g, 0, -31, 40);
    g.fillStyle = '#2f4a1b';
    fitText(g, 'ACEITE', 0, -9, 46, `bold 13px ${SERIF}`);
    fitText(g, 'DE OLIVA', 0, 1.5, 46, `bold 8.2px ${SERIF}`);
    g.fillStyle = '#c9a23a';
    g.fillRect(-26, 6.5, 52, 9.5);
    g.fillStyle = '#ffffff';
    fitText(g, 'VIRGEN EXTRA', 0, 13.3, 46, `900 5.8px ${SANS_BLACK}`);
    g.fillStyle = '#4a4a32';
    fitText(g, 'Primera presión en frío', 0, 24, 46, `italic 4.2px ${SERIF}`);
    g.fillStyle = '#2f4a1b';
    fitText(g, '500 ml', 0, 37, 30, `bold 5px ${SANS}`);
    // collarín
    g.setTransform(1, 0, 0, 1, 0, 0);
    const y0 = h * 0.75;
    g.fillStyle = '#2d4a1e';
    g.fillRect(0, y0, w, h - y0);
    g.fillStyle = '#d4b04a';
    g.fillRect(0, y0 + (h - y0) * 0.18, w, (h - y0) * 0.07);
    g.fillRect(0, y0 + (h - y0) * 0.75, w, (h - y0) * 0.07);
  });
}

/** Texturas y geometrías compartidas por todos los recipientes y el bol. */
function makeShared() {
  return {
    sprite: makeCanvasTexture(64, 64, (g, w, h) => {
      const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.45, 'rgba(255,255,255,0.85)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }),
    flour: grainTexture('#f3eee3', ['#e8e0cf', '#fbf8f1', '#ddd2bd', '#cdb996'], { count: 2600, min: 0.5, max: 1.6, seed: 3 }),
    flourBump: grainTexture('#808080', ['#5a5a5a', '#9c9c9c', '#b8b8b8', '#707070'], { count: 1400, min: 1.5, max: 5, seed: 4, srgb: false }),
    yeast: grainTexture('#b58a52', ['#8f6534', '#d2a86c', '#a37744', '#e0bd85', '#6f4a24'], { count: 3400, min: 1, max: 2.4, seed: 5, repeat: 2, shape: 'rod' }),
    sugar: grainTexture('#e9e5dc', ['#ffffff', '#d6d1c6', '#f8f6f1', '#c4beb2'], { count: 3800, min: 0.8, max: 1.9, seed: 7, repeat: 2, shape: 'crystal' }),
    salt: grainTexture('#d9dcdc', ['#ffffff', '#c8cccd', '#f1f3f3', '#b3b8ba'], { count: 1000, min: 2.6, max: 5.4, seed: 9, repeat: 1.5, shape: 'crystal' }),
    ripple: rippleTexture(),
    contact: makeCanvasTexture(128, 128, (g, w, h) => {
      const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      grd.addColorStop(0, 'rgba(30,20,10,0.75)');
      grd.addColorStop(0.55, 'rgba(30,20,10,0.35)');
      grd.addColorStop(1, 'rgba(30,20,10,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, w, h);
    }),
    spill: makeCanvasTexture(256, 128, (g, w, h) => {
      const rnd = makeRng(31);
      for (let i = 0; i < 900; i++) {
        const x = w * (0.5 + (rnd() - 0.5) * rnd() * 1.0), y = h * (0.5 + (rnd() - 0.5) * rnd() * 1.0);
        g.fillStyle = `rgba(250,247,240,${0.08 + rnd() * 0.35})`;
        g.beginPath(); g.arc(x, y, 0.6 + rnd() * 2.6, 0, TAU); g.fill();
      }
    }),
    disc: new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2),
    ring: new THREE.RingGeometry(0.72, 1, 36).rotateX(-Math.PI / 2),
  };
}

// ---------------------------------------------------------------------------
// Contenido de un recipiente: volumen recortado por un plano horizontal (nivel real al inclinar)
// ---------------------------------------------------------------------------
class Fill {
  /**
   * @param {THREE.Vector2[]} inner perfil interior (r, y) de abajo arriba
   * @param {{volumeMaterial?: THREE.Material, surfaceMaterial?: THREE.Material, parent: THREE.Object3D, disc: THREE.BufferGeometry, margin?: number}} opts
   */
  constructor(inner, { volumeMaterial = null, surfaceMaterial = null, parent, disc, margin = 0.0012 }) {
    const prof = inner.map((p) => v2(Math.max(0, p.x - margin), p.y));
    prof[0].y += margin * 0.5;
    this.prof = prof;
    this.y0 = prof[0].y;
    this.y1 = prof[prof.length - 1].y;
    // volumen acumulado cada 0.5 mm
    const steps = Math.max(8, Math.ceil((this.y1 - this.y0) / 0.0005));
    this.dy = (this.y1 - this.y0) / steps;
    this.cum = new Float32Array(steps + 1);
    for (let i = 1; i <= steps; i++) {
      const r = this.radiusAt(this.y0 + (i - 0.5) * this.dy);
      this.cum[i] = this.cum[i - 1] + Math.PI * r * r * this.dy;
    }
    this.volume = this.cum[steps];
    // muestras equiprobables del volumen interior (para el nivel con el recipiente inclinado)
    const xs = [], ys = [], zs = [], slices = 30, N = 420;
    for (let i = 0; i < slices; i++) {
      const ya = this.y0 + ((this.y1 - this.y0) * i) / slices, yb = ya + (this.y1 - this.y0) / slices;
      const n = Math.max(1, Math.round((N * (this.volumeBelow(yb) - this.volumeBelow(ya))) / this.volume));
      for (let k = 0; k < n; k++) {
        const y = ya + (yb - ya) * ((k * 0.618034 + i * 0.37) % 1);
        const rr = this.radiusAt(y) * Math.sqrt((k + 0.5) / n), ang = k * 2.39996 + i;
        xs.push(Math.cos(ang) * rr); ys.push(y); zs.push(Math.sin(ang) * rr);
      }
    }
    this.sx = Float32Array.from(xs); this.sy = Float32Array.from(ys); this.sz = Float32Array.from(zs);
    this.tmp = new Float32Array(xs.length);
    // plano de recorte en mundo: se conserva lo que queda por debajo del nivel
    this.plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 10);
    if (volumeMaterial) {
      volumeMaterial.clippingPlanes = [this.plane];
      volumeMaterial.clipShadows = true;
      const pts = [v2(0, this.y0), ...prof.filter((p) => p.x > 0), v2(0, this.y1)];
      this.mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 40), volumeMaterial);
      parent.add(this.mesh);
    }
    if (surfaceMaterial) {
      // la superficie vive dentro del recipiente, pero su matriz se calcula horizontal en mundo;
      // la recortan el fondo y la boca para que la elipse no se salga al inclinar mucho
      this.base = new THREE.Plane();
      this.top = new THREE.Plane();
      surfaceMaterial.clippingPlanes = [this.base, this.top];
      this.surface = new THREE.Mesh(disc, surfaceMaterial);
      this.surface.matrixAutoUpdate = false;
      parent.add(this.surface);
    }
    this.m = new THREE.Matrix4();
    this.inv = new THREE.Matrix4();
    this.p = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.s = new THREE.Vector3();
  }

  /** Radio interior (con margen) a la altura local y. */
  radiusAt(y) {
    const p = this.prof;
    for (let i = p.length - 2; i >= 0; i--) {
      const a = p[i], b = p[i + 1];
      if (b.y > a.y && y >= a.y && y <= b.y) return lerp(a.x, b.x, (y - a.y) / (b.y - a.y));
    }
    return y <= this.y0 ? p[1]?.x ?? 0 : p[p.length - 1].x;
  }

  volumeBelow(y) {
    const f = clamp((y - this.y0) / this.dy, 0, this.cum.length - 1), i = Math.floor(f);
    return i >= this.cum.length - 1 ? this.cum[i] : lerp(this.cum[i], this.cum[i + 1], f - i);
  }

  /** Altura local del nivel con el recipiente recto para un volumen (m³). */
  heightForVolume(vol) {
    const c = this.cum;
    if (vol <= 0) return this.y0;
    if (vol >= this.volume) return this.y1;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] < vol) lo = m; else hi = m; }
    return this.y0 + (lo + (vol - c[lo]) / Math.max(1e-12, c[hi] - c[lo])) * this.dy;
  }

  /** Cuantil `f` de los valores de this.tmp (ya rellenados). */
  quantile(f) {
    const t = this.tmp;
    t.sort();
    const x = clamp(f) * (t.length - 1), i = Math.floor(x);
    return i >= t.length - 1 ? t[t.length - 1] : lerp(t[i], t[i + 1], x - i);
  }

  /** Inclinación (rad, hacia +X local) a la que el contenido llega a la boca `spout`. */
  onsetTilt(spout, f) {
    let lo = 0, hi = Math.PI * 0.92;
    for (let it = 0; it < 18; it++) {
      const m = (lo + hi) / 2, c = Math.cos(m), s = Math.sin(m);
      for (let i = 0; i < this.tmp.length; i++) this.tmp[i] = -s * this.sx[i] + c * this.sy[i];
      if (this.quantile(f) >= -s * spout.x + c * spout.y) hi = m; else lo = m;
    }
    return hi;
  }

  /**
   * Coloca el plano de recorte y la superficie para la pose actual del recipiente.
   * @param {THREE.Object3D} object recipiente (matrixWorld al día)
   * @param {number} f fracción de llenado 0..1
   * @param {number} maxY nivel máximo en mundo (la boca: lo que sobra se está vertiendo)
   */
  update(object, f, maxY) {
    const e = object.matrixWorld.elements;
    const ux = e[4], uy = e[5], uz = e[6], ox = e[12], oy = e[13], oz = e[14];
    let level = oy + uy * this.heightForVolume(f * this.volume);
    const k = smoothstep(0, 0.05, 1 - uy);
    if (k > 0) {
      for (let i = 0; i < this.tmp.length; i++) this.tmp[i] = e[1] * this.sx[i] + e[5] * this.sy[i] + e[9] * this.sz[i] + e[13];
      level = lerp(level, this.quantile(f), k);
    }
    level = Math.min(level, maxY);
    this.plane.constant = level;
    const has = f > 0.003;
    if (this.mesh) this.mesh.visible = has;
    if (!this.surface) return;
    let show = has && uy > 0.3;
    if (show) {
      const t = (level - oy) / uy;
      show = t > this.y0 + 0.0008 && t < this.y1;
      if (show) {
        // elipse: el corte horizontal de un cilindro inclinado se alarga 1/cos en la dirección de la inclinación
        const r = this.radiusAt(t) - 0.0004;
        this.s.set(ux, uy, uz);
        this.base.setFromNormalAndCoplanarPoint(this.s, this.p.set(ox + ux * this.y0, oy + uy * this.y0, oz + uz * this.y0));
        this.top.setFromNormalAndCoplanarPoint(this.s.negate(), this.p.set(ox + ux * this.y1, oy + uy * this.y1, oz + uz * this.y1));
        this.m.compose(this.p.set(ox + ux * t, level, oz + uz * t), this.q.setFromAxisAngle(UP, Math.atan2(ux, uz)), this.s.set(r, 1, r / uy));
        this.surface.matrix.multiplyMatrices(this.inv.copy(object.matrixWorld).invert(), this.m);
      }
    }
    this.surface.visible = show;
  }
}

// ---------------------------------------------------------------------------
// Chorros: partículas para polvos y granos, tubo afilado para líquidos
// ---------------------------------------------------------------------------

/** Conjunto de partículas compacto (las vivas al principio del búfer). */
function makePool(parent, sprite, max, size, renderOrder) {
  const pos = new Float32Array(max * 3), col = new Float32Array(max * 4);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  const mat = new THREE.PointsMaterial({ size, map: sprite, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: true });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = renderOrder;
  points.raycast = () => {};
  parent.add(points);
  return {
    points, pos, col, max, n: 0,
    vel: new Float32Array(max * 3), rgb: new Float32Array(max * 3),
    age: new Float32Array(max), life: new Float32Array(max), alpha: new Float32Array(max), grav: new Float32Array(max),
  };
}

function spawn(p, x, y, z, vx, vy, vz, life, c, a, grav) {
  if (p.n >= p.max) return;
  const i = p.n++;
  p.pos[i * 3] = x; p.pos[i * 3 + 1] = y; p.pos[i * 3 + 2] = z;
  p.vel[i * 3] = vx; p.vel[i * 3 + 1] = vy; p.vel[i * 3 + 2] = vz;
  p.rgb[i * 3] = c.r; p.rgb[i * 3 + 1] = c.g; p.rgb[i * 3 + 2] = c.b;
  p.age[i] = 0; p.life[i] = life; p.alpha[i] = a; p.grav[i] = grav;
}

function kill(p, i) {
  const j = --p.n;
  if (i === j) return;
  for (let k = 0; k < 3; k++) { p.pos[i * 3 + k] = p.pos[j * 3 + k]; p.vel[i * 3 + k] = p.vel[j * 3 + k]; p.rgb[i * 3 + k] = p.rgb[j * 3 + k]; }
  p.age[i] = p.age[j]; p.life[i] = p.life[j]; p.alpha[i] = p.alpha[j]; p.grav[i] = p.grav[j];
}

/**
 * Avanza un conjunto de partículas. `land(i)` se llama al cruzar `landY` y devuelve true para
 * eliminarla. `fade(i, k)` da el alfa relativo según la edad normalizada k.
 */
function stepPool(p, dt, drag, landY, land, fade) {
  const dragK = Math.max(0, 1 - drag * dt);
  for (let i = p.n - 1; i >= 0; i--) {
    p.age[i] += dt;
    if (p.age[i] >= p.life[i]) { kill(p, i); continue; }
    const o = i * 3;
    p.vel[o + 1] -= GRAVITY * p.grav[i] * dt;
    p.vel[o] *= dragK; p.vel[o + 2] *= dragK;
    if (p.grav[i] < 0.2) p.vel[o + 1] *= dragK;
    p.pos[o] += p.vel[o] * dt; p.pos[o + 1] += p.vel[o + 1] * dt; p.pos[o + 2] += p.vel[o + 2] * dt;
    if (p.vel[o + 1] < 0 && p.pos[o + 1] < landY && land(i)) kill(p, i);
  }
  for (let i = 0; i < p.n; i++) {
    const a = p.alpha[i] * fade(i, p.age[i] / p.life[i]);
    p.col[i * 4] = p.rgb[i * 3]; p.col[i * 4 + 1] = p.rgb[i * 3 + 1]; p.col[i * 4 + 2] = p.rgb[i * 3 + 2]; p.col[i * 4 + 3] = a;
  }
  const geo = p.points.geometry;
  geo.setDrawRange(0, p.n);
  geo.attributes.position.needsUpdate = true;
  geo.attributes.color.needsUpdate = true;
}

/** Chorro de polvo o de granos: partículas con gravedad, neblina y polvareda al caer. */
class PowderStream {
  constructor(parent, sprite, opt) {
    this.o = opt;
    this.grains = makePool(parent, sprite, opt.max, opt.size, 6);
    this.dust = opt.dust ? makePool(parent, sprite, opt.dust.max, opt.dust.size, 7) : null;
    this.base = new THREE.Color(opt.color);
    this.dustColor = new THREE.Color(opt.dust?.color ?? 0xffffff);
    this.c = new THREE.Color();
    this.acc = 0;
    this.dustAcc = 0;
    this.rnd = makeRng(opt.seed ?? 7);
    this.time = 0;
    this.landY = 0;
    // al tocar fondo: algunos granos levantan polvo
    this.onGrainLand = (i) => {
      if (this.dust && this.rnd() < (opt.dust?.landProb ?? 0)) this.puffAt(this.grains.pos[i * 3], this.landY, this.grains.pos[i * 3 + 2], 1);
      return true;
    };
    // la neblina que cae se convierte en nube al tocar fondo
    this.onDustLand = (i) => {
      const d = this.dust, r = this.rnd, a = r() * TAU, sp = 0.05 + r() * 0.1;
      d.pos[i * 3 + 1] = this.landY + 0.003;
      d.vel[i * 3] = Math.cos(a) * sp; d.vel[i * 3 + 1] = 0.03 + r() * 0.04; d.vel[i * 3 + 2] = Math.sin(a) * sp;
      d.grav[i] = -0.012; d.age[i] = 0; d.life[i] = 0.6 + r() * 0.6;
      return false;
    };
    this.fadeGrain = opt.twinkle
      ? (i, k) => (0.5 + 0.5 * Math.sin(this.time * 40 + i * 1.7)) * Math.min(1, k * 40)
      : (i, k) => Math.min(1, k * 40);
    this.fadeDust = (i, k) => Math.min(1, k * 8) * (1 - k * k);
  }

  /** true cuando no queda ninguna partícula en el aire. */
  get idle() { return this.grains.n === 0 && (!this.dust || this.dust.n === 0); }

  /** Nube de polvo al llegar al bol. */
  puffAt(x, y, z, n) {
    const d = this.dust, r = this.rnd;
    for (let k = 0; k < n; k++) {
      const a = r() * TAU, sp = 0.05 + r() * 0.12;
      spawn(d, x + (r() - 0.5) * 0.02, y + 0.004, z + (r() - 0.5) * 0.02, Math.cos(a) * sp, 0.02 + r() * 0.06, Math.sin(a) * sp,
        0.7 + r() * 0.7, this.dustColor, this.o.dust.alpha * (0.6 + r() * 0.6), -0.012);
    }
  }

  /**
   * @param {number} dt
   * @param {{flow:number, origin:THREE.Vector3, dir:THREE.Vector3, axis:THREE.Vector3, landY:number}} s
   */
  update(dt, { flow, origin, dir, axis, landY }) {
    const o = this.o, r = this.rnd, g = this.grains;
    this.time += dt;
    this.acc += o.rate * flow * dt;
    while (this.acc >= 1) {
      this.acc -= 1;
      const w = (r() - 0.5) * o.width, sp = o.speed * (0.6 + 0.8 * r()), k = 1 + (r() - 0.5) * 2 * o.jitter;
      this.c.copy(this.base).multiplyScalar(k);
      spawn(g, origin.x + axis.x * w, origin.y + axis.y * w, origin.z + axis.z * w,
        dir.x * sp + (r() - 0.5) * o.spread, -r() * 0.05, dir.z * sp + (r() - 0.5) * o.spread, 2, this.c, 1, 1);
    }
    if (this.dust) {
      // neblina que acompaña al chorro y se queda algo atrás
      this.dustAcc += o.dust.rate * flow * dt;
      while (this.dustAcc >= 1) {
        this.dustAcc -= 1;
        const w = (r() - 0.5) * o.width * 0.8;
        spawn(this.dust, origin.x + axis.x * w, origin.y - r() * 0.02, origin.z + axis.z * w,
          dir.x * o.speed * 0.6 + (r() - 0.5) * 0.04, -0.05, dir.z * o.speed * 0.6 + (r() - 0.5) * 0.04, 1.2, this.dustColor, o.dust.alpha * 0.7, 0.55);
      }
    }
    this.landY = landY;
    stepPool(g, dt, 0.4, landY, this.onGrainLand, this.fadeGrain);
    if (this.dust) stepPool(this.dust, dt, 2.2, landY, this.onDustLand, this.fadeDust);
  }

  reset() {
    this.grains.n = 0;
    this.grains.points.geometry.setDrawRange(0, 0);
    if (this.dust) { this.dust.n = 0; this.dust.points.geometry.setDrawRange(0, 0); }
    this.acc = this.dustAcc = 0;
  }
}

/**
 * Chorro continuo: tubo que sigue la parábola de caída y se afila al acelerar, con temblor.
 * Sirve para líquidos (redondo y brillante, con ondas y gotas al caer) y para la harina
 * (cortina ancha y mate, con vetas que bajan con el flujo).
 */
class TubeStream {
  /**
   * @param {{material: THREE.Material, radius: number, width?: number, keep?: number, speed: [number, number],
   *   rings?: number|null, droplets?: boolean, flowScroll?: number}} opt
   *   width: ensanchamiento lateral en la boca; keep: cuánto conserva el grosor al caer (0 = líquido);
   *   rings: color de las ondas al caer en agua; flowScroll: escala de las vetas de la textura.
   */
  constructor(parent, shared, { material, radius, width = 1, keep = 0, speed, rings = null, droplets = false, flowScroll = 0 }) {
    this.M = 28; this.K = 12;
    const n = this.M * this.K;
    this.posArr = new Float32Array(n * 3);
    this.nrmArr = new Float32Array(n * 3);
    this.uvArr = new Float32Array(n * 2);
    const idx = [];
    for (let i = 0; i < this.M - 1; i++) {
      for (let k = 0; k < this.K; k++) {
        const a = i * this.K + k, b = i * this.K + ((k + 1) % this.K), d = a + this.K, c = b + this.K;
        idx.push(a, b, d, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.BufferAttribute(this.nrmArr, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('uv', new THREE.BufferAttribute(this.uvArr, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
    this.mesh.raycast = () => {};
    parent.add(this.mesh);
    this.opt = { radius, width, keep, speed, flowScroll };
    this.scrollMap = material.alphaMap ?? null;
    if (rings !== null) {
      // ondas en el agua donde cae (aditivas: el negro no se ve)
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
      this.rings = new THREE.InstancedMesh(shared.ring, ringMat, 5);
      this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.rings.frustumCulled = false;
      this.rings.renderOrder = 4;
      this.rings.raycast = () => {};
      this.ringState = Array.from({ length: 5 }, () => ({ age: 9, x: 0, y: 0, z: 0 }));
      this.ringColor = new THREE.Color(rings);
      this.tc = new THREE.Color(0);
      for (let i = 0; i < 5; i++) this.rings.setColorAt(i, this.tc);
      parent.add(this.rings);
    }
    this.drops = droplets ? makePool(parent, shared.sprite, 70, 0.007, 6) : null;
    this.dropColor = new THREE.Color(0xe4f3fa);
    this.dropLand = () => true;
    this.dropFade = () => 1;
    this.rnd = makeRng(19);
    this.origin = new THREE.Vector3();
    this.dir = new THREE.Vector3(1, 0, 0);
    this.state = { on: false, head: 0, tail: 0, vis: 0, v0: speed[0], ringTimer: 0, dropAcc: 0 };
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.sc = new THREE.Vector3();
    this.p = new THREE.Vector3();
  }

  /**
   * @param {number} dt
   * @param {{flow:number, origin:THREE.Vector3, dir:THREE.Vector3, landY:number, wet:boolean, time:number}} s
   */
  update(dt, { flow, origin, dir, landY, wet, time }) {
    const st = this.state, o = this.opt;
    if (flow > 0.02) {
      if (!st.on || st.tail > 0) { st.head = 0; st.tail = 0; }
      st.on = true;
      st.head += dt;
      st.v0 = lerp(o.speed[0], o.speed[1], flow);
      this.origin.copy(origin);
      this.dir.copy(dir);
      st.vis = damp(st.vis, flow, 10, dt);
    } else if (st.on) {
      st.tail += dt; // el chorro se despega de la boca y cae
      st.head += dt;
    }
    const tLand = Math.sqrt((2 * Math.max(0, this.origin.y - landY)) / GRAVITY);
    const ta = st.tail, tb = Math.min(st.head, tLand);
    if (st.on && ta >= tLand) st.on = false;
    this.mesh.visible = st.on && tb - ta > 0.004 && st.vis > 0.01;
    if (this.mesh.visible) this.buildTube(ta, tb, tLand, time);
    if (this.scrollMap) this.scrollMap.offset.y = -time * o.flowScroll * 0.9;

    // salpicaduras mientras el chorro toca la superficie
    const touching = st.on && st.head >= tLand && st.tail < tLand && flow > 0.02 && wet;
    const lx = this.origin.x + this.dir.x * st.v0 * tLand, lz = this.origin.z + this.dir.z * st.v0 * tLand;
    if (this.rings) {
      if (touching) {
        st.ringTimer -= dt;
        if (st.ringTimer <= 0) {
          st.ringTimer = 0.17;
          const ring = this.ringState.reduce((a, b) => (b.age > a.age ? b : a));
          ring.age = 0; ring.x = lx + (this.rnd() - 0.5) * 0.006; ring.y = landY + 0.0015; ring.z = lz + (this.rnd() - 0.5) * 0.006;
        }
      }
      for (let i = 0; i < 5; i++) {
        const r = this.ringState[i];
        r.age += dt;
        const k = clamp(r.age / 0.75), sz = lerp(0.006, 0.05, 1 - (1 - k) * (1 - k));
        this.m.compose(this.p.set(r.x, r.y, r.z), this.q, this.sc.set(sz, 1, sz));
        this.rings.setMatrixAt(i, this.m);
        this.rings.setColorAt(i, this.tc.copy(this.ringColor).multiplyScalar(k < 1 ? (1 - k) * 0.8 : 0));
      }
      this.rings.instanceMatrix.needsUpdate = true;
      this.rings.instanceColor.needsUpdate = true;
    }
    if (this.drops) {
      if (touching) {
        st.dropAcc += 45 * st.vis * dt;
        while (st.dropAcc >= 1) {
          st.dropAcc -= 1;
          const a = this.rnd() * TAU, sp = 0.08 + this.rnd() * 0.22;
          spawn(this.drops, lx, landY + 0.003, lz, Math.cos(a) * sp, 0.35 + this.rnd() * 0.45, Math.sin(a) * sp, 0.8, this.dropColor, 0.9, 1);
        }
      }
      stepPool(this.drops, dt, 0.2, landY, this.dropLand, this.dropFade);
    }
  }

  /** true cuando no hay chorro, ondas ni gotas activas. */
  get idle() {
    return !this.state.on && (!this.drops || this.drops.n === 0) && (!this.rings || this.ringState.every((r) => r.age > 0.75));
  }

  /** Recalcula el tubo entre los tiempos de caída ta y tb (parábola desde la boca). */
  buildTube(ta, tb, tLand, time) {
    const { M, K, posArr, nrmArr, uvArr, origin: o, dir: d, opt } = this;
    const v0 = this.state.v0, vis = Math.sqrt(this.state.vis), vRef = Math.max(v0, 0.22);
    const sx = -d.z, sz = d.x;                         // lateral (horizontal, perpendicular a la caída)
    for (let i = 0; i < M; i++) {
      const tau = ta + (tb - ta) * Math.pow(i / (M - 1), 1.25);
      const fall = tau / Math.max(0.01, tLand);
      let cx = o.x + d.x * v0 * tau, cy = o.y - 0.5 * GRAVITY * tau * tau, cz = o.z + d.z * v0 * tau;
      const vx = d.x * v0, vy = -GRAVITY * tau, vz = d.z * v0;
      const sp = Math.hypot(vx, vy, vz) || 1;
      const tx = vx / sp, ty = vy / sp, tz = vz / sp;
      // b = t × s (perpendicular a la tangente y al lateral)
      let bx = ty * sz, by = tz * sx - tx * sz, bz = -ty * sx;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      const wob1 = Math.sin(time * 29 - tau * 60) * 0.0011 * fall, wob2 = Math.sin(time * 21 + tau * 45) * 0.0008 * fall;
      cx += sx * wob1 + bx * wob2; cy += by * wob2; cz += sz * wob1 + bz * wob2;
      // continuidad: sección ∝ 1/velocidad; ligeras "perlas" abajo
      const taper = Math.sqrt(Math.min(1, vRef / sp)) * vis * (1 + 0.16 * Math.sin(time * 45 - tau * 150) * fall * fall);
      const rs = opt.radius * opt.width * taper, rb = opt.radius * lerp(taper, vis, opt.keep);
      for (let k = 0; k < K; k++) {
        const a = (k / K) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        let nx = (ca / rs) * sx + (sa / rb) * bx, ny = (sa / rb) * by, nz = (ca / rs) * sz + (sa / rb) * bz;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const j = (i * K + k) * 3;
        posArr[j] = cx + (ca * rs * sx + sa * rb * bx);
        posArr[j + 1] = cy + sa * rb * by;
        posArr[j + 2] = cz + (ca * rs * sz + sa * rb * bz);
        nrmArr[j] = nx; nrmArr[j + 1] = ny; nrmArr[j + 2] = nz;
        uvArr[(i * K + k) * 2] = k / K;
        uvArr[(i * K + k) * 2 + 1] = tau * opt.flowScroll;
      }
    }
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
  }

  reset() {
    Object.assign(this.state, { on: false, head: 0, tail: 0, vis: 0, ringTimer: 0, dropAcc: 0 });
    this.mesh.visible = false;
    if (this.rings) for (const r of this.ringState) r.age = 9;
    if (this.drops) { this.drops.n = 0; this.drops.points.geometry.setDrawRange(0, 0); }
  }
}

// ---------------------------------------------------------------------------
// Recipientes (origen = centro de la base, etiqueta hacia +Z, boca de vertido hacia +X)
// ---------------------------------------------------------------------------
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Puntos de control para la holgura sobre el bol: dos anillos (base y boca). */
function ringBounds(r0, r1, h, n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push(V(Math.cos(a) * r0, 0, Math.sin(a) * r0), V(Math.cos(a) * r1, h, Math.sin(a) * r1));
  }
  return out;
}

function flourMaterial(shared) {
  return new THREE.MeshPhysicalMaterial({
    color: 0xffffff, map: shared.flour, bumpMap: shared.flourBump, bumpScale: 1, roughness: 0.96,
    sheen: 0.5, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xfff6e6),
  });
}

/** Cortina de polvo: mate, con vetas que bajan y bordes difuminados (alfa según el ángulo de visión). */
function powderColumnMaterial(color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, transparent: true, depthWrite: false, alphaMap: streakTexture() });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float powderFacing = smoothstep(0.0, 0.75, abs(dot(normalize(vViewPosition), normal)));
      diffuseColor.a *= 0.5 + 0.5 * powderFacing;
      outgoingLight *= 0.86 + 0.14 * powderFacing;
      #include <opaque_fragment>`);
  };
  return mat;
}

/** Material de grano para el contenido de un tarro (volumen recortado o superficie). */
function grainMaterial(map, { roughness = 0.9, bumpScale = 2, side = THREE.FrontSide } = {}) {
  return new THREE.MeshStandardMaterial({ map, bumpMap: map, bumpScale, roughness, side });
}

/** Bolsa de papel kraft de 1 kg, abierta y con el borde enrollado hacia fuera. */
function buildFlourBag(shared, env) {
  const a = 0.0625, b = 0.04, rc = 0.013, Hc = 0.15, H = 0.188;
  const { pts: path, P, sFront, sLeft, sRight } = roundedRectPath(a, b, rc, 128);
  const R = P / TAU;
  // perfil del barrido: [k (escala hacia el eje), desplazamiento según la normal, altura, arrugas]
  const prof = [[0, 0, 0, 0], [0.55, 0, 0, 0], [0.9, 0, 0, 0.2], [0.975, 0, 0.0018, 0.4], [1, 0, 0.007, 0.7]];
  const bulge = (y) => 0.0045 * Math.pow(Math.sin(Math.PI * clamp(y / Hc)), 0.6);
  for (let i = 1; i <= 16; i++) { const y = 0.007 + ((Hc - 0.007) * i) / 16; prof.push([1, bulge(y), y, 1]); }
  const cuffStart = prof.length;
  prof.push(
    [1, 0.0055, Hc + 0.004, 1.3], [1, 0.0095, Hc + 0.009, 1.5], [1, 0.0108, Hc + 0.016, 1.5], [1, 0.0094, Hc + 0.022, 1.5],
    [1, 0.0106, Hc + 0.029, 1.5], [1, 0.0094, H - 0.006, 1.5], [1, 0.0074, H - 0.0015, 1.3], [1, 0.0036, H + 0.0006, 1.1],
    [1, -0.0004, H - 0.0018, 1], [1, -0.0026, H - 0.008, 0.9],
  );
  const rimRow = cuffStart + 7;
  for (let y = H - 0.018; y > 0.028; y -= 0.014) prof.push([1, -0.003, y, 0.6]);
  // coordenada v por longitud de arco del perfil (medida en el centro del frente)
  const vArc = [0];
  for (let j = 1; j < prof.length; j++) {
    const [k0, o0, y0] = prof[j - 1], [k1, o1, y1] = prof[j];
    vArc.push(vArc[j - 1] + Math.hypot((k1 - k0) * b + (o1 - o0), y1 - y0));
  }
  const L = vArc[vArc.length - 1];
  // arrugas del papel con ruido periódico a lo largo del contorno (sin costura)
  const around = (s, f) => { const t = (s / P) * TAU; return [Math.cos(t) * R * f, Math.sin(t) * R * f]; };
  const crinkle = (s, y, w) => {
    const [cx, cz] = around(s, 32), [rx, rz] = around(s, 9);
    const ridge = 1 - Math.abs(noise3(rx, rz, y * 5 + 8.3) * 2 - 1);
    return ((fbm3(cx, cz, y * 32, 3) - 0.5) * 0.005 + (ridge ** 4 - 0.15) * 0.002) * w;
  };
  const rimWave = (s) => { const [cx, cz] = around(s, 6); return (noise3(cx, cz, 4.2) - 0.5) * 0.009; };
  const geo = sweepGeometry(path, prof.length, (p, j) => {
    const [k, off, y, w] = prof[j];
    let o = off + (w ? crinkle(p.s, y, w) : 0);
    // pliegue del fuelle en los laterales
    if (Math.abs(p.nx) > 0.98 && j < cuffStart) {
      o -= 0.0065 * (1 - smoothstep(0, 0.02, Math.abs(p.z))) * smoothstep(0.012, 0.05, y) * (1 - smoothstep(Hc - 0.035, Hc - 0.005, y));
    }
    const yy = y + (j >= cuffStart ? rimWave(p.s) : 0);
    return [p.x * k + p.nx * o, yy, p.z * k + p.nz * o, p.u, vArc[j] / L];
  });
  const map = paintFlourBag({ P, L, sFront, sLeft, sRight, v0: (vArc[4] - 0.007) / L, vCuff: vArc[cuffStart] / L, vRim: vArc[rimRow] / L });
  const bag = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map, roughness: 0.88 }));
  bag.castShadow = bag.receiveShadow = true;

  // harina dentro de la bolsa (baja a medida que se vacía)
  const capRows = 6;
  const capGeo = sweepGeometry(path, capRows, (p, j) => {
    const k = j / (capRows - 1), x = (p.x - p.nx * 0.0052) * k, z = (p.z - p.nz * 0.0052) * k;
    const y = 0.011 * (1 - k * k) + (noise3(x * 90, z * 90, 2.5) - 0.5) * 0.003 * (1 - k * 0.5);
    return [x, y, z, x * 6 + 0.5, z * 6 + 0.5];
  }, true);
  const cap = new THREE.Mesh(capGeo, flourMaterial(shared));
  cap.receiveShadow = true;

  const object = new THREE.Group();
  object.add(bag, cap);
  const bounds = [];
  for (const y of [0, H]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) bounds.push(V(sx * (a + 0.011), y, sz * (b + 0.011)));
  return {
    object, bounds, fill: null, full: 1, liquid: false, contact: 0.095,
    spout: V(a + 0.009, H - 0.002, 0),
    pour: { pre: 25 * DEG, onset: 72 * DEG, margin: 26 * DEG, max: 110 * DEG, shake: 0, height: 0.035 },
    setFraction: (f) => { cap.position.y = lerp(0.035, H - 0.03, f); cap.visible = f > 0.002; },
    puff: { color: 0xf8f4ec, count: 8, spread: 0.05, size: 0.025, life: 1.0 },
    streams: [
      new TubeStream(env.group, shared, { material: powderColumnMaterial(0xf1ebdf), radius: 0.013, width: 1.4, keep: 0.7, speed: [0.05, 0.09], flowScroll: 6 }),
      new PowderStream(env.group, shared.sprite, {
        color: 0xf6f2ea, size: 0.012, max: 260, rate: 260, speed: 0.07, spread: 0.05, jitter: 0.04, width: 0.05,
        dust: { color: 0xfbf8f2, size: 0.08, max: 120, rate: 50, alpha: 0.22, landProb: 0.12 },
      }),
    ],
  };
}

/** Jarra medidora de vidrio con asa, pico y marcas rojas; el agua se ve por el cristal. */
function buildJug(shared, env) {
  const outer = [[0, 0], [0.04, 0], [0.0465, 0.0015], [0.05, 0.0055], [0.051, 0.012], [0.0522, 0.05], [0.0536, 0.1], [0.0552, 0.15], [0.0562, 0.172]];
  const { profile, inner } = shellProfile(outer, 0.0028, 0.007);
  const UVH = 0.185, SEG = 64;
  const body = lathe(profile, SEG, -Math.PI / 2, UVH);
  // pico: estira el borde hacia +X
  const p = body.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < 1e-5) continue;
    const w = Math.exp(-((Math.acos(clamp(x / r, -1, 1)) / 0.34) ** 2)) * Math.pow(smoothstep(0.125, 0.174, y), 1.5);
    const nr = r + 0.017 * w;
    p.setXYZ(i, (x / r) * nr, y + 0.006 * w, (z / r) * nr);
  }
  body.computeVertexNormals();
  weldLatheSeam(body, profile.length, SEG);
  // asa
  const curve = new THREE.CatmullRomCurve3([V(-0.054, 0.155, 0), V(-0.077, 0.153, 0), V(-0.093, 0.13, 0), V(-0.092, 0.076, 0), V(-0.078, 0.047, 0), V(-0.054, 0.04, 0)]);
  const handle = new THREE.TubeGeometry(curve, 48, 0.0068, 12);
  const huv = handle.attributes.uv;
  for (let i = 0; i < huv.count; i++) huv.setXY(i, 0.75, 0.5);
  const object = new THREE.Group();
  const waterVol = glassMaterial({ color: 0x9fcbdc, opacity: 0.3, edge: 0.4, side: THREE.DoubleSide, roughness: 0.02 });
  const waterTop = glassMaterial({ color: 0xbfe0ec, opacity: 0.4, edge: 0.15, roughness: 0.04, envMapIntensity: 0.9 });
  waterTop.normalMap = shared.ripple;
  waterTop.normalScale.set(0.12, 0.12);
  const fill = new Fill(inner, { volumeMaterial: waterVol, surfaceMaterial: waterTop, parent: object, disc: shared.disc });
  fill.mesh.renderOrder = 1;
  fill.surface.renderOrder = 2;
  const glass = new THREE.Mesh(mergeGeometries([body, handle]), glassMaterial({ map: paintJugMarks(fill, UVH, 0.0545), opacity: 1, edge: 0.5, roughness: 0.04 }));
  glass.renderOrder = 3;
  object.add(glass);
  const streamMat = glassMaterial({ color: 0xcfe9f3, opacity: 0.5, edge: 0.6, roughness: 0.02, envMapIntensity: 1.8 });
  return {
    object, fill, liquid: true, contact: 0.075,
    spout: V(0.0735, 0.1795, 0),
    bounds: [...ringBounds(0.051, 0.057, 0.175), V(-0.095, 0.1, 0)],
    pour: { pre: 12 * DEG, minOnset: 25 * DEG, margin: 14 * DEG, max: 100 * DEG, shake: 0, height: 0.06 },
    streams: [new TubeStream(env.group, shared, { material: streamMat, radius: 0.007, speed: [0.12, 0.3], rings: 0x9cc3d4, droplets: true })],
  };
}

/** Tarrito de vidrio con rosca y etiqueta amarilla, lleno de levadura en gránulos. */
function buildYeastJar(shared, env) {
  const outer = [[0, 0], [0.025, 0], [0.0295, 0.0015], [0.0318, 0.006], [0.032, 0.012], [0.032, 0.05], [0.0312, 0.055], [0.029, 0.0585],
    [0.0275, 0.0605], [0.0276, 0.0625], [0.029, 0.0638], [0.0276, 0.0652], [0.029, 0.0666], [0.0276, 0.068], [0.0276, 0.071]];
  const { profile, inner } = shellProfile(outer, 0.0022, 0.005);
  const object = new THREE.Group();
  const fill = new Fill(inner, {
    volumeMaterial: grainMaterial(shared.yeast, { side: THREE.DoubleSide }), surfaceMaterial: grainMaterial(shared.yeast), parent: object, disc: shared.disc,
  });
  fill.mesh.castShadow = true;
  const glass = new THREE.Mesh(lathe(profile, 48, -Math.PI, 0.075), glassMaterial({ opacity: 0.1, edge: 0.55 }));
  glass.renderOrder = 3;
  const LH = 0.032;
  const labelGeo = new THREE.CylinderGeometry(0.0327, 0.0327, LH, 48, 1, true, Math.PI, TAU).translate(0, 0.008 + LH / 2, 0);
  const label = new THREE.Mesh(labelGeo, new THREE.MeshStandardMaterial({ map: paintYeastLabel(0.0327, LH), roughness: 0.7 }));
  label.castShadow = label.receiveShadow = true;
  object.add(glass, label);
  return {
    object, fill, full: 0.8, liquid: false, contact: 0.045,
    spout: V(0.0285, 0.0715, 0),
    bounds: ringBounds(0.032, 0.029, 0.072),
    pour: { pre: 25 * DEG, minOnset: 55 * DEG, margin: 30 * DEG, max: 135 * DEG, shake: 3.5 * DEG, height: 0.07 },
    streams: [new PowderStream(env.group, shared.sprite, { color: 0x9a6a36, jitter: 0.2, size: 0.011, max: 240, rate: 200, speed: 0.05, spread: 0.025, width: 0.016, seed: 3 })],
  };
}

/** Salero de cerámica esmaltada con "SAL" pintado en azul cobalto y sal gorda. */
function buildSaltPot(shared, env) {
  const outer = [[0, 0], [0.024, 0], [0.028, 0.0015], [0.0295, 0.005], [0.0305, 0.008], [0.0335, 0.014], [0.0368, 0.024], [0.0384, 0.036],
    [0.0378, 0.048], [0.0358, 0.058], [0.0348, 0.064], [0.0352, 0.067]];
  const { profile, inner, outerCount } = shellProfile(outer, 0.0048, 0.008);
  const UVH = 0.072;
  const geo = lathe(profile, 56, -Math.PI, UVH);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) if (i % profile.length >= outerCount) uv.setY(i, 0.995); // interior liso
  const pot = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({ map: paintSaltPot(0.0375, UVH), roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 }));
  pot.castShadow = pot.receiveShadow = true;
  const object = new THREE.Group();
  object.add(pot);
  const fill = new Fill(inner, { surfaceMaterial: grainMaterial(shared.salt, { roughness: 0.45, bumpScale: 3 }), parent: object, disc: shared.disc });
  return {
    object, fill, full: 0.7, liquid: false, contact: 0.05,
    spout: V(0.0335, 0.0695, 0),
    bounds: ringBounds(0.03, 0.036, 0.069),
    pour: { pre: 25 * DEG, minOnset: 55 * DEG, margin: 30 * DEG, max: 130 * DEG, shake: 4 * DEG, height: 0.07 },
    streams: [new PowderStream(env.group, shared.sprite, { color: 0xf2f4f5, jitter: 0.05, size: 0.018, max: 200, rate: 150, speed: 0.05, spread: 0.025, width: 0.018, seed: 5 })],
  };
}

/** Tarro hermético de vidrio (tapa abierta con goma naranja y cierre de alambre) lleno de azúcar. */
function buildSugarJar(shared, env) {
  const outer = [[0, 0], [0.036, 0], [0.0405, 0.0015], [0.0428, 0.006], [0.043, 0.012], [0.043, 0.078], [0.0418, 0.085], [0.0385, 0.09],
    [0.0372, 0.093], [0.0385, 0.0945], [0.0385, 0.0995], [0.0372, 0.101]];
  const { profile, inner } = shellProfile(outer, 0.0026, 0.006);
  const object = new THREE.Group();
  const fill = new Fill(inner, {
    volumeMaterial: grainMaterial(shared.sugar, { roughness: 0.5, side: THREE.DoubleSide }), surfaceMaterial: grainMaterial(shared.sugar, { roughness: 0.45 }),
    parent: object, disc: shared.disc,
  });
  fill.mesh.castShadow = true;
  const glassMat = glassMaterial({ opacity: 0.12, edge: 0.7 });
  const glass = new THREE.Mesh(lathe(profile, 56, -Math.PI, 0.11), glassMat);
  glass.renderOrder = 3;
  // tapa de vidrio con goma naranja, articulada en la bisagra trasera (se abre al levantar el tarro)
  const hinge = new THREE.Group();
  hinge.position.set(0, 0.1015, -0.0405);
  const lidPts = [[0, 0.004], [0.034, 0.0035], [0.034, 0], [0.0388, 0], [0.0388, 0.0015], [0.0372, 0.0045], [0.03, 0.0085], [0.018, 0.0108], [0, 0.0115]].map(([r, y]) => v2(r, y));
  const lid = new THREE.Mesh(new THREE.LatheGeometry(lidPts, 48).translate(0, 0, 0.0405), glassMat);
  lid.renderOrder = 3;
  const seal = new THREE.Mesh(new THREE.TorusGeometry(0.0362, 0.0018, 8, 48).rotateX(Math.PI / 2).translate(0, 0.0012, 0.0405),
    new THREE.MeshStandardMaterial({ color: 0xcf6a3a, roughness: 0.6 }));
  hinge.add(lid, seal);
  // cierre de alambre: aro en el cuello y dos brazos hasta la bisagra
  const wires = [new THREE.TorusGeometry(0.0392, 0.0011, 6, 48).rotateX(Math.PI / 2).translate(0, 0.0965, 0)];
  for (const sx of [-1, 1]) {
    const arm = new THREE.CatmullRomCurve3([V(sx * 0.012, 0.0965, -0.0372), V(sx * 0.0125, 0.1, -0.046), V(sx * 0.012, 0.106, -0.047), V(sx * 0.011, 0.1045, -0.042)]);
    wires.push(new THREE.TubeGeometry(arm, 10, 0.0011, 6));
  }
  const wire = new THREE.Mesh(mergeGeometries(wires),
    new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 1, roughness: 0.3 }));
  const LW = 1.5 * 0.0436;
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0436, 0.0436, 0.036, 32, 1, true, -0.75, 1.5).translate(0, 0.045, 0),
    new THREE.MeshStandardMaterial({ map: paintSugarLabel(LW * 1000, 36), roughness: 0.8, alphaTest: 0.5 }));
  label.castShadow = label.receiveShadow = true;
  seal.castShadow = wire.castShadow = true;
  object.add(glass, hinge, wire, label);
  return {
    object, fill, full: 0.66, liquid: false, contact: 0.06,
    spout: V(0.0385, 0.1015, 0),
    bounds: [...ringBounds(0.043, 0.039, 0.102), V(0, 0.17, -0.07)],
    pour: { pre: 25 * DEG, minOnset: 50 * DEG, margin: 26 * DEG, max: 130 * DEG, shake: 2.5 * DEG, height: 0.07 },
    onPose: (sv) => { hinge.rotation.x = -118 * DEG * smoothstep(0.02, 0.35, sv); },
    streams: [new PowderStream(env.group, shared.sprite, { color: 0xffffff, jitter: 0.03, size: 0.015, max: 300, rate: 240, speed: 0.06, spread: 0.025, width: 0.024, twinkle: true, seed: 9 })],
  };
}

/** Botella de aceite de oliva de vidrio verde con aceite dorado, etiqueta y vertedor metálico. */
function buildOilBottle(shared, env) {
  const outer = [[0, 0], [0.026, 0], [0.0305, 0.0015], [0.0328, 0.006], [0.033, 0.014], [0.033, 0.165], [0.0318, 0.176], [0.0285, 0.188],
    [0.022, 0.2], [0.0165, 0.209], [0.0136, 0.217], [0.0127, 0.226], [0.0127, 0.241], [0.0146, 0.2425], [0.0148, 0.2495], [0.0128, 0.251]];
  const { profile, inner } = shellProfile(outer, 0.0024, 0.006);
  const object = new THREE.Group();
  const oilVol = new THREE.MeshPhysicalMaterial({ color: 0xc79a1c, transparent: true, opacity: 0.85, roughness: 0.1, side: THREE.DoubleSide, depthWrite: false, clearcoat: 0.6 });
  const fill = new Fill(inner, { volumeMaterial: oilVol, parent: object, disc: shared.disc });
  fill.mesh.renderOrder = 1;
  fill.mesh.castShadow = true;
  const glass = new THREE.Mesh(lathe(profile, 48, -Math.PI, 0.26), glassMaterial({ color: 0x6f9a45, opacity: 0.22, edge: 0.6 }));
  glass.renderOrder = 3;
  // etiqueta principal + collarín (un solo material con la textura dividida en dos zonas)
  const main = new THREE.CylinderGeometry(0.0334, 0.0334, 0.095, 48, 1, true, -1.35, 2.7).translate(0, 0.1, 0);
  const neck = new THREE.CylinderGeometry(0.0129, 0.0129, 0.013, 32, 1, true).translate(0, 0.2335, 0);
  const remapV = (g, v0, v1) => { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setY(i, lerp(v0, v1, uv.getY(i))); return g; };
  const label = new THREE.Mesh(mergeGeometries([remapV(main, 0.3, 1), remapV(neck, 0, 0.25)]),
    new THREE.MeshStandardMaterial({ map: paintOilLabel(2.7 * 33.4, 95), roughness: 0.75 }));
  label.castShadow = label.receiveShadow = true;
  const cork = new THREE.Mesh(new THREE.CylinderGeometry(0.0104, 0.0098, 0.022, 20).translate(0, 0.2485, 0),
    new THREE.MeshStandardMaterial({ color: 0xb48a5a, roughness: 0.95, map: shared.yeast }));
  const spoutCurve = new THREE.CatmullRomCurve3([V(0, 0.256, 0), V(0, 0.27, 0), V(0.005, 0.281, 0), V(0.014, 0.2885, 0), V(0.025, 0.2925, 0)]);
  const metal = mergeGeometries([
    new THREE.TubeGeometry(spoutCurve, 24, 0.0032, 10),
    new THREE.CylinderGeometry(0.0058, 0.0063, 0.007, 20).translate(0, 0.2625, 0),
  ]);
  const pourer = new THREE.Mesh(metal, new THREE.MeshStandardMaterial({ color: 0xd8dadd, metalness: 1, roughness: 0.22 }));
  cork.castShadow = pourer.castShadow = true;
  object.add(glass, label, cork, pourer);
  const streamMat = new THREE.MeshPhysicalMaterial({ color: 0xd9a41e, transparent: true, opacity: 0.9, roughness: 0.08, clearcoat: 1, emissive: 0x6a4300, emissiveIntensity: 0.3 });
  return {
    object, fill, liquid: true, contact: 0.048,
    spout: V(0.026, 0.2925, 0),
    bounds: [...ringBounds(0.033, 0.015, 0.29), V(0, 0.17, 0.033), V(0, 0.17, -0.033)],
    pour: { pre: 20 * DEG, minOnset: 60 * DEG, margin: 14 * DEG, max: 150 * DEG, shake: 0, height: 0.05 },
    streams: [new TubeStream(env.group, shared, { material: streamMat, radius: 0.0027, speed: [0.06, 0.12], rings: 0x6b5410 })],
  };
}

// ---------------------------------------------------------------------------
// Ingrediente: coreografía de vertido, flujo y chorro
// ---------------------------------------------------------------------------

/**
 * Envuelve un recipiente con su coreografía. El estado es un único progreso continuo
 * s ∈ [0, 2] (0 = en casa, 1 = sobre el bol casi recto, 2 = inclinado del todo) y la pose es
 * una función pura de s: así se puede interrumpir en cualquier momento sin saltos.
 */
function createItem(id, built, env) {
  const def = ITEM_DEFS[id];
  const { object, spout, bounds, fill, pour, streams } = built;
  const home = SPOTS.ingredients[id].clone();
  const cam = CAMERAS.ingredients.position;
  const homeYaw = Math.atan2(cam.x - home.x, cam.z - home.z) * 0.8;    // etiqueta mirando a la cámara
  const highlighter = makeHighlighter(object);
  const target = DEFAULT_TARGET.clone(), wanted = DEFAULT_TARGET.clone();
  const q = new THREE.Quaternion(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const root = new THREE.Vector3(), goal = new THREE.Vector3(), tmp = new THREE.Vector3();
  const spoutW = new THREE.Vector3(), axisW = new THREE.Vector3(), landP = new THREE.Vector3();
  const streamArgs = { flow: 0, origin: spoutW, dir: POUR_DIR, axis: axisW, landY: 0, wet: false, time: 0 };
  let active = false, s = 0, sVel = 0, flow = 0, remaining = def.capacity, time = 0;
  let onset = pour.onset ?? pour.minOnset, pourTilt = onset + pour.margin, onsetFrac = -1, lastFrac = -1, posed = false;
  let audioLoop = null, audioTried = false, puffTimer = 0, warned = false;
  let throttle = 1, throttleGoal = 1; // chorrito fino (setThrottle): menos inclinación y menos caudal
  let releaseT = Infinity;            // s desde que se soltó (el chorro se corta en menos de 0,1 s)

  const fraction = () => (built.liquid ? (remaining * 1e-6) / fill.volume : built.full * (remaining / def.capacity));
  const rotate = (yaw, tilt) => q.multiplyQuaternions(qa.setFromAxisAngle(TILT_AXIS, tilt), qb.setFromAxisAngle(UP, yaw));

  /** Coloca el recipiente para el progreso sv; devuelve la inclinación base (sin temblor). */
  function pose(sv, bowl) {
    const e = clamp(sv, 0, 1), b = easeInOut(sv - 1), hold = 1 - b;
    // la boca acaba sobre el centro del bol; al empezar a inclinar está algo más alta y retrasada
    goal.set(target.x, bowl.rimY + pour.height, target.z).addScaledVector(POUR_DIR, -0.035 * hold).addScaledVector(UP, 0.05 * hold);
    let tilt;
    if (sv < 1) {
      rotate(POUR_YAW, pour.pre);
      tmp.copy(spout).applyQuaternion(q);
      const hx = smoothstep(0.1, 1, e), vy = smoothstep(0, 0.8, e);
      root.set(lerp(home.x, goal.x - tmp.x, hx), lerp(home.y, goal.y - tmp.y, vy) + Math.sin(Math.PI * e) * 0.07, lerp(home.z, goal.z - tmp.z, hx));
      tilt = pour.pre * smoothstep(0.45, 1, e);
      rotate(lerpAngle(homeYaw, POUR_YAW, smoothstep(0.05, 0.85, e)), tilt);
    } else {
      tilt = lerp(pour.pre, pourTilt - pour.margin * 0.4 * (1 - throttle), b);
      rotate(POUR_YAW, tilt + (pour.shake ? Math.sin(time * 11) * pour.shake * b : 0));
      root.copy(spout).applyQuaternion(q);
      root.subVectors(goal, root);
    }
    // holgura: nada del recipiente por debajo del borde del bol mientras está encima de él
    let need = 0;
    for (const p of bounds) {
      tmp.copy(p).applyQuaternion(q).add(root);
      const w = 1 - smoothstep(BOWL.rimRadius, BOWL.rimRadius + 0.07, Math.hypot(tmp.x - bowl.x, tmp.z - bowl.z));
      need = Math.max(need, (bowl.rimY + 0.015 - tmp.y) * w);
    }
    // pulso de la mano que lo sostiene
    const hand = Math.min(1, sv);
    root.x += Math.sin(time * 1.3) * 0.0015 * hand;
    root.y += need + Math.sin(time * 1.9 + 1) * 0.001 * hand;
    object.position.copy(root);
    object.quaternion.copy(q);
    return tilt;
  }

  function sound(dt) {
    const ctx = env.ctx;
    if (flow > 0.02) {
      if (!audioLoop && !audioTried) { audioTried = true; audioLoop = ctx.audio?.loop?.(def.sound, { volume: 0.7 }) ?? null; }
      audioLoop?.setIntensity?.(flow);
      if (built.puff) {
        puffTimer -= dt;
        if (puffTimer <= 0 && flow > 0.3) { puffTimer = 0.35; ctx.particles?.puff?.(landP, built.puff); }
      }
    } else if (audioLoop || audioTried) {
      audioLoop?.stop?.(0.25);
      audioLoop = null;
      audioTried = false;
    }
  }

  function update(dt) {
    try {
      time += dt;
      highlighter.update(dt);
      // destino suavizado: si cambia a mitad de vertido, el recipiente se desliza
      if (s <= 1e-4 && !active) target.copy(wanted); else target.lerp(wanted, 1 - Math.exp(-5 * dt));
      const dest = active ? 2 : 0, dir = Math.sign(dest - s);
      const tiltTime = TILT_TIME + (0.55 * (pourTilt - pour.pre)) / Math.PI;
      const speed = 1 / ((dir > 0 ? s < 1 : s <= 1) ? TRAVEL_TIME : active ? tiltTime : UNTILT_TIME);
      sVel = dir === 0 ? 0 : damp(sVel, dir * speed, 10, dt);
      const prev = s;
      s = clamp(s + sVel * dt, 0, 2);
      if (dir !== 0 && (dest - prev) * (dest - s) <= 0) { s = dest; sVel = 0; }

      const frac = fraction();
      flow = 0;
      if (s > 0 || prev > 0 || !posed) {
        // la inclinación necesaria crece a medida que el recipiente se vacía
        if (fill && s > 0 && Math.abs(frac - onsetFrac) > 0.004) {
          onset = clamp(fill.onsetTilt(spout, frac), pour.minOnset, pour.max - pour.margin * 0.5);
          pourTilt = Math.min(onset + pour.margin, pour.max);
          onsetFrac = frac;
        }
        const tilt = pose(s, env.bowl(target));
        built.onPose?.(s);
        if (s > 1 && remaining > 0) flow = smoothstep(onset - 2 * DEG, onset + pour.margin * 0.55, tilt);
      }
      throttle = damp(throttle, throttleGoal, 6, dt);
      flow *= throttle;
      // al soltar deja de salir casi al instante: lo que cae después ya no te hace pasarte
      if (!active) { releaseT += dt; flow *= 1 - smoothstep(0, 0.07, releaseT); }
      if (flow > 0) remaining = Math.max(0, remaining - flow * def.maxRate * dt);
      object.updateWorldMatrix(true, false);
      spoutW.copy(spout).applyMatrix4(object.matrixWorld);
      if (fill && (s > 0 || prev > 0 || !posed || frac !== lastFrac)) fill.update(object, frac, spoutW.y + 0.002);
      built.setFraction?.(frac);
      lastFrac = frac;
      posed = true;

      if (s === 0 && prev === 0 && streams.every((st) => st.idle)) { sound(dt); return; }
      axisW.set(0, 0, 1).applyQuaternion(object.quaternion);
      const land = env.surface(spoutW.x + POUR_DIR.x * 0.015, spoutW.z + POUR_DIR.z * 0.015, target.y);
      landP.set(spoutW.x + POUR_DIR.x * 0.015, land.y, spoutW.z + POUR_DIR.z * 0.015);
      Object.assign(streamArgs, { flow, landY: land.y, wet: land.wet, time });
      for (const st of streams) st.update(dt, streamArgs);
      sound(dt);
    } catch (e) {
      if (!warned) { warned = true; console.error(`[ingredients] ${id}:`, e); }
    }
  }

  const item = {
    id,
    label: def.label,
    unit: def.unit,
    maxRate: def.maxRate,
    object,
    /** 0..1: lo que está saliendo ahora mismo. */
    get flow() { return flow; },
    /** true mientras el recipiente no está quieto en su sitio. */
    get busy() { return active || s > 1e-4; },
    /**
     * Activo: lo levanta, lo lleva sobre `targetWorld` (centro del bol) y lo inclina hasta verter.
     * Inactivo: lo endereza y lo devuelve a casa. Se puede alternar en cualquier momento.
     * @param {boolean} on
     * @param {THREE.Vector3} [targetWorld]
     */
    setPouring(on, targetWorld) {
      if (active && !on) releaseT = 0;
      active = !!on;
      if (targetWorld?.isVector3) wanted.copy(targetWorld);
    },
    /**
     * Limita el caudal (0.05..1; 1 = normal). Con menos de 1 se inclina algo menos y sale un chorrito
     * fino: sirve para afinar los últimos gramos. El cambio es suave.
     * @param {number} k01
     */
    setThrottle(k01) { if (Number.isFinite(k01)) throttleGoal = clamp(k01, 0.05, 1); },
    /** Pulso luminoso suave para indicar que se puede pulsar. */
    setHighlight(on) { highlighter.set(!!on); },
    /** Lo devuelve a casa al instante y lo rellena. */
    reset() {
      active = false;
      s = sVel = flow = 0;
      throttle = throttleGoal = 1;
      remaining = def.capacity;
      onsetFrac = -1;
      posed = false;
      for (const st of streams) st.reset();
      audioLoop?.stop?.(0.1);
      audioLoop = null;
      audioTried = false;
      update(0);
    },
    /** Lo llama el update() del módulo; no hace falta llamarlo aparte. */
    update,
  };
  update(0);
  return item;
}

// ---------------------------------------------------------------------------
// Contenido del bol (antes de ser masa)
// ---------------------------------------------------------------------------
const AMOUNT_KEYS = ['flour', 'water', 'yeast', 'salt', 'sugar', 'oil'];
const OIL_AT = [0.042, 0.034];   // el aceite resbala del montón y flota en el agua
const GRAIN_TYPES = [
  { key: 'yeast', n: 150, full: 9, color: 0x8f5e2c, jitter: 0.25, size: [0.0017, 0.0009, 0.0009], spread: 0.014, at: [0.01, -0.008] },
  { key: 'salt', n: 110, full: 12, color: 0xf3f5f6, jitter: 0.05, size: [0.0017, 0.0014, 0.0016], spread: 0.016, at: [-0.011, 0.006] },
  { key: 'sugar', n: 220, full: 18, color: 0xffffff, jitter: 0.04, size: [0.001, 0.0009, 0.001], spread: 0.018, at: [0.006, 0.013] },
];

function createBowlContents(shared) {
  const group = new THREE.Group();
  group.name = 'bowlContents';
  const amounts = { flour: 0, water: 0, yeast: 0, salt: 0, sugar: 0, oil: 0 };
  let mix = 0, shown = true, dirty = true, time = 0, sinceBuild = 1, warned = false;
  let H = 0, Rm = 0, level = 0;
  const m4 = new THREE.Matrix4(), p3 = new THREE.Vector3(), s3 = new THREE.Vector3(), c3 = new THREE.Color(), local = new THREE.Vector3();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const noRaycast = (o) => { o.raycast = () => {}; return o; };

  // volumen del bol por alturas (para el nivel del agua)
  const STEP = 0.0005, cum = [0];
  for (let y = STEP; y <= BOWL_INNER_H + 1e-9; y += STEP) { const r = bowlInnerR(y - STEP / 2); cum.push(cum[cum.length - 1] + Math.PI * r * r * STEP); }
  const levelFor = (ml) => {
    const v = ml * 1e-6;
    let i = 0;
    while (i < cum.length - 1 && cum[i + 1] < v) i++;
    return i >= cum.length - 1 ? BOWL_INNER_H : (i + (v - cum[i]) / (cum[i + 1] - cum[i])) * STEP;
  };

  // --- montón de harina: disco polar deformado ---
  const mound = polarDisc(30, 72, 3);
  const n1 = new Float32Array(mound.n), n2 = new Float32Array(mound.n);
  for (let k = 0; k < mound.n; k++) {
    const x = mound.t[k] * Math.cos(mound.ang[k]), z = mound.t[k] * Math.sin(mound.ang[k]);
    n1[k] = fbm3(x * 2.2 + 3, z * 2.2, 1.3, 3) - 0.5;
    n2[k] = noise3(x * 9, z * 9, 4.1) - 0.5;
  }
  // (algo más cálida y apagada que el esmalte crema del bol, para que el montón se distinga)
  const flourMat = new THREE.MeshPhysicalMaterial({
    vertexColors: true, map: shared.flour, bumpMap: shared.flourBump, bumpScale: 1, roughness: 0.96,
    sheen: 0.3, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xf4e6cc),
  });
  const flourMesh = noRaycast(new THREE.Mesh(mound.geometry, flourMat));
  flourMesh.receiveShadow = true;
  const DRY = new THREE.Color(0xe3d1b1), WET = new THREE.Color(0xbfa77d), OILY = new THREE.Color(0xd8b25a);
  const shape = (t, a, b) => Math.max(0, H * Math.pow(Math.cos((t * Math.PI) / 2), 1.4) * (1 + 0.38 * a) + 0.0022 * b * (1 - t));
  const flourH = (x, z) => {
    if (H <= 0) return 0;
    const nx = x / Rm, nz = z / Rm, t = Math.hypot(nx, nz);
    return t >= 1 ? 0 : shape(t, fbm3(nx * 2.2 + 3, nz * 2.2, 1.3, 3) - 0.5, noise3(nx * 9, nz * 9, 4.1) - 0.5);
  };
  /** Altura local de lo más alto en (x, z): harina, agua o el propio bol. */
  const surfaceH = (x, z) => {
    const r = Math.hypot(x, z);
    let h = Math.max(flourH(x, z), bowlWallY(r));
    if (level > 0 && r < bowlInnerR(level)) h = Math.max(h, level);
    return h;
  };

  // --- agua: disco transparente con ondas ---
  const waterMat = glassMaterial({ color: 0x8fb2c0, opacity: 0.42, edge: 0.5, roughness: 0.02, envMapIntensity: 1.7 });
  waterMat.normalMap = shared.ripple.clone();
  waterMat.normalScale.set(0.45, 0.45);
  const water = noRaycast(new THREE.Mesh(shared.disc, waterMat));
  water.renderOrder = 2;
  // cerco mojado: el borde del agua oscurece el esmalte (se ve dónde llega aunque el agua sea clara)
  const wetRing = noRaycast(new THREE.Mesh((() => {
    const g = new THREE.RingGeometry(0.8, 1, 48, 1).rotateX(-Math.PI / 2);
    const p = g.attributes.position, col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const a = smoothstep(0.8, 1, Math.hypot(p.getX(i), p.getZ(i)));
      col.set([0.36, 0.3, 0.24, a * a], i * 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    return g;
  })(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false })));
  wetRing.renderOrder = 3;

  // --- granos de levadura, sal y azúcar (una sola malla instanciada) ---
  const grainTotal = GRAIN_TYPES.reduce((n, g) => n + g.n, 0);
  const grains = noRaycast(new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ roughness: 0.35 }), grainTotal));
  grains.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const grainData = [];
  {
    const rnd = makeRng(41);
    const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd() * 0.999)) * Math.cos(TAU * rnd());
    let i = 0;
    for (const G of GRAIN_TYPES) {
      const base = new THREE.Color(G.color);
      for (let k = 0; k < G.n; k++, i++) {
        const rot = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * TAU, rnd() * TAU, rnd() * TAU));
        const j = 1 + (rnd() - 0.5) * 0.5;
        grainData.push({ x: G.at[0] + gauss() * G.spread, z: G.at[1] + gauss() * G.spread, q: rot, s: new THREE.Vector3(G.size[0] * j, G.size[1] * j, G.size[2] * j) });
        grains.setColorAt(i, c3.copy(base).multiplyScalar(1 + (rnd() - 0.5) * 2 * G.jitter));
      }
    }
  }

  // --- aceite: mancha dorada que se adapta a la superficie ---
  const oilDisc = polarDisc(8, 40, 4);
  const oilMesh = noRaycast(new THREE.Mesh(oilDisc.geometry, new THREE.MeshPhysicalMaterial({
    vertexColors: true, transparent: true, depthWrite: false, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05,
  })));
  oilMesh.renderOrder = 3;
  const OIL = new THREE.Color(0xc99a22);
  const oilRadius = () => 0.012 + 0.022 * Math.sqrt(Math.min(amounts.oil, 60) / 25);

  // --- grumos de masa desgreñada (al mezclar) ---
  const lumpGeo = (() => {
    const g = new THREE.IcosahedronGeometry(1, 3);
    g.deleteAttribute('normal');
    g.deleteAttribute('uv');
    const m = mergeVertices(g);
    const pos = m.attributes.position, col = new Float32Array(pos.count * 3), c = new THREE.Color();
    const dough = new THREE.Color(0xc29c66), floury = new THREE.Color(0xe6dbc2), wet = new THREE.Color(0xab8550);
    for (let i = 0; i < pos.count; i++) {
      p3.fromBufferAttribute(pos, i);
      const d = 1 + (fbm3(p3.x * 1.8 + 5, p3.y * 1.8, p3.z * 1.8, 3) - 0.5) * 0.55 + (noise3(p3.x * 6, p3.y * 6, p3.z * 6) - 0.5) * 0.16;
      p3.multiplyScalar(d);
      if (p3.y < -0.4) p3.y = -0.4 + (p3.y + 0.4) * 0.25;
      pos.setXYZ(i, p3.x, p3.y, p3.z);
      c.copy(dough).lerp(wet, smoothstep(0.5, 0.75, noise3(p3.x * 3 + 2, p3.y * 3, p3.z * 3)));
      c.lerp(floury, 0.85 * smoothstep(0.64, 0.76, noise3(p3.x * 4, p3.y * 4 + 7, p3.z * 4)) * smoothstep(0, 0.6, p3.y));
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    m.setAttribute('color', new THREE.BufferAttribute(col, 3));
    m.computeVertexNormals();
    return m;
  })();
  const CLUMPS = 11;
  const clumps = noRaycast(new THREE.InstancedMesh(lumpGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }), CLUMPS));
  clumps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  clumps.castShadow = clumps.receiveShadow = true;
  const clumpData = [];
  {
    const rnd = makeRng(77);
    for (let i = 0; i < CLUMPS; i++) {
      const a = (i / CLUMPS) * TAU + rnd() * 0.5, r = i === 0 ? 0 : 0.025 + rnd() * 0.04;
      clumpData.push({
        x: Math.cos(a) * r, z: Math.sin(a) * r, r, size: 0.021 + rnd() * 0.017,
        q: new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.6, rnd() * TAU, (rnd() - 0.5) * 0.6)),
        grow: 0.05 + rnd() * 0.18, shrink: 0.55 + rnd() * 0.18,
      });
    }
  }

  group.add(flourMesh, water, wetRing, grains, oilMesh, clumps);

  function rebuild() {
    dirty = false;
    const flat = smoothstep(0.08, 0.6, mix), shrink = 1 - smoothstep(0.5, 0.95, mix), gone = 1 - smoothstep(0.04, 0.3, mix);
    const f = amounts.flour, h0 = 0.05 * Math.cbrt(f / 500);
    H = f > 0 ? h0 * (1 - 0.8 * flat) * shrink : 0;
    Rm = f > 0 ? (h0 / Math.tan(36 * DEG) + 0.012) * (1 + 0.25 * flat) * (0.35 + 0.65 * shrink) : 0;
    // el agua rodea la harina: cuenta algo del volumen que ocupa la harina mojada
    level = amounts.water > 0 ? levelFor(amounts.water * (1 + 0.93 * Math.min(1, f / 500))) * (1 - smoothstep(0.05, 0.45, mix)) : 0;
    const Ro = oilRadius(), hasOil = amounts.oil > 0;

    // harina
    flourMesh.visible = H > 0.0008;
    if (flourMesh.visible) {
      const geo = mound.geometry, pos = geo.attributes.position.array, uv = geo.attributes.uv.array, col = geo.attributes.color.array;
      const wetMix = smoothstep(0.02, 0.35, mix);
      for (let k = 0; k < mound.n; k++) {
        const t = mound.t[k], r = t * Rm, x = Math.cos(mound.ang[k]) * r, z = Math.sin(mound.ang[k]) * r;
        const h = Math.max(t < 1 ? shape(t, n1[k], n2[k]) : 0, bowlWallY(r) + 0.0012);
        pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
        uv[k * 2] = x * 2.5 + 0.5; uv[k * 2 + 1] = z * 2.5 + 0.5;
        const wet = Math.max(level > 0 ? smoothstep(level + 0.005, level - 0.002, h) : 0, wetMix);
        c3.copy(DRY).lerp(WET, wet).multiplyScalar(lerp(0.55, 1, smoothstep(1, 0.45, t))); // pie del montón en sombra
        if (hasOil) c3.lerp(OILY, 0.55 * gone * (1 - smoothstep(Ro * 0.5, Ro * 1.05, Math.hypot(x - OIL_AT[0], z - OIL_AT[1]))));
        col[k * 3] = c3.r; col[k * 3 + 1] = c3.g; col[k * 3 + 2] = c3.b;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }

    // agua
    water.visible = wetRing.visible = level > 0.0012;
    if (water.visible) {
      const r = bowlInnerR(level) - 0.0008;
      water.position.y = level;
      water.scale.set(r, 1, r);
      wetRing.position.y = level + 0.0003;
      wetRing.scale.set(r, 1, r);
    }

    // granos
    let gi = 0;
    for (const G of GRAIN_TYPES) {
      const vis = Math.round(G.n * Math.min(1, amounts[G.key] / G.full));
      for (let k = 0; k < G.n; k++, gi++) {
        if (k >= vis || gone < 0.002) { grains.setMatrixAt(gi, ZERO); continue; }
        const d = grainData[gi];
        s3.copy(d.s).multiplyScalar(gone);
        m4.compose(p3.set(d.x, surfaceH(d.x, d.z) + s3.y * 0.6, d.z), d.q, s3);
        grains.setMatrixAt(gi, m4);
      }
    }
    grains.instanceMatrix.needsUpdate = true;
    grains.visible = gone > 0.002 && (amounts.yeast > 0 || amounts.salt > 0 || amounts.sugar > 0);

    // aceite
    oilMesh.visible = hasOil && gone > 0.01;
    if (oilMesh.visible) {
      const geo = oilDisc.geometry, pos = geo.attributes.position.array, col = geo.attributes.color.array;
      for (let k = 0; k < oilDisc.n; k++) {
        const t = oilDisc.t[k], r = t * Ro;
        const x = OIL_AT[0] + Math.cos(oilDisc.ang[k]) * r, z = OIL_AT[1] + Math.sin(oilDisc.ang[k]) * r;
        pos[k * 3] = x; pos[k * 3 + 1] = surfaceH(x, z) + 0.0012; pos[k * 3 + 2] = z;
        col[k * 4] = OIL.r; col[k * 4 + 1] = OIL.g; col[k * 4 + 2] = OIL.b;
        col[k * 4 + 3] = 0.62 * (1 - t * t * t) * gone;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
      geo.computeVertexNormals();
      geo.computeBoundingSphere();
    }

    // grumos: aparecen, crecen y se funden en la masa
    const cf = Math.cbrt(Math.min(1, f / 500));
    for (let i = 0; i < CLUMPS; i++) {
      const c = clumpData[i];
      const k = c.size * cf * smoothstep(c.grow, c.grow + 0.22, mix) * (1 - smoothstep(c.shrink, 0.97, mix));
      if (k < 1e-4) { clumps.setMatrixAt(i, ZERO); continue; }
      m4.compose(p3.set(c.x, bowlWallY(c.r) + k * 0.6, c.z), c.q, s3.set(k, k * 0.75, k * 0.92));
      clumps.setMatrixAt(i, m4);
    }
    clumps.instanceMatrix.needsUpdate = true;
    clumps.visible = f > 0 && mix > 0.04 && mix < 0.99;
    clumps.computeBoundingSphere();
    grains.computeBoundingSphere();
  }

  const applyVisibility = () => { group.visible = shown && mix < 0.995; };
  const out = { y: 0, wet: false };

  return {
    group,
    /**
     * Cantidades actuales en gramos / ml (las claves que falten no cambian).
     * @param {{flour?: number, water?: number, yeast?: number, salt?: number, sugar?: number, oil?: number}} a
     */
    setAmounts(a = {}) {
      for (const k of AMOUNT_KEYS) {
        const v = Number(a[k]);
        if (Number.isFinite(v) && Math.max(0, v) !== amounts[k]) { amounts[k] = Math.max(0, v); dirty = true; }
      }
    },
    /** 0: ingredientes sueltos; al mezclar se apelmazan en grumos y desaparecen (ocultos en 1). */
    setMix(t) {
      const v = clamp(Number(t) || 0);
      if (v !== mix) { mix = v; dirty = true; }
      applyVisibility();
    },
    setVisible(on) { shown = !!on; applyVisibility(); },
    reset() {
      for (const k of AMOUNT_KEYS) amounts[k] = 0;
      mix = 0;
      shown = true;
      applyVisibility();
      rebuild();
    },
    update(dt) {
      try {
        time += dt;
        sinceBuild += dt;
        waterMat.normalMap.offset.set(time * 0.012, time * 0.008);
        if (dirty && group.visible && sinceBuild >= 1 / 30) { sinceBuild = 0; rebuild(); }
      } catch (e) {
        if (!warned) { warned = true; console.error('[ingredients] bowlContents:', e); }
      }
    },
    /**
     * Altura (mundo) de lo que hay en el bol en (x, z) y si es agua; null si no está en un bol.
     * Lo usan los chorros para terminar justo en la superficie.
     */
    surfaceAt(wx, wz) {
      if (!group.parent) return null;
      group.updateWorldMatrix(true, false);
      local.set(wx, group.matrixWorld.elements[13], wz);
      group.worldToLocal(local);
      const r = Math.hypot(local.x, local.z);
      if (r > BOWL.rimRadius + 0.05) return null;
      const on = shown && mix < 0.995;
      local.y = on ? surfaceH(local.x, local.z) : bowlWallY(r);
      out.wet = on && level > 0 && local.y <= level + 1e-4;
      group.localToWorld(local);
      out.y = local.y;
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------

/** Sombra suave bajo un recipiente en su sitio (el vidrio no proyecta sombra); se apaga al levantarlo. */
function makeContact(item, radius, map) {
  const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2).rotateX(-Math.PI / 2), mat);
  const home = SPOTS.ingredients[item.id];
  mesh.position.set(home.x, home.y + 0.0005, home.z);
  mesh.raycast = () => {};
  mesh.renderOrder = -1;
  return {
    mesh,
    update() {
      const lift = item.object.position.y - home.y;
      mat.opacity = 1 - smoothstep(0, 0.04, lift);
      mesh.visible = mat.opacity > 0.01;
    },
  };
}

/**
 * Crea los seis ingredientes sobre la isla y el contenido del bol.
 * @param {{engine?: any, scene?: THREE.Scene, camera?: THREE.Camera, renderer?: THREE.WebGLRenderer, particles?: any, audio?: any}} ctx
 * @returns {{group: THREE.Group, items: {flour: any, water: any, yeast: any, salt: any, sugar: any, oil: any},
 *   bowlContents: any, update(dt: number, elapsed?: number): void}}
 */
export function createIngredients(ctx = {}) {
  const group = new THREE.Group();
  group.name = 'ingredients';
  const shared = makeShared();
  const bowlContents = createBowlContents(shared);
  const bowlPos = new THREE.Vector3();
  const bowlInfo = { x: 0, z: 0, rimY: 0 };
  const fallback = { y: 0, wet: true };
  const env = {
    ctx, group, shared,
    /** Eje y altura del borde del bol hacia el que se vierte. */
    bowl(target) {
      const g = bowlContents.group;
      let ref = target;
      if (g.parent) {
        g.getWorldPosition(bowlPos);
        if (Math.hypot(bowlPos.x - target.x, bowlPos.z - target.z) < 0.25) ref = bowlPos;
      }
      bowlInfo.x = ref.x;
      bowlInfo.z = ref.z;
      bowlInfo.rimY = ref.y - BOWL.wall - 0.002 + BOWL.height;
      return bowlInfo;
    },
    /** Superficie donde acaba un chorro (contenido del bol o, si no hay bol, la altura del destino). */
    surface(x, z, fallbackY) {
      const r = bowlContents.surfaceAt(x, z);
      if (r) return r;
      fallback.y = fallbackY;
      return fallback;
    },
  };
  const contacts = [];
  const builders = { flour: buildFlourBag, water: buildJug, yeast: buildYeastJar, salt: buildSaltPot, sugar: buildSugarJar, oil: buildOilBottle };
  const items = {};
  for (const [id, build] of Object.entries(builders)) {
    const built = build(shared, env);
    built.object.name = `ingredient-${id}`;
    built.object.traverse((o) => { if (o.isMesh) o.userData.ingredient = id; });
    group.add(built.object);
    items[id] = createItem(id, built, env);
    contacts.push(makeContact(items[id], built.contact, shared.contact));
  }
  const spill = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shared.spill, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  spill.position.copy(SPOTS.ingredients.flour).add(V(0.07, 0.0006, 0.07));
  spill.rotation.y = -0.35;
  spill.raycast = () => {};
  spill.renderOrder = -1;
  group.add(spill, ...contacts.map((c) => c.mesh));
  const list = Object.values(items);
  return {
    group,
    items,
    bowlContents,
    /** Avanza recipientes, chorros y contenido del bol. */
    update(dt) {
      const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
      for (const it of list) it.update(d);
      for (const c of contacts) c.update();
      bowlContents.update(d);
    },
  };
}
