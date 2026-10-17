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
 * Played in the first person (see odyssey.ts).
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
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Beacon's cage, raymarched into the distance. A three-fold polar fold
 * of the xy plane turns one cyan light-tube into a cage of them, and a magenta
 * halo is repeated along the centre line, so the whole thing recedes with real
 * perspective — halos get smaller and dimmer the further back they sit, which
 * is the one thing flat discs cannot do.
 *
 * Rendered by accumulating 1/(eps + d*d) along the ray rather than stopping at
 * a surface. Beacon does the same, and it is why the structure reads as light
 * rather than as painted geometry: the march passes straight through it.
 */
vec3 skyCageOd(vec2 uv, float react){
  vec3 rd = skyRayOd(uv, 0.90);
  vec3 ro = vec3(0.0, -1.1, 0.0);
  float flow = iTime * (0.7 + react * 1.3);
  float g1 = 0.0;
  float g2 = 0.0;
  float t = 0.4;
  for(int i = 0; i < 32; i++){
    vec3 p = ro + rd * t;
    p.z += flow;
    vec3 q = p;

    p.xy = pSFoldOd(-p.xy, 3.0);
    p.y -= 2.6;
    p.xz = mod(p.xz, 3.4) - 1.7;
    float d1 = length(p.yz) - 0.26;             // the tube cage

    q.z = q.z - 2.6 * floor(q.z / 2.6 + 0.5);   // halos, odd-repeated
    float d0 = max(abs(length(q.xy) - 0.85) - 0.06, abs(q.z) - 0.06);

    // Tight kernels. A wide one turns the whole lattice into haze, which over
    // a sky this bright is indistinguishable from nothing.
    g1 += 0.005 / (0.005 + d1 * d1);
    g2 += 0.006 / (0.006 + d0 * d0);

    t += max(min(abs(d1), abs(d0)) * 0.75, 0.05);
    if(t > 18.0) break;
  }
  return (vec3(0.18, 0.85, 1.00) * g1 * 0.030
        + vec3(1.00, 0.24, 0.72) * g2 * 0.038) * (0.4 + react * 1.1);
}

float gHueOd = 0.0;

/*
 * Crystal spires lining the path, one every nine metres either side when the
 * hash allows. Hexagonal in section and tapering to a point, so they read as
 * grown rather than built. Left and right hash separately; symmetric, they look
 * like an avenue someone planned.
 */
