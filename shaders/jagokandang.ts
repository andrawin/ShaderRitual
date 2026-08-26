/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Jago Kandang" — a flight through volumetric storm mist lit by two duelling
 * lights, red against blue, with lightning discharging along the line between
 * them and blowing the fog white.
 *
 * Adapted from a Shadertoy original. This one needed the most rework for
 * GLSL-ES 1.00: the fbm sampled a noise texture through textureLod (rebuilt in
 * Buffer B and read with texture2D), the dither used a uint hash with bit-ops
 * (replaced by a float hash), the lights lived in a struct array indexed in a
 * loop (unrolled to two), the light-cast loop had a runtime bound (constant
 * bound with an early break), and the FFT texture read that drove the flashes
 * now comes from the band uniforms. Step count is cut from 320 to 160.
 *
 * Elements:
 *   mist   -> density of the storm fog
 *   lights -> brightness of the two duelling lights
 *   bolt   -> lightning discharge between them; hideable
 *   speed  -> flight speed through the storm
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

uniform float mist_react;
uniform float lights_react;
uniform float bolt_react;
uniform float bolt_visible;
uniform float speed_react;

#define MARCH_ITERATIONS 160
#define MARCH_DELTA 0.055
#define MARCH_DELTA2 1.02
#define START_DIST 4.0
#define MIST_LOD 5
#define LIGHT_LOD 5

