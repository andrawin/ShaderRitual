/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Kodok" — an armoured machine-toad crouched on a wet industrial deck, lit by
 * the red running inside it.
 *
 * The anatomy is adapted from a raymarched frog on Shadertoy (body / head /
 * eyelids / splayed limbs and toes, and the breathing cycle that swells the
 * throat), rebuilt as the creature in the reference: horns repeated along the
 * spine, a sweep of them off the skull, armour plates over the shoulders, hips
 * and jaw, a circuit panel let into the flank, and a throat cavity that glows
 * through the skin. Voronoi noise from iq, as in the original.
 *
 * Porting notes (GLSL ES 1.00):
 *   - The shadow march ran `i<256 && t<maxt` in the loop condition. Only the
 *     index may be tested against a constant here, so the distance test moved
 *     into the body as a break.
 *   - The original's march incremented its index twice — once in the for, once
 *     in the body — so it ran half the steps it asked for. Removed, and the cap
 *     set deliberately instead.
 *   - round() is not available; floor(x + 0.5) stands in, which is also what
 *     limits the spine to five horns rather than an infinite ridge of them.
 *   - Mouse orbit replaced by the shared camera rig, and the fixed 30-degree
 *     half-angle by iCamFov.
 *
 * Cost: one map() carries about thirty primitives, and the normal costs six
 * map() calls on top of the march. Detail sets the step count and the shadow
 * quality; Spikes, Armour and Haze each remove real work when hidden.
 *
 * Elements:
 *   pulse    -> the red glow and the breathing cycle driving it
 *   spikes   -> the spine and skull horns (hideable)
 *   armour   -> the plating over shoulders, hips and jaw (hideable)
 *   circuits -> the lit panel in the flank and the throat cavity (hideable)
 *   haze     -> smog, scaffolding and the glow bleeding into it (hideable)
 *   detail   -> march steps and shadow quality, the cost knob
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

uniform float pulse_react;
uniform float spikes_react;
uniform float spikes_visible;
uniform float armour_react;
uniform float armour_visible;
uniform float circuits_react;
uniform float circuits_visible;
uniform float haze_react;
uniform float haze_visible;
uniform float detail_react;

#define SURF_DIST 0.0015
#define MAX_DIST 40.0
#define PI 3.14159265
#define TAU 6.28318531

// Set once per frame in main(); read by map() and the shading.
float gBreath = 1.0;
float gSteps = 90.0;
float gShadow = 1.0;

/* ---------------- noise (hash + voronoi, after iq) ---------------- */

vec3 hash3(vec3 x){
  x = vec3(dot(x, vec3(127.1, 311.7, 74.7)),
           dot(x, vec3(269.5, 183.3, 246.1)),
           dot(x, vec3(113.5, 271.9, 124.6)));
  return fract(sin(x) * 43758.5453123);
}

vec3 voronoi(in vec3 x){
  vec3 p = floor(x);
  vec3 f = fract(x);
  float id = 0.0;
  vec2 res = vec2(100.0);
  for(int k = -1; k <= 1; k++)
  for(int j = -1; j <= 1; j++)
  for(int i = -1; i <= 1; i++){
    vec3 b = vec3(float(i), float(j), float(k));
    vec3 r = b - f + hash3(p + b);
    float d = dot(r, r);
    if(d < res.x){ id = dot(p + b, vec3(1.0, 57.0, 113.0)); res = vec2(d, res.x); }
    else if(d < res.y) res.y = d;
  }
  return vec3(sqrt(res), abs(id));
}

float hash1(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash1(i), hash1(i + vec2(1., 0.)), f.x),
             mix(hash1(i + vec2(0., 1.)), hash1(i + vec2(1., 1.)), f.x), f.y);
}

float fbm2(vec2 p){
  float a = 0.5, f = 0.0;
  for(int i = 0; i < 4; i++){ f += a * vnoise(p); p *= 2.03; a *= 0.5; }
  return f;
}

/* ---------------- distance functions (iq) ---------------- */

float sdSphere(vec3 p, vec3 c, float r){ return length(p - c) - r; }

