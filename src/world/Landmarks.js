// Landmarks.js — the recognisable buildings and bridges of the real-world maps (Maps.js
// `landmarks`). Every landmark is built from primitives into a few merged meshes (one per
// material for the whole map), and reports solid collision boxes in the same shape as city
// buildings, so `Environment.buildingAt()` stops aircraft on them (they can't be destroyed).
//
// Landmark frame: origin on the ground at `at`, y up, local -z pointing along heading `rot`
// (degrees clockwise from north). Bridges use `hdg` for their span direction and sit on the water.
import * as THREE from 'three';

const D2R = Math.PI / 180;

/** Accumulates transformed, vertex-coloured triangles; one merged BufferGeometry per material. */
class Batch {
  constructor() { this.pos = []; this.nor = []; this.col = []; this.uv = []; }
  add(geo, m, hex) {
    const g = (geo.index ? geo.toNonIndexed() : geo.clone()).applyMatrix4(m);
    const p = g.attributes.position.array, n = g.attributes.normal.array, uv = g.attributes.uv;
    const c = new THREE.Color(hex);
    for (let i = 0; i < p.length; i++) { this.pos.push(p[i]); this.nor.push(n[i]); }
    for (let i = 0; i < p.length / 3; i++) { this.col.push(c.r, c.g, c.b); this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0); }
    g.dispose();
  }
  geometry() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);           // base on y = 0
const CYL = (seg) => new THREE.CylinderGeometry(1, 1, 1, seg).translate(0, 0.5, 0);
const CYL8 = CYL(8), CYL16 = CYL(16), CYL4 = CYL(4).rotateY(Math.PI / 4);
const SPH = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);   // dome (upper half)
const CONE = (seg) => new THREE.ConeGeometry(1, 1, seg).translate(0, 0.5, 0);
const CONE8 = CONE(8), CONE4 = CONE(4).rotateY(Math.PI / 4);
const PRISM = (() => {                                                       // gable roof, ridge along z, base y = 0
  const s = new THREE.Shape(); s.moveTo(-0.5, 0); s.lineTo(0, 1); s.lineTo(0.5, 0); s.closePath();
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5);
})();

/** One World Trade Center's shaft: a square base whose top square is turned 45 deg (an antiprism,
 *  octagonal at mid-height). b / t: half side at the foot / half diagonal-ish of the top, h: height. */
