/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AudioConfig, AudioSignal, Bands, Modulation } from './types';
import { modulatable, paramRange } from './param-ranges';

/*
 * Audio signals, in the spirit of TouchDesigner's Audio Spectrum, Lag, Math and
 * Analyze CHOPs: a frequency range drawn on the spectrum becomes a named 0..1
 * control value, shaped per signal, and any numeric setting can follow it.
 *
 * Each frame, per signal:
 *   level   the range's power, from a dedicated unsmoothed float FFT, in dB,
 *           mapped -85..-15 dB to 0..1
 *   auto    optionally scaled between the signal's own recent floor and peak,
 *           which drift to follow the room and the mix
 *   gain    multiplied, then
 *   gate    anything under it reads as 0, the rest is stretched to 0..1
 *   lag     followed with separate attack and release times (one-pole)
 *   curve   raised to a power: above 1 punchier, below 1 softer
 *
 * The analyser here is separate from the one the low/mid/high bands use:
 * those keep the global FFT smoothing, while signals see every transient and
 * leave the smoothing to each one's own attack and release.
 */

export const SIGNAL_PRESETS: Omit<AudioSignal, 'id'>[] = [
  { name: 'Kick', color: '#ff4d4d', lo: 40, hi: 100, auto: true, gain: 1, gate: 0.3, attack: 0.004, release: 0.14, curve: 2 },
  { name: 'Bass', color: '#ff9f1c', lo: 60, hi: 250, auto: true, gain: 1, gate: 0.15, attack: 0.03, release: 0.35, curve: 1.2 },
  { name: 'Snare', color: '#ffd93d', lo: 1500, hi: 4500, auto: true, gain: 1, gate: 0.35, attack: 0.004, release: 0.12, curve: 2 },
  { name: 'Hats', color: '#4dd2ff', lo: 7000, hi: 14000, auto: true, gain: 1, gate: 0.35, attack: 0.002, release: 0.06, curve: 1.6 },
  { name: 'Vocal', color: '#c77dff', lo: 300, hi: 3000, auto: true, gain: 1, gate: 0.2, attack: 0.05, release: 0.4, curve: 1 },
  { name: 'Air', color: '#e0e0e0', lo: 12000, hi: 18000, auto: true, gain: 1, gate: 0.2, attack: 0.02, release: 0.3, curve: 1 },
];

export function newSignalId(existing: AudioSignal[]): string {
  let i = existing.length + 1;
  while (existing.some((s) => s.id === `sig${i}`)) i++;
  return `sig${i}`;
}

export function defaultAudio(): AudioConfig {
  // Kick, Snare and Hats to start with: the three a drum-led set wants most.
  const signals = [0, 2, 3].map((p, i) => ({ id: `sig${i + 1}`, ...SIGNAL_PRESETS[p] }));
  return { signals, mods: [] };
}

/** Keep a saved audio config well-formed. */
export function mergeAudio(base: AudioConfig, saved: any): AudioConfig {
  if (!saved || typeof saved !== 'object') return base;
  const reserved = new Set(['none', 'low', 'mid', 'high', 'rawLow', 'rawMid', 'rawHigh']);
  const signals: AudioSignal[] = Array.isArray(saved.signals)
    ? saved.signals
        .filter((s: any) => s && typeof s.id === 'string' && !reserved.has(s.id))
        .map((s: any) => ({ ...SIGNAL_PRESETS[0], ...s }))
    : base.signals;
  const ids = new Set(['low', 'mid', 'high', ...signals.map((s) => s.id)]);
  const mods: Modulation[] = Array.isArray(saved.mods)
    ? saved.mods.filter((m: any) => m && ids.has(m.source) && typeof m.target === 'string')
    : [];
  return { signals, mods };
}

const DB_FLOOR = -85;
const DB_RANGE = 70;
const F_MIN = 20;
const F_MAX = 20000;

/** Position 0..1 of a frequency on the log-frequency axis the editor uses. */
export function freqToX(f: number): number {
  return Math.log(Math.max(F_MIN, f) / F_MIN) / Math.log(F_MAX / F_MIN);
}
export function xToFreq(x: number): number {
  return F_MIN * Math.pow(F_MAX / F_MIN, Math.min(1, Math.max(0, x)));
}

interface SignalState {
  env: number;
  peak: number;
  floor: number;
  level: number;
}

export class SignalEngine {
  private analyser: AnalyserNode;
  private db: Float32Array;
  private sampleRate: number;
  private state = new Map<string, SignalState>();
  /** Last frame's levels before shaping, by id, for the editor's meters. */
  readonly levels: Record<string, number> = {};

  constructor(node: AudioNode) {
    this.analyser = node.context.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.analyser.minDecibels = -100;
    this.analyser.maxDecibels = -10;
    this.db = new Float32Array(this.analyser.frequencyBinCount);
    this.sampleRate = node.context.sampleRate;
    node.connect(this.analyser);
  }

