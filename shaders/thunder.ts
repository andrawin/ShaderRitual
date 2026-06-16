/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Thunder" — a procedural lightning bolt arcing past a small core, rendered as
 * a thin volumetric glow.
 *
 * Single-pass shader (no channels). Ported from a GLSL-ES 3.00 Shadertoy
 * original to GLSL-ES 1.00 (texture-free, so mostly just the wrapper + camera
 * rig hookup). The unused dead-code helpers from the original are kept as-is.
 *
 * Elements:
 *   bolt   -> brightness + jaggedness of the lightning
 *   core   -> the small central sphere (hideable)
 *   color  -> tint of the glow (hue / white)
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

uniform float bolt_react;
uniform float bolt_visible;
uniform float core_react;
uniform float core_visible;
uniform float color_react;
uniform float color_visible;

#define MAX_STEPS 99
#define MAX_DIST 100.
#define EPSILON 0.001
#define PI 3.1415
#define EMPTY 0.
#define MIRROR 1.
#define WHITE_MIRROR 5.
#define PUREWHITE 6.
#define n getNormal(p)

mat2 Rot(float a){ float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }
float sdBox(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float rnd(float x){ return 2. * fract(54321.987139 * sin(987.123452331 * x)) - 1.; }
float sdRocket(vec3 p){ float sph = length(p) - 1.; return sph * .7; }

float lightning(vec3 p, vec2 amp){
  float id = floor(p.x);
  vec2 shift = vec2(rnd(id + iTime * 1.0), rnd(id + iTime * 1.0 + 10.));
  vec2 shiftNext = vec2(rnd(id + 1. + iTime * 1.0), rnd(id + 1. + iTime * 1.0 + 10.));
  vec2 shift_ = shift, shiftNext_ = shiftNext;
  shift = pow(shift, vec2(4.)); shiftNext = pow(shiftNext, vec2(4.));
  shift *= shift_ / abs(shift_); shiftNext *= shiftNext_ / abs(shiftNext_);
  shift *= amp; shiftNext *= amp;
  p.x -= id;
  p.yz += shift;
  float dx = 1.,
        dy = shiftNext.x - shift.x,
        dz = shiftNext.y - shift.y;
  p.xy *= Rot(atan(dy, dx));
  p.zx *= Rot(-atan(dz, length(vec2(dx, dy))));
  return length(p.yz);
}

vec2 getDist(vec3 p){
  float rocket = sdRocket(p);
  p.z -= 10.;
  p.xy *= Rot(1000. * rnd(floor(iTime * 4.16)));
  p.x -= 2.;
  p.xz *= Rot(PI / 2.2);
  p.x *= .2;
  vec2 amp = vec2(1.5 + bolt_react * 1.5);
  float obj = lightning(p, amp);
  if(core_visible > 0.5) obj = min(obj, rocket);
  return vec2(obj * .6, WHITE_MIRROR);
}

vec3 rayMarch(vec3 ro, vec3 rd){
  float d = 0.;
  float info = EMPTY;
  float minAngleToObstacle = 1e10;
  for(int i = 0; i < MAX_STEPS; i++){
    vec2 distToClosest = getDist(ro + rd * d);
    minAngleToObstacle = min(minAngleToObstacle, atan(distToClosest.x, d));
    d += abs(distToClosest.x);
    info = distToClosest.y;
    if(abs(distToClosest.x) < EPSILON || d > MAX_DIST){ break; }
  }
  return vec3(d, info, minAngleToObstacle);
}

vec3 getNormal(vec3 p){
  vec2 e = vec2(EPSILON, 0.);
  vec3 n_ = getDist(p).x - vec3(getDist(p - e.xyy).x, getDist(p - e.yxy).x, getDist(p - e.yyx).x);
  return normalize(n_);
}

vec3 getRayDir(vec2 uv, vec3 p, vec3 l, float z){
  vec3 f = normalize(l - p),
       r = normalize(cross(vec3(0, 1, 0), f)),
       u = cross(f, r),
       c = f * z,
       i = c + uv.x * r + uv.y * u,
       d = normalize(i);
  return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float d, info, dTotal = 0.;
  vec2 uv = (fragCoord - .5 * iResolution.xy) / iResolution.y;
  vec3 ro, rd, color, p, rm;
  float camDist = -10. * iCamDist;
  ro = vec3(0, iCamHeight * 3., camDist);
  ro.xz *= Rot(iCamOrbit);
  rd = getRayDir(uv, ro, vec3(0), 60. / iCamFov);
  color = vec3(0);
  float colorAmount = 0.;

  for(int reflectionDepth = 0; reflectionDepth < 2; reflectionDepth++){
    rm = rayMarch(ro, rd);
    dTotal += d = rm[0];
    info = rm[1];
    p = ro + rd * d;
    if(d < MAX_DIST){
      if(info == MIRROR){
        rd = reflect(rd, n);
        ro = p + 0.01 * rd;
        continue;
      } else if(info == WHITE_MIRROR){
        vec3 nn = n;
        nn.xy *= Rot(1.);
        color = nn * .5 + .5;
      } else if(info == PUREWHITE){
        color += vec3(1) * (1. - colorAmount);
        colorAmount = 1.;
      }
    }
    break;
  }
  color = mix(color, rd * .2, smoothstep(20., 100., dTotal));

  rm = rayMarch(ro, rd);
  vec3 glow = vec3(.003 / rm.z) * (1.0 + bolt_react * 3.0);
  vec3 tint = mix(vec3(1.), 3. * abs(1. - 2. * fract(iTime * 0.2 + color_react * 0.5 + vec3(0., -1. / 3., 1. / 3.))) - 1., color_visible * 0.7);
  fragColor = vec4(glow * tint, 1);
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

export const thunder: ShaderDef = {
  id: 'thunder',
  name: 'Thunder',
  description:
    'A procedural lightning bolt arcing past a small core, drawn as a thin volumetric glow. Single-pass — looks great with audio driving the bolt.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'bolt',
      name: 'Lightning',
      description: 'Brightness + jaggedness of the bolt. React makes it flash and thrash.',
      defaultBand: 'high',
      defaultAmount: 1.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'core',
      name: 'Core',
      description: 'The small central sphere the bolt arcs past.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'color',
      name: 'Tint',
      description: 'Colour of the glow. React shifts the hue; hide for white.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
