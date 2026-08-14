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
uniform sampler2D tPrev;
uniform vec3 iResolution;
uniform float iTime;
uniform float uPixelate;
uniform float uEdge;
uniform float uPosterize;
uniform float uRgb;
uniform float uScan;
uniform float uGlitch;
uniform float uMosaic;

/* ---------------------------------------------------------------
 * Glitch — block swap / static / colour banding, adapted from a
 * Shadertoy original that drove its probability from a raymarched
 * mask. Here the probability comes from scene luminance instead, so
 * the glitch clusters on the bright parts of whatever is playing.
 * ------------------------------------------------------------- */

float rnd(vec2 co){ return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453); }
float rnd1(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * .1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float aspect(){ return iResolution.x / iResolution.y; }
vec2 pToUv(vec2 p){ return p / (2.0 * vec2(aspect(), 1.0)) + 0.5; }
vec2 uvToP(vec2 uv){ return (uv - 0.5) * 2.0 * vec2(aspect(), 1.0); }

vec2 glitchCoord(vec2 p, vec2 gridSize){
  vec2 coord = floor(p / gridSize) * gridSize;
  coord += gridSize * 0.5;
  return coord;
}

/** Probability that a region glitches: brighter scene -> more likely. */
float glitchProb(vec2 p){
  vec2 uv = clamp(pToUv(p), 0.0, 1.0);
  vec3 c = texture2D(tScene, uv).rgb;
  return clamp(dot(c, vec3(.299, .587, .114)) * 1.6, 0.0, 1.0);
}

/** vec3(seed.xy, prob) — the original's GlitchSeed struct, flattened. */
vec3 glitchSeed(vec2 p, float speed, float t){
  float seedTime = floor(t * speed);
  vec2 seed = vec2(1. + mod(seedTime / 100., 100.), 1. + mod(seedTime, 100.)) / 100.;
  seed += p;
  return vec3(seed, glitchProb(p));
}

float shouldApply(vec3 s){
  float v = mix(mix(rnd(s.xy), 1., s.z - .5), 0., (1. - s.z) * .5);
  return floor(v + 0.5); // ES 1.00 has no round()
}

vec4 swapCoords(vec2 seed, vec2 groupSize, vec2 subGrid, vec2 blockSize){
  vec2 r2 = vec2(rnd(seed), rnd(seed + .1));
  vec2 range = subGrid - (blockSize - 1.);
  vec2 coord = floor(r2 * range) / subGrid;
  vec2 bottomLeft = coord * groupSize;
  vec2 realBlockSize = (groupSize / subGrid) * blockSize;
  vec2 topRight = bottomLeft + realBlockSize;
  topRight -= groupSize / 2.;
  bottomLeft -= groupSize / 2.;
  return vec4(bottomLeft, topRight);
}
float isInBlock(vec2 pos, vec4 block){
  vec2 a = sign(pos - block.xy);
  vec2 b = sign(block.zw - pos);
  return min(sign(a.x + a.y + b.x + b.y - 3.), 0.);
}
vec2 moveDiff(vec2 pos, vec4 swapA, vec4 swapB){
  return (swapB.xy - swapA.xy) * isInBlock(pos, swapA);
}
void swapBlocks(inout vec2 xy, vec2 groupSize, vec2 subGrid, vec2 blockSize, vec2 seed, float apply){
  vec2 groupOffset = glitchCoord(xy, groupSize);
  vec2 pos = xy - groupOffset;
  vec4 swapA = swapCoords(seed * groupOffset, groupSize, subGrid, blockSize);
  vec4 swapB = swapCoords(seed * (groupOffset + .1), groupSize, subGrid, blockSize);
  pos += moveDiff(pos, swapA, swapB) * apply;
  pos += moveDiff(pos, swapB, swapA) * apply;
  xy = pos + groupOffset;
}

void glitchSwap(inout vec2 p, float t, float scale){
  float speed = 5.;
  vec3 seed;
  float apply;

  seed = glitchSeed(glitchCoord(p, vec2(.6) * scale), speed, t);
  apply = shouldApply(seed);
  swapBlocks(p, vec2(.6) * scale, vec2(2), vec2(1), seed.xy, apply);

  seed = glitchSeed(glitchCoord(p, vec2(.8) * scale), speed, t);
  apply = shouldApply(seed);
  swapBlocks(p, vec2(.8) * scale, vec2(3), vec2(1), seed.xy, apply);

  vec2 gs = vec2(.2) * scale;
  seed = glitchSeed(glitchCoord(p, gs), speed, t);
  float apply2 = shouldApply(seed);
  swapBlocks(p, gs, vec2(6), vec2(1), seed.xy + 1., apply * apply2);
  swapBlocks(p, gs, vec2(6), vec2(1), seed.xy + 2., apply * apply2);
  swapBlocks(p, gs, vec2(6), vec2(1), seed.xy + 3., apply * apply2);

  gs = vec2(1.2, .2) * scale;
  seed = glitchSeed(glitchCoord(p, gs), speed, t);
  apply = shouldApply(seed);
  swapBlocks(p, gs, vec2(9, 2), vec2(3, 1), seed.xy, apply);
}

void glitchStatic(inout vec2 p, float t, float scale){
  vec2 groupSize = vec2(.5, .125) * scale;
  float grainSize = .2 * scale;
  vec3 a = glitchSeed(glitchCoord(p, groupSize), 5., t);
  a.z *= .5;
  if(shouldApply(a) == 1.){
    vec3 b = glitchSeed(glitchCoord(p, vec2(grainSize)), 5., t);
    vec2 offset = vec2(rnd(b.xy), rnd(b.xy + .1));
    offset = floor(offset * 2. - 1. + 0.5);
    p += offset * 2.0 * scale;
  }
}

void glitchColor(vec2 p, inout vec3 color, float t, float scale){
  vec2 groupSize = vec2(.75, .125) * scale;
  vec3 seed = glitchSeed(glitchCoord(p, groupSize), 5., t);
  seed.z *= .3;
  if(shouldApply(seed) == 1.){
    vec2 co = mod(p, groupSize) / groupSize * vec2(0., 6.);
    float a = max(co.x, co.y);
    color *= min(floor(mod(a, 2.)), 1.) * 3.5;
  }
}

void main(){
  vec2 uv = vUv;

  // Glitch displaces the sampling coordinate before anything else reads it.
  if(uGlitch > 0.001){
    float g = clamp(uGlitch, 0., 1.);
    float t = iTime * 0.35;
    float scale = mix(1.2, 0.35, g); // smaller groups -> busier glitch
    vec2 p = uvToP(uv);
    glitchSwap(p, t, scale);
    glitchStatic(p, t, scale * 0.5);
    uv = pToUv(p);
  }
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

  // Glitch colour banding, applied after shading like the original.
  if(uGlitch > 0.001){
    float g = clamp(uGlitch, 0., 1.);
    glitchColor(uvToP(uv), col, iTime * 0.35, mix(1.2, 0.35, g));
  }

  /* Mosaic Shuffle (Leon Denise): each tile drags the previous frame along a
   * quantised direction, and tiles respawn from the live image at random, so
   * the picture smears into shuffling blocks. Needs the feedback texture. */
  if(uMosaic > 0.001){
    float m = clamp(uMosaic, 0., 1.);
    float unit = 1.0 / iResolution.y;
    float mt = iTime * 10.0;
    float index = floor(mt);
    float mask = hash12(floor(vUv * rnd1(index + 78.) * 32.) + index);
    float a = 6.283 * floor(rnd1(index * 72.) * 4.) / 4.;
    vec2 dir = vec2(cos(a), sin(a));
    vec2 offset = mask * dir * unit * (10.0 * m) * hash12(floor(vUv * 16.));
    vec3 prev = texture2D(tPrev, vUv - offset).rgb;
    // Respawn threshold eases off as the amount rises -> longer smears.
    bool spawn = hash12(floor(vUv * rnd1(index + 78.) * 8.) + index) > mix(0.55, 0.92, m);
    bool cold = dot(prev, prev) < 1e-5; // first frame / just switched on
    col = (spawn || cold) ? col : mix(col, prev, m);
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

  // Mosaic feedback (previous post output) + a plain copy pass to the screen.
  private feedRead!: THREE.WebGLRenderTarget;
  private feedWrite!: THREE.WebGLRenderTarget;
  private copyScene!: THREE.Scene;
  private copyUniforms!: Record<string, { value: any }>;

  // Reduced-resolution pass for the 3D overlay (model + screen capture).
  private modelTarget!: THREE.WebGLRenderTarget;
  private modelBlitScene!: THREE.Scene;
  private modelBlitUniforms!: Record<string, { value: any }>;
  private lastModelQuality = 1;
  private contextLost = false;

  // User-uploaded GLB model overlay (rendered on top with a perspective camera).
  private modelScene!: THREE.Scene;
  private modelCamera!: THREE.PerspectiveCamera;
  private modelHolder: THREE.Group | null = null; // transform group (scale/pos/rot)
  private modelRootObj: THREE.Object3D | null = null; // the loaded gltf scene (centred)
  private modelMats: THREE.Material[] = [];
  private modelBaseScale = 1;
  private modelPhase = 0; // elapsed beats, drives the tempo-locked motion
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
  private tmpQuat = new THREE.Quaternion(); // scratch (avoids per-frame allocation)
  private partsPosed = false; // parts carry an animated pose that needs resetting
  private lastAppliedOpacity = -1; // skip the material opacity loop when unchanged
  private opacityMatCount = -1;

  // Screen-capture projection (shared window -> textured plane).
  private captureMesh!: THREE.Mesh;
  private captureTexture: THREE.Texture | null = null;
  private captureVideo: HTMLVideoElement | null = null;
  private _captureStream: MediaStream | null = null;
  private captureFrameReady = false; // a new video frame is waiting to upload
  private lastCaptureUpload = 0;

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
      // Re-apply the internal render resolution when the scale changes.
      if ((this.config.renderScale ?? 1) !== this.lastRenderScale) {
        this.lastRenderScale = this.config.renderScale ?? 1;
        this.resize();
      }
      // Refresh part / fracture visibility on config edits (mode, per-part
      // hide, fracture toggle) instead of recomputing it every frame.
      if (this.modelHolder) this.applyMode();
    }
  }

  private lastRenderScale = 1;

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
    // Mosaic feedback: the post pass reads the previous frame from one target
    // while writing the next into the other, then the result is copied out.
    this.feedRead = new THREE.WebGLRenderTarget(1, 1, opts);
    this.feedWrite = new THREE.WebGLRenderTarget(1, 1, opts);
    this.copyUniforms = { tSrc: { value: null } };
    this.copyScene = new THREE.Scene();
    this.copyScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          uniforms: this.copyUniforms,
          vertexShader: commonVertex,
          fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
void main(){ gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.); }`,
        }),
      ),
    );

    // The 3D overlay (model + capture) can render at a fraction of the screen
    // resolution and be blitted up — the big win on large displays.
    this.modelTarget = new THREE.WebGLRenderTarget(1, 1, opts);
    this.modelBlitUniforms = { tModel: { value: this.modelTarget.texture } };
    this.modelBlitScene = new THREE.Scene();
    this.modelBlitScene.add(
      new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.RawShaderMaterial({
          uniforms: this.modelBlitUniforms,
          vertexShader: commonVertex,
          fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tModel;
void main(){
  vec4 c = texture2D(tModel, vUv);
  if(c.a <= 0.001) discard;
  gl_FragColor = c;
}`,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      ),
    );

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
      tPrev: { value: null },
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      uPixelate: { value: 0 },
      uEdge: { value: 0 },
      uPosterize: { value: 0 },
      uRgb: { value: 0 },
      uScan: { value: 0 },
      uGlitch: { value: 0 },
      uMosaic: { value: 0 },
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

    // A lost GL context (starting a screen share, a GPU switch, waking from
    // sleep) otherwise leaves the canvas dead until a reload. Ride it out and
    // rebuild the render targets when it comes back.
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.resize();
      this.baseLayer.renderBufferB(this.camera);
      this.overlayShaderId = ''; // force the overlay layer to rebuild
      this.lastAppliedOpacity = -1; // re-apply model material state
    });

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
    // Effective device pixels, scaled by the render-scale knob. Re-read the
    // live devicePixelRatio so moving to an external display (different DPR)
    // recomputes the backing-store size instead of ballooning it.
    const scale = Math.min(1, Math.max(0.25, this.config?.renderScale ?? 1));
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio) * scale);
    this.renderer.setSize(w, h);
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    this.baseTarget.setSize(pw, ph);
    this.overlayTarget.setSize(pw, ph);
    this.sceneTarget.setSize(pw, ph);
    this.feedRead.setSize(pw, ph);
    this.feedWrite.setSize(pw, ph);
    const mq = Math.min(1, Math.max(0.25, this.config?.model?.quality ?? 1));
    this.lastModelQuality = mq;
    this.modelTarget.setSize(Math.max(1, Math.floor(pw * mq)), Math.max(1, Math.floor(ph * mq)));
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

  private rafId = 0;

  connectedCallback() {
    super.connectedCallback();
    // Resume the loop after a reconnect (init/firstUpdated only runs once).
    if (this.renderer && !this.rafId) this.rafId = requestAnimationFrame(this.renderLoop);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private renderLoop = () => {
    this.rafId = requestAnimationFrame(this.renderLoop);
    if (!this.renderer || this.contextLost) return;

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

    // Work out which optional passes are actually needed this frame. When the
    // overlay is off and every post-FX filter is idle (the common case), we
    // skip the composite + post passes entirely and draw the base image
    // straight to the screen — 2 full-screen passes instead of 4.
    const ov = this.config.overlay;
    const px = this.fxAmount('pixelate');
    const ed = this.fxAmount('edge');
    const po = this.fxAmount('posterize');
    const rg = this.fxAmount('rgbShift');
    const sc = this.fxAmount('scanlines');
    const gl = this.fxAmount('glitch');
    const mo = this.fxAmount('mosaic');
    const anyPost = px + ed + po + rg + sc + gl + mo > 0.001;
    const needComposite = ov.enabled;

    const baseDef = getShader(this.config.activeShader);
    const baseCfg = this.config.shaders[baseDef.id]?.elements || {};
    this.baseLayer.setUniforms(time, cam, this.lastBands, baseCfg);

    if (!needComposite && !anyPost) {
      // Fast path: base image straight to the screen.
      this.baseLayer.render(this.camera, null as any);
    } else if (!needComposite) {
      // Post only: base -> sceneTarget -> post -> screen.
      this.baseLayer.render(this.camera, this.sceneTarget);
    } else {
      // Overlay compositing needed: base + overlay -> composite.
      this.baseLayer.render(this.camera, this.baseTarget);
      this.compositeUniforms.uOverlay.value = 1;
      this.ensureOverlay();
      const ovDef = getShader(ov.shader);
      const ovCfg = this.config.shaders[ovDef.id]?.elements || {};
      this.overlayLayer.setUniforms(time, cam, this.lastBands, ovCfg);
      this.overlayLayer.render(this.camera, this.overlayTarget);
      this.compositeUniforms.uOpacity.value = ov.opacity;
      this.compositeUniforms.uBlend.value = BLEND_INDEX[ov.blend] ?? 0;
      // Composite -> sceneTarget (if post follows) or straight to screen.
      this.renderer.setRenderTarget(anyPost ? this.sceneTarget : null);
      this.renderer.render(this.compositeScene, this.camera);
    }

    // Global post-FX -> screen (only when a filter is active).
    if (anyPost) {
      this.postUniforms.uPixelate.value = px;
      this.postUniforms.uEdge.value = ed;
      this.postUniforms.uPosterize.value = po;
      this.postUniforms.uRgb.value = rg;
      this.postUniforms.uScan.value = sc;
      this.postUniforms.uGlitch.value = gl;
      this.postUniforms.uMosaic.value = mo;
      this.postUniforms.iTime.value = time;

      if (mo > 0.001) {
        // Mosaic needs the previous post output: render into the write target,
        // copy that to the screen, then swap so it becomes next frame's source.
        this.postUniforms.tPrev.value = this.feedRead.texture;
        this.renderer.setRenderTarget(this.feedWrite);
        this.renderer.render(this.postScene, this.camera);
        this.renderer.setRenderTarget(null);
        this.copyUniforms.tSrc.value = this.feedWrite.texture;
        this.renderer.render(this.copyScene, this.camera);
        const tmp = this.feedRead;
        this.feedRead = this.feedWrite;
        this.feedWrite = tmp;
      } else {
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.postScene, this.camera);
      }
    }

    // 3D overlay scene, drawn on top of the post-processed image. It holds both
    // the uploaded model and the screen-capture plane — either one alone is
    // reason to render it, and all per-frame work is skipped when neither is up.
    const md = this.config.model;
    const modelUp = !!this.modelHolder && !!md && md.visible && md.opacity > 0.004;
    const captureUp = !!this.captureTexture && !!md?.capture?.visible && md.capture.opacity > 0;

    if (modelUp) {
      // Rebuild fracture shards if the mode / fragment count changed — or if
      // the group went missing while the count still matches (a config sync or
      // a reload can leave the two out of step, which would render nothing).
      const wantFrag = md.mode === 'fracture' ? Math.max(2, Math.round(md.fracture.fragments)) : 0;
      if (wantFrag !== this.fragmentCount || (wantFrag > 0 && !this.fractureGroup)) {
        this.syncFracture();
      }

      const physicsActive =
        md.mode === 'fracture' && md.fracture.physics.enabled && !!this.fractureGroup;
      // Reset shards to rest the first frame physics is switched on.
      if (physicsActive && !this.physicsWasEnabled) this.reset();
      this.physicsWasEnabled = md.mode === 'fracture' && md.fracture.physics.enabled;

      this.modelHolder.visible = true;
      this.modelHolder.scale.setScalar(md.scale * this.modelBaseScale);
      if (physicsActive) {
        // Physics needs a still, upright frame so gravity stays "down".
        this.modelHolder.position.set(md.posX, md.posY, md.posZ);
        this.modelHolder.rotation.set(0, 0, 0);
      } else {
        // The Movement dropdown is what decides whether the model moves; the
        // BPM field only sets the rate, falling back to the global camera tempo
        // so choosing a movement does something without a second setting.
        // Real time, not the audio-gated clock: a tempo the user typed should
        // run at that tempo whether or not audio is coming in.
        const beat = md.bpm > 0 ? md.bpm : this.config.camera?.bpm || 120;
        if (md.motion !== 'none') this.modelPhase += dt * (beat / 60); // beats
        this.applyModelMotion(md);
      }

      // Opacity applies to every part / fragment material — only re-applied when
      // it (or the active material set) actually changes, not every frame.
      const allMats = this.fractureGroup && md.mode === 'fracture' ? this.fractureMaterials : this.modelMats;
      if (md.opacity !== this.lastAppliedOpacity || allMats.length !== this.opacityMatCount) {
        for (const mat of allMats) {
          (mat as any).transparent = md.opacity < 0.999;
          (mat as any).opacity = md.opacity;
          (mat as any).depthWrite = md.opacity > 0.99;
        }
        this.lastAppliedOpacity = md.opacity;
        this.opacityMatCount = allMats.length;
      }

      if (md.mode === 'parts') {
        this.animateParts(this.lastBands, motionDt);
        this.partsPosed = true;
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
      } else if (this.partsPosed) {
        // Left Parts mode: animateParts had been rewriting each mesh every
        // frame, so without this they stay frozen in their last pose and the
        // model looks stuck / deformed.
        for (const p of this.modelParts) {
          p.mesh.position.copy(p.basePosition);
          p.mesh.scale.copy(p.baseScale);
          p.mesh.quaternion.copy(p.baseQuaternion);
          for (const m of p.materials) m.emissiveIntensity = 0;
        }
        this.partsPosed = false;
      }

    } else if (this.modelHolder) {
      this.modelHolder.visible = false;
    }

    // Screen capture is independent of the model — it renders on its own.
    if (modelUp || captureUp) {
      this.applyCapture(this.lastBands);

      const mq = Math.min(1, Math.max(0.25, md?.quality ?? 1));
      if (mq !== this.lastModelQuality) this.resize();

      if (mq >= 0.999) {
        // Full resolution: draw straight over the screen image.
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.modelScene, this.modelCamera);
        this.renderer.autoClear = true;
      } else {
        // Reduced resolution: render the 3D layer to its own transparent
        // target, then blit it over the screen (cheap on large displays).
        const prevAlpha = this.renderer.getClearAlpha();
        this.renderer.setClearAlpha(0);
        this.renderer.setRenderTarget(this.modelTarget);
        this.renderer.clear(true, true, false);
        this.renderer.render(this.modelScene, this.modelCamera);
        this.renderer.setRenderTarget(null);
        this.renderer.setClearAlpha(prevAlpha);

        this.renderer.autoClear = false;
        this.renderer.render(this.modelBlitScene, this.camera);
        this.renderer.autoClear = true;
      }
    }
  };

  /* ----------------------- Model animation ----------------------- */

  /**
   * Tempo-locked model movement. `modelPhase` counts elapsed beats, so every
   * mode lands on the beat: a quarter turn, one full bob, one swing.
   */
  private applyModelMotion(md: ShaderRitualConfig['model']) {
    const h = this.modelHolder!;
    const p = this.modelPhase;
    const amt = md.motionAmount ?? 1;

    h.position.set(md.posX, md.posY, md.posZ);
    h.rotation.set(0, 0, 0);

    switch (md.motion) {
      case 'none':
        break; // held at rest — position/rotation already reset above
      case 'bob':
        // Floats up and down, one cycle every two beats, with a soft nod.
        h.position.y += Math.sin(p * Math.PI) * 0.35 * amt;
        h.rotation.x = Math.sin(p * Math.PI + 1.2) * 0.12 * amt;
        h.rotation.y = p * Math.PI * 0.12; // slow drift so it never reads static
        break;
      case 'sway':
        // Pendulum rock, like a hanging sign.
        h.rotation.z = Math.sin(p * Math.PI) * 0.45 * amt;
        h.position.x += Math.sin(p * Math.PI) * 0.25 * amt;
        break;
      case 'orbit': {
        // Circles the frame, keeping the same face toward the centre.
        const a = p * Math.PI * 0.5;
        h.position.x += Math.cos(a) * 0.6 * amt;
        h.position.z += Math.sin(a) * 0.6 * amt;
        h.rotation.y = -a;
        break;
      }
      case 'tumble':
        // Off-axis rotation on all three axes at unrelated rates.
        h.rotation.x = p * Math.PI * 0.31;
        h.rotation.y = p * Math.PI * 0.5;
        h.rotation.z = p * Math.PI * 0.17;
        break;
      case 'spin':
      default:
        h.rotation.y = p * Math.PI * 0.5; // a quarter turn per beat
        break;
    }
  }

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
    }
    // Fragments keep their original colour — no audio-reactive emissive glow.
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

    let active = 0;

    for (const f of this.modelFragments) {
      // Scale stays audio-reactive even while the body simulates.
      const scaleBand = f2.distribute ? f.band : f2.scaleBand;
      const sc = val(scaleBand, f2.scaleAmount);
      f.mesh.scale.setScalar(1 + sc);

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
          this.tmpQuat.setFromAxisAngle(this.tmpVec.copy(f.angVel).normalize(), sp * dt);
          f.mesh.quaternion.premultiply(this.tmpQuat);
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
    this.captureFrameReady = false;
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
      // Keep VideoTexture (Three's video upload path), but throttle it: by
      // default it re-uploads the whole frame every render, even when the
      // shared window is static. Overriding update() — which Three calls once
      // per frame — lets us decide when the texture actually goes dirty.
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      this.captureTexture = tex;
      mat.map = tex;
      mat.needsUpdate = true;

      // requestVideoFrameCallback tells us a genuinely new frame arrived, so a
      // static shared window costs nothing. Without it, fall back to the
      // fps throttle alone.
      const v = video as any;
      const hasRvfc = typeof v.requestVideoFrameCallback === 'function';
      this.captureFrameReady = !hasRvfc;
      if (hasRvfc) {
        const onFrame = () => {
          if (this.captureVideo !== video) return; // stream replaced
          this.captureFrameReady = true;
          v.requestVideoFrameCallback(onFrame);
        };
        v.requestVideoFrameCallback(onFrame);
      }

      (tex as any).update = () => {
        if (video.readyState < video.HAVE_CURRENT_DATA) return;
        if (hasRvfc && !this.captureFrameReady) return; // no new frame to upload
        const fps = Math.min(60, Math.max(1, this.config?.model?.capture?.fps || 30));
        const nowMs = performance.now();
        if (nowMs - this.lastCaptureUpload < 1000 / fps) return;
        this.lastCaptureUpload = nowMs;
        this.captureFrameReady = false;
        tex.needsUpdate = true;
      };
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
    // Independent of the model's own Visible toggle — capture is its own layer.
    this.captureMesh.visible = !!this.captureTexture && c.visible && c.opacity > 0;
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
