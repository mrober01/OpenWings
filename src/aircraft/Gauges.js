// Gauges.js — 2D-canvas instrument drawing for the cockpit panels (no three.js).
// Every function draws one instrument centred on (x, y) with radius r (round dials) or in a
// box (glass displays). Units in: knots, feet, feet/min, degrees/radians as named.
const TAU = Math.PI * 2, D2R = Math.PI / 180;
const WHITE = '#f2f2ec', DIMW = 'rgba(242,242,236,0.55)', FACE = '#0d0f11', AMBER = '#ffb52e', RED = '#ff4433', GREEN = '#3dff72', CYAN = '#4fd8ff', MAG = '#ff5cf0';

const font = (g, px, bold = true) => { g.font = `${bold ? 'bold ' : ''}${Math.round(px)}px "Helvetica Neue", Arial, sans-serif`; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Dark face with a machined bezel and screw heads. */
export function bezel(g, x, y, r) {
  const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.4, r * 0.2, x, y, r * 1.15);
  grd.addColorStop(0, '#5a5f66'); grd.addColorStop(1, '#16181b');
  g.fillStyle = grd; g.beginPath(); g.arc(x, y, r * 1.12, 0, TAU); g.fill();
  g.fillStyle = FACE; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  g.fillStyle = '#2b2f34';
  for (const a of [0.785, 2.356, 3.927, 5.498]) { g.beginPath(); g.arc(x + Math.cos(a) * r * 1.2, y + Math.sin(a) * r * 1.2, r * 0.07, 0, TAU); g.fill(); }
}

/** Glass reflection over a dial. */
function glass(g, x, y, r) {
  const grd = g.createLinearGradient(x - r, y - r, x + r * 0.2, y + r * 0.4);
  grd.addColorStop(0, 'rgba(255,255,255,0.10)'); grd.addColorStop(0.5, 'rgba(255,255,255,0.02)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}

function needle(g, x, y, ang, len, w, col = WHITE, tail = 0.18) {
  g.save(); g.translate(x, y); g.rotate(ang);
  g.fillStyle = col; g.beginPath();
  g.moveTo(-w, len * tail); g.lineTo(-w * 0.55, -len * 0.82); g.lineTo(0, -len); g.lineTo(w * 0.55, -len * 0.82); g.lineTo(w, len * tail); g.closePath(); g.fill();
  g.restore();
}
function hub(g, x, y, r) { g.fillStyle = '#3a3e44'; g.beginPath(); g.arc(x, y, r * 0.09, 0, TAU); g.fill(); }

/**
 * Generic needle dial. o = { min, max, a0, a1 (radians, 0 = up, clockwise), major, minor,
 * label (centre text), unit, fmt(v) for scale numbers, arcs: [[from, to, colour]], value, digital? }
 */
export function dial(g, x, y, r, o) {
  bezel(g, x, y, r);
  const a0 = o.a0 ?? -2.35, a1 = o.a1 ?? 2.35;
  const ang = (v) => a0 + (clamp(v, o.min, o.max) - o.min) / (o.max - o.min) * (a1 - a0);
  for (const [f, t, c] of o.arcs || []) {
    g.strokeStyle = c; g.lineWidth = r * 0.07; g.beginPath();
    g.arc(x, y, r * 0.86, ang(f) - Math.PI / 2, ang(t) - Math.PI / 2); g.stroke();
  }
  g.strokeStyle = WHITE;
  if (o.minor) for (let v = o.min; v <= o.max + 1e-6; v += o.minor) {
    const a = ang(v) - Math.PI / 2; g.lineWidth = r * 0.025;
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.92, y + Math.sin(a) * r * 0.92); g.lineTo(x + Math.cos(a) * r * 0.82, y + Math.sin(a) * r * 0.82); g.stroke();
  }
  font(g, r * 0.2); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let v = o.min; v <= o.max + 1e-6; v += o.major) {
    const a = ang(v) - Math.PI / 2; g.lineWidth = r * 0.05;
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.94, y + Math.sin(a) * r * 0.94); g.lineTo(x + Math.cos(a) * r * 0.74, y + Math.sin(a) * r * 0.74); g.stroke();
    if (o.fmt !== null) g.fillText((o.fmt || String)(v), x + Math.cos(a) * r * 0.56, y + Math.sin(a) * r * 0.56);
  }
  font(g, r * 0.15, false); g.fillStyle = DIMW;
  if (o.label) g.fillText(o.label, x, y + r * (o.digital ? -0.3 : 0.3));
  if (o.unit) g.fillText(o.unit, x, y + r * 0.48);
  if (o.digital) { font(g, r * 0.2); g.fillStyle = WHITE; g.fillText(o.digital, x, y + r * 0.3); }
  needle(g, x, y, ang(o.value), r * 0.82, r * 0.06, o.needle || WHITE);
  hub(g, x, y, r);
  glass(g, x, y, r);
}

