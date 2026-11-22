// Carrier.js — the aircraft carrier: deck geometry, catapults, arrestor wires, collision.
// Pure JS (no three.js) so the flight tests run it in node; the mesh is world/CarrierMesh.js.
//
// Ship-local frame: f = metres forward of the ship's centre (bow +), r = metres to starboard (right +).
// World ↔ local uses the same convention as an airfield: dir = (sin h, −cos h) forward, right = (−dirZ, dirX).
//
// The deck is a flat polygon DECK_Y above the sea. Landing uses the ANGLED deck: a lane canted 9° to
// port that starts at the round-down (stern) and runs off the port bow, so a missed wire (bolter) just
// flies off the end. Four wires cross the lane; take-off uses the two bow catapults along the ship axis.

export const DECK_Y = 19.5;            // flight deck above the waterline (m)
const ANG = 9 * Math.PI / 180, CA = Math.cos(ANG), SA = Math.sin(ANG);

/** Flight deck outline (f, r), stern → starboard → bow → port. */
export const DECK = [
  [-163, -21], [-163, 22], [-110, 30], [-40, 33], [60, 33], [110, 27], [150, 17], [168, 7],
  [168, -7], [150, -16], [100, -21], [82, -27], [72, -50], [40, -48], [-60, -36], [-140, -25],
];
/** Hull at the waterline (narrower than the deck: the deck overhangs on sponsons). */
export const HULL = [
  [-158, -17], [-158, 17], [-100, 20], [60, 20], [120, 14], [160, 4], [172, 0], [160, -4], [120, -14], [60, -20], [-100, -20],
];
/** Landing lane: starts at the stern on the centreline, canted 9° to port, 26 m wide, 235 m long. */
export const LANE = { f0: -160, r0: 2, len: 235, hw: 13, ca: CA, sa: SA };
/** Arrestor wires: distance along the lane from its start (1..4). The glide slope aims between 2 and 3. */
export const WIRES = [50, 62, 74, 86];
export const AIM_T = 76;                // touchdown aim point (along the lane) for the main wheels: hook into wire 3
export const GLIDE = 3.5 * Math.PI / 180;
/** Bow catapults: launch position (f0), end of the stroke (f1), lateral offset. */
export const CATS = [{ f0: 58, f1: 158, r: 9 }, { f0: 58, f1: 158, r: -9 }];
/** Solid superstructure: island + mast, as boxes (f0..f1, r0..r1, height above the deck). */
export const SOLIDS = [
  { f0: -44, f1: 2, r0: 21, r1: 33, h: 24 },     // island
  { f0: -30, f1: -20, r0: 24, r1: 30, h: 42 },   // mast
];
/** Parked jets (decoration): f, r, heading offset (rad). Clear of the landing lane and the bow cats. */
export const PARKED = [[-128, 22, 0.5], [-108, 23, 0.5], [-88, 24, 0.5], [18, 24, 0.6], [38, 25, 0.6]];

function inPoly(poly, f, r) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [fi, ri] = poly[i], [fj, rj] = poly[j];
    if ((ri > r) !== (rj > r) && f < (fj - fi) * (r - ri) / (rj - ri) + fi) inside = !inside;
  }
  return inside;
}

export class Carrier {
  /** @param o { x, z, heading, name } */
  constructor(o) {
    this.name = o.name || 'CVN-77 VALIANT';
    this.x = o.x; this.z = o.z; this.heading = o.heading;
    this.dirX = Math.sin(o.heading); this.dirZ = -Math.cos(o.heading);
    this.y = DECK_Y;
    this.length = 332;
    // the landing "runway" the HUD / nav / ILS / autopilot use: the angled deck, one way only
    const ld = this.landing = {
      name: this.name, role: 'carrier', carrier: this, oneWay: true,
      width: LANE.hw * 2, length: LANE.len, y: DECK_Y, aim: AIM_T, glide: GLIDE,
    };
    // lane direction in world: rotate the ship's forward 9° toward port
    const hdg = o.heading - ANG;
    ld.heading = (hdg + Math.PI * 2) % (Math.PI * 2);
    ld.dirX = Math.sin(hdg); ld.dirZ = -Math.cos(hdg);
    const mid = this.toWorld(LANE.f0 + CA * LANE.len / 2, LANE.r0 - SA * LANE.len / 2);
    ld.x = mid.x; ld.z = mid.z;
  }

  /** World → ship-local (f, r) into out. */
  toLocal(x, z, out = {}) {
    const dx = x - this.x, dz = z - this.z;
    out.f = dx * this.dirX + dz * this.dirZ;
    out.r = dx * -this.dirZ + dz * this.dirX;
    return out;
  }

