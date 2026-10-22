// Etapa 6 · Hornear: precalentar, meter el pan, vigilar el color y sacarlo a tiempo.
import * as THREE from 'three';
import { Stage, TIME_SPEEDS } from './stage.js';
import { bakeStep, initialBake, idealBakeWindow, ovenStep, ovenStatus, ROOM_C } from '../recipe.js';
import { SPOTS } from '../core/layout.js';
import { animate, ease, wait, cancelAnimations } from '../core/anim.js';
import { clamp, damp, smoothstep, formatMinutes } from '../core/utils.js';

/** Velocidades del horneado (minutos simulados por segundo real): el pan se vigila más despacio que la masa. */
export const BAKE_SPEEDS = { pause: 0, normal: 1, fast: 4 };
const TEMP_MIN = 150, TEMP_MAX = 260;
const DOOR_SIM_SPEED = 0.3;   // min simulados por segundo mientras la puerta está abierta (que no se enfríe de golpe)
/** Largo máximo del pan (m): el mismo al formar, en la bandeja, en el horno y en la rejilla. */
export const MAX_LEN = 0.42;
const STEAM_END = [8, 12];    // el vapor se disipa entre estos minutos
const TAG = 'bake-stage';
const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** true con la interfaz de móvil (hoja inferior con instrucciones y controles). */
export const isPhone = () => window.matchMedia?.('(max-width: 720px)').matches ?? false;

/**
 * Vista que encuadra un punto: la cámara se coloca a `dist` metros en la dirección `dir` y el objetivo se
 * desplaza para que el punto quede en la posición de pantalla `ndc` ([-1..1, -1..1]), lejos de los paneles.
 * @param {import('../engine.js').Engine} engine
 * @param {THREE.Vector3} subject punto de mundo a encuadrar
 * @param {{dir: THREE.Vector3, dist: number, ndc?: [number, number]}} opts
 * @returns {{position: THREE.Vector3, target: THREE.Vector3}}
 */
export function frameView(engine, subject, { dir, dist, ndc = [0, 0] }) {
  const cam = engine.camera;
  const d = dir.clone().normalize();
  const position = subject.clone().addScaledVector(d, dist);
  const fwd = d.clone().negate();
  const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2), tanH = tanV * cam.aspect;
  const target = subject.clone()
    .addScaledVector(right, -ndc[0] * tanH * dist)
    .addScaledVector(up, -ndc[1] * tanV * dist);
  return { position, target };
}

/** Color de la corteza en palabras (para medidores y avisos). */
export function crustLabel(c) {
  if (c < 0.12) return 'Cruda';
  if (c < 0.3) return 'Muy pálida';
  if (c < 0.5) return 'Pálida';
  if (c < 0.66) return 'Dorada clara';
  if (c <= 0.88) return 'Dorada';
  if (c < 1.05) return 'Muy tostada';
  if (c < 1.2) return 'Casi quemada';
  return 'Quemada';
}

/** Ajusta el largo del pan para que quepa en la bandeja y en el horno (solo la barra se pasa de largo). */
export function fitDough(dough, dt = 1) {
  const s = dough.getSize();
  const k = s.x > MAX_LEN ? MAX_LEN / s.x : 1;
  const sx = dt >= 1 ? k : damp(dough.group.scale.x, k, 6, dt);
  dough.group.scale.set(sx, 1, 1);
}

export class BakeStage extends Stage {
  constructor(game) {
    super(game);
    this.phase = 'setup';       // setup → preheat → loading → baking → unloading → out
    this.busy = false;          // animación o diálogo en curso: se ignoran botones y clics
    this.doorBusy = false;      // la puerta está abierta por una animación (el tiempo corre despacio)
    this.exited = false;
    this.time = 0;              // segundos reales en la etapa
    this.speed = 'normal';
    this.preheatMin = 0;
    this.flags = {};            // avisos ya mostrados
    this.dialogOpen = false;    // con un diálogo abierto el tiempo simulado se detiene
    this.steamKept = 1;         // vapor que queda dentro (abrir la puerta lo deja escapar)
    this.view = 'panel';
    this.hover = null;
    this.hoverNdc = null;
    this.hoverT = 0;
    this.knob = null;           // arrastre del mando de temperatura
    this.metersT = 0;
    this.smoke = null;
    this.vapor = null;          // vapor/humo del pan ya fuera del horno
  }

  // ---------------------------------------------------------------------------
  // Entrada y salida
  // ---------------------------------------------------------------------------

  async enter() {
    const { oven, tools, dough } = this.models;
    const bread = this.bread;
    const s = this.state;

    // ¿Bandeja o molde? La masa ya va colgada de su recipiente desde la etapa anterior.
    this.container = dough.group.parent === tools.tin.anchors.inside || (bread.container === 'tin' && tools.tin.object.visible)
      ? tools.tin : tools.tray;
    const obj = this.container.object;
    this.home = { parent: obj.parent || tools.group, position: obj.position.clone(), quaternion: obj.quaternion.clone() };
    if (obj.parent !== tools.group) { this.home.parent = tools.group; this.home.position.copy(SPOTS.tray); }

    const target = this.guided ? bread.bake.tempC : 200;
    s.oven = { tempC: s.oven?.tempC ?? ROOM_C, targetC: target, on: false, doorOpen: false };
    this.steam = this.guided ? bread.bake.steam !== 'no' : false;
    oven.reset?.();
    oven.setTemperature(s.oven.tempC);
    oven.setTargetTemperature(target);
    oven.setTimer(null);
    oven.setStatus('off');
    oven.setLight(false);

    this.instructSetup();
    this.buildControls();
    this.showPreheatInfo();
    this.goView('panel', 1.4);
    this.track(() => oven.setHighlight(null));
    const onResize = () => this.goView(this.view, 0.3);
    window.addEventListener('resize', onResize);
    this.track(() => window.removeEventListener('resize', onResize));
  }

