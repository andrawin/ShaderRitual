/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Horizon" — a monochrome scrolling landscape (fractal terrain, wind-bent
 * trees, flocking birds) projected through a stack of 50 scaled copies, like
 * light through a lantern.
 *
 * Adapted from a Shadertoy original that sampled an RGBA noise texture on
 * iChannel0. Ported to GLSL-ES 1.00 with the noise texture rebuilt in Buffer B
 * (256-cell smooth value noise, repeat-wrapped, read via iChannel1) and the
 * one-shot intro fades removed.
 *
 * Elements:
 *   beam  -> strength of the layered light-beam projection
 *   birds -> the bird flocks (flap energy; hideable)
 *   trees -> the fractal trees (sway; hideable)
 *   haze  -> the cloud/haze band over the far terrain (hideable)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel1;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float beam_react;
uniform float birds_react;
uniform float birds_visible;
uniform float trees_react;
uniform float trees_visible;
uniform float haze_react;
uniform float haze_visible;

float noise(vec2 p){
  return texture2D(iChannel1, p).x;
}

float fnoise(vec2 uv, vec4 sc){
  float f  = sc.x*noise(uv); uv = 2.*uv+.11532185;
        f += sc.y*noise(uv); uv = 2.*uv+.23548563;
        f += sc.z*noise(uv); uv = 2.*uv+.12589452;
        f += sc.w*noise(uv); uv = 2.*uv+.26489542;
  return f;
}

float terrain(float x){
  float w = 0.;
  float a = 1.;
  x *= 20.;
  w += sin(x*.3521)*4.;
  for(int i = 0; i < 5; i++){
    x *= 1.53562;
    x += 7.56248;
    w += sin(x)*a;
    a *= .5;
  }
  return .2+w*.015;
}

float bird(vec2 p){
  p.x += iTime*.05;
  float t = iTime*.05 + noise(vec2(floor(p.x/.4-.2)*.7213548))*.7;
  p.x = mod(p.x, .4)-.2;
  p *= 2.-mod(t, 1.)*2.;
  p.y += .6-mod(t, 1.);
  // element: flap energy pushed by the band
  p.y += pow(abs(p.x), 2.)*20.*(.2+sin(iTime*20.)*(1.+birds_react));
  float s = step(0.003-abs(p.x)*.1, abs(p.y));
  return min(s, step(0.005, length(p+vec2(0., .0015))));
}

float tree(vec2 p, float tx){
  float noisev = noise(p.xx*.1+.552121)*.25;
  p.x = mod(p.x, .2)-.1;
  p *= 15.+noise(vec2(tx*1.72561))*10.;
  float ot = 1000.;
  float a = radians(-60.+noise(vec2(tx))*30.);
  a += sin(iTime*2.+tx*20.)*.06*trees_react; // element: wind sway
  for(int i = 0; i < 7; i++){
    ot = min(ot, length(max(vec2(0.), abs(p)-vec2(-a*.15, .9))));
    float s = (sign(p.x)+1.)*.25;
    p.x = abs(p.x);
    p = p*1.3-vec2(0., 1.+noisev);
    a *= .8;
    a -= (noise(vec2(float(i+2)*.55170275+tx, s))-.5)*.2;
    mat2 rotm = mat2(cos(a), sin(a), -sin(a), cos(a));
    p *= rotm;
  }
  return step(0.05, ot);
}

float scene(vec2 p){
  float t = terrain(p.x);
  float s = step(0., p.y+t);
  float tx = floor(p.x/.2)*.2+.1;
  if(trees_visible > 0.5 && noise(vec2(tx*3.75489)) > .55){
    s = min(s, tree(p+vec2(0., terrain(tx)), .42+tx*4.5798523));
  }
  if(birds_visible > 0.5) s = min(s, bird(p));
  return s;
}

float aascene(vec2 p){
  vec2 pix = vec2(0., .25/iResolution.x);
  float aa = scene(p);
  aa += scene(p+pix.xy);
  aa += scene(p+pix.yy);
  aa += scene(p+pix.yx);
  return aa*.25;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord.xy / iResolution.xy - .5;
  uv.x *= iResolution.x/iResolution.y;
  float v = 0.;
  float l = 1.;
  float t = iTime*.05;
  vec2 c = vec2(-t - iCamOrbit*.03, 0.); // orbit scrubs the scroll
  vec2 p = vec2(0.);
  float sc = clamp(t*t*.5, .05, .15);
  uv.y -= .25 + iCamHeight*.2;
  uv.x -= .2;
  uv *= (iCamFov/60.) * max(iCamDist, 0.3); // fov + distance zoom the lantern
  for(int i = 0; i < 50; i++){
    p = uv*sc;
    l = pow(max(0., 1.-length(p)*2.), 15.);
    l = .02+l*.8;
    v += scene(p+c)*pow(float(i+1)/30., 2.)*l;
    sc += .006;
  }
  float clo = fnoise((uv-vec2(t, 0.))*vec2(.03, .15), vec4(.8, .6, .3, .1))*max(0., 1.-uv.y*3.);
  clo *= haze_visible * (0.6 + haze_react*0.8); // element: haze band
  float tx = uv.x-t*.5;
  float ter = .5+step(0., uv.y-fnoise(vec2(tx)*.015,
        vec4(1., .5, .3, .1))*(.23*(1.+sin(tx*3.2342)*.25))+.5);
  float s = aascene(p+c)*(ter+clo*.4);
  // element: beam strength (0.5 manual level = original at rest)
  v *= .025*(0.5 + beam_react);
  float col = min(1., .05+v+s*l);
  col = sqrt(col)*2.05-.5;
  fragColor = vec4(vec3(col), 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

// Smooth value noise with 256-cell tiling — stands in for Shadertoy's
// linear-filtered 256x256 RGBA noise texture (read repeat-wrapped as iChannel1).
const bufferBShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

float hash(vec2 p){
  p = fract(p * vec2(.16632, .17369));
  p += dot(p, p.yx+19.19);
  return fract(p.x * p.y * 95.4337);
}

void main(){
  vec2 p = vUv * 256.;
  vec2 c = floor(p);
  vec2 f = fract(p);
  f = f*f*(3.-2.*f);
  float n = mix(
    mix(hash(mod(c, 256.)),               hash(mod(c+vec2(1., 0.), 256.)), f.x),
    mix(hash(mod(c+vec2(0., 1.), 256.)),  hash(mod(c+vec2(1., 1.), 256.)), f.x),
    f.y);
  gl_FragColor = vec4(vec3(n), 1.);
}
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.); }
`;

export const horizon: ShaderDef = {
  id: 'horizon',
  name: 'Horizon',
  description:
    'A monochrome scrolling landscape — terrain, wind-bent trees and bird flocks projected like light through a lantern.',
  bufferShader,
  bufferBShader,
  imageShader,
  elements: [
    {
      id: 'beam',
      name: 'Light Beam',
      description: 'The layered projection glow. The manual level sets the resting brightness.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'birds',
      name: 'Birds',
      description: 'The bird flocks. React whips their flapping; hide for a still sky.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trees',
      name: 'Trees',
      description: 'The fractal trees. React sways them in the wind.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'haze',
      name: 'Haze',
      description: 'The cloud/haze band over the far terrain.',
      defaultBand: 'mid',
      defaultAmount: 0.6,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
