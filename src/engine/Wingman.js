// Wingman.js — a friendly jet that flies formation on the player and does show-off stunts.
//
// The wingman is NOT flown through the FlightModel: holding a slot a few metres off your wing
// through every roll and 9 g pull needs better than stick inputs. Instead it rides a spring:
//   slot  = a point fixed in the player's frame (x right, y up, z aft — metres)
//   error = wingman − slot, driven to zero by a critically damped spring whose acceleration and
//           closing speed are limited, so a wingman 1.5 km behind accelerates, catches up, and
//           settles into the slot like a real join-up.
// Far from the slot it banks into its own turns (coordinated flight from its acceleration); near
// the slot it takes the leader's attitude plus the stunt's extra roll.
// Stunts are keyframed slot offsets / roll / pilot wave in the player frame, starting from
// wherever the slot currently is, so commands can interrupt each other smoothly.
// It never crashes (ground / roof floor) and is not shot at (Game skips `u.wingman`).
import * as THREE from 'three';
import { makeAircraft } from './Entities.js';
import { clamp } from './utils.js';

const G = 9.81;
export const WING_CMDS = ['toggle', 'side', 'wave', 'inverted', 'barrel', 'roll', 'smoke'];
export const WING_LABELS = {
  toggle: 'WINGMAN', side: 'SWAP SIDE', wave: 'CLOSE IN & WAVE', inverted: 'INVERTED OVERHEAD',
  barrel: 'BARREL ROLL AROUND YOU', roll: 'VICTORY ROLL', smoke: 'SMOKE',
};
// radio calls (toasts)
const CALLS = {
  wave: 'TWO · "COMING IN CLOSE — WAVE HELLO!"', inverted: 'TWO · "GOING INVERTED. HOLD HER STEADY!"',
  barrel: 'TWO · "ROLLING AROUND YOU — KEEP IT STRAIGHT AND LEVEL"', roll: 'TWO · "VICTORY ROLL!"',
};

const _T = new THREE.Vector3(), _Tv = new THREE.Vector3(), _acc = new THREE.Vector3(), _o = new THREE.Vector3();
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Quaternion(), _qf = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qr = new THREE.Quaternion();
const _m = new THREE.Matrix4(), _e = new THREE.Euler(), _box = new THREE.Box3();
const Z = new THREE.Vector3(0, 0, 1);
const gi = { y: 0, water: false, runway: false, slope: 0 }, gi2 = { y: 0, water: false, runway: false, slope: 0 };
const ss = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

/** Half-width, top, length of an aircraft mesh in its own frame (gear down; rotors included). */
function extents(obj) {
  const p = obj.position.clone(), q = obj.quaternion.clone();
  obj.position.set(0, 0, 0); obj.quaternion.identity(); obj.updateMatrixWorld(true);
  _box.setFromObject(obj);
  obj.position.copy(p); obj.quaternion.copy(q); obj.updateMatrixWorld(true);
  return { hw: Math.max(-_box.min.x, _box.max.x), top: _box.max.y, bot: -_box.min.y, hl: Math.max(-_box.min.z, _box.max.z) };
}

export class Wingman {
  constructor(game) {
    this.game = game;
    this.unit = null;
    this.side = 1;               // +1 right wing, −1 left wing
    this.smoke = false;
    this.off = new THREE.Vector3();      // current slot offset (player frame)
    this.e = new THREE.Vector3();        // position error vs. the slot target
    this.ev = new THREE.Vector3();       // velocity error
    this.Tprev = new THREE.Vector3(); this.hasPrev = false;
    this.vPrev = new THREE.Vector3(); this.accS = new THREE.Vector3();
    this.stunt = null; this.roll = 0; this.wave = 0; this.waveArm = 1; this.w = 1.6;
    this.mode = 'form';          // form | orbit
    this.orbitC = new THREE.Vector3(); this.orbitA = 0;
    this.puffD = 0; this.arm = null; this.armK = 0;
    this.pending = null;         // stunt ordered while still joining up: flown on arrival
    this.spread = 0;             // 0..1 formation loosening while the leader manoeuvres hard
    this.showing = false;        // the showpiece moment of a stunt (Game turns the cockpit view to watch)
  }

