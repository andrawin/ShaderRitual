/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Ocean" — a flight over open water under slice-based volumetric clouds, with
 * god-rays, sun glare and height-modulated waves reflecting the sky.
 *
 * Adapted from Frank Hugenroth's "Clouds / Water" (2013), CC BY-NC-SA 3.0,
 * itself built on raymarching and noise from Inigo Quilez.
 *
 * Porting notes (GLSL ES 1.00):
 *   - The original read a noise texture through textureLod on iChannel0. That
 *     texture is rebuilt in Buffer B as 256-cell smooth value noise, repeat
 *     wrapped, and read through iChannel1 — the same arrangement Horizon uses.
 *   - A global initialiser has to be a constant expression here, so the sun
 *     direction is written pre-normalised and re-aimed at run time.
 *   - The original's distance speed-up chain tests t>500 before t>800, so the
 *     coarser branches can never run. That looks like a bug and is not: with
 *     the tests ordered largest-first the march strides past the surface at
 *     distance and the sea comes back white and speckled. Left as written.
 *   - Divisions by ray.y are floored: at the horizon that term goes to zero and
 *     the cloud slice position blows up to infinity.
 *   - The shading normal is differenced over a width that grows with distance.
 *     At a fixed width the far water fizzes with speckle, because out there one
 *     pixel spans many waves and the difference is just noise.
 *
 * This is the heaviest scene in the set — a full march per pixel with noise at
 * every step — so the counts that drive the cost are on Detail, and the two
 * most expensive parts (clouds, god-rays) can be switched off entirely.
 *
 * Elements:
 *   swell  -> the long ocean swell
 *   chop   -> small surface waves
 *   clouds -> cloud cover and density (hideable)
 *   rays   -> god-rays through the cloud deck (hideable)
 *   sun    -> sun glare, haze and reflection off the water
 *   detail -> march / cloud-layer counts, the cost knob
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel1;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float swell_react;
uniform float chop_react;
uniform float clouds_react;
uniform float clouds_visible;
uniform float rays_react;
uniform float rays_visible;
uniform float sun_react;
uniform float detail_react;

const float waterlevel = 70.0;

const vec3 fogcolor     = vec3(0.50, 0.70, 1.10);
const vec3 skybottom    = vec3(0.60, 0.80, 1.20);
const vec3 skytop       = vec3(0.05, 0.20, 0.50);
const vec3 reflskycolor = vec3(0.025, 0.10, 0.20);
const vec3 watercolor   = vec3(0.20, 0.25, 0.30);

// normalize(vec3(0.1, 0.25, 0.9)), pre-divided: a global initialiser must be a
// constant expression, and normalize() is not one.
const vec3 light = vec3(0.10645, 0.26612, 0.95804);

const mat3 m  = mat3(0.00, 1.60, 1.20, -1.60, 0.72, -0.96, -1.20, -0.96, 1.28);
const mat2 m2 = mat2(1.6, -1.2, 1.2, 1.6);

// Set once per frame in main() from the elements above; read by the marchers.
float large_waveheight = 1.0;
float small_waveheight = 1.0;
float gWaterOct = 5.0;
float gCloudLayers = 30.0;
float gCloudCut = 0.5;
float gRayGain = 1.0;

float hash(float n){ return fract(cos(n) * 41415.92653); }

float noise(vec2 p){ return texture2D(iChannel1, p * (1. / 256.)).x; }

float noise(vec3 x){
  vec3 p = floor(x);
  vec3 f = smoothstep(0.0, 1.0, fract(x));
  float n = p.x + p.y * 57.0 + 113.0 * p.z;
  return mix(mix(mix(hash(n +   0.0), hash(n +   1.0), f.x),
                 mix(hash(n +  57.0), hash(n +  58.0), f.x), f.y),
             mix(mix(hash(n + 113.0), hash(n + 114.0), f.x),
                 mix(hash(n + 170.0), hash(n + 171.0), f.x), f.y), f.z);
}

float fbm(vec3 p){
  float f = 0.5000 * noise(p); p = m * p * 1.1;
  f += 0.2500 * noise(p); p = m * p * 1.2;
  f += 0.1666 * noise(p); p = m * p;
  f += 0.0834 * noise(p);
  return f;
}

float fbm(vec2 p){
  float f = 0.5000 * noise(p); p = m2 * p;
  f += 0.2500 * noise(p); p = m2 * p;
  f += 0.1666 * noise(p); p = m2 * p;
  f += 0.0834 * noise(p);
  return f;
}

