/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Phantom" — a spinning box-lattice raymarcher drowning in frame feedback.
 *
 * This is a FEEDBACK shader: Buffer A samples its own previous frame through
 * iChannel0 (stored in the alpha channel) to build the smears, echoes and
 * motion-blur trails. The engine's ping-pong targets make that read safe.
 *
 * Ported from a Shadertoy (GLSL-ES 3.00) original to the engine's GLSL-ES 1.00
 * two-pass pipeline:
 *   - texture()      -> texture2D()
 *   - dynamic for-loop bounds -> constant bounds with an early `break`
 *   - the auto camera spin is overlaid with the global camera rig.
 *
 * Elements:
 *   structure -> the lattice geometry + its edge light
 *   glow      -> the volumetric core glow (bl1 accumulation)
 *   trails    -> length / spread of the frame-feedback smear
 *   color     -> palette cycling (hue shift + grayscale toggle)
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

uniform float structure_react;
uniform float structure_visible;
uniform float glow_react;
uniform float glow_visible;
uniform float trails_react;
uniform float trails_visible;
uniform float color_react;
uniform float color_visible;

float np(vec2 p){
  vec2 f = floor(p); p = smoothstep(0., 1., fract(p));
  vec2 se = vec2(45., 78.);
  vec2 v1 = dot(f, se) + vec2(0., se.y);
  vec2 v2 = mix(fract(sin(v1) * 7845.236), fract(sin(v1 + se.x) * 7845.236), p.x);
  return mix(v2.x, v2.y, p.y);
}
float it(vec2 t){
  float r = 0.; float a = 0.5;
  for(int i = 0; i < 4; i++){ r += np(t / a) * a; a *= 0.5; }
  return r;
}
mat2 rot(float t){ float c = cos(t); float s = sin(t); return mat2(c, -s, s, c); }
float rd(float t){ return fract(sin(dot(floor(t), 45.)) * 7845.236); }
float no(float t){ return mix(rd(t), rd(t + 1.), smoothstep(0., 1., t)); }
float it(float t){
  float r = 0.; float a = 0.5;
  for(int i = 0; i < 4; i++){ r += no(t / a) * a; a *= 0.5; }
  return r;
}
float box(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(vec3(0.), q)) + min(0., max(q.x, max(q.y, q.z)));
}

float zl1; float bl1;

