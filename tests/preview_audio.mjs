// preview_audio.mjs — headless measurement run of the procedural sound engine.
//   node tests/preview_audio.mjs [--windows] [filter]
// Opens tests/preview_audio.html?auto=1 in headless Chrome: every scenario is rendered
// through an OfflineAudioContext and measured, then the same engine is hammered against a
// real (muted) AudioContext. Prints a pass/fail table; exit code 1 on any failure or any
// console error / warning.   --windows also prints RMS/peak per 100 ms window.
// To listen: serve the repo root (e.g. `npx vite` or `python3 -m http.server`) and open
// /tests/preview_audio.html
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const showWindows = args.includes('--windows');
const filter = args.find(a => !a.startsWith('--'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serve(root) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
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

const srv = await serve(ROOT);
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text()}`); });
page.on('requestfailed', r => consoleErrors.push('requestfailed: ' + r.url()));
let res;
try {
  await page.goto(`http://127.0.0.1:${srv.address().port}/tests/preview_audio.html?auto=1`, { waitUntil: 'load' });
  await page.waitForFunction('window.__audioResults', { timeout: 180000, polling: 250 });
  res = await page.evaluate('window.__audioResults');
} catch (e) {
  res = { rows: [{ scenario: 'driver', check: 'page ran', pass: false, detail: e.message }], windows: {} };
}
await browser.close();
srv.close();

const rows = res.rows.filter(r => !filter || r.scenario.includes(filter));
const w1 = Math.max(...rows.map(r => r.scenario.length)), w2 = Math.max(...rows.map(r => r.check.length));
let prev = '';
for (const r of rows) {
  const sc = r.scenario === prev ? '' : r.scenario; prev = r.scenario;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${sc.padEnd(w1)}  ${r.check.padEnd(w2)}  ${r.detail}`);
}
if (showWindows) {
  const line = (w) => w.map(([rms, pk]) => `${rms.toFixed(3)}/${pk.toFixed(2)}`).join(' ');
  console.log('\nRMS/peak per 100 ms window');
  for (const [name, w] of Object.entries(res.windows)) {
    if (filter && !name.includes(filter)) continue;
    if (Array.isArray(w)) console.log(`\n${name}\n  ${line(w)}`);
    else for (const [k, ww] of Object.entries(w)) console.log(`\n${name} [${k}]\n  ${line(ww)}`);
  }
}
const failed = rows.filter(r => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} checks passed; console errors/warnings: ${consoleErrors.length}`);
for (const e of [...new Set(consoleErrors)].slice(0, 20)) console.log('   ' + e);
process.exit(failed || consoleErrors.length ? 1 : 0);