  get active() { return !!(this.unit && this.unit.alive); }

  /** Mission start: the old unit went with game.units; forget it. */
  reset() { this.unit = null; this.stunt = null; this.smoke = false; this.arm = null; this.pending = null; this.showing = false; this.spread = 0; }

  /* ------------------------------------------------------------ spawn / dismiss */

  spawn() {
    const g = this.game, p = g.player;
    if (!p || this.active) return;
    const u = makeAircraft(p.key, 0, { lod: 'full', score: 0 });
    u.wingman = true; u.name = 'WINGMAN'; u.ai = null;
    this.unit = u;
    this.sz = { me: extents(u.obj), lead: extents(p.obj) };
    this.buildArm();
    this.stunt = null; this.roll = 0; this.wave = 0; this.armK = 0; this.pending = null; this.spread = 0; this.mode = 'form';
    this.setSlot(this.off);
    this.hasPrev = false;
    // parked beside the player on the runway → formation take-off; otherwise arrive from behind
    const env = g.env, fm = p.fm;
    let parked = false;
    if (fm.onGround && !fm.onCarrier) {
      this.target(_T);
      env.ground(_T.x, _T.z, gi);
      env.ground(p.pos.x, p.pos.z, gi2);
      parked = !gi.water && Math.abs(gi.y - gi2.y) < 2.5 && !env.buildingAt(_T.x, gi.y + 3, _T.z, this.sz.me.hw);
      if (parked) {
        u.obj.position.set(_T.x, gi.y + u.spec.bellyH + u.spec.gearH, _T.z);
        u.obj.quaternion.copy(p.obj.quaternion);
        u.fm.gearPos = 1; u.fm.gearDown = true; u.fm.onGround = true;
        u.fm.velocity.copy(p.vel);
      }
    }
    if (!parked) {
      _f.set(0, 0, -1).applyQuaternion(p.obj.quaternion); _f.y = 0;
      if (_f.lengthSq() < 1e-4) _f.set(0, 0, -1); _f.normalize();
      const y = Math.max(p.pos.y + 30, env.groundHeight(p.pos.x, p.pos.z) + 400);
      u.obj.position.set(p.pos.x - _f.x * 1200 + _f.z * 250 * this.side, y, p.pos.z - _f.z * 1200 - _f.x * 250 * this.side);
      u.obj.quaternion.setFromEuler(_e.set(0, Math.atan2(-_f.x, -_f.z), 0));
      const v = Math.max(p.fm.speed, u.spec.vStall * 2);
      u.fm.velocity.copy(_f).multiplyScalar(v);
      u.fm.gearPos = 0; u.fm.gearDown = false; u.fm.onGround = false;
    }
    u.fm.thrEff = u.fm.throttle = 0.8;
    // spring state relative to wherever the slot target is
    this.target(_T);
    this.e.copy(u.pos).sub(_T); this.ev.copy(u.vel).sub(p.vel);
    this.vPrev.copy(u.vel); this.accS.set(0, 0, 0);
    g.scene.add(u.obj);
    g.units.push(u);
    g.say(parked ? `TWO · "ON YOUR ${this.side > 0 ? 'RIGHT' : 'LEFT'}, READY TO ROLL"` : 'TWO · "JOINING UP ON YOU"', 'good');
  }

  dismiss() {
    const g = this.game, u = this.unit;
    if (!u) return;
    u.alive = false; g.removeObj(u); u.gone = true;
    const i = g.units.indexOf(u); if (i >= 0) g.units.splice(i, 1);
    this.unit = null; this.arm = null; this.pending = null; this.showing = false;
    g.say('TWO · "HEADING HOME. FIRST ROUND\'S ON ME!"');
  }

  /* ------------------------------------------------------------ commands */

