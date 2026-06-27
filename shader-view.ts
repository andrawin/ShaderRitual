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
import { decompose, type Part } from './decompose';
import { fracture, type Fragment } from './fracture';
import { Analyser } from './analyser';
import { computeBands } from './audio-bands';
import { CameraRig } from './camera';
import { ShaderLayer } from './shader-layer';
import { commonVertex } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, PartInfo, ShaderRitualConfig } from './types';

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
  private modelHolder: THREE.Group | null = null; // transform group (scale/pos/rot)
  private modelRootObj: THREE.Object3D | null = null; // the loaded gltf scene (centred)
  private modelMats: THREE.Material[] = [];
  private modelBaseScale = 1;
  private modelRot = 0;
  private modelRadius = 1; // model-local bounding radius (physics + capture scaling)

  // MeshRitual engine: per-mesh parts + fracture shards + physics.
  private modelParts: Part[] = [];
  private partMap = new Map<string, Part>();
  private fractureGroup: THREE.Group | null = null;
  private modelFragments: Fragment[] = [];
  private fractureMaterials: THREE.MeshStandardMaterial[] = [];
  private fragmentCount = 0;
  private gltfLoader = new GLTFLoader();

  // Physics simulation state.
  private prevBeatVal = 0;
  private lastBeat = 0;
  private imploding = false;
  private beatToggle = false;
  private pulseImplodeAt = 0;
  private physicsWasEnabled = false;
  private readonly IDENTITY = new THREE.Quaternion();
  private tmpVec = new THREE.Vector3();

  // Screen-capture projection (shared window -> textured plane).
  private captureMesh!: THREE.Mesh;
  private captureTexture: THREE.VideoTexture | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  private _captureStream: MediaStream | null = null;

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
      // Refresh part / fracture visibility on config edits (mode, per-part
      // hide, fracture toggle) instead of recomputing it every frame.
      if (this.modelHolder) this.applyMode();
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
    // Camera lives in the scene graph so a camera-attached capture plane renders.
    this.modelScene.add(this.modelCamera);
    const amb = new THREE.AmbientLight(0xffffff, 0.9);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 4);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-3, -1, -2);
    this.modelScene.add(amb, key, rim);

    // Screen-capture plane (background = camera-attached rear wall, or floating).
    this.captureMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.captureMesh.visible = false;
    this.modelScene.add(this.captureMesh);

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

  /** Load a GLB/GLTF from an ArrayBuffer; centres + normalises it, decomposes
   *  it into parts, and dispatches `parts-changed` for the host UI.
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
              const sphere = box.getBoundingSphere(new THREE.Sphere());
              this.modelRadius = Math.max(sphere.radius, 1e-3);
              root.position.sub(center);
              this.modelBaseScale = 1.6 / (Math.max(size.x, size.y, size.z) || 1);

              const holder = new THREE.Group();
              this.modelHolder = holder;
              this.modelRootObj = root;
              holder.add(root);
              this.modelScene.add(holder);

              // Decompose into addressable parts (model already centred at origin).
              this.modelParts = decompose(root, new THREE.Vector3(0, 0, 0));
              this.partMap.clear();
              this.modelMats = [];
              for (const p of this.modelParts) {
                this.partMap.set(p.id, p);
                for (const m of p.materials) this.modelMats.push(m);
              }

              this.dispatchEvent(
                new CustomEvent<PartInfo[]>('parts-changed', {
                  detail: this.modelParts.map((p) => ({ id: p.id, name: p.name })),
                  bubbles: true,
                  composed: true,
                }),
              );

              this.fragmentCount = 0;
              this.syncFracture();
              this.applyMode();
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
    if (this.modelHolder) {
      this.modelScene.remove(this.modelHolder);
      this.modelHolder.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const m = mesh.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((mm) => mm.dispose());
      });
    }
    for (const m of this.fractureMaterials) m.dispose();
    this.modelHolder = null;
    this.modelRootObj = null;
    this.modelParts = [];
    this.partMap.clear();
    this.fractureGroup = null;
    this.modelFragments = [];
    this.fractureMaterials = [];
    this.fragmentCount = 0;
    this.modelMats = [];
    this.dispatchEvent(
      new CustomEvent<PartInfo[]>('parts-changed', { detail: [], bubbles: true, composed: true }),
    );
  }

  /** Rebuild fracture fragments when the requested count (or mode) changes. */
  private syncFracture() {
    const holder = this.modelHolder;
    const root = this.modelRootObj;
    if (!holder || !root || !this.modelParts.length) return;
    const want = this.config.model.mode === 'fracture'
      ? Math.max(2, Math.round(this.config.model.fracture.fragments))
      : 0;
    if (want === this.fragmentCount && (want === 0 || this.fractureGroup)) {
      this.applyMode();
      return;
    }
    // Tear down old fracture group.
    if (this.fractureGroup) {
      holder.remove(this.fractureGroup);
      this.fractureGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.fractureGroup = null;
      this.modelFragments = [];
      for (const m of this.fractureMaterials) m.dispose();
      this.fractureMaterials = [];
    }
    if (want > 0) {
      // Reset parts to rest so fracture reads the model at rest, then build in
      // the holder's identity frame (so fragments are captured model-local).
      for (const p of this.modelParts) {
        p.mesh.position.copy(p.basePosition);
        p.mesh.scale.copy(p.baseScale);
        p.mesh.quaternion.copy(p.baseQuaternion);
      }
      const savedPos = holder.position.clone();
      const savedScale = holder.scale.clone();
      const savedRot = holder.rotation.clone();
      holder.position.set(0, 0, 0);
      holder.scale.setScalar(1);
      holder.rotation.set(0, 0, 0);
      holder.updateWorldMatrix(true, true);
      const built = fracture(root, new THREE.Vector3(), want);
      holder.position.copy(savedPos);
      holder.scale.copy(savedScale);
      holder.rotation.copy(savedRot);
      this.fractureGroup = built.group;
      this.modelFragments = built.fragments;
      this.fractureMaterials = built.materials;
      holder.add(this.fractureGroup);
    }
    this.fragmentCount = want;
    this.applyMode();
  }

  /** Show the decomposed parts or the fracture group depending on mode. */
  private applyMode() {
    const md = this.config.model;
    const showParts = md.mode !== 'fracture';
    for (const p of this.modelParts) {
      p.mesh.visible = showParts && (md.mode === 'none' || (md.parts[p.id]?.visible ?? true));
    }
    if (this.fractureGroup) this.fractureGroup.visible = !showParts && md.fracture.visible;
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

    // 3D model overlay, drawn on top of the post-processed image. All per-frame
    // model work is skipped entirely when there's no model or it's hidden.
    const md = this.config.model;
    if (this.modelHolder && md && md.visible) {
      // Rebuild fracture shards if the mode / fragment count changed.
      const wantFrag = md.mode === 'fracture' ? Math.max(2, Math.round(md.fracture.fragments)) : 0;
      if (wantFrag !== this.fragmentCount) this.syncFracture();

      const physicsActive =
        md.mode === 'fracture' && md.fracture.physics.enabled && !!this.fractureGroup;
      // Reset shards to rest the first frame physics is switched on.
      if (physicsActive && !this.physicsWasEnabled) this.reset();
      this.physicsWasEnabled = md.mode === 'fracture' && md.fracture.physics.enabled;

      this.modelHolder.visible = true;
      this.modelHolder.position.set(md.posX, md.posY, md.posZ);
      this.modelHolder.scale.setScalar(md.scale * this.modelBaseScale);
      // Physics needs a non-rotating frame so gravity stays "down".
      if (!physicsActive && md.bpm > 0) {
        this.modelRot += motionDt * (md.bpm / 60) * (Math.PI / 2); // quarter-turn/beat
      }
      this.modelHolder.rotation.y = physicsActive ? 0 : this.modelRot;

      // Opacity applies to every part / fragment material.
      const allMats = this.fractureGroup && md.mode === 'fracture' ? this.fractureMaterials : this.modelMats;
      for (const mat of allMats) {
        (mat as any).transparent = md.opacity < 0.999;
        (mat as any).opacity = md.opacity;
        (mat as any).depthWrite = md.opacity > 0.99;
      }

      if (md.mode === 'parts') {
        this.animateParts(this.lastBands, motionDt);
      } else if (md.mode === 'fracture') {
        if (physicsActive) {
          this.detectBeat(this.lastBands);
          if (this.pulseImplodeAt && now >= this.pulseImplodeAt) {
            this.implode();
            this.pulseImplodeAt = 0;
          }
          this.animateFracturePhysics(this.lastBands, dt);
        } else {
          this.animateFracture(this.lastBands, motionDt);
        }
      }

      this.applyCapture(this.lastBands);

      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.modelScene, this.modelCamera);
      this.renderer.autoClear = true;
    } else if (this.modelHolder) {
      this.modelHolder.visible = false;
    }
  };

  /* ----------------------- Model animation ----------------------- */

  private animateParts(bands: Bands, dt: number) {
    const k = this.modelRadius;
    for (const part of this.modelParts) {
      const s = this.config.model.parts[part.id];
      if (!part.mesh.visible) continue;

      part.mesh.position.copy(part.basePosition);
      part.mesh.scale.copy(part.baseScale);
      part.mesh.quaternion.copy(part.baseQuaternion);
      for (const m of part.materials) m.emissiveIntensity = 0;

      const v = !s || s.band === 'none' ? 0 : (bands as any)[s.band] * s.amount;
      if (v <= 0 && s?.target !== 'rotate') continue;

      switch (s?.target) {
        case 'scale':
          part.mesh.scale.copy(part.baseScale).multiplyScalar(1 + v);
          break;
        case 'explode':
          part.mesh.position.copy(part.basePosition).addScaledVector(part.explodeDir, v * k * 0.6);
          break;
        case 'emissive':
          for (const m of part.materials) m.emissiveIntensity = v * 2.5;
          break;
        case 'rotate':
          part.spin += v * dt * 4;
          part.mesh.quaternion.copy(part.baseQuaternion);
          part.mesh.rotateY(part.spin);
          break;
      }
    }
  }

  private animateFracture(bands: Bands, dt: number) {
    if (!this.fractureGroup) return;
    const f = this.config.model.fracture;
    const k = this.modelRadius;
    const val = (b: string, amt: number) => (b === 'none' ? 0 : (bands as any)[b] * amt);

    let emissive = 0;
    for (const frag of this.modelFragments) {
      const explodeBand = f.distribute ? frag.band : f.explodeBand;
      const scaleBand = f.distribute ? frag.band : f.scaleBand;

      const ex = val(explodeBand, f.explodeAmount);
      const sc = val(scaleBand, f.scaleAmount);
      const sp = val(f.spinBand, f.spinAmount);

      frag.mesh.position.copy(frag.base).addScaledVector(frag.dir, ex * k * (0.6 + frag.phase * 0.8));
      frag.mesh.scale.setScalar(1 + sc);
      frag.spin += sp * dt * (2 + frag.phase * 3);
      frag.mesh.quaternion.setFromAxisAngle(frag.axis, frag.spin);
      emissive = Math.max(emissive, ex, sc);
    }
    for (const m of this.fractureMaterials) m.emissiveIntensity = emissive * 2.0;
  }

  /* --------------------------- Physics --------------------------- */

  /** Fire an action on the rising edge of the trigger band past its threshold. */
  private detectBeat(bands: Bands) {
    const p = this.config.model.fracture.physics;
    const v = (bands as any)[p.beatBand] ?? 0;
    const now = performance.now();
    if (v > p.beatThreshold && this.prevBeatVal <= p.beatThreshold && now - this.lastBeat > 120) {
      this.lastBeat = now;
      switch (p.beatAction) {
        case 'burst':
          this.burst();
          break;
        case 'implode':
          this.implode();
          break;
        case 'pulse':
          this.burst();
          this.pulseImplodeAt = now + 350;
          break;
        case 'alternate':
          this.beatToggle = !this.beatToggle;
          this.beatToggle ? this.burst() : this.implode();
          break;
      }
    }
    this.prevBeatVal = v;
  }

  /** Launch every fragment outward + upward with random tumble. */
  burst() {
    if (!this.modelFragments.length) return;
    const p = this.config.model.fracture.physics;
    const r = this.modelRadius;
    this.imploding = false;
    for (const f of this.modelFragments) {
      f.resting = false;
      const lateral = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.3, Math.random() - 0.5).multiplyScalar(0.5 * r);
      f.vel.copy(f.dir).multiplyScalar(p.burstStrength * r * (1.2 + f.phase)).add(lateral);
      f.vel.y += p.burstStrength * r * 0.8;
      f.angVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(p.spin * (1 + f.phase) * 3);
    }
  }

  /** Spring every fragment back toward its rest position. */
  implode() {
    if (!this.modelFragments.length) return;
    this.imploding = true;
    for (const f of this.modelFragments) f.resting = false;
  }

  /** Instantly snap all fragments back to rest. */
  reset() {
    this.imploding = false;
    this.pulseImplodeAt = 0;
    for (const f of this.modelFragments) {
      f.mesh.position.copy(f.base);
      f.mesh.quaternion.copy(this.IDENTITY);
      f.mesh.scale.setScalar(1);
      f.vel.set(0, 0, 0);
      f.angVel.set(0, 0, 0);
      f.resting = true;
    }
  }

  private animateFracturePhysics(bands: Bands, dt: number) {
    if (!this.fractureGroup) return;
    const f2 = this.config.model.fracture;
    const p = f2.physics;
    const r = this.modelRadius;
    const g = p.gravity * r * 3.0;
    const floorY = -r;
    const val = (b: string, amt: number) => (b === 'none' ? 0 : (bands as any)[b] * amt);

    let maxSc = 0;
    let active = 0;

    for (const f of this.modelFragments) {
      // Scale stays audio-reactive even while the body simulates.
      const scaleBand = f2.distribute ? f.band : f2.scaleBand;
      const sc = val(scaleBand, f2.scaleAmount);
      f.mesh.scale.setScalar(1 + sc);
      maxSc = Math.max(maxSc, sc);

      if (f.resting && !this.imploding) continue;
      active++;

      if (this.imploding) {
        this.tmpVec.copy(f.base).sub(f.mesh.position);
        f.vel.addScaledVector(this.tmpVec, p.implodeStrength * dt);
        f.vel.multiplyScalar(Math.max(0, 1 - 4 * dt));
        f.mesh.position.addScaledVector(f.vel, dt);
        f.mesh.quaternion.slerp(this.IDENTITY, Math.min(1, 6 * dt));
        f.angVel.multiplyScalar(Math.max(0, 1 - 6 * dt));
        if (this.tmpVec.length() < 0.02 * r && f.vel.length() < 0.05 * r) {
          f.mesh.position.copy(f.base);
          f.mesh.quaternion.copy(this.IDENTITY);
          f.vel.set(0, 0, 0);
          f.angVel.set(0, 0, 0);
          f.resting = true;
        }
      } else {
        f.vel.y -= g * dt;
        f.vel.multiplyScalar(Math.max(0, 1 - 0.2 * dt)); // mild air drag
        f.mesh.position.addScaledVector(f.vel, dt);

        const sp = f.angVel.length();
        if (sp > 1e-5) {
          const dq = new THREE.Quaternion().setFromAxisAngle(this.tmpVec.copy(f.angVel).normalize(), sp * dt);
          f.mesh.quaternion.premultiply(dq);
        }

        if (p.floor && f.mesh.position.y < floorY) {
          f.mesh.position.y = floorY;
          f.vel.y *= -p.restitution;
          f.vel.x *= 0.78;
          f.vel.z *= 0.78;
          f.angVel.multiplyScalar(0.78);
          if (Math.abs(f.vel.y) < 0.05 * r) f.vel.y = 0;
          if (f.vel.lengthSq() < (0.01 * r) * (0.01 * r)) {
            f.vel.set(0, 0, 0);
            f.angVel.multiplyScalar(0.5);
            f.resting = true;
          }
        }
      }
    }

    if (this.imploding && active === 0) this.imploding = false;
    for (const m of this.fractureMaterials) m.emissiveIntensity = maxSc * 2.0;
  }

  /* ----------------------- Screen capture ------------------------ */

  /** Wire a getDisplayMedia stream (or null) into the capture plane. */
  setCaptureStream(stream: MediaStream | null) {
    if (this._captureStream === stream) return;
    this._captureStream = stream;
    if (this.renderer) this.initCapture();
  }

  private async initCapture() {
    if (!this.captureMesh) return;
    const mat = this.captureMesh.material as THREE.MeshBasicMaterial;
    if (this.captureVideo) {
      this.captureVideo.pause();
      this.captureVideo.srcObject = null;
      this.captureVideo = null;
    }
    if (this.captureTexture) {
      this.captureTexture.dispose();
      this.captureTexture = null;
    }
    if (this._captureStream) {
      const video = document.createElement('video');
      video.srcObject = this._captureStream;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      this.captureVideo = video;
      try {
        await video.play();
      } catch (e) {}
      this.captureTexture = new THREE.VideoTexture(video);
      this.captureTexture.colorSpace = THREE.SRGBColorSpace;
      this.captureTexture.minFilter = THREE.LinearFilter;
      this.captureTexture.magFilter = THREE.LinearFilter;
      mat.map = this.captureTexture;
      mat.needsUpdate = true;
    } else {
      mat.map = null;
      mat.needsUpdate = true;
      this.captureMesh.visible = false;
    }
  }

  private captureAspect(): number {
    const w = this.captureVideo?.videoWidth || 16;
    const h = this.captureVideo?.videoHeight || 9;
    return h > 0 ? w / h : 16 / 9;
  }

  private applyCapture(bands: Bands) {
    if (!this.captureMesh) return;
    const c = this.config.model.capture;
    if (!c) return;
    const mat = this.captureMesh.material as THREE.MeshBasicMaterial;
    this.captureMesh.visible =
      !!this.captureTexture && c.visible && this.config.model.visible && c.opacity > 0;
    if (!this.captureMesh.visible) return;

    mat.opacity = c.opacity;
    const react = c.reactive ? 1 + ((bands as any)[c.reactiveBand] || 0) * 0.2 : 1;

    if (c.mode === 'background') {
      if (this.captureMesh.parent !== this.modelCamera) this.modelCamera.add(this.captureMesh);
      const dist = this.modelCamera.far * 0.5;
      const h = 2 * Math.tan((this.modelCamera.fov * Math.PI) / 360) * dist;
      const w = h * this.modelCamera.aspect;
      this.captureMesh.position.set(0, 0, -dist);
      this.captureMesh.quaternion.identity();
      this.captureMesh.scale.set(w * c.scale * react, h * c.scale * react, 1);
    } else {
      if (this.captureMesh.parent !== this.modelScene) this.modelScene.add(this.captureMesh);
      // Use the on-screen (normalised) radius so the plane is a sane size.
      const dr = Math.max(0.4, this.modelRadius * this.modelBaseScale);
      const base = dr * 2.2 * c.scale * react;
      this.captureMesh.position.set(0, 0, 0);
      this.captureMesh.quaternion.copy(this.modelCamera.quaternion); // billboard
      this.captureMesh.scale.set(base, base / this.captureAspect(), 1);
    }
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}
