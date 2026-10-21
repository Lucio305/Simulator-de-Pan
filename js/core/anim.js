// Motor mínimo de animaciones (tweens) basado en promesas.
// Lo avanza el bucle principal con updateAnimations(dt), así todo se pausa a la vez
// y las secuencias se escriben con async/await:  await animate({ duration: 1, onUpdate: t => ... })

const active = new Set();

export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outElastic: (t) => (t === 0 || t === 1 ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

// Escala global del tiempo de las animaciones (p. ej. 0.4 con prefers-reduced-motion).
let timeScale = 1;
export function setAnimationTimeScale(s) { timeScale = s; }

/**
 * Anima t de 0 a 1 en `duration` segundos.
 * @returns {Promise<boolean> & {cancel(): void}} resuelve true al terminar, false si se cancela.
 */
export function animate({ duration = 1, delay = 0, ease: easing = ease.inOutCubic, onUpdate, onComplete, tag } = {}) {
  let resolveFn;
  const promise = new Promise((r) => (resolveFn = r));
  const a = {
    elapsed: -delay, duration: Math.max(1e-4, duration), easing, onUpdate, onComplete, tag,
    resolve: resolveFn, done: false,
  };
  active.add(a);
  promise.cancel = () => { if (!a.done) { a.done = true; active.delete(a); a.resolve(false); } };
  return promise;
}

/** Interpola propiedades numéricas de `target` (sirve para Vector3, Euler, materiales...). */
export function tweenTo(target, props, opts = {}) {
  const from = {};
  for (const k in props) from[k] = target[k];
  return animate({
    ...opts,
    onUpdate: (t, raw) => {
      for (const k in props) target[k] = from[k] + (props[k] - from[k]) * t;
      opts.onUpdate?.(t, raw);
    },
  });
}

/** Mueve un Object3D hasta `to` (Vector3 en el espacio de su padre) siguiendo un arco de altura `height`. */
export function arcMove(object, to, { height = 0.25, duration = 1, ease: easing = ease.inOutCubic, rotateTo, onUpdate } = {}) {
  const from = object.position.clone();
  const fromRot = object.rotation.clone();
  return animate({
    duration, ease: easing,
    onUpdate: (t) => {
      object.position.lerpVectors(from, to, t);
      object.position.y += Math.sin(Math.PI * t) * height;
      if (rotateTo) {
        object.rotation.set(
          fromRot.x + ((rotateTo.x ?? fromRot.x) - fromRot.x) * t,
          fromRot.y + ((rotateTo.y ?? fromRot.y) - fromRot.y) * t,
          fromRot.z + ((rotateTo.z ?? fromRot.z) - fromRot.z) * t,
        );
      }
      onUpdate?.(t);
    },
  });
}

/** Espera en tiempo de simulación (se congela si el bucle se detiene). */
export function wait(seconds) { return animate({ duration: seconds, ease: ease.linear }); }

/** Cancela todas las animaciones (o solo las de una etiqueta). */
export function cancelAnimations(tag) {
  for (const a of [...active]) if (tag === undefined || a.tag === tag) { a.done = true; active.delete(a); a.resolve(false); }
}

export function updateAnimations(dt) {
  for (const a of [...active]) {
    if (a.done) continue;
    a.elapsed += dt * timeScale;
    if (a.elapsed < 0) continue;
    const raw = Math.min(1, a.elapsed / a.duration);
    try { a.onUpdate?.(a.easing(raw), raw); } catch (e) { console.error(e); }
    if (raw >= 1) {
      a.done = true;
      active.delete(a);
      try { a.onComplete?.(); } catch (e) { console.error(e); }
      a.resolve(true);
    }
  }
}
