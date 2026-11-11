/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model: "animal company - Megalodon Dead End Control Room" by Romeo rios vr (rrios2027)
 * https://sketchfab.com/3d-models/animal-company-megalodon-dead-end-control-room-e8e4db6b6048444d802fcd6574c172f9
 * licensed CC-BY-4.0. Prepared by tools/prep-scenes.py.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';
import { Walker, beatPulse, imageHead, linColour, makeMotes, option, react, sceneBuffer, shown } from './scene-kit';

/*
 * "Leviathan" — a scene shader: a control room built inside a dead megalodon.
 * Server racks and desks stand on deck plate between the ribs, cables run up
 * into the carcass, and everything is a little bloody.
 *
 * The model is low-poly with 256px textures, so the picture leans into it:
 * the image pass can crunch it down to chunky, dithered pixels.
 *
 * Elements:
 *   route   -> Walk (a loop between the racks), Ribs (from the floor, looking
 *              up into the rib cage, turning), or Overseer (high, looking down)
 *   alarm   -> emergency lamps along the walk: colour, and how hard they burn;
 *              they kick on the beat
 *   flesh   -> the carcass itself glowing from inside, like a heartbeat
 *   servers -> the rack lights and the one live screen
 *   board   -> the whiteboards: with words in the Text feature, they are wiped
 *              and the words written up in marker (the old drawing a ghost);
 *              ink colour, and how much it glows
 *   spores  -> motes drifting up through the air
 *   crunch  -> pixelation and dither in the image pass
 *   haze    -> fog colour and density
 *   bloom   -> how far the light spills
 */

const ROUTES = ['Walk', 'Ribs', 'Overseer'];
// A loop at eye height, planned in Blender (tools/walk-plan.py), glTF axes.
const PATH: number[][] = [[-7.02, -2.49, -6.88], [-5.68, -2.49, -7.29], [-3.98, -2.49, -7.31], [-2.55, -2.49, -7.61], [-1.29, -2.49, -8.09], [0.34, -2.48, -8.19], [1.97, -2.35, -8.09], [3.22, -2.06, -7.61], [4.66, -1.96, -7.31], [6.15, -2.01, -7.3], [6.26, -2.01, -7.19], [5.71, -1.98, -6.4], [6.07, -2.21, -5.22], [6.36, -2.46, -3.73], [6.38, -2.49, -1.98], [6.67, -2.49, -0.5], [7.04, -2.49, 0.69], [6.67, -2.49, 1.89], [6.38, -2.49, 3.37], [6.38, -2.46, 5.12], [6.56, -2.26, 6.49], [6.17, -2.26, 6.9], [4.64, -2.46, 6.91], [2.92, -2.49, 6.91], [1.31, -2.47, 6.99], [0.45, -2.43, 7.08], [0.33, -2.47, 6.01], [-0.07, -2.49, 4.67], [-1.4, -2.49, 4.26], [-3.11, -2.49, 4.25], [-4.73, -2.49, 4.36], [-5.6, -2.49, 5.23], [-6.0, -2.49, 6.38], [-6.47, -2.49, 5.9], [-6.56, -2.49, 4.25], [-6.56, -2.49, 2.47], [-6.65, -2.49, 0.79], [-7.12, -2.49, -0.5], [-7.41, -2.49, -1.98], [-7.42, -2.49, -3.75], [-7.41, -2.49, -5.51]];

