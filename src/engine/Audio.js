// Audio.js — fully procedural WebAudio sound engine (no assets, works offline).
//
//   const audio = new AudioEngine();      // creates nothing yet (autoplay policy)
//   audio.unlock();                       // from a user gesture: creates / resumes the context
//   audio.startFlight(spec);              // continuous voices for this aircraft
//   audio.update(dt, state);              // every frame
//   audio.play('explosion', { dist: 400, size: 1.5 });
//
// Signal flow
//   [flight voices] -> ext low-pass (cockpit muffle) -> flight bus --+
//   [gun] [warning tones] ------------------------------> flight bus +-> mix -> compressor -> trim
//   [one-shots] -> sfx -------------------------------------------- -+      -> soft clip -> out (volume) -> destination
//
// Continuous voices are built once per startFlight() and only have their AudioParams
// steered (setTargetAtTime, and only when a target actually changes), so update() does
// not allocate. One-shots create a few nodes and disconnect themselves when they end.
// Every public method is a no-op before unlock() or where WebAudio is missing, and
// never throws (failures are counted in `errorCount` / `lastError`).
//
// Testing: pass `{ context }` (e.g. an OfflineAudioContext) to the constructor and the
// engine uses it instead of creating a live AudioContext — see tests/preview_audio.html.

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const fin = (x, d) => (typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity ? x : d);

// Warning tone table, indexed by priority id (0 = silent).
//   f: base Hz, sine/saw: partial levels, fm: LFO shape + rate + depth (Hz) on the pitch,
//   am: gating rate (Hz) (0 = steady), lvl: output level.
const WARN = [
  null,
  { f: 1150, sine: 1.0, saw: 0.0, fmType: 'sine', fmRate: 1, fmDepth: 0, am: 3.2, lvl: 0.10 },       // 1 lock acquiring: slow beeps
  { f: 1520, sine: 1.0, saw: 0.0, fmType: 'sine', fmRate: 13, fmDepth: 75, am: 0, lvl: 0.085 },     // 2 locked: steady warbling tone
  { f: 430, sine: 0.35, saw: 0.5, fmType: 'sine', fmRate: 7, fmDepth: 9, am: 0, lvl: 0.11 },        // 3 stall horn
  { f: 900, sine: 0.75, saw: 0.22, fmType: 'sawtooth', fmRate: 2.4, fmDepth: 420, am: 0, lvl: 0.13 }, // 4 pull up: whoop-whoop
  { f: 1650, sine: 0.6, saw: 0.3, fmType: 'square', fmRate: 6, fmDepth: 290, am: 0, lvl: 0.14 },    // 5 missile: urgent two-tone
];
const WARN_FADE = 0.008;   // s, gain time-constant when a warning starts / stops
const WARN_GAP = 0.045;    // s of silence while the tone generator is re-patched

// Minimum spacing between identical one-shots (s) and a cap on simultaneous one-shot sources.
const MIN_GAP = { hitmark: 0.035, hit: 0.05, explosion: 0.03, click: 0.03 };
const MAX_ACTIVE = 40;

export class AudioEngine {
  /** @param {{context?: BaseAudioContext}} [opts] context: use this (e.g. OfflineAudioContext) instead of creating one */
  constructor(opts = {}) {
    this.ctx = null;
    this._injected = (opts && opts.context) || null;
    this._offline = false;
    this._resuming = false;
    this.enabled = true;
    this.volume = 1;
    this.flight = null;
    this._paused = false;
    this._pendingSpec = null;
    this._active = 0;
    this._last = Object.create(null);
    this.errorCount = 0;
    this.lastError = null;
  }

  /** Final node before the destination (handy for an AnalyserNode in tests). */
  get output() { return this.ctx ? this.out : null; }

  // ------------------------------------------------------------------ lifecycle

  unlock() {
    try {
      if (!this.ctx) {
        let ctx = this._injected;
        if (!ctx) {
          const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
          if (!AC) return false;
          ctx = new AC({ latencyHint: 'interactive' });
        }
        this._offline = typeof ctx.startRendering === 'function';
        this._build(ctx);
        this.ctx = ctx;
      }
      this._wake();
      if (this._pendingSpec) { const sp = this._pendingSpec; this._pendingSpec = null; this.startFlight(sp); }
    } catch (e) { this._fail(e); }
    return !!this.ctx;
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._applyMaster();
  }

