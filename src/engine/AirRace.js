// AirRace.js — the AIR RACE mission: an air-race pylon course laid low over the current map,
// with a gunnery range strung along it (tethered target balloons, range hulks on the ground and a
// full-scale target drone circling overhead).
//
// Rules follow real air racing: fly the gates in order between the two pylons. Blue gates are flown
// wings level and red gates in knife-edge (both checks are off on EASY). Going over a gate, the wrong
// attitude, clipping a pylon (they are inflatable, so they rip, but it still dents the aeroplane) or
// missing a gate adds seconds to your time. Score = gates + targets shot + a time bonus.
// EASY / NORMAL are the arcade version: wide, tall gates, long straights, soft penalties, the next gate
// lit by a light curtain. HARD is the real thing: race-size gates and full penalties.
// Race feel: a 3-2-1-GO countdown on the run-in, a clean-gate streak multiplier, split times against
// your best run at every gate, a ghost of your best run to race, and a gold / silver / bronze medal.
//
// The course is generated from a seed of map + aircraft, so everyone flying the same map in the same
// aircraft gets the same course and the scores compare.
import * as THREE from 'three';
import { clamp } from './utils.js';
import { steerToward } from './AIPilot.js';
import { buildAircraft } from '../aircraft/AircraftFactory.js';

const TAU = Math.PI * 2;
const _gi = { y: 0, water: false, runway: false, slope: 0 };
const _v = new THREE.Vector3(), _r = new THREE.Vector3();

/** mulberry32 seeded random */
function seeded(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dirX = (h) => Math.sin(h), dirZ = (h) => -Math.cos(h);

/** Course dimensions and rules for an aircraft and difficulty. */
export function courseSize(spec, radius, diff) {
  const V = spec.type === 'heli' ? 50 : Math.min(clamp(spec.vStall * 2.5, 60, 210), spec.vMax * 0.8);
  const strict = diff.n > 1, easy = diff.n < 1;
  // heavies (airliners, < 3 g) get a gentle course: longer legs, softer turns, taller gates
  const heavy = spec.type !== 'heli' && spec.gMax < 3;
  const n = easy ? 8 : strict ? 12 : 10;
  if (strict) {
    const W = Math.max(clamp(V * 0.32, 20, 60) * 0.82, radius * 2.6);
    return {
      V, W, H: heavy ? 80 : clamp(W * 1.05, 25, 60), L: clamp(V * 7.5, 420, 1500) * (heavy ? 1.6 : 1), n, turn: heavy ? 0.45 : 1,
      bank: 0.35, knife: 1.05, pen: { high: 2, attitude: 2, pylon: 3, miss: 10 }, pylonDmg: 12, balloonR: 4, arcade: false, assist: 0, slack: 0,
    };
  }
  // arcade: big gates you can fly through at a comfortable height (jets ~145 m wide and tall on
  // VETERAN, ~190 m on ROOKIE), long straights, gentle turns
  const W = Math.max(clamp(V * (easy ? 1.3 : 1), easy ? 90 : 70, easy ? 200 : 160), radius * 5);
  return {
    V, W, H: heavy ? 180 : clamp(W * (easy ? 1.05 : 1), easy ? 100 : 80, easy ? 200 : 160),
    L: clamp(V * 11, 600, 2200) * (heavy ? 1.3 : 1), n, turn: heavy ? 0.4 : easy ? 0.3 : 0.45,
    bank: easy ? Infinity : 0.79, knife: 0.79,          // level within 45°, knife-edge past 45°
    pen: { high: 1, attitude: 1, pylon: 2, miss: easy ? 3 : 5 }, pylonDmg: easy ? 3 : 6, balloonR: easy ? 13 : 11, arcade: true,
    // gate assist: how strongly the stick is nudged toward the next gate when you're roughly lined up;
    // slack: a pass just outside a pylon still counts (fraction of the width)
    assist: easy ? 0.5 : 0.35, slack: 0.12,
  };
}

/**
 * Lay out the gates. Pure apart from env queries: env.groundHeight, env.ground, env.buildingAt,
 * env.buildingsNear, env.carrier, env.hf.city. Returns { start, gates[] } or null.
 */
export function buildCourse(env, size, seed, home) {
  const { W, H, L, n } = size;
  const rnd = seeded(seed);
  const city = env.hf.city, cv = env.carrier, near = [];
  const lim = 17000 - (L > 1600 ? 1500 : 0);
  const flyY = (base) => base + H * 0.5;
  const flat = (x, z, h) => {
    // ground across the gate (both pylons + a bit either side along the course)
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of [[0, 0], [W * 0.6, 0], [-W * 0.6, 0], [0, 40], [0, -40]]) {
      const gx = x + dirX(h) * b - dirZ(h) * a, gz = z + dirZ(h) * b + dirX(h) * a;
      const y = env.groundHeight(gx, gz);
      if (y < lo) lo = y; if (y > hi) hi = y;
    }
    return hi - lo < H * 0.22 ? hi : null;
  };
  /** clear flying from (ax, ay, az) to (bx, by, bz): terrain, buildings, landmarks */
  const clear = (ax, ay, az, bx, by, bz) => {
    const d = Math.hypot(bx - ax, bz - az), steps = Math.ceil(d / 30);
    for (let i = 1; i < steps; i++) {
      const t = i / steps, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = ay + (by - ay) * t;
      if (env.groundHeight(x, z) > y - H * 0.3) return false;
      if (env.buildingAt(x, y, z, W * 0.5)) return false;
    }
    return true;
  };
  const okSpot = (x, z, h, gates) => {
    if (Math.abs(x) > lim || Math.abs(z) > lim) return null;
    if (cv && Math.hypot(x - cv.x, z - cv.z) < 900) return null;
    const base = flat(x, z, h);
    if (base == null) return null;
    if (env.buildingsNear(x, z, W * 0.7, near).length) return null;
    for (let i = 0; i < gates.length - 1; i++) if (Math.hypot(gates[i].x - x, gates[i].z - z) < L * 0.75) return null;
    return base;
  };

  let bestRun = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    // start a few km from home; prefer heading toward the city (scenery), randomised
    const a0 = rnd() * TAU, r0 = 2500 + rnd() * 5000;
    const sx = home.x + Math.cos(a0) * r0, sz = home.z + Math.sin(a0) * r0;
    let hdg = city ? Math.atan2(city.x - sx, -(city.z - sz)) + (rnd() - 0.5) * 1.6 : rnd() * TAU;
    const sBase = env.groundHeight(sx, sz);
    let px = sx, pz = sz, py = Math.max(sBase + 120, flyY(sBase));
    const gates = [];
    for (let i = 0; i < n; i++) {
      let best = null, bs = -Infinity;
      for (let c = 0; c < 28; c++) {
        const turn = (i === 0 ? (rnd() - 0.5) * 0.5 : (rnd() - 0.5) * 1.7) * Math.min(1, (size.turn || 1) * (1 + c / 20));
        const h = hdg + turn, d = (i === 0 ? 2.4 : 0.85 + rnd() * 0.45) * L;
        const x = px + dirX(h) * d, z = pz + dirZ(h) * d;
        const base = okSpot(x, z, h, gates);
        if (base == null) continue;
        const y = flyY(base);
        if (i > 0 && Math.abs(y - py) / d > 0.12) continue;
        if (!clear(px, py, pz, x, y, z)) continue;
        // run-out: no hill straight ahead just past the gate (a long one after the finish)
        const ro = (i === n - 1 ? 3.5 : 1.2) * size.V;
        if (!clear(x, y, z, x + dirX(h) * ro, y + 10, z + dirZ(h) * ro)) continue;
        // score: random, but keep it compact (drift back toward the start) and low (water / valleys)
        const back = Math.hypot(x - sx, z - sz);
        const sc = rnd() - back / 16000 - base / 300 + (city ? -Math.hypot(x - city.x, z - city.z) / 40000 : 0);
        if (sc > bs) { bs = sc; best = { x, z, base, y, h }; }
      }
      if (!best) break;
      gates.push(best);
      px = best.x; pz = best.z; py = best.y; hdg = best.h;
    }
    if (!bestRun || gates.length > bestRun.gates.length) bestRun = { gates, start: { x: sx, z: sz, y: Math.max(sBase + 120, flyY(sBase)) } };
    if (gates.length === n) break;
  }
  if (!bestRun || bestRun.gates.length < 4) return null;
  const g = bestRun.gates, st = bestRun.start;
  // each gate faces the bisector of its in and out legs, so a smooth line flies straight through
  for (let i = 0; i < g.length; i++) {
    const p = i ? g[i - 1] : st, q = g[i + 1];
    let ix = g[i].x - p.x, iz = g[i].z - p.z; const il = Math.hypot(ix, iz); ix /= il; iz /= il;
    let nx = ix, nz = iz;
    if (q) { let ox = q.x - g[i].x, oz = q.z - g[i].z; const ol = Math.hypot(ox, oz); ox /= ol; oz /= ol; nx += ox; nz += oz; }
    const nl = Math.hypot(nx, nz);
    g[i].nx = nx / nl; g[i].nz = nz / nl;
  }
  return bestRun;
}

