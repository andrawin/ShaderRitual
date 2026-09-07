/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Journey" — a small animal crossing a monochrome desert: rolling dunes, a
 * vast prism mountain on the horizon, layered clouds and standing stones, with
 * a bundle of cables trailing from the creature and whipping in the wind.
 *
 * An adaptation of a Shadertoy tribute to That Game Company's "Journey", with
 * three deliberate departures from the original:
 *   - the cloaked traveller is replaced by a small four-legged creature
 *     (body, head with snout and ears, walking legs, tail);
 *   - the scarves become cables — five trailing from the creature and two
 *     from each standing stone, where the original had one scarf each;
 *   - the picture is desaturated to grey. The original's tuned palette (its
 *     warm desert scheme) is kept and the colour is drained at the very end,
 *     so the greys carry its tonal relationships rather than hand-picked
 *     luminances — and the Grey element can dial the colour back in.
 *
 * Ported to GLSL-ES 1.00 besides: the terrain and mountain noise came from
 * textureLod reads of a noise texture (procedural value noise here), the
 * camera came from a baked mat4 inverse-view (a lookAt off the camera rig),
 * and the shadow march is cut from 100 steps to 24.
 *
 * Elements:
 *   cables   -> how hard the cables whip; hideable
 *   creature -> the animal itself; hideable for an empty desert
 *   dunes    -> height of the dunes
 *   clouds   -> the cloud banks; hideable
 *   sun      -> sun glare and haze
 *   grey     -> how far toward grey; hide it for the original colour
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

uniform float cables_react;
uniform float cables_visible;
uniform float creature_react;
uniform float creature_visible;
uniform float dunes_react;
uniform float clouds_react;
uniform float clouds_visible;
uniform float sun_react;
uniform float grey_react;
uniform float grey_visible;

#define MAT_PYRAMID 1.0
#define MAT_TERRAIN 10.0
#define MAT_CLOUD 20.0
#define MAT_STONE 30.0
#define MAT_STONE_CABLE 31.0
#define MAT_CREATURE 50.0
#define MAT_CREATURE_CABLE 53.0

const vec3 LIGHT_DIR = vec3(-0.23047, 0.87328, -0.42927);
const vec3 SUN_POS = vec3(0.2, 56.0, -40.1);
const vec3 CREATURE_POS = vec3(0.52, 2.30, 17.6);
const float DRAW_DIST = 70.0;

/* ---------------- primitives (IQ) ---------------- */
float sdSphere(vec3 p, float s){ return length(p) - s; }
float sdBox(vec3 p, vec3 b){
  vec3 d = abs(p) - b;
  return min(max(d.x, max(d.y, d.z)), 0.0) + length(max(d, 0.0));
}
float sdRoundBox(vec3 p, vec3 b, float r){ return length(max(abs(p) - b, 0.0)) - r; }
float sdEllipsoid(in vec3 p, in vec3 r){
  return (length(p / r) - 1.0) * min(min(r.x, r.y), r.z);
}
vec2 sdSegment(in vec3 p, vec3 a, vec3 b){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return vec2(length(pa - ba * h), h);
}
float sdTriPrism(vec3 p, vec2 h){
  vec3 q = abs(p);
  float d1 = q.z - h.y;
  float d2 = max(q.x * 0.866025 + p.y * 0.5, -p.y) - h.x * 0.5;
  return length(max(vec2(d1, d2), 0.0)) + min(max(d1, d2), 0.);
}

vec2 min_mat(vec2 d1, vec2 d2){ return (d1.x < d2.x) ? d1 : d2; }
float smin(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(a, b, h) + k * h * (1.0 - h);
}
void rX(inout vec3 p, float a){
  float c = cos(a); float s = sin(a);
  p = vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
void rY(inout vec3 p, float a){
  float c = cos(a); float s = sin(a);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

/* Procedural value noise — the original read these from a noise texture. */
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 x){
  vec2 i = floor(x); vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x),
             mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}

float triWave(float x){ float t = abs(fract(x + 0.5) * 2.0 - 1.0); return t * t * (3.0 - 2.0 * t); }

/* ---------------- the creature ----------------
 * A small four-legged animal in place of the original's cloaked traveller:
 * rounded body, head with snout and ears, walking legs and a tail.
 */
