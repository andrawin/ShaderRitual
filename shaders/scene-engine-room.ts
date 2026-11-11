/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model: "HMS Belfast Engine Room" by artfletch
 * https://sketchfab.com/3d-models/hms-belfast-engine-room-f99d43c01604443ab731a07c7714f55c
 * licensed CC-BY-4.0. Prepared by tools/prep-scenes.py.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';
import { buildWiring } from './engine-wiring';
import { Walker, beatPulse, hash, imageHead, linColour, loopPoint, makeMotes, option, react, sceneBuffer, shown } from './scene-kit';

/*
 * "Engine Room" — a scene shader: a photoscan of the engine room of HMS
 * Belfast, pipes and turbines packed to the deckhead, walked at action stations.
 *
 * The scan carries its own light in its texture and has soft, melted edges,
 * which reads well as heat and steam. The texture is shown as the worklight,
 * a dimmer; on top of it real lights rake the pipework.
 *
 * Elements:
 *   route     -> Walk (a planned loop through the gangways), Hold (stand at one
 *                spot and pan, cutting to the next every two bars), or Rush
 *                (the walk at a run, wide-angle)
 *   worklight -> the scan's own lighting: colour, and how much of it
 *   alarm     -> red battle lamps sweeping along the route; they slam on the beat
 *   furnace   -> a hot glow from below, breathing
 *   steam     -> vapour rising through the room
 *   rumble    -> the camera shaking with the machinery
 *   cables    -> hundreds of cables strung through the room, in loose sagging
 *                bundles; colour and strength of the current running along
 *                the live ones (hide to strip the rig out)
 *   sparks    -> the cut ends arcing: sputtering with the signal, and bursting
 *                on the beat with a flash on the pipes
 *   haze      -> fog colour and density
 *   bloom     -> how far the light spills
 */

const ROUTES = ['Walk', 'Hold', 'Rush'];
const HOLD_BEATS = 8;
// A loop at eye height, planned in Blender (tools/walk-plan.py), glTF axes.
const PATH: number[][] = [[-7.31, 3.5, 7.46], [-7.55, 3.49, 6.72], [-7.56, 3.51, 5.78], [-7.56, 3.52, 4.84], [-7.56, 3.53, 4.32], [-7.56, 3.52, 4.84], [-7.49, 3.51, 5.78], [-6.96, 3.47, 6.66], [-5.97, 3.46, 6.92], [-5.08, 3.52, 6.24], [-4.54, 3.53, 5.3], [-4.29, 3.54, 4.41], [-3.75, 3.55, 3.93], [-2.76, 3.58, 3.71], [-1.93, 3.74, 3.23], [-1.69, 3.84, 2.44], [-1.68, 3.67, 1.45], [-1.67, 3.63, 0.25], [-1.43, 3.63, -0.65], [-0.74, 3.62, -0.98], [-0.74, 3.61, -0.76], [-1.43, 3.62, 0.24], [-1.67, 3.67, 1.45], [-1.61, 3.84, 2.45], [-1.08, 3.74, 3.34], [-0.08, 3.63, 3.76], [0.92, 3.77, 3.34], [1.45, 3.88, 2.45], [1.52, 3.71, 1.5], [1.52, 3.66, 0.57], [1.52, 3.66, 0.05], [1.52, 3.66, 0.57], [1.52, 3.71, 1.5], [1.53, 3.88, 2.45], [1.77, 3.78, 3.24], [2.6, 3.65, 3.93], [3.65, 3.66, 4.83], [4.49, 3.67, 5.78], [4.96, 3.65, 6.72], [5.31, 3.67, 7.46], [4.72, 3.66, 7.66], [3.85, 3.66, 7.46], [3.07, 3.63, 6.77], [2.06, 3.6, 6.15], [1.12, 3.6, 5.83], [1.12, 3.6, 5.83], [2.05, 3.6, 6.03], [2.87, 3.62, 5.71], [2.87, 3.63, 4.84], [2.05, 3.63, 4.1], [0.99, 3.62, 3.89], [-0.08, 3.61, 3.88], [-1.15, 3.59, 3.89], [-2.21, 3.57, 4.1], [-2.99, 3.55, 4.83], [-3.18, 3.55, 5.56], [-3.83, 3.55, 5.83], [-4.64, 3.54, 6.31], [-4.95, 3.53, 7.14], [-5.49, 3.52, 7.62], [-6.48, 3.51, 7.67]];

