// Etapa 2 · Mezclar: remover en el bol hasta que los ingredientes formen una masa.
import * as THREE from 'three';
import { Stage } from './stage.js';
import { animate, ease } from '../core/anim.js';
import { clamp, lerp, smoothstep, damp, makeCanvasTexture } from '../core/utils.js';
import { SIZES } from '../core/layout.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const TAU = Math.PI * 2;
const TURNS = 8;          // vueltas completas para mezclarlo todo
const AUTO_TURNS = 1.2;   // vueltas por segundo con «Remover»
const MAX_TURNS = 3;      // velocidad máxima que cuenta (vueltas por segundo)
const MORPH_AT = 0.5;     // a mitad de mezcla los grumos se juntan en una bola

/**
 * Vistas del bol: algo cenital para que los círculos en pantalla sean círculos en el bol.
 * Escritorio: el bol en el centro de la zona libre. Móvil en vertical: en la mitad de arriba.
 */
const VIEWS = {
  wide: { position: V(-0.32, 1.58, 0.63), target: V(-0.32, 0.985, 0.1) },
  tall: { position: V(-0.32, 1.68, 0.6), target: V(-0.32, 1.026, 0.175) },
};

/** Ángulo en (-π, π]. */
const wrap = (a) => a - TAU * Math.round(a / TAU);

/** Guía de dos flechas circulares (textura) que gira sobre el bol hasta que empiezas a remover. */
function makeRingGuide() {
  const tex = makeCanvasTexture(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    // espejo: las flechas giran en sentido antihorario visto desde arriba, como «Remover»
    g.translate(w, 0);
    g.scale(-1, 1);
    const cx = w / 2, cy = h / 2, r = w * 0.4;
    for (const a0 of [0.25, 0.25 + Math.PI]) {
      const a1 = a0 + 2.3;
      g.lineCap = 'round';
      // contorno oscuro suave y trazo crema encima
      for (const [color, width] of [['rgba(40,24,12,0.45)', 17], ['#fff6e2', 9]]) {
        g.strokeStyle = color;
        g.fillStyle = color;
        g.lineWidth = width;
        g.beginPath();
        g.arc(cx, cy, r, a0, a1);
        g.stroke();
        // punta de flecha al final del arco
        const ex = cx + Math.cos(a1) * r, ey = cy + Math.sin(a1) * r;
        const tx = -Math.sin(a1), ty = Math.cos(a1);
        const nx = Math.cos(a1), ny = Math.sin(a1);
        const s = width === 9 ? 15 : 20;
        g.beginPath();
        g.moveTo(ex + tx * s * 1.1, ey + ty * s * 1.1);
        g.lineTo(ex + nx * s * 0.8 - tx * s * 0.3, ey + ny * s * 0.8 - ty * s * 0.3);
        g.lineTo(ex - nx * s * 0.8 - tx * s * 0.3, ey - ny * s * 0.8 - ty * s * 0.3);
        g.closePath();
        g.fill();
      }
    }
  });
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 0.25).rotateX(-Math.PI / 2), mat);
  mesh.name = 'mix-guide';
  mesh.renderOrder = 8;
  mesh.raycast = () => {};
  mesh.position.y = 0.012;
  return {
    mesh,
    dispose() { mesh.removeFromParent(); mesh.geometry.dispose(); mat.dispose(); tex.dispose(); },
  };
}

export class MixStage extends Stage {
  constructor(game) {
    super(game);
    this.mix = 0;
    this.dragId = null;
    this.lastAngle = null;
    this.pending = 0;          // giro acumulado por el puntero desde el último frame (rad)
    this.auto = false;         // «Remover» mantenido (botón o espacio)
    this.autoSource = null;
    this.spoonAngle = Math.PI / 4;
    this.spoonGoal = Math.PI / 4;
    this.omega = 0;            // velocidad de giro suavizada (rad/s)
    this.idle = 0;             // segundos sin remover (para volver a mostrar la guía)
    this.puffTimer = 0.4;
    this.dentTimer = 0.5;
    this.morphed = false;
    this.morphing = null;      // promesa de la transformación en curso
    this.bounce = null;        // saltito final de la masa
    this.mixed = false;
    this.leaving = false;
    this.hovering = false;
    this.lastPct = -1;
    this.center = new THREE.Vector3();
    this.tmp = new THREE.Vector3();
    this.guide = null;
    this.stirLoop = null;
    this.ctl = null;
  }

