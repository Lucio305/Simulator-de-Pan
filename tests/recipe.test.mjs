// Pruebas del módulo de simulación y puntuación (node --test tests/)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  INGREDIENTS, INGREDIENT_ORDER, BREADS, BREAD_ORDER, PROOF_SPOTS, STAGES, ESTIMATES,
  getBread, hydration, ingredientReport, kneadStroke, stickiness, windowpaneTest,
  fermentationRate, riseFromProgress, proofStep, initialProof, pokeTest, proofStatus,
  ovenStep, ovenStatus, initialOven, bakeStep, initialBake, springPotential,
  crumbFromState, evaluate, idealProofMinutes, idealBakeWindow,
} from '../js/recipe.js';

const mid = ([a, b]) => (a + b) / 2;

// Opciones de horneado "de libro" para un pan
function bakeOpts(breadId, extra = {}) {
  const b = BREADS[breadId];
  return {
    ovenC: b.bake.tempC,
    steam: b.bake.steam !== 'no',
    eggwash: b.toppings.suggested === 'eggwash',
    sugarPct: (b.recipe.sugar / b.recipe.flour) * 100,
    shape: b.shape,
    proofP: mid(b.proof2Ideal),
    proofIdeal: b.proof2Ideal,
    gluten: 0.92,
    scored: true,
    yeastPct: (b.recipe.yeast / b.recipe.flour) * 100,
    ...extra,
  };
}

function bakeFor(minutes, opts, dt = 0.5) {
  let bk = initialBake(24);
  for (let t = 0; t < minutes - 1e-9; t += dt) bk = bakeStep(bk, Math.min(dt, minutes - t), opts);
  return bk;
}

function proofUntil(p, amounts, tempC) {
  let pr = initialProof(tempC);
  while (pr.p < p) pr = proofStep(pr, 1, { amounts, tempC });
  return pr;
}

// Partida perfecta simulada con las propias funciones del módulo
function perfectState(breadId, tempC = 22) {
  const b = BREADS[breadId];
  const amounts = { ...b.recipe };
  let gluten = 0;
  for (let i = 0; i < 32; i++) gluten = kneadStroke(gluten, 1);
  const proof1 = proofUntil(mid(b.proof1Ideal), amounts, tempC);
  const proof2 = proofUntil(mid(b.proof2Ideal), amounts, tempC);
  const scores = b.scoring.min === 0 ? 0 : Math.round(mid([b.scoring.min, b.scoring.max]) - 0.5);
  const win = idealBakeWindow(breadId);
  const minutes = Math.round(mid(win.minutes));
  const opts = bakeOpts(breadId, { proofP: proof2.p, gluten });
  const bk = bakeFor(minutes, opts);
  return {
    breadId,
    amounts,
    mix: 1,
    knead: { gluten, strokes: 32, extraFlour: 0 },
    proof1,
    shape: { shape: b.shape, scores, topping: b.toppings.suggested },
    proof2,
    bake: { ...bk, targetC: b.bake.tempC, preheated: true, steam: opts.steam, doorOpenings: 1 },
  };
}

function assertAllFinite(value, path = 'root') {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} no es finito: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllFinite(v, `${path}.${k}`);
  }
}

function section(res, id) {
  return res.sections.find((s) => s.id === id);
}

describe('datos', () => {
  test('ingredientes, panes, sitios y etapas', () => {
    assert.deepEqual([...INGREDIENT_ORDER], ['flour', 'water', 'yeast', 'salt', 'sugar', 'oil']);
    assert.equal(INGREDIENTS.flour.label, 'Harina de fuerza');
    assert.equal(INGREDIENTS.water.maxRate, 70);
    assert.equal(INGREDIENTS.yeast.maxRate, 2.5);
    assert.deepEqual([...BREAD_ORDER], ['hogaza', 'baguette', 'molde']);
    assert.deepEqual({ ...BREADS.molde.recipe }, { flour: 500, water: 300, yeast: 7, salt: 9, sugar: 15, oil: 25 });
    assert.equal(BREADS.baguette.bake.steam, 'imprescindible');
    assert.equal(BREADS.molde.container, 'tin');
    for (const id of BREAD_ORDER) {
      const b = BREADS[id];
      for (const k of ['ingredients', 'mix', 'knead', 'proof', 'shape', 'bake']) assert.equal(typeof b.tips[k], 'string');
      assert.ok(['Fácil', 'Media', 'Difícil'].includes(b.difficulty));
    }
    assert.deepEqual(PROOF_SPOTS.map((s) => s.tempC), [22, 28, 5]);
    assert.equal(STAGES.length, 7);
    assert.equal(STAGES[3].label, 'Fermentar');
    assert.equal(getBread('nope').id, 'hogaza');
    assert.equal(typeof ESTIMATES.idealProofMinutes, 'function');
    assert.ok(Object.isFrozen(BREADS.hogaza.recipe));
  });
});

