/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 4 — "Miasma". The fourth journey: the air itself has turned. A
 * jaundiced sky, a sun that cannot get through it, two layers of particulate
 * scrolling at different speeds, and figures along the ridge who have stopped
 * walking.
 *
 * The fallen are kept small, distant and in silhouette on purpose — the scene
 * is about the air, and they register as what the air did rather than as the
 * subject. Fumes drives the density; at the top of its range the traveller is
 * most of what is still legible.
 *
 * Shares the suite's grammar (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float fumes_react;
uniform float fumes_visible;
uniform float fallen_react;
uniform float fallen_visible;
uniform float sun_react;
uniform float sun_visible;
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Plasma's globe filaments, turned loose in the open air. The trick
 * there is that thin arcs fall out of a thick noise field for free — take the
 * distance from a single iso-value and raise it to a power, and everything but
 * a hairline shell of the field goes to zero. Twisting the sample plane by
 * depth is what bends them into arcs rather than sheets.
 *
 * In a plasma globe that reads as electricity in glass. Over a poisoned
 * landscape, in green, it reads as the air itself discharging.
 */
vec3 skyFilamentOd(vec2 uv, float react){
  vec3 rd = skyRayOd(uv, 0.90);
  vec3 acc = vec3(0.0);
  float t = 0.5;
  for(int i = 0; i < 22; i++){
    vec3 p = rd * t;
    p.xy *= rotOd(p.z * 0.55 + iTime * 0.12);
    float n = fbm3Od(p.xy * 2.1 + vec2(p.z * 1.3, iTime * 0.22));
    float fil = pow(max(0.0, 1.0 - abs(n - 0.5) * 8.5), 4.0);
    acc += mix(vec3(0.30, 0.52, 0.08), vec3(0.78, 0.88, 0.28), fil)
         * fil * (0.05 + react * 0.11) * exp(-t * 0.32);
    t += 0.14;
  }
  return acc;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.030 - iCamOrbit * 0.03;

  float spd = 0.020 + walk_react * 0.050;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);
  float gy  = groundOd(wx, scroll, 12.4, -0.25, 0.55);

  // Jaundiced sky.
  float s = clamp(uv.y + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.46, 0.46, 0.14), vec3(0.09, 0.13, 0.07), s);
  col += vec3(0.40, 0.36, 0.10) * pow(max(0.0, 1.0 - abs(uv.y + 0.24) * 1.6), 3.0) * 0.6;

  // Background, behind everything.
  float gyx = groundOd(uv.x, scroll, 12.4, -0.25, 0.55);
  if(sky_visible > 0.5 && uv.y > gyx - 0.02){
    col += skyFilamentOd(uv, sky_react) * skyFadeOd(uv.y, gyx);
  }

  // A sun that cannot get through.
  if(sun_visible > 0.5){
    vec2 sp = uv - vec2(0.34, 0.06);
    float sd = length(sp);
    col += vec3(0.85, 0.72, 0.22) * smoothstep(0.085, 0.062, sd) * (0.45 + sun_react * 0.7);
    col += vec3(0.55, 0.48, 0.12) * pow(max(0.0, 1.0 - sd * 1.6), 3.0)
         * (0.25 + sun_react * 0.6);
  }

  // Far ridge, already lost in it.
  col = mix(col * vec3(0.55, 0.58, 0.40), col,
            bandOd(uv, scroll * 0.5, 8.8, -0.18, 0.70, px));

  // The fallen, along the ridge behind the traveller.
  if(fallen_visible > 0.5){
    float fx = uv.x + scroll * 0.9;
    float cell = floor(fx / 0.30);
    float h = hashOd(vec2(cell, 33.0));
    if(h > 0.50){
      float cx = (cell + 0.5) * 0.30 - scroll * 0.9;
      float sc = 0.15 + h * 0.07;
      // Lifted clear of the ground line: they sit on a slope, and the ground
      // band drawn after this would otherwise bury half of each figure.
      vec2 fp = vec2(mod(fx, 0.30) - 0.15,
                     uv.y - groundOd(cx, scroll, 12.4, -0.25, 0.55) - 0.012) / sc;
      float fd = slumpedOd(fp, 0.3 + h * 0.7) * sc;
      col = mix(col, vec3(0.030, 0.045, 0.022), smoothstep(px, -px, fd));
      col += vec3(0.60, 0.70, 0.22) * smoothstep(px * 2.2, 0.0, abs(fd))
           * (0.35 + fallen_react * 0.7);
    }
  }

  // Ground.
  col *= mix(0.06, 1.0, bandOd(uv, scroll, 12.4, -0.25, 0.55, px));

  vec3 key = vec3(0.75, 1.00, 0.35);
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.6 + walk_react * 0.9);

  // Particulate, over everything, two layers at different speeds. This is the
  // one thing in the suite that is allowed to bury the traveller.
  if(fumes_visible > 0.5){
    float f1 = fbmOd(vec2(uv.x * 1.7 + scroll * 1.6, uv.y * 1.2 - iTime * 0.06));
    float f2 = fbmOd(vec2(uv.x * 3.4 - scroll * 2.6 + 9.0, uv.y * 2.3 - iTime * 0.11));
    float f = clamp((f1 * 0.65 + f2 * 0.45) * (0.35 + fumes_react * 0.95), 0.0, 0.92);
    col = mix(col, vec3(0.30, 0.32, 0.10), f);
    col += vec3(0.10, 0.11, 0.03) * f2 * fumes_react * 0.4;
  }

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

export const miasma: ShaderDef = {
  id: 'miasma',
  name: 'Odyssey V — Miasma',
  description:
    'The fourth journey: the air itself has turned. A jaundiced sky, a sun that cannot get through, scrolling particulate, and figures along the ridge who have stopped walking.',
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
      defaultLevel: 0.25,
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
      id: 'fumes',
      name: 'Fumes',
      description:
        'Two layers of particulate scrolling over the whole frame. At the top of its range it buries everything but the traveller.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.45,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'fallen',
      name: 'The Fallen',
      description:
        'Slumped silhouettes along the ridge. React lifts their outline out of the murk; hide for an empty landscape.',
      defaultBand: 'low',
      defaultAmount: 0.7,
      defaultLevel: 0.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sun',
      name: 'Sun',
      description: 'The dimmed disc and its bloom behind the haze.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Discharge',
      description:
        'Plasma’s filaments let loose in the open air: thin green arcs falling out of a twisted noise field, so the sky itself reads as discharging. React drives how hard they burn. Hide for an empty sky.',
      defaultBand: 'high',
      defaultAmount: 0.9,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
