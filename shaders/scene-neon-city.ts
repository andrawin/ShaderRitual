/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';

/*
 * "Neon City" — a scene shader: Buffer A is a GLB city drawn in three.js, not
 * GLSL. The model arrives as a daylight SketchUp export with no emissive
 * materials and no lights, so the night is made here:
 *
 *   - the untextured massing gets lit windows drawn in world space, a cell per
 *     window, each on or off, warm or cool or neon, a few flickering — faded
 *     to their average where they get smaller than a pixel, or the towers
 *     shimmer;
 *   - the one material that is a window texture is turned into light;
 *   - the SketchUp edge lines become glowing outlines;
 *   - neon point lights sit low among the buildings, in the two neon colours,
 *     pulsing on the music;
 *   - an environment of neon panels gives the metal something to reflect, and
 *     a dark, polished ground plays wet street;
 *   - haze swallows the distance, and the whole thing is rendered in linear
 *     HDR so the bloom and the tone map in the image pass have real light to
 *     work with.
 *
 * Elements:
 *   route   -> where the camera goes: orbit, flyover, or low along the skyline
 *   neon    -> the first neon colour, and how hard its lights burn
 *   glow    -> the second neon colour
 *   windows -> how many windows are lit, and how bright
 *   edges   -> the building outlines glowing (hideable)
 *   haze    -> fog colour and density (hideable)
 *   bloom   -> how far the light spills
 */

const ROUTES = ['Orbit', 'Flyover', 'Skyline'];

/** Linear colour from a uniform holding sRGB 0..1, as the colour elements do. */
function linColour(v: THREE.Vector3, out: THREE.Color): THREE.Color {
  return out.setRGB(v.x, v.y, v.z, THREE.SRGBColorSpace);
}

