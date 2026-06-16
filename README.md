# Shader Ritual

An audio-reactive **shader manipulation** playground, built in the spirit of
FrameRitual but focused on Shadertoy-style fragment shaders instead of 3D
geometry.

Every shader is broken into named **elements**. For each element you can:

- **Assign an audio band** — split the signal into **Low / Mid / High** and wire
  any element to any band (or `None`).
- **Set a reactive amount** — how strongly that band drives the element.
- **Hide it** — toggle each element on/off independently.

Each shader has its own menu generated from its element list, so the element →
audio mapping is per-shader. MIDI-learn is available on every amount slider.

## Beyond per-element reactivity

Two newer manipulation layers sit on top of the element system:

- **Camera / Motion rig** — a *global* virtual camera shared by every shader,
  decoupled from element reactivity. Pick a **Mode**:
  - `Manual` — a steady orbit at a chosen speed.
  - `BPM` — tempo-locked jump-cuts + drift (set the BPM; `Cut variety` controls
    how wild the re-framing gets). This reproduces the "camera angle play" of the
    reference shader.
  - `Audio` — orbit speed, push-in and FOV are driven by a chosen band.

  Distance, Height and Field of view are always adjustable, and every camera
  slider is MIDI-learnable.

- **Detachable controls** — the gear panel can pop out into its **own window**
  (the ⧉ button). The detached controller and the render window stay in
  lock-step over a `BroadcastChannel`: moving any slider, changing the camera
  mode, learning MIDI or toggling audio updates the other window **instantly**.
  The detached window carries the live band meter too, so you can run the visual
  full-screen on one display and drive it from another.

## Architecture

| File | Responsibility |
| --- | --- |
| `analyser.ts` | Web Audio `AnalyserNode` FFT wrapper |
| `audio-bands.ts` | Splits FFT into Low/Mid/High, applies sensitivity + noise gate |
| `camera.ts` | CPU camera rig — turns the camera config + bands into shared uniforms |
| `shaders/common.ts` | Shared full-screen-quad vertex shader |
| `shaders/sanctum.ts` | Raymarched chamber shader (Buffer A + Image bloom pass) |
| `shaders/cathedral.ts` | Reactive column-grid shader; showcase for the camera rig |
| `shader-registry.ts` | Shader list + default/sanitized config |
| `shader-view.ts` | Three.js two-pass renderer; auto-creates per-element + camera uniforms |
| `main.ts` | Lit UI: shader selector, camera/motion, per-element menus, MIDI, detachable controls |
| `types.ts` | Shared config + shader-definition types |

### Camera uniforms available to every shader

The renderer feeds these from the global camera rig each frame:

| Uniform | Meaning |
| --- | --- |
| `iCamOrbit` | orbit angle in radians |
| `iCamDist` | distance multiplier around the shader's native framing |
| `iCamHeight` | normalised height offset (−1..1) — scale to your world |
| `iCamFov` | field of view in degrees |
| `iCamReact` | 0..1 motion energy (beat pulse / audio level) |
| `iBeat` | continuous beat phase = `time * bpm / 60` |

### How an element maps to the shader

For each element `<id>` the renderer auto-creates two uniforms:

- `<id>_react` = `bandValue * amount` (the live reactive value)
- `<id>_visible` = `1.0` / `0.0` (the hide toggle)

The shader reads these to modulate or remove that part of the image. For the
`sanctum` shader:

| Element | `_react` drives | `_visible` hides |
| --- | --- | --- |
| `core` | morph + spin of the central fractal | the central object |
| `beams` | emission + glow of the moving light bars | the bars |
| `walls` | surface brightness of the chamber | the architecture |
| `bloom` | post-process bloom spread | the bloom (passes through) |

## Add a new shader

1. Create `shaders/<name>.ts` exporting a `ShaderDef` (buffer + image GLSL and
   an `elements` array). Reference `<id>_react` / `<id>_visible` uniforms in the
   GLSL for each element.
2. Register it in `shader-registry.ts` (`SHADERS` array).

The UI and uniform wiring are generated automatically from the element list.

## Run locally

```bash
npm install
npm run dev
```

Then click the gear icon → **Ignite Audio** and play sound near your mic.
