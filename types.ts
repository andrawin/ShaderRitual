/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/** Audio frequency band a visual element can be wired to. */
export type Band = 'none' | 'low' | 'mid' | 'high';

/** Per-element audio-reactive allocation + visibility. */
export interface ElementSetting {
  band: Band;
  amount: number;
  /** Manual baseline added to the reactive value (drive by hand / MIDI / LFO). */
  level: number;
  visible: boolean;
}

/** Saved settings for a single shader (keyed by element id). */
export interface ShaderSetting {
  elements: Record<string, ElementSetting>;
}

/**
 * How the virtual camera is driven, independent of per-element reactivity:
 *   manual -> a steady orbit at `orbitSpeed`
 *   bpm    -> tempo-locked jump-cuts + drift derived from `bpm`
 *   audio  -> orbit speed / framing pushed by an audio band
 */
export type CameraMode = 'manual' | 'bpm' | 'audio';

/** Global camera / motion rig shared by every shader. */
export interface CameraConfig {
  mode: CameraMode;
  /** Beats per minute used by `bpm` mode (and the on-beat pulse uniform). */
  bpm: number;
  /** Continuous orbit speed (rad/s) for manual / audio modes. */
  orbitSpeed: number;
  /** Distance multiplier around the shader's native framing (1 = default). */
  distance: number;
  /** Normalised height offset (-1..1); each shader scales it to its world. */
  height: number;
  /** Field of view in degrees. */
  fov: number;
  /** Band that drives `audio` mode. */
  audioBand: Band;
  /** Strength of the audio / bpm modulation. */
  reactAmount: number;
  /** 0..1 — how wild the tempo-locked jump-cuts get in `bpm` mode. */
  cutChance: number;
}

/**
 * Audio-gated motion: animation time advances at `idle + level * gain` where
 * `level` is the live audio energy. With `audioGated` on, the scene calms (or
 * freezes, at idle 0) when no sound is coming in.
 */
export interface MotionConfig {
  audioGated: boolean;
  /** Baseline time speed when silent (0 = freeze). */
  idle: number;
  /** How much audio energy accelerates time. */
  gain: number;
}

/** Top-level persisted configuration. */
export interface ShaderRitualConfig {
  activeShader: string;
  fftSmoothing: number;
  sensitivity: { low: number; mid: number; high: number };
  thresholds: { low: number; mid: number; high: number };
  camera: CameraConfig;
  motion: MotionConfig;
  shaders: Record<string, ShaderSetting>;
}

/**
 * One controllable element inside a shader. The renderer auto-creates two
 * uniforms per element: `<id>_react` (band value * amount) and
 * `<id>_visible` (1.0 / 0.0).
 */
export interface ShaderElement {
  id: string;
  name: string;
  description: string;
  defaultBand: Band;
  defaultAmount: number;
  /** Default manual baseline (added to the band-driven value). */
  defaultLevel?: number;
  canHide: boolean;
  defaultVisible: boolean;
}

/** A registered Shadertoy-style multi-pass shader. */
export interface ShaderDef {
  id: string;
  name: string;
  description: string;
  /** Buffer A fragment shader (rendered to an offscreen target). */
  bufferShader: string;
  /**
   * Optional Buffer B fragment shader, exposed to Buffer A as `iChannel1`
   * (repeat-wrapped). Rendered once per shader build — use it for static
   * helper textures such as tiling noise.
   */
  bufferBShader?: string;
  /** Image fragment shader (samples Buffer A via iChannel0, draws to screen). */
  imageShader: string;
  /**
   * When true the buffer passes are compiled as GLSL ES 3.00 (`#version 300 es`)
   * for WebGL2 features such as uint / bit ops. The image pass stays ES 1.00.
   */
  glsl3?: boolean;
  elements: ShaderElement[];
}

/** Live audio band readout (post-sensitivity raw + post-gate values). */
export interface Bands {
  low: number;
  mid: number;
  high: number;
  rawLow: number;
  rawMid: number;
  rawHigh: number;
}