float sdCreature(vec3 p){
  float t = iTime;
  p.y -= sin(t * 2.0) * 0.02;                    // gentle walking bob

  float body = sdEllipsoid(p, vec3(0.17, 0.13, 0.26));

  vec3 hp = p - vec3(0.0, 0.13, 0.24);
  rX(hp, -0.2 + sin(t * 1.3) * 0.06);            // head nod
  float head = sdEllipsoid(hp, vec3(0.11, 0.10, 0.11));
  float snout = sdEllipsoid(hp - vec3(0.0, -0.035, 0.09), vec3(0.05, 0.04, 0.07));
  head = smin(head, snout, 0.04);

  vec3 ep = hp; ep.x = abs(ep.x);                // mirrored ears
  vec2 ear = sdSegment(ep, vec3(0.05, 0.07, 0.0), vec3(0.085, 0.20, -0.02));
  head = smin(head, ear.x - 0.026 + ear.y * 0.014, 0.03);

  float d = smin(body, head, 0.06);

  vec3 lp = p; lp.x = abs(lp.x);                 // mirrored legs, walk cycle
  float ph = t * 3.0;
  vec2 fl = sdSegment(lp, vec3(0.10, -0.08, 0.16),
                          vec3(0.10, -0.26 + sin(ph) * 0.03, 0.18 + cos(ph) * 0.04));
  vec2 bl = sdSegment(lp, vec3(0.11, -0.08, -0.14),
                          vec3(0.11, -0.26 + sin(ph + 3.14) * 0.03, -0.16 + cos(ph + 3.14) * 0.04));
  d = smin(d, fl.x - 0.035, 0.03);
  d = smin(d, bl.x - 0.035, 0.03);

  vec3 tp = p - vec3(0.0, 0.06, -0.26);          // tail
  vec2 tail = sdSegment(tp, vec3(0.0), vec3(sin(t * 2.0) * 0.06, 0.12, -0.12));
  d = smin(d, tail.x - 0.03 + tail.y * 0.02, 0.04);

  return d;
}

/* Five cables trailing from the creature's back — the original had one scarf. */
float sdCreatureCables(vec3 p){
  float t = iTime;
  float whip = 0.09 + cables_react * 0.16;
  float d = 1e3;
  for(int i = 0; i < 5; i++){
    float fi = float(i);
    vec3 cp = p - vec3((fi - 2.0) * 0.05, 0.15, -0.06);
    float run = max(0.0, -cp.z);                 // sway grows down the length
    cp.x += sin(cp.z * 4.0 + t * 2.5 + fi * 1.3) * whip * run;
    cp.y += sin(cp.z * 3.1 + t * 1.9 + fi * 0.7) * whip * run * 0.8;
    cp.y += triWave(cp.z * 1.5 + t * 0.7 + fi) * 0.05 * run;
    d = min(d, sdBox(cp - vec3(0.0, 0.0, -0.55), vec3(0.011, 0.011, 0.55)));
  }
  return d;
}

vec2 sdCharacter(vec3 pos){
  if(creature_visible < 0.5) return vec2(DRAW_DIST, 0.0);
  pos -= CREATURE_POS;
  vec3 scale = vec3(0.4, 0.53, 0.38);
  float scaleMul = min(scale.x, min(scale.y, scale.z));
  rY(pos, 0.17);
  pos /= scale;

  vec2 res = vec2(sdCreature(pos), MAT_CREATURE);
  if(cables_visible > 0.5){
    res = min_mat(res, vec2(sdCreatureCables(pos), MAT_CREATURE_CABLE));
  }
  res.x *= scaleMul;
  return res;
}

