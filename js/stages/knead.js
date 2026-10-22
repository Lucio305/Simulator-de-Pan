// Etapa 3 · Amasar: estirar y plegar la masa sobre la tabla enharinada hasta desarrollar el gluten.
import * as THREE from 'three';
import { Stage } from './stage.js';
import { kneadStroke, stickiness, windowpaneTest, hydration } from '../recipe.js';
import { animate, ease, cancelAnimations } from '../core/anim.js';
import { clamp, lerp, damp, smoothstep, makeCanvasTexture, fbm3, formatMinutes } from '../core/utils.js';

const TAG = 'knead-stage';
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const TAU = Math.PI * 2;

/** Banda ideal del gluten: desde 0,85 el amasado puntúa al máximo. */
export const GLUTEN_IDEAL = [0.85, 1];
const STROKE_IDEAL = [0.06, 0.18];   // largo ideal de un estirón sobre la tabla (m)
const TAP_MAX = 0.015;               // por debajo de esto es un toque (presión), no un estirón
const DRAG_H = 0.035;                // el estirón se mide en un plano a media altura de la masa
const AUTO_PERIOD = 0.7;             // «Amasar» mantenido: una amasada cada 0,7 s…
const AUTO_PUSH = 0.34;              // …de la que 0,34 s son el empujón
const AUTO_LEN = 0.13;               // largo del empujón automático (m)
const AUTO_QUALITY = 0.8;
const TAP_QUALITY = 0.4;
const TAP_COOLDOWN = 0.5;            // toques más seguidos que esto no cuentan (machacar no amasa)
const TURN_EVERY = 4;                // cuarto de vuelta cada 4 amasadas, como un panadero
const FLOUR_STEP = 5;                // g por cada «Enharinar»
const STICKY_MAX = 0.6;              // por encima se pega a la tabla y cunde menos
const EXTRA_WARN = 30;               // g de harina extra (6 % de 500 g) a partir de los que se reseca
const SIM_MIN_PER_STROKE = 1 / 3;    // cada amasada son ~20 s de reloj
const COLORS = { short: 0xffc45e, good: 0x84e05f, long: 0xff6f5a };
const FLOUR_COLOR = 0xf8f3ea;

/** true en pantallas verticales (móvil): la hoja inferior tapa la mitad de abajo. */
export const isTall = (engine) => engine.camera.aspect < 0.8;

/**
 * Vista que encuadra `subject` desde la dirección `dir` a `dist` metros y lo deja aproximadamente en
 * la posición de pantalla `ndc` ([-1..1, -1..1]), para que no quede debajo de los paneles del HUD.
 * @returns {{position: THREE.Vector3, target: THREE.Vector3}}
 */
export function frameAt(engine, subject, { dir, dist, ndc = [0, 0] }) {
  const cam = engine.camera;
  const d = dir.clone().normalize();
  const position = subject.clone().addScaledVector(d, dist);
  const fwd = d.clone().negate();
  const right = V().crossVectors(fwd, UP).normalize();
  const up = V().crossVectors(right, fwd);
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), tanH = tanV * cam.aspect;
  const target = subject.clone().addScaledVector(right, -ndc[0] * tanH * dist).addScaledVector(up, -ndc[1] * tanV * dist);
  return { position, target };
}

/**
 * Lleva `object` en arco hasta `anchor` y lo cuelga de él (conserva el giro en Y).
 * A diferencia de Stage.moveTo, si se cancela (tag) no lo engancha al ancla.
 * @returns {Promise<boolean>} false si se interrumpe
 */
export async function travel(engine, object, anchor, { height = 0.2, duration = 1, tag, spin = 0, onUpdate } = {}) {
  engine.scene.attach(object);
  const to = anchor.getWorldPosition(V());
  const from = object.position.clone(), r0 = object.rotation.clone();
  const ok = await animate({
    duration, tag, ease: ease.inOutCubic,
    onUpdate: (t) => {
      object.position.lerpVectors(from, to, t);
      object.position.y += Math.sin(Math.PI * t) * height;
      object.rotation.set(r0.x * (1 - t), r0.y + spin * t, r0.z * (1 - t));
      onUpdate?.(t);
    },
  });
  if (!ok) return false;
  anchor.attach(object);
  object.position.set(0, 0, 0);
  object.rotation.set(0, object.rotation.y, 0);
  return true;
}

/** Número con coma decimal ("0,4"). */
const dec = (v, digits = 1) => v.toFixed(digits).replace('.', ',');

// -------------------------------------------------------------------------------------------------
// Flecha del estirón sobre la tabla (y guía animada antes de empezar)
// -------------------------------------------------------------------------------------------------

function makeStrokeGuide() {
  const group = new THREE.Group();
  group.name = 'knead-guide';
  group.visible = false;
  // banda con bordes suaves (se tiñe con el color del material)
  const band = makeCanvasTexture(8, 64, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.28, 'rgba(255,255,255,1)');
    gr.addColorStop(0.72, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  // punta de flecha con un contorno oscuro para que se lea sobre la harina
  const head = makeCanvasTexture(64, 64, (g, w, h) => {
    const tri = () => {
      g.beginPath();
      g.moveTo(w * 0.94, h / 2);
      g.lineTo(w * 0.12, h * 0.1);
      g.lineTo(w * 0.32, h / 2);
      g.lineTo(w * 0.12, h * 0.9);
      g.closePath();
    };
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(70,40,18,0.55)';
    g.lineWidth = 7;
    tri();
    g.stroke();
    g.fillStyle = '#fff';
    tri();
    g.fill();
  });
  const mk = (geo, map, order) => {
    // se dibuja por encima de la masa: es la flecha de tu gesto
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, opacity: 0 }));
    m.renderOrder = 20 + order;
    m.raycast = () => {};
    group.add(m);
    return m;
  };
  const [lo, hi] = STROKE_IDEAL;
  // zona buena (verde muy suave), cuerpo y punta
  const zone = mk(new THREE.PlaneGeometry(hi - lo, 0.06).translate((lo + hi) / 2, 0, 0).rotateX(-Math.PI / 2), band, 8);
  zone.material.color.set(COLORS.good);
  const shaft = mk(new THREE.PlaneGeometry(1, 0.02).translate(0.5, 0, 0).rotateX(-Math.PI / 2), band, 9);
  const tip = mk(new THREE.PlaneGeometry(0.05, 0.05).rotateX(-Math.PI / 2), head, 10);
  const color = new THREE.Color();
  return {
    group,
    /**
     * @param {{x:number, z:number, angle:number, length:number, color:number, opacity:number, zone:number}} o
     *   origen en coordenadas de la tabla, ángulo (0 = +X), largo (m) y opacidades
     */
    set({ x, z, angle, length, color: c, opacity, zone: zoneOpacity = 0 }) {
      group.visible = opacity > 0.01 || zoneOpacity > 0.01;
      if (!group.visible) return;
      group.position.set(x, DRAG_H, z);
      group.rotation.y = angle;
      const L = Math.max(0.02, length);
      shaft.scale.x = Math.max(0.001, L - 0.03);
      tip.position.x = L - 0.021;
      color.set(c);
      shaft.material.color.copy(color);
      tip.material.color.copy(color);
      shaft.material.opacity = opacity * 0.8;
      tip.material.opacity = opacity;
      zone.material.opacity = zoneOpacity * 0.3;
    },
    hide() { group.visible = false; },
    dispose() {
      group.removeFromParent();
      for (const m of [zone, shaft, tip]) { m.geometry.dispose(); m.material.dispose(); }
      band.dispose();
      head.dispose();
    },
  };
}

