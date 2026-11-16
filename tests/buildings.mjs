// buildings.mjs — headless check that buildings are solid: fly a jet into a house (it breaks,
// the jet survives), into a tower (crash), and shoot an office (it breaks up). All three maps.
//   node tests/buildings.mjs [--dist]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useDist = args.includes('--dist');
const wanted = args.filter(a => !a.startsWith('--'));
const MAP = (args.find(a => a.startsWith('--map=')) || '--map=nordic').slice(6);
const RUNS = [
  ['free', 'ef2000', 60], ['dogfight', 'ef2000', 240], ['strike', 'a10', 200], ['intercept', 'f22', 300],
  ['waves', 'su35', 240], ['landing', 'c172', 60], ['dogfight', 'spitfire', 120], ['free', 'mi24', 40],
];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const root = useDist ? path.join(ROOT, 'dist') : ROOT;
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), '.cache/puppeteer/chrome');
  if (fs.existsSync(base)) { const p = path.join(base, fs.readdirSync(base).sort().pop(), 'chrome-linux64/chrome'); if (fs.existsSync(p)) return p; }
  for (const p of ['/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) if (fs.existsSync(p)) return p;
  throw new Error('no Chrome found; set CHROME=/path/to/chrome');
}
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'] });

let failed = 0;
const check = (name, ok, msg) => { console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + msg}`); if (!ok) failed++; };
// in-page helper: aim the player at building b from `dist` metres, at a fraction of its height
const AIM = `window.__aim = (b, dist, frac, above = 0) => {
  const g = __game;
  // approach from the direction with the lowest terrain along the path (and 150 m past the target)
  let a = 0, best = 1e9;
  for (let k = 0; k < 24; k++) {
    const t = k / 24 * 6.283; let hi = -1e9;
    for (let d = -150; d <= dist; d += 15) hi = Math.max(hi, g.env.groundHeight(b.x - Math.sin(t) * d, b.z + Math.cos(t) * d));
    if (hi < best) { best = hi; a = t; }
  }
  const x = b.x - Math.sin(a) * dist, z = b.z + Math.cos(a) * dist;
  g.placePlayer({ x, z, y: 0, heading: a });
  const ty = b.y0 + (b.top - b.y0) * frac;
  g.player.pos.y = ty + above;
  if (above) g.player.obj.rotateX(-Math.atan2(above, dist));   // dive at the aim point
  g.player.fm.setAirborne(g.player.obj, 200);
  // nothing else between us and it
  for (const o of g.env.buildings) if (o !== b && o.state !== 2) {
    const dx = o.x - x, dz = o.z - z, along = dx * Math.sin(a) - dz * Math.cos(a), lat = dx * Math.cos(a) + dz * Math.sin(a);
    if (along > 0 && along < dist + 400 && Math.abs(lat) < Math.max(o.hw, o.hd) + 25 && o.top > g.player.pos.y - 10) g.env.damageBuilding(o, 1e9);
  }
};
window.__until = (s, fn) => { const g = __game; for (let t = 0; t < s && g.state === 'playing' && !fn(); t += 1 / 60) g.update(1 / 60); };
window.__step = (s, fire) => { const g = __game; for (let t = 0; t < s && g.state === 'playing'; t += 1 / 60) { g.ui.keys.Space = !!fire; g.update(1 / 60); } g.ui.keys.Space = false; };`;
for (const map of ['nordic', 'desert', 'tropic']) {
  console.log(`\n== ${map}`);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message + ' @ ' + (e.stack || '').split('\n').slice(1, 6).join(' <- ')));
  page.on("console", m => { if (m.type() === "error" || /context/i.test(m.text())) console.log("   [console]", m.text().slice(0, 200)); });
  await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  await page.waitForFunction('window.__game && window.__shot', { timeout: 20000 });
  await page.evaluate(AIM);
  const start = `__shot.start('free','ef2000',{quality:'low', map:'${map}'})`;
  // 1. house: breaks, jet survives
  let r = await page.evaluate(`(() => { ${start}; const g = __game;
    const b = g.env.buildings.filter(b => b.style === 'res' && b.floors >= 3)[0]; __aim(b, 160, 0.6, 6); __until(1.4, () => b.state === 2);
    return { state: b.state, alive: g.player.alive, hp: Math.round(g.player.hp), title: g.result && g.result.title }; })()`);
  check('house breaks when flown through', r.state === 2, JSON.stringify(r));
  check('jet survives a house', r.alive && r.hp < 130, JSON.stringify(r));
  // 2. tower: crash
  r = await page.evaluate(`(() => { ${start}; const g = __game;
    const b = g.env.buildings.filter(b => b.style === 'glass').sort((p, q) => (q.top - q.y0) - (p.top - p.y0))[0]; __aim(b, 350, 0.4); __step(4);
    return { state: b.state, alive: g.player.alive, title: g.result && g.result.title }; })()`);
  check('tower is solid', !r.alive && r.title === 'FLEW INTO A BUILDING', JSON.stringify(r));
  // 3. guns: an office breaks up under fire
  r = await page.evaluate(`(() => { ${start}; const g = __game;
    const b = g.env.buildings.filter(b => b.style === 'office' && b.floors >= 5)[0]; __aim(b, 650, 0.5, 40); __step(2.2, true);
    return { state: b.state, hp: Math.round(b.hp), hp0: b.hp0, alive: g.player.alive }; })()`);
  check('gunfire damages an office', r.hp < r.hp0 && r.state >= 1, JSON.stringify(r));
  // 4. a new mission restores the city
  r = await page.evaluate(`(() => { ${start}; return __game.env.buildings.filter(b => b.state || b.hp !== b.hp0).length; })()`);
  check('mission restart rebuilds the city', r === 0, r + ' damaged');
  check('no page errors', !errors.length, errors.join(' | '));
  await page.close();
}
await browser.close(); srv.close();
console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nALL BUILDING CHECKS PASSED');
process.exit(failed ? 1 : 0);
