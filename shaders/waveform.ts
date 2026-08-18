/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Waveform" — a monochrome 3D soundwave landscape: rows of waveform traces
 * receding into perspective, each row an older snapshot, so the sound scrolls
 * away from the viewer as a terrain of ridges.
 *
 * Rendered analytically rather than raymarched: for every pixel the rows are
 * walked front to back while tracking the highest line drawn so far, which
 * gives exact hidden-line removal (a nearer ridge hides everything behind it)
 * and keeps the strokes crisp at any resolution.
 *
 * The trace is synthesised from the engine's bands — low sets the body of the
 * wave, high adds the fine harmonics — since the engine exposes bands rather
 * than a full FFT spectrum.
 *
 * Elements:
 *   wave   -> amplitude of the trace (the body of the sound)
 *   detail -> fine harmonics riding on top
 *   scan   -> how fast rows scroll away
 *   glow   -> bloom around the strokes
 *   grid   -> cross-ticks that read as a wireframe mesh; hideable
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
uniform float grid_react;
uniform float grid_visible;

/** One waveform trace. The seed differs per row, so each is an older snapshot. */
float waveAt(float x, float seed){
  float s = seed * 0.7;
  float w = sin(x * 1.7 + s);
  w += sin(x * 3.9 - s * 1.3) * 0.55;
  w += sin(x * 8.3 + s * 2.1) * 0.30 * (0.30 + detail_react);
  w += sin(x * 17.1 - s * 3.3) * 0.16 * (0.20 + detail_react * 1.5);
  return w * 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  uv *= (iCamFov / 60.) * max(iCamDist, 0.3);
  uv.x += iCamOrbit * 0.12;

  float t = iTime;
  float scroll = t * (0.35 + scan_react * 1.6);
  float amp = 0.16 + wave_react * 0.40;

  float line = 0.0;   // crisp strokes
  float bloom = 0.0;  // soft halo
  float horizon = -1e3;

  for(int i = 0; i < 48; i++){
    float fi = float(i);
    // Rows march toward the viewer; the fractional part gives smooth motion
    // while the integer part hands each row the previous row's shape.
    float rowT = fi + fract(scroll);
    float z = 0.42 + rowT * 0.17;
    float s = 1.0 / z;                    // perspective scale

    float wx = uv.x * z * 2.4;            // world x at this depth
    float seed = floor(scroll) - fi;      // per-row history
    float ly = (waveAt(wx, seed) * amp - 0.34 + iCamHeight * 0.18) * s + 0.02;

    // Hidden-line removal: a row is only visible where it rises above every
    // nearer row already walked.
    if(ly > horizon){
      float thick = 0.0055 * s + 0.0012;
      float d = abs(uv.y - ly);
      float fade = smoothstep(1.0, 0.12, z * 0.11); // distance falloff
      line = max(line, smoothstep(thick, thick * 0.3, d) * fade);
      bloom += fade * 0.0009 / (0.0016 + d * d);

      if(grid_visible > 0.5){
        // Cross-ticks at regular world-x steps read as a wireframe mesh.
        float gm = abs(fract(wx * 0.5 + 0.5) - 0.5) * 2.0;
        float tick = smoothstep(0.14, 0.0, gm) * (0.4 + grid_react * 0.8);
        line = max(line, tick * smoothstep(thick * 7.0, 0.0, d) * fade * 0.75);
      }

      horizon = ly;
    }
  }

  float v = clamp(line + bloom * (0.35 + glow_react * 1.4), 0.0, 1.0);
  // Monochrome by design: a single luminance channel, with a soft vignette.
  v *= 1.0 - 0.55 * dot(uv, uv);
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
    'A monochrome 3D soundwave landscape — rows of waveform traces receding into perspective, scrolling away as the sound moves.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'wave',
      name: 'Amplitude',
      description: 'Height of the trace — the body of the sound. React drives it on the bass.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.25,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Harmonics',
      description: 'Fine ripple riding on top of the trace.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'scan',
      name: 'Scroll',
      description: 'How fast rows recede. React surges the scroll.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Bloom around the strokes. React flares them on hits.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'grid',
      name: 'Mesh',
      description: 'Cross-ticks that read as a wireframe. Hide for clean traces.',
      defaultBand: 'high',
      defaultAmount: 0.7,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
