/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Oscilloscope" — a glowing vector-scope drawing a procedural Lissajous/
 * spirograph waveform, with frame-feedback persistence and a CRT post pass.
 * Adapted from a Shadertoy original (procedural `mainSound`, so no real audio
 * needed). Ported to GLSL-ES 1.00: iTimeDelta -> fixed dt, tanh() helper,
 * texture() -> texture2D(), constant loop bound. Audio wired via elements.
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform float wave_react;
uniform float trails_react;
uniform float color_react;

#define TAU 6.2831
#define DT 1.5
#define NBITERATIONS 180

vec4 tnh(vec4 x){ vec4 e = exp(-2.0 * abs(x)); return sign(x) * (1.0 - e) / (1.0 + e); }

mat3 rotationMatrix(vec3 axis, float angle){
  axis = normalize(axis);
  float s = -sin(angle), c = cos(angle), oc = 1.0 - c;
  return mat3(
    oc*axis.x*axis.x + c,        oc*axis.x*axis.y - axis.z*s, oc*axis.z*axis.x + axis.y*s,
    oc*axis.x*axis.y + axis.z*s, oc*axis.y*axis.y + c,        oc*axis.y*axis.z - axis.x*s,
    oc*axis.z*axis.x - axis.y*s, oc*axis.y*axis.z + axis.x*s, oc*axis.z*axis.z + c);
}

int Shape = 0;

vec2 gen(float t, float f){
  float q = t * TAU * f;
  vec2 r = vec2(0.0);
  if(Shape == 0){
    q *= 3.0;
    r += 1.0 * cos(5.0 * q + vec2(t, TAU / 4.0));
    r += 2.0 * cos(3.0 * q + vec2(0.0, TAU / 2.0));
    r += 0.6 * cos(8.0 * q + vec2(t * 8.0, TAU / 2.0));
    r /= 4.0;
  } else {
    mat3 Sys = mat3(0.0);
    Sys[0][0] = 1.0; Sys[1][1] = 1.0; Sys[2][2] = 1.0;
    vec3 p = vec3(0.0);
    float sumRad = 1.0;
    float m = 8.0;
    for(float i = 1.0; i < 4.0; i++){
      float rad = i == 1.0 ? 8.0 : i == 2.0 ? 4.0 : i == 3.0 ? 1.0 : 0.0;
      float ang = i == 1.0 ? 1.0 * i * q - t : i == 2.0 ? m * i * q + t * 2.2 : i == 3.0 ? 2.0 * m * i * q : 0.0;
      float ca = cos(ang), sa = sin(ang);
      p += Sys * vec3(ca, sa, 0.0) * rad;
      Sys *= mat3(0.0, 0.0, 1.0, ca, sa, 0.0, -sa, ca, 0.0);
      sumRad += rad;
    }
    p *= rotationMatrix(vec3(2.0, -1.0 * cos(t * 2.0), 1.0), TAU * 0.5 * t);
    r = p.xy / sumRad;
  }
  return r;
}

vec2 sig(float t){
  Shape = (cos(t * 0.5) + sin(t * 3.0)) > 0.8 ? 0 : 1;
  vec2 r = gen(t, mix(13.0, min(20.0 + t * 3.0, 500.0), pow(cos(t / 24.0 * TAU) * 0.499 + 0.501, 2.0)));
  return clamp(r, -1.0, 1.0);
}

