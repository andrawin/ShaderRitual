/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 3 — "Lullaby". The third journey: a silent night, a sky thick with
 * soft stars and a low moon, everything as still as a room with a sleeping
 * child in it. Then the horizon goes white.
 *
 * The two halves are deliberately on separate faders. With Blast hidden this
 * is a pure calm scene and can be left running as long as you like. With Blast
 * visible it carries a slow automatic swell, and its band punches on top — put
 * it on the kick and the detonation lands on the beat: white core, a column
 * that grows with the hit, shock rings rolling out, and the whole sky flashed.
 *
 * Shares the suite's grammar (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float stars_react;
uniform float stars_visible;
uniform float moon_react;
uniform float moon_visible;
uniform float blast_react;
uniform float blast_visible;
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: a real volumetric cloud. Density is three octaves of 3D value noise
 * sampled at the marched position, integrated front to back with a running
 * transmittance, so nearer cloud actually occludes further cloud instead of
 * summing with it — that occlusion is what gives it body.
 *
 * The march also carries the blast: b lights the underside and warms it, so the
 * detonation happens inside the sky rather than in front of it, and the cloud
 * above it goes bright while the cloud behind stays cold.
 */
vec3 skyCloudOd(vec2 uv, float react, float b){
  vec3 rd = skyRayOd(uv, 0.90);
  vec3 ro = vec3(0.0, 0.0, iTime * 0.05);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float t = 0.8;
  for(int i = 0; i < 20; i++){
    vec3 p = ro + rd * t;
    float dns = fbmVolOd(p * 0.85) - 0.44 - t * 0.010;
    if(dns > 0.0){
      float dd = clamp(dns * 0.55 * (0.5 + react * 1.0), 0.0, 0.6);
      // Thin cloud is the lit edge and thick cloud is the shadowed core —
      // a free stand-in for a light march, and what stops the integral
      // averaging out to one flat grey.
      float edge = smoothstep(0.16, 0.0, dns);
      vec3 c = mix(vec3(0.09, 0.13, 0.40), vec3(0.26, 0.22, 0.58),
                   clamp(dns * 3.0, 0.0, 1.0));
      c += vec3(0.55, 0.64, 0.98) * edge * 0.42;
      c = mix(c, vec3(1.00, 0.88, 0.66),
              clamp(b, 0.0, 1.0) * smoothstep(1.6, -0.4, p.y));
      acc += c * dd * trans;
      trans *= 1.0 - dd;
      if(trans < 0.03) break;
    }
    t += 0.22;
  }
  // Kept low by default: it is a silent night, and cloud that lifts the whole
  // sky off black takes the quiet out of the scene.
  return acc * (0.30 + react * 0.55);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = frameOd(fragCoord);
  float px = pxOd();
  float scroll = -iTime * 0.018 - iCamOrbit * 0.02;

  float spd = 0.010 + walk_react * 0.040;
  float sw  = 0.9 + sword_react * 1.3;
  float wx  = travellerXOd(spd);
  float gy  = groundOd(wx, scroll, 7.9, -0.25, 0.60);

  // The detonation. Hidden means it never happens.
  float b = 0.0;
  if(blast_visible > 0.5){
    b = clamp(pow(max(0.0, sin(iTime * 0.13)), 24.0) + blast_react * 0.7, 0.0, 1.6);
  }

  // Night sky: deep blue overhead, a colder wash at the horizon.
  float s = clamp(uv.y + 0.5, 0.0, 1.0);
  vec3 col = mix(vec3(0.06, 0.10, 0.26), vec3(0.01, 0.02, 0.09), s);
  col += vec3(0.10, 0.18, 0.34) * pow(max(0.0, 1.0 - abs(uv.y + 0.25) * 2.0), 3.0);
  col += vec3(0.05, 0.09, 0.20) * fbmOd(vec2(uv.x * 1.1 + scroll, uv.y * 2.2 + 4.0)) * 0.5;

  // Background, behind everything.
  float gyx = groundOd(uv.x, scroll, 7.9, -0.25, 0.60);
  if(sky_visible > 0.5 && uv.y > gyx - 0.02){
    col += skyCloudOd(uv, sky_react, b) * skyFadeOd(uv.y, gyx);
  }

  if(stars_visible > 0.5){
    float st = starsOd(uv + vec2(scroll * 0.25, 0.0), 34.0, 0.7)
             + starsOd(uv * 1.9 + vec2(scroll * 0.15, 11.0), 34.0, 1.0) * 0.6;
    col += vec3(0.80, 0.88, 1.0) * st * (0.45 + stars_react * 0.9);
  }

  if(moon_visible > 0.5){
    vec2 mp = uv - vec2(-0.42, 0.18);
    float md = length(mp);
    col += vec3(0.75, 0.82, 1.0) * smoothstep(0.105, 0.098, md) * (0.7 + moon_react * 0.6);
    col += vec3(0.35, 0.50, 0.85) * pow(max(0.0, 1.0 - md * 2.2), 4.0)
         * (0.25 + moon_react * 0.6);
  }

  // Far ridge.
  col = mix(col * vec3(0.30, 0.36, 0.60), col,
            bandOd(uv, scroll * 0.5, 6.2, -0.19, 0.75, px));

  if(b > 0.001){
    vec2 bp = uv - vec2(0.42, -0.24);
    float bd = length(bp);
    vec3 hot = vec3(1.00, 0.94, 0.82);

    // Column and cap as one union, so the cap sits on the stem instead of
    // floating over it, with its outline boiled so it is not a clean ellipse.
    float colw = 0.020 + b * 0.026;
    float colh = 0.12 + b * 0.30;
    vec2 cp = bp - vec2(0.0, colh);
    float capr = 0.060 + b * 0.075;
    float boil = fbmOd(vec2(cp.x * 7.0, cp.y * 7.0 - iTime * 0.8)) - 0.5;
    float cloud = min(sdSegOd(bp, vec2(0.0, 0.0), vec2(0.0, colh), colw),
                      length(cp * vec2(0.58, 1.05)) - capr - boil * capr * 0.5);
    col = mix(col, hot, smoothstep(px * 2.0, -px * 2.0, cloud) * min(b, 1.0));

    // Core, ground flash and the sky going white.
    col += hot * pow(max(0.0, 1.0 - bd * 3.2), 5.0) * b * 1.4;
    col += hot * pow(max(0.0, 1.0 - bd * 1.1), 2.5) * b * 0.45;
    col += vec3(1.0, 0.95, 0.85) * b * 0.22;

    // Shock fronts rolling out along the ground. Squashing the radius flattens
    // them onto the horizon — unsquashed they read as ripples in a pond.
    float rr = length(bp * vec2(1.0, 3.2));
    col += hot * pow(sin(rr * 30.0 - iTime * 6.0) * 0.5 + 0.5, 10.0)
         * smoothstep(0.8, 0.05, rr) * b * 0.45;
  }

  col *= mix(0.04, 1.0, bandOd(uv, scroll, 7.9, -0.25, 0.60, px));

  // The traveller is backlit by it: the rim warms as the blast grows.
  vec3 key = mix(vec3(0.55, 0.75, 1.00), vec3(1.00, 0.90, 0.70), clamp(b, 0.0, 1.0));
  float d = travellerOd(uv, wx, gy, 0.30, spd, sw, walk_visible);
  col *= smoothstep(-px, px, d);
  col += key * smoothstep(px * 2.5, 0.0, abs(d)) * (0.55 + walk_react * 0.8 + b * 0.8);
  // Suit piping, drawn only where it falls inside the cut-out — outside it
  // would read as a thicker outline rather than as costume.
  col += key * smoothstep(px * 1.7, 0.0, gTrimOd)
       * (1.0 - smoothstep(-px, px, d)) * (0.55 + walk_react * 0.7);

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

export const lullaby: ShaderDef = {
  id: 'lullaby',
  name: 'Odyssey IV — Lullaby',
  description:
    'The third journey: a silent night of soft stars and a low moon — until the horizon goes white. Put Blast on the kick and the detonation lands on the beat.',
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
      id: 'stars',
      name: 'Stars',
      description: 'Two layers of soft stars over the whole sky. React drives the twinkle.',
      defaultBand: 'high',
      defaultAmount: 0.5,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'moon',
      name: 'Moon',
      description: 'The low moon and its halo. Hide for stars alone.',
      defaultBand: 'mid',
      defaultAmount: 0.4,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'blast',
      name: 'Blast',
      description:
        'The detonation: column, core, shock rings and a sky flash, with the traveller backlit by it and the nebula lit from underneath. Carries a slow automatic swell; assign it to the kick to land it on the beat. Hide to keep the night silent.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Nebula',
      description:
        'A real volumetric cloud marched through the night sky — 3D noise integrated front to back, so nearer cloud occludes further cloud rather than summing with it. The blast lights its underside. React drives density. Hide for stars on bare sky.',
      defaultBand: 'mid',
      defaultAmount: 0.7,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
