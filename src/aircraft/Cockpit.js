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

    const dark = this.dark = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x3d4248).multiplyScalar(2.2) });
    const trim = this.trim = new THREE.MeshLambertMaterial({ color: new THREE.Color(0x62686f).multiplyScalar(2.2) });
    const box = this.box = new THREE.BoxGeometry(1, 1, 1);
    const add = (mat, sx, sy, sz, x, y, z, rx = 0, rz = 0) => {
      const m = new THREE.Mesh(box, mat);
      m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.rotation.set(rx, 0, rz);
      pit.add(m);
      return m;
    };

    // glare shield, panel, sills, floor
    add(dark, st.w + 0.16, 0.04, 0.3, cx, st.shield, -st.d - 0.12, 0.12);
    add(dark, st.w + 0.16, 0.66, 0.05, cx, -0.58, -st.d + 0.05, -0.2);
    for (const s of [-1, 1]) {
      add(dark, 0.07, 0.5, 1.5, cx + s * (st.sill + 0.03), -0.6, -0.1);
      add(trim, 0.09, 0.03, 1.5, cx + s * (st.sill + 0.03), -0.345, -0.1);
    }
    add(dark, st.sill * 2, 0.04, 1.5, cx, -0.86, -0.1);
    if (spec.cockpit !== 'airliner') add(trim, 0.16, 0.04, 0.14, 0, st.shield + 0.04, -st.d - 0.02);        // HUD / gunsight projector

    // canopy / windscreen frame
    this.arch = new THREE.TorusGeometry(1, 0.03, 5, 20, Math.PI);
    const bow = (z, w, h, tube) => {
      const m = new THREE.Mesh(this.arch, trim);
      m.scale.set(w, h, tube); m.position.set(cx, -0.33, z);
      pit.add(m);
    };
    if (st.frame === 'bow') { bow(-st.d - 0.12, st.sill + 0.06, st.arch + 0.33, 1); bow(0.42, st.sill + 0.06, st.arch + 0.36, 1.2); }
    else if (st.frame === 'cage') {
      bow(-st.d - 0.1, st.sill + 0.05, st.arch + 0.33, 1); bow(0.05, st.sill + 0.05, st.arch + 0.36, 1); bow(0.6, st.sill + 0.05, st.arch + 0.3, 1);
      add(trim, 0.03, 0.03, st.d + 0.2, 0, st.arch, -st.d / 2 + 0.05);
    } else {
      for (const x of [-1.35, -0.62, 0.62, 1.35]) add(trim, 0.07, 0.95, 0.07, cx + x, 0.1, -st.d - 0.22, 0.25);
      add(dark, st.w + 0.6, 0.06, 1.0, cx, 0.58, -0.4, -0.2);
      for (const s of [-1, 1]) add(trim, 0.07, 0.9, 0.07, cx + s * (st.sill + 0.03), 0.1, -0.1);
    }

    // live instrument canvases
    this.kind = spec.cockpit in CANVAS ? spec.cockpit : 'fighter';
    this.plane = new THREE.PlaneGeometry(1, 1);
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

    // stick + throttle
    this.stickGeo = new THREE.CylinderGeometry(0.016, 0.02, 0.3, 6); this.stickGeo.translate(0, 0.15, 0);
    this.stick = new THREE.Mesh(this.stickGeo, trim);
    this.stick.position.set(0, -0.86, -0.34);
    pit.add(this.stick);
    this.throttle = add(trim, 0.05, 0.07, 0.1, cx - st.sill + 0.06, -0.36, -0.2);
    this.t = 1; this.frame = 0;
  }

  update(dt, s) {
    this.stick.rotation.set(-s.input.pitch * 0.3, 0, -s.input.roll * 0.3);
    this.throttle.position.z = -0.12 - s.own.throttle * 0.16;
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
    this.box.dispose(); this.arch.dispose(); this.plane.dispose(); this.stickGeo.dispose();
    this.dark.dispose(); this.trim.dispose();
    for (const p of [this.strip, this.main]) { p.mat.dispose(); p.tex.dispose(); }
  }
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Painted metal panel with a faint brushed texture. */
function panelBg(g, W, H) {
  g.fillStyle = '#23272c'; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < H; y += 3) g.fillRect(0, y, W, 1);
}
