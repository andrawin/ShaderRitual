/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 6 — "Fallout". A Pralina variant, and the abstract companion to Odyssey
 * IV (Lullaby): the moment the mass goes.
 *
 * Pralina carves its core from the outside in — a lattice of spheres
 * subtracted from the surface, working inward. Here a single expanding void is
 * subtracted from the centre instead, so the mass is eaten *outward*: it
 * hollows from the middle, thins to a shell, and is gone, then the cycle
 * starts over. One line, and erosion becomes detonation.
 *
 * Around that:
 *   Three shock shells at staggered phases rather than Pralina's one, so there
 *     is always a front going out and the frame never empties. They are pure
 *     glow and never enter the distance field — a shell that is min'd in and
 *     floored makes the ray crawl through it accumulating on every step, which
 *     is enough on its own to white out the frame.
 *   A flash on the same clock as the void, cutting the whole image to white at
 *     the instant the core opens.
 *   Fallout: a point lattice drifting down rather than up, cold rather than
 *     hot, and the only thing left once the shells have passed.
 *
 * Chill takes the palette from the white of the flash to the deep blue of
 * Lullaby's night — run it up across the tail of a track and the detonation
 * cools into the sky it happened in.
 *
 * Trimmed like the rest of the family: 7-deep lattice, 72-step march, 14 glow
 * samples at double spacing.
 *
 * Elements:
 *   blast  -> size of the expanding void, and how far the shells reach
 *   flash  -> the whiteout when the core opens
 *   dust   -> the falling fallout; hideable
 *   slices -> the scan planes
 *   chill  -> white-hot through to the cold blue of the night it happened in
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

uniform float blast_react;
uniform float flash_react;
uniform float dust_react;
uniform float dust_visible;
uniform float slices_react;
uniform float chill_react;
uniform float chill_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }
mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }
vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}

float map(vec3 p){
  vec3 bp = p;

  float t3 = time * 0.24;
  p.xz *= rot(t3 + sin(p.y * 0.3 + t3 * .7) * .4);
  p.xy *= rot(t3 + sin(p.z * .4 + t3 * .6) * .4);

  float d = length(p) - 3.;
  float sd = 3. / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  float reach = 0.6 + clamp(blast_react, 0.0, 2.0) * 0.7;

  // Three fronts at staggered phases. Pure glow: min'ing a shell into d and
  // flooring it makes the ray crawl through it while accumulating on every
  // step, which whites the frame out on its own.
  for(float i = 0.; i < 3.; ++i){
    float ph = fract(time * 0.25 + i * 0.3333);
    float an = pow(ph, 2.);
    float d3 = abs(length(p) - an * 26. * reach - 2.) - (0.30 - an * 0.16);
    vec3 sc = mix(vec3(1.0, 0.94, 0.80), vec3(0.35, 0.55, 1.0), an);
    aco += sc * (0.0022 + blast_react * 0.0028) * (1.0 - an) / (0.05 + abs(d3));
  }

  // Fallout, drifting down.
  if(dust_visible > 0.5){
    vec3 ep = bp;
    ep.y += time * 1.6;
    vec3 eid = repid(ep, vec3(4.5));
    vec3 e2 = repeat(ep, vec3(4.5)) + (rnd3(eid) - 0.5) * 2.7;
    float de = length(e2) - 0.045;
    aco += vec3(0.72, 0.82, 1.0) * (0.002 + dust_react * 0.005) / (0.02 + abs(de));
  }

  d *= 0.6;

  if(d < 0.1){
    // The void, expanding out of the centre. Pralina works inward from the
    // surface; this works outward from nothing, and the mass is eaten.
    float v = pow(fract(time * 0.25), 0.5) * 3.6 * reach;
    d = max(d, -(length(p) - v));

    float bite = 0.30;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      d = max(d, -(length(p2) - ss * bite));
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    vec3 p4 = repeat(p + time * 4., vec3(8));
    float s = 1. + slices_react * 1.2;
    float d4 = max(abs(p4.x) - 0.1, d);
    aco += vec3(1.5, 1.5, 1.5) * 0.020 * s / (0.15 + abs(d4));
    float d5 = max(abs(p4.y) - 0.1, d);
    aco += vec3(0.5, 0.7, 1.6) * 0.014 * s / (0.15 + abs(d5));
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

  vec3 s = vec3(0, 0, -18.0);
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.2));

  float ct = time * 0.14 + iCamOrbit * 0.4;
  s.yz *= rot(0.3 + sin(time * 0.08) * 0.2 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(0.3 + sin(time * 0.08) * 0.2 + iCamHeight * 0.3);
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
    col += map(p + r * dd) * fog * 0.075 * vec3(0.85, 0.88, 1.0 + dd * .2) * ao;
  }

  float fre = pow(1. - abs(dot(n, r)), 3.);
  col += fre * vec3(1.0, 1.0, 1.1) * 1.3 * (0.5 - 0.5 * n.y) * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.18, 0.22, 0.34), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.14, 0.18, 0.30), pow(abs(r.z), 4.)) * 2.;

  // The whiteout, on the same clock as the void.
  float fl = pow(max(0., 1.0 - fract(time * 0.25) * 7.0), 2.0);
  col += vec3(1.0, 0.97, 0.90) * fl * (0.25 + flash_react * 0.85);

  // White-hot, cooling into the blue of the night it happened in.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if(chill_visible < 0.5){
    col = vec3(lum);
  } else {
    float k = clamp(chill_react, 0., 2.);
    vec3 hot  = vec3(lum) * vec3(1.25, 1.15, 0.95);
    vec3 cold = vec3(lum) * vec3(0.55, 0.75, 1.50);
    vec3 deep = vec3(lum) * vec3(0.28, 0.46, 1.55);
    col = mix(col, k < 1.0 ? mix(hot, cold, k) : mix(cold, deep, k - 1.0), 0.75);
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

export const fallout: ShaderDef = {
  id: 'fallout',
  name: 'Core — Fallout',
  description:
    'A Pralina variant eaten from the inside out: an expanding void hollows the mass until it is gone, three shock fronts going out around it and cold dust coming down. The abstract companion to Odyssey IV.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'blast',
      name: 'Blast',
      description:
        'Size of the void eating the mass from the centre, and how far the shock fronts reach. Pralina erodes inward from the surface; this works outward from nothing.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'flash',
      name: 'Flash',
      description:
        'The whiteout at the instant the core opens, on the same clock as the void. Put it on the kick to land the cut on the beat.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      defaultLevel: 0.25,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'dust',
      name: 'Fallout',
      description:
        'Cold dust coming down — the only thing left once the fronts have passed. Pure glow, so it is nearly free. Hide for clear space.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes cutting through what is left of the mass.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'chill',
      name: 'Chill',
      description:
        'Palette: 0 white-hot, 1 cold, 2 the deep blue of Lullaby’s night. Ride it up across a tail and the detonation cools into the sky it happened in. Hide for black and white.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