/** Attitude indicator (artificial horizon). pitch / bank in radians. */
export function adi(g, x, y, r, pitch, bank) {
  bezel(g, x, y, r);
  g.save(); g.beginPath(); g.arc(x, y, r, 0, TAU); g.clip();
  g.translate(x, y); g.rotate(-bank);
  const k = r * 2.2, py = pitch * k;
  g.fillStyle = '#2e6db4'; g.fillRect(-r * 2, -r * 4 + py, r * 4, r * 4);
  g.fillStyle = '#6b4424'; g.fillRect(-r * 2, py, r * 4, r * 4);
  g.strokeStyle = WHITE; g.lineWidth = r * 0.03; g.beginPath(); g.moveTo(-r * 2, py); g.lineTo(r * 2, py); g.stroke();
  font(g, r * 0.13); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = -40; d <= 40; d += 10) {
    if (!d) continue;
    const yy = py - d * D2R * k, w = d % 20 ? r * 0.18 : r * 0.34;
    g.beginPath(); g.moveTo(-w, yy); g.lineTo(w, yy); g.stroke();
    if (!(d % 20)) { g.fillText(Math.abs(d), -w - r * 0.14, yy); g.fillText(Math.abs(d), w + r * 0.14, yy); }
  }
  g.restore();
  // bank scale + pointer (fixed to the case)
  g.strokeStyle = WHITE; g.lineWidth = r * 0.03;
  for (const d of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const a = d * D2R - Math.PI / 2, l = d % 30 ? 0.86 : 0.8;
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.97, y + Math.sin(a) * r * 0.97); g.lineTo(x + Math.cos(a) * r * l, y + Math.sin(a) * r * l); g.stroke();
  }
  g.save(); g.translate(x, y); g.rotate(-bank);
  g.fillStyle = AMBER; g.beginPath(); g.moveTo(0, -r * 0.78); g.lineTo(-r * 0.07, -r * 0.66); g.lineTo(r * 0.07, -r * 0.66); g.fill();
  g.restore();
  // aircraft symbol
  g.strokeStyle = AMBER; g.lineWidth = r * 0.07; g.lineCap = 'round';
  g.beginPath(); g.moveTo(x - r * 0.5, y); g.lineTo(x - r * 0.18, y); g.lineTo(x - r * 0.1, y + r * 0.08);
  g.moveTo(x + r * 0.5, y); g.lineTo(x + r * 0.18, y); g.lineTo(x + r * 0.1, y + r * 0.08); g.stroke();
  g.fillStyle = AMBER; g.beginPath(); g.arc(x, y, r * 0.04, 0, TAU); g.fill();
  g.lineCap = 'butt';
  glass(g, x, y, r);
}

/** Three-pointer altimeter with a drum readout. */
export function altimeter(g, x, y, r, ft) {
  dial(g, x, y, r, { min: 0, max: 1000, a0: 0, a1: TAU * 0.999, major: 100, minor: 20, fmt: (v) => (v === 1000 ? '' : v / 100), value: 0, needle: 'rgba(0,0,0,0)', label: 'ALT', unit: 'FEET' });
  const f = Math.max(0, ft);
  g.fillStyle = '#000'; g.fillRect(x - r * 0.36, y - r * 0.12, r * 0.72, r * 0.24);
  g.strokeStyle = '#555'; g.lineWidth = 1; g.strokeRect(x - r * 0.36, y - r * 0.12, r * 0.72, r * 0.24);
  font(g, r * 0.19); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(Math.round(f / 10) * 10).padStart(5, '0'), x, y + 1);
  needle(g, x, y, (f % 10000) / 10000 * TAU, r * 0.5, r * 0.09, WHITE, 0.1);     // 10 000s: short fat
  needle(g, x, y, (f % 1000) / 1000 * TAU, r * 0.84, r * 0.045, WHITE, 0.15);   // 100s: long thin
  hub(g, x, y, r);
  glass(g, x, y, r);
}

