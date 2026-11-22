// Autopilot.js — the player's autopilot. One mode at a time:
//   TAKE OFF   runway roll / catapult shot, rotate, gear up, climb out, then HOLD
//   LAND       nearest friendly field (or the NAV selection, carrier included): join a gate on the
//              extended centreline, fly the glide slope, flare (runways) or fly it into the deck with
//              the hook down (carrier), roll out / trap; go around when it is not working out
//   SPACE      the hung-missile booster run: accelerate, zoom at 78 deg, lock the pylon latches,
//              override the burn limiter, light the motors in pairs, coast to apogee, pull out
//   LANDMARK   fly to the next landmark of the map and orbit it (each selection picks the next one)
//   TARGET     go after the current / nearest hostile: dogfight air targets, dive-attack ground ones
//   HOLD       hold altitude and heading (helicopters: hover)
// Like the AI pilots it only moves the stick and throttle of the same FlightModel; navigation legs
// reuse an AIPilot (with its terrain avoidance) and precise legs use the shared steerToward().
// update(dt) returns the input for the frame; `status` is the HUD line; `done` asks Game to disengage.
import * as THREE from 'three';
import { AIPilot, steerToward } from './AIPilot.js';
import { AB_DETENT } from './FlightModel.js';
import { MISSILE } from './Weapons.js';
import { clamp } from './utils.js';

export const AP_MODES = ['takeoff', 'land', 'space', 'landmark', 'target', 'hold'];
export const AP_LABELS = { takeoff: 'TAKE OFF', land: 'LAND', space: 'GO TO SPACE', landmark: 'LANDMARK', target: 'ATTACK TARGET', hold: 'HOLD' };

const TAU = Math.PI * 2, D2R = Math.PI / 180;
const fwd = new THREE.Vector3(), want = new THREE.Vector3(), tmp = new THREE.Vector3(), aim = new THREE.Vector3(), vhat = new THREE.Vector3();
const gi = { y: 0, water: false, runway: false, slope: 0, carrier: null };
const wrap = (a) => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const km = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' KM';
const ft = (m) => Math.round(m * 3.281 / 10) * 10;
/** Apogee (km) of the GO TO SPACE run with a full load of motors, from the flight-model sims. */
const SPACE_PEAK = { f22: 103, su35: 139, ef2000: 68, mig29: 64, a10: 33 };
const PRETTY = {
  empire: 'EMPIRE STATE BUILDING', chrysler: 'CHRYSLER BUILDING', onewtc: 'ONE WORLD TRADE CENTER', liberty: 'STATUE OF LIBERTY',
  eiffel: 'EIFFEL TOWER', arc: 'ARC DE TRIOMPHE', notredame: 'NOTRE-DAME', sacrecoeur: 'SACRE-COEUR', louvre: 'THE LOUVRE',
  bigben: 'BIG BEN', londoneye: 'LONDON EYE', shard: 'THE SHARD', stpauls: "ST PAUL'S", towerbridge: 'TOWER BRIDGE',
  christ: 'CHRIST THE REDEEMER', sugarloaf: 'SUGARLOAF', maracana: 'MARACANA',
};

/** Places worth flying to on the current map: real landmarks, or the city, airfields, carrier and peaks. */
export function landmarkList(env) {
  const hf = env.hf, out = [];
  const add = (name, x, z, h = 0) => out.push({ name, x, z, y: Math.max(hf.height(x, z), 0), h });
  if (hf.real && env.map.landmarks) {
    for (const lm of env.map.landmarks) {
      const [x, z] = hf.real.ll(lm.at[0], lm.at[1]);
      add(lm.name || PRETTY[lm.type] || lm.type.toUpperCase(), x, z, 450);
    }
  }
  if (hf.city) add(hf.city.name, hf.city.x, hf.city.z, hf.city.real ? 450 : 200);
  if (env.carrier) add(env.carrier.name, env.carrier.x, env.carrier.z, 60);
  for (const a of env.airfields) add(a.name, a.x, a.z, 50);
  if (env.map.volcano) add('THE VOLCANO', env.map.volcano[0], env.map.volcano[1], 0);
  if (!hf.real) {
    // highest summit
    let best = null;
    for (let x = -hf.half + 1000; x < hf.half; x += 700) for (let z = -hf.half + 1000; z < hf.half; z += 700) {
      const h = hf.height(x, z);
      if (!best || h > best.h) best = { x, z, h };
    }
    if (best && best.h > 300) add(`SUMMIT ${Math.round(best.h * 3.281 / 100) * 100} FT`, best.x, best.z, 0);
  }
  return out;
}

export class Autopilot {
  constructor(game, mode) {
    this.g = game; this.mode = mode;
    const p = game.player, s = p.spec;
    this.p = p; this.s = s; this.fm = p.fm;
    this.heli = s.type === 'heli';
    this.hasAB = s.ab > 1;
    this.inp = { pitch: 0, roll: 0, yaw: 0, throttle: p.fm.throttle, brake: false, fire: false };
    this.nav = new AIPilot(s, { skill: 0.95, role: 'drone', loop: false, cruiseAlt: 1500, minAGL: 160 });
    this.nav.waypoints = [{ x: 0, y: 0, z: 0 }];
    this.status = ''; this.done = false; this.doneMsg = '';
    this.t = 0; this.phaseT = 0; this.phase = '';
    this.thrI = 0; this.missileCd = 0;
    this.savedWaypoint = game.waypoint;
    this.enter(mode);
  }

