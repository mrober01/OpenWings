// Ejection.js — the player's way out: canopy jettison, rocket seat (or a bail-out for the
// propeller types and the helicopter), seat separation, parachute and a gentle descent.
//
// The instance doubles as a camera "unit" ({obj, pos, vel, radius, spec}) so CameraRig can
// follow the pilot with any of its views once the aircraft has been abandoned.
import * as THREE from 'three';
import { airDensity } from './FlightModel.js';

const G = 9.81;
const _u = new THREE.Vector3(), _f = new THREE.Vector3(), _a = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(), _y = new THREE.Vector3(0, 1, 0);
const gi = { y: 0, water: false, runway: false, slope: 0 };

// shared meshes (built on first use)
let KIT = null;
function kit() {
  if (KIT) return KIT;
  const lam = (c) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c).multiplyScalar(2.0) });
  // parachute canopy: shallow dome with alternating orange / white gores (vertex colours)
  const dome = new THREE.SphereGeometry(4.2, 24, 8, 0, Math.PI * 2, 0, Math.PI * 0.42).toNonIndexed();
  const pos = dome.attributes.position, col = [];
  for (let i = 0; i < pos.count; i += 3) {
    // one colour per triangle (from its centroid) so the gores have crisp seams
    const x = pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2), z = pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2);
    const gore = Math.floor((Math.atan2(z, x) + Math.PI) / (Math.PI * 2) * 12) % 2;
    const c = new THREE.Color(gore ? 0xff6a14 : 0xf2efe6).multiplyScalar(1.8);
    for (let k = 0; k < 3; k++) col.push(c.r, c.g, c.b);
  }
  dome.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  dome.scale(1, 0.75, 1);
  const lines = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2, r = 4.2 * Math.sin(Math.PI * 0.42), y = 4.2 * Math.cos(Math.PI * 0.42) * 0.75;
    lines.push(0, -6.6, 0, Math.cos(a) * r, y, Math.sin(a) * r);
  }
  const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
  KIT = {
    dome, risers: rg,
    domeMat: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    lineMat: new THREE.LineBasicMaterial({ color: 0x2a2a2a }),
    suit: lam(0x5c6848), helmet: lam(0xd8d8d0), visor: lam(0x101418), seat: lam(0x3a3e42), yellow: lam(0xd9b21c),
    glass: new THREE.MeshStandardMaterial({ color: 0x9fb8cc, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.45 }),
    frame: lam(0x4a5058),
    box: new THREE.BoxGeometry(1, 1, 1), ball: new THREE.SphereGeometry(1, 12, 8),
    bubble: new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
  };
  return KIT;
}

function part(geo, mat, sx, sy, sz, x, y, z, parent) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  parent.add(m);
  return m;
}

export class Ejection {
  /**
   * @param scene   world scene
   * @param fx      Effects (smoke / flame)
   * @param unit    the aircraft being abandoned
   * @param rocket  true = rocket ejection seat, false = bail out over the side
   */
  constructor(scene, fx, unit, rocket) {
    const K = kit();
    this.scene = scene; this.fx = fx; this.rocket = rocket;
    this.spec = { eye: [0, 0.35, 0] };
    this.radius = 6;
    this.alive = true;
    this.t = 0; this.trail = 0;
    this.landed = false; this.splash = false;
    this.chute = 0;                          // 0..1 deployment

    const q = unit.obj.quaternion;
    _u.set(0, 1, 0).applyQuaternion(q);
    _f.set(0, 0, -1).applyQuaternion(q);
    const e = unit.spec.eye;
    this.obj = new THREE.Group();
    this.obj.position.set(e[0], e[1] + 0.3, e[2]).applyQuaternion(q).add(unit.pos);
    this.pos = this.obj.position;
    this.vel = unit.vel.clone();
    if (rocket) this.vel.addScaledVector(_u, 48);                     // ~0.2 s at 15+ g up the rails
    else { _a.set(1, 0, 0).applyQuaternion(q); this.vel.addScaledVector(_a, 4).addScaledVector(_u, 3); }
    this.heading = Math.atan2(-_f.x, -_f.z);
    this.obj.quaternion.copy(q);

    // the pilot (+ seat while it is still attached)
    const body = this.body = new THREE.Group();
    part(K.box, K.suit, 0.42, 0.62, 0.3, 0, -0.35, 0, body);              // torso
    part(K.ball, K.helmet, 0.15, 0.17, 0.16, 0, 0.12, 0, body);           // helmet
    part(K.box, K.visor, 0.2, 0.08, 0.04, 0, 0.12, -0.15, body);          // visor
    for (const s of [-1, 1]) {
      part(K.box, K.suit, 0.13, 0.58, 0.14, s * 0.12, -0.92, -0.05, body); // legs
      part(K.box, K.suit, 0.1, 0.5, 0.1, s * 0.28, -0.3, -0.02, body);     // arms
    }
    this.obj.add(body);
    this.seat = new THREE.Group();
    part(K.box, K.seat, 0.55, 0.12, 0.55, 0, -0.68, 0.02, this.seat);
    part(K.box, K.seat, 0.5, 1.15, 0.14, 0, -0.2, 0.26, this.seat);
    part(K.box, K.seat, 0.32, 0.26, 0.16, 0, 0.42, 0.26, this.seat);
    part(K.box, K.yellow, 0.12, 0.04, 0.06, 0, -0.6, -0.27, this.seat);  // firing handle
    if (rocket) this.obj.add(this.seat);
    this.seatFree = null;                    // the seat after man-seat separation

    // parachute (folded until deployed)
    const ch = this.chuteObj = new THREE.Group();
    ch.add(new THREE.Mesh(K.dome, K.domeMat));
    ch.add(new THREE.LineSegments(K.risers, K.lineMat));
    ch.position.y = 6.6; ch.scale.setScalar(0.01); ch.visible = false;
    this.obj.add(ch);
    scene.add(this.obj);

    // canopy (jets: blown off first; it tumbles away)
    this.debris = [];
    if (rocket) {
      const c = new THREE.Group();
      part(K.bubble, K.glass, 0.5, 0.45, 1.4, 0, 0, 0, c);
      part(K.box, K.frame, 1.0, 0.06, 0.06, 0, 0.02, -1.35, c);
      c.position.set(e[0], e[1] + 0.25, e[2]).applyQuaternion(q).add(unit.pos);
      c.quaternion.copy(q);
      scene.add(c);
      this.debris.push({ obj: c, vel: unit.vel.clone().addScaledVector(_u, 22).addScaledVector(_f, -6), spin: new THREE.Vector3(-3.5, 0.6, 1.2), life: 8 });
    }
  }