  view() { return this.engine.camera.aspect < 0.8 ? VIEWS.tall : VIEWS.wide; }

  async enter() {
    const { dough, tools, ingredients } = this.models;
    this.mix = clamp(this.state.mix || 0);
    // la masa nace dentro del bol, pequeña y escondida entre la harina
    this.placeAt(dough.group, tools.bowl.anchors.contents);
    dough.set({ shape: 'shaggy', mix: this.mix, smoothness: 0, hydration: this.hydration, flour: 0.6, rise: 1, collapse: 0, squash: 0, stretch: 0, bake: 0 });
    dough.group.visible = true;
    ingredients.bowlContents.setVisible(true);
    this.applyMix();

    tools.spoon.setStirring(true);
    tools.spoon.setStirAngle(this.spoonAngle, 0.7);
    this.stirLoop = this.loop('stir', { volume: 0.9 });
    this.stirLoop?.setIntensity(0);

    this.guide = makeRingGuide();
    tools.bowl.anchors.rim.add(this.guide.mesh);
    this.track(() => this.guide?.dispose());

    this.camera(this.view(), { duration: 1.4 });
    this.instruct('Mezcla los ingredientes',
      'Dibuja círculos sobre el bol con el ratón o el dedo (o mantén pulsado «Remover») hasta que no quede harina seca.',
      this.hydrationTip());
    this.ctl = this.ui.setControls([
      { type: 'hold', id: 'stir', label: 'Remover', icon: 'hand', value: this.mix, onStart: () => this.setAuto(true, 'hold'), onEnd: () => this.setAuto(false, 'hold') },
      { type: 'button', id: 'next', label: 'Llevar a la mesa de amasar', variant: 'primary', icon: 'play', disabled: true, onClick: () => this.goNext() },
    ]);
    this.refreshMeters(true);

    const down = (e) => this.onKey(e, true), up = (e) => this.onKey(e, false);
    const blur = () => { this.setAuto(false, 'key'); this.endDrag(); };
    const leave = () => { if (this.dragId == null) this.setHover(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.engine.canvas.addEventListener('pointerleave', leave);
    this.track(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      this.engine.canvas.removeEventListener('pointerleave', leave);
    });
    if (this.mix >= 1) this.finish();
  }

  // ---------------------------------------------------------------------------------------------
  // Textos y medidores
  // ---------------------------------------------------------------------------------------------

  breadName() {
    return { hogaza: 'la hogaza', baguette: 'la baguette', molde: 'el pan de molde' }[this.state.breadId] ?? 'este pan';
  }

  /** Consejo según la hidratación pesada frente a la ideal del pan. */
  hydrationTip() {
    const h = this.hydration, [lo, hi] = this.bread.hydrationIdeal;
    const pct = Math.round(h * 100), range = `${Math.round(lo * 100)}–${Math.round(hi * 100)} %`;
    if (h > hi + 0.004) return `Hidratación del ${pct} % (${this.breadName()} pide ${range}): saldrá pegajosa. Al amasar tendrás que enharinar más la tabla.`;
    if (h < lo - 0.004) return `Hidratación del ${pct} % (${this.breadName()} pide ${range}): saldrá seca y costará más amasarla.`;
    return `Hidratación del ${pct} %: justo lo que pide ${this.breadName()}. ${this.bread.tips?.mix ?? ''}`.trim();
  }

  refreshMeters(force = false) {
    const pct = Math.floor(this.mix * 100 + 1e-6);
    if (!force && pct === this.lastPct) return;
    this.lastPct = pct;
    const h = this.hydration, [lo, hi] = this.bread.hydrationIdeal;
    const toH = (v) => clamp((v - 0.5) / 0.4);
    const okH = h >= lo - 0.004 && h <= hi + 0.004;
    this.ui.setMeters([
      { id: 'mix', label: 'Mezcla', value01: this.mix, text: `${pct} %`, ideal: null, tone: this.mix >= 1 ? 'good' : 'neutral' },
      { id: 'hydration', label: 'Hidratación', value01: toH(h), text: `${Math.round(h * 100)} %`, ideal: this.ideal([toH(lo), toH(hi)]), tone: !this.guided ? 'neutral' : okH ? 'good' : 'warn' },
    ]);
    this.ctl?.get('stir').set({ value: this.mix });
  }

  // ---------------------------------------------------------------------------------------------
  // Mezcla
  // ---------------------------------------------------------------------------------------------

  /** Aplica la mezcla a la masa (crece y se cohesiona) y a los ingredientes sueltos (se funden). */
  applyMix() {
    const { dough, ingredients } = this.models;
    const m = this.mix;
    this.state.mix = m;
    ingredients.bowlContents.setMix(m);
    if (this.mixed) return;
    dough.group.scale.setScalar(lerp(0.35, 1, 1 - Math.pow(1 - m, 1.6)));
    dough.set({ mix: m, flour: lerp(0.6, 0.25, m), smoothness: 0.1 * smoothstep(0.5, 1, m), hydration: this.hydration });
  }

  setAuto(on, source) {
    if (on) {
      if (this.mixed || this.leaving) return;
      this.auto = true;
      this.autoSource = source;
    } else if (this.autoSource === source) {
      this.auto = false;
      this.autoSource = null;
    }
  }

  update(dt) {
    if (this.leaving || !this.guide) return;
    const { tools, dough } = this.models;
    let d = this.pending;
    this.pending = 0;
    if (this.auto && this.dragId == null && !this.mixed) {
      d = AUTO_TURNS * TAU * dt;
      this.spoonGoal += d;
    }
    // la cuchara sigue al puntero (suavizado) y sube a medida que la masa crece
    this.spoonAngle += wrap(this.spoonGoal - this.spoonAngle) * (1 - Math.exp(-16 * dt));
    if (!this.mixed) tools.spoon.setStirAngle(this.spoonAngle, lerp(0.75, 0.35, this.mix) + 0.12 * Math.sin(this.spoonAngle * 2));

    const speed = dt > 0 ? Math.abs(d) / dt : 0;
    this.omega = damp(this.omega, speed, 8, dt);
    this.stirLoop?.setIntensity(this.mixed ? 0 : clamp(this.omega / (TAU * 1.4)));

    if (!this.mixed && d !== 0) {
      const counted = Math.min(Math.abs(d), MAX_TURNS * TAU * dt);
      this.mix = Math.min(1, this.mix + counted / (TAU * TURNS));
      // la masa gira un poco con la cuchara
      dough.group.rotation.y += d * 0.22;
      this.idle = 0;
      this.stirJuice(dt);
      this.applyMix();
      this.refreshMeters();
      if (!this.morphed && this.mix >= MORPH_AT) this.startMorph();
      if (this.mix >= 1) this.finish();
    } else this.idle += dt;

    // guía: visible al principio y si te quedas quieto un rato
    const g = this.guide.mesh;
    const want = !this.mixed && this.dragId == null && !this.auto && (this.mix < 0.02 || this.idle > 3) ? 1 : 0;
    g.material.opacity = damp(g.material.opacity, want * (0.75 + 0.2 * Math.sin(this.engine.elapsed * 4)), 6, dt);
    g.visible = g.material.opacity > 0.01;
    g.rotation.y += dt * 1.6;
  }

  /** Nubecillas de harina al principio y la masa que cede al paso de la cuchara. */
  stirJuice(dt) {
    const { tools, dough } = this.models;
    const k = clamp(this.omega / TAU);
    this.puffTimer -= dt * (0.4 + k);
    if (this.puffTimer <= 0 && this.mix < 0.6) {
      this.puffTimer = 0.5 + Math.random() * 0.7;
      tools.spoon.anchors.scoop.getWorldPosition(this.tmp);
      this.tmp.y += 0.02;
      this.particles?.puff(this.tmp, { color: 0xf6efe2, count: Math.round(6 + 10 * (1 - this.mix)), spread: 0.035, size: 0.014, life: 0.9, rise: 0.05 });
    }
    this.dentTimer -= dt * (0.5 + k);
    if (this.dentTimer <= 0 && this.mix > 0.3) {
      this.dentTimer = 0.45;
      tools.spoon.anchors.scoop.getWorldPosition(this.tmp);
      const local = dough.group.worldToLocal(this.tmp.clone());
      dough.dent(local, { radius: 0.028, depth: 0.006, recovery: 0.6 });
    }
  }

  startMorph() {
    this.morphed = true;
    this.audio?.play('plop', { volume: 0.7 });
    this.ui.toast('¡Ya se forma una masa! Sigue removiendo hasta que no quede harina suelta.', { tone: 'info' });
    this.morphToBall(2);
  }

  /** Transforma la masa en bola (recuerda la transformación en curso para poder terminarla al salir). */
  morphToBall(duration) {
    const p = this.models.dough.morphTo('ball', duration);
    this.morphing = p;
    p.then(() => { if (this.morphing === p) this.morphing = null; });
    return p;
  }

  /** Mezcla terminada: la cuchara vuelve a su sitio, la masa da un saltito y se celebra. */
  async finish() {
    if (this.mixed) return;
    const { dough, tools, ingredients } = this.models;
    this.mixed = true;
    this.state.mix = 1;
    this.mix = 1;
    this.auto = false;
    this.dragId = null;
    this.engine.setCursor('');
    this.ui.hideHint();
    tools.spoon.setStirring(false);
    ingredients.bowlContents.setMix(1);
    ingredients.bowlContents.setVisible(false);
    if (dough.params.shape !== 'ball' || this.morphing) this.morphToBall(this.morphing ? 0.5 : 0.8);
    dough.set({ mix: 1, smoothness: 0.1, flour: 0.25, hydration: this.hydration });
    // saltito: la escala acaba en 1 y el giro vuelve a una vuelta entera
    const g = dough.group, s0 = g.scale.x, r0 = g.rotation.y, r1 = Math.round(r0 / TAU) * TAU;
    this.bounce = animate({ duration: 0.7, ease: ease.outBack, onUpdate: (t) => { g.scale.setScalar(lerp(s0, 1, t)); g.rotation.y = lerp(r0, r1, Math.min(1, t)); } });
    this.bounce.then(() => { if (!this.leaving) { g.scale.setScalar(1); g.rotation.y = 0; } });
    dough.dent(V(0, 0.09, 0), { radius: 0.05, depth: 0.01, recovery: 0.5 });
    this.audio?.play('success');
    tools.bowl.anchors.rim.getWorldPosition(this.tmp);
    this.particles?.sparkle(this.tmp.clone().add(V(0, 0.03, 0)), { count: 30, spread: 0.09 });
    this.ui.toast('¡Masa lista! Ya no queda harina seca.', { tone: 'good' });
    this.instruct('¡Masa lista!', 'Ya no queda harina seca: es una masa pegajosa y algo desgreñada. Llévala a la mesa para amasarla.',
      'Es normal que se pegue un poco: el amasado la volverá lisa y elástica.');
    this.refreshMeters(true);
    this.ctl?.get('stir').set({ disabled: true, hidden: true });
    this.ctl?.get('next').set({ disabled: false });
  }

  goNext() {
    if (!this.mixed || this.leaving) return;
    this.complete();
  }

  // ---------------------------------------------------------------------------------------------
  // Puntero y teclado
  // ---------------------------------------------------------------------------------------------

  /** Centro del bol en pantalla y radio del borde (px). */
  bowlScreen() {
    const rim = this.models.tools.bowl.anchors.rim;
    rim.getWorldPosition(this.center);
    const c = this.engine.worldToScreen(this.center);
    const e = this.engine.worldToScreen(this.tmp.copy(this.center).add(V(SIZES.bowl.rimRadius, 0, 0)));
    return { x: c.x, y: c.y, r: Math.max(40, Math.hypot(e.x - c.x, e.y - c.y)) };
  }

  /** Ángulo (convención de la cuchara) del puntero alrededor del centro del bol; null si está en el centro. */
  pointerAngle(ev) {
    const rim = this.models.tools.bowl.anchors.rim;
    rim.getWorldPosition(this.center);
    const p = this.engine.screenToPlane(ev.ndc, this.center.y - 0.03);
    if (!p) return null;
    const dx = p.x - this.center.x, dz = p.z - this.center.z;
    if (Math.hypot(dx, dz) < 0.015) return null;
    return Math.atan2(-dz, dx);
  }

  inStirZone(ev) {
    const c = this.bowlScreen();
    return Math.hypot(ev.x - c.x, ev.y - c.y) < c.r * 2.1;
  }

  onPointerDown(ev) {
    if (this.leaving || ev.button > 0) return;
    if (this.mixed) {
      // un toque a la masa terminada: se bambolea
      const hit = this.engine.raycast(ev.ndc, this.models.dough.mesh)[0];
      if (hit) {
        this.models.dough.dent(this.models.dough.group.worldToLocal(hit.point.clone()), { radius: 0.03, depth: 0.01, recovery: 0.7 });
        this.audio?.play('plop', { volume: 0.5 });
      }
      return;
    }
    if (this.dragId != null || !this.inStirZone(ev)) return;
    this.dragId = ev.pointerId;
    this.models.tools.bowl.setHighlight(false);
    this.lastAngle = this.pointerAngle(ev);
    if (this.lastAngle != null) this.spoonGoal = this.spoonAngle + wrap(this.lastAngle - this.spoonAngle);
    this.engine.setCursor('grabbing');
    this.ui.hideHint();
  }

  onPointerMove(ev) {
    if (this.leaving) return;
    if (this.dragId != null) {
      if (ev.pointerId !== this.dragId) return;
      const a = this.pointerAngle(ev);
      if (a == null) return;
      if (this.lastAngle == null) { this.lastAngle = a; return; }
      const d = wrap(a - this.lastAngle);
      this.lastAngle = a;
      this.pending += d;
      this.spoonGoal += d;
      return;
    }
    if (this.mixed || ev.pointerType === 'touch') return;
    this.setHover(this.inStirZone(ev));
  }

  /** Ratón cerca del bol: cursor de agarrar, bol resaltado al principio y pista flotante. */
  setHover(near) {
    if (near !== this.hovering) {
      this.hovering = near;
      this.engine.setCursor(near ? 'grab' : '');
      this.models.tools.bowl.setHighlight(near && this.mix < 0.02);
    }
    if (near) {
      const rim = this.models.tools.bowl.anchors.rim;
      rim.getWorldPosition(this.tmp);
      this.tmp.y += 0.06;
      this.tmp.z -= 0.16;
      this.ui.showHint('Arrastra en círculos para remover', this.engine.worldToScreen(this.tmp));
    } else this.ui.hideHint();
  }

  onPointerUp(ev) {
    if (this.dragId == null || ev.pointerId !== this.dragId) return;
    this.endDrag();
  }

  endDrag() {
    if (this.dragId == null) return;
    this.dragId = null;
    this.lastAngle = null;
    this.engine.setCursor(this.hovering && !this.mixed ? 'grab' : '');
  }

  onKey(e, down) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (!down) { this.setAuto(false, 'key'); return; } // soltar siempre para
    if (this.leaving) return;
    const t = e.target;
    if (t && t !== document.body && t.closest?.('button, input, select, textarea, a, [role="dialog"], [role="alertdialog"]')) return;
    e.preventDefault();
    if (!e.repeat) this.setAuto(true, 'key');
  }

