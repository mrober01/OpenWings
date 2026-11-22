// FlightModel.js — flight dynamics shared by the player and AI aircraft.
//
// Everything is per unit mass (accelerations), real gravity, SI units.
//   lift  = g · qn · CLn(α)          qn = ρ (V / Vstall)²  = max g available
//   drag  = g · qn · (cd0 + kn·CLn²) cd0 derived so thrust = drag at vMax
// Pitch is a G-command loop (fly-by-wire style): stick sets a target load
// factor on top of "hold the flight path", so a centred stick flies straight.
// Corner speed, sustained turn rate, stall and glide all fall out of the spec.
//
// Input convention (all -1..1):  pitch + = pull / nose up,  roll + = right,
// yaw + = nose right, throttle 0..1 (top 8 % = afterburner where fitted),
// brake = airbrake (in flight and on the ground) + wheel brakes on the ground.
//
// Carrier ops (driven by Game.js, geometry in world/Carrier.js): `cat` holds the aircraft on a catapult
// and then flings it down the stroke; `arrest` is a caught wire that stops it in a fixed run-out;
// `hookDown` lowers the tail hook. Flying into the side of the ship below deck level is a crash.
import * as THREE from 'three';
import { clamp } from './utils.js';

const G = 9.81;
const SUBSTEP = 1 / 100;
export const AB_DETENT = 0.92;

const fwd = new THREE.Vector3(), up = new THREE.Vector3(), right = new THREE.Vector3();
const vhat = new THREE.Vector3(), liftDir = new THREE.Vector3(), tmp = new THREE.Vector3();
const dq = new THREE.Quaternion();
const gi = { y: 0, water: false, runway: false, slope: 0, carrier: null };
const gi2 = { y: 0, water: false, runway: false, slope: 0, carrier: null };

/**
 * Air density relative to sea level. Troposphere: scale height 9 km; above the tropopause
 * (11 km) the air thins faster (6.3 km scale height): ~0.07 at 20 km, ~0.015 at 30 km.
 * Lift, drag, control authority and air-breathing thrust all fall with it.
 */
export function airDensity(y) {
  if (y <= 0) return 1;
  if (y < 11000) return Math.exp(-y / 9000);
  return 0.2956 * Math.exp(-(y - 11000) / 6340);
}
/** Below this density an air-breathing jet flames out (~26.5 km); it relights under RELIGHT_RHO. */
export const FLAMEOUT_RHO = 0.025, RELIGHT_RHO = 0.055;

function liftCurve(x) {
  const ax = Math.abs(x);
  if (ax <= 1) return x;
  const s = x < 0 ? -1 : 1;
  if (ax < 2) return s * (1 - 0.45 * (ax - 1));
  return s * 0.55 * Math.max(0, 1 - (ax - 2) * 0.3);
}

