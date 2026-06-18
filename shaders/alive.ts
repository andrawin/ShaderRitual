/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Alive" — a pulsing organic blob (a displaced sphere with smin'd satellites)
 * lit with PBR over a voronoi aura.
 *
 * Adapted from a Shadertoy auto-VJ fork of coledea's "It is alive..."
 * (https://www.shadertoy.com/view/ctcGR8). The original drove everything from a
 * music-FFT texture in iChannel0 (read via texelFetch and packed into the buffer
 * alpha). We have no audio texture, so the shader's `fft` / `ffts` bands are
 * derived from the engine's band-driven element uniforms in BOTH passes instead.
 *
 * Two-pass: Buffer A makes a procedural displacement texture; the Image pass
 * raymarches the blob, using Buffer A (iChannel0) for surface displacement.
 *
 * Ported to GLSL-ES 1.00: texelFetch removed, `vec3[2](...)` constructors and
 * array params unrolled, `texture()` -> `texture2D()`, float loop made standard.
 *
 * Elements:
 *   pulse  -> the main blob's bass-driven swell      (fft.x)
 *   sats   -> the orbiting satellite spheres         (fft.y / speech bands)
 *   shimmer-> high-frequency surface detail          (fft.z / fft.w)
 *   aura   -> brightness of the voronoi background   (overall loudness)
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;

uniform float pulse_react;
uniform float sats_react;
uniform float shimmer_react;
uniform float aura_react;

#define DETAIL 20
#define ANIMATION_SPEED 2.0
#define BRIGHTNESS 0.2
#define STRUCTURE_SMOOTHNESS 1.2
#define SATURATION 0.2
#define aTime (2.133333 * iTime)

vec4 fft, ffts;

mat2 rotate2D(float r){ return mat2(cos(r), sin(r), -sin(r), cos(r)); }

// Map the engine's band/element reacts onto the original's FFT layout.
void setFft(){
  float lo = pulse_react, mi = sats_react, hi = shimmer_react;
  fft = vec4(lo, mi, hi, hi * 0.8);
  ffts = vec4(mi * 0.9, mi, mi * 0.7, aura_react);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  setFft();

  vec2 p = (fragCoord.xy - 0.5 * iResolution.xy) / iResolution.y;
  float dist_squared = dot(p, p);
  float S = 9.0;
  mat2 m = rotate2D(5.0);

  float a = 0.0;
  vec2 n = vec2(0.0), q;

  for(int ji = 1; ji <= DETAIL; ji++){
    float j = float(ji);
    p *= m;
    n *= m;
    q = p * S
      + iTime * fft.x * 0.01 * .15 * ANIMATION_SPEED
      + 1.8 * sin((aTime / 2. + fft.z) * ANIMATION_SPEED - dist_squared * 6.0) * 0.8
      + j + n;
    a += dot(cos(q) / S, vec2(SATURATION));
    n -= sin(q);
    S *= STRUCTURE_SMOOTHNESS;
  }

  float result = 0.2 * ((a + BRIGHTNESS) + a + a);
  fragColor = vec4(result);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float pulse_react;
uniform float sats_react;
uniform float sats_visible;
uniform float shimmer_react;
uniform float shimmer_visible;
uniform float aura_react;

#define PI 3.14159265359
#define aTime (2.133333 * iTime)

const int MAX_MARCHING_STEPS = 80;
const float MARCHING_EPSILON = 0.0001;
const float DERIVATIVE_EPSILON = 0.001;

const vec3 ALBEDO_INNER = vec3(3.0, 0.02, 0.03);
const vec3 ALBEDO_OUTER = vec3(0.3, 0.0, 0.0);

const vec3 SPHERE_CENTER = vec3(0.0);
const float SPHERE_RADIUS = .4;

vec4 fft, ffts;

mat2 rotate2D(float r){ return mat2(cos(r), sin(r), -sin(r), cos(r)); }

void setFft(){
  float lo = pulse_react, mi = sats_react, hi = shimmer_react;
  fft = vec4(lo, mi, hi, hi * 0.8);
  ffts = vec4(mi * 0.9, mi, mi * 0.7, aura_react);
}

vec2 spherical_mapping(vec2 nrm){
  return vec2(asin(nrm.x), asin(nrm.y)) / PI + 0.5;
}
float smin(float a, float b, float k){
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * (1.0 / 4.0);
}
vec3 hash(vec3 p){
  return fract(sin(vec3(
    dot(p, vec3(1.0, 57.0, 113.0)),
    dot(p, vec3(57.0, 113.0, 1.0)),
    dot(p, vec3(113.0, 1.0, 57.0)))) * 43758.5453);
}
vec3 voronoi3d(vec3 x){
  vec3 p = floor(x);
  vec3 f = fract(x);
  float id = 0.0;
  vec2 res = vec2(100.0);
  for(int k = -1; k <= 1; k++)
  for(int j = -1; j <= 1; j++)
  for(int i = -1; i <= 1; i++){
    vec3 b = vec3(float(i), float(j), float(k));
    vec3 r = b - f + hash(p + b);
    float d = dot(r, r);
    float cond = max(sign(res.x - d), 0.0);
    float nCond = 1.0 - cond;
    float cond2 = nCond * max(sign(res.y - d), 0.0);
    float nCond2 = 1.0 - cond2;
    id = (dot(p + b, vec3(1.0, 57.0, 113.0)) * cond) + (id * nCond);
    res = vec2(d, res.x) * cond + res * nCond;
    res.y = cond2 * d + nCond2 * res.y;
  }
  return vec3(sqrt(res), abs(id));
}

float organic_displacement(vec2 nrm){
  vec2 uv = spherical_mapping(nrm);
  return texture2D(iChannel0, uv).x;
}
float distToSphere(vec3 center, float radius, vec3 q){ return length(center - q) - radius; }

vec2 distToScene(vec3 q){
  float displacement = organic_displacement(normalize(q - SPHERE_CENTER).xy);
  float dist = length(SPHERE_CENTER - q) - (SPHERE_RADIUS + displacement);

  float sinTime = sin(iTime + fft.x * PI) * 0.2;
  float cosTime = cos(aTime / 4. + fft.y * PI) * 0.2;
  if(sats_visible > 0.5){
    dist = smin(dist, distToSphere(vec3(sinTime * sinTime, cosTime, sinTime), 0.5 * pow(fft.x, 9.), q), 0.4 + ffts.x * .3);
    dist = smin(dist, distToSphere(vec3(sinTime, sinTime * cosTime, cosTime), 0.3 * fft.y, q), 0.3 + .3 * ffts.y);
  }
  if(shimmer_visible > 0.5){
    dist = smin(dist, distToSphere(vec3(cosTime * cosTime, sinTime, sinTime * cosTime), 0.2 * fft.z, q), 0.2 + .2 * ffts.z);
  }
  return vec2(dist, displacement);
}

vec3 normal(vec3 p){
  const vec2 k = vec2(1, -1);
  return normalize(
    k.xyy * distToScene(p + k.xyy * DERIVATIVE_EPSILON).x +
    k.yyx * distToScene(p + k.yyx * DERIVATIVE_EPSILON).x +
    k.yxy * distToScene(p + k.yxy * DERIVATIVE_EPSILON).x +
    k.xxx * distToScene(p + k.xxx * DERIVATIVE_EPSILON).x);
}

// --- PBR (learnopengl.com/PBR/Lighting) ---
vec3 fresnelSchlick(float cosTheta, vec3 F0){
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
float DistributionGGX(vec3 N, vec3 H, float roughness){
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float NdotH2 = NdotH * NdotH;
  float denom = (NdotH2 * (a2 - 1.0) + 1.0);
  denom = PI * denom * denom;
  return a2 / denom;
}
float GeometrySchlickGGX(float NdotV, float roughness){
  float r = (roughness + 1.0);
  float k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}
float GeometrySmith(vec3 N, vec3 V, vec3 L, float roughness){
  return GeometrySchlickGGX(max(dot(N, V), 0.0), roughness) * GeometrySchlickGGX(max(dot(N, L), 0.0), roughness);
}

vec3 lightPBR(vec3 point, vec3 eye, float material){
  vec3 albedo = mix(ALBEDO_OUTER, ALBEDO_INNER, smoothstep(0.05, 0.08, material));
  float metallic = 0.0;
  float roughness = 0.1 + 0.4 * (1.0 - smoothstep(0.07, 0.08, material));
  float ao = smoothstep(0.05, 0.09, material);

  vec3 N = normalize(normal(point));
  vec3 V = normalize(eye - point);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);

  vec3 lp[2]; lp[0] = vec3(2.0, 0.0, 0.0); lp[1] = vec3(0.0, 1.0, 1.0);
  vec3 lc[2]; lc[0] = vec3(1.0); lc[1] = vec3(1.0);

  vec3 Lo = vec3(0.0);
  for(int i = 0; i < 2; i++){
    vec3 L = normalize(lp[i] - point);
    vec3 H = normalize(V + L);
    float distance = length(lp[i] - point);
    float attenuation = 1.0 / (distance * distance);
    vec3 radiance = lc[i] * attenuation;

    float NDF = DistributionGGX(N, H, roughness);
    float G = GeometrySmith(N, V, L, roughness);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);

    vec3 kD = (vec3(1.0) - F) * (1.0 - metallic);
    vec3 specular = (NDF * G * F) / (4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001);

    float NdotL = max(dot(N, L), 0.0);
    Lo += (kD * albedo / PI + specular) * radiance * NdotL;
  }

  vec3 color = vec3(0.03) * albedo * ao + Lo;
  color = color / (color + vec3(1.0));
  color = pow(color, vec3(1.0 / 2.2));
  return color;
}

vec3 getRayDirection(vec3 eye, vec2 fragCoord){
  vec2 p = (2.0 * fragCoord - iResolution.xy) / iResolution.y;
  vec3 ww = normalize(vec3(0.0) - eye);
  vec3 uu = normalize(cross(vec3(0.0, 1.0, 0.0), ww));
  vec3 vv = normalize(cross(ww, uu));
  float focal = 2.5 * (60.0 / iCamFov);
  return normalize(p.x * uu + p.y * vv + focal * ww);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  setFft();

  vec3 eye = vec3(sin(iTime * 0.05 + pow(abs(sin(aTime / 16.)), 9.) * PI) * 0.5 + 0.1, iCamHeight * 0.4, 1.8 * iCamDist);
  eye.xz *= rotate2D(iCamOrbit);
  vec3 ray = getRayDirection(eye, fragCoord);

  vec3 p = eye;
  for(int i = 0; i < MAX_MARCHING_STEPS; i++){
    vec2 qr = distToScene(p);
    if(qr.x < MARCHING_EPSILON){
      fragColor = vec4(lightPBR(p, eye, qr.y), 1.0);
      return;
    }
    p += ray * qr.x;
  }

  // background
  vec2 uv = fragCoord / iResolution.xy;
  float organic = texture2D(iChannel0, uv).x;
  uv.x *= iResolution.x / iResolution.y;
  uv = sin(iTime * 0.25) + uv * 6.0;
  vec3 voronoi = voronoi3d(vec3(-6.0, uv)) * .1 * (1. + 5. * fft.w);
  float final = pow(voronoi.r * 3.0, organic * 10.0 * (1. + 2. * fft.y));
  vec2 vg = (2. * fragCoord - iResolution.xy) / max(iResolution.x, iResolution.y) * 1.2;
  final *= length(vg) * length(vg); // vignette
  fragColor = vec4(final * .5 * ffts.w, 0., 0.015, 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const alive: ShaderDef = {
  id: 'alive',
  name: 'Alive',
  description:
    'A pulsing organic blob (displaced sphere with orbiting satellites) lit with PBR over a voronoi aura. Auto-VJ fork of coledea\'s "It is alive...".',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'pulse',
      name: 'Core Pulse',
      description: 'The main blob swell + displacement. React on bass.',
      defaultBand: 'low',
      defaultAmount: 1.2,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'sats',
      name: 'Satellites',
      description: 'Orbiting blobs that merge into the core. React on mids.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'shimmer',
      name: 'Shimmer',
      description: 'High-frequency surface detail + extra satellite. React on treble.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'aura',
      name: 'Aura',
      description: 'Brightness of the voronoi background glow. React on overall level.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
