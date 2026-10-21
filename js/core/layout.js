// Distribución de la cocina en coordenadas de mundo (1 unidad = 1 metro, Y hacia arriba).
// Todos los modelos y etapas leen de aquí para que las piezas encajen entre sí.
import * as THREE from 'three';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

/** Habitación: suelo en y=0, pared del fondo en z=-1.6, paredes laterales en x=±3.5, techo a 2.8. */
export const ROOM = { minX: -3.5, maxX: 3.5, backZ: -1.6, frontZ: 3.2, height: 2.8 };

/** Isla de trabajo central (donde ocurre casi todo). La superficie superior está en y = COUNTER.topY. */
export const COUNTER = { x: 0, z: 0, width: 2.6, depth: 0.9, topY: 0.92, thickness: 0.06 };
// => encimera de x ∈ [-1.3, 1.3], z ∈ [-0.45, 0.45]

/** Mueble bajo del fondo (contra la pared): frente en z = -1.0, encimera a la misma altura. */
export const BACK_RUN = { minX: -2.9, maxX: 1.55, frontZ: -1.0, topY: 0.92 };

/** Ventana en la pared del fondo (luz de día principal). */
export const WINDOW = { centerX: -0.7, centerY: 1.62, width: 1.4, height: 1.0 };

/**
 * Horno de pared dentro de una columna alta al final del mueble del fondo.
 * La columna ocupa x ∈ [1.6, 2.4], frente en z = -1.0. Deja un hueco (niche) para el aparato.
 * El grupo del horno se coloca con su origen en `front` = centro de la cara frontal del aparato;
 * el aparato se extiende hacia -z (`depth`). La puerta abate hacia +z girando sobre su borde inferior.
 */
export const OVEN = {
  column: { minX: 1.6, maxX: 2.4, frontZ: -1.0, depth: 0.6, height: 2.25 },
  front: v(2.0, 1.12, -1.0),
  width: 0.6, height: 0.72, depth: 0.56,
};

/** Nevera decorativa a la derecha del horno. */
export const FRIDGE = { minX: 2.45, maxX: 3.3, frontZ: -1.0, height: 1.95 };

/** Puntos sobre la encimera de la isla (y = superficie donde se apoya el objeto). */
export const SPOTS = {
  scale: v(-0.32, COUNTER.topY, 0.12),     // báscula; el bol va encima de su plato
  board: v(0.42, COUNTER.topY, 0.1),       // tabla de amasar/formar (0.5 x 0.36)
  tray: v(0.92, COUNTER.topY, -0.1),       // bandeja de horno / molde esperando
  coolingRack: v(0.92, COUNTER.topY, -0.1),// rejilla de enfriado (aparece al final, en el sitio de la bandeja)
  spoonRest: v(-0.02, COUNTER.topY, 0.24), // cuchara de madera en reposo
  clothRest: v(-0.78, COUNTER.topY, 0.24), // paño doblado
  knifeRest: v(0.2, COUNTER.topY, 0.3),    // cuchilla de greñar / cuchillo de pan
  ingredients: {                            // fila trasera de ingredientes
    flour: v(-1.05, COUNTER.topY, -0.24),
    water: v(-0.8, COUNTER.topY, -0.27),
    yeast: v(-0.63, COUNTER.topY, -0.3),
    salt: v(-0.51, COUNTER.topY, -0.3),
    sugar: v(-0.38, COUNTER.topY, -0.29),
    oil: v(-0.22, COUNTER.topY, -0.28),
  },
};

/** Tamaños de referencia compartidos. */
export const SIZES = {
  scaleHeight: 0.035,        // altura del plato de la báscula sobre la encimera
  bowl: { rimRadius: 0.15, height: 0.11, baseRadius: 0.075, wall: 0.006 },
  board: { width: 0.5, depth: 0.36, thickness: 0.025 },
  tray: { width: 0.46, depth: 0.32, thickness: 0.02 },
  tin: { length: 0.24, width: 0.125, height: 0.09 },
  dough: { ballRadius: 0.07, baguetteLength: 0.4, bouleRadius: 0.09 },
};

/** Vistas de cámara (posición + punto al que mira). Las etapas las usan con engine.moveCamera(). */
export const CAMERAS = {
  intro: { position: v(1.6, 2.1, 3.4), target: v(0.3, 1.0, -0.5) },
  overview: { position: v(0.35, 1.85, 2.6), target: v(0.35, 0.95, -0.35) },
  ingredients: { position: v(-0.6, 1.45, 0.85), target: v(-0.6, 0.97, -0.12) },
  bowl: { position: v(-0.32, 1.4, 0.64), target: v(-0.32, 0.98, 0.1) },
  board: { position: v(0.42, 1.38, 0.64), target: v(0.42, 0.97, 0.08) },
  tray: { position: v(0.92, 1.38, 0.55), target: v(0.92, 0.98, -0.1) },
  ovenFront: { position: v(1.62, 1.45, 0.3), target: v(2.0, 1.1, -1.0) },
  ovenWindow: { position: v(2.0, 1.18, -0.5), target: v(2.0, 1.05, -1.3) },
  result: { position: v(0.92, 1.28, 0.5), target: v(0.92, 1.0, -0.1) },
};
