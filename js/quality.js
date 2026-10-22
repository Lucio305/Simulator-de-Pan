// Calidad gráfica: elige un nivel según el equipo y ajusta la resolución en vivo para que el juego vaya fluido.
//
// - Cuatro niveles (alta, media, baja, mínima) que cambian resolución, sombras, lámparas y efectos.
// - Resolución dinámica: si los frames tardan demasiado baja la resolución interna, y la sube cuando sobra margen.
// - Modo automático: si va muy lento baja de nivel en el acto; si va sobrado, sube. Recuerda el nivel que
//   funcionó en este equipo para empezar ya en él la próxima vez.
// - Detecta navegadores que dibujan el 3D sin la tarjeta gráfica (sin aceleración por hardware).
import * as THREE from 'three';

const STORAGE_KEY = 'pan-casero-3d:calidad';       // 'auto' o un nivel fijo elegido por el jugador
const AUTO_KEY = 'pan-casero-3d:calidad-auto';     // último nivel al que llegó el modo automático

/**
 * Niveles. maxPR/minPR = rango de resolución (se limita además al devicePixelRatio de la pantalla).
 * shadowEvery = cada cuántos frames se redibuja cada mapa de sombras; doughHz = ritmo de la masa.
 */
export const TIERS = {
  alta: { label: 'Alta', maxPR: 1.5, minPR: 0.9, shadows: true, sunMap: 2048, softShadows: true, spotShadow: true, shadowEvery: 1, pendants: true, shafts: true, physicalExtras: true, ovenGlow: true, doughDetail: 'high', doughHz: 30 },
  media: { label: 'Media', maxPR: 1.25, minPR: 0.75, shadows: true, sunMap: 1024, softShadows: false, spotShadow: false, shadowEvery: 2, pendants: true, shafts: true, physicalExtras: true, ovenGlow: true, doughDetail: 'high', doughHz: 20 },
  baja: { label: 'Baja', maxPR: 1, minPR: 0.6, shadows: false, sunMap: 1024, softShadows: false, spotShadow: false, shadowEvery: 3, pendants: false, shafts: false, physicalExtras: false, ovenGlow: true, doughDetail: 'low', doughHz: 15 },
  minima: { label: 'Mínima', maxPR: 0.75, minPR: 0.5, shadows: false, sunMap: 1024, softShadows: false, spotShadow: false, shadowEvery: 3, pendants: false, shafts: false, physicalExtras: false, ovenGlow: false, doughDetail: 'low', doughHz: 10 },
};
export const TIER_ORDER = ['alta', 'media', 'baja', 'minima'];

const VERY_SLOW_MS = 40; // una ventana por debajo de 25 fps: bajar de nivel en el acto
const SLOW_MS = 22;      // por debajo de ~45 fps: bajar resolución (y de nivel si ya está al mínimo)
const FAST_MS = 17.5;    // por encima de ~57 fps: hay margen para subir
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

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, v) => { try { localStorage.setItem(key, v); } catch { /* sin almacenamiento */ } };
const isTier = (v) => typeof v === 'string' && Object.hasOwn(TIERS, v);

/** Modo guardado: 'auto' o un nivel fijo. */
export function savedMode() {
  const v = read(STORAGE_KEY);
  return v === 'auto' || isTier(v) ? v : 'auto';
}

/**
 * Nivel con el que arrancará el juego (main.js lo usa para decidir el antialiasing, que no se puede
 * cambiar después de crear el contexto WebGL).
 * @param {{software?: boolean}} opts
 */
export function plannedTier({ software = false } = {}) {
  const mode = savedMode();
  if (mode !== 'auto') return mode;
  if (software) return 'minima';
  const remembered = read(AUTO_KEY);
  if (isTier(remembered)) return remembered;
  return 'media'; // sin datos de este equipo: empieza en media y sube si va sobrado
}

/**
 * @param {{engine: import('./engine.js').Engine, models: any, onAutoChange?: (tier: string) => void}} deps
 */
