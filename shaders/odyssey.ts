/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Shared GLSL for the Odyssey suite — six scenes following one traveller with
 * an oversized sword across a story arc, from waking in an empty universe to a
 * burnt-out desert. The scenes are separate shaders so they can be cut between
 * live, but they share this library so the traveller, the ground and the
 * parallax band language stay identical from one to the next.
 *
 * The visual grammar is Horizon's: silhouettes stepped out of procedural
 * functions, layered into parallax bands, over a scrolling sin-stack ridge.
 * What is different is the palette — Horizon is monochrome, and these take
 * The Artful Escape's saturated neon as reference, so each scene is built
 * around two or three strong hues with the traveller cut out black against
 * them and rim-lit in the scene's key colour.
 *
 * Every scene shares two elements, in the same order, so one MIDI map carries
 * across the whole suite:
 *   walk  -> travel speed and stride; hide to clear the traveller out
 *   sword -> blade size, from a longsword to something absurd
 *
 * Everything here is GLSL-ES 1.00: constant loop bounds with the index
 * declared in the init clause, no round()/dFdx()/texelFetch(), no dynamic
 * array indexing.
 */

/** Uniform block every scene in the suite opens with. */
export const odysseyUniforms = `
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
`;

/** Geometry, noise and figure library shared by every scene. */
export const odysseyLib = `
mat2 rotOd(float a){ return mat2(cos(a), sin(a), -sin(a), cos(a)); }

float hashOd(vec2 p){
  p = fract(p * vec2(0.16632, 0.17369));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y * 95.4337);
}

float noiseOd(vec2 p){
  vec2 c = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hashOd(c),                 hashOd(c + vec2(1.0, 0.0)), f.x),
             mix(hashOd(c + vec2(0.0, 1.0)), hashOd(c + vec2(1.0, 1.0)), f.x), f.y);
}

float fbmOd(vec2 p){
  float v = 0.0;
  float a = 0.5;
  for(int i = 0; i < 5; i++){
    v += a * noiseOd(p);
    p *= 2.02;
    a *= 0.5;
  }
  return v;
}

/* Three-octave fbm. The sky backgrounds evaluate noise inside a march loop,
 * where five octaves per step is the difference between running and not. */
float fbm3Od(vec2 p){
  float v = 0.0;
  float a = 0.5;
  for(int i = 0; i < 3; i++){
    v += a * noiseOd(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

/* Box, in the max form Machina uses — cheap, and its exterior distance is what
 * the glow accumulators want. */
float sbOd(vec3 p, vec3 s){
  p = abs(p) - s;
  return max(max(p.x, p.y), p.z);
}

/*
 * A ray into the sky dome, from the same uv the flat layers are drawn in, so a
 * background with real depth still tracks the rig (frameOd has already folded
 * in orbit, height, fov and distance).
 */
vec3 skyRayOd(vec2 uv, float z){
  return normalize(vec3(uv, z));
}

/*
 * How much of a sky background survives at this pixel: nothing below the
 * ground line, and eased in above it so the background does not fight the
 * horizon glow every scene puts there.
 */
float skyFadeOd(float y, float gy){
  return smoothstep(gy - 0.01, gy + 0.18, y);
}

/* The frame every scene shares: centred, aspect-corrected, rig-driven. */
vec2 frameOd(vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy - 0.5;
  uv.x *= iResolution.x / iResolution.y;
  uv *= (iCamFov / 60.0) * max(iCamDist, 0.3);
  uv.y -= iCamHeight * 0.2;
  return uv;
}

/* One pixel in frame units — the antialiasing width for every silhouette. */
float pxOd(){
  return 1.6 * (iCamFov / 60.0) * max(iCamDist, 0.3) / iResolution.y;
}

/* Horizon's sin-stack ridge. This is the shape language of the whole suite. */
float ridgeOd(float x, float seed){
  float w = 0.0;
  float a = 1.0;
  x = x * 20.0 + seed;
  w += sin(x * 0.3521) * 4.0;
  for(int i = 0; i < 5; i++){
    x *= 1.53562;
    x += 7.56248;
    w += sin(x) * a;
    a *= 0.5;
  }
  return w * 0.015;
}

/* Height of one parallax band at x, and the band as an antialiased mask
 * (1 above the ridge, 0 in the solid below it). */
float groundOd(float x, float scroll, float seed, float base, float amp){
  return base + ridgeOd(x + scroll, seed) * amp;
}
float bandOd(vec2 uv, float scroll, float seed, float base, float amp, float px){
  return smoothstep(-px, px, uv.y - groundOd(uv.x, scroll, seed, base, amp));
}

float sdSegOd(vec2 p, vec2 a, vec2 b, float r){
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

/*
 * The traveller: a side-on silhouette mid-stride with a greatsword raised.
 * p is figure-space — feet at y = 0, crown near y = 1 — so a scene only has
 * to decide where the figure stands and how tall it is. ph is the stride phase
 * in radians. sw scales the sword alone, so it can be made absurd without
 * inflating the body with it.
 */
float walkerOd(vec2 p, float ph, float sw){
  float s = sin(ph);
  float c = cos(ph);
  p.y -= abs(s) * 0.03;                      // the bob of a walk cycle
  float d = 1e5;

  vec2 hip = vec2(0.0, 0.44);
  vec2 kF = hip + vec2( 0.11 * s + 0.02, -0.21);
  vec2 fF = kF  + vec2( 0.09 * s + 0.03, -0.23);
  vec2 kB = hip + vec2(-0.11 * s + 0.02, -0.21);
  vec2 fB = kB  + vec2(-0.09 * s + 0.03, -0.23);
  d = min(d, sdSegOd(p, hip, kF, 0.055));
  d = min(d, sdSegOd(p, kF,  fF, 0.042));
  d = min(d, sdSegOd(p, hip, kB, 0.055));
  d = min(d, sdSegOd(p, kB,  fB, 0.042));

  vec2 sh = vec2(0.02 + c * 0.015, 0.78);    // shoulders counter-rotate
  d = min(d, sdSegOd(p, hip, sh, 0.088));
  d = min(d, length(p - (sh + vec2(0.03, 0.12))) - 0.088);

  vec2 grip = sh + vec2(0.17, -0.05);        // both hands on the grip
  d = min(d, sdSegOd(p, sh,                     grip,                     0.040));
  d = min(d, sdSegOd(p, sh + vec2(0.0, -0.06), grip + vec2(0.0, 0.04), 0.036));

  // The sword, raised and leaning forward off the grip.
  vec2 q = (p - grip) * rotOd(-0.35);
  float bl = 1.15 * sw;
  d = min(d, sdSegOd(q, vec2(0.0, -0.13 * sw), vec2(0.0, 0.03), 0.030 * sw));
  d = min(d, length(q - vec2(0.0, -0.16 * sw)) - 0.042 * sw);
  d = min(d, sdSegOd(q, vec2(-0.17 * sw, 0.055), vec2(0.17 * sw, 0.055), 0.026 * sw));

  // Tapered blade: a zero-radius segment less a width that narrows to the tip.
  float t = clamp(q.y / max(bl, 1e-3), 0.0, 1.0);
  float w = (0.070 - 0.050 * t * t) * sw;
  d = min(d, sdSegOd(q, vec2(0.0, 0.07), vec2(0.0, bl), 0.0) - w);
  return d;
}

/* Where the traveller is across the frame. At speed 0 they hold centre and
 * march in place rather than freezing at an edge. */
float travellerXOd(float spd){
  return -0.85 + fract(0.5 + iTime * spd) * 1.7;
}

/* The traveller in frame units: signed distance, negative inside the figure.
 * Hidden returns a large positive, so a scene can call it unconditionally. */
float travellerOd(vec2 uv, float wx, float gy, float h, float spd, float sw, float show){
  if(show < 0.5) return 1e5;
  float ph = iTime * (1.6 + spd * 40.0);
  return walkerOd((uv - vec2(wx, gy)) / h, ph, sw) * h;
}

/* A hunched, kneeling silhouette, in the same figure-space as walkerOd so the
 * two read as the same species at a glance. k bows the back further over. */
float slumpedOd(vec2 p, float k){
  float d = 1e5;
  vec2 hip = vec2(0.0, 0.26);
  d = min(d, sdSegOd(p, hip, vec2( 0.20, 0.05), 0.070));   // folded legs
  d = min(d, sdSegOd(p, hip, vec2(-0.13, 0.04), 0.062));
  vec2 sh = vec2(-0.07 - k * 0.07, 0.56 - k * 0.10);       // the bowed back
  d = min(d, sdSegOd(p, hip, sh, 0.085));
  d = min(d, length(p - (sh + vec2(-0.06 - k * 0.05, 0.10))) - 0.082);
  d = min(d, sdSegOd(p, sh, sh + vec2(0.19, -0.24), 0.045)); // an arm to the ground
  return d;
}

/* Horizon's fractal tree, trimmed to five iterations for the projector.
 * Returns a distance; threshold it to get the silhouette. */
float treeOd(vec2 p, float seed, float sway){
  float nv = noiseOd(vec2(seed * 7.1, 0.5)) * 0.25;
  p *= 12.0 + noiseOd(vec2(seed * 1.72561, 3.0)) * 8.0;
  float ot = 1000.0;
  float a = radians(-60.0 + noiseOd(vec2(seed, 1.0)) * 30.0);
  a += sin(iTime * 2.0 + seed * 20.0) * 0.06 * sway;
  for(int i = 0; i < 5; i++){
    ot = min(ot, length(max(vec2(0.0), abs(p) - vec2(-a * 0.15, 0.9))));
    float sgn = (sign(p.x) + 1.0) * 0.25;
    p.x = abs(p.x);
    p = p * 1.3 - vec2(0.0, 1.0 + nv);
    a *= 0.8;
    a -= (noiseOd(vec2(float(i + 2) * 0.5517 + seed, sgn)) - 0.5) * 0.2;
    p *= rotOd(a);
  }
  return ot;
}

/* Star field: at most one star per cell, size and twinkle from the cell hash. */
float starsOd(vec2 uv, float density, float tw){
  vec2 g = uv * density;
  vec2 c = floor(g);
  float h = hashOd(c);
  if(h < 0.55) return 0.0;
  vec2 f = fract(g) - 0.5;
  vec2 o = (vec2(hashOd(c + 3.1), hashOd(c + 7.7)) - 0.5) * 0.7;
  float b = smoothstep(0.09, 0.0, length(f - o)) * (0.35 + h * 0.65);
  return max(b * (0.6 + 0.4 * sin(iTime * (1.0 + h * 3.0) + h * 40.0) * tw), 0.0);
}

/* Drifting motes. The whole field is offset before the cell split so they
 * scroll smoothly instead of popping at cell boundaries. */
float motesOd(vec2 uv, float density, float rise, float cut){
  uv.y -= iTime * rise;
  uv.x += sin(uv.y * 2.0 + iTime * 0.3) * 0.08;
  vec2 g = uv * density;
  vec2 c = floor(g);
  float h = hashOd(c);
  if(h < cut) return 0.0;
  vec2 f = fract(g) - 0.5;
  vec2 o = (vec2(hashOd(c + 5.3), hashOd(c + 9.1)) - 0.5) * 0.6;
  return smoothstep(0.13, 0.0, length(f - o)) * (0.35 + h * 0.65);
}
`;
