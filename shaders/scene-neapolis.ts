/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Models, all CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/):
 *   "Neapolis Greek Walls" by artfletch — sketchfab.com/3d-models/neapolis-greek-walls-734c2106e82840e7a79e7a4a6d806238
 *   "Gary's Synthesizer" by Fredrik (kird3rf) — sketchfab.com/3d-models/garys-synthesizer-4df4d2a8a556486a85e3b3336843d0ae
 *   "Moog Grandmother Semi-Modular Analog Synthesizer" by gozdemrl — sketchfab.com/3d-models/moog-grandmother-semi-modular-analog-synthesizer-6394f8259fb4450083d4333e394c02a8
 *   "SYNTHGEN-V1 O2" by AL3K (alexinsouratselou) — sketchfab.com/3d-models/synthgen-v1-o2-3ebd1cb2b60e44fab636403ddd0219fe
 *   "TR-808" by VictorBorgions — sketchfab.com/3d-models/tr-808-577cb95c8d78491795918d06e0afe05b
 *   "Synthesizer" by Michael Perez (pixelflygraphics) — sketchfab.com/3d-models/synthesizer-736c46af07c54a7fb0eb6f93a6398cdf
 * Placed and flown in Blender by tools/build-neapolis.py, exported by
 * tools/export-neapolis.py.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';

/*
 * "Neapolis" — a scene shader: a drone checking on synthesizers left out in
 * the ruins of the Greek walls of Neapolis.
 *
 * The ruin is a photoscan, its daylight baked into the texture; the synths sit
 * where a raycast survey found flat, clear stone for them (on the brick floor,
 * on wall tops, down in the pit), each tilted to the surface it rests on. The
 * drone's flight was planned and collision-checked in Blender and rides in the
 * GLB, so the Tour route is the same flight as the rendered video.
 *
 * Elements:
 *   route       -> Tour (the flight, looping), Inspect (hold on one synth,
 *                  cutting to the next every two bars), or Orbit (high over the site)
 *   daylight    -> the baked daylight on the stone: colour, and how much of it.
 *                  Pull it down for night, and the searchlight takes over
 *   searchlight -> the drone's light on whatever it is looking at; kicks on the beat
 *   synths      -> the panels glowing, as if powered up
 *   drift       -> how much the drone wobbles in the air
 *   haze        -> fog colour and density; also the sky
 *   bloom       -> how far the light spills
 *   hud         -> a drone OSD over the picture: brackets, crosshair, REC
 */

const ROUTES = ['Tour', 'Inspect', 'Orbit'];
const INSPECT_BEATS = 8;     // two bars a synth
const HOVER_FRAMES = 105;    // how long the flight hovers at each stop
const BRIDGE_SECONDS = 6;    // the flight's end back round to its start

interface Flight {
  fps: number;
  step: number;
  frames: number;
  cam: number[];
  look: number[];
  stops: { name: string; frame: number; at: number[]; look: number[] }[];
}

function linColour(v: THREE.Vector3, out: THREE.Color): THREE.Color {
  return out.setRGB(v.x, v.y, v.z, THREE.SRGBColorSpace);
}

/** Catmull-Rom through flat xyz samples, at fractional sample index f. */
function sample(arr: number[], f: number, out: THREE.Vector3): THREE.Vector3 {
  const n = arr.length / 3;
  const i = Math.floor(f);
  const t = f - i;
  const g = (k: number, c: number) => arr[Math.min(n - 1, Math.max(0, k)) * 3 + c];
  const v = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p0 = g(i - 1, c), p1 = g(i, c), p2 = g(i + 1, c), p3 = g(i + 2, c);
    v[c] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  }
  return out.set(v[0], v[1], v[2]);
}

const ease = (x: number) => x * x * (3 - 2 * x);

