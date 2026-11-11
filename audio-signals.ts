/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AudioConfig, AudioSignal, Bands, LiveEvent, Modulation } from './types';
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

const S = { mode: 'follow' as const, onset: 0.6, action: '' };
export const SIGNAL_PRESETS: Omit<AudioSignal, 'id'>[] = [
  { name: 'Kick', color: '#ff4d4d', lo: 40, hi: 100, auto: true, gain: 1, gate: 0.3, attack: 0.004, release: 0.14, curve: 2, ...S },
  { name: 'Bass', color: '#ff9f1c', lo: 60, hi: 250, auto: true, gain: 1, gate: 0.15, attack: 0.03, release: 0.35, curve: 1.2, ...S },
  { name: 'Snare', color: '#ffd93d', lo: 1500, hi: 4500, auto: true, gain: 1, gate: 0.35, attack: 0.004, release: 0.12, curve: 2, ...S },
  { name: 'Hats', color: '#4dd2ff', lo: 7000, hi: 14000, auto: true, gain: 1, gate: 0.35, attack: 0.002, release: 0.06, curve: 1.6, ...S },
  { name: 'Vocal', color: '#c77dff', lo: 300, hi: 3000, auto: true, gain: 1, gate: 0.2, attack: 0.05, release: 0.4, curve: 1, ...S },
  { name: 'Air', color: '#e0e0e0', lo: 12000, hi: 18000, auto: true, gain: 1, gate: 0.2, attack: 0.02, release: 0.3, curve: 1, ...S },
];

/**
 * Low, Mid and High: the three broad bands every shader's defaults use, as
 * signals like any other (their ids are fixed, so saved settings and shader
 * defaults that say low / mid / high keep working). They cannot be removed.
 */
export const CORE_SIGNALS: AudioSignal[] = [
  { id: 'low', name: 'Low', color: '#3b82f6', lo: 20, hi: 160, auto: true, gain: 1, gate: 0.15, attack: 0.02, release: 0.25, curve: 1, ...S },
  { id: 'mid', name: 'Mid', color: '#10b981', lo: 160, hi: 2200, auto: true, gain: 1, gate: 0.15, attack: 0.02, release: 0.25, curve: 1, ...S },
  { id: 'high', name: 'High', color: '#ef4444', lo: 2200, hi: 11000, auto: true, gain: 1, gate: 0.15, attack: 0.01, release: 0.2, curve: 1, ...S },
];
export const isCore = (id: string) => id === 'low' || id === 'mid' || id === 'high';

/** One-shot actions a hit can fire, as the MIDI action table names them. */
export const HIT_ACTIONS: { id: string; label: string }[] = [
  { id: '!camCut', label: 'Camera cut' },
  { id: '!palNext', label: 'Next palette' },
  { id: '!nextShader', label: 'Next shader' },
  { id: '!prevShader', label: 'Previous shader' },
  { id: '!textFire', label: 'Fire text' },
  { id: '!vidRetrig', label: 'Video: retrigger slice' },
  { id: '!vidJump', label: 'Video: jump slice' },
  { id: '!vidNext', label: 'Video: next slice' },
  { id: '!burst', label: 'Model: burst' },
  { id: '!implode', label: 'Model: implode' },
];

export function newSignalId(existing: AudioSignal[]): string {
  let i = existing.length + 1;
  while (existing.some((s) => s.id === `sig${i}`)) i++;
  return `sig${i}`;
}

export function defaultAudio(): AudioConfig {
  // Low, Mid and High, then Kick, Snare and Hats: what a drum-led set wants most.
  const signals = [...CORE_SIGNALS.map((s) => ({ ...s })), ...[0, 2, 3].map((p, i) => ({ id: `sig${i + 1}`, ...SIGNAL_PRESETS[p] }))];
  return { signals, mods: [] };
}

