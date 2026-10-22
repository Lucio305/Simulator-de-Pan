// Etapa 1 · Ingredientes: pesar cada ingrediente vertiéndolo en el bol sobre la báscula.
import * as THREE from 'three';
import { Stage, totalGrams } from './stage.js';
import { INGREDIENTS, INGREDIENT_ORDER, ingredientReport } from '../recipe.js';
import { wait } from '../core/anim.js';
import { SPOTS } from '../core/layout.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/**
 * Vistas propias: la fila de recipientes, el bol y la pantalla de la báscula dentro de la zona que deja
 * libre el HUD. Escritorio: desde delante a la izquierda (la bolsa de harina queda a la derecha del
 * panel de instrucciones y el bol a la derecha). Móvil en vertical: desde delante a la derecha, con
 * los seis recipientes, el bol y la báscula en la mitad de arriba (la hoja inferior tapa el resto).
 */
const VIEWS = {
  wide: { position: V(-1.15, 1.63, 0.92), target: V(-0.79, 1.0, -0.06) },
  tall: { position: V(0.14, 1.73, 1.24), target: V(-0.38, 0.83, 0.19) },   // pensada para 390x844
};

/** Aleja la cámara de su objetivo (pantallas menos panorámicas). */
function pull(view, k) {
  const position = view.target.clone().lerp(view.position, k);
  return { position, target: view.target.clone() };
}

const SHORT = { flour: 'Harina', water: 'Agua', yeast: 'Levadura', salt: 'Sal', sugar: 'Azúcar', oil: 'Aceite' };
const LOWER = { flour: 'harina', water: 'agua', yeast: 'levadura', salt: 'sal', sugar: 'azúcar', oil: 'aceite' };
const THE = { flour: 'la harina', water: 'el agua', yeast: 'la levadura', salt: 'la sal', sugar: 'el azúcar', oil: 'el aceite' };
const DRIBBLE_ZONE = 0.12; // modo guiado: a menos de un 12 % del objetivo sale un chorrito
const DRIBBLE_RATE = 0.3;
const REQUIRED = ['flour', 'water', 'yeast'];

/** Cantidad al estilo de la báscula: "500", "3,5". */
function fmt(v) {
  const n = Math.max(0, Number(v) || 0);
  const r = n >= 20 ? Math.round(n) : Math.round(n * 10) / 10;
  return String(r).replace('.', ',');
}

export class IngredientsStage extends Stage {
  constructor(game) {
    super(game);
    this.items = null;
    this.selected = 'flour';
    this.pouring = null;          // id del recipiente que se está vertiendo
    this.pourSource = null;       // 'pointer' | 'hold' | 'key'
    this.pointerId = null;
    this.hovered = null;
    this.pourTime = 0;
    this.flowed = false;
    this.target = new THREE.Vector3();
    this.tops = {};               // punto encima de cada recipiente (para las pistas)
    this.warned = new Set();      // avisos de "esta receta no lleva…" ya mostrados
    this.okSeen = new Set();      // filas que ya celebraron estar en su punto
    this.overSeen = new Set();    // filas que ya avisaron de que te pasaste
    this.refill = new Set();      // recipientes que se rellenan al volver a casa
    this.allOk = false;
    this.canGo = null;
    this.leaving = false;
    this.dialogOpen = false;
    this.ctl = null;
    this.pourValue = undefined;
    this.pourActive = undefined;
  }

  /** Vista según la forma de la pantalla. */
  view() {
    const aspect = this.engine.camera.aspect;
    if (aspect < 0.8) return aspect < 0.46 ? pull(VIEWS.tall, 0.46 / aspect) : VIEWS.tall;
    return aspect < 1.5 ? pull(VIEWS.wide, 1 + (1.5 - aspect) * 0.5) : VIEWS.wide;
  }

