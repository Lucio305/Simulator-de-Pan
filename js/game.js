// Orquestador del juego: estado de la partida, etapas, reloj simulado y entrada del jugador.
import { BREADS, STAGES } from './recipe.js';
import { CAMERAS } from './core/layout.js';
import { cancelAnimations, wait } from './core/anim.js';
import { IngredientsStage } from './stages/ingredients.js';
import { MixStage } from './stages/mix.js';
import { KneadStage } from './stages/knead.js';
import { ProofStage } from './stages/proof.js';
import { ShapeStage } from './stages/shape.js';
import { BakeStage } from './stages/bake.js';
import { ResultStage } from './stages/result.js';

const STAGE_CLASSES = {
  ingredients: IngredientsStage,
  mix: MixStage,
  knead: KneadStage,
  proof: ProofStage,
  shape: ShapeStage,
  bake: BakeStage,
  result: ResultStage,
};

const BEST_KEY = 'pan-casero-3d:mejores';
const ROOM_TEMP = 22;

/** Estado inicial de una partida. Lo leen las etapas y recipe.evaluate(). */
export function createInitialState(breadId, guided = true) {
  const bread = BREADS[breadId];
  return {
    breadId,
    guided,
    amounts: { flour: 0, water: 0, yeast: 0, salt: 0, sugar: 0, oil: 0 },
    mix: 0,
    knead: { gluten: 0, strokes: 0, extraFlour: 0, windowpane: false },
    proof1: { minutes: 0, tempC: ROOM_TEMP, p: 0, rise: 1, collapse: 0, spot: 'encimera' },
    shape: { shape: bread.shape, scores: 0, topping: 'none' },
    proof2: { minutes: 0, tempC: 24, p: 0, rise: 1, collapse: 0 },
    oven: { tempC: ROOM_TEMP, targetC: bread.bake?.tempC ?? 220, on: false, doorOpen: false },
    bake: {
      targetC: bread.bake?.tempC ?? 220, preheated: false, steam: false,
      minutes: 0, crust: 0, internalC: 24, spring: 1, doorOpenings: 0,
    },
    result: null,
    clockMinutes: 8 * 60 + 30, // la partida empieza a las 8:30 de la mañana
  };
}

export class Game {
  /**
   * @param {{engine: import('./engine.js').Engine, ui: any, audio: any, particles: any,
   *          models: {kitchen: any, oven: any, tools: any, ingredients: any, dough: any}}} deps
   */
  constructor({ engine, ui, audio, particles, models }) {
    this.engine = engine;
    this.ui = ui;
    this.audio = audio;
    this.particles = particles;
    this.models = models;
    this.state = createInitialState('hogaza');
    this.stage = null;
    this.stageIndex = -1;
    this._busy = false;
    this._runId = 0;

    engine.onUpdate((dt, elapsed) => this.update(dt, elapsed));
    engine.on('pointerdown', (ev) => this.stage?.onPointerDown(ev));
    engine.on('pointermove', (ev) => this.stage?.onPointerMove(ev));
    engine.on('pointerup', (ev) => this.stage?.onPointerUp(ev));

    ui.onSoundToggle?.(() => {
      const on = !this.audio.enabled;
      this.audio.unlock?.();
      this.audio.setEnabled(on);
      ui.setSound(on);
    });
    ui.onCameraToggle?.(() => {
      const on = !engine.controls.enabled;
      engine.setFreeCamera(on);
      ui.setFreeCamera(on);
      ui.toast(on ? 'Cámara libre: arrastra para girar, rueda para acercar.' : 'Cámara guiada', { tone: 'info' });
    });
    ui.onRestart?.(() => this.confirmRestart());
    ui.onHelp?.(() => this.showHelp());

    this.debug = {
      skipTo: (id) => this.skipTo(id),
      stageId: () => STAGES[this.stageIndex]?.id,
    };
  }

  get bread() { return BREADS[this.state.breadId]; }

  /** Pantalla de inicio con la cámara paseando por la cocina. */
  async start() {
    this.engine.moveCamera(CAMERAS.intro, { duration: 0 });
    this.engine.moveCamera(CAMERAS.overview, { duration: 6 });
    this.ui.setStages(STAGES);
    const config = await this.ui.showStart({
      breads: Object.values(BREADS).map((b) => ({
        id: b.id, name: b.name, description: b.description, difficulty: b.difficulty, timeLabel: b.timeLabel,
      })),
      best: this.loadBest(),
    });
    this.audio?.unlock?.();
    if (!this._ambience) this._ambience = this.audio?.loop?.('ambience', { volume: 0.5 });
    this.ui.setSound?.(this.audio?.enabled ?? false);
    await this.newRun(config.breadId, config.guided);
  }

  async newRun(breadId, guided = true) {
    this._runId++;
    this.state = createInitialState(breadId, guided);
    this.resetScene();
    this.ui.setStages(STAGES);
    await this.goTo(0);
  }

