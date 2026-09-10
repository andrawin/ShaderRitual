/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 0 — "Awakening". The origin: the traveller comes to in a universe
 * that has barely been switched on. There is almost nothing here — a cold
 * violet band where a horizon ought to be, a thin scatter of stars, and one
 * point of light behind the figure that pulses like something breathing.
 *
 * Rise is the scene's real subject: at 0 the ground is dead flat and the world
 * is a void; turn it up and terrain grows out of the floor. Run it low and let
 * it climb across a set and the world assembles itself under the traveller.
 *
 * Shares the suite's grammar (see odyssey.ts): Horizon's sin-stack ridge and
 * stepped silhouettes, but coloured after The Artful Escape — the figure is
 * cut out black and rimmed in the scene's key colour rather than shaded.
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float spark_react;
uniform float spark_visible;
uniform float stars_react;
uniform float stars_visible;
uniform float rise_react;

${odysseyLib}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.02 - iCamOrbit * 0.02;

  float spd = 0.008 + walk_react * 0.045;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);

  // How much world has risen out of the void.
  float amp = 0.15 + rise_react * 1.0;
  float gy  = groundOd(wx, scroll, 3.1, -0.24, amp);

  vec3 key = vec3(0.45, 0.85, 1.0);

  // Sky: almost nothing, with a cold violet just above where the ground is.
  vec3 col = vec3(0.010, 0.011, 0.026);
  col += vec3(0.05, 0.03, 0.12) * pow(max(0.0, 1.0 - abs(uv.y + 0.24) * 2.2), 3.0);

  if(stars_visible > 0.5){
    float s = starsOd(uv + vec2(scroll * 0.3, 0.0), 26.0, 1.0);
    col += vec3(0.55, 0.70, 1.0) * s * (0.35 + stars_react * 0.9);
  }

  // The waking light, sitting behind the traveller and moving with them.
  if(spark_visible > 0.5){
    float sd = length((uv - vec2(wx, gy + 0.17)) * vec2(1.0, 1.25));
    float pulse = 0.75 + 0.25 * sin(iTime * 0.9);
    col += key * pow(max(0.0, 1.0 - sd * 1.3), 3.0) * pulse * (0.25 + spark_react * 1.1);
    col += key * pow(max(0.0, 1.0 - sd * 5.0), 8.0) * (0.40 + spark_react * 1.5);
  }

  // Ground: solid, with the horizon line itself picked out as a hairline.
  col *= mix(0.06, 1.0, bandOd(uv, scroll, 3.1, -0.24, amp, px));
  float hl = smoothstep(px * 3.0, 0.0,
                        abs(uv.y - groundOd(uv.x, scroll, 3.1, -0.24, amp)));
  col += key * hl * (0.25 + rise_react * 0.5);

  // The traveller: cut out black, rimmed in the key colour.
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.6 + walk_react * 0.8);

  col *= 1.0 - 0.5 * pow(clamp(length(uv * vec2(0.85, 1.25)), 0.0, 1.0), 2.5);
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

export const awakening: ShaderDef = {
  id: 'awakening',
  name: 'Odyssey I — Awakening',
  description:
    'The origin. A traveller with an oversized sword wakes in a near-empty universe: one pulsing light, a thin scatter of stars, and a horizon that has barely formed.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'walk',
      name: 'Traveller',
      description:
        'Travel speed and stride of the figure crossing the scene. At 0 they hold centre and march in place. Hide to clear them out of the frame.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sword',
      name: 'Sword',
      description:
        'Size of the blade alone — the body stays put. Push the level for something absurd above the horizon.',
      defaultBand: 'high',
      defaultAmount: 0.5,
      defaultLevel: 0.45,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'spark',
      name: 'First Light',
      description:
        'The waking light behind the traveller. React makes it breathe with the track; hide for a figure alone in the dark.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'stars',
      name: 'Stars',
      description: 'The scatter of stars coming up out of the dark. React drives the twinkle.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'rise',
      name: 'Rise',
      description:
        'How much world exists yet. At 0 the ground is dead flat void; climbing it grows terrain out of the floor.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.2,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
