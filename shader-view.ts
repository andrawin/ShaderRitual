/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import * as THREE from 'three';
import { Analyser } from './analyser';
import { computeBands } from './audio-bands';
import { commonVertex, commonVertex300 } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, ShaderDef, ShaderRitualConfig } from './types';

/** A user-loaded video bound to an `iChannel<n>` slot. */
interface VideoSlot {
  url: string;
  video: HTMLVideoElement;
  texture: THREE.VideoTexture;
}

/**
 * Renders the active shader as a Shadertoy-style two-pass pipeline:
 *   Buffer A (offscreen render target) -> Image pass (samples it -> screen).
 * Per-element uniforms are refreshed every frame from the live audio bands.
 * Videos (see `videos`) are bound to iChannel1-3 for shaders that declare them.
 */
@customElement('shader-ritual-view')
export class ShaderRitualView extends LitElement {
  private analyser!: Analyser;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.OrthographicCamera;
  private bufferScene!: THREE.Scene;
  private imageScene!: THREE.Scene;
  private bufferTarget!: THREE.WebGLRenderTarget;
  private uniforms: Record<string, { value: any }> = {};
  private currentShaderId = '';
  private startTime = performance.now();
  private lastBands: Bands = { low: 0, mid: 0, high: 0, rawLow: 0, rawMid: 0, rawHigh: 0 };
  private canvas!: HTMLCanvasElement;
  private videoSlots = new Map<number, VideoSlot>();
  private emptyTexture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);

  @property({ type: Object }) config!: ShaderRitualConfig;

  /** Video object URLs keyed by channel (1-3). */
  @property({ type: Object }) videos: Record<number, string> = {};

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

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.init();
  }

  updated(changed: Map<string, any>) {
    if (changed.has('config') && this.renderer) {
      if (this.config.activeShader !== this.currentShaderId) this.buildShader();
      if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    }
    if (changed.has('videos') && this.renderer) this.syncVideos();
  }

  private init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bufferScene = new THREE.Scene();
    this.imageScene = new THREE.Scene();
    this.bufferTarget = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    });

    this.emptyTexture.needsUpdate = true;
    this.buildShader();
    this.syncVideos();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    this.renderLoop();
  }

  /** (Re)build materials and quads for the active shader. */
  private buildShader() {
    const def: ShaderDef = getShader(this.config.activeShader);
    this.currentShaderId = def.id;

    // Dispose previous quads/materials.
    this.disposeScene(this.bufferScene);
    this.disposeScene(this.imageScene);

    // Shared uniform set — both passes read from the same object.
    this.uniforms = {
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      iChannel0: { value: this.bufferTarget.texture },
      iChannel1: { value: this.emptyTexture },
      iChannel2: { value: this.emptyTexture },
      iChannel3: { value: this.emptyTexture },
      iChannelResolution: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
    };
    for (const el of def.elements) {
      this.uniforms[`${el.id}_react`] = { value: 0 };
      this.uniforms[`${el.id}_visible`] = { value: 1 };
    }

    const vertexShader = def.glsl3 ? commonVertex300 : commonVertex;
    const glslVersion = def.glsl3 ? THREE.GLSL3 : null;
    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader: def.bufferShader,
      glslVersion,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader: def.imageShader,
      glslVersion,
    });

    const quad = new THREE.PlaneGeometry(2, 2);
    this.bufferScene.add(new THREE.Mesh(quad, bufferMat));
    this.imageScene.add(new THREE.Mesh(quad.clone(), imageMat));
    this.bindVideos();
    this.resize();
  }

  /** Create / drop video elements so they match the `videos` property. */
  private syncVideos() {
    for (const [channel, slot] of this.videoSlots) {
      if (this.videos[channel] === slot.url) continue;
      slot.video.pause();
      slot.video.removeAttribute('src');
      slot.video.load();
      slot.texture.dispose();
      this.videoSlots.delete(channel);
    }
    for (const [key, url] of Object.entries(this.videos)) {
      const channel = Number(key);
      if (!url || this.videoSlots.has(channel)) continue;
      const video = document.createElement('video');
      video.src = url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';
      // Resolution is only known once metadata arrives.
      video.addEventListener('loadedmetadata', () => this.bindVideos());
      const texture = new THREE.VideoTexture(video);
      this.videoSlots.set(channel, { url, video, texture });
    }
    this.bindVideos();
  }

  /**
   * Point iChannel1-3 at the loaded videos and play only the ones the active
   * shader actually samples.
   */
  private bindVideos() {
    if (!this.uniforms.iChannelResolution) return;
    const def = getShader(this.config.activeShader);
    const used = new Set((def.videoChannels || []).map((c) => c.channel));
    const res = this.uniforms.iChannelResolution.value as THREE.Vector3[];
    for (let channel = 1; channel <= 3; channel++) {
      const slot = this.videoSlots.get(channel);
      const ready = !!slot && slot.video.videoWidth > 0;
      this.uniforms[`iChannel${channel}`].value = ready ? slot!.texture : this.emptyTexture;
      res[channel].set(ready ? slot!.video.videoWidth : 0, ready ? slot!.video.videoHeight : 0, 1);
      if (!slot) continue;
      if (used.has(channel)) slot.video.play().catch(() => {});
      else slot.video.pause();
    }
  }

  private disposeScene(scene: THREE.Scene | undefined) {
    if (!scene) return;
    for (const child of [...scene.children]) {
      scene.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      (mesh.material as THREE.Material)?.dispose();
    }
  }

  private resize() {
    if (!this.renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const def = getShader(this.currentShaderId);
    const dpr = Math.min(this.renderer.getPixelRatio(), def.maxPixelRatio ?? Infinity);
    this.bufferTarget.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
    (this.uniforms.iResolution.value as THREE.Vector3).set(w * dpr, h * dpr, 1);
  }

  private renderLoop = () => {
    requestAnimationFrame(this.renderLoop);
    if (!this.renderer) return;

    if (this.analyser) {
      this.analyser.update();
      this.lastBands = computeBands(
        this.analyser.data,
        this.config.sensitivity,
        this.config.thresholds,
      );
    }

    const def = getShader(this.config.activeShader);
    const elemCfg = this.config.shaders[def.id]?.elements || {};
    for (const el of def.elements) {
      const c = elemCfg[el.id];
      const bandVal = !c || c.band === 'none' ? 0 : (this.lastBands as any)[c.band];
      this.uniforms[`${el.id}_react`].value = (bandVal || 0) * (c ? c.amount : 0);
      this.uniforms[`${el.id}_visible`].value = c ? (c.visible ? 1 : 0) : 1;
    }

    this.uniforms.iTime.value = (performance.now() - this.startTime) / 1000;

    this.renderer.setRenderTarget(this.bufferTarget);
    this.renderer.render(this.bufferScene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.imageScene, this.camera);
  };

  protected render() {
    return html`<canvas></canvas>`;
  }
}
