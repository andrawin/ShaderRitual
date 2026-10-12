/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Vitrine" — a Cornell box path-traced live, with the loaded clip playing on
 * the faces of the two blocks, and its side and back walls see-through. Because the room is actually traced, the screens
 * are not decals: their light bounces off the walls, so whatever is playing
 * colours the whole box.
 *
 * Adapted from a Shadertoy path tracer with next-event estimation and MIS
 * between the light and the BRDF.
 *
 * Porting notes (GLSL ES 1.00):
 *   - The original seeded its sampler with a TEA cipher over uvec2. There are
 *     no unsigned ints or bit operators in this dialect, so the random stream
 *     is a float hash over (pixel, sample index, time) instead. It decorrelates
 *     well enough that the noise reads as grain rather than as structure.
 *   - transpose() does not exist here. The only transpose taken is of a Y
 *     rotation, whose inverse is the same rotation negated.
 *   - dFdx/dFdy are unavailable, so the sub-pixel jitter uses the analytic
 *     pixel step instead of a screen-space derivative.
 *   - Both intersectors divide by a ray direction that can be zero. The
 *     original leaned on IEEE infinities; the divisor is floored here, keeping
 *     its sign, because a NaN takes the whole pixel with it.
 *   - Sample and bounce counts are constant-capped loops with a break, since
 *     only a constant may bound a loop.
 *
 * The clip reaches the shader whether or not the Video layer is visible —
 * turning that layer off is how you get it *only* on the blocks.
 *
 * Elements:
 *   lamp   -> ceiling light size and output
 *   screen -> the clip on the blocks, and how much light it throws (hideable)
 *   walls  -> how solid the side and back walls are to the camera
 *   tint   -> how much colour those walls throw (hideable for a neutral room)
 *   blocks -> the two blocks themselves (hideable for an empty room)
 *   bounce -> how far light is followed; the cost of colour bleed
 *   detail -> samples per pixel, which is grain against frame rate
 */

const bufferShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform float iTime;
uniform sampler2D iChannel0;
uniform sampler2D iVideo;
uniform float iVideoOn;
uniform float iVideoAspect;

uniform float iCamOrbit;
uniform float iCamDist;
uniform float iCamHeight;
uniform float iCamFov;
uniform float iCamReact;
uniform float iBeat;

uniform float lamp_react;
uniform float screen_react;
uniform float screen_visible;
uniform float tint_react;
uniform float tint_visible;
uniform float walls_react;
uniform float blocks_react;
uniform float blocks_visible;
uniform float bounce_react;
uniform float detail_react;

#define INFINITY 9999999.0
#define PI 3.14159265359

// Scene state, set once per frame in main().
float light_size;
float light_area;
vec3 light_position;
vec3 light_normal;
vec4 light_albedo;
float gScreen;
float gEmit;
float gSamples;
float gBounces;
float gWallEye;    // how solid the three walls are to the camera
float gSkipWalls;  // set for a camera ray that is passing through them

// Random stream. The original used a TEA cipher over unsigned ints, which this
// dialect does not have; this is a float hash over pixel, index and time.
vec2 gPix;
float gSeed;

