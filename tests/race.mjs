// race.mjs — headless AIR RACE check: on every map, build the course for several aircraft, script the
// player through each gate (clean, then with faults), pop a balloon, clip a pylon; fails on errors or
// wrong scoring.
//   node tests/race.mjs [--dist] [--map=nyc]
//   node tests/race.mjs --fly [--map=nyc]   a steering bot flies the course with the real flight model
//                                            (no teleports): is it flyable, and how long does it take?
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
const DIFF = (args.find(a => a.startsWith('--diff=')) || '--diff=normal').slice(7);
const MAPARG = (args.find(a => a.startsWith('--map=')) || '').slice(6);
const MAPS = MAPARG ? [MAPARG] : ['nordic', 'desert', 'tropic', 'pacific', 'nyc', 'paris', 'london', 'rio'];
const KEYS = args.includes('--hands') ? ['ef2000', 'a10', 'spitfire', 'c172'] : args.includes('--trace') || args.includes('--twice') ? ['f22'] : args.includes('--fly') ? ['ef2000', 'f22', 'a10', 'spitfire', 'c172', 'a320'] : ['ef2000', 'c172', 'a320', 'mi24', 'spitfire'];
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

// in-page driver: fly the course by placing the aircraft just short of each gate
const DRIVE = `(async (opts) => {
  const g = window.__game, p = g.player, m = g.mission, THREE = g.v3(0,0,0).constructor;
  if (!m.course) return { err: 'no course' };
  const out = { gates: m.course.length, W: Math.round(m.size.W), H: Math.round(m.size.H), targets: m.targets.length, log: [] };
  const step = (n) => { for (let i = 0; i < n && g.state === 'playing'; i++) g.update(1 / 30); };
  step(3);
  if (opts.balloon) {
    const b = m.targets.find(u => u.type === 'balloon');
    if (b) { const s0 = g.score; g.damage(b, 50, p); out.balloon = { alive: b.alive, visible: b.obj.visible, dScore: g.score - s0 }; }
    // gold balloon: a second off the clock; bullseye panel: centre hit 50, edge 5, a missile shreds it
    const gb = m.targets.find(u => u.name === 'GOLD BALLOON');
    if (gb) { const t0 = m.timer(); g.damage(gb, 50, p); out.gold = Math.round((m.timer() - t0) * 10) / 10; }
    const pn = m.targets.find(u => u.type === 'panel');
    if (pn) {
      const s0 = g.score; g.onHit(pn, 10, 0, pn.pos.clone(), false, p); const bull = g.score - s0;
      const s1 = g.score; g.onHit(pn, 10, 0, pn.pos.clone().add(g.v3(7.5, 0, 0)), false, p); const edge = g.score - s1;
      g.onHit(pn, 10, 0, pn.pos.clone(), true, p);
      out.panel = { bull, edge, shredded: !pn.alive };
    }
  }
  for (const q of m.course) {
    if (g.result) break;
    const hdg = Math.atan2(q.nx, -q.nz);
    const lat = opts.miss === q.i ? m.size.W * 0.9 : 0;
    const y = opts.high === q.i ? q.top + 15 : q.y;
    const roll = q.kind === 'knife' ? Math.PI / 2 : 0;
    const v = Math.max(m.size.V, 30);
    p.obj.position.set(q.x - q.nx * v * 0.2 + q.tx * lat, y, q.z - q.nz * v * 0.2 + q.tz * lat);
    p.obj.quaternion.setFromEuler(new (p.obj.rotation.constructor)(0, -hdg, roll));
    p.fm.setAirborne(p.obj, v);
    p.fm.velocity.set(q.nx * v, 0, q.nz * v);
    if (opts.pylon === q.i) {
      // wingtip clips the left pylon while the aircraft itself is inside the gate
      const py = q.pylons[0], off = -(m.size.W / 2 - py.rb * 0.5);
      p.obj.position.set(q.x - q.nx * v * 0.2 + q.tx * off, q.y, q.z - q.nz * v * 0.2 + q.tz * off);
      p.fm.velocity.set(q.nx * v, 0, q.nz * v);
      step(10);
      out.pylonTorn = py.torn > 0;
      continue;
    }
    step(10);
  }
  step(5);
  out.result = g.result ? g.result.title : 'none';
  out.detail = g.result ? g.result.detail : '';
  out.score = g.score; out.timer = Math.round(m.timer());
  out.ghost = !!m.ghost; out.hadBest = !!m.best;
  out.hp = Math.round(p.hp);
  return out;
})`;

