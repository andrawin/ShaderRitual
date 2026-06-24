/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  CameraConfig,
  MotionConfig,
  PostFXConfig,
  ShaderDef,
  ShaderRitualConfig,
  ShaderSetting,
} from './types';
import { sanctum } from './shaders/sanctum';
import { cathedral } from './shaders/cathedral';
import { phantom } from './shaders/phantom';
import { mandala } from './shaders/mandala';
import { cosa } from './shaders/cosa';
import { thunder } from './shaders/thunder';
import { pulsar } from './shaders/pulsar';
import { alive } from './shaders/alive';
import { chrome } from './shaders/chrome';

/** All registered shaders. Add new shaders here. */
export const SHADERS: ShaderDef[] = [
  sanctum,
  cathedral,
  phantom,
  mandala,
  cosa,
  thunder,
  pulsar,
  alive,
  chrome,
];

/** Fresh camera / motion rig defaults. */
export function defaultCamera(): CameraConfig {
  return {
    mode: 'bpm',
    bpm: 128,
    orbitSpeed: 0.3,
    distance: 1.0,
    height: 0.0,
    fov: 60,
    audioBand: 'low',
    reactAmount: 1.5,
    cutChance: 0.5,
  };
}

export function getShader(id: string): ShaderDef {
  return SHADERS.find((s) => s.id === id) || SHADERS[0];
}

/** Fresh audio-gated motion defaults (gentle drift when silent). */
export function defaultMotion(): MotionConfig {
  return { audioGated: true, idle: 0.12, gain: 1.2 };
}

/** Merge a saved post-FX config over the defaults, per filter. */
function mergePostFX(base: PostFXConfig, saved: any): PostFXConfig {
  if (!saved || typeof saved !== 'object') return base;
  const out = { ...base } as PostFXConfig;
  (Object.keys(base) as (keyof PostFXConfig)[]).forEach((k) => {
    if (saved[k]) out[k] = { ...base[k], ...saved[k] };
  });
  return out;
}

/** Fresh global post-FX defaults (all off). */
export function defaultPostFX(): PostFXConfig {
  return {
    pixelate: { on: false, amount: 0.4, band: 'none' },
    edge: { on: false, amount: 0.6, band: 'none' },
    posterize: { on: false, amount: 0.5, band: 'none' },
    rgbShift: { on: false, amount: 0.4, band: 'none' },
    scanlines: { on: false, amount: 0.5, band: 'none' },
  };
}

/** Build the per-shader element settings from a shader's declared defaults. */
function defaultShaderSetting(def: ShaderDef): ShaderSetting {
  const elements: ShaderSetting['elements'] = {};
  for (const el of def.elements) {
    elements[el.id] = {
      band: el.defaultBand,
      amount: el.defaultAmount,
      level: el.defaultLevel ?? 0,
      visible: el.defaultVisible,
    };
  }
  return { elements };
}

/** Fresh configuration covering every registered shader. */
export function defaultConfig(): ShaderRitualConfig {
  const shaders: Record<string, ShaderSetting> = {};
  for (const def of SHADERS) shaders[def.id] = defaultShaderSetting(def);
  return {
    activeShader: SHADERS[0].id,
    fftSmoothing: 0.7,
    sensitivity: { low: 1.5, mid: 1.5, high: 2.5 },
    thresholds: { low: 0.15, mid: 0.15, high: 0.15 },
    camera: defaultCamera(),
    motion: defaultMotion(),
    overlay: { enabled: false, shader: 'pulsar', blend: 'add', opacity: 1 },
    postfx: defaultPostFX(),
    model: { visible: true, scale: 1, opacity: 1, posX: 0, posY: 0, posZ: 0, bpm: 0 },
    shaders,
  };
}

/**
 * Merge a (possibly stale) saved config over current registry defaults so new
 * shaders / elements always appear with sane defaults.
 */
export function sanitizeConfig(saved: any): ShaderRitualConfig {
  const base = defaultConfig();
  if (!saved || typeof saved !== 'object') return base;

  const merged: ShaderRitualConfig = {
    ...base,
    ...saved,
    sensitivity: { ...base.sensitivity, ...(saved.sensitivity || {}) },
    thresholds: { ...base.thresholds, ...(saved.thresholds || {}) },
    camera: { ...base.camera, ...(saved.camera || {}) },
    motion: { ...base.motion, ...(saved.motion || {}) },
    overlay: { ...base.overlay, ...(saved.overlay || {}) },
    postfx: mergePostFX(base.postfx, saved.postfx),
    model: { ...base.model, ...(saved.model || {}) },
    shaders: { ...base.shaders },
  };

  for (const def of SHADERS) {
    const savedShader = saved.shaders?.[def.id];
    const baseShader = base.shaders[def.id];
    const elements = { ...baseShader.elements };
    for (const el of def.elements) {
      const savedEl = savedShader?.elements?.[el.id];
      if (savedEl) elements[el.id] = { ...elements[el.id], ...savedEl };
    }
    merged.shaders[def.id] = { elements };
  }

  if (!SHADERS.some((s) => s.id === merged.activeShader)) {
    merged.activeShader = base.activeShader;
  }
  if (!SHADERS.some((s) => s.id === merged.overlay.shader)) {
    merged.overlay = { ...merged.overlay, shader: base.overlay.shader };
  }
  return merged;
}