function setupLeviathan(root: THREE.Object3D): SceneRuntime {
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const floorY = -4.09;

  const flesh: THREE.MeshStandardMaterial[] = [];
  const blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blankTex.needsUpdate = true;
  const board = {
    uBoardText: { value: blankTex as THREE.Texture },
    uBoardOn: { value: 0 },
    uInk: { value: new THREE.Color() },
    uInkGlow: { value: 0 },
    uBoardTime: { value: 0 },
  };
  const blink: THREE.MeshStandardMaterial[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial;
    const name = m.name || '';
    if (name === 'LensFlare' || name === 'M_LightRays001') {
      o.visible = false; // billboards for an engine this is not
      return;
    }
    if (seen.has(m)) return;
    seen.add(m);
    m.envMapIntensity = 0;
    m.roughness = Math.max(m.roughness ?? 1, 0.75);
    m.metalness = Math.min(m.metalness ?? 0, 0.3);
    if (m.map) {
      // Chunky texels, as the model was made to be seen.
      m.map.magFilter = THREE.NearestFilter;
      m.map.needsUpdate = true;
    }
    if (/Whiteboard/.test(name)) {
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, board);
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            '#include <common>\nuniform sampler2D uBoardText;\nuniform float uBoardOn;\nuniform vec3 uInk;\nuniform float uInkGlow;\nuniform float uBoardTime;\nfloat inkMask = 0.0;',
          )
          .replace(
            '#include <map_fragment>',
            `#include <map_fragment>
#ifdef USE_MAP
if(uBoardOn > 0.5){
  // Marker: the words a little shaky, as if written by hand.
  vec2 tu = vec2(vMapUv.x, 1.0 - vMapUv.y);
  tu += vec2(sin(tu.y * 90.0) * 0.0015, sin(tu.x * 70.0 + 1.3) * 0.002);
  inkMask = texture2D(uBoardText, tu).a;
  vec3 wiped = mix(vec3(0.78, 0.79, 0.8), diffuseColor.rgb, 0.12);
  diffuseColor.rgb = mix(wiped, uInk * 0.6, inkMask);
}
#endif`,
          )
          .replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uInk * inkMask * uInkGlow;',
          );
      };
      m.customProgramCacheKey = () => 'leviathan-board';
    }
    if (/Bone|Guts/.test(name)) {
      m.emissiveMap = m.map;
      m.emissive = new THREE.Color(0, 0, 0);
      flesh.push(m);
    } else if (/Blink|Display_On/.test(name)) {
      m.emissiveMap = m.map;
      m.emissive = new THREE.Color(0, 0, 0);
      blink.push(m);
    }
  });

  scene.add(new THREE.HemisphereLight(0x3a2630, 0x0a0506, 0.7));
  // The desk lamp, the one warm light in the place.
  const desk = new THREE.PointLight(0xffc98a, 6, 9, 1.6);
  desk.position.set(-2.9, -2.0, 5.5);
  scene.add(desk);
  // Emergency lamps: every seventh point of the walk, up near head height.
  const alarms: { light: THREE.PointLight; phase: number }[] = [];
  for (let i = 0; i < PATH.length; i += 7) {
    const light = new THREE.PointLight(0xffffff, 0, 14, 1.5);
    light.position.set(PATH[i][0], PATH[i][1] + 1.3, PATH[i][2]);
    scene.add(light);
    alarms.push({ light, phase: i * 0.9 });
  }
  // One light high in the rib cage, for the flesh to glow by.
  const heart = new THREE.PointLight(0xffffff, 0, 40, 1.2);
  heart.position.set(0, 7, 0);
  scene.add(heart);

  const motes = makeMotes(new THREE.Box3(new THREE.Vector3(-12, floorY, -12), new THREE.Vector3(12, 9, 12)), 1600);
  scene.add(motes.points);

  scene.fog = new THREE.FogExp2(0x120608, 0.04);
  scene.background = new THREE.Color(0x050203);
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 1.0);
  const walker = new Walker(PATH);
  const cA = new THREE.Color(), cF = new THREE.Color(), cS = new THREE.Color(), cH = new THREE.Color();
  const target = new THREE.Vector3();

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const beat = beatPulse(u);
      linColour(u.alarm_color.value, cA);
      linColour(u.flesh_color.value, cF);
      linColour(u.servers_color.value, cS);
      linColour(u.haze_color.value, cH);

      const av = shown(u, 'alarm') ? react(u, 'alarm') : 0;
      for (const a of alarms) {
        // A slow sweep round the loop, so the lamps chase each other.
        const sweep = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(t * 1.4 - a.phase), 3);
        a.light.color.copy(cA);
        a.light.intensity = av * 7 * sweep * (1 + beat * 1.5);
      }

      // Flesh: two quick thumps and a rest, plus whatever the band gives.
      const fv = react(u, 'flesh');
      const ph = (t * 0.9) % 1;
      const thump = Math.exp(-ph * 9) + 0.7 * Math.exp(-Math.abs(ph - 0.22) * 14);
      const glow = fv * (0.25 + 0.75 * Math.min(1, thump)) + beat * 0.3 * fv;
      for (const m of flesh) m.emissive.copy(cF).multiplyScalar(glow * 0.55);
      heart.color.copy(cF);
      heart.intensity = glow * 30;

      // The boards: the Text feature's words, when there are any.
      const textOn = ((u.iTextOn?.value as number) ?? 0) > 0.5;
      board.uBoardOn.value = textOn ? 1 : 0;
      board.uBoardText.value = textOn ? (u.iText.value as THREE.Texture) : blankTex;
      linColour(u.board_color.value, board.uInk.value);
      board.uInkGlow.value = react(u, 'board') * 1.4 * (0.85 + 0.15 * Math.sin(t * 31) * Math.sin(t * 17));
      const sv = react(u, 'servers');
      const flick = 0.6 + 0.4 * Math.sin(t * 13) * Math.sin(t * 7.3);
      for (const m of blink) m.emissive.copy(cS).multiplyScalar(sv * 3.2 * flick);

      motes.points.visible = shown(u, 'spores');
      motes.uniforms.uTime.value = t;
      motes.uniforms.uRise.value = 0.25;
      motes.uniforms.uSize.value = 14;
      motes.uniforms.uColor.value.copy(cF).lerp(cA, 0.4).multiplyScalar(react(u, 'spores') * (0.5 + beat));

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = shown(u, 'haze') ? 0.01 + react(u, 'haze') * 0.07 : 0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.5);
      bloom.strength = 0.15 + react(u, 'bloom') * 0.6 + beat * 0.3;

      const route = option(u, 'route', ROUTES.length);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      camera.fov = Math.min(110, Math.max(30, u.iCamFov.value as number));
      if (route === 0) {
        walker.place(camera, t * 0.55 + orbit * 2, t);
        camera.position.y += Math.sin(t * 5) * 0.02 + hgt * 0.4;
      } else if (route === 1) {
        // Lying between the racks, looking up as the ribs turn overhead.
        const a = orbit + t * 0.06;
        camera.position.set(0.3, floorY + 0.6 + hgt, 5.6);
        target.set(0.3 + Math.sin(a) * 3, floorY + 7, 5.6 + Math.cos(a) * 3);
        camera.up.set(Math.sin(a), 0.2, Math.cos(a)).normalize();
        camera.lookAt(target);
        camera.up.set(0, 1, 0);
      } else {
        const a = orbit + t * 0.05;
        const r = 5.5 * dist;
        camera.position.set(Math.sin(a) * r, 2.2 + hgt * 2, Math.cos(a) * r);
        target.set(-Math.sin(a) * 4, floorY + 0.5, -Math.cos(a) * 4);
        camera.lookAt(target);
      }
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
  void box;
  (runtime as any).camera = camera;
  return runtime;
}

