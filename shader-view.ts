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
import { commonVertex } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, ShaderDef, ShaderRitualConfig } from './types';

/**
 * Renders the active shader as a Shadertoy-style two-pass pipeline:
 *   Buffer A (offscreen render target) -> Image pass (samples it -> screen).
 * Per-element uniforms are refreshed every frame from the live audio bands.
 */
@customElement('shader-ritual-view')
export class ShaderRitualView extends LitElement {
  private analyser!: Analyser;
  private renderer!: THREE.WebGLRenderer;
  private camera!: THREE.OrthographicCamera;
  private bufferScene!: THREE.Scene;
  private imageScene!: THREE.Scene;
  // Ping-pong targets so a Buffer-A pass can read its own previous frame
  // (frame feedback) via iChannel0 without reading the texture it writes.
  private targetA!: THREE.WebGLRenderTarget;
  private targetB!: THREE.WebGLRenderTarget;
  private readTarget!: THREE.WebGLRenderTarget;
  private writeTarget!: THREE.WebGLRenderTarget;
  private uniforms: Record<string, { value: any }> = {};
  private currentShaderId = '';
  private lastFrame = performance.now();
  private animTime = 0; // audio-gated animation clock fed to shaders as iTime
  private cameraRig = new CameraRig();
  private lastBands: Bands = { low: 0, mid: 0, high: 0, rawLow: 0, rawMid: 0, rawHigh: 0 };
  private canvas!: HTMLCanvasElement;

