// AircraftFactory.js — procedural aircraft meshes, built from data.
//   • fuselages / nacelles / canopies are lofted from cross-sections  [z, halfW, halfH, yCentre, xCentre?]
//   • wings, tails, canards and fins are tapered slabs               { r:[x,y,zLE,chord], t:[x,y,zLE,chord], th }
// The whole airframe is ONE vertex-coloured mesh (1 draw call) + canopy glass;
// only moving parts (gear, flames, props, lights) are separate objects.
// Contract (docs/INTERFACES.md): buildAircraft(key, {team, lod}) → Object3D with
// userData { radius, muzzle, nozzles, wingtips, pylons, update(dt, s), dispose() }.
// Local axes: nose −Z, right wing +X, up +Y; belly at y = −spec.bellyH.
import * as THREE from 'three';
import { AIRCRAFT_SPECS } from './AircraftSpecs.js';
import { shadeAir } from '../world/Environment.js';

const TAU = Math.PI * 2;
const HOSTILE = { top: 0x6d6552, bottom: 0x9a9c94, accent: 0x8c2f24 };

/* ------------------------------------------------------------------ data */
// S = surface: r = root [x, y, zLE, chord], t = tip, th = root thickness, m = mirror (default true), c = colour key
const FLANKER = {
  body: [[-11, .05, .05, .3], [-9.2, .42, .42, .3], [-7.2, .78, .82, .3], [-5.2, 1.0, 1.0, .2], [-2.5, 1.55, .9, .05], [1.5, 2.15, .75, -.05],
    [6, 2.15, .72, 0], [8.4, 1.95, .58, 0], [9.4, 1.5, .4, .05], [10.8, .3, .22, .15]],
  canopy: [[-7.9, .05, .05, 1.0], [-7.2, .4, .38, 1.02], [-6.2, .5, .56, 1.08], [-4.9, .45, .42, 1.05], [-3.8, .1, .1, 1.0]],
  surfs: [
    { r: [2.0, 0, -2.6, 7.2], t: [7.5, 0, 3.0, 2.0], th: .34 },
    { r: [2.0, 0, 6.0, 3.6], t: [4.9, 0, 8.6, 1.4], th: .16, mv: 'tail' },
    { r: [1.85, .6, 4.6, 3.6], t: [2.05, 4.0, 7.0, 1.5], th: .18, c: 'accent' },
  ],
  nozzles: [[1.2, 0, 9.5, .62], [-1.2, 0, 9.5, .62]],
  intakes: [[1.15, -.92, -2.3, 4.6, .52, .5], [-1.15, -.92, -2.3, 4.6, .52, .5]],
  gear: [[0, -6.4], [2.1, 1.2], [-2.1, 1.2]], muzzle: [0.9, .5, -6.5],
  col: { top: 0x4f7096, bottom: 0xa9bccb, accent: 0x3d5a7d },
};