  /* ------------------------------------------------------------ plumbing */

  setPhase(ph) { if (this.phase !== ph) { this.phase = ph; this.phaseT = 0; } }

  /** Switch mode in place (e.g. TAKE OFF → HOLD when the climb-out is done). */
  enter(mode) {
    this.mode = mode; this.phase = ''; this.phaseT = 0;
    const g = this.g, p = this.p, fm = this.fm, pos = p.pos;
    this.hdg0 = this.heading();
    this.alt0 = pos.y;
    if (mode === 'takeoff') this.initTakeoff();
    else if (mode === 'land') this.initLand();
    else if (mode === 'space') {
      if (this.heli) { this.finish('HELICOPTERS CAN\'T GO TO SPACE'); return; }
      this.peak = 0; this.boosted = false;
      this.setPhase(fm.onGround ? 'takeoff' : 'accel');
      if (fm.onGround) this.initTakeoff(true);
      this.accelHold = Math.max(pos.y, this.groundAt(pos.x, pos.z) + 1500);
      // what this jet can do with the motors it has (from the flight-model sims, full load)
      const est = SPACE_PEAK[p.key] ? Math.round(SPACE_PEAK[p.key] * Math.min(1, (p.missiles + 0.5) / Math.max(1, this.s.missileCount)) ** 1.6) : 20;
      if (!p.missiles) g.say('AP · SPACE · NO MISSILES TO BOOST WITH · ZOOM CLIMB ONLY (~20 KM)', 'warn');
      else if (est < 100) g.say(`AP · SPACE · ${p.missiles} MOTORS → ABOUT ${est} KM · NOT ENOUGH FOR SPACE (100 KM) · THE F-22 OR SU-35 CAN MAKE IT`, 'warn');
      else g.say(`AP · SPACE · ${p.missiles} MOTORS → ABOUT ${est} KM · STEP 1/5 ${fm.onGround ? 'TAKE OFF' : 'BUILD SPEED'}`, 'good');
      this.est = est;
    } else if (mode === 'landmark') {
      const list = landmarkList(g.env);
      if (!list.length) { this.finish('NO LANDMARKS ON THIS MAP'); return; }
      g._lmIdx = g._lmIdx || 0;
      // start with the nearest one the first time, then step through the list
      if (!g._lmPicked) {
        let bi = 0, bd = Infinity;
        list.forEach((l, i) => { const d = Math.hypot(l.x - pos.x, l.z - pos.z); if (d < bd && d > 2500) { bd = d; bi = i; } });
        g._lmIdx = bi; g._lmPicked = true;
      }
      this.lm = list[g._lmIdx % list.length];
      g._lmIdx++;
      this.lmAlt = this.lm.y + Math.max(this.lm.h + 250, 450);
      g.waypoint = { pos: new THREE.Vector3(this.lm.x, this.lm.y + 5, this.lm.z), label: 'LMK' };
      g.say(`AP · LANDMARK · ${this.lm.name} · ${km(Math.hypot(this.lm.x - pos.x, this.lm.z - pos.z))}`, 'good');
      this.setPhase(fm.onGround ? 'takeoff' : 'transit');
      if (fm.onGround) this.initTakeoff(true);
    } else if (mode === 'target') {
      this.fighter = new AIPilot(this.s, { skill: 0.92, role: 'fighter', cruiseAlt: Math.max(2200, pos.y) });
      this.setPhase(fm.onGround ? 'takeoff' : 'hunt');
      if (fm.onGround) this.initTakeoff(true);
    } else if (mode === 'hold') {
      this.holdAlt = Math.max(pos.y, this.groundAt(pos.x, pos.z) + (this.heli ? 60 : 250));
      this.holdHdg = this.heading();
      this.holdV = this.heli ? 0 : clamp(Math.max(fm.speed, this.s.vStall * 2.2), this.s.vStall * 1.9, this.s.vMax * 0.75);
      if (fm.onGround) { this.finish('ON THE GROUND · USE TAKE OFF'); return; }
      this.setPhase('hold');
    }
  }

  finish(msg) { this.done = true; this.doneMsg = msg; }

  heading() { fwd.set(0, 0, -1).applyQuaternion(this.p.obj.quaternion); return Math.atan2(fwd.x, -fwd.z); }
  groundAt(x, z) { this.g.env.ground(x, z, gi); return gi.y; }

  /**
   * Steer the FLIGHT PATH onto `w` (precise legs). steerToward points the nose; slow and gear-down the
   * wing flies several degrees nose-high, so aim the nose that far above where the path should go.
   */
  steer(w, maxPull = 0.6, k = 0.3) {
    const fm = this.fm;
    aim.copy(w);
    if (fm.speed > 20 && fm.rho > 0.05) {
      fwd.set(0, 0, -1).applyQuaternion(this.p.obj.quaternion);
      vhat.copy(fm.velocity).normalize();
      aim.add(fwd).sub(vhat).normalize();
    }
    steerToward(this.p.obj, fm, this.s, aim, maxPull, 0, k, this.inp);
  }

