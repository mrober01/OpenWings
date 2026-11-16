// Maps.js — the selectable worlds. Each map is pure data plus a terrain shape
// function (hf, x, z) → raw height in metres, run on the same 40 km grid by
// world/Heightfield.js. Sites (3 airfields + a city) are found automatically, so a
// shape only has to offer some flat lowland between 5 and 150 m.
// Pure JS (no three.js / DOM): the node tests and render_map.mjs use it too.

export const SEA_FLOOR = -60;
const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** Domain warp shared by the shapes: bends coastlines and ridges so nothing looks gridded. */
function warp(hf, x, z, amt) {
  const n = hf.noise;
  return [x + n.noise2D(x * 0.00007 + 11, z * 0.00007 - 7) * amt, z + n.noise2D(x * 0.00007 - 31, z * 0.00007 + 19) * amt];
}

/* ---------------- Nordic: mountains, fjords, coastal plains (the original island) ---------------- */
function nordic(hf, x, z) {
  const n = hf.noise;
  const [wx, wz] = warp(hf, x, z, 2200);
  const d = Math.hypot(wx, wz * 1.08) / hf.half;
  const coastN = hf.fbm(wx / 7500 + 3, wz / 7500 - 5, 3);
  const mask = smoothstep(0.9, 0.42, d + coastN * 0.24);
  const hills = hf.fbm(x / 2600, z / 2600, 4);
  const region = smoothstep(-0.3, 0.4, n.noise2D(wx / 10500 + 5, wz / 10500 + 3));
  const ridge = hf.ridged(wx / 5600, wz / 5600, 5);
  let h = -75 + mask * (105 + hills * 40 * (0.35 + region))
    + mask * mask * region * Math.pow(ridge, 1.7) * 1900;
  // fjords & glacial valleys: thin winding channels cut down to sea level
  const f = Math.abs(n.noise2D(wx / 9000 + 70, wz / 9000 - 40) + 0.35 * n.noise2D(wx / 3100 - 9, wz / 3100 + 4));
  const ch = smoothstep(0.2, 0.02, f);
  if (h > -30) h = mix(h, -30 + (h + 30) * 0.03, ch);
  h += n.noise2D(x / 420, z / 420) * (4 + Math.max(h, 0) * 0.035);
  return Math.max(h, SEA_FLOOR);
}

/* ---------------- Desert: sand plains, dunes, terraced mesas, dry canyons, a sea coast ---------------- */
function desert(hf, x, z) {
  const n = hf.noise;
  const [wx, wz] = warp(hf, x, z, 2600);
  // mostly land; the sea only creeps in along the western and southern edges
  const d = Math.max(Math.abs(wx + 2500) / hf.half, Math.abs(wz - 2500) / hf.half);
  const coastN = hf.fbm(wx / 6000 - 8, wz / 6000 + 2, 3);
  const mask = smoothstep(1.02, 0.8, d + coastN * 0.18);
  // gently rolling plain, rising inland
  let h = 22 + hf.fbm(x / 3400, z / 3400, 4) * 16 + smoothstep(-0.2, 1, (wz * -0.6 + wx * 0.5) / hf.half) * 40;
  // dune fields: long crescent ridges in some regions
  const duneR = smoothstep(0.05, 0.45, n.noise2D(wx / 9000 - 13, wz / 9000 + 27));
  const du = 1 - Math.abs(n.noise2D(x / 650 + n.noise2D(x / 3000, z / 3000) * 1.6, z / 1500));
  h += duneR * du * du * du * 22;
  // mesas: flat-topped, stepped plateaus with steep cliffs
  const r = n.noise2D(wx / 7600 + 5, wz / 7600 - 2) + 0.3 * hf.fbm(wx / 2100, wz / 2100, 3);
  const plateau = smoothstep(0.2, 0.27, r);
  if (plateau > 0) {
    const t = (120 + smoothstep(0.27, 0.75, r) * 520) / 85;
    const ti = Math.floor(t);
    const mesa = (ti + smoothstep(0.7, 1, t - ti)) * 85;
    h += plateau * mesa;
  }
  // canyons: winding dry riverbeds cut through everything, floor stays dry (~12 m)
  const f = Math.abs(n.noise2D(wx / 8200 + 70, wz / 8200 - 40) + 0.3 * n.noise2D(wx / 2400 - 9, wz / 2400 + 4));
  const ch = smoothstep(0.1, 0.025, f);
  h = mix(h, Math.min(h, 12 + (h - 12) * 0.05), ch);
  h += n.noise2D(x / 380, z / 380) * (2 + Math.max(h, 0) * 0.02);
  h = -70 + mask * (h + 70);
  return Math.max(h, SEA_FLOOR);
}

