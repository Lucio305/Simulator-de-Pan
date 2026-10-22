// Etapa 4 · Fermentar: la masa reposa tapada en el bol hasta doblar su volumen.
import * as THREE from 'three';
import { Stage, TIME_SPEEDS, totalGrams } from './stage.js';
import { proofStep, initialProof, riseFromProgress, proofStatus, pokeTest, idealProofMinutes, PROOF_SPOTS } from '../recipe.js';
import { animate, ease, cancelAnimations } from '../core/anim.js';
import { clamp, lerp, damp, smoothstep, formatMinutes } from '../core/utils.js';
import { SIZES } from '../core/layout.js';
import { frameAt, isTall, travel } from './knead.js';

const TAG = 'proof-stage';
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const FRIDGE_BOOST = 4;        // en la nevera la cámara rápida va ×4 (si no, serían 12 h de espera)
const SKIP_MIN = 60;           // «Adelantar 1 h»
const SKIP_RATE = 90;          // minutos simulados por segundo real mientras adelanta
const MIN_SHAPE_MIN = 10;      // minutos de fermentación antes de poder formar
const RISE_RANGE = [1, 2.6];   // escala del medidor de volumen
// Paño puesto (tools.js · CLOTH): se apoya en el borde (alto del bol + grosor) y se hunde 1,4 cm en el centro.
const CLOTH_TOP = SIZES.bowl.height + 0.0016;
const CLOTH_SAG = 0.014;
const DOME_GAIN = 2.2;         // el abombamiento del paño exagera lo que sube la masa (si no, apenas se ve)
const UNCOVER_LIFT = 1.8;      // s que tarda el paño (tools.js · uncover) en levantarse y doblarse sobre el bol

const riseTo01 = (r) => clamp((r - RISE_RANGE[0]) / (RISE_RANGE[1] - RISE_RANGE[0]));
const dec = (v, digits = 1) => v.toFixed(digits).replace('.', ',');

/**
 * Dedo para la prueba del dedo (la punta en el origen, el dedo hacia +Y y la uña hacia +Z).
 * Corto, con la yema redondeada y algo más estrecha; el otro extremo se desvanece para que no
 * llegue al borde de la pantalla.
 */
function makeFinger() {
  const group = new THREE.Group();
  group.name = 'proof-finger';
  const skin = new THREE.MeshStandardMaterial({ color: 0xe7b08a, roughness: 0.6, envMapIntensity: 0.6, vertexColors: true, transparent: true });
  const nailMat = new THREE.MeshStandardMaterial({ color: 0xf0b4aa, roughness: 0.3, envMapIntensity: 0.8, transparent: true });
  const r = 0.0088, len = 0.085;
  // perfil desde la punta: media esfera algo estrecha y luego se ensancha poco a poco
  const pts = [];
  const rt = r * 0.82;
  for (let i = 0; i <= 8; i++) { const a = (i / 8) * (Math.PI / 2); pts.push(new THREE.Vector2(Math.sin(a) * rt, rt * (1 - Math.cos(a)))); }
  for (let i = 1; i <= 14; i++) { const y = rt + (i / 14) * (len - rt); pts.push(new THREE.Vector2(lerp(rt, r, smoothstep(rt, 0.035, y)), y)); }
  const geo = new THREE.LatheGeometry(pts, 24);
  // alfa por vértice: se desvanece hacia la mano; un pliegue algo más oscuro en la articulación
  const p = geo.attributes.position, col = new Float32Array(p.count * 4);
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), crease = 1 - 0.12 * (1 - smoothstep(0, 0.003, Math.abs(y - 0.027)));
    col.set([crease, crease * 0.97, crease * 0.97, 1 - smoothstep(len * 0.5, len, y)], i * 4);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
  const body = new THREE.Mesh(geo, skin);
  const nail = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), nailMat);
  nail.scale.set(r * 0.68, r * 1.15, r * 0.3);
  nail.position.set(0, r * 1.55, r * 0.8);
  group.add(body, nail);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.raycast = () => {}; } });
  group.visible = false;
  return {
    group, skin, nailMat,
    dispose() {
      group.removeFromParent();
      group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      skin.dispose();
      nailMat.dispose();
    },
  };
}