/* ------------------------------------------------------------------ best runs (splits + ghost) */

const RUN_KEY = 'openwings.race.', RUN_INDEX = 'openwings.race.index', RUN_MAX = 40;
const GHOST_DT = 0.2;   // s between ghost samples

/** Best run for a course: { total, splits: [s at each gate], path: [t-ordered x,y,z,qx,qy,qz,qw ints] } or null. */
export function loadRun(key) {
  try { return JSON.parse(localStorage.getItem(RUN_KEY + key) || 'null'); } catch { return null; }
}

function saveRun(key, run) {
  try {
    localStorage.setItem(RUN_KEY + key, JSON.stringify(run));
    // keep the newest RUN_MAX courses
    let idx = JSON.parse(localStorage.getItem(RUN_INDEX) || '[]').filter(k => k !== key);
    idx.push(key);
    while (idx.length > RUN_MAX) localStorage.removeItem(RUN_KEY + idx.shift());
    localStorage.setItem(RUN_INDEX, JSON.stringify(idx));
  } catch { /* storage full / private mode: no ghost */ }
}

function loadTop(key) {
  try { const a = JSON.parse(localStorage.getItem(RUN_KEY + 'top.' + key) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveTop(key, top) { try { localStorage.setItem(RUN_KEY + 'top.' + key, JSON.stringify(top)); } catch { /* ignore */ } }

/** A see-through copy of the aircraft that replays a stored path. */
function makeGhost(key, path) {
  const obj = buildAircraft(key, { team: 0, lod: 'low' });
  const mats = [];
  obj.traverse(o => {
    if (!o.isMesh) return;
    const ms = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
      const c = m.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false;
      if (c.emissive) c.emissive.setRGB(0.25, 0.6, 0.9);          // a pale blue glow: clearly a ghost
      if (c.color) c.color.lerp(new THREE.Color(0x9fdcff), 0.6);
      mats.push(c); return c;
    });
    o.material = Array.isArray(o.material) ? ms : ms[0];
    o.castShadow = false;
  });
  obj.visible = false;
  const n = path.length / 7, qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  return {
    obj,
    /** pose at race time t; hidden before the start and after the end */
    at(t, started) {
      const f = t / GHOST_DT, i = Math.floor(f);
      if (!started || i < 0 || i >= n - 1) { obj.visible = false; return; }
      const k = f - i, a = i * 7, b = a + 7;
      obj.position.set(
        (path[a] + (path[b] - path[a]) * k) / 10, (path[a + 1] + (path[b + 1] - path[a + 1]) * k) / 10, (path[a + 2] + (path[b + 2] - path[a + 2]) * k) / 10);
      qa.set(path[a + 3], path[a + 4], path[a + 5], path[a + 6]).normalize();
      qb.set(path[b + 3], path[b + 4], path[b + 5], path[b + 6]).normalize();
      obj.quaternion.copy(qa).slerp(qb, k);
      obj.visible = true;
    },
    dispose() {
      for (const m of mats) m.dispose();
      if (obj.userData.dispose) obj.userData.dispose();
    },
  };
}

/* ------------------------------------------------------------------ meshes */

let checkerTex = null;
function checker() {
  if (checkerTex) return checkerTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  for (let i = 0; i < 4; i++) for (let j = 0; j < 8; j++) { x.fillStyle = (i + j) & 1 ? '#111' : '#eee'; x.fillRect(i * 16, j * 8, 16, 8); }
  checkerTex = new THREE.CanvasTexture(c);
  checkerTex.wrapS = checkerTex.wrapT = THREE.RepeatWrapping;
  checkerTex.colorSpace = THREE.SRGBColorSpace;
  return checkerTex;
}

let dotTex = null;
function dot() {
  if (dotTex) return dotTex;
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const x = c.getContext('2d'), gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 32, 32);
  dotTex = new THREE.CanvasTexture(c);
  return dotTex;
}

