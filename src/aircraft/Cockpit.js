// Cockpit.js — 3D cockpit interior for the first-person view.
// Contract: docs/INTERFACES.md ("Cockpit"). `group` is in AIRCRAFT-LOCAL coordinates;
// Engine draws it in a second scene after a depth clear (near plane 5 cm), so it
// never fights the world's depth precision. Instruments are live canvases:
//   • a gauge strip just under the glare shield (always in view): standby dials for jets and
//     helicopters, the classic six-pack for props, autopilot/FCU windows for the airliner
//   • the main panel below it (hold C, or drag-look down): three MFDs + warning lamps for
//     jets/helis, engine dials for props, PFD / ND / EICAS glass for the airliner
import * as THREE from 'three';
import * as G from './Gauges.js';

const KT = 1.943844, FT = 3.28084;
const GREEN = '#3dff72', DIM = 'rgba(61,255,114,0.45)', AMBER = '#ffc531', RED = '#ff4d3d';

// per cockpit style: panel width, sill half-width, canopy arch height, eye → panel distance
// shield: glare-shield height; strip / main: [centre y, panel width] of the two instrument canvases
const STYLE = {
  fighter: { w: 0.92, sill: 0.46, arch: 0.62, d: 0.62, frame: 'bow', shield: -0.205, strip: [-0.29, 0.86], main: [-0.6, 0.88] },
  prop: { w: 0.8, sill: 0.4, arch: 0.5, d: 0.52, frame: 'cage', shield: -0.17, strip: [-0.245, 0.74], main: [-0.52, 0.78] },
  heli: { w: 0.9, sill: 0.5, arch: 0.6, d: 0.6, frame: 'cage', shield: -0.2, strip: [-0.285, 0.86], main: [-0.58, 0.88] },
  airliner: { w: 2.3, sill: 1.6, arch: 0.55, d: 0.75, frame: 'posts', shield: -0.19, strip: [-0.25, 1.0], main: [-0.53, 2.1] },
};
const CANVAS = { fighter: [[1024, 192], [512, 208]], heli: [[1024, 192], [512, 208]], prop: [[1024, 192], [1024, 192]], airliner: [[1024, 112], [1536, 336]] };

