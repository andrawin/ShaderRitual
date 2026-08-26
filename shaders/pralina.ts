/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Pralina" — an eroded kaleidoscopic core: a cross-shaped mass carved out by
 * repeated sphere subtractions, ringed by expanding shells and flanked by
 * writhing vertical tubes, with slicing scan-planes lighting it from inside.
 *
 * Adapted from a shader coded live at the Inercia Shader Royale 2020 (1st
 * place). The original's compile-time toggles (rainbow / symmetry / post-fx)
 * become audio elements, and its rainbow channel-rotation becomes a Tint
 * element that runs from black-and-white through red and purple to the full
 * rotating palette.
 *
 * Elements:
 *   core    -> the eroded central mass (erosion depth)
 *   rings   -> expanding shell pulses; hideable
 *   tubes   -> the writhing vertical tubes; hideable
 *   slices  -> the scan-planes cutting through the mass
 *   tint    -> 0 = black & white, sweeping up through red / purple / rainbow
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

uniform float core_react;
uniform float rings_react;
uniform float rings_visible;
uniform float tubes_react;
uniform float tubes_visible;
uniform float slices_react;
uniform float tint_react;
uniform float tint_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }

mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }

vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}
float rnd1(float t){ return fract(sin(t * 457.588) * 942.512); }

float tick(float t, float d){
  t /= d;
  return (floor(t) + pow(smoothstep(0., 1., fract(t)), 10.)) * d;
}
float curve(float t, float d){
  t /= d;
  return mix(rnd1(floor(t)), rnd1(floor(t) + 1.), pow(smoothstep(0., 1., fract(t)), 10.));
}

