/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 7 — "Wrath". A Pralina variant with the temper taken off it.
 *
 * Everything Pralina does is soft in the geometric sense: it subtracts spheres,
 * which leaves rounded pits, and it tumbles on smooth sines. Two inversions and
 * it has teeth.
 *
 *   Facets, not weathering. The core is intersected with a stack of hashed
 *     half-spaces, so it is cut flat and left with hard edges instead of being
 *     rounded off. That is the difference between a rock that has weathered and
 *     one that has been broken.
 *   Spikes, not pits. The erosion lattice is unioned on as octahedra rather
 *     than subtracted as spheres — the same cells, coming out as points instead
 *     of dents.
 *
 * The motion is snapped rather than smooth: tick() holds the rotation still and
 * then slams it to the next position, and the camera takes Pralina's hashed
 * jump-cuts, which the calmer variants in this family dropped. This is the one
 * that should look like it is hitting something.
 *
 * Plane normals come from a hash, so they can land arbitrarily close to zero —
 * a bare normalize() there is a NaN waiting to happen, and one NaN in a
 * distance field takes the whole pixel. The divisor is floored instead, which
 * shortens the vector rather than exploding it, and a short normal
 * under-reports the distance, which is the safe direction for an intersection.
 *
 * Strobe is a brightness pulse between a third and full, not a black frame.
 * A hard on/off gate at these rates is a photosensitivity risk on a projector,
 * and it defaults to 0 regardless.
 *
 * Elements:
 *   spike  -> length of the spikes driven out of the mass
 *   facet  -> how many planes the core is cut with, 3 to 10
 *   strobe -> a brightness pulse on the whole frame; off by default
 *   slices -> the scan planes, narrow and hot
 *   rage   -> palette, dull iron through to arterial red
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

uniform float spike_react;
uniform float facet_react;
uniform float strobe_react;
uniform float slices_react;
uniform float rage_react;
uniform float rage_visible;

float time;
vec3 aco;

vec3 repeat(vec3 p, vec3 s){ return (fract(p / s + .5) - .5) * s; }
vec3 repid(vec3 p, vec3 s){ return floor(p / s + .5); }
mat2 rot(float a){ float ca = cos(a); float sa = sin(a); return mat2(ca, sa, -sa, ca); }
vec3 rnd3(vec3 p){
  return fract(sin(p * 452.512 + p.yzx * 847.512 + p.zxy * 245.577) * 512.844);
}
float rnd1(float t){ return fract(sin(t * 457.588) * 942.512); }

