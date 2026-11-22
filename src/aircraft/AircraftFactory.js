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
const X_AXIS = new THREE.Vector3(1, 0, 0), DOWN = new THREE.Vector3(0, -1, 0), _q1 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const HOSTILE = { top: 0x6d6552, bottom: 0x9a9c94, accent: 0x8c2f24 };

/* ------------------------------------------------------------------ data */
// S = surface: r = root [x, y, zLE, chord], t = tip, th = root thickness, m = mirror (default true), c = colour key
const FLANKER = {
  body: [[-11, .05, .05, .3], [-9.2, .42, .42, .3], [-7.2, .78, .82, .3], [-5.2, 1.0, 1.0, .2], [-2.5, 1.55, .9, .05], [1.5, 2.15, .75, -.05],
    [6, 2.15, .72, 0], [8.4, 1.95, .58, 0], [9.4, 1.5, .4, .05], [10.8, .3, .22, .15]],
  canopy: [[-7.9, .05, .05, 1.0], [-7.2, .4, .38, 1.02], [-6.2, .5, .56, 1.08], [-4.9, .45, .42, 1.05], [-3.8, .1, .1, 1.0]],
  surfs: [
    { r: [2.0, 0, -2.6, 7.2], t: [7.5, 0, 3.0, 2.0], th: .34, ctl: [['flaperon', .08, .6, .16, .27]] },
    { r: [2.0, 0, 6.0, 3.6], t: [4.9, 0, 8.6, 1.4], th: .16, mv: 'tail' },
    { r: [1.85, .6, 4.6, 3.6], t: [2.05, 4.0, 7.0, 1.5], th: .18, c: 'accent', ctl: [['rudder', .1, .75, .3, .36]] },
  ],
  brake: [0, -2.4, 2.6, 1.0, .85],
  nozzles: [[1.2, 0, 9.5, .62], [-1.2, 0, 9.5, .62]],
  intakes: [[1.15, -.92, -2.3, 4.6, .52, .5], [-1.15, -.92, -2.3, 4.6, .52, .5]],
  gear: [[0, -6.4, .28], [2.1, 1.2, .4], [-2.1, 1.2, .4]], twin: [1, 0, 0], muzzle: [0.9, .5, -6.5],
  fit: { tubes: [[7.5, 0, 2.5, 5.3, .09, 0x9aa0a6, .2]], blobs: [[0, .93, -8.05, .13, .13, .17, 0x16181c]] },
  marks: [['w', 0, .5, .4, 1.1, 1.1, 'star', 'tb'], ['w', 2, .52, .34, .8, .8, 'star', 'tb'], ['f', -6.3, .5, .9, .45, 'num'],
    ['f', -7.4, .22, 1.0, .11, 'slime'], ['f', 5.5, .25, 1.0, .11, 'slime'], ['w', 2, .86, .4, .11, .6, 'slime', 'tb'], ['w', 0, .93, .4, .1, .7, 'slime', 't']],
  col: { top: 0x4f7096, bottom: 0xa9bccb, accent: 0x3d5a7d },
};

