// Effects.js — every puff of smoke, flame, spark, splash and contrail in ONE
// draw call: an instanced-quad batch with a ring-buffer pool.
//
// A particle is written once when it spawns; the vertex shader then animates it
// from its birth time (drag, gravity/buoyancy, growth, fade), so the CPU cost is
// per spawn, not per live particle. Blending is premultiplied alpha with an
// "additive" factor per particle, which lets smoke (alpha) and fire (additive)
// share the batch.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class Effects {
  constructor(scene, max = 1600) {
    this.scene = scene;
    this.max = max;
    this.head = 0;
    this.time = 0;
    this.dirty = false;
    const quad = new THREE.PlaneGeometry(2, 2);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    const mk = (name) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a;
    };
    this.aPos = mk('aPos');   // xyz, start size
    this.aVel = mk('aVel');   // xyz, birth time
    this.aPar = mk('aPar');   // life, end-size factor, drag, gravity
    this.aCol = mk('aCol');   // rgb, alpha
    this.aMis = mk('aMis');   // additive 0..1, rotation seed, fade-in fraction, lit 0..1
    for (let i = 0; i < max; i++) this.aVel.array[i * 4 + 3] = -1e6; // all dead
    g.instanceCount = max;
    this.uniforms = {
      uTime: { value: 0 }, uTex: { value: this.makePuffTexture() },
      uLight: { value: new THREE.Color(1, 1, 1) }, uFogCol: { value: new THREE.Color(0.7, 0.8, 0.9) }, uFogD: { value: 0.00005 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      vertexShader: `
        attribute vec4 aPos; attribute vec4 aVel; attribute vec4 aPar; attribute vec4 aCol; attribute vec4 aMis;
        uniform float uTime; uniform float uFogD;
        varying vec2 vUv; varying vec4 vCol; varying vec3 vMis; varying float vFog;
        void main() {
          float t = uTime - aVel.w;
          float k = t / aPar.x;
          if (k < 0.0 || k >= 1.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float drag = aPar.z;
          float tt = drag > 0.001 ? (1.0 - exp(-drag * t)) / drag : t;
          vec3 p = aPos.xyz + aVel.xyz * tt;
          p.y -= aPar.w * t * t * 0.5;
          float size = aPos.w * mix(1.0, aPar.y, sqrt(k));
          float rot = aMis.y * 6.283 + t * (aMis.y - 0.5) * 0.9;
          float c = cos(rot), s = sin(rot);
          vec2 corner = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
          vec4 mv = viewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          mv.xy += corner * size;
          gl_Position = projectionMatrix * mv;
          vUv = position.xy;
          float fade = smoothstep(0.0, max(aMis.z, 0.001), k) * (1.0 - k) * (1.0 - k * k);
          // soft near fade so flying through smoke does not pop
          fade *= smoothstep(size * 0.15, size * 0.9 + 2.0, d);
          vCol = vec4(aCol.rgb, aCol.a * fade);
          vMis = vec3(aMis.x, aMis.y, aMis.w);
          vFog = 1.0 - exp(-uFogD * uFogD * d * d);
        }`,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec3 uLight; uniform vec3 uFogCol;
        varying vec2 vUv; varying vec4 vCol; varying vec3 vMis; varying float vFog;
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 > 1.0) discard;
          float n = texture2D(uTex, vUv * 0.5 + 0.5 + vMis.y).r;
          float a = vCol.a * smoothstep(1.0, 0.15, sqrt(r2) + (n - 0.5) * 0.55);
          vec3 lit = vCol.rgb * mix(vec3(1.0), uLight * (0.75 + 0.5 * n) , vMis.z);
          lit = mix(lit, uFogCol, vFog * (1.0 - vMis.x));
          a *= 1.0 - vFog * vMis.x;
          gl_FragColor = vec4(lit * a, a * (1.0 - vMis.x));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);

    // blob shadows: soft dark discs under low-flying aircraft
    const sg = new THREE.PlaneGeometry(1, 1); sg.rotateX(-Math.PI / 2);
    this.shadowMat = new THREE.MeshBasicMaterial({
      map: this.makeBlobTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.5,
      polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, fog: false,
    });
    this.shadows = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(sg, this.shadowMat.clone());
      m.visible = false; m.renderOrder = 2;
      scene.add(m); this.shadows.push(m);
    }
    this.shadowN = 0;
    // MED/HIGH: true silhouettes — the airframe squashed onto the ground plane along the sun.
    // Stencil keeps overlapping triangles from darkening twice.
    this.planar = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(undefined, new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false, fog: true,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, side: THREE.DoubleSide,
        stencilWrite: true, stencilRef: 1, stencilFunc: THREE.NotEqualStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
      }));
      m.matrixAutoUpdate = false; m.frustumCulled = false; m.visible = false; m.renderOrder = 2;
      scene.add(m); this.planar.push(m);
    }
    this.planarN = 0;
    this._proj = new THREE.Matrix4();
  }

  makePuffTexture() {
    const S = 64, data = new Uint8Array(S * S * 4);
    // tileable value noise, 3 octaves
    const lat = (c) => { const a = new Float32Array(c * c); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a; };
    const l1 = lat(4), l2 = lat(8), l3 = lat(16);
    const samp = (l, c, x, y) => {
      const fx = x * c / S, fy = y * c / S, ix = Math.floor(fx), iy = Math.floor(fy);
      let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x1 = (ix + 1) % c, y1 = (iy + 1) % c;
      const a = l[iy * c + ix], b = l[iy * c + x1], cc = l[y1 * c + ix], d = l[y1 * c + x1];
      return a + (b - a) * tx + (cc - a + (a - b - cc + d) * tx) * ty;
    };
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const v = samp(l1, 4, x, y) * 0.5 + samp(l2, 8, x, y) * 0.3 + samp(l3, 16, x, y) * 0.2;
      const k = (y * S + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.max(0, Math.min(255, v * 255)); data[k + 3] = 255;
    }
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }

  makeBlobTexture() {
    const S = 64, data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = (x + 0.5) / S * 2 - 1, dy = (y + 0.5) / S * 2 - 1;
      const a = Math.max(0, 1 - Math.hypot(dx, dy));
      const k = (y * S + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = 255; data[k + 3] = Math.min(255, a * a * 3 * 255);
    }
    const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
    return t;
  }

  /** Match the particle lighting/fog to the current atmosphere. */
  setAtmosphere(env) {
    const a = env.atmo;
    const L = this.uniforms.uLight.value, A = env.uniforms.uAmb.value, S = env.uniforms.uSunCol.value;
    L.setRGB(A.r + S.r * 0.45, A.g + S.g * 0.45, A.b + S.b * 0.45);
    this.uniforms.uFogCol.value.set(a.horizon);
    this.uniforms.uFogD.value = a.fogD;
    this.night = !!a.night;
  }

  clear() {
    for (let i = 0; i < this.max; i++) this.aVel.array[i * 4 + 3] = -1e6;
    this.dirty = true;
  }

  /** Raw spawn. All emitters below go through this. */
  spawn(x, y, z, vx, vy, vz, size, life, r, g, b, a, grow = 1, drag = 0, gravity = 0, additive = 0, fadeIn = 0.05, lit = 1) {
    const i = this.head * 4;
    this.head = (this.head + 1) % this.max;
    const P = this.aPos.array, V = this.aVel.array, R = this.aPar.array, C = this.aCol.array, M = this.aMis.array;
    P[i] = x; P[i + 1] = y; P[i + 2] = z; P[i + 3] = size;
    V[i] = vx; V[i + 1] = vy; V[i + 2] = vz; V[i + 3] = this.time;
    R[i] = life; R[i + 1] = grow; R[i + 2] = drag; R[i + 3] = gravity;
    C[i] = r; C[i + 1] = g; C[i + 2] = b; C[i + 3] = a;
    M[i] = additive; M[i + 1] = Math.random(); M[i + 2] = fadeIn; M[i + 3] = additive > 0.5 ? 0 : lit;
    this.dirty = true;
  }

  /* ---------------- emitters ---------------- */
  explosion(pos, size = 1, vel = null) {
    const s = size, bx = vel ? vel.x * 0.3 : 0, by = vel ? vel.y * 0.3 : 0, bz = vel ? vel.z * 0.3 : 0;
    const R = Math.random;
    // flash
    this.spawn(pos.x, pos.y, pos.z, bx, by, bz, 26 * s, 0.14, 1, 0.9, 0.6, 1, 1.6, 0, 0, 1, 0.01);
    this.spawn(pos.x, pos.y, pos.z, bx, by, bz, 60 * s, 0.25, 1, 0.6, 0.25, 0.35, 1.3, 0, 0, 1, 0.01);
    // fireball
    for (let i = 0; i < 10; i++) {
      const vx = (R() - 0.5) * 34 * s, vy = (R() - 0.2) * 30 * s, vz = (R() - 0.5) * 34 * s;
      this.spawn(pos.x + vx * 0.05, pos.y + vy * 0.05, pos.z + vz * 0.05, vx + bx, vy + by, vz + bz,
        (5 + R() * 6) * s, 0.5 + R() * 0.5, 1, 0.5 + R() * 0.25, 0.12, 0.95, 2.6, 2.2, -4, 1, 0.04);
    }
    // smoke that lingers and rises
    for (let i = 0; i < 12; i++) {
      const vx = (R() - 0.5) * 26 * s, vy = (R() - 0.1) * 22 * s, vz = (R() - 0.5) * 26 * s;
      const c = 0.05 + R() * 0.12;
      this.spawn(pos.x + vx * 0.1, pos.y + vy * 0.1, pos.z + vz * 0.1, vx + bx, vy + by, vz + bz,
        (6 + R() * 7) * s, 2.8 + R() * 2.6, c, c, c, 0.8, 3.4, 1.4, -2.5, 0, 0.12);
    }
    // sparks / burning fragments
    for (let i = 0; i < 14; i++) {
      const vx = (R() - 0.5) * 150 * s, vy = (R() - 0.25) * 130 * s, vz = (R() - 0.5) * 150 * s;
      this.spawn(pos.x, pos.y, pos.z, vx + bx, vy + by, vz + bz, (0.7 + R() * 0.9) * s, 0.7 + R() * 0.9, 1, 0.75, 0.3, 1, 0.3, 1.1, 16, 1, 0.01);
    }
    // dark debris chunks
    for (let i = 0; i < 6; i++) {
      const vx = (R() - 0.5) * 80 * s, vy = R() * 70 * s, vz = (R() - 0.5) * 80 * s;
      this.spawn(pos.x, pos.y, pos.z, vx + bx, vy + by, vz + bz, (0.5 + R() * 0.8) * s, 2.2 + R(), 0.04, 0.04, 0.04, 1, 1, 0.3, 20, 0, 0.01, 0.6);
    }
  }

  hitSpark(pos) {
    const R = Math.random;
    this.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 3.2, 0.12, 1, 0.9, 0.55, 1, 1.5, 0, 0, 1, 0.01);
    for (let i = 0; i < 4; i++) {
      this.spawn(pos.x, pos.y, pos.z, (R() - 0.5) * 70, (R() - 0.3) * 60, (R() - 0.5) * 70, 0.5, 0.35 + R() * 0.3, 1, 0.8, 0.4, 1, 0.3, 1.5, 14, 1, 0.01);
    }
    this.spawn(pos.x, pos.y, pos.z, (R() - 0.5) * 6, 3, (R() - 0.5) * 6, 1.6, 0.9, 0.25, 0.25, 0.25, 0.5, 3, 1, -2, 0, 0.1);
  }

  /** Bullet / wreck hitting the surface. */
  groundBurst(pos, water, size = 1) {
    const R = Math.random;
    if (water) {
      for (let i = 0; i < 4; i++) this.spawn(pos.x, pos.y + 0.5, pos.z, (R() - 0.5) * 5 * size, (9 + R() * 9) * size, (R() - 0.5) * 5 * size,
        1.6 * size, 0.9 + R() * 0.5, 0.92, 0.96, 1, 0.75, 2.6, 0.6, 22, 0, 0.05);
      this.spawn(pos.x, pos.y + 0.3, pos.z, 0, 0.5, 0, 2.5 * size, 1.6, 0.9, 0.95, 1, 0.4, 3.5, 0, 0, 0, 0.1);
    } else {
      for (let i = 0; i < 3; i++) this.spawn(pos.x, pos.y + 0.5, pos.z, (R() - 0.5) * 6 * size, (4 + R() * 7) * size, (R() - 0.5) * 6 * size,
        2 * size, 1.3 + R() * 0.8, 0.5, 0.44, 0.33, 0.6, 3, 1.5, 3, 0, 0.06);
    }
  }

  /**
   * Building breaking up: concrete/glass chunks thrown out and falling, plus a rolling grey dust
   * cloud sized to the building. `b` = { x, z, hw, hd, y0, top }; `vel` adds the impactor's push.
   */
  rubble(b, collapse, vel = null) {
    const R = Math.random, w = Math.max(b.hw, b.hd), h = Math.max(4, b.top - b.y0);
    const bx = vel ? vel.x * 0.25 : 0, bz = vel ? vel.z * 0.25 : 0;
    const top = collapse ? b.y0 + h * 0.5 : b.top;
    // chunks (lit, dark grey / concrete, falling under gravity)
    const nChunks = collapse ? 36 : 18;
    for (let i = 0; i < nChunks; i++) {
      const x = b.x + (R() - 0.5) * b.hw * 2, z = b.z + (R() - 0.5) * b.hd * 2, y = top - R() * h * 0.3;
      const c = 0.22 + R() * 0.3;
      this.spawn(x, y, z, (R() - 0.5) * 30 + bx, R() * 22, (R() - 0.5) * 30 + bz, 0.6 + R() * 1.6, 2 + R() * 1.5, c, c * 0.97, c * 0.93, 1, 1, 0.2, 18, 0, 0.01, 0.9);
    }
    // glass glints
    for (let i = 0; i < 10; i++) {
      this.spawn(b.x + (R() - 0.5) * b.hw * 2, top, b.z + (R() - 0.5) * b.hd * 2, (R() - 0.5) * 24 + bx, R() * 18, (R() - 0.5) * 24 + bz,
        0.4, 1 + R(), 0.8, 0.9, 1, 0.9, 0.5, 0.3, 16, 1, 0.01);
    }
    // dust: a collapse rolls out along the ground, a hit puffs from the break
    const nDust = collapse ? 26 : 10;
    for (let i = 0; i < nDust; i++) {
      const ang = R() * 6.283, sp = (collapse ? 9 : 4) + R() * 8;
      const y = collapse ? b.y0 + 2 + R() * h * 0.6 : top - R() * 4;
      const c = 0.36 + R() * 0.12;
      this.spawn(b.x + Math.cos(ang) * w * 0.6, y, b.z + Math.sin(ang) * w * 0.6, Math.cos(ang) * sp + bx * 0.3, 1 + R() * 3, Math.sin(ang) * sp + bz * 0.3,
        (collapse ? 7 : 4) + R() * w * 0.3, 5 + R() * 5, c, c * 0.95, c * 0.88, 0.32, 4, 0.9, -0.3, 0, 0.2);
    }
  }

  /** White rocket-motor smoke. */
  missileSmoke(pos, vel) {
    const R = Math.random;
    this.spawn(pos.x, pos.y, pos.z, vel.x * 0.04 + (R() - 0.5) * 3, vel.y * 0.04 + (R() - 0.5) * 3, vel.z * 0.04 + (R() - 0.5) * 3,
      1.5, 2.6 + R() * 0.8, 0.92, 0.92, 0.9, 0.5, 4.5, 0.8, -0.4, 0, 0.03);
  }

  flame(pos, vel, size = 1) {
    const R = Math.random;
    this.spawn(pos.x, pos.y, pos.z, vel.x * 0.5 + (R() - 0.5) * 5, vel.y * 0.5 + (R() - 0.5) * 5, vel.z * 0.5 + (R() - 0.5) * 5,
      2.2 * size, 0.28 + R() * 0.2, 1, 0.5 + R() * 0.2, 0.1, 0.9, 1.8, 1.5, -6, 1, 0.05);
  }

  /** Damage smoke: grey when hurt, black when burning. */
  damageSmoke(pos, vel, dark, size = 1) {
    const R = Math.random, c = dark ? 0.04 + R() * 0.05 : 0.35 + R() * 0.15;
    this.spawn(pos.x, pos.y, pos.z, vel.x * 0.25 + (R() - 0.5) * 4, vel.y * 0.25 + (R() - 0.5) * 4, vel.z * 0.25 + (R() - 0.5) * 4,
      2.2 * size, dark ? 3.2 : 1.8, c, c, c, dark ? 0.75 : 0.4, 4.5, 0.9, -1.5, 0, 0.05);
  }

  contrail(pos) {
    this.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 1.8, 9, 1, 1, 1, 0.3, 4.5, 0, 0, 0, 0.02);
  }

  /** Wingtip / over-wing vapour at high g. */
  vapour(pos, vel, strength) {
    this.spawn(pos.x, pos.y, pos.z, vel.x * 0.1, vel.y * 0.1, vel.z * 0.1, 0.8, 0.5, 1, 1, 1, 0.35 * strength, 3.2, 0.5, 0, 0, 0.1);
  }

  dust(pos, vel, size = 1) {
    const R = Math.random;
    this.spawn(pos.x + (R() - 0.5) * 3, pos.y, pos.z + (R() - 0.5) * 3, vel.x * 0.15 + (R() - 0.5) * 4, 1.5 + R() * 2, vel.z * 0.15 + (R() - 0.5) * 4,
      2.4 * size, 1.5 + R(), 0.62, 0.56, 0.44, 0.3, 3.5, 0.8, -0.5, 0, 0.15);
  }

  tyreSmoke(pos, vel) {
    const R = Math.random;
    for (let i = 0; i < 5; i++) this.spawn(pos.x + (R() - 0.5) * 3, pos.y, pos.z + (R() - 0.5) * 3, vel.x * 0.3, 1 + R() * 2, vel.z * 0.3,
      1.5, 1.1 + R() * 0.6, 0.85, 0.85, 0.88, 0.45, 4, 1.2, -1, 0, 0.1);
  }

  spray(pos, vel) {
    const R = Math.random;
    this.spawn(pos.x + (R() - 0.5) * 4, pos.y + 0.5, pos.z + (R() - 0.5) * 4, vel.x * 0.4 + (R() - 0.5) * 6, 4 + R() * 5, vel.z * 0.4 + (R() - 0.5) * 6,
      2, 1.0 + R() * 0.5, 0.92, 0.96, 1, 0.5, 3, 0.8, 9, 0, 0.1);
  }

  flareGlow(pos) {
    const R = Math.random;
    this.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 3.5, 0.1, 1, 0.92, 0.7, 1, 1, 0, 0, 1, 0.01);
    if (R() < 0.5) this.spawn(pos.x, pos.y, pos.z, (R() - 0.5) * 2, 1, (R() - 0.5) * 2, 0.9, 1.6, 0.85, 0.85, 0.85, 0.3, 3.5, 0.5, -0.5, 0, 0.1);
  }

  muzzleFlash(pos, vel) {
    this.spawn(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, 1.3, 0.05, 1, 0.85, 0.5, 0.9, 1.4, 0, 0, 1, 0.01);
  }

  /* ---------------- blob shadows ---------------- */
  beginShadows() { this.shadowN = 0; this.planarN = 0; }

  /**
   * Silhouette shadow: `geo` (airframe, local space) transformed by `world`, then projected
   * along the light onto the horizontal plane y = gy. `sun` points towards the sun.
   */
  planarShadow(geo, world, sun, gy, agl, dim = 1) {
    if (this.planarN >= this.planar.length || agl > 300) return;
    const m = this.planar[this.planarN++];
    const ly = Math.max(sun.y, 0.2), kx = sun.x / ly, kz = sun.z / ly, y = gy + 0.12;
    // p' = (x - kx (y_p - gy), gy, z - kz (y_p - gy))
    this._proj.set(
      1, -kx, 0, kx * gy,
      0, 0, 0, y,
      0, -kz, 1, kz * gy,
      0, 0, 0, 1);
    m.matrix.multiplyMatrices(this._proj, world);
    m.matrixWorld.copy(m.matrix);
    m.geometry = geo;
    const f = 1 - agl / 300;
    m.material.opacity = 0.55 * f * f * dim;
    m.visible = true;
  }
  /** Soft shadow on the ground under an aircraft at height `agl` above `gy`. */
  shadow(x, gy, z, agl, radius, heading) {
    if (this.shadowN >= this.shadows.length || agl > 260 || this.night) return;
    const m = this.shadows[this.shadowN++];
    const k = 1 + agl * 0.012;
    m.position.set(x, gy + 0.25, z);
    m.scale.set(radius * 2.2 * k, 1, radius * 2.2 * k);
    m.rotation.y = heading;
    m.material.opacity = 0.55 / (k * k);
    m.visible = true;
  }
  endShadows() {
    for (let i = this.shadowN; i < this.shadows.length; i++) this.shadows[i].visible = false;
    for (let i = this.planarN; i < this.planar.length; i++) this.planar[i].visible = false;
  }

  update(dt) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    if (this.dirty) {
      this.aPos.needsUpdate = this.aVel.needsUpdate = this.aPar.needsUpdate = this.aCol.needsUpdate = this.aMis.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose(); this.material.dispose(); this.uniforms.uTex.value.dispose();
    for (const s of this.shadows) { this.scene.remove(s); s.material.dispose(); }
  }
}