/* ---------------- Tropical: archipelago, lagoons, jungle hills and a volcano ---------------- */
function tropic(hf, x, z) {
  const n = hf.noise;
  const [wx, wz] = warp(hf, x, z, 1800);
  const d = Math.hypot(wx, wz) / hf.half;
  const isl = hf.fbm(wx / 6200 + 3, wz / 6200 - 5, 4) + 0.25 * n.noise2D(wx / 15000 - 4, wz / 15000 + 9);
  const m = isl + smoothstep(0.98, 0.3, d) * 0.55 - 0.4;            // > 0 is land
  let h;
  if (m <= 0) {
    // shallow reef shelf around every island, then the deep ocean
    h = mix(SEA_FLOOR, -3, smoothstep(-0.22, 0, m));
  } else {
    const k = smoothstep(0, 0.35, m);
    const hills = hf.fbm(x / 1900, z / 1900, 4);
    const peaks = Math.pow(Math.max(0, hf.fbm(wx / 3600 - 21, wz / 3600 + 13, 4) + 0.15), 1.5);
    h = mix(-3, 6, smoothstep(0, 0.05, m)) + k * (16 + hills * 18) + k * k * peaks * 950;
  }
  // the volcano: a broad cone with a crater, on its own island
  const vx = x - hf.map.volcano[0], vz = z - hf.map.volcano[1];
  const rv = Math.hypot(vx + n.noise2D(x / 900, z / 900) * 260, vz + n.noise2D(x / 900 + 7, z / 900 - 3) * 260);
  const cone = 1400 * Math.exp(-Math.pow(rv / 2100, 1.3)) - 320 * smoothstep(520, 110, rv);
  h = Math.max(h, cone - 50 + Math.abs(n.noise2D(x / 300, z / 300)) * 25 * smoothstep(2600, 500, rv));
  h += n.noise2D(x / 400, z / 400) * (1.5 + Math.max(h, 0) * 0.03);
  return Math.max(h, SEA_FLOOR);
}

/*
 * Shader palette entries are linear RGB (as the terrain shader uses them).
 * upland: [lo, hi] height band where grass turns into the upland colour.
 * snow: [lo, hi] snow-line band (huge = no snow). rockSlope: slope band that turns rock.
 * strata: 0..1 banded cliff colouring (desert mesas). patch: [r, g, b, amount] large irregular
 * patches (desert gravel, darker jungle) that break up the ground colour. forest: tree band + density bias.
 * houses: wall colours for low-rise housing. mini: 0-255 sRGB colours for the HUD moving map.
 */
