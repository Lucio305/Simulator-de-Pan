// Calidad gráfica: elige un nivel según el equipo y ajusta la resolución en vivo para que el juego vaya fluido.
//
// - Tres niveles (alta, media, baja) que cambian sombras, luces secundarias y efectos.
// - Resolución dinámica: si los frames tardan demasiado baja la resolución interna, y la sube
//   cuando sobra margen. En modo automático, si ni con la resolución mínima va fluido, baja de nivel.
// - Detecta navegadores que dibujan el 3D sin la tarjeta gráfica (sin aceleración por hardware).
import * as THREE from 'three';

const STORAGE_KEY = 'pan-casero-3d:calidad';

/**
 * Niveles. pr = factor de resolución (se limita además al devicePixelRatio de la pantalla).
 * shadowEvery = cada cuántos frames se redibuja cada mapa de sombras; doughHz = ritmo de la masa.
 */
export const TIERS = {
  alta: { label: 'Alta', maxPR: 1.5, minPR: 0.9, sunMap: 2048, softShadows: true, spotShadow: true, shadowEvery: 1, sidePendants: true, shafts: true, doughHz: 30 },
  media: { label: 'Media', maxPR: 1.25, minPR: 0.75, sunMap: 1024, softShadows: false, spotShadow: false, shadowEvery: 2, sidePendants: true, shafts: true, doughHz: 20 },
  baja: { label: 'Baja', maxPR: 1, minPR: 0.6, sunMap: 1024, softShadows: false, spotShadow: false, shadowEvery: 3, sidePendants: false, shafts: false, doughHz: 12 },
};
const ORDER = ['alta', 'media', 'baja'];

const SLOW_MS = 25;      // por encima (< 40 fps de media) se considera que va lento
const FAST_MS = 18.5;    // por debajo (> 54 fps) hay margen para subir la resolución
const WINDOW_S = 1;      // las medias se toman por ventanas de 1 s

/** ¿El navegador dibuja WebGL por software (sin aceleración por hardware)? */
export function detectSoftwareRenderer(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

function loadMode() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'auto' || v in TIERS ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function saveMode(mode) {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* sin almacenamiento */ }
}

/**
 * @param {{engine: import('./engine.js').Engine, models: any, onAutoChange?: (tier: string) => void}} deps
 */
