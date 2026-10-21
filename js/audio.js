// Sonido de la cocina: todo sintetizado con Web Audio (sin archivos).
// Mezcla: voces → bus → compresor suave → volumen maestro → salida, con una reverb corta de cocina por envío.
// Nada suena (ni lanza errores) hasta unlock(), que debe llamarse desde un gesto del usuario.

const MAX_VOICES = 32;   // efectos cortos simultáneos
const MAX_LOOPS = 16;    // bucles simultáneos
const LOOKAHEAD = 0.3;   // segundos que el planificador programa por delante
const NOOP_LOOP = Object.freeze({ setIntensity() {}, stop() {} });

const rand = (a = 0, b = 1) => a + (b - a) * Math.random();
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * Crea el sistema de sonido.
 * @param {{context?: BaseAudioContext}} [opts] contexto inyectado (p. ej. OfflineAudioContext en pruebas)
 * @returns {{unlock(): boolean, readonly enabled: boolean, setEnabled(on: boolean): void, setVolume(v01: number): void,
 *   play(name: string, opts?: {volume?: number, rate?: number}): void,
 *   loop(name: string, opts?: {volume?: number}): {setIntensity(v01: number): void, stop(fadeSeconds?: number): void}}}
 */
export function createAudio({ context } = {}) {
  let ctx = null, offline = false, unlocked = false, userEnabled = true, volume = 0.8;
  let master, bus, verbIn, buffers, timer = 0, voices = 0, warned = false;
  const loops = new Set();
  const lastPlayed = new Map();

  const warn = (e) => { if (!warned) { warned = true; console.warn('audio', e); } };
  const ready = () => !!ctx && unlocked;

  // ---------- Grafo y búferes ----------

  function build() {
    const OfflineCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    offline = !!OfflineCtor && ctx instanceof OfflineCtor;
    master = gain(userEnabled ? volume : 0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 3;
    comp.attack.value = 0.005; comp.release.value = 0.25;
    bus = gain(1);
    verbIn = gain(1);
    const verb = ctx.createConvolver();
    verb.buffer = makeImpulse(1.3);
    const verbOut = gain(0.55);
    chain(bus, comp, master, ctx.destination);
    chain(verbIn, verb, verbOut, comp);
    buffers = {
      white: makeNoise('white'), pink: makeNoise('pink'), brown: makeNoise('brown'), crackle: makeCrackle(3),
    };
  }

  /** Ruido de 2 s que se repite sin chasquido (el final enlaza con el principio). */
  function makeNoise(kind, seconds = 2) {
    const n = Math.floor(ctx.sampleRate * seconds), m = 4096;
    const x = new Float32Array(n + m);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < n + m; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') {
        // filtro de Paul Kellet (versión económica)
        b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
        x[i] = b0 + b1 + b2 + w * 0.1848;
      } else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        x[i] = last;
      } else x[i] = w;
    }
    for (let i = 0; i < m; i++) x[i] = x[i] * (i / m) + x[n + i] * (1 - i / m);
    return toBuffer(x.subarray(0, n));
  }

  /** Crepitar: impulsos cortos aleatorios (muchos flojos, pocos fuertes). */
  function makeCrackle(seconds) {
    const sr = ctx.sampleRate, n = Math.floor(sr * seconds), x = new Float32Array(n);
    let t = 0;
    while (true) {
      t += -Math.log(1 - Math.random()) / 55; // proceso de Poisson, ~55 chasquidos/s
      const start = Math.floor(t * sr);
      if (start >= n) break;
      const amp = Math.pow(Math.random(), 2.5), tau = rand(0.0003, 0.003) * sr, len = Math.min(n - start, Math.floor(tau * 5));
      for (let j = 0; j < len; j++) x[start + j] += amp * (Math.random() * 2 - 1) * Math.exp(-j / tau);
    }
    return toBuffer(x);
  }

  function toBuffer(x) {
    let peak = 1e-6;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const buf = ctx.createBuffer(1, x.length, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < x.length; i++) d[i] = (x[i] / peak) * 0.95;
    return buf;
  }

  /** Respuesta al impulso de una cocina pequeña: cola estéreo que se oscurece al decaer. */
  function makeImpulse(seconds) {
    const sr = ctx.sampleRate, n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let y = 0;
      for (let i = 0; i < n; i++) {
        const k = i / n;
        y += (Math.random() * 2 - 1 - y) * (0.85 - 0.7 * k); // filtro paso bajo que se cierra
        d[i] = y * Math.pow(1 - k, 2.4) * (i < sr * 0.012 ? i / (sr * 0.012) : 1);
      }
    }
    return buf;
  }

  // ---------- Utilidades de síntesis ----------

  function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function filter(type, freq, Q = 0.707) {
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    return f;
  }
  function osc(type, freq) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; return o; }
  function noise(kind, rate = 1) {
    const s = ctx.createBufferSource();
    s.buffer = buffers[kind]; s.loop = true; s.playbackRate.value = rate;
    return s;
  }
  function chain(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  /**
   * Envolvente: ataque lineal; después caída exponencial (decay) o rampa lineal (release) tras `hold`.
   * Devuelve el instante en que ya es silencio.
   */
  function envelope(param, t, { attack = 0.002, peak = 0.2, hold = 0, decay = 0.2, release }) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    const t1 = t + attack + hold;
    if (hold) param.setValueAtTime(peak, t1);
    if (release != null) { param.linearRampToValueAtTime(0, t1 + release); return t1 + release + 0.01; }
    param.setTargetAtTime(0, t1, decay / 5);
    return t1 + decay * 1.25;
  }

  /** Voz de un solo uso: se desconecta sola cuando acaban todas sus fuentes. */
  function makeVoice(level, wet, dest = bus, counted = true) {
    const out = gain(level);
    out.connect(dest);
    if (wet > 0) { const send = gain(wet); out.connect(send); send.connect(verbIn); }
    let pending = 0;
    if (counted) voices++;
    return {
      out,
      play(src, t0, t1, offset = 0) {
        pending++;
        src.onended = () => {
          if (--pending > 0) return;
          out.disconnect();
          if (counted) voices--;
        };
        src.start(t0, offset);
        src.stop(Math.max(t0 + 0.01, t1));
      },
    };
  }

  /** Tono con barrido opcional de frecuencia (to, sweep) y envolvente. */
  function tone(v, t, { type = 'sine', f, to, sweep = 0.05, dest = v.out, ...env }) {
    const o = osc(type, f);
    if (to) { o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(to, t + sweep); }
    const g = gain(0);
    const end = envelope(g.gain, t, env);
    chain(o, g, dest);
    v.play(o, t, end);
    return o;
  }

  /** Ráfaga de ruido filtrado con barrido opcional del filtro. */
  function noiseHit(v, t, { kind = 'white', type = 'bandpass', freq = 1000, to, sweep = 0.1, Q = 0.9, rate = 1, dest = v.out, ...env }) {
    const s = noise(kind, rate), f = filter(type, freq, Q), g = gain(0);
    if (to) { f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(to, t + sweep); }
    const end = envelope(g.gain, t, env);
    chain(s, f, g, dest);
    v.play(s, t, end, Math.random() * 1.5);
  }

  /** Golpe metálico: parciales inarmónicos [ratio, amplitud, caída] sobre f0. */
  function metal(v, t, f0, partials, dest = v.out) {
    for (const [ratio, peak, decay] of partials) tone(v, t, { f: f0 * ratio, attack: 0.001, peak, decay, dest });
  }

  /** Nota de marimba: fundamental + parciales 3.93 y 9.2 que se apagan muy rápido + golpe de maza. */
  function marimba(v, t, f, amp, decay) {
    tone(v, t, { f, attack: 0.002, peak: amp, decay });
    tone(v, t, { f: f * 3.93, attack: 0.001, peak: amp * 0.3, decay: 0.07 });
    tone(v, t, { f: f * 9.2, attack: 0.001, peak: amp * 0.08, decay: 0.03 });
    noiseHit(v, t, { type: 'lowpass', freq: 3000, peak: amp * 0.25, decay: 0.008 });
  }

  /** Bisagra: chirrido suave (diente de sierra filtrado con vibrato lento). */
  function hinge(v, t, dur, f0, f1, peak) {
    const o = osc('sawtooth', f0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f1, t + dur);
    const vib = osc('sine', 6.5), vibG = gain(f0 * 0.03);
    chain(vib, vibG, o.frequency);
    const g = gain(0);
    const end = envelope(g.gain, t, { attack: dur * 0.3, peak, hold: dur * 0.3, release: dur * 0.4 });
    chain(o, filter('bandpass', 1100, 5), filter('lowpass', 2600), g, v.out);
    v.play(o, t, end);
    v.play(vib, t, end);
  }

  // ---------- Efectos cortos ----------
  // build(v, t, r): v = voz, t = inicio, r = velocidad (sube el tono y acorta el sonido)

  const SHOTS = {
    click: { wet: 0.05, build(v, t, r) {
      tone(v, t, { f: 1700 * r, to: 900 * r, sweep: 0.03, peak: 0.13, decay: 0.035 });
      noiseHit(v, t, { type: 'highpass', freq: 2500, peak: 0.05, decay: 0.012 });
    } },
    tick: { wet: 0.04, build(v, t, r) {
      noiseHit(v, t, { freq: 4200 * r, Q: 3, attack: 0.0005, peak: 0.3, decay: 0.008 });
      tone(v, t, { f: 2600 * r, attack: 0.0005, peak: 0.06, decay: 0.012 });
    } },
    pop: { wet: 0.08, build(v, t, r) {
      tone(v, t, { f: 380 * r, to: 1150 * r, sweep: 0.05 / r, peak: 0.2, decay: 0.09 / r });
      noiseHit(v, t, { freq: 1800 * r, peak: 0.05, decay: 0.01 });
    } },
    'pour-start': { wet: 0.1, build(v, t, r) {
      noiseHit(v, t, { kind: 'pink', freq: 600 * r, to: 1800 * r, sweep: 0.25 / r, attack: 0.08 / r, peak: 0.2, release: 0.4 / r });
      noiseHit(v, t, { kind: 'brown', type: 'lowpass', freq: 400, attack: 0.05, peak: 0.12, release: 0.3 / r });
    } },
    splash: { wet: 0.15, build(v, t, r) {
      noiseHit(v, t, { type: 'lowpass', freq: 5000 * r, to: 700 * r, sweep: 0.35 / r, Q: 0.7, attack: 0.004, peak: 0.36, decay: 0.45 / r });
      noiseHit(v, t, { freq: 1200 * r, Q: 1.5, peak: 0.12, decay: 0.2 / r });
      for (let k = 0; k < 5; k++) {
        const f = rand(500, 1100) * r;
        tone(v, t + rand(0.04, 0.35) / r, { f, to: f * 1.7, sweep: 0.03, peak: rand(0.03, 0.07), decay: 0.06 });
      }
    } },
    plop: { wet: 0.08, build(v, t, r) {
      tone(v, t, { f: 160 * r, to: 70 * r, sweep: 0.12 / r, attack: 0.003, peak: 0.45, decay: 0.22 / r });
      noiseHit(v, t, { kind: 'brown', type: 'lowpass', freq: 700, peak: 0.3, decay: 0.12 / r });
      noiseHit(v, t + 0.01, { kind: 'pink', freq: 900 * r, to: 350 * r, sweep: 0.15 / r, Q: 2, attack: 0.01, peak: 0.1, decay: 0.15 / r });
    } },
    thump: { wet: 0.06, build(v, t, r) {
      tone(v, t, { f: 95 * r, to: 48 * r, sweep: 0.15 / r, attack: 0.004, peak: 0.36, decay: 0.25 / r });
      noiseHit(v, t, { kind: 'brown', type: 'lowpass', freq: 500, peak: 0.32, decay: 0.1 / r });
      noiseHit(v, t + 0.02, { kind: 'pink', freq: 700 * r, to: 260 * r, sweep: 0.2 / r, Q: 2.5, attack: 0.015, peak: 0.11, decay: 0.2 / r });
    } },
    whoosh: { wet: 0.12, build(v, t, r) {
      const d = 0.55 / r, s = noise('pink'), f = filter('bandpass', 350, 1.2), g = gain(0), pan = ctx.createStereoPanner();
      f.frequency.setValueAtTime(350 * r, t);
      f.frequency.exponentialRampToValueAtTime(2200 * r, t + d * 0.4);
      f.frequency.exponentialRampToValueAtTime(500 * r, t + d);
      pan.pan.setValueAtTime(-0.6, t);
      pan.pan.linearRampToValueAtTime(0.6, t + d);
      const end = envelope(g.gain, t, { attack: d * 0.4, peak: 0.48, release: d * 0.6 });
      chain(s, f, g, pan, v.out);
      v.play(s, t, end, Math.random());
    } },
    'oven-open': { wet: 0.15, build(v, t, r) {
      // pestillo, bisagra, aire caliente y tope al abrir del todo (~0.8 s)
      noiseHit(v, t, { type: 'highpass', freq: 1800, peak: 0.2, decay: 0.025 });
      metal(v, t, 2100 * r, [[1, 0.04, 0.05], [1.62, 0.03, 0.04]]);
      hinge(v, t + 0.05, 0.6 / r, 210 * r, 160 * r, 0.045);
      noiseHit(v, t + 0.15, { kind: 'pink', type: 'lowpass', freq: 900, attack: 0.2, peak: 0.1, release: 0.45 });
      const t2 = t + 0.78 / r;
      metal(v, t2, 146 * r, [[1, 0.2, 0.35], [2.54, 0.11, 0.22], [4.06, 0.08, 0.15], [6.28, 0.05, 0.1], [9.8, 0.03, 0.06]]);
      noiseHit(v, t2, { kind: 'brown', type: 'lowpass', freq: 600, peak: 0.22, decay: 0.08 });
    } },
    'oven-close': { wet: 0.15, build(v, t, r) {
      // la puerta encaja: golpe metálico grave, cuerpo y pestillo
      metal(v, t, 118 * r, [[1, 0.19, 0.45], [2.52, 0.1, 0.25], [4.34, 0.065, 0.15], [6.8, 0.045, 0.1], [10.5, 0.025, 0.06]]);
      tone(v, t, { f: 62 * r, to: 45 * r, sweep: 0.1, attack: 0.003, peak: 0.24, decay: 0.16 });
      noiseHit(v, t, { kind: 'brown', type: 'lowpass', freq: 700, peak: 0.32, decay: 0.07 });
      noiseHit(v, t + 0.04, { type: 'highpass', freq: 2200, peak: 0.12, decay: 0.015 });
    } },
    beep: { wet: 0.06, build(v, t, r) {
      for (let k = 0; k < 3; k++) {
        const tk = t + (k * 0.2) / r;
        tone(v, tk, { f: 1760 * r, attack: 0.006, peak: 0.17, hold: 0.1 / r, release: 0.03 });
        tone(v, tk, { f: 3520 * r, attack: 0.006, peak: 0.025, hold: 0.1 / r, release: 0.03 });
      }
    } },
    ding: { wet: 0.3, build(v, t, r) {
      // campana de temporizador: parciales inarmónicos con batido suave y cola larga
      metal(v, t, 1480 * r, [[1, 0.2, 2.8], [1.0035, 0.09, 2.6], [2.405, 0.11, 1.3], [3.87, 0.06, 0.7], [5.43, 0.035, 0.45], [7.1, 0.02, 0.3]]);
      noiseHit(v, t, { type: 'highpass', freq: 3000, peak: 0.1, decay: 0.01 });
    } },
    success: { wet: 0.25, build(v, t, r) {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => marimba(v, t + (i * 0.085) / r, f * r, i === 3 ? 0.24 : 0.19, i === 3 ? 0.9 : 0.5));
      const ts = t + 0.3 / r;
      tone(v, ts, { f: 2093 * r, attack: 0.01, peak: 0.025, decay: 0.7 });
      tone(v, ts + 0.05, { f: 2637 * r, attack: 0.01, peak: 0.02, decay: 0.6 });
    } },
    fail: { wet: 0.25, build(v, t, r) {
      // dos notas que bajan, suaves y redondas («oh…»)
      const note = (tn, f, hold, release, bend) => {
        const lp = filter('lowpass', 1400), g = gain(0);
        const end = envelope(g.gain, tn, { attack: 0.02, peak: 0.17, hold, release });
        chain(lp, g, v.out);
        const vib = osc('sine', 5), vibG = gain(f * 0.006);
        vib.connect(vibG);
        for (const [type, mult, lvl] of [['triangle', 1, 1], ['sine', 0.5, 0.45]]) {
          const o = osc(type, f * mult), og = gain(lvl);
          if (bend) { o.detune.setValueAtTime(0, tn + hold); o.detune.linearRampToValueAtTime(-35, end); }
          vibG.connect(o.frequency);
          chain(o, og, lp);
          v.play(o, tn, end);
        }
        v.play(vib, tn, end);
      };
      note(t, 329.63 * r, 0.12 / r, 0.25 / r, false);
      note(t + 0.28 / r, 261.63 * r, 0.25 / r, 0.45 / r, true);
    } },
    cut: { wet: 0.05, build(v, t, r) {
      // la sierra del cuchillo raspando la corteza
      noiseHit(v, t, { freq: 3200 * r, Q: 1.4, attack: 0.03, peak: 0.16, release: 0.2 / r });
      noiseHit(v, t, { kind: 'crackle', type: 'highpass', freq: 2000, rate: r, attack: 0.02, peak: 0.35, release: 0.22 / r });
      noiseHit(v, t, { kind: 'pink', freq: 900 * r, Q: 2, attack: 0.03, peak: 0.06, release: 0.2 / r });
    } },
    crunch: { wet: 0.05, build(v, t, r) {
      noiseHit(v, t, { kind: 'crackle', freq: 2500 * r, Q: 0.6, rate: r, attack: 0.004, peak: 1.3, decay: 0.3 / r });
      noiseHit(v, t, { kind: 'crackle', type: 'lowpass', freq: 1200, rate: 0.6 * r, attack: 0.004, peak: 0.9, decay: 0.2 / r });
      noiseHit(v, t, { kind: 'brown', type: 'lowpass', freq: 400, peak: 0.3, decay: 0.06 });
    } },
    cloth: { wet: 0.08, build(v, t, r) {
      const d = 0.4 / r, s = noise('pink'), f = filter('bandpass', 1000 * r, 0.6), g = gain(0);
      f.frequency.setValueAtTime(1000 * r, t);
      f.frequency.exponentialRampToValueAtTime(2000 * r, t + d * 0.35);
      f.frequency.exponentialRampToValueAtTime(1200 * r, t + d);
      const end = envelope(g.gain, t, { attack: d * 0.25, peak: 0.22, release: d * 0.75 });
      chain(s, f, filter('lowpass', 4000), g, v.out);
      v.play(s, t, end, Math.random());
      noiseHit(v, t, { type: 'highpass', freq: 5000, attack: d * 0.25, peak: 0.025, release: d * 0.75 });
    } },
    'sizzle-start': { wet: 0.1, build(v, t, r) {
      const s = noise('crackle', r), g = gain(0);
      const end = envelope(g.gain, t, { attack: 0.01, peak: 0.42, decay: 1.0 });
      chain(s, filter('highpass', 2500), filter('lowpass', 7500), g, v.out);
      v.play(s, t, end, Math.random() * 2);
      noiseHit(v, t, { type: 'highpass', freq: 4000, attack: 0.02, peak: 0.08, decay: 0.8 });
    } },
  };

  // ---------- Bucles ----------
  // build(L) conecta fuentes a L.in, registra tareas con L.every() y devuelve apply(intensidad, t).
  // fadeIn: segundos de entrada; wet: envío a la reverb.

  const LOOPS = {
    'pour-powder': { fadeIn: 0.2, build(L) {
      const bp = filter('bandpass', 1800, 0.7), mod = gain(0.8);
      L.source(noise('pink'), bp, filter('lowpass', 6000), mod);
      L.source(noise('brown'), filter('lowpass', 320), gain(0.35));
      L.source(noise('crackle', 1.6), filter('highpass', 3000), gain(0.22)); // granitos
      L.every(() => rand(0.06, 0.16), (tt) => {
        mod.gain.setTargetAtTime(rand(0.55, 1), tt, 0.05);
        bp.frequency.setTargetAtTime(rand(1300, 2300), tt, 0.08);
      });
      return (x, tt) => L.in.gain.setTargetAtTime(0.5 * Math.pow(x, 0.8), tt, 0.08);
    } },
    'pour-liquid': { fadeIn: 0.2, wet: 0.08, build(L) {
      const bp = filter('bandpass', 750, 0.9), mod = gain(0.8);
      L.source(noise('white'), bp, filter('lowpass', 2500), mod);
      L.source(noise('pink'), filter('highpass', 2500), filter('lowpass', 7000), gain(0.1));
      L.every(() => rand(0.025, 0.07), (tt) => {
        mod.gain.setTargetAtTime(rand(0.35, 1), tt, 0.02);
        bp.frequency.setTargetAtTime(rand(600, 1100), tt, 0.03);
      });
      // burbujas: senos cortos que suben de tono
      L.every(() => rand(0.04, 0.14), (tt) => {
        if (Math.random() > 0.35 + 0.65 * L.intensity) return;
        const f = rand(350, 900);
        tone(L.voice(), tt, { f, to: f * rand(1.4, 2), sweep: rand(0.02, 0.04), peak: rand(0.05, 0.14), decay: rand(0.04, 0.08) });
      });
      return (x, tt) => L.in.gain.setTargetAtTime(0.45 * Math.pow(x, 0.7), tt, 0.08);
    } },
    stir: { fadeIn: 0.25, build(L) {
      const wob = gain(0.65), lfo = osc('sine', 1.6), depth = gain(0.3);
      chain(lfo, depth, wob.gain);
      L.source(noise('brown'), filter('bandpass', 420, 1.6), gain(2.2), wob);
      L.start(lfo);
      // chapoteos húmedos
      L.every(() => rand(0.12, 0.35), (tt) => {
        if (Math.random() > 0.4 + 0.6 * L.intensity) return;
        const up = Math.random() < 0.5, lo = rand(280, 420), hi = rand(800, 1200);
        noiseHit(L.voice(), tt, { kind: 'pink', freq: up ? lo : hi, to: up ? hi : lo, sweep: rand(0.06, 0.12), Q: 4, attack: 0.01, peak: rand(0.15, 0.3), decay: 0.1 });
      });
      return (x, tt) => {
        L.in.gain.setTargetAtTime(0.55 * x, tt, 0.1);
        lfo.frequency.setTargetAtTime(1.2 + 1.2 * x, tt, 0.2);
      };
    } },
    knead: { fadeIn: 0.25, wet: 0.05, build(L) {
      const mod = gain(0.6);
      L.source(noise('pink'), filter('bandpass', 600, 1.2), filter('lowpass', 1500), gain(0.3), mod);
      L.every(() => rand(0.08, 0.25), (tt) => mod.gain.setTargetAtTime(rand(0.3, 1), tt, 0.06));
      // presiones: golpe sordo + aplastado, más seguidas con más intensidad
      L.every(() => rand(0.45, 0.9) / (0.6 + 0.8 * L.intensity), (tt) => {
        const v = L.voice();
        tone(v, tt, { f: 85, to: 50, sweep: 0.12, attack: 0.004, peak: 0.4, decay: 0.2 });
        noiseHit(v, tt + 0.015, { kind: 'pink', freq: 700, to: 280, sweep: 0.18, Q: 2, attack: 0.02, peak: 0.18, decay: 0.18 });
      });
      return (x, tt) => L.in.gain.setTargetAtTime(0.6 * x, tt, 0.1);
    } },
    'oven-hum': { fadeIn: 0.6, build(L) {
      L.source(noise('brown'), filter('lowpass', 180), gain(0.32));
      const fanBp = filter('bandpass', 520, 2.5), fanG = gain(0.06), am = osc('sine', 23), amG = gain(0.025);
      chain(am, amG, fanG.gain);
      L.source(noise('pink'), fanBp, fanG);
      L.start(am);
      const motor = filter('lowpass', 400);
      motor.connect(L.in);
      for (const [f, lvl] of [[100, 0.035], [100.6, 0.035], [200, 0.012]]) {
        const o = osc('sine', f), g = gain(lvl);
        chain(o, g, motor);
        L.start(o);
      }
      return (x, tt) => {
        L.in.gain.setTargetAtTime(0.35 + 0.5 * x, tt, 0.3);
        fanBp.frequency.setTargetAtTime(420 + 200 * x, tt, 0.4);
      };
    } },
    sizzle: { fadeIn: 0.3, build(L) {
      L.source(noise('crackle'), filter('highpass', 2200), filter('lowpass', 7000), gain(0.55));
      L.source(noise('crackle', 0.77), filter('highpass', 1500), filter('lowpass', 5000), gain(0.4));
      const hiss = gain(0.05);
      L.source(noise('white'), filter('highpass', 5000), filter('lowpass', 9000), hiss);
      L.every(() => rand(0.1, 0.3), (tt) => hiss.gain.setTargetAtTime(rand(0.02, 0.07), tt, 0.08));
      // chasquidos sueltos más fuertes
      L.every(() => rand(0.15, 0.7) / (0.3 + L.intensity), (tt) => {
        noiseHit(L.voice(), tt, { kind: 'crackle', freq: rand(2000, 5000), Q: 0.8, attack: 0.001, peak: rand(0.15, 0.35), decay: rand(0.02, 0.06) });
      });
      return (x, tt) => L.in.gain.setTargetAtTime(0.45 * x, tt, 0.15);
    } },
    ambience: { fadeIn: 2, wet: 0.35, build(L) {
      const room = gain(0.8);
      L.source(noise('brown'), filter('lowpass', 260), gain(0.12), room);
      L.source(noise('pink'), filter('lowpass', 900), filter('highpass', 120), gain(0.02), room);
      L.every(() => rand(0.8, 2), (tt) => room.gain.setTargetAtTime(rand(0.7, 1), tt, 0.6));
      // pájaros lejanos de vez en cuando
      L.every(() => rand(3.5, 9), (tt) => birdPhrase(L, tt));
      return (x, tt) => L.in.gain.setTargetAtTime(x, tt, 0.3);
    } },
  };

  /** Un pájaro lejano: tres tipos de frase (pío-pío, gorjeo ascendente, trino). */
  function birdPhrase(L, t) {
    const pan = ctx.createStereoPanner();
    pan.pan.value = rand(-0.7, 0.7);
    const v = L.voice();
    const lp = filter('lowpass', 6000);
    chain(lp, pan, v.out);
    const chirp = (tc, f0, f1, dur, peak) => tone(v, tc, { f: f0, to: f1, sweep: dur, attack: 0.008, peak, release: dur, dest: lp });
    const kind = Math.floor(Math.random() * 3), amp = rand(0.03, 0.06);
    if (kind === 0) {
      const f = rand(3200, 4200);
      for (let k = 0, n = 2 + Math.floor(rand(0, 3)); k < n; k++) chirp(t + k * rand(0.11, 0.16), f, f * 0.72, 0.07, amp);
    } else if (kind === 1) {
      const f = rand(2200, 2800);
      for (let k = 0, n = 2 + Math.floor(rand(0, 2)); k < n; k++) chirp(t + k * 0.14, f, f * 1.45, 0.09, amp);
    } else {
      const f = rand(3700, 4300);
      for (let k = 0, n = 6 + Math.floor(rand(0, 5)); k < n; k++) chirp(t + k * 0.045, k % 2 ? f * 0.9 : f, k % 2 ? f * 0.86 : f * 0.97, 0.035, amp * 0.7);
    }
  }

  function startLoop(def, level) {
    const t = ctx.currentTime;
    const L = {
      in: gain(1), out: gain(0), sources: [], tasks: [], intensity: 1, stopped: false,
      start(src) { src.start(t, src.buffer ? Math.random() * src.buffer.duration : 0); this.sources.push(src); },
      /** Fuente → nodos... → L.in, y la arranca. */
      source(src, ...nodes) { chain(src, ...nodes, this.in); this.start(src); },
      every(interval, fn) { this.tasks.push({ next: t + Math.random() * interval(), interval, fn }); },
      voice() { return makeVoice(1, 0, this.in, false); },
    };
    L.in.connect(L.out);
    L.out.connect(bus);
    if (def.wet) { const send = gain(def.wet); L.out.connect(send); send.connect(verbIn); }
    L.apply = def.build(L);
    L.apply(1, t);
    L.out.gain.setValueAtTime(0, t);
    L.out.gain.linearRampToValueAtTime(level, t + def.fadeIn);
    loops.add(L);
    pump();
    if (!offline && !timer) timer = setInterval(pump, 100);
    return L;
  }

  function stopLoop(L, fade) {
    if (L.stopped) return;
    L.stopped = true;
    loops.delete(L);
    if (!loops.size && timer) { clearInterval(timer); timer = 0; }
    const t = ctx.currentTime, g = L.out.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.linearRampToValueAtTime(0, t + fade);
    L.sources.forEach((s, i) => {
      if (i === 0) s.onended = () => L.out.disconnect();
      s.stop(t + fade + 0.05);
    });
  }

  /** Programa los eventos de los bucles hasta el horizonte (offline: hasta el final del render). */
  function pump() {
    if (!ctx) return;
    const now = ctx.currentTime, horizon = offline ? ctx.length / ctx.sampleRate : now + LOOKAHEAD;
    for (const L of loops) {
      for (const task of L.tasks) {
        // si el temporizador se retrasó, se saltan los eventos perdidos en vez de amontonarlos
        if (task.next < now) task.next = now + Math.random() * 0.05;
        let guard = 0;
        while (task.next < horizon && guard++ < 400) {
          try { task.fn(task.next); } catch (e) { warn(e); }
          task.next += Math.max(0.01, task.interval());
        }
      }
    }
  }

  function onVisibility() {
    if (!ctx || offline) return;
    if (document.hidden) ctx.suspend?.().catch(() => {});
    else if (unlocked) ctx.resume?.().catch(() => {});
  }

  /** Rampa lineal corta del volumen maestro (llega exactamente a 0 al silenciar). */
  function setMaster() {
    if (!ready()) return;
    const g = master.gain, t = ctx.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else { g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); }
    g.linearRampToValueAtTime(userEnabled ? volume : 0, t + 0.12);
  }

  // ---------- API ----------

  return {
    /** Crea/reanuda el contexto de audio. Llamar desde un gesto del usuario. Devuelve si hay audio. */
    unlock() {
      try {
        if (!ctx) {
          const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
          ctx = context ?? (Ctor ? new Ctor({ latencyHint: 'interactive' }) : null);
          if (!ctx) return false;
          build();
          if (!offline) document.addEventListener('visibilitychange', onVisibility);
        }
        if (!offline && ctx.state !== 'running') ctx.resume?.().catch(() => {});
        if (!unlocked && !offline) {
          // iOS: un búfer mudo dentro del gesto termina de desbloquear la salida
          const s = ctx.createBufferSource();
          s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
          s.connect(ctx.destination);
          s.start();
        }
        unlocked = true;
      } catch (e) {
        warn(e);
        ctx = null;
        unlocked = false;
      }
      return unlocked;
    },

    /** true si el audio está desbloqueado y activado. */
    get enabled() { return ready() && userEnabled; },

    /** Activa o silencia todo (con un fundido corto). Los bucles siguen vivos en silencio. */
    setEnabled(on) {
      userEnabled = !!on;
      try { setMaster(); if (userEnabled && ready() && !offline) ctx.resume?.().catch(() => {}); } catch (e) { warn(e); }
    },

    /** Volumen maestro 0..1. */
    setVolume(v) {
      if (!Number.isFinite(v)) return;
      volume = clamp01(v);
      try { setMaster(); } catch (e) { warn(e); }
    },

    /**
     * Efecto corto. Nombres desconocidos no hacen nada.
     * @param {string} name
     * @param {{volume?: number, rate?: number}} [opts]
     */
    play(name, opts) {
      if (!ready() || !userEnabled || !Object.hasOwn(SHOTS, name) || voices >= MAX_VOICES) return;
      const def = SHOTS[name], { volume: vol = 1, rate = 1 } = opts ?? {};
      try {
        const t = ctx.currentTime;
        if (t - (lastPlayed.get(name) ?? -1) < 0.03) return; // evita ráfagas idénticas
        lastPlayed.set(name, t);
        const level = Number.isFinite(vol) ? Math.min(2, Math.max(0, vol)) : 1;
        const r = Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1;
        def.build(makeVoice(level, def.wet), t + 0.005, r);
      } catch (e) { warn(e); }
    },

    /**
     * Sonido continuo. Devuelve un handle seguro aunque el audio no esté disponible.
     * @param {string} name
     * @param {{volume?: number}} [opts]
     * @returns {{setIntensity(v01: number): void, stop(fadeSeconds?: number): void}}
     */
    loop(name, opts) {
      if (!ready() || !Object.hasOwn(LOOPS, name) || loops.size >= MAX_LOOPS) return NOOP_LOOP;
      const def = LOOPS[name], { volume: vol = 1 } = opts ?? {};
      let L;
      try {
        L = startLoop(def, Number.isFinite(vol) ? Math.min(2, Math.max(0, vol)) : 1);
      } catch (e) { warn(e); return NOOP_LOOP; }
      return {
        setIntensity(v) {
          if (L.stopped || !Number.isFinite(v)) return;
          const x = clamp01(v);
          if (Math.abs(x - L.intensity) < 0.01) return;
          L.intensity = x;
          try { L.apply(x, ctx.currentTime); } catch (e) { warn(e); }
        },
        stop(fade = 0.25) {
          try { stopLoop(L, Number.isFinite(fade) ? Math.max(0.02, fade) : 0.25); } catch (e) { warn(e); }
        },
      };
    },
  };
}