export class FlightModel {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.isHelicopter = spec.type === 'heli';
    this.assist = opts.assist !== false;
    // zero-lift drag so that full thrust balances drag at vMax (sea level)
    const tMax = this.thrustAt(spec.vMax, 1, 1, true);
    // (minus the induced drag still present at that speed, which matters for slow aircraft)
    const qTop = Math.pow(spec.vMax / Math.max(spec.vStall, 1), 2);
    this.cd0 = Math.max(tMax / G - spec.kn / qTop, 0.2 * tMax / G) / qTop;
    this.velocity = new THREE.Vector3();
    this.events = [];
    this.reset();
  }

  reset() {
    this.velocity.set(0, 0, 0);
    this.throttle = 0;
    this.thrEff = 0;         // spooled engine output 0..1
    this.ab = false;         // afterburner lit
    this.gearDown = true;
    this.gearPos = 1;
    this.onGround = true;
    this.onRunway = false;
    this.stalled = false;
    this.crashed = null;     // reason string when destroyed by impact
    this.destroyed = false;
    this.aoa = 0; this.beta = 0;
    this.gForce = 1;
    this.altitudeAGL = 0;
    this.speed = 0; this.ias = 0; this.mach = 0; this.vs = 0;
    this.fuel = 100;
    this.engineHealth = 1;   // damage: thrust scale
    this.rollBias = 0;       // damage: uncommanded roll
    this.wp = 0; this.wy = 0; this.wr = 0; // body rates: pitch-up, yaw-right, roll-right
    this.airbrake = 0;
    this.buffet = 0;
    this.flameout = false;   // air-breathing engine died in the thin air (relights lower down)
    this.boost = 0;          // external rocket thrust (m/s², along the nose) — hung missile motors
    this.boostYaw = 0;       // yaw rate from asymmetric rocket thrust (rad/s, + = nose right)
    this.rcs = 0;            // 0..1 rocket attitude control (wingtip RCS hack, set by Game) where the air is thin
    this.rho = 1;
    this.hookDown = false; this.hookPos = 0;   // tail hook (carrier landings)
    this.cat = null;         // { dirX, dirZ, speed, accel, stroke, dist, fired } while on a catapult
    this.arrest = null;      // { v0, run, s } while an arrestor wire has the hook
    this.onCarrier = null;   // the Carrier whose deck we are rolling on
    this.events.length = 0;
  }

  /** Thrust acceleration (m/s²). */
  thrustAt(V, power, rho, ab) {
    const s = this.spec;
    if (s.type === 'prop') return G * s.twr * power * (s.propVp / (s.propVp + V)) * rho;
    return G * s.twr * power * Math.pow(rho, 0.7) * (ab ? s.ab : 1);
  }

  step(obj, input, dt, env) {
    if (this.destroyed) return;
    const n = Math.max(1, Math.ceil(dt / SUBSTEP));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      if (this.isHelicopter) this.stepHeli(obj, input, h, env);
      else this.stepPlane(obj, input, h, env);
      if (this.crashed) break;
    }
  }

  systems(input, h) {
    const s = this.spec;
    this.throttle = clamp(input.throttle, 0, 1);
    const hasAB = s.ab > 1;
    let power = hasAB ? Math.min(this.throttle / AB_DETENT, 1) : this.throttle;
    if (this.fuel <= 0) power = 0;
    // jets need air: flame out near space, relight once back in thicker air
    if (s.type === 'jet') {
      if (!this.flameout && this.rho < FLAMEOUT_RHO) { this.flameout = true; this.events.push({ type: 'flameout' }); }
      else if (this.flameout && this.rho > RELIGHT_RHO) { this.flameout = false; this.events.push({ type: 'relight' }); }
      if (this.flameout) power = 0;
    }
    const tau = s.type === 'prop' ? 0.5 : 1.3;
    this.thrEff += (power - this.thrEff) * Math.min(1, h / tau);
    this.ab = hasAB && this.throttle > AB_DETENT + 0.02 && this.thrEff > 0.93 && this.fuel > 0 && !this.flameout;
    this.fuel = Math.max(0, this.fuel - h * s.fuelBurn * (0.12 + this.thrEff) * (this.ab ? 3.2 : 1));
    this.gearPos += clamp((this.gearDown ? 1 : 0) - this.gearPos, -h / 2.5, h / 2.5);
    this.hookPos += clamp((this.hookDown ? 1 : 0) - this.hookPos, -h / 1.2, h / 1.2);
  }

  basis(q) {
    fwd.set(0, 0, -1).applyQuaternion(q);
    up.set(0, 1, 0).applyQuaternion(q);
    right.set(1, 0, 0).applyQuaternion(q);
  }

  rotate(obj, h) {
    tmp.set(this.wp, -this.wy, -this.wr);
    const ang = tmp.length() * h;
    if (ang > 1e-7) {
      dq.setFromAxisAngle(tmp.normalize(), ang);
      obj.quaternion.multiply(dq).normalize();
    }
  }

  stepPlane(obj, input, h, env) {
    const s = this.spec, v = this.velocity, pos = obj.position;
    this.systems(input, h);
    this.basis(obj.quaternion);

    const V = v.length();
    const rho = this.rho = airDensity(pos.y);
    const flap = this.gearPos;
    const vs = s.vStall * (1 - 0.15 * flap);
    const qn = rho * (V / vs) * (V / vs);
    if (V > 2) vhat.copy(v).multiplyScalar(1 / V); else vhat.copy(fwd);
    const vf = v.dot(fwd), vu = v.dot(up), vr = v.dot(right);
    const alpha = V > 3 ? Math.atan2(-vu, Math.max(vf, 0.01)) : 0;
    const beta = V > 3 ? Math.asin(clamp(vr / V, -1, 1)) : 0;
    this.aoa = alpha; this.beta = beta;

    const as = s.alphaStall;
    const clN = liftCurve(alpha / as);
    const L = G * qn * clN;
    liftDir.copy(up).addScaledVector(vhat, -up.dot(vhat));
    if (liftDir.lengthSq() > 1e-6) liftDir.normalize(); else liftDir.copy(up);

    const bank = Math.atan2(-right.y, up.y);
    const pitchAng = Math.asin(clamp(fwd.y, -1, 1));
    const auth = clamp(Math.sqrt(qn), 0, 1);
    const authR = clamp((V / Math.max(vs, 1) - 0.25) / 0.75, 0, 1);
    const assist = this.assist || s.fbw;
    const limiter = this.assist;
    let wPitch, wRoll, wYaw;
    const stalledNow = Math.abs(alpha) > as * 1.03 && V > 5 && !this.onGround;

    if (this.onGround) {
      // --- ground handling: direct rotation, nose-wheel steering ---
      const canRotate = V > 0.72 * vs && !this.cat;
      if (input.pitch > 0.05 && canRotate) wPitch = pitchAng < 0.21 ? input.pitch * 0.28 : 0;
      // taildraggers sit nose-high at rest and the tail comes up as the speed builds
      // catapult: the nose strut extends during the stroke, so the jet leaves the bow already at a flying attitude
      else if (this.cat && this.cat.fired) wPitch = clamp((0.13 * clamp(V / this.cat.speed, 0, 1) - pitchAng) * 4, -0.5, 0.5);
      else wPitch = clamp(((s.tailSit || 0) * (1 - clamp((V / vs - 0.3) / 0.3, 0, 1)) - pitchAng) * 2.5, -0.3, 0.3);
      wRoll = clamp(-bank * 6, -2, 2);
      const steer = this.cat || this.arrest ? 0 : clamp(input.yaw + input.roll, -1, 1);
      wYaw = steer * 0.55 * clamp(V / 6, 0, 1) * (22 / Math.max(V, 22));
    } else {
      // --- G-command pitch loop ---
      const gn = G * liftDir.y;
      let aTrim = gn;
      if (this.assist) {
        const cosg = Math.sqrt(Math.max(0, 1 - vhat.y * vhat.y));
        if (cosg > 0.2 && liftDir.y > 0) {
          const cosPhi = liftDir.y / cosg;
          const w = clamp((cosPhi - 0.15) / 0.25, 0, 1);
          const comp = Math.min(G * cosg * cosg / Math.max(liftDir.y, 0.05), 2.6 * G);
          aTrim = gn + (comp - gn) * w;
        }
      }
      const aAvail = G * qn;
      // speed stability: hands-off the wing will not hold 1 g right down to the
      // stall, so the nose drops and the aircraft accelerates instead of mushing
      aTrim = Math.min(aTrim, 0.72 * aAvail);
      // ...and a slow climb it cannot sustain is eased off before it gets there
      if (vhat.y > 0) aTrim *= 1 - 0.35 * clamp((1.6 - V / vs) / 0.5, 0, 1) * clamp(vhat.y * 8, 0, 1);
      const nCmd = input.pitch > 0 ? input.pitch * (s.gMax - 1) : input.pitch * (s.gNeg + 1);
      let aT = aTrim + nCmd * G;
      const lim = limiter ? 0.96 : 1.35;
      aT = clamp(aT, -0.6 * lim * aAvail, lim * aAvail);
      aT = clamp(aT, -s.gNeg * G, s.gMax * G);
      const Vc = Math.max(V, 30);
      wPitch = (aT - gn) / Vc + 2.0 * (aT - L) / Vc;
      wPitch = clamp(wPitch, -s.pitchRate * auth, s.pitchRate * auth);
      // weathervane when there is no airflow to steer with
      wPitch += (1 - auth) * -alpha * 1.5;
      if (stalledNow) wPitch -= Math.sign(alpha) * (Math.abs(alpha) - as) * 2.2 + 0.12 * Math.sign(alpha);

      wRoll = input.roll * s.rollRate * authR;
      if (assist && Math.abs(input.roll) < 0.04 && up.y > 0 && Math.abs(bank) < 0.16) wRoll -= bank * 1.4 * authR;
      wRoll += this.rollBias * authR;
      if (stalledNow && !limiter) {
        if (!this._stallDir) this._stallDir = Math.random() < 0.5 ? -1 : 1;
        wRoll += this._stallDir * 0.9;
      } else this._stallDir = 0;
      wYaw = input.yaw * 0.35 * auth + clamp(beta, -0.5, 0.5) * 3.2 * Math.max(authR, 0.15) + this.boostYaw;
      // wingtip rocket thrusters: where the wings have nothing to bite on, the stick commands body
      // rates directly (hands off = hold attitude) instead of the nose drifting onto the flight path
      const kc = this.rcs * (1 - Math.min(auth, authR));
      if (kc > 0) {
        wPitch += (input.pitch * s.pitchRate * 0.7 - wPitch) * kc;
        wRoll += (input.roll * s.rollRate * 0.5 - wRoll) * kc;
        wYaw += (input.yaw * 0.5 + this.boostYaw - wYaw) * kc;
      }
    }

    const kr = Math.min(1, h / 0.09);
    this.wp += (wPitch - this.wp) * kr;
    this.wr += (wRoll - this.wr) * Math.min(1, h / 0.12);
    this.wy += (wYaw - this.wy) * kr;
    this.rotate(obj, h);

    // --- forces ---
    // the speed brake opens on the ground too (rollout), where B also works the wheel brakes
    this.airbrake += ((input.brake ? 1 : 0) - this.airbrake) * Math.min(1, h / 0.4);
    const sa = Math.sin(alpha);
    let cd = this.cd0 * (1 + 1.3 * this.gearPos + 3.0 * this.airbrake) + s.kn * clN * clN;
    if (Math.abs(alpha) > as) cd += 0.7 * sa * sa;
    const D = G * qn * cd;
    const side = -G * Math.min(qn, 6) * clamp(beta, -0.4, 0.4) * 1.6;
    const T = this.thrustAt(V, this.thrEff, rho, this.ab) * this.engineHealth;

    v.addScaledVector(fwd, (T + this.boost) * h);
    v.addScaledVector(liftDir, L * h);
    v.addScaledVector(vhat, -D * h);
    v.addScaledVector(right, side * h);
    v.y -= G * h;
    pos.addScaledVector(v, h);

    // --- ground contact ---
    env.ground(pos.x, pos.z, gi);
    const gearH = s.bellyH + s.gearH * this.gearPos - (s.tailSit ? s.sitDrop * clamp(pitchAng / s.tailSit, 0, 1) * this.gearPos : 0);
    const floor = gi.y + gearH;
    // on a catapult the shuttle holds the jet down on the deck
    if (pos.y <= floor + 0.02 || (this.cat && this.onGround)) {
      if (this.cat && this.onGround) pos.y = floor;
      if (!this.onGround) {
        env.ground(pos.x + v.x * 0.1, pos.z + v.z * 0.1, gi2);
        const sink = -v.y + Math.max(0, (gi2.y - gi.y) / 0.1);
        let why = null;
        if (gi.carrier && floor - pos.y > 1.2) why = 'ship';       // below deck level: hit the side / round-down
        else if (gi.water) why = 'water';
        else if (this.gearPos < 0.9) why = 'gear';
        else if (sink > s.crashSink) why = 'impact';
        else if (Math.abs(bank) > 0.32 || pitchAng < -0.16 || pitchAng > 0.45) why = 'attitude';
        else if (gi.slope > 0.28) why = 'terrain';
        if (why) { this.crash(why); pos.y = floor; return; }
        this.onGround = true;
        this.events.push({ type: 'touchdown', sink, runway: gi.runway, speed: V });
      }
      if (pos.y < floor) pos.y = floor;
      if (v.y < 0) v.y = 0;
      this.onRunway = gi.runway;
      this.onCarrier = gi.carrier;
      if ((gi.water && V > 2) || (gi.slope > 0.32 && V > 14)) { this.crash(gi.water ? 'water' : 'terrain'); return; }
      // tyres: no sideways slip, rolling resistance, brakes
      tmp.set(right.x, 0, right.z);
      if (tmp.lengthSq() > 1e-4) {
        tmp.normalize();
        v.addScaledVector(tmp, -v.dot(tmp) * Math.min(1, 12 * h));
      }
      if (this.cat) this.catapult(h);
      const braking = !this.cat && (input.brake || (this.assist && this.throttle < 0.03));
      const dec = G * ((gi.runway ? 0.016 : 0.06) + (braking ? 0.42 : 0));
      const vh = Math.hypot(v.x, v.z);
      if (vh > 1e-3) {
        const k = Math.max(0, vh - dec * h) / vh;
        v.x *= k; v.z *= k;
      }
      if (vh < 0.6 && this.throttle < 0.08) { v.x = 0; v.z = 0; }
    } else if (this.onGround && pos.y > floor + 0.12) {
      this.onGround = false; this.onRunway = false;
      this.events.push({ type: 'liftoff', carrier: this.onCarrier, cat: !!this.cat });
      this.onCarrier = null;
      if (this.cat) { this.cat = null; this.events.push({ type: 'catEnd' }); }
    }
    if (this.arrest) this.arrested(h);

    this.finish(pos, V, rho, this.onGround ? 1 : L / G, gi.y + gearH, stalledNow);
  }

  stepHeli(obj, input, h, env) {
    const s = this.spec, v = this.velocity, pos = obj.position;
    this.systems(input, h);
    this.basis(obj.quaternion);
    const V = v.length();
    const rho = this.rho = airDensity(pos.y);
    const bank = Math.atan2(-right.y, up.y);
    const pitchAng = Math.asin(clamp(fwd.y, -1, 1));

    // attitude-command cyclic: stick sets tilt, releases to level
    let wPitch = clamp((input.pitch * 0.5 - pitchAng) * 3.2, -1.4, 1.4);
    let wRoll = clamp((input.roll * 0.65 - bank) * 3.2, -1.8, 1.8);
    let wYaw = input.yaw * 1.1 + Math.sin(bank) * clamp(V / 22, 0.35, 1) * 0.9;
    if (this.onGround) { wPitch = -pitchAng * 4; wRoll = -bank * 4; if (this.thrEff < 0.3) wYaw = 0; }
    const k = Math.min(1, h / 0.12);
    this.wp += (wPitch - this.wp) * k; this.wr += (wRoll - this.wr) * k; this.wy += (wYaw - this.wy) * k;
    this.rotate(obj, h);

    const T = G * (0.3 + 1.4 * this.thrEff) * rho * this.engineHealth * (this.fuel > 0 ? 1 : 0.4);
    v.addScaledVector(up, T * h);
    v.addScaledVector(fwd, this.boost * h);
    v.y -= G * h;
    const cdh = G * 0.6 / (s.vMax * s.vMax);
    v.addScaledVector(v, -(cdh * V + 0.03) * h);
    v.y -= v.y * 0.3 * h; // rotor damping in the vertical
    pos.addScaledVector(v, h);

    env.ground(pos.x, pos.z, gi);
    const floor = gi.y + s.bellyH;
    if (pos.y <= floor + 0.02) {
      if (!this.onGround) {
        const sink = -v.y;
        const tilt = Math.max(Math.abs(bank), Math.abs(pitchAng));
        const vh = Math.hypot(v.x, v.z);
        if (gi.water || sink > 6 || tilt > 0.4 || vh > 14 || gi.slope > 0.3) {
          this.crash(gi.water ? 'water' : 'impact'); pos.y = floor; return;
        }
        this.onGround = true;
        this.events.push({ type: 'touchdown', sink, runway: gi.runway, speed: V });
      }
      if (pos.y < floor) pos.y = floor;
      if (v.y < 0) v.y = 0;
      this.onRunway = gi.runway;
      const kf = Math.max(0, 1 - 4 * h);
      v.x *= kf; v.z *= kf;
    } else if (this.onGround && pos.y > floor + 0.12) {
      this.onGround = false; this.onRunway = false;
      this.events.push({ type: 'liftoff' });
    }
    this.aoa = 0; this.beta = 0;
    this.finish(pos, V, rho, T / G, floor, false);
  }

  finish(pos, V, rho, g, floor, stalled) {
    this.speed = V;
    this.ias = V * Math.sqrt(rho);
    this.mach = V / (340 - Math.min(pos.y, 11000) * 0.0041);
    this.vs = this.velocity.y;
    this.altitudeAGL = Math.max(0, pos.y - floor);
    this.gForce += (g - this.gForce) * 0.12;
    this.stalled = stalled;
    const lim = this.spec.alphaStall;
    this.buffet = this.onGround ? 0 : clamp((Math.abs(this.aoa) - lim * 0.8) / (lim * 0.3), 0, 1);
  }

  /** On a catapult: held by the holdback bar until fired, then driven down the stroke at constant g. */
  catapult(h) {
    const c = this.cat, v = this.velocity;
    if (!c.fired) { v.x = 0; v.z = 0; return; }
    const along = Math.max(0, v.x * c.dirX + v.z * c.dirZ);
    const nv = Math.min(c.speed, along + c.accel * h);
    v.x = c.dirX * nv; v.z = c.dirZ * nv;
    c.dist += nv * h;
    if (c.dist >= c.stroke) {
      // shuttle at the end of the track: the launch bar drops off; a little nose-up kick as the jet leaves
      this.cat = null;
      this.events.push({ type: 'catEnd', speed: nv });
    }
  }

  /** A wire has the hook: speed falls as sqrt(1 - s/run) (constant deceleration), whatever the throttle. */
  arrested(h) {
    const a = this.arrest, v = this.velocity;
    const vh = Math.hypot(v.x, v.z);
    if (a.s >= a.run || vh < 0.4) {
      v.x = 0; v.z = 0;
      if (!a.stopped) { a.stopped = true; this.events.push({ type: 'arrested' }); }
      return;
    }
    a.s += vh * h;
    const want = a.v0 * Math.sqrt(Math.max(0, 1 - a.s / a.run));
    if (want < vh) { const k = want / vh; v.x *= k; v.z *= k; }
  }

  crash(reason) {
    this.crashed = reason;
    this.destroyed = true;
    this.events.push({ type: 'crash', reason });
  }

  /** Put the aircraft in a clean airborne state. */
  setAirborne(obj, speed) {
    this.onGround = false; this.onCarrier = null; this.cat = null; this.arrest = null;
    this.gearDown = false; this.gearPos = 0;
    this.thrEff = 0.75; this.throttle = 0.75;
    fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
    this.velocity.copy(fwd).multiplyScalar(speed);
  }
}
