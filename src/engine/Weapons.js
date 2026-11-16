// Weapons.js — cannon rounds (tracers), guided missiles and flares for every
// aircraft and ground unit in the world. One manager, pooled storage:
//   • bullets: struct-of-arrays, drawn as one instanced ribbon batch (1 draw call)
//   • missiles: fixed pool of small meshes, proportional-ish lead guidance
//   • flares: struct-of-arrays, drawn through the particle batch
//
// A "unit" (see Entities.js) needs: pos, vel, radius, alive, team, kind.
import * as THREE from 'three';
import { clamp } from './utils.js';

const G = 9.81;
export const BULLET_SPEED = 950;
export const MISSILE = { range: 9000, minRange: 350, life: 16, burn: 2.6, accel: 240, maxG: 28, seeker: 0.95, fuse: 11, dmg: 95 };

const MAXB = 420, MAXM = 20, MAXF = 40;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const gi = { y: 0, water: false, runway: false, slope: 0 };

export class Weapons {
  constructor(scene, effects, env) {
    this.scene = scene; this.effects = effects; this.env = env;
    this.onHit = null;        // (unit, dmg, team, pos, byMissile, shooter)
    this.onExplode = null;    // (pos, size)
    this.onStructure = null;  // (building, dmg, pos): a bullet hit a building

    /* ---- bullets ---- */
    this.bn = 0;
    this.bp = new Float32Array(MAXB * 3); this.bv = new Float32Array(MAXB * 3);
    this.bl = new Float32Array(MAXB); this.bd = new Float32Array(MAXB);
    this.bt = new Int8Array(MAXB); this.bs = new Array(MAXB).fill(null);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.iHead = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iTail = new THREE.InstancedBufferAttribute(new Float32Array(MAXB * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iHead', this.iHead); g.setAttribute('iTail', this.iTail);
    g.instanceCount = 0;
    this.tracerMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      vertexShader: `
        attribute vec3 iHead; attribute vec4 iTail; varying vec2 vUv; varying float vTeam;
        void main() {
          vec3 p = mix(iTail.xyz, iHead, position.x);
          vec3 axis = normalize(iHead - iTail.xyz);
          vec3 toCam = normalize(cameraPosition - p);
          vec3 side = normalize(cross(axis, toCam));
          float d = distance(cameraPosition, p);
          float w = max(0.09, d * 0.0011);
          p += side * position.y * w;
          vUv = position.xy; vTeam = iTail.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `
        varying vec2 vUv; varying float vTeam;
        void main() {
          float a = (1.0 - abs(vUv.y)) * smoothstep(0.0, 0.35, vUv.x);
          vec3 col = mix(vec3(1.0, 0.82, 0.35), vec3(1.0, 0.32, 0.18), vTeam);
          gl_FragColor = vec4(col * a * 2.2 + vec3(a * a * a), 1.0);
        }`,
    });
    this.tracers = new THREE.Mesh(g, this.tracerMat);
    this.tracers.frustumCulled = false; this.tracers.renderOrder = 21;
    scene.add(this.tracers);

    /* ---- missiles ---- */
    const body = new THREE.CylinderGeometry(0.09, 0.09, 2.9, 6); body.rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.09, 0.4, 6); nose.rotateX(-Math.PI / 2); nose.translate(0, 0, -1.65);
    const fins = new THREE.BoxGeometry(0.6, 0.02, 0.35); fins.translate(0, 0, 1.25);
    const fins2 = new THREE.BoxGeometry(0.02, 0.6, 0.35); fins2.translate(0, 0, 1.25);
    this.mGeo = mergeSimple([body, nose, fins, fins2]);
    this.mMat = new THREE.MeshLambertMaterial({ color: 0xe6e6e6 });
    this.glowTex = glowTexture();
    this.missiles = [];
    for (let i = 0; i < MAXM; i++) {
      const mesh = new THREE.Mesh(this.mGeo, this.mMat);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffc070, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      glow.position.z = 1.8; glow.scale.setScalar(5);
      mesh.add(glow);
      mesh.visible = false; scene.add(mesh);
      this.missiles.push({ active: false, mesh, glow, pos: mesh.position, vel: new THREE.Vector3(), dir: new THREE.Vector3(), target: null, team: 0, t: 0, trail: 0, shooter: null, lost: false });
    }

    /* ---- flares ---- */
    this.fn = 0;
    this.flares = [];
    for (let i = 0; i < MAXF; i++) this.flares.push({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), life: 0, alive: false, radius: 2, team: 0, kind: 'flare' });
  }

  reset() {
    this.bn = 0; this.tracers.geometry.instanceCount = 0;
    for (const m of this.missiles) { m.active = false; m.mesh.visible = false; m.target = null; m.shooter = null; }
    for (const f of this.flares) { f.alive = false; f.life = 0; }
  }

  /* ---------------- firing ---------------- */
  /** One cannon round from `unit` along `dir` (unit vector) starting at world `from`. */
  fireBullet(unit, from, dir, dmg, spread = 0.004) {
    if (this.bn >= MAXB) return;
    const i = this.bn++, k = i * 3;
    const sx = (Math.random() - 0.5) * spread * 2, sy = (Math.random() - 0.5) * spread * 2, sz = (Math.random() - 0.5) * spread * 2;
    const uv = unit.vel;
    this.bp[k] = from.x; this.bp[k + 1] = from.y; this.bp[k + 2] = from.z;
    this.bv[k] = (dir.x + sx) * BULLET_SPEED + uv.x; this.bv[k + 1] = (dir.y + sy) * BULLET_SPEED + uv.y; this.bv[k + 2] = (dir.z + sz) * BULLET_SPEED + uv.z;
    this.bl[i] = 2.6; this.bd[i] = dmg; this.bt[i] = unit.team; this.bs[i] = unit;
  }

  /** Launch a missile from world `from` in direction `dir`; target may be null (unguided). */
  fireMissile(unit, from, dir, target) {
    const m = this.missiles.find(x => !x.active);
    if (!m) return null;
    m.active = true; m.t = 0; m.trail = 0; m.lost = !target;
    m.pos.copy(from); m.dir.copy(dir).normalize();
    m.vel.copy(unit.vel).addScaledVector(m.dir, 25);
    m.target = target; m.team = unit.team; m.shooter = unit;
    m.mesh.visible = true; m.glow.visible = true;
    return m;
  }

  dropFlare(unit) {
    const f = this.flares.find(x => !x.alive);
    if (!f) return false;
    f.alive = true; f.life = 4.2; f.team = unit.team;
    f.pos.copy(unit.pos);
    f.vel.copy(unit.vel).multiplyScalar(0.82);
    f.vel.x += (Math.random() - 0.5) * 26; f.vel.y -= 16 + Math.random() * 10; f.vel.z += (Math.random() - 0.5) * 26;
    return true;
  }

  /** Closest live missile homing on `unit` (metres), or Infinity. */
  threatRange(unit) {
    let best = Infinity;
    for (const m of this.missiles) {
      if (!m.active || m.target !== unit || m.lost) continue;
      const d = m.pos.distanceTo(unit.pos);
      if (d < best) best = d;
    }
    return best;
  }

  /* ---------------- per-frame ---------------- */
  update(dt, units, camPos) {
    const fx = this.effects, env = this.env;

    // ---- bullets ----
    const bp = this.bp, bv = this.bv;
    for (let i = this.bn - 1; i >= 0; i--) {
      const k = i * 3;
      const x0 = bp[k], y0 = bp[k + 1], z0 = bp[k + 2];
      bv[k + 1] -= G * dt;
      const x1 = x0 + bv[k] * dt, y1 = y0 + bv[k + 1] * dt, z1 = z0 + bv[k + 2] * dt;
      bp[k] = x1; bp[k + 1] = y1; bp[k + 2] = z1;
      let dead = (this.bl[i] -= dt) <= 0;
      if (!dead) {
        // segment vs unit spheres
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len2 = dx * dx + dy * dy + dz * dz;
        for (let u = 0; u < units.length; u++) {
          const t = units[u];
          if (!t.alive || t.team === this.bt[i] || t === this.bs[i]) continue;
          const px = t.pos.x - x0, py = t.pos.y - y0, pz = t.pos.z - z0;
          if (Math.abs(px) > 1200 || Math.abs(pz) > 1200) continue;
          const s = clamp((px * dx + py * dy + pz * dz) / len2, 0, 1);
          const cx = px - dx * s, cy = py - dy * s, cz = pz - dz * s;
          const r = t.radius * (t.kind === 'ground' ? 1.25 : 0.8);
          if (cx * cx + cy * cy + cz * cz < r * r) {
            _a.set(x0 + dx * s, y0 + dy * s, z0 + dz * s);
            fx.hitSpark(_a);
            if (this.onHit) this.onHit(t, this.bd[i], this.bt[i], _a, false, this.bs[i]);
            dead = true; break;
          }
        }
      }
      if (!dead && y1 < 600 && env.buildingAt) {
        const b = env.buildingAt(x1, y1, z1, 0);
        if (b) {
          _a.set(x1, y1, z1);
          if ((i & 1) === 0) fx.hitSpark(_a); else fx.groundBurst(_a, false, 0.6);
          if (this.onStructure) this.onStructure(b, this.bd[i], _a);
          dead = true;
        }
      }
      if (!dead && y1 < 2500) {
        const gy = env.groundHeight(x1, z1);
        if (y1 <= gy) {
          if ((i & 1) === 0) { _a.set(x1, gy, z1); fx.groundBurst(_a, gy <= 0.2, 0.8); }
          dead = true;
        }
      }
      if (dead) {
        const j = --this.bn;
        if (i !== j) {
          const kj = j * 3;
          bp[k] = bp[kj]; bp[k + 1] = bp[kj + 1]; bp[k + 2] = bp[kj + 2];
          bv[k] = bv[kj]; bv[k + 1] = bv[kj + 1]; bv[k + 2] = bv[kj + 2];
          this.bl[i] = this.bl[j]; this.bd[i] = this.bd[j]; this.bt[i] = this.bt[j]; this.bs[i] = this.bs[j];
        }
        this.bs[j] = null;
      }
    }
    // upload tracers
    const H = this.iHead.array, T = this.iTail.array;
    for (let i = 0; i < this.bn; i++) {
      const k = i * 3, q = i * 4;
      const vx = bv[k], vy = bv[k + 1], vz = bv[k + 2];
      const age = 2.6 - this.bl[i];
      const tl = Math.min(0.045, age) ; // streak = distance covered in ~45 ms
      H[k] = bp[k]; H[k + 1] = bp[k + 1]; H[k + 2] = bp[k + 2];
      T[q] = bp[k] - vx * tl; T[q + 1] = bp[k + 1] - vy * tl; T[q + 2] = bp[k + 2] - vz * tl; T[q + 3] = this.bt[i] === 0 ? 0 : 1;
    }
    this.tracers.geometry.instanceCount = this.bn;
    if (this.bn) { this.iHead.needsUpdate = true; this.iTail.needsUpdate = true; }

    // ---- flares ----
    for (const f of this.flares) {
      if (!f.alive) continue;
      f.life -= dt;
      f.vel.y -= 7 * dt; f.vel.multiplyScalar(1 - 0.9 * dt);
      f.pos.addScaledVector(f.vel, dt);
      fx.flareGlow(f.pos);
      if (f.life <= 0 || f.pos.y < env.groundHeight(f.pos.x, f.pos.z)) f.alive = false;
    }

    // ---- missiles ----
    for (const m of this.missiles) {
      if (!m.active) continue;
      m.t += dt;
      const speed = m.vel.length();
      let tgt = m.target;
      if (tgt && !tgt.alive) { tgt = m.target = null; m.lost = true; }
      if (tgt && m.t > 0.25) {
        // flares can pull the seeker off an aircraft
        if (tgt.kind === 'air') {
          for (const f of this.flares) {
            if (!f.alive || f.team !== tgt.team) continue;
            _a.copy(f.pos).sub(m.pos);
            const fd = _a.length();
            if (fd < 1800 && _a.dot(m.dir) / fd > 0.9 && Math.random() < dt * 0.55) { tgt = m.target = f; break; }
          }
        }
        _a.copy(tgt.pos).sub(m.pos);
        const range = _a.length();
        const closing = Math.max(speed * 0.5, speed - tgt.vel.dot(_a) / Math.max(range, 1));
        const tgo = clamp(range / closing, 0, 6);
        _b.copy(tgt.pos).addScaledVector(tgt.vel, tgo).sub(m.pos).normalize(); // lead point
        _a.multiplyScalar(1 / Math.max(range, 1e-3));
        if (_a.dot(m.dir) < Math.cos(MISSILE.seeker) && m.t > 1) { m.target = null; m.lost = true; }
        else {
          // turn toward the lead point, limited by available g
          const maxTurn = (MISSILE.maxG * G / Math.max(speed, 150)) * dt * clamp(m.t / 0.6, 0.2, 1);
          const ang = m.dir.angleTo(_b);
          if (ang > 1e-4) { m.dir.lerp(_b, Math.min(1, maxTurn / ang)).normalize(); }
        }
        // proximity fuse
        if (range < MISSILE.fuse + tgt.radius) {
          this.explodeMissile(m, tgt);
          continue;
        }
      }
      // motor / drag: velocity follows the nose
      let sp = speed;
      if (m.t < MISSILE.burn) sp += MISSILE.accel * dt; else sp -= (sp * sp * 0.00016 + 6) * dt;
      m.vel.copy(m.dir).multiplyScalar(sp);
      if (m.lost) { m.vel.y -= G * dt * 2; m.dir.copy(m.vel).normalize(); }
      m.pos.addScaledVector(m.vel, dt);
      _c.copy(m.pos).add(m.dir); m.mesh.lookAt(_c);
      const burning = m.t < MISSILE.burn;
      m.glow.visible = burning;
      if (burning) {
        m.trail += sp * dt;
        while (m.trail > 14) { m.trail -= 14; _c.copy(m.pos).addScaledVector(m.dir, -(2 + m.trail)); fx.missileSmoke(_c, m.vel); }
        m.glow.scale.setScalar(4 + Math.random() * 2.5);
      }
      // direct hits on anything else in the way, buildings, ground, time-out
      if (m.pos.y < 600 && env.buildingAt && env.buildingAt(m.pos.x, m.pos.y, m.pos.z, 1)) { this.explodeMissile(m, null); continue; }
      env.ground(m.pos.x, m.pos.z, gi);
      if (m.pos.y <= gi.y + 0.5) { m.pos.y = gi.y + 0.5; this.explodeMissile(m, null, gi.water); continue; }
      if (m.t > MISSILE.life || sp < 90) { this.explodeMissile(m, null); continue; }
    }
  }

  explodeMissile(m, direct, water = false) {
    m.active = false; m.mesh.visible = false;
    this.effects.explosion(m.pos, 1.1);
    if (water) this.effects.groundBurst(m.pos, true, 3);
    if (this.onExplode) this.onExplode(m.pos, 1.1);
    if (direct && direct.kind !== 'flare' && this.onHit) this.onHit(direct, MISSILE.dmg, m.team, m.pos, true, m.shooter);
    m.target = null; m.shooter = null;
    // splash damage handled by the game through onExplode (ground targets)
  }

  dispose() {
    this.scene.remove(this.tracers); this.tracers.geometry.dispose(); this.tracerMat.dispose();
    for (const m of this.missiles) { this.scene.remove(m.mesh); m.glow.material.dispose(); }
    this.mGeo.dispose(); this.mMat.dispose(); this.glowTex.dispose();
  }
}

/** Where to aim so that a round fired now meets the target: returns time of flight. */
export function leadSolution(shooterPos, shooterVel, target, out) {
  _d.copy(target.pos).sub(shooterPos);
  let t = _d.length() / BULLET_SPEED;
  for (let i = 0; i < 3; i++) {
    out.copy(target.pos).addScaledVector(target.vel, t).addScaledVector(shooterVel, -t);
    out.y += 0.5 * G * t * t;
    t = _d.copy(out).sub(shooterPos).length() / BULLET_SPEED;
  }
  return t;
}

function mergeSimple(geos) {
  let n = 0, ni = 0;
  for (const g of geos) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), idx = new Uint16Array(ni);
  let o = 0, oi = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3);
    for (let i = 0; i < g.index.count; i++) idx[oi++] = g.index.array[i] + o;
    o += g.attributes.position.count; g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export function glowTexture() {
  const S = 64, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1);
    const a = Math.max(0, 1 - d), v = Math.min(1, a * a * 1.2 + Math.pow(a, 8) * 2);
    const k = (y * S + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255 * v; data[k + 3] = 255 * v;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