/* ---------------- terrain ---------------- */
float sdTerrain(in vec3 pos){
  float distZ = abs(pos.z - 18.6);
  float distX = abs(pos.x - 1.0);
  float dist = (distZ) + (distX * 0.1);
  dist = dist * dist * 0.01;

  float detailNoise = vnoise(pos.xz) * -2.5;
  // The original amplitude at rest — the band only ever adds. Reducing this
  // raises the dune surface (it sits at -large) and buries the camera.
  float amp = 2.96 * (1.0 + dunes_react * 0.30);
  float large = (sin(-11.64 + pos.z * 0.73 + pos.z * 0.02)
               * sin((-3.65 + dist) + (pos.x * 0.25)) * 0.5) + 0.5;
  large = -4.41 + pow(large, 0.6) * amp - detailNoise * 0.1;
  large = smin(large, -2.08, 0.2);
  large = (large - dist) * 0.9;

  float small = sin(pos.z * 16.0 + detailNoise + iTime * 0.6)
              * sin(pos.x * 3.19 + detailNoise + iTime * 2.0) * 0.006 * 0.9;
  return large + small;
}

/* ---------------- standing stones, each with a pair of cables ---------------- */
float sdStoneCables(vec3 pos, float t){
  vec3 cp = pos - vec3(0.0, 0.46, 0.0);
  rY(cp, -0.36);
  float d = 1e3;
  float whip = 0.04 + cables_react * 0.06;
  for(int i = 0; i < 2; i++){
    vec3 q = cp - vec3((float(i) - 0.5) * 0.06, 0.0, 0.0);
    float run = max(0.0, q.z + 0.5);
    q.x += sin(q.z * 6.0 + iTime * 1.6 + float(i) * 2.0 + t) * whip * run;
    q.y += sin(q.z * 5.0 + iTime * 1.2 + float(i)) * whip * run;
    d = min(d, sdBox(q - vec3(0.0, 0.0, 0.5), vec3(0.02, 0.02, 0.5)));
  }
  return d;
}

vec2 sdStones(in vec3 p){
  vec2 main = vec2(DRAW_DIST, MAT_STONE);
  for(float t = -1.0; t <= 1.0; t += 2.0){
    vec3 pos = p - (vec3(5.0, 5.0, 9.28) + vec3(-0.25 * t, t * 0.05, 0.1 * t));
    float cable = cables_visible > 0.5 ? sdStoneCables(pos, t + 1.0) : DRAW_DIST;
    pos.x = abs(pos.x);
    pos.x += abs(pos.y > 0.44 ? (pos.y - 0.44) * 0.66 : 0.0);
    float stone = sdRoundBox(pos, vec3(0.07, 0.5, 0.006), 0.01);
    stone = max(stone, -sdSphere(pos - vec3(0.0, 0.39, 0.0), 0.06));
    main = min_mat(main, min_mat(vec2(stone, MAT_STONE), vec2(cable, MAT_STONE_CABLE)));
  }
  return main;
}

/* ---------------- clouds + mountain ---------------- */
float sdCloud(in vec3 pos, vec3 cloudPos, float rad, float spread, float phase, vec3 g){
  pos += vnoise(pos.xz * 1.5) * 0.2;
  pos = pos - cloudPos;
  pos.z /= g.x;
  float rep = rad * 2.0 + spread;
  vec3 repSpace = pos - mod(pos - rep * 0.5, rep);
  pos.y += sin(phase + repSpace.x * 0.23) * g.y;
  pos.y += sin(phase + repSpace.x * 0.9) * g.z;
  pos.x = fract((pos.x + rep * 0.5) / rep) * rep - rep * 0.5;
  return (length(pos) - rad) * g.x;
}

vec2 sdClouds(in vec3 pos){
  if(clouds_visible < 0.5) return vec2(DRAW_DIST, MAT_CLOUD);
  vec3 g = vec3(0.123, 2.1, 0.5);
  vec3 fp = vec3(9.91, 8.6, -12.88);
  float c1 = sdCloud(pos, fp, 5.02, 3.79, 5.0, g);
  float c2 = sdCloud(pos, fp + vec3(-9.1, 3.04, 0.0), 3.04, 0.16, 2.0, g);
  float c3 = sdCloud(pos, fp + vec3(-2.97, 3.72, -0.05), 1.34, 0.3, 3.15, g);
  float front = min(c3, min(c1, c2));
  float plane = length(pos.z - fp.z) / g.x + (pos.y - 10.85 + sin(7.64 + pos.x * 0.23) * 3.76);
  front = min(plane * g.x, front);

  vec3 bg = vec3(0.16, 1.4, -0.01);
  float c4 = sdCloud(pos, vec3(29.99, 13.61, -18.8), 7.12, 4.26, 1.68, bg);
  float c5 = sdCloud(pos, vec3(29.99, 13.61, -18.8) + vec3(24.87, -1.49, 0.0), 6.37, 2.23, 2.07, bg);
  return vec2(min(front, min(c4, c5)), MAT_CLOUD);
}

