/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Chrome" — a twisting reflective metal ribbon (chain of capsules) over a
 * floor, with glowing nodes, iridescent tinting and a variable motion blur.
 *
 * Adapted from a Shadertoy original. Buffer A raymarches the chrome (with one
 * reflection bounce) and writes a per-pixel blur radius into alpha; the Image
 * pass reads that and blurs accordingly. Ported to GLSL-ES 1.00 (constant-bound
 * blur loop, texture() -> texture2D(), dropped unused helpers).
 *
 * Elements:
 *   flow  -> the ribbon's animation / twist           (drives the chain phase)
 *   nodes -> the glowing sphere nodes                  (size + hideable)
 *   color -> iridescent palette                        (hue + grayscale toggle)
 *   blur  -> motion-blur amount (post pass)            (scale + hideable)
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

uniform float flow_react;
uniform float nodes_react;
uniform float nodes_visible;
uniform float color_react;
uniform float color_visible;

float hs(vec3 p){ return fract(sin(dot(p, vec3(45., 956., 124.))) * 7845.236); }
float no(vec2 p){
  vec2 f = floor(p); p = smoothstep(0., 1., fract(p));
  vec2 se = vec2(45., 457.); vec2 v1 = dot(f, se) + vec2(0., se.y);
  vec2 v2 = mix(fract(sin(v1) * 4587.236), fract(sin(v1 + se.x) * 4587.236), p.x);
  return mix(v2.x, v2.y, p.y);
}
float it(vec2 p){ float r = 0.; float a = 0.5; for(int i = 0; i < 4; i++){ r += no(p / a) * a; a *= 0.5; } return r; }
mat2 rot(float t){ float c = cos(t); float s = sin(t); return mat2(c, -s, s, c); }
float cap(vec3 u, vec3 a, vec3 b){
  vec3 ua = u - a; vec3 ba = b - a;
  float h = clamp(dot(ua, ba) / dot(ba, ba), 0., 1.);
  return length(ua - ba * h);
}
float smin(float d1, float d2, float k){
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0., 1.);
  return mix(d2, d1, h) - k * h * (1. - h);
}

float zb = 0.;

float map(vec3 p){
  vec3 ps = p;
  float l1 = 100.;
  vec3 bs = vec3(0., -3.5, 0.);
  float ta = mix(1.5, .3, smoothstep(0., 8., abs(p.y)));
  float ft = fract(iTime * 0.5);
  float t = sin(sin(iTime * 0.1) * 0.1 * pow(mix(ft, 1. - ft, step(0.5, fract(iTime * 0.25))), 1.5)) * sin(iTime * 0.1) * 180.;
  t += flow_react * 40.; // element: ribbon flow
  p.xy *= rot(p.y * sin(iTime) * 0.2);
  p.xz *= rot(p.y * sin(iTime + 0.5) * 0.2);
  vec3 p2 = p; vec3 p3 = p;
  float l2 = 1000.; float l3 = 1000.;
  p2.xz *= rot(3.14);
  for(int i = 0; i < 5; i++){
    float ip = float(i);
    vec3 v0 = vec3(sin(ip - 1. + t), sin(ip - 1. + t), cos(ip - 1. + t) * 0.5) * 2.;
    vec3 v1 = vec3(sin(ip + t), sin(ip + t), cos(ip + t) * 0.5) * 2.;
    bs += vec3(0., 1.5, 0.);
    v0 += bs - vec3(0., 0.75, 0.);
    v1 += bs + vec3(0., 0.75, 0.);
    l1 = min(l1, cap(p, v0, v1) - ta);
    l1 = min(l1, cap(p2, v0, v1) - ta * 0.5);
    l1 = min(l1, cap(p3, v0, v1) - ta * 0.25);
    l3 = min(l3, length(ps + v0 * vec3(2., 1., 2.)) - (0.3 + nodes_react * 0.25));
  }
  if(nodes_visible < 0.5) l3 = 1000.;
  zb = 1.;
  float r1 = min(l1, l2);
  float r2 = r1 - hs(p) * 0.003;
  float r3 = min(r2, l3);
  float s = dot(ps, vec3(0., 1., 0.)) + 4.;
  if(r2 < min(s, l3)){ zb = 0.; }
  return min(r3, s);
}
float map2(vec3 p){ return dot(p, vec3(0., 1., 0.)) + 4.; }
vec3 nor(vec3 p){ vec2 e = vec2(0.01, 0.); return normalize(map(p) - vec3(map(p - e.xyy), map(p - e.yxy), map(p - e.yyx))); }

