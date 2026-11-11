/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model: "DAE Diorama - By the Ocean" by Sidney Eliot Bundschuh (sidney-eliot)
 * https://sketchfab.com/3d-models/dae-diorama-by-the-ocean-e6dffd4062c64986afaf11b5a497ddff
 * licensed CC-BY-4.0. Prepared by tools/prep-scenes.py.
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';
import { Walker, beatPulse, hash, imageHead, linColour, makeMotes, option, react, sceneBuffer, shown } from './scene-kit';

/*
 * "Seawall" — a scene shader: a slice of a coastal town as a diorama at night.
 * Waves break against a seawall road, houses and power poles climb the cliff
 * behind it, a tunnel runs into the rock with something red-eyed inside, and
 * fireflies hang over the gardens.
 *
 * The houses are below the road, behind the wall, so the set is seen from
 * its cut-open side, or walked at street level.
 *
 * Elements:
 *   route     -> Town (an arc round the open side, where the houses sit behind
 *                the wall), Walk (down the street between the houses, into
 *                the tunnel and back), Ocean (low over the water, facing the
 *                wall), or Above (straight down, turning slowly)
 *   moon      -> the moonlight: colour, and how much
 *   waves     -> the swell rising and falling, and the foam glowing
 *   lamps     -> the red lights, the eyes in the tunnel, and the town's windows
 *   fireflies -> the fireflies over the gardens
 *   lightning -> flashes from out at sea; on the beat with a band on it
 *   haze      -> sea mist: colour and density
 *   bloom     -> how far the light spills
 */

const ROUTES = ['Town', 'Walk', 'Ocean', 'Above'];
// A loop at eye height through the street behind the wall and into the tunnel
// and back, planned in Blender (tools/walk-plan.py), glTF axes.
const PATH: number[][] = [[0.2, 1.52, 10.71], [0.26, 1.52, 9.93], [0.32, 1.52, 8.92], [0.32, 1.52, 7.91], [0.32, 1.52, 6.9], [0.31, 1.52, 5.88], [0.04, 1.52, 4.87], [-0.45, 1.52, 3.86], [-0.38, 1.52, 2.84], [-0.32, 1.52, 1.83], [-0.32, 1.52, 0.82], [-0.32, 1.52, -0.2], [-0.32, 1.52, -1.21], [-0.31, 1.52, -2.23], [-0.1, 1.52, -3.24], [0.25, 1.52, -4.25], [0.32, 1.52, -5.27], [0.32, 1.52, -6.28], [0.32, 1.52, -7.29], [0.32, 1.52, -8.31], [0.32, 1.52, -9.32], [0.32, 1.52, -10.33], [0.32, 1.52, -11.22], [0.32, 1.52, -11.22], [0.32, 1.52, -10.33], [0.32, 1.52, -9.32], [0.33, 1.52, -8.31], [0.47, 1.52, -7.29], [0.47, 1.52, -6.28], [0.33, 1.52, -5.27], [0.32, 1.52, -4.25], [0.39, 1.52, -3.24], [0.73, 1.52, -2.23], [0.94, 1.52, -1.21], [1.03, 1.53, -0.2], [1.66, 1.57, 0.82], [2.56, 1.6, 1.83], [2.85, 1.6, 2.84], [2.86, 1.6, 3.86], [2.86, 1.6, 4.87], [2.87, 1.6, 5.88], [3.16, 1.6, 6.9], [4.11, 1.6, 7.91], [4.8, 1.6, 8.92], [4.1, 1.57, 9.94], [2.86, 1.53, 10.83], [1.59, 1.52, 11.06], [0.47, 1.52, 10.89]];