  /** Fly a navigation leg to (x, y, z) with the AI pilot's terrain avoidance; returns the distance (m). */
  navTo(x, y, z, dt, loop = null) {
    const n = this.nav;
    if (loop) { if (n.waypoints !== loop) { n.waypoints = loop; n.wpIndex = 0; n.loop = true; } } else {
      if (n.waypoints.length !== 1) n.waypoints = [{ x, y, z }];
      const w = n.waypoints[0]; w.x = x; w.y = y; w.z = z; n.wpIndex = 0; n.loop = false; n.arrived = false;
    }
    n.cruiseAlt = y;
    n.input.pitch = this.inp.pitch; n.input.roll = this.inp.roll;
    const i = n.think(this.p.obj, this.fm, dt, this.g.env);
    this.inp.pitch = i.pitch; this.inp.roll = i.roll; this.inp.yaw = i.yaw;
    this.inp.throttle = i.throttle; this.inp.brake = i.brake;
    this._navAvoid = n.avoiding || n.avoidT > 0;
    return Math.hypot(x - this.p.pos.x, z - this.p.pos.z);
  }

  /** Throttle (and speed brake) to hold an airspeed. */
  speedHold(v, dt, allowAB = false) {
    const e = v - this.fm.speed;
    this.thrI = clamp(this.thrI + e * dt * 0.012, -0.4, 0.5);
    let thr = clamp(0.45 + e * 0.035 + this.thrI, 0, 1);
    if (this.hasAB && !allowAB) thr = Math.min(thr, AB_DETENT - 0.01);
    this.inp.throttle = thr;
    this.inp.brake = e < -14;
    // climbing over terrain on a nav leg: full power, whatever the speed
    if (this._navAvoid) { this.inp.throttle = this.hasAB ? 1 : 1; this.inp.brake = false; }
  }

  mil() { return this.hasAB ? AB_DETENT - 0.01 : 1; }

  gear(down) {
    const fm = this.fm;
    if (this.s.gearH === 0 || fm.gearDown === down || fm.onGround) return;
    fm.gearDown = down; this.g.audio.play('gear'); this.g.say(down ? 'AP · GEAR DOWN' : 'AP · GEAR UP');
  }

  /** Nose-wheel steering on the ground toward a heading and onto a line (lat + = right of it). */
  groundSteer(hdg, lat = 0) {
    this.inp.roll = 0;
    this.inp.yaw = clamp(wrap(hdg - this.heading()) * 3 - clamp(lat * 0.03, -0.25, 0.25), -1, 1);
  }

  update(dt) {
    this.t += dt; this.phaseT += dt;
    const inp = this.inp;
    inp.fire = false; this._navAvoid = false;
    if (this.done) return inp;
    if (this.heli) this.updateHeli(dt);
    else if (this.mode === 'takeoff') this.updateTakeoff(dt);
    else if (this.mode === 'land') this.updateLand(dt);
    else if (this.mode === 'space') this.updateSpace(dt);
    else if (this.mode === 'landmark') this.updateLandmark(dt);
    else if (this.mode === 'target') this.updateTarget(dt);
    else this.updateHold(dt);
    if (!this.fm.onGround) inp.brake = inp.brake && this.fm.speed > this.s.vStall * 1.3;
    return inp;
  }

  /* ------------------------------------------------------------ TAKE OFF */

  initTakeoff(sub = false) {
    const g = this.g, p = this.p, fm = this.fm;
    this.subTakeoff = sub;
    this.rwyHdg = this.heading(); this.rwyLine = null;
    if (fm.onGround && !fm.cat && !fm.onCarrier) {
      // on an airfield: run along the runway the way we are pointing
      let best = null, bd = 1e9;
      for (const a of g.navFields) {
        if (a.carrier) continue;
        const dx = p.pos.x - a.x, dz = p.pos.z - a.z, lat = dx * -a.dirZ + dz * a.dirX, along = dx * a.dirX + dz * a.dirZ;
        if (Math.abs(lat) < a.width && Math.abs(along) < a.length / 2 + 100 && Math.abs(lat) < bd) { bd = Math.abs(lat); best = a; }
      }
      if (best) {
        const h = best.heading, sgn = Math.cos(wrap(h - this.rwyHdg)) >= 0 ? 1 : -1;
        this.rwyHdg = sgn > 0 ? h : h + Math.PI;
        this.rwyLine = { x: best.x, z: best.z, dx: Math.sin(this.rwyHdg), dz: -Math.cos(this.rwyHdg) };
      }
    }
    if (!fm.onGround) this.setPhase(sub ? this.phase : 'climb');
    else if (!sub) this.setPhase('roll');
    this.climbTo = Math.max(p.pos.y, this.groundAt(p.pos.x, p.pos.z)) + 650;
    this.gear(true);
  }

  /** One frame of the take-off; returns true once climbing out and clear of the ground. */
  takeoffStep(dt) {
    const fm = this.fm, p = this.p, s = this.s, inp = this.inp;
    if (fm.onGround) {
      inp.brake = false; inp.pitch = 0;
      inp.throttle = this.hasAB && (fm.cat || s.twr < 0.7) ? 1 : this.mil();
      if (fm.cat) { inp.yaw = 0; inp.roll = 0; this.status = fm.cat.fired ? 'CAT SHOT' : 'ON THE CATAPULT · SPOOLING UP'; return false; }
      let lat = 0;
      if (this.rwyLine) { const r = this.rwyLine; lat = (p.pos.x - r.x) * -r.dz + (p.pos.z - r.z) * r.dx; }
      this.groundSteer(this.rwyHdg, lat);
      const vr = s.vStall * (s.tailSit ? 0.85 : 0.95);
      if (fm.speed > vr) inp.pitch = 0.75;
      this.status = `TAKE-OFF ROLL · ${Math.round(fm.speed * 1.944)} KT${fm.speed > vr ? ' · ROTATE' : ''}`;
      return false;
    }
    const agl = p.pos.y - this.groundAt(p.pos.x, p.pos.z);
    if (agl > 18 && fm.vs > 1) { this.gear(false); if (fm.hookDown) fm.hookDown = false; }
    const d = 25000;
    this.navTo(p.pos.x + Math.sin(this.rwyHdg) * d, this.climbTo, p.pos.z - Math.cos(this.rwyHdg) * d, dt);
    // the nav leg would pull up gently; just after lift-off keep the nose steady and the speed building
    inp.throttle = agl < 250 ? (this.hasAB && s.twr < 0.7 ? 1 : this.mil()) : Math.max(inp.throttle, 0.85);
    this.status = `CLIMB-OUT · ${ft(p.pos.y)} FT`;
    return p.pos.y > this.climbTo - 120 || agl > 600;
  }

