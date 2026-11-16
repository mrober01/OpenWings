// Heightfield.js — procedural terrain for one of the maps in world/Maps.js
// (Nordic fjords by default), plus its airfields and city.
// Pure JS (no three.js / DOM) so it can be unit-tested and rendered from node.
//
// The heightfield is THE source of truth for the ground: the terrain mesh is
// built from the same grid (with the same triangle split) that height() samples,
// so what you see is exactly what you collide with.
import { SimplexNoise } from './SimplexNoise.js';
import { MAPS, SEA_FLOOR } from './Maps.js';

export const WORLD_SIZE = 40000;   // metres, square, centred on the origin
export const GRID = 512;           // cells per side at full resolution
export { SEA_FLOOR };

const smoothstep = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

export class Heightfield {
  constructor(mapKey = 'nordic') {
    this.mapKey = MAPS[mapKey] ? mapKey : 'nordic';
    this.map = MAPS[this.mapKey];
    this.noise = new SimplexNoise(this.map.seed);
    this.size = WORLD_SIZE;
    this.n = GRID;
    this.cell = WORLD_SIZE / GRID;
    this.half = WORLD_SIZE / 2;
    this.stride = 1; // mesh / collision sampling stride (set from quality)
    this.h = new Float32Array((GRID + 1) * (GRID + 1));
    this.generate();
    this.airfields = [];
    this.city = null;
    this.placeSites();
  }