// -------------------------------------------------------------------------------------------------
// Membrana de la prueba de la ventana
// -------------------------------------------------------------------------------------------------

const MEMBRANE_OPACITY = 0.72;       // película fina: deja ver a través

/** Película de masa estirada entre dos yemas de dedo (mira siempre a la cámara). */
function makeMembrane() {
  // alpha: película irregular, más gruesa en el borde; las zonas finas son las que se rasgan
  const alpha = makeCanvasTexture(192, 192, (g, w, h) => {
    const img = g.createImageData(w, h), d = img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = ((x + 0.5) / w) * 2 - 1, v = ((y + 0.5) / h) * 2 - 1;
        const r = Math.hypot(u, v), a = Math.atan2(v, u);
        // contorno deshilachado: ondas amplias y mellas pequeñas
        const edge = 0.84 + 0.22 * (fbm3(Math.cos(a) * 1.8 + 3, Math.sin(a) * 1.8, 1.3, 3) - 0.5)
          + 0.12 * (fbm3(Math.cos(a) * 7 + 11, Math.sin(a) * 7, 2.7, 2) - 0.5);
        let val = 0;
        if (r < edge) {
          const thick = fbm3(u * 2.6 + 7, v * 2.6, 4.2, 4);
          const rim = smoothstep(edge - 0.22, edge - 0.02, r);
          val = clamp(0.3 + 0.95 * (thick - 0.5) + 0.45 + 0.5 * rim - 0.18 * (1 - r));
          val *= smoothstep(edge, edge - 0.03, r);
        }
        const i = (y * w + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = Math.round(val * 255);
        d[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  }, { srgb: false });
  const glowTex = makeCanvasTexture(64, 64, (g, w, h) => {
    const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    gr.addColorStop(0, 'rgba(255,236,190,0.8)');
    gr.addColorStop(0.45, 'rgba(255,214,140,0.25)');
    gr.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  });
  // estirada a lo ancho (entre los dedos) y apenas abombada
  const geo = new THREE.CircleGeometry(0.05, 64);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i)) / 0.05;
    pos.setXYZ(i, pos.getX(i) * 1.1, pos.getY(i) * 0.72, 0.004 * (1 - r * r));
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xf2dfb8, alphaMap: alpha, transparent: true, opacity: MEMBRANE_OPACITY, alphaTest: 0.02, side: THREE.DoubleSide, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'knead-windowpane';
  mesh.renderOrder = 12;
  mesh.raycast = () => {};
  // dos yemas de dedo pellizcan los bordes (el otro extremo se desvanece: los dedos vienen de fuera)
  const tipGeo = new THREE.CapsuleGeometry(0.0078, 0.03, 4, 12);
  const tp = tipGeo.attributes.position, tc = new Float32Array(tp.count * 4);
  for (let i = 0; i < tp.count; i++) tc.set([1, 1, 1, smoothstep(-0.023, -0.004, tp.getY(i))], i * 4);
  tipGeo.setAttribute('color', new THREE.BufferAttribute(tc, 4));
  const skin = new THREE.MeshStandardMaterial({ color: 0xe7b08a, roughness: 0.6, envMapIntensity: 0.6, vertexColors: true, transparent: true });
  for (const side of [-1, 1]) {
    const tip = new THREE.Mesh(tipGeo, skin);
    tip.position.set(side * 0.058, 0, 0.006);   // la yema (+Y local) apoyada en el borde de la película
    tip.rotation.z = side * (Math.PI / 2 + 0.3);
    tip.renderOrder = 13;
    tip.raycast = () => {};
    mesh.add(tip);
  }
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.13), new THREE.MeshBasicMaterial({
    map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, toneMapped: false,
  }));
  glow.position.z = -0.012;
  glow.renderOrder = 11;
  glow.raycast = () => {};
  mesh.add(glow);
  mesh.visible = false;
  return {
    mesh, mat, glow,
    dispose() {
      mesh.removeFromParent();
      geo.dispose(); mat.dispose(); alpha.dispose();
      tipGeo.dispose(); skin.dispose();
      glow.geometry.dispose(); glow.material.dispose(); glowTex.dispose();
    },
  };
}

// -------------------------------------------------------------------------------------------------
// Etapa
// -------------------------------------------------------------------------------------------------

export class KneadStage extends Stage {
  constructor(game) {
    super(game);
    this.ready = false;        // la masa ya está en la tabla
    this.leaving = false;
    this.finishing = false;    // «Dejar fermentar» pulsado
    this.testing = false;      // prueba de la ventana en curso
    this.confirming = false;   // diálogo abierto
    this.time = 0;
    this.drag = null;          // estirón con el puntero
    this.auto = false;         // «Amasar» mantenido (botón o espacio)
    this.autoSource = null;
    this.autoT = 0;
    this.autoReleased = false;
    this.autoCount = 0;
    this.pose = { stretch: 0, squash: 0, slide: V() };
    this.dirW = new THREE.Vector2(0, -1);   // dirección del estirón en XZ de mundo
    this.fold = null;          // pulso de plegado tras soltar {t, dur, amp, tilt}
    this.yaw = 0;
    this.yawGoal = 0;
    this.lastStrokeAt = -Infinity;
    this.lastTapAt = -Infinity;
    this.idle = 0;
    this.flourVis = 0.25;      // harina visible sobre la masa
    this.boardFlour = 0.6;
    this.succeeded = false;
    this.stickyWarnAt = -Infinity;
    this.extraWarned = false;
    this.feedback = null;      // {text, t}
    this.hoverNdc = null;
    this.hoverDirty = false;
    this.hoverAt = 0;
    this.hovering = false;
    this.parallaxSaved = null;
    this.view = 'knead';
    this.metersKey = '';
    this.ctl = null;
    this.guide = null;
    this.membrane = null;
    this.kneadLoop = null;
    this.tmp = V();
    this.tmp2 = V();
    this.qYaw = new THREE.Quaternion();
    this.qTilt = new THREE.Quaternion();
    this.axis = V();
    this.sphere = new THREE.Sphere();
    this.raycaster = new THREE.Raycaster();
  }

