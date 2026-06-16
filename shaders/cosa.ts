/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Cosa" — a raymarched lattice of grids, glowing cells and 12-fold radial
 * beams, smeared by frame feedback and colour-cycled.
 *
 * Single-buffer feedback shader (reads its own previous frame via iChannel0).
 * Ported from a GLSL-ES 3.00 Shadertoy original to GLSL-ES 1.00:
 *   - texture() -> texture2D()
 *   - the dynamic float blur loop rewritten to constant int bounds
 *   - native spin overlaid with the global camera rig.
 *
 * Elements:
 *   structure -> the grid lattice lines
 *   glow      -> the cell glow + radial beams
 *   trails    -> frame-feedback persistence
 *   color     -> palette cycling (hue / grayscale)
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

float hs(vec2 p){ return fract(sin(dot((p), vec2(45., 269.))) * 7845.236 + iTime * 10.); }
float rd(vec3 p){ return fract(sin(dot(floor(p), vec3(45., 65., 269.))) * 7845.236); }
mat2 rot(float t){ float c = cos(t); float s = sin(t); return mat2(c, -s, s, c); }
float bl(vec2 p, vec2 b){ vec2 q = abs(p) - b; return length(max(vec2(0.), q)) + min(0., max(q.x, q.y)); }
float box(vec3 p, vec3 b){ vec3 q = abs(p) - b; return length(max(vec3(0.), q)) + min(0., max(q.x, max(q.z, q.y))); }

float zl1; float zl2; float bl2; float zl3; float bl3;