/* Holds, then slams to the next value. Pralina's, and the reason this one
 * moves in hits rather than drifting. */
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
  float t3 = tick(time * 1.6, 0.5);
  p.xz *= rot(t3 * 0.50);
  p.xy *= rot(t3 * 0.37);

  float d = length(p) - 3.0;

  // Cut flat with hashed planes.
  float nf = 3.0 + floor(clamp(facet_react, 0.0, 2.0) * 3.6);
  for(float i = 1.; i < 11.; ++i){
    if(i > nf) break;
    vec3 rr = rnd3(vec3(i * 3.1, 7.0, 2.0)) * 2.0 - 1.0;
    // Floored, not normalized: the hash can land near zero and normalize()
    // would return NaN. Dividing by max(len, 0.3) can only shorten the vector,
    // and a short normal under-reports, which is safe under max().
    vec3 nr = rr / max(length(rr), 0.3);
    d = max(d, dot(p, nr) - (1.55 + rnd3(vec3(i, 5.0, 9.0)).x * 1.10));
  }

  float sd = 3. / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  d *= 0.5;

  // Generous gate: the spikes stand well off the surface, and anything the
  // gate closes on early gets marched straight through.
  if(d < 1.4){
    float sp = 0.14 + spike_react * 0.26;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      vec3 a2 = abs(p2);
      // Octahedra, unioned. Pralina's spheres, subtracted, leave pits; these
      // leave points.
      //
      // Bounded to a shell around the core. Subtraction can only touch material
      // that is already there, so Pralina needs no bound; a union runs over the
      // whole infinite lattice and fills space, and without this the camera
      // ends up inside a room of shards rather than looking at a mass.
      //
      // The bound is lumpy on purpose. A plain sphere clips the shards to a
      // perfect circle and the whole thing reads as a decal; three cheap sines
      // break the silhouette without costing a noise lookup.
      float oc = (a2.x + a2.y + a2.z) * 0.5773 - ss * sp * 0.45;
      float bnd = 5.4 + sin(bp.x * 0.62) * sin(bp.y * 0.55) * sin(bp.z * 0.70) * 0.9;
      d = min(d, max(oc, length(bp) - bnd));
      p.xz *= rot(0.9);
      p.yz *= rot(1.2);
    }

    vec3 p4 = repeat(p + time * 7., vec3(6));
    float s = 1. + slices_react * 1.5;
    float d4 = max(abs(p4.x) - 0.05, d);
    aco += vec3(2.0, 0.22, 0.10) * 0.012 * s / (0.04 + abs(d4));
    float d5 = max(abs(p4.z) - 0.05, d);
    aco += vec3(1.4, 0.85, 0.65) * 0.007 * s / (0.04 + abs(d5));
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

  // Pralina's hashed jump-cuts, which the calm variants dropped.
  float pulse = floor(time * 1.2);
  vec3 s = vec3(0, 0, -14.0 - curve(pulse, 0.5) * 5.0);
  s.x += (curve(pulse, 0.4) - .5) * 5.;
  s.y += (curve(pulse, 0.7) - .5) * 5.;
  s.z *= max(iCamDist, 0.4);
  vec3 r = normalize(vec3(-uv, 1.15));

  float ct = time * 0.35 + curve(pulse, 0.6) * 27.3 + iCamOrbit * 0.4;
  s.yz *= rot(ct * 0.55 + iCamHeight * 0.3);
  s.xz *= rot(ct);
  r.yz *= rot(ct * 0.55 + iCamHeight * 0.3);
  r.xz *= rot(ct);

  vec3 p = s;
  for(int i = 0; i < 72; ++i){
    float d = map(p);
    if(d < 0.001) break;
    if(d > 100.0) break;
    p += r * d;
  }

  float fog = 1. - clamp(length(p - s) / 100., 0., 1.);
  vec3 col = aco * .9;

  vec2 off = vec2(0.01, 0);
  vec3 n = normalize(map(p) - vec3(map(p - off.xyy), map(p - off.yxy), map(p - off.yyx)));

  float ao = gao(p, n, 0.35);
  ao *= gao(p, n, 1.0) * .5 + .5;
  ao = 0.20 + 0.80 * ao;

  for(float i = 1.; i < 15.; ++i){
    float dd = 0.2 * i;
    col += map(p + r * dd) * fog * 0.022 * vec3(1.0 + dd * .2, 0.28, 0.20) * ao;
  }

  // Key rides with the camera, so the faces turned toward us stay lit through
  // the tumble. Hard specular: the facets are the point, and they need
  // something to catch.
  vec3 lig = normalize(-r + vec3(0.40, 0.70, 0.0));
  float dif = clamp(dot(n, lig), 0., 1.);
  float spe = pow(clamp(dot(reflect(-lig, n), -r), 0., 1.), 60.);
  col += vec3(1.30, 0.26, 0.16) * dif * ao * fog * 0.95;
  col += vec3(0.40, 0.12, 0.10) * (0.35 + 0.65 * clamp(dot(n, -r), 0., 1.)) * ao * fog * 0.45;
  col += vec3(1.00, 0.80, 0.68) * spe * fog * 1.5;

  float fre = pow(1. - abs(dot(n, r)), 6.);
  col += fre * vec3(1.60, 0.55, 0.35) * 1.5 * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.22, 0.05, 0.04), pow(abs(r.x), 4.)) * 2.;

  // Dull iron, driven to arterial red, with white only where it is hottest.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if(rage_visible < 0.5){
    col = vec3(lum);
  } else {
    float k = clamp(rage_react, 0., 2.);
    vec3 iron  = vec3(lum) * vec3(1.10, 0.72, 0.62);
    vec3 blood = vec3(lum) * vec3(1.80, 0.20, 0.14);
    col = mix(col, mix(iron, blood, smoothstep(0.0, 1.3, k)), 0.85);
    col += vec3(1.0, 0.92, 0.85) * pow(clamp(lum - 0.55, 0., 1.), 2.) * (0.4 + k * 0.8);
  }

  // A pulse between a third and full, never a black frame.
  float sb = clamp(strobe_react, 0., 1.);
  col *= mix(1.0, 0.35 + 0.65 * step(0.5, fract(time * (3.0 + strobe_react * 9.0))), sb);

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

export const wrath: ShaderDef = {
  id: 'wrath',
  name: 'Core — Wrath',
  description:
    'A Pralina variant with teeth: the core cut flat by hashed planes instead of weathered round, the lattice driven out as spikes instead of pits, and the whole thing moving in hits rather than drifting.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'spike',
      name: 'Spikes',
      description:
        'Length of the spikes driven out of the mass. Pralina subtracts this lattice as spheres and gets pits; these are octahedra, unioned on, and come out as points.',
      defaultBand: 'mid',
      defaultAmount: 1.2,
      defaultLevel: 0.45,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'facet',
      name: 'Facets',
      description:
        'How many planes the core is cut with, 3 to 10. This is what makes it read as broken rather than weathered — put it on a band and the mass re-cuts itself on every hit.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'strobe',
      name: 'Strobe',
      description:
        'A brightness pulse on the whole frame, between a third and full — not a black frame, because a hard gate at these rates is a photosensitivity risk on a projector. Off at 0, which is the default. Raise it only where you know the room.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes cutting through the mass, narrower and hotter than the rest of the family.',
      defaultBand: 'high',
      defaultAmount: 1.2,
      defaultLevel: 0.35,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'rage',
      name: 'Rage',
      description:
        'Palette: 0 dull iron, 1.3+ arterial red, with white breaking through wherever it is hottest. Hide for black and white.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 1.1,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
