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

/** How an overlay layer is blended over the base shader. */
export type BlendMode = 'add' | 'screen' | 'mix';

/**
 * A second shader rendered on top of the active one. Use the overlay shader's
 * per-element hide toggles to keep only the part you want (e.g. just Mandala's
 * light columns); under add/screen its dark areas drop out.
 */
export interface LayerConfig {
  enabled: boolean;
  shader: string;
  blend: BlendMode;
  opacity: number;
}

/** A single global post-process filter. The assigned band pushes the amount. */
export interface FxSetting {
  on: boolean;
  /** 0..1 strength; the shader maps it to the filter's real parameter. */
  amount: number;
  band: Band;
}

/** The available global post-process filters (applied to the final image). */
export type FxName =
  | 'pixelate'
  | 'edge'
  | 'posterize'
  | 'rgbShift'
  | 'scanlines'
  | 'glitch'
  | 'mosaic';

export type PostFXConfig = Record<FxName, FxSetting>;

/** What a part reacts to when its band fires (MeshRitual engine). */
export type ReactTarget = 'scale' | 'emissive' | 'explode' | 'rotate';
/** Per-mesh part allocation. */
export interface PartSetting {
  band: Band;
  amount: number;
  target: ReactTarget;
  visible: boolean;
}
/** Lightweight part descriptor surfaced to the UI. */
export interface PartInfo {
  id: string;
  name: string;
}
export type BeatAction = 'burst' | 'implode' | 'pulse' | 'alternate';
/** Fracture physics sub-config (burst / fall / tumble). */
export interface PhysicsConfig {
  enabled: boolean;
  gravity: number;
  burstStrength: number;
  spin: number;
  restitution: number;
  floor: boolean;
  beatBand: Band;
  beatThreshold: number;
  beatAction: BeatAction;
  implodeStrength: number;
}
/** Fracture (shatter) sub-config. */
export interface FractureConfig {
  fragments: number;
  explodeBand: Band;
  explodeAmount: number;
  spinBand: Band;
  spinAmount: number;
  scaleBand: Band;
  scaleAmount: number;
  distribute: boolean;
  visible: boolean;
  physics: PhysicsConfig;
}
/**
 * How the model moves on the beat. All are tempo-locked; `spin` is the classic
 * turntable rotation and `none` holds it still.
 */
export type ModelMotion = 'none' | 'spin' | 'bob' | 'sway' | 'orbit' | 'tumble';

/** Shared-window screen-capture projection. */
/**
 * How the captured screen is mixed with the shader underneath it. `normal` is
 * a plain cross-fade at the layer's opacity; the rest are the usual compositing
 * operators, evaluated per channel against the finished shader image.
 */
export type CaptureBlend =
  | 'normal'
  | 'screen'
  | 'add'
  | 'multiply'
  | 'overlay'
  | 'difference'
  | 'lighten'
  | 'darken';

export interface CaptureConfig {
  opacity: number;
  scale: number;
  /** Where the capture sits: filling the frame, or a centred inset. */
  mode: 'background' | 'floating';
  blend: CaptureBlend;
  reactive: boolean;
  reactiveBand: Band;
  visible: boolean;
  /**
   * Max captured frames uploaded to the GPU per second. Each upload costs a
   * full-resolution texture transfer, so this is the main capture cost knob.
   */
  fps: number;
}

/**
 * What a beat trigger does to the playhead.
 *   off       -> the clip plays straight through
 *   retrigger -> jumps back to the start of the slice it is in (a stutter)
 *   jump      -> draws the next slice from a shuffled bag
 *   ladder    -> walks that same bag as a run
 *
 * Jump and Ladder both draw without replacement: a pass plays every slice
 * exactly once, and the order is reshuffled on each loop, so the clip is
 * covered evenly without repeating the same sequence every time round.
 */
export type VideoSliceMode = 'off' | 'retrigger' | 'jump' | 'ladder';

/** How a clip is fitted to a frame of a different shape. */
export type VideoFit = 'cover' | 'contain' | 'stretch';