  async exit() {
    this.exited = true;
    cancelAnimations(TAG);
    const { oven, kitchen, dough } = this.models;
    this.knob = null;
    this.setHover(null);
    this.smoke?.stop();
    this.vapor?.stop();
    oven.setHighlight(null);
    oven.setSteam(0);
    // Si salimos a medias (reinicio), el recipiente vuelve a casa y el horno se apaga.
    if (!this.done) {
      this.returnHome();
      this.state.oven = { ...this.state.oven, on: false, doorOpen: false };
      oven.reset?.();
      kitchen.setOvenGlow(0);
      dough.group.scale.set(1, 1, 1);
    }
    super.exit();
  }

  /** Bandeja/molde a su sitio en la encimera, sin animación. */
  returnHome() {
    const obj = this.container?.object;
    if (!obj || !this.home) return;
    this.home.parent.add(obj);
    obj.position.copy(this.home.position);
    obj.quaternion.copy(this.home.quaternion);
  }

  // ---------------------------------------------------------------------------
  // Interfaz
  // ---------------------------------------------------------------------------

  buildControls() {
    const s = this.state;
    this.controls = this.ui.setControls([
      {
        type: 'slider', id: 'temp', label: 'Temperatura', min: TEMP_MIN, max: TEMP_MAX, step: 5, value: s.oven.targetC,
        unit: '°C', format: (v) => `${Math.round(v)} °C`, onInput: (v) => this.setTarget(v, false),
      },
      {
        type: 'choice', id: 'steam', label: 'Vapor', value: this.steam ? 'yes' : 'no',
        options: [{ value: 'yes', label: 'Con vapor' }, { value: 'no', label: 'Sin vapor' }],
        onChange: (v) => this.setSteamChoice(v === 'yes'),
      },
      { ...this.speedControl(this.speed, (v) => this.setSpeed(v)), hidden: true },
      { type: 'button', id: 'peek', label: 'Abrir y mirar', icon: 'info', variant: 'secondary', hidden: true, onClick: () => this.peek() },
      { type: 'button', id: 'on', label: 'Encender el horno', icon: 'thermometer', variant: 'primary', onClick: () => this.turnOn() },
      { type: 'button', id: 'load', label: 'Meter el pan', icon: 'loaf', variant: 'primary', hidden: true, onClick: () => this.loadBread() },
      { type: 'button', id: 'unload', label: 'Sacar el pan', icon: 'loaf', variant: 'primary', hidden: true, onClick: () => this.unloadBread() },
      { type: 'button', id: 'next', label: 'Ver el resultado', icon: 'check', variant: 'primary', hidden: true, onClick: () => this.complete() },
    ]);
  }

  ctl(id) { return this.controls?.get(id) ?? { set() {} }; }

  /** "la bandeja" o "el molde", según dónde vaya el pan. */
  get boxName() { return this.container === this.models.tools.tin ? 'el molde' : 'la bandeja'; }

  /** Muestra solo los controles de la fase actual. */
  syncControls() {
    const p = this.phase;
    const pre = p === 'setup' || p === 'preheat';
    const moving = p === 'loading' || p === 'unloading'; // durante las animaciones se ven, pero desactivados
    this.ctl('temp').set({ hidden: !(pre || p === 'baking' || moving) });
    this.ctl('steam').set({ hidden: !pre });
    this.ctl('speed').set({ hidden: !(p === 'preheat' || p === 'baking' || moving), value: this.speed });
    this.ctl('peek').set({ hidden: p !== 'baking', disabled: this.busy });
    this.ctl('on').set({ hidden: p !== 'setup' });
    this.ctl('load').set({ hidden: p !== 'preheat', disabled: this.busy });
    this.ctl('unload').set({ hidden: p !== 'baking', disabled: this.busy });
    this.ctl('next').set({ hidden: p !== 'out' });
  }

  instructSetup() {
    const b = this.bread, s = this.state;
    if (this.guided) {
      this.instruct('Precalienta el horno',
        `Pon el horno a ${s.oven.targetC} °C${this.steam ? ' con vapor' : ''} y enciéndelo. Cuando pite, mete el pan.`,
        b.tips?.bake);
    } else {
      this.instruct('Precalienta el horno',
        'Elige la temperatura, decide si quieres vapor y enciende el horno. Cuando pite, estará listo para el pan.');
    }
  }

  /** Texto con la ventana ideal de horneado (modo guiado). */
  windowTip() {
    const s = this.state, b = this.bread;
    const w = idealBakeWindow(b.id, { ovenC: s.oven.targetC, steam: this.steam, eggwash: String(s.shape.topping).includes('eggwash'), shape: s.shape.shape });
    const at = `A ${s.oven.targetC} °C${this.steam ? ' con vapor' : ''}`;
    if (!w.minutes) return `${at} será difícil que quede bien: la receta pide ${b.bake.tempC} °C.`;
    return `${at} estará en su punto entre los ${w.minutes[0]} y los ${w.minutes[1]} min.`;
  }

  // ---------------------------------------------------------------------------
  // Cámara
  // ---------------------------------------------------------------------------