const FLY = `(async () => { const process_trace = ${args.includes('--trace')};
  const g = window.__game, p = g.player, m = g.mission, V3 = g.v3(0,0,0).constructor;
  const { steerToward } = await import('/src/engine/AIPilot.js');
  const want = new V3(), inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0.8, brake: false };
  let gi = 0;
  g.autoInput = (dt) => {
    // next gate = first not done
    while (gi < m.course.length - 1 && m.course[gi].done) gi++;
    const q = m.course[gi], pos = p.pos;
    const dx = q.x - pos.x, dz = q.z - pos.z, d = Math.hypot(dx, dz);
    // aim at a point on the gate's axis a little short of it, so we arrive lined up
    const back = 0;
    const ax = q.x - q.nx * back, az = q.z - q.nz * back;
    const ay = q.y + (d > 600 ? 12 : 3);
    want.set(ax - pos.x, 0, az - pos.z).normalize();
    // altitude: hold the gate height with a gentle climb/descent, never closer than 14 m to the ground ahead
    let floor = 0;
    for (const s of [0.5, 1, 1.5, 2.5]) floor = Math.max(floor, g.env.groundHeight(pos.x + p.vel.x * s, pos.z + p.vel.z * s));
    const tY = Math.max(ay, floor + 14);
    want.y = Math.max(-0.12, Math.min(0.25, (tY - pos.y) / 120 - p.vel.y / Math.max(p.fm.speed, 1) * 0.5));
    want.normalize();
    if (pos.y < floor + 8) { want.y = 0.4; want.normalize(); }
    steerToward(p.obj, p.fm, p.spec, want, p.spec.gMax < 3 ? 0.6 : 1, 0, p.spec.gMax < 3 ? 0.15 : 0.5, inp);
    // level the wings right at a blue gate, knife-edge at a red one
    if (d < m.size.V * 0.3 && (q.x - pos.x) * q.nx + (q.z - pos.z) * q.nz > 0) {
      const r = new V3(1,0,0).applyQuaternion(p.obj.quaternion), bank = Math.asin(Math.max(-1, Math.min(1, r.y)));
      const goal = q.kind === 'knife' ? (bank >= 0 ? 1.3 : -1.3) : 0;
      inp.roll = Math.max(-1, Math.min(1, (bank - goal) * -3 / p.spec.rollRate));
    }
    inp.throttle = Math.max(0, Math.min(1, 0.55 + (m.size.V - p.fm.speed) * 0.05)); inp.brake = p.fm.speed > m.size.V * 1.1;
    if ((window.__tr = window.__tr || []).length < 4000 && Math.random() < 0.2) {
      const r = new V3(1,0,0).applyQuaternion(p.obj.quaternion);
      window.__tr.push(['g' + gi, 'd' + d.toFixed(0), 'y' + pos.y.toFixed(1), 'fl' + floor.toFixed(1), 'vy' + p.vel.y.toFixed(1), 'v' + p.fm.speed.toFixed(0), 'bank' + (Math.asin(r.y) * 57).toFixed(0), 'p' + inp.pitch.toFixed(2), 'r' + inp.roll.toFixed(2), 'wy' + want.y.toFixed(2)].join(' '));
    }
    return inp;
  };
  const says = []; const say0 = g.say.bind(g); g.say = (msg, k) => { if (msg.includes(' S') || msg.includes('GATE') || msg.includes('FINISH') || msg.length === 1) says.push(msg); say0(msg, k); };
  g.setAutopilot(true);
  for (let t = 0; t < 400 && !g.result; t += 1 / 30) g.update(1 / 30);
  if (process_trace) console.log(window.__tr.slice(-25).join('\\n'));
  return { says: says.join(' | '), result: g.result ? g.result.title : 'no finish', detail: g.result ? g.result.detail : '', hp: Math.round(p.hp), score: g.score };
})`;

