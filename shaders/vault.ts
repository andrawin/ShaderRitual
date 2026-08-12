/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Vault" — a Machina variant gone vertical and slow: folds bias upward, a
 * cylinder lattice on the ground plane reads as a colonnade, and the palette is
 * amber on deep shadow. Cathedral pacing rather than machine pacing.
 *
 * Same skeleton as Machina (see machina.ts); the fold is anisotropic (tall) and
 * the repetition is a column grid on XZ rather than a pillar tube.
 *
 * Elements:
 *   folds   -> how deeply the vault folds (3..8)
 *   lamp    -> the hanging light at the crossing
 *   columns -> the colonnade grid; hideable
 *   floor   -> the polished floor; hideable
 *   speed   -> how fast the vault breathes
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
uniform float lamp_react;
uniform float lamp_visible;
uniform float columns_react;
uniform float columns_visible;
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
float sb(vec3 p, vec3 s){ p = abs(p) - s; return max(max(p.y, p.z), p.x); }
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.) / k;
  return min(a, b) - pow(h, 3.) * k * (1.0 / 6.0);
}

bool hitGround = false;
float glowe, glowrep;

float map(vec3 p, float time){
  // Slow turn, slight sway — the vault breathes rather than churns.
  p.xz *= rot(time * 0.35);
  p.yz *= rot(sin(time * 0.4) * 0.18);
  vec3 p0 = p;
  float tt = (c(time * 40., 60.5) * 2.5);

  float sf = floor(clamp(3. + folds_react * 4.0, 3., 8.));
  vec3 p1 = p;
  for(int i = 0; i < 8; i++){
    if(float(i) >= sf) break;
    float fi = float(i);
    // Anisotropic fold: shallower on Y, so structure stacks upward.
    p1 = abs(p1) - vec3(6. + tt * 3., 2.5 + tt, 6. + tt * 3.);
    p1.xz *= rot(tt * .22 + fi * .5);
  }

  float r = sin(tt + p1.x * .4) * sin(tt + p1.y * .21) * sin(tt + p1.z * .4);
  // Tall boxes -> arch ribs.
  float d = sb(p1, vec3(4.5 + r, 14. + r * 2., 4.5 + r));

  // Hanging lamp at the crossing.
  float e1 = length(p0 - vec3(0., 18., 0.)) - 7. - r * 2.;
  if(lamp_visible > 0.5) glowe += 5.5 / (1. + e1 * e1 * e1) * (1. + lamp_react * 2.5);

  // Colonnade: a column grid tiled on the ground plane.
  vec3 p2 = p0;
  p2.xz = mod(p2.xz + 30., 60.) - 30.;
  float e2 = max(length(p2.xz) - 5., abs(p0.y) - 70.);
  if(columns_visible > 0.5) glowrep += 9. / (4. + e2 * e2) * (1. + columns_react * 1.5);

  float pisos = 1. - abs(p.y) + (99. + sin(p.y * .5 + tt) * sin(p.x * .7 + tt) * sin(p.z * .7 + time) - 3.) * .5;
  hitGround = floor_visible > 0.5 && pisos < 0.5;

  float shell = 1. - sb(p, vec3(230.));
  d = min(d, shell);
  if(columns_visible > 0.5) d = smin(d, e2, 7.);
  if(floor_visible > 0.5) d = min(d, pisos);
  if(lamp_visible > 0.5) d = smin(e1, d, 6.);
  return d;
}

vec3 nm(vec3 p, float t){
  const vec2 e = vec2(0.01, 0.);
  return map(p, t) - normalize(vec3(map(p - e.xyy, t), map(p - e.yxy, t), map(p - e.yyx, t)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float time = mod(iTime * (0.35 + speed_react * 0.7), 10.) * .88;

  vec2 uv = fragCoord.xy / iResolution.xy;
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1);
  uv *= (iCamFov / 60.);

  float tt = c(time * 200., 100.) * .25;
  time -= rand(uv.y) * tt * .25;

  vec3 s = vec3(0.00001, .000001, -110. * max(iCamDist, 0.4));
  vec3 r = normalize(vec3(-uv, 1.));
  r.xz *= rot(iCamOrbit * 0.25);
  r.yz *= rot(0.12 + iCamHeight * 0.3); // slight upward tilt
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

  // Amber on deep shadow.
  vec3 baseColor = vec3(1.0, 0.72, 0.32);
  float dao = .88;
  float ao = clamp(map(p + n * dao, time), 0., 1.);
  float fres = pow(16. - ld, .5) * .4;
  float fog = 4. - max(length(p - s) / 400., 0.);
  col += dd * baseColor * .011;
  col += glowe * baseColor - vec3(0.3, 0.7, 1.2);
  col += (mix(vec3(fres), vec3(ao), glowrep * baseColor * .7));

  vec2 uv2 = p.xy * 4.;
  vec2 gid = fract(max(uv2, uv2.yx) + time * 12.);
  col *= vec3(1., gid.x * .75 + .25, gid.y * .45 + .1) * .8;

  col = pow(max(col, 0.), vec3(2.5)) * vec3(1.2, 0.85, 0.5) * .55;
  vec3 a = rand33(col / (1. + length(uv.yx)));
  vec3 b = rand33(col / (1. + length(uv)));
  vec3 cc = pow(smoothstep(vec3(0.), vec3(1.), fract(col)), vec3(20.));
  col *= mix(a, b, cc);
  col = smoothstep(0., 1., col) - length(uv) * 1.12;

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

export const vault: ShaderDef = {
  id: 'vault',
  name: 'Vault',
  description:
    'Machina gone vertical and slow — stacked arch ribs, a colonnade grid and a hanging lamp, in amber on deep shadow.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'folds',
      name: 'Folds',
      description: 'How deeply the vault folds (3–8). React restacks the arches.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'lamp',
      name: 'Lamp',
      description: 'The hanging light at the crossing. React swells it; hide to douse it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'columns',
      name: 'Colonnade',
      description: 'The column grid on the ground plane. Hide for an open nave.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'floor',
      name: 'Floor',
      description: 'The polished floor. Hide to fall through into open space.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Breath',
      description: 'How fast the vault breathes. React quickens it.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