  /** Vistas de la etapa, adaptadas a escritorio o móvil. */
  viewFor(name) {
    const { oven } = this.models;
    const phone = isPhone();
    if (name === 'panel') {
      // frente del horno: visor, mandos y puerta
      return frameView(this.engine, V(2.0, 1.15, -1.0), { dir: V(-0.36, 0.3, 1.3), dist: phone ? 2.0 : 1.42, ndc: phone ? [0, 0.38] : [0.02, 0.08] });
    }
    if (name === 'load') {
      // de la encimera al horno: se ve el viaje de la bandeja
      return frameView(this.engine, V(1.55, 1.05, -0.6), { dir: V(-0.62, 0.58, 1.0), dist: phone ? 2.9 : 2.05, ndc: phone ? [0, 0.36] : [0.06, 0.2] });
    }
    if (name === 'window') {
      const w = oven.getWindowView();
      const rack = oven.anchors.rack.getWorldPosition(new THREE.Vector3());
      const subject = rack.clone().add(V(0, 0.055, 0));
      const dir = w.position.clone().sub(w.target).setY(0).normalize().add(V(0, 0.12, 0));
      return frameView(this.engine, subject, { dir, dist: phone ? 1.2 : 0.92, ndc: phone ? [0, 0.36] : [0, 0.12] });
    }
    // 'out': el pan recién sacado, en la encimera
    const p = this.home.position.clone().add(V(0, 0.05, 0));
    return frameView(this.engine, p, { dir: V(0.25, 0.55, 0.8), dist: phone ? 1.25 : 0.85, ndc: phone ? [0, 0.38] : [0, 0.08] });
  }

  goView(name, duration = 1.2) {
    this.view = name;
    if (this.exited) return Promise.resolve(false);
    return this.camera(this.viewFor(name), { duration });
  }

  // ---------------------------------------------------------------------------
  // Acciones
  // ---------------------------------------------------------------------------

  setTarget(v, fromKnob) {
    const t = clamp(Math.round(v / 5) * 5, TEMP_MIN, TEMP_MAX);
    const s = this.state;
    if (t === s.oven.targetC) return;
    s.oven = { ...s.oven, targetC: t };
    if (this.phase === 'baking') s.bake.targetC = t;
    this.models.oven.setTargetTemperature(t);
    if (fromKnob) this.ctl('temp').set({ value: t });
    if (Math.abs(s.oven.tempC - t) > 6) this.flags.ready = false; // al volver a llegar, volverá a avisar
    if (this.phase === 'setup') this.instructSetup();
    if (this.phase === 'baking' && this.guided) this.instruct(this.bakingTitle(), this.bakingText(), this.windowTip());
  }

  setSteamChoice(on) {
    this.steam = on;
    this.audio?.play('click');
    if (this.phase === 'setup') this.instructSetup();
    if (this.guided && this.bread.bake.steam === 'imprescindible' && !on) {
      this.ui.toast(`Sin vapor la ${this.bread.name.toLowerCase()} no se abre ni brilla: la receta lo pide.`, { tone: 'warn' });
    }
  }

  setSpeed(v) {
    if (!(v in BAKE_SPEEDS)) return;
    this.speed = v;
    this.audio?.play('click');
  }

  turnOn() {
    if (this.phase !== 'setup' || this.busy || this.exited) return;
    const { oven } = this.models;
    const s = this.state;
    s.oven = { ...s.oven, on: true, doorOpen: false };
    this.phase = 'preheat';
    this.preheatMin = 0;
    this.audio?.play('click');
    oven.setStatus(ovenStatus(s.oven));
    this.hum = this.loop('oven-hum', { volume: 0.7 });
    this.hum?.setIntensity(0.4);
    this.syncControls();
    this.instruct('Precalentando…',
      `El horno sube de ${Math.round(s.oven.tempC)} °C a ${s.oven.targetC} °C. Cuando pite y la luz se ponga verde, mete el pan.`,
      'El tiempo corre deprisa: con «Rápido» el precalentado dura un suspiro.');
    this.ui.toast(`Horno encendido: calentando a ${s.oven.targetC} °C`, { tone: 'info' });
  }

  async loadBread() {
    if (this.phase !== 'preheat' || this.busy || this.exited) return;
    const { oven } = this.models;
    const s = this.state;
    if (ovenStatus(s.oven) !== 'ready') {
      this.busy = true;
      this.dialogOpen = true;
      this.syncControls();
      const choice = await this.ui.showDialog({
        title: 'El horno aún no está caliente',
        body: `Está a ${Math.round(s.oven.tempC)} °C y has pedido ${s.oven.targetC} °C. Si metes el pan ahora subirá peor y tardará más en dorarse.`,
        actions: [
          { label: 'Esperar a que se caliente', variant: 'secondary', value: 'wait' },
          { label: 'Meterlo ya', variant: 'primary', value: 'go' },
        ],
      });
      this.busy = false;
      this.dialogOpen = false;
      if (this.exited || this.phase !== 'preheat') return;
      this.syncControls();
      if (choice !== 'go') return;
    }
    // --- coreografía: abrir, llevar la bandeja, cerrar ---
    this.phase = 'loading';
    this.busy = true;
    this.ui.setBusy(true);
    this.setHover(null);
    oven.setHighlight(null);
    s.bake = {
      ...initialBake(24), targetC: s.oven.targetC, steam: this.steam,
      preheated: s.oven.tempC >= s.oven.targetC - 10, doorOpenings: 0,
    };
    this.flags.ready = true;
    this.syncControls();
    this.instruct('Al horno', `Abrimos la puerta, metemos ${this.boxName} en la rejilla y cerramos rápido para que no se escape el calor.`);
    const obj = this.container.object;
    this.goView('load', 1.3);
    this.doorBusy = true;
    s.oven = { ...s.oven, doorOpen: true };
    await oven.openDoor(0.9);
    if (this.exited) return;
    oven.setLight(true);
    this.audio?.play('whoosh', { volume: 0.6 });
    await this.travel(obj, this.worldOf(oven.anchors.doorFront), { height: 0.16, duration: 1.35 });
    if (this.exited) return;
    await this.travel(obj, this.worldOf(oven.anchors.rack), { height: 0, duration: 0.95, ease: ease.inOutSine });
    if (this.exited) return;
    oven.anchors.rack.attach(obj);
    obj.position.set(0, 0, 0);
    obj.quaternion.copy(this.home.quaternion);
    this.audio?.play('click', { volume: 0.6 });
    s.oven = { ...s.oven, doorOpen: false };
    const closing = oven.closeDoor(0.75);
    if (this.steam) {
      this.audio?.play('sizzle-start');
      oven.setSteam(1);
    }
    await closing;
    if (this.exited) return;
    this.doorBusy = false;
    this.goView('window', 1.4);
    // --- empieza el horneado ---
    this.phase = 'baking';
    this.bakeT0 = this.time;
    this.sizzle = this.loop('sizzle', { volume: 0.8 });
    this.instruct(this.bakingTitle(), this.bakingText(), this.windowTip());
    this.ui.setBusy(false);
    this.busy = false;
    this.syncControls();
    this.ui.toast(s.bake.preheated ? '¡Dentro! Ahora, a vigilar el color.' : 'Dentro, aunque el horno aún no estaba caliente del todo.',
      { tone: s.bake.preheated ? 'good' : 'warn' });
  }

