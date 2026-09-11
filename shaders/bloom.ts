/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * CORE 5 — "Bloom". A Pralina variant, and the abstract companion to Odyssey II
 * (Revelry): the mass at its most alive.
 *
 * Pralina's core is a cross — three tubes on the three axes, and that is all
 * the symmetry it has. Here the space is folded into an n-sector wedge before
 * the distance is taken, so those three tubes come back out as however many
 * petals the fold has sectors. Folding the space rather than adding geometry
 * means the petal count costs nothing: 4 petals and 13 petals are the same
 * shader doing the same work.
 *
 * Two more changes:
 *   The erosion scallops rather than bites. The subtracted sphere is scaled
 *     along the radius before it is measured, so each cut is an elongated
 *     scoop running outward — it reads as the edge of a petal instead of a
 *     bite out of a rock.
 *   Pollen. A drifting point lattice accumulated as pure glow and never added
 *     to the distance, so it costs nothing in the march.
 *
 * A polar fold puts a seam at every sector boundary where the field stops
 * being a true distance, so the march takes a heavier safety factor — at
 * Pralina's 0.7 the seams tear open.
 *
 * Trimmed like the rest of the family: 7-deep lattice, 72-step march, 14 glow
 * samples at double spacing.
 *
 * Elements:
 *   petal  -> how many sectors the fold has, 4 to 13
 *   core   -> depth of the scalloping
 *   pollen -> the drifting motes; hideable
 *   slices -> the scan planes
 *   tint   -> grey, through hot pink, into the full rotating rainbow
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

uniform float petal_react;
uniform float core_react;
uniform float pollen_react;
uniform float pollen_visible;
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

