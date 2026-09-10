/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 2 — "Extraction". The second journey, where it turns. Derricks come
 * up over the ridge and start nodding, plumes go up, and the colour goes out
 * of everything.
 *
 * Drain is the scene, and it does two things at once. It crossfades the sky
 * from Revelry's magenta to a flat ochre grey, and it quantises the hillside:
 * the same sin-stack ridge every other scene uses gets floored into benches,
 * so the natural hill becomes a stepped open pit as you push the fader. Run it
 * from 0 to 2 across a track and the landscape is mined in front of the
 * audience.
 *
 * Shares the suite's grammar (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float rigs_react;
uniform float rigs_visible;
uniform float smoke_react;
uniform float smoke_visible;
uniform float drain_react;
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Machina's fold, hung overhead as a machine the scene is being fed
 * to. Space is folded abs()-and-rotate a few times and a box is measured in the
 * folded coordinate, which turns one box into a lattice of them; accumulating
 * 1/(1+d*d) along the ray renders it as edges of light rather than solid, which
 * is both cheaper than shading it and closer to the scene's flat silhouettes.
 *
 * Machina drives its fold count from a band, and so does this: react adds folds
 * as well as brightness, so the machinery genuinely restructures on the music.
 */
float machDeOd(vec3 p, float folds, float t){
  p.xz *= rotOd(t * 0.12);
  p.xy *= rotOd(sin(t * 0.09) * 0.4);
  for(int i = 0; i < 6; i++){
    if(float(i) >= folds) break;
    p = abs(p) - 1.9 - float(i) * 0.35;
    p.xy *= rotOd(0.34 + sin(t * 0.18) * 0.14);
    p.yz *= rotOd(-0.27);
  }
  // Edges rather than faces. A folded box's *surface* is everywhere once it has
  // been folded a few times, so accumulating against it renders as fog; its
  // frame is a sparse set of struts, which is what reads as machinery.
  vec3 q = abs(abs(p) - 1.5);
  return min(min(max(q.x, q.y), max(q.y, q.z)), max(q.x, q.z)) - 0.06;
}

vec3 skyMachineOd(vec2 uv, float react){
  vec3 rd = skyRayOd(uv, 0.85);
  vec3 ro = vec3(0.0, 0.0, -11.0);
  float folds = floor(3.0 + react * 1.6);
  float g = 0.0;
  float d = 0.0;
  for(int i = 0; i < 28; i++){
    float de = machDeOd(ro + rd * d, folds, iTime);
    g += 0.010 / (0.010 + de * de);
    d += max(abs(de) * 0.8, 0.09);
    if(d > 20.0) break;
  }
  return vec3(0.74, 0.54, 0.32) * g * 0.045 * (0.4 + react * 1.0);
}

