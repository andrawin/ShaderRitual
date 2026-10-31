/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Contour. Organic forms drawn entirely in flowing lines: a lens
 * whose fibres all run in to a point at its heart, a leaf veined toward an
 * off-centre focus, a topographic map with every fifth contour heavier, and
 * rings rippling out through a warped field.
 *
 * The fibres are lines of constant angle around the focus, warped by noise.
 * atan() has a branch cut, and across it the derivative jumps by a full turn:
 * every line would vanish along a seam. Both placements of the cut are
 * computed everywhere and each pixel takes the one pointing away from it — so
 * the derivatives stay continuous and nothing is branched on per pixel.
 */

const FORMS = ['Lens', 'Leaf', 'Topographic', 'Rings'];

const bufferShader = `
${lineworkUniforms}
uniform float warp_react;
${lineworkLib}

void main(){
  vec2 uv = uvLw();
  float t = iTime;
  float kick = beatLw();
  int f = formLw(4.0);
  float amp = 0.3 + clamp(swell_react, 0.0, 2.5) * 0.45;
  float wrp = 0.2 + clamp(warp_react, 0.0, 2.0) * 0.55;
  float n = floor(24.0 + clamp(density_react, 0.0, 2.5) * 26.0);

  vec3 ink = inkLw();
  vec3 acc = accentLw();
  vec3 col = paperLw();

  // Lens and leaf are seen tilted away, like a disc lying on a table.
  vec2 p = uv;
  vec2 focus = vec2(0.0);
  vec2 ab = vec2(0.62, 0.30);
  if(f == 1){
    p = mat2(0.94, 0.34, -0.34, 0.94) * uv;
    focus = vec2(0.22, -0.06);
    ab = vec2(0.66, 0.34);
  }

  // The fibre field: angle around the focus, warped. Two cuts, one picked.
  vec2 q = p - focus;
  q.y *= (f == 1 ? 1.5 : 1.9);
  float wv = (fbmLw(p * 3.0 + vec2(t * 0.12, -t * 0.08)) - 0.5) * wrp * (1.0 + amp * 0.6)
           + 0.15 * amp * sin(length(q) * 9.0 - t * 1.2);
  float aA = atan(q.y, q.x) + wv;                 // cut along -x
  float aB = atan(-q.y, -q.x) + PI + wv;          // cut along +x
  float vA = linesLw(aA / TAU * n, 0.5);
  float vB = linesLw(aB / TAU * n, 0.5);
  float veins = q.x > 0.0 ? vA : vB;

  // The outline: a ragged ellipse, its edge breathing with the music.
  // Noise sampled round a circle, not along a raw angle: an angle jumps by a
  // full turn at the back of the shape, and the outline would step there.
  float ang = atan(p.y, p.x);
  vec2 ring2 = vec2(cos(ang), sin(ang));
  float rag = 0.10 * (fbmLw(ring2 * 1.3 + vec2(3.0, t * 0.1)) - 0.5) * (1.0 + wrp)
            + 0.04 * amp * sin(ang * 5.0 + t * 0.7);
  float sd = length(p / ab) - (1.0 + rag) * (1.0 + kick * 0.05);
  float edge = strokeLw(sd / max(fwidth(sd), 1e-5), 0.75);
  float inside = smoothstep(0.02, -0.02, sd);

  // Topographic heights, and rings.
  float h = fbmLw(uv * 1.7 + vec2(t * 0.03, t * 0.02)) + 0.25 * amp * sin(length(uv) * 6.0 - t * 0.6);
  float topo = h * n * 0.4;
  float ring = (length(uv * vec2(1.0, 1.25)) + (fbmLw(uv * 2.5 + t * 0.07) - 0.5) * wrp * 0.4) * n * 0.8
             - t * (0.6 + amp);

  float cov = 0.0;
  vec3 lc = ink;
  if(f <= 1){
    // Fibres crowd towards the focus; let them run brighter there.
    float r = length(q);
    cov = max(veins * inside * smoothstep(0.012, 0.05, r), edge);
    lc = mix(acc, ink, smoothstep(0.5, 0.05, r));
    col = mix(col, ink, smoothstep(0.09, 0.0, r) * 0.6 * inside);
  } else if(f == 2){
    // Every fifth contour is an index line, heavier, as on a survey map.
    float minor = linesLw(topo, 0.45);
    float major = linesLw(topo / 5.0, 0.9);
    cov = max(minor * 0.75, major);
    lc = mix(acc, ink, major);
  } else {
    cov = linesLw(ring, 0.55);
    lc = mix(ink, acc, smoothstep(0.1, 0.6, length(uv)));
  }

  col = mix(col, lc, clamp(cov, 0.0, 1.0));
  fragColor = vec4(clamp(finishLw(col, uv), 0.0, 1.0), 1.0);
}
`;

export const lwContour: ShaderDef = {
  id: 'lw_contour',
  name: 'Linework — Contour',
  description:
    'Organic forms drawn in flowing lines: a lens of fibres running into its heart, a veined leaf, a topographic map, rippling rings.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The form: a lens whose fibres run in to a point, a leaf veined toward an off-centre focus, a topographic map, or rings rippling outward.',
    {
      id: 'warp',
      name: 'Warp',
      description: 'How much the lines bend and the outline frays.',
      defaultBand: 'mid',
      defaultAmount: 0.6,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
