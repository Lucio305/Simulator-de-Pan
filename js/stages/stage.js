// Clase base de las etapas del juego. Cada etapa dirige cámara, modelos e interfaz mientras está activa.
import * as THREE from 'three';
import { arcMove } from '../core/anim.js';

/** Velocidades de cámara rápida (minutos simulados por segundo real). */
export const TIME_SPEEDS = { pause: 0, normal: 5, fast: 15 };

export class Stage {
  /** @param {import('../game.js').Game} game */
  constructor(game) {
    this.game = game;
    this._disposers = [];
    this.done = false;
  }

  get engine() { return this.game.engine; }
  get ui() { return this.game.ui; }
  get audio() { return this.game.audio; }
  get particles() { return this.game.particles; }
  get models() { return this.game.models; }
  get state() { return this.game.state; }
  get bread() { return this.game.bread; }
  get guided() { return this.game.state.guided; }

  /** Prepara cámara, modelos e interfaz. */
  async enter() {}
  /** @param {number} dt segundos reales */
  update(dt) {} // eslint-disable-line no-unused-vars
  onPointerDown(ev) {} // eslint-disable-line no-unused-vars
  onPointerMove(ev) {} // eslint-disable-line no-unused-vars
  onPointerUp(ev) {} // eslint-disable-line no-unused-vars
  /** Limpia escuchas, sonidos en bucle y controles. */
  async exit() { this.dispose(); }

  /**
   * Completa la etapa al instante con un buen resultado (pruebas y depuración) y deja la escena
   * como la espera la etapa siguiente. Se llama en lugar de enter()/exit().
   */
  async autoComplete() {}

  /** Registra una función de limpieza que se ejecutará al salir de la etapa. */
  track(disposer) { if (disposer) this._disposers.push(disposer); return disposer; }

  dispose() {
    for (const d of this._disposers.splice(0)) {
      try { typeof d === 'function' ? d() : d?.stop?.(0.2); } catch (e) { console.error(e); }
    }
    this.ui.hideHint?.();
    this.engine.setCursor('');
  }

  /** Instrucción principal; el consejo solo aparece en modo guiado. */
  instruct(title, text, tip) {
    this.ui.setInstruction({ title, text, tip: this.guided ? tip : undefined });
  }

  /** Banda ideal de un medidor (solo en modo guiado). */
  ideal(range) { return this.guided ? range : null; }

  camera(view, opts) { return this.engine.moveCamera(view, opts); }

  /** Avanza a la etapa siguiente (una sola vez). */
  complete() {
    if (this.done) return;
    this.done = true;
    this.game.next();
  }

  /** Bucle de sonido que se detiene solo al salir de la etapa. */
  loop(name, opts) {
    const h = this.audio?.loop?.(name, opts);
    if (h) this.track(() => h.stop(0.3));
    return h;
  }

  /** Control segmentado estándar para la cámara rápida. */
  speedControl(value, onChange, id = 'speed') {
    return {
      type: 'choice', id, label: 'Velocidad', value,
      options: [
        { value: 'pause', label: 'Pausa' },
        { value: 'normal', label: 'Normal' },
        { value: 'fast', label: 'Rápido' },
      ],
      onChange,
    };
  }

  /** Posición de mundo de un ancla u objeto. */
  worldPos(obj, out = new THREE.Vector3()) { return obj.getWorldPosition(out); }

  /**
   * Mueve la masa (u otro objeto) en arco hasta `anchor` y la cuelga de él, conservando
   * la transformación de mundo durante el viaje.
   */
  async moveTo(object, anchor, { height = 0.18, duration = 1.0, offset } = {}) {
    this.engine.scene.attach(object);
    const target = this.worldPos(anchor);
    if (offset) target.add(offset);
    await arcMove(object, target, { height, duration, rotateTo: { x: 0, z: 0 } });
    anchor.attach(object);
    object.position.set(offset?.x ?? 0, offset?.y ?? 0, offset?.z ?? 0);
    object.rotation.set(0, object.rotation.y, 0);
  }

  /** Coloca un objeto en un ancla sin animación. */
  placeAt(object, anchor) {
    anchor.add(object);
    object.position.set(0, 0, 0);
    object.rotation.set(0, 0, 0);
  }
}