function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,1)');
  grad.addColorStop(0.55, 'rgba(0,0,0,0.6)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

function setupNeapolis(root: THREE.Object3D, renderer: THREE.WebGLRenderer): SceneRuntime {
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);

  let flight: Flight | null = null;
  root.traverse((o) => {
    if (!flight && typeof o.userData?.sr === 'string') flight = JSON.parse(o.userData.sr);
  });
  if (!flight) throw new Error('neapolis.glb has no flight data');
  const fl: Flight = flight;
  const nSamples = fl.cam.length / 3;
  const pathSeconds = fl.frames / fl.fps;

  // --- Sort the meshes into ruin and synths. --------------------------------------
  const synthNodes: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (/^(HERO|extra)_/.test(o.name)) synthNodes.push(o);
  });
  const isSynth = new Set<THREE.Object3D>();
  for (const n of synthNodes) n.traverse((o) => isSynth.add(o));

  const ruinMats: THREE.MeshLambertMaterial[] = [];
  const synthMats: THREE.MeshStandardMaterial[] = [];
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial;
    if (isSynth.has(o)) {
      if (!synthMats.includes(m)) {
        m.envMapIntensity = 0;
        // The panels' own artwork is what lights up when they are "on".
        if (m.map && !m.emissiveMap) m.emissiveMap = m.map;
        m.emissive = new THREE.Color(0, 0, 0);
        synthMats.push(m);
      }
      return;
    }
    // The scan carries its daylight in the texture: show it as emissive, so
    // daylight is a dimmer, and keep a little diffuse for the searchlight.
    const lm = new THREE.MeshLambertMaterial({
      map: m.map,
      emissiveMap: m.map,
      emissive: new THREE.Color(1, 1, 1),
      color: new THREE.Color(0.55, 0.55, 0.55),
      // Decimating the scan flipped a few triangles; with culling they show as
      // slivers of sky through the stone.
      side: THREE.DoubleSide,
    });
    m.dispose();
    o.material = lm;
    ruinMats.push(lm);
  });

  const box = new THREE.Box3().setFromObject(root);
  const centre = box.getCenter(new THREE.Vector3());

  // Contact shadows: the scan's shadows are baked, the synths' are not.
  const blobMat = new THREE.MeshBasicMaterial({
    map: blobTexture(), color: 0x000000, transparent: true, opacity: 0.6,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
  });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  for (const n of synthNodes) {
    const b = new THREE.Box3().setFromObject(n);
    const blob = new THREE.Mesh(blobGeo, blobMat);
    blob.position.set((b.min.x + b.max.x) / 2, b.min.y + 0.012, (b.min.z + b.max.z) / 2);
    blob.scale.set((b.max.x - b.min.x) * 1.25, 1, (b.max.z - b.min.z) * 1.25);
    scene.add(blob);
  }

  // --- Light. -------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a3b2a, 1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0dd, 2);
  sun.position.set(centre.x - 12, centre.y + 25, centre.z + 8);
  sun.target.position.copy(centre);
  scene.add(sun, sun.target);
  const spot = new THREE.SpotLight(0xffffff, 0, 40, 0.5, 0.9, 1.2);
  scene.add(spot, spot.target);

  scene.fog = new THREE.FogExp2(0x9aa8bd, 0.01);
  scene.background = new THREE.Color(0x9aa8bd);

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 250);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.4, 0.5, 1.0);

  const cD = new THREE.Color();
  const cL = new THREE.Color();
  const cS = new THREE.Color();
  const cH = new THREE.Color();
  const pos = new THREE.Vector3();
  const look = new THREE.Vector3();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const endCam = sample(fl.cam, nSamples - 1, new THREE.Vector3());
  const endLook = sample(fl.look, nSamples - 1, new THREE.Vector3());
  const startCam = sample(fl.cam, 0, new THREE.Vector3());
  const startLook = sample(fl.look, 0, new THREE.Vector3());

  /** The baked flight at a time in seconds, looping through a bridge arc. */
  function tour(t: number) {
    const total = pathSeconds + BRIDGE_SECONDS;
    const tt = ((t % total) + total) % total;
    if (tt < pathSeconds) {
      const f = (tt * fl.fps) / fl.step;
      sample(fl.cam, f, pos);
      sample(fl.look, f, look);
      return;
    }
    // Swing round the site, high, from where the flight ends to where it starts.
    const s = ease((tt - pathSeconds) / BRIDGE_SECONDS);
    const aE = Math.atan2(endCam.z - centre.z, endCam.x - centre.x);
    let aS = Math.atan2(startCam.z - centre.z, startCam.x - centre.x);
    if (aS - aE > Math.PI) aS -= Math.PI * 2;
    if (aE - aS > Math.PI) aS += Math.PI * 2;
    const rE = Math.hypot(endCam.x - centre.x, endCam.z - centre.z);
    const rS = Math.hypot(startCam.x - centre.x, startCam.z - centre.z);
    const ang = aE + (aS - aE) * s;
    const r = rE + (rS - rE) * s;
    pos.set(centre.x + Math.cos(ang) * r, endCam.y + (startCam.y - endCam.y) * s + Math.sin(Math.PI * s) * 4,
      centre.z + Math.sin(ang) * r);
    look.copy(endLook).lerp(startLook, s);
  }

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const rv = (id: string) => Math.max(0, (u[`${id}_react`]?.value as number) ?? 0);
      const vis = (id: string) => ((u[`${id}_visible`]?.value as number) ?? 1) > 0.5;
      const beat = Math.pow(Math.sin(((u.iBeat.value as number) % 1) * Math.PI * 2) * 0.5 + 0.5, 6)
                 * (u.iCamReact.value as number);

      linColour(u.daylight_color.value, cD);
      linColour(u.searchlight_color.value, cL);
      linColour(u.synths_color.value, cS);
      linColour(u.haze_color.value, cH);

      // Daylight: the baked light on the stone, and sky + sun for the synths.
      const day = rv('daylight');
      for (const m of ruinMats) m.emissive.copy(cD).multiplyScalar(day);
      hemi.intensity = 0.15 + day * 0.9;
      hemi.color.copy(cH).lerp(cD, 0.5);
      sun.color.copy(cD);
      sun.intensity = day * 2.4;

      // Synths powered up.
      const glow = vis('synths') ? rv('synths') * (1 + beat * 1.2) : 0;
      for (const m of synthMats) m.emissive.copy(cS).multiplyScalar(glow * 0.6);

      // Haze, and the sky behind the site.
      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = vis('haze') ? 0.002 + rv('haze') * 0.035 : 0;
      (scene.background as THREE.Color).copy(cH);

      bloom.strength = 0.15 + rv('bloom') * 0.6 + beat * 0.25;

      // --- Camera. -----------------------------------------------------------------
      const route = Math.floor(Math.min(1.999, Math.max(0, rv('route'))) * ROUTES.length / 2);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      camera.fov = Math.min(110, Math.max(30, u.iCamFov.value as number));

      if (route === 0) {
        // The flight; the rig's orbit scrubs along it.
        tour(t + orbit * 4);
      } else if (route === 1) {
        // Hold on one synth for two bars, drifting through its hover, then cut.
        const beats = (u.iBeat.value as number) / INSPECT_BEATS;
        const stop = fl.stops[((Math.floor(beats) % fl.stops.length) + fl.stops.length) % fl.stops.length];
        const local = beats - Math.floor(beats);
        const f = (stop.frame - 1 + local * HOVER_FRAMES) / fl.step;
        sample(fl.cam, f, pos);
        sample(fl.look, f, look);
        // Pull back or lean in with the rig's distance, along the line of sight.
        a.copy(pos).sub(look);
        pos.copy(look).add(a.multiplyScalar(0.6 + 0.4 * dist));
        pos.y += hgt * 0.4;
      } else {
        // High over the site, circling.
        const ang = orbit + t * 0.04;
        const r = 9 + 7 * dist;
        pos.set(centre.x + Math.cos(ang) * r, box.max.y + 4 + hgt * 3, centre.z + Math.sin(ang) * r);
        look.set(centre.x, box.min.y + (box.max.y - box.min.y) * 0.3, centre.z);
      }

      // The drone holding itself in the air.
      const dr = vis('drift') ? rv('drift') : 0;
      b.set(Math.sin(t * 1.31) + Math.sin(t * 2.7 + 1.2) * 0.4,
            Math.sin(t * 1.73 + 0.4) + Math.sin(t * 3.1) * 0.3,
            Math.cos(t * 1.07 + 2.0) + Math.sin(t * 2.3 + 0.7) * 0.4).multiplyScalar(0.04 * dr);
      pos.add(b);
      look.addScaledVector(b, 0.6);
      pos.y += beat * 0.03 * dr;

      camera.position.copy(pos);
      camera.lookAt(look);
      camera.updateProjectionMatrix();

      // The searchlight rides under the drone and looks where it looks.
      spot.position.copy(pos).y -= 0.15;
      spot.target.position.copy(look);
      spot.color.copy(cL);
      spot.intensity = vis('searchlight') ? rv('searchlight') * 60 * (1 + beat * 1.5) : 0;
    },
    render(r, rt) {
      r.setRenderTarget(rt);
      r.setClearColor(scene.background as THREE.Color, 1);
      r.clear(true, true, false);
      r.render(scene, camera);
      bloom.render(r, null as any, rt, 0, false);
    },
    resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      bloom.setSize(Math.max(1, Math.floor(w)), Math.max(1, Math.floor(h)));
    },
  };
  (runtime as any).scene = scene;
  void renderer;
  return runtime;
}

