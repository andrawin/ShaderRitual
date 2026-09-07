/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Polyframe" — a tunnel of polyhedral wireframe: space is folded five times
 * against a mirror plane to build the symmetry of a solid, then a hairline tube
 * is traced through it and accumulated as glow, with the depth axis wrapped in
 * a log so the frames telescope away forever.
 *
 * Adapted from a compact Shadertoy original. Its "frame" is decided by two
 * things — the normal the fold mirrors against (which solid the symmetry comes
 * from) and which axis-pair the tube is measured on. The original hard-coded a
 * dodecahedral normal and left the second tube axis commented out; both are now
 * a Frame element that steps through five combinations.
 *
 * Ported to GLSL-ES 1.00: the original's for-loop declared three variables in
 * its init clause and did its accumulation in the increment clause, neither of
 * which is legal here, so the loop is spelled out; the log of the depth axis is
 * guarded against non-positive input.
 *
 * Elements:
 *   frame -> which wireframe solid (level 0..2 steps through five)
 *   glow  -> brightness of the accumulated tube
 *   depth -> how fast the frames telescope toward you
 *   spin  -> rotation of the whole lattice
 *   tint  -> palette; hide for white wireframe
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

uniform float frame_react;
uniform float glow_react;
uniform float depth_react;
uniform float spin_react;
uniform float tint_react;
uniform float tint_visible;

/* Rotate p about unit axis a by angle r (the original's R macro). */
vec3 rotAxis(vec3 p, vec3 a, float r){
  return mix(a * dot(p, a), p, cos(r)) + sin(r) * cross(p, a);
}
/* Cheap cosine palette (the original's H macro). */
vec3 pal(float h){ return cos(h * 6.3 + vec3(0.0, 23.0, 21.0)) * 0.5 + 0.5; }

mat2 rot2(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

/*
 * The mirror plane the fold reflects against — this is what decides which
 * solid's symmetry the wireframe inherits.
 *   0,1 : golden-ratio normal -> dodecahedral / icosahedral
 *   2   : octahedral
 *   3   : tetrahedral
 *   4   : a second icosahedral plane, giving a denser cage
 */
vec3 foldNormal(float sel){
  if(sel < 1.5) return vec3(-0.5, -0.809, 0.309);
  if(sel < 2.5) return normalize(vec3(-1.0, -1.0, 0.0));
  if(sel < 3.5) return normalize(vec3(-1.0, -1.0, -1.0));
  return normalize(vec3(-0.357, -0.934, 0.0));
}

/* Which axis-pair the hairline tube is measured on — the other half of the
 * frame's character, and the line the original left commented out. */
float tubeDist(vec3 p, float sel, float rad){
  if(sel < 0.5) return length(p.yz) - rad;   // original
  if(sel < 1.5) return length(p.xz) - rad;   // the commented alternative
  if(sel < 2.5) return length(p.yz) - rad;
  if(sel < 3.5) return length(p.xy) - rad;
  return length(p.xz) - rad;
}

void mainImage(out vec4 O, vec2 C){
  O = vec4(0.0);

  vec3 r = iResolution;
  vec2 uv = (C - 0.5 * r.xy) / r.y;
  uv *= (iCamFov / 60.0);
  vec3 d = normalize(vec3(uv, 1.0));
  d.xz *= rot2(iCamOrbit * 0.35);
  d.yz *= rot2(iCamHeight * 0.35);

  // Level 0..2 steps through the five frames; assign a band to flip on a hit.
  float sel = floor(clamp(frame_react, 0.0, 1.99) * 2.51);
  vec3 n = foldNormal(sel);

  float spin = iTime * (0.5 + spin_react * 1.2);
  float scroll = iTime * (0.5 + depth_react * 1.4);
  float bright = 0.05 * (0.6 + glow_react * 1.4);
  float dist = 10.0 * max(iCamDist, 0.35);

  vec3 p = vec3(0.0);
  float e = 0.0;
  float g = 0.0;

  // The original declared i/e/g together in the init clause and accumulated in
  // the increment clause; ES 1.00 allows neither, so it is written out.
  for(float i = 1.0; i < 99.0; i++){
    p = g * d;
    p.z -= dist;
    p = rotAxis(p, normalize(vec3(1.0, 2.0, 2.0)), spin);

    for(int j = 0; j < 5; j++){
      p.xy = abs(p.xy);
      p -= 2.0 * min(0.0, dot(p, n)) * n;
    }

    // Guarded: log of a non-positive depth would poison the march with NaN.
    p.z = fract(log(max(p.z, 1e-4)) - scroll) - 0.5;

    e = tubeDist(p, sel, 0.01);
    g += e;

    vec3 c = tint_visible > 0.5
      ? mix(vec3(1.0), pal(dot(p, p) * 0.5 + tint_react * 0.5), 0.7)
      : vec3(1.0);
    O.xyz += c * bright * exp(-0.05 * i * i * max(e, 0.0));
  }

  O = vec4(clamp(O.xyz, 0.0, 1.0), 1.0);
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

export const polyframe: ShaderDef = {
  id: 'polyframe',
  name: 'Polyframe',
  description:
    'A telescoping tunnel of polyhedral wireframe — folded symmetry traced as hairline tubes and accumulated as glow. The frame solid is selectable.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'frame',
      name: 'Frame',
      description:
        'Which wireframe solid. Level steps through five: 0 dodecahedron, 0.4 dodecahedron (alt edges), 0.8 octahedron, 1.2 tetrahedron, 1.6 icosahedron. Assign a band to flip frames on a hit.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Brightness of the accumulated wireframe. React flares it on hits.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'depth',
      name: 'Depth',
      description: 'How fast the frames telescope toward you.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'spin',
      name: 'Spin',
      description: 'Rotation of the whole lattice.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description: 'Palette across the wireframe. React sweeps the hue; hide for a white frame.',
      defaultBand: 'high',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
