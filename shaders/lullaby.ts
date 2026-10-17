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
 * Played in the first person (see odyssey.ts).
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

float sceneMapOd(vec3 p){
  gMatOd = 0.0;
  return groundDistOd(p, 0.6, 7.9);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float stride = 0.3 + walk_react * 0.8;
  float sw = 0.9 + sword_react * 1.3;

  vec3 ro, rd;
  fpsCamOd(fragCoord, 0.6, 7.9, stride, ro, rd);
  vec2 sky = skyUvOd(rd);

  // The detonation. Hidden means it never happens.
  float b = 0.0;
  if(blast_visible > 0.5){
    b = clamp(pow(max(0.0, sin(iTime * 0.13)), 24.0) + blast_react * 0.7, 0.0, 1.6);
  }
  vec3 hot = vec3(1.00, 0.94, 0.82);
  // Where it is: ahead and to the right, far enough that it sits on the
  // horizon. Kept a fixed way off from you rather than fixed in the world, so
  // it stays where the cloud in the sky is drawn.
  // sky.x = azimuth * 1.42, and positive azimuth is screen-right, which is -x
  // in the world when you face +z.
  float baz = 0.42 / 1.42;
  vec2 gz = vec2(-sin(baz) * 320.0, walkedOd() + cos(baz) * 320.0);
  vec3 blastDir = normalize(vec3(gz.x - ro.x, 6.0, gz.y - ro.z));

  // Night: deep blue overhead, a colder wash at the horizon.
  float e = clamp(rd.y * 2.2, 0.0, 1.0);
  vec3 horizon = vec3(0.06, 0.10, 0.26);
  vec3 col = mix(horizon, vec3(0.01, 0.02, 0.09), e);
  col += vec3(0.10, 0.18, 0.34) * pow(max(0.0, 1.0 - abs(rd.y) * 4.0), 3.0);
  col += vec3(0.05, 0.09, 0.20) * fbmOd(vec2(sky.x * 1.1, sky.y * 2.2 + 4.0)) * 0.5;
  vec3 skyCol = col;

  float mat;
  float t = marchOd(ro, rd, 220.0, mat);

  if(mat < -0.5){
    float up = smoothstep(-0.02, 0.1, rd.y);
    if(sky_visible > 0.5) col += skyCloudOd(sky, sky_react, b) * up;
    if(stars_visible > 0.5){
      float st = starsOd(sky, 34.0, 0.7) + starsOd(sky * 1.9 + vec2(0.0, 11.0), 34.0, 1.0) * 0.6;
      col += vec3(0.80, 0.88, 1.0) * st * (0.45 + stars_react * 0.9) * up * (1.0 - min(b, 1.0) * 0.7);
    }
    if(moon_visible > 0.5){
      // As a true angle from a direction rather than a circle in sky
      // coordinates, which comes out as an oval once it is projected.
      vec3 md3 = normalize(vec3(0.279, 0.292, 0.915));
      float md = acos(clamp(dot(rd, md3), -1.0, 1.0));
      col += vec3(0.75, 0.82, 1.0) * smoothstep(0.072, 0.067, md) * (0.7 + moon_react * 0.6);
      col += vec3(0.35, 0.50, 0.85) * pow(max(0.0, 1.0 - md * 3.1), 4.0) * (0.25 + moon_react * 0.6);
    }
    if(b > 0.001){
      // Column and cap as one union, with the cap outline boiled.
      vec2 bp = sky - vec2(0.42, -0.24);
      float colw = 0.020 + b * 0.026;
      float colh = 0.12 + b * 0.30;
      vec2 cp = bp - vec2(0.0, colh);
      float capr = 0.060 + b * 0.075;
      float boil = fbmOd(vec2(cp.x * 7.0, cp.y * 7.0 - iTime * 0.8)) - 0.5;
      float cloud = min(sdSegOd(bp, vec2(0.0, 0.0), vec2(0.0, colh), colw),
                        length(cp * vec2(0.58, 1.05)) - capr - boil * capr * 0.5);
      float px = 0.004;
      col = mix(col, hot, smoothstep(px * 2.0, -px * 2.0, cloud) * min(b, 1.0));
      float bd = length(bp);
      col += hot * pow(max(0.0, 1.0 - bd * 3.2), 5.0) * b * 1.4;
      col += hot * pow(max(0.0, 1.0 - bd * 1.1), 2.5) * b * 0.45;
    }
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);
    // The moon is up and to the left, which is +x facing +z.
    vec3 moon = normalize(vec3(0.279, 0.292, 0.915));
    float dif = clamp(dot(n, moon), 0.0, 1.0);
    vec3 base = vec3(0.035, 0.045, 0.08);
    vec3 g = base * (vec3(0.5, 0.6, 1.0) * dif * 1.6 + vec3(0.18, 0.24, 0.45) * (0.5 + 0.5 * n.y));
    // The flash lights everything that faces it.
    g += vec3(0.25, 0.22, 0.18) * hot * clamp(dot(n, blastDir), 0.0, 1.0) * b * 1.6;
    // Shock fronts rolling out across the ground, towards you.
    if(b > 0.001){
      float rr = length(p.xz - gz);
      g += hot * pow(sin(rr * 0.08 - iTime * 6.0) * 0.5 + 0.5, 10.0)
         * smoothstep(420.0, 40.0, rr) * b * 0.55;
    }
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    vec3 keyT = mix(vec3(0.55, 0.75, 1.00), vec3(1.00, 0.90, 0.70), clamp(b, 0.0, 1.0));
    g += keyT * rim * (0.16 + b * 0.3) * exp(-t * 0.01);
    col = fogOd(g, mix(skyCol, hot * 0.5, min(b, 1.0) * 0.5), t, 0.010);
  }

  // The whole sky goes white at the peak.
  col += vec3(1.0, 0.95, 0.85) * b * 0.18;

  vec3 key = mix(vec3(0.55, 0.75, 1.00), vec3(1.00, 0.90, 0.70), clamp(b, 0.0, 1.0));
  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.55 + walk_react * 0.8 + b * 0.8);

  col *= 1.0 - 0.45 * pow(clamp(length(gUvOd * vec2(0.85, 1.25)), 0.0, 1.0), 2.5);
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
    'The third journey, in the first person: a silent night of soft stars and a low moon over moonlit dunes — until the horizon goes white and the shock rolls towards you. Put Blast on the kick and it lands on the beat.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'walk',
      name: 'Traveller',
      description:
        
        'You. How hard each step lands — the head bob and the sword swinging with it. The pace itself follows the motion clock, so the walk quickens with the music. Hide to put the sword away.',
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
        
        'Size of the blade in your hand. Push the level and it runs off the top of the frame.',
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
        
        'The detonation on the horizon: column, cap, a flash that lights the ground and shock fronts rolling across it towards you. Carries a slow automatic cycle; react pushes it.',
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
