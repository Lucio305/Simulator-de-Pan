// Motor de render: renderer, cámara, entorno, luces base, bucle, puntero y raycasting.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { updateAnimations, animate, ease, setAnimationTimeScale } from './core/anim.js';

export class Engine {
  /**
   * @param {HTMLElement} container elemento que contendrá el <canvas>
   * @param {{quality?: 'high'|'low'}} opts
   */
  constructor(container, { quality = 'high' } = {}) {
    this.container = container;
    this.quality = quality;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    if (this.reducedMotion) setAnimationTimeScale(1.6);

    const renderer = new THREE.WebGLRenderer({ antialias: quality === 'high', powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality === 'high' ? 1.5 : 1)); // quality.js la ajusta en vivo
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.localClippingEnabled = true; // el corte del pan usa planos de recorte locales
    renderer.domElement.classList.add('scene-canvas');
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);
    this.renderer = renderer;
    this.canvas = renderer.domElement;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x2a2522);
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
    scene.environmentIntensity = 0.55; // r163+; en r160 se ignora sin errores
    pmrem.dispose();
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 0.02, 60);
    camera.position.set(0.35, 1.85, 2.6);
    this.camera = camera;
    this.cameraTarget = new THREE.Vector3(0.35, 0.95, -0.35);
    camera.lookAt(this.cameraTarget);

    // Luces base. kitchen.js añade las luces "prácticas" (lámparas, luz de ventana...).
    const hemi = new THREE.HemisphereLight(0xfff4e6, 0x3a2e26, 0.55);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.2);
    sun.position.set(-2.2, 3.6, -1.2); // entra por la ventana del fondo, desde la izquierda
    sun.target.position.set(0.2, 0.9, 0.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024);
    sun.shadow.camera.left = -3; sun.shadow.camera.right = 3;
    sun.shadow.camera.top = 3; sun.shadow.camera.bottom = -3;
    sun.shadow.camera.near = 0.5; sun.shadow.camera.far = 10;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);
    this.lights = { hemi, sun };

    // Cámara libre (desactivada por defecto: las etapas dirigen la cámara).
    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.target.copy(this.cameraTarget);
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 5;
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.updaters = new Set();
    this.listeners = { pointerdown: new Set(), pointermove: new Set(), pointerup: new Set() };
    this.raycaster = new THREE.Raycaster();
    this._cameraAnim = null;
    this._running = false;
    this._parallax = new THREE.Vector2();
    this._parallaxTarget = new THREE.Vector2();
    this.parallaxEnabled = !this.reducedMotion;

    this._bindPointer();
    // Al girar o redimensionar la ventana, la cámara se actualiza antes que los encuadres de las etapas
    // (este listener se registra primero); el ResizeObserver cubre los cambios del contenedor.
    window.addEventListener('resize', () => this.resize());
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
  }

  /** Registra fn(dt, elapsed) para cada frame. Devuelve una función para darlo de baja. */
  onUpdate(fn) { this.updaters.add(fn); return () => this.updaters.delete(fn); }

  /** Suscribe a eventos de puntero sobre el canvas: 'pointerdown' | 'pointermove' | 'pointerup'. */
  on(type, fn) { this.listeners[type].add(fn); return () => this.listeners[type].delete(fn); }

  start() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    const loop = () => {
      if (!this._running) return;
      this._raf = requestAnimationFrame(loop);
      this.tick(Math.min(this.clock.getDelta(), 0.05));
    };
    loop();
  }

  stop() { this._running = false; cancelAnimationFrame(this._raf); }

  /** Avanza un frame (lo usa el bucle; las pruebas pueden llamarlo a mano sin dibujar). */
  tick(dt, render = true) {
    this.elapsed += dt;
    updateAnimations(dt);
    for (const fn of [...this.updaters]) {
      try { fn(dt, this.elapsed); } catch (e) { console.error(e); }
    }
    if (this.controls.enabled) {
      this.controls.update();
    } else if (!this._cameraAnim) {
      // Paralaje sutil con el ratón para que la escena "respire".
      this._parallax.x += (this._parallaxTarget.x - this._parallax.x) * Math.min(1, dt * 3);
      this._parallax.y += (this._parallaxTarget.y - this._parallax.y) * Math.min(1, dt * 3);
      if (this.parallaxEnabled && this._basePos) {
        const right = new THREE.Vector3().subVectors(this.cameraTarget, this._basePos).cross(this.camera.up).normalize();
        this.camera.position.copy(this._basePos)
          .addScaledVector(right, this._parallax.x * 0.035)
          .addScaledVector(this.camera.up, this._parallax.y * 0.02);
        this.camera.lookAt(this.cameraTarget);
      }
    }
    if (render) this.renderer.render(this.scene, this.camera);
  }

  /** Dibuja el frame actual sin avanzar el tiempo. */
  render() { this.renderer.render(this.scene, this.camera); }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // En pantallas verticales abrimos el campo de visión para que quepa la escena.
    this.camera.fov = w / h < 0.8 ? 62 : w / h < 1.2 ? 52 : 45;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Mueve la cámara suavemente a una vista {position, target}.
   * @returns {Promise<boolean>}
   */
  moveCamera({ position, target }, { duration = 1.3, ease: easing = ease.inOutCubic } = {}) {
    // Última vista pedida por las etapas: la cámara vuelve a ella al salir de la cámara libre.
    this._guided = { position: position.clone(), target: target.clone() };
    this._cameraAnim?.cancel();
    const fromPos = this.camera.position.clone();
    const fromTarget = this.cameraTarget.clone();
    const toPos = position.clone(), toTarget = target.clone();
    if (duration <= 0) { this._setView(toPos, toTarget); return Promise.resolve(true); }
    const p = animate({
      duration, ease: easing,
      onUpdate: (t) => {
        const pos = fromPos.clone().lerp(toPos, t);
        pos.y += Math.sin(Math.PI * t) * 0.06 * fromPos.distanceTo(toPos); // ligero arco
        this._setView(pos, fromTarget.clone().lerp(toTarget, t), false);
      },
    });
    this._cameraAnim = p;
    return p.then((r) => {
      if (this._cameraAnim === p) { this._cameraAnim = null; if (r) this._setView(toPos, toTarget); }
      return r;
    });
  }

  _setView(pos, target, setBase = true) {
    this.camera.position.copy(pos);
    this.cameraTarget.copy(target);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    if (setBase) this._basePos = pos.clone();
    else this._basePos = null;
  }

  /** Activa/desactiva la cámara libre (OrbitControls). */
  setFreeCamera(enabled) {
    this.controls.enabled = enabled;
    if (enabled) { this.controls.target.copy(this.cameraTarget); return; }
    // El regreso parte de la vista real (OrbitControls puede haber desplazado el objetivo).
    this.cameraTarget.copy(this.controls.target);
    if (this._cameraAnim) return; // ya va camino de una vista guiada
    if (this._guided) this.moveCamera(this._guided, { duration: 0.8 });
    else this._basePos = this.camera.position.clone();
  }

  setCursor(cursor) { this.canvas.style.cursor = cursor || ''; }

  /** Coordenadas normalizadas (-1..1) a partir de un evento de puntero. */
  toNdc(clientX, clientY, out = new THREE.Vector2()) {
    const r = this.canvas.getBoundingClientRect();
    return out.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  }

  /** Intersecciones del rayo de cámara (ndc) con `objects`. */
  raycast(ndc, objects, recursive = true) {
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.intersectObjects(Array.isArray(objects) ? objects : [objects], recursive);
  }

  /** Punto donde el rayo (ndc) corta el plano horizontal y = planeY (o un THREE.Plane). */
  screenToPlane(ndc, plane) {
    const p = typeof plane === 'number' ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -plane) : plane;
    this.raycaster.setFromCamera(ndc, this.camera);
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(p, out) ? out : null;
  }

  /** Proyecta un punto del mundo a píxeles CSS relativos al canvas. */
  worldToScreen(vec3) {
    const p = vec3.clone().project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: (p.x * 0.5 + 0.5) * r.width, y: (-p.y * 0.5 + 0.5) * r.height, visible: p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
  }

  _bindPointer() {
    const el = this.canvas;
    const wrap = (type) => (e) => {
      const ev = {
        type, x: e.clientX, y: e.clientY, ndc: this.toNdc(e.clientX, e.clientY),
        button: e.button, pointerId: e.pointerId, pointerType: e.pointerType, originalEvent: e,
      };
      if (type === 'pointermove' && !this.controls.enabled) this._parallaxTarget.copy(ev.ndc);
      for (const fn of [...this.listeners[type]]) fn(ev);
    };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture?.(e.pointerId); wrap('pointerdown')(e); });
    el.addEventListener('pointermove', wrap('pointermove'));
    el.addEventListener('pointerup', (e) => { el.releasePointerCapture?.(e.pointerId); wrap('pointerup')(e); });
    el.addEventListener('pointercancel', wrap('pointerup'));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