let failed = 0;
const fail = (msg) => { failed++; console.log('   FAIL ' + msg); };
for (const map of MAPS) {
  for (const key of KEYS) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error' && !/VALIDATE_STATUS|Program Info Log|^\s*$/.test(m.text())) errors.push(m.text()); });
    if (args.includes('--trace')) page.on('console', m => { if (m.type() === 'log') console.log(m.text()); });
    await page.setViewport({ width: 915, height: 412, deviceScaleFactor: 1 });
    await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'load' });
    try {
      await page.waitForFunction('window.__game && window.__shot', { timeout: 30000 });
      const t0 = Date.now();
      await page.evaluate(`__shot.start('race','${key}',{quality:'low', map:'${map}', difficulty:'${DIFF}'})`);
      const built = Date.now() - t0;
      const tag = `${map.padEnd(7)} ${key.padEnd(8)}`;
      if (args.includes('--hands')) {
        // hands off the stick: how far does the gate assist alone carry you? (--raw: ASSIST OFF, no help)
        if (args.includes('--raw')) await page.evaluate(`__game.settings.set('assist', false)`);
        const r = await page.evaluate(`(() => { const g = __game; let n = 0;
          const tr = []; for (let t = 0; t < 300 && !g.result; t += 1 / 30) { g.update(1 / 30); const p = g.player; if (Math.round(t * 30) % 15 === 0) tr.push([t.toFixed(1), p.pos.y.toFixed(0), (p.pos.y - g.env.groundHeight(p.pos.x, p.pos.z)).toFixed(0), p.vel.y.toFixed(1), p.fm.speed.toFixed(0), (g.ui.input.pitch||0).toFixed(2)].join(' ')); }
          window.__htr = tr.slice(-14);
          return { tr: window.__htr, gates: g.mission.course.filter(q => q.done).length, of: g.mission.course.length, result: g.result ? g.result.title : 'running', detail: g.result ? g.result.detail.split('<br>')[0] : '' }; })()`);
        if (args.includes('--trace')) console.log(r.tr.join('\n')); console.log(`${errors.length ? 'ERR' : 'ok '} ${tag} hands-off: ${r.gates}/${r.of} gates · ${r.result} · ${r.detail}`);
        if (errors.length) { failed++; console.log('   ' + [...new Set(errors)].slice(0, 8).join('\n   ')); }
        await page.close(); continue;
      }
      if (args.includes('--fly')) {
        let r = await page.evaluate(`${FLY}()`);
        if (args.includes('--twice')) {
          console.log(`    run 1: ${r.result} · ${r.detail}`);
          await page.evaluate(`__shot.start('race','${key}',{quality:'low', map:'${map}', difficulty:'${DIFF}'})`);
          r = await page.evaluate(`${FLY}()`);
          const gh = await page.evaluate('!!__game.mission.ghost');
          console.log(`    run 2 ghost ${gh}: ${r.says}`);
        }
        console.log(`${errors.length ? 'ERR' : 'ok '} ${tag} ${r.result} · ${r.detail} · hp ${r.hp} · score ${r.score}`); if (args.includes('--says')) console.log('    ' + r.says);
        if (errors.length) { failed++; console.log('   ' + [...new Set(errors)].slice(0, 8).join('\n   ')); }
        await page.close(); continue;
      }
      const clean = await page.evaluate(`${DRIVE}({ balloon: true })`);
      if (clean.err) { fail(`${tag} ${clean.err}`); }
      else {
        console.log(`${errors.length ? 'ERR' : 'ok '} ${tag} ${clean.gates} gates W${clean.W} H${clean.H} tgts ${clean.targets} · ${clean.result} · score ${clean.score} · ${clean.detail} · start ${built} ms`);
        // the clean run is a new best: restarting the same course brings its ghost and splits back
        if (map === MAPS[0] && key === 'ef2000') {
          await page.evaluate(`__shot.start('race','${key}',{quality:'low', map:'${map}', difficulty:'${DIFF}'})`);
          const again = await page.evaluate(`${DRIVE}({})`);
          console.log(`    rerun: ${again.result} · ghost ${again.ghost} · best ${again.hadBest} · ${again.detail}`);
          if (!again.ghost || !again.hadBest) fail('no ghost / best run on the second run of a course');
        }
        if (clean.gates < (DIFF === 'hard' ? 12 : DIFF === 'easy' ? 8 : 10)) fail(`${tag} short course (${clean.gates})`);
        if (DIFF === 'normal' && !/CLEAN RUN$/.test(clean.result)) fail(`${tag} clean pass judged ${clean.result}`);
        if (clean.gold !== undefined && clean.gold !== -1) fail(`${tag} gold balloon changed the clock by ${clean.gold}`);
        if (clean.panel && !(clean.panel.bull > 0 && clean.panel.bull / clean.panel.edge > 8 && clean.panel.bull / clean.panel.edge < 12 && clean.panel.shredded)) fail(`${tag} panel ${JSON.stringify(clean.panel)}`);
        if (DIFF === 'normal' && key === 'ef2000' && (clean.gold === undefined || !clean.panel)) fail(`${tag} no gold balloon / panel on the course`);
        if (clean.balloon && (clean.balloon.alive || clean.balloon.visible || clean.balloon.dScore <= 0)) fail(`${tag} balloon ${JSON.stringify(clean.balloon)}`);
        // second run on the first map only: faults must cost time
        if (DIFF === 'normal' && map === MAPS[0] && key === 'ef2000') {
          await page.evaluate(`__shot.start('race','${key}',{quality:'low', map:'${map}', difficulty:'${DIFF}'})`);
          const bad = await page.evaluate(`${DRIVE}({ miss: 1, high: 3, pylon: 5 })`);
          console.log(`    faults: ${bad.result} · ${bad.detail} · timer ${bad.timer} · hp ${bad.hp} · torn ${bad.pylonTorn}`);
          if (!bad.pylonTorn) fail('pylon not torn');
          if (!/\+ 8 s penalties/.test(bad.detail)) fail('expected 8 s of penalties on normal (miss 5 + high 1 + pylon 2)');
          // pylon tops level across every gate; course removed from the world on the way back to the hangar
          const chk = await page.evaluate(`(() => { const g = __game, m = g.mission;
            const lvl = m.course.every(q => Math.abs((q.pylons[0].base + q.pylons[0].h) - (q.pylons[1].base + q.pylons[1].h)) < 0.01 && Math.abs(q.pylons[0].base + q.pylons[0].h - q.top) < 0.01);
            const missedDone = m.course[1].done;
            const mesh = m.course[0].pylons[0].mesh; g.ui.toMenu();
            let inScene = false; g.scene.traverse(o => { if (o === mesh) inScene = true; });
            return { lvl, missedDone, inScene, mission: g.mission }; })()`);
          if (!chk.lvl) fail('pylon tops not level with the gate top');
          if (!chk.missedDone) fail('missed gate not marked done');
          if (chk.inScene || chk.mission) fail('course left in the world after returning to the hangar');
        }
      }
    } catch (e) { errors.push('driver: ' + e.message); }
    if (errors.length) { failed++; console.log('   ' + [...new Set(errors)].slice(0, 8).join('\n   ')); }
    await page.close();
  }
}
await browser.close(); srv.close();
console.log(failed ? `${failed} problem(s)` : 'all clean');
process.exit(failed ? 1 : 0);