float sdEllipsoid(vec3 po, vec3 c, vec3 r){
  vec3 p = po - c;
  float k0 = length(p / r);
  float k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float sdCapsule(vec3 p, vec3 a, vec3 b, float r){
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float sdRoundBox(vec3 p, vec3 b, float r){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

/* A tapered horn: wide at the base, a point at the tip. */
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2){
  vec3 ba = b - a;
  float l2 = max(dot(ba, ba), 1e-6);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xp = pa * l2 - ba * y;
  float x2 = dot(xp, xp);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if(sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if(sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}

float opSmoothUnion(float d1, float d2, float k){
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}
float opSmoothSubtraction(float d1, float d2, float k){
  float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
  return mix(d1, -d2, h) + k * h * (1.0 - h);
}

vec3 rotX(vec3 p, float a){
  float s = sin(a), c = cos(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
vec3 rotZ(vec3 p, float a){
  float s = sin(a), c = cos(a);
  return vec3(c * p.x - s * p.y, s * p.x + c * p.y, p.z);
}

/* ---------------- the creature ----------------
 * Materials: 1 skin, 2 eye, 3 deck, 4 metal, 5 lit slot.
 * Forward is -z, so the skull sits at negative z and the rump at positive.
 */
vec2 map(vec3 p){
  vec3 pSym = vec3(abs(p.x), p.y, p.z);
  float rt = gBreath;
  vec2 res = vec2(1.0, 1.0);

  // Trunk — heavier and lower than a frog's, with the breath swelling it.
  float body = sdEllipsoid(p, vec3(0.), vec3(0.74, 0.52, 0.74) + 0.02 * rt);
  body = opSmoothUnion(body, sdEllipsoid(p, vec3(0., -0.1, 0.03), vec3(0.84, 0.5, 0.78)), 0.1);

  // Skull, tipped down onto the chest.
  vec3 ph = rotX(p + vec3(0., -0.25, 0.4), -PI / 3.);
  float head = sdEllipsoid(ph, vec3(0.), vec3(0.4, 0.33, 0.42));
  float d = opSmoothUnion(body, head, 0.3);

  // Brow ridge and eye. The eye is a lamp, so it keeps its own material.
  float lid = sdEllipsoid(pSym, vec3(0.25, 0.45 + 0.01 * rt, -0.53), vec3(0.17, 0.15, 0.17));
  d = opSmoothUnion(d, lid, 0.04);
  float eye = sdSphere(pSym, vec3(0.275, 0.435 + 0.012 * rt, -0.585), 0.115);
  if(eye - 0.005 < d) res.y = 2.0;
  d = opSmoothUnion(d, eye, 0.006);

  // Jaw line, cut in rather than modelled.
  vec3 pf = rotX(p + vec3(0., -0.12, 0.655), -0.35);
  float face = sdEllipsoid(pf, vec3(0.), vec3(0.28, 0.3, 0.1));
  float gap = sdEllipsoid(pf + vec3(0., 0.03 * rt, 0.02), vec3(0.), vec3(0.27, 0.4, 0.04));
  d = opSmoothSubtraction(d, gap, 0.02);
  d = opSmoothUnion(d, face, 0.01);

  // Throat, inflating on the breath.
  float throat = sdSphere(p, vec3(0., 0.0, -0.6), 0.17);
  d = opSmoothUnion(d, throat, 0.2 * rt);

  // Forelimbs, splayed, with the long fingers spread on the deck.
  vec3 elbow = vec3(0.64, -0.3, -0.42);
  vec3 shoulder = vec3(0.5, -0.1, -0.4);
  vec3 wrist = vec3(0.6, -0.48, -0.47);
  float upper = sdCapsule(pSym, shoulder, elbow, 0.09);
  d = opSmoothUnion(d, upper, 0.1);
  d += 0.008 * sin(40. * upper) * smoothstep(1., 0., 5. * upper);
  d = opSmoothUnion(d, sdCapsule(pSym, elbow + vec3(0., -0.05, 0.), wrist, 0.085), 0.05);

  vec3 kn = wrist - vec3(0., 0.03, 0.03);
  d = opSmoothUnion(d, sdCapsule(pSym, kn, wrist - vec3(0.17, 0.03, 0.005), 0.042), 0.04);
  d = opSmoothUnion(d, sdCapsule(pSym, kn, wrist - vec3(0.22, 0.05, 0.07), 0.042), 0.04);
  d = opSmoothUnion(d, sdCapsule(pSym, kn, wrist - vec3(0.16, 0.06, 0.14), 0.042), 0.04);

  // Hind limbs and rump.
  vec3 knee = vec3(0.57, -0.46, 0.44);
  float leg = sdCapsule(pSym, vec3(0.42, -0.2, 0.48), knee, 0.08);
  d = opSmoothUnion(d, leg, 0.1);
  d += 0.008 * sin(40. * leg) * smoothstep(1., 0., 5. * leg);
  d = opSmoothUnion(d, sdSphere(pSym, vec3(0.16, -0.15, 0.66), 0.12), 0.15);

  vec3 tk = knee - vec3(0., 0.03, 0.);
  d = opSmoothUnion(d, sdCapsule(pSym, tk, knee - vec3(-0.2, 0.05, 0.13), 0.042), 0.04);
  d = opSmoothUnion(d, sdCapsule(pSym, tk, knee - vec3(-0.14, 0.05, 0.19), 0.042), 0.04);
  d = opSmoothUnion(d, sdCapsule(pSym, tk, knee - vec3(-0.06, 0.05, 0.19), 0.042), 0.04);

  // Horns. The spine row is one cone evaluated in a repeated cell, which is
  // why it costs the same as a single horn; floor(x+0.5) clamped to +-2 is what
  // stops it running off into an infinite ridge.
  if(spikes_visible > 0.5){
    float cz = 0.24;
    float idx = clamp(floor((pSym.z - 0.06) / cz + 0.5), -2.0, 2.0);
    vec3 q = pSym - vec3(0.0, 0.0, 0.06 + cz * idx);
    float grow = 1.0 - 0.17 * abs(idx);
    // Inner row, tall and raked back.
    float hornA = sdRoundCone(q - vec3(0.17, 0.30, 0.0),
                              vec3(0.), vec3(0.06, 0.60 * grow, 0.17 * grow), 0.08, 0.012);
    float horns = hornA;
    d = opSmoothUnion(d, hornA, 0.05);
    // Outer row, shorter, flaring out.
    // The outer row has less body under it, so it starts higher or it never
    // breaks the surface at all.
    float hornB = sdRoundCone(q - vec3(0.42, 0.26, 0.0),
                              vec3(0.), vec3(0.17, 0.36 * grow, 0.12 * grow), 0.06, 0.012);
    horns = min(horns, hornB);
    d = opSmoothUnion(d, hornB, 0.06);

    // Skull horns sweeping back off the cheeks, in two lengths.
    float hornC = sdRoundCone(pSym - vec3(0.30, 0.56, -0.40),
                              vec3(0.), vec3(0.16, 0.46, 0.30), 0.085, 0.015);
    horns = min(horns, hornC);
    d = opSmoothUnion(d, hornC, 0.07);
    float hornD = sdRoundCone(pSym - vec3(0.37, 0.40, -0.52),
                              vec3(0.), vec3(0.26, 0.26, 0.26), 0.06, 0.012);
    horns = min(horns, hornD);
    d = opSmoothUnion(d, hornD, 0.06);
    // Claimed a little inside the blend, so the join keeps the hide colour.
    if(horns < d + 0.03) res.y = 5.0;
  }

  // Plating. Hard-edged boxes over soft anatomy — the contrast is the look.
  if(armour_visible > 0.5){
    float plate = sdRoundBox(rotZ(pSym - vec3(0.42, 0.05, -0.28), -0.5),
                             vec3(0.09, 0.25, 0.2), 0.06);                // shoulder
    plate = min(plate, sdRoundBox(rotZ(pSym - vec3(0.4, -0.08, 0.4), 0.38),
                                  vec3(0.09, 0.22, 0.25), 0.06));         // hip
    plate = min(plate, sdRoundBox(rotX(p - vec3(0., 0.45, -0.06), 0.3),
                                  vec3(0.26, 0.06, 0.2), 0.05));          // dorsal
    plate = min(plate, sdRoundBox(rotX(p - vec3(0., 0.06, -0.62), -0.25),
                                  vec3(0.2, 0.05, 0.1), 0.035));          // jaw
    plate = min(plate, sdRoundBox(rotX(p - vec3(0., 0.56, -0.42), -0.5),
                                  vec3(0.17, 0.05, 0.15), 0.04));         // skull cap
    if(plate < d + 0.02) res.y = 4.0;
    d = opSmoothUnion(d, plate, 0.02);
  }

  // Deck.
  float deck = sdRoundBox(p + vec3(0., 0.8, 0.), vec3(1.9, 0.07, 1.9), 0.03);
  if(deck < d) res.y = 3.0;
  d = min(d, deck);

  res.x = d;
  return res;
}

vec2 rayMarch(vec3 ro, vec3 rd){
  float d = 0.0;
  float mat = 1.0;
  for(int i = 0; i < 140; i++){
    if(float(i) >= gSteps) break;
    vec2 ds = map(ro + rd * d);
    d += ds.x;
    mat = ds.y;
    if(d >= MAX_DIST || ds.x < SURF_DIST) break;
  }
  return vec2(d, mat);
}

/* iq's soft shadow. The distance test is a break because only the loop index
 * may be compared against a constant in this dialect. */
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k){
  float res = 1.0;
  float t = mint;
  for(int i = 0; i < 40; i++){
    if(float(i) >= gShadow * 40.0 || t >= maxt) break;
    float h = map(ro + rd * t).x;
    if(h < 0.001) return 0.0;
    res = min(res, k * h / t);
    t += clamp(h, 0.02, 0.4);
  }
  return clamp(res, 0.0, 1.0);
}

vec3 gradient(vec3 p){
  vec2 e = vec2(0.0012, 0.);
  return normalize(vec3(
    map(p + e.xyy).x - map(p - e.xyy).x,
    map(p + e.yxy).x - map(p - e.yxy).x,
    map(p + e.yyx).x - map(p - e.yyx).x));
}

/* Circuit traces for the flank panel: nested rectangles plus a runner that
 * crawls along them, which is what sells it as powered rather than painted. */
float circuitry(vec2 q, float t){
  vec2 g = fract(q * 6.0) - 0.5;
  vec2 cell = floor(q * 6.0);
  float r = hash1(cell);
  float line = min(abs(g.x), abs(g.y));
  if(r > 0.55) line = abs(abs(g.x) - abs(g.y)) * 0.7;
  float trace = smoothstep(0.055, 0.015, line);
  // Pads where traces meet.
  float pad = smoothstep(0.16, 0.1, length(g)) * step(0.82, r);
  // A pulse travelling the trace.
  float run = smoothstep(0.75, 1.0, sin((q.x + q.y) * 7.0 - t * 2.4 + r * 6.0));
  return clamp(trace * (0.45 + run * 0.9) + pad, 0.0, 1.5);
}

/* Smoggy hall: haze, a few scaffold uprights and pipework, all in silhouette. */
vec3 background(vec2 uv, float glow){
  vec3 sky = mix(vec3(0.17, 0.18, 0.21), vec3(0.09, 0.095, 0.115),
                 smoothstep(-0.8, 0.9, uv.y));
  if(haze_visible > 0.5){
    // Uprights: a handful of vertical bands, darker than the smog they sit in.
    float x = uv.x * 1.6;
    for(int i = 0; i < 5; i++){
      float fi = float(i);
      float px = -1.5 + fi * 0.78 + hash1(vec2(fi, 3.0)) * 0.5;
      float w = 0.035 + hash1(vec2(fi, 7.0)) * 0.05;
      float bar = smoothstep(w, w * 0.4, abs(x - px));
      float dep = 0.35 + 0.4 * hash1(vec2(fi, 11.0));
      sky = mix(sky, sky * (1.0 - dep), bar * smoothstep(-0.9, 0.2, uv.y));
      // Cross-brace, so they read as scaffold rather than columns.
      float br = smoothstep(0.02, 0.005, abs(uv.y - 0.35 + hash1(vec2(fi, 5.)) * 0.3))
               * step(abs(x - px), 0.45);
      sky = mix(sky, sky * 0.75, br * 0.7);
    }
    // Smog drifting across it.
    float smog = fbm2(uv * vec2(1.6, 2.2) + vec2(iTime * 0.04, iTime * 0.015));
    sky = mix(sky, vec3(0.2, 0.2, 0.23), smog * 0.45 * (0.5 + haze_react * 0.4));
    // The creature's light bleeding into the smog.
    sky += vec3(0.5, 0.06, 0.09) * glow * smog
         * smoothstep(1.3, 0.0, length(uv - vec2(0.0, -0.1))) * 0.9;
  }
  return sky;
}

void main(){
  vec2 uv = (vUv - 0.5) * 2.0;
  uv.x *= iResolution.x / max(iResolution.y, 1.0);

  float det = clamp(detail_react, 0.0, 2.0);
  gSteps = 55.0 + det * 42.0;
  gShadow = 0.35 + det * 0.32;

  // Breathing: two offset sines, so the swell holds at the top instead of
  // running as a clean sinusoid. The beat adds a kick on top.
  float w = 1.5;
  float br = max(sin(w * iTime), sin(w * iTime + PI / 3.));
  gBreath = br * 0.5 + 1.0;
  float beat = pow(sin(fract(iBeat) * TAU) * 0.5 + 0.5, 3.0);
  float glow = (0.5 + clamp(pulse_react, 0.0, 2.0) * 0.75) * (0.75 + 0.25 * br)
             + beat * iCamReact * 0.12;

  // Camera on the shared rig.
  // Front three-quarter, near enough to read the face. The rig orbits from
  // here rather than from a default that looks at the rump.
  float a = iCamOrbit - 0.85;
  float dist = 3.15 * clamp(iCamDist, 0.4, 3.0);
  vec3 rt = vec3(0.0, 0.02, -0.08);
  vec3 ro = rt + vec3(sin(a) * dist, 0.28 + iCamHeight * 1.6, -cos(a) * dist);

  vec3 vw = normalize(ro - rt);
  vec3 vu = normalize(cross(vec3(0., 1., 0.), vw));
  vec3 vv = cross(vw, vu);
  float th = tan(radians(clamp(iCamFov, 15.0, 110.0) * 0.5));
  vec3 rd = normalize(-uv.x * th * vu + uv.y * th * vv - vw);

  vec3 col = background(uv, glow);

  vec2 hit = rayMarch(ro, rd);
  if(hit.x < MAX_DIST){
    vec3 p = ro + rd * hit.x;
    vec3 n = gradient(p);
    float mat = hit.y;

    // Warty hide. Only the organic material gets it; plate and lamp stay clean.
    if(mat < 1.5) n = normalize(n + (voronoi(42. * p).x - 0.4) * 0.22);

    vec3 base = vec3(0.14, 0.145, 0.115);
    float emis = 0.0;
    vec3 emisCol = vec3(1.0, 0.1, 0.12);
    float spec = 0.25;

    if(mat < 1.5){
      // Damp olive hide, mottled.
      float c = 1.0 - voronoi(9. * p).x;
      base = mix(vec3(0.085, 0.105, 0.07), vec3(0.17, 0.165, 0.11), c);
      base *= 0.7 + 0.5 * smoothstep(-0.6, 0.6, p.y);
      spec = 0.5;

      if(circuits_visible > 0.5){
        float ca = 0.35 + clamp(circuits_react, 0.0, 2.0) * 0.4;
        // Flank panel: an upright oval on the side of the trunk, behind the
        // shoulder. Let in as a material rather than cut as geometry — the
        // march is already carrying thirty primitives.
        vec2 fq = vec2(p.z * 1.05 + 0.18, p.y * 1.25 - 0.12);
        float fr = length(fq * vec2(1.0, 1.25));
        float panel = 1.0 - smoothstep(0.25, 0.28, fr);
        panel *= smoothstep(0.5, 0.6, abs(p.x));
        float bezel = (smoothstep(0.25, 0.28, fr) - smoothstep(0.30, 0.34, fr))
                    * smoothstep(0.5, 0.6, abs(p.x));
        // Dark red glass rather than black: the window is lit from inside, so
        // even the gaps between traces carry some of it.
        base = mix(base, vec3(0.085, 0.012, 0.016), panel);
        base = mix(base, vec3(0.12, 0.125, 0.14), bezel);
        emis += circuitry(fq * 2.4, iTime) * panel * ca * 2.6;
        emis += panel * ca * 0.5;

        // The jaw cut carries the throat light out along the mouth line.
        vec3 pm = rotX(p + vec3(0., -0.12, 0.655), -0.35);
        float mouth = (1.0 - smoothstep(0.02, 0.07, abs(pm.y)))
                    * (1.0 - smoothstep(0.2, 0.3, length(pm.xz * vec2(1.0, 2.2))));
        emis += mouth * ca * 2.4;

        // Throat cavity, brightest on the inhale.
        float cav = 1.0 - smoothstep(0.06, 0.22, length(p - vec3(0., -0.05, -0.6)));
        emis += cav * ca * (0.8 + br * 0.9) * 1.5;

        // Vents between the spine horns.
        float sl = 1.0 - smoothstep(0.02, 0.09, abs(fract((p.z - 0.06) / 0.24 + 0.5) - 0.5) * 0.24);
        emis += sl * smoothstep(0.26, 0.42, p.y) * smoothstep(0.42, 0.2, abs(p.x)) * ca * 1.6;
      }
    } else if(mat < 2.5){
      // The eye is a lamp: a pale core in a dark socket.
      base = vec3(0.02);
      float er = length(vec3(abs(p.x) - 0.275, p.y - 0.435, p.z + 0.585));
      float core = smoothstep(0.12, 0.045, er);
      emis = 0.35 + core * 3.6;
      emisCol = mix(vec3(1.0, 0.95, 0.85), vec3(1.0, 0.75, 0.6), 0.4);
      spec = 1.2;
    } else if(mat < 3.5){
      // Wet grating.
      vec2 g = abs(fract(p.xz * 3.0) - 0.5);
      float grid = smoothstep(0.46, 0.5, max(g.x, g.y));
      base = mix(vec3(0.05, 0.052, 0.058), vec3(0.085, 0.085, 0.095), grid);
      base *= 0.55 + 0.45 * fbm2(p.xz * 3.0);
      spec = 0.9;
    } else if(mat > 4.5){
      // Horn: pale bone, darkening into the socket, with the banding the
      // reference wraps round the skull pair.
      float band = smoothstep(0.35, 0.5, abs(fract(p.y * 5.5) - 0.5) * 2.0);
      base = mix(vec3(0.3, 0.285, 0.245), vec3(0.42, 0.4, 0.35), band);
      base *= 0.45 + 0.55 * smoothstep(0.1, 0.75, p.y);
      spec = 0.8;
      if(circuits_visible > 0.5){
        float lit = 1.0 - smoothstep(0.0, 0.14, abs(fract(p.y * 5.5) - 0.5) * 2.0);
        emis += lit * smoothstep(0.75, 0.35, p.y) * 0.9
              * (0.3 + clamp(circuits_react, 0.0, 2.0) * 0.4);
      }
    } else {
      // Plate: dark, hard, a little anisotropy from the brushed direction.
      base = vec3(0.1, 0.1, 0.108);
      base *= 0.9 + 0.1 * smoothstep(-1., 1., sin(p.y * 70.0));
      spec = 1.4;
      if(circuits_visible > 0.5){
        float seam = smoothstep(0.012, 0.0, abs(fract(p.y * 7.0) - 0.5) * 0.14);
        emis += seam * 0.5 * (0.35 + clamp(circuits_react, 0.0, 2.0) * 0.4);
      }
    }

    // Lighting: a cool key from the hall, a dim fill, and the creature's own
    // red doing most of the work on the near side.
    vec3 key = normalize(vec3(-0.5, 0.85, -0.65));
    float dif = clamp(dot(n, key), 0.0, 1.0);
    float fill = 0.5 + 0.5 * dot(n, vec3(0.6, 0.35, 0.7));
    float sh = softShadow(p + n * 0.02, key, 0.03, 4.0, 6.0);

    vec3 lit = base * (vec3(0.62, 0.70, 0.88) * dif * (0.3 + 0.7 * sh) * 1.55
                     + vec3(0.16, 0.18, 0.25) * fill * 0.85);

    // Red bounce off the glowing parts onto everything near them.
    float bounce = exp(-max(length(p - vec3(0., 0.0, -0.45)) - 0.25, 0.0) * 3.0);
    lit += base * vec3(1.0, 0.14, 0.16) * bounce * glow * 2.2;

    vec3 h = normalize(key - rd);
    lit += vec3(0.7, 0.75, 0.9) * pow(clamp(dot(n, h), 0.0, 1.0), 30.0) * spec * sh * 0.5;

    // Rim, which is what separates a dark creature from a dark room.
    float fres = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0);
    lit += mix(vec3(0.3, 0.36, 0.5), vec3(1.0, 0.2, 0.2), 0.55) * fres * 0.5;

    lit += emisCol * emis * glow;

    // Depth haze, so it sits in the room rather than on top of it.
    float fo = 1.0 - exp(-pow(max(hit.x - 3.0, 0.0) * 0.1, 1.6));
    col = mix(lit, vec3(0.13, 0.135, 0.16), fo * (haze_visible > 0.5 ? 0.85 : 0.3));
  }

  // Vignette.
  col *= 1.0 - 0.45 * smoothstep(0.5, 1.7, length(uv * vec2(0.8, 1.0)));

  gl_FragColor = vec4(col, 1.0);
}
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;

/* A short bloom so the red carries into the smog the way it does in the
 * reference, without a second buffer to ping-pong through. */
void main(){
  vec3 c = texture2D(iChannel0, vUv).rgb;
  vec2 px = 1.0 / iResolution.xy;
  vec3 b = vec3(0.0);
  for(int i = 0; i < 8; i++){
    float a = float(i) * 0.7853982;
    vec2 o = vec2(cos(a), sin(a));
    b += texture2D(iChannel0, vUv + o * px * 5.0).rgb;
    b += texture2D(iChannel0, vUv + o * px * 11.0).rgb;
  }
  b /= 16.0;
  b = max(b - 0.25, 0.0);
  c += b * vec3(1.0, 0.55, 0.5) * 0.85;
  c = c / (1.0 + c * 0.35);                 // soft shoulder
  gl_FragColor = vec4(pow(clamp(c, 0.0, 1.0), vec3(0.95)), 1.0);
}
`;

export const kodok: ShaderDef = {
  id: 'kodok',
  name: 'Kodok',
  description:
    'An armoured machine-toad crouched on a wet industrial deck, lit by the red running inside it.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'pulse',
      name: 'Core Pulse',
      description:
        'How hard the red burns, and the breath driving it. The manual level sets the resting glow.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.6,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'spikes',
      name: 'Horns',
      description: 'The row down the spine and the sweep off the skull. Hide for a smooth back.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'armour',
      name: 'Plating',
      description: 'Shoulder, hip, dorsal and jaw plates. Hide to strip it back to the animal.',
      defaultBand: 'none',
      defaultAmount: 0.4,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'circuits',
      name: 'Circuitry',
      description:
        'The lit panel in the flank, the throat cavity and the vents between the horns.',
      defaultBand: 'high',
      defaultAmount: 0.9,
      defaultLevel: 0.7,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'haze',
      name: 'Smog',
      description: 'Scaffolding, drifting smoke and the glow bleeding into it.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.6,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Detail',
      description:
        'March steps and shadow quality. A creature this size costs what this says — drop it on a projector.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
