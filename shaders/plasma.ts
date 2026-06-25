/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Plasma" — nimitz's Plasma Globe: volumetric filaments arcing inside a glass
 * sphere. (CC BY-NC-SA 3.0.)
 *
 * The original read a noise texture (iChannel0) and a music-FFT texture
 * (iChannel1). We have neither, so the texture noise is replaced with procedural
 * value noise and the FFT with the engine's band/element reacts. The ray count
 * (originally FFT-gated) is rebuilt as a constant loop + early break.
 *
 * Heavy: up to ~50 volumetric rays. Elements: arc / core / glow.
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
uniform float arc_react;
uniform float core_react;
uniform float glow_react;

#define NUM_RAYS 50.0
#define VOLUMETRIC_STEPS 19
#define MAX_ITER 35
#define FAR 6.0
#define time (iTime * 1.1)

float LOband(){ return clamp(core_react, 0.0, 1.0); }
float MIband(){ return clamp(arc_react, 0.0, 1.0); }
float HIband(){ return clamp(glow_react, 0.0, 1.0); }
float snd(){ return clamp(MIband() * 0.7 + LOband() * 0.3 + HIband() * 0.2, 0.0, 1.0); }
float fftv(float a){ float n = a / 80.0; return n < 0.4 ? LOband() : n < 0.75 ? MIband() : HIband(); }

