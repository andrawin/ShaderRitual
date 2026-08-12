/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Sound Blob" — a chain of twelve spheres, one per frequency slot, smin-melded
 * into a single writhing blob and orbited by a camera, over a layered starfield.
 *
 * Adapted from seb0fh's Shadertoy original (ArthurTent's reactive edit). The
 * original sized each sphere from an FFT texture bin; here a spectral helper
 * blends the engine's low / mid / high bands across the twelve slots, so the
 * blob still ripples from bass end to treble end. Ported to GLSL-ES 1.00
 * (no texelFetch / texture(), constant loop bounds, mouse camera -> camera rig).
 *
 * Elements:
 *   blob  -> size of the frequency spheres (the blob's bulk)
 *   halo  -> the coloured glow behind the blob
 *   stars -> the layered starfield; hideable
 *   orbit -> speed of the orbiting camera
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float blob_react;
uniform float halo_react;
uniform float stars_react;
uniform float stars_visible;
uniform float orbit_react;

#define TWO_PI 6.2831
const float PI = 3.1415926;

/**
 * Stand-in for the original's per-bin FFT read: blends the three bands across
 * the spectrum so slot 0 is bass-driven and slot 11 is treble-driven.
 */
float bandAt(float t){
  float lo = clamp(blob_react, 0., 2.);
  float md = clamp(halo_react, 0., 2.);
  float hi = clamp(stars_react, 0., 2.);
  float a = smoothstep(0.0, 0.5, t);
  float b = smoothstep(0.5, 1.0, t);
  return mix(mix(lo, md, a), hi, b);
}

vec3 hash33(vec3 p){
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p.zxy, p.yxz + 19.27);
  return fract(vec3(p.x * p.y, p.z * p.x, p.y * p.z));
}

vec3 stars(in vec3 p){
  vec3 c = vec3(0.);
  float res = iResolution.x * 0.8;
  for(float i = 0.; i < 4.; i++){
    vec3 q = fract(p * (.15 * res)) - 0.5;
    vec3 id = floor(p * (.15 * res));
    vec2 rn = hash33(id).xy;
    float c2 = 1. - smoothstep(0., .6, length(q));
    c2 *= step(rn.x, .0005 + i * i * 0.001);
    c += c2 * (mix(vec3(1.0, 0.49, 0.1), vec3(0.75, 0.9, 1.), rn.y) * 0.25 + 0.75);
    p *= 1.4;
  }
  return c * c * .65;
}

vec3 rotateY(vec3 p, float a){ float c = cos(a); float s = sin(a); return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x); }

float sdSphere(vec3 p, float r){ return length(p) - r; }
float smin(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }

float map(in vec3 p){
  float t, d, minD = 1e8;
  float a = 2.5 * TWO_PI, b, cc;
  for(int i = 0; i < 12; i++){
    t = float(i) / 12.0;
    float f = bandAt(t);
    b = sin(PI * t + iTime * 1.3);
    cc = t * a;
    d = sdSphere(p + vec3(cos(cc * 0.9 + iTime * 2.) * b, sin(cc + iTime * 1.7) * b, 2.0 * t - 1.0) * 0.1,
                 0.01 + f * pow(1.11, float(i)) * 0.05);
    minD = smin(minD, d, 0.07);
  }
  return minD;
}

vec3 calcNormal(in vec3 pos, in float epsilon){
  vec3 eps = vec3(epsilon, 0.0, 0.0);
  vec3 nor = vec3(
    map(pos + eps.xyy) - map(pos - eps.xyy),
    map(pos + eps.yxy) - map(pos - eps.yxy),
    map(pos + eps.yyx) - map(pos - eps.yyx));
  return normalize(nor);
}

vec2 rayMarch(in vec3 from, in vec3 direction){
  float travel = 0.0;
  for(float i = 0.0; i < 64.0; i += 1.0){
    vec3 position = from + direction * travel;
    float d = map(position);
    if(d < 0.002) return vec2(travel, i / 64.0);
    travel += max(d, 0.001);
  }
  return vec2(0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = (fragCoord.xy / iResolution.xx) - vec2(0.5, 0.5 * iResolution.y / iResolution.x);
  uv *= (iCamFov / 60.);

  // Background ray (camera rig replaces the original's mouse look).
  vec3 rd = normalize(vec3(uv, -1.5));
  rd = rotateY(rd, iCamOrbit * 0.5);
  rd.y += iCamHeight * 0.4;

  float time = iTime * 1.5 * (0.6 + orbit_react * 1.2);
  float dist = 0.8 * max(iCamDist, 0.4);

  vec3 camera_position = vec3(sin(time) * dist, iCamHeight * 0.3, -cos(time) * dist);
  vec3 ray_direction = rotateY(normalize(vec3(uv, 1.0)), -time);

  vec2 result = rayMarch(camera_position, ray_direction);

  // Halo behind the blob (was an FFT amplitude read).
  float amp = 0.15 + clamp(halo_react, 0., 2.) * 0.85;
  vec4 color = vec4(vec3(0.3, 0.9, 1.0) * amp * 0.1 / max(length(uv), 1e-3), 1.0);

  vec3 bg = vec3(0.);
  if(stars_visible > 0.5){
    vec3 srd = rd;
    srd.x += sin(iTime / 1000.) * 2.;
    bg = stars(srd) * (1. + 30. * clamp(stars_react, 0., 1.5) * 0.2);
  }

  if(result.x != 0.0){
    vec3 position = camera_position + (ray_direction * result.x);
    vec3 normal = calcNormal(position, 0.001);
    vec3 light = normalize(vec3(-1.0, 1.0, -0.5));
    vec3 reflection = reflect(ray_direction, normal);
    float diffuse = dot(normal, light);
    float specular = pow(clamp(dot(reflection, light), 0.0, 1.0), 20.0);
    color = vec4(vec3(specular * diffuse) * vec3(1., 1., 1.) +
                 vec3(diffuse * 0.4 + 0.6) * vec3(0.9, 0.5 - result.y * 0.5, (1.0 / max(result.x, 1e-3)) * 0.1), 1.0);
    color -= vec4(bg, 1.);
  }
  fragColor = vec4(clamp(color.rgb + bg, 0., 1.), 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.); }
`;

export const soundblob: ShaderDef = {
  id: 'soundblob',
  name: 'Sound Blob',
  description:
    'Twelve frequency spheres melded into one writhing blob, orbited by the camera over a layered starfield.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'blob',
      name: 'Blob',
      description: 'Bulk of the low end of the sphere chain — the blob\'s body.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'halo',
      name: 'Halo',
      description: 'The coloured glow behind the blob, and its mid-spectrum bulk.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'stars',
      name: 'Stars',
      description: 'The layered starfield, and the treble end of the chain. Hide for a black void.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'orbit',
      name: 'Orbit',
      description: 'Speed of the orbiting camera. React whips it around.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