  updateTakeoff(dt) {
    if (this.takeoffStep(dt)) {
      this.g.say('AP · TAKE-OFF COMPLETE · HOLDING ALTITUDE', 'good');
      this.enter('hold');
    }
  }

  /* ------------------------------------------------------------ HOLD */

  updateHold(dt) {
    const p = this.p, d = 30000;
    this.holdAlt = Math.max(this.holdAlt, this.groundAt(p.pos.x, p.pos.z) + 150);
    this.navTo(p.pos.x + Math.sin(this.holdHdg) * d, this.holdAlt, p.pos.z - Math.cos(this.holdHdg) * d, dt);
    this.speedHold(this.holdV, dt);
    this.status = `HOLD ${ft(this.holdAlt)} FT · HDG ${String(Math.round(((this.holdHdg / D2R) % 360 + 360) % 360)).padStart(3, '0')}`;
  }

  /* ------------------------------------------------------------ LAND */

  initLand() {
    const g = this.g, p = this.p, fm = this.fm;
    if (fm.onGround) { this.finish('ALREADY ON THE GROUND'); return; }
    let a = g.navField;
    if (!a || a.role === 'enemy') a = g.nearestField(p.pos.x, p.pos.z, true);
    if (!a) { this.finish('NO FIELD TO LAND AT'); return; }
    this.field = a;
    this.carrier = !!a.carrier;
    this.glide = a.glide ?? 3 * D2R;
    const dx = p.pos.x - a.x, dz = p.pos.z - a.z, along = dx * a.dirX + dz * a.dirZ;
    this.sgn = a.oneWay ? 1 : (along < 0 ? 1 : -1);
    this.wheelsH = this.s.bellyH + this.s.gearH;
    this.vApp = this.s.vStall * 0.85 * (this.carrier ? 1.22 : 1.3);
    g.navField = a;
    this.goArounds = 0;
    this.join();
    g.say(`AP · LANDING · ${a.name}${this.carrier ? ' · HOOK WILL GO DOWN' : ''}`, 'good');
  }

  /** Approach geometry: s = distance before the aim point (m), lat = right of the centreline, hGS = glide-slope height. */
  geom(x, z) {
    const a = this.field, ax = a.dirX * this.sgn, az = a.dirZ * this.sgn;
    const T = -a.length / 2 + (a.aim ?? 300);                      // aim point along the approach direction from the centre
    const px = x - (a.x + ax * T), pz = z - (a.z + az * T);
    const o = this._geo || (this._geo = {});
    o.s = -(px * ax + pz * az); o.lat = px * -az + pz * ax;
    o.ax = ax; o.az = az; o.aimX = a.x + ax * T; o.aimZ = a.z + az * T;
    o.hGS = a.y + this.wheelsH + Math.max(o.s, 0) * Math.tan(this.glide);
    return o;
  }

  join() {
    const p = this.p, G = this.geom(p.pos.x, p.pos.z);
    const Dg = this.carrier ? 7000 : 9000;
    let lat = 0;
    if (G.s < Dg * 0.75 || Math.abs(G.lat) > G.s * 0.5) lat = (G.lat >= 0 ? 1 : -1) * 2800;
    const gx = G.aimX - G.ax * Dg - G.az * lat, gz = G.aimZ - G.az * Dg + G.ax * lat;
    // join no lower than the glide slope, and well clear of any ground between the gate and the field
    let gy = this.field.y + this.wheelsH + Dg * Math.tan(this.glide) + 40;
    for (let k = 0; k <= 8; k++) gy = Math.max(gy, this.groundAt(gx + (G.aimX - gx) * k / 16, gz + (G.aimZ - gz) * k / 16) + 300);
    this.gate = { s: Dg, lat, x: gx, z: gz, y: gy };
    this.routeT = 0;
    this.setPhase('join');
  }

