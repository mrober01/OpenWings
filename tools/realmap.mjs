// realmap.mjs — bakes a real-world map (coastline, rivers, lakes, parks, runways) from
// OpenStreetMap into src/world/real/<key>.data.js for the game's 40 km grid.
//   node tools/realmap.mjs nyc|paris [--refetch] [--ppm=/tmp/x.ppm]
// Raw Overpass replies are cached in tools/.cache/ (gitignored). Map data © OpenStreetMap
// contributors, ODbL — the generated files carry that notice.
//
// Output: one class per terrain vertex (513 x 513, same grid as world/Heightfield.js):
//   0 water · 1 land · 2 park/green · 3 woods
// encoded as row-wise run lengths, plus the longest runway of each listed airport.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = 40000, GRID = 512, CELL = WORLD / GRID, HALF = WORLD / 2;
const SS = 4;                                   // supersampling per terrain cell
const FN = GRID * SS + 1, FC = CELL / SS;       // fine raster

const CITIES = {
  nyc: {
    lat0: 40.722, lon0: -73.975,
    // water flood seeds: Lower Bay, Atlantic off the Rockaways, Long Island Sound
    seeds: [[40.55, -74.05], [40.52, -73.85], [40.83, -73.76], [40.70, -74.03]],
    coast: true,
    airports: { JFK: [40.6413, -73.7781], LGA: [40.7769, -73.8740], EWR: [40.6895, -74.1745] },
    rivers: [],
  },
  paris: {
    lat0: 48.858, lon0: 2.36,
    seeds: [],
    coast: false,
    airports: { VCB: [48.7742, 2.2017], ORY: [48.7262, 2.3652], CDG: [49.0097, 2.5479], LBG: [48.9694, 2.4414] },
    // centrelines drawn at least this wide (m) so the river never breaks up on the 78 m grid
    rivers: [['Seine', 170], ['La Seine', 170], ['La Marne', 120], ['Marne', 120], ['L\'Oise', 110]],
  },
  london: {
    lat0: 51.500, lon0: -0.200,
    seeds: [],
    coast: false,
    airports: { NHT: [51.5530, -0.4182], LHR: [51.4700, -0.4543], LCY: [51.5048, 0.0495] },
    rivers: [['River Thames', 190], ['River Lea', 0], ['River Brent', 0]],
  },
  rio: {
    lat0: -22.920, lon0: -43.235,
    // Atlantic off Copacabana, Guanabara Bay, Barra / Recreio
    seeds: [[-23.02, -43.20], [-22.86, -43.16], [-23.06, -43.35], [-22.80, -43.12]],
    coast: true,
    airports: { SBAF: [-22.8750, -43.3847], GIG: [-22.8100, -43.2506], SDU: [-22.9105, -43.1631], JPA: [-22.9875, -43.3700] },
    rivers: [],
    elev: 100,                                      // real terrain: 100 x 100 SRTM samples (OpenTopoData)
  },
};

const key = process.argv[2];
const C = CITIES[key];
if (!C) { console.error('usage: node tools/realmap.mjs ' + Object.keys(CITIES).join('|')); process.exit(1); }
const refetch = process.argv.includes('--refetch');
const ppmArg = (process.argv.find(a => a.startsWith('--ppm=')) || '').slice(6);

const KX = 111320 * Math.cos(C.lat0 * Math.PI / 180), KZ = 110574;
const toXZ = (lat, lon) => [(lon - C.lon0) * KX, -(lat - C.lat0) * KZ];
const pad = 1500;
const bbox = [C.lat0 - (HALF + pad) / KZ, C.lon0 - (HALF + pad) / KX, C.lat0 + (HALF + pad) / KZ, C.lon0 + (HALF + pad) / KX].map(v => v.toFixed(5)).join(',');