  bakingTitle() { return 'Vigila el horneado'; }

  bakingText() {
    return this.guided
      ? 'Mira por el cristal cómo sube y se dora. Sácalo cuando la corteza esté en la franja verde y el centro pase de 94 °C.'
      : 'Mira por el cristal cómo sube y se dora. Tú decides cuándo sacarlo.';
  }

  /** Abre la puerta un momento para ver el pan (se escapa calor y vapor). */
  async peek() {
    if (this.phase !== 'baking' || this.busy || this.exited) return;
    const { oven } = this.models;
    const s = this.state;
    this.busy = true;
    this.doorBusy = true;
    this.syncControls();
    s.bake.doorOpenings = (s.bake.doorOpenings || 0) + 1;
    s.oven = { ...s.oven, doorOpen: true };
    this.setHover(null);
    await oven.openDoor(0.8);
    if (this.exited) return;
    this.steamKept = Math.min(this.steamKept, 0.3);
    if (s.bake.crust > 1.05) this.particles?.puff(this.doorTop(), { color: 0x3a332e, count: 40, spread: 0.12, size: 0.06, life: 2, rise: 0.25 });
    const b = s.bake;
    const n = s.bake.doorOpenings;
    this.ui.toast(`Corteza ${crustLabel(b.crust).toLowerCase()} · ${Math.round(b.internalC)} °C en el centro · ${formatMinutes(Math.round(b.minutes))} de horno`,
      { tone: 'info', duration: 3.2 });
    if (n === 3) this.ui.toast('Cada vez que abres se escapa el calor: mejor mirar por el cristal.', { tone: 'warn' });
    await wait(1.7);
    if (this.exited) return;
    s.oven = { ...s.oven, doorOpen: false };
    await oven.closeDoor(0.6);
    if (this.exited) return;
    this.doorBusy = false;
    this.busy = false;
    this.syncControls();
  }

  async unloadBread() {
    if (this.phase !== 'baking' || this.busy || this.exited) return;
    if (this.time - this.bakeT0 < 1) return; // evita el doble clic de "Meter el pan"
    const { oven } = this.models;
    const s = this.state, b = s.bake, [lo] = this.bread.bake.crustIdeal;
    const raw = b.internalC < 75;
    const early = this.guided && (b.internalC < 93 || b.crust < lo - 0.05);
    if (raw || early) {
      this.busy = true;
      this.dialogOpen = true;
      this.syncControls();
      const why = b.internalC < 93
        ? `El centro está a ${Math.round(b.internalC)} °C y tiene que pasar de 93 °C: por dentro aún está crudo.`
        : `La corteza todavía está ${crustLabel(b.crust).toLowerCase()}: unos minutos más y se dorará.`;
      const choice = await this.ui.showDialog({
        title: 'Aún le falta horno',
        body: `Lleva ${formatMinutes(Math.round(b.minutes))}. ${why}`,
        actions: [
          { label: 'Dejarlo un poco más', variant: 'secondary', value: 'wait' },
          { label: 'Sacarlo igualmente', variant: 'primary', value: 'go' },
        ],
      });
      this.busy = false;
      this.dialogOpen = false;
      if (this.exited || this.phase !== 'baking') return;
      this.syncControls();
      if (choice !== 'go') return;
    }
    // --- coreografía: abrir, sacar la bandeja a la encimera, apagar ---
    this.phase = 'unloading';
    this.busy = true;
    this.doorBusy = true;
    this.ui.setBusy(true);
    this.syncControls();
    this.sizzle?.stop(1.2);
    this.sizzle = null;
    this.instruct('¡Fuera del horno!', `Con cuidado, que quema: ${this.boxName} vuelve a la encimera.`);
    this.goView('load', 1.3);
    s.oven = { ...s.oven, doorOpen: true };
    await oven.openDoor(0.9);
    if (this.exited) return;
    if (b.crust > 1.05) this.particles?.puff(this.doorTop(), { color: 0x3a332e, count: 60, spread: 0.15, size: 0.07, life: 2.2, rise: 0.25 });
    const obj = this.container.object;
    await this.travel(obj, this.worldOf(oven.anchors.doorFront), { height: 0, duration: 0.85, ease: ease.inOutSine });
    if (this.exited) return;
    // el horno se apaga y la puerta se cierra mientras la bandeja vuela a la encimera
    s.oven = { ...s.oven, on: false, doorOpen: false };
    oven.setSteam(0);
    oven.setStatus('off');
    oven.setTimer(null);
    this.hum?.stop(1.5);
    this.hum = null;
    const closing = oven.closeDoor(0.8);
    const homeWorld = this.home.parent.localToWorld(this.home.position.clone());
    this.audio?.play('whoosh', { volume: 0.5 });
    await this.travel(obj, homeWorld, { height: 0.16, duration: 1.3 });
    if (this.exited) return;
    this.returnHome();
    oven.setLight(false);
    this.audio?.play('thump', { volume: 0.5 });
    await closing;
    if (this.exited) return;
    this.doorBusy = false;
    this.phase = 'out';
    this.startVapor();
    this.goView('out', 1.1);
    this.celebrate();
    this.ui.setBusy(false);
    this.busy = false;
    this.syncControls();
    this.updateHud(true);
    // un momento para mirarlo y pasamos al resultado
    await wait(2.6);
    if (!this.exited && this.phase === 'out') this.complete();
  }

