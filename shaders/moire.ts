/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Moire" — thirty rotated sine layers stacked at growing scale, folding into a
 * dense interference bloom.
 *
 * Adapted from a compact Shadertoy original that read a per-bin FFT to perturb
 * each layer's rotation. Here a spectral helper blends the engine's bands
 * across the layers, and the reactivity goes further than the original's
 * wobble: `detail` changes how fast the scale grows (restructuring the whole
 * interference pattern), `fold` collapses the layer stack, and `bloom` drives
 * the exposure — so hits reshape the image rather than just shaking it.
 *
 * Elements:
 *   fold   -> how many layers actually fold in (collapses the pattern)
 *   detail -> scale growth per layer; restructures the interference
 *   bloom  -> exposure / how hard the bloom burns
 *   tint   -> warm palette; hide for monochrome
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

uniform float fold_react;
uniform float detail_react;
uniform float bloom_react;
uniform float tint_react;
uniform float tint_visible;

mat2 R(float a){ float c = cos(a); float s = sin(a); return mat2(c, s, -s, c); }

/** Blend the three bands across the layer stack (stands in for per-bin FFT). */
float bandAt(float t){
  float lo = clamp(fold_react, 0., 2.);
  float md = clamp(detail_react, 0., 2.);
  float hi = clamp(bloom_react, 0., 2.);
  float a = smoothstep(0.0, 0.5, t);
  float b = smoothstep(0.5, 1.0, t);
  return mix(mix(lo, md, a), hi, b);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 r = iResolution.xy;
  vec2 p = fragCoord.xy;

  vec2 l = (p + p - r) / r.y * 0.8 * (iCamFov / 60.) * max(iCamDist, 0.3);
  l *= R(iCamOrbit * 0.3);
  l.y += iCamHeight * 0.3;

  vec2 n = vec2(0.);
  vec2 q;
  float S = 4.0;
  float h = 0.0;
  float L = dot(l, l);

  // Overall energy: drives exposure and the final lift.
  float snd = (clamp(fold_react, 0., 2.) + clamp(detail_react, 0., 2.) + clamp(bloom_react, 0., 2.)) / 6.0;

  // Layers actually folded in — collapsing this restructures the pattern.
  float layers = floor(mix(8.0, 30.0, clamp(fold_react, 0., 1.)));
  layers = max(layers, 6.0);
  // Scale growth per layer: the single biggest shape control.
  float grow = mix(1.06, 1.16, clamp(detail_react, 0., 1.));

  for(int i = 0; i < 30; i++){
    float fi = float(i) + 1.0;
    if(fi > layers) break;
    float t = fi / 30.0;
    l *= R(5.0);
    n *= R(5.0 - bandAt(t) * 0.5);
    q = l * S * fi + n;
    h += dot(r / r, sin(q) / S * 2.0);
    n += cos(q);
    S *= grow;
  }

  h = snd + 0.5 - h * 0.4 - L;

  vec3 col = tint_visible > 0.5
    ? vec3(h, h * 0.5, h * 0.2) * (1.0 + tint_react * 0.6)
    : vec3(h);
  // Hue drift when the tint element is driven.
  if(tint_visible > 0.5 && tint_react > 0.001){
    float a = tint_react * 1.4;
    col = vec3(h) * (0.6 + 0.6 * cos(a + vec3(0.0, 2.09, 4.19)));
  }
  col *= (.521 + snd * 3.0) * (1.0 + bloom_react * 0.8);

  fragColor = vec4(clamp(col, 0., 1.), 1.);
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

export const moire: ShaderDef = {
  id: 'moire',
  name: 'Moire',
  description:
    'Thirty rotated sine layers stacked at growing scale — a dense interference bloom that restructures with the music.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'fold',
      name: 'Layers',
      description: 'How many layers fold in. React collapses and rebuilds the pattern on hits.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Detail',
      description: 'Scale growth per layer — restructures the whole interference field.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'Exposure. React burns the bloom out on peaks.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description: 'Warm palette. React sweeps the hue; hide for monochrome.',
      defaultBand: 'high',
      defaultAmount: 0.7,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
