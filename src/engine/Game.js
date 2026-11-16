// Game.js — state machine + per-frame orchestration.
//   units (Entities) · Weapons · Effects · Missions · CameraRig · Hud · Audio
// Contracts with those modules are in docs/INTERFACES.md. Missions drive the
// game through the "mission API" section below (placePlayer, spawnAir, ...).
import * as THREE from 'three';
import { Environment } from '../world/Environment.js';
import { WORLD_SIZE } from '../world/Heightfield.js';
import { Weapons, MISSILE, leadSolution } from './Weapons.js';
import { Effects } from './Effects.js';
import { makeAircraft, makeGround, wreckGround } from './Entities.js';
import { buildAircraft } from '../aircraft/AircraftFactory.js';
import { MISSIONS, DIFFICULTY } from './Missions.js';
import { CameraRig, VIEW_NAMES } from './CameraRig.js';
import { Hud } from '../ui/Hud.js';
import { Cockpit } from '../aircraft/Cockpit.js';
import { AIPilot } from './AIPilot.js';
import { clamp } from './utils.js';

const G = 9.81, TAU = Math.PI * 2;
const GUN_RANGE = 1500;
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _e = new THREE.Euler();
const gi = { y: 0, water: false, runway: false, slope: 0 };
const _nearB = [];
const NEUTRAL = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, brake: false, fire: false };
const CRASH_TEXT = {
  water: 'DITCHED IN THE SEA', gear: 'GEAR-UP LANDING', impact: 'HIT THE GROUND TOO HARD',
  attitude: 'BAD LANDING ATTITUDE', terrain: 'FLEW INTO TERRAIN',
};

export class Game {
  constructor(engine, settings, audio) {
    this.engine = engine; this.settings = settings; this.audio = audio; this.ui = null;
    this.scene = engine.scene;
    this.effects = new Effects(this.scene);
    this.weapons = null;
    this.hud = new Hud(document.getElementById('hud-canvas'));
    this.cam = new CameraRig(engine.camera);
    this.env = null; this._envKey = '';

    this.state = 'menu';          // menu | playing | paused | ended
    this.mode = 'free'; this.mission = null; this.diff = DIFFICULTY.normal;
    this.units = []; this.player = null;
    this.time = 0; this.score = 0; this.kills = 0; this.wave = 0;
    this.hostilesLeft = 0; this.primaryLeft = 0;
    this.waypoint = null; this.navField = null; this._ilsSgn = 1;
    this.target = null; this.lock = 0;
    this.result = null; this.endT = 0;
    this.radarRange = 12000;
    this.gloc = 0; this._rearm = 0; this._gearWarned = 0;
    this.threats = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.hs = this.makeHudState();
    this.as = {};                 // audio state (reused)
    this.frameMs = 16; this.resT = 0;

    engine.onResize(() => this.hud.resize());
    this.onHit = this.onHit.bind(this);
    this.onExplode = this.onExplode.bind(this);
    this.loop = this.loop.bind(this);
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  /* ================================================================ lifecycle */

  startMission(mode, aircraftKey) {
    const s = this.settings;
    this.mode = MISSIONS[mode] ? mode : 'free';
    this.diff = DIFFICULTY[s.get('difficulty')] || DIFFICULTY.normal;

    this.ensureEnv();
    this.clearShowcase();
    this.env.resetBuildings();

    for (const u of this.units) this.removeObj(u);
    this.units.length = 0;
    this.weapons.reset();
    this.effects.clear();

    this.time = 0; this.score = 0; this.kills = 0; this.wave = 0;
    this.waypoint = null; this.navField = null; this.target = null; this.lock = 0;
    this.result = null; this.endT = 0; this.gloc = 0; this._rearm = 0;

    const p = makeAircraft(aircraftKey, 0, { player: true, assist: s.get('assist') });
    this.player = p;
    this.scene.add(p.obj);
    this.units.push(p);

    if (this.cockpit) this.cockpit.dispose();
    this.cockpit = new Cockpit(p.spec);
    this.engine.setCockpit(this.cockpit.group, this.env);

    this.mission = MISSIONS[this.mode].create(this);
    this.count();

    this.cam.reset();
    if (this.cam.view === 'orbit' || this.cam.view === 'flyby') this.cam.setView('chase');
    this.state = 'playing';
    this.lastTime = performance.now();
    this.audio.startFlight(p.spec);
    this.audio.resume();
    if (this.ui) this.ui.onGameStart(p);
    this.say(`${MISSIONS[this.mode].title} · ${p.spec.name.toUpperCase()}`, 'good');
  }

  /** (Re)build the world only when quality, time of day or map changed. */
  ensureEnv() {
    const s = this.settings;
    let q = s.get('quality');
    this.autoRes = q === 'auto';
    if (q === 'auto') q = 'med';
    const tod = s.get('tod'), map = s.get('map'), envKey = q + ':' + tod + ':' + map;
    if (!this.env || this._envKey !== envKey) {
      if (this.env) this.env.dispose();
      this.engine.applyQuality(q);
      this.env = new Environment(this.engine, { time: tod, map });
      this._envKey = envKey;
      this.effects.setAtmosphere(this.env);
      if (this.engine.post) this.engine.post.setGrade(this.env.atmo);
      this.buildMap();
    }
    if (!this.weapons) {
      this.weapons = new Weapons(this.scene, this.effects, this.env);
      this.weapons.onHit = this.onHit; this.weapons.onExplode = this.onExplode;
      this.weapons.onStructure = (b, dmg) => this.damageStructure(b, dmg, null);
    }
    this.weapons.env = this.env;
  }

  /* ---- hangar: the selected aircraft cruising over the home field behind the menu ---- */
  showcase(key) {
    this.ensureEnv();
    for (const u of this.units) this.removeObj(u);
    this.units.length = 0; this.player = null;
    this.weapons.reset(); this.effects.clear(); this.effects.beginShadows(); this.effects.endShadows();
    this.engine.pitOn = false;
    this.clearShowcase();
    const a = this.env.airfields[0], m = buildAircraft(key, { team: 0, lod: 'full' });
    m.position.set(a.x - a.dirZ * 500, a.y + 260, a.z + a.dirX * 500);
    m.quaternion.setFromEuler(_e.set(0.04, -a.heading, -0.12));
    this.scene.add(m);
    this.show = { mesh: m, t: 0, anim: { time: 0, gearPos: 0, thrEff: 0.8, ab: false, pitch: 0, roll: 0, yaw: 0, airbrake: 0, speed: 200, night: !!this.env.atmo.night } };
  }

  clearShowcase() {
    if (!this.show) return;
    this.scene.remove(this.show.mesh);
    this.show = null;
  }

  updateShowcase(dt) {
    const sh = this.show, m = sh.mesh, cam = this.engine.camera, R = m.userData.radius;
    sh.t += dt; sh.anim.time = sh.t;
    m.userData.update(dt, sh.anim);
    const ang = sh.t * 0.22 + 2.4, d = R * 2.1 + 7;
    // aircraft sits right of centre on wide screens so the cards do not cover it
    cam.position.set(m.position.x + Math.sin(ang) * d, m.position.y + R * 0.35 + 1.5, m.position.z + Math.cos(ang) * d);
    cam.up.set(0, 1, 0);
    cam.lookAt(m.position);
    if (cam.fov !== 50) { cam.fov = 50; cam.updateProjectionMatrix(); }
    this.effects.update(dt);
    this.env.update(dt, cam.position);
  }

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused'; this.audio.suspend();
  }