const DEFS = {
  ef2000: {
    body: [[-8.4, .05, .05, .15], [-7.2, .3, .33, .12], [-5.6, .6, .7, .08], [-4.0, .85, .95, 0], [-2.2, 1.15, 1.0, 0], [1, 1.28, 1.0, 0],
      [4, 1.22, .95, .05], [6.2, 1.08, .8, .1], [7.3, .95, .62, .12], [7.4, .5, .35, .12]],
    canopy: [[-5.7, .05, .05, .78], [-5.1, .4, .4, .84], [-4.2, .5, .56, .9], [-3.1, .42, .42, .86], [-2.2, .1, .1, .8]],
    surfs: [
      { r: [.95, -.2, -2.3, 8.6], t: [5.45, -.2, 4.5, 1.3], th: .3 },
      { r: [.75, .45, -5.7, 1.5], t: [2.35, .32, -4.5, .55], th: .1, mv: 'canard' },
      { r: [0, .85, 2.3, 4.3], t: [0, 4.0, 5.6, 1.3], th: .18, m: false, c: 'accent' },
    ],
    nozzles: [[.56, .12, 7.4, .5], [-.56, .12, 7.4, .5]],
    intakes: [[0, -.98, -3.0, 1.4, .66, .42]],
    gear: [[0, -4.6], [1.7, 1.2], [-1.7, 1.2]], muzzle: [.8, .3, -5.2],
    col: { top: 0x8794a1, bottom: 0xb9c3cc, accent: 0x76828f },
  },
  f22: {
    body: [[-9.4, .05, .05, .1], [-7.8, .45, .4, .1], [-6, .8, .75, .05], [-4, 1.5, .95, 0], [-1, 1.9, 1.0, 0], [3, 1.9, .95, 0],
      [6.5, 1.7, .7, .05], [8.2, 1.5, .45, .1], [8.3, .6, .2, .1]],
    canopy: [[-6.9, .05, .05, .8], [-6.2, .42, .4, .86], [-5.0, .52, .58, .93], [-3.9, .44, .42, .9], [-3.0, .1, .1, .82]],
    surfs: [
      { r: [1.7, 0, -2.6, 8.0], t: [6.7, 0, 3.2, 1.6], th: .3 },
      { r: [1.6, 0, 5.0, 3.6], t: [4.4, 0, 7.4, 1.2], th: .14, mv: 'tail' },
      { r: [1.5, .6, 3.4, 3.6], t: [2.9, 3.2, 5.6, 1.5], th: .16, c: 'accent' },
    ],
    nozzles: [[.75, .1, 8.2, .55], [-.75, .1, 8.2, .55]],
    intakes: [[1.5, -.12, -4.5, 1.0, .4, .58], [-1.5, -.12, -4.5, 1.0, .4, .58]],
    internalBay: true,
    gear: [[0, -5.6], [1.6, 1.4], [-1.6, 1.4]], muzzle: [1.2, .6, -4.5],
    col: { top: 0x6f7b86, bottom: 0x98a3ad, accent: 0x5d6873 },
  },
  su35: FLANKER,
  mig29: { ...FLANKER, scale: 0.79, col: { top: 0x7c8a7a, bottom: 0xaab4b8, accent: 0x5f6d5e } },
  a10: {
    body: [[-8, .05, .05, -.1], [-7, .45, .5, -.1], [-5, .7, .85, 0], [-2, .75, .9, 0], [3, .7, .8, 0], [6, .45, .5, .2], [8, .15, .2, .3]],
    canopy: [[-5.8, .05, .05, .75], [-5.2, .38, .4, .82], [-4.4, .46, .56, .88], [-3.5, .4, .42, .84], [-2.8, .1, .1, .78]],
    surfs: [
      { r: [.6, -.55, -1.6, 3.3], t: [8.7, -.1, -.9, 2.0], th: .42 },
      { r: [0, .3, 6.2, 1.9], t: [2.9, .3, 6.3, 1.7], th: .16, mv: 'elev' },
      { r: [2.9, .3, 6.2, 1.8], t: [2.9, 2.7, 6.6, 1.3], th: .14, c: 'accent' },
    ],
    pods: [[1.35, 1.25, 2.0, 5.2, .78], [-1.35, 1.25, 2.0, 5.2, .78]],
    nozzles: [[1.35, 1.25, 5.2, .5], [-1.35, 1.25, 5.2, .5]],
    gear: [[0, -5.6], [2.6, .2], [-2.6, .2]], muzzle: [0, -.5, -8.1],
    col: { top: 0x6c7772, bottom: 0x8f9a98, accent: 0x5a6560 },
  },
  spitfire: {
    body: [[-4.25, .22, .22, 0], [-3.6, .5, .55, 0], [-1.5, .55, .7, 0], [.5, .5, .7, .05], [3, .26, .4, .2], [4.8, .05, .15, .3]],
    canopy: [[-.8, .05, .05, .62], [-.4, .3, .3, .7], [.2, .34, .4, .76], [.9, .3, .3, .72], [1.5, .05, .05, .62]],
    surfs: [
      { r: [.45, -.5, -1.9, 2.6], t: [3.4, -.32, -1.6, 2.1], th: .3 },
      { r: [3.4, -.32, -1.6, 2.1], t: [5.55, -.2, -.9, .8], th: .2 },
      { r: [.15, .3, 3.6, 1.2], t: [1.7, .3, 3.9, .6], th: .1, mv: 'elev' },
      { r: [0, .3, 3.4, 1.5], t: [0, 1.7, 4.2, .7], th: .1, m: false },
    ],
    props: [[0, 0, -4.35, 1.6, 4]],
    gear: [[0, 4.4, .16], [1.05, -1.6], [-1.05, -1.6]], muzzle: [2.2, -.35, -2.2],
    col: { top: 0x5b6b4c, bottom: 0xa9c0cc, accent: 0x6e5a40 },
  },
  c172: {
    body: [[-3.35, .25, .25, 0], [-2.6, .5, .5, 0], [-1.2, .58, .72, .1], [.8, .58, .72, .1], [2.4, .3, .4, .25], [4.9, .08, .15, .4]],
    canopy: [[-1.75, .1, .1, .55], [-1.3, .5, .34, .52], [.4, .5, .34, .52], [.9, .1, .1, .5]],
    surfs: [
      { r: [0, .93, -1.3, 1.65], t: [5.5, .97, -1.2, 1.2], th: .2 },
      { r: [.1, .4, 4.0, 1.1], t: [1.7, .4, 4.2, .7], th: .08, mv: 'elev' },
      { r: [0, .5, 3.6, 1.5], t: [0, 1.9, 4.6, .7], th: .08, m: false, c: 'accent' },
    ],
    props: [[0, 0, -3.45, .95, 2]],
    gear: [[0, -2.3, .2], [1.15, .1, .22], [-1.15, .1, .22]], fixedGear: true, muzzle: [0, 0, -3.5],
    col: { top: 0xe9ecee, bottom: 0xdfe3e6, accent: 0xb5322c },
  },
  a320: {
    body: [[-19, .1, .1, -.4], [-17.6, 1.15, 1.2, -.25], [-15.2, 1.85, 1.95, 0], [-12, 2.0, 2.07, 0], [8, 2.0, 2.07, 0], [14, 1.3, 1.5, .5], [18.6, .3, .4, 1.2]],
    canopy: [[-17.9, .05, .05, .55], [-17.3, .95, .3, .62], [-16.2, 1.5, .4, .98], [-15.8, 1.2, .1, 1.3]],
    surfs: [
      { r: [1.9, -1.2, -4.6, 7.0], t: [17, -.1, 4.4, 1.6], th: .7 },
      { r: [1.0, .8, 14.0, 3.6], t: [6.2, 1.1, 17.0, 1.3], th: .3, mv: 'elev' },
      { r: [0, 1.6, 11.5, 5.5], t: [0, 7.6, 16.6, 2.0], th: .35, m: false, c: 'accent' },
    ],
    pods: [[5.8, -2.0, -5.6, -1.6, 1.08], [-5.8, -2.0, -5.6, -1.6, 1.08]],
    nozzles: [[5.8, -2.0, -1.6, .7], [-5.8, -2.0, -1.6, .7]],
    gear: [[0, -15, .4], [3.6, 1.5, .55], [-3.6, 1.5, .55]], muzzle: [0, 0, -19], noPilot: true,
    windows: { z0: -14.4, z1: 7.6, pitch: 0.78, y: 0.62, stripe: [-0.05, 0.16] },
    col: { top: 0xeef1f3, bottom: 0xc9d0d6, accent: 0x1f4f9c },
  },
  bomber: {
    body: [[-23, .1, .1, -.5], [-21, 1.0, 1.0, -.5], [-17, 1.45, 1.45, -.5], [8, 1.45, 1.45, -.5], [18, .8, .9, -.1], [23, .2, .3, .3]],
    canopy: [[-21.6, .05, .05, .2], [-20.6, .8, .3, .32], [-19.4, 1.0, .35, .7], [-19, .8, .1, .95]],
    surfs: [
      { r: [1.4, -.4, -6, 7.5], t: [25, -.1, 4, 2.2], th: .65 },
      { r: [.8, 0, 18, 4], t: [7, .1, 21, 1.6], th: .3 },
      { r: [0, .6, 15, 6], t: [0, 7.2, 21, 2.4], th: .35, m: false, c: 'accent' },
    ],
    pods: [[7, -.4, -8.5, -1, .8], [-7, -.4, -8.5, -1, .8], [14.5, -.25, -4.6, 2, .7], [-14.5, -.25, -4.6, 2, .7]],
    props: [[7, -.4, -8.7, 2.8, 4], [-7, -.4, -8.7, 2.8, 4], [14.5, -.25, -4.8, 2.8, 4], [-14.5, -.25, -4.8, 2.8, 4]],
    gear: [[0, -17, .5], [7, -2, .65], [-7, -2, .65]], muzzle: [0, .2, 23], noPilot: true,
    col: { top: 0xb9bdbf, bottom: 0xa4a9ad, accent: 0x9aa0a4 },
  },
  mi24: {
    body: [[-8.5, .1, .1, -.6], [-7.5, .6, .6, -.6], [-5.5, .85, 1.0, -.4], [-3, .95, 1.35, -.2], [1, .95, 1.35, -.2], [3, .5, .6, .35], [9.2, .18, .25, .95]],
    canopy: [[-7.3, .05, .05, .0], [-6.6, .45, .42, .1], [-5.4, .5, .5, .35], [-4.6, .48, .46, .62], [-3.4, .52, .5, .88], [-2.5, .1, .1, .9]],
    surfs: [
      { r: [.9, -.3, -1, 1.8], t: [3.3, -.75, -.6, 1.2], th: .2 },
      { r: [0, .95, 7.4, 1.9], t: [.1, 3.4, 8.9, 1.0], th: .16, m: false },
      { r: [0, 1.15, -2.2, 2.6], t: [0, 1.75, -1.6, 1.4], th: 1.1, m: false },
    ],
    rotor: [0, 2.0, -.9, 8.6, 5], tailRotor: [.4, 3.1, 9.2, 1.9],
    gear: [[0, -5.5, .28], [1.5, .3, .32], [-1.5, .3, .32]], fixedGear: true, muzzle: [0, -1.1, -7.6],
    col: { top: 0x5f6b4a, bottom: 0x8fa0aa, accent: 0x4c573c },
  },
};