async function overpass(name, q) {
  const dir = path.join(ROOT, 'tools/.cache'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${key}-${name}.json`);
  if (!refetch && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`fetching ${name}…`);
  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = urls[attempt % urls.length];
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'user-agent': 'OpenWings-mapgen/1.0 (hobby flight sim)', 'content-type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(`[out:json][timeout:180];(${q});out geom;`) });
      if (r.ok) {
        const j = await r.json();
        fs.writeFileSync(f, JSON.stringify(j));
        return j;
      }
      console.log(`  ${url}: HTTP ${r.status}`);
    } catch (e) { console.log(`  ${url}: ${e.message}`); }
    await new Promise(res => setTimeout(res, Math.min(60, 5 * 2 ** (attempt / 3)) * 1000));   // back off
  }
  throw new Error('overpass failed: ' + name);
}

/* ---------------- fine raster ---------------- */
// 0 unknown/land · 1 coast barrier · 2 water · then overlays
const fine = new Uint8Array(FN * FN);      // water (2) / barrier (1) / land (0)
const green = new Uint8Array(FN * FN);     // 0 none · 1 park · 2 woods
const fi = (x) => (x + HALF) / FC;

function drawLine(ax, az, bx, bz, put) {
  // 4-connected DDA so the barrier has no diagonal leaks
  let x0 = fi(ax), y0 = fi(az); const x1 = fi(bx), y1 = fi(bz);
  let ix = Math.floor(x0), iy = Math.floor(y0); const ex = Math.floor(x1), ey = Math.floor(y1);
  const dx = x1 - x0, dy = y1 - y0, sx = Math.sign(dx), sy = Math.sign(dy);
  const tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity;
  let tx = dx ? (sx > 0 ? (ix + 1 - x0) : (x0 - ix)) * tdx : Infinity;
  let ty = dy ? (sy > 0 ? (iy + 1 - y0) : (y0 - iy)) * tdy : Infinity;
  put(ix, iy);
  for (let n = 0; n < 1e6 && (ix !== ex || iy !== ey); n++) {
    if (tx < ty) { ix += sx; tx += tdx; } else { iy += sy; ty += tdy; }
    put(ix, iy);
  }
}

/** Even-odd scanline fill of a set of edges (closed rings, possibly split into many ways). */
function fillEdges(edges, put) {
  if (!edges.length) return;
  let zmin = Infinity, zmax = -Infinity;
  for (const e of edges) { zmin = Math.min(zmin, e[1], e[3]); zmax = Math.max(zmax, e[1], e[3]); }
  const j0 = Math.max(0, Math.ceil(fi(zmin))), j1 = Math.min(FN - 1, Math.floor(fi(zmax)));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const z = j * FC - HALF; xs.length = 0;
    for (const [ax, az, bx, bz] of edges) {
      if ((az <= z) === (bz <= z)) continue;
      xs.push(ax + (z - az) / (bz - az) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(fi(xs[k]))), i1 = Math.min(FN - 1, Math.floor(fi(xs[k + 1])));
      for (let i = i0; i <= i1; i++) put(i, j);
    }
  }
}

const geomXZ = (g) => g.map(p => toXZ(p.lat, p.lon));
/** All edges of a closed way or of a multipolygon relation's members (outer and inner alike). */
function edgesOf(el) {
  const lines = el.type === 'way' ? [el.geometry] : (el.members || []).filter(m => m.geometry && (m.role === 'outer' || m.role === 'inner' || m.role === '')).map(m => m.geometry);
  const edges = [];
  for (const g of lines) {
    const pts = geomXZ(g.filter(Boolean));
    for (let k = 0; k + 1 < pts.length; k++) edges.push([pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1]]);
  }
  return edges;
}
function area(edges) { let a = 0; for (const [ax, az, bx, bz] of edges) a += ax * bz - bx * az; return Math.abs(a / 2); }
/** Rings only close if every endpoint is shared an even number of times — skip broken (clipped) relations. */
function closed(edges) {
  const cnt = new Map(), k = (x, z) => `${x.toFixed(2)},${z.toFixed(2)}`;
  for (const [ax, az, bx, bz] of edges) { for (const s of [k(ax, az), k(bx, bz)]) cnt.set(s, (cnt.get(s) || 0) + 1); }
  for (const v of cnt.values()) if (v % 2) return false;
  return true;
}

const inF = (i, j) => i >= 0 && j >= 0 && i < FN && j < FN;

// 1) coastline + flood fill
if (C.coast) {
  const cj = await overpass('coast', `way["natural"="coastline"](${bbox});`);
  let segs = 0;
  for (const w of cj.elements) {
    const pts = geomXZ(w.geometry);
    for (let k = 0; k + 1 < pts.length; k++) { drawLine(pts[k][0], pts[k][1], pts[k + 1][0], pts[k + 1][1], (i, j) => { if (inF(i, j)) fine[j * FN + i] = 1; }); segs++; }
  }
  console.log(`coastline: ${cj.elements.length} ways, ${segs} segments`);
  const stack = [];
  for (const [la, lo] of C.seeds) {
    const [x, z] = toXZ(la, lo), i = Math.round(fi(x)), j = Math.round(fi(z));
    if (inF(i, j) && fine[j * FN + i] === 0) stack.push(j * FN + i);
  }
  while (stack.length) {
    const p = stack.pop();
    if (fine[p] !== 0) continue;
    fine[p] = 2;
    const i = p % FN, j = (p - i) / FN;
    if (i > 0) stack.push(p - 1); if (i < FN - 1) stack.push(p + 1);
    if (j > 0) stack.push(p - FN); if (j < FN - 1) stack.push(p + FN);
  }
  for (let p = 0; p < fine.length; p++) if (fine[p] === 1) fine[p] = 0;   // the barrier itself is land
}

// 2) lakes, reservoirs, riverbank polygons
const wj = await overpass('water', `way["natural"="water"](${bbox});relation["natural"="water"](${bbox});way["waterway"="riverbank"](${bbox});`);
let nl = 0;
for (const el of wj.elements) {
  const e = edgesOf(el);
  if (!e.length || !closed(e) || area(e) < 12000) continue;
  fillEdges(e, (i, j) => { fine[j * FN + i] = 2; }); nl++;
}
console.log(`water polygons: ${nl} of ${wj.elements.length}`);

// 3) river centrelines with a minimum width
if (C.rivers.length) {
  const rj = await overpass('rivers', `way["waterway"="river"](${bbox});`);
  const widths = new Map(C.rivers);
  let nr = 0;
  for (const w of rj.elements) {
    const wd = widths.get(w.tags && w.tags.name);
    if (!wd) continue;                              // (0 = known but too small to draw)
    nr++;
    const pts = geomXZ(w.geometry), r = wd / 2;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
      const i0 = Math.max(0, Math.floor(fi(Math.min(ax, bx) - r))), i1 = Math.min(FN - 1, Math.ceil(fi(Math.max(ax, bx) + r)));
      const j0 = Math.max(0, Math.floor(fi(Math.min(az, bz) - r))), j1 = Math.min(FN - 1, Math.ceil(fi(Math.max(az, bz) + r)));
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = i * FC - HALF, z = j * FC - HALF;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
        if (Math.hypot(x - ax - dx * t, z - az - dz * t) < r) fine[j * FN + i] = 2;
      }
    }
  }
  console.log(`river ways: ${nr}`);
}

// 4) parks and woods
const gj = await overpass('green', `way["leisure"~"^(park|golf_course|nature_reserve)$"](${bbox});relation["leisure"~"^(park|golf_course|nature_reserve)$"](${bbox});` +
  `way["landuse"~"^(cemetery|forest|recreation_ground)$"](${bbox});relation["landuse"~"^(cemetery|forest)$"](${bbox});way["natural"="wood"](${bbox});relation["natural"="wood"](${bbox});`);
let ng = 0;
for (const el of gj.elements) {
  const e = edgesOf(el);
  if (!e.length || !closed(e) || area(e) < 60000) continue;
  const t = el.tags || {}, woods = t.landuse === 'forest' || t.natural === 'wood' || /^bois\b/i.test(t.name || '');
  fillEdges(e, (i, j) => { const p = j * FN + i; green[p] = Math.max(green[p], woods ? 2 : 1); }); ng++;
}
console.log(`green polygons: ${ng} of ${gj.elements.length}`);

/* ---------------- downsample to the terrain vertices ---------------- */
const N1 = GRID + 1, cls = new Uint8Array(N1 * N1);
for (let j = 0; j < N1; j++) for (let i = 0; i < N1; i++) {
  let wat = 0, g1 = 0, g2 = 0, n = 0;
  for (let b = -SS / 2; b < SS / 2; b++) for (let a = -SS / 2; a < SS / 2; a++) {
    const fx = i * SS + a, fz = j * SS + b;
    if (!inF(fx, fz)) continue;
    const p = fz * FN + fx; n++;
    if (fine[p] === 2) wat++; else if (green[p] === 2) g2++; else if (green[p] === 1) g1++;
  }
  cls[j * N1 + i] = wat * 2 >= n ? 0 : (g1 + g2) * 2 >= n - wat ? (g2 > g1 ? 3 : 2) : 1;
}

/* ---------------- runways ---------------- */
const aj = await overpass('runways', `way["aeroway"="runway"](${bbox});`);
const fields = {};
for (const [code, [la, lo]] of Object.entries(C.airports)) {
  const [px, pz] = toXZ(la, lo);
  let best = null;
  for (const w of aj.elements) {
    const pts = geomXZ(w.geometry);
    if (pts.length < 2) continue;
    const a = pts[0], b = pts[pts.length - 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2;
    if (Math.hypot(cx - px, cz - pz) > 3500 || L < 1200) continue;
    if (!best || L > best.L) {
      let hdg = Math.atan2(b[0] - a[0], -(b[1] - a[1]));            // 0 = north (-z), clockwise
      hdg = ((hdg % Math.PI) + Math.PI) % Math.PI;
      best = { L, x: Math.round(cx), z: Math.round(cz), heading: +hdg.toFixed(4), ref: w.tags && w.tags.ref };
    }
  }
  if (!best) console.log(`  no runway for ${code}`);
  else { fields[code] = best; console.log(`  ${code}: runway ${best.ref} ${Math.round(best.L)} m at ${best.x},${best.z} hdg ${(best.heading * 180 / Math.PI).toFixed(1)}°`); }
}

/* ---------------- elevation (optional) ---------------- */
let elev = null;
if (C.elev) {
  const n = C.elev, f = path.join(ROOT, `tools/.cache/${key}-elev${n}.json`);
  let vals;
  if (!refetch && fs.existsSync(f)) vals = JSON.parse(fs.readFileSync(f, 'utf8'));
  else {
    vals = [];
    const pts = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -HALF + WORLD * i / (n - 1), z = -HALF + WORLD * j / (n - 1);
      pts.push([C.lat0 - z / KZ, C.lon0 + x / KX]);
    }
    console.log(`fetching ${pts.length} elevations…`);
    for (let k = 0; k < pts.length; k += 100) {
      const q = pts.slice(k, k + 100).map(([a, b]) => `${a.toFixed(5)},${b.toFixed(5)}`).join('|');
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${q}`);
          const j = await r.json();
          if (j.status !== 'OK') throw new Error(j.error || r.status);
          vals.push(...j.results.map(e => e.elevation ?? 0));
          break;
        } catch (e) { if (attempt > 6) throw e; await new Promise(res => setTimeout(res, 3000 * (attempt + 1))); }
      }
      await new Promise(res => setTimeout(res, 1100));                // public API: 1 call / s
      if (k % 2000 === 0) console.log(`  ${k}/${pts.length}`);
    }
    fs.writeFileSync(f, JSON.stringify(vals));
  }
  // uint8, 5 m steps, below sea level clamps to 0
  elev = Buffer.from(vals.map(v => Math.max(0, Math.min(255, Math.round(v / 5))))).toString('base64');
  console.log(`elevation ${n}x${n}: max ${Math.max(...vals)} m`);
}