/* Surface height of the water at a world position. */
float water(vec2 p){
  float height = waterlevel;

  vec2 shift1 = 0.001 * vec2(iTime * 160.0 * 2.0, iTime * 120.0 * 2.0);
  vec2 shift2 = 0.001 * vec2(iTime * 190.0 * 2.0, -iTime * 130.0 * 2.0);

  // Long crossing swell...
  float wave = 0.0;
  wave += sin(p.x * 0.021 + shift2.x) * 4.5;
  wave += sin(p.x * 0.0172 + p.y * 0.010 + shift2.x * 1.121) * 4.0;
  wave -= sin(p.x * 0.00104 + p.y * 0.005 + shift2.x * 0.121) * 4.0;
  // ...with smaller, faster waves over it...
  wave += sin(p.x * 0.02221 + p.y * 0.01233 + shift2.x * 3.437) * 5.0;
  wave += sin(p.x * 0.03112 + p.y * 0.01122 + shift2.x * 4.269) * 2.5;
  wave *= large_waveheight;
  wave -= fbm(p * 0.004 - shift2 * .5) * small_waveheight * 24.;

  // ...and distorted noise ridges, which is what makes it read as water.
  float amp = 6. * small_waveheight;
  shift1 *= .3;
  for (int i = 0; i < 7; i++){
    if (float(i) >= gWaterOct) break;
    wave -= abs(sin((noise(p * 0.01 + shift1) - .5) * 3.14)) * amp;
    amp *= .51;
    shift1 *= 1.841;
    p *= m2 * 0.9331;
  }

  height += wave;
  return height;
}

/* How much light survives the cloud deck along a ray. */
float trace_fog(in vec3 rStart, in vec3 rDirection){
  if (clouds_visible < 0.5) return 1.0;

  vec2 shift = vec2(iTime * 80.0, iTime * 60.0);
  float sum = 0.0;
  float q2 = 0.0, q3 = 0.0;
  // A ray running flat along the deck divides by nothing — floor it, or the
  // slice position comes back as infinity and takes the pixel with it.
  float dy = max(rDirection.y, 0.05);

  // Ten slices only. This is what gives the occasional god-ray through a cloud,
  // and it is far cheaper than resolving the deck properly.
  for (int q = 0; q < 10; q++){
    float c = (q2 + 350.0 - rStart.y) / dy;
    vec3 cpos = rStart + c * rDirection
              + vec3(831.0, 321.0 + q3 - shift.x * 0.2, 1330.0 + shift.y * 3.0);
    float alpha = smoothstep(gCloudCut, 1.0, fbm(cpos * 0.0015));
    sum += (1.0 - sum) * alpha;
    if (sum > 0.98) break;
    q2 += 120.;
    q3 += 0.15;
  }
  return clamp(1.0 - sum, 0.0, 1.0);
}

/*
 * Marches until the ray meets the water, collecting god-ray intensity on the
 * way. Returns whether it hit, with the distance and the accumulated fog.
 */
bool trace(in vec3 rStart, in vec3 rDirection, in float sundot,
           out float fog, out float dist){
  float h = 20.0;
  float t = 0.0;
  float st = 1.0;
  float asum = 0.0;
  bool hit = false;
  vec3 p = rStart;

  for (int j = 0; j < 120; j++){
    // The original's chain tests t>500 first, so the t>800 and t>1000 branches
    // can never run and the step never exceeds 2. That reads like a bug, but it
    // is load-bearing: ordered largest-first the march strides past the surface
    // at distance, the hit lands well above the water, and the sea turns white
    // and speckled. Left as written.
    if (t > 500.0) st = 2.0;

    p = rStart + t * rDirection;

    if (rays_visible > 0.5 && rDirection.y > 0. && sundot > 0.001
        && t > 400.0 && t < 2500.0){
      float alpha = sundot * clamp((p.y - waterlevel) / waterlevel, 0.0, 1.0)
                  * st * 0.024 * gRayGain
                  * smoothstep(0.80, 1.0, trace_fog(p, light));
      asum += (1.0 - asum) * alpha;
      if (asum > 0.9) break;
    }

    h = p.y - water(p.xz);
    if (h < 0.1){ hit = true; break; }
    if (p.y > 450.0) break;

    // Looking up there is nothing to hit, so cover ground quickly.
    if (rDirection.y > 0.0) t += 30.0 * st;
    else t += max(1.0, h) * st;
  }

  dist = t;
  fog = asum;
  return hit || h < 10.0;
}

