# OpenWings v2 — module interfaces

Contracts between `Game.js` and the modules it drives. If you change one side,
change this file and the other side in the same commit.

## Conventions

- SI units everywhere (m, m/s, rad, s). The HUD converts to kt / ft for display.
- World: +Y up, north = −Z, east = +X. `heading = atan2(fwd.x, -fwd.z)`, 0 = north, clockwise, 0..2π.
- Aircraft local axes: nose = −Z, right wing = +X, up = +Y. Origin ≈ centre of gravity.
- Stick convention (all −1..1): `pitch` + = pull / nose up, `roll` + = right, `yaw` + = nose right.
- Teams: `0` = friendly (player side), `1` = hostile.
- Only `import * as THREE from 'three'` (bare). No `three/examples/jsm/*`, no assets, no CDN.
- No per-frame allocations in `update()` / `draw()` paths (module-level temporaries).

## Unit (engine/Entities.js)

Everything that can be shot at or shown on radar.

```js
{
  kind: 'air' | 'ground',
  team: 0 | 1,
  name: 'MIG-29',            // short label for HUD
  pos: THREE.Vector3,        // === obj.position for aircraft
  vel: THREE.Vector3,        // === fm.velocity for aircraft
  radius: 9,                 // hit sphere, metres
  alive: true,
  hp, maxHp,
  obj: THREE.Object3D | null,
  spec, fm, ai,              // aircraft only (AircraftSpecs entry, FlightModel, AIPilot)
  isPlayer: false,
  hung: [{ t, side, trail }],  // player only: missile motors burning on locked pylon latches (Game.hangFire)
}
```

## Aircraft meshes (aircraft/AircraftFactory.js)

```js
const mesh = buildAircraft(key, opts?)   // key ∈ AIRCRAFT_SPECS; opts: { team?: 0|1, lod?: 'full'|'low' }
mesh.userData = {
  radius,                 // bounding radius (m) for hit tests / shadows / camera distance
  muzzle: Vector3,        // gun muzzle, aircraft-local
  nozzles: Vector3[],     // engine exhaust positions, local (contrails, damage smoke)
  wingtips: [Vector3, Vector3],   // left, right, local (vapour trails)
  pylons: Vector3[],      // missile launch points, local (alternate left/right); on armed types these are
                          //   the visible underwing missiles (none on the F-22: internal bay)
  update(dt, s) {},       // animate: s = { time, gearPos 0..1, thrEff 0..1, ab bool, pitch, roll, yaw (stick),
                          //               airbrake 0..1, speed m/s, night bool, missiles? (left; hides fired rounds),
                          //               hook? 0..1 (tail hook), rcs? 0..1 (wingtip RCS grain; 0 hides the tip rounds) }
                          //   → gear retraction, burner flames, control surfaces/canards, props/rotors, nav lights
  dispose() {},           // no-op today: geometry/materials are cached per aircraft+team and shared
  glass,                  // canopy Mesh, with the pilot as its child (Game hides both in cockpit view)
}
```

Meshes sit so that the wheels touch the ground at local `y = -(spec.bellyH + spec.gearH)`
(gear down) and the belly is at `y = -spec.bellyH`.

## Buildings (world/Environment.js → engine/Game.js)

The city is solid. `Environment` keeps one record per building and a 100 m spatial hash:

```js
b = { x, z, hw, hd,           // centre and half-extents (m), axis-aligned
      y0, top, top0,          // base, current roof height, original roof height
      style,                  // 'glass' | 'office' | 'res'
      floors, hp, hp0, state, // state 0 intact · 1 top broken off · 2 rubble (no longer solid)
      parts }                 // instanced boxes (body, setback crown, roof plant) for damage/restore
env.buildingAt(x, y, z, r?)          // standing building containing the point (grown by r), or null
env.buildingsNear(x, z, rad, out?)   // standing buildings within rad (blast damage)
env.damageBuilding(b, dmg)           // → new state (1 / 2) when it changes, else -1; updates the meshes
env.resetBuildings()                 // restore everything (called by startMission)
```

`Game.damageStructure(b, dmg, vel)` applies damage and throws debris/dust (`effects.rubble`).
`Game.hitBuilding(u, b)` handles an aircraft flying into one: houses and low offices
(≤ 6 floors) are smashed and the aircraft survives hurt and slowed; anything bigger is a crash.
Bullets (`weapons.onStructure`), missile blasts (`onExplode`), falling wrecks and the
intercept mission's bombing all damage buildings.

## HUD (ui/Hud.js)

```js
const hud = new Hud(canvas2d)   // full-screen <canvas id="hud-canvas">; sizes itself (DPR-aware) on resize()
hud.resize()
hud.draw(s)                     // once per rendered frame while flying
hud.clear()
```

