/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model: "Science Lab Assets" by caitydesu
 * https://sketchfab.com/3d-models/science-lab-assets-0b71f4dd1a55457b9e69a60cb73f06dd
 * licensed CC-BY-4.0. Prepared by tools/prep-scenes.py.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';
import { beatPulse, imageHead, linColour, makeMotes, option, react, sceneBuffer, shown } from './scene-kit';

/*
 * "Specimen" — a scene shader: a corner of a lab as a diorama in the dark. A
 * server tower, a desk of four monitors, an examination chair, two vats and
 * something green leaking across the floor.
 *
 * Unlike the walk-through scenes this one is a set piece: two walls and a
 * floor, seen from outside, so the camera swings round the open side.
 *
 * Elements:
 *   route   -> Swing (an arc round the open side), Desk (close on the
 *              monitors), or Above (straight down, turning slowly)
 *   screens -> the monitors: colour, and how bright; they flicker
 *   toxic   -> the puddle and what it lights
 *   leds    -> the server tower's lights
 *   key     -> the one lamp over the set: colour and level
 *   scan    -> a sheet of light sweeping the set, floor to ceiling
 *   haze    -> fog colour and density
 *   bloom   -> how far the light spills
 */

const ROUTES = ['Swing', 'Desk', 'Above'];

