// main.js — bootstrap: settings, audio, engine, game, ui
import { Engine } from './engine/Engine.js';
import { Game } from './engine/Game.js';
import { Settings } from './engine/Settings.js';
import { AudioEngine } from './engine/Audio.js';
import { UI } from './ui/UI.js';
import { startLoading, hideLoading } from './ui/loading.js';

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
      ui.show('menu', false); ui.show('pause', false); ui.show('endscreen', false);
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
  if (msg) msg.textContent = 'BOOT ERROR: ' + err.message;
});
