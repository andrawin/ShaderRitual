/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Model: "office is old abandoned FREE" by dasy444
 * https://sketchfab.com/3d-models/office-is-old-abandoned-free-3977a108b2304b85a698f3dda1777015
 * licensed CC-BY-4.0 (tools/source/office-license.txt). Prepared for this scene by
 * tools/prep-office.py.
 */
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { SceneRuntime, ShaderDef } from '../types';

/*
 * "Overtime" — a scene shader: an abandoned office at night, still working.
 *
 * The room is a photoscanned wreck: two long desks of dead CRTs, rubble, a
 * ceiling of stained tiles, blinds on both end walls. tools/prep-office.py cut
 * each monitor's glass out as its own surface with its own 0..1 UV and an
 * index, so here every screen can be its own thing:
 *
 *   - the intact screens power on and off at random, and show static, lines
 *     of scrolling text, or a roll bar and cursor — or, while Screen & Camera
 *     is running, the live camera feed, in phosphor;
 *   - the smashed screens sputter glitch noise through their cracks;
 *   - fluorescent tubes hang under the ceiling, buzzing and dropping out, one
 *     of them dying, all of them kicking on the beat;
 *   - moonlight comes through the blinds, the slats glowing;
 *   - dust hangs in the air;
 *   - the camera walks the aisle, watches from a security camera in a corner
 *     (the image pass turns that into CCTV), or stands in the middle turning
 *     to look at the desks.
 *
 * Elements:
 *   route   -> Walk, CCTV or Survey
 *   screens -> phosphor colour; how many screens are on, and how bright
 *   feed    -> how many of the intact screens show the camera, when it runs
 *   tubes   -> the fluorescent light: colour, and how hard it burns
 *   moon    -> the light through the blinds
 *   dust    -> the motes in the air
 *   haze    -> fog colour and density
 *   bloom   -> how far the light spills
 */

const ROUTES = ['Walk', 'CCTV', 'Survey'];

function linColour(v: THREE.Vector3, out: THREE.Color): THREE.Color {
  return out.setRGB(v.x, v.y, v.z, THREE.SRGBColorSpace);
}
const hash = (n: number) => {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
};

const screenVertex = /* glsl */ `
attribute vec2 screenId;
varying vec2 vUv;
varying float vId;
varying float vKind;
#include <common>
#include <fog_pars_vertex>
void main(){
  vUv = uv;
  vId = screenId.x;
  // glTF flips V on the way out of Blender, so the kind written as 0/1 in
  // TEXCOORD_1.y arrives as 1/0.
  vKind = 1.0 - screenId.y;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const screenFragment = /* glsl */ `
uniform float uTime;
uniform float uOn;
uniform float uBright;
uniform float uFeed;
uniform float uFlash;
uniform vec3 uGlow;
uniform sampler2D uCap;
uniform float uCapOn;
uniform float uCapAspect;
uniform float uCapMirror;
varying vec2 vUv;
varying float vId;
varying float vKind;
#include <common>
#include <fog_pars_fragment>