  setVolume(v) {
    this.volume = clamp(fin(v, 1), 0, 1);
    this._applyMaster();
  }

  startFlight(spec) {
    if (!this.ctx) { this._pendingSpec = spec || null; return; }
    try {
      this.stopFlight();
      this.flight = this._buildFlight(spec || {});
    } catch (e) { this._fail(e); }
  }

  stopFlight() {
    this._pendingSpec = null;
    const f = this.flight;
    if (!f || !this.ctx) return;
    this.flight = null;
    try {
      const t = this.ctx.currentTime;
      f.bus.gain.setTargetAtTime(0, t, 0.06);
      const end = t + 0.6;
      const nodes = f.nodes;
      f.noise.onended = () => { for (let i = 0; i < nodes.length; i++) { try { nodes[i].disconnect(); } catch (_) { /* gone */ } } };
      for (let i = 0; i < f.sources.length; i++) f.sources[i].stop(end);
    } catch (e) { this._fail(e); }
  }

  /** Pause menu: fade the continuous voices quickly, keep the context alive. */
  suspend() {
    this._paused = true;
    if (!this.ctx || !this.flight) return;
    try { this.flight.bus.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03); } catch (e) { this._fail(e); }
  }

  resume() {
    this._paused = false;
    if (!this.ctx) return;
    try {
      this._wake();
      if (this.flight) this.flight.bus.gain.setTargetAtTime(1, this.ctx.currentTime, 0.06);
    } catch (e) { this._fail(e); }
  }

  // ------------------------------------------------------------------ per-frame

  update(dt, s) {
    const f = this.flight;
    if (!f || !s) return;
    try { this._update(f, s); } catch (e) { this._fail(e); }
  }

  _update(f, s) {
    const now = this.ctx.currentTime;
    this._now = now;
    const thr = clamp(fin(s.thrEff, 0), 0, 1);
    const vMax = Math.max(1, fin(s.vMax, f.vMax));
    const sp = clamp(fin(s.speed, 0) / vMax, 0, 1.3);
    const q = sp * sp;
    const cockpit = !!s.cockpit;
    const dmg = clamp(fin(s.damaged, 0), 0, 1);
    const buffet = clamp(fin(s.buffet, 0), 0, 1);
    const brake = clamp(fin(s.airbrake, 0), 0, 1);
    const g = clamp(fin(s.gForce, 1), -5, 12);
    const ab = !!s.ab && f.hasAB;

    // exterior muffle + balance
    this._tgt(f.sExtF, cockpit ? 1250 : f.extOpen, 0.09);
    this._tgt(f.sEng, cockpit ? 0.8 : 1, 0.09);
    this._tgt(f.sDmg, dmg * 0.4, 0.2);

    // ---- engine
    if (f.type === 'jet') {
      this._tgt(f.sRoarF, 260 + 2300 * Math.pow(thr, 1.6) + (ab ? 900 : 0), 0.12);
      this._tgt(f.sRoarG, 0.22 + 0.68 * thr + (ab ? 0.3 : 0), 0.12);
      this._tgt(f.sHissG, 0.02 + 0.1 * thr, 0.12);
      const wf = 1050 + 2350 * Math.pow(thr, 0.8);
      this._tgt(f.sW1, wf, 0.14);
      this._tgt(f.sW2, wf * 2.02, 0.14);
      if (f.sW3) this._tgt(f.sW3, wf * 1.011, 0.14);
      this._tgt(f.sWhineG, 0.016 + 0.012 * thr, 0.14);
      if (f.hasAB) {
        this._tgt(f.sAbG, ab ? 2.0 : 0, 0.1);
        if (ab && !f.abOn) this._abThump(now);
        f.abOn = ab;
      }
    } else if (f.type === 'prop') {
      const pf = (f.fIdle + (f.fFull - f.fIdle) * Math.pow(thr, 0.9)) * (1 + 0.1 * Math.min(sp, 1));
      this._tgt(f.sP1, pf, 0.12);
      this._tgt(f.sP2, pf * 0.5, 0.12);
      this._tgt(f.sP3, pf * 3.01, 0.12);
      if (f.sP4) this._tgt(f.sP4, pf * 1.012, 0.12);
      this._tgt(f.sPropF, 380 + 1500 * thr, 0.12);
      this._tgt(f.sPropG, 0.07 + 0.15 * thr, 0.12);
      this._tgt(f.sExF, 500 + 900 * thr, 0.12);
      this._tgt(f.sExG, 0.25 + 0.9 * thr, 0.12);
    } else { // heli
      this._tgt(f.sRot, 16.5 + 3.5 * thr, 0.25);
      this._tgt(f.sSlapF, 380 + 420 * thr, 0.15);
      this._tgt(f.sSlapG, 0.55 + 0.85 * thr + 0.3 * Math.min(sp, 1), 0.15);
      const tf = 1900 + 550 * thr;
      this._tgt(f.sT1, tf, 0.2);
      if (f.sT2) this._tgt(f.sT2, tf * 1.013, 0.2);
      this._tgt(f.sWhineG, 0.014 + 0.01 * thr, 0.2);
      this._tgt(f.sHissG, 0.04 + 0.07 * thr, 0.15);
    }

    // ---- airflow: wind, buffet, ground roll, gear motor
    this._tgt(f.sWindF, 350 + 1100 * Math.min(sp, 1.2), 0.15);
    this._tgt(f.sWindG, q * 0.75 * (cockpit ? 0.5 : 1) * (1 + 0.5 * brake) * (1 + 0.04 * Math.max(0, g - 1)) + buffet * 0.05, 0.12);
    this._tgt(f.sBufDepth, buffet * 0.6, 0.08);
    this._tgt(f.sLfo, 9 + 4 * buffet, 0.2);
    this._tgt(f.sBufG, buffet * 2.6 * (0.35 + 0.65 * Math.min(1, sp * 2)) + brake * q * 1.8, 0.08);
    const gs = fin(s.groundSpeed, 0);
    const gnd = s.onGround && gs > 2 ? Math.min(1, gs / 70) : 0;
    this._tgt(f.sRumF, gnd > 0 ? 150 + 160 * gnd : 190, 0.2);
    this._tgt(f.sGndG, gnd > 0 ? 0.8 + 2.4 * gnd : 0, 0.1);
    this._tgt(f.sGearG, s.gearMoving ? 0.03 : 0, 0.05);

    // ---- gun: free-running pulse train, gated
    const firing = !!s.firing;
    if (firing) this._tgt(f.sGunF, 1 / clamp(fin(s.gunRate, f.gunRate), 0.02, 0.5), 0.004);
    this._tgt(f.sGunGate, firing ? 0.42 : 0, 0.0035);

    // ---- warning tones (one generator, highest priority wins)
    const lock = fin(s.lock, 0) | 0;
    const want = s.missileWarn ? 5 : s.pullUp ? 4 : s.stall ? 3 : lock === 2 ? 2 : lock === 1 ? 1 : 0;
    if (want !== f.warnWant) {
      f.warnWant = want;
      f.warnG.gain.setTargetAtTime(0, now, WARN_FADE);
      f.warnSwitchAt = now + WARN_GAP;
      f.warnPending = true;
    }
    if (f.warnPending && now >= f.warnSwitchAt) {
      f.warnPending = false;
      f.warnCur = f.warnWant;
      const w = WARN[f.warnWant];
      if (w) {
        f.wA.frequency.value = w.f; f.wB.frequency.value = w.f;
        f.mixA.gain.value = w.sine; f.mixB.gain.value = w.saw;
        if (f.fm.type !== w.fmType) f.fm.type = w.fmType;
        f.fm.frequency.value = w.fmRate; f.fmDepth.gain.value = w.fmDepth;
        if (w.am > 0) { f.am.frequency.value = w.am; f.amDepth.gain.value = 0.5; f.gate.gain.value = 0.5; }
        else { f.amDepth.gain.value = 0; f.gate.gain.value = 1; }
        f.warnG.gain.setTargetAtTime(w.lvl, now, WARN_FADE);
      }
    }
  }

  // ------------------------------------------------------------------ one-shots

  play(name, opts) {
    const ctx = this.ctx;
    if (!ctx || !this.enabled) return;
    if (!this._offline && ctx.state !== 'running' && !this._resuming) return; // don't queue sounds on a frozen clock
    if (!Object.prototype.hasOwnProperty.call(SHOTS, name)) return;
    try {
      const now = ctx.currentTime;
      const last = this._last[name];
      const gap = MIN_GAP[name] || 0.015;
      if (last !== undefined && now - last < gap && now >= last) return;
      if (this._active > MAX_ACTIVE && name !== 'crash' && name !== 'explosion') return;
      this._last[name] = now;
      SHOTS[name](this, now + 0.002, opts || {});
    } catch (e) { this._fail(e); }
  }

  // ------------------------------------------------------------------ internals

  _fail(e) {
    this.errorCount++;
    this.lastError = e;
    if (this.errorCount === 1 && typeof console !== 'undefined') console.warn('[audio]', e);
  }

  _wake() {
    const ctx = this.ctx;
    if (!ctx || this._offline) return;
    if (ctx.state !== 'running' && ctx.state !== 'closed' && typeof ctx.resume === 'function') {
      this._resuming = true;
      const done = () => { this._resuming = false; };
      try {
        const p = ctx.resume();
        if (p && p.then) p.then(done, done); else done();
      } catch (_) { done(); }
    }
  }

  _applyMaster() {
    if (!this.ctx) return;
    try { this.out.gain.setTargetAtTime(this.enabled ? this.volume : 0, this.ctx.currentTime, 0.025); } catch (e) { this._fail(e); }
  }

  /** Steer a cached param slot; skips the call when the target has not really changed. */
  _tgt(slot, v, tc) {
    if (v !== v) return;
    const d = v - slot.v;
    if ((d < 0 ? -d : d) <= 1e-4 + 0.003 * (slot.v < 0 ? -slot.v : slot.v)) return;
    slot.v = v;
    slot.p.setTargetAtTime(v, this._now, tc);
  }

  _build(ctx) {
    const sr = ctx.sampleRate;
    // one shared 4 s white-noise buffer
    const len = Math.floor(sr * 4);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;

    // pulse envelope: sawtooth phase (-1..1) -> sharp attack, power-law decay (gun rounds, blade slap)
    const pc = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 1023 * 2 - 1; pc[i] = Math.pow((1 - x) / 2, 2.6); }
    this.pulseCurve = pc;

    // output soft clipper: linear to 0.7, then a tanh knee that tops out near 0.92
    const cc = new Float32Array(4097);
    for (let i = 0; i < 4097; i++) {
      const x = i / 2048 - 1, a = Math.abs(x);
      cc[i] = a < 0.7 ? x : Math.sign(x) * (0.7 + 0.28 * Math.tanh((a - 0.7) / 0.28));
    }

    this.mix = ctx.createGain();
    this.sfx = ctx.createGain();
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -9;
    this.comp.knee.value = 6;
    this.comp.ratio.value = 12;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.18;
    this.trim = ctx.createGain();
    this.trim.gain.value = 0.72;   // Blink/WebKit/Gecko compressors add make-up gain; take it back off
    this.clip = ctx.createWaveShaper();
    this.clip.curve = cc;
    this.out = ctx.createGain();
    this.out.gain.value = this.enabled ? this.volume : 0;
    this.sfx.connect(this.mix);
    this.mix.connect(this.comp);
    this.comp.connect(this.trim);
    this.trim.connect(this.clip);
    this.clip.connect(this.out);
    this.out.connect(ctx.destination);
  }

  _buildFlight(spec) {
    const ctx = this.ctx, t = ctx.currentTime;
    const nodes = [], sources = [];
    const nyq = ctx.sampleRate * 0.45;
    const G = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; nodes.push(n); return n; };
    const F = (type, freq, q = 0.707) => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = Math.min(freq, nyq); n.Q.value = q; nodes.push(n); return n;
    };
    const O = (type, freq) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq; nodes.push(o); sources.push(o); return o; };
    const SH = () => { const n = ctx.createWaveShaper(); n.curve = this.pulseCurve; nodes.push(n); return n; };
    const S = (param) => ({ p: param, v: param.value });

    const type = spec.type === 'prop' || spec.type === 'heli' ? spec.type : 'jet';
    const engines = Math.max(1, fin(spec.engines, 1) | 0);
    const f = {
      type, nodes, sources,
      hasAB: type === 'jet' && fin(spec.ab, 1) > 1, abOn: false,
      vMax: Math.max(1, fin(spec.vMax, 300)), gunRate: fin(spec.gunRate, 0.06),
      extOpen: Math.min(16000, nyq),
      warnWant: 0, warnCur: 0, warnPending: false, warnSwitchAt: 0,
    };

    const bus = G(0); bus.connect(this.mix); f.bus = bus;
    const ext = F('lowpass', f.extOpen, 0.5); ext.connect(bus); f.sExtF = S(ext.frequency);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf; noise.loop = true;
    nodes.push(noise); sources.push(noise); f.noise = noise;

    // slow random modulator (~0.6 RMS): afterburner crackle, damage sputter, runway bumps
    const modLP = F('lowpass', 22, 0.7); noise.connect(modLP);
    const mod = G(30); modLP.connect(mod);

    // engine sub-mix; damage makes its level stumble
    const eng = G(1); eng.connect(ext); f.sEng = S(eng.gain);
    const dmgDepth = G(0); mod.connect(dmgDepth); dmgDepth.connect(eng.gain); f.sDmg = S(dmgDepth.gain);

    if (type === 'jet') {
      const roarLP = F('lowpass', 260, 0.6); noise.connect(roarLP);
      const roarG = G(0); roarLP.connect(roarG); roarG.connect(eng);
      f.sRoarF = S(roarLP.frequency); f.sRoarG = S(roarG.gain);
      const hissBP = F('bandpass', 3200, 0.8); noise.connect(hissBP);
      const hissG = G(0); hissBP.connect(hissG); hissG.connect(eng); f.sHissG = S(hissG.gain);
      const whineG = G(0); whineG.connect(eng); f.sWhineG = S(whineG.gain);
      const w1 = O('sine', 1050), w2 = O('triangle', 2121);
      w1.connect(whineG); w2.connect(whineG);
      f.sW1 = S(w1.frequency); f.sW2 = S(w2.frequency);
      if (engines > 1) { const w3 = O('sine', 1062); w3.connect(whineG); f.sW3 = S(w3.frequency); }
      if (f.hasAB) {
        const abLP = F('lowpass', 420, 1.0); noise.connect(abLP);
        const abAmp = G(1); abLP.connect(abAmp);
        const abDepth = G(0.75); mod.connect(abDepth); abDepth.connect(abAmp.gain);
        const abG = G(0); abAmp.connect(abG); abG.connect(eng); f.sAbG = S(abG.gain);
      }
    } else if (type === 'prop') {
      // single big piston engines get the throaty treatment (strong sub-octave + exhaust bark)
      const throat = engines === 1 ? clamp((fin(spec.twr, 0.35) - 0.25) / 0.2, 0, 1) : 0.3;
      f.fIdle = engines > 1 ? 50 : 34;
      f.fFull = engines > 1 ? 74 : 90;
      const propLP = F('lowpass', 380, 1.4);
      const propG = G(0); propLP.connect(propG); propG.connect(eng);
      f.sPropF = S(propLP.frequency); f.sPropG = S(propG.gain);
      const p1 = O('sawtooth', f.fIdle); p1.connect(propLP); f.sP1 = S(p1.frequency);
      const p2 = O('square', f.fIdle * 0.5); const g2 = G(0.3 + 0.5 * throat); p2.connect(g2); g2.connect(propLP); f.sP2 = S(p2.frequency);
      const p3 = O('sawtooth', f.fIdle * 3.01); const g3 = G(0.28); p3.connect(g3); g3.connect(propLP); f.sP3 = S(p3.frequency);
      if (engines > 1) { const p4 = O('sawtooth', f.fIdle * 1.012); p4.connect(propLP); f.sP4 = S(p4.frequency); }
      // exhaust: noise chopped at the blade/firing rate
      const exLP = F('lowpass', 500, 0.8); noise.connect(exLP);
      const exAmp = G(0.5); exLP.connect(exAmp);
      const exDepth = G(0.3 + 0.25 * throat); p1.connect(exDepth); exDepth.connect(exAmp.gain);
      const exG = G(0); exAmp.connect(exG); exG.connect(eng);
      f.sExF = S(exLP.frequency); f.sExG = S(exG.gain);
    } else {
      // rotor: blade-pass pulse train chops low noise and a thud tone
      const rot = O('sawtooth', 16.5); f.sRot = S(rot.frequency);
      const pulse = SH(); rot.connect(pulse);
      const slapLP = F('lowpass', 380, 0.8); noise.connect(slapLP); f.sSlapF = S(slapLP.frequency);
      const slapAmp = G(0.1); slapLP.connect(slapAmp);
      const slapDepth = G(1.6); pulse.connect(slapDepth); slapDepth.connect(slapAmp.gain);
      const slapG = G(0); slapAmp.connect(slapG); slapG.connect(eng); f.sSlapG = S(slapG.gain);
      const thud = O('triangle', 62); const thudAmp = G(0); thud.connect(thudAmp);
      const thudDepth = G(0.22); pulse.connect(thudDepth); thudDepth.connect(thudAmp.gain); thudAmp.connect(slapG);
      const whineG = G(0); whineG.connect(eng); f.sWhineG = S(whineG.gain);
      const t1 = O('sine', 1900); t1.connect(whineG); f.sT1 = S(t1.frequency);
      if (engines > 1) { const t2 = O('sine', 1925); t2.connect(whineG); f.sT2 = S(t2.frequency); }
      const hissBP = F('bandpass', 2600, 0.7); noise.connect(hissBP);
      const hissG = G(0); hissBP.connect(hissG); hissG.connect(eng); f.sHissG = S(hissG.gain);
    }

    // wind + buffet wobble
    const windBP = F('bandpass', 350, 0.5); noise.connect(windBP); f.sWindF = S(windBP.frequency);
    const windAmp = G(1); windBP.connect(windAmp);
    const lfo = O('sine', 9); f.sLfo = S(lfo.frequency);
    const bufDepth = G(0); lfo.connect(bufDepth); bufDepth.connect(windAmp.gain); f.sBufDepth = S(bufDepth.gain);
    const windG = G(0); windAmp.connect(windG); windG.connect(ext); f.sWindG = S(windG.gain);
    // low rumble: buffet + ground roll
    const rumLP = F('lowpass', 190, 0.7); noise.connect(rumLP); f.sRumF = S(rumLP.frequency);
    const rumAmp = G(1); rumLP.connect(rumAmp);
    const rumDepth = G(0.5); mod.connect(rumDepth); rumDepth.connect(rumAmp.gain);
    const bufG = G(0); rumAmp.connect(bufG); bufG.connect(ext); f.sBufG = S(bufG.gain);
    const gndG = G(0); rumAmp.connect(gndG); gndG.connect(ext); f.sGndG = S(gndG.gain);
    // gear hydraulic motor
    const hyd = O('triangle', 205); const gearG = G(0); hyd.connect(gearG); gearG.connect(ext); f.sGearG = S(gearG.gain);

    // gun
    const gunOsc = O('sawtooth', 1 / clamp(f.gunRate, 0.02, 0.5)); f.sGunF = S(gunOsc.frequency);
    const gunPulse = SH(); gunOsc.connect(gunPulse);
    const heavy = f.gunRate <= 0.035;
    const gunLP = F('lowpass', heavy ? 2100 : 2900, 1.0); noise.connect(gunLP);
    const gunAmp = G(0); gunLP.connect(gunAmp);
    const gunDepth = G(2.6); gunPulse.connect(gunDepth); gunDepth.connect(gunAmp.gain);
    const gunTone = O('triangle', heavy ? 68 : 92); const thumpAmp = G(0); gunTone.connect(thumpAmp);
    const thumpDepth = G(heavy ? 0.75 : 0.55); gunPulse.connect(thumpDepth); thumpDepth.connect(thumpAmp.gain);
    const gunGate = G(0); gunAmp.connect(gunGate); thumpAmp.connect(gunGate); gunGate.connect(bus); f.sGunGate = S(gunGate.gain);

    // warning tone generator
    const wA = O('sine', 1000), wB = O('sawtooth', 1000);
    const mixA = G(0), mixB = G(0); wA.connect(mixA); wB.connect(mixB);
    const fm = O('sine', 5); const fmDepth = G(0); fm.connect(fmDepth); fmDepth.connect(wA.frequency); fmDepth.connect(wB.frequency);
    const gate = G(1); mixA.connect(gate); mixB.connect(gate);
    const am = O('square', 3); const amLP = F('lowpass', 45, 0.5); const amDepth = G(0);
    am.connect(amLP); amLP.connect(amDepth); amDepth.connect(gate.gain);
    const warnLP = F('lowpass', 3600, 0.6); gate.connect(warnLP);
    const warnG = G(0); warnLP.connect(warnG); warnG.connect(bus);
    Object.assign(f, { wA, wB, mixA, mixB, fm, fmDepth, gate, am, amDepth, warnG });

    for (let i = 0; i < sources.length; i++) {
      if (sources[i] === noise) noise.start(t, Math.random() * 3); else sources[i].start(t);
    }
    bus.gain.setTargetAtTime(this._paused ? 0 : 1, t, 0.12);
    return f;
  }

  _abThump(t) {
    this._tone(t, 0.45, 0.5, 'sine', 95, 38, 0.012);
    this._noise(t, 0.4, 1.6, 'lowpass', 700, 180, 0.8, 0.015);
  }

  /** Attack / exponential-decay envelope that ends at exactly 0. */
  _env(param, t, dur, peak, attack) {
    param.value = 0;
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(peak * 0.001, t + dur);
    param.linearRampToValueAtTime(0, t + dur + 0.02);
  }

  _finish(src, a, b, t, end) {
    this._active++;
    src.onended = () => {
      this._active--;
      try { src.disconnect(); a.disconnect(); if (b) b.disconnect(); } catch (_) { /* gone */ }
    };
    src.stop(end);
  }

  /** Filtered noise burst. Filter sweeps f0 -> f1 over the duration. */
  _noise(t, dur, peak, type, f0, f1, q, attack) {
    const ctx = this.ctx, nyq = ctx.sampleRate * 0.45;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const flt = ctx.createBiquadFilter(); flt.type = type; flt.Q.value = q;
    f0 = clamp(f0, 20, nyq); f1 = clamp(f1, 20, nyq);
    flt.frequency.value = f0;
    flt.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); this._env(g.gain, t, dur, peak, attack);
    src.connect(flt); flt.connect(g); g.connect(this.sfx);
    src.start(t, Math.random() * 3.5);
    this._finish(src, flt, g, t, t + dur + 0.03);
  }

  /** Decaying tone with a pitch sweep f0 -> f1. */
  _tone(t, dur, peak, type, f0, f1, attack) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.value = f0;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain(); this._env(g.gain, t, dur, peak, attack);
    o.connect(g); g.connect(this.sfx);
    o.start(t);
    this._finish(o, g, null, t, t + dur + 0.03);
  }

  /** Flat-topped beep. */
  _beep(t, dur, peak, type, freq) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.006);
    g.gain.setValueAtTime(peak, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g); g.connect(this.sfx);
    o.start(t);
    this._finish(o, g, null, t, t + dur + 0.01);
  }

  _explosion(t0, dist, size) {
    const t = t0 + Math.min(dist / 343, 4);            // speed-of-sound delay, capped
    const att = 1 / (1 + dist / 400);
    const cut = 200 + 5000 / (1 + dist / 250);         // air absorbs the highs
    const vol = 0.6 * Math.sqrt(size) * att;
    const b0 = Math.min(cut, 1900);
    this._noise(t, 1.1 + 0.6 * size + Math.min(1, dist / 2000), vol * 3.2, 'lowpass', b0, Math.max(50, b0 * 0.1), 0.7, 0.004 + Math.min(0.06, dist / 20000));
    this._tone(t, 0.8 * Math.sqrt(size), vol * 0.85, 'sine', 90 / Math.sqrt(size), 30, 0.008);
    if (dist < 1500) this._noise(t, 0.14, vol * 1.6 * (1 - dist / 1500), 'bandpass', 2600, 1200, 0.7, 0.003);
  }
}

