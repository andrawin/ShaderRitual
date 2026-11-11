/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';

/* Small shared pieces for the scene shaders. */

export type Uniforms = Record<string, { value: any }>;

/** Linear colour from a uniform holding sRGB 0..1, as the colour elements do. */
export function linColour(v: THREE.Vector3, out: THREE.Color): THREE.Color {
  return out.setRGB(v.x, v.y, v.z, THREE.SRGBColorSpace);
}

export const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

export const react = (u: Uniforms, id: string) => Math.max(0, (u[`${id}_react`]?.value as number) ?? 0);
export const shown = (u: Uniforms, id: string) => ((u[`${id}_visible`]?.value as number) ?? 1) > 0.5;

/** A sharp pulse on each beat, scaled by the camera's react amount. */
export function beatPulse(u: Uniforms): number {
  return Math.pow(Math.sin(((u.iBeat.value as number) % 1) * Math.PI * 2) * 0.5 + 0.5, 6) * (u.iCamReact.value as number);
}

/** Which option a menu element is on. */
export function option(u: Uniforms, id: string, count: number): number {
  return Math.floor((Math.min(1.999, Math.max(0, react(u, id))) * count) / 2);
}

/** A closed Catmull-Rom loop through points; `s` is in points, any value. */
export function loopPoint(pts: number[][], s: number, out: THREE.Vector3): THREE.Vector3 {
  const n = pts.length;
  const i = Math.floor(s);
  const f = s - i;
  const p = (k: number) => pts[(((i + k) % n) + n) % n];
  const a = p(-1), b = p(0), c = p(1), d = p(2);
  const f2 = f * f, f3 = f2 * f;
  const w0 = -0.5 * f3 + f2 - 0.5 * f;
  const w1 = 1.5 * f3 - 2.5 * f2 + 1;
  const w2 = -1.5 * f3 + 2 * f2 + 0.5 * f;
  const w3 = 0.5 * f3 - 0.5 * f2;
  return out.set(
    a[0] * w0 + b[0] * w1 + c[0] * w2 + d[0] * w3,
    a[1] * w0 + b[1] * w1 + c[1] * w2 + d[1] * w3,
    a[2] * w0 + b[2] * w1 + c[2] * w2 + d[2] * w3,
  );
}

/**
 * Walks a camera round a loop, looking ahead. The look direction is slewed,
 * so where the path doubles back the walker turns round instead of snapping.
 */
export class Walker {
  private dir = new THREE.Vector3(0, 0, 1);
  private want = new THREE.Vector3();
  private ahead = new THREE.Vector3();
  private lastT = -1;
  constructor(private pts: number[][]) {}
  place(camera: THREE.Camera, s: number, t: number, pitch = -0.08, lookAhead = 2.5) {
    loopPoint(this.pts, s, camera.position);
    loopPoint(this.pts, s + lookAhead, this.ahead);
    this.want.subVectors(this.ahead, camera.position);
    this.want.y = 0;
    if (this.want.lengthSq() < 1e-6) this.want.copy(this.dir);
    this.want.normalize();
    const gap = this.lastT < 0 ? 1 : Math.abs(t - this.lastT);
    this.lastT = t;
    // Turn at a walker's pace; after a cut or a pause, land facing the right way.
    const k = gap > 0.25 ? 1 : 1 - Math.exp(-gap * 2.2);
    this.dir.lerp(this.want, k);
    if (this.dir.lengthSq() < 1e-4) this.dir.copy(this.want);
    this.dir.normalize();
    this.ahead.copy(camera.position).add(this.dir).setY(camera.position.y + pitch);
    camera.lookAt(this.ahead);
  }
}

const dustVertex = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uSize;
uniform float uRise;
uniform vec3 uBoxMin;
uniform vec3 uBoxSize;
varying float vA;
void main(){
  vec3 p = position;
  p.x += sin(uTime * 0.13 + aSeed * 30.0) * 0.25;
  p.z += cos(uTime * 0.11 + aSeed * 23.0) * 0.25;
  // Rising motes wrap from the top of the box back to the bottom.
  p.y = uBoxMin.y + mod(p.y - uBoxMin.y + uTime * uRise * (0.5 + aSeed), uBoxSize.y);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize * (0.5 + aSeed) / max(-mv.z, 0.25);
  gl_Position = projectionMatrix * mv;
  vA = (0.35 + 0.65 * fract(aSeed * 91.7)) * (0.6 + 0.4 * sin(uTime * (0.8 + aSeed) + aSeed * 40.0));
}`;
const dustFragment = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main(){
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor * a * vA, 1.0);
}`;

/** Additive motes filling a box: dust, embers or steam, by size and rise. */
export function makeMotes(box: THREE.Box3, count: number) {
  const size = box.getSize(new THREE.Vector3());
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = box.min.x + hash(i * 1.1) * size.x;
    pos[i * 3 + 1] = box.min.y + hash(i * 2.3) * size.y;
    pos[i * 3 + 2] = box.min.z + hash(i * 3.7) * size.z;
    seed[i] = hash(i * 5.9);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const uniforms = {
    uTime: { value: 0 },
    uSize: { value: 10 },
    uRise: { value: 0 },
    uColor: { value: new THREE.Color() },
    uBoxMin: { value: box.min.clone() },
    uBoxSize: { value: size },
  };
  const points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: dustVertex, fragmentShader: dustFragment,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  points.frustumCulled = false;
  return { points, uniforms };
}

/** The placeholder Buffer A of a scene shader. */
export const sceneBuffer = (name: string, file: string) => `
// ${name} is a scene shader: Buffer A is the GLB scene, rendered in three.js
// (shaders/${file}). Edit the image pass to regrade it.
precision highp float;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/** GLSL shared by the scene image passes. */
export const imageHead = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
vec3 aces(vec3 x){
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float grain(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + iTime) * 43758.5453); }
`;
