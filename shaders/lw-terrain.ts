/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Terrain. An undulating sheet floating in the dark, with a pattern
 * drawn on it in its own coordinates: ridgelines, a wire grid, a dot lattice,
 * hexagons outlined or filled, triangles, diamonds. Every one is the same
 * surface — only the pattern changes — which is what the pack's terrains are.
 *
 * The sheet is marched as a heightfield inside its bounding box with fixed
 * steps and a bisection, rather than relaxed sphere-tracing: it is thin and
 * smooth, and fixed steps cannot step over a peak the way a relaxed march can.
 *
 * The pattern is evaluated for every pixel and masked afterwards. fwidth() is
 * undefined inside a branch that differs between neighbouring pixels, so
 * computing it only where the ray hit would put garbage along the silhouette.
 */

const FORMS = ['Ridges', 'Grid', 'Dots', 'Hexagons', 'Hex cells', 'Triangles', 'Diamonds'];

const bufferShader = `
${lineworkUniforms}
uniform float peaks_react;
${lineworkLib}

const float W = 3.0;     // half-width of the sheet
const float D = 2.0;     // half-depth
float gAmp = 0.5;
float gSig = 1.0;

/* A few soft hills drifting about, one hollow, and a slow ripple under them. */
float heightTw(vec2 p){
  float t = iTime;
  vec2 c1 = vec2(1.1 + 0.6 * sin(t * 0.23), -0.3 + 0.4 * cos(t * 0.31));
  vec2 c2 = vec2(-1.3 + 0.5 * cos(t * 0.19), 0.6 + 0.3 * sin(t * 0.27));
  vec2 c3 = vec2(0.2 + 1.2 * sin(t * 0.13), 0.9 * cos(t * 0.17));
  float s2 = gSig * gSig;
  float h = 0.80 * exp(-dot(p - c1, p - c1) / s2)
          + 0.55 * exp(-dot(p - c2, p - c2) / (s2 * 1.3))
          - 0.35 * exp(-dot(p - c3, p - c3) / (s2 * 0.8));
  h += 0.16 * sin(p.x * 1.3 + t * 0.5) * cos(p.y * 1.1 - t * 0.37);
  return h * gAmp;
}

bool slabTw(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1){
  vec3 inv = vec3(rd.x < 0.0 ? -1.0 : 1.0, rd.y < 0.0 ? -1.0 : 1.0, rd.z < 0.0 ? -1.0 : 1.0)
           / max(abs(rd), vec3(1e-6));
  vec3 a = (bmin - ro) * inv, b = (bmax - ro) * inv;
  vec3 lo = min(a, b), hi = max(a, b);
  t0 = max(max(lo.x, lo.y), lo.z);
  t1 = min(min(hi.x, hi.y), hi.z);
  return t1 > max(t0, 0.0);
}

/* First crossing of the sheet along the ray, or -1. */
float marchTw(vec3 ro, vec3 rd){
  float hb = gAmp * 1.25 + 0.05;
  float t0, t1;
  if(!slabTw(ro, rd, vec3(-W, -hb, -D), vec3(W, hb, D), t0, t1)) return -1.0;
  t0 = max(t0, 0.0);
  const int N = 90;
  float dt = (t1 - t0) / float(N);
  float ta = t0;
  vec3 pa = ro + rd * ta;
  float fa = pa.y - heightTw(pa.xz);
  float s0 = sign(fa);
  for(int i = 1; i <= N; i++){
    float tb = t0 + dt * float(i);
    vec3 pb = ro + rd * tb;
    float fb = pb.y - heightTw(pb.xz);
    if(sign(fb) != s0){
      for(int k = 0; k < 7; k++){
        float tm = 0.5 * (ta + tb);
        vec3 pm = ro + rd * tm;
        float fm = pm.y - heightTw(pm.xz);
        if(sign(fm) == s0){ ta = tm; } else { tb = tm; }
      }
      return 0.5 * (ta + tb);
    }
    ta = tb;
  }
  return -1.0;
}

void main(){
  vec2 uv = uvLw();
  float kick = beatLw();
  gAmp = (0.30 + clamp(swell_react, 0.0, 2.5) * 0.6) * (1.0 + kick * 0.25);
  gSig = mix(1.45, 0.55, clamp(peaks_react * 0.5, 0.0, 1.0));

  vec3 ro, rd;
  cameraLw(uv, vec3(0.0, 0.15, 0.0), 5.4, 0.5, ro, rd);
  float t = marchTw(ro, rd);
  bool hit = t > 0.0;
  // A stand-in point for misses, so the pattern below can run everywhere.
  vec3 p = ro + rd * (hit ? t : 6.0);

  float dens = 1.6 + clamp(density_react, 0.0, 2.5) * 3.6;
  vec2 q = p.xz * dens;
  int f = formLw(7.0);
  float cov = 0.0;
  float fwq = max(length(fwidth(q)), 1e-5);
  float fade = 1.0 - smoothstep(0.35, 0.8, fwq);

  if(f == 0){
    cov = linesLw(q.y, 0.65);
  } else if(f == 1){
    cov = max(linesLw(q.x, 0.55), linesLw(q.y, 0.55));
  } else if(f == 2){
    vec2 g = fract(q) - 0.5;
    float r = 0.11 + 0.07 * hash21Lw(floor(q));
    cov = coverLw((length(g) - r) / fwq) * fade;
  } else if(f == 3 || f == 4){
    vec2 rr = vec2(1.0, 1.7320508);
    vec2 a = mod(q, rr) - rr * 0.5;
    vec2 b = mod(q - rr * 0.5, rr) - rr * 0.5;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    vec2 id = q - gv;
    float hx = max(dot(abs(gv), vec2(0.5, 0.8660254)), abs(gv.x));
    float e = 0.5 - hx;                        // distance to the cell's edge
    if(f == 3){
      cov = strokeLw(e / fwq, 0.6) * fade;
    } else {
      // Cells set into the sheet, some missing, so it reads as a lattice
      // being assembled rather than a floor tile.
      float keep = step(0.3, hash21Lw(id + 3.7));
      cov = coverLw((0.07 - e) / fwq) * keep * fade;
    }
  } else if(f == 5){
    float a = q.y * 1.1547;
    float b = dot(q, vec2(0.8660254, 0.5)) * 1.1547;
    float c = dot(q, vec2(0.8660254, -0.5)) * 1.1547;
    cov = max(linesLw(a, 0.5), max(linesLw(b, 0.5), linesLw(c, 0.5)));
  } else {
    float a = dot(q, vec2(0.5, 0.8660254));
    float b = dot(q, vec2(0.5, -0.8660254));
    cov = max(linesLw(a, 0.55), linesLw(b, 0.55));
  }

  vec3 paper = paperLw();
  vec3 col = paper;
  if(hit){
    // Near lines in ink, far ones going over to the accent — depth without
    // shading, which is how the pack draws it.
    float depth = smoothstep(3.5, 8.5, t);
    vec3 line = mix(inkLw(), accentLw(), depth);
    // Peaks catch a little extra light.
    line *= 0.85 + 0.3 * smoothstep(0.0, gAmp, p.y);
    // The sheet itself is opaque paper, faintly shaded, so lines behind a
    // ridge are hidden by it.
    vec3 n = normalize(vec3(heightTw(p.xz - vec2(0.01, 0.0)) - heightTw(p.xz + vec2(0.01, 0.0)),
                            0.02,
                            heightTw(p.xz - vec2(0.0, 0.01)) - heightTw(p.xz + vec2(0.0, 0.01))));
    float sh = clamp(dot(n, normalize(vec3(-0.4, 0.8, -0.5))), 0.0, 1.0);
    col = paper + accentLw() * sh * 0.05;
    col = mix(col, line, clamp(cov, 0.0, 1.0));
  }

  fragColor = vec4(clamp(finishLw(col, uv), 0.0, 1.0), 1.0);
}
`;

export const lwTerrain: ShaderDef = {
  id: 'lw_terrain',
  name: 'Linework — Terrain',
  description:
    'An undulating sheet in the dark with a pattern drawn on it: ridgelines, wire grid, dots, hexagons, hex cells, triangles or diamonds.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The pattern on the sheet: ridgelines, a wire grid, a dot lattice, hexagon outlines, filled hex cells, triangles, or diamonds.',
    {
      id: 'peaks',
      name: 'Peaks',
      description: 'How sharp the hills are, from broad swells to tight peaks.',
      defaultBand: 'mid',
      defaultAmount: 0.4,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
