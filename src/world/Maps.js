// Maps.js — the selectable worlds. Each map is pure data plus a terrain shape
// function (hf, x, z) → raw height in metres, run on the same 40 km grid by
// world/Heightfield.js. Sites (3 airfields + a city) are found automatically, so a
// shape only has to offer some flat lowland between 5 and 150 m.
// Pure JS (no three.js / DOM): the node tests and render_map.mjs use it too.
//
// Real-world maps (NYC, Paris) carry `real`: a land/water/park grid baked from OpenStreetMap by
// tools/realmap.mjs, plus fixed `sites` (real airports + city centre), `urban` (district zones that
// drive the street grid and the buildings) and `landmarks` (world/Landmarks.js). Their positions are
// written as [lat, lon] and turned into metres with ll().
import NYC from './real/nyc.data.js';
import PARIS from './real/paris.data.js';
import LONDON from './real/london.data.js';
import RIO from './real/rio.data.js';

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

/* ---------------- real-world maps ---------------- */
const realCache = new WeakMap();
/** Decoded class grid of a real map + distance (m) from every vertex to the nearest vertex of the
 *  other kind (land vs water), so coasts and river banks can be shaped smoothly. Cached per data. */
export function realGrid(data) {
  let R = realCache.get(data);
  if (R) return R;
  const n = data.n, cls = new Uint8Array(n * n), raw = atob(data.rle);
  let p = 0;
  for (let k = 0; k < raw.length; k++) { const b = raw.charCodeAt(k); cls.fill(b & 3, p, p + (b >> 2)); p += b >> 2; }
  const cell = 40000 / (n - 1);
  // two-pass chamfer distance (in cells) to the nearest vertex of the other kind
  const dist = (isSrc) => {
    const d = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) d[k] = isSrc(cls[k]) ? 0 : 1e6;
    const D = Math.SQRT2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i; let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) { v = Math.min(v, d[k - n] + 1); if (i > 0) v = Math.min(v, d[k - n - 1] + D); if (i < n - 1) v = Math.min(v, d[k - n + 1] + D); }
      d[k] = v;
    }
    for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
      const k = j * n + i; let v = d[k];
      if (i < n - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < n - 1) { v = Math.min(v, d[k + n] + 1); if (i < n - 1) v = Math.min(v, d[k + n + 1] + D); if (i > 0) v = Math.min(v, d[k + n - 1] + D); }
      d[k] = v;
    }
    for (let k = 0; k < n * n; k++) d[k] = d[k] * cell;
    return d;
  };
  const toWater = dist(c => c === 0), toLand = dist(c => c !== 0);
  const KX = 111320 * Math.cos(data.lat0 * Math.PI / 180), KZ = 110574;
  // optional real terrain (SRTM, 5 m steps) on a coarse grid
  let elev = null;
  if (data.elev) { const r = atob(data.elev); elev = new Float32Array(r.length); for (let k = 0; k < r.length; k++) elev[k] = r.charCodeAt(k) * 5; }
  R = {
    n, cls, cell, toWater, toLand,
    ll: (lat, lon) => [(lon - data.lon0) * KX, -(lat - data.lat0) * KZ],
    /** Real ground height (m, bilinear) where the map carries elevation, else 0. */
    elevAt(x, z) {
      if (!elev) return 0;
      const m = data.elevN, gx = Math.min(m - 1.001, Math.max(0, (x + 20000) / 40000 * (m - 1))), gz = Math.min(m - 1.001, Math.max(0, (z + 20000) / 40000 * (m - 1)));
      // Catmull-Rom: smooth slopes instead of the bilinear facets of a 400 m grid
      const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
      const at = (a, b) => elev[Math.min(m - 1, Math.max(0, b)) * m + Math.min(m - 1, Math.max(0, a))];
      const cr = (p0, p1, p2, p3, t) => p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
      const row = (b) => cr(at(i - 1, b), at(i, b), at(i + 1, b), at(i + 2, b), fx);
      return Math.max(0, cr(row(j - 1), row(j), row(j + 1), row(j + 2), fz));
    },
    /** class at the nearest vertex: 0 water · 1 land · 2 park · 3 woods */
    at(x, z) {
      const i = Math.round((x + 20000) / cell), j = Math.round((z + 20000) / cell);
      if (i < 0 || j < 0 || i >= n || j >= n) return 0;
      return cls[j * n + i];
    },
  };
  realCache.set(data, R);
  return R;
}