vec3 camera(float time){
  return vec3(500.0 * sin(1.5 + 1.57 * time), 0.0, 1200.0 * time);
}

void main(){
  vec2 xy = -1.0 + 2.0 * vUv;
  vec2 s = xy * vec2(max(iResolution.x / max(iResolution.y, 1.), 0.1), 1.0);

  // Elements -> the values the marchers read.
  float det = clamp(detail_react, 0.0, 2.0);
  gWaterOct = 3.0 + det * 2.0;        // 3..7 ridge octaves
  gCloudLayers = 14.0 + det * 17.0;   // 14..48 cloud slices
  large_waveheight = 0.35 + clamp(swell_react, 0.0, 2.0) * 0.9;
  small_waveheight = 0.35 + clamp(chop_react, 0.0, 2.0) * 0.8;
  // More cover means cutting the density field lower down.
  gCloudCut = 0.62 - clamp(clouds_react, 0.0, 2.0) * 0.11;
  gRayGain = 0.35 + clamp(rays_react, 0.0, 2.0) * 0.7;
  float sunGain = 0.35 + clamp(sun_react, 0.0, 2.0) * 0.55;

  // Camera: the original's flight path, with the rig layered over it.
  float time = (iTime + 13.5 + 44.0) * .05;
  vec3 campos = camera(time);
  vec3 camtar = camera(time + 0.4);
  float alt = waterlevel + 90.0 + 60.0 * sin(time * 2.0);
  campos.y = max(waterlevel + 30.0, alt * max(iCamDist, 0.3) + iCamHeight * 120.0);
  camtar.y = campos.y * 0.5;

  // Orbit swings the heading rather than the flight path, so the rig can turn
  // the view without taking the camera off the water.
  vec3 cw = normalize(camtar - campos);
  float yaw = iCamOrbit * 0.5;
  float cy = cos(yaw), sy = sin(yaw);
  cw = normalize(vec3(cw.x * cy - cw.z * sy, cw.y, cw.x * sy + cw.z * cy));

  float pulse = pow(sin(fract(iBeat) * 6.28318) * 0.5 + 0.5, 3.);
  float roll = 0.14 * sin(time * 1.2) + pulse * iCamReact * 0.02;
  vec3 cp = vec3(sin(roll), cos(roll), 0.0);
  vec3 cu = normalize(cross(cw, cp));
  vec3 cv = normalize(cross(cu, cw));
  // Focal length, so a wider field of view really is wider.
  vec3 rd = normalize(s.x * cu + s.y * cv + 1.6 * (60.0 / max(iCamFov, 10.0)) * cw);

  float sundot = clamp(dot(rd, light), 0.0, 1.0);

  vec3 col;
  float fog = 0.0, dist = 0.0;

  if (!trace(campos, rd, sundot, fog, dist)){
    // Sky.
    float t = pow(1.0 - 0.7 * rd.y, 15.0);
    col = 0.8 * (skybottom * t + skytop * (1.0 - t));
    col += 0.47 * vec3(1.6, 1.4, 1.0) * pow(sundot, 350.0) * sunGain;
    col += 0.40 * vec3(0.8, 0.9, 1.0) * pow(sundot, 2.0) * sunGain;

    if (clouds_visible > 0.5){
      vec2 shift = vec2(iTime * 80.0, iTime * 60.0);
      vec4 sum = vec4(0.0);
      float dy = max(rd.y, 0.015);
      for (int q = 0; q < 48; q++){
        if (float(q) >= gCloudLayers) break;
        float c = (float(q) * 12.0 + 350.0 - campos.y) / dy;
        vec3 cpos = campos + c * rd
                  + vec3(831.0, 321.0 + float(q) * .15 - shift.x * 0.2, 1330.0 + shift.y * 3.0);
        float alpha = smoothstep(gCloudCut, 1.0, fbm(cpos * 0.0015)) * .9;
        vec3 localcolor = mix(vec3(1.1, 1.05, 1.0), 0.7 * vec3(0.4, 0.4, 0.3), alpha);
        alpha = (1.0 - sum.w) * alpha;
        sum += vec4(localcolor * alpha, alpha);
        if (sum.w > 0.98) break;
      }
      float alpha = smoothstep(0.7, 1.0, sum.w);
      sum.rgb /= sum.w + 0.0001;

      // Darkens dense cloud in front of the sun — cloud self-shadow.
      sum.rgb -= 0.6 * vec3(0.8, 0.75, 0.7) * pow(sundot, 13.0) * alpha;
      // ...and lifts the thin edges, where light scatters through.
      sum.rgb += 0.2 * vec3(1.3, 1.2, 1.0) * pow(sundot, 5.0) * (1.0 - alpha);

      col = mix(col, sum.rgb, sum.w * (1.0 - t));
    }

    col += vec3(0.5, 0.4, 0.3) * fog;
  } else {
    // Water.
    vec3 wpos = campos + dist * rd;

    // Normal sampling width grows with distance. At range a pixel covers many
    // waves, and differencing the height over a fixed 0.4 units there returns
    // an essentially random normal — which is what makes the far water fizz
    // with salt-and-pepper speckle instead of settling into a sheen.
    float nw = 0.4 + dist * 0.01;
    vec2 xdiff = vec2(nw, 0.0);
    vec2 ydiff = vec2(0.0, nw);
    rd = reflect(rd, normalize(vec3(water(wpos.xz - xdiff) - water(wpos.xz + xdiff),
                                    1.0,
                                    water(wpos.xz - ydiff) - water(wpos.xz + ydiff))));
    float refl = 1.0 - clamp(dot(rd, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

    float sh = smoothstep(0.2, 1.0, trace_fog(wpos + 20.0 * rd, rd)) * .7 + .3;
    float wsky = refl * sh;              // how much sky it mirrors
    float wwater = (1.0 - refl) * sh;    // and how much is water

    float rsun = clamp(dot(rd, light), 0.0, 1.0);

    col = wsky * reflskycolor;
    col += wwater * watercolor;
    // Height tint. Clamped because a march that ends short of the surface —
    // at the far distances it can — otherwise drives this term straight to
    // white rather than tinting a wave crest.
    col += vec3(.003, .005, .005) * clamp(wpos.y - waterlevel + 30., 0., 60.);

    float wsunrefl = wsky * (0.5 * pow(rsun, 10.0) + 0.25 * pow(rsun, 3.5)
                           + .75 * pow(rsun, 300.0));
    col += vec3(1.5, 1.3, 1.0) * wsunrefl * sunGain;

    float fo = 1.0 - exp(-pow(0.0003 * dist, 1.5));
    vec3 fco = fogcolor + 0.6 * vec3(0.6, 0.5, 0.4) * pow(sundot, 4.0) * sunGain;
    col = mix(col, fco, fo);

    col += vec3(0.5, 0.4, 0.3) * fog;
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/* 256-cell smooth value noise, repeat-wrapped — the texture the original read
 * off iChannel0. Rendered once per shader build. */
const bufferBShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

float hash(vec2 p){
  p = fract(p * vec2(.16632, .17369));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y * 95.4337);
}

void main(){
  vec2 p = vUv * 256.;
  vec2 c = floor(p);
  vec2 f = fract(p);
  f = f * f * (3. - 2. * f);
  float n = mix(
    mix(hash(mod(c, 256.)),              hash(mod(c + vec2(1., 0.), 256.)), f.x),
    mix(hash(mod(c + vec2(0., 1.), 256.)), hash(mod(c + vec2(1., 1.), 256.)), f.x),
    f.y);
  gl_FragColor = vec4(vec3(n), 1.);
}
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.); }
`;

export const ocean: ShaderDef = {
  id: 'ocean',
  name: 'Ocean',
  description:
    'A flight over open water under volumetric cloud, with god-rays, sun glare and swell that mirrors the sky.',
  bufferShader,
  bufferBShader,
  imageShader,
  elements: [
    {
      id: 'swell',
      name: 'Swell',
      description:
        'The long ocean swell. The manual level sets the resting sea state; react drives the crests on the beat.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'chop',
      name: 'Chop',
      description: 'Small surface waves and noise ridges — the detail that makes it read as water.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'clouds',
      name: 'Clouds',
      description:
        'Cloud cover and density. Hide for a clear sky — this is one of the two expensive parts of the scene.',
      defaultBand: 'mid',
      defaultAmount: 0.7,
      defaultLevel: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'rays',
      name: 'God Rays',
      description:
        'Shafts of light through gaps in the cloud deck. Hide to get the frame rate back on a big display.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.6,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sun',
      name: 'Sun',
      description: 'Glare, haze and the sun track reflected off the water.',
      defaultBand: 'high',
      defaultAmount: 0.8,
      defaultLevel: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Detail',
      description:
        'Wave octaves and cloud slices. The scene costs what this says it costs — drop it on a projector.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
