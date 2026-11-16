// Minimal 2D Simplex noise (self-contained, seeded) — used for terrain generation.
export class SimplexNoise {
  constructor(seed = Math.random()) {
    this.p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) this.p[i] = i;
    // seeded shuffle
    let s = Math.floor(seed * 65536) || 1;
    for (let i = 255; i > 0; i--) {
      s = (s * 16807) % 2147483647;
      const j = s % (i + 1);
      [this.p[i], this.p[j]] = [this.p[j], this.p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = this.p[i & 255];
  }

  noise2D(xin, yin) {
    const grad = SimplexNoise.grad3;
    const perm = this.perm;
    const F2 = 0.5 * (Math.sqrt(3) - 1);
    const G2 = (3 - Math.sqrt(3)) / 6;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - j1 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      const gi0 = (perm[ii + perm[jj]] % 8) * 2;
      t0 *= t0;
      n0 = t0 * t0 * (grad[gi0] * x0 + grad[gi0 + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      const gi1 = (perm[ii + i1 + perm[jj + j1]] % 8) * 2;
      t1 *= t1;
      n1 = t1 * t1 * (grad[gi1] * x1 + grad[gi1 + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      const gi2 = (perm[ii + 1 + perm[jj + 1]] % 8) * 2;
      t2 *= t2;
      n2 = t2 * t2 * (grad[gi2] * x2 + grad[gi2 + 1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }
}
SimplexNoise.grad3 = [1,1, -1,1, 1,-1, -1,-1, 1,0, -1,0, 0,1, 0,-1];