// One-shot recipes: (engine, startTime, opts)
const SHOTS = {
  missile(a, t) {
    a._tone(t, 0.12, 0.3, 'triangle', 150, 60, 0.004);                 // rail release
    a._noise(t, 0.14, 0.35, 'highpass', 2500, 2500, 0.7, 0.004);       // ignition spit
    a._noise(t, 1.6, 1.1, 'bandpass', 1900, 480, 0.8, 0.05);           // whoosh receding
    a._noise(t, 1.1, 1.6, 'lowpass', 520, 140, 0.7, 0.04);             // motor roar
  },
  flare(a, t) {
    a._tone(t, 0.09, 0.25, 'sine', 260, 90, 0.003);
    a._noise(t, 0.3, 0.55, 'bandpass', 3500, 1500, 1.0, 0.003);
    a._noise(t, 0.6, 0.09, 'highpass', 5000, 5000, 0.7, 0.05);
  },
  explosion(a, t, o) {
    a._explosion(t, Math.max(0, fin(o.dist, 0)), clamp(fin(o.size, 1), 0.5, 3));
  },
  hit(a, t) {
    a._noise(t, 0.09, 2.2, 'bandpass', 1400 + Math.random() * 900, 900, 4, 0.002);
    a._tone(t, 0.09, 0.22, 'square', 170 + Math.random() * 50, 85, 0.003);
  },
  hitmark(a, t) {
    a._tone(t, 0.045, 0.07, 'sine', 2100, 1700, 0.003);
  },
  touchdown(a, t, o) {
    const h = clamp(fin(o.hard, 0.3), 0, 1);
    a._noise(t, 0.24, 0.9 + 1.7 * h, 'bandpass', 2900, 1400, 5, 0.004);   // tyre chirp
    a._tone(t, 0.26, 0.28 + 0.5 * h, 'sine', 78, 38, 0.006);              // thump
    a._noise(t, 0.3, 1.0 + 2.2 * h, 'lowpass', 260, 90, 0.7, 0.006);
  },
  gear(a, t) {
    a._tone(t, 0.16, 0.4, 'triangle', 125, 55, 0.004);
    a._noise(t, 0.08, 1.1, 'bandpass', 700, 500, 2, 0.003);
    a._noise(t + 0.06, 0.05, 0.4, 'bandpass', 1600, 1200, 3, 0.003);
  },
  crash(a, t) {
    a._explosion(t, 0, 2);
    a._noise(t, 0.9, 1.6, 'bandpass', 950, 300, 1.5, 0.004);              // structure crunch
    a._noise(t + 0.05, 0.55, 0.25, 'highpass', 3000, 3000, 0.7, 0.01);    // debris
    a._tone(t, 0.35, 0.3, 'square', 140, 48, 0.004);
  },
  click(a, t) {
    a._tone(t, 0.04, 0.13, 'sine', 1400, 1000, 0.003);
  },
  rearm(a, t) {
    for (let i = 0; i < 3; i++) a._noise(t + i * 0.07, 0.035, 0.9, 'bandpass', 3000, 2200, 2, 0.002);
    a._beep(t + 0.24, 0.09, 0.1, 'sine', 660);
    a._beep(t + 0.34, 0.13, 0.1, 'sine', 990);
  },
  warn(a, t) {
    a._beep(t, 0.22, 0.16, 'triangle', 1000);
  },
  splash(a, t) {
    a._noise(t, 0.5, 2.0, 'lowpass', 320, 80, 0.7, 0.008);
    a._noise(t, 1.1, 1.2, 'bandpass', 1500, 350, 0.6, 0.02);
    a._noise(t, 0.7, 0.16, 'highpass', 4000, 4000, 0.7, 0.08);
  },
};
