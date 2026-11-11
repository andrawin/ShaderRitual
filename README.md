# Shader Ritual

An audio-reactive **shader manipulation** playground, built in the spirit of
FrameRitual but focused on Shadertoy-style fragment shaders instead of 3D
geometry.

Every shader is broken into named **elements**. For each element you can:

- **Assign an audio band** — split the signal into **Low / Mid / High** and wire
  any element to any band (or `None`).
- **Set a reactive amount** — how strongly that band drives the element.
- **Hide it** — toggle each element on/off independently.

The control panel is laid out as a **hardware-style device surface** docked
along the bottom, mirroring a MIDI controller. The global controls take the prime
real estate:

- **8 rotary encoders** (drag up/down) → camera / motion: BPM, FOV, distance,
  height, orbit speed, react amount, cut variety, audio gain.
- **LED row** → lights with the live low/mid/high band meter.
- **8 faders** → response / gates: low/mid/high gain, FFT smoothing, low/mid/high
  gate, motion idle drift.
- **Transport row** → ignite/kill audio, toggle overlay, BPM ±, prev/next shader,
  camera mode, prev/next overlay shader.

Below that, a compact **ELEMENTS** row holds the per-shader element on/off + band
chips (lower priority), then a **SETUP** section (overlay layer, MIDI bridge).

**MIDI-learn (the ● dot)** is on every encoder, fader and element on/off — map a
hardware knob/fader to a camera/response param and a hardware button to an
element's on/off (a note press toggles it).

Every element also has a **Manual level** — a baseline added on top of the
band-driven value. Set an element's band to **None** and ride the Manual level
(by hand, MIDI, or the detached controller) to drive lighting / colour / shape
**without** audio. `react = level + band × amount`.

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
  slider is MIDI-learnable. BPM has a **number input** + **Tap** button for
  exact tempo matching.

- **Overlay layer (combine elements across shaders)** — composite a *second*
  shader on top of the active one (Add / Screen / Mix + opacity). Because each
  element has a hide toggle, you can mute everything in the overlay except the
  part you want — e.g. set the overlay to **Mandala**, hide all but its **Light
  Columns**, and ride its beams over any base shader. Under Add/Screen the
  overlay's dark areas drop out, so only the kept element shows through. Both
  layers run their own full pipeline (feedback + elements), so it's ~2× the GPU.

- **3D model overlay** — upload a **`.glb` / `.gltf`** model and composite it on
  top of the shader with a perspective camera + lighting. Controls for Visible,
  Scale, Opacity, Position X/Y/Z, and a BPM auto-rotate (0 = off). The model is
  centred/normalised on load; the transforms persist (the model data itself
  lives only in memory, so re-upload after a reload). Draco/Meshopt-compressed
  GLBs are supported.

- **Model breakup (explode / shatter)** — break the loaded model into addressable
  pieces and drive them with the audio: **Parts** (one piece per mesh) or
  **Shatter** (k-means triangle clustering into N fragments). Each piece can
  **explode** outward (with a band that pushes the amount), **spin**, and **glow**
  (emissive, band-driven), so the model bursts apart on the beat and reassembles.

- **Global post-FX** — image-wide filters layered over *every* shader (and the
  overlay): **Pixelate, Edge Detect, Posterize, RGB Shift, Scanlines**. Each has
  an on/off, a strength, and an optional **react band** so the filter's strength
  pulses with the audio. Runs as a final pass after compositing.

- **Calm on silence (Motion)** — animation time advances at `idle + level × gain`
  where `level` is the live audio energy. So the whole scene (and the camera)
  **calms when no sound is coming in**, and at `idle = 0` it freezes entirely.
  Toggle it off for constant motion. Applies to all shaders.

- **Live code panel** (the `</>` button or the `C` key) — a semi-live-coding
  overlay showing the active shader's GLSL plus a **live-updating block of the
  current uniform values** (element react, camera orbit/fov/beat, motion time).
  The source is **editable**: edits recompile the shader ~0.5 s after you stop
  typing. A failed compile is rejected (the last working shader keeps running)
  and the GLSL error is shown; **Reset** restores the original source. In-page
  the panel is fully **transparent** (it reads as part of the visual), and it
  can **pop out to its own window** (⧉) which stays synced over `BroadcastChannel`
  — edit in the detached window, watch it recompile on the render window live.

