// Engine.js — renderer, scene graph, camera rig, resize/quality management
import * as THREE from 'three';
import { Post } from './Post.js';
import { SHADE_UNIFORMS } from '../world/Environment.js';

const _v2 = new THREE.Vector2();

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    // Shader error checking reads the compile log, which is null while the context is lost (phone
    // sleep, GPU reset) and three.js then throws. Off by default (also saves a sync GPU round-trip
    // per program); add ?glcheck to the URL to get shader compile errors while developing.
    this.renderer.debug.checkShaderErrors = /[?&]glcheck/.test(location.search);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 1.5, 130000);
    this.camera.position.set(0, 500, 1200);

    // Secondary camera used for gun-aim / free-look
    this.lookCamera = new THREE.PerspectiveCamera(62, 1, 1.5, 130000);

    this.quality = 'med';
    this.shadows = false;
    this.clock = new THREE.Clock();
    this.onResizeCallbacks = [];
    this.paused = false;
  }

  applyQuality(q) {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    let pixelRatio = Math.min(dpr, 2);
    let shadows = false;
    if (q === 'low') { pixelRatio = Math.min(dpr, 1); shadows = false; }
    else if (q === 'high') { pixelRatio = Math.min(dpr, 2.5); shadows = true; }
    this.renderer.setPixelRatio(pixelRatio);
    // HDR + bloom + grade on MEDIUM / HIGH; HIGH also gets 4x MSAA on the scene target
    // (?nopost in the URL turns the post pipeline off for comparison)
    this.postOn = q !== 'low' && !/[?&]nopost/.test(location.search);
    if (this.postOn && !this.post) {
      try { this.post = new Post(this.renderer); } catch (e) { this.post = null; this.postOn = false; }
    }
    if (this.post) this.post.setSamples(q === 'high' && this.renderer.capabilities.isWebGL2 ? 4 : 0);
    this.shadows = shadows;
    this.renderer.shadowMap.enabled = shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.resize();
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.post) { const v = this.renderer.getDrawingBufferSize(_v2); this.post.setSize(v.x, v.y); }
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.lookCamera.aspect = w / h;
    this.lookCamera.updateProjectionMatrix();
    this.onResizeCallbacks.forEach(cb => cb(w, h));
  }

  onResize(cb) { this.onResizeCallbacks.push(cb); }

  start() {
    window.addEventListener('resize', () => this.resize());
    this.resize();

    // Mobile GPUs kill the WebGL context when the screen sleeps or memory
    // gets tight. Three.js re-initialises automatically on restore — we just
    // surface it so a "frozen black screen" never happens silently.
    const overlay = document.createElement('div');
    overlay.id = 'gl-lost';
    overlay.textContent = 'RENDERING INTERRUPTED — recovering…';
    let restoreTimer = null;
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); // required for the browser to attempt restore
      overlay.textContent = 'RENDERING INTERRUPTED — recovering…';
      overlay.classList.add('show');
      clearTimeout(restoreTimer);
      restoreTimer = setTimeout(() => {
        overlay.textContent = 'RENDERING LOST — tap anywhere to reload';
        const retry = () => location.reload();
        overlay.addEventListener('click', retry, { once: true });
      }, 8000);
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      clearTimeout(restoreTimer);
      overlay.classList.remove('show');
      this.resize();
    });
    document.body.appendChild(overlay);
  }

  setMenuMode(env) {
    // slow cinematic orbit for the main menu background
    this.menuEnv = env;
    const cam = this.camera;
    const tick = () => {
      if (!this.menuEnv) return;
      const t = performance.now() * 0.00004;
      cam.position.set(Math.sin(t) * 3500, 1600 + Math.sin(t * 2.3) * 300, Math.cos(t) * 3500);
      cam.lookAt(0, 400, 0);
      if (env) env.update(0.016, cam.position);
      requestAnimationFrame(tick);
    };
    tick();
  }

  clearMenuMode() {
    if (this.menuEnv && this.menuEnv.group) this.scene.remove(this.menuEnv.group);
    this.menuEnv = null;
  }

  /** Second pass: 3D cockpit, drawn after a depth clear with its own tiny near plane. */
  setCockpit(group, env) {
    if (!this.pitScene) {
      this.pitScene = new THREE.Scene();
      this.pitCam = new THREE.PerspectiveCamera(62, 1, 0.05, 40);
      this.pitHemi = new THREE.HemisphereLight(0xffffff, 0x30342c, 1);
      this.pitSun = new THREE.DirectionalLight(0xffffff, 1);
      this.pitScene.add(this.pitHemi, this.pitSun);
    }
    if (this.pitGroup) this.pitScene.remove(this.pitGroup);
    this.pitGroup = group;
    if (group) this.pitScene.add(group);
    if (env) {
      this.pitHemi.color.copy(env.hemi.color); this.pitHemi.intensity = env.hemi.intensity;
      this.pitSun.color.copy(env.sun.color); this.pitSun.intensity = env.sun.intensity * 0.8;
      this.pitSun.position.copy(env.sun.position);
    }
    this.pitOn = false;
  }

  render(dt) {
    const r = this.renderer;
    const post = this.postOn && this.post;
    if (post) {
      const v = r.getDrawingBufferSize(_v2);
      this.post.setSize(v.x, v.y);
      r.setRenderTarget(this.post.rt);
    }
    SHADE_UNIFORMS.uShOff.value.set(0, 0, 0);
    r.render(this.scene, this.camera);
    if (this.pitOn && this.pitGroup) {
      SHADE_UNIFORMS.uShOff.value.copy(this.camera.position);    // the cockpit scene is camera-relative
      const c = this.pitCam, m = this.camera;
      if (c.fov !== m.fov || c.aspect !== m.aspect) { c.fov = m.fov; c.aspect = m.aspect; c.updateProjectionMatrix(); }
      c.quaternion.copy(m.quaternion);
      r.autoClear = false;
      r.clearDepth();
      r.render(this.pitScene, c);
      r.autoClear = true;
    }
    if (post) this.post.finish(performance.now() / 1000);
  }
}
