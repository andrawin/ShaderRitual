/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Shared GLSL for the Odyssey suite — six scenes of one journey, from waking in
 * an empty universe to a burnt-out desert, carrying an oversized sword. The
 * scenes are separate shaders so they can be cut between live, but they share
 * this library so the walk, the ground and the sword stay identical from one to
 * the next.
 *
 * It is played in the first person. You are the traveller: the eye walks a
 * lane at head height over a marched heightfield, the sword is held in view the
 * way a shooter holds its weapon, and each scene lines the path with its own
 * props. The shape language is still Horizon's — the terrain is its sin-stack
 * ridge crossed with itself — and the palette still takes The Artful Escape's
 * saturated neon as reference: the sword is cut out black against each scene
 * and rimmed in its key colour, which is the old figure language carried into
 * the viewmodel.
 *
 * Every scene shares two elements, in the same order, so one MIDI map carries
 * across the whole suite:
 *   walk  -> how hard each step lands; hide to put the sword away
 *   sword -> blade size, from a longsword to something absurd
 *
 * Everything here is GLSL-ES 1.00: constant loop bounds with the index
 * declared in the init clause, no round()/dFdx()/texelFetch(), no dynamic
 * array indexing. The side-on figure functions below (walkerOd and friends)
 * are no longer drawn; they are kept for reference to the original suite.
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
 * Real 3D value noise. Sampling 2D noise in a plane that slides with depth is
 * cheaper and looks like volume from a fixed camera, but it shears the moment
 * anything moves through it — a true lattice is what lets a cloud hold its
 * shape while the ray, the camera and the cloud all move independently.
 */
float hash3Od(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3Od(vec3 p){
  vec3 c = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3Od(c),                      hash3Od(c + vec3(1.0, 0.0, 0.0)), f.x),
        mix(hash3Od(c + vec3(0.0, 1.0, 0.0)), hash3Od(c + vec3(1.0, 1.0, 0.0)), f.x), f.y),
    mix(mix(hash3Od(c + vec3(0.0, 0.0, 1.0)), hash3Od(c + vec3(1.0, 0.0, 1.0)), f.x),
        mix(hash3Od(c + vec3(0.0, 1.0, 1.0)), hash3Od(c + vec3(1.0, 1.0, 1.0)), f.x), f.y),
    f.z);
}

/* Three octaves is the ceiling for a density sampled inside a march: each one
 * is eight hashes, and this runs twenty-odd times per pixel. */
