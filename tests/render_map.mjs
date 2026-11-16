// Renders the heightfield to a PPM (top-down relief map) for eyeballing world layout.
// usage: node tests/render_map.mjs /tmp/map.ppm
import { Heightfield, GRID, WORLD_SIZE } from '../src/world/Heightfield.js';
import fs from 'node:fs';
const t0 = Date.now();
const hf = new Heightfield(process.argv[3] || 'nordic');
console.log('gen ms', Date.now() - t0);
const N = GRID, buf = Buffer.alloc(N * N * 3);
let land = 0, maxH = 0;
for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
  const h = hf.at(i, j), hx = hf.at(i + 1, j), hz = hf.at(i, j + 1);
  const x = i * hf.cell - hf.half, z = j * hf.cell - hf.half;
  let r, g, b;
  if (h <= 0) { const d = Math.min(1, -h / 60); r = 30 - d * 20; g = 90 - d * 50; b = 140 - d * 60; }
  else {
    land++; maxH = Math.max(maxH, h);
    const f = hf.forest(x, z, h);
    if (h < 4) { r = 200; g = 190; b = 150; }
    else if (h > 900) { r = g = b = 235; }
    else if (h > 420) { r = 120; g = 115; b = 105; }
    else { r = 90 - f * 50; g = 130 - f * 45; b = 70 - f * 35; }
    const sh = 1 + Math.max(-0.5, Math.min(0.5, ((h - hx) + (h - hz)) / hf.cell * 1.2));
    r *= sh; g *= sh; b *= sh;
  }
  const k = (j * N + i) * 3;
  buf[k] = Math.max(0, Math.min(255, r)); buf[k + 1] = Math.max(0, Math.min(255, g)); buf[k + 2] = Math.max(0, Math.min(255, b));
}
const mark = (x, z, col, rad = 3) => {
  const ci = Math.round((x + hf.half) / hf.cell), cj = Math.round((z + hf.half) / hf.cell);
  for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
    const i = ci + di, j = cj + dj; if (i < 0 || j < 0 || i >= N || j >= N) continue;
    const k = (j * N + i) * 3; buf[k] = col[0]; buf[k + 1] = col[1]; buf[k + 2] = col[2];
  }
};
for (const a of hf.airfields) {
  for (let s = -a.length / 2; s <= a.length / 2; s += 80) mark(a.x + a.dirX * s, a.z + a.dirZ * s, a.role === 'enemy' ? [255, 0, 0] : [255, 255, 0], 1);
  console.log(a.name, a.role, Math.round(a.x), Math.round(a.z), 'y', a.y, 'hdg', (a.heading * 180 / Math.PI).toFixed(0));
}
if (hf.city) { mark(hf.city.x, hf.city.z, [255, 0, 255], 4); console.log('city', hf.city); }
console.log('land frac', (land / N / N).toFixed(2), 'maxH', maxH.toFixed(0));
fs.writeFileSync(process.argv[2] || '/tmp/map.ppm', Buffer.concat([Buffer.from(`P6\n${N} ${N}\n255\n`), buf]));
