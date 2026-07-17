/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Planet" — a living miniature planet: fbm mountains, wave-animated oceans,
 * ice caps, deserts, drifting volumetric clouds and a starfield, soft-focused
 * by a bloom pass. The heaviest shader in the registry.
 *
 * Adapted from Morgan McGuire's Shadertoy original (4 passes). Restructured
 * for this pipeline: planet + stars + clouds render in one buffer pass with
 * the temporal blur done via the ping-pong feedback (iChannel0 = previous
 * frame), and the bloom in the image pass. The dFdx/dFdy material slope was
 * replaced with the hit-point SDF normal (materials are now evaluated once at
 * the hit instead of on every march step), the cubemap reflection with a sky
 * constant, and the cloud march trimmed — all so it stays GLSL-ES 1.00.
 *
 * Elements:
 *   planet -> the planet body (react: storm seas + rotation nudge; hideable)
 *   clouds -> volumetric cloud layer (react: coverage; hideable)
 *   stars  -> background starfield (react: twinkle; hideable)
 *   atmo   -> atmospheric glow (react: intensity; hideable)
 *   trails -> temporal motion trails (level sets persistence; hideable)
 *   bloomfx-> soft-focus bloom in the post pass (react: lift; hideable)
 */

const bufferShader = `
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

uniform float planet_react;
uniform float planet_visible;
uniform float clouds_react;
uniform float clouds_visible;
uniform float stars_react;
uniform float stars_visible;
uniform float atmo_react;
uniform float atmo_visible;
uniform float trails_react;
uniform float trails_visible;

const float PI = 3.1415926535;
const float INF = 1e10;

float square(float x){ return x*x; }
float pow3(float x){ return x*square(x); }
float pow4(float x){ return square(square(x)); }
float pow8(float x){ return square(pow4(x)); }

float hashf(float p){ p = fract(p*0.011); p *= p+7.5; p *= p+p; return fract(p); }
float hash2(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.13); p3 += dot(p3, p3.yzx+3.333); return fract((p3.x+p3.y)*p3.z); }
float noise2(vec2 x){
  vec2 i = floor(x); vec2 f = fract(x);
  float a = hash2(i);
  float b = hash2(i+vec2(1., 0.));
  float c = hash2(i+vec2(0., 1.));
  float d = hash2(i+vec2(1., 1.));
  vec2 u = f*f*(3.-2.*f);
  return mix(a, b, u.x) + (c-a)*u.y*(1.-u.x) + (d-b)*u.x*u.y;
}
float noise3(vec3 x){
  const vec3 stp = vec3(110., 241., 171.);
  vec3 i = floor(x); vec3 f = fract(x);
  float n = dot(i, stp);
  vec3 u = f*f*(3.-2.*f);
  return mix(mix(mix(hashf(n+dot(stp, vec3(0., 0., 0.))), hashf(n+dot(stp, vec3(1., 0., 0.))), u.x),
                 mix(hashf(n+dot(stp, vec3(0., 1., 0.))), hashf(n+dot(stp, vec3(1., 1., 0.))), u.x), u.y),
             mix(mix(hashf(n+dot(stp, vec3(0., 0., 1.))), hashf(n+dot(stp, vec3(1., 0., 1.))), u.x),
                 mix(hashf(n+dot(stp, vec3(0., 1., 1.))), hashf(n+dot(stp, vec3(1., 1., 1.))), u.x), u.y), u.z);
}
float fbm2(vec3 x){
  float v = 0.; float a = .5;
  for(int i = 0; i < 2; ++i){ v += a*noise3(x); x = x*2.+100.; a *= .5; }
  return v;
}
float fbm4(vec3 x){
  float v = 0.; float a = .5;
  for(int i = 0; i < 4; ++i){ v += a*noise3(x); x = x*2.+100.; a *= .5; }
  return v;
}
float fbm6(vec3 x){
  float v = 0.; float a = .5;
  for(int i = 0; i < 6; ++i){ v += a*noise3(x); x = x*2.+100.; a *= .5; }
  return v;
}

// Directional light + planet constants.
const vec3 W_I = vec3(1., 1.3, .6)/1.7464;
const float B_I = 2.9;
const float WATER = 0.85;
const float CLOUD_MIN_R = 0.85;

mat3 planetRot;

vec3 atmosphereColor(){
  // element: atmosphere glow (level 0.5 = original intensity)
  return vec3(.3, .6, 1.)*1.6*(0.5+atmo_react)*atmo_visible;
}

vec3 shadowedAtmosphereColor(vec2 fragCoord, float minVal){
  vec2 rel = 0.65*(fragCoord.xy - iResolution.xy*0.5)/iResolution.y;
  float a = min(1.,
    pow(max(0., 1.-dot(rel, rel)*6.5), 2.4) +
    max(abs(rel.x-rel.y)-0.35, 0.)*12.0 +
    max(0., 0.2+dot(rel, vec2(2.75))));
  return atmosphereColor()*mix(minVal, 1., a);
}

/** Analytic ray-sphere intersection (unit planet at the origin). */
bool intersectSphere(float r, vec3 ro, vec3 rd, out float nearD, out float farD){
  float b = 2.*dot(rd, ro);
  float c = dot(ro, ro)-square(r);
  float d = square(b)-4.*c;
  nearD = INF; farD = INF;
  if(d < 0.) return false;
  float ds = sqrt(d);
  float t0 = (-b-ds)*0.5; if(t0 < 0.) t0 = INF;
  float t1 = (-b+ds)*0.5; if(t1 < 0.) t1 = INF;
  nearD = min(t0, t1); farD = max(t0, t1);
  return nearD < INF;
}

float mountainAt(vec3 s){
  float m = clamp(1. - fbm6(s*4.) + max(abs(s.y)-.6, 0.)*.03, 0., 1.);
  return pow3(m)*.25 + .8;
}

/** Coarse SDF (flat ocean) — used for marching + shadows. */
float mapCoarse(vec3 X){
  vec3 Xr = planetRot*X;
  vec3 s = normalize(Xr);
  return (length(Xr) - max(mountainAt(s), WATER))*.8;
}

/** Fine SDF (+ animated waves) — used for the hit normal. */
float mapFine(vec3 X){
  vec3 Xr = planetRot*X;
  vec3 s = normalize(Xr);
  float mtn = mountainAt(s);
  float elev = mtn;
  if(mtn < WATER){
    float rwd = min(1., (WATER-mtn)*30.);
    float shallowPhase = (s.y - mtn*4.)*100.;
    float deepPhase = (atan(s.z, s.x) + noise3(s*15.)*.075)*150.;
    // element: seas storm up with the band
    float wave = (cos(shallowPhase + iTime*1.5)*sqrt(1.-rwd) +
                  cos(deepPhase + iTime*2.)*2.5*(1.-abs(s.y))*square(rwd))*.0014*(1.+planet_react*3.);
    elev = WATER + wave;
  }
  return (length(Xr) - elev)*.8;
}

bool marchPlanet(vec3 ro, vec3 rd, float minD, float maxD, out vec3 hit){
  const float closeEnough = 0.0011;
  float closest = INF;
  float tClosest = 0.;
  float t = minD;
  hit = ro;
  for(int i = 0; i < 60; ++i){
    hit = rd*t + ro;
    float dt = mapCoarse(hit);
    if(dt < closest){ closest = dt; tClosest = t; }
    t += max(dt, closeEnough);
    if(dt < closeEnough) return true;
    if(t > maxD) return false;
  }
  if(closest < closeEnough*5.){ hit = rd*tClosest + ro; return true; }
  return false;
}

bool shadowed(vec3 ro, vec3 rd, float maxD){
  const float closeEnough = 0.0044;
  float t = 0.;
  for(int i = 0; i < 20; ++i){
    float dt = mapCoarse(rd*t + ro);
    t += max(dt, closeEnough);
    if(dt < closeEnough) return true;
    if(t > maxD) return false;
  }
  return false;
}

// element: cloud coverage pushed by the band
float cloudDensity(vec3 X){
  vec3 p = X*vec3(1.5, 2.5, 2.);
  return fbm4(p + 1.5*fbm2(p - iTime*.047) - iTime*vec3(.03, .01, .01)) - .42 + clouds_react*.1;
}

/** Material colour / metal / smoothness at the hit (planet frame). */
void materialAt(vec3 s, float mtn, vec3 nP, out vec3 mColor, out float mMetal, out float mSmooth){
  if(mtn < WATER){
    float rwd = min(1., (WATER-mtn)*30.);
    mColor = mix(vec3(.4, 1., 1.9), vec3(0., .1, .7), pow(rwd, .4));
    mColor = mix(mColor, vec3(.7, 1., 1.2), square(clamp((abs(s.y)-.65)*3., 0., 1.)));
    mMetal = .5*rwd;
    mSmooth = .7;
  } else {
    float matNoise = noise3(s*200.);
    float slope = clamp(2.*(1.-dot(nP, s)), 0., 1.);
    bool iceCap = abs(s.y) + matNoise*.2 > .98;
    bool rock = (mtn + matNoise*.1 > .94) || (slope > .3);
    bool mountainTop = (mtn + matNoise*.05 - slope*.05) > .92;
    bool sand = (mtn < WATER+.006) && (noise3(s*8.) > .3);
    sand = sand || (mtn < .89) && (noise3(s*1.5)*.15 + noise3(s*73.)*.25 > abs(s.y));

    if(rock){ mColor = vec3(.5, .35, .15); mMetal = 0.; mSmooth = 0.; }
    else { mColor = vec3(.05, 1.15, .1); mMetal = .2; mSmooth = .1; }
    if(iceCap || mountainTop){ mColor = vec3(.85, 1., 1.2); mMetal = .2; mSmooth = .6; }
    else if(!rock && sand){ mColor = vec3(1., 1., .85); mMetal = 0.; mSmooth = 0.; }
    if(!sand && !iceCap) mColor *= mix(noise3(s*256.), 1., .4);
  }
}

bool renderPlanet(vec3 ro, vec3 rd, float minD, float maxD, out vec3 L_o, out vec3 hitPoint){
  if(!marchPlanet(ro, rd, minD, maxD, hitPoint)) return false;

  // Normal from the fine (wave-displaced) field, one-sided differences.
  float e = 8e-4;
  float d0 = mapFine(hitPoint);
  vec3 n = normalize(vec3(
    mapFine(hitPoint+vec3(e, 0., 0.)),
    mapFine(hitPoint+vec3(0., e, 0.)),
    mapFine(hitPoint+vec3(0., 0., e))) - d0);

  vec3 s = normalize(planetRot*hitPoint);
  float mtn = mountainAt(s);
  vec3 nP = planetRot*n;

  vec3 mColor; float mMetal; float mSmooth;
  materialAt(s, mtn, nP, mColor, mMetal, mSmooth);

  // Direct light with a shadow ray (coarse field).
  vec3 L_direct = vec3(0.);
  float cos_i = dot(n, W_I);
  if(cos_i > 0.){
    float shadowDist, ignore;
    intersectSphere(1., hitPoint + (n-rd)*0.003, W_I, shadowDist, ignore);
    if(!shadowed(hitPoint + (n-rd)*0.003, W_I, min(shadowDist, 3.))){
      vec3 p_L = mix(mColor, vec3(0.), mMetal);
      vec3 p_G = mix(vec3(.04), mColor, mMetal);
      float gExp = exp2(mSmooth*15.);
      vec3 w_h = normalize(W_I - rd);
      L_direct = cos_i*B_I*(p_L*(1./PI) + pow(max(0., dot(n, w_h)), gExp)*p_G*(gExp+8.)/(14.*PI));
    }
  }

  float cloudShadow = pow4(1. - clamp(cloudDensity(hitPoint), 0., 1.));
  if(clouds_visible < 0.5) cloudShadow = 1.;

  // "Ambient" + a sky-coloured stand-in for the original cubemap reflection.
  vec3 E_ind = max(vec3(0.), vec3(.4) - .4*vec3(n.y, n.x, n.x));
  vec3 skyRef = vec3(.3, .45, .75)*1.4;
  vec3 L_indirect = mix(E_ind*mColor, mix(vec3(1.), mColor, mMetal)*skyRef, mSmooth)*(1./PI);

  L_o = (L_direct + L_indirect)*cloudShadow;
  return true;
}

vec4 renderClouds(vec3 ro, vec3 rd, float minD, float maxD, vec3 shAtmo){
  const float stepSize = 0.027;
  const vec3 cloudColor = vec3(.95);
  const vec3 ambient = vec3(.9, 1., 1.);

  float planetShadow = clamp(0.4 + dot(W_I, normalize(ro + rd*minD)), 0.25, 1.);

  vec4 result = vec4(0.);
  float t = maxD;
  for(int i = 0; i < 36; ++i){
    if(t <= minD) return result;
    vec3 X = rd*t + ro;
    float density = cloudDensity(X);
    if(density > 0.){
      float wrapShading = clamp(-(cloudDensity(X + W_I*stepSize) - density)*(1./stepSize), -1., 1.)*.5+.5;
      float AO = pow8((dot(X, X)-.5)*2.);
      vec3 L_o = cloudColor*(B_I*planetShadow*wrapShading*mix(1., AO, .5) + ambient*AO);
      L_o = mix(L_o, shAtmo, min(.5, square(max(0., 1.-X.z))));
      density *= square(1. - abs(2.*length(X) - (CLOUD_MIN_R+1.))*(1./(1.-CLOUD_MIN_R)));
      result = mix(result, vec4(L_o, 1.), clamp(density, 0., 1.));
      t += stepSize*2.;
    }
    t -= stepSize*3.;
  }
  return result;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  // Camera rig: orbit yaws (plus the band nudge), height pitches, distance
  // pulls back, fov widens.
  float yaw = -iTime*.015 + iCamOrbit*.4 + planet_react*.1;
  float pitch = -.5 + iCamHeight*1.0;
  planetRot =
    mat3(cos(yaw), 0., -sin(yaw), 0., 1., 0., sin(yaw), 0., cos(yaw)) *
    mat3(1., 0., 0., 0., cos(pitch), sin(pitch), 0., -sin(pitch), cos(pitch));

  vec2 invRes = 1./iResolution.xy;
  float vfov = radians(25.*iCamFov/60.);
  vec3 ro = vec3(0., 0., 5.*iCamDist);
  vec3 rd = normalize(vec3(fragCoord.xy - iResolution.xy/2., iResolution.y/(-2.*tan(vfov/2.))));

  float minD, maxD;
  bool hitBounds = intersectSphere(1., ro, rd, minD, maxD);
  vec3 shAtmo = shadowedAtmosphereColor(fragCoord, 0.5);

  vec3 col = vec3(0.);
  vec3 hitPoint;
  float cloudFar = maxD;

  bool hitPlanet = false;
  if(hitBounds && planet_visible > 0.5){
    hitPlanet = renderPlanet(ro, rd, minD, maxD, col, hitPoint);
  }
  if(hitPlanet){
    col = mix(col, shAtmo, min(.8, square(1.-hitPoint.z)));
    cloudFar = min(maxD, dot(rd, hitPoint-ro));
  } else if(stars_visible > 0.5){
    // Background starfield.
    float galaxyClump = (pow(noise2(fragCoord.xy*(30.*invRes.x)), 3.)*.5 +
      pow(noise2(100.+fragCoord.xy*(15.*invRes.x)), 5.))/1.5;
    col = vec3(galaxyClump*pow(hash2(fragCoord.xy), 1500.)*80.);
    col.r *= sqrt(noise2(fragCoord.xy)*1.2);
    col.g *= sqrt(noise2(fragCoord.xy*4.));
    // element: twinkle energy
    col *= noise2(iTime*.5 + fragCoord.yx*10.)*(1.+stars_react);
    vec2 delta = (fragCoord.xy - iResolution.xy*.5)*invRes.y*1.1;
    float radial = min(1., .06*pow8(max(0., 1.-(length(delta)-.9)/.9)));
    float radialNoise = mix(1., noise2(normalize(delta)*40. + iTime*.5), .14);
    col += radialNoise*radial*shAtmo;
  }

  if(hitBounds && clouds_visible > 0.5){
    vec4 clouds = renderClouds(ro, rd, minD, cloudFar, 1.1*shadowedAtmosphereColor(fragCoord, 0.08));
    col = col*(1.-clouds.a) + clouds.rgb;
  }

  // Temporal trails via the feedback buffer (the original's Buffer C blur).
  float hyst = trails_visible > 0.5 ? clamp(.9*trails_react, 0., .92) : 0.;
  vec3 prev = texture2D(iChannel0, fragCoord*invRes).rgb;
  col = mix(col, prev, hyst);

  fragColor = vec4(col, 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

// Bloom / soft-focus post (the original's Image pass).
const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;

uniform float bloomfx_react;
uniform float bloomfx_visible;

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 invRes = 1./iResolution.xy;

  if(bloomfx_visible < 0.5){
    fragColor = vec4(texture2D(iChannel0, fragCoord*invRes).rgb, 1.);
    return;
  }

  const float blurVariance = 0.1*25.;
  vec4 sum = vec4(texture2D(iChannel0, fragCoord*invRes).rgb*13., 13.);
  for(int dx = -5; dx < 5; dx += 2){
    for(int dy = -5; dy < 5; dy += 2){
      vec3 src = texture2D(iChannel0, (fragCoord + vec2(float(dx), float(dy)) + .5)*invRes).rgb;
      float weight = exp2(-float(dx*dx + dy*dy)/blurVariance);
      sum += vec4(src, 1.)*weight;
    }
  }
  // element: bass lifts the bloom exposure
  float ex = .65 - clamp(bloomfx_react, 0., 1.5)*.1;
  fragColor = vec4(pow(sum.rgb/sum.a, vec3(ex)), 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const planet: ShaderDef = {
  id: 'planet',
  name: 'Planet',
  description:
    'A living miniature planet — fbm mountains, storming seas, ice caps, volumetric clouds and stars. Heavy; lower the render scale if it strains.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'planet',
      name: 'Planet',
      description: 'The planet body. React storms the seas and nudges the spin; hide for space only.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'clouds',
      name: 'Clouds',
      description: 'The volumetric cloud layer. React grows the coverage.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'stars',
      name: 'Stars',
      description: 'The background starfield. React makes them twinkle harder.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'atmo',
      name: 'Atmosphere',
      description: 'The blue atmospheric glow. The manual level sets the resting intensity.',
      defaultBand: 'low',
      defaultAmount: 0.6,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'trails',
      name: 'Trails',
      description: 'Temporal motion blur. The manual level sets persistence (drop it for a crisper image).',
      defaultBand: 'none',
      defaultAmount: 0.5,
      defaultLevel: 0.75,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bloomfx',
      name: 'Bloom',
      description: 'Soft-focus bloom over the final image. React lifts the exposure on hits.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