function setupSeawall(root: THREE.Object3D): SceneRuntime {
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const centre = new THREE.Vector3(-3, 6, -2);

  let waterMesh: THREE.Object3D | null = null;
  let waterY = 0;
  let water: THREE.MeshStandardMaterial | null = null;
  const reds: THREE.MeshStandardMaterial[] = [];
  const warm: THREE.MeshStandardMaterial[] = [];
  const flies: THREE.MeshStandardMaterial[] = [];
  const seen = new Set<THREE.Material>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial;
    if (seen.has(m)) return;
    seen.add(m);
    const name = m.name || '';
    m.envMapIntensity = 0;
    m.metalness = 0;
    m.roughness = Math.max(m.roughness ?? 1, 0.7);
    if (m.transparent) {
      // Cut-outs (leaves, cables, decals): tested, not blended, so they sort.
      m.transparent = false;
      m.alphaTest = 0.4;
      m.side = THREE.DoubleSide;
    }
    if (/Ocean/.test(name)) {
      water = m;
      m.roughness = 0.35;
      m.emissiveMap = m.map;
      m.emissive = new THREE.Color(0, 0, 0);
      waterMesh = o;
      waterY = o.position.y;
    } else if (/Red_Light|Red_Eyes/.test(name)) {
      reds.push(m);
    } else if (/Flower_Petals|Interior/.test(name)) {
      if (!m.emissiveMap) m.emissiveMap = m.map;
      warm.push(m);
    } else if (/Firefly/.test(name)) {
      flies.push(m);
    }
  });

  const hemi = new THREE.HemisphereLight(0xffffff, 0x0a0a10, 0);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0xffffff, 0);
  moon.position.set(-30, 40, 25);
  scene.add(moon);
  const flash = new THREE.DirectionalLight(0xffffff, 0);
  flash.position.set(-60, 30, 10); // from out at sea
  scene.add(flash);
  const redLamp = new THREE.PointLight(0xffffff, 0, 12, 1.5);
  redLamp.position.set(-1.4, 2.4, -7.6);
  scene.add(redLamp);
  const townLamps: THREE.PointLight[] = [];
  // Street lamps: every sixth point of the walk, overhead.
  for (let i = 2; i < PATH.length; i += 6) {
    const l = new THREE.PointLight(0xffb060, 0, 16, 1.6);
    l.position.set(PATH[i][0], PATH[i][1] + 1.6, PATH[i][2]);
    scene.add(l);
    townLamps.push(l);
  }

  const motes = makeMotes(new THREE.Box3(new THREE.Vector3(-2, 0.5, -3), new THREE.Vector3(13, 10, 13)), 500);
  scene.add(motes.points);

  scene.fog = new THREE.FogExp2(0x060a12, 0.01);
  scene.background = new THREE.Color(0x02040a);
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 400);
  const walker = new Walker(PATH);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 1.0);
  const cM = new THREE.Color(), cW = new THREE.Color(), cL = new THREE.Color(), cF = new THREE.Color(),
    cZ = new THREE.Color(), cH = new THREE.Color();
  const target = new THREE.Vector3();

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const beat = beatPulse(u);
      linColour(u.moon_color.value, cM);
      linColour(u.waves_color.value, cW);
      linColour(u.lamps_color.value, cL);
      linColour(u.fireflies_color.value, cF);
      linColour(u.lightning_color.value, cZ);
      linColour(u.haze_color.value, cH);

      const mv = react(u, 'moon');
      hemi.color.copy(cM);
      hemi.intensity = mv * 4;
      moon.color.copy(cM);
      moon.intensity = mv * 9;

      const wv = react(u, 'waves');
      // The swell: the whole sea rises and falls against the wall.
      if (waterMesh) {
        const up = (0.25 + wv * 0.5) * (Math.sin(t * 0.9) * 0.6 + Math.sin(t * 0.37 + 1.3) * 0.4) + beat * wv * 0.35;
        // The mesh may sit under a scaled parent; move it by a world distance.
        const sy = (waterMesh as THREE.Object3D).parent?.getWorldScale(target).y || 1;
        (waterMesh as THREE.Object3D).position.y = waterY + up / sy;
      }
      if (water) (water as THREE.MeshStandardMaterial).emissive.copy(cW).multiplyScalar(wv * 0.45 * (1 + beat * 0.6));

      const lv = react(u, 'lamps');
      const pulse = 0.7 + 0.3 * Math.sin(t * 2.1);
      for (const m of reds) {
        m.emissive.copy(cL);
        m.emissiveIntensity = lv * 5 * pulse;
      }
      redLamp.color.copy(cL);
      redLamp.intensity = lv * 10 * pulse;
      for (const m of warm) m.emissiveIntensity = lv * 1.2;
      townLamps.forEach((l, i) => (l.intensity = lv * 14 * (0.85 + 0.15 * Math.sin(t * 7 + i * 2.3))));

      const fv = shown(u, 'fireflies') ? react(u, 'fireflies') : 0;
      for (const m of flies) {
        m.emissive.copy(cF);
        m.emissiveIntensity = fv * 6 * (0.6 + 0.4 * Math.sin(t * 3.1));
      }
      motes.points.visible = fv > 0;
      motes.uniforms.uTime.value = t;
      motes.uniforms.uRise.value = 0.05;
      motes.uniforms.uSize.value = 16;
      motes.uniforms.uColor.value.copy(cF).multiplyScalar(fv * 1.5);

      // Lightning: a strike now and then (two quick flickers), and the beat.
      const zv = shown(u, 'lightning') ? react(u, 'lightning') : 0;
      const slot = Math.floor(t * 0.7);
      const ph = t * 0.7 - slot;
      const strike = hash(slot * 3.3) > 0.72 ? Math.exp(-ph * 14) + 0.6 * Math.exp(-Math.abs(ph - 0.12) * 40) : 0;
      const z = zv * Math.min(1.5, strike + beat * 0.8);
      flash.color.copy(cZ);
      flash.intensity = z * 9;

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH).lerp(cZ, Math.min(0.1, z * 0.08));
      fog.density = shown(u, 'haze') ? 0.002 + react(u, 'haze') * 0.014 : 0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.6).lerp(cZ, Math.min(0.08, z * 0.06));
      bloom.strength = 0.15 + react(u, 'bloom') * 0.55 + beat * 0.25;

      const route = option(u, 'route', ROUTES.length);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      const fov = u.iCamFov.value as number;
      camera.fov = Math.min(100, Math.max(20, route === 1 ? fov + 5 : fov - 20));
      if (route === 0) {
        // Back and forth across the cut-open side, looking in at the houses.
        const a = 0.95 + Math.sin(t * 0.07 + orbit) * 0.5;
        const r = 50 * dist;
        camera.position.set(4 + Math.sin(a) * r, 16 + hgt * 16, 2 + Math.cos(a) * r);
        target.set(3, 4, 0);
        camera.lookAt(target);
      } else if (route === 1) {
        walker.place(camera, t * 0.6 + orbit * 2, t, -0.02);
        camera.position.y += Math.sin(t * 5) * 0.02 + hgt * 0.4;
      } else if (route === 2) {
        const a = -1.0 + Math.sin(t * 0.09 + orbit) * 0.45;
        const r = 34 * dist;
        camera.position.set(centre.x + Math.sin(a) * r, 9 + hgt * 8, centre.z + Math.cos(a) * r);
        target.set(1, 5, -2);
        camera.lookAt(target);
      } else {
        const a = orbit + t * 0.04;
        camera.position.set(centre.x + Math.sin(a) * 3, 70 * dist, centre.z + Math.cos(a) * 3);
        target.set(centre.x, 0, centre.z);
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
  return runtime;
}