/** Signed distance (m) from (x,z) to the segment a-b, and the position along it (0..1). */
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

/**
 * Shared real-map terrain: water deepens away from the shore (rivers stay shallow, the open sea
 * goes down to the floor), land rises gently inland, and `relief(x, z, R, dl)` adds the named hills.
 * The world is finite, so the last ~1.3 km fall away into the sea like the other maps' coasts.
 */
function realShape(hf, x, z, relief) {
  const map = hf.map, R = realGrid(map.real);
  const i = Math.round((x + hf.half) / R.cell), j = Math.round((z + hf.half) / R.cell), k = j * R.n + i;
  const n = hf.noise, em = Math.max(Math.abs(x), Math.abs(z));
  const edge = em < hf.half - 950 ? 1 : smoothstep(hf.half - 100, hf.half - 800, em + n.noise2D(x / 2500, z / 2500) * 120);
  let h;
  // islands forced by landmarks (Liberty Island is smaller than one terrain cell)
  let island = 0;
  for (const lm of map.landmarks || []) if (lm.island) {
    const [lx, lz] = llOf(R, lm.at);
    island = Math.max(island, smoothstep(lm.island + 90, lm.island - 40, Math.hypot(x - lx, z - lz)));
  }
  if (R.cls[k] === 0 && island < 0.5) {
    const dw = R.toLand[k] - R.cell * 0.5;
    // river maps get a deep channel straight away: a 2-cell river is all "shore" to the water
    // shader otherwise, and turns to surf from bank to bank
    h = (map.seaDepth ? -3 : -11) - 5 * smoothstep(0, 250, dw) - 52 * smoothstep(400, 3500, dw) * map.seaDepth;
  } else {
    const dl = Math.max(R.toWater[k] - R.cell * 0.5, island > 0.5 ? 60 : 0);
    h = map.bank + map.inland * smoothstep(0, 2500, dl) + hf.fbm(x / 2200, z / 2200, 3) * 5 * smoothstep(0, 400, dl)
      + n.noise2D(x / 600, z / 600) * 1.5 + relief(x, z, R, dl);
  }
  h = mix(SEA_FLOOR, h, edge);
  return Math.max(h, SEA_FLOOR);
}

// lat/lon -> metres, memoised per (grid, point): the shapes run these for every terrain vertex
const llMemo = new WeakMap();
const llOf = (R, at) => {
  let m = llMemo.get(R);
  if (!m) llMemo.set(R, m = new Map());
  let v = m.get(at);
  if (!v) m.set(at, v = R.ll(at[0], at[1]));
  return v;
};
/** Gaussian-ish hill at [lat, lon]: height h, radius r (m), steepness via the exponent. */
const hill = (R, x, z, at, h, r, p = 2) => {
  const [hx, hz] = llOf(R, at);
  const dx = x - hx, dz = z - hz;
  if (dx * dx + dz * dz > 9 * r * r) return 0;                       // < 0.01 % of h out there
  const d = Math.sqrt(dx * dx + dz * dz) / r;
  return h * Math.exp(-(p === 2 ? d * d : Math.pow(d, p)));
};
/** A ridge along a lat/lon polyline. */
const ridge = (R, x, z, pts, h, r) => {
  let d = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = llOf(R, pts[k]), [bx, bz] = llOf(R, pts[k + 1]);
    d = Math.min(d, segDist(x, z, ax, az, bx, bz));
  }
  return d > 3 * r ? 0 : h * Math.exp(-(d / r) * (d / r));
};

/* Relief tables: hills are [[lat, lon], height, radius, exponent?], ridges [[[lat, lon], …], height, half-width].
   Kept at module level so llOf() memoises every point (the shapes run once per terrain vertex). */
const sumRelief = (R, x, z, hills, ridges) => {
  let h = 0;
  for (const [at, H, r, p] of hills) h += hill(R, x, z, at, H, r, p);
  for (const [pts, H, r] of ridges) h += ridge(R, x, z, pts, H, r);
  return h;
};

/* New York: the Palisades cliff along the Hudson's west bank, Washington Heights, the glacial
   moraine across Brooklyn and Queens, Todt Hill on Staten Island. */