  updateLand(dt) {
    const p = this.p, fm = this.fm, inp = this.inp, a = this.field, pos = p.pos;
    const G = this.geom(pos.x, pos.z);
    const h = pos.y - a.y - this.wheelsH;                         // wheels above the field / deck
    const ph = this.phase;
    if (ph === 'join') {
      const gt = this.gate;
      // en route: stay above the highest ground between here and the gate (re-scanned every few s)
      this.routeT = (this.routeT || 0) - dt;
      if (this.routeT <= 0) {
        this.routeT = 3;
        let top = -1e9;
        for (let k = 1; k <= 24; k++) top = Math.max(top, this.groundAt(pos.x + (gt.x - pos.x) * k / 24, pos.z + (gt.z - pos.z) * k / 24));
        this.routeY = top + 350;
      }
      const dg = Math.hypot(gt.x - pos.x, gt.z - pos.z);
      const d = this.navTo(gt.x, dg > 3500 ? Math.max(gt.y, this.routeY) : gt.y, gt.z, dt);
      this.speedHold(clamp(this.s.vStall * 1.9, this.vApp + 20, this.s.vMax * 0.6), dt);
      // already lined up and far enough out: take the glide slope from here
      const trackErr = Math.abs(wrap(Math.atan2(fm.velocity.x, -fm.velocity.z) - Math.atan2(G.ax, -G.az)));
      if (d < Math.max(1400, fm.speed * 9) || (G.s > 3000 && G.s < 14000 && Math.abs(G.lat) < G.s * 0.25 && trackErr < 0.6)) this.setPhase('final');
      this.status = `LAND · JOIN ${a.name} · GATE ${km(d)}`;
      return;
    }
    if (ph === 'final') {
      if (G.s < 12000) this.gear(true);
      if (this.carrier && !fm.hookDown) { fm.hookDown = true; this.g.say('AP · HOOK DOWN'); }
      const L = clamp(G.s * 0.3, this.carrier ? 300 : 450, 2500);
      const cs = G.s - L;
      const cx = G.aimX - G.ax * cs, cz = G.aimZ - G.az * cs;
      tmp.set(cx - pos.x, 0, cz - pos.z).normalize();
      const err = G.hGS - pos.y;
      // high: dive at up to ~11 deg to get back on (speed brake holds the speed); low: level off
      const gam = G.s > 0 ? -this.glide + clamp(err / Math.max(120, G.s * 0.12), -0.14, 0.07) : -this.glide;
      // terrain floor: a corner-cutting intercept may cross high ground the glide slope itself clears
      let gAhead = -1e9;
      for (const t of [2, 4, 7]) gAhead = Math.max(gAhead, this.groundAt(pos.x + fm.velocity.x * t, pos.z + fm.velocity.z * t));
      const clear = clamp(G.s * 0.035, 12, 140);
      let gm = gam;
      if (pos.y - gAhead < clear && G.s > 1200) gm = Math.max(gam, clamp((gAhead + clear - pos.y) / 300, 0, 0.12));
      want.set(tmp.x * Math.cos(gm), Math.sin(gm), tmp.z * Math.cos(gm));
      this.steer(want, 0.45, 0.35);
      this.speedHold(this.vApp, dt);
      if (fm.speed > this.vApp + 25) inp.brake = true;
      // not working out close in: wave off
      const tol = this.carrier ? 7 : 20;
      if (G.s < 450 && G.s > -20 && (Math.abs(G.lat) > tol || Math.abs(err) > (this.carrier ? 9 : 16))) { this.goAround(Math.abs(G.lat) > tol ? 'LINED UP BADLY' : err > 0 ? 'LOW' : 'HIGH'); return; }
      const agl = pos.y - this.groundAt(pos.x, pos.z);
      if (agl < 25 && G.s > 1500) { this.goAround('TOO LOW'); return; }
      if (!this.carrier && h < 9 && G.s < 700) this.setPhase('flare');
      if (G.s < -600 && !fm.onGround) { this.goAround('LONG'); return; }
      if (fm.onGround) this.setPhase(this.carrier ? 'deck' : 'rollout');
      this.status = `LAND · FINAL ${a.name} · ${km(Math.max(G.s, 0))} · ${err > 6 ? 'LOW' : err < -6 ? 'HIGH' : 'ON GLIDE SLOPE'}`;
      return;
    }
    if (ph === 'flare') {
      const sink = 0.7 + Math.max(0, h) * 0.22;
      const gam = -sink / Math.max(fm.speed, 20);
      const c = -clamp(G.lat * 0.004, -0.04, 0.04);          // ease back onto the centreline
      tmp.set(G.ax - G.az * c, 0, G.az + G.ax * c).normalize();
      want.set(tmp.x * Math.cos(gam), Math.sin(gam), tmp.z * Math.cos(gam));
      this.steer(want, 0.35, 0.4);
      inp.throttle = h < 4 ? 0 : 0.2; inp.brake = false;
      if (fm.onGround) this.setPhase('rollout');
      else if (G.s < -900) { this.goAround('LONG'); return; }
      this.status = 'LAND · FLARE';
      return;
    }
    if (ph === 'rollout') {
      inp.throttle = 0; inp.brake = true; inp.pitch = 0;
      this.groundSteer(Math.atan2(G.ax, -G.az), G.lat);
      this.status = `LAND · ROLL-OUT · ${Math.round(fm.speed * 1.944)} KT`;
      if (fm.speed < 1) this.finish(`LANDED AT ${a.name}`);
      return;
    }
    if (ph === 'deck') {
      // carrier: full power on touchdown (in case of a bolter) until the wire has you
      inp.pitch = 0; inp.roll = 0; inp.yaw = 0; inp.brake = false;
      inp.throttle = fm.arrest ? 0 : this.mil();
      if (!fm.onGround && !fm.arrest) { this.goAround('BOLTER'); return; }
      this.status = fm.arrest ? `TRAPPED · ${fm.arrest.wire} WIRE` : 'ON DECK · MIL POWER';
      if (fm.arrest && fm.arrest.stopped) this.finish(`TRAPPED ON ${a.name} · ${fm.arrest.wire} WIRE`);
      return;
    }
    if (ph === 'goaround') {
      const climb = 9 * D2R;
      want.set(G.ax * Math.cos(climb), Math.sin(climb), G.az * Math.cos(climb));
      this.steer(want, 0.8, 0.4);
      inp.throttle = this.mil(); inp.brake = false;
      if (this.phaseT > 14 && pos.y - this.groundAt(pos.x, pos.z) > 250) { this.join(); }
      this.status = `LAND · GO-AROUND (${this.waveOff})`;
    }
  }

