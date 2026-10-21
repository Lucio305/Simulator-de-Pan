// Etapa 7 · Resultado: el pan sale a la rejilla, se puntúa y se puede cortar para ver la miga.
import * as THREE from 'three';
import { Stage } from './stage.js';
import { evaluate } from '../recipe.js';
import { animate, ease, wait, cancelAnimations } from '../core/anim.js';
import { lerp, formatMinutes } from '../core/utils.js';
import { frameView, isPhone, fitDough } from './bake.js';

const TAG = 'result-stage';
const TAU = Math.PI * 2;
const START_CLOCK = 8 * 60 + 30; // la partida empieza a las 8:30 (game.js, createInitialState)
const SPIN = 0.32;                // rad/s del giro lento del pan en la rejilla
const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Describe la miga en una frase a partir de recipe.crumbFromState().
 * @param {{openness:number, density:number, gumminess:number, tunnels:number}} c
 * @param {string} breadId
 */
export function crumbText(c, breadId) {
  if (!c) return 'Una miga muy apetecible.';
  if (c.gumminess > 0.5) return 'Miga húmeda y gomosa: le faltó horno para cuajar por dentro.';
  if (c.density > 0.85 && c.openness < 0.2) return 'Miga muy densa y compacta: a la masa le faltó subir.';
  if (c.tunnels > 0.5) return 'Miga con túneles grandes e irregulares: la masa fermentó de más.';
  if (c.density > 0.68) return 'Miga apretada y algo densa: le faltó fermentación o fuerza.';
  if (breadId === 'molde') {
    return c.openness < 0.5 ? 'Miga fina, tierna y esponjosa: perfecta para tostadas.' : 'Miga esponjosa, con algún alveolo grande.';
  }
  if (c.openness > 0.5) return 'Miga abierta, con alveolos grandes y brillantes. ¡De panadería!';
  if (c.openness > 0.3) return 'Miga regular y esponjosa, con alveolos medianos.';
  return 'Miga cerrada y uniforme: con más agua o más amasado se habría abierto.';
}