export class ProofStage extends Stage {
  constructor(game) {
    super(game);
    this.phase = 'intro';      // intro → cover → covering → proofing ⇄ poking → reveal
    this.leaving = false;
    this.finishing = false;
    this.dialogOpen = false;   // con un diálogo abierto el tiempo se detiene
    this.speed = 'normal';
    this.skip = 0;             // minutos pendientes de «Adelantar 1 h»
    this.flags = {};           // avisos ya mostrados
    this.uiT = 0;
    this.view = 'bowl';
    this.hover = null;         // 'cloth' | 'bowl' | null
    this.hoverNdc = null;
    this.hoverDirty = false;
    this.hoverAt = 0;
    this.time = 0;
    this.pokeHint = null;      // {text, t}
    this.finger = null;
    this.bulge = 0;
    this.ctl = null;
    this.tmp = V();
    this.sphere = new THREE.Sphere();
    this.raycaster = new THREE.Raycaster();
  }

  get spot() { return PROOF_SPOTS.find((s) => s.id === this.state.proof1?.spot) ?? PROOF_SPOTS[0]; }
  get fridge() { return this.spot.id === 'nevera'; }

  /** Banda ideal de volumen a partir de la ventana de fermentación del pan. */
  idealRise() {
    const [lo, hi] = this.bread.proof1Ideal;
    return [riseFromProgress(lo).rise, riseFromProgress(hi).rise];
  }

  // -----------------------------------------------------------------------------------------------
  // Entrada
  // -----------------------------------------------------------------------------------------------

  async enter() {
    const { dough, tools } = this.models;
    const s = this.state;
    if (!Number.isFinite(s.proof1?.p)) s.proof1 = { ...initialProof(22), spot: 'encimera' };
    s.proof1 = { ...s.proof1, spot: this.spot.id, tempC: this.spot.tempC };
    tools.cloth.reset();

    const [rLo, rHi] = this.idealRise();
    this.instruct('Tapa la masa y déjala fermentar',
      'Vuelve al bol. Tápala con el paño para que no se seque y elige dónde dejarla: con calor va más rápido.',
      `${this.bread.tips?.proof ?? ''} Tiene que crecer hasta ×${dec(rLo)}–×${dec(rHi)}.`.trim());
    this.buildControls();
    this.refreshHud(true);

    const resize = () => this.goView(this.view, 0.3);
    const leave = () => this.setHover(null);
    window.addEventListener('resize', resize);
    this.engine.canvas.addEventListener('pointerleave', leave);
    this.track(() => {
      window.removeEventListener('resize', resize);
      this.engine.canvas.removeEventListener('pointerleave', leave);
      tools.cloth.setHighlight(false);
      tools.bowl.setHighlight(false);
    });

    this.goView('start', 1.6);
    if (dough.group.parent !== tools.bowl.anchors.contents) {
      dough.setHighlight(false);
      const ok = await travel(this.engine, dough.group, tools.bowl.anchors.contents, { height: 0.26, duration: 1.3, tag: TAG, spin: -Math.PI / 2 });
      if (!ok || this.leaving) return;
      this.audio?.play('plop', { volume: 0.8 });
      this.squashPulse(0.35, 0.45);
      tools.bowl.anchors.contents.getWorldPosition(this.tmp);
      this.tmp.y += 0.03;
      this.particles?.puff(this.tmp, { color: 0xf8f3ea, count: 14, spread: 0.05, size: 0.011, life: 0.9, rise: 0.04 });
    }
    // la báscula, de paso, pesa la masa
    tools.scale.setReading(totalGrams(s.amounts) + (s.knead?.extraFlour || 0));
    dough.set({ rise: s.proof1.rise, collapse: s.proof1.collapse, squash: 0, stretch: 0 });
    this.phase = 'cover';
    this.syncControls();
    tools.cloth.setHighlight(true);
  }

  /** Aplastón breve (la masa cae en el bol, la prueba del dedo...). */
  squashPulse(amp, dur) {
    const dough = this.models.dough;
    animate({ duration: dur, tag: TAG, ease: ease.linear, onUpdate: (t) => dough.set({ squash: amp * Math.sin(Math.PI * t) * (1 - t * 0.3) }) })
      .then(() => dough.set({ squash: 0 }));
  }

  // -----------------------------------------------------------------------------------------------
  // Cámara
  // -----------------------------------------------------------------------------------------------

