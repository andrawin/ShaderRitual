/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Strands. Bundles of lines running across the frame: a ribbon that
 * swells and narrows, a braid that fans out from a point and gathers to
 * another, a node graph with circles riding the lines, a tangled web of
 * straight runs, and an oscilloscope tube pinched to a bright core.
 *
 * Each line is a function y(x). Its stroke is drawn from the exact
 * perpendicular distance in pixels, |F| / |grad F| with F = y - line(x), which
 * the screen-space derivatives give directly — so a strand keeps one width
 * however steeply it climbs, where a vertical distance would thin it to a
 * hairline on every slope.
 */

const FORMS = ['Ribbon', 'Braid', 'Nodes', 'Web', 'Scope'];

const bufferShader = `
${lineworkUniforms}
uniform float spread_react;
${lineworkLib}

float gAmp = 0.5;
float gSpread = 1.0;
int gForm = 0;

float gaussSt(float x, float c, float w){ float d = (x - c) / w; return exp(-d * d); }

/* Where line i of n sits at x. */
float lineSt(float x, float fi, float n, float t){
  float k = fi / max(n - 1.0, 1.0);         // 0..1 across the bundle
  float c = k - 0.5;
  if(gForm == 0){
    // Ribbon: one curve, offset into a bundle whose width breathes along x.
    float base = 0.10 * sin(x * 2.1 + t * 0.6)
               + 0.20 * gAmp * gaussSt(x, 0.35 * sin(t * 0.21), 0.32)
               - 0.12 * gAmp * gaussSt(x, -0.55 + 0.2 * cos(t * 0.17), 0.22);
    float w = 0.10 + 0.07 * sin(x * 1.7 + t * 0.4) + 0.05 * gaussSt(x, 0.1, 0.3);
    return base + c * w * gSpread * 2.2 + 0.006 * sin(x * 9.0 + fi * 1.7 + t);
  }
  if(gForm == 1 || gForm == 2){
    // Braid: pinched at both ends, crossing in between.
    float x0 = -0.78, x1 = 0.78;
    float s = clamp((x - x0) / (x1 - x0), 0.0, 1.0);
    float env = sin(PI * s);
    float ph = k * PI * 1.6 + t * 0.35;
    return env * (0.20 * gAmp * sin(ph + x * 3.2) + 0.07 * gSpread * sin(ph * 1.7 - x * 5.0 + t * 0.5))
         + 0.05 * sin(x * 1.5 + t * 0.3);
  }
  if(gForm == 3){
    // Web: straight runs between jittered control points, so it tangles.
    float seg = (x + 0.9) / 0.36;
    float i0 = floor(seg);
    float f = fract(seg);
    float ya = (hash21Lw(vec2(i0, fi)) - 0.5) * 0.7 * gSpread
             + 0.12 * gAmp * sin(i0 * 1.3 + t * 0.4 + fi * 0.2);
    float yb = (hash21Lw(vec2(i0 + 1.0, fi)) - 0.5) * 0.7 * gSpread
             + 0.12 * gAmp * sin((i0 + 1.0) * 1.3 + t * 0.4 + fi * 0.2);
    return mix(ya, yb, f) * (0.35 + 0.65 * gaussSt(x, 0.0, 0.75));
  }
  // Scope: a tube of sine traces, narrow at the core and opening outwards.
  float env = 0.035 + 0.3 * gSpread * pow(abs(x) / 0.9, 1.2);
  return env * sin(x * (9.0 + k * 7.0) + k * TAU + t * (1.0 + gAmp)) * (0.6 + 0.4 * gAmp);
}

void main(){
  vec2 uv = uvLw();
  float t = iTime;
  float kick = beatLw();
  gForm = formLw(5.0);
  gAmp = 0.35 + clamp(swell_react, 0.0, 2.5) * 0.55 + kick * 0.2;
  gSpread = 0.5 + clamp(spread_react, 0.0, 2.0) * 0.6;
  float n = floor(10.0 + clamp(density_react, 0.0, 2.5) * 14.0);
  float px = pxLw();

  vec3 ink = inkLw();
  vec3 acc = accentLw();
  vec3 col = paperLw();
  // Fade the strands in from the edges of the frame, as the pack does.
  float xfade = smoothstep(0.98, 0.72, abs(uv.x) / (0.5 * iResolution.x / iResolution.y));

  for(int i = 0; i < 48; i++){
    float fi = float(i);
    if(fi >= n) break;
    float F = uv.y - lineSt(uv.x, fi, n, t);
    float g = length(vec2(dFdx(F), dFdy(F)));
    float dpx = abs(F) / max(g, 1e-6);
    // The web's runs are fewer and heavier; everything else is hairline.
    float w = gForm == 3 ? 0.55 : 0.45;
    float c = strokeLw(dpx, w) * xfade;
    if(gForm == 1 || gForm == 2){
      // The braid is clipped to its span.
      c *= smoothstep(0.8, 0.77, abs(uv.x));
    }
    vec3 lc = mix(ink, acc, fi / max(n - 1.0, 1.0) * 0.75);
    col = mix(col, lc, c * 0.9);
  }

  if(gForm == 2){
    // Nodes riding the lines at four stations, some filled, some open rings,
    // and a few large ones where the braid gathers.
    for(int j = 0; j < 4; j++){
      float xn = -0.55 + float(j) * 0.37;
      for(int i = 0; i < 48; i++){
        float fi = float(i);
        if(fi >= n) break;
        float h = hash21Lw(vec2(fi, float(j) + 9.0));
        if(h < 0.72) continue;
        vec2 c = vec2(xn, lineSt(xn, fi, n, t));
        float r = mix(0.006, 0.03, pow(h, 6.0)) * (1.0 + kick * 0.6);
        float d = (length(uv - c) - r) / px;
        float fill = h > 0.93 ? strokeLw(d + 1.2, 1.0) : coverLw(d);
        col = mix(col, acc, fill);
        col = mix(col, ink, strokeLw(d, 0.5));
      }
    }
    // The two terminals.
    for(int e = 0; e < 2; e++){
      vec2 c = vec2(e == 0 ? -0.78 : 0.78, 0.05 * sin((e == 0 ? -0.78 : 0.78) * 1.5 + t * 0.3));
      float d = (length(uv - c) - 0.04 * (1.0 + kick * 0.4)) / px;
      col = mix(col, ink, coverLw(d));
    }
  }

  if(gForm == 4){
    // The core where every trace crosses burns brighter.
    float core = exp(-uv.x * uv.x * 40.0) * exp(-uv.y * uv.y * 900.0);
    col = mix(col, ink, clamp(core * 0.8, 0.0, 1.0));
  }

  fragColor = vec4(clamp(finishLw(col, uv), 0.0, 1.0), 1.0);
}
`;

export const lwStrands: ShaderDef = {
  id: 'lw_strands',
  name: 'Linework — Strands',
  description:
    'Bundles of lines across the frame: a breathing ribbon, a braid gathered at both ends, a node graph, a tangled web, an oscilloscope tube.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The bundle: a ribbon that swells and narrows, a braid gathered at both ends, a braid with nodes riding it, a tangled web of straight runs, or an oscilloscope tube.',
    {
      id: 'spread',
      name: 'Spread',
      description: 'How far the lines fan apart from each other.',
      defaultBand: 'mid',
      defaultAmount: 0.6,
      defaultLevel: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
