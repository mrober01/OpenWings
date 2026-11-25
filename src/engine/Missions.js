// Missions.js — mission definitions. Each `create(g)` sets the world up through the
// Game's spawn helpers and returns { objective(), update(dt), onTouchdown?(info), timer?() }.
// Missions end by calling g.finish(won, title, detail).
import { clamp } from './utils.js';
import { getMap } from '../world/Maps.js';
import { airRaceMission } from './AirRace.js';

/** Mission blurbs and callouts name the current map's places. */
const cap = (s) => s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase()).replace(/\b(Ab|Intl)\b/g, w => w.toUpperCase());
const places = (g) => { const m = g.env.hf.map; return { home: m.fields[0], civ: m.fields[1], foe: m.fields[2], city: m.city }; };

export const DIFFICULTY = {
  easy: { skill: 0.25, n: 0.67, dmg: 0.5, score: 0.7 },
  normal: { skill: 0.55, n: 1, dmg: 0.8, score: 1 },
  hard: { skill: 0.9, n: 1.34, dmg: 1.2, score: 1.5 },
};

const HOSTILE_TYPES = ['mig29', 'su35', 'mig29', 'f22'];
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function hostileKey(g) {
  // a fair fight: warbirds and other slow, missile-less types meet guns-only props
  const ps = g.player.spec;
  if (ps.type === 'prop' || (ps.missileCount === 0 && ps.vMax < 200)) return 'spitfire';
  if (ps.vMax < 220) return 'a10';        // A-10, Hind: slow jets instead of supersonic fighters
  let k = pick(HOSTILE_TYPES);
  if (k === g.player.key) k = 'mig29';
  return k;
}

function headingTo(ax, az, bx, bz) { return Math.atan2(bx - ax, -(bz - az)); }

/** Airfield-local (lateral, along) → world x/z. Lateral + is the apron side. */
function fieldXZ(a, lat, along, out) {
  out.x = a.x + a.dirX * along - a.dirZ * lat;
  out.z = a.z + a.dirZ * along + a.dirX * lat;
  return out;
}

function spawnFighters(g, n, cx, cz, alt, skill, heading) {
  for (let i = 0; i < n; i++) {
    g.spawnAir(hostileKey(g), 1, {
      x: cx + rnd(-1800, 1800), z: cz + rnd(-1800, 1800), y: alt + rnd(-300, 500), heading: heading + rnd(-0.3, 0.3),
      ai: { skill: clamp(skill + rnd(-0.1, 0.1), 0.1, 1), role: 'fighter', cruiseAlt: alt },
    });
  }
}

