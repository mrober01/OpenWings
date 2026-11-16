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
    this.flyPos = new THREE.Vector3(); this.flyT = 0;
    this.fov = BASE_FOV;
  }

  setView(v) {
    if (!VIEWS.includes(v)) return;
    this.view = v; this.init = false; this.lookYaw = 0; this.lookPitch = 0;
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
      if (this.auto) this.orbitYaw += dt * 0.25;
      const d = R * 2.8 + 6, cp = Math.cos(this.orbitPitch);
      cam.position.set(p.x + Math.sin(this.orbitYaw) * cp * d, p.y + Math.sin(this.orbitPitch) * d, p.z + Math.cos(this.orbitYaw) * cp * d);
      this.clampGround(env, 3);
      cam.up.copy(UP);
      cam.lookAt(p);
    } else if (view === 'flyby') {
      this.flyT -= dt;
      const d = cam.position.distanceTo(p);
      if (!this.init || this.flyT <= 0 || d > 1100) {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.flyPos.copy(p).addScaledVector(unit.vel, 2.4).addScaledVector(_r, side * (R * 2 + 20 + Math.random() * 40));
        this.flyPos.y += Math.random() * 24 - 6;
        this.flyT = 7; this.init = true;
      }
      cam.position.copy(this.flyPos);
      this.clampGround(env, 2.5);
      cam.up.copy(UP);
      cam.lookAt(p);
      fov = clamp(2 * Math.atan(R * 5 / Math.max(cam.position.distanceTo(p), 1)) * 57.3, 12, BASE_FOV);
    } else if (view === 'target') {
      _a.copy(target.pos).sub(p).normalize();
      _b.copy(p).addScaledVector(_a, -(R * 2.6 + 4)); _b.y += R * 0.55 + 1;
      if (!this.init) { cam.position.copy(_b); this.init = true; }
      cam.position.lerp(_b, 1 - Math.exp(-9 * dt));
      this.clampGround(env, 3);
      cam.up.copy(UP);
      cam.lookAt(target.pos);
    } else {
      // chase: behind and above, rolls partly with the aircraft; drag swings it round
      const back = R * 2.4, up = R * 0.5;
      const cy = Math.cos(this.lookYaw), sy = Math.sin(this.lookYaw);
      _b.copy(p).addScaledVector(_f, -back * cy).addScaledVector(_r, -back * sy)
        .addScaledVector(_u, up + back * Math.sin(this.lookPitch) * 0.8);
      if (!this.init) { cam.position.copy(_b); cam.up.copy(UP); this.init = true; }
      const l = 1 - Math.exp(-9 * dt);
      cam.position.lerp(_b, l);
      this.clampGround(env, 3);
      _a.copy(_u).lerp(UP, 0.55).normalize();
      cam.up.lerp(_a, l).normalize();
      _a.copy(p).addScaledVector(_u, R * 0.12).addScaledVector(_f, R * 0.5 * cy);
      cam.lookAt(_a);
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

  clampGround(env, margin) {
    const c = this.camera.position;
    const g = env.groundHeight(c.x, c.z) + margin;
    if (c.y < g) c.y = g;
  }
}
