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
 * Played in the first person (see odyssey.ts).
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
 * The sky: a pyrocumulus cell with the bolt inside it. Firestorms really do
 * make their own lightning, so this is the one sky in the suite the scene would
 * have produced on its own.
 *
 * Thunder builds a bolt by giving every integer step along an axis a hashed
 * lateral offset and joining consecutive offsets with a segment — a chain whose
 * kinks are random, which is why it reads as jagged rather than wobbly. Only
 * the three segments around a point can be its nearest, so three is all it
 * checks. Here that chain is kept in 3D and marched together with the cloud, so
 * the strike is *behind* the smoke it lights rather than painted over it: the
 * cloud in front of the bolt goes bright, the cloud behind it stays dark, and
 * the whole cell flickers from inside.
 */
float bolt3Od(vec3 p, float seed, float amp){
  float id = floor(p.x);
  float d = 1e5;
  for(int i = 0; i < 3; i++){
    float k = id + float(i) - 1.0;
    vec3 a = vec3(k,       (hashOd(vec2(k,       seed)) - 0.5) * amp,
                           (hashOd(vec2(k,       seed + 13.0)) - 0.5) * amp);
    vec3 b = vec3(k + 1.0, (hashOd(vec2(k + 1.0, seed)) - 0.5) * amp,
                           (hashOd(vec2(k + 1.0, seed + 13.0)) - 0.5) * amp);
    d = min(d, sdSeg3Od(p, a, b));
  }
  return d;
}

vec3 skyStormOd(vec2 uv, float react){
  // A strike every couple of seconds, decaying fast; react can force one.
  float slot = floor(iTime / 2.2);
  float ph = fract(iTime / 2.2);
  float flash = exp(-ph * 8.0) * step(0.35, hashOd(vec2(slot, 3.0)));
  flash = max(flash, clamp(react - 0.65, 0.0, 1.0));

  vec3 rd = skyRayOd(uv, 0.90);
  vec3 acc = vec3(0.0);
  float trans = 1.0;
  float bx = hashOd(vec2(slot, 7.0)) * 3.0 - 1.5;
  float minBd = 1e5;   // closest the ray ever gets to the bolt
  float coreT = 1.0;   // and how much smoke was in front of it there
  float t = 0.9;
  for(int i = 0; i < 18; i++){
    vec3 p = rd * t;

    float bd = 1e5;
    if(flash > 0.01){
      // The chain runs down the world y axis, so bolt-space x is -y.
      vec3 lp = vec3((3.4 - p.y) * 1.25, (p.x - bx) * 1.25, (p.z - 2.6) * 0.9);
      bd = bolt3Od(lp, slot, 1.1 + react * 0.7) / 1.25;
      if(bd < minBd){ minBd = bd; coreT = trans; }
      // Wide scatter into the smoke around it, only partly occluded — fully
      // occluded is what physics wants and it loses the strike in its own cell.
      acc += vec3(1.00, 0.82, 0.58) * (0.05 / (0.05 + bd * bd))
           * flash * (0.25 + trans * 0.75) * 0.09;
    }

    float dns = fbmVolOd((p + vec3(iTime * 0.05, 0.0, 0.0)) * 0.70) - 0.50;
    if(dns > 0.0){
      float dd = clamp(dns * 0.60, 0.0, 0.5);
      vec3 c = mix(vec3(0.18, 0.08, 0.05), vec3(1.00, 0.44, 0.12),
                   clamp(dns * 2.6, 0.0, 1.0));
      c += vec3(1.00, 0.76, 0.46) * flash * exp(-bd * 1.1) * 1.3;
      acc += c * dd * trans * (0.45 + react * 0.8);
      trans *= 1.0 - dd;
      if(trans < 0.04) break;
    }
    t += 0.26;
  }

  // The channel itself, from the ray's closest approach rather than from
  // whichever steps happened to land near it — at 0.26 per step a curve this
  // thin is sampled two or three times, and summing those gives a smear.
  if(flash > 0.01){
    acc += vec3(1.00, 0.93, 0.80) * (0.004 / (0.004 + minBd * minBd))
         * flash * (0.35 + coreT * 0.65);
  }
  return acc;
}

