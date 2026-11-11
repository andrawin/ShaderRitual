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

All audio reactivity runs on **signals**, TouchDesigner-style (Audio Spectrum,
Lag, Math and Trigger CHOPs in one):

- **Draw a range on the spectrum.** Each coloured box is a signal. Low, Mid and
  High are always there (every shader's defaults use them); Kick, Snare and
  Hats come next, and more from presets. Drag a box, or its edges.
- **Shape it.** Auto-level (scales between its own recent floor and peak),
  Gain, Gate, Attack and Release in milliseconds, and a Curve for punch.
- **Follow or Trigger.** Follow tracks the level. Trigger turns each detected
  hit into a clean envelope, up over Attack and away over Release. Hit
  sensitivity sets how big a jump counts; the box flashes white on every hit.
- **On hit.** Fire a one-shot action on each hit: camera cut, next palette,
  next or previous shader, fire text, video slice jumps, model burst.
  (Actions are spaced out so a hat line cannot flood them.)
- **Use it anywhere a band is chosen.** Every Audio band menu lists the signals.
- **Map it to any slider or amount.** Press Map on a signal, then click the ●
  next to any numeric setting. Its own slider sets where it rests; the depth
  (-100% to +100% of its range) sets how far the signal pushes it. Several
  signals add up on one setting. Driven settings have a purple ring.

Code: `audio-signals.ts` (analysis, hits, shaping, modulation), `param-ranges.ts`.

## Live events: Strudel and SuperCollider

Notes and messages from live code become signals too, so they can be
mapped to any setting, fire On hit actions, or drive the strobe in the same
way as an audio signal. Each one is exact to the note, and lands when the
sound plays: Strudel and SuperCollider schedule ahead, and the event carries
how far, so the picture waits for it.

1. Run the relay alongside the app: `npm run dev:live` (or `npm run relay`
   in a second terminal next to `npm run dev`). It listens for OSC on UDP
   **57121** and for Strudel on **ws://localhost:8787**.
2. In the panel, **Audio Signals > Live events**, copy a snippet:
   - **Strudel**: paste it at the top of your code, then add `.sr()` to any
     pattern (or `all(x => x.sr())` for everything). It works from
     strudel.cc; the browser may ask to allow access to local devices the
     first time.
   - **SuperCollider**: `~sr = NetAddr("127.0.0.1", 57121)`, then
     `~sr.sendMsg("/sr", "s", "kick", "gain", 1)`, a Pbind `\finish`, or the
     `OSCdef` that forwards everything SuperDirt plays.
3. Events show in the log as they arrive; click one to make a signal that
   listens for events like it, or add one with **+ Event signal**.

An event signal's **Match** picks the events, with space-separated tokens
that must all hold:

| Token | Matches |
| --- | --- |
| `s=bd` | a parameter equal to a value; `s=bd\|sd` either, `s=hh*` wildcards |
| `/sr/kick` | the OSC address (`/sr/*`) |
| `strudel:` `sc:` `dirt:` | only from that sender (dirt = SuperDirt's `/dirt/play`) |
| `kick` | any parameter equal to it |
| `*` | everything |

**Trigger** fires a pulse per event, as tall as its gain (or the number in
**Value from**). **Follow** holds the latest number instead, which suits a
knob sent from SuperCollider (`~sr.sendMsg("/sr/cutoff", 0.7)` with Match
`/sr/cutoff`). **Offset** shifts every event if the projector runs behind.

## Skins

The control panel comes in two skins: **XP** (the default) and **Classic**,
the original dark one. The XP skin has a blue window and fold-away task
panes (click a section's title; folds are remembered). Its Media Player
monitor has working transport buttons: previous and next shader,
play/pause for the audio, and a strobe flash; the seek bar runs through each
bar of four beats. Switch with **View: Classic skin** in the menu bar, or the
◧ button in Classic. The choice is per browser.

## Strobe

A flash over the finished picture — every shader, the camera layer and the
model included. It lives in the panel under **Strobe · all shaders**.

- **Run** latches it on. **Drive** sets the clock: *Tempo* (one flash every
  1/16 to 4 beats at the Camera · Motion BPM), *Free* (Rate per second),
  *Hits* (one flash per hit of any audio signal, e.g. Kick), *Gate* (Rate
  per second while a signal is above a level).
- **Hold** strobes at Rate while pressed — the button, the **S** key in the
  render window, or a MIDI pad (momentary: note off stops it). **Flash** fires
  one. Run, Hold and Flash are all MIDI-learnable, and so is every setting.
- **Style**: White, Colour, Blackout or Invert; **Intensity** and **Length**
  (10–250 ms) shape each flash. Rate is capped at 15/s.
- Run always starts off when the app opens, whatever it was when it closed.

Flashing light can trigger seizures in people with photosensitive epilepsy;
warn the audience when a set uses it.

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

### Live inputs available to every shader

Besides the camera uniforms, every shader (GLSL or scene) receives:

| Uniform | What it is |
|---|---|
| `iAudio` | The live audio, 512×2: the spectrum in row 0 (log frequency, left to right; sample at `y = 0.25`) and the waveform in row 1 (`y = 0.75`, 0.5 is silence). |
| `iText`, `iTextOn` | The Text feature's words, set plainly in white on clear and sized to fill the texture, whether or not the full-screen text is shown. Leviathan writes them on its whiteboards. |
| `iCapture`, `iCaptureOn`, `iCaptureAspect`, `iCaptureMirror` | Whatever Screen & Camera is capturing. Overtime shows it on its CRTs and projects it onto its windows. |

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
  (textures and geometry compressed, the scan decimated, the Seawall town
  wrecked by a landslide in `tools/wreck-seawall.py`) by `tools/prep-scenes.py`;
  the Engine Room's cables were hung by `tools/engine-cables.py`.
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