  async enter() {
    const { ingredients, tools } = this.models;
    this.items = ingredients.items;
    const a = this.state.amounts;
    ingredients.bowlContents.setVisible(true);
    ingredients.bowlContents.setMix(0);
    ingredients.bowlContents.setAmounts(a);
    tools.scale.setReading(totalGrams(a));
    tools.bowl.anchors.contents.getWorldPosition(this.target);
    this.measureTops();
    for (const id of INGREDIENT_ORDER) if ((a[id] || 0) > 0 && this.rowState(id) === 'ok') this.okSeen.add(id);
    this.selected = this.nextPending() ?? 'flour';

    this.camera(this.view(), { duration: 1.6 });
    this.instruct('Pesa los ingredientes',
      'Mantén pulsado un recipiente (o el botón «Verter») para echarlo en el bol. Suelta cuando la báscula llegue a la cantidad de la receta.',
      this.bread.tips?.ingredients);

    const recipe = this.bread.recipe;
    this.ctl = this.ui.setControls([
      {
        type: 'choice', id: 'ing', label: 'Ingrediente', value: this.selected,
        options: INGREDIENT_ORDER.map((id) => ({
          value: id, label: SHORT[id],
          sub: recipe[id] > 0 ? `${fmt(recipe[id])} ${INGREDIENTS[id].unit}` : 'no lleva',
        })),
        onChange: (v) => this.select(v),
      },
      { type: 'hold', id: 'pour', label: this.pourLabel(), icon: 'hand', onStart: () => this.startPour(this.selected, 'hold'), onEnd: () => this.endPour('hold') },
      { type: 'button', id: 'empty', label: 'Vaciar el bol', variant: 'secondary', icon: 'restart', onClick: () => this.askEmpty() },
      { type: 'button', id: 'next', label: 'Continuar', variant: 'primary', icon: 'check', disabled: true, onClick: () => this.tryContinue() },
    ]);
    this.refreshRecipe();
    this.refreshControls();
    this.refreshPourButton();
    this.refreshHighlights();

    // Teclado: 1–6 eligen ingrediente, ← → cambian, espacio mantenido vierte.
    const down = (e) => this.onKey(e, true), up = (e) => this.onKey(e, false);
    const blur = () => { if (this.pourSource !== 'hold') this.stopPour(); };
    // al salir del lienzo (p. ej. hacia el dock) se apaga la pista del recipiente
    const leave = () => {
      if (this.hovered) { this.hovered = null; this.refreshHighlights(); }
      if (!this.pouring) this.ui.hideHint();
    };
    // al girar el móvil o cambiar el tamaño de la ventana se vuelve a encuadrar
    // (engine.resize primero: el ResizeObserver puede llegar después y view() leería el aspecto viejo)
    const resize = () => {
      if (this.leaving) return;
      this.engine.resize();
      this.measureTops();
      this.camera(this.view(), { duration: 0.3 });
    };
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
  }

  // ---------------------------------------------------------------------------------------------
  // Estado de la receta
  // ---------------------------------------------------------------------------------------------

  /** Estado de una fila según recipe.ingredientReport (sin la marca de "activa"). */
  rowState(id, report = ingredientReport(this.state.amounts, this.state.breadId)) {
    return report.rows.find((r) => r.id === id)?.state ?? 'ok';
  }

  /** Primer ingrediente de la receta que aún no está en su punto. */
  nextPending() {
    const report = ingredientReport(this.state.amounts, this.state.breadId);
    return INGREDIENT_ORDER.find((id) => this.bread.recipe[id] > 0 && this.rowState(id, report) !== 'ok' && !this.state.amounts[id])
      ?? INGREDIENT_ORDER.find((id) => this.bread.recipe[id] > 0 && this.rowState(id, report) !== 'ok');
  }

  refreshRecipe(report = ingredientReport(this.state.amounts, this.state.breadId)) {
    const a = this.state.amounts;
    const rows = INGREDIENT_ORDER.map((id) => {
      let state = this.rowState(id, report);
      if (id === this.selected && (state === 'pending' || state === 'under')) state = 'active';
      const ing = INGREDIENTS[id];
      return { id, label: ing.label, target: this.bread.recipe[id] || 0, current: a[id] || 0, unit: ing.unit, state };
    });
    this.ui.setRecipe({ title: `Receta · ${this.bread.name}`, rows });
  }