float h1(float n){ return fract(sin(n * 127.1) * 43758.5453); }
float h2(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main(){
  vec2 c = vUv - 0.5;
  vec2 uv = 0.5 + c * (1.0 + 0.09 * dot(c, c));   // the tube's bulge
  float t = uTime;
  float id = vId;

  // Power: each screen is on or off, re-rolled every few seconds on its own
  // clock; uOn sets the share that are on.
  float epoch = floor(t * 0.22 + h1(id) * 4.0);
  float on = step(1.0 - uOn, h1(id * 7.3 + epoch));
  // A screen in its first half-second on flickers as it warms up.
  float warm = fract(t * 0.22 + h1(id) * 4.0) * 4.5;
  on *= mix(step(0.4, h2(vec2(id, floor(t * 20.0)))), 1.0, smoothstep(0.1, 0.5, warm));

  vec3 col;
  if(vKind > 0.5){
    // Smashed: glitch static through the cracks, sputtering.
    float row = floor(uv.y * 40.0);
    float g = h2(vec2(row, floor(t * 24.0)));
    vec2 q = uv + vec2((g - 0.5) * 0.2 * step(0.8, g), 0.0);
    float n = h2(floor(q * vec2(160.0, 120.0)) + floor(t * 30.0));
    float band = 0.35 + 0.65 * step(0.5, h2(vec2(row, floor(t * 6.0))));
    col = mix(uGlow, vec3(1.0), 0.35) * n * n * 1.5 * band;
    on *= step(0.35, h2(vec2(id, floor(t * 11.0))));
  } else if(uCapOn > 0.5 && h1(id * 3.1 + 1.7) < uFeed){
    // The live camera, cropped to fill a 4:3 tube, in phosphor.
    vec2 cu = uv - 0.5;
    float r = (4.0 / 3.0) / max(uCapAspect, 0.001);
    cu = cu * (r > 1.0 ? vec2(1.0, 1.0 / r) : vec2(r, 1.0)) + 0.5;
    if(uCapMirror > 0.5) cu.x = 1.0 - cu.x;
    float tear = step(0.975, h2(vec2(floor(uv.y * 30.0), floor(t * 10.0))));
    cu.x += tear * 0.05;
    vec3 cam = texture2D(uCap, cu).rgb;
    float l = dot(cam, vec3(0.299, 0.587, 0.114));
    col = mix(uGlow * l * 0.9, cam * 0.6, 0.3);
    on = 1.0;   // a screen showing the feed stays on
  } else {
    // Idle: static, scrolling text, or a roll bar with a cursor.
    float mode = floor(h1(id * 5.7 + floor(t * 0.08 + h1(id))) * 3.0);
    if(mode < 0.5){
      float n = h2(floor(uv * vec2(200.0, 150.0)) + floor(t * 30.0));
      col = uGlow * mix(0.15, 0.9, n);
    } else if(mode < 1.5){
      float y = uv.y * 16.0 + t * 1.8;
      float line = floor(y);
      float len = h2(vec2(line, id));
      float chars = step(0.3, h2(vec2(floor(uv.x * 42.0), line)));
      float inRow = step(0.25, fract(y)) * step(fract(y), 0.8);
      float txt = chars * inRow * step(uv.x, 0.08 + len * 0.85) * step(0.06, uv.x);
      col = uGlow * (0.05 + txt * 1.1);
    } else {
      float bar = smoothstep(0.0, 0.2, fract(uv.y - t * 0.12)) * 0.5;
      float cursor = step(0.5, fract(t * 1.5)) * step(abs(uv.x - 0.13), 0.03) * step(abs(uv.y - 0.8), 0.035);
      col = uGlow * (0.1 + bar * 0.25 + cursor * 1.5);
    }
  }

  col *= 0.72 + 0.28 * sin(uv.y * 380.0 - t * 30.0);   // scanlines
  float edge = smoothstep(0.0, 0.05, uv.x) * smoothstep(1.0, 0.95, uv.x)
             * smoothstep(0.0, 0.05, uv.y) * smoothstep(1.0, 0.95, uv.y);
  vec3 glass = vec3(0.010, 0.012, 0.014);
  gl_FragColor = vec4(glass + col * uBright * (1.0 + uFlash) * on * edge, 1.0);
  #include <fog_fragment>
}`;

const dustVertex = /* glsl */ `
attribute float aSeed;
uniform float uTime;
uniform float uSize;
varying float vA;
void main(){
  vec3 p = position;
  p.x += sin(uTime * 0.13 + aSeed * 30.0) * 0.25;
  p.y += sin(uTime * 0.07 + aSeed * 17.0) * 0.3;
  p.z += cos(uTime * 0.11 + aSeed * 23.0) * 0.25;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_PointSize = uSize / max(-mv.z, 0.25);
  gl_Position = projectionMatrix * mv;
  // Twinkle as a mote turns in the light.
  vA = (0.35 + 0.65 * fract(aSeed * 91.7)) * (0.6 + 0.4 * sin(uTime * (0.8 + aSeed) + aSeed * 40.0));
}`;
const dustFragment = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main(){
  float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
  gl_FragColor = vec4(uColor * a * vA, 1.0);
}`;

function setupOffice(root: THREE.Object3D, renderer: THREE.WebGLRenderer): SceneRuntime {
  RectAreaLightUniformsLib.init();
  const scene = new THREE.Scene();
  scene.add(root);
  root.updateMatrixWorld(true);

  // The room, in the file's own metres: walls, floor and the ceiling tiles,
  // which hang ~0.3 m under the top of the walls.
  const box = new THREE.Box3().setFromObject(root);
  const floorY = Math.max(0, box.min.y);
  const ceilY = box.max.y - 0.3;
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  const halfX = (box.max.x - box.min.x) / 2;
  const halfZ = (box.max.z - box.min.z) / 2;

  // --- Screens. ----------------------------------------------------------------
  const screenU = {
    uTime: { value: 0 },
    uOn: { value: 0.6 },
    uBright: { value: 2.5 },
    uFeed: { value: 0.6 },
    uFlash: { value: 0 },
    uGlow: { value: new THREE.Color(0.3, 1, 0.55) },
    uCap: { value: null as THREE.Texture | null },
    uCapOn: { value: 0 },
    uCapAspect: { value: 16 / 9 },
    uCapMirror: { value: 0 },
  };
  const screenMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]),
    vertexShader: screenVertex,
    fragmentShader: screenFragment,
    fog: true,
    toneMapped: false,
  });
  Object.assign(screenMat.uniforms, screenU);
  // Kept in a placeholder until the feed arrives: an unbound sampler is undefined.
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  blank.needsUpdate = true;
  screenU.uCap.value = blank;

  const screenPos: THREE.Vector3[] = [];
  let blinds: THREE.MeshStandardMaterial | null = null;
  root.traverse((o: any) => {
    if (!o.isMesh) return;
    const m = o.material as THREE.MeshStandardMaterial;
    const name = m?.name || '';
    if (name === 'CRT_Screen' || name === 'CRT_Broken') {
      const id = o.geometry.getAttribute('uv1');
      if (!id) return;
      // Its own name, so it cannot collide with three's own uv1 handling.
      o.geometry.setAttribute('screenId', id);
      m.dispose();
      o.material = screenMat;
      if (name === 'CRT_Screen') {
        o.geometry.computeBoundingBox();
        screenPos.push(o.geometry.boundingBox!.getCenter(new THREE.Vector3()).applyMatrix4(o.matrixWorld));
      }
      return;
    }
    // No environment to reflect, and the scans' normal maps under the tubes'
    // area lights glitter in the rubble like snow — so everything is matte.
    m.envMapIntensity = 0;
    m.roughness = Math.max(m.roughness ?? 1, 0.8);
    m.metalness = Math.min(m.metalness ?? 0, 0.2);
    if (name === 'Material.022') {
      // The blinds: their slats glow with the moonlight behind them.
      m.emissiveMap = m.map;
      m.emissive = new THREE.Color(0, 0, 0);
      blinds = m;
    }
  });

  // --- Light. --------------------------------------------------------------------
  scene.add(new THREE.HemisphereLight(0x2a3346, 0x0a0908, 0.9));

  // Fluorescent tubes: two rows of three under the ceiling, each a glowing
  // tube and an area light pointing down. Tube 4 is dying.
  const tubeGeo = new THREE.BoxGeometry(1.25, 0.035, 0.09);
  const housingGeo = new THREE.BoxGeometry(1.35, 0.05, 0.2);
  const housingMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 });
  const tubes: { light: THREE.RectAreaLight; mat: THREE.MeshBasicMaterial; seed: number; dying: boolean }[] = [];
  const rowsX = [cx - halfX * 0.38, cx + halfX * 0.32];
  const colsZ = [cz - halfZ * 0.55, cz, cz + halfZ * 0.55];
  let ti = 0;
  for (const x of rowsX) {
    for (const z of colsZ) {
      const g = new THREE.Group();
      g.position.set(x, ceilY - 0.06, z);
      g.rotation.y = Math.PI / 2; // tubes run along the room
      const housing = new THREE.Mesh(housingGeo, housingMat);
      housing.position.y = 0.03;
      g.add(housing);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const tube = new THREE.Mesh(tubeGeo, mat);
      g.add(tube);
      const light = new THREE.RectAreaLight(0xffffff, 0, 1.25, 0.12);
      light.position.y = -0.03;
      light.rotation.x = -Math.PI / 2; // facing down
      g.add(light);
      scene.add(g);
      tubes.push({ light, mat, seed: ti * 3.17 + 0.5, dying: ti === 4 });
      ti++;
    }
  }

  // Moonlight through the blinds on the two end walls.
  const moonLights: THREE.RectAreaLight[] = [];
  for (const s of [-1, 1]) {
    const l = new THREE.RectAreaLight(0x6f8cff, 0, 3.0, 1.9);
    l.position.set(cx - 0.45, floorY + 2.05, cz + s * (halfZ - 0.12));
    l.lookAt(cx - 0.45, floorY + 1.2, cz);
    scene.add(l);
    moonLights.push(l);
  }

  // Screen glow: one light per cluster of screens, not one per screen.
  const clusters: THREE.Vector3[] = [];
  for (const p of screenPos) {
    const near = clusters.find((c) => c.distanceTo(p) < 1.6);
    if (!near) clusters.push(p.clone());
  }
  const glowLights = clusters.map((p) => {
    const l = new THREE.PointLight(0xffffff, 0, 3.2, 2);
    // A little in front of the screens, towards the room.
    l.position.copy(p).add(new THREE.Vector3(cx - p.x, 0, cz - p.z).normalize().multiplyScalar(0.45));
    scene.add(l);
    return l;
  });

  // --- Dust. ---------------------------------------------------------------------
  const N = 1400;
  const pos = new Float32Array(N * 3);
  const seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = cx + (hash(i * 1.1) - 0.5) * halfX * 1.9;
    pos[i * 3 + 1] = floorY + 0.2 + hash(i * 2.3) * (ceilY - floorY - 0.3);
    pos[i * 3 + 2] = cz + (hash(i * 3.7) - 0.5) * halfZ * 1.9;
    seed[i] = hash(i * 5.9);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const dustU = { uTime: { value: 0 }, uSize: { value: 30 }, uColor: { value: new THREE.Color() } };
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    uniforms: dustU, vertexShader: dustVertex, fragmentShader: dustFragment,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  dust.frustumCulled = false;
  scene.add(dust);

  scene.fog = new THREE.FogExp2(0x0b0f14, 0.08);
  scene.background = new THREE.Color(0x020304);

  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 60);
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.5, 1.0);

  const cS = new THREE.Color();
  const cT = new THREE.Color();
  const cM = new THREE.Color();
  const cH = new THREE.Color();
  const target = new THREE.Vector3();
  const look = new THREE.Vector3();

  const runtime: SceneRuntime = {
    update(u) {
      const t = u.iTime.value as number;
      const rv = (id: string) => Math.max(0, (u[`${id}_react`]?.value as number) ?? 0);
      const vis = (id: string) => ((u[`${id}_visible`]?.value as number) ?? 1) > 0.5;
      const beat = Math.pow(Math.sin(((u.iBeat.value as number) % 1) * Math.PI * 2) * 0.5 + 0.5, 6)
                 * (u.iCamReact.value as number);

      linColour(u.screens_color.value, cS);
      linColour(u.tubes_color.value, cT);
      linColour(u.moon_color.value, cM);
      linColour(u.haze_color.value, cH);

      // Screens.
      const sv = rv('screens');
      screenU.uTime.value = t;
      screenU.uOn.value = Math.min(1, 0.15 + sv * 0.6);
      screenU.uBright.value = 0.8 + sv * 1.5;
      screenU.uFlash.value = beat * 0.8;
      (screenU.uGlow.value as THREE.Color).copy(cS);
      const capOn = ((u.iCaptureOn?.value as number) ?? 0) > 0.5;
      screenU.uCapOn.value = capOn && vis('feed') ? 1 : 0;
      screenU.uFeed.value = Math.min(1, rv('feed'));
      screenU.uCap.value = capOn ? (u.iCapture.value as THREE.Texture) : blank;
      screenU.uCapAspect.value = (u.iCaptureAspect?.value as number) || 16 / 9;
      screenU.uCapMirror.value = (u.iCaptureMirror?.value as number) || 0;
      const glowI = (0.4 + screenU.uOn.value) * screenU.uBright.value * 0.6 * (1 + beat * 0.5);
      for (const l of glowLights) {
        l.color.copy(cS);
        l.intensity = glowI * (0.85 + 0.15 * Math.sin(t * 7 + l.position.z));
      }

      // Tubes: a steady burn with the odd dropout, the dying one stuttering,
      // and every tube kicking on the beat.
      const showTubes = vis('tubes');
      const tv = rv('tubes');
      let tubeSum = 0;
      for (const tb of tubes) {
        const k = Math.floor(t * 18 + tb.seed * 10);
        let f = hash(k + tb.seed) > 0.97 ? 0.15 : 1;
        if (tb.dying) {
          const slow = hash(Math.floor(t * 1.3) + tb.seed);
          f = slow > 0.55 ? (hash(k * 1.7) > 0.45 ? 1 : 0.05) : 0.03;
        }
        const level = showTubes ? f * tv * (1 + beat * 1.5) : 0;
        tubeSum += level;
        tb.light.color.copy(cT);
        tb.light.intensity = level * 22;
        tb.mat.color.copy(cT).multiplyScalar(0.15 + level * 4);
      }
      const tubeAvg = tubeSum / tubes.length;

      // Moon.
      const mv = rv('moon');
      for (const l of moonLights) {
        l.color.copy(cM);
        l.intensity = mv * 2.2;
      }
      if (blinds) {
        (blinds as THREE.MeshStandardMaterial).emissive.copy(cM).multiplyScalar(mv * 0.07);
      }

      // Dust: lit by whatever is burning.
      dust.visible = vis('dust');
      dustU.uTime.value = t;
      dustU.uSize.value = 9 * renderer.getPixelRatio();
      (dustU.uColor.value as THREE.Color)
        .copy(cT).multiplyScalar(tubeAvg * 0.6)
        .add(cM.clone().multiplyScalar(mv * 0.25))
        .multiplyScalar(rv('dust') * 1.4);

      const fog = scene.fog as THREE.FogExp2;
      fog.color.copy(cH);
      fog.density = vis('haze') ? 0.02 + rv('haze') * 0.12 : 0;
      (scene.background as THREE.Color).copy(cH).multiplyScalar(0.5);

      bloom.strength = 0.2 + rv('bloom') * 0.6 + beat * 0.3;

      // Camera, inside the walls whatever the rig asks for.
      const route = Math.floor(Math.min(1.999, Math.max(0, rv('route'))) * ROUTES.length / 2);
      const orbit = u.iCamOrbit.value as number;
      const dist = Math.min(3, Math.max(0.35, u.iCamDist.value as number));
      const hgt = u.iCamHeight.value as number;
      camera.fov = Math.min(110, Math.max(30, u.iCamFov.value as number));
      if (route === 0) {
        // Walk the aisle and back. At each end the walker slows and turns to
        // the desks, so the turn-round is a look at the screens.
        const ph = t * 0.06 + orbit * 0.3;
        const along = Math.sin(ph);
        const speed = Math.cos(ph);
        const x = cx - 0.35 + Math.sin(t * 0.11) * 0.25;
        const z = cz + along * halfZ * 0.72;
        const bob = Math.sin(t * 5.2) * 0.025 * Math.abs(speed);
        camera.position.set(x, floorY + 1.6 + bob + hgt * 0.5, z);
        const side = Math.sin(t * 0.045) > 0 ? 1 : -1;
        look.set(Math.sin(t * 0.09) * 0.5 + (1 - Math.abs(speed)) * side * 1.6, -0.12, Math.sign(speed) * Math.abs(speed) + 1e-3);
        target.copy(camera.position).add(look.normalize());
      } else if (route === 1) {
        // A security camera high in a corner, panning and holding.
        const corner = ((Math.floor(orbit / (Math.PI / 2)) % 4) + 4) % 4;
        const sx = corner === 0 || corner === 3 ? 1 : -1;
        const sz = corner < 2 ? 1 : -1;
        camera.position.set(cx + sx * (halfX - 0.3), ceilY - 0.12, cz + sz * (halfZ - 0.3));
        const pan = Math.sin(Math.sin(t * 0.18) * Math.PI / 2) * 0.55;
        const base = Math.atan2(cx - camera.position.x, cz - camera.position.z);
        const a = base + pan;
        target.set(camera.position.x + Math.sin(a) * 4, floorY + 0.6 - hgt, camera.position.z + Math.cos(a) * 4);
      } else {
        // Standing in the middle, turning to look along the desks.
        const a = orbit + t * 0.05;
        const r = 0.6 * dist;
        camera.position.set(cx - 0.3 + Math.sin(a) * r, floorY + 1.45 + hgt * 0.6, cz + Math.cos(a) * r);
        target.set(cx - 0.3 + Math.sin(a) * 6, floorY + 1.05, cz + Math.cos(a) * 6);
      }
      camera.position.x = Math.min(box.max.x - 0.25, Math.max(box.min.x + 0.25, camera.position.x));
      camera.position.z = Math.min(box.max.z - 0.25, Math.max(box.min.z + 0.25, camera.position.z));
      camera.position.y = Math.min(ceilY - 0.08, Math.max(floorY + 0.3, camera.position.y));
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
  (runtime as any).scene = scene;
  return runtime;
}

const bufferShader = `
// Overtime is a scene shader: Buffer A is the GLB scene, rendered in three.js
// (shaders/scene-office.ts). Edit the image pass to regrade it.
precision highp float;
varying vec2 vUv;
void main(){ gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); }
`;

/* The image pass: tone map and a little lens; on the CCTV route, a security
 * camera's picture — fisheye, washed-out green-grey, interlace, a blinking REC. */
const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform float route_react;

vec3 aces(vec3 x){
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233)) + iTime) * 43758.5453); }