/** Vertical speed, ±6000 ft/min on a compressed scale. */
export function vsi(g, x, y, r, fpm) {
  const sc = (v) => Math.sign(v) * Math.sqrt(Math.abs(v) / 6000) * 6000;
  bezel(g, x, y, r);
  g.strokeStyle = WHITE; font(g, r * 0.19); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  const ang = (v) => -Math.PI / 2 + sc(clamp(v, -6000, 6000)) / 6000 * 2.7;
  for (const v of [-6000, -4000, -2000, -1000, -500, 0, 500, 1000, 2000, 4000, 6000]) {
    const a = ang(v); g.lineWidth = r * 0.045;
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.93, y + Math.sin(a) * r * 0.93); g.lineTo(x + Math.cos(a) * r * 0.76, y + Math.sin(a) * r * 0.76); g.stroke();
    if (Math.abs(v) >= 1000 || v === 0) g.fillText(Math.abs(v) / 1000 || '0', x + Math.cos(a) * r * 0.57, y + Math.sin(a) * r * 0.57);
  }
  font(g, r * 0.13, false); g.fillStyle = DIMW; g.fillText('UP', x - r * 0.3, y - r * 0.28); g.fillText('DN', x - r * 0.3, y + r * 0.28);
  g.fillText('×1000 FT/MIN', x + r * 0.15, y + r * 0.08);
  needle(g, x, y, ang(fpm) + Math.PI / 2, r * 0.84, r * 0.06);
  hub(g, x, y, r);
  glass(g, x, y, r);
}

/** Compass card / HSI: card turns with heading; optional bearing pointer (radians). */
export function hsi(g, x, y, r, hdg, brg = null, label = 'HDG') {
  bezel(g, x, y, r);
  g.save(); g.translate(x, y); g.rotate(-hdg);
  g.strokeStyle = WHITE; font(g, r * 0.19); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    const a = d * D2R - Math.PI / 2, l = d % 30 ? (d % 10 ? 0.9 : 0.84) : 0.8; g.lineWidth = r * (d % 10 ? 0.02 : 0.035);
    g.beginPath(); g.moveTo(Math.cos(a) * r * 0.96, Math.sin(a) * r * 0.96); g.lineTo(Math.cos(a) * r * l, Math.sin(a) * r * l); g.stroke();
    if (!(d % 30)) {
      g.save(); g.rotate(d * D2R); g.fillText({ 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] || d / 10, 0, -r * 0.64); g.restore();
    }
  }
  if (brg !== null) {
    g.save(); g.rotate(brg);
    g.strokeStyle = CYAN; g.lineWidth = r * 0.05;
    g.beginPath(); g.moveTo(0, r * 0.75); g.lineTo(0, -r * 0.62); g.stroke();
    g.fillStyle = CYAN; g.beginPath(); g.moveTo(0, -r * 0.8); g.lineTo(-r * 0.1, -r * 0.6); g.lineTo(r * 0.1, -r * 0.6); g.fill();
    g.restore();
  }
  g.restore();
  // lubber line + aircraft
  g.fillStyle = AMBER; g.beginPath(); g.moveTo(x, y - r * 0.98); g.lineTo(x - r * 0.07, y - r * 0.84); g.lineTo(x + r * 0.07, y - r * 0.84); g.fill();
  g.strokeStyle = AMBER; g.lineWidth = r * 0.05;
  g.beginPath(); g.moveTo(x, y - r * 0.28); g.lineTo(x, y + r * 0.26); g.moveTo(x - r * 0.24, y - r * 0.02); g.lineTo(x + r * 0.24, y - r * 0.02);
  g.moveTo(x - r * 0.1, y + r * 0.22); g.lineTo(x + r * 0.1, y + r * 0.22); g.stroke();
  font(g, r * 0.13, false); g.fillStyle = DIMW; g.textAlign = 'center'; g.fillText(label, x, y + r * 0.45);
  glass(g, x, y, r);
}