/* The hillside, cut into benches as the drain rises. */
float mineOd(float x, float scroll, float dr){
  float r = ridgeOd(x + scroll, 9.3) * 0.6;
  return -0.25 + mix(r, floor(r * 26.0) / 26.0, dr);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.040 - iCamOrbit * 0.03;
  float dr = clamp(drain_react, 0.0, 1.0);

  float spd = 0.026 + walk_react * 0.060;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);
  float gy  = mineOd(wx, scroll, dr);

  // The sky Revelry had, crossfaded into the one it is being turned into.
  float s = clamp(uv.y + 0.5, 0.0, 1.0);
  vec3 skyA = mix(vec3(0.42, 0.10, 0.38), vec3(0.09, 0.03, 0.22), s);
  vec3 skyB = mix(vec3(0.40, 0.29, 0.16), vec3(0.10, 0.09, 0.10), s);
  vec3 col = mix(skyA, skyB, dr);
  col += mix(vec3(0.9, 0.25, 0.6), vec3(0.55, 0.38, 0.14), dr)
       * pow(max(0.0, 1.0 - abs(uv.y + 0.25) * 1.8), 4.0) * 0.45;

  // Background, behind everything.
  float gyx = mineOd(uv.x, scroll, dr);
  if(sky_visible > 0.5 && uv.y > gyx - 0.02){
    col += skyMachineOd(uv, sky_react) * skyFadeOd(uv.y, gyx);
  }

  // A far ridge, already grey.
  col = mix(col * mix(vec3(0.40, 0.22, 0.45), vec3(0.30, 0.28, 0.26), dr), col,
            bandOd(uv, scroll * 0.55, 4.1, -0.19, 0.70, px));

  // Derricks: a narrowing lattice tower with a nodding arm on top.
  if(rigs_visible > 0.5){
    float rx = uv.x + scroll * 1.2;
    float cell = floor(rx / 0.34);
    float h = hashOd(vec2(cell, 21.0));
    if(h > 0.42){
      float cx = (cell + 0.5) * 0.34 - scroll * 1.2;
      vec2 rp = vec2(mod(rx, 0.34) - 0.17, uv.y - mineOd(cx, scroll, dr));
      float th = 0.16 + h * 0.14;
      float d = 1e5;
      d = min(d, sdSegOd(rp, vec2(-0.035, 0.0), vec2(-0.008, th), 0.006));
      d = min(d, sdSegOd(rp, vec2( 0.035, 0.0), vec2( 0.008, th), 0.006));
      for(int i = 0; i < 3; i++){
        float f = (float(i) + 1.0) / 4.0;
        float ww = mix(0.035, 0.008, f);
        d = min(d, sdSegOd(rp, vec2(-ww, th * f), vec2(ww, th * f), 0.004));
      }
      float nod = sin(iTime * (1.2 + h) + h * 12.0) * 0.10 * (0.4 + rigs_react);
      d = min(d, sdSegOd(rp, vec2(0.0, th), vec2(0.075, th + nod), 0.010));
      col = mix(col, vec3(0.030, 0.026, 0.028), smoothstep(px, -px, d));
      // the one warning light left burning on the mast
      col += vec3(1.0, 0.25, 0.12)
           * smoothstep(0.02, 0.0, length(rp - vec2(0.0, th + 0.02)))
           * (0.5 + rigs_react * 1.0);
    }
  }

  // Plumes, thickening as they climb.
  if(smoke_visible > 0.5){
    float sm = fbmOd(vec2(uv.x * 2.0 + scroll * 1.2, uv.y * 1.4 - iTime * 0.10));
    sm *= smoothstep(-0.30, 0.35, uv.y) * smoothstep(0.60, 0.10, uv.y);
    col = mix(col, vec3(0.16, 0.14, 0.13),
              clamp(sm * (0.35 + smoke_react * 0.9), 0.0, 0.85));
  }

  // The cut hillside.
  col *= mix(0.05, 1.0, smoothstep(-px, px, uv.y - mineOd(uv.x, scroll, dr)));

  vec3 key = mix(vec3(0.35, 1.00, 0.95), vec3(1.00, 0.55, 0.18), dr);
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.7 + walk_react * 0.9);
  // Suit piping, drawn only where it falls inside the cut-out — outside it
  // would read as a thicker outline rather than as costume.
  col += key * smoothstep(px * 1.7, 0.0, gTrimOd)
       * (1.0 - smoothstep(-px, px, d)) * (0.55 + walk_react * 0.7);

  // Grit in the air, only once the drain is on.
  col += (hashOd(floor(uv * iResolution.y * 0.5) + floor(iTime * 24.0)) - 0.5)
       * 0.05 * dr;

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

export const extraction: ShaderDef = {
  id: 'extraction',
  name: 'Odyssey III — Extraction',
  description:
    'The second journey, where it turns. Nodding derricks, rising plumes, and a hillside quantised into mine benches as the colour drains out of the sky.',
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
      id: 'rigs',
      name: 'Derricks',
      description:
        'The pumping rigs on the ridge. React drives how hard they nod and how bright their warning lights burn.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.25,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'smoke',
      name: 'Plumes',
      description: 'The smoke going up off the rigs. React thickens it across the sky.',
      defaultBand: 'mid',
      defaultAmount: 0.9,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'drain',
      name: 'Drain',
      description:
        'The scene itself. Pulls the sky from magenta to ochre grey and cuts the hillside into mine benches. Ride it 0 to 2 across a track to mine the landscape live.',
      defaultBand: 'mid',
      defaultAmount: 0.4,
      defaultLevel: 0.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Machine',
      description:
        'Machina’s folded lattice hung overhead as the machine this landscape is being fed to, rendered as edges of light. React adds folds as well as brightness, so it restructures on the music. Hide for an empty sky.',
      defaultBand: 'mid',
      defaultAmount: 0.9,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