  resume() {
    if (this.state !== 'paused') return;
    this.state = 'playing'; this.lastTime = performance.now(); this.audio.resume();
  }

  toMenu() {
    this.state = 'menu';
    this.audio.stopFlight();
    this.hud.clear();
    this.cam.fov = 0;   // force the rig to restore its FOV after the hangar camera
  }

  removeObj(u) {
    if (!u.obj) return;
    this.scene.remove(u.obj);
    if (u.obj.userData.dispose) u.obj.userData.dispose();
  }

  /* ================================================================ mission API */

  v3(x, y, z) { return new THREE.Vector3(x, y, z); }
  say(msg, kind = '') { if (this.ui) this.ui.toast(msg, kind); }
  playerHeading() { return heading(this.player.obj.quaternion); }

  placePlayer(o) {
    const p = this.player, s = p.spec, fm = p.fm, obj = p.obj;
    let hdg = o.heading || 0;
    if (o.airfield) {
      const a = o.airfield, s0 = -a.length / 2 + 120;
      hdg = a.heading;
      obj.position.set(a.x + a.dirX * s0, a.y + 0.3 + s.bellyH + s.gearH, a.z + a.dirZ * s0);
      obj.quaternion.setFromEuler(_e.set(0, -hdg, 0));
      this.navField = a;
      return;
    }
    let speed = s.type === 'heli' ? 30 : clamp(s.vStall * 2.4, 90, s.vMax * 0.8);
    if (o.final) {
      const a = o.final, d = a.length / 2 + o.dist;
      hdg = a.heading;
      obj.position.set(a.x - a.dirX * d, a.y + o.alt, a.z - a.dirZ * d);
      speed = s.type === 'heli' ? 40 : s.vStall * 1.7;
    } else {
      obj.position.set(o.x, Math.max(o.y, this.env.groundHeight(o.x, o.z) + 300), o.z);
    }
    obj.quaternion.setFromEuler(_e.set(0, -hdg, 0));
    fm.setAirborne(obj, speed);
    if (o.final) { fm.throttle = 0.45; fm.thrEff = 0.45; }
  }

  spawnAir(key, team, o = {}) {
    const ai = { skill: this.diff.skill, ...(o.ai || {}) };
    const u = makeAircraft(key, team, { ai, score: o.score, primary: o.primary, turret: o.turret });
    const y = Math.max(o.y ?? 2000, this.env.groundHeight(o.x, o.z) + 250);
    u.obj.position.set(o.x, y, o.z);
    u.obj.quaternion.setFromEuler(_e.set(0, -(o.heading || 0), 0));
    u.fm.setAirborne(u.obj, o.speed ?? clamp(u.spec.vStall * 2.3, 60, u.spec.vMax * 0.75));
    this.scene.add(u.obj);
    this.units.push(u);
    return u;
  }

  spawnGround(type, team, x, z, opts = {}) {
    const u = makeGround(type, team, x, z, this.env, opts);
    this.scene.add(u.obj);
    this.units.push(u);
    return u;
  }

  addScore(n, label) {
    if (this.result) return;
    this.score = Math.max(0, this.score + Math.round(n));
    if (label) this.say(`${label}  ${n >= 0 ? '+' : ''}${Math.round(n)}`, 'good');
  }

  finish(won, title, detail = '') {
    if (this.result) return;
    this.result = { won, title, detail, mission: this.mode };
    this.endT = won ? 3 : 2.4;
    this.say(title, won ? 'good' : 'danger');
  }

  bombCity(city) {
    for (let i = 0; i < 9; i++) {
      const a = Math.random() * TAU, r = Math.random() * city.r * 0.6;
      _a.set(city.x + Math.cos(a) * r, city.y + 8, city.z + Math.sin(a) * r);
      this.effects.explosion(_a, 3 + Math.random() * 2);
      for (const b of this.env.buildingsNear(_a.x, _a.z, 70, _nearB)) this.damageStructure(b, 600 * Math.random(), null);
    }
    this.boomSound(_a, 3);
  }

  /* ================================================================ buildings */

  /** Damage a building; breaking / collapsing throws debris and dust. */
  damageStructure(b, dmg, vel) {
    const st = this.env.damageBuilding(b, dmg);
    if (st < 1) return st;
    this.effects.rubble(b, st === 2, vel);
    _b.set(b.x, (b.y0 + b.top) / 2, b.z);
    this.boomSound(_b, st === 2 ? 1.6 : 0.8);
    return st;
  }

  /**
   * An aircraft flew into a building. Houses and low offices break apart and the aircraft
   * survives (badly hurt, slowed); towers and big blocks stop it dead.
   */
  hitBuilding(u, b) {
    const small = b.style === 'res' || (b.style === 'office' && b.floors <= 6);
    const pos = u.pos;
    if (!small) {
      this.damageStructure(b, b.hp0 * 0.6, u.vel);
      if (u.isPlayer) this.crashPlayer('FLEW INTO A BUILDING', false);
      else this.kill(u, null, true);
      return;
    }
    this.damageStructure(b, 1e9, u.vel);
    u.fm.velocity.multiplyScalar(0.8);
    this.effects.explosion(pos, 0.5, u.vel);
    this.damage(u, (28 + b.floors * 8) * (130 / Math.max(130, u.spec.armor * 0.8)), null);
    if (u.isPlayer && u.alive) {
      this.cam.shake = Math.max(this.cam.shake, 1.2);
      this.say('SMASHED THROUGH A BUILDING', 'warn');
    }
  }

  /* ================================================================ player actions (called by UI) */

  get flying() { return this.state === 'playing' && this.player && this.player.alive; }

  toggleGear() {
    if (!this.flying) return;
    const fm = this.player.fm;
    if (fm.onGround || this.player.spec.gearH === 0) return;
    fm.gearDown = !fm.gearDown;
    this.audio.play('gear');
    this.say(fm.gearDown ? 'GEAR DOWN' : 'GEAR UP');
  }

  dropFlare() {
    const p = this.player;
    if (!this.flying || p.flares <= 0) return;
    if (this.weapons.dropFlare(p)) { p.flares--; this.audio.play('flare'); }
  }