/**
 * How the clip is matted into the shader under it.
 *   off     -> the clip covers its whole rectangle
 *   luma    -> it shows only where the shader is bright, so it lands on the
 *              lit form and the background stays shader
 *   lumaInv -> the inverse: the clip fills the empty space around the form
 */
export type VideoSurface = 'off' | 'luma' | 'lumaInv';

/**
 * A user-loaded video clip, composited with the shader *before* global post-FX
 * so every filter applies to it. The file itself is never read into memory —
 * it is held as an object URL and streamed off disk by the browser, which is
 * what makes multi-gigabyte clips workable — so it lives only in the window
 * that opened it and is not persisted or relayed.
 */
export interface VideoConfig {
  visible: boolean;
  opacity: number;
  blend: CaptureBlend;
  fit: VideoFit;
  /** Matte the clip into the shader's own image instead of over it. */
  surface: VideoSurface;
  /** Luminance the matte cuts at, and how soft that cut is. */
  surfaceThreshold: number;
  surfaceSoftness: number;
  /**
   * How far the shader image's own gradient bends the clip's UVs. Without it
   * the clip is a flat cut-out of the form; with it, it runs along the
   * contours and reads as painted on the surface.
   */
  warp: number;
  /** Zoom around the centre, on top of the fit. */
  scale: number;
  loop: boolean;
  playing: boolean;
  /** Playback rate before audio is added. 1 is the clip's own speed. */
  speed: number;
  /** Band that pushes the rate, and how hard. */
  speedBand: Band;
  speedAmount: number;
  /** The clip is cut into this many equal slices for beat triggering. */
  slices: number;
  /**
   * How far the cut points slide each pass, as a fraction of a slice. At 0 the
   * clip is always chopped in the same places, so a pass replays the same
   * fragments in a new order; above that, every pass is cut out of different
   * material. Reseeded whenever Jump / Ladder reshuffle.
   */
  sliceDrift: number;
  sliceMode: VideoSliceMode;
  /** Beats between triggers. 0.25 = sixteenths, 4 = one bar. */
  sliceDiv: number;
  /**
   * Max frames uploaded to the GPU per second. Each upload is a full-resolution
   * texture transfer, so this is the layer's main cost knob — same as capture.
   */
  fps: number;
}

/**
 * A user-uploaded GLB model rendered as a 3D overlay, with the MeshRitual
 * engine (per-part allocation / fracture / physics / capture). The model data
 * and the per-part map live only in memory; the rest persists.
 */
export interface ModelConfig {
  visible: boolean;
  scale: number;
  opacity: number;
  posX: number;
  posY: number;
  posZ: number;
  /** Movement tempo in beats per minute; 0 = follow the global camera BPM. */
  bpm: number;
  /** Which tempo-locked movement to play. */
  motion: ModelMotion;
  /** Depth / travel of the movement (1 = default). */
  motionAmount: number;
  /**
   * Render resolution of the whole 3D overlay layer (model + screen capture)
   * as a fraction of the screen, 0.25..1. Drop it on large displays — the 3D
   * pass is the expensive one once a model is loaded.
   */
  quality: number;
  /** Whole / per-mesh parts / shattered fracture. */
  mode: 'none' | 'parts' | 'fracture';
  /** Per-part settings keyed by part id (rebuilt per loaded model). */
  parts: Record<string, PartSetting>;
  fracture: FractureConfig;
  capture: CaptureConfig;
}

/** Top-level persisted configuration. */
export interface ShaderRitualConfig {
  activeShader: string;
  /** Internal render-resolution multiplier (0.25..1) over the display's
   *  device pixels. Lower it to cut GPU load on big / external displays. */
  renderScale: number;
  fftSmoothing: number;
  sensitivity: { low: number; mid: number; high: number };
  thresholds: { low: number; mid: number; high: number };
  camera: CameraConfig;
  motion: MotionConfig;
  overlay: LayerConfig;
  video: VideoConfig;
  postfx: PostFXConfig;
  model: ModelConfig;
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