void main(){
  float route = floor(clamp(route_react, 0.0, 1.999) * 1.5);
  bool cctv = route > 0.5 && route < 1.5;
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  if(cctv){
    uv = 0.5 + d * (0.92 + 0.22 * dot(d, d));     // fisheye
    uv.x += (hash(vec2(floor(uv.y * iResolution.y * 0.5), 0.0)) - 0.5) * 0.0015;
  }
  float ca = cctv ? 0.004 : 0.0018;
  vec3 c = vec3(texture2D(iChannel0, uv + d * ca).r,
                texture2D(iChannel0, uv).g,
                texture2D(iChannel0, uv - d * ca).b);
  c = aces(c * 1.15);
  c = pow(c, vec3(1.0 / 2.2));
  if(cctv){
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l) * vec3(0.82, 1.0, 0.86), c, 0.15);
    c = (c - 0.5) * 0.85 + 0.53;                    // lifted, flat
    c *= 0.88 + 0.12 * step(0.5, fract(gl_FragCoord.y * 0.5));   // interlace
    // REC: a red dot top left, blinking once a second.
    vec2 p = vUv * iResolution.xy / iResolution.y;
    float dot1 = smoothstep(0.016, 0.012, length(p - vec2(0.07, 0.92)));
    c = mix(c, vec3(1.0, 0.1, 0.08), dot1 * step(0.5, fract(iTime)));
    // Frame corners: thin brackets in each corner.
    vec2 q = abs(vUv - 0.5);
    float inside = step(q.x, 0.45) * step(q.y, 0.44);
    float nearCorner = step(0.39, q.x) * step(0.37, q.y);
    float edgeLine = min(1.0, step(0.446, q.x) + step(0.436, q.y));
    c = mix(c, vec3(0.9), inside * nearCorner * edgeLine * 0.7);
  }
  c *= 1.0 - 0.6 * smoothstep(0.3, 0.95, length(d * vec2(1.0, 0.8)) * 1.3);
  c += (hash(vUv * iResolution.xy) - 0.5) * (cctv ? 0.08 : 0.035);
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