float map(vec3 p, vec3 tm){
  vec3 pb = p;
  vec3 pc = p;
  pc.xy *= rot(tm.y);
  vec3 pnc = pc;
  vec3 pn = p;
  vec3 pl = p;
  p = abs(p);
  p -= 1.;
  if(p.x > p.y) p.xy = p.yx;
  if(p.x > p.z) p.xz = p.zx;
  vec3 p2 = p;
  vec3 rp1 = vec3(2.);
  p = mod(p, rp1) - 0.5 * rp1;
  vec3 rp2 = vec3(4.);
  p2 = mod(p2, rp2) - 0.5 * rp2;
  float d1 = bl(p.zy, vec2(0.2));
  float d2 = bl(pn.xz, vec2(5.));
  float d4 = bl(p2.xz, vec2(0.1));
  float dl = min(d1, d4);
  float d3 = max(min(d1, d4), -d2);
  zl1 = max(d4, -d2);
  pc = abs(pc);
  pc += 3.;
  if(pc.x < pc.y) pc.xy = pc.yx;
  if(pc.y < pc.z) pc.yz = pc.zy;
  vec3 pc2 = pc;
  vec3 rc1 = vec3(0.1, 0.3, 0.55);
  pc = mod(pc, rc1) - 0.5 * rc1;
  vec3 rc2 = vec3(0.005, 0.3, 0.2 + fract(iTime * 0.1));
  pc2 = mod(pc2, rc2) - 0.5 * rc2;
  float c1 = box(pc, vec3(0.1));
  float c2 = min(box(pnc, vec3(2.5, 0.2, 0.5)), box(pnc, vec3(0.5, 5., 0.5)));
  float c4 = box(pc2, vec3(0.02));
  float c5 = min(length(pn) - tm.z * 2.5, length(pc) - tm.z * 0.2);
  float c3 = max(max(min(c1, c4), c2), -c5);
  float cl = min(max(c4, c2), length(pn) - tm.z * 2.5);
  zl2 = cl;
  float fl2 = 0.01;
  bl2 += fl2 / (fl2 + cl);
  float r2 = min(d3, c3);
  pb += vec3(0., -5., 0.);
  vec3 pb2 = pb;
  vec3 pb3 = pb;
  float ft = 6.38 / 12.;
  float at = mod(atan(pb.y, pb.x) + 0.5 * ft, ft) - 0.5 * ft;
  pb.xy = vec2(cos(at), sin(at)) * length(pb.xy);
  float at2 = mod(atan(pb2.y, pb2.z) + 0.5 * ft, ft) - 0.5 * ft;
  pb2.zy = vec2(cos(at2), sin(at2)) * length(pb2.zy);
  float at3 = mod(atan(pb3.z, pb3.x) + 0.5 * ft, ft) - 0.5 * ft;
  pb3.xz = vec2(cos(at3), sin(at3)) * length(pb3.xz);
  float b1 = box(pb - vec3(2.5, 0., 0.), vec3(tm.x, 0.02, 0.02));
  float b2 = box(pb2 - vec3(0., 0., 2.5), vec3(0.02, 0.02, tm.x));
  float b3 = box(pb3 - vec3(2.5, 0., 0.), vec3(tm.x, 0.02, 0.02));
  float b5 = length(pn) - tm.z * 5.;
  float b4 = max(min(min(b1, b3), b2), -pn.y + 5.);
  float fl3 = 0.01;
  bl3 += fl3 / (fl3 + b4);
  zl3 = b4;
  float r3 = min(r2, b4);
  return r3;
}
vec3 nor(vec3 p, vec3 tm){
  vec2 e = vec2(0.01, 0.);
  return normalize(map(p, tm) - vec3(map(p - e.xyy, tm), map(p - e.yxy, tm), map(p - e.yyx, tm)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  bl2 = 0.; bl3 = 0.; // per-fragment glow accumulators
  float time = iTime;
  vec2 uv = fragCoord / iResolution.xy;
  vec2 uc = uv;
  uv -= 0.5;
  uv *= 2.;
  uv.x *= iResolution.x / iResolution.y;

  float t1 = pow(sin(time * 0.5) * 0.5 + 0.5, 10.);
  vec3 p = vec3(0., t1 * 20. * sin(time * 0.25) + 3. + iCamHeight * 5., -5. * iCamDist);
  float tmx = mod(time * 5., floor(fract(time * 0.1) * 10.) / 10. + 0.1) * 1.1;
  vec3 r = normalize(vec3(uv, 60. / iCamFov));

  float tmy = mix(pow(fract(time * 0.1), 0.1), pow(1. - fract(time * 0.1), 10.), step(0.5, fract(time * 0.05))) * 3.14;
  float tmz = smoothstep(0.5, 1., fract(time * 0.05));
  vec3 tm = vec3(tmx, tmy, tmz);
  p.xz *= rot(time + iCamOrbit);
  r.xz *= rot(time + iCamOrbit);
  r.zy *= rot(t1 * 2.);

  float dd = 0.;
  for(int i = 0; i < 48; i++){
    float d = map(p, tm);
    if(dd > 40.){ break; }
    if(d < 0.01){ break; }
    p += r * d;
    dd += d;
  }

  vec3 n = nor(p, tm);
  float tex = rd(p * 70.);
  float s = smoothstep(40., 0., dd);
  float dn = smoothstep(0., 2., length(p.y)) * smoothstep(0., 2., length(p.x)) * smoothstep(0., 2., length(p.z));
  float ml = distance(0.5, fract(p.x * 0.1 + time * 2.));
  float l1 = smoothstep(2., 0., zl1) * 0.2 + smoothstep(3., 0., zl1) * 0.1 * smoothstep(0., 0.5, ml);
  l1 += smoothstep(1., 0., zl1) * 2. * smoothstep(0.25, 0.26, ml);
  l1 *= dn;
  l1 *= structure_visible * (1.0 + structure_react * 2.0);

  float l2 = smoothstep(0.05, 0., zl2) * 2. + bl2 * 0.05;
  float l3 = smoothstep(0.05, 0., zl3) * 2. + bl3 * 0.5;
  float glowK = glow_visible * (1.0 + glow_react * 2.0);
  l2 *= glowK; l3 *= glowK;

  float ld = clamp(dot(n, -r), 0., 1.);
  float ao = 1.3;
  float fres = pow(1. - ld, 3. + tex * 6.) * 0.1;
  float spec = pow(ld, 5. + tex * 10.) * 0.2;
  float bsz = 0.5 * sqrt(24.);
  float c = 0.;
  float dpix = pow(length(uv.y), 2.) * 0.004 + 0.0004;
  float r0 = ((fres + spec) * ao + l1 + l2 + l3) * s + mix(-0.05, 0.05, hs(uv));
  for(int j = 0; j < 6; j++)
  for(int k = 0; k < 6; k++){
    vec2 off = vec2(-bsz + float(j), -bsz + float(k));
    c += texture2D(iChannel0, uc + off * dpix).a;
  }
  c /= 24.;

  float tr = step(0.7, fract(time * 0.3));
  vec3 r1 = mix(vec3(1.), 3. * abs(1. - 2. * fract(c * 0.4 + mix(0.4, 0.85, tr) + color_react * 0.3 + vec3(0., -1. / 3., 1. / 3.))) - 1., mix(0.3, 0.8, tr) + mix(0.2, 0., ao)) * c * 1.1;
  vec3 rc = pow(r1, mix(vec3(0.55, 0.8, 0.7), vec3(1.2), length(uv.y)));
  rc = mix(vec3(c * 1.1), rc, color_visible);

  // trails element adds optional feedback persistence on top of the 1-frame echo
  float aOut = clamp(r0 + c * trails_visible * trails_react * 0.6, 0., 1.);
  fragColor = vec4(rc, aOut);
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

export const cosa: ShaderDef = {
  id: 'cosa',
  name: 'Cosa',
  description:
    'Raymarched lattice of grids, glowing cells and 12-fold radial beams, smeared by frame feedback. Single-buffer feedback shader.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'structure',
      name: 'Lattice',
      description: 'The grid lattice lines. React drives their brightness.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Cells & Beams',
      description: 'Glowing cells + 12-fold radial beams. React drives intensity.',
      defaultBand: 'low',
      defaultAmount: 1.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trails',
      name: 'Feedback Trails',
      description: 'Extra frame-feedback persistence. React lengthens the smear.',
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