  command(cmd) {
    const g = this.game;
    if (cmd === 'toggle') {
      if (this.active) this.dismiss(); else this.spawn();
      g.settings.set('wingman', this.active);
      return;
    }
    if (!this.active) { g.say('NO WINGMAN · CALL ONE FIRST (WINGMAN MENU → 1)', 'warn'); return; }
    if (cmd === 'smoke') { this.smoke = !this.smoke; g.say(this.smoke ? 'TWO · "SMOKE ON!"' : 'TWO · "SMOKE OFF"'); return; }
    if (cmd === 'side') { this.side = -this.side; this.startStunt('side'); g.say(`TWO · "CROSSING TO YOUR ${this.side > 0 ? 'RIGHT' : 'LEFT'}"`); return; }
    if (!this.joined) { this.pending = cmd; g.say('TWO · "COPY — AS SOON AS I\'M ON YOUR WING"'); return; }
    this.startStunt(cmd);
    if (CALLS[cmd]) g.say(CALLS[cmd], 'good');
  }

  /** In formation, close to the slot (stunts only start from here). */
  get joined() { return this.active && this.mode === 'form' && this.e.length() < 40 && !this.game.player.fm.onGround; }

  /** Normal formation slot: echelon a little aft and below, wingtip clearance ~0.6 span. */
  setSlot(out) {
    const a = this.sz.me, b = this.sz.lead;
    return out.set(this.side * (a.hw + b.hw + Math.max(a.hw, b.hw) * 0.55 + 3), -1.5, b.hl * 0.55 + 4);
  }

  /**
   * Build the keyframes for a stunt. Each key: { d: seconds to get there, x, y, z (slot offset),
   * roll (extra roll about the nose, rad), wave (0..1 arm raised), w (spring stiffness) }.
   * `barrel` is procedural.
   */
  startStunt(kind) {
    const a = this.sz.me, b = this.sz.lead, s = this.side;
    const slot = this.setSlot(new THREE.Vector3());
    const close = a.hw + b.hw + 2.2;                       // wingtip clearance ~2 m
    const over = a.top + b.top + 2.0;                      // fin tips ~2 m apart, canopy to canopy
    const R = Math.max(close, over) + 5;
    const from = { x: this.off.x, y: this.off.y, z: this.off.z, roll: this.roll, wave: this.wave, w: this.w };
    const K = (d, x, y, z, roll = 0, wave = 0, w = 2.4) => ({ d, x, y, z, roll, wave, w });
    let keys;
    switch (kind) {
      case 'side':
        // drop below and slide across behind the leader
        keys = [K(1.8, 0, -Math.max(over, 8), slot.z + 6, 0, 0, 1.8), K(2.2, slot.x, slot.y, slot.z, 0, 0, 1.8)];
        break;
      case 'wave':
        this.waveArm = -s;                                  // the arm on the leader's side
        keys = [K(3.2, s * close, 0, 0.5, 0, 0, 3.2), K(0.6, s * close, 0, 0, 0, 0, 3.6),
          // rock the wings to say hello, then wave
          K(0.5, s * close, 0, 0, -0.32 * s, 0, 3.6), K(0.6, s * close, 0, 0, 0.32 * s, 0, 3.6), K(0.6, s * close, 0, 0, -0.32 * s, 0, 3.6), K(0.5, s * close, 0, 0, 0, 0, 3.6),
          K(0.7, s * close, 0, 0, 0, 1, 3.6), K(4.2, s * close, 0, 0, 0, 1, 3.6), K(0.6, s * close, 0, 0, 0, 0, 3.6),
          K(3.2, slot.x, slot.y, slot.z, 0, 0, 2)];
        break;
      case 'inverted':
        this.waveArm = 1;
        keys = [K(2.6, s * (close + 4), over + 14, 2, 0, 0, 2.6), K(2.2, 0, over + 14, 0, 0, 0, 2.8),
          K(1.6, 0, over + 14, 0, s * Math.PI, 0, 3.2),     // roll inverted well clear
          K(2.6, 0, over, 0, s * Math.PI, 0, 3.6),          // ease down, canopy to canopy
          K(0.6, 0, over, 0, s * Math.PI, 1, 3.8), K(4, 0, over, 0, s * Math.PI, 1, 3.8), K(0.5, 0, over, 0, s * Math.PI, 0, 3.8),
          K(2, 0, over + 14, 0, s * Math.PI, 0, 3), K(1.6, 0, over + 14, 0, s * 2 * Math.PI, 0, 3),
          K(3, slot.x, slot.y, slot.z, s * 2 * Math.PI, 0, 2)];
        break;
      case 'roll':
        keys = [K(0.3, slot.x, slot.y, slot.z), K(1.7, slot.x, slot.y, slot.z, -s * 2 * Math.PI, 0, 2.4), K(0.5, slot.x, slot.y, slot.z, -s * 2 * Math.PI)];
        break;
      case 'barrel': {
        // drop under the leader, then circle round its flight path with the canopy facing in
        this.waveArm = 1;
        const z = 1;
        keys = [K(2.6, s * R * 0.5, -R, z + 4, 0, 0, 2.6), K(1.2, 0, -R, z, 0, 0, 3)];
        this.barrel = { R, z, T: 6.5, s };
        break;
      }
      default: return;
    }
    let t = 0;
    for (const k of keys) { t += k.d; k.t = t; }
    // the showpiece window (s into the stunt) during which the cockpit view turns to watch
    const SHOW = { wave: [3.3, 11.3], inverted: [6.2, 14.1], roll: [0.1, 2.4] };
    this.stunt = { kind, keys, from, t: 0, show: SHOW[kind] || null };
    if (kind === 'barrel') this.stunt.barrelAt = t;
  }