const bufferShader = `
// Neapolis is a scene shader: Buffer A is the GLB scene, rendered in three.js
// (shaders/scene-neapolis.ts). Edit the image pass to regrade it.
precision highp float;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/* The image pass: tone map, a little lens, grain — and, with the HUD shown, a
 * drone's on-screen display: frame brackets, a crosshair, a blinking REC. */
const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform float hud_react;
uniform float hud_visible;
uniform vec3 hud_color;

vec3 aces(vec3 x){
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + iTime) * 43758.5453); }

void main(){
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  float ca = 0.0016;
  vec3 c = vec3(texture2D(iChannel0, uv + d * ca).r,
                texture2D(iChannel0, uv).g,
                texture2D(iChannel0, uv - d * ca).b);
  c = aces(c * 1.1);
  c = pow(c, vec3(1.0 / 2.2));
  c *= 1.0 - 0.45 * smoothstep(0.35, 1.0, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (hash(vUv * iResolution.xy) - 0.5) * 0.03;

  if(hud_visible > 0.5){
    vec3 hc = hud_color;
    float a = clamp(hud_react, 0.0, 1.0);
    vec2 px = vUv * iResolution.xy;
    float lw = max(1.0, iResolution.y / 540.0);
    // Corner brackets.
    vec2 q = abs(vUv - 0.5);
    vec2 e = vec2(0.44, 0.42);
    float inB = step(q.x, e.x) * step(q.y, e.y);
    float corner = step(e.x - 0.05, q.x) * step(e.y - 0.07, q.y);
    vec2 dpx = (e - q) * iResolution.xy;
    float edge = min(1.0, step(dpx.x, lw) + step(dpx.y, lw));
    float m = inB * corner * edge;
    // Crosshair: a gap in the middle.
    vec2 cp = px - iResolution.xy * 0.5;
    float ch = (step(abs(cp.y), lw * 0.6) * step(6.0 * lw, abs(cp.x)) * step(abs(cp.x), 22.0 * lw))
             + (step(abs(cp.x), lw * 0.6) * step(6.0 * lw, abs(cp.y)) * step(abs(cp.y), 22.0 * lw));
    m = max(m, min(ch, 1.0));
    // Horizon ticks at the sides.
    float tick = step(abs(cp.y), lw * 0.6) * step(0.30 * iResolution.x, abs(cp.x)) * step(abs(cp.x), 0.33 * iResolution.x);
    m = max(m, tick);
    c = mix(c, hc, m * a * 0.85);
    // REC: a red dot top left, blinking once a second.
    vec2 p = vUv * iResolution.xy / iResolution.y;
    float dot1 = smoothstep(0.014, 0.010, length(p - vec2(0.09, 0.89)));
    c = mix(c, vec3(1.0, 0.12, 0.08), dot1 * step(0.5, fract(iTime)) * a);
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const neapolis: ShaderDef = {
  id: 'neapolis',
  name: 'Neapolis',
  description:
    'A scene shader: a drone checks on synthesizers left out in the ruins of the Greek walls of Neapolis. ' +
    'Models, all CC-BY-4.0 on Sketchfab: "Neapolis Greek Walls" by artfletch; "Gary\'s Synthesizer" by Fredrik (kird3rf); ' +
    '"Moog Grandmother Semi-Modular Analog Synthesizer" by gozdemrl; "SYNTHGEN-V1 O2" by AL3K; "TR-808" by VictorBorgions; ' +
    '"Synthesizer" by Michael Perez (pixelflygraphics).',
  bufferShader,
  imageShader,
  scene: { url: 'scenes/neapolis.glb', setup: setupNeapolis },
  palettes: [
    { name: 'Afternoon', colors: { daylight: '#fff1e0', searchlight: '#ffffff', synths: '#ffd9a8', haze: '#a9b8cc', hud: '#e8f4ff' } },
    { name: 'Golden hour', colors: { daylight: '#ffc98a', searchlight: '#fff0d0', synths: '#ff9a40', haze: '#d49a6a', hud: '#ffe7c2' } },
    { name: 'Night sweep', colors: { daylight: '#3a4a7a', searchlight: '#e8f0ff', synths: '#7ab8ff', haze: '#070a14', hud: '#9cffb0' } },
    { name: 'Darkwave', colors: { daylight: '#4a2a5a', searchlight: '#ff2a6a', synths: '#ff3d8a', haze: '#0d0610', hud: '#ff6aa0' } },
    { name: 'Thermal', colors: { daylight: '#2a1a12', searchlight: '#ff7a1a', synths: '#ffd23a', haze: '#120804', hud: '#ffffff' } },
  ],
  elements: [
    {
      id: 'route',
      name: 'Route',
      description: 'Fly the planned tour of the five synths, hold on one synth at a time (cutting every two bars), or circle high over the site.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1 / ROUTES.length,
      canHide: false,
      defaultVisible: true,
      options: ROUTES,
    },
    {
      id: 'daylight',
      name: 'Daylight',
      description: 'The daylight baked into the scanned stone, and the sun on the synths. Pull it down for night and let the searchlight work.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#fff1e0',
    },
    {
      id: 'searchlight',
      name: 'Searchlight',
      description: "The drone's light on whatever it is looking at. On the kick, it flares.",
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.15,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#ffffff',
    },
    {
      id: 'synths',
      name: 'Synths',
      description: 'The panels lighting up as if the synths were powered on. On the mids, they pulse with the music.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.05,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#ffd9a8',
    },
    {
      id: 'drift',
      name: 'Drift',
      description: 'How much the drone wobbles holding itself in the air.',
      defaultBand: 'high',
      defaultAmount: 0.4,
      defaultLevel: 0.6,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'haze',
      name: 'Haze',
      description: 'Fog colour and density, and the sky behind the site. Hide for clear air.',
      defaultBand: 'none',
      defaultAmount: 0.2,
      defaultLevel: 0.2,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#a9b8cc',
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'How far the light spills.',
      defaultBand: 'low',
      defaultAmount: 0.4,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'hud',
      name: 'HUD',
      description: "A drone's on-screen display over the picture: frame brackets, crosshair, horizon ticks, a blinking REC.",
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 0.8,
      canHide: true,
      defaultVisible: false,
      defaultColor: '#e8f4ff',
    },
  ],
};
