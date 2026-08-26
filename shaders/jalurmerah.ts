/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Jalur Merah" — a flight down a twelve-fold mirrored shaft: girders and
 * filament wires repeat around the axis while a pulsing conduit runs through
 * the centre, banded rings sweeping along it.
 *
 * Adapted from a Shadertoy original. Ported to GLSL-ES 1.00 — the original
 * took its normal from screen-space derivatives (dFdx/dFdy), unavailable
 * here, so the normal comes from the SDF gradient instead, which is also
 * smoother. The march gains an early exit, and the red-dominant palette the
 * shader is named for is an element rather than a code edit.
 *
 * Elements:
 *   grid    -> the repeating girder cells
 *   wires   -> the filament wires threading the shaft; hideable
 *   conduit -> the pulsing central conduit; hideable
 *   bands   -> the rings sweeping along the conduit
 *   tint    -> shown = red-dominant; hidden = the original cool palette
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

uniform float grid_react;
uniform float wires_react;
uniform float wires_visible;
uniform float conduit_react;
uniform float conduit_visible;
uniform float bands_react;
uniform float tint_react;
uniform float tint_visible;

float PI = 3.14159265;

mat2 genRot(float v){ return mat2(cos(v), -sin(v), sin(v), cos(v)); }

vec2 pMod(vec2 p, float c){
  p *= genRot(PI / c);
  float at = atan(p.y / p.x);
  at = mod(at, 2. * PI / c);
  float r = length(p);
  p = vec2(r * cos(at), r * sin(at));
  p *= genRot(-PI / c);
  return p;
}

float cube(vec3 a){ a = abs(a); return max(a.x, max(a.y, a.z)); }

float map(vec3 p){
  vec3 q = p;
  p.xy = pMod(p.xy, 12.);
  p.xy = (fract(p.xy / 1.5 + .5) - .5) * 1.5;
  p.z = fract(p.z + .5) - .5;

  // Girder cells — the band swells them.
  float sp = cube(p - vec3(0.5, 0., 0.)) - (0.05 + grid_react * 0.035);

  if(wires_visible > 0.5){
    float w = 0.015 + wires_react * 0.012;
    float fi = length(p.xz - vec2(0.5, 0.)) - w + 0.01 * floor(sin(p.y * 6. * PI + iTime));
    fi = min(fi, length(p.yz) - w + 0.01 * floor(sin(p.x * 6. * PI + iTime)));
    fi = min(fi, length(p.xy - vec2(0.5, 0.)) - w + 0.01 * floor(sin(p.z * 6. * PI - iTime * 2.)));
    fi = max(fi, -(length(q.xy) - 0.5));
    sp = min(sp, fi);
  }

  if(conduit_visible > 0.5){
    float con = length(q.xy) -
      (0.2 + conduit_react * 0.12 + 0.1 * cos(iTime) * sin(atan(q.y / q.x) * 2. + q.z * PI + iTime * 2.));
    sp = min(sp, con);
  }
  return sp;
}

/** SDF gradient normal — replaces the original's dFdx/dFdy flat normal. */
vec3 getNormal(vec3 p){
  vec2 e = vec2(0.002, 0.);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

vec3 cam(){
  vec3 c = vec3(0., 0., -1.5);
  c += vec3(cos(iTime / 2.), sin(iTime / 2.), iTime * PI / 4.);
  c.xy *= 1. + .5 * smoothstep(0., 1., sin(iTime));
  c.xy *= max(iCamDist, 0.4);
  return c;
}

vec3 ray(vec2 uv, float z){
  vec3 r = normalize(vec3(uv, z));
  r.yz *= genRot(-PI / 3. + iCamHeight * 0.3);
  r.xy *= genRot(PI / 3.);
  r.xy *= genRot(iTime / 2. + iCamOrbit * 0.4);
  return r;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = (fragCoord * 2. - iResolution.xy) / iResolution.x;
  uv *= (iCamFov / 60.);

  vec3 o = cam();
  vec3 r = ray(uv, 1.5);

  vec3 p = o;
  float t = 0.;
  for(int i = 0; i < 128; i++){
    p = o + r * t;
    float d = map(p);
    t += d * 0.5;
    if(d < 0.0008) break;
    if(t > 40.) break;
  }
  vec3 n = getNormal(p);

  float rim = 1. - dot(r, n);
  vec3 bc = vec3(rim);

  float at = atan(p.y / p.x) * 2.;
  vec3 cc = cos(p) * 0.5 + 0.5;
  // Bands sweeping along the conduit.
  float bandSpeed = 2. + bands_react * 3.;
  bool lit = length(p.xy) < 0.4 ||
    (fract(p.z + 0.1) < 0.2 && fract(length(p.xy) - iTime * bandSpeed + at) < 0.4);
  cc = lit ? cc * (1. + bands_react * 0.8) : vec3(0.);
  bc += cc;

  float fog = 1. / (1. + t * t * 0.1);
  bc = mix(bc, vec3(0.), 1. - fog);

  // Tint: shown -> red-dominant (the shader's namesake); hidden -> original.
  if(tint_visible > 0.5){
    float lum = dot(bc, vec3(0.299, 0.587, 0.114));
    float k = clamp(0.5 + tint_react * 0.6, 0., 1.5);
    vec3 red = vec3(lum * 1.7, lum * 0.22, lum * 0.16) + bc * vec3(0.35, 0.02, 0.05);
    bc = mix(bc, red, clamp(k, 0., 1.));
  }

  fragColor = vec4(clamp(bc, 0., 1.), 1.0);
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

export const jalurmerah: ShaderDef = {
  id: 'jalurmerah',
  name: 'Jalur Merah',
  description:
    'A flight down a twelve-fold mirrored shaft — repeating girders, filament wires and a pulsing conduit with rings sweeping along it.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'grid',
      name: 'Girders',
      description: 'The repeating girder cells. React swells them.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'wires',
      name: 'Wires',
      description: 'Filament wires threading the shaft. Hide for bare girders.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'conduit',
      name: 'Conduit',
      description: 'The pulsing central conduit. React swells it; hide to open the shaft.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bands',
      name: 'Bands',
      description: 'Rings sweeping along the conduit. React drives them faster and brighter.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Red',
      description: 'Shown = red-dominant palette. Hide for the original cool tones.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
