# OpenWings — architecture

How the game is put together. Module contracts (units, aircraft meshes, HUD state, cockpit, axis/unit
conventions) are in `docs/INTERFACES.md`.

## Design decisions (and why)

| Area | Decision | Why |
|------|----------|-----|
| World | `world/Heightfield.js`: 40 km Nordic island on a 512² grid, generated once. Mesh **and** collision sample the same grid with the same triangle split | No "floating/sinking" mismatch between what you see and what you hit. Pure JS, so it runs in node tests |
| Airfields | 3 sites auto-picked by flatness + clear approaches, then flattened: `home`, `civil`, `enemy`. City near the civil field | Robust to changing the terrain seed/shape |
| Flight model | Per-unit-mass forces, real g. Lift/drag from normalised CL(α); G-command fly-by-wire pitch loop; corner speed and sustained turn emerge from `vStall`, `gMax`, `kn`, `twr` | Believable energy fighting, yet "stick centred = holds flight path" which is what makes touch flying pleasant |
| Assist | Setting `assist`: α-limiter (no stalls), bank-to-turn pull compensation, wings auto-level near level, auto wheel-brake at idle | Phone playability. Off = raw aeroplane |
| Throttle | One axis 0..1; for afterburner aircraft the top ~8 % is the AB detent | One slider on touch, no extra button |
| AI | Enemies fly the **same** FlightModel through a stick-input autopilot (`engine/AIPilot.js`) | Fair fights; they bleed energy and can be out-flown |
| Rendering | Custom shaders for sky / terrain / water / clouds sharing one atmosphere (fog) function; aircraft are one vertex-coloured MeshStandardMaterial mesh each (colour ×2.3 because the scene lights are balanced for the terrain shader; no env map yet); 3D cockpit in a second scene drawn after a depth clear, camera-relative | Scenic look at phone cost; cockpit needs a tiny near plane that would wreck world depth precision |
| HUD | One full-screen 2D canvas (`ui/Hud.js`), world-conformal symbology (pitch ladder, flight-path marker, target boxes, lead pipper, ILS) | Classic fighter feel; cheap; identical on phone and desktop |
| Particles | One instanced-quad batch with premultiplied alpha (smoke + additive fire in one draw call), ring-buffer pool | Draw calls / GC |
| Audio | Procedural WebAudio (`engine/Audio.js`), unlocked on the FLY tap | No assets |

## Module map (as built)

```
src/main.js                  boot + window.__game / window.__shot test hooks
src/aircraft/AircraftSpecs.js   pure data: performance + loadout per aircraft
src/aircraft/AircraftFactory.js data-driven meshes: lofted bodies + slab surfaces, gear, flames, props, lights
src/aircraft/Cockpit.js         3D cockpit (2nd render pass), live MFD canvas
src/world/Maps.js            selectable maps: terrain shape fn, palette, trees, houses, names, minimap (pure)
src/world/Heightfield.js     terrain generation + sampling + site placement (pure, node-testable)
src/world/Environment.js     atmosphere presets, sky, reflection env map, terrain mesh (per-pixel normals from a
                             height texture, bicubic on HIGH), water, clouds, airfields,
                             city (solid, destructible, baked shadows), trees
src/engine/Engine.js         renderer, quality, two-pass render (world + cockpit)
src/engine/Post.js           MED/HIGH: HDR target, bloom pyramid, grade/vignette/grain, ACES output
src/engine/FlightModel.js    physics (planes + helicopter)
src/engine/AIPilot.js        autopilot producing stick inputs for AI aircraft
src/engine/Entities.js       "units": aircraft (mesh+FlightModel+AIPilot) and ground targets
src/engine/Weapons.js        pooled tracers, missiles, flares
src/engine/Effects.js        instanced particle batch + shadows (silhouettes projected along the sun on MED/HIGH,
                             soft blobs on LOW)
src/engine/Audio.js          synthesised sound
src/engine/CameraRig.js      views: chase, cockpit, target padlock, fly-by, orbit
src/engine/Missions.js       mission definitions (use the "mission API" in Game.js) + DIFFICULTY
src/engine/Game.js           state machine + per-frame orchestration
src/engine/Settings.js       persisted options + best scores (localStorage)
src/ui/Hud.js                canvas HUD + radar/moving map
src/ui/UI.js                 hangar/pause/debrief, toasts, ALL input (keys, mouse, touch, gamepad)
tests/flight.test.mjs, ai.test.mjs   node tests (physics envelope, AI)
tests/play.mjs               headless Chrome: an AI pilot flies the PLAYER through every mission (--map=)
tests/buildings.mjs          headless Chrome: buildings are solid / breakable, city restored per mission
tests/shots.mjs              headless Chrome screenshots → /tmp/ow-shots/
tests/render_map.mjs         top-down world picture (PPM)
```

Not split out yet: `world/Atmosphere.js`, `world/Scenery.js`
(both still inside `Environment.js`) and `ui/Input.js` (inside `UI.js`).
Module contracts live in `docs/INTERFACES.md` — keep it in step with the code.