  // ---------------------------------------------------------------------------------------------
  // Salida
  // ---------------------------------------------------------------------------------------------

  async exit() {
    const { dough, tools, ingredients } = this.models;
    this.leaving = true;
    this.auto = false;
    this.dragId = null;
    tools.spoon.setStirring(false);
    tools.bowl.setHighlight(false);
    this.bounce?.cancel();
    if (this.mixed) {
      // la masa se queda en el bol, como bola entera
      if (dough.params.shape !== 'ball' || this.morphing) dough.morphTo('ball', 0);
      this.morphing = null;
      dough.group.scale.setScalar(1);
      dough.group.rotation.set(0, 0, 0);
      ingredients.bowlContents.setVisible(false);
    }
    super.exit();
  }

  async autoComplete() {
    const { ingredients, tools, dough } = this.models;
    this.state.mix = 1;
    ingredients.bowlContents.setMix(1);
    ingredients.bowlContents.setVisible(false);
    tools.spoon.reset();
    this.placeAt(dough.group, tools.bowl.anchors.contents);
    dough.group.scale.setScalar(1);
    dough.group.visible = true;
    dough.set({ shape: 'ball', mix: 1, smoothness: 0.1, hydration: this.hydration, flour: 0.25, rise: 1, collapse: 0, squash: 0, stretch: 0 });
    dough.morphTo('ball', 0);
  }
}