describe('ingredientes', () => {
  test('hidratación', () => {
    assert.equal(hydration({ flour: 500, water: 350 }), 0.7);
    assert.equal(hydration({ water: 350 }), 0);
    assert.equal(hydration(null), 0);
  });

  test('receta exacta → 100 y todo ok', () => {
    const r = ingredientReport(BREADS.hogaza.recipe, 'hogaza');
    assert.equal(r.score, 100);
    assert.equal(r.rows.length, 4); // azúcar y aceite no aparecen si la receta no los lleva
    assert.ok(r.rows.every((row) => row.state === 'ok'));
    assert.deepEqual(r.notes, []);
  });

  test('estados pending / under / ok / over y tolerancias', () => {
    const r = ingredientReport({ flour: 520, water: 300, yeast: 4.7, salt: 0, sugar: 5 }, 'hogaza');
    const st = Object.fromEntries(r.rows.map((row) => [row.id, row.state]));
    assert.equal(st.flour, 'ok'); // +4 % dentro de ±6 %
    assert.equal(st.water, 'under');
    assert.equal(st.yeast, 'ok'); // +17,5 % dentro de ±20 %
    assert.equal(st.salt, 'pending');
    assert.equal(st.sugar, 'over'); // la hogaza no lleva azúcar
    assert.ok(r.score < 80);
    assert.ok(r.notes.length >= 3);
  });

  test('nota con números reales', () => {
    const r = ingredientReport({ flour: 500, water: 412, yeast: 4, salt: 10 }, 'hogaza', { past: true });
    assert.ok(r.notes.includes('Pusiste 412 ml de agua en lugar de 350 ml: hidratación del 82 %, la masa quedó muy pegajosa.'), r.notes.join(' | '));
  });

  test('sin levadura o sin harina es grave', () => {
    assert.ok(ingredientReport({ flour: 500, water: 350, salt: 10 }, 'hogaza').score <= 25);
    assert.ok(ingredientReport({ water: 350, yeast: 4, salt: 10 }, 'hogaza').score <= 5);
    const extra = ingredientReport({ flour: 500, water: 350, yeast: 4, salt: 10, oil: 10 }, 'hogaza');
    assert.ok(extra.score >= 90 && extra.score < 100, `penalización pequeña: ${extra.score}`);
  });
});

describe('amasado', () => {
  test('30 golpes buenos llevan el gluten a ≥ 0,9 con rendimientos decrecientes', () => {
    let g = 0;
    const gains = [];
    for (let i = 0; i < 30; i++) {
      const n = kneadStroke(g, 1);
      gains.push(n - g);
      g = n;
    }
    assert.ok(g >= 0.9, `gluten ${g}`);
    assert.ok(gains[0] > gains[29]);
    assert.ok(kneadStroke(0.5, 0.3) < kneadStroke(0.5, 1));
    assert.ok(kneadStroke(1, 1) <= 1);
  });

  test('pegajosidad y prueba de la ventana', () => {
    assert.ok(stickiness(0.82, 0, 500) > stickiness(0.7, 0, 500));
    assert.ok(stickiness(0.7, 60, 500) < stickiness(0.7, 0, 500));
    assert.ok(stickiness(0.6, 0, 500) < 0.2);
    assert.equal(windowpaneTest(0.92).pass, true);
    assert.equal(windowpaneTest(0.4).pass, false);
    assert.equal(typeof windowpaneTest(0.4).text, 'string');
  });
});