let curtainTex = null;
/** Light-curtain texture: bright edges and soft horizontal bands, transparent middle. */
function curtain() {
  if (curtainTex) return curtainTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 64, 0);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.12, 'rgba(255,255,255,0.25)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.08)'); gr.addColorStop(0.88, 'rgba(255,255,255,0.25)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 128);
  x.fillStyle = 'rgba(255,255,255,0.35)';
  for (let y = 0; y < 128; y += 16) x.fillRect(0, y, 64, 3);
  x.fillStyle = 'rgba(255,255,255,0.9)'; x.fillRect(0, 0, 64, 4);
  curtainTex = new THREE.CanvasTexture(c);
  curtainTex.wrapT = THREE.RepeatWrapping;
  return curtainTex;
}

/** A tapered inflatable pylon: coloured body, white bands, a beacon on top. Origin at the base. */
function pylonMesh(H, rb, color, mats, finish) {
  const g = new THREE.Group();
  const seg = (y0, y1, mat) => {
    const r0 = rb * (1 - 0.78 * y0 / H), r1 = rb * (1 - 0.78 * y1 / H);
    const geo = new THREE.CylinderGeometry(r1, r0, y1 - y0, 18, 1, true);
    geo.translate(0, (y0 + y1) / 2, 0);
    g.add(new THREE.Mesh(geo, mat));
  };
  if (finish) seg(0, H, mats.checker);
  else {
    seg(0, H * 0.58, mats[color]); seg(H * 0.58, H * 0.68, mats.white); seg(H * 0.68, H * 0.86, mats[color]); seg(H * 0.86, H, mats.white);
  }
  const cap = new THREE.Mesh(new THREE.SphereGeometry(rb * 0.22, 10, 6), mats.white);
  cap.position.y = H; g.add(cap);
  return g;
}

function balloonMesh(r, tether, mats, gold) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), gold ? mats.gold : mats.balloon);
  b.scale.y = 1.12; g.add(b);
  const t = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, tether, 4, 1, true), mats.tether);
  t.position.y = -r - tether / 2; g.add(t);
  return g;
}

let bullTex = null;
/** Bullseye face: white board, black / red rings, a red centre. */
function bullseye() {
  if (bullTex) return bullTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#f2efe6'; x.fillRect(0, 0, 128, 128);
  for (const [r, col] of [[60, '#111'], [52, '#f2efe6'], [44, '#111'], [34, '#f2efe6'], [26, '#c8231b'], [16, '#f2efe6'], [9, '#c8231b']]) {
    x.fillStyle = col; x.beginPath(); x.arc(64, 64, r, 0, TAU); x.fill();
  }
  bullTex = new THREE.CanvasTexture(c);
  bullTex.colorSpace = THREE.SRGBColorSpace;
  return bullTex;
}

const PANEL_W = 16, PANEL_C = 10;   // board size (m) and centre height above the ground
/**
 * A strafing panel: a big bullseye board on two posts (on a raft over water). Gun hits score by ring
 * (bullseye 50 · 25 · 10 · 5); after 30 hits, or one missile, it is shredded.
 */
function makePanel(g, x, z, heading, water, mats) {
  const env = g.env, gy = env.groundHeight(x, z);
  const obj = new THREE.Group();
  const box = new THREE.BoxGeometry(1, 1, 1);
  const part = (mat, sx, sy, sz, px, py, pz) => { const m = new THREE.Mesh(box, mat); m.scale.set(sx, sy, sz); m.position.set(px, py, pz); obj.add(m); return m; };
  if (water) part(mats.raft, PANEL_W + 4, 1.2, 8, 0, 0.3, 0);
  for (const sx of [-PANEL_W * 0.42, PANEL_W * 0.42]) part(mats.post, 0.7, PANEL_C + 2, 0.7, sx, (PANEL_C + 2) / 2, 0.6);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_W), mats.board);
  face.position.set(0, PANEL_C, 0); face.rotation.x = -0.12;   // leaning back a touch toward the pilot
  obj.add(face);
  obj.position.set(x, gy, z); obj.rotation.y = heading;
  g.scene.add(obj);
  const centre = new THREE.Vector3(x, gy + PANEL_C, z);
  const u = {
    kind: 'ground', type: 'panel', team: 1, name: 'BULLSEYE', obj, spec: null, fm: null, ai: null,
    pos: centre, vel: new THREE.Vector3(), radius: PANEL_W * 0.55,
    alive: true, hp: 1e6, maxHp: 1e6, isPlayer: false, score: 50, primary: false,
    cd: 1e9, burst: 0, burstCd: 0, smoke: 0, smokeLife: 0, hits: 0, bulls: 0, killLabel: 'TARGET SHREDDED',
    onHitAt(game, pos, byMissile, shooter) {
      if (!u.alive) return;
      if (byMissile) { game.kill(u, shooter); return; }
      if (shooter !== game.player) return;
      const d = pos.distanceTo(centre), r = PANEL_W / 2;
      const pts = d < r * 0.15 ? 50 : d < r * 0.4 ? 25 : d < r * 0.75 ? 10 : 5;
      u.hits++;
      if (pts === 50) { u.bulls++; game.say(`BULLSEYE  +${Math.round(50 * game.diff.score)}`, 'good'); }
      game.addScore(pts * game.diff.score);
      if (u.hits >= 30) game.kill(u, shooter);
    },
    onKill() {
      // shredded: the board drops flat, splinters fly
      face.rotation.x = -1.45; face.position.y = 2;
      for (let i = 0; i < 12; i++) g.effects.spawn(centre.x, centre.y, centre.z, (Math.random() - 0.5) * 30, Math.random() * 20, (Math.random() - 0.5) * 30, 0.8, 1.6, 0.85, 0.8, 0.7, 1, 0.5, 1, 9, 0, 0.01);
    },
    dispose() { g.scene.remove(obj); box.dispose(); face.geometry.dispose(); },
  };
  g.units.push(u);
  return u;
}

/* ------------------------------------------------------------------ mission */

