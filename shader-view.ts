/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
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
    this.baseLayer.resize(pw, ph);
    this.overlayLayer.resize(pw, ph);
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

    // Composite -> screen.
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.compositeScene, this.camera);
  };

  protected render() {
    return html`<canvas></canvas>`;
  }
}
