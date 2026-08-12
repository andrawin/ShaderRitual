/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Shards" — a Machina variant with the softening removed: hard min() unions
 * instead of smin, a rotating octahedral fold, and no floor by default, so the
 * scene reads as suspended crystal rather than an interior. Violet on white.
 *
 * Same skeleton as Machina (see machina.ts), sharpened: the fold rotates every
 * iteration (breaking the axis alignment that makes Machina read as a room) and
 * the shards are unioned hard so edges stay crisp.
 *
 * Elements:
 *   folds  -> how deeply space folds (3..8)
 *   prism  -> the central crystal
 *   motes  -> the suspended debris lattice; hideable
 *   floor  -> a refractive floor; hidden by default
 *   speed  -> how fast the crystal turns
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

uniform float folds_react;
uniform float prism_react;
uniform float prism_visible;
uniform float motes_react;
uniform float motes_visible;
uniform float floor_react;
uniform float floor_visible;
uniform float speed_react;

#define rot(a) mat2(cos(a), sin(a), -sin(a), cos(a))

float rand(float x){ return fract(sin(x * 345.345) * 454.345345); }
float rand3(vec3 p){ return fract(sin(dot(p, p.yzx * 324.2344)) * 2342.234); }
vec3 rand33(vec3 p){ return fract(sin(p * 6234.324) * 567.5675); }

float c(float t, float s){
  t /= s;
  return mix(rand(floor(t)), rand(floor(t + 1.)), pow(smoothstep(0., 1., fract(t)), 10.));
}
float oct(vec3 p, float s){ p = abs(p); return (p.x + p.y + p.z - s) * 0.5773; }
float sb(vec3 p, vec3 s){ p = abs(p) - s; return max(max(p.y, p.z), p.x); }
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - pow(h, 3.) * k * (1.0 / 6.0);
}

bool hitGround = false;
float glowe, glowrep;

float map(vec3 p, float time){
  p.xz *= rot(time * 0.9);
  p.xy *= rot(cos(time) * 0.8);
  vec3 p0 = p;
  float tt = (c(time * 40., 60.5) * 4.);

  float sf = floor(clamp(3. + folds_react * 4.0, 3., 8.));
  vec3 p1 = p;
  for(int i = 0; i < 8; i++){
    if(float(i) >= sf) break;
    float fi = float(i);
    // Rotate every fold so nothing stays axis-aligned — this is what breaks
    // the "room" reading and leaves free-floating crystal instead.
    p1.xy *= rot(tt * .4 + fi * .9);
    p1.yz *= rot(cos(tt * .27) * 1.9 + fi * .6);
    p1 = abs(p1) - 4.5 - tt * 3.5;
  }

  float r = sin(tt + p1.x * .45) * sin(tt + p1.y * .31) * sin(tt + p1.z * .22);
  // Hard union of an octahedron and a box -> faceted shard.
  float d = min(oct(p1, 9. + r * 2.5), sb(p1, vec3(5.5 + r * 1.2)));

  float e1 = length(p0) - 9. - r * 3.5;
  if(prism_visible > 0.5) glowe += 4.5 / (1. + e1 * e1 * e1) * (1. + prism_react * 3.0);

  // Suspended motes on a coarse lattice.
  vec3 p2 = p0;
  float id = rand3(floor(p2 / 100. - .5));
  p2 /= 2.;
  p2.y += time * 25.;
  p2 = (fract(p2 / 70. - .5) - .5) * 70.;
  float e2 = length(p2) - 2.5 - id * 2.;
  if(motes_visible > 0.5) glowrep += 8. / (4. + e2 * e2) * (1. + motes_react * 2.0);

  float pisos = 1. - abs(p.y) + (99. + sin(p.y + tt) * sin(p.x + tt) * sin(p.z + time) - 3.) * .5;
  hitGround = floor_visible > 0.5 && pisos < 0.5;

  float shell = 1. - sb(p, vec3(200.));
  d = min(d, shell);
  if(motes_visible > 0.5) d = min(d, e2); // hard union keeps the motes crisp
  if(floor_visible > 0.5) d = min(d, pisos);
  if(prism_visible > 0.5) d = smin(e1, d, 3.);
  return d;
}

vec3 nm(vec3 p, float t){
  const vec2 e = vec2(0.01, 0.);
  return map(p, t) - normalize(vec3(map(p - e.xyy, t), map(p - e.yxy, t), map(p - e.yyx, t)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float time = mod(iTime * (0.7 + speed_react * 1.0), 10.) * .88;

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  float tt = c(time * 200., 100.) * .25;
  time -= rand(uv.y) * tt * .25;

  vec3 s = vec3(0.00001, .000001, -85. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(-uv, 1.));
  r.xz *= rot(iCamOrbit * 0.3);
  r.yz *= rot(iCamHeight * 0.3);

  vec3 p = s;
  vec3 col = vec3(0.);
  float dd = 0.;
  glowe = 0.;
  glowrep = 0.;

  for(float i = 0.; i < 64.; i++){
    float d = map(p, time);
    if(abs(d) < 0.001){
      if(hitGround){
        vec3 n = nm(p, time);
        r = refract(r, n, .001);
        d -= 100.;
      } else {
        break;
      }
    }
    p += d * r;
    dd += 200. / (10. + d * d * d);
  }

  vec3 n = nm(p, time);
  float ld = clamp(dot(n, r), 0., 1.);
  col -= ld;

  // Violet on white — high contrast, little midtone.
  vec3 baseColor = vec3(0.78, 0.55, 1.0);
  float dao = .88;
  float ao = clamp(map(p + n * dao, time), 0., 1.);
  float fres = pow(16. - ld, .5) * .45;
  float fog = 4. - max(length(p - s) / 400., 0.);
  col += dd * baseColor * .013;
  col += glowe * baseColor - vec3(0.6, 0.85, 0.45);
  col += (mix(vec3(fres), vec3(ao), glowrep * baseColor * .8));

  vec2 uv2 = p.xy * 6.;
  vec2 gid = fract(max(uv2, uv2.yx) + time * 24.);
  col *= vec3(gid.y * .55 + .45, gid.x * .4 + .3, 1.) * .85;

  col = pow(max(col, 0.), vec3(3.2)) * vec3(0.95, 0.8, 1.25) * .6;
  vec3 a = rand33(col / (1. + length(uv.yx)));
  vec3 b = rand33(col / (1. + length(uv)));
  vec3 cc = pow(smoothstep(vec3(0.), vec3(1.), fract(col)), vec3(20.));
  col *= mix(a, b, cc);
  col = smoothstep(0., 1., col) - length(uv) * 0.95;

  col *= ao * fres * fog;
  fragColor = sqrt(vec4(max(col, 0.), 1.0));
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

export const shards: ShaderDef = {
  id: 'shards',
  name: 'Shards',
  description:
    'Machina sharpened — rotating octahedral folds hard-unioned into suspended crystal, violet on white. No walls.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'folds',
      name: 'Folds',
      description: 'How deeply space folds (3–8). React recuts the crystal on the beat.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'prism',
      name: 'Prism',
      description: 'The central crystal. React flares it; hide to leave only shards.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'motes',
      name: 'Motes',
      description: 'Suspended debris drifting through. Hide for clean space.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'floor',
      name: 'Floor',
      description: 'A refractive floor. Off by default — turn it on to ground the crystal.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: false,
    },
    {
      id: 'speed',
      name: 'Turn',
      description: 'How fast the crystal turns. React spins it up.',
      defaultBand: 'low',
      defaultAmount: 0.9,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