vec2 segment(vec2 p, vec2 a, vec2 b){
  float len = length(b - a);
  if(len < 1e-2) return vec2(dot(p - a, p - a), 0.0);
  a -= p; b -= p;
  vec3 k = vec3(dot(a, a), dot(b, b), dot(a, b));
  float t = (k.x - k.z) / (k.x + k.y - 2.0 * k.z);
  if(t < 0.0) return vec2(k.x, 0.0);
  if(t > 1.0) return vec2(k.y, 1.0);
  a = a * (1.0 - t) + b * t;
  return vec2(dot(a, a), t);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec2 uv_ = uv - 0.5;
  uv_.x *= iResolution.x / iResolution.y;
  uv_ += 0.5;
  fragColor = vec4(0.0);
  vec2 uvSound = uv_ * 2.0 - 1.0;

  float t = iTime;
  float dt = 0.016 * DT;
  float nbPointsF = float(NBITERATIONS);

  vec3 beam = mix(vec3(0.2, 1.0, 0.1), 3.0 * abs(1.0 - 2.0 * fract(color_react + vec3(0.0, -1.0/3.0, 1.0/3.0))) - 1.0, color_react);
  float lum = 6e4;
  float tBegin = t - dt * 0.97, tEnd = t;
  float tLoop = tBegin;
  vec2 A = sig(tLoop);
  float tStep = (tEnd - tBegin) / nbPointsF;
  tLoop += tStep;

  for(int i = 1; i <= NBITERATIONS; i++){
    if(tLoop > tEnd) break;
    float iF = float(i);
    vec2 B = sig(tLoop);
    vec2 seg = segment(uvSound, A, B);
    float k = (iF + seg.y) / nbPointsF - 0.5;
    float aa = max(1.0 - k * k * 4.0, 0.0);
    aa *= aa;
    fragColor.rgb += beam * aa * aa / (1.0 + seg.x * lum) * (0.6 + wave_react * 1.4);
    tLoop += tStep;
    A = B;
  }

  float fb = clamp(0.5 + trails_react * 0.45, 0.0, 0.97);
  fragColor += texture2D(iChannel0, uv) * fb;
  fragColor = tnh(fragColor);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

vec3 smp(float u, float v){ return texture2D(iChannel0, vec2(u, v)).xyz; }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec3 col;
  float x = sin(0.3 * iTime + uv.y * 21.0) * sin(0.7 * iTime + uv.y * 29.0) * sin(0.3 + 0.33 * iTime + uv.y * 31.0) * 0.0017;
  col.r = smp(x + uv.x + 0.001, uv.y + 0.001).x + 0.05;
  col.g = smp(x + uv.x, uv.y - 0.002).y + 0.05;
  col.b = smp(x + uv.x - 0.002, uv.y).z + 0.05;
  col.r += 0.08 * smp(0.75 * (x + 0.025) + uv.x + 0.001, 0.75 * -0.027 + uv.y + 0.001).x;
  col.g += 0.05 * smp(0.75 * (x - 0.022) + uv.x, 0.75 * -0.02 + uv.y - 0.002).y;
  col.b += 0.08 * smp(0.75 * (x - 0.02) + uv.x - 0.002, 0.75 * -0.018 + uv.y).z;
  col = clamp(col * 0.6 + 0.4 * col * col, 0.0, 1.0);

  float vig = 16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y);
  col *= vec3(pow(vig, 0.3));
  col *= vec3(0.95, 1.05, 0.95) * 2.8;

  float scans = clamp(0.35 + 0.35 * sin(4.0 * iTime + uv.y * iResolution.y), 0.0, 1.0);
  col *= vec3(0.4 + 0.7 * pow(scans, 1.7));
  col *= 1.0 + 0.01 * sin(50.0 * iTime);
  col *= 1.0 - 0.65 * vec3(clamp((mod(uv.x * iResolution.x, 2.0) - 1.0) * 2.0, 0.0, 1.0));

  float grid = 1.0;
  grid *= 1.0 - smoothstep(0.98, 0.99, 2.0 * abs(fract(uv.x * 10.0) - 0.5));
  grid *= 1.0 - smoothstep(0.96, 0.98, 2.0 * abs(fract(uv.y * 6.0) - 0.5));
  col *= 0.5 + 0.5 * grid;

  fragColor = vec4(col, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const oscilloscope: ShaderDef = {
  id: 'oscilloscope',
  name: 'Oscilloscope',
  description: 'A glowing CRT vector-scope drawing a procedural spirograph waveform with feedback trails.',
  bufferShader,
  imageShader,
  elements: [
    { id: 'wave', name: 'Beam', description: 'Brightness of the traced waveform. React on mids.', defaultBand: 'mid', defaultAmount: 1.0, canHide: false, defaultVisible: true },
    { id: 'trails', name: 'Persistence', description: 'Phosphor trail / feedback length. React on bass.', defaultBand: 'low', defaultAmount: 1.0, canHide: true, defaultVisible: true },
    { id: 'color', name: 'Beam Colour', description: 'Tint of the trace. React shifts the hue.', defaultBand: 'high', defaultAmount: 0.4, canHide: true, defaultVisible: true },
  ],
};