  // Live-coding source overrides (per active shader) + last compile error.
  private overrideBuffer: string | null = null;
  private overrideImage: string | null = null;
  private lastError = '';

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

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas')!;
    this.init();
  }

  updated(changed: Map<string, any>) {
    if (changed.has('config') && this.renderer) {
      if (this.config.activeShader !== this.currentShaderId) this.buildShader();
      if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    }
  }

  private init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    // Capture GLSL compile/link errors so the code panel can surface them
    // (and so a bad live edit can be rejected instead of crashing the view).
    this.renderer.debug.onShaderError = (gl, _program, _vs, fs) => {
      const log = gl.getShaderInfoLog(fs) || '';
      this.lastError = log.trim() || 'Shader compile error';
    };
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.bufferScene = new THREE.Scene();
    this.imageScene = new THREE.Scene();
    const targetOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    };
    this.targetA = new THREE.WebGLRenderTarget(1, 1, targetOpts);
    this.targetB = new THREE.WebGLRenderTarget(1, 1, targetOpts);
    this.readTarget = this.targetA;
    this.writeTarget = this.targetB;

    this.buildShader();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (this.analyser) this.analyser.smoothing = this.config.fftSmoothing;
    this.renderLoop();
  }

  /** (Re)build materials and quads for the active shader. */
  private buildShader() {
    const def: ShaderDef = getShader(this.config.activeShader);
    this.currentShaderId = def.id;
    // Switching shaders drops any live-coding edits and starts from source.
    this.overrideBuffer = null;
    this.overrideImage = null;
    this.lastError = '';

    // Dispose previous quads/materials.
    this.disposeScene(this.bufferScene);
    this.disposeScene(this.imageScene);

    // Shared uniform set — both passes read from the same object.
    this.uniforms = {
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      iChannel0: { value: this.readTarget.texture },
      // Global camera / motion rig — available to every shader.
      iCamOrbit: { value: 0 },
      iCamDist: { value: 1 },
      iCamHeight: { value: 0 },
      iCamFov: { value: 60 },
      iCamReact: { value: 0 },
      iBeat: { value: 0 },
    };
    for (const el of def.elements) {
      this.uniforms[`${el.id}_react`] = { value: 0 };
      this.uniforms[`${el.id}_visible`] = { value: 1 };
    }

    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: def.bufferShader,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: def.imageShader,
    });

    const quad = new THREE.PlaneGeometry(2, 2);
    this.bufferScene.add(new THREE.Mesh(quad, bufferMat));
    this.imageScene.add(new THREE.Mesh(quad.clone(), imageMat));
    this.resize();
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
    const dpr = this.renderer.getPixelRatio();
    const pw = Math.floor(w * dpr);
    const ph = Math.floor(h * dpr);
    this.targetA.setSize(pw, ph);
    this.targetB.setSize(pw, ph);
    (this.uniforms.iResolution.value as THREE.Vector3).set(pw, ph, 1);
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
      // react = manual baseline + audio-driven value, so an element can be
      // driven by hand (band = None) or by audio, or both.
      const level = c ? c.level || 0 : 0;
      this.uniforms[`${el.id}_react`].value = level + (bandVal || 0) * (c ? c.amount : 0);
      this.uniforms[`${el.id}_visible`].value = c ? (c.visible ? 1 : 0) : 1;
    }

    // Audio-gated animation clock: time advances at idle + level*gain, so the
    // scene calms (or freezes at idle 0) when no sound is coming in.
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const m = this.config.motion;
    const energy = Math.max(this.lastBands.low, this.lastBands.mid, this.lastBands.high);
    const speed = m && m.audioGated ? m.idle + energy * m.gain : 1;
    const motionDt = dt * speed;
    this.animTime += motionDt;
    const time = this.animTime;
    this.uniforms.iTime.value = time;

    // Drive the shared camera uniforms from the global motion rig (gated too).
    const cam = this.cameraRig.update(motionDt, time, this.config.camera, this.lastBands);
    this.uniforms.iCamOrbit.value = cam.orbit;
    this.uniforms.iCamDist.value = cam.dist;
    this.uniforms.iCamHeight.value = cam.height;
    this.uniforms.iCamFov.value = cam.fov;
    this.uniforms.iCamReact.value = cam.react;
    this.uniforms.iBeat.value = cam.beat;

    // Buffer A reads the previous frame (readTarget) and renders into
    // writeTarget; the Image pass then samples the just-written frame.
    this.uniforms.iChannel0.value = this.readTarget.texture;
    this.renderer.setRenderTarget(this.writeTarget);
    this.renderer.render(this.bufferScene, this.camera);

    this.uniforms.iChannel0.value = this.writeTarget.texture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.imageScene, this.camera);

    // Swap so this frame's output becomes next frame's feedback input.
    const tmp = this.readTarget;
    this.readTarget = this.writeTarget;
    this.writeTarget = tmp;
  };

  /* ---------------------- Live-coding support ---------------------- */

  /** Active GLSL for the current shader (edited override if present). */
  getActiveSource(): { buffer: string; image: string } {
    const def = getShader(this.config?.activeShader);
    return {
      buffer: this.overrideBuffer ?? def.bufferShader,
      image: this.overrideImage ?? def.imageShader,
    };
  }

  /** Restore the original (registry) source for the active shader. */
  resetSource() {
    const def = getShader(this.config.activeShader);
    this.applySource(def.bufferShader, def.imageShader);
    this.overrideBuffer = null;
    this.overrideImage = null;
    this.lastError = '';
  }

  /**
   * Compile and swap in edited GLSL. Returns null on success or the compile
   * log on failure (in which case the previous working material is kept).
   */
  applySource(bufferSrc: string, imageSrc: string): string | null {
    const bufMesh = this.bufferScene.children[0] as THREE.Mesh;
    const imgMesh = this.imageScene.children[0] as THREE.Mesh;
    if (!bufMesh || !imgMesh) return 'Renderer not ready';

    const oldBuf = bufMesh.material as THREE.Material;
    const oldImg = imgMesh.material as THREE.Material;

    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: bufferSrc,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: imageSrc,
    });

    this.lastError = '';
    bufMesh.material = bufferMat;
    imgMesh.material = imageMat;
    // Force a real render so each program's first-use link check runs and, on
    // failure, fires onShaderError (which sets lastError). compile() alone
    // defers that check to first use, so it wouldn't catch a bad edit here.
    this.uniforms.iChannel0.value = this.readTarget.texture;
    this.renderer.setRenderTarget(this.writeTarget);
    this.renderer.render(this.bufferScene, this.camera);
    this.renderer.render(this.imageScene, this.camera);
    this.renderer.setRenderTarget(null);

    if (this.lastError) {
      bufMesh.material = oldBuf;
      imgMesh.material = oldImg;
      bufferMat.dispose();
      imageMat.dispose();
      return this.lastError;
    }

    oldBuf.dispose();
    oldImg.dispose();
    this.overrideBuffer = bufferSrc;
    this.overrideImage = imageSrc;
    return null;
  }

  /** Snapshot of the live uniform values for the on-screen code/value panel. */
  getUniformSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of Object.keys(this.uniforms)) {
      const v = this.uniforms[key].value;
      if (typeof v === 'number') out[key] = v;
    }
    return out;
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}
