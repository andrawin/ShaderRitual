/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 4 — "Ember". A Pralina variant, and the abstract companion to Odyssey VI
 * (Cinder): the mass after it has burnt, with the fire still in it.
 *
 * Pralina's erosion lattice throws away the surface it cuts. Here that surface
 * is kept and lit: each subtracted sphere accumulates glow along the ray in
 * proportion to how near it passes, so the cuts read as heat showing through
 * from inside a shell that is otherwise almost black. The geometry is Pralina's
 * — the difference is entirely in what the loop does with the intermediate it
 * was already computing.
 *
 * Two additions:
 *   A crumbling skin. High-frequency sines eat into the outer surface as the
 *     fracture level rises, so the shell goes from smooth to spalled.
 *   An ember field. A drifting 3D point lattice accumulated as pure glow and
 *     never added to the distance — so it costs a length() per step and
 *     nothing in the march, which is why it can be dense.
 *
 * The body is graded almost to black before the glow is added, because heat
 * only reads as heat against something cold. Turning Fracture down gives a dark
 * mass with seams; turning it up opens it until the inside is most of the frame.
 *
 * Trimmed like the rest of the family: 7-deep lattice, 72-step march, 14 glow
 * samples at double spacing.
 *
 * Elements:
 *   crack  -> how far the fractures cut, and how much inside shows
 *   heat   -> how hot the interior burns
 *   sparks -> the drifting ember field; hideable
 *   slices -> the scan planes
 *   ash    -> cools and greys the whole thing toward spent cinder
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

uniform float crack_react;
uniform float heat_react;
uniform float sparks_react;
uniform float sparks_visible;
uniform float slices_react;
uniform float ash_react;
uniform float ash_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }
mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }
vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}

float map(vec3 p){
  vec3 bp = p;

  float t3 = time * 0.34;
  p.xz *= rot(t3 + sin(p.y * 0.3 + t3 * .7) * .5);
  p.xy *= rot(t3 + sin(p.z * .4 + t3 * .6) * .5);
  p.yz *= rot(t3 + sin(p.x * .2 + t3 * .8) * .5);

  float d = length(p) - 3.;
  float sd = 3. / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // The ember field. Pure glow — never min'd into d, so it costs nothing in
  // the march and can be as dense as it likes.
  if(sparks_visible > 0.5){
    vec3 ep = bp;
    ep.y -= time * 3.0;
    vec3 eid = repid(ep, vec3(4.0));
    vec3 e2 = repeat(ep, vec3(4.0)) + (rnd3(eid) - 0.5) * 2.4;
    float de = length(e2) - 0.05;
    aco += vec3(1.0, 0.40, 0.07)
         * (0.0025 + sparks_react * 0.006) / (0.02 + abs(de));
  }

  d *= 0.6;

  if(d < 0.1){
    float frac = clamp(crack_react, 0.0, 2.0);

    // A spalled skin: the surface crumbles as the fracture level climbs.
    d += sin(p.x * 7.3) * sin(p.y * 6.9) * sin(p.z * 7.7) * 0.035 * frac;

    float bite = 0.22 + frac * 0.16;
    float hot = 0.5 + heat_react * 1.4;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      float sph = length(p2) - ss * bite;
      // Pralina throws this surface away. Keep it, and the cut is a seam of
      // heat instead of an absence.
      // Small per iteration: this runs seven times per map() call and map()
      // runs on every march step, so a coefficient that looks right in
      // isolation integrates into a solid wall of fire.
      aco += vec3(1.0, 0.30, 0.05) * 0.0011 * hot / (0.06 + abs(sph));
      d = max(d, -sph);
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    vec3 p4 = repeat(p + time * 4., vec3(8));
    float s = 1. + slices_react * 1.2;
    float d4 = max(abs(p4.x) - 0.1, d);
    aco += vec3(1.9, 0.70, 0.18) * 0.016 * s / (0.15 + abs(d4));
    float d5 = max(abs(p4.y) - 0.1, d);
    aco += vec3(1.2, 0.35, 0.08) * 0.010 * s / (0.15 + abs(d5));
    d = min(d, min(d4, d5));
  }

  return d;
}

float gao(vec3 p, vec3 n, float s){ return clamp(map(p + n * s) / s, 0., 1.); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  time = mod(iTime * 0.5, 300.);
  aco = vec3(0.);

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  vec3 s = vec3(0, 0, -15.0);
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.2));

  float ct = time * 0.22 + iCamOrbit * 0.4;
  s.yz *= rot(ct * 0.8 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(ct * 0.8 + iCamHeight * 0.3);
  r.xz *= rot(ct);

  vec3 p = s;
  for(int i = 0; i < 72; ++i){
    float d = map(p);
    if(d < 0.001) break;
    if(d > 100.0) break;
    p += r * d;
  }

  float fog = 1. - clamp(length(p - s) / 100., 0., 1.);

  vec2 off = vec2(0.01, 0);
  vec3 n = normalize(map(p) - vec3(map(p - off.xyy), map(p - off.yxy), map(p - off.yyx)));

  float ao = gao(p, n, 0.35);
  ao *= gao(p, n, 1.0) * .5 + .5;

  // The body first, kept nearly black — heat only reads against something cold.
  vec3 body = vec3(0.0);
  for(float i = 1.; i < 15.; ++i){
    float dd = 0.2 * i;
    body += map(p + r * dd) * fog * 0.075 * vec3(0.45, 0.30, 0.26) * ao;
  }
  float fre = pow(1. - abs(dot(n, r)), 3.);
  body += fre * vec3(0.55, 0.30, 0.20) * 1.1 * (0.5 - 0.5 * n.y) * ao * fog;
  body += (1. - fog) * mix(vec3(0), vec3(0.10, 0.06, 0.05), pow(abs(r.x), 4.)) * 2.;

  float lum = dot(body, vec3(0.299, 0.587, 0.114));
  vec3 col = mix(body, vec3(lum) * vec3(0.55, 0.48, 0.46), 0.55) * 0.55;

  // Then the fire, on top and undimmed.
  col += aco * 0.95;

  // Ash cools it toward spent cinder and drops the last of the colour.
  if(ash_visible > 0.5){
    float a = clamp(ash_react, 0.0, 2.0) * 0.5;
    float l2 = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(l2) * vec3(0.88, 0.86, 0.90), a);
    col *= 1.0 - a * 0.25;
  }

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

export const ember: ShaderDef = {
  id: 'ember',
  name: 'Core — Ember',
  description:
    'A Pralina variant that keeps the surface its erosion cuts and lights it: a near-black shell with heat showing through the seams, drifting embers around it. The abstract companion to Odyssey VI.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'crack',
      name: 'Fracture',
      description:
        'How far the seams cut, and how much of the inside shows. Also spalls the outer skin. Low is a dark mass with hairlines; high opens it until the fire is most of the frame.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'heat',
      name: 'Heat',
      description:
        'How hot the interior burns through the seams. This is the one to put on the kick — it lights the whole mass from inside without moving anything.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      defaultLevel: 0.35,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sparks',
      name: 'Embers',
      description:
        'The drifting ember field. Pure glow, never part of the geometry, so it is nearly free — run it dense. Hide for the mass alone.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes working through the mass, here burning rather than scanning.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'ash',
      name: 'Ash',
      description:
        'Cools the whole thing toward spent cinder and takes the last of the colour out. Ride it up to end a set. Hide to keep it burning.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