export const office: ShaderDef = {
  id: 'overtime',
  name: 'Overtime',
  description:
    'A scene shader: an abandoned office at night, its dead CRTs flickering back on — with your camera on the screens when Screen & Camera is running. ' +
    'Model: "office is old abandoned FREE" by dasy444 (sketchfab.com/dasy444), CC-BY-4.0.',
  bufferShader,
  imageShader,
  scene: { url: 'scenes/office.glb', setup: setupOffice },
  palettes: [
    { name: 'Graveyard shift', colors: { screens: '#5dff9a', tubes: '#d8e6ff', moon: '#4a68ff', haze: '#0b0f14' } },
    { name: 'Amber terminal', colors: { screens: '#ffb238', tubes: '#ffd9a0', moon: '#3a4cff', haze: '#140d07' } },
    { name: 'Red alert', colors: { screens: '#ff3326', tubes: '#ff8a7a', moon: '#2a1840', haze: '#160506' } },
    { name: 'Blue screen', colors: { screens: '#3d7bff', tubes: '#f2f6ff', moon: '#7a9cff', haze: '#070b18' } },
    { name: 'Sodium', colors: { screens: '#9cff5a', tubes: '#ff9a30', moon: '#ff7a1a', haze: '#140a02' } },
  ],
  elements: [
    {
      id: 'route',
      name: 'Route',
      description: 'Walk the aisle, watch through a security camera in a corner, or stand in the middle and turn.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1 / ROUTES.length,
      canHide: false,
      defaultVisible: true,
      options: ROUTES,
    },
    {
      id: 'screens',
      name: 'Screens',
      description: 'The phosphor colour, and how many of the dead monitors are on and how bright. On the mids, they flare with the music.',
      defaultBand: 'mid',
      defaultAmount: 0.6,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#5dff9a',
    },
    {
      id: 'feed',
      name: 'Camera feed',
      description: 'How many of the intact screens show the live camera while Screen & Camera is running. Hide to keep the camera off them.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 0.6,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tubes',
      name: 'Tubes',
      description: 'The fluorescent lights: colour, and how hard they burn. One of them is dying. On the kick, they strobe.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#d8e6ff',
    },
    {
      id: 'moon',
      name: 'Moonlight',
      description: 'The light through the blinds at both ends of the room.',
      defaultBand: 'none',
      defaultAmount: 0.2,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#4a68ff',
    },
    {
      id: 'dust',
      name: 'Dust',
      description: 'Motes hanging in the air, lit by the tubes and the moon.',
      defaultBand: 'high',
      defaultAmount: 0.5,
      defaultLevel: 0.6,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'haze',
      name: 'Haze',
      description: 'Fog colour and density. Hide for clear air.',
      defaultBand: 'none',
      defaultAmount: 0.3,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
      defaultColor: '#0b0f14',
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'How far the light spills.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