export const MISSIONS = {
  free: {
    title: 'FREE FLIGHT', blurb: (m) => `Explore the ${m.terrainWord} from any airfield (pick it under START). No hostiles.`, armed: false,
    create(g) {
      const fields = g.env.airfields, civ = fields[1], city = g.env.hf.city;
      const start = (g.settings && g.settings.get('start')) || 'valhall';
      const idx = { valhall: 0, nordvik: 1, redkeep: 2 }[start];
      const home = fields[idx ?? 0] || fields[0];
      const cv = g.env.carrier, onBoat = cv && (start === 'carrier' || (start === 'valhall' && g.env.map.carrierHome));
      if (onBoat) {
        g.placePlayer({ carrier: cv, cat: 0 });
        g.say(g.player.spec.type === 'heli' ? `${cv.name} · COLLECTIVE UP TO LIFT OFF` : `${cv.name} · ON CAT 1 · FULL POWER TO LAUNCH`, 'good');
      } else if (start === 'air' && city) {
        // airborne a few km out, pointed at the city
        const ang = headingTo(home.x, home.z, city.x, city.z);
        const sx = city.x - Math.sin(ang) * 5000, sz = city.z + Math.cos(ang) * 5000;
        g.placePlayer({ x: sx, z: sz, y: Math.max(1500, g.env.groundHeight(sx, sz) + 900), heading: ang });
        g.navField = civ;
      } else {
        g.placePlayer({ airfield: home });
      }
      // a little life in the sky: an airliner in the hold and a Cessna sightseeing
      const ring = (cx, cz, r, y, n) => Array.from({ length: n }, (_, i) => ({ x: cx + Math.cos(i / n * 6.283) * r, z: cz + Math.sin(i / n * 6.283) * r, y }));
      g.spawnAir('a320', 0, { x: civ.x + 6000, z: civ.z, y: 1900, heading: 0, score: 0, ai: { role: 'drone', waypoints: ring(civ.x, civ.z, 6000, 1900, 8), cruiseAlt: 1900, minAGL: 400 } });
      g.spawnAir('c172', 0, { x: home.x + 2500, z: home.z - 1500, y: home.y + 600, heading: 2, score: 0, ai: { role: 'drone', waypoints: ring(home.x, home.z, 3500, home.y + 600, 8), cruiseAlt: home.y + 600, minAGL: 200 } });
      return {
        objective: () => {
          const fm = g.player.fm;
          if (fm.cat && !fm.cat.fired) return 'ON THE CATAPULT · FULL POWER (5 / SLIDER TO THE TOP) TO LAUNCH';
          if (fm.arrest) return 'TRAPPED · THROTTLE IDLE · DECK CREW WILL RE-SPOT YOU';
          return fm.onGround ? 'THROTTLE UP · ROTATE AT 140 KT' : 'FREE FLIGHT · LAND ANYWHERE TO REFUEL · CARRIER: GEAR + HOOK (K)';
        },
        update() {},
      };
    },
  },

  dogfight: {
    title: 'DOGFIGHT', blurb: (m) => `Bandits inbound over the ${m.terrainWord}. Splash them all.`, armed: true,
    create(g) {
      const home = g.homeBase(), foe = g.env.airfields[2];
      const hdg = headingTo(home.x, home.z, foe.x, foe.z);
      g.placePlayer({ x: home.x, z: home.z, y: 2600, heading: hdg });
      const n = Math.max(1, Math.round(2 * g.diff.n));
      const dx = Math.sin(hdg), dz = -Math.cos(hdg);
      spawnFighters(g, n, home.x + dx * 10000, home.z + dz * 10000, 2800, g.diff.skill, hdg + Math.PI);
      g.say(`${n} BANDITS · 12 O'CLOCK · 10 KM`, 'warn');
      return {
        objective: () => `SPLASH THE BANDITS · ${g.hostilesLeft} LEFT`,
        update() { if (g.hostilesLeft === 0) g.finish(true, 'ALL HOSTILES DOWN'); },
      };
    },
  },

  waves: {
    title: 'WAVE ASSAULT', blurb: 'Endless waves, each tougher than the last. A wingman covers you.', armed: true,
    create(g) {
      const home = g.homeBase();
      g.placePlayer({ x: home.x, z: home.z - 2000, y: 2400, heading: 0 });
      let wave = 0, pause = 2, wing = null;
      const ps = g.player.spec;
      const wingKey = ps.type === 'prop' ? 'spitfire' : ps.vMax < 220 ? 'a10' : g.player.key === 'f22' ? 'ef2000' : 'f22';
      return {
        objective: () => (g.hostilesLeft ? `WAVE ${wave} · ${g.hostilesLeft} LEFT` : `WAVE ${wave + 1} INBOUND`),
        update(dt) {
          g.wave = wave;
          if (g.hostilesLeft > 0) return;
          pause -= dt;
          if (pause > 0) return;
          if (wave > 0) g.addScore(150 * wave, `WAVE ${wave} CLEARED`);
          wave++; pause = 6;
          const p = g.player.pos, ang = rnd(0, 6.283);
          const n = clamp(Math.round((1 + wave * 0.8) * g.diff.n), 1, 6);
          spawnFighters(g, n, p.x + Math.sin(ang) * 9000, p.z - Math.cos(ang) * 9000, Math.max(p.y, 1800), g.diff.skill + wave * 0.05, ang + Math.PI);
          if ((!wing || !wing.alive) && wave % 3 === 1) {
            wing = g.spawnAir(wingKey, 0, { x: p.x - 400, z: p.z + 500, y: p.y + 100, heading: g.playerHeading(), score: 0, ai: { skill: 0.6, role: 'fighter', cruiseAlt: 2400 } });
            wing.name = 'VIKING 2';
          }
          g.say(`WAVE ${wave} · ${n} BANDIT${n > 1 ? 'S' : ''}`, 'warn');
        },
      };
    },
  },

  strike: {
    title: 'GROUND STRIKE', blurb: (m) => `Hit the fuel, radar and vehicles at ${cap(m.fields[2])}. Expect AAA and SAMs.`, armed: true,
    create(g) {
      const home = g.env.airfields[0], foe = g.env.airfields[2];
      const back = headingTo(foe.x, foe.z, home.x, home.z);
      const sx = foe.x + Math.sin(back) * 12000, sz = foe.z - Math.cos(back) * 12000;
      g.placePlayer({ x: sx, z: sz, y: Math.max(foe.y + 1100, g.env.groundHeight(sx, sz) + 700), heading: back + Math.PI });
      const o = { x: 0, z: 0 }, hd = -foe.heading;
      const put = (type, lat, along, opts) => { fieldXZ(foe, lat, along, o); return g.spawnGround(type, 1, o.x, o.z, { heading: hd, ...opts }); };
      for (let i = 0; i < 3; i++) put('fuel', 500, -330 + i * 34);
      put('depot', 500, 180);
      put('radar', -190, 560);
      for (let i = 0; i < 4; i++) put('truck', 205 + (i % 2) * 22, -250 + i * 46, { heading: hd + 1.57 });
      put('tank', 150, 420); put('tank', 150, 470); put('truck', 150, -520);
      const nA = Math.round(2 * g.diff.n), nS = Math.round(1.4 * g.diff.n) - (g.diff.n < 1 ? 1 : 0);
      const aaa = [[-140, -820], [330, 440], [-160, 250], [560, -520]], sam = [[-380, -60], [640, 760]];
      for (let i = 0; i < Math.min(nA, aaa.length); i++) put('aaa', aaa[i][0], aaa[i][1]);
      for (let i = 0; i < Math.min(nS, sam.length); i++) put('sam', sam[i][0], sam[i][1]);
      const cap = Math.round(1.5 * g.diff.n) - 1;
      if (cap > 0) spawnFighters(g, cap, foe.x, foe.z, foe.y + 1500, g.diff.skill, back);
      g.waypoint = { pos: g.v3(foe.x, foe.y + 5, foe.z), label: 'TGT' };
      const total = g.units.filter(u => u.primary).length;
      g.say(`TARGET: ${places(g).foe} · 12 KM`, 'warn');
      return {
        objective: () => `DESTROY GROUND TARGETS · ${total - g.primaryLeft}/${total}`,
        update() { if (g.primaryLeft === 0) g.finish(true, 'TARGETS DESTROYED'); },
      };
    },
  },

  intercept: {
    title: 'INTERCEPT', blurb: (m) => `Bear bombers are running in on ${cap(m.city)}. Stop them before they reach the city.`, armed: true,
    create(g) {
      const home = g.homeBase(), city = g.env.hf.city;
      const from = headingTo(home.x, home.z, city.x, city.z);       // bombers come from beyond the city
      const dist = g.diff.n < 1 ? 31000 : 27000;
      const bx = city.x + Math.sin(from) * dist, bz = city.z - Math.cos(from) * dist, alt = 2600;
      g.placePlayer({ x: home.x, z: home.z, y: 2200, heading: from });
      const nb = Math.round(2.4 * g.diff.n), esc = Math.round(1.5 * g.diff.n) - 1;
      const back = from + Math.PI, rx = Math.cos(back), rz = Math.sin(back);
      const bombers = [];
      for (let i = 0; i < nb; i++) {
        const side = (i % 2 ? 1 : -1) * Math.ceil(i / 2);
        const b = g.spawnAir('bomber', 1, {
          x: bx + rx * side * 260 + Math.sin(from) * Math.abs(side) * 300, z: bz + rz * side * 260 - Math.cos(from) * Math.abs(side) * 300,
          y: alt + side * 30, heading: back, speed: 160, primary: true, turret: g.diff.n >= 1, score: 400,
          ai: { role: 'bomber', waypoints: [{ x: city.x + rx * side * 260, z: city.z + rz * side * 260, y: alt }], loop: false, cruiseAlt: alt, minAGL: 500, cruiseThrottle: 0.62 },
        });
        bombers.push(b);
      }
      if (esc > 0) spawnFighters(g, esc, bx - Math.sin(from) * 1500, bz + Math.cos(from) * 1500, alt + 500, g.diff.skill, back);
      g.say(`${nb} BOMBERS INBOUND TO ${places(g).city}`, 'warn');
      let eta = 0, near = 1e9;
      return {
        objective: () => `STOP THE BOMBERS · ${g.primaryLeft} LEFT · ${(near / 1000).toFixed(0)} KM FROM CITY`,
        timer: () => eta,
        update() {
          near = 1e9;
          for (const b of bombers) {
            if (!b.alive) continue;
            const d = Math.hypot(b.pos.x - city.x, b.pos.z - city.z);
            if (d < near) near = d;
            if (b.ai.arrived || d < 900) {
              g.bombCity(city);
              g.finish(false, `${places(g).city} WAS BOMBED`, 'A bomber got through.');
              return;
            }
          }
          eta = near < 1e8 ? near / 170 : 0;
          if (g.primaryLeft === 0) g.finish(true, 'BOMBERS DESTROYED', `${cap(places(g).city)} is safe.`);
        },
      };
    },
  },

  race: {
    title: 'AIR RACE', blurb: (m) => `A pylon course low over the ${m.terrainWord}. Blue gates level, red knife-edge. Shoot the targets, beat the clock.`, armed: true,
    create(g) { return airRaceMission(g); },
  },

  trap: {
    title: 'CARRIER LANDING', blurb: 'Behind the boat at 1,100 ft. Gear and hook down, fly the ball, catch the 3 wire. No flare!', armed: false,
    create(g) { return trapMission(g); },
  },

  landing: {
    title: 'LANDING CHALLENGE', blurb: 'Nine kilometres out on final. Gear down, follow the ILS, grease it.', armed: false,
    create(g) {
      const home = g.env.airfields[0];
      g.placePlayer({ final: home, dist: 9000, alt: 480 });
      g.navField = home;
      let td = null;
      return {
        objective: () => (td ? 'BRAKE TO A STOP ON THE RUNWAY' : g.player.fm.gearDown ? 'FOLLOW THE ILS BARS · FLARE AT 30 FT' : 'GEAR DOWN · REDUCE SPEED'),
        onTouchdown(info) {
          if (!td) td = info;
        },
        update() {
          const fm = g.player.fm;
          if (td && fm.onGround && fm.speed < 1.5) {
            if (!td.runway || !fm.onRunway) { g.finish(false, 'MISSED THE RUNWAY', 'Touch down on the tarmac next time.'); return; }
            const s = Math.round(clamp(1000 - clamp(td.sink - 0.8, 0, 8) * 110 - Math.abs(td.lat) * 14 - Math.abs(td.along - 350) * 0.45, 50, 1000));
            g.addScore(s);
            const grade = s > 880 ? 'PERFECT' : s > 700 ? 'GOOD' : s > 450 ? 'FAIR' : 'ROUGH';
            g.finish(true, `${grade} LANDING`,
              `Sink rate ${Math.round(td.sink * 197)} ft/min · ${Math.abs(td.lat).toFixed(1)} m off centreline · ${Math.round(td.along)} m past the threshold`);
          } else if (td && !fm.onGround && g.time - td.time > 4) td = null; // bounced / went around
        },
      };
    },
  },
};

