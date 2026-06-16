/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Pulsar" — a spinning spiky ball drifting through a warped tunnel, ringed by
 * rotating kaleidoscopic LASER beams (in the spirit of Mandala's light columns).
 *
 * Ported from a Shadertoy original. The original sampled an audio texture
 * (`megabass = texture(iChannel0, ...)`) to drive the spike length; here that
 * becomes the `ball` element's reactive value, so it's wired into the engine's
 * band / manual / MIDI system like everything else.
 *
 * The laser beams are the new addition: a 6-fold radial field accumulated as
 * volumetric glow along the ray (occluded by the geometry), rotating on the
 * BPM beat and coloured by the palette.
 *
 * Elements:
 *   ball   -> spike length of the central body (was the audio "megabass")
 *   lasers -> the rotating kaleidoscopic laser beams
 *   room   -> the surrounding warped tunnel (walls breathe with react)
 *   color  -> palette of the lasers (hue / grayscale)
 *   bloom  -> additive glow in the post pass
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

uniform float ball_react;
uniform float ball_visible;
uniform float lasers_react;
uniform float lasers_visible;
uniform float room_react;
uniform float room_visible;
uniform float color_react;
uniform float color_visible;

#define ITER 64.
#define PI 3.141592

float gLaser; // per-fragment laser glow accumulator

float hash21(vec2 x){ return fract(sin(dot(x, vec2(12.4, 14.1))) * 1245.4); }

vec2 moda(vec2 p, float per){
  float a = atan(p.y, p.x);
  float l = length(p);
  a = mod(a - per / 2., per) - per / 2.;
  return vec2(cos(a), sin(a)) * l;
}

mat2 rot(float a){ return mat2(cos(a), sin(a), -sin(a), cos(a)); }
float smin(float a, float b, float k){ float res = exp(-k * a) + exp(-k * b); return -log(res) / k; }
float sphe(vec3 p, float r){ return length(p) - r; }
float cyl(vec2 p, float r){ return length(p) - r; }

float needles(vec3 p){
  vec3 pp = p;
  // Original: l_needle = 0.8 - clamp(megabass, 0., 0.75), where megabass was a
  // RAW (hot) FFT bin near 1.0 on a kick. The engine's band is gated/normalised
  // and peaks lower, so we remap it through a smoothstep to reach the same
  // 0.8..0.05 range — spikes still only emerge past the sphere on strong hits.
  float drive = clamp(ball_react, 0., 1.0);
  float l_needle = 0.8 - 0.75 * smoothstep(0.05, 0.45, drive);

  p.xz = moda(p.xz, 2. * PI / 7.);
  float n1 = cyl(p.yz, 0.1 - p.x * l_needle);

  p = pp;
  p.y = abs(p.y);
  p.y -= 0.1;
  p.xz = moda(p.xz, 2. * PI / 7.);
  p.xy *= rot(PI / 4.5);
  float n2 = cyl(p.yz, 0.1 - p.x * l_needle);

  p = pp;
  float n3 = cyl(p.xz, 0.1 - abs(p.y) * l_needle);

  return min(n3, min(n2, n1));
}

float spikyball(vec3 p){
  p.y -= iTime;
  p.xz *= rot(iTime);
  p.yz *= rot(iTime * 0.5);
  float s = sphe(p, .9);
  return smin(s, needles(p), 5.);
}

float room(vec3 p){
  p += sin(p.yzx - cos(p.zxy));
  p += sin(p.yzx / 1.5 + cos(p.zxy) / 2.) * .5;
  return -length(p.xz) + 5. + room_react * 2.0; // walls breathe outward with react
}

// 6-fold radial laser field, centred on the body, spinning on the beat
float laserField(vec3 p){
  p.y -= iTime;
  p.xz *= rot(iTime * 2.0 + iBeat);
  p.xz = moda(p.xz, 2. * PI / 6.);
  return length(p.yz);
}

float SDF(vec3 p){
  float b = spikyball(p);
  if(ball_visible < 0.5) b = 1e5;
  float r = room(p);
  if(room_visible < 0.5) r = 1e5;
  return min(b, r);
}

vec3 palette(float t){
  return mix(vec3(1.), 3. * abs(1. - 2. * fract(t + vec3(0., -1. / 3., 1. / 3.))) - 1., 0.7);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  gLaser = 0.;
  vec2 uv = (2. * fragCoord - iResolution.xy) / iResolution.y;
  float dither = hash21(uv);

  vec3 ro = vec3(0.001, 0.001 + iTime + iCamHeight * 2., -3. * iCamDist);
  vec3 dir = normalize(vec3(uv, 60. / iCamFov));
  ro.xz *= rot(iCamOrbit);
  dir.xz *= rot(iCamOrbit);

  vec3 p = ro;
  float shad = 0.;
  float laserAmt = (0.012 + lasers_react * 0.05) * lasers_visible;

  for(float i = 0.; i < ITER; i++){
    float d = SDF(p);
    gLaser += laserAmt / (0.02 + laserField(p));
    if(d < 0.001){ shad = i / ITER; break; }
    d *= 0.9 + dither * 0.1;
    p += d * dir;
  }

  vec3 base = vec3(pow(shad, 1.5));
  float laser = clamp(gLaser * 0.05, 0., 4.);
  vec3 laserCol = palette(iTime * 0.2 + iBeat * 0.1 + color_react * 0.5) * laser;
  vec3 col = base + laserCol;
  col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, color_visible);

  fragColor = vec4(col, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float bloom_react;
uniform float bloom_visible;

vec3 bl(vec2 uv){
  vec2 r = iResolution.xy;
  vec3 col = vec3(0.);
  float spread = (2.0 + bloom_react * 5.0) / r.y;
  const int B = 3;
  for(int i = -B; i <= B; i++)
  for(int j = -B; j <= B; j++){
    col += texture2D(iChannel0, uv + vec2(float(i), float(j)) * spread).xyz;
  }
  return col / 49.;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec3 src = texture2D(iChannel0, uv).xyz;
  if(bloom_visible > 0.5) src += bl(uv) * 0.7 * (0.4 + bloom_react);
  fragColor = vec4(src, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const pulsar: ShaderDef = {
  id: 'pulsar',
  name: 'Pulsar',
  description:
    'A spinning spiky body drifting through a warped tunnel, ringed by rotating kaleidoscopic laser beams. The lasers spin on the BPM beat.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'ball',
      name: 'Spikes',
      description: 'Length of the body spikes (the original audio "megabass"). Bass drives them out.',
      defaultBand: 'low',
      defaultAmount: 1.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'lasers',
      name: 'Lasers',
      description: 'Rotating 6-fold laser beams. React drives their intensity + reach.',
      defaultBand: 'high',
      defaultAmount: 1.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'room',
      name: 'Tunnel',
      description: 'The surrounding warped tunnel. React pushes the walls outward.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'color',
      name: 'Palette',
      description: 'Laser hue cycling. React shifts the palette; hide for grayscale.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'Additive glow in the post pass. React drives spread.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