  /* ---------------- noise helpers ---------------- */
  fbm(x, z, oct) {
    let a = 1, f = 1, s = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += this.noise.noise2D(x * f + i * 17.1, z * f - i * 9.3) * a;
      norm += a; a *= 0.5; f *= 2.03;
    }
    return s / norm;
  }

  ridged(x, z, oct) {
    let a = 1, f = 1, s = 0, norm = 0, prev = 1;
    for (let i = 0; i < oct; i++) {
      let r = 1 - Math.abs(this.noise.noise2D(x * f - i * 13.7, z * f + i * 21.9));
      r *= r;
      s += r * a * prev;
      prev = r;
      norm += a; a *= 0.5; f *= 2.1;
    }
    return s / norm;
  }

  /** Raw procedural height before airfield flattening (the map's shape function). */
  rawHeight(x, z) { return this.map.shape(this, x, z); }

  generate() {
    const N = this.n, c = this.cell, half = this.half, h = this.h;
    for (let j = 0; j <= N; j++) {
      const z = j * c - half;
      for (let i = 0; i <= N; i++) {
        h[j * (N + 1) + i] = this.rawHeight(i * c - half, z);
      }
    }
  }

  /* ---------------- sampling ---------------- */
  /** grid value with clamping */
  at(i, j) {
    const N = this.n;
    if (i < 0) i = 0; else if (i > N) i = N;
    if (j < 0) j = 0; else if (j > N) j = N;
    return this.h[j * (N + 1) + i];
  }

  /**
   * Terrain height at world (x,z). Triangle-accurate against the render mesh
   * (same grid stride, same diagonal). Outside the world it is sea floor.
   */
  height(x, z) {
    const s = this.stride, cs = this.cell * s;
    const gx = (x + this.half) / cs, gz = (z + this.half) / cs;
    const M = this.n / s;
    if (gx < 0 || gz < 0 || gx >= M || gz >= M) return SEA_FLOOR;
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const N1 = this.n + 1;
    const r0 = iz * s * N1, r1 = (iz + 1) * s * N1;
    const h00 = this.h[r0 + ix * s], h10 = this.h[r0 + (ix + 1) * s];
    const h01 = this.h[r1 + ix * s], h11 = this.h[r1 + (ix + 1) * s];
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Approximate surface normal (unnormalised y=1 form): returns slope magnitude (rise/run). */
  slope(x, z) {
    const e = this.cell * this.stride;
    const dx = (this.height(x + e, z) - this.height(x - e, z)) / (2 * e);
    const dz = (this.height(x, z + e) - this.height(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }

  /**
   * Surface under (x,z): fills out = { y, water, runway, slope }. Runways, taxiways
   * and aprons are hard level surfaces. Shared by the game and the node tests.
   */
  ground(x, z, out) {
    const h = this.height(x, z);
    out.water = h <= 0.2;
    out.y = out.water ? 0 : h;
    out.runway = false;
    out.slope = out.water ? 0 : this.slope(x, z);
    for (let i = 0; i < this.airfields.length; i++) {
      const a = this.airfields[i];
      const dx = x - a.x, dz = z - a.z;
      if (Math.abs(dx) > a.length || Math.abs(dz) > a.length) continue;
      const along = dx * a.dirX + dz * a.dirZ, lat = dx * -a.dirZ + dz * a.dirX;
      if (Math.abs(along) < a.length / 2 + 30 && lat > -a.width / 2 && lat < 360) {
        out.y = a.y + 0.3; out.slope = 0; out.water = false;
        out.runway = Math.abs(lat) < a.width / 2 || lat > 60;
        break;
      }
    }
    return out;
  }

  /** Forest density 0..1 (shared by the terrain shader map and tree placement). */
  forest(x, z, h) {
    const fo = this.map.forest;
    if (h < fo.hMin || h > fo.hMax) return 0;
    const n = this.noise.noise2D(x / 1900 + 200, z / 1900 - 100) * 0.7
      + this.noise.noise2D(x / 520 - 50, z / 520 + 80) * 0.3;
    let f = smoothstep(-0.12 + fo.bias, 0.25 + fo.bias, n);
    f *= smoothstep(fo.hMin, fo.hMin + 12, h) * smoothstep(fo.hMax, fo.hMax * 0.62, h);
    f *= smoothstep(0.55, 0.3, this.slope(x, z));
    // keep airfields & city clear
    for (const a of this.airfields) f *= smoothstep(900, 1700, this.distToStrip(a, x, z));
    if (this.city) f *= smoothstep(this.city.r * 0.9, this.city.r * 1.3, Math.hypot(x - this.city.x, z - this.city.z));
    return f;
  }

  /** Distance from (x,z) to an airfield's runway centreline segment. */
  distToStrip(a, x, z) {
    const dx = x - a.x, dz = z - a.z;
    const along = dx * a.dirX + dz * a.dirZ;
    const cl = Math.max(-a.length / 2, Math.min(a.length / 2, along));
    return Math.hypot(dx - a.dirX * cl, dz - a.dirZ * cl);
  }

  /* ---------------- airfields & city ---------------- */
  placeSites() {
    const c = this.cell, N = this.n, half = this.half;
    const L = 2600, HW = 160;
    const cands = [];
    const step = 6;
    for (let j = 24; j <= N - 24; j += step) {
      for (let i = 24; i <= N - 24; i += step) {
        const h0 = this.at(i, j);
        if (h0 < 5 || h0 > 150) continue;
        const x = i * c - half, z = j * c - half;
        for (let k = 0; k < 8; k++) {
          const hdg = k * Math.PI / 8;
          const dirX = Math.sin(hdg), dirZ = -Math.cos(hdg);
          let mn = 1e9, mx = -1e9, sum = 0, cnt = 0;
          for (let a = -L / 2 - 300; a <= L / 2 + 300; a += 160) {
            for (let w = -HW * 2; w <= HW * 2; w += HW) {
              const hh = this.sampleRaw(x + dirX * a - dirZ * w, z + dirZ * a + dirX * w);
              if (hh < mn) mn = hh; if (hh > mx) mx = hh;
              sum += hh; cnt++;
            }
          }
          if (mn < 2.5) continue;
          const mean = sum / cnt;
          // obstacle clearance on both approaches (3 deg glide = 0.052)
          let obst = 0;
          for (const sgn of [-1, 1]) {
            for (let a = 400; a <= 9000; a += 300) {
              const px = x + dirX * sgn * (L / 2 + a), pz = z + dirZ * sgn * (L / 2 + a);
              const hh = Math.max(this.sampleRaw(px, pz), 0);
              obst = Math.max(obst, (hh - mean) / a);
            }
          }
          const score = (mx - mn) + Math.max(0, obst - 0.028) * 4000 + mean * 0.15;
          cands.push({ x, z, heading: hdg, dirX, dirZ, y: mean, score });
        }
      }
    }
    cands.sort((a, b) => a.score - b.score);
    const picked = [];
    const minSep = [0, 15000, 11000];
    for (const cnd of cands) {
      const need = minSep[picked.length];
      if (picked.every(p => Math.hypot(p.x - cnd.x, p.z - cnd.z) > need)) {
        picked.push(cnd);
        if (picked.length === 3) break;
      }
    }
    const names = this.map.fields;
    const roles = ['home', 'civil', 'enemy'];
    picked.forEach((p, idx) => {
      const a = {
        name: names[idx], role: roles[idx], x: p.x, z: p.z, y: Math.max(Math.round(p.y), 6),
        heading: p.heading, dirX: p.dirX, dirZ: p.dirZ, length: L, width: 60,
      };
      this.airfields.push(a);
      this.flattenStrip(a);
    });

    // city: flattest low ground 2.5–6 km from the civil airport
    const civ = this.airfields[1] || this.airfields[0];
    let best = null;
    for (let ang = 0; ang < Math.PI * 2; ang += Math.PI / 10) {
      for (let r = 2600; r <= 6000; r += 600) {
        const x = civ.x + Math.cos(ang) * r, z = civ.z + Math.sin(ang) * r;
        if (this.distToStrip(civ, x, z) < 1900) continue;
        if (this.airfields.some(a => Math.abs((x - a.x) * -a.dirZ + (z - a.z) * a.dirX) < 900
          && Math.hypot(x - a.x, z - a.z) < 7000)) continue; // keep approaches clear
        let mn = 1e9, mx = -1e9, wet = 0;
        for (let dx = -1000; dx <= 1000; dx += 250) for (let dz = -1000; dz <= 1000; dz += 250) {
          const hh = this.height(x + dx, z + dz);
          if (hh < 3) wet++;
          if (hh < mn) mn = hh; if (hh > mx) mx = hh;
        }
        const score = (mx - mn) + wet * 12;
        if (!best || score < best.score) best = { x, z, score, y: Math.max((mn + mx) / 2, 8) };
      }
    }
    if (best) {
      this.city = { name: this.map.city, x: best.x, z: best.z, y: Math.round(best.y), r: 1150 };
      this.flattenDisc(this.city.x, this.city.z, this.city.r, this.city.y, 700, 0.9);
    }
  }

  sampleRaw(x, z) {
    const gx = (x + this.half) / this.cell, gz = (z + this.half) / this.cell;
    if (gx < 0 || gz < 0 || gx > this.n || gz > this.n) return SEA_FLOOR;
    return this.at(Math.round(gx), Math.round(gz));
  }

  flattenStrip(a) {
    const c = this.cell, N = this.n, half = this.half;
    const flatR = 420, blend = 900;
    for (let j = 0; j <= N; j++) {
      const z = j * c - half;
      if (Math.abs(z - a.z) > a.length) continue;
      for (let i = 0; i <= N; i++) {
        const x = i * c - half;
        if (Math.abs(x - a.x) > a.length) continue;
        const dx = x - a.x, dz = z - a.z;
        const along = dx * a.dirX + dz * a.dirZ;
        const cl = Math.max(-a.length / 2 - 250, Math.min(a.length / 2 + 250, along));
        const d = Math.hypot(dx - a.dirX * cl, dz - a.dirZ * cl);
        const w = smoothstep(flatR + blend, flatR, d);
        if (w > 0) {
          const k = j * (N + 1) + i;
          this.h[k] = mix(this.h[k], a.y, w);
        }
      }
    }
  }

  flattenDisc(cx, cz, r, y, blend, strength) {
    const c = this.cell, N = this.n, half = this.half;
    for (let j = 0; j <= N; j++) {
      const z = j * c - half;
      if (Math.abs(z - cz) > r + blend) continue;
      for (let i = 0; i <= N; i++) {
        const x = i * c - half;
        const d = Math.hypot(x - cx, z - cz);
        const w = smoothstep(r + blend, r, d) * strength;
        if (w > 0) {
          const k = j * (N + 1) + i;
          this.h[k] = mix(this.h[k], y, w);
        }
      }
    }
  }
}
