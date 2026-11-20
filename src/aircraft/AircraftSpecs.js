// AircraftSpecs.js — pure data (no three.js) so the flight model can be tested in node.
//
// Units: speeds m/s, rates rad/s, angles rad. Forces are expressed per unit mass:
//   twr        thrust-to-weight at full dry power (static, sea level)
//   ab         afterburner thrust multiplier (1 = none)
//   vStall     1 g clean stall speed (sea level)
//   vMax       sea-level top speed at full power (incl. afterburner)
//   kn         induced-drag factor (drag in g at CLmax); lower = better glide / sustained turn
//   alphaStall critical angle of attack
//   tailSit    taildraggers: nose-up angle at rest (rad); sitDrop = how far the origin sinks in that attitude
// The flight model derives its zero-lift drag from twr/vMax so every aircraft
// tops out where the spec says it should.

const base = {
  type: 'jet', ab: 1, gMax: 9, gNeg: 3, rollRate: 3.5, pitchRate: 1.0, kn: 0.15,
  alphaStall: 0.30, fbw: false, crashSink: 7, gearH: 1.4, bellyH: 1.0, propVp: 50,
  fuelBurn: 0.085, gunAmmo: 0, gunRate: 0.06, gunDmg: 12, missileCount: 0, flares: 0,
  armor: 100, engines: 1, playable: true, eye: [0, 1.15, -3.2], cockpit: 'fighter',
};