float gBnOd = 0.0;

/* Forest ridge crossfading into dunes as the burn advances. The dunes are kept
 * low down the lane for the same reason the ridge is. */
float landOd(vec2 xz){
  float f = terrainOd(xz, 0.5, 13.7);
  float lane = mix(0.12, 1.0, smoothstep(2.5, 16.0, abs(xz.x)));
  float dn = (sin(xz.x * 0.09 + xz.y * 0.05) * 2.6 + sin(xz.x * 0.21 - xz.y * 0.13 + 1.7) * 0.9) * lane;
  return mix(f, dn, gBnOd);
}

/*
 * A burnt tree: a tapering trunk forking into three bare limbs. No crown — it
 * has already gone — and fewer of them stand as the burn finishes.
 */
float treeOd3(vec3 q, float h){
  float ht = 4.5 + h * 4.0;
  float d = sdSeg3Od(q, vec3(0.0), vec3(0.15 * (h - 0.5), ht, 0.0)) - mix(0.32, 0.09, clamp(q.y / ht, 0.0, 1.0));
  vec3 top = vec3(0.15 * (h - 0.5), ht * 0.62, 0.0);
  float a = h * 17.0;
  for(int i = 0; i < 3; i++){
    float fi = float(i);
    float an = a + fi * 2.094;
    vec3 tip = top + vec3(cos(an) * 1.6, 1.4 + fi * 0.5 + h, sin(an) * 1.6);
    d = min(d, sdSeg3Od(q, top, tip) - 0.08);
  }
  return d;
}

