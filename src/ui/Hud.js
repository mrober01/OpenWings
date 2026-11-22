// Hud.js — full-screen 2D-canvas fighter HUD (classic 90s style) + radar / moving map.
// Contract: docs/INTERFACES.md, section "HUD".   new Hud(canvas) · resize() · draw(s) · clear()
//
// Everything world-related (pitch ladder, horizon, flight-path marker, target box, lead
// pipper, waypoint) is projected with s.camera, so it overlays the rendered world in any
// view. All sizes are css px; `u` scales fonts/boxes, `g` scales pure geometry.
// draw() allocates nothing per frame: numbers → strings go through small caches (Slot).
import * as THREE from 'three';

const KT = 1.943844, FT = 3.28084, DEG = 180 / Math.PI, RAD = Math.PI / 180, TAU = Math.PI * 2;

const GREEN = '#3dff72';
const GREEN_DIM = 'rgba(61,255,114,0.6)';
const OUTLINE = 'rgba(0,16,6,0.8)';
const BACK = 'rgba(0,12,5,0.5)';
const AMBER = '#ffc531';
const RED = '#ff4d3d';
const HOSTILE = '#ff6a50';
const WHITE = '#eaf6ee';
const FONT_FAMILY = 'ui-monospace, "DejaVu Sans Mono", Menlo, Consolas, "Roboto Mono", "Droid Sans Mono", monospace';

const MAX_MARK = 96;
const _mx = new Float32Array(MAX_MARK), _my = new Float32Array(MAX_MARK), _mf = new Uint8Array(MAX_MARK);
const _v = new THREE.Vector3();

const EMPTY = Object.freeze({});
const ZERO_INSETS = Object.freeze({ l: 0, r: 0, t: 0, b: 0 });

// warnings in priority order
const W_KEY = ['missile', 'pullUp', 'stall', 'overG', 'gear', 'fuel', 'damage'];
const W_TXT = ['MISSILE', 'PULL UP', 'STALL', 'OVER-G', 'GEAR', 'FUEL', 'DAMAGE'];
const W_RED = [true, true, true, false, false, false, false];
const _wActive = new Uint8Array(W_KEY.length);

const HDG_LBL = [];
for (let i = 0; i < 36; i++) HDG_LBL.push(i === 0 ? 'N' : i === 9 ? 'E' : i === 18 ? 'S' : i === 27 ? 'W' : (i < 10 ? '0' : '') + i);
const LAD_LBL = [];
for (let i = 0; i <= 18; i++) LAD_LBL.push(String(i * 5));
const SPD_LBL = [], ALT_LBL = [];

const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