/** Carrier landing: start on the approach behind the boat. Shared by the 'trap' mission. */
function trapMission(g) {
  const cv = g.env.carrier, L = cv.landing, dist = 5600;
  g.placePlayer({ final: L, dist: dist - L.aim, alt: dist * Math.tan(L.glide) + 6 });
  g.navField = L;
  let wire = null, bolters = 0, td = null;
  return {
    objective: () => {
      const fm = g.player.fm;
      if (wire) return 'TRAPPED · THROTTLE IDLE';
      if (!fm.gearDown) return 'GEAR DOWN (G) · HOOK DOWN (K) · SLOW TO APPROACH SPEED';
      if (!fm.hookDown) return 'HOOK DOWN (K / HOOK BUTTON)';
      return `FLY THE BALL: HOLD THE ILS BARS · NO FLARE · AIM BETWEEN WIRES 2 AND 3${bolters ? ` · BOLTERS ${bolters}` : ''}`;
    },
    onTouchdown(info) { td = info; },
    onTrap(info) { wire = info; },
    onBolter() { bolters++; },
    onArrested() {
      if (!wire) return;
      const sink = td ? td.sink : 4;
      const base = { 1: 450, 2: 780, 3: 1000, 4: 620 }[wire.wire] || 400;
      const s = Math.round(clamp(base - Math.abs(wire.lat) * 25 - Math.max(0, sink - 5) * 80 - bolters * 150, 50, 1000));
      g.addScore(s);
      const grade = s > 880 ? 'OK PASS' : s > 650 ? 'FAIR PASS' : 'NO-GRADE PASS';
      g.finish(true, `${wire.wire} WIRE · ${grade}`,
        `Sink ${Math.round(sink * 197)} ft/min · ${Math.abs(wire.lat).toFixed(1)} m off the centreline · ${Math.round(wire.speed * 1.944)} kt at the wire${bolters ? ` · ${bolters} bolter${bolters > 1 ? 's' : ''}` : ''}`);
    },
    update() {},
  };
}

/** Best-score slot: the air race keeps one per map and aircraft (each has its own course). */
export function bestKey(mission, map, aircraft) {
  return mission === 'race' ? `race/${map}/${aircraft}` : mission;
}

/** Mission blurb for the menu, filled in for a map key. */
export function missionBlurb(key, mapKey) {
  const b = MISSIONS[key].blurb;
  return typeof b === 'function' ? b(getMap(mapKey)) : b;
}

export const MISSION_ORDER = ['free', 'race', 'dogfight', 'strike', 'intercept', 'waves', 'landing', 'trap'];