float sceneMapOd(vec3 p){
  float dg = (p.y - landOd(p.xz)) * 0.55;
  float d = dg;
  gMatOd = 0.0;
  if(trees_visible > 0.5){
    float sp = 5.0;
    float cz = cellOd(p.z, sp);
    float side = p.x < 0.0 ? -1.0 : 1.0;
    float h = hashOd(vec2(cz, side * 9.0 + 41.0));
    if(h > mix(0.25, 0.92, gBnOd)){
      vec3 c = vec3(side * (3.5 + h * 10.0), 0.0, cz * sp + (h - 0.5) * 2.0);
      c.y = landOd(c.xz) - 0.3;
      float dt = treeOd3(p - c, h);
      if(dt < d){ d = dt; gMatOd = 1.0; }
    }
    if(dg < 7.0) gCapOd = min(gCapOd, cellEdgeOd(p.z, cz, sp));
  }
  return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  gBnOd = clamp(burn_react, 0.0, 2.0) * 0.5;
  float bn = gBnOd;
  float stride = 0.4 + walk_react * 0.9;
  float sw = 0.9 + sword_react * 1.3;

  vec3 ro, rd;
  fpsCamOd(fragCoord, 0.5, 13.7, stride, ro, rd);
  vec2 sky = skyUvOd(rd);

  // Sky: ember orange under ash, lifting to desert haze as it finishes.
  float e = clamp(rd.y * 2.2, 0.0, 1.0);
  vec3 col = mix(mix(vec3(0.85, 0.28, 0.06), vec3(0.72, 0.50, 0.28), bn),
                 mix(vec3(0.10, 0.05, 0.06), vec3(0.28, 0.20, 0.16), bn), e);
  col += vec3(1.0, 0.45, 0.10) * pow(max(0.0, 1.0 - abs(rd.y) * 3.0), 3.0) * 0.5 * (1.0 - bn * 0.6);
  vec3 skyCol = col;

  float mat;
  float t = marchOd(ro, rd, 200.0, mat);

  // The fire goes out as the burn finishes; what is left is sand.
  float fireAmt = fire_visible > 0.5 ? (0.5 + fire_react * 1.4) * (1.0 - bn * 0.92) : 0.0;

  if(mat < -0.5){
    if(sky_visible > 0.5) col += skyStormOd(sky, sky_react) * smoothstep(-0.02, 0.1, rd.y);
    // Smoke lying across the sky.
    float sm = fbmOd(vec2(sky.x * 1.6, sky.y * 1.5 - iTime * 0.07));
    col = mix(col, vec3(0.13, 0.10, 0.10), clamp(sm * 0.45 * (1.0 - bn * 0.4), 0.0, 0.7));
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);
    vec3 sun = normalize(vec3(0.2, 0.25, 1.0));
    float dif = clamp(dot(n, sun), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    vec3 key = mix(vec3(1.00, 0.55, 0.15), vec3(1.00, 0.86, 0.58), bn);
    vec3 g;
    if(mat < 0.5){
      // Burnt black turning to sand.
      vec3 base = mix(vec3(0.035, 0.022, 0.02), vec3(0.42, 0.29, 0.17), bn);
      g = base * (vec3(1.0, 0.55, 0.3) * dif * 1.8 + vec3(0.35, 0.18, 0.12) * (0.5 + 0.5 * n.y));
      // The fire line: the ground itself burning in drifting patches, flaring
      // under the trees and dying back to sand as the burn finishes.
      float fl = fbmOd(p.xz * 0.35 + vec2(iTime * 0.25, -iTime * 0.4));
      float burnPatch = smoothstep(0.52, 0.72, fl);
      g += mix(vec3(1.0, 0.30, 0.05), vec3(1.0, 0.75, 0.25), fl) * burnPatch * fireAmt * 0.9;
      g += key * rim * 0.14 * exp(-t * 0.012);
    } else {
      // Charcoal, with the limbs still catching higher up.
      float up = clamp((p.y - landOd(p.xz)) / 7.0, 0.0, 1.0);
      g = vec3(0.025, 0.016, 0.015) * (0.4 + dif);
      float flick = 0.6 + 0.4 * sin(iTime * 9.0 + p.y * 3.0 + p.x);
      g += vec3(1.0, 0.40, 0.08) * smoothstep(0.35, 0.9, up) * flick
         * (0.35 + trees_react * 0.8) * (1.0 - bn * 0.7);
      g += key * rim * 0.4;
    }
    col = fogOd(g, skyCol, t, 0.012 + (1.0 - bn) * 0.004);
  }

  vec3 key = mix(vec3(1.00, 0.55, 0.15), vec3(1.00, 0.86, 0.58), bn);
  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.7 + walk_react * 0.9);

  // Embers streaming past, over everything.
  if(embers_visible > 0.5){
    float em = sporesOd(gUvOd + vec2(0.0, -iTime * 0.02), 0.04, 0.7);
    col += vec3(1.0, 0.42, 0.10) * em * (0.5 + embers_react * 1.6) * (1.0 - bn * 0.4);
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

export const cinder: ShaderDef = {
  id: 'cinder',
  name: 'Odyssey VI — Cinder',
  description:
    'The last journey, in the first person: walking through a forest and an air both on fire, with nothing but sand behind it. Ride Burn from 0 to 2 and it goes to desert around you.',
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
      id: 'fire',
      name: 'Fire',
      description:
        
        'The ground burning in drifting patches. React makes it surge; it goes out as Burn rises and there is less left to take.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'embers',
      name: 'Embers',
      description: 
        'Embers streaming past as you walk through the fire. React drives the density.',
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
        
        'The burnt trees lining the path, limbs still catching. React drives the fire in them; hide for bare ground.',
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
        
        'How far the fire has already got. Crossfades forest to dunes, thins the trees to the last few standing, puts the fire out and lifts the sky to desert haze.',
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
        'A pyrocumulus cell with Thunder’s bolt marched inside it, so the strike lights the smoke from within instead of over it. Strikes fire on their own every couple of seconds; push react past about 0.65 and the band fires them instead, so it cracks on the beat. Hide for a clear sky.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