float ev(vec3 r, float blr){
  return smoothstep(0.5 + blr, 0.5, pow(length(r.x - r.z), -smoothstep(0., 1.8, length(r.y - 0.2)) * 0.51 + 0.8))
       * smoothstep(0.5 + blr, 0.5, pow(length(r.y - 0.2), -smoothstep(0., 2., length(r.x - r.z)) * 0.51 + 0.8));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = -1. + 2. * fragCoord / iResolution.xy;
  uv.x *= iResolution.x / iResolution.y;
  float time = iTime;

  vec3 p = vec3(0., -1. + iCamHeight, -7. * iCamDist);
  vec3 r = normalize(vec3(uv, 60. / iCamFov));
  r.xz *= rot(sin(time) * 0.1);
  r.zy *= rot(cos(time) * 0.1);
  p.xz *= rot(iCamOrbit);
  r.xz *= rot(iCamOrbit);

  vec3 p2 = p; vec3 r2 = r;
  float dd = 0.;
  float ref = 1.;
  vec3 n = vec3(0.);
  float mf = zb;
  float mf2 = 0.;
  const float md = 12.;
  for(int i = 0; i < 48; i++){
    float d = map(p);
    if(dd > md){ dd = md; break; }
    if(d < 0.001){
      mf = zb;
      ref *= mf;
      n = nor(p);
      if(ref < 0.01){ break; }
      mf2 = zb;
      r = reflect(r, n);
      d = 0.01;
    }
    p += r * d;
    dd += d;
  }

  float dd2 = 0.;
  for(int j = 0; j < 7; j++){
    float d2 = map2(p2);
    if(d2 < 0.01){ break; }
    p2 += r2 * d2;
    dd2 += d2;
  }

  vec2 e = vec2(0.01, 0.);
  vec2 pt = p2.xz * 1.5;
  float tex = smoothstep(0.3, 0.7, it(pt));
  float tex2 = smoothstep(0.3, 0.7, it(pt + e.xy));
  float tex3 = smoothstep(0.3, 0.7, it(pt + e.yx));
  vec3 tn = normalize(vec3(tex - tex2, 0.2, tex - tex3));
  vec3 n2 = n + tn * mf2;
  float s = smoothstep(md - 1., 7., dd);
  float s2 = smoothstep(md - 1., 7., dd2);
  float s3 = max(s, s2);
  float dao = 0.2;
  float ao = max(mix(0.8, 1., clamp(map(p + n2 * dao) / dao, 0., 1.)), 0.);
  float dss = 1.5;
  float ss = clamp(map(p + r * dss) / dss, 0., 1.) * (1. - mf);
  float dr = clamp(dot(n2, -r2), 0., 1.);
  float fres = pow(1. - dr, 0.5);
  float spec = pow(dr, 10.);
  float spec2 = pow(dr, 100.);
  float vaf = (1. - mf) * (1. - mf2 * 0.5);
  float vt = step(0.5, fract(time * 5.));
  float va2 = ev(r, 0.01) * vt;
  float va3 = mix(-1., dot(n, vec3(1., 0., 1.)), vt);
  float sat = mix(0., mix(0.2, 0., ao) + mix(0.05, 0.2, smoothstep(-4., 5., p.y + p.z * 0.5)) + ss * 0.1 + ss * 0.05, vaf) * 0.8 + (-1. * va3) * 0.13;
  float val = mix(va2 * 0.5, mix(0.9, 0.4, smoothstep(-4., 5., p.y + p.z * 0.5)) + mix(-0.15, 0.1, va3), vaf) * ao + fres * 0.2 + (spec2 * 0.1 + spec * 0.1) * (1. - mf) + ss * 0.2 + clamp(va3, 0., 1.) * 0.5;
  float hue = clamp(p.y * -0.09 * (1. - mf) + 0.8 + mix(0.1, 0., ao), 0.6, 1.) + mf * 0.3;
  vec3 c1 = mix(vec3(1.), 3. * abs(1. - 2. * fract(hue + color_react * 0.3 + vec3(0., -1. / 3., 1. / 3.))) - 1., sat) * val;
  c1 = mix(vec3(val), c1, color_visible); // grayscale toggle
  vec3 c2 = mix(vec3(va2), c1, s3);
  c2 = clamp(c2, 0., 1.);
  float m = mf2 * mix(0.0001, 0.0009, 1. - tex) * mix(0., 1., length(uv.y)) * 8. + (pow(length(uv.y), 2.) * 0.002 + 0.0001) * (1080. / iResolution.y);
  fragColor = vec4(c2, m);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float blur_react;
uniform float blur_visible;

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  float m = texture2D(iChannel0, uv).a * (1.0 + blur_react * 2.0);
  if(blur_visible < 0.5) m = 0.;
  vec3 c = vec3(0.);
  for(int ii = 0; ii < 9; ii++)
  for(int jj = 0; jj < 9; jj++){
    float i = float(ii) - 4.;
    float j = float(jj) - 4.;
    c += texture2D(iChannel0, uv + vec2(i, j) * m).xyz;
  }
  c /= 81.;
  c = clamp(c, 0., 1.);
  fragColor = vec4(c, 0.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const chrome: ShaderDef = {
  id: 'chrome',
  name: 'Chrome',
  description:
    'A twisting reflective chrome ribbon over a floor, with glowing nodes, iridescent tints and a variable motion blur.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'flow',
      name: 'Ribbon Flow',
      description: 'The ribbon\'s twist / animation. React pushes the flow.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'nodes',
      name: 'Nodes',
      description: 'Glowing sphere nodes along the ribbon. React swells them.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'color',
      name: 'Iridescence',
      description: 'Palette tint. React shifts the hue; hide for chrome/grayscale.',
      defaultBand: 'high',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'blur',
      name: 'Motion Blur',
      description: 'Per-pixel motion blur in the post pass. React deepens it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
