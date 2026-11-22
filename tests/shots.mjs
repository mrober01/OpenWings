// shots.mjs — headless-Chrome screenshot driver.
//   node tests/shots.mjs [--desktop] [--dist] [scenario ...]   → /tmp/ow-shots/<name>.png
// Serves the project root itself (no vite needed; index.html's importmap handles
// `three`). With --dist it serves the single-file build instead.
// Scenarios poke the game through window.__game / window.__shot (see Game.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OW_SHOTS || '/tmp/ow-shots';
const args = process.argv.slice(2);
const desktop = args.includes('--desktop');
const useDist = args.includes('--dist');
const wanted = args.filter(a => !a.startsWith('--'));

/** name → { setup: JS run in the page (may be async), wait: seconds of sim time, after?: JS } */
export const SCENARIOS = {
  menu: { menu: true, wait: 1.5 },
  runway: { setup: `__shot.start('free','ef2000',{tod:'day'})`, wait: 1.5 },
  // golden hour on the ground: Valhall lies in a mountain's shadow, so the aircraft must be shaded too
  runway_dawn: { setup: `__shot.start('free','ef2000',{tod:'dawn'})`, wait: 1.5 },
  chase: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:600})`, wait: 3 },
  cockpit: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'})`, wait: 3 },
  dawn: { setup: `__shot.start('free','ef2000',{tod:'dawn',air:true,alt:900})`, wait: 3 },
  sunset: { setup: `__shot.start('free','su35',{tod:'sunset',air:true,alt:500,view:'cockpit'})`, wait: 3 },
  night: { setup: `__shot.start('free','f22',{tod:'night',air:true,alt:500})`, wait: 3 },
  overcast: { setup: `__shot.start('free','a10',{tod:'overcast',air:true,alt:400})`, wait: 3 },
  dogfight: { setup: `__shot.start('dogfight','ef2000',{tod:'day'})`, wait: 6 },
  strike: { setup: `__shot.start('strike','a10',{tod:'day'})`, wait: 4 },
  orbit: { setup: `__shot.start('free','ef2000',{tod:'dawn',air:true,alt:1200,view:'orbit'})`, wait: 3 },
  flyby: { setup: `__shot.start('free','mig29',{tod:'day',air:true,alt:300,view:'flyby'})`, wait: 2.2 },
  heli: { setup: `__shot.start('free','mi24',{tod:'day',air:true,alt:120})`, wait: 3 },
  spitfire: { setup: `__shot.start('free','spitfire',{tod:'dawn',air:true,alt:400,view:'cockpit'})`, wait: 3 },
  airliner: { setup: `__shot.start('free','a320',{tod:'day',air:true,alt:800})`, wait: 3 },
  landing: { setup: `__shot.start('landing','ef2000',{tod:'day'})`, wait: 3 },
  // cockpit detail: glancing down at the panel (pedals, gear handle, annunciators, kneeboard, hose)
  cockpit_panel: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.lookPitch = -0.6; __game.cam.lookYaw = 0.25; __game.cam.lookIdle = -1e9`, wait: 2 },
  cockpit_spit: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.lookPitch = -0.5; __game.cam.lookIdle = -1e9`, wait: 2 },
  // climbing out of the atmosphere: stratosphere, near space (chase + cockpit)
  strato: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:14000}); __game.player.fm.setAirborne(__game.player.obj, 330)`, wait: 2 },
  space: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:32000}); __game.player.fm.setAirborne(__game.player.obj, 600)`, wait: 2 },
  space_pit: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:32000,view:'cockpit'}); __game.player.fm.setAirborne(__game.player.obj, 600); __game.cam.lookPitch = 0.25; __game.cam.lookIdle = -1e9`, wait: 2 },
  // above the Kármán line (extended-burn motors): looking at the horizon, and down at the island
  space_100: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:100000}); __game.player.fm.setAirborne(__game.player.obj, 400)`, wait: 2 },
  space_100_down: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:100000,view:'cockpit'}); __game.player.fm.setAirborne(__game.player.obj, 400);
      __game.cam.lookPitch = -0.7; __game.cam.lookYaw = 1.5; __game.cam.lookIdle = -1e9`, wait: 2 },
  space_60_pit: { setup: `__shot.start('free','su35',{tod:'sunset',air:true,alt:60000,view:'cockpit'}); __game.player.fm.setAirborne(__game.player.obj, 400)`, wait: 2 },
  // ejection: 0.8 s after the pull (seat rocket) and 5 s after (under the canopy)
  eject: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:900}); __game.eject(); __game.eject()`, wait: 0.8 },
  eject_chute: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:900}); __game.eject(); __game.eject();
      for (let t = 0; t < 5; t += 1 / 30) __game.update(1 / 30); __game.cam.lookYaw = 0.5`, wait: 0.5 },
  // burn-limiter override procedure: latches locked, LATCH held 1.8 s (guard up, switch to OVRD), looking at the left console
  ovrd_switch: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:3000,view:'cockpit'}); const g = __game; g.toggleLatch(); g.latchPress();
      for (let t = 0; t < 1.8; t += 1 / 30) g.update(1 / 30); g.latchRelease(); g.fireMissile(); for (let t = 0; t < 0.5; t += 1 / 30) g.update(1 / 30);
      g.cam.lookPitch = -0.75; g.cam.lookYaw = 0.75; g.cam.lookIdle = -1e9`, wait: 1 },
  // hung-missile booster: latches locked, two motors lit on the rails
  boost: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:900}); __game.toggleLatch(); __game.fireMissile(); __game.fireMissile()`, wait: 1.2 },
  // carrier ops: on the catapult, the boat from astern on approach, the deck at night, hook down, autopilot picker
  carrier_deck: { setup: `__shot.start('free','f22',{tod:'day',start:'carrier',view:'orbit'}); __game.cam.orbitYaw = 2.5; __game.cam.orbitPitch = 0.3`, wait: 2 },
  carrier_wide: { setup: `__shot.start('free','ef2000',{tod:'day',start:'carrier',view:'orbit'}); __game.cam.orbitYaw = 0.9; __game.cam.orbitPitch = 0.45;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.position.sub(__game.player.pos).multiplyScalar(14).add(__game.player.pos); k.lookAt(__game.env.carrier.x, 10, __game.env.carrier.z); }; }`, wait: 2 },
  carrier_final: { setup: `__shot.start('trap','f22',{tod:'day'}); __game.player.fm.gearDown = true; __game.player.fm.hookDown = true; __game.setAP('land'); for (let t = 0; t < 52; t += 1 / 30) __game.update(1 / 30)`, wait: 1 },
  carrier_pit: { setup: `__shot.start('trap','ef2000',{tod:'sunset',view:'cockpit'}); __game.setAP('land'); for (let t = 0; t < 50; t += 1 / 30) __game.update(1 / 30)`, wait: 1 },
  carrier_night: { setup: `__shot.start('trap','f22',{tod:'night'}); __game.setAP('land'); for (let t = 0; t < 45; t += 1 / 30) __game.update(1 / 30)`, wait: 1 },
  carrier_hook: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:400,view:'orbit'}); const p = __game.player; p.fm.hookDown = true; p.fm.hookPos = 1; p.fm.gearDown = true; p.fm.gearPos = 1; __game.cam.orbitYaw = 2.0; __game.cam.orbitPitch = -0.15;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.fov = 24; k.updateProjectionMatrix(); }; }`, wait: 1.5 },
  pacific: { setup: `__shot.start('free','su35',{tod:'day',map:'pacific',start:'carrier',view:'orbit'}); __game.cam.orbitYaw = 3.5; __game.cam.orbitPitch = 0.25`, wait: 2 },
  ap_panel: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:900}); __game.setAP('landmark'); __game.ui.toggleAP(true)`, wait: 1.5 },
  rcs_space: { setup: `__shot.start('free','f22',{tod:'day',air:true,alt:45000,view:'orbit'}); __game.player.fm.setAirborne(__game.player.obj, 600); __game.toggleLatch(); __game.ui.keys.KeyD = true; __game.cam.orbitYaw = 2.4; __game.cam.orbitPitch = 0.2`, wait: 1.2 },
  explosion: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:500}); __shot.boom()`, wait: 0.6 },
  // the other maps: low chase, high overview and a runway start on each
  // low pass toward each map's city (buildings close up); tod given per scenario
  ...Object.fromEntries([['nordic', 'day'], ['desert', 'day'], ['tropic', 'dawn'], ['nordic', 'night']].map(([m, t]) => [`city_${m}_${t}`, {
    setup: `__shot.start('free','ef2000',{tod:'${t}',map:'${m}'}); { const g = __game, c = g.env.hf.city, a = 0.7;
      g.placePlayer({ x: c.x + Math.sin(a) * 2300, z: c.z - Math.cos(a) * 2300, y: c.y + 260, heading: a + Math.PI }); g.player.pos.y = c.y + 260; }`, wait: 2.5 }])),
  city_street: { setup: `__shot.start('free','ef2000',{tod:'day'}); { const g = __game, c = g.env.hf.city, a = 2.2;
      g.placePlayer({ x: c.x + Math.sin(a) * 1250, z: c.z - Math.cos(a) * 1250, y: 0, heading: a + Math.PI }); g.player.pos.y = c.y + 75; }`, wait: 1.2 },
  // flying through a house: the moment after impact, from the chase camera
  smash: { setup: `__shot.start('free','a10',{tod:'day'}); { const g = __game;
      const b = g.env.buildings.filter(b => b.style === 'res' && b.floors >= 4).sort((p, q) => Math.hypot(p.x - g.env.hf.city.x, p.z - g.env.hf.city.z) - Math.hypot(q.x - g.env.hf.city.x, q.z - g.env.hf.city.z)).pop();
      const a = 0.4, x = b.x - Math.sin(a) * 120, z = b.z + Math.cos(a) * 120;
      g.placePlayer({ x, z, y: 0, heading: a }); g.player.pos.y = b.y0 + (b.top - b.y0) * 0.75; g.player.fm.setAirborne(g.player.obj, 150);
      for (let t = 0; t < 0.95; t += 1 / 60) g.update(1 / 60); g.cam.setView('orbit'); g.cam.orbitYaw = 2.6; g.cam.orbitPitch = 0.35; }`, wait: 0.6 },
  burner: { setup: `__shot.start('free','f22',{tod:'sunset',air:true,alt:600,view:'orbit'}); __game.ui.throttle = 1; for (let t = 0; t < 4; t += 1 / 30) __game.update(1 / 30); __game.cam.orbitYaw = 0.25; __game.cam.orbitPitch = 0.12;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.fov = 24; k.updateProjectionMatrix(); }; }`, wait: 2 },
  shadow_low: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:600}); { const g = __game, p = g.player;
      p.pos.set(p.pos.x + 900, 0, p.pos.z - 600); p.pos.y = g.env.groundHeight(p.pos.x, p.pos.z) + 14; p.fm.setAirborne(p.obj, 140);
      g.cam.setView('orbit'); g.cam.orbitYaw = 1.2; g.cam.orbitPitch = 0.55; }`, wait: 0.4 },
  // volumetric clouds up close: approaching one at mid height, and inside one (whiteout)
  ...Object.fromEntries([['cloud_pass', 2600, 'day', 'chase'], ['cloud_sun', 5000, 'sunset', 'chase'], ['cloud_in', 0, 'day', 'cockpit']].map(([n, d, t, v]) => [n, {
    setup: `__shot.start('free','ef2000',{tod:'${t}',air:true,alt:2000,view:'${v}'}); { const g = __game, p = g.player.pos;
      const c = g.env.clouds.cl.slice().sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      const h = ${t === 'sunset' ? 'Math.atan2(g.env.sunDir.x, -g.env.sunDir.z)' : '0.6'}, r = ${d} + c.rx;
      g.placePlayer({ x: c.x - Math.sin(h) * r * (${d} ? 1 : 0), z: c.z + Math.cos(h) * r * (${d} ? 1 : 0), y: 0, heading: h });
      g.player.pos.y = ${d} ? c.base + c.ry * 0.5 : c.y; g.player.fm.setAirborne(g.player.obj, 150); }`, wait: d ? 0.5 : 1.2 }])),
  // a cumulus close overhead at golden hour, with a seeded Math.random so before/after shots match
  cloud_near: { setup: `{ let q = 1234567; Math.random = () => (q = (q * 1664525 + 1013904223) >>> 0) / 4294967296; }
      __shot.start('free','ef2000',{tod:'dawn',air:true,alt:2000}); { const g = __game, p = g.player.pos;
      const c = g.env.clouds.cl.slice().sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
      g.placePlayer({ x: c.x, z: c.z + c.rz + 1500, y: 0, heading: 0 }); g.player.pos.y = c.base - 150; g.player.fm.setAirborne(g.player.obj, 150); }`, wait: 0.5 },
  dawn_high: { setup: `__shot.start('free','ef2000',{tod:'dawn',quality:'high',air:true,alt:900})`, wait: 3 },
  // low over the mountains: terrain surface detail
  peaks: { setup: `__shot.start('free','ef2000',{tod:'day'}); { const g = __game, hf = g.env.hf; let best = null;
      for (let x = -15000; x < 15000; x += 500) for (let z = -15000; z < 15000; z += 500) { const h = hf.height(x, z); if (!best || h > best.h) best = { x, z, h }; }
      g.placePlayer({ x: best.x - 2600, z: best.z + 1500, y: 0, heading: Math.atan2(2600, 1500) }); g.player.pos.y = best.h * 0.85; g.player.fm.setAirborne(g.player.obj, 150); }`, wait: 0.6 },
  nordic_city: { setup: `__shot.start('free','ef2000',{tod:'day',start:'air',air:true,alt:450})`, wait: 3 },
  ...Object.fromEntries(['desert', 'tropic'].flatMap(m => [
    [m + '_chase', { setup: `__shot.start('free','ef2000',{tod:'day',map:'${m}',start:'air',air:true,alt:450})`, wait: 3 }],
    [m + '_high', { setup: `__shot.start('free','ef2000',{tod:'dawn',map:'${m}',start:'air',air:true,alt:2500,view:'orbit'})`, wait: 3 }],
    [m + '_runway', { setup: `__shot.start('free','f22',{tod:'day',map:'${m}',start:'valhall'})`, wait: 1.5 }],
    [m + '_strike', { setup: `__shot.start('strike','a10',{tod:'sunset',map:'${m}'})`, wait: 4 }],
  ])),
  // close-up detail shots (narrow lens) of the airframes
  ...Object.fromEntries(['ef2000', 'f22', 'su35', 'a10', 'spitfire', 'a320', 'mi24'].map(k => ['d_' + k, {
    setup: `__shot.start('free','${k}',{tod:'day',air:true,alt:500,view:'orbit'}); __game.cam.orbitYaw = 2.3; __game.cam.orbitPitch = 0.25;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.fov = 20; k.updateProjectionMatrix(); }; }`, wait: 1.2 }])),
  // hostile markings and the underside
  d_hostile: { setup: `__shot.start('dogfight','ef2000',{tod:'day'}); { const g = __game, e = g.units.find(u => u.team === 1 && u.kind !== 'ground'); g.player = e; g.cam.setView('orbit'); g.cam.orbitYaw = 2.2; g.cam.orbitPitch = -0.35;
      const c = g.cam, u = c.update.bind(c); c.update = (dt, unit, env, t) => { u(dt, e, env, t); const k = g.engine.camera; k.fov = 22; k.updateProjectionMatrix(); }; }`, wait: 0.5 },
  // model gallery: one orbit shot per aircraft
  ...Object.fromEntries(['ef2000', 'f22', 'su35', 'mig29', 'a10', 'spitfire', 'c172', 'a320', 'mi24'].map(k =>
    ['m_' + k, { setup: `__shot.start('free','${k}',{tod:'day',air:true,alt:500,view:'orbit'}); __game.player.fm.gearDown = true; __game.player.fm.gearPos = 1`, wait: 1.5 }])),
  // control surfaces deflected (right roll + pull + rudder + airbrake), gear and flaps down: rear-quarter and front-quarter
  ...Object.fromEntries(['ef2000', 'f22', 'su35', 'a10', 'spitfire', 'c172', 'a320'].flatMap(k => [['ctl_' + k, 2.6, 0.3], ['ctlf_' + k, 0.7, 0.18]].map(([n, yaw, pit]) => [n, {
    setup: `__shot.start('free','${k}',{tod:'day',air:true,alt:500,view:'orbit'}); __game.cam.orbitYaw = ${yaw}; __game.cam.orbitPitch = ${pit};
      { const g = __game, k = g.ui.keys; k.KeyD = k.KeyS = k.KeyE = k.KeyB = true; const u = g.update.bind(g); let f = null;
        g.update = (dt) => { const p = g.player; if (!f) f = { q: p.obj.quaternion.clone(), v: p.fm.velocity.clone(), y: p.pos.y }; u(dt); p.obj.quaternion.copy(f.q); p.fm.velocity.copy(f.v); p.pos.y = f.y; p.fm.gearDown = true; };
        const c = g.cam, cu = c.update.bind(c); c.update = (...a) => { cu(...a); const k = g.engine.camera; k.fov = 26; k.updateProjectionMatrix(); }; }`, wait: 2.2 }]))),
  // landing gear close-ups on the runway (low orbit), and the landing lamp at night
  ...Object.fromEntries(['ef2000', 'f22', 'su35', 'a10', 'spitfire', 'c172', 'a320', 'mi24'].map(k => ['gear_' + k, {
    setup: `__shot.start('free','${k}',{tod:'day',view:'orbit'}); __game.cam.orbitYaw = 3.9; __game.cam.orbitPitch = 0.06;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.fov = 30; k.updateProjectionMatrix(); }; }`, wait: 3 }])),
  gear_night: { setup: `__shot.start('free','ef2000',{tod:'night',view:'orbit'}); __game.cam.orbitYaw = 3.6; __game.cam.orbitPitch = 0.12`, wait: 1.2 },
  final_night: { setup: `__shot.start('landing','a320',{tod:'night'}); __shot.run(34)`, wait: 1 },
  // hangar/tower close-up: arched shed, slide door, gallery railing (spec 3.2 acceptance)
  airfield_detail: { setup: `__shot.start('free','ef2000',{tod:'day'}); { const g = __game, a = g.env.airfields[0];
      const lx = 480, lz = 330;                                        // east of the hangar row (apron edge), looking along it (local)
      const wx = a.x + Math.cos(a.heading) * lx - Math.sin(a.heading) * lz;
      const wz = a.z + Math.sin(a.heading) * lx + Math.cos(a.heading) * lz;
      const dxl = 395 - lx, dzl = -200 - lz;                           // local direction along the row toward the far hangars
      const c = Math.cos(a.heading), s = Math.sin(a.heading);
      g.placePlayer({ x: wx, z: wz, y: 0, heading: Math.atan2(dxl * c - dzl * s, -(dxl * s + dzl * c)) });
      g.player.pos.y = a.y + 14; g.player.fm.setAirborne(g.player.obj, 40); }`, wait: 1.2 },
  // PAPI + sequenced approach lights from the approach end: 2 km back on the centreline, ~3 deg up
  papi_night: { setup: `__shot.start('free','ef2000',{tod:'night'}); { const g = __game, a = g.env.airfields[0], L = a.length / 2;
      const c = g.env.hf.city;
      const ae = Math.hypot(a.x + a.dirX * L - c.x, a.z + a.dirZ * L - c.z) > Math.hypot(a.x - a.dirX * L - c.x, a.z - a.dirZ * L - c.z) ? 1 : -1;
      g.placePlayer({ x: a.x + a.dirX * ae * (L + 2000), z: a.z + a.dirZ * ae * (L + 2000), y: 0, heading: Math.atan2(-ae * a.dirX, ae * a.dirZ) });
      g.player.pos.y = a.y + 105; g.player.fm.setAirborne(g.player.obj, 80); }`, wait: 1.5 },
  pit_look: { setup: `__shot.start('dogfight','ef2000',{tod:'day',view:'cockpit'}); __game.cam.look(-150, 20); __game.cam.lookIdle = -99`, wait: 2 },
  pit_spitfire: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:700,view:'cockpit'})`, wait: 2 },
  pit_mi24: { setup: `__shot.start('free','mi24',{tod:'day',air:true,alt:300,view:'cockpit'})`, wait: 2 },
  pit_down: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_a320: { setup: `__shot.start('free','a320',{tod:'day',air:true,alt:500,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_spit: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:500,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_c172: { setup: `__shot.start('free','c172',{tod:'day',air:true,alt:500,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_mi24: { setup: `__shot.start('free','mi24',{tod:'day',air:true,alt:300,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  // over the shoulder (seat, harness, rear bow) and steeply down (legs, stick, consoles)
  pit_back: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.look(-400, 30); __game.cam.lookIdle = -99`, wait: 2 },
  pit_floor: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.look(-60, 150); __game.cam.lookIdle = -99; __game.ui.keys.KeyD = __game.ui.keys.KeyS = true`, wait: 1 },
  pit_floor_spit: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.look(60, 150); __game.cam.lookIdle = -99`, wait: 1 },
  pit_side_a320: { setup: `__shot.start('free','a320',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.cam.look(-170, 80); __game.cam.lookIdle = -99`, wait: 1 },
  pit_night: { setup: `__shot.start('free','ef2000',{tod:'night',air:true,alt:700,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  // night lighting on the airframes (orbit close-ups)
  ...Object.fromEntries(['f22', 'a320', 'c172'].map(k => ['night_' + k, { setup: `__shot.start('free','${k}',{tod:'night',air:true,alt:500,view:'orbit'}); __game.cam.orbitYaw = 2.3; __game.cam.orbitPitch = 0.2;
      { const c = __game.cam, u = c.update.bind(c); c.update = (...a) => { u(...a); const k = __game.engine.camera; k.fov = 26; k.updateProjectionMatrix(); }; }`, wait: 1.3 }])),
  pit_a320: { setup: `__shot.start('free','a320',{tod:'dawn',air:true,alt:500,view:'cockpit'})`, wait: 2 },
  glare: { setup: `__shot.start('free','ef2000',{tod:'dawn',air:true,alt:900}); __game.player.obj.rotation.y = -1.92; __game.player.fm.setAirborne(__game.player.obj, 150); __game.ui.input.pitch = 1; __game.ui.stick.on = true; __game.ui.stick.y = 0.6`, wait: 1.2 },
  pause: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:500})`, wait: 1, after: `__game.ui.pauseGame()` },
  // real-world maps: [map, tod, target lat, lon, distance back (m), height above the target ground, approach heading (deg), view]
  ...Object.fromEntries([
    ['nyc_overview', 'nyc', 'day', 40.748, -73.985, 9000, 1500, 15], ['nyc_midtown', 'nyc', 'day', 40.7484, -73.9857, 1700, 260, 60],
    ['nyc_downtown', 'nyc', 'dawn', 40.7127, -74.0134, 2300, 220, 10], ['nyc_liberty', 'nyc', 'day', 40.6892, -74.0445, 650, 90, 300],
    ['nyc_bridges', 'nyc', 'day', 40.7060, -73.9970, 1400, 70, 330], ['nyc_gwb', 'nyc', 'sunset', 40.8517, -73.9527, 2200, 60, 20],
    ['nyc_night', 'nyc', 'night', 40.748, -73.985, 6000, 700, 20], ['nyc_central_park', 'nyc', 'day', 40.7829, -73.9654, 3500, 700, 210],
    ['paris_overview', 'paris', 'day', 48.8584, 2.2945, 7000, 1100, 100], ['paris_eiffel', 'paris', 'day', 48.8584, 2.2945, 800, 160, 130],
    ['paris_arc', 'paris', 'day', 48.8738, 2.2950, 700, 25, 292], ['paris_seine', 'paris', 'dawn', 48.8530, 2.3499, 1500, 45, 120],
    ['paris_night', 'paris', 'night', 48.8584, 2.2945, 1800, 250, 60], ['paris_defense', 'paris', 'sunset', 48.8920, 2.2380, 2500, 200, 290],
    ['paris_montmartre', 'paris', 'day', 48.8867, 2.3431, 1500, 130, 0],
    ['london_overview', 'london', 'day', 51.5007, -0.1246, 7000, 1000, 80], ['london_westminster', 'london', 'day', 51.5007, -0.1246, 900, 110, 20],
    ['london_towerbridge', 'london', 'dawn', 51.5055, -0.0754, 900, 40, 280], ['london_city', 'london', 'day', 51.5045, -0.0865, 1600, 200, 330],
    ['london_night', 'london', 'night', 51.5033, -0.1196, 1500, 200, 300],
    ['rio_overview', 'rio', 'day', -22.9519, -43.2105, 9000, 1200, 200], ['rio_christ', 'rio', 'day', -22.9519, -43.2105, 600, 30, 330],
    ['rio_sugarloaf', 'rio', 'sunset', -22.9492, -43.1546, 2200, 150, 200], ['rio_copacabana', 'rio', 'day', -22.9711, -43.1822, 2500, 250, 40],
    ['rio_bridge', 'rio', 'dawn', -22.8700, -43.1650, 2000, 60, 260], ['rio_night', 'rio', 'night', -22.9519, -43.2105, 2500, 300, 300],
  ].map(([n, m, t, lat, lon, d, alt, hdg, view]) => [n, {
    setup: `__shot.start('free','ef2000',{tod:'${t}',map:'${m}',air:true,alt:600${view ? `,view:'${view}'` : ''}}); { const g = __game, R = g.env.hf.real;
      const [tx, tz] = R.ll(${lat}, ${lon}), a = ${hdg} * Math.PI / 180;
      const o = ${d} * 0.45;                 // offset right so the target sits left of the jet
      g.placePlayer({ x: tx - Math.sin(a) * ${d} + Math.cos(a) * o, z: tz + Math.cos(a) * ${d} + Math.sin(a) * o, y: 0, heading: a });
      g.player.pos.y = Math.max(g.env.groundHeight(tx, tz), 0) + ${alt}; g.player.fm.setAirborne(g.player.obj, 140); }`, wait: 0.6 }])),
  // landmark gallery: a fixed free camera (no jet, no HUD) — [name, map, tod, eye [lat, lon, m AGL], target [lat, lon, m AGL], fov]
  ...Object.fromEntries([

  ['nyc_empire', 'nyc', 'day', [40.7395, -73.9990, 260], [40.7484, -73.9857, 200], 50],
  ['nyc_wtc', 'nyc', 'dawn', [40.6990, -74.0300, 150], [40.7127, -74.0134, 250], 50],
  ['nyc_liberty', 'nyc', 'day', [40.6870, -74.0420, 70], [40.6892, -74.0445, 50], 50],
  ['nyc_brooklyn', 'nyc', 'day', [40.7010, -73.9930, 60], [40.7060, -73.9970, 40], 60],
  ['nyc_gwb', 'nyc', 'sunset', [40.8400, -73.9600, 120], [40.8517, -73.9527, 80], 60],
  ['nyc_skyline', 'nyc', 'dawn', [40.6800, -74.0450, 300], [40.7300, -73.9900, 100], 55],
  ['paris_eiffel', 'paris', 'day', [48.8530, 2.3010, 150], [48.8584, 2.2945, 150], 55],
  ['paris_arc', 'paris', 'day', [48.8725, 2.3005, 60], [48.8738, 2.2950, 25], 55],
  ['paris_notredame', 'paris', 'day', [48.8510, 2.3540, 80], [48.8530, 2.3499, 30], 55],
  ['paris_sacrecoeur', 'paris', 'day', [48.8820, 2.3440, 120], [48.8867, 2.3431, 40], 55],
  ['paris_louvre', 'paris', 'day', [48.8570, 2.3300, 250], [48.8608, 2.3362, 0], 55],
  ['paris_defense', 'paris', 'sunset', [48.8850, 2.2550, 200], [48.8920, 2.2380, 100], 55],
  ['paris_night', 'paris', 'night', [48.8500, 2.3050, 200], [48.8584, 2.2945, 150], 55],
  ['london_westminster', 'london', 'day', [51.4990, -0.1150, 90], [51.5000, -0.1248, 50], 55],
  ['london_eye', 'london', 'day', [51.5000, -0.1150, 80], [51.5033, -0.1196, 70], 55],
  ['london_tower', 'london', 'dawn', [51.5020, -0.0700, 70], [51.5055, -0.0754, 30], 55],
  ['london_city', 'london', 'day', [51.4990, -0.0950, 250], [51.5100, -0.0850, 120], 55],
  ['london_stpauls', 'london', 'day', [51.5110, -0.0930, 120], [51.5138, -0.0984, 60], 55],
  ['london_o2', 'london', 'day', [51.4980, 0.0150, 150], [51.5030, 0.0032, 20], 55],
  ['london_battersea', 'london', 'day', [51.4780, -0.1380, 120], [51.4815, -0.1445, 50], 55],
  ['rio_christ', 'rio', 'day', [-22.9535, -43.2080, 160], [-22.9519, -43.2105, 20], 40],
  ['rio_corcovado', 'rio', 'day', [-22.9640, -43.1980, 400], [-22.9519, -43.2105, 0], 45],
  ['rio_sugarloaf', 'rio', 'day', [-22.9650, -43.1700, 250], [-22.9492, -43.1546, 150], 55],
  ['rio_bridge', 'rio', 'dawn', [-22.8850, -43.1650, 120], [-22.8700, -43.1650, 50], 60],
  ['rio_maracana', 'rio', 'day', [-22.9050, -43.2250, 250], [-22.9122, -43.2302, 0], 55],
  ['rio_night', 'rio', 'night', [-22.9600, -43.1950, 450], [-22.9519, -43.2105, 0], 40],
  ].map(([n, m, t, eye, tgt, fov]) => ['gal_' + n.replace(/^[a-z]+_/, (p) => p), {
    setup: `__shot.start('free','ef2000',{tod:'${t}',map:'${m}',air:true,alt:4000}); { const g = __game, R = g.env.hf.real;
      const [ex, ez] = R.ll(${eye[0]}, ${eye[1]}), [tx, tz] = R.ll(${tgt[0]}, ${tgt[1]});
      const ey = Math.max(g.env.groundHeight(ex, ez), 0) + ${eye[2]}, ty = Math.max(g.env.groundHeight(tx, tz), 0) + ${tgt[2]};
      g.player.obj.visible = false;
      for (const c of document.querySelectorAll('canvas')) if (c !== g.engine.renderer.domElement) c.style.visibility = 'hidden';
      const cu = g.cam.update.bind(g.cam);
      g.cam.update = (...a) => { cu(...a); const k = g.engine.camera; k.position.set(ex, ey, ez); k.lookAt(tx, ty, tz); k.fov = ${fov}; k.updateProjectionMatrix(); }; }`, wait: 0.8 }])),
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

function serve(root) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.join(root, p);
      if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (fs.existsSync(base)) {
    const v = fs.readdirSync(base).sort().pop();
    const p = path.join(base, v, 'chrome-linux64/chrome');
    if (fs.existsSync(p)) return p;
  }
  for (const p of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) if (fs.existsSync(p)) return p;
  throw new Error('no Chrome found; set CHROME=/path/to/chrome');
}

const srv = await serve(useDist ? path.join(ROOT, 'dist') : ROOT);
const url = `http://127.0.0.1:${srv.address().port}/?glcheck`;
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
// warm-up: the first WebGL context in headless Chrome sporadically reports empty-log shader
// validation errors; burn that on a throwaway page so real errors stand out
{ const w = await browser.newPage(); await w.goto(url, { waitUntil: 'load' });
  try { await w.waitForFunction('window.__shot', { timeout: 20000 }); await w.evaluate(`__shot.start('free','c172',{quality:'low'})`); await new Promise(r => setTimeout(r, 1500)); } catch {}
  await w.close(); }
let failed = 0;
const names = wanted.length ? wanted.flatMap(w => (w === 'models' ? Object.keys(SCENARIOS).filter(k => k.startsWith('m_')) : ['ctl', 'gear', 'pit'].includes(w) ? Object.keys(SCENARIOS).filter(k => k.startsWith(w)) : [w])) : Object.keys(SCENARIOS).filter(k => !/^(m_|ctl|gear_)/.test(k));
for (const name of names) {
  const sc = SCENARIOS[name];
  if (!sc) { console.log(`?? unknown scenario ${name}`); failed++; continue; }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
  if (desktop) await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  else await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
  await page.goto(url, { waitUntil: 'load' });
  try {
    await page.waitForFunction('window.__game && window.__shot', { timeout: 20000 });
    if (sc.setup) await page.evaluate(`(async () => { ${sc.setup} })()`);
    // advance in real time; the sim is frame-driven
    await new Promise(r => setTimeout(r, (sc.wait || 1) * 1000));
    if (sc.after) await page.evaluate(`(async () => { ${sc.after} })()`);
    await new Promise(r => setTimeout(r, 250));
    const info = await page.evaluate('window.__shot.info ? window.__shot.info() : ""');
    await page.screenshot({ path: path.join(OUT, `${name}${desktop ? '-desktop' : ''}.png`) });
    console.log(`ok  ${name.padEnd(10)} ${info}`);
  } catch (e) {
    errors.push('driver: ' + e.message);
    try { await page.screenshot({ path: path.join(OUT, `${name}-FAILED.png`) }); } catch {}
  }
  if (errors.length) { failed++; console.log(`ERR ${name}\n   ` + [...new Set(errors)].slice(0, 12).join('\n   ')); }
  await page.close();
}
await browser.close();
srv.close();
console.log(failed ? `${failed} scenario(s) had errors` : `all clean → ${OUT}`);
process.exit(failed ? 1 : 0);