  /** Advance the stunt; writes this.off / roll / wave / w. */
  stepStunt(dt) {
    if (this.pending && this.joined) {
      const c = this.pending; this.pending = null;
      this.startStunt(c);
      if (CALLS[c]) this.game.say(CALLS[c], 'good');
    }
    const st = this.stunt;
    this.showing = !!st && ((st.show && st.t >= st.show[0] && st.t <= st.show[1]) || (st.kind === 'barrel' && st.t >= st.barrelAt - 0.5));
    if (!st) { this.setSlot(_o); this.off.lerp(_o, Math.min(1, dt * 1.5)); this.roll = 0; this.wave = 0; this.w = 1.6; return; }
    st.t += dt;
    if (st.kind === 'barrel' && st.t >= st.barrelAt) {
      const bt = st.t - st.barrelAt, B = this.barrel;
      if (bt < B.T) {
        // φ from −π/2 (below) round to 3π/2; roll θ = φ + π/2 keeps the canopy pointing at the leader
        const phi = -Math.PI / 2 + B.s * 2 * Math.PI * ss(bt / B.T);
        this.off.set(B.R * Math.cos(phi), B.R * Math.sin(phi), B.z);
        this.roll = phi + Math.PI / 2; this.wave = clamp(Math.min(bt, B.T - bt) / 0.8, 0, 1); this.w = 4;
        return;
      }
      // done: go home from below
      st.kind = 'home'; st.t = 0;
      const slot = this.setSlot(new THREE.Vector3());
      st.from = { x: this.off.x, y: this.off.y, z: this.off.z, roll: 0, wave: 0, w: 3 };
      st.keys = [{ d: 3, t: 3, x: slot.x, y: slot.y, z: slot.z, roll: 0, wave: 0, w: 2 }];
    }
    let prev = st.from, k = null;
    for (const kk of st.keys) { if (st.t <= kk.t) { k = kk; break; } prev = kk; }
    if (!k) {
      // finished
      const last = st.keys[st.keys.length - 1];
      this.off.set(last.x, last.y, last.z); this.roll = 0; this.wave = 0; this.stunt = null;
      return;
    }
    const f = ss((st.t - (k.t - k.d)) / k.d);
    this.off.set(lerp(prev.x, k.x, f), lerp(prev.y, k.y, f), lerp(prev.z, k.z, f));
    this.roll = lerp(prev.roll, k.roll, f); this.wave = lerp(prev.wave, k.wave, f); this.w = lerp(prev.w, k.w, f);
  }

  /* ------------------------------------------------------------ per frame */

