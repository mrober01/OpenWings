// AI pilot checks on the real island heightfield. Run: node tests/ai.test.mjs
import * as THREE from 'three';
import { FlightModel } from '../src/engine/FlightModel.js';
import { AIPilot } from '../src/engine/AIPilot.js';
import { AIRCRAFT_SPECS } from '../src/aircraft/AircraftSpecs.js';
import { Heightfield } from '../src/world/Heightfield.js';

const hf = new Heightfield();
hf.stride = 2;
const env = { ground: (x, z, o) => hf.ground(x, z, o) };
const DT = 1 / 60;
let failed = 0;
const check = (name, ok, msg) => { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + msg}`); if (!ok) failed++; };
const gi = { y: 0 };

function spawn(key, x, y, z, hdg, speed, opts) {
  const spec = AIRCRAFT_SPECS[key];
  const fm = new FlightModel(spec, { assist: true });
  const obj = new THREE.Object3D();
  obj.position.set(x, y, z);
  obj.quaternion.setFromEuler(new THREE.Euler(0, -hdg, 0));
  fm.setAirborne(obj, speed);
  const ai = new AIPilot(spec, opts);
  return { spec, fm, obj, ai, pos: obj.position, vel: fm.velocity, alive: true };
}
const agl = (a) => a.pos.y - env.ground(a.pos.x, a.pos.z, gi).y;

// 1. terrain: low-level patrol across the mountains for 4 minutes
console.log('\n== terrain avoidance (low patrol over the island)');
for (const key of ['ef2000', 'su35', 'a10', 'bomber']) {
  const wps = [];
  for (let i = 0; i < 8; i++) { const a = i * 2.4; wps.push({ x: Math.cos(a) * 11000, z: Math.sin(a) * 11000, y: 350 }); }
  const a = spawn(key, 0, env.ground(0, 0, gi).y + 1300, 0, 0.5, AIRCRAFT_SPECS[key].vStall * 2.2, { role: key === 'bomber' ? 'bomber' : 'fighter', waypoints: wps, cruiseAlt: 350, minAGL: 150 });
  let minAgl = 1e9, t = 0, maxAlt = 0;
  for (; t < 240 && !a.fm.crashed; t += DT) {
    a.ai.think(a.obj, a.fm, DT, env);
    a.fm.step(a.obj, a.ai.input, DT, env);
    minAgl = Math.min(minAgl, agl(a)); maxAlt = Math.max(maxAlt, a.pos.y);
  }
  check(`${key} survives 240 s at low level`, !a.fm.crashed, `crashed (${a.fm.crashed}) at t=${t.toFixed(0)}s pos ${a.pos.x.toFixed(0)},${a.pos.y.toFixed(0)},${a.pos.z.toFixed(0)}`);
  console.log(`        min AGL ${minAgl.toFixed(0)} m, max alt ${maxAlt.toFixed(0)} m, wp reached ${a.ai.wpIndex}, end speed ${a.fm.speed.toFixed(0)}`);
}

// 2. pursuit: catch a drone flying a lazy circle
console.log('\n== pursuit (fighter vs manoeuvring drone)');
for (const skill of [0.3, 0.9]) {
  const sq = [[4000, -4000], [4000, 4000], [-4000, 4000], [-4000, -4000]].map(([x, z]) => ({ x, z, y: 2000 }));
  const drone = spawn('mig29', 3000, 2000, -3000, 1.0, 220, { role: 'drone', waypoints: sq, cruiseAlt: 2000 });
  const hunter = spawn('ef2000', 0, 2200, 1500, 0, 230, { skill });
  hunter.ai.target = drone;
  let gunTime = 0, minRange = 1e9, firstGun = null, t = 0;
  for (; t < 120 && !hunter.fm.crashed && !drone.fm.crashed; t += DT) {
    drone.ai.think(drone.obj, drone.fm, DT, env);
    drone.fm.step(drone.obj, drone.ai.input, DT, env);
    hunter.ai.think(hunter.obj, hunter.fm, DT, env);
    hunter.fm.step(hunter.obj, hunter.ai.input, DT, env);
    minRange = Math.min(minRange, hunter.ai.range);
    if (hunter.ai.wantFire) { gunTime += DT; if (firstGun == null) firstGun = t; }
  }
  console.log(`   skill ${skill}: min range ${minRange.toFixed(0)} m, gun solution ${gunTime.toFixed(1)} s (first at ${firstGun == null ? '—' : firstGun.toFixed(0) + ' s'}), hunter speed ${hunter.fm.speed.toFixed(0)}, alt ${hunter.pos.y.toFixed(0)}`);
  check(`skill ${skill} neither crashes`, !hunter.fm.crashed && !drone.fm.crashed, `hunter ${hunter.fm.crashed} drone ${drone.fm.crashed}`);
  check(`skill ${skill} closes to gun range`, minRange < 1000, `min range ${minRange.toFixed(0)}`);
  if (skill > 0.8) check('ace gets a gun solution', gunTime > 0.3, `gun time ${gunTime.toFixed(2)}`);
}
// 3. duel: two AIs fight low over the mountains for 3 minutes, nobody may hit the ground
console.log('\n== duel (AI vs AI over mountains)');
{
  let crashes = 0, guns = 0;
  for (let round = 0; round < 4; round++) {
    const a = spawn('ef2000', -2500 + round * 300, 1500, 0, Math.PI / 2, 240, { skill: 0.8 });
    const b = spawn('su35', 2500, 1700, 600, -Math.PI / 2, 240, { skill: 0.6 });
    a.ai.target = b; b.ai.target = a;
    for (let t = 0; t < 180; t += DT) {
      for (const p of [a, b]) {
        if (p.fm.crashed) continue;
        p.ai.think(p.obj, p.fm, DT, env);
        p.fm.step(p.obj, p.ai.input, DT, env);
        if (p.ai.wantFire) guns += DT;
      }
    }
    for (const p of [a, b]) if (p.fm.crashed) { crashes++; console.log(`        round ${round}: ${p.spec.short} crashed (${p.fm.crashed}) state ${p.ai.state}`); }
  }
  console.log(`   total gun-solution time ${guns.toFixed(1)} s over 4 rounds, crashes ${crashes}/8`);
  check('duel: at most one terrain crash in 8 sorties', crashes <= 1, `${crashes} crashes`);
  check('duel: somebody gets guns on', guns > 1, `gun time ${guns.toFixed(1)}`);
}

// 4. evade: reacts to a missile warning and dumps flares
console.log('\n== missile evasion');
{
  const a = spawn('mig29', 0, 2500, 0, 0, 250, { skill: 0.7 });
  a.ai.target = { pos: new THREE.Vector3(0, 2500, -6000), vel: new THREE.Vector3(), alive: true };
  a.ai.threatMissile = true;
  let flares = 0; const h0 = new THREE.Vector3(0, 0, -1);
  for (let t = 0; t < 5; t += DT) { a.ai.think(a.obj, a.fm, DT, env); if (a.ai.wantFlare) flares++; a.fm.step(a.obj, a.ai.input, DT, env); }
  const turned = h0.angleTo(new THREE.Vector3(0, 0, -1).applyQuaternion(a.obj.quaternion)) * 57.3;
  console.log(`   turned ${turned.toFixed(0)}° in 5 s, ${flares} flares`);
  check('breaks hard', turned > 50, `only ${turned.toFixed(0)}°`);
  check('drops flares', flares >= 2, `${flares}`);
}

console.log(failed ? `\n${failed} AI CHECK(S) FAILED` : '\nALL AI CHECKS PASSED');
process.exit(failed ? 1 : 0);