float sdBigMountain(in vec3 pos){
  vec3 s = vec3(34.1, 24.9, 18.0);
  float scaleMul = min(s.x, min(s.y, s.z));
  vec3 pp = pos - vec3(0.0, 10.9, -50.0);
  pp.x += sin(vnoise(pp.xz * 1.5)) * 1.0;
  pp /= s;
  float pyramid = sdTriPrism(pp, vec2(1.0, 1.9)) * scaleMul;

  vec3 pe = pos;
  pe.y = 51.5 - pos.y;
  pe.x = pos.x * 5.86;
  float eye = sdTriPrism((pe - vec3(2.0, -4.9, 0.0)) / s.x, vec2(0.7, 1.9)) * s.x;
  return max(pyramid, -eye);
}

/* ---------------- the map ---------------- */
vec2 map(in vec3 pos){
  vec2 res = sdCharacter(pos);
  if(res.x > 0.01){
    vec2 terrain = vec2(pos.y + sdTerrain(pos), MAT_TERRAIN);
    res = min_mat(res, terrain);
    if(terrain.x > 0.01){
      res = min_mat(res, sdStones(pos));
      res = min_mat(res, vec2(sdBigMountain(pos), MAT_PYRAMID));
      res = min_mat(res, sdClouds(pos));
    }
  }
  return res;
}

vec3 castRay(vec3 ro, vec3 rd){
  float t = 0.1;
  float m = -1.0;
  float j = 0.0;
  for(float i = 0.0; i < 72.0; i += 1.0){
    j = i;
    float precis = 0.0005 * t;
    vec2 res = map(ro + rd * t);
    if(res.x < precis || t > DRAW_DIST) break;
    t += res.x;
    m = res.y;
  }
  if(t > DRAW_DIST) m = -1.0;
  return vec3(t, m, j / 72.0);
}

vec3 calcNormal(in vec3 pos){
  vec2 e = vec2(1.0, -1.0) * 0.5773 * 0.0008;
  return normalize(e.xyy * map(pos + e.xyy).x +
                   e.yyx * map(pos + e.yyx).x +
                   e.yxy * map(pos + e.yxy).x +
                   e.xxx * map(pos + e.xxx).x);
}

/* Only the creature and stones cast; only terrain receives. 24 steps (was 100). */
float softShadow(in vec3 ro, in vec3 rd, float mint, float maxt, float k){
  float res = 1.0;
  float t = mint;
  for(int i = 0; i < 24; ++i){
    if(t >= maxt) break;
    float h = min(sdCharacter(ro + rd * t).x, sdStones(ro + rd * t).x);
    if(h < 0.001) return 0.1;
    res = min(res, k * h / t);
    t += h;
  }
  return res;
}

/* ----------------------------------------------------------------------
 * Shading keeps the original's tuned palette (its warm "scheme 2" desert)
 * and desaturates at the very end, so the grey carries the original's tonal
 * relationships instead of hand-picked luminances.
 * -------------------------------------------------------------------- */
const vec3 SUN_COL      = vec3(0.97059, 0.97059, 0.97059);
const vec3 ZENITH       = vec3(0.98039, 0.83137, 0.53725);
const vec3 HORIZON      = vec3(0.84559, 0.77688, 0.60310);
const vec3 PYRAMID_COL  = vec3(0.92647, 0.73579, 0.33380);
const vec3 TERRAIN_COL  = vec3(0.71324, 0.50760, 0.23600);
const vec3 TERRAIN_SPEC = vec3(0.32353, 0.32123, 0.31877);
const vec3 TERRAIN_SHAD = vec3(0.66912, 0.52969, 0.36900);
const vec3 TERRAIN_DIST = vec3(1.00000, 0.75466, 0.43382);
const vec3 CLOUD_COL    = vec3(0.99216, 0.94510, 0.76471);
const vec3 CLOUD_SPEC   = vec3(0.17647, 0.06228, 0.06228);
const vec3 STONE_COL    = vec3(0.94118, 0.82759, 0.45675);
const vec3 STONE_CABLE  = vec3(0.44118, 0.19989, 0.14922);
const vec3 CREATURE_COL = vec3(0.60294, 0.15150, 0.06207);
const vec3 CREATURE_LEG = vec3(0.50000, 0.34040, 0.12868);
const vec3 CABLE_COL    = vec3(0.64706, 0.30233, 0.00000);

