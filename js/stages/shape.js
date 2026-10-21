// Etapa 5 · Formar: desgasificar, dar forma, segundo levado, greñar y cobertura.
// Tres fases en la misma etapa: forma (en la tabla) → segundo levado (bandeja o molde) → cortes y cobertura.
import * as THREE from 'three';
import { Stage, scorePattern } from './stage.js';
import { proofStep, initialProof, idealProofMinutes, proofStatus, riseFromProgress } from '../recipe.js';
import { animate, ease, cancelAnimations } from '../core/anim.js';
import { clamp, lerp, smoothstep, damp, formatMinutes, makeCanvasTexture } from '../core/utils.js';

const TAG = 'shape-stage';
const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const PROOF_C = 24;      // el segundo levado se hace en la cocina templada (°C)
const DEGASSED = 1.05;   // volumen de la masa tras desgasificarla
const PRESSES = 3;       // aplastones para sacarle el gas
const MAX_CUTS = 6;      // cortes como mucho
const MIN_CUT = 0.02;    // un corte cuenta a partir de 2 cm
const MAX_LEN = 0.42;    // la barra no puede pasar del largo útil de la bandeja (m)
const EXTRA_MIN = 15;    // minutos de «Levar 15 min más»
const MAX_PROOF = 240;   // tope del segundo levado (min)

/** Formas que se le pueden dar a la masa. */
const SHAPES = {
  boule: {
    label: 'Hogaza redonda', the: 'la hogaza', done: '¡Hogaza formada! Bola tensa y redonda.',
    text: 'Pliegas los bordes hacia el centro y la boleas sobre la tabla para que coja tensión.',
  },
  baguette: {
    label: 'Barra', the: 'la barra', done: '¡Barra formada! Larga, fina y con las puntas afiladas.',
    text: 'La aplanas, la pliegas en tres y la enrollas estirando con las palmas hacia las puntas.',
  },
  loaf: {
    label: 'Molde', the: 'el pan de molde', done: '¡Rulo al molde, con la unión hacia abajo!',
    text: 'La aplanas y la enrollas como un rulo del largo del molde, con la unión hacia abajo.',
  },
};

/** Qué forma pide cada receta (texto para la instrucción). */
const RECIPE_SHAPE = {
  hogaza: 'La hogaza se forma redonda: una bola tensa.',
  baguette: 'La baguette se forma en barra larga y fina.',
  molde: 'El pan de molde se forma en rulo y se cuece dentro del molde.',
};

const PATTERNS = [
  { value: 'cross', label: 'Cruz' },
  { value: 'diagonals', label: 'Diagonales' },
  { value: 'long', label: 'Un corte largo' },
];
const TOPPINGS = [
  { value: 'none', label: 'Nada' },
  { value: 'flour', label: 'Harina' },
  { value: 'sesame', label: 'Sésamo' },
  { value: 'poppy', label: 'Amapola' },
];
/** Partículas al espolvorear cada cobertura. */
const SPRINKLE = {
  flour: { color: 0xfbf8f1, size: 0.0042, rate: 260 },
  sesame: { color: 0xeedcb3, size: 0.0034, rate: 170 },
  poppy: { color: 0x2b2d36, size: 0.0028, rate: 210 },
};

/** "×1,8" (coma decimal). */
const times = (r) => `×${(Math.round(r * 10) / 10).toFixed(1).replace('.', ',')}`;
/** Duración con espacios duros ("1 h 05 min" no se parte en dos líneas). */
const mins = (m) => formatMinutes(m).replace(/ /g, '\u00a0');
const DEG = `${PROOF_C}\u00a0°C`;
/** Ángulo en (-π, π]. */
const wrap = (a) => a - TAU * Math.round(a / TAU);
/** true con la interfaz de móvil (hoja inferior con instrucciones y controles). */
const isPhone = () => window.matchMedia?.('(max-width: 720px)').matches ?? false;

/** Curva de un aplastón: baja rápido, rebota y se asienta (aplastado 0..0,5). */
function pressCurve(t) {
  if (t < 0.09) return 0.5 * smoothstep(0, 0.09, t);
  const u = t - 0.09;
  return Math.max(0, 0.5 * Math.exp(-6 * u) * Math.cos(u * 12));
}

/**
 * Vista que encuadra `subject` desde la dirección `dir` a `dist` metros y lo deja en la posición de
 * pantalla `ndc` ([-1..1]), lejos de los paneles de la interfaz.
 */
function frameView(camera, subject, dir, dist, ndc) {
  const d = dir.clone().normalize();
  const position = subject.clone().addScaledVector(d, dist);
  const fwd = d.clone().negate();
  const right = V().crossVectors(fwd, UP).normalize();
  const up = V().crossVectors(right, fwd);
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), tanH = tanV * camera.aspect;
  const target = subject.clone()
    .addScaledVector(right, -ndc[0] * tanH * dist)
    .addScaledVector(up, -ndc[1] * tanV * dist);
  return { position, target };
}

let dashTex = null;
/** Textura de trazos para la guía punteada de los cortes. */
function dashTexture() {
  dashTex ??= makeCanvasTexture(64, 16, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.roundRect(2, 2, w * 0.55, h - 4, (h - 4) / 2);
    g.fill();
  }, { repeat: [1, 1] });
  return dashTex;
}

/**
 * Cinta fina pegada a la superficie de la masa (espacio local de la masa): el rastro de la cuchilla
 * mientras cortas o la guía punteada de los cortes recomendados.
 */
