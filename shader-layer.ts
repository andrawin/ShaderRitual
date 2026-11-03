/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';
import type { CameraUniforms } from './camera';
import { commonVertex, commonVertex3 } from './shaders/common';
import { getShader } from './shader-registry';
import type { Bands, SceneRuntime, ShaderDef, ShaderSetting } from './types';
import { loadSceneGLB } from './scene-loader';

/**
 * '#rrggbb' to 0..1 RGB, kept in sRGB exactly as picked. THREE.Color would
 * convert to linear on the way in, and these shaders write their output raw,
 * so every mid-tone would come out darker and more saturated than the swatch.
 */
export function hexToRgb(hex: string, out: THREE.Vector3): THREE.Vector3 {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || '').trim());
  if (!m) return out.set(1, 1, 1);
  const n = parseInt(m[1], 16);
  return out.set(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** A 1x1 white texture, so iVideo is always bound to something valid. */
let whiteTex: THREE.DataTexture | null = null;
function whiteTexture(): THREE.DataTexture {
  if (!whiteTex) {
    whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteTex.needsUpdate = true;
  }
  return whiteTex;
}

/**
 * One shader's full render pipeline — ping-pong feedback (`iChannel0`), an
 * optional static Buffer B (`iChannel1`) and the per-element uniforms — drawn
 * into a caller-supplied output target. Extracted from the view so it can run
 * twice: once for the base shader and once for an overlay layer that gets
 * composited on top.
 */
export class ShaderLayer {
  private bufferScene = new THREE.Scene();
  private imageScene = new THREE.Scene();
  private bufferBScene = new THREE.Scene();
  private targetA: THREE.WebGLRenderTarget;
  private targetB: THREE.WebGLRenderTarget;
  private readTarget: THREE.WebGLRenderTarget;
  private writeTarget: THREE.WebGLRenderTarget;
  private bufferBTarget: THREE.WebGLRenderTarget;
  private hasBufferB = false;
  private quad = new THREE.PlaneGeometry(2, 2);

  // Scene shaders: an HDR, depth-buffered target the scene draws into in place
  // of Buffer A, and the runtimes already built, keyed by URL, so cutting back
  // to a scene is instant rather than a re-parse.
  private sceneTarget: THREE.WebGLRenderTarget;
  private sceneRuntime: SceneRuntime | null = null;
  private sceneCache = new Map<string, SceneRuntime>();
  private sceneToken = 0;
  private size = new THREE.Vector2(1, 1);

  uniforms: Record<string, { value: any }> = {};
  currentShaderId = '';

  // Live-coding source overrides (base layer only).
  private overrideBuffer: string | null = null;
  private overrideImage: string | null = null;

  /** `errorSink.error` is written by the renderer's shared onShaderError. */
  constructor(
    private renderer: THREE.WebGLRenderer,
    private errorSink: { error: string },
  ) {
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
    };
    this.targetA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.targetB = new THREE.WebGLRenderTarget(1, 1, opts);
    this.readTarget = this.targetA;
    this.writeTarget = this.targetB;
    this.bufferBTarget = new THREE.WebGLRenderTarget(1024, 1024, opts);
    // Half float so emissive light above 1.0 survives to the bloom and the
    // tone map in the image pass, instead of clipping flat at white.
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      type: THREE.HalfFloatType,
      depthBuffer: true,
    });
    this.bufferBTarget.texture.wrapS = THREE.RepeatWrapping;
    this.bufferBTarget.texture.wrapT = THREE.RepeatWrapping;
  }

  /** (Re)build materials + uniforms for a shader id. */
  build(shaderId: string) {
    const def: ShaderDef = getShader(shaderId);
    this.currentShaderId = def.id;
    this.overrideBuffer = null;
    this.overrideImage = null;

    this.disposeScene(this.bufferScene);
    this.disposeScene(this.imageScene);
    this.disposeScene(this.bufferBScene);

    this.uniforms = {
      iResolution: { value: new THREE.Vector3(1, 1, 1) },
      iTime: { value: 0 },
      iChannel0: { value: this.readTarget.texture },
      iChannel1: { value: this.bufferBTarget.texture },
      iCamOrbit: { value: 0 },
      iCamDist: { value: 1 },
      iCamHeight: { value: 0 },
      iCamFov: { value: 60 },
      iCamReact: { value: 0 },
      iBeat: { value: 0 },
      // The loaded clip, for shaders that map it onto their own geometry
      // rather than letting it composite over the frame. Bound to a 1x1 white
      // texture when nothing is loaded, because sampling an unbound sampler is
      // undefined — a shader that reads it must gate on iVideoOn.
      iVideo: { value: whiteTexture() },
      iVideoOn: { value: 0 },
      iVideoAspect: { value: 16 / 9 },
    };
    for (const el of def.elements) {
      this.uniforms[`${el.id}_react`] = { value: 0 };
      this.uniforms[`${el.id}_visible`] = { value: 1 };
      if (el.defaultColor) {
        this.uniforms[`${el.id}_color`] = { value: hexToRgb(el.defaultColor, new THREE.Vector3()) };
      }
    }

    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: def.glsl3 ? commonVertex3 : commonVertex,
      fragmentShader: def.bufferShader,
      glslVersion: def.glsl3 ? THREE.GLSL3 : null,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: def.imageShader,
    });
    this.bufferScene.add(new THREE.Mesh(this.quad, bufferMat));
    this.imageScene.add(new THREE.Mesh(this.quad, imageMat));

    this.startScene(def);

    this.hasBufferB = !!def.bufferBShader;
    if (this.hasBufferB) {
      const bufferBMat = new THREE.RawShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: commonVertex,
        fragmentShader: def.bufferBShader!,
      });
      this.bufferBScene.add(new THREE.Mesh(this.quad, bufferBMat));
    }
  }

  /**
   * Bring up the scene behind a scene shader: from cache if this layer has
   * built it before, otherwise load and set it up in the background. Frames
   * drawn meanwhile come out black. A load that finishes after the layer has
   * moved on is still cached, but not shown.
   */
  private startScene(def: ShaderDef) {
    const token = ++this.sceneToken;
    this.sceneRuntime = null;
    const spec = def.scene;
    if (!spec) return;
    const cached = this.sceneCache.get(spec.url);
    if (cached) {
      cached.resize?.(this.size.x, this.size.y);
      this.sceneRuntime = cached;
      return;
    }
    loadSceneGLB(spec.url)
      .then((root) => {
        const rt = spec.setup(root, this.renderer);
        rt.resize?.(this.size.x, this.size.y);
        this.sceneCache.set(spec.url, rt);
        if (token === this.sceneToken) this.sceneRuntime = rt;
      })
      .catch((e) => {
        if (token === this.sceneToken) {
          this.errorSink.error = `Could not load scene ${spec.url}: ${e?.message || e}`;
        }
      });
  }

  /** Render Buffer B once (static helper texture); call after build + resize. */
  renderBufferB(camera: THREE.Camera) {
    if (!this.hasBufferB) return;
    this.renderer.setRenderTarget(this.bufferBTarget);
    this.renderer.render(this.bufferBScene, camera);
    this.renderer.setRenderTarget(null);
  }

  resize(pw: number, ph: number) {
    this.targetA.setSize(pw, ph);
    this.targetB.setSize(pw, ph);
    this.sceneTarget.setSize(pw, ph);
    this.size.set(pw, ph);
    this.sceneRuntime?.resize?.(pw, ph);
    (this.uniforms.iResolution?.value as THREE.Vector3)?.set(pw, ph, 1);
  }

  /** Push the per-frame uniform values (time, camera, element react/visible). */
  /** Hand the layer the live clip, or null when there is none. */
  setVideo(tex: THREE.Texture | null, aspect: number) {
    if (!this.uniforms || !this.uniforms.iVideo) return;
    this.uniforms.iVideo.value = tex || whiteTexture();
    this.uniforms.iVideoOn.value = tex ? 1 : 0;
    this.uniforms.iVideoAspect.value = aspect > 0 ? aspect : 16 / 9;
  }

  setUniforms(time: number, cam: CameraUniforms, bands: Bands, elemCfg: ShaderSetting['elements']) {
    const def = getShader(this.currentShaderId);
    for (const el of def.elements) {
      const c = elemCfg[el.id];
      const bandVal = !c || c.band === 'none' ? 0 : (bands as any)[c.band];
      const level = c ? c.level || 0 : 0;
      this.uniforms[`${el.id}_react`].value = level + (bandVal || 0) * (c ? c.amount : 0);
      this.uniforms[`${el.id}_visible`].value = c ? (c.visible ? 1 : 0) : 1;
      if (el.defaultColor && this.uniforms[`${el.id}_color`]) {
        hexToRgb(c?.color || el.defaultColor, this.uniforms[`${el.id}_color`].value);
      }
    }
    this.uniforms.iTime.value = time;
    this.uniforms.iCamOrbit.value = cam.orbit;
    this.uniforms.iCamDist.value = cam.dist;
    this.uniforms.iCamHeight.value = cam.height;
    this.uniforms.iCamFov.value = cam.fov;
    this.uniforms.iCamReact.value = cam.react;
    this.uniforms.iBeat.value = cam.beat;
  }

  /** Render the feedback buffer + image pass into `output`. */
  render(camera: THREE.Camera, output: THREE.WebGLRenderTarget) {
    if (getShader(this.currentShaderId).scene) {
      // The scene stands in for Buffer A; the image pass grades it as usual.
      // The scene may change the clear colour; nothing else in the app should
      // inherit that.
      const cc = this.renderer.getClearColor(new THREE.Color());
      const ca = this.renderer.getClearAlpha();
      if (this.sceneRuntime) {
        this.sceneRuntime.update(this.uniforms);
        this.sceneRuntime.render(this.renderer, this.sceneTarget);
      } else {
        this.renderer.setRenderTarget(this.sceneTarget);
        this.renderer.setClearColor(0x000000, 1);
        this.renderer.clear(true, true, false);
      }
      this.renderer.setClearColor(cc, ca);
      this.uniforms.iChannel0.value = this.sceneTarget.texture;
      this.renderer.setRenderTarget(output);
      this.renderer.render(this.imageScene, camera);
      return;
    }
    this.uniforms.iChannel0.value = this.readTarget.texture;
    this.renderer.setRenderTarget(this.writeTarget);
    this.renderer.render(this.bufferScene, camera);

    this.uniforms.iChannel0.value = this.writeTarget.texture;
    this.renderer.setRenderTarget(output);
    this.renderer.render(this.imageScene, camera);

    const tmp = this.readTarget;
    this.readTarget = this.writeTarget;
    this.writeTarget = tmp;
  }

  /* ---------------------- Live-coding support ---------------------- */

  getActiveSource(): { buffer: string; image: string } {
    const def = getShader(this.currentShaderId);
    return {
      buffer: this.overrideBuffer ?? def.bufferShader,
      image: this.overrideImage ?? def.imageShader,
    };
  }

  resetSource(camera: THREE.Camera) {
    const def = getShader(this.currentShaderId);
    this.applySource(def.bufferShader, def.imageShader, camera);
    this.overrideBuffer = null;
    this.overrideImage = null;
    this.errorSink.error = '';
  }

  applySource(bufferSrc: string, imageSrc: string, camera: THREE.Camera): string | null {
    const bufMesh = this.bufferScene.children[0] as THREE.Mesh;
    const imgMesh = this.imageScene.children[0] as THREE.Mesh;
    if (!bufMesh || !imgMesh) return 'Renderer not ready';

    const oldBuf = bufMesh.material as THREE.Material;
    const oldImg = imgMesh.material as THREE.Material;
    const glsl3 = !!getShader(this.currentShaderId).glsl3;

    const bufferMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: glsl3 ? commonVertex3 : commonVertex,
      fragmentShader: bufferSrc,
      glslVersion: glsl3 ? THREE.GLSL3 : null,
    });
    const imageMat = new THREE.RawShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: commonVertex,
      fragmentShader: imageSrc,
    });

    this.errorSink.error = '';
    bufMesh.material = bufferMat;
    imgMesh.material = imageMat;
    this.renderer.compile(this.bufferScene, camera);
    this.renderer.compile(this.imageScene, camera);

    if (this.errorSink.error) {
      bufMesh.material = oldBuf;
      imgMesh.material = oldImg;
      bufferMat.dispose();
      imageMat.dispose();
      return this.errorSink.error;
    }
    oldBuf.dispose();
    oldImg.dispose();
    this.overrideBuffer = bufferSrc;
    this.overrideImage = imageSrc;
    return null;
  }

  getUniformSnapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of Object.keys(this.uniforms)) {
      const v = this.uniforms[key].value;
      if (typeof v === 'number') out[key] = v;
    }
    return out;
  }

  private disposeScene(scene: THREE.Scene) {
    for (const child of [...scene.children]) {
      scene.remove(child);
      (child as THREE.Mesh).material && ((child as THREE.Mesh).material as THREE.Material).dispose();
    }
  }
}