/* Tone map, then the crunch: big pixels, an ordered dither down to a few
 * levels a channel, and a vignette. */
const imageShader = `${imageHead}
uniform float crunch_react;
uniform float crunch_visible;
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer(vec2 p){ return bayer2(0.5 * p) * 0.25 + bayer2(p) - 0.5; }
void main(){
  float k = crunch_visible > 0.5 ? clamp(crunch_react, 0.0, 2.0) : 0.0;
  // Pixel rows on screen: full resolution at 0, 240 at 1, 96 at 2.
  float rows = mix(iResolution.y, mix(240.0, 96.0, clamp(k - 1.0, 0.0, 1.0)), clamp(k, 0.0, 1.0));
  vec2 cells = vec2(rows * iResolution.x / iResolution.y, rows);
  vec2 uv = k > 0.01 ? (floor(vUv * cells) + 0.5) / cells : vUv;
  vec3 c = texture2D(iChannel0, uv).rgb;
  c = pow(aces(c * 1.15), vec3(1.0 / 2.2));
  if(k > 0.01){
    float levels = mix(48.0, 10.0, clamp(k, 0.0, 1.0));
    c = floor(c * levels + 0.5 + bayer(vUv * cells) * clamp(k, 0.0, 1.0)) / levels;
  }
  vec2 d = vUv - 0.5;
  c *= 1.0 - 0.6 * smoothstep(0.3, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (grain(vUv * iResolution.xy) - 0.5) * 0.03;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const leviathan: ShaderDef = {
  id: 'leviathan',
  name: 'Leviathan',
  description:
    'A scene shader: a control room built inside a dead megalodon, alarm lamps chasing round the racks and the carcass glowing like a heartbeat. ' +
    'Model: "animal company - Megalodon Dead End Control Room" by Romeo rios vr (sketchfab.com/rrios2027), CC-BY-4.0.',
  bufferShader: sceneBuffer('Leviathan', 'scene-leviathan.ts'),
  imageShader,
  scene: { url: 'scenes/leviathan.glb', setup: setupLeviathan },
  palettes: [
    { name: 'Dead end', colors: { alarm: '#ff2a1a', flesh: '#ff5a3c', servers: '#5dff9a', board: '#ff2a1a', haze: '#120608' } },
    { name: 'Abyss', colors: { alarm: '#1f6bff', flesh: '#19d3c5', servers: '#bfe4ff', board: '#19d3c5', haze: '#030a14' } },
    { name: 'Bile', colors: { alarm: '#b6ff1a', flesh: '#e8ff5a', servers: '#ff3d8a', board: '#b6ff1a', haze: '#0a1004' } },
    { name: 'Autopsy', colors: { alarm: '#f2f6ff', flesh: '#ff9a9a', servers: '#ffb238', board: '#c0101a', haze: '#0c0c10' } },
    { name: 'Ultraviolet', colors: { alarm: '#8a2bff', flesh: '#ff2bd6', servers: '#22e6ff', board: '#ff2bd6', haze: '#0a0414' } },
  ],
  elements: [
    { id: 'route', name: 'Route', description: 'Walk the loop between the racks, lie on the deck looking up into the ribs, or watch from above.', defaultBand: 'none', defaultAmount: 0, defaultLevel: 1 / ROUTES.length, canHide: false, defaultVisible: true, options: ROUTES },
    { id: 'alarm', name: 'Alarm', description: 'Emergency lamps chasing each other round the walk. On the kick, they slam.', defaultBand: 'low', defaultAmount: 0.8, defaultLevel: 0.7, canHide: true, defaultVisible: true, defaultColor: '#ff2a1a' },
    { id: 'flesh', name: 'Flesh', description: 'The ribs and guts glowing from inside, on a heartbeat of their own plus whatever you feed them.', defaultBand: 'low', defaultAmount: 0.6, defaultLevel: 0.5, canHide: false, defaultVisible: true, defaultColor: '#ff5a3c' },
    { id: 'servers', name: 'Servers', description: 'The rack lights and the one screen still on.', defaultBand: 'high', defaultAmount: 0.8, defaultLevel: 0.6, canHide: false, defaultVisible: true, defaultColor: '#5dff9a' },
    { id: 'board', name: 'Whiteboard', description: 'The two whiteboards. Type words into the Text feature and they are wiped and written up in marker (hide the full-screen text if you only want them here). Ink colour, and how much it glows.', defaultBand: 'mid', defaultAmount: 0.5, defaultLevel: 0.5, canHide: false, defaultVisible: true, defaultColor: '#ff2a1a' },
    { id: 'spores', name: 'Spores', description: 'Motes drifting up through the carcass.', defaultBand: 'mid', defaultAmount: 0.5, defaultLevel: 0.5, canHide: true, defaultVisible: true },
    { id: 'crunch', name: 'Crunch', description: 'Chunky pixels and dither, to match the low-poly model. 0 is clean; past 1 it gets brutal.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.8, canHide: true, defaultVisible: true },
    { id: 'haze', name: 'Haze', description: 'Fog colour and density. Hide for clear air.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.4, canHide: true, defaultVisible: true, defaultColor: '#120608' },
    { id: 'bloom', name: 'Bloom', description: 'How far the light spills.', defaultBand: 'low', defaultAmount: 0.5, defaultLevel: 0.6, canHide: false, defaultVisible: true },
  ],
};
