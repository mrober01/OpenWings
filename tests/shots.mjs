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
  // model gallery: one orbit shot per aircraft
  ...Object.fromEntries(['ef2000', 'f22', 'su35', 'mig29', 'a10', 'spitfire', 'c172', 'a320', 'mi24'].map(k =>
    ['m_' + k, { setup: `__shot.start('free','${k}',{tod:'day',air:true,alt:500,view:'orbit'}); __game.player.fm.gearDown = true; __game.player.fm.gearPos = 1`, wait: 1.5 }])),
  pit_look: { setup: `__shot.start('dogfight','ef2000',{tod:'day',view:'cockpit'}); __game.cam.look(-150, 20); __game.cam.lookIdle = -99`, wait: 2 },
  pit_spitfire: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:700,view:'cockpit'})`, wait: 2 },
  pit_mi24: { setup: `__shot.start('free','mi24',{tod:'day',air:true,alt:300,view:'cockpit'})`, wait: 2 },
  pit_down: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:700,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_a320: { setup: `__shot.start('free','a320',{tod:'day',air:true,alt:500,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_down_spit: { setup: `__shot.start('free','spitfire',{tod:'day',air:true,alt:500,view:'cockpit'}); __game.ui.keys.KeyC = true`, wait: 2 },
  pit_a320: { setup: `__shot.start('free','a320',{tod:'dawn',air:true,alt:500,view:'cockpit'})`, wait: 2 },
  glare: { setup: `__shot.start('free','ef2000',{tod:'dawn',air:true,alt:900}); __game.player.obj.rotation.y = -1.92; __game.player.fm.setAirborne(__game.player.obj, 150); __game.ui.input.pitch = 1; __game.ui.stick.on = true; __game.ui.stick.y = 0.6`, wait: 1.2 },
  pause: { setup: `__shot.start('free','ef2000',{tod:'day',air:true,alt:500})`, wait: 1, after: `__game.ui.pauseGame()` },
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
const url = `http://127.0.0.1:${srv.address().port}/`;
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
const names = wanted.length ? wanted.flatMap(w => (w === 'models' ? Object.keys(SCENARIOS).filter(k => k.startsWith('m_')) : [w])) : Object.keys(SCENARIOS).filter(k => !k.startsWith('m_'));
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
