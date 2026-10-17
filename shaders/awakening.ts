/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import { odysseyUniforms, odysseyLib } from './odyssey';

/*
 * ODYSSEY 0 — "Awakening". The origin: you come to in a universe that has
 * barely been switched on. There is almost nothing here — a floor drawing
 * itself in as a grid, a thin scatter of stars, a vortex falling inward
 * overhead, and one point of light hanging ahead on the path that pulses like
 * something breathing and keeps its distance however far you walk.
 *
 * Rise is the scene's real subject: at 0 the ground is a dead flat grid; turn
 * it up and hills grow out of the floor around you. Run it low and let it
 * climb across a set and the world assembles itself as you walk.
 *
 * Played in the first person (see odyssey.ts).
 */

const bufferShader = `
${odysseyUniforms}

uniform float walk_react;
uniform float walk_visible;
uniform float sword_react;
uniform float spark_react;
uniform float spark_visible;
uniform float stars_react;
uniform float stars_visible;
uniform float rise_react;
uniform float sky_react;
uniform float sky_visible;

${odysseyLib}

/*
 * The sky: Maelstrom's log-polar vortex, trimmed to 40 steps and 4 octaves and
 * re-divided into blue instead of amber. Mapping position into
 * (log R, radial falloff, angle) makes the same field repeat at every scale, so
 * it reads as something falling inward forever — which is the whole scene:
 * a universe still switching itself on behind an empty horizon.
 */
vec3 skyVortexOd(vec2 uv, float react){
  vec3 d = vec3(uv * 0.85, 0.4);
  vec3 q = vec3(0.0, -0.35, -0.5);
  vec3 acc = vec3(0.0);
  vec3 p = vec3(0.0);
  float e = 0.0;
  float R = 0.0;
  float s = 0.0;
  float spd = 0.09 + react * 0.16;
  for(int i = 0; i < 40; i++){
    acc += min(e * s, 1.0 - e) / vec3(132.0, 84.0, 54.0);
    s = 7.5;
    q += d * e * R * 0.5;
    p = q;
    R = max(length(p), 1e-4);
    float ang = (abs(p.x) + abs(p.y) < 1e-6) ? 0.0 : atan(p.x, p.y);
    p = vec3(log(R) - iTime * spd, exp(-p.z / R + 0.55), ang);
    p.y -= 1.0;
    e = p.y;
    for(int k = 0; k < 4; k++){
      e -= abs(dot(cos(p.zxy * s) - sin(p.yzx), 0.3 - sin(p * s))) / s;
      s += s;
    }
  }
  return max(acc, 0.0);
}

float gAmp = 0.2;

/* Nothing here but ground — this is a universe that has barely been switched
 * on, and Rise decides how much of it exists. */
float sceneMapOd(vec3 p){
  gMatOd = 0.0;
  return groundDistOd(p, gAmp, 3.1);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float stride = 0.35 + walk_react * 0.9;
  float sw = 0.9 + sword_react * 1.3;
  gAmp = 0.06 + rise_react * 0.9;

  vec3 ro, rd;
  fpsCamOd(fragCoord, gAmp, 3.1, stride, ro, rd);
  vec2 sky = skyUvOd(rd);
  vec3 key = vec3(0.45, 0.85, 1.0);

  // Almost nothing: near-black, with a cold violet sitting on the horizon.
  vec3 haze = vec3(0.05, 0.035, 0.12);
  vec3 col = vec3(0.010, 0.011, 0.026) + haze * pow(max(0.0, 1.0 - abs(rd.y) * 5.0), 3.0);
  vec3 skyCol = col;

  // The waking light hangs ahead on the path and keeps its distance, so you
  // walk towards it and never arrive.
  float dz = walkedOd() + 11.0;
  vec3 spark = vec3(0.6, terrainOd(vec2(0.6, dz), gAmp, 3.1) + 2.3 + 0.3 * sin(iTime * 0.7), dz);
  float pulse = 0.75 + 0.25 * sin(iTime * 0.9);
  float sparkGain = spark_visible > 0.5 ? (0.25 + spark_react * 1.1) * pulse : 0.0;

  float mat;
  float t = marchOd(ro, rd, 220.0, mat);

  if(mat < -0.5){
    if(sky_visible > 0.5 && rd.y > -0.02){
      col += skyVortexOd(sky, sky_react) * (0.14 + sky_react * 0.6)
           * smoothstep(-0.02, 0.18, rd.y);
    }
    if(stars_visible > 0.5){
      col += vec3(0.55, 0.70, 1.0) * starsOd(sky, 26.0, 1.0) * (0.35 + stars_react * 0.9)
           * smoothstep(0.0, 0.1, rd.y);
    }
  } else {
    vec3 p = ro + rd * t;
    vec3 n = normalOd(p, t);

    // Lit only by the spark — there is nothing else here to light it.
    vec3 L = spark - p;
    float dl = length(L);
    float dif = clamp(dot(n, L / dl), 0.0, 1.0) / (1.0 + dl * dl * 0.012);
    vec3 g = vec3(0.012, 0.013, 0.03) * (0.6 + 0.4 * n.y) + key * dif * sparkGain * 0.9;

    // A grid on the floor, the world drawing itself in. Widened with distance,
    // or far off it aliases into shimmer before the fog can take it.
    vec2 gq = abs(fract(p.xz * 0.25) - 0.5);
    float lw = 0.025 + t * 0.0025;
    float grid = smoothstep(lw, 0.0, min(gq.x, gq.y));
    g += key * grid * (0.12 + rise_react * 0.45) * exp(-t * 0.018);

    // Crests catch the light edge-on: the old horizon hairline, in depth.
    float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 5.0);
    g += key * rim * (0.08 + rise_react * 0.25) * exp(-t * 0.012);

    col = fogOd(g, skyCol, t, 0.012);
  }

  // The spark's glow, wherever it sits in front of what the ray hit.
  if(spark_visible > 0.5){
    float along;
    float dr = rayPointDistOd(ro, rd, spark, along);
    if(along < t + 0.5){
      col += key * pow(max(0.0, 1.0 - dr * 0.09), 4.0) * sparkGain * 0.75;
      col += key * pow(max(0.0, 1.0 - dr * 0.6), 3.0) * sparkGain * 1.2;
      col += vec3(0.9, 0.97, 1.0) * smoothstep(0.32, 0.0, dr) * sparkGain * 1.8;
    }
  }

  col = viewmodelLayerOd(col, sw, walk_visible, stride, key, 0.6 + walk_react * 0.8);

  col *= 1.0 - 0.5 * pow(clamp(length(gUvOd * vec2(0.85, 1.25)), 0.0, 1.0), 2.5);
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

export const awakening: ShaderDef = {
  id: 'awakening',
  name: 'Odyssey I — Awakening',
  description:
    'The origin, in the first person. You wake with an oversized sword in a near-empty universe: a floor drawing itself in, a thin scatter of stars, and one pulsing light ahead that you never reach.',
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
      id: 'spark',
      name: 'First Light',
      description:
        
        'The waking light hanging ahead on the path. It keeps its distance, so you walk towards it and never arrive. React makes it breathe with the track; hide to walk on in the dark.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'stars',
      name: 'Stars',
      description: 'The scatter of stars coming up out of the dark. React drives the twinkle.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      defaultLevel: 0.4,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'rise',
      name: 'Rise',
      description:
        
        'How much world exists yet. At 0 the ground is a dead flat grid; climbing it grows hills out of the floor around you.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.2,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sky',
      name: 'Sky — Vortex',
      description:
        'Maelstrom’s log-polar vortex behind the horizon: a field that repeats at every scale, so it falls inward forever. React drives how fast it turns and how bright it burns. Hide for an empty sky, and for the cheapest version of the scene.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.35,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
