/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The range of a numeric setting, by dotted config path. MIDI scales a knob
 * across it, and a modulation's depth is a fraction of it.
 */
const RANGES: Record<string, { min: number; max: number }> = {
  'sensitivity.low': { min: 0, max: 5 },
  'sensitivity.mid': { min: 0, max: 5 },
  'sensitivity.high': { min: 0, max: 10 },
  fftSmoothing: { min: 0, max: 0.95 },
  renderScale: { min: 0.25, max: 1 },
  'camera.bpm': { min: 60, max: 200 },
  'camera.orbitSpeed': { min: 0, max: 3 },
  'camera.distance': { min: 0.3, max: 2.5 },
  'camera.height': { min: -1, max: 1 },
  'camera.fov': { min: 20, max: 120 },
  'camera.reactAmount': { min: 0, max: 3 },
  'camera.cutChance': { min: 0, max: 1 },
  'motion.idle': { min: 0, max: 1 },
  'motion.gain': { min: 0, max: 3 },
  'overlay.opacity': { min: 0, max: 1 },
  'model.scale': { min: 0.1, max: 5 },
  'model.opacity': { min: 0, max: 1 },
  'model.posX': { min: -3, max: 3 },
  'model.posY': { min: -3, max: 3 },
  'model.posZ': { min: -3, max: 3 },
  'model.bpm': { min: 0, max: 300 },
  'model.motionAmount': { min: 0, max: 3 },
  'model.quality': { min: 0.25, max: 1 },
  'model.fracture.fragments': { min: 2, max: 250 },
  'video.opacity': { min: 0, max: 1 },
  'video.scale': { min: 0.25, max: 3 },
  'video.speed': { min: 0.1, max: 4 },
  'video.speedAmount': { min: 0, max: 3 },
  'video.surfaceThreshold': { min: 0, max: 1 },
  'video.surfaceSoftness': { min: 0.01, max: 0.6 },
  'video.warp': { min: 0, max: 0.35 },
  'video.sliceDrift': { min: 0, max: 1 },
  'text.opacity': { min: 0, max: 1 },
  'text.size': { min: 0.02, max: 0.3 },
  'text.posX': { min: -1, max: 1 },
  'text.posY': { min: -1, max: 1 },
  'text.lineHeight': { min: 0.8, max: 2.5 },
  'text.wrap': { min: 0.2, max: 1 },
  'text.beats': { min: 1, max: 64 },
  'text.amount': { min: 0, max: 3 },
  'model.capture.opacity': { min: 0, max: 1 },
  'model.capture.scale': { min: 0.1, max: 4 },
  'model.fracture.physics.gravity': { min: 0, max: 4 },
  'model.fracture.physics.burstStrength': { min: 0, max: 4 },
  'model.fracture.physics.spin': { min: 0, max: 5 },
  'model.fracture.physics.restitution': { min: 0, max: 0.95 },
  'model.fracture.physics.implodeStrength': { min: 1, max: 20 },
  'model.fracture.physics.beatThreshold': { min: 0.05, max: 1 },
};

export function paramRange(path: string): { min: number; max: number } {
  if (RANGES[path]) return RANGES[path];
  if (path.startsWith('postfx') && path.endsWith('.amount')) return { min: 0, max: 1 };
  if (path.startsWith('camfx') && (path.endsWith('.amount') || path === 'camfx.key')) return { min: 0, max: 1 };
  if (path.endsWith('.amount')) return { min: 0, max: 3 };
  if (path.endsWith('.level')) return { min: 0, max: 2 };
  if (path.includes('thresholds') || path.includes('Threshold')) return { min: 0, max: 1 };
  return { min: 0, max: 1 };
}

/**
 * Settings a signal may not modulate: ones that rebuild something when they
 * change (render size, model quality, fracture count, tempos) and ones that
 * feed the audio analysis itself, which would chase its own tail.
 */
export function modulatable(path: string): boolean {
  if (path.startsWith('audio.') || path.startsWith('sensitivity.') || path.startsWith('thresholds.')) return false;
  return ![
    'fftSmoothing',
    'renderScale',
    'model.quality',
    'model.fracture.fragments',
    'camera.bpm',
    'model.bpm',
    'text.beats',
  ].includes(path);
}