function setupEngineRoom(root: THREE.Object3D): SceneRuntime {
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);

  // The scan arrives unlit. Its texture becomes emission (the worklight) and
  // a darker diffuse for the real lights to land on.
  const mats: THREE.MeshStandardMaterial[] = [];
  const made = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const old = o.material as THREE.MeshBasicMaterial;
    let m = made.get(old);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        map: old.map, emissiveMap: old.map, emissive: new THREE.Color(1, 1, 1),
        color: new THREE.Color(0.55, 0.55, 0.55), roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
      });
      made.set(old, m);
      mats.push(m);
    }
    o.material = m;
  });

  const alarms: { light: THREE.PointLight; at: number }[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    const light = new THREE.PointLight(0xffffff, 0, 9, 1.4);
    scene.add(light);
    alarms.push({ light, at: (i / 6) * PATH.length });
  }
  const furnace: THREE.PointLight[] = [];
  for (const [x, z] of [[-4, 1], [5, 0], [0, 6]]) {
    const light = new THREE.PointLight(0xffffff, 0, 14, 1.3);
    light.position.set(x, box.min.y + 1.2, z);
    scene.add(light);
    furnace.push(light);
  }

  const wiring = buildWiring();
  scene.add(wiring.cables, wiring.sparks, ...wiring.lights);
  let lastBeat = -1;
  let lastT = 0;

  const steam = makeMotes(new THREE.Box3(new THREE.Vector3(-9, box.min.y + 1.5, -1), new THREE.Vector3(7, box.max.y, 8.5)), 2200);
  scene.add(steam.points);

  scene.fog = new THREE.FogExp2(0x0a0c0e, 0.05);
  scene.background = new THREE.Color(0x030405);
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 80);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 1.0);
  const walker = new Walker(PATH);
  const cW = new THREE.Color(), cA = new THREE.Color(), cF = new THREE.Color(), cH = new THREE.Color(), cT = new THREE.Color();
  const target = new THREE.Vector3();
  const ahead = new THREE.Vector3();

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const beat = beatPulse(u);
      linColour(u.worklight_color.value, cW);
      linColour(u.alarm_color.value, cA);
      linColour(u.furnace_color.value, cF);
      linColour(u.haze_color.value, cH);

      const wv = react(u, 'worklight');
      for (const m of mats) m.emissive.copy(cW).multiplyScalar(wv * 0.9);

      // Battle lamps run ahead along the route, a little above head height.
      const av = shown(u, 'alarm') ? react(u, 'alarm') : 0;
      for (const a of alarms) {
        loopPoint(PATH, a.at + t * 1.6, p);
        a.light.position.set(p.x, p.y + 0.9, p.z);
        a.light.color.copy(cA);
        a.light.intensity = av * 6 * (0.5 + 0.5 * Math.sin(t * 6 + a.at)) * (1 + beat * 2);
      }
      const fv = react(u, 'furnace');
      furnace.forEach((l, i) => {
        l.color.copy(cF);
        l.intensity = fv * 16 * (0.7 + 0.3 * Math.sin(t * 0.8 + i * 2.1)) * (1 + beat * 0.6);
      });

      // The rig: current along the live cables, and the cut ends arcing.
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      const b = Math.floor(u.iBeat.value as number);
      const newBeat = b !== lastBeat;
      lastBeat = b;
      linColour(u.cables_color.value, cT);
      const pulseC = cT.clone();
      linColour(u.sparks_color.value, cT);
      wiring.update(t, dt, {
        glow: wv * 0.35,
        pulse: react(u, 'cables'),
        pulseColour: pulseC,
        sparks: shown(u, 'sparks') ? react(u, 'sparks') : 0,
        sparkColour: cT,
        burst: newBeat && shown(u, 'sparks') && react(u, 'sparks') > 0.05,
        show: shown(u, 'cables'),
      });

      steam.points.visible = shown(u, 'steam');
      const sv = react(u, 'steam');
      steam.uniforms.uTime.value = t;
      steam.uniforms.uRise.value = 0.5 + sv * 0.8;
      steam.uniforms.uSize.value = 20;
      // Lit by the worklight, and tinted by the lamps passing through it.
      steam.uniforms.uColor.value.copy(cW).multiplyScalar(wv * 0.5)
        .add(cT.copy(cA).multiplyScalar(av * 0.25))
        .multiplyScalar(sv * 0.22);

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = shown(u, 'haze') ? 0.015 + react(u, 'haze') * 0.1 : 0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.5);
      bloom.strength = 0.15 + react(u, 'bloom') * 0.55 + beat * 0.3;

      const route = option(u, 'route', ROUTES.length);
      const orbit = u.iCamOrbit.value as number;
      const hgt = u.iCamHeight.value as number;
      const fov = Math.min(110, Math.max(30, u.iCamFov.value as number));
      camera.fov = route === 2 ? Math.min(115, fov + 25) : fov;
      if (route === 1) {
        // One spot per two bars, panning across what is there.
        const k = Math.floor((u.iBeat.value as number) / HOLD_BEATS);
        const s = Math.floor(hash(k + 0.5) * PATH.length);
        loopPoint(PATH, s, camera.position);
        loopPoint(PATH, s + 3, ahead);
        const base = Math.atan2(ahead.x - camera.position.x, ahead.z - camera.position.z);
        const a = base + Math.sin(t * 0.25 + k) * 0.7 + orbit * 0.2;
        target.set(camera.position.x + Math.sin(a), camera.position.y - 0.1 + hgt * 0.3, camera.position.z + Math.cos(a));
        camera.lookAt(target);
      } else {
        // Looking a touch up, into the cables.
        walker.place(camera, t * (route === 2 ? 2.4 : 0.7) + orbit * 2, t, 0.12);
        camera.position.y += Math.sin(t * (route === 2 ? 11 : 5.5)) * 0.025 + hgt * 0.3;
      }
      // Rumble: the deck shaking through the camera.
      const rv = shown(u, 'rumble') ? react(u, 'rumble') : 0;
      camera.rotation.z += (Math.sin(t * 37) * Math.sin(t * 23.1)) * 0.012 * rv;
      camera.rotation.x += Math.sin(t * 41.3) * 0.006 * rv;
      camera.updateProjectionMatrix();
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
  (runtime as any).camera = camera;
  return runtime;
}