`s` (HudState) is one object owned and reused by `Game`:

```js
{
  time,                         // sim seconds (blink timers)
  view: 'cockpit'|'pitlook'|'chase'|'flyby'|'orbit'|'target',   // cockpit = full HUD; pitlook = compact strip;
                                // outside views = flight bar + world markers + weapons panel (no ladder/tapes)
  camera: THREE.PerspectiveCamera,   // matrices current for this frame; project world points with it
  clean: false,                 // HUD hidden (I key): draw only the warnings
  touch: false,                 // touch layout active: keep symbology out of the bottom-left 200×200 css px
                                // (stick) and the bottom-right 260×210 css px (buttons + throttle)
  own: {
    name, pos, vel, quat,       // Vector3, Vector3, Quaternion (live references)
    ias, tas, mach, alt, agl, vs,
    heading, pitch, bank,       // rad; bank + = right wing down
    g, gMax, aoa, aoaMax,
    throttle, thrEff, ab, hasAB, fuel /*0..100*/, hp /*0..1*/,
    gearDown, gearPos, onGround, stalled, airbrake, isHeli,
    flameout, rho,              // jet flamed out in thin air; air density relative to sea level
  },
  latch, boost,                 // pylon latches locked (bool); number of hung motors burning
  override, guard,              // MSL BURN LIMIT switch in OVRD (bool); its guard 0 closed .. 1 up
  input: { pitch, roll, yaw },  // current stick (cockpit animates the stick with it)
  weapons: { gun, gunMax, missiles, missilesMax, flares, hasGun, hasMissiles, gunRange /*m*/, missileRange /*m*/, missileMin /*m*/ },
  target: null | {
    unit, pos, vel, name, kind, hp /*0..1*/,
    range, closure,             // m, m/s (+ = closing)
    lock /*0..1*/, locked,      // missile seeker
    off,                        // rad off the nose (the seeker locks inside 0.45)
    aim: Vector3 | null,        // world point to put the gun cross on to hit (lead-computed); null beyond gun range
  },
  units: Unit[],                // every unit (check .alive); own aircraft has isPlayer
  threats: Vector3[], threatN,  // positions of missiles homing on the player (first threatN entries valid)
  nav: null | {                 // selected airfield
    name, pos, dist, bearing,   // bearing rad (world heading to fly)
    rwyHeading,                 // rad, the landing direction currently in use
    ils: null | { loc, gs },    // rad off the localiser (+ = aircraft is right of centreline) / off a 3° glideslope (+ = above)
  },
  waypoint: null | { pos, label },
  warn: { stall, pullUp, missile, fuel, gear, damage, overG },   // booleans
  mission: { title, objective, score, kills, hostiles, wave, timer /*s or null*/ },
  map: { canvas, worldSize, airfields },   // north-up top-down picture of the whole world (HTMLCanvasElement)
  radarRange,                   // m
  blackout,                     // -1..1: >0 grey-out/black-out (positive g), <0 red-out
}
```

## Cockpit (aircraft/Cockpit.js)

```js
const cockpit = new Cockpit(spec)        // spec = AIRCRAFT_SPECS entry; spec.cockpit ∈ 'fighter'|'prop'|'heli'|'airliner'
cockpit.group                            // Object3D in AIRCRAFT-LOCAL coordinates (pilot's eye is at spec.eye)
cockpit.update(dt, s)                    // s = the HudState above (live MFDs, moving stick/throttle, pedals, gear handle, annunciators)
cockpit.setNight(on); cockpit.setSun(dir) // panel flood / HUD + canopy glass; world sun direction for the canopy glint
cockpit.dispose()
```

`Engine.setCockpit(group, env)` puts it in a second scene that is drawn after clearing
depth (near plane 0.05 m) while `engine.pitOn` is true. That pass is **camera-relative**:
Game sets `group.quaternion` to the aircraft attitude and `engine.pitCam.position` to the
rotated eye offset, with no world translation, so 5 cm detail survives float precision
20 km from the origin. The HUD canvas is drawn on top; the cockpit must leave the
forward view through the HUD glass clear.

## Altitude, ejection, hung-missile boost

- `FlightModel.airDensity(y)`: troposphere scale height 9 km, faster thinning above 11 km. Lift, drag,
  control authority and jet thrust (ρ^0.7) all follow it; jets flame out below `FLAMEOUT_RHO` (~26.5 km)
  and relight under `RELIGHT_RHO` (~21 km), pushing `flameout` / `relight` events.
  `fm.boost` (m/s² along the nose) and `fm.boostYaw` (rad/s) are external rocket inputs, zero by default.