export function createQuality({ engine, models, onAutoChange }) {
  const renderer = engine.renderer;
  const dpr = window.devicePixelRatio || 1;
  const software = detectSoftwareRenderer(renderer);
  const sun = engine.lights.sun;
  const hemi = engine.lights.hemi;
  const pendants = models.kitchen?.lights?.pendants ?? [];
  const shadowSpots = pendants.filter((p) => p.castShadow);
  const ovenGlow = models.kitchen?.lights?.ovenGlow ?? null;
  const shafts = models.kitchen?.group?.getObjectByName('kitchen-light-shafts') ?? null;
  const hemiBase = hemi.intensity;
  const physicalSaved = new Map(); // material → valores originales de barniz/brillo

  let mode = savedMode();
  let tier = plannedTier({ software });
  let pr = 1;
  let frame = 0;
  let last = 0;
  let warmup = 2;            // segundos que se ignoran tras arrancar o cambiar de nivel (compilación de shaders)
  let acc = 0, count = 0;    // ventana actual
  let slow = 0, fast = 0;    // ventanas seguidas lentas/rápidas
  let fps = 0;
  let wentDown = false;      // si ya bajó de nivel en esta sesión, no vuelve a subir (evita ir y venir)

  const effMax = () => Math.min(TIERS[tier].maxPR, dpr);
  const effMin = () => Math.min(TIERS[tier].minPR, effMax());

  function setPixelRatio(v) {
    pr = Math.round(Math.min(effMax(), Math.max(effMin(), v)) * 100) / 100;
    if (Math.abs(renderer.getPixelRatio() - pr) > 0.001) renderer.setPixelRatio(pr);
  }

  function recompileAll() {
    engine.scene.traverse((o) => {
      const m = o.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
    });
  }

  /** Quita o devuelve el barniz y el brillo de los materiales físicos (salvo la masa, que es la protagonista). */
  function setPhysicalExtras(on) {
    const keep = new Set();
    models.dough?.group?.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => keep.add(m)); });
    engine.scene.traverse((o) => {
      if (!o.material) return;
      [].concat(o.material).forEach((m) => {
        if (!m.isMeshPhysicalMaterial || keep.has(m)) return;
        if (!on) {
          if (!physicalSaved.has(m)) physicalSaved.set(m, { clearcoat: m.clearcoat, sheen: m.sheen, iridescence: m.iridescence });
          m.clearcoat = 0; m.sheen = 0; m.iridescence = 0;
        } else if (physicalSaved.has(m)) {
          Object.assign(m, physicalSaved.get(m));
        }
      });
    });
    if (on) physicalSaved.clear();
  }

  /** Aplica un nivel: resolución, sombras, luces y efectos (algunos cambios recompilan los materiales una vez). */
  function applyTier(t) {
    tier = t;
    const T = TIERS[t];
    let recompile = false;
    if (renderer.shadowMap.enabled !== T.shadows) { renderer.shadowMap.enabled = T.shadows; recompile = true; }
    if (sun.shadow.mapSize.x !== T.sunMap) {
      sun.shadow.mapSize.set(T.sunMap, T.sunMap);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    // sombras suaves (PCFSoft) o simples (PCF): three no recompila solo al cambiar el tipo
    const type = T.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    if (renderer.shadowMap.type !== type) { renderer.shadowMap.type = type; recompile = true; }
    shadowSpots.forEach((p) => { p.castShadow = T.spotShadow; });
    // sin lámparas del techo, más luz ambiente para que la isla no quede apagada
    pendants.forEach((p) => { p.visible = T.pendants; });
    hemi.intensity = hemiBase + (T.pendants ? 0 : 0.45);
    if (ovenGlow) ovenGlow.visible = T.ovenGlow;
    if (shafts) shafts.visible = T.shafts;
    setPhysicalExtras(T.physicalExtras);
    if (recompile) recompileAll();
    models.dough?.setRebuildRate?.(T.doughHz);
    models.dough?.setDetail?.(T.doughDetail);
    setPixelRatio(effMax());
    warmup = 2;
    acc = 0; count = 0; slow = 0; fast = 0;
  }

  /** Cambio de nivel decidido por el modo automático. */
  function autoStep(dir) {
    const i = TIER_ORDER.indexOf(tier) + dir;
    if (i < 0 || i >= TIER_ORDER.length) return false;
    if (dir > 0) wentDown = true;
    applyTier(TIER_ORDER[i]);
    write(AUTO_KEY, tier);
    onAutoChange?.(tier, dir);
    return true;
  }

  /** Redibuja los mapas de sombras de forma escalonada (no todos en el mismo frame). */
  function scheduleShadows() {
    const T = TIERS[tier];
    if (!T.shadows) return;
    const lights = [sun, ...shadowSpots.filter((p) => p.castShadow)];
    lights.forEach((l, i) => {
      if (T.shadowEvery <= 1) { l.shadow.autoUpdate = true; return; }
      l.shadow.autoUpdate = false;
      if ((frame + i) % T.shadowEvery === 0) l.shadow.needsUpdate = true;
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
    const auto = mode === 'auto';

    if (avg > VERY_SLOW_MS) {
      // muy lento: en automático, un nivel menos ya; con nivel fijo, la resolución al mínimo
      if (!(auto && autoStep(1))) setPixelRatio(effMin());
      slow = 0; fast = 0;
      return;
    }
    if (avg > SLOW_MS) { slow++; fast = 0; } else if (avg < FAST_MS) { fast++; slow = 0; } else { slow = 0; fast = 0; }

    if (slow >= 2) {
      slow = 0;
      if (pr > effMin() + 0.01) setPixelRatio(pr - 0.15);
      else if (auto) autoStep(1);
    } else if (fast >= 4 && pr < effMax() - 0.01) {
      fast = 0;
      setPixelRatio(pr + 0.1);
    } else if (fast >= 8 && auto && !wentDown) {
      fast = 0;
      autoStep(-1); // va sobrado con la resolución máxima: un nivel más
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
    TIER_ORDER,
    /** true si el navegador dibuja sin la tarjeta gráfica. */
    software,
    get mode() { return mode; },
    get tier() { return tier; },
    get fps() { return fps; },
    get pixelRatio() { return pr; },
    /**
     * Elige el modo: 'auto' o un nivel fijo.
     * @param {'auto'|'alta'|'media'|'baja'|'minima'} m
     */
    setMode(m) {
      if (m !== 'auto' && !isTier(m)) return;
      mode = m;
      write(STORAGE_KEY, m);
      wentDown = false;
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