vec3 sky(vec3 ro, vec3 rd){
  float sunDistance = length(SUN_POS);
  vec3 delta = SUN_POS - (ro + rd * sunDistance);
  float dist = length(delta);
  delta.xy *= vec2(14.7, 1.47);
  float spot = 1.0 - smoothstep(0.0, 26.0, length(delta));
  vec3 sun = clamp(15.0 * spot * spot * spot, 0.0, 1.0) * SUN_COL * (0.6 + sun_react * 1.0);

  float expControl = pow(clamp((dist - 11.1) * 0.09, 0.0, 1.0), 0.52);
  float y = rd.y;
  float zen = 1.0 - pow(min(1.0, 1.0 - y), 2.36);
  vec3 zenithColor = mix(SUN_COL, ZENITH * zen, expControl);
  float nad = 1.0 - pow(min(1.0, 1.0 + y), 1.91);
  float hor = 1.0 - zen - nad;
  return sun * 0.1 + zenithColor + HORIZON * hor;
}

vec3 render(in vec3 ro, in vec3 rd){
  vec3 res = castRay(ro, rd);
  vec3 skyCol = sky(ro, rd);
  float t = res.x;
  float m = res.y;
  vec3 pos = ro + t * rd;

  // Iteration-count bloom around foreground silhouettes.
  if(m < 0.0) return skyCol + res.z * res.z * 0.2;

  // The original's light haze (-0.001), not the heavy one — this is what had
  // crushed the scene dark.
  float skyFog = 1.0 - exp(-0.001 * t * pow(max(pos.y, 0.0), 1.68));

  vec3 pyramidCol = mix(PYRAMID_COL, skyCol, skyFog * 0.5);
  if(m < MAT_PYRAMID + 0.1){
    float nh = pos.y / 38.66;
    nh = nh * nh * nh * nh * nh;
    float heightFog = clamp(pow(clamp(1.0 - nh, 0.0, 1.0), 4.65), 0.0, 1.0);
    return mix(pyramidCol, skyCol, heightFog);
  }

  vec3 nor = calcNormal(pos);

  if(m < MAT_TERRAIN + 0.1){
    float shadow = clamp(softShadow(pos - rd * 0.01, LIGHT_DIR, 0.12, 5.2, 88.7) + 0.28, 0.0, 1.0);
    vec3 shadowCol = mix(shadow * TERRAIN_SHAD, TERRAIN_DIST, pow(skyFog, 2.11 * 0.11));
    float rim = clamp(pow(1.0 - clamp(dot(nor, -rd), 0.0, 1.0), 5.59), 0.0, 1.0) * 1.61;
    vec3 ref = reflect(rd, nor);
    vec3 halfDir = normalize(LIGHT_DIR + rd);
    float mainSpec = pow(clamp(dot(ref, halfDir), 0.0, 1.0), 55.35) * 0.03 * 2.0;
    float glitter = pow(vnoise(pos.xz * 7.0) * 1.15, 3.2);
    mainSpec *= glitter;
    float rimSpec = pow(rim, 0.38) * glitter;
    vec3 specColor = (mainSpec + rimSpec) * TERRAIN_SPEC;
    vec3 terrainCol = mix(specColor * shadow + TERRAIN_COL, skyCol, pow(skyFog, 2.11)) + res.z * 0.2;
    return mix(shadowCol, terrainCol, shadow);
  }

  if(m < MAT_CLOUD + 0.1){
    vec3 cn = normalize(nor + vec3(0.26, -0.13, 1.22));
    float spec = (1.0 - clamp(pow(dot(cn, vec3(1.0, -3.5, 1.0)), 24.04), 0.0, 1.0)) * 2.0;
    vec3 cloudCol = spec * CLOUD_SPEC + CLOUD_COL * (1.0 + clouds_react * 0.3);
    return mix(cloudCol, skyCol, skyFog * 0.5);
  }

  if(m < MAT_STONE_CABLE + 0.1){
    float diff = clamp(dot(nor, LIGHT_DIR) + 1.0, 0.0, 1.0);
    vec3 col = m > MAT_STONE + 0.5 ? STONE_CABLE * 2.0 : STONE_COL;
    return mix(diff * col, skyCol, skyFog);
  }

  // Creature and its cables.
  float diff = 1.5 * clamp(dot(nor, LIGHT_DIR), 0.0, 1.0);
  vec3 fn = normalize(nor + vec3(0.3, -0.1, 1.0));
  fn.y *= 0.3;
  float fres = pow(clamp(1.0 + dot(fn, rd) + 0.75, 0.0, 1.0), 3.84) * 1.77;

  vec3 col;
  if(m > MAT_CREATURE_CABLE - 0.1){
    // Cables: banded, with a bright pulse travelling along them.
    float band = step(0.55, fract(pos.z * 6.0 + iTime * 0.8));
    col = mix(CABLE_COL, vec3(1.0), band * 0.45);
    col += smoothstep(0.6, 1.0, sin(pos.z * 2.0 - iTime * 2.0)) * (0.25 + cables_react * 0.6);
  } else {
    // Creature: legs pick up sand colour, back stays warm.
    float up = clamp(nor.y * 0.5 + 0.5, 0.0, 1.0);
    col = mix(CREATURE_LEG, CREATURE_COL, up);
    col += creature_react * 0.15;
  }
  return mix((fres + diff) * col, skyCol, skyFog * 12.47);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 screenCoord = (fragCoord / iResolution.xy) * 2.0 - 1.0;

  // Original baked its camera into an inverse-view matrix; this is a lookAt
  // driven by the rig, keeping the same framing by default.
  vec3 ro = vec3(1.0, 2.2, 18.6);
  ro.x += sin(iTime * 0.25) * 0.15;
  ro.y += sin(iTime * 0.25 + 32.0) * 0.1;
  ro += vec3(0.0, iCamHeight * 1.2, 0.0);
  vec3 ta = vec3(0.6, 2.1, 8.0);
  rY(ro, iCamOrbit * 0.12);
  ro = ta + (ro - ta) * max(iCamDist, 0.5);

  vec3 ww = normalize(ta - ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = normalize(cross(uu, ww));
  vec2 sc = screenCoord * vec2(1.038 * 1.35, 0.78984) * (iCamFov / 60.0);
  vec3 rd = normalize(sc.x * uu + sc.y * vv + 1.0 * ww);

  vec3 col = render(ro, rd);

  float vig = min(pow(1.0 - 0.4 * dot(screenCoord, screenCoord), 0.6) * 1.25, 1.0);
  col *= vig;

  // Desaturate last, so the grey inherits the original palette's tonal
  // relationships. Hide the element for the original colour; the level sets
  // how far toward grey it goes.
  if(grey_visible > 0.5){
    float lum = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(col, vec3(lum), clamp(grey_react, 0.0, 1.0));
  }
  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
void main(){ gl_FragColor = vec4(texture2D(iChannel0, vUv).rgb, 1.); }
`;

export const journey: ShaderDef = {
  id: 'journey',
  name: 'Journey',
  description:
    'A small animal crossing a grey desert — dunes, a vast prism mountain, cloud banks and standing stones, with cables trailing behind it. Grey is dialable back to colour.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'cables',
      name: 'Cables',
      description:
        'The cables trailing from the creature and the stones. React whips them harder; hide to strip them off.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'creature',
      name: 'Creature',
      description: 'The little animal. React lifts it out of the haze; hide for an empty desert.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'dunes',
      name: 'Dunes',
      description: 'Height of the dunes. React swells the desert.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'clouds',
      name: 'Clouds',
      description: 'The cloud banks. React brightens them; hide for clear sky.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'sun',
      name: 'Sun',
      description: 'Glare from the low sun and the haze it throws across the scene.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'grey',
      name: 'Grey',
      description:
        'How far the picture is drained toward grey. Level 1 is fully monochrome, lower keeps some of the warm desert colour; hide for the original palette.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