/** Keep a saved audio config well-formed. */
export function mergeAudio(base: AudioConfig, saved: any): AudioConfig {
  if (!saved || typeof saved !== 'object') return base;
  const reserved = new Set(['none', 'rawLow', 'rawMid', 'rawHigh']);
  let signals: AudioSignal[] = Array.isArray(saved.signals)
    ? saved.signals
        .filter((s: any) => s && typeof s.id === 'string' && !reserved.has(s.id))
        .map((s: any) => ({ ...SIGNAL_PRESETS[0], ...s }))
    : base.signals;
  // Settings saved before Low / Mid / High became signals: put them in front.
  const missing = CORE_SIGNALS.filter((c) => !signals.some((s) => s.id === c.id)).map((c) => ({ ...c }));
  signals = [...missing, ...signals];
  const ids = new Set(['low', 'mid', 'high', ...signals.map((s) => s.id)]);
  const mods: Modulation[] = Array.isArray(saved.mods)
    ? saved.mods.filter((m: any) => m && ids.has(m.source) && typeof m.target === 'string')
    : [];
  const eventOffset = Number.isFinite(saved.eventOffset) ? saved.eventOffset : 0;
  return { signals, mods, eventOffset };
}

/** A new event signal listening for `match`. */
export function eventSignal(id: string, name: string, match: string, color = '#7cff6b'): AudioSignal {
  return {
    id, name, color, lo: 20, hi: 20000, auto: false, gain: 1, gate: 0,
    attack: 0.004, release: 0.2, curve: 1.4, mode: 'trigger', onset: 0.6, action: '',
    kind: 'event', match, key: '',
  };
}

const glob = (pat: string, v: any) => {
  const s = String(v);
  if (!pat.includes('*')) return s === pat;
  const re = new RegExp('^' + pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(s);
};

/**
 * Whether an event matches a signal's Match text. Tokens are separated by
 * spaces and all must hold; `|` gives alternatives within one.
 *   s=bd       a parameter equal to a value (`s=bd|sd`, `s=hh*`)
 *   /sr/kick   the OSC address (`/sr/*`)
 *   strudel:   only from that sender (strudel, sc, dirt; several = any of them)
 *   kick       any parameter equal to it
 *   *          everything
 */
export function eventMatches(match: string, ev: LiveEvent): boolean {
  let tokens = (match || '').trim().split(/[\s,]+/).filter(Boolean);
  const isFrom = (t: string) => /^[a-z]+:$/i.test(t);
  const from = tokens.filter(isFrom).map((t) => t.slice(0, -1).toLowerCase());
  if (from.length && !from.includes(ev.src)) return false;
  tokens = tokens.filter((t) => !isFrom(t));
  if (tokens.length === 0) return from.length > 0;
  const any = (alts: string, v: any) => alts.split('|').some((p) => glob(p, v));
  return tokens.every((t) => {
    if (t === '*') return true;
    if (t.startsWith('/')) return any(t, ev.address);
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq);
      return k in ev.params && any(t.slice(eq + 1), ev.params[k]);
    }
    return Object.values(ev.params).some((v) => (typeof v === 'string' || typeof v === 'number') && any(t, v));
  });
}

/** The number an event carries for a signal: its `key`, or its loudness. */
export function eventValue(key: string | undefined, ev: LiveEvent): number | null {
  const p = ev.params;
  const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
  if (key) return num(p[key]);
  for (const k of ['gain', 'velocity', 'amp', 'value']) {
    const v = num(p[k]);
    if (v !== null) return v;
  }
  if (Array.isArray(p.args)) for (const a of p.args) if (num(a) !== null) return num(a);
  return null;
}