- Sky: `Environment.update` sets `space` 0..1 from camera height (8 → 38 km) → sky shader `uSpace`:
  zenith to black, thinner horizon band, daytime stars, no cirrus.
- `Game.eject()` (J, twice within 1.5 s; touch EJECT; pad R3): `engine/Ejection.js` — canopy + rocket seat
  (fighter cockpits) or bail-out (prop / heli), seat separation, parachute. The instance is a camera unit
  (`{obj, pos, vel, radius, spec}`); the abandoned aircraft flies on with a slack stick until it crashes.
- LATCH control (H; touch LATCH; pad L3) → `Game.latchPress()` / `latchRelease()`: a tap (< 0.4 s) is
  `toggleLatch()`; with the latches locked, a hold lifts the guard (`s.guard` 0..1) and at 1.5 s flips the
  MSL BURN LIMIT switch NORM ↔ OVRD (`Game.override`, `s.override`; reset when the latches are unlocked).
  Then `fireMissile()` = `hangFire()`: the motor stays on the rail adding thrust plus a yaw away from the
  burning side. `MOTORS` in Game.js: `stock` 0.85 g × 3.9 s (tops out ~35–40 km); `extended` (override)
  2 g × 7 s, +15 % in vacuum, scorches the wing 0.5 hp/s (never below 25 % hull) — a full load fired in
  sequence in a steep zoom reaches 100+ km in the F-22 / Su-35.
- Above ~15 km `Environment.update` stretches the water disc past the true horizon (√(2Rh)), raises the
  camera far / near planes to match, and dips the sky horizon (`uDip`) so the fogged sea rim reads as a
  curved Earth limb.

## Mission API (engine/Game.js → engine/Missions.js)

`MISSIONS[key].create(g)` receives the Game and returns `{ objective(), update(dt), onTouchdown?(info), timer?() }`.

```js
g.env, g.player, g.units, g.diff /* DIFFICULTY entry */, g.time
g.hostilesLeft, g.primaryLeft                  // live counts (team 1 aircraft / units flagged primary)
g.placePlayer({ airfield }) | ({ x, z, y, heading }) | ({ final: airfield, dist, alt })
g.spawnAir(key, team, { x, z, y, heading, speed?, ai: { skill, role, waypoints, loop, cruiseAlt, minAGL }, score?, primary?, turret? }) → unit
g.spawnGround(type, team, x, z, { heading?, primary? }) → unit     // type ∈ GROUND_TYPES
g.waypoint = { pos, label }; g.navField = airfield; g.wave = n
g.say(text, 'good'|'warn'|'danger'); g.addScore(n, label?); g.finish(won, title, detail?)
g.bombCity(city); g.playerHeading(); g.v3(x, y, z)
// onTouchdown(info): { sink m/s, runway bool, speed, time, field, along /*m past threshold*/, lat /*m right of centreline*/ }
```

## Test hooks (main.js)

`window.__game`, `window.__shot.start(mission, aircraft, { tod, quality, difficulty, air, alt, view })`,
`__shot.run(seconds, autopilot = true)`, `__shot.info()`, `__game.setAutopilot(bool)`.


## Carrier (world/Carrier.js)

```js
env.carrier === hf.carrier          // Carrier on every map
carrier.onDeck(x, z) · carrier.solidAt(x, y, z, r) · carrier.lane(x, z) → { t, s } · carrier.toWorld(f, r) · carrier.catPose(i)
carrier.landing = { name, role: 'carrier', carrier, x, z, y, heading, dirX, dirZ, length, width, oneWay: true, aim, glide }
env.ground(x, z, out)               // out.carrier = the Carrier when over its deck, else null
```

FlightModel carrier state (set by Game): `hookDown` / `hookPos`, `cat = { dirX, dirZ, speed, accel, stroke, dist, fired }`,
`arrest = { v0, run, s, wire, stopped }`, `onCarrier`, `rcs` (0..1). Events: `catEnd { speed }`, `arrested`,
`liftoff { carrier, cat }`. Crash reason `'ship'`.

Missions may implement `onTrap({ wire, speed, lat, td })`, `onBolter()`, `onArrested(arrest)`.

## Autopilot (engine/Autopilot.js)

```js
game.setAP(mode | 'off')            // mode ∈ AP_MODES: takeoff land space landmark target hold
ap.update(dt) → { pitch, roll, yaw, throttle, brake, fire }
ap.status                           // HUD line (hs.ap); ap.done + ap.doneMsg ask Game to disengage
landmarkList(env) → [{ name, x, z, y, h }]
```

HUD state additions: `hs.ap` (string), `hs.rcs` (-1 none, else 0..1), `hs.rcsOn`, `hs.motorsCut`, `own.hook`, `own.cat`, `own.arrest`.
