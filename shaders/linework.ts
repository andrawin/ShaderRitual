/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Palette, ShaderElement } from '../types';

/*
 * Shared pieces for the Linework suite: six shaders after a pack of
 * "technological background" vector shapes — wireframe and dotted terrains,
 * hexagon sheets, bundled strands, filament bursts, flow-line contours, string
 * art and halftone forms. Each shader covers one family and offers its
 * variants as a Form menu.
 *
 * They are written in GLSL ES 3.00 for one reason: fwidth(). Line art drawn on
 * a surface in perspective needs to know how big a pixel is in the surface's
 * own coordinates, or the lines go fat up close and alias to shimmer in the
 * distance. With the screen-space derivative every line stays one even width
 * at any depth, and fades out cleanly where the lattice gets denser than the
 * pixels can show.
 *
 * Every shader shares the same first six elements, in the same order, so one
 * MIDI map carries across the suite:
 *   form    -> which shape in the family (a menu)
 *   swell   -> how much the shape moves with the music
 *   density -> how many lines, dots or cells
 *   ink     -> the line colour (a colour; its level is intensity)
 *   accent  -> the second colour: depth, nodes, highlights
 *   paper   -> the background
 * and then one element of its own.
 */

/** Uniform block every Linework shader opens with. GLSL ES 3.00. */
export const lineworkUniforms = `
precision highp float;
in vec2 vUv;
out highp vec4 fragColor;
uniform vec3 iResolution;
uniform float iTime;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float form_react;
uniform float swell_react;
uniform float density_react;
uniform float ink_react;
uniform vec3 ink_color;
uniform float accent_react;
uniform vec3 accent_color;
uniform float paper_react;
uniform vec3 paper_color;
`;

export const lineworkLib = `
#define PI 3.14159265
#define TAU 6.28318531

/* Which option the Form menu is on, out of n. */
int formLw(float n){ return int(floor(clamp(form_react, 0.0, 1.999) * n * 0.5)); }

vec3 inkLw(){ return ink_color * max(ink_react, 0.0); }
vec3 accentLw(){ return accent_color * max(accent_react, 0.0); }
vec3 paperLw(){ return paper_color * max(paper_react, 0.0); }

float hash11Lw(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21Lw(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noiseLw(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21Lw(i), hash21Lw(i + vec2(1, 0)), f.x),
             mix(hash21Lw(i + vec2(0, 1)), hash21Lw(i + vec2(1, 1)), f.x), f.y);
}
float fbmLw(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 4; i++){ s += a * noiseLw(p); p = p * 2.03 + 1.7; a *= 0.5; }
  return s;
}

/* Screen position: centred, y in [-0.5, 0.5]. And one pixel in those units. */
vec2 uvLw(){ return (vUv - 0.5) * vec2(iResolution.x / iResolution.y, 1.0); }
float pxLw(){ return 1.0 / iResolution.y; }

/*
 * One family of parallel lines, x = integer, drawn wpx pixels wide whatever
 * the depth. Where the lines crowd closer than about two pixels they fade to
 * nothing instead of beating against the pixel grid.
 */
float linesLw(float x, float wpx){
  float fw = max(fwidth(x), 1e-5);
  float d = abs(fract(x - 0.5) - 0.5) / fw;
  return clamp(wpx + 0.5 - d, 0.0, 1.0) * (1.0 - smoothstep(0.3, 0.7, fw));
}

/* Coverage of something whose edge is d pixels away (negative inside). */
float coverLw(float dpx){ return clamp(0.5 - dpx, 0.0, 1.0); }

/* A line of half-width wpx pixels, given the distance to it in pixels. */
float strokeLw(float dpx, float wpx){ return clamp(wpx + 0.5 - abs(dpx), 0.0, 1.0); }

/*
 * The shared orbit camera: yaw from the rig's orbit, elevation from its
 * height, range from its distance, lens from its field of view.
 */
void cameraLw(vec2 uv, vec3 target, float range, float elev, out vec3 ro, out vec3 rd){
  float yaw = iCamOrbit * 0.35;
  float el = clamp(elev + iCamHeight * 0.6, -1.3, 1.45);
  float r = range * clamp(iCamDist, 0.35, 3.0);
  ro = target + r * vec3(sin(yaw) * cos(el), sin(el), -cos(yaw) * cos(el));
  vec3 fw = normalize(target - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  float f = 0.5 / tan(radians(clamp(iCamFov, 20.0, 110.0) * 0.5));
  rd = normalize(uv.x * rt + uv.y * up + f * fw);
}

/* Project a world point to screen with the same camera. w <= 0 is behind. */
vec3 projectLw(vec3 p, vec3 ro, vec3 target){
  vec3 fw = normalize(target - ro);
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  float f = 0.5 / tan(radians(clamp(iCamFov, 20.0, 110.0) * 0.5));
  vec3 q = p - ro;
  float z = dot(q, fw);
  return vec3(vec2(dot(q, rt), dot(q, up)) * f / max(z, 1e-3), z);
}

/* The beat as a 0..1 kick, for anything that should land on it. */
float beatLw(){ return pow(sin(fract(iBeat) * TAU) * 0.5 + 0.5, 6.0) * iCamReact; }

/* Finish: a gentle vignette in the paper colour, never touching the ink. */
vec3 finishLw(vec3 col, vec2 uv){
  float v = smoothstep(0.35, 1.1, length(uv * vec2(0.8, 1.0)));
  return mix(col, col * 0.7, v);
}
`;

