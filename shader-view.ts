/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Analyser } from './analyser';
import { computeBands } from './audio-bands';
import { CameraRig } from './camera';
import { ShaderLayer } from './shader-layer';
import { commonVertex } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, ShaderRitualConfig } from './types';

const BLEND_INDEX: Record<string, number> = { add: 0, screen: 1, mix: 2 };

const compositeShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tBase;
uniform sampler2D tOverlay;
uniform float uOverlay;
uniform float uOpacity;
uniform int uBlend;
void main(){
  vec3 b = texture2D(tBase, vUv).xyz;
  if(uOverlay < 0.5){ gl_FragColor = vec4(b, 1.); return; }
  vec3 o = texture2D(tOverlay, vUv).xyz;
  vec3 r;
  if(uBlend == 0) r = b + o * uOpacity;
  else if(uBlend == 1) r = 1. - (1. - b) * (1. - o * uOpacity);
  else r = mix(b, o, uOpacity);
  gl_FragColor = vec4(clamp(r, 0., 1.), 1.);
}
`;

// Global post-FX: each u* is a 0..1 strength (0 = off). Applied to the final
// composited image. FrameRitual-style filters for extra nuance.
const postShader = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform vec3 iResolution;
uniform float uPixelate;
uniform float uEdge;
uniform float uPosterize;
uniform float uRgb;
uniform float uScan;
void main(){
  vec2 uv = vUv;
  if(uPixelate > 0.001){
    float blk = max(mix(1.0, 90.0, clamp(uPixelate, 0., 1.)), 1.0);
    vec2 bs = vec2(blk) / iResolution.xy;
    uv = (floor(uv / bs) + 0.5) * bs;
  }
  vec3 col;
  if(uRgb > 0.001){
    vec2 o = vec2(uRgb * 18.0, 0.0) / iResolution.xy;
    col.r = texture2D(tScene, uv + o).r;
    col.g = texture2D(tScene, uv).g;
    col.b = texture2D(tScene, uv - o).b;
  } else {
    col = texture2D(tScene, uv).rgb;
  }
  if(uEdge > 0.001){
    vec2 t = 1.0 / iResolution.xy;
    vec3 dx = abs(texture2D(tScene, uv + vec2(t.x, 0.)).rgb - texture2D(tScene, uv - vec2(t.x, 0.)).rgb);
    vec3 dy = abs(texture2D(tScene, uv + vec2(0., t.y)).rgb - texture2D(tScene, uv - vec2(0., t.y)).rgb);
    float edge = clamp(length(dx + dy) * 6.0, 0., 1.);
    col = mix(col, vec3(edge), clamp(uEdge, 0., 1.));
  }
  if(uPosterize > 0.001){
    float lv = mix(16.0, 2.0, clamp(uPosterize, 0., 1.));
    col = floor(col * lv + 0.5) / lv;
  }
  if(uScan > 0.001){
    float sl = 0.5 + 0.5 * sin(vUv.y * iResolution.y * 3.14159);
    col *= 1.0 - clamp(uScan, 0., 1.) * (1.0 - sl);
  }
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);
}
`;

/**
 * Renders the active shader (and an optional overlay shader composited on top)
 * via {@link ShaderLayer}. Per-element + camera uniforms are refreshed every
 * frame from the live audio bands and the global motion/camera rig.
 */
@customElement('shader-ritual-view')
export class ShaderRitualView extends LitElement {
  private analyser!: Analyser;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.OrthographicCamera;
  private canvas!: HTMLCanvasElement;

  private errorSink = { error: '' };
  private baseLayer!: ShaderLayer;
  private overlayLayer!: ShaderLayer;
  private baseTarget!: THREE.WebGLRenderTarget;
  private overlayTarget!: THREE.WebGLRenderTarget;
  private compositeScene!: THREE.Scene;
  private compositeUniforms!: Record<string, { value: any }>;
  private overlayShaderId = '';

  // Global post-FX pass (composite -> sceneTarget -> post -> screen).
  private sceneTarget!: THREE.WebGLRenderTarget;
  private postScene!: THREE.Scene;
  private postUniforms!: Record<string, { value: any }>;

  // User-uploaded GLB model overlay (rendered on top with a perspective camera).
  private modelScene!: THREE.Scene;
  private modelCamera!: THREE.PerspectiveCamera;
  private modelHolder: THREE.Group | null = null;
  private modelMats: THREE.Material[] = [];
  private modelBaseScale = 1;
  private modelRot = 0;
  private gltfLoader = new GLTFLoader();

  private lastFrame = performance.now();
  private animTime = 0;
  private cameraRig = new CameraRig();
  private lastBands: Bands = { low: 0, mid: 0, high: 0, rawLow: 0, rawMid: 0, rawHigh: 0 };

  @property({ type: Object }) config!: ShaderRitualConfig;

