// play.mjs — headless gameplay smoke test: an AI pilot flies the player through
// every mission for a few simulated minutes; fails on any page error.
//   node tests/play.mjs [--dist] [mission ...]
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
for (const [mode, key, secs] of RUNS) {
  if (wanted.length && !wanted.includes(mode)) continue;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/VALIDATE_STATUS|Program Info Log|^\s*$/.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
  try {
    await page.waitForFunction('window.__game && window.__shot', { timeout: 20000 });
    await page.evaluate(`__shot.start('${mode}','${key}',{quality:'low', map:'${MAP}', air: ${mode === 'free'}})`);
    let info = '';
    for (let t = 0; t < secs; t += 20) info = await page.evaluate(`__shot.run(20, ${mode !== 'landing'})`);
    console.log(`${errors.length ? 'ERR' : 'ok '} ${mode.padEnd(9)} ${key.padEnd(8)} ${info}`);
  } catch (e) { errors.push('driver: ' + e.message); }
  if (errors.length) { failed++; console.log('   ' + [...new Set(errors)].slice(0, 8).join('\n   ')); }
  await page.close();
}
await browser.close(); srv.close();
console.log(failed ? `${failed} run(s) had errors` : 'all clean');
process.exit(failed ? 1 : 0);
