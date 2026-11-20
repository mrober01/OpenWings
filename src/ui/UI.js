// UI.js — menus (hangar, pause, debrief), toasts, and all input:
// keyboard, mouse, touch (floating stick / throttle / buttons / drag-to-look) and gamepad.
// The in-flight symbology is NOT here — that is the canvas HUD (ui/Hud.js).
import { clamp } from '../engine/utils.js';
import { AIRCRAFT_SPECS, PLAYABLE } from '../aircraft/AircraftSpecs.js';
import { MISSIONS, MISSION_ORDER, missionBlurb } from '../engine/Missions.js';
import { getMap } from '../world/Maps.js';
import { OPTIONS } from '../engine/Settings.js';
import { AB_DETENT } from '../engine/FlightModel.js';

const MENU_OPTIONS = ['map', 'start', 'tod', 'difficulty', 'assist', 'quality', 'sensitivity', 'invertY', 'tilt', 'sound', 'haptics'];
const STICK_R = 58;
const expo = (v) => v * (0.4 + 0.6 * v * v);

export class UI {
  constructor(game, settings, audio) {
    this.game = game; this.settings = settings; this.audio = audio;
    this.keys = {};
    this.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    this.touchActive = false;         // touch controls on screen (read by the HUD layout)
    this.stick = { x: 0, y: 0, on: false };
    this.mouse = { dx: 0, dy: 0, fire: false, locked: false };
    this.lookD = { dx: 0, dy: 0 };
    this._look = { dx: 0, dy: 0 };
    this.throttle = 0;
    this.touchFire = false; this.touchBrake = false;
    this.pad = { fire: false, brake: false, prev: [] };
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false, fire: false };
    this.aircraft = PLAYABLE.includes(settings.get('aircraft')) ? settings.get('aircraft') : 'ef2000';
    this.mission = MISSIONS[settings.get('mission')] ? settings.get('mission') : 'free';