  goAround(why) {
    this.waveOff = why; this.goArounds++;
    this.g.say(`AP · GO AROUND · ${why}`, 'warn');
    if (this.goArounds > 4) { this.finish('GAVE UP AFTER 5 APPROACHES'); return; }
    this.setPhase('goaround');
  }

  /* ------------------------------------------------------------ GO TO SPACE */

  updateSpace(dt) {
    const g = this.g, p = this.p, fm = this.fm, inp = this.inp, pos = p.pos;
    this.peak = Math.max(this.peak, pos.y);
    const hdg = this.hdg0, hx = Math.sin(hdg), hz = -Math.cos(hdg);
    const ph = this.phase;
    if (ph === 'takeoff') {
      if (this.takeoffStep(dt)) { g.say('AP · SPACE · STEP 1/5 · BUILDING SPEED LOW DOWN', 'good'); this.setPhase('accel'); this.hdg0 = this.heading(); this.accelHold = Math.max(pos.y, this.groundAt(pos.x, pos.z) + 1500); }
      this.status = 'SPACE · ' + this.status;
      return;
    }
    if (ph === 'accel') {
      // build speed fairly low down, where the engines are strongest
      this.gear(false);
      this.navTo(pos.x + hx * 30000, this.accelHold, pos.z + hz * 30000, dt);
      inp.throttle = 1; inp.brake = false;
      const target = this.s.vMax * 0.95 * (pos.y > 6000 ? 0.85 : 1);
      if (fm.speed > target || this.phaseT > 75) {
        this.setPhase('pull');
        g.say('AP · SPACE · STEP 2/5 · ZOOM CLIMB — PULLING UP TO 78°', 'good');
        if (this.s.missileCount && p.missiles > 0) {
          if (!g.latch) g.toggleLatch();
          g.motorsCut = false;
          if (!g.override) { g.override = true; g.audio.play('gear'); g.say('AP · PYLON LATCHES LOCKED · BURN LIMITER OVERRIDE', 'danger'); }
        }
      }
      this.status = `SPACE 1/5 · BUILDING SPEED ${Math.round(Math.min(1, fm.speed / target) * 100)}% · ${Math.round(fm.speed * 1.944)} / ${Math.round(target * 1.944)} KT`;
      return;
    }
    const zoom = 78 * D2R;
    if (ph === 'pull' || ph === 'burn') {
      want.set(hx * Math.cos(zoom), Math.sin(zoom), hz * Math.cos(zoom));
      this.steer(want, 0.75, 0.3);
      inp.throttle = 1;
      if (ph === 'pull' && (pos.y > 10000 || fm.speed < this.s.vStall * 1.6)) { this.setPhase('burn'); if (p.missiles) g.say('AP · SPACE · STEP 3/5 · LIGHTING THE MOTORS IN PAIRS', 'danger'); }
      if (ph === 'burn') {
        // light the motors two at a time (left + right: the yaw cancels) as each pair burns out
        if (p.hung.length === 0 && p.missiles > 0 && g.latch) { g.fireMissile(); if (p.missiles > 0) g.fireMissile(); this.boosted = true; }
        if (p.hung.length === 0 && (p.missiles === 0 || !g.latch)) { this.setPhase('coast'); g.say('AP · SPACE · STEP 4/5 · BURN-OUT · COASTING UP TO APOGEE', 'good'); }
      }
      this.status = ph === 'pull' ? `SPACE 2/5 · ZOOM CLIMB ${ft(pos.y)} FT` : `SPACE 3/5 · ROCKET BOOST · ${p.missiles + p.hung.length} MOTORS LEFT · ${km(pos.y)}`;
      return;
    }
    if (ph === 'coast') {
      // no air to steer with: keep the nose along the flight path until the air comes back
      if (fm.speed > 5) want.copy(fm.velocity).normalize(); else want.set(hx, 0, hz);
      this.steer(want, 0.6, 0.3);
      inp.throttle = 1;
      if (fm.vs < 0 && !this._apogee) { this._apogee = true; g.say(`APOGEE ${km(this.peak)}${this.peak > 100000 ? ' · SPACE!' : ''}`, 'good'); }
      if (fm.vs < 0 && pos.y < 32000) { this.setPhase('pullout'); g.say('AP · SPACE · STEP 5/5 · REENTRY · PULLING OUT', 'warn'); }
      this.status = `SPACE 4/5 · ${fm.vs > 0 ? 'COASTING UP' : 'FALLING BACK'} · ${km(pos.y)} · PEAK ${km(this.peak)}`;
      return;
    }
    if (ph === 'pullout') {
      fwd.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
      want.set(fwd.x, 0, fwd.z);
      if (want.lengthSq() < 1e-4) want.set(hx, 0, hz);
      want.normalize();
      this.steer(want, 0.6, 0.3);
      inp.throttle = 0.85;
      this.status = `SPACE 5/5 · REENTRY PULL-OUT · ${km(pos.y)}`;
      if (fm.vs > -5 && pos.y < 30000) {
        if (g.latch) g.toggleLatch();
        g.say(`AP · SPACE RUN COMPLETE · PEAK ${km(this.peak)}${this.peak > 100000 ? ' · YOU WERE IN SPACE!' : ' · SHORT OF SPACE (100 KM)'} · HOLDING`, 'good');
        this.enter('hold');
      }
    }
  }