  // -----------------------------------------------------------------------------------------------
  // Entrada
  // -----------------------------------------------------------------------------------------------

  async enter() {
    const { dough, tools } = this.models;
    const board = tools.board;
    this.yaw = this.yawGoal = dough.group.rotation.y || 0;
    this.instruct('Amasa la masa',
      'Arrastra la masa para estirarla y suelta para plegarla (o mantén pulsado «Amasar»). Unas 30 amasadas con buen ritmo la dejarán lisa y elástica.',
      this.startTip());
    this.buildControls();
    this.refreshMeters(true);

    this.guide = makeStrokeGuide();
    board.anchors.top.add(this.guide.group);
    this.track(() => this.guide?.dispose());
    this.kneadLoop = this.loop('knead', { volume: 0.7 });
    this.kneadLoop?.setIntensity(0);

    const down = (e) => this.onKey(e, true), up = (e) => this.onKey(e, false);
    const blur = () => { this.setAuto(false, 'key'); this.endDrag(true); };
    const leave = () => { if (!this.drag) this.setHover(false); };
    const resize = () => this.goView(this.view, 0.3);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', resize);
    this.engine.canvas.addEventListener('pointerleave', leave);
    this.track(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', resize);
      this.engine.canvas.removeEventListener('pointerleave', leave);
    });

