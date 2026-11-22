// Environment.js — the visible world: sky, sun, terrain, water, clouds, airfields,
// city and trees, all built on world/Heightfield.js. Custom shaders share one
// atmosphere (fog) function so distant terrain, water and sky blend together.
import * as THREE from 'three';
import { Heightfield, WORLD_SIZE, GRID } from './Heightfield.js';

/** Merge BufferGeometries with identical attribute sets (position/normal[/uv/color]) into one indexed geometry. */
function mergeGeo(list) {
  const names = Object.keys(list[0].attributes);
  let vc = 0, ic = 0;
  for (const g of list) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const out = new THREE.BufferGeometry();
  for (const n of names) {
    const itemSize = list[0].attributes[n].itemSize, arr = new Float32Array(vc * itemSize);
    let o = 0;
    for (const g of list) { const a = g.attributes[n]; arr.set(a.array, o); o += a.count * itemSize; }
    out.setAttribute(n, new THREE.BufferAttribute(arr, itemSize));
  }
  const idx = new Uint32Array(ic);
  let io = 0, vo = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.array[i] + vo;
    else for (let i = 0; i < c; i++) idx[io + i] = i + vo;
    io += g.index ? g.index.count : c; vo += c;
  }
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
import { bakeTerrainLight } from './LightBake.js';
import { buildLandmarks } from './Landmarks.js';
import { buildCarrierMesh } from './CarrierMesh.js';

/* ---------- time-of-day presets ---------- */
export const ATMOSPHERES = {
  day: {
    label: 'Clear day', sunElev: 42, sunAz: 215,
    sun: 0xfff1d8, sunI: 2.6, amb: 0x6f8fb8, ambI: 0.75,
    zenith: 0x1d58a8, horizon: 0xa9cbe8, sunFog: 0xf4e6c8, fogD: 0.000048, cloud: 0xffffff, exposure: 1.0, shadow: 1,
  },
  dawn: {
    label: 'Golden hour', sunElev: 9, sunAz: 110,
    sun: 0xffc27a, sunI: 2.4, amb: 0x6a78a0, ambI: 0.6,
    zenith: 0x2a4f8c, horizon: 0xd9b89a, sunFog: 0xffb060, fogD: 0.00006, cloud: 0xffe2c4, exposure: 1.05, shadow: 1,
  },
  sunset: {
    label: 'Sunset', sunElev: 3.5, sunAz: 285,
    sun: 0xff8a45, sunI: 2.0, amb: 0x5a5a88, ambI: 0.55,
    zenith: 0x1b2f66, horizon: 0xc78f7c, sunFog: 0xff6a2a, fogD: 0.000062, cloud: 0xffb89a, exposure: 1.1, shadow: 1,
  },
  night: {
    label: 'Moonlit night', sunElev: 38, sunAz: 160,
    sun: 0x8fa8d8, sunI: 0.55, amb: 0x1c2a48, ambI: 0.55,
    zenith: 0x02040c, horizon: 0x0d1626, sunFog: 0x182540, fogD: 0.00005, cloud: 0x55607a, exposure: 1.15, night: true, shadow: 0.85,
  },
  overcast: {
    label: 'Overcast', sunElev: 35, sunAz: 200,
    sun: 0xc9d0d6, sunI: 0.9, amb: 0x8a96a4, ambI: 1.15,
    zenith: 0x6f7c8a, horizon: 0xaab3bb, sunFog: 0xb8c0c6, fogD: 0.00011, cloud: 0xb9c0c8, exposure: 1.0, shadow: 0.3,
  },
};

