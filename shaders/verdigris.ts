/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Verdigris" — an infinite folded lattice grown out of a smooth-abs fractal
 * and skinned with a triplanar stripe pattern, so the surface reads as etched
 * metal rather than plastic. The camera drifts diagonally through the cell
 * repeat forever while the fold angles breathe on two detuned sines.
 *
 * The structure comes from sabs() — a soft absolute value built on a smooth
 * min — folded three times with a scale of ~3.7 per step. The stripes come
 * from boxmap(), a triplanar blend of abs(sin(x) + sin(y)) that is added back
 * into the distance estimate, so the pattern is real relief, not just colour.
 *
 * Ported to GLSL-ES 1.00 and hardened for a live rig:
 *   - normalize() inside boxmap could divide by zero at the fold's centre, and
 *     its triplanar weights sum to ~1.7e-5 at worst; both are now guarded, as
 *     a NaN here would punch a black hole through the lattice.
 *   - the far plane is pulled in from 5.0 to 2.8. The fog is exp(-t*t*0.6),
 *     which is already down to 0.009 at 2.8, so nothing visible is lost — but
 *     the march is a 0.1 * d crawl, so those steps were most of the cost.
 *   - the monochrome pulse folded to vec3(col.x) in the original, which on a
 *     green material collapses to near-black. It desaturates by luminance now.
 *
 * Elements:
 *   morph -> how far the fold angles swing
 *   scale -> fractal scale per fold; changes the whole structure
 *   grain -> stripe density; hideable for a bare smooth lattice
 *   tint  -> material colour, green -> copper -> blue; hideable for steel
 *   mono  -> the slow desaturation pulse; hideable to stay in colour
 *   drift -> flight speed through the cells
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

uniform float morph_react;
uniform float scale_react;
uniform float grain_react;
uniform float grain_visible;
uniform float tint_react;
uniform float tint_visible;
uniform float mono_react;
uniform float mono_visible;
uniform float drift_react;

mat2 rot2(float a){ return mat2(cos(a), sin(a), -sin(a), cos(a)); }

/* One stripe octave. Its frequency is the Grain element. */
float pattern(vec2 p){
  p *= 8.0 + grain_react * 14.0;
  return abs(sin(p.x) + sin(p.y));
}

/*
 * Triplanar projection of the stripes. The original normalized p directly and
 * divided by the raw weight sum; at the fold centre that is a 0/0, so both are
 * floored here.
 */
float boxmap(vec3 p){
  p *= 0.3;
  vec3 n = p / max(length(p), 1e-4);
  vec3 m = pow(abs(n), vec3(20.0));
  vec3 a = vec3(pattern(p.yz), pattern(p.zx), pattern(p.xy));
  return dot(a, m) / max(m.x + m.y + m.z, 1e-6);
}