const imageShader = `${imageHead}
void main(){
  vec2 d = vUv - 0.5;
  float ca = 0.002 * dot(d, d);
  vec3 c = vec3(texture2D(iChannel0, vUv + d * ca * 4.0).r,
                texture2D(iChannel0, vUv).g,
                texture2D(iChannel0, vUv - d * ca * 4.0).b);
  c = pow(aces(c * 1.1), vec3(1.0 / 2.2));
  c *= 1.0 - 0.5 * smoothstep(0.35, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (grain(vUv * iResolution.xy) - 0.5) * 0.03;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const seawall: ShaderDef = {
  id: 'seawall',
  name: 'Seawall',
  description:
    'A scene shader: a coastal town as a diorama at night — waves on the seawall, lamps up the cliff, fireflies, and lightning out at sea. ' +
    'Model: "DAE Diorama - By the Ocean" by Sidney Eliot Bundschuh (sketchfab.com/sidney-eliot), CC-BY-4.0.',
  bufferShader: sceneBuffer('Seawall', 'scene-seawall.ts'),
  imageShader,
  scene: { url: 'scenes/seawall.glb', setup: setupSeawall },
  palettes: [
    { name: 'Night tide', colors: { moon: '#8fa8ff', waves: '#bfe4ff', lamps: '#ff2a1a', fireflies: '#ffd05c', lightning: '#e8f0ff', haze: '#060a12' } },
    { name: 'Dusk', colors: { moon: '#ffb38a', waves: '#ffd9c2', lamps: '#ff5a1f', fireflies: '#fff0a0', lightning: '#ffe7c2', haze: '#2a1a24' } },
    { name: 'Red tide', colors: { moon: '#5a2030', waves: '#ff3d5a', lamps: '#ff1a1a', fireflies: '#ff8a7a', lightning: '#ff2a1a', haze: '#120406' } },
    { name: 'Phosphor', colors: { moon: '#1f5a4a', waves: '#3dffb0', lamps: '#22e6ff', fireflies: '#b6ff1a', lightning: '#9cffe0', haze: '#03100c' } },
    { name: 'Storm', colors: { moon: '#4a5260', waves: '#f2f6ff', lamps: '#ffb238', fireflies: '#ffffff', lightning: '#ffffff', haze: '#0c0e12' } },
  ],
  elements: [
    { id: 'route', name: 'Route', description: 'Swing round the open side where the houses are, walk the street and the tunnel, sit low over the water facing the wall, or look straight down.', defaultBand: 'none', defaultAmount: 0, defaultLevel: 1 / ROUTES.length, canHide: false, defaultVisible: true, options: ROUTES },
    { id: 'moon', name: 'Moonlight', description: 'The moon on everything: colour, and how much.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.6, canHide: false, defaultVisible: true, defaultColor: '#8fa8ff' },
    { id: 'waves', name: 'Waves', description: 'The swell rising and falling, and the foam glowing. Put it on the bass and the sea heaves.', defaultBand: 'low', defaultAmount: 0.8, defaultLevel: 0.4, canHide: false, defaultVisible: true, defaultColor: '#bfe4ff' },
    { id: 'lamps', name: 'Lamps', description: 'The red lights, the eyes in the tunnel and the lamps of the town.', defaultBand: 'mid', defaultAmount: 0.6, defaultLevel: 0.6, canHide: false, defaultVisible: true, defaultColor: '#ff2a1a' },
    { id: 'fireflies', name: 'Fireflies', description: 'The fireflies over the gardens.', defaultBand: 'high', defaultAmount: 0.8, defaultLevel: 0.5, canHide: true, defaultVisible: true, defaultColor: '#ffd05c' },
    { id: 'lightning', name: 'Lightning', description: 'Flashes from out at sea, now and then by themselves and on the beat.', defaultBand: 'high', defaultAmount: 0.8, defaultLevel: 0.5, canHide: true, defaultVisible: true, defaultColor: '#e8f0ff' },
    { id: 'haze', name: 'Sea mist', description: 'Mist colour and density. Hide for clear air.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.35, canHide: true, defaultVisible: true, defaultColor: '#060a12' },
    { id: 'bloom', name: 'Bloom', description: 'How far the light spills.', defaultBand: 'low', defaultAmount: 0.5, defaultLevel: 0.6, canHide: false, defaultVisible: true },
  ],
};
