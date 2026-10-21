// Interfaz (HUD) de Pan Casero 3D: barra superior con los pasos, instrucciones, receta, medidores,
// reloj, controles del dock, avisos, pista flotante, diálogos, pantalla de inicio y de resultados.
// Todo el DOM del HUD se construye aquí; index.html solo trae la pantalla de carga estática.
// Estilo "esmaltado": ver css/styles.css (todas las clases y colores salen de allí).

// ---------------------------------------------------------------------------------------------
// Iconos (trazo, currentColor). viewBox 24x24.
// ---------------------------------------------------------------------------------------------
const ICONS = {
  sound: '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.3a8 8 0 0 1 0 11.4"/>',
  soundOff: '<path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  camera: '<path d="M3.5 8.8c0-.9.7-1.6 1.6-1.6h2.3l1.5-2.4h6.2l1.5 2.4h2.3c.9 0 1.6.7 1.6 1.6v8.6c0 .9-.7 1.6-1.6 1.6H5.1c-.9 0-1.6-.7-1.6-1.6z"/><circle cx="12" cy="13" r="3.4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.6.3-1 .8-1 1.5v.5"/><path d="M12 16.9v.1"/>',
  restart: '<path d="M4.5 12a7.5 7.5 0 1 0 2.3-5.4"/><path d="M4.5 4.5v4.2h4.2"/>',
  play: '<path d="M8 5.8v12.4a.6.6 0 0 0 .9.5l9.6-6.2a.6.6 0 0 0 0-1L8.9 5.3a.6.6 0 0 0-.9.5z"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  forward: '<path d="M3.5 6.5v11l7.5-5.5zM12.5 6.5v11l7.5-5.5z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  warning: '<path d="M10.3 4.6 2.9 17.4a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.2"/><path d="M12 17v.1"/>',
  thermometer: '<path d="M14 14.6V5.5a2 2 0 1 0-4 0v9.1a4 4 0 1 0 4 0z"/><path d="M12 9.5v7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path class="icon-hand" d="M12 7v5l3.2 2"/>',
  hand: '<path d="M8.5 12.5V6.8a1.5 1.5 0 0 1 3 0v4.7"/><path d="M11.5 11V5a1.5 1.5 0 0 1 3 0v6"/><path d="M14.5 11V6.8a1.5 1.5 0 0 1 3 0v6.7c0 3.9-2.9 6.5-6.3 6.5-2.3 0-3.8-.9-5-2.6l-2.3-3.4a1.6 1.6 0 0 1 2.6-1.8l1.5 1.8"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6v.1"/>',
  chevron: '<path d="m6 9.5 6 6 6-6"/>',
  knife: '<path d="M3.5 20.5 8.8 15.2"/><path d="M8.8 15.2 19.6 4.4c1 2.9-.3 6.6-3.6 9.9l-3.4 3.4z"/>',
  loaf: '<path d="M3.5 15.8C3.5 11 7.3 7.5 12 7.5s8.5 3.5 8.5 8.3c0 1.5-1.2 2.7-2.7 2.7H6.2a2.7 2.7 0 0 1-2.7-2.7z"/><path d="m8.6 11.2 1.6 2.2M12.3 10.4l1.6 2.2M16 11.4l1.2 1.7"/>',
  tip: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2v.2h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
};
// Alias por comodidad para quien escriba las etapas.
const ICON_ALIAS = {
  hold: 'hand', 'fast-forward': 'forward', fast: 'forward', 'sound-off': 'soundOff', mute: 'soundOff',
  temp: 'thermometer', temperature: 'thermometer', time: 'clock', timer: 'clock', ok: 'check',
  cut: 'knife', bread: 'loaf', reload: 'restart', again: 'restart', alert: 'warning',
};
const STAR_PATH = 'M12 2.6l2.9 5.9 6.4.9-4.7 4.5 1.1 6.4L12 17.3l-5.7 3 1.1-6.4-4.7-4.5 6.4-.9z';

const ROW_STATE_TEXT = {
  pending: 'pendiente', active: 'en curso', ok: 'correcto', over: 'te has pasado', under: 'falta',
};
const TONE_ICON = { info: 'info', good: 'check', warn: 'warning', bad: 'warning' };
const PREFS_KEY = 'pan-casero-3d:inicio';

// ---------------------------------------------------------------------------------------------
// Utilidades de DOM y formato
// ---------------------------------------------------------------------------------------------

/** Crea un elemento con atributos/propiedades y lo rellena con hijos (nodos o texto). */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) if (c != null && c !== false) node.append(c);
  return node;
}

/** Icono SVG en línea (decorativo). Devuelve null si el nombre no existe. */
function icon(name, cls = '') {
  const key = ICONS[name] ? name : ICON_ALIAS[name];
  if (!key) return null;
  const t = document.createElement('template');
  t.innerHTML = `<svg class="icon icon--${key} ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[key]}</svg>`;
  return t.content.firstChild;
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** Llama a una función del juego sin dejar que un error rompa la interfaz. */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    const r = fn(...args);
    if (r && typeof r.catch === 'function') r.catch((e) => console.error(e));
    return r;
  } catch (e) {
    console.error(e);
    return undefined;
  }
}

/** Cantidades al estilo de la báscula: "1 254", "7", "3,5". */
function fmtQty(v) {
  const n = Number(v) || 0;
  const r = Math.abs(n) >= 20 ? Math.round(n) : Math.round(n * 10) / 10;
  const [int, dec] = String(Math.abs(r)).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
  return (r < 0 ? '−' : '') + grouped + (dec ? `,${dec}` : '');
}

/** Número para controles deslizantes (respeta decimales del paso). */
function fmtNumber(v, step = 1) {
  const decimals = Math.max(0, Math.min(3, (String(step).split('.')[1] || '').length));
  return Number(v).toFixed(decimals).replace('.', ',');
}

const slug = (v) => String(v).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* sin almacenamiento */ }
}

/** Dificultad → variante de color de la etiqueta. */
function difficultyTone(text) {
  const s = slug(text || '');
  if (s.startsWith('facil')) return 'good';
  if (s.startsWith('dificil')) return 'bad';
  return 'warn';
}

