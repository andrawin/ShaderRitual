/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Blossom" — a cherry tree rendered as a living painting: Buffer A raymarches
 * a space-folded fractal tree, the Image pass repaints it with thousands of
 * brushed circle splats plus a pencil-sketch edge pass.
 *
 * Adapted from a Shadertoy original. Ported to GLSL-ES 1.00: the comma-operator
 * branch loop is spelled out, the `& 1` parity bit-op becomes a float mod, and
 * the demo's fixed timeline becomes a controllable growth stage.
 *
 * Elements:
 *   growth -> growth stage of the tree (manual level scrubs seed -> full bloom)
 *   wind   -> branch sway
 *   paint  -> the painterly splat repaint (hideable -> raw 3D render)
 *   sketch -> pencil edge darkening (hideable)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float growth_react;
uniform float wind_react;

float hash(float n){
  return fract(sin(n)*43758.5453);
}
float noise(vec2 p){
  return hash(p.x + p.y*57.0);
}
float valnoise(vec2 p){
  vec2 c = floor(p);
  vec2 f = smoothstep(0., 1., fract(p));
  return mix(mix(noise(c+vec2(0., 0.)), noise(c+vec2(1., 0.)), f.x),
             mix(noise(c+vec2(0., 1.)), noise(c+vec2(1., 1.)), f.x), f.y);
}

float ti;
float col = 1e3;
float col2 = 1e3;
float col3 = 1e3;

