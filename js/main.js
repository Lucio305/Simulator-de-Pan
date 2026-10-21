// Punto de entrada: crea el motor, la interfaz y los modelos, y arranca el juego.
import { Engine } from './engine.js';
import { createUI } from './ui.js';
import { createAudio } from './audio.js';
import { createParticles } from './particles.js';
import { createKitchen } from './models/kitchen.js';
import { createOven } from './models/oven.js';
import { createTools } from './models/tools.js';
import { createIngredients } from './models/ingredients.js';
import { createDough } from './models/dough.js';
import { Game } from './game.js';

/** Deja respirar al navegador para que pinte la barra de carga. */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

let ui = null;

async function boot() {
  ui = createUI();
  if (!hasWebGL()) {
    ui.showError('Tu navegador no puede mostrar gráficos 3D',
      'Pan Casero 3D necesita WebGL. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari, o activa la aceleración por hardware.');
    return;
  }

  ui.setLoading(0.1, 'Encendiendo las luces de la cocina…');
  await nextFrame();
  const engine = new Engine(document.getElementById('app'));
  const audio = createAudio();
  const particles = createParticles({ engine, scene: engine.scene, camera: engine.camera, renderer: engine.renderer });
  engine.scene.add(particles.group);
  const ctx = { engine, scene: engine.scene, camera: engine.camera, renderer: engine.renderer, particles, audio };

  const steps = [
    ['kitchen', createKitchen, 'Montando la cocina…'],
    ['oven', createOven, 'Instalando el horno…'],
    ['tools', createTools, 'Sacando el bol y la tabla…'],
    ['ingredients', createIngredients, 'Colocando la harina, el agua y la levadura…'],
    ['dough', createDough, 'Preparando la masa…'],
  ];
  const models = {};
  for (let i = 0; i < steps.length; i++) {
    const [key, factory, text] = steps[i];
    ui.setLoading(0.15 + (0.65 * i) / steps.length, text);
    await nextFrame();
    models[key] = factory(ctx);
    engine.scene.add(models[key].group);
  }
  // Los ingredientes que caen en el bol viven dentro del bol.
  models.tools.bowl.anchors.contents.add(models.ingredients.bowlContents.group);

  ui.setLoading(0.85, 'Precalentando sombras y materiales…');
  await nextFrame();
  engine.renderer.compile(engine.scene, engine.camera);

  const game = new Game({ engine, ui, audio, particles, models });
  window.__pan = game;

  // Parámetros de desarrollo/pruebas:
  //   ?manual=1  no arranca el bucle; window.__advance(segundos) avanza el tiempo y dibuja al final.
  //   ?stage=<id>&bread=<id>  salta directamente a una etapa (completando las anteriores).
  const params = new URLSearchParams(location.search);
  if (params.has('manual')) {
    window.__advance = async (seconds = 1, step = 1 / 30) => {
      for (let t = 0; t < seconds; t += step) {
        engine.tick(step, false);
        await new Promise((r) => setTimeout(r, 0)); // deja correr las continuaciones de las promesas
      }
      engine.render();
    };
  } else {
    engine.start();
  }
  ui.setLoading(1, '¡Listo!');
  await nextFrame();
  ui.hideLoading();
  const stage = params.get('stage');
  if (stage) {
    await game.skipTo(stage, { breadId: params.get('bread') || 'hogaza', guided: params.get('guided') !== '0' });
  } else {
    await game.start();
  }
}

boot().catch((e) => {
  console.error(e);
  try {
    (ui ?? createUI()).showError('No se pudo abrir la cocina', 'Ha ocurrido un error al cargar el simulador. Recarga la página para intentarlo de nuevo.');
  } catch {
    document.body.insertAdjacentHTML('beforeend', '<p style="position:fixed;inset:auto 16px 16px;color:#fff">No se pudo cargar Pan Casero 3D. Recarga la página.</p>');
  }
});
