// Flight-model envelope checks. Run: node tests/flight.test.mjs
// Prints a table per aircraft and exits non-zero if an envelope check fails.
import * as THREE from 'three';
import { FlightModel } from '../src/engine/FlightModel.js';
import { AIRCRAFT_SPECS } from '../src/aircraft/AircraftSpecs.js';

const env = { ground(x, z, o) { o.y = 10; o.water = false; o.runway = true; o.slope = 0; return o; } };
const DT = 1 / 60;
let failed = 0;
const check = (name, ok, msg) => { if (!ok) { failed++; console.log(`   FAIL ${name}: ${msg}`); } };
const mk = (key, assist = true) => {
  const spec = AIRCRAFT_SPECS[key];
  const fm = new FlightModel(spec, { assist });
  const obj = new THREE.Object3D();
  return { spec, fm, obj };
};
const inp = (o = {}) => ({ pitch: 0, roll: 0, yaw: 0, throttle: 1, brake: false, ...o });
const bankOf = (obj) => {
  const r = new THREE.Vector3(1, 0, 0).applyQuaternion(obj.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(obj.quaternion);
  return Math.atan2(-r.y, u.y);
};

for (const key of Object.keys(AIRCRAFT_SPECS)) {
  const spec = AIRCRAFT_SPECS[key];
  console.log(`\n== ${key} (${spec.name}) cd0=${new FlightModel(spec).cd0.toFixed(4)}`);
  if (spec.type === 'heli') {
    const { fm, obj } = mk(key);
    obj.position.set(0, 10 + spec.bellyH, 0);
    let t = 0;
    for (; t < 20; t += DT) fm.step(obj, inp({ throttle: 0.75 }), DT, env);
    const climbed = obj.position.y;
    check('heli climb', climbed > 60 && !fm.crashed, `alt ${climbed.toFixed(0)}`);
    for (t = 0; t < 30; t += DT) fm.step(obj, inp({ throttle: 0.62, pitch: -0.7 }), DT, env);
    console.log(`   heli: alt after 20s ${climbed.toFixed(0)} m, fwd speed ${fm.speed.toFixed(0)} m/s (vMax ${spec.vMax}), vs ${fm.vs.toFixed(1)}`);
    check('heli speed', fm.speed > spec.vMax * 0.5, `speed ${fm.speed.toFixed(0)}`);
    // descend & land
    for (t = 0; t < 12; t += DT) fm.step(obj, inp({ throttle: 0.5, pitch: 0.5 }), DT, env);
    let landed = false;
    for (t = 0; t < 240 && !landed && !fm.crashed; t += DT) {
      const thr = fm.vs < -3 ? 0.56 : 0.44;
      fm.step(obj, inp({ throttle: thr }), DT, env); landed = fm.onGround;
    }
    check('heli land', landed && !fm.crashed, `landed=${landed} crashed=${fm.crashed}`);
    continue;
  }

  // 1. takeoff
  {
    const { fm, obj } = mk(key);
    obj.position.set(0, 10 + spec.bellyH + spec.gearH, 0);
    let t = 0, roll = null, tLift = null;
    for (; t < 90; t += DT) {
      const pull = fm.speed > spec.vStall * 0.8 ? 0.6 : 0;
      if (!fm.onGround && fm.altitudeAGL > 15) fm.gearDown = false;
      const th = Math.asin(new THREE.Vector3(0, 0, -1).applyQuaternion(obj.quaternion).y);
      fm.step(obj, inp({ pitch: fm.onGround ? pull : clamp((0.17 - th) * 2, -0.3, 0.5) }), DT, env);
      if (roll == null && !fm.onGround) { roll = -obj.position.z; tLift = t; }
      if (fm.crashed) break;
    }
    console.log(`   takeoff: roll ${roll?.toFixed(0)} m in ${tLift?.toFixed(1)} s; at 90s alt ${obj.position.y.toFixed(0)} m, ${fm.speed.toFixed(0)} m/s`);
    check('takeoff', roll != null && roll < 2100 && !fm.crashed && obj.position.y > 150, `roll ${roll} crashed ${fm.crashed} alt ${obj.position.y}`);
  }

  // 2. top speed & hands-off stability (assist on)
  {
    const { fm, obj } = mk(key);
    obj.position.set(0, 300, 0);
    fm.setAirborne(obj, spec.vMax * 0.6);
    let minY = 1e9, maxY = -1e9;
    for (let t = 0; t < 150; t += DT) {
      fm.step(obj, inp({ pitch: t < 110 ? clamp(-fm.vs * 0.02, -0.2, 0.2) : 0 }), DT, env); // level off, then hands-off
      if (t > 110) { minY = Math.min(minY, obj.position.y); maxY = Math.max(maxY, obj.position.y); }
    }
    const rho = Math.exp(-obj.position.y / 9000);
    console.log(`   top speed ${fm.speed.toFixed(0)} m/s (spec ${spec.vMax}), hands-off alt drift ${(minY - 300).toFixed(0)}..${(maxY - 300).toFixed(0)} m, aoa ${(fm.aoa * 57.3).toFixed(1)}°`);
    check('top speed', Math.abs(fm.speed - spec.vMax) / spec.vMax < 0.1, `${fm.speed.toFixed(0)} vs ${spec.vMax}`);
    check('hands-off', maxY - minY < spec.vMax * 40 * 0.03, `drift ${(maxY - minY).toFixed(0)}`);
  }

  // 3. max-rate turn from corner speed (bank 78°, full pull, full power)
  {
    const { fm, obj } = mk(key);
    const vc = Math.min(spec.vStall * Math.sqrt(spec.gMax), spec.vMax * 0.9);
    obj.position.set(0, 1500, 0);
    fm.setAirborne(obj, vc);
    let maxG = 0, turned = 0, t = 0, tRoll = null; const pv = new THREE.Vector3();
    for (; t < 24; t += DT) {
      const b = bankOf(obj);
      if (tRoll == null && b > 1.2) tRoll = t;
      const rollCmd = clamp((clamp(1.3 + fm.vs * 0.03, 0.6, 1.5) - b) * 3, -1, 1);
      pv.copy(fm.velocity);
      fm.step(obj, inp({ roll: rollCmd, pitch: t > 0.8 ? 1 : 0 }), DT, env);
      if (t > 4) { turned += pv.angleTo(fm.velocity); maxG = Math.max(maxG, fm.gForce); }
    }
    const rate = turned / 20 * 57.3;
    console.log(`   turn: corner ${vc.toFixed(0)} m/s, max ${maxG.toFixed(1)} g (limit ${spec.gMax}), avg ${rate.toFixed(1)}°/s over 20 s, end speed ${fm.speed.toFixed(0)}, alt ${obj.position.y.toFixed(0)}, 70° bank in ${tRoll?.toFixed(2)} s`);
    check('turn g', maxG > spec.gMax * 0.6 && maxG < spec.gMax * 1.12, `maxG ${maxG.toFixed(1)}`);
    check('turn rate', rate > 4, `rate ${rate.toFixed(1)}`);
  }

  // 4. stall: idle power, hold altitude by pulling. assist ON must not depart; OFF must stall and recover.
  for (const assist of [true, false]) {
    const { fm, obj } = mk(key, assist);
    obj.position.set(0, 2500, 0);
    fm.setAirborne(obj, spec.vStall * 1.5);
    let stalledAt = null, minV = 1e9, maxBank = 0;
    for (let t = 0; t < 40; t += DT) {
      const pull = t < 25 ? clamp(-fm.vs * 0.06, -0.2, 0.7) : 0;
      fm.step(obj, inp({ throttle: t < 25 ? 0 : 1, pitch: pull }), DT, env);
      if (fm.stalled && stalledAt == null) stalledAt = t;
      minV = Math.min(minV, fm.speed); maxBank = Math.max(maxBank, Math.abs(bankOf(obj)));
    }
    console.log(`   stall(assist=${assist}): stalled ${stalledAt == null ? 'never' : 'at ' + stalledAt.toFixed(1) + 's'}, min speed ${minV.toFixed(0)} (Vs ${spec.vStall}), max bank ${(maxBank * 57.3).toFixed(0)}°, end ${fm.speed.toFixed(0)} m/s alt ${obj.position.y.toFixed(0)}`);
    if (assist) check('no stall w/ assist', stalledAt == null, `stalled at ${stalledAt}`);
    else check('stalls w/o assist', stalledAt != null || spec.fbw || spec.gMax < 3, 'never stalled');
    check('recovers', fm.speed > spec.vStall * 1.05 && !fm.crashed, `end speed ${fm.speed.toFixed(0)}`);
  }

  // 5. landing: 3° approach held by a simple autopilot, flare, roll-out
  {
    const { fm, obj } = mk(key);
    const vApp = spec.vStall * 0.85 * 1.35;
    obj.position.set(0, 10 + 120, 0);
    fm.setAirborne(obj, vApp);
    fm.gearDown = true; fm.gearPos = 1;
    let thr = 0.4, td = null, t = 0;
    for (; t < 200; t += DT) {
      const agl = fm.altitudeAGL;
      const vsT = agl > 12 ? -vApp * 0.052 : -0.7;
      const pitch = clamp((vsT - fm.vs) * 0.08, -0.3, 0.4);
      thr = clamp(thr + (vApp * (agl > 8 ? 1 : 0.9) - fm.speed) * 0.002, 0, 1);
      fm.step(obj, inp({ throttle: fm.onGround ? 0 : thr, pitch: fm.onGround ? 0 : pitch, brake: fm.onGround }), DT, env);
      for (const e of fm.events) if (e.type === 'touchdown' && !td) td = { ...e, t };
      fm.events.length = 0;
      if (fm.crashed || (fm.onGround && fm.speed < 0.1)) break;
    }
    console.log(`   landing: touchdown sink ${td?.sink.toFixed(1)} m/s at ${td?.speed.toFixed(0)} m/s, stopped after ${(t - (td?.t ?? 0)).toFixed(0)} s, crashed=${fm.crashed}`);
    check('landing', td && !fm.crashed && fm.speed < 0.5, `td ${JSON.stringify(td)} crashed ${fm.crashed} v ${fm.speed.toFixed(1)}`);
  }
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL FLIGHT CHECKS PASSED');
process.exit(failed ? 1 : 0);
