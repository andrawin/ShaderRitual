/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 5 — "Cinder". The last journey: the forest and the air are both
 * alight, and behind the fire there is nothing but sand.
 *
 * Burn is the whole arc of the scene on one fader. It crossfades the ground
 * from the suite's sin-stack ridge to smooth dunes, thins the trees out (the
 * hash threshold a cell has to clear climbs from 0.42 to 0.97, so they go from
 * a forest to the last few), damps the fire down as there is less left to burn,
 * and lifts the sky from ember-orange to a pale desert haze. At 0 it is a
 * forest on fire; at 2 it is a desert that has already finished.
 *
 * The trees are Horizon's fractal tree, trimmed to five iterations — the one
 * direct quotation in the suite, and the reason this scene closes the arc that
 * Revelry's clean air opened.
 *
 * Shares the suite's grammar (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float fire_react;
uniform float fire_visible;
uniform float embers_react;
uniform float embers_visible;
uniform float trees_react;
uniform float trees_visible;
uniform float burn_react;
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Thunder's bolt, flattened onto the sky plane. Thunder builds its
 * lightning by giving every integer step along an axis a random lateral offset
 * and joining consecutive offsets with a segment — a chain of segments whose
 * kinks are hashed, which is why it looks jagged rather than wobbly. Only the
 * three segments around this pixel can be nearest, so three is all it checks.
 *
 * Firestorms really do make their own lightning, so this is the one sky in the
 * suite the scene would have produced on its own.
 */
float boltOd(vec2 p, float seed, float amp){
  float id = floor(p.x);
  float d = 1e5;
  for(int i = 0; i < 3; i++){
    float k = id + float(i) - 1.0;
    float y0 = (hashOd(vec2(k, seed)) - 0.5) * amp;
    float y1 = (hashOd(vec2(k + 1.0, seed)) - 0.5) * amp;
    d = min(d, sdSegOd(p, vec2(k, y0), vec2(k + 1.0, y1), 0.0));
  }
  return d;
}

vec3 skyStormOd(vec2 uv, float react){
  // A strike every couple of seconds, decaying fast; react can force one.
  float slot = floor(iTime / 2.2);
  float ph = fract(iTime / 2.2);
  float flash = exp(-ph * 9.0) * step(0.35, hashOd(vec2(slot, 3.0)));
  flash = max(flash, clamp(react - 0.65, 0.0, 1.0));
  if(flash < 0.004) return vec3(0.0);
  float sx = hashOd(vec2(slot, 7.0)) * 1.3 - 0.65;
  vec2 bp = vec2((0.5 - uv.y) * 6.0, (uv.x - sx) * 6.0);
  float d = boltOd(bp, slot, 1.0 + react * 0.8);
  vec3 c = vec3(1.00, 0.74, 0.44);
  return c * (0.045 / (0.045 + d * d)) * flash * (0.5 + react * 0.8)
       + c * flash * 0.05;
}