- **Detachable controls** — the gear panel can pop out into its **own window**
  (the ⧉ button). The detached controller and the render window stay in
  lock-step over a `BroadcastChannel`: moving any slider, changing the camera
  mode, learning MIDI or toggling audio updates the other window **instantly**.
  The detached window carries the live band meter too, so you can run the visual
  full-screen on one display and drive it from another.

## Audio signals

Beyond the fixed Low / Mid / High bands, **Audio Signals** works like
TouchDesigner's Audio Spectrum, Lag and Math CHOPs:

- **Draw a range on the spectrum.** Each coloured box is a signal (Kick, Snare
  and Hats to start; more from presets). Drag it, or drag its edges.
- **Shape it.** Auto-level (scales between its own recent floor and peak),
  Gain, Gate, Attack and Release in milliseconds, and a Curve for punch.
  Signals read an unsmoothed FFT of their own, so transients come through.
- **Use it anywhere a band is chosen.** Every Audio band menu lists the signals.
- **Map it to any slider or amount.** Press Map on a signal, then click the ●
  next to any numeric setting. Its own slider sets where it rests; the depth
  (-100% to +100% of its range) sets how far the signal pushes it. Several
  signals add up on one setting. Driven settings have a purple ring.

Code: `audio-signals.ts` (analysis, shaping, modulation), `param-ranges.ts`.

## Architecture

| File | Responsibility |
| --- | --- |
| `analyser.ts` | Web Audio `AnalyserNode` FFT wrapper |
| `audio-bands.ts` | Splits FFT into Low/Mid/High, applies sensitivity + noise gate |
| `camera.ts` | CPU camera rig — turns the camera config + bands into shared uniforms |
| `shaders/common.ts` | Shared full-screen-quad vertex shader |
| `shaders/sanctum.ts` | Raymarched chamber shader (Buffer A + Image bloom pass) |
| `shaders/cathedral.ts` | Reactive column-grid shader; showcase for the camera rig |
| `shaders/phantom.ts` | Box-lattice **frame-feedback** shader (reads its own previous frame) |
| `shaders/mandala.ts` | Kaleidoscopic **two-buffer** shader (Buffer B noise → `iChannel1`) + feedback |
| `shaders/cosa.ts` | Grid-lattice + radial-beam **feedback** shader |
| `shaders/thunder.ts` | Single-pass procedural lightning bolt |
| `shaders/pulsar.ts` | Spiky body + warped tunnel ringed by kaleidoscopic **laser** beams |
| `shaders/alive.ts` | Pulsing organic PBR blob with satellites over a voronoi aura (two-pass) |
| `shaders/chrome.ts` | Twisting reflective chrome ribbon with motion blur |
| `shaders/nebula.ts` | Volumetric Julia-fractal fog (srtuss) |
| `shaders/oscilloscope.ts` | CRT vector-scope drawing a procedural waveform with feedback |
| `shaders/siren.ts` | Neural-network SDF blob over a starfield (Blackle Mori, CC0) |
| `shaders/plasma.ts` | Volumetric plasma globe (nimitz); procedural-noise port |
| `shaders/tardigrade.ts` | Raymarched water-bear (nimitz / ArthurTent); procedural-noise port |
| `shader-registry.ts` | Shader list + default/sanitized config |
| `decompose.ts` | Split a loaded model into addressable per-mesh Parts (cloned materials, explode dirs) |
| `fracture.ts` | Shatter a model into fragments via k-means triangle clustering |
| `shader-layer.ts` | One shader's full pipeline (feedback + Buffer B + elements) as a reusable layer |
| `shader-view.ts` | Orchestrates base + optional overlay layer and the composite pass |
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