const FOG_GLSL = `
uniform vec3 uFogCol; uniform vec3 uSunFog; uniform float uFogD; uniform vec3 uSunDir;
// haze thins with height (scale height 1700 m): mean density along the ray camera -> point
float hazeMean(float camY, float y) {
  float y0 = max(camY, 0.0) / 1700.0, y1 = max(y, 0.0) / 1700.0, dy = y1 - y0;
  return 1.2 * (abs(dy) < 0.01 ? exp(-y0) : (exp(-y0) - exp(-y1)) / dy);
}
vec3 applyFog(vec3 col, vec3 wpos) {
  vec3 v = wpos - cameraPosition; float d = length(v);
  float t = uFogD * d * hazeMean(cameraPosition.y, wpos.y);
  float f = 1.0 - exp(-t * t);
  float s = pow(max(dot(v / d, uSunDir), 0.0), 8.0);
  return mix(col, mix(uFogCol, uSunFog, s * 0.7), f);
}`;
// Baked terrain light (world/LightBake.js): x = sun visibility, y = sky visibility.
const LIGHT_GLSL = `
uniform sampler2D uLightMap; uniform vec4 uLightK;   // 1 / world size, shadow strength, occlusion strength, -
uniform sampler2D uCloudSh; uniform vec4 uCloudP;    // drift (m), 1 / wrap length in x, 1 / span in z, strength
uniform vec2 uSunSlope;                              // horizontal metres towards the sun per metre of height
float cloudShade(vec3 w) {
  vec2 q = w.xz - uSunSlope * w.y;
  float c = texture2D(uCloudSh, vec2((q.x - uCloudP.x) * uCloudP.y, q.y * uCloudP.z) + 0.5).r;
  return 1.0 - c * uCloudP.w * (1.0 - smoothstep(1300.0, 1900.0, w.y));
}
// for things in the air: lit when above the shadow ceiling stored in b
float airLight(vec3 w) {
  float ceil = texture2D(uLightMap, w.xz * uLightK.x + 0.5).b * 2550.0;
  return mix(1.0, clamp((w.y - ceil) / 50.0 + 0.5, 0.0, 1.0), uLightK.y) * cloudShade(w);
}
vec2 bakedLight(vec3 w) {
  vec4 l = texture2D(uLightMap, w.xz * uLightK.x + 0.5);
  return vec2(mix(1.0, l.r, uLightK.y) * cloudShade(w), mix(1.0, l.g, uLightK.z));
}`;
/** Convex hull of [x, z] points (monotone chain), counter-clockwise. */
function convexHull(p) {
  p.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

// Built-in materials (buildings, trees, aircraft) get the same height haze: only the fog depth is
// rescaled, in the vertex shader. Camera height comes from viewMatrix because three.js does not
// set cameraPosition for Lambert/Basic materials.
THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = length(mvPosition.xyz);
  {
    float fy0 = max(-dot(viewMatrix[1].xyz, viewMatrix[3].xyz), 0.0) / 1700.0;
    float fy1 = max(dot(viewMatrix[1].xyz, mvPosition.xyz - viewMatrix[3].xyz), 0.0) / 1700.0, fdy = fy1 - fy0;
    vFogDepth *= 1.2 * (abs(fdy) < 0.01 ? exp(-fy0) : (exp(-fy0) - exp(-fy1)) / fdy);
  }
#endif`;

/**
 * Aircraft materials outlive any one Environment, so they read the shadow maps through these shared
 * uniforms; the newest Environment points them at its textures. uShOff is added to the world position:
 * Engine sets it to the camera position for the camera-relative cockpit pass, zero otherwise.
 */
export const SHADE_UNIFORMS = {
  uLightMap: { value: null }, uLightK: { value: new THREE.Vector4(0, 0, 0, 0) }, uCloudSh: { value: null },
  uCloudP: { value: new THREE.Vector4(0, 1, 1, 0) }, uSunSlope: { value: new THREE.Vector2() }, uShOff: { value: new THREE.Vector3() },
};
/** Patch an aircraft material (Standard/Physical) to go dark inside mountain and cloud shadows. */
export function shadeAir(mat) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey;
  const had = !!prev && prev !== THREE.Material.prototype.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    if (had) prev.call(this, sh, r);
    Object.assign(sh.uniforms, SHADE_UNIFORMS);
    sh.vertexShader = 'varying vec3 vShW;\n' + sh.vertexShader.replace('#include <project_vertex>',
      '#include <project_vertex>\n vShW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = 'varying vec3 vShW; uniform vec3 uShOff;\n' + LIGHT_GLSL + '\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
      `outgoingLight = (outgoingLight - totalEmissiveRadiance) * mix(0.5, 1.0, airLight(vShW + uShOff)) + totalEmissiveRadiance;
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'air+' + (had ? prev.toString().length : 0) + (prevKey ? prevKey.call(mat) : '');
  return mat;
}

// Shared city-roof geometries (built once per module load): the residential gable roof is a prism
// 1 m wide, 2.4 m pitch at x = 0, running z -0.5..0.5 — scaled per instance to the building footprint.
const GABLE_GEO = (() => {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0); s.lineTo(0, 2.4); s.lineTo(0.5, 0); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false });
  g.translate(0, 0, -0.5);
  return g;
})();

const _cloudGrey = new THREE.Color();
const _yAxis = new THREE.Vector3(0, 1, 0);
const OUT_GLSL = `
#include <tonemapping_fragment>
#include <colorspace_fragment>`;

export class Environment {
  constructor(engine, opts = {}) {
    this.engine = engine;
    this.scene = engine.scene;
    this.quality = engine.quality;
    this.time = 0;
    this.group = new THREE.Group();
    this.scene.add(this.group);

    // heightfields are cached per map: regenerating one costs ~0.2 s
    const mapKey = opts.map || 'nordic';
    Environment._hfs = Environment._hfs || {};
    this.hf = Environment._hfs[mapKey] || (Environment._hfs[mapKey] = new Heightfield(mapKey));
    this.map = this.hf.map;
    this.hf.stride = this.quality === 'high' ? 1 : this.quality === 'low' ? 4 : 2;
    this.airfields = this.hf.airfields;
    // legacy alias used by HUD/radar code
    this.runways = this.airfields;

    this.atmo = ATMOSPHERES[opts.time] || ATMOSPHERES.day;
    const a = this.atmo;
    const el = a.sunElev * Math.PI / 180, az = a.sunAz * Math.PI / 180;
    this.sunDir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    this.uniforms = {
      uFogCol: { value: new THREE.Color(a.horizon) }, uSunFog: { value: new THREE.Color(a.sunFog) },
      uFogD: { value: a.fogD }, uSunDir: { value: this.sunDir },
      uSunCol: { value: new THREE.Color(a.sun).multiplyScalar(a.sunI) },
      uAmb: { value: new THREE.Color(a.amb).multiplyScalar(a.ambI) },
      uZenith: { value: new THREE.Color(a.zenith) },
      uTime: { value: 0 },
      uDetail: { value: this.makeDetailTexture() },
      // cloud shadows: filled in by buildClouds / updateClouds
      uCloudSh: { value: null }, uCloudP: { value: new THREE.Vector4(0, 1, 1, 0) },
      uSunSlope: { value: new THREE.Vector2(this.sunDir.x, this.sunDir.z).divideScalar(Math.max(this.sunDir.y, 0.25)) },
    };
    const pal = this.map.palette, v3 = (c) => ({ value: new THREE.Vector3(c[0], c[1], c[2]) });
    this.palette = {
      uGrassA: v3(pal.grassA), uGrassB: v3(pal.grassB), uUpland: v3(pal.upland), uForestC: v3(pal.forest),
      uSand: v3(pal.sand), uRockA: v3(pal.rockA), uRockB: v3(pal.rockB), uSnow: v3(pal.snow),
      uShallow: v3(pal.shallow), uDeep: v3(pal.deep),
      uBands: { value: new THREE.Vector4(pal.uplandH[0], pal.uplandH[1], pal.snowH[0], pal.snowH[1]) },
      uRockS: { value: new THREE.Vector4(pal.rockSlope[0], pal.rockSlope[1], pal.beachH, pal.strata) },
      uPatch: { value: new THREE.Vector4(...(pal.patch || [0, 0, 0, 0])) },
    };
    engine.renderer.toneMappingExposure = a.exposure;
    this.scene.fog = new THREE.FogExp2(a.horizon, a.fogD);

    this._sharedTex = [];
    this.buildLightMap();
    this.initCityShadows();
    this.buildSky();
    this.buildEnvMap(engine.renderer);
    this.buildLights();
    this.buildTerrain();
    this.buildWater();
    this.buildClouds();
    this.buildAirfields();
    this.carrier = this.hf.carrier;
    if (this.carrier) { this.carrierMesh = buildCarrierMesh(this, this.carrier); this.group.add(this.carrierMesh); }
    this.buildCity();
    this.bakeCityShadows();
    if (this.quality !== 'low') this.buildTrees();
    for (const k of ['uLightMap', 'uLightK', 'uCloudSh', 'uCloudP', 'uSunSlope']) SHADE_UNIFORMS[k].value = this.uniforms[k].value;
  }

  dispose() {
    this.scene.remove(this.group);
    if (this.heightTex) this.heightTex.dispose();
    if (this.light) this.light.tex.dispose();
    if (this.clouds && this.clouds.shadowTex) this.clouds.shadowTex.dispose();
    if (this.envRT) { if (this.scene.environment === this.envRT.texture) this.scene.environment = null; this.envRT.dispose(); }
    this.scene.remove(this.hemi); this.scene.remove(this.sun);
    // shared textures (sprite atlas, marking decals) are used by several airfield materials: unhook
    // them first so the traverse below cannot free one of them twice and leave a live Points
    // sampling a destroyed texture (it would render black). Free the list once, here.
    if (this._sharedTex) {
      this.group.traverse(o => { for (const mt of [].concat(o.material || [])) { mt.map = null; mt.emissiveMap = null; } });
      for (const t of this._sharedTex) t.dispose();
      this._sharedTex.length = 0;
    }
    this.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      for (const mt of [].concat(o.material || [])) { if (mt.map) mt.map.dispose(); if (mt.emissiveMap) mt.emissiveMap.dispose(); mt.dispose(); }
    });
  }

  /* ---------- procedural textures ---------- */
  makeDetailTexture() {
    // tileable multi-octave value noise, different seed per channel
    const S = 256, data = new Uint8Array(S * S * 4);
    for (let ch = 0; ch < 3; ch++) {
      const acc = new Float32Array(S * S);
      let amp = 1, tot = 0;
      for (let cells = 8; cells <= 128; cells *= 2) {
        const lat = new Float32Array(cells * cells);
        for (let i = 0; i < lat.length; i++) lat[i] = Math.random();
        const sc = cells / S;
        for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
          const fx = x * sc, fy = y * sc, ix = Math.floor(fx), iy = Math.floor(fy);
          let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
          const x1 = (ix + 1) % cells, y1 = (iy + 1) % cells;
          const a = lat[iy * cells + ix], b = lat[iy * cells + x1], c = lat[y1 * cells + ix], d = lat[y1 * cells + x1];
          acc[y * S + x] += (a + (b - a) * tx + (c - a + (a - b - c + d) * tx) * ty) * amp;
        }
        tot += amp; amp *= 0.55;
      }
      for (let i = 0; i < S * S; i++) data[i * 4 + ch] = Math.max(0, Math.min(255, ((acc[i] / tot - 0.5) * 1.9 + 0.5) * 255));
    }
    for (let i = 0; i < S * S; i++) data[i * 4 + 3] = 255;
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  }

  makeGlowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.08, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }

  /**
   * Airfield lamp sprite atlas: one 256² canvas, four quadrants (bulb / halo / flood pool / strobe).
   * Peak alpha is capped at 0.85 — the sprites are additive and bloom on med/high, and each bulb
   * keeps a >=4 px opaque core so it still reads with no post at all on low. Built once per
   * Environment (this._airAtlas) and shared by every airfield's Points; see dispose().
   */
  makeSpriteAtlas() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const quad = (cx, cy, draw) => { ctx.save(); ctx.translate(cx, cy); ctx.beginPath(); ctx.rect(-S / 2, -S / 2, S / 2, S / 2); ctx.clip(); draw(S / 2); ctx.restore(); };
    // bulb: hard small core + soft halo (runway edge, threshold, taxiway, PAPI)
    quad(0, 0, r => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.16, 'rgba(255,255,255,0.8)');
      g.addColorStop(0.34, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-r, -r, S / 2, S / 2);
    });
    // halo: wide soft disc (approach bars, flasher, beacons)
    quad(S, 0, r => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,0.7)'); g.addColorStop(0.4, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-r, -r, S / 2, S / 2);
    });
    // flood pool: very wide, flat wash for the apron (drawn as a point sprite lying low over the slabs)
    quad(0, S, r => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, 'rgba(255,255,255,0.34)'); g.addColorStop(0.5, 'rgba(255,255,255,0.12)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-r, -r, S / 2, S / 2);
    });
    // strobe: tiny very bright core with a short cross flare
    quad(S, S, r => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.5);
      g.addColorStop(0, 'rgba(255,255,255,0.85)'); g.addColorStop(0.3, 'rgba(255,255,255,0.3)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(-r, -r, S / 2, S / 2);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return {
      tex,
      uv: {
        bulb: [0.0, 0.5, 0.5, 1.0], halo: [0.5, 0.5, 1.0, 1.0],
        pool: [0.0, 0.0, 0.5, 0.5], strobe: [0.5, 0.0, 1.0, 0.0],
      },
    };
  }

  /**
   * One airfield's entire light system as flat arrays for a single Points draw call (spec 3.1).
   * Lamp classes from the exact table: edge / threshold / end / taxiway / apron-edge navigators,
   * apron flood pools, one approach row of crossbars + sequenced flasher, PAPI, and obstruction
   * beacons on the tower roof and hangar ridges. All coordinates are airfield-local (y = 1.2).
   */
  makeAirfieldLightGeometry(a) {
    const L = a.length / 2;                          // 1300 m to each threshold
    const pos = [], col = [], size = [], phase = [], rate = [], quad = [];
    // quad: 0 bulb (tight core) · 1 halo (wide soft) · 2 flood pool · 3 strobe
    const push = (x, y, z, r, g, b, s, ph = 0, rt = 0, qd = 0) => {
      pos.push(x, y, z); col.push(r, g, b); size.push(s); phase.push(ph); rate.push(rt); quad.push(qd);
    };
    const role = a.role;
    // runway edge: two sizes — larger lamps in the threshold band (2400 cd) vs 900 cd outboard
    for (let z = -L; z <= L; z += 60) {
      const s = Math.abs(z) > L - 180 ? 15 : 12;
      push(-32, 1.2, z, 1, 0.95, 0.78, s); push(32, 1.2, z, 1, 0.95, 0.78, s);
    }
    // threshold bars: green inward-facing, both ends (red is a stop light — not here)
    for (const sgn of [-1, 1]) {
      for (const x of [10, 13, 16, 19, 22, 25, 28]) { push(x, 1.2, sgn * L, 0.25, 1, 0.35, 16); push(-x, 1.2, sgn * L, 0.25, 1, 0.35, 16); }
      for (const x of [2, 6]) { push(x, 1.2, sgn * L, 0.25, 1, 0.35, 16); push(-x, 1.2, sgn * L, 0.25, 1, 0.35, 16); }
    }
    // runway end: red facing the approach, green facing back
    for (const sgn of [-1, 1]) { push(30, 1.2, sgn * L, 1, 0.15, 0.1, 16); push(-30, 1.2, sgn * L, 0.2, 1, 0.3, 16); }
    // taxiway edge: blue both sides of the 24 m parallel, amber at the three link mouths
    for (let z = -L + 30; z <= L - 30; z += 60) { push(138, 1.2, z, 0.2, 0.45, 1, 10); push(162, 1.2, z, 0.2, 0.45, 1, 10); }
    for (const z of [-a.length * 0.42, 0, a.length * 0.42]) {
      for (const x of [85 - 14, 85 + 14]) { push(x, 1.2, z - 16, 1, 0.6, 0.2, 10); push(x, 1.2, z + 16, 1, 0.6, 0.2, 10); }
    }
    // apron edge: amber along the outer edge plus the link mouths
    for (let z = -312; z <= 312; z += 78) push(351, 1.2, z, 1, 0.6, 0.2, 10);
    // apron floodlight pools: warm ground wash (the enemy field is unlit at night)
    if (role !== 'enemy') for (const mx of [165, 345]) for (const mz of [-260, 0, 260]) push(mx, 0.35, mz, 1, 0.72, 0.4, 90, 0, 0, 2);
    // approach lights: ONE end only — the threshold farther from the city (deterministic)
    const city = this.hf.city || { x: 0, z: 0 };
    const ae = Math.hypot(a.x + a.dirX * L - city.x, a.z + a.dirZ * L - city.z) >
               Math.hypot(a.x - a.dirX * L - city.x, a.z - a.dirZ * L - city.z) ? 1 : -1;
    for (const d of [300, 450, 600, 750]) {
      const n = 3 + 2 * Math.floor((d - 300) / 150);                       // 3 / 5 / 7 / 9 lamps
      for (let i = 0; i < n; i++) push((i - (n - 1) / 2) * 4.5, 1.2, ae * (L + d), 1, 0.95, 0.85, 14);
    }
    // sequenced flasher: outer marker to the threshold, 0.4 Hz chase by distance (med/high only)
    if (this.quality !== 'low') {
      const rt = 0.4;
      for (let d = 900; d >= 300; d -= 40) push(0, 1.2, ae * (L + d), 1, 1, 1, 18, ((ae > 0 ? d : -d) / 40) % 1, rt, 3);
    }
    // PAPI: four lamps 15 m apart, just past the approach threshold on its left (med/high only)
    if (this.quality !== 'low') {
      const pcol = [1, 0.12, 0.1];                                         // red; white set applied per-lamp below
      for (let i = 0; i < 4; i++) {
        const w = i >= 2 ? 1 : 0;                                          // 2 red / 2 white on the glide path
        push(-45, 1.2, ae * (L + 15) + ae * i * 15, w ? 1 : pcol[0], w ? 0.97 : pcol[1], w ? 0.9 : pcol[2], 20);
      }
    }
    // obstruction beacons: tower roof and each hangar ridge, flashing (enemy strobes faster);
    // low tier keeps them steady — the budget gives low "navigator only, no blink"
    let brt = role === 'enemy' ? 1.6 : role === 'civil' ? 1.0 : 0.8;
    if (this.quality === 'low') brt = 0;
    push(330, 49.5, 330, 1, 0.08, 0.06, 22, 0, brt, 1);
    for (let i = 0; i < 4; i++) push(395, 24, -230 + i * 150, 1, 0.08, 0.06, 22, 0.25 * i % 1, brt, 1);
    return { pos: new Float32Array(pos), col: new Float32Array(col), size: new Float32Array(size), phase: new Float32Array(phase), rate: new Float32Array(rate), quad: new Uint8Array(quad) };
  }

  /**
   * The one blink material for all airfield lights (spec 3.1a): a Points ShaderMaterial — not
   * PointsMaterial + onBeforeCompile, which has no uTime and would chase a uniform that never
   * reaches the shader. uTime is wired to this.uniforms.uTime, the same object update() advances.
   */
  makeLampMaterial(atlas) {
    return new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      uniforms: {
        uTime: this.uniforms.uTime, uNight: { value: this.atmo.night || this.atmo.sunElev < 12 ? 1 : 0 },
        uAtlas: { value: atlas.tex },
      },
      vertexShader: `uniform float uTime;
        attribute float aSize; attribute float aPhase; attribute float aRate; attribute float aQuad;
        varying vec3 vCol; varying vec4 vUv; varying float vBlink;
        void main() {
          vCol = color;
          // atlas quadrant (bulb / halo / pool / strobe) as a 0.5x0.5 uv window
          vec2 o = vec2(mod(aQuad, 2.0), floor(aQuad * 0.5));
          vUv = vec4(o * 0.5, 0.5, 1.0);
          float p = fract(uTime * aRate + aPhase);
          // flashing classes: ~20 % duty cycle; steady lamps pass aRate = 0 and stay on
          vBlink = aRate > 0.0 ? smoothstep(0.0, 0.15, p) * smoothstep(1.0, 0.85, p) : 1.0;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * (300.0 / -mv.z), 3.0, 64.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform sampler2D uAtlas; uniform float uNight;
        varying vec3 vCol; varying vec4 vUv; varying float vBlink;
        void main() {
          vec4 t = texture2D(uAtlas, gl_PointCoord * 0.5 + vUv.xy);
          // day: a faint sheen on the pavement, never invisible geometry; night: full brightness
          gl_FragColor = vec4(vCol, t.a * mix(0.25, 1.0, uNight) * vBlink);
        }`,
      vertexColors: true,
    });
  }

  /**
   * Red flashing obstruction beacons for the tallest city roofs (spec 3.3.6): same blink shader as
   * the airfield lamps but a fixed red colour and world-space positions, one Points for the whole
   * city — 1 Hz, ~20 % duty cycle, steady on low.
   */
  makeBeaconMaterial(atlas) {
    const mat = this.makeLampMaterial(atlas);
    mat.vertexShader = mat.vertexShader.replace('varying vec3 vCol; varying vec4 vUv;', 'varying vec4 vUv;')
      .replace('vCol = color;\n', '');
    mat.fragmentShader = mat.fragmentShader.replace('varying vec3 vCol; varying vec4 vUv;', 'varying vec4 vUv;')
      .replace('gl_FragColor = vec4(vCol,', 'gl_FragColor = vec4(vec3(1.0, 0.08, 0.06),');
    mat.vertexColors = false;
    return mat;
  }

  /* ---------- airfield buildings (spec 3.2) ---------- */
  /**
   * Arched hangar shed: box body + semicircular roof whose radius equals half the span, so the
   * arch meets the wall heads exactly (no more scale-hack overhang). Corrugation ribs run radially
   * along the arch; the runway-facing end has a two-panel slide door with frame and tracks.
   * Per-role palette: home green, civil cream, enemy dark grey. The interior behind the open door
   * is one dark plane (warm for civil fields) — the cheapest "there is a hangar behind this door".
   */
  makeHangar(role, fill) {
    const q = this.quality;                                                            // low: plain box + door only (~1.2 k tri tier)
    const bodyCol = role === 'home' ? 0x5f7a5c : role === 'civil' ? 0xd8d2c4 : 0x4a4e52;
    const bodyM = new THREE.MeshLambertMaterial({ color: bodyCol, emissive: fill(bodyCol, 0.3) });
    const steelM = new THREE.MeshLambertMaterial({ color: 0x6a7076, emissive: fill(0x6a7076, 0.3) });
    const doorM = new THREE.MeshLambertMaterial({ color: 0x8a9096, emissive: fill(0x8a9096, 0.25) });
    const darkM = new THREE.MeshBasicMaterial({ color: role === 'civil' ? 0x3a2f1e : 0x141414 });
    for (const m of [bodyM, steelM, doorM]) this.shadeMat(m);
    // body: span in x (70), height 20, length in z (90) — sits on the ground
    const body = new THREE.BoxGeometry(70, 20, 90); body.translate(0, 10, 0);
    // roof: semicircle profile radius 35 = half the span; ExtrudeGeometry extrudes the XY profile
    // along +z, which is exactly the hangar length — no rotation needed. The arch meets the wall
    // heads at y = 20 (the profile starts and ends at x = ±35, y = 0).
    const prof = new THREE.Shape();
    prof.moveTo(-35, 0);
    for (let i = 1; i <= 16; i++) prof.lineTo(35 * Math.cos(i / 16 * Math.PI), 35 * Math.sin(i / 16 * Math.PI));
    const roofG = new THREE.ExtrudeGeometry(prof, { depth: 88, bevelEnabled: false });
    roofG.translate(0, 20, -44);                                                       // centred on the 90 m body
    // corrugation ribs: longitudinal ridges sitting ON the arch surface (thin radially, long in z)
    const ribG = [];
    for (let i = 0; i < 10; i++) {
      const th = (i + 0.5) / 10 * Math.PI;                                             // 0..PI across the arch
      const rib = new THREE.BoxGeometry(1.4, 0.7, 86);                                 // local x radial after rotateZ(th)
      rib.rotateZ(th);
      rib.translate(35.5 * Math.cos(th), 20 + 35.5 * Math.sin(th), 0);
      ribG.push(rib);
    }
    // slide door on the runway-facing end (local x = -35): two panels, side frames, top track
    const track = new THREE.BoxGeometry(1, 1.2, 44); track.translate(-35.5, 19, 0);
    const panelA = new THREE.BoxGeometry(0.8, 16, 20); panelA.translate(-35.7, 8, -11);
    const panelB = new THREE.BoxGeometry(0.8, 16, 20); panelB.translate(-35.7, 8, 11);
    const frameL = new THREE.BoxGeometry(0.9, 18, 1); frameL.translate(-35.6, 9, -22);
    const frameR = new THREE.BoxGeometry(0.9, 18, 1); frameR.translate(-35.6, 9, 22);
    // the void behind the open door (faces -x, toward the runway)
    const interior = new THREE.PlaneGeometry(40, 18); interior.rotateY(-Math.PI / 2); interior.translate(-34.6, 9, 0);
    const g = new THREE.Group();
    const sets = [[mergeGeo([body]), bodyM]];
    if (q !== 'low') sets.push([mergeGeo([roofG, ...ribG]), steelM]);
    sets.push([mergeGeo([track, panelA, panelB, frameL, frameR]), doorM], [interior, darkM]);
    for (const [geo, mat] of sets) { const m = new THREE.Mesh(geo, mat); m.position.x = 395; g.add(m); }
    return g;
  }

  /**
   * Three-tier control tower: hex concrete shaft, gallery slab with railing (16 posts + 2 rails),
   * glass cab with hairline mullions (not a solid glow at night), roof + radar dome, VHF whips.
   */
  makeTower(fill) {
    if (this.quality === 'low') {                                                      // low tier: shaft + cab only
      const concM = new THREE.MeshLambertMaterial({ color: 0xc9c5b8, emissive: fill(0xc9c5b8, 0.3) });
      this.shadeMat(concM);
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(5, 7, 38, 6), concM); shaft.position.set(330, 19, 330); g.add(shaft);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(10, 8, 8, 8),
        new THREE.MeshLambertMaterial({ color: 0x1c3a4a, emissive: this.atmo.night ? 0x9a7a3c : 0 }));
      cab.position.set(330, 42, 330); g.add(cab);
      return g;
    }
    const concM = new THREE.MeshLambertMaterial({ color: 0xc9c5b8, emissive: fill(0xc9c5b8, 0.3) });
    const steelM = new THREE.MeshLambertMaterial({ color: 0x6a7076, emissive: fill(0x6a7076, 0.3) });
    const glassM = new THREE.MeshLambertMaterial({ color: 0x1c3a4a, emissive: this.atmo.night ? 0x9a7a3c : 0 });
    for (const m of [concM, steelM]) this.shadeMat(m);
    const conc = [], steel = [], glass = [];
    const shaft = new THREE.CylinderGeometry(4.5, 6.5, 32, 6); shaft.translate(0, 16, 0); conc.push(shaft);
    const slab = new THREE.BoxGeometry(22, 1.4, 22); slab.translate(0, 32.7, 0); conc.push(slab);
    for (let i = 0; i < 16; i++) {                                                     // railing posts around the gallery
      const a = i / 16 * Math.PI * 2;
      const post = new THREE.BoxGeometry(0.3, 1.6, 0.3); post.translate(Math.cos(a) * 9.6, 34.5, Math.sin(a) * 9.6); conc.push(post);
    }
    for (const h of [33.7, 34.5]) {                                                    // two rails
      const rail = new THREE.TorusGeometry(9.6, 0.12, 4, 40); rail.rotateX(Math.PI / 2); rail.translate(0, h, 0); steel.push(rail);
    }
    const cab = new THREE.CylinderGeometry(8.5, 9.5, 7, 12); cab.translate(0, 37.5, 0); glass.push(cab);
    for (let i = 0; i < 6; i++) {                                                      // mullions break up the glow
      const a = i / 6 * Math.PI * 2;
      const mul = new THREE.BoxGeometry(0.3, 7, 0.3); mul.translate(Math.cos(a) * 9.1, 37.5, Math.sin(a) * 9.1); glass.push(mul);
    }
    const roofD = new THREE.CylinderGeometry(6, 8.7, 2.5, 12); roofD.translate(0, 42.4, 0); glass.push(roofD);
    const dome = new THREE.SphereGeometry(3.4, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2); dome.translate(0, 43.4, 0); glass.push(dome);
    const g = new THREE.Group();
    for (const [geo, mat] of [[mergeGeo(conc), concM], [mergeGeo(steel), steelM], [mergeGeo(glass), glassM]]) {
      const m = new THREE.Mesh(geo, mat); m.position.set(330, 0, 330); g.add(m);
    }
    // VHF whips: three ~1.5 m lines off the dome
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -1.5, 46, 0, -1.5, 47.8, 0,   // whip 1
      1.8, 46, 0, 1.8, 47.6, 0,     // whip 2
      0, 46.5, -2.2, 0, 48.2, -2.2, // whip 3
    ]), 3));
    const whips = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x8a9096 }));
    whips.position.set(330, 0, 330);
    g.add(whips);
    return g;
  }

  /**
   * Apron furniture (spec 3.2): traffic cones, baggage carts, a fuel bowser and the floodlight
   * masts — static scenery, so all instances are baked into one merged geometry: one draw call,
   * no per-frame work.
   */
  makeApronProps(fill) {
    const propM = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, emissive: fill(0x8a9096, 0.25) });
    this.shadeMat(propM);
    const coneG = () => { const g = new THREE.ConeGeometry(0.35, 1.1, 6); g.translate(0, 0.55, 0); return g; };
    const cartG = () => { const g = new THREE.BoxGeometry(4, 2, 2); g.translate(0, 1, 0); return g; };
    const bowserG = () => { const g = new THREE.CylinderGeometry(1.6, 1.6, 7, 8); g.rotateZ(Math.PI / 2); g.translate(0, 1.8, 0); return g; };
    const mastG = () => { const g = new THREE.CylinderGeometry(0.25, 0.35, 20, 6); g.translate(0, 10, 0); return g; };
    // [geometry, x, z, colour] — cones on the taxiway edge, carts/bowser on the apron, masts at the flood-pool sites
    const items = [
      [coneG(), 150, -100, [1, 0.55, 0.1]], [coneG(), 158, -92, [1, 0.55, 0.1]], [coneG(), 146, -84, [1, 0.55, 0.1]],
      [coneG(), 300, 150, [1, 0.55, 0.1]], [coneG(), 310, 158, [1, 0.55, 0.1]], [coneG(), 292, 142, [1, 0.55, 0.1]],
      [coneG(), 255, -200, [1, 0.55, 0.1]], [coneG(), 265, -192, [1, 0.55, 0.1]],
      [cartG(), 220, 60, [0.7, 0.72, 0.75]], [cartG(), 230, 72, [0.7, 0.72, 0.75]],
      [bowserG(), 280, -60, [0.85, 0.3, 0.25]],
      [mastG(), 165, -260, [0.6, 0.62, 0.65]], [mastG(), 345, 260, [0.6, 0.62, 0.65]],
    ];
    const geos = items.map(([g, x, z]) => { g.translate(x, 0.25, z); return g; });
    // bake per-prop colours into vertex colours so one material serves all of them
    for (let i = 0; i < geos.length; i++) {
      const c = items[i][3], n = geos[i].attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let j = 0; j < n; j++) { col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2]; }
      geos[i].setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const mesh = new THREE.Mesh(mergeGeo(geos), propM);
    mesh.frustumCulled = false;
    return mesh;
  }

  /** Perimeter fence (spec 3.2): 1.8 m posts every 3 m + three wire lines, one LineSegments. */
  makeFence(len) {
    const n = Math.floor(len / 3);
    const p = [];
    for (let i = 0; i <= n; i++) {
      const x = -len / 2 + i * 3;
      p.push(x, 0.25, 0, x, 1.8, 0);
    }
    for (const h of [0.9, 1.35, 1.75]) p.push(-len / 2, h, 0, len / 2, h, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x7a7e82 }));
  }

  /* ---------- baked terrain light ---------- */
  buildLightMap() {
    const R = this.quality === 'low' ? 512 : 1024;
    const data = bakeTerrainLight(this.hf, this.sunDir, R);
    const tex = new THREE.DataTexture(data, R, R, THREE.RGBAFormat);
    tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.needsUpdate = true;
    this.light = { R, data, tex };
    this.uniforms.uLightMap = { value: tex };
    this.uniforms.uLightK = { value: new THREE.Vector4(1 / WORLD_SIZE, this.atmo.shadow, 0.75, 0) };
  }

  /**
   * Make a built-in material (Lambert / Standard) on the ground take the baked mountain shadows and
   * the drifting cloud shadows, like the terrain under it. Emissive light (lit windows, fill) is kept.
   * Only for things standing on the ground: the map holds sun visibility at ground level.
   */
  shadeMat(mat) {
    const prev = mat.onBeforeCompile, U = this.uniforms;
    const shade = (sh) => {
      for (const k of ['uLightMap', 'uLightK', 'uCloudSh', 'uCloudP', 'uSunSlope']) sh.uniforms[k] = U[k];
      sh.vertexShader = 'varying vec3 vShW;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 shw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          shw = instanceMatrix * shw;
        #endif
        vShW = (modelMatrix * shw).xyz; }`);
      sh.fragmentShader = 'varying vec3 vShW;\n' + LIGHT_GLSL + '\n' + sh.fragmentShader.replace('#include <opaque_fragment>',
        `outgoingLight = (outgoingLight - totalEmissiveRadiance) * mix(0.5, 1.0, bakedLight(vShW).x) + totalEmissiveRadiance;
        #include <opaque_fragment>`);
    };
    // (two named variants so three.js keeps separate programs for materials that also had a hook)
    mat.onBeforeCompile = prev ? function shadedChained(sh, r) { prev(sh, r); shade(sh); } : function shadedPlain(sh) { shade(sh); };
    mat.customProgramCacheKey = () => (prev ? 'shade+' + prev.name : 'shade');
    return mat;
  }

  /** Sun visibility 0..1 on the ground at (x,z) from the baked map (mountain shadows). */
  sunAt(x, z) {
    const L = this.light, R = L.R;
    const i = Math.floor((x / WORLD_SIZE + 0.5) * R), j = Math.floor((z / WORLD_SIZE + 0.5) * R);
    if (i < 0 || j < 0 || i >= R || j >= R) return 1;
    return 1 - this.atmo.shadow * (1 - L.data[(j * R + i) * 4] / 255);
  }

  /* ---------- sky ---------- */
  buildSky() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { ...this.uniforms, uNight: { value: this.atmo.night ? 1 : 0 },
        uCirrus: { value: this.quality === 'low' ? 0 : this.atmo.cirrus ?? 0.5 }, uSpace: { value: 0 }, uDip: { value: 0 } },
      vertexShader: `varying vec3 vDir;
        void main() { vDir = position; vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; }`,
      fragmentShader: `varying vec3 vDir; uniform vec3 uZenith; uniform vec3 uSunCol; uniform float uNight;
        uniform vec3 uFogCol; uniform vec3 uSunFog; uniform vec3 uSunDir; uniform sampler2D uDetail; uniform float uTime; uniform float uCirrus;
        uniform float uSpace;   // 0 = lower atmosphere .. 1 = edge of space (set from camera height)
        uniform float uDip;     // sin of the horizon dip below eye level (round Earth, high up)
        float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
        void main() {
          vec3 d = normalize(vDir);
          float sd = max(dot(d, uSunDir), 0.0);
          vec3 hor = mix(uFogCol, uSunFog, pow(sd, 8.0) * 0.7);
          float h = max(d.y, 0.0);
          // climbing out of the atmosphere: less air above to scatter light, so the zenith goes
          // deep blue then black and the bright haze shrinks to a thin band along the horizon
          float sp = uSpace;
          vec3 zen = mix(uZenith, vec3(0.004, 0.008, 0.03), smoothstep(0.0, 0.85, sp));
          float hd = max(d.y + uDip, 0.0);               // the horizon dips below eye level up high
          vec3 limb = mix(hor, vec3(0.42, 0.62, 0.95), sp * 0.6 * smoothstep(-0.03, 0.05, d.y + uDip));   // below: matches the fogged sea
          vec3 col = mix(limb, zen, 1.0 - exp(-hd * mix(3.4, 26.0, sp)));
          col += uSunFog * pow(sd, 6.0) * 0.18 * (1.0 - h) * (1.0 - 0.85 * sp);
          // cirrus: thin streaky ice cloud on a high plane, lit by the sun colour (we climb past it)
          if (d.y > 0.015 && uCirrus > 0.0 && sp < 0.3) {
            vec2 p = d.xz / (d.y + 0.14) + uTime * vec2(0.0012, 0.0004);
            float a = texture2D(uDetail, p * vec2(0.05, 0.13)).r, b = texture2D(uDetail, p * vec2(0.16, 0.45) + a * 0.15).g;
            float cov = texture2D(uDetail, p * 0.021 + 0.37).b;
            float w = smoothstep(0.52, 0.95, a * 0.55 + b * 0.45 + (cov - 0.5) * 1.1 + uCirrus - 0.5) * smoothstep(0.015, 0.22, d.y);
            col = mix(col, uSunCol * (0.36 + 0.5 * pow(sd, 4.0)) + uZenith * 0.35 + hor * 0.25, w * 0.62 * (1.0 - sp / 0.3));
          }
          float disc = smoothstep(0.99955, 0.9998, sd);
          col += uSunCol * (disc * 6.0 + pow(sd, 900.0) * 1.5 + pow(sd, 90.0) * 0.12);
          // stars: at night, and in daylight once the sky above has gone black (away from the sun)
          float starK = max(uNight, smoothstep(0.45, 0.9, sp) * (1.0 - smoothstep(0.8, 0.97, sd)));
          if (starK > 0.0) {
            vec3 c = floor(d * 220.0);
            float s = step(0.9985, hash(c)) * smoothstep(0.02 - 0.1 * sp, 0.2 - 0.1 * sp, d.y);
            col += vec3(s) * (0.5 + 0.5 * hash(c + 3.0)) * starK;
          }
          gl_FragColor = vec4(col, 1.0);
          ${OUT_GLSL}
        }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 32, 20), mat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -10;
    this.group.add(this.sky);
  }

  /**
   * Reflection environment for the PBR materials (aircraft paint, canopy glass): a small scene
   * with this sky's zenith/horizon gradient, the sun and a ground tinted with the map's land
   * colour, prefiltered with PMREM. Lambert materials (terrain, city) ignore it.
   */
  buildEnvMap(renderer) {
    // a lost context (mobile sleep, GPU reset) can't compile the prefilter shaders: skip, the
    // materials just render without reflections until the next world build
    if (renderer.getContext().isContextLost()) return;
    const a = this.atmo, pal = this.map.palette;
    const ground = new THREE.Color(pal.grassA[0], pal.grassA[1], pal.grassA[2]).lerp(new THREE.Color(pal.grassB[0], pal.grassB[1], pal.grassB[2]), 0.5)
      .multiply(new THREE.Color(a.amb).multiplyScalar(a.ambI * 1.6).add(new THREE.Color(a.sun).multiplyScalar(a.sunI * Math.max(0.15, Math.sin(a.sunElev * Math.PI / 180)) * 0.5)));
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: {
        uZen: { value: new THREE.Color(a.zenith) }, uHor: { value: new THREE.Color(a.horizon) }, uSunFog: { value: new THREE.Color(a.sunFog) },
        uGround: { value: ground }, uSun: { value: new THREE.Color(a.sun).multiplyScalar(a.sunI) }, uSunDir: { value: this.sunDir },
      },
      vertexShader: 'varying vec3 vD; void main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `varying vec3 vD; uniform vec3 uZen, uHor, uSunFog, uGround, uSun, uSunDir;
        void main() {
          vec3 d = normalize(vD); float sd = max(dot(d, uSunDir), 0.0);
          vec3 hor = mix(uHor, uSunFog, pow(sd, 8.0) * 0.7);
          vec3 sky = mix(hor, uZen, 1.0 - exp(-max(d.y, 0.0) * 3.4));
          vec3 col = d.y > 0.0 ? sky : mix(hor, uGround, smoothstep(0.0, -0.18, d.y));
          col += uSun * (smoothstep(0.9990, 0.9996, sd) * 18.0 + pow(sd, 60.0) * 0.5);
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const sc = new THREE.Scene();
    sc.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), mat));
    const pm = new THREE.PMREMGenerator(renderer);
    try {
      this.envRT = pm.fromScene(sc, 0.02);
      this.scene.environment = this.envRT.texture;
    } catch (e) { this.envRT = null; }
    pm.dispose(); mat.dispose(); sc.children[0].geometry.dispose();
  }

  buildLights() {
    const a = this.atmo;
    this.hemi = new THREE.HemisphereLight(a.amb, 0x30342c, a.ambI * 1.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(a.sun, a.sunI);
    this.sun.position.copy(this.sunDir).multiplyScalar(1000);
    this.scene.add(this.sun);
  }

  /* ---------- terrain ---------- */
  buildTerrain() {
    const hf = this.hf, s = hf.stride, M = GRID / s, cs = hf.cell * s, half = hf.half;
    const n1 = M + 1;
    const pos = new Float32Array(n1 * n1 * 3), nor = new Float32Array(n1 * n1 * 3), forest = new Float32Array(n1 * n1);
    for (let j = 0; j <= M; j++) for (let i = 0; i <= M; i++) {
      const k = j * n1 + i, x = i * cs - half, z = j * cs - half;
      const h = hf.at(i * s, j * s);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      const dx = hf.at(i * s + s, j * s) - hf.at(i * s - s, j * s), dz = hf.at(i * s, j * s + s) - hf.at(i * s, j * s - s);
      const nx = -dx, ny = 2 * cs, nz = -dz, l = Math.hypot(nx, ny, nz);
      nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
      forest[k] = hf.forest(x, z, h);
    }
    const idx = new Uint32Array(M * M * 6);
    let p = 0;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1; // diagonal b–c, matches Heightfield.height()
      idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('forest', new THREE.BufferAttribute(forest, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const city = hf.city || { x: 0, z: 0, r: 0 };
    const ug = this.makeUrbanTextures();
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, ...this.palette, uCity: { value: new THREE.Vector3(city.x, city.z, city.real ? 0 : city.r) },
        uUrban: { value: ug.urban }, uGridTex: { value: ug.grid }, uGrid: { value: ug.info }, uUrbanOn: { value: ug.on },
        uRoofA: { value: new THREE.Vector3(...((this.map.urban && this.map.urban.groundA) || [0.3, 0.3, 0.29])) },
        uRoofB: { value: new THREE.Vector3(...((this.map.urban && this.map.urban.groundB) || [0.3, 0.3, 0.29])) },
        uCityShadow: { value: this.cityShadow.tex }, uCityBox: { value: this.cityShadow.box },
        uHeight: { value: this.makeHeightTexture() }, uHInfo: { value: new THREE.Vector4(GRID + 1, hf.cell, hf.half, !this.heightTex || this.quality === 'low' ? 0 : this.quality === 'high' ? 2 : 1) } },
      vertexShader: `attribute float forest; varying vec3 vW; varying vec3 vN; varying float vF;
        void main() { vW = position; vN = normal; vF = forest; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec3 vW; varying vec3 vN; varying float vF;
        uniform sampler2D uDetail; uniform vec3 uSunCol; uniform vec3 uAmb; uniform vec3 uCity;
        uniform vec3 uGrassA; uniform vec3 uGrassB; uniform vec3 uUpland; uniform vec3 uForestC; uniform vec3 uSand;
        uniform vec3 uRockA; uniform vec3 uRockB; uniform vec3 uSnow; uniform vec4 uBands; uniform vec4 uRockS; uniform vec4 uPatch;
        uniform sampler2D uCityShadow; uniform vec4 uCityBox;
        uniform sampler2D uUrban; uniform sampler2D uGridTex; uniform vec4 uGrid; uniform float uUrbanOn; uniform vec3 uRoofA; uniform vec3 uRoofB;
        uniform sampler2D uHeight; uniform vec4 uHInfo;   // texels per side, cell (m), half world (m), mode 0 off · 1 bilinear · 2 bicubic
        float hAt(vec2 xz) {
          vec2 t = (xz + uHInfo.z) / uHInfo.y;             // texel space (texel centres on integers)
          if (uHInfo.w < 1.5) return texture2D(uHeight, (t + 0.5) / uHInfo.x).r;
          // cubic B-spline from 4 bilinear taps: C2-smooth heights, so no grid shows in the lighting
          vec2 i = floor(t), f = t - i;
          vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0, w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
          vec2 w3 = f * f * f / 6.0, w2 = 1.0 - w0 - w1 - w3;
          vec2 g0 = w0 + w1, g1 = w2 + w3;
          vec2 h0 = i - 1.0 + w1 / g0 + 0.5, h1 = i + 1.0 + w3 / g1 + 0.5;
          float iv = 1.0 / uHInfo.x;
          return g0.y * (g0.x * texture2D(uHeight, vec2(h0.x, h0.y) * iv).r + g1.x * texture2D(uHeight, vec2(h1.x, h0.y) * iv).r)
               + g1.y * (g0.x * texture2D(uHeight, vec2(h0.x, h1.y) * iv).r + g1.x * texture2D(uHeight, vec2(h1.x, h1.y) * iv).r);
        }
        ${FOG_GLSL}
        ${LIGHT_GLSL}
        void main() {
          float h = vW.y;
          vec4 d1 = texture2D(uDetail, vW.xz / 70.0);
          vec4 d2 = texture2D(uDetail, vW.xz / 1100.0);
          vec4 d3 = texture2D(uDetail, vW.xz / 6500.0);
          float nz = d1.r * 0.4 + d2.g * 0.6;
          // per-pixel normal from the full-resolution heightfield: smooth light across the coarse mesh
          vec3 bn = normalize(vN);
          if (uHInfo.w > 0.5) {
            float e = uHInfo.y;
            vec3 tn = normalize(vec3(hAt(vW.xz - vec2(e, 0.0)) - hAt(vW.xz + vec2(e, 0.0)), 2.0 * e,
                                     hAt(vW.xz - vec2(0.0, e)) - hAt(vW.xz + vec2(0.0, e))));
            // bicubic (HIGH) is smooth everywhere; bilinear (MED) only on steep ground where kinks don't show
            float wt = uHInfo.w > 1.5 ? 0.85 : 0.8 * smoothstep(0.12, 0.3, 1.0 - bn.y);
            bn = normalize(mix(bn, tn, wt));
          }
          float slope = 1.0 - bn.y;
          // triplanar detail: on steep faces the top-down projection smears into streaks, so blend in
          // the two side projections by how much the face looks sideways
          vec3 tw = bn * bn; tw *= tw; tw /= tw.x + tw.y + tw.z;
          vec4 d4 = texture2D(uDetail, vW.xz / 260.0);
          if (tw.y < 0.97) {
            d1 = d1 * tw.y + texture2D(uDetail, vW.zy / 70.0) * tw.x + texture2D(uDetail, vW.xy / 70.0) * tw.z;
            d4 = d4 * tw.y + texture2D(uDetail, vW.zy / 260.0) * tw.x + texture2D(uDetail, vW.xy / 260.0) * tw.z;
            nz = d1.r * 0.4 + mix(d4.r, d2.g, tw.y) * 0.6;
          }
          // rock relief: mid-scale bumps and crags, only where it is steep (or high and bare)
          float rk = smoothstep(0.06, 0.32, slope) + smoothstep(uBands.y, uBands.y + 300.0, h) * 0.5;
          vec3 n = normalize(bn + vec3(d1.g - 0.5, 0.0, d1.b - 0.5) * (0.4 + 0.5 * rk) + vec3(d2.b - 0.5, 0.0, d2.r - 0.5) * 0.3
                            + vec3(d4.g - 0.5, 0.0, d4.b - 0.5) * 1.1 * rk);
          vec3 grass = mix(uGrassA, uGrassB, d2.r * 0.6 + d3.g * 0.6);
          // natural, less uniform ground cover: darker overall, with drier olive-brown drifts
          float gl = dot(grass, vec3(0.3, 0.5, 0.2));
          grass = mix(grass, gl * vec3(1.12, 1.0, 0.72), clamp(0.15 + 0.75 * smoothstep(0.35, 0.75, d3.r * 0.6 + d2.b * 0.4), 0.0, 1.0)) * 0.78;
          // large irregular patches (gravel plains, darker jungle) at two scales
          float pm = smoothstep(0.5, 0.78, d3.b * 0.95 + d2.g * 0.2 + d1.b * 0.05);
          grass = mix(grass, uPatch.rgb * (0.8 + 0.4 * d1.r), pm * uPatch.w);
          vec3 c = mix(grass, uUpland, smoothstep(uBands.x, uBands.y, h + nz * 200.0));
          c = mix(c, uForestC, vF * (0.55 + 0.45 * d1.r));
          // city blocks: grey ground with a street grid
          float cd = length(vW.xz - uCity.xy);
          float cm = uCity.z > 0.0 ? smoothstep(uCity.z * 1.05, uCity.z * 0.85, cd + (d2.r - 0.5) * 300.0) : 0.0;
          vec2 gp = vW.xz;
          if (uUrbanOn > 0.5) {
            // real maps: town ground from the district texture, street grid turned to the local angle
            vec2 tuv = (vW.xz + uHInfo.z) / (2.0 * uHInfo.z);
            cm = max(cm, texture2D(uUrban, tuv).r * (0.85 + 0.3 * d2.g));
            float ga = texture2D(uGridTex, tuv).r * 3.14159265;
            gp = vec2(dot(vW.xz, vec2(cos(ga), sin(ga))), dot(vW.xz, vec2(sin(ga), -cos(ga))));
          }
          // metres to the nearest block edge along each axis -> street bands (uGrid: block u, v, half street u, v)
          vec2 ge = (0.5 - abs(fract(gp / uGrid.xy) - 0.5)) * uGrid.xy;
          float street = max(smoothstep(uGrid.z + 2.4, uGrid.z - 2.4, ge.x), smoothstep(uGrid.w + 2.4, uGrid.w - 2.4, ge.y));
          vec3 blockC = vec3(0.30, 0.30, 0.29), streetC = vec3(0.12, 0.12, 0.13);
          if (uUrbanOn > 0.5) {
            // a tone per block (roofs, yards, car parks), the odd green square, and streets that
            // fade out with distance instead of turning the far town into graph paper
            vec2 bc = floor(gp / uGrid.xy);
            float bh = fract(sin(dot(bc, vec2(12.9898, 78.233))) * 43758.5453);
            blockC = mix(uRoofA, uRoofB, bh) * (0.82 + 0.36 * d1.r);
            blockC = mix(blockC, grass * 0.85, step(0.9, bh) * 0.75);
            streetC = vec3(0.085, 0.085, 0.09);
            street *= 1.0 - smoothstep(1200.0, 6000.0, length(vW - cameraPosition));
          }
          c = mix(c, mix(blockC, streetC, street), clamp(cm, 0.0, 1.0));
          c = mix(c, uSand, smoothstep(uRockS.z, uRockS.z * 0.25, h + (d1.r - 0.5) * 3.0));
          // rock on steep ground; with strata > 0 it is banded like layered sandstone
          float band = 0.5 + 0.5 * sin(h * 0.11 + d2.r * 4.0) * (0.7 + 0.3 * sin(h * 0.37));
          vec3 rock = mix(uRockA, uRockB, mix(d1.r, band * 0.8 + d1.r * 0.2, uRockS.w));
          c = mix(c, rock, smoothstep(uRockS.x, uRockS.y, slope + (nz - 0.5) * 0.12));
          float snow = smoothstep(uBands.z, uBands.w, h + nz * 320.0 - slope * 900.0);
          c = mix(c, uSnow, snow);
          c *= 0.7 + 0.6 * nz;
          // fine grain close to the camera so low passes don't look airbrushed
          float cdist = length(vW - cameraPosition);
          vec4 dn = texture2D(uDetail, vW.xz / 9.0);
          c *= mix(1.0, 0.72 + 0.56 * (dn.r * 0.6 + dn.b * 0.4), 1.0 - smoothstep(150.0, 1400.0, cdist));
          c = mix(c, vec3(0.05, 0.16, 0.2), smoothstep(0.0, -6.0, h) * 0.85);
          float dif = max(dot(n, uSunDir), 0.0);
          // baked building shadows (r) and contact occlusion around their bases (g)
          vec2 cuv = (vW.xz - uCityBox.xy) / uCityBox.z;
          float amb = 0.6 + 0.4 * n.y;
          vec2 bl = bakedLight(vW);
          dif *= bl.x; amb *= bl.y;
          if (uCityBox.w > 0.5 && cuv.x > 0.0 && cuv.y > 0.0 && cuv.x < 1.0 && cuv.y < 1.0) {
            vec4 cs = texture2D(uCityShadow, cuv);
            dif *= 1.0 - cs.r * 0.88;
            amb *= 1.0 - cs.g * 0.55;
          }
          vec3 col = c * (uAmb * amb + uSunCol * dif);
          gl_FragColor = vec4(applyFog(col, vW), 1.0);
          ${OUT_GLSL}
        }`,
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.frustumCulled = false;
    this.group.add(this.terrain);
  }

  /**
   * Real maps: R8 textures over the whole world — town ground amount (linear) and street-grid
   * angle (nearest, the same quantised values Heightfield.gridAngle() hands the building placer).
   * Other maps get 1-texel dummies and the old city disc.
   */
  makeUrbanTextures() {
    const hf = this.hf, u = this.map.urban;
    const mk = (data, S, linear) => {
      const t = new THREE.DataTexture(data, S, S, THREE.RedFormat, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = linear ? THREE.LinearFilter : THREE.NearestFilter;
      t.needsUpdate = true; this._sharedTex.push(t);
      return t;
    };
    if (!u || !hf.gridAng) {
      return { urban: mk(new Uint8Array(1), 1, true), grid: mk(new Uint8Array(1), 1, false), info: new THREE.Vector4(120, 120, 7.2, 7.2), on: 0 };
    }
    const S = hf.gridS, cs = WORLD_SIZE / S;
    let ground = hf._urbanTexData;                                       // cached with the heightfield
    if (!ground) {
      ground = hf._urbanTexData = new Uint8Array(S * S);
      for (let j = 0; j < S; j++) for (let i = 0; i < S; i++)
        ground[j * S + i] = Math.round(hf.urbanGround((i + 0.5) * cs - hf.half, (j + 0.5) * cs - hf.half) * 255);
    }
    return { urban: mk(ground, S, true), grid: mk(hf.gridAng, S, false), info: new THREE.Vector4(u.block[0], u.block[1], u.street[0] / 2, u.street[1] / 2), on: 1 };
  }

  /* ---------- water ---------- */
  buildWater() {
    const hf = this.hf, S = 512, data = new Uint8Array(S * S * 4);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
      const h = hf.at(Math.round(i * GRID / (S - 1)), Math.round(j * GRID / (S - 1)));
      const k = (j * S + i) * 4;
      data[k] = Math.max(0, Math.min(255, (-h / 40) * 255)); data[k + 3] = 255;
    }
    const depth = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    depth.magFilter = depth.minFilter = THREE.LinearFilter; depth.needsUpdate = true;
    // a disc, not a square: from high up its (fogged) rim is the horizon and must sit at one distance
    const geo = new THREE.CircleGeometry(120000, 128);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uShallow: this.palette.uShallow, uDeep: this.palette.uDeep, uDepth: { value: depth }, uWorld: { value: WORLD_SIZE } },
      vertexShader: `varying vec3 vW;
        void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `varying vec3 vW; uniform sampler2D uDetail; uniform sampler2D uDepth; uniform float uWorld; uniform float uTime;
        uniform vec3 uSunCol; uniform vec3 uAmb; uniform vec3 uZenith; uniform vec3 uShallow; uniform vec3 uDeep;
        ${FOG_GLSL}
        ${LIGHT_GLSL}
        void main() {
          vec3 V = cameraPosition - vW; float dist = length(V); V /= dist;
          vec2 uv = vW.xz;
          // wave slopes: three fine scrolling octaves (ripples, chop, swell). Mip-mapping flattens them
          // with distance, so the far sea is smooth and "rough" below takes over as sub-pixel roughness.
          vec3 a = texture2D(uDetail, uv / 9.0 + uTime * vec2(0.05, 0.031)).rgb - 0.5;
          vec3 b = texture2D(uDetail, uv / 37.0 - uTime * vec2(0.017, 0.026)).gbr - 0.5;
          vec3 c2 = texture2D(uDetail, uv / 131.0 + uTime * vec2(0.006, -0.009)).brg - 0.5;
          float wind = texture2D(uDetail, uv / 5200.0 + uTime * 0.0006).g;      // calm and ruffled patches
          float far = smoothstep(150.0, 5000.0, dist);
          float str = mix(0.5, 0.2, far) * (0.65 + 0.7 * wind);
          vec3 n = normalize(vec3((a.x * 0.6 + b.x + c2.x * 1.2) * str, 1.0, (a.y * 0.6 + b.y + c2.y * 1.2) * str));
          // rough-sea fresnel: wave faces tilt towards the viewer, so grazing reflection never reaches a mirror
          float nv = max(dot(n, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0) / (1.0 + 2.2 * (1.0 - nv));
          vec3 R = reflect(-V, n); R.y = abs(R.y) + 0.06 * far; R = normalize(R);
          float sd = max(dot(R, uSunDir), 0.0);
          vec3 sky = mix(mix(uFogCol, uSunFog, pow(sd, 8.0) * 0.7), uZenith, 1.0 - exp(-R.y * 3.4));
          vec2 duv = uv / uWorld + 0.5;
          float dep = (duv.x < 0.0 || duv.y < 0.0 || duv.x > 1.0 || duv.y > 1.0) ? 1.0 : texture2D(uDepth, duv).r;
          float lit = bakedLight(vW).x;            // mountain and cloud shadows fall across the water
          vec3 light = uAmb + uSunCol * max(uSunDir.y, 0.05) * 0.6 * lit;
          vec3 base = mix(uShallow, uDeep, smoothstep(0.0, 0.55, dep)) * light;
          base *= 0.85 + 0.3 * wind;
          vec3 col = mix(base, sky, fres);
          // sun glitter: tight sparkles near the camera, a broad shimmering path far away
          float glit = pow(sd, mix(520.0, 70.0, far)) * mix(5.0, 0.55, far) + pow(sd, 24.0) * 0.06;
          glit *= 0.6 + 0.8 * smoothstep(0.35, 0.75, a.z + 0.5 + b.z * 0.5);
          col += uSunCol * glit * lit;
          float foam = smoothstep(0.07, 0.0, dep) * smoothstep(0.35, 0.7, a.z + 0.5 + b.z * 0.6 + 0.25 * sin(uTime * 0.8 + uv.x * 0.02));
          // a few whitecaps where the wind ruffles open water
          foam = max(foam, smoothstep(0.80, 0.93, c2.z + 0.5 + b.z * 0.35 + (wind - 0.5) * 0.5) * 0.5 * (1.0 - far) * smoothstep(0.15, 0.45, dep));
          col = mix(col, light * 0.85, foam * 0.75);
          gl_FragColor = vec4(applyFog(col, vW), 1.0);
          ${OUT_GLSL}
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.frustumCulled = false;
    this.group.add(this.water);
  }

  /* ---------- clouds ---------- */
  // Volumetric-looking cumulus: each cloud is a cluster of camera-facing "puffs"
  // (one instanced draw call, sorted back-to-front every frame). A puff is shaded
  // as the front surface of a sphere, and its light comes from the whole cluster:
  // sun transmittance through the cluster's ellipsoid (analytic optical depth),
  // darker flat bases, sky/ground ambient, forward-scatter silver lining on thin
  // edges, and drifting noise erosion. Flying into one fogs the world to white.
  buildClouds() {
    const q = this.quality;
    const clusters = Math.round((q === 'low' ? 14 : q === 'high' ? 46 : 28) * this.map.clouds);
    const perCluster = q === 'low' ? 12 : q === 'high' ? 32 : 22;
    const cl = [], puffs = [];
    for (let i = 0; i < clusters; i++) {
      const big = 0.8 + Math.random() * 1.2;
      const rx = (900 + Math.random() * 700) * big, rz = rx * (0.6 + Math.random() * 0.5), ry = (380 + Math.random() * 260) * big;
      const base = 1500 + Math.random() * 2200;
      const c = { x: (Math.random() - 0.5) * WORLD_SIZE * 1.5, z: (Math.random() - 0.5) * WORLD_SIZE * 1.5,
        y: base + ry * 0.55, base, rx, ry, rz, first: puffs.length };
      const n = Math.round(perCluster * (0.7 + 0.3 * big));
      for (let k = 0; k < n; k++) {
        // dome: puffs spread wide near the base, fewer and higher towards the top
        const h = Math.pow(Math.random(), 1.4), spread = Math.sqrt(1 - h * h * 0.85);
        const a = Math.random() * Math.PI * 2, rr = Math.sqrt(Math.random()) * spread * 0.78;
        const r = (0.34 + 0.22 * Math.random()) * ry * (1.6 - 0.6 * h) * (0.75 + 0.35 * spread);
        const dy = Math.max(base + r * 0.45, base + h * ry * 1.35 + r * 0.2) - c.y;
        puffs.push({ c, dx: Math.cos(a) * rr * rx, dy, dz: Math.sin(a) * rr * rz, r });
      }
      c.count = puffs.length - c.first;
      cl.push(c);
    }
    const N = puffs.length;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const mk = (name) => { const at = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4); at.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(name, at); return at; };
    const aPuff = mk('aPuff'), aClu = mk('aClu'), aRad = mk('aRad');
    geo.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uCloud: { value: new THREE.Color(this.atmo.cloud) }, uNight: { value: this.atmo.night ? 1 : 0 } },
      transparent: true, depthWrite: false, premultipliedAlpha: true,
      vertexShader: `attribute vec4 aPuff; attribute vec4 aClu; attribute vec4 aRad;
        varying vec2 vC; varying vec4 vPuff; varying vec4 vClu; varying vec4 vRad; varying vec3 vRight; varying vec3 vUp;
        void main() {
          vC = position.xy; vPuff = aPuff; vClu = aClu; vRad = aRad;
          vRight = vec3(viewMatrix[0].x, viewMatrix[1].x, viewMatrix[2].x);
          vUp = vec3(viewMatrix[0].y, viewMatrix[1].y, viewMatrix[2].y);
          vec3 w = aPuff.xyz + (vRight * position.x + vUp * position.y) * aPuff.w;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
        }`,
      fragmentShader: `varying vec2 vC; varying vec4 vPuff; varying vec4 vClu; varying vec4 vRad; varying vec3 vRight; varying vec3 vUp;
        uniform sampler2D uDetail; uniform vec3 uSunCol; uniform vec3 uAmb; uniform vec3 uZenith; uniform vec3 uCloud;
        uniform float uTime; uniform float uNight;
        ${FOG_GLSL}
        void main() {
          float d2 = dot(vC, vC);
          if (d2 > 1.0) discard;
          vec3 toCam = normalize(cameraPosition - vPuff.xyz);
          float zf = sqrt(1.0 - d2);
          vec3 p = vPuff.xyz + (vRight * vC.x + vUp * vC.y + toCam * zf) * vPuff.w;
          // noise erosion: two projections of the tileable detail texture, slowly drifting
          vec2 dr = uTime * vec2(6.0, 2.5);
          float n1 = texture2D(uDetail, (p.xz + dr) / 1500.0 + p.y / 2600.0).r;
          float n2 = texture2D(uDetail, (p.xy + p.zy * 0.7 + dr) / 520.0).g;
          float n3 = texture2D(uDetail, (p.zx - p.y * 0.6 - dr) / 190.0).b;
          float nz = n1 * 0.5 + n2 * 0.33 + n3 * 0.17;
          float dens = (1.0 - d2) * 1.2 - (nz - 0.42) * 1.6 + 0.02;
          // flat-ish base
          dens -= smoothstep(vClu.w + 140.0, vClu.w - 60.0, p.y) * 1.2;
          float a = smoothstep(0.0, 0.6, dens) * 0.97;
          // fade puffs that are right at the camera (fly-through), and very distant ones a touch
          float cd = length(p - cameraPosition);
          a *= smoothstep(vPuff.w * 0.15, vPuff.w * 0.9, cd);
          if (a < 0.004) discard;
          // light path to the sun through the cluster ellipsoid (optical depth)
          vec3 R = vRad.xyz;
          vec3 qo = (p - vClu.xyz) / R, ql = uSunDir / R;
          float qa = dot(ql, ql), qb = 2.0 * dot(qo, ql), qc = dot(qo, qo) - 1.0;
          float disc = qb * qb - 4.0 * qa * qc;
          float t = disc > 0.0 ? max((-qb + sqrt(disc)) / (2.0 * qa), 0.0) : 0.0;
          float T = exp(-t / 620.0);
          float powder = 1.0 - exp(-t / 180.0) * 0.45;
          // cluster-scale normal blended with the puff's sphere normal
          vec3 ns = normalize(vRight * vC.x + vUp * vC.y + toCam * zf);
          vec3 nc = normalize(qo / R);
          vec3 nrm = normalize(ns * 0.3 + nc * 0.7);
          float hgt = clamp((p.y - vClu.w) / (vRad.y * 1.5), 0.0, 1.0);
          float ao = mix(0.62, 1.0, sqrt(hgt)) * mix(0.8, 1.0, nz);
          vec3 v = normalize(p - cameraPosition);
          float mu = dot(v, uSunDir);
          float g = 0.65, hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5) / 12.566;
          float silver = min(hg, 1.2) * 2.4 * (1.0 - a * 0.85) * (0.25 + 0.75 * T);
          float wrapDif = clamp(dot(nrm, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
          vec3 sun = uSunCol * (T * powder * (0.35 + 0.65 * wrapDif) + silver);
          vec3 sky = mix(uAmb * 0.95 + uFogCol * 0.25, uAmb * 0.6 + uZenith * 0.55, nrm.y * 0.5 + 0.5);
          vec3 col = uCloud * (sun * 0.36 + sky * ao * 0.95);
          col = applyFog(col, p);
          gl_FragColor = vec4(col, a);
          ${OUT_GLSL}
          gl_FragColor.rgb *= a;
        }`,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.clouds = { mesh, cl, puffs, aPuff, aClu, aRad, keys: new Float32Array(N), order: new Uint32Array(N).map((_, i) => i),
      fogD: this.uniforms.uFogD.value, fogCol: this.uniforms.uFogCol.value.clone(), whiteout: 0 };
    this.cloudGroup = mesh;
    this.group.add(mesh);
    this.bakeCloudShadows();
    this.updateClouds(0, new THREE.Vector3());
  }

  /**
   * Cloud shadows on the ground: every puff is splatted, projected along the sun onto the y = 0
   * plane, into one texture. The whole cloud field drifts along +x and wraps, so the texture is
   * baked once and just scrolled (it repeats in x with the same period as the wrap).
   */
  bakeCloudShadows() {
    const C = this.clouds, W = 512, H = 512;
    const period = WORLD_SIZE * 1.6, span = WORLD_SIZE * 2.4;      // x wrap length (see updateClouds), z coverage
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const sl = this.uniforms.uSunSlope.value;
    for (const p of C.puffs) {
      const y = p.c.y + p.dy;
      const x = ((p.c.x + p.dx - sl.x * y) / period + 0.5) * W, z = ((p.c.z + p.dz - sl.y * y) / span + 0.5) * H;
      const rx = p.r / period * W * 1.05, rz = p.r / span * H * 1.05;
      for (const ox of [-W, 0, W]) {
        const px = ((x % W) + W) % W + ox;
        if (px < -rx || px > W + rx) continue;
        ctx.save(); ctx.translate(px, z); ctx.scale(rx, rz);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        g.addColorStop(0, 'rgba(255,255,255,0.55)'); g.addColorStop(0.55, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, 6.2832); ctx.fill();
        ctx.restore();
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    C.shadowTex = tex; C.drift = 0;
    this.uniforms.uCloudSh.value = tex;
    const sy = this.sunDir.y;
    const k = Math.max(0, Math.min(1, (sy - 0.03) / 0.22));
    this.uniforms.uCloudP.value.set(0, 1 / period, 1 / span, 0.82 * this.atmo.shadow * k * k * (3 - 2 * k));
  }

  /** Drift, sort back-to-front, refill the instance buffers; fog to white when inside a cloud. */
  updateClouds(dt, cam) {
    const C = this.clouds, lim = WORLD_SIZE * 0.8;
    let inside = 0;
    for (const c of C.cl) {
      c.x += dt * 9; if (c.x > lim) c.x -= lim * 2;       // (bakeCloudShadows relies on this speed and wrap)
      const ex = (cam.x - c.x) / c.rx, ey = (cam.y - c.y) / c.ry, ez = (cam.z - c.z) / c.rz;
      if (cam.y > c.base) inside = Math.max(inside, 1 - Math.min(1, Math.max(0, (Math.sqrt(ex * ex + ey * ey + ez * ez) - 0.45) / 0.35)));
    }
    if (C.shadowTex) { C.drift = (C.drift + dt * 9) % (lim * 2); this.uniforms.uCloudP.value.x = C.drift; }
    const P = C.puffs, keys = C.keys, ord = C.order;
    for (let i = 0; i < P.length; i++) {
      const p = P[i], x = p.c.x + p.dx - cam.x, y = p.c.y + p.dy - cam.y, z = p.c.z + p.dz - cam.z;
      keys[i] = x * x + y * y + z * z;
    }
    ord.sort((a, b) => keys[b] - keys[a]);
    const ap = C.aPuff.array, ac = C.aClu.array, ar = C.aRad.array;
    for (let j = 0; j < ord.length; j++) {
      const p = P[ord[j]], c = p.c, o = j * 4;
      ap[o] = c.x + p.dx; ap[o + 1] = c.y + p.dy; ap[o + 2] = c.z + p.dz; ap[o + 3] = p.r;
      ac[o] = c.x; ac[o + 1] = c.y; ac[o + 2] = c.z; ac[o + 3] = c.base;
      ar[o] = c.rx; ar[o + 1] = c.ry * 1.25; ar[o + 2] = c.rz; ar[o + 3] = 0;
    }
    C.aPuff.needsUpdate = C.aClu.needsUpdate = C.aRad.needsUpdate = true;
    // whiteout: fog the whole world toward lit cloud grey while inside a cloud body
    const w = C.whiteout += (inside - C.whiteout) * Math.min(1, dt * 4);
    if (w > 0.001 || this._wasWhite) {
      this._wasWhite = w > 0.001;
      const k = w * w * (3 - 2 * w);
      this.uniforms.uFogD.value = C.fogD + (0.009 * Math.exp(Math.max(cam.y, 0) / 1700) / 1.2 - C.fogD) * k;
      this.uniforms.uFogCol.value.copy(C.fogCol).lerp(_cloudGrey.set(this.atmo.night ? 0x2a3040 : this.atmo.cloud).multiplyScalar(0.8), k);
      this.scene.fog.density = this.uniforms.uFogD.value;
      this.scene.fog.color.copy(this.uniforms.uFogCol.value);
    }
  }

  /* ---------- airfields ---------- */
  makeRunwayTexture() {
    const c = document.createElement('canvas'); c.width = 128; c.height = 2048;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#4b4d50'; ctx.fillRect(0, 0, 128, 2048);
    for (let i = 0; i < 2600; i++) {
      const v = 58 + Math.random() * 44;
      ctx.fillStyle = `rgba(${v},${v},${v + 3},0.35)`;
      ctx.fillRect(Math.random() * 128, Math.random() * 2048, 1 + Math.random() * 3, 2 + Math.random() * 14);
    }
    ctx.fillStyle = 'rgba(15,15,15,0.5)'; // tyre marks in the touchdown zones
    for (const y0 of [150, 1640]) for (let i = 0; i < 40; i++) ctx.fillRect(40 + Math.random() * 44, y0 + Math.random() * 260, 2, 30 + Math.random() * 80);
    ctx.fillStyle = '#e9e9e4';
    ctx.fillRect(5, 0, 2, 2048); ctx.fillRect(121, 0, 2, 2048);
    for (let y = 130; y < 1920; y += 64) ctx.fillRect(63, y, 2, 34);
    for (const y0 of [14, 2048 - 14 - 46]) for (let x = 14; x < 114; x += 9) ctx.fillRect(x, y0, 5, 46);
    for (const y0 of [230, 330, 1700, 1800]) { ctx.fillRect(34, y0, 12, 30); ctx.fillRect(82, y0, 12, 30); }
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = Math.min(8, this.engine.renderer.capabilities.getMaxAnisotropy());
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /**
   * Runway designation + direction-arrow decal (spec 3.1b): one 256x64 canvas per number — the
   * number in the left half, an up-pointing arrow in the right half. The runway texture is 128 px
   * wide (~4 px/m), too coarse for "27", so the numbers live on separate decal planes. Built once
   * per number and shared by every airfield (this._markTex); see dispose().
   */
  makeRunwayMarking(num) {
    if (!this._markTex) this._markTex = {};
    const key = String(num).padStart(2, '0');
    if (this._markTex[key]) return this._markTex[key];
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#e9e9e4';                                   // same paint as the baked runway lines
    ctx.font = 'bold 54px monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(key, 64, 36);
    ctx.fillRect(180, 34, 24, 26);                               // arrow shaft (points up = direction of travel)
    ctx.beginPath(); ctx.moveTo(192, 4); ctx.lineTo(166, 38); ctx.lineTo(218, 38); ctx.closePath(); ctx.fill();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Math.min(8, this.engine.renderer.capabilities.getMaxAnisotropy());
    this._markTex[key] = t;
    this._sharedTex.push(t);
    return t;
  }

  /** Concrete apron: one tile = 4 x 4 slabs (24 m), with joints, patch repairs and oil stains. */
  makeApronTexture() {
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#8b8a84'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 16; i++) {                       // slab-to-slab tone differences
      const v = 120 + Math.random() * 34;
      ctx.fillStyle = `rgba(${v},${v},${v - 5},0.5)`; ctx.fillRect((i % 4) * 64, (i >> 2) * 64, 64, 64);
    }
    for (let i = 0; i < 2600; i++) {
      const v = 95 + Math.random() * 80;
      ctx.fillStyle = `rgba(${v},${v},${v - 4},0.22)`; ctx.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    ctx.fillStyle = 'rgba(30,28,26,0.16)';
    for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(Math.random() * S, Math.random() * S, 3 + Math.random() * 9, 2 + Math.random() * 5, Math.random() * 3, 0, 6.2832); ctx.fill(); }
    ctx.fillStyle = 'rgba(40,40,40,0.55)';
    for (let k = 0; k < 4; k++) { ctx.fillRect(k * 64, 0, 1.5, S); ctx.fillRect(0, k * 64, S, 1.5); }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = Math.min(8, this.engine.renderer.capabilities.getMaxAnisotropy());
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  buildAirfields() {
    const rwTex = this.makeRunwayTexture();
    // Lambert divides by pi while the terrain shader does not: lift the paved surfaces to match the ground around them
    const lift = new THREE.Color(2.5, 2.5, 2.5);
    const rwMat = new THREE.MeshLambertMaterial({ map: rwTex, color: lift, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    const apronMat = new THREE.MeshLambertMaterial({ map: this.makeApronTexture(), color: lift, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    // paved planes get world-scale UVs so the 24 m slab tile is the same size everywhere
    const slab = (w, l) => {
      const g = new THREE.PlaneGeometry(w, l), uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 24, uv.getY(i) * l / 24);
      return g;
    };
    // fill light (linear) so walls facing away from the sun don't go black
    const fill = (hex, k) => new THREE.Color(hex).multiplyScalar(this.atmo.night ? k * 0.15 : k);
    for (const m of [rwMat, apronMat]) this.shadeMat(m);
    // one atlas + one blink material serve all three airfields (shared: see dispose())
    const atlas = this._airAtlas || (this._airAtlas = this.makeSpriteAtlas());
    if (!this._sharedTex.includes(atlas.tex)) this._sharedTex.push(atlas.tex);
    const lampMat = this._lampMat || (this._lampMat = this.makeLampMaterial(atlas));
    // windsock: 3-segment cone on a 6 m pole. There is no wind model in this game, so the sway is
    // a decorative uTime oscillation (~4 deg at 0.7 Hz) around the attachment point — the cone
    // hangs toward -z local (the runway direction), which is why it reads as "pointing downfield"
    const sockGeo = new THREE.CylinderGeometry(0.15, 0.6, 3, 8, 3, true);
    sockGeo.rotateX(Math.PI / 2);                                  // axis along z
    sockGeo.translate(0, 0, -1.5);                                 // top vertex at the pole head
    const sockMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(0xff7a1a).multiplyScalar(lift), side: THREE.DoubleSide });
    sockMat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.uniforms.uTime;
      // sway in object space around the attachment point: rotate y/z by a small angle that grows
      // toward the tail (position.z runs 0 at the pole to -3 at the open end)
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
        { float sw = 0.07 * sin(uTime * 4.4 + position.z) * smoothstep(-1.5, -2.9, position.z);
          float cs = cos(sw), sn = sin(sw);
          transformed.yz = mat2(cs, sn, -sn, cs) * transformed.yz; }`);
    };
    this.shadeMat(sockMat);                                        // last, once (cache key set here)
    const poleMat = this.shadeMat(new THREE.MeshLambertMaterial({ color: 0xc9c5b8, emissive: fill(0xc9c5b8, 0.3) }));
    for (const a of this.airfields) {
      const g = new THREE.Group();
      g.position.set(a.x, a.y, a.z);
      g.rotation.y = -a.heading;
      const rw = new THREE.Mesh(new THREE.PlaneGeometry(a.width, a.length), rwMat);
      rw.rotation.x = -Math.PI / 2; rw.position.y = 0.3; g.add(rw);
      // parallel taxiway + apron on the right-hand side
      const taxi = new THREE.Mesh(slab(24, a.length * 0.9), apronMat);
      taxi.rotation.x = -Math.PI / 2; taxi.position.set(150, 0.25, 0); g.add(taxi);
      for (const z of [-a.length * 0.42, 0, a.length * 0.42]) {
        const link = new THREE.Mesh(slab(130, 24), apronMat);
        link.rotation.x = -Math.PI / 2; link.position.set(85, 0.25, z); g.add(link);
      }
      const apron = new THREE.Mesh(slab(192, 624), apronMat);
      apron.rotation.x = -Math.PI / 2; apron.position.set(255, 0.25, 0); g.add(apron);
      // hangars: arched sheds with slide doors (spec 3.2) — the obstruction beacons above sit on these ridges
      for (let i = 0; i < 4; i++) {
        const hz = -230 + i * 150;
        const hangar = this.makeHangar(a.role, fill);
        hangar.position.z = hz; g.add(hangar);
      }
      g.add(this.makeTower(fill));
      // apron furniture (cones, carts, bowser, floodlight masts) — one merged mesh
      if (this.quality !== 'low') g.add(this.makeApronProps(fill));
      // perimeter fence along the apron's outer edge (med/high: posts + wire; low: wire only)
      const fence = this.makeFence(624);
      fence.rotation.y = Math.PI / 2; fence.position.set(357, 0.25, 0); g.add(fence);
      // windsock: 6 m pole + swaying cone on the apron (decorative — no wind model in this game)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 6, 6), poleMat);
      pole.position.set(300, 3, 360); g.add(pole);
      const sock = new THREE.Mesh(sockGeo, sockMat);
      sock.position.set(300, 6, 360); g.add(sock);
      // designation decals: number + arrow at each end, oriented to the local runway direction (spec 3.1b)
      const hdgDeg = Math.round(((a.heading * 180 / Math.PI) % 360 + 360) % 360);
      for (const [num, z] of [[hdgDeg, -1245], [(hdgDeg + 180) % 360, 1245]]) {
        const decal = new THREE.Mesh(new THREE.PlaneGeometry(42, 10.5),
          new THREE.MeshBasicMaterial({ map: this.makeRunwayMarking(num), transparent: true, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -16 }));
        decal.rotation.x = -Math.PI / 2; decal.position.set(0, 0.32, z); g.add(decal);
      }
      // airfield light system (spec 3.1): one Points draw call per airfield, all blink/phase in the shader
      const L = this.makeAirfieldLightGeometry(a);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
      lg.setAttribute('color', new THREE.BufferAttribute(L.col, 3));
      lg.setAttribute('aSize', new THREE.BufferAttribute(L.size, 1));
      lg.setAttribute('aPhase', new THREE.BufferAttribute(L.phase, 1));
      lg.setAttribute('aRate', new THREE.BufferAttribute(L.rate, 1));
      lg.setAttribute('aQuad', new THREE.BufferAttribute(L.quad, 1));
      // lamps live in airfield-local space: recompute the bounding sphere or a wrong one culls
      // the whole runway lights away as the camera turns (looks like a bug in the blink)
      lg.computeBoundingSphere();
      const lights = new THREE.Points(lg, lampMat);
      g.add(lights);
      this.group.add(g);
    }
  }

  /* ---------- city ---------- */
  /**
   * One facade tile = 4 bays x 4 floors = 14 x 14 m (3.5 m floors). Returns the day texture and a
   * night emissive texture that holds only the lit windows, in the same places.
   */
  makeFacade(style, night) {
    const S = 128, u = S / 4;
    const day = document.createElement('canvas'), nite = document.createElement('canvas');
    day.width = day.height = nite.width = nite.height = S;
    const d = day.getContext('2d'), n = nite.getContext('2d');
    n.fillStyle = '#000'; n.fillRect(0, 0, S, S);
    const rnd = Math.random;
    if (style === 'glass') {
      // curtain wall: tinted glass panes, thin mullions, a spandrel band per floor
      d.fillStyle = '#5d7684'; d.fillRect(0, 0, S, S);
      for (let f = 0; f < 4; f++) for (let b = 0; b < 4; b++) {
        const x = b * u, y = f * u, v = 70 + rnd() * 40;
        d.fillStyle = `rgb(${v * 0.55},${v * 0.8},${v})`; d.fillRect(x + 1, y + 1, u - 2, u - 7);
        d.fillStyle = 'rgba(255,255,255,0.10)'; d.fillRect(x + 1, y + 1, (u - 2) * 0.45, u - 7);
        if (rnd() < 0.45) { n.fillStyle = rnd() < 0.7 ? '#ffe0a0' : '#cfe4ff'; n.fillRect(x + 1, y + 1, u - 2, u - 7); }
      }
      d.fillStyle = '#9aa7ae'; for (let f = 0; f < 4; f++) d.fillRect(0, f * u + u - 6, S, 4);
    } else {
      // masonry / render with punched windows (offices: wide bands, housing: small + balconies)
      const off = style === 'office';
      d.fillStyle = off ? '#b9b7b0' : '#e8e2d6'; d.fillRect(0, 0, S, S);
      for (let i = 0; i < 900; i++) { const v = 150 + rnd() * 90; d.fillStyle = `rgba(${v},${v},${v - 8},0.18)`; d.fillRect(rnd() * S, rnd() * S, 2, 2); }
      for (let f = 0; f < 4; f++) for (let b = 0; b < 4; b++) {
        const x = b * u, y = f * u;
        const [wx, wy, ww, wh] = off ? [x + 3, y + 7, u - 6, u - 14] : [x + 8, y + 8, u - 16, u - 13];
        d.fillStyle = '#d4d0c6'; d.fillRect(wx - 1, wy - 1, ww + 2, wh + 2);
        const v = 38 + rnd() * 30;
        d.fillStyle = `rgb(${v},${v + 8},${v + 16})`; d.fillRect(wx, wy, ww, wh);
        if (!off && rnd() < 0.3) { d.fillStyle = 'rgba(60,55,50,0.55)'; d.fillRect(x + 4, y + u - 6, u - 8, 4); } // balcony
        // night windows: warm low floors, fluorescent office bands (spec 3.3.5)
        if (rnd() < (off ? 0.4 : 0.35)) { n.fillStyle = off && f > 1 ? '#cfe4ff' : rnd() < 0.8 ? '#ffd890' : '#ffeacc'; n.fillRect(wx, wy, ww, wh); }
      }
      if (off) { d.fillStyle = 'rgba(80,80,80,0.25)'; for (let f = 0; f < 4; f++) d.fillRect(0, f * u + u - 3, S, 2); }
    }
    const mk = (c) => {
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; return t;
    };
    return { day: mk(day), night: night ? mk(nite) : null };
  }

  /**
   * Street band (spec 3.3.1): one storey of ground floor as its own 128² texture — plinth 0–0.6 m,
   * shopfront glass 0.6–2.6 m (two ~4 m panes with mullions; office = lobby + reception), fascia
   * 2.6–3.5 m. The night version holds only the lit windows and one lit lobby. Sampled pinned to
   * vBaseH in the tileUv hook — never tiled vertically, so shopfronts can't climb up a tower.
   */
  makeStreetBand(style) {
    const S = 128, ppm = S / 3.5;                       // pixels per metre; canvas bottom = street level
    const day = document.createElement('canvas'), nite = document.createElement('canvas');
    day.width = day.height = nite.width = nite.height = S;
    const d = day.getContext('2d'), n = nite.getContext('2d');
    n.fillStyle = '#000'; n.fillRect(0, 0, S, S);
    const y = (m) => S - m * ppm;                       // metres above the street → canvas y
    const rnd = Math.random;
    const off = style === 'office', gls = style === 'glass';
    // plinth 0–0.6 m
    d.fillStyle = off ? '#8f8d88' : gls ? '#7e848a' : '#9a8f80';
    d.fillRect(0, y(0.6), S, S - y(0.6));
    for (let i = 0; i < 240; i++) { const v = 100 + rnd() * 70; d.fillStyle = `rgba(${v},${v},${v},0.15)`; d.fillRect(rnd() * S, y(0.6), 2, S - y(0.6)); }
    // shopfront glass 0.6–2.6 m: two ~4 m panes with a centre mullion (office = lobby + reception)
    const gx = off ? 8 : 12, gw = off ? 52 : 46;
    for (const px of [gx, S - gx - gw]) {
      d.fillStyle = gls ? '#6d8896' : '#3a4a52';
      d.fillRect(px, y(2.6), gw, y(0.6) - y(2.6));
      d.fillStyle = off ? '#b9b7b0' : '#8a8f94';
      d.fillRect(px + (off ? 27 : 22), y(2.6), 3, y(0.6) - y(2.6));           // centre mullion
      d.fillStyle = 'rgba(255,255,255,0.18)';
      d.fillRect(px + 2, y(2.4), (gw - 5) * 0.45, y(1.2) - y(2.4));           // glass reflection sweep
      if (off) { d.fillStyle = 'rgba(255,230,180,0.22)'; d.fillRect(px + 2, y(1.5), gw - 4, y(0.9)); }  // lobby glow hint
      if (rnd() < (off ? 0.8 : 0.6)) { n.fillStyle = off ? '#ffe9c0' : '#ffd890'; n.fillRect(px, y(2.55), gw, y(0.7)); }
    }
    // fascia 2.6–3.5 m, with a sign strip for the non-glass styles
    d.fillStyle = off ? '#b9b7b0' : gls ? '#9aa7ae' : '#c8bfae';
    d.fillRect(0, 0, S, y(2.6));
    if (!gls) { d.fillStyle = 'rgba(45,45,52,0.35)'; d.fillRect(14, y(3.2), S - 28, y(2.85)); }
    const mk = (c) => {
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; return t;
    };
    return { day: mk(day), night: mk(nite) };
  }

  buildCity() {
    const city = this.hf.city;
    if (!city) return;
    const night = this.atmo.night || this.atmo.sunElev < 6;
    // Box UVs are 0..1 per face: rescale them per instance so the 14 m facade tile repeats at true size.
    // One hook factory per style (named, so three.js keeps separate programs — shadeMat's key would
    // otherwise make every facade material share one program).
    const tileUv = (st, band) => {
      // onBeforeCompile runs with the renderer as `this`, so the band textures come from a closure.
      // The three styles share one hook name on purpose: their GLSL is identical and only the uniform
      // VALUES differ per material, so 'shade+cityFacadeTile' compiles once for all of them.
      return function cityFacadeTile(sh) {
        sh.uniforms.uStreetMap = band.day;
        sh.uniforms.uStreetNight = band.night;
        sh.vertexShader = 'attribute vec2 aFacade;\nvarying float vBaseH;\nvarying float vSide;\n' +
          sh.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
            vBaseH = 99.0; vSide = 1.0;
            #ifdef USE_INSTANCING
              vec3 isc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
              vBaseH = uv.y * isc.y - 2.0;            // metres above the street (boxes start 2 m below it)
              vSide = step(0.5, abs(normal.y));       // side faces only (top/bottom box UVs differ)
              vec2 tuv = vec2((abs(normal.x) > 0.5 ? isc.z : isc.x) / 14.0, isc.y / 14.0);
              #ifdef USE_MAP
                vMapUv *= tuv + aFacade;              // per-instance tile offset: no two towers share lit windows
              #endif
              #ifdef USE_EMISSIVEMAP
                vEmissiveMapUv *= tuv + aFacade;
              #endif
            #endif`);
        sh.fragmentShader = 'uniform sampler2D uStreetMap;\nuniform sampler2D uStreetNight;\nvarying float vBaseH;\nvarying float vSide;\n' +
          sh.fragmentShader.replace('#include <color_fragment>',
            `#include <color_fragment>
             diffuseColor.rgb *= mix(0.5, 1.0, smoothstep(0.0, 5.0, vBaseH));`);
        // street band (spec 3.3.1): step() mixes in the ground-floor texture for the bottom storey.
        // Both fetches stay unconditional — no divergence between the 3.5 m strip and the 90 m above;
        // aFacade.x (u) applies to the band too, but its v is pinned to vBaseH, never to a tile index.
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>',
          `#include <map_fragment>
           float gf = step(vBaseH, 3.5) * vSide;
           vec4 sb = texture2D(uStreetMap, vec2(vMapUv.x, clamp(vBaseH / 3.5, 0.0, 1.0)));
           diffuseColor.rgb = mix(diffuseColor.rgb, sb.rgb, gf);`);
        sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           totalEmissiveRadiance = mix(totalEmissiveRadiance, texture2D(uStreetNight, vec2(vMapUv.x, clamp(vBaseH / 3.5, 0.0, 1.0))).rgb * emissive, step(vBaseH, 3.5) * vSide);`);
      };
    };
    // roof texture: slab tone + a soft shadow line around the edge (the parapet's cast shadow)
    const rc = document.createElement('canvas'); rc.width = rc.height = 64;
    const rctx = rc.getContext('2d');
    rctx.fillStyle = '#8a8d90'; rctx.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 300; i++) { const v = 120 + Math.random() * 50; rctx.fillStyle = `rgba(${v},${v},${v},0.2)`; rctx.fillRect(Math.random() * 64, Math.random() * 64, 2, 2); }
    rctx.strokeStyle = 'rgba(30,32,34,0.5)'; rctx.lineWidth = 3; rctx.strokeRect(1.5, 1.5, 61, 61);
    const roofTex = new THREE.CanvasTexture(rc);
    roofTex.colorSpace = THREE.SRGBColorSpace;
    this._sharedTex.push(roofTex);
    const roofMat = this.shadeMat(new THREE.MeshLambertMaterial({ map: roofTex }));
    const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, 0.5, 0);
    const styles = {};
    // real maps: districts of a whole metro area instead of one 1.15 km town
    const urban = this.map.urban, real = !!(urban && this.hf.zones);
    const target = real ? (this.quality === 'low' ? 1000 : this.quality === 'high' ? 5200 : 2200) : (this.quality === 'low' ? 320 : 820);
    // plus whole street blocks built out around them (see the fill pass below)
    const fillMax = real ? (this.quality === 'low' ? 1200 : this.quality === 'high' ? 9000 : 3000) : 0;
    for (const st of ['glass', 'office', 'res']) {
      const tex = this.makeFacade(st, night);
      const band = this.makeStreetBand(st);
      // glass towers are PBR so the curtain wall reflects the sky (scene.environment)
      const mat = st === 'glass'
        ? new THREE.MeshStandardMaterial({ map: tex.day, color: new THREE.Color(1.35, 1.35, 1.35), roughness: 0.16, metalness: 0.55, envMapIntensity: 1.1 })
        : new THREE.MeshLambertMaterial({ map: tex.day });
      // fill light on the walls facing away from the sun (bounce from the ground and the street);
      // at night the emissive map holds only the lit windows
      if (night) { mat.emissiveMap = tex.night; mat.emissive = new THREE.Color(0xc8a060); } else { mat.emissiveMap = tex.day; mat.emissive = new THREE.Color().setRGB(0.42, 0.43, 0.45); }
      this._sharedTex.push(band.day, band.night);
      mat.onBeforeCompile = tileUv(st, band);
      this.shadeMat(mat);
      const max = real ? target + fillMax : this.quality === 'low' ? 260 : 700;
      // the spec's "one attribute on the shared BoxGeometry" cannot work: three InstancedMeshes
      // each read their instances from index 0 of the same attribute, so they would overwrite
      // each other. One clone of the box per style carries its own aFacade (8 B/instance).
      const stGeo = geo.clone();
      stGeo.setAttribute('aFacade', new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2));
      const mesh = new THREE.InstancedMesh(stGeo, [mat, mat, roofMat, roofMat, mat, mat], max);
      mesh.count = 0; mesh.frustumCulled = false;
      styles[st] = mesh;
      this.group.add(mesh);
    }
    // hard instance limits (put() silently stops when full): parapets + AC plant + huts + tanks +
    // antennas average ~3.2 instances per building, so the spec's 500/1400 is not enough — sized
    // for ~320/820 buildings at ~4 each (parapets are added first, so they keep priority)
    const extras = new THREE.InstancedMesh(geo, roofMat, real ? target * 4 : this.quality === 'low' ? 1200 : 3200);
    extras.count = 0; extras.frustumCulled = false;
    // gable roofs for the low residential: one shared prism geometry, scaled per instance
    // measured ~150 (low) / ~460 (med+) low houses per city; the guard below is the real limit —
    // drawing count > capacity reads past the instance buffer and renders screen-filling spikes
    // (real maps tint them: Paris' blue-grey zinc mansards, New York's brownstone-era tar and slate)
    const gableMat = urban && urban.roofCol
      ? this.shadeMat(new THREE.MeshLambertMaterial({ map: roofTex, color: new THREE.Color(...urban.roofCol).multiplyScalar(1.6) })) : roofMat;
    const gables = new THREE.InstancedMesh(GABLE_GEO, gableMat, real ? target + fillMax : this.quality === 'low' ? 240 : 640);
    gables.count = 0; gables.frustumCulled = false;
    this.group.add(extras);
    this.group.add(gables);

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    // every box is recorded as a part so buildings can be damaged and later restored
    let parts = null;
    const put = (mesh, x, y, z, w, h, dd, c) => {
      if (mesh.count >= mesh.instanceMatrix.count) return false;
      p.set(x, y, z); sc.set(w, h, dd); m.compose(p, q, sc);
      mesh.setMatrixAt(mesh.count, m);
      if (c) mesh.setColorAt(mesh.count, c);
      const afAttr = mesh.geometry.attributes.aFacade;                             // per-instance window variation (3.3.2)
      if (afAttr) {
        const i = mesh.count * 2, arr = afAttr.array;
        arr[i] = Math.floor(Math.random() * 14) / 14 + Math.random() * 0.06;       // >= 1 tile apart, random sub-tile
        arr[i + 1] = Math.floor(Math.random() * 14) / 14;
      }
      if (parts) parts.push({ mesh, i: mesh.count, x, y, z, w, h, d: dd, col: c ? c.clone() : null });
      mesh.count++;
      return true;
    };
    const extra = (x, y, z, w, h, dd) => put(extras, x, y, z, w, h, dd, null);
    this.buildings = [];
    this.bgrid = new Map();
    const snap = (v) => Math.max(1, Math.round(v / 3.5)) * 3.5;
    const houses = this.map.houses;
    // a coarse occupancy grid keeps footprints from overlapping
    const CELL = 15, used = new Set();
    const free = (x0, z0, x1, z1, mark) => {
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++)
        for (let k = Math.floor(z0 / CELL); k <= Math.floor(z1 / CELL); k++) {
          const key = i * 100003 + k;
          if (mark) used.add(key); else if (used.has(key)) return false;
        }
      return true;
    };
    let n = 0;
    const beacons = [];                                                   // h > 60 m roofs (spec 3.3.6)
    const hf = this.hf;
    // occupancy: the legacy town uses a 15 m world-axis grid; rotated grids rasterise each footprint
    // (plus a 2 m gap) onto an 8 m world grid so neighbouring cells of different angles can't overlap
    const OC = real ? 8 : CELL;
    const occ = (bx, bz, hw, hd, ca, sa, mark) => {
      const ex = hw * Math.abs(ca) + hd * Math.abs(sa) + 2, ez = hw * Math.abs(sa) + hd * Math.abs(ca) + 2;
      for (let i = Math.floor((bx - ex) / OC); i <= Math.floor((bx + ex) / OC); i++)
        for (let k = Math.floor((bz - ez) / OC); k <= Math.floor((bz + ez) / OC); k++) {
          const dx = (i + 0.5) * OC - bx, dz = (k + 0.5) * OC - bz;
          if (Math.abs(dx * ca + dz * sa) > hw + 2 + OC * 0.5 || Math.abs(dz * ca - dx * sa) > hd + 2 + OC * 0.5) continue;
          const key = i * 100003 + k;
          if (mark) used.add(key); else if (used.has(key)) return false;
        }
      return true;
    };
    // landmarks first: their footprints (and bridge ramps, the Etoile, the Tuileries) stay clear
    if (real && this.map.landmarks) {
      const lm = buildLandmarks(this);
      for (const f of lm.footprints) occ(f.x, f.z, f.hw, f.hd, f.ca, f.sa, true);
      for (const b of lm.colliders) { this.buildings.push(b); this.gridBuilding(b); }
      this.landmarkCount = lm.colliders.length;
    }
    const zones = real ? hf.zones : null, shareSum = real ? zones.reduce((a, z) => a + z.share, 0) : 0;
    const pickW = (obj) => { let t = Math.random() * Object.values(obj).reduce((a, b) => a + b, 0); for (const k in obj) { t -= obj[k]; if (t <= 0) return k; } return Object.keys(obj)[0]; };
    for (let tries = 0; tries < target * (real ? 14 : 6) && n < target; tries++) {
      let style, w, dd, bx, bz, floors, core, ang = 0;
      if (!real) {
        const a0 = Math.random() * 6.283, r = Math.sqrt(Math.random()) * city.r * 0.97;
        core = 1 - r / city.r;
        style = core > 0.62 && Math.random() < 0.75 ? 'glass' : core > 0.3 && Math.random() < 0.7 ? 'office' : 'res';
        const big = style === 'glass' ? 24 + Math.random() * 18 : style === 'office' ? 18 + Math.random() * 20 : 10 + Math.random() * 14;
        w = snap(big); dd = snap(big * (0.7 + Math.random() * 0.5));
        // stay inside the shader's 120 m blocks (streets are the outer ~10 m of each block)
        const bxC = Math.floor((city.x + Math.cos(a0) * r) / 120) * 120, bzC = Math.floor((city.z + Math.sin(a0) * r) / 120) * 120;
        bx = bxC + 12 + w / 2 + Math.random() * Math.max(0, 96 - w); bz = bzC + 12 + dd / 2 + Math.random() * Math.max(0, 96 - dd);
        if (style === 'glass') floors = 10 + Math.round(Math.random() * 10 + core * core * Math.random() * 45);
        else if (style === 'office') floors = 4 + Math.round(Math.random() * 6 + core * Math.random() * 8);
        else floors = 2 + Math.round(Math.random() * (core > 0.3 ? 5 : 3));
      } else {
        // a district by its share of the budget, a point in it, kept with the district's weight there
        let t = Math.random() * shareSum, zn = zones[0];
        for (const z of zones) { t -= z.share; if (t <= 0) { zn = z; break; } }
        let x, z;
        if (zn.pts.length === 1) { const a0 = Math.random() * 6.283, r = Math.sqrt(Math.random()) * zn.r; x = zn.pts[0][0] + Math.cos(a0) * r; z = zn.pts[0][1] + Math.sin(a0) * r; }
        else {
          let l = Math.random() * zn.len, k = 0;
          while (k < zn.pts.length - 2) { const sl = Math.hypot(zn.pts[k + 1][0] - zn.pts[k][0], zn.pts[k + 1][1] - zn.pts[k][1]); if (l < sl) break; l -= sl; k++; }
          const [ax, az] = zn.pts[k], [bx2, bz2] = zn.pts[k + 1], sl = Math.hypot(bx2 - ax, bz2 - az) || 1;
          const a0 = Math.random() * 6.283, r = Math.sqrt(Math.random()) * zn.r;
          x = ax + (bx2 - ax) * l / sl + Math.cos(a0) * r; z = az + (bz2 - az) * l / sl + Math.sin(a0) * r;
        }
        core = hf.zoneWeight(zn, x, z);
        if (Math.random() > core || hf.real.at(x, z) !== 1 || hf.urbanGround(x, z) < 0.3) continue;
        style = pickW(zn.mix);
        const fr = zn.floors[style];
        floors = Math.round(fr[0] + (fr[1] - fr[0]) * Math.pow(Math.random(), style === 'res' ? 1 : 1.7) * (0.55 + 0.45 * core));
        const sz = zn.size || 1;
        const big = (style === 'glass' ? 26 + Math.random() * 20 : style === 'office' ? 20 + Math.random() * 22 : 12 + Math.random() * 16) * sz;
        // snap into a block of the local street grid (u across the avenues, v along them)
        ang = hf.gridAngle(x, z);
        const ca = Math.cos(ang), sa = Math.sin(ang), [BU, BV] = urban.block;
        const mu = urban.street[0] / 2 + 3, mv = urban.street[1] / 2 + 3;
        w = Math.min(snap(big), BU - 2 * mu); dd = Math.min(snap(big * (0.7 + Math.random() * 0.5)), BV - 2 * mv);
        const u = x * ca + z * sa, v = x * sa - z * ca;
        const u0 = Math.floor(u / BU) * BU, v0 = Math.floor(v / BV) * BV;
        const bu = u0 + mu + w / 2 + Math.random() * Math.max(0, BU - 2 * mu - w), bv = v0 + mv + dd / 2 + Math.random() * Math.max(0, BV - 2 * mv - dd);
        bx = bu * ca + bv * sa; bz = bu * sa - bv * ca;
      }
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // local footprint offsets -> world (local x along u, local z along -v)
      const at = (ox, oz) => [bx + ox * ca - oz * sa, bz + ox * sa + oz * ca];
      if (real ? !occ(bx, bz, w / 2, dd / 2, ca, sa, false) : !free(bx - w / 2, bz - dd / 2, bx + w / 2, bz + dd / 2, false)) continue;
      const c0 = at(-w / 2, -dd / 2), c1 = at(w / 2, dd / 2);
      const gy = Math.min(hf.height(c0[0], c0[1]), hf.height(c1[0], c1[1]), hf.height(bx, bz));
      if (gy < (real ? 1.5 : 4)) continue;
      if (real && (hf.real.at(c0[0], c0[1]) === 0 || hf.real.at(c1[0], c1[1]) === 0)) continue;
      q.setFromAxisAngle(_yAxis, -ang);
      const h = floors * 3.5, y0 = gy - 2;
      if (style === 'glass') col.setHSL(0.55 + Math.random() * 0.08, 0.15, 0.8 + Math.random() * 0.2);
      else if (style === 'office') { const v = 0.75 + Math.random() * 0.25; col.setRGB(v, v * 0.98, v * 0.95); }
      else col.setHex(houses[Math.floor(Math.random() * houses.length)]).multiplyScalar(0.9 + Math.random() * 0.15);
      parts = [];
      if (!put(styles[style], bx, y0, bz, w, h + 2, dd, col)) { parts = null; continue; }
      if (real) occ(bx, bz, w / 2, dd / 2, ca, sa, true); else free(bx - w / 2, bz - dd / 2, bx + w / 2, bz + dd / 2, true);
      n++;
      const hp = style === 'glass' ? 420 : style === 'office' ? 160 + floors * 12 : 55 + floors * 12;
      const b = { x: bx, z: bz, hw: w / 2, hd: dd / 2, ca, sa, q: ang ? q.clone() : null, y0, top: y0 + h + 2, top0: y0 + h + 2, style, floors, hp, hp0: hp, parts, state: 0 };
      this.buildings.push(b);
      this.gridBuilding(b);
      const top = y0 + h + 2;
      // a random point on the roof, `m` metres in from the edges (local footprint frame)
      const onRoof = (mw, md) => at((Math.random() - 0.5) * Math.max(0, w - mw), (Math.random() - 0.5) * Math.max(0, dd - md));
      // parapet: one rim slab slightly proud of the roof edge (the spec's 4-sided inset wall costs 4
      // instances/building and would eat the whole extras budget — a rim reads the same from above)
      extra(bx, top - 0.1, bz, w + 0.6, 0.5, dd + 0.6);
      if (style === 'glass' && floors > 18 && Math.random() < 0.6) {
        // setback crown (1-2 setbacks), sometimes with a mast
        const w2 = snap(w * 0.68), d2 = snap(dd * 0.68), h2 = (3 + Math.round(Math.random() * 8)) * 3.5;
        put(styles.glass, bx, top, bz, w2, h2, d2, col);
        let t2 = top + h2;
        if (floors > 30 && Math.random() < 0.5) {
          const w3 = snap(w2 * 0.6), d3 = snap(d2 * 0.6), h3 = (2 + Math.round(Math.random() * 4)) * 3.5;
          put(styles.glass, bx, t2, bz, w3, h3, d3, col);
          t2 += h3;
        }
        if (Math.random() < 0.5) extra(bx, t2, bz, 0.8, 10 + Math.random() * 22, 0.8);
        else extra(bx, t2, bz, w2 * 0.5, 3, d2 * 0.5);
      } else if (style === 'office' && floors > 6) {
        // cornice slab + lifted penthouse box (no two adjacent offices share a silhouette)
        extra(bx, top - 0.15, bz, w + 1.2, 0.4, dd + 1.2);
        if (Math.random() < 0.6) {
          const pw = snap(w * 0.4), pd = snap(dd * 0.4), ph = 3.5;
          const [px, pz] = at((w - pw) / 4, (dd - pd) / 4);
          put(styles.office, px, top, pz, pw, ph, pd, col);
        }
      } else if (style === 'res' && (urban && urban.roof === 'all' || floors <= 4) && !(urban && urban.roof === 'none')) {
        // pitched gable roof on the low houses (shared prism, scaled to the footprint); Paris: every
        // block gets its zinc mansard. Recorded as a part, so it falls with the house.
        put(gables, bx, top - 0.1, bz, w + 0.8, (urban && urban.roofH) || 1, dd + 0.8, null);
      }
      // rooftop plant: AC units (as before), plus an access hut / stair bulkhead and, on ~30 %,
      // a water tank or lattice antenna (spec 3.3.3) — all in extras, unrecorded like the old plant
      const k = style === 'res' ? (Math.random() < 0.4 ? 1 : 0) : 1 + Math.floor(Math.random() * 2);
      for (let i = 0; i < k; i++) {
        const ew = 2 + Math.random() * (style === 'res' ? 2 : 5), ed = 2 + Math.random() * 4;
        const [ex, ez] = onRoof(ew + 1, ed + 1);
        extra(ex, top, ez, ew, 1.6 + Math.random() * 2.5, ed);
      }
      if (Math.random() < 0.5) { const [ex, ez] = onRoof(6, 6); extra(ex, top, ez, 2.4, 2.2, 2.4); }
      if (style !== 'res' && Math.random() < 0.3) {
        const tw = 2.5 + Math.random() * 3;
        const [tx, tz] = onRoof(tw + 2, tw + 2), [ax, az] = onRoof(3, 3);
        extra(tx, top, tz, tw, 2.4 + Math.random() * 2, tw); // tank
        extra(ax, top, az, 0.6, 6 + Math.random() * 8, 0.6);   // antenna
      }
      if (h > 60) beacons.push([bx, top + (style === 'glass' && floors > 18 ? 4 : 1.5), bz]);
    }
    if (real) this.fillBlocks({ zones, urban, fillMax, styles, gables, extra, put, occ, houses, snap, col, q, setParts: (v) => (parts = v), getParts: () => parts });
    q.identity();
    parts = null;
    for (const mesh of Object.values(styles)) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.cityMeshes = [...Object.values(styles), extras, gables];
    // obstruction beacons on the h > 60 m roofs: one Points for the whole city, world-space
    if (beacons.length && this.quality !== 'low') {
      const atlas = this._airAtlas || (this._airAtlas = this.makeSpriteAtlas());
      if (!this._sharedTex.includes(atlas.tex)) this._sharedTex.push(atlas.tex);
      const bMat = this._beaconMat || (this._beaconMat = this.makeBeaconMaterial(atlas));
      const pos = new Float32Array(beacons.length * 3), size = new Float32Array(beacons.length),
        phase = new Float32Array(beacons.length), rate = new Float32Array(beacons.length), quad = new Uint8Array(beacons.length);
      beacons.forEach(([x, y, z], i) => {
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
        size[i] = 22; phase[i] = Math.random(); rate[i] = 1.0; quad[i] = 1;   // halo, 1 Hz, random phase
      });
      const bg = new THREE.BufferGeometry();
      bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      bg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      bg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
      bg.setAttribute('aRate', new THREE.BufferAttribute(rate, 1));
      bg.setAttribute('aQuad', new THREE.BufferAttribute(quad, 1));
      bg.computeBoundingSphere();
      this.group.add(new THREE.Points(bg, bMat));
    }
  }

  /**
   * Real maps: build out whole street blocks in districts with a `fill` rule (Manhattan mid-rise,
   * Haussmann Paris, terraced London) — each block split into a few frontages of differing height,
   * nearest the city centre first until the budget runs out. Towers placed earlier keep their plots.
   */
  fillBlocks(o) {
    const hf = this.hf, { urban, styles, gables, put, occ, col, q } = o;
    const [BU, BV] = urban.block, mu = urban.street[0] / 2 + 3, mv = urban.street[1] / 2 + 3;
    const city = hf.city, blocks = new Map();
    for (const zn of o.zones) {
      if (!zn.fill) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [px, pz] of zn.pts) { x0 = Math.min(x0, px - zn.r); x1 = Math.max(x1, px + zn.r); z0 = Math.min(z0, pz - zn.r); z1 = Math.max(z1, pz + zn.r); }
      const step = Math.min(BU, BV) * 0.45;
      for (let z = z0; z <= z1; z += step) for (let x = x0; x <= x1; x += step) {
        const w = hf.zoneWeight(zn, x, z);
        if (w < 0.4 || hf.real.at(x, z) !== 1) continue;
        const ang = hf.gridAngle(x, z), ca = Math.cos(ang), sa = Math.sin(ang);
        const u0 = Math.floor((x * ca + z * sa) / BU), v0 = Math.floor((x * sa - z * ca) / BV);
        const key = `${ang.toFixed(4)}|${u0}|${v0}`;
        if (blocks.has(key)) continue;
        const d = Math.hypot(x - city.x, z - city.z) * (zn.fill.far || 1) - w * 600;
        blocks.set(key, { ang, ca, sa, u0, v0, d, zn });
      }
    }
    const list = [...blocks.values()].sort((a, b) => a.d - b.d);
    const W = BU - 2 * mu, D = BV - 2 * mv;
    let made = 0;
    for (const bl of list) {
      if (made >= o.fillMax) break;
      const f = bl.zn.fill, { ca, sa } = bl;
      // frontage widths along the block (u), with 1-3 m gaps between buildings
      const k = f.parts[0] + Math.floor(Math.random() * (f.parts[1] - f.parts[0] + 1));
      const cuts = [0, ...Array.from({ length: k - 1 }, () => 0.2 + Math.random() * 0.6).sort(), 1].map((t, i, a) => i && i < a.length - 1 ? (i / (a.length - 1)) * 0.6 + t * 0.4 : t);
      const rows = D > 50 && Math.random() < 0.5 ? 2 : 1;            // deep blocks: back-to-back rows round a yard
      for (let r = 0; r < rows; r++) for (let i = 0; i < k; i++) {
        const gap = 1 + Math.random() * 2;
        const w = (cuts[i + 1] - cuts[i]) * W - gap, dd = rows === 2 ? D * (0.32 + Math.random() * 0.1) : D * (0.75 + Math.random() * 0.25);
        if (w < 8) continue;
        const bu = bl.u0 * BU + mu + (cuts[i] + cuts[i + 1]) / 2 * W;
        const bv = bl.v0 * BV + mv + (rows === 2 ? (r ? D - dd / 2 : dd / 2) : D / 2);
        const bx = bu * ca + bv * sa, bz = bu * sa - bv * ca;
        if (!occ(bx, bz, w / 2, dd / 2, ca, sa, false)) continue;
        const at = (ox, oz) => [bx + ox * ca - oz * sa, bz + ox * sa + oz * ca];
        const c0 = at(-w / 2, -dd / 2), c1 = at(w / 2, dd / 2), c2 = at(w / 2, -dd / 2), c3 = at(-w / 2, dd / 2);
        if ([c0, c1, c2, c3].some(([x, z]) => hf.real.at(x, z) !== 1)) continue;
        const gy = Math.min(hf.height(c0[0], c0[1]), hf.height(c1[0], c1[1]), hf.height(c2[0], c2[1]), hf.height(c3[0], c3[1]));
        if (gy < 1.5 || hf.urbanGround(bx, bz) < 0.3) continue;
        let style = 'res', t = Math.random() * Object.values(f.mix).reduce((a, b) => a + b, 0);
        for (const s in f.mix) { t -= f.mix[s]; if (t <= 0) { style = s; break; } }
        const floors = f.floors[0] + Math.floor(Math.random() * (f.floors[1] - f.floors[0] + 1));
        const h = floors * 3.5, y0 = gy - 2, ang = bl.ang;
        q.setFromAxisAngle(_yAxis, -ang);
        if (style === 'office') { const v = 0.72 + Math.random() * 0.25; col.setRGB(v, v * 0.98, v * 0.94); }
        else col.setHex(o.houses[Math.floor(Math.random() * o.houses.length)]).multiplyScalar(0.88 + Math.random() * 0.17);
        const parts = [];
        o.setParts(parts);
        if (!put(styles[style], bx, y0, bz, w, h + 2, dd, col)) { o.setParts(null); return; }
        occ(bx, bz, w / 2, dd / 2, ca, sa, true);
        made++;
        const hp = style === 'office' ? 160 + floors * 12 : 55 + floors * 12, top = y0 + h + 2;
        const b = { x: bx, z: bz, hw: w / 2, hd: dd / 2, ca, sa, q: q.clone(), y0, top, top0: top, style, floors, hp, hp0: hp, parts, state: 0 };
        this.buildings.push(b);
        this.gridBuilding(b);
        if (style === 'res' && (urban.roof === 'all' || floors <= 4) && urban.roof !== 'none') put(gables, bx, top - 0.1, bz, w + 0.8, urban.roofH || 1, dd + 0.8, null);
        else o.extra(bx, top - 0.1, bz, w + 0.6, 0.5, dd + 0.6);
        if (Math.random() < 0.35) { const [ex, ez] = at((Math.random() - 0.5) * (w - 5), (Math.random() - 0.5) * (dd - 5)); o.extra(ex, top, ez, 2 + Math.random() * 3, 1.6 + Math.random() * 2, 2 + Math.random() * 3); }
      }
    }
    o.setParts(null);
    this.filledBlocks = made;
  }

  /** Full-resolution heightfield as a half-float texture for per-pixel terrain normals (WebGL2). */
  makeHeightTexture() {
    const caps = this.engine.renderer.capabilities;
    if (!caps.isWebGL2) { this.heightTex = null; return null; }
    const hf = this.hf, n = GRID + 1, data = new Uint16Array(n * n);
    for (let i = 0; i < n * n; i++) data[i] = THREE.DataUtils.toHalfFloat(hf.h[i]);
    const t = new THREE.DataTexture(data, n, n, THREE.RedFormat, THREE.HalfFloatType);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    this.heightTex = t;
    return t;
  }

  /* ---------- baked city shadows ---------- */
  initCityShadows() {
    const city = this.hf.city, S = city && city.real && this.quality !== 'low' ? 2048 : 1024;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const tex = new THREE.CanvasTexture(c);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
    const size = city ? (city.real ? 15000 : city.r * 2 + 900) : 1;
    this.cityShadow = { canvas: c, ctx: c.getContext('2d'), tex, S, box: new THREE.Vector4(city ? city.x - size / 2 : 0, city ? city.z - size / 2 : 0, size, 0), dirty: false, t: 0 };
  }

  /**
   * Shadow of every standing building on flat ground: the convex hull of its footprint and the
   * footprint pushed along the sun direction by its height (red), plus a soft occlusion skirt
   * around the base (green). Cheap enough to redo whenever buildings break.
   */
  bakeCityShadows() {
    const cs = this.cityShadow;
    if (!this.buildings || !this.buildings.length) return;
    const { ctx, S, box } = cs, k = S / box.z;
    const sun = this.sunDir, ty = Math.max(sun.y, 0.12);
    let sx = -sun.x / ty, sz = -sun.z / ty;
    const sl = Math.hypot(sx, sz);
    if (sl > 5) { sx *= 5 / sl; sz *= 5 / sl; }            // very low sun: cap the shadow length
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.globalCompositeOperation = 'lighter';
    const px = (x) => (x - box.x) * k, pz = (z) => (z - box.y) * k;
    // occlusion skirts (green), drawn as a few widening translucent rings
    const quad = (b, g) => {
      ctx.beginPath();
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = dx * (b.hw + g), lz = dz * (b.hd + g);
        ctx.lineTo(px(b.x + lx * b.ca - lz * b.sa), pz(b.z + lx * b.sa + lz * b.ca));
      }
      ctx.closePath(); ctx.fill();
    };
    for (const b of this.buildings) {
      if (b.noShadow) continue;
      for (const [g, a] of [[0, 0.5], [3, 0.25], [7, 0.12]]) {
        ctx.fillStyle = `rgba(0,${Math.round(255 * a)},0,1)`;
        if (b.ca === 1) ctx.fillRect(px(b.x - b.hw - g), pz(b.z - b.hd - g), (b.hw + g) * 2 * k, (b.hd + g) * 2 * k);
        else quad(b, g);
      }
    }
    // shadows (red)
    ctx.fillStyle = 'rgb(255,0,0)';
    const pts = [];
    for (const b of this.buildings) {
      const h = b.top - b.y0 - 2;
      if (h < 1 || b.noShadow) continue;
      pts.length = 0;
      for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = dx * b.hw, lz = dz * b.hd;
        const x = b.x + lx * b.ca - lz * b.sa, z = b.z + lx * b.sa + lz * b.ca;
        pts.push([x, z], [x + sx * h, z + sz * h]);
      }
      const hull = convexHull(pts);
      ctx.beginPath();
      hull.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      ctx.closePath(); ctx.fill();
    }
    cs.tex.needsUpdate = true;
    box.w = 1;
    cs.dirty = false;
  }

  /* ---------- building damage ---------- */
  /** The standing building whose box contains (x,y,z) grown by r metres, or null. */
  buildingAt(x, y, z, r = 0) {
    if (!this.bgrid) return null;
    const cell = this.bgrid.get(Math.floor(x / 100) * 100003 + Math.floor(z / 100));
    if (!cell) return null;
    for (const b of cell) {
      if (b.state === 2) continue;
      if (y >= b.top + r || y <= b.y0 - r) continue;
      const dx = x - b.x, dz = z - b.z;
      if (Math.abs(dx * b.ca + dz * b.sa) < b.hw + r && Math.abs(dz * b.ca - dx * b.sa) < b.hd + r) return b;
    }
    return null;
  }

  /** Ground distance (m) from (x, z) to building b's (possibly rotated) footprint, 0 inside. */
  footDist(b, x, z) {
    const dx = x - b.x, dz = z - b.z;
    const ex = Math.max(0, Math.abs(dx * b.ca + dz * b.sa) - b.hw), ez = Math.max(0, Math.abs(dz * b.ca - dx * b.sa) - b.hd);
    return Math.hypot(ex, ez);
  }

  /** Register a building (or landmark collider) in the 100 m collision grid. */
  gridBuilding(b) {
    const ex = b.hw * Math.abs(b.ca) + b.hd * Math.abs(b.sa), ez = b.hw * Math.abs(b.sa) + b.hd * Math.abs(b.ca);
    for (let i = Math.floor((b.x - ex) / 100); i <= Math.floor((b.x + ex) / 100); i++)
      for (let k = Math.floor((b.z - ez) / 100); k <= Math.floor((b.z + ez) / 100); k++) {
        const key = i * 100003 + k;
        if (!this.bgrid.has(key)) this.bgrid.set(key, []);
        this.bgrid.get(key).push(b);
      }
  }

  /** Standing buildings with any part within `rad` of (x,z) (for blast damage). */
  buildingsNear(x, z, rad, out = []) {
    out.length = 0;
    if (!this.bgrid) return out;
    const seen = new Set();
    for (let i = Math.floor((x - rad) / 100); i <= Math.floor((x + rad) / 100); i++)
      for (let k = Math.floor((z - rad) / 100); k <= Math.floor((z + rad) / 100); k++) {
        const cell = this.bgrid.get(i * 100003 + k);
        if (!cell) continue;
        for (const b of cell) {
          if (b.state === 2 || seen.has(b)) continue;
          seen.add(b);
          if (this.footDist(b, x, z) < rad) out.push(b);
        }
      }
    return out;
  }

  /**
   * Take `dmg` off a building. Below half health the top third breaks away (state 1);
   * at zero it collapses to a low rubble heap (state 2). Returns the new state if it changed, else -1.
   */
  damageBuilding(b, dmg) {
    if (b.state === 2) return -1;
    b.hp -= dmg;
    const want = b.hp <= 0 ? 2 : b.hp < b.hp0 * 0.5 ? 1 : 0;
    if (want <= b.state) return -1;
    b.state = want;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), col = new THREE.Color();
    const touched = new Set();
    const body = b.parts[0], H0 = body.h;
    const h = want === 2 ? Math.max(1.5, Math.min(H0 * 0.12, 6)) + 2 : H0 * (0.55 + Math.random() * 0.15);
    b.top = body.y + h;
    for (const pt of b.parts) {
      if (pt === body) { p.set(pt.x, pt.y, pt.z); sc.set(pt.w * (want === 2 ? 1.08 : 1), h, pt.d * (want === 2 ? 1.08 : 1)); }
      else { p.set(pt.x, -1e4, pt.z); sc.set(0.001, 0.001, 0.001); }             // crowns, masts, roof plant fall with it
      m.compose(p, b.q || q, sc);
      pt.mesh.setMatrixAt(pt.i, m);
      if (pt.col) { col.copy(pt.col).multiplyScalar(want === 2 ? 0.38 : 0.62); pt.mesh.setColorAt(pt.i, col); }
      touched.add(pt.mesh);
    }
    for (const mesh of touched) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
    this.cityShadow.dirty = true;
    return want;
  }

  /** Put every damaged building back (new mission on the same world). */
  resetBuildings() {
    if (!this.buildings) return;
    if (this.buildings.some(b => b.state)) this.cityShadow.dirty = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3();
    const touched = new Set();
    for (const b of this.buildings) {
      if (b.state === 0 && b.hp === b.hp0) continue;
      b.state = 0; b.hp = b.hp0; b.top = b.top0;
      for (const pt of b.parts) {
        p.set(pt.x, pt.y, pt.z); sc.set(pt.w, pt.h, pt.d); m.compose(p, b.q || q, sc);
        pt.mesh.setMatrixAt(pt.i, m);
        if (pt.col) pt.mesh.setColorAt(pt.i, pt.col);
        touched.add(pt.mesh);
      }
    }
    for (const mesh of touched) { mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; }
  }

  /* ---------- trees ---------- */
  buildTrees() {
    const hf = this.hf;
    const count = this.quality === 'high' ? 26000 : 11000;
    const t = this.map.trees;
    // conifers are open cones; broadleaf / scrub are low-poly blobs lifted onto a short trunk height
    const geo = t.shape === 'cone' ? new THREE.ConeGeometry(1, 1, 5, 1, true) : new THREE.IcosahedronGeometry(0.5, 0);
    geo.translate(0, t.shape === 'cone' ? 0.5 : 0.55, 0);
    const mat = this.shadeMat(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: t.shape !== 'cone' }));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    // woods concentrate around the places the player actually flies low
    const hubs = [...this.airfields.map(a => ({ x: a.x, z: a.z, r: 5200 })), { x: hf.city.x, z: hf.city.z, r: hf.city.real ? 12000 : 4200 }];
    if (hf.city.real) hubs.push({ x: hf.city.x, z: hf.city.z, r: 6000 }, { x: 0, z: 0, r: 19000 });
    let n = 0;
    for (let tries = 0; tries < count * 12 && n < count; tries++) {
      const hub = hubs[tries % hubs.length];
      const ang = Math.random() * 6.283, r = Math.sqrt(Math.random()) * hub.r;
      const x = hub.x + Math.cos(ang) * r, z = hub.z + Math.sin(ang) * r;
      const h = hf.height(x, z);
      if (Math.random() > hf.forest(x, z, h)) continue;
      const s = t.size[0] + Math.random() * t.size[1], w = s * t.width * (0.85 + Math.random() * 0.3);
      p.set(x, h - 1, z); sc.set(w, s, w);
      m.compose(p, q, sc); mesh.setMatrixAt(n, m);
      col.setHSL(t.hue[0] + Math.random() * t.hue[1], t.sat, t.light[0] + Math.random() * t.light[1]);
      mesh.setColorAt(n, col);
      n++;
    }
    mesh.count = n;
    mesh.frustumCulled = false;
    this.group.add(mesh);
  }

  /* ---------- queries ---------- */
  terrainHeight(x, z) { return this.hf.height(x, z); }
  groundHeight(x, z) { return Math.max(this.hf.height(x, z), 0); }

  /** Surface under (x,z): fills out = { y, water, runway, slope, carrier } (see Heightfield.ground). */
  ground(x, z, out) { return this.hf.ground(x, z, out); }

  nearestRunway(x, z) {
    let best = null, bd = Infinity;
    for (const rw of this.airfields) {
      const d = Math.hypot(rw.x - x, rw.z - z);
      if (d < bd) { bd = d; best = rw; }
    }
    return best ? { ...best, dist: bd } : null;
  }

  update(dt, cameraPos) {
    this.time += dt;
    const cs = this.cityShadow;
    if (cs.dirty && this.time - cs.t > 0.4) { cs.t = this.time; this.bakeCityShadows(); }
    this.uniforms.uTime.value = this.time;
    this.sky.position.copy(cameraPos);
    // 0 below ~8 km, rising through the stratosphere to 1 at ~38 km (black sky, daytime stars)
    const sp = Math.min(1, Math.max(0, (cameraPos.y - 8000) / 30000));
    this.space = sp * (2 - sp);
    this.sky.material.uniforms.uSpace.value = this.space;
    // round Earth from high up: the horizon dips and lies ~sqrt(2Rh) away. The flat sea is stretched
    // past it (fog turns its far edge into the bright limb haze) and the view distance follows.
    const h = Math.max(cameraPos.y, 0), R = 6.371e6, hz = Math.sqrt(2 * R * h + h * h);
    const blend = Math.min(1, Math.max(0, (h - 5000) / 25000));
    this.sky.material.uniforms.uDip.value = Math.sin(Math.acos(R / (R + h))) * blend * blend * (3 - 2 * blend);
    const ws = h < 15000 ? 1 : Math.max(1, hz * 1.2 / 120000);
    this.water.scale.set(ws, 1, ws);
    const cam = this.engine.camera, far = Math.max(130000, 120000 * ws * 1.5), near = Math.min(6, Math.max(1.5, 1.5 + (h - 20000) / 16000));
    if (Math.abs(cam.far - far) > far * 0.02 || Math.abs(cam.near - near) > 0.05) { cam.far = far; cam.near = near; cam.updateProjectionMatrix(); }
    this.water.position.set(Math.round(cameraPos.x / 2000) * 2000, 0, Math.round(cameraPos.z / 2000) * 2000);
    this.updateClouds(dt, cameraPos);
    if (this.carrierMesh) this.carrierMesh.userData.radar.rotation.y += dt * 2.4;
  }
}