export class Cockpit {
  constructor(spec) {
    this.spec = spec;
    const st = this.style = STYLE[spec.cockpit] || STYLE.fighter;
    this.group = new THREE.Group();
    const pit = this.pit = new THREE.Group();          // origin = pilot's eye
    pit.position.set(spec.eye[0], spec.eye[1], spec.eye[2]);
    this.group.add(pit);
    const cx = spec.cockpit === 'airliner' ? -spec.eye[0] : 0;   // panel centred on the aircraft, pilot sits left

    const k = spec.cockpit, liner = k === 'airliner', yoke = spec.key === 'c172', spit = k === 'prop' && !yoke;
    const suit = liner ? 0x1e2436 : yoke ? 0x3c4c6c : spit ? 0x4c5670 : 0x5c6848, glove = spit ? 0x6a4a2c : liner || yoke ? 0xb98d6e : 0x2a2c26;
    // everything that does not move is merged into ONE vertex-coloured mesh (1 draw call)
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, color: new THREE.Color(2.2, 2.2, 2.2) });
    this.geos = [];
    const b = new Build();
    const mesh = (bd, parent = pit) => { const m = bd.mesh(this.mat); this.geos.push(m.geometry); parent.add(m); return m; };

    // glare shield with a padded lip, panel, sills, floor
    b.box(C.dark, st.w + 0.16, 0.04, 0.3, cx, st.shield, -st.d - 0.12, 0.12);
    b.box(C.black, st.w + 0.18, 0.028, 0.03, cx, st.shield - 0.02, -st.d + 0.03);
    b.box(C.dark, st.w + 0.16, 0.66, 0.05, cx, -0.58, -st.d + 0.05, -0.2);
    for (const s of [-1, 1]) {
      b.box(C.dark, 0.07, 0.5, 1.5, cx + s * (st.sill + 0.03), -0.6, -0.1);
      b.box(C.trim, 0.09, 0.03, 1.5, cx + s * (st.sill + 0.03), -0.345, -0.1);
      for (const z of [-0.55, -0.1, 0.35]) b.box(C.black, 0.1, 0.012, 0.05, cx + s * (st.sill + 0.03), -0.326, z);   // canopy locks
    }
    b.box(C.dark, st.sill * 2, 0.04, 1.5, cx, -0.86, -0.1);
    this.cons = st.sill - 0.085;                       // side consoles (switch panels on top, see below)
    if (!liner) for (const s of [-1, 1]) {
      b.box(C.dark, 0.15, 0.36, 0.84, s * this.cons, -0.68, 0.1);
      b.box(C.trim, 0.155, 0.012, 0.85, s * this.cons, -0.502, 0.1);
    }

    // canopy / windscreen frame
    if (st.frame === 'bow') {
      const w = st.sill + 0.06, h = st.arch + 0.33;
      b.arch(C.trim, cx, -0.33, -st.d - 0.12, w, h, 1); b.arch(C.trim, cx, -0.33, 0.42, w, st.arch + 0.36, 1.2);
      // rear-view mirrors on the windscreen bow
      for (const a of [1.08, Math.PI / 2, Math.PI - 1.08]) {
        const x = Math.cos(a) * (w - 0.055), y = -0.33 + Math.sin(a) * (h - 0.055);
        b.box(C.black, 0.105, 0.05, 0.02, x, y, -st.d - 0.105, 0.1, 0, a - Math.PI / 2);
        b.box(C.mirror, 0.09, 0.036, 0.004, x, y, -st.d - 0.093, 0.1, 0, a - Math.PI / 2);
      }
    } else if (st.frame === 'cage') {
      b.arch(C.trim, cx, -0.33, -st.d - 0.1, st.sill + 0.05, st.arch + 0.33, 1); b.arch(C.trim, cx, -0.33, 0.05, st.sill + 0.05, st.arch + 0.36, 1); b.arch(C.trim, cx, -0.33, 0.6, st.sill + 0.05, st.arch + 0.3, 1);
      b.box(C.trim, 0.03, 0.03, st.d + 0.2, 0, st.arch, -st.d / 2 + 0.05);
      if (spit) { b.box(C.black, 0.12, 0.05, 0.02, 0, st.arch - 0.06, -st.d - 0.07); b.box(C.mirror, 0.1, 0.036, 0.004, 0, st.arch - 0.06, -st.d - 0.058); }
    } else {
      for (const x of [-1.35, -0.62, 0.62, 1.35]) b.box(C.trim, 0.07, 0.95, 0.07, cx + x, 0.1, -st.d - 0.22, 0.25);
      b.box(C.dark, st.w + 0.6, 0.06, 1.0, cx, 0.58, -0.4, -0.2);
      for (const s of [-1, 1]) b.box(C.trim, 0.07, 0.9, 0.07, cx + s * (st.sill + 0.03), 0.1, -0.1);
    }

    // HUD combiner (jets, helicopter) / reflector gunsight (warbird): projector box, posts and a tinted glass
    this.glassMat = null; this.glassBase = 0.07;
    if (!liner && !yoke) {
      const gw = spit ? 0.09 : 0.2, gh = spit ? 0.09 : 0.17, gy = spit ? -0.06 : -0.015, gz = -st.d - 0.03, tilt = 0.3;
      const y0 = gy - gh / 2 * Math.cos(tilt), z0 = gz - gh / 2 * Math.sin(tilt), y1 = gy + gh / 2 * Math.cos(tilt), z1 = gz + gh / 2 * Math.sin(tilt);
      b.box(C.trim, spit ? 0.1 : 0.16, 0.04, 0.14, 0, st.shield + 0.04, -st.d - 0.02);
      b.box(C.black, spit ? 0.06 : 0.1, 0.012, 0.08, 0, st.shield + 0.064, -st.d - 0.02);          // projector lens
      for (const s of [-1, 1]) {
        b.rod(C.trim, [s * gw / 2, st.shield + 0.05, z0], [s * gw / 2, y0, z0], 0.004);
        b.rod(C.trim, [s * gw / 2, y0, z0], [s * gw / 2, y1, z1], 0.0025);
      }
      b.rod(C.trim, [-gw / 2, y0, z0], [gw / 2, y0, z0], 0.003);
      this.glassMat = new THREE.MeshBasicMaterial({ color: spit ? 0xffd9a0 : 0x7dffb0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
      const gl = new THREE.Mesh(this.plane = new THREE.PlaneGeometry(1, 1), this.glassMat);
      gl.scale.set(gw, gh, 1); gl.position.set(0, gy, gz); gl.rotation.x = tilt; gl.renderOrder = 2;
      pit.add(gl);
    }

    // seats: pan, back, headrest (ejection seat on jets: canopy breakers + the yellow/black firing handle)
    const seat = (x) => {
      b.box(C.seat, 0.42, 0.06, 0.44, x, -0.8, -0.02);
      b.box(C.seat, 0.3, 0.6, 0.07, x, -0.52, 0.26, 0.1);
      b.box(C.dark, 0.17, 0.17, 0.07, x, -0.08, 0.24);
      for (const s of [-1, 1]) b.box(C.strap, 0.045, 0.4, 0.012, x + s * 0.09, -0.46, 0.215, 0.1);          // shoulder harness
      if (k === 'fighter') {
        for (const s of [-1, 1]) b.box(C.metal, 0.018, 0.06, 0.03, x + s * 0.07, 0.03, 0.24);
        b.ring(C.yellow, x, -0.745, -0.2, 0.045);
        for (const a of [0.6, 2.2, 3.8, 5.4]) b.box(C.black, 0.022, 0.022, 0.022, x + Math.cos(a) * 0.045, -0.745, -0.2 + Math.sin(a) * 0.045);
      }
    };
    seat(0);
    if (liner) seat(cx * 2);

    // the pilot's legs (and upper arms; the forearms follow the stick and throttle, see update)
    const legs = (x) => {
      for (const s of [-1, 1]) {
        const hip = [x + s * 0.1, -0.72, 0.02], knee = [x + s * (yoke || spit ? 0.16 : 0.19), -0.7, -0.33], foot = [x + s * 0.17, -0.87, -0.5];
        b.rod(suit, hip, knee, 0.075); b.ball(suit, knee[0], knee[1], knee[2], 0.077); b.rod(suit, knee, foot, 0.062);
      }
    };
    legs(0);
    this.arms = !liner && !yoke;
    if (this.arms) for (const s of [-1, 1]) { b.rod(suit, [s * 0.21, -0.24, 0.13], ELBOW(s, this.cons), 0.05); b.ball(suit, ...ELBOW(s, this.cons), 0.05); }

    // airliner: centre pedestal with thrust levers, the captain's side console and side-stick
    if (liner) {
      b.box(C.dark, 0.36, 0.42, 0.95, cx, -0.67, -0.12);
      b.box(C.trim, 0.3, 0.012, 0.2, cx, -0.455, -0.2);
      b.box(C.black, 0.26, 0.012, 0.3, cx, -0.455, 0.12);
      b.box(C.dark, 0.16, 0.4, 0.7, -0.4, -0.66, -0.1);
      b.box(C.trim, 0.165, 0.012, 0.71, -0.4, -0.462, -0.1);
    }
    if (yoke) b.rod(C.metal, [0, -0.63, -st.d + 0.02], [0, -0.63, -st.d + 0.2], 0.014);
    // instrument bezels
    const bezel = ([y, w], [W, H], x, z) => {
      const h = w * H / W, t = 0.014, c = Math.cos(-0.2), s = Math.sin(-0.2);
      for (const sg of [-1, 1]) {
        b.box(C.black, w + 2 * t, t, 0.022, x, y + sg * (h / 2 + t / 2) * c, z + sg * (h / 2 + t / 2) * s, -0.2);
        b.box(C.black, t, h, 0.022, x + sg * (w / 2 + t / 2), y, z, -0.2);
      }
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) b.ball(C.metal, x + sx * (w / 2 + t / 2), y + sy * (h / 2 + t / 2) * c, z + sy * (h / 2 + t / 2) * s + 0.011, 0.005);   // screws
    };
    this.kind = spec.cockpit in CANVAS ? spec.cockpit : 'fighter';
    bezel(st.strip, CANVAS[this.kind][0], cx, -st.d + 0.085);
    bezel(st.main, CANVAS[this.kind][1], cx, -st.d + 0.1);

    // ---- detail pass: the bits that make it read as a real office ----
    const pz = -st.d + 0.05, tilt = -0.2;                   // panel face plane
    // raised lip around the whole instrument panel + a row of panel fasteners along the glare shield
    for (const sg of [-1, 1]) b.box(C.trim, 0.018, 0.64, 0.03, cx + sg * (st.w / 2 + 0.07), -0.58, pz + 0.02, tilt);
    b.box(C.trim, st.w + 0.16, 0.018, 0.03, cx, -0.905, pz + 0.085, tilt);
    if (!liner) for (let i = -6; i <= 6; i++) b.box(C.metal, 0.008, 0.008, 0.008, cx + i * (st.w + 0.1) / 13, st.shield - 0.034, -st.d + 0.046);
    // rivet lines along the sills
    for (const sg of [-1, 1]) for (let z = -0.8; z <= 0.6; z += 0.1) b.box(C.metal, 0.006, 0.006, 0.006, cx + sg * (st.sill + 0.03 - sg * 0.046), -0.335, z);
    if (!liner) {
      // throttle quadrant slot with the afterburner gate
      const tx = -this.cons + 0.02;
      b.box(C.black, 0.016, 0.006, 0.22, tx, -0.497, -0.18);
      for (const [z, c] of [[-0.1, C.metal], [-0.18, C.metal], [-0.247, k === 'fighter' ? C.amber : C.metal]]) b.box(c, 0.04, 0.004, 0.004, tx + 0.028, -0.497, z);
      // a fire handle on the right console, oxygen regulator behind it
      b.ring(C.red, this.cons, -0.48, 0.34, 0.022, true);
      b.box(C.dark, 0.1, 0.05, 0.1, this.cons, -0.48, 0.42);
      b.box(C.green, 0.03, 0.008, 0.03, this.cons, -0.452, 0.42);
      // rudder pedal floor rails
      for (const sg of [-1, 1]) b.box(C.black, 0.025, 0.012, 0.28, sg * 0.17, -0.9, -0.48);
      // map light on a gooseneck by the right shoulder
      b.rod(C.black, [st.sill - 0.03, -0.34, 0.25], [st.sill - 0.09, -0.2, 0.14], 0.007);
      b.rod(C.black, [st.sill - 0.09, -0.2, 0.14], [st.sill - 0.13, -0.19, 0.08], 0.016);
      b.box(C.amber, 0.02, 0.02, 0.004, st.sill - 0.135, -0.19, 0.06);
    }
    const annOn = k === 'fighter' || k === 'heli';
    if (annOn) b.box(C.black, 0.25, 0.075, 0.03, cx - 0.25, st.shield + 0.026, -st.d - 0.05, -0.3);   // annunciator housing
    if (k === 'fighter') {
      // standby (whiskey) compass and a grab handle up on the windscreen bow
      const by = -0.33 + (st.arch + 0.33) - 0.05;
      b.box(C.black, 0.06, 0.045, 0.05, cx + 0.14, by - 0.04, -st.d - 0.1);
      b.box(C.white, 0.04, 0.02, 0.004, cx + 0.14, by - 0.04, -st.d - 0.074);
      b.rod(C.black, [cx + 0.14, by, -st.d - 0.1], [cx + 0.14, by - 0.02, -st.d - 0.1], 0.006);
      for (const sg of [-1, 1]) b.rod(C.metal, [cx + sg * 0.09, by - 0.01, -st.d - 0.11], [cx + sg * 0.09, by - 0.05, -st.d - 0.08], 0.006);
      b.rod(C.metal, [cx - 0.09, by - 0.05, -st.d - 0.08], [cx + 0.09, by - 0.05, -st.d - 0.08], 0.007);
      // ejection-seat side handles (yellow / black striped) and the leg restraint garters
      for (const sg of [-1, 1]) {
        for (let i = 0; i < 6; i++) b.box(i & 1 ? C.black : C.yellow, 0.025, 0.025, 0.025, sg * 0.235, -0.73 + i * 0.022, -0.12 + i * 0.012);
        b.box(C.strap, 0.13, 0.02, 0.13, sg * 0.18, -0.66, -0.3);
      }
      // oxygen hose from the mask down to the right console regulator
      const hose = [[0.03, -0.2, -0.1], [0.1, -0.4, -0.13], [0.2, -0.6, -0.04], [this.cons - 0.02, -0.5, 0.25], [this.cons, -0.47, 0.4]];
      for (let i = 0; i < hose.length - 1; i++) {
        b.rod(C.hose, hose[i], hose[i + 1], 0.017);
        for (let t = 0; t < 1; t += 0.2) {
          const a = hose[i], z = hose[i + 1];
          b.ball(C.hoseRib, a[0] + (z[0] - a[0]) * t, a[1] + (z[1] - a[1]) * t, a[2] + (z[2] - a[2]) * t, 0.02);
        }
      }
    }
    mesh(b);

    // gear handle (wheel-shaped knob, swings up / down, red light in the knob while the gear travels)
    this.gearLever = null;
    if (!liner && spec.gearH > 0) {
      const gb = new Build();
      gb.box(C.black, 0.05, 0.08, 0.012, 0, 0, -0.012);                          // gate plate
      gb.rod(C.metal, [0, 0, 0], [0, 0, 0.09], 0.006);
      gb.ring(C.white, 0, 0, 0.1, 0.022, true);
      this.gearLever = mesh(gb);
      this.gearLever.position.set(cx - 0.36, -0.83, -st.d + 0.13);      // lower-left of the panel, clear of the knee
      this.gearLamp = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
      this.gearLamp.position.set(0, 0, 0.1);
      this.gearLever.add(this.gearLamp);
    }
    // MSL BURN LIMIT guarded switch on the left console, ahead of the throttle (missile carriers only):
    // the red guard lifts while LATCH is held and the toggle flips NORM -> OVRD (s.guard, s.override)
    this.ovrd = null;
    if (!liner && spec.missileCount) {
      const base = new Build();
      for (let i = 0; i < 5; i++) base.box(i & 1 ? C.black : C.yellow, 0.07, 0.004, 0.014, 0, 0, -0.035 + i * 0.014);   // hazard plate
      base.box(C.black, 0.024, 0.016, 0.024, 0, 0.008, 0);
      const plate = mesh(base);
      plate.position.set(-this.cons, -0.497, -0.38);
      const lb = new Build(); lb.rod(C.metal, [0, 0, 0], [0, 0.04, 0], 0.004); lb.ball(C.metal, 0, 0.042, 0, 0.007);
      const lever = mesh(lb, plate); lever.position.set(0, 0.016, 0);
      const gb = new Build();                                   // guard hinged on its far edge
      gb.box(C.red, 0.036, 0.004, 0.05, 0, 0.05, 0.025);
      for (const sg of [-1, 1]) gb.box(C.red, 0.004, 0.05, 0.05, sg * 0.018, 0.025, 0.025);
      const guard = mesh(gb, plate); guard.position.set(0, 0, -0.025);
      this.ovrd = { lever, guard };
    }
    // rudder pedals
    this.pedals = [];
    if (!liner) for (const sg of [-1, 1]) {
      const pb = new Build();
      pb.box(C.metal, 0.1, 0.14, 0.018, 0, 0.07, 0, -0.35);
      pb.box(C.black, 0.09, 0.012, 0.022, 0, 0.11, 0.004, -0.35);
      pb.box(C.black, 0.09, 0.012, 0.022, 0, 0.05, 0.004, -0.35);
      pb.rod(C.trim, [0, 0, 0], [0, -0.06, 0.04], 0.01);
      const m = mesh(pb);
      m.position.set(sg * 0.17, -0.89, -0.56);
      this.pedals.push({ m, s: sg, z: -0.56 });
    }

    // switch panels on the consoles (one shared canvas, drawn once)
    this.swTex = switchTexture();
    this.swMat = new THREE.MeshLambertMaterial({ map: this.swTex, color: new THREE.Color(2.2, 2.2, 2.2) });
    if (!this.plane) this.plane = new THREE.PlaneGeometry(1, 1);
    const sw = (x, z, w, l, flip, y = -0.455) => {
      const m = new THREE.Mesh(this.plane, this.swMat);
      m.scale.set(w, l, 1); m.position.set(x, y, z); m.rotation.set(-Math.PI / 2, 0, flip ? Math.PI : 0);
      pit.add(m);
    };
    if (liner) { sw(-0.4, -0.1, 0.14, 0.66, false); sw(cx, 0.12, 0.24, 0.28, true); }
    else for (const s of [-1, 1]) sw(s * this.cons, 0.1, 0.135, 0.8, s > 0, -0.495);

    // kneeboard on the right thigh: a checklist (and the pilot's own scribbled notes)
    this.knee = null;
    if (!liner) {
      this.kneeTex = kneeboardTexture(spec);
      this.kneeMat = new THREE.MeshLambertMaterial({ map: this.kneeTex, color: new THREE.Color(1.9, 1.9, 1.9) });
      const kb = new THREE.Mesh(this.plane, this.kneeMat);
      kb.scale.set(0.13, 0.17, 1);
      kb.position.set((yoke || spit ? 0.16 : 0.17), -0.625, -0.27); kb.rotation.set(-1.3, 0, 0.12);
      pit.add(kb);
      this.knee = kb;
    }

    // canopy glass: almost invisible head-on, a soft sheen at grazing angles and a sun glint
    this.canopyMat = null;
    if (!liner) {
      this.canopyMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.BackSide,
        uniforms: { uSun: { value: new THREE.Vector3(0, 1, 0) }, uK: { value: 1 } },
        vertexShader: `varying vec3 vN; varying vec3 vW; varying vec3 vL;
          void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vL = position; vN = normalize(mat3(modelMatrix) * normal);
            gl_Position = projectionMatrix * viewMatrix * w; }`,
        fragmentShader: `varying vec3 vN; varying vec3 vW; varying vec3 vL; uniform vec3 uSun; uniform float uK;
          float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
          void main() {
            vec3 V = normalize(cameraPosition - vW), N = -normalize(vN);
            float c = abs(dot(V, N)), fr = pow(1.0 - c, 3.0);
            float gl = pow(max(dot(reflect(-V, N), uSun), 0.0), 120.0);
            // faint wiper-less smears / micro scratches, mostly visible against the sun
            float sc = step(0.995, h(floor(vL.xz * vec2(90.0, 6.0)))) * 0.5;
            float a = (0.02 + fr * 0.28 + gl * 0.55 + sc * 0.04 * (0.3 + gl * 20.0)) * uK;
            gl_FragColor = vec4(mix(vec3(0.62, 0.72, 0.82), vec3(1.0, 0.97, 0.9), clamp(gl * 2.0, 0.0, 1.0)), clamp(a, 0.0, 0.7));
          }`,
      });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), this.canopyMat);
      const half = k === 'fighter' ? 0.62 : 0.5, zc = k === 'fighter' ? -0.2 : -0.1;
      dome.scale.set(st.sill + 0.04, st.arch + 0.31, half + 0.12);
      dome.position.set(cx, -0.33, zc - 0.06);
      dome.renderOrder = 3;
      this.canopyGeo = dome.geometry;
      pit.add(dome);
    }

    // live instrument canvases
    const mkPanel = ([W, H], [y, w], x, z) => {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const m = new THREE.Mesh(this.plane, mat);
      m.scale.set(w, w * H / W, 1); m.position.set(x, y, z); m.rotation.x = -0.2;
      pit.add(m);
      return { c, g: c.getContext('2d'), tex, mat, W, H };
    };
    const px = spec.cockpit === 'airliner' ? 0 : cx;
    this.strip = mkPanel(CANVAS[this.kind][0], st.strip, spec.cockpit === 'airliner' ? cx : px, -st.d + 0.085);
    this.main = mkPanel(CANVAS[this.kind][1], st.main, spec.cockpit === 'airliner' ? cx : px, -st.d + 0.1);
    this.prevHdg = null; this.turnRate = 0;
    this.ann = null;
    if (annOn) {
      const aw = 0.24, W = 384, H = 96;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
      const m = new THREE.Mesh(this.plane, mat);
      // on the glare shield, left of the HUD: where the master caution / warning lights live in a real jet
      m.scale.set(aw, aw * H / W, 1); m.position.set(cx - 0.25, st.shield + 0.03, -st.d - 0.035); m.rotation.x = -0.3;
      pit.add(m);
      this.ann = { c, g: c.getContext('2d'), tex, mat, W, H };
    }

    // controls: stick (spade grip on the warbird), yoke (Cessna), side-stick (airliner); throttle / thrust levers
    const sb = new Build();
    if (yoke) {
      sb.rod(C.metal, [0, 0, -0.02], [0, 0, 0.1], 0.012);
      sb.box(C.black, 0.26, 0.028, 0.028, 0, 0, 0.1);
      for (const s of [-1, 1]) sb.box(C.black, 0.03, 0.1, 0.03, s * 0.13, 0.04, 0.1);
    } else {
      const L = liner ? 0.1 : 0.2;
      sb.ball(C.black, 0, 0.01, 0, 0.05, 0.03, 0.05);                                      // boot
      sb.rod(C.metal, [0, 0, 0], [0, L, 0], 0.012);
      if (spit) { sb.ring(C.black, 0, L + 0.05, 0, 0.05, true); sb.box(C.metal, 0.02, 0.02, 0.012, 0.035, L + 0.085, -0.01); }
      else {
        sb.box(C.black, 0.034, 0.11, 0.04, 0, L + 0.05, 0.004, 0.18);                       // grip
        sb.box(C.black, 0.04, 0.03, 0.05, 0, L + 0.105, -0.006, 0.18);
        sb.box(C.red, 0.012, 0.012, 0.012, -0.012, L + 0.123, -0.012); sb.box(C.metal, 0.014, 0.012, 0.014, 0.01, L + 0.123, -0.006);   // weapon release + trim hat
        sb.box(C.red, 0.01, 0.022, 0.008, 0, L + 0.07, -0.02);                              // trigger
      }
    }
    this.stickLen = (liner ? 0.1 : 0.2) + 0.05;
    this.stick = mesh(sb);
    this.stick.position.set(liner ? -0.4 : 0, yoke ? -0.63 : liner ? -0.455 : -0.86, yoke ? -st.d + 0.2 : liner ? -0.25 : -0.34);
    this.stickZ = this.stick.position.z;
    const tb = new Build();
    if (liner) for (const s of [-1, 1]) { tb.box(C.metal, 0.02, 0.09, 0.02, s * 0.035, 0.04, 0); tb.box(C.black, 0.05, 0.035, 0.045, s * 0.035, 0.095, 0); }
    else { tb.box(C.metal, 0.016, 0.07, 0.02, 0, 0.03, 0); tb.box(C.black, 0.05, 0.05, 0.075, 0.012, 0.085, 0); tb.box(C.metal, 0.012, 0.012, 0.012, 0.03, 0.1, -0.02); }
    this.throttle = mesh(tb);
    this.throttle.position.set(liner ? cx : -this.cons + 0.02, liner ? -0.46 : -0.5, 0);
    // forearms + gloves
    this.limbs = [];
    if (this.arms) {
      this.limbGeo = new THREE.CylinderGeometry(0.8, 1, 1, 8); this.limbGeo.translate(0, 0.5, 0);
      this.handGeo = new THREE.SphereGeometry(1, 8, 6);
      this.suitMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(suit).multiplyScalar(2.2) });
      this.gloveMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(glove).multiplyScalar(2.2) });
      for (const s of [1, -1]) {
        const arm = new THREE.Mesh(this.limbGeo, this.suitMat), hand = new THREE.Mesh(this.handGeo, this.gloveMat);
        hand.scale.set(0.038, 0.045, 0.045);
        pit.add(arm, hand);
        this.limbs.push({ arm, hand, e: new THREE.Vector3(...ELBOW(s, this.cons)) });
      }
    }
    // night: dim red flood light under the glare shield
    this.flood = new THREE.PointLight(0xff6a3c, 0, 2.2, 1.2);
    this.flood.position.set(cx, st.shield - 0.06, -st.d + 0.32);
    pit.add(this.flood);
    this.t = 1; this.frame = 0;
  }

  /** Sun direction (world) for the canopy glint. */
  setSun(dir) { if (this.canopyMat) this.canopyMat.uniforms.uSun.value.copy(dir); }

  /** Night lighting: panel flood on, HUD glass barely visible. */
  setNight(on) {
    this.flood.intensity = on ? 0.16 : 0;
    if (this.canopyMat) this.canopyMat.uniforms.uK.value = on ? 0.35 : 1;
    this.glassBase = on ? 0.02 : 0.07;
    if (this.glassMat) this.glassMat.opacity = this.glassBase;
  }

  update(dt, s) {
    const inp = s.input;
    if (this.spec.key === 'c172') { this.stick.rotation.z = -inp.roll * 0.9; this.stick.position.z = this.stickZ + inp.pitch * 0.05; }
    else this.stick.rotation.set(inp.pitch * 0.3, 0, -inp.roll * 0.3);            // pull = grip towards the pilot
    this.throttle.position.z = (this.kind === 'airliner' ? -0.12 : -0.1) - s.own.throttle * 0.16;
    // the HUD combiner tint shows up against a black sky: fade it as the sky darkens
    if (this.glassMat) this.glassMat.opacity = this.glassBase * (1 - 0.75 * clamp((s.own.alt - 8000) / 22000, 0, 1));
    for (const p of this.pedals) p.m.position.z = p.z - 0.045 * inp.yaw * p.s;
    if (this.ovrd) {
      this.ovrd.guard.rotation.x = -(s.guard || 0) * 1.9;                // flips up and forward
      const want = s.override ? -0.55 : 0.55;
      this.ovrd.lever.rotation.x += (want - this.ovrd.lever.rotation.x) * Math.min(1, dt * 14);
    }
    if (this.gearLever) {
      const gp = s.own.gearPos;
      this.gearLever.rotation.x = 0.55 - 1.1 * gp;                      // handle down = gear down
      this.gearLamp.visible = gp > 0.02 && gp < 0.98;
    }
    if (this.limbs.length) {
      // right hand on the stick, left on the throttle
      this.stick.updateMatrix();
      this.reach(this.limbs[0], _v.set(0, this.stickLen, 0.012).applyMatrix4(this.stick.matrix));
      this.reach(this.limbs[1], _v.copy(this.throttle.position).add(_w.set(0.012, 0.105, 0)));
    }
    // turn rate for the turn coordinator (smoothed)
    const h = s.own.heading;
    if (this.prevHdg !== null && dt > 0) {
      let d = h - this.prevHdg; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
      this.turnRate += (d / dt - this.turnRate) * Math.min(1, dt * 4);
    }
    this.prevHdg = h;
    // needles at ~20 Hz, the busy main panel at ~6 Hz
    this.ts = (this.ts || 0) + dt;
    if (this.ts >= 0.05) { this.ts = 0; this.drawStrip(s); this.strip.tex.needsUpdate = true; }
    this.t += dt;
    if (this.t < 0.16) return;
    this.t = 0;
    this.drawMain(s);
    this.main.tex.needsUpdate = true;
    if (this.ann) { this.drawAnn(s); this.ann.tex.needsUpdate = true; }
  }

  /** Annunciator strip on the glare shield: master warning / caution + engine, thin air, latches, boost. */
  drawAnn(s) {
    const { g, W, H } = this.ann, o = s.own, wn = s.warn, blink = (s.time * 3) % 1 < 0.6;
    panelBg(g, W, H);
    const caution = wn.fuel || wn.damage || wn.overG || o.flameout || s.boost > 0;
    const warning = wn.stall || wn.pullUp || wn.missile;
    const big = (x, a, b, on, col) => {
      G.lamp(g, x, 8, 80, H - 16, '', on, col);
      g.fillStyle = on ? '#140c00' : '#4a4d52'; g.font = 'bold 17px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(a, x + 40, H / 2 - 11); g.fillText(b, x + 40, H / 2 + 12);
    };
    big(6, 'MASTER', 'WARN', warning && blink, G.COLORS.RED);
    big(92, 'MASTER', 'CAUTN', caution, G.COLORS.AMBER);
    const lamps = [['ENG', o.flameout, G.COLORS.RED], ['THIN', o.rho < 0.3 && !o.onGround, G.COLORS.AMBER], ['BOOST', s.boost > 0 && blink, G.COLORS.RED],
      ['LATCH', s.latch, G.COLORS.AMBER], ['OVRD', s.override, G.COLORS.RED], ['', false, G.COLORS.AMBER]];
    lamps.forEach(([t, on, c], i) => G.lamp(g, 178 + (i % 3) * 68, 8 + Math.floor(i / 3) * 42, 64, 36, t, on, c));
  }

  /** Stretch a forearm from its elbow to the hand position `h` (pit coordinates). */
  reach(l, h) {
    l.hand.position.copy(h);
    _w.copy(h).sub(l.e); const len = _w.length();
    l.arm.position.copy(l.e); l.arm.scale.set(0.045, len, 0.045);
    l.arm.quaternion.setFromUnitVectors(UP, _w.multiplyScalar(1 / len));
  }

  /* ---------------- gauge strip ---------------- */
  drawStrip(s) {
    const { g, W, H } = this.strip, o = s.own, k = this.kind;
    panelBg(g, W, H);
    const kt = o.ias * KT, ft = o.alt * FT, fpm = o.vs * 196.85;
    const brg = s.nav ? s.nav.bearing - o.heading : null;
    if (k === 'airliner') {
      // flight control unit on the glare shield
      const cells = [['SPD', String(Math.round(kt))], ['MACH', o.mach.toFixed(2)], ['HDG', String(Math.round((o.heading * 57.2958 + 360) % 360)).padStart(3, '0')],
        ['ALT', String(Math.round(ft / 100) * 100)], ['V/S', (fpm >= 0 ? '+' : '') + String(Math.round(fpm / 100) * 100)]];
      const cw = 150, gap = 18, x0 = (W - (cells.length * cw + (cells.length - 1) * gap)) / 2;
      cells.forEach(([c, t], i) => G.readout(g, x0 + i * (cw + gap), 14, cw, 62, c, t));
      const lamps = [['AP1', !o.onGround], ['A/THR', o.thrEff > 0.2], ['LOC', !!(s.nav && s.nav.ils)], ['G/S', !!(s.nav && s.nav.ils)], ['GEAR', o.gearPos > 0.98]];
      lamps.forEach(([t, on], i) => G.lamp(g, x0 + i * (cw + gap) + 25, 82, cw - 50, 22, t, on, G.COLORS.GREEN));
      return;
    }
    const r = k === 'prop' ? 74 : 54, n = k === 'prop' ? 6 : 8, step = W / n, y = H / 2;
    const X = (i) => step * (i + 0.5);
    G.dial(g, X(0), y, r, k === 'prop'
      ? { min: 0, max: 450, major: 50, minor: 10, a0: -2.6, a1: 2.6, fmt: (v) => v / 10 | 0, label: 'AIRSPEED', unit: 'KNOTS ×10', value: kt, arcs: [[60, 100, '#e8e8e8'], [100, 340, '#2fbf4a'], [340, 400, '#ffb52e'], [400, 450, '#ff4433']] }
      : { min: 0, max: 900, major: 100, minor: 20, a0: -2.6, a1: 2.6, fmt: (v) => v / 100, label: 'KIAS', unit: '×100', value: kt, digital: String(Math.round(kt)) });
    G.adi(g, X(1), y, r, o.pitch, o.bank);
    G.altimeter(g, X(2), y, r, ft);
    if (k === 'prop') {
      G.turnCoord(g, X(3), y, r, this.turnRate, clamp(-s.input.yaw * 0.7 + o.bank * 0.15 - this.turnRate * 0.4, -1, 1));
      G.hsi(g, X(4), y, r, o.heading, brg);
      G.vsi(g, X(5), y, r, fpm);
      return;
    }
    G.vsi(g, X(3), y, r, fpm);
    G.hsi(g, X(4), y, r, o.heading, brg, s.nav ? s.nav.name.split(' ')[0] : 'HDG');
    if (k === 'heli') {
      G.dial(g, X(5), y, r, { min: 0, max: 120, major: 20, minor: 5, label: 'TORQUE', unit: '%', value: o.thrEff * 100, arcs: [[0, 100, '#2fbf4a'], [100, 120, '#ff4433']] });
      G.dial(g, X(6), y, r, { min: 0, max: 120, major: 20, minor: 5, label: 'ROTOR', unit: '% NR', value: o.onGround && o.thrEff < 0.05 ? 0 : 97 + o.thrEff * 4, arcs: [[95, 105, '#2fbf4a'], [105, 120, '#ff4433']] });
    } else {
      G.dial(g, X(5), y, r, { min: -3, max: 10, major: 1, minor: 0.5, a0: -2.5, a1: 2.5, fmt: (v) => (v % 2 ? '' : v), label: 'G', unit: 'ACCEL', value: o.g, arcs: [[o.gMax, 10, '#ff4433']], digital: o.g.toFixed(1) });
      G.dial(g, X(6), y, r, { min: 0, max: 40, major: 5, minor: 1, a0: -2.2, a1: 2.2, fmt: (v) => (v % 10 ? '' : v), label: 'AOA', unit: 'DEG', value: o.aoa * 57.2958, arcs: [[o.aoaMax * 57.2958 * 0.8, o.aoaMax * 57.2958, '#ffb52e'], [o.aoaMax * 57.2958, 40, '#ff4433']] });
    }
    G.dial(g, X(7), y, r, { min: 0, max: 110, major: 10, minor: 5, a0: -2.6, a1: 2.6, fmt: (v) => (v % 20 ? '' : v), label: k === 'heli' ? 'FUEL' : 'RPM', unit: k === 'heli' ? '%' : '% ' + (o.ab ? 'A/B' : ''),
      value: k === 'heli' ? o.fuel : 62 + o.thrEff * 40, arcs: k === 'heli' ? [[0, 15, '#ff4433']] : [[100, 110, '#ff4433']], needle: !k.startsWith('h') && o.ab ? '#ffb52e' : undefined });
  }

  /* ---------------- main panel ---------------- */
  drawMain(s) {
    if (this.kind === 'prop') return this.drawEngine(s);
    if (this.kind === 'airliner') return this.drawGlass(s);
    this.drawMfd(s);
    // warning lamps along the bottom
    const g = this.main.g, o = s.own, wn = s.warn;
    const lamps = [['GEAR', o.gearPos > 0.98, G.COLORS.GREEN], ['STALL', wn.stall || o.stalled, G.COLORS.RED], ['PULL UP', wn.pullUp, G.COLORS.RED],
      ['MISSILE', wn.missile, G.COLORS.RED], ['FUEL', wn.fuel, G.COLORS.AMBER], ['DAMAGE', wn.damage, G.COLORS.AMBER], ['OVER-G', wn.overG, G.COLORS.AMBER], [o.hasAB ? 'A/B' : 'BRAKE', o.hasAB ? o.ab : o.airbrake > 0.1, G.COLORS.AMBER]];
    const lw = 60, x0 = (512 - lamps.length * (lw + 3)) / 2;
    lamps.forEach(([t, on, c], i) => G.lamp(g, x0 + i * (lw + 3), 180, lw, 22, t, on && (c !== G.COLORS.RED || (s.time * 3) % 1 < 0.6), c));
  }

  /** Warbird / light aircraft engine panel: round dials + clock + gear / ammo. */
  drawEngine(s) {
    const { g, W, H } = this.main, o = s.own, w = s.weapons;
    panelBg(g, W, H);
    const r = 62, step = W / 7, y = H / 2 - 6, X = (i) => step * (i + 0.5);
    const rpm = o.onGround && o.thrEff < 0.02 ? 0 : 900 + o.thrEff * 2100;
    G.dial(g, X(0), y, r, { min: 0, max: 3500, major: 500, minor: 100, fmt: (v) => v / 100, label: 'RPM', unit: '×100', value: rpm, arcs: [[2850, 3000, '#ffb52e'], [3000, 3500, '#ff4433']], digital: String(Math.round(rpm / 10) * 10) });
    G.dial(g, X(1), y, r, { min: 10, max: 50, major: 10, minor: 2, label: 'MANIFOLD', unit: 'IN HG', value: 15 + o.throttle * 28, arcs: [[15, 38, '#2fbf4a'], [44, 50, '#ff4433']] });
    G.dial(g, X(2), y, r, { min: 0, max: 120, major: 20, minor: 10, label: 'OIL °C', value: 40 + o.thrEff * 45, arcs: [[60, 95, '#2fbf4a'], [105, 120, '#ff4433']] });
    G.dial(g, X(3), y, r, { min: 0, max: 100, major: 20, minor: 10, label: 'OIL PSI', value: o.thrEff > 0.02 || !o.onGround ? 55 + o.thrEff * 20 : 0, arcs: [[50, 90, '#2fbf4a']] });
    G.dial(g, X(4), y, r, { min: 0, max: 100, major: 25, minor: 5, a0: -1.6, a1: 1.6, fmt: (v) => ['E', '¼', '½', '¾', 'F'][v / 25], label: 'FUEL', value: o.fuel, arcs: [[0, 15, '#ff4433']] });
    const t = new Date(), mins = t.getMinutes() + t.getSeconds() / 60, hrs = (t.getHours() % 12) + mins / 60;
    G.dial(g, X(5), y, r, { min: 0, max: 11, major: 1, minor: 0.2, a0: 0, a1: Math.PI * 2 * 11 / 12, fmt: (v) => v || 12, label: 'CLOCK', value: hrs % 12, needle: '#f2f2ec' });
    g.save(); g.translate(X(5), y); g.rotate(mins / 60 * Math.PI * 2); g.fillStyle = '#f2f2ec'; g.fillRect(-1.5, -r * 0.8, 3, r * 0.8); g.restore();
    // gear + ammo
    const bx = X(6) - 52;
    G.lamp(g, bx, 22, 104, 26, o.gearPos > 0.98 ? 'GEAR DOWN' : o.gearPos < 0.02 ? 'GEAR UP' : 'GEAR ···', true, o.gearPos > 0.98 ? G.COLORS.GREEN : o.gearPos < 0.02 ? '#555' : G.COLORS.RED);
    if (w.hasGun) G.readout(g, bx, 60, 104, 50, 'ROUNDS', String(w.gun), w.gun ? G.COLORS.AMBER : G.COLORS.RED);
    G.lamp(g, bx, 120, 104, 26, 'STALL', s.warn.stall || o.stalled, G.COLORS.RED);
    G.lamp(g, bx, 152, 104, 26, 'LOW FUEL', s.warn.fuel, G.COLORS.AMBER);
  }

  /** Airliner glass: PFD | ND | EICAS. */
  drawGlass(s) {
    const { g, W, H } = this.main, o = s.own;
    panelBg(g, W, H);
    const pw = 440, pad = 22;
    G.pfd(g, pad, 14, pw, H - 28, o, s.nav && s.nav.ils);
    G.nd(g, pad * 2 + pw, 14, pw, H - 28, o.heading, s.nav);
    const ex = pad * 3 + pw * 2, ew = W - ex - pad;
    g.fillStyle = '#000'; g.fillRect(ex, 14, ew, H - 28);
    const pct = o.onGround && o.thrEff < 0.02 ? 19 : 22 + o.thrEff * 80;
    G.n1(g, ex + ew * 0.28, 110, 62, pct, 'N1 ENG 1');
    G.n1(g, ex + ew * 0.72, 110, 62, pct + 0.3, 'N1 ENG 2');
    G.readout(g, ex + 20, 200, ew - 40, 52, 'FUEL  ' + Math.round(o.fuel) + ' %', (Math.round(o.fuel * 189) + ' KG'), o.fuel < 15 ? G.COLORS.AMBER : G.COLORS.GREEN);
    G.lamp(g, ex + 20, 266, (ew - 50) / 2, 24, o.gearPos > 0.98 ? 'GEAR DN' : 'GEAR UP', true, o.gearPos > 0.98 ? G.COLORS.GREEN : '#555');
    G.lamp(g, ex + 30 + (ew - 50) / 2, 266, (ew - 50) / 2, 24, 'SPD BRK', o.airbrake > 0.1, G.COLORS.AMBER);
  }

  drawMfd(s) {
    const g = this.main.g, o = s.own, w = s.weapons, W = 512, H = 208;
    g.fillStyle = '#0b0d10'; g.fillRect(0, 0, W, H);
    g.lineWidth = 1.5; g.font = 'bold 13px monospace'; g.textBaseline = 'middle';
    const scr = (x) => { g.fillStyle = '#020805'; g.fillRect(x, 8, 160, 160); g.strokeStyle = '#3a4047'; g.strokeRect(x, 8, 160, 160); };

    // --- left: radar / tactical ---
    scr(8);
    g.save(); g.beginPath(); g.rect(8, 8, 160, 160); g.clip();
    const cx = 88, cy = 110, k = 95 / s.radarRange, sh = Math.sin(o.heading), ch = Math.cos(o.heading);
    g.strokeStyle = DIM;
    g.beginPath(); g.arc(cx, cy, 47, 0, 6.3); g.moveTo(cx + 95, cy); g.arc(cx, cy, 95, 0, 6.3); g.moveTo(cx, cy); g.lineTo(cx, 8); g.stroke();
    for (const u of s.units) {
      if (!u.alive || u.isPlayer) continue;
      const e = u.pos.x - o.pos.x, n = -(u.pos.z - o.pos.z);
      const px = cx + (e * ch - n * sh) * k, py = cy - (e * sh + n * ch) * k;
      g.fillStyle = u.team === 1 ? RED : GREEN;
      if (u.kind === 'ground') g.fillRect(px - 2, py - 2, 4, 4); else { g.beginPath(); g.arc(px, py, 3, 0, 6.3); g.fill(); }
    }
    g.fillStyle = GREEN; g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx - 4, cy + 4); g.lineTo(cx + 4, cy + 4); g.fill();
    g.restore();
    g.fillStyle = GREEN; g.textAlign = 'left'; g.fillText('RDR ' + Math.round(s.radarRange / 1000) + 'KM', 14, 19);

    // --- centre: attitude ---
    scr(176);
    g.save(); g.beginPath(); g.rect(176, 8, 160, 160); g.clip();
    g.translate(256, 88); g.rotate(-o.bank);
    const py = o.pitch * 150;
    g.fillStyle = '#1d4a7a'; g.fillRect(-200, -300 + py, 400, 300);
    g.fillStyle = '#5a3d22'; g.fillRect(-200, py, 400, 300);
    g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(-200, py); g.lineTo(200, py);
    for (let d = -60; d <= 60; d += 10) { if (!d) continue; const y = py - d * Math.PI / 180 * 150; g.moveTo(-18, y); g.lineTo(18, y); }
    g.stroke();
    g.restore();
    g.strokeStyle = AMBER; g.lineWidth = 3; g.beginPath(); g.moveTo(226, 88); g.lineTo(246, 88); g.moveTo(266, 88); g.lineTo(286, 88); g.moveTo(256, 84); g.lineTo(256, 92); g.stroke();
    g.lineWidth = 1.5; g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(Math.round(o.ias * KT) + ' KT', 181, 19);
    g.textAlign = 'right'; g.fillText(Math.round(o.alt * FT) + ' FT', 331, 19);
    g.textAlign = 'center'; g.fillText(('00' + (Math.round(o.heading * 57.2958) % 360)).slice(-3) + '°', 256, 158);

    // --- right: stores + engine ---
    scr(344);
    g.textAlign = 'left';
    const row = (y, label, val, col = GREEN) => { g.fillStyle = DIM; g.fillText(label, 352, y); g.fillStyle = col; g.fillText(val, 410, y); };
    const bar = (y, f, col) => { g.strokeStyle = DIM; g.strokeRect(410, y - 5, 84, 10); g.fillStyle = col; g.fillRect(410, y - 5, 84 * Math.max(0, Math.min(1, f)), 10); };
    g.fillStyle = DIM; g.fillText('THR', 352, 24); bar(24, o.thrEff, o.ab ? AMBER : GREEN);
    g.fillStyle = DIM; g.fillText('FUEL', 352, 44); bar(44, o.fuel / 100, o.fuel < 15 ? AMBER : GREEN);
    g.fillStyle = DIM; g.fillText('HULL', 352, 64); bar(64, o.hp, o.hp < 0.35 ? RED : GREEN);
    row(88, 'GUN', w.hasGun ? String(w.gun) : '--', w.gun > 0 ? GREEN : AMBER);
    row(106, 'MSL', w.hasMissiles ? String(w.missiles) : '--', w.missiles > 0 ? GREEN : AMBER);
    row(124, 'FLR', String(w.flares));
    row(142, 'GEAR', o.gearPos > 0.98 ? 'DOWN' : o.gearPos < 0.02 ? 'UP' : '----', o.gearPos > 0.02 && o.gearPos < 0.98 ? AMBER : GREEN);
    row(160, 'G', o.g.toFixed(1), o.g > o.gMax * 0.95 ? AMBER : GREEN);
  }

  dispose() {
    for (const g of this.geos) g.dispose();
    this.plane.dispose(); this.mat.dispose(); this.swMat.dispose(); this.swTex.dispose();
    if (this.glassMat) this.glassMat.dispose();
    if (this.limbGeo) { this.limbGeo.dispose(); this.handGeo.dispose(); this.suitMat.dispose(); this.gloveMat.dispose(); }
    for (const p of [this.strip, this.main, this.ann]) if (p) { p.mat.dispose(); p.tex.dispose(); }
    if (this.canopyMat) { this.canopyMat.dispose(); this.canopyGeo.dispose(); }
    if (this.kneeMat) { this.kneeMat.dispose(); this.kneeTex.dispose(); }
    if (this.gearLamp) { this.gearLamp.geometry.dispose(); this.gearLamp.material.dispose(); }
  }
}

