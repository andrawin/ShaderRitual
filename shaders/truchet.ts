/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Truchet" — a flight through a 3D multi-scale truchet lattice (octtree
 * truchet): interlocking pipe arcs at mixed cell sizes, rendered as soft
 * accumulated fog.
 *
 * Adapted from flockaroo's golfed Shadertoy original ("3D generalization of
 * multi-scale truchets"). De-golfed for GLSL-ES 1.00: the `mat2(cos(vec4(...)))`
 * rotation trick becomes a real rotation, the comma-operator loops become
 * explicit loops with breaks, and the swizzle-assignment axis cycling is
 * spelled out.
 *
 * Elements:
 *   drift -> extra travel along the flight path
 *   warp  -> the wobble distortion of the lattice
 *   glow  -> fog brightness
 *   tint  -> iridescent tint over the grayscale fog (hideable)
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

uniform float drift_react;
uniform float warp_react;
uniform float glow_react;
uniform float tint_react;
uniform float tint_visible;

mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

// The golfed R(p) macro: cos(p/.1 + p.zxy*11. + p.yzx*13.)
vec3 Rf(vec3 p){ return cos(p*10. + p.zxy*11. + p.yzx*13.); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float t = iTime;
  vec2 F = fragCoord;
  vec3 R = iResolution;

  // Ray direction; fov zooms, orbit/height roll and tilt the flight.
  vec3 d = vec3((F+F-R.xy)/R.x, -.7*(60./iCamFov)*max(iCamDist, 0.3));
  d.yz *= rot(t*.2 + iCamHeight*.5);
  d.xy *= rot(t*.07 + iCamOrbit*.3);

  // Flight path (drift element pushes further along it).
  vec3 p = vec3(7., 2., 1.)*(t + drift_react*4.)/100.;

  float x = 0.; // accumulated fog (doubles as the march distance /3)
  for(int i = 0; i < 200; i++){
    vec3 P = p + d*x*3.;
    P += Rf(.3*P)*.05*(1. + warp_react*1.5); // element: lattice warp

    float l;
    float D = 1e3;
    float s = 2.;
    vec3 q = vec3(0.);
    vec3 r = vec3(1.); // > .5 so the octree descent always starts

    // Octree descent: subdivide up to 4 times, stopping on the cell hash.
    for(int k = 0; k < 4; k++){
      if(r.x <= .5) break;
      s *= .5;
      q = floor(P/s);
      r = Rf(s*q);
    }

    P = (P/s - q - .5)*sign(r);
    s *= 8.;

    // Three pipe arcs, cycling the axes between each.
    for(int k = 0; k < 3; k++){
      l = length(P.xy+.5)*s;
      D = min(D, length(.5-vec2(min(ceil(l), s)-l, fract(P.z*s+.5*s)))/s);
      vec3 tp = P;
      P = vec3(tp.y, tp.z, tp.x); // P.zxy = P
      P.z *= -1.;
      P.x *= -1.;
    }

    x += D*s*.025 - 4e-4;
  }

  // element: glow (0.75 manual level = original brightness at rest)
  float g = clamp(x*(0.45 + glow_react*0.75), 0., 1.4);
  vec3 col = vec3(g);
  if(tint_visible > 0.5){
    // element: iridescent tint, hue pushed by the band
    col = g*(1. + .3*cos(6.28318*(g*.6 + tint_react*.4 + vec3(0., .33, .67))));
  }
  fragColor = vec4(clamp(col, 0., 1.), 1.);
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

export const truchet: ShaderDef = {
  id: 'truchet',
  name: 'Truchet',
  description:
    'A flight through a 3D multi-scale truchet lattice — interlocking pipes at mixed scales as soft accumulated fog.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'drift',
      name: 'Drift',
      description: 'Extra travel along the flight path. Wire to Low to surge forward on hits.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'warp',
      name: 'Warp',
      description: 'Wobble distortion of the lattice. React bends the pipes.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Fog brightness. The manual level sets the resting exposure.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.75,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description: 'Iridescent tint over the fog. React shifts the hue; hide for grayscale.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
