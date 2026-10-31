/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Burst. Hundreds of hair-fine filaments thrown out from a centre:
 * a bow-tie flaring left and right, a full star, a fuzzed sphere of short
 * curling strokes, and a plume of streaks rising off a baseline.
 *
 * Every filament lives in its own angular cell (or, for the plume, a cell
 * along x), and a pixel only checks its own cell and the two either side. That
 * is what makes several hundred overlapping hairs cost a dozen distance checks
 * rather than several hundred. Three layers at different counts give the
 * density the pack's bursts have, where the middle goes solid white.
 */

const FORMS = ['Bow-tie', 'Star', 'Sphere', 'Plume'];

const bufferShader = `
${lineworkUniforms}
uniform float reach_react;
${lineworkLib}

float gReach = 1.0;
float gAmp = 0.5;
int gForm = 0;

/* Coverage of filament cell c in layer L at polar (r, a). k = cells per turn. */
float hairBu(float r, float a, float c, float L, float k, float px, out float along){
  float h1 = hash21Lw(vec2(c, L * 13.1));
  float h2 = hash21Lw(vec2(c + 7.3, L * 3.7));
  float h3 = hash21Lw(vec2(c - 2.1, L * 5.9));
  float ang = (c + 0.5 + (h1 - 0.5) * 0.9) * TAU / k;
  float R = 0.42 * gReach;
  float r0, r1;
  if(gForm == 0){
    // Bow-tie: long along the horizontal, short up and down.
    float lob = pow(abs(cos(ang)), 1.4);
    r0 = R * 0.04 * h2;
    r1 = R * (0.12 + 0.95 * lob) * (0.55 + 0.45 * h2);
  } else if(gForm == 1){
    r0 = R * 0.05 * h2;
    r1 = R * (0.35 + 0.65 * h2 * h2);
  } else {
    // Sphere: short strokes scattered through the ball, longer near the rim.
    r0 = R * 0.78 * sqrt(h2);
    r1 = r0 + R * (0.08 + 0.3 * h3);
    r1 = min(r1, R * (1.0 + 0.15 * h3));
  }
  r1 *= 1.0 + gAmp * 0.25 * sin(iTime * (0.7 + h3) + h1 * 20.0);
  // Curl: the angle drifts along the hair, more for the sphere.
  // The sphere's strokes bend through a good part of a turn, so none of them
  // reads as a spoke to the centre — radial strokes make a dandelion, not fuzz.
  float curl = (gForm == 2 ? 2.6 : 0.25) * (h3 - 0.5);
  ang += curl * (r - r0) / max(R, 1e-3) + 0.03 * sin(r * 30.0 + h1 * 9.0 + iTime);
  float da = abs(mod(a - ang + PI, TAU) - PI);
  float dpx = r * sin(min(da, 1.5)) / px;
  along = clamp((r - r0) / max(r1 - r0, 1e-4), 0.0, 1.0);
  float inside = smoothstep(r0 - px, r0 + px, r) * smoothstep(r1 + px * 2.0, r1 - px * 2.0, r);
  return strokeLw(dpx, 0.42) * inside;
}

void main(){
  vec2 uv = uvLw();
  float px = pxLw();
  float kick = beatLw();
  gForm = formLw(4.0);
  gAmp = 0.3 + clamp(swell_react, 0.0, 2.5) * 0.5;
  gReach = (0.75 + clamp(reach_react, 0.0, 2.0) * 0.35) * (1.0 + kick * 0.15);
  float dens = 0.6 + clamp(density_react, 0.0, 2.5) * 0.6;

  vec3 ink = inkLw();
  vec3 acc = accentLw();
  vec3 col = paperLw();

  // A slow turn, and for the bow-tie a gentle tilt.
  // The plume has a ground to stand on, so it does not turn.
  float rot = gForm == 3 ? 0.0 : iTime * 0.04 + (gForm == 0 ? 0.12 * sin(iTime * 0.2) : 0.0);
  vec2 p = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * uv;

  if(gForm < 3){
    if(gForm == 2) p.y *= 1.04;
    float r = length(p);
    float a = atan(p.y, p.x);
    for(int L = 0; L < 3; L++){
      float fl = float(L);
      float k = floor((gForm == 2 ? 640.0 : 260.0) * dens * (1.0 + fl * 0.6));
      float c0 = floor(a / TAU * k);
      for(int j = -1; j <= 1; j++){
        float c = c0 + float(j);
        c = mod(c, k);
        float along;
        float cv = hairBu(r, a, c, fl, k, px, along);
        // Ink at the root running to the accent at the tip.
        vec3 lc = mix(ink, acc, along * 0.85);
        col = mix(col, lc, cv * 0.62);
      }
    }
    // The core goes solid, as it does in the pack.
    float core = smoothstep(0.06 * gReach, 0.0, r) * (gForm == 2 ? 0.0 : 1.0);
    col = mix(col, ink, core * 0.8);
    if(gForm == 2){
      // A soft fill under the strokes so the sphere reads as a mass.
      col = mix(col, ink, 0.3 * smoothstep(0.44 * gReach, 0.18 * gReach, r));
    }
  } else {
    // Plume: streaks rising off a baseline, leaning and fanning, with a crest
    // that rolls along like a wave.
    for(int L = 0; L < 3; L++){
      float fl = float(L);
      float k = floor(140.0 * dens * (1.0 + fl * 0.5));
      float sx = (p.x + 0.9) / 1.8 * k;
      float c0 = floor(sx);
      for(int j = -2; j <= 2; j++){
        float c = c0 + float(j);
        float h1 = hash21Lw(vec2(c, fl * 7.0 + 1.0));
        float h2 = hash21Lw(vec2(c + 3.3, fl * 5.0 + 2.0));
        float x0 = (c + 0.5 + (h1 - 0.5)) / k * 1.8 - 0.9;
        float crest = 0.12 + 0.24 * gReach * exp(-pow((x0 - 0.25 * sin(iTime * 0.3)) / 0.42, 2.0))
                    + 0.06 * gAmp * sin(x0 * 7.0 + iTime * 1.1)
                    + 0.05 * (h2 - 0.5);
        float base = -0.22 + 0.04 * sin(x0 * 3.0 + iTime * 0.4);
        float lean = 0.35 * (x0 - 0.1) + 0.2 * (h2 - 0.5);
        // Distance to the streak from (x0, base) to (x0 + lean*len, crest).
        vec2 A = vec2(x0, base);
        vec2 B = vec2(x0 + lean * (crest - base), crest);
        vec2 pa = p - A, ba = B - A;
        float hh = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        float dpx = length(pa - ba * hh) / px;
        float cv = strokeLw(dpx, 0.42) * smoothstep(1.0, 0.85, hh);
        if(abs(x0) > 0.92) cv = 0.0;
        col = mix(col, mix(ink, acc, hh * 0.85), cv * 0.6);
      }
    }
  }

  fragColor = vec4(clamp(finishLw(col, uv), 0.0, 1.0), 1.0);
}
`;

export const lwBurst: ShaderDef = {
  id: 'lw_burst',
  name: 'Linework — Burst',
  description:
    'Hair-fine filaments thrown out from a centre: a bow-tie, a full star, a fuzzed sphere, or a plume of streaks rising like a wave.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The burst: a bow-tie flaring left and right, a full star, a fuzzed sphere of short curling strokes, or a plume of streaks rising off a baseline.',
    {
      id: 'reach',
      name: 'Reach',
      description: 'How far the filaments throw. Put it on the kick and the burst lunges with it.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
