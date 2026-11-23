// CameraRig.js — the views: cockpit, chase, fly-by, orbit and target padlock.
// update() is allocation-free. look(dx, dy) takes drag deltas in css px.
import * as THREE from 'three';
import { clamp } from './utils.js';

export const VIEWS = ['chase', 'cockpit', 'target', 'flyby', 'orbit'];
export const VIEW_NAMES = { chase: 'CHASE VIEW', cockpit: 'COCKPIT', target: 'TARGET PADLOCK', flyby: 'FLY-BY', orbit: 'ORBIT' };

const BASE_FOV = 62, COCKPIT_FOV = 72;
const _f = new THREE.Vector3(), _u = new THREE.Vector3(), _r = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const UP = new THREE.Vector3(0, 1, 0);

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.view = 'chase';
    this.lookYaw = 0; this.lookPitch = 0; this.lookIdle = 9;
    this.orbitYaw = 0.6; this.orbitPitch = 0.2;
    this.auto = false;          // slow automatic orbit (debrief)
    this.shake = 0;
    this.init = false;
    this.flyPos = new THREE.Vector3(); this.flyT = 0; this.flySide = 1; this.flyN = 0;
    this.flyAim = new THREE.Vector3();
    this.fov = BASE_FOV;
    this.zoom = 1;              // external-view distance multiplier (mouse wheel)
  }

  /** Mouse wheel: >0 pulls the camera back. Chase, orbit and padlock only. */
  zoomBy(steps) {
    if (this.view === 'cockpit' || this.view === 'flyby' || !steps) return;
    this.zoom = clamp(this.zoom * Math.exp(steps * 0.12), 0.55, 4);
  }

  setView(v) {
    if (!VIEWS.includes(v)) return;
    this.view = v; this.init = false; this.lookYaw = 0; this.lookPitch = 0; this.lookIdle = 9;
  }

  next() { this.setView(VIEWS[(VIEWS.indexOf(this.view) + 1) % VIEWS.length]); return this.view; }

  reset() { this.init = false; this.lookYaw = 0; this.lookPitch = 0; this.auto = false; this.shake = 0; }

  look(dx, dy) {
    if (!dx && !dy) return;
    this.lookIdle = 0;
    if (this.view === 'orbit') {
      this.orbitYaw -= dx * 0.006;
      this.orbitPitch = clamp(this.orbitPitch + dy * 0.006, -1.3, 1.4);
    } else {
      this.lookYaw = clamp(this.lookYaw - dx * 0.006, -2.6, 2.6);
      this.lookPitch = clamp(this.lookPitch - dy * 0.006, -0.9, 1.2);
    }
  }

  /**
   * @param unit    the aircraft unit to follow ({obj, pos, vel, radius, spec})
   * @param env     for ground clamping
   * @param target  unit or null (target view)
   */
  update(dt, unit, env, target) {
    const cam = this.camera, p = unit.pos, q = unit.obj.quaternion;
    const R = unit.radius || 8;
    let view = this.view;
    if (view === 'target' && !(target && target.alive)) view = 'chase';
    let fov = view === 'cockpit' ? COCKPIT_FOV : BASE_FOV;

    // head / look-around springs back after a moment without input
    this.lookIdle += dt;
    if (this.lookIdle > 1.2) {
      const k = Math.exp(-4 * dt);
      this.lookYaw *= k; this.lookPitch *= k;
    }

    _f.set(0, 0, -1).applyQuaternion(q);
    _u.set(0, 1, 0).applyQuaternion(q);
    _r.set(1, 0, 0).applyQuaternion(q);

    if (view === 'cockpit') {
      const e = unit.spec.eye;
      cam.position.set(e[0], e[1], e[2]).applyQuaternion(q).add(p);
      _e.set(this.lookPitch, this.lookYaw, 0);
      cam.quaternion.copy(q).multiply(_q.setFromEuler(_e));
    } else if (view === 'orbit') {
      // the debrief spins; in flight it drifts slowly once you let go of the mouse
      if (this.auto) this.orbitYaw += dt * 0.25;
      else if (this.lookIdle > 3) this.orbitYaw += dt * 0.06 * Math.min(1, (this.lookIdle - 3) / 2);
      const d = (R * 2.8 + 6) * this.zoom, cp = Math.cos(this.orbitPitch);
      cam.position.set(p.x + Math.sin(this.orbitYaw) * cp * d, p.y + Math.sin(this.orbitPitch) * d, p.z + Math.cos(this.orbitYaw) * cp * d);
      this.clampGround(env, 3);
      cam.up.copy(UP);
      cam.lookAt(p);
    } else if (view === 'flyby') {
      // a camera operator on a spot ahead of the flight path: the aircraft comes at the lens,
      // passes close by and goes away; then cut to the next spot. Long lens, smooth pan.
      this.flyT += dt;
      const spd = unit.vel.length();
      _a.copy(this.flyPos).sub(p);
      const d = _a.length();
      const passed = spd > 2 ? _a.dot(unit.vel) / spd < -Math.max(R * 6, 60) : this.flyT > 6;
      if (!this.init || d > 2200 || this.flyT > 14 || (passed && this.flyT > 2.5)) {
        this.pickFlyby(unit, env, spd, R);
        _a.copy(this.flyPos).sub(p);
      }
      cam.position.copy(this.flyPos);
      this.clampGround(env, 1.8);
      // aim a touch ahead of the aircraft (where it is going), with a little pan lag
      _b.copy(p).addScaledVector(unit.vel, 0.08);
      this.flyAim.lerp(_b, 1 - Math.exp(-14 * dt));
      cam.up.copy(UP);
      cam.lookAt(this.flyAim);
      // zoom: keep the airframe ~1/4 of the frame tall-ish, wider as it gets close
      const dist = Math.max(cam.position.distanceTo(p), 1);
      fov = clamp(2 * Math.atan(R * 2.4 / dist) * 57.3, 4, 70);
      if (this.flyT === 0) this.fov = fov;   // fresh cut: no zoom sweep
    } else if (view === 'target') {
      _a.copy(target.pos).sub(p).normalize();
      _b.copy(p).addScaledVector(_a, -(R * 2.6 + 4) * this.zoom); _b.y += (R * 0.55 + 1) * this.zoom;
      if (!this.init) { cam.position.copy(_b); this.init = true; }
      cam.position.lerp(_b, 1 - Math.exp(-9 * dt));
      this.clampGround(env, 3);
      cam.up.copy(UP);
      cam.lookAt(target.pos);
    } else {
      // chase: behind and a bit above, rolls partly with the aircraft; drag swings it round.
      // The camera aims well ahead of the nose so the aircraft sits low in the frame and
      // the sky in front of it (where the target is) stays clear.
      const z = this.zoom, back = R * 2.5 * z + 2, up = R * 0.55 * z;
      const cy = Math.cos(this.lookYaw), sy = Math.sin(this.lookYaw);
      _b.copy(p).addScaledVector(_f, -back * cy).addScaledVector(_r, -back * sy)
        .addScaledVector(_u, up + back * Math.sin(this.lookPitch) * 0.8);
      if (!this.init) { cam.position.copy(_b); cam.up.copy(UP); this.init = true; }
      const l = 1 - Math.exp(-9 * dt);
      cam.position.lerp(_b, l);
      this.clampGround(env, 3);
      _a.copy(_u).lerp(UP, 0.55).normalize();
      cam.up.lerp(_a, l).normalize();
      _a.copy(p).addScaledVector(_u, R * 0.2 * z).addScaledVector(_f, R * 2.3 * z * cy);
      cam.lookAt(_a);
      // a little wider with speed: sells the pace without moving the camera
      const spd = unit.vel.length();
      fov = BASE_FOV + clamp((spd - 120) / 300, 0, 1) * 8;
    }

    if (this.shake > 0.01) {
      const s = this.shake * this.shake * (view === 'cockpit' ? 0.05 : 0.5);
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.5);
    }

    this.fov += (fov - this.fov) * Math.min(1, dt * 6);
    if (Math.abs(cam.fov - this.fov) > 0.05) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld(true);
  }

  /** Choose the next fly-by spot: ahead on the flight path, off to one side (alternating). */
  pickFlyby(unit, env, spd, R) {
    const p = unit.pos;
    this.flySide = -this.flySide;
    this.flyN++;
    // time for the aircraft to reach the spot: long enough to see it coming
    const lead = clamp(600 / Math.max(spd, 20), 2.2, 8);
    this.flyPos.copy(p).addScaledVector(unit.vel, lead);
    // sideways: horizontal right of the velocity, so a banked aircraft does not push the camera up/down
    _r.set(-unit.vel.z, 0, unit.vel.x);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    const off = R * 2.2 + 12 + Math.random() * (18 + spd * 0.12);
    _a.copy(this.flyPos);                                  // the point on the path
    // try this side, then the other; if a hill hides the approach either way, climb until it does not
    for (let k = 0; k < 2; k++) {
      this.flyPos.copy(_a).addScaledVector(_r, this.flySide * off);
      const g = env.groundHeight(this.flyPos.x, this.flyPos.z);
      if (this.flyPos.y - g < 120 && this.flyN % 3 === 0) this.flyPos.y = g + 2 + Math.random() * 4;   // standing on the ground, looking up
      else this.flyPos.y += (this.flyN % 2 ? -1 : 1) * (R * 0.6 + Math.random() * 10);                // a touch above or below the path
      if (this.flyPos.y < g + 2) this.flyPos.y = g + 2;
      if (this.clearView(env, this.flyPos, p)) break;
      this.flySide = -this.flySide;
    }
    for (let k = 0; k < 8 && !this.clearView(env, this.flyPos, p); k++) this.flyPos.y += 25;
    this.flyAim.copy(p);
    this.flyT = 0; this.init = true;
  }

  /** Terrain line of sight between two points (8 samples, 3 m margin). */
  clearView(env, a, b) {
    for (let i = 1; i < 8; i++) {
      const t = i / 8, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      if (env.groundHeight(x, z) + 3 > y) return false;
    }
    return true;
  }

  clampGround(env, margin) {
    const c = this.camera.position;
    const g = env.groundHeight(c.x, c.z) + margin;
    if (c.y < g) c.y = g;
  }
}