    this.initMenus();
    this.initKeyboardMouse();
    this.initTouch();
    audio.setVolume(settings.get('sound'));
    settings.onChange((k, v) => { if (k === 'sound') audio.setVolume(v); });
  }

  $(id) { return document.getElementById(id); }

  /* ================================================================ menus */

  initMenus() {
    const mk = (parent, cls, html, fn) => {
      const el = document.createElement('button');
      el.className = cls; el.innerHTML = html;
      el.addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); fn(el); });
      parent.appendChild(el);
      return el;
    };

    this.aircraftCards = {};
    for (const key of PLAYABLE) {
      const s = AIRCRAFT_SPECS[key], st = s.stats || {};
      const bar = (n, v) => `<span class="stat"><i>${n}</i><b style="width:${Math.round((v || 0) * 0.42)}px"></b></span>`;
      this.aircraftCards[key] = mk(this.$('aircraft-cards'), 'card',
        `<h3>${s.short || s.name}</h3><div class="sub">${s.name}</div><div class="sub dim">${s.role}</div>` +
        `<div class="stats">${bar('SPD', st.speed)}${bar('AGI', st.agility)}${bar('ARM', st.armor)}${bar('PWR', st.firepower)}</div>`,
        () => this.selectAircraft(key));
    }
    this.missionCards = {};
    for (const key of MISSION_ORDER) {
      const m = MISSIONS[key];
      this.missionCards[key] = mk(this.$('mission-cards'), 'card',
        `<h3>${m.title}</h3><div class="sub" data-blurb="${key}"></div><div class="best" data-best="${key}"></div>`,
        () => this.selectMission(key));
    }
    this.optPaint = {};
    for (const k of MENU_OPTIONS) {
      if (k === 'tilt' && !this.isTouch) continue;
      const el = mk(this.$('options'), 'opt', '', () => {
        this.settings.cycle(k); paint(); this.refreshBest();
        if (k === 'map') { this.optPaint.start(); this.refreshBlurbs(); }
        if (k === 'tod' || k === 'quality' || k === 'map') this.game.showcase(this.aircraft);
      });
      const paint = () => { el.innerHTML = `<i>${OPTIONS[k].label}</i><b>${this.optName(k)}</b>`; };
      paint();
      this.optPaint[k] = paint;
      if (k === 'start') this.startOpt = el;
    }
    this.selectAircraft(this.aircraft);
    this.selectMission(this.mission);
    this.refreshBlurbs();

    this.$('menu-help').innerHTML = this.isTouch
      ? `<b>Left thumb</b> flies (pull down = nose up) · <b>right slider</b> is the throttle, top = afterburner · drag the sky to look around · ` +
        `<b>TGT</b> picks a target, hold it in front until the diamond closes, then <b>MSL</b> · stop on a runway to rearm · ` +
        `<b>LATCH</b> + <b>MSL</b> = missile motor stays on the rail as a rocket boost · <b>hold LATCH</b> (latches locked) = override the motor burn limiter: long burns, scorched wing, enough to reach space · <b>EJECT</b> twice to bail out`
      : `<b>W/S</b> pitch · <b>A/D</b> roll · <b>Q/E</b> rudder · <b>Shift/Ctrl</b> throttle (1-5 presets, 5 = afterburner) · <b>Space</b> gun · ` +
        `<b>X</b> missile · <b>F</b> flares · <b>T</b> target · <b>G</b> gear · <b>B</b> brake · <b>V</b> view · <b>C</b> (hold) look at panel · <b>N</b> nav · <b>H</b> lock pylon latches (then <b>X</b> = rocket boost) · <b>hold H</b> = burn-limiter override (long burns, enough to reach space) · <b>J J</b> eject · right-drag look · <b>Esc</b> pause · gamepad supported`;

    const on = (id, fn) => this.$(id).addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); fn(); });
    on('btn-fly', () => this.fly());
    on('btn-resume', () => this.resume());
    on('btn-restart', () => this.fly());
    on('btn-hangar', () => this.toMenu());
    on('btn-end-restart', () => this.fly());
    on('btn-end-hangar', () => this.toMenu());
    on('btn-pause', () => this.pauseGame());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.pauseGame(); });
  }

  selectAircraft(key) {
    this.aircraft = key; this.settings.set('aircraft', key);
    for (const [k, c] of Object.entries(this.aircraftCards)) c.classList.toggle('selected', k === key);
    if (this.game.state === 'menu' && this._menuUp) this.game.showcase(key);
  }

  selectMission(key) {
    this.mission = key; this.settings.set('mission', key);
    for (const [k, c] of Object.entries(this.missionCards)) c.classList.toggle('selected', k === key);
    if (this.startOpt) this.startOpt.classList.toggle('hidden', key !== 'free');
    this.refreshBest();
  }

  /** Option label; the free-flight start names the current map's airfields / city. */
  optName(k) {
    if (k !== 'start') return this.settings.name(k);
    const m = getMap(this.settings.get('map'));
    const i = OPTIONS.start.values.indexOf(this.settings.get('start'));
    return i === 3 ? `AIRBORNE · OVER ${m.city}` : m.fields[Math.max(0, i)];
  }

  refreshBlurbs() {
    for (const el of document.querySelectorAll('[data-blurb]')) el.textContent = missionBlurb(el.dataset.blurb, this.settings.get('map'));
  }

  refreshBest() {
    for (const el of document.querySelectorAll('[data-best]')) {
      const b = this.settings.best(el.dataset.best);
      el.textContent = b ? `BEST ${b}` : '';
    }
  }

  show(id, on) { this.$(id).classList.toggle('hidden', !on); }

  showMenu() {
    this.show('menu', true); this.show('pause', false); this.show('endscreen', false);
    this.setFlightUi(false);
    this.refreshBest();
    this._menuUp = true;
    this.game.showcase(this.aircraft);
  }

  hideMenu() { this.show('menu', false); }

  fly() {
    this.audio.unlock();
    this.show('menu', false); this.show('pause', false); this.show('endscreen', false);
    this.goImmersive();
    if (this.isTouch && this.settings.get('tilt')) this.initTilt();
    this.calibrateTilt();
    this._menuUp = false;
    this.game.startMission(this.mission, this.aircraft);
  }

  /** Fullscreen + landscape + keep the screen awake (phones). Every call is best-effort. */
  goImmersive() {
    if (!this.isTouch) return;
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen({ navigationUI: 'hide' }).then(() => {
          if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
        }).catch(() => {});
      }
      if (navigator.wakeLock && !this._wake) {
        navigator.wakeLock.request('screen').then(w => { this._wake = w; w.addEventListener('release', () => { this._wake = null; }); }).catch(() => {});
      }
    } catch { /* not allowed here */ }
  }

  onGameStart(player) {
    this.throttle = player.fm.throttle;
    this.stick.on = false; this.stick.x = 0; this.stick.y = 0;
    this.touchFire = false; this.touchBrake = false;
    this.lookD.dx = 0; this.lookD.dy = 0;
    this.setFlightUi(true);
    this.paintThrottle();
    const s = player.spec;
    this.show('btn-msl', s.missileCount > 0); this.show('btn-fire', s.gunAmmo > 0);
    this.show('btn-flare', s.flares > 0); this.show('btn-gear', s.gearH > 0);
    this.show('btn-latch', s.missileCount > 0); this.show('btn-eject', s.cockpit !== 'airliner');
  }

  setFlightUi(on) {
    this.touchActive = on && this.isTouch;
    this.show('touch-ui', this.touchActive);
    this.show('btn-pause', on);
  }

  togglePause() {
    if (this.game.state === 'playing') this.pauseGame();
    else if (this.game.state === 'paused') this.resume();
  }

  pauseGame() {
    const g = this.game;
    if (g.state !== 'playing') return;
    g.pause();
    this.setFlightUi(false);
    this.$('pause-stats').innerHTML = `${MISSIONS[g.mode].title}<br>SCORE <b>${g.score}</b> · KILLS <b>${g.kills}</b>` + (g.wave ? ` · WAVE <b>${g.wave}</b>` : '');
    this.show('pause', true);
    if (document.exitPointerLock) document.exitPointerLock();
  }

  resume() { this.show('pause', false); this.setFlightUi(true); this.calibrateTilt(); this.game.resume(); }

  toMenu() { this.game.toMenu(); this.showMenu(); }

  showDebrief(r) {
    this.setFlightUi(false);
    if (document.exitPointerLock) document.exitPointerLock();
    const t = this.$('end-title');
    t.textContent = r.title; t.className = r.won ? 'won' : 'lost';
    this.$('end-stats').innerHTML =
      (r.detail ? `<p>${r.detail}</p>` : '') +
      `SCORE <b>${r.score}</b> · KILLS <b>${r.kills}</b>` + (r.wave ? ` · WAVE <b>${r.wave}</b>` : '') +
      `<br>${r.newBest ? '<span class="newbest">★ NEW BEST ★</span>' : r.best ? `BEST <b>${r.best}</b>` : ''}`;
    this.show('endscreen', true);
  }

  toast(msg, kind = '') {
    const t = this.$('toast');
    t.textContent = msg; t.className = 'show ' + kind;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.className = kind; }, 2600);
  }

  damageFlash() {
    const v = this.$('damage-vignette');
    v.style.opacity = 1;
    clearTimeout(this._dmgT);
    this._dmgT = setTimeout(() => { v.style.opacity = 0; }, 160);
  }

  /* ================================================================ keyboard + mouse */

  initKeyboardMouse() {
    document.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys[e.code] = true;
      const g = this.game;
      if (e.code === 'Escape' || e.code === 'KeyP') { this.togglePause(); return; }
      if (e.code === 'Enter' && g.state === 'menu') { this.fly(); return; }
      if (g.state !== 'playing') return;
      switch (e.code) {
        case 'KeyV': g.cycleView(); break;
        case 'KeyG': g.toggleGear(); break;
        case 'KeyF': g.dropFlare(); break;
        case 'KeyX': g.fireMissile(); break;
        case 'KeyT': case 'Tab': g.cycleTarget(); e.preventDefault(); break;
        case 'KeyN': g.cycleNav(); break;
        case 'KeyJ': g.eject(); break;
        case 'KeyH': g.latchPress(); break;
        case 'Space': e.preventDefault(); break;
        default:
      }
    });
    document.addEventListener('keyup', (e) => { this.keys[e.code] = false; if (e.code === 'KeyH') this.game.latchRelease(); });
    window.addEventListener('blur', () => { this.keys = {}; this.mouse.fire = false; });

    // click the view to capture the mouse as a stick; right-drag looks around
    const canvas = this.$('hud-canvas');
    let rdrag = false;
    canvas.addEventListener('mousedown', (e) => {
      if (this.game.state !== 'playing') return;
      if (e.button === 2) { rdrag = true; return; }
      if (e.button !== 0) return;
      if (!this.mouse.locked && !this.isTouch && canvas.requestPointerLock) canvas.requestPointerLock();
      else this.mouse.fire = true;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => { this.mouse.locked = document.pointerLockElement === canvas; });
    document.addEventListener('mousemove', (e) => {
      if (rdrag) { this.lookD.dx += e.movementX; this.lookD.dy += e.movementY; }
      else if (this.mouse.locked) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
    });
    document.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.fire = false; if (e.button === 2) rdrag = false; });
  }

  /* ================================================================ touch */

  initTouch() {
    const game = this.game;
    const opts = { passive: false };

    // ---- floating stick: appears where the left thumb lands ----
    const zone = this.$('stick-zone'), base = this.$('stick-base'), nub = this.$('stick-nub');
    let sid = null, ox = 0, oy = 0;
    const place = (x, y) => { base.style.left = x + 'px'; base.style.top = y + 'px'; };
    const home = () => {
      const r = zone.getBoundingClientRect();
      place(r.left + Math.min(110, r.width / 2), r.bottom - 100);
      nub.style.transform = 'translate(-50%,-50%)';
      base.classList.remove('active');
    };
    this._stickHome = home;
    zone.addEventListener('touchstart', (e) => {
      e.preventDefault();
      if (sid !== null) return;
      const t = e.changedTouches[0];
      sid = t.identifier; ox = t.clientX; oy = t.clientY;
      place(ox, oy); base.classList.add('active');
      this.stick.on = true; this.stick.x = 0; this.stick.y = 0;
    }, opts);
    zone.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== sid) continue;
        let dx = t.clientX - ox, dy = t.clientY - oy;
        const len = Math.hypot(dx, dy);
        if (len > STICK_R) {
          // the base trails the thumb so you never run out of travel
          ox += dx * (1 - STICK_R / len); oy += dy * (1 - STICK_R / len);
          place(ox, oy);
          dx *= STICK_R / len; dy *= STICK_R / len;
        }
        this.stick.x = dx / STICK_R; this.stick.y = dy / STICK_R;
        nub.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      }
    }, opts);
    const endStick = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== sid) continue;
        sid = null; this.stick.on = false; this.stick.x = 0; this.stick.y = 0;
        home();
      }
    };
    zone.addEventListener('touchend', endStick);
    zone.addEventListener('touchcancel', endStick);

    // ---- throttle slider (absolute) ----
    const tz = this.$('throttle-zone'), track = this.$('throttle-track');
    let tid = null;
    const setThr = (y) => {
      const r = track.getBoundingClientRect();
      let v = 1 - clamp((y - r.top) / r.height, 0, 1);
      // a little stickiness just below the afterburner detent
      if (this.hasAB() && v > AB_DETENT - 0.05 && v <= AB_DETENT + 0.03) v = AB_DETENT - 0.01;
      this.throttle = v;
      this.paintThrottle();
    };
    tz.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; tid = t.identifier; setThr(t.clientY); }, opts);
    tz.addEventListener('touchmove', (e) => { e.preventDefault(); for (const t of e.changedTouches) if (t.identifier === tid) setThr(t.clientY); }, opts);
    const endThr = (e) => { for (const t of e.changedTouches) if (t.identifier === tid) tid = null; };
    tz.addEventListener('touchend', endThr); tz.addEventListener('touchcancel', endThr);

    // ---- drag anywhere else to look around ----
    const lz = this.$('look-zone');
    let lid = null, lx = 0, ly = 0;
    lz.addEventListener('touchstart', (e) => { e.preventDefault(); if (lid !== null) return; const t = e.changedTouches[0]; lid = t.identifier; lx = t.clientX; ly = t.clientY; }, opts);
    lz.addEventListener('touchmove', (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== lid) continue;
        this.lookD.dx += t.clientX - lx; this.lookD.dy += t.clientY - ly;
        lx = t.clientX; ly = t.clientY;
      }
    }, opts);
    const endLook = (e) => { for (const t of e.changedTouches) if (t.identifier === lid) lid = null; };
    lz.addEventListener('touchend', endLook); lz.addEventListener('touchcancel', endLook);

    // ---- buttons ----
    const tap = (id, fn) => this.$(id).addEventListener('touchstart', (e) => { e.preventDefault(); fn(); }, opts);
    const hold = (id, set) => {
      const el = this.$(id);
      el.addEventListener('touchstart', (e) => { e.preventDefault(); set(true); el.classList.add('down'); }, opts);
      const up = (e) => { e.preventDefault(); set(false); el.classList.remove('down'); };
      el.addEventListener('touchend', up, opts); el.addEventListener('touchcancel', up, opts);
    };
    hold('btn-fire', (v) => { this.touchFire = v; });
    hold('btn-brake', (v) => { this.touchBrake = v; });
    tap('btn-msl', () => game.fireMissile());
    tap('btn-flare', () => game.dropFlare());
    tap('btn-tgt', () => game.cycleTarget());
    tap('btn-gear', () => game.toggleGear());
    tap('btn-view', () => game.cycleView());
    tap('btn-nav', () => game.cycleNav());
    tap('btn-eject', () => game.eject());
    // LATCH: tap = pylon latches, hold ~1.5 s = lift the guard and override the motor burn limiter
    hold('btn-latch', (v) => { if (v) game.latchPress(); else game.latchRelease(); });
    window.addEventListener('resize', () => { if (sid === null) home(); this.paintThrottle(); });
  }

  /* ================================================================ tilt-to-fly */
  // Uses gravity in the device frame, so it works however the phone is held:
  // roll = sideways lean of the screen, pitch = fore/aft tilt relative to the
  // attitude at calibration (mission start / resume). UNTESTED on real hardware.
  initTilt() {
    if (this._tiltInit) return;
    this._tiltInit = true;
    this.tilt = { roll: 0, pitch: 0, zero: null, live: false };
    const start = () => window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
      // screen-up / screen-right components of the measured gravity reaction
      let up, right;
      if (ang === 90) { up = a.x; right = -a.y; } else if (ang === 270 || ang === -90) { up = -a.x; right = a.y; } else { up = a.y; right = a.x; }
      let out = a.z;
      if (up < 0 && Math.abs(up) > Math.abs(out)) { up = -up; right = -right; out = -out; }   // iOS reports the opposite sign
      const t = this.tilt;
      const roll = Math.atan2(-right, Math.hypot(up, out)), pitch = Math.atan2(out, up);
      if (t.zero == null) t.zero = pitch;
      t.roll += (clamp(roll / 0.45, -1, 1) - t.roll) * 0.35;
      t.pitch += (clamp((pitch - t.zero) / 0.32, -1, 1) - t.pitch) * 0.35;
      t.live = true;
    });
    try {
      const D = window.DeviceMotionEvent;
      if (D && typeof D.requestPermission === 'function') D.requestPermission().then(r => { if (r === 'granted') start(); }).catch(() => {});
      else start();
    } catch { /* no sensors */ }
  }

  calibrateTilt() { if (this.tilt) { this.tilt.zero = null; this.tilt.roll = 0; this.tilt.pitch = 0; } }

  hasAB() { const p = this.game.player; return !!p && p.spec.ab > 1; }

  paintThrottle() {
    if (!this.touchActive) return;
    const knob = this.$('throttle-knob'), track = this.$('throttle-track');
    const h = track.clientHeight || 1;
    knob.style.top = `${(1 - this.throttle) * h}px`;
    const ab = this.hasAB();
    this.$('ab-mark').style.display = ab ? '' : 'none';
    knob.classList.toggle('ab', ab && this.throttle > AB_DETENT + 0.02);
    if (this._stickHome && !this.stick.on) this._stickHome();
  }

  /* ================================================================ per-frame */

  consumeLook() {
    const l = this._look;
    l.dx = this.lookD.dx; l.dy = this.lookD.dy;
    this.lookD.dx = 0; this.lookD.dy = 0;
    return l;
  }

  getInput() {
    const k = this.keys, inp = this.input, s = this.settings;
    const sens = s.get('sensitivity'), inv = s.get('invertY') ? -1 : 1;
    let pitch = 0, roll = 0, yaw = 0, fire = !!k.Space || this.mouse.fire || this.touchFire, brake = !!k.KeyB || this.touchBrake;

    // keyboard: S / down-arrow pulls, like a real stick
    if (k.KeyS || k.ArrowDown) pitch += 1;
    if (k.KeyW || k.ArrowUp) pitch -= 1;
    if (k.KeyA || k.ArrowLeft) roll -= 1;
    if (k.KeyD || k.ArrowRight) roll += 1;
    if (k.KeyQ) yaw -= 1;
    if (k.KeyE) yaw += 1;
    if (k.ShiftLeft || k.ShiftRight || k.Equal) this.throttle += 0.012;
    if (k.ControlLeft || k.ControlRight || k.Minus) this.throttle -= 0.012;
    if (k.Digit1) this.throttle = 0; if (k.Digit2) this.throttle = 0.4; if (k.Digit3) this.throttle = 0.7;
    if (k.Digit4) this.throttle = AB_DETENT - 0.01; if (k.Digit5) this.throttle = 1;

    if (this.mouse.locked) {
      pitch += this.mouse.dy * 0.012 * inv * sens;
      roll += this.mouse.dx * 0.012 * sens;
    }
    this.mouse.dx = 0; this.mouse.dy = 0;

    if (this.stick.on) {
      const m = Math.min(1, sens);          // "soft" shortens the throw, "sharp" removes the expo
      const f = sens > 1 ? (v) => v : expo;
      pitch += f(this.stick.y) * inv * m;   // pull DOWN = nose UP by default
      roll += f(this.stick.x) * m;
    }

    if (this.tilt && this.tilt.live && s.get('tilt') && !this.stick.on) {
      pitch += expo(this.tilt.pitch) * inv * sens;
      roll += expo(this.tilt.roll) * sens;
    }

    // gamepad (standard mapping)
    const pads = navigator.getGamepads ? navigator.getGamepads() : null;
    const gp = pads && (pads[0] || pads[1]);
    if (gp && gp.connected) {
      const dz = (v) => (Math.abs(v) < 0.12 ? 0 : (v - Math.sign(v) * 0.12) / 0.88);
      const ax = gp.axes, b = gp.buttons, on = (i) => !!(b[i] && b[i].pressed), g = this.game, pv = this.pad.prev;
      roll += expo(dz(ax[0] || 0)) * sens; pitch += expo(dz(ax[1] || 0)) * inv * sens;
      this.lookD.dx += dz(ax[2] || 0) * 9; this.lookD.dy += dz(ax[3] || 0) * 9;
      const rt = b[7] ? b[7].value : 0, lt = b[6] ? b[6].value : 0;
      if (rt > 0.3 || on(0)) fire = true;
      if (lt > 0.3) brake = true;
      if (on(5)) this.throttle += 0.012;
      if (on(4)) this.throttle -= 0.012;
      yaw += (on(15) ? 1 : 0) - (on(14) ? 1 : 0);
      const edge = (i, fn) => { const d = on(i); if (d && !pv[i]) fn(); pv[i] = d; };
      edge(1, () => g.fireMissile()); edge(2, () => g.dropFlare()); edge(3, () => g.cycleTarget());
      edge(12, () => g.cycleView()); edge(13, () => g.toggleGear()); edge(9, () => this.togglePause());
      edge(11, () => g.eject());
      { const d = on(10); if (d && !pv[10]) g.latchPress(); else if (!d && pv[10]) g.latchRelease(); pv[10] = d; }   // L3: tap / hold like LATCH
    }

    const t0 = this.throttle;
    this.throttle = clamp(this.throttle, 0, 1);
    if (t0 !== inp.throttle) this.paintThrottle();
    inp.pitch = clamp(pitch, -1, 1); inp.roll = clamp(roll, -1, 1); inp.yaw = clamp(yaw, -1, 1);
    inp.throttle = this.throttle; inp.fire = fire; inp.brake = brake;
    return inp;
  }
}
