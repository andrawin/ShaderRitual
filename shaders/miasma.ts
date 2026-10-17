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
 * Played in the first person (see odyssey.ts).
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

/*
 * The fallen, lying where they dropped beside the path: a torso, head, an arm
 * thrown out and the legs, each turned by its own hash so no two lie the same
 * way. Close to the lane — the point is that you walk past them.
 */
float fallenOd(vec3 q){
  float d = sdSeg3Od(q, vec3(-0.40, 0.17, 0.0), vec3(0.35, 0.21, 0.0)) - 0.17;
  d = min(d, length(q - vec3(0.62, 0.19, 0.05)) - 0.13);
  d = min(d, sdSeg3Od(q, vec3(0.20, 0.20, 0.14), vec3(0.48, 0.07, 0.48)) - 0.06);
  d = min(d, sdSeg3Od(q, vec3(-0.40, 0.14, 0.06), vec3(-1.15, 0.09, 0.16)) - 0.09);
  d = min(d, sdSeg3Od(q, vec3(-0.40, 0.14, -0.06), vec3(-1.10, 0.10, -0.24)) - 0.09);
  return d;
}

float sceneMapOd(vec3 p){
  float dg = groundDistOd(p, 0.55, 12.4);
  float d = dg;
  gMatOd = 0.0;
  if(fallen_visible > 0.5){
    float sp = 6.0;
    float cz = cellOd(p.z, sp);
    float side = p.x < 0.0 ? -1.0 : 1.0;
    float h = hashOd(vec2(cz, side * 3.0 + 33.0));
    if(h > 0.32){
      vec3 c = vec3(side * (2.6 + h * 4.5), 0.0, cz * sp + (h - 0.5) * 2.5);
      c.y = terrainOd(c.xz, 0.55, 12.4) - 0.05;
      vec3 q = p - c;
      float a = h * 37.0;
      q.xz = mat2(cos(a), sin(a), -sin(a), cos(a)) * q.xz;
      float df = fallenOd(q);
      if(df < d){ d = df; gMatOd = 1.0; }
    }
    if(dg < 1.0) gCapOd = min(gCapOd, cellEdgeOd(p.z, cz, sp));
  }
  return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float stride = 0.3 + walk_react * 0.8;
  float sw = 0.9 + sword_react * 1.3;

  vec3 ro, rd;
  fpsCamOd(fragCoord, 0.55, 12.4, stride, ro, rd);
  vec2 sky = skyUvOd(rd);
  vec3 key = vec3(0.75, 1.00, 0.35);

  // Jaundiced sky.
  float e = clamp(rd.y * 2.2, 0.0, 1.0);
  vec3 horizon = vec3(0.46, 0.46, 0.14);
  vec3 col = mix(horizon, vec3(0.09, 0.13, 0.07), e);
  col += vec3(0.40, 0.36, 0.10) * pow(max(0.0, 1.0 - abs(rd.y) * 3.2), 3.0) * 0.6;
  vec3 skyCol = col;

  // A sun that cannot get through: up and to the right.
  vec3 sunDir = normalize(vec3(-0.226, 0.204, 0.953));

  float mat;
  float t = marchOd(ro, rd, 160.0, mat);

  if(mat < -0.5){
    if(sky_visible > 0.5) col += skyFilamentOd(sky, sky_react) * smoothstep(-0.02, 0.1, rd.y);
    if(sun_visible > 0.5){
      float sd = acos(clamp(dot(rd, sunDir), -1.0, 1.0));
      col += vec3(0.85, 0.72, 0.22) * smoothstep(0.06, 0.044, sd) * (0.45 + sun_react * 0.7);
      col += vec3(0.55, 0.48, 0.12) * pow(max(0.0, 1.0 - sd * 2.3), 3.0) * (0.25 + sun_react * 0.6);
    }
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);
    float dif = clamp(dot(n, sunDir), 0.0, 1.0) * (sun_visible > 0.5 ? 1.0 : 0.4);
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    vec3 g;
    if(mat < 0.5){
      vec3 base = vec3(0.07, 0.075, 0.035);
      g = base * (vec3(0.9, 0.85, 0.35) * dif * 2.0 + vec3(0.3, 0.32, 0.12) * (0.5 + 0.5 * n.y));
      g += key * rim * 0.12 * exp(-t * 0.015);
    } else {
      // Cut out dark, and picked out in the sickly green so they are not
      // mistaken for rocks.
      g = vec3(0.030, 0.045, 0.022) * (0.5 + dif);
      g += vec3(0.60, 0.70, 0.22) * rim * (0.35 + fallen_react * 0.8);
    }
    // The air itself is the subject: it thickens fast with distance.
    float dens = 0.022 + (fumes_visible > 0.5 ? fumes_react * 0.018 : 0.0);
    col = fogOd(g, skyCol, t, dens);
  }

  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.6 + walk_react * 0.9);

  // Particulate over everything, two layers, pinned to the sky so it hangs in
  // the world as you turn. This is the one thing in the suite that is allowed
  // to bury you.
  if(fumes_visible > 0.5){
    float drift = walkedOd() * 0.02;
    float f1 = fbmOd(vec2(sky.x * 1.7 - drift, sky.y * 1.2 - iTime * 0.06));
    float f2 = fbmOd(vec2(sky.x * 3.4 + 9.0 - drift * 2.0, sky.y * 2.3 - iTime * 0.11));
    float f = clamp((f1 * 0.65 + f2 * 0.45) * (0.25 + fumes_react * 0.85), 0.0, 0.9);
    col = mix(col, vec3(0.30, 0.32, 0.10), f);
    col += vec3(0.10, 0.11, 0.03) * f2 * fumes_react * 0.4;
  }

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

export const miasma: ShaderDef = {
  id: 'miasma',
  name: 'Odyssey V — Miasma',
  description:
    'The fourth journey, in the first person: the air itself has turned. A jaundiced haze, a sun that cannot get through, and the fallen lying beside the path as you walk past.',
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
      id: 'fumes',
      name: 'Fumes',
      description:
        
        'The air itself. Thickens the haze with distance and hangs particulate across the view. At the top of its range it buries everything.',
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
        
        'The fallen, lying beside the path as you walk past. React lifts their outline out of the murk; hide for an empty landscape.',
      defaultBand: 'low',
      defaultAmount: 0.7,
      defaultLevel: 0.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sun',
      name: 'Sun',
      description: 
        'The dimmed disc and its bloom, failing to get through.',
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