  /** Deja todos los modelos en su posición inicial. */
  resetScene() {
    const { kitchen, oven, tools, ingredients, dough } = this.models;
    cancelAnimations();
    for (const item of Object.values(ingredients.items)) item.reset();
    ingredients.bowlContents.reset();
    ingredients.bowlContents.setVisible(true);
    dough.reset();
    dough.group.visible = false;
    this.engine.scene.attach(dough.group);
    tools.bowl.object.visible = true;
    tools.scale.anchors.plate.attach(tools.bowl.object);
    tools.bowl.object.position.set(0, 0, 0);
    tools.bowl.object.rotation.set(0, 0, 0);
    tools.scale.setReading(0);
    tools.cloth.reset?.();
    tools.spoon.reset?.();
    tools.board.setFlour(0);
    tools.tray.show();
    tools.tray.setParchment(false);
    tools.tin.hide();
    tools.coolingRack.hide();
    tools.lame.reset?.();
    tools.breadKnife.reset?.();
    oven.reset?.();
    oven.setLight(false);
    oven.setHeat(0);
    oven.setSteam(0);
    oven.setTemperature(this.state.oven.tempC);
    oven.setTargetTemperature(this.state.oven.targetC);
    oven.setTimer(null);
    oven.setStatus('off');
    kitchen.setOvenGlow(0);
    kitchen.setClock(this.state.clockMinutes);
  }

  /** Cambia de etapa (sale de la actual, entra en la nueva). */
  async goTo(index) {
    if (this._busy || index < 0 || index >= STAGES.length) return;
    this._busy = true;
    this.ui.setBusy(true);
    const runId = this._runId;
    try {
      if (this.stage) await this.stage.exit();
      if (runId !== this._runId) return;
      this.stageIndex = index;
      this.ui.setStage(index);
      this.ui.setRecipe(null);
      this.ui.setMeters(null);
      this.ui.setClock(null);
      this.ui.setControls(null);
      this.stage = new STAGE_CLASSES[STAGES[index].id](this);
      this._busy = false;
      this.ui.setBusy(false);
      await this.stage.enter();
    } catch (e) {
      console.error(e);
      this.ui.toast('Algo ha fallado en esta etapa. Prueba a reiniciar.', { tone: 'bad' });
    } finally {
      this._busy = false;
      this.ui.setBusy(false);
    }
  }

  next() { return this.goTo(this.stageIndex + 1); }

  update(dt, elapsed) {
    const m = this.models;
    this.stage?.update(dt);
    for (const key of ['kitchen', 'oven', 'tools', 'ingredients', 'dough']) {
      try { m[key]?.update(dt, elapsed); } catch (e) { console.error(e); }
    }
    this.particles?.update(dt);
    // El reloj de pared avanza despacio en tiempo real (1 min cada 6 s) y a saltos en las cámaras rápidas.
    this.advanceClock(dt / 6);
  }

  /** Avanza el reloj simulado de la cocina. */
  advanceClock(minutes) {
    this.state.clockMinutes = (this.state.clockMinutes + minutes) % (24 * 60);
    this.models.kitchen.setClock(this.state.clockMinutes);
  }

  async confirmRestart() {
    const choice = await this.ui.showDialog({
      title: '¿Empezar de nuevo?',
      body: 'Perderás el pan que estás preparando.',
      actions: [
        { label: 'Seguir con este pan', variant: 'secondary', value: 'stay' },
        { label: 'Empezar de nuevo', variant: 'primary', value: 'restart' },
      ],
    });
    if (choice === 'restart') this.restart();
  }

  async restart() {
    this._runId++;
    try { await this.stage?.exit(); } catch (e) { console.error(e); }
    this.stage = null;
    this.stageIndex = -1;
    this.ui.hideResult?.();
    this.ui.setInstruction(null);
    this.ui.setRecipe(null);
    this.ui.setMeters(null);
    this.ui.setClock(null);
    this.ui.setControls(null);
    this.resetScene();
    await this.start();
  }

  showHelp() {
    this.ui.showDialog({
      title: 'Cómo se juega',
      body: [
        'Sigue los pasos de arriba: pesar, mezclar, amasar, fermentar, formar, hornear y probar.',
        'Ingredientes: mantén pulsado un recipiente (o el botón «Verter») y suelta cuando la báscula marque la cantidad.',
        'Mezclar: dibuja círculos con el ratón o el dedo sobre el bol.',
        'Amasar: arrastra la masa para estirarla y suelta para plegarla. Si se pega, enharina.',
        'Fermentar y hornear: el tiempo corre deprisa. Tú decides cuándo está lista la masa y cuándo sacar el pan.',
        'Cámara libre (icono de la cámara): arrastra para girar y usa la rueda para acercarte.',
      ].join('\n\n'),
      actions: [{ label: 'Entendido', variant: 'primary', value: 'ok' }],
    });
  }

  loadBest() {
    try { return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') || {}; } catch { return {}; }
  }

  /** Guarda la mejor puntuación de este pan. Devuelve true si es un récord nuevo. */
  saveBest(breadId, total) {
    const best = this.loadBest();
    const isBest = !(best[breadId] >= total);
    if (isBest) {
      best[breadId] = Math.round(total);
      try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch { /* sin almacenamiento */ }
    }
    return isBest;
  }

  /**
   * Salta a una etapa completando las anteriores con un buen resultado (pruebas automáticas).
   * @param {string} id id de la etapa de STAGES
   */
  async skipTo(id, { breadId = this.state.breadId, guided = true } = {}) {
    const target = STAGES.findIndex((s) => s.id === id);
    if (target < 0) throw new Error(`Etapa desconocida: ${id}`);
    this._runId++;
    try { await this.stage?.exit(); } catch (e) { console.error(e); }
    this.stage = null;
    this.stageIndex = -1;
    this.ui.hideStart?.();
    this.ui.hideResult?.();
    this.state = createInitialState(breadId, guided);
    this.resetScene();
    this.ui.setStages(STAGES);
    for (let i = 0; i < target; i++) {
      const s = new STAGE_CLASSES[STAGES[i].id](this);
      await s.autoComplete();
      s.dispose();
    }
    await wait(0.05);
    await this.goTo(target);
  }
}