/** Turn coordinator: little aeroplane banks with turn rate (rad/s), ball shows slip (-1..1). */
export function turnCoord(g, x, y, r, rate, slip) {
  bezel(g, x, y, r);
  font(g, r * 0.15); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('L', x - r * 0.72, y + r * 0.25); g.fillText('R', x + r * 0.72, y + r * 0.25);
  g.strokeStyle = WHITE; g.lineWidth = r * 0.05;
  for (const a of [0, -0.33, 0.33]) {          // wings-level and standard-rate marks, both sides
    g.beginPath(); g.moveTo(x - Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62); g.lineTo(x - Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8); g.stroke();
    g.beginPath(); g.moveTo(x + Math.cos(a) * r * 0.62, y + Math.sin(a) * r * 0.62); g.lineTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8); g.stroke();
  }
  const tilt = clamp(rate / (3 * D2R), -1.6, 1.6) * 0.33;       // standard rate (3°/s) = the marks
  g.save(); g.translate(x, y); g.rotate(tilt);
  g.strokeStyle = WHITE; g.lineWidth = r * 0.07; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-r * 0.6, 0); g.lineTo(r * 0.6, 0); g.moveTo(0, -r * 0.18); g.lineTo(0, r * 0.05); g.stroke();
  g.fillStyle = WHITE; g.beginPath(); g.arc(0, 0, r * 0.1, 0, TAU); g.fill();
  g.restore(); g.lineCap = 'butt';
  // inclinometer
  g.fillStyle = '#1c2024'; g.strokeStyle = '#555';
  g.beginPath(); g.ellipse(x, y + r * 0.55, r * 0.5, r * 0.11, 0, 0, TAU); g.fill(); g.stroke();
  g.fillStyle = '#e6e6e6'; g.beginPath(); g.arc(x + clamp(slip, -1, 1) * r * 0.38, y + r * 0.55, r * 0.09, 0, TAU); g.fill();
  g.strokeStyle = '#aaa'; g.lineWidth = 1.5; g.beginPath();
  g.moveTo(x - r * 0.11, y + r * 0.44); g.lineTo(x - r * 0.11, y + r * 0.66); g.moveTo(x + r * 0.11, y + r * 0.44); g.lineTo(x + r * 0.11, y + r * 0.66); g.stroke();
  font(g, r * 0.11, false); g.fillStyle = DIMW; g.fillText('2 MIN', x, y - r * 0.45);
  glass(g, x, y, r);
}

/** Annunciator lamp. */
export function lamp(g, x, y, w, h, text, on, col = AMBER) {
  g.fillStyle = on ? col : '#1a1b1d'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#3a3d42'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  font(g, h * 0.5); g.fillStyle = on ? '#140c00' : '#4a4d52'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, x + w / 2, y + h / 2 + 1);
}

/** Small digital window with a caption. */
export function readout(g, x, y, w, h, caption, text, col = AMBER) {
  g.fillStyle = '#050607'; g.fillRect(x, y, w, h);
  g.strokeStyle = '#33373c'; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  font(g, h * 0.24, false); g.fillStyle = DIMW; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(caption, x + w / 2, y + h * 0.2);
  font(g, h * 0.46); g.fillStyle = col; g.fillText(text, x + w / 2, y + h * 0.62);
}

/** Airliner engine gauge: N1 % arc with digital value (EICAS style). */
export function n1(g, x, y, r, pct, label) {
  g.strokeStyle = '#555'; g.lineWidth = r * 0.06;
  g.beginPath(); g.arc(x, y, r, Math.PI * 0.75, Math.PI * 2.25); g.stroke();
  g.strokeStyle = RED; g.beginPath(); g.arc(x, y, r, Math.PI * 2.15, Math.PI * 2.25); g.stroke();
  const a = Math.PI * 0.75 + clamp(pct / 110, 0, 1) * Math.PI * 1.5;
  g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.moveTo(x, y); g.arc(x, y, r * 0.95, Math.PI * 0.75, a); g.fill();
  g.strokeStyle = WHITE; g.lineWidth = r * 0.06; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); g.stroke();
  g.fillStyle = '#000'; g.fillRect(x + r * 0.05, y + r * 0.1, r * 0.95, r * 0.42);
  font(g, r * 0.36); g.fillStyle = GREEN; g.textAlign = 'right'; g.textBaseline = 'middle';
  g.fillText(pct.toFixed(1), x + r * 0.95, y + r * 0.32);
  font(g, r * 0.22, false); g.fillStyle = CYAN; g.textAlign = 'center'; g.fillText(label, x, y - r * 0.4);
}