/* Forest ridge crossfading into dunes as the burn advances. */
float landOd(float x, float scroll, float bn){
  float f = ridgeOd(x + scroll, 13.7) * 0.5;
  float dn = sin((x + scroll) * 3.1) * 0.05 + sin((x + scroll) * 7.3 + 1.7) * 0.018;
  return -0.24 + mix(f, dn, bn);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.038 - iCamOrbit * 0.03;
  float bn = clamp(burn_react, 0.0, 2.0) * 0.5;

  float spd = 0.024 + walk_react * 0.055;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);
  float gy  = landOd(wx, scroll, bn);

  // Sky: ember orange under ash, lifting to desert haze as it finishes.
  float s = clamp(uv.y + 0.5, 0.0, 1.0);
  vec3 col = mix(mix(vec3(0.85, 0.28, 0.06), vec3(0.72, 0.50, 0.28), bn),
                 mix(vec3(0.10, 0.05, 0.06), vec3(0.28, 0.20, 0.16), bn), s);
  col += vec3(1.0, 0.45, 0.10) * pow(max(0.0, 1.0 - abs(uv.y + 0.24) * 1.5), 3.0)
       * 0.5 * (1.0 - bn * 0.6);

  // Background, behind everything — under the smoke, so the smoke veils it.
  float gyx = landOd(uv.x, scroll, bn);
  if(sky_visible > 0.5 && uv.y > gyx - 0.02){
    col += skyStormOd(uv, sky_react) * skyFadeOd(uv.y, gyx);
  }

  // Smoke lying across the sky.
  float sm = fbmOd(vec2(uv.x * 1.6 + scroll * 1.3, uv.y * 1.5 - iTime * 0.07));
  col = mix(col, vec3(0.13, 0.10, 0.10), clamp(sm * 0.45 * (1.0 - bn * 0.4), 0.0, 0.7));

  // Far ridge.
  col = mix(col * vec3(0.55, 0.35, 0.28), col,
            bandOd(uv, scroll * 0.5, 10.6, -0.18, 0.70, px));

  // The forest, thinning out as the burn advances.
  if(trees_visible > 0.5){
    float tx = uv.x + scroll * 1.15;
    float cell = floor(tx / 0.155);
    float h = hashOd(vec2(cell, 41.0));
    if(h > mix(0.42, 0.97, bn)){
      float cx = (cell + 0.5) * 0.155 - scroll * 1.15;
      vec2 tp = vec2(mod(tx, 0.155) - 0.0775, uv.y - landOd(cx, scroll, bn));
      float td = treeOd(tp, h * 4.3, 0.5 + trees_react);
      float m = smoothstep(0.07, 0.02, td);
      col = mix(col, vec3(0.020, 0.014, 0.016), m);
      // the crown catching
      col += vec3(1.0, 0.40, 0.08) * smoothstep(0.11, 0.07, td)
           * (0.25 + trees_react * 0.6) * (1.0 - bn * 0.7);
    }
  }

  // Ground: burnt black turning to sand.
  col = mix(mix(vec3(0.030, 0.020, 0.020), vec3(0.42, 0.29, 0.17), bn), col,
            smoothstep(-px, px, uv.y - landOd(uv.x, scroll, bn)));

  vec3 key = mix(vec3(1.00, 0.55, 0.15), vec3(1.00, 0.86, 0.58), bn);
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.7 + walk_react * 0.9);

  // The fire line hugging the ground, and what it throws up.
  if(fire_visible > 0.5){
    float hgt = uv.y - landOd(uv.x, scroll, bn);
    float fl = fbmOd(vec2(uv.x * 5.0 + scroll * 3.0, uv.y * 3.0 - iTime * 1.1));
    float band = smoothstep(0.22 + fl * 0.12, -0.01, hgt)
               * smoothstep(-0.05, 0.02, hgt) * (1.0 - bn * 0.55);
    col += mix(vec3(1.0, 0.35, 0.06), vec3(1.0, 0.80, 0.25), fl)
         * band * (0.5 + fire_react * 1.4);
  }

  if(embers_visible > 0.5){
    float e = motesOd(uv * 1.3 + vec2(scroll * 1.4, 0.0), 16.0, 0.22, 0.62);
    col += vec3(1.0, 0.42, 0.10) * e * (0.5 + embers_react * 1.6) * (1.0 - bn * 0.4);
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

export const cinder: ShaderDef = {
  id: 'cinder',
  name: 'Odyssey VI — Cinder',
  description:
    'The last journey: a forest and an air both on fire, with nothing but sand behind it. Ride Burn from 0 to 2 and the forest goes to desert in front of the audience.',
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
      id: 'fire',
      name: 'Fire',
      description:
        'The burning line along the ground. React makes it surge on the beat; it damps itself down as Burn rises and there is less left to take.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'embers',
      name: 'Embers',
      description: 'What the fire throws up into the air. React drives the density.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trees',
      name: 'Forest',
      description:
        'The fractal trees, straight out of Horizon. React sways them and lights their crowns; hide for bare ground.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'burn',
      name: 'Burn',
      description:
        'How far the fire has already got. Crossfades ridge to dunes, thins the forest to the last few trees, damps the fire and lifts the sky to desert haze. 0 is forest, 2 is desert.',
      defaultBand: 'mid',
      defaultAmount: 0.4,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Firestorm',
      description:
        'Thunder’s bolt striking through the smoke — firestorms make their own lightning. Strikes fire on their own every couple of seconds; push react past about 0.65 and the band fires them instead, so it cracks on the beat. Hide for smoke alone.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