  /** Mean power over a range of frequencies, in dB. */
  private rangeDb(lo: number, hi: number): number {
    const binHz = this.sampleRate / this.analyser.fftSize;
    const n = this.db.length;
    let a = Math.max(1, Math.floor(Math.min(lo, hi) / binHz));
    let b = Math.min(n - 1, Math.ceil(Math.max(lo, hi) / binHz));
    if (b < a) b = a;
    let p = 0;
    for (let i = a; i <= b; i++) {
      const d = this.db[i];
      if (d > -200) p += Math.pow(10, d / 10);
    }
    p /= b - a + 1;
    return p > 0 ? 10 * Math.log10(p) : -200;
  }

  /**
   * Analyse one frame and write each signal's value into `out` by id. `dt` is
   * the frame time in seconds.
   */
  update(signals: AudioSignal[], dt: number, out: Record<string, number>) {
    this.analyser.getFloatFrequencyData(this.db as any);
    for (const s of signals) {
      let st = this.state.get(s.id);
      if (!st) {
        st = { env: 0, peak: 0.3, floor: 0.3, level: 0 };
        this.state.set(s.id, st);
      }
      let v = Math.min(1, Math.max(0, (this.rangeDb(s.lo, s.hi) - DB_FLOOR) / DB_RANGE));
      st.level = v;
      if (s.auto) {
        // The peak falls back slowly and the floor creeps up, so both follow
        // a mix that gets louder or quieter; each snaps to a new extreme.
        st.peak = Math.max(v, st.peak - dt * 0.05);
        st.floor = Math.min(v, st.floor + dt * 0.02);
        const span = Math.max(st.peak - st.floor, 0.12);
        v = Math.min(1, Math.max(0, (v - st.floor) / span));
      }
      v = Math.min(1, v * s.gain);
      const g = Math.min(0.95, Math.max(0, s.gate));
      v = Math.max(0, v - g) / (1 - g);
      const t = v > st.env ? s.attack : s.release;
      st.env += (v - st.env) * (1 - Math.exp(-dt / Math.max(0.001, t)));
      out[s.id] = Math.pow(Math.min(1, Math.max(0, st.env)), Math.max(0.1, s.curve));
      this.levels[s.id] = st.level;
    }
    // Forget signals that have been removed.
    if (this.state.size > signals.length) {
      for (const id of [...this.state.keys()]) {
        if (!signals.some((s) => s.id === id)) {
          this.state.delete(id);
          delete this.levels[id];
        }
      }
    }
  }

  /** The spectrum on the editor's log-frequency axis, `points` values 0..1. */
  spectrum(points: number): number[] {
    const out: number[] = new Array(points);
    const binHz = this.sampleRate / this.analyser.fftSize;
    for (let i = 0; i < points; i++) {
      const f0 = xToFreq(i / points);
      const f1 = xToFreq((i + 1) / points);
      const a = Math.max(1, Math.floor(f0 / binHz));
      const b = Math.max(a, Math.min(this.db.length - 1, Math.floor(f1 / binHz)));
      let m = -200;
      for (let k = a; k <= b; k++) m = Math.max(m, this.db[k]);
      out[i] = Math.min(1, Math.max(0, (m - DB_FLOOR) / DB_RANGE));
    }
    return out;
  }
}

/**
 * The config with every modulation applied, for one frame. Only the objects on
 * the way to a modulated setting are copied; everything else is shared, and
 * with no modulations the config itself comes back.
 */
export function applyModulation<T extends object>(cfg: T, mods: Modulation[], bands: Bands): T {
  if (!mods || mods.length === 0) return cfg;
  const sums = new Map<string, number>();
  for (const m of mods) {
    const v = (bands as any)[m.source];
    if (typeof v !== 'number' || !modulatable(m.target)) continue;
    sums.set(m.target, (sums.get(m.target) || 0) + v * m.depth);
  }
  if (sums.size === 0) return cfg;
  const out: any = { ...cfg };
  const fresh = new Set<any>([out]);
  for (const [path, sum] of sums) {
    const keys = path.split('.');
    let parent = out;
    let ok = true;
    for (let i = 0; i < keys.length - 1; i++) {
      let child = parent[keys[i]];
      if (child == null || typeof child !== 'object') {
        ok = false;
        break;
      }
      if (!fresh.has(child)) {
        child = Array.isArray(child) ? [...child] : { ...child };
        parent[keys[i]] = child;
        fresh.add(child);
      }
      parent = child;
    }
    const last = keys[keys.length - 1];
    if (!ok || typeof parent[last] !== 'number') continue;
    const r = paramRange(path);
    parent[last] = Math.min(r.max, Math.max(r.min, parent[last] + sum * (r.max - r.min)));
  }
  return out;
}
