// AIPilot.js — an autopilot that flies an aircraft through the SAME FlightModel
// the player uses, by producing stick inputs. It never moves the aircraft
// directly, so AI aircraft bleed energy, stall and can be out-flown.
//
// Each think() fills `this.input` ({pitch, roll, yaw, throttle, brake}) and sets
// `wantFire` / `wantMissile` / `wantFlare`. Pure three.js maths — runs in node.
//
// Steering: pick a world-space direction to fly (`want`), roll until it lies in
// the lift plane, then pull. Terrain avoidance overrides the direction when the
// projected flight path gets too close to the ground.
import * as THREE from 'three';
import { clamp } from './utils.js';

const G = 9.81;
const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
const want = new THREE.Vector3(), toT = new THREE.Vector3(), tmp = new THREE.Vector3(), lead = new THREE.Vector3();
const gi = { y: 0, water: false, runway: false, slope: 0 };
const BEAR = [0, 0.7, -0.7, 1.5, -1.5, 2.6];
const SCAN_T = [0.02, 0.045, 0.075, 0.11, 0.17, 0.25, 0.37, 0.54, 0.75, 1]; // dense near, sparse far

export class AIPilot {
  /**
   * @param {object} spec  aircraft spec
   * @param {object} opts  { skill 0..1, role: 'fighter'|'bomber'|'drone', waypoints: [{x,y,z}], loop }
   */
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.skill = opts.skill ?? 0.6;
    this.role = opts.role || 'fighter';
    this.waypoints = opts.waypoints || null;
    this.loop = opts.loop !== false;
    this.wpIndex = 0;
    this.input = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: false };
    this.state = 'patrol';
    this.stateTime = 0;
    this.target = null;          // { pos: Vector3, vel: Vector3, alive }
    this.threatMissile = false;  // set by the game when a missile is tracking us
    this.wantFire = false; this.wantMissile = false; this.wantFlare = false;
    this.aimNoise = new THREE.Vector3();
    this.noiseT = 0;
    this.lockT = 0;
    this.missileCd = 4 + Math.random() * 6;
    this.flareCd = 0;
    this.evadeVec = new THREE.Vector3(1, 0, 0);
    this.extendDir = new THREE.Vector3(0, 0, -1);
    this.minAGL = opts.minAGL ?? 180;
    this.cruiseAlt = opts.cruiseAlt ?? 1500;
    this.cruiseThrottle = opts.cruiseThrottle ?? 0.9;   // bombers in transit
    this.angleOff = Math.PI; this.range = Infinity;
    this.arrived = false;
    this.cornerSpeed = spec.vStall * Math.sqrt(spec.gMax) * 1.02;
    this.bulletSpeed = 950;
    this.avoiding = false;
    this.scanT = Math.random() * 0.15; this.scanSlope = new Float32Array(BEAR.length);
    this.scanNear = -1e9; this.scanHere = 0;
    this.avoidT = 0; this.avoidVec = new THREE.Vector3(); this.avoidSlope = 0;
  }

  setState(s) { if (this.state !== s) { this.state = s; this.stateTime = 0; } }

  /**
   * @param obj    aircraft Object3D (position/quaternion)
   * @param fm     its FlightModel (velocity, speed, onGround)
   * @param dt     seconds
   * @param env    { ground(x,z,out) }
   */
  think(obj, fm, dt, env) {
    const inp = this.input, s = this.spec, pos = obj.position, v = fm.velocity;
    this.stateTime += dt;
    this.wantFire = false; this.wantMissile = false; this.wantFlare = false;
    this.missileCd -= dt; this.flareCd -= dt;
    fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
    up.set(0, 1, 0).applyQuaternion(obj.quaternion);
    right.set(1, 0, 0).applyQuaternion(obj.quaternion);
    const V = Math.max(fm.speed, 1);
    let throttle = 0.85, maxPull = 1;

    // ---- pick a direction ----
    const tgt = this.target && this.target.alive ? this.target : null;
    if (this.role === 'fighter' && tgt) {
      if (this.state === 'patrol') this.setState('engage');
    } else if (this.state !== 'patrol') this.setState('patrol');

    if (this.threatMissile && this.role === 'fighter' && this.state !== 'evade') {
      this.setState('evade');
      // break across the horizon: a fixed world direction ~100° off the current track
      const dir = Math.random() < 0.5 ? -1 : 1, c = Math.cos(1.75), sn = Math.sin(1.75) * dir;
      const hx = fwd.x, hz = fwd.z;
      this.evadeVec.set(hx * c - hz * sn, 0, hx * sn + hz * c).normalize();
    }

    this.angleOff = Math.PI; this.range = Infinity;
    if (tgt) {
      toT.copy(tgt.pos).sub(pos);
      this.range = toT.length();
      this.angleOff = fwd.angleTo(toT);
    }

    if (this.state === 'evade') {
      // beam the threat: hard turn across the horizon, flares out, then re-engage
      want.copy(this.evadeVec);
      want.y = clamp(-0.1 + (this.cruiseAlt - pos.y) / 4000, -0.3, 0.3);
      want.normalize();
      throttle = 1;
      if (this.flareCd <= 0) { this.wantFlare = true; this.flareCd = 0.7 + (1 - this.skill) * 1.2; }
      if (this.stateTime > 3.5 + this.skill * 2 && !this.threatMissile) this.setState(tgt ? 'engage' : 'patrol');
      if (this.stateTime > 9) this.setState(tgt ? 'engage' : 'patrol');
    } else if (this.state === 'extend') {
      // unload and accelerate away to rebuild energy, then come back
      want.copy(this.extendDir);
      throttle = 1; maxPull = 0.5;
      if (this.stateTime > 7 || V > this.cornerSpeed * 1.25 || this.range > 3500) this.setState('engage');
    } else if (this.state === 'engage' && tgt) {
      // lead pursuit inside gun range, pure pursuit further out
      const tof = clamp(this.range / (this.bulletSpeed + V), 0, 2.5);
      this.noiseT -= dt;
      if (this.noiseT <= 0) {
        this.noiseT = 0.6 + Math.random() * 0.8;
        const n = (1 - this.skill) * 0.035 + 0.004;
        this.aimNoise.set((Math.random() - 0.5) * n, (Math.random() - 0.5) * n, (Math.random() - 0.5) * n);
      }
      lead.copy(tgt.pos).addScaledVector(tgt.vel, this.range < 2500 ? tof : 0);
      lead.y += 0.5 * G * tof * tof; // bullet drop
      want.copy(lead).sub(pos).normalize().add(this.aimNoise).normalize();
      const leadOff = fwd.angleTo(want);

      // energy: afterburner when slow or far; inside 2 km manage closure so we
      // arrive co-speed behind the target instead of blowing through
      const closure = -(tmp.copy(tgt.vel).sub(v).dot(toT)) / Math.max(this.range, 1);
      inp.brake = false;
      if (this.range > 2200 || V < this.cornerSpeed * 0.9) throttle = 1;
      else {
        const wantClosure = clamp((this.range - 350) / 7, -25, 140);
        throttle = clamp(0.7 + (wantClosure - closure) * 0.02, 0.05, 1);
        if (closure - wantClosure > 45 && V > this.cornerSpeed * 0.85) inp.brake = true;
      }
      maxPull = 0.55 + 0.45 * this.skill;

      // weapons
      if (this.range < 1000 && leadOff < 0.03 + (1 - this.skill) * 0.02) this.wantFire = true;
      if (this.range > 900 && this.range < 6000 && this.angleOff < 0.3) {
        this.lockT += dt;
        if (this.lockT > 2.5 + (1 - this.skill) * 3 && this.missileCd <= 0) {
          this.wantMissile = true; this.lockT = 0;
          this.missileCd = 9 + (1 - this.skill) * 14 + Math.random() * 6;
        }
      } else this.lockT = Math.max(0, this.lockT - dt * 2);

      // too slow to fight, or about to ram: extend
      if (V < s.vStall * 1.45 && this.stateTime > 4) {
        this.extendDir.copy(fwd); this.extendDir.y = -0.12; this.extendDir.normalize();
        this.setState('extend');
      } else if (this.range < 160) {
        this.extendDir.copy(fwd).addScaledVector(up, 0.5).normalize();
        this.setState('extend');
      }
    } else {
      // patrol / transit along waypoints, or orbit where we are
      inp.brake = false;
      const wp = this.waypoints && this.waypoints[this.wpIndex];
      if (wp) {
        tmp.set(wp.x - pos.x, 0, wp.z - pos.z);
        const d = tmp.length();
        if (d < Math.max(600, V * 4)) {
          if (this.wpIndex < this.waypoints.length - 1) this.wpIndex++;
          else if (this.loop) this.wpIndex = 0;
          else this.arrived = true;
        }
        want.copy(tmp).normalize();
        want.y = clamp(((wp.y ?? this.cruiseAlt) - pos.y) / 1500, -0.25, 0.3);
        want.normalize();
      } else {
        // gentle left-hand orbit
        want.copy(fwd).addScaledVector(right, -0.25); want.y = clamp((this.cruiseAlt - pos.y) / 1500, -0.25, 0.3); want.normalize();
      }
      throttle = this.role === 'bomber' ? this.cruiseThrottle : (V < this.cornerSpeed ? 0.9 : 0.62);
      maxPull = 0.4;
    }

    // ---- terrain avoidance (overrides everything) ----
    // (a) dive recovery: height lost in a pull-out started now, R(1-cos γ) + reaction
    // (b) rising ground: lift the wanted direction to out-climb it, or turn toward
    //     the lower side when the aircraft cannot climb that steeply
    const margin = this.minAGL * (this.state === 'engage' ? 0.7 : 1);
    const vh = Math.max(Math.hypot(v.x, v.z), 1), hx = v.x / vh, hz = v.z / vh;
    const rho = Math.exp(-Math.max(pos.y, 0) / 9000);
    const nAv = clamp(rho * (V / Math.max(s.vStall, 1)) ** 2, 1.4, s.gMax) * 0.7;
    const R = V * V / (G * Math.max(nAv - 1, 0.35));
    const sinG = clamp(-v.y / V, 0, 1);
    const pullLoss = R * (1 - Math.sqrt(1 - sinG * sinG)) + sinG * V * 1.3;
    const horizon = clamp(R * sinG / vh + 4, 4, 12);    // seconds of track that matter
    const climbCap = clamp(s.twr * (s.ab > 1 ? 1.1 : 0.5), 0.1, 1.2);
    const look = climbCap < 0.4 ? 24 : 11;              // slow climbers must plan further ahead
    this.scanT -= dt;
    if (this.scanT <= 0) {
      // scan the ground along the track and along alternative headings (cached ~7 Hz)
      this.scanT = 0.15;
      let gNear = -1e9, best = 0, bestCost = 1e9;
      for (let b = 0; b < BEAR.length; b++) {
        const cb = Math.cos(BEAR[b]), sb = Math.sin(BEAR[b]);
        const bx = hx * cb - hz * sb, bz = hz * cb + hx * sb;
        let sl = -1e9;
        for (let k = 0; k < SCAN_T.length; k++) {
          const t = look * SCAN_T[k], d = vh * t;
          env.ground(pos.x + bx * d, pos.z + bz * d, gi);
          if (b === 0 && t <= horizon && gi.y > gNear) gNear = gi.y;
          sl = Math.max(sl, (gi.y + margin - pos.y) / d);
        }
        this.scanSlope[b] = sl;
        const cost = sl + Math.abs(BEAR[b]) * 0.08;
        if (cost < bestCost) { bestCost = cost; best = b; }
        if (b === 0 && sl <= climbCap * 0.6) break;       // straight ahead is fine
      }
      env.ground(pos.x, pos.z, gi);
      this.scanNear = Math.max(gNear, gi.y); this.scanHere = gi.y;
      if (this.scanSlope[0] > climbCap * 0.6 && best > 0) {
        // cannot (or should not) out-climb what is ahead: commit to the lowest gap
        const ang = BEAR[best] * 1.25, cb = Math.cos(ang), sb = Math.sin(ang);
        if (this.avoidT <= 0) { this.avoidVec.set(hx * cb - hz * sb, 0, hz * cb + hx * sb); this.avoidSlope = this.scanSlope[best]; }
        this.avoidT = 2.5;
      }
    }
    let slopeS = this.scanSlope[0];
    const floorClear = pos.y - this.scanNear - margin;    // spare height above the margin
    let danger = clamp(1.6 - floorClear / Math.max(pullLoss, 25), 0, 1);
    if (pos.y - this.scanHere < margin * 0.5) danger = 1;
    if (this.avoidT > 0) {
      this.avoidT -= dt;
      const keepY = want.y;
      want.copy(this.avoidVec);
      want.y = Math.max(keepY, 0.05); want.normalize();
      slopeS = Math.min(slopeS, Math.max(this.avoidSlope, 0));
      maxPull = Math.max(maxPull, 0.75);
    }
    // never ask for a climb the aircraft cannot hold: it would stall into the hill
    const needSin = Math.sin(Math.atan(Math.min(slopeS, climbCap * 1.3, 2.5)) + 0.06);
    if (slopeS > -0.05 && want.y < needSin) {
      const hl = Math.hypot(want.x, want.z) || 1, c = Math.sqrt(Math.max(0, 1 - needSin * needSin));
      want.set(want.x / hl * c, needSin, want.z / hl * c);
      if (slopeS > 0.05) { throttle = 1; inp.brake = false; }
    }
    this.avoiding = danger > 0.05;
    if (danger > 0.05) {
      tmp.set(hx, 0.7, hz).normalize();
      want.lerp(tmp, danger).normalize();
      throttle = 1; maxPull = 1; inp.brake = false;
      if (danger > 0.3) this.wantFire = false;
    }

    // ---- fly toward `want` ----
    // acceleration needed to swing the nose onto `want`, plus gravity → where the
    // lift vector must point; roll onto it and pull that many g.
    const lz = want.dot(fwd);
    const off = Math.acos(clamp(lz, -1, 1));
    tmp.copy(want).addScaledVector(fwd, -lz);            // component of want ⟂ nose
    const pl = tmp.length();
    const aCmd = Math.min(V * off / 0.55, s.gMax * G * maxPull);
    if (pl > 1e-5) tmp.multiplyScalar(aCmd / pl); else tmp.set(0, 0, 0);
    tmp.y += G; tmp.addScaledVector(fwd, -G * fwd.y);     // + gravity compensation ⟂ nose
    const Lr = tmp.dot(right), Lu = tmp.dot(up);
    const rollErr = Math.atan2(Lr, Lu);
    const Lmag = Math.hypot(Lr, Lu);
    // roll-rate command with damping (a plain P gain here oscillates through the control lags)
    let roll = clamp((rollErr * 3.2 - (fm.wr || 0) * 0.45) / s.rollRate, -1, 1);
    const aligned = Math.cos(rollErr);
    let pitch;
    if (aligned > 0) pitch = clamp((Lmag * aligned * aligned - G * clamp(up.y, 0, 1)) / ((s.gMax - 1) * G), -0.4, maxPull);
    else pitch = Lmag < 1.5 * G ? clamp(Lmag * aligned / ((s.gNeg + 1) * G), -0.5, 0) : 0;
    // small errors: push/pull directly instead of rolling a long way round
    if (off < 0.12 && Math.abs(rollErr) > 1.2 && danger < 0.05) {
      roll = clamp((-Math.atan2(-right.y, up.y) * 3 - (fm.wr || 0) * 0.45) / s.rollRate, -1, 1);
      pitch = clamp(want.dot(up) * 6, -0.5, 0.5);
    }
    inp.yaw = off < 0.06 ? clamp(want.dot(right) * 8, -1, 1) : 0;
    // do not pull the aircraft below fighting speed unless the ground demands it
    if (danger < 0.05 && V < s.vStall * 1.3) pitch = Math.min(pitch, 0.12);

    const k = Math.min(1, dt * (5 + 6 * this.skill));
    inp.pitch += (pitch - inp.pitch) * k;
    inp.roll += (roll - inp.roll) * k;
    inp.throttle = throttle;
    return inp;
  }
}