float map(vec3 p){
  vec3 bp = p;

  // Spin about the flower's own axis and give it a slow nod, but leave the
  // axis itself alone. The fold builds a ring of petals around y, and a rosette
  // only reads as one when you can see its face — Pralina's second rotation
  // tumbles the axis, which shows the ring edge-on half the time.
  float t3 = time * 0.30;
  p.xz *= rot(t3 + sin(p.y * 0.3 + t3 * .7) * .5);
  p.yz *= rot(sin(t3 * 0.5) * 0.22);

  // The fold. Three tubes become as many petals as there are sectors, and it
  // costs the same whether that is four or thirteen.
  float n = 4.0 + floor(clamp(petal_react, 0.0, 2.0) * 4.6);
  float rad = length(p.xz);
  if(rad > 1e-4){
    float sec = 6.28318 / n;
    float a = mod(atan(p.z, p.x) + sec * 0.5, sec) - sec * 0.5;
    p.x = cos(a) * rad;
    p.z = sin(a) * rad;
  }

  float d = length(p) - 2.8;
  float sd = 2.8 / max(length(p), 0.001);
  d = min(d, length(p.xz) - sd);
  d = min(d, length(p.xy) - sd);
  d = min(d, length(p.yz) - sd);

  // A petal, sitting out along the sector axis. The fold alone is not enough:
  // Pralina's tubes are length(p.xz) and friends, which are already
  // rotationally symmetric, so folding them changes almost nothing. This is a
  // shape that only exists on the axis, so the fold makes n copies of it.
  //
  // Measured in the L1 norm rather than L2 — an ellipsoid has no edge anywhere
  // on it, so it reads as a lozenge however it is lit. This has a point at the
  // tip, a ridge down the spine and a crease at the base: places for light to
  // break, which is the whole difference between a petal and a blob.
  vec3 pl = abs((p - vec3(3.4, 0.0, 0.0)) * vec3(0.60, 1.70, 1.05));
  d = min(d, (pl.x + pl.y + pl.z) * 0.5773 - 0.88);

  // Pollen. Pure glow — never min'd into d.
  if(pollen_visible > 0.5){
    vec3 ep = bp;
    ep.y -= time * 1.2;
    vec3 eid = repid(ep, vec3(5.0));
    vec3 e2 = repeat(ep, vec3(5.0)) + (rnd3(eid) - 0.5) * 3.0;
    float de = length(e2) - 0.05;
    vec3 pc = 0.45 + 0.55 * cos(rnd3(eid).x * 12.0 + vec3(0.0, 2.1, 4.2));
    aco += pc * (0.0025 + pollen_react * 0.006) / (0.02 + abs(de));
  }

  // The fold leaves a seam at every sector boundary where this stops being a
  // true distance. At Pralina's 0.7 those seams tear.
  d *= 0.45;

  if(d < 0.1){
    float bite = 0.22 + core_react * 0.22;
    for(float i = 1.; i < 8.; ++i){
      p -= 0.8;
      float ss = 9. / i;
      vec3 id = repid(p, vec3(ss));
      vec3 p2 = repeat(p, vec3(ss)) + rnd3(id) * 0.2;
      // Scooped, not bitten: squashing the cut across the radius turns each
      // subtraction into a scallop running outward.
      p2.y *= 0.55;
      d = max(d, -(length(p2) - ss * bite));
      p.xz *= rot(0.7);
      p.yz *= rot(0.6);
    }

    // Tight kernels. Pralina's 0.15 spreads each plane into a haze that fills
    // the gaps between forms, which is most of why it reads soft.
    vec3 p4 = repeat(p + time * 3.5, vec3(8));
    float s = 1. + slices_react * 1.3;
    float d4 = max(abs(p4.x) - 0.06, d);
    aco += vec3(1.8, 0.45, 1.4) * 0.010 * s / (0.05 + abs(d4));
    float d5 = max(abs(p4.y) - 0.06, d);
    aco += vec3(0.35, 1.5, 1.7) * 0.007 * s / (0.05 + abs(d5));
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

  // High enough to look down on the face of it.
  float ct = time * 0.26 + iCamOrbit * 0.4;
  float el = 0.85 + sin(time * 0.13) * 0.22 + iCamHeight * 0.3;
  s.yz *= rot(el);
  s.xz *= rot(ct);
  r.yz *= rot(el);
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

  // Floored. Pralina's AO goes to zero inside a cavity, which is correct and
  // crushes the middle of the flower to black — the petals are what is lit,
  // and without a floor there is nothing between them.
  float ao = gao(p, n, 0.35);
  ao *= gao(p, n, 1.0) * .5 + .5;
  ao = 0.25 + 0.75 * ao;

  // Half the ambient bleed the rest of the family carries. That loop is a
  // distance-field haze that smears outward from every surface, and past a
  // certain strength it is the only thing you can see.
  for(float i = 1.; i < 15.; ++i){
    float dd = 0.2 * i;
    col += map(p + r * dd) * fog * 0.042 * vec3(0.95, 0.40, 0.95 + dd * .2) * ao;
  }

  // Real lighting, which Pralina has none of — it is glow, fresnel and AO, so
  // its forms have no shading to separate them and they melt together. A key
  // light gives every facet its own value, and the specular finds the ridges.
  //
  // The key rides with the camera rather than sitting in world space. The mass
  // tumbles, so a fixed light leaves whichever face is turned toward us unlit
  // through most of the rotation, and the frame goes dark for no reason the
  // audience can see. The fill keeps the cavities off black.
  vec3 lig = normalize(-r + vec3(0.45, 0.75, 0.0));
  float dif = clamp(dot(n, lig), 0., 1.);
  float fill = 0.35 + 0.65 * clamp(dot(n, -r), 0., 1.);
  float spe = pow(clamp(dot(reflect(-lig, n), -r), 0., 1.), 40.);
  col += vec3(1.15, 0.28, 0.95) * dif * ao * fog * 1.45;
  col += vec3(0.45, 0.12, 0.55) * fill * ao * fog * 0.60;
  col += vec3(1.00, 0.88, 1.00) * spe * fog * 1.7;

  // A tight rim in the opposite hue. At Pralina's power of 3 this is a halo
  // around the whole silhouette; at 6 it is an edge, and cyan against magenta
  // is what actually makes the petals cut apart.
  float fre = pow(1. - abs(dot(n, r)), 6.);
  col += fre * vec3(0.40, 1.35, 1.25) * 2.2 * ao * fog;
  col += (1. - fog) * mix(vec3(0), vec3(0.20, 0.07, 0.22), pow(abs(r.x), 4.)) * 2.;
  col += (1. - fog) * mix(vec3(0), vec3(0.08, 0.16, 0.26), pow(abs(r.z), 4.)) * 2.;

  // Pralina's channel-rotating rainbow, reached through hot pink.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  if(tint_visible < 0.5){
    col = vec3(lum);
  } else {
    // A hue cycle, not Pralina's channel rotation. Rotating the colour vector
    // mixes the channels toward each other, so at some phases all three land on
    // the same value and the frame washes out to grey — survivable in a piece
    // that is chaotic by design, useless when the palette is the point.
    float k = clamp(tint_react, 0., 2.);
    vec3 hot = vec3(lum) * vec3(1.55, 0.40, 1.25);
    vec3 w = max(vec3(0.15), 0.55 + 0.70 * cos(time * 0.8 + vec3(0.0, 2.094, 4.188)));
    vec3 rb = col * w * 1.25;
    col = mix(mix(vec3(lum), hot, smoothstep(0.0, 0.5, k)), rb, smoothstep(0.9, 1.7, k));
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

export const bloom: ShaderDef = {
  id: 'bloom',
  name: 'Core — Bloom',
  description:
    'A Pralina variant folded into a rosette: three tubes become as many petals as the fold has sectors, scalloped rather than eroded, with pollen drifting through. The abstract companion to Odyssey II.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'petal',
      name: 'Petals',
      description:
        'How many sectors the fold has, 4 to 13. Folding space costs the same whatever the count, so this is free to swing — put it on a band and the flower reshapes on every hit.',
      defaultBand: 'mid',
      defaultAmount: 0.7,
      defaultLevel: 0.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'core',
      name: 'Scallop',
      description:
        'Depth of the scooping. Pralina bites; the cut is squashed across the radius here, so it runs outward like the edge of a petal.',
      defaultBand: 'low',
      defaultAmount: 0.9,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'pollen',
      name: 'Pollen',
      description:
        'Drifting motes, each its own colour. Pure glow, never part of the geometry, so it is nearly free. Hide for the flower alone.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'slices',
      name: 'Scan Planes',
      description: 'Planes cutting through the mass and lighting it from inside.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.35,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description:
        'Palette: 0 grey, 0.5 hot pink, 1.7+ the full rotating rainbow. Hide for black and white.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 1.2,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