// Ilustraciones de los panes (SVG en línea; colores desde css/styles.css).
const BREAD_ART = {
  round: `
    <ellipse class="art-shadow" cx="60" cy="63" rx="44" ry="5.5"/>
    <path class="art-crust" d="M15 57c0-21 20-37 45-37s45 16 45 37c0 3.3-2.7 5.5-6 5.5H21c-3.3 0-6-2.2-6-5.5z"/>
    <path class="art-gloss" d="M30 37c7-7 17-10.5 28-10.5"/>
    <path class="art-score" d="M37 38c12 7.5 34 7.5 46 0"/>
    <path class="art-score" d="M61 25c-5 10-5 24 0 33"/>
    <circle class="art-flour" cx="44" cy="31" r="1.6"/><circle class="art-flour" cx="76" cy="30" r="1.3"/>
    <circle class="art-flour" cx="52" cy="50" r="1.1"/><circle class="art-flour" cx="83" cy="47" r="1.5"/>`,
  baguette: `
    <ellipse class="art-shadow" cx="60" cy="62" rx="50" ry="5"/>
    <g transform="rotate(-11 60 40)">
      <rect class="art-crust" x="7" y="29" width="106" height="24" rx="12"/>
      <path class="art-gloss" d="M18 35h30"/>
      <path class="art-score" d="M24 36l11 11M43 35l11 11M62 35l11 11M81 35l11 11"/>
    </g>`,
  tin: `
    <ellipse class="art-shadow" cx="60" cy="64" rx="42" ry="5"/>
    <path class="art-crust" d="M27 38c0-13 15-20.5 33-20.5S93 25 93 38z"/>
    <path class="art-gloss" d="M37 28c6-4 14-6 22-6"/>
    <path class="art-tin" d="M22 36h76l-6.5 26a3 3 0 0 1-2.9 2.3H31.4a3 3 0 0 1-2.9-2.3z"/>
    <path class="art-tin-rim" d="M21 36h78"/>
    <path class="art-tin-shine" d="M31 43l4 16"/>`,
};
function breadArt(id, index) {
  const kind = /bague|barra/.test(id) ? 'baguette' : /molde|loaf|tin/.test(id) ? 'tin'
    : /hogaza|boule|redond/.test(id) ? 'round' : ['round', 'baguette', 'tin'][index % 3];
  const t = document.createElement('template');
  t.innerHTML = `<svg class="bread-art" viewBox="0 0 120 72" aria-hidden="true" focusable="false">${BREAD_ART[kind]}</svg>`;
  return t.content.firstChild;
}

// Control nulo: lo devuelve get(id) cuando el id no existe, para que las etapas nunca fallen.
const NULL_CONTROL = Object.freeze({ el: null, set() {} });

// ---------------------------------------------------------------------------------------------
// createUI
// ---------------------------------------------------------------------------------------------

/**
 * Construye el HUD dentro de `root` y devuelve su API. Llamarlo dos veces con el mismo root
 * devuelve la misma instancia.
 * @param {{root?: HTMLElement}} [opts]
 */
