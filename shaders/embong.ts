/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Embong" — a laser refracting through glass: a beam is traced through a
 * transparent solid, bouncing and bending at every surface, and the path it
 * carves is then lit volumetrically while the camera looks through the same
 * glass. Per-pixel jitter of the refractive index splits the beam into colour.
 *
 * Adapted from a Shadertoy original. The original stored the beam's collision
 * points in an array indexed by a running counter — dynamic indexing that
 * GLSL-ES 1.00 forbids — so the bounce list is unrolled into six named points
 * with the segment tests spelled out. The frame feedback it used to denoise
 * rides our ping-pong buffer (iChannel0 = previous frame).
 *
 * Elements:
 *   laser -> brightness of the beam's volumetric glow
 *   ior   -> refractive spread, which is what splits the beam into colour
 *   shape -> shown = folded spheres, hidden = sphere caged in a cube
 *   trail -> how much of the previous frame is held (denoise / smear)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float laser_react;
uniform float ior_react;
uniform float shape_react;
uniform float shape_visible;
uniform float trail_react;

mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }

float box(vec3 p, vec3 s){ p = abs(p) - s; return max(p.x, max(p.y, p.z)); }

float caps(vec3 p, vec3 p1, vec3 p2, float s){
  vec3 pa = p - p1;
  vec3 pb = p2 - p1;
  float prog = clamp(dot(pa, pb) / dot(pb, pb), 0., 1.);
  return length(p1 + pb * prog - p) - s;
}

/** The refractive solid. shape_visible picks which of the two forms is used. */
float map(vec3 p){
  float t = iTime * 0.1;

  // Sphere caged in a cube.
  vec3 p2 = p;
  p2.yz *= rot(t);
  p2.yx *= rot(t * 1.3);
  float d4 = max(box(p2, vec3(3)), 1.2 - length(p));

  // Folded spheres + cube (KIFS).
  float d2 = 10000.;
  for(float i = 0.; i < 3.; ++i){
    float tt = iTime * 0.03 + i;
    p.yz *= rot(tt + i);
    p.yx *= rot(tt * 1.3);
    d2 = min(d2, length(p) - 0.47);
    p = abs(p);
    p -= 0.9;
  }
  float d = min(box(p, vec3(0.4)), d2);

  return shape_visible > 0.5 ? d : d4;
}

// The beam's bounce points. The original kept these in an array indexed by a
// running counter; ES 1.00 has no dynamic indexing, so they are unrolled.
vec3 pt0, pt1, pt2, pt3, pt4, pt5;
int pid;
float atm;

/** One beam segment: adds its volumetric glow and returns its distance. */
float seg(vec3 p, vec3 a, vec3 b){
  float d3 = caps(p, a, b, 0.01);
  atm += 0.013 / (0.05 + abs(d3)) * smoothstep(4., 0.3, d3);
  return d3;
}

/** Refractive solid plus every recorded beam segment. */
float map2(vec3 p){
  float d = map(p);
  float d2 = 10000.;
  if(pid > 1) d2 = min(d2, seg(p, pt0, pt1));
  if(pid > 2) d2 = min(d2, seg(p, pt1, pt2));
  if(pid > 3) d2 = min(d2, seg(p, pt2, pt3));
  if(pid > 4) d2 = min(d2, seg(p, pt3, pt4));
  if(pid > 5) d2 = min(d2, seg(p, pt4, pt5));
  return min(abs(d), d2);
}

