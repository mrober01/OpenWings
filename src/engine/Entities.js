// Entities.js — "units": everything that can be shot at or shown on radar.
// Aircraft units wrap a mesh + FlightModel (+ AIPilot when not the player);
// ground units are static targets, some of which shoot back (AAA, SAM).
// See docs/INTERFACES.md for the Unit shape.
import * as THREE from 'three';
import { FlightModel } from './FlightModel.js';
import { AIPilot } from './AIPilot.js';
import { AIRCRAFT_SPECS } from '../aircraft/AircraftSpecs.js';
import { buildAircraft } from '../aircraft/AircraftFactory.js';

const ZERO = new THREE.Vector3();
const gi = { y: 0, water: false, runway: false, slope: 0 };

export function makeAircraft(key, team, opts = {}) {
  const spec = AIRCRAFT_SPECS[key];
  if (!spec) throw new Error('unknown aircraft ' + key);
  const obj = buildAircraft(key, { team, lod: opts.lod || (opts.player ? 'full' : 'low') });
  const fm = new FlightModel(spec, { assist: opts.assist !== false });
  const ud = obj.userData;
  const big = spec.gMax < 3;
  return {
    kind: 'air', team, key, spec, obj, fm,
    name: spec.short || spec.name.toUpperCase(),
    ai: opts.player ? null : new AIPilot(spec, opts.ai || {}),
    pos: obj.position, vel: fm.velocity,
    radius: ud.radius || (big ? 20 : 8),
    alive: true, hp: spec.armor, maxHp: spec.armor, isPlayer: !!opts.player,
    gun: spec.gunAmmo, missiles: spec.missileCount, flares: spec.flares,
    gunCd: 0, pylon: 0, retarget: Math.random() * 2, target: null,
    trail: 0, smoke: 0, fx: 0, wreck: null, score: opts.score ?? (big ? 400 : 250),
    turret: !!opts.turret, turretCd: 2, burst: 0,
    primary: !!opts.primary, anim: { time: 0, gearPos: 0, thrEff: 0, ab: false, pitch: 0, roll: 0, yaw: 0, airbrake: 0, speed: 0, night: false },
  };
}

/* ------------------------------------------------------------------ ground */
export const GROUND_TYPES = {
  fuel: { name: 'FUEL TANK', hp: 55, r: 11, h: 9, score: 150 },
  radar: { name: 'RADAR', hp: 45, r: 9, h: 9, score: 200 },
  truck: { name: 'TRUCK', hp: 22, r: 6, h: 3, score: 75 },
  tank: { name: 'TANK', hp: 85, r: 6, h: 3, score: 150 },
  aaa: { name: 'AAA', hp: 45, r: 6, h: 3.5, score: 200 },
  sam: { name: 'SAM SITE', hp: 45, r: 7, h: 4, score: 300 },
  depot: { name: 'DEPOT', hp: 130, r: 17, h: 9, score: 250 },
};

let shared = null;
function res() {
  if (shared) return shared;
  const L = (c) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c).multiplyScalar(2.2) });
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 14); cyl.translate(0, 0.5, 0);
  const dish = new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
  shared = {
    box, cyl, dish,
    olive: L(0x4b5338), dark: L(0x2c3026), sand: L(0x8a7d5a), white: L(0xc9cdc8), rust: L(0x7a4a32),
    steel: L(0x6f767c), burnt: L(0x15130f), red: L(0x9a2f25),
  };
  return shared;
}

function part(geo, mat, sx, sy, sz, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  return m;
}