/** Airliner primary flight display: attitude, speed tape, altitude tape, heading, VS. */
export function pfd(g, x, y, w, h, o, fd) {
  g.fillStyle = '#000'; g.fillRect(x, y, w, h);
  const cx = x + w * 0.46, cy = y + h * 0.46, ar = Math.min(w, h) * 0.3;
  g.save(); g.beginPath(); g.rect(cx - ar, cy - ar, ar * 2, ar * 2); g.clip();
  g.translate(cx, cy); g.rotate(-o.bank);
  const k = ar * 3, py = o.pitch * k;
  g.fillStyle = '#2e74c8'; g.fillRect(-ar * 3, -ar * 6 + py, ar * 6, ar * 6);
  g.fillStyle = '#7a4a22'; g.fillRect(-ar * 3, py, ar * 6, ar * 6);
  g.strokeStyle = WHITE; g.lineWidth = 2; g.beginPath(); g.moveTo(-ar * 3, py); g.lineTo(ar * 3, py);
  for (let d = -30; d <= 30; d += 2.5) { if (!d) continue; const yy = py - d * D2R * k, ww = d % 10 ? (d % 5 ? ar * 0.08 : ar * 0.16) : ar * 0.3; g.moveTo(-ww, yy); g.lineTo(ww, yy); }
  g.stroke();
  g.restore();
  g.strokeStyle = '#ffd200'; g.lineWidth = 4;
  g.beginPath(); g.moveTo(cx - ar * 0.7, cy); g.lineTo(cx - ar * 0.25, cy); g.lineTo(cx - ar * 0.25, cy + ar * 0.1);
  g.moveTo(cx + ar * 0.7, cy); g.lineTo(cx + ar * 0.25, cy); g.lineTo(cx + ar * 0.25, cy + ar * 0.1); g.stroke();
  g.fillStyle = '#ffd200'; g.fillRect(cx - 3, cy - 3, 6, 6);
  if (fd) { // ILS deviation diamonds
    g.fillStyle = MAG;
    const dx = clamp(fd.loc / (2.5 * D2R), -1, 1) * ar * 0.8, dy = clamp(-fd.gs / (0.7 * D2R), -1, 1) * ar * 0.8;
    g.beginPath(); g.moveTo(cx + dx, cy + ar + 8); g.lineTo(cx + dx - 6, cy + ar + 14); g.lineTo(cx + dx, cy + ar + 20); g.lineTo(cx + dx + 6, cy + ar + 14); g.fill();
    g.beginPath(); g.moveTo(cx + ar + 8, cy + dy); g.lineTo(cx + ar + 14, cy + dy - 6); g.lineTo(cx + ar + 20, cy + dy); g.lineTo(cx + ar + 14, cy + dy + 6); g.fill();
  }
  // tapes
  const tape = (tx, tw, val, step, px, fmt, left) => {
    g.fillStyle = '#3a3f46'; g.fillRect(tx, cy - ar, tw, ar * 2);
    g.save(); g.beginPath(); g.rect(tx, cy - ar, tw, ar * 2); g.clip();
    font(g, h * 0.05); g.fillStyle = WHITE; g.strokeStyle = WHITE; g.lineWidth = 1.5; g.textBaseline = 'middle';
    const base = Math.floor(val / step) * step;
    for (let v = base - step * 6; v <= base + step * 6; v += step) {
      const yy = cy - (v - val) * px;
      g.beginPath(); g.moveTo(left ? tx + tw : tx, yy); g.lineTo(left ? tx + tw - 8 : tx + 8, yy); g.stroke();
      if (v >= 0 && (v / step) % 2 === 0) { g.textAlign = left ? 'right' : 'left'; g.fillText(fmt(v), left ? tx + tw - 12 : tx + 12, yy); }
    }
    g.restore();
    g.fillStyle = '#000'; g.fillRect(tx - 2, cy - h * 0.04, tw + 4, h * 0.08);
    g.strokeStyle = '#ffd200'; g.strokeRect(tx - 2, cy - h * 0.04, tw + 4, h * 0.08);
    font(g, h * 0.058); g.fillStyle = GREEN; g.textAlign = 'center'; g.fillText(fmt(Math.round(val)), tx + tw / 2, cy + 1);
  };
  tape(x + w * 0.03, w * 0.13, o.ias * 1.943844, 10, ar / 45, (v) => String(Math.round(v)), true);
  tape(x + w * 0.8, w * 0.16, o.alt * 3.28084, 100, ar / 450, (v) => String(Math.round(v)), false);
  // heading strip
  const hdg = (o.heading / D2R + 360) % 360;
  g.fillStyle = '#3a3f46'; g.fillRect(cx - ar, y + h * 0.86, ar * 2, h * 0.11);
  g.save(); g.beginPath(); g.rect(cx - ar, y + h * 0.86, ar * 2, h * 0.11); g.clip();
  font(g, h * 0.05); g.fillStyle = WHITE; g.strokeStyle = WHITE; g.textAlign = 'center';
  for (let d = Math.floor(hdg / 5) * 5 - 30; d <= hdg + 30; d += 5) {
    const xx = cx + (d - hdg) * ar / 25;
    g.beginPath(); g.moveTo(xx, y + h * 0.86); g.lineTo(xx, y + h * 0.86 + (d % 10 ? 5 : 9)); g.stroke();
    if (!(d % 10)) g.fillText(String(((d % 360) + 360) % 360 / 10 | 0), xx, y + h * 0.93);
  }
  g.restore();
  g.fillStyle = '#ffd200'; g.fillRect(cx - 1, y + h * 0.85, 2, h * 0.05);
  // VS
  font(g, h * 0.05); g.fillStyle = GREEN; g.textAlign = 'left';
  g.fillText((o.vs >= 0 ? '+' : '') + Math.round(o.vs * 196.85 / 100) * 100, x + w * 0.8, y + h * 0.82);
  font(g, h * 0.045); g.fillStyle = CYAN; g.fillText('M ' + o.mach.toFixed(2), x + w * 0.03, y + h * 0.82);
}

