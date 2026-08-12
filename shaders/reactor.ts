/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Reactor" — a Machina variant turned radial and hot: octahedral folds instead
 * of boxes, a toroidal ring lattice orbiting the core instead of vertical
 * pillars, and an orange / iron palette. Reads like standing inside a reactor.
 *
 * Same skeleton as Machina (see machina.ts) — audio-driven fold count, glowing
 * core, hideable lattice and floor — with the primitive and repetition swapped.
 *
 * Elements:
 *   folds -> how deeply space folds (3..8); restructures the chamber
 *   core  -> the burning central mass
 *   rings -> the orbiting torus lattice; hideable
 *   floor -> the refractive floor; hideable
 *   speed -> how fast the folds churn
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

uniform float folds_react;
uniform float core_react;
uniform float core_visible;
uniform float rings_react;
uniform float rings_visible;
uniform float floor_react;
uniform float floor_visible;
uniform float speed_react;

#define rot(a) mat2(cos(a), sin(a), -sin(a), cos(a))

float rand(float x){ return fract(sin(x * 345.345) * 454.345345); }
float rand3(vec3 p){ return fract(sin(dot(p, p.yzx * 324.2344)) * 2342.234); }
vec3 rand33(vec3 p){ return fract(sin(p * 6234.324) * 567.5675); }

float c(float t, float s){
  t /= s;
  return mix(rand(floor(t)), rand(floor(t + 1.)), pow(smoothstep(0., 1., fract(t)), 10.));
}
/** Octahedron — the sharp cousin of Machina's box. */
float oct(vec3 p, float s){ p = abs(p); return (p.x + p.y + p.z - s) * 0.5773; }
float sb(vec3 p, vec3 s){ p = abs(p) - s; return max(max(p.y, p.z), p.x); }
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - pow(h, 3.) * k * (1.0 / 6.0);
}

bool hitGround = false;
float glowe, glowrep;

float map(vec3 p, float time){
  p.xz *= rot(time * 0.7);
  p.yz *= rot(sin(time) * 0.4);
  vec3 p0 = p;
  float tt = (c(time * 40., 60.5) * 3.5);

  float sf = floor(clamp(3. + folds_react * 4.0, 3., 8.));
  vec3 p1 = p;
  for(int i = 0; i < 8; i++){
    if(float(i) >= sf) break;
    float fi = float(i);
    p1 = abs(p1) - 5.5 - tt * 3.;
    p1.xy *= rot(tt * .28 + fi * .35);
    p1.xz *= rot(cos(tt * .31) * 1.6);
  }

  float r = sin(tt + p1.x * .41) * sin(tt + p1.y * .27) * sin(tt + p1.z * .19);
  float d = oct(p1, 8. + r * 2.);

  // Burning core.
  float e1 = length(p0) - 11. - r * 3.;
  if(core_visible > 0.5) glowe += 5. / (1. + e1 * e1 * e1) * (1. + core_react * 2.5);

  // Rings: a torus lattice tiled in radius and height, orbiting the core.
  vec3 p2 = p0;
  float rad = length(p2.xz);
  vec2 q = vec2(mod(rad, 42.) - 21., mod(p2.y + time * 45., 42.) - 21.);
  float e2 = length(q) - 4.;
  if(rings_visible > 0.5) glowrep += 11. / (4. + e2 * e2) * (1. + rings_react * 1.6);

  float pisos = 1. - abs(p.y) + (99. + sin(p.y + tt + time * 2.) * sin(p.x + tt) * sin(p.z + time) - 3.) * .5;
  hitGround = floor_visible > 0.5 && pisos < 0.5;

  float shell = 1. - sb(p, vec3(210.));
  d = min(d, shell);
  if(rings_visible > 0.5) d = smin(d, e2, 8.);
  if(floor_visible > 0.5) d = min(d, pisos);
  if(core_visible > 0.5) d = smin(e1, d, 5.);
  return d;
}

vec3 nm(vec3 p, float t){
  const vec2 e = vec2(0.01, 0.);
  return map(p, t) - normalize(vec3(map(p - e.xyy, t), map(p - e.yxy, t), map(p - e.yyx, t)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float time = mod(iTime * (0.6 + speed_react * 0.9), 10.) * .88;

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  float tt = c(time * 200., 100.) * .25;
  time -= rand(uv.y) * tt * .25;

  vec3 s = vec3(0.00001, .000001, -95. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(-uv, 1.));
  r.xz *= rot(iCamOrbit * 0.25);
  r.yz *= rot(iCamHeight * 0.3);

  vec3 p = s;
  vec3 col = vec3(0.);
  float dd = 0.;
  glowe = 0.;
  glowrep = 0.;

  for(float i = 0.; i < 64.; i++){
    float d = map(p, time);
    if(abs(d) < 0.001){
      if(hitGround){
        vec3 n = nm(p, time);
        r = refract(r, n, .001);
        d -= 100.;
      } else {
        break;
      }
    }
    p += d * r;
    dd += 200. / (10. + d * d * d);
  }

  vec3 n = nm(p, time);
  float ld = clamp(dot(n, r), 0., 1.);
  col -= ld;

  // Iron / ember palette.
  vec3 baseColor = vec3(1.0, 0.42, 0.14);
  float dao = .88;
  float ao = clamp(map(p + n * dao, time), 0., 1.);
  float fres = pow(16. - ld, .5) * .4;
  float fog = 4. - max(length(p - s) / 400., 0.);
  col += dd * baseColor * .012;
  col += glowe * baseColor - vec3(0.35, 0.9, 1.15);
  col += (mix(vec3(fres), vec3(ao), glowrep * baseColor * .7));

  vec2 uv2 = p.xy * 5.;
  vec2 gid = fract(max(uv2, uv2.yx) + time * 20.);
  col *= vec3(1., gid.x * .6 + .4, gid.y * .3) * .8;

  col = pow(max(col, 0.), vec3(2.6)) * vec3(1.15, 0.62, 0.32) * .6;
  vec3 a = rand33(col / (1. + length(uv.yx)));
  vec3 b = rand33(col / (1. + length(uv)));
  vec3 cc = pow(smoothstep(vec3(0.), vec3(1.), fract(col)), vec3(20.));
  col *= mix(a, b, cc);
  col = smoothstep(0., 1., col) - length(uv) * 1.05;

  col *= ao * fres * fog;
  fragColor = sqrt(vec4(max(col, 0.), 1.0));
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

export const reactor: ShaderDef = {
  id: 'reactor',
  name: 'Reactor',
  description:
    'Machina turned radial and molten — octahedral folds, torus rings orbiting a burning core, iron and ember.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'folds',
      name: 'Folds',
      description: 'How deeply space folds (3–8). React restructures the chamber on the beat.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'core',
      name: 'Core',
      description: 'The burning central mass. React swells it; hide to strip it out.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'rings',
      name: 'Rings',
      description: 'The torus lattice orbiting the core. Hide for an empty chamber.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'floor',
      name: 'Floor',
      description: 'The refractive floor. Hide to fall through into open space.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Drive',
      description: 'How fast the folds churn. React surges it.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
