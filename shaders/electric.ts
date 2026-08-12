/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Electric" — nimitz's noise animation: a ridged fbm domain-warped by two more
 * fbm calls, cut by logarithmic rings so it reads as arcing electricity.
 *
 * Adapted from the Shadertoy original, which sampled a noise texture on
 * iChannel0. Here the noise texture is rebuilt procedurally in Buffer B
 * (repeat-wrapped, read as iChannel1) and the audio bands drive the turbulence,
 * ring pulse and palette.
 *
 * Elements:
 *   bolts -> turbulence of the arcs (fbm gain)
 *   rings -> the expanding ring pulse; hide for pure plasma
 *   heat  -> brightness / how hot the cores burn
 *   hue   -> palette shift; hide for the original violet
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

uniform float bolts_react;
uniform float rings_react;
uniform float rings_visible;
uniform float heat_react;
uniform float hue_react;
uniform float hue_visible;

#define tau 6.2831853

mat2 makem2(in float theta){ float c = cos(theta); float s = sin(theta); return mat2(c, -s, s, c); }
float noise(in vec2 x){ return texture2D(iChannel1, x * .01).x; }

float fbm(in vec2 p){
  float z = 2.;
  float rz = 0.;
  for(int i = 1; i < 6; i++){
    rz += abs((noise(p) - 0.5) * 2.) / z;
    z = z * 2.;
    p = p * 2.;
  }
  return rz;
}

float dualfbm(in vec2 p, float t){
  // Two rotated fbm calls displace the domain; bolts pushes the displacement.
  vec2 p2 = p * .7;
  float warp = .2 * (1. + bolts_react * 2.5);
  vec2 basis = vec2(fbm(p2 - t * 1.6), fbm(p2 + t * 1.7));
  basis = (basis - .5) * warp;
  p += basis;
  return fbm(p * makem2(t * 0.2));
}

float circ(vec2 p){
  float r = length(p);
  r = log(sqrt(r));
  return abs(mod(r * 4., tau) - 3.14) * 3. + .2;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float t = iTime * 0.15;

  vec2 p = fragCoord.xy / iResolution.xy - 0.5;
  p.x *= iResolution.x / iResolution.y;
  p *= 4. * (iCamFov / 60.) * max(iCamDist, 0.3);
  p *= makem2(iCamOrbit * 0.3);
  p.y += iCamHeight * 0.6;

  float rz = dualfbm(p, t);

  // Rings: the pulse rate rides the band, so hits snap the rings outward.
  if(rings_visible > 0.5){
    float pulse = mod(t * 10. * (1. + rings_react * 1.5), 3.14159);
    p /= exp(pulse);
    rz *= pow(abs((0.1 - circ(p))), .9);
  }

  // heat brightens the cores (rz sits in the denominator).
  float gain = 1. + heat_react * 1.6;
  vec3 base = vec3(.2, 0.1, 0.4);
  if(hue_visible > 0.5){
    // Rotate the palette around the original violet.
    float h = hue_react * 1.2;
    base = vec3(
      .2 + .25 * sin(h),
      .1 + .2 * sin(h + 2.09),
      .4 + .2 * sin(h + 4.19));
    base = max(base, vec3(0.02));
  }
  vec3 col = base * gain / max(rz, 1e-3);
  col = pow(abs(col), vec3(.99));
  fragColor = vec4(clamp(col, 0., 1.), 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

// Smooth tiling value noise standing in for Shadertoy's 256x256 noise texture.
const bufferBShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;

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

export const electric: ShaderDef = {
  id: 'electric',
  name: 'Electric',
  description:
    "nimitz's ridged-noise electricity — domain-warped plasma arcs cut by expanding logarithmic rings.",
  bufferShader,
  bufferBShader,
  imageShader,
  elements: [
    {
      id: 'bolts',
      name: 'Arcs',
      description: 'Turbulence of the electric arcs. React tears them apart.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'rings',
      name: 'Rings',
      description: 'The expanding ring pulse. React snaps them outward; hide for pure plasma.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'heat',
      name: 'Heat',
      description: 'How hot the cores burn.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'hue',
      name: 'Hue',
      description: 'Palette shift. React sweeps the colour; hide for the original violet.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
