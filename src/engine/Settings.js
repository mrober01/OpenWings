// Settings.js — persisted options + best scores (localStorage, with an in-memory fallback).
const KEY = 'openwings.v2';

export const OPTIONS = {
  map: { label: 'MAP', values: ['nordic', 'desert', 'tropic', 'pacific', 'nyc', 'paris', 'london', 'rio'], names: ['NORDIC FJORDS', 'DESERT CANYONS', 'TROPICAL ISLANDS', 'PACIFIC · CARRIER', 'NEW YORK CITY', 'PARIS', 'LONDON', 'RIO DE JANEIRO'] },
  // free-flight start: home / civil / enemy airfield of the current map, or airborne near its city
  // (the menu shows the current map's names; these are the fallbacks)
  start: { label: 'FREE FLIGHT START', values: ['valhall', 'nordvik', 'redkeep', 'air', 'carrier'], names: ['HOME BASE', 'CIVIL AIRPORT', 'ENEMY FIELD', 'AIRBORNE · OVER CITY', 'AIRCRAFT CARRIER'] },
  tod: { label: 'TIME', values: ['day', 'dawn', 'sunset', 'night', 'overcast'], names: ['CLEAR DAY', 'GOLDEN HOUR', 'SUNSET', 'MOONLIT', 'OVERCAST'] },
  difficulty: { label: 'ENEMY', values: ['easy', 'normal', 'hard'], names: ['ROOKIE', 'VETERAN', 'ACE'] },
  assist: { label: 'ASSIST', values: [true, false], names: ['ON', 'OFF (RAW)'] },
  quality: { label: 'GRAPHICS', values: ['auto', 'low', 'med', 'high'], names: ['AUTO', 'LOW', 'MEDIUM', 'HIGH'] },
  sensitivity: { label: 'STICK', values: [0.7, 1, 1.4], names: ['SOFT', 'NORMAL', 'SHARP'] },
  invertY: { label: 'PULL', values: [false, true], names: ['DOWN = NOSE UP', 'UP = NOSE UP'] },
  tilt: { label: 'TILT TO FLY', values: [false, true], names: ['OFF', 'ON'] },
  sound: { label: 'SOUND', values: [1, 0.5, 0], names: ['ON', 'QUIET', 'OFF'] },
  haptics: { label: 'VIBRATION', values: [true, false], names: ['ON', 'OFF'] },
  units: { label: 'HUD', values: ['full', 'lite'], names: ['FULL', 'DECLUTTERED'] },
};

const DEFAULTS = {
  aircraft: 'ef2000', mission: 'free', map: 'nordic', start: 'valhall',
  tod: 'day', difficulty: 'normal', assist: true, quality: 'auto',
  sensitivity: 1, invertY: false, tilt: false, sound: 1, haptics: true, units: 'full',
  best: {},
};

export class Settings {
  constructor() {
    this.data = { ...DEFAULTS, best: {} };
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) this.data[k] = raw[k];
      for (const k of Object.keys(OPTIONS)) if (!OPTIONS[k].values.includes(this.data[k])) this.data[k] = DEFAULTS[k];
      if (!this.data.best || typeof this.data.best !== 'object') this.data.best = {};
    } catch { /* private mode / corrupt: defaults */ }
    this.listeners = [];
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    if (this.data[k] === v) return;
    this.data[k] = v;
    this.save();
    for (const fn of this.listeners) fn(k, v);
  }

  /** Step an OPTIONS entry to its next value; returns the new value. */
  cycle(k) {
    const o = OPTIONS[k], i = o.values.indexOf(this.data[k]);
    this.set(k, o.values[(i + 1) % o.values.length]);
    return this.data[k];
  }

  name(k) { const o = OPTIONS[k]; return o.names[Math.max(0, o.values.indexOf(this.data[k]))]; }

  onChange(fn) { this.listeners.push(fn); }

  /** Record a score; returns true when it is a new best for that mission+difficulty. */
  submitScore(mission, score) {
    const id = `${mission}:${this.data.difficulty}`;
    const prev = this.data.best[id] || 0;
    if (score > prev) { this.data.best[id] = score; this.save(); return true; }
    return false;
  }

  best(mission) { return this.data.best[`${mission}:${this.data.difficulty}`] || 0; }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* ignore */ } }
}
