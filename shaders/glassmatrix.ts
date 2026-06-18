/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Glass Matrix" — a refractive glass lattice tunnel with a floating marble,
 * flown through on a path, with a chromatic-aberration refraction look and a
 * depth-of-field post pass.
 *
 * Adapted from a Shadertoy original (Frostbyte, CC-BY-NC-SA-4.0) that used
 * CUBEMAP channels for its environment. We have no cubemaps, so every cubemap
 * lookup is replaced with a procedural `env(dir)`. Also ported to GLSL-ES 1.00:
 *   - removed the dead `tanh` path, `iFrame`/ZERO and the AA loop
 *   - replaced the bit-twiddling tetrahedral normal with the plain 4-tap
 *   - replaced `i % 5` (no integer modulo in ES 1.00) in the DoF kernel
 *   - the buffer stores depth normalised (t / zBound) in alpha so the 8-bit
 *     target can drive the DoF focus.
 *
 * Elements:
 *   lattice -> the glass lattice tunnel (react twists it)
 *   marble  -> the central glass marble (react swells it)
 *   glass   -> refraction / chromatic split strength
 *   dof     -> depth-of-field blur amount (post pass)
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

uniform float lattice_react;
uniform float lattice_visible;
uniform float marble_react;
uniform float marble_visible;
uniform float glass_react;
uniform float glass_visible;

#define T iTime
#define zBound 70.
#define PI 3.14159265