const DEFS = {
  ef2000: {
    body: [[-8.4, .05, .05, .15], [-7.2, .3, .33, .12], [-5.6, .6, .7, .08], [-4.0, .85, .95, 0], [-2.2, 1.15, 1.0, 0], [1, 1.28, 1.0, 0],
      [4, 1.22, .95, .05], [6.2, 1.08, .8, .1], [7.3, .95, .62, .12], [7.4, .5, .35, .12]],
    canopy: [[-5.7, .05, .05, .78], [-5.1, .4, .4, .84], [-4.2, .5, .56, .9], [-3.1, .42, .42, .86], [-2.2, .1, .1, .8]],
    surfs: [
      { r: [.95, -.2, -2.3, 8.6], t: [5.45, -.2, 4.5, 1.3], th: .3, ctl: [['elevon', .06, .5, .116, .19], ['elevon', .52, .96, .2, .45]] },
      { r: [.75, .45, -5.7, 1.5], t: [2.35, .32, -4.5, .55], th: .1, mv: 'canard' },
      { r: [0, .85, 2.3, 4.3], t: [0, 4.0, 5.6, 1.3], th: .18, m: false, c: 'accent', ctl: [['rudder', .1, .92, .25, .36]] },
    ],
    brake: [0, -1.7, 2.3, .62, .8],
    nozzles: [[.56, .12, 7.4, .5], [-.56, .12, 7.4, .5]],
    intakes: [[0, -.98, -3.0, 1.4, .66, .42]],
    gear: [[0, -4.6, .25], [1.7, 1.2, .36], [-1.7, 1.2, .36]], muzzle: [.8, .3, -5.2],
    fit: { tubes: [[5.45, -.2, 3.7, 6.3, .13, 'top', .2]], blobs: [[.3, .52, -5.8, .09, .09, .16, 0x16181c, false]], fins: [[0, -.5, .5, .3, .28], [0, 2.6, .45, .3, .25, -1]] },
    marks: [['w', 0, .5, .42, .95, .95, 'lowvis', 'tb'], ['f', -3.0, .3, .66, .66, 'lowvis'], ['w', 2, .28, .4, .3, 1.2, 'serial1', 'tb'], ['w', 2, .62, .36, .42, .42, 'flash', 'tb'],
      ['f', -6.3, -.02, 1.0, .11, 'slime'], ['f', 3.4, .3, 1.0, .11, 'slime'], ['w', 2, .84, .35, .11, .6, 'slime', 'tb'], ['w', 0, .9, .4, .1, .7, 'slime', 't']],
    col: { top: 0x8794a1, bottom: 0xb9c3cc, accent: 0x76828f },
  },
  f22: {
    body: [[-9.4, .05, .05, .1], [-7.8, .45, .4, .1], [-6, .8, .75, .05], [-4, 1.5, .95, 0], [-1, 1.9, 1.0, 0], [3, 1.9, .95, 0],
      [6.5, 1.7, .7, .05], [8.2, 1.5, .45, .1], [8.3, .6, .2, .1]],
    canopy: [[-6.9, .05, .05, .8], [-6.2, .42, .4, .86], [-5.0, .52, .58, .93], [-3.9, .44, .42, .9], [-3.0, .1, .1, .82]],
    surfs: [
      { r: [1.7, 0, -2.6, 8.0], t: [6.7, 0, 3.2, 1.6], th: .3, ctl: [['flapBrake', .1, .5, .15, .23], ['ailUp', .52, .9, .23, .42]] },
      { r: [1.6, 0, 5.0, 3.6], t: [4.4, 0, 7.4, 1.2], th: .14, mv: 'tail' },
      { r: [1.5, .6, 3.4, 3.6], t: [2.9, 3.2, 5.6, 1.5], th: .16, c: 'accent', ctl: [['rudderBrake', .08, .9, .3, .36]] },
    ],
    nozzles: [[.75, .1, 8.2, .55], [-.75, .1, 8.2, .55]],
    intakes: [[1.5, -.12, -4.5, 1.0, .4, .58], [-1.5, -.12, -4.5, 1.0, .4, .58]],
    internalBay: true,
    gear: [[0, -5.6, .26], [1.6, 1.4, .38], [-1.6, 1.4, .38]], muzzle: [1.2, .6, -4.5],
    marks: [['w', 0, .45, .4, 1.0, 1.0, 'usaf', 'tb'], ['f', -3.0, .32, .8, .8, 'usaf'], ['w', 2, .4, .34, .6, .6, 'code', 'tb'], ['w', 2, .16, .38, .22, .88, 'serial2', 'tb'],
      ['f', -7.4, .18, 1.0, .11, 'slime'], ['f', 4.6, .25, 1.0, .11, 'slime'], ['w', 2, .78, .35, .11, .6, 'slime', 'tb'], ['w', 0, .9, .4, .1, .7, 'slime', 't']],
    col: { top: 0x6f7b86, bottom: 0x98a3ad, accent: 0x5d6873 },
  },
  su35: FLANKER,
  mig29: { ...FLANKER, scale: 0.79, col: { top: 0x7c8a7a, bottom: 0xaab4b8, accent: 0x5f6d5e } },
  a10: {
    body: [[-8, .05, .05, -.1], [-7, .45, .5, -.1], [-5, .7, .85, 0], [-2, .75, .9, 0], [3, .7, .8, 0], [6, .45, .5, .2], [8, .15, .2, .3]],
    canopy: [[-5.8, .05, .05, .75], [-5.2, .38, .4, .82], [-4.4, .46, .56, .88], [-3.5, .4, .42, .84], [-2.8, .1, .1, .78]],
    surfs: [
      { r: [.6, -.55, -1.6, 3.3], t: [8.7, -.1, -.9, 2.0], th: .42, ctl: [['flap', .08, .55, .28, .28], ['ailBrake', .58, .97, .3, .3]] },
      { r: [0, .3, 6.2, 1.9], t: [2.9, .3, 6.3, 1.7], th: .16, ctl: [['elev', .06, .95, .4, .4]] },
      { r: [2.9, .3, 6.2, 1.8], t: [2.9, 2.7, 6.6, 1.3], th: .14, c: 'accent', ctl: [['rudder', .1, .95, .36, .36]] },
    ],
    pods: [[1.35, 1.25, 2.0, 5.2, .78], [-1.35, 1.25, 2.0, 5.2, .78]],
    nozzles: [[1.35, 1.25, 5.2, .5], [-1.35, 1.25, 5.2, .5]],
    gear: [[0, -5.6, .3], [2.6, .2, .42], [-2.6, .2, .42]], muzzle: [0, -.5, -8.1],
    fit: { tubes: [[0, -.4, -8.55, -7.0, .1, 0x26282a, .04]], blobs: [[.92, .85, 3.5, .32, .3, 1.5, 'top'], [2.6, -.7, -.5, .27, .27, 1.7, 'top']], fins: [[0, -1.5, .8, .32, .3]] },
    marks: [['w', 0, .6, .36, .8, .8, 'usaf', 'tb'], ['f', .6, .2, .7, .7, 'usaf'], ['w', 2, .55, .3, .5, .5, 'code', 'tb'], ['w', 2, .22, .32, .16, .64, 'serial2', 'tb'],
      ['f', -6.4, .0, .9, .11, 'slime'], ['f', 4.6, .25, .9, .11, 'slime'], ['w', 2, .86, .35, .11, .55, 'slime', 'tb'], ['w', 0, .95, .4, .1, .7, 'slime', 't']],
    col: { top: 0x6c7772, bottom: 0x8f9a98, accent: 0x5a6560 },
  },
  spitfire: {
    body: [[-4.25, .22, .22, 0], [-3.6, .5, .55, 0], [-1.5, .55, .7, 0], [.5, .5, .7, .05], [3, .26, .4, .2], [4.8, .05, .15, .3]],
    canopy: [[-.8, .05, .05, .62], [-.4, .3, .3, .7], [.2, .34, .4, .76], [.9, .3, .3, .72], [1.5, .05, .05, .62]],
    surfs: [
      { r: [.45, -.5, -1.9, 2.6], t: [3.4, -.32, -1.6, 2.1], th: .3, ctl: [['flap', .1, .98, .2, .2]], open: true },
      { r: [3.4, -.32, -1.6, 2.1], t: [5.55, -.2, -.9, .8], th: .24, ctl: [['ail', .02, .8, .25, .32]] },
      { r: [.15, .3, 3.6, 1.2], t: [1.7, .3, 3.9, .6], th: .1, ctl: [['elev', .1, .95, .42, .45]] },
      { r: [0, .3, 3.4, 1.5], t: [0, 1.7, 4.2, .7], th: .1, m: false, ctl: [['rudder', .05, .95, .45, .5]] },
    ],
    props: [[0, 0, -4.35, 1.6, 4]],
    gear: [[0, 4.4, .13, 0, 1.16], [1.05, -1.6, .32], [-1.05, -1.6, .32]], muzzle: [2.2, -.35, -2.2],
    fit: {
      rods: [...[-3.35, -3.12, -2.89, -2.66, -2.43, -2.2].map(z => [[.5, .2, z], [.64, .21, z + .2], .04, 0x3a2e26]),
        [[2.1, -.42, -1.6], [2.1, -.42, -2.55], .04, 0x26282a], [[0, .68, 1.55], [0, 1.25, 1.75], .02, 0x3a3c3e]],
      blobs: [[1.4, -.68, -.3, .3, .13, .75, 'bottom']],
    },
    marks: [['w', 0, .8, .4, 1.0, 1.0, 'raf', 'tb'], ['f', 1.75, .16, .6, .6, 'raf'], ['w', 3, .35, .26, .4, .4, 'flash', 'tb']],
    col: { top: 0x5b6b4c, bottom: 0xa9c0cc, accent: 0x6e5a40 },
  },
  c172: {
    body: [[-3.35, .25, .25, 0], [-2.6, .5, .5, 0], [-1.2, .58, .72, .1], [.8, .58, .72, .1], [2.4, .3, .4, .25], [4.9, .08, .15, .4]],
    canopy: [[-1.75, .1, .1, .55], [-1.3, .5, .34, .52], [.4, .5, .34, .52], [.9, .1, .1, .5]],
    surfs: [
      { r: [0, .93, -1.3, 1.65], t: [5.5, .97, -1.2, 1.2], th: .2, ctl: [['flap', .12, .5, .26, .26], ['ail', .52, .95, .26, .26]] },
      { r: [.1, .4, 4.0, 1.1], t: [1.7, .4, 4.2, .7], th: .08, ctl: [['elev', .1, .95, .4, .42]] },
      { r: [0, .5, 3.6, 1.5], t: [0, 1.9, 4.6, .7], th: .08, m: false, c: 'accent', ctl: [['rudder', .08, .95, .4, .45]] },
    ],
    props: [[0, 0, -3.45, .95, 2]],
    gear: [[0, -2.3, .2], [1.2, .1, .22, .5], [-1.2, .1, .22, .5]], fixedGear: true, muzzle: [0, 0, -3.5],
    fit: {
      rods: [[[.55, -.5, -.55], [2.7, .86, -.62], .04, 'top'], [[.3, -.45, -2.65], [.3, -.66, -2.3], .03, 0x5a5c5e, false]],
      blobs: [[1.2, -1.43, .1, .12, .19, .44, 'accent'], [0, -1.45, -2.3, .11, .18, .4, 'accent']],
    },
    marks: [['f', 2.75, .3, 1.0, .25, 'reg1']],
    col: { top: 0xe9ecee, bottom: 0xdfe3e6, accent: 0xb5322c },
  },
  a320: {
    body: [[-19, .1, .1, -.4], [-17.6, 1.15, 1.2, -.25], [-15.2, 1.85, 1.95, 0], [-12, 2.0, 2.07, 0], [8, 2.0, 2.07, 0], [14, 1.3, 1.5, .5], [18.6, .3, .4, 1.2]],
    canopy: [[-17.9, .05, .05, .55], [-17.3, .95, .3, .62], [-16.2, 1.5, .4, .98], [-15.8, 1.2, .1, 1.3]],
    surfs: [
      { r: [1.9, -1.2, -4.6, 7.0], t: [17, -.1, 4.4, 1.6], th: .7, ctl: [['flap', .05, .72, .2, .27], ['ail', .76, .95, .27, .3]], spoiler: [.2, .68, .62, .78] },
      { r: [1.0, .8, 14.0, 3.6], t: [6.2, 1.1, 17.0, 1.3], th: .3, ctl: [['elev', .06, .95, .3, .33]] },
      { r: [0, 1.6, 11.5, 5.5], t: [0, 7.6, 16.6, 2.0], th: .35, m: false, c: 'accent', ctl: [['rudder', .08, .95, .3, .33]] },
      { r: [17, -.1, 4.5, 1.5], t: [17.45, 2.3, 5.95, .55], th: .1, c: 'accent', fx: true },          // sharklets
      { r: [5.8, -1.15, -5.1, 3.4], t: [5.8, -.8, -3.5, 2.4], th: .3, c: 'bottom', fx: true },       // engine pylons
    ],
    fit: { blobs: [[4.2, -1.36, 2.1, .18, .24, 1.7, 'bottom'], [8.5, -1.0, 3.1, .16, .22, 1.6, 'bottom'], [12, -.69, 4.0, .14, .18, 1.3, 'bottom']], fins: [[0, -7, .5, .45, .45], [0, 2, .45, .4, .4, -1]],
      panes: [[-16.85, .66, .5, .4, .3], [-16.3, .825, .5, .42, .3], [-15.75, .99, .5, .42, .3]] },
    marks: [['f', -9.4, 1.22, 5.2, .65, 'title'], ['f', 11.6, 1.0, 1.8, .45, 'reg2'], ['w', 2, .5, .36, 2.2, 2.2, 'logo', 'tb'],
      ...[0, 1, 2, 3].map(i => ['f', -14.4 + (8 * i + 3.5) * .7, .62, 5.6, .44, 'cabin']), ['f', -16.3, .825, 1.6, .42, 'deck', .3]],
    pods: [[5.8, -2.0, -5.6, -1.6, 1.08], [-5.8, -2.0, -5.6, -1.6, 1.08]],
    nozzles: [[5.8, -2.0, -1.6, .7], [-5.8, -2.0, -1.6, .7]],
    gear: [[0, -15, .4], [3.6, 1.5, .55], [-3.6, 1.5, .55]], twin: [1, 1, 1], muzzle: [0, 0, -19], noPilot: true,
    windows: { z0: -14.4, z1: 7.95, pitch: 0.7, y: 0.62, stripe: [-0.05, 0.16] },
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
    marks: [['w', 0, .6, .45, 2.2, 2.2, 'star', 'tb'], ['w', 2, .5, .4, 1.6, 1.6, 'star', 'tb']],
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
    gear: [[0, -5.5, .28], [1.5, .3, .32, .8], [-1.5, .3, .32, .8]], fixedGear: true, muzzle: [0, -1.1, -7.6],
    fit: {
      tubes: [[2.6, -.95, -1.5, .5, .2, 0x4a5040, .12]],
      blobs: [[.45, 1.3, -2.3, .34, .34, 1.5, 'top'], [.45, 1.3, -3.62, .26, .26, .14, 0x0c0d0e], [0, -1.18, -7.25, .2, .17, .3, 0x30342c]],
      rods: [[[.9, 1.2, -.9], [1.3, 1.26, -.65], .15, 0x2c2a28], [[0, -1.22, -7.4], [0, -1.26, -8.3], .035, 0x1c1e20], [[3.3, -.72, -.7], [3.3, -1.02, -.7], .03, 0x4a5040], [[3.3, -1.02, -1.3], [3.3, -1.02, .1], .05, 0x4a5040]],
    },
    marks: [['f', 4.6, .52, .52, .52, 'star'], ['f', -1.3, -.15, .9, .45, 'num']],
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

/* ---- lifting surfaces: tapered wings with a real aerofoil section and hinged trailing-edge controls ---- */
// half thickness of a NACA 00xx section at chord fraction x, as a fraction of the maximum thickness
const AF = (x) => 5 * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);
const S_FULL = [0, .012, .05, .12, .25, .42, .62, .82, 1], S_PART = [0, .35, .7, 1];
const _wn = new THREE.Vector3(), _wp = new THREE.Vector3(), _mx = new THREE.Matrix4(), _mi = new THREE.Matrix4();
const _hx = new THREE.Vector3(), _hy = new THREE.Vector3(), _hz = new THREE.Vector3();

/** Section of the surface {r, t, th} at span fraction u: leading edge, chord, thickness. */
function wsec(s, u, sx) {
  const r = s.r, t = s.t, L = (a, b) => a + (b - a) * u;
  return { x: L(r[0], t[0]) * sx, y: L(r[1], t[1]), z: L(r[2], t[2]), c: L(r[3], t[3]), h: Math.max(0.05, s.th * L(1, t[3] / r[3])) };
}
/** Point on a section: chord fraction x, side +1 top / −1 bottom / 0 chord line. `_wn` = thickness direction. */
const wpt = (P, x, side, v = new THREE.Vector3()) => v.set(P.x + _wn.x * side * P.h * AF(x), P.y + _wn.y * side * P.h * AF(x), P.z + P.c * x + _wn.z * side * P.h * AF(x));

/**
 * One spanwise piece of a surface between sections A and B, covering chord fractions a0..a1 at A and
 * b0..b1 at B. Smooth round the leading edge, sharp at the trailing edge; flat closing faces and end caps.
 */
function wpatch(out, A, B, a0, a1, b0, b1, hexT, hexB, flip, capA, capB) {
  const S = a0 === 0 ? S_FULL : S_PART, m = S.length - 1, lead = a0 === 0;
  const ring = (P, x0, x1) => {
    const pts = [];
    for (let i = m; i >= (lead ? 1 : 0); i--) pts.push([wpt(P, x0 + (x1 - x0) * S[i], -1), 0]);
    for (let i = 0; i <= m; i++) pts.push([wpt(P, x0 + (x1 - x0) * S[i], 1), 1]);
    return pts;
  };
  const ra = ring(A, a0, a1), rb = ring(B, b0, b1), K = ra.length;
  const pos = new Float32Array(K * 6), col = new Float32Array(K * 6);
  _c1.setHex(hexT); _c2.setHex(hexB);
  [ra, rb].forEach((rg, j) => rg.forEach(([p, top], k) => {
    const o = (j * K + k) * 3, c = top ? _c1 : _c2;
    pos[o] = p.x; pos[o + 1] = p.y; pos[o + 2] = p.z; col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
  }));
  const idx = [];
  for (let k = 0; k < K - 1; k++) { const a = k, b = k + 1, c = K + k, d = K + k + 1; if (flip) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const f = g.toNonIndexed();
  out.pos.push(...f.attributes.position.array); out.nor.push(...f.attributes.normal.array); out.col.push(...f.attributes.color.array);
  g.dispose(); f.dispose();
  // flat faces
  _ctr.set(0, 0, 0); for (const [p] of ra) _ctr.add(p); for (const [p] of rb) _ctr.add(p); _ctr.multiplyScalar(1 / (2 * K));
  const ctr = _ctr.clone(), cT = _c1.setHex(hexT).clone();
  if (a1 < 1 || b1 < 1) { _ctr.copy(ctr); quad(out, ra[0][0], rb[0][0], rb[K - 1][0], ra[K - 1][0], cT); }
  for (const [rg, on] of [[ra, capA], [rb, capB]]) {
    if (!on) continue;
    const c = new THREE.Vector3(); for (const [p] of rg) c.add(p); c.multiplyScalar(1 / K);
    for (let k = 0; k < K; k++) { _ctr.copy(ctr); tri(out, c, rg[k][0], rg[(k + 1) % K][0], cT); }
  }
}

/** Re-express freshly built geometry `o` in a hinge frame (origin p, x along the hinge d, z aft); returns the mover record. */
function hinged(o, p, d, kind, sx) {
  _hx.copy(d).normalize();
  _hz.set(0, 0, 1).addScaledVector(_hx, -_hx.z).normalize();
  _hy.crossVectors(_hz, _hx);
  _mx.makeBasis(_hx, _hy, _hz).setPosition(p);
  const geo = toMesh(o, null).geometry;
  geo.applyMatrix4(_mi.copy(_mx).invert());
  return { geo, pos: p.clone(), quat: new THREE.Quaternion().setFromRotationMatrix(_mx), sx, kind };
}

/**
 * A whole surface (one side). With `movers`, its `ctl` entries [kind, u0, u1, f0, f1] (span range, chord
 * fraction at each end) become separate hinged meshes and `spoiler` [u0, u1, x0, x1] a plate on the top skin.
 */
function wing(out, s, hexT, hexB, sx, movers) {
  // thickness direction, from the sx = +1 side and mirrored so "top" stays the same face
  _ab.set(s.t[0] - s.r[0], s.t[1] - s.r[1], s.t[2] - s.r[2]);
  _wn.set(0, 0, 1).cross(_ab).normalize(); _wn.x *= sx;
  if (Math.abs(_wn.y) < 0.7) hexB = hexT;                     // fins: one colour both sides
  const flip = sx < 0, ctl = movers ? (s.ctl || []) : [];
  let u = 0;
  const S = (v) => wsec(s, v, sx);
  for (const [kind, u0, u1, f0, f1] of ctl) {
    if (u0 > u) wpatch(out, S(u), S(u0), 0, 1, 0, 1, hexT, hexB, flip, u === 0 && !s.open, true);
    const A = S(u0), B = S(u1);
    wpatch(out, A, B, 0, 1 - f0, 0, 1 - f1, hexT, hexB, flip, false, false);
    const o = { pos: [], nor: [], col: [] };
    wpatch(o, A, B, 1 - f0 + 0.004, 1, 1 - f1 + 0.004, 1, hexT, hexB, flip, true, true);
    const pa = wpt(A, 1 - f0, 0), pb = wpt(B, 1 - f1, 0);
    movers.push(hinged(o, pa, pb.sub(pa), kind, sx));
    u = u1;
  }
  wpatch(out, S(u), S(1), 0, 1, 0, 1, hexT, hexB, flip, u > 0, true);
  if (movers && s.spoiler) {
    const [u0, u1, x0, x1] = s.spoiler, A = S(u0), B = S(u1), o = { pos: [], nor: [], col: [] };
    const lift = (P, x, k) => wpt(P, x, 1).addScaledVector(_wn, k);
    const c = _c1.setHex(hexT).multiplyScalar(0.9).clone();
    const a0 = lift(A, x0, .012), a1 = lift(A, x1, .012), b0 = lift(B, x0, .012), b1 = lift(B, x1, .012);
    const A0 = lift(A, x0, .04), A1 = lift(A, x1, .04), B0 = lift(B, x0, .04), B1 = lift(B, x1, .04);
    _ctr.copy(a0).add(b1).add(A0).add(B1).multiplyScalar(0.25);
    quad(o, A0, B0, B1, A1, c); quad(o, a0, b0, b1, a1, c); quad(o, a1, b1, B1, A1, c); quad(o, a0, A0, A1, a1, c); quad(o, b0, B0, B1, b1, c);
    movers.push(hinged(o, a0.clone(), b0.clone().sub(a0), 'spoiler', sx));
  }
}

/** A straight rod (hexagonal prism) between two points; flat ends. */
function rod(out, a, b, r, hex) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A).normalize();
  const u = new THREE.Vector3().crossVectors(d, Math.abs(d.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : X_AXIS).normalize(), v = new THREE.Vector3().crossVectors(d, u);
  const col = _c1.setHex(hex).clone(), N = 6, ra = [], rb = [], mid = A.clone().add(B).multiplyScalar(0.5);
  for (let i = 0; i < N; i++) {
    const an = i / N * TAU, o = u.clone().multiplyScalar(Math.cos(an) * r).addScaledVector(v, Math.sin(an) * r);
    ra.push(A.clone().add(o)); rb.push(B.clone().add(o));
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    _ctr.copy(mid); quad(out, ra[i], ra[j], rb[j], rb[i], col);
    _ctr.copy(mid); tri(out, A, ra[i], ra[j], col);
    _ctr.copy(mid); tri(out, B, rb[i], rb[j], col);
  }
}

/**
 * One propeller / rotor blade along +x (root at the hub, tip at x = 1), in the plane of the disc (z = axis):
 * tapered plan-form, lens section, washout twist; painted tip.
 */
function bladeGeo(rotor) {
  const N = 10, K = 6, pos = [], col = [];
  _c1.setHex(rotor ? 0x34383a : 0x191b1d); _c2.setHex(rotor ? 0xc9c4b4 : 0xd9a81c);
  for (let i = 0; i <= N + 1; i++) {
    const t = Math.min(1, i / N), x = 0.07 + t * 0.93 + (i > N ? 0.006 : 0);
    let c = rotor ? 0.064 * (t < 0.08 ? 0.45 : 1) : 0.045 + 0.105 * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.08) ** 0.9) * (1 - t * 0.3);
    if (i > N) c *= 0.35;
    const tw = rotor ? 0.16 - 0.12 * t : 1.0 - 0.72 * t, th = c * (rotor ? 0.12 : 0.2 * (1.25 - t * 0.6));
    const cs = Math.cos(tw), sn = Math.sin(tw), tip = t > (rotor ? 0.955 : 0.9) ? _c2 : _c1;
    for (const [a, n] of [[-0.35, 0], [-0.1, 0.5], [0.3, 0.36], [0.65, 0], [0.3, -0.36], [-0.1, -0.5]]) {
      pos.push(x, a * c * cs - n * th * sn, a * c * sn + n * th * cs); col.push(tip.r, tip.g, tip.b);
    }
  }
  const idx = [];
  for (let i = 0; i <= N; i++) for (let k = 0; k < K; k++) { const a = i * K + k, b = i * K + (k + 1) % K, c = a + K, d = b + K; idx.push(a, c, b, b, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** Motion-blur disc for a spinning propeller / rotor: faint streaked annulus, bright tip ring. */
function blurTexture(tipRgb) {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d'), gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(30,33,38,0)'); gr.addColorStop(0.12, 'rgba(30,33,38,0.05)'); gr.addColorStop(0.5, 'rgba(30,33,38,0.26)');
  gr.addColorStop(0.9, 'rgba(30,33,38,0.14)'); gr.addColorStop(0.925, `rgba(${tipRgb},0.2)`); gr.addColorStop(0.985, `rgba(${tipRgb},0.2)`); gr.addColorStop(1, 'rgba(30,33,38,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---- markings: one atlas texture, decal quads draped over the wing and fuselage surfaces ---- */
const CELLS = {
  raf: [0, 0, 128, 128], lowvis: [128, 0, 128, 128], usaf: [256, 0, 128, 128], star: [384, 0, 128, 128],
  hostile: [0, 128, 128, 128], flash: [128, 128, 128, 128], logo: [256, 128, 128, 128], code: [384, 128, 128, 128],
  title: [0, 256, 512, 64], serial1: [0, 320, 256, 64], serial2: [256, 320, 256, 64], num: [0, 384, 128, 64], reg1: [256, 384, 256, 64],
  reg2: [0, 448, 256, 64], hnum: [256, 448, 128, 64], slime: [392, 456, 112, 28], cabin: [0, 520, 512, 40], deck: [0, 572, 128, 34],
};
const ATLAS_H = 640;
const HOSTILE_CELL = { raf: 'hostile', lowvis: 'hostile', usaf: 'hostile', star: 'hostile', num: 'hnum', slime: 'slime' };

/** `glow` = the emissive twin of the atlas: only what lights up at night (formation strips, cabin and flight-deck windows, tail logo). */
function markAtlas(glow = false) {
  const c = document.createElement('canvas'); c.width = 512; c.height = ATLAS_H;
  const g = c.getContext('2d');
  // formation-light strip; cabin window row (8 windows, some blinds down); flight-deck glazing
  g.fillStyle = glow ? '#000' : 'rgba(0,0,0,0)'; g.fillRect(0, 0, 512, ATLAS_H);
  if (!glow) { g.fillStyle = '#4c503c'; g.fillRect(392, 456, 112, 28); }
  g.fillStyle = glow ? '#b9e04a' : '#c9cf9a'; g.fillRect(396, 460, 104, 20);
  for (let i = 0; i < 8; i++) {
    const x = i * 64 + 32 - 11, lit = [1, 1, 0.25, 1, 0.8, 1, 0, 0.9][i];
    g.fillStyle = glow ? `rgb(${255 * lit | 0},${214 * lit | 0},${150 * lit | 0})` : '#141a22';
    g.beginPath(); g.roundRect(x, 524, 22, 31, 8); g.fill();
  }
  g.fillStyle = glow ? '#0d1c1a' : '#10151c'; g.fillRect(0, 572, 128, 34);
  if (glow) {
    g.globalAlpha = 0.55; g.strokeStyle = '#ffffff'; g.lineCap = 'round'; g.lineWidth = 9;
    for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(276 + i * 6, 228 - i * 16); g.quadraticCurveTo(320, 190 - i * 18, 368 - i * 10, 176 - i * 12); g.stroke(); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  }
  const disc = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); };
  const star = (x, y, r, col) => {
    g.fillStyle = col; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, q = i % 2 ? r * 0.4 : r; g.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
    g.closePath(); g.fill();
  };
  // roundels
  disc(64, 64, 60, '#1f3a7a'); disc(64, 64, 40, '#eef0f0'); disc(64, 64, 20, '#b8262a');
  disc(192, 64, 60, '#5d7391'); disc(192, 64, 26, '#b98f95');
  // star and bar (low visibility)
  g.fillStyle = '#3d444c'; g.fillRect(262, 50, 116, 28); disc(320, 64, 36, '#3d444c');
  g.fillStyle = '#8f98a2'; g.fillRect(266, 54, 108, 20); disc(320, 64, 32, '#8f98a2'); star(320, 64, 30, '#3d444c');
  // red star
  star(448, 66, 62, '#f2f2ee'); star(448, 66, 52, '#c0201c');
  // hostile: red triangle, black edge
  const triangle = (r, col) => { g.fillStyle = col; g.beginPath(); g.moveTo(64, 128 + 70 + r); g.lineTo(64 - r * 0.95, 128 + 70 - r * 0.62); g.lineTo(64 + r * 0.95, 128 + 70 - r * 0.62); g.closePath(); g.fill(); };
  triangle(60, '#101010'); triangle(46, '#c8201a'); disc(64, 128 + 58, 12, '#f0d020');
  // fin flash
  g.fillStyle = '#b8262a'; g.fillRect(140, 150, 35, 84); g.fillStyle = '#eef0f0'; g.fillRect(175, 150, 34, 84); g.fillStyle = '#1f3a7a'; g.fillRect(209, 150, 35, 84);
  // airline tail logo: a white wing
  g.strokeStyle = '#ffffff'; g.lineCap = 'round'; g.lineWidth = 9;
  for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(276 + i * 6, 228 - i * 16); g.quadraticCurveTo(320, 190 - i * 18, 368 - i * 10, 176 - i * 12); g.stroke(); }
  // stencilled text
  const text = (t, x, y, w, h, col, font = 'bold 50px monospace', edge = null) => {
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (edge) { g.strokeStyle = edge; g.lineWidth = 6; g.lineJoin = 'round'; g.strokeText(t, x + w / 2, y + h / 2 + 2, w - 8); }
    g.fillStyle = col; g.fillText(t, x + w / 2, y + h / 2 + 2, w - 8);
  };
  text('FF', 384, 128, 128, 128, '#353b42', 'bold 92px sans-serif');
  text('OPENWINGS', 0, 256, 512, 64, '#1f4f9c', 'italic bold 58px sans-serif');
  text('ZK349', 0, 320, 256, 64, '#30363c'); text('AF 09 191', 256, 320, 256, 64, '#353b42', 'bold 44px monospace');
  text('52', 0, 384, 128, 64, '#c0201c', 'bold 60px sans-serif', '#f2f2ee'); text('G-OWNG', 256, 384, 256, 64, '#20242a', 'bold 56px sans-serif');
  text('D-AOWN', 0, 448, 256, 64, '#20242a', 'bold 52px sans-serif'); text('13', 256, 448, 128, 64, '#f0d020', 'bold 60px sans-serif', '#101010');
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

const _dn = new THREE.Vector3(), _dr = new THREE.Vector3(), _du = new THREE.Vector3();
/** Drape a decal over a surface: fn(a, b) → point for a, b in −½..½; `hint` = roughly outward, `up` = which way is up on it. */
function decal(out, fn, hint, up, cellName) {
  const n = 4, P = [], cell = CELLS[cellName];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) P.push(fn(i / n - 0.5, j / n - 0.5).clone());
  const c = P[(n / 2) * (n + 1) + n / 2];
  _ab.subVectors(P[(n / 2) * (n + 1) + n], P[(n / 2) * (n + 1)]); _ac.subVectors(P[n * (n + 1) + n / 2], P[n / 2]);
  _dn.crossVectors(_ab, _ac).normalize(); if (_dn.dot(hint) < 0) _dn.negate();
  _dr.crossVectors(up, _dn).normalize(); _du.crossVectors(_dn, _dr);
  let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
  const ab = P.map(p => { _fc.subVectors(p, c); const a = _fc.dot(_dr), b = _fc.dot(_du); a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); return [a, b]; });
  const put = (k) => {
    const p = P[k], [a, b] = ab[k];
    out.pos.push(p.x + _dn.x * 0.012, p.y + _dn.y * 0.012, p.z + _dn.z * 0.012); out.nor.push(_dn.x, _dn.y, _dn.z);
    out.uv.push((cell[0] + 1 + (a - a0) / (a1 - a0) * (cell[2] - 2)) / 512, 1 - (cell[1] + 1 + (1 - (b - b0) / (b1 - b0)) * (cell[3] - 2)) / ATLAS_H);
  };
  // wind the triangles to face along the normal (a double-sided material lights back faces with a flipped normal)
  const flip = _fc.crossVectors(_ab, _ac).dot(_dn) < 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * (n + 1) + i;
    if (flip) { put(k); put(k + n + 1); put(k + 1); put(k + 1); put(k + n + 1); put(k + n + 2); }
    else { put(k); put(k + 1); put(k + n + 1); put(k + 1); put(k + n + 2); put(k + n + 1); }
  }
}