function antiprism(b, t, h) {
  const c = t * Math.SQRT2;
  const B = [[-b, -b], [b, -b], [b, b], [-b, b]], T = [[0, -c], [c, 0], [0, c], [-c, 0]];
  const v = [];
  const tri = (a, b2, c2) => v.push(...a, ...b2, ...c2);
  for (let i = 0; i < 4; i++) {
    const b0 = [B[i][0], 0, B[i][1]], b1 = [B[(i + 1) % 4][0], 0, B[(i + 1) % 4][1]];
    const t0 = [T[i][0], h, T[i][1]], t1 = [T[(i + 1) % 4][0], h, T[(i + 1) % 4][1]];
    tri(b0, t0, b1);                                  // T[i] stands over B's edge i
    tri(t0, t1, b1);
  }
  tri([T[0][0], h, T[0][1]], [T[2][0], h, T[2][1]], [T[1][0], h, T[1][1]]);
  tri([T[0][0], h, T[0][1]], [T[3][0], h, T[3][1]], [T[2][0], h, T[2][1]]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Lattice texture for the Eiffel Tower: cross-braced panels, open great arch at the foot. */
function latticeTexture() {
  const W = 128, H = 512, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.strokeStyle = '#fff'; g.fillStyle = '#fff';
  // corner legs (u near 0 and 1 of each face) and horizontal girders
  g.fillRect(0, 0, 12, H); g.fillRect(W - 12, 0, 12, H);
  const rows = 26;
  for (let r = 0; r <= rows; r++) { const y = H - (r / rows) * H; g.fillRect(0, y - 2, W, 4); }
  g.lineWidth = 2.5;
  for (let r = 0; r < rows; r++) {
    const y0 = H - (r / rows) * H, y1 = H - ((r + 1) / rows) * H;
    g.beginPath(); g.moveTo(0, y0); g.lineTo(W, y1); g.moveTo(W, y0); g.lineTo(0, y1); g.stroke();
  }
  // first platform girder band and the great arch under it (lower ~19 % of the height)
  const vArch = H * (1 - 0.13), vDeck = H * (1 - 0.19);
  g.fillRect(0, vDeck - 8, W, 16);
  g.globalCompositeOperation = 'destination-out';
  g.beginPath();
  g.moveTo(16, H); g.lineTo(16, H - 10);
  g.quadraticCurveTo(16, vArch, W / 2, vArch); g.quadraticCurveTo(W - 16, vArch, W - 16, H - 10);
  g.lineTo(W - 16, H); g.closePath(); g.fill();
  g.globalCompositeOperation = 'source-over';
  g.lineWidth = 5;
  g.beginPath(); g.moveTo(16, H - 10); g.quadraticCurveTo(16, vArch, W / 2, vArch); g.quadraticCurveTo(W - 16, vArch, W - 16, H - 10); g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

/**
 * Build every landmark of the current map. Returns { colliders, footprints } and adds the meshes
 * to env.group. Colliders are building-shaped boxes (x, z, hw, hd, ca, sa, y0, top) that can't break.
 */
export function buildLandmarks(env) {
  const hf = env.hf, list = env.map.landmarks || [], R = hf.real;
  const night = env.atmo.night || env.atmo.sunElev < 6;
  const stone = new Batch(), lit = new Batch(), glass = new Batch(), lattice = new Batch();
  const colliders = [], footprints = [];
  const M = new THREE.Matrix4(), L = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();

  for (const lm of list) {
    const [wx, wz] = R.ll(lm.at[0], lm.at[1]);
    const heading = (lm.hdg ?? lm.rot ?? 0) * D2R;
    // landmark frame → world
    const frame = new THREE.Matrix4().compose(new THREE.Vector3(wx, 0, wz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -heading, 0)), new THREE.Vector3(1, 1, 1));
    const ca = Math.cos(heading), sa = Math.sin(heading);
    const toWorld = (lx, lz) => [wx + lx * ca - lz * sa, wz + lx * sa + lz * ca];
    let gy = Math.max(hf.height(wx, wz), 0);
    if (lm.type !== 'suspension' && lm.type !== 'beam' && !lm.summit) {
      // stand on the lowest ground under the footprint so nothing floats on a slope
      for (const [dx, dz] of [[-20, -20], [20, -20], [20, 20], [-20, 20]]) gy = Math.min(gy, Math.max(hf.height(wx + dx, wz + dz), 0));
    }
    /** piece: geometry, local position (x, y above ground, z), scale, colour, batch, optional local rotation */
    const piece = (batch, geo, x, y, z, sx, sy, sz, hex, rx = 0, ry = 0, rz = 0) => {
      e.set(rx, ry, rz, 'XYZ'); q.setFromEuler(e); p.set(x, y + gy, z); s.set(sx, sy, sz);
      L.compose(p, q, s); M.multiplyMatrices(frame, L);
      batch.add(geo, M, hex);
    };
    /** solid box in the landmark frame (local centre x/z, half sizes, y range above ground) */
    const solid = (x, z, hw, hd, y0, y1, fp = true) => {
      const [cx, cz] = toWorld(x, z);
      colliders.push({ x: cx, z: cz, hw, hd, ca, sa, y0: y0 + gy, top: y1 + gy, top0: y1 + gy, style: 'landmark', floors: 99,
        hp: Infinity, hp0: Infinity, parts: [], state: 0, name: lm.name || lm.type, noShadow: !fp });
      if (fp) footprints.push({ x: cx, z: cz, hw: hw + 6, hd: hd + 6, ca, sa });
    };
    const box = (batch, x, y, z, w, h, d, hex) => piece(batch, BOX, x, y, z, w, h, d, hex);

    switch (lm.type) {
      case 'empire': {                                                        // 381 m roof, mast to 443 m
        const c = 0xb9b3a4;
        box(stone, 0, 0, 0, 129, 25, 61, c);
        box(stone, 0, 25, 0, 100, 60, 50, c);
        box(stone, 0, 85, 0, 58, 235, 40, 0xbdb7a8);
        box(stone, 0, 320, 0, 46, 20, 32, c); box(stone, 0, 340, 0, 34, 20, 24, c);
        box(lit, 0, 360, 0, 24, 21, 18, 0xd8d0b8);
        piece(lit, CYL8, 0, 381, 0, 7, 22, 7, 0xd8d0b8);
        piece(stone, CONE8, 0, 403, 0, 2.5, 40, 2.5, 0x9a9a9a);
        // pilaster stripes so the shaft reads as stone and windows, not a plain box
        for (let i = -3; i <= 3; i++) for (const z of [-20.3, 20.3]) box(stone, i * 8, 85, z, 1.6, 235, 0.6, 0x8d8679);
        solid(0, 0, 64, 30, 0, 85); solid(0, 0, 29, 20, 85, 381); solid(0, 0, 4, 4, 381, 443, false);
        break;
      }
      case 'chrysler': {                                                     // 319 m with its needle
        box(stone, 0, 0, 0, 62, 62, 62, 0xb7b2a8);
        box(stone, 0, 62, 0, 44, 120, 44, 0xbcb8b0);
        box(stone, 0, 182, 0, 36, 58, 36, 0xbcb8b0);
        // terraced stainless-steel crown: shrinking octagonal sun-ray tiers
        for (let i = 0; i < 6; i++) piece(lit, CONE8, 0, 240 + i * 7, 0, 18 - i * 2.6, 12, 18 - i * 2.6, 0xd6dadd);
        piece(lit, CONE8, 0, 282, 0, 2.2, 37, 2.2, 0xe2e6e8);
        solid(0, 0, 31, 31, 0, 62); solid(0, 0, 22, 22, 62, 282); solid(0, 0, 3, 3, 282, 319, false);
        break;
      }
      case 'onewtc': {                                                       // 417 m roof, spire to 541 m
        box(glass, 0, 0, 0, 61, 56, 61, 0x9eb0bc);
        piece(glass, antiprism(30.5, 21.5, 361), 0, 56, 0, 1, 1, 1, 0xa8c0d0);
        box(stone, 0, 417, 0, 34, 5, 34, 0x9aa2a8);
        piece(stone, CYL8, 0, 422, 0, 2, 119, 2, 0xd0d4d8);
        for (const y of [440, 480]) piece(stone, CYL16, 0, y, 0, 6, 2, 6, 0xb0b4b8);
        solid(0, 0, 30.5, 30.5, 0, 200); solid(0, 0, 25, 25, 200, 422); solid(0, 0, 3, 3, 422, 541, false);
        break;
      }
      case 'liberty': {                                                      // star fort, pedestal, 93 m to the torch
        piece(stone, CYL(11), 0, 0, 0, 72, 9, 72, 0xa8a090);
        piece(stone, CYL4, 0, 9, 0, 21, 8, 21, 0xb8b0a0);
        piece(stone, CYL4, 0, 17, 0, 15, 30, 15, 0xc8c0b0);
        const cu = 0x5ea893;
        piece(stone, CYL8, 0, 47, 0, 7.5, 3, 7.5, cu);
        piece(stone, new THREE.CylinderGeometry(3.6, 7, 28, 10).translate(0, 14, 0), 0, 50, 0, 1, 1, 1, cu);
        piece(stone, new THREE.SphereGeometry(3, 10, 8), 0, 81, 0, 1, 1.15, 1, cu);
        for (let i = 0; i < 7; i++) piece(stone, CONE4, 0, 82, 0, 0.5, 4, 0.5, cu, (i - 3) * 0.32, 0, 0.5);   // crown rays
        piece(stone, BOX, 3, 76, 0, 1.8, 15, 1.8, cu, 0, 0, -0.2);                // raised right arm
        piece(lit, CONE8, 6, 90, 0, 1.8, 4, 1.8, 0xe8c050);            // torch flame
        piece(stone, BOX, -4, 64, -2, 3, 5, 1, cu, 0.3);                         // tablet
        solid(0, 0, 21, 21, 0, 47); solid(0, 0, 7, 7, 47, 93, false);
        break;
      }
      case 'suspension': {
        const { span, len, ramp, deckH, towerH, col } = lm, W = 26, top = towerH;
        gy = 0;                                                                 // decks hang over the water
        box(stone, 0, deckH - 3, 0, W, 4, len, col);
        box(stone, 0, deckH + 1, 0, W - 2, 0.6, len, 0x3a3a3c);                 // road surface
        // approach ramps down to the ground at both ends
        for (const sg of [-1, 1]) {
          const [ex, ez] = toWorld(0, sg * (len / 2 + ramp));
          const gEnd = Math.max(hf.height(ex, ez), 1);
          const dy = deckH - gEnd, Lr = Math.hypot(ramp, dy), pitch = Math.atan2(dy, ramp) * sg;
          piece(stone, BOX, 0, gEnd + dy / 2 - 3, sg * (len / 2 + ramp / 2), W, 4, Lr, col, pitch);
          footprints.push({ ...(() => { const [cx, cz] = toWorld(0, sg * (len / 2 + ramp / 2)); return { x: cx, z: cz }; })(), hw: W / 2 + 8, hd: ramp / 2 + 10, ca, sa });
        }
        for (const sg of [-1, 1]) {
          const z = sg * span / 2;
          if (lm.stone) {                                                       // masonry tower with twin gothic arches
            box(stone, 0, 0, z, W + 16, deckH - 3, 16, col);
            for (const x of [-(W / 2 + 4), 0, W / 2 + 4]) box(stone, x, deckH - 3, z, x ? 8 : 6, top - deckH - 14, 14, col);
            box(stone, 0, top - 17, z, W + 16, 17, 15, col);
          } else {                                                              // steel towers: two legs and cross braces
            for (const x of [-(W / 2 + 3), W / 2 + 3]) box(stone, x, 0, z, 6, top, 8, col);
            for (const y of [deckH - 8, top * 0.72, top - 6]) box(stone, 0, y, z, W + 12, 5, 6, col);
          }
          for (const x of [-(W / 2 + 3), W / 2 + 3]) solid(x, z, 4, 6, 0, top);
        }
        // main cables (parabola between the tower tops) + back stays to the deck ends, and suspenders
        const cable = (x, z0, y0, z1, y1) => {
          const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy);
          piece(stone, BOX, x, (y0 + y1) / 2 - 0.4, (z0 + z1) / 2, 0.9, 0.9, l, 0x50555a, Math.atan2(-dy, dz));
        };
        const sag = (z) => deckH + 4 + (top - 2 - deckH - 4) * (2 * z / span) ** 2;
        for (const x of [-(W / 2 + 1), W / 2 + 1]) {
          const n = 20;
          for (let i = 0; i < n; i++) {
            const z0 = -span / 2 + span * i / n, z1 = z0 + span / n;
            cable(x, z0, sag(z0), z1, sag(z1));
          }
          for (const sg of [-1, 1]) cable(x, sg * span / 2, top - 2, sg * len / 2, deckH + 2);
          for (let z = -span / 2 + 30; z < span / 2 - 10; z += 30) box(stone, x, deckH + 1, z, 0.35, sag(z) - deckH - 1, 0.35, 0x50555a);
        }
        solid(0, 0, W / 2, len / 2, deckH - 4, deckH + 2, false);
        break;
      }
      case 'beam': {                                                          // a Paris bridge: find the river and span it
        let bx = wx, bz = wz, bestD = Infinity;
        for (let dz = -160; dz <= 160; dz += 20) for (let dx = -160; dx <= 160; dx += 20)
          if (R.at(wx + dx, wz + dz) === 0 && dx * dx + dz * dz < bestD) { bestD = dx * dx + dz * dz; bx = wx + dx; bz = wz + dz; }
        if (bestD === Infinity) break;
        // the shortest crossing over the water is square to the banks
        let best = null;
        for (let a = 0; a < 180; a += 6) {
          const dx = Math.sin(a * D2R), dz = -Math.cos(a * D2R);
          let t0 = 0, t1 = 0;
          while (t0 < 600 && hf.height(bx - dx * t0, bz - dz * t0) < 1.5) t0 += 8;
          while (t1 < 600 && hf.height(bx + dx * t1, bz + dz * t1) < 1.5) t1 += 8;
          if (!best || t0 + t1 < best.l) best = { a, l: t0 + t1, mid: (t1 - t0) / 2 };
        }
        const hd = best.a * D2R, dx = Math.sin(hd), dz = -Math.cos(hd);
        const cx = bx + dx * best.mid, cz = bz + dz * best.mid, half = best.l / 2 + 30;
        const yEnd = Math.max(hf.height(cx - dx * half, cz - dz * half), hf.height(cx + dx * half, cz + dz * half), 3) + 1.2;
        const fr = new THREE.Matrix4().compose(new THREE.Vector3(cx, 0, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -hd, 0)), new THREE.Vector3(1, 1, 1));
        const bp = (x, y, z, w, h, d, hex) => { p.set(x, y, z); s.set(w, h, d); q.identity(); L.compose(p, q, s); M.multiplyMatrices(fr, L); stone.add(BOX, M, hex); };
        bp(0, yEnd - 2.2, 0, 24, 2.2, half * 2, 0xc9bda2);
        for (const x of [-12.3, 12.3]) bp(x, yEnd, 0, 0.8, 1.1, half * 2, 0xb8ac92);              // parapets
        for (const z of [-best.l / 6, best.l / 6]) bp(0, -6, z, 20, yEnd + 3.8, 6, 0xb5a98e);       // piers
        const [ca2, sa2] = [Math.cos(hd), Math.sin(hd)];
        colliders.push({ x: cx, z: cz, hw: 12, hd: half, ca: ca2, sa: sa2, y0: yEnd - 4, top: yEnd + 1.1, top0: yEnd + 1.1, style: 'landmark',
          floors: 99, hp: Infinity, hp0: Infinity, parts: [], state: 0, name: 'bridge', noShadow: true });
        break;
      }
      case 'eiffel': {                                                       // 330 m wrought-iron lattice
        const hw = (y) => 3 + 59 * Math.pow(Math.max(0, 1 - y / 310), 2.4);
        const pts = [];
        for (let i = 0; i <= 40; i++) { const y = i / 40 * 300; pts.push(new THREE.Vector2(hw(y) * Math.SQRT2, y)); }
        const shell = new THREE.LatheGeometry(pts, 4, Math.PI / 4);
        const uv = shell.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * 4);              // one lattice tile per face
        piece(lattice, shell, 0, 0, 0, 1, 1, 1, 0x8a7458);
        const brown = 0x6e5c46;
        box(stone, 0, 55, 0, hw(57) * 2 + 6, 5, hw(57) * 2 + 6, brown);
        box(stone, 0, 113, 0, hw(115) * 2 + 4, 4, hw(115) * 2 + 4, brown);
        box(lit, 0, 272, 0, 16, 8, 16, 0xb09060);
        piece(stone, CYL8, 0, 280, 0, 2.2, 50, 2.2, 0x9a9a9a);
        for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) solid(x * 50, z * 50, 12, 12, 0, 55);
        solid(0, 0, hw(57) + 3, hw(57) + 3, 53, 60);
        solid(0, 0, hw(115), hw(115), 60, 180); solid(0, 0, hw(180), hw(180), 180, 300); solid(0, 0, 2, 2, 300, 330, false);
        footprints.push({ x: wx, z: wz, hw: 80, hd: 80, ca, sa });
        break;
      }
      case 'arc': {                                                          // 50 m, the big arch 14.6 m wide, 29 m tall
        const c = 0xd9ceb4;
        for (const x of [-15.2, 15.2]) box(stone, x, 0, 0, 15.2, 29, 22, c);
        box(stone, 0, 29, 0, 45, 21, 22, c);
        box(stone, 0, 44, 0, 46, 1.2, 23, 0xc4b89e);
        for (const x of [-15.2, 15.2]) solid(x, 0, 7.6, 11, 0, 29);
        solid(0, 0, 22.5, 11, 29, 50);
        footprints.push({ x: wx, z: wz, hw: 90, hd: 90, ca, sa });                     // the Etoile is a roundabout
        break;
      }
      case 'notredame': {                                                    // nave, transept, west towers, spire
        const c = 0xcfc4aa, lead = 0x5c6168;
        box(stone, 0, 0, 0, 14, 33, 120, c);
        piece(stone, PRISM, 0, 33, 0, 14, 10, 120, lead);
        box(stone, 0, 0, -10, 48, 33, 14, c);
        piece(stone, PRISM, 0, 33, -10, 14, 10, 48, lead, 0, Math.PI / 2);
        for (const x of [-11, 11]) box(stone, x, 0, 54, 14, 69, 14, c);
        box(stone, 0, 0, 54, 36, 45, 12, c);
        piece(stone, CONE8, 0, 43, -10, 3, 53, 3, lead);
        for (const x of [-11, 11]) solid(x, 54, 7, 7, 0, 69);
        solid(0, 0, 8, 60, 0, 43); solid(0, -10, 24, 7, 0, 43);
        break;
      }
      case 'sacrecoeur': {                                                   // white domes on top of Montmartre
        const c = 0xf2eee4;
        box(stone, 0, 0, 0, 34, 30, 80, c);
        piece(stone, CYL16, 0, 30, 0, 15, 22, 15, c);
        piece(stone, SPH, 0, 52, 0, 15, 20, 15, c);
        piece(stone, CYL8, 0, 72, 0, 3, 8, 3, c); piece(stone, CONE8, 0, 80, 0, 3.2, 6, 3.2, c);
        for (const [x, z] of [[-14, 22], [14, 22], [-14, -22], [14, -22]]) { piece(stone, CYL8, x, 30, z, 5, 8, 5, c); piece(stone, SPH, x, 38, z, 5, 7, 5, c); }
        box(stone, 0, 0, -48, 12, 84, 12, c);
        solid(0, 0, 17, 40, 0, 52); solid(0, 0, 15, 15, 52, 86); solid(0, -48, 6, 6, 0, 84);
        break;
      }
      case 'montparnasse': {
        piece(glass, CYL16, 0, 0, 0, 25, 210, 16, 0x2f2b28);
        piece(stone, CYL16, 0, 210, 0, 22, 2, 14, 0x55504a);
        solid(0, 0, 25, 16, 0, 212);
        break;
      }
      case 'grandearche': {                                                  // 110 m hollow cube
        const c = 0xeeeeea;
        for (const x of [-45, 45]) box(stone, x, 0, 0, 20, 110, 112, c);
        box(stone, 0, 92, 0, 70, 18, 112, c);
        box(stone, 0, 0, 0, 110, 4, 112, 0xd8d8d4);
        box(glass, 0, 4, 0, 70, 0.5, 70, 0xb0c4cc);
        for (const x of [-45, 45]) solid(x, 0, 10, 56, 0, 110);
        solid(0, 0, 35, 56, 92, 110);
        break;
      }
      case 'louvre': {                                                       // the palace wings round the Cour Napoléon, and the pyramid
        const c = 0xd7cbb0, zinc = 0x6a7480;
        const wing = (x, z0, z1, w = 26) => {
          box(stone, x, 0, (z0 + z1) / 2, w, 22, Math.abs(z1 - z0), c);
          piece(stone, PRISM, x, 22, (z0 + z1) / 2, w, 8, Math.abs(z1 - z0), zinc);
          solid(x, (z0 + z1) / 2, w / 2, Math.abs(z1 - z0) / 2, 0, 30);
        };
        wing(120, -120, 620); wing(-120, -120, 240);                          // Grande Galerie (along the Seine), Richelieu
        // Cour Carrée: a hollow square
        wing(80, -290, -130); wing(-80, -290, -130);
        const cross = (z) => { box(stone, 0, 0, z, 186, 22, 26, c); piece(stone, PRISM, 0, 22, z, 26, 8, 186, zinc, 0, Math.PI / 2); solid(0, z, 93, 13, 0, 30); };
        cross(-130); cross(-290);
        piece(glass, CONE4, 0, 0, 30, 25, 21.6, 25, 0xa8bcc4);
        for (const [x, z] of [[-34, 30], [34, 30], [0, -4]]) piece(glass, CONE4, x, 0, z, 5, 5, 5, 0xa8bcc4);
        footprints.push({ x: wx, z: wz, hw: 140, hd: 140, ca, sa });
        footprints.push({ ...(() => { const [x, z] = toWorld(0, 400); return { x, z }; })(), hw: 140, hd: 300, ca, sa });   // Tuileries
        break;
      }
      case 'invalides': {                                                    // the golden dome
        const c = 0xd8ceb6, gold = 0xc9a447;
        box(stone, 0, 0, 0, 60, 26, 60, c);
        piece(stone, CYL16, 0, 26, 0, 24, 22, 24, c);
        piece(lit, SPH, 0, 48, 0, 23, 30, 23, gold);
        piece(lit, CYL8, 0, 76, 0, 4, 12, 4, gold); piece(lit, CONE8, 0, 88, 0, 3, 19, 3, gold);
        box(stone, 0, 0, -110, 110, 20, 140, c);
        solid(0, 0, 30, 30, 0, 26); solid(0, 0, 24, 24, 26, 78); solid(0, -110, 55, 70, 0, 22);
        break;
      }
      /* ---------------- London ---------------- */
      case 'westminster': {                                                  // Palace of Westminster, Big Ben at the north end
        const c = 0xcdbf9c, lead = 0x5e6570;
        box(stone, 0, 0, 0, 70, 24, 265, c);
        piece(stone, PRISM, 0, 24, 0, 70, 9, 265, lead);
        for (let z = -110; z <= 110; z += 22) for (const x of [-35.5, 35.5]) box(stone, x, 0, z, 1.2, 28, 2, 0xb8aa88);   // buttresses
        // Victoria Tower (south) and the central spire
        box(stone, 0, 0, 120, 23, 90, 23, c);
        for (const [x, z] of [[-10, 110], [10, 110], [-10, 130], [10, 130]]) piece(stone, CONE8, x, 90, z, 1.6, 10, 1.6, c);
        piece(stone, CYL8, 0, 24, 0, 9, 40, 9, c); piece(stone, CONE8, 0, 64, 0, 7, 27, 7, lead);
        // Elizabeth Tower: shaft, lit clock stage, belfry, iron spire
        const bz = -150;
        box(stone, 0, 0, bz, 12, 55, 12, c);
        box(lit, 0, 55, bz, 13, 13, 13, 0xe8dcb8);
        box(stone, 0, 68, bz, 11, 9, 11, c);
        piece(stone, CONE4, 0, 77, bz, 8.5, 15, 8.5, 0x4a5058);
        piece(lit, CYL8, 0, 92, bz, 0.6, 4, 0.6, 0xd8c070);
        solid(0, 0, 35, 132, 0, 33); solid(0, 120, 11.5, 11.5, 0, 100); solid(0, 0, 9, 9, 33, 91); solid(0, bz, 6.5, 6.5, 0, 96);
        footprints.push({ ...(() => { const [x, z] = toWorld(0, bz); return { x, z }; })(), hw: 40, hd: 40, ca, sa });
        break;
      }
      case 'londoneye': {                                                    // 120 m wheel on an A-frame, 32 capsules
        const R0 = 60, ay = 75, w = 0xe8ecf0;
        piece(stone, new THREE.TorusGeometry(R0, 1.1, 6, 64), 0, ay, 0, 1, 1, 1, w);
        piece(stone, new THREE.TorusGeometry(R0 - 4, 0.6, 4, 64), 0, ay, 0, 1, 1, 1, w);
        for (let i = 0; i < 16; i++) piece(stone, BOX, 0, ay, 0, 0.35, R0, 0.35, 0xcfd4d8, 0, 0, i * Math.PI / 8);
        for (let i = 0; i < 32; i++) {
          const a = i / 32 * Math.PI * 2;
          piece(lit, new THREE.SphereGeometry(1, 8, 6), Math.cos(a) * (R0 + 2.5), ay + Math.sin(a) * (R0 + 2.5), 0, 4, 2.6, 2.6, 0xd8e8f4);
        }
        piece(stone, CYL8, 0, ay, 0, 3, 8, 3, 0x9aa0a6, Math.PI / 2);
        for (const sg of [-1, 1]) piece(stone, BOX, 0, 0, sg * 22, 2.5, ay * 1.08, 2.5, 0xc8ccd0, sg * -0.29);      // A-frame legs
        solid(0, 0, R0 + 4, 3, ay - R0 - 4, ay + R0 + 4, false);
        break;
      }
      case 'towerbridge': {                                                  // two gothic towers, high walkways, bascules, side chains
        const c = 0xcdc3ad, blue = 0x5d93c4, sp = 31;
        box(stone, 0, 7, 0, 12, 2, 260, 0x7a8590);                         // road deck
        for (const sg of [-1, 1]) {
          const z = sg * sp;
          box(stone, 0, -6, z, 22, 6, 30, c);                              // pier
          box(stone, 0, 0, z, 18, 50, 18, c);
          for (const [x, zz] of [[-8, -8], [8, -8], [8, 8], [-8, 8]]) { box(stone, x, 50, z + zz, 4, 8, 4, c); piece(stone, CONE4, x, 58, z + zz, 3.2, 7, 3.2, 0x58606a); }
          piece(stone, CONE4, 0, 50, z, 10, 14, 10, 0x58606a);
          // side spans: suspension chains from the tower to the shore
          for (const x of [-7, 7]) {
            const n = 6;
            for (let i = 0; i < n; i++) {
              const z0 = z + sg * (9 + i * 12), z1 = z0 + sg * 12, y0 = 40 - i * 5, y1 = 40 - (i + 1) * 5;
              const dz = z1 - z0, dy = y1 - y0, l = Math.hypot(dz, dy);
              piece(stone, BOX, x, (y0 + y1) / 2, (z0 + z1) / 2, 1.2, 1.4, l, blue, Math.atan2(-dy, dz));
            }
          }
          solid(0, z, 9, 9, 0, 66);
        }
        for (const x of [-6, 6]) box(stone, x, 42, 0, 3, 4, sp * 2 - 18, blue);  // the two high-level walkways
        solid(0, 0, 6, sp - 9, 41, 46, false); solid(0, 0, 6, 130, 5, 9, false);
        break;
      }
      case 'shard': {                                                        // 310 m glass pyramid
        piece(glass, CONE4, 0, 0, 0, 42, 310, 34, 0xa9bccb);
        solid(0, 0, 28, 23, 0, 100); solid(0, 0, 18, 15, 100, 200); solid(0, 0, 8, 7, 200, 310, false);
        break;
      }
      case 'stpauls': {                                                      // Wren's dome, 111 m
        const c = 0xd6cebb, lead = 0x7c8288;
        box(stone, 0, 0, 0, 37, 30, 150, c); box(stone, 0, 0, -5, 75, 30, 34, c);
        piece(stone, PRISM, 0, 30, 0, 37, 8, 150, lead);
        piece(stone, CYL16, 0, 30, -5, 21, 36, 21, c);
        piece(stone, SPH, 0, 66, -5, 18, 26, 18, lead);
        piece(stone, CYL8, 0, 92, -5, 3.5, 12, 3.5, c); piece(lit, CONE8, 0, 104, -5, 2.5, 7, 2.5, 0xd8c070);
        for (const x of [-15, 15]) { box(stone, x, 0, 70, 10, 54, 10, c); piece(stone, CONE8, x, 54, 70, 4, 10, 4, lead); }
        solid(0, 0, 18.5, 75, 0, 38); solid(0, -5, 37, 17, 0, 30); solid(0, -5, 18, 18, 30, 111);
        break;
      }
      case 'gherkin': {
        const pts = [[24.5, 0], [27, 30], [28, 60], [27, 90], [23, 120], [16, 150], [8, 170], [0.5, 180]].map(([r, y]) => new THREE.Vector2(r, y));
        piece(glass, new THREE.LatheGeometry(pts, 20), 0, 0, 0, 1, 1, 1, 0x4d6f80);
        solid(0, 0, 22, 22, 0, 120); solid(0, 0, 12, 12, 120, 180, false);
        break;
      }
      case 'battersea': {                                                    // brick power station, four white chimneys
        const brick = 0x8c4c3a;
        box(stone, 0, 0, 0, 48, 50, 160, brick);
        for (const x of [-24, 24]) for (const z of [-72, 72]) { box(stone, x, 0, z, 12, 52, 12, brick); piece(stone, new THREE.CylinderGeometry(3.6, 4.6, 51, 12).translate(0, 25.5, 0), x, 52, z, 1, 1, 1, 0xf0eee8); }
        solid(0, 0, 30, 80, 0, 52); for (const x of [-24, 24]) for (const z of [-72, 72]) solid(x, z, 4.6, 4.6, 52, 103, false);
        break;
      }
      case 'o2': {                                                           // the Millennium Dome
        piece(stone, SPH, 0, 0, 0, 182, 50, 182, 0xeeeeea);
        for (let i = 0; i < 12; i++) {
          const a = i / 12 * Math.PI * 2;
          piece(stone, CYL8, Math.cos(a) * 105, 0, Math.sin(a) * 105, 1.4, 100, 1.4, 0xe2c022, Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12);
        }
        solid(0, 0, 130, 130, 0, 40); solid(0, 0, 70, 70, 40, 50);
        footprints.push({ x: wx, z: wz, hw: 200, hd: 200, ca, sa });
        break;
      }
      /* ---------------- Rio de Janeiro ---------------- */
      case 'christ': {                                                       // Christ the Redeemer on Corcovado, 38 m with pedestal
        const c = 0xe9e6dc;
        box(stone, 0, -6, 0, 16, 6, 16, 0xb0aaa0);                           // summit platform
        box(stone, 0, 0, 0, 8, 8, 8, c);
        piece(lit, new THREE.CylinderGeometry(2.4, 3.8, 22, 10).translate(0, 11, 0), 0, 8, 0, 1, 1, 1, c);
        box(lit, 0, 26.5, 0, 28, 2.6, 2.4, c);                               // the outstretched arms
        piece(lit, new THREE.SphereGeometry(1.7, 10, 8), 0, 31.5, 0, 1, 1.15, 1, c);
        solid(0, 0, 4, 4, 0, 33); solid(0, 0, 14, 1.5, 25, 29.5, false);
        break;
      }
      case 'cable': {                                                        // Sugarloaf cable car: stations and sagging cables
        const st = lm.stops.map(([la, lo]) => { const [x, z] = R.ll(la, lo); return [x, Math.max(hf.height(x, z), 0), z]; });
        const toLocal = (x, z) => { const dx = x - wx, dz = z - wz; return [dx * ca + dz * sa, -dx * sa + dz * ca]; };
        gy = 0;
        for (const [x, y, z] of st) { const [lx, lz] = toLocal(x, z); box(stone, lx, y - 2, lz, 18, 14, 14, 0xd8d4c8); }
        for (let k = 0; k + 1 < st.length; k++) {
          const [x0, y0, z0] = st[k], [x1, y1, z1] = st[k + 1], n = 16;
          for (const off of [-2, 2]) for (let i = 0; i < n; i++) {
            const t0 = i / n, t1 = (i + 1) / n, sag = (t) => 4 * t * (1 - t) * 18;
            const [ax, az] = toLocal(x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0), [bx, bz] = toLocal(x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1);
            const ay = y0 + 10 + (y1 - y0) * t0 - sag(t0), by = y0 + 10 + (y1 - y0) * t1 - sag(t1);
            const dx = bx - ax, dz = bz - az, dy = by - ay, lh = Math.hypot(dx, dz);
            e.set(Math.atan2(-dy, lh), Math.atan2(dx, dz), 0, 'YXZ'); q.setFromEuler(e);
            p.set((ax + bx) / 2 + off, (ay + by) / 2, (az + bz) / 2); s.set(0.4, 0.4, Math.hypot(lh, dy));
            L.compose(p, q, s); M.multiplyMatrices(frame, L); stone.add(BOX, M, 0x303236);
            if (i === 7 && off > 0) { p.y -= 4; s.set(3, 3, 4); L.compose(p, q, s); M.multiplyMatrices(frame, L); lit.add(BOX, M, 0xe0ddd0); }
          }
        }
        break;
      }
      case 'causeway': {                                                     // the 13 km Rio–Niterói bridge, 72 m over the shipping lane
        gy = 0;
        const pts = lm.path.map(([la, lo]) => R.ll(la, lo));
        let tot = 0; const segL = [];
        for (let k = 0; k + 1 < pts.length; k++) { const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]); segL.push(l); tot += l; }
        const yAt = (d) => {
          const ends = Math.min(1, Math.min(d, tot - d) / 900);
          const g0 = Math.max(hf.height(...(d < tot / 2 ? pts[0] : pts[pts.length - 1])), 2);
          const bump = Math.exp(-((((d / tot) - lm.peak) / 0.035) ** 2));
          return g0 + (lm.deckH + (lm.topH - lm.deckH) * bump - g0) * (ends * ends * (3 - 2 * ends));
        };
        let d0 = 0;
        for (let k = 0; k < segL.length; k++) {
          const [ax, az] = pts[k], [bx, bz] = pts[k + 1], hd = Math.atan2(bx - ax, -(bz - az));
          const cs = Math.cos(hd), sn = Math.sin(hd), n = Math.ceil(segL[k] / 70);
          for (let i = 0; i < n; i++) {
            const t = (i + 0.5) / n, d = d0 + segL[k] * t, x = ax + (bx - ax) * t, z = az + (bz - az) * t, y = yAt(d), y2 = yAt(d + 35), y1 = yAt(d - 35);
            const pitch = Math.atan2(y2 - y1, 70);
            const fr = new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -hd, 0)), new THREE.Vector3(1, 1, 1));
            e.set(pitch, 0, 0); q.setFromEuler(e); p.set(0, y - 3.5, 0); s.set(26, 3.5, segL[k] / n + 0.5);
            L.compose(p, q, s); M.multiplyMatrices(fr, L); stone.add(BOX, M, 0xb8b4aa);
            if (hf.height(x, z) < 0) { q.identity(); p.set(0, -10, 0); s.set(7, y + 6.5, 5); L.compose(p, q, s); M.multiplyMatrices(fr, L); stone.add(BOX, M, 0xa8a49a); }
            colliders.push({ x, z, hw: 13, hd: segL[k] / n / 2 + 1, ca: cs, sa: sn, y0: y - 4, top: y + 0.5, top0: y + 0.5, style: 'landmark',
              floors: 99, hp: Infinity, hp0: Infinity, parts: [], state: 0, name: 'bridge', noShadow: true });
          }
          d0 += segL[k];
        }
        break;
      }
      case 'maracana': {                                                     // the stadium bowl: stands round an oval, white roof ring
        const n = 40, A = 150, B = 128;
        box(stone, 0, 0.2, 0, 70, 0.3, 108, 0x3f8a3c);
        for (let i = 0; i < n; i++) {
          const a = (i + 0.5) / n * Math.PI * 2, x = Math.cos(a) * A, z = Math.sin(a) * B;
          const tx = -Math.sin(a) * A, tz = Math.cos(a) * B, seg = Math.hypot(tx, tz) * Math.PI * 2 / n;
          const yaw = Math.atan2(tx, tz);
          piece(stone, BOX, x * 0.86, 0, z * 0.86, 40, 30, seg + 1, 0xc8c8c4, 0, yaw);
          piece(stone, BOX, x * 0.8, 31, z * 0.8, 52, 2, seg + 1.5, 0xf2f2ee, 0, yaw);
          solid(x * 0.86, z * 0.86, 14, 14, 0, 32, false);
        }
        footprints.push({ x: wx, z: wz, hw: 190, hd: 170, ca, sa });
        break;
      }
      default: console.warn('unknown landmark', lm.type);
    }
  }

  // materials: walls take the same fill / shade treatment as the city
  const fillK = night ? 0.06 : 0.42;
  const add = (batch, mat) => {
    const g = batch.geometry();
    if (!g) return;
    // the fill / floodlight emissive takes each vertex's own colour (a flat grey would wash
    // the copper Statue and the bronze Eiffel Tower out to white)
    mat.onBeforeCompile = function landmarkTint(sh) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vColor.rgb;');
    };
    const mesh = new THREE.Mesh(g, env.shadeMat(mat));
    mesh.frustumCulled = false;
    env.group.add(mesh);
  };
  add(stone, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color().setScalar(fillK) }));
  // floodlit at night: crowns, the golden dome, the torch
  add(lit, new THREE.MeshLambertMaterial({ vertexColors: true, emissive: night ? new THREE.Color(1.1, 0.9, 0.55) : new THREE.Color().setScalar(fillK) }));
  add(glass, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.55, envMapIntensity: 1.1,
    emissive: night ? new THREE.Color(0.18, 0.2, 0.26) : new THREE.Color().setScalar(0.12) }));
  if (lattice.pos.length) {
    const tex = latticeTexture();
    env._sharedTex.push(tex);
    add(lattice, new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, alphaTest: 0.5, side: THREE.DoubleSide,
      emissive: night ? new THREE.Color(1.0, 0.68, 0.3) : new THREE.Color().setScalar(fillK), emissiveMap: tex }));
  }
  return { colliders, footprints };
}