export function airRaceMission(g) {
  const env = g.env, p = g.player, spec = p.spec, diff = g.diff;
  const size = courseSize(spec, p.radius, diff);
  const { W, H, V } = size;
  const home = g.homeBase();
  const courseKey = `${env.map.key || g.settings.get('map')}:${p.key}:${g.settings.get('difficulty')}`;
  let course = buildCourse(env, size, courseKey, home);
  // not room for every gate (big aircraft on a tight map): shorter legs
  for (const k of [0.8, 0.65]) {
    if (course && course.gates.length >= size.n) break;
    const c2 = buildCourse(env, { ...size, L: size.L * k }, courseKey, home);
    if (c2 && (!course || c2.gates.length > course.gates.length)) course = c2;
  }
  const armed = p.gun > 0 || p.missiles > 0;
  const night = !!(env.atmo.night || env.atmo.sunElev < 12);

  if (!course) {
    g.placePlayer({ x: home.x, z: home.z, y: home.y + 800, heading: home.heading || 0 });
    g.say('NO ROOM FOR A COURSE HERE', 'danger');
    return { objective: () => 'NO COURSE ON THIS MAP', update() { g.finish(false, 'NO COURSE'); } };
  }

  const L = (c, e = 0) => new THREE.MeshLambertMaterial({ color: new THREE.Color(c).multiplyScalar(2.2), emissive: new THREE.Color(c).multiplyScalar(e) });
  const glow = night ? 0.55 : size.arcade ? 0.12 : 0;
  const mats = {
    blue: L(0x1f4fb8, glow), red: L(0xc02a1f, glow), white: L(0xd8dcdc, glow * 0.6),
    checker: new THREE.MeshLambertMaterial({ map: checker(), color: 0xffffff, emissive: night ? 0x444444 : 0, emissiveMap: night ? checker() : null }),
    balloon: L(0xff4a10, night ? 0.5 : 0.35), tether: L(0x333333),
    gold: L(0xffc21a, night ? 0.6 : 0.4), post: L(0x6b5a44), raft: L(0x8a6a3a),
    board: new THREE.MeshLambertMaterial({ map: bullseye(), emissive: night ? 0x666666 : 0x222222, emissiveMap: bullseye() }),
  };
  const group = new THREE.Group();
  g.scene.add(group);
  // racing line (arcade): glowing dots in the air leading through the next gate to the one after
  let rline = null, lineSeg = null, lineN = 0;
  if (size.arcade) {
    const N = 48, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setDrawRange(0, 0);
    const lm = mats.line = new THREE.PointsMaterial({ map: dot(), color: 0x60ff90, size: clamp(W * 0.09, 5, 15), sizeAttenuation: true,
      transparent: true, opacity: 0.95, depthWrite: false, fog: false });
    rline = new THREE.Points(geo, lm); rline.frustumCulled = false;
    group.add(rline);
  }
  // your best run on this course: split times and a ghost to race
  const best = loadRun(courseKey);
  const ghost = best && best.path && best.path.length >= 14 ? makeGhost(p.key, best.path) : null;
  if (ghost) group.add(ghost.obj);

  // gates: every 4th one (from the 3rd) a knife-edge red gate; none on easy, nor for aircraft that
  // can't really fly knife-edge (helicopters, airliners, the Cessna)
  const knifeOk = diff.n >= 1 && spec.type !== 'heli' && spec.rollRate >= 2;
  const gates = course.gates.map((c, i) => {
    const last = i === course.gates.length - 1;
    const kind = last ? 'finish' : knifeOk && i % 4 === 2 ? 'knife' : 'level';
    const tx = -c.nz, tz = c.nx;          // lateral unit vector
    const rb = clamp(H * 0.035, 1.6, 6);
    const pylons = [-1, 1].map(side => {
      const x = c.x + tx * side * W / 2, z = c.z + tz * side * W / 2;
      // each pylon stands on its own ground, tall enough that both tops are level at the gate's top
      const base = env.groundHeight(x, z), ph = c.base + H - base;
      const m = pylonMesh(ph, rb, kind === 'knife' ? 'red' : 'blue', mats, kind === 'finish' || i === 0);
      m.position.set(x, base, z);
      const bm = mats['beacon' + i + side] = new THREE.MeshBasicMaterial({ color: 0x40ff60, transparent: true, opacity: 0.9, fog: false });
      const beacon = new THREE.Mesh(new THREE.SphereGeometry(rb * 0.45, 10, 6), bm);
      beacon.position.y = ph + rb * 0.4; beacon.visible = false; m.add(beacon);
      group.add(m);
      return { x, z, base, h: ph, rb, mesh: m, beacon, torn: 0 };
    });
    // the light curtain between the pylons: shown on the next gate (arcade), flashes when you pass
    let cur = null;
    if (size.arcade) {
      const cm = mats['curtain' + i] = new THREE.MeshBasicMaterial({
        map: curtain(), color: kind === 'knife' ? 0xff3a20 : 0x20ff60, transparent: true, opacity: 0, side: THREE.DoubleSide,
        depthWrite: false, fog: false,
      });
      cur = new THREE.Mesh(new THREE.PlaneGeometry(W - rb * 2, H), cm);
      cur.position.set(c.x, c.base + H / 2, c.z);
      cur.rotation.y = Math.atan2(-c.nx, -c.nz);   // plane normal along the course
      cur.visible = false;
      group.add(cur);
    }
    return { ...c, i, kind, tx, tz, top: c.base + H, pylons, s: null, done: false, cur, flash: 0 };
  });

  // gunnery range along the legs (armed aircraft only)
  const targets = [];
  if (armed) {
    const rr = seeded(`${p.key}:range`);
    for (let i = 0; i < gates.length - 1; i++) {
      const a = gates[i], b = gates[i + 1];
      const lx = b.x - a.x, lz = b.z - a.z, len = Math.hypot(lx, lz), ux = lx / len, uz = lz / len;
      if (i % 2 === 0) {
        // a cluster of three tethered balloons to one side, a little above the gate line
        const side = rr() < 0.5 ? -1 : 1;
        for (let k = 0; k < 3; k++) {
          const t = 0.45 + k * 0.08, off = side * (W * 0.8 + k * W * 0.4);
          const x = a.x + lx * t - uz * off, z = a.z + lz * t + ux * off;
          const gy = env.groundHeight(x, z), y = Math.max(a.y, b.y) + 10 + k * 12;
          const r = size.balloonR;
          // arcade: the middle one of each cluster is a gold bonus balloon, worth a second off your time
          const gold = size.arcade && k === 1;
          const obj = balloonMesh(r, y - gy - r, mats, gold);
          obj.position.set(x, y, z);
          group.add(obj);
          const u = addTarget(g, {
            type: 'balloon', name: gold ? 'GOLD BALLOON' : 'BALLOON', obj, x, y, z, radius: r, hp: 6, score: gold ? 100 : 50,
            pop() { obj.visible = false; burst(g, obj.position, gold); if (gold && u.killedBy === p) goldBonus(); },
          }, y, rr() * TAU);
          if (gold) u.killLabel = 'GOLD BALLOON −1 S';
          targets.push(u);
        }
      } else if (i % 4 === 1) {
        // strafing panels: big bullseye boards (on a raft over water), scored by where the rounds hit
        const side = rr() < 0.5 ? -1 : 1, off = side * (W * 0.75);
        const x = a.x + lx * 0.55 - uz * off, z = a.z + lz * 0.55 + ux * off;
        env.ground(x, z, _gi);
        if (!env.buildingAt(x, _gi.y + 5, z, 12)) targets.push(makePanel(g, x, z, Math.atan2(-ux, -uz), _gi.water, mats));
      } else if (i % 4 === 3) {
        // range hulks: old armour parked by the course, on land only
        for (let k = 0; k < 2; k++) {
          const off = (k ? 1 : -1) * (W * 1.2 + 25);
          const x = a.x + lx * 0.5 - uz * off, z = a.z + lz * 0.5 + ux * off;
          env.ground(x, z, _gi);
          if (_gi.water || env.buildingAt(x, _gi.y + 2, z, 6)) continue;
          const u = g.spawnGround(k ? 'truck' : 'tank', 1, x, z, { heading: rr() * TAU, primary: false });
          u.name = k ? 'RANGE TRUCK' : 'RANGE TANK';
          targets.push(u);
        }
      }
    }
    // a full-scale target drone (a retired fighter flown by remote control) orbiting the course
    let cx = 0, cz = 0, top = 0;
    for (const q of gates) { cx += q.x / gates.length; cz += q.z / gates.length; top = Math.max(top, q.base); }
    const R = clamp(size.L * 1.5, 1200, 2500), alt = top + Math.max(250, H * 2.5);
    const wps = Array.from({ length: 8 }, (_, k) => ({ x: cx + Math.cos(k / 8 * TAU) * R, z: cz + Math.sin(k / 8 * TAU) * R, y: alt }));
    const dk = spec.type === 'prop' || spec.vMax < 220 ? 'c172' : 'mig29';
    const d = g.spawnAir(dk, 1, { x: wps[0].x, z: wps[0].z, y: alt, heading: 0, score: 300, ai: { role: 'drone', waypoints: wps, cruiseAlt: alt, minAGL: 300, cruiseThrottle: 0.6 } });
    d.name = 'TARGET DRONE';
    d.gun = 0; d.missiles = 0; d.flares = 0;
    targets.push(d);
  }

  // start: on the approach to gate 1
  const g0 = gates[0];
  const sh = Math.atan2(g0.x - course.start.x, -(g0.z - course.start.z));
  g.placePlayer({ x: course.start.x, z: course.start.z, y: course.start.y, heading: sh });
  p.obj.position.y = Math.max(course.start.y, env.groundHeight(course.start.x, course.start.z) + 60);
  if (spec.type !== 'heli') { const v = Math.min(V, spec.vMax * 0.8); p.fm.velocity.set(dirX(sh) * v, 0, dirZ(sh) * v); }
  g.ui && (g.ui.throttle = p.fm.throttle);

  // par time: the timed line (gate 1 to the finish) at race speed
  let line = 0;
  for (let i = 1; i < gates.length; i++) line += Math.hypot(gates[i].x - gates[i - 1].x, gates[i].z - gates[i - 1].z);
  const par = line / (V * 1.05);

  let streak = 0, count = 3, recT = 0, faults = 0, golds = 0;
  const splits = [], path = [];
  let next = 0, t = 0, wait = 0, pen = 0, clean = 0, passed = 0, hits = 0, started = false;
  const PEN = size.pen, bankLimit = size.bank, knifeMin = size.knife;
  const label = () => ({ edge: true, pos: g.v3(gates[next].x, gates[next].y, gates[next].z), label: next === gates.length - 1 ? 'FINISH' : `GATE ${next + 1}${gates[next].kind === 'knife' ? ' KNIFE' : ''}` });
  g.waypoint = label();
  layLine();
  g.say(`AIR RACE · ${gates.length} GATES${armed ? ' · SHOOT THE TARGETS FOR POINTS' : ''}`, 'good');

  const penalty = (s, why) => { pen += s; faults += s; g.say(`${why} +${s} S`, 'warn'); };
  /** Racing line: dots from just behind the next gate's approach, through it, toward the gate after. */
  /** Each frame: draw only the dots still ahead of you (the ones you passed would blob up by the camera). */
  function trimLine() {
    if (!rline || !lineSeg) return;
    const L2 = lineSeg.dx * lineSeg.dx + lineSeg.dz * lineSeg.dz;
    const kp = ((p.pos.x - lineSeg.x) * lineSeg.dx + (p.pos.z - lineSeg.z) * lineSeg.dz) / Math.max(L2, 1) + 60 / Math.sqrt(Math.max(L2, 1));
    const skip = clamp(Math.ceil((kp - lineSeg.t0) / (1 - lineSeg.t0) * lineSeg.cnt), 0, lineSeg.cnt);
    rline.geometry.setDrawRange(skip, Math.max(0, lineN - skip));
  }

  function layLine() {
    if (!rline) return;
    const a = rline.geometry.attributes.position, arr = a.array, N = arr.length / 3;
    const q = gates[next], q2 = gates[next + 1];
    const from = next > 0 ? gates[next - 1] : { x: course.start.x, y: q.y, z: course.start.z };
    let n = 0;
    const seg = (ax, ay, az, bx, by, bz, cnt, t0) => {
      for (let i = 0; i < cnt && n < N; i++) {
        const k = t0 + (1 - t0) * i / cnt;
        arr[n * 3] = ax + (bx - ax) * k; arr[n * 3 + 1] = ay + (by - ay) * k; arr[n * 3 + 2] = az + (bz - az) * k; n++;
      }
    };
    lineSeg = { x: from.x, z: from.z, dx: q.x - from.x, dz: q.z - from.z, t0: 0.12, cnt: 28 };
    seg(from.x, from.y, from.z, q.x, q.y, q.z, 28, 0.12);
    if (q2) seg(q.x, q.y, q.z, q2.x, q2.y, q2.z, 18, 0); else { arr[n * 3] = q.x; arr[n * 3 + 1] = q.y; arr[n * 3 + 2] = q.z; n++; }
    a.needsUpdate = true;
    lineN = n;
    rline.geometry.setDrawRange(0, n);
    rline.material.color.setHex(q.kind === 'knife' ? 0xff6040 : 0x60ff90);
  }

  /** Gate assist (arcade): when roughly lined up with the next gate, nudge the stick toward its centre.
   *  The less you move the stick yourself, the more it helps; any real input takes over. */
  const aIn = { pitch: 0, roll: 0, yaw: 0 }, aOut = {}, _w = new THREE.Vector3(), _fw = new THREE.Vector3();
  let gcasT = 0, help = 0, helpGcas = false;
  // what the assist is doing right now, for the HUD light: smoothed so it doesn't flicker
  const helped = (w, gcas, dt) => { help += (w - help) * clamp((dt || 0) * 6, 0, 1); helpGcas = gcas; };
  function assist(inp, dt) {
    const out = steer(inp, dt);
    if (out === inp) helped(0, false, dt);
    return out;
  }
  function steer(inp, dt) {
    if (!size.assist || !g.settings.get('assist') || !p.alive || spec.type === 'heli' || p.fm.onGround) return inp;   // ASSIST OFF (RAW): no help
    // Auto-GCAS (like the F-16's): about to fly into the ground or water -> roll level and pull up
    gcasT = Math.max(0, gcasT - (dt || 0));
    let floor = -Infinity, worst = Infinity;
    for (const s of [0.5, 1, 2, 3, 4]) {
      const gy = env.groundHeight(p.pos.x + p.vel.x * s, p.pos.z + p.vel.z * s);
      floor = Math.max(floor, gy);
      worst = Math.min(worst, p.pos.y + p.vel.y * s - gy);
    }
    if (worst < 25 + spec.bellyH * 2 || p.pos.y - env.groundHeight(p.pos.x, p.pos.z) < 15) {
      _w.set(p.vel.x, 0, p.vel.z).normalize(); _w.y = 0.5; _w.normalize();
      steerToward(p.obj, p.fm, spec, _w, 1, 1, 0.6, aIn);
      if (gcasT <= 0) { g.say('AUTO-GCAS · PULL UP', 'warn'); gcasT = 4; }
      Object.assign(aOut, inp);
      aOut.pitch = Math.max(inp.pitch, aIn.pitch); aOut.roll = aIn.roll; aOut.yaw = 0;
      helped(1, true, dt);
      return aOut;
    }
    const q = gates[next];
    const dx = q.x - p.pos.x, dz = q.z - p.pos.z, d = Math.hypot(dx, dz);
    const along = dx * q.nx + dz * q.nz;
    if (along < 20 || d > V * 14) { aIn.pitch = aIn.roll = aIn.yaw = 0; return inp; }
    // aim a little short of the gate on its axis when far, at the centre when close
    const back = clamp(d * 0.3, 0, 250);
    _w.set(q.x - q.nx * back - p.pos.x, q.y - p.pos.y, q.z - q.nz * back - p.pos.z).normalize();
    _fw.set(0, 0, -1).applyQuaternion(p.obj.quaternion);
    const lined = _fw.dot(_w);
    if (lined < 0.75) return inp;                            // not lined up (> ~40°): you're on your own
    steerToward(p.obj, p.fm, spec, _w, 0.6, 0, 0.25, aIn);
    // wings level into a blue gate
    if (q.kind !== 'knife' && d < V * 1.2) {
      _r.set(1, 0, 0).applyQuaternion(p.obj.quaternion);
      aIn.roll = clamp(-Math.asin(clamp(_r.y, -1, 1)) * 3 / spec.rollRate, -1, 1);
    }
    const human = Math.max(Math.abs(inp.pitch), Math.abs(inp.roll));
    const w = size.assist * clamp((lined - 0.75) / 0.15, 0, 1) * (1 - clamp(human * 1.6, 0, 1));
    Object.assign(aOut, inp);
    aOut.pitch = inp.pitch + (aIn.pitch - inp.pitch) * w;
    aOut.roll = inp.roll + (aIn.roll - inp.roll) * w;
    aOut.yaw = inp.yaw + (aIn.yaw - inp.yaw) * w;
    helped(size.assist ? w / size.assist : 0, false, dt);
    return aOut;
  }

  function goldBonus() { pen -= 1; golds++; g.audio.play('gate'); }
  let topV = 0, topG = 0, bestStreak = 0, puffD = 0;
  const fmt = (s) => { const d = Math.round(s * 10); return `${Math.floor(d / 600)}:${((d % 600) / 10).toFixed(1).padStart(4, '0')}`; };

  function gateCrossed(q) {
    // which side of the gate plane, and where across it
    const dx = p.pos.x - q.x, dz = p.pos.z - q.z;
    const s = dx * q.nx + dz * q.nz;
    const prev = q.s; q.s = s;
    if (prev == null || !(prev < 0 && s >= 0)) return null;
    const lat = dx * q.tx + dz * q.tz;
    return { lat, y: p.pos.y };
  }

  function judge(q, x) {
    const half = W * (0.5 + size.slack);
    splits[q.i] = t + pen;
    if (Math.abs(x.lat) > half) { penalty(PEN.miss, `MISSED GATE ${q.i + 1}`); streak = 0; splits[q.i] = t + pen; return; }
    let ok = true;
    if (x.y > q.top) { penalty(PEN.high, 'TOO HIGH'); ok = false; }
    _r.set(1, 0, 0).applyQuaternion(p.obj.quaternion);
    const bank = Math.abs(Math.asin(clamp(_r.y, -1, 1)));
    if (q.kind === 'level' && bank > bankLimit) { penalty(PEN.attitude, 'NOT LEVEL'); ok = false; }
    if (q.kind === 'knife' && bank < knifeMin) { penalty(PEN.attitude, 'NO KNIFE-EDGE'); ok = false; }
    passed++;
    splits[q.i] = t + pen;
    if (!ok) { streak = 0; g.addScore(40 * diff.score); return; }
    clean++; streak++; bestStreak = Math.max(bestStreak, streak);
    g.audio.play(q.i === 0 ? 'go' : 'gate');
    // clean-gate streak: x2 from the 3rd in a row, x3 from the 6th, x4 from the 9th
    const mult = Math.min(4, 1 + Math.floor(streak / 3));
    const pts = 100 * mult * diff.score;
    // split against your best run on this course
    let split = '', ahead = true;
    if (best && best.splits && best.splits[q.i] != null && q.i > 0) {
      const d = splits[q.i] - best.splits[q.i];
      ahead = d <= 0;
      split = ` · ${d <= 0 ? '−' : '+'}${Math.abs(d).toFixed(1)} S`;
    }
    const name = q.i === 0 ? 'GO! GATE 1' : q.kind === 'finish' ? 'FINISH' : `GATE ${q.i + 1}`;
    g.addScore(pts);
    g.say(`${name}${mult > 1 ? ` ×${mult}` : ''}  +${Math.round(pts)}${split}`, ahead ? 'good' : 'warn');
  }

  function pylonHits(dt) {
    // ripped pylons: the fabric sags down in a second or two
    for (const gt of gates) for (const py of gt.pylons) if (py.torn > 0 && py.torn < 2) {
      py.torn += dt;
      py.mesh.scale.y = Math.max(0.05, 1 - py.torn * 0.7);
      py.mesh.scale.x = py.mesh.scale.z = 1 + Math.min(py.torn, 1) * 0.4;
    }
    for (let i = Math.max(0, next - 1); i < Math.min(gates.length, next + 2); i++) {
      for (const py of gates[i].pylons) {
        if (py.torn > 0) continue;
        const hy = p.pos.y - py.base;
        if (hy < -2 || hy > py.h + 1) continue;
        const r = py.rb * (1 - 0.78 * clamp(hy, 0, py.h) / py.h) + p.radius * 0.45;
        if (Math.hypot(p.pos.x - py.x, p.pos.z - py.z) < r) {
          py.torn = 0.01; hits++;
          _v.set(py.x, p.pos.y, py.z);
          g.effects.hitSpark(_v);
          g.damage(p, size.pylonDmg, null);
          penalty(PEN.pylon, 'PYLON HIT');
        }
      }
    }
  }

  function finishRace() {
    const total = t + pen;
    const bonus = Math.max(0, par * 1.5 - total) / (par * 0.5) * 1000;
    if (bonus > 0) g.addScore(bonus * diff.score, 'TIME BONUS');
    const shot = targets.filter(u => !u.alive && u.killedBy === p).length;
    const grade = passed < gates.length * 0.7 ? 'COURSE FINISHED' : faults === 0 ? 'CLEAN RUN' : faults <= 4 ? 'GREAT RUN' : faults <= 12 ? 'GOOD RUN' : 'ROUGH RUN';
    // medal against par (penalties included)
    const medal = passed < gates.length * 0.7 ? '' : total <= par ? 'GOLD' : total <= par * 1.15 ? 'SILVER' : total <= par * 1.35 ? 'BRONZE' : '';
    // best time on this course: keep the splits and the ghost
    const newBest = passed === gates.length && (!best || total < best.total);
    if (newBest) saveRun(courseKey, { total, splits: splits.slice(), path, medal });
    const vsBest = best && !newBest ? ` · best ${fmt(best.total)}` : '';
    // your top 5 times on this course
    let top = loadTop(courseKey), rank = 0;
    if (passed === gates.length) {
      top.push(total); top.sort((a, b) => a - b); top = top.slice(0, 5);
      rank = top.indexOf(total) + 1; saveTop(courseKey, top);
    }
    const bulls = targets.reduce((n, u) => n + (u.bulls || 0), 0);
    const stats = `<br>Top speed ${Math.round(topV * 1.944)} kt · ${topG.toFixed(1)} g max · best streak ${bestStreak}` + (bulls ? ` · ${bulls} bullseye${bulls > 1 ? 's' : ''}` : '') +
      (top.length ? `<br>Your top ${top.length}: ${top.map((x, i) => (i + 1 === rank ? `<b>${fmt(x)}</b>` : fmt(x))).join(' · ')}` : '');
    const mapName = (env.map.name || '').replace(/\b\w/g, c => c.toUpperCase()).replace(/\B\w/g, c => c.toLowerCase());
    const share = `I flew the OpenWings Air Race${mapName ? ` (${mapName})` : ''} in the ${spec.name} in ${fmt(total)}` +
      `${medal ? ` — ${medal.toLowerCase()} medal` : ''}${faults === 0 ? ', clean run' : ''}! Can you beat it?`;
    g.finish(true, `${medal ? medal + ' · ' : ''}${grade}`,
      `${newBest ? 'NEW BEST TIME · ' : ''}Time ${fmt(t)}${faults ? ` + ${faults} s penalties` : ''}${golds ? ` − ${golds} s gold` : ''}${pen || golds ? ` = ${fmt(total)}` : ''} (par ${fmt(par)}${vsBest}) · ${clean}/${gates.length} clean gates` +
      (hits ? ` · ${hits} pylon hit${hits > 1 ? 's' : ''}` : '') + (armed ? ` · ${shot}/${targets.length} targets` : '') + stats);
    if (g.result) g.result.share = share;
  }

  return {
    course: gates, size, targets, ghost, best,
    objective: () => {
      const q = gates[next];
      const what = q.kind === 'finish' ? 'FINISH GATE' : q.kind === 'knife' ? `GATE ${next + 1}/${gates.length} · RED: KNIFE-EDGE` : `GATE ${next + 1}/${gates.length} · BLUE: WINGS LEVEL`;
      const left = armed ? targets.filter(u => u.alive).length : 0;
      return `${what}${pen ? ` · ${pen > 0 ? '+' : '−'}${Math.abs(pen)} S` : ''}${left ? ` · ${left} TARGETS` : ''}`;
    },
    timer: () => t + pen,
    /** test / screenshot hook: make gate i the next one, clock running */
    skipTo(i) { next = clamp(i, 0, gates.length - 1); started = true; for (const q of gates) q.s = null; g.waypoint = label(); layLine(); },
    assist,
    /** HUD light: '' (not helping), 'ASSIST' (steering you toward the gate) or 'GCAS' (pulling up) */
    assistState: () => helpGcas && help > 0.05 ? 'GCAS' : help > 0.15 ? 'ASSIST' : '',
    update(dt) {
      if (g.state !== 'playing' || !p.alive) return;
      // the clock starts at gate 1, like a real race
      if (started) t += dt; else wait += dt;
      // countdown on the run-in: 3 - 2 - 1 by the time to gate 1 (GO! comes with the gate)
      if (!started && count > 0) {
        const q0 = gates[0], along = (q0.x - p.pos.x) * q0.nx + (q0.z - p.pos.z) * q0.nz;
        const eta = along / Math.max(p.fm.speed, 1);
        if (along > 0 && eta < count + 0.05 && eta > count - 1) { g.say(String(count), 'good'); g.audio.play('count'); count--; }
      }
      // record this run for the ghost (position x10, quaternion x1000, every GHOST_DT)
      if (started) {
        recT -= dt;
        if (recT <= 0 && path.length < 7 * 3000) {
          recT += GHOST_DT;
          const q = p.obj.quaternion;
          path.push(Math.round(p.pos.x * 10), Math.round(p.pos.y * 10), Math.round(p.pos.z * 10),
            Math.round(q.x * 1000), Math.round(q.y * 1000), Math.round(q.z * 1000), Math.round(q.w * 1000));
        }
      }
      if (ghost) ghost.at(t, started);
      trimLine();
      if (started) {
        topV = Math.max(topV, p.fm.speed); topG = Math.max(topG, p.fm.gForce || 0);
        // race smoke: a white trail from the tail, like the real racers
        const V = p.fm.speed;
        puffD += V * dt;
        if (puffD >= 8) {
          _r.set(0, 0, 1).applyQuaternion(p.obj.quaternion);
          let n = 0;
          while (puffD >= 8 && n < 12) {
            puffD -= 8; n++;
            _v.copy(p.pos).addScaledVector(_r, p.radius * 1.1).addScaledVector(p.vel, -puffD / Math.max(V, 1));
            g.effects.spawn(_v.x, _v.y, _v.z, 0, 0, 0, 1.3, 4, 1, 1, 1, 0.28, 3.2, 0, 0, 0, 0.05);
          }
          if (puffD > 8) puffD = 0;
        }
      }
      for (const u of targets) if (u.bob && u.alive) {
        u.bobT += dt;
        u.obj.position.y = u.pos.y = u.y0 + Math.sin(u.bobT * 0.6) * 1.2;
        u.obj.rotation.z = Math.sin(u.bobT * 0.45) * 0.05;
      }
      pylonHits(dt);
      // the next gate: crossing it counts; crossing the one after while this one is open counts as a miss + pass
      const q = gates[next];
      const x = gateCrossed(q);
      const q2 = gates[next + 1], x2 = q2 && Math.abs((p.pos.x - q2.x) * q2.tx + (p.pos.z - q2.z) * q2.tz) < W ? gateCrossed(q2) : (q2 && (q2.s = null), null);
      if (x && Math.abs(x.lat) < Math.max(400, W * 4) && Math.abs(x.y - q.y) < 400) {
        judge(q, x); started = true; advance();
      } else if (x2) {
        penalty(PEN.miss, `MISSED GATE ${next + 1}`);
        gates[next].done = true;
        next++; judge(q2, x2); started = true; advance();
      }
      // beacons: the next gate's tops blink green
      const on = (g.time * 2.5) % 1 < 0.6;
      for (const gt of gates) {
        for (const py of gt.pylons) py.beacon.visible = gt.i === next && on && !py.torn;
        if (!gt.cur) continue;
        gt.flash = Math.max(0, gt.flash - dt * 1.6);
        const o = gt.done ? gt.flash * 0.9 : gt.i === next ? 0.62 + 0.18 * Math.sin(g.time * 5) : gt.i === next + 1 ? 0.2 : 0;
        gt.cur.visible = o > 0.01;
        gt.cur.material.opacity = o;
        if (gt.cur.visible) gt.cur.material.map.offset.y = -g.time * 0.25;
      }
      if (t > par * 4) g.finish(false, 'OUT OF TIME', `${passed}/${gates.length} gates`);
      else if (wait > 180) g.finish(false, 'NO START', 'Fly through gate 1 to start the clock.');
    },
    dispose() {
      if (ghost) ghost.dispose();
      for (const u of targets) if (u.type === 'panel') u.dispose();
      g.scene.remove(group);
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of Object.values(mats)) if (m.dispose) m.dispose();
    },
  };

  function advance() {
    gates[next].done = true; gates[next].flash = 1;
    next++;
    if (next >= gates.length) { next = gates.length - 1; finishRace(); return; }
    gates[next].s = null;
    g.waypoint = label();
    layLine();
  }
}

