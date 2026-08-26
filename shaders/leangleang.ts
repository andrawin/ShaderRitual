/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Leangleang" — an endless lattice of folded cross-girders: each cell of a
 * repeating grid spins on its own random axis and folds in on itself, so the
 * whole field reads as a churning steel scaffold lit in cold blue, with
 * emissive seams running through it.
 *
 * Adapted from a Shadertoy original. Ported to GLSL-ES 1.00 (constant loop
 * bounds, tetrahedral normal kept as-is) and the flight is hooked to the
 * camera rig. The original returned a distance-dependent alpha, which would
 * punch a hole in our composite — the output is forced opaque.
 *
 * Elements:
 *   fold  -> how hard each cell folds in on itself
 *   spin  -> rotation speed of the cells
 *   seams -> the emissive seams running through the lattice; hideable
 *   glow  -> overall exposure
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
uniform float spin_react;
uniform float seams_react;
uniform float seams_visible;
uniform float glow_react;

vec2 rot(vec2 p, float r){
  mat2 m = mat2(cos(r), sin(r), -sin(r), cos(r));
  return m * p;
}

float hasira(vec3 p, vec3 s){
  vec2 q = abs(p.xy);
  vec2 m = max(s.xy - q.xy, vec2(0.0, 0.0));
  return length(max(q.xy - s.xy, 0.0)) - min(m.x, m.y);
}
float closs(vec3 p, vec3 s){
  float d1 = hasira(p, s);
  float d2 = hasira(p.yzx, s.yzx);
  float d3 = hasira(p.zxy, s.zxy);
  return min(min(d1, d2), d3);
}
float rand(vec2 co){
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}

float dist(vec3 p){
  float k = 1.2;
  vec3 sxyz = floor((p.xyz - 0.5 * k) / k) * k;
  float sz = rand(sxyz.xz);
  // spin rides the band; the sign keeps neighbouring cells counter-rotating.
  float t = iTime * (0.05 + spin_react * 0.10) + 50.0;
  p.xy = rot(p.xy, t * sign(sz - 0.5) * (sz * 0.5 + 0.7));
  p.z += t * sign(sz - 0.5) * (sz * 0.5 + 0.7);
  p = mod(p, k) - 0.5 * k;
  float s = 7.0;
  p *= s;
  p.yz = rot(p.yz, 0.76);

  // fold depth is the band-driven structural control.
  float fd = 0.4 - fold_react * 0.18;
  for(int i = 0; i < 4; i++){
    p = abs(p) - fd + (0.25 + 0.1 * sz) * sin(t * (0.5 + sz));
    p.xy = rot(p.xy, t * (0.7 + sz));
    p.yz = rot(p.yz, 1.3 * t + sz);
  }

  return closs(p, vec3(0.06, 0.06, 0.06)) / s;
}

vec3 gn(vec3 p){
  const float h = 0.001;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * dist(p + k.xyy * h) +
                   k.yyx * dist(p + k.yyx * h) +
                   k.yxy * dist(p + k.yxy * h) +
                   k.xxx * dist(p + k.xxx * h));
}

vec3 light(vec3 p, vec3 view){
  vec3 normal = gn(p);
  float vn = clamp(dot(-view, normal), 0.0, 1.0);
  vec3 ld = normalize(vec3(-1, 0.9 * sin(iTime * 0.5) - 0.1, 0));
  float NdotL = max(dot(ld, normal), 0.0);
  vec3 R = normalize(-ld + NdotL * normal * 2.0);
  float spec = pow(max(dot(-view, R), 0.0), 20.0) * clamp(sign(NdotL), 0.0, 1.0);
  vec3 col = vec3(1, 1, 1) * (pow(vn, 2.0) * 0.9 + spec * 0.3);

  float emissive = 0.0;
  if(seams_visible > 0.5){
    float k = 0.5;
    float ks = 0.9;
    vec2 sxz = floor((p.xz - 0.5 * ks) / ks) * ks;
    float sx = rand(sxz);
    float sy = rand(sxz + 100.1);
    emissive = clamp(0.001 / abs((mod(abs(p.y * sx + p.x * sy) + iTime * sign(sx - 0.5) * 0.4, k) - 0.5 * k)), 0.0, 1.0);
    emissive *= 1.0 + seams_react * 2.0;
  }
  return clamp(col * vec3(0.3, 0.5, 0.9) * 0.7 + emissive * vec3(0.2, 0.2, 1.0), 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 p = (fragCoord.xy * 2.0 - iResolution.xy) / iResolution.yy;

  vec3 tn = iTime * vec3(0.0, 0.0, 1.0) * 0.3;
  float tk = iTime * 0.3 + iCamOrbit * 0.4;
  vec3 ro = vec3(1. * cos(tk), 0.2 * sin(tk) + iCamHeight * 0.4, 1. * sin(tk)) * max(iCamDist, 0.4) + tn;
  vec3 ta = vec3(0.0, 0.0, 0.0) + tn;
  vec3 cdir = normalize(ta - ro);
  vec3 up = vec3(0., 1., 0.);
  vec3 side = cross(cdir, up);
  up = cross(side, cdir);
  float fov = 1.3 * (60.0 / iCamFov);
  vec3 rd = normalize(p.x * side + p.y * up + cdir * fov);

  float d = 0.0;
  float t = 0.1;
  float far = 18.;
  float near = t;
  float hit = 0.0001;
  for(int i = 0; i < 100; i++){
    d = dist(ro + rd * t);
    t += d;
    if(hit > d) break;
    if(t > far) break;
  }

  vec3 bcol = vec3(0.1, 0.1, 0.8);
  vec3 col = light(ro + rd * t, rd);
  col = mix(bcol, col, pow(clamp((far - t) / (far - near), 0.0, 1.0), 2.0));

  col = pow(max(col, 0.), vec3(2.2));
  col *= 2.0 * (0.7 + glow_react * 0.8);
  // Opaque: the original's distance-based alpha would cut a hole in the composite.
  fragColor = vec4(clamp(col, 0., 1.), 1.0);
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

export const leangleang: ShaderDef = {
  id: 'leangleang',
  name: 'Leangleang',
  description:
    'An endless lattice of folded cross-girders, each cell spinning on its own axis — a churning steel scaffold in cold blue.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'fold',
      name: 'Fold',
      description: 'How hard each cell folds in on itself. React reshapes the lattice.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'spin',
      name: 'Spin',
      description: 'Rotation speed of the cells. React churns the scaffold faster.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'seams',
      name: 'Seams',
      description: 'Emissive seams running through the lattice. Hide for bare steel.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Exposure',
      description: 'Overall brightness. React lifts it on hits.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