  /** Ship-local (f, r) → world {x, z}. */
  toWorld(f, r, out = {}) {
    out.x = this.x + this.dirX * f - this.dirZ * r;
    out.z = this.z + this.dirZ * f + this.dirX * r;
    return out;
  }

  /** True when (x, z) is over the flight deck. */
  onDeck(x, z) {
    const dx = x - this.x, dz = z - this.z;
    if (dx * dx + dz * dz > 180 * 180) return false;
    const f = dx * this.dirX + dz * this.dirZ, r = dx * -this.dirZ + dz * this.dirX;
    return inPoly(DECK, f, r);
  }

  /** Lane coordinates of a world point: t along the lane from its stern end, s to starboard of its centreline. */
  lane(x, z, out = {}) {
    const dx = x - this.x, dz = z - this.z;
    const f = dx * this.dirX + dz * this.dirZ - LANE.f0, r = dx * -this.dirZ + dz * this.dirX - LANE.r0;
    out.t = f * CA - r * SA;
    out.s = f * SA + r * CA;
    return out;
  }

  /** The superstructure box containing (x, y, z) grown by rad, or null. */
  solidAt(x, y, z, rad = 0) {
    if (y > DECK_Y + 45 + rad || y < DECK_Y - 1) return null;
    const dx = x - this.x, dz = z - this.z;
    if (dx * dx + dz * dz > 200 * 200) return null;
    const f = dx * this.dirX + dz * this.dirZ, r = dx * -this.dirZ + dz * this.dirX;
    for (const b of SOLIDS) {
      if (f > b.f0 - rad && f < b.f1 + rad && r > b.r0 - rad && r < b.r1 + rad && y < DECK_Y + b.h + rad) return b;
    }
    return null;
  }

  /** World position + heading of catapult i, with the aircraft's wheels on the deck. */
  catPose(i, out = {}) {
    const c = CATS[i % CATS.length];
    this.toWorld(c.f0, c.r, out);
    out.heading = this.heading; out.stroke = c.f1 - c.f0;
    return out;
  }
}

/**
 * Find open water for the carrier: deep sea for 700 m all round, 7-12 km from the home field when
 * possible, steaming parallel-ish to it. Falls back to just past the world edge (every map ends in sea).
 */
export function placeCarrier(hf) {
  const home = hf.airfields[0] || { x: 0, z: 0, heading: 0 };
  const deep = (x, z) => {
    for (let a = 0; a < 12; a++) {
      const ang = a / 12 * Math.PI * 2;
      for (const d of [0, 350, 700]) if (hf.height(x + Math.cos(ang) * d, z + Math.sin(ang) * d) > -12) return false;
    }
    return true;
  };
  const want = hf.map.carrierDist || 9000;
  let best = null;
  for (let r = 4000; r <= 19000; r += 500) {
    for (let k = 0; k < 48; k++) {
      const ang = k / 48 * Math.PI * 2, x = home.x + Math.cos(ang) * r, z = home.z + Math.sin(ang) * r;
      if (Math.abs(x) > hf.half + 600 || Math.abs(z) > hf.half + 600) continue;
      if (!deep(x, z)) continue;
      // keep clear of the other airfields' approach paths and the city
      let pen = 0;
      for (const a of hf.airfields) if (Math.hypot(a.x - x, a.z - z) < 4000) pen += 5000;
      if (hf.city && Math.hypot(hf.city.x - x, hf.city.z - z) < 5000) pen += 3000;
      const score = Math.abs(r - want) + pen;
      if (!best || score < best.score) best = { x, z, score };
    }
    if (best && best.score < 600) break;
  }
  if (!best) {
    // past the edge of the world on the side nearest the home field
    const sx = Math.sign(home.x) || 1, sz = Math.sign(home.z) || 1;
    best = Math.abs(home.x) > Math.abs(home.z) ? { x: sx * (hf.half + 1500), z: home.z } : { x: home.x, z: sz * (hf.half + 1500) };
  }
  // steam roughly "into the wind": the same way as the home runway, so the approach doesn't cross land
  // too often; then nudge so the landing lane points away from the home field (a clean bolter)
  let heading = (home.heading || 0);
  const lx = Math.sin(heading), lz = -Math.cos(heading);
  if ((home.x - best.x) * lx + (home.z - best.z) * lz > 0) heading += Math.PI;
  return new Carrier({ x: best.x, z: best.z, heading: heading % (Math.PI * 2), name: hf.map.carrier || 'CVN-77 VALIANT' });
}
