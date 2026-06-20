/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FilterType } from '../types';

/**
 * Global audio-reactive post-processing pass. Runs *after* every shader's
 * Image pass (regardless of which shader is active), sampling the rendered
 * frame from iChannel0 and applying a single selectable filter at `uAmount`
 * intensity. The amount is driven live by an audio band so the whole frame
 * can pump with the music — edge-detect on the kick, pixelate on the snare,
 * chroma-shift on the hats, etc.
 *
 *   uFilter -> integer id (index into POST_FILTERS below)
 *   uAmount -> 0..1 effect intensity (base amount + band * react, clamped)
 */
export interface PostFilter {
  id: FilterType;
  name: string;
}

/** Order is significant — the index is the `uFilter` value sent to the GPU. */
export const POST_FILTERS: PostFilter[] = [
  { id: 'none', name: 'None' },
  { id: 'pixelate', name: 'Pixelate' },
  { id: 'edge', name: 'Edge Detect' },
  { id: 'chroma', name: 'Chroma Shift' },
  { id: 'posterize', name: 'Posterize' },
  { id: 'scanlines', name: 'Scanlines' },
  { id: 'mirror', name: 'Kaleidoscope' },
];

export function filterIndex(type: FilterType): number {
  const i = POST_FILTERS.findIndex((f) => f.id === type);
  return i < 0 ? 0 : i;
}

export const postShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform int uFilter;
uniform float uAmount;

vec3 smp(vec2 uv){ return texture2D(iChannel0, clamp(uv,0.0,1.0)).rgb; }
float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }

void main(){
  vec2 uv = vUv;
  vec2 texel = 1.0/iResolution.xy;
  float a = clamp(uAmount,0.0,1.0);
  vec3 col = smp(uv);

  if(uFilter==1){
    // Pixelate — quantise UV into chunky cells.
    float size = mix(1.0, 90.0, a);
    vec2 cell = max(vec2(1.0), iResolution.xy/size);
    vec2 uvp = (floor(uv*cell)+0.5)/cell;
    col = smp(uvp);
  } else if(uFilter==2){
    // Edge detect — 3x3 Sobel on luminance.
    float tl=luma(smp(uv+texel*vec2(-1.,-1.)));
    float tc=luma(smp(uv+texel*vec2( 0.,-1.)));
    float tr=luma(smp(uv+texel*vec2( 1.,-1.)));
    float ml=luma(smp(uv+texel*vec2(-1., 0.)));
    float mr=luma(smp(uv+texel*vec2( 1., 0.)));
    float dl=luma(smp(uv+texel*vec2(-1., 1.)));
    float dc=luma(smp(uv+texel*vec2( 0., 1.)));
    float dr=luma(smp(uv+texel*vec2( 1., 1.)));
    float gx = -tl -2.0*ml -dl + tr +2.0*mr + dr;
    float gy = -tl -2.0*tc -tr + dl +2.0*dc + dr;
    float g = sqrt(gx*gx+gy*gy);
    col = mix(col, vec3(g), a);
  } else if(uFilter==3){
    // Chroma shift — split the RGB channels horizontally.
    float o = a*0.03;
    col = vec3(smp(uv+vec2(o,0.)).r, smp(uv).g, smp(uv-vec2(o,0.)).b);
  } else if(uFilter==4){
    // Posterize — crush the colour depth.
    float levels = mix(16.0, 2.0, a);
    col = floor(col*levels+0.5)/levels;
  } else if(uFilter==5){
    // Scanlines — CRT-style horizontal banding.
    float line = 0.5+0.5*sin(uv.y*iResolution.y*3.14159);
    col *= mix(1.0, line, a);
  } else if(uFilter==6){
    // Kaleidoscope — mirror an angular wedge around the centre.
    vec2 c = uv-0.5;
    c.x *= iResolution.x/iResolution.y;
    float ang = atan(c.y, c.x);
    float rad = length(c);
    float seg = mix(6.2831853, 0.5235988, a); // full frame -> 12-fold mirror
    ang = abs(mod(ang, seg) - seg*0.5);
    vec2 m = vec2(cos(ang), sin(ang))*rad;
    m.x /= iResolution.x/iResolution.y;
    col = smp(m+0.5);
  }

  gl_FragColor = vec4(col,1.0);
}
`;
