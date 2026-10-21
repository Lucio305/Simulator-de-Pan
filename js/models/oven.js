// Horno de pared empotrado (100 % procedural): marco de acero cepillado, panel de cristal negro con
// dos mandos y LCD, puerta abatible con cristal ahumado, cavidad esmaltada con guías y rejilla,
// resistencias que se ponen al rojo, ventilador trasero, lámpara interior y vapor.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { OVEN } from '../core/layout.js';
import { animate, ease } from '../core/anim.js';
import { clamp, damp, lerp, degToRad, makeRng, makeCanvasTexture, makeHighlighter } from '../core/utils.js';

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Medidas (coordenadas locales: origen = centro de la cara frontal, +Z hacia la cocina)
// ---------------------------------------------------------------------------
const FRONT_Z = 0.006;                                                   // cara del marco (sobresale 6 mm del mueble)
const FASCIA = { w: OVEN.width - 0.006, h: OVEN.height - 0.006, back: -0.02 };
const CAV = { x0: -0.25, x1: 0.25, y0: -0.27, y1: 0.13, z0: -0.48, z1: -0.0175, r: 0.03 };
const PANEL = { cy: 0.302, w: 0.574, h: 0.1, t: 0.012 };
const PANEL_FRONT = FRONT_Z + PANEL.t;
const PRINT = { w: PANEL.w - 0.006, h: PANEL.h - 0.006 };              // serigrafía del panel
const LCD = { w: 0.19, h: 0.0594, px: [512, 160] };
const DOOR = { w: 0.588, h: 0.586, t: 0.034, hingeY: -0.352, hingeZ: 0.0105 };
const WIN = { w: 0.44, h: 0.29, cy: (CAV.y0 + CAV.y1) / 2 + 0.02 - DOOR.hingeY, r: 0.024 }; // ventana (coords de la puerta)
const HANDLE_Y = DOOR.h - 0.05;
const LEVELS = [-0.1785, -0.0785, 0.0215];                               // alambre de apoyo de cada nivel
const RAIL = { x: 0.234, r: 0.0025, zf: -0.05, zb: -0.452 };
const RACK = { frameR: 0.003, wireR: 0.0021, d: 0.4, z: -0.255 };
const RACK_TOP = LEVELS[1] + RAIL.r + 2 * RACK.frameR;                  // ≈ -0.07 (y mundo ≈ 1.05)
const LAMP = { y: CAV.y1 - 0.05, z: -0.17, r: 0.02 };
const FAN = { y: (CAV.y0 + CAV.y1) / 2, r: 0.086 };
const KNOB = { x: 0.212, r: 0.0215, h: 0.024 };
const OPEN_ANGLE = degToRad(85);
const TEMP_MAX = 250, TEMP_SWEEP = degToRad(270);
const MODE_STEP = degToRad(45);
const MODE = { off: 0, light: 1, fan: 3 };                               // 2 = convencional, 4 = grill (solo serigrafía)
const WINDOW_ALPHA = { dark: 0.86, lit: 0.34 };
const LAMP_INTENSITY = 0.4, HEAT_INTENSITY = 0.55;

/** Apertura de puerta pesada con amortiguador: arranca decidida y se asienta con un rebote mínimo. */
const doorEase = (t) => { const x = t - 1; return 1 + 1.6 * x * x * x + 0.6 * x * x; };

// ---------------------------------------------------------------------------
// Utilidades de geometría
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

/** Añade a `path` un rectángulo redondeado en sentido antihorario. */
function roundedRect(path, x0, y0, x1, y1, r) {
  path.moveTo(x0 + r, y0);
  path.lineTo(x1 - r, y0);
  path.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x1, y1 - r);
  path.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  path.lineTo(x0 + r, y1);
  path.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x0, y0 + r);
  path.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

/** Varilla cilíndrica entre dos puntos. */
function rod(a, b, r, seg = 6) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r, r, dir.length(), seg, 1, false);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** Tubo a lo largo de una polilínea [x, y, z][] con las esquinas redondeadas (resistencias). */
function bentTube(points, cornerR, radius, radialSeg = 8) {
  const P = points.map((p) => new THREE.Vector3(...p));
  const path = new THREE.CurvePath();
  let prev = P[0].clone();
  for (let i = 1; i < P.length - 1; i++) {
    const a = P[i - 1], c = P[i], b = P[i + 1];
    const din = c.clone().sub(a), dout = b.clone().sub(c);
    const r = Math.min(cornerR, din.length() / 2, dout.length() / 2);
    const p1 = c.clone().addScaledVector(din.normalize(), -r);
    const p2 = c.clone().addScaledVector(dout.normalize(), r);
    if (prev.distanceTo(p1) > 1e-5) path.add(new THREE.LineCurve3(prev, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, c.clone(), p2));
    prev = p2;
  }
  path.add(new THREE.LineCurve3(prev, P[P.length - 1]));
  return new THREE.TubeGeometry(path, Math.ceil(path.getLength() / 0.006), radius, radialSeg, false);
}

/** Tubo cerrado siguiendo un rectángulo redondeado en un plano (marco de rejilla, junta). */
function loopTube(x0, a0, x1, a1, r, radius, map, radialSeg = 6) {
  const pts = roundedRect(new THREE.Path(), x0, a0, x1, a1, r).getSpacedPoints(160);
  pts.pop(); // el último repite el primero
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => map(p.x, p.y)), true);
  return new THREE.TubeGeometry(curve, 160, radius, radialSeg, true);
}

/** Paredes interiores de la cavidad: túnel de sección redondeada con normales suaves hacia dentro. */
function tunnelGeometry(x0, y0, x1, y1, r, z0, z1, seg = 8) {
  const pts = [];
  const corners = [[x1 - r, y0 + r, -Math.PI / 2], [x1 - r, y1 - r, 0], [x0 + r, y1 - r, Math.PI / 2], [x0 + r, y0 + r, Math.PI]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= seg; i++) {
      const a = a0 + (i / seg) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), Math.cos(a), Math.sin(a)]);
    }
  }
  const pos = [], nor = [], uv = [], idx = [];
  let s = 0;
  for (let i = 0; i <= pts.length; i++) {
    const p = pts[i % pts.length];
    if (i > 0) { const q = pts[i - 1]; s += Math.hypot(p[0] - q[0], p[1] - q[1]); }
    for (const z of [z0, z1]) { pos.push(p[0], p[1], z); nor.push(-p[2], -p[3], 0); uv.push(s, z - z0); }
  }
  for (let i = 0; i < pts.length; i++) { const a = 2 * i; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

/** ShapeGeometry de un rectángulo redondeado con UV normalizadas 0..1 (para texturas de canvas). */
function cardGeometry(w, h, r, cx = 0, cy = 0) {
  const g = new THREE.ShapeGeometry(roundedRect(new THREE.Shape(), cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r), 10);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, (p.getX(i) - cx + w / 2) / w, (p.getY(i) - cy + h / 2) / h);
  return g;
}

/** Trazo de rectángulo redondeado en un canvas 2D. */
function canvasRoundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const FONT = '"DejaVu Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif';