/** Register a custom airborne range target (balloon) as a ground-kind unit the weapons can hit. */
function addTarget(g, o, y, phase) {
  const u = {
    kind: 'ground', type: o.type, team: 1, name: o.name, obj: o.obj, spec: null, fm: null, ai: null,
    pos: new THREE.Vector3(o.x, y, o.z), vel: new THREE.Vector3(), radius: o.radius,
    alive: true, hp: o.hp, maxHp: o.hp, isPlayer: false, score: o.score, primary: false,
    cd: 1e9, burst: 0, burstCd: 0, smoke: 0, smokeLife: 0,
    bob: true, bobT: phase, y0: y, onKill: o.pop, killLabel: 'BALLOON POPPED',
  };
  g.units.push(u);
  return u;
}

/** Balloon pop: a burst of orange shreds and a puff. */
function burst(g, pos, gold) {
  const R = Math.random, fx = g.effects;
  for (let i = 0; i < 10; i++)
    fx.spawn(pos.x, pos.y, pos.z, (R() - 0.5) * 30, (R() - 0.3) * 24, (R() - 0.5) * 30, 0.8 + R() * 0.6, 1.2 + R(), 0.95, gold ? 0.78 : 0.35, gold ? 0.15 : 0.1, 1, 0.5, 1.2, 9, 0, 0.01);
  fx.spawn(pos.x, pos.y, pos.z, 0, 1, 0, 6, 0.8, 0.85, 0.85, 0.85, 0.35, 2.5, 1, 0, 0, 0.02);
}