export const MAPS = {
  nordic: {
    name: 'NORDIC FJORDS', seed: 0.1337, shape: nordic,
    fields: ['VALHALL AB', 'NORDVIK INTL', 'RED KEEP'], city: 'NORDVIK', terrainWord: 'fjords',
    palette: {
      grassA: [0.16, 0.26, 0.08], grassB: [0.32, 0.36, 0.13], upland: [0.34, 0.30, 0.19], uplandH: [230, 620],
      forest: [0.045, 0.10, 0.04], sand: [0.62, 0.56, 0.40], beachH: 6,
      rockA: [0.27, 0.25, 0.23], rockB: [0.46, 0.44, 0.41], rockSlope: [0.13, 0.3], strata: 0,
      snow: [0.93, 0.95, 1.0], snowH: [680, 900],
      shallow: [0.10, 0.36, 0.34], deep: [0.012, 0.06, 0.12],
    },
    forest: { hMin: 6, hMax: 420, bias: 0 },
    trees: { shape: 'cone', hue: [0.3, 0.06], sat: 0.45, light: [0.1, 0.07], size: [14, 14], width: 0.32 },
    houses: [0xb5523b, 0xd9b25a, 0xe8e4da, 0x8aa0a8, 0xc9c2b0, 0x9c3d30], clouds: 1,
    mini: { sand: [120, 114, 90], low: [62, 92, 50], up: [86, 84, 78], high: [170, 170, 170], upH: 420, highH: 900 },
  },
  desert: {
    name: 'DESERT CANYONS', seed: 0.7213, shape: desert,
    fields: ['MIRAGE AB', 'SOLANA INTL', 'SCORPION FIELD'], city: 'SOLANA', terrainWord: 'canyons',
    palette: {
      grassA: [0.38, 0.23, 0.11], grassB: [0.53, 0.35, 0.17], upland: [0.40, 0.19, 0.09], uplandH: [110, 330],
      forest: [0.16, 0.17, 0.07], sand: [0.62, 0.50, 0.31], beachH: 5,
      rockA: [0.30, 0.12, 0.05], rockB: [0.56, 0.30, 0.15], rockSlope: [0.09, 0.22], strata: 1,
      patch: [0.25, 0.15, 0.07, 0.45],
      snow: [0.93, 0.95, 1.0], snowH: [1e5, 1e5 + 1],
      shallow: [0.08, 0.42, 0.44], deep: [0.012, 0.08, 0.14],
    },
    forest: { hMin: 8, hMax: 200, bias: 0.42 },
    trees: { shape: 'blob', hue: [0.16, 0.06], sat: 0.3, light: [0.42, 0.1], size: [6, 6], width: 1.2 },
    houses: [0xd8c09a, 0xcfae82, 0xe6d6b8, 0xc99b6d, 0xe0cfb0], clouds: 0.35,
    mini: { sand: [190, 160, 112], low: [168, 120, 70], up: [146, 76, 42], high: [178, 104, 64], upH: 150, highH: 450 },
  },
  tropic: {
    name: 'TROPICAL ISLANDS', seed: 0.4242, shape: tropic, volcano: [7200, -8600],
    fields: ['CORAL AB', 'PALM BAY INTL', 'SKULL ISLE'], city: 'PALM BAY', terrainWord: 'islands',
    palette: {
      grassA: [0.08, 0.25, 0.04], grassB: [0.20, 0.36, 0.07], upland: [0.15, 0.20, 0.08], uplandH: [380, 800],
      patch: [0.05, 0.15, 0.03, 0.35],
      forest: [0.02, 0.12, 0.03], sand: [0.86, 0.80, 0.60], beachH: 8,
      rockA: [0.10, 0.09, 0.09], rockB: [0.24, 0.21, 0.19], rockSlope: [0.16, 0.34], strata: 0,
      snow: [0.30, 0.27, 0.25], snowH: [950, 1150],        // bare ash cone instead of snow
      shallow: [0.04, 0.58, 0.56], deep: [0.008, 0.10, 0.24],
    },
    forest: { hMin: 9, hMax: 760, bias: -0.22 },
    trees: { shape: 'blob', hue: [0.25, 0.08], sat: 0.55, light: [0.26, 0.1], size: [10, 10], width: 0.75 },
    houses: [0xf4f1ea, 0xf2d6a2, 0xa8d8d0, 0xf0b8a0, 0xe8e8f0, 0xb8d890], clouds: 1.25,
    mini: { sand: [214, 200, 150], low: [46, 104, 38], up: [70, 80, 44], high: [70, 64, 60], upH: 500, highH: 950 },
  },
};

export const MAP_ORDER = ['nordic', 'desert', 'tropic'];
export const getMap = (key) => MAPS[key] || MAPS.nordic;