export function createQuality({ engine, models, onAutoChange }) {
  const renderer = engine.renderer;
  const dpr = window.devicePixelRatio || 1;
  const software = detectSoftwareRenderer(renderer);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const sun = engine.lights.sun;
  const hemi = engine.lights.hemi;
  const pendants = models.kitchen?.lights?.pendants ?? [];
  const shadowSpots = pendants.filter((p) => p.castShadow);
  const sidePendants = pendants.filter((p) => !p.castShadow);
  const shafts = models.kitchen?.group?.getObjectByName('kitchen-light-shafts') ?? null;
  const hemiBase = hemi.intensity;

  let mode = loadMode();
  let tier = mode === 'auto' ? (software ? 'baja' : coarse ? 'media' : 'alta') : mode;
  let pr = 1;
  let frame = 0;
  let last = 0;
  let warmup = 2;          // segundos que se ignoran tras arrancar o cambiar de nivel (compilación de shaders)
  let acc = 0, count = 0;  // ventana actual
  let slow = 0, fast = 0;  // ventanas seguidas lentas/rápidas
  let fps = 0;

  const effMax = () => Math.min(TIERS[tier].maxPR, dpr);
  const effMin = () => Math.min(TIERS[tier].minPR, effMax());

  function setPixelRatio(v) {
    pr = Math.round(Math.min(effMax(), Math.max(effMin(), v)) * 100) / 100;
    if (Math.abs(renderer.getPixelRatio() - pr) > 0.001) renderer.setPixelRatio(pr);
  }

  /** Aplica un nivel: sombras, luces y efectos (cambiar luces recompila los materiales una vez). */
  function applyTier(t) {
    tier = t;
    const T = TIERS[t];
    if (sun.shadow.mapSize.x !== T.sunMap) {
      sun.shadow.mapSize.set(T.sunMap, T.sunMap);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    shadowSpots.forEach((p) => { p.castShadow = T.spotShadow; });
    // sombras suaves (PCFSoft) o simples (PCF): three no recompila solo al cambiar el tipo
    const type = T.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (renderer.shadowMap.type !== type) {
      renderer.shadowMap.type = type;
      engine.scene.traverse((o) => {
        const m = o.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
      });
    }
    sidePendants.forEach((p) => { p.visible = T.sidePendants; });
    hemi.intensity = hemiBase + (T.sidePendants ? 0 : 0.12); // compensa las lámparas laterales apagadas
    if (shafts) shafts.visible = T.shafts;
    models.dough?.setRebuildRate?.(T.doughHz);
    setPixelRatio(effMax());
    warmup = 2;
    acc = 0; count = 0; slow = 0; fast = 0;
  }

  /** Redibuja los mapas de sombras de forma escalonada (no todos en el mismo frame). */
  function scheduleShadows() {
    const every = TIERS[tier].shadowEvery;
    const lights = [sun, ...shadowSpots.filter((p) => p.castShadow)];
    lights.forEach((l, i) => {
      if (every <= 1) { l.shadow.autoUpdate = true; return; }
      l.shadow.autoUpdate = false;
      if ((frame + i) % every === 0) l.shadow.needsUpdate = true;
    });
  }

  /** Mide el tiempo real entre frames y ajusta resolución y nivel. */
  function measure() {
    const now = performance.now();
    const ms = last ? now - last : 0;
    last = now;
    if (!(ms > 0) || ms > 250) return; // pestaña oculta o un tirón puntual: no cuenta
    if (warmup > 0) { warmup -= ms / 1000; return; }
    acc += ms; count++;
    if (acc < WINDOW_S * 1000) return;
    const avg = acc / count;
    fps = 1000 / avg;
    acc = 0; count = 0;
    if (avg > SLOW_MS) { slow++; fast = 0; } else if (avg < FAST_MS) { fast++; slow = 0; } else { slow = 0; fast = 0; }

    if (slow >= 2) {
      slow = 0;
      if (pr > effMin() + 0.01) {
        setPixelRatio(pr - 0.15);
      } else if (mode === 'auto' && tier !== 'baja') {
        applyTier(ORDER[ORDER.indexOf(tier) + 1]);
        onAutoChange?.(tier);
      }
    } else if (fast >= 5 && pr < effMax() - 0.01) {
      fast = 0;
      setPixelRatio(pr + 0.1);
    }
  }

  engine.onUpdate(() => {
    frame++;
    scheduleShadows();
    measure();
  });
  applyTier(tier);

  return {
    TIERS,
    /** true si el navegador dibuja sin la tarjeta gráfica. */
    software,
    get mode() { return mode; },
    get tier() { return tier; },
    get fps() { return fps; },
    get pixelRatio() { return pr; },
    /**
     * Elige el modo: 'auto' o un nivel fijo ('alta' | 'media' | 'baja').
     * @param {'auto'|'alta'|'media'|'baja'} m
     */
    setMode(m) {
      if (m !== 'auto' && !(m in TIERS)) return;
      mode = m;
      saveMode(m);
      applyTier(m === 'auto' ? tier : m);
    },
    /** Texto corto con el estado actual (para la interfaz). */
    describe() {
      const res = `${pr.toLocaleString('es-ES', { maximumFractionDigits: 2 })}×`;
      const f = fps ? ` · ${Math.round(fps)} fps` : '';
      return `${mode === 'auto' ? 'Automática' : 'Fija'}: calidad ${TIERS[tier].label.toLowerCase()} · resolución ${res}${f}`;
    },
  };
}
