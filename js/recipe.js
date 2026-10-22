/**
 * Pan Casero 3D — simulación y puntuación.
 *
 * Módulo puro: sin THREE ni DOM. Todas las funciones son deterministas, no mutan sus entradas,
 * nunca lanzan excepciones con datos incompletos y nunca devuelven NaN.
 * Unidades: gramos / mililitros, grados Celsius y minutos SIMULADOS.
 * @module recipe
 */

// ---------------------------------------------------------------------------
// Utilidades internas
// ---------------------------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, v) => {
  if (a === b) return v < a ? 0 : 1;
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
// Número finito o valor por defecto (acepta strings numéricas)
const num = (v, def = 0) => {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const pos = (v, def = 0) => Math.max(0, num(v, def));
const obj = (v) => (v && typeof v === 'object' ? v : {});
const fin = (v, def = 0) => (Number.isFinite(v) ? v : def);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// Formato español: coma decimal
function fmtDec(v, decimals = 1) {
  const f = 10 ** decimals;
  const r = Math.round(fin(v) * f) / f;
  return (Number.isInteger(r) ? String(r) : r.toFixed(decimals)).replace('.', ',');
}
// Cantidades: decimales solo en cantidades pequeñas
const fmtAmount = (v) => {
  const x = fin(v);
  return x < 20 && Math.abs(x - Math.round(x)) >= 0.05 ? fmtDec(x, 1) : String(Math.round(x));
};
const fmtPct = (ratio01) => `${Math.round(fin(ratio01) * 100)} %`;
const fmtC = (c) => `${Math.round(fin(c))} °C`;
// Minutos simulados → "1 h 35 min" / "3 h 05 min" / "45 min" (como el HUD)
function fmtMinutes(min) {
  const total = Math.max(0, Math.round(fin(min)));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------
// Datos: ingredientes, panes, sitios de fermentación y etapas
// ---------------------------------------------------------------------------

/**
 * Ingredientes disponibles. `maxRate` = unidades por segundo con el recipiente totalmente inclinado.
 * `tolerance` = margen relativo aceptado al pesar (±).
 * @type {Readonly<Record<'flour'|'water'|'yeast'|'salt'|'sugar'|'oil',
 *   {id:string,label:string,unit:'g'|'ml',maxRate:number,tolerance:number}>>}
 */
export const INGREDIENTS = deepFreeze({
  flour: { id: 'flour', label: 'Harina de fuerza', unit: 'g', maxRate: 110, tolerance: 0.06 },
  water: { id: 'water', label: 'Agua tibia', unit: 'ml', maxRate: 70, tolerance: 0.06 },
  yeast: { id: 'yeast', label: 'Levadura seca', unit: 'g', maxRate: 2.5, tolerance: 0.2 },
  salt: { id: 'salt', label: 'Sal', unit: 'g', maxRate: 3, tolerance: 0.2 },
  sugar: { id: 'sugar', label: 'Azúcar', unit: 'g', maxRate: 8, tolerance: 0.06 },
  oil: { id: 'oil', label: 'Aceite de oliva', unit: 'ml', maxRate: 10, tolerance: 0.06 },
});

/**
 * Orden en que se presentan y se pesan los ingredientes.
 * @type {ReadonlyArray<string>}
 */
export const INGREDIENT_ORDER = deepFreeze(['flour', 'water', 'yeast', 'salt', 'sugar', 'oil']);

/**
 * Recetas de pan. Ventanas de fermentación expresadas en progreso adimensional `p`
 * (1 = la masa ha doblado su volumen). `bake.minutes` es el tiempo recomendado al horno
 * a `bake.tempC`; `crustIdeal` es el rango ideal del valor de corteza (0..1.4).
 * @type {Readonly<Record<'hogaza'|'baguette'|'molde', object>>}
 */
export const BREADS = deepFreeze({
  hogaza: {
    id: 'hogaza',
    name: 'Hogaza rústica',
    description: 'Pan redondo de pueblo, con corteza crujiente y una miga abierta y jugosa.',
    difficulty: 'Media',
    timeLabel: '3 h 30 min',
    shape: 'boule',
    container: 'tray',
    recipe: { flour: 500, water: 350, yeast: 4, salt: 10, sugar: 0, oil: 0 },
    hydrationIdeal: [0.66, 0.74],
    proof1Ideal: [0.85, 1.3],
    proof2Ideal: [0.55, 0.9],
    bake: { tempC: 230, minutes: [35, 40], steam: 'recomendado', crustIdeal: [0.7, 0.88] },
    scoring: {
      min: 1,
      max: 4,
      suggestion: 'Haz de 1 a 4 cortes decididos: una cruz, un cuadrado o un corte largo en arco.',
    },
    toppings: { suggested: 'flour', text: 'Espolvorea un velo de harina antes de greñar: los cortes resaltarán.' },
    tips: {
      ingredients: 'Pesa con calma: 500 g de harina, 350 ml de agua tibia, 4 g de levadura y 10 g de sal.',
      mix: 'Mezcla hasta que no quede harina seca. Estará pegajosa: es normal, no añadas harina todavía.',
      knead: 'Empuja con la palma, dobla y gira. Unas 30 buenas amasadas y la masa quedará lisa y elástica.',
      proof: 'Tápala y espera a que doble su volumen: 1 h 30 min a 2 h en la encimera.',
      shape: 'Pliega los bordes hacia el centro y dale la vuelta para formar una bola tensa.',
      bake: 'Horno a 230 °C bien precalentado y con vapor al principio: unos 35–40 min.',
    },
  },
  baguette: {
    id: 'baguette',
    name: 'Baguette',
    description: 'La barra francesa: fina, larga, de corteza que cruje y greñas bien abiertas.',
    difficulty: 'Difícil',
    timeLabel: '3 h',
    shape: 'baguette',
    container: 'tray',
    recipe: { flour: 500, water: 340, yeast: 5, salt: 10, sugar: 0, oil: 0 },
    hydrationIdeal: [0.64, 0.72],
    proof1Ideal: [0.85, 1.25],
    proof2Ideal: [0.5, 0.85],
    bake: { tempC: 240, minutes: [22, 25], steam: 'imprescindible', crustIdeal: [0.7, 0.85] },
    scoring: {
      min: 3,
      max: 5,
      suggestion: 'De 3 a 5 cortes largos, casi paralelos a la barra, que se solapen un tercio.',
    },
    toppings: { suggested: 'none', text: 'Mejor al natural: la corteza dorada y brillante es su seña.' },
    tips: {
      ingredients: 'Solo cuatro cosas: 500 g de harina, 340 ml de agua, 5 g de levadura y 10 g de sal.',
      mix: 'Integra bien el agua; una masa algo pegajosa dará una miga más abierta.',
      knead: 'Amasa con energía: la baguette necesita un gluten fuerte para estirarse sin romperse.',
      proof: 'Que doble su volumen sin pasarse: entre 1 h 15 min y 1 h 45 min a 22 °C.',
      shape: 'Estira un cilindro largo y fino, sin desgasificar del todo, y haz 3–5 cortes con la cuchilla.',
      bake: 'Muy caliente, a 240 °C, y con vapor: sin vapor no hay greña ni brillo. Unos 22–25 min.',
    },
  },
  molde: {
    id: 'molde',
    name: 'Pan de molde',
    description: 'Pan tierno y esponjoso de miga fina, perfecto para tostadas y bocadillos.',
    difficulty: 'Fácil',
    timeLabel: '3 h',
    shape: 'loaf',
    container: 'tin',
    recipe: { flour: 500, water: 300, yeast: 7, salt: 9, sugar: 15, oil: 25 },
    hydrationIdeal: [0.57, 0.64],
    proof1Ideal: [0.85, 1.3],
    proof2Ideal: [0.6, 0.95],
    bake: { tempC: 190, minutes: [28, 35], steam: 'no', crustIdeal: [0.6, 0.82] },
    scoring: {
      min: 0,
      max: 1,
      suggestion: 'No necesita cortes: el molde guía la subida. Como mucho, uno largo por el centro.',
    },
    toppings: { suggested: 'eggwash', text: 'Píntalo con huevo batido: saldrá dorado y brillante.' },
    tips: {
      ingredients: 'Esta lleva algo de azúcar (15 g) y aceite (25 ml): por eso la miga sale tan tierna.',
      mix: 'Mezcla hasta formar una masa suave; el aceite la hará un poco resbaladiza.',
      knead: 'Amasa hasta que esté lisa y sedosa: el gluten sujeta la subida dentro del molde.',
      proof: 'Con más levadura y algo de azúcar va rápida: en 1 h a 1 h 20 min suele doblar.',
      shape: 'Forma un rulo del largo del molde y colócalo con la unión hacia abajo.',
      bake: 'A 190 °C sin vapor, unos 28–35 min, hasta que suene hueco al golpear la base.',
    },
  },
});

/**
 * Orden de presentación de los panes.
 * @type {ReadonlyArray<string>}
 */
export const BREAD_ORDER = deepFreeze(['hogaza', 'baguette', 'molde']);

/**
 * Lugares donde dejar fermentar la masa.
 * @type {ReadonlyArray<{id:string,label:string,tempC:number,note:string}>}
 */
export const PROOF_SPOTS = deepFreeze([
  { id: 'encimera', label: 'Encimera', tempC: 22, note: 'A temperatura ambiente: fermentación tranquila y con buen sabor.' },
  { id: 'calido', label: 'Junto al horno', tempC: 28, note: 'Con calorcito va más rápido, pero vigílala para que no se pase.' },
  { id: 'nevera', label: 'Nevera', tempC: 5, note: 'En frío casi se detiene: tarda horas, pero gana mucho sabor.' },
]);

/**
 * Etapas del juego, en orden.
 * @type {ReadonlyArray<{id:string,label:string}>}
 */
export const STAGES = deepFreeze([
  { id: 'ingredients', label: 'Ingredientes' },
  { id: 'mix', label: 'Mezclar' },
  { id: 'knead', label: 'Amasar' },
  { id: 'proof', label: 'Fermentar' },
  { id: 'shape', label: 'Formar' },
  { id: 'bake', label: 'Hornear' },
  { id: 'result', label: 'Resultado' },
]);

/**
 * Devuelve la definición de un pan (por defecto la hogaza si el id no existe).
 * @param {string} breadId
 * @returns {object} entrada de BREADS
 */
export function getBread(breadId) {
  return Object.prototype.hasOwnProperty.call(BREADS, breadId) ? BREADS[breadId] : BREADS.hogaza;
}

// Cantidades saneadas (≥ 0, finitas)
function normAmounts(amounts) {
  const a = obj(amounts);
  const out = {};
  for (const id of INGREDIENT_ORDER) out[id] = pos(a[id]);
  return out;
}

// ---------------------------------------------------------------------------
// Ingredientes
// ---------------------------------------------------------------------------

/**
 * Hidratación = agua / harina (0 si no hay harina).
 * @param {{flour?:number, water?:number}} amounts
 * @returns {number} p. ej. 0.70
 */
export function hydration(amounts) {
  const a = normAmounts(amounts);
  return a.flour > 0 ? a.water / a.flour : 0;
}

const ING_WEIGHT = { flour: 0.25, water: 0.25, yeast: 0.2, salt: 0.15, sugar: 0.075, oil: 0.075 };

// Consecuencia de la hidratación en palabras
function hydrationEffect(h, bread) {
  const [lo, hi] = bread.hydrationIdeal;
  if (h > hi + 0.07) return 'muy pegajosa';
  if (h > hi) return 'algo pegajosa';
  if (h < lo - 0.07) return 'seca y dura de amasar';
  if (h < lo) return 'algo seca';
  return null;
}

// Nota para una fila de ingrediente fuera de rango (tiempo presente/futuro o pasado)
function ingredientNote(row, bread, h, past) {
  const { id, target, current, state } = row;
  const v = (fut, pas) => (past ? pas : fut);
  const c = fmtAmount(current);
  const t = fmtAmount(target);
  const hp = fmtPct(h);
  const eff = hydrationEffect(h, bread);
  const queda = v('quedará', 'quedó');
  switch (id) {
    case 'flour': {
      if (current <= 0) return v('Falta la harina: ¡es la base del pan!', 'Sin harina no hay pan: al bol le faltó su ingrediente principal.');
      const verb = v('Has pesado', 'Pesaste');
      const solo = state === 'under' ? 'solo ' : '';
      if (!eff) return `${verb} ${solo}${c} g de harina en lugar de ${t} g; por suerte la hidratación (${hp}) sigue en su punto.`;
      return `${verb} ${solo}${c} g de harina en lugar de ${t} g: hidratación del ${hp}, la masa ${queda} ${eff}.`;
    }
    case 'water': {
      const verb = v('Has puesto', 'Pusiste');
      if (current <= 0) return v('Falta el agua: sin ella la harina no se convierte en masa.', 'No pusiste agua: la harina nunca llegó a ser masa.');
      const solo = state === 'under' ? 'solo ' : '';
      if (!eff) return `${verb} ${solo}${c} ml de agua en lugar de ${t} ml, aunque la hidratación (${hp}) sigue en su punto.`;
      return `${verb} ${solo}${c} ml de agua en lugar de ${t} ml: hidratación del ${hp}, la masa ${queda} ${eff}.`;
    }
    case 'yeast':
      if (current <= 0) return v('No has puesto levadura: sin ella la masa no subirá.', 'No pusiste levadura: sin ella la masa no pudo subir.');
      if (state === 'over') return `${v('Has echado', 'Echaste')} ${c} g de levadura en lugar de ${t} g: ${v('fermentará', 'fermentó')} muy deprisa y con sabor a levadura.`;
      return `Solo ${c} g de levadura (la receta pide ${t} g): ${v('fermentará', 'fermentó')} muy despacio.`;
    case 'salt':
      if (current <= 0) return v('Falta la sal: el pan quedará soso y fermentará demasiado deprisa.', 'Olvidaste la sal: el pan quedó soso y fermentó demasiado deprisa.');
      if (state === 'over') return `${c} g de sal en lugar de ${t} g: el pan ${queda} salado y la levadura ${v('irá', 'fue')} más lenta.`;
      return `Solo ${c} g de sal (la receta pide ${t} g): ${queda} algo soso.`;
    case 'sugar':
      if (target <= 0) return `${v('Has añadido', 'Añadiste')} ${c} g de azúcar, que esta receta no lleva: la corteza se ${v('dorará', 'doró')} antes.`;
      if (current <= 0) return v('Falta el azúcar: la miga será menos tierna y dorará menos.', 'Olvidaste el azúcar: la miga quedó menos tierna y doró menos.');
      if (state === 'over') return `${c} g de azúcar en lugar de ${t} g: ${queda} dulzón y la corteza se ${v('tostará', 'tostó')} antes.`;
      return `Solo ${c} g de azúcar (la receta pide ${t} g): ${v('dorará', 'doró')} menos y la miga ${v('será', 'fue')} menos tierna.`;
    case 'oil':
      if (target <= 0) return `${v('Has añadido', 'Añadiste')} ${c} ml de aceite, que esta receta no lleva: la miga ${v('será', 'salió')} más tierna pero menos rústica.`;
      if (current <= 0) return v('Falta el aceite: la miga será menos tierna.', 'Olvidaste el aceite: la miga quedó menos tierna.');
      if (state === 'over') return `${c} ml de aceite en lugar de ${t} ml: la masa ${v('estará', 'estuvo')} grasienta y ${v('subirá', 'subió')} menos.`;
      return `Solo ${c} ml de aceite (la receta pide ${t} ml): la miga ${v('será', 'fue')} menos tierna.`;
    default:
      return '';
  }
}

/**
 * Compara las cantidades pesadas con la receta.
 * Filas: todos los ingredientes que la receta lleva, más los que no lleva pero se han añadido (estado 'over').
 * Estados: 'pending' (aún nada), 'under', 'ok', 'over'. Tolerancia ±6 % (harina, agua, azúcar, aceite)
 * y ±20 % (levadura, sal). Sin harina o sin levadura la puntuación cae en picado.
 * @param {{flour?:number,water?:number,yeast?:number,salt?:number,sugar?:number,oil?:number}} amounts
 * @param {string} breadId
 * @param {{past?: boolean}} [opts] past: notas en pasado (para el resultado final)
 * @returns {{rows: Array<{id:string,label:string,unit:string,target:number,current:number,ratio:number,
 *   state:'pending'|'under'|'ok'|'over'}>, score:number, hydration:number, notes:string[], missing:string[]}}
 */
export function ingredientReport(amounts, breadId, opts) {
  const bread = getBread(breadId);
  const past = !!obj(opts).past;
  const a = normAmounts(amounts);
  const h = hydration(a);
  const rows = [];
  const scored = [];
  const missing = [];
  let total = 0;
  let wsum = 0;
  for (const id of INGREDIENT_ORDER) {
    const ing = INGREDIENTS[id];
    const target = bread.recipe[id];
    const current = a[id];
    const tol = ing.tolerance;
    let ratio;
    let state;
    let s;
    if (target > 0) {
      ratio = current / target;
      const d = Math.abs(ratio - 1);
      if (current <= 0) {
        state = 'pending';
        s = 0;
        missing.push(id);
      } else if (d <= tol + 1e-9) {
        state = 'ok';
        s = 100 - (d / tol) * 6;
      } else {
        state = ratio < 1 ? 'under' : 'over';
        s = clamp(94 - ((d - tol) / tol) * 30, 0, 94);
      }
    } else {
      // La receta no lo lleva: cualquier cantidad es "de más" (penalización pequeña)
      const pct = (current / bread.recipe.flour) * 100;
      ratio = current > 0 ? 1 + pct / 5 : 1;
      state = current > 0 ? 'over' : 'ok';
      s = current > 0 ? 100 - Math.min(35, pct * 7) : 100;
    }
    total += s * ING_WEIGHT[id];
    wsum += ING_WEIGHT[id];
    if (target > 0 || current > 0) {
      rows.push({ id, label: ing.label, unit: ing.unit, target, current, ratio: fin(ratio, 1), state });
      if (state !== 'ok') scored.push({ row: rows[rows.length - 1], s });
    }
  }
  let score = total / wsum;
  // la hidratación es lo que más cambia la masa: penaliza si se sale de la ventana
  if (a.flour > 0) {
    const [hLo, hHi] = bread.hydrationIdeal;
    const dist = Math.max(0, hLo - h, h - hHi);
    score -= Math.min(40, (dist / 0.04) * 10);
  }
  if (a.flour <= 0) score = Math.min(score, 5);
  else if (a.yeast <= 0) score = Math.min(score, 25);
  // Notas: primero lo más grave
  scored.sort((x, y) => x.s - y.s);
  const notes = scored.map(({ row }) => ingredientNote(row, bread, h, past)).filter(Boolean);
  // Si harina y agua están bien pero la hidratación se sale (no debería), avisar igualmente
  const eff = a.flour > 0 ? hydrationEffect(h, bread) : null;
  if (eff && !scored.some(({ row }) => row.id === 'flour' || row.id === 'water')) {
    notes.push(`Hidratación del ${fmtPct(h)}: la masa ${past ? 'quedó' : 'quedará'} ${eff}.`);
  }
  return { rows, score: Math.round(clamp(score, 0, 100)), hydration: h, notes, missing };
}

// ---------------------------------------------------------------------------
// Amasado
// ---------------------------------------------------------------------------

const KNEAD_GAIN = 0.08;

/**
 * Un golpe de amasado: el gluten se acerca a 1 con rendimientos decrecientes.
 * Unos 30 golpes buenos (quality = 1) llevan el gluten de 0 a ≥ 0,9.
 * @param {number} gluten desarrollo actual 0..1
 * @param {number} [quality01=1] calidad del golpe 0..1 (escala la ganancia)
 * @returns {number} nuevo gluten 0..1
 */
export function kneadStroke(gluten, quality01 = 1) {
  const g = clamp(num(gluten, 0));
  const q = clamp(num(quality01, 1));
  return clamp(g + (1 - g) * KNEAD_GAIN * q);
}

/**
 * Lo pegajosa que se nota la masa (0 = nada, 1 = muchísimo). La harina extra espolvoreada
 * baja la hidratación efectiva; un gluten desarrollado también la hace menos pegajosa.
 * @param {number} hydrationRatio agua/harina (p. ej. 0.70)
 * @param {number} [extraFlourG=0] harina añadida al amasar (g)
 * @param {number} [flourG=500] harina de la receta pesada (g)
 * @param {number} [gluten=0] desarrollo del gluten 0..1 (opcional)
 * @returns {number} 0..1
 */
export function stickiness(hydrationRatio, extraFlourG = 0, flourG = 500, gluten = 0) {
  const h = pos(hydrationRatio);
  const ex = pos(extraFlourG);
  const f = pos(flourG) > 0 ? pos(flourG) : 500;
  const hEff = (h * f) / (f + ex);
  return clamp(smoothstep(0.55, 0.85, hEff) * (1 - 0.35 * clamp(num(gluten, 0))));
}

/**
 * Prueba de la ventana (estirar un trozo de masa hasta que deje pasar la luz).
 * @param {number} gluten 0..1
 * @returns {{pass: boolean, text: string}}
 */
export function windowpaneTest(gluten) {
  const g = clamp(num(gluten, 0));
  if (g >= 0.8) return { pass: true, text: '¡Prueba de la ventana superada! La masa se estira tan fina que deja pasar la luz sin romperse.' };
  if (g >= 0.62) return { pass: false, text: 'Casi: forma una membrana, pero se rasga antes de transparentar. Unas cuantas amasadas más.' };
  if (g >= 0.35) return { pass: false, text: 'Se estira un poco y se rompe enseguida: el gluten aún está flojo. Sigue amasando.' };
  return { pass: false, text: 'Se desgarra en cuanto tiras: la masa todavía está muy suelta. Toca amasar con ganas.' };
}

// ---------------------------------------------------------------------------
// Fermentación (progreso adimensional p: 1 = la masa dobla su volumen)
// ---------------------------------------------------------------------------

const BASE_PROOF_RATE = 1 / 75; // dp/min a 24 °C con levadura al 1 %
const q10 = (T) => 2 ** ((T - 24) / 10);
const COLD_K = Math.log(0.12 / q10(12)) / (5 - 12); // caída fuerte en frío (≈0,12 a 5 °C)

// Factor de temperatura sobre la actividad de la levadura
function proofTempFactor(T) {
  if (T >= 55) return 0; // levadura muerta
  if (T > 38) {
    const u = (T - 38) / 17;
    return q10(35) * 1.06 * (1 - u) ** 2;
  }
  if (T > 35) return q10(35) * (1 + 0.02 * (T - 35));
  if (T >= 12) return q10(T);
  return q10(12) * Math.exp(COLD_K * (T - 12)) * smoothstep(-2, 2, T);
}

function saltFactor(pct) {
  if (pct <= 2) return 1 + 0.12 * (2 - pct);
  if (pct <= 2.6) return 1 - 0.05 * (pct - 2);
  return Math.max(0.15, 0.97 - 0.25 * (pct - 2.6));
}

function sugarFactor(pct) {
  if (pct <= 5) return 1 + 0.016 * pct;
  if (pct <= 10) return 1.08 - 0.016 * (pct - 5);
  return Math.max(0.2, 1 - 0.05 * (pct - 10));
}

/**
 * Velocidad de fermentación en progreso por minuto simulado.
 * Base 1/75 a 24 °C con levadura al 1 % de la harina. Levadura: (pct/1)^0.6. Temperatura: Q10 ≈ 2
 * entre 12 y 35 °C, caída más fuerte en frío (≈0,12 a 5 °C), declive por encima de 38 °C y 0 a 55 °C.
 * Sal: ≈1 al 2 %, más rápido con poca sal y más lento por encima del 2,6 %. Azúcar: ligero empujón
 * hasta ~5 %, inhibe por encima del 10 %.
 * @param {{amounts?: object, tempC?: number}} env
 * @returns {number} dp/min (0 sin harina o sin levadura)
 */
export function fermentationRate(env) {
  const e = obj(env);
  const a = normAmounts(e.amounts);
  if (a.flour <= 0 || a.yeast <= 0) return 0;
  const T = num(e.tempC, 22);
  const yeastPct = (a.yeast / a.flour) * 100;
  const saltPct = (a.salt / a.flour) * 100;
  const sugarPct = (a.sugar / a.flour) * 100;
  const rate = BASE_PROOF_RATE * yeastPct ** 0.6 * proofTempFactor(T) * saltFactor(saltPct) * sugarFactor(sugarPct);
  return fin(Math.max(0, rate));
}

const RISE_K = -Math.log(1 - 1.1 / 1.6); // para que rise(1) ≈ 2,1

/**
 * Volumen y hundimiento a partir del progreso de fermentación.
 * rise crece suavemente hacia ~2,6 (≈2,1 en p = 1). Pasado p ≈ 1,6 la masa se viene abajo:
 * collapse llega a 1 en p ≈ 2,6 y el volumen se reduce hasta un 35 %.
 * @param {number} p progreso
 * @returns {{rise: number, collapse: number}}
 */
export function riseFromProgress(p) {
  const x = pos(p);
  const base = 1 + 1.6 * (1 - Math.exp(-RISE_K * x ** 1.2));
  const collapse = smoothstep(1.6, 2.6, x);
  return { rise: base * (1 - 0.35 * collapse), collapse };
}

/**
 * Avanza una fermentación dt minutos. No muta la entrada (conserva otros campos que traiga).
 * @param {{minutes?:number,tempC?:number,p?:number}} proof estado anterior (puede ser {} o undefined)
 * @param {number} dtMinutes minutos simulados
 * @param {{amounts?: object, tempC?: number}} env cantidades y temperatura del sitio
 * @returns {{minutes:number,tempC:number,p:number,rise:number,collapse:number,coldMin:number,degMin:number}}
 */
export function proofStep(proof, dtMinutes, env) {
  const p0 = obj(proof);
  const e = obj(env);
  const dt = pos(dtMinutes);
  const tempC = num(e.tempC, num(p0.tempC, 22));
  const rate = fermentationRate({ amounts: e.amounts, tempC });
  const p = pos(p0.p) + rate * dt;
  const { rise, collapse } = riseFromProgress(p);
  // minutos en frío y grados·minuto: para la temperatura media y el bonus de reposo en frío
  const coldMin = pos(p0.coldMin) + (tempC <= 8 ? dt : 0);
  const degMin = pos(p0.degMin) + tempC * dt;
  return { ...p0, minutes: pos(p0.minutes) + dt, tempC, p, rise, collapse, coldMin, degMin };
}

/**
 * Estado inicial de una fermentación.
 * @param {number} [tempC=22]
 * @returns {{minutes:number,tempC:number,p:number,rise:number,collapse:number,coldMin:number,degMin:number}}
 */
export function initialProof(tempC = 22) {
  return { minutes: 0, tempC: num(tempC, 22), p: 0, rise: 1, collapse: 0, coldMin: 0, degMin: 0 };
}

/**
 * Clasifica el progreso de fermentación respecto a una ventana ideal.
 * @param {number} p
 * @param {[number, number]} [ideal=[0.85, 1.3]]
 * @returns {'under'|'ok'|'over'}
 */
export function proofStatus(p, ideal = [0.85, 1.3]) {
  const [lo, hi] = normWindow(ideal, [0.85, 1.3]);
  const x = pos(p);
  if (x < lo) return 'under';
  if (x > hi) return 'over';
  return 'ok';
}

function normWindow(w, def) {
  const arr = Array.isArray(w) ? w : def;
  const lo = pos(arr[0], def[0]);
  const hi = Math.max(lo, pos(arr[1], def[1]));
  return [lo, hi];
}

/**
 * Prueba del dedo: hundir un dedo en la masa y ver cuánto tarda en recuperarse.
 * @param {number} p progreso de fermentación
 * @param {[number, number]} [ideal=[0.85, 1.3]] ventana ideal (usa proof1Ideal o proof2Ideal)
 * @returns {{result:'under'|'ok'|'over', recoverySeconds:number, text:string}}
 */
export function pokeTest(p, ideal = [0.85, 1.3]) {
  const [lo, hi] = normWindow(ideal, [0.85, 1.3]);
  const x = pos(p);
  const result = proofStatus(x, [lo, hi]);
  let recoverySeconds;
  let text;
  if (result === 'under') {
    recoverySeconds = lerp(0.25, 0.6, clamp(x / Math.max(lo, 1e-6)));
    text = x < lo * 0.5
      ? 'La masa rebota al instante, tensa como un balón: le falta mucho. Dale bastante más tiempo.'
      : 'El hueco vuelve enseguida: todavía le falta un poco de fermentación. Espera un rato más.';
  } else if (result === 'ok') {
    recoverySeconds = lerp(1.5, 2.6, clamp((x - lo) / Math.max(hi - lo, 1e-6)));
    text = 'El hueco vuelve despacio y deja una marquita: ¡fermentación en su punto!';
  } else {
    recoverySeconds = 6 + 6 * clamp((x - hi) / 0.8);
    text = x > hi + 0.5
      ? 'El hueco no vuelve y la masa suspira y se hunde: se ha pasado de fermentación.'
      : 'El hueco apenas se recupera: se está pasando. ¡A la siguiente fase cuanto antes!';
  }
  return { result, recoverySeconds, text };
}

// ---------------------------------------------------------------------------
// Horno
// ---------------------------------------------------------------------------

/** Temperatura de la cocina (°C). */
export const ROOM_C = 22;
const OVEN_MAX_RATE = 18; // °C/min calentando
const OVEN_APPROACH = 0.6; // 1/min cerca del objetivo
const OVEN_LOSS_CLOSED = 0.025; // 1/min de pérdidas con la puerta cerrada
const OVEN_LOSS_OPEN = -Math.log(0.75); // ≈ -25 %/min del exceso con la puerta abierta

/**
 * Estado inicial del horno (apagado, a temperatura ambiente).
 * @returns {{tempC:number,targetC:number,on:boolean,doorOpen:boolean}}
 */
export function initialOven() {
  return { tempC: ROOM_C, targetC: 0, on: false, doorOpen: false };
}

/**
 * Avanza el horno dt minutos. Encendido calienta a ~18 °C/min y frena al acercarse al objetivo
 * (termostato sin rebote apreciable); con la puerta abierta pierde ~25 %/min del exceso sobre la
 * cocina; apagado se enfría despacio. No muta la entrada (conserva otros campos).
 * @param {{tempC?:number,targetC?:number,on?:boolean,doorOpen?:boolean}} oven
 * @param {number} dtMinutes
 * @returns {{tempC:number,targetC:number,on:boolean,doorOpen:boolean}}
 */
export function ovenStep(oven, dtMinutes) {
  const o = obj(oven);
  let T = num(o.tempC, ROOM_C);
  const targetC = clamp(num(o.targetC, 0), 0, 300);
  const on = !!o.on;
  const doorOpen = !!o.doorOpen;
  let rem = Math.min(pos(dtMinutes), 24 * 60);
  while (rem > 1e-9) {
    const h = Math.min(0.05, rem);
    rem -= h;
    const closedLoss = OVEN_LOSS_CLOSED * (T - ROOM_C);
    const loss = (doorOpen ? OVEN_LOSS_OPEN : OVEN_LOSS_CLOSED) * (T - ROOM_C);
    let heat = 0;
    if (on && T < targetC) {
      // la resistencia compensa las pérdidas normales y empuja hacia el objetivo
      heat = Math.max(0, Math.min(OVEN_MAX_RATE, OVEN_APPROACH * (targetC - T)) + closedLoss);
    }
    T += (heat - loss) * h;
  }
  return { ...o, tempC: fin(T, ROOM_C), targetC, on, doorOpen };
}

/**
 * Estado del piloto del horno.
 * @param {{tempC?:number,targetC?:number,on?:boolean}} oven
 * @returns {'off'|'heating'|'ready'} 'ready' si está a ±6 °C del objetivo
 */
export function ovenStatus(oven) {
  const o = obj(oven);
  if (!o.on) return 'off';
  return Math.abs(num(o.tempC, ROOM_C) - num(o.targetC, 0)) <= 6 ? 'ready' : 'heating';
}

// ---------------------------------------------------------------------------
// Horneado
// ---------------------------------------------------------------------------

// Parámetros térmicos por forma (constantes de tiempo a 230 °C, en minutos)
const SHAPE_BAKE = {
  boule: { tau1: 6.0, tau2: 4.0, dry: 0.128 },
  baguette: { tau1: 3.2, tau2: 2.2, dry: 0.45 },
  loaf: { tau1: 5.5, tau2: 3.6, dry: 0.39 }, // la parte de arriba del molde se seca rápido
};
const SHAPE_ALIAS = { ball: 'boule', shaggy: 'boule' };
const STEAM_MINUTES = 10; // el vapor actúa los primeros minutos
const INTERNAL_PLATEAU = 99; // el agua no deja que el centro pase de ~99 °C
const SET_CRUST = 0.22; // corteza "cuajada y pálida"
const BROWN_RATE = 0.024;
const BROWN_TE = 45; // el tostado se duplica cada ~31 °C de superficie
const SURFACE_FRAC = 0.79; // superficie seca ≈ 100 + 0,79·(horno − 100)
const STEAM_DRY = 0.33; // con vapor la superficie se seca a un tercio de velocidad
const STEAM_BROWN = 0.83; // y se dora algo más despacio
const BROWN_SAT = 0.3; // el tostado se frena un poco cuando la corteza ya está oscura

function shapeParams(shape) {
  const id = SHAPE_ALIAS[shape] || shape;
  return SHAPE_BAKE[id] || SHAPE_BAKE.boule;
}

/**
 * Potencial de subida en el horno (oven spring) y su irregularidad.
 * @param {{proofP?:number, proofIdeal?:[number,number], gluten?:number, steam?:boolean,
 *   scored?:boolean, shape?:string, yeastPct?:number}} opts
 * @returns {{max:number, irregular:number}} max ≥ 1 (≈1,3 ideal); irregular 0..1 (desgarros)
 */
export function springPotential(opts) {
  const o = obj(opts);
  const [lo, hi] = normWindow(o.proofIdeal, [0.55, 0.9]);
  const p = pos(o.proofP, (lo + hi) / 2);
  const yeastPct = pos(o.yeastPct, 1);
  if (yeastPct <= 0.02) return { max: 1.03, irregular: 0.1 };
  let base;
  let irregular;
  if (p < lo) {
    // poco fermentado: subida explosiva e irregular (sin gas previo casi no sube)
    const u = clamp(p / Math.max(lo, 1e-6));
    base = 0.38 * smoothstep(0, 0.25, u) + 0.06 * (1 - smoothstep(0, 0.25, u));
    irregular = 0.3 + 0.6 * (1 - u);
  } else if (p <= hi) {
    base = 0.3;
    irregular = 0.05;
  } else {
    base = 0.04 + 0.26 * (1 - smoothstep(hi, hi + 0.9, p));
    irregular = 0.1 + 0.2 * smoothstep(hi, hi + 1, p);
  }
  const g = clamp(num(o.gluten, 0.6));
  base *= lerp(0.35, 1, smoothstep(0.2, 0.85, g));
  if (!o.steam) base *= 0.85;
  const isLoaf = (SHAPE_ALIAS[o.shape] || o.shape) === 'loaf';
  if (!isLoaf && !o.scored) {
    base *= 0.85;
    irregular += 0.35;
  }
  return { max: 1 + base, irregular: clamp(irregular) };
}

/**
 * Estado inicial de un horneado.
 * @param {number} [doughC=24] temperatura de la masa al entrar al horno
 * @returns {object} bake inicial
 */
export function initialBake(doughC = 24) {
  const c = num(doughC, 24);
  return { minutes: 0, crust: 0, internalC: c, shellC: c, surfaceC: c, spring: 1, moisture: 1, brown: 0, burst: 0, burnt: false };
}

/**
 * Avanza el horneado dt minutos.
 * - Centro: dos etapas térmicas (miga externa → centro), más rápido en baguette; meseta a ~99 °C.
 * - Corteza: humedad superficial que se seca (el vapor la mantiene húmeda los primeros 10 min);
 *   la superficie no pasa de 100 °C mientras está húmeda; tostado tipo Maillard a partir de ~140 °C,
 *   creciente con la temperatura; huevo (+25 %) y azúcar (hasta +25 %) aceleran el dorado.
 * - Oven spring: los primeros minutos, mientras el centro está por debajo de ~60 °C y la corteza blanda.
 * No muta la entrada (conserva otros campos como targetC, steam, doorOpenings...).
 * @param {object} bake estado anterior ({} o undefined = recién metido, masa a 24 °C)
 * @param {number} dtMinutes
 * @param {{ovenC?:number, steam?:boolean, eggwash?:boolean, sugarPct?:number, shape?:string,
 *   proofP?:number, proofIdeal?:[number,number], gluten?:number, scored?:boolean, yeastPct?:number}} opts
 * @returns {{minutes:number, crust:number, internalC:number, shellC:number, surfaceC:number, spring:number,
 *   springMax:number, moisture:number, brown:number, burst:number, burnt:boolean}}
 */
export function bakeStep(bake, dtMinutes, opts) {
  const b = obj(bake);
  const o = obj(opts);
  const ovenC = num(o.ovenC, ROOM_C);
  const steam = !!o.steam;
  const sp = shapeParams(o.shape);
  const sugarPct = pos(o.sugarPct);
  const boost = (o.eggwash ? 1.25 : 1) * (1 + 0.25 * smoothstep(0, 5, sugarPct));
  const { max: springMax, irregular } = springPotential(o);

  const startMin = pos(b.minutes);
  const dt = Math.min(pos(dtMinutes), 6 * 60);
  let minutes = startMin;
  let internalC = num(b.internalC, 24);
  let shellC = num(b.shellC, internalC);
  let m = clamp(num(b.moisture, 1));
  let brown = Number.isFinite(b.brown) ? Math.max(0, b.brown) : Math.max(0, num(b.crust, 0) - SET_CRUST * (1 - m));
  let spring = Math.max(1, num(b.spring, 1));
  let surfaceC = num(b.surfaceC, internalC);

  // velocidad térmica según la temperatura del horno
  const drive = Math.max(0.05, (ovenC - 20) / 210) ** 0.8;
  const plateau = Math.min(INTERNAL_PLATEAU, ovenC - 5);
  const dryDrive = clamp((ovenC - 100) / 130, 0, 1.6);
  const springRate = 2.4 / sp.tau1;
  const heatOk = smoothstep(110, 200, ovenC);

  let rem = dt;
  while (rem > 1e-9) {
    const h = Math.min(0.1, rem);
    rem -= h;
    const steamOn = steam && minutes < STEAM_MINUTES;
    // temperatura interna (dos etapas)
    shellC += (plateau - shellC) * Math.min(1, (h * drive) / sp.tau1);
    internalC += (shellC - internalC) * Math.min(1, (h * drive) / sp.tau2);
    // humedad superficial y temperatura de la superficie
    m -= m * Math.min(1, sp.dry * dryDrive * (steamOn ? STEAM_DRY : 1) * h);
    surfaceC = ovenC <= 100 ? Math.min(ovenC, Math.max(surfaceC, internalC)) : 100 + (ovenC - 100) * SURFACE_FRAC * (1 - m);
    // tostado (Maillard): nada por debajo de ~140 °C, crece con la temperatura
    const crustNow = SET_CRUST * (1 - m) + brown;
    const g = smoothstep(140, 177, surfaceC) * Math.exp((surfaceC - 190) / BROWN_TE) * (1 - BROWN_SAT * smoothstep(0.55, 1.3, crustNow));
    brown += BROWN_RATE * boost * g * (steamOn ? STEAM_BROWN : 1) * h;
    // subida en el horno
    const soft = steamOn ? 1 : smoothstep(0.15, 0.7, m);
    const active = (1 - smoothstep(48, 62, internalC)) * soft * heatOk;
    if (spring < springMax) spring += (springMax - spring) * Math.min(1, springRate * active * h);
    minutes += h;
  }
  minutes = startMin + dt; // exacto, sin acumular error de coma flotante
  const crust = clamp(SET_CRUST * (1 - m) + brown, 0, 1.4);
  const springProgress = springMax > 1.0001 ? clamp((spring - 1) / (springMax - 1)) : 0;
  return {
    ...b,
    minutes,
    crust: fin(crust),
    internalC: fin(internalC, 24),
    shellC: fin(shellC, 24),
    surfaceC: fin(surfaceC, 24),
    spring: fin(spring, 1),
    springMax: fin(springMax, 1),
    moisture: fin(m, 1),
    brown: fin(brown),
    burst: fin(irregular * springProgress),
    burnt: crust >= 1.2,
  };
}

// Parámetros de horneado recomendados para un pan
function bakeOptsFor(bread, extra) {
  const e = obj(extra);
  const r = bread.recipe;
  return {
    ovenC: num(e.ovenC, bread.bake.tempC),
    steam: e.steam !== undefined ? !!e.steam : bread.bake.steam !== 'no',
    eggwash: e.eggwash !== undefined ? !!e.eggwash : bread.toppings.suggested === 'eggwash',
    sugarPct: (r.sugar / r.flour) * 100,
    shape: typeof e.shape === 'string' ? e.shape : bread.shape, // la forma real (una barra hecha bola tarda más)
    proofP: (bread.proof2Ideal[0] + bread.proof2Ideal[1]) / 2,
    proofIdeal: bread.proof2Ideal,
    gluten: 0.9,
    scored: true,
    yeastPct: (r.yeast / r.flour) * 100,
  };
}

const bakeWindowCache = new Map();

/**
 * Ventana ideal de horneado simulada: desde que la corteza entra en su rango ideal con el centro
 * a ≥ 95 °C hasta que se sale por arriba.
 * @param {string} breadId
 * @param {{ovenC?:number, steam?:boolean, eggwash?:boolean, shape?:string}} [opts] por defecto, lo recomendado
 *   (shape: la forma que se le dio a la masa; por defecto, la de la receta)
 * @returns {{tempC:number, steam:boolean, minutes:[number,number]|null, crustIdeal:[number,number],
 *   recipeMinutes:[number,number]}} minutes = null si a esa temperatura nunca queda bien
 */
export function idealBakeWindow(breadId, opts) {
  const bread = getBread(breadId);
  const bo = bakeOptsFor(bread, opts);
  const key = `${bread.id}|${bo.ovenC}|${bo.steam}|${bo.eggwash}|${bo.shape}`;
  if (bakeWindowCache.has(key)) return bakeWindowCache.get(key);
  const [cLo, cHi] = bread.bake.crustIdeal;
  let bk = initialBake(24);
  let lo = null;
  let hi = null;
  for (let t = 0; t < 120; t += 0.25) {
    bk = bakeStep(bk, 0.25, bo);
    const okNow = bk.crust >= cLo && bk.crust <= cHi && bk.internalC >= 95;
    if (okNow && lo === null) lo = bk.minutes;
    if (okNow) hi = bk.minutes;
    if (bk.crust > cHi) break;
  }
  const res = deepFreeze({
    tempC: bo.ovenC,
    steam: bo.steam,
    minutes: lo === null ? null : [Math.ceil(lo), Math.floor(hi)],
    crustIdeal: [cLo, cHi],
    recipeMinutes: [...bread.bake.minutes],
  });
  bakeWindowCache.set(key, res);
  return res;
}

/**
 * Minutos simulados para que una fermentación llegue a su ventana ideal.
 * @param {{amounts?: object, tempC?: number}} env
 * @param {[number, number]} idealWindow p. ej. BREADS.hogaza.proof1Ideal
 * @param {number} [fromP=0] progreso ya alcanzado
 * @returns {[number, number]|null} [minLo, minHi] o null si la masa no puede fermentar
 */
export function idealProofMinutes(env, idealWindow, fromP = 0) {
  const rate = fermentationRate(env);
  if (!(rate > 0)) return null;
  const [lo, hi] = normWindow(idealWindow, [0.85, 1.3]);
  const p0 = pos(fromP);
  return [Math.max(0, (lo - p0) / rate), Math.max(0, (hi - p0) / rate)];
}

/**
 * Ayudas de estimación para el modo guiado.
 * @type {{idealProofMinutes: typeof idealProofMinutes, idealBakeWindow: typeof idealBakeWindow}}
 */
export const ESTIMATES = Object.freeze({ idealProofMinutes, idealBakeWindow });

// ---------------------------------------------------------------------------
// Miga
// ---------------------------------------------------------------------------

function proofDeviation(P, [lo, hi]) {
  return {
    under: clamp((lo - P) / Math.max(lo, 1e-6)),
    over: clamp((P - hi) / 1.0),
  };
}

/**
 * Aspecto de la miga a partir del estado de la partida (para dough.setCut()).
 * Más hidratación + buen gluten + buena fermentación → miga abierta. Poco fermentado → densa con
 * algún túnel. Pasado → hundida con agujeros grandes e irregulares. Centro < 93 °C → gomosa.
 * @param {object} state estado de la partida (ver evaluate)
 * @returns {{openness:number, density:number, gumminess:number, tunnels:number}} todos 0..1
 */
export function crumbFromState(state) {
  const s = obj(state);
  const bread = getBread(s.breadId);
  const a = normAmounts(s.amounts);
  const knead = obj(s.knead);
  const gluten = clamp(num(knead.gluten, 0));
  const extra = pos(knead.extraFlour);
  const hEff = a.flour > 0 ? a.water / (a.flour + extra) : 0;
  const p1 = obj(s.proof1);
  const p2 = obj(s.proof2);
  const P1 = pos(p1.p);
  const P2 = pos(p2.p);
  const bake = obj(s.bake);
  const baked = Number.isFinite(num(bake.internalC, NaN)) && pos(bake.minutes, 1) > 0;
  const internalC = num(bake.internalC, 24);
  const noYeast = a.flour > 0 && a.yeast <= 0;

  const d1 = proofDeviation(P1, bread.proof1Ideal);
  const d2 = proofDeviation(P2, bread.proof2Ideal);
  const under = clamp(0.45 * d1.under + 0.55 * d2.under + 0.3 * Math.min(d1.under, d2.under));
  const collapse = Math.max(clamp(num(p1.collapse, riseFromProgress(P1).collapse)), clamp(num(p2.collapse, riseFromProgress(P2).collapse)));
  const over = clamp(Math.max(d1.over, d2.over * 1.2));
  const spring = Math.max(1, num(bake.spring, 1));
  const oilPct = a.flour > 0 ? (a.oil / a.flour) * 100 : 0;

  // Gumminess: centro poco hecho
  let gumminess = baked ? 1 - smoothstep(82, 95, internalC) : 1;
  if (hEff > 0.8) gumminess += 0.1 * smoothstep(0.8, 0.9, hEff);
  // demasiada agua: la masa se desparrama, sin estructura → miga más cerrada y pastosa
  const hi = bread.hydrationIdeal[1];
  const slack = smoothstep(hi + 0.05, hi + 0.3, hEff);
  gumminess = clamp(gumminess + 0.3 * slack);

  if (a.flour <= 0) return { openness: 0, density: 1, gumminess: 1, tunnels: 0 };
  if (noYeast) return { openness: 0.03, density: 1, gumminess: clamp(Math.max(gumminess, 0.25)), tunnels: 0.05 };

  let openness = 0.1 + 0.9 * smoothstep(0.56, 0.8, hEff);
  openness *= lerp(0.3, 1, smoothstep(0.3, 0.88, gluten));
  openness *= 1 - 0.65 * under;
  openness *= 1 - 0.25 * smoothstep(0, 6, oilPct);
  openness *= lerp(0.6, 1, smoothstep(1.0, 1.22, spring));
  openness *= 1 - 0.6 * slack;
  openness = clamp(openness + 0.25 * over * (1 - collapse * 0.5));

  const rise2 = num(p2.rise, riseFromProgress(P2).rise);
  const riseTotal = Math.max(1, rise2) * spring;
  let density = clamp(1 - (riseTotal - 1) / 1.5) + 0.35 * collapse + 0.25 * under;
  density = clamp(density + 0.3 * slack);

  const tunnels = clamp(0.05 + 0.45 * under * smoothstep(0, 0.1, P1 + P2) + 0.7 * over + 0.5 * collapse);
  return { openness: fin(openness), density: fin(density, 1), gumminess: fin(gumminess, 1), tunnels: fin(tunnels) };
}

// ---------------------------------------------------------------------------
// Evaluación final
// ---------------------------------------------------------------------------

const SECTION_WEIGHTS = { ingredients: 0.2, knead: 0.15, proof: 0.25, shape: 0.1, bake: 0.3 };
const SECTION_LABELS = {
  ingredients: 'Ingredientes',
  knead: 'Amasado',
  proof: 'Fermentación',
  shape: 'Formado y greñado',
  bake: 'Horneado',
};
const SECTION_FOCUS = {
  ingredients: 'el pesado de los ingredientes',
  knead: 'el amasado',
  proof: 'los tiempos de fermentación',
  shape: 'el formado y los cortes',
  bake: 'el horneado',
};
const BREAD_ARTICLE = { hogaza: 'una', baguette: 'una', molde: 'un' };
const TOPPING_NOTES = {
  flour: 'El velo de harina remata las greñas.',
  eggwash: 'El huevo le dio un brillo precioso.',
  sesame: 'El sésamo le aporta un toque tostado.',
  poppy: 'Las semillas de amapola le quedan de lujo.',
};
// Segunda cobertura junto al huevo ('eggwash+sesame'…), para una sola frase
const SEED_SHORT = { sesame: 'el sésamo, un toque tostado', poppy: 'la amapola, un punto crujiente', flour: 'la harina, un acabado rústico' };
const SHAPE_NAMES = {
  boule: 'una hogaza redonda',
  baguette: 'una barra',
  loaf: 'un pan de molde',
  ball: 'una bola sin formar',
  shaggy: 'un amasijo sin formar',
};

function crustWord(c, bread) {
  if (c < 0.3) return 'muy pálida';
  if (c < 0.5) return 'pálida';
  if (c < 0.66) return 'dorada clara';
  if (c <= 0.88) return bread && bread.id === 'molde' ? 'dorada y tierna' : 'dorada y crujiente';
  if (c < 1.05) return 'muy tostada';
  if (c < 1.2) return 'casi quemada';
  return 'quemada';
}

// Puntuación de una fermentación respecto a su ventana
function proofScore(P, [lo, hi]) {
  if (P >= lo && P <= hi) {
    const mid = (lo + hi) / 2;
    return 100 - (10 * Math.abs(P - mid)) / Math.max((hi - lo) / 2, 1e-6);
  }
  if (P < lo) return 90 * clamp(P / lo) ** 1.5;
  return clamp(90 - (P - hi) * 110, 0, 90);
}

function sectionIngredients(a, bread) {
  const rep = ingredientReport(a, bread.id, { past: true });
  let note = rep.notes.slice(0, 2).join(' ');
  if (!note) {
    note = `Pesaste todo con precisión: ${fmtAmount(a.flour)} g de harina y ${fmtAmount(a.water)} ml de agua, una hidratación del ${fmtPct(rep.hydration)}.`;
  }
  return { score: rep.score, note, report: rep };
}

function sectionKnead(s, a, bread) {
  const knead = obj(s.knead);
  const mix = clamp(num(s.mix, 0));
  const gluten = clamp(num(knead.gluten, 0));
  const strokes = Math.round(pos(knead.strokes));
  const extra = pos(knead.extraFlour);
  const mixScore = mix >= 0.95 ? 100 : mix * 100;
  let gScore;
  if (gluten >= 0.85) gScore = 100;
  else if (gluten >= 0.7) gScore = lerp(78, 100, (gluten - 0.7) / 0.15);
  else if (gluten >= 0.5) gScore = lerp(52, 78, (gluten - 0.5) / 0.2);
  else gScore = lerp(5, 52, gluten / 0.5);
  let score = 0.25 * mixScore + 0.75 * gScore;
  const extraPct = a.flour > 0 ? (extra / a.flour) * 100 : 0;
  if (extraPct > 6) score -= Math.min(30, (extraPct - 6) * 2.5);
  score = clamp(score, 0, 100);

  const parts = [];
  if (mix <= 0.05) parts.push('No llegaste a mezclar: quedó harina seca por todas partes.');
  else if (mix < 0.6) parts.push(`La mezcla se quedó a medias (${fmtPct(mix)}): quedaron grumos de harina seca dentro de la masa.`);
  const amasadas = strokes > 0 ? (strokes === 1 ? '1 amasada' : `${strokes} amasadas`) : 'el amasado';
  if (gluten >= 0.8) {
    // la ventana solo se menciona si el jugador hizo la prueba
    const doneTxt = knead.windowpane ? 'la masa pasó la prueba de la ventana.' : 'la masa quedó lisa y elástica.';
    parts.push(strokes > 0
      ? `Con ${amasadas} el gluten llegó al ${fmtPct(gluten)}: ${doneTxt}`
      : `El gluten llegó al ${fmtPct(gluten)}: ${doneTxt}`);
  } else if (gluten >= 0.6) {
    parts.push(`Con ${amasadas} el gluten se quedó en el ${fmtPct(gluten)}: le faltaron unos minutos para estar elástica.`);
  } else if (strokes > 0 || gluten > 0) {
    parts.push(`Con solo ${amasadas} el gluten se quedó en el ${fmtPct(gluten)}: la masa no retuvo bien el gas y la miga salió más cerrada.`);
  } else {
    parts.push('No llegaste a amasar: sin gluten, la masa no pudo atrapar el gas.');
  }
  if (extraPct > 6 && a.flour > 0) {
    const h0 = a.water / a.flour;
    const h1 = a.water / (a.flour + extra);
    parts.push(`Además añadiste ${fmtAmount(extra)} g de harina al amasar: la hidratación bajó del ${fmtPct(h0)} al ${fmtPct(h1)}.`);
  }
  return { score, note: parts.slice(0, 2).join(' '), gluten, mix };
}

function sectionProof(s, a, bread, noYeast, noFlour) {
  const p1 = obj(s.proof1);
  const p2 = obj(s.proof2);
  const P1 = pos(p1.p);
  const P2 = pos(p2.p);
  const m1 = pos(p1.minutes);
  const m2 = pos(p2.minutes);
  const T1 = num(p1.tempC, 22);
  const T2 = num(p2.tempC, T1);
  // temperatura media de cada fermentación (tempC es solo el último sitio elegido)
  const avgT = (pr, m, T) => (m > 0 && num(pr.degMin) > 0 ? num(pr.degMin) / m : T);
  const T1avg = avgT(p1, m1, T1);
  const T2avg = avgT(p2, m2, T2);
  const c1 = clamp(num(p1.collapse, riseFromProgress(P1).collapse));
  const c2 = clamp(num(p2.collapse, riseFromProgress(P2).collapse));
  const collapse = Math.max(c1, c2);
  const st1 = proofStatus(P1, bread.proof1Ideal);
  const st2 = proofStatus(P2, bread.proof2Ideal);
  if (noFlour) return { score: 0, note: 'Sin harina no había masa que fermentar.', st1, st2, collapse, P1, P2 };
  if (noYeast) {
    const note = m1 + m2 > 0
      ? `Sin levadura no hubo fermentación: tras ${fmtMinutes(m1 + m2)} de espera, la masa seguía igual que al principio.`
      : 'Sin levadura no hubo fermentación: la masa no creció ni un milímetro.';
    return { score: 0, note, st1, st2, collapse, P1, P2 };
  }
  const s1 = proofScore(P1, bread.proof1Ideal);
  const s2 = proofScore(P2, bread.proof2Ideal);
  let score = 0.55 * s1 + 0.45 * s2 - 40 * collapse;
  // bonus de frío: al menos 2 h en la nevera (estados antiguos sin coldMin: último sitio)
  const coldOf = (pr, m, T) => (pr.coldMin === undefined ? m > 0 && T <= 8 : pos(pr.coldMin) >= 120);
  const cold = coldOf(p1, m1, T1) || coldOf(p2, m2, T2);
  if (cold && st1 === 'ok') score += 3;
  score = clamp(score, 0, 100);

  const rise1 = num(p1.rise, riseFromProgress(P1).rise);
  const where = (T) => `a ${fmtC(T)}`;
  // parte en la nevera y parte fuera → «en la nevera y a 22 °C» (la nevera está a 5 °C)
  const whereP = (pr, m, Tavg) => {
    const cm = pos(pr.coldMin);
    if (cm > 30 && cm < m - 30) return `en la nevera y ${where((num(pr.degMin) - 5 * cm) / (m - cm))}`;
    return where(Tavg);
  };
  const w1 = whereP(p1, m1, T1avg);
  const w2 = whereP(p2, m2, T2avg);
  const d1 = () => {
    if (st1 === 'under') {
      if (P1 < 0.05) return 'Te saltaste la primera fermentación: la masa no tuvo tiempo de crecer ni de coger sabor.';
      return `La primera fermentación se quedó corta (${fmtMinutes(m1)} ${w1}): la masa solo creció un ${Math.round((rise1 - 1) * 100)} %.`;
    }
    if (st1 === 'over') {
      return c1 > 0.3
        ? `La primera fermentación se pasó (${fmtMinutes(m1)} ${w1}): la masa creció de más y se vino abajo.`
        : `La primera fermentación se alargó (${fmtMinutes(m1)} ${w1}) y la masa perdió fuerza.`;
    }
    return null;
  };
  const d2 = () => {
    if (st2 === 'under') {
      if (P2 < 0.05) return 'Sin segunda fermentación, el pan entró al horno tenso: se abrió a lo bruto y la miga quedó apretada.';
      return `La segunda fermentación fue corta (${fmtMinutes(m2)}): el pan reventó en el horno y la miga quedó apretada.`;
    }
    if (st2 === 'over') {
      return c2 > 0.3
        ? `La segunda fermentación se pasó (${fmtMinutes(m2)}): el pan se desinfló antes de entrar al horno.`
        : `La segunda fermentación se alargó (${fmtMinutes(m2)}): el pan llegó al horno sin fuerza y apenas subió.`;
    }
    return null;
  };
  const parts = [];
  const where2 = w2 !== w1 ? ` ${w2}` : '';
  if (st1 === 'ok' && st2 === 'ok') {
    parts.push(`Primera fermentación de ${fmtMinutes(m1)} ${w1} y segunda de ${fmtMinutes(m2)}${where2}: la masa dobló su volumen y llegó al horno en su punto.`);
  } else if (st1 === 'under' && st2 === 'under' && P1 >= 0.05 && P2 >= 0.05) {
    parts.push(`Las dos fermentaciones se quedaron cortas (${fmtMinutes(m1)} ${w1} y ${fmtMinutes(m2)} ${w2}): el pan reventó en el horno y la miga salió densa y apretada.`);
  } else if (st1 === 'over' && st2 === 'over') {
    parts.push(`Las dos fermentaciones se pasaron (${fmtMinutes(m1)} ${w1} y ${fmtMinutes(m2)} ${w2}): la masa se quedó sin fuerza y el pan salió chato y con sabor ácido.`);
  } else {
    const n1 = d1();
    const n2 = d2();
    const ordered = s1 <= s2 ? [n1, n2] : [n2, n1];
    for (const n of ordered) if (n) parts.push(n);
    if (!n1) parts.push('La primera, en cambio, estuvo en su punto.');
    else if (!n2) parts.push('La segunda, en cambio, estuvo en su punto.');
  }
  if (cold && st1 === 'ok' && parts.length < 2) parts.push('El reposo en frío le dio un sabor más profundo.');
  return { score, note: parts.slice(0, 2).join(' '), st1, st2, collapse, P1, P2 };
}

function sectionShape(s, bread) {
  const sh = obj(s.shape);
  const shapeId = typeof sh.shape === 'string' ? sh.shape : null;
  const cuts = Math.round(pos(sh.scores));
  const topping = typeof sh.topping === 'string' ? sh.topping : 'none';
  // los cortes se valoran según la forma que tiene de verdad (una barra pide greñas aunque sea masa de molde)
  const rules = shapeId && shapeId !== bread.shape
    ? (Object.values(BREADS).find((b) => b.shape === shapeId)?.scoring ?? bread.scoring)
    : bread.scoring;
  const { min, max } = rules;
  const parts = [];
  let score = 100;
  let wrongShape = false;
  if (!shapeId) {
    return { score: 45, note: 'No llegaste a formar el pan: entró al horno tal cual salió del bol.', wrongShape: false, cuts };
  } else if (shapeId !== bread.shape) {
    wrongShape = true;
    score -= 25;
    parts.push(`Formaste ${SHAPE_NAMES[shapeId] || 'una forma libre'} en lugar de ${SHAPE_NAMES[bread.shape]}: rico igual, pero no es lo que pedía la receta.`);
  }
  if (min === 0) {
    if (cuts > max) {
      score -= Math.min(20, 6 * (cuts - max));
      parts.push(`Le hiciste ${cuts} cortes y ${shapeId === 'loaf' ? 'el pan de molde' : 'esta forma'} no los necesita: con uno o ninguno basta.`);
    }
  } else if (cuts === 0) {
    score -= 35;
    parts.push('Sin greñas, el pan se abrió por donde quiso y la corteza se rasgó de lado.');
  } else if (cuts < min) {
    score -= 12 * (min - cuts);
    parts.push(`Con ${cuts} ${cuts === 1 ? 'corte' : 'cortes'} se quedó corto: ${rules.suggestion}`);
  } else if (cuts > max) {
    score -= Math.min(40, 8 * (cuts - max));
    parts.push(`Con ${cuts} cortes la superficie quedó como un acordeón: con ${min}–${max} basta.`);
  }
  if (!parts.length) {
    const cutTxt = cuts === 0 ? 'sin cortes' : `con ${cuts} ${cuts === 1 ? 'corte limpio' : 'cortes limpios'}`;
    const formed = bread.id === 'molde' ? 'Bien formado' : 'Bien formada';
    parts.push(`${formed} y ${cutTxt}: justo lo que pide ${BREAD_ARTICLE[bread.id] || 'el'} ${bread.name.toLowerCase()}.`);
    const tops = topping.split('+').filter((t) => TOPPING_NOTES[t]);
    const other = tops.find((t) => t !== 'eggwash');
    if (tops.length === 1) parts.push(TOPPING_NOTES[tops[0]]);
    else if (tops.length > 1 && tops.includes('eggwash') && SEED_SHORT[other]) parts.push(`El huevo le dio brillo y ${SEED_SHORT[other]}.`);
    else if (tops.length > 1) parts.push(TOPPING_NOTES[tops[0]]);
  }
  return { score: clamp(score, 0, 100), note: parts.slice(0, 2).join(' '), wrongShape, cuts };
}

function sectionBake(s, bread) {
  const bk = obj(s.bake);
  const minutes = pos(bk.minutes);
  const internalC = num(bk.internalC, 24);
  const crust = clamp(num(bk.crust, 0), 0, 1.4);
  const targetC = num(bk.targetC, NaN);
  const steam = !!bk.steam;
  const preheated = bk.preheated !== false;
  const doors = Math.round(pos(bk.doorOpenings));
  const [cLo, cHi] = bread.bake.crustIdeal;
  const raw = minutes <= 0 || internalC < 60;
  const burnt = crust >= 1.2 || bk.burnt === true;
  const underbaked = !raw && internalC < 93;

  let crustScore;
  if (crust >= cLo && crust <= cHi) crustScore = 100;
  else if (crust < cLo) crustScore = clamp(100 - ((cLo - crust) / 0.4) * 100, 0, 100);
  else crustScore = clamp(100 - ((crust - cHi) / 0.3) * 100, 0, 100);
  let coreScore;
  if (internalC >= 95) coreScore = 100;
  else if (internalC >= 93) coreScore = lerp(85, 100, (internalC - 93) / 2);
  else if (internalC >= 88) coreScore = lerp(40, 85, (internalC - 88) / 5);
  else coreScore = clamp(lerp(0, 40, (internalC - 70) / 18), 0, 40);
  const req = bread.bake.steam;
  let score = 0.55 * crustScore + 0.45 * coreScore;
  if (!preheated) score *= 0.75;
  if (req === 'imprescindible' && !steam) score *= 0.6;
  else if (req === 'recomendado' && !steam) score *= 0.88;
  else if (req === 'no' && steam) score *= 0.95;
  score -= 3 * Math.max(0, doors - 2);
  if (Number.isFinite(targetC)) score -= Math.max(0, Math.abs(targetC - bread.bake.tempC) - 10) * 0.3;
  if (burnt) score = Math.min(score, 20 - (crust - 1.2) * 50);
  if (underbaked && internalC < 88) score = Math.min(score, 35);
  if (raw) score = Math.min(score, 5);
  score = clamp(score, 0, 100);

  const at = Number.isFinite(targetC) ? ` a ${fmtC(targetC)}` : '';
  const parts = [];
  if (raw && minutes > 1) {
    parts.push(`Lo sacaste a los ${fmtMinutes(minutes)}${at} con ${fmtC(internalC)} en el centro: por dentro sigue siendo masa cruda.`);
  } else if (raw) {
    parts.push('El pan no llegó a hornearse: por dentro sigue siendo masa cruda.');
  } else if (burnt) {
    parts.push(`Horneaste ${fmtMinutes(minutes)}${at}: la corteza se quemó y sabe amarga.`);
  } else if (underbaked) {
    parts.push(`Lo sacaste a los ${fmtMinutes(minutes)}${at} con ${fmtC(internalC)} en el centro: por dentro quedó crudo y gomoso (tiene que pasar de 93 °C).`);
  } else if (crust < cLo) {
    parts.push(`${fmtMinutes(minutes)}${at}: corteza ${crustWord(crust, bread)}; le faltó horno o temperatura para dorarse.`);
  } else if (crust > cHi) {
    parts.push(`${fmtMinutes(minutes)}${at}: corteza ${crustWord(crust, bread)}. Unos minutos menos y habría quedado perfecta.`);
  } else {
    parts.push(`${fmtMinutes(minutes)}${at}${steam ? ' con vapor' : ''}: corteza ${crustWord(crust, bread)}, y ${fmtC(internalC)} en el centro. ¡En su punto!`);
  }
  if (!raw) {
    if (req === 'imprescindible' && !steam) parts.push(`Sin vapor la ${bread.name.toLowerCase()} no se abre ni brilla: es imprescindible.`);
    else if (!preheated) parts.push('El horno no estaba precalentado y el pan perdió subida.');
    else if (doors > 2) parts.push(`Abriste la puerta ${doors} veces y se escapó el calor.`);
    else if (req === 'recomendado' && !steam) parts.push('Con un poco de vapor la corteza habría quedado más fina y brillante.');
    else if (Number.isFinite(targetC) && Math.abs(targetC - bread.bake.tempC) > 15) {
      parts.push(`La receta pide ${fmtC(bread.bake.tempC)}; con ${fmtC(targetC)} cuesta más acertar.`);
    }
  }
  return { score, note: parts.slice(0, 2).join(' '), raw, burnt, underbaked, crust, internalC, minutes, steam, preheated };
}

function pickTitle(total, f) {
  if (total >= 90) return 'Maestro panadero';
  if (total >= 75) return 'Panadero de barrio';
  if (total >= 55) return 'Aprendiz con futuro';
  if (total >= 35) return 'Pan... comestible';
  if (f.noFlour) return 'Pan invisible';
  if (f.noYeast) return 'Piedra de pan';
  if (f.raw) return 'Masa cruda con ilusión';
  if (f.burnt) return 'Carbón artesanal';
  if (f.underbaked) return 'Masa con corteza';
  if (f.collapsed) return 'Globo pinchado';
  if (f.underProofed) return 'Ladrillo casero';
  return 'Experimento culinario';
}

const PRAISE = {
  hogaza: '¡Una hogaza de escaparate! Corteza que canta al enfriarse y una miga abierta y jugosa.',
  baguette: '¡Baguette de panadería francesa! Cruje al partirla y las greñas se abrieron de maravilla.',
  molde: '¡Un pan de molde de libro! Tierno, esponjoso y con un dorado brillante.',
};

function pickSummary(total, f, worstId, bread, sections) {
  const focus = SECTION_FOCUS[worstId] || 'los detalles';
  // el elogio solo si ninguna fase flojeó
  const allGood = (sections || []).every((sec) => sec.score >= 80) && !f.noSalt;
  if (total >= 90 && allGood) return PRAISE[bread.id] || PRAISE.hogaza;
  if (total >= 75) return `Un pan muy rico, de los que desaparecen en la mesa. Para bordarlo, cuida ${focus}.`;
  if (total >= 55) return `Vas por buen camino: el pan está apañado, aunque has perdido bastantes puntos en ${focus}.`;
  if (total >= 35) return `Se puede comer, pero te toca practicar ${focus}. ¡A por otra hornada!`;
  if (f.noFlour) return 'Sin harina no hay pan que valga. ¡Empieza pesando la harina!';
  if (f.noYeast) return 'Sin levadura la masa no subió y salió compacta como un ladrillo. La próxima vez, ¡que no falte la levadura!';
  if (f.rawEarly) return 'Lo sacaste demasiado pronto: por dentro sigue crudo. Espera a que el centro pase de 93 °C y la corteza se dore.';
  if (f.raw) return 'La masa no llegó a pasar por el horno. ¡Mételo bien caliente y espera a que se dore!';
  if (f.burnt) return 'Ese aroma a chimenea lo dice todo: esta vez ganó el horno. Vigila el tiempo y la temperatura.';
  if (f.underbaked) return 'Por fuera parece pan, pero por dentro sigue siendo masa. Déjalo hasta que el centro pase de 93 °C.';
  if (f.collapsed) return 'La masa fermentó tanto que se desinfló como un globo pinchado. Acorta la fermentación o busca un sitio más fresco.';
  if (f.underProofed) return 'Le faltó fermentar y salió denso y apretado. Ten paciencia: deja que la masa doble su volumen.';
  return 'Esta hornada no salió bien, pero cada fallo enseña algo. ¡Vuelve a intentarlo!';
}

/**
 * Evaluación final de la partida. Nunca lanza: con un estado vacío o roto devuelve una evaluación
 * válida (puntuación baja) con números finitos.
 *
 * state = { breadId, amounts: {flour, water, yeast, salt, sugar, oil}, mix (0..1),
 *   knead: { gluten, strokes, extraFlour }, proof1: { minutes, tempC, p, rise, collapse },
 *   shape: { shape, scores, topping }, proof2: { minutes, tempC, p, rise, collapse },
 *   bake: { targetC, preheated, steam, minutes, crust, internalC, spring, doorOpenings } }
 *
 * @param {object} state
 * @returns {{breadId:string, breadName:string, total:number, stars:number, title:string, summary:string,
 *   sections: Array<{id:string,label:string,score:number,weight:number,note:string}>,
 *   crumb: {openness:number,density:number,gumminess:number,tunnels:number},
 *   flags: Record<string, boolean>}}
 */
export function evaluate(state) {
  try {
    return evaluateUnsafe(state);
  } catch (err) {
    // red de seguridad: nunca romper la pantalla de resultados
    const bread = BREADS.hogaza;
    return {
      breadId: bread.id,
      breadName: bread.name,
      total: 0,
      stars: 0,
      title: 'Experimento culinario',
      summary: 'Algo raro pasó en la cocina y no pudimos valorar este pan. ¡Prueba otra hornada!',
      sections: Object.keys(SECTION_LABELS).map((id) => ({ id, label: SECTION_LABELS[id], score: 0, weight: SECTION_WEIGHTS[id], note: '' })),
      crumb: { openness: 0, density: 1, gumminess: 1, tunnels: 0 },
      flags: {},
    };
  }
}

function evaluateUnsafe(state) {
  const s = obj(state);
  const bread = getBread(s.breadId);
  const a = normAmounts(s.amounts);
  const noFlour = a.flour <= 0;
  const noYeast = !noFlour && a.yeast <= 0;

  const ing = sectionIngredients(a, bread);
  const kn = sectionKnead(s, a, bread);
  const pr = sectionProof(s, a, bread, noYeast, noFlour);
  const sh = sectionShape(s, bread);
  const bk = sectionBake(s, bread);
  const crumb = crumbFromState(s);

  const scores = { ingredients: ing.score, knead: kn.score, proof: pr.score, shape: sh.score, bake: bk.score };
  const notes = { ingredients: ing.note, knead: kn.note, proof: pr.note, shape: sh.note, bake: bk.note };
  const sections = Object.keys(SECTION_LABELS).map((id) => ({
    id,
    label: SECTION_LABELS[id],
    score: Math.round(clamp(fin(scores[id]), 0, 100)),
    weight: SECTION_WEIGHTS[id],
    note: notes[id],
  }));

  const hEff = a.flour > 0 ? a.water / (a.flour + pos(obj(s.knead).extraFlour)) : 0;
  const flags = {
    noFlour,
    noYeast,
    noSalt: !noFlour && a.salt <= 0,
    raw: bk.raw,
    rawEarly: bk.raw && bk.minutes > 1,
    burnt: bk.burnt,
    underbaked: bk.underbaked,
    underProofed: !noYeast && (pr.st1 === 'under' || pr.st2 === 'under'),
    overProofed: !noYeast && (pr.st1 === 'over' || pr.st2 === 'over'),
    collapsed: pr.collapse > 0.5,
    underKneaded: kn.gluten < 0.6,
    sticky: a.flour > 0 && hEff > bread.hydrationIdeal[1] + 0.07,
    tooDry: a.flour > 0 && hEff < bread.hydrationIdeal[0] - 0.07,
    wrongShape: sh.wrongShape,
    notPreheated: obj(s.bake).preheated === false,
    noSteam: bread.bake.steam !== 'no' && !bk.steam,
    gummy: crumb.gumminess > 0.5,
  };

  let total = sections.reduce((acc, sec) => acc + sec.score * sec.weight, 0);
  // eslabón débil: un desastre en una fase se nota en todo el pan
  total -= sections.reduce((acc, sec) => acc + Math.max(0, 50 - sec.score) * 0.4, 0);
  if (pr.collapse > 0.5) total = Math.min(total, 72);
  if (sh.wrongShape) total = Math.min(total, 89); // sin la forma de la receta no hay "maestro" 
  if (noFlour) total = Math.min(total, 5);
  if (bk.raw) total = Math.min(total, 10);
  if (noYeast) total = Math.min(total, 30);
  if (bk.burnt) total = Math.min(total, 30);
  if (bk.underbaked && bk.internalC < 88) total = Math.min(total, 34);
  // una fase suspendida o sin sal: buen pan, pero no de maestro
  if (sections.some((sec) => sec.score < 60) || flags.noSalt) total = Math.min(total, 85);
  total = Math.round(clamp(fin(total), 0, 100));
  const stars = clamp(Math.round(total / 10) / 2, 0, 5);

  const worst = sections.reduce((w, sec) => (sec.score * sec.weight - sec.weight * 100 < w.score * w.weight - w.weight * 100 ? sec : w), sections[0]);
  return {
    breadId: bread.id,
    breadName: bread.name,
    total,
    stars,
    title: pickTitle(total, flags),
    summary: pickSummary(total, flags, worst.id, bread, sections),
    sections,
    crumb,
    flags,
  };
}