const PALISADES = [40.80, -73.99];
const NYC_HILLS = [
  [[40.597, -74.115], 105, 2600, 1.6],                                                // Todt Hill
];
const NYC_RIDGES = [
  [[[40.835, -73.944], [40.872, -73.925]], 45, 450],                                  // Washington Heights
  [[[40.655, -73.975], [40.685, -73.905], [40.712, -73.840], [40.745, -73.735]], 28, 1300],   // moraine
  [[[40.86, -73.88], [40.90, -73.86]], 25, 1500],                                     // Bronx
];
function nyc(hf, x, z) {
  return realShape(hf, x, z, (x, z, R, dl) => {
    let h = sumRelief(R, x, z, NYC_HILLS, NYC_RIDGES);
    // Palisades: a sheer basalt wall straight up from the river, north of Weehawken
    const [px, pz] = llOf(R, PALISADES);
    const lat = 40.722 - z / 110574;
    if (lat > 40.755 && x < px + (pz - z) * 0.49 + 250) {
      const along = smoothstep(40.755, 40.80, lat);
      h += along * 95 * smoothstep(0, 160, dl) * smoothstep(2600, 1400, dl);
    }
    return h;
  });
}

/* Paris: the Seine valley between the buttes — Montmartre, Belleville, Mont Valérien — and the
   wooded plateaus of Meudon / Saint-Cloud to the south-west. */
const PARIS_HILLS = [
  [[48.8867, 2.3431], 92, 520, 1.7],              // Montmartre
  [[48.8730, 2.3900], 58, 1300],                  // Belleville / Ménilmontant
  [[48.8800, 2.3830], 25, 500],                   // Buttes-Chaumont
  [[48.8714, 2.2126], 118, 1000, 1.6],            // Mont Valérien
  [[48.885, 2.455], 75, 2400],                    // Romainville plateau
  [[49.000, 2.310], 120, 3200],                   // Montmorency hills
  [[48.840, 2.520], 50, 3000],                    // Plateau d'Avron
];
const PARIS_RIDGES = [
  [[[48.845, 2.205], [48.815, 2.215], [48.795, 2.250], [48.780, 2.300]], 95, 1900],   // Saint-Cloud / Meudon
  [[[48.800, 2.330], [48.775, 2.400]], 55, 2600],                                     // Villejuif plateau (Orly side)
];
function paris(hf, x, z) {
  return realShape(hf, x, z, (x, z, R) => sumRelief(R, x, z, PARIS_HILLS, PARIS_RIDGES));
}

/* London: the Thames basin between Hampstead and the Crystal Palace ridge. */
const LONDON_HILLS = [
  [[51.5630, -0.1650], 105, 2300],                // Hampstead / Highgate
  [[51.4700, 0.0650], 110, 1700],                 // Shooters Hill
  [[51.5720, -0.3370], 85, 1100],                 // Harrow on the Hill
  [[51.4510, -0.2950], 40, 1500],                 // Richmond Hill
  [[51.4770, -0.0010], 38, 700],                  // Greenwich Park
  [[51.6000, -0.0800], 50, 3500],                 // the northern heights
];
const LONDON_RIDGES = [
  [[[51.4400, -0.1200], [51.4180, -0.0700], [51.4300, -0.0200]], 95, 1900],           // Norwood / Crystal Palace
];
function london(hf, x, z) {
  return realShape(hf, x, z, (x, z, R) => sumRelief(R, x, z, LONDON_HILLS, LONDON_RIDGES));
}