  /** World target point for the current slot offset (low down the frame loses its bank and pitch). */
  target(out) {
    const p = this.game.player, env = this.game.env;
    env.ground(p.pos.x, p.pos.z, gi);
    const agl = p.pos.y - gi.y;
    // near the ground use a heading-only frame so a bank does not swing the wingman into the dirt
    const hk = p.fm.onGround ? 1 : clamp(1 - (agl - 25) / 60, 0, 1);
    _qf.copy(p.obj.quaternion);
    if (hk > 0) {
      _f.set(0, 0, -1).applyQuaternion(_qf);
      _qy.setFromEuler(_e.set(0, Math.atan2(-_f.x, -_f.z), 0));
      _qf.slerp(_qy, hk);
    }
    return out.copy(this.off).multiplyScalar(1 + this.spread).applyQuaternion(_qf).add(p.pos);
  }

  update(dt) {
    const u = this.unit, g = this.game, p = g.player, env = g.env;
    if (!u || !u.alive || !p) return;
    if (dt <= 0) return;
    const fm = u.fm, pos = u.pos, s = u.spec;

    // ---- where to be ----
    const playerOk = p.alive && !g.ejection;
    const pAir = playerOk && !p.fm.onGround;
    const parkedPair = playerOk && p.fm.onGround && !p.fm.onCarrier && !this.wet && this.mode === 'form' && this.e.length() < 60;
    const mode = pAir || parkedPair ? 'form' : 'orbit';
    if (mode !== this.mode) {
      this.mode = mode; this.hasPrev = false; this.stunt = null; this.roll = 0; this.wave = 0; this.showing = false;
      if (mode === 'orbit') {
        this.orbitC.copy(p.pos); this.orbitA = Math.atan2(pos.z - p.pos.z, pos.x - p.pos.x);
        if (playerOk) g.say('TWO · "I\'LL HOLD OVERHEAD"');
      } else g.say('TWO · "REJOINING"');
    }
    // hard manoeuvring by the leader (g, roll / pitch rate): open the formation up a little, so a
    // sudden yank during a close pass does not put the wingman through your wing; close back slowly
    const agit = playerOk ? clamp(Math.max(Math.abs(p.fm.gForce - 1) / 4, Math.abs(p.fm.wr || 0) / 2.2, Math.abs(p.fm.wp || 0) / 0.6) - 0.15, 0, 1) : 0;
    this.spread += (agit * 0.7 - this.spread) * Math.min(1, dt * (agit * 0.7 > this.spread ? 6 : 0.5));
    let w, aMax, vMax;
    if (mode === 'form') {
      this.stepStunt(dt);
      this.target(_T);
      w = this.w; aMax = 28 + 50 * clamp(1 - this.e.length() / 150, 0, 1); vMax = 170;
      if (this.hasPrev) _Tv.copy(_T).sub(this.Tprev).divideScalar(dt); else _Tv.copy(p.vel);
    } else {
      // circle overhead: player on the deck / taxiing / ejected / dead
      if (playerOk) this.orbitC.lerp(p.pos, Math.min(1, dt * 0.5));
      const R = 900, V = Math.max(s.vStall * 1.9, 90);
      this.orbitA += V / R * dt;
      const ca = Math.cos(this.orbitA), sa = Math.sin(this.orbitA);
      const y = Math.max(this.orbitC.y + 450, env.groundHeight(this.orbitC.x + ca * R, this.orbitC.z + sa * R) + 450);
      _T.set(this.orbitC.x + ca * R, y, this.orbitC.z + sa * R);
      _Tv.set(-sa * V, 0, ca * V);
      w = 0.35; aMax = 25; vMax = 120;
      this.roll = 0; this.wave = 0;
    }
    // first frame in a mode: carry on from where we are (no jump onto the new target)
    if (!this.hasPrev) { this.e.copy(pos).sub(_T); this.ev.copy(fm.velocity).sub(_Tv); }
    this.Tprev.copy(_T); this.hasPrev = true;

    // ---- close the error (sub-stepped) ----
    // wanted closing speed: a braking curve far out (arrive without overshooting), linear close in
    // (with the velocity loop that is a critically damped spring of natural frequency w)
    const n = Math.ceil(dt / (1 / 60)), h = dt / n, aBrake = 14;
    const vMin = pAir ? Math.max(s.vStall * 1.25, p.fm.speed * 0.7) : 0;
    for (let i = 0; i < n; i++) {
      const el = this.e.length();
      const want = Math.min(vMax, 0.5 * w * el, Math.sqrt(2 * aBrake * el));
      _acc.copy(this.e).multiplyScalar(el > 1e-6 ? -want / el : 0).sub(this.ev).multiplyScalar(2 * w);
      const al = _acc.length(); if (al > aMax) _acc.multiplyScalar(aMax / al);
      this.ev.addScaledVector(_acc, h);
      // never slow to a crawl to drop back into the slot
      _b.copy(_Tv).add(this.ev);
      const sp = _b.length();
      if (sp < vMin && el > 30) this.ev.addScaledVector(_b, (vMin / Math.max(sp, 1) - 1));
      this.e.addScaledVector(this.ev, h);
    }
    pos.copy(_T).add(this.e);
    fm.velocity.copy(_Tv).add(this.ev);

    // ---- never into the ground, the sea or a roof ----
    const near = mode === 'form' && this.e.length() < 60;
    fm.gearPos += clamp((near ? p.fm.gearPos : 0) - fm.gearPos, -dt * 0.5, dt * 0.5);
    fm.gearDown = fm.gearPos > 0.5;
    env.ground(pos.x, pos.z, gi);
    this.wet = near && gi.water;
    let floor = gi.y + s.bellyH + s.gearH * fm.gearPos + (fm.gearPos < 0.9 ? 0.6 : 0);
    if (!near) {
      // joining / orbiting: keep a margin that shrinks as the slot gets close (the leader may be low)
      const clear = mode === 'orbit' ? 150 : clamp(this.e.length() - 40, 0, 120);
      _b.copy(fm.velocity).multiplyScalar(2.5).add(pos);
      floor = Math.max(floor, gi.y + clear, env.groundHeight(_b.x, _b.z) + clear);
    }
    const hb = env.buildingAt(pos.x, pos.y, pos.z, this.sz.me.hw);
    if (hb) floor = Math.max(floor, hb.top + this.sz.me.bot + 3);
    if (pos.y < floor) {
      const lift = floor - pos.y;
      pos.y = floor; this.e.y += lift;
      if (this.ev.y < 0) this.ev.y = 0;
      if (fm.velocity.y < 0 && !near) fm.velocity.y = 0;
    }
    fm.onGround = near && p.fm.onGround && pos.y - floor < 0.3;
    fm.onRunway = gi.runway;

    // ---- attitude ----
    _acc.copy(fm.velocity).sub(this.vPrev).divideScalar(dt);
    this.vPrev.copy(fm.velocity);
    this.accS.lerp(_acc, Math.min(1, dt * 4));
    const V = fm.velocity.length();
    // formation: the leader's attitude + stunt roll
    _qr.setFromAxisAngle(Z, this.roll);
    _qf.copy(p.obj.quaternion).multiply(_qr);
    // free flight: nose along the velocity, lift vector where the acceleration needs it
    const fk = mode === 'form' ? 1 - clamp((this.e.length() - 25) / 120, 0, 1) : 0;
    if (fk < 1 && V > 5) {
      _f.copy(fm.velocity).divideScalar(V);
      _u.copy(this.accS); _u.y += G;
      _u.addScaledVector(_f, -_u.dot(_f));
      if (_u.lengthSq() < 1e-3) _u.set(0, 1, 0).addScaledVector(_f, -_f.y);
      _u.normalize();
      _b.copy(_f).negate();
      _r.crossVectors(_u, _b).normalize();
      _m.makeBasis(_r, _u, _b);
      _q.setFromRotationMatrix(_m);
      _q.slerp(_qf, fk);
    } else _q.copy(_qf);
    u.obj.quaternion.slerp(_q, Math.min(1, dt * (near ? 16 : 5)));

    // ---- FlightModel fields the effects / animation read ----
    fm.speed = V; fm.ias = V; fm.vs = fm.velocity.y;
    _u.set(0, 1, 0).applyQuaternion(u.obj.quaternion);
    fm.gForce = clamp((this.accS.dot(_u) + G * _u.y) / G, -3, 12);
    fm.throttle = near ? p.fm.throttle : 0.95;
    fm.thrEff += ((near ? p.fm.thrEff : 0.95) - fm.thrEff) * Math.min(1, dt * 2);
    fm.ab = near ? p.fm.ab : (this.e.length() > 300 && !!s.ab);
    fm.airbrake = near ? p.fm.airbrake : 0;
    fm.hookPos = 0;
    fm.altitudeAGL = pos.y - gi.y;

    const a = p.anim, inp = this._inp || (this._inp = { pitch: 0, roll: 0, yaw: 0 });
    inp.pitch = near ? a.pitch : clamp(this.accS.dot(_u) / (s.gMax * G), -0.3, 1);
    inp.roll = near ? a.roll : 0; inp.yaw = near ? a.yaw : 0;
    g.animate(u, dt, inp);
    this.animateArm(dt);
    this.updateSmoke(dt);
  }