/* ------------------------------------------------------------------ geometry helpers */
const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color(), _rgb = [0, 0, 0];

/** Insert Catmull-Rom midpoints between sections: a smoother fuselage from the same data. */
function refine(secs) {
  const out = [];
  for (let i = 0; i < secs.length; i++) {
    out.push(secs[i]);
    if (i === secs.length - 1) continue;
    const p0 = secs[Math.max(0, i - 1)], p1 = secs[i], p2 = secs[i + 1], p3 = secs[Math.min(secs.length - 1, i + 2)];
    if (p2[0] - p1[0] < 0.4) continue;           // keep deliberate steps (nozzle lips, tail cones) sharp
    const m = [];
    for (let j = 0; j < p1.length; j++) {
      const a = p0[j] ?? 0, b = p1[j] ?? 0, c = p2[j] ?? 0, d = p3[j] ?? 0;
      const v = (-a + 9 * b + 9 * c - d) / 16;
      m.push(j === 1 || j === 2 ? Math.max(Math.min(b, c) * 0.9, Math.min(v, Math.max(b, c) * 1.08)) : v);
    }
    out.push(m);
  }
  return out;
}

/** An ellipsoid as loft sections. */
const blob = (z, rx, ry, rz, y, x = 0) => [-1, -0.8, -0.45, 0, 0.45, 0.8, 1].map(t => [z + t * rz, Math.max(0.005, rx * Math.sqrt(1 - t * t)), Math.max(0.005, ry * Math.sqrt(1 - t * t)), y, x]);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/**
 * Loft cross-sections [z, halfW, halfH, yCentre, xCentre?, wobble?] into a smooth tube; appends
 * position/normal/colour to `out`. `paint(z, s, rgb)` may recolour a vertex (s = sin of the angle,
 * +1 = top); wobble alternates the radius per vertex (nozzle petals).
 */