// ---------------------------------------------------------------------------
// Iconos (canvas): los usan la serigrafía del panel y el LCD
// ---------------------------------------------------------------------------
const ICON = {
  bulb(g, x, y, s) {
    g.beginPath();
    g.arc(x, y - s * 0.12, s * 0.3, Math.PI * 0.78, Math.PI * 2.22);
    g.lineTo(x + s * 0.13, y + s * 0.28);
    g.lineTo(x - s * 0.13, y + s * 0.28);
    g.closePath();
    g.stroke();
    g.beginPath();
    g.moveTo(x - s * 0.11, y + s * 0.4); g.lineTo(x + s * 0.11, y + s * 0.4);
    g.stroke();
  },
  heat(g, x, y, s) {
    for (const dx of [-0.25, 0, 0.25]) {
      g.beginPath();
      for (let i = 0; i <= 12; i++) {
        const t = i / 12, px = x + dx * s + Math.sin(t * TAU) * s * 0.07, py = y + (t - 0.5) * s * 0.8;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.stroke();
    }
  },
  fan(g, x, y, s) {
    for (let i = 0; i < 3; i++) {
      const a = (i * TAU) / 3 - Math.PI / 2;
      g.beginPath();
      g.ellipse(x + Math.cos(a) * s * 0.2, y + Math.sin(a) * s * 0.2, s * 0.21, s * 0.09, a, 0, TAU);
      g.stroke();
    }
    g.beginPath(); g.arc(x, y, s * 0.05, 0, TAU); g.fill();
  },
  clock(g, x, y, s) {
    g.beginPath(); g.arc(x, y, s * 0.38, 0, TAU); g.stroke();
    g.beginPath(); g.moveTo(x, y - s * 0.24); g.lineTo(x, y); g.lineTo(x + s * 0.17, y + s * 0.1); g.stroke();
  },
  arrow(g, x, y, s) {
    g.beginPath();
    g.moveTo(x - s * 0.36, y); g.lineTo(x + s * 0.3, y);
    g.moveTo(x + s * 0.08, y - s * 0.2); g.lineTo(x + s * 0.32, y); g.lineTo(x + s * 0.08, y + s * 0.2);
    g.stroke();
  },
  box(g, x, y, s) { g.strokeRect(x - s * 0.36, y - s * 0.36, s * 0.72, s * 0.72); },
  topBottom(g, x, y, s) {
    ICON.box(g, x, y, s);
    g.fillRect(x - s * 0.36, y - s * 0.36, s * 0.72, s * 0.11);
    g.fillRect(x - s * 0.36, y + s * 0.25, s * 0.72, s * 0.11);
  },
  fanHeat(g, x, y, s) { ICON.box(g, x, y, s); ICON.fan(g, x, y, s * 0.62); g.fillRect(x - s * 0.36, y - s * 0.36, s * 0.72, s * 0.09); g.fillRect(x - s * 0.36, y + s * 0.27, s * 0.72, s * 0.09); },
  grill(g, x, y, s) {
    ICON.box(g, x, y, s);
    g.beginPath();
    for (let i = 0; i <= 6; i++) g.lineTo(x - s * 0.28 + (i * s * 0.56) / 6, y - s * (i % 2 ? 0.14 : 0.24));
    g.stroke();
  },
  power(g, x, y, s) {
    g.beginPath(); g.arc(x, y, s * 0.32, -Math.PI * 0.32, Math.PI * 1.32); g.stroke();
    g.beginPath(); g.moveTo(x, y - s * 0.42); g.lineTo(x, y - s * 0.06); g.stroke();
  },
};

// ---------------------------------------------------------------------------
// Dígitos de 7 segmentos (LCD)
// ---------------------------------------------------------------------------
const SEGMENTS = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', '°': 'abfg', ' ': '' };

/** Dibuja un dígito de segmentos con su esquina inferior izquierda en (x, y), en cursiva. */
function segDigit(g, ch, x, y, w, h, t, color, ghost, glow = 0) {
  const lit = SEGMENTS[ch] ?? '';
  const hw = t / 2, gap = t * 0.24, mid = -h / 2;
  const hor = (yc) => [[gap, yc], [gap + hw, yc - hw], [w - gap - hw, yc - hw], [w - gap, yc], [w - gap - hw, yc + hw], [gap + hw, yc + hw]];
  const ver = (xc, y0, y1) => [[xc, y0], [xc + hw, y0 + hw], [xc + hw, y1 - hw], [xc, y1], [xc - hw, y1 - hw], [xc - hw, y0 + hw]];
  const shapes = {
    a: hor(-h), g: hor(mid), d: hor(0),
    f: ver(0, -h + gap, mid - gap), b: ver(w, -h + gap, mid - gap),
    e: ver(0, mid + gap, -gap), c: ver(w, mid + gap, -gap),
  };
  g.save();
  g.translate(x, y);
  g.transform(1, 0, -0.1, 1, 0, 0);
  for (const pass of [0, 1]) {
    for (const k of 'abcdefg') {
      const on = lit.includes(k);
      if ((pass === 0) === on) continue; // primero los apagados, luego los encendidos con brillo
      g.fillStyle = on ? color : ghost;
      g.shadowColor = color;
      g.shadowBlur = on ? glow : 0;
      g.beginPath();
      shapes[k].forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      g.closePath();
      g.fill();
    }
  }
  g.restore();
}

/** Escribe una cadena de dígitos (y ':' como dos puntos) desde x; devuelve la x final. */
function segString(g, str, x, y, w, h, t, step, color, ghost, glow) {
  for (const ch of str) {
    if (ch === ':') {
      g.save();
      g.fillStyle = g.shadowColor = color;
      g.shadowBlur = color === ghost ? 0 : glow;
      for (const fy of [0.3, 0.72]) { g.beginPath(); g.arc(x + t * 0.6 - fy * h * 0.1, y - h * fy, t * 0.55, 0, TAU); g.fill(); }
      g.restore();
      x += t * 2.2;
    } else {
      segDigit(g, ch, x, y, w, h, t, color, ghost, glow);
      x += step;
    }
  }
  return x;
}

/** Pinta el visor completo a partir del estado (solo se llama cuando cambia). */
function paintLcd(g, w, h, s) {
  const on = s.status !== 'off';
  const AMBER = '#ffb24a', SOFT = 'rgba(255,178,74,0.55)', GHOST = 'rgba(255,170,70,0.07)';
  const main = on ? AMBER : SOFT;
  g.save();
  g.shadowBlur = 0;
  g.fillStyle = '#040302';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,220,180,0.09)';
  g.lineWidth = 2;
  canvasRoundRect(g, 3, 3, w - 6, h - 6, 12);
  g.stroke();

  // Fila superior: LED de estado, texto e iconos
  const led = s.status === 'ready' ? '#7dff9a' : s.status === 'heating' ? '#ff7a2e' : null;
  g.fillStyle = led && s.led ? led : 'rgba(255,255,255,0.07)';
  g.shadowColor = led ?? 'transparent';
  g.shadowBlur = led && s.led ? 14 : 0;
  g.beginPath(); g.arc(28, 28, 7.5, 0, TAU); g.fill();
  g.shadowBlur = 0;
  const label = { off: 'APAGADO', heating: 'CALENTANDO', ready: 'LISTO' }[s.status] ?? '';
  g.font = `bold 17px ${FONT}`;
  if ('letterSpacing' in g) g.letterSpacing = '2px';
  g.fillStyle = on ? (s.status === 'ready' ? '#a8ffbc' : AMBER) : 'rgba(255,178,74,0.32)';
  g.textBaseline = 'middle';
  g.fillText(label, 46, 29);
  g.lineWidth = 2.6;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const icon = (fn, x, lit) => {
    g.strokeStyle = g.fillStyle = lit ? AMBER : GHOST;
    g.shadowColor = AMBER; g.shadowBlur = lit ? 8 : 0;
    fn(g, x, 28, 30);
  };
  icon(ICON.bulb, 402, s.light);
  icon(ICON.heat, 442, s.heat);
  icon(ICON.fan, 482, s.fan);
  g.shadowBlur = 0;

  // Separador
  g.fillStyle = 'rgba(255,178,74,0.1)';
  g.fillRect(270, 56, 2, 90);

  // Temperatura actual (grande)
  const temp = String(clamp(Math.round(s.temp), 0, 999)).padStart(3, ' ');
  segString(g, temp, 30, 146, 42, 86, 10.5, 64, main, GHOST, 12);
  segDigit(g, '°', 226, 92, 17, 34, 6, main, GHOST, 10);

  // Columna derecha: objetivo y temporizador
  const target = on ? String(clamp(Math.round(s.target), 0, 999)).padStart(3, ' ') : '   ';
  g.lineWidth = 3;
  g.strokeStyle = g.fillStyle = on ? AMBER : GHOST;
  ICON.arrow(g, 298, 78, 28);
  segString(g, target, 326, 96, 17, 36, 6, 26, on ? AMBER : GHOST, GHOST, 8);
  segDigit(g, '°', 406, 74, 9, 18, 3.6, on ? AMBER : GHOST, GHOST, 6);
  const timerOn = s.timer !== null;
  g.strokeStyle = g.fillStyle = timerOn ? AMBER : GHOST;
  g.shadowColor = AMBER; g.shadowBlur = timerOn ? 8 : 0;
  ICON.clock(g, 298, 128, 30);
  g.shadowBlur = 0;
  segString(g, timerOn ? s.timer : '88:88', 326, 146, 17, 36, 6, 26, timerOn ? AMBER : GHOST, GHOST, 8);
  g.restore();
}