  /* ------------------------------------------------------------ pilot wave */

  buildArm() {
    const ud = this.unit.obj.userData;
    this.arm = null;
    if (!ud.glass || !ud.pilotAt) return;
    const suit = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x4d5a3e).multiplyScalar(2.2) });
    const glove = new THREE.MeshLambertMaterial({ color: new THREE.Color(0xe6e3d8).multiplyScalar(1.6) });
    const mk = (side) => {
      const [cx, hy, hz] = ud.pilotAt;
      const sh = new THREE.Group();
      sh.position.set(cx + side * 0.21, hy - 0.36, hz + 0.08);
      // a little oversized so the wave reads from a wingspan away
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.36, 8), suit);
      up.position.y = 0.18; sh.add(up);
      const el = new THREE.Group(); el.position.y = 0.36; sh.add(el);
      const fa = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.34, 8), suit);
      fa.position.y = 0.17; el.add(fa);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), glove);
      hand.scale.set(0.75, 1.3, 1.1); hand.position.y = 0.43; el.add(hand);
      sh.visible = false;
      ud.glass.add(sh);
      return { sh, el, side };
    };
    this.arm = { l: mk(-1), r: mk(1), t: 0 };
  }

  animateArm(dt) {
    const A = this.arm;
    if (!A) return;
    this.armK += clamp(this.wave - this.armK, -dt * 3, dt * 3);
    A.t += dt;
    for (const arm of [A.l, A.r]) {
      const k = arm.side === this.waveArm ? this.armK : 0;
      arm.sh.visible = k > 0.02;
      if (!arm.sh.visible) continue;
      // raise from hanging at the side to up (leaning out a little), then swing the forearm fore and aft:
      // seen across the wingspan or from above, that is a hand waving at you
      arm.sh.rotation.set(0, 0, -arm.side * lerp(2.7, 0.3, k));
      arm.el.rotation.set(0.6 * k * Math.sin(A.t * 8), 0, -arm.side * 0.1 * k);
    }
  }

  /* ------------------------------------------------------------ airshow smoke */

  updateSmoke(dt) {
    if (!this.smoke) return;
    const u = this.unit, fx = this.game.effects, V = u.fm.speed;
    this.puffD += V * dt;
    const step = 5;
    if (this.puffD < step) return;
    _f.set(0, 0, -1).applyQuaternion(u.obj.quaternion);
    let n = 0;
    while (this.puffD >= step && n < 12) {
      this.puffD -= step; n++;
      _b.copy(u.pos).addScaledVector(_f, -this.sz.me.hl * 1.05).addScaledVector(u.vel, -this.puffD / Math.max(V, 1));
      fx.spawn(_b.x, _b.y, _b.z, 0, 0, 0, 2.4, 8, 1, 1, 1, 0.55, 4.5, 0, 0, 0, 0.02);
    }
    if (this.puffD > step) this.puffD = 0;
  }
}
