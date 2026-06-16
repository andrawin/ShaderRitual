/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Bands, CameraConfig } from './types';

/**
 * CPU-side camera rig. Turns the global {@link CameraConfig} (plus the live
 * audio bands) into a small set of uniforms every shader can consume the same
 * way, so a single set of motion controls drives any scene:
 *
 *   iCamOrbit  -> orbit angle in radians (universal)
 *   iCamDist   -> distance multiplier around the shader's native framing
 *   iCamHeight -> normalised height offset (-1..1); shaders scale to their world
 *   iCamFov    -> field of view in degrees
 *   iCamReact  -> 0..1 motion energy (beat pulse / audio level)
 *   iBeat      -> continuous beat phase = time * bpm / 60
 *
 * The `bpm` mode reproduces the tempo-locked jump-cut feel of the reference
 * shader via {@link stepNoise}; `audio` mode integrates orbit speed so loud
 * passages spin and push in faster.
 */

const PI2 = Math.PI * 2;

const hash = (x: number) => {
  const s = Math.sin(x) * 43758.5453;
  return s - Math.floor(s);
};

const fract = (x: number) => x - Math.floor(x);

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Discrete-but-eased noise: holds a random level per integer step of `x` and
 * smoothly blends to the next. `n` controls how many distinct levels exist.
 * Returns roughly [-0.5, 0.5]. Mirrors the GLSL helper in the reference shader.
 */
export function stepNoise(x: number, n: number): number {
  n = Math.max(n, 2);
  const i = Math.floor(x);
  const s = 0.2;
  const u = smoothstep(0.5 - s, 0.5 + s, fract(x));
  const res = lerp(Math.floor(hash(i) * n), Math.floor(hash(i + 1) * n), u);
  return res / (n - 1) - 0.5;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export interface CameraUniforms {
  orbit: number;
  dist: number;
  height: number;
  fov: number;
  react: number;
  beat: number;
}

export class CameraRig {
  /** Integrated orbit angle for manual / audio modes. */
  private orbitPhase = 0;

  /**
   * Advance the rig by `dt` seconds at absolute `time`, returning the uniforms
   * for this frame.
   */
  update(dt: number, time: number, cam: CameraConfig, bands: Bands): CameraUniforms {
    const beat = (time * cam.bpm) / 60;
    const bandVal = cam.audioBand === 'none' ? 0 : (bands as any)[cam.audioBand] || 0;
    const audio = Math.min(1, bandVal * cam.reactAmount);

    let orbit: number;
    let height = cam.height;
    let dist = cam.distance;
    let fov = cam.fov;
    let react = 0;

    if (cam.mode === 'bpm') {
      // Tempo-locked: hold a framing for a bar, then cut to a new one.
      const T = beat / 2;
      const levels = Math.round(2 + cam.cutChance * 4); // 2..6 distinct shots
      const na = stepNoise(T, 2);
      orbit = na + Math.sign(na) * T * 0.2; // jump + slow drift (as in reference)
      height = clamp(cam.height + stepNoise(T + 500, levels), -1, 1);
      dist = Math.max(0.2, cam.distance * (1 + stepNoise(T + 1000, levels) * 0.6));
      fov = cam.fov + stepNoise(T + 1500, 3) * 20 * (0.4 + cam.cutChance);
      // Cubic pulse that peaks on every beat.
      react = Math.pow(Math.sin(fract(beat) * PI2) * 0.5 + 0.5, 3);
    } else if (cam.mode === 'audio') {
      // Louder passages orbit faster and push the camera in.
      this.orbitPhase += dt * (cam.orbitSpeed + audio * 2);
      orbit = this.orbitPhase;
      height = clamp(cam.height + audio * 0.4, -1, 1);
      dist = Math.max(0.2, cam.distance * (1 - audio * 0.25));
      fov = cam.fov + audio * 15;
      react = audio;
    } else {
      // manual: steady orbit, fixed framing.
      this.orbitPhase += dt * cam.orbitSpeed;
      orbit = this.orbitPhase;
    }

    return { orbit, dist, height, fov, react, beat };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
