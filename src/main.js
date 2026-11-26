// main.js — bootstrap: settings, audio, engine, game, ui
import { Engine } from './engine/Engine.js';
import { Game } from './engine/Game.js';
import { Settings } from './engine/Settings.js';
import { AudioEngine } from './engine/Audio.js';
import { UI } from './ui/UI.js';
import { startLoading, hideLoading } from './ui/loading.js';

/** Installable app (Home screen): only on the https site. The app keeps a copy of the game for offline
 *  play and, being the https site, keeps the motion sensor (TILT TO FLY), which a downloaded file never gets. */
function initApp() {
  if (location.protocol !== 'https:' || !('serviceWorker' in navigator)) return;
  const link = document.createElement('link');
  link.rel = 'manifest'; link.href = 'manifest.webmanifest';
  document.head.appendChild(link);
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
initApp();

/** Opened from a link inside Facebook / Instagram / Messenger: their built-in browser stays upright (so the
 *  rotate-your-phone screen never goes away), can't go full screen and has no install / tilt. Offer to open
 *  the game in the real browser: an Android intent link to Chrome, plus the menu route for iPhone. */
function initInApp() {
  const ua = navigator.userAgent || '';
  const fb = /FBAN|FBAV|FB_IAB|FBIOS/.test(ua);
  // other apps' built-in browsers: Instagram, Messenger, LinkedIn, X/Twitter, TikTok, Snapchat, LINE, WeChat
  const other = /Instagram|Messenger|LinkedInApp|Twitter|musical_ly|BytedanceWebview|TikTok|Snapchat|Line\/|MicroMessenger/.test(ua);
  if (!fb && !other) return;
  const android = /Android/i.test(ua), ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS says Macintosh
  const url = location.href.split('#')[0];
  const intent = `intent://${url.replace(/^https?:\/\//, '')}#Intent;scheme=${location.protocol.replace(':', '')};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  const help = document.getElementById('inapp-help'), menuBtn = document.getElementById('btn-inapp');
  const why = help && help.querySelector('.inapp-why');
  if (why && !fb) why.textContent = "This app's built-in browser can't turn sideways, go full screen or use tilt-to-fly.";
  const how = help && help.querySelector('.inapp-how');
  if (how && ios) how.innerHTML = 'or tap <b>•••</b> → <b>Open in external browser</b>';
  for (const a of document.querySelectorAll('.inapp-open')) {
    if (android) a.href = intent;
    else if (ios) {
      // iPhone: no Chrome needed. x-safari-https:// opens Safari straight from an in-app browser (iOS 17+);
      // the link is copied too, and if Safari did not open (older iOS) the button says to paste it there
      a.textContent = a.id === 'btn-inapp' ? 'OPEN IN SAFARI · FULL SCREEN + TILT' : 'OPEN IN SAFARI';
      a.href = 'x-safari-' + url;
      a.addEventListener('click', () => {
        if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {});
        setTimeout(() => { if (!document.hidden) a.textContent = 'LINK COPIED · PASTE IT IN SAFARI'; }, 1500);
      });
    } else {
      a.textContent = a.id === 'btn-inapp' ? 'COPY LINK · OPEN IN YOUR BROWSER' : 'COPY LINK'; a.href = '#';
      a.addEventListener('click', (e) => { e.preventDefault(); if (navigator.clipboard) navigator.clipboard.writeText(url).catch(() => {}); a.textContent = 'LINK COPIED · PASTE IN YOUR BROWSER'; });
    }
  }
  if (help) help.classList.remove('hidden');
  if (menuBtn) menuBtn.classList.remove('hidden');
}
initInApp();

async function boot() {
  startLoading();
  // let the loading screen paint before doing heavy work
  await new Promise(r => setTimeout(r, 16));

  const settings = new Settings();
  const audio = new AudioEngine();
  const engine = new Engine(document.getElementById('scene'));
  engine.start();
  const game = new Game(engine, settings, audio);
  const ui = new UI(game, settings, audio);
  game.ui = ui;

  window.__game = game; // debug handle
  // screenshot / smoke-test hooks (tests/shots.mjs)
  window.__shot = {
    start(mode, key, o = {}) {
      settings.set('tod', o.tod || 'day');
      settings.set('quality', o.quality || 'med');
      if (o.difficulty) settings.set('difficulty', o.difficulty);
      settings.set('start', o.start || 'valhall');
      settings.set('map', o.map || 'nordic');
      ui.aircraft = key; ui.mission = mode;
      ui.show('menu', false); ui.show('pause', false); ui.show('endscreen', false); ui.show('help', false);   // first-visit HOW TO FLY
      ui._menuUp = false;
      game.startMission(mode, key);
      const p = game.player;
      if (o.air && p.fm.onGround) {
        p.pos.y += o.alt || 600;
        p.fm.setAirborne(p.obj, Math.max(p.spec.vStall * 2.4, 40));
        ui.throttle = p.fm.throttle;
      }
      if (o.view) game.cam.setView(o.view);
    },
    /** Let an AI pilot fly the player and step the sim `seconds` ahead without rendering. */
    run(seconds, auto = true) {
      if (auto && !game.autopilot) game.setAutopilot(true);
      for (let t = 0; t < seconds && game.state === 'playing'; t += 1 / 30) game.update(1 / 30);
      return this.info();
    },
    boom() { const p = game.player; game.effects.explosion(p.pos.clone().add(game.v3(0, 0, -60).applyQuaternion(p.obj.quaternion)), 2); },
    info() {
      const p = game.player;
      if (!p) return game.state;
      return `pos ${p.pos.x.toFixed(0)},${p.pos.y.toFixed(0)},${p.pos.z.toFixed(0)} v ${p.fm.speed.toFixed(0)} hp ${p.hp.toFixed(0)} units ${game.units.length} ` +
        `hostile ${game.hostilesLeft} score ${game.score} state ${game.state}${game.result ? ' [' + game.result.title + ']' : ''}`;
    },
  };

  hideLoading();
  ui.showMenu();
}

boot().catch(err => {
  console.error(err);
  const msg = document.getElementById('loading-msg');
  if (!msg) return;
  // no 3D graphics (WebGL off / blocked / very old device): say what to do instead of a cryptic error
  let gl = false; try { const c = document.createElement('canvas'); gl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { /* none */ }
  if (!gl || /webgl/i.test(err.message || '')) {
    msg.innerHTML = '<b>This browser has 3D graphics turned off.</b><br>In Chrome: Settings → System → turn on <i>Use graphics acceleration</i>, ' +
      'then restart Chrome.<br>Or open the game in another browser (Chrome, Safari, Edge, Firefox).';
    const sp = document.querySelector('#loading .spinner'); if (sp) sp.style.display = 'none';
  } else msg.textContent = 'BOOT ERROR: ' + err.message;
});