float blerp(float x, float y0, float y1, float y2, float y3){
  float a = y3 - y2 - y0 + y1;
  float b = y0 - y1 - a;
  float c = y2 - y0;
  return a * x * x * x + b * x * x + c * x + y1;
}
float rand(vec2 co){
  return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
float perlin(float x, float h){
  float a = floor(x);
  return blerp(mod(x, 1.0),
    rand(vec2(a - 1.0, h)), rand(vec2(a - 0.0, h)),
    rand(vec2(a + 1.0, h)), rand(vec2(a + 2.0, h)));
}

/** Was a uint hash with shifts and masks — float arithmetic instead. */
float dither1(vec2 co, float t){
  return fract(sin(dot(co, vec2(12.9898, 78.233)) + t * 0.017) * 43758.5453);
}

/** Bilinear value noise from the Buffer B texture (was textureLod). */
float noise2(in vec3 x){
  vec3 p = floor(x);
  vec3 f = fract(x);
  f = (f * f * (3.0 - 2.0 * f) + f) * 0.5;
  vec2 uv = (p.xy + vec2(37.0, 17.0) * p.z) + f.xy;
  vec2 rg = texture2D(iChannel1, (uv + 0.5) / 256.0).yx;
  return mix(rg.x, rg.y, f.z);
}

float mistAt(vec3 p, int lod){
  vec3 p2 = p;
  p *= 0.2;
  float weight = 0.25;
  float totalweight = 0.0;
  float value = 0.0;
  for(int i = 0; i < 6; i++){
    if(i >= lod) break;
    totalweight += weight;
    value += noise2(p) * weight;
    p *= 2.03;
    weight *= 0.6;
  }
  return (value / totalweight + abs(p2.y) * 0.07 + abs(p2.x) * 0.0001 - 0.1);
}

float fogvalue(float mistvalue, float z){
  float vmax = 0.85;
  float vmin = mix(0.5, 0.25, (sin(z * 0.05) + 1.0) * 0.5);
  // Denser fog pulls the floor down, so the band thickens the storm.
  vmin -= mist_react * 0.14;
  float value = 0.0;
  if(mistvalue >= vmax) value = 1.0;
  else if(mistvalue <= vmin) value = 0.0;
  else value = (mistvalue - vmin) / (vmax - vmin);
  return value * value;
}

float lightning;
vec3 lightningcolour = vec3(1.5, 2.0, 3.0);
vec3 lpos0, lpos1, lcol0, lcol1;

float Lightning(float t){
  return clamp(pow(perlin(t * 10.14159, 3.14), 2.0), 0.0, 1.0);
}

/** One light's contribution to the fog colour at a sample. */
vec3 lightFog(vec3 pos, vec3 lp, vec3 lc, float v1){
  const float lightstep = 0.6;
  const float lightatten = 1.0 / (sqrt(lightstep) * 1.8);
  vec3 lighting = pos - lp;
  float attenuation = 9.0 / max(length(lighting), 1e-3);
  lighting = normalize(lighting);
  float v2 = mistAt(pos + lighting * lightstep, LIGHT_LOD);
  vec3 c = vec3(0.);
  if((v2 - v1) >= 0.0){
    attenuation = clamp(attenuation, 0.0, 1.0) * lightatten;
    c += 8.0 * (v2 - v1) * (v2 - v1) * 10.0 * lc * attenuation;
    c += 0.25 * lc * attenuation;
  } else {
    attenuation = clamp(attenuation * 0.5, 0.0, 1.0) * lightatten;
    c += 5.5 * 0.3 * lc * pow(attenuation, 10.0);
  }
  return c;
}

vec4 raymarchFog(vec3 ro, vec3 rd){
  float delta = MARCH_DELTA;
  float dstalpha = 0.0;
  vec3 fog = vec3(0.);

  for(int i = 0; i < MARCH_ITERATIONS; i++){
    float v1 = mistAt(ro, MIST_LOD);
    float value = fogvalue(v1, ro.z);

    float density = clamp(value * delta * 0.9, 0.0, 1.0);
    density *= clamp(delta * 4.0, 0.0, 1.0);

    if(density > 0.01){
      vec3 fogcolour = mix(vec3(0.1 + lightning * 0.2), vec3(0.0), value);
      fogcolour += lightFog(ro, lpos0, lcol0, v1);
      fogcolour += lightFog(ro, lpos1, lcol1, v1);
      float prevdst = dstalpha;
      dstalpha = dstalpha + density * (1.0 - dstalpha);
      fog = mix(fogcolour, fog, prevdst / max(dstalpha, 1e-4));
    }
    if(dstalpha > 0.95) break;

    ro += rd * delta;
    delta *= MARCH_DELTA2;
  }
  return vec4(fog, dstalpha);
}

vec3 nearestpointonline(vec3 l0, vec3 l1, vec3 p){
  vec3 ld = l1 - l0;
  vec3 ldn = normalize(ld);
  float d = dot(p - l0, ldn);
  if(d < 0.0) return l0;
  if(d > length(ld)) return l1;
  return l0 + d * ldn;
}

/** Additive glow from the light bodies and the discharge between them. */
vec3 volumelights(vec3 ro, vec3 rd){
  float caststep = 0.6;
  vec3 colour = vec3(0.0);
  float castdistance = max(length(lpos0 - ro), length(lpos1 - ro)) * 1.1;
  float castscale = castdistance / caststep;
  float obscurity = 0.0;

  // Runtime bound in the original — constant bound with an early break here.
  for(int i = 0; i < 96; i++){
    float t = float(i) * caststep;
    if(t >= castdistance) break;
    vec3 pos = ro + rd * t;
    obscurity += fogvalue(mistAt(pos, 3), pos.z) * 1.2;

    if(bolt_visible > 0.5 && lightning > 0.5){
      vec3 nearest = nearestpointonline(lpos0, lpos1, pos);
      vec3 dp = nearest - pos;
      float d2 = dot(dp, dp);
      if(d2 < 5.0) colour += lightningcolour / (d2 * castscale) * lightning * (1.0 + bolt_react);
    }

    vec3 d0 = lpos0 - pos;
    float q0 = dot(d0, d0);
    if(q0 < 40.0) colour += lcol0 / (q0 * castscale * 0.4);
    vec3 d1 = lpos1 - pos;
    float q1 = dot(d1, d1);
    if(q1 < 40.0) colour += lcol1 / (q1 * castscale * 0.4);
  }
  return colour * clamp(1.0 - obscurity * 0.1, 0.0, 1.0);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord.xy / iResolution.xy * 2.0 - 1.0;
  uv.y *= iResolution.y / iResolution.x;
  uv *= (iCamFov / 60.);

  float speed = 15.0 * (0.5 + speed_react * 1.1);
  float time = iTime;

  float ft = time - 1.0;
  vec3 p0 = vec3(12.0 - perlin(ft * 0.25, 7.5) * 24.0, 3.0 - perlin(ft * 0.25, 8.5) * 6.0, 0.0);
  ft += 0.5;
  vec3 p1 = vec3(12.0 - perlin(ft * 0.25, 7.5) * 24.0, 3.0 - perlin(ft * 0.25, 8.5) * 6.0, 0.0);

  vec3 dir = normalize((p1 - p0) + vec3(0.0, 0.0, 4.0));
  vec3 up = normalize(vec3(dir.x * 0.5, 1.0, 0.0));
  vec3 right = normalize(cross(dir, up));
  up = normalize(cross(right, dir));

  // Camera rig nudges the heading on top of the original's drift.
  dir = normalize(dir + right * iCamOrbit * 0.25 + up * iCamHeight * 0.25);

  vec3 ro = vec3(0.0, 0.0, time * speed) + p0;
  vec3 rd = normalize(dir + up * uv.y + right * uv.x);

  float dither = 0.2 * dither1(fragCoord, time);
  ro += rd * (START_DIST * max(iCamDist, 0.4) + dither);

  lightning = bolt_visible > 0.5 ? Lightning(time) : 0.0;

  lpos0 = vec3(0.0, 0.0, time * speed) + vec3(perlin(time * 0.4, 2.5) * 24.0 - 12.0, perlin(time * 0.4, 3.5) * 8.0 - 4.0, 20.0 + perlin(time * 0.4, 13.5) * 12.0 - 4.0);
  lpos1 = vec3(0.0, 0.0, time * speed) + vec3(perlin(time * 0.6, 1.5) * 24.0 - 12.0, perlin(time * 0.6, 2.5) * 8.0 - 4.0, 20.0 + perlin(time * 0.6, 11.5) * 12.0 - 4.0);

  lcol0 = mix(vec3(1.0, 0.4, 0.4), lightningcolour, lightning);
  lcol1 = mix(vec3(0.4, 0.4, 1.3), lightningcolour, lightning);
  // Was an FFT texture read; the band drives the light intensity now.
  float f = lights_react;
  lcol0 *= 0.5 + lightning * 0.75 + f;
  lcol1 *= 0.5 + lightning * 0.75 + f;

  vec4 fog = raymarchFog(ro, rd);
  vec3 col = mix(vec3(0.05 + lightning * 0.15), fog.xyz, fog.w);
  col += volumelights(ro, rd);

  fragColor = vec4(clamp(col, 0., 1.), 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

// Two-channel value noise standing in for Shadertoy's 256x256 RGBA noise
// texture; the fbm reads .yx and interpolates between them.
const bufferBShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;

float h(vec2 p){
  p = fract(p * vec2(.1031, .1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main(){
  vec2 c = floor(vUv * 256.);
  gl_FragColor = vec4(h(c), h(c + 71.3), 0., 1.);
}
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.); }
`;

export const jagokandang: ShaderDef = {
  id: 'jagokandang',
  name: 'Jago Kandang',
  description:
    'A flight through volumetric storm mist lit by two duelling lights, red against blue, with lightning discharging between them.',
  bufferShader,
  bufferBShader,
  imageShader,
  elements: [
    {
      id: 'mist',
      name: 'Storm',
      description: 'Density of the fog. React thickens the storm around you.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'lights',
      name: 'Lights',
      description: 'Brightness of the two duelling lights. React drives them on the beat.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.2,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'bolt',
      name: 'Lightning',
      description: 'Discharge arcing between the lights. React intensifies it; hide for calm fog.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Flight',
      description: 'Speed through the storm. React surges the run.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