  viewFor(name) {
    const tall = isTall(this.engine);
    const { tools, dough } = this.models;
    if (name === 'poke' || name === 'reveal') {
      const top = dough.group.localToWorld(V(0, dough.getTopY(), 0));
      return frameAt(this.engine, top, name === 'poke'
        ? (tall ? { dir: V(0, 0.62, 0.78), dist: 0.62, ndc: [0, 0.36] } : { dir: V(0, 0.58, 0.81), dist: 0.52, ndc: [0, 0.1] })
        : (tall ? { dir: V(0, 0.7, 0.72), dist: 0.62, ndc: [0, 0.38] } : { dir: V(0, 0.62, 0.78), dist: 0.54, ndc: [0, 0.12] }));
    }
    const rim = tools.bowl.anchors.rim.getWorldPosition(V());
    rim.y -= 0.025;
    if (name === 'start' && !tall) {
      // el bol y, a su izquierda, el paño doblado que hay que poner (en el móvil no caben los dos)
      const cloth = tools.cloth.object.getWorldPosition(V());
      const s = rim.clone().lerp(cloth, 0.3);
      s.y = rim.y;
      return frameAt(this.engine, s, { dir: V(0, 0.52, 0.85), dist: 0.86, ndc: [0, 0.1] });
    }
    // el bol con el paño, bastante de lado para que se vea el abombamiento
    return frameAt(this.engine, rim, tall
      ? { dir: V(0, 0.52, 0.85), dist: 0.84, ndc: [0, 0.36] }
      : { dir: V(0, 0.4, 0.92), dist: 0.7, ndc: [0, 0.1] });
  }

  goView(name, duration = 1.2) {
    this.view = name;
    return this.camera(this.viewFor(name), { duration });
  }

  // -----------------------------------------------------------------------------------------------
  // Interfaz
  // -----------------------------------------------------------------------------------------------

  buildControls() {
    this.ctl = this.ui.setControls([
      {
        type: 'choice', id: 'spot', label: 'Dónde fermenta', value: this.spot.id,
        options: PROOF_SPOTS.map((p) => ({ value: p.id, label: p.label, sub: `${p.tempC} °C` })),
        onChange: (v) => this.setSpot(v),
      },
      { ...this.speedControl(this.speed, (v) => this.setSpeed(v)), hidden: true },
      { type: 'button', id: 'skip', label: 'Adelantar 1 h', icon: 'forward', variant: 'secondary', hidden: true, onClick: () => this.skipHour() },
      { type: 'button', id: 'poke', label: 'Prueba del dedo', icon: 'hand', variant: 'secondary', hidden: true, onClick: () => this.poke() },
      { type: 'button', id: 'cover', label: 'Tapar con el paño', icon: 'check', variant: 'primary', disabled: true, onClick: () => this.cover() },
      { type: 'button', id: 'next', label: 'Desgasificar y formar', icon: 'play', variant: 'primary', hidden: true, disabled: true, onClick: () => this.goNext() },
    ]);
  }

  syncControls() {
    const c = this.ctl;
    if (!c) return;
    const ph = this.phase;
    const running = ph === 'proofing' || ph === 'poking';
    const done = ph === 'reveal' || this.finishing;
    c.get('spot').set({ disabled: done || ph === 'intro', value: this.spot.id });
    c.get('cover').set({ hidden: running || done, disabled: ph !== 'cover' });
    c.get('speed').set({ hidden: !running, disabled: done, value: this.speed });
    c.get('skip').set({ hidden: !(running && this.fridge), disabled: ph !== 'proofing' || done });
    c.get('poke').set({ hidden: !running, disabled: ph !== 'proofing' || done });
    c.get('next').set({ hidden: !running && !done, disabled: done || this.state.proof1.minutes < MIN_SHAPE_MIN });
  }

  /** Medidor de volumen y reloj (llamar a menudo: solo toca lo que cambia). */
  refreshHud(force = false) {
    const pr = this.state.proof1;
    const [lo, hi] = this.bread.proof1Ideal;
    const st = proofStatus(pr.p, [lo, hi]);
    const [rLo, rHi] = this.idealRise();
    const collapsing = pr.collapse > 0.04;
    const text = `×${dec(pr.rise)}${collapsing ? ' · se hunde' : ''}`;
    let tone = 'neutral';
    if (collapsing) tone = 'bad';
    else if (this.guided) tone = st === 'ok' ? 'good' : st === 'over' ? 'warn' : 'neutral';
    const key = `${text}|${tone}|${Math.round(riseTo01(pr.rise) * 400)}`;
    if (force || key !== this.hudKey) {
      this.hudKey = key;
      this.ui.setMeters([{ id: 'volume', label: 'Volumen', value01: riseTo01(pr.rise), ideal: this.ideal([riseTo01(rLo), riseTo01(rHi)]), text, tone }]);
    }
    const running = this.phase === 'proofing' || this.phase === 'poking' || this.phase === 'reveal';
    let sub = `${this.spot.label} · ${this.spot.tempC} °C${this.fridge ? ' · tiempo ×4' : ''}`;
    if (!running) sub = `${this.spot.label} · ${this.spot.tempC} °C · tápala para empezar`;
    else if (this.guided) {
      if (st === 'under') {
        const est = idealProofMinutes({ amounts: this.state.amounts, tempC: this.spot.tempC }, [lo, hi], pr.p);
        if (est) sub += ` · en su punto en ~${formatMinutes(Math.max(1, Math.ceil(est[0] / 5) * 5))}`;
      } else sub += st === 'ok' ? ' · ¡en su punto!' : ' · se está pasando';
    }
    this.ui.setClock({ label: 'Fermentando', text: formatMinutes(pr.minutes), sub });
  }