/* ---------------- encode ---------------- */
// per run one byte: class in the low 2 bits, run length 1..63 in the upper 6
const bytes = [];
for (let j = 0; j < N1; j++) {
  let i = 0;
  while (i < N1) {
    const c = cls[j * N1 + i]; let n = 1;
    while (i + n < N1 && n < 63 && cls[j * N1 + i + n] === c) n++;
    bytes.push(c | (n << 2)); i += n;
  }
}
const b64 = Buffer.from(bytes).toString('base64');
const counts = [0, 0, 0, 0]; for (const c of cls) counts[c]++;
console.log(`classes water/land/park/woods: ${counts.map(c => (100 * c / cls.length).toFixed(1) + '%').join(' ')}; ${bytes.length} B -> ${b64.length} chars`);

const out = path.join(ROOT, `src/world/real/${key}.data.js`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `// GENERATED by tools/realmap.mjs ${key} — do not edit.
// Map data © OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright
// Terrain-vertex classes (${N1}x${N1}, 0 water · 1 land · 2 park · 3 woods), row run-lengths:
// one byte per run = class | length << 2. Runways: longest of each airport (x/z metres, heading rad, 0 = north).
export default {
  lat0: ${C.lat0}, lon0: ${C.lon0}, n: ${N1},
  fields: ${JSON.stringify(fields, (k, v) => typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v)},
  rle: '${b64}',${elev ? `\n  // SRTM 30 m heights (NASA, via OpenTopoData) on a ${C.elev}x${C.elev} grid over the world, 5 m per step\n  elevN: ${C.elev}, elev: '${elev}',` : ''}
};
`);
console.log('wrote', path.relative(ROOT, out));

if (ppmArg) {
  const buf = Buffer.alloc(N1 * N1 * 3), pal = [[30, 70, 130], [150, 150, 140], [70, 150, 60], [30, 90, 30]];
  for (let p = 0; p < cls.length; p++) buf.set(pal[cls[p]], p * 3);
  fs.writeFileSync(ppmArg, Buffer.concat([Buffer.from(`P6 ${N1} ${N1} 255\n`), buf]));
  console.log('preview', ppmArg);
}