describe('fermentación', () => {
  const amounts = BREADS.hogaza.recipe;

  test('28 °C > 22 °C ≫ 5 °C', () => {
    const r28 = fermentationRate({ amounts, tempC: 28 });
    const r22 = fermentationRate({ amounts, tempC: 22 });
    const r5 = fermentationRate({ amounts, tempC: 5 });
    assert.ok(r28 > r22 * 1.3, `${r28} vs ${r22}`);
    assert.ok(r22 > r5 * 5, `${r22} vs ${r5}`);
    assert.ok(r5 > 0);
    assert.equal(fermentationRate({ amounts, tempC: 60 }), 0); // levadura muerta
    assert.ok(fermentationRate({ amounts, tempC: 45 }) < fermentationRate({ amounts, tempC: 37 }));
  });

  test('base 1/75 por minuto a 24 °C con levadura al 1 % y factor de 5 °C ≈ 0,12', () => {
    const ref = { flour: 500, yeast: 5, salt: 10, water: 350 };
    assert.ok(Math.abs(fermentationRate({ amounts: ref, tempC: 24 }) - 1 / 75) < 1e-9);
    const ratio = fermentationRate({ amounts: ref, tempC: 5 }) / fermentationRate({ amounts: ref, tempC: 24 });
    assert.ok(Math.abs(ratio - 0.12) < 0.01, `ratio ${ratio}`);
    assert.ok(fermentationRate({ amounts: { ...ref, salt: 0 }, tempC: 24 }) > fermentationRate({ amounts: ref, tempC: 24 }));
    assert.ok(fermentationRate({ amounts: { ...ref, salt: 20 }, tempC: 24 }) < fermentationRate({ amounts: ref, tempC: 24 }));
    assert.ok(fermentationRate({ amounts: { ...ref, sugar: 100 }, tempC: 24 }) < fermentationRate({ amounts: ref, tempC: 24 }));
  });

  test('subida: ~2,1 en p = 1, hundimiento pasado p ≈ 1,6', () => {
    const r1 = riseFromProgress(1);
    assert.ok(r1.rise >= 2.0 && r1.rise <= 2.2, `rise ${r1.rise}`);
    assert.equal(r1.collapse, 0);
    assert.equal(riseFromProgress(0).rise, 1);
    assert.ok(riseFromProgress(1.5).rise > r1.rise);
    const r26 = riseFromProgress(2.6);
    assert.ok(r26.collapse > 0.99);
    assert.ok(r26.rise < riseFromProgress(1.6).rise * 0.7);
  });

  test('proofStep no muta la entrada', () => {
    const input = Object.freeze({ minutes: 10, tempC: 22, p: 0.2, rise: 1.3, collapse: 0, extra: 'x' });
    const copy = JSON.stringify(input);
    const out = proofStep(input, 15, { amounts, tempC: 28 });
    assert.equal(JSON.stringify(input), copy);
    assert.notEqual(out, input);
    assert.equal(out.minutes, 25);
    assert.equal(out.tempC, 28);
    assert.ok(out.p > 0.2);
    assert.equal(out.extra, 'x');
  });

  test('sobrefermentación (p ≈ 2,4) → hundida y mala nota de fermentación', () => {
    const p1 = proofUntil(2.4, amounts, 28);
    assert.ok(p1.collapse > 0.5, `collapse ${p1.collapse}`);
    const st = { ...perfectState('hogaza'), proof1: p1 };
    const res = evaluate(st);
    assert.ok(section(res, 'proof').score < 35, `fermentación ${section(res, 'proof').score}`);
    assert.equal(res.flags.collapsed, true);
    assert.equal(pokeTest(p1.p, BREADS.hogaza.proof1Ideal).result, 'over');
  });

  test('prueba del dedo', () => {
    const ideal = BREADS.hogaza.proof1Ideal;
    const u = pokeTest(0.4, ideal);
    const o = pokeTest(1.05, ideal);
    const v = pokeTest(2.2, ideal);
    assert.equal(u.result, 'under');
    assert.ok(u.recoverySeconds <= 0.6);
    assert.equal(o.result, 'ok');
    assert.ok(o.recoverySeconds >= 1.5 && o.recoverySeconds <= 2.6);
    assert.equal(v.result, 'over');
    assert.ok(v.recoverySeconds >= 6);
    assert.equal(proofStatus(1.0, ideal), 'ok');
    assert.equal(proofStatus(0.7, BREADS.hogaza.proof2Ideal), 'ok');
  });

  test('estimaciones de tiempo de fermentación', () => {
    const r22 = idealProofMinutes({ amounts, tempC: 22 }, BREADS.hogaza.proof1Ideal);
    const r28 = idealProofMinutes({ amounts, tempC: 28 }, BREADS.hogaza.proof1Ideal);
    assert.ok(r22[0] > 60 && r22[1] < 150, r22.join());
    assert.ok(r28[1] < r22[1]);
    assert.equal(idealProofMinutes({ amounts: { ...amounts, yeast: 0 }, tempC: 22 }, [0.85, 1.3]), null);
    // a mitad de ventana desde el progreso actual
    const pr = proofStep(initialProof(22), r22[0], { amounts, tempC: 22 });
    assert.equal(proofStatus(pr.p + 1e-9, BREADS.hogaza.proof1Ideal), 'ok');
  });
});