function loft(out, secs, top, bottom, K = 14, e = 0.85, paint = null) {
  const n = secs.length, pos = new Float32Array(n * K * 3), col = new Float32Array(n * K * 3);
  _c1.setHex(top); _c2.setHex(bottom);
  for (let i = 0; i < n; i++) {
    const [z, w, h, y, x0 = 0, wob = 0] = secs[i];
    for (let k = 0; k < K; k++) {
      const a = k / K * TAU, c = Math.cos(a), s = Math.sin(a), o = (i * K + k) * 3, f = 1 + (k % 2 ? wob : -wob);
      pos[o] = x0 + w * f * Math.sign(c) * Math.abs(c) ** e; pos[o + 1] = y + h * f * Math.sign(s) * Math.abs(s) ** e; pos[o + 2] = z;
      const t = smooth(-0.45, 0.05, s);
      col[o] = _c2.r + (_c1.r - _c2.r) * t; col[o + 1] = _c2.g + (_c1.g - _c2.g) * t; col[o + 2] = _c2.b + (_c1.b - _c2.b) * t;
      if (paint) { _rgb[0] = col[o]; _rgb[1] = col[o + 1]; _rgb[2] = col[o + 2]; paint(z, s, _rgb); col[o] = _rgb[0]; col[o + 1] = _rgb[1]; col[o + 2] = _rgb[2]; }
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < K; k++) {
    const a = i * K + k, b = i * K + (k + 1) % K, c = a + K, d = b + K;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const f = g.toNonIndexed();
  out.pos.push(...f.attributes.position.array); out.nor.push(...f.attributes.normal.array); out.col.push(...f.attributes.color.array);
  g.dispose(); f.dispose();
}

const _p = [], _n = new THREE.Vector3(), _ab = new THREE.Vector3(), _ac = new THREE.Vector3(), _ctr = new THREE.Vector3(), _fc = new THREE.Vector3();
for (let i = 0; i < 8; i++) _p.push(new THREE.Vector3());

/** Flat triangle, wound so its normal points away from `_ctr`. */
function tri(out, a, b, c, col) {
  _ab.subVectors(b, a); _ac.subVectors(c, a); _n.crossVectors(_ab, _ac);
  if (_n.lengthSq() < 1e-10) return;
  _n.normalize();
  _fc.copy(a).add(b).add(c).multiplyScalar(1 / 3).sub(_ctr);
  if (_n.dot(_fc) < 0) { const t = b; b = c; c = t; _n.negate(); }
  out.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < 3; i++) { out.nor.push(_n.x, _n.y, _n.z); out.col.push(col.r, col.g, col.b); }
}
const quad = (out, a, b, c, d, col) => { tri(out, a, b, c, col); tri(out, a, c, d, col); };

/** Tapered slab with a diamond section: wing, tailplane, canard or fin. */
function surf(out, r, t, th, hex, sx = 1) {
  const col = _c1.setHex(hex).clone();
  const rx = r[0] * sx, tx = t[0] * sx;
  _ab.set(tx - rx, t[1] - r[1], t[2] - r[2]);
  _n.set(0, 0, 1).cross(_ab).normalize();          // thickness direction
  const nx = _n.x, ny = _n.y, nz = _n.z;
  const h0 = th / 2, h1 = Math.max(0.025, th / 2 * t[3] / r[3]);
  const [rL, rT, rB, rE, tL, tT, tB, tE] = _p;
  rL.set(rx, r[1], r[2]); rE.set(rx, r[1], r[2] + r[3]);
  rT.set(rx + nx * h0, r[1] + ny * h0, r[2] + r[3] * 0.36 + nz * h0); rB.set(rx - nx * h0, r[1] - ny * h0, r[2] + r[3] * 0.36 - nz * h0);
  tL.set(tx, t[1], t[2]); tE.set(tx, t[1], t[2] + t[3]);
  tT.set(tx + nx * h1, t[1] + ny * h1, t[2] + t[3] * 0.36 + nz * h1); tB.set(tx - nx * h1, t[1] - ny * h1, t[2] + t[3] * 0.36 - nz * h1);
  _ctr.set(0, 0, 0); for (const p of _p) _ctr.add(p); _ctr.multiplyScalar(1 / 8);
  quad(out, rL, tL, tT, rT, col); quad(out, rT, tT, tE, rE, col);
  quad(out, rL, rB, tB, tL, col); quad(out, rB, rE, tE, tB, col);
  tri(out, tL, tT, tB, col); tri(out, tT, tE, tB, col);
  tri(out, rL, rT, rB, col); tri(out, rT, rE, rB, col);
}

function toMesh(out, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  g.computeBoundingSphere();
  return new THREE.Mesh(g, mat);
}

/** Visible missile stations under the main wing (4 max; none for internal-bay or unarmed types). */
function stores(def, spec) {
  if (!spec.missileCount || def.internalBay) return [];
  const w = def.surfs[0], span = Math.abs(w.t[0]);
  return [-0.55, 0.55, -0.35, 0.35].map(f => {
    const x = f * span, u = Math.min(1, Math.max(0, (Math.abs(x) - w.r[0]) / (w.t[0] - w.r[0])));
    const wy = w.r[1] + (w.t[1] - w.r[1]) * u, le = w.r[2] + (w.t[2] - w.r[2]) * u, chord = w.r[3] + (w.t[3] - w.r[3]) * u;
    const th = w.th * (1 - u * 0.5);
    return { x, wy: wy - th * 0.3, y: wy - th * 0.5 - 0.3, z: le + chord * 0.42 };
  });
}

/** Missile: body, seeker, four tail fins. Built once and shared. */
function missileGeo() {
  const o = { pos: [], nor: [], col: [] }, L = 2.9, r = 0.09;
  loft(o, [[-L / 2 - 0.12, .01, .01, 0], [-L / 2, r * 0.75, r * 0.75, 0], [-L / 2 + 0.25, r, r, 0], [L / 2, r, r, 0], [L / 2 + 0.01, r * 0.6, r * 0.6, 0]], 0xa8acae, 0x9a9ea0, 10, 1,
    (z, sn, c) => { if (z < -L / 2 + 0.1) { c[0] = 0.12; c[1] = 0.12; c[2] = 0.13; } else if (z > -L / 2 + 0.35 && z < -L / 2 + 0.5) { c[0] = 0.6; c[1] = 0.45; c[2] = 0.08; } });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4, cx = Math.cos(a), cy = Math.sin(a);
    _ctr.set(0, 0, 0);
    const fin = (z0, len, h) => {
      const a0 = new THREE.Vector3(cx * r, cy * r, z0), a1 = new THREE.Vector3(cx * r, cy * r, z0 + len), b = new THREE.Vector3(cx * (r + h), cy * (r + h), z0 + len * 0.85);
      const n = new THREE.Vector3(-cy, cx, 0).multiplyScalar(0.008);
      const col = _c1.setHex(0x8e9294).clone();
      _ctr.copy(a0).add(a1).add(b).multiplyScalar(1 / 3).sub(n);
      tri(o, a0.clone().add(n), a1.clone().add(n), b.clone().add(n), col);
      _ctr.copy(a0).add(a1).add(b).multiplyScalar(1 / 3).add(n);
      tri(o, a0.clone().sub(n), a1.clone().sub(n), b.clone().sub(n), col);
    };
    fin(L / 2 - 0.45, 0.42, 0.2);
    fin(-L / 2 + 0.55, 0.25, 0.08);
  }
  return toMesh(o, null).geometry;
}

/**
 * Skin detail in the shader, all from the local (airframe) position, picked triplanar by the local normal:
 *   • staggered panels with per-panel tone and roughness variation
 *   • panel seams as small grooves (bump-mapped, so they catch the light)
 *   • rivet rows along the seams (only resolved up close)
 *   • faint chordwise grime streaks from the airflow
 * Everything fades with screen-space size so distant aircraft stay clean. `k` = seam contrast.
 */