function num(v, d) { return (typeof v === 'number' && v === v && v !== Infinity && v !== -Infinity) ? v : d; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrapPi(a) { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; }

/** number → string cache: the string is rebuilt only when the displayed integer changes */
class Slot {
  constructor(pre = '', suf = '') { this.k = NaN; this.s = ''; this.pre = pre; this.suf = suf; }
}
function sInt(slot, v) {
  const k = Math.round(v);
  if (slot.k !== k) { slot.k = k; slot.s = slot.pre + k + slot.suf; }
  return slot.s;
}
function sSigned(slot, v) {
  const k = Math.round(v);
  if (slot.k !== k) { slot.k = k; slot.s = slot.pre + (k >= 0 ? '+' : '') + k + slot.suf; }
  return slot.s;
}
function sFix1(slot, v) {
  const k = Math.round(v * 10);
  if (slot.k !== k) { slot.k = k; slot.s = slot.pre + (k / 10).toFixed(1) + slot.suf; }
  return slot.s;
}
function sFix2(slot, v) {
  const k = Math.round(v * 100);
  if (slot.k !== k) { slot.k = k; slot.s = slot.pre + (k / 100).toFixed(2) + slot.suf; }
  return slot.s;
}
function sHdg(slot, deg) {
  let k = Math.round(deg) % 360; if (k < 0) k += 360;
  if (slot.k !== k) { slot.k = k; slot.s = slot.pre + (k < 10 ? '00' : k < 100 ? '0' : '') + k + slot.suf; }
  return slot.s;
}
/** metres → "850M" / "3.2KM" / "24KM" */
function sRange(slot, m) {
  let k;
  if (m < 1000) k = Math.round(m / 10);
  else if (m < 20000) k = 100000 + Math.round(m / 100);
  else k = 1000000 + Math.round(m / 1000);
  if (slot.k !== k) {
    slot.k = k;
    slot.s = slot.pre + (k < 100000 ? (k * 10) + 'M' : k < 1000000 ? ((k - 100000) / 10).toFixed(1) + 'KM' : (k - 1000000) + 'KM') + slot.suf;
  }
  return slot.s;
}
function spdLabel(kt) { const i = kt / 50; return SPD_LBL[i] || (SPD_LBL[i] = String(kt)); }
function altLabel(ft) { const i = ft / 500; return ALT_LBL[i] || (ALT_LBL[i] = String(ft)); }

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    /** optional safe-area insets in css px (CSS env() cannot be read from a canvas) */
    this.insets = { l: 0, r: 0, t: 0, b: 0 };
    this.w = 0; this.h = 0; this.dpr = 1;
    this.u = 1; this.g = 1;
    this.fS = ''; this.fM = ''; this.fL = ''; this._font = '';
    this.cw = 6.6;
    this._wWidthS = new Float32Array(W_KEY.length);
    this._vig = new Array(33).fill(null);
    this._saved = 0;
    this._errLogged = false;

    // projection scratch
    this._me = null; this._pe = null;
    this.sx = 0; this.sy = 0; this.vx = 0; this.vy = 0; this.vz = 0;

    // layout scratch
    this.L = 0; this.R = 0; this.T = 0; this.B = 0; this.cx = 0; this.cy = 0;
    this.tapeOff = 0; this.th = 0;
    this.stickX = 0; this.stickY = 0; this.btnX = 0; this.btnY = 0; this.touch = false;

    // string caches
    this.kSpd = new Slot(); this.kAlt = new Slot(); this.kHdg = new Slot();
    this.kMach = new Slot('M '); this.kG = new Slot('G '); this.kAoa = new Slot('α ');
    this.kVs = new Slot('VS '); this.kRalt = new Slot('R ');
    this.kGun = new Slot(); this.kMsl = new Slot(); this.kFlr = new Slot();
    this.kThr = new Slot(); this.kFuel = new Slot(); this.kHp = new Slot();
    this.kTgtRng = new Slot(); this.kTgtClo = new Slot('', 'KT');
    this.kWpt = new Slot(); this.kNavBrg = new Slot('BRG '); this.kNavDst = new Slot();
    this.kIls = new Slot('RWY '); this.kRwy = new Slot('ILS RWY ');
    this.kRadar = new Slot(); this.kRadarHalf = new Slot();
    this.kStripSpd = new Slot('', ' KT'); this.kStripAlt = new Slot('', ' FT'); this.kStripHdg = new Slot('HDG ');
    // mission strip cache
    this._mScore = NaN; this._mKills = NaN; this._mHost = NaN; this._mWave = NaN; this._mTime = NaN; this._mStr = '';
    this._objSrc = null; this._objStr = ''; this._objW = 0;

    this.resize();
  }

  /* ------------------------------------------------------------------ sizing */

  resize() {
    const c = this.canvas;
    const w = Math.max(1, c.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0) || 1);
    const h = Math.max(1, c.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 0) || 1);
    let dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
    // fill-rate cap: never more than ~4 Mpx of backing store
    dpr = Math.min(dpr, Math.sqrt(4.0e6 / (w * h)));
    const bw = Math.max(1, Math.round(w * dpr)), bh = Math.max(1, Math.round(h * dpr));
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    this.w = w; this.h = h; this.dpr = dpr;
    const M = Math.min(w, h);
    this.u = clamp(M / 412, 1, 1.5);
    this.g = clamp(M / 412, 0.8, 2.6);
    const u = this.u;
    this.fS = 'bold ' + Math.round(11 * u) + 'px ' + FONT_FAMILY;
    this.fM = 'bold ' + Math.round(13 * u) + 'px ' + FONT_FAMILY;
    this.fL = 'bold ' + Math.round(15 * u) + 'px ' + FONT_FAMILY;
    const ctx = this.ctx;
    ctx.font = this.fS; this._font = this.fS;
    this.cw = ctx.measureText('0').width || 6.6 * u;
    for (let i = 0; i < W_TXT.length; i++) this._wWidthS[i] = ctx.measureText(W_TXT[i]).width;
    for (let i = 0; i < this._vig.length; i++) this._vig[i] = null;
    this._objSrc = null;
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  _layout(touch) {
    const W = this.w, H = this.h, u = this.u;
    const ins = this.insets || ZERO_INSETS;
    const il = num(ins.l, 0), ir = num(ins.r, 0), it = num(ins.t, 0), ib = num(ins.b, 0);
    this.L = il + 6; this.R = W - ir - 6; this.T = it + 6; this.B = H - ib - 6;
    this.cx = W / 2; this.cy = H / 2;
    const M = Math.min(W, H);
    this.touch = !!touch;
    // touch control rectangles (contract): bottom-left 200×200 stick, bottom-right 260×210 buttons
    this.stickX = il + 200; this.stickY = H - ib - 200;
    this.btnX = W - ir - 260; this.btnY = H - ib - 210;
    let off = 0.44 * M;
    if (touch) off = Math.min(off, W / 2 - 260 - ir - 64 * u);
    off = Math.min(off, W / 2 - 66 * u - Math.max(il, ir));
    this.tapeOff = Math.max(off, 92 * u);
    this.th = 0.2 * M;
  }

  /* ------------------------------------------------------------------ low-level drawing helpers */

  _f(font) { if (this._font !== font) { this.ctx.font = font; this._font = font; } }

  /** stroke the current path: dark halo, then colour */
  _st(col, lw) {
    const ctx = this.ctx;
    ctx.lineWidth = lw + 2; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
  }

  _text(str, x, y, col) {
    const ctx = this.ctx;
    ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE;
    ctx.strokeText(str, x, y);
    ctx.fillStyle = col;
    ctx.fillText(str, x, y);
  }

  _bar(x, y, w, h, frac, col) {
    const ctx = this.ctx;
    ctx.fillStyle = BACK; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = col; ctx.fillRect(x, y, w * clamp(frac, 0, 1), h);
    ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /* ------------------------------------------------------------------ projection */

  _setCamera(cam) {
    if (cam && cam.matrixWorldInverse && cam.projectionMatrix) {
      this._me = cam.matrixWorldInverse.elements; this._pe = cam.projectionMatrix.elements;
      return true;
    }
    this._me = null; this._pe = null;
    return false;
  }

  /** world direction → screen (point at infinity). Returns true when in front of the camera. */
  _projDir(x, y, z) {
    const m = this._me;
    return this._projView(m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z);
  }

  /** world point → screen. Returns true when in front of the camera. */
  _projPt(x, y, z) {
    const m = this._me;
    return this._projView(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
  }

  _projView(vx, vy, vz) {
    this.vx = vx; this.vy = vy; this.vz = vz;
    const p = this._pe;
    const wq = -vz;
    if (!(wq > 1e-6)) return false;
    const nx = (p[0] * vx + p[8] * vz) / wq, ny = (p[5] * vy + p[9] * vz) / wq;
    this.sx = (nx * 0.5 + 0.5) * this.w;
    this.sy = (0.5 - ny * 0.5) * this.h;
    return this.sx === this.sx && this.sy === this.sy;
  }

  _onScreen(m) { return this.sx > m && this.sx < this.w - m && this.sy > m && this.sy < this.h - m; }

  /* ------------------------------------------------------------------ main */

  draw(s) {
    if (!s) return;
    try {
      this._draw(s);
    } catch (e) {
      const ctx = this.ctx;
      while (this._saved > 0) { ctx.restore(); this._saved--; }
      ctx.globalAlpha = 1;
      if (!this._errLogged) { this._errLogged = true; console.error('Hud.draw failed:', e); }
    }
  }

  _draw(s) {
    const ctx = this.ctx, dpr = this.dpr, W = this.w, H = this.h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    this._font = ''; this._f(this.fS);
    this._layout(s.touch);

    const own = s.own || EMPTY;
    const time = num(s.time, 0);
    const hdg = num(own.heading, 0);
    const view = s.view;
    const full = view === 'cockpit' || view === 'chase' || view == null;
    const hasCam = this._setCamera(s.camera);

    const bo = num(s.blackout, 0);
    if (bo > 0.02 || bo < -0.02) this._vignette(bo);

    const nav = s.nav || null, wpt = s.waypoint || null;
    let bug = NaN;
    if (nav && num(nav.bearing, NaN) === nav.bearing) bug = nav.bearing;
    else if (wpt && wpt.pos && own.pos) bug = Math.atan2(wpt.pos.x - own.pos.x, -(wpt.pos.z - own.pos.z));

    if (full) {
      if (hasCam) {
        this._ladder(own, hdg);
        this._markers(s, own);
        if (wpt && wpt.pos) this._waypoint(wpt, own);
        this._boresightAndFpm(own, hdg, nav);
        if (s.target) this._target(s, s.target, time);
      }
      this._bankScale(num(own.bank, 0));
      this._tapes(own, s.warn || EMPTY);
      this._headingTape(hdg * DEG, bug);
      this._status(own, s.weapons || EMPTY, s.warn || EMPTY, time);
      this._mission(s.mission || EMPTY);
    } else {
      this._strip(own, hdg);
    }
    this._radar(s, own, hdg, time, nav, wpt);
    this._navBlock(nav);
    this._apLine(s, time);
    this._warnings(s.warn || EMPTY, time, full);
  }

  /* ------------------------------------------------------------------ pitch ladder + horizon */

  _ladder(own, hdg) {
    const ctx = this.ctx, g = this.g, u = this.u, cx = this.cx, cy = this.cy;
    const sh = Math.sin(hdg), ch = Math.cos(hdg);
    const rx = ch, rz = sh;                         // horizontal "right of heading"
    const boxW = this.tapeOff - 12 * u, boxH = 0.31 * Math.min(this.w, this.h);
    const gap = 24 * g, len = Math.min(60 * g, boxW - 26 * u), hlen = Math.min(118 * g, boxW);
    const tick = 6 * g;
    this._f(this.fS);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.beginPath();
    for (let i = -17; i <= 17; i++) {
      const e = i * 5 * RAD, ce = Math.cos(e), se = Math.sin(e);
      const dx = sh * ce, dy = se, dz = -ch * ce;
      if (!this._projDir(dx, dy, dz)) continue;
      const px = this.sx, py = this.sy;
      if (Math.abs(px - cx) > boxW || Math.abs(py - cy) > boxH) continue;
      if (!this._projDir(dx + rx * 0.04, dy, dz + rz * 0.04)) continue;
      let ux = this.sx - px, uy = this.sy - py;
      const ul = Math.hypot(ux, uy);
      if (!(ul > 1e-6)) continue;
      ux /= ul; uy /= ul;
      const nx = uy, ny = -ux;                      // towards the zenith on screen
      if (i === 0) {
        ctx.moveTo(px - ux * hlen, py - uy * hlen); ctx.lineTo(px - ux * gap, py - uy * gap);
        ctx.moveTo(px + ux * gap, py + uy * gap); ctx.lineTo(px + ux * hlen, py + uy * hlen);
        continue;
      }
      const sgn = i > 0 ? -1 : 1;                   // end ticks point at the horizon
      for (let side = -1; side <= 1; side += 2) {
        const ax = ux * side, ay = uy * side;
        if (i > 0) {
          ctx.moveTo(px + ax * gap, py + ay * gap); ctx.lineTo(px + ax * len, py + ay * len);
        } else {
          const seg = (len - gap) / 5;              // dash, gap, dash, gap, dash
          for (let k = 0; k < 3; k++) {
            const a0 = gap + seg * 2 * k, a1 = a0 + seg;
            ctx.moveTo(px + ax * a0, py + ay * a0); ctx.lineTo(px + ax * a1, py + ay * a1);
          }
        }
        ctx.lineTo(px + ax * len + nx * tick * sgn, py + ay * len + ny * tick * sgn);
      }
      // labels, rotated with the bar
      const lbl = LAD_LBL[i < 0 ? -i : i], lo = len + 11 * u, d = this.dpr;
      ctx.setTransform(d * ux, d * uy, -d * uy, d * ux, d * (px - ux * lo), d * (py - uy * lo));
      this._text(lbl, 0, 0, GREEN);
      ctx.setTransform(d * ux, d * uy, -d * uy, d * ux, d * (px + ux * lo), d * (py + uy * lo));
      this._text(lbl, 0, 0, GREEN);
      ctx.setTransform(d, 0, 0, d, 0, 0);
    }
    this._st(GREEN, 1.5);
  }

  /* ------------------------------------------------------------------ boresight cross, flight-path marker, ILS */

  _boresightAndFpm(own, hdg, nav) {
    const ctx = this.ctx, g = this.g, u = this.u;
    // nose direction
    let fx, fy, fz;
    const q = own.quat;
    if (q && num(q.w, NaN) === q.w) {
      fx = -2 * (q.x * q.z + q.w * q.y); fy = -2 * (q.y * q.z - q.w * q.x); fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    } else {
      const p = num(own.pitch, 0), cp = Math.cos(p);
      fx = Math.sin(hdg) * cp; fy = Math.sin(p); fz = -Math.cos(hdg) * cp;
    }
    let bx = this.cx, by = this.cy;
    ctx.beginPath();
    if (this._projDir(fx, fy, fz) && this._onScreen(0)) {
      bx = this.sx; by = this.sy;
      const a = 4 * g, b = 11 * g;
      ctx.moveTo(bx - b, by); ctx.lineTo(bx - a, by);
      ctx.moveTo(bx + a, by); ctx.lineTo(bx + b, by);
      ctx.moveTo(bx, by - b); ctx.lineTo(bx, by - a);
      ctx.moveTo(bx, by + a); ctx.lineTo(bx, by + b);
    }
    // flight-path marker
    const v = own.vel;
    if (v && !own.onGround) {
      const sp2 = v.x * v.x + v.y * v.y + v.z * v.z;
      if (sp2 > 15 * 15 && this._projDir(v.x, v.y, v.z) && this._onScreen(8)) {
        const x = this.sx, y = this.sy, r = 6 * g;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
        ctx.moveTo(x - r, y); ctx.lineTo(x - r * 2.6, y);
        ctx.moveTo(x + r, y); ctx.lineTo(x + r * 2.6, y);
        ctx.moveTo(x, y - r); ctx.lineTo(x, y - r * 1.9);
      }
    }
    this._st(GREEN, 1.5);

    // ILS cross-pointer around the boresight
    const ils = nav && nav.ils;
    if (ils) {
      const loc = num(ils.loc, 0), gs = num(ils.gs, 0);
      const full = 44 * g, half = 30 * g;
      const lx = bx - clamp(loc / (2.5 * RAD), -1, 1) * full;   // right of centreline → bar to the left
      const gy = by + clamp(gs / (0.7 * RAD), -1, 1) * full;    // above the glideslope → bar below
      ctx.fillStyle = OUTLINE;
      for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        ctx.fillRect(bx + k * full / 2 - 2.5, by + full + 8 * g - 2.5, 5, 5);
        ctx.fillRect(bx + full + 8 * g - 2.5, by + k * full / 2 - 2.5, 5, 5);
      }
      ctx.fillStyle = GREEN;
      for (let k = -2; k <= 2; k++) {
        if (k === 0) continue;
        ctx.fillRect(bx + k * full / 2 - 1.5, by + full + 8 * g - 1.5, 3, 3);
        ctx.fillRect(bx + full + 8 * g - 1.5, by + k * full / 2 - 1.5, 3, 3);
      }
      ctx.beginPath();
      ctx.moveTo(lx, by - half); ctx.lineTo(lx, by + half);
      ctx.moveTo(bx - half, gy); ctx.lineTo(bx + half, gy);
      this._st(GREEN, 2.5);
      const d = num(nav.dist, NaN);
      if (d === d) {
        this._f(this.fS);
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        this._text(sRange(this.kIls, d), bx, by + full + 22 * g + 4 * u, GREEN);
      }
    }
  }

  /* ------------------------------------------------------------------ bank scale */

  _bankScale(bank) {
    const ctx = this.ctx, g = this.g, cx = this.cx, cy = this.cy;
    const R = 0.36 * Math.min(this.w, this.h);
    ctx.beginPath();
    for (let i = 0; i < BANK_TICKS.length; i++) {
      const d = BANK_TICKS[i], a = d * RAD;
      const s = Math.sin(a), c = Math.cos(a);
      const l = (d === 0 ? 10 : d % 30 === 0 ? 8 : 5) * g;
      ctx.moveTo(cx + s * R, cy + c * R); ctx.lineTo(cx + s * (R + l), cy + c * (R + l));
    }
    // pointer: rides inside the scale, points at the ground
    const s = Math.sin(bank), c = Math.cos(bank);
    const tx = cx + s * (R - 2), ty = cy + c * (R - 2);
    const bx = cx + s * (R - 2 - 9 * g), by = cy + c * (R - 2 - 9 * g);
    const hw = 5 * g;
    ctx.moveTo(tx, ty);
    ctx.lineTo(bx + c * hw, by - s * hw);
    ctx.lineTo(bx - c * hw, by + s * hw);
    ctx.closePath();
    this._st(GREEN, 1.5);
  }

  /* ------------------------------------------------------------------ speed / altitude tapes + readouts */

  _tapes(own, warn) {
    const ctx = this.ctx, u = this.u, cy = this.cy, th = this.th;
    const kt = Math.max(0, num(own.ias, 0) * KT);
    const altFt = num(own.alt, 0) * FT;
    const xs = this.cx - this.tapeOff, xa = this.cx + this.tapeOff;
    const ppk = th / 60, ppf = th / 600;
    const bh = 20 * u, bwS = 44 * u, bwA = 56 * u;

    // scales
    ctx.beginPath();
    ctx.moveTo(xs, cy - th); ctx.lineTo(xs, cy + th);
    let v0 = Math.max(0, Math.ceil((kt - 60) / 10) * 10);
    for (let v = v0; v <= kt + 60; v += 10) {
      const y = cy - (v - kt) * ppk;
      ctx.moveTo(xs, y); ctx.lineTo(xs - (v % 50 === 0 ? 8 : 4) * u, y);
    }
    ctx.moveTo(xa, cy - th); ctx.lineTo(xa, cy + th);
    const a0 = Math.ceil((altFt - 600) / 100) * 100;
    for (let a = a0; a <= altFt + 600; a += 100) {
      const y = cy - (a - altFt) * ppf;
      ctx.moveTo(xa, y); ctx.lineTo(xa + (a % 500 === 0 ? 8 : 4) * u, y);
    }
    this._st(GREEN, 1.5);

    // vertical speed: bar on the inner side of the altitude tape (±6000 ft/min full scale)
    const vsFpm = num(own.vs, 0) * FT * 60;
    const vf = clamp(vsFpm / 6000, -1, 1);
    if (Math.abs(vf) > 0.01) {
      const x = xa - 5 * u, y1 = cy - vf * th, d = vf > 0 ? 1 : -1;
      ctx.beginPath();
      ctx.moveTo(x, cy); ctx.lineTo(x, y1);
      ctx.moveTo(x - 3 * u, y1 + d * 4 * u); ctx.lineTo(x, y1); ctx.lineTo(x + 3 * u, y1 + d * 4 * u);
      this._st(GREEN, 2);
    }

    // scale labels
    this._f(this.fS);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    v0 = Math.max(0, Math.ceil((kt - 60) / 50) * 50);
    for (let v = v0; v <= kt + 60; v += 50) {
      const y = cy - (v - kt) * ppk;
      if (Math.abs(y - cy) > bh / 2 + 6 * u) this._text(spdLabel(v), xs - 11 * u, y, GREEN);
    }
    ctx.textAlign = 'left';
    const a5 = Math.ceil((altFt - 600) / 500) * 500;
    for (let a = a5; a <= altFt + 600; a += 500) {
      if (a < 0) continue;
      const y = cy - (a - altFt) * ppf;
      if (Math.abs(y - cy) > bh / 2 + 6 * u) this._text(altLabel(a), xa + 11 * u, y, GREEN);
    }

    // boxed digital readouts (with a notch pointing at the scale)
    ctx.beginPath();
    let x1 = xs - 6 * u, x0 = x1 - bwS;
    ctx.moveTo(xs - 1, cy); ctx.lineTo(x1, cy - 5 * u); ctx.lineTo(x1, cy - bh / 2); ctx.lineTo(x0, cy - bh / 2);
    ctx.lineTo(x0, cy + bh / 2); ctx.lineTo(x1, cy + bh / 2); ctx.lineTo(x1, cy + 5 * u); ctx.closePath();
    x0 = xa + 6 * u; x1 = x0 + bwA;
    ctx.moveTo(xa + 1, cy); ctx.lineTo(x0, cy - 5 * u); ctx.lineTo(x0, cy - bh / 2); ctx.lineTo(x1, cy - bh / 2);
    ctx.lineTo(x1, cy + bh / 2); ctx.lineTo(x0, cy + bh / 2); ctx.lineTo(x0, cy + 5 * u); ctx.closePath();
    ctx.fillStyle = BACK; ctx.fill();
    this._st(GREEN, 1.5);
    this._f(this.fL);
    ctx.textAlign = 'right';
    this._text(sInt(this.kSpd, kt), xs - 10 * u, cy + 0.5, GREEN);
    this._text(sInt(this.kAlt, Math.round(altFt / 10) * 10), xa + 6 * u + bwA - 4 * u, cy + 0.5, GREEN);

    // readouts below the tapes
    this._f(this.fS);
    const lh = 14 * u;
    let y = cy + th + 12 * u;
    ctx.textAlign = 'right';
    this._text(sFix2(this.kMach, num(own.mach, 0)), xs, y, GREEN); y += lh;
    this._text(sFix1(this.kG, num(own.g, 1)), xs, y, warn.overG ? AMBER : GREEN); y += lh;
    this._text(sFix1(this.kAoa, num(own.aoa, 0) * DEG), xs, y, (warn.stall || own.stalled) ? AMBER : GREEN);
    ctx.textAlign = 'left';
    y = cy + th + 12 * u;
    this._text(sSigned(this.kVs, Math.round(vsFpm / 50) * 50), xa, y, GREEN); y += lh;
    const aglFt = num(own.agl, NaN) * FT;
    if (aglFt === aglFt && aglFt < 2500) {
      this._text(sInt(this.kRalt, aglFt < 100 ? Math.max(0, aglFt) : Math.round(aglFt / 10) * 10), xa, y, GREEN);
    }
  }

  /* ------------------------------------------------------------------ heading tape */

  _headingTape(hdgDeg, bugRad) {
    const ctx = this.ctx, u = this.u, cx = this.cx;
    const hw = Math.min(130 * u, this.w * 0.17), ppd = hw / 30;
    const yb = this.T + 22 * u;
    ctx.beginPath();
    ctx.moveTo(cx - hw, yb); ctx.lineTo(cx + hw, yb);
    const d0 = Math.ceil((hdgDeg - 30) / 5) * 5;
    for (let d = d0; d <= hdgDeg + 30; d += 5) {
      const x = cx + (d - hdgDeg) * ppd;
      ctx.moveTo(x, yb); ctx.lineTo(x, yb - (d % 10 === 0 ? 6 : 3) * u);
    }
    // lubber caret
    ctx.moveTo(cx - 4 * u, yb + 7 * u); ctx.lineTo(cx, yb + 1.5); ctx.lineTo(cx + 4 * u, yb + 7 * u);
    // nav bearing bug
    if (bugRad === bugRad) {
      const dd = wrapPi(bugRad - hdgDeg * RAD) * DEG;
      const x = cx + clamp(dd, -30, 30) * ppd;
      if (dd > 30) { ctx.moveTo(x - 4 * u, yb - 9 * u); ctx.lineTo(x + 1 * u, yb - 5 * u); ctx.lineTo(x - 4 * u, yb - 1 * u); }
      else if (dd < -30) { ctx.moveTo(x + 4 * u, yb - 9 * u); ctx.lineTo(x - 1 * u, yb - 5 * u); ctx.lineTo(x + 4 * u, yb - 1 * u); }
      else {
        ctx.moveTo(x - 5 * u, yb + 1.5); ctx.lineTo(x - 5 * u, yb + 6 * u); ctx.lineTo(x + 5 * u, yb + 6 * u); ctx.lineTo(x + 5 * u, yb + 1.5);
        ctx.lineTo(x + 2.5 * u, yb + 1.5); ctx.lineTo(x, yb + 4 * u); ctx.lineTo(x - 2.5 * u, yb + 1.5); ctx.closePath();
      }
    }
    this._st(GREEN, 1.5);
    this._f(this.fS);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const d10 = Math.ceil((hdgDeg - 28) / 10) * 10;
    for (let d = d10; d <= hdgDeg + 28; d += 10) {
      let i = Math.round(d / 10) % 36; if (i < 0) i += 36;
      this._text(HDG_LBL[i], cx + (d - hdgDeg) * ppd, yb - 13 * u, GREEN);
    }
    // digital heading
    const bw = 38 * u, bh = 17 * u, by = yb + 8 * u;
    ctx.fillStyle = BACK; ctx.fillRect(cx - bw / 2, by, bw, bh);
    ctx.beginPath(); ctx.rect(cx - bw / 2, by, bw, bh);
    this._st(GREEN, 1.5);
    this._f(this.fM);
    this._text(sHdg(this.kHdg, hdgDeg), cx, by + bh / 2 + 0.5, GREEN);
  }

  /* ------------------------------------------------------------------ top-left: weapons, engine, airframe */

  _status(own, wp, warn, time) {
    const ctx = this.ctx, u = this.u, cw = this.cw, x = this.L, lh = 14 * u;
    let y = this.T + 6 * u;
    this._f(this.fS);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    // line 1: weapons
    const gun = num(wp.gun, 0), msl = num(wp.missiles, 0), flr = num(wp.flares, 0);
    this._text('GUN', x, y, GREEN);
    this._text(wp.hasGun === false ? '--' : sInt(this.kGun, gun), x + cw * 4, y, (wp.hasGun !== false && gun <= 0) ? AMBER : GREEN);
    this._text('MSL', x + cw * 9, y, GREEN);
    this._text(wp.hasMissiles === false ? '--' : sInt(this.kMsl, msl), x + cw * 13, y, (wp.hasMissiles !== false && msl <= 0) ? AMBER : GREEN);
    this._text('FLR', x + cw * 16, y, GREEN);
    this._text(sInt(this.kFlr, flr), x + cw * 20, y, flr <= 0 ? AMBER : GREEN);
    // lines 2-4: bars
    const bx = x + cw * 5, bw = 56 * u, bh = 7 * u, tx = bx + bw + 5 * u, sx = tx + cw * 4;
    y += lh;
    const thr = clamp(num(own.throttle, 0), 0, 1), eff = clamp(num(own.thrEff, thr), 0, 1);
    this._text('THR', x, y, GREEN);
    this._bar(bx, y - bh / 2, bw, bh, eff, GREEN);
    ctx.fillStyle = WHITE; ctx.fillRect(bx + bw * thr - 1, y - bh / 2 - 2, 2, bh + 4);     // commanded
    if (own.hasAB) { ctx.fillStyle = GREEN; ctx.fillRect(bx + bw * 0.92, y - bh / 2 - 3, 1, 3); }
    this._text(sInt(this.kThr, thr * 100), tx, y, GREEN);
    if (own.ab) this._text('AB', sx, y, GREEN);
    y += lh;
    const fuel = clamp(num(own.fuel, 0), 0, 100);
    const fuelCol = (warn.fuel || fuel < 15) ? AMBER : GREEN;
    this._text('FUEL', x, y, fuelCol);
    this._bar(bx, y - bh / 2, bw, bh, fuel / 100, fuelCol);
    this._text(sInt(this.kFuel, fuel), tx, y, fuelCol);
    const gp = num(own.gearPos, own.gearDown ? 1 : 0);
    if (gp > 0.98) this._text('GEAR DN', sx, y, GREEN);
    else if (gp > 0.02) { if ((time * 3) % 1 < 0.6) this._text('GEAR --', sx, y, AMBER); }
    else this._text('GEAR UP', sx, y, GREEN_DIM);
    y += lh;
    const hp = clamp(num(own.hp, 1), 0, 1);
    const hpCol = hp < 0.25 ? RED : hp < 0.5 ? AMBER : GREEN;
    this._text('HULL', x, y, hpCol);
    this._bar(bx, y - bh / 2, bw, bh, hp, hpCol);
    this._text(sInt(this.kHp, hp * 100), tx, y, hpCol);
    if (num(own.airbrake, 0) > 0.05) this._text('BRAKE', sx, y, GREEN);
    const hk = num(own.hook, 0);
    if (hk > 0.98) this._text('HOOK', sx + cw * 6, y, GREEN);
    else if (hk > 0.02 && (time * 3) % 1 < 0.6) this._text('HOOK', sx + cw * 6, y, AMBER);
  }

  _mission(m) {
    const ctx = this.ctx, u = this.u, x = this.L, lh = 14 * u;
    let y = this.T + 6 * u + lh * 4 + 2 * u;
    this._f(this.fS);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const obj = m.objective;
    if (typeof obj === 'string' && obj.length) {
      const maxW = Math.max(120, this.cx - Math.min(130 * u, this.w * 0.17) - 14 * u - x);
      if (obj !== this._objSrc || maxW !== this._objW) {
        this._objSrc = obj; this._objW = maxW;
        let t = obj, n = obj.length;
        while (n > 4 && ctx.measureText(t).width > maxW) { n--; t = obj.slice(0, n) + '…'; }
        this._objStr = t;
      }
      this._text(this._objStr, x, y, GREEN);
      y += lh;
    }
    const score = num(m.score, 0), kills = num(m.kills, 0), host = num(m.hostiles, 0), wave = num(m.wave, 0);
    const t = (m.timer == null) ? -1 : Math.max(0, Math.floor(num(m.timer, 0)));
    if (score !== this._mScore || kills !== this._mKills || host !== this._mHost || wave !== this._mWave || t !== this._mTime) {
      this._mScore = score; this._mKills = kills; this._mHost = host; this._mWave = wave; this._mTime = t;
      let str = 'SCORE ' + score + '  KILLS ' + kills + '  HOSTILE ' + host;
      if (wave > 0) str += '  WAVE ' + wave;
      if (t >= 0) { const mm = Math.floor(t / 60), ss = t % 60; str += '  ' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss; }
      this._mStr = str;
    }
    this._text(this._mStr, x, y, GREEN_DIM);
  }

  /* ------------------------------------------------------------------ other units */

  _markers(s, own) {
    const units = s.units;
    if (!units || !units.length || !own.pos) return;
    const ctx = this.ctx, g = this.g;
    const rr = num(s.radarRange, 20000), rr2 = rr * rr;
    const tu = s.target ? s.target.unit : null;
    const ox = own.pos.x, oy = own.pos.y, oz = own.pos.z;
    let n = 0;
    for (let i = 0; i < units.length && n < MAX_MARK; i++) {
      const un = units[i];
      if (!un || !un.alive || un.isPlayer || un === tu || !un.pos) continue;
      const dx = un.pos.x - ox, dy = un.pos.y - oy, dz = un.pos.z - oz;
      if (!(dx * dx + dy * dy + dz * dz <= rr2)) continue;
      if (!this._projPt(un.pos.x, un.pos.y, un.pos.z) || !this._onScreen(4)) continue;
      _mx[n] = this.sx; _my[n] = this.sy;
      _mf[n] = (un.team === 1 ? 1 : 0) | (un.kind === 'ground' ? 2 : 0);
      n++;
    }
    if (!n) return;
    const r = 5 * g;
    for (let pass = 0; pass < 2; pass++) {
      let any = false;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        if ((_mf[i] & 1) !== pass) continue;
        any = true;
        const x = _mx[i], y = _my[i];
        if (_mf[i] & 2) { ctx.moveTo(x - r, y + r * 0.7); ctx.lineTo(x, y - r * 0.8); ctx.lineTo(x + r, y + r * 0.7); }
        else ctx.rect(x - r, y - r, r * 2, r * 2);
      }
      if (!any) continue;
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.lineWidth = 1.25; ctx.strokeStyle = pass ? HOSTILE : GREEN; ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------ waypoint */

  _waypoint(wpt, own) {
    const p = wpt.pos;
    if (!this._projPt(p.x, p.y, p.z) || !this._onScreen(10)) return;
    const ctx = this.ctx, g = this.g, u = this.u, x = this.sx, y = this.sy, r = 7 * g;
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x - r, y - r * 1.6); ctx.lineTo(x + r, y - r * 1.6); ctx.closePath();
    this._st(GREEN, 1.5);
    this._f(this.fS);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let ty = y - r * 1.6 - 8 * u;
    if (own.pos) {
      const d = Math.hypot(p.x - own.pos.x, p.y - own.pos.y, p.z - own.pos.z);
      this._text(sRange(this.kWpt, d), x, ty, GREEN);
      ty -= 13 * u;
    }
    if (typeof wpt.label === 'string') this._text(wpt.label, x, ty, GREEN);
  }

  /* ------------------------------------------------------------------ target designator, lock, gun lead */

  _target(s, t, time) {
    const p = t.pos || (t.unit && t.unit.pos);
    if (!p) return;
    const ctx = this.ctx, g = this.g, u = this.u, W = this.w, H = this.h;
    const front = this._projPt(p.x, p.y, p.z);
    const on = front && this._onScreen(6);
    const tx = this.sx, ty = this.sy;
    const hostile = !t.unit || t.unit.team !== 0;
    const lock = clamp(num(t.lock, 0), 0, 1), locked = !!t.locked;
    const box = 13 * g;
    const range = num(t.range, NaN), clo = num(t.closure, NaN);
    const name = typeof t.name === 'string' ? t.name : '';

    if (on) {
      ctx.beginPath();
      ctx.rect(tx - box, ty - box, box * 2, box * 2);
      this._st(GREEN, 1.5);
      if (locked || lock > 0.02) {
        const d = locked ? box * 1.75 : box * (0.35 + 1.4 * lock);
        ctx.beginPath();
        ctx.moveTo(tx, ty - d); ctx.lineTo(tx + d, ty); ctx.lineTo(tx, ty + d); ctx.lineTo(tx - d, ty); ctx.closePath();
        this._st(locked ? RED : GREEN, locked ? 2 : 1.5);
      }
      // hp bar under the box
      const hp = num(t.hp, NaN);
      const ext = locked ? box * 1.75 : box;
      if (hp === hp) {
        ctx.fillStyle = OUTLINE; ctx.fillRect(tx - box - 1, ty + box + 3 * u - 1, box * 2 + 2, 3 * u + 2);
        ctx.fillStyle = hostile ? HOSTILE : GREEN; ctx.fillRect(tx - box, ty + box + 3 * u, box * 2 * clamp(hp, 0, 1), 3 * u);
      }
      this._f(this.fS);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (name) this._text(name, tx, ty - ext - 8 * u, hostile ? HOSTILE : GREEN);
      let y = ty + ext + 14 * u;
      if (range === range) {
        const cwid = this.cw;
        if (clo === clo) {
          ctx.textAlign = 'right'; this._text(sRange(this.kTgtRng, range), tx - cwid * 0.5, y, GREEN);
          ctx.textAlign = 'left'; this._text(sSigned(this.kTgtClo, clo * KT), tx + cwid * 0.5, y, GREEN);
          ctx.textAlign = 'center';
        } else this._text(sRange(this.kTgtRng, range), tx, y, GREEN);
        y += 15 * u;
      }
      if (locked && (time * 5) % 1 < 0.65) {
        this._f(this.fL);
        this._text('SHOOT', tx, y + 2 * u, RED);
      }
    } else {
      // off-screen: arrow on an ellipse near the screen edge
      const pe = this._pe;
      let dx = pe[0] * this.vx * W, dy = -pe[5] * this.vy * H;
      let l = Math.hypot(dx, dy);
      if (!(l > 1e-6)) { dx = 0; dy = 1; l = 1; }
      dx /= l; dy /= l;
      const ea = W / 2 - 34 * u, eb = H / 2 - 34 * u;
      const k = 1 / Math.sqrt((dx * dx) / (ea * ea) + (dy * dy) / (eb * eb));
      let ax = this.cx + dx * k, ay = this.cy + dy * k;
      if (this.touch) {
        if (ax < this.stickX + 16 * u && ay > this.stickY - 16 * u) ay = this.stickY - 16 * u;
        if (ax > this.btnX - 16 * u && ay > this.btnY - 16 * u) ay = this.btnY - 16 * u;
      }
      const a = 12 * g, b = 7 * g;
      ctx.beginPath();
      ctx.moveTo(ax + dx * a, ay + dy * a);
      ctx.lineTo(ax - dx * a * 0.6 - dy * b, ay - dy * a * 0.6 + dx * b);
      ctx.lineTo(ax - dx * a * 0.6 + dy * b, ay - dy * a * 0.6 - dx * b);
      ctx.closePath();
      ctx.fillStyle = hostile ? HOSTILE : GREEN; ctx.fill();
      this._st(hostile ? HOSTILE : GREEN, 1.5);
      this._f(this.fS);
      ctx.textBaseline = 'middle';
      // label on the inner side of the arrow
      const lx = ax - dx * 24 * u, ly = ay - dy * 26 * u;
      ctx.textAlign = dx > 0.5 ? 'right' : dx < -0.5 ? 'left' : 'center';
      if (name) this._text(name, lx, ly - 7 * u, hostile ? HOSTILE : GREEN);
      if (range === range) this._text(sRange(this.kTgtRng, range), lx, ly + 7 * u, GREEN);
      if (locked && (time * 5) % 1 < 0.65) this._text('SHOOT', lx, ly + 21 * u, RED);
    }

    // gun lead marker
    const aim = t.aim;
    if (aim && this._projPt(aim.x, aim.y, aim.z) && this._onScreen(4)) {
      const x = this.sx, y = this.sy, r = 10 * g;
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, TAU);
      if (on) {
        const dx = x - tx, dy = y - ty, d = Math.hypot(dx, dy);
        if (d > r + box * 1.42) {
          const ux = dx / d, uy = dy / d;
          // leave the box through its edge
          const e = box / Math.max(Math.abs(ux), Math.abs(uy));
          ctx.moveTo(tx + ux * e, ty + uy * e); ctx.lineTo(x - ux * r, y - uy * r);
        }
      }
      this._st(GREEN, 1.5);
      ctx.fillStyle = OUTLINE; ctx.fillRect(x - 2.5, y - 2.5, 5, 5);
      ctx.fillStyle = GREEN; ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }

  /* ------------------------------------------------------------------ compact strip (external views) */

  _strip(own, hdg) {
    const ctx = this.ctx, u = this.u, cx = this.cx;
    const cw = this.cw, w = cw * 34, h = 20 * u, y = this.T;
    ctx.fillStyle = BACK; ctx.fillRect(cx - w / 2, y, w, h);
    ctx.lineWidth = 1; ctx.strokeStyle = GREEN_DIM; ctx.strokeRect(cx - w / 2 + 0.5, y + 0.5, w - 1, h - 1);
    this._f(this.fS);
    ctx.textBaseline = 'middle';
    const ym = y + h / 2 + 0.5;
    ctx.textAlign = 'left';
    this._text(sInt(this.kStripSpd, Math.max(0, num(own.ias, 0) * KT)), cx - w / 2 + cw * 1.5, ym, GREEN);
    ctx.textAlign = 'center';
    this._text(sInt(this.kStripAlt, Math.round(num(own.alt, 0) * FT / 10) * 10), cx, ym, GREEN);
    ctx.textAlign = 'right';
    this._text(sHdg(this.kStripHdg, hdg * DEG), cx + w / 2 - cw * 1.5, ym, GREEN);
  }

  /* ------------------------------------------------------------------ radar / moving map */

  _radar(s, own, hdg, time, nav, wpt) {
    const ctx = this.ctx, u = this.u, dpr = this.dpr;
    const rs = Math.round(Math.min(Math.max(96, 0.25 * this.h), this.w * 0.3));
    const x0 = Math.round(this.R - rs), y0 = Math.round(this.T);
    const rad = rs / 2, cx = x0 + rad, cy = y0 + rad;
    const range = Math.max(100, num(s.radarRange, 20000));
    const k = rad / range;
    const ox = own.pos ? num(own.pos.x, 0) : 0, oz = own.pos ? num(own.pos.z, 0) : 0;
    const sh = Math.sin(hdg), ch = Math.cos(hdg);

    ctx.save(); this._saved++;
    ctx.beginPath(); ctx.rect(x0, y0, rs, rs); ctx.clip();
    ctx.fillStyle = 'rgba(2,14,8,0.6)'; ctx.fillRect(x0, y0, rs, rs);
    const map = s.map;
    const mc = map && map.canvas;
    const ws = map ? num(map.worldSize, 0) : 0;
    if (mc && mc.width > 0 && mc.height > 0 && ws > 0) {
      ctx.translate(cx, cy);
      ctx.rotate(-hdg);
      ctx.scale(k * ws / mc.width, k * ws / mc.height);
      ctx.translate(-(ox + ws / 2) / ws * mc.width, -(oz + ws / 2) / ws * mc.height);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(mc, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = 'rgba(0,14,8,0.28)'; ctx.fillRect(x0, y0, rs, rs);
    }
    // range rings + heading line
    ctx.beginPath();
    ctx.moveTo(cx + rad - 0.5, cy); ctx.arc(cx, cy, rad - 0.5, 0, TAU);
    ctx.moveTo(cx + rad / 2, cy); ctx.arc(cx, cy, rad / 2, 0, TAU);
    ctx.moveTo(cx, cy - 7 * u); ctx.lineTo(cx, y0);
    ctx.lineWidth = 1; ctx.strokeStyle = GREEN_DIM; ctx.stroke();

    // airfields: runway bars
    const afs = map && map.airfields;
    if (afs && afs.length) {
      ctx.beginPath();
      for (let i = 0; i < afs.length; i++) {
        const a = afs[i];
        if (!a) continue;
        const ax = num(a.x, a.pos ? a.pos.x : NaN), az = num(a.z, a.pos ? a.pos.z : NaN);
        if (ax !== ax || az !== az) continue;
        const e = ax - ox, n = -(az - oz);
        const px = cx + (e * ch - n * sh) * k, py = cy - (e * sh + n * ch) * k;
        if (Math.abs(px - cx) > rad + 10 || Math.abs(py - cy) > rad + 10) continue;
        const rel = num(a.heading, num(a.rwyHeading, 0)) - hdg;
        const hl = Math.max(4 * u, num(a.length, 2500) * k * 0.5);
        const dx = Math.sin(rel) * hl, dy = -Math.cos(rel) * hl;
        ctx.moveTo(px - dx, py - dy); ctx.lineTo(px + dx, py + dy);
      }
      ctx.lineWidth = 4.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.lineWidth = 2.5; ctx.strokeStyle = WHITE; ctx.stroke();
    }
    // selected airfield + waypoint
    ctx.beginPath();
    let anyNav = false;
    if (nav && nav.pos) {
      const e = nav.pos.x - ox, n = -(nav.pos.z - oz);
      const px = cx + (e * ch - n * sh) * k, py = cy - (e * sh + n * ch) * k;
      if (Math.abs(px - cx) < rad && Math.abs(py - cy) < rad) { ctx.moveTo(px + 6 * u, py); ctx.arc(px, py, 6 * u, 0, TAU); anyNav = true; }
    }
    if (wpt && wpt.pos) {
      const e = wpt.pos.x - ox, n = -(wpt.pos.z - oz);
      const px = cx + (e * ch - n * sh) * k, py = cy - (e * sh + n * ch) * k;
      if (Math.abs(px - cx) < rad && Math.abs(py - cy) < rad) {
        const r = 4 * u;
        ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath(); anyNav = true;
      }
    }
    if (anyNav) { ctx.lineWidth = 3; ctx.strokeStyle = OUTLINE; ctx.stroke(); ctx.lineWidth = 1.25; ctx.strokeStyle = WHITE; ctx.stroke(); }

    // contacts
    const units = s.units;
    const tu = s.target ? s.target.unit : null;
    const d = Math.max(2, 2.2 * u);
    if (units && units.length) {
      for (let i = 0; i < units.length; i++) {
        const un = units[i];
        if (!un || !un.alive || un.isPlayer || !un.pos) continue;
        const e = un.pos.x - ox, n = -(un.pos.z - oz);
        const px = cx + (e * ch - n * sh) * k, py = cy - (e * sh + n * ch) * k;
        if (!(Math.abs(px - cx) < rad && Math.abs(py - cy) < rad)) continue;
        ctx.fillStyle = OUTLINE; ctx.fillRect(px - d - 1, py - d - 1, d * 2 + 2, d * 2 + 2);
        ctx.fillStyle = un.team === 1 ? RED : GREEN;
        if (un.kind === 'ground') { ctx.fillRect(px - d, py - d, d * 2, d * 2); ctx.fillStyle = OUTLINE; ctx.fillRect(px - d + 1.2, py - d + 1.2, d * 2 - 2.4, d * 2 - 2.4); }
        else ctx.fillRect(px - d, py - d, d * 2, d * 2);
      }
    }
    // selected target ring (clamped to the scope edge)
    const tp = s.target ? (s.target.pos || (tu && tu.pos)) : null;
    if (tp) {
      const e = tp.x - ox, n = -(tp.z - oz);
      const px = clamp(cx + (e * ch - n * sh) * k, x0 + 5 * u, x0 + rs - 5 * u);
      const py = clamp(cy - (e * sh + n * ch) * k, y0 + 5 * u, y0 + rs - 5 * u);
      ctx.beginPath(); ctx.moveTo(px + 5.5 * u, py); ctx.arc(px, py, 5.5 * u, 0, TAU);
      ctx.lineWidth = 3.5; ctx.strokeStyle = OUTLINE; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = WHITE; ctx.stroke();
    }
    // missile threats, flashing
    const th = s.threats, tn = th ? Math.min(num(s.threatN, 0), th.length) : 0;
    if (tn > 0) {
      const flash = (time * 6) % 1 < 0.5;
      const r = (flash ? 4.5 : 3) * u;
      for (let i = 0; i < tn; i++) {
        const m = th[i];
        if (!m) continue;
        const e = m.x - ox, n = -(m.z - oz);
        const px = clamp(cx + (e * ch - n * sh) * k, x0 + 5 * u, x0 + rs - 5 * u);
        const py = clamp(cy - (e * sh + n * ch) * k, y0 + 5 * u, y0 + rs - 5 * u);
        ctx.beginPath();
        ctx.moveTo(px, py - r); ctx.lineTo(px + r, py); ctx.lineTo(px, py + r); ctx.lineTo(px - r, py); ctx.closePath();
        ctx.fillStyle = flash ? AMBER : RED; ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = OUTLINE; ctx.stroke();
      }
    }
    // own ship
    ctx.beginPath();
    ctx.moveTo(cx, cy - 6 * u); ctx.lineTo(cx + 4 * u, cy + 4 * u); ctx.lineTo(cx, cy + 1.5 * u); ctx.lineTo(cx - 4 * u, cy + 4 * u); ctx.closePath();
    ctx.fillStyle = GREEN; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = OUTLINE; ctx.stroke();
    ctx.restore(); this._saved--;

    ctx.lineWidth = 1.5; ctx.strokeStyle = GREEN; ctx.strokeRect(x0 + 0.5, y0 + 0.5, rs - 1, rs - 1);
    // range labels
    this._f(this.fS);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    this._text(sRange(this.kRadar, range), x0 + 3 * u, y0 + rs - 8 * u, GREEN);
    this._text(sRange(this.kRadarHalf, range / 2), cx + 3 * u, cy + rad / 2 - 7 * u, GREEN_DIM);
    this._radarBottom = y0 + rs;
  }

  _navBlock(nav) {
    if (!nav) return;
    const ctx = this.ctx, u = this.u, x = this.R, lh = 14 * u;
    let y = (this._radarBottom || this.T) + 10 * u;
    this._f(this.fS);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    if (typeof nav.name === 'string') { this._text(nav.name, x, y, GREEN); y += lh; }
    const brg = num(nav.bearing, NaN), dist = num(nav.dist, NaN);
    if (dist === dist) this._text(sRange(this.kNavDst, dist), x, y, GREEN);
    if (brg === brg) this._text(sHdg(this.kNavBrg, brg * DEG), x - this.cw * 7, y, GREEN);
    y += lh;
    if (nav.ils) {
      const rh = num(nav.rwyHeading, NaN);
      if (rh === rh) {
        let n = Math.round(rh * DEG / 10) % 36; if (n <= 0) n += 36;
        const sl = this.kRwy;
        if (sl.k !== n) { sl.k = n; sl.s = sl.pre + (n < 10 ? '0' : '') + n; }
        this._text(sl.s, x, y, GREEN);
      } else this._text('ILS', x, y, GREEN);
    }
  }

  /* ------------------------------------------------------------------ warnings */

  _warnings(warn, time, full) {
    let n = 0, first = -1;
    for (let i = 0; i < W_KEY.length; i++) {
      const on = warn[W_KEY[i]] ? 1 : 0;
      _wActive[i] = on;
      if (on) { n++; if (first < 0) first = i; }
    }
    if (!n) return;
    const ctx = this.ctx, u = this.u, cx = this.cx;
    const yTop = this.T + (full ? 52 : 28) * u;
    const red = W_RED[first];
    const blinkOn = red ? (time * 4) % 1 < 0.7 : (time * 1.5) % 1 < 0.8;
    const bh = 21 * u;
    if (blinkOn) {
      this._f(this.fL);
      const txt = W_TXT[first];
      const bw = this._wWidthS[first] * 15 / 11 + 16 * u;
      const col = red ? RED : AMBER;
      ctx.fillStyle = 'rgba(20,0,0,0.6)'; ctx.fillRect(cx - bw / 2, yTop, bw, bh);
      ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.strokeRect(cx - bw / 2, yTop, bw, bh);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      this._text(txt, cx, yTop + bh / 2 + 0.5, col);
    }
    if (n > 1) {
      // the rest: one small row beneath
      const gap = 10 * u;
      let total = -gap;
      for (let i = first + 1; i < W_KEY.length; i++) if (_wActive[i]) total += this._wWidthS[i] + gap;
      let x = cx - total / 2;
      const y = yTop + bh + 10 * u;
      this._f(this.fS);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (let i = first + 1; i < W_KEY.length; i++) {
        if (!_wActive[i]) continue;
        this._text(W_TXT[i], x, y, W_RED[i] ? RED : AMBER);
        x += this._wWidthS[i] + gap;
      }
    }
  }

  /** Autopilot status + the rocket hacks (RCS grain, motor cut-off), low in the middle of the screen. */
  _apLine(s, time) {
    const ctx = this.ctx, u = this.u, x = this.L, lh = 14 * u;
    const ap = typeof s.ap === 'string' ? s.ap : '';
    const rcs = num(s.rcs, -1);
    let hack = '';
    if (s.motorsCut) hack = 'MOTORS CUT';
    else if (s.rcsOn) hack = 'RCS ' + Math.round(rcs * 100) + '%';
    if (!ap && !hack) return;
    this._f(this.fS);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    // left column, under the mission objective and score lines
    let y = this.T + 6 * u + lh * 6 + 8 * u;
    if (ap) {
      const str = 'AP · ' + ap, w = ctx.measureText(str).width + 12 * u, bh = 17 * u;
      ctx.fillStyle = BACK; ctx.fillRect(x - 4 * u, y - bh / 2, w, bh);
      ctx.lineWidth = 1; ctx.strokeStyle = GREEN; ctx.strokeRect(x - 4 * u + 0.5, y - bh / 2 + 0.5, w - 1, bh - 1);
      this._text(str, x + 2 * u, y + 0.5, GREEN);
      y += bh + 2 * u;
    }
    if (hack) this._text(hack, x, y, s.motorsCut ? AMBER : rcs < 0.2 && (time * 3) % 1 < 0.5 ? AMBER : GREEN);
  }

  /* ------------------------------------------------------------------ black-out / red-out */

  _vignette(b) {
    const ctx = this.ctx, W = this.w, H = this.h;
    const q = clamp(Math.round(b * 16), -16, 16);
    if (q === 0) return;
    if (q >= 16) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    let gr = this._vig[q + 16];
    if (!gr) {
      const a = Math.abs(q) / 16;
      const R = Math.hypot(W, H) / 2;
      const r0 = R * Math.max(0, 1 - a * 1.15), r1 = r0 + R * 0.55;
      gr = ctx.createRadialGradient(W / 2, H / 2, r0, W / 2, H / 2, r1);
      if (q > 0) {
        gr.addColorStop(0, 'rgba(0,0,0,' + (a * a * 0.85).toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(0,0,0,' + Math.min(1, 0.35 + a).toFixed(3) + ')');
      } else {
        gr.addColorStop(0, 'rgba(150,0,0,' + (a * 0.55).toFixed(3) + ')');
        gr.addColorStop(1, 'rgba(120,0,0,' + Math.min(0.95, 0.3 + a * 0.7).toFixed(3) + ')');
      }
      this._vig[q + 16] = gr;
    }
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H);
  }
}