describe('horno', () => {
  test('precalienta 22 → 220 °C en 10–14 min y queda listo', () => {
    let o = { ...initialOven(), targetC: 220, on: true };
    assert.equal(ovenStatus(o), 'heating');
    let t = 0;
    while (ovenStatus(o) !== 'ready' && t < 30) {
      o = ovenStep(o, 0.1);
      t += 0.1;
    }
    assert.ok(t >= 10 && t <= 14, `listo en ${t.toFixed(1)} min`);
    o = ovenStep(o, 20);
    assert.equal(ovenStatus(o), 'ready');
    assert.ok(Math.abs(o.tempC - 220) < 3, `se estabiliza: ${o.tempC}`);
  });

  test('puerta abierta enfría deprisa; apagado enfría despacio', () => {
    const hot = { tempC: 230, targetC: 230, on: true, doorOpen: false };
    const open = ovenStep({ ...hot, doorOpen: true }, 1);
    assert.ok(open.tempC < 205 && open.tempC > 170, `${open.tempC}`);
    const off = ovenStep({ ...hot, on: false }, 1);
    assert.ok(off.tempC > 220);
    assert.equal(ovenStatus(off), 'off');
    assert.equal(ovenStatus({}), 'off');
    const input = Object.freeze({ ...hot });
    ovenStep(input, 5); // no muta (estaría congelado)
  });
});