/** "13:05" a partir de minutos del día. */
const clockText = (min) => {
  const m = Math.round(min) % (24 * 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
};

export class ResultStage extends Stage {
  constructor(game) {
    super(game);
    this.exited = false;
    this.busy = true;          // coreografía o corte en marcha
    this.cut = false;
    this.panelOpen = false;
    this.spin = true;
    this.view = 'intro';
    this.hovering = false;
    this.hoverNdc = null;
    this.hoverT = 0;
    this.vapor = null;
    this.vaporT = 0;
    this.crumbMsg = '';
  }

  async enter() {
    const { kitchen, oven, dough } = this.models;
    const s = this.state;
    kitchen.setOvenGlow?.(0);
    oven.setHighlight?.(null);
    oven.setSteam?.(0);
    fitDough(dough);

    // Nota final (una sola vez) y récord
    s.result = evaluate(s);
    const r = s.result;
    const prev = this.game.loadBest()[s.breadId];
    const isBest = this.game.saveBest(s.breadId, r.total);
    const hadPrev = Number.isFinite(prev);
    this.best = isBest && (hadPrev || r.total >= 50) ? true : hadPrev ? prev : null;

    const crust = s.bake?.crust || 0;
    this.instruct('¡Pan horneado!', crust >= 0.5 && crust < 1.15
      ? 'Lo pasamos a la rejilla para que se enfríe: escucha cómo cruje la corteza.'
      : 'Lo pasamos a la rejilla para que se enfríe. Vamos a ver la nota…');
    const total = (s.clockMinutes - START_CLOCK + 24 * 60) % (24 * 60);
    this.ui.setClock({ label: 'Pan listo', text: clockText(s.clockMinutes), sub: `${formatMinutes(total)} de principio a fin` });
    this.goView('intro', 1.3);
    const onResize = () => this.goView(this.view, 0.3);
    window.addEventListener('resize', onResize);
    this.track(() => window.removeEventListener('resize', onResize));

    await this.toRack();
    if (this.exited) return;
    this.busy = false;
    await this.celebrate();
    if (this.exited) return;
    this.openScore();
  }

  async exit() {
    this.exited = true;
    cancelAnimations(TAG);
    const { dough, tools } = this.models;
    this.vapor?.stop();
    this.vapor = null;
    dough.setHighlight(false);
    dough.group.rotation.set(0, 0, 0);
    dough.group.scale.set(1, 1, 1);
    tools.coolingRack.object.scale.setScalar(1);
    tools.breadKnife.reset?.();
    super.exit();
  }

  // ---------------------------------------------------------------------------
  // Cámara
  // ---------------------------------------------------------------------------

  /** Centro del pan en el mundo y su tamaño. */
  breadInfo() {
    const { dough, tools } = this.models;
    const size = dough.getSize();
    const base = tools.coolingRack.anchors.top.getWorldPosition(new THREE.Vector3());
    const span = Math.max(size.x * dough.group.scale.x, size.z, 0.2);
    return { center: base.add(V(0, size.y * 0.5, 0)), size, span };
  }

  viewFor(name) {
    const phone = isPhone();
    const { center, span, size } = this.breadInfo();
    if (name === 'panel' || name === 'intro') {
      // con la tarjeta de resultado abierta: el pan a la izquierda (escritorio) o arriba (móvil)
      const ndc = name === 'intro' ? (phone ? [0, 0.4] : [0, 0.12]) : (phone ? [0, 0.56] : [-0.15, 0.04]);
      return frameView(this.engine, center, { dir: V(0.12, 0.62, 1), dist: phone ? 0.5 + 2.2 * span : 0.42 + 1.55 * span, ndc });
    }
    if (name === 'cut') {
      // tres cuartos: se ve bien el serrucho del cuchillo
      return frameView(this.engine, center.clone().add(V(0, 0.03, 0)), { dir: V(0.8, 0.62, 0.85), dist: phone ? 0.45 + 2.1 * span : 0.4 + 1.45 * span, ndc: phone ? [0, 0.38] : [0, 0.1] });
    }
    if (name === 'crumb') {
      // de frente a las dos caras del corte, abiertas como un libro (lo importante es la miga, no las puntas)
      const face = Math.max(size.z, size.y, 0.12);
      return frameView(this.engine, center, { dir: V(0, 0.5, 1), dist: phone ? 0.36 + 2.0 * face : 0.32 + 1.5 * face, ndc: phone ? [0, 0.38] : [0, 0.12] });
    }
    // 'free': sin tarjeta, con el dock abajo
    return frameView(this.engine, center, { dir: V(0.12, 0.62, 1), dist: phone ? 0.5 + 2.2 * span : 0.42 + 1.55 * span, ndc: phone ? [0, 0.38] : [0, 0.12] });
  }

  goView(name, duration = 1.1) {
    this.view = name;
    if (this.exited) return Promise.resolve(false);
    return this.camera(this.viewFor(name), { duration });
  }

  // ---------------------------------------------------------------------------
  // Coreografía: de la bandeja (o el molde) a la rejilla
  // ---------------------------------------------------------------------------

  async toRack() {
    const { tools, dough } = this.models;
    const g = dough.group;
    const rack = tools.coolingRack;
    const box = g.parent === tools.tin.anchors.inside ? tools.tin : tools.tray;
    const isTin = box === tools.tin;
    if (g.parent === rack.anchors.top) { rack.show(); box.hide(); this.startVapor(); return; }
    this.engine.scene.attach(g);
    const p0 = g.position.clone();
    const up = p0.clone().add(V(0, isTin ? 0.15 : 0.11, 0));
    await wait(0.5);
    if (this.exited) return;
    this.audio?.play('whoosh', { volume: 0.4 });
    await animate({ duration: 0.6, ease: ease.outCubic, tag: TAG, onUpdate: (t) => g.position.lerpVectors(p0, up, t) });
    if (this.exited) return;
    // el pan sale del molde conservando su forma; la bandeja se retira y aparece la rejilla
    if (isTin) dough.set({ inTin: false });
    box.hide();
    rack.show();
    this.audio?.play('click', { volume: 0.6 });
    animate({ duration: 0.4, ease: ease.outBack, tag: TAG, onUpdate: (t) => rack.object.scale.setScalar(0.8 + 0.2 * t) })
      .then(() => rack.object.scale.setScalar(1));
    const dst = rack.anchors.top.getWorldPosition(new THREE.Vector3());
    await animate({ duration: 0.55, ease: ease.inQuad, tag: TAG, onUpdate: (t) => g.position.lerpVectors(up, dst, t) });
    if (this.exited) return;
    rack.anchors.top.attach(g);
    g.position.set(0, 0, 0);
    g.rotation.set(0, g.rotation.y, 0);
    this.audio?.play('crunch');
    this.particles?.crumbs(this.topWorld(-0.01), { count: 16, color: this.crustColor(), floorY: dst.y });
    this.startVapor();
  }

  /** Color aproximado de la corteza para las migas que saltan. */
  crustColor() {
    const c = this.state.bake.crust || 0;
    return c > 1.1 ? 0x2b1a10 : c > 0.88 ? 0x7a4421 : c > 0.5 ? 0xb5743a : 0xd9b27a;
  }

  topWorld(dy = 0.01) {
    const { dough } = this.models;
    return dough.group.localToWorld(new THREE.Vector3(0, dough.getTopY() + dy, 0));
  }

  /** Vapor del pan caliente (o humo si se quemó) que se va apagando. */
  startVapor() {
    const burnt = (this.state.bake.crust || 0) >= 1.15;
    this.vapor?.stop();
    this.vapor = burnt
      ? this.particles?.smoke(this.topWorld(), { rate: 9, spread: 0.06, rise: 0.18, size: 0.06 })
      : this.particles?.steam(this.topWorld(), { rate: 12, spread: 0.06, rise: 0.24, size: 0.05 });
    this.vaporT = 0;
  }

  /** Destellos y sonido según la nota. */
  async celebrate() {
    const total = this.state.result.total;
    if (total >= 75) {
      this.audio?.play('success');
      for (let i = 0; i < 3; i++) {
        const p = this.topWorld(0.02).add(V((i - 1) * 0.08, 0, 0));
        this.particles?.sparkle(p, { count: 28, spread: 0.09 });
        await wait(0.22);
        if (this.exited) return;
      }
    } else if (total < 35) {
      this.audio?.play('fail', { volume: 0.55 });
      await wait(0.4);
    } else {
      this.audio?.play('ding', { volume: 0.7 });
      this.particles?.sparkle(this.topWorld(0.02), { count: 16, spread: 0.08 });
      await wait(0.4);
    }
  }

  // ---------------------------------------------------------------------------
  // Tarjeta de resultado y dock
  // ---------------------------------------------------------------------------

  async openScore() {
    if (this.exited || this.panelOpen || this.busy) return;
    this.panelOpen = true;
    this.setHover(false);
    this.ui.setControls(null);
    this.goView('panel', 1.0);
    const choice = await this.ui.showResult({ ...this.state.result, best: this.best, canCut: !this.cut });
    this.panelOpen = false;
    if (this.exited) return;
    if (choice === 'cut') this.cutBread();
    else if (choice === 'again') this.game.restart();
    else this.showDock();
  }

  showDock() {
    if (this.exited) return;
    const r = this.state.result;
    this.goView(this.cut ? 'crumb' : 'free', 1.0);
    this.ui.setControls([
      { type: 'button', id: 'score', label: 'Ver puntuación', icon: 'check', variant: this.cut ? 'primary' : 'secondary', onClick: () => this.openScore() },
      { type: 'button', id: 'cut', label: 'Cortar el pan', icon: 'knife', variant: 'primary', hidden: this.cut, onClick: () => this.cutBread() },
      { type: 'button', id: 'again', label: 'Hornear otro pan', icon: 'restart', variant: 'secondary', onClick: () => this.game.restart() },
    ]);
    if (this.cut) {
      this.instruct('Así es tu miga', `${this.crumbMsg} Nota final: ${r.total}/100.`);
    } else {
      this.instruct(`${r.breadName}: ${r.total}/100`, `${r.title}. Córtalo para ver la miga o hornea otro pan.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Corte: cuchillo de sierra, las mitades se abren como un libro
  // ---------------------------------------------------------------------------

  async cutBread() {
    if (this.cut || this.busy || this.exited || this.panelOpen) return;
    const { dough, tools } = this.models;
    const g = dough.group;
    this.busy = true;
    this.spin = false;
    this.setHover(false);
    this.ui.setControls(null);
    this.instruct('Cortando el pan…', 'Sierra suave, sin aplastar: escucha cómo cruje la corteza.');
    // el pan gira hasta quedar de frente (el corte abre las caras hacia la cámara)
    const y0 = g.rotation.y;
    let y1 = y0 - (((y0 % TAU) + TAU) % TAU);
    if (y0 - y1 > Math.PI) y1 += TAU;
    this.goView('cut', 1.1);
    await animate({ duration: 0.9, ease: ease.inOutCubic, tag: TAG, onUpdate: (t) => { g.rotation.y = lerp(y0, y1, t); } });
    if (this.exited) return;
    g.rotation.y = 0;
    const size = dough.getSize();
    await tools.breadKnife.slice(this.topWorld(0), size.y + 0.003, -Math.PI / 2);
    if (this.exited) return;
    // las mitades se separan
    const crumb = this.state.result.crumb;
    const hot = (this.state.bake.internalC || 0) > 80 && (this.state.bake.crust || 0) < 1.15;
    dough.setCut(0.001, crumb);
    this.audio?.play('crunch');
    this.particles?.crumbs(this.topWorld(-0.02), { count: 26, color: this.crustColor(), floorY: tools.coolingRack.anchors.top.getWorldPosition(new THREE.Vector3()).y });
    tools.breadKnife.goHome();
    this.goView('crumb', 1.4);
    await animate({ duration: 1.3, ease: ease.outCubic, tag: TAG, onUpdate: (t) => dough.setCut(Math.max(0.001, t)) });
    if (this.exited) return;
    if (hot) this.particles?.puff(this.topWorld(-0.03), { color: 0xffffff, count: 26, spread: 0.06, size: 0.04, life: 1.6, rise: 0.22 });
    this.cut = true;
    this.busy = false;
    const goodCrumb = crumb && crumb.gumminess <= 0.5 && crumb.tunnels <= 0.5 && crumb.density <= 0.68;
    const burnt = (this.state.bake.crust || 0) >= 1.2;
    let text = crumbText(crumb, this.state.breadId);
    if (burnt) {
      const first = text.split('. ')[0].replace(/\.$/, '');
      text = `Corteza quemada ${goodCrumb ? 'pero' : 'y'} ${first.charAt(0).toLowerCase()}${first.slice(1)}.`;
    }
    const good = goodCrumb && !burnt;
    this.crumbMsg = text;
    if (good) {
      this.audio?.play('success', { volume: 0.6 });
      this.particles?.sparkle(this.topWorld(0.02), { count: 22, spread: 0.1 });
    }
    this.ui.toast(text, { tone: good ? 'good' : 'warn', duration: 3.6 });
    this.showDock();
  }

  // ---------------------------------------------------------------------------
  // Bucle y puntero
  // ---------------------------------------------------------------------------

  update(dt) {
    if (this.exited) return;
    try {
      const { dough } = this.models;
      // giro lento de escaparate mientras no se ha cortado
      if (this.spin && !this.cut && !this.busy) dough.group.rotation.y += dt * SPIN;
      // el vapor se va apagando según se enfría
      if (this.vapor) {
        this.vaporT += dt;
        const k = Math.max(0, 1 - this.vaporT / 14);
        this.vapor.setRate?.(12 * k);
        this.vapor.setPosition?.(this.topWorld());
        if (k <= 0) { this.vapor.stop(); this.vapor = null; }
      }
      this.hoverT -= dt;
      if (this.hoverNdc && this.hoverT <= 0) {
        this.hoverT = 0.06;
        const ndc = this.hoverNdc;
        this.hoverNdc = null;
        this.setHover(this.canPoke() && this.hitBread(ndc));
      }
    } catch (e) {
      if (!this._failed) { this._failed = true; console.error('[result]', e); }
    }
  }

  canPoke() { return !this.busy && !this.panelOpen && !this.exited; }

  hitBread(ndc) {
    const { dough } = this.models;
    return this.engine.raycast(ndc, dough.group).some((h) => h.object.visible && h.object.userData.dough);
  }

  setHover(on) {
    const { dough } = this.models;
    if (on !== this.hovering) {
      this.hovering = on;
      dough.setHighlight(on && !this.cut);
    }
    if (on) {
      const text = this.cut ? this.crumbMsg : 'Cortar el pan';
      this.ui.showHint(text, this.engine.worldToScreen(this.topWorld(0.03)));
      this.engine.setCursor(this.cut ? '' : 'pointer');
    } else {
      this.ui.hideHint();
      this.engine.setCursor('');
    }
  }

  onPointerMove(ev) {
    if (ev.pointerType === 'mouse') this.hoverNdc = ev.ndc.clone();
  }

  onPointerDown(ev) {
    if (!this.canPoke() || ev.button > 0 || this.cut) return;
    if (this.hitBread(ev.ndc)) this.cutBread();
  }

  /** Última etapa: deja el pan en la rejilla con la nota calculada (sin animaciones). */
  async autoComplete() {
    const { tools, dough } = this.models;
    tools.tray.hide();
    tools.tin.hide();
    tools.coolingRack.show();
    tools.coolingRack.anchors.top.attach(dough.group);
    dough.group.position.set(0, 0, 0);
    dough.group.rotation.set(0, 0, 0);
    dough.set({ inTin: false });
    this.state.result = evaluate(this.state);
  }
}
