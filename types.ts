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
  visible: boolean;
}

/** Saved settings for a single shader (keyed by element id). */
export interface ShaderSetting {
  elements: Record<string, ElementSetting>;
}

/** Global post-processing filter applied to every shader's final frame. */
export type FilterType =
  | 'none'
  | 'pixelate'
  | 'edge'
  | 'chroma'
  | 'posterize'
  | 'scanlines'
  | 'mirror';

/** Settings for the global, audio-reactive post-FX pass. */
export interface FilterSetting {
  /** Which effect is active. */
  type: FilterType;
  /** Base intensity (0..1) applied regardless of audio. */
  amount: number;
  /** Audio band that modulates the intensity. */
  band: Band;
  /** How strongly the band drives the intensity on top of `amount`. */
  react: number;
}

/** Top-level persisted configuration. */
export interface ShaderRitualConfig {
  activeShader: string;
  fftSmoothing: number;
  sensitivity: { low: number; mid: number; high: number };
  thresholds: { low: number; mid: number; high: number };
  shaders: Record<string, ShaderSetting>;
  /** Global audio-reactive post-processing filter. */
  filter: FilterSetting;
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
  /** Image fragment shader (samples Buffer A via iChannel0, draws to screen). */
  imageShader: string;
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
