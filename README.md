# OpenWings — browser flight / air-combat sim (v2)

A self-contained 3D flight simulator that runs in any modern browser, built
**phone-first** (landscape, touch), in the spirit of the 90s combat flight sims. No server, no accounts,
no internet: everything is procedural and the whole game builds into **one HTML file**.

- **9 flyable aircraft**: Eurofighter Typhoon, F-22, Su-35, MiG-29, A-10, Mi-24 Hind,
  Spitfire, Cessna 172, Airbus A320
- **6 missions**: Free Flight, Dogfight, Ground Strike (AAA + SAMs), Intercept (bombers),
  Wave Assault (with a wingman), Landing Challenge (ILS, graded) — three difficulty levels, best scores saved
- **Flight model** with real g, energy bleed, stall, fly-by-wire assist; AI flies the same physics
- **Fighter HUD** (pitch ladder, flight-path marker, target box, lead-computing gun sight, missile lock, ILS, moving-map radar)
- **3D cockpit**, chase / padlock / fly-by / orbit views, drag to look around
- Three 40 km maps — Nordic fjords, desert canyons, tropical islands — each with three airfields and a city; five times of day / weather; free flight can start from any airfield or airborne
- Solid, destructible cities: smash through houses (towers stop you), shoot buildings apart
- Detailed airframes: panel seams and rivets, sky reflections on paint and canopies, pilots, visible missiles
- Procedural sound, haptics, gamepad support

## Play it on a phone

```bash
npm install
npm run phone      # → dist/OpenWings.html  (one ~700 kB file, works offline)
```

Copy `dist/OpenWings.html` to the phone (USB, cloud drive, e-mail…) and open it in the
browser, or serve it: `cd dist && python3 -m http.server` → `http://<pc-ip>:8000/OpenWings.html`.
Hold the phone in landscape. (`dist/index.html` is the same build and is kept in git.)

## Development

```bash
npm run dev        # vite dev server → http://localhost:5173  (hard-refresh after edits)
npm test           # node tests: flight envelope + AI
node tests/play.mjs    # headless Chrome: an AI pilot flies every mission, fails on errors
node tests/shots.mjs   # headless screenshots → /tmp/ow-shots/
```

Requires Node 18+. The repo also runs straight from a static file server without a
bundler (`index.html` has an importmap for the vendored Three.js).
Docs for contributors: `docs/ARCHITECTURE.md` (module map) and `docs/INTERFACES.md` (module contracts).

## Controls

### Touch

| Control | Action |
|---|---|
| Left thumb, anywhere on the left side | Floating stick — pull **down** = nose up (can be inverted) |
| Slider at the right edge | Throttle; push past the amber mark for afterburner |
| Drag on the sky | Look around (springs back) |
| GUN (hold) · MSL · FLR | Cannon · missile (needs a lock) · flares |
| TGT | Cycle target — keep it in front until the diamond closes and you hear the tone |
| BRK (hold) | Airbrake in flight, wheel brakes on the ground |
| GEAR · VIEW · NAV | Gear · next view · next airfield for the nav/ILS readout |
| II | Pause |

Optional **TILT TO FLY** (hangar options): lean the phone to bank, tilt it to pitch;
it re-zeroes each time you press FLY or resume. Experimental.

### Keyboard / mouse

| Action | Key |
|---|---|
| Pitch / roll / rudder | `W` `S` / `A` `D` / `Q` `E` (or arrows) |
| Throttle | `Shift` up, `Ctrl` down; `1`–`4` presets, `5` afterburner |
| Gun / missile / flares | `Space` / `X` / `F` |
| Target / nav airfield | `T` / `N` |
| Gear / brake | `G` / `B` |
| View | `V` (chase → cockpit → padlock → fly-by → orbit) |
| Look | right-mouse drag; click the view to use the mouse as a stick |
| Pause | `Esc` or `P` |

A standard gamepad also works (left stick fly, right stick look, RT gun, B missile,
X flares, Y target, bumpers throttle, LT brake).

## Flying tips

- Take-off: full throttle, pull gently at ~140 kt (the HUD speed tape is in knots). Gear up with GEAR.
- With **ASSIST ON** the jet holds its flight path when you let go of the stick and will not stall.
- Fight at corner speed (~300–400 kt in the fighters); pulling hard bleeds energy fast.
- Missile warning tone? Break hard across the missile and pump flares.
- Landing: gear down, follow the ILS bars to the runway, ~150 kt over the threshold, throttle to idle (auto-brakes).
  Stop on any friendly runway to refuel, rearm and repair.

## License

MIT, see `LICENSE`. Three.js (vendored) is MIT too. Everything else (terrain, aircraft, sounds) is generated in code.