function buildGround(type) {
  const r = res(), g = new THREE.Group();
  switch (type) {
    case 'fuel':
      g.add(part(r.cyl, r.white, 9, 9, 9));
      g.add(part(r.cyl, r.steel, 9.3, 0.6, 9.3, 0, 8.6, 0));
      g.add(part(r.box, r.red, 18.3, 0.9, 0.5, 0, 5, 0));
      break;
    case 'radar': {
      g.add(part(r.box, r.olive, 7, 3.5, 7));
      g.add(part(r.cyl, r.steel, 0.5, 4, 0.5, 0, 3.5, 0));
      const d = part(r.dish, r.white, 4.5, 4.5, 4.5, 0, 8.5, 0);
      d.rotation.x = Math.PI / 2.4; d.material = r.white;
      const spin = new THREE.Group(); spin.add(d); g.add(spin); g.userData.spin = spin;
      break;
    }
    case 'truck':
      g.add(part(r.box, r.olive, 2.6, 1.6, 2.4, 0, 0.7, -2.6));
      g.add(part(r.box, r.sand, 2.8, 2.4, 5.2, 0, 0.7, 1.2));
      g.add(part(r.box, r.dark, 2.7, 0.8, 7.6, 0, 0, -0.2));
      break;
    case 'tank':
      g.add(part(r.box, r.dark, 3.6, 1.1, 7));
      g.add(part(r.box, r.olive, 3.2, 0.9, 6.2, 0, 1.0, 0));
      g.add(part(r.cyl, r.olive, 1.5, 0.9, 1.5, 0, 1.9, 0.4));
      g.add(part(r.box, r.dark, 0.24, 0.24, 5, 0, 2.2, -2.8));
      break;
    case 'aaa': {
      g.add(part(r.box, r.dark, 3.4, 1.2, 5.6));
      const t = new THREE.Group(); t.position.y = 1.2;
      t.add(part(r.cyl, r.olive, 1.6, 1.3, 1.6));
      for (const sx of [-0.45, 0.45]) { const b = part(r.box, r.steel, 0.16, 0.16, 4.2, sx, 1.0, -2.2); b.rotation.x = 0.5; t.add(b); }
      g.add(t); g.userData.turret = t;
      break;
    }
    case 'sam': {
      g.add(part(r.box, r.dark, 3.4, 1.2, 7));
      const t = new THREE.Group(); t.position.y = 1.2;
      for (const sx of [-0.9, 0, 0.9]) { const b = part(r.box, r.white, 0.6, 0.6, 5.4, sx, 1.6, 0); b.rotation.x = 0.6; t.add(b); }
      t.add(part(r.box, r.olive, 2.6, 1.0, 2.2));
      g.add(t); g.userData.turret = t;
      break;
    }
    default: // depot
      g.add(part(r.box, r.sand, 22, 7, 14));
      g.add(part(r.box, r.rust, 23, 1.6, 15, 0, 7, 0));
      g.add(part(r.box, r.dark, 6, 4.5, 0.4, 0, 0, 7.05));
  }
  return g;
}

export function makeGround(type, team, x, z, env, opts = {}) {
  const t = GROUND_TYPES[type];
  const obj = buildGround(type);
  env.ground(x, z, gi);
  obj.position.set(x, gi.y, z);
  obj.rotation.y = opts.heading ?? Math.random() * 6.283;
  return {
    kind: 'ground', type, team, name: t.name, obj, spec: null, fm: null, ai: null,
    pos: new THREE.Vector3(x, gi.y + t.h * 0.5, z), vel: ZERO,
    radius: t.r, alive: true, hp: t.hp, maxHp: t.hp, isPlayer: false,
    score: t.score, primary: opts.primary !== false && type !== 'aaa' && type !== 'sam',
    cd: 3 + Math.random() * 4, burst: 0, burstCd: 0, smoke: 0, smokeLife: 0,
  };
}

/** Swap a destroyed ground unit for a scorched, flattened hulk. */
export function wreckGround(u) {
  const r = res();
  u.obj.traverse(o => { if (o.isMesh) o.material = r.burnt; });
  u.obj.scale.y = 0.45;
  u.obj.rotation.z = (Math.random() - 0.5) * 0.3;
  u.smokeLife = 45;
}