  /** Momento de éxito (o aviso) al sacar el pan. */
  celebrate() {
    const s = this.state, b = s.bake, bread = this.bread;
    const [lo, hi] = bread.bake.crustIdeal;
    const top = this.breadTop();
    const when = `${formatMinutes(Math.round(b.minutes))} a ${s.bake.targetC} °C`;
    if (b.crust >= 1.2) {
      this.audio?.play('fail', { volume: 0.6 });
      this.ui.toast(`Se ha quemado: ${when} ha sido demasiado.`, { tone: 'bad', duration: 3.2 });
      this.instruct('¡Fuera del horno!', `${when}. Huele a tostado de más… vamos a ver cómo ha quedado por dentro.`);
    } else if (b.internalC < 93) {
      this.audio?.play('ding', { volume: 0.5 });
      this.ui.toast(`Le falta horno: el centro está a ${Math.round(b.internalC)} °C.`, { tone: 'warn', duration: 3.2 });
      this.instruct('¡Fuera del horno!', `${when}, con ${Math.round(b.internalC)} °C en el centro. Vamos a ver qué tal ha quedado.`);
    } else if (b.crust >= lo && b.crust <= hi) {
      this.audio?.play('success');
      this.particles?.sparkle(top, { count: 40, spread: 0.12 });
      this.ui.toast(`¡En su punto! ${when}: corteza dorada y ${Math.round(b.internalC)} °C en el centro.`, { tone: 'good', duration: 3.2 });
      this.instruct('¡Fuera del horno!', `${when}. ¡Qué pinta! Escucha cómo cruje la corteza al enfriarse.`);
    } else {
      this.audio?.play('ding', { volume: 0.6 });
      this.ui.toast(`Corteza ${crustLabel(b.crust).toLowerCase()} tras ${when}.`, { tone: b.crust < lo ? 'info' : 'warn', duration: 3.2 });
      this.instruct('¡Fuera del horno!', `${when}. Vamos a ver qué tal ha quedado.`);
    }
  }

  /** Vapor (o humo, si se ha quemado) saliendo del pan caliente en la encimera. */
  startVapor() {
    const b = this.state.bake;
    const pos = this.breadTop();
    this.vapor?.stop();
    this.vapor = b.crust >= 1.15
      ? this.particles?.smoke(pos, { rate: 10, spread: 0.06, rise: 0.2, size: 0.06 })
      : this.particles?.steam(pos, { rate: 12, spread: 0.06, rise: 0.25, size: 0.05 });
    if (this.vapor) this.track(() => this.vapor?.stop());
  }

  // ---------------------------------------------------------------------------
  // Utilidades de escena
  // ---------------------------------------------------------------------------

  worldOf(obj) { return obj.getWorldPosition(new THREE.Vector3()); }

  /** Punto sobre el pan (para partículas y pistas). */
  breadTop() {
    const { dough } = this.models;
    return dough.group.localToWorld(new THREE.Vector3(0, dough.getTopY() + 0.01, 0));
  }

  /** Parte alta de la puerta, delante del cristal (por donde se escapa el humo; se ve desde la vista del cristal). */
  doorTop() { return this.models.oven.group.localToWorld(new THREE.Vector3(0, 0.13, 0.08)); }