/* Rio de Janeiro: real SRTM terrain, sharpened at the famous granite peaks the coarse grid rounds off. */
const RIO_PEAKS = [
  [[-22.9492, -43.1546], 392, 300, 2.6],          // Sugarloaf
  [[-22.9505, -43.1636], 215, 260, 2.2],          // Morro da Urca
  [[-22.9519, -43.2105], 700, 480, 1.6],          // Corcovado
  [[-22.9395, -43.2856], 1015, 1100, 1.5],        // Pico da Tijuca
  [[-22.9975, -43.2847], 835, 620, 3.0],          // Pedra da Gávea (flat-topped)
  [[-22.9880, -43.2400], 530, 420, 1.8],          // Dois Irmãos
  [[-22.9300, -43.1150], 280, 900, 1.6],          // Niterói hills
];
function rio(hf, x, z) {
  return realShape(hf, x, z, (x, z, R, dl) => {
    const e = R.elevAt(x, z);
    let h = (e + hf.ridged(x / 1400, z / 1400, 4) * Math.min(e, 600) * 0.12) * smoothstep(0, 220, dl);
    const k = smoothstep(0, 60, dl);
    for (const [at, H, r, p] of RIO_PEAKS) h = Math.max(h, hill(R, x, z, at, H, r, p) * k);
    return h - 1.5;
  });
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


/*
 * Real maps add:
 *   real: baked OSM grid · seaDepth 0..1 · bank / inland: ground height at the water's edge / far inland (m)
 *   sites: { fields: [airport codes in real.fields, as home / civil / enemy], city: [lat, lon], cityR }
 *   urban: street grid + districts. angle: avenue heading (deg, 0 = north) or null for patchwork grids
 *     (a random angle per ~1.4 km Voronoi cell); block: [across, along] the avenues (m); street: [w, w] (m).
 *     zones: { at: [lat, lon] | line: [[lat, lon], …], r (m), share of the building budget, ground 0..1
 *     (street-grid ground), mix: { style: weight }, floors: { style: [min, max] }, size (footprint scale) }
 *     roof: gable roofs on 'low' houses (<= 4 floors) or on 'all' houses (Paris mansards), roofCol: tint
 *   landmarks: see world/Landmarks.js (types and parameters)
 */
MAPS.nyc = {
  name: 'NEW YORK CITY', seed: 0.0311, shape: nyc, real: NYC, seaDepth: 1, bank: 2.5, inland: 9,
  fields: ['JFK INTL', 'LA GUARDIA', 'NEWARK'], city: 'MANHATTAN', terrainWord: 'five boroughs',
  sites: { fields: ['JFK', 'LGA', 'EWR'], city: [40.754, -73.984], cityR: 2500 },
  palette: {
    grassA: [0.13, 0.22, 0.07], grassB: [0.27, 0.32, 0.12], upland: [0.30, 0.29, 0.20], uplandH: [140, 300],
    forest: [0.05, 0.11, 0.04], sand: [0.60, 0.55, 0.42], beachH: 2.5,
    rockA: [0.20, 0.19, 0.18], rockB: [0.36, 0.34, 0.31], rockSlope: [0.16, 0.42], strata: 0,
    snow: [0.93, 0.95, 1.0], snowH: [1e5, 1e5 + 1],
    shallow: [0.08, 0.24, 0.24], deep: [0.012, 0.06, 0.10],
  },
  forest: { hMin: 2, hMax: 400, bias: 0.1 },
  trees: { shape: 'blob', hue: [0.22, 0.08], sat: 0.45, light: [0.17, 0.08], size: [9, 7], width: 0.85 },
  houses: [0x8c4a36, 0x9a5a44, 0x6e3b2e, 0xb08a6a, 0xc8b8a0, 0x7a6658, 0xa0603e], clouds: 0.9,
  mini: { sand: [150, 140, 110], low: [60, 86, 50], up: [86, 84, 78], high: [150, 150, 150], upH: 200, highH: 600 },
  urban: {
    angle: 29, block: [262, 80], street: [30, 18], groundA: [0.12, 0.115, 0.11], groundB: [0.21, 0.18, 0.155],
    roof: 'low', roofCol: [0.55, 0.42, 0.36],
    zones: [
      { name: 'midtown', line: [[40.7425, -73.9935], [40.7655, -73.9745]], r: 780, share: 0.2, ground: 1,
        mix: { glass: 0.5, office: 0.5 }, floors: { glass: [22, 78], office: [10, 34] } },
      { name: 'downtown', at: [40.7075, -74.0105], r: 700, share: 0.08, ground: 1,
        mix: { glass: 0.55, office: 0.45 }, floors: { glass: [24, 70], office: [10, 30] } },
      { name: 'manhattan', line: [[40.704, -74.013], [40.795, -73.962], [40.873, -73.921]], r: 1750, share: 0.32, ground: 1,
        fill: { mix: { office: 0.4, res: 0.6 }, floors: [4, 13], parts: [3, 6] },
        mix: { glass: 0.08, office: 0.42, res: 0.5 }, floors: { glass: [14, 32], office: [6, 20], res: [4, 8] } },
      { name: 'jersey city', line: [[40.712, -74.036], [40.750, -74.024]], r: 900, share: 0.04, ground: 1,
        mix: { glass: 0.35, office: 0.3, res: 0.35 }, floors: { glass: [18, 48], office: [6, 18], res: [3, 6] } },
      { name: 'downtown brooklyn', at: [40.692, -73.986], r: 800, share: 0.035, ground: 1,
        mix: { glass: 0.3, office: 0.35, res: 0.35 }, floors: { glass: [16, 50], office: [6, 18], res: [3, 6] } },
      { name: 'long island city', at: [40.747, -73.944], r: 650, share: 0.025, ground: 1,
        mix: { glass: 0.4, office: 0.3, res: 0.3 }, floors: { glass: [16, 50], office: [5, 12], res: [3, 6] } },
      { name: 'brooklyn', line: [[40.700, -73.990], [40.690, -73.940], [40.745, -73.930]], r: 2600, share: 0, ground: 1,
        fill: { mix: { res: 1 }, floors: [2, 5], parts: [4, 8], far: 1.5 } },
      { name: 'boroughs', at: [40.715, -73.955], r: 13500, share: 0.30, ground: 0.75, size: 0.9,
        mix: { office: 0.12, res: 0.88 }, floors: { office: [3, 9], res: [2, 5] } },
    ],
  },
  landmarks: [
    { type: 'empire', at: [40.74844, -73.98566], rot: 29 },
    { type: 'chrysler', at: [40.75162, -73.97545], rot: 29 },
    { type: 'onewtc', at: [40.71274, -74.01338], rot: 29 },
    { type: 'liberty', at: [40.68925, -74.04450], rot: 0, island: 200 },
    { type: 'suspension', name: 'BROOKLYN BRIDGE', at: [40.70570, -73.99690], hdg: 133, span: 486, len: 1150, ramp: 420, deckH: 38, towerH: 84, col: 0x9a8c74, stone: true },
    { type: 'suspension', name: 'MANHATTAN BRIDGE', at: [40.70750, -73.99080], hdg: 145, span: 448, len: 1100, ramp: 420, deckH: 40, towerH: 102, col: 0x5d7f9a },
    { type: 'suspension', name: 'WILLIAMSBURG BRIDGE', at: [40.71340, -73.97250], hdg: 110, span: 488, len: 1150, ramp: 450, deckH: 41, towerH: 102, col: 0x8a7e72 },
    { type: 'suspension', name: 'GEORGE WASHINGTON BRIDGE', at: [40.85170, -73.95270], hdg: 107, span: 1067, len: 1450, ramp: 300, deckH: 65, towerH: 184, col: 0x8e969a },
    { type: 'suspension', name: 'VERRAZZANO', at: [40.60660, -74.04470], hdg: 67, span: 1298, len: 2050, ramp: 500, deckH: 69, towerH: 211, col: 0xa8adb0 },
  ],
};

MAPS.paris = {
  name: 'PARIS', seed: 0.1789, shape: paris, real: PARIS, seaDepth: 0, bank: 5, inland: 22,
  fields: ['VILLACOUBLAY AB', 'ORLY', 'CHARLES DE GAULLE'], city: 'PARIS', terrainWord: 'Seine valley',
  sites: { fields: ['VCB', 'ORY', 'CDG'], city: [48.8584, 2.3200], cityR: 2800 },
  palette: {
    grassA: [0.16, 0.24, 0.08], grassB: [0.32, 0.34, 0.14], upland: [0.30, 0.30, 0.16], uplandH: [160, 320],
    forest: [0.05, 0.12, 0.04], sand: [0.52, 0.49, 0.42], beachH: 1,
    rockA: [0.40, 0.37, 0.31], rockB: [0.58, 0.54, 0.46], rockSlope: [0.18, 0.45], strata: 0,
    patch: [0.36, 0.33, 0.16, 0.3],
    snow: [0.93, 0.95, 1.0], snowH: [1e5, 1e5 + 1],
    shallow: [0.10, 0.22, 0.18], deep: [0.03, 0.09, 0.08],
  },
  forest: { hMin: 2, hMax: 400, bias: 0.1 },
  trees: { shape: 'blob', hue: [0.21, 0.07], sat: 0.42, light: [0.17, 0.08], size: [10, 8], width: 0.9 },
  houses: [0xe6dcc4, 0xddd0b4, 0xefe6d2, 0xd8ccb0, 0xe2d6bc, 0xcfc2a6], clouds: 1,
  mini: { sand: [150, 140, 120], low: [70, 96, 52], up: [96, 98, 70], high: [150, 150, 150], upH: 120, highH: 600 },
  urban: {
    angle: null, block: [96, 96], street: [16, 12], groundA: [0.17, 0.17, 0.18], groundB: [0.25, 0.23, 0.19],
    roof: 'all', roofCol: [0.50, 0.55, 0.62], roofH: 4,
    zones: [
      { name: 'paris', at: [48.8590, 2.3450], r: 5600, share: 0.35, ground: 1, size: 1.2,
        fill: { mix: { res: 1 }, floors: [5, 7], parts: [1, 3] },
        mix: { res: 0.88, office: 0.12 }, floors: { res: [5, 7], office: [6, 8] } },
      { name: 'la defense', at: [48.8915, 2.2400], r: 620, share: 0.05, ground: 1,
        mix: { glass: 0.8, office: 0.2 }, floors: { glass: [22, 62], office: [10, 25] } },
      { name: 'olympiades', at: [48.8265, 2.3655], r: 380, share: 0.012, ground: 1,
        mix: { office: 1 }, floors: { office: [18, 30] } },
      { name: 'front de seine', at: [48.8480, 2.2850], r: 300, share: 0.01, ground: 1,
        mix: { glass: 0.5, office: 0.5 }, floors: { glass: [20, 32], office: [18, 30] } },
      { name: 'banlieue', at: [48.8600, 2.3500], r: 14500, share: 0.58, ground: 0.7, size: 0.9,
        mix: { res: 0.85, office: 0.15 }, floors: { res: [2, 4], office: [4, 15] } },
    ],
  },
  landmarks: [
    { type: 'eiffel', at: [48.85826, 2.29450], rot: 46 },
    { type: 'arc', at: [48.87380, 2.29500], rot: 112 },
    { type: 'notredame', at: [48.85300, 2.34990], rot: 113, island: 160 },
    { type: 'sacrecoeur', at: [48.88670, 2.34310], rot: 0 },
    { type: 'montparnasse', at: [48.84210, 2.32200], rot: 20 },
    { type: 'grandearche', at: [48.89250, 2.23610], rot: 23 },
    { type: 'louvre', at: [48.86080, 2.33620], rot: 23 },
    { type: 'invalides', at: [48.85500, 2.31250], rot: 0 },
    ...[[48.85750, 2.34120], [48.85830, 2.33750], [48.86370, 2.31360], [48.86370, 2.31970], [48.86010, 2.29250],
      [48.85560, 2.28770], [48.86010, 2.32910], [48.85350, 2.34450], [48.84350, 2.36550], [48.83850, 2.37560],
      [48.86350, 2.30180], [48.84970, 2.28150], [48.85040, 2.36000], [48.85500, 2.34980], [48.86230, 2.30750],
      [48.85920, 2.33320], [48.85640, 2.34720], [48.84630, 2.36700]].map(at => ({ type: 'beam', at })),
  ],
};

MAPS.london = {
  name: 'LONDON', seed: 0.5151, shape: london, real: LONDON, seaDepth: 0, bank: 4, inland: 16,
  fields: ['RAF NORTHOLT', 'HEATHROW', 'LONDON CITY'], city: 'LONDON', terrainWord: 'Thames',
  sites: { fields: ['NHT', 'LHR', 'LCY'], city: [51.5072, -0.1100], cityR: 2800 },
  palette: {
    grassA: [0.13, 0.25, 0.07], grassB: [0.26, 0.34, 0.12], upland: [0.24, 0.30, 0.12], uplandH: [200, 400],
    forest: [0.05, 0.12, 0.04], sand: [0.42, 0.38, 0.30], beachH: 1,
    rockA: [0.30, 0.28, 0.24], rockB: [0.45, 0.42, 0.36], rockSlope: [0.2, 0.5], strata: 0,
    snow: [0.93, 0.95, 1.0], snowH: [1e5, 1e5 + 1],
    shallow: [0.12, 0.17, 0.13], deep: [0.04, 0.07, 0.06],
  },
  forest: { hMin: 2, hMax: 400, bias: 0.1 },
  trees: { shape: 'blob', hue: [0.22, 0.07], sat: 0.42, light: [0.16, 0.08], size: [10, 8], width: 0.9 },
  houses: [0x8a4b3a, 0xa0624a, 0x7d3f30, 0x94523e, 0xc9bda5, 0xd8cfbb, 0x6e5a4a], clouds: 1.3,
  mini: { sand: [140, 130, 110], low: [66, 98, 52], up: [90, 104, 64], high: [150, 150, 150], upH: 150, highH: 600 },
  urban: {
    angle: null, block: [110, 72], street: [14, 12], groundA: [0.15, 0.135, 0.12], groundB: [0.24, 0.20, 0.17],
    roof: 'all', roofCol: [0.42, 0.40, 0.42], roofH: 2.6,
    zones: [
      { name: 'city', at: [51.5140, -0.0860], r: 750, share: 0.10, ground: 1,
        mix: { glass: 0.55, office: 0.45 }, floors: { glass: [16, 50], office: [8, 22] } },
      { name: 'canary wharf', at: [51.5050, -0.0195], r: 560, share: 0.06, ground: 1,
        mix: { glass: 0.85, office: 0.15 }, floors: { glass: [25, 55], office: [10, 25] } },
      { name: 'west end', line: [[51.4950, -0.1900], [51.5150, -0.1400], [51.5170, -0.0750]], r: 2400, share: 0.18, ground: 1,
        mix: { office: 0.55, res: 0.45 }, floors: { office: [5, 10], res: [4, 6] },
        fill: { mix: { office: 0.35, res: 0.65 }, floors: [4, 7], parts: [2, 4] } },
      { name: 'inner london', at: [51.5050, -0.1050], r: 8000, share: 0.10, ground: 1,
        mix: { office: 0.2, res: 0.8 }, floors: { office: [8, 20], res: [2, 4] },
        fill: { mix: { res: 1 }, floors: [2, 4], parts: [4, 8], far: 1.7 } },
      { name: 'suburbs', at: [51.5050, -0.1500], r: 16000, share: 0.56, ground: 0.6, size: 0.85,
        mix: { office: 0.08, res: 0.92 }, floors: { office: [4, 14], res: [2, 3] } },
    ],
  },
  landmarks: [
    { type: 'westminster', at: [51.49950, -0.12500], rot: 10 },
    { type: 'londoneye', at: [51.50330, -0.11960], rot: 25 },
    { type: 'towerbridge', at: [51.50550, -0.07540], rot: 5 },
    { type: 'shard', at: [51.50450, -0.08650], rot: 20 },
    { type: 'stpauls', at: [51.51380, -0.09840], rot: 85 },
    { type: 'gherkin', at: [51.51450, -0.08030], rot: 0 },
    { type: 'battersea', at: [51.48150, -0.14450], rot: 60 },
    { type: 'o2', at: [51.50300, 0.00320], rot: 0 },
    ...[[51.50080, -0.12180], [51.49460, -0.12380], [51.50870, -0.11660], [51.50970, -0.10430], [51.50960, -0.09850],
      [51.50850, -0.09430], [51.50790, -0.08770], [51.48780, -0.12680], [51.48460, -0.14970], [51.48230, -0.16650],
      [51.50650, -0.12030], [51.51040, -0.10850], [51.47800, -0.17200], [51.46800, -0.21000]].map(at => ({ type: 'beam', at })),
  ],
};

MAPS.rio = {
  name: 'RIO DE JANEIRO', seed: 0.2231, shape: rio, real: RIO, seaDepth: 1, bank: 2.5, inland: 4,
  fields: ['AFONSOS AB', 'GALEAO INTL', 'SANTOS DUMONT'], city: 'RIO', terrainWord: 'bay and mountains',
  sites: { fields: ['SBAF', 'GIG', 'SDU'], city: [-22.9300, -43.1900], cityR: 3000 },
  palette: {
    grassA: [0.09, 0.24, 0.05], grassB: [0.20, 0.34, 0.08], upland: [0.12, 0.22, 0.07], uplandH: [300, 700],
    patch: [0.05, 0.15, 0.03, 0.3],
    forest: [0.025, 0.11, 0.03], sand: [0.84, 0.78, 0.60], beachH: 3.5,
    rockA: [0.26, 0.25, 0.24], rockB: [0.48, 0.46, 0.43], rockSlope: [0.2, 0.42], strata: 0,
    snow: [0.93, 0.95, 1.0], snowH: [1e5, 1e5 + 1],
    shallow: [0.05, 0.45, 0.44], deep: [0.01, 0.09, 0.18],
  },
  forest: { hMin: 3, hMax: 1100, bias: -0.2 },
  trees: { shape: 'blob', hue: [0.25, 0.08], sat: 0.55, light: [0.20, 0.09], size: [10, 9], width: 0.85 },
  houses: [0xf2efe6, 0xe8e0d0, 0xf0d8b8, 0xd8e4e8, 0xe8c8a8, 0xc87850, 0xd09060], clouds: 1.1,
  mini: { sand: [214, 200, 150], low: [50, 100, 40], up: [56, 84, 40], high: [110, 110, 104], upH: 250, highH: 650 },
  urban: {
    angle: null, block: [90, 70], street: [14, 10], groundA: [0.16, 0.15, 0.14], groundB: [0.26, 0.23, 0.20],
    roof: 'low', roofCol: [0.62, 0.36, 0.26],
    zones: [
      { name: 'zona sul', line: [[-22.9680, -43.1780], [-22.9840, -43.2000], [-22.9860, -43.2250]], r: 750, share: 0.20, ground: 1,
        mix: { office: 0.6, res: 0.4 }, floors: { office: [10, 16], res: [8, 12] },
        fill: { mix: { office: 0.5, res: 0.5 }, floors: [8, 14], parts: [2, 3] } },
      { name: 'botafogo', line: [[-22.9150, -43.1750], [-22.9450, -43.1800]], r: 650, share: 0.08, ground: 1,
        mix: { office: 0.6, res: 0.4 }, floors: { office: [8, 18], res: [5, 10] },
        fill: { mix: { office: 0.5, res: 0.5 }, floors: [6, 12], parts: [2, 3] } },
      { name: 'centro', at: [-22.9050, -43.1800], r: 900, share: 0.10, ground: 1,
        mix: { glass: 0.45, office: 0.55 }, floors: { glass: [18, 42], office: [8, 25] } },
      { name: 'barra', line: [[-23.0050, -43.3200], [-23.0100, -43.3700]], r: 700, share: 0.08, ground: 1,
        mix: { glass: 0.3, office: 0.7 }, floors: { glass: [15, 30], office: [10, 20] } },
      { name: 'zona norte', at: [-22.8900, -43.2700], r: 8000, share: 0.40, ground: 0.7, size: 0.85,
        mix: { office: 0.12, res: 0.88 }, floors: { office: [5, 14], res: [2, 4] },
        fill: { mix: { res: 0.85, office: 0.15 }, floors: [2, 5], parts: [3, 6], far: 1.6 } },
      { name: 'niteroi', at: [-22.9000, -43.1050], r: 2500, share: 0.06, ground: 0.9,
        mix: { office: 0.4, res: 0.6 }, floors: { office: [8, 18], res: [2, 5] } },
      { name: 'rocinha', at: [-22.9880, -43.2480], r: 400, share: 0.04, ground: 0.9, size: 0.5,
        mix: { res: 1 }, floors: { res: [2, 4] } },
    ],
  },
  landmarks: [
    { type: 'christ', at: [-22.95190, -43.21050], rot: 150, summit: true },
    { type: 'cable', at: [-22.95300, -43.16000], rot: 0, stops: [[-22.95530, -43.16500], [-22.95050, -43.16360], [-22.94920, -43.15460]] },
    { type: 'causeway', at: [-22.87500, -43.17000], rot: 0, deckH: 26, topH: 72, peak: 0.42,
      path: [[-22.8830, -43.2260], [-22.8760, -43.2050], [-22.8700, -43.1800], [-22.8690, -43.1600], [-22.8720, -43.1400], [-22.8770, -43.1250], [-22.8830, -43.1150]] },
    { type: 'maracana', at: [-22.91220, -43.23020], rot: 30 },
  ],
};

export const MAP_ORDER = ['nordic', 'desert', 'tropic', 'nyc', 'paris', 'london', 'rio'];
export const getMap = (key) => MAPS[key] || MAPS.nordic;