export function createUI({ root = document.getElementById('hud') } = {}) {
  if (!root) {
    root = el('div', { id: 'hud' });
    document.body.append(root);
  }
  if (root.__panUI) return root.__panUI;

  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  // Pantallas pequeñas (teléfono vertical u horizontal): la instrucción empieza plegada.
  const compactQuery = window.matchMedia?.('(max-width: 720px), (max-height: 500px)');
  const reducedMotion = () => !!motionQuery?.matches;
  const handlers = { sound: new Set(), camera: new Set(), restart: new Set(), help: new Set() };
  const emit = (name) => handlers[name].forEach((fn) => safeCall(fn));

  // ---------- Región viva (lectores de pantalla) ----------
  const live = el('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const pendingLive = [];
  let liveTimer = 0;
  /** Anuncia un texto en la región viva (agrupa los que llegan casi a la vez). */
  function announce(text) {
    if (!text) return;
    pendingLive.push(String(text));
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      live.textContent = '';
      const msg = pendingLive.splice(0).join('. ');
      requestAnimationFrame(() => { live.textContent = msg; });
    }, 80);
  }

  // ---------- Barra superior ----------
  const iconButton = (name, label, onClick, toggle = false) => el('button', {
    type: 'button', class: 'icon-btn', id: `hud-${slug(label)}`, 'aria-label': label, 'data-tip': label,
    'aria-pressed': toggle ? 'false' : null, onclick: onClick,
  }, [icon(name)]);
  const btnSound = iconButton('soundOff', 'Sonido', () => emit('sound'), true);
  const btnCamera = iconButton('camera', 'Cámara libre', () => emit('camera'), true);
  const btnHelp = iconButton('help', 'Ayuda', () => emit('help'));
  const btnRestart = iconButton('restart', 'Reiniciar', () => emit('restart'));

  const stepList = el('ol', { class: 'stepper__list' });
  const stepCompactText = el('span', { class: 'stepper__compact-text' });
  const stepCompactFill = el('i');
  const stepper = el('nav', { class: 'panel stepper', 'aria-label': 'Pasos de la receta', hidden: true }, [
    stepList,
    el('div', { class: 'stepper__compact' }, [stepCompactText, el('span', { class: 'stepper__compact-bar', 'aria-hidden': 'true' }, [stepCompactFill])]),
  ]);
  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'panel brand-plate' }, [
      el('span', { class: 'brand-plate__mark' }, [icon('loaf')]),
      el('span', { class: 'brand brand-plate__name', text: 'Pan Casero 3D' }),
    ]),
    stepper,
    el('div', { class: 'panel toolbar', role: 'toolbar', 'aria-label': 'Opciones' }, [btnSound, btnCamera, btnHelp, btnRestart]),
  ]);

  // ---------- Instrucción ----------
  const instrKicker = el('p', { class: 'kicker instr__kicker' });
  const instrTitle = el('h2', { class: 'instr__title', id: 'hud-instr-title' });
  const instrText = el('p', { class: 'instr__text' });
  const tipText = el('p', { class: 'tip__text' });
  const tipBox = el('div', { class: 'tip', hidden: true }, [
    el('p', { class: 'tip__label' }, [icon('tip'), 'Consejo']), tipText,
  ]);
  const instrBody = el('div', { class: 'instr__body', id: 'hud-instr-body' }, [instrText, tipBox]);
  const instrToggle = el('button', {
    type: 'button', class: 'icon-btn icon-btn--sm instr__toggle', id: 'hud-instr-toggle',
    'aria-expanded': 'true', 'aria-controls': 'hud-instr-body', 'aria-label': 'Plegar la instrucción',
    onclick: () => setCollapsed(!collapsed),
  }, [icon('chevron')]);
  const instrCard = el('section', { class: 'panel card instr', 'aria-labelledby': 'hud-instr-title', hidden: true }, [
    el('header', { class: 'instr__head' }, [el('div', { class: 'instr__heading' }, [instrKicker, instrTitle]), instrToggle]),
    instrBody,
  ]);

  // ---------- Receta ----------
  const recipeTitle = el('h3', { class: 'recipe__title' });
  const recipeCount = el('span', { class: 'recipe__count' });
  const recipeRows = el('ul', { class: 'recipe__rows' });
  const recipeCard = el('section', { class: 'panel card recipe', 'aria-label': 'Receta', hidden: true }, [
    el('header', { class: 'recipe__head' }, [el('p', { class: 'kicker', text: 'Receta' }), recipeCount]),
    recipeTitle, recipeRows,
  ]);

  // ---------- Reloj y medidores ----------
  const clockLabel = el('p', { class: 'kicker clock__label' });
  const clockText = el('p', { class: 'clock__text' });
  const clockSub = el('p', { class: 'clock__sub' });
  const clockCard = el('section', { class: 'panel card clock', 'aria-label': 'Tiempo', hidden: true }, [
    el('span', { class: 'clock__icon' }, [icon('clock')]),
    el('div', { class: 'clock__body' }, [clockLabel, clockText, clockSub]),
  ]);
  const metersList = el('ul', { class: 'meters__list' });
  const metersCard = el('section', { class: 'panel card meters', 'aria-label': 'Medidores', hidden: true }, [metersList]);

  // ---------- Dock ----------
  const dock = el('div', { class: 'panel dock', role: 'group', 'aria-label': 'Controles', hidden: true });

  // ---------- Composición ----------
  const sideLeft = el('aside', { class: 'side side--left', 'aria-label': 'Instrucciones y receta' }, [instrCard, recipeCard]);
  const sideRight = el('aside', { class: 'side side--right', 'aria-label': 'Tiempo y medidores' }, [clockCard, metersCard]);
  const sheet = el('div', { class: 'sheet' }, [sideLeft, dock]);
  const hud = el('div', { class: 'hud' }, [topbar, sideRight, sheet]);
  const toasts = el('div', { class: 'toasts', 'aria-hidden': 'true' });
  const hintText = el('span');
  const hint = el('div', { class: 'hint', 'aria-hidden': 'true' }, [hintText]);
  root.append(hud, hint, toasts, live);

  // ---------- Estado ----------
  let stages = [];
  let stageIndex = -1;
  let busy = false;
  let collapsed = false;
  let lastInstrTitle = null;
  const controls = new Map();
  const meters = new Map();
  const rows = new Map();

  /** Oculta columnas y hoja cuando no tienen nada visible. */
  function refreshLayout() {
    sideLeft.hidden = instrCard.hidden && recipeCard.hidden;
    sideRight.hidden = clockCard.hidden && metersCard.hidden;
    sheet.classList.toggle('is-empty', sideLeft.hidden && dock.hidden);
  }

  function setCollapsed(on) {
    collapsed = !!on;
    sheet.classList.toggle('is-collapsed', collapsed);
    instrToggle.setAttribute('aria-expanded', String(!collapsed));
    instrToggle.setAttribute('aria-label', collapsed ? 'Mostrar la instrucción completa' : 'Plegar la instrucción');
  }

  // ---------- Modales (pila, foco atrapado, Escape) ----------
  const modals = [];
  function syncInert() {
    const top = modals.length ? modals[modals.length - 1].layer : null;
    hud.toggleAttribute('inert', !!top);
    for (const m of modals) m.layer.toggleAttribute('inert', m.layer !== top);
  }
  function pushModal(layer, onEscape) {
    modals.push({ layer, onEscape, restore: document.activeElement });
    syncInert();
  }
  function popModal(layer) {
    const i = modals.findIndex((m) => m.layer === layer);
    if (i < 0) return;
    const [m] = modals.splice(i, 1);
    syncInert();
    if (i === modals.length && m.restore?.isConnected && !m.restore.closest('[inert]')) {
      try { m.restore.focus({ preventScroll: true }); } catch { /* sin foco */ }
    }
  }
  function focusables(layer) {
    const all = [...layer.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')];
    return all.filter((n) => !n.disabled && n.getClientRects().length > 0
      && !(n.type === 'radio' && !n.checked && layer.querySelector(`input[type=radio][name="${n.name}"]:checked`)));
  }
  document.addEventListener('keydown', (e) => {
    const top = modals[modals.length - 1];
    if (!top) return;
    if (e.key === 'Escape' && top.onEscape) {
      e.preventDefault();
      top.onEscape();
    } else if (e.key === 'Tab') {
      const items = focusables(top.layer);
      if (!items.length) { e.preventDefault(); return; }
      const i = items.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && (i === items.length - 1 || i < 0)) { e.preventDefault(); items[0].focus(); }
    }
  }, true);

  // =============================================================================================
  // Carga y errores
  // =============================================================================================
  const loading = document.getElementById('loading');
  let loadingTimer = 0;

  /** Actualiza la pantalla de carga (0..1) y su texto. */
  function setLoading(progress01, text) {
    if (!loading) return;
    clearTimeout(loadingTimer);
    loading.hidden = false;
    loading.classList.remove('is-hidden');
    const p = Math.round(clamp01(progress01) * 100);
    const fill = loading.querySelector('.loading__fill');
    if (fill) fill.style.width = `${p}%`;
    loading.querySelector('[role="progressbar"]')?.setAttribute('aria-valuenow', String(p));
    const t = loading.querySelector('.loading__text');
    if (t && text) t.textContent = text;
  }

  /** Funde y retira la pantalla de carga. */
  function hideLoading() {
    if (!loading || loading.hidden) return;
    loading.classList.add('is-hidden');
    clearTimeout(loadingTimer);
    loadingTimer = setTimeout(() => { loading.hidden = true; }, reducedMotion() ? 0 : 520);
  }

  let errorLayer = null;
  /** Pantalla de error bloqueante con botón para recargar. */
  function showError(title, message) {
    if (loading) { loading.hidden = true; loading.classList.add('is-hidden'); }
    closeStart();
    closeResult();
    hud.classList.add('is-hidden');
    if (errorLayer) { popModal(errorLayer); errorLayer.remove(); }
    const reload = el('button', { type: 'button', class: 'btn btn--primary', id: 'error-reload', onclick: () => location.reload() },
      [icon('restart'), el('span', { text: 'Recargar la página' })]);
    const panel = el('div', {
      class: 'panel dialog dialog--error', role: 'alertdialog', 'aria-modal': 'true',
      'aria-labelledby': 'error-title', 'aria-describedby': 'error-text', tabindex: '-1',
    }, [
      el('div', { class: 'dialog__badge' }, [icon('warning')]),
      el('h2', { class: 'dialog__title', id: 'error-title', text: title || 'Algo ha fallado' }),
      el('p', { class: 'dialog__text', id: 'error-text', text: message || '' }),
      el('div', { class: 'dialog__actions' }, [reload]),
    ]);
    errorLayer = el('div', { class: 'layer layer--dialog layer--error' }, [panel]);
    document.body.append(errorLayer);
    pushModal(errorLayer, null);
    reload.focus({ preventScroll: true });
  }

  // =============================================================================================
  // Pantalla de inicio
  // =============================================================================================
  let startLayer = null;

  /**
   * Muestra la pantalla de inicio. Resuelve con el pan elegido y el modo guiado.
   * @returns {Promise<{breadId: string, guided: boolean}>}
   */
  function showStart({ breads = [], best = {} } = {}) {
    closeStart();
    hud.classList.add('is-hidden');
    hideHint();
    const prefs = loadPrefs();
    const list = Array.isArray(breads) ? breads : [];
    const chosen = list.some((b) => b.id === prefs.breadId) ? prefs.breadId : list[0]?.id;

    const cards = list.map((b, i) => {
      const id = `start-bread-${slug(b.id)}`;
      const record = Number(best?.[b.id]);
      return el('label', { class: 'bread-card', for: id }, [
        el('input', { type: 'radio', name: 'start-bread', id, value: b.id, class: 'bread-card__input', checked: b.id === chosen }),
        el('span', { class: 'bread-card__check', 'aria-hidden': 'true' }, [icon('check')]),
        el('span', { class: 'bread-card__art' }, [breadArt(String(b.id), i)]),
        el('span', { class: 'bread-card__name', text: b.name || b.id }),
        el('span', { class: 'bread-card__desc', text: b.description || '' }),
        el('span', { class: 'bread-card__meta' }, [
          b.difficulty ? el('span', { class: `chip chip--${difficultyTone(b.difficulty)}`, text: b.difficulty }) : null,
          b.timeLabel ? el('span', { class: 'chip chip--time' }, [icon('clock'), el('span', { text: b.timeLabel })]) : null,
        ]),
        Number.isFinite(record) && record > 0
          ? el('span', { class: 'bread-card__best' }, ['Tu récord: ', el('b', { text: `${Math.round(record)} pts` })])
          : el('span', { class: 'bread-card__best bread-card__best--none', text: 'Aún sin hornear' }),
      ]);
    });

    const guided = el('input', {
      type: 'checkbox', id: 'start-guided', class: 'switch__input', role: 'switch', checked: prefs.guided !== false,
    });
    const form = el('form', { class: 'start__form', novalidate: true }, [
      el('fieldset', { class: 'start__breads' }, [
        el('legend', { class: 'kicker', text: 'Elige tu pan' }),
        el('div', { class: 'bread-grid' }, cards),
      ]),
      el('div', { class: 'start__foot' }, [
        el('label', { class: 'switch', for: 'start-guided' }, [
          guided,
          el('span', { class: 'switch__track', 'aria-hidden': 'true' }, [el('span', { class: 'switch__thumb' })]),
          el('span', { class: 'switch__text' }, ['Modo guiado ', el('small', { text: '(consejos en pantalla)' })]),
        ]),
        el('button', { type: 'submit', class: 'btn btn--primary btn--lg', id: 'start-go' }, [icon('play'), el('span', { text: 'Empezar a hornear' })]),
      ]),
    ]);
    const panel = el('div', {
      class: 'panel start__panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'start-title', tabindex: '-1',
    }, [
      el('p', { class: 'start__eyebrow' }, [icon('loaf'), 'Simulador de panadería casera']),
      el('h1', { class: 'brand start__title', id: 'start-title', text: 'Pan Casero 3D' }),
      el('p', { class: 'start__pitch', text: 'Pesa, mezcla, amasa, deja fermentar y hornea tu propio pan, paso a paso, en una cocina de verdad… sin mancharte de harina.' }),
      form,
    ]);
    startLayer = el('div', { class: 'layer layer--start' }, [panel]);
    document.body.append(startLayer);
    pushModal(startLayer, null);
    panel.focus({ preventScroll: true });

    return new Promise((resolve) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const breadId = form.querySelector('input[name="start-bread"]:checked')?.value ?? list[0]?.id;
        const result = { breadId, guided: guided.checked };
        savePrefs(result);
        closeStart();
        resolve(result);
      });
    });
  }

  /** Cierra la pantalla de inicio sin resolver su promesa (lo usan las pruebas automáticas). */
  function closeStart() {
    if (!startLayer) return;
    popModal(startLayer);
    startLayer.remove();
    startLayer = null;
    hud.classList.remove('is-hidden');
  }

  // =============================================================================================
  // Pasos (stepper)
  // =============================================================================================

  /** Define las etapas del juego: [{id, label}]. */
  function setStages(list) {
    stages = Array.isArray(list) ? list.map((s) => ({ id: s.id, label: s.label })) : [];
    stepList.replaceChildren(...stages.map((s, i) => el('li', { class: 'step', 'data-step': s.id }, [
      el('span', { class: 'step__dot', 'aria-hidden': 'true' }, [el('span', { class: 'step__num', text: String(i + 1) }), icon('check', 'step__check')]),
      el('span', { class: 'step__label', text: s.label }),
      el('span', { class: 'sr-only step__state' }),
    ])));
    stepper.hidden = stages.length === 0;
    setStage(stageIndex);
  }

  /** Marca la etapa actual (índice en la lista de setStages). */
  function setStage(index) {
    stageIndex = Number.isInteger(index) ? index : -1;
    const n = stages.length;
    [...stepList.children].forEach((li, i) => {
      const state = i < stageIndex ? 'done' : i === stageIndex ? 'current' : 'todo';
      li.className = `step is-${state}`;
      if (state === 'current') li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      li.querySelector('.step__state').textContent = state === 'done' ? ' (hecho)' : state === 'current' ? ' (paso actual)' : '';
    });
    const cur = stages[stageIndex];
    stepCompactText.textContent = cur ? `${stageIndex + 1}/${n} · ${cur.label}` : n ? `0/${n}` : '';
    stepCompactFill.style.width = n ? `${((Math.max(0, stageIndex) + (cur ? 1 : 0)) / n) * 100}%` : '0%';
    instrKicker.textContent = cur ? `Paso ${stageIndex + 1} de ${n} · ${cur.label}` : '';
  }

  // =============================================================================================
  // Instrucción
  // =============================================================================================

  /** Instrucción principal ({title, text, tip?}) o null para ocultarla. */
  function setInstruction(data) {
    if (!data) {
      instrCard.hidden = true;
      lastInstrTitle = null;
      refreshLayout();
      return;
    }
    const { title = '', text = '', tip } = data;
    const changed = title !== instrTitle.textContent || text !== instrText.textContent;
    if (title !== lastInstrTitle) {
      lastInstrTitle = title;
      setCollapsed(!!compactQuery?.matches);
      if (!reducedMotion()) {
        instrCard.classList.remove('is-fresh');
        void instrCard.offsetWidth; // reinicia la animación de entrada
        instrCard.classList.add('is-fresh');
      }
    }
    instrTitle.textContent = title;
    instrText.textContent = text;
    instrText.hidden = !text;
    tipText.textContent = tip || '';
    tipBox.hidden = !tip;
    instrCard.hidden = false;
    refreshLayout();
    if (changed) announce([title, text].filter(Boolean).join('. '));
  }

  // =============================================================================================
  // Receta
  // =============================================================================================

  function buildRow(id) {
    const r = {
      el: el('li', { class: 'rrow', 'data-id': id }),
      state: el('span', { class: 'rrow__state', 'aria-hidden': 'true' }),
      label: el('span', { class: 'rrow__label' }),
      cur: el('b', { class: 'rrow__cur' }),
      tgt: el('span', { class: 'rrow__tgt' }),
      sr: el('span', { class: 'sr-only' }),
      fill: el('i', { class: 'rrow__fill' }),
      cache: {},
    };
    r.el.append(r.state, r.label, el('span', { class: 'rrow__amount' }, [r.cur, r.tgt]), r.sr,
      el('span', { class: 'rrow__bar', 'aria-hidden': 'true' }, [r.fill, el('span', { class: 'rrow__mark' })]));
    return r;
  }

  function updateRow(r, row) {
    const state = ROW_STATE_TEXT[row.state] ? row.state : 'pending';
    const target = Math.max(0, Number(row.target) || 0);
    const current = Math.max(0, Number(row.current) || 0);
    const unit = row.unit || 'g';
    const c = r.cache;
    if (c.state !== state) {
      if (c.state) r.el.classList.remove(`is-${c.state}`);
      r.el.classList.add(`is-${state}`);
      c.state = state;
      r.state.replaceChildren(icon(state === 'ok' ? 'check' : state === 'over' || state === 'under' ? 'warning' : '') || '');
    }
    if (c.label !== row.label) { c.label = row.label; r.label.textContent = row.label ?? ''; }
    const none = target === 0 && current === 0;
    if (c.none !== none) { c.none = none; r.el.classList.toggle('is-none', none); }
    const curText = none ? '' : fmtQty(current);
    const tgtText = target === 0 ? (current > 0 ? ` ${unit} · no lleva` : 'no lleva') : ` / ${fmtQty(target)}\u00a0${unit}`;
    if (c.cur !== curText) { c.cur = curText; r.cur.textContent = curText; }
    if (c.tgt !== tgtText) { c.tgt = tgtText; r.tgt.textContent = tgtText; }
    const sr = `: ${ROW_STATE_TEXT[state]}`;
    if (c.sr !== sr) { c.sr = sr; r.sr.textContent = sr; }
    // La marca del objetivo está al 80 % de la barra para que se vea si te pasas.
    const ratio = target > 0 ? Math.min(1.25, current / target) * 0.8 : current > 0 ? 1 : 0;
    const w = `${(ratio * 100).toFixed(1)}%`;
    if (c.w !== w) { c.w = w; r.fill.style.width = w; }
  }

  /** Tarjeta de receta ({title, rows}) o null. Llamarla cada frame es barato: solo toca lo que cambia. */
  function setRecipe(data) {
    if (!data || !Array.isArray(data.rows)) {
      recipeCard.hidden = true;
      rows.clear();
      recipeRows.replaceChildren();
      refreshLayout();
      return;
    }
    if (recipeTitle.textContent !== (data.title || '')) recipeTitle.textContent = data.title || '';
    recipeTitle.hidden = !data.title;
    const seen = new Set();
    data.rows.forEach((row, i) => {
      const id = String(row.id ?? i);
      let r = rows.get(id);
      if (!r) { r = buildRow(id); rows.set(id, r); }
      if (recipeRows.children[i] !== r.el) recipeRows.insertBefore(r.el, recipeRows.children[i] || null);
      updateRow(r, row);
      seen.add(id);
    });
    for (const [id, r] of rows) if (!seen.has(id)) { r.el.remove(); rows.delete(id); }
    // En el móvil solo se ve la fila "en foco": la activa, o la primera pendiente.
    const list = data.rows.map((row, i) => ({ id: String(row.id ?? i), state: row.state }));
    const focus = list.find((x) => x.state === 'active') || list.find((x) => x.state !== 'ok') || list[list.length - 1];
    for (const [id, r] of rows) r.el.classList.toggle('is-focus', id === focus?.id);
    const done = data.rows.filter((row) => row.state === 'ok').length;
    const countText = `${done}/${data.rows.length} listos`;
    if (recipeCount.textContent !== countText) recipeCount.textContent = countText;
    recipeCard.hidden = false;
    refreshLayout();
  }

  // =============================================================================================
  // Medidores
  // =============================================================================================

  function buildMeter(id) {
    const m = {
      el: el('li', { class: 'meter', 'data-id': id }),
      label: el('span', { class: 'meter__label' }),
      value: el('span', { class: 'meter__value' }),
      valueText: el('span'),
      track: el('span', { class: 'meter__track', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100' }),
      ideal: el('span', { class: 'meter__ideal', hidden: true }),
      fill: el('span', { class: 'meter__fill' }),
      cache: {},
    };
    m.toneIcon = el('span', { class: 'meter__tone' });
    m.value.append(m.toneIcon, m.valueText);
    m.track.append(m.ideal, m.fill);
    m.el.append(el('span', { class: 'meter__top' }, [m.label, m.value]), m.track);
    return m;
  }

  function updateMeter(m, data, fresh) {
    const c = m.cache;
    const tone = ['good', 'warn', 'bad'].includes(data.tone) ? data.tone : 'neutral';
    if (c.tone !== tone) {
      c.tone = tone;
      m.el.className = `meter tone-${tone}`;
      m.toneIcon.replaceChildren(icon(tone === 'good' ? 'check' : tone === 'neutral' ? '' : 'warning') || '');
    }
    if (c.label !== data.label) {
      c.label = data.label;
      m.label.textContent = data.label ?? '';
      m.track.setAttribute('aria-label', data.label ?? '');
    }
    const text = data.text ?? `${Math.round(clamp01(data.value01) * 100)} %`;
    if (c.text !== text) {
      c.text = text;
      m.valueText.textContent = text;
      m.track.setAttribute('aria-valuetext', text);
    }
    const pct = (clamp01(data.value01) * 100).toFixed(1);
    if (c.pct !== pct) {
      c.pct = pct;
      m.track.setAttribute('aria-valuenow', String(Math.round(pct)));
      if (fresh && !reducedMotion()) {
        m.fill.style.width = '0%';
        void m.fill.offsetWidth; // la primera vez crece desde cero
      }
      m.fill.style.width = `${pct}%`;
    }
    const ideal = Array.isArray(data.ideal) && data.ideal.length === 2
      ? `${clamp01(Math.min(...data.ideal)) * 100}|${clamp01(Math.max(...data.ideal)) * 100}` : '';
    if (c.ideal !== ideal) {
      c.ideal = ideal;
      m.ideal.hidden = !ideal;
      if (ideal) {
        const [lo, hi] = ideal.split('|').map(Number);
        m.ideal.style.left = `${lo}%`;
        m.ideal.style.width = `${Math.max(1.5, hi - lo)}%`;
      }
    }
  }

  /** Medidores [{id, label, value01, ideal, text, tone}] o null. Se actualizan en el sitio por id. */
  function setMeters(list) {
    if (!Array.isArray(list) || !list.length) {
      metersCard.hidden = true;
      meters.clear();
      metersList.replaceChildren();
      refreshLayout();
      return;
    }
    const seen = new Set();
    list.forEach((data, i) => {
      const id = String(data.id ?? i);
      let m = meters.get(id);
      const fresh = !m;
      if (!m) { m = buildMeter(id); meters.set(id, m); }
      if (metersList.children[i] !== m.el) metersList.insertBefore(m.el, metersList.children[i] || null);
      updateMeter(m, data, fresh);
      seen.add(id);
    });
    for (const [id, m] of meters) if (!seen.has(id)) { m.el.remove(); meters.delete(id); }
    metersCard.hidden = false;
    refreshLayout();
  }

  // =============================================================================================
  // Reloj
  // =============================================================================================

  /** Reloj de la etapa ({label, text, sub?}) o null. */
  function setClock(data) {
    if (!data) { clockCard.hidden = true; refreshLayout(); return; }
    if (clockLabel.textContent !== (data.label ?? '')) clockLabel.textContent = data.label ?? '';
    if (clockText.textContent !== (data.text ?? '')) clockText.textContent = data.text ?? '';
    if (clockSub.textContent !== (data.sub ?? '')) clockSub.textContent = data.sub ?? '';
    clockSub.hidden = !data.sub;
    clockCard.hidden = false;
    refreshLayout();
  }

  // =============================================================================================
  // Controles del dock
  // =============================================================================================

  /** Base común: estado propio (disabled/hidden) combinado con setBusy(). */
  function makeControl(spec, rootEl, applyDisabled) {
    const ctl = {
      el: rootEl, own: { disabled: !!spec.disabled, hidden: !!spec.hidden },
      sync() {
        rootEl.hidden = ctl.own.hidden;
        applyDisabled(ctl.own.disabled || busy);
      },
      destroy() {},
    };
    rootEl.dataset.ctl = spec.id;
    return ctl;
  }

  function buildButton(spec) {
    const variant = ['primary', 'secondary', 'ghost'].includes(spec.variant) ? spec.variant : 'secondary';
    const label = el('span', { class: 'btn__label', text: spec.label ?? '' });
    const btn = el('button', { type: 'button', class: `btn btn--${variant}`, id: `ctl-${slug(spec.id)}` },
      [icon(spec.icon), label]);
    btn.addEventListener('click', () => { if (!btn.disabled) safeCall(spec.onClick); });
    const ctl = makeControl(spec, btn, (d) => { btn.disabled = d; });
    ctl.focus = () => btn.focus({ preventScroll: true });
    ctl.set = (p = {}) => {
      if ('label' in p) label.textContent = p.label ?? '';
      if ('active' in p) { btn.classList.toggle('is-active', !!p.active); btn.setAttribute('aria-pressed', String(!!p.active)); }
      if ('disabled' in p) ctl.own.disabled = !!p.disabled;
      if ('hidden' in p) ctl.own.hidden = !!p.hidden;
      ctl.sync();
    };
    if (spec.active != null) ctl.set({ active: spec.active });
    return ctl;
  }

  // Pulsaciones mantenidas activas (para soltarlas al perder el foco la ventana).
  const activeHolds = new Set();

  function buildHold(spec) {
    const label = el('span', { class: 'btn__label', text: spec.label ?? '' });
    const fill = el('span', { class: 'btn__fill', 'aria-hidden': 'true' });
    const btn = el('button', {
      type: 'button', class: 'btn btn--hold', id: `ctl-${slug(spec.id)}`, 'aria-pressed': 'false',
      'aria-description': 'Mantén pulsado (o mantén la barra espaciadora)',
    }, [fill, icon(spec.icon || 'hand'), label]);
    let source = null;
    const start = (src) => {
      if (source || btn.disabled) return;
      source = src;
      btn.classList.add('is-held');
      btn.setAttribute('aria-pressed', 'true');
      activeHolds.add(ctl);
      safeCall(spec.onStart);
    };
    const end = () => {
      if (!source) return;
      source = null;
      btn.classList.remove('is-held');
      btn.setAttribute('aria-pressed', 'false');
      activeHolds.delete(ctl);
      safeCall(spec.onEnd);
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // sin selección de texto ni menú de arrastre
      try { btn.setPointerCapture(e.pointerId); } catch { /* puntero ya liberado */ }
      start('pointer');
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      btn.addEventListener(type, () => { if (source === 'pointer') end(); });
    }
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (!e.repeat) start('key');
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      if (source === 'key') end();
    });
    btn.addEventListener('blur', () => { if (source === 'key') end(); });

    const ctl = makeControl(spec, btn, (d) => { btn.disabled = d; if (d) end(); });
    ctl.focus = () => btn.focus({ preventScroll: true });
    ctl.end = end;
    ctl.destroy = end;
    ctl.set = (p = {}) => {
      if ('label' in p) label.textContent = p.label ?? '';
      if ('value' in p) {
        const has = p.value != null && Number.isFinite(Number(p.value));
        btn.classList.toggle('has-value', has);
        btn.style.setProperty('--p', has ? String(clamp01(p.value)) : '0');
      }
      if ('active' in p) btn.classList.toggle('is-active', !!p.active);
      if ('disabled' in p) ctl.own.disabled = !!p.disabled;
      if ('hidden' in p) ctl.own.hidden = !!p.hidden;
      ctl.sync();
    };
    if (spec.value != null) ctl.set({ value: spec.value });
    return ctl;
  }

  function buildSlider(spec) {
    const id = `ctl-${slug(spec.id)}`;
    const min = Number(spec.min ?? 0), max = Number(spec.max ?? 100), step = Number(spec.step ?? 1);
    const fmt = (v) => {
      if (typeof spec.format === 'function') { try { return String(spec.format(v)); } catch (e) { console.error(e); } }
      return `${fmtNumber(v, step)}${spec.unit ? `\u00a0${spec.unit}` : ''}`;
    };
    const input = el('input', { type: 'range', id, class: 'range', min, max, step, value: spec.value ?? min });
    const labelEl = el('label', { class: 'ctl__label', for: id, text: spec.label ?? '' });
    const out = el('output', { class: 'ctl__value', for: id });
    const paint = () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      input.setAttribute('aria-valuetext', out.textContent);
      input.style.setProperty('--pct', `${((v - min) / (max - min || 1)) * 100}%`);
    };
    input.addEventListener('input', () => { paint(); safeCall(spec.onInput, Number(input.value)); });
    const wrap = el('div', { class: 'ctl ctl--slider' }, [
      el('div', { class: 'ctl__row' }, [labelEl, out]),
      input,
      el('div', { class: 'ctl__scale', 'aria-hidden': 'true' }, [el('span', { text: fmt(min) }), el('span', { text: fmt(max) })]),
    ]);
    paint();
    const ctl = makeControl(spec, wrap, (d) => { input.disabled = d; wrap.classList.toggle('is-disabled', d); });
    ctl.focus = () => input.focus({ preventScroll: true });
    ctl.set = (p = {}) => {
      if ('label' in p) labelEl.textContent = p.label ?? '';
      if ('value' in p && p.value != null) { input.value = p.value; paint(); }
      if ('disabled' in p) ctl.own.disabled = !!p.disabled;
      if ('hidden' in p) ctl.own.hidden = !!p.hidden;
      ctl.sync();
    };
    return ctl;
  }

  function buildChoice(spec) {
    const labelId = `ctl-${slug(spec.id)}-label`;
    const labelEl = el('span', { class: 'ctl__label', id: labelId, text: spec.label ?? '' });
    const group = el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': labelId });
    const options = Array.isArray(spec.options) ? spec.options : [];
    const buttons = options.map((opt) => {
      const b = el('button', {
        type: 'button', role: 'radio', class: `seg__opt${opt.sub ? ' seg__opt--sub' : ''}`, id: `ctl-${slug(spec.id)}-${slug(opt.value)}`,
        'aria-checked': 'false', tabindex: '-1',
      }, [icon(opt.icon), el('span', { class: 'seg__label', text: opt.label ?? String(opt.value) }),
        opt.sub ? el('small', { class: 'seg__sub', text: opt.sub }) : null]);
      b.addEventListener('click', () => select(opt.value, true));
      group.append(b);
      return b;
    });
    let value = spec.value;
    function select(v, fire) {
      const i = options.findIndex((o) => o.value === v);
      buttons.forEach((b, j) => {
        b.setAttribute('aria-checked', String(j === i));
        b.tabIndex = j === (i < 0 ? 0 : i) ? 0 : -1;
      });
      const changed = v !== value;
      value = v;
      // En el móvil la fila puede desplazarse en horizontal: que se vea la opción elegida.
      const b = buttons[i];
      if (b && group.scrollWidth > group.clientWidth) {
        const left = b.offsetLeft, right = left + b.offsetWidth;
        if (left < group.scrollLeft || right > group.scrollLeft + group.clientWidth) group.scrollLeft = Math.max(0, left - 12);
      }
      if (fire && changed && i >= 0) safeCall(spec.onChange, v);
    }
    group.addEventListener('keydown', (e) => {
      const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!dir || !buttons.length) return;
      e.preventDefault();
      const cur = Math.max(0, options.findIndex((o) => o.value === value));
      let next = cur;
      for (let k = 0; k < buttons.length; k++) {
        next = (next + dir + buttons.length) % buttons.length;
        if (!buttons[next].disabled) break;
      }
      select(options[next].value, true);
      buttons[next].focus();
    });
    select(value, false);
    const wrap = el('div', { class: `ctl ctl--choice${options.length > 3 ? ' ctl--wide' : ''}` }, [labelEl, group]);
    const ctl = makeControl(spec, wrap, (d) => {
      buttons.forEach((b) => { b.disabled = d; });
      wrap.classList.toggle('is-disabled', d);
    });
    ctl.focus = () => (buttons.find((b) => b.tabIndex === 0) || buttons[0])?.focus({ preventScroll: true });
    ctl.mounted = () => select(value, false);
    ctl.set = (p = {}) => {
      if ('label' in p) labelEl.textContent = p.label ?? '';
      if ('value' in p) select(p.value, false);
      if ('disabled' in p) ctl.own.disabled = !!p.disabled;
      if ('hidden' in p) ctl.own.hidden = !!p.hidden;
      ctl.sync();
    };
    return ctl;
  }

  const BUILDERS = { button: buildButton, hold: buildHold, slider: buildSlider, choice: buildChoice };

  /**
   * Sustituye los controles del dock.
   * @param {Array<object>|null} specs ver CONTRACT §7 (button | hold | slider | choice)
   * @returns {{get(id: string): {set(props: object): void, el: HTMLElement|null}}}
   */
  function setControls(specs) {
    const focusedId = document.activeElement?.closest?.('[data-ctl]')?.dataset.ctl;
    for (const c of controls.values()) safeCall(c.destroy);
    controls.clear();
    const nodes = [];
    for (const spec of Array.isArray(specs) ? specs : []) {
      if (!spec || spec.id == null) continue;
      const build = BUILDERS[spec.type] || buildButton;
      try {
        const c = build(spec);
        c.sync();
        controls.set(String(spec.id), c);
        nodes.push(c.el);
      } catch (e) {
        console.error(e);
      }
    }
    dock.replaceChildren(...nodes);
    dock.hidden = nodes.length === 0;
    refreshLayout();
    for (const c of controls.values()) c.mounted?.();
    if (focusedId && controls.has(focusedId)) controls.get(focusedId).focus();
    return { get: getControl };
  }

  /** Control del dock por id (o un control nulo que no hace nada). */
  function getControl(id) {
    const c = controls.get(String(id));
    return c ? { set: c.set, el: c.el } : NULL_CONTROL;
  }

  /** Desactiva todos los controles mientras dura una animación. */
  function setBusy(on) {
    busy = !!on;
    dock.classList.toggle('is-busy', busy);
    dock.setAttribute('aria-busy', String(busy));
    for (const c of controls.values()) c.sync();
  }

  const releaseHolds = () => { for (const c of [...activeHolds]) c.end(); };
  window.addEventListener('blur', releaseHolds);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseHolds(); });

  // =============================================================================================
  // Avisos y pista flotante
  // =============================================================================================

  /** Aviso breve arriba del todo. tone: info | good | warn | bad. */
  function toast(text, { tone = 'info', duration = 2.6 } = {}) {
    if (!text) return;
    const t = ['info', 'good', 'warn', 'bad'].includes(tone) ? tone : 'info';
    const node = el('div', { class: `toast tone-${t}` }, [
      el('span', { class: 'toast__icon' }, [icon(TONE_ICON[t])]), el('span', { class: 'toast__text', text: String(text) }),
    ]);
    toasts.append(node);
    while (toasts.children.length > 3) toasts.firstElementChild.remove();
    announce(text);
    const ms = Math.max(0.8, Number(duration) || 2.6) * 1000;
    setTimeout(() => {
      node.classList.add('is-leaving');
      setTimeout(() => node.remove(), reducedMotion() ? 0 : 260);
    }, ms);
  }

  let hintWidth = 0;
  /** Etiqueta flotante junto a un objeto 3D ({x, y} en píxeles de pantalla). */
  function showHint(text, pos) {
    if (!text || !pos || pos.visible === false || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) { hideHint(); return; }
    if (hintText.textContent !== text) {
      hintText.textContent = text;
      hintWidth = hint.offsetWidth;
    }
    const margin = 8;
    const x = Math.min(window.innerWidth - hintWidth / 2 - margin, Math.max(hintWidth / 2 + margin, pos.x));
    const below = pos.y < 90;
    hint.classList.toggle('is-below', below);
    hint.style.transform = `translate(${Math.round(x)}px, ${Math.round(pos.y)}px) translate(-50%, ${below ? '16px' : 'calc(-100% - 16px)'})`;
    const arrow = Math.max(-(hintWidth / 2 - 14), Math.min(hintWidth / 2 - 14, pos.x - x));
    hint.style.setProperty('--arrow-x', `${Math.round(arrow)}px`);
    hint.classList.add('is-visible');
  }

  function hideHint() { hint.classList.remove('is-visible'); }

  // =============================================================================================
  // Diálogos
  // =============================================================================================
  let dialogChain = Promise.resolve();

  /**
   * Diálogo modal. Se encolan si ya hay uno abierto.
   * @param {{title: string, body?: string|Node, actions?: Array<{label, variant, value}>, dismissible?: boolean}} opts
   * @returns {Promise<any>} el `value` de la acción elegida (Escape = primera acción no principal)
   */
  function showDialog(opts = {}) {
    const p = dialogChain.then(() => openDialog(opts));
    dialogChain = p.catch(() => {});
    return p;
  }

  function openDialog({ title = '', body = '', actions, dismissible = true } = {}) {
    return new Promise((resolve) => {
      const acts = Array.isArray(actions) && actions.length ? actions : [{ label: 'Vale', variant: 'primary', value: 'ok' }];
      const uid = 'dialog';
      const bodyEl = el('div', { class: 'dialog__text', id: `${uid}-text` });
      if (body instanceof Node) bodyEl.append(body);
      else String(body || '').split(/\n{2,}/).filter(Boolean).forEach((para) => bodyEl.append(el('p', { text: para })));
      let layer = null;
      const close = (value) => {
        if (!layer) return;
        popModal(layer);
        layer.classList.add('is-leaving');
        const l = layer;
        layer = null;
        l.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id')); // el siguiente diálogo reutiliza los ids
        setTimeout(() => l.remove(), reducedMotion() ? 0 : 160);
        resolve(value);
      };
      const buttons = acts.map((a, i) => el('button', {
        type: 'button', class: `btn btn--${['primary', 'secondary', 'ghost'].includes(a.variant) ? a.variant : 'secondary'}`,
        id: `${uid}-act-${i}`, onclick: () => close(a.value),
      }, [icon(a.icon), el('span', { text: a.label ?? '' })]));
      const escAction = acts.find((a) => a.variant !== 'primary') || (acts.length === 1 ? acts[0] : null);
      const panel = el('div', {
        class: 'panel dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-title`,
        'aria-describedby': `${uid}-text`, tabindex: '-1',
      }, [
        el('h2', { class: 'dialog__title', id: `${uid}-title`, text: title }),
        bodyEl,
        el('div', { class: 'dialog__actions' }, buttons),
      ]);
      layer = el('div', { class: 'layer layer--dialog' }, [panel]);
      layer.addEventListener('pointerdown', (e) => { if (e.target === layer && dismissible && escAction) close(escAction.value); });
      document.body.append(layer);
      pushModal(layer, dismissible && escAction ? () => close(escAction.value) : null);
      const primary = buttons[acts.findIndex((a) => a.variant === 'primary')] || buttons[0];
      primary?.focus({ preventScroll: true });
    });
  }

  // =============================================================================================
  // Resultado
  // =============================================================================================
  let resultLayer = null;
  let resultResolve = null;

  function starsEl(stars) {
    const value = Math.max(0, Math.min(5, Math.round((Number(stars) || 0) * 2) / 2));
    const wrap = el('div', { class: 'stars', role: 'img', 'aria-label': `${String(value).replace('.', ',')} de 5 estrellas` });
    for (let i = 0; i < 5; i++) {
      const fillPct = Math.max(0, Math.min(1, value - i)) * 100;
      const t = document.createElement('template');
      t.innerHTML = `<span class="star" style="--fill:${fillPct}%;--i:${i}"><svg viewBox="0 0 24 24" aria-hidden="true"><path class="star__base" d="${STAR_PATH}"/></svg><span class="star__fill"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}"/></svg></span></span>`;
      wrap.append(t.content.firstChild);
    }
    return wrap;
  }

  const scoreTone = (s) => (s >= 75 ? 'good' : s >= 50 ? 'neutral' : s >= 35 ? 'warn' : 'bad');

  /**
   * Panel de resultados. `best`: true = récord nuevo, o número = récord anterior.
   * Extra opcional `canCut` (por defecto true) oculta "Cortar el pan" si ya está cortado.
   * @returns {Promise<'cut'|'again'|'close'>}
   */
  function showResult({ breadName = '', total = 0, stars = 0, title = '', summary = '', sections = [], best, canCut = true } = {}) {
    closeResult();
    hideHint();
    const score = Math.max(0, Math.min(100, Math.round(Number(total) || 0)));
    const scoreEl = el('span', { class: 'result__score-num', text: reducedMotion() ? String(score) : '0' });
    const bestEl = best === true
      ? el('span', { class: 'chip chip--record' }, [icon('check'), el('span', { text: '¡Nuevo récord!' })])
      : Number.isFinite(Number(best)) && best !== null && best !== false
        ? el('span', { class: 'chip chip--plain', text: `Récord anterior: ${Math.round(Number(best))} pts` }) : null;

    const secList = el('ul', { class: 'result__sections' }, (Array.isArray(sections) ? sections : []).map((s) => {
      const v = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
      return el('li', { class: `rsec tone-${scoreTone(v)}` }, [
        el('div', { class: 'rsec__top' }, [el('span', { class: 'rsec__label', text: s.label ?? '' }),
          el('span', { class: 'rsec__score' }, [el('b', { text: String(v) }), '/100'])]),
        el('span', { class: 'rsec__bar', 'aria-hidden': 'true' }, [el('i', { style: `--w:${v}%` })]),
        s.note ? el('p', { class: 'rsec__note', text: s.note }) : null,
      ]);
    }));

    const choose = (value) => {
      const done = resultResolve;
      closeResult();
      done?.(value);
    };
    const cutBtn = canCut ? el('button', { type: 'button', class: 'btn btn--primary', id: 'result-cut', onclick: () => choose('cut') },
      [icon('knife'), el('span', { text: 'Cortar el pan' })]) : null;
    const againBtn = el('button', { type: 'button', class: `btn btn--${canCut ? 'secondary' : 'primary'}`, id: 'result-again', onclick: () => choose('again') },
      [icon('restart'), el('span', { text: 'Hornear otro pan' })]);
    const closeBtn = el('button', { type: 'button', class: 'btn btn--ghost', id: 'result-close', onclick: () => choose('close') },
      [el('span', { text: 'Seguir mirando' })]);

    const panel = el('div', {
      class: 'panel result', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'result-title',
      'aria-describedby': summary ? 'result-summary' : null, tabindex: '-1',
    }, [
      el('div', { class: 'result__head' }, [
        el('div', { class: `result__badge tone-${scoreTone(score)}`, role: 'img', 'aria-label': `Puntuación: ${score} de 100` }, [
          scoreEl, el('span', { class: 'result__score-max', 'aria-hidden': 'true', text: '/100' }),
        ]),
        el('div', { class: 'result__heading' }, [
          el('p', { class: 'kicker', text: breadName || 'Tu pan' }),
          el('h2', { class: 'result__title', id: 'result-title', text: title || 'Resultado' }),
          starsEl(stars),
          bestEl,
        ]),
      ]),
      summary ? el('p', { class: 'result__summary', id: 'result-summary', text: summary }) : null,
      secList,
      el('div', { class: 'result__actions' }, [cutBtn, againBtn, closeBtn]),
    ]);
    resultLayer = el('div', { class: 'layer layer--result' }, [panel]);
    document.body.append(resultLayer);
    pushModal(resultLayer, () => choose('close'));
    (cutBtn || againBtn).focus({ preventScroll: true });

    // Cuenta atrás de la nota y barras que crecen.
    if (!reducedMotion()) {
      const t0 = performance.now();
      const layer = resultLayer;
      const tick = (now) => {
        const k = Math.min(1, (now - t0) / 1100);
        scoreEl.textContent = String(Math.round(score * (1 - Math.pow(1 - k, 3))));
        if (k < 1 && layer.isConnected) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
    announce(`${title}. ${score} de 100.`);
    return new Promise((resolve) => { resultResolve = resolve; });
  }

  /**
   * Cierra el panel de resultados sin resolver su promesa: así una etapa ya terminada (reinicio,
   * pruebas) no reacciona. Las decisiones del jugador (botones, Escape) sí la resuelven.
   */
  function closeResult() {
    if (!resultLayer) return;
    popModal(resultLayer);
    resultLayer.remove();
    resultLayer = null;
    resultResolve = null;
  }

  // =============================================================================================
  // Barra de herramientas
  // =============================================================================================

  /** Refleja si el sonido está activado. */
  function setSound(on) {
    btnSound.setAttribute('aria-pressed', String(!!on));
    btnSound.dataset.tip = on ? 'Silenciar' : 'Activar sonido';
    btnSound.replaceChildren(icon(on ? 'sound' : 'soundOff'));
  }

  /** Refleja si la cámara libre está activa. */
  function setFreeCamera(on) {
    btnCamera.setAttribute('aria-pressed', String(!!on));
    btnCamera.dataset.tip = on ? 'Volver a la cámara guiada' : 'Cámara libre';
  }

  const subscribe = (name) => (fn) => {
    if (typeof fn !== 'function') return () => {};
    handlers[name].add(fn);
    return () => handlers[name].delete(fn);
  };

  setSound(false);
  refreshLayout();

  const api = {
    root,
    setLoading, hideLoading, showError,
    showStart, hideStart: closeStart,
    setStages, setStage,
    setInstruction, setRecipe, setMeters, setControls, getControl, setClock,
    toast, announce,
    showDialog, showResult, hideResult: closeResult,
    showHint, hideHint,
    setBusy,
    setSound, setFreeCamera,
    onSoundToggle: subscribe('sound'), onCameraToggle: subscribe('camera'),
    onRestart: subscribe('restart'), onHelp: subscribe('help'),
  };
  root.__panUI = api;
  return api;
}