  /** Lleva un objeto a un punto de mundo en arco (cancelable al salir de la etapa). */
  travel(object, toWorld, { height = 0, duration = 1, ease: easing = ease.inOutCubic } = {}) {
    this.engine.scene.attach(object);
    const from = object.position.clone();
    const q0 = object.quaternion.clone(), q1 = this.home.quaternion;
    return animate({
      duration, ease: easing, tag: TAG,
      onUpdate: (t, raw) => {
        object.position.lerpVectors(from, toWorld, t);
        object.position.y += Math.sin(Math.PI * raw) * height;
        object.quaternion.slerpQuaternions(q0, q1, t);
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Bucle
  // ---------------------------------------------------------------------------

  /** Minutos simulados por segundo real ahora mismo. */
  simRate() {
    const p = this.phase;
    // apagado o con el pan fuera, el tiempo va al ritmo real; precalentando y horneando, en cámara rápida
    const k = p === 'baking' || p === 'unloading' ? BAKE_SPEEDS[this.speed]
      : p === 'preheat' || p === 'loading' ? TIME_SPEEDS[this.speed] : 1 / 60;
    if (this.dialogOpen || this.game.simPaused) return 0; // el tiempo se detiene mientras el jugador decide (o lee la ayuda)
    return this.doorBusy ? Math.min(k, DOOR_SIM_SPEED) : k;
  }

  update(dt) {
    if (this.exited) return;
    try {
      this.time += dt;
      const s = this.state;
      const dtMin = dt * this.simRate();
      const ovenRuns = s.oven.on || s.oven.tempC > ROOM_C + 0.5;
      if (dtMin > 0 && ovenRuns) s.oven = ovenStep(s.oven, dtMin);
      if (this.phase === 'preheat' && dtMin > 0) {
        this.preheatMin += dtMin;
        this.game.advanceClock(dtMin);
        if (ovenStatus(s.oven) === 'ready' && !this.flags.ready) this.onReady();
      }
      if (this.phase === 'baking' && dtMin > 0) {
        s.bake = bakeStep(s.bake, dtMin, this.bakeOpts(s.oven.tempC));
        this.game.advanceClock(dtMin);
      }
      if (this.phase === 'baking' || this.phase === 'unloading') this.updateBaking();
      this.updateOven();
      this.fitTimer = (this.fitTimer || 0) + dt;
      if (this.fitTimer > 0.1) { fitDough(this.models.dough, this.fitTimer); this.fitTimer = 0; }
      this.metersT -= dt;
      if (this.metersT <= 0) { this.metersT = 0.1; this.updateHud(); }
      this.updateHover(dt);
    } catch (e) {
      if (!this._failed) { this._failed = true; console.error('[bake]', e); }
    }
  }

  onReady() {
    const { oven } = this.models;
    const s = this.state;
    this.flags.ready = true;
    this.ui.toast(`¡Horno listo a ${s.oven.targetC} °C! Ya puedes meter el pan.`, { tone: 'good' });
    this.particles?.sparkle(oven.group.localToWorld(new THREE.Vector3(0, 0.3, 0.05)), { count: 18, spread: 0.06, color: 0xffb347 });
    this.instruct('¡Horno listo!', `Ya está a ${s.oven.targetC} °C. Pulsa «Meter el pan» o la puerta del horno.`,
      this.guided ? 'Mételo enseguida: si esperas mucho, el horno gasta y la cocina se calienta.' : undefined);
    oven.setHighlight('door');
  }

  /** Visor, resistencias, luz de la cocina y sonido del horno según el estado. */
  updateOven() {
    const { oven, kitchen } = this.models;
    const o = this.state.oven;
    oven.setTemperature(o.tempC);
    oven.setTargetTemperature(o.targetC);
    let status = ovenStatus(o);
    if (this.phase === 'baking' && status === 'heating' && o.tempC > o.targetC - 25) status = 'ready'; // sin pitidos por un bache
    if (this.phase !== 'unloading' && this.phase !== 'out') oven.setStatus(status);
    // resistencias: a tope mientras calienta; el termostato las hace respirar cuando ya está a temperatura
    const heat = !o.on ? 0 : o.tempC < o.targetC - 6 ? 1 : o.tempC > o.targetC + 4 ? 0.15 : 0.6 + 0.12 * Math.sin(this.time * 0.9);
    oven.setHeat(heat);
    // resplandor cálido delante del horno: solo con las resistencias encendidas, mucho más con la puerta abierta
    const hot = o.on ? clamp((o.tempC - ROOM_C) / 220) : 0;
    kitchen.setOvenGlow?.(hot * (0.12 + 0.8 * (oven.doorOpen01 ?? 0)));
    this.hum?.setIntensity(0.25 + 0.5 * heat);
  }

  updateBaking() {
    const { oven, dough } = this.models;
    const s = this.state, b = s.bake, bread = this.bread;
    const [lo, hi] = bread.bake.crustIdeal;
    dough.set({ bake: b.crust, rise: (s.proof2?.rise || 1) * (b.spring || 1) });
    if (this.phase === 'baking') oven.setTimer(b.minutes);
    // vapor dentro los primeros minutos
    const steam = this.steam ? (1 - smoothstep(STEAM_END[0], STEAM_END[1], b.minutes)) * this.steamKept : 0;
    const haze = 0.55 * smoothstep(1.05, 1.3, b.crust); // al quemarse, el interior se llena de humo
    oven.setSteam(this.phase === 'baking' ? Math.max(steam, haze) : 0);
    this.sizzle?.setIntensity(0.2 + 0.7 * clamp(b.moisture ?? 0.5));
    // humo si se quema
    if (b.crust > 1.1 && this.phase === 'baking') {
      const rate = 10 + 40 * smoothstep(1.1, 1.4, b.crust);
      if (!this.smoke) {
        // gris medio: se distingue sobre la puerta negra y sobre los muebles claros
        this.smoke = this.particles?.smoke(this.doorTop(), { rate, spread: 0.14, rise: 0.2, size: 0.08, color: 0x8a8079 }) ?? null;
        if (this.smoke) this.track(() => this.smoke?.stop());
      }
      this.smoke?.setRate(rate);
      if (!this.flags.burning) {
        this.flags.burning = true;
        this.audio?.play('fail', { volume: 0.4 });
        this.ui.toast('¡Huele a quemado! Sácalo ya.', { tone: 'bad', duration: 3.5 });
      }
    } else if (this.smoke && this.phase !== 'baking') {
      this.smoke.stop();
      this.smoke = null;
    }
    if (this.phase !== 'baking') return;
    // avisos del modo guiado
    if (!this.guided) return;
    const f = this.flags;
    if (this.steam && !f.steamOut && b.minutes >= 10) {
      f.steamOut = true;
      this.ui.toast('Fuera el vapor: a partir de ahora la corteza se dora.', { tone: 'info' });
    }
    if (!f.slow && this.speed === 'fast' && b.crust >= lo - 0.12 && b.internalC > 85) {
      f.slow = true;
      this.speed = 'normal';
      this.ctl('speed').set({ value: 'normal' });
      this.ui.toast('Ya casi está: vuelvo a velocidad normal para que no se te pase.', { tone: 'info' });
    }
    if (!f.core && b.internalC >= 94) {
      f.core = true;
      this.ui.toast('El centro ya pasa de 94 °C: por dentro está hecho.', { tone: 'good' });
    }
    if (!f.ideal && b.crust >= lo && b.internalC >= 93) {
      f.ideal = true;
      this.audio?.play('ding');
      this.particles?.sparkle(this.breadTop(), { count: 24, spread: 0.1 });
      this.ui.toast('¡En su punto! Sácalo ahora o espera un poco si lo quieres más tostado.', { tone: 'good', duration: 3.4 });
    }
    if (!f.over && b.crust > hi) {
      f.over = true;
      this.ui.toast('Se está tostando de más: ¡sácalo ya!', { tone: 'warn', duration: 3 });
    }
  }

  /** Medidores, reloj y estado de los botones. */
  updateHud(force) {
    const s = this.state;
    const o = s.oven;
    if (this.phase === 'setup' || this.phase === 'preheat' || (this.phase === 'loading' && !force)) {
      this.showPreheatInfo();
      return;
    }
    const b = s.bake, bread = this.bread;
    const [lo, hi] = bread.bake.crustIdeal;
    const crustTone = b.crust > 1.05 ? 'bad' : b.crust > hi ? 'warn' : b.crust >= lo ? 'good' : 'neutral';
    const springPct = Math.round(((b.spring || 1) - 1) * 100);
    this.ui.setMeters([
      { id: 'crust', label: 'Color de la corteza', value01: clamp(b.crust / 1.4), ideal: this.ideal([lo / 1.4, hi / 1.4]), text: crustLabel(b.crust), tone: crustTone },
      {
        id: 'core', label: 'Temperatura interna', value01: clamp((b.internalC - 20) / 80), ideal: this.ideal([(94 - 20) / 80, 1]),
        text: `${Math.round(b.internalC)} °C`, tone: b.internalC >= 94 ? 'good' : 'neutral',
      },
      {
        id: 'spring', label: 'Subida en el horno', value01: clamp(springPct / 40), ideal: null,
        text: springPct > 0 ? `+${springPct} %` : '—', tone: springPct >= 20 ? 'good' : 'neutral',
      },
    ]);
    const steamOn = this.steam && b.minutes < STEAM_END[1] && this.phase === 'baking';
    this.ui.setClock(this.phase === 'out'
      ? { label: 'Horneado', text: formatMinutes(Math.round(b.minutes)), sub: `a ${s.bake.targetC} °C${this.steam ? ' con vapor' : ''}` }
      : { label: 'Horneando', text: formatMinutes(b.minutes < 10 ? Math.floor(b.minutes * 6) / 6 : b.minutes), sub: `Horno a ${Math.round(o.tempC)} °C${steamOn ? ' · con vapor' : ''}` });
  }

  showPreheatInfo() {
    const o = this.state.oven;
    const loading = this.phase === 'loading';
    const ready = !loading && ovenStatus(o) === 'ready';
    this.ui.setMeters([{
      id: 'oven', label: 'Temperatura del horno', value01: clamp(o.tempC / TEMP_MAX),
      ideal: this.ideal([(o.targetC - 6) / TEMP_MAX, (o.targetC + 6) / TEMP_MAX]),
      text: `${Math.round(o.tempC)} °C`, tone: ready ? 'good' : o.on && !loading ? 'warn' : 'neutral',
    }]);
    // mientras entra el pan, la puerta abierta enfría el horno: no es un precalentado ni un aviso
    this.ui.setClock(this.phase === 'setup'
      ? { label: 'Horno apagado', text: `${Math.round(o.tempC)} °C`, sub: `Objetivo: ${o.targetC} °C` }
      : loading ? { label: 'Metiendo el pan', text: `${Math.round(o.tempC)} °C`, sub: `Objetivo: ${o.targetC} °C` }
        : { label: ready ? 'Horno listo' : 'Precalentando', text: formatMinutes(Math.round(this.preheatMin)), sub: `${Math.round(o.tempC)} °C → ${o.targetC} °C` });
  }

  // ---------------------------------------------------------------------------
  // Puntero: pistas, mando de temperatura, puerta y bandeja
  // ---------------------------------------------------------------------------

  /** ¿Qué hay bajo el puntero? → {kind: 'tempKnob'|'modeKnob'|'door'|'bread', anchor: Vector3} | null */
  pick(ndc) {
    const { oven } = this.models;
    const hits = this.engine.raycast(ndc, oven.interactive);
    // la bandeja (o el molde) con el pan: basta su caja; un rayo contra la malla de la masa cuesta milisegundos
    let breadAt = Infinity;
    if ((this.phase === 'setup' || this.phase === 'preheat') && this.container.object.visible) {
      const ray = this.engine.raycaster.ray;
      this.boxBounds ??= new THREE.Box3().setFromObject(this.container.object); // no se mueve hasta meterlo al horno
      const p = ray.intersectBox(this.boxBounds, new THREE.Vector3());
      if (p) breadAt = p.distanceTo(ray.origin);
    }
    for (const h of hits) {
      if (h.distance > breadAt) break;
      const part = h.object.userData.ovenPart;
      if (part === 'tempKnob' || part === 'modeKnob') return { kind: part, anchor: h.object.getWorldPosition(new THREE.Vector3()) };
      if (part === 'door') return { kind: 'door', anchor: h.point.clone() }; // la pista junto al puntero, no en la bisagra
    }
    return breadAt < Infinity ? { kind: 'bread', anchor: this.breadTop() } : null;
  }

  hintFor(kind) {
    const p = this.phase, o = this.state.oven;
    if (this.busy) return null;
    if (kind === 'tempKnob') return p === 'out' ? null : `Temperatura: ${o.targetC} °C · arrastra arriba o abajo`;
    if (kind === 'modeKnob') return p === 'setup' ? 'Encender el horno' : null;
    if (kind === 'door') return p === 'setup' ? 'Primero enciende el horno' : p === 'preheat' ? 'Meter el pan' : p === 'baking' ? 'Abrir y mirar (se escapa calor)' : null;
    if (kind === 'bread') return p === 'preheat' ? 'Meter el pan' : p === 'setup' ? `Tu pan espera en ${this.boxName}` : null;
    return null;
  }

  setHover(h) {
    const { oven } = this.models;
    const prev = this.hover?.kind;
    this.hover = h;
    if (prev !== h?.kind) {
      const part = h?.kind === 'door' || h?.kind === 'tempKnob' || h?.kind === 'modeKnob' ? h.kind : null;
      if (part) oven.setHighlight(part);
      else if (!(this.phase === 'preheat' && this.flags.ready)) oven.setHighlight(null);
      else oven.setHighlight('door');
      this.container?.setHighlight?.(h?.kind === 'bread');
      this.models.dough.setHighlight(h?.kind === 'bread');
    }
    const text = h ? this.hintFor(h.kind) : null;
    if (text) {
      this.ui.showHint(text, this.engine.worldToScreen(h.anchor));
      this.engine.setCursor(h.kind === 'tempKnob' ? 'grab' : 'pointer');
    } else {
      this.ui.hideHint();
      this.engine.setCursor('');
    }
  }

  updateHover(dt) {
    this.hoverT -= dt;
    if (this.knob || !this.hoverNdc || this.hoverT > 0) return;
    this.hoverT = 0.06;
    const ndc = this.hoverNdc;
    this.hoverNdc = null;
    this.setHover(this.busy ? null : this.pick(ndc));
  }

  onPointerMove(ev) {
    if (this.knob) {
      const steps = Math.round((this.knob.y - ev.y) / 7);
      const v = clamp(this.knob.start + steps * 5, TEMP_MIN, TEMP_MAX);
      if (v !== this.state.oven.targetC) {
        this.setTarget(v, true);
        this.audio?.play('tick', { volume: 0.5 });
      }
      if (this.hover) this.ui.showHint(`Temperatura: ${this.state.oven.targetC} °C`, this.engine.worldToScreen(this.hover.anchor));
      return;
    }
    if (ev.pointerType === 'mouse') this.hoverNdc = ev.ndc.clone();
  }

  onPointerDown(ev) {
    if (this.exited || this.busy || ev.button > 0) return;
    const h = this.pick(ev.ndc);
    if (!h) return;
    const p = this.phase;
    if (h.kind === 'tempKnob' && p !== 'out' && p !== 'loading' && p !== 'unloading') {
      this.knob = { y: ev.y, start: this.state.oven.targetC };
      this.hover = h;
      this.engine.setCursor('grabbing');
      return;
    }
    if (h.kind === 'modeKnob') {
      if (p === 'setup') this.turnOn();
      return;
    }
    if (h.kind === 'door' || h.kind === 'bread') {
      if (p === 'setup') this.ui.toast('Primero enciende el horno y espera a que se caliente.', { tone: 'info' });
      else if (p === 'preheat') this.loadBread();
      else if (p === 'baking' && h.kind === 'door') this.peek();
    }
  }

  onPointerUp() {
    if (!this.knob) return;
    this.knob = null;
    this.engine.setCursor('grab');
  }

  // ---------------------------------------------------------------------------
  // Atajo para pruebas: horneado perfecto al instante
  // ---------------------------------------------------------------------------

  async autoComplete() {
    const { oven, dough, kitchen, tools } = this.models;
    const bread = this.bread;
    const targetC = bread.bake.tempC;
    const steam = bread.bake.steam !== 'no';
    Object.assign(this.state.bake, { targetC, steam, preheated: true, doorOpenings: 0 });
    const eggwash = String(this.state.shape.topping).includes('eggwash');
    const win = idealBakeWindow(bread.id, { ovenC: targetC, steam, eggwash, shape: this.state.shape.shape });
    const minutes = win.minutes ? (win.minutes[0] + win.minutes[1]) / 2 : bread.bake.minutes[0];
    let bake = initialBake(24);
    const opts = this.bakeOpts(targetC);
    for (let t = 0; t < minutes; t += 0.5) bake = bakeStep(bake, 0.5, opts);
    Object.assign(this.state.bake, bake);
    this.state.oven = { tempC: targetC, targetC, on: false, doorOpen: false };
    this.game.advanceClock(12 + minutes);
    oven.reset();
    oven.setTemperature(targetC);
    oven.setTargetTemperature(targetC);
    kitchen.setOvenGlow(0);
    // el recipiente sigue (o vuelve) a su sitio en la encimera, con el pan dentro
    const box = dough.group.parent === tools.tin.anchors.inside ? tools.tin : tools.tray;
    if (box.object.parent !== tools.group) {
      tools.group.add(box.object);
      box.object.position.copy(SPOTS.tray);
      box.object.quaternion.identity();
    }
    dough.set({ bake: bake.crust, rise: this.state.proof2.rise * bake.spring });
    fitDough(dough);
  }
}