const defs = {
  ef2000: {
    name: 'Eurofighter Typhoon', short: 'EF2000', faction: 'military', role: 'Agile delta-canard air superiority fighter',
    vStall: 58, vMax: 430, twr: 0.82, ab: 1.5, gMax: 9, rollRate: 4.2, kn: 0.15, alphaStall: 0.42, fbw: true,
    gunAmmo: 400, gunRate: 0.045, gunDmg: 14, missileCount: 6, flares: 16, armor: 130, engines: 2,
    stats: { speed: 96, agility: 96, armor: 65, firepower: 88 }, eye: [0, 1.25, -4.3],
  },
  f22: {
    name: 'F-22 Raptor', short: 'F-22', faction: 'military', role: 'Stealth air dominance fighter',
    vStall: 60, vMax: 440, twr: 0.86, ab: 1.5, gMax: 9, rollRate: 4.0, kn: 0.15, alphaStall: 0.45, fbw: true,
    gunAmmo: 480, gunRate: 0.04, gunDmg: 12, missileCount: 8, flares: 16, armor: 130, engines: 2,
    stats: { speed: 98, agility: 92, armor: 65, firepower: 95 }, eye: [0, 1.3, -4.6],
  },
  su35: {
    name: 'Su-35 Flanker-E', short: 'SU-35', faction: 'military', role: 'Supermaneuverable heavy fighter',
    vStall: 58, vMax: 420, twr: 0.84, ab: 1.5, gMax: 9, rollRate: 3.6, kn: 0.14, alphaStall: 0.5, fbw: true,
    gunAmmo: 300, gunRate: 0.05, gunDmg: 16, missileCount: 10, flares: 20, armor: 150, engines: 2,
    stats: { speed: 92, agility: 97, armor: 75, firepower: 96 }, eye: [0, 1.5, -6.0], gearH: 1.7,
  },
  mig29: {
    name: 'MiG-29 Fulcrum', short: 'MIG-29', faction: 'military', role: 'Nimble point-defence fighter',
    vStall: 62, vMax: 410, twr: 0.8, ab: 1.5, gMax: 9, rollRate: 3.8, kn: 0.16, alphaStall: 0.42, fbw: false,
    gunAmmo: 300, gunRate: 0.05, gunDmg: 16, missileCount: 6, flares: 14, armor: 120, engines: 2,
    stats: { speed: 90, agility: 90, armor: 60, firepower: 82 }, eye: [0, 1.25, -4.6],
  },
  a10: {
    name: 'A-10 Thunderbolt II', short: 'A-10', faction: 'military', role: 'Armoured tank-buster with the 30 mm GAU-8',
    vStall: 52, vMax: 195, twr: 0.38, gMax: 7.3, rollRate: 1.9, pitchRate: 0.8, kn: 0.085, alphaStall: 0.3,
    gunAmmo: 1150, gunRate: 0.03, gunDmg: 22, missileCount: 6, flares: 24, armor: 260, engines: 2, crashSink: 8,
    stats: { speed: 45, agility: 60, armor: 100, firepower: 100 }, eye: [0, 1.3, -4.4], gearH: 1.6,
  },
  mi24: {
    name: 'Mi-24 Hind', short: 'MI-24', faction: 'military', role: 'Attack helicopter gunship — hovers',
    type: 'heli', vStall: 0, vMax: 88, twr: 1, gMax: 3, rollRate: 1.6,
    gunAmmo: 900, gunRate: 0.05, gunDmg: 12, missileCount: 8, flares: 16, armor: 200, gearH: 0, bellyH: 2.2, engines: 2,
    stats: { speed: 25, agility: 70, armor: 85, firepower: 85 }, eye: [0, 0.75, -3.4], cockpit: 'heli',
  },
  spitfire: {
    name: 'Supermarine Spitfire', short: 'SPITFIRE', faction: 'warbird', role: 'WWII legend — guns only, turns on a sixpence',
    type: 'prop', vStall: 34, vMax: 165, twr: 0.45, propVp: 62, gMax: 7.5, rollRate: 2.3, pitchRate: 1.0, kn: 0.075,
    gunAmmo: 500, gunRate: 0.05, gunDmg: 8, armor: 90, gearH: 0.85, bellyH: 0.9, tailSit: 0.2, sitDrop: 0.34, fuelBurn: 0.05,
    stats: { speed: 40, agility: 88, armor: 45, firepower: 55 }, eye: [0, 0.95, 0.2], cockpit: 'prop',
  },
  c172: {
    name: 'Cessna 172 Skyhawk', short: 'C172', faction: 'civilian', role: 'Gentle trainer — perfect for sightseeing',
    type: 'prop', vStall: 25, vMax: 64, twr: 0.34, propVp: 35, gMax: 3.8, rollRate: 1.3, pitchRate: 0.7, kn: 0.08,
    armor: 60, gearH: 1.0, bellyH: 0.7, crashSink: 5, fuelBurn: 0.03,
    stats: { speed: 15, agility: 55, armor: 30, firepower: 0 }, eye: [-0.25, 0.75, -0.6], cockpit: 'prop',
  },
  a320: {
    name: 'Airbus A320', short: 'A320', faction: 'civilian', role: 'Twin-jet airliner — heavy and stately',
    vStall: 62, vMax: 255, twr: 0.33, gMax: 2.5, gNeg: 1, rollRate: 0.5, pitchRate: 0.28, kn: 0.06, alphaStall: 0.26, fbw: true,
    armor: 220, gearH: 2.1, bellyH: 2.1, crashSink: 5.5, engines: 2, fuelBurn: 0.03,
    stats: { speed: 60, agility: 20, armor: 70, firepower: 0 }, eye: [-0.5, 1.0, -15.6], cockpit: 'airliner',
  },
  // AI-only
  bomber: {
    name: 'Tu-95 Bear', short: 'TU-95', faction: 'military', role: 'Strategic bomber', playable: false,
    type: 'prop', vStall: 62, vMax: 230, twr: 0.3, propVp: 200, gMax: 2.5, rollRate: 0.5, pitchRate: 0.3, kn: 0.06,
    armor: 260, engines: 4, gearH: 3, bellyH: 2,
  },
};

export const AIRCRAFT_SPECS = {};
for (const [key, d] of Object.entries(defs)) AIRCRAFT_SPECS[key] = { ...base, ...d, key };

export const PLAYABLE = Object.keys(AIRCRAFT_SPECS).filter(k => AIRCRAFT_SPECS[k].playable);
