/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 2 — "Quarry". A Pralina variant, and the abstract companion to Odyssey
 * III (Extraction): the same mass, being taken apart on purpose.
 *
 * Pralina erodes its core by subtracting a lattice of spheres — erosion, which
 * has no direction. Three changes turn that into extraction, which does:
 *
 *   Bores, not bites. The subtracted primitive is a cylinder rather than a
 *     sphere, so every hole has a shaft and an axis instead of being a dent.
 *     The lattice rotates between iterations, so the bores come in at angles.
 *   Benches. p.y is quantised before the core's distance is taken, which
 *     terraces the sphere into shelves — the same trick Extraction uses on its
 *     hillside, and the reason these two cut together.
 *   Derricks. Pralina's tubes writhe on three stacked sines; these are dead
 *     straight, in a hard radial repeat, with a lamp burning on each.
 *
 * Quantising a coordinate breaks the distance field's Lipschitz bound — the
 * field can now under-report — so the march takes a heavier safety factor than
 * Pralina's, which is what stops the benches from tearing.
 *
 * Trimmed like the rest of the family: 7-deep lattice, 72-step march, and the
 * volumetric glow at 14 samples on double spacing rather than 29 on single.
 *
 * Elements:
 *   bore   -> width of the drilled shafts
 *   bench  -> how many terraces the mass is cut into
 *   rigs   -> the derrick columns and their lamps; hideable
 *   cuts   -> the scan planes, here reading as cutting lines
 *   grit   -> dust in the air
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

uniform float bore_react;
uniform float bench_react;
uniform float rigs_react;
uniform float rigs_visible;
uniform float cuts_react;
uniform float grit_react;
uniform float grit_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }
mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }
vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}
float hash21(vec2 p){
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

float map(vec3 p){
  vec3 bp = p;

  float t3 = time * 0.26;
  p.xz *= rot(t3 + sin(p.y * 0.2 + t3 * .5) * .25);
  p.xy *= rot(t3 * 0.7);

  // Benches: quantise the height before measuring, and the sphere terraces.
  float nb = 3.0 + floor(clamp(bench_react, 0.0, 2.0) * 5.5);
  // Scaled by the radius, so nb is the number of shelves on the mass rather
  // than the number per world unit — unscaled it terraces at 1/nb and a
  // 3-unit sphere comes out with 36 hairlines instead of 6 benches.
  vec3 q = p;
  q.y = (floor(q.y * nb / 3.0) + 0.5) * 3.0 / nb;
  float d = length(q) - 3.0;

  float sd = 3. / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // Derricks: straight columns in a hard radial repeat, each with a lamp.
  if(rigs_visible > 0.5){
    vec3 p6 = bp;
    p6.xz = abs(p6.xz);
    if(p6.z > p6.x) p6.xz = p6.zx;
    p6.x -= 16.;
    p6.z = abs(p6.z) - 5.;
    float d7 = max(length(p6.xz) - 0.55, 0.2);
    d = min(d, d7);
    float nod = 0.5 + 0.5 * sin(time * 2.0 + floor(bp.y * 0.1));
    aco += vec3(1.0, 0.42, 0.14)
         * (0.005 + rigs_react * 0.011) * (0.5 + nod) / (0.05 + abs(d7));
  }

  // A heavier safety factor than Pralina's 0.7 — the quantised benches make
  // the field under-report, and at 0.7 they tear.
  d *= 0.5;

  if(d < 0.1){
    float bw = 0.10 + bore_react * 0.26;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      // A shaft, not a dent: an infinite cylinder subtracted from the mass.
      d = max(d, -(length(p2.xz) - ss * bw));
      p.xz *= rot(0.55);
      p.yz *= rot(0.90);
    }

    // Cutting lines. Tighter and harder than Pralina's scan planes.
    vec3 p4 = repeat(p + time * 5., vec3(7));
    float s = 1. + cuts_react * 1.4;
    float d4 = max(abs(p4.x) - 0.06, d);
    aco += vec3(1.6, 0.62, 0.16) * 0.020 * s / (0.12 + abs(d4));
    float d5 = max(abs(p4.z) - 0.06, d);
    aco += vec3(0.9, 0.36, 0.11) * 0.014 * s / (0.12 + abs(d5));
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

  vec3 s = vec3(0, 0, -17.0);
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.15));

  // Mechanical: a steady orbit with a slow vertical crawl, no random cuts.
  float ct = time * 0.16 + iCamOrbit * 0.4;
  s.yz *= rot(0.35 + sin(time * 0.09) * 0.25 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(0.35 + sin(time * 0.09) * 0.25 + iCamHeight * 0.3);
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
    col += map(p + r * dd) * fog * 0.075 * vec3(1.0 + dd * .2, 0.55, 0.26) * ao;
  }

  float fre = pow(1. - abs(dot(n, r)), 3.);
  col += fre * vec3(1.3, 0.7, 0.35) * 1.3 * (0.5 - 0.5 * n.y) * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.34, 0.26, 0.16), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.26, 0.20, 0.14), pow(abs(r.z), 4.)) * 2.;

  // Rust and ochre, with the colour pulled out of it as the grit thickens.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum) * vec3(1.15, 0.92, 0.72), 0.35);

  if(grit_visible > 0.5){
    float g = clamp(grit_react, 0.0, 2.0);
    col = mix(col, vec3(lum) * vec3(0.95, 0.90, 0.84), g * 0.30);
    col += (hash21(floor(fragCoord * 0.5) + floor(time * 24.)) - 0.5) * 0.07 * g;
    col *= 1.0 - g * 0.10;
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

export const quarry: ShaderDef = {
  id: 'quarry',
  name: 'Core — Quarry',
  description:
    'A Pralina variant: the same mass being taken apart on purpose. Drilled shafts instead of dents, the sphere terraced into benches, derricks burning around it. The abstract companion to Odyssey III.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'bore',
      name: 'Bore',
      description:
        'Width of the shafts drilled through the mass. Cylinders, not dents — every hole has an axis.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.45,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'bench',
      name: 'Benches',
      description:
        'How many terraces the mass is cut into, 3 to 14 across the level. The same quantise Extraction uses on its hillside.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'rigs',
      name: 'Derricks',
      description:
        'The straight columns standing off the mass, each with a lamp on it. React drives how hard the lamps burn; hide for the pit alone.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'cuts',
      name: 'Cutting Lines',
      description: 'The planes working through the mass, tighter and harder than Pralina’s.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'grit',
      name: 'Grit',
      description:
        'Dust in the air. Pulls the colour out and puts a live grain over the frame. Hide for a clean image.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