float sceneMapOd(vec3 p){
  float dg = groundDistOd(p, 0.55, 5.7);
  float d = dg;
  gMatOd = 0.0;
  if(spires_visible > 0.5){
    float sp = 9.0;
    float cz = cellOd(p.z, sp);
    float side = p.x < 0.0 ? -1.0 : 1.0;
    float h = hashOd(vec2(cz, side * 7.0 + 11.0));
    if(h > 0.3){
      vec3 c = vec3(side * (6.5 + h * 7.0), 0.0, cz * sp + (h - 0.5) * 3.0);
      c.y = terrainOd(c.xz, 0.55, 5.7) - 0.6;
      vec3 q = p - c;
      float ht = 3.5 + h * 10.0;
      float r = 0.55 + h * 0.75;
      float hex = max(abs(q.x) * 0.866 + abs(q.z) * 0.5, abs(q.z));
      float taper = r * clamp(1.0 - q.y / ht, 0.0, 1.0);
      float ds = max(max(hex - taper, -q.y), q.y - ht) * 0.6;
      if(ds < d){ d = ds; gMatOd = 1.0; gHueOd = h; }
    }
    if(dg < 8.5) gCapOd = min(gCapOd, cellEdgeOd(p.z, cz, sp));
  }
  return d;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float stride = 0.4 + walk_react * 0.9;
  float sw = 0.9 + sword_react * 1.3;

  vec3 ro, rd;
  fpsCamOd(fragCoord, 0.55, 5.7, stride, ro, rd);
  vec2 sky = skyUvOd(rd);
  vec3 key = vec3(0.35, 1.00, 0.95);

  // Clean sky: deep violet overhead into hot magenta at the horizon.
  float e = clamp(rd.y * 2.2, 0.0, 1.0);
  vec3 horizon = vec3(0.55, 0.10, 0.45);
  vec3 col = mix(horizon, vec3(0.10, 0.03, 0.30), e);
  col += vec3(0.9, 0.25, 0.6) * pow(max(0.0, 1.0 - abs(rd.y) * 4.0), 4.0) * 0.5;
  vec3 skyCol = col;

  float mat;
  float t = marchOd(ro, rd, 200.0, mat);

  if(mat < -0.5){
    if(sky_visible > 0.5) col += skyCageOd(sky, sky_react) * smoothstep(-0.02, 0.1, rd.y);
    if(aurora_visible > 0.5){
      float a = 0.0;
      for(int i = 0; i < 3; i++){
        float fi = float(i);
        float yy = sky.y - 0.10 - fi * 0.09;
        float wv = fbmOd(vec2(sky.x * 1.6 + fi * 4.0, iTime * 0.12 + fi)) - 0.5;
        a += smoothstep(0.075, 0.0, abs(yy - wv * 0.22)) * (1.0 - fi * 0.22);
      }
      vec3 ac = mix(vec3(0.20, 1.00, 0.80), vec3(0.70, 0.35, 1.00), 0.5 + 0.5 * sin(iTime * 0.3));
      col += ac * a * (0.25 + aurora_react * 0.8);
    }
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);
    // A low magenta sun off the horizon ahead, and the crests rimmed in cyan.
    vec3 sun = normalize(vec3(-0.3, 0.22, 1.0));
    float dif = clamp(dot(n, sun), 0.0, 1.0);
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 4.0);
    vec3 g;
    if(mat < 0.5){
      vec3 base = vec3(0.07, 0.03, 0.10);
      g = base * (vec3(1.0, 0.35, 0.8) * dif * 2.2 + vec3(0.25, 0.12, 0.45) * (0.5 + 0.5 * n.y));
      g += key * rim * 0.25 * exp(-t * 0.01);
    } else {
      // Lit glass: dark through the body, burning along the edges and up
      // towards the point.
      vec3 sc = mix(vec3(0.15, 0.90, 1.00), vec3(1.00, 0.30, 0.85), gHueOd);
      float rise = clamp((p.y - terrainOd(p.xz, 0.55, 5.7)) / 10.0, 0.0, 1.0);
      // Lit from inside: a floor of glow through the whole body, so they read
      // as glass with a light in it rather than as dark spikes with an edge.
      float facet = 0.5 + 0.5 * sin((p.y - p.x * 0.5) * 3.0 + gHueOd * 20.0);
      g = sc * (0.22 + rise * 0.55 + facet * 0.12) * (0.45 + spires_react * 1.1);
      g += sc * rim * 1.4 * (0.4 + spires_react * 1.1);
      g += vec3(1.0) * pow(clamp(dot(reflect(rd, n), sun), 0.0, 1.0), 24.0) * 0.6;
    }
    col = fogOd(g, skyCol, t, 0.011);
  }

  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.7 + walk_react * 0.9);

  // Spores, over everything — this is the air the rest of the suite loses.
  if(motes_visible > 0.5){
    float m = sporesOd(gUvOd, 0.035, 0.74);
    vec3 mc = mix(vec3(1.00, 0.85, 0.40), vec3(0.40, 1.00, 0.95), fract(gUvOd.x * 3.0 + 0.5));
    col += mc * m * (0.4 + motes_react * 1.2);
  }

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

export const revelry: ShaderDef = {
  id: 'revelry',
  name: 'Odyssey II — Revelry',
  description:
    'The first journey, in the first person: clean air and a landscape behaving like a party. An avenue of glowing crystal spires, aurora overhead and spores streaming past, in full magenta and cyan.',
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
      description: 
        'The lit crystal spires lining the path. React drives the light inside them.',
      defaultBand: 'low',
      defaultAmount: 0.9,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'motes',
      name: 'Spores',
      description: 
        'Spores in the clean air, streaming past as you walk. React brightens the whole field.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Cage',
      description:
        'Beacon’s folded light cage raymarched into the distance: cyan tubes and magenta halos receding with real perspective. React drives how fast you fly through it and how hard it burns. Hide for an empty sky.',
      defaultBand: 'low',
      defaultAmount: 0.7,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