function makeRibbon({ color = 0x4a2c16, opacity = 0.8, width = 0.0036, lift = 0.0016, dashed = false, max = 160 } = {}) {
  const pos = new Float32Array(max * 6), uv = new Float32Array(max * 4);
  const index = [];
  for (let i = 0; i < max - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(index);
  geo.setDrawRange(0, 0);
  const mat = new THREE.MeshBasicMaterial({
    color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, map: dashed ? dashTexture() : null,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = dashed ? 'shape-guide' : 'shape-trail';
  mesh.frustumCulled = false;
  mesh.renderOrder = 7;
  mesh.visible = false;
  mesh.raycast = () => {};
  const t = V(), s = V(), q = V();
  return {
    mesh, mat,
    /** @param {{p: THREE.Vector3, n: THREE.Vector3}[]} pts puntos locales con su normal */
    set(pts, dashLen = 0.012) {
      const n = Math.min(pts.length, max);
      let u = 0;
      for (let i = 0; i < n; i++) {
        t.subVectors(pts[Math.min(n - 1, i + 1)].p, pts[Math.max(0, i - 1)].p);
        if (t.lengthSq() < 1e-12) t.set(1, 0, 0);
        t.normalize();
        const nn = pts[i].n;
        s.crossVectors(nn, t);
        if (s.lengthSq() < 1e-12) s.set(0, 0, 1);
        s.normalize().multiplyScalar(width / 2);
        if (i) u += pts[i].p.distanceTo(pts[i - 1].p) / dashLen;
        q.copy(pts[i].p).addScaledVector(nn, lift);
        const j = i * 6;
        pos[j] = q.x + s.x; pos[j + 1] = q.y + s.y; pos[j + 2] = q.z + s.z;
        pos[j + 3] = q.x - s.x; pos[j + 4] = q.y - s.y; pos[j + 5] = q.z - s.z;
        uv[i * 4] = u; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = u; uv[i * 4 + 3] = 1;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.uv.needsUpdate = true;
      geo.setDrawRange(0, Math.max(0, n - 1) * 6);
      mesh.visible = n > 1;
    },
    clear() { geo.setDrawRange(0, 0); mesh.visible = false; },
    dispose() { mesh.removeFromParent(); geo.dispose(); mat.dispose(); },
  };
}

export class ShapeStage extends Stage {
  constructor(game) {
    super(game);
    // intro → degas → degassed → shape → forming → proof → score (→ leaving)
    this.phase = 'intro';
    this.exited = false;
    this.busy = false;          // animación en curso: se ignoran la masa y los botones repetidos
    this.leaving = false;
    this.asking = false;        // diálogo abierto
    this.time = 0;
    this.shape = this.bread.shape;
    // desgasificar
    this.rise = 1;
    this.riseGoal = 1;
    this.rise0 = 1;
    this.collapse0 = 0;
    this.presses = 0;
    this.pressAt = -1;
    this.pulses = [];
    // segundo levado
    this.proof = initialProof(PROOF_C);
    this.proofDone = false;
    this.proofChoice = 'normal';
    this.proofOpts = null;
    // cortes y cobertura
    this.cuts = 0;
    this.pattern = null;
    this.base = 'none';
    this.egg = false;
    this.toppingPending = null;
    this.toppingDelay = 0;
    this.fx = null;
    this.drag = null;
    this.ribbon = null;
    this.ghosts = [];
    // puntero
    this.hoverNdc = null;
    this.hoverDirty = false;
    this.hoverHit = null;
    this.hovering = false;
    this.glow = false;
    this.pointer = null;
    this.lameOut = false;
    this.lameIdle = 0;
    this.lameYaw = Math.PI / 2; // hoja hacia el fondo, mango hacia ti
    this.tinHomeY = null;
    this.view = 'board';
    this.ctl = null;
    this.meterKey = '';
    this.flags = {};
  }

  // ---------------------------------------------------------------------------------------------
  // Entrada y salida
  // ---------------------------------------------------------------------------------------------

  async enter() {
    const { dough, tools } = this.models;
    const g = dough.group;
    this.parallax0 = this.engine.parallaxEnabled;
    this.track(() => { this.engine.parallaxEnabled = this.parallax0; });
    this.rise0 = Math.max(1, dough.params.rise || 1);
    this.collapse0 = clamp(dough.params.collapse || 0);
    this.rise = this.rise0;
    this.riseGoal = this.rise0;
    g.visible = true;
    g.scale.set(1, 1, 1);
    tools.tin.hide();
    tools.tray.show();
    tools.board.setFlour(Math.max(tools.board.flour ?? 0, 0.45));

    this.ribbon = makeRibbon();
    g.add(this.ribbon.mesh);
    this.track(() => { this.ribbon?.dispose(); this.ribbon = null; });

    const onResize = () => { if (!this.exited) this.goView(this.view, 0.3); };
    const onBlur = () => { this.endDrag(false); this.clearHover(); };
    const onLeave = () => { if (!this.drag) this.clearHover(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    this.engine.canvas.addEventListener('pointerleave', onLeave);
    this.track(() => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
      this.engine.canvas.removeEventListener('pointerleave', onLeave);
    });

    this.enterDegas();
    this.goView('board', 1.5);
    if (g.parent === tools.board.anchors.top) return;
    // del bol a la tabla: la masa sale del bol y viaja a la tabla enharinada
    this.busy = true;
    this.ui.setBusy(true);
    if (tools.cloth.isCovering) await tools.cloth.uncover();
    if (this.exited) return;
    const ok = await this.fly(tools.board.anchors.top, { lift: 0.13, height: 0.1, duration: 1.05 });
    if (!ok || this.exited) return;
    this.land(0.7);
    this.busy = false;
    this.ui.setBusy(false);
    this.hoverDirty = true;
  }

  async exit() {
    this.exited = true;
    cancelAnimations(TAG);
    const { dough, tools } = this.models;
    this.drag = null;
    this.fx?.stream?.stop();
    this.fx = null;
    this.hideGhost();
    dough.setHighlight(false);
    if (this.tinHomeY != null) { tools.tin.object.position.y = this.tinHomeY; this.tinHomeY = null; }
    if (this.done) {
      // la masa se queda asentada en su bandeja o molde, con la cobertura puesta
      this.flushTopping();
      dough.set({ squash: 0, stretch: 0 });
    } else if (this.lameOut) {
      tools.lame.reset();
    }
    super.exit();
  }

  /**
   * Resultado bueno al instante (pruebas): forma de la receta, segundo levado en su punto, cortes
   * recomendados y cobertura sugerida, con la masa ya en su bandeja o molde.
   */
  async autoComplete() {
    const { tools, dough } = this.models;
    const bread = this.bread;
    const shape = bread.shape;
    this.shape = shape;
    const topping = bread.toppings?.suggested ?? 'none';
    const [lo, hi] = bread.proof2Ideal;
    const env = { amounts: this.state.amounts, tempC: PROOF_C };
    let proof = initialProof(PROOF_C);
    while (proof.p < (lo + hi) / 2 && proof.minutes < 600) proof = proofStep(proof, 1, env);
    this.state.proof2 = proof;
    this.game.advanceClock(proof.minutes);

    if (shape === 'loaf') {
      tools.tray.hide();
      tools.tin.show();
      this.placeAt(dough.group, tools.tin.anchors.inside);
    } else {
      tools.tin.hide();
      tools.tray.show();
      tools.tray.setParchment(true);
      this.placeAt(dough.group, tools.tray.anchors.top);
    }
    dough.group.visible = true;
    dough.group.scale.set(1, 1, 1);
    dough.clearScores();
    dough.morphTo(shape, 0);
    this.rise = Math.max(DEGASSED, proof.rise);
    dough.set({
      shape, inTin: shape === 'loaf', rise: this.rise, collapse: proof.collapse,
      smoothness: Math.max(0.85, this.state.knead.gluten), flour: 0, squash: 0, stretch: 0,
    });
    this.fitLength();
    dough.getSize(); // reconstruye ya: los cortes se guardan a la escala actual
    const pattern = this.suggestedPattern();
    const cuts = pattern ? this.patternPaths(pattern) : [];
    for (const c of cuts) dough.addScore(c);
    dough.setTopping(topping);
    tools.lame.reset();
    this.state.shape = { shape, scores: cuts.length, topping };
  }

  // ---------------------------------------------------------------------------------------------
  // Ayudas
  // ---------------------------------------------------------------------------------------------

  /** Animación con la etiqueta de la etapa (se cancela al salir). Resuelve false si se cancela. */
  anim(duration, onUpdate, easing = ease.inOutCubic) {
    return animate({ duration, ease: easing, tag: TAG, onUpdate });
  }

  /** Espera en tiempo de juego (se cancela al salir). */
  pause(seconds) { return this.anim(seconds, null, ease.linear); }

  breadName() {
    return { hogaza: 'la hogaza', baguette: 'la baguette', molde: 'el pan de molde' }[this.state.breadId] ?? 'este pan';
  }

  /** 'la bandeja' o 'el molde'. */
  box() { return this.shape === 'loaf' ? 'el molde' : 'la bandeja'; }

  /** Punto de mundo sobre lo más alto de la masa. */
  doughTop(up = 0) {
    const { dough } = this.models;
    return dough.group.localToWorld(V(0, dough.getTopY() + up, 0));
  }

  /** Nubecilla de harina alrededor de la base de la masa. */
  flourPuff(count = 14, spread = 0.1) {
    const p = this.models.dough.group.getWorldPosition(V()).add(V(0, 0.012, 0));
    this.particles?.puff(p, { color: 0xf6efe2, count, spread, size: 0.013, life: 1.0 });
  }

  /** La barra no puede salirse de la bandeja: si al crecer pasa de MAX_LEN, se acorta un poco. */
  fitLength() {
    const { dough } = this.models;
    if (this.shape !== 'baguette') { dough.group.scale.set(1, 1, 1); return; }
    const s = dough.getSize();
    dough.group.scale.set(Math.min(1, MAX_LEN / Math.max(s.x, 1e-3)), 1, 1);
  }

  /** Lleva la masa volando hasta `anchor` (si hace falta, primero sube en vertical) y la cuelga de él. */
  async fly(anchor, { lift = 0, height = 0.14, duration = 1 } = {}) {
    const g = this.models.dough.group;
    this.engine.scene.attach(g);
    this.audio?.play('whoosh', { volume: 0.5 });
    if (lift > 0) {
      const y0 = g.position.y;
      if (!(await this.anim(0.3, (t) => { g.position.y = y0 + lift * t; }, ease.outCubic))) return false;
    }
    const from = g.position.clone(), to = anchor.getWorldPosition(V());
    const r0 = g.rotation.clone();
    const ok = await this.anim(duration, (t) => {
      g.position.lerpVectors(from, to, t);
      g.position.y += Math.sin(Math.PI * t) * height;
      g.rotation.set(r0.x * (1 - t), r0.y, r0.z * (1 - t));
    });
    if (!ok) return false;
    anchor.attach(g);
    g.position.set(0, 0, 0);
    g.rotation.set(0, g.rotation.y, 0);
    return true;
  }

  /** La masa cae en su sitio: «plof», harina y un temblor. */
  land(flour = 0.5) {
    const { dough } = this.models;
    this.audio?.play('plop', { volume: 0.85 });
    if (flour > 0) this.flourPuff(Math.round(10 + 22 * flour), 0.11);
    dough.dent(V(0, dough.getTopY(), 0), { radius: 0.06, depth: 0.008, recovery: 0.5 });
  }

  // ---------------------------------------------------------------------------------------------
  // Cámara
  // ---------------------------------------------------------------------------------------------

  /**
   * Altura (ndc) del centro de la franja libre de pantalla: entre la barra de arriba (y en el móvil la tira
   * de medidores) y el dock o la hoja de abajo. Se mide en vivo porque cada fase tiene un dock distinto.
   */
  freeNdcY() {
    const phone = isPhone();
    const [fallback, lo, hi] = phone ? [0.3, 0.1, 0.45] : [0.1, 0.04, 0.18];
    try {
      const root = this.ui.root ?? document;
      const H = window.innerHeight || 1;
      const rect = (sel) => {
        const e = root.querySelector?.(sel);
        const r = e && !e.hidden ? e.getBoundingClientRect() : null;
        return r && r.height > 0 ? r : null;
      };
      let top = rect('.topbar')?.bottom ?? 60;
      if (phone) top = Math.max(top, rect('.side--right')?.bottom ?? 0);
      const low = (phone && rect('.sheet')) || rect('.dock');
      const bottom = low ? Math.min(H, low.top) : H;
      if (!(bottom - top > 80)) return fallback;
      return clamp(1 - (top + bottom) / H, lo, hi);
    } catch {
      return fallback;
    }
  }

  /** Vistas de la etapa: tabla, bandeja (3/4) y cortes (casi cenital), para escritorio o móvil. */
  viewFor(kind) {
    const { tools } = this.models;
    const phone = isPhone();
    const ndc = [0, this.freeNdcY()];
    if (kind === 'board') {
      const subject = tools.board.anchors.top.getWorldPosition(V()).add(V(0, 0.05, 0));
      return frameView(this.engine.camera, subject, V(0, 0.64, 0.77), phone ? 0.9 : 0.66, ndc);
    }
    const loaf = this.shape === 'loaf', long = this.shape === 'baguette';
    const anchor = loaf ? tools.tin.anchors.inside : tools.tray.anchors.top;
    const subject = anchor.getWorldPosition(V()).add(V(0, loaf ? 0.07 : 0.04, 0));
    if (kind === 'tray') {
      return frameView(this.engine.camera, subject, V(0, 0.62, 0.78), long ? (phone ? 1.04 : 0.78) : (phone ? 0.78 : 0.6), ndc);
    }
    // cortes: desde arriba, para que arrastrar sobre la pantalla sea dibujar sobre la masa
    return frameView(this.engine.camera, subject, V(0, 0.93, 0.36), long ? (phone ? 1.02 : 0.74) : (phone ? 0.74 : 0.58), ndc);
  }

  goView(kind, duration = 1.3) {
    this.view = kind;
    if (this.exited) return Promise.resolve(false);
    return this.camera(this.viewFor(kind), { duration });
  }

  // ---------------------------------------------------------------------------------------------
  // Fase 1a · Desgasificar
  // ---------------------------------------------------------------------------------------------

  enterDegas() {
    this.phase = 'degas';
    this.instruct('Desgasifica la masa',
      `Ha crecido hasta ${times(this.rise0)}. Aplástala con la palma para sacarle el gas: toca la masa ${PRESSES} veces (o pulsa «Desgasificar»).`,
      'Sin miedo: se escapan las burbujas grandes y quedan las pequeñas, que darán una miga regular.');
    this.ctl = this.ui.setControls([
      { type: 'button', id: 'degas', label: 'Desgasificar', icon: 'hand', variant: 'primary', onClick: () => this.autoDegas() },
    ]);
    this.refreshMeters(true);
  }

  /**
   * Un aplastón: la masa se hunde, suelta gas y pierde volumen.
   * @param {THREE.Vector3} [localPoint] punto tocado (local de la masa); si no, cerca de lo alto
   */
  press(localPoint) {
    if (this.phase !== 'degas' || this.presses >= PRESSES || this.time - this.pressAt < 0.16) return false;
    const { dough } = this.models;
    this.pressAt = this.time;
    this.presses++;
    this.riseGoal = lerp(this.rise0, DEGASSED, this.presses / PRESSES);
    this.pulses.push(0);
    const p = localPoint ?? V((Math.random() - 0.5) * 0.04, dough.getTopY(), (Math.random() - 0.5) * 0.04);
    dough.dent(p, { radius: 0.055, depth: 0.02, recovery: 0.9 });
    this.audio?.play('thump', { volume: 0.9, rate: 0.92 + Math.random() * 0.16 });
    // el gas se escapa: burbujitas que estallan
    for (let i = 0; i < 3; i++) {
      animate({ duration: 0.01, delay: 0.07 + i * 0.07 + Math.random() * 0.04, tag: TAG,
        onComplete: () => this.audio?.play('pop', { volume: 0.3, rate: 1.2 + Math.random() * 0.7 }) });
    }
    this.particles?.puff(dough.group.localToWorld(p.clone()), { color: 0xffffff, count: 7, spread: 0.04, size: 0.008, life: 0.7, rise: 0.1 });
    this.flourPuff(16, 0.12);
    if (this.presses >= PRESSES) this.degassed();
    this.hoverDirty = true;
    return true;
  }

  /** «Desgasificar» (teclado, táctil): los aplastones que falten, seguidos. */
  async autoDegas() {
    if (this.phase !== 'degas' || this.busy) return;
    this.busy = true;
    this.ctl?.get('degas').set({ disabled: true });
    while (this.phase === 'degas' && this.presses < PRESSES && !this.exited) {
      this.pressAt = -1;
      this.press(null);
      if (!(await this.pause(0.42))) return;
    }
    this.busy = false;
  }

  async degassed() {
    this.phase = 'degassed';
    this.ctl?.get('degas').set({ disabled: true });
    this.setHover(false);
    if (!(await this.pause(0.55)) || this.exited) return;
    this.audio?.play('pop', { volume: 0.6, rate: 0.8 });
    this.ui.toast('¡Gas fuera! La masa ha vuelto casi a su tamaño y ya se puede formar.', { tone: 'good' });
    this.enterShape();
  }

  updateDegas(dt) {
    const { dough } = this.models;
    if (Math.abs(this.rise - this.riseGoal) > 5e-4) {
      this.rise = damp(this.rise, this.riseGoal, 5, dt);
      const k = clamp((this.rise0 - this.rise) / Math.max(1e-3, this.rise0 - DEGASSED));
      dough.set({ rise: this.rise, collapse: this.collapse0 * (1 - k) });
      this.refreshMeters();
    }
    let sq = 0;
    for (let i = this.pulses.length - 1; i >= 0; i--) {
      const t = (this.pulses[i] += dt);
      if (t > 1) { this.pulses.splice(i, 1); continue; }
      sq = Math.max(sq, pressCurve(t));
    }
    if (sq > 0 || dough.params.squash !== 0) dough.set({ squash: sq });
  }

  // ---------------------------------------------------------------------------------------------
  // Fase 1b · Dar forma
  // ---------------------------------------------------------------------------------------------

  enterShape() {
    this.phase = 'shape';
    this.instruct('Dale forma',
      `Elige la forma y pulsa «Formar». ${RECIPE_SHAPE[this.state.breadId] ?? ''}`.trim(),
      this.bread.tips?.shape);
    this.ctl = this.ui.setControls([
      {
        type: 'choice', id: 'shape', label: 'Forma', value: this.shape,
        options: Object.entries(SHAPES).map(([value, s]) => ({ value, label: s.label })),
        onChange: (v) => this.chooseShape(v),
      },
      { type: 'button', id: 'form', label: 'Formar', icon: 'loaf', variant: 'primary', onClick: () => this.form() },
    ]);
    this.goView('board', 0.8); // reencuadre suave al hueco que deja el dock nuevo
    this.hoverDirty = true;
  }

  chooseShape(v) {
    if (!SHAPES[v] || this.phase !== 'shape') return;
    this.shape = v;
    this.audio?.play('click', { volume: 0.6 });
    if (this.guided && v !== this.bread.shape) {
      this.ui.toast(`${RECIPE_SHAPE[this.state.breadId]} Puedes hacer ${v === 'loaf' ? 'un pan de molde' : v === 'boule' ? 'una hogaza redonda' : 'una barra'}, pero no será lo que pide la receta.`, { tone: 'warn', duration: 3.6 });
    }
  }

  /** «Formar»: coreografía de formado y viaje a la bandeja o al molde. */
  async form() {
    if (this.phase !== 'shape' || this.busy || this.leaving) return;
    const shape = this.shape;
    this.busy = true;
    this.phase = 'forming';
    this.setHover(false);
    this.ui.setBusy(true);
    this.instruct(`Formando ${SHAPES[shape].the}…`, SHAPES[shape].text);
    if (!(await this.choreography(shape)) || this.exited) return;
    if (!(await this.toContainer(shape)) || this.exited) return;
    this.busy = false;
    this.ui.setBusy(false);
    this.enterProof();
  }

  /** Pliegues, aplastones y giros mientras la masa se transforma en la forma elegida. */
  async choreography(shape) {
    const { dough } = this.models;
    const g = dough.group;
    const dir2 = (a) => new THREE.Vector2(Math.cos(a), Math.sin(a));
    const thump = (v = 0.7) => { this.audio?.play('thump', { volume: v, rate: 0.9 + Math.random() * 0.25 }); this.flourPuff(8, 0.08); };
    this.pulses.length = 0;
    // volumen, harina y piel se asientan durante todo el formado
    const r0 = this.rise, c0 = dough.params.collapse, f0 = dough.params.flour, s0 = dough.params.smoothness;
    const s1 = Math.max(s0, 0.85, this.state.knead?.gluten ?? 0);
    this.anim(2.2, (t) => {
      this.rise = lerp(r0, DEGASSED, t);
      dough.set({ rise: this.rise, collapse: c0 * (1 - t), flour: lerp(f0, 0, t), smoothness: lerp(s0, s1, t) });
    }, ease.outCubic);
    const yawStart = g.rotation.y;

    if (shape === 'boule') {
      // 1) tres pliegues hacia el centro, girando la masa un tercio entre uno y otro
      for (let i = 0; i < 3; i++) {
        dough.set({ stretchDir: dir2(0.5 + (i * TAU) / 3) });
        const y0 = g.rotation.y;
        const ok = await this.anim(0.34, (t, raw) => {
          const k = Math.sin(Math.PI * raw);
          dough.set({ stretch: 0.5 * k, squash: 0.12 * k });
          g.rotation.y = y0 + (TAU / 3) * t;
        }, ease.inOutSine);
        if (!ok) return false;
        thump(0.55);
      }
      // 2) bolear: da una vuelta sobre la tabla mientras coge tensión
      this.audio?.play('whoosh', { volume: 0.55 });
      dough.morphTo('boule', 1.1);
      const y0 = g.rotation.y;
      const ok = await this.anim(1.1, (t, raw) => {
        g.rotation.y = y0 + TAU * t;
        g.rotation.z = 0.05 * Math.sin(raw * TAU * 3) * (1 - raw);
        dough.set({ squash: 0.14 * Math.abs(Math.sin(raw * Math.PI * 3)) * (1 - raw) });
      }, ease.inOutSine);
      if (!ok) return false;
    } else {
      // 1) aplanar en un rectángulo
      const ok1 = await this.anim(0.32, (t) => dough.set({ squash: 0.5 * t }), ease.outCubic);
      if (!ok1) return false;
      thump(0.85);
      // 2) plegar en tres: primero un borde y luego el otro
      for (const a of [Math.PI / 2, -Math.PI / 2]) {
        dough.set({ stretchDir: dir2(a) });
        const sq0 = dough.params.squash;
        const ok = await this.anim(0.3, (t, raw) => dough.set({ stretch: 0.45 * Math.sin(Math.PI * raw), squash: sq0 - 0.1 * t }), ease.inOutSine);
        if (!ok) return false;
        thump(0.6);
      }
      // 3) enrollar: rueda adelante y atrás bajo las palmas mientras toma forma
      this.audio?.play('whoosh', { volume: 0.5 });
      const dur = shape === 'baguette' ? 1.35 : 1.15;
      dough.morphTo(shape, dur);
      const y0 = g.rotation.y, y1 = Math.round(y0 / Math.PI) * Math.PI; // a lo largo de la tabla (eje X)
      const sq0 = dough.params.squash;
      const waves = shape === 'baguette' ? 2.5 : 2;
      const ok = await this.anim(dur, (t, raw) => {
        const w = Math.sin(raw * TAU * waves);
        g.rotation.y = lerp(y0, y1, t);
        g.rotation.x = (shape === 'baguette' ? 0.16 : -0.13) * w * (1 - 0.75 * raw);
        dough.set(shape === 'baguette'
          ? { stretchDir: dir2(w >= 0 ? 0 : Math.PI), stretch: 0.24 * Math.abs(w) * (1 - raw), squash: sq0 * (1 - t) }
          : { stretchDir: dir2(Math.PI / 2), stretch: 0.2 * Math.abs(w) * (1 - raw), squash: sq0 * (1 - t) + 0.05 * Math.abs(w) * (1 - raw) });
      }, ease.inOutSine);
      if (!ok) return false;
      thump(0.5);
    }
    // 3) asentar: rebote elástico y giro a una posición limpia
    this.audio?.play('plop', { volume: 0.6 });
    const y0 = g.rotation.y, y1 = shape === 'boule' ? yawStart + Math.round((y0 - yawStart) / TAU) * TAU : Math.round(y0 / Math.PI) * Math.PI;
    const x0 = g.rotation.x, z0 = g.rotation.z;
    const ok = await this.anim(0.55, (t, raw) => {
      g.rotation.set(x0 * (1 - t), lerp(y0, y1, t), z0 * (1 - t));
      dough.set({ squash: Math.max(0, 0.2 * Math.exp(-5 * raw) * Math.cos(raw * 13)), stretch: 0 });
    }, ease.outCubic);
    if (!ok) return false;
    g.rotation.set(0, wrap(y1), 0);
    dough.set({ squash: 0, stretch: 0 });
    return true;
  }

  /** La masa formada va a la bandeja (con papel) o al molde, y la cámara la sigue. */
  async toContainer(shape) {
    const { tools, dough } = this.models;
    let anchor;
    if (shape === 'loaf') {
      // el molde aparece en el sitio de la bandeja
      tools.tray.hide();
      tools.tin.show();
      const obj = tools.tin.object;
      const y0 = (this.tinHomeY = obj.position.y);
      this.audio?.play('whoosh', { volume: 0.35 });
      const ok = await this.anim(0.6, (t) => { obj.position.y = y0 + 0.16 * (1 - t); }, ease.outBounce);
      obj.position.y = y0;
      this.tinHomeY = null;
      if (!ok) return false;
      this.audio?.play('click', { volume: 0.8, rate: 0.7 });
      anchor = tools.tin.anchors.inside;
    } else {
      tools.tin.hide();
      tools.tray.show();
      if (!tools.tray.hasParchment) {
        tools.tray.setParchment(true);
        this.audio?.play('cloth', { volume: 0.7 });
        if (!(await this.pause(0.3))) return false;
      }
      anchor = tools.tray.anchors.top;
    }
    this.goView('tray', 1.6);
    if (!(await this.fly(anchor, { lift: 0.02, height: 0.16, duration: 1.15 }))) return false;
    if (shape === 'loaf') dough.set({ inTin: true });
    this.fitLength();
    this.land(shape === 'loaf' ? 0 : 0.25);
    this.audio?.play('success', { volume: 0.8 });
    this.particles?.sparkle(this.doughTop(0.03), { count: 28, spread: 0.07 });
    this.ui.toast(SHAPES[shape].done, { tone: 'good' });
    return this.pause(0.45);
  }

  // ---------------------------------------------------------------------------------------------
  // Fase 2 · Segundo levado
  // ---------------------------------------------------------------------------------------------

  /** Opciones de tiempo según lo rápido que fermenta esta masa a 24 °C (Normal = en su punto). */
  proofOptions() {
    const env = { amounts: this.state.amounts, tempC: PROOF_C };
    const win = idealProofMinutes(env, this.bread.proof2Ideal);
    const r5 = (m) => Math.max(5, Math.round(m / 5) * 5);
    let short = 30, normal = 45, long = 90;
    if (win && win[1] < MAX_PROOF) {
      const [lo, hi] = win;
      normal = r5((lo + hi) / 2);
      short = r5(Math.min(lo * 0.55, normal - 15));
      long = Math.min(MAX_PROOF, r5(Math.max(hi * 1.45, normal + 30)));
    }
    return { window: win, short, normal, long };
  }

  enterProof() {
    this.phase = 'proof';
    const o = (this.proofOpts = this.proofOptions());
    let tip;
    if (o.window && o.window[1] < MAX_PROOF) {
      const [lo, hi] = this.bread.proof2Ideal;
      tip = `Para tu masa, a ${DEG} lo ideal son ${mins(o.window[0])}–${mins(o.window[1])}: tiene que crecer hasta ${times(riseFromProgress(lo).rise)}–${times(riseFromProgress(hi).rise)} y quedar blandita.`;
    }
    this.instruct('Segundo levado',
      `Ahora reposa en ${this.box()} a ${DEG} para recuperar el gas que le quitaste. Elige cuánto tiempo y pulsa «Dejar levar».`, tip);
    const opt = (value, label) => ({ value, label, sub: formatMinutes(o[value]) });
    this.ctl = this.ui.setControls([
      {
        type: 'choice', id: 'proof', label: 'Segundo levado', value: this.proofChoice,
        options: [opt('short', 'Corto'), opt('normal', 'Normal'), opt('long', 'Largo')],
        onChange: (v) => { this.proofChoice = v; this.audio?.play('click', { volume: 0.6 }); },
      },
      { type: 'button', id: 'rise', label: 'Dejar levar', icon: 'clock', variant: 'primary', onClick: () => this.runProof() },
    ]);
    this.setClockCard();
    this.refreshMeters(true);
    this.goView('tray', 0.9);
    this.hoverDirty = true;
  }

  setClockCard() {
    this.ui.setClock({ label: 'Segundo levado', text: formatMinutes(this.proof.minutes), sub: `${DEG} · en ${this.box()}` });
  }

  /**
   * Cámara rápida del levado (unos 3 s): la masa crece y el reloj corre.
   * @param {number} [extra] minutos extra desde la fase de cortes («Levar 15 min más»)
   */
  async runProof(extra = 0) {
    const fromScore = this.phase === 'score';
    if (this.busy || this.leaving || this.exited || !(this.phase === 'proof' || (extra && fromScore))) return;
    if (this.proof.minutes >= MAX_PROOF) return;
    const minutes = Math.min(extra || this.proofOpts?.[this.proofChoice] || 45, MAX_PROOF - this.proof.minutes);
    this.busy = true;
    this.ui.setBusy(true);
    this.endDrag(false);
    this.setHover(false);
    if (this.lameOut) this.lameHome();
    const env = { amounts: this.state.amounts, tempC: PROOF_C };
    const dur = extra ? 1.3 : clamp(1.6 + minutes / 50, 2.2, 3.8);
    let done = 0, nextTick = this.proof.minutes + 5;
    this.audio?.play('whoosh', { volume: 0.3, rate: 0.7 });
    const ok = await this.anim(dur, (t) => {
      const dm = minutes * t - done;
      if (dm <= 1e-6) return;
      done += dm;
      this.proof = proofStep(this.proof, dm, env);
      this.game.advanceClock(dm);
      this.applyProof();
      if (this.proof.minutes >= nextTick) { nextTick += 10; this.audio?.play('tick', { volume: 0.35 }); }
    }, ease.inOutSine);
    if (!ok || this.exited) return;
    this.state.proof2 = { ...this.proof };
    this.proofDone = true;
    this.busy = false;
    this.ui.setBusy(false);
    this.proofFeedback();
    if (fromScore) {
      this.refreshMeters(true);
      this.syncScoreControls();
      this.showGhost();
      this.hoverDirty = true;
    } else {
      this.enterScore();
    }
  }

  /** Aplica el levado a la masa, el reloj y los medidores. */
  applyProof() {
    const { dough } = this.models;
    this.rise = Math.max(DEGASSED, this.proof.rise);
    dough.set({ rise: this.rise, collapse: this.proof.collapse });
    this.fitLength();
    this.setClockCard();
    this.refreshMeters();
  }

  /** Aviso al terminar el levado (en modo libre, sin juicio: solo los datos). */
  proofFeedback() {
    const st = proofStatus(this.proof.p, this.bread.proof2Ideal);
    const r = times(this.rise), m = mins(this.proof.minutes);
    if (!this.guided) {
      this.audio?.play('ding', { volume: 0.7 });
      this.ui.toast(`Ha crecido hasta ${r} en ${m}.`, { tone: 'info' });
    } else if (st === 'ok') {
      this.audio?.play('ding');
      this.particles?.sparkle(this.doughTop(0.03), { count: 24, spread: 0.07 });
      this.ui.toast(`¡En su punto! Ha crecido hasta ${r} en ${m}: blandita y llena de gas.`, { tone: 'good', duration: 3.2 });
    } else if (st === 'under') {
      this.audio?.play('ding', { volume: 0.6, rate: 0.8 });
      this.ui.toast(`Le falta un poco: solo ${r} en ${m}. Puedes dejarla ${EXTRA_MIN} min más.`, { tone: 'warn', duration: 3.4 });
    } else {
      this.audio?.play('fail', { volume: 0.5 });
      this.ui.toast(`Se ha pasado: ${r} en ${m}. Está floja y subirá menos en el horno.`, { tone: 'warn', duration: 3.4 });
    }
    return st;
  }

  // ---------------------------------------------------------------------------------------------
  // Fase 3 · Cortes y cobertura
  // ---------------------------------------------------------------------------------------------

  enterScore() {
    this.phase = 'score';
    this.engine.parallaxEnabled = false; // la cámara quieta: dibujar los cortes tiene que ser preciso
    const sc = this.bread.scoring;
    const toppingTip = this.bread.toppings?.text ?? '';
    if (this.shape === 'loaf') {
      this.instruct('Decora el pan',
        'El molde no necesita cortes (si quieres, uno largo por el centro: arrastra sobre la masa). Elige la cobertura y… ¡al horno!',
        toppingTip);
    } else {
      this.instruct('Greña y decora',
        'Arrastra sobre la masa para cortarla con la cuchilla, o elige un dibujo de cortes. Luego elige la cobertura y… ¡al horno!',
        `${sc.suggestion} ${toppingTip}`.trim());
    }
    this.ctl = this.ui.setControls([
      { type: 'choice', id: 'pattern', label: 'Cortes', value: this.pattern, options: PATTERNS, onChange: (v) => this.applyPattern(v) },
      { type: 'button', id: 'clear', label: 'Borrar cortes', icon: 'restart', variant: 'ghost', disabled: true, onClick: () => this.clearCuts() },
      { type: 'button', id: 'more', label: `Levar +${EXTRA_MIN} min`, icon: 'clock', variant: 'ghost', hidden: true, onClick: () => this.runProof(EXTRA_MIN) },
      { type: 'choice', id: 'topping', label: 'Cobertura', value: this.base, options: TOPPINGS, onChange: (v) => this.setBase(v) },
      { type: 'button', id: 'egg', label: this.eggLabel(), variant: 'secondary', active: this.egg, onClick: () => this.toggleEgg() },
      { type: 'button', id: 'oven', label: 'Al horno', icon: 'play', variant: 'primary', onClick: () => this.toOven() },
    ]);
    this.syncScoreControls();
    this.refreshMeters(true);
    this.goView('score', 1.3); // después del dock y los medidores: se encuadra en el hueco que dejan
    this.showGhost();
    this.hoverDirty = true;
  }

  syncScoreControls() {
    const c = this.ctl;
    if (!c || this.phase !== 'score') return;
    const under = proofStatus(this.proof.p, this.bread.proof2Ideal) === 'under';
    const canMore = this.proof.minutes + 1 < MAX_PROOF;
    c.get('more').set({ hidden: !canMore || (this.guided && !under) });
    c.get('clear').set({ disabled: this.cuts === 0 });
    c.get('pattern').set({ value: this.pattern });
    c.get('egg').set({ active: this.egg, label: this.eggLabel() });
  }

  eggLabel() { return this.egg ? 'Huevo batido ✓' : 'Huevo batido'; }

  /** Dibujo de cortes recomendado para esta forma que encaja con lo que pide la receta (o null). */
  suggestedPattern() {
    const { min, max } = this.bread.scoring;
    if (this.shape === 'loaf' && min === 0) return null;
    const order = {
      boule: ['cross', 'diagonals', 'long'], baguette: ['diagonals', 'long', 'cross'], loaf: ['long', 'cross', 'diagonals'],
    }[this.shape] ?? ['cross'];
    return order.find((p) => { const n = scorePattern(p, this.shape).length; return n >= min && n <= max; }) ?? null;
  }

  /** Cortes de un dibujo en XZ local, escalados a lo que ha crecido la masa. */
  patternPaths(name) {
    const k = this.shape === 'loaf' ? 1 : Math.pow(Math.max(1, this.rise), 0.36);
    return scorePattern(name, this.shape).map((path) => path.map((q) => q.clone().multiplyScalar(k)));
  }

  /** Punto de la cara de arriba de la masa sobre (x, z) locales, con su normal (o null si no hay masa). */
  surfacePoint(x, z) {
    const { dough } = this.models;
    dough.getTopY(); // reconstruye si hace falta
    const geo = dough.mesh.geometry;
    const P = geo.attributes.position.array, N = geo.attributes.normal.array;
    for (const r of [0.006, 0.014]) {
      const r2 = r * r;
      let best = -1, by = -Infinity;
      for (let j = 0; j < P.length; j += 3) {
        const dx = P[j] - x, dz = P[j + 2] - z;
        if (dx * dx + dz * dz < r2 && P[j + 1] > by) { by = P[j + 1]; best = j; }
      }
      if (best >= 0 && N[best + 1] > 0.15) return { p: V(x, by, z), n: V(N[best], N[best + 1], N[best + 2]) };
    }
    return null;
  }

  /** Guía punteada de los cortes recomendados (modo guiado, mientras no haya cortes). */
  showGhost() {
    this.hideGhost();
    if (!this.guided || this.cuts > 0 || this.phase !== 'score') return;
    const name = this.suggestedPattern();
    if (!name) return;
    for (const path of this.patternPaths(name)) {
      const pts = path.map((q) => this.surfacePoint(q.x, q.y)).filter(Boolean);
      if (pts.length < 2) continue;
      const r = makeRibbon({ color: 0xffffff, opacity: 0.8, width: 0.0034, lift: 0.0022, dashed: true });
      r.set(pts, 0.011);
      this.models.dough.group.add(r.mesh);
      this.ghosts.push(r);
    }
  }

  hideGhost() { for (const r of this.ghosts.splice(0)) r.dispose(); }

  /** Rayo contra la masa; con topOnly solo vale la cara de arriba. */
  hitDough(ndc, topOnly = false) {
    const hit = this.engine.raycast(ndc, this.models.dough.mesh, false)[0];
    if (!hit) return null;
    if (topOnly && (hit.face?.normal.y ?? 1) < 0.2) return null;
    return hit;
  }

  /** La cuchilla con la punta en `w` (mundo), orientada según el avance del corte. */
  poseLame(w, fresh = false) {
    const d = this.drag;
    if (d && !fresh) {
      const dx = w.x - d.lastW.x, dz = w.z - d.lastW.z;
      if (dx * dx + dz * dz > 0.003 * 0.003) {
        this.lameYaw += wrap(Math.atan2(-dz, dx) - this.lameYaw) * 0.55;
        d.lastW.copy(w);
      }
    }
    this.models.tools.lame.setPose(V(w.x, w.y - 0.0015, w.z), this.lameYaw);
    this.lameOut = true;
    this.lameIdle = 0;
  }

  lameHome() {
    if (!this.lameOut) return;
    this.lameOut = false;
    this.models.tools.lame.goHome();
  }

  /** Empieza un corte. Se puede empezar fuera de la masa: corta solo mientras pasa por encima. */
  startCut(ev) {
    const hit = this.hitDough(ev.ndc, true);
    if (this.cuts >= MAX_CUTS) {
      if (hit || this.hitDough(ev.ndc)) this.ui.toast(`Ya hay ${MAX_CUTS} cortes: pulsa «Borrar cortes» si quieres empezar de nuevo.`, { tone: 'warn' });
      return;
    }
    const y = hit ? hit.point.y : this.doughTop().y;
    const start = hit ? hit.point : this.engine.screenToPlane(ev.ndc, y);
    if (!start) return;
    this.drag = { id: ev.pointerId, pts: [], len: 0, lastW: start.clone(), y, touch: ev.pointerType === 'touch' };
    this.hideGhost();
    this.ui.hideHint();
    this.engine.setCursor('crosshair');
    if (hit) this.addCutPoint(hit);
    this.poseLame(start, true);
  }

  moveCut(ev) {
    const d = this.drag;
    const hit = this.hitDough(ev.ndc, true);
    if (hit) {
      this.addCutPoint(hit);
      d.y = hit.point.y;
      this.poseLame(hit.point);
    } else {
      // fuera de la masa la cuchilla sigue al dedo, pero no corta
      const p = this.engine.screenToPlane(ev.ndc, d.y);
      if (p) this.poseLame(p);
    }
  }

  addCutPoint(hit) {
    const d = this.drag;
    const p = this.models.dough.group.worldToLocal(hit.point.clone());
    const last = d.pts[d.pts.length - 1];
    if ((last && last.p.distanceTo(p) < 0.0025) || d.pts.length >= 150) return;
    if (last) d.len += Math.hypot(p.x - last.p.x, p.z - last.p.z);
    d.pts.push({ p, n: hit.face ? hit.face.normal.clone() : UP.clone() });
    this.ribbon?.set(d.pts);
  }

  /** Suelta el corte: si mide más de 2 cm se queda en la masa. */
  endDrag(commit = true) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.ribbon?.clear();
    this.hoverDirty = true;
    if (!commit || this.exited) return;
    if (d.len >= MIN_CUT && d.pts.length >= 2) {
      this.models.dough.addScore(d.pts.map((q) => new THREE.Vector2(q.p.x, q.p.z)));
      this.cuts++;
      this.pattern = null;
      this.cutJuice(d.pts);
      this.syncScoreControls();
      this.refreshMeters();
      if (this.cuts === 1 && !this.flags.firstCut) {
        this.flags.firstCut = true;
        this.ui.toast('¡Zas! Corte limpio. Con el horno se abrirá en una greña.', { tone: 'good' });
      }
    } else if (d.pts.length) {
      this.ui.toast('Muy corto: arrastra al menos 2 cm sobre la masa para que cuente.', { tone: 'info', duration: 2.2 });
      this.showGhost();
    }
  }

  /** Sonido y polvillo de un corte. */
  cutJuice(pts) {
    this.audio?.play('cut', { volume: 0.9, rate: 0.9 + Math.random() * 0.2 });
    const mid = this.models.dough.group.localToWorld(pts[pts.length >> 1].p.clone());
    this.particles?.puff(mid, { color: 0xfbf6ec, count: 6, spread: 0.03, size: 0.008, life: 0.6 });
  }

  /** Dibujo de cortes elegido en el dock: la cuchilla los traza uno a uno. */
  async applyPattern(name) {
    if (!name || this.phase !== 'score' || this.busy || this.leaving) {
      this.ctl?.get('pattern').set({ value: this.pattern });
      return;
    }
    const { dough, tools } = this.models;
    const g = dough.group;
    this.endDrag(false);
    this.busy = true;
    this.ui.setBusy(true);
    this.setHover(false);
    this.hideGhost();
    dough.clearScores();
    this.cuts = 0;
    this.pattern = name;
    this.refreshMeters();
    const lame = tools.lame;
    const w = V(), wa = V(), wb = V();
    let prev = null;
    for (const path of this.patternPaths(name)) {
      const pts = path.map((q) => this.surfacePoint(q.x, q.y)).filter(Boolean);
      if (pts.length < 2) continue;
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].p.distanceTo(pts[i - 1].p));
      const len = cum[cum.length - 1];
      g.localToWorld(wa.copy(pts[0].p));
      g.localToWorld(wb.copy(pts[1].p));
      const yaw = Math.atan2(-(wb.z - wa.z), wb.x - wa.x);
      // la cuchilla va al principio del corte (con un pequeño salto desde el anterior)
      if (!this.lameOut || !prev) {
        this.lameYaw = yaw;
        lame.setPose(wa, yaw);
        this.lameOut = true;
        if (!(await this.pause(0.38))) return;
      } else {
        const from = prev.clone(), y0 = this.lameYaw;
        const ok = await this.anim(0.2, (t, raw) => {
          w.lerpVectors(from, wa, t);
          w.y += Math.sin(Math.PI * raw) * 0.02;
          this.lameYaw = y0 + wrap(yaw - y0) * t;
          lame.setPose(w, this.lameYaw);
        }, ease.inOutSine);
        if (!ok) return;
      }
      // trazo: el rastro crece detrás de la hoja
      const trail = [];
      let seg = 0;
      const ok = await this.anim(0.2 + len * 2.6, (t) => {
        const s = len * t;
        while (seg < pts.length - 2 && cum[seg + 1] < s) seg++;
        const a = pts[seg], b = pts[seg + 1];
        const u = clamp((s - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]));
        const p = a.p.clone().lerp(b.p, u);
        trail.length = 0;
        for (let i = 0; i <= seg; i++) trail.push(pts[i]);
        trail.push({ p, n: a.n });
        this.ribbon?.set(trail);
        g.localToWorld(wa.copy(a.p));
        g.localToWorld(wb.copy(b.p));
        this.lameYaw += wrap(Math.atan2(-(wb.z - wa.z), wb.x - wa.x) - this.lameYaw) * 0.5;
        g.localToWorld(w.copy(p));
        w.y -= 0.0015;
        lame.setPose(w, this.lameYaw);
      }, ease.inOutSine);
      if (!ok || this.exited) return;
      prev = w.clone();
      dough.addScore(path);
      this.cuts++;
      this.ribbon?.clear();
      this.cutJuice(pts);
      this.refreshMeters();
      if (!(await this.pause(0.1))) return;
    }
    this.busy = false;
    this.ui.setBusy(false);
    this.lameIdle = 0;
    this.hoverHit = null;
    this.syncScoreControls();
    this.refreshMeters(true);
    this.hoverDirty = true;
  }

  clearCuts() {
    if (this.phase !== 'score' || this.busy || this.leaving || !this.cuts) return;
    this.endDrag(false);
    this.models.dough.clearScores();
    this.cuts = 0;
    this.pattern = null;
    this.audio?.play('whoosh', { volume: 0.4 });
    this.particles?.puff(this.doughTop(0.005), { color: 0xf6efe2, count: 12, spread: 0.06, size: 0.012, life: 0.8 });
    this.syncScoreControls();
    this.refreshMeters();
    this.showGhost();
  }

  /** 'eggwash+sesame', 'flour', 'none'… */
  toppingName() {
    const parts = [];
    if (this.egg) parts.push('eggwash');
    if (this.base !== 'none') parts.push(this.base);
    return parts.join('+') || 'none';
  }

  setBase(v) {
    if (this.phase !== 'score' || this.leaving || !TOPPINGS.some((t) => t.value === v)) return;
    this.base = v;
    this.queueTopping(v === 'none' ? 'clear' : v);
  }

  toggleEgg() {
    if (this.phase !== 'score' || this.leaving) return;
    this.egg = !this.egg;
    this.ctl?.get('egg').set({ active: this.egg, label: this.eggLabel() });
    this.queueTopping(this.egg ? 'eggwash' : 'clear');
  }

  /** La cobertura se pone cuando caen las semillas o termina la pincelada. */
  queueTopping(kind) {
    this.toppingPending = this.toppingName();
    this.toppingDelay = kind === 'clear' ? 0 : kind === 'eggwash' ? 0.5 : 0.32;
    this.startToppingFx(kind);
  }

  flushTopping() {
    if (this.toppingPending == null) return;
    this.models.dough.setTopping(this.toppingPending);
    this.toppingPending = null;
  }

  /** Recorrido sobre lo alto de la masa (mundo) para espolvorear o pintar. */
  sprinklePath() {
    const { dough } = this.models;
    const g = dough.group;
    const s = dough.getSize();
    const hx = s.x * 0.34, hz = s.z * 0.3;
    const pts = [];
    for (let i = 0, n = 22; i <= n; i++) {
      const u = i / n;
      let x, z;
      if (this.shape === 'boule') {
        const a = u * TAU * 1.5, r = lerp(0.95, 0.12, u);
        x = Math.cos(a) * hx * r; z = Math.sin(a) * hz * r;
      } else {
        x = lerp(-hx, hx, u); z = hz * 0.7 * Math.sin(u * TAU * 3);
      }
      const sp = this.surfacePoint(x, z);
      pts.push(g.localToWorld(V(x, (sp ? sp.p.y : dough.getTopY()) + 0.002, z)));
    }
    return pts;
  }

  startToppingFx(kind) {
    this.fx?.stream?.stop();
    this.fx = null;
    if (kind === 'clear') { this.audio?.play('whoosh', { volume: 0.35 }); return; }
    const path = this.sprinklePath();
    const cfg = SPRINKLE[kind];
    this.fx = { kind, t: 0, dur: kind === 'eggwash' ? 0.6 : 0.75, path, stream: null, emit: 0 };
    if (cfg) {
      const from = path[0].clone().add(V(0, 0.13, 0));
      this.fx.stream = this.particles?.stream(from, path[0], { color: cfg.color, rate: cfg.rate, size: cfg.size, life: 0.6 }) ?? null;
      this.audio?.play('pour-start', { volume: 0.45 });
    } else {
      this.audio?.play('cloth', { volume: 0.8, rate: 1.3 });
    }
  }

  updateFx(dt) {
    const fx = this.fx;
    if (!fx) return;
    fx.t += dt;
    const u = clamp(fx.t / fx.dur);
    const f = u * (fx.path.length - 1), i = Math.min(fx.path.length - 2, Math.floor(f));
    const p = V().lerpVectors(fx.path[i], fx.path[i + 1], f - i);
    if (fx.stream) {
      fx.stream.setTo(p);
      fx.stream.setFrom(p.clone().add(V(0, 0.13, 0)));
    } else {
      // pincelada de huevo: brillos que siguen al pincel
      fx.emit -= dt;
      if (fx.emit <= 0) {
        fx.emit = 0.045;
        this.particles?.sparkle(p.add(V(0, 0.004, 0)), { color: 0xffcf6a, count: 4, spread: 0.012, size: 0.012, life: 0.5 });
      }
    }
    if (u >= 1) {
      fx.stream?.stop();
      if (fx.kind === 'flour') this.particles?.puff(this.doughTop(0.02), { color: 0xfbf8f1, count: 26, spread: 0.06, size: 0.014, life: 1.3 });
      this.fx = null;
    }
  }

  /** «Al horno»: en modo guiado avisa si faltan o sobran cortes. */
  async toOven() {
    if (this.phase !== 'score' || this.busy || this.leaving || this.asking) return;
    const sc = this.bread.scoring;
    if (this.guided) {
      let warn = null;
      if (this.shape !== 'loaf' && this.cuts === 0 && sc.min > 0) {
        warn = {
          title: '¿Al horno sin cortes?',
          body: `Sin greñas, el pan se abrirá por donde quiera al crecer en el horno y la corteza se rasgará de lado. ${sc.suggestion}`,
          stay: 'Hacer cortes', go: 'Hornear sin cortes',
        };
      } else if (this.cuts > sc.max) {
        warn = {
          title: 'Demasiados cortes',
          body: `Llevas ${this.cuts} cortes y ${this.breadName()} pide ${sc.min === 0 ? `como mucho ${sc.max}` : `${sc.min}–${sc.max}`}: la superficie quedará como un acordeón y subirá menos.`,
          stay: 'Revisar cortes', go: 'Hornear así',
        };
      }
      if (warn) {
        this.asking = true;
        this.endDrag(false);
        const v = await this.ui.showDialog({
          title: warn.title, body: warn.body,
          actions: [{ label: warn.stay, variant: 'secondary', value: 'stay' }, { label: warn.go, variant: 'primary', value: 'go' }],
        });
        this.asking = false;
        if (v !== 'go' || this.exited || this.phase !== 'score' || this.busy || this.leaving) return;
      }
    }
    const { tools } = this.models;
    this.leaving = true;
    this.busy = true;
    this.ui.setBusy(true);
    this.endDrag(false);
    this.setHover(false);
    this.hideGhost();
    this.fx?.stream?.stop();
    this.fx = null;
    this.flushTopping();
    this.state.proof2 = { ...this.proof };
    this.state.shape = { shape: this.shape, scores: this.cuts, topping: this.toppingName() };
    this.audio?.play('success');
    this.particles?.sparkle(this.doughTop(0.03), { count: 30, spread: 0.08 });
    this.ui.toast('¡Listo para el horno!', { tone: 'good' });
    if (this.lameOut) await tools.lame.goHome();
    else await this.pause(0.5);
    this.lameOut = false;
    if (this.exited) return;
    this.complete();
  }

  // ---------------------------------------------------------------------------------------------
  // Medidores
  // ---------------------------------------------------------------------------------------------

  refreshMeters(force = false) {
    const v01 = (r) => clamp((r - 1) / 1.6);
    const list = [];
    const ph = this.phase;
    if (ph === 'intro' || ph === 'degas' || ph === 'degassed' || ph === 'shape' || ph === 'forming') {
      const ok = this.rise <= DEGASSED + 0.06;
      list.push({ id: 'volume', label: 'Volumen', value01: v01(this.rise), ideal: this.ideal([0, v01(DEGASSED + 0.06)]), text: times(this.rise), tone: ok ? 'good' : 'neutral' });
    } else {
      const [lo, hi] = this.bread.proof2Ideal;
      const st = proofStatus(this.proof.p, this.bread.proof2Ideal);
      let tone = 'neutral';
      if (this.guided && st === 'ok') tone = 'good';
      else if (this.guided && (st === 'over' || (st === 'under' && this.proofDone))) tone = 'warn';
      list.push({
        id: 'volume', label: 'Segundo levado', value01: v01(this.rise), text: times(this.rise), tone,
        ideal: this.ideal([v01(riseFromProgress(lo).rise), v01(riseFromProgress(hi).rise)]),
      });
      if (ph === 'score') {
        const { min, max } = this.bread.scoring;
        const inRange = this.cuts >= min && this.cuts <= max;
        list.push({
          id: 'cuts', label: 'Cortes', value01: this.cuts / MAX_CUTS,
          ideal: this.ideal([min / MAX_CUTS, max / MAX_CUTS]),
          text: this.cuts === 1 ? '1 corte' : `${this.cuts} cortes`,
          tone: !this.guided ? 'neutral' : inRange ? 'good' : this.cuts > max ? 'warn' : 'neutral',
        });
      }
    }
    const key = list.map((m) => `${m.id}:${m.text}:${m.tone}:${m.label}:${m.value01.toFixed(3)}`).join('|');
    if (!force && key === this.meterKey) return;
    this.meterKey = key;
    this.ui.setMeters(list);
  }

  // ---------------------------------------------------------------------------------------------
  // Bucle
  // ---------------------------------------------------------------------------------------------

  update(dt) {
    if (this.exited) return;
    this.time += dt;
    const ph = this.phase;
    if (ph === 'degas' || ph === 'degassed' || ph === 'shape') this.updateDegas(dt);
    this.updateHover(dt);
    this.updateFx(dt);
    if (this.toppingPending != null) {
      this.toppingDelay -= dt;
      if (this.toppingDelay <= 0) {
        const egg = this.egg && this.toppingPending.includes('eggwash');
        this.flushTopping();
        if (egg) this.particles?.sparkle(this.doughTop(0.01), { color: 0xffe2a0, count: 14, spread: 0.06, size: 0.016, life: 0.8 });
      }
    }
    if (this.ghosts.length) {
      const o = 0.55 + 0.3 * Math.sin(this.time * 3.2);
      for (const r of this.ghosts) r.mat.opacity = o;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Puntero
  // ---------------------------------------------------------------------------------------------

  canPoint() { return !this.exited && !this.leaving && !this.asking && !this.engine.controls.enabled; }

  onPointerDown(ev) {
    if (!this.canPoint() || ev.button > 0) return;
    this.pointer = { x: ev.x, y: ev.y };
    if (this.busy || this.drag) return;
    const ph = this.phase;
    if (ph === 'score') { this.startCut(ev); return; }
    const hit = this.hitDough(ev.ndc);
    if (!hit) return;
    const { dough } = this.models;
    const local = dough.group.worldToLocal(hit.point.clone());
    if (ph === 'degas') {
      this.press(local);
    } else if (ph === 'shape' || ph === 'proof') {
      // un toque: la masa cede y vuelve (blandita)
      dough.dent(local, { radius: 0.025, depth: 0.008, recovery: 0.6 });
      this.audio?.play('plop', { volume: 0.35, rate: 1.3 });
      if (ev.pointerType === 'touch' && !this.flags[`tap-${ph}`]) {
        this.flags[`tap-${ph}`] = true;
        this.ui.toast(ph === 'shape' ? 'Elige la forma abajo y pulsa «Formar».' : 'Elige el tiempo abajo y pulsa «Dejar levar».', { tone: 'info' });
      }
    }
  }

  onPointerMove(ev) {
    this.pointer = { x: ev.x, y: ev.y };
    if (this.drag) {
      if (ev.pointerId === this.drag.id && this.canPoint()) this.moveCut(ev);
      return;
    }
    if (ev.pointerType === 'touch') return;
    this.hoverNdc = ev.ndc;
    this.hoverDirty = true;
  }

  onPointerUp(ev) {
    if (this.drag && ev.pointerId === this.drag.id) this.endDrag(true);
  }

  /** Como mucho un rayo por frame para el ratón que pasa por encima. */
  updateHover(dt) {
    if (this.hoverDirty) {
      this.hoverDirty = false;
      const ph = this.phase;
      const active = this.hoverNdc && !this.drag && !this.busy && this.canPoint()
        && (ph === 'degas' || ph === 'shape' || ph === 'proof' || ph === 'score');
      const hit = active ? this.hitDough(this.hoverNdc, ph === 'score') : null;
      this.hoverHit = hit;
      this.setHover(!!hit, hit);
    }
    // la cuchilla vuelve a su sitio si el ratón deja la masa un momento
    if (this.phase === 'score' && this.lameOut && !this.drag && !this.hoverHit && !this.busy) {
      this.lameIdle += dt;
      if (this.lameIdle > 0.45) this.lameHome();
    } else {
      this.lameIdle = 0;
    }
  }

  clearHover() {
    this.hoverNdc = null;
    this.hoverHit = null;
    this.setHover(false);
  }

  /** Resaltado, cursor, pista flotante y (al greñar) la cuchilla siguiendo al ratón. */
  setHover(on, hit) {
    const { dough } = this.models;
    const ph = this.phase;
    const glow = on && (ph === 'degas' || ph === 'shape');
    if (glow !== this.glow) { this.glow = glow; dough.setHighlight(glow); }
    if (on !== this.hovering) {
      this.hovering = on;
      this.engine.setCursor(on ? (ph === 'score' ? 'crosshair' : 'pointer') : '');
    }
    if (!on) { this.ui.hideHint(); return; }
    if (ph === 'score' && hit) {
      this.poseLame(V(hit.point.x, hit.point.y + 0.012, hit.point.z));
      const text = this.cuts >= MAX_CUTS ? `Ya hay ${MAX_CUTS} cortes` : 'Arrastra para cortar';
      if (this.pointer) this.ui.showHint(text, { x: this.pointer.x, y: this.pointer.y - 34 });
      return;
    }
    const text = ph === 'degas' ? `Toca para aplastar · ${Math.min(PRESSES, this.presses + 1)}/${PRESSES}`
      : ph === 'shape' ? 'Elige la forma y pulsa «Formar»'
        : ph === 'proof' ? 'Elige el tiempo y pulsa «Dejar levar»' : '';
    if (text) this.ui.showHint(text, this.engine.worldToScreen(this.doughTop(0.03)));
    else this.ui.hideHint();
  }
}
