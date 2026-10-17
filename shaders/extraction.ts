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
 * Played in the first person (see odyssey.ts).
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

float gDrOd = 0.0;

/* The land, cut into benches as the drain rises — an open pit, terraced away
 * from the lane. The lane itself stays smooth, so the walk does not stair-step. */
float pitOd(vec2 xz){
  float h = terrainOd(xz, 0.7, 4.1);
  float stepH = 1.6;
  float k = h / stepH;
  float bench = (floor(k) + smoothstep(0.78, 1.0, fract(k))) * stepH;
  return mix(h, bench, gDrOd * smoothstep(3.0, 11.0, abs(xz.x)));
}

/*
 * Derricks: a narrowing lattice tower with a nodding pump arm. The four legs
 * are one capsule folded into each quadrant with abs(), and each bracing level
 * is two, so a whole tower costs about what a single leg would.
 */
float sceneMapOd(vec3 p){
  float dg = (p.y - pitOd(p.xz)) * 0.55;
  float d = dg;
  gMatOd = 0.0;
  if(rigs_visible > 0.5){
    float sp = 14.0;
    float cz = cellOd(p.z, sp);
    float side = p.x < 0.0 ? -1.0 : 1.0;
    float h = hashOd(vec2(cz, side * 5.0 + 21.0));
    if(h > 0.35){
      vec3 c = vec3(side * (9.0 + h * 9.0), 0.0, cz * sp);
      c.y = pitOd(c.xz) - 0.3;
      vec3 q = p - c;
      float ht = 7.0 + h * 6.0;
      vec3 f = vec3(abs(q.x), q.y, abs(q.z));
      float wb = 1.4, wt = 0.3;
      float rig = sdSeg3Od(f, vec3(wb, 0.0, wb), vec3(wt, ht, wt)) - 0.07;
      for(int i = 0; i < 2; i++){
        float fy = (float(i) + 1.0) / 3.0;
        float wf = mix(wb, wt, fy);
        float y = ht * fy;
        rig = min(rig, sdSeg3Od(f, vec3(0.0, y, wf), vec3(wf, y, wf)) - 0.05);
        rig = min(rig, sdSeg3Od(f, vec3(wf, y, 0.0), vec3(wf, y, wf)) - 0.05);
      }
      // The pump arm nods on its own clock; react drives how far it swings.
      float nod = sin(iTime * (1.2 + h) + h * 12.0) * 0.6 * (0.4 + rigs_react);
      rig = min(rig, sdSeg3Od(q, vec3(0.0, ht, 0.0), vec3(-side * 3.0, ht + nod, 0.0)) - 0.14);
      if(rig < d){ d = rig; gMatOd = 1.0; }
      // The one warning light left burning on the mast.
      float lamp = length(q - vec3(0.0, ht + 0.35, 0.0)) - 0.22;
      if(lamp < d){ d = lamp; gMatOd = 2.0; }
    }
    if(dg < 8.5) gCapOd = min(gCapOd, cellEdgeOd(p.z, cz, sp));
  }
  return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  gDrOd = clamp(drain_react, 0.0, 1.0);
  float dr = gDrOd;
  float stride = 0.4 + walk_react * 0.9;
  float sw = 0.9 + sword_react * 1.3;

  vec3 ro, rd;
  fpsCamOd(fragCoord, 0.7, 4.1, stride, ro, rd);
  vec2 sky = skyUvOd(rd);
  vec3 key = mix(vec3(0.35, 1.00, 0.95), vec3(1.00, 0.55, 0.18), dr);

  // The sky Revelry had, crossfaded into the one it is being turned into.
  float e = clamp(rd.y * 2.2, 0.0, 1.0);
  vec3 skyA = mix(vec3(0.42, 0.10, 0.38), vec3(0.09, 0.03, 0.22), e);
  vec3 skyB = mix(vec3(0.40, 0.29, 0.16), vec3(0.10, 0.09, 0.10), e);
  vec3 horizon = mix(vec3(0.42, 0.10, 0.38), vec3(0.40, 0.29, 0.16), dr);
  vec3 col = mix(skyA, skyB, dr);
  col += mix(vec3(0.9, 0.25, 0.6), vec3(0.55, 0.38, 0.14), dr)
       * pow(max(0.0, 1.0 - abs(rd.y) * 4.0), 4.0) * 0.45;
  vec3 skyCol = col;

  float mat;
  float t = marchOd(ro, rd, 200.0, mat);

  if(mat < -0.5){
    if(sky_visible > 0.5) col += skyMachineOd(sky, sky_react) * smoothstep(-0.02, 0.1, rd.y);
    // Plumes standing up off the horizon, thickening as they climb.
    if(smoke_visible > 0.5){
      float sm = fbmOd(vec2(sky.x * 2.0, sky.y * 1.4 - iTime * 0.10));
      sm *= smoothstep(-0.30, 0.35, sky.y) * smoothstep(0.60, 0.10, sky.y);
      col = mix(col, vec3(0.16, 0.14, 0.13), clamp(sm * (0.35 + smoke_react * 0.9), 0.0, 0.85));
    }
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);
    vec3 sun = normalize(vec3(0.25, 0.3, 1.0));
    float dif = clamp(dot(n, sun), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    vec3 g;
    if(mat < 0.5){
      // Violet earth turning to spoil as it is dug out.
      vec3 base = mix(vec3(0.08, 0.035, 0.10), vec3(0.11, 0.095, 0.08), dr);
      g = base * (horizon * dif * 2.4 + vec3(0.2, 0.15, 0.22) * (0.5 + 0.5 * n.y));
      g += key * rim * 0.22 * exp(-t * 0.01);
    } else if(mat < 1.5){
      // Steel, nearly black against the sky, catching a little sun.
      g = vec3(0.03, 0.028, 0.03) * (0.4 + dif * 2.0) + key * rim * 0.35;
    } else {
      g = vec3(1.0, 0.25, 0.12) * (1.5 + rigs_react * 2.0);
    }
    // Smoke lies in the pit and thickens the air.
    float dens = 0.010 + (smoke_visible > 0.5 ? smoke_react * 0.008 : 0.0);
    col = fogOd(g, mix(skyCol, vec3(0.16, 0.14, 0.13), dr * 0.6), t, dens);
  }

  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.7 + walk_react * 0.9);

  // Grit in the air, only once the drain is on.
  col += (hashOd(floor(gUvOd * iResolution.y * 0.5) + floor(iTime * 24.0)) - 0.5) * 0.05 * dr;

  col *= 1.0 - 0.4 * pow(clamp(length(gUvOd * vec2(0.85, 1.25)), 0.0, 1.0), 2.5);
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
    'The second journey, where it turns, in the first person. Derricks nodding along the path, plumes on the horizon, and the land either side cut into mine benches as the colour drains out of the sky.',
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
      defaultLevel: 0.3,
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
      id: 'rigs',
      name: 'Derricks',
      description:
        
        'The derricks lining the path, pump arms nodding. React drives how hard they nod and how bright their warning lights burn.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.25,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'smoke',
      name: 'Plumes',
      description: 
        'The plumes standing up off the horizon. React thickens them and the air in the pit.',
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
        
        'The scene itself. Pulls the sky from magenta to ochre grey and cuts the land either side of the path into mine benches. Ride it 0 to 2 across a track to mine the landscape out from under you.',
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