mat2 mm2(in float a){ float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
float hash(float n){ return fract(sin(n) * 43758.5453); }
float h31(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float pn3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float noise(in vec3 p){ return pn3(p); }
float noise(in float x){ x *= 0.01; float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash(i), hash(i + 1.0), f); }

mat3 m3 = mat3(0.0, 0.8, 0.6, -0.8, 0.36, -0.48, -0.6, -0.48, 0.64);

vec3 Background(vec2 uv){
  float d = length(uv - vec2(0.0, 0.2));
  vec3 col = vec3(1.0, 0.4, 0.3);
  col *= smoothstep(0.8, 0.0, d) * 1.5 * (fftv(50.0) * 0.5 + 0.1);
  return col;
}
float flow(in vec3 p, in float t){
  float z = 2.0, rz = 0.0; vec3 bp = p;
  for(float i = 1.0; i < 5.0; i++){
    p += time * 0.1;
    rz += (sin(noise(p + t * 0.8) * 6.0) * 0.5 + 0.5) / z;
    p = mix(bp, p, 0.6);
    z *= 2.0; p *= 2.01; p *= m3;
  }
  return rz;
}
float sins(in float x){
  float rz = 0.0, z = 2.0;
  for(float i = 0.0; i < 3.0; i++){ rz += abs(fract(x * 1.4) - 0.5) / z; x *= 1.3; z *= 1.15; x -= time * 0.65 * z; }
  return rz;
}
float segm(vec3 p, vec3 a, vec3 b){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) * 0.5;
}
vec3 path(in float i, in float d){
  vec3 en = vec3(0.0, 0.0, 1.0);
  float sns2 = sins(d + i * 0.5) * 0.22, sns = sins(d + i * 0.6) * 0.21;
  en.xz *= mm2((hash(i * 10.569) - 0.5) * 6.2 + sns2);
  en.xy *= mm2((hash(i * 4.732) - 0.5) * 6.2 + sns);
  return en;
}
vec2 map(vec3 p, float i){
  float lp = length(p); vec3 bg = vec3(0.0);
  vec3 en = path(i, lp);
  float ins = smoothstep(0.11, 0.46, lp);
  float outs = 0.15 + smoothstep(0.0, 0.15, abs(lp - 1.0));
  p *= ins * outs;
  float id = ins * outs;
  float rz = segm(p, bg, en) - 0.011;
  return vec2(rz, id);
}
float march(in vec3 ro, in vec3 rd, in float startf, in float maxd, in float j){
  float precis = 0.001, h = 0.5, d = startf;
  for(int i = 0; i < MAX_ITER; i++){
    if(abs(h) < precis || d > maxd) break;
    d += h * 1.2;
    h = map(ro + rd * d, j).x * (0.3 + MIband() * 1.2) * 1.5;
  }
  return d;
}
vec3 vmarch(in vec3 ro, in vec3 rd, in float j, in vec3 orig){
  vec3 p = ro; vec2 r = vec2(0.0); vec3 sum = vec3(0.0);
  for(int i = 0; i < VOLUMETRIC_STEPS; i++){
    r = map(p, j); p += rd * 0.03;
    float lp = length(p);
    vec3 col = sin(vec3(1.05, 2.5, 1.52) * 3.94 + r.y) * 0.85 + 0.4 * snd();
    col.rgb *= smoothstep(0.0, 0.015, -r.x);
    col *= smoothstep(0.04, 0.2, abs(lp - 1.1));
    col *= smoothstep(0.1, 0.34, lp);
    sum += abs(col) * 5.0 * (1.2 - noise(lp * 2.0 + j * 13.0 + time * 5.0) * 1.1) / (log(distance(p, orig) - 2.0) + 0.75);
  }
  return sum * snd();
}
vec2 iSphere2(in vec3 ro, in vec3 rd){
  vec3 oc = ro; float b = dot(oc, rd); float c = dot(oc, oc) - 1.0; float h = b * b - c;
  if(h < 0.0) return vec2(-1.0);
  return vec2(-b - sqrt(h), -b + sqrt(h));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 p = fragCoord.xy / iResolution.xy - 0.5;
  p.x *= iResolution.x / iResolution.y;

  vec3 ro = vec3(0.0, iCamHeight, 5.0 * iCamDist);
  vec3 rd = normalize(vec3(p * 0.7, -1.5 * (60.0 / iCamFov)));
  mat2 mx = mm2(time * 0.4 + iCamOrbit);
  mat2 my = mm2(time * 0.3);
  ro.xz *= mx; rd.xz *= mx;
  ro.xy *= my; rd.xy *= my;

  vec3 bro = ro, brd = rd;
  vec3 col = vec3(0.0125, 0.0, 0.025);
  float nRays = 1.0 + NUM_RAYS * (0.2 + snd() * 0.8);

  for(int jj = 1; jj <= 50; jj++){
    if(float(jj) >= nRays) break;
    float j = float(jj);
    ro = bro; rd = brd;
    mat2 mm = mm2((time * 0.1 + ((j + 1.0) * 5.1)) * j * 0.25);
    ro.xy *= mm; rd.xy *= mm;
    ro.xz *= mm; rd.xz *= mm;
    float rz = march(ro, rd, 2.5, FAR, j);
    if(rz >= FAR) continue;
    vec3 pos = ro + rz * rd;
    col = max(col, vmarch(pos, rd, j, bro));
  }

  ro = bro; rd = brd;
  vec2 sph = iSphere2(ro, rd);
  if(sph.x > 0.0){
    vec3 pos = ro + rd * sph.x;
    vec3 pos2 = ro + rd * sph.y;
    vec3 rf = reflect(rd, pos);
    vec3 rf2 = reflect(rd, pos2);
    float nz = (-log(abs(flow(rf * 1.2, time) - 0.01)));
    float nz2 = (-log(abs(flow(rf2 * 1.2, -time) - 0.01)));
    col += (0.1 * nz * nz * vec3(0.12, 0.12, 0.5) + 0.05 * nz2 * nz2 * vec3(0.55, 0.2, 0.55)) * 0.8;
  }
  p.y = -p.y;
  vec3 bg = Background(p);
  col *= (0.3 + bg * 10.5);
  col += bg;
  fragColor = vec4(col * 1.3, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  fragColor = texture2D(iChannel0, fragCoord / iResolution.xy);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const plasma: ShaderDef = {
  id: 'plasma',
  name: 'Plasma',
  description: 'A plasma globe: volumetric electric filaments arcing inside a glass sphere (nimitz). Heavy — react drives the arc count.',
  bufferShader,
  imageShader,
  elements: [
    { id: 'arc', name: 'Arcs', description: 'Number + intensity of the plasma filaments. React on mids.', defaultBand: 'mid', defaultAmount: 1.0, canHide: false, defaultVisible: true },
    { id: 'core', name: 'Core Flow', description: 'The refracted flow on the glass. React on bass.', defaultBand: 'low', defaultAmount: 1.0, canHide: false, defaultVisible: true },
    { id: 'glow', name: 'Glow', description: 'Background bloom. React on treble.', defaultBand: 'high', defaultAmount: 1.0, canHide: false, defaultVisible: true },
  ],
};
