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
import { createQuality, plannedTier, TIERS } from './quality.js';

/** Deja respirar al navegador para que pinte la barra de carga. */
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** Comprueba WebGL y si el navegador lo dibuja por software (sin la tarjeta gráfica). */
function probeWebGL() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, software: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { ok: true, software: /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name) };
  } catch {
    return { ok: false, software: false };
  }
}

/**
 * Crea ya las piezas que la masa monta a demanda (semillas, mitades cortadas) y las dibuja una vez
 * tras la pantalla de carga: así sus shaders se compilan ahora y no dan un tirón en mitad del juego.
 */
async function prewarm(engine, models) {
  const { dough, tools } = models;
  const g = dough.group;
  const pos = g.position.clone();
  const wasVisible = g.visible;
  g.visible = true;
  g.position.set(engine.cameraTarget.x, 0.92, engine.cameraTarget.z);
  dough.set({ shape: 'boule', bake: 0.8 });
  dough.setTopping('eggwash+sesame');
  dough.setCut(1, { openness: 0.5, density: 0.5, gumminess: 0, tunnels: 0 });
  dough.update(0, 0);
  const hidden = [tools.tin, tools.coolingRack].filter((t) => t && !t.object.visible);
  hidden.forEach((t) => t.show());
  // compileAsync compila en paralelo (KHR_parallel_shader_compile) sin congelar la pantalla de carga
  if (engine.renderer.extensions.has('KHR_parallel_shader_compile')) {
    await engine.renderer.compileAsync(engine.scene, engine.camera).catch(() => {});
  } else {
    engine.renderer.compile(engine.scene, engine.camera);
  }
  engine.render(); // sombras y piezas con planos de recorte: sus variantes se compilan al dibujar
  hidden.forEach((t) => t.hide());
  dough.setCut(0);
  dough.reset();
  dough.update(0, 0);
  g.position.copy(pos);
  g.visible = wasVisible;
}

let ui = null;

async function boot() {
  ui = createUI();
  const gl = probeWebGL();
  if (!gl.ok) {
    ui.showError('Tu navegador no puede mostrar gráficos 3D',
      'Pan Casero 3D necesita WebGL. Prueba con una versión reciente de Chrome, Edge, Firefox o Safari, o activa la aceleración por hardware.');
    return;
  }

  ui.setLoading(0.1, 'Encendiendo las luces de la cocina…');
  await nextFrame();
  // Antialiasing (MSAA) solo si se arranca en calidad alta y en pantallas de densidad normal: es de lo más
  // caro y no se puede cambiar después de crear el contexto WebGL.
  const antialias = !gl.software && plannedTier({ software: gl.software }) === 'alta' && (window.devicePixelRatio || 1) < 1.5;
  const engine = new Engine(document.getElementById('app'), { quality: antialias ? 'high' : 'low' });
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

  // Calidad gráfica (antes de compilar: el nivel decide qué luces y sombras hay).
  const quality = createQuality({
    engine, models,
    onAutoChange: (tier, dir) => ui.toast(dir > 0
      ? `Calidad gráfica bajada a «${TIERS[tier].label}» para que vaya más fluido.`
      : `Tu equipo va sobrado: calidad gráfica subida a «${TIERS[tier].label}».`, { tone: 'info', duration: 4 }),
  });

  ui.setLoading(0.85, 'Precalentando sombras y materiales…');
  await nextFrame();
  await prewarm(engine, models);

  const game = new Game({ engine, ui, audio, particles, models, quality });
  // Los atajos de prueba solo existen en desarrollo local, no en la página publicada.
  const dev = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (dev) window.__pan = game;
  if (quality.software) {
    ui.toast('Tu navegador dibuja el 3D sin la tarjeta gráfica y irá lento. Activa la aceleración por hardware en su configuración.', { tone: 'warn', duration: 10 });
  }

  // Parámetros de desarrollo/pruebas:
  //   ?manual=1  no arranca el bucle; window.__advance(segundos) avanza el tiempo y dibuja al final.
  //   ?stage=<id>&bread=<id>  salta directamente a una etapa (completando las anteriores).
  const params = dev ? new URLSearchParams(location.search) : new URLSearchParams();
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
    const p = document.createElement('p');
    p.textContent = 'No se pudo cargar Pan Casero 3D. Recarga la página.';
    Object.assign(p.style, { position: 'fixed', inset: 'auto 16px 16px', color: '#fff' });
    document.body.append(p);
  }
});