const panelLines = (k) => function (sh) {
  sh.vertexShader = 'varying vec3 vLoc; varying vec3 vLocN;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vLoc = position; vLocN = normal;');
  sh.fragmentShader = `varying vec3 vLoc; varying vec3 vLocN;
    float sHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float sNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
    }
  ` + sh.fragmentShader
    .replace('void main() {', 'void main() {\n  float pHgt = 0.0, pRough = 1.0, pFade = 0.0;')
    .replace('#include <color_fragment>', `#include <color_fragment>
    {
      vec3 an = abs(normalize(vLocN));
      vec2 q = an.x > max(an.y, an.z) ? vLoc.zy : (an.y > an.z ? vLoc.zx : vLoc.xy);   // metres in the surface plane
      vec2 P = vec2(1.3, 0.85);
      vec2 g = q / P;
      g.y += floor(g.x) * 0.37;
      vec2 id = floor(g), f = abs(fract(g) - 0.5), fw = fwidth(g);
      vec2 l2 = smoothstep(0.5 - fw * 1.4, 0.5 - fw * 0.2, f);
      float line = max(l2.x, l2.y);
      float fade = 1.0 - smoothstep(0.035, 0.12, max(fw.x, fw.y));
      float h = sHash(id);
      // rivets: a row 4.5 cm in from each seam, 11 cm pitch
      vec2 e = (0.5 - f) * P;                     // distance to the panel edges in metres
      vec2 fq = fwidth(q);
      float rv = 0.0;
      vec2 rowA = vec2(e.x - 0.045, (fract(q.y / 0.11) - 0.5) * 0.11);
      vec2 rowB = vec2(e.y - 0.045, (fract(q.x / 0.11) - 0.5) * 0.11);
      float rr = 0.0075, aa = max(fq.x, fq.y) * 0.8;
      rv = max(1.0 - smoothstep(rr - aa, rr + aa, length(rowA)), 1.0 - smoothstep(rr - aa, rr + aa, length(rowB)));
      float rfade = 1.0 - smoothstep(0.006, 0.016, max(fq.x, fq.y));
      rv *= rfade;
      // airflow grime: thin streaks running fore-aft
      float st = sNoise(vec2((vLoc.x + vLoc.y) * 9.0, vLoc.z * 0.28)) * sNoise(vec2((vLoc.x - vLoc.y) * 3.0, vLoc.z * 0.12 + 7.0));
      diffuseColor.rgb *= (1.0 - ${k.toFixed(2)} * line * fade) * (1.0 - ${(k * 0.14).toFixed(3)} + ${(k * 0.28).toFixed(3)} * h * fade)
        * (1.0 - 0.08 * rv) * (1.0 - 0.07 * st * fade);
      pHgt = (-line * 0.5 + rv * 0.4) * fade;
      pRough = 0.82 + 0.36 * h + 0.25 * line + 0.15 * st;
      pFade = fade;
    }`)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor * mix(1.0, pRough, pFade), 0.05, 1.0);')
    .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    {
      // bump: seams are grooves, rivet heads stand proud
      vec2 dH = vec2(dFdx(pHgt), dFdy(pHgt)) * 0.012;
      vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
      vec3 R1 = cross(sy, normal), R2 = cross(normal, sx);
      float det = dot(sx, R1) * faceDirection;
      normal = normalize(abs(det) * normal - sign(det) * (dH.x * R1 + dH.y * R2));
    }`);
};

/* ------------------------------------------------------------------ shared resources */
let R = null;
function res() {
  if (R) return R;
  const S = 32, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = Math.hypot((x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1), a = Math.max(0, 1 - d), k = (y * S + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255; data[k + 3] = 255 * a * a;
  }
  const glow = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  glow.magFilter = glow.minFilter = THREE.LinearFilter; glow.needsUpdate = true;
  const flame = new THREE.ConeGeometry(1, 1, 10, 1, true); flame.rotateX(Math.PI / 2); flame.translate(0, 0, 0.5);
  const strut = new THREE.CylinderGeometry(1, 1, 1, 8); strut.translate(0, -0.5, 0);
  const wheel = new THREE.CylinderGeometry(1, 1, 1, 12); wheel.rotateZ(Math.PI / 2);
  const blade = new THREE.BoxGeometry(1, 0.09, 0.02); blade.translate(0.5, 0, 0);
  const light = (c) => new THREE.SpriteMaterial({ map: glow, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  R = {
    glow, flame, strut, wheel, blade, disc: new THREE.CircleGeometry(1, 20),
    // colour > 1: scene lights are balanced for the custom terrain shader; standard materials come out too dark
    // military: matte paint over metal. Colour > 1 because the scene lights are balanced for the custom
    // terrain shader; tuned together with the sky reflection environment (Environment.buildEnvMap)
    skin: new THREE.MeshPhysicalMaterial({ vertexColors: true, color: new THREE.Color(1.55, 1.55, 1.55), roughness: 0.58, metalness: 0.12, side: THREE.DoubleSide, envMapIntensity: 0.55 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x2a3a46, roughness: 0.04, metalness: 0.55, transparent: true, opacity: 0.6, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.03 }),
    missile: missileGeo(),
    metal: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.6, 1.62, 1.65), roughness: 0.5, metalness: 0.2 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.9, metalness: 0 }),
    blur: new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }),
    flameOut: new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    flameIn: new THREE.MeshBasicMaterial({ color: 0xbfd8ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }),
    red: light(0xff2a20), green: light(0x30ff50), white: light(0xffffff),
    // HDR colours (> 1) so they read as hot and feed the bloom
    core: new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(3.2, 1.5, 0.55), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
    diamond: new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(2.4, 2.2, 3.0), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0.85 }),
  };
  R.skin.onBeforeCompile = panelLines(0.16);
  // airliners and light aircraft: smoother, subtler skin
  // civil: glossy clear-coated paint
  R.skinCivil = R.skin.clone();
  R.skinCivil.roughness = 0.42; R.skinCivil.metalness = 0.05; R.skinCivil.clearcoat = 0.7; R.skinCivil.clearcoatRoughness = 0.18;
  R.skinCivil.onBeforeCompile = panelLines(0.10);
  R.skinCivil.customProgramCacheKey = () => 'skin-civil';
  for (const m of [R.skin, R.skinCivil, R.metal, R.tyre]) shadeAir(m);     // mountain and cloud shadows fall on aircraft
  return R;
}

const cache = new Map();   // `${key}:${team}` → { skin: BufferGeometry, glass: BufferGeometry|null }

function airframe(key, def, team, full) {
  const id = key + ':' + team + ':' + (full ? 1 : 0);
  let g = cache.get(id);
  if (g) return g;
  const col = team === 1 ? HOSTILE : def.col;
  const spec = AIRCRAFT_SPECS[key], mil = spec.faction === 'military';
  const out = { pos: [], nor: [], col: [] };
  // fuselage: smoother loft; radome + anti-glare panel ahead of the canopy on military types
  const z0 = def.body[0][0], cz0 = def.canopy ? def.canopy[0][0] : z0;
  const radome = mil && spec.type === 'jet' ? z0 + (cz0 - z0) * 0.32 : -1e9;
  _c3.setHex(team === 1 ? 0x3e4038 : 0x3a4048);
  const ag = mil ? [cz0 - (cz0 - z0) * 0.45, cz0 + 0.3] : null;
  loft(out, refine(def.body), col.top, col.bottom, 20, 0.85, (z, sn, c) => {
    if (z < radome) { const k = 0.82; c[0] = c[0] * k + 0.05; c[1] = c[1] * k + 0.05; c[2] = c[2] * k + 0.05; }
    else if (ag && z > ag[0] && z < ag[1] && sn > 0.45) { c[0] = _c3.r; c[1] = _c3.g; c[2] = _c3.b; }
  });
  if (mil && spec.type === 'jet') {
    // pitot / air-data probe on the nose
    const [nz, , , ny, nx = 0] = def.body[0];
    loft(out, [[nz - 1.1, .02, .02, ny, nx], [nz - 0.3, .03, .03, ny, nx], [nz + 0.1, .05, .05, ny, nx]], 0x8a8f94, 0x8a8f94, 6, 1);
  }
  // air intakes: a boxy duct fairing with a dark recessed face
  for (const [x, y, za, zb, w, h] of def.intakes || []) {
    loft(out, [[za, w, h, y, x], [za + 0.5, w * 1.04, h * 1.04, y, x], [zb - 1.2, w * 0.96, h * 0.96, y, x], [zb, w * 0.35, h * 0.35, y, x]], col.top, col.bottom, 12, 0.4);
    loft(out, [[za + 0.3, w * 0.94, h * 0.9, y, x], [za + 0.31, 0.02, 0.02, y, x]], 0x0b0c0e, 0x0b0c0e, 12, 0.4);
  }
  // canopy frame: windscreen arch + mid bow, slightly proud of the glass
  if (def.canopy && !def.noPilot) {
    const cs = def.canopy, frameHex = 0x24282c;
    for (const i of [1, Math.floor(cs.length / 2)]) {
      const [z, w, h, y, x = 0] = cs[i];
      loft(out, [[z - 0.035, w * 1.03 + 0.012, h * 1.03 + 0.012, y, x], [z + 0.035, w * 1.03 + 0.012, h * 1.03 + 0.012, y, x]], frameHex, frameHex, 10, 1);
    }
  }
  // airliner: cabin window row + cheatline, laid just proud of the fuselage on both sides
  if (def.windows) {
    const wdef = def.windows, at = (z) => {
      const b = def.body; let i = 0; while (i < b.length - 2 && b[i + 1][0] < z) i++;
      const t = Math.min(1, Math.max(0, (z - b[i][0]) / (b[i + 1][0] - b[i][0])));
      return [b[i][1] + (b[i + 1][1] - b[i][1]) * t, b[i][2] + (b[i + 1][2] - b[i][2]) * t, b[i][3] + (b[i + 1][3] - b[i][3]) * t];
    };
    const sx = (z, y) => { const [w, h, yc] = at(z); const sn = Math.min(0.98, Math.abs((y - yc) / h) ** (1 / 0.85)); return w * Math.sqrt(1 - sn * sn) ** 0.85 + 0.015; };
    const win = _c1.setHex(0x1a2028).clone(), line = _c1.setHex(col.accent).clone();
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    for (const side of [1, -1]) {
      for (let z = wdef.z0; z < wdef.z1; z += wdef.pitch) {
        const y0 = wdef.y - 0.17, y1 = wdef.y + 0.17, za = z - 0.12, zb = z + 0.12;
        _ctr.set(0, wdef.y, z);
        quad(out, V(side * sx(za, y0), y0, za), V(side * sx(zb, y0), y0, zb), V(side * sx(zb, y1), y1, zb), V(side * sx(za, y1), y1, za), win);
      }
      for (let z = wdef.z0 - 1.5; z < wdef.z1 + 2; z += 1) {
        const [ya, yb] = wdef.stripe, zb = z + 1;
        _ctr.set(0, (ya + yb) / 2, z);
        quad(out, V(side * sx(z, ya), ya, z), V(side * sx(zb, ya), ya, zb), V(side * sx(zb, yb), yb, zb), V(side * sx(z, yb), yb, z), line);
      }
    }
  }
  // propeller spinners
  for (const [x, y, z, rad] of def.props || []) {
    const rb = Math.min(0.32, Math.max(0.14, rad * 0.13));
    loft(out, [[z - 0.62, .01, .01, y, x], [z - 0.45, rb * 0.62, rb * 0.62, y, x], [z - 0.15, rb * 0.95, rb * 0.95, y, x], [z + 0.12, rb, rb, y, x]], col.accent, col.accent, 12, 1);
  }
  const movers = [];
  for (const s of def.surfs) {
    const hex = col[s.c] || col.top;
    if (full && s.mv) {
      // all-moving surface: its own little mesh, hinged at 45 % root chord
      const py = s.r[1], pz = s.r[2] + s.r[3] * 0.45;
      const r2 = [s.r[0], 0, s.r[2] - pz, s.r[3]], t2 = [s.t[0], s.t[1] - py, s.t[2] - pz, s.t[3]];
      for (const sx of [1, -1]) {
        const o = { pos: [], nor: [], col: [] };
        surf(o, r2, t2, s.th, hex, sx);
        movers.push({ geo: toMesh(o, null).geometry, py, pz, sx, mv: s.mv });
      }
      continue;
    }
    surf(out, s.r, s.t, s.th, hex, 1);
    if (s.m !== false) surf(out, s.r, s.t, s.th, hex, -1);
  }
  for (const [x, y, z0, z1, r] of def.pods || []) {
    const L = z1 - z0;
    loft(out, [[z0 - 0.02, r * 0.5, r * 0.5, y, x], [z0, r * 0.82, r * 0.82, y, x], [z0 + L * 0.25, r, r, y, x], [z0 + L * 0.7, r, r, y, x], [z1, r * 0.72, r * 0.72, y, x], [z1 + 0.02, r * 0.3, r * 0.3, y, x]],
      col.top, col.bottom, 16, 1);
    if (!def.props) {
      // jet pod: dark fan face with a spinner cone, set back behind the lip
      loft(out, [[z0 + 0.3, r * 0.8, r * 0.8, y, x], [z0 + 0.31, .01, .01, y, x]], 0x16181a, 0x16181a, 16, 1);
      loft(out, [[z0 + 0.02, .01, .01, y, x], [z0 + 0.32, r * 0.24, r * 0.24, y, x]], 0x8a8e92, 0x6a6e72, 10, 1);
    }
  }
  for (const [x, y, z, r] of def.nozzles || []) {
    loft(out, [[z - 1.1, r * 1.05, r * 1.05, y, x], [z - 0.4, r * 1.0, r * 1.0, y, x, 0.0], [z + 0.25, r * 0.9, r * 0.9, y, x, 0.045]], 0x4c4640, 0x3c3834, 16, 1);
    loft(out, [[z + 0.25, r * 0.86, r * 0.86, y, x], [z + 0.05, r * 0.74, r * 0.74, y, x], [z + 0.04, r * 0.3, r * 0.3, y, x], [z + 0.035, .01, .01, y, x]], 0x151515, 0x151515, 16, 1);
  }
  // underwing pylons for the visible missiles
  const st = stores(def, spec);
  for (const p of st) {
    const L = 1.4;
    surf(out, [p.x, p.wy - 0.02, p.z - L * 0.5, L], [p.x, p.y + 0.12, p.z - L * 0.45, L * 0.85], 0.14, 0x5a5e62, 1);
  }
  const skin = toMesh(out, null).geometry;
  let glass = null, pilot = null;
  if (def.canopy) { const o = { pos: [], nor: [], col: [] }; loft(o, def.canopy, 0xffffff, 0xffffff, 14, 1); glass = toMesh(o, null).geometry; }
  if (def.canopy && !def.noPilot) {
    // pilot: helmet + visor + headrest under the biggest canopy section (hidden with the glass in cockpit view)
    let im = 0; def.canopy.forEach((c, i) => { if (c[2] > def.canopy[im][2]) im = i; });
    const [cz, , ch, cy, cx = 0] = def.canopy[im];
    const hy = cy + ch * 0.25 - 0.06, hz = cz + 0.3, R = 0.15;
    const o = { pos: [], nor: [], col: [] };
    const helmet = team === 1 ? 0x4c5444 : (spec.type === 'prop' ? 0x5a4a3a : 0xd6d8d0);
    loft(o, blob(hz, R, R * 1.08, R * 1.12, hy, cx), helmet, helmet, 10, 1);
    loft(o, blob(hz - R * 0.45, R * 0.78, R * 0.5, R * 0.7, hy - R * 0.05, cx), 0x14181c, 0x14181c, 10, 1);
    loft(o, blob(hz + R * 1.3, 0.2, 0.32, 0.1, hy - 0.12, cx), 0x2a2c2e, 0x2a2c2e, 8, 0.5);
    loft(o, blob(hz + 0.1, 0.24, 0.16, 0.22, hy - 0.42, cx), team === 1 ? 0x404a3a : 0x4d5a3e, 0x3a4430, 10, 1);  // shoulders
    pilot = toMesh(o, null).geometry;
  }
  g = { skin, glass, pilot, movers, stores: st };
  cache.set(id, g);
  return g;
}

/* ------------------------------------------------------------------ public */
export function buildAircraft(key, opts = {}) {
  const spec = AIRCRAFT_SPECS[key], def = DEFS[key];
  if (!spec || !def) throw new Error(`Unknown aircraft: ${key}`);
  const r = res(), team = opts.team === 1 ? 1 : 0, full = opts.lod !== 'low';
  const sc = def.scale || 1;
  const g = new THREE.Group(), inner = new THREE.Group();
  inner.scale.setScalar(sc);
  g.add(inner);
  const geo = airframe(key, def, team, full);
  const skinMat = spec.faction === 'civilian' ? r.skinCivil : r.skin;
  const skin = new THREE.Mesh(geo.skin, skinMat);
  skin.castShadow = true;
  inner.add(skin);
  if (geo.glass) {
    g.userData.glass = new THREE.Mesh(geo.glass, r.glass);
    g.userData.glass.renderOrder = 1;
    inner.add(g.userData.glass);
    // the pilot rides with the glass so the cockpit view hides both
    if (geo.pilot) g.userData.glass.add(new THREE.Mesh(geo.pilot, r.skin));
  }
  const missiles = geo.stores.map(p => {
    const m = new THREE.Mesh(r.missile, r.skin);
    m.position.set(p.x, p.y, p.z);
    inner.add(m);
    return m;
  });

  const movers = geo.movers.map(m => {
    const mesh = new THREE.Mesh(m.geo, skinMat);
    mesh.position.set(0, m.py, m.pz);
    inner.add(mesh);
    return { mesh, sx: m.sx, mv: m.mv };
  });

  // extents
  let span = 0, zMin = 0, zMax = 0;
  for (const s of def.body) { zMin = Math.min(zMin, s[0]); zMax = Math.max(zMax, s[0]); }
  let tip = [3, 0, 0, 1];
  for (const s of def.surfs) if (Math.abs(s.t[0]) > span) { span = Math.abs(s.t[0]); tip = s.t; }
  if (def.rotor) span = Math.max(span, def.rotor[3]);
  const ud = g.userData;
  // merged airframe (all surfaces in one geometry, cached) for silhouette shadows
  ud.shadowGeo = full ? airframe(key, def, team, false).skin : geo.skin;
  ud.inner = inner;
  ud.radius = Math.max(span, (zMax - zMin) / 2) * sc;
  ud.muzzle = new THREE.Vector3(...def.muzzle).multiplyScalar(sc);
  ud.nozzles = (def.nozzles || [[0, 0, zMax]]).map(n => new THREE.Vector3(n[0], n[1], n[2]).multiplyScalar(sc));
  ud.wingtips = [new THREE.Vector3(-tip[0], tip[1], tip[2] + tip[3] * 0.7).multiplyScalar(sc), new THREE.Vector3(tip[0], tip[1], tip[2] + tip[3] * 0.7).multiplyScalar(sc)];
  ud.pylons = geo.stores.length
    ? geo.stores.map(p => new THREE.Vector3(p.x, p.y, p.z).multiplyScalar(sc))
    : [-0.55, 0.55, -0.35, 0.35].map(f => new THREE.Vector3(f * span, -0.5, 1).multiplyScalar(sc));

  // afterburner / exhaust flames
  const flames = [];
  if (spec.type === 'jet') {
    for (const [x, y, z, rad] of def.nozzles || []) {
      const fo = new THREE.Mesh(r.flame, r.flameOut), fi = new THREE.Mesh(r.flame, r.flameIn);
      fo.position.set(x, y, z + 0.2); fi.position.copy(fo.position);
      fo.visible = fi.visible = false;
      inner.add(fo, fi);
      // hot core inside the nozzle + shock diamonds in the afterburner plume (both bloom on MED/HIGH)
      const core = new THREE.Sprite(r.core); core.position.set(x, y, z + 0.1); core.scale.setScalar(rad * 1.5); core.visible = false;
      inner.add(core);
      const diamonds = [];
      for (let i = 0; i < 4; i++) {
        const d = new THREE.Sprite(r.diamond); d.visible = false;
        d.position.set(x, y, z + 0.9 + i * rad * 2.1);
        inner.add(d); diamonds.push(d);
      }
      flames.push({ fo, fi, r: rad * 0.85, rad, core, diamonds });
    }
  }

  // landing gear (AI aircraft never need it: they spawn airborne)
  const legs = [];
  if (full && def.gear) {
    const ground = -(spec.bellyH + spec.gearH) / sc;
    for (const [x, z, wr0] of def.gear) {
      const wr = wr0 || 0.3, top = -spec.bellyH / sc * 0.6, len = top - ground - wr;
      const leg = new THREE.Group();
      leg.position.set(x, top, z);
      const st = new THREE.Mesh(r.strut, r.metal); st.scale.set(wr * 0.3, len, wr * 0.3);
      const wh = new THREE.Mesh(r.wheel, r.tyre); wh.scale.set(wr * 0.7, wr, wr); wh.position.y = -len;
      leg.add(st, wh);
      inner.add(leg);
      legs.push(leg);
    }
  }

  // propellers / rotors
  const spinners = [];
  const addProp = (x, y, z, rad, blades, axis) => {
    const p = new THREE.Group();
    p.position.set(x, y, z);
    if (axis === 'y') p.rotation.x = -Math.PI / 2; else if (axis === 'x') p.rotation.y = Math.PI / 2;
    for (let i = 0; i < blades; i++) {
      const b = new THREE.Mesh(r.blade, r.tyre);
      b.scale.set(rad, Math.max(1, rad * 0.9), 1); b.rotation.z = i / blades * TAU;
      p.add(b);
    }
    const d = new THREE.Mesh(r.disc, r.blur); d.scale.setScalar(rad); p.add(d);
    inner.add(p);
    spinners.push({ p, rate: axis === 'y' ? 26 : axis === 'x' ? 60 : 55 });
  };
  for (const [x, y, z, rad, n] of def.props || []) addProp(x, y, z, rad, n, 'z');
  if (def.rotor) addProp(def.rotor[0], def.rotor[1], def.rotor[2], def.rotor[3], def.rotor[4], 'y');
  if (def.tailRotor) addProp(def.tailRotor[0], def.tailRotor[1], def.tailRotor[2], def.tailRotor[3], 3, 'x');

  // navigation lights
  const lights = [];
  if (full) {
    const mk = (mat, v, size) => { const s = new THREE.Sprite(mat); s.position.copy(v); s.scale.setScalar(size); g.add(s); lights.push(s); return s; };
    mk(r.red, ud.wingtips[0], 0.7); mk(r.green, ud.wingtips[1], 0.7);
    lights.strobe = mk(r.white, new THREE.Vector3(0, 0.3, zMax * sc), 2.2);
  }

  const fixed = !!def.fixedGear;
  ud.update = (dt, s) => {
    const gp = fixed ? 1 : s.gearPos;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      leg.visible = gp > 0.03;
      leg.rotation.x = (1 - gp) * (i === 0 ? -1.5 : 1.5);
    }
    for (let i = 0; i < flames.length; i++) {
      const f = flames[i], on = s.ab || s.thrEff > 0.55;
      f.fo.visible = f.fi.visible = on;
      f.core.visible = s.thrEff > 0.35;
      if (f.core.visible) { f.core.material.opacity = 1; f.core.scale.setScalar(f.rad * (1.1 + s.thrEff * 0.6 + (s.ab ? 0.5 : 0)) * (0.95 + Math.random() * 0.1)); }
      for (let k = 0; k < f.diamonds.length; k++) {
        const d = f.diamonds[k];
        d.visible = !!s.ab;
        if (d.visible) d.scale.setScalar(f.rad * (1.05 - k * 0.18) * (0.9 + Math.random() * 0.2));
      }
      if (!on) continue;
      const fl = 0.9 + Math.random() * 0.2;
      const len = (s.ab ? 5.5 : (s.thrEff - 0.5) * 2.2) * fl;
      f.fo.scale.set(f.r, f.r, len); f.fi.scale.set(f.r * 0.55, f.r * 0.55, len * 0.6);
    }
    for (let i = 0; i < movers.length; i++) {
      const m = movers[i];
      // pull: tail trailing edge up / canard leading edge up; fighters' tails also work as ailerons
      const want = m.mv === 'canard' ? s.pitch * 0.3 : -s.pitch * 0.32 - (m.mv === 'tail' ? m.sx * s.roll * 0.14 : 0);
      m.mesh.rotation.x += (want - m.mesh.rotation.x) * Math.min(1, dt * 12);
    }
    // missiles on the rails disappear as they are fired (outer pair last)
    const left = s.missiles ?? missiles.length;
    for (let i = 0; i < missiles.length; i++) missiles[i].visible = i < left;
    const sp = 0.35 + s.thrEff * 0.65;
    for (let i = 0; i < spinners.length; i++) spinners[i].p.rotation.z += dt * spinners[i].rate * sp;
    if (lights.strobe) {
      lights.strobe.visible = (s.time % 1.2) < 0.08;
      const k = s.night ? 1.6 : 0.7;        // the bloom (MED/HIGH) spreads them further
      lights[0].scale.setScalar(k); lights[1].scale.setScalar(k);
    }
  };
  ud.dispose = () => {};   // geometry + materials are cached and shared
  return g;
}

/** Keys with a mesh definition (used by tests). */
export const AIRCRAFT_MODELS = DEFS;
