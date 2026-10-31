/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Halftone. A form in space printed through a dot screen: the dots
 * sit on a fixed grid and only their size carries the shading. A torus, a
 * torus whose square section twists as it goes round, a lumpy blob, and a
 * rolling sheet.
 *
 * Each dot samples the form at the centre of its own cell, not at the pixel.
 * Every pixel in a cell marches the same ray, which is redundant but is the
 * only way a dot comes out as one dot: sampled per pixel, the dots along an
 * edge get sliced by the silhouette and the screen stops reading as print.
 */

const FORMS = ['Torus', 'Twist', 'Blob', 'Sheet'];

const bufferShader = `
${lineworkUniforms}
uniform float tone_react;
${lineworkLib}

int gForm = 0;
float gAmp = 0.5;
float gTime = 0.0;

mat3 spinHt(float a, float b){
  float ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b);
  return mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca)
       * mat3(1.0, 0.0, 0.0, 0.0, cb, sb, 0.0, -sb, cb);
}

float noise3Ht(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  return mix(mix(mix(hash11Lw(n), hash11Lw(n + 1.0), f.x),
                 mix(hash11Lw(n + 57.0), hash11Lw(n + 58.0), f.x), f.y),
             mix(mix(hash11Lw(n + 113.0), hash11Lw(n + 114.0), f.x),
                 mix(hash11Lw(n + 170.0), hash11Lw(n + 171.0), f.x), f.y), f.z);
}

float mapHt(vec3 p){
  if(gForm == 3){
    // A sheet rolling under the camera.
    float h = 0.35 * gAmp * sin(p.x * 1.7 + gTime * 0.8) * cos(p.z * 1.4 - gTime * 0.6)
            + 0.25 * sin(p.x * 0.7 - p.z * 0.9 + gTime * 0.5);
    float sheet = (p.y - h) * 0.6;
    return max(sheet, max(abs(p.x) - 1.6, abs(p.z) - 1.2));
  }
  p = spinHt(gTime * 0.25, 0.9 + 0.2 * sin(gTime * 0.17)) * p;
  if(gForm == 0){
    vec2 q = vec2(length(p.xz) - 0.85, p.y);
    return length(q) - 0.36 - 0.05 * gAmp * sin(atan(p.z, p.x) * 6.0 + gTime * 2.0);
  }
  if(gForm == 1){
    // Square section, turned by the angle round the ring: it twists as it goes.
    float a = atan(p.z, p.x);
    vec2 q = vec2(length(p.xz) - 0.85, p.y);
    float tw = a * 1.5 + gTime * 0.6;
    q = mat2(cos(tw), sin(tw), -sin(tw), cos(tw)) * q;
    vec2 d = abs(q) - vec2(0.26 + 0.05 * gAmp);
    return (length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 0.04) * 0.7;
  }
  // Blob: a sphere pushed about by slow noise.
  float dn = noise3Ht(p * 1.8 + vec3(0.0, gTime * 0.3, 0.0)) - 0.5;
  return (length(p) - 0.95 - dn * 0.6 * (0.5 + gAmp)) * 0.6;
}

/* Brightness of the form along a ray, or -1 where it misses. */
float shadeHt(vec3 ro, vec3 rd){
  float t = 0.0;
  for(int i = 0; i < 72; i++){
    float d = mapHt(ro + rd * t);
    if(d < 0.0015){
      vec3 p = ro + rd * t;
      vec2 e = vec2(0.002, 0.0);
      vec3 n = normalize(vec3(mapHt(p + e.xyy) - mapHt(p - e.xyy),
                              mapHt(p + e.yxy) - mapHt(p - e.yxy),
                              mapHt(p + e.yyx) - mapHt(p - e.yyx)));
      // The sheet is lit low from the side, or its slopes all print one tone.
      vec3 key = gForm == 3 ? normalize(vec3(-0.85, 0.32, 0.25)) : normalize(vec3(-0.5, 0.8, -0.4));
      float dif = clamp(dot(n, key), 0.0, 1.0);
      float rim = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.0);
      return clamp(0.08 + dif * 0.85 + rim * 0.25, 0.0, 1.0);
    }
    t += d;
    if(t > 9.0) break;
  }
  return -1.0;
}

void main(){
  vec2 frag = vUv * iResolution.xy;
  float kick = beatLw();
  gForm = formLw(4.0);
  gAmp = 0.35 + clamp(swell_react, 0.0, 2.5) * 0.5 + kick * 0.25;
  gTime = iTime;

  // The screen: cell size in pixels, scaled to the frame so it prints the
  // same on a laptop and a projector.
  float cell = iResolution.y / (34.0 + clamp(density_react, 0.0, 2.5) * 30.0);
  vec2 cid = floor(frag / cell);
  vec2 cc = (cid + 0.5) * cell;
  vec2 cuv = (cc / iResolution.xy - 0.5) * vec2(iResolution.x / iResolution.y, 1.0);

  vec3 ro, rd;
  cameraLw(cuv, vec3(0.0, gForm == 3 ? -0.15 : 0.0, 0.0), gForm == 3 ? 4.3 : 3.6,
           gForm == 3 ? 0.62 : 0.12, ro, rd);
  float b = shadeHt(ro, rd);

  vec3 col = paperLw();
  if(b >= 0.0){
    // Tone is the contrast of the print: high pulls the midtones down into
    // small dots and leaves only the lit side at full size.
    float g = 0.6 + clamp(tone_react, 0.0, 2.0) * 0.9;
    float lum = pow(b, g);
    float r = 0.5 * cell * sqrt(lum) * 0.98;
    float d = length(frag - cc) - r;
    float cov = clamp(0.5 - d, 0.0, 1.0);
    col = mix(col, mix(accentLw(), inkLw(), smoothstep(0.15, 0.7, lum)), cov);
  }

  fragColor = vec4(clamp(finishLw(col, uvLw()), 0.0, 1.0), 1.0);
}
`;

export const lwHalftone: ShaderDef = {
  id: 'lw_halftone',
  name: 'Linework — Halftone',
  description:
    'A form in space printed through a dot screen, its shading carried only by dot size: a torus, a twisting torus, a blob, a rolling sheet.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The form under the screen: a torus, a torus whose square section twists as it goes round, a lumpy blob, or a rolling sheet.',
    {
      id: 'tone',
      name: 'Tone',
      description: 'Contrast of the print. Up, the shadows go to pinpricks and only the lit side prints full.',
      defaultBand: 'none',
      defaultAmount: 0.4,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
