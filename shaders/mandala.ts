/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Mandala" — a kaleidoscopic raymarched orb wrapped in light columns, frame
 * feedback and a palette strobe.
 *
 * This is a TWO-BUFFER + feedback shader:
 *   - Buffer B renders a tiling FBM noise texture (static), exposed to Buffer A
 *     as iChannel1 (repeat-wrapped) — it drives the surface displacement, the
 *     reflection environment and the pseudo-random "signal" reads.
 *   - Buffer A is the raymarcher; it samples its own previous frame via
 *     iChannel0 (alpha) for the trails.
 *
 * Ported from a GLSL-ES 3.00 Shadertoy original to the engine's GLSL-ES 1.00
 * pipeline (texture() -> texture2D(); dynamic loop bound -> constant + break;
 * native camera spin overlaid with the global camera rig).
 *
 * Elements:
 *   surface -> brightness of the lit geometry
 *   glow    -> the orbiting light + kaleidoscopic columns
 *   trails  -> frame-feedback persistence
 *   color   -> palette strobe (hue shift / grayscale toggle)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float surface_react;
uniform float surface_visible;
uniform float glow_react;
uniform float glow_visible;
uniform float trails_react;
uniform float trails_visible;
uniform float color_react;
uniform float color_visible;

float hs(vec3 p){ return fract(sin(dot(p, vec3(45., 95., 123.))) * 7845.236); }
mat2 rot(float t){ float c = cos(t); float s = sin(t); return mat2(c, -s, s, c); }
float box(vec3 p, vec3 b){
  vec3 q = abs(p) - b;
  return length(max(q, vec3(0.))) + min(0., max(q.x, max(q.y, q.z)));
}
float smin(float a, float b, float t){
  float h = clamp(0.5 + 0.5 * (b - a) / t, 0., 1.);
  return mix(b, a, h) - t * h * (1. - h);
}
float segd(vec3 p, vec3 a, vec3 b){
  vec3 pa = p - a; vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h);
}

float l1; float zl;