/** fn(a, b) for a patch on the fuselage side: centre station zc, height y, size w × h, side ±1. */
function fusePatch(B, zc, y, w, h, side, slope = 0) {
  const v = new THREE.Vector3();
  return (a, b) => {
    const z = zc + a * w, yy = y + b * h + slope * a * w, [bw, bh, yc, xc = 0] = bodyAt(B, z);
    const sn = Math.min(0.985, Math.abs((yy - yc) / bh) ** (1 / 0.85));
    return v.set(side * (xc + bw * Math.sqrt(1 - sn * sn) ** 0.85), yy, z);
  };
}

function toMesh(out, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(out.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(out.col, 3));
  g.computeBoundingSphere();
  return new THREE.Mesh(g, mat);
}

/** Fuselage half-width, half-height and centre height at station z (linear between the defining sections). */
function bodyAt(b, z) {
  let i = 0; while (i < b.length - 2 && b[i + 1][0] < z) i++;
  const t = Math.min(1, Math.max(0, (z - b[i][0]) / (b[i + 1][0] - b[i][0])));
  return [b[i][1] + (b[i + 1][1] - b[i][1]) * t, b[i][2] + (b[i + 1][2] - b[i][2]) * t, b[i][3] + (b[i + 1][3] - b[i][3]) * t, 0];
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
  const blade = bladeGeo(false), rotorBlade = bladeGeo(true);
  const hubGeo = new THREE.CylinderGeometry(1, 1, 1, 12); hubGeo.rotateX(Math.PI / 2);
  // tyre: a rounded section revolved about the axle (x)
  const tyreGeo = new THREE.LatheGeometry([[0.56, -0.46], [0.8, -0.5], [0.94, -0.42], [1, -0.22], [1, 0.22], [0.94, 0.42], [0.8, 0.5], [0.56, 0.46]].map(([a, b]) => new THREE.Vector2(a, b)), 20);
  tyreGeo.rotateZ(Math.PI / 2);
  const light = (c) => new THREE.SpriteMaterial({ map: glow, color: c, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  R = {
    glow, flame, strut, wheel, blade, rotorBlade, hubGeo, tyreGeo,
    bladeMat: new THREE.MeshStandardMaterial({ vertexColors: true, color: new THREE.Color(1.5, 1.5, 1.5), roughness: 0.5, metalness: 0.25, side: THREE.DoubleSide }),
    decal: new THREE.MeshStandardMaterial({ map: markAtlas(), emissiveMap: markAtlas(true), emissive: 0xffffff, emissiveIntensity: 0, color: new THREE.Color(1.5, 1.5, 1.5), roughness: 0.62, metalness: 0.05, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), box: new THREE.BoxGeometry(1, 1, 1), disc: new THREE.CircleGeometry(1, 20),
    // colour > 1: scene lights are balanced for the custom terrain shader; standard materials come out too dark
    // military: matte paint over metal. Colour > 1 because the scene lights are balanced for the custom
    // terrain shader; tuned together with the sky reflection environment (Environment.buildEnvMap)
    skin: new THREE.MeshPhysicalMaterial({ vertexColors: true, color: new THREE.Color(1.55, 1.55, 1.55), roughness: 0.58, metalness: 0.12, side: THREE.DoubleSide, envMapIntensity: 0.55 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x2a3a46, roughness: 0.04, metalness: 0.55, transparent: true, opacity: 0.6, envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.03 }),
    missile: missileGeo(),
    metal: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.6, 1.62, 1.65), roughness: 0.5, metalness: 0.2 }),
    tyre: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.92, metalness: 0 }),
    hub: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.5, 1.52, 1.55), roughness: 0.38, metalness: 0.55 }),
    chrome: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.9, 1.92, 1.96), roughness: 0.16, metalness: 1 }),
    gearPaint: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.75, 1.77, 1.8), roughness: 0.5, metalness: 0.1 }),
    door: new THREE.MeshStandardMaterial({ color: new THREE.Color(1.3, 1.33, 1.36), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide }),
    lamp: new THREE.SpriteMaterial({ map: glow, color: new THREE.Color(2.6, 2.5, 2.2), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }),
    blur: new THREE.MeshBasicMaterial({ map: blurTexture('30,33,38'), transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }),
    blurProp: new THREE.MeshBasicMaterial({ map: blurTexture('217,168,28'), transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
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
  for (const m of [R.skin, R.skinCivil, R.metal, R.tyre, R.hub, R.gearPaint, R.door, R.bladeMat, R.decal]) shadeAir(m);     // mountain and cloud shadows fall on aircraft
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
    const wdef = def.windows, at = (z) => bodyAt(def.body, z);
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
    const hex = col[s.c] || col.top, hexB = s.c ? hex : col.bottom;
    for (const sx of s.m === false ? [1] : [1, -1]) {
      if (full && s.mv) {
        // all-moving surface: its own little mesh, hinged at 45 % root chord
        const py = s.r[1], pz = s.r[2] + s.r[3] * 0.45;
        const o = { pos: [], nor: [], col: [] };
        wing(o, { r: [s.r[0], 0, s.r[2] - pz, s.r[3]], t: [s.t[0], s.t[1] - py, s.t[2] - pz, s.t[3]], th: s.th }, hex, hexB, sx, null);
        movers.push({ geo: toMesh(o, null).geometry, pos: new THREE.Vector3(0, py, pz), quat: new THREE.Quaternion(), sx, kind: s.mv });
      } else wing(out, s, hex, hexB, sx, full && !s.fx ? movers : null);
    }
  }
  // dorsal airbrake: a panel on the spine, hinged at its front edge  [x, z, length, width, max angle]
  if (full && def.brake) {
    const [bx, bz, bl, bw] = def.brake, top = (z) => { const [, h, yc] = bodyAt(def.body, z); return yc + h; };
    const o = { pos: [], nor: [], col: [] }, c = _c1.setHex(col.top).multiplyScalar(0.92).clone();
    const y0 = top(bz) + 0.02, y1 = top(bz + bl) + 0.02, V = (x, y, z) => new THREE.Vector3(x, y, z), hw = bw / 2;
    const a = V(bx - hw, y0, bz), b = V(bx + hw, y0, bz), cc = V(bx + hw * 0.7, y1, bz + bl), d = V(bx - hw * 0.7, y1, bz + bl), up = V(0, 0.05, 0);
    const A = a.clone().add(up), B = b.clone().add(up), C = cc.clone().add(up), D = d.clone().add(up);
    _ctr.copy(a).add(cc).multiplyScalar(0.5).add(up.multiplyScalar(0.5));
    quad(o, A, B, C, D, c); quad(o, a, b, cc, d, c); quad(o, a, A, D, d, c); quad(o, b, B, C, cc, c); quad(o, d, D, C, cc, c); quad(o, a, A, B, b, c);
    const m = hinged(o, V(bx, y0, bz), V(1, 0, 0), 'brake', 1);
    m.max = def.brake[4];
    movers.push(m);
  }
  // tail hook (carrier landings): a bar under the rear fuselage, hinged at its front end, stowed flat
  // along the belly; lowered it swings ~40 deg down with a yellow hook shoe at the tip
  if (full && !def.rotor && !def.noPilot) {
    const zs = def.body.map(b => b[0]), zEnd = Math.max(...zs), zh = zEnd - Math.min(3.4, (zEnd - Math.min(...zs)) * 0.2);
    const [, hh, yc] = bodyAt(def.body, zh), yb = yc - hh - 0.06, L = Math.min(2.8, zEnd - zh + 0.5);
    const o = { pos: [], nor: [], col: [] };
    rod(o, [0, yb, zh], [0, yb, zh + L], 0.07, 0x2c2e30);
    rod(o, [0, yb, zh + L - 0.12], [0, yb - 0.24, zh + L + 0.06], 0.085, 0xd8b020);
    movers.push(hinged(o, new THREE.Vector3(0, yb, zh), new THREE.Vector3(1, 0, 0), 'hook', 1));
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
  // type-specific fittings: pods, fairings, probes, struts, aerials, flight-deck side windows
  const F = def.fit || {}, hexOf = (c) => typeof c === 'number' ? c : (col[c] || col.top);
  const sides = (x, m) => (x !== 0 && m !== false ? [1, -1] : [1]);
  for (const [x, y, z, rx, ry, rz, c = 'top', m] of F.blobs || []) for (const sd of sides(x, m)) loft(out, blob(z, rx, ry, rz, y, sd * x), hexOf(c), c === 'top' ? col.bottom : hexOf(c), 10, 1);
  for (const [x, y, za, zb, r, c = 'top', nose = 0.3, m] of F.tubes || []) for (const sd of sides(x, m)) {
    const L = zb - za;
    loft(out, [[za, .01, .01, y, sd * x], [za + L * nose * 0.4, r * 0.7, r * 0.7, y, sd * x], [za + L * nose, r, r, y, sd * x], [zb - 0.06, r, r, y, sd * x], [zb, r * 0.55, r * 0.55, y, sd * x]], hexOf(c), hexOf(c), 10, 1);
  }
  for (const [a, b, r, c = 0x2a2c2e, m] of F.rods || []) for (const sd of sides(a[0] || b[0], m)) rod(out, [sd * a[0], a[1], a[2]], [sd * b[0], b[1], b[2]], r, hexOf(c));
  // blade aerials on the spine (dir = 1) or belly (dir = −1): [x, z, chord, height, rake, dir]
  for (const [x, z, ch, ht, rake, dir = 1] of F.fins || []) {
    const [, bh, yc] = bodyAt(def.body, z), y0 = yc + dir * (bh - 0.03);
    wing(out, { r: [x, y0, z, ch], t: [x, y0 + dir * ht, z + rake, ch * 0.55], th: 0.04 }, 0x8a8f94, 0x8a8f94, 1, null);
  }
  const RB = refine(def.body);
  for (const [zc, y, w, h, slope] of F.panes || []) for (const sd of [1, -1]) {
    const fn = fusePatch(RB, zc, y, w, h, sd, slope), g4 = [], dark = _c1.setHex(0x12161c).clone();
    for (let j = 0; j <= 2; j++) for (let i = 0; i <= 2; i++) { const p = fn(i / 2 - 0.5, j / 2 - 0.5).clone(); p.x += sd * 0.02; g4.push(p); }
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const k = j * 3 + i; _ctr.set(0, y, zc); quad(out, g4[k], g4[k + 1], g4[k + 4], g4[k + 3], dark); }
  }
  // markings
  const dc = { pos: [], nor: [], uv: [] }, UPV = new THREE.Vector3(0, 1, 0), FWD = new THREE.Vector3(0, 0, -1), hint = new THREE.Vector3();
  for (const mk of def.marks || []) {
    const name = team === 1 ? HOSTILE_CELL[mk[mk[0] === 'w' ? 6 : 5]] : mk[mk[0] === 'w' ? 6 : 5];
    if (!name) continue;
    if (mk[0] === 'f') {
      const [, zc, y, w, h, , slope] = mk;
      for (const sd of [1, -1]) decal(dc, fusePatch(RB, zc, y, name === 'hnum' ? h * 2 : w, h, sd, slope), hint.set(sd, 0, 0), UPV, name);
    } else {
      const [, si, u, xc, sp, ch, , faces] = mk, sf = def.surfs[si], v = new THREE.Vector3();
      const len = Math.hypot(sf.t[0] - sf.r[0], sf.t[1] - sf.r[1]), chord = sf.r[3] + (sf.t[3] - sf.r[3]) * u;
      for (const sx of sf.m === false ? [1] : [1, -1]) for (const face of faces === 'tb' ? [1, -1] : [1]) {
        const setN = () => { _ab.set(sf.t[0] - sf.r[0], sf.t[1] - sf.r[1], sf.t[2] - sf.r[2]); _wn.set(0, 0, 1).cross(_ab).normalize(); _wn.x *= sx; };
        setN();
        const upright = Math.abs(_wn.y) < 0.7;
        // square in the world, not in the (swept, tapered) span / chord parameters
        const z0 = sf.r[2] + (sf.t[2] - sf.r[2]) * u + xc * chord;
        decal(dc, (a, b) => { setN(); const P = wsec(sf, u + a * sp / len, sx); return wpt(P, Math.min(0.98, Math.max(0.02, (z0 + b * ch - P.z) / P.c)), face, v); },
          hint.copy(_wn).multiplyScalar(face), upright ? UPV : FWD, name);
      }
    }
  }
  // underwing pylons for the visible missiles
  const st = stores(def, spec);
  for (const p of st) {
    const L = 1.4;
    wing(out, { r: [p.x, p.wy - 0.02, p.z - L * 0.5, L], t: [p.x, p.y + 0.12, p.z - L * 0.45, L * 0.85], th: 0.12 }, 0x5a5e62, 0x5a5e62, 1, null);
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
  let decals = null;
  if (dc.pos.length) {
    decals = new THREE.BufferGeometry();
    decals.setAttribute('position', new THREE.Float32BufferAttribute(dc.pos, 3)); decals.setAttribute('normal', new THREE.Float32BufferAttribute(dc.nor, 3));
    decals.setAttribute('uv', new THREE.Float32BufferAttribute(dc.uv, 2)); decals.computeBoundingSphere();
  }
  g = { skin, glass, pilot, movers, stores: st, decals };
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
  if (geo.decals) inner.add(new THREE.Mesh(geo.decals, r.decal));
  const missiles = geo.stores.map(p => {
    const m = new THREE.Mesh(r.missile, r.skin);
    m.position.set(p.x, p.y, p.z);
    inner.add(m);
    return m;
  });

  // wingtip RCS rounds (the "attitude thruster" hack): one small missile on each wingtip rail of
  // missile-armed jets; their pinhole-vented motors steer the jet where there is no air
  const rcsRounds = [];
  if (full && spec.missileCount && spec.type === 'jet') {
    let tipS = null;
    for (const sf of def.surfs) if (!sf.mv && !sf.fx && Math.abs(sf.t[1] - sf.r[1]) < 1.5 && (!tipS || Math.abs(sf.t[0]) > Math.abs(tipS.t[0]))) tipS = sf;
    if (tipS) for (const sd of [-1, 1]) {
      const m = new THREE.Mesh(r.missile, r.skin);
      m.position.set(sd * (Math.abs(tipS.t[0]) + 0.14), tipS.t[1] - 0.05, tipS.t[2] + tipS.t[3] * 0.5);
      m.scale.setScalar(0.8);
      inner.add(m); rcsRounds.push(m);
    }
  }

  const movers = geo.movers.map(m => {
    const mesh = new THREE.Mesh(m.geo, skinMat);
    mesh.position.copy(m.pos); mesh.quaternion.copy(m.quat);
    inner.add(mesh);
    return { mesh, sx: m.sx, kind: m.kind, quat: m.quat, max: m.max || 0.8, a: 0 };
  });

  // extents
  let span = 0, zMin = 0, zMax = 0;
  for (const s of def.body) { zMin = Math.min(zMin, s[0]); zMax = Math.max(zMax, s[0]); }
  let tip = [3, 0, 0, 1];
  for (const s of def.surfs) if (!s.fx && Math.abs(s.t[0]) > span) { span = Math.abs(s.t[0]); tip = s.t; }
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
  //   gear entry: [x, z, wheel radius?, mount x?, height of the contact point above the main wheels' ground line?]  — the leg runs from the airframe (belly or wing underside,
  //   or the given mount x for spring legs) down to the axle; oleo, torque links, brace, hubs, doors
  const legs = [], doors = [], wheels = [];
  let landingLight = null;
  if (full && def.gear) {
    const ground = -(spec.bellyH + spec.gearH) / sc, fixedGear = !!def.fixedGear, w0 = def.surfs[0];
    const mountY = (x, z) => {
      const [bw, bh, yc] = bodyAt(def.body, z), ax = Math.abs(x);
      if (ax < bw * 0.9) return yc - bh * Math.sqrt(1 - (ax / bw) ** 2) + 0.06;
      const u = Math.min(1, Math.max(0, (ax - w0.r[0]) / (w0.t[0] - w0.r[0])));
      return w0.r[1] + (w0.t[1] - w0.r[1]) * u - w0.th * 0.25;
    };
    def.gear.forEach(([x, z, wr0, mx, lift = 0], i) => {
      const wr = wr0 || 0.3, nose = i === 0, tail = nose && z > 0, tw = wr * 0.5;
      const twin = !!(def.twin && def.twin[i]);
      const M = _v1.set(mx !== undefined ? Math.sign(x) * mx : x, 0, z); M.y = mountY(M.x, z);
      const W = _v2.set(x, ground + wr + lift, z);
      const leg = new THREE.Group(); leg.position.copy(M);
      const tilt = new THREE.Group(); leg.add(tilt);
      const d = W.clone().sub(M), len = d.length();
      tilt.quaternion.setFromUnitVectors(DOWN, d.clone().normalize());
      const B = (par, mat, x0, y0, z0, x1, y1, z1, rad) => {
        const m = new THREE.Mesh(r.strut, mat); m.position.set(x0, y0, z0);
        _v3.set(x1 - x0, y1 - y0, z1 - z0); const l = _v3.length();
        m.scale.set(rad, l, rad); m.quaternion.setFromUnitVectors(DOWN, _v3.normalize()); par.add(m); return m;
      };
      if (mx !== undefined && !tail) B(tilt, r.gearPaint, 0, 0, 0, 0, -len, 0, wr * 0.16);               // spring-steel leg
      else {
        B(tilt, r.gearPaint, 0, 0, 0, 0, -len * 0.6, 0, wr * 0.2);                              // oleo housing
        B(tilt, r.metal, 0, -len * 0.56, 0, 0, -len * 0.62, 0, wr * 0.25);                      // gland collar
        B(tilt, r.chrome, 0, -len * 0.55, 0, 0, -len, 0, wr * 0.11);                            // piston
        if (!tail) {
          B(tilt, r.metal, 0, -len * 0.6, wr * 0.2, 0, -len * 0.8, wr * 0.62, wr * 0.05);       // torque links
          B(tilt, r.metal, 0, -len * 0.8, wr * 0.62, 0, -len * 0.99, wr * 0.12, wr * 0.05);
          if (!fixedGear) B(tilt, r.gearPaint, 0, -len * 0.45, 0, 0, -0.02, (nose ? 1 : -1) * len * 0.42, wr * 0.09);   // drag brace
        }
      }
      // axle group stays level whatever the leg rake; it steers on the nose leg
      const ax = new THREE.Group(); ax.position.copy(d); leg.add(ax);
      const offs = twin ? [-tw * 0.85, tw * 0.85] : [nose ? 0 : Math.sign(x) * tw * 0.8];
      if (nose && !twin) { for (const sgn of [-1, 1]) B(leg, r.gearPaint, 0, d.y * 0.7, d.z * 0.7, sgn * tw * 0.72, d.y, d.z, wr * 0.07); }   // fork
      B(ax, r.metal, -tw * (twin ? 1.2 : 0.9), 0, 0, tw * (twin ? 1.2 : 0.9), 0, 0, wr * 0.09);
      for (const ox of offs) {
        const wh = new THREE.Group(); wh.position.x = ox;
        const ty = new THREE.Mesh(r.tyreGeo, r.tyre); ty.scale.set(tw, wr, wr);
        const hub = new THREE.Mesh(r.wheel, r.hub); hub.scale.set(tw * 0.82, wr * 0.58, wr * 0.58);
        const cap = new THREE.Mesh(r.wheel, r.metal); cap.scale.set(tw * 0.9, wr * 0.2, wr * 0.2);
        wh.add(ty, hub, cap); ax.add(wh);
        wheels.push({ m: wh, r: wr * sc });
      }
      if (nose && !tail && spec.type !== 'heli') {
        // landing / taxi lamp on the nose leg
        const lamp = new THREE.Mesh(r.wheel, r.metal); lamp.scale.set(wr * 0.3, wr * 0.32, wr * 0.32); lamp.rotation.y = Math.PI / 2;
        lamp.position.set(0, d.y * 0.42, -wr * 0.32); leg.add(lamp);
        landingLight = new THREE.Sprite(r.lamp); landingLight.position.set(0, d.y * 0.42, -wr * 0.5); leg.add(landingLight);
      }
      inner.add(leg);
      legs.push({ leg, ax: nose ? ax : null, dir: nose ? -1.5 : 1.5 });
      // bay doors: two panels hinged along the bay edges, hanging open while the gear is out
      if (!fixedGear && !tail) {
        const dl = len + wr * 0.6, zc = z + (nose ? 1 : -1) * dl * 0.5, dw = (twin ? tw * 2.2 : tw * 1.3) * 0.62;
        for (const sgn of [-1, 1]) {
          const h = new THREE.Group(); h.position.set(M.x + sgn * dw, M.y - 0.03, zc);
          const dm = new THREE.Mesh(r.box, skinMat); dm.scale.set(dw, 0.025, dl); dm.position.x = -sgn * dw * 0.5; dm.material = r.door;
          h.add(dm); inner.add(h);
          doors.push({ h, sgn });
        }
      }
    });
  }

  // propellers / rotors
  const spinners = [];
  const addProp = (x, y, z, rad, blades, axis) => {
    const p = new THREE.Group(), rotor = axis !== 'z';
    p.position.set(x, y, z);
    if (axis === 'y') p.rotation.x = -Math.PI / 2; else if (axis === 'x') p.rotation.y = Math.PI / 2;
    for (let i = 0; i < blades; i++) {
      const b = new THREE.Mesh(rotor ? r.rotorBlade : r.blade, r.bladeMat);
      b.rotation.order = 'ZYX';
      b.scale.setScalar(rad); b.rotation.set(0, axis === 'y' ? -0.045 : 0, i / blades * TAU);     // main rotor blades cone upwards
      p.add(b);
    }
    if (rotor) {
      // hub with blade grips; the main rotor also gets its mast and swash plate
      const hub = new THREE.Mesh(r.hubGeo, r.hub); hub.scale.set(rad * 0.055, rad * 0.055, rad * 0.035); p.add(hub);
      const cap = new THREE.Mesh(r.hubGeo, r.tyre); cap.scale.set(rad * 0.03, rad * 0.03, rad * 0.055); p.add(cap);
      if (axis === 'y') {
        const mast = new THREE.Mesh(r.strut, r.metal); mast.position.set(x, y, z); mast.scale.set(rad * 0.02, rad * 0.11, rad * 0.02); inner.add(mast);
        const swash = new THREE.Mesh(r.strut, r.tyre); swash.position.set(x, y - rad * 0.035, z); swash.scale.set(rad * 0.045, rad * 0.012, rad * 0.045); inner.add(swash);
      }
    }
    const d = new THREE.Mesh(r.disc, rotor ? r.blur : r.blurProp); d.scale.setScalar(rad); p.add(d);
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
    // red anti-collision beacons above and below; civil types also flash white wingtip strobes
    const [, bh, yc] = bodyAt(def.body, 0);
    lights.beacons = [mk(r.red, new THREE.Vector3(0, (yc + bh + 0.12) * sc, 0), 1), mk(r.red, new THREE.Vector3(0, (yc - bh - 0.12) * sc, 0), 1)];
    lights.tips = spec.faction === 'civilian' ? ud.wingtips.map(w => mk(r.white, w.clone().add(_v1.set(0, 0, 0.3)), 1)) : [];
  }

  const fixed = !!def.fixedGear;
  let wheelV = 0;
  ud.update = (dt, s) => {
    const gp = fixed ? 1 : s.gearPos;
    for (let i = 0; i < legs.length; i++) {
      const L = legs[i];
      L.leg.visible = gp > 0.03;
      L.leg.rotation.x = (1 - gp) * L.dir;
      if (L.ax) L.ax.rotation.y += ((s.onGround ? -s.yaw * 0.6 : 0) - L.ax.rotation.y) * Math.min(1, dt * 8);
    }
    // doors swing open during the first part of the travel
    const dOpen = Math.min(1, gp * 2.5) * 1.5;
    for (let i = 0; i < doors.length; i++) { const d = doors[i]; d.h.visible = gp > 0.03; d.h.rotation.z = d.sgn * dOpen; }
    // wheels spin up on the ground and run down after lift-off
    wheelV = s.onGround ? s.speed : wheelV * Math.max(0, 1 - dt * 0.8);
    if (wheelV > 0.05) for (let i = 0; i < wheels.length; i++) wheels[i].m.rotation.x -= dt * wheelV / wheels[i].r;
    if (landingLight) {
      landingLight.visible = gp > 0.9;
      landingLight.scale.setScalar(s.night ? 1.15 : 0.45);
    }
    r.decal.emissiveIntensity = s.night ? 1.4 : 0;                // formation strips, cabin windows
    r.blur.color.setScalar(s.night ? 0.3 : 1); r.blurProp.color.setScalar(s.night ? 0.3 : 1);
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
    const brk = s.airbrake || 0, flap = s.flaps ?? gp;
    for (let i = 0; i < movers.length; i++) {
      // angle about the hinge: + = trailing edge down on the right wing, up on the left (hinge x runs outboard)
      const m = movers[i], sx = m.sx;
      let want = 0;
      switch (m.kind) {
        case 'canard': want = s.pitch * 0.24; break;                              // leading edge up on a pull
        case 'tail': want = -s.pitch * 0.26 - sx * s.roll * 0.12; break;         // all-moving, also works as an aileron
        case 'elev': want = -sx * s.pitch * 0.42; break;
        case 'elevon': want = -sx * s.pitch * 0.22 - s.roll * 0.24; break;
        case 'ail': want = -s.roll * 0.38; break;
        case 'ailBrake': want = -s.roll * 0.38 + sx * brk * 0.5; break;
        case 'flap': want = sx * flap * 0.62; break;
        case 'flaperon': want = sx * flap * 0.35 - s.roll * 0.25; break;
        case 'rudder': want = s.yaw * 0.45; break;
        case 'rudderBrake': want = s.yaw * 0.4 + sx * brk * 0.45; break;         // F-22: rudders splay out as the airbrake
        case 'spoiler': want = -sx * (brk * 0.75 + Math.max(0, sx * s.roll) * 0.3); break;
        case 'brake': want = -brk * m.max; break;
        case 'hook': want = (s.hook || 0) * 0.7; break;                           // swings down aft
        case 'flapBrake': want = sx * (flap * 0.35 + brk * 0.4) - s.roll * 0.25; break;   // F-22 speed brake:
        case 'ailUp': want = -s.roll * 0.38 - sx * brk * 0.55; break;              //   flaperons down, ailerons up
      }
      m.a += (want - m.a) * Math.min(1, dt * 10);
      m.mesh.quaternion.copy(m.quat).multiply(_q1.setFromAxisAngle(X_AXIS, m.a));
    }
    for (let i = 0; i < rcsRounds.length; i++) rcsRounds[i].visible = (s.rcs ?? 1) > 0;
    // missiles on the rails disappear as they are fired (outer pair last)
    const left = s.missiles ?? missiles.length;
    for (let i = 0; i < missiles.length; i++) missiles[i].visible = i < left;
    const sp = 0.35 + s.thrEff * 0.65;
    for (let i = 0; i < spinners.length; i++) spinners[i].p.rotation.z += dt * spinners[i].rate * sp;
    if (lights.strobe) {
      lights.strobe.visible = (s.time % 1.2) < 0.08;
      const k = s.night ? 1.6 : 0.7;        // the bloom (MED/HIGH) spreads them further
      lights[0].scale.setScalar(k); lights[1].scale.setScalar(k);
      const ph = s.time % 1.1, bk = s.night ? 2.6 : 1.1;
      lights.beacons[0].visible = ph < 0.13; lights.beacons[1].visible = ph > 0.55 && ph < 0.68;
      lights.beacons[0].scale.setScalar(bk); lights.beacons[1].scale.setScalar(bk);
      const dbl = ph < 0.05 || (ph > 0.14 && ph < 0.19);              // double flash
      for (let i = 0; i < lights.tips.length; i++) { lights.tips[i].visible = dbl; lights.tips[i].scale.setScalar(s.night ? 3 : 1.3); }
    }
  };
  ud.dispose = () => {};   // geometry + materials are cached and shared
  return g;
}

/** Keys with a mesh definition (used by tests). */
export const AIRCRAFT_MODELS = DEFS;