  setSpot(id) {
    const spot = PROOF_SPOTS.find((p) => p.id === id);
    if (!spot || this.finishing) return;
    this.state.proof1 = { ...this.state.proof1, spot: spot.id, tempC: spot.tempC };
    this.ui.toast(`${spot.label} (${spot.tempC} °C): ${spot.note}${spot.id === 'nevera' ? ' La cámara rápida irá ×4.' : ''}`, { tone: 'info', duration: 3.4 });
    this.audio?.play('click');
    if (this.phase === 'proofing' || this.phase === 'poking') this.instructProofing();
    this.syncControls();
    this.refreshHud(true);
  }

  setSpeed(v) {
    if (!(v in TIME_SPEEDS)) return;
    // (si después de frenarla tú la vuelves a poner en «Rápido», ya no se frena otra vez)
    this.speed = v;
  }

  skipHour() {
    if (this.phase !== 'proofing' || this.finishing) return;
    this.skip += SKIP_MIN;
    this.audio?.play('whoosh', { volume: 0.4 });
  }

  // -----------------------------------------------------------------------------------------------
  // Tapar
  // -----------------------------------------------------------------------------------------------

  async cover() {
    if (this.phase !== 'cover' || this.leaving) return;
    const { tools } = this.models;
    this.phase = 'covering';
    this.setHover(null);
    tools.cloth.setHighlight(false);
    this.syncControls();
    const ok = await tools.cloth.cover(tools.bowl.object);
    if (this.leaving || this.phase !== 'covering') return;
    if (!ok) { this.phase = 'cover'; this.syncControls(); return; }
    this.phase = 'proofing';
    this.goView('bowl', 1.2);
    this.instructProofing();
    this.syncControls();
    this.refreshHud(true);
  }

  /** Instrucción mientras fermenta (el consejo depende de dónde está; mismo título: no se reanima). */
  instructProofing() {
    const [rLo, rHi] = this.idealRise();
    const target = this.guided ? `crezca a ×${dec(rLo)}–×${dec(rHi)}` : 'doble su volumen';
    this.instruct('Deja que doble su volumen',
      `Deja correr el tiempo (cámara rápida) hasta que ${target}. Si dudas, haz la prueba del dedo. Si se pasa, se viene abajo.`,
      this.fridge ? 'En la nevera tarda horas: usa «Rápido» o «Adelantar 1 h».' : 'Cuando el paño empiece a abombarse, ya casi está.');
  }

  /**
   * Quita el paño y acerca la cámara cuando ya está doblado y se va a su sitio
   * (si no, la tela plana cruzaría por delante de la cámara).
   * @returns {Promise<boolean>} lo que devuelve tools.cloth.uncover()
   */
  async uncoverThenView(name, duration) {
    const phase = this.phase;
    const uncovering = this.models.tools.cloth.uncover();
    await Promise.race([uncovering, animate({ duration: UNCOVER_LIFT, tag: TAG, ease: ease.linear })]);
    if (!this.leaving && this.phase === phase) this.goView(name, duration);
    return uncovering;
  }

  // -----------------------------------------------------------------------------------------------
  // Tiempo
  // -----------------------------------------------------------------------------------------------