  update(dt, env) {
    this.t += dt;
    const t = this.t, v = this.vel, p = this.pos;
    const rho = airDensity(p.y);
    for (const d of this.debris) {
      d.life -= dt;
      d.vel.y -= G * dt; d.vel.multiplyScalar(1 - Math.min(1, 0.25 * rho * dt));
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt; d.obj.rotation.y += d.spin.y * dt; d.obj.rotation.z += d.spin.z * dt;
      const gy = env.groundHeight(d.obj.position.x, d.obj.position.z);
      if (d.obj.position.y < gy + 0.3) { d.obj.position.y = gy + 0.3; d.vel.set(0, 0, 0); d.spin.set(0, 0, 0); }
    }

    if (this.landed) {
      // canopy sags over onto the ground
      const ch = this.chuteObj;
      ch.rotation.z = Math.min(1.45, ch.rotation.z + dt * 0.8);
      ch.scale.y = Math.max(0.2, ch.scale.y - dt * 0.5);
      return;
    }

    // rocket burn: a fiery plume and smoke under the seat
    if (this.rocket && t < 0.45) {
      _a.copy(p); _a.y -= 0.9;
      this.fx.flame(_a, v, 0.8);
      this.fx.missileSmoke(_a, v);
    }
    // man-seat separation, then the chute opens
    const sepT = this.rocket ? 1.6 : 0.9;
    if (this.rocket && !this.seatFree && t > sepT) {
      this.seatFree = { vel: v.clone().add(_a.set(0, -2, 3)), spin: 2.5 };
      this.obj.remove(this.seat);
      this.seat.position.copy(p); this.seat.quaternion.copy(this.obj.quaternion);
      this.scene.add(this.seat);
    }
    if (this.seatFree) {
      const s = this.seatFree;
      s.vel.y -= G * dt;
      this.seat.position.addScaledVector(s.vel, dt);
      this.seat.rotation.x += s.spin * dt;
      if (this.seat.position.y < env.groundHeight(this.seat.position.x, this.seat.position.z)) { s.vel.set(0, 0, 0); s.spin = 0; }
    }
    const deployT = sepT + 0.4;
    if (t > deployT) {
      this.chuteObj.visible = true;
      this.chute = Math.min(1, this.chute + dt / 1.4);
      const k = this.chute, e = k * k * (3 - 2 * k);
      this.chuteObj.scale.set(0.1 + 0.9 * e, 0.3 + 0.7 * e, 0.1 + 0.9 * e);
    }

    // ballistics: body drag in free fall, then the canopy (descent ~6 m/s at sea level, faster up high)
    const drag = (0.006 + this.chute * 0.27) * rho;
    const sp = v.length();
    if (sp > 1e-3) v.multiplyScalar(Math.max(0, 1 - drag * sp * dt));
    v.y -= G * dt;
    // a little wind drift under the canopy
    if (this.chute > 0.5) { v.x += (2.2 - v.x) * dt * 0.3 * this.chute; v.z += (1.2 - v.z) * dt * 0.3 * this.chute; }
    p.addScaledVector(v, dt);

    // orientation: tumble a little in the seat, hang upright facing downwind under the chute
    const k = Math.min(1, this.chute * 1.4 + (t > deployT ? 0.2 : 0));
    const hv = Math.hypot(v.x, v.z);
    const hdg = hv > 0.5 ? Math.atan2(-v.x, -v.z) : this.heading;
    this.heading = hdg;
    _q.setFromAxisAngle(_y, hdg);
    const swing = Math.sin(t * 1.3) * 0.12 * this.chute;
    _q.multiply(_q2.setFromEuler(_e.set(swing, 0, Math.cos(t * 0.9) * 0.08 * this.chute)));
    this.obj.quaternion.slerp(_q, Math.min(1, dt * (0.6 + 3 * k)));

    // touchdown
    env.ground(p.x, p.z, gi);
    if (p.y <= gi.y + 1.3) {
      p.y = gi.y + (gi.water ? 0.4 : 1.3);
      v.set(0, 0, 0);
      this.landed = true; this.splash = gi.water;
      if (gi.water) this.fx.groundBurst(p, true, 0.4);
    }
  }

  dispose() {
    this.scene.remove(this.obj);
    this.scene.remove(this.seat);
    for (const d of this.debris) this.scene.remove(d.obj);
    this.debris.length = 0;
  }
}