/* ---------------- static geometry builder ---------------- */
const C = { dark: 0x3d4248, trim: 0x62686f, black: 0x17191b, seat: 0x5a6054, strap: 0x7d7a66, metal: 0x9aa0a6, yellow: 0xd9b21c, red: 0xb5281e, mirror: 0x9fb6cc,
  white: 0xdedbd0, amber: 0xd98a1c, green: 0x2f8a3c, hose: 0x3c4436, hoseRib: 0x2e3529 };
const UP = new THREE.Vector3(0, 1, 0), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const ELBOW = (s, cons) => [s * Math.min(0.26, cons - 0.11), -0.6, 0.04];
const _m = new THREE.Matrix4(), _nm = new THREE.Matrix3(), _eu = new THREE.Euler(), _q = new THREE.Quaternion(), _sc = new THREE.Vector3(), _tr = new THREE.Vector3(), _col = new THREE.Color();
const UNIT = {};
function unit(name) {
  if (UNIT[name]) return UNIT[name];
  let g;
  if (name === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else if (name === 'cyl') { g = new THREE.CylinderGeometry(1, 1, 1, 10); g.translate(0, 0.5, 0); }
  else if (name === 'ball') g = new THREE.SphereGeometry(1, 10, 8);
  else if (name === 'arch') g = new THREE.TorusGeometry(1, 0.03, 5, 20, Math.PI);
  else g = new THREE.TorusGeometry(1, 0.2, 6, 16);
  return (UNIT[name] = g.toNonIndexed());
}

/** Collects transformed primitives into one vertex-coloured geometry. */
class Build {
  constructor() { this.pos = []; this.nor = []; this.col = []; }
  put(name, hex, m) {
    const g = unit(name), p = g.attributes.position, n = g.attributes.normal;
    _nm.getNormalMatrix(m); _col.setHex(hex);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(m); this.pos.push(_v.x, _v.y, _v.z);
      _v.fromBufferAttribute(n, i).applyMatrix3(_nm).normalize(); this.nor.push(_v.x, _v.y, _v.z);
      this.col.push(_col.r, _col.g, _col.b);
    }
  }
  box(hex, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) { this.put('box', hex, _m.compose(_tr.set(x, y, z), _q.setFromEuler(_eu.set(rx, ry, rz)), _sc.set(sx, sy, sz))); }
  ball(hex, x, y, z, rx, ry = rx, rz = rx) { this.put('ball', hex, _m.compose(_tr.set(x, y, z), _q.identity(), _sc.set(rx, ry, rz))); }
  rod(hex, a, b, r) {
    _w.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]); const len = _w.length();
    this.put('cyl', hex, _m.compose(_tr.set(a[0], a[1], a[2]), _q.setFromUnitVectors(UP, _w.multiplyScalar(1 / len)), _sc.set(r, len, r)));
  }
  arch(hex, x, y, z, w, h, tube) { this.put('arch', hex, _m.compose(_tr.set(x, y, z), _q.identity(), _sc.set(w, h, tube))); }
  /** A ring of radius r lying flat (axis y), or upright facing the pilot. */
  ring(hex, x, y, z, r, upright = false) { this.put('ring', hex, _m.compose(_tr.set(x, y, z), _q.setFromEuler(_eu.set(upright ? 0 : Math.PI / 2, 0, 0)), _sc.set(r, r, r))); }
  mesh(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return new THREE.Mesh(g, mat);
  }
}