    this.goView('knead', 1.5);
    this.dustBoard();
    if (dough.group.parent !== board.anchors.top) {
      // la masa sale del bol (la báscula vuelve a 0) y vuela a la tabla
      tools.scale.setReading(0);
      dough.setHighlight(false);
      const ok = await travel(this.engine, dough.group, board.anchors.top, { height: 0.22, duration: 1.15, tag: TAG, spin: Math.PI / 2 });
      if (!ok || this.leaving) return;
      this.yaw = this.yawGoal = dough.group.rotation.y;
      this.audio?.play('plop', { volume: 0.8 });
      this.audio?.play('thump', { volume: 0.5 });
      this.puffAt(0, 0, { count: 26, spread: 0.08 });
      this.fold = { t: 0, dur: 0.45, amp: 0.38, tilt: 0 };
    }
    this.ready = true;
    this.lastStrokeAt = this.lastTapAt = -Infinity;
    this.refreshMeters(true);
    this.syncControls();
  }

  startTip() {
    const s = this.sticky();
    const pct = Math.round(hydration(this.state.amounts) * 100);
    if (s > STICKY_MAX) return `Con un ${pct} % de hidratación se va a pegar: pulsa «Enharinar» un par de veces antes de empezar (5 g cada vez).`;
    return `${this.bread.tips?.knead ?? ''} Estira unos 10–15 cm y suelta, a ritmo tranquilo: más o menos una amasada por segundo.`.trim();
  }

  /** Espolvorea la tabla mientras la cámara llega. */
  dustBoard() {
    const board = this.models.tools.board;
    const from = board.flour, to = Math.max(from, 0.6);
    this.boardFlour = to;
    if (to - from < 0.05) { board.setFlour(to); return; }
    this.audio?.play('pour-start', { volume: 0.4 });
    animate({ duration: 0.8, delay: 0.25, tag: TAG, ease: ease.outCubic, onUpdate: (t) => board.setFlour(lerp(from, to, t)) });
    for (const [i, dx, dz] of [[0, -0.12, 0.05], [1, 0.1, -0.06], [2, 0.02, 0.08]]) {
      animate({ duration: 0.01, delay: 0.25 + i * 0.18, tag: TAG }).then((ok) => {
        if (!ok || this.leaving) return;
        board.anchors.top.getWorldPosition(this.tmp).add(V(dx, 0.1, dz));
        this.particles?.puff(this.tmp, { color: FLOUR_COLOR, count: 18, spread: 0.06, size: 0.012, life: 1.1 });
      });
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Cámara
  // -----------------------------------------------------------------------------------------------

  viewFor(name) {
    const tall = isTall(this.engine);
    const top = this.models.tools.board.anchors.top.getWorldPosition(V());
    if (name === 'close') {
      const d = this.models.dough;
      const s = d.group.localToWorld(V(0, d.getTopY() + 0.045, 0));
      return frameAt(this.engine, s, tall
        ? { dir: V(0, 0.6, 0.8), dist: 0.5, ndc: [0, 0.4] }
        : { dir: V(0, 0.55, 0.83), dist: 0.42, ndc: [0, 0.16] });
    }
    // la tabla un poco desde arriba: lo que arrastras en pantalla es lo que estiras en la tabla
    // (la masa algo por debajo del centro: deja sitio para empujarla hacia el fondo)
    top.y += 0.03;
    return frameAt(this.engine, top, tall
      ? { dir: V(0, 0.84, 0.54), dist: 0.8, ndc: [0, 0.22] }
      : { dir: V(0, 0.8, 0.6), dist: 0.84, ndc: [0, 0.02] });
  }

  goView(name, duration = 1.2) {
    this.view = name;
    return this.camera(this.viewFor(name), { duration });
  }

  // -----------------------------------------------------------------------------------------------
  // Interfaz
  // -----------------------------------------------------------------------------------------------

  buildControls() {
    const g = this.state.knead.gluten;
    this.ctl = this.ui.setControls([
      { type: 'hold', id: 'knead', label: 'Amasar', icon: 'hand', value: g, disabled: true, onStart: () => this.setAuto(true, 'hold'), onEnd: () => this.setAuto(false, 'hold') },
      { type: 'button', id: 'flour', label: `Enharinar +${FLOUR_STEP} g`, variant: 'secondary', disabled: true, onClick: () => this.addFlour() },
      { type: 'button', id: 'window', label: 'Prueba de la ventana', icon: 'info', variant: 'secondary', disabled: true, onClick: () => this.windowpane() },
      { type: 'button', id: 'next', label: 'Dejar fermentar', icon: 'play', variant: 'primary', disabled: true, onClick: () => this.goNext() },
    ]);
  }

  syncControls() {
    if (!this.ctl) return;
    const free = this.ready && !this.leaving && !this.finishing && !this.testing;
    const k = this.state.knead;
    this.ctl.get('knead').set({ disabled: !free, value: k.gluten });
    this.ctl.get('flour').set({ disabled: !free, active: this.sticky() > STICKY_MAX });
    this.ctl.get('window').set({ disabled: !free, active: this.guided && k.gluten >= 0.8 && !k.windowpane });
    this.ctl.get('next').set({ disabled: !this.ready || this.leaving || this.finishing || this.testing });
  }

  /** Pegajosidad actual (recipe.stickiness con la harina extra y el gluten). */
  sticky() {
    const a = this.state.amounts, k = this.state.knead;
    return stickiness(hydration(a), k.extraFlour, a.flour || 500, k.gluten);
  }

  refreshMeters(force = false) {
    const k = this.state.knead;
    const s = this.sticky();
    const g = k.gluten;
    const key = `${Math.round(g * 1000)}|${Math.round(s * 100)}|${k.strokes}|${k.extraFlour}`;
    if (!force && key === this.metersKey) return;
    this.metersKey = key;
    const dry = k.extraFlour > EXTRA_WARN && s < 0.45;
    // (de 0,45 al máximo sigue dentro de la banda ideal: algo pegajosa es normal, sin aviso;
    // texto corto para que no se corte la etiqueta del medidor)
    const sText = s > STICKY_MAX ? 'Se pega' : dry ? 'Reseca' : s > 0.45 ? 'Algo pegajosa' : s > 0.15 ? 'Normal' : 'No se pega';
    this.ui.setMeters([
      { id: 'gluten', label: 'Desarrollo del gluten', value01: g, text: `${Math.round(g * 100)} %`, ideal: this.ideal(GLUTEN_IDEAL), tone: g >= GLUTEN_IDEAL[0] ? 'good' : 'neutral' },
      { id: 'sticky', label: 'Pegajosidad', value01: s, text: sText, ideal: this.ideal([0, STICKY_MAX]),
        tone: s > STICKY_MAX ? 'bad' : dry ? 'warn' : this.guided ? 'good' : 'neutral' },
    ]);
    const extra = k.extraFlour > 0 ? ` · ${Math.round(k.extraFlour)} g de harina extra` : '';
    this.ui.setClock({ label: 'Amasando', text: formatMinutes(k.strokes * SIM_MIN_PER_STROKE), sub: `${k.strokes} ${k.strokes === 1 ? 'amasada' : 'amasadas'}${extra}` });
    this.ctl?.get('knead').set({ value: g });
  }

  /** Mensaje flotante breve sobre la masa (calidad de la amasada). */
  say(text, seconds = 1.2) {
    this.feedback = { text, t: seconds };
  }

  // -----------------------------------------------------------------------------------------------
  // Amasado
  // -----------------------------------------------------------------------------------------------

  canKnead() { return this.ready && !this.leaving && !this.finishing && !this.testing; }

  setAuto(on, source) {
    if (on) {
      if (!this.canKnead()) return;
      if (!this.auto) { this.autoT = 0; this.autoReleased = false; }
      this.auto = true;
      this.autoSource = source;
    } else if (this.autoSource === source || source === '*') {
      this.auto = false;
      this.autoSource = null;
      // empujón a medias: vuelve sin contar
      if (this.autoT > 0 && !this.autoReleased) this.startFold(0.2, 0);
      this.autoT = 0;
      this.autoReleased = false;
    }
  }

  /** Pulso de plegado: la masa vuelve sobre sí misma y se aplasta un instante. */
  startFold(amp, tilt = -0.14, dur = 0.45) {
    this.fold = { t: 0, dur, amp, tilt };
  }

  /**
   * Una amasada completa (estirón soltado, presión o automática).
   * @param {number} L largo del estirón (m)
   * @param {{auto?: boolean, tap?: boolean, local?: THREE.Vector3}} opts
   */
  stroke(L, { auto = false, tap = false, local = null } = {}) {
    const { dough, tools } = this.models;
    const k = this.state.knead;
    const [lo, hi] = STROKE_IDEAL;
    const gap = this.time - this.lastStrokeAt;
    if (tap) {
      // toques muy seguidos: la masa se hunde y suena, pero no cuenta (ni amasada, ni reloj, ni gluten);
      // cada toque reinicia la espera, así que machacar sin parar no suma nada
      const sinceTap = this.time - Math.max(this.lastStrokeAt, this.lastTapAt);
      this.lastTapAt = this.time;
      if (sinceTap < TAP_COOLDOWN) {
        if (local) dough.dent(local, { radius: 0.032, depth: 0.015, recovery: 0.9 });
        this.startFold(0.2, 0, 0.3);
        this.audio?.play('thump', { volume: 0.35, rate: 1.15 });
        this.say('Presionar ayuda poco: mejor estira');
        return;
      }
    }
    this.lastStrokeAt = this.time;
    this.idle = 0;
    const sticky = this.sticky();
    let lenQ = 1, rhythmQ = 1, stickQ = 1;
    if (!auto && !tap) lenQ = L < lo ? lerp(0.3, 1, smoothstep(TAP_MAX, lo, L)) : L <= hi ? 1 : lerp(1, 0.35, smoothstep(hi, 0.32, L));
    if (!auto && Number.isFinite(gap)) {
      rhythmQ = gap < 0.4 ? lerp(0.35, 1, smoothstep(0.12, 0.4, gap)) : gap <= 1.5 ? 1 : lerp(1, 0.82, smoothstep(1.5, 3.5, gap));
    }
    if (sticky > STICKY_MAX) stickQ = lerp(0.75, 0.35, smoothstep(STICKY_MAX, 0.85, sticky));
    const q = clamp((tap ? TAP_QUALITY : auto ? AUTO_QUALITY : 1) * lenQ * rhythmQ * stickQ);
    const g0 = k.gluten;
    k.gluten = kneadStroke(g0, q);
    k.strokes += 1;
    this.game.advanceClock(SIM_MIN_PER_STROKE);

    // la masa se pliega sobre sí misma: golpe sordo, nubecilla de harina y un hueco donde apoya la palma
    const top = dough.getTopY();
    if (tap) {
      if (local) dough.dent(local, { radius: 0.032, depth: 0.015, recovery: 0.9 });
      this.startFold(0.2, 0, 0.3);
      this.audio?.play('thump', { volume: 0.45, rate: 1.15 });
    } else {
      const ld = this.localDir();
      dough.dent(V(-ld.x * 0.02, top * 0.95, -ld.y * 0.02), { radius: 0.04, depth: 0.009, recovery: 0.7 });
      this.startFold(auto ? 0.3 : 0.26 + 0.12 * q);
      this.audio?.play('thump', { volume: 0.45 + 0.5 * q, rate: 0.92 + Math.random() * 0.16 });
      this.puffAt(this.dirW.x * 0.08, this.dirW.y * 0.08, { count: Math.round(6 + 14 * this.boardFlour), spread: 0.04 });
    }
    if (stickQ < 0.8) this.audio?.play('plop', { volume: 0.5, rate: 0.8 });
    // la harina de la tabla se va gastando y la masa la absorbe
    this.boardFlour = Math.max(0.22, this.boardFlour - 0.012);
    tools.board.setFlour(this.boardFlour);
    this.flourVis = Math.max(0.08, this.flourVis - 0.012);
    // cuarto de vuelta cada pocas amasadas
    if (k.strokes % TURN_EVERY === 0) {
      this.yawGoal += Math.PI / 2;
      this.audio?.play('whoosh', { volume: 0.15, rate: 1.4 });
    }

    // qué tal ha ido (solo con el puntero: con el botón ya se ve el ritmo)
    if (!auto) {
      const gain = (k.gluten - g0) * 100;
      const gainText = gain >= 0.05 ? ` · +${dec(gain, gain < 1 ? 1 : 0)} %` : '';
      let msg;
      if (stickQ < 0.8) msg = '¡Se pega! Enharina';
      else if (tap) msg = 'Presionar ayuda poco: mejor estira';
      else if (L < lo) msg = 'Estira más (10–15 cm)';
      else if (L > hi) msg = '¡Demasiado! Se rasga';
      else if (rhythmQ < 0.7) msg = 'Más despacio, con ritmo';
      else if (rhythmQ < 0.95) msg = 'Sin parar: mantén el ritmo';
      else msg = q >= 0.97 ? '¡Perfecta!' : '¡Bien!';
      this.say(msg + gainText);
    }
    if (sticky > STICKY_MAX && this.time - this.stickyWarnAt > 6) {
      this.stickyWarnAt = this.time;
      this.ui.toast('¡Se pega a la tabla! Echa un poco de harina con «Enharinar».', { tone: 'warn' });
    }
    if (!this.succeeded && k.gluten >= GLUTEN_IDEAL[0]) this.success();
    this.refreshMeters();
    this.syncControls();
  }

  /** Masa lisa y elástica: el momento de gloria. */
  success() {
    this.succeeded = true;
    const { dough } = this.models;
    this.audio?.play('success');
    dough.group.localToWorld(this.tmp.set(0, dough.getTopY() + 0.03, 0));
    this.particles?.sparkle(this.tmp, { count: 34, spread: 0.1 });
    const pct = Math.round(this.state.knead.gluten * 100);
    this.ui.toast(this.guided
      ? `¡Masa lisa y elástica! Gluten al ${pct} %. Haz la prueba de la ventana o déjala fermentar.`
      : '¡Qué lisa y elástica se ha puesto!', { tone: 'good', duration: 3.6 });
    this.instruct('¡Masa lisa y elástica!',
      `El gluten está al ${pct} %: la masa brilla, no se rompe y vuelve a su sitio. Comprueba con la prueba de la ventana si quieres, y déjala fermentar.`,
      'Puedes seguir amasando un poco más, pero ya no hace falta.');
  }

  /** Dirección del estirón en el espacio local de la masa (XZ). */
  localDir(out = new THREE.Vector2()) {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return out.set(this.dirW.x * c - this.dirW.y * s, this.dirW.x * s + this.dirW.y * c);
  }

  addFlour() {
    if (!this.canKnead() || this.time - (this.flourAt ?? -1) < 0.25) return;
    this.flourAt = this.time;
    const { dough, tools } = this.models;
    const k = this.state.knead;
    const wasSticky = this.sticky() > STICKY_MAX;
    k.extraFlour += FLOUR_STEP;
    this.boardFlour = Math.min(0.95, this.boardFlour + 0.12);
    tools.board.setFlour(this.boardFlour);
    this.flourVis = Math.min(0.6, this.flourVis + 0.3);
    dough.set({ hydration: this.hydration });
    this.audio?.play('pour-start', { volume: 0.45, rate: 1.2 });
    // lluvia de harina sobre la masa
    const top = dough.getTopY();
    for (let i = 0; i < 3; i++) {
      dough.group.localToWorld(this.tmp.set((Math.random() - 0.5) * 0.1, top + 0.1 + i * 0.02, (Math.random() - 0.5) * 0.1));
      this.particles?.puff(this.tmp, { color: FLOUR_COLOR, count: 16, spread: 0.05, size: 0.011, life: 1.3 });
    }
    const s = this.sticky();
    if (wasSticky && s <= STICKY_MAX) this.ui.toast('¡Mucho mejor! Ya no se pega.', { tone: 'good' });
    // (con una masa muy húmeda la harina extra es el remedio: solo avisa cuando ya no se pega)
    if (k.extraFlour > EXTRA_WARN && s < 0.45 && !this.extraWarned) {
      this.extraWarned = true;
      this.ui.toast(`Ya llevas ${Math.round(k.extraFlour)} g de harina extra: si añades más, la masa se resecará.`, { tone: 'warn', duration: 3.4 });
    } else if (!wasSticky && s < 0.45 && this.guided && k.extraFlour <= EXTRA_WARN) {
      this.say(`+${FLOUR_STEP} g · no hace falta más`);
    } else {
      this.say(`+${FLOUR_STEP} g de harina`);
    }
    this.refreshMeters();
    this.syncControls();
  }

  // -----------------------------------------------------------------------------------------------
  // Prueba de la ventana
  // -----------------------------------------------------------------------------------------------

  async windowpane() {
    if (!this.canKnead()) return;
    this.endDrag(false);
    this.setAuto(false, '*');
    this.testing = true;
    this.syncControls();
    this.setHover(false);
    this.feedback = null;
    this.ui.hideHint();
    const { dough } = this.models;
    const k = this.state.knead;
    const res = windowpaneTest(k.gluten);
    k.windowpane = true;
    const mem = this.membrane ??= makeMembrane();
    this.engine.scene.add(mem.mesh);
    // la película sale de lo alto de la masa, de cara a la cámara, y queda bien por encima de ella
    const base = dough.group.localToWorld(V(0, dough.getTopY() - 0.01, 0));
    const lift = base.clone().add(V(0, 0.085, 0.012));
    mem.mesh.visible = true;
    mem.mat.alphaTest = 0.02;
    mem.mat.color.set(0xf2dfb8);
    mem.mat.opacity = MEMBRANE_OPACITY;
    mem.glow.material.opacity = 0;
    this.goView('close', 0.9);
    this.audio?.play('whoosh', { volume: 0.25, rate: 0.8 });
    let ok = await animate({
      duration: 0.9, delay: 0.25, tag: TAG, ease: ease.outBack,
      onUpdate: (t) => { mem.mesh.position.lerpVectors(base, lift, Math.min(1, t)); mem.mesh.scale.setScalar(Math.max(0.05, t)); },
    });
    if (!ok || this.leaving) return;
    const g = k.gluten;
    if (res.pass) {
      // la luz la atraviesa
      this.audio?.play('ding');
      const c0 = new THREE.Color(0xf2dfb8), c1 = new THREE.Color(0xfff3dc);
      ok = await animate({
        duration: 0.8, tag: TAG, ease: ease.outCubic,
        onUpdate: (t) => { mem.mat.color.lerpColors(c0, c1, t); mem.glow.material.opacity = 0.55 * t; mem.mat.opacity = MEMBRANE_OPACITY - 0.25 * t; },
      });
      if (!ok || this.leaving) return;
      this.particles?.sparkle(lift, { count: 26, spread: 0.06 });
      this.audio?.play('success', { volume: 0.7 });
    } else {
      // se rasga por las zonas más finas
      // (umbral sobre el grosor de la película: cuanto menos gluten, más agujeros)
      const tear = (g >= 0.62 ? 0.54 : g >= 0.35 ? 0.65 : 0.74) * MEMBRANE_OPACITY;
      this.audio?.play('pop', { volume: 0.6 });
      ok = await animate({
        duration: 0.8, tag: TAG, ease: ease.outQuad,
        onUpdate: (t) => { mem.mat.alphaTest = lerp(0.02, tear, t); },
      });
      if (!ok || this.leaving) return;
      this.audio?.play('pop', { volume: 0.4, rate: 1.3 });
    }
    this.ui.toast(res.text, { tone: res.pass ? 'good' : g >= 0.62 ? 'warn' : 'bad', duration: 4.5 });
    ok = await animate({ duration: 1.7, tag: TAG, ease: ease.linear });
    if (!ok || this.leaving) return;
    const s0 = mem.mesh.scale.x, p0 = mem.mesh.position.clone(), o0 = mem.glow.material.opacity;
    ok = await animate({
      duration: 0.45, tag: TAG, ease: ease.inCubic,
      onUpdate: (t) => { mem.mesh.scale.setScalar(Math.max(0.01, s0 * (1 - t))); mem.mesh.position.lerpVectors(p0, base, t); mem.glow.material.opacity = o0 * (1 - t); },
    });
    if (!ok || this.leaving) return;
    mem.mesh.visible = false;
    this.startFold(0.15, 0, 0.3);
    this.goView('knead', 0.9);
    this.testing = false;
    this.syncControls();
  }

  // -----------------------------------------------------------------------------------------------
  // Salida hacia la fermentación
  // -----------------------------------------------------------------------------------------------

  async goNext() {
    if (!this.ready || this.leaving || this.finishing || this.testing || this.confirming) return;
    this.endDrag(false);
    this.setAuto(false, '*');
    const k = this.state.knead;
    if (k.gluten < 0.7) {
      this.confirming = true;
      const pct = Math.round(k.gluten * 100);
      const v = await this.ui.showDialog({
        title: '¿Dejarla ya?',
        body: `El gluten está al ${pct} %. Con menos del 70 % la masa no retendrá bien el gas y la miga saldrá densa. Lo ideal es pasar del ${Math.round(GLUTEN_IDEAL[0] * 100)} %: unas cuantas amasadas más.`,
        actions: [
          { label: 'Seguir amasando', variant: 'secondary', value: 'stay' },
          { label: 'Dejar fermentar', variant: 'primary', value: 'go' },
        ],
      });
      this.confirming = false;
      if (v !== 'go' || this.leaving) return;
    }
    this.finishing = true;
    this.syncControls();
    this.setHover(false);
    // boleado final: media vuelta y un último aplastón para dejarla redonda
    this.yawGoal += Math.PI;
    this.startFold(0.3, 0, 0.55);
    this.audio?.play('thump', { volume: 0.6 });
    const ok = await animate({ duration: 0.6, tag: TAG, ease: ease.linear });
    if (!ok || this.leaving) return;
    this.complete();
  }

  // -----------------------------------------------------------------------------------------------
  // Bucle
  // -----------------------------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    if (this.leaving) return;
    const { dough } = this.models;
    const k = this.state.knead;

    // «Amasar» automático: empujón hacia el fondo (alternando un poco el ángulo) y pliegue
    let autoL = 0;
    if (this.auto && !this.drag && this.canKnead()) {
      if (this.autoT === 0) {
        const a = [0, 0.3, -0.3][this.autoCount % 3];
        this.dirW.set(Math.sin(a), -Math.cos(a));
      }
      this.autoT += dt;
      if (this.autoT < AUTO_PUSH) autoL = AUTO_LEN * ease.outQuad(this.autoT / AUTO_PUSH);
      else if (!this.autoReleased) {
        this.autoReleased = true;
        this.stroke(AUTO_LEN, { auto: true });
      }
      if (this.autoT >= AUTO_PERIOD) { this.autoT = 0; this.autoReleased = false; this.autoCount++; }
    }

    // objetivos de la deformación
    let L = 0;
    if (this.drag) {
      const d = this.drag;
      const dx = d.cur.x - d.start.x, dz = d.cur.z - d.start.z;
      L = Math.hypot(dx, dz);
      if (L > 0.004) this.dirW.set(dx / L, dz / L);
    } else L = autoL;
    const stGoal = L > 0 ? 1 - (1 - clamp(L / 0.16)) ** 2 : 0;
    let sqGoal = L > 0 ? 0.12 + 0.12 * stGoal : 0;
    const slide = Math.min(L, 0.22) * 0.3;
    let tilt = 0;
    if (this.fold) {
      const f = this.fold;
      f.t += dt;
      const e = clamp(f.t / f.dur);
      const s = Math.sin(Math.PI * e);
      sqGoal = Math.max(sqGoal, f.amp * s);
      tilt = f.tilt * s;
      if (e >= 1) this.fold = null;
    }
    const p = this.pose;
    p.stretch = damp(p.stretch, stGoal, L > 0 ? 14 : 18, dt);
    p.squash = damp(p.squash, sqGoal, 22, dt);
    p.slide.x = damp(p.slide.x, this.dirW.x * slide, 14, dt);
    p.slide.z = damp(p.slide.z, this.dirW.y * slide, 14, dt);
    this.yaw = Math.abs(this.yawGoal - this.yaw) < 1e-4 ? this.yawGoal : damp(this.yaw, this.yawGoal, 7, dt);

    if (this.ready) {
      const st = p.stretch < 1e-3 ? 0 : p.stretch;
      // la dirección solo importa mientras hay estirón (así no se reconstruye la masa sin necesidad)
      dough.set(st > 0 ? { stretch: st, squash: p.squash < 1e-3 ? 0 : p.squash, stretchDir: this.localDir() } : { stretch: 0, squash: p.squash < 1e-3 ? 0 : p.squash });
      dough.group.position.set(p.slide.x, 0, p.slide.z);
      // giro (cuarto de vuelta) + leve vaivén al plegar
      this.qYaw.setFromAxisAngle(UP, this.yaw);
      this.axis.set(this.dirW.y, 0, -this.dirW.x);
      this.qTilt.setFromAxisAngle(this.axis, tilt);
      dough.group.quaternion.multiplyQuaternions(this.qTilt, this.qYaw);
    }

    // la masa se alisa a medida que se desarrolla el gluten; la harina se absorbe
    // (valores redondeados: la masa solo se recalcula cuando el cambio se nota)
    const smoothGoal = Math.max(0.1, lerp(0.1, 1, k.gluten));
    this.smooth = damp(this.smooth ?? dough.params.smoothness, smoothGoal, 3, dt);
    this.flourVis = damp(this.flourVis, 0.1 + 0.08 * (1 - k.gluten), 0.25, dt);
    dough.set({ smoothness: Math.round(this.smooth * 200) / 200, flour: Math.round(this.flourVis * 200) / 200 });

    // sonido: textura blanda al estirar
    const want = this.drag ? clamp(0.25 + stGoal * 0.5) : this.auto && this.canKnead() ? 0.75 : 0;
    this.kneadLoop?.setIntensity(want);

    this.updateGuide(dt, L);
    this.updateMembrane();
    if (this.ready && !this.drag && !this.auto) this.idle += dt;

    // puntero encima de la masa (limitado a ~12 por segundo: el rayo contra la masa cuesta)
    if (this.hoverDirty && this.time - this.hoverAt > 0.08) {
      this.hoverDirty = false;
      this.hoverAt = this.time;
      this.setHover(!!this.proxyHit(this.hoverNdc));
    }
    // mensaje flotante (calidad de la amasada) o pista al pasar por encima
    if (this.feedback) {
      this.feedback.t -= dt;
      if (this.feedback.t <= 0) { this.feedback = null; if (!this.hovering) this.ui.hideHint(); }
    }
    // modo guiado: durante el estirón, una etiqueta en la punta de la flecha dice si ya vale
    if (this.drag && this.guided && L > TAP_MAX) {
      const [lo, hi] = STROKE_IDEAL;
      const text = L < lo ? 'Estira más…' : L <= hi ? '¡Así! Suelta' : '¡Demasiado!';
      this.ui.showHint(text, this.engine.worldToScreen(this.drag.cur));
      return;
    }
    const hintText = this.feedback?.text ?? (this.hovering && !this.drag && this.canKnead() ? 'Arrastra para estirar · toca para presionar' : null);
    if (hintText && this.ready && !this.testing) {
      dough.group.localToWorld(this.tmp.set(0, dough.getTopY() + 0.03, 0));
      this.ui.showHint(hintText, this.engine.worldToScreen(this.tmp));
    }
  }

  /** Flecha del estirón (o guía animada cuando aún no has amasado o llevas un rato quieto). */
  updateGuide(dt, L) {
    const g = this.guide;
    if (!g) return;
    const [lo, hi] = STROKE_IDEAL;
    if (this.drag && L > TAP_MAX) {
      const top = this.models.tools.board.anchors.top;
      const s = top.worldToLocal(this.tmp.copy(this.drag.start));
      const color = L < lo ? COLORS.short : L <= hi ? COLORS.good : COLORS.long;
      g.set({ x: s.x, z: s.z, angle: Math.atan2(-this.dirW.y, this.dirW.x), length: L, color, opacity: 0.95, zone: 1 });
      return;
    }
    const k = this.state.knead;
    const show = this.canKnead() && !this.drag && !this.auto && (k.strokes === 0 || (this.idle > 7 && k.gluten < GLUTEN_IDEAL[0]));
    this.ghost = damp(this.ghost ?? 0, show ? 1 : 0, 5, dt);
    if (this.ghost < 0.01) { g.hide(); return; }
    // de la masa hacia el fondo de la tabla, creciendo en bucle
    const ph = (this.time % 1.7) / 1.7;
    const len = lerp(0.03, 0.15, ease.inOutCubic(Math.min(1, ph * 1.3)));
    const fade = smoothstep(0, 0.08, ph) * (1 - smoothstep(0.8, 1, ph));
    const o = this.models.dough.group.position;
    g.set({ x: o.x, z: o.z + 0.01, angle: Math.PI / 2, length: len, color: COLORS.good, opacity: this.ghost * fade * 0.85, zone: 0 });
  }

  /** La película de la prueba de la ventana siempre mira a la cámara. */
  updateMembrane() {
    const m = this.membrane?.mesh;
    if (m?.visible) m.quaternion.copy(this.engine.camera.quaternion);
  }

  // -----------------------------------------------------------------------------------------------
  // Puntero y teclado
  // -----------------------------------------------------------------------------------------------

  /** Esfera aproximada de la masa (barata para el hover). */
  proxyHit(ndc) {
    if (!ndc) return null;
    const d = this.models.dough;
    const size = d.getSize();
    d.group.getWorldPosition(this.sphere.center);
    this.sphere.center.y += size.y * 0.45;
    this.sphere.radius = Math.max(size.x, size.z) * 0.5 * 1.3 + 0.01;
    this.raycaster.setFromCamera(ndc, this.engine.camera);
    return this.raycaster.ray.intersectSphere(this.sphere, this.tmp2);
  }

  /** Punto donde el rayo corta el plano del gesto (a media altura de la masa, sobre la tabla). */
  boardPoint(ndc) {
    const y = this.models.tools.board.anchors.top.getWorldPosition(this.tmp).y + DRAG_H;
    return this.engine.screenToPlane(ndc, y);
  }

  onPointerDown(ev) {
    if (ev.button > 0 || this.drag || !this.canKnead() || this.engine.controls.enabled) return;
    const { dough } = this.models;
    const near = this.proxyHit(ev.ndc);
    if (!near) return;
    const hit = this.engine.raycast(ev.ndc, dough.mesh, false)[0];
    const start = this.boardPoint(ev.ndc);
    if (!start) return;
    const local = dough.group.worldToLocal((hit ? hit.point : near).clone());
    this.drag = { id: ev.pointerId, start, cur: start.clone(), t0: this.time, local, maxLen: 0 };
    // durante el gesto la cámara no se mueve con el ratón (el estirón se mide en la tabla)
    if (this.parallaxSaved == null) { this.parallaxSaved = this.engine.parallaxEnabled; this.engine.parallaxEnabled = false; }
    this.engine.setCursor('grabbing');
    dough.setHighlight(false);
    this.feedback = null;
    this.ui.hideHint();
    dough.dent(local, { radius: 0.03, depth: 0.005, recovery: 0.5 });
  }

  onPointerMove(ev) {
    if (this.drag) {
      if (ev.pointerId !== this.drag.id) return;
      const p = this.boardPoint(ev.ndc);
      if (p) {
        this.drag.cur.copy(p);
        this.drag.maxLen = Math.max(this.drag.maxLen, Math.hypot(p.x - this.drag.start.x, p.z - this.drag.start.z));
      }
      return;
    }
    if (ev.pointerType === 'touch' || !this.canKnead()) return;
    this.hoverNdc = ev.ndc.clone();
    this.hoverDirty = true;
  }

  onPointerUp(ev) {
    if (!this.drag || ev.pointerId !== this.drag.id) return;
    this.endDrag(true);
  }

  /** Termina el gesto: estirón (pliegue), toque (presión) o cancelación (vuelve sin contar). */
  endDrag(commit) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (this.parallaxSaved != null) { this.engine.parallaxEnabled = this.parallaxSaved; this.parallaxSaved = null; }
    this.engine.setCursor(this.hovering ? 'grab' : '');
    this.guide?.hide();
    this.ui.hideHint();
    if (!commit || !this.canKnead()) { this.startFold(0.12, 0); return; }
    const L = Math.hypot(d.cur.x - d.start.x, d.cur.z - d.start.z);
    if (d.maxLen < TAP_MAX) this.stroke(0, { tap: true, local: d.local });
    else this.stroke(L);
  }

  setHover(on) {
    if (on === this.hovering) return;
    this.hovering = on;
    if (!this.drag) this.engine.setCursor(on ? 'grab' : '');
    this.models.dough.setHighlight(on && !this.drag && this.state.knead.strokes < 3);
    if (!on && !this.feedback) this.ui.hideHint();
  }

  onKey(e, down) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!down) { this.setAuto(false, 'key'); return; }
    if (this.leaving) return;
    const t = e.target;
    if (t && t !== document.body && t.closest?.('button, input, select, textarea, a, [role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    if (!e.repeat) this.setAuto(true, 'key');
  }

  /** Nubecilla de harina a ras de tabla (x, z relativos a la masa, en mundo). */
  puffAt(x, z, { count = 14, spread = 0.05 } = {}) {
    const g = this.models.dough.group;
    g.getWorldPosition(this.tmp);
    this.tmp.x += x;
    this.tmp.z += z;
    this.tmp.y += 0.012;
    this.particles?.puff(this.tmp, { color: FLOUR_COLOR, count, spread, size: 0.012, life: 0.9, rise: 0.03 });
  }

  // -----------------------------------------------------------------------------------------------
  // Salida
  // -----------------------------------------------------------------------------------------------

  async exit() {
    this.leaving = true;
    cancelAnimations(TAG);
    const { dough, tools } = this.models;
    this.auto = false;
    if (this.drag) { this.drag = null; }
    if (this.parallaxSaved != null) { this.engine.parallaxEnabled = this.parallaxSaved; this.parallaxSaved = null; }
    // la masa queda en la tabla, redonda y quieta
    if (dough.group.parent !== tools.board.anchors.top) tools.board.anchors.top.add(dough.group);
    dough.group.position.set(0, 0, 0);
    dough.group.rotation.set(0, this.yawGoal % TAU, 0);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.setHighlight(false);
    const g = this.state.knead.gluten;
    dough.set({ shape: 'ball', stretch: 0, squash: 0, smoothness: Math.max(0.1, lerp(0.1, 1, g)), flour: 0.15, hydration: this.hydration });
    tools.board.setFlour(Math.max(0.3, this.boardFlour));
    this.membrane?.dispose();
    this.membrane = null;
    super.exit();
  }

  async autoComplete() {
    const { tools, dough } = this.models;
    Object.assign(this.state.knead, { gluten: 0.93, strokes: 32, extraFlour: 10, windowpane: true });
    tools.board.setFlour(0.6);
    tools.scale.setReading(0);
    this.placeAt(dough.group, tools.board.anchors.top);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.setHighlight(false);
    dough.set({ shape: 'ball', mix: 1, smoothness: 0.93, hydration: this.hydration, flour: 0.15, rise: 1, collapse: 0, squash: 0, stretch: 0 });
    this.game.advanceClock(32 * SIM_MIN_PER_STROKE);
  }
}