/** A short readable form of an event, for the panel's log. */
export function describeEvent(ev: LiveEvent): string {
  const parts = Object.entries(ev.params)
    .filter(([k, v]) => k !== 'args' && (typeof v === 'string' || typeof v === 'number'))
    .slice(0, 5)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`);
  if (Array.isArray(ev.params.args)) parts.push(ev.params.args.slice(0, 4).join(' '));
  return `${ev.address ? ev.address + ' ' : ''}${parts.join(' ')}`.trim();
}

/** The Match text that picks out events like this one. */
export function suggestMatch(ev: LiveEvent): string {
  const p = ev.params;
  for (const k of ['s', 'sound', 'instrument', 'name']) {
    if (typeof p[k] === 'string' && p[k]) return `${k}=${p[k]}`;
  }
  if (ev.address && ev.address !== '/dirt/play') return ev.address;
  return `${ev.src}:`;
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
  /** Hit detection: a slow average to rise above, and when the last hit was. */
  avg: number;
  last: number;
  /** Re-armed once the level settles after a hit; one sound, one hit. */
  armed: boolean;
}

export class SignalEngine {
  private analyser: AnalyserNode | null = null;
  private db = new Float32Array(1024);
  private wave = new Float32Array(2048);
  private sampleRate = 48000;
  /** Live events waiting for the moment they sound (performance.now() ms). */
  private pending: { at: number; ev: LiveEvent }[] = [];
  private state = new Map<string, SignalState>();
  /** Last frame's levels before shaping, by id, for the editor's meters. */
  readonly levels: Record<string, number> = {};
  /** Hits detected so far, by id: a counter, so a reader can tell a new one. */
  readonly hits: Record<string, number> = {};
  private clock = 0;

  /** Whether a mic (or other input) is feeding the audio signals. */
  get listening() {
    return !!this.analyser;
  }

  /**
   * A live event, landing `ev.delay` + `offset` ms from now, when it sounds.
   * Event signals read it whether or not a mic is on.
   */
  push(ev: LiveEvent, offset = 0) {
    const at = performance.now() + Math.min(4000, Math.max(0, (ev.delay || 0) + offset));
    this.pending.push({ at, ev });
    if (this.pending.length > 512) this.pending.splice(0, this.pending.length - 512);
  }

  /** Listen to an audio node (the mic). Hit counters carry over. */
  attach(node: AudioNode) {
    const an = node.context.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0;
    an.minDecibels = -100;
    an.maxDecibels = -10;
    this.analyser = an;
    this.db = new Float32Array(an.frequencyBinCount);
    this.wave = new Float32Array(an.fftSize);
    this.sampleRate = node.context.sampleRate;
    node.connect(this.analyser);
  }

  /** Mean power over a range of frequencies, in dB. */
  private rangeDb(lo: number, hi: number): number {
    const binHz = this.sampleRate / 2048;
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
    if (this.analyser) this.analyser.getFloatFrequencyData(this.db as any);
    this.clock += dt;
    const now = this.clock;
    // The live events whose moment has come.
    const t = performance.now();
    let due: LiveEvent[] = [];
    if (this.pending.length) {
      due = this.pending.filter((p) => p.at <= t).map((p) => p.ev);
      if (due.length) this.pending = this.pending.filter((p) => p.at > t);
    }
    for (const s of signals) {
      let st = this.state.get(s.id);
      if (!st) {
        st = { env: 0, peak: 0.3, floor: 0.3, level: 0, avg: 0, last: -10, armed: true };
        this.state.set(s.id, st);
        this.hits[s.id] = this.hits[s.id] || 0;
      }
      if (s.kind === 'event') {
        this.updateEvent(s, st, due, dt, now);
        out[s.id] = Math.pow(Math.min(1, Math.max(0, st.env)), Math.max(0.1, s.curve));
        this.levels[s.id] = st.level;
        continue;
      }
      if (!this.analyser) {
        // No mic: audio signals rest at 0 and fall away from where they were.
        st.env *= Math.exp(-dt / Math.max(0.01, s.release));
        out[s.id] = Math.pow(st.env, Math.max(0.1, s.curve));
        this.levels[s.id] = 0;
        continue;
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
      // Hits: a jump well above the recent average, no closer than 80 ms to
      // the last. Onset sets how big a jump counts.
      const jump = v - st.avg;
      const need = 0.03 + (1 - Math.min(1, Math.max(0, s.onset ?? 0.6))) * 0.32;
      if (st.armed && jump > need && now - st.last > 0.08) {
        st.last = now;
        st.armed = false;
        this.hits[s.id] = (this.hits[s.id] || 0) + 1;
      } else if (!st.armed && jump < need * 0.35) {
        // The sound has settled (or died away): the next jump is a new hit.
        st.armed = true;
      }
      st.avg += (v - st.avg) * (1 - Math.exp(-dt / 0.2));
      const g = Math.min(0.95, Math.max(0, s.gate));
      v = Math.max(0, v - g) / (1 - g);
      if (s.mode === 'trigger') {
        // An envelope from the last hit: up over Attack, away over Release.
        const age = now - st.last;
        const a = Math.max(0.001, s.attack);
        st.env = age < a ? age / a : Math.exp((-3 * (age - a)) / Math.max(0.01, s.release));
      } else {
        const t = v > st.env ? s.attack : s.release;
        st.env += (v - st.env) * (1 - Math.exp(-dt / Math.max(0.001, t)));
      }
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

  /**
   * An event signal. Trigger: each matching event is a hit and fires an
   * envelope as tall as its value. Follow: the value holds the latest
   * matching event's number, approached over Attack and Release.
   */
  private updateEvent(s: AudioSignal, st: SignalState, due: LiveEvent[], dt: number, now: number) {
    for (const ev of due) {
      if (!eventMatches(s.match || '', ev)) continue;
      const raw = eventValue(s.key, ev);
      const v = Math.min(1, Math.max(0, (raw ?? 1) * s.gain));
      st.level = v;
      if (s.mode === 'follow') {
        st.peak = v;
      } else {
        st.peak = v;
        st.last = now;
      }
      this.hits[s.id] = (this.hits[s.id] || 0) + 1;
    }
    if (s.mode === 'follow') {
      const tc = st.peak > st.env ? s.attack : s.release;
      st.env += (st.peak - st.env) * (1 - Math.exp(-dt / Math.max(0.001, tc)));
    } else {
      const age = now - st.last;
      const a = Math.max(0.001, s.attack);
      st.env = st.peak * (age < a ? age / a : Math.exp((-3 * (age - a)) / Math.max(0.01, s.release)));
      // The meter's line falls with the pulse, so a held value does not linger.
      st.level *= Math.exp(-dt / 0.25);
    }
  }

  /**
   * Fill an RGBA byte texture `w` texels wide and 2 high, for shaders
   * (iAudio): row 0 is the spectrum on the log axis, row 1 the waveform,
   * starting at a rising zero crossing so it stands still on a steady tone.
   * The value is in every channel.
   */
  fillAudioTexture(data: Uint8Array, w: number) {
    if (!this.analyser) return;
    const spec = this.spectrum(w)!;
    this.analyser.getFloatTimeDomainData(this.wave as any);
    const n = this.wave.length;
    let start = 0;
    for (let i = 1; i < n - w; i++) {
      if (this.wave[i - 1] < 0 && this.wave[i] >= 0) {
        start = i;
        break;
      }
    }
    for (let i = 0; i < w; i++) {
      const s = Math.round(Math.min(1, Math.max(0, spec[i])) * 255);
      const v = Math.round(Math.min(1, Math.max(0, this.wave[Math.min(n - 1, start + i)] * 0.5 + 0.5)) * 255);
      const a = i * 4;
      const b = (w + i) * 4;
      data[a] = data[a + 1] = data[a + 2] = s;
      data[a + 3] = 255;
      data[b] = data[b + 1] = data[b + 2] = v;
      data[b + 3] = 255;
    }
  }

  /** The spectrum on the editor's log-frequency axis, `points` values 0..1. */
  spectrum(points: number): number[] | null {
    if (!this.analyser) return null;
    const out: number[] = new Array(points);
    const binHz = this.sampleRate / 2048;
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
