// Post.js — the photographic finish for MEDIUM/HIGH graphics.
// The scene (and the cockpit pass) render linear HDR into a half-float target; then:
//   1. bright-pass at half resolution (soft knee) → anything brighter than white blooms:
//      the sun, afterburners, explosions, runway/city lights, glints on the water
//   2. dual-Kawase blur pyramid (4 levels down, 4 up) → a wide, smooth glow
//   3. composite to the screen: scene + bloom, gentle contrast/saturation grade, lens
//      vignette, fine film grain; three.js applies the ACES tone map + sRGB output there.
// LOW graphics bypasses all of this (Engine renders straight to the screen as before).
import * as THREE from 'three';

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

export class Post {
  constructor(renderer) {
    this.renderer = renderer;
    const hdr = renderer.capabilities.isWebGL2 || renderer.extensions.has('EXT_color_buffer_half_float');
    this.type = hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const opts = { type: this.type, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: this.type, depthBuffer: true, stencilBuffer: true, samples: 0 });
    this.levels = [];
    for (let i = 0; i < 5; i++) this.levels.push(new THREE.WebGLRenderTarget(4, 4, opts));
    this.ups = [];
    for (let i = 0; i < 4; i++) this.ups.push(new THREE.WebGLRenderTarget(4, 4, opts));

    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);

    this.bright = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uThresh: { value: hdr ? 1.15 : 0.85 }, uKnee: { value: 0.6 } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tSrc; uniform float uThresh, uKnee;
        void main() {
          vec3 c = texture2D(tSrc, vUv).rgb;
          float l = max(c.r, max(c.g, c.b));
          float soft = clamp(l - uThresh + uKnee, 0.0, 2.0 * uKnee); soft = soft * soft / (4.0 * uKnee + 1e-4);
          float w = max(soft, l - uThresh) / max(l, 1e-4);
          gl_FragColor = vec4(min(c * w, vec3(40.0)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.down = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tSrc; uniform vec2 uTexel;
        void main() {
          vec3 s = texture2D(tSrc, vUv).rgb * 4.0;
          s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
          s += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
          gl_FragColor = vec4(s / 8.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.up = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;
        void main() {
          vec2 o = uTexel;
          vec3 s = texture2D(tSrc, vUv + vec2(-2.0 * o.x, 0.0)).rgb + texture2D(tSrc, vUv + vec2(2.0 * o.x, 0.0)).rgb;
          s += texture2D(tSrc, vUv + vec2(0.0, -2.0 * o.y)).rgb + texture2D(tSrc, vUv + vec2(0.0, 2.0 * o.y)).rgb;
          s += (texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb
              + texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb) * 2.0;
          gl_FragColor = vec4(s / 12.0 + texture2D(tAdd, vUv).rgb, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.comp = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.rt.texture }, tBloom: { value: null }, uBloom: { value: 0.32 }, uTime: { value: 0 },
        uSat: { value: 1.06 }, uContrast: { value: 1.04 }, uVignette: { value: 0.32 }, uGrain: { value: 0.018 },
        uTint: { value: new THREE.Vector3(1, 1, 1) }, uAspect: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tScene, tBloom; uniform float uBloom, uTime, uSat, uContrast, uVignette, uGrain, uAspect;
        uniform vec3 uTint;
        void main() {
          vec3 c = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloom;
          // grade in linear light: saturation around luminance, contrast around mid-grey (log-ish), tint
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = max(mix(vec3(l), c, uSat), 0.0);
          c = pow(c / 0.18, vec3(uContrast)) * 0.18;
          c *= uTint;
          // lens vignette (cos^4 falloff, shaped for the aspect ratio)
          vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
          float v = 1.0 - uVignette * smoothstep(0.25, 1.15, dot(d, d) * 1.6);
          c *= v;
          // fine luminance grain, strongest in the shadows
          float n = fract(sin(dot(vUv * 913.7 + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
          c += n * uGrain * (0.25 + 0.75 * exp(-l * 6.0)) * max(l, 0.02);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      depthTest: false, depthWrite: false,
    });
    this.comp.toneMapped = true;
    this.w = 0; this.h = 0;
  }

  /** Per-world look (time of day). */
  setGrade(atmo) {
    const u = this.comp.uniforms;
    u.uBloom.value = atmo.night ? 0.5 : atmo.sunElev < 12 ? 0.32 : 0.2;
    u.uSat.value = atmo.label === 'Overcast' ? 0.96 : 1.07;
    u.uContrast.value = atmo.night ? 1.0 : 1.04;
    // a touch of warmth at golden hour / sunset, cool at night
    if (atmo.night) u.uTint.value.set(0.94, 0.98, 1.06);
    else if (atmo.sunElev < 12) u.uTint.value.set(1.04, 1.0, 0.95);
    else u.uTint.value.set(1, 1, 1);
  }

  setSize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.rt.setSize(w, h);
    let lw = Math.max(1, w >> 1), lh = Math.max(1, h >> 1);
    for (let i = 0; i < this.levels.length; i++) {
      this.levels[i].setSize(lw, lh);
      if (i < this.ups.length) this.ups[i].setSize(lw, lh);
      lw = Math.max(1, lw >> 1); lh = Math.max(1, lh >> 1);
    }
    this.comp.uniforms.uAspect.value = w / Math.max(1, h);
  }

  setSamples(n) {
    if (this.rt.samples === n) return;
    this.rt.dispose();
    this.rt = new THREE.WebGLRenderTarget(Math.max(4, this.w), Math.max(4, this.h), { type: this.type, depthBuffer: true, stencilBuffer: true, samples: n });
    this.comp.uniforms.tScene.value = this.rt.texture;
  }

  pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  /** After the scene has been drawn into this.rt: bloom + composite to the screen. */
  finish(time) {
    const L = this.levels, U = this.ups;
    this.bright.uniforms.tSrc.value = this.rt.texture;
    this.pass(this.bright, L[0]);
    for (let i = 1; i < L.length; i++) {
      this.down.uniforms.tSrc.value = L[i - 1].texture;
      this.down.uniforms.uTexel.value.set(1 / L[i - 1].width, 1 / L[i - 1].height);
      this.pass(this.down, L[i]);
    }
    // up the pyramid: ups[i] = blur(level i+1 or ups[i+1]) + level i
    let src = L[L.length - 1];
    for (let i = U.length - 1; i >= 0; i--) {
      this.up.uniforms.tSrc.value = src.texture;
      this.up.uniforms.tAdd.value = L[i].texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this.pass(this.up, U[i]);
      src = U[i];
    }
    this.comp.uniforms.tBloom.value = U[0].texture;
    this.comp.uniforms.uTime.value = time % 100;
    this.pass(this.comp, null);
  }

  dispose() {
    this.rt.dispose();
    for (const t of [...this.levels, ...this.ups]) t.dispose();
    for (const m of [this.bright, this.down, this.up, this.comp]) m.dispose();
    this.quad.geometry.dispose();
  }
}