// ---------------------------------------------------------------------------
// Texturas procedurales
// ---------------------------------------------------------------------------
function makeTextures() {
  // Acero cepillado: vetas horizontales (mismo patrón para color y rugosidad)
  const streaks = (g, w, h, base, spread) => {
    const rng = makeRng(11);
    g.fillStyle = `rgb(${base},${base},${base})`;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const y = rng() * h, x = rng() * w, len = 30 + rng() * 280;
      const v = Math.round(clamp(base + (rng() - 0.5) * 2 * spread, 0, 255));
      g.strokeStyle = `rgba(${v},${v},${v},${0.2 + rng() * 0.5})`;
      g.lineWidth = 0.5 + rng() * 1.2;
      for (const dx of [0, -w]) { g.beginPath(); g.moveTo(x + dx, y); g.lineTo(x + dx + len, y); g.stroke(); }
    }
  };
  const brushedColor = makeCanvasTexture(512, 512, (g, w, h) => streaks(g, w, h, 214, 12), { repeat: [3, 3] });
  const brushedRough = makeCanvasTexture(512, 512, (g, w, h) => streaks(g, w, h, 84, 22), { repeat: [3, 3], srgb: false });

  // Esmalte gris azulado moteado (UV en metros: 1 repetición = 0.25 m)
  const enamel = makeCanvasTexture(512, 512, (g, w, h) => {
    const rng = makeRng(5);
    g.fillStyle = '#2a323d';
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { // manchas suaves muy sutiles
      const x = rng() * w, y = rng() * h, r = 30 + rng() * 70;
      for (const [dx, dy] of [[0, 0], [-w, 0], [0, -h], [-w, -h], [w, 0], [0, h]]) {
        const grd = g.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
        grd.addColorStop(0, rng() < 0.5 ? 'rgba(60,72,88,0.18)' : 'rgba(18,22,28,0.18)');
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grd;
        g.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
      }
    }
    for (let i = 0; i < 12000; i++) {
      const x = rng() * w, y = rng() * h, k = rng();
      g.fillStyle = k < 0.5 ? `rgba(130,145,165,${0.2 + rng() * 0.4})` : k < 0.88 ? 'rgba(8,10,14,0.65)' : 'rgba(215,224,235,0.5)';
      const s = rng() < 0.85 ? 1 : 2;
      g.fillRect(x, y, s, s);
    }
  }, { repeat: [4, 4] });

  // Tapa del ventilador: esmalte con ranuras radiales transparentes (alpha) y tornillos
  const fanCover = makeCanvasTexture(256, 256, (g, w) => {
    const c = w / 2, rng = makeRng(9);
    g.clearRect(0, 0, w, w);
    const grd = g.createRadialGradient(c, c * 0.8, 10, c, c, c);
    grd.addColorStop(0, '#3b4552'); grd.addColorStop(1, '#262d36');
    g.fillStyle = grd;
    g.beginPath(); g.arc(c, c, c - 1, 0, TAU); g.fill();
    for (let i = 0; i < 1600; i++) {
      g.fillStyle = rng() < 0.6 ? 'rgba(160,175,195,0.45)' : 'rgba(8,10,14,0.5)';
      g.fillRect(rng() * w, rng() * w, 1, 1);
    }
    g.globalCompositeOperation = 'destination-out';
    g.lineCap = 'round';
    g.lineWidth = 6.5;
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * TAU;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * c * 0.36, c + Math.sin(a) * c * 0.36);
      g.lineTo(c + Math.cos(a) * c * 0.84, c + Math.sin(a) * c * 0.84);
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 2;
    g.beginPath(); g.arc(c, c, c * 0.93, 0, TAU); g.stroke();
    for (let i = 0; i < 4; i++) { // tornillos
      const a = Math.PI / 4 + (i * Math.PI) / 2, x = c + Math.cos(a) * c * 0.92 * 0.97, y = c + Math.sin(a) * c * 0.92 * 0.97;
      g.fillStyle = '#9aa3ad'; g.beginPath(); g.arc(x, y, 4.5, 0, TAU); g.fill();
      g.strokeStyle = '#3a4048'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x + 3, y); g.stroke();
    }
    g.fillStyle = '#4a5562'; g.beginPath(); g.arc(c, c, c * 0.16, 0, TAU); g.fill();
    g.fillStyle = '#7f8995'; g.beginPath(); g.arc(c, c, c * 0.06, 0, TAU); g.fill();
  });

  // Cara del mando: acero con cepillado concéntrico, ranura indicadora y punto naranja
  const knobFace = makeCanvasTexture(256, 256, (g, w) => {
    const c = w / 2, rng = makeRng(3);
    g.fillStyle = '#c3c7cc';
    g.fillRect(0, 0, w, w);
    for (let i = 0; i < 260; i++) {
      const v = Math.round(170 + rng() * 70);
      g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
      g.lineWidth = 0.6 + rng();
      g.beginPath(); g.arc(c, c, rng() * c, 0, TAU); g.stroke();
    }
    const grd = g.createRadialGradient(c, c, c * 0.8, c, c, c);
    grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.35)');
    g.fillStyle = grd; g.fillRect(0, 0, w, w);
    g.fillStyle = '#16171a';
    canvasRoundRect(g, c - 6, 14, 12, 92, 6); g.fill();
    g.fillStyle = '#ff7b22';
    g.beginPath(); g.arc(c, 26, 6.5, 0, TAU); g.fill();
  });

  return { brushedColor, brushedRough, enamel, fanCover, knobFace, panelPrint: makePanelPrint(), doorPrint: makeDoorPrint() };
}

/** Serigrafía del panel de mandos: escala de temperatura, iconos de funciones y teclas táctiles. */
function makePanelPrint() {
  return makeCanvasTexture(1024, 170, (g, w, h) => {
    const sx = w / PRINT.w, sy = h / PRINT.h;
    const P = (x, y) => [w / 2 + x * sx, h / 2 - y * sy];
    g.fillStyle = '#0b0c0e';
    g.fillRect(0, 0, w, h);
    const sheen = g.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255,255,255,0.05)'); sheen.addColorStop(0.45, 'rgba(255,255,255,0)');
    g.fillStyle = sheen; g.fillRect(0, 0, w, h);
    const ink = '#d4d7dc', inkDim = '#7d838c';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    // Escala de temperatura alrededor del mando derecho (0 arriba, sentido horario)
    const [tx, ty] = P(KNOB.x, 0);
    for (let T = 0; T <= TEMP_MAX; T += 25) {
      const a = (T / TEMP_MAX) * TEMP_SWEEP, major = T % 50 === 0;
      const r1 = (major ? 0.0262 : 0.0268) * sx, r2 = (major ? 0.0306 : 0.0288) * sx;
      g.strokeStyle = major ? ink : inkDim;
      g.lineWidth = major ? 2.6 : 1.5;
      g.beginPath();
      g.moveTo(tx + r1 * Math.sin(a), ty - r1 * Math.cos(a));
      g.lineTo(tx + r2 * Math.sin(a), ty - r2 * Math.cos(a));
      g.stroke();
      if (!major) continue;
      const rl = 0.0378 * sx, lx = tx + rl * Math.sin(a), ly = ty - rl * Math.cos(a);
      if (T === 0) { g.lineWidth = 2; g.beginPath(); g.arc(lx, ly, 4.5, 0, TAU); g.stroke(); }
      else { g.fillStyle = ink; g.font = `600 ${T >= 100 ? 13 : 14}px ${FONT}`; g.fillText(String(T), lx, ly + 1); }
    }
    g.fillStyle = inkDim;
    g.font = `600 12px ${FONT}`;
    g.fillText('°C', tx + 0.034 * sx, ty + 0.03 * sy);

    // Funciones alrededor del mando izquierdo
    const [mx, my] = P(-KNOB.x, 0);
    const icons = [null, ICON.bulb, ICON.topBottom, ICON.fanHeat, ICON.grill];
    icons.forEach((fn, i) => {
      const a = i * MODE_STEP, rd = 0.0284 * sx, ri = 0.0385 * sx;
      g.fillStyle = ink;
      g.beginPath(); g.arc(mx + rd * Math.sin(a), my - rd * Math.cos(a), 2.4, 0, TAU); g.fill();
      const ix = mx + ri * Math.sin(a), iy = my - ri * Math.cos(a);
      g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1.8;
      if (fn) fn(g, ix, iy, 17);
      else { g.font = `600 14px ${FONT}`; g.fillText('0', ix, iy + 1); }
    });

    // Teclas táctiles decorativas junto al visor
    g.strokeStyle = inkDim; g.fillStyle = inkDim; g.lineWidth = 2;
    const keys = [[-0.113, ICON.bulb], [-0.138, ICON.power], [0.113, ICON.clock], [0.138, null]];
    for (const [x, fn] of keys) {
      const [kx, ky] = P(x, 0);
      if (fn) fn(g, kx, ky, 22);
      else { g.font = `600 20px ${FONT}`; g.fillText('±', kx, ky + 1); }
    }
  });
}