mat2 rot2(float a){ float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

vec3 MainPath(float t){ t += T*2.5; return vec3(0., 0., t); }
vec3 MarblePath(){
  vec3 c;
  c -= MainPath(3.5);
  c.x += sin(T*.5)*.5;
  c.y += cos(T*.5)*.5;
  return c;
}
vec3 roPath(){ return MainPath(0.); }
vec3 taPath(){ vec3 c; c += MainPath(3.5); return c; }

vec3 BlatticeRot(vec3 p){
  float r = p.z * (.05 + lattice_react*.06);
  p.xy *= rot2(r);
  return p;
}
float Blattice(vec3 p){
  p = BlatticeRot(p + MarblePath()) - MarblePath();
  vec3 b = p;
  b.x += sin(mod(iTime*.05, 6.2831853)) * 50.;
  p = abs(4. - mod(p, 8.));
  b = abs(4. - mod(b, 8.));
  float cylz = length(b.xy) - 1.;
  float cylx = length(p.zy) - .95;
  return smin(cylx, cylz, 1.);
}
float sdSphere(vec3 p, float r){ return length(p) - r; }
float Marble(vec3 p){ return sdSphere(p + MarblePath(), .25 + marble_react*.18); }

vec2 opU(vec2 d1, vec2 d2){ return (d1.x < d2.x) ? d1 : d2; }

vec2 map(vec3 p){
  vec2 res = vec2(1e10, 0.);
  vec2 bl = vec2(lattice_visible > 0.5 ? Blattice(p) : 1e10, 4.);
  vec2 ma = vec2(marble_visible > 0.5 ? Marble(p) : 1e10, 4.);
  res = opU(res, bl);
  res = opU(res, ma);
  return res;
}

vec2 iBox(vec3 ro, vec3 rd, vec3 rad){
  vec3 m = 1.0/rd; vec3 n = m*ro; vec3 k = abs(m)*rad;
  vec3 t1 = -n - k; vec3 t2 = -n + k;
  return vec2(max(max(t1.x, t1.y), t1.z), min(min(t2.x, t2.y), t2.z));
}
vec2 sceneBox(vec3 ro, vec3 rd){
  vec3 roLocal = ro - roPath() - vec3(0., 0., zBound);
  return iBox(roLocal, rd, vec3(40., 20., zBound + 4.));
}
vec2 raycast(vec3 ro, vec3 rd){
  vec2 res = vec2(-1.0, -1.0);
  float tmin = 1.0, tmax = zBound;
  vec2 tb = sceneBox(ro, rd);
  if(tb.x < tb.y && tb.y > 0.0 && tb.x < tmax){
    tmin = max(tb.x, tmin);
    tmax = min(tb.y, tmax);
    float t = tmin;
    for(int i = 0; i < 100; i++){
      if(t >= tmax) break;
      vec2 h = map(ro + rd*t);
      float eps = max(0.0001, 0.0001*t);
      if(abs(h.x) < eps){ res = vec2(t, h.y); break; }
      t += h.x;
    }
  }
  return res;
}
vec3 calcNormal(vec3 pos){
  vec2 e = vec2(1.0, -1.0) * 0.5773 * 0.0005;
  return normalize(
    e.xyy*map(pos + e.xyy).x +
    e.yyx*map(pos + e.yyx).x +
    e.yxy*map(pos + e.yxy).x +
    e.xxx*map(pos + e.xxx).x);
}

// Procedural environment, standing in for the original's cubemaps.
vec3 env(vec3 d){
  d = normalize(d);
  float y = d.y*0.5 + 0.5;
  vec3 col = mix(vec3(0.03, 0.05, 0.09), vec3(0.35, 0.55, 0.85), y);
  float a = atan(d.x, d.z);
  float bands = sin(a*8. + d.y*5. + iTime*0.2)*0.5 + 0.5;
  col += vec3(0.5, 0.3, 0.7) * pow(bands, 6.) * 0.6;
  col += vec3(0.9, 0.95, 1.0) * pow(max(d.y, 0.), 8.) * 0.5;
  return col;
}

vec4 render(vec3 ro, vec3 rd){
  vec3 col;
  vec2 res = raycast(ro, rd);
  float t = res.x;
  float m = res.y;
  float IOR = 1.45;
  vec3 Rcol = env(rd);
  if(m > -0.5){
    vec3 p = ro + t*rd;
    vec3 nor = calcNormal(p);
    vec3 ref = reflect(rd, nor);

    vec3 refOutside = pow(env(ref), vec3(2.2));
    vec3 rdIn = refract(rd, nor, 1./IOR);
    vec3 pEnter = p - nor;
    float dIn = raycast(pEnter, rdIn).x;
    vec3 pExit = pEnter + rdIn*dIn;
    vec3 nExit = -calcNormal(pExit);

    vec3 rdOut, reflTex;
    float abb = .01 + glass_react*.05; // chromatic aberration

    rdOut = refract(rdIn, nExit, IOR - abb);
    if(dot(rdOut, rdOut) == 0.) rdOut = reflect(rdIn, nExit);
    reflTex.r = pow(env(rdOut).r, 2.2);

    rdOut = refract(rdIn, nExit, IOR);
    if(dot(rdOut, rdOut) == 0.) rdOut = reflect(rdIn, nExit);
    reflTex.g = pow(env(rdOut).g, 2.2);

    rdOut = refract(rdIn, nExit, IOR + abb);
    if(dot(rdOut, rdOut) == 0.) rdOut = reflect(rdIn, nExit);
    reflTex.b = pow(env(rdOut).b, 2.2);

    float dens = .1;
    float optDist = exp(-dIn*dens);
    col = reflTex*optDist;
    float fresnel = pow(1. + dot(rd, nor), 1.);
    Rcol = mix(col, refOutside, fresnel);
  }
  return vec4(clamp(Rcol, 0.0, 1.0), t);
}

mat3 setCamera(vec3 ro, vec3 ta, float cr){
  vec3 cw = normalize(ta - ro);
  vec3 cp = vec3(sin(cr), cos(cr), 0.0);
  vec3 cu = normalize(cross(cw, cp));
  vec3 cv = cross(cu, cw);
  return mat3(cu, cv, cw);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec3 ro = roPath();
  vec3 ta = taPath();
  mat3 ca = setCamera(ro, ta, iCamOrbit*0.3); // rig orbit -> camera roll

  vec2 p = (2.*fragCoord - iResolution.xy) / iResolution.y;
  float fl = (3. + 6.*smoothstep(8., 0., T)) * (60. / iCamFov);
  vec3 rd = ca * normalize(vec3(p, fl));

  vec4 col = render(ro, rd);
  col.rgb = col.rgb * 4.0 / (2.5 + col.rgb); // gain / soften
  fragColor = vec4(col.rgb, clamp(col.a / zBound, 0.0, 1.0)); // normalised depth in alpha
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float dof_react;
uniform float dof_visible;

#define zBound 70.

vec3 DpthFld(vec2 uv){
  const float focD = 2.5, coc = 40.;
  float l = abs(texture2D(iChannel0, uv).w * zBound - focD) - coc;
  float dof = clamp(l/coc, 0., 2.) * 2.;
  dof = mix(dof, smoothstep(-.25, .25, abs(uv.y - .5)*abs(uv.y - .5) - .2)*4., .5);
  dof *= (0.3 + dof_react*1.7); // element scales the blur
  vec3 acc = vec3(0.);
  for(int i = 0; i < 25; i++){
    vec2 o = (vec2(float(i / 5), float(i - (i / 5) * 5)) - 2.) / 450. * dof;
    acc += texture2D(iChannel0, uv + o).xyz;
  }
  return acc / 25.;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec4 col = dof_visible > 0.5 ? vec4(DpthFld(uv), 1.) : texture2D(iChannel0, uv);
  col /= (2.25 + col) / 3.; // rough Reinhard
  col *= pow(16.*uv.x*uv.y*(1. - uv.x)*(1. - uv.y), 1./16.); // vignette
  fragColor = pow(max(col, 0.), vec4(1./2.2));
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const glassmatrix: ShaderDef = {
  id: 'glassmatrix',
  name: 'Glass Matrix',
  description:
    'A refractive glass lattice tunnel with a floating marble, flown through on a path, with chromatic-aberration glass and a depth-of-field post pass. Heavy — refraction does several raymarches per pixel.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'lattice',
      name: 'Glass Lattice',
      description: 'The refractive lattice tunnel. React twists it.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'marble',
      name: 'Marble',
      description: 'The floating glass marble. React swells it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'glass',
      name: 'Refraction',
      description: 'Chromatic split / aberration strength. React widens it.',
      defaultBand: 'high',
      defaultAmount: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'dof',
      name: 'Depth of Field',
      description: 'Post-process focus blur. React deepens it.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