/** Image pass for the suite: lines are already finished, so copy straight out. */
export const lineworkImage = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.0); }
`;

/** Colour sets shared by the whole suite. */
export const LINEWORK_PALETTES: Palette[] = [
  { name: 'Mono', colors: { ink: '#ffffff', accent: '#8c8c8c', paper: '#0b0b0c' } },
  { name: 'Blueprint', colors: { ink: '#d6ecff', accent: '#3d9bff', paper: '#061833' } },
  { name: 'Phosphor', colors: { ink: '#9dffad', accent: '#1db34a', paper: '#020a04' } },
  { name: 'Amber', colors: { ink: '#ffd27a', accent: '#ff6a00', paper: '#110700' } },
  { name: 'Neon', colors: { ink: '#ff4fd8', accent: '#36f0ff', paper: '#090212' } },
  { name: 'Infrared', colors: { ink: '#ffffff', accent: '#ff2a3a', paper: '#000000' } },
  { name: 'Print', colors: { ink: '#141414', accent: '#7d7d7d', paper: '#efebe2' } },
];

/** The six shared elements, then the shader's own. */
export function lineworkElements(forms: string[], formHelp: string, own: ShaderElement): ShaderElement[] {
  return [
    {
      id: 'form',
      name: 'Form',
      description: formHelp,
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1 / forms.length,
      canHide: false,
      defaultVisible: true,
      options: forms,
    },
    {
      id: 'swell',
      name: 'Swell',
      description: 'How much the shape moves with the music. The level sets how much it moves at rest.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'density',
      name: 'Density',
      description: 'How many lines, dots or cells. More is finer and, for the heavier forms, costlier.',
      defaultBand: 'none',
      defaultAmount: 0.3,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'ink',
      name: 'Ink',
      description: 'The line colour. Intensity is its brightness — give it a band and the lines flash with the track.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#ffffff',
    },
    {
      id: 'accent',
      name: 'Accent',
      description: 'The second colour: depth, nodes and highlights, depending on the form.',
      defaultBand: 'high',
      defaultAmount: 0.4,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#8c8c8c',
    },
    {
      id: 'paper',
      name: 'Paper',
      description: 'The background colour. Drop the intensity to 0 to put the lines over pure black.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
      defaultColor: '#0b0b0c',
    },
    own,
  ];
}