float hash31(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec2 get_random(){
  gSeed += 1.0;
  return vec2(hash31(vec3(gPix, gSeed)),
              hash31(vec3(gPix.yx + 17.37, gSeed + 101.7)));
}

vec2 sample_disk(vec2 uv){
  float theta = 2.0 * PI * uv.x;
  float r = sqrt(uv.y);
  return vec2(cos(theta), sin(theta)) * r;
}

vec3 sample_cos_hemisphere(vec2 uv){
  vec2 disk = sample_disk(uv);
  return vec3(disk.x, sqrt(max(0.0, 1.0 - dot(disk, disk))), disk.y);
}

mat3 construct_ONB_frisvad(vec3 normal){
  mat3 ret;
  ret[1] = normal;
  if(normal.z < -0.999805696){
    ret[0] = vec3(0.0, -1.0, 0.0);
    ret[2] = vec3(-1.0, 0.0, 0.0);
  } else {
    float a = 1.0 / (1.0 + normal.z);
    float b = -normal.x * normal.y * a;
    ret[0] = vec3(1.0 - normal.x * normal.x * a, b, -normal.x);
    ret[2] = vec3(b, 1.0 - normal.y * normal.y * a, -normal.y);
  }
  return ret;
}

struct Ray { vec3 origin; vec3 dir; };

/* Y rotation, and its inverse — which is all transpose() was being used for. */
vec3 rotY(vec3 v, float a){
  float s = sin(a), c = cos(a);
  return vec3(c * v.x - s * v.z, v.y, s * v.x + c * v.z);
}

vec3 sample_light(vec2 rng){
  return light_position + vec3(rng.x - 0.5, 0.0, rng.y - 0.5) * light_size;
}

vec3 ray_at(in Ray ray, float t){ return ray.origin + t * ray.dir; }

/* A direction component of exactly zero divides to infinity, and the NaN that
 * follows takes the pixel with it. Floor the magnitude, keep the sign. */
vec3 safeInv(vec3 d){
  vec3 m = max(abs(d), vec3(1e-7));
  return vec3(d.x < 0.0 ? -1.0 : 1.0, d.y < 0.0 ? -1.0 : 1.0, d.z < 0.0 ? -1.0 : 1.0) / m;
}

bool intersect_aabb(in Ray ray, vec3 mn, vec3 mx, inout float t_min, inout float t_max){
  vec3 div = safeInv(ray.dir);
  vec3 t_1 = (mn - ray.origin) * div;
  vec3 t_2 = (mx - ray.origin) * div;
  vec3 a = min(t_1, t_2);
  vec3 b = max(t_1, t_2);
  t_min = max(max(a.x, a.y), max(a.z, t_min));
  t_max = min(min(b.x, b.y), min(b.z, t_max));
  return t_min < t_max;
}

float intersect_plane(Ray ray, vec3 center, vec3 normal){
  float denom = dot(ray.dir, normal);
  if(abs(denom) < 1e-6) return INFINITY;
  float t = dot(center - ray.origin, normal) / denom;
  return t > 0.0 ? t : INFINITY;
}

float intersect_box(Ray ray, out vec3 normal, vec3 size){
  float t_min = 0.0;
  float t_max = 999999999.0;
  normal = vec3(0.0, 1.0, 0.0);
  if(intersect_aabb(ray, -size, size, t_min, t_max)){
    vec3 p = ray_at(ray, t_min) / size;
    if(abs(p.x) > abs(p.y)){
      if(abs(p.x) > abs(p.z)) normal = vec3(p.x > 0.0 ? 1.0 : -1.0, 0.0, 0.0);
      else normal = vec3(0.0, 0.0, p.z > 0.0 ? 1.0 : -1.0);
    } else if(abs(p.y) > abs(p.z)){
      normal = vec3(0.0, p.y > 0.0 ? 1.0 : -1.0, 0.0);
    } else {
      normal = vec3(0.0, 0.0, p.z > 0.0 ? 1.0 : -1.0);
    }
    return t_min;
  }
  return INFINITY;
}

/* The clip on a block face. Cover-fitted to the face so a 16:9 frame is
 * cropped rather than squashed onto a tall side. */
vec3 screenColour(vec3 lp, vec3 n, vec3 size){
  vec2 uv;
  vec2 fs;
  if(abs(n.x) > 0.5){
    uv = vec2(-(n.x > 0.0 ? 1.0 : -1.0) * lp.z, lp.y) / vec2(size.z, size.y);
    fs = vec2(size.z, size.y);
  } else if(abs(n.y) > 0.5){
    uv = vec2(lp.x, -(n.y > 0.0 ? 1.0 : -1.0) * lp.z) / vec2(size.x, size.z);
    fs = vec2(size.x, size.z);
  } else {
    uv = vec2((n.z > 0.0 ? 1.0 : -1.0) * lp.x, lp.y) / vec2(size.x, size.y);
    fs = vec2(size.x, size.y);
  }
  uv = uv * 0.5 + 0.5;
  float fa = fs.x / max(fs.y, 1e-4);
  vec2 sc = vec2(min(1.0, fa / max(iVideoAspect, 1e-4)), min(1.0, iVideoAspect / max(fa, 1e-4)));
  uv = (uv - 0.5) * sc + 0.5;
  return texture2D(iVideo, clamp(uv, 0.0, 1.0)).rgb;
}

float intersect_light(Ray ray){
  float t = intersect_plane(ray, light_position, light_normal);
  if(t >= INFINITY) return INFINITY;
  vec3 p = ray_at(ray, t);
  if(all(lessThan(abs(light_position - p).xz, vec2(light_size * 0.5)))) return t;
  return INFINITY;
}

/*
 * emit carries the block screens' own output. The area light stays in
 * albedo.a, where the MIS weighting expects it; the screens are not sampled by
 * next-event estimation, so they are added along the path instead.
 */
float intersect(Ray ray, inout vec3 p, inout vec3 normal, out vec4 albedo, out vec3 emit){
  float t_min = INFINITY;
  albedo = vec4(0.0);
  emit = vec3(0.0);

  {
    float t = intersect_light(ray);
    if(t < t_min){ albedo = light_albedo; normal = light_normal; t_min = t; p = ray_at(ray, t); }
  }

  if(blocks_visible > 0.5){
    // Tall block, turned off-axis.
    vec3 nt;
    Ray rt = ray;
    float ang = 0.3;
    rt.origin -= vec3(-0.35, -0.5, -0.35);
    rt.dir = rotY(rt.dir, ang);
    rt.origin = rotY(rt.origin, ang);
    vec3 size = vec3(0.25, 0.5, 0.25);
    float t = intersect_box(rt, nt, size);
    if(t < t_min){
      t_min = t;
      p = ray_at(ray, t);
      albedo = vec4(0.7, 0.7, 0.7, 0.0);
      if(iVideoOn > 0.5 && screen_visible > 0.5){
        vec3 c = screenColour(ray_at(rt, t), nt, size);
        albedo.rgb = c * gScreen;
        emit = c * gEmit;
      }
      normal = rotY(nt, -ang);
    }

    // Short block, square on.
    Ray rs = ray;
    rs.origin -= vec3(0.5, -0.75, 0.35);
    vec3 size2 = vec3(0.25);
    float t2 = intersect_box(rs, nt, size2);
    if(t2 < t_min){
      t_min = t2;
      p = ray_at(ray, t2);
      albedo = vec4(0.7, 0.7, 0.7, 0.0);
      if(iVideoOn > 0.5 && screen_visible > 0.5){
        vec3 c = screenColour(ray_at(rs, t2), nt, size2);
        albedo.rgb = c * gScreen;
        emit = c * gEmit;
      }
      normal = nt;
    }
  }

  float sat = tint_visible > 0.5 ? clamp(tint_react / 1.2, 0.0, 1.0) : 0.0;
  vec3 red = mix(vec3(0.7), vec3(0.9, 0.1, 0.1), clamp(sat, 0.0, 1.0));
  vec3 grn = mix(vec3(0.7), vec3(0.1, 0.9, 0.1), clamp(sat, 0.0, 1.0));

  if(gSkipWalls < 0.5){
  // left
  {
    vec3 n = vec3(1, 0, 0);
    float t = intersect_plane(ray, vec3(-1, 0, 0), n);
    if(t < t_min){
      vec3 q = ray_at(ray, t);
      if(all(lessThanEqual(q.yz, vec2(1.0))) && all(greaterThanEqual(q.yz, vec2(-1.0)))){
        normal = n; p = q; t_min = t; albedo = vec4(red, 0.0); emit = vec3(0.0);
      }
    }
  }
  // right
  {
    vec3 n = vec3(-1, 0, 0);
    float t = intersect_plane(ray, vec3(1, 0, 0), n);
    if(t < t_min){
      vec3 q = ray_at(ray, t);
      if(all(lessThanEqual(q.yz, vec2(1.0))) && all(greaterThanEqual(q.yz, vec2(-1.0)))){
        normal = n; p = q; t_min = t; albedo = vec4(grn, 0.0); emit = vec3(0.0);
      }
    }
  }
  }

  // floor
  {
    vec3 n = vec3(0, 1, 0);
    float t = intersect_plane(ray, vec3(0, -1, 0), n);
    if(t < t_min){
      vec3 q = ray_at(ray, t);
      if(all(lessThan(q.xz, vec2(1.0))) && all(greaterThan(q.xz, vec2(-1.0)))){
        normal = n; p = q; t_min = t; albedo = vec4(0.7, 0.7, 0.7, 0.0); emit = vec3(0.0);
      }
    }
  }
  // ceiling
  {
    vec3 n = vec3(0, -1, 0);
    float t = intersect_plane(ray, vec3(0, 1, 0), n);
    if(t < t_min){
      vec3 q = ray_at(ray, t);
      if(all(lessThan(q.xz, vec2(1.0))) && all(greaterThan(q.xz, vec2(-1.0)))){
        normal = n; p = q; t_min = t; albedo = vec4(0.7, 0.7, 0.7, 0.0); emit = vec3(0.0);
      }
    }
  }
  if(gSkipWalls < 0.5){
  // back wall
  {
    vec3 n = vec3(0, 0, 1);
    float t = intersect_plane(ray, vec3(0, 0, -1), n);
    if(t < t_min){
      vec3 q = ray_at(ray, t);
      if(all(lessThan(q.xy, vec2(1.0))) && all(greaterThan(q.xy, vec2(-1.0)))){
        normal = n; p = q; t_min = t; albedo = vec4(0.7, 0.7, 0.7, 0.0); emit = vec3(0.0);
      }
    }
  }
  }

  normal = normalize(normal);
  return t_min;
}

bool test_visibility(vec3 p1, vec3 p2){
  float eps = 1e-5;
  Ray r;
  r.dir = normalize(p2 - p1);
  r.origin = p1 + eps * r.dir;
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 q = vec3(0.0);
  vec4 a;
  vec3 e;
  float t_shadow = intersect(r, q, n, a, e);
  return t_shadow > distance(p1, p2) - 2.0 * eps;
}

vec3 pt_mis(Ray ray){
  vec3 contrib = vec3(0.0);
  vec3 tp = vec3(1.0);
  vec3 position = vec3(0.0);
  vec3 normal = vec3(0.0, 1.0, 0.0);
  vec4 albedo;
  vec3 emit;

  // Whether this camera ray passes through the walls is decided per sample, so
  // the fader cross-fades across the samples in a pixel rather than dimming a
  // wall that is still standing in the way. Cleared immediately: the bounce and
  // shadow rays must always see the walls, or the room loses its bounced
  // colour and its shadows along with them.
  gSkipWalls = get_random().x < (1.0 - gWallEye) ? 1.0 : 0.0;
  float t = intersect(ray, position, normal, albedo, emit);
  gSkipWalls = 0.0;
  if(t >= INFINITY) return vec3(0.0);
  if(albedo.a > 0.0) return albedo.rgb * albedo.a;
  contrib += emit;

  for(int i = 0; i < 3; i++){
    if(float(i) >= gBounces) break;
    mat3 onb = construct_ONB_frisvad(normal);

    { /* next-event estimation against the ceiling light */
      vec3 pos_ls = sample_light(get_random());
      vec3 l_nee = pos_ls - position;
      float rr_nee = dot(l_nee, l_nee);
      l_nee /= sqrt(max(rr_nee, 1e-8));
      float G = max(0.0, dot(normal, l_nee)) * max(0.0, -dot(l_nee, light_normal)) / max(rr_nee, 1e-8);
      if(G > 0.0){
        float light_pdf = 1.0 / (light_area * G);
        float brdf_pdf = 1.0 / PI;
        float w = light_pdf / (light_pdf + brdf_pdf);
        vec3 brdf = albedo.rgb / PI;
        if(test_visibility(position, pos_ls)){
          vec3 Le = light_albedo.rgb * light_albedo.a;
          contrib += tp * (Le * w * brdf) / light_pdf;
        }
      }
    }

    { /* BRDF sample */
      vec3 dir = normalize(onb * sample_cos_hemisphere(get_random()));
      vec3 brdf = albedo.rgb / PI;
      Ray rn;
      rn.dir = dir;
      rn.origin = position + dir * 1e-5;
      vec3 pn = vec3(0.0), nn = vec3(0.0, 1.0, 0.0);
      vec4 an;
      vec3 en;
      float tn = intersect(rn, pn, nn, an, en);
      if(tn >= INFINITY) break;
      float brdf_pdf = 1.0 / PI;

      if(an.a > 0.0){ /* hit the light */
        float G = max(0.0, dot(rn.dir, normal)) * max(0.0, -dot(rn.dir, nn)) / max(tn * tn, 1e-8);
        if(G <= 0.0) break;
        float light_pdf = 1.0 / (light_area * G);
        float w = brdf_pdf / (light_pdf + brdf_pdf);
        vec3 Le = light_albedo.rgb * light_albedo.a;
        contrib += tp * (Le * w * brdf) / brdf_pdf;
        break;
      }

      tp *= brdf / brdf_pdf;
      // The screens are not in the light sampling, so their own output is
      // picked up here, weighted by the throughput that reached them.
      contrib += tp * en;
      position = pn;
      normal = nn;
      albedo = an;
    }
  }
  return contrib;
}

void main(){
  vec2 frag = vUv * iResolution.xy;
  gPix = frag;
  gSeed = fract(iTime * 0.37) * 113.0;

  float det = clamp(detail_react, 0.0, 2.0);
  gSamples = 2.0 + det * 7.0;
  gBounces = 1.0 + floor(clamp(bounce_react, 0.0, 2.0) * 1.49);

  float beat = pow(sin(fract(iBeat) * 6.2831853) * 0.5 + 0.5, 3.0);
  float power = (0.35 + clamp(lamp_react, 0.0, 2.0) * 0.9) * (1.0 + beat * iCamReact * 0.25);
  light_size = 0.5;
  light_area = light_size * light_size;
  light_position = vec3(0.5 * sin(iTime), 0.90, 0.5 * cos(iTime));
  light_normal = vec3(0.0, -1.0, 0.0);
  light_albedo = vec4(1.0, 1.0, 1.0, 2.0 * power / light_area);

  gWallEye = clamp(walls_react, 0.0, 1.0);
  float sg = clamp(screen_react, 0.0, 2.0);
  gScreen = 0.55 + sg * 0.3;     // how the clip behaves as a diffuse surface
  gEmit = sg * 0.9;              // and how much light it throws into the room

  vec2 p = vUv - 0.5;
  float a = iResolution.x / max(iResolution.y, 1.0);
  vec2 pstep;
  if(a < 1.0){ p.y /= a; pstep = vec2(1.0 / iResolution.x, 1.0 / (iResolution.y * a)); }
  else { p.x *= a; pstep = vec2(a / iResolution.x, 1.0 / iResolution.y); }

  // Camera on the shared rig, orbiting the open face of the box.
  float orb = iCamOrbit * 0.35;
  float zoom0 = 1.0 / max(tan(radians(clamp(iCamFov, 15.0, 110.0) * 0.5)) * 2.0, 0.05);
  // The open face is 2 units across at z = 1, so a ray leaving the frame edge
  // stops hitting the room past this distance and comes back black. At
  // iCamDist = 1 the room exactly fills the frame, whatever the aspect.
  float fill = 1.0 + zoom0 / max(0.5 * (iResolution.x / max(iResolution.y, 1.0)), 0.5);
  float dist = fill * clamp(iCamDist, 0.45, 2.2);
  vec3 cam_center = vec3(sin(orb) * dist, iCamHeight * 0.7, cos(orb) * dist);
  vec3 fwd = normalize(-cam_center);
  vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
  vec3 up = cross(right, fwd);
  float zoom = zoom0;

  vec3 s = vec3(0.0);
  float n = 0.0;
  for(int i = 0; i < 16; i++){
    if(float(i) >= gSamples) break;
    vec2 r = get_random();
    vec2 jp = p + (r - 0.5) * pstep;
    Ray ray;
    ray.origin = cam_center;
    ray.dir = normalize(jp.x * right + jp.y * up + zoom * fwd);
    s += pt_mis(ray);
    n += 1.0;
  }

  vec3 col = pow(max(s / max(n, 1.0), 0.0), vec3(1.0 / 2.2));

  // The layer hands its own last frame back on iChannel0, so the estimate can
  // be carried across frames instead of being thrown away. More samples means
  // trusting the new frame more, which is also what keeps the smear short when
  // the quality is high enough not to need the help.
  vec3 prev = texture2D(iChannel0, vUv).rgb;
  float keep = mix(0.26, 0.65, clamp(det * 0.5, 0.0, 1.0));
  if(dot(prev, prev) > 1e-6) col = mix(prev, col, keep);

  gl_FragColor = vec4(col, 1.0);
}
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;

/* A small cross blur. At the sample counts this can afford in real time the
 * estimate is grainy, and a touch of spatial averaging buys back more than it
 * costs in sharpness. */
void main(){
  vec2 px = 1.0 / iResolution.xy;
  vec3 c = texture2D(iChannel0, vUv).rgb * 4.0;
  c += texture2D(iChannel0, vUv + vec2(px.x, 0.0)).rgb;
  c += texture2D(iChannel0, vUv - vec2(px.x, 0.0)).rgb;
  c += texture2D(iChannel0, vUv + vec2(0.0, px.y)).rgb;
  c += texture2D(iChannel0, vUv - vec2(0.0, px.y)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}
`;

export const vitrine: ShaderDef = {
  id: 'vitrine',
  name: 'Vitrine',
  description:
    'A Cornell box traced live, with the loaded clip playing on the blocks — its light bounces off the walls.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'lamp',
      name: 'Lamp',
      description:
        'Output of the ceiling light that circles above the room. The manual level sets the exposure of the whole box.',
      defaultBand: 'low',
      defaultAmount: 0.7,
      defaultLevel: 0.7,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'screen',
      name: 'Screens',
      description:
        'The clip on the blocks, and how much light it throws into the room. Load a clip in Video; turn that layer off to keep it on the blocks only.',
      defaultBand: 'mid',
      defaultAmount: 0.6,
      defaultLevel: 0.9,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'walls',
      name: 'Wall Solidity',
      description:
        'How solid the side and back walls are to the camera. At 0 you see straight through them to the void, while they still bounce their colour into the room — coloured light with no visible source. Turn it up for the closed box.',
      defaultBand: 'none',
      defaultAmount: 0.4,
      defaultLevel: 0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Wall Colour',
      description:
        'How red and green the side walls are. They colour the light whether or not they can be seen; hide for a neutral room.',
      defaultBand: 'none',
      defaultAmount: 0.5,
      defaultLevel: 1.2,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'blocks',
      name: 'Blocks',
      description: 'The two blocks. Hide for an empty room — and with them go the screens.',
      defaultBand: 'none',
      defaultAmount: 0.3,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'bounce',
      name: 'Bounces',
      description:
        'How far light is followed: one bounce is direct light only, three carries colour from wall to wall.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Samples',
      description:
        'Rays per pixel. This is grain traded against frame rate — low is noisy and fast, high is clean and slow.',
      defaultBand: 'none',
      defaultAmount: 0,
      defaultLevel: 1.2,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