describe('horneado: calibración', () => {
  test('hogaza 230 °C con vapor, 37 min → corteza 0,70–0,85 y centro ≥ 96 °C', () => {
    const bk = bakeFor(37, bakeOpts('hogaza'));
    assert.ok(bk.crust >= 0.7 && bk.crust <= 0.85, `corteza ${bk.crust}`);
    assert.ok(bk.internalC >= 96, `centro ${bk.internalC}`);
    assert.equal(bk.burnt, false);
  });

  test('baguette 240 °C con vapor, 24 min → corteza 0,70–0,85', () => {
    const bk = bakeFor(24, bakeOpts('baguette'));
    assert.ok(bk.crust >= 0.7 && bk.crust <= 0.85, `corteza ${bk.crust}`);
    assert.ok(bk.internalC >= 96);
  });

  test('molde 190 °C sin vapor, con huevo, 32 min → corteza 0,68–0,85', () => {
    const bk = bakeFor(32, bakeOpts('molde', { steam: false, eggwash: true }));
    assert.ok(bk.crust >= 0.68 && bk.crust <= 0.85, `corteza ${bk.crust}`);
    assert.ok(bk.internalC >= 95);
  });

  test('cualquier pan a 250 °C durante 60 min se quema', () => {
    for (const id of BREAD_ORDER) {
      for (const steam of [true, false]) {
        const bk = bakeFor(60, bakeOpts(id, { ovenC: 250, steam }));
        assert.ok(bk.crust >= 1.2 && bk.burnt, `${id} vapor=${steam}: ${bk.crust}`);
      }
    }
  });

  test('hogaza 230 °C 15 min → poco hecha y pálida', () => {
    for (const steam of [true, false]) {
      const bk = bakeFor(15, bakeOpts('hogaza', { steam }));
      assert.ok(bk.internalC < 93, `centro ${bk.internalC}`);
      assert.ok(bk.crust < 0.55, `corteza ${bk.crust}`);
    }
  });

  test('a 150 °C durante 40 min queda pálido', () => {
    for (const id of BREAD_ORDER) {
      const bk = bakeFor(40, bakeOpts(id, { ovenC: 150 }));
      assert.ok(bk.crust < 0.45, `${id}: ${bk.crust}`);
    }
  });

  test('el centro se estanca en ~98–99 °C y la baguette se hace antes', () => {
    const long = bakeFor(90, bakeOpts('hogaza', { ovenC: 250 }));
    assert.ok(long.internalC <= 99 && long.internalC >= 98, `${long.internalC}`);
    const bag = bakeFor(12, bakeOpts('baguette', { ovenC: 230 }));
    const hog = bakeFor(12, bakeOpts('hogaza', { ovenC: 230 }));
    const mol = bakeFor(12, bakeOpts('molde', { ovenC: 230 }));
    assert.ok(bag.internalC > hog.internalC && bag.internalC > mol.internalC);
  });

  test('huevo y azúcar doran antes; el vapor retrasa el color', () => {
    const base = bakeOpts('molde', { eggwash: false, sugarPct: 0 });
    const plain = bakeFor(25, base).crust;
    assert.ok(bakeFor(25, { ...base, eggwash: true }).crust > plain * 1.1);
    assert.ok(bakeFor(25, { ...base, sugarPct: 3 }).crust > plain * 1.05);
    const h = bakeOpts('hogaza');
    assert.ok(bakeFor(20, { ...h, steam: true }).crust < bakeFor(20, { ...h, steam: false }).crust);
  });

  test('oven spring: ideal ≈ 1,3, poco fermentado explosivo e irregular, pasado poco', () => {
    const ideal = BREADS.hogaza.proof2Ideal;
    const good = bakeFor(15, bakeOpts('hogaza'));
    assert.ok(good.spring >= 1.2 && good.spring <= 1.4, `${good.spring}`);
    const under = springPotential({ proofP: 0.3, proofIdeal: ideal, gluten: 0.9, steam: true, scored: true, shape: 'boule' });
    const over = springPotential({ proofP: 1.9, proofIdeal: ideal, gluten: 0.9, steam: true, scored: true, shape: 'boule' });
    const ok = springPotential({ proofP: 0.7, proofIdeal: ideal, gluten: 0.9, steam: true, scored: true, shape: 'boule' });
    assert.ok(under.max > ok.max && under.irregular > ok.irregular);
    assert.ok(over.max < 1.12);
    assert.ok(springPotential({ proofP: 0.7, proofIdeal: ideal, gluten: 0.9, steam: false, scored: true }).max < ok.max);
    assert.ok(springPotential({ proofP: 0.7, proofIdeal: ideal, gluten: 0.2, steam: true, scored: true }).max < ok.max);
    assert.ok(springPotential({ proofP: 0, yeastPct: 0 }).max < 1.05);
    // la subida ocurre al principio
    const early = bakeFor(12, bakeOpts('hogaza'));
    const late = bakeFor(30, bakeOpts('hogaza'));
    assert.ok(late.spring - early.spring < 0.01);
  });

  test('bakeStep no muta la entrada y conserva campos del juego', () => {
    const input = Object.freeze({ ...initialBake(24), targetC: 230, steam: true, doorOpenings: 2 });
    const out = bakeStep(input, 5, bakeOpts('hogaza'));
    assert.equal(input.minutes, 0);
    assert.equal(out.minutes, 5);
    assert.equal(out.targetC, 230);
    assert.equal(out.doorOpenings, 2);
  });

  test('ventanas ideales de horneado coherentes con la receta', () => {
    for (const id of BREAD_ORDER) {
      const w = idealBakeWindow(id);
      assert.ok(w.minutes, id);
      const [a, b] = w.minutes;
      const [ra, rb] = BREADS[id].bake.minutes;
      assert.ok(a <= rb && b >= ra, `${id}: simulado ${a}-${b} vs receta ${ra}-${rb}`);
      assert.ok(Math.abs(a - ra) <= 3, `${id}: inicio ${a} vs ${ra}`);
    }
    assert.equal(idealBakeWindow('hogaza', { ovenC: 150 }).minutes, null);
    // la forma real cambia la ventana: una barra hecha bola tarda más
    const bag = idealBakeWindow('baguette', { shape: 'baguette' });
    const boule = idealBakeWindow('baguette', { shape: 'boule' });
    assert.notDeepEqual(boule.minutes, bag.minutes);
    assert.ok(boule.minutes[0] > bag.minutes[0] + 4, `${boule.minutes} vs ${bag.minutes}`);
    assert.deepEqual(idealBakeWindow('baguette').minutes, bag.minutes);
  });
});

describe('miga', () => {
  test('perfecta: abierta, ligera, sin gomosidad', () => {
    const c = crumbFromState(perfectState('hogaza'));
    assert.ok(c.openness > 0.45, `openness ${c.openness}`);
    assert.ok(c.density < 0.35, `density ${c.density}`);
    assert.ok(c.gumminess < 0.1);
    assert.ok(c.tunnels < 0.2);
    const molde = crumbFromState(perfectState('molde'));
    assert.ok(molde.openness < c.openness, 'el molde tiene la miga más fina');
  });

  test('poco hecho → gomoso', () => {
    const st = perfectState('hogaza');
    const bk = bakeFor(15, bakeOpts('hogaza'));
    const c = crumbFromState({ ...st, bake: { ...st.bake, ...bk } });
    assert.ok(c.gumminess > 0.5, `gumminess ${c.gumminess}`);
  });

  test('poco fermentado → denso con túneles; pasado → túneles grandes', () => {
    const st = perfectState('hogaza');
    const amounts = st.amounts;
    const under = crumbFromState({ ...st, proof1: proofUntil(0.3, amounts, 22), proof2: proofUntil(0.15, amounts, 22) });
    const over = crumbFromState({ ...st, proof1: proofUntil(2.4, amounts, 28) });
    const good = crumbFromState(st);
    assert.ok(under.density > good.density + 0.2, `${under.density} vs ${good.density}`);
    assert.ok(under.openness < good.openness);
    assert.ok(under.tunnels > 0.25);
    assert.ok(over.tunnels > 0.6, `${over.tunnels}`);
    assert.ok(over.density > good.density);
  });
});

