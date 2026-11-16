// LightBake.js — precomputed terrain lighting from the heightfield. Pure JS (no three.js / DOM).
//
//   bakeTerrainLight(hf, sunDir, R) → Uint8Array(R*R*4)
//     R  sun visibility: mountains cast long soft shadows across valleys and fjords
//     G  sky visibility (ambient occlusion): valley floors and gullies get less skylight
//     B  shadow ceiling height / 10 m: anything flying below it is in the mountain's shadow; A 255
//
// Texel (i, j) is centred on world x = -half + (i + 0.5) * size / R (same for z).
// The sun shadow is a single sweep over the grid (O(R²)): each texel inherits the "shadow
// ceiling" of its neighbour towards the sun, lowered by the sun's slope over one step, and is
// in shadow while the ground is below that ceiling. Sea counts as level 0.
// The occlusion term does not depend on the sun, so it is cached on the heightfield.

const AO_STEP = 2;                       // occlusion is computed on every 2nd grid point
const AO_DIST = [1, 2, 4, 8, 16];        // sample distances, in AO grid cells (156 m … 2.5 km)
const AO_DIRS = 8;

function skyVisibility(hf) {
  if (hf._ao) return hf._ao;
  const N = hf.n, n = N / AO_STEP + 1, cs = hf.cell * AO_STEP;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = Math.max(hf.h[j * AO_STEP * (N + 1) + i * AO_STEP], 0);
  const out = new Float32Array(n * n);
  const dirs = [];
  for (let k = 0; k < AO_DIRS; k++) { const a = k * Math.PI * 2 / AO_DIRS; dirs.push([Math.cos(a), Math.sin(a)]); }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const h0 = h[j * n + i];
    let occ = 0;
    for (let k = 0; k < AO_DIRS; k++) {
      const dx = dirs[k][0], dz = dirs[k][1];
      let t = 0;
      for (let s = 0; s < AO_DIST.length; s++) {
        const d = AO_DIST[s];
        let x = Math.round(i + dx * d), z = Math.round(j + dz * d);
        if (x < 0) x = 0; else if (x >= n) x = n - 1;
        if (z < 0) z = 0; else if (z >= n) z = n - 1;
        const tt = (h[z * n + x] - h0) / (d * cs);
        if (tt > t) t = tt;
      }
      occ += t / Math.sqrt(1 + t * t);          // sine of the horizon angle in this direction
    }
    out[j * n + i] = Math.pow(1 - occ / AO_DIRS, 1.6);
  }
  hf._ao = { n, data: out };
  return hf._ao;
}

export function bakeTerrainLight(hf, sunDir, R = 1024) {
  const N = hf.n, N1 = N + 1, texel = hf.size / R;
  // heights at texel centres (bilinear), sea clamped to 0
  const H = new Float32Array(R * R);
  for (let j = 0; j < R; j++) {
    const gz = Math.min((j + 0.5) * N / R, N - 1e-4), jz = Math.floor(gz), fz = gz - jz;
    for (let i = 0; i < R; i++) {
      const gx = Math.min((i + 0.5) * N / R, N - 1e-4), ix = Math.floor(gx), fx = gx - ix;
      const a = hf.h[jz * N1 + ix], b = hf.h[jz * N1 + ix + 1], c = hf.h[(jz + 1) * N1 + ix], d = hf.h[(jz + 1) * N1 + ix + 1];
      const v = a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fz;
      H[j * R + i] = v > 0 ? v : 0;
    }
  }
  const out = new Uint8Array(R * R * 4);
  // --- sun shadow sweep ---
  const sx = sunDir.x, sz = sunDir.z, hl = Math.hypot(sx, sz);
  const S = new Float32Array(R * R).fill(-1e9);
  if (hl > 1e-3 && sunDir.y > 0) {
    const tanE = sunDir.y / hl;
    const xMajor = Math.abs(sx) >= Math.abs(sz);
    const major = xMajor ? sx : sz, minor = xMajor ? sz : sx;
    const sgn = major > 0 ? 1 : -1, k = minor / Math.abs(major);
    const drop = tanE * texel * Math.sqrt(1 + k * k);
    // a(i) walks the major axis away from the sun; b is the minor axis
    for (let n = 1; n < R; n++) {
      const a = sgn > 0 ? R - 1 - n : n, as = a + sgn;
      for (let b = 0; b < R; b++) {
        let bf = b + k; if (bf < 0) bf = 0; else if (bf > R - 1) bf = R - 1;
        const b0 = Math.floor(bf), b1 = b0 < R - 1 ? b0 + 1 : b0, t = bf - b0;
        const i0 = xMajor ? b0 * R + as : as * R + b0, i1 = xMajor ? b1 * R + as : as * R + b1;
        const v0 = H[i0] > S[i0] ? H[i0] : S[i0], v1 = H[i1] > S[i1] ? H[i1] : S[i1];
        S[xMajor ? b * R + a : a * R + b] = v0 + (v1 - v0) * t - drop;
      }
    }
    const w = Math.max(drop * 2.5, 7);            // penumbra width, metres of ceiling height
    for (let i = 0; i < R * R; i++) {
      const lit = 0.5 - (S[i] - H[i]) / w;
      out[i * 4] = lit <= 0 ? 0 : lit >= 1 ? 255 : Math.round(lit * lit * (3 - 2 * lit) * 255);
      const c = S[i] / 10;                          // shadow ceiling, 10 m steps (0 … 2550 m)
      out[i * 4 + 2] = c <= 0 ? 0 : c >= 255 ? 255 : Math.round(c);
    }
  } else {
    for (let i = 0; i < R * R; i++) out[i * 4] = 255;
  }
  // --- sky visibility, upsampled from the coarse grid ---
  const ao = skyVisibility(hf), an = ao.n, A = ao.data;
  for (let j = 0; j < R; j++) {
    const gz = Math.min((j + 0.5) * (an - 1) / R, an - 1.001), jz = Math.floor(gz), fz = gz - jz;
    for (let i = 0; i < R; i++) {
      const gx = Math.min((i + 0.5) * (an - 1) / R, an - 1.001), ix = Math.floor(gx), fx = gx - ix;
      const a = A[jz * an + ix], b = A[jz * an + ix + 1], c = A[(jz + 1) * an + ix], d = A[(jz + 1) * an + ix + 1];
      const o = (j * R + i) * 4;
      out[o + 1] = Math.round((a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fz) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}