  /* ------------------------------------------------------------ LANDMARK */

  updateLandmark(dt) {
    const p = this.p, lm = this.lm, pos = p.pos;
    if (this.phase === 'takeoff') {
      if (this.takeoffStep(dt)) this.setPhase('transit');
      this.status = 'LANDMARK · ' + this.status;
      return;
    }
    const d = Math.hypot(lm.x - pos.x, lm.z - pos.z);
    if (this.phase === 'transit') {
      this.gear(false);
      this.navTo(lm.x, this.lmAlt, lm.z, dt);
      this.speedHold(clamp(this.s.vStall * 2.8, 80, this.s.vMax * 0.7), dt);
      if (d < 1800) {
        // a ring round it, entered on the side we arrive from
        const R = 1600, a0 = Math.atan2(pos.z - lm.z, pos.x - lm.x);
        this.ring = Array.from({ length: 8 }, (_, i) => ({ x: lm.x + Math.cos(a0 + i * TAU / 8) * R, z: lm.z + Math.sin(a0 + i * TAU / 8) * R, y: this.lmAlt }));
        this.g.say(`AP · ORBITING ${lm.name}`, 'good');
        this.setPhase('orbit');
      }
      this.status = `LANDMARK · ${lm.name} · ${km(d)}`;
      return;
    }
    this.navTo(lm.x, this.lmAlt, lm.z, dt, this.ring);
    this.speedHold(clamp(this.s.vStall * 2.2, 70, this.s.vMax * 0.6), dt);
    this.status = `LANDMARK · ORBITING ${lm.name}`;
  }

  /* ------------------------------------------------------------ TARGET */

  pickTarget() {
    const g = this.g, p = this.p;
    let t = g.target && g.target.alive && g.target.team === 1 ? g.target : null;
    if (!t) {
      let bd = Infinity;
      for (const u of g.units) {
        if (!u.alive || u.team !== 1) continue;
        const d = u.pos.distanceTo(p.pos) * (u.kind === 'air' ? 0.6 : u.primary ? 0.8 : 1);
        if (d < bd) { bd = d; t = u; }
      }
      if (t) { g.target = t; g.lock = 0; }
    }
    return t;
  }

  updateTarget(dt) {
    const g = this.g, p = this.p, fm = this.fm, inp = this.inp, pos = p.pos;
    if (this.phase === 'takeoff') {
      if (this.takeoffStep(dt)) this.setPhase('hunt');
      this.status = 'TARGET · ' + this.status;
      return;
    }
    this.gear(false);
    const t = this.pickTarget();
    if (!t) { g.say('AP · NO HOSTILES LEFT · HOLDING', 'good'); this.enter('hold'); return; }
    if (this.tgt !== t) { this.tgt = t; this.setPhase('hunt'); g.say(`AP · ATTACKING ${t.name} · ${km(t.pos.distanceTo(pos))}`, 'warn'); }
    const range = t.pos.distanceTo(pos);
    this.missileCd -= dt;
    if (t.kind === 'air') {
      // dogfight with the AI fighter brain
      const ai = this.fighter;
      ai.target = t;
      ai.threatMissile = g.weapons.threatRange(p) < 2500;
      ai.input.pitch = inp.pitch; ai.input.roll = inp.roll;
      const i = ai.think(p.obj, fm, dt, g.env);
      inp.pitch = i.pitch; inp.roll = i.roll; inp.yaw = i.yaw; inp.throttle = i.throttle; inp.brake = i.brake;
      inp.fire = ai.wantFire;
      if (g.lock >= 1 && this.missileCd <= 0 && p.missiles > 0 && !g.latch) { g.fireMissile(); this.missileCd = 4; }
      if (ai.wantFlare) g.dropFlare();
      this.status = `TARGET · ${t.name} · ${km(range)}`;
      return;
    }
    // ground target: run in high, dive on it, guns / missile, pull out, extend, come round again
    const gy = t.pos.y, hd = Math.hypot(t.pos.x - pos.x, t.pos.z - pos.z);
    const agl = pos.y - this.groundAt(pos.x, pos.z);
    if (this.phase === 'hunt') {
      this.navTo(t.pos.x, gy + 900, t.pos.z, dt);
      this.speedHold(clamp(this.s.vStall * 2.6, 90, this.s.vMax * 0.7), dt);
      if (hd < 4200 && pos.y > gy + 400) { this.setPhase('dive'); this.fired = false; }
      this.status = `TARGET · ${t.name} · RUN-IN ${km(hd)}`;
      return;
    }
    if (this.phase === 'dive') {
      want.copy(t.pos).sub(pos).normalize();
      this.steer(want, 0.8, 0.4);
      this.speedHold(clamp(this.s.vStall * 2.6, 90, this.s.vMax * 0.6), dt);
      fwd.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
      const off = fwd.angleTo(want);
      if (p.gun > 0 && range < 1500 && off < 0.04) inp.fire = true;
      if (!this.fired && p.missiles > 0 && !g.latch && g.lock >= 1 && range < MISSILE.range) { g.fireMissile(); this.fired = true; }
      if (range < 600 || agl < 220 || (fm.vs < -30 && agl < -fm.vs * 4.5)) { this.setPhase('egress'); this.egressHdg = this.heading(); }
      this.status = `TARGET · ${t.name} · ATTACK ${km(range)}`;
      return;
    }
    // egress: climb away straight ahead, then turn back in
    const eh = this.egressHdg;
    this.navTo(pos.x + Math.sin(eh) * 20000, gy + 1100, pos.z - Math.cos(eh) * 20000, dt);
    this.inp.throttle = 1;
    if (this.phaseT > 11 && agl > 500) this.setPhase('hunt');
    this.status = `TARGET · ${t.name} · EXTENDING`;
  }