float map(vec3 p){
  vec3 bp = p;

  float t3 = time * 0.4;
  p.xz *= rot(t3 + sin(p.y * 0.3 + t3 * .7) * .5);
  p.xy *= rot(t3 + sin(p.z * .4 + t3 * .6) * .5);
  p.yz *= rot(t3 + sin(p.x * .2 + t3 * .8) * .5);

  float d = length(p) - 3.;

  float sd = 3. / length(p);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // Expanding shells.
  if(rings_visible > 0.5){
    float an = pow(fract(time * 0.5), 2.);
    float ep = 0.2 - an * 0.1 - d * 0.05;
    float d3 = max(abs(length(p) - an * 20. - 3.) - ep, 0.1);
    aco += vec3(0.8, 0.5, 1.) * (0.004 + rings_react * 0.006) / (0.05 + abs(d3));
    d = min(d, d3);
  }

  // Writhing vertical tubes.
  if(tubes_visible > 0.5){
    vec3 p6 = bp;
    p6.xz = abs(p6.xz);
    if(p6.z > p6.x) p6.xz = p6.zx;
    p6.x -= 22.;
    p6.z = abs(p6.z) - 6. - sin(bp.y * .03 + time) * 5. - sin(bp.y * .1 + time) * 10.;
    p6.z = abs(p6.z) - 3. - sin(bp.y * .07 + time) * 5. - sin(bp.y * .2 + time * 1.3) * 4.;
    float d7 = max(length(p6.xz) - 1., 0.2);
    d = min(d, d7);
    aco += vec3(0.8, 0.5, 1.) * (0.008 + tubes_react * 0.01) * exp(fract(-time * 2.)) / (0.05 + abs(d7));
  }

  d *= 0.7;
  p.x += tick(time, 1.) * 4.;

  if(d < 0.1){
    // Erosion: subtract a lattice of spheres, deeper as the band rises.
    float bite = 0.3 + core_react * 0.18;
    for(float i = 1.; i < 11.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      d = max(d, -(length(p2) - ss * bite));
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    // Scan-planes slicing the mass.
    vec3 p4 = repeat(p + time * 4., vec3(8));
    float s = 1. + slices_react * 1.2;
    float d4 = max(abs(p4.x) - 0.1, d);
    aco += vec3(0.4, 0.5, 1.9) * 0.026 * s / (0.15 + abs(d4));
    float d5 = max(abs(p4.y) - 0.1, d);
    aco += vec3(0.8, 0.5, 0.4) * 0.016 * s / (0.15 + abs(d5));
    d = min(d, min(d4, d5));
  }

  return d;
}

float gao(vec3 p, vec3 n, float s){ return clamp(map(p + n * s) / s, 0., 1.); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  time = mod(iTime * 0.5, 300.);
  float pulse = floor(time * 0.5);
  aco = vec3(0.);

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  // The original's symmetry / pixel-crush passes, kept as time-driven flourishes.
  float alpha = 1.0;
  float gd = 10. + curve(time, 0.1) * 50.;
  float se = curve(time - length(uv) * 0.5, 0.15);
  if(se > 0.6){
    vec2 tmp = smoothstep(0.8, 0.9, fract(uv * gd));
    uv = floor(uv * gd) / gd;
    alpha = mix(1., max(tmp.x, tmp.y) * .5 + .5, se);
  }
  uv.y += pow(curve(time, 0.3), 2.0) * 0.2;
  uv *= 1.0 + curve(time - length(uv), 0.3) * .3;
  if(curve(time, 2.0) > 0.6) uv = abs(uv);

  vec3 s = vec3(0, 0, -6. - curve(pulse, 0.5) * 10.);
  s.x += (curve(pulse, 0.4) - .5) * 8.;
  s.y += (curve(pulse, 0.7) - .5) * 8.;
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1. + sin(time * curve(pulse, 0.3) * 2.0) * .5));

  // Camera: the original's tumble, offset by the rig.
  float ct = time * 0.3 + curve(pulse, 0.6) * 27.3 + iCamOrbit * 0.4;
  s.yz *= rot(ct * 0.7 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(ct * 0.7 + iCamHeight * 0.3);
  r.xz *= rot(ct);

  vec3 p = s;
  for(int i = 0; i < 100; ++i){
    float d = map(p);
    if(d < 0.001) break;
    if(d > 100.0) break;
    p += r * d;
  }

  float fog = 1. - clamp(length(p - s) / 100., 0., 1.);
  vec3 col = aco * .9;

  vec2 off = vec2(0.01, 0);
  vec3 n = normalize(map(p) - vec3(map(p - off.xyy), map(p - off.yxy), map(p - off.yyx)));

  float ao = gao(p, n, 0.3);
  ao *= gao(p, n, 0.6) * .5 + .5;
  ao *= gao(p, n, 1.2) * .5 + .5;

  for(float i = 1.; i < 30.; ++i){
    float dd = 0.1 * i;
    col += map(p + r * dd) * fog * 0.06 * vec3(dd + 0.3, 0.6, 0.9 + dd * .3) * ao;
  }

  float fre = pow(1. - abs(dot(n, r)), 3.);
  col += fre * vec3(1, .5, .7) * 1.4 * (0.5 - 0.5 * n.y) * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.5, 0.6, 0.7), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.7, 0.6, 0.3), pow(abs(r.z), 4.)) * 2.;

  // Tint: hidden -> black & white; otherwise the value sweeps the palette from
  // red through purple into the original's full channel-rotating rainbow.
  if(tint_visible < 0.5){
    col = vec3(dot(col, vec3(0.299, 0.587, 0.114)));
  } else {
    float k = clamp(tint_react, 0., 2.);
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    // 0..1 : grey -> red -> purple. 1..2 : blend into the rotating rainbow.
    vec3 warm = mix(vec3(lum) * vec3(1.6, 0.35, 0.35), vec3(lum) * vec3(1.2, 0.35, 1.5),
                    smoothstep(0.35, 1.0, k));
    float t5 = time * .3;
    vec3 rb = col;
    rb.xz *= rot(t5);
    rb.xy *= rot(t5 * .7);
    rb = abs(rb);
    col = mix(mix(vec3(lum), warm, smoothstep(0.0, 0.35, k)), rb, smoothstep(1.0, 1.8, k));
  }

  col *= alpha;
  col *= 1.2 - length(uv);
  fragColor = vec4(max(col, 0.), 1.0);
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

export const pralina: ShaderDef = {
  id: 'pralina',
  name: 'Pralina',
  description:
    'An eroded kaleidoscopic core ringed by expanding shells and writhing tubes, sliced by scan-planes. Tint runs from black & white to full rainbow.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'core',
      name: 'Erosion',
      description: 'How deeply the lattice of spheres carves into the central mass.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'rings',
      name: 'Shells',
      description: 'Expanding shell pulses. React brightens them; hide to remove.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tubes',
      name: 'Tubes',
      description: 'The writhing vertical tubes flanking the core. Hide for the core alone.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes slicing through the mass and lighting it from inside.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description:
        'Palette: hide for black & white. Level 0 grey, ~0.5 red, ~1 purple, 1.5+ the full rotating rainbow.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 1.6,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
