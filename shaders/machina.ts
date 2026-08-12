/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Machina" — a folded industrial interior: kaleidoscopic boxes inside a vast
 * cage, repeating pillars marching past, a refractive floor and a glowing core.
 *
 * Adapted from lechuga yera's Shadertoy original. Ported to GLSL-ES 1.00: the
 * dynamic fold loop gets a constant bound with an early break, and the
 * timeline-driven scene switch (`mod(time,3.)` picking 3 / 4 / 7 folds) becomes
 * an audio-driven element — so the geometry itself refolds with the music
 * rather than on a fixed clock.
 *
 * Elements:
 *   folds   -> how many times space is folded (3..8) — restructures the scene
 *   core    -> the glowing central sphere
 *   pillars -> the repeating pillar grid; hideable
 *   floor   -> the refractive floor planes; hideable
 *   speed   -> how fast the fold animation runs
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
uniform float pillars_react;
uniform float pillars_visible;
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
float sb(vec3 p, vec3 s){
  p = abs(p) - s;
  return max(max(p.y, p.z), p.x);
}
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - pow(h, 3.) * k * (1.0 / 6.0);
}

bool hitGround = false;
const float rep = 100.;
float glowe, glowrep;

float map(vec3 p, float time){
  p.xz *= rot(time);
  p.xy *= rot(cos(time));
  p.z += sin(cos(time) * .5 - .5) * 60.5 - .5;
  vec3 p1 = p;
  float tt = (c(time * 40., 60.5) * 4.);

  // Element: the band picks how deeply space folds (was a fixed timeline).
  float sf = floor(clamp(3. + folds_react * 4.0, 3., 8.));

  for(int i = 0; i < 8; i++){
    if(float(i) >= sf) break;
    float fi = float(i);
    p1.xz *= rot(cos(tt * .3523) * 2.);
    p1.yz *= rot(tt * .345);
    p1 = abs(p1) - fi - tt * 4.;
    p1 -= fi * .1;
  }

  float r = sin(tt + p1.x * .435345) * sin(tt + p1.y * .234234) * sin(tt + p1.z * .123123);
  float d = sb(p1, vec3(5. + r * .5 - .5));

  p1 += mod(time * 60., 40.);
  float dd = sb(p1, vec3(10. + r * .5 - .5));

  float e1 = length(p) - 10. - r * 3.;
  if(core_visible > 0.5) glowe += 4. / (1. + e1 * e1 * e1) * (1. + core_react * 2.);

  vec3 p2 = p;
  float id = rand3(floor(p2 / rep - .5));
  p2 /= 2.;
  p2.y += time * 40.;
  p2 = (fract(p2 / rep - .5) - .5) * rep;
  float e2 = length(p2.xz) - .3 - id;
  if(pillars_visible > 0.5) glowrep += 10. / (4. + e2 * e2) * (1. + pillars_react * 1.5);

  float sb2 = sb(p2, vec3(4.5));

  float pisos = 1. - abs(p.y) + (99. + sin(p.y + tt + time * 2.) * sin(p.x + tt + time * 4.) * sin(p.z + time) - 3.) * .5;
  hitGround = floor_visible > 0.5 && pisos < 0.5;

  float cage = 1. - sb(p, vec3(210.));
  d = min(d, cage);
  if(pillars_visible > 0.5){
    d = min(d, sb2);
    d = smin(d, e2, 10.);
  }
  d = min(dd, d);
  if(floor_visible > 0.5) d = min(d, pisos);
  if(core_visible > 0.5) d = smin(e1, d, 5.);
  return d;
}

vec3 nm(vec3 p, float t){
  const vec2 e = vec2(0.01, 0.);
  return map(p, t) - normalize(vec3(map(p - e.xyy, t), map(p - e.yxy, t), map(p - e.yyx, t)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  // speed rides the band, so the fold animation surges with the music.
  float time = mod(iTime * (0.6 + speed_react * 0.9), 10.) * .88;

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  float tt = c(time * 200., 100.) * .25;
  time -= rand(uv.y) * tt * .25;

  vec3 s = vec3(0.00001, .000001, -100. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(-uv, 1.));
  r.xz *= rot(iCamOrbit * 0.25);
  r.yz *= rot(iCamHeight * 0.3);

  vec3 p = s;
  vec3 col = vec3(0.);
  float dd = 0.;
  const float alfa = 1.;
  glowe = 0.;
  glowrep = 0.;

  // GLSL ES 1.00 requires the loop index to be declared in the init clause.
  for(float i = 0.; i < 64.; i++){
    float d = map(p, time);
    if(abs(d) < 0.001){
      if(hitGround){
        vec3 n = nm(p, time);
        r = refract(r, n, .001) * alfa;
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

  vec3 baseColor = 1. - vec3(0.234, .56, 0.145);
  float dao = .88;
  float ao = clamp(map(p + n * dao, time), 0., 1.);
  float fres = pow(16. - ld, .5) * .4;
  float fog = 4. - max(length(p - s) / 400., 0.);
  col += dd * baseColor * .01;
  col += glowe * baseColor - vec3(1., 0.345345, .345345);
  col += (mix(vec3(fres), vec3(ao), glowrep * baseColor * .75));

  vec2 uv2 = p.xy;
  uv2 *= 5.;
  vec2 gid = fract(max(uv2, uv2.yx) + time * 20.);
  col *= vec3(gid, 1.) * vec3(0., 1., 1.) * .5;

  col = pow(col, vec3(3.)) * vec3(0.5734, 1., 1.) * .5;
  vec3 a = rand33(col / (1. + length(uv.yx)));
  vec3 b = rand33(col / (1. + length(uv)));
  vec3 cc = pow(smoothstep(vec3(0.), vec3(1.), fract(col)), vec3(20.));
  col *= mix(a, b, cc);
  col = smoothstep(0., 1., col) * 1. - length(uv) * 1.09;

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

export const machina: ShaderDef = {
  id: 'machina',
  name: 'Machina',
  description:
    'A folded industrial interior — kaleidoscopic boxes in a vast cage, marching pillars and a refractive floor. Space refolds with the music.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'folds',
      name: 'Folds',
      description: 'How many times space is folded (3–8). React refolds the whole scene on the beat.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'core',
      name: 'Core',
      description: 'The glowing central mass. React swells it; hide to strip it out.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'pillars',
      name: 'Pillars',
      description: 'The repeating pillar grid marching past. Hide for an empty hall.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'floor',
      name: 'Floor',
      description: 'The refractive floor planes. Hide to fall through into open space.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Drive',
      description: 'How fast the fold animation runs. React surges it.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