function setupNeonCity(root: THREE.Object3D, renderer: THREE.WebGLRenderer): SceneRuntime {
  const scene = new THREE.Scene();

  // --- Normalise: centred, on the ground, 100 units across. -----------------
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const s = 100 / Math.max(size.x, size.z, 1e-6);
  const holder = new THREE.Group();
  holder.scale.setScalar(s);
  root.position.set(-centre.x, -box.min.y, -centre.z);
  holder.add(root);
  scene.add(holder);
  const height = size.y * s;

  // --- Shared uniforms the material patches read. ---------------------------
  const win = {
    uWinIntensity: { value: 1.0 },
    uWinDensity: { value: 0.45 },
    uWinTime: { value: 0.0 },
    uWinCell: { value: new THREE.Vector2(0.34, 0.26) },
    // Nothing below this height gets windows: the city stands on a plinth,
    // and a lit plinth reads as a ring of glitch round the base.
    uWinMinY: { value: 1.45 },   // the plinth's top is at 1.35
    uNeonA: { value: new THREE.Color(1, 0.2, 0.8) },
    uNeonB: { value: new THREE.Color(0.1, 0.9, 1) },
  };

  /*
   * Windows, in world space. Each facade picks the axis it faces, cuts itself
   * into cells, and lights a cell or not from a hash that also takes the
   * facade's depth, so neighbouring buildings do not share one pattern.
   * fwidth() tells it when a window is smaller than a pixel; from there it
   * fades to the average a lit facade would have, rather than aliasing.
   */
  const patch = (mat: THREE.MeshStandardMaterial, density: number) => {
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, win, { uDensityScale: { value: density } });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWNrm;')
        .replace(
          '#include <project_vertex>',
          '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * objectNormal);',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vWPos;
varying vec3 vWNrm;
uniform float uWinIntensity;
uniform float uWinDensity;
uniform float uDensityScale;
uniform float uWinTime;
uniform vec2 uWinCell;
uniform float uWinMinY;
uniform vec3 uNeonA;
uniform vec3 uNeonB;
float winHash(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 windowGlow(vec3 p, vec3 n){
  vec3 an = abs(n);
  float side = an.x > an.z ? 1.0 : 0.0;
  vec2 q = (side > 0.5 ? vec2(p.z, p.y) : vec2(p.x, p.y)) / uWinCell;
  float depthKey = floor((side > 0.5 ? p.x : p.z) * 1.5);
  vec2 cell = floor(q);
  vec2 f = fract(q);
  float h = winHash(vec3(cell, depthKey));
  float hc = winHash(vec3(cell.yx + 3.7, depthKey + 7.0));
  float dens = uWinDensity * uDensityScale;
  float lit = step(1.0 - dens, h);
  vec2 m = smoothstep(vec2(0.10, 0.16), vec2(0.18, 0.24), f)
         * smoothstep(vec2(0.90, 0.84), vec2(0.82, 0.76), f);
  float pane = m.x * m.y;
  // Smaller than a pixel, a window cannot be drawn — and nor can the choice of
  // which ones are lit, which changes from pixel to pixel out there and
  // shimmers. Both are replaced by what a lit facade averages to.
  float far = smoothstep(0.45, 1.15, length(fwidth(q)));
  // Mostly ordinary light — warm rooms, cold offices — and only the odd
  // window in the neon colours. Too many and the towers read as noise.
  vec3 col = hc < 0.68 ? vec3(1.0, 0.66, 0.34)
           : hc < 0.94 ? vec3(0.62, 0.78, 1.0)
           : hc < 0.975 ? uNeonA : uNeonB;
  float flick = hc > 0.965 ? step(0.35, fract(sin(floor(uWinTime * 9.0) + h * 91.0) * 43758.5)) : 1.0;
  float facade = (1.0 - smoothstep(0.45, 0.7, an.y)) * smoothstep(uWinMinY, uWinMinY + 0.2, p.y);
  vec3 near = col * lit * pane * flick;
  vec3 avg = vec3(0.92, 0.70, 0.45) * dens * 0.2;
  return mix(near, avg, far) * facade * uWinIntensity;
}`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance += windowGlow(vWPos, normalize(vWNrm));',
        );
    };
    mat.customProgramCacheKey = () => `neoncity-win-${density}`;
  };

  // --- Materials. ----------------------------------------------------------------
  const edgeMats: THREE.LineBasicMaterial[] = [];
  const windowTexMats: THREE.MeshStandardMaterial[] = [];
  root.traverse((o: any) => {
    if (o.isLineSegments || o.isLine) {
      const old = o.material as THREE.Material & { opacity?: number };
      // The model's own hidden edges were drawn at alpha 0; keep them fainter.
      const hidden = (old.opacity ?? 1) < 0.05 || old.transparent;
      const m = new THREE.LineBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: hidden ? 0.16 : 0.8,
        depthWrite: false,
        toneMapped: false,
      });
      old.dispose();
      o.material = m;
      edgeMats.push(m);
      return;
    }
    if (!o.isMesh) return;
    const old = o.material as THREE.MeshStandardMaterial;
    const name = (old.name || '').toLowerCase();
    // Deepen the baked occlusion a touch: at night most of the frame is
    // emission it cannot touch, so what it can reach should count.
    //
    // Through getX/setXYZ, never the raw array. The baked file stores its
    // attributes interleaved, so the colour shares one buffer with position,
    // normal and UV at a 36-byte stride; walking .array in steps of four wrote
    // straight across the vertex positions, flung them to huge coordinates,
    // and buried the GPU in screen-filling triangles.
    const aoAttr = o.geometry && o.geometry.getAttribute('color');
    if (aoAttr) {
      for (let i = 0; i < aoAttr.count; i++) {
        const v = Math.pow(aoAttr.getX(i), 1.5);
        aoAttr.setXYZ(i, v, v, v);
      }
      aoAttr.needsUpdate = true;
    }
    const m = new THREE.MeshStandardMaterial({
      map: old.map || null,
      color: old.color ? old.color.clone() : new THREE.Color(0.6, 0.6, 0.65),
      side: THREE.DoubleSide,
      // Ambient occlusion baked offline into the file's vertex colours:
      // darker where towers crowd each other and meet the ground.
      vertexColors: !!(o.geometry && o.geometry.getAttribute('color')),
    });
    if (name.startsWith('lights')) {
      // The one window texture in the model: it becomes light.
      m.emissiveMap = old.map || null;
      m.emissive = new THREE.Color(1, 0.85, 0.6);
      m.color.setRGB(0.05, 0.05, 0.06);
      m.roughness = 0.6;
      m.metalness = 0.2;
      windowTexMats.push(m);
    } else {
      // Night-dark cladding. A facade at night is dark with points of light
      // in it; brighter than this and the towers read as lit cardboard.
      m.color.multiplyScalar(0.2);
      m.metalness = old.map ? 0.7 : 0.4;
      m.roughness = old.map ? 0.34 : 0.55;
      m.envMapIntensity = 0.45;
      patch(m, old.map ? 0.55 : 1.0);
    }
    old.dispose();
    o.material = m;
  });

  // --- Ground: dark and polished, standing in for wet street. ---------------
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    // Rough enough that it catches the lights as smeared highlights, as wet
    // asphalt does, and barely reflects the environment: near-mirror, its
    // grazing reflection of the neon panels blew the low views out.
    new THREE.MeshStandardMaterial({ color: 0x050508, metalness: 0.6, roughness: 0.5, envMapIntensity: 0.15 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  // --- Light. --------------------------------------------------------------------
  // Enough sky fill that the cladding shows its form — without it the towers
  // are flat silhouettes with windows in them — and that fill is what the
  // baked occlusion darkens in the canyons and at the foot of each tower.
  const hemi = new THREE.HemisphereLight(0x3a4f9a, 0x12061c, 2.2);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.9);
  moon.position.set(-40, 80, -30);
  scene.add(moon);

  // Neon lights low among the buildings, alternating the two colours.
  const neonLights: { light: THREE.PointLight; a: boolean; phase: number }[] = [];
  const N = 10;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2 + (i % 2) * 0.4;
    const r = i < 4 ? 12 + i * 4 : 28 + (i % 3) * 8;
    const light = new THREE.PointLight(0xffffff, 0, 26, 1.7);
    light.position.set(Math.cos(ang) * r, 1.2 + (i % 3) * 2.2, Math.sin(ang) * r);
    scene.add(light);
    neonLights.push({ light, a: i % 2 === 0, phase: i * 1.37 });
  }

  // --- Reflections: a room of neon panels, rebuilt only when a colour changes.
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  let envKey = '';
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20),
    new THREE.MeshBasicMaterial({ color: 0x020205, side: THREE.BackSide })));
  const panelA = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panelB = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const panelW = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 0.9, 0.7) });
  const addPanel = (mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, ry: number) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    envScene.add(p);
  };
  addPanel(panelA, -9.5, 1, -2, 6, 1.2, Math.PI / 2);
  addPanel(panelB, 9.5, 2, 3, 6, 1.0, -Math.PI / 2);
  addPanel(panelA, 2, 0, -9.5, 8, 0.8, 0);
  addPanel(panelB, -3, 3, 9.5, 5, 1.4, Math.PI);
  addPanel(panelW, 0, -2, 9.5, 10, 0.6, Math.PI);
  const rebuildEnv = (a: THREE.Color, b: THREE.Color) => {
    const key = a.getHexString() + b.getHexString();
    if (key === envKey) return;
    envKey = key;
    panelA.color.copy(a).multiplyScalar(1.6);
    panelB.color.copy(b).multiplyScalar(1.6);
    envRT?.dispose();
    envRT = pmrem.fromScene(envScene, 0.02);
    scene.environment = envRT.texture;
  };

  // --- Haze and sky. -------------------------------------------------------------
  scene.fog = new THREE.FogExp2(0x140a2e, 0.012);
  scene.background = new THREE.Color(0x0a0618);

  // --- Camera and bloom. -------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 900);
  // Thresholded above 1.0, so only real light blooms, not every lit surface.
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.4, 1.1);

  const cA = new THREE.Color();
  const cB = new THREE.Color();
  const cE = new THREE.Color();
  const cH = new THREE.Color();
  const target = new THREE.Vector3();
  let lastT = 0;

  const runtime: SceneRuntime & { scene?: THREE.Scene } = {
    update(u) {
      const t = u.iTime.value as number;
      const dt = Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      void dt;
      const rv = (id: string) => Math.max(0, (u[`${id}_react`]?.value as number) ?? 0);
      const vis = (id: string) => ((u[`${id}_visible`]?.value as number) ?? 1) > 0.5;
      const beat = Math.pow(Math.sin(((u.iBeat.value as number) % 1) * Math.PI * 2) * 0.5 + 0.5, 6)
                 * (u.iCamReact.value as number);

      linColour(u.neon_color.value, cA);
      linColour(u.glow_color.value, cB);
      linColour(u.edges_color.value, cE);
      linColour(u.haze_color.value, cH);
      rebuildEnv(cA, cB);

      // Neon: each light breathes on its own phase and kicks with the beat.
      const na = rv('neon'), nb = rv('glow');
      for (const n of neonLights) {
        const k = n.a ? na : nb;
        const pulse = 0.75 + 0.25 * Math.sin(t * 1.7 + n.phase) + beat * 0.6;
        n.light.color.copy(n.a ? cA : cB);
        n.light.intensity = 55 * k * pulse;
      }
      win.uNeonA.value.copy(cA).multiplyScalar(2.2);
      win.uNeonB.value.copy(cB).multiplyScalar(2.2);
      const w = rv('windows');
      win.uWinIntensity.value = 2.6 * w;
      win.uWinDensity.value = Math.min(0.8, 0.12 + w * 0.24);
      win.uWinTime.value = t;
      // The model's own lit-window texture. Minified from a distance it
      // averages to a wash, so it runs well below the drawn windows.
      for (const m of windowTexMats) m.emissiveIntensity = 1.7 * w;

      const showEdges = vis('edges');
      const e = rv('edges') * (1 + beat * 0.8);
      for (const m of edgeMats) {
        m.visible = showEdges;
        m.color.copy(cE).multiplyScalar(0.5 + e * 1.8);
      }

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = vis('haze') ? 0.004 + rv('haze') * 0.012 : 0.0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.7);

      bloom.strength = 0.12 + rv('bloom') * 0.5 + beat * 0.25;

      // Camera on the shared rig, along the chosen route.
      const route = Math.floor(Math.min(1.999, Math.max(0, rv('route'))) * ROUTES.length / 2);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      camera.fov = Math.min(110, Math.max(20, u.iCamFov.value as number));
      if (route === 0) {
        const r = 46 * dist;
        camera.position.set(Math.sin(orbit) * r, Math.max(2, height * 1.05 + hgt * 40), -Math.cos(orbit) * r);
        target.set(0, height * 0.28, 0);
      } else if (route === 1) {
        // A slow figure of eight over the rooftops, looking ahead and down.
        const a = t * 0.045 + orbit * 0.2;
        const px = Math.sin(a) * 32 * dist, pz = Math.sin(a * 2) * 18 * dist;
        const ahead = 0.25;
        const tx = Math.sin(a + ahead) * 32 * dist, tz = Math.sin((a + ahead) * 2) * 18 * dist;
        const y = height * 1.15 + hgt * 30;
        camera.position.set(px, Math.max(2, y), pz);
        target.set(tx, Math.max(0, y - 14), tz);
      } else {
        // Low outside the city, looking up at the skyline.
        const r = 70 * dist;
        camera.position.set(Math.sin(orbit) * r, Math.max(0.6, 1.6 + hgt * 12), -Math.cos(orbit) * r);
        target.set(0, height * 0.45, 0);
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
  runtime.scene = scene;
  return runtime;
}

/* The buffer pass is never drawn for a scene shader; this placeholder only
 * keeps the code panel and the compile check meaningful. */
const bufferShader = `
// Neon City is a scene shader: Buffer A is the GLB scene, rendered in
// three.js (shaders/scene-neon-city.ts). Edit the image pass to regrade it.
precision highp float;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/* The image pass: the scene arrives as linear HDR with bloom already added.
 * Here it is tone-mapped, encoded, and given a little lens: fringing towards
 * the edges, a vignette and grain. */
const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform float bloom_react;

vec3 aces(vec3 x){
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float grainHash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + iTime) * 43758.5453); }

void main(){
  vec2 d = vUv - 0.5;
  // Kept small: stronger, it splits every lit window into red, green and blue.
  float ca = 0.0015 * dot(d, d);
  vec3 c = vec3(texture2D(iChannel0, vUv + d * ca * 4.0).r,
                texture2D(iChannel0, vUv).g,
                texture2D(iChannel0, vUv - d * ca * 4.0).b);
  c = aces(c * 1.1);
  c = pow(c, vec3(1.0 / 2.2));
  c *= 1.0 - 0.55 * smoothstep(0.35, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (grainHash(vUv * iResolution.xy) - 0.5) * 0.025;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const neonCity: ShaderDef = {
  id: 'neon_city',
  name: 'Neon City',
  description:
    'A scene shader: a GLB cyberpunk city at night — lit windows, glowing outlines, neon pooling in the streets, haze and bloom.',
  bufferShader,
  imageShader,
  scene: { url: 'scenes/cyberpunk_city.glb', setup: setupNeonCity },
  palettes: [
    { name: 'Neon', colors: { neon: '#ff2bd6', glow: '#22e6ff', edges: '#36f0ff', haze: '#140a2e' } },
    { name: 'Blade', colors: { neon: '#ff8a1f', glow: '#1fd2c2', edges: '#ffb35c', haze: '#1a1208' } },
    { name: 'Toxic', colors: { neon: '#8dff2a', glow: '#b04dff', edges: '#8dff2a', haze: '#0b1a0c' } },
    { name: 'Ice', colors: { neon: '#bfe4ff', glow: '#3d7bff', edges: '#e8f6ff', haze: '#0a1424' } },
    { name: 'Inferno', colors: { neon: '#ff2a1a', glow: '#ff9a1f', edges: '#ff4a2a', haze: '#1f0605' } },
  ],
  elements: [
    {
      id: 'route',
      name: 'Route',
      description:
        'Where the camera goes: an orbit round the city, a figure of eight over the rooftops, or low outside it looking up at the skyline.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1 / ROUTES.length,
      canHide: false,
      defaultVisible: true,
      options: ROUTES,
    },
    {
      id: 'neon',
      name: 'Neon',
      description: 'The first neon colour and how hard its lights burn in the streets.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#ff2bd6',
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'The second neon colour, on the lights between the first.',
      defaultBand: 'mid',
      defaultAmount: 0.7,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#22e6ff',
    },
    {
      id: 'windows',
      name: 'Windows',
      description: 'How many windows are lit and how brightly. Up, the city comes alive.',
      defaultBand: 'high',
      defaultAmount: 0.4,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'edges',
      name: 'Outlines',
      description: 'The buildings traced in light. Put it on the hats and the city flashes its wireframe.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#36f0ff',
    },
    {
      id: 'haze',
      name: 'Haze',
      description: 'Fog colour and density. Hide for clear air all the way out.',
      defaultBand: 'none',
      defaultAmount: 0.3,
      defaultLevel: 1.0,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#140a2e',
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'How far the light spills into the air around it.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