float fbmVolOd(vec3 p){
  float v = 0.0;
  float a = 0.5;
  for(int i = 0; i < 3; i++){
    v += a * noise3Od(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

float sdSeg3Od(vec3 p, vec3 a, vec3 b){
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/*
 * Beacon's polar smooth fold. Folding the space rather than the geometry is
 * what turns a single tube into a cage of them; the loop bound came from the
 * argument in the original, so it runs to a constant cap and breaks.
 */
vec2 pSFoldOd(vec2 p, float n){
  float h = floor(log2(n));
  float a = 6.2831 * exp2(h) / n;
  for(int i = 0; i < 6; i++){
    if(float(i) >= h + 2.0) break;
    vec2 v = vec2(-cos(a), sin(a));
    float g = dot(p, v);
    p -= (g - sqrt(g * g + 5e-3)) * v;
    a *= 0.5;
  }
  return p;
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

float sminOd(float a, float b, float k){
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

/*
 * The traveller. p is figure-space — feet at y = 0, crown at y = 1 — so a scene
 * only has to decide where the figure stands and how tall it is. ph is the
 * stride phase in radians; sw scales the sword alone, so it can be made absurd
 * without inflating the body with it.
 *
 * Built to read as a designed character rather than a stick figure, which for a
 * silhouette comes down to four things:
 *
 *   Proportion. Eight heads tall, not the five-and-a-half a naive build gives
 *     you. Nothing else matters as much: a big head reads as a cartoon toy at
 *     any size, and no amount of costume detail fixes it.
 *   A trailing coat. The largest single silhouette gain available — it fills
 *     the space behind the figure, swings against the stride, and is what makes
 *     a walking outline look like it is moving through air.
 *   Hair with a direction. A swept mass off the back of the skull, so the head
 *     is a shape rather than a circle.
 *   Interior line. The body is a black cut-out, so costume detail can only live
 *     as light: walkerOd leaves piping in gTrimOd for the scene to draw inside
 *     the silhouette in its own key colour.
 */
float gTrimOd = 1e5;

float walkerOd(vec2 p, float ph, float sw){
  float s = sin(ph);
  float c = cos(ph);
  p.y -= abs(s) * 0.028;                       // the bob of a walk cycle
  float d = 1e5;
  float tr = 1e5;

  // Eight heads: hip at half height, shoulders at 0.80, crown at 1.0.
  vec2 hip = vec2(0.0, 0.50);
  vec2 sh  = vec2(0.025 + c * 0.014, 0.80);    // shoulders counter-rotate
  vec2 hd  = sh + vec2(0.035, 0.137);

  vec2 kF = hip + vec2( 0.115 * s + 0.02, -0.23);
  vec2 fF = kF  + vec2( 0.100 * s + 0.03, -0.25);
  vec2 kB = hip + vec2(-0.115 * s + 0.02, -0.23);
  vec2 fB = kB  + vec2(-0.100 * s + 0.03, -0.25);

  // Coat. It has to stay narrow and stop around mid-thigh: reaching further
  // back and wider reads as a fin rather than as cloth, and it swallows the
  // stride, which is the one part of the silhouette that has to stay legible.
  float sway = s * 0.09;
  vec2 c0 = sh + vec2(-0.045, 0.015);
  vec2 c1 = c0 + vec2(-0.075 - abs(s) * 0.03, -0.20 + sway * 0.5);
  vec2 c2 = c1 + vec2(-0.075, -0.17 - sway);
  d = min(d, sdSegOd(p, c0, c1, 0.072));
  d = min(d, sdSegOd(p, c1, c2, 0.048));
  d = min(d, sdSegOd(p, c2, c2 + vec2(-0.055, -0.075 - sway * 0.6), 0.021));

  // Legs, with a boot on the end of each.
  d = min(d, sdSegOd(p, hip, kF, 0.050));
  d = min(d, sdSegOd(p, kF,  fF, 0.040));
  d = min(d, sdSegOd(p, fF, fF + vec2(0.055, 0.0), 0.032));
  d = min(d, sdSegOd(p, hip, kB, 0.050));
  d = min(d, sdSegOd(p, kB,  fB, 0.040));
  d = min(d, sdSegOd(p, fB, fB + vec2(0.055, 0.0), 0.032));

  // Torso, tapering to the shoulders.
  d = min(d, sdSegOd(p, hip, mix(hip, sh, 0.5), 0.068));
  d = min(d, sdSegOd(p, mix(hip, sh, 0.5), sh, 0.078));

  // Neck, so the head sits on the body instead of balancing on it.
  d = min(d, sdSegOd(p, sh + vec2(0.020, 0.0), hd + vec2(-0.010, -0.030), 0.030));

  // Head, and a swept mop that gives it a facing. One flick, not two — a
  // second one turns the profile into a crest and the head reads as a bird.
  // Smooth-unioned: a hard min leaves a notch where the hair meets the skull,
  // and in profile that notch is exactly where a beak would be.
  float head = length(p - hd) - 0.062;
  head = sminOd(head,
                length((p - hd - vec2(-0.028, 0.030)) * vec2(1.10, 1.0)) - 0.072, 0.035);
  // Short and thick. A long thin flick off the back of a head this small is a
  // bill, not hair, whatever it is unioned to.
  head = sminOd(head,
                sdSegOd(p, hd + vec2(-0.045, 0.046), hd + vec2(-0.092, 0.012), 0.029), 0.030);
  d = min(d, head);

  // Both arms on the grip, bent at the elbow.
  vec2 grip = sh + vec2(0.175, -0.03);
  vec2 e1 = sh + vec2(0.110, -0.135);
  vec2 e2 = sh + vec2(0.055, -0.165);
  d = min(d, sdSegOd(p, sh, e1, 0.036));
  d = min(d, sdSegOd(p, e1, grip, 0.032));
  d = min(d, sdSegOd(p, sh + vec2(-0.010, -0.05), e2, 0.033));
  d = min(d, sdSegOd(p, e2, grip + vec2(0.0, -0.045), 0.030));

  // Suit piping. Only meaningful inside the silhouette, where the scene draws
  // it as light — outside it would just thicken the outline. Kept to three
  // marks: a line down the centre of a limb reads as bone, not as costume, so
  // these follow seams instead.
  tr = min(tr, sdSegOd(p, sh + vec2(-0.050, -0.030), sh + vec2(0.060, -0.058), 0.005));
  tr = min(tr, sdSegOd(p, sh + vec2(0.018, -0.080), hip + vec2(0.026, 0.020), 0.005));
  tr = min(tr, length(p - (hd + vec2(0.042, 0.008))) - 0.014);   // the visor
  gTrimOd = tr;

  // The sword, raised and leaning forward off the grip.
  vec2 q = (p - grip) * rotOd(-0.35);
  float bl = 1.15 * sw;
  d = min(d, sdSegOd(q, vec2(0.0, -0.13 * sw), vec2(0.0, 0.03), 0.030 * sw));
  d = min(d, length(q - vec2(0.0, -0.16 * sw)) - 0.042 * sw);
  d = min(d, sdSegOd(q, vec2(-0.13 * sw, 0.055), vec2(0.13 * sw, 0.055), 0.024 * sw));

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
  if(show < 0.5){ gTrimOd = 1e5; return 1e5; }
  float ph = iTime * (1.6 + spd * 40.0);
  float d = walkerOd((uv - vec2(wx, gy)) / h, ph, sw) * h;
  gTrimOd *= h;   // piping comes back in figure units; scenes want frame units
  return d;
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

/* ===================== First-person core =====================
 * The suite began as a side-on scroller. Now the traveller is you: the eye is
 * at head height walking the path, the ground is a heightfield marched in
 * depth, and the oversized sword is held in view the way a shooter holds its
 * weapon. Each scene supplies sceneMapOd() and its own shading; everything
 * else — camera, terrain, march, sky projection, the viewmodel — lives here,
 * so the six still feel like one journey when you cut between them.
 */

#define EYE_OD 1.7

// Material of whatever sceneMapOd() last found nearest. 0 is always ground.
float gMatOd = 0.0;

// A step limit a scene may set from sceneMapOd(), kept apart from the
// distance. Folded into the distance it reads as a surface: the hit test is
// relative to range, so far enough out a capped step looks like a wall.
float gCapOd = 1e5;

// Each scene defines this: distance to everything in it, setting gMatOd.
float sceneMapOd(vec3 p);

/*
 * Horizon's ridge, crossed with itself, so the suite's shape language carries
 * into depth. A lane down the middle is kept low; without it the first hill
 * fills the frame and you are looking at a wall.
 */
float terrainOd(vec2 xz, float amp, float seed){
  float a = ridgeOd(xz.x * 0.022, seed);
  float b = ridgeOd(xz.y * 0.016 + xz.x * 0.005, seed + 4.7);
  float lane = smoothstep(2.5, 16.0, abs(xz.x));
  return (a + b) * 55.0 * amp * mix(0.12, 1.0, lane);
}

/* A heightfield is not a distance field — on a slope p.y - h overstates the
 * distance — so the step is taken at a fraction of it. */
float groundDistOd(vec3 p, float amp, float seed){
  return (p.y - terrainOd(p.xz, amp, seed)) * 0.55;
}

// Set by fpsCamOd() for the rest of the frame.
vec2 gUvOd;       // screen position, aspect-corrected, y in [-0.5, 0.5]
float gPhaseOd;   // stride phase
float gPxOd;      // one pixel in gUvOd units

/*
 * How far you have walked. Deliberately driven by iTime and nothing else: the
 * motion clock is already audio-gated and integrated on the CPU, so the pace
 * follows the music smoothly. Multiplying by a band here instead would make
 * the position jump by metres every time the audio moved, because
 * distance = time * speed only holds while speed stands still.
 */
float walkedOd(){ return iTime * 2.4; }

/*
 * The eye: head height over the lane, walking +z. Orbit turns the head — kept
 * within reach, so it never ends up looking back down the path — height
 * pitches it, distance scales how tall you are, and the lens is iCamFov.
 * 'stride' is how hard each footfall lands.
 */
void fpsCamOd(vec2 fragCoord, float amp, float seed, float stride,
              out vec3 ro, out vec3 rd){
  gUvOd = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  gPxOd = 1.5 / iResolution.y;
  float dist = walkedOd();
  gPhaseOd = dist * 1.35;

  float bob = abs(sin(gPhaseOd)) * 0.06 * stride;
  float sway = sin(gPhaseOd) * 0.04 * stride;
  // The ground under the eye, averaged a step either side, so one bump in
  // the lane does not jolt the whole view.
  float g = 0.5 * (terrainOd(vec2(0.0, dist - 1.2), amp, seed)
                 + terrainOd(vec2(0.0, dist + 1.2), amp, seed));
  ro = vec3(sway, g + EYE_OD * clamp(iCamDist, 0.3, 4.0) + bob, dist);

  float yaw = sin(iCamOrbit * 0.5) * 0.55;
  float pitch = -0.05 + iCamHeight * 0.4 - bob * 0.3;
  vec3 fw = normalize(vec3(sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch)));
  // cross(forward, up) — the other order mirrors the world left to right.
  vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(rt, fw);
  float f = 0.5 / tan(radians(clamp(iCamFov, 25.0, 110.0) * 0.5));
  rd = normalize(gUvOd.x * rt + gUvOd.y * up + f * fw);
}

/*
 * The skies were written for a flat frame with the horizon at y = -0.24. This
 * maps a ray to that frame by its angles — azimuth across, elevation up —
 * which puts the horizon back where they expect it and pins them to the
 * world, so they turn with the head and stay put as you walk. A planar
 * projection (rd.xy / rd.z) looks the same straight ahead but its scale runs
 * away as the head turns, and smears the sky at the edge of the frame.
 */
vec2 skyUvOd(vec3 rd){
  float az = (abs(rd.x) + abs(rd.z) < 1e-5) ? 0.0 : atan(-rd.x, rd.z);
  float el = asin(clamp(rd.y, -1.0, 1.0));
  return vec2(az, el) * 1.42 + vec2(0.0, -0.24);
}

/*
 * March the scene. A grazing ray near the horizon can run out of steps short
 * of the ground; treating that as a hit at whatever distance it reached hands
 * it to the fog, which at that range is all that is visible anyway. Treated as
 * a miss instead, the sky shows through the far hills in a ragged line.
 */
float marchOd(vec3 ro, vec3 rd, float maxT, out float mat){
  float t = 0.1;
  mat = -1.0;
  for(int i = 0; i < 100; i++){
    gCapOd = 1e5;
    float d = sceneMapOd(ro + rd * t);
    if(d < 0.0025 * t){ mat = gMatOd; return t; }
    // A floor under the step that grows with distance. A ray skimming far
    // terrain otherwise crawls and runs out of budget, and out there the fog
    // hides any precision the floor costs.
    t += max(min(d, gCapOd), t * 0.003);
    if(t > maxT) return maxT;
  }
  mat = 0.0;
  return t;
}

vec3 normalOd(vec3 p, float t){
  vec2 k = vec2(1.0, -1.0) * (0.004 + t * 0.0015);
  return normalize(k.xyy * sceneMapOd(p + k.xyy) + k.yyx * sceneMapOd(p + k.yyx)
                 + k.yxy * sceneMapOd(p + k.yxy) + k.xxx * sceneMapOd(p + k.xxx));
}

vec3 fogOd(vec3 col, vec3 fogCol, float t, float density){
  return mix(col, fogCol, 1.0 - exp(-t * density));
}

/* How close a ray passes to a point, and how far along it that is — for glows
 * that should sit in the world rather than on the screen. */
float rayPointDistOd(vec3 ro, vec3 rd, vec3 c, out float along){
  along = dot(c - ro, rd);
  return length(ro + rd * max(along, 0.0) - c);
}

/* Domain repetition along the path with a clamp-free cell index, so props keep
 * coming as long as you keep walking. */
float cellOd(float z, float spacing){ return floor(z / spacing + 0.5); }

/* Distance to the edge of a repeated cell along z. A prop's distance only
 * covers its own cell, so a ray could otherwise stride clean over one standing
 * in the next; capping the step at the edge stops that. Feed it to gCapOd, and
 * only below the props' height — never into the distance itself. */
float cellEdgeOd(float z, float cz, float spacing){
  return spacing * 0.5 - abs(z - cz * spacing) + 0.3;
}

/* Particles you walk through: a mote field zoomed out from the middle of the
 * frame, in three staggered layers, so they stream past the way a starfield
 * does. Screen-space motes only slide sideways, which in first person reads
 * as dirt on the lens rather than as air you are moving through. */
float sporesOd(vec2 uv, float speed, float cut){
  float a = 0.0;
  for(int i = 0; i < 3; i++){
    float fi = float(i);
    float z = fract(walkedOd() * speed + fi / 3.0);
    float sc = mix(3.6, 0.35, z);
    float fade = smoothstep(0.0, 0.25, z) * smoothstep(1.0, 0.7, z);
    a += motesOd(uv * sc + fi * 7.31, 9.0, 0.015, cut) * fade;
  }
  return a;
}

/* ---------------- The viewmodel ----------------
 * The sword in your hand. Screen space, so it holds still while the world
 * moves past it — which is the whole effect of a first-person view. Grip off
 * the bottom-right corner, blade rising across toward the centre, the arm
 * dipping on each footfall against the head's rise and kicking on the beat.
 */
float gFullerOd = 1e5;

float viewmodelOd(vec2 uv, float sw, float show, float stride){
  gFullerOd = 1e5;
  if(show < 0.5) return 1e5;
  float ph = gPhaseOd;
  float kick = pow(sin(fract(iBeat) * 6.2831853) * 0.5 + 0.5, 6.0) * iCamReact;
  float aspect = iResolution.x / max(iResolution.y, 1.0);
  vec2 o = vec2(0.5 * aspect - 0.30 + sin(ph) * 0.014 * stride,
                -0.32 - abs(cos(ph)) * 0.024 * stride - kick * 0.018
                + sin(iTime * 1.3) * 0.004);
  float ang = 2.02 + sin(ph) * 0.03 * stride - kick * 0.05;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 nrm = vec2(-dir.y, dir.x);
  vec2 q = uv - o;
  float al = dot(q, dir);     // along the blade
  float ac = dot(q, nrm);     // across it

  float L = 0.48 * sw;
  float thick = sqrt(sw / 1.5);
  float h = clamp((al - 0.04) / max(L - 0.04, 1e-3), 0.0, 1.0);
  // Taper towards the tip, then close to a point over the last eighth.
  float w = mix(0.036, 0.024, h) * thick * (1.0 - smoothstep(0.86, 1.0, h));
  float blade = max(abs(ac) - w, max(0.04 - al, al - L));

  float guard = max(abs(al - 0.028) - 0.012, abs(ac) - 0.085 * thick);
  float grip = max(abs(al + 0.05) - 0.07, abs(ac) - 0.017);
  float pommel = length(q - dir * -0.13) - 0.024;
  // Gauntlet round the grip, and the forearm running off the corner.
  vec2 hq = vec2(al + 0.05, ac);
  float hand = length(max(abs(hq) - vec2(0.05, 0.034), 0.0)) - 0.02;
  vec2 ea = o - dir * 0.05;
  vec2 eb = ea + vec2(0.42, -0.36);
  vec2 pa = uv - ea, ba = eb - ea;
  float hh = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float arm = length(pa - ba * hh) - mix(0.05, 0.085, hh);

  // The fuller: a line down the middle of the blade, for the lit edge.
  gFullerOd = max(abs(ac) - 0.003 * thick, max(0.07 - al, al - L * 0.82));

  return min(min(min(blade, guard), min(grip, pommel)), min(hand, arm));
}

/* Cut the viewmodel out black and rim it in the scene's key colour — the
 * suite's figure language, carried into the first person. */
vec3 viewmodelLayerOd(vec3 col, float sw, float show, float stride, vec3 key, float glow){
  float px = gPxOd;
  float vm = viewmodelOd(gUvOd, sw, show, stride);
  if(vm > 0.05) return col;
  float inside = 1.0 - smoothstep(-px, px, vm);
  col *= 1.0 - inside;
  col += key * smoothstep(px * 2.5, 0.0, abs(vm)) * glow;
  col += key * smoothstep(px * 1.6, 0.0, gFullerOd) * inside * glow * 0.9;
  return col;
}
`;
