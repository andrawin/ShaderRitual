/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 3 — "Blight". A Pralina variant, and the abstract companion to Odyssey
 * V (Miasma): the mass with something growing on it.
 *
 * This is the one that inverts Pralina rather than retuning it. Pralina's
 * lattice is subtracted — max(d, -sphere) — which takes material away. Here the
 * same lattice is smooth-unioned on instead, so every cell puts a blister on
 * the surface and the core swells and fuses into itself. Identical loop,
 * opposite sign, completely different object: one is a ruin, this is a culture
 * dish.
 *
 * Two more changes follow from that:
 *   A creeping film. Three multiplied sines displace the surface, so it is
 *     lumpy everywhere rather than clean between blisters.
 *   The gate widens. Pralina only runs its lattice where d < 0.1, because
 *     subtraction can only affect material that is already there. Blisters
 *     stick out, so the gate has to open before the ray reaches the surface or
 *     they are marched straight past.
 *
 * Union keeps the field conservative, so unlike Quarry this one does not need a
 * heavier safety factor — but the sine displacement does break the bound, which
 * is why it is scaled down rather than applied at full strength.
 *
 * Elements:
 *   spread -> how far the blistering has taken hold
 *   film   -> the creeping surface displacement; hideable
 *   bloom  -> spore pulses travelling outward; hideable
 *   slices -> the scan planes
 *   decay  -> palette, pale yellow through to deep bile green
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

uniform float spread_react;
uniform float film_react;
uniform float film_visible;
uniform float bloom_react;
uniform float bloom_visible;
uniform float slices_react;
uniform float decay_react;
uniform float decay_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }
mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }
vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0., 1.);
  return mix(b, a, h) - k * h * (1. - h);
}

float map(vec3 p){
  vec3 bp = p;

  float t3 = time * 0.22;
  p.xz *= rot(t3 + sin(p.y * 0.25 + t3 * .6) * .45);
  p.xy *= rot(t3 * 0.8 + sin(p.z * .3 + t3 * .5) * .45);

  float d = length(p) - 2.6;
  float sd = 2.6 / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // Spore pulses.
  if(bloom_visible > 0.5){
    float an = pow(fract(time * 0.4), 2.);
    float ep = 0.25 - an * 0.1 - d * 0.05;
    float d3 = max(abs(length(p) - an * 18. - 3.) - ep, 0.1);
    aco += vec3(0.55, 0.85, 0.18) * (0.004 + bloom_react * 0.007) / (0.05 + abs(d3));
    d = min(d, d3);
  }

  d *= 0.6;

  // Wide gate: blisters stand off the surface, so the lattice has to be
  // evaluated before the ray arrives at it.
  if(d < 0.9){
    float grow = 0.16 + spread_react * 0.26;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      // Pralina's max(d, -sphere). Union instead, and the mass grows.
      d = smin(d, length(p2) - ss * grow, 0.32);
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    if(film_visible > 0.5){
      float f = sin(p.x * 2.1 + time) * sin(p.y * 1.9 - time * 0.7)
              * sin(p.z * 2.3 + time * 0.4);
      d -= f * 0.09 * (0.3 + film_react);
    }

    vec3 p4 = repeat(p + time * 2.5, vec3(9));
    float s = 1. + slices_react * 1.2;
    float d4 = max(abs(p4.y) - 0.12, d);
    aco += vec3(0.9, 1.5, 0.30) * 0.024 * s / (0.15 + abs(d4));
    float d5 = max(abs(p4.z) - 0.12, d);
    aco += vec3(0.6, 0.8, 0.18) * 0.014 * s / (0.15 + abs(d5));
    d = min(d, min(d4, d5));
  }

  return d;
}

float gao(vec3 p, vec3 n, float s){ return clamp(map(p + n * s) / s, 0., 1.); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  time = mod(iTime * 0.5, 300.);
  aco = vec3(0.);

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  vec3 s = vec3(0, 0, -16.0);
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.2));

  // A queasy drift rather than a clean orbit.
  float ct = time * 0.10 + sin(time * 0.07) * 0.6 + iCamOrbit * 0.4;
  s.yz *= rot(ct * 0.5 + sin(time * 0.05) * 0.3 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(ct * 0.5 + sin(time * 0.05) * 0.3 + iCamHeight * 0.3);
  r.xz *= rot(ct);

  vec3 p = s;
  for(int i = 0; i < 72; ++i){
    float d = map(p);
    if(d < 0.001) break;
    if(d > 100.0) break;
    p += r * d;
  }

  float fog = 1. - clamp(length(p - s) / 100., 0., 1.);
  vec3 col = aco * .9;

  vec2 off = vec2(0.01, 0);
  vec3 n = normalize(map(p) - vec3(map(p - off.xyy), map(p - off.yxy), map(p - off.yyx)));

  float ao = gao(p, n, 0.35);
  ao *= gao(p, n, 1.0) * .5 + .5;

  for(float i = 1.; i < 15.; ++i){
    float dd = 0.2 * i;
    col += map(p + r * dd) * fog * 0.075 * vec3(0.62, 0.95 + dd * .2, 0.22) * ao;
  }

  float fre = pow(1. - abs(dot(n, r)), 3.);
  col += fre * vec3(0.85, 1.25, 0.35) * 1.3 * (0.5 - 0.5 * n.y) * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.22, 0.28, 0.08), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.18, 0.24, 0.07), pow(abs(r.z), 4.)) * 2.;

  // Pale yellow, souring into bile green as the level climbs.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if(decay_visible < 0.5){
    col = vec3(lum);
  } else {
    float k = clamp(decay_react, 0., 2.);
    vec3 pale = vec3(lum) * vec3(1.25, 1.25, 0.55);
    vec3 bile = vec3(lum) * vec3(0.55, 1.35, 0.28);
    vec3 deep = vec3(lum) * vec3(0.30, 0.95, 0.22);
    col = mix(col, k < 1.0 ? mix(pale, bile, k) : mix(bile, deep, k - 1.0), 0.8);
  }

  col *= 1.2 - length(uv);
  fragColor = vec4(max(col, 0.), 1.0);
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

export const blight: ShaderDef = {
  id: 'blight',
  name: 'Core — Blight',
  description:
    'A Pralina variant with its lattice inverted: the same cells that carved the core hollow now blister it over. A mass growing into itself in bile green. The abstract companion to Odyssey V.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'spread',
      name: 'Blister',
      description:
        'How far the growth has taken hold. Pralina subtracts this lattice; here it is unioned on, so the level swells the mass instead of hollowing it.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'film',
      name: 'Creep',
      description:
        'A film over the whole surface, so it is lumpy between the blisters too. Hide for clean geometry.',
      defaultBand: 'high',
      defaultAmount: 0.9,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Spore Bloom',
      description: 'Pulses travelling outward off the mass. React brightens them; hide to remove.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes cutting through the mass and lighting it from inside.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'decay',
      name: 'Decay',
      description:
        'Palette: 0 pale yellow, 1 bile green, 2 deep and sour. Hide for black and white.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
