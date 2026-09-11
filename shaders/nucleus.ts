/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 1 — "Nucleus". A Pralina variant, and the abstract companion to Odyssey
 * I (Awakening): the mass before anything has been taken out of it. Pralina's
 * whole subject is erosion — a cross-shaped core carved hollow by a lattice of
 * subtracted spheres. Here that lattice barely bites, so the core reads as
 * intact, and what would be a ruin is a seed instead.
 *
 * Three structural changes from Pralina (see pralina.ts):
 *   - a closed shell around the core, breathing on its own slow cycle. An egg
 *     that has not opened yet, and the thing the other three variants no longer
 *     have.
 *   - one scan plane on a long repeat instead of a lattice of them on a short
 *     one, so the core is lit occasionally rather than striped constantly.
 *   - the camera's random jump-cuts and pixel-crush are gone. Pralina cuts on a
 *     hidden clock, which is right for a competition piece and wrong for a
 *     scene whose subject is stillness.
 *
 * Also trimmed for the projector: the erosion lattice runs 7 deep rather than
 * 10, the march is 72 steps rather than 100, and the volumetric glow loop
 * samples 14 times at double spacing rather than 29 at single — same reach,
 * half the map() calls, and that loop was the single most expensive thing in
 * the original.
 *
 * Elements:
 *   core   -> how far the erosion bites (0 is a whole mass)
 *   shell  -> the closed shell around it; hideable
 *   rings  -> the slow pulse travelling outward; hideable
 *   slices -> the scan plane lighting it from inside
 *   tint   -> white through ice blue to deep indigo
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

uniform float core_react;
uniform float shell_react;
uniform float shell_visible;
uniform float rings_react;
uniform float rings_visible;
uniform float slices_react;
uniform float tint_react;
uniform float tint_visible;

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

  // Slower than Pralina's tumble, and with less wobble on each axis.
  float t3 = time * 0.18;
  p.xz *= rot(t3 + sin(p.y * 0.3 + t3 * .7) * .35);
  p.xy *= rot(t3 + sin(p.z * .4 + t3 * .6) * .35);
  p.yz *= rot(t3 + sin(p.x * .2 + t3 * .8) * .35);

  float br = 1.0 + sin(time * 0.6) * 0.05;
  float d = length(p) - 3.0 * br;
  float sd = 3. / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // The closed shell, breathing. Pure glow, never min'd into d: flooring a
  // surface at 0.1 and leaving it in the field makes the ray crawl through it
  // at 0.1 a step while accumulating on every one, and a shell this large is
  // crossed by most of the frame — it blows the image out on its own.
  if(shell_visible > 0.5){
    float sr = 7.0 + sin(time * 0.35) * 0.5 * (0.5 + shell_react);
    float ds = abs(length(bp) - sr) - 0.05;
    aco += vec3(0.45, 0.72, 1.0) * (0.0012 + shell_react * 0.0022) / (0.05 + abs(ds));
  }

  // One slow pulse travelling out.
  if(rings_visible > 0.5){
    float an = pow(fract(time * 0.22), 2.);
    float ep = 0.2 - an * 0.1 - d * 0.05;
    float d3 = max(abs(length(p) - an * 20. - 3.) - ep, 0.1);
    aco += vec3(0.55, 0.75, 1.0) * (0.0025 + rings_react * 0.004) / (0.05 + abs(d3));
    d = min(d, d3);
  }

  d *= 0.7;

  if(d < 0.1){
    // Barely a bite. At level 0 the lattice leaves the mass whole.
    float bite = 0.06 + core_react * 0.22;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      d = max(d, -(length(p2) - ss * bite));
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    // A single plane on a long repeat.
    vec3 p4 = repeat(p + time * 2., vec3(14));
    float d4 = max(abs(p4.x) - 0.1, d);
    aco += vec3(0.45, 0.70, 1.9) * 0.030 * (1. + slices_react) / (0.15 + abs(d4));
    d = min(d, d4);
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

  vec3 s = vec3(0, 0, -20.0);   // outside the shell, so it frames as an object
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.2));

  // A steady drift. No cuts.
  float ct = time * 0.12 + iCamOrbit * 0.4;
  s.yz *= rot(ct * 0.6 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(ct * 0.6 + iCamHeight * 0.3);
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

  // Half the samples at double the spacing: same reach, half the map() calls.
  for(float i = 1.; i < 15.; ++i){
    float dd = 0.2 * i;
    col += map(p + r * dd) * fog * 0.075 * vec3(0.45, 0.62, 1.0 + dd * .2) * ao;
  }

  float fre = pow(1. - abs(dot(n, r)), 3.);
  col += fre * vec3(0.6, 0.8, 1.2) * 1.4 * (0.5 - 0.5 * n.y) * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.16, 0.22, 0.38), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.10, 0.16, 0.34), pow(abs(r.z), 4.)) * 2.;

  // Cold end of the spectrum only: white, ice, indigo.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if(tint_visible < 0.5){
    col = vec3(lum);
  } else {
    float k = clamp(tint_react, 0., 2.);
    vec3 ice = vec3(lum) * vec3(0.70, 0.92, 1.35);
    vec3 ind = vec3(lum) * vec3(0.42, 0.55, 1.60);
    col = k < 1.0 ? mix(vec3(lum), ice, k) : mix(ice, ind, k - 1.0);
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

export const nucleus: ShaderDef = {
  id: 'nucleus',
  name: 'Core — Nucleus',
  description:
    'A Pralina variant: the mass before anything was taken out of it. An intact core inside a breathing shell, drifting in cold blue. The abstract companion to Odyssey I.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'core',
      name: 'Erosion',
      description:
        'How far the lattice bites into the mass. At 0 it is whole — that is the point of this one. Push it and the core starts becoming Quarry.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.15,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'shell',
      name: 'Shell',
      description:
        'The closed shell around the core, breathing on its own slow cycle. React swells it; hide for the core alone.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'rings',
      name: 'Pulse',
      description: 'The slow shell travelling outward. React brightens it; hide to remove.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.25,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Plane',
      description: 'The single plane cutting through the mass and lighting it from inside.',
      defaultBand: 'high',
      defaultAmount: 0.9,
      defaultLevel: 0.2,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description:
        'The cold end only: 0 white, 1 ice blue, 2 deep indigo. Hide for black and white.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.9,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