const imageShader = `${imageHead}
void main(){
  vec2 d = vUv - 0.5;
  float ca = 0.004 * dot(d, d);
  vec3 c = vec3(texture2D(iChannel0, vUv + d * ca * 4.0).r,
                texture2D(iChannel0, vUv).g,
                texture2D(iChannel0, vUv - d * ca * 4.0).b);
  c = pow(aces(c * 1.1), vec3(1.0 / 2.2));
  // A little crushed and gritty, like film pushed in a dark hull.
  c = smoothstep(0.02, 0.98, c);
  c *= 1.0 - 0.65 * smoothstep(0.3, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (grain(vUv * iResolution.xy) - 0.5) * 0.06;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const engineRoom: ShaderDef = {
  id: 'engine_room',
  name: 'Engine Room',
  description:
    'A scene shader: a photoscan of the engine room of HMS Belfast at action stations, battle lamps sweeping the pipework. ' +
    'Model: "HMS Belfast Engine Room" by artfletch (sketchfab.com/artfletch), CC-BY-4.0.',
  bufferShader: sceneBuffer('Engine Room', 'scene-engine-room.ts'),
  imageShader,
  scene: { url: 'scenes/engine-room.glb', setup: setupEngineRoom },
  palettes: [
    { name: 'Action stations', colors: { cables: '#7fe0ff', sparks: '#9fd8ff', worklight: '#ffe2c0', alarm: '#ff2a1a', furnace: '#ff7a1a', haze: '#0a0c0e' } },
    { name: 'Dry dock', colors: { cables: '#ffd23a', sparks: '#fff0c0', worklight: '#f2f6ff', alarm: '#ffd23a', furnace: '#ff9a40', haze: '#10141a' } },
    { name: 'Flooded', colors: { cables: '#3dffd0', sparks: '#bff6ff', worklight: '#3a8a8a', alarm: '#19d3c5', furnace: '#1f6bff', haze: '#03121a' } },
    { name: 'Blackout', colors: { cables: '#ff3d00', sparks: '#ffb070', worklight: '#20242c', alarm: '#ff2a1a', furnace: '#ff3d00', haze: '#020203' } },
    { name: 'Reactor', colors: { cables: '#b6ff1a', sparks: '#e8ffb0', worklight: '#5a7a3a', alarm: '#b6ff1a', furnace: '#3dff8a', haze: '#060c04' } },
  ],
  elements: [
    { id: 'route', name: 'Route', description: 'Walk the gangways, hold at one spot and pan (cutting every two bars), or take the walk at a run.', defaultBand: 'none', defaultAmount: 0, defaultLevel: 1 / ROUTES.length, canHide: false, defaultVisible: true, options: ROUTES },
    { id: 'worklight', name: 'Worklight', description: 'The light the scan was taken in: colour, and how much. Pull it down for a blackout and let the lamps work.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.45, canHide: false, defaultVisible: true, defaultColor: '#ffe2c0' },
    { id: 'alarm', name: 'Battle lamps', description: 'Lamps running ahead along the route, raking the pipes. On the kick, they slam.', defaultBand: 'low', defaultAmount: 0.9, defaultLevel: 0.7, canHide: true, defaultVisible: true, defaultColor: '#ff2a1a' },
    { id: 'furnace', name: 'Furnace', description: 'A hot glow from under the machinery, breathing.', defaultBand: 'mid', defaultAmount: 0.6, defaultLevel: 0.5, canHide: false, defaultVisible: true, defaultColor: '#ff7a1a' },
    { id: 'steam', name: 'Steam', description: 'Vapour rising through the room; more signal, faster and thicker.', defaultBand: 'high', defaultAmount: 0.6, defaultLevel: 0.6, canHide: true, defaultVisible: true },
    { id: 'rumble', name: 'Rumble', description: 'The camera shaking with the machinery. Put it on the bass.', defaultBand: 'low', defaultAmount: 1.0, defaultLevel: 0.15, canHide: true, defaultVisible: true },
    { id: 'cables', name: 'Cables', description: 'Hundreds of cables strung through the room. Colour and strength of the current pulsing along the live ones. Hide to strip the rig out.', defaultBand: 'mid', defaultAmount: 0.8, defaultLevel: 0.4, canHide: true, defaultVisible: true, defaultColor: '#7fe0ff' },
    { id: 'sparks', name: 'Sparks', description: 'The cut cable ends arcing: sputtering with the signal, bursting on the beat with a flash on the pipes. Put it on Snare or Hats.', defaultBand: 'high', defaultAmount: 1.0, defaultLevel: 0.3, canHide: true, defaultVisible: true, defaultColor: '#9fd8ff' },
    { id: 'haze', name: 'Haze', description: 'Fog colour and density. Hide for clear air.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.35, canHide: true, defaultVisible: true, defaultColor: '#0a0c0e' },
    { id: 'bloom', name: 'Bloom', description: 'How far the light spills.', defaultBand: 'low', defaultAmount: 0.5, defaultLevel: 0.6, canHide: false, defaultVisible: true },
  ],
};