  /* ------------------------------------------------------------ helicopters */

  /** Fly a helicopter toward (x, z) at height y; stops `stop` metres short. Returns the distance. */
  heliTo(x, y, z, dt, stop = 0) {
    const p = this.p, fm = this.fm, inp = this.inp, pos = p.pos, v = fm.velocity;
    const dx = x - pos.x, dz = z - pos.z, d = Math.hypot(dx, dz);
    const vd = clamp((d - stop) * 0.1, 0, this.s.vMax * 0.8);
    fwd.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
    const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1;
    const hx = fx / fl, hz = fz / fl;
    const err = d > 25 ? wrap(Math.atan2(dx, -dz) - Math.atan2(hx, -hz)) : 0;
    const vf = v.x * hx + v.z * hz, vsd = v.x * -hz + v.z * hx;
    inp.yaw = clamp(err * 1.4, -1, 1);
    inp.pitch = clamp((vf - vd * Math.max(0, Math.cos(err))) * 0.035, -0.75, 0.5);
    inp.roll = clamp(-vsd * 0.05, -0.4, 0.4);
    this.thrI = clamp(this.thrI + (y - pos.y) * dt * 0.002, -0.2, 0.3);
    inp.throttle = clamp(0.5 + (y - pos.y) * 0.012 - fm.vs * 0.09 + this.thrI, 0.05, 1);
    inp.brake = false;
    return d;
  }

  updateHeli(dt) {
    const g = this.g, p = this.p, fm = this.fm, inp = this.inp, pos = p.pos;
    const gnd = this.groundAt(pos.x, pos.z), agl = pos.y - gnd;
    const m = this.mode;
    if (m === 'takeoff' || ((m === 'landmark' || m === 'target') && this.phase === 'takeoff')) {
      if (!this.liftX) { this.liftX = pos.x; this.liftZ = pos.z; this.liftY = gnd + 120; }
      this.heliTo(this.liftX, this.liftY, this.liftZ, dt);
      this.status = `LIFT-OFF · ${ft(agl)} FT AGL`;
      if (agl > 100) {
        if (m === 'takeoff') { g.say('AP · HOVERING', 'good'); this.enter('hold'); } else this.setPhase(m === 'target' ? 'hunt' : 'transit');
      }
      return;
    }
    if (m === 'hold') {
      if (this.hoverX === undefined) { this.hoverX = pos.x; this.hoverZ = pos.z; }
      this.heliTo(this.hoverX, this.holdAlt, this.hoverZ, dt);
      this.status = `HOVER ${ft(this.holdAlt - gnd)} FT AGL`;
      return;
    }
    if (m === 'landmark') {
      const lm = this.lm;
      const d = this.heliTo(lm.x, Math.max(this.lmAlt - 150, lm.y + 200), lm.z, dt, 500);
      this.status = d < 700 ? `LANDMARK · HOVERING BY ${lm.name}` : `LANDMARK · ${lm.name} · ${km(d)}`;
      return;
    }
    if (m === 'target') {
      const t = this.pickTarget();
      if (!t) { g.say('AP · NO HOSTILES LEFT · HOVERING', 'good'); this.holdAlt = pos.y; this.enter('hold'); return; }
      const d = this.heliTo(t.pos.x, Math.max(t.pos.y + 220, gnd + 120), t.pos.z, dt, 1300);
      fwd.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
      want.copy(t.pos).sub(pos).normalize();
      if (d < 1600 && fwd.angleTo(want) < 0.12 && p.gun > 0) inp.fire = true;
      this.missileCd -= dt;
      if (g.lock >= 1 && this.missileCd <= 0 && p.missiles > 0 && !g.latch) { g.fireMissile(); this.missileCd = 3; }
      this.status = `TARGET · ${t.name} · ${km(t.pos.distanceTo(pos))}`;
      return;
    }
    if (m === 'land') {
      if (!this.padX) {
        const a = this.field;
        if (a.carrier) { const w = a.carrier.toWorld(118, 0, {}); this.padX = w.x; this.padZ = w.z; } else { this.padX = a.x; this.padZ = a.z; }
      }
      const pad = this.field.y + this.s.bellyH;
      const d = Math.hypot(this.padX - pos.x, this.padZ - pos.z);
      if (fm.onGround) { inp.throttle = 0.05; inp.pitch = 0; inp.roll = 0; inp.yaw = 0; this.finish(`LANDED AT ${this.field.name}`); return; }
      const desc = d < 25 ? Math.max(pad, pos.y - (pos.y - pad > 15 ? 4 : 1.5) * 1) : Math.max(pad + 120, gnd + 100);
      this.heliTo(this.padX, desc, this.padZ, dt);
      if (d < 25) inp.throttle = clamp(0.5 - (fm.vs + (pos.y - pad > 15 ? 4 : 1.2)) * 0.08 + this.thrI, 0.05, 1);
      this.status = d < 25 ? `LAND · DESCENDING ${ft(pos.y - pad)} FT` : `LAND · ${this.field.name} · ${km(d)}`;
    }
  }
}