  update(dt) {
    this.time += dt;
    if (this.leaving) return;
    const { tools } = this.models;
    if (this.phase === 'proofing' && !this.dialogOpen && !this.game.simPaused && !this.finishing) {
      let dtMin = TIME_SPEEDS[this.speed] * (this.fridge ? FRIDGE_BOOST : 1) * dt;
      if (this.skip > 0) {
        const k = Math.min(this.skip, SKIP_RATE * dt);
        this.skip -= k;
        dtMin += k;
      }
      if (dtMin > 0) this.advance(dtMin);
    }
    // el paño se apoya en la masa cuando esta llega arriba
    if (tools.cloth.isCovering) {
      this.bulge = damp(this.bulge, this.clothBulge(), 6, dt);
      tools.cloth.setBulge(this.bulge);
    }
    this.updateFinger();
    // puntero: el paño (para tapar) o el bol (prueba del dedo)
    if (this.hoverDirty && this.time - this.hoverAt > 0.08) {
      this.hoverDirty = false;
      this.hoverAt = this.time;
      this.setHover(this.pick(this.hoverNdc));
    }
    if (this.pokeHint) {
      this.pokeHint.t -= dt;
      if (this.pokeHint.t <= 0) { this.pokeHint = null; this.ui.hideHint(); }
    }
    this.showHints();
    this.uiT -= dt;
    if (this.uiT <= 0) {
      this.uiT = 0.12;
      this.refreshHud();
      const can = this.state.proof1.minutes >= MIN_SHAPE_MIN;
      if (can !== this.flags.canShape) { this.flags.canShape = can; this.syncControls(); }
    }
  }

  /** Avanza la fermentación dtMin minutos simulados (y el reloj de la cocina). */
  advance(dtMin) {
    const s = this.state;
    const prev = s.proof1;
    s.proof1 = { ...proofStep(prev, dtMin, { amounts: s.amounts, tempC: this.spot.tempC }), spot: this.spot.id };
    this.game.advanceClock(dtMin);
    this.models.dough.set({ rise: s.proof1.rise, collapse: s.proof1.collapse });
    this.milestones(prev.p, s.proof1);
  }

  /** Avisos al cruzar la ventana ideal y al empezar a hundirse. */
  milestones(p0, pr) {
    const [lo, hi] = this.bread.proof1Ideal;
    const f = this.flags;
    const env = { amounts: this.state.amounts, tempC: this.spot.tempC };
    // modo guiado: frena la cámara rápida justo antes de la ventana
    if (this.guided && this.speed === 'fast' && !f.slowed && pr.p < lo) {
      const est = idealProofMinutes(env, [lo, hi], pr.p);
      const rate = TIME_SPEEDS.fast * (this.fridge ? FRIDGE_BOOST : 1);
      if (est && est[0] < rate * 1.2) {
        f.slowed = true;
        this.speed = 'normal';
        this.ctl?.get('speed').set({ value: 'normal' });
        this.ui.toast('Ya casi está: volvemos a velocidad normal para no pasarnos.', { tone: 'info' });
      }
    }
    if (p0 < lo && pr.p >= lo && !f.ready) {
      f.ready = true;
      if (this.guided) {
        this.audio?.play('ding');
        this.sparkleAbove();
        this.ui.toast(`¡Ha doblado su volumen (×${dec(pr.rise)})! Ya puedes desgasificarla y formarla.`, { tone: 'good', duration: 3.4 });
      }
    }
    if (p0 < hi && pr.p >= hi && !f.over) {
      f.over = true;
      this.skip = 0;
      if (this.guided) this.ui.toast('Se está pasando de fermentación: fórmala cuanto antes.', { tone: 'warn', duration: 3.2 });
    }
    if (pr.collapse > 0.04 && !f.collapse) {
      f.collapse = true;
      this.skip = 0;
      this.audio?.play('fail', { volume: 0.5 });
      this.ui.toast('¡La masa se está viniendo abajo! Se ha pasado de fermentación.', { tone: 'bad', duration: 3.4 });
    }
  }

  sparkleAbove() {
    const rim = this.models.tools.bowl.anchors.rim.getWorldPosition(V());
    rim.y += 0.04 + this.bulge;
    this.particles?.sparkle(rim, { count: 30, spread: 0.1 });
  }

  /**
   * Cuánto hay que levantar el centro del paño para que quede encima de la masa
   * (cero mientras la masa no llega a la tela, que cuelga hundida en el centro).
   */
  clothBulge() {
    const { dough, tools } = this.models;
    // lectura por frame: sin forzar la reconstrucción de la masa (va a su propio ritmo)
    const top = dough.group.localToWorld(this.tmp.set(0, dough.getTopY(false), 0));
    tools.bowl.object.worldToLocal(top);
    // altura de la masa sin fermentar (la masa crece en vertical ~ rise^0,28)
    this.baseTop ??= top.y / Math.pow(Math.max(1, this.state.proof1.rise), 0.28);
    const dome = DOME_GAIN * Math.max(0, top.y - this.baseTop) * (1 - 0.5 * this.state.proof1.collapse);
    const need = top.y + 0.004;
    const yAt = (b) => CLOTH_TOP - CLOTH_SAG * (1 - smoothstep(0, 0.02, b)) + b;
    if (yAt(0) >= need) return dome;
    let lo = 0, hi = 0.08;
    for (let i = 0; i < 14; i++) {
      const m = (lo + hi) / 2;
      if (yAt(m) >= need) hi = m; else lo = m;
    }
    return Math.max(hi, dome);
  }