float map(vec3 p, vec4 ta){
  p.y += sin(iTime * 2.);
  p.xy *= rot(iTime);
  p = abs(p);
  if(p.x > p.z) p.xz = p.zx;
  vec3 pb = p;
  vec3 pb2 = p;
  pb.xz *= rot(iTime);
  pb2.xy *= rot(iTime);
  vec3 rb = vec3(2.);
  pb = mod(pb, rb) - 0.5 * rb;
  vec3 rb2 = vec3(1.);
  pb2 = mod(pb2, rb2) - 0.5 * rb2;
  float d1 = box(p, vec3(ta.x * 0.8, ta.y * 20., ta.x * 2.));
  float d2 = box(pb, vec3(0.5));
  float d4 = box(pb2, vec3(0.5, 0.3, 0.3));
  float d3 = max(min(d2, d4), d1);
  float dl = max(d2, d1);
  zl1 = dl;
  float fl1 = 0.1;
  bl1 += fl1 / (fl1 + d2);
  return d3;
}
vec3 nor(vec3 p, vec4 ta){
  vec2 e = vec2(0.01, 0.);
  return normalize(map(p, ta) - vec3(map(p - e.xyy, ta), map(p - e.yxy, ta), map(p - e.yyx, ta)));
}
float ev(vec3 r){ return clamp(pow(np(r.xz), 2.), 0., 0.5); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float time = iTime;
  bl1 = 0.; // feedback glow accumulates per-fragment; start clean

  vec2 uv = fragCoord / iResolution.xy;
  vec2 uc = uv;
  uv -= 0.5;
  uv *= 2.;
  uv.x *= iResolution.x / iResolution.y;

  float tl = smoothstep(0.88, 0.95, fract(time * 0.07));
  vec2 vu2 = mix(vec2(5.), vec2(3., 5.), tl);
  vec2 tu = vec2(np(uv * vu2 + time), np(uv * vu2 - time + 47.));
  vec2 tu2 = tu * 0.5 + (vec2(it(uv * vec2(3., 5.) + time), np(uv * vec2(3., 5.) - time + 47.)) - 0.5) * 0.5;
  vec4 ta = vec4(it(time * 2.) * 2. + 1.5, it(time * 3. + 45.), 0., 0.);

  // --- camera: native spin overlaid with the global rig ---
  vec3 p = vec3(0., iCamHeight * 3., -10. * iCamDist);
  float focal = 60.0 / iCamFov;                 // fov 60 == original framing
  vec3 r = normalize(vec3(uv + tu2 * tl, focal));
  float tt = time + it(time) * 12. + iCamOrbit;
  p.xz *= rot(tt);
  r.xz *= rot(tt);

  float dd = 0.;
  for(int i = 0; i < 64; i++){
    float d = map(p, ta);
    if(dd > 40.){ dd = 40.; break; }
    if(d < 0.001){ break; }
    p += r * d;
    dd += d;
  }

  float s = smoothstep(40., 0., dd);
  float l1 = smoothstep(0.01, 0., zl1) * 2. + smoothstep(0.2, 0., zl1) * 0.5 + smoothstep(0.3, 0., zl1) * 0.2;

  // structure element: hide the geometry / drive its edge light
  s *= structure_visible;
  l1 *= structure_visible * (1.0 + structure_react * 2.0);

  vec3 n = nor(p, ta);
  float dao = 0.9;
  float ao = mix(0., 1., clamp(map(p + n * dao, ta) / dao, 0., 1.));
  float ld = clamp(dot(n, -r), 0., 1.);
  float fres = pow(1. - ld, 2.) * 0.9;
  float spec = pow(ld, 9.) * 0.2;
  float ref = clamp(ev(reflect(n, r)), 0., 1.);

  // glow element: scale the volumetric core glow
  float r0 = mix(ev(r), (l1 + fres + spec + ref * 0.5) * ao, s)
           + bl1 * 0.003 * glow_visible * (1.0 + glow_react * 3.0);

  // trails element: feedback smear strength
  float trailVis = trails_visible;
  float bb = clamp(smoothstep(0.51, 1., texture2D(iChannel0, uc + tu * 0.01).a), 0., 0.5) * trailVis;
  float r2 = r0 + bb * 0.9;

  float b = 0.5 * sqrt(32.);
  float c = 0.;
  float d = (pow(length(uv.y), 1.5) * 0.005 + 0.0005) * (1.0 + trails_react * 1.5);
  for(int jj = 0; jj < 6; jj++)
  for(int kk = 0; kk < 6; kk++){
    float j = -b + float(jj);
    float k = -b + float(kk);
    c += texture2D(iChannel0, uc + vec2(j, k) * d).a;
  }
  c /= 32.;

  float rc = r2 * 2. * it(time + 16.);
  float rl = mix(texture2D(iChannel0, uc + tu2 * 0.01).a, rc, smoothstep(0.5, 1., it(uv * 5.)));
  float rcl = mix(rc, rl, tl);

  vec2 ul = uc;
  vec2 um = uv * (0.001 + fract(time * 7.) * 0.002);
  float vi = 0.;
  int mv2 = int(mix(0., 30., tl));
  for(int k = 0; k < 30; k++){
    if(k >= mv2) break;
    float d2 = float(k) / float(mv2);
    ul -= um;
    vi = texture2D(iChannel0, ul).a;
    if(d2 > dot(vi, 1.)) break;
  }
  float vc = mix(c, mix(vi, c, pow(length(uv.y), 1.5)), tl);

  float ttr = smoothstep(0.3, 0.8, no(time * 0.7)) * 0.5;
  float trr = floor((sin(time * 0.25) * 0.5 + 0.5) * 10.) * 0.1 + 0.2;
  float tr = smoothstep(0.5 - ttr, 0.5 + ttr, mod(time, trr) / trr);

  // color element: hue shift (react) + grayscale toggle (visible)
  vec3 hue = 3. * abs(1. - 2. * fract(vc * 0.9 + 0.1 + 0.5 * tr + color_react * 0.3 + vec3(0., -1. / 3., 1. / 3.))) - 1.;
  vec3 r1 = mix(vec3(1.), hue, mix(0.15, 0.3, length(uv.y))) * vc;
  vec3 r3 = pow(r1, mix(vec3(0.5), vec3(1.5), length(uv.y)));
  vec3 r4 = mix(r3, 1. - r3, tr);
  r4 = mix(vec3(vc), r4, color_visible);

  vec4 rf = smoothstep(-0.1, 1.1, vec4(r4, rcl));
  fragColor = rf;
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture2D(iChannel0, uv);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const phantom: ShaderDef = {
  id: 'phantom',
  name: 'Phantom',
  description:
    'Spinning box-lattice drowning in frame-feedback trails and palette cycling. A feedback shader — try the camera Motion modes to re-frame the smear.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'structure',
      name: 'Lattice',
      description: 'The raymarched box geometry + its edge light. React drives the rim glow.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Core Glow',
      description: 'Volumetric glow bleeding from the inner cells. React drives intensity.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trails',
      name: 'Feedback Trails',
      description: 'Length / spread of the frame-feedback smear. React stretches the trails.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'color',
      name: 'Palette',
      description: 'Hue cycling. React shifts the palette; hide for grayscale.',
      defaultBand: 'high',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
