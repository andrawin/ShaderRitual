/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Trench" — a Machina variant reshaped into a corridor: space folds only on
 * X/Y so the structure stays open along Z, ribs repeat down the tunnel, and the
 * camera flies through it. Cold steel and cyan.
 *
 * Same skeleton as Machina (see machina.ts), with the fold axis constrained and
 * the lattice laid along the flight direction instead of vertically.
 *
 * Elements:
 *   folds -> how tight the trench walls fold (3..8)
 *   glow  -> the light strip running down the trench
 *   ribs  -> the repeating ribs passing by; hideable
 *   floor -> the refractive floor; hideable
 *   speed -> flight speed down the trench
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
uniform float glow_react;
uniform float glow_visible;
uniform float ribs_react;
uniform float ribs_visible;
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
float sb(vec3 p, vec3 s){ p = abs(p) - s; return max(max(p.y, p.z), p.x); }
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - pow(h, 3.) * k * (1.0 / 6.0);
}

bool hitGround = false;
float glowe, glowrep;

float map(vec3 p, float time){
  // Fly down Z; only a gentle roll, so the corridor stays readable.
  p.xy *= rot(sin(time * 0.5) * 0.35);
  p.z += time * 120.;
  vec3 p0 = p;
  float tt = (c(time * 40., 60.5) * 3.);

  // Folds act on the cross-section only — Z is left open.
  float sf = floor(clamp(3. + folds_react * 4.0, 3., 8.));
  vec3 p1 = p;
  for(int i = 0; i < 8; i++){
    if(float(i) >= sf) break;
    float fi = float(i);
    p1.xy = abs(p1.xy) - 7. - tt * 2.5;
    p1.xy *= rot(tt * .21 + fi * .3);
  }

  float r = sin(tt + p1.x * .38) * sin(tt + p1.y * .29);
  // Long boxes: wide in Z so they read as trench walls, not blocks.
  float d = sb(p1, vec3(6. + r * 1.5, 6. + r * 1.5, 60.));

  // The light strip running the length of the trench.
  float e1 = length(p0.xy) - 5. - r * 2.;
  if(glow_visible > 0.5) glowe += 5. / (1. + e1 * e1 * e1) * (1. + glow_react * 2.5);

  // Ribs tiled along the flight axis.
  vec3 p2 = p0;
  p2.z = mod(p2.z, 60.) - 30.;
  float e2 = max(length(p2.xy) - 26., abs(p2.z) - 2.5);
  if(ribs_visible > 0.5) glowrep += 10. / (4. + e2 * e2) * (1. + ribs_react * 1.6);

  float pisos = 1. - abs(p.y) + (99. + sin(p.y + tt) * sin(p.x + tt + time * 3.) * sin(p.z * .05 + time) - 3.) * .5;
  hitGround = floor_visible > 0.5 && pisos < 0.5;

  float shell = 1. - sb(p, vec3(220., 220., 4000.));
  d = min(d, shell);
  if(ribs_visible > 0.5) d = smin(d, e2, 6.);
  if(floor_visible > 0.5) d = min(d, pisos);
  if(glow_visible > 0.5) d = smin(e1, d, 6.);
  return d;
}

vec3 nm(vec3 p, float t){
  const vec2 e = vec2(0.01, 0.);
  return map(p, t) - normalize(vec3(map(p - e.xyy, t), map(p - e.yxy, t), map(p - e.yyx, t)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float time = mod(iTime * (0.5 + speed_react * 1.1), 10.) * .88;

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  float tt = c(time * 200., 100.) * .25;
  time -= rand(uv.y) * tt * .25;

  vec3 s = vec3(0.00001, .000001, -70. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(-uv, 1.));
  r.xz *= rot(iCamOrbit * 0.18);
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

  // Steel / cyan.
  vec3 baseColor = vec3(0.35, 0.85, 1.0);
  float dao = .88;
  float ao = clamp(map(p + n * dao, time), 0., 1.);
  float fres = pow(16. - ld, .5) * .4;
  float fog = 4. - max(length(p - s) / 400., 0.);
  col += dd * baseColor * .012;
  col += glowe * baseColor - vec3(0.9, 0.55, 0.25);
  col += (mix(vec3(fres), vec3(ao), glowrep * baseColor * .75));

  vec2 uv2 = p.xy * 5.;
  vec2 gid = fract(max(uv2, uv2.yx) + time * 20.);
  col *= vec3(gid.x * .35, gid.y * .8 + .2, 1.) * .75;

  col = pow(max(col, 0.), vec3(2.8)) * vec3(0.45, 0.9, 1.15) * .55;
  vec3 a = rand33(col / (1. + length(uv.yx)));
  vec3 b = rand33(col / (1. + length(uv)));
  vec3 cc = pow(smoothstep(vec3(0.), vec3(1.), fract(col)), vec3(20.));
  col *= mix(a, b, cc);
  col = smoothstep(0., 1., col) - length(uv) * 1.0;

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

export const trench: ShaderDef = {
  id: 'trench',
  name: 'Trench',
  description:
    'Machina reshaped into a corridor — folded trench walls, ribs rushing past and a light strip running to the vanishing point.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'folds',
      name: 'Folds',
      description: 'How tightly the trench walls fold (3–8). React reshapes the corridor.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Light Strip',
      description: 'The strip running the length of the trench. Hide for a dark run.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'ribs',
      name: 'Ribs',
      description: 'The rings rushing past. Hide for a smooth tunnel.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'floor',
      name: 'Floor',
      description: 'The refractive floor. Hide to fly through open space.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Flight',
      description: 'Speed down the trench. React surges the run.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