function setupSpecimen(root: THREE.Object3D, renderer: THREE.WebGLRenderer): SceneRuntime {
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const centre = new THREE.Vector3(-3.1, 1.5, 2.2);

  // Soft studio reflections for the metal and glass; kept low.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  // The scan sheet: every lit material gets a band of light at a height.
  const scan = { uScanY: { value: -10 }, uScanColor: { value: new THREE.Color() } };
  const addScan = (m: THREE.MeshStandardMaterial) => {
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, scan);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vWorldY;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldY = (modelMatrix * vec4(transformed, 1.0)).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vWorldY;\nuniform float uScanY;\nuniform vec3 uScanColor;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\nfloat sd = abs(vWorldY - uScanY);\ntotalEmissiveRadiance += uScanColor * (exp(-sd * 40.0) + 0.15 * exp(-sd * 4.0));',
        );
    };
    m.customProgramCacheKey = () => 'specimen-scan';
  };

  const screens: THREE.MeshStandardMaterial[] = [];
  const leds: THREE.MeshStandardMaterial[] = [];
  let puddle: THREE.MeshStandardMaterial | null = null;
  const puddleAt = new THREE.Vector3(-1, 0.05, 3.6);
  const seen = new Set<THREE.Material>();
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial;
    if (seen.has(m)) return;
    seen.add(m);
    const name = m.name || '';
    m.envMapIntensity = 0.12;
    if (/monitor|screen|minidisk/i.test(name) && !/mat$/i.test(name) && name !== 'Screen' && name !== 'Smallglassmonitor') {
      // The lit displays: their picture becomes light.
      m.emissiveMap = m.map;
      m.emissive = new THREE.Color(0, 0, 0);
      screens.push(m);
    } else if (name === 'Lights') {
      m.emissive = new THREE.Color(0, 0, 0);
      leds.push(m);
    } else if (name === 'Puddle2') {
      puddle = m;
      m.emissiveIntensity = 1;
      m.roughness = 0.15;
      o.geometry.computeBoundingBox();
      o.geometry.boundingBox.getCenter(puddleAt).applyMatrix4(o.matrixWorld);
    } else if (name === 'Screen' || name === 'Glass' || name === 'Smallglassmonitor') {
      // The glass in front of each display.
      m.transparent = true;
      m.opacity = 0.12;
      m.color.setRGB(0.6, 0.8, 0.9);
      m.roughness = 0.05;
      m.depthWrite = false;
      m.envMapIntensity = 0.5;
    }
    if (!m.transparent) addScan(m);
  });

  scene.add(new THREE.HemisphereLight(0x2a3040, 0x08080a, 0.3));
  const key = new THREE.SpotLight(0xffffff, 0, 16, 0.75, 0.6, 1.2);
  key.position.set(-3, 6.2, 5);
  key.target.position.copy(centre).setY(0.5);
  scene.add(key, key.target);
  const toxic = new THREE.PointLight(0xffffff, 0, 6, 1.6);
  toxic.position.copy(puddleAt).setY(0.35);
  scene.add(toxic);
  const screenGlow = new THREE.PointLight(0xffffff, 0, 5, 1.8);
  screenGlow.position.set(-3.3, 1.9, 3.1);
  scene.add(screenGlow);

  // A floor running off into the dark, so the set does not float.
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: 0x020203, roughness: 0.4, metalness: 0.5, envMapIntensity: 0.02 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = box.min.y - 0.01;
  scene.add(ground);

  const motes = makeMotes(new THREE.Box3(new THREE.Vector3(-7, 0, 0.2), new THREE.Vector3(1, 4.6, 5.5)), 700);
  scene.add(motes.points);

  scene.fog = new THREE.FogExp2(0x05070a, 0.04);
  scene.background = new THREE.Color(0x020304);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.05, 120);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 1.0);
  const cS = new THREE.Color(), cT = new THREE.Color(), cL = new THREE.Color(), cK = new THREE.Color(),
    cN = new THREE.Color(), cH = new THREE.Color();
  const target = new THREE.Vector3();

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const beat = beatPulse(u);
      linColour(u.screens_color.value, cS);
      linColour(u.toxic_color.value, cT);
      linColour(u.leds_color.value, cL);
      linColour(u.key_color.value, cK);
      linColour(u.scan_color.value, cN);
      linColour(u.haze_color.value, cH);

      const sv = react(u, 'screens');
      const flick = 0.85 + 0.15 * Math.sin(t * 50) * Math.sin(t * 13.7);
      for (const m of screens) m.emissive.copy(cS).multiplyScalar(sv * 0.55 * flick);
      screenGlow.color.copy(cS);
      screenGlow.intensity = sv * 1.6 * flick;

      const tv = react(u, 'toxic');
      const breathe = 0.7 + 0.3 * Math.sin(t * 1.3);
      if (puddle) {
        (puddle as THREE.MeshStandardMaterial).color.copy(cT).multiplyScalar(0.3);
        (puddle as THREE.MeshStandardMaterial).emissive.copy(cT).multiplyScalar(tv * 0.9 * breathe * (1 + beat));
      }
      toxic.color.copy(cT);
      toxic.intensity = tv * 3 * breathe * (1 + beat);

      const lv = react(u, 'leds');
      for (const m of leds) m.emissive.copy(cL).multiplyScalar(lv * 1.5 * (0.6 + 0.4 * Math.sin(t * 9)));

      key.color.copy(cK);
      key.intensity = react(u, 'key') * 45;

      // The scan climbs the set and starts again; faster with more signal.
      const nv = shown(u, 'scan') ? react(u, 'scan') : 0;
      scan.uScanY.value = ((t * (0.35 + nv * 0.5)) % 1.3) * 4.8 - 0.4;
      scan.uScanColor.value.copy(cN).multiplyScalar(nv * 0.7);

      motes.uniforms.uTime.value = t;
      motes.uniforms.uRise.value = 0.08;
      motes.uniforms.uSize.value = 9;
      motes.uniforms.uColor.value.copy(cK).multiplyScalar(react(u, 'key') * 0.5).add(cH.clone().multiplyScalar(0.2));

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = shown(u, 'haze') ? 0.008 + react(u, 'haze') * 0.06 : 0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.6);
      bloom.strength = 0.15 + react(u, 'bloom') * 0.55 + beat * 0.25;

      const route = option(u, 'route', ROUTES.length);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      camera.fov = Math.min(100, Math.max(20, (u.iCamFov.value as number) - 10));
      if (route === 0) {
        // Back and forth across the open side; never behind the walls.
        const a = Math.sin(t * 0.09 + orbit) * 1.0 + 0.25;
        const r = 8.5 * dist;
        camera.position.set(centre.x + Math.sin(a) * r, 2.4 + hgt * 2.5, centre.z + Math.cos(a) * r);
        target.copy(centre);
      } else if (route === 1) {
        const a = Math.sin(t * 0.13 + orbit) * 0.35;
        const r = 2.6 * dist;
        camera.position.set(-3.3 + Math.sin(a) * r, 1.9 + hgt, 2.2 + Math.cos(a) * r);
        target.set(-3.3, 1.9, 2.1);
      } else {
        const a = orbit + t * 0.05;
        camera.position.set(centre.x + Math.sin(a) * 0.6, 9.5 * dist, centre.z + 0.4 + Math.cos(a) * 0.6);
        target.set(centre.x, 0, centre.z + 0.3);
      }
      camera.lookAt(target);
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
  c *= 1.0 - 0.55 * smoothstep(0.35, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (grain(vUv * iResolution.xy) - 0.5) * 0.025;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const specimen: ShaderDef = {
  id: 'specimen',
  name: 'Specimen',
  description:
    'A scene shader: a corner of a lab as a diorama in the dark — monitors, a server tower, vats and something green on the floor. ' +
    'Model: "Science Lab Assets" by caitydesu (sketchfab.com/caitydesu), CC-BY-4.0.',
  bufferShader: sceneBuffer('Specimen', 'scene-specimen.ts'),
  imageShader,
  scene: { url: 'scenes/specimen.glb', setup: setupSpecimen },
  palettes: [
    { name: 'Containment', colors: { screens: '#7dffa0', toxic: '#39ff14', leds: '#ff3b30', key: '#cfe0ff', scan: '#39ff14', haze: '#05070a' } },
    { name: 'Clean room', colors: { screens: '#bfe4ff', toxic: '#22e6ff', leds: '#ffffff', key: '#ffffff', scan: '#22e6ff', haze: '#0a0e14' } },
    { name: 'Biohazard', colors: { screens: '#ffb238', toxic: '#ffd400', leds: '#ff2a1a', key: '#ffd9a0', scan: '#ff7a1a', haze: '#100a02' } },
    { name: 'Mutagen', colors: { screens: '#ff2bd6', toxic: '#b04dff', leds: '#22e6ff', key: '#8a7aff', scan: '#ff2bd6', haze: '#0a0414' } },
    { name: 'Quarantine', colors: { screens: '#ff3326', toxic: '#ff2a1a', leds: '#ff8a7a', key: '#40181a', scan: '#ff2a1a', haze: '#120304' } },
  ],
  elements: [
    { id: 'route', name: 'Route', description: 'Swing round the open side of the set, sit close on the desk of monitors, or look straight down.', defaultBand: 'none', defaultAmount: 0, defaultLevel: 1 / ROUTES.length, canHide: false, defaultVisible: true, options: ROUTES },
    { id: 'screens', name: 'Screens', description: 'The monitors and server displays: colour, and how bright.', defaultBand: 'mid', defaultAmount: 0.7, defaultLevel: 0.7, canHide: false, defaultVisible: true, defaultColor: '#7dffa0' },
    { id: 'toxic', name: 'Toxic', description: 'The puddle glowing, and the light it throws up the vats. On the kick, it surges.', defaultBand: 'low', defaultAmount: 0.9, defaultLevel: 0.6, canHide: false, defaultVisible: true, defaultColor: '#39ff14' },
    { id: 'leds', name: 'LEDs', description: 'The lights on the server tower.', defaultBand: 'high', defaultAmount: 0.9, defaultLevel: 0.5, canHide: false, defaultVisible: true, defaultColor: '#ff3b30' },
    { id: 'key', name: 'Key light', description: 'The one lamp over the set. Down, and only the screens and the puddle light it.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.5, canHide: false, defaultVisible: true, defaultColor: '#cfe0ff' },
    { id: 'scan', name: 'Scan', description: 'A sheet of light sweeping up the set; more signal, faster and brighter.', defaultBand: 'high', defaultAmount: 0.6, defaultLevel: 0.4, canHide: true, defaultVisible: true, defaultColor: '#39ff14' },
    { id: 'haze', name: 'Haze', description: 'Fog colour and density. Hide for clear air.', defaultBand: 'none', defaultAmount: 0.3, defaultLevel: 0.3, canHide: true, defaultVisible: true, defaultColor: '#05070a' },
    { id: 'bloom', name: 'Bloom', description: 'How far the light spills.', defaultBand: 'low', defaultAmount: 0.5, defaultLevel: 0.6, canHide: false, defaultVisible: true },
  ],
};
