// CarrierMesh.js — the visible aircraft carrier (geometry and collision live in world/Carrier.js).
// Hull + boot-topping + flight-deck slab are extrusions of the Carrier.js outlines, so what you see is
// what you land on. The deck paint (angled-deck lane, wires, catapult tracks, elevators, hull number)
// is one canvas texture on the deck's top face; island and mast are a few merged boxes; deck lights are
// one Points draw call with the airfield lamp shader. Everything sits in a group in ship-local space:
// local +X = starboard (r), local −Z = forward (f), y = 0 at the waterline.
import * as THREE from 'three';
import { DECK, HULL, DECK_Y, LANE, WIRES, CATS, SOLIDS, AIM_T } from './Carrier.js';

const F0 = -170, F1 = 175, R0 = -52, R1 = 36;          // deck texture window (m)

/** Extrude a ship-local outline (f, r) up by `depth` from y = y0. Shape coords are (r, f) so the
 *  top-cap UVs are (r, f) in metres. */
function extrude(poly, y0, depth, inset = 0) {
  const sh = new THREE.Shape();
  poly.forEach(([f, r], i) => {
    const rr = r - Math.sign(r) * inset, ff = f - Math.sign(f) * inset;
    if (i) sh.lineTo(rr, ff); else sh.moveTo(rr, ff);
  });
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);          // (r, f, d) → (r, d, −f)
  g.translate(0, y0, 0);
  return g;
}