/** Kneeboard card: clip, checklist, a frequency table and the pilot's pencilled notes. */
function kneeboardTexture(spec) {
  const W = 256, H = 336, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#2b2d2f'; g.fillRect(0, 0, W, H);                         // board
  g.fillStyle = '#ece8dc'; g.fillRect(10, 26, W - 20, H - 36);             // paper
  g.fillStyle = '#8c9096'; g.fillRect(W / 2 - 46, 4, 92, 30);              // clip
  g.fillStyle = '#5c6066'; g.fillRect(W / 2 - 30, 10, 60, 8);
  g.fillStyle = '#1c1c1c'; g.font = 'bold 15px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText((spec.short || 'ACFT') + ' CHECKLIST', W / 2, 48);
  g.font = '12px monospace'; g.textAlign = 'left';
  const items = [['TAKEOFF', ''], ['FLAPS', 'T/O'], ['THROTTLE', spec.ab > 1 ? 'MIL/AB' : 'FULL'], ['ROTATE', Math.round(spec.vStall * 1.943844 * 1.1) + ' KT'], ['GEAR', 'UP'],
    ['LANDING', ''], ['GEAR', '3 GREEN'], ['SPEED', Math.round(spec.vStall * 1.943844 * 1.3) + ' KT'], ['SINK', '< 600 FPM']];
  items.forEach(([a, b], i) => {
    const y = 74 + i * 19;
    if (!b) { g.font = 'bold 12px monospace'; g.fillText(a, 18, y); g.font = '12px monospace'; return; }
    g.fillText(a, 26, y); g.textAlign = 'right'; g.fillText(b, W - 20, y); g.textAlign = 'left';
    g.fillStyle = 'rgba(0,0,0,0.25)'; for (let x = 26 + g.measureText(a).width + 4; x < W - 24 - g.measureText(b).width; x += 5) g.fillRect(x, y + 3, 2, 1);
    g.fillStyle = '#1c1c1c';
  });
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.moveTo(18, 250); g.lineTo(W - 18, 250); g.stroke();
  // pencilled notes
  g.fillStyle = '#3a4a8a'; g.font = 'italic 13px serif';
  g.fillText('EMERG: pull handle  (J J)', 20, 270);
  if (spec.missileCount) { g.fillText('latch rails + fire = BOOST!', 20, 284); g.fillText('hold LATCH: limiter OVRD', 20, 300); }
  g.fillText('above 11 km: air too thin...', 20, 318);
  return Object.assign(new THREE.CanvasTexture(c), { colorSpace: THREE.SRGBColorSpace, anisotropy: 4 });
}