float map(vec3 p){
  vec3 pc = p; vec3 pl = p; vec3 pb = p;
  float tn1 = 0.02; float tn2 = 0.4;
  float nn = ((texture2D(iChannel1, p.xy * tn1 + 23.).x + texture2D(iChannel1, p.zy * tn1 + 435.).x + texture2D(iChannel1, p.xz * tn1 + 512.).x) - 0.7) * 2.;
  nn += ((texture2D(iChannel1, p.xy * tn2 + 296.).x + texture2D(iChannel1, p.zy * tn2).x + texture2D(iChannel1, p.xz * tn2 + 125.).x) - 1.) * 0.2;
  float v1 = pow(texture2D(iChannel1, vec2(0.5, iTime)).x, 1.5) * 10.;
  float d1 = length(p * vec3(1., 0.8, 1.)) - 2. - nn;
  pc.xy *= rot(0.8);
  pc.xz *= rot(0.8);
  float d2 = box(pc, vec3(1.6)) - nn;
  float d3 = smin(d1, d2, 0.2);
  float tj = step(0.75, fract(iTime * 0.4));
  float tm4 = iTime * 2.;
  float d4 = length(p + vec3(cos(tm4), sin(iTime * 2.), sin(tm4)) * 2.7);
  float ta = 6.28 / 3.;
  float a = atan(pl.x, pl.z);
  float at = mod(a + 0.5 * ta, ta) - 0.5 * ta;
  pl.xz = vec2(cos(at), sin(at)) * length(pl.xz);
  pl.y = distance(fract(pl.y), 0.5);
  float d6 = max(segd(pl, vec3(3., 0., -100.), vec3(3., 0., 100.)), (length(p.y + 0.5) - v1));
  l1 = mix(d4, d6 * 2., tj);
  float fzl = 0.003;
  zl += fzl / (fzl + mix(d4, d6, tj));
  pb.xz *= rot(iTime);
  float d7 = mix((distance(0.5, fract(pb.y)) * 2.) - 0.5, 1000., step(0.3, fract(iTime)));
  float d5 = min(max(max(d3, -(d3 + 0.1)), -d7), mix(d4 - 0.3, d6 - 0.03, tj));
  return d5;
}
float ev(vec3 r){
  float v1 = smoothstep(0., 1., texture2D(iChannel1, vec2(0.2, iTime)).x);
  return pow(smoothstep(0.15, 0.95, texture2D(iChannel1, r.xz * 0.1).x), v1) * smoothstep(2., 0., length(r.y));
}
vec3 nor(vec3 p){
  vec2 e = vec2(0.01, 0.);
  return normalize(map(p) - vec3(map(p - e.xyy), map(p - e.yxy), map(p - e.yyx)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  zl = 0.; // feedback glow accumulates per-fragment; start clean
  float v1 = texture2D(iChannel1, vec2(0.51, iTime * 0.4)).x;
  vec2 uv = fragCoord / iResolution.xy;
  vec2 uc = uv;
  uv -= 0.5;
  uv *= 2.;
  uv.x *= iResolution.x / iResolution.y;

  // camera: native double-spin overlaid with the global rig
  vec3 p = vec3(0., iCamHeight * 3., (-4. - v1 * 3.) * iCamDist);
  float focal = 60.0 / iCamFov;
  vec3 r = normalize(vec3(uv, focal));
  float tt = iTime + iCamOrbit; float tt2 = iTime * 0.5;
  p.xz *= rot(tt); r.xz *= rot(tt);
  p.xy *= rot(tt2); r.xy *= rot(tt2);

  float dd = 0.; float dm = 10.;
  for(int i = 0; i < 64; i++){
    float d = map(p);
    if(dd > dm){ dd = dm; break; }
    if(d < 0.001){ break; }
    p += r * d;
    dd += d;
  }

  float ti1 = step(0.5, fract(iTime * 5.));
  float ti2 = step(0.1, fract(iTime));
  float s = smoothstep(dm, 5., dd);
  vec3 n = nor(p);
  float dao = 1.;
  float ao = clamp(map(p + n * dao) / dao, 0., 1.);
  float ld = clamp(dot(n, -r), 0., 1.);
  float br = hs(p * 0.1);
  float sp = pow(ld, 5. + br * 5.) * 0.5 + pow(ld, 30. + br * 30.) * 0.2 * br;
  float fr = pow(1. - ld, 0.4 + br * 0.4) * 0.2 + pow(1. - ld, 1. + br) * 0.2 * br;
  float r0 = pow(ev(reflect(n, r)), 1. + br * 0.7);
  r0 += sp * 0.2;
  r0 += fr * 0.2;
  r0 *= ao;
  r0 *= (1.0 + surface_react * 1.5); // surface element

  float li = smoothstep(5., 0., l1);
  float dss = 2.5;
  float ss = clamp(map(p + r * dss) / dss, 0., 1.);
  float li2 = pow(li, mix(1.5, 0.5, ss));
  li2 *= ti1;
  li2 *= glow_visible * (1.0 + glow_react * 1.5); // glow element

  float r1 = pow(clamp(mix(ev(r), r0, s), 0., 1.), 1. + ti2 * 5.);
  r1 += li2 * s * (ti2);
  r1 += zl * glow_visible * (1.0 + glow_react * 2.0);

  float c = 0.;
  for(int i = -1; i <= 1; i++)
  for(int j = -1; j <= 1; j++){
    c += texture2D(iChannel0, uc + vec2(i, j) / iResolution.xy).a;
  }
  c /= 9.;

  // trails element: feedback persistence
  float fb = trails_visible * clamp(0.5 + trails_react * 0.3, 0., 0.95);
  r1 = clamp(mix(r1, c, fb), 0., 1.);

  // color element: palette strobe + grayscale toggle
  vec3 hue = 3. * abs(1. - 2. * fract(iTime * 32. + color_react * 0.5 + vec3(0., -1. / 3., 1. / 3.))) - 1.;
  vec3 rc = mix(vec3(1.), hue, 0.3) * r1 * 1.5;
  rc = mix(vec3(r1 * 1.5), rc, color_visible);

  fragColor = vec4(rc, r1);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const bufferBShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

// simulation of a tiling noise texture
float no(vec2 p, float scale){
  p *= scale;
  vec2 f = floor(p); p = smoothstep(0., 1., fract(p));
  vec2 se = vec2(284., 26.); vec2 v1 = dot(se, f) + vec2(0., se.y);
  vec2 v2 = mix(fract(sin(mod(v1, scale)) * 7845.236), fract(sin(mod(v1 + se.x, scale)) * 7845.236), p.x);
  return mix(v2.x, v2.y, p.y);
}
float it(in vec2 p, float tt){
  float r = 0.0; float scale = 5.; p = mod(p, scale);
  float a = 0.5;
  for(int i = 0; i < 9; i++){
    if(float(i) >= tt) break;
    r += no(p, scale) * a; a *= 0.5; scale *= 2.;
  }
  return r;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  float t1 = it(uv, 9.);
  fragColor = vec4(t1);
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

export const mandala: ShaderDef = {
  id: 'mandala',
  name: 'Mandala',
  description:
    'Kaleidoscopic raymarched orb with light columns, frame-feedback trails and a palette strobe. Uses a tiling-noise helper buffer (Buffer B).',
  bufferShader,
  bufferBShader,
  imageShader,
  elements: [
    {
      id: 'surface',
      name: 'Surface',
      description: 'Brightness of the lit, displaced geometry. React boosts it.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Light Columns',
      description: 'The orbiting light + kaleidoscopic beams. React drives intensity.',
      defaultBand: 'low',
      defaultAmount: 1.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trails',
      name: 'Feedback Trails',
      description: 'Frame-feedback persistence. React lengthens the smear.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'color',
      name: 'Palette',
      description: 'Hue strobe. React shifts the palette; hide for grayscale.',
      defaultBand: 'high',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