/** Merge boxes [cx, cy, cz, sx, sy, sz] (ship-local, cy = bottom) into one non-indexed geometry. */
function boxes(list) {
  const pos = [], nor = [];
  for (const [cx, cy, cz, sx, sy, sz] of list) {
    const b = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
    b.translate(cx, cy + sy / 2, cz);
    pos.push(...b.attributes.position.array); nor.push(...b.attributes.normal.array);
    b.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Ship-local box from deck-frame numbers: f0..f1, r0..r1, y0..y1 (above the waterline). */
const fbox = (f0, f1, r0, r1, y0, y1) => [(r0 + r1) / 2, y0, -(f0 + f1) / 2, r1 - r0, y1 - y0, f1 - f0];

function deckTexture() {
  const W = 512, H = 2048, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const X = (r) => (r - R0) / (R1 - R0) * W, Y = (f) => (1 - (f - F0) / (F1 - F0)) * H;
  const k = W / (R1 - R0);                                   // px per metre
  // non-skid deck: dark grey with mottling and tyre-rubber streaks in the landing area
  g.fillStyle = '#3a3d40'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 2600; i++) {
    const v = 50 + Math.random() * 22 | 0;
    g.fillStyle = `rgba(${v},${v + 2},${v + 4},0.35)`;
    g.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 10, 2 + Math.random() * 10);
  }
  const ca = LANE.ca, sa = LANE.sa;
  const lanePt = (t, s) => [LANE.f0 + t * ca + s * sa, LANE.r0 - t * sa + s * ca];
  const line = (a, b, w, col, dash) => {
    g.strokeStyle = col; g.lineWidth = w * k; g.setLineDash(dash ? dash.map(d => d * k) : []);
    g.beginPath(); g.moveTo(X(a[1]), Y(a[0])); g.lineTo(X(b[1]), Y(b[0])); g.stroke();
  };
  g.save();
  g.globalAlpha = 0.5;
  for (let i = 0; i < 70; i++) {                              // rubber in the touchdown zone
    const t = 40 + Math.random() * 70, s = (Math.random() - 0.5) * 10, L = 10 + Math.random() * 30;
    line(lanePt(t, s), lanePt(t + L, s + (Math.random() - 0.5)), 0.4 + Math.random() * 0.5, 'rgba(15,15,16,0.6)');
  }
  g.restore();
  // landing lane: white edge lines, dashed white centreline, yellow foul line on the starboard side
  line(lanePt(0, -LANE.hw), lanePt(LANE.len, -LANE.hw), 0.45, '#e8e8e2');
  line(lanePt(0, LANE.hw), lanePt(LANE.len, LANE.hw), 0.45, '#e8e8e2');
  line(lanePt(4, 0), lanePt(LANE.len, 0), 0.4, '#f0f0ea', [6, 6]);
  line(lanePt(30, LANE.hw + 3.5), lanePt(LANE.len, LANE.hw + 3.5), 0.35, '#e2c23a', [3, 2]);
  // arrestor wires: steel cables across the lane on little bow springs
  for (const t of WIRES) {
    line(lanePt(t, -LANE.hw - 1.5), lanePt(t, LANE.hw + 1.5), 0.32, '#c9ccce');
    for (const s of [-LANE.hw - 1.5, LANE.hw + 1.5]) { const p = lanePt(t, s); g.fillStyle = '#d8b020'; g.fillRect(X(p[1]) - 4, Y(p[0]) - 4, 8, 8); }
  }
  // round-down at the stern: white / black hatching
  for (let r = -20; r < 22; r += 2.4) {
    g.fillStyle = (Math.round(r / 2.4) & 1) ? '#e6e6e0' : '#1c1c1e';
    g.fillRect(X(r), Y(-158), 2.4 * k, 5 * k);
  }
  // bow catapults: shuttle slot, track edges, launch-bar line and a jet-blast deflector outline
  for (const cat of CATS) {
    line([cat.f0 - 6, cat.r], [cat.f1, cat.r], 0.25, '#121314');
    line([cat.f0 - 6, cat.r - 1.4], [cat.f1, cat.r - 1.4], 0.18, '#7d8084');
    line([cat.f0 - 6, cat.r + 1.4], [cat.f1, cat.r + 1.4], 0.18, '#7d8084');
    line([cat.f0, cat.r - 7], [cat.f0, cat.r + 7], 0.3, '#e2c23a', [1.2, 1]);
    g.strokeStyle = '#6a6d70'; g.lineWidth = 0.3 * k; g.setLineDash([]);
    g.strokeRect(X(cat.r - 6.5), Y(cat.f0 - 14), 13 * k, 4 * k);
  }
  // elevators: outlined deck-edge platforms (two starboard, one port)
  for (const [f0, f1, r0, r1] of [[18, 40, 22, 33], [52, 74, 22, 33], [-150, -130, -24, -14]]) {
    g.strokeStyle = '#d8d8d0'; g.lineWidth = 0.3 * k; g.setLineDash([0.8 * k, 0.8 * k]);
    g.strokeRect(X(r0), Y(f1), (r1 - r0) * k, (f1 - f0) * k);
  }
  g.setLineDash([]);
  // deck-edge stripe all round
  g.strokeStyle = 'rgba(230,230,220,0.7)'; g.lineWidth = 0.35 * k;
  g.beginPath(); DECK.forEach(([f, r], i) => { const rr = r - Math.sign(r) * 1.2, ff = f - Math.sign(f) * 1.2; if (i) g.lineTo(X(rr), Y(ff)); else g.moveTo(X(rr), Y(ff)); }); g.closePath(); g.stroke();
  // hull number at the bow, read from the approach (bottom of the letters toward the stern)
  g.save(); g.translate(X(0), Y(128)); g.fillStyle = '#e8e8e2';
  g.font = `bold ${20 * k}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('77', 0, 0);
  g.restore();
  // landing-area "box" marks near the aim point
  for (const s of [-LANE.hw + 1, LANE.hw - 1]) line(lanePt(AIM_T, s), lanePt(AIM_T + 8, s), 0.9, '#e8e8e2');
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.repeat.set(1 / (R1 - R0), 1 / (F1 - F0));
  tex.offset.set(-R0 / (R1 - R0), -F0 / (F1 - F0));
  return tex;
}

/** Deck lights: lane centre + edges, drop lights down the stern, island floods, mast beacons. */
function deckLights(env) {
  const pos = [], col = [], size = [], phase = [], rate = [], quad = [];
  const push = (f, r, y, c, s, ph = 0, rt = 0, qd = 0) => { pos.push(r, y, -f); col.push(...c); size.push(s); phase.push(ph); rate.push(rt); quad.push(qd); };
  const ca = LANE.ca, sa = LANE.sa, y = DECK_Y + 0.25;
  const P = (t, s) => [LANE.f0 + t * ca + s * sa, LANE.r0 - t * sa + s * ca];
  for (let t = 6; t <= LANE.len; t += 12) {
    const [f, r] = P(t, 0); push(f, r, y, [1, 0.97, 0.88], 7);
    for (const s of [-LANE.hw, LANE.hw]) { const [fe, re] = P(t, s); push(fe, re, y, [1, 0.78, 0.4], 6); }
  }
  // drop lights hanging down the stern below the lane centreline: a vertical "runway" to line up on
  for (let d = 1; d <= 6; d++) push(-163.5, LANE.r0, DECK_Y - d * 1.8, [1, 0.35, 0.15], 8);
  // lens datum bar on the port side by the aim point (green row)
  const [lf, lr] = P(AIM_T + 20, -LANE.hw - 9);
  for (let i = -4; i <= 4; i++) push(lf, lr + i * 1.2, DECK_Y + 2.5, [0.3, 1, 0.4], 7);
  push(lf, lr, DECK_Y + 2.5, [1, 0.7, 0.2], 12, 0, 0, 1);           // the "meatball"
  // bow catapult centrelines
  for (const c of CATS) for (let f = c.f0; f <= c.f1; f += 10) push(f, c.r, y, [0.4, 0.6, 1], 5);
  // island: red obstruction beacons on the mast and a warm flood toward the deck
  push(-25, 27, DECK_Y + 42.5, [1, 0.1, 0.08], 18, 0, 0.8, 1);
  push(-25, 27, DECK_Y + 30, [1, 0.1, 0.08], 14, 0.5, 0.8, 1);
  for (const f of [-40, -20, 0]) push(f, 20, DECK_Y + 0.5, [1, 0.72, 0.4], 70, 0, 0, 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
  g.setAttribute('aPhase', new THREE.Float32BufferAttribute(phase, 1));
  g.setAttribute('aRate', new THREE.Float32BufferAttribute(rate, 1));
  g.setAttribute('aQuad', new THREE.Float32BufferAttribute(quad, 1));
  g.computeBoundingSphere();
  const atlas = env._airAtlas || (env._airAtlas = env.makeSpriteAtlas());
  if (!env._sharedTex.includes(atlas.tex)) env._sharedTex.push(atlas.tex);
  const mat = env._lampMat || (env._lampMat = env.makeLampMaterial(atlas));
  return new THREE.Points(g, mat);
}

/**
 * Build the carrier for an Environment. Returns a Group placed and rotated in the world.
 * @param env  Environment (atmosphere for the fill light, lamp atlas / material)
 * @param cv   world/Carrier.js Carrier
 */
export function buildCarrierMesh(env, cv) {
  const night = !!env.atmo.night;
  const fill = (hex, k) => new THREE.Color(hex).multiplyScalar(night ? k * 0.15 : k);
  const lam = (hex, k = 0.3, extra = {}) => new THREE.MeshLambertMaterial({ color: hex, emissive: fill(hex, k), ...extra });
  const grp = new THREE.Group();
  grp.position.set(cv.x, 0, cv.z);
  grp.rotation.y = -cv.heading;

  const hullM = lam(0x737a80), bootM = lam(0x3a2826, 0.2), sideM = lam(0x666d73);
  const deckM = new THREE.MeshLambertMaterial({ map: deckTexture(), emissive: fill(0x3a3d40, 0.25) });
  // hull from below the waterline up to the hangar deck; dark boot-topping band at the waterline
  grp.add(new THREE.Mesh(extrude(HULL, -7, DECK_Y - 2.6 + 7), hullM));
  grp.add(new THREE.Mesh(extrude(HULL, -7, 8.2, -0.25), bootM));
  // hangar-deck gallery: a slightly inset dark band under the overhanging flight deck
  grp.add(new THREE.Mesh(extrude(DECK, DECK_Y - 4.6, 2.0, 3.5), lam(0x2a2e32, 0.15)));
  // flight deck slab: textured top cap, grey sides
  grp.add(new THREE.Mesh(extrude(DECK, DECK_Y - 2.6, 2.6), [deckM, sideM]));

  // island superstructure, bridge windows and mast
  const isl = SOLIDS[0], D = DECK_Y;
  const islandG = boxes([
    fbox(isl.f0, isl.f1, isl.r0, isl.r1, D, D + 14),
    fbox(isl.f0 + 5, isl.f1 - 7, isl.r0 + 1, isl.r1 - 1, D + 14, D + 20),
    fbox(isl.f0 + 9, isl.f1 - 13, isl.r0 + 1.5, isl.r1 - 1.5, D + 20, D + 24),
    fbox(-28, -22, 25.5, 28.5, D + 24, D + 30),                // mast base
    fbox(-26, -24, 26.3, 27.7, D + 30, D + 42.5),               // mast pole
    fbox(-25.5, -24.5, 21, 33, D + 35, D + 35.6),               // yardarm
    fbox(-18, -12, 24, 30, D + 24, D + 25.2),                   // radar platform
    fbox(isl.f0 + 2, isl.f0 + 3, isl.r0 - 0.5, isl.r1 + 0.5, D + 6, D + 14.5),   // aft deckhouse rib
  ]);
  grp.add(new THREE.Mesh(islandG, lam(0x7d848a)));
  const win = boxes([
    fbox(isl.f0 + 4.9, isl.f1 - 6.9, isl.r0 + 0.9, isl.r1 - 0.9, D + 16.5, D + 18.5),
    fbox(isl.f0 + 8.9, isl.f1 - 12.9, isl.r0 + 1.4, isl.r1 - 1.4, D + 21.5, D + 23),
  ]);
  grp.add(new THREE.Mesh(win, new THREE.MeshLambertMaterial({ color: 0x15232c, emissive: night ? 0x6a5428 : 0x000000 })));
  // flat radar array faces + a rotating search radar on the platform
  const arr = boxes([fbox(isl.f1 - 0.2, isl.f1 + 0.1, isl.r0 + 3, isl.r1 - 3, D + 9, D + 13), fbox(isl.f0 - 0.1, isl.f0 + 0.2, isl.r0 + 3, isl.r1 - 3, D + 9, D + 13)]);
  grp.add(new THREE.Mesh(arr, lam(0x5a6066)));
  const radar = new THREE.Mesh(boxes([[0, 0, 0, 5.5, 1.4, 0.4]]), lam(0x9aa0a6));
  radar.position.set(27, D + 25.4, 15);
  grp.add(radar);
  grp.userData.radar = radar;
  // jet-blast deflectors behind each bow catapult (lowered: flush panels, a little proud of the deck)
  grp.add(new THREE.Mesh(boxes(CATS.map(c => fbox(c.f0 - 14, c.f0 - 10, c.r - 6.5, c.r + 6.5, D, D + 0.25))), lam(0x55595d)));
  grp.add(deckLights(env));
  for (const o of grp.children) if (o.material && !o.isPoints) for (const m of [].concat(o.material)) env.shadeMat(m);
  return grp;
}