  refreshControls() {
    const a = this.state.amounts;
    const canGo = REQUIRED.every((id) => (a[id] || 0) > 0);
    if (canGo !== this.canGo) {
      this.canGo = canGo;
      this.ctl?.get('next').set({ disabled: !canGo });
    }
  }

  pourLabel() { return `Verter ${LOWER[this.selected]}`; }

  /** El botón «Verter» se rellena con lo que llevas del ingrediente elegido. */
  refreshPourButton() {
    const id = this.selected, target = this.bread.recipe[id] || 0;
    const value = target > 0 ? Math.round(Math.min(1, (this.state.amounts[id] || 0) / target) * 100) / 100 : null;
    const active = !!this.pouring;
    if (value === this.pourValue && active === this.pourActive) return;
    this.pourValue = value;
    this.pourActive = active;
    this.ctl?.get('pour').set({ value, active });
  }

  /** Punto encima de cada recipiente en su sitio (para colocar las pistas). */
  measureTops() {
    const box = new THREE.Box3();
    for (const id of INGREDIENT_ORDER) {
      const item = this.items[id], home = SPOTS.ingredients[id];
      if (item.busy && this.tops[id]) continue; // en el aire: se queda la medida de cuando estaba en casa
      let h = 0.2;
      if (!item.busy) { box.setFromObject(item.object); h = box.max.y - home.y; }
      this.tops[id] = V(home.x, home.y + h + 0.015, home.z);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Selección y vertido
  // ---------------------------------------------------------------------------------------------

  select(id) {
    if (!INGREDIENTS[id] || this.leaving) return;
    if (this.pouring && this.pouring !== id) this.stopPour(false);
    if (this.selected === id) return;
    this.selected = id;
    this.audio?.play('click', { volume: 0.5 });
    this.ctl?.get('ing').set({ value: id });
    this.ctl?.get('pour').set({ label: this.pourLabel() });
    this.refreshRecipe();
    this.refreshPourButton();
    this.refreshHighlights();
  }

  startPour(id, source) {
    if (this.leaving || this.dialogOpen || !this.items?.[id]) return;
    if (this.pouring === id) { this.pourSource = source; return; }
    if (this.pouring) this.stopPour(false);
    this.select(id);
    const item = this.items[id];
    this.pouring = id;
    this.pourSource = source;
    this.pourTime = 0;
    this.flowed = false;
    this.emptyWarned = false;
    this.models.tools.bowl.anchors.contents.getWorldPosition(this.target);
    item.setThrottle?.(1);
    item.setPouring(true, this.target);
    this.audio?.play('whoosh', { volume: 0.35, rate: 1.2 });
    if (!(this.bread.recipe[id] > 0) && !this.warned.has(id)) {
      this.warned.add(id);
      this.ui.toast(`Ojo: la receta de ${this.breadArticle()} no lleva ${LOWER[id]}. Si lo echas, cambiará el pan.`, { tone: 'info', duration: 3.4 });
    }
    this.engine.setCursor('grabbing');
    this.refreshPourButton();
    this.refreshHighlights();
  }

  /**
   * Suelta el recipiente que se está vertiendo (vuelve solo a su sitio).
   * @param {boolean} [advance=true] si quedó en su punto, elige el siguiente ingrediente
   */
  stopPour(advance = true) {
    const id = this.pouring;
    if (!id) return;
    this.items[id].setPouring(false);
    this.pouring = null;
    this.pourSource = null;
    this.pointerId = null;
    this.ui.hideHint();
    this.engine.setCursor(this.hovered ? 'grab' : '');
    // si quedó en su punto, se pasa al siguiente ingrediente de la receta
    if (advance && !this.leaving && (this.state.amounts[id] || 0) > 0 && this.rowState(id) === 'ok') {
      const next = this.nextPending();
      if (next) this.select(next);
    }
    this.refreshPourButton();
    this.refreshHighlights();
  }

  endPour(source) {
    if (this.pouring && this.pourSource === source) this.stopPour();
  }

  breadArticle() {
    return { hogaza: 'la hogaza', baguette: 'la baguette', molde: 'el pan de molde' }[this.state.breadId] ?? 'este pan';
  }

  // ---------------------------------------------------------------------------------------------
  // Bucle
  // ---------------------------------------------------------------------------------------------

  update(dt) {
    if (!this.items) return;
    const a = this.state.amounts;
    let changed = false;
    // todo lo que sale de cualquier recipiente cae en el bol (también lo que gotea al soltar)
    for (const id of INGREDIENT_ORDER) {
      const item = this.items[id];
      const f = item.flow;
      if (f > 0) { a[id] = (a[id] || 0) + item.maxRate * f * dt; changed = true; }
      if (this.refill.has(id) && !item.busy && f === 0) { item.reset(); this.refill.delete(id); }
    }
    if (this.pouring) this.updatePour(dt);
    if (changed) {
      const { ingredients, tools } = this.models;
      ingredients.bowlContents.setAmounts(a);
      tools.scale.setReading(totalGrams(a));
      const report = ingredientReport(a, this.state.breadId);
      this.refreshRecipe(report);
      this.refreshControls();
      this.refreshPourButton();
      this.checkMilestones(report);
    }
    if (this.pouring) this.showPourHint();
  }

  updatePour(dt) {
    const id = this.pouring, item = this.items[id];
    const amount = this.state.amounts[id] || 0, target = this.bread.recipe[id] || 0;
    // modo guiado: cerca del objetivo sale un chorrito para poder parar justo
    const near = this.guided && target > 0 && amount >= target * (1 - DRIBBLE_ZONE);
    item.setThrottle?.(near ? DRIBBLE_RATE : 1);
    this.pourTime += dt;
    if (item.flow > 0.05) this.flowed = true;
    if (this.flowed && item.flow === 0 && this.pourTime > 2.5 && !this.emptyWarned) {
      this.emptyWarned = true;
      this.ui.toast(`¡Se ha acabado ${THE[id]}! Vacía el bol si quieres empezar de nuevo.`, { tone: 'warn' });
    }
  }

  /** Etiqueta flotante con lo que llevas del ingrediente que estás vertiendo. */
  showPourHint() {
    const id = this.pouring;
    const amount = this.state.amounts[id] || 0, target = this.bread.recipe[id] || 0;
    const unit = INGREDIENTS[id].unit;
    let text;
    if (!(target > 0)) text = `${SHORT[id]}: ${fmt(amount)} ${unit} · esta receta no lleva`;
    else {
      const state = amount > 0 ? this.rowState(id) : 'pending';
      const base = `${fmt(amount)} de ${fmt(target)} ${unit}`;
      if (state === 'over') text = `¡Te pasas! ${base}`;
      else if (this.guided && state === 'ok') text = `¡En su punto! ${base} · suelta`;
      else if (this.guided && amount >= target * (1 - DRIBBLE_ZONE)) text = `¡Ya casi! ${base}`;
      else text = `${SHORT[id]}: ${base}`;
    }
    // a la derecha del bol (el recipiente vierte desde la izquierda)
    const p = this.target.clone().add(V(0.17, 0.11, 0.05));
    this.ui.showHint(text, this.engine.worldToScreen(p));
  }

  /** Sonidos y avisos al llegar a la cantidad, al pasarse y al completar la receta. */
  checkMilestones(report) {
    const a = this.state.amounts;
    for (const row of report.rows) {
      const { id, state, target } = row;
      if (!(a[id] > 0)) continue;
      if (state === 'ok' && target > 0 && !this.okSeen.has(id)) {
        this.okSeen.add(id);
        this.audio?.play('ding', { volume: 0.55 });
        this.particles?.sparkle(this.target.clone().add(V(0.06, 0.1, 0.05)), { count: 14, spread: 0.04 });
      }
      if (state === 'over' && target > 0 && !this.overSeen.has(id)) {
        this.overSeen.add(id);
        this.audio?.play('tick');
        this.ui.toast(`¡Te pasas de ${LOWER[id]}! La receta pide ${fmt(target)} ${row.unit}. Si quieres, vacía el bol y vuelve a pesar.`, { tone: 'warn', duration: 3.6 });
      }
    }
    const allOk = report.rows.every((r) => r.state === 'ok');
    if (allOk && !this.allOk) {
      this.allOk = true;
      this.audio?.play('success');
      this.particles?.sparkle(this.target.clone().add(V(0, 0.12, 0)), { count: 36, spread: 0.1 });
      this.ui.toast('¡Todo pesado! Pulsa «Continuar» para mezclar.', { tone: 'good', duration: 3.2 });
    } else if (!allOk) this.allOk = false;
  }

  refreshHighlights() {
    if (!this.items) return;
    const report = ingredientReport(this.state.amounts, this.state.breadId);
    const nudge = this.guided && !this.pouring && !this.hovered && !this.allOk && this.rowState(this.selected, report) !== 'ok';
    for (const id of INGREDIENT_ORDER) {
      const on = !this.leaving && !this.pouring && (id === this.hovered || (nudge && id === this.selected));
      this.items[id].setHighlight(on);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Puntero y teclado
  // ---------------------------------------------------------------------------------------------

  /** Recipiente bajo el puntero (el bol y la báscula tapan lo que haya detrás). */
  pick(ev) {
    const { tools } = this.models;
    const objects = [...INGREDIENT_ORDER.map((id) => this.items[id].object), tools.bowl.object, tools.scale.object];
    const hit = this.engine.raycast(ev.ndc, objects)[0];
    return hit?.object.userData.ingredient ?? null;
  }

  onPointerDown(ev) {
    if (!this.items || this.leaving || this.dialogOpen || ev.button > 0) return;
    if (this.pouring) return; // un solo recipiente a la vez
    const id = this.pick(ev);
    if (!id) return;
    // (el lienzo captura el puntero: aunque lo arrastres hacia el bol sigue vertiendo hasta soltar)
    this.startPour(id, 'pointer');
    this.pointerId = ev.pointerId;
  }

  onPointerMove(ev) {
    if (!this.items || this.leaving) return;
    if (this.pouring) return;
    if (ev.pointerType === 'touch') return;
    const id = this.dialogOpen ? null : this.pick(ev);
    if (id !== this.hovered) {
      this.hovered = id;
      this.engine.setCursor(id ? 'grab' : '');
      this.refreshHighlights();
    }
    if (id) {
      const target = this.bread.recipe[id] || 0;
      const text = target > 0
        ? `${INGREDIENTS[id].label} · ${fmt(target)} ${INGREDIENTS[id].unit} · mantén pulsado`
        : `${INGREDIENTS[id].label} · esta receta no lleva`;
      this.ui.showHint(text, this.engine.worldToScreen(this.tops[id]));
    } else this.ui.hideHint();
  }

  onPointerUp(ev) {
    if (this.pourSource === 'pointer' && (this.pointerId == null || ev.pointerId === this.pointerId)) this.stopPour();
  }

  onKey(e, down) {
    const space = e.key === ' ' || e.code === 'Space';
    if (!down && space) { this.endPour('key'); return; } // soltar siempre corta el chorro
    if (this.leaving || this.dialogOpen) return;
    const t = e.target;
    if (t && t !== document.body && t.closest?.('button, input, select, textarea, a, [role="dialog"], [role="alertdialog"]')) return;
    if (space) {
      e.preventDefault();
      if (!e.repeat) this.startPour(this.selected, 'key');
      return;
    }
    if (!down || this.pouring) return;
    const i = INGREDIENT_ORDER.indexOf(this.selected);
    if (/^[1-6]$/.test(e.key)) this.select(INGREDIENT_ORDER[+e.key - 1]);
    else if (e.key === 'ArrowRight') this.select(INGREDIENT_ORDER[(i + 1) % 6]);
    else if (e.key === 'ArrowLeft') this.select(INGREDIENT_ORDER[(i + 5) % 6]);
  }

  // ---------------------------------------------------------------------------------------------
  // Botones del dock
  // ---------------------------------------------------------------------------------------------

  async askEmpty() {
    if (this.leaving || this.dialogOpen) return;
    this.stopPour();
    const total = totalGrams(this.state.amounts);
    if (total < 0.05) { this.ui.toast('El bol ya está vacío.', { tone: 'info' }); return; }
    this.dialogOpen = true;
    const v = await this.ui.showDialog({
      title: '¿Vaciar el bol?',
      body: `Tirarás los ${fmt(total)} g que hay en el bol y los recipientes volverán a estar llenos. Después podrás pesar todo de nuevo.`,
      actions: [
        { label: 'Mejor no', variant: 'secondary', value: 'no' },
        { label: 'Vaciar el bol', variant: 'primary', value: 'yes' },
      ],
    });
    this.dialogOpen = false;
    if (v !== 'yes' || this.leaving || this.game.stage !== this) return;
    this.emptyBowl();
  }

  emptyBowl() {
    const { ingredients, tools } = this.models;
    const a = this.state.amounts;
    for (const id of INGREDIENT_ORDER) { a[id] = 0; this.refill.add(id); }
    ingredients.bowlContents.reset();
    ingredients.bowlContents.setVisible(true);
    tools.scale.setReading(0);
    this.okSeen.clear();
    this.overSeen.clear();
    this.allOk = false;
    this.audio?.play('whoosh');
    this.particles?.puff(this.target.clone().add(V(0, 0.06, 0)), { color: 0xf3ece0, count: 30, spread: 0.08, rise: 0.12 });
    this.select(this.nextPending() ?? 'flour');
    this.refreshRecipe();
    this.refreshControls();
    this.refreshPourButton();
    this.refreshHighlights();
    this.ui.toast('Bol vacío. ¡A pesar otra vez!', { tone: 'info' });
  }

  async tryContinue() {
    if (this.leaving || this.dialogOpen) return;
    const a = this.state.amounts;
    const missing = REQUIRED.filter((id) => !((a[id] || 0) > 0));
    if (missing.length) {
      this.ui.toast(`Aún falta ${missing.map((id) => THE[id]).join(', ').replace(/, ([^,]*)$/, ' y $1')}.`, { tone: 'warn' });
      return;
    }
    this.stopPour();
    // espera a que deje de caer lo que aún gotea (para que cuente)
    this.dialogOpen = true;
    for (let t = 0; t < 1.6 && Object.values(this.items).some((it) => it.flow > 0); t += 0.1) await wait(0.1);
    this.dialogOpen = false;
    if (this.leaving || this.game.stage !== this) return;
    const report = ingredientReport(a, this.state.breadId);
    if (report.notes.length) {
      this.dialogOpen = true;
      const v = await this.ui.showDialog({
        title: 'La báscula no cuadra con la receta',
        body: [...report.notes, '¿Quieres seguir así o prefieres corregirlo?'].join('\n\n'),
        actions: [
          { label: 'Corregir', variant: 'secondary', value: 'fix' },
          { label: 'Seguir así', variant: 'primary', value: 'go' },
        ],
      });
      this.dialogOpen = false;
      if (v !== 'go' || this.leaving || this.game.stage !== this) return;
    }
    this.leaving = true;
    this.refreshHighlights();
    this.complete();
  }

  async exit() {
    this.leaving = true;
    this.stopPour();
    for (const id of INGREDIENT_ORDER) {
      const item = this.items?.[id];
      if (!item) continue;
      item.setPouring(false);
      item.setHighlight(false);
    }
    super.exit();
  }

  async autoComplete() {
    const { ingredients, tools } = this.models;
    for (const item of Object.values(ingredients.items)) { item.setPouring(false); item.setHighlight(false); }
    Object.assign(this.state.amounts, this.bread.recipe);
    ingredients.bowlContents.setVisible(true);
    ingredients.bowlContents.setMix(0);
    ingredients.bowlContents.setAmounts(this.state.amounts);
    tools.scale.setReading(totalGrams(this.state.amounts));
  }
}