// Signed distance field: ground disc + space-folded fractal tree + blossoms.
float f(vec3 p){
  col3 = p.y-(.5+.5*cos(p.x*2.))*.1;

  float d = max(col3, length(p.xz)-5.5);
  float s = 1.;
  float ss = 1.6;

  // Branch local frame (wind element sways it).
  vec3 w = normalize(vec3(-.8+cos(iTime/30.)*.01 + sin(iTime*1.2)*.05*wind_react, 1.2, -1.));
  vec3 u = normalize(cross(w, vec3(0., 1., 0.)));

  float j = min(floor(ti-1.), 7.);

  float scale = min(.3+ti/6., 1.);
  p /= scale;

  // Tree branches: space-folded cylinders (de-golfed comma loop).
  for(int i = 0; i < 8; i++){
    d = min(d, scale*max(p.y-1., max(-p.y, length(p.xz)-.1/(p.y+.7)))/s);
    p.xz = abs(p.xz);
    p.y -= 1.;
    if(float(i) >= j) break;
    p *= mat3(u, normalize(cross(u, w)), w);
    p *= ss;
    s *= ss;
  }

  col = max(0., length(p)-.25)/s;
  return min(d, col);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord/iResolution.xy;

  vec2 tuv = (uv*2.-1.)*.5;
  tuv.x *= iResolution.x/iResolution.y;

  // Growth element: the demo's fixed timeline becomes a scrubbed stage
  // (level 1 = fully grown; assign a band to grow it with the music).
  float stageT = 6. + clamp(growth_react, 0., 1.25)*140.;

  ti = max(0., stageT)/3.;
  ti = noise(floor(gl_FragCoord.xy)) + (floor(ti)+clamp(fract(ti)*2., 0., 1.));
  ti = floor(ti);

  float zoom = 1.5*(60./iCamFov);

  // Camera: original bob + rig orbit / height / distance.
  vec3 camtarget = vec3(0., 1.3, 0.);
  vec3 ro = vec3(-2.5+cos(iTime/4.), .1+cos(ti*17.)*.1 + iCamHeight*1.2, 3.5);
  ro = camtarget + (ro-camtarget)*iCamDist;
  float co = cos(iCamOrbit*.5); float so = sin(iCamOrbit*.5);
  ro.xz = mat2(co, -so, so, co)*(ro.xz - camtarget.xz) + camtarget.xz;
  vec3 rd = normalize(vec3(tuv.xy, zoom));
  if(ti == 10.) ro.y += 2.;

  vec3 w = normalize(camtarget-ro);
  vec3 u = normalize(cross(w, vec3(0., 1., 0.)));
  vec3 v = normalize(cross(w, -u));

  rd = mat3(u, v, w)*rd;

  fragColor = vec4(vec3(.8, .8, 1.)/6., 1.);

  // Signed distance field raymarch.
  float mt = 0.;
  float d = 0.;
  for(int i = 0; i < 100; ++i){
    d = f(ro+rd*mt);
    if(d < 1e-3) break;
    mt += d;
    if(mt > 10.) return;
  }

  // Colourise ground, branch/trunk, or cherry blossom.
  {
    fragColor.rgb = vec3(.75, .6, .4)/1.5;
    if(col < 2e-3) fragColor.rgb = vec3(1., .7, .8);
    if(col3 < 2e-2 && (ti < 17. || ti > 22.)) fragColor.rgb = vec3(.5, 1., .6)/3.;
  }

  // Lighting.
  vec3 ld = normalize(vec3(1., 3.+cos(ti)/2., 1.+sin(ti*3.)/2.));
  float e = 1e-2;
  float d2 = f(ro+rd*mt+ld*e);
  float l = max(0., (d2-d)/e);

  float d3 = f(ro+rd*mt+vec3(0., 1., 0.)*e);
  float l2 = max(0., .5+.5*(d3-d)/e);

  // Snow / blossom-carpet transition stages.
  {
    vec3 rp = ro+rd*mt;
    if(ti > 12. && ti < 22.){
      if(col2 < 1e-2 || d3+d2/7. > 0.0017 && pow(valnoise(rp.xz*8.), 2.) > abs(ti-18.)/5.) fragColor.rgb = vec3(.65);
    }
  }
  {
    vec3 rp = ro+rd*mt;
    if(ti > 12. && ti < 17.){
      if(col2 < 1e-2 || d3+d2/7. > 0.0017 && valnoise(rp.xz*8.) < (ti-12.)/3.) fragColor.rgb = vec3(.65);
    }
  }

  vec3 rp = ro+rd*(mt-1e-3);

  // Directional shadow.
  float st = 0.1;
  float sh = 1.;
  for(int i = 0; i < 30; ++i){
    d = f(rp+ld*st)+.01;
    sh = min(sh, d*50.+0.3);
    if(d < 1e-4) break;
    st += d;
  }

  fragColor.rgb *= 1.*sh*(.2+.8*l)*vec3(1., 1., .9)*.7 + l2*vec3(.85, .85, 1.)*.4;
  fragColor.rgb = clamp(fragColor.rgb, 0., 1.);
  fragColor.a = 1.;
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

uniform float paint_react;
uniform float paint_visible;
uniform float sketch_react;
uniform float sketch_visible;

float hash(float n){
  return fract(sin(n)*43758.5453);
}
float noise(vec2 p){
  return hash(p.x + p.y*57.0);
}
float valnoise(vec2 p){
  vec2 c = floor(p);
  vec2 f = smoothstep(0., 1., fract(p));
  return mix(mix(noise(c+vec2(0., 0.)), noise(c+vec2(1., 0.)), f.x),
             mix(noise(c+vec2(0., 1.)), noise(c+vec2(1., 1.)), f.x), f.y);
}

float seed;
float rand(){
  float v = fract(sin(seed)*43758.545);
  seed += 1.;
  return v;
}

// Sample the 3D render at a splat-space coordinate (exact inverse of the
// buffer's aspect-corrected mapping).
vec4 samp(vec2 p){
  p.x /= iResolution.x/iResolution.y;
  p /= .55;
  return texture2D(iChannel0, p*.5+.5)*1.05;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord/iResolution.xy;
  vec2 t = (uv*2.-1.)*.55;
  t.x *= iResolution.x/iResolution.y;

  // Hide paint -> show the raw 3D render.
  if(paint_visible < 0.5){
    fragColor = vec4(texture2D(iChannel0, uv).rgb, 1.);
    return;
  }

  // element: splat opacity (level 0.5 = original look at rest)
  float paintAmt = 0.6 + paint_react*0.8;

  // Splat circular brush strokes sampled from the 3D render.
  vec3 c = vec3(.8, .8, 1.)/6.;
  vec2 p = t;
  for(int n = 0; n < 2; ++n){
    float maxr = mix(1./22., 1./4., 1.-float(n))*.4;

    vec2 uo = floor(p/maxr);
    for(int i = -1; i < 2; ++i){
      for(int j0 = -1; j0 < 2; ++j0){
        // ((uo.x+i)&1)==1 parity, as a float mod (ES 1.00 has no bit ops).
        float odd = mod(uo.x+float(i), 2.);
        vec2 u = uo + vec2(float(i), odd > 0.5 ? -float(j0) : float(j0));
        seed = u.x*881.+u.y*927.+float(n)*1801.;
        for(int k = 0; k < 11; ++k){
          vec2 o = (u+vec2(rand(), rand()))*maxr;
          vec2 p2 = p-o;
          vec3 cc = samp(o).rgb;
          float a = dot(cc, vec3(1./3.));
          float r = mix(.25, .99, pow(rand(), 4.))*maxr;
          float ang = rand()*acos(-1.)*2.; // stroke-line angle inside the circle
          float d = length(p2);
          p2 *= mat2(cos(ang), sin(ang), -sin(ang), cos(ang));
          cc = mix(cc, vec3(a)*1.5, pow(rand(), 16.));
          if(rand() > -floor(iTime*2.)/2./10.){
            // Shade in the circle, and an outline of the circle.
            c = mix(c, cc, mix(.1, .4, rand())*3.*paintAmt*pow(a, .8)*mix(.8, 1., cos(p2.x*1200.)*.5+.5)*clamp((r-d)/mix(.001, .004, rand()), 0., 1.));
            c = mix(c, cc/2., mix(.14, .3, pow(rand(), 16.))/4.*clamp(1.-abs(r-d)/.002, 0., 1.));
          }
        }
      }
    }
  }

  // Pencil-sketch darkening from edge detection (hideable element).
  if(sketch_visible > 0.5){
    vec2 e = vec2(1e-3, 0.);
    vec2 p2 = p+(valnoise(p*18.)-.5)*.01;
    float c0 = dot(vec3(1./3.), samp(p2).rgb);
    float c1 = dot(vec3(1./3.), samp(p2+e.xy).rgb);
    float c2 = dot(vec3(1./3.), samp(p2+e.yx*1.8).rgb);
    float cap = .13*clamp(sketch_react, 0., 2.);
    c *= vec3(mix(.1, 1., 1.-clamp(max(abs(c2-c0), abs(c1-c0))*4., 0., cap)));
  }

  // Final output.
  c = (c-.5)*1.1+.5;
  fragColor = vec4(sqrt(c*mix(.9, 1., valnoise(t.xy*400.)))*1.28, 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const blossom: ShaderDef = {
  id: 'blossom',
  name: 'Blossom',
  description:
    'A cherry tree as a living painting — a raymarched fractal tree repainted with brushed circle splats and pencil edges.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'growth',
      name: 'Growth',
      description: 'Growth stage: level 0 = seedling, 1 = full bloom. Band-assign to grow with the music.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'wind',
      name: 'Wind',
      description: 'Branch sway. React shakes the crown.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'paint',
      name: 'Paint Splats',
      description: 'The painterly repaint. React thickens strokes; hide for the raw 3D render.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sketch',
      name: 'Pencil Edges',
      description: 'Edge-detected pencil darkening. React deepens the linework.',
      defaultBand: 'none',
      defaultAmount: 0.6,
      defaultLevel: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
