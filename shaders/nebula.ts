/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Nebula" — a volumetric Julia-fractal fog. Adapted from srtuss (2014).
 * Pure procedural (no channel inputs), so the port is direct; audio is wired in
 * via element reacts (density / warp / colour) and the camera rig.
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
uniform float density_react;
uniform float warp_react;
uniform float color_react;

#define STEPS 80

float rnd(float x){ return fract(sin(x * 143.5925) * 98723.8791); }
float nse(float x){ float fl = floor(x); return mix(rnd(fl), rnd(fl + 1.0), smoothstep(0.0, 1.0, fract(x))); }
float fbm(float x){ return nse(x) * 0.5 + nse(x * 2.0) * 0.25 + nse(x * 4.0) * 0.125; }
vec2 rotate(vec2 p, float a){ return vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a)); }

float scene(vec3 p){
  p *= iTime;
  vec3 pz = p;
  vec3 jul = vec3(2.2, 0.75, 0.3) + warp_react * vec3(0.4, 0.15, 0.1);
  for(int i = 0; i < 10; i++){
    p = p + pz / dot(p, p) + jul;
    p = p * (-1.0) * 0.3;
  }
  return pow(max(length(p), 0.0), 0.8);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord.xy / iResolution.xy;
  vec2 pos = uv;
  uv = uv * 2.0 - 1.0;
  uv.x *= iResolution.x / iResolution.y;

  vec3 ro = vec3(0.0, iCamHeight, (cos(iTime * 0.1) * -2.0 - 1.0) * iCamDist);
  vec3 rd = normalize(vec3(uv, 1.66 * (60.0 / iCamFov)));

  float t = iTime * 0.05;
  ro.xz = rotate(ro.xz, cos(t * 2.0) + iCamOrbit);
  rd.xz = rotate(rd.xz, cos(t) + iCamOrbit);

  vec3 r = ro;
  float a = 0.0;
  for(int i = 0; i < STEPS; i++){ a += scene(r); r += rd * 0.05; }
  a /= float(STEPS);
  float v = a * 0.15;
  vec3 col = vec3(v);
  col = pow(col, vec3(1.0, 0.6, 0.4) * 6.0) * 5.0;
  col = pow(col, vec3(1.0 / 2.2));
  col *= 0.1 + 0.9 * pow(16.0 * pos.x * pos.y * (1.0 - pos.x) * (1.0 - pos.y), 0.1);
  col *= fbm(iTime * 20.0) * 0.4 + 0.7;
  col *= 0.6 + density_react * 1.4;

  vec3 tint = 3.0 * abs(1.0 - 2.0 * fract(iTime * 0.1 + color_react * 0.4 + vec3(0.0, -1.0 / 3.0, 1.0 / 3.0))) - 1.0;
  col = mix(col, col * tint, color_react);

  fragColor = vec4(col, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  fragColor = texture2D(iChannel0, fragCoord / iResolution.xy);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const nebula: ShaderDef = {
  id: 'nebula',
  name: 'Nebula',
  description: 'A volumetric Julia-fractal fog (after srtuss). React drives density, warp and colour.',
  bufferShader,
  imageShader,
  elements: [
    { id: 'density', name: 'Density', description: 'Overall fog brightness. React on bass.', defaultBand: 'low', defaultAmount: 1.0, canHide: false, defaultVisible: true },
    { id: 'warp', name: 'Warp', description: 'Perturbs the Julia constant. React on treble.', defaultBand: 'high', defaultAmount: 0.6, canHide: false, defaultVisible: true },
    { id: 'color', name: 'Colour', description: 'Palette tint amount. React on mids; hide for mono.', defaultBand: 'mid', defaultAmount: 0.6, canHide: true, defaultVisible: true },
  ],
};