vec3 smin3(vec3 a, vec3 b){
  float k = 0.08;
  vec3 h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/* Smooth absolute value — the fold that rounds every crease. */
vec3 sabs(vec3 p){ return p - 2.0 * smin3(vec3(0.0), p); }

float map(vec3 p){
  float s = 3.3 + scale_react * 0.55;
  float amp = 1.0 / s;
  float c = 0.5;
  p = sabs(mod(p, c * 2.0) - c);
  float de = 100.0;
  float wob = 0.12 + morph_react * 0.25;
  for(int i = 0; i < 3; i++){
    p.xy *= rot2(0.4 + sin(iTime * 0.2 + 0.3 * sin(iTime * 0.4)) * wob);
    p.yz *= rot2(0.4 + sin(iTime * 0.3 + 0.5 * sin(iTime * 0.5)) * wob);
    p = sabs(p);
    p *= s;
    p -= vec3(0.2 * p.z, 0.6 * p.x, 0.4) * (s - 1.0);
    de = abs(length(p * amp) - 0.2);
    amp /= s;
  }
  // Hidden grain feeds back the mean stripe value, so the two constants cancel
  // and the surface is left exactly at de.
  float g = grain_visible > 0.5 ? boxmap(p) : 0.5;
  return de + g * 0.02 - 0.01;
}

vec3 calcNormal(vec3 p){
  vec2 e = vec2(1, -1) * 0.001;
  return normalize(
    e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) +
    e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

/* Green -> copper -> blue across the Tint level's 0..2 range. */
vec3 baseTint(){
  vec3 a = vec3(0.20, 0.90, 0.20);
  vec3 b = vec3(0.95, 0.45, 0.15);
  vec3 c = vec3(0.25, 0.55, 1.00);
  float h = clamp(tint_react, 0.0, 2.0);
  return h < 1.0 ? mix(a, b, h) : mix(b, c, h - 1.0);
}

vec3 doColor(vec3 p){
  vec3 t = tint_visible > 0.5 ? baseTint() : vec3(0.75);
  float g = grain_visible > 0.5 ? boxmap(p) : 0.6;
  return t * g;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;
  uv *= (iCamFov / 60.0);

  float fly = iTime * (0.06 + drift_react * 0.12);
  vec3 ro = vec3(0.2, 0.1, 0.5) + fly;
  ro.y += iCamHeight * 0.4;
  ro.z += (iCamDist - 1.0) * 0.5;

  vec3 rd = normalize(vec3(uv, 2.0));
  rd.xz *= rot2(sin(iTime * 0.3) * 0.6 + iCamOrbit * 0.4);
  rd.yz *= rot2(sin(iTime * 0.2) * 0.6);
  rd.xy *= rot2(sin(iTime * 0.05));

  vec3 col = mix(vec3(0.3, 0.7, 0.8), vec3(0.1, 0.1, 0.2),
                 smoothstep(0.3, 2.5, length(uv)));

  // The distance estimate is not conservative, hence the 0.1 crawl.
  float t = 0.1;
  float d = 1.0;
  for(int i = 0; i < 200; i++){
    d = map(ro + rd * t);
    t += 0.1 * d;
    if(d < 0.001 || t > 2.8) break;
  }

  if(d < 0.001){
    vec3 hp = ro + rd * t;
    vec3 nor = calcNormal(hp);
    vec3 li = normalize(vec3(1.0));
    vec3 c = doColor(hp);
    c *= clamp(dot(nor, li), 0.3, 1.0);
    c *= max(0.5 + 0.5 * nor.y, 0.0);
    c += pow(clamp(dot(reflect(normalize(hp - ro), nor), li), 0.0, 1.0), 20.0);
    c.x += 1.0 - exp(-t * t * 0.15);
    c = clamp(c, 0.0, 1.0);
    col = mix(col, c, exp(-t * t * 0.6));
  }

  col = pow(max(col, 0.0), vec3(0.8));

  // React can force it grey on a hit; visible keeps the original slow pulse.
  float m = clamp(mono_react, 0.0, 1.0);
  if(mono_visible > 0.5){
    m = max(m, clamp(sin(iTime * 0.5 + sin(iTime * 0.2) * 0.5) * 2.0 - 1.0, 0.0, 1.0));
  }
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), m);

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
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

export const verdigris: ShaderDef = {
  id: 'verdigris',
  name: 'Verdigris',
  description:
    'An endless folded lattice of etched green metal — a smooth-abs fractal skinned with triplanar stripes, drifting through its own cell repeat.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'morph',
      name: 'Morph',
      description: 'How far the fold angles swing as they breathe. React opens the folds on a hit.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.32,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'scale',
      name: 'Scale',
      description:
        'Fractal scale per fold. Small moves rebuild the whole structure, so keep the amount low unless you want it to churn.',
      defaultBand: 'mid',
      defaultAmount: 0.4,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'grain',
      name: 'Grain',
      description:
        'Density of the stripes etched into the surface — real relief, not just colour. Hide for a bare smooth lattice.',
      defaultBand: 'high',
      defaultAmount: 0.35,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description:
        'Material colour across the level: 0 green, 1 copper, 2 blue. Hide for bare steel.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'mono',
      name: 'Mono',
      description:
        'The slow drain to greyscale. Visible keeps the original pulse; react forces it grey on a hit. Hide to stay in colour.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      defaultLevel: 0.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'drift',
      name: 'Drift',
      description: 'Flight speed through the cells. React surges the run.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.3,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