describe('evaluación', () => {
  for (const id of BREAD_ORDER) {
    test(`partida perfecta de ${id} → ≥ 85 puntos y ≥ 4,5 estrellas`, () => {
      const res = evaluate(perfectState(id));
      assert.ok(res.total >= 85, `${id}: ${res.total} ${JSON.stringify(res.sections)}`);
      assert.ok(res.stars >= 4.5);
      assert.equal(res.breadName, BREADS[id].name);
      assert.equal(res.sections.length, 5);
      assert.deepEqual(res.sections.map((s) => s.label), ['Ingredientes', 'Amasado', 'Fermentación', 'Formado y greñado', 'Horneado']);
      for (const s of res.sections) assert.ok(s.note.length > 10, `nota vacía en ${s.id}`);
      assert.ok(['Maestro panadero', 'Panadero de barrio'].includes(res.title));
      assert.equal(res.flags.burnt, false);
      assert.equal(res.flags.underbaked, false);
    });
  }

  test('perfecta también fermentando junto al horno (28 °C)', () => {
    assert.ok(evaluate(perfectState('baguette', 28)).total >= 85);
  });

  test('las estrellas van en pasos de 0,5', () => {
    const res = evaluate(perfectState('molde'));
    assert.equal(res.stars * 2, Math.round(res.stars * 2));
  });

  test('sin levadura → no sube y "Piedra de pan"', () => {
    const st = perfectState('hogaza');
    const amounts = { ...st.amounts, yeast: 0 };
    let p1 = initialProof(22);
    for (let i = 0; i < 180; i++) p1 = proofStep(p1, 1, { amounts, tempC: 22 });
    assert.ok(Math.abs(p1.rise - 1) < 0.01, `rise ${p1.rise}`);
    assert.equal(p1.p, 0);
    const p2 = proofStep(initialProof(22), 60, { amounts, tempC: 22 });
    const bk = bakeFor(37, bakeOpts('hogaza', { proofP: 0, yeastPct: 0 }));
    assert.ok(bk.spring < 1.05);
    const res = evaluate({ ...st, amounts, proof1: p1, proof2: p2, bake: { ...st.bake, ...bk } });
    assert.equal(res.title, 'Piedra de pan');
    assert.equal(res.flags.noYeast, true);
    assert.ok(res.total < 35);
    assert.ok(res.crumb.density > 0.9);
  });

  test('quemado → "Carbón artesanal" y Horneado < 25', () => {
    const st = perfectState('hogaza');
    const bk = bakeFor(60, bakeOpts('hogaza', { ovenC: 250 }));
    const res = evaluate({ ...st, bake: { ...st.bake, ...bk, targetC: 250 } });
    assert.equal(res.title, 'Carbón artesanal');
    assert.ok(section(res, 'bake').score < 25, `horneado ${section(res, 'bake').score}`);
    assert.equal(res.flags.burnt, true);
    assert.match(section(res, 'bake').note, /250 °C/);
  });

  test('poco hecho → gomoso y "Masa con corteza"', () => {
    const st = perfectState('hogaza');
    const bk = bakeFor(15, bakeOpts('hogaza'));
    const res = evaluate({ ...st, bake: { ...st.bake, ...bk } });
    assert.ok(res.crumb.gumminess > 0.5);
    assert.equal(res.flags.underbaked, true);
    assert.equal(res.title, 'Masa con corteza');
    assert.match(section(res, 'bake').note, /15 min/);
  });

  test('baguette sin vapor penaliza; forma equivocada penaliza poco', () => {
    const st = perfectState('baguette');
    const good = evaluate(st);
    const noSteam = evaluate({ ...st, bake: { ...st.bake, steam: false } });
    assert.ok(section(good, 'bake').score - section(noSteam, 'bake').score >= 8);
    assert.equal(noSteam.flags.noSteam, true);
    const wrong = evaluate({ ...st, shape: { ...st.shape, shape: 'boule' } });
    const drop = section(good, 'shape').score - section(wrong, 'shape').score;
    assert.ok(drop > 0 && drop <= 30, `caída ${drop}`);
    assert.ok(wrong.total >= 80);
    assert.equal(wrong.flags.wrongShape, true);
  });

  test('equilibrio: un fallo grave baja de categoría', () => {
    const st = perfectState('hogaza');
    const pale = evaluate({ ...st, bake: { ...st.bake, ...bakeFor(40, bakeOpts('hogaza', { ovenC: 150 })), targetC: 150 } });
    assert.ok(pale.total < 75 && pale.total >= 55, `pálido ${pale.total}`);
    const over = evaluate({ ...st, proof1: proofUntil(2.4, st.amounts, 28) });
    assert.ok(over.total <= 72, `pasado ${over.total}`);
    const bg = perfectState('baguette');
    const wrong = evaluate({ ...bg, shape: { shape: 'boule', scores: 2, topping: 'none' } });
    assert.ok(wrong.total <= 89 && wrong.title !== 'Maestro panadero');
    const sticky = ingredientReport({ ...BREADS.hogaza.recipe, water: 412 }, 'hogaza');
    assert.ok(sticky.score < 70, `hidratación 82 %: ${sticky.score}`);
  });

  test('el molde no necesita cortes', () => {
    const st = perfectState('molde');
    const one = evaluate({ ...st, shape: { ...st.shape, scores: 1 } });
    assert.equal(section(one, 'shape').score, 100);
  });

  test('notas específicas con números reales', () => {
    const st = perfectState('hogaza');
    const res = evaluate({ ...st, amounts: { ...st.amounts, water: 412 } });
    assert.match(section(res, 'ingredients').note, /412 ml de agua en lugar de 350 ml: hidratación del 82 %/);
    const lazy = evaluate({ ...st, knead: { gluten: 0.45, strokes: 8, extraFlour: 0 } });
    assert.match(section(lazy, 'knead').note, /8 amasadas/);
    assert.match(section(lazy, 'knead').note, /45 %/);
    // la ventana solo si se hizo la prueba
    assert.match(section(evaluate({ ...st, knead: { ...st.knead, windowpane: true } }), 'knead').note, /prueba de la ventana/);
    assert.match(section(evaluate({ ...st, knead: { ...st.knead, windowpane: false } }), 'knead').note, /lisa y elástica/);
    // minutos con dos cifras cuando hay horas, como el HUD
    const long = evaluate({ ...st, proof1: { ...proofStep(initialProof(22), 185, { amounts: st.amounts, tempC: 22 }) } });
    assert.match(section(long, 'proof').note, /3 h 05 min/);
  });

  test('una fase suspendida o sin sal no llega a "Maestro panadero"', () => {
    const st = perfectState('molde');
    const amounts = { ...st.amounts, salt: 0 };
    const noSalt = evaluate({ ...st, amounts });
    assert.ok(noSalt.total <= 85, `sin sal ${noSalt.total}`);
    assert.notEqual(noSalt.title, 'Maestro panadero');
    assert.ok(!noSalt.summary.startsWith('¡'), noSalt.summary);
    const bg = perfectState('baguette');
    const lazy = evaluate({ ...bg, knead: { gluten: 0.25, strokes: 4, extraFlour: 0 } });
    assert.ok(lazy.total <= 85, `poco amasado ${lazy.total}`);
    assert.notEqual(lazy.title, 'Maestro panadero');
    assert.equal(evaluate(perfectState('hogaza')).title, 'Maestro panadero');
  });

  test('hidratación del 120 % → miga cerrada, no la mejor', () => {
    const st = perfectState('baguette');
    const c = crumbFromState({ ...st, amounts: { ...st.amounts, water: 600 } });
    assert.ok(c.openness < 0.5, `openness ${c.openness}`);
    assert.ok(c.openness < crumbFromState(st).openness);
  });

  test('forma equivocada: los cortes se valoran según la forma real', () => {
    const st = perfectState('baguette');
    const loaf = evaluate({ ...st, shape: { shape: 'loaf', scores: 0, topping: 'none' } });
    assert.equal(section(loaf, 'shape').score, 75);
    assert.doesNotMatch(section(loaf, 'shape').note, /Sin greñas/);
    const boule = evaluate({ ...perfectState('molde'), shape: { shape: 'boule', scores: 0, topping: 'none' } });
    assert.match(section(boule, 'shape').note, /Sin greñas/);
  });

  test('baguette: 6 cortes son demasiados', () => {
    const st = perfectState('baguette');
    const six = evaluate({ ...st, shape: { ...st.shape, scores: 6 } });
    assert.equal(section(six, 'shape').score, 92);
    assert.match(section(six, 'shape').note, /acordeón/);
  });

  test('coberturas combinadas tienen su nota', () => {
    const st = perfectState('baguette');
    const res = evaluate({ ...st, shape: { ...st.shape, topping: 'eggwash+sesame' } });
    assert.match(section(res, 'shape').note, /huevo/);
    assert.match(section(res, 'shape').note, /sésamo/);
  });

  test('fermentación: temperatura media y bonus de frío solo con horas en la nevera', () => {
    const st = perfectState('baguette');
    const amounts = st.amounts;
    let p1 = initialProof(22);
    for (let i = 0; i < 90; i++) p1 = proofStep(p1, 1, { amounts, tempC: 22 });
    p1 = proofStep(p1, 1, { amounts, tempC: 5 });
    assert.equal(p1.coldMin, 1);
    const res = evaluate({ ...st, proof1: p1 });
    const note = section(res, 'proof').note;
    assert.match(note, /a 22 °C/);
    assert.doesNotMatch(note, /5 °C|frío/);
    // 10 h en la nevera sí tiene bonus
    let cold = initialProof(5);
    while (cold.p < 1.05) cold = proofStep(cold, 5, { amounts, tempC: 5 });
    assert.ok(cold.coldMin >= 120);
    assert.match(section(evaluate({ ...st, proof1: cold }), 'proof').note, /frío/);
  });

  test('pan crudo: distinto si estuvo en el horno o no', () => {
    const st = perfectState('molde');
    const early = evaluate({ ...st, bake: { ...st.bake, ...bakeFor(5, bakeOpts('molde')) } });
    assert.equal(early.flags.raw, true);
    assert.match(section(early, 'bake').note, /Lo sacaste a los 5 min/);
    assert.match(early.summary, /demasiado pronto/);
    const never = evaluate({ ...st, bake: { ...st.bake, ...initialBake(24) } });
    assert.match(section(never, 'bake').note, /no llegó a hornearse/);
    assert.match(never.summary, /no llegó a pasar por el horno/);
  });

  test('estado vacío o roto no lanza y devuelve números finitos', () => {
    const broken = [
      undefined, null, {}, 42, 'pan', [],
      { breadId: 'molde' },
      { breadId: 'zzz', amounts: { flour: 'abc', water: NaN, yeast: -3, salt: Infinity }, mix: 'x', knead: null, proof1: 5, proof2: { p: NaN, minutes: -10 }, shape: 'boule', bake: 'raw' },
      { breadId: 'hogaza', amounts: BREADS.hogaza.recipe, bake: { minutes: 30, crust: NaN, internalC: undefined, preheated: 'yes', doorOpenings: 'many' } },
      { breadId: 'baguette', amounts: { flour: 500 }, proof1: { p: 1e9 }, bake: { minutes: 1e9, crust: 1e9, internalC: 1e9 } },
    ];
    for (const st of broken) {
      const res = evaluate(st);
      assertAllFinite(res);
      assert.ok(res.total >= 0 && res.total <= 100);
      assert.ok(res.stars >= 0 && res.stars <= 5);
      assert.equal(res.sections.length, 5);
      assert.equal(typeof res.title, 'string');
      assert.equal(typeof res.summary, 'string');
      assertAllFinite(crumbFromState(st));
    }
    assert.ok(evaluate({}).total <= 5);
  });

  test('las funciones toleran entradas basura', () => {
    assertAllFinite(ingredientReport(undefined, undefined));
    assertAllFinite(ingredientReport({ flour: 'x' }, 'nope'));
    assert.ok(Number.isFinite(kneadStroke(NaN, NaN)));
    assert.ok(Number.isFinite(stickiness(NaN, NaN, NaN)));
    assert.equal(fermentationRate(), 0);
    assert.equal(fermentationRate(null), 0);
    assertAllFinite(riseFromProgress(NaN));
    assertAllFinite(proofStep(undefined, NaN, undefined));
    assertAllFinite(proofStep(null, 10, { amounts: BREADS.hogaza.recipe, tempC: 'calor' }));
    assertAllFinite(pokeTest(NaN, 'x'));
    assertAllFinite(ovenStep(undefined, NaN));
    assertAllFinite(ovenStep({ tempC: 'x', targetC: 1e9, on: true }, 1));
    const b = bakeStep(undefined, 10, undefined);
    assertAllFinite({ ...b, burnt: 0 });
    assertAllFinite(bakeStep({ crust: 'x', internalC: NaN }, 1e9, { ovenC: 1e9, shape: 'triángulo' }));
    assertAllFinite(springPotential(null));
    assert.equal(idealProofMinutes(null, null), null);
  });
});