  fireMissile() {
    const p = this.player;
    if (!this.flying) return;
    if (p.missiles <= 0) { if (p.spec.missileCount) this.say('NO MISSILES', 'warn'); return; }
    const t = this.lock >= 1 && this.target && this.target.alive ? this.target : null;
    if (!t && this.target) { this.say('NO LOCK', 'warn'); return; }
    if (this.launch(p, t)) this.say(t ? 'FOX 2' : 'MISSILE AWAY (UNGUIDED)');
  }

  cycleTarget() {
    if (!this.flying) return;
    const p = this.player.pos;
    const list = this.units.filter(u => u.alive && u.team === 1 && u.pos.distanceTo(p) < this.radarRange * 2.5)
      .sort((a, b) => a.pos.distanceToSquared(p) - b.pos.distanceToSquared(p));
    if (!list.length) { this.target = null; this.say('NO TARGETS'); return; }
    this.target = list[(list.indexOf(this.target) + 1) % list.length];
    this.lock = 0;
    this.audio.play('click');
  }

  cycleView() {
    if (this.state !== 'playing') return;
    this.say(VIEW_NAMES[this.cam.next()]);
  }

  cycleNav() {
    if (!this.flying) return;
    const a = this.env.airfields, i = a.indexOf(this.navField);
    this.navField = a[(i + 1) % a.length];
    this.say('NAV · ' + this.navField.name);
  }

  /* ================================================================ loop */

  loop() {
    requestAnimationFrame(this.loop);
    const now = performance.now();
    const raw = (now - this.lastTime) / 1000;
    this.lastTime = now;
    const dt = Math.min(raw, 0.05);
    if (this.state === 'menu' || !this.player) {
      if (this.show) { this.updateShowcase(dt); this.engine.render(dt); }
      return;
    }
    if (this.state !== 'paused') {
      this.update(dt);
      this.adaptResolution(raw);
    }
    this.engine.render(dt);
  }

  /** Quality "auto": trade resolution for frame rate. */
  adaptResolution(raw) {
    if (!this.autoRes || raw > 0.25) return;
    this.frameMs += (raw * 1000 - this.frameMs) * 0.05;
    this.resT += raw;
    if (this.resT < 1.5) return;
    this.resT = 0;
    const r = this.engine.renderer, dpr = window.devicePixelRatio || 1;
    const cur = r.getPixelRatio();
    let next = cur;
    if (this.frameMs > 25) next = Math.max(0.6, cur * 0.85);
    else if (this.frameMs < 17.5) next = Math.min(Math.min(dpr, 2), cur * 1.1);
    if (Math.abs(next - cur) > 0.02) { r.setPixelRatio(next); this.engine.resize(); }
  }

  update(dt) {
    const p = this.player, env = this.env;
    this.time += dt;
    let input = NEUTRAL;
    if (this.state === 'playing' && this.ui) input = this.ui.getInput();
    else NEUTRAL.throttle = p.fm.throttle;
    if (this.autopilot && p.alive && this.state === 'playing') input = this.autoInput(dt);

    if (p.alive) this.updatePlayer(p, input, dt);
    this.updateAI(dt);
    this.updateGround(dt);
    this.updateWrecks(dt);
    this.weapons.update(dt, this.units, this.engine.camera.position);
    if (p.alive) this.updateTargeting(dt);

    this.count();
    if (!this.result && this.mission) this.mission.update(dt);
    if (this.result && this.state === 'playing') {
      this.endT -= dt;
      if (this.endT <= 0) this.end();
    }

    this.updateFx(dt);
    this.effects.update(dt);
    if (this.ui) { const l = this.ui.consumeLook(); this.cam.look(l.dx, l.dy); }
    // hold C in the cockpit: glance down at the instrument panel
    if (this.ui && this.ui.keys.KeyC && this.cam.view === 'cockpit') {
      const c = this.cam, k = Math.min(1, dt * 8);
      c.lookPitch += (-0.62 - c.lookPitch) * k; c.lookYaw -= c.lookYaw * k; c.lookIdle = 0;
    }
    this.cam.update(dt, p, env, this.target);
    // cockpit view: the airframe stays visible (you see your own wings and nose from
    // inside; the fuselage around you is back-face culled), the interior is a 2nd pass
    const inPit = this.cam.view === 'cockpit' && p.alive;
    p.obj.visible = p.alive || !!p.wreck;
    if (p.obj.userData.glass) p.obj.userData.glass.visible = !inPit;
    this.engine.pitOn = inPit;
    if (inPit) {
      // camera-relative: the cockpit sits at the origin so 5 cm detail survives float precision
      this.cockpit.group.quaternion.copy(p.obj.quaternion);
      const e = p.spec.eye;
      this.engine.pitCam.position.set(e[0], e[1], e[2]).applyQuaternion(p.obj.quaternion);
    }
    env.update(dt, this.engine.camera.position);

    if (this.state === 'playing') {
      this.fillHud(input);
      this.hud.draw(this.hs);
      this.drawGlare(dt);
      if (inPit) this.cockpit.update(dt, this.hs);
      this.updateAudio(dt, input);
    }
  }

  end() {
    const r = this.result;
    this.state = 'ended';
    r.score = this.score; r.kills = this.kills; r.wave = this.wave;
    r.newBest = this.score > 0 && this.settings.submitScore(this.mode, this.score);
    r.best = this.settings.best(this.mode);
    this.audio.stopFlight();
    this.hud.clear();
    this.cam.setView('orbit'); this.cam.auto = true;
    if (this.ui) this.ui.showDebrief(r);
  }

  count() {
    let h = 0, pr = 0;
    for (const u of this.units) {
      if (!u.alive || u.team !== 1) continue;
      if (u.kind === 'air') h++;
      if (u.primary) pr++;
    }
    this.hostilesLeft = h; this.primaryLeft = pr;
  }

  /* ================================================================ player */

