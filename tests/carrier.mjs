// carrier.mjs — headless checks for carrier ops and the player autopilot: catapult shot, autopilot
// carrier traps and runway landings, take-off, the space run, landmark tour, attack, wingtip RCS.
//   node tests/carrier.mjs [name ...]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wanted = process.argv.slice(2).filter(a => !a.startsWith('--') && !/^[A-Z_]+=/.test(a));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
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

// page-side helper: step the sim, log autopilot status changes and toasts
const HELPER = `
window.__t = { log: [], step(sec, until) {
  const g = __game; let last = '';
  for (let t = 0; t < sec && g.state === 'playing'; t += 1 / 30) {
    g.update(1 / 30);
    const st = (g.ap ? g.ap.status.replace(/[0-9.,]+ ?(KM|KT|FT)/g, '#') : 'AP OFF');
    if (st !== last) { last = st; this.log.push(t.toFixed(0) + 's ' + st); }
    if (until && until(g)) break;
  }
  const p = g.player;
  return { y: Math.round(p.pos.y), v: Math.round(p.fm.speed), ground: p.fm.onGround, alive: p.alive, ap: g.ap && g.ap.mode, result: g.result && g.result.title, state: g.state };
} };
{ const ui = __game.ui, t0 = ui.toast.bind(ui); ui.toast = (m, k) => { __t.log.push('  » ' + m); t0(m, k); }; }`;

const CASES = {
  catshot: [`__shot.start('free','ef2000',{quality:'low',start:'carrier'}); __game.ui.throttle = 1; __t.step(8)`,
    r => !r.ground && r.alive && r.v > 60 && r.y > 12],
  ap_takeoff_cat: [`__shot.start('free','f22',{quality:'low',start:'carrier'}); __game.setAP('takeoff'); __t.step(80, g => !g.ap || g.ap.mode === 'hold')`,
    r => r.alive && r.ap === 'hold' && r.y > 400],
  ap_takeoff_rwy: [`__shot.start('free','a10',{quality:'low'}); __game.setAP('takeoff'); __t.step(90, g => !g.ap || g.ap.mode === 'hold')`,
    r => r.alive && r.ap === 'hold' && r.y > 400],
  ...Object.fromEntries(['f22', 'ef2000', 'su35', 'a10', 'spitfire', 'mig29'].map(k => ['trap_' + k, [
    `__shot.start('trap','${k}',{quality:'low'}); __game.setAP('land'); __t.step(200, g => !!g.result)`, r => r.alive && /WIRE/.test(r.result || '')]])),
  trap_mi24: [`__shot.start('trap','mi24',{quality:'low'}); __game.setAP('land'); __t.step(240, g => !g.ap)`, r => r.alive && r.ground],
  ap_land_rwy: [`__shot.start('free','ef2000',{quality:'low',start:'air'}); __game.navField = __game.env.airfields[0]; __game.setAP('land'); __t.step(400, g => !g.ap)`,
    r => r.alive && r.ground && r.v < 2],
  ap_land_rwy_c172: [`__shot.start('free','c172',{quality:'low',start:'air'}); __game.navField = __game.env.airfields[1]; __game.setAP('land'); __t.step(800, g => !g.ap)`,
    r => r.alive && r.ground && r.v < 2],
  ap_land_pacific: [`__shot.start('free','su35',{quality:'low',map:'pacific',air:true,alt:1500}); __game.setAP('land'); __t.step(400, g => !g.ap)`,
    r => r.alive && r.ground],
  ap_space: [`__shot.start('free','f22',{quality:'low'}); __game.setAP('space'); __t.step(600, g => !g.ap || g.ap.mode === 'hold'); __t.step(0)`,
    r => r.alive && r.ap === 'hold'],
  ap_landmark: [`__shot.start('free','ef2000',{quality:'low',map:'paris',start:'air'}); __game.setAP('landmark'); __t.step(150)`, r => r.alive && r.ap === 'landmark'],
  ap_target_air: [`__shot.start('dogfight','ef2000',{quality:'low'}); __game.setAP('target'); __t.step(240, g => g.hostilesLeft === 0)`, r => r.alive || r.result === 'SHOT DOWN'],   // may lose a 2-v-1, must not fly into the ground
  ap_target_gnd: [`__shot.start('strike','a10',{quality:'low',difficulty:'easy'}); __game.setAP('target'); __t.step(240)`, r => r.alive],
  rcs: [`__shot.start('free','f22',{quality:'low',air:true,alt:40000}); __game.player.fm.setAirborne(__game.player.obj, 500); __game.toggleLatch();
    const q0 = __game.player.obj.quaternion.clone(); __game.ui.keys.KeyS = true; __t.step(2); __game.ui.keys.KeyS = false;
    __t.log.push('rotated ' + (q0.angleTo(__game.player.obj.quaternion) * 57.3).toFixed(0) + ' deg, rcs ' + __game.player.rcs.toFixed(2)); __t.step(0.1)`, r => r.alive],
};

// ad-hoc probe: --js=file.js [NAME=value ...] runs a script in the page and prints its result
const jsArg = process.argv.find(a => a.startsWith('--js='));
if (jsArg) {
  let src = fs.readFileSync(jsArg.slice(5), 'utf8');
  for (const a of process.argv.slice(2).filter(a => /^[A-Z_]+=/.test(a))) { const [k, v] = a.split('='); src = src.replaceAll(k, JSON.stringify(v)); }
  for (const k of Object.keys(CASES)) delete CASES[k];
  CASES.probe = [src, () => true];
}

const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--mute-audio'] });
let failed = 0;
for (const [name, [js, ok]] of Object.entries(CASES)) {
  if (wanted.length && !wanted.some(w => name.startsWith(w))) continue;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/VALIDATE_STATUS|Program Info Log|^\s*$/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  let r = null, log = [];
  try {
    await page.waitForFunction('window.__game && window.__shot', { timeout: 20000 });
    await page.evaluate(HELPER);
    r = await page.evaluate(js);
    log = await page.evaluate('__t.log');
  } catch (e) { errors.push('driver: ' + e.message); }
  const pass = !errors.length && r && ok(r);
  if (!pass) failed++;
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${typeof r === 'string' ? '\n' + r : JSON.stringify(r)}`);
  if (!pass || process.argv.includes('--v')) console.log('     ' + [...errors, ...log.slice(-40)].join('\n     '));
  await page.close();
}
await browser.close(); srv.close();
console.log(failed ? `${failed} case(s) failed` : 'all clean');
process.exit(failed ? 1 : 0);