/** Airliner navigation display: arc compass rose with the bearing to the nav target. */
export function nd(g, x, y, w, h, hdg, nav) {
  g.fillStyle = '#000'; g.fillRect(x, y, w, h);
  const cx = x + w / 2, cy = y + h * 0.82, R = h * 0.7;
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  g.translate(cx, cy); g.rotate(-hdg);
  g.strokeStyle = WHITE; g.lineWidth = 1.5; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.stroke();
  font(g, h * 0.06); g.fillStyle = WHITE; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let d = 0; d < 360; d += 5) {
    const a = d * D2R;
    g.save(); g.rotate(a);
    g.beginPath(); g.moveTo(0, -R); g.lineTo(0, -R + (d % 10 ? 6 : 12)); g.stroke();
    if (!(d % 30)) g.fillText(String(d / 10), 0, -R + 24);
    g.restore();
  }
  g.strokeStyle = 'rgba(242,242,236,0.35)'; g.beginPath(); g.arc(0, 0, R * 0.5, 0, TAU); g.stroke();
  if (nav) {
    const a = nav.bearing, rr = clamp(nav.dist / 40000, 0.05, 1) * R;
    g.strokeStyle = MAG; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.sin(a) * rr, -Math.cos(a) * rr); g.stroke();
    g.fillStyle = MAG; g.beginPath(); g.arc(Math.sin(a) * rr, -Math.cos(a) * rr, 5, 0, TAU); g.fill();
  }
  g.restore();
  g.strokeStyle = '#ffd200'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(cx, cy - 14); g.lineTo(cx, cy + 10); g.moveTo(cx - 12, cy - 2); g.lineTo(cx + 12, cy - 2); g.stroke();
  font(g, h * 0.06); g.fillStyle = GREEN; g.textAlign = 'left';
  g.fillText('HDG ' + String(Math.round((hdg / D2R + 360) % 360)).padStart(3, '0'), x + 8, y + h * 0.07);
  if (nav) { g.fillStyle = MAG; g.textAlign = 'right'; g.fillText(nav.name + '  ' + (nav.dist / 1852).toFixed(1) + ' NM', x + w - 8, y + h * 0.07); }
}

export const COLORS = { WHITE, DIMW, AMBER, RED, GREEN, CYAN };