  updatePlayer(p, input, dt) {
    const fm = p.fm, env = this.env;
    fm.step(p.obj, input, dt, env);
    for (const ev of fm.events) {
      if (ev.type === 'touchdown') this.onTouchdown(p, ev);
      else if (ev.type === 'crash') {
        fm.events.length = 0;
        this.crashPlayer(CRASH_TEXT[ev.reason] || 'CRASHED', ev.reason === 'water');
        return;
      }
    }
    fm.events.length = 0;
    // buildings are solid
    const hb = env.buildingAt(p.pos.x, p.pos.y, p.pos.z, p.radius * 0.35);
    if (hb) { this.hitBuilding(p, hb); if (!p.alive) return; }

    // stopped on a runway: ground crew turn the jet around
    if (fm.onGround && fm.onRunway && fm.speed < 1 && fm.throttle < 0.1) {
      this._rearm += dt;
      const s = p.spec;
      if (this._rearm > 3 && (fm.fuel < 99 || p.hp < p.maxHp || p.gun < s.gunAmmo || p.missiles < s.missileCount || p.flares < s.flares)) {
        fm.fuel = 100; p.hp = p.maxHp; p.gun = s.gunAmmo; p.missiles = s.missileCount; p.flares = s.flares;
        fm.engineHealth = 1; fm.rollBias = 0;
        this.audio.play('rearm');
        this.say('REFUELLED · REARMED · REPAIRED', 'good');
      }
    } else this._rearm = 0;

    // gun
    if (input.fire && p.gun > 0 && this.state === 'playing') {
      this.fireGun(p, dt, 0.0035);
      this.cam.shake = Math.max(this.cam.shake, 0.35);
      p.firing = true;
    } else { p.gunCd = Math.max(0, p.gunCd - dt); p.firing = false; }

    // g-induced grey-out / red-out
    const g = fm.gForce;
    const load = g > 6.2 ? (g - 6.2) * 0.22 : g < -1.6 ? (g + 1.6) * 0.35 : 0;
    if (load > 0) this.gloc = Math.min(1, Math.max(this.gloc, 0) + load * dt);
    else if (load < 0) this.gloc = Math.max(-1, Math.min(this.gloc, 0) + load * dt);
    else this.gloc -= Math.sign(this.gloc) * Math.min(Math.abs(this.gloc), dt * 0.6);

    if (fm.buffet > 0.3) this.cam.shake = Math.max(this.cam.shake, fm.buffet * 0.5);
    this.animate(p, dt, input);
  }

  onTouchdown(p, ev) {
    const fm = p.fm, a = this.nearestField(p.pos.x, p.pos.z);
    const dx = p.pos.x - a.x, dz = p.pos.z - a.z;
    // landing direction = whichever way along the strip we are rolling
    const sgn = (fm.velocity.x * a.dirX + fm.velocity.z * a.dirZ) >= 0 ? 1 : -1;
    const info = {
      sink: ev.sink, runway: ev.runway, speed: ev.speed, time: this.time, field: a,
      along: (dx * a.dirX + dz * a.dirZ) * sgn + a.length / 2,
      lat: (dx * -a.dirZ + dz * a.dirX) * sgn,
    };
    _a.copy(p.pos); _a.y -= p.spec.bellyH + p.spec.gearH;
    this.effects.tyreSmoke(_a, p.vel);
    this.audio.play('touchdown', { hard: clamp(ev.sink / 5, 0, 1) });
    if (this.settings.get('haptics') && navigator.vibrate) navigator.vibrate(40);
    const grade = ev.sink < 1.2 ? 'GREASER!' : ev.sink < 3.2 ? 'GOOD LANDING' : 'HARD LANDING';
    this.say(`${grade} · ${Math.round(ev.sink * 197)} FT/MIN${ev.runway ? '' : ' · OFF RUNWAY'}`, ev.sink < 3.2 ? 'good' : 'warn');
    if (ev.sink >= 3.5) this.damage(p, (ev.sink - 3.5) * 14, null);
    if (this.mission && this.mission.onTouchdown) this.mission.onTouchdown(info);
  }

  crashPlayer(reason, water) {
    const p = this.player;
    if (!p.alive) return;
    p.alive = false; p.fm.destroyed = true;
    this.effects.explosion(p.pos, 2.5);
    if (water) this.effects.groundBurst(p.pos, true, 5);
    this.audio.play(water ? 'splash' : 'crash');
    this.cam.shake = 1.4;
    if (this.cam.view === 'cockpit') this.cam.setView('chase');
    if (this.settings.get('haptics') && navigator.vibrate) navigator.vibrate([80, 40, 160]);
    this.finish(false, reason);
  }

  /** Test/demo hook: an AIPilot flies the player's aircraft (tests/play.mjs). */
  setAutopilot(on) {
    this.autopilot = on ? new AIPilot(this.player.spec, { skill: 0.9, role: 'fighter', cruiseAlt: 2200 }) : null;
    this._autoT = 0;
  }

  autoInput(dt) {
    const ai = this.autopilot, p = this.player, t = this.target;
    ai.target = t && t.alive && t.kind === 'air' ? t : null;
    ai.threatMissile = this.weapons.threatRange(p) < 2500;
    const inp = ai.think(p.obj, p.fm, dt, this.env);
    inp.fire = ai.wantFire;
    this._autoT -= dt;
    if (this.lock >= 1 && this._autoT <= 0) { this.fireMissile(); this._autoT = 4; }
    if (ai.wantFlare) this.dropFlare();
    return inp;
  }

  /* ================================================================ AI aircraft */

  updateAI(dt) {
    const env = this.env, w = this.weapons;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u.alive || u.kind !== 'air' || u.isPlayer) continue;
      const ai = u.ai;
      u.retarget -= dt;
      if (u.target && !u.target.alive) { u.target = null; u.retarget = 0; }
      if (ai.role === 'fighter' && u.retarget <= 0) {
        u.retarget = 2 + Math.random() * 2;
        u.target = this.pickEnemy(u, 16000);
      }
      ai.target = u.target;
      ai.threatMissile = w.threatRange(u) < 2500;
      ai.think(u.obj, u.fm, dt, env);
      u.fm.step(u.obj, ai.input, dt, env);
      u.fm.events.length = 0;
      if (u.fm.crashed) { this.kill(u, u.lastHitBy && this.time - u.lastHitT < 12 ? u.lastHitBy : null, true); continue; }
      const hb = env.buildingAt(u.pos.x, u.pos.y, u.pos.z, u.radius * 0.35);
      if (hb) { this.hitBuilding(u, hb); if (!u.alive) continue; }

