/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Waveform" — a monochrome 3D soundwave rendered as a volumetric contour scan.
 *
 * Structure follows a Shadertoy original that raymarched a box and lit a thin
 * sheet wherever the ray's height matched a height map sampled from an image,
 * accumulating additively so the sheets read as glowing translucent surfaces.
 * Here the height map is a soundwave synthesised from the engine's bands rather
 * than an image, and the four RGB+luminance sheets of the original become
 * stacked monochrome layers.
 *
 * Ported to GLSL-ES 1.00: the mouse-orbit state (which the original kept in a
 * feedback buffer) is replaced by the camera rig, and the march is 256 fixed
 * steps with the original's early-exit once the ray leaves the box heading out.
 *
 * Elements:
 *   wave   -> amplitude of the soundwave surface
 *   detail -> harmonics folded into the surface
 *   scan   -> how fast the wave travels
 *   glow   -> brightness accumulated per sheet crossing
 *   sheets -> the extra stacked layers; hide for a single clean surface
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

uniform float wave_react;
uniform float detail_react;
uniform float scan_react;
uniform float glow_react;
uniform float sheets_react;
uniform float sheets_visible;

#define MAX_STEPS 256
#define STEP_SIZE .012
#define WIDTH .009
#define Z_SCALE 1.4
#define Z_OFFSET .6
#define CAM_RADIUS 3.
#define _tau 6.2831853071

/**
 * The height field: a soundwave running along x, with the trailing axis
 * carrying older phase so the wave visibly travels across the surface.
 * Returns roughly 0..1, the range the sheet heights are scaled from.
 */
float field(vec2 p, float ph){
  float amp = 0.20 + wave_react * 0.55;
  float d = 0.30 + detail_react;

  float w = sin(p.x * 5.0 + ph);
  w += sin(p.x * 11.0 - ph * 1.4 + p.y * 3.0) * 0.55 * d;
  w += sin(p.x * 23.0 + ph * 2.1 - p.y * 5.0) * 0.28 * d * 1.4;

  // Fade toward the edges of the box so the surface reads as a slab of sound.
  float env = exp(-1.5 * dot(p, p));
  return clamp(0.5 + w * amp * env * 0.5, 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  // Same framing as the original: both axes divided by width.
  vec2 uv = vec2(2. * fragCoord.x / iResolution.x - 1.,
                 (2. * fragCoord.y - iResolution.y) / iResolution.x);

  // Camera rig replaces the original's mouse-orbit feedback buffer.
  float a = (0.35 + iCamOrbit * 0.15) * _tau;
  float b = (0.08 + iCamHeight * 0.09) * _tau;
  float radius = CAM_RADIUS * max(iCamDist, 0.4);

  vec3 ro = radius * vec3(-cos(a) * cos(b), -sin(a) * cos(b), sin(b));
  ro.z += Z_OFFSET;
  mat3 cm = mat3(
    cos(-b) * cos(a), cos(-b) * sin(a), sin(-b),
    -sin(a), cos(a), 0.,
    -sin(-b) * cos(a), -sin(-b) * sin(a), cos(-b));
  vec3 rd = cm * normalize(vec3(60.0 / iCamFov, uv));
  ro += rd;

  float ph = iTime * (0.8 + scan_react * 2.6);
  float bright = 0.028 + glow_react * 0.05;
  float v = 0.0;

  for(int i = 0; i < MAX_STEPS; i++){
    ro += STEP_SIZE * rd;

    // Left the box travelling away — nothing further can be hit.
    if((abs(ro.x) >= 1. || abs(ro.y) >= 1.) && dot(rd, ro) >= .2) break;
    // Outside the box but still heading in: keep marching.
    if(abs(ro.x) >= 1. || abs(ro.y) >= 1. || ro.z <= 0.) continue;

    float h = field(ro.xy, ph);

    // Main surface.
    if(abs(ro.z - h * Z_SCALE) <= WIDTH) v += bright;

    if(sheets_visible > 0.5){
      // Stacked companions — the original's separate RGB sheets, kept
      // monochrome so crossings simply read as brighter.
      float o = 0.10 + sheets_react * 0.12;
      if(abs(ro.z - (h + o) * Z_SCALE) <= WIDTH) v += bright * 0.7;
      if(abs(ro.z - (h - o) * Z_SCALE) <= WIDTH) v += bright * 0.7;
      // A flat reference plane at the wave's resting height.
      if(abs(ro.z - 0.5 * Z_SCALE) <= WIDTH * 0.7) v += bright * 0.35;
    }
  }

  fragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
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

export const waveform: ShaderDef = {
  id: 'waveform',
  name: 'Waveform',
  description:
    'A monochrome 3D soundwave scanned volumetrically — thin glowing contour sheets tracing a wave surface inside a box.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'wave',
      name: 'Amplitude',
      description: 'Height of the wave surface. React drives it on the bass.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.25,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Harmonics',
      description: 'Finer ripples folded into the surface.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'scan',
      name: 'Travel',
      description: 'How fast the wave runs across the surface.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Brightness picked up per sheet crossing. React flares it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sheets',
      name: 'Layers',
      description: 'Stacked companion sheets. React spreads them; hide for one clean surface.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
