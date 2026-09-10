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
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Maelstrom's log-polar vortex, trimmed to 40 steps and 4 octaves and
 * re-divided into blue instead of amber. Mapping position into
 * (log R, radial falloff, angle) makes the same field repeat at every scale, so
 * it reads as something falling inward forever — which is the whole scene:
 * a universe still switching itself on behind an empty horizon.
 */
vec3 skyVortexOd(vec2 uv, float react){
  vec3 d = vec3(uv * 0.85, 0.4);
  vec3 q = vec3(0.0, -0.35, -0.5);
  vec3 acc = vec3(0.0);
  vec3 p = vec3(0.0);
  float e = 0.0;
  float R = 0.0;
  float s = 0.0;
  float spd = 0.09 + react * 0.16;
  for(int i = 0; i < 40; i++){
    acc += min(e * s, 1.0 - e) / vec3(132.0, 84.0, 54.0);
    s = 7.5;
    q += d * e * R * 0.5;
    p = q;
    R = max(length(p), 1e-4);
    float ang = (abs(p.x) + abs(p.y) < 1e-6) ? 0.0 : atan(p.x, p.y);
    p = vec3(log(R) - iTime * spd, exp(-p.z / R + 0.55), ang);
    p.y -= 1.0;
    e = p.y;
    for(int k = 0; k < 4; k++){
      e -= abs(dot(cos(p.zxy * s) - sin(p.yzx), 0.3 - sin(p * s))) / s;
      s += s;
    }
  }
  return max(acc, 0.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.02 - iCamOrbit * 0.02;

  float spd = 0.008 + walk_react * 0.045;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);

  // How much world has risen out of the void.
  float amp = 0.15 + rise_react * 1.0;
  float gy  = groundOd(wx, scroll, 3.1, -0.24, amp);   // under the traveller
  float gyx = groundOd(uv.x, scroll, 3.1, -0.24, amp); // under this pixel

  vec3 key = vec3(0.45, 0.85, 1.0);

  // Sky: almost nothing, with a cold violet just above where the ground is.
  vec3 col = vec3(0.010, 0.011, 0.026);
  col += vec3(0.05, 0.03, 0.12) * pow(max(0.0, 1.0 - abs(uv.y + 0.24) * 2.2), 3.0);

  // Background, behind everything. Skipped below the ground line, where it
  // would be painted over anyway — that is a third of the frame for free.
  if(sky_visible > 0.5 && uv.y > gyx - 0.02){
    col += skyVortexOd(uv, sky_react) * (0.22 + sky_react * 0.85)
         * skyFadeOd(uv.y, gyx);
  }

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
  col *= mix(0.06, 1.0, smoothstep(-px, px, uv.y - gyx));
  col += key * smoothstep(px * 3.0, 0.0, abs(uv.y - gyx)) * (0.25 + rise_react * 0.5);

  // The traveller: cut out black, rimmed in the key colour.
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.6 + walk_react * 0.8);
  // Suit piping, drawn only where it falls inside the cut-out — outside it
  // would read as a thicker outline rather than as costume.
  col += key * smoothstep(px * 1.7, 0.0, gTrimOd)
       * (1.0 - smoothstep(-px, px, d)) * (0.55 + walk_react * 0.7);

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
    {
      id: 'sky',
      name: 'Sky — Vortex',
      description:
        'Maelstrom’s log-polar vortex behind the horizon: a field that repeats at every scale, so it falls inward forever. React drives how fast it turns and how bright it burns. Hide for an empty sky, and for the cheapest version of the scene.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