      if (ai.wantFire && u.gun > 0) this.fireGun(u, dt, 0.007);
      else u.gunCd = Math.max(0, u.gunCd - dt);
      if (ai.wantMissile && u.missiles > 0 && u.target) {
        // keep it fair: only so many missiles in the air against the player at once
        if (u.target.isPlayer && this.missilesOn(u.target) >= (this.diff.skill > 0.8 ? 2 : 1)) ai.missileCd = 3 + Math.random() * 3;
        else this.launch(u, u.target);
      }
      if (ai.wantFlare && u.flares > 0 && w.dropFlare(u)) u.flares--;
      if (u.turret) this.turret(u, dt, 1000, 2.6, 8, 5);
      this.animate(u, dt, ai.input);
    }
  }

  missilesOn(unit) {
    let n = 0;
    for (const m of this.weapons.missiles) if (m.active && m.target === unit && !m.lost) n++;
    return n;
  }

  pickEnemy(u, maxR) {
    let best = null, bd = maxR;
    for (const t of this.units) {
      if (!t.alive || t.kind !== 'air' || t.team === u.team) continue;
      if (t.team === 0 && !t.isPlayer && t.score === 0 && t.ai && t.ai.role === 'drone') continue; // leave civilians alone
      let d = t.pos.distanceTo(u.pos);
      if (t.isPlayer) d *= 0.6;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** Flexible gun (bomber tail gun, AAA): lead-aimed bursts at the nearest enemy aircraft. */
  turret(u, dt, range, period, rounds, dmg) {
    if (u.burst > 0) {
      u.burstCd -= dt;
      if (u.burstCd <= 0 && u.aimAt && u.aimAt.alive) {
        u.burstCd = 0.09; u.burst--;
        _a.copy(u.pos); _a.y += u.kind === 'ground' ? 2.5 : 0;
        leadSolution(_a, u.vel, u.aimAt, _b);
        const n = (1.1 - this.diff.skill) * 0.03;
        _b.sub(_a).normalize();
        _b.x += (Math.random() - 0.5) * n; _b.y += (Math.random() - 0.5) * n; _b.z += (Math.random() - 0.5) * n;
        _b.normalize();
        _a.addScaledVector(_b, u.radius + 2);
        this.weapons.fireBullet(u, _a, _b, dmg, 0.006);
        if (u.obj.userData.turret) u.obj.userData.turret.rotation.y = Math.atan2(-_b.x, -_b.z) - u.obj.rotation.y;
      }
      return;
    }
    u.turretCd = (u.turretCd ?? period) - dt;
    if (u.turretCd > 0) return;
    u.turretCd = period * (0.7 + Math.random() * 0.6) / (0.6 + this.diff.skill * 0.7);
    let best = null, bd = range;
    for (const t of this.units) {
      if (!t.alive || t.kind !== 'air' || t.team === u.team) continue;
      const d = t.pos.distanceTo(u.pos);
      if (d < bd) { bd = d; best = t; }
    }
    if (best) { u.aimAt = best; u.burst = rounds; u.burstCd = 0; }
  }

  fireGun(u, dt, spread) {
    u.gunCd -= dt;
    const s = u.spec, q = u.obj.quaternion;
    let n = 0;
    while (u.gunCd <= 0 && u.gun > 0 && n < 6) {
      u.gunCd += s.gunRate; u.gun--; n++;
      _f.set(0, 0, -1).applyQuaternion(q);
      const m = u.obj.userData.muzzle;
      if (m) _a.copy(m); else _a.set(0, 0, -u.radius);
      _a.applyQuaternion(q).add(u.pos);
      this.weapons.fireBullet(u, _a, _f, s.gunDmg, spread);
      if (n === 1 && (u.isPlayer || Math.random() < 0.5)) this.effects.muzzleFlash(_a, u.vel);
    }
    if (u.gunCd < -0.5) u.gunCd = 0;
  }

  launch(u, target) {
    const q = u.obj.quaternion, side = (u.pylon++ & 1) ? 1 : -1;
    _f.set(0, 0, -1).applyQuaternion(q);
    _a.set(side * u.radius * 0.35, -u.radius * 0.14 - 0.6, 0).applyQuaternion(q).add(u.pos);
    if (!this.weapons.fireMissile(u, _a, _f, target)) return false;
    u.missiles--;
    if (u.isPlayer) this.audio.play('missile');
    return true;
  }

  /* ================================================================ ground units */

  updateGround(dt) {
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.kind !== 'ground') continue;
      if (!u.alive) {
        if (u.smokeLife > 0) {
          u.smokeLife -= dt; u.smoke -= dt;
          if (u.smoke <= 0) { u.smoke = 0.12; _a.copy(u.pos); _a.y += 2; _b.set(4, 9, 0); this.effects.damageSmoke(_a, _b, true, 2.4); }
        }
        continue;
      }
      const ud = u.obj.userData;
      if (ud.spin) ud.spin.rotation.y += dt * 1.6;
      if (u.type === 'aaa') this.turret(u, dt, 2600, 3.2, 12, 5);
      else if (u.type === 'sam') {
        u.cd -= dt;
        if (u.cd > 0) continue;
        u.cd = 1.5;
        let best = null, bd = 7500;
        for (const t of this.units) {
          if (!t.alive || t.kind !== 'air' || t.team === u.team) continue;
          const d = t.pos.distanceTo(u.pos);
          if (d < bd && d > 1200 && t.pos.y - u.pos.y > 120) { bd = d; best = t; }
        }
        if (!best) continue;
        _a.copy(u.pos); _a.y += 5;
        _b.copy(best.pos).sub(_a).normalize(); _b.y += 0.35; _b.normalize();
        if (this.weapons.fireMissile(u, _a, _b, best)) {
          u.cd = (15 + Math.random() * 8) / (0.6 + this.diff.skill * 0.7);
          if (ud.turret) ud.turret.rotation.y = Math.atan2(-_b.x, -_b.z) - u.obj.rotation.y;
          if (best.isPlayer) this.say('SAM LAUNCH', 'danger');
        }
      }
    }
  }

  /* ================================================================ damage */

  onHit(unit, dmg, team, pos, byMissile, shooter) {
    if (!unit.alive) return;
    if (shooter === this.player && unit.team === 1) this.audio.play('hitmark');
    this.damage(unit, dmg, shooter);
  }

  onExplode(pos, size) {
    this.boomSound(pos, size);
    // blast damage to buildings
    for (const b of this.env.buildingsNear(pos.x, pos.z, 24 * size, _nearB)) {
      if (pos.y > b.top + 15) continue;
      const d = Math.max(Math.abs(pos.x - b.x) - b.hw, Math.abs(pos.z - b.z) - b.hd, 0);
      this.damageStructure(b, 140 * size * (1 - d / (24 * size + 1)), null);
    }
    // splash damage to soft ground targets
    for (const u of this.units) {
      if (!u.alive || u.kind !== 'ground') continue;
      const d = u.pos.distanceTo(pos);
      if (d < 30) this.damage(u, 70 * (1 - d / 30), this.player);
    }
  }

  boomSound(pos, size) {
    this.audio.play('explosion', { dist: pos.distanceTo(this.engine.camera.position), size });
  }

  damage(u, dmg, shooter) {
    if (!u.alive) return;
    if (u.isPlayer) dmg *= this.diff.dmg;
    u.hp -= dmg;
    if (shooter) { u.lastHitBy = shooter; u.lastHitT = this.time; }
    if (u.kind === 'air') {
      const frac = clamp(u.hp / u.maxHp, 0, 1);
      u.fm.engineHealth = 0.55 + 0.45 * frac;
      if (frac < 0.4 && !u.fm.rollBias) u.fm.rollBias = (Math.random() - 0.5) * 0.25;
    }
    if (u.isPlayer) {
      this.cam.shake = Math.max(this.cam.shake, 0.7);
      this.audio.play('hit');
      if (this.ui) this.ui.damageFlash();
      if (this.settings.get('haptics') && navigator.vibrate) navigator.vibrate(60);
    }
    if (u.hp <= 0) this.kill(u, shooter, false);
  }

  kill(u, shooter, crashed) {
    if (!u.alive) return;
    u.alive = false;
    if (u.kind === 'air') {
      u.fm.destroyed = true;
      this.effects.explosion(u.pos, crashed ? 2.2 : 1.6, crashed ? null : u.vel);
      this.boomSound(u.pos, 1.6);
      if (crashed) { this.removeObj(u); u.gone = true; }
      else u.wreck = { spin: (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3) };
      if (u.isPlayer) {
        this.cam.shake = 1.4;
        if (this.cam.view === 'cockpit') this.cam.setView('chase');
        this.finish(false, 'SHOT DOWN');
      }
    } else {
      wreckGround(u);
      this.effects.explosion(u.pos, 2.4);
      this.boomSound(u.pos, 2.4);
    }
    if (shooter === this.player && u.team === 1 && !this.result) {
      this.kills++;
      this.addScore(u.score * this.diff.score, `${u.name} DESTROYED`);
    }
    if (this.target === u) { this.target = null; this.lock = 0; }
  }

  updateWrecks(dt) {
    let gone = false;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.gone) { gone = true; continue; }
      const w = u.wreck;
      if (!w) continue;
      const v = u.vel, pos = u.pos;
      v.y -= G * dt; v.multiplyScalar(1 - 0.12 * dt);
      pos.addScaledVector(v, dt);
      u.obj.rotateZ(w.spin * dt); u.obj.rotateX(-0.4 * dt);
      u.smoke -= dt;
      if (u.smoke <= 0) { u.smoke = 0.035; this.effects.damageSmoke(pos, v, true, 1.6); if (Math.random() < 0.6) this.effects.flame(pos, v, 1.4); }
      this.env.ground(pos.x, pos.z, gi);
      const wb = this.env.buildingAt(pos.x, pos.y, pos.z, 2);
      if (wb) { this.damageStructure(wb, 700, v); gi.y = pos.y - 1; }
      if (pos.y <= gi.y + 1) {
        pos.y = gi.y + 1;
        this.effects.explosion(pos, 2.4);
        this.effects.groundBurst(pos, gi.water, 4);
        this.boomSound(pos, 2.2);
        u.wreck = null;
        if (u.isPlayer) u.obj.visible = false;
        else { this.removeObj(u); u.gone = true; gone = true; }
      }
    }
    if (gone) {
      for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].gone) this.units.splice(i, 1);
    }
  }

  /* ================================================================ targeting */

  updateTargeting(dt) {
    const p = this.player;
    let t = this.target;
    if (t && !t.alive) t = this.target = null;
    _f.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
    if (!t) {
      // auto-acquire: the hostile closest to the nose
      let best = null, bs = 0.25;
      for (const u of this.units) {
        if (!u.alive || u.team !== 1) continue;
        _a.copy(u.pos).sub(p.pos);
        const d = _a.length();
        if (d > this.radarRange) continue;
        const sc = _a.dot(_f) / Math.max(d, 1) - d / this.radarRange * 0.3;
        if (sc > bs) { bs = sc; best = u; }
      }
      if (!best) {
        // nothing on the scope: point the pilot at the nearest mission target, however far
        let bd = Infinity;
        for (const u of this.units) {
          if (!u.alive || u.team !== 1 || !(u.primary || u.kind === 'air')) continue;
          const d = u.pos.distanceToSquared(p.pos);
          if (d < bd) { bd = d; best = u; }
        }
      }
      if (best) { t = this.target = best; this.lock = 0; }
    }
    if (t && p.missiles > 0) {
      _a.copy(t.pos).sub(p.pos);
      const d = _a.length(), ang = Math.acos(clamp(_a.dot(_f) / Math.max(d, 1), -1, 1));
      const was = this.lock;
      if (d < MISSILE.range && d > MISSILE.minRange && ang < 0.45) this.lock = Math.min(1, this.lock + dt / 1.3);
      else this.lock = Math.max(0, this.lock - dt * 1.5);
      if (was < 1 && this.lock >= 1) this.audio.play('click');
    } else this.lock = 0;
  }

  /* ================================================================ visuals */

  animate(u, dt, input) {
    const ud = u.obj.userData, fm = u.fm;
    if (ud.update) {
      const a = u.anim;
      a.time = this.time; a.gearPos = fm.gearPos; a.thrEff = fm.thrEff; a.ab = fm.ab;
      a.pitch = input.pitch; a.roll = input.roll; a.yaw = input.yaw;
      a.airbrake = fm.airbrake; a.speed = fm.speed; a.night = !!this.env.atmo.night;
      a.missiles = u.missiles;
      ud.update(dt, a);
      return;
    }
    const sp = 0.35 + fm.thrEff * 0.65;
    if (ud.rotor) ud.rotor.rotation.y += dt * 32 * sp;
    if (ud.tailRotor) ud.tailRotor.rotation.x += dt * 44 * sp;
    if (ud.prop) ud.prop.rotation.z += dt * 48 * sp;
  }

  updateFx(dt) {
    const fx = this.effects, cam = this.engine.camera.position, env = this.env;
    fx.beginShadows();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.kind !== 'air' || !u.alive) continue;
      const fm = u.fm, pos = u.pos;
      const near = pos.distanceToSquared(cam) < 6000 * 6000;
      if (!near) continue;
      const q = u.obj.quaternion;
      _f.set(0, 0, -1).applyQuaternion(q);
      env.ground(pos.x, pos.z, gi);
      const agl = pos.y - gi.y;
      const ud = u.obj.userData;
      if (this.engine.quality !== 'low' && ud.shadowGeo && !env.atmo.night) {
        // silhouette: find the ground where the shadow lands (it is offset along the sun), then project
        const sun = env.sunDir, ly = Math.max(sun.y, 0.2);
        let gy = gi.y;
        for (let k = 0; k < 2; k++) gy = env.groundHeight(pos.x - sun.x / ly * (pos.y - gy), pos.z - sun.z / ly * (pos.y - gy));
        ud.inner.updateMatrixWorld(true);
        if (pos.y - gy < 300) fx.planarShadow(ud.shadowGeo, ud.inner.matrixWorld, sun, gy, pos.y - gy, env.atmo.label === 'Overcast' ? 0.35 : 1);
      } else if (agl < 260) fx.shadow(pos.x, gi.y, pos.z, agl, u.radius, -heading(q));

      const frac = u.hp / u.maxHp;
      if (frac < 0.6) {
        u.smoke -= dt;
        if (u.smoke <= 0) {
          u.smoke = frac < 0.3 ? 0.04 : 0.08;
          _a.copy(pos).addScaledVector(_f, -u.radius * 0.7);
          fx.damageSmoke(_a, u.vel, frac < 0.3, 1);
          if (frac < 0.18 && Math.random() < 0.5) fx.flame(_a, u.vel, 1);
        }
      }
      // contrails up high, vapour off the wingtips under g
      if (pos.y > 2800 && fm.thrEff > 0.5 && u.spec.type === 'jet') {
        u.trail += fm.speed * dt;
        if (u.trail > 26) { u.trail = 0; _a.copy(pos).addScaledVector(_f, -u.radius * 1.1); fx.contrail(_a); }
      }
      if (fm.gForce > 6 && fm.speed > 110) {
        _r.set(1, 0, 0).applyQuaternion(q);
        const k = clamp((fm.gForce - 6) / 3, 0.2, 1), w = u.radius * 0.62;
        for (let sgn = -1; sgn <= 1; sgn += 2) { _a.copy(pos).addScaledVector(_r, sgn * w).addScaledVector(_f, -u.radius * 0.3); fx.vapour(_a, u.vel, k); }
      }
      // dust / spray when rolling or flying very low
      if (fm.onGround && fm.speed > 12 && !fm.onRunway && Math.random() < 0.5) { _a.copy(pos); _a.y = gi.y + 0.5; fx.dust(_a, u.vel, 1); }
      else if (!fm.onGround && agl < 14 && fm.speed > 60 && Math.random() < 0.6) {
        _a.copy(pos).addScaledVector(_f, -u.radius); _a.y = gi.y + 0.4;
        if (gi.water) fx.spray(_a, u.vel); else if (!gi.runway) fx.dust(_a, u.vel, 1.4);
      }
    }
    fx.endShadows();
  }

  /* ================================================================ HUD + audio state */

  makeHudState() {
    return {
      time: 0, view: 'chase', camera: this.engine.camera, touch: false,
      own: {
        name: '', pos: null, vel: null, quat: null, ias: 0, tas: 0, mach: 0, alt: 0, agl: 0, vs: 0,
        heading: 0, pitch: 0, bank: 0, g: 1, gMax: 9, aoa: 0, aoaMax: 0.3, throttle: 0, thrEff: 0, ab: false, hasAB: false,
        fuel: 100, hp: 1, gearDown: true, gearPos: 1, onGround: true, stalled: false, airbrake: 0, isHeli: false,
      },
      input: { pitch: 0, roll: 0, yaw: 0 },
      weapons: { gun: 0, gunMax: 0, missiles: 0, missilesMax: 0, flares: 0, hasGun: false, hasMissiles: false, gunRange: GUN_RANGE, missileRange: MISSILE.range },
      target: null,
      _target: { unit: null, pos: null, vel: null, name: '', kind: 'air', hp: 1, range: 0, closure: 0, lock: 0, locked: false, aim: null },
      _aim: new THREE.Vector3(),
      units: this.units, threats: this.threats, threatN: 0,
      nav: null,
      _nav: { name: '', pos: new THREE.Vector3(), dist: 0, bearing: 0, rwyHeading: 0, ils: null },
      _ils: { loc: 0, gs: 0 },
      waypoint: null,
      warn: { stall: false, pullUp: false, missile: false, fuel: false, gear: false, damage: false, overG: false },
      mission: { title: '', objective: '', score: 0, kills: 0, hostiles: 0, wave: 0, timer: null },
      map: { canvas: null, worldSize: WORLD_SIZE, airfields: [] },
      radarRange: this.radarRange, blackout: 0,
    };
  }

  fillHud(input) {
    const s = this.hs, p = this.player, fm = p.fm, sp = p.spec, q = p.obj.quaternion, o = s.own;
    s.time = this.time; s.view = this.cam.view === 'target' && !this.target ? 'chase' : this.cam.view;
    // the HUD is a fixed glass plate ahead of the pilot: looking away (panel glance, free look) shows the compact strip
    if (s.view === 'cockpit' && (this.cam.lookPitch < -0.3 || Math.abs(this.cam.lookYaw) > 0.5)) s.view = 'pitlook';
    s.touch = !!(this.ui && this.ui.touchActive);
    s.units = this.units;
    _f.set(0, 0, -1).applyQuaternion(q); _u.set(0, 1, 0).applyQuaternion(q); _r.set(1, 0, 0).applyQuaternion(q);
    o.name = p.name; o.pos = p.pos; o.vel = p.vel; o.quat = q;
    o.ias = fm.ias; o.tas = fm.speed; o.mach = fm.mach; o.alt = p.pos.y; o.agl = fm.altitudeAGL; o.vs = fm.vs;
    o.heading = heading(q); o.pitch = Math.asin(clamp(_f.y, -1, 1)); o.bank = Math.atan2(-_r.y, _u.y);
    o.g = fm.gForce; o.gMax = sp.gMax; o.aoa = fm.aoa; o.aoaMax = sp.alphaStall;
    o.throttle = fm.throttle; o.thrEff = fm.thrEff; o.ab = fm.ab; o.hasAB = sp.ab > 1;
    o.fuel = fm.fuel; o.hp = clamp(p.hp / p.maxHp, 0, 1);
    o.gearDown = fm.gearDown; o.gearPos = fm.gearPos; o.onGround = fm.onGround; o.stalled = fm.stalled;
    o.airbrake = fm.airbrake; o.isHeli = sp.type === 'heli';
    s.input.pitch = input.pitch; s.input.roll = input.roll; s.input.yaw = input.yaw;

    const w = s.weapons;
    w.gun = p.gun; w.gunMax = sp.gunAmmo; w.missiles = p.missiles; w.missilesMax = sp.missileCount; w.flares = p.flares;
    w.hasGun = sp.gunAmmo > 0; w.hasMissiles = sp.missileCount > 0;

    // target
    const t = this.target;
    if (t && t.alive) {
      const ts = s._target;
      ts.unit = t; ts.pos = t.pos; ts.vel = t.vel; ts.name = t.name; ts.kind = t.kind; ts.hp = clamp(t.hp / t.maxHp, 0, 1);
      _a.copy(t.pos).sub(p.pos);
      ts.range = _a.length();
      ts.closure = -(_b.copy(t.vel).sub(p.vel).dot(_a)) / Math.max(ts.range, 1);
      ts.lock = this.lock; ts.locked = this.lock >= 1;
      if (w.hasGun && ts.range < GUN_RANGE) { leadSolution(p.pos, p.vel, t, s._aim); ts.aim = s._aim; } else ts.aim = null;
      s.target = ts;
    } else s.target = null;

    // missile threats
    let n = 0, threat = false;
    for (const m of this.weapons.missiles) {
      if (!m.active || m.target !== p || m.lost) continue;
      if (n < this.threats.length) this.threats[n++].copy(m.pos);
      if (m.pos.distanceToSquared(p.pos) < 4500 * 4500) threat = true;
    }
    s.threatN = n;

    // nav / ILS to the selected (or nearest friendly) airfield
    const a = this.navField || this.nearestField(p.pos.x, p.pos.z, true);
    if (a) {
      const nv = s._nav, dx = p.pos.x - a.x, dz = p.pos.z - a.z;
      nv.name = a.name; nv.pos.set(a.x, a.y, a.z);
      nv.dist = Math.hypot(dx, dz); nv.bearing = (Math.atan2(-dx, dz) + TAU) % TAU;
      const along = dx * a.dirX + dz * a.dirZ;
      if (Math.abs(along) > a.length / 2 + 200 && !fm.onGround) this._ilsSgn = along < 0 ? 1 : -1;
      const sgn = this._ilsSgn, lx = a.dirX * sgn, lz = a.dirZ * sgn;
      nv.rwyHeading = (a.heading + (sgn < 0 ? Math.PI : 0)) % TAU;
      const sAl = dx * lx + dz * lz, dAim = (-a.length / 2 + 300) - sAl, lat = dx * -lz + dz * lx;
      if (!fm.onGround && dAim > 30 && dAim < 25000 && Math.abs(lat) < dAim * 0.7 + 300) {
        s._ils.loc = Math.atan2(lat, dAim + a.length);
        s._ils.gs = Math.atan2(p.pos.y - sp.bellyH - sp.gearH - a.y, dAim) - 3 * Math.PI / 180;
        nv.ils = s._ils;
      } else nv.ils = null;
      s.nav = nv;
    } else s.nav = null;
    s.waypoint = this.waypoint;

    const wn = s.warn, low = !fm.onGround && fm.altitudeAGL < 150;
    wn.stall = !fm.onGround && (fm.stalled || fm.buffet > 0.75);
    wn.pullUp = !fm.onGround && fm.vs < -10 && fm.altitudeAGL < -fm.vs * (fm.gearDown ? 2.5 : 5.5);
    wn.missile = threat;
    wn.fuel = fm.fuel < 12;
    wn.gear = low && !fm.gearDown && sp.gearH > 0 && fm.throttle < 0.5 && fm.ias < sp.vStall * 2 && fm.vs < 0;
    wn.damage = o.hp < 0.35;
    wn.overG = fm.gForce > sp.gMax * 0.985;

    const m = s.mission, mi = this.mission;
    m.title = MISSIONS[this.mode].title; m.objective = mi ? mi.objective() : '';
    m.score = this.score; m.kills = this.kills; m.hostiles = this.hostilesLeft; m.wave = this.wave;
    m.timer = mi && mi.timer ? mi.timer() : null;
    s.radarRange = this.radarRange;
    s.blackout = Math.abs(this.gloc) < 0.25 ? 0 : (this.gloc - Math.sign(this.gloc) * 0.25) / 0.75;
  }

  updateAudio(dt, input) {
    const a = this.as, p = this.player, fm = p.fm, w = this.hs.warn;
    a.thrEff = fm.thrEff; a.vMax = p.spec.vMax; a.speed = fm.speed; a.cockpit = this.cam.view === 'cockpit';
    a.damaged = 1 - p.hp / p.maxHp; a.buffet = fm.buffet; a.airbrake = fm.airbrake; a.gForce = fm.gForce; a.ab = fm.ab;
    a.groundSpeed = fm.speed; a.onGround = fm.onGround; a.gearMoving = fm.gearPos > 0.02 && fm.gearPos < 0.98;
    a.firing = !!p.firing; a.gunRate = p.spec.gunRate;
    a.lock = this.target && p.missiles > 0 ? (this.lock >= 1 ? 2 : this.lock > 0.05 ? 1 : 0) : 0;
    a.missileWarn = w.missile; a.pullUp = w.pullUp; a.stall = w.stall;
    this.audio.update(dt, a);
    void input;
  }

  /** Sun glare on the HUD canvas, hidden when terrain is in the way. */
  drawGlare(dt) {
    const env = this.env, cam = this.engine.camera, sun = env.sunDir, hud = this.hud;
    const k = env.atmo.night ? 0.25 : env.atmo.sunI < 1.5 ? 0 : 1;
    let vis = 0, sx = 0, sy = 0;
    if (k > 0) {
      _a.copy(cam.position).addScaledVector(sun, 1000).project(cam);
      if (_a.z < 1 && Math.abs(_a.x) < 1.25 && Math.abs(_a.y) < 1.25) {
        vis = 1; sx = (_a.x * 0.5 + 0.5) * hud.w; sy = (0.5 - _a.y * 0.5) * hud.h;
        for (let d = 200; d < 14000; d *= 1.8) {
          const p = cam.position;
          if (env.terrainHeight(p.x + sun.x * d, p.z + sun.z * d) > p.y + sun.y * d) { vis = 0; break; }
        }
      }
    }
    this.glare = (this.glare || 0) + (vis - (this.glare || 0)) * Math.min(1, dt * 6);
    if (this.glare < 0.02) return;
    if (vis) { this._gx = sx; this._gy = sy; }
    const ctx = hud.ctx, r = hud.h * 0.55, a = this.glare * k * 0.5;
    const g = ctx.createRadialGradient(this._gx, this._gy, 0, this._gx, this._gy, r);
    g.addColorStop(0, `rgba(255,246,220,${a})`); g.addColorStop(0.25, `rgba(255,236,190,${a * 0.35})`); g.addColorStop(1, 'rgba(255,230,180,0)');
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g;
    ctx.fillRect(this._gx - r, this._gy - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  nearestField(x, z, friendly = false) {
    let best = null, bd = Infinity;
    for (const a of this.env.airfields) {
      if (friendly && a.role === 'enemy') continue;
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /** North-up picture of the current map for the HUD moving map. */
  buildMap() {
    const hf = this.env.hf, N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d'), img = ctx.createImageData(N, N), d = img.data;
    const step = WORLD_SIZE / N, half = WORLD_SIZE / 2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * step - half, z = (j + 0.5) * step - half;
      const h = hf.height(x, z);
      let r, g, b;
      if (h <= 0.2) { const k = Math.min(1, -h / 60); r = 14 - k * 8; g = 46 - k * 22; b = 66 - k * 26; }
      else {
        const f = hf.forest(x, z, h), mc = hf.map.mini;
        const col = h < 4 ? mc.sand : h > mc.highH ? mc.high : h > mc.upH ? mc.up : mc.low;
        r = col[0]; g = col[1]; b = col[2];
        if (col === mc.low) { r -= f * 30; g -= f * 30; b -= f * 22; }
        const sh = 1 + clamp((h - hf.height(x + step, z) + h - hf.height(x, z + step)) / step * 1.3, -0.45, 0.45);
        r *= sh; g *= sh; b *= sh;
      }
      const k = (j * N + i) * 4;
      d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (hf.city) { ctx.fillStyle = 'rgba(190,190,200,0.8)'; ctx.fillRect((hf.city.x + half) / step - 4, (hf.city.z + half) / step - 4, 8, 8); }
    this.hs.map.canvas = c;
    this.hs.map.airfields = this.env.airfields;
  }
}

function heading(q) {
  _c.set(0, 0, -1).applyQuaternion(q);
  return (Math.atan2(_c.x, -_c.z) + TAU) % TAU;
}