/** Cristal exterior de la puerta: borde serigrafiado opaco, trama de puntos degradada y ventana (alfa 0). */
function makeDoorPrint() {
  const gw = DOOR.w - 0.004, gh = DOOR.h - 0.004;
  return makeCanvasTexture(1024, 1024, (g, w, h) => {
    const sx = w / gw, sy = h / gh;
    const cy = WIN.cy - DOOR.h / 2; // centro de la ventana respecto al centro del cristal
    const P = (x, y) => [w / 2 + x * sx, h / 2 - y * sy];
    g.fillStyle = '#0a0b0d';
    g.fillRect(0, 0, w, h);
    // Ventana transparente
    const [wx, wy] = P(-WIN.w / 2, cy + WIN.h / 2);
    g.globalCompositeOperation = 'destination-out';
    canvasRoundRect(g, wx, wy, WIN.w * sx, WIN.h * sy, WIN.r * sx);
    g.fill();
    g.globalCompositeOperation = 'source-over';
    // Trama de puntos que se desvanece hacia el centro de la ventana
    const band = 0.024, step = 0.0034, hx = WIN.w / 2, hy = WIN.h / 2;
    const inside = (x, y) => { // distancia con signo al borde (positiva dentro)
      const qx = Math.abs(x) - (hx - WIN.r), qy = Math.abs(y - cy) - (hy - WIN.r);
      return -(Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - WIN.r);
    };
    g.fillStyle = '#0a0b0d';
    let row = 0;
    for (let y = cy - hy; y <= cy + hy; y += step * 0.866, row++) {
      for (let x = -hx + (row % 2) * step * 0.5; x <= hx; x += step) {
        const d = inside(x, y);
        if (d <= 0 || d >= band) continue;
        const r = Math.pow(1 - d / band, 1.3) * step * 0.66 * sx;
        if (r < 0.4) continue;
        const [px, py] = P(x, y);
        g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
      }
    }
    // Marca discreta bajo el tirador
    const [bx, by] = P(0, (WIN.cy + WIN.h / 2 + HANDLE_Y - 0.012) / 2 - DOOR.h / 2);
    g.fillStyle = 'rgba(190,194,200,0.75)';
    g.font = `600 17px ${FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = '7px';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('PAN CASERO', bx + 3.5, by);
  });
}

// ---------------------------------------------------------------------------
// Materiales
// ---------------------------------------------------------------------------
function makeMaterials(T) {
  const steel = new THREE.MeshStandardMaterial({
    color: 0xe2e5e9, map: T.brushedColor, roughnessMap: T.brushedRough, roughness: 1, metalness: 1, envMapIntensity: 1.1,
  });
  const blackGlass = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 });
  return {
    steel,
    housing: new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6, metalness: 0.5 }),
    enamel: new THREE.MeshPhysicalMaterial({ color: 0xdfe3ea, map: T.enamel, roughness: 0.45, metalness: 0.05, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 0.55 }),
    fanCover: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: T.fanCover, alphaTest: 0.5, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.25 }),
    fan: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.4 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xaeb3b9, roughness: 0.2, metalness: 1 }),
    element: new THREE.MeshStandardMaterial({ color: 0x3a3836, roughness: 0.5, metalness: 0.6, emissive: 0xff4a12, emissiveIntensity: 0 }),
    lampGlass: new THREE.MeshPhysicalMaterial({ color: 0xfff4e0, roughness: 0.15, transparent: true, opacity: 0.8, emissive: 0xffd49a, emissiveIntensity: 0, clearcoat: 1 }),
    gasket: new THREE.MeshStandardMaterial({ color: 0x2b2c2e, roughness: 0.92, metalness: 0 }),
    blackGlass,
    panelPrint: new THREE.MeshPhysicalMaterial({ color: 0xffffff, map: T.panelPrint, roughness: 0.12, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04 }),
    lcd: new THREE.MeshStandardMaterial({ color: 0x050403, roughness: 0.22, metalness: 0, emissive: 0xffffff, emissiveMap: null, emissiveIntensity: 1.5 }),
    knobSteel: new THREE.MeshStandardMaterial({ color: 0xd9dce0, map: T.brushedColor, roughnessMap: T.brushedRough, roughness: 0.85, metalness: 1 }),
    knobFace: new THREE.MeshStandardMaterial({ color: 0xffffff, map: T.knobFace, roughness: 0.32, metalness: 1 }),
    doorSteel: steel.clone(),
    doorInner: new THREE.MeshStandardMaterial({ color: 0x2c3036, roughness: 0.45, metalness: 0.3 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xffffff, map: T.doorPrint, roughness: 0.05, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.7,
    }),
    innerGlass: new THREE.MeshPhysicalMaterial({ color: 0x3c4348, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.3, depthWrite: false }),
  };
}

/**
 * El cristal de la puerta usa el alfa de su textura (borde serigrafiado opaco) pero la ventana nunca
 * baja de `uWindowAlpha`: así se oscurece o aclara sin redibujar la textura.
 */
function patchDoorGlass(material, uniform) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindowAlpha = uniform;
    shader.fragmentShader = 'uniform float uWindowAlpha;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n\tdiffuseColor.a = max( diffuseColor.a, uWindowAlpha );',
    );
  };
  material.customProgramCacheKey = () => 'oven-door-glass';
}

// ---------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------
function mesh(geo, mat, { cast = false, receive = false, name } = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  if (name) m.name = name;
  return m;
}

/** Carcasa, marco frontal de acero, cavidad esmaltada, junta y ventilador trasero. */
function buildBody(M) {
  const group = new THREE.Group();
  // Caja exterior sin cara frontal (solo se ve si el horno está fuera del hueco)
  const housing = new THREE.BoxGeometry(OVEN.width - 0.01, OVEN.height - 0.01, OVEN.depth - 0.02);
  const front = housing.groups[4]; // orden de BoxGeometry: +x, -x, +y, -y, +z, -z
  const idx = Array.from(housing.index.array);
  idx.splice(front.start, front.count);
  housing.setIndex(idx);
  housing.clearGroups();
  housing.translate(0, 0, FASCIA.back - (OVEN.depth - 0.02) / 2);
  group.add(mesh(housing, M.housing));

  // Marco frontal de acero con la boca de la cavidad
  const bs = 0.003;
  const frame = roundedRect(new THREE.Shape(), -FASCIA.w / 2 + bs, -FASCIA.h / 2 + bs, FASCIA.w / 2 - bs, FASCIA.h / 2 - bs, 0.004);
  frame.holes.push(roundedRect(new THREE.Path(), CAV.x0 - bs, CAV.y0 - bs, CAV.x1 + bs, CAV.y1 + bs, CAV.r + bs));
  const fascia = new THREE.ExtrudeGeometry(frame, {
    depth: FRONT_Z - FASCIA.back - 2 * bs, bevelEnabled: true, bevelThickness: bs, bevelSize: bs, bevelSegments: 2, curveSegments: 10,
  });
  fascia.translate(0, 0, FASCIA.back + bs);
  group.add(mesh(fascia, M.steel, { receive: true, name: 'oven-fascia' }));

  // Cavidad: túnel + fondo + aro del ventilador
  const back = new THREE.ShapeGeometry(roundedRect(new THREE.Shape(), CAV.x0, CAV.y0, CAV.x1, CAV.y1, CAV.r), 8);
  back.translate(0, 0, CAV.z0);
  const ring = new THREE.CylinderGeometry(FAN.r, FAN.r + 0.008, 0.012, 48, 1, true);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, FAN.y, CAV.z0 + 0.006);
  const cavity = mergeGeometries([tunnelGeometry(CAV.x0, CAV.y0, CAV.x1, CAV.y1, CAV.r, CAV.z0, CAV.z1), back, ring]);
  group.add(mesh(cavity, M.enamel, { receive: true, name: 'oven-cavity' }));

  // Junta de la puerta alrededor de la boca
  const o = 0.012;
  const gasket = loopTube(CAV.x0 - o, CAV.y0 - o, CAV.x1 + o, CAV.y1 + o, CAV.r + o, 0.003, (x, y) => new THREE.Vector3(x, y, FRONT_Z + 0.0015));
  group.add(mesh(gasket, M.gasket));

  // Tapa del ventilador (ranuras con alphaTest) y aspas detrás, que giran
  const cover = new THREE.CircleGeometry(FAN.r, 48);
  cover.translate(0, FAN.y, CAV.z0 + 0.012);
  group.add(mesh(cover, M.fanCover));
  const fan = new THREE.Mesh(buildFanGeometry(), M.fan);
  fan.position.set(0, FAN.y, CAV.z0 + 0.002);
  group.add(fan);
  return { group, fan };
}

/** Disco oscuro de fondo + aspas curvas claras (colores por vértice, una sola llamada de dibujo). */
function buildFanGeometry() {
  const paint = (geo, hex) => {
    const c = new THREE.Color(hex), n = geo.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.toArray(arr, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };
  const parts = [paint(new THREE.CircleGeometry(FAN.r * 0.95, 40), 0x0c0e11)];
  for (let i = 0; i < 7; i++) {
    const s = new THREE.Shape();
    s.moveTo(0.012, -0.006);
    s.quadraticCurveTo(0.05, -0.02, 0.074, 0.004);
    s.quadraticCurveTo(0.05, 0.004, 0.012, 0.008);
    s.closePath();
    const blade = new THREE.ShapeGeometry(s, 6);
    blade.rotateZ((i / 7) * TAU);
    blade.translate(0, 0, 0.004);
    parts.push(paint(blade, 0x9aa1aa));
  }
  const hub = new THREE.CircleGeometry(0.016, 20);
  hub.translate(0, 0, 0.0045);
  parts.push(paint(hub, 0xb5bcc4));
  return mergeGeometries(parts);
}

/** Guías laterales, rejilla, soportes de resistencias y aro de la lámpara (todo cromado, una malla). */
function buildChrome() {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const parts = [];
  // Guías laterales: dos postes y un alambre por nivel en cada lado
  for (const sx of [-1, 1]) {
    const x = sx * RAIL.x, xw = sx * (CAV.x1 - 0.001), yb = LEVELS[0] - 0.035, yt = LEVELS[2] + 0.03;
    for (const z of [RAIL.zf, RAIL.zb]) {
      parts.push(rod(V(x, yb, z), V(x, yt, z), 0.0028));
      for (const y of [yb + 0.01, yt - 0.01]) parts.push(rod(V(x, y, z), V(xw, y, z), 0.0024));
    }
    for (const y of LEVELS) {
      parts.push(rod(V(x, y, RAIL.zf + 0.012), V(x, y, RAIL.zb), RAIL.r));
      const tip = new THREE.SphereGeometry(RAIL.r, 8, 6);
      tip.translate(x, y, RAIL.zf + 0.012);
      parts.push(tip);
    }
  }
  // Rejilla en el nivel central: marco + alambres de delante a atrás + dos travesaños
  const fy = LEVELS[1] + RAIL.r + RACK.frameR, z0 = RACK.z - RACK.d / 2, z1 = RACK.z + RACK.d / 2;
  parts.push(loopTube(-RAIL.x, z0, RAIL.x, z1, 0.018, RACK.frameR, (x, z) => V(x, fy, z)));
  const wy = fy + RACK.frameR - RACK.wireR;
  const nWires = 17;
  for (let i = 1; i <= nWires; i++) {
    const x = -RAIL.x + (i * 2 * RAIL.x) / (nWires + 1);
    parts.push(rod(V(x, wy, z0), V(x, wy, z1), RACK.wireR, 5));
  }
  for (const z of [z0 + 0.07, z1 - 0.07]) parts.push(rod(V(-RAIL.x, fy - 0.004, z), V(RAIL.x, fy - 0.004, z), 0.0024, 5));
  // Soportes de las resistencias
  const yTop = CAV.y1 - 0.018, yBot = CAV.y0 + 0.014;
  for (const z of [-0.13, -0.33]) {
    parts.push(rod(V(-0.22, yTop + 0.006, z), V(0.22, yTop + 0.006, z), 0.002, 5));
    for (const x of [-0.16, 0.16]) parts.push(rod(V(x, yTop + 0.006, z), V(x, CAV.y1, z), 0.002, 5));
    for (const x of [-0.12, 0.12]) parts.push(rod(V(x, CAV.y0, z), V(x, yBot - 0.004, z), 0.0022, 5));
  }
  // Aro de la lámpara (pared izquierda)
  const bezel = new THREE.TorusGeometry(LAMP.r + 0.0015, 0.0025, 8, 32);
  bezel.rotateY(Math.PI / 2);
  bezel.translate(CAV.x0 + 0.001, LAMP.y, LAMP.z);
  parts.push(bezel);
  return mergeGeometries(parts);
}

/** Resistencias superior e inferior en serpentín (una malla, un material emisivo). */
function buildElements() {
  const B = CAV.z0 - 0.004, yT = CAV.y1 - 0.018, yB = CAV.y0 + 0.014;
  const top = bentTube([
    [-0.2, yT, B], [-0.2, yT, -0.07], [-0.07, yT, -0.07], [-0.07, yT, -0.4],
    [0.07, yT, -0.4], [0.07, yT, -0.07], [0.2, yT, -0.07], [0.2, yT, B],
  ], 0.045, 0.0045);
  const bottom = bentTube([
    [-0.17, yB, B], [-0.17, yB, -0.09], [-0.056, yB, -0.09], [-0.056, yB, -0.37],
    [0.056, yB, -0.37], [0.056, yB, -0.09], [0.17, yB, -0.09], [0.17, yB, B],
  ], 0.04, 0.0045);
  return mergeGeometries([top, bottom]);
}

/** Panel de mandos: cristal negro, serigrafía, visor LCD y dos mandos con su aro. */
function buildPanel(M, lcdTex) {
  const group = new THREE.Group();
  const glass = new RoundedBoxGeometry(PANEL.w, PANEL.h, PANEL.t, 2, 0.003);
  glass.translate(0, PANEL.cy, FRONT_Z + PANEL.t / 2);
  const vent = new THREE.BoxGeometry(0.5, 0.0045, 0.002); // rejilla de ventilación sobre la puerta
  vent.translate(0, (DOOR.hingeY + DOOR.h + PANEL.cy - PANEL.h / 2) / 2, FRONT_Z + 0.0002);
  group.add(mesh(mergeGeometries([glass, vent.toNonIndexed()]), M.blackGlass));

  const print = new THREE.PlaneGeometry(PRINT.w, PRINT.h);
  print.translate(0, PANEL.cy, PANEL_FRONT + 0.0003);
  group.add(mesh(print, M.panelPrint));

  M.lcd.emissiveMap = lcdTex;
  const lcd = new THREE.PlaneGeometry(LCD.w, LCD.h);
  lcd.translate(0, PANEL.cy, PANEL_FRONT + 0.0006);
  group.add(mesh(lcd, M.lcd, { name: 'oven-lcd' }));

  // Aros cromados de los mandos
  const bezels = [-1, 1].map((sx) => {
    const t = new THREE.TorusGeometry(KNOB.r + 0.0045, 0.0017, 8, 48);
    t.translate(sx * KNOB.x, PANEL.cy, PANEL_FRONT + 0.0006);
    return t;
  });
  group.add(mesh(mergeGeometries(bezels), M.chrome));

  // Mandos: cuerpo torneado + cara con indicador (materiales propios para poder resaltarlos)
  const profile = [
    [0.0246, 0], [0.0246, 0.0022], [0.0236, 0.0032], [0.0222, 0.0046], [KNOB.r, 0.0062],
    [KNOB.r, 0.0196], [KNOB.r - 0.0006, 0.0222], [KNOB.r - 0.0018, 0.0236], [KNOB.r - 0.0026, KNOB.h],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const bodyGeo = new THREE.LatheGeometry(profile, 56);
  bodyGeo.rotateX(Math.PI / 2);
  const faceGeo = new THREE.CircleGeometry(KNOB.r - 0.0026, 48);
  faceGeo.translate(0, 0, KNOB.h);
  const knob = (x, part) => {
    const k = new THREE.Group();
    k.position.set(x, PANEL.cy, PANEL_FRONT);
    const body = mesh(bodyGeo, M.knobSteel.clone(), { name: `oven-${part}-body` });
    const face = mesh(faceGeo, M.knobFace.clone(), { name: `oven-${part}-face` });
    body.userData.ovenPart = face.userData.ovenPart = part;
    k.add(body, face);
    k.name = `oven-${part}`;
    group.add(k);
    return k;
  };
  return { group, modeKnob: knob(-KNOB.x, 'modeKnob'), tempKnob: knob(KNOB.x, 'tempKnob') };
}

/** Puerta abatible: armazón con ventana, cristal serigrafiado, cristal interior y tirador. */
function buildDoor(M) {
  const pivot = new THREE.Group(); // bisagra en el borde inferior trasero
  pivot.position.set(0, DOOR.hingeY, DOOR.hingeZ);
  pivot.name = 'oven-door';

  const bs = 0.002;
  const outline = roundedRect(new THREE.Shape(), -DOOR.w / 2 + bs, bs, DOOR.w / 2 - bs, DOOR.h - bs, 0.006);
  outline.holes.push(roundedRect(new THREE.Path(), -WIN.w / 2 - bs, WIN.cy - WIN.h / 2 - bs, WIN.w / 2 + bs, WIN.cy + WIN.h / 2 + bs, WIN.r + bs));
  const shellGeo = new THREE.ExtrudeGeometry(outline, {
    depth: DOOR.t - 2 * bs, bevelEnabled: true, bevelThickness: bs, bevelSize: bs, bevelSegments: 2, curveSegments: 10,
  });
  shellGeo.translate(0, 0, bs);
  const shell = mesh(shellGeo, [M.doorInner, M.doorSteel], { cast: true, name: 'oven-door-shell' });

  const glass = mesh(cardGeometry(DOOR.w - 0.004, DOOR.h - 0.004, 0.005, 0, DOOR.h / 2), M.glass, { name: 'oven-door-glass' });
  glass.position.z = DOOR.t + 0.0004;

  const innerGeo = cardGeometry(WIN.w + 0.03, WIN.h + 0.03, WIN.r + 0.01, 0, WIN.cy);
  innerGeo.rotateY(Math.PI);
  const inner = mesh(innerGeo, M.innerGlass);
  inner.position.z = -0.0006;

  // Tirador: barra con extremos redondeados sobre dos soportes torneados
  const bar = new THREE.CapsuleGeometry(0.0105, 0.47, 6, 20);
  bar.rotateZ(Math.PI / 2);
  bar.translate(0, HANDLE_Y, DOOR.t + 0.052);
  const standoffProfile = [[0.0102, 0], [0.0102, 0.0035], [0.0084, 0.012], [0.0074, 0.052]].map(([r, y]) => new THREE.Vector2(r, y));
  const parts = [bar];
  for (const x of [-0.205, 0.205]) {
    const s = new THREE.LatheGeometry(standoffProfile, 20);
    s.rotateX(Math.PI / 2);
    s.translate(x, HANDLE_Y, DOOR.t);
    parts.push(s);
  }
  const handle = mesh(mergeGeometries(parts), M.doorSteel, { cast: true, name: 'oven-handle' });

  // Halo del tirador para el resalte (brillo de contorno aditivo; oculto por defecto)
  const haloGeo = new THREE.CapsuleGeometry(0.0155, 0.47, 6, 20);
  haloGeo.rotateZ(Math.PI / 2);
  haloGeo.translate(0, HANDLE_Y, DOOR.t + 0.052);
  const halo = mesh(haloGeo, makeHaloMaterial(0xffb35c));
  halo.visible = false;
  halo.raycast = () => {}; // no debe interceptar clics

  for (const m of [shell, glass, handle]) m.userData.ovenPart = 'door';
  pivot.add(shell, inner, glass, handle, halo);
  return { pivot, handle, glass, shell, halo };
}

/** Material de halo: más intenso en el contorno (fresnel), mezcla aditiva. */
function makeHaloMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: 1 } },
    vertexShader: /* glsl */`
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        gl_FragColor = vec4(uColor * uStrength * (0.1 + 1.4 * f * f), 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// ---------------------------------------------------------------------------
// Vapor interior (Points con shader propio: tamaño y alfa por partícula)
// ---------------------------------------------------------------------------
const STEAM_CENTER = new THREE.Vector3(0, (CAV.y0 + CAV.y1) / 2, RACK.z);

function createSteam() {
  const N = 56, rng = makeRng(23);
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), size = new Float32Array(N), alpha = new Float32Array(N), seed = new Float32Array(N);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1).setUsage(THREE.DynamicDrawUsage));
  const uniforms = { uColor: { value: new THREE.Color(1, 1, 1) }, uScale: { value: 500 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      attribute float aSize;
      attribute float aAlpha;
      attribute float aSeed;
      uniform float uScale;
      varying float vAlpha;
      varying float vSeed;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uScale / max(0.05, -mv.z);
        vAlpha = aAlpha;
        vSeed = aSeed;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vAlpha;
      varying float vSeed;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
      void main() {
        vec2 uv = gl_PointCoord - 0.5;
        float d = length(uv) * 2.0;
        float a = 1.0 - smoothstep(0.0, 1.0, d);
        // jirones: ruido que se deforma con la edad de cada partícula
        float n = vnoise(uv * 3.2 + vec2(vSeed, vSeed * 0.7)) * 0.65 + vnoise(uv * 7.0 - vec2(vSeed * 1.3, vSeed)) * 0.35;
        a *= a * smoothstep(0.22, 0.78, n);
        gl_FragColor = vec4(uColor, a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geo, material);
  points.position.copy(STEAM_CENTER);
  points.frustumCulled = false;
  points.name = 'oven-steam';

  const P = Array.from({ length: N }, () => ({ alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, s0: 0.05, a0: 0.2, seed: 0 }));
  let acc = 0;

  const spawn = (burst = false) => {
    const p = P.find((q) => !q.alive);
    if (!p) return;
    const fromFloor = !burst && rng() < 0.35;
    p.alive = true;
    p.age = 0;
    p.seed = rng() * 100;
    if (burst) { // bocanada que escapa por la parte alta de la boca
      p.x = (rng() - 0.5) * 0.36; p.y = CAV.y1 - 0.04 - rng() * 0.06; p.z = CAV.z1 - 0.04 - rng() * 0.08;
      p.vx = (rng() - 0.5) * 0.06; p.vy = 0.08 + rng() * 0.08; p.vz = 0.25 + rng() * 0.2;
      p.life = 1.5 + rng() * 0.9; p.s0 = 0.1 + rng() * 0.07; p.a0 = 0.7;
    } else {
      p.x = (rng() - 0.5) * 0.3;
      p.y = fromFloor ? CAV.y0 + 0.03 : RACK_TOP + 0.03 + rng() * 0.06;
      p.z = RACK.z + (rng() - 0.5) * 0.24;
      p.vx = (rng() - 0.5) * 0.02; p.vy = 0.03 + rng() * 0.035; p.vz = (rng() - 0.5) * 0.02;
      p.life = 2.4 + rng() * 1.8; p.s0 = 0.06 + rng() * 0.05; p.a0 = 0.4 + rng() * 0.2;
    }
  };

  return {
    points,
    uniforms,
    /** Avanza el vapor. level: 0..1, open01: apertura de la puerta 0..1. */
    update(dt, level, open01, elapsed) {
      const open = open01 > 0.12;
      acc += dt * level * (open ? 5 : 16);
      while (acc >= 1) { acc -= 1; spawn(); }
      if (!points.visible && acc < 1 && level <= 0) return; // nada vivo ni por nacer: sin subir buffers
      let any = false;
      for (let i = 0; i < N; i++) {
        const p = P[i];
        if (!p.alive) { size[i] = 0; alpha[i] = 0; continue; }
        p.age += dt * (open && p.z > CAV.z1 ? 1.6 : 1);
        if (p.age >= p.life) { p.alive = false; size[i] = 0; alpha[i] = 0; continue; }
        any = true;
        // remolino suave + flotación
        p.vx += Math.sin(elapsed * 0.9 + p.seed) * 0.03 * dt;
        p.vz += Math.cos(elapsed * 0.7 + p.seed * 1.3) * 0.02 * dt;
        p.vy += 0.012 * dt;
        if (open) { p.vz += 0.4 * open01 * dt; p.vy += 0.1 * dt; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        // con la puerta cerrada el vapor se queda dentro de la cavidad
        if (p.y > CAV.y1 - 0.035 && p.z < CAV.z1) { p.y = CAV.y1 - 0.035; p.vy *= -0.2; p.vx *= 1.02; }
        if (Math.abs(p.x) > 0.21) { p.x = Math.sign(p.x) * 0.21; p.vx *= -0.5; }
        if (p.z < CAV.z0 + 0.04) { p.z = CAV.z0 + 0.04; p.vz = Math.abs(p.vz) * 0.5; }
        if (!open && p.z > CAV.z1 - 0.04) { p.z = CAV.z1 - 0.04; p.vz = -Math.abs(p.vz) * 0.5; }
        const t = p.age / p.life;
        pos[i * 3] = p.x - STEAM_CENTER.x; pos[i * 3 + 1] = p.y - STEAM_CENTER.y; pos[i * 3 + 2] = p.z - STEAM_CENTER.z;
        size[i] = p.s0 * (1 + t * 1.8);
        alpha[i] = p.a0 * Math.pow(Math.sin(Math.PI * t), 1.2);
        seed[i] = p.seed + p.age * 0.6;
      }
      points.visible = any;
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aSize.needsUpdate = true;
      geo.attributes.aAlpha.needsUpdate = true;
      geo.attributes.aSeed.needsUpdate = true;
    },
    /** Lanza una bocanada hacia fuera (al abrir la puerta con vapor). */
    burst(count) { for (let i = 0; i < count; i++) spawn(true); points.visible = true; },
    /** Elimina todo el vapor al instante. */
    clear() { for (const p of P) p.alive = false; size.fill(0); alpha.fill(0); points.visible = false; },
  };
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------
/**
 * Crea el horno empotrado. El grupo se coloca en OVEN.front (centro de la cara frontal) mirando a +Z.
 * @param {{engine?: object, scene?: THREE.Scene, camera?: THREE.Camera, renderer?: THREE.WebGLRenderer,
 *   particles?: object, audio?: object}} ctx
 * @returns {{group: THREE.Group, update(dt: number, elapsed: number): void,
 *   anchors: {rack: THREE.Object3D, doorFront: THREE.Object3D}, interactive: THREE.Object3D[],
 *   readonly isOpen: boolean, readonly doorOpen01: number,
 *   openDoor(duration?: number): Promise<boolean>, closeDoor(duration?: number): Promise<boolean>,
 *   setLight(on: boolean): void, setHeat(level01: number): void, setTemperature(celsius: number): void,
 *   setTargetTemperature(celsius: number): void, setTimer(minutes: number|null): void,
 *   setStatus(status: 'off'|'heating'|'ready'): void, setSteam(level01: number): void,
 *   setHighlight(part: 'door'|'tempKnob'|'modeKnob'|null): void,
 *   getWindowView(): {position: THREE.Vector3, target: THREE.Vector3}, reset(): void}}
 */
export function createOven(ctx = {}) {
  const group = new THREE.Group();
  group.name = 'oven';
  group.position.copy(OVEN.front);

  const T = makeTextures();
  const M = makeMaterials(T);
  const windowAlpha = { value: WINDOW_ALPHA.dark };
  patchDoorGlass(M.glass, windowAlpha);

  const body = buildBody(M);
  group.add(body.group);
  group.add(mesh(buildChrome(), M.chrome, { name: 'oven-racks' }));
  group.add(mesh(buildElements(), M.element, { name: 'oven-elements' }));

  // Lámpara interior: cúpula de cristal en la pared izquierda
  const domeGeo = new THREE.SphereGeometry(LAMP.r, 24, 10, 0, TAU, 0, Math.PI / 2);
  domeGeo.scale(1, 0.55, 1);
  domeGeo.rotateZ(-Math.PI / 2);
  const dome = mesh(domeGeo, M.lampGlass, { name: 'oven-lamp' });
  dome.position.set(CAV.x0 + 0.001, LAMP.y, LAMP.z);
  group.add(dome);

  const lampLight = new THREE.PointLight(0xffd8a0, 0, 0.95, 2);
  lampLight.position.set(CAV.x0 + 0.06, LAMP.y - 0.01, LAMP.z);
  const heatLight = new THREE.PointLight(0xff6a24, 0, 0.9, 2);
  heatLight.position.set(0, CAV.y1 - 0.05, RACK.z);
  group.add(lampLight, heatLight);

  const lcdTex = makeCanvasTexture(LCD.px[0], LCD.px[1], () => {});
  const lcdCtx = lcdTex.image.getContext('2d');
  const panel = buildPanel(M, lcdTex);
  group.add(panel.group);

  const door = buildDoor(M);
  group.add(door.pivot);

  const steam = createSteam();
  group.add(steam.points);

  // Anclas
  const rackAnchor = new THREE.Object3D();
  rackAnchor.name = 'oven-anchor-rack';
  rackAnchor.position.set(0, RACK_TOP, RACK.z);
  const doorFrontAnchor = new THREE.Object3D();
  doorFrontAnchor.name = 'oven-anchor-doorFront';
  doorFrontAnchor.position.set(0, RACK_TOP, 0.35);
  group.add(rackAnchor, doorFrontAnchor);

  const highlighters = {
    door: makeHighlighter(door.handle), // el acero de la puerta (tirador y cantos) es un material propio
    tempKnob: makeHighlighter(panel.tempKnob),
    modeKnob: makeHighlighter(panel.modeKnob),
  };

  // --- Estado ---
  const s = {
    isOpen: false, doorAngle: 0, doorAnim: null, puffed: false,
    light: false, lightLevel: 0,
    heatTarget: 0, heat: 0,
    steam: 0,
    temp: 20, target: 220, timer: null, status: 'off',
    tempKnobAngle: 0, modeKnobAngle: 0, fanSpeed: 0,
    ledOn: true, lcdKey: '', failed: false,
  };

  const setDoorAngle = (a) => { s.doorAngle = a; door.pivot.rotation.x = a; };

  const redrawLcd = () => {
    const state = {
      temp: s.temp, target: s.target, timer: s.timer, status: s.status, led: s.ledOn,
      light: s.light, heat: s.heatTarget > 0.02, fan: s.fanSpeed > 0.5,
    };
    const key = JSON.stringify(state);
    if (key === s.lcdKey) return;
    s.lcdKey = key;
    paintLcd(lcdCtx, LCD.px[0], LCD.px[1], state);
    lcdTex.needsUpdate = true;
  };

  const animateDoor = (to, duration, easing, onDone) => {
    s.doorAnim?.cancel();
    const from = s.doorAngle;
    const span = Math.abs(to - from) / OPEN_ANGLE;
    if (span < 1e-3) { setDoorAngle(to); s.doorAnim = null; return Promise.resolve(true); }
    const dur = Math.max(0.15, (Number.isFinite(duration) ? duration : 0.9) * span);
    const p = animate({ duration: dur, ease: easing, tag: 'oven-door', onUpdate: (t) => setDoorAngle(lerp(from, to, t)) });
    s.doorAnim = p;
    return p.then((done) => {
      if (s.doorAnim === p) s.doorAnim = null;
      if (done) onDone?.();
      return done;
    });
  };

  const modeTarget = () => {
    if (s.status !== 'off' || s.heatTarget > 0.02) return MODE.fan;
    return s.light ? MODE.light : MODE.off;
  };

  redrawLcd();

  const api = {
    group,
    anchors: { rack: rackAnchor, doorFront: doorFrontAnchor },
    interactive: [door.handle, door.glass, door.shell, ...panel.tempKnob.children, ...panel.modeKnob.children],

    /** Estado objetivo de la puerta (true desde que se llama a openDoor hasta closeDoor). */
    get isOpen() { return s.isOpen; },
    /** Apertura real de la puerta en este instante, 0..1. */
    get doorOpen01() { return s.doorAngle / OPEN_ANGLE; },

    /** Abre la puerta (abate hacia +Z sobre la bisagra inferior). Resuelve true al terminar. */
    openDoor(duration = 0.9) {
      if (!s.isOpen) ctx.audio?.play('oven-open');
      s.isOpen = true;
      s.puffed = false;
      return animateDoor(OPEN_ANGLE, duration, doorEase);
    },

    /** Cierra la puerta; suena el golpe al encajar. Resuelve true al terminar. */
    closeDoor(duration = 0.7) {
      s.isOpen = false;
      return animateDoor(0, duration, ease.inOutCubic, () => ctx.audio?.play('oven-close'));
    },

    /** Lámpara interior encendida/apagada (el cristal se aclara con la luz). */
    setLight(on) { s.light = !!on; },

    /** Calor 0..1: las resistencias pasan de gris a naranja y el interior se calienta de color. */
    setHeat(level01) { if (Number.isFinite(level01)) s.heatTarget = clamp(level01); },

    /** Temperatura actual en el visor (número grande). */
    setTemperature(celsius) { if (Number.isFinite(celsius)) s.temp = Math.round(celsius); },

    /** Temperatura elegida: gira el mando derecho y aparece pequeña en el visor ("→ 220°"). */
    setTargetTemperature(celsius) { if (Number.isFinite(celsius)) s.target = Math.round(clamp(celsius, 0, 999)); },

    /** Temporizador en minutos (admite decimales) → "mm:ss"; null lo apaga. */
    setTimer(minutes) {
      if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) { s.timer = null; return; }
      const total = Math.min(99 * 60 + 59, Math.max(0, Math.round(minutes * 60)));
      s.timer = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    },

    /** Estado del horno: LED y texto del visor. Pita al llegar a 'ready'. */
    setStatus(status) {
      if (!['off', 'heating', 'ready'].includes(status) || status === s.status) return;
      if (status === 'ready') ctx.audio?.play('beep');
      s.status = status;
      s.ledOn = true;
    },

    /** Vapor visible dentro de la cavidad (0..1); al abrir con vapor escapa una bocanada. */
    setSteam(level01) { if (Number.isFinite(level01)) s.steam = clamp(level01); },

    /** Resalta la puerta o un mando con un pulso cálido (null quita el resalte). */
    setHighlight(part) {
      for (const [key, h] of Object.entries(highlighters)) h.set(key === part);
    },

    /** Vista de cámara (mundo) a 0.5 m del cristal, un poco por encima de la rejilla y mirándola. */
    getWindowView() {
      group.updateWorldMatrix(true, false);
      return {
        position: group.localToWorld(new THREE.Vector3(0, RACK_TOP + 0.1, DOOR.hingeZ + DOOR.t + 0.5)),
        target: group.localToWorld(new THREE.Vector3(0, RACK_TOP + 0.04, RACK.z)),
      };
    },

    /** Vuelve al estado inicial al instante (puerta cerrada, todo apagado). */
    reset() {
      s.doorAnim?.cancel();
      s.doorAnim = null;
      s.isOpen = false;
      setDoorAngle(0);
      s.light = false; s.lightLevel = 0;
      s.heatTarget = 0; s.heat = 0;
      s.steam = 0;
      s.timer = null;
      s.status = 'off';
      steam.clear();
      api.setHighlight(null);
    },

    /** Animaciones continuas (luces, mandos, ventilador, vapor, LCD). Nunca lanza. */
    update(dt, elapsed = 0) {
      try {
        const d = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
        const time = Number.isFinite(elapsed) ? elapsed : 0;

        // Luz y calor con inercia
        s.lightLevel = damp(s.lightLevel, s.light ? 1 : 0, 14, d);
        s.heat = damp(s.heat, s.heatTarget, s.heatTarget > s.heat ? 0.9 : 0.55, d);
        const glow = Math.pow(s.heat, 1.4);
        const flicker = 1 + 0.035 * Math.sin(time * 7.3) * Math.sin(time * 2.9);
        lampLight.intensity = s.lightLevel * LAMP_INTENSITY;
        M.lampGlass.emissiveIntensity = s.lightLevel * 2.4;
        heatLight.intensity = glow * HEAT_INTENSITY * flicker;
        M.element.emissiveIntensity = glow * 3.2 * flicker;
        M.element.color.setRGB(lerp(0.043, 0.16, glow), lerp(0.04, 0.045, glow), lerp(0.037, 0.03, glow));
        // el cristal deja ver más cuando hay luz dentro (lámpara o resistencias al rojo)
        windowAlpha.value = lerp(WINDOW_ALPHA.dark, WINDOW_ALPHA.lit, Math.max(s.lightLevel, glow * 0.45));

        // Mandos y ventilador
        s.tempKnobAngle = damp(s.tempKnobAngle, -(Math.min(s.target, TEMP_MAX) / TEMP_MAX) * TEMP_SWEEP, 9, d);
        s.modeKnobAngle = damp(s.modeKnobAngle, -modeTarget() * MODE_STEP, 9, d);
        panel.tempKnob.rotation.z = s.tempKnobAngle;
        panel.modeKnob.rotation.z = s.modeKnobAngle;
        const fanOn = s.status !== 'off' || s.heatTarget > 0.02;
        s.fanSpeed = damp(s.fanSpeed, fanOn ? 14 : 0, 1.2, d);
        body.fan.rotation.z -= s.fanSpeed * d;

        // Vapor: bocanada al abrir con vapor dentro
        const open01 = s.doorAngle / OPEN_ANGLE;
        if (s.isOpen && !s.puffed && open01 > 0.22) {
          s.puffed = true;
          if (s.steam > 0.05) {
            steam.burst(Math.round(10 + s.steam * 18));
            const p = group.localToWorld(new THREE.Vector3(0, CAV.y1 + 0.02, 0.12));
            ctx.particles?.puff?.(p, { color: 0xffffff, count: Math.round(25 + 45 * s.steam), spread: 0.14, size: 0.05, life: 1.6 });
          }
        }
        if (!s.isOpen && open01 < 0.05) s.puffed = false;
        const lit = 0.3 + 0.7 * s.lightLevel;
        steam.uniforms.uColor.value.setRGB(lit + glow * 0.25, lit * 0.97 + glow * 0.1, lit * 0.93);
        const renderer = ctx.renderer ?? ctx.engine?.renderer, camera = ctx.camera ?? ctx.engine?.camera;
        if (renderer && camera?.isPerspectiveCamera) {
          const hPx = renderer.domElement.height || 800;
          steam.uniforms.uScale.value = (hPx * 0.5) / Math.tan(degToRad(camera.fov) / 2);
        }
        steam.update(d, s.steam, open01, time);

        // Visor: el LED parpadea mientras calienta
        s.ledOn = s.status !== 'heating' || Math.floor(time * 1.6) % 2 === 0;
        redrawLcd();

        for (const h of Object.values(highlighters)) h.update(d);
        door.halo.visible = highlighters.door.active;
        if (door.halo.visible) door.halo.material.uniforms.uStrength.value = 0.6 + 0.4 * Math.sin(time * 5);
      } catch (e) {
        if (!s.failed) { s.failed = true; console.error('[oven] update', e); }
      }
    },
  };
  return api;
}