/** Console switch panel: rows of toggles, knobs, push-buttons and engraved legends. */
function switchTexture() {
  const W = 128, H = 1024, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  let q = 977; const rnd = () => (q = (q * 1664525 + 1013904223) >>> 0) / 4294967296;
  g.fillStyle = '#1d2024'; g.fillRect(0, 0, W, H);
  g.font = 'bold 9px monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  const words = ['FUEL', 'HYD', 'ELEC', 'ECS', 'COMM', 'NAV', 'LIGHTS', 'IFF', 'OXY', 'APU', 'ANTI-ICE', 'TRIM'];
  for (let y = 6, i = 0; y < H - 90; i++) {
    const h = 86 + Math.floor(rnd() * 3) * 22, kind = Math.floor(rnd() * 3);
    g.fillStyle = '#2a2e33'; g.fillRect(6, y, W - 12, h - 6);
    g.strokeStyle = '#4a5058'; g.lineWidth = 1; g.strokeRect(6.5, y + 0.5, W - 13, h - 7);
    g.fillStyle = '#c9cdd1'; g.fillText(words[i % words.length], W / 2, y + 10);
    for (const [sx, sy] of [[11, y + 5], [W - 11, y + 5], [11, y + h - 11], [W - 11, y + h - 11]]) { g.fillStyle = '#6a7078'; g.beginPath(); g.arc(sx, sy, 2, 0, 7); g.fill(); }
    for (let ry = y + 30; ry < y + h - 18; ry += 28) for (let rx = 26; rx < W - 12; rx += 38) {
      if (kind === 0) {            // toggle switch
        const up = rnd() < 0.5;
        g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(rx, ry, 7, 0, 7); g.fill();
        g.strokeStyle = '#d8dce0'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(rx, ry); g.lineTo(rx, ry + (up ? -8 : 8)); g.stroke();
      } else if (kind === 1) {     // rotary knob
        const a = rnd() * 5;
        g.fillStyle = '#0c0d0f'; g.beginPath(); g.arc(rx, ry, 10, 0, 7); g.fill();
        g.fillStyle = '#3c4148'; g.beginPath(); g.arc(rx, ry, 7.5, 0, 7); g.fill();
        g.strokeStyle = '#e8e8e0'; g.lineWidth = 2; g.beginPath(); g.moveTo(rx, ry); g.lineTo(rx + Math.cos(a) * 7, ry + Math.sin(a) * 7); g.stroke();
      } else {                     // lit push-button
        const on = rnd() < 0.4;
        g.fillStyle = '#0c0d0f'; g.fillRect(rx - 11, ry - 8, 22, 16);
        g.fillStyle = on ? ['#2fbf4a', '#ffb52e', '#58a6ff'][Math.floor(rnd() * 3)] : '#3a3f45'; g.fillRect(rx - 9, ry - 6, 18, 12);
      }
    }
    y += h;
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Painted metal panel with a faint brushed texture. */
function panelBg(g, W, H) {
  g.fillStyle = '#23272c'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
}