  // -----------------------------------------------------------------------------------------------
  // Prueba del dedo
  // -----------------------------------------------------------------------------------------------

  async poke() {
    if (this.phase !== 'proofing' || this.leaving || this.finishing) return;
    const { tools, dough } = this.models;
    this.phase = 'poking';
    this.setHover(null);
    this.syncControls();
    const pr = this.state.proof1;
    const res = pokeTest(pr.p, this.bread.proof1Ideal);
    let ok = await this.uncoverThenView('poke', 1.1);
    if (this.leaving || this.phase !== 'poking') return;
    if (!ok) tools.cloth.reset();

    // el dedo baja, se hunde 1,5 cm en lo alto y sale
    const f = this.finger ??= makeFinger();
    this.engine.scene.add(f.group);
    const local = this.surfacePoint(0.012, 0.022);
    const hit = dough.group.localToWorld(local.clone());
    const axis = V(0.55, 0.78, 0.42).normalize();
    const above = hit.clone().addScaledVector(axis, 0.11);
    const pressed = hit.clone().addScaledVector(axis, -0.014);
    // la uña mira hacia la cámara
    const toCam = this.engine.camera.position.clone().sub(hit);
    const nailDir = toCam.addScaledVector(axis, -toCam.dot(axis)).normalize();
    f.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(V().crossVectors(axis, nailDir), axis, nailDir));
    f.group.position.copy(above);
    f.group.visible = true;
    f.fade = 0;
    ok = await animate({ duration: 0.55, tag: TAG, ease: ease.inOutCubic, onUpdate: (t) => { f.group.position.lerpVectors(above, hit, t); f.fade = t; } });
    if (!ok || this.leaving || this.phase !== 'poking') return;
    dough.dent(local, { radius: 0.017, depth: 0.016, recovery: res.recoverySeconds });
    this.audio?.play('plop', { volume: 0.6, rate: 1.2 });
    ok = await animate({ duration: 0.22, tag: TAG, ease: ease.outQuad, onUpdate: (t) => f.group.position.lerpVectors(hit, pressed, t) });
    if (!ok || this.leaving || this.phase !== 'poking') return;
    ok = await animate({ duration: 0.25, tag: TAG, ease: ease.linear });
    if (!ok || this.leaving || this.phase !== 'poking') return;
    ok = await animate({ duration: 0.6, tag: TAG, ease: ease.inOutCubic, onUpdate: (t) => { f.group.position.lerpVectors(pressed, above, t); f.fade = 1 - t; } });
    f.group.visible = false;
    if (!ok || this.leaving || this.phase !== 'poking') return;
    const tone = res.result === 'ok' ? 'good' : res.result === 'over' ? 'bad' : 'warn';
    this.ui.toast(res.text, { tone, duration: 4.2 });
    this.pokeHint = {
      text: res.result === 'ok' ? 'Vuelve despacio: ¡en su punto!' : res.result === 'under' ? 'Vuelve enseguida: le falta' : 'No vuelve: se ha pasado',
      t: 2.8,
    };
    if (res.result === 'ok') { this.audio?.play('ding', { volume: 0.7 }); this.sparkleAbove(); }
    ok = await animate({ duration: 2.8, tag: TAG, ease: ease.linear });
    if (!ok || this.leaving || this.phase !== 'poking') return;
    // se vuelve a tapar y sigue fermentando
    this.goView('bowl', 1.2);
    ok = await tools.cloth.cover(tools.bowl.object);
    if (this.leaving || this.phase !== 'poking') return;
    if (!ok) { tools.cloth.reset(); this.phase = 'cover'; this.syncControls(); return; }
    this.phase = 'proofing';
    this.syncControls();
  }

  /** Punto de la superficie de la masa (local) sobre (x, z) locales, bajando un rayo desde arriba. */
  surfacePoint(x, z) {
    const dough = this.models.dough;
    const top = dough.getTopY();
    const from = dough.group.localToWorld(V(x, top + 0.1, z));
    const to = dough.group.localToWorld(V(x, 0, z));
    this.raycaster.set(from, to.sub(from).normalize());
    const hit = this.raycaster.intersectObject(dough.mesh, false)[0];
    return hit ? dough.group.worldToLocal(hit.point.clone()) : V(x, top * 0.97, z);
  }

  /** El dedo aparece y se desvanece al entrar y salir (sin pegarse a la cámara). */
  updateFinger() {
    const f = this.finger;
    if (!f?.group.visible) return;
    const k = clamp(f.fade ?? 1);
    f.group.scale.setScalar(lerp(0.85, 1, k));
    f.skin.opacity = f.nailMat.opacity = smoothstep(0, 0.35, k);
  }

  // -----------------------------------------------------------------------------------------------
  // Formar
  // -----------------------------------------------------------------------------------------------

  async goNext() {
    if (this.leaving || this.finishing || this.dialogOpen) return;
    if (this.phase !== 'proofing' && this.phase !== 'poking') return;
    const s = this.state;
    const pr = s.proof1;
    if (pr.minutes < MIN_SHAPE_MIN) return;
    const [lo, hi] = this.bread.proof1Ideal;
    const st = proofStatus(pr.p, [lo, hi]);
    if (this.guided && st !== 'ok') {
      const [rLo, rHi] = this.idealRise();
      const range = `×${dec(rLo)}–×${dec(rHi)}`;
      let body, actions;
      if (st === 'under') {
        const est = idealProofMinutes({ amounts: s.amounts, tempC: this.spot.tempC }, [lo, hi], pr.p);
        const left = est ? ` A ${this.spot.tempC} °C le quedan unos ${formatMinutes(Math.max(1, Math.ceil(est[0])))}.` : '';
        body = `Solo ha crecido ×${dec(pr.rise)} y lo ideal es ${range}. Si la formas ahora, el pan saldrá denso y se abrirá a lo bruto en el horno.${left}`;
        actions = [{ label: 'Esperar un poco más', variant: 'secondary', value: 'wait' }, { label: 'Formar ya', variant: 'primary', value: 'go' }];
      } else {
        body = pr.collapse > 0.04
          ? 'Se ha pasado de fermentación y ya se está hundiendo. Cuanto más esperes, peor: fórmala ya para salvar lo que se pueda.'
          : `Ha crecido de más (×${dec(pr.rise)}; lo ideal era ${range}). No esperes más: fórmala ya.`;
        actions = [{ label: 'Esperar', variant: 'secondary', value: 'wait' }, { label: 'Formar ya', variant: 'primary', value: 'go' }];
      }
      this.dialogOpen = true;
      const v = await this.ui.showDialog({ title: st === 'under' ? 'Aún le falta' : 'Se ha pasado', body, actions });
      this.dialogOpen = false;
      if (v !== 'go' || this.leaving || this.finishing) return;
      if (this.phase !== 'proofing' && this.phase !== 'poking') return;
    }
    const { tools } = this.models;
    this.finishing = true;
    this.phase = 'reveal';
    this.skip = 0;
    this.setHover(null);
    this.pokeHint = null;
    this.ui.hideHint();
    this.syncControls();
    if (this.finger) this.finger.group.visible = false;
    // se quita el paño y se ve lo que ha crecido
    const ok = await this.uncoverThenView('reveal', 1.3);
    if (this.leaving) return;
    if (!ok) tools.cloth.reset();
    const fin = proofStatus(this.state.proof1.p, [lo, hi]);
    const rise = dec(this.state.proof1.rise);
    if (fin === 'ok') {
      this.audio?.play('success');
      this.sparkleAbove();
      this.ui.toast(`¡Mira cómo ha crecido: ×${rise}! Fermentación en su punto.`, { tone: 'good' });
    } else if (fin === 'under') {
      this.ui.toast(`Ha crecido ×${rise}: algo justa de fermentación.`, { tone: 'warn' });
    } else {
      this.ui.toast(this.state.proof1.collapse > 0.04 ? 'Se ha venido abajo: fermentó de más.' : `Ha crecido de más (×${rise}).`, { tone: 'warn' });
    }
    // (la cámara llega a la vista de cerca algo después de quitar el paño: deja verla un momento)
    const done = await animate({ duration: 1.6, tag: TAG, ease: ease.linear });
    if (!done || this.leaving) return;
    this.complete();
  }

  // -----------------------------------------------------------------------------------------------
  // Puntero
  // -----------------------------------------------------------------------------------------------

  /** ¿Qué hay bajo el puntero? Esferas aproximadas (baratas) del paño doblado y del bol. */
  pick(ndc) {
    if (!ndc || this.finishing) return null;
    const { tools } = this.models;
    this.raycaster.setFromCamera(ndc, this.engine.camera);
    const ray = this.raycaster.ray;
    if (this.phase === 'cover') {
      tools.cloth.object.getWorldPosition(this.sphere.center);
      this.sphere.radius = 0.1;
      if (ray.intersectsSphere(this.sphere)) return 'cloth';
    }
    if (this.phase === 'cover' || this.phase === 'proofing') {
      tools.bowl.anchors.rim.getWorldPosition(this.sphere.center);
      this.sphere.center.y -= 0.04;
      this.sphere.radius = 0.16;
      if (ray.intersectsSphere(this.sphere)) return 'bowl';
    }
    return null;
  }

  setHover(what) {
    if (what === this.hover) return;
    this.hover = what;
    const { tools } = this.models;
    this.engine.setCursor(what ? 'pointer' : '');
    if (this.phase === 'cover') tools.cloth.setHighlight(true);
    else tools.cloth.setHighlight(what === 'bowl' && this.phase === 'proofing');
    if (!what && !this.pokeHint) this.ui.hideHint();
  }

  showHints() {
    if (this.pokeHint) {
      const d = this.models.dough;
      d.group.localToWorld(this.tmp.set(0, d.getTopY() + 0.04, 0));
      this.ui.showHint(this.pokeHint.text, this.engine.worldToScreen(this.tmp));
      return;
    }
    if (!this.hover) return;
    const { tools } = this.models;
    if (this.hover === 'cloth' || (this.hover === 'bowl' && this.phase === 'cover')) {
      const text = 'Tápala con el paño';
      if (this.hover === 'cloth') tools.cloth.object.getWorldPosition(this.tmp).add(V(0, 0.04, 0));
      else tools.bowl.anchors.rim.getWorldPosition(this.tmp).add(V(0, 0.05, 0));
      this.ui.showHint(text, this.engine.worldToScreen(this.tmp));
    } else if (this.hover === 'bowl' && this.phase === 'proofing') {
      tools.bowl.anchors.rim.getWorldPosition(this.tmp).add(V(0, 0.05 + this.bulge, 0));
      this.ui.showHint('Prueba del dedo · haz clic', this.engine.worldToScreen(this.tmp));
    }
  }

  onPointerDown(ev) {
    if (ev.button > 0 || this.leaving || this.engine.controls.enabled) return;
    const what = this.pick(ev.ndc);
    if (!what) return;
    if (this.phase === 'cover') this.cover();
    else if (this.phase === 'proofing' && what === 'bowl') this.poke();
  }

  onPointerMove(ev) {
    if (ev.pointerType === 'touch' || this.leaving) return;
    this.hoverNdc = ev.ndc.clone();
    this.hoverDirty = true;
  }

  // -----------------------------------------------------------------------------------------------
  // Salida
  // -----------------------------------------------------------------------------------------------

  async exit() {
    this.leaving = true;
    cancelAnimations(TAG);
    const { dough, tools } = this.models;
    // la masa queda en el bol, crecida; el paño, doblado en su sitio
    if (dough.group.parent !== tools.bowl.anchors.contents) tools.bowl.anchors.contents.add(dough.group);
    dough.group.position.set(0, 0, 0);
    dough.group.rotation.set(0, dough.group.rotation.y, 0);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.setHighlight(false);
    const pr = this.state.proof1;
    dough.set({ rise: pr.rise, collapse: pr.collapse, squash: 0, stretch: 0 });
    tools.cloth.reset();
    tools.cloth.setHighlight(false);
    tools.bowl.setHighlight(false);
    this.finger?.dispose();
    this.finger = null;
    super.exit();
  }

  async autoComplete() {
    const { tools, dough } = this.models;
    const [lo, hi] = this.bread.proof1Ideal;
    const env = { amounts: this.state.amounts, tempC: 22 };
    let proof = initialProof(22);
    while (proof.p < (lo + hi) / 2 && proof.minutes < 600) proof = proofStep(proof, 1, env);
    this.state.proof1 = { ...proof, spot: 'encimera' };
    this.game.advanceClock(proof.minutes);
    tools.cloth.reset();
    tools.scale.setReading(totalGrams(this.state.amounts) + (this.state.knead?.extraFlour || 0));
    this.placeAt(dough.group, tools.bowl.anchors.contents);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.setHighlight(false);
    dough.set({ shape: 'ball', rise: proof.rise, collapse: proof.collapse, squash: 0, stretch: 0 });
  }
}