> **Frame feedback:** the renderer ping-pongs two render targets, so a Buffer-A
> pass may sample its **own previous frame** through `iChannel0` (trails, echoes,
> motion blur). The `phantom` shader relies on this. Shaders that don't read
> `iChannel0` in their buffer pass are unaffected.
>
> **Helper buffer (`iChannel1`):** a `ShaderDef` may also declare an optional
> `bufferBShader`. It's rendered once into a fixed-size, **repeat-wrapped** target
> and exposed to Buffer A as `iChannel1` — handy for tiling noise or lookup
> tables. The `mandala` shader uses this for its surface noise + reflection map.
>
> **GLSL ES 3.00:** set `glsl3: true` on a `ShaderDef` to compile its buffer
> passes as `#version 300 es` (WebGL2 — uint / bit ops / `texture()`). The image
> pass stays ES 1.00. Use this for shaders that need WebGL2-only features.

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

## Credits

- **Overtime** uses "office is old abandoned FREE" by
  [dasy444](https://sketchfab.com/dasy444)
  ([Sketchfab](https://sketchfab.com/3d-models/office-is-old-abandoned-free-3977a108b2304b85a698f3dda1777015)),
  licensed [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/). Prepared
  for the scene (screens cut out, textures compressed) by `tools/prep-office.py`;
  the original and its licence are in `tools/source/`.
- **Leviathan** uses "[animal company - Megalodon Dead End Control Room](https://sketchfab.com/3d-models/animal-company-megalodon-dead-end-control-room-e8e4db6b6048444d802fcd6574c172f9)"
  by [Romeo rios vr](https://sketchfab.com/rrios2027); **Seawall** uses
  "[DAE Diorama - By the Ocean](https://sketchfab.com/3d-models/dae-diorama-by-the-ocean-e6dffd4062c64986afaf11b5a497ddff)"
  by [Sidney Eliot Bundschuh](https://sketchfab.com/sidney-eliot); **Engine Room** uses
  "[HMS Belfast Engine Room](https://sketchfab.com/3d-models/hms-belfast-engine-room-f99d43c01604443ab731a07c7714f55c)"
  by [artfletch](https://sketchfab.com/artfletch). All three are licensed
  [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/) and were prepared
  (textures and geometry compressed, the scan decimated) by `tools/prep-scenes.py`.
- **Neapolis** uses six models from Sketchfab, all licensed
  [CC-BY-4.0](http://creativecommons.org/licenses/by/4.0/):
  "[Neapolis Greek Walls](https://sketchfab.com/3d-models/neapolis-greek-walls-734c2106e82840e7a79e7a4a6d806238)" by [artfletch](https://sketchfab.com/artfletch);
  "[Gary's Synthesizer](https://sketchfab.com/3d-models/garys-synthesizer-4df4d2a8a556486a85e3b3336843d0ae)" by [Fredrik](https://sketchfab.com/kird3rf);
  "[Moog Grandmother Semi-Modular Analog Synthesizer](https://sketchfab.com/3d-models/moog-grandmother-semi-modular-analog-synthesizer-6394f8259fb4450083d4333e394c02a8)" by [gozdemrl](https://sketchfab.com/gozdemrl);
  "[SYNTHGEN-V1 O2](https://sketchfab.com/3d-models/synthgen-v1-o2-3ebd1cb2b60e44fab636403ddd0219fe)" by [AL3K](https://sketchfab.com/alexinsouratselou);
  "[TR-808](https://sketchfab.com/3d-models/tr-808-577cb95c8d78491795918d06e0afe05b)" by [VictorBorgions](https://sketchfab.com/VictorBorgions);
  "[Synthesizer](https://sketchfab.com/3d-models/synthesizer-736c46af07c54a7fb0eb6f93a6398cdf)" by [Michael Perez](https://sketchfab.com/pixelflygraphics).
  Scaled to real size, placed on raycast-checked flat stone and flown by
  `tools/build-neapolis.py` (Blender); exported for the web, with the drone's
  flight in the GLB, by `tools/export-neapolis.py` and
  `gltf-transform meshopt`.