float rnd(vec2 uv){
  return fract(dot(sin(uv * 452.714 + uv.yx * 547.524), vec2(352.887)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  atm = 0.;

  // Per-pixel refractive index — this is what splits the beam into colour.
  float spread = 0.5 + ior_react * 0.9;
  float ior = (rnd(uv + fract(iTime * .1)) - 0.5) * spread;
  float id = ior * 2.;
  vec3 diff = 1.3 - vec3(1. + id, 0.45 + abs(id), 1. - id);

  // Trace the beam, recording where it bends.
  vec3 s2 = vec3(10, 0, 0);
  vec3 r2 = normalize(vec3(-1, sin(iTime) * 0.1, 0));
  vec3 p2 = s2;
  pt0 = p2; pt1 = p2; pt2 = p2; pt3 = p2; pt4 = p2; pt5 = p2;
  pid = 1;
  float side = 1.;

  for(int i = 0; i < 48; ++i){
    float d = abs(map(p2));
    if(d < 0.001){
      // Unrolled store — no dynamic array indexing in ES 1.00.
      if(pid == 1) pt1 = p2;
      else if(pid == 2) pt2 = p2;
      else if(pid == 3) pt3 = p2;
      else if(pid == 4) pt4 = p2;
      else if(pid == 5) pt5 = p2;
      pid += 1;
      if(pid >= 5) break;

      vec2 off = vec2(0.01, 0);
      vec3 n2 = side * normalize(d - vec3(map(p2 - off.xyy), map(p2 - off.yxy), map(p2 - off.yyx)));
      vec3 r3 = refract(r2, n2, 1. - side * (0.3 + 0.1 * ior));
      if(dot(r3, r3) < 0.5) r3 = reflect(r2, n2);
      r2 = r3;
      side = -side;
      d = 0.1;
    }
    if(d > 100.0) break;
    p2 += r2 * d;
  }
  // Final leg runs off to infinity.
  vec3 far = p2 + r2 * 1000.;
  if(pid == 1) pt1 = far;
  else if(pid == 2) pt2 = far;
  else if(pid == 3) pt3 = far;
  else if(pid == 4) pt4 = far;
  else pt5 = far;
  pid += 1;

  // Now look through the same glass.
  vec3 s = vec3(0, 0, -10. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(uv, 1));
  s.xz *= rot(iCamOrbit * 0.3);
  r.xz *= rot(iCamOrbit * 0.3);
  s.yz *= rot(iCamHeight * 0.25);
  r.yz *= rot(iCamHeight * 0.25);

  float mumu = mix(rnd(-uv + fract(iTime * .1)), 1., 0.9);
  vec3 p = s;
  float side2 = 1.;
  for(int i = 0; i < 64; ++i){
    float d = abs(map2(p));
    if(d < 0.001){
      vec2 off = vec2(0.01, 0);
      vec3 n = side2 * normalize(d - vec3(map(p - off.xyy), map(p - off.yxy), map(p - off.yyx)));
      vec3 r3 = refract(r, n, 1. - side2 * (0.3 + 0.1 * ior));
      if(dot(r3, r3) < 0.5) r3 = reflect(r, n);
      r = r3;
      side2 = -side2;
      d = 0.1;
    }
    if(d > 100.0) break;
    p += r * d * mumu;
  }

  vec3 col = diff * atm * (0.7 + laser_react * 1.3);

  // Feedback denoise, riding the ping-pong buffer.
  vec3 prev = texture2D(iChannel0, fragCoord.xy / iResolution.xy).xyz;
  col = mix(col, prev, clamp(0.45 + trail_react * 0.45, 0., 0.94));

  fragColor = vec4(max(col, 0.), 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

// The original's Image pass: contrast then gamma.
const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){
  vec3 col = texture2D(iChannel0, vUv).xyz;
  col = smoothstep(0.01, 0.9, col);
  col = pow(col, vec3(0.4545));
  gl_FragColor = vec4(col, 1.);
}
`;

export const embong: ShaderDef = {
  id: 'embong',
  name: 'Embong',
  description:
    'A laser refracting through glass — the beam bends and bounces inside a transparent solid, its path lit volumetrically and split into colour.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'laser',
      name: 'Beam',
      description: 'Brightness of the beam\'s volumetric glow. React flares it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'ior',
      name: 'Dispersion',
      description: 'Refractive spread — how far the beam splits into colour.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'shape',
      name: 'Glass',
      description: 'Shown = folded spheres. Hide for a sphere caged in a cube.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trail',
      name: 'Persistence',
      description: 'How much of the previous frame is held — smooths the beam, or smears it.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      defaultLevel: 0.55,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