  @property()
  set inputNode(node: AudioNode) {
    this.analyser = new Analyser(node);
  }

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
      display: block;
    }
  `;

  getBandData() {
    return this.lastBands;
  }

  /* ---- Live-coding delegates to the base layer ---- */
  getActiveSource() {
    return this.baseLayer.getActiveSource();
  }
  applySource(buffer: string, image: string) {
    return this.baseLayer.applySource(buffer, image, this.camera);
  }
  resetSource() {
    this.baseLayer.resetSource(this.camera);
  }
  getUniformSnapshot() {
    return this.baseLayer.getUniformSnapshot();
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.init();
  }

  updated(changed: Map<string, any>) {
    if (changed.has('config') && this.renderer) {
      if (this.config.activeShader !== this.baseLayer.currentShaderId) {
        this.baseLayer.build(this.config.activeShader);
        this.resize();
        this.baseLayer.renderBufferB(this.camera);
      }
      if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    }
  }

  private init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.debug.onShaderError = (gl, _program, _vs, fs) => {
      this.errorSink.error = (gl.getShaderInfoLog(fs) || '').trim() || 'Shader compile error';
    };
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    };
    this.baseTarget = new THREE.WebGLRenderTarget(1, 1, opts);
    this.overlayTarget = new THREE.WebGLRenderTarget(1, 1, opts);
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, opts);

    this.baseLayer = new ShaderLayer(this.renderer, this.errorSink);
    this.overlayLayer = new ShaderLayer(this.renderer, this.errorSink);
    this.baseLayer.build(this.config.activeShader);

    // Final composite pass: base + optional overlay -> screen.
    this.compositeUniforms = {
      tBase: { value: this.baseTarget.texture },
      tOverlay: { value: this.overlayTarget.texture },
      uOverlay: { value: 0 },
      uOpacity: { value: 1 },
      uBlend: { value: 0 },
    };
    this.compositeScene = new THREE.Scene();
    this.compositeScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          uniforms: this.compositeUniforms,
          vertexShader: commonVertex,
          fragmentShader: compositeShader,
        }),
      ),
    );

    // Global post-FX pass.
    this.postUniforms = {
      tScene: { value: this.sceneTarget.texture },
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      uPixelate: { value: 0 },
      uEdge: { value: 0 },
      uPosterize: { value: 0 },
      uRgb: { value: 0 },
      uScan: { value: 0 },
    };
    this.postScene = new THREE.Scene();
    this.postScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          uniforms: this.postUniforms,
          vertexShader: commonVertex,
          fragmentShader: postShader,
        }),
      ),
    );

    // 3D model overlay (perspective camera + lights).
    this.modelScene = new THREE.Scene();
    this.modelCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    this.modelCamera.position.set(0, 0, 3.2);
    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 4);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-3, -1, -2);
    this.modelScene.add(amb, key, rim);

    // Support Draco- and Meshopt-compressed GLBs (very common in exports).
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.176.0/examples/jsm/libs/draco/');
    this.gltfLoader.setDRACOLoader(draco);
    this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);

    this.resize();
    this.baseLayer.renderBufferB(this.camera);
    window.addEventListener('resize', () => this.resize());
    if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    this.renderLoop();
  }

  private resize() {
    if (!this.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    this.baseTarget.setSize(pw, ph);
    this.overlayTarget.setSize(pw, ph);
    this.sceneTarget.setSize(pw, ph);
    this.baseLayer.resize(pw, ph);
    this.overlayLayer.resize(pw, ph);
    (this.postUniforms.iResolution.value as THREE.Vector3).set(pw, ph, 1);
    if (this.modelCamera) {
      this.modelCamera.aspect = w / h;
      this.modelCamera.updateProjectionMatrix();
    }
  }

  /** Load a GLB/GLTF from an ArrayBuffer; centres + normalises it.
   *  Resolves to '' on success or an error message on failure. */
  loadModel(buffer: ArrayBuffer): Promise<string> {
    return new Promise((resolve) => {
      try {
        this.gltfLoader.parse(
          buffer,
          '',
          (gltf) => {
            try {
              this.disposeModel();
              const root = gltf.scene;
              // Centre at origin and record a normalising base scale (fit ~1.6 units).
              const box = new THREE.Box3().setFromObject(root);
              const center = box.getCenter(new THREE.Vector3());
              const size = box.getSize(new THREE.Vector3());
              root.position.sub(center);
              this.modelBaseScale = 1.6 / (Math.max(size.x, size.y, size.z) || 1);
              this.modelMats = [];
              root.traverse((o) => {
                const m = (o as THREE.Mesh).material;
                if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => this.modelMats.push(mm));
              });
              const holder = new THREE.Group();
              holder.add(root);
              this.modelHolder = holder;
              this.modelScene.add(holder);
              resolve('');
            } catch (e: any) {
              resolve(e?.message || 'Error placing model');
            }
          },
          (err: any) => resolve(err?.message || 'Could not parse (Draco/KTX2 textures unsupported?)'),
        );
      } catch (e: any) {
        resolve(e?.message || 'Loader error');
      }
    });
  }

  removeModel() {
    this.disposeModel();
  }

  private disposeModel() {
    if (!this.modelHolder) return;
    this.modelScene.remove(this.modelHolder);
    this.modelHolder.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const m = mesh.material;
      if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
    });
    this.modelHolder = null;
    this.modelMats = [];
  }

  /** 0..1 effective strength of a post-FX filter (band pushes the amount). */
  private fxAmount(name: keyof ShaderRitualConfig['postfx']) {
    const s = this.config.postfx?.[name];
    if (!s || !s.on) return 0;
    const bv = s.band === 'none' ? 0 : (this.lastBands as any)[s.band] || 0;
    return Math.min(1.2, s.amount + bv);
  }

  private ensureOverlay() {
    const ov = this.config.overlay;
    if (ov.enabled && this.overlayShaderId !== ov.shader) {
      this.overlayShaderId = ov.shader;
      this.overlayLayer.build(ov.shader);
      const dpr = this.renderer.getPixelRatio();
      this.overlayLayer.resize(
        Math.floor(window.innerWidth * dpr),
        Math.floor(window.innerHeight * dpr),
      );
      this.overlayLayer.renderBufferB(this.camera);
    }
  }

  private renderLoop = () => {
    requestAnimationFrame(this.renderLoop);
    if (!this.renderer) return;

    if (this.analyser) {
      this.analyser.update();
      this.lastBands = computeBands(this.analyser.data, this.config.sensitivity, this.config.thresholds);
    }

    // Audio-gated animation clock + shared camera rig.
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const m = this.config.motion;
    const energy = Math.max(this.lastBands.low, this.lastBands.mid, this.lastBands.high);
    const speed = m && m.audioGated ? m.idle + energy * m.gain : 1;
    const motionDt = dt * speed;
    this.animTime += motionDt;
    const time = this.animTime;
    const cam = this.cameraRig.update(motionDt, time, this.config.camera, this.lastBands);

    // Base layer -> baseTarget.
    const baseDef = getShader(this.config.activeShader);
    const baseCfg = this.config.shaders[baseDef.id]?.elements || {};
    this.baseLayer.setUniforms(time, cam, this.lastBands, baseCfg);
    this.baseLayer.render(this.camera, this.baseTarget);

    // Optional overlay layer -> overlayTarget.
    const ov = this.config.overlay;
    this.compositeUniforms.uOverlay.value = ov.enabled ? 1 : 0;
    if (ov.enabled) {
      this.ensureOverlay();
      const ovDef = getShader(ov.shader);
      const ovCfg = this.config.shaders[ovDef.id]?.elements || {};
      this.overlayLayer.setUniforms(time, cam, this.lastBands, ovCfg);
      this.overlayLayer.render(this.camera, this.overlayTarget);
      this.compositeUniforms.uOpacity.value = ov.opacity;
      this.compositeUniforms.uBlend.value = BLEND_INDEX[ov.blend] ?? 0;
    }

    // Composite (base + overlay) -> sceneTarget.
    this.renderer.setRenderTarget(this.sceneTarget);
    this.renderer.render(this.compositeScene, this.camera);

    // Global post-FX -> screen.
    this.postUniforms.uPixelate.value = this.fxAmount('pixelate');
    this.postUniforms.uEdge.value = this.fxAmount('edge');
    this.postUniforms.uPosterize.value = this.fxAmount('posterize');
    this.postUniforms.uRgb.value = this.fxAmount('rgbShift');
    this.postUniforms.uScan.value = this.fxAmount('scanlines');
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.postScene, this.camera);

    // 3D model overlay, drawn on top of the post-processed image.
    const md = this.config.model;
    if (this.modelHolder && md) {
      this.modelHolder.visible = md.visible;
      this.modelHolder.position.set(md.posX, md.posY, md.posZ);
      this.modelHolder.scale.setScalar(md.scale * this.modelBaseScale);
      if (md.bpm > 0) this.modelRot += motionDt * (md.bpm / 60) * (Math.PI / 2); // quarter-turn/beat
      this.modelHolder.rotation.y = this.modelRot;
      for (const mat of this.modelMats) {
        (mat as any).transparent = true;
        (mat as any).opacity = md.opacity;
        (mat as any).depthWrite = md.opacity > 0.99;
      }
      if (md.visible) {
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.modelScene, this.modelCamera);
        this.renderer.autoClear = true;
      }
    }
  };

  protected render() {
    return html`<canvas></canvas>`;
  }
}
