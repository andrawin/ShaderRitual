/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 1 — "Revelry". The first journey, and the only one that is purely
 * good: clean air, a sky that has never been dirty, and a landscape that
 * behaves like a party. Aurora ribbons roll overhead, crystal spires glow up
 * out of the ridge, and spores drift through the whole frame.
 *
 * This is the palette the rest of the suite is measured against — the magenta
 * and cyan of The Artful Escape's cavern, at full saturation. Extraction takes
 * this exact sky and drains it; Cinder burns what is left of it.
 *
 * Shares the suite's grammar (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float aurora_react;
uniform float aurora_visible;
uniform float spires_react;
uniform float spires_visible;
uniform float motes_react;
uniform float motes_visible;

${odysseyLib}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.045 - iCamOrbit * 0.03;

  float spd = 0.030 + walk_react * 0.070;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);
  float gy  = groundOd(wx, scroll, 5.7, -0.26, 0.55);

  // Clean sky: deep violet overhead into hot magenta at the horizon.
  float s = clamp(uv.y + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.55, 0.10, 0.45), vec3(0.10, 0.03, 0.30), s);
  col += vec3(0.9, 0.25, 0.6) * pow(max(0.0, 1.0 - abs(uv.y + 0.26) * 1.8), 4.0) * 0.5;

  if(aurora_visible > 0.5){
    float a = 0.0;
    for(int i = 0; i < 3; i++){
      float fi = float(i);
      float yy = uv.y - 0.10 - fi * 0.09;
      float wv = fbmOd(vec2(uv.x * 1.6 + scroll * 2.0 + fi * 4.0, iTime * 0.12 + fi)) - 0.5;
      a += smoothstep(0.075, 0.0, abs(yy - wv * 0.22)) * (1.0 - fi * 0.22);
    }
    vec3 ac = mix(vec3(0.20, 1.00, 0.80), vec3(0.70, 0.35, 1.00),
                  0.5 + 0.5 * sin(iTime * 0.3));
    col += ac * a * (0.25 + aurora_react * 0.8);
  }

  // Crystal spires, tapering as they rise, lit from inside.
  if(spires_visible > 0.5){
    float sx = uv.x + scroll * 1.4;
    float cell = floor(sx / 0.26);
    float h = hashOd(vec2(cell, 11.0));
    float lx = mod(sx, 0.26) - 0.13;
    float top = -0.16 + h * 0.30;
    float ty = clamp((uv.y + 0.30) / max(top + 0.30, 1e-3), 0.0, 1.0);
    float wdt = (0.012 + h * 0.020) * (1.0 - ty * 0.85);
    float m = smoothstep(px, -px, abs(lx) - wdt)
            * smoothstep(px, -px, uv.y - top)
            * smoothstep(-px, px, uv.y + 0.30)
            * step(0.45, h);
    vec3 sc = mix(vec3(0.15, 0.90, 1.00), vec3(1.00, 0.30, 0.85), h);
    col = mix(col, sc * (0.5 + spires_react * 1.2), m * 0.9);
    // a soft bleed so they read as lit glass rather than cut paper
    col += sc * smoothstep(0.05, 0.0, abs(lx) - wdt)
              * smoothstep(top + 0.05, top - 0.2, uv.y)
              * step(0.45, h) * (0.10 + spires_react * 0.25);
  }

  // Ground: a far violet band and a near black one.
  col = mix(col * vec3(0.35, 0.18, 0.45), col,
            bandOd(uv, scroll * 0.55, 2.3, -0.20, 0.70, px));
  col *= mix(0.05, 1.0, bandOd(uv, scroll, 5.7, -0.26, 0.55, px));

  vec3 key = vec3(0.35, 1.00, 0.95);
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.7 + walk_react * 0.9);

  // Spores, over everything — this is the air the rest of the suite loses.
  if(motes_visible > 0.5){
    float m = motesOd(uv + vec2(scroll, 0.0), 14.0, 0.06, 0.55);
    vec3 mc = mix(vec3(1.00, 0.85, 0.40), vec3(0.40, 1.00, 0.95), fract(uv.x * 3.0));
    col += mc * m * (0.4 + motes_react * 1.2);
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

export const revelry: ShaderDef = {
  id: 'revelry',
  name: 'Odyssey II — Revelry',
  description:
    'The first journey: clean air and a landscape behaving like a party. Aurora ribbons, glowing crystal spires and drifting spores in full magenta and cyan.',
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
      id: 'aurora',
      name: 'Aurora',
      description:
        'The ribbons rolling overhead. React swells them and shifts their hue between green and violet.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'spires',
      name: 'Spires',
      description: 'The lit crystal columns growing out of the ridge. React drives what is inside them.',
      defaultBand: 'low',
      defaultAmount: 0.9,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'motes',
      name: 'Spores',
      description: 'Drifting particles in the clean air. React brightens the whole field.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
