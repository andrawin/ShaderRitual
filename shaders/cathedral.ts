/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Cathedral" — a grid of audio-reactive columns, spheres and a roaming light,
 * adapted from a Shadertoy-style raymarcher (originally GLSL 1.50 / desktop).
 *
 * Ported to the engine's GLSL-ES 1.00 two-pass pipeline and rewired so that:
 *   - the per-frame FFT texture lookups become element `_react` uniforms, and
 *   - the BPM-locked / noisy camera becomes the GLOBAL camera rig uniforms
 *     (iCamOrbit / iCamDist / iCamHeight / iCamFov / iBeat).
 *
 * It is the showcase for "camera angle play": switch the Motion mode between
 * Manual / BPM / Audio in the menu and the whole shot re-frames live.
 *
 * Elements:
 *   columns -> height of the cylinder forest   (drives gHeightScale)
 *   spheres -> radius of the grid spheres       (drives gSphRadius)
 *   light   -> brightness of the roaming light  (drives the beat-pulse volume)
 *   bloom   -> additive glow in the Image pass
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

uniform float columns_react;
uniform float columns_visible;
uniform float spheres_react;
uniform float spheres_visible;
uniform float light_react;
uniform float light_visible;

#define hash(x) fract(sin(x) * 43758.5453)
const float PI = 3.14159265;
const float PI2 = 6.28318530;
const float EPS = 0.001;
const float rCyl = 0.1;
const float lightSize = 0.5;

// audio-driven globals — set once per frame in main()
float gVolume;       // overall pulse volume (from the light element)
float gHeightScale;  // how tall the columns get
float gSphRadius;    // sphere size
float maxHeight;     // dynamic ceiling for ray culling
vec3 lightPos;

mat2 rotate2D(float a){ float s = sin(a), c = cos(a); return mat2(c, s, -s, c); }

float sphIntersect(vec3 ro, vec3 rd, vec3 ce, float ra){
  vec3 oc = ro - ce;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - ra * ra;
  float h = b * b - c;
  if(h < 0.) return -1.;
  return -b - sqrt(h);
}

float cylIntersect(vec3 ro, vec3 rd, vec3 ca, float cr){
  float rcaca = 1. / dot(ca, ca);
  float card = dot(ca, rd);
  float caro = dot(ca, ro);
  float a = 1. - card * card * rcaca;
  float b = dot(ro, rd) - caro * card * rcaca;
  float c = dot(ro, ro) - caro * caro * rcaca - cr * cr;
  float h = b * b - a * c;
  if(h < 0.) return -1.;
  float t = (-b - sqrt(h)) / a;
  if(caro + t * card < 0.) return -1.;
  return t;
}

// procedural height per grid cell, scaled by the columns element
float height(vec2 p){
  p += 0.5;
  float L = length(p);
  float theta = (atan(p.y, p.x) + PI) / PI2;
  float wave = sin(L * 0.6 - iTime * 2.0) * 0.5 + 0.5;
  float wave2 = sin(theta * 5.0 + iTime * 1.5) * 0.5 + 0.5;
  float pattern = wave * wave2;
  return pattern * gHeightScale + gSphRadius;
}

float objIntersect(vec3 ro, vec3 rd, vec2 ID, float tCell){
  float tObj = 1e5;

  float h = height(ID);
  float h1 = height(ID + vec2(1, 0));
  float h2 = height(ID + vec2(-1, 0));
  float h3 = height(ID + vec2(0, 1));
  float h4 = height(ID + vec2(0, -1));
  float maxH = max(max(max(max(h, h1), h2), h3), h4) + gSphRadius;

  if(rd.y > 0. && ro.y > maxH) return tObj;
  if(rd.y < 0. && ro.y + rd.y * tCell > maxH) return tObj;

  ro.y -= h;

  if(spheres_visible > 0.5){
    float tSph = sphIntersect(ro, rd, vec3(0), gSphRadius);
    tObj = tSph > 0. ? tSph : tObj;
  }

  if(columns_visible > 0.5){
    float res = cylIntersect(ro, rd, vec3(1, h1 - h, 0), rCyl);
    tObj = res > 0. && res < tObj ? res : tObj;
    res = cylIntersect(ro, rd, vec3(-1, h2 - h, 0), rCyl);
    tObj = res > 0. && res < tObj ? res : tObj;
    res = cylIntersect(ro, rd, vec3(0, h3 - h, 1), rCyl);
    tObj = res > 0. && res < tObj ? res : tObj;
    res = cylIntersect(ro, rd, vec3(0, h4 - h, -1), rCyl);
    tObj = res > 0. && res < tObj ? res : tObj;
  }

  return tObj;
}

float castRay(vec3 ro, vec3 rd){
  float t = 0.;
  vec2 ri = 1. / rd.xz;
  vec2 rs = sign(rd.xz);
  float tLimit = 1e5;

  if(ro.y > maxHeight && rd.y > 0.) return tLimit;

  float temp = (maxHeight - ro.y) / rd.y;
  tLimit = temp > 0. && rd.y > 0. ? temp : tLimit;

  float tFloor = -ro.y / rd.y;
  tLimit = tFloor > 0. ? tFloor : tLimit;

  float tLight = sphIntersect(ro, rd, lightPos, lightSize);
  tLimit = tLight > 0. && tLight < tLimit ? tLight : tLimit;

  vec2 ID = floor(ro.xz);
  for(int i = 0; i < 100; i++){
    if(t >= tLimit) break;
    vec3 rp = ro + t * rd;

    vec2 frp = rp.xz - ID - 0.5;
    vec2 v = (0.5 * rs - frp) * ri;
    vec2 vCell = vec2(step(v.x, v.y), step(v.y, v.x));
    float tCell = dot(v, vCell);
    float tObj = objIntersect(vec3(frp.x, rp.y, frp.y), rd, ID, tCell);

    if(tObj < tCell) return min(t + tObj, tLimit);

    t += tCell;
    ID += vCell * rs;
  }

  return tLimit;
}

vec3 cylNormal(vec3 p, vec3 ca, float cr){
  return (p - ca * dot(p, ca) / dot(ca, ca)) / cr;
}

vec3 objNormal(vec3 p){
  vec3 normal = vec3(0, 1, 0);
  if(p.y < EPS) return normal;

  vec3 pos = p - lightPos;
  if(dot(pos, pos) < (lightSize + EPS) * (lightSize + EPS)) return pos / lightSize;

  vec2 ID = floor(p.xz);
  float h = height(ID);
  p.xz = fract(p.xz) - 0.5;
  p.y -= h;

  if(dot(p, p) < (gSphRadius + EPS) * (gSphRadius + EPS)) return p / gSphRadius;

  float minDis = 1e5;
  vec3 ca = vec3(1, height(ID + vec2(1, 0)) - h, 0);
  vec3 tmp = cylNormal(p, ca, rCyl);
  float dis = abs(dot(tmp, tmp) - 1.);
  if(dis < minDis){ minDis = dis; normal = tmp; }

  ca = vec3(-1, height(ID + vec2(-1, 0)) - h, 0);
  tmp = cylNormal(p, ca, rCyl);
  dis = abs(dot(tmp, tmp) - 1.);
  if(dis < minDis){ minDis = dis; normal = tmp; }

  ca = vec3(0, height(ID + vec2(0, 1)) - h, 1);
  tmp = cylNormal(p, ca, rCyl);
  dis = abs(dot(tmp, tmp) - 1.);
  if(dis < minDis){ minDis = dis; normal = tmp; }

  ca = vec3(0, height(ID + vec2(0, -1)) - h, -1);
  tmp = cylNormal(p, ca, rCyl);
  dis = abs(dot(tmp, tmp) - 1.);
  if(dis < minDis){ minDis = dis; normal = tmp; }

  return normal;
}

vec3 render(vec3 ro, vec3 rd){
  vec3 col = vec3(0);
  vec3 amb = vec3(0.01);

  float t = (maxHeight - ro.y) / rd.y;
  if(rd.y < 0. && t > 0.) ro += t * rd;

  t = castRay(ro, rd);
  vec3 rp = ro + t * rd;
  if(rp.y > maxHeight - EPS) return amb;

  vec3 n = objNormal(rp);
  vec3 ld = lightPos - rp;
  float L = length(ld);
  if(L < lightSize + EPS) return vec3(1);
  ld /= L;

  // light intensity pulses on every beat and reacts to the light element
  float pulse = pow(sin(fract(iBeat) * PI2) * 0.5 + 0.5, 3.);
  float amp = pulse * (0.5 + gVolume * 0.5) + iCamReact * 0.3;
  float lp = (20. + amp * 800.) / (L * L);

  float diff = max(dot(n, ld), 0.);
  float spec = pow(max(dot(reflect(ld, n), rd), 0.), 20.);

  float sh = 1.;
  t = castRay(rp + n * EPS * 0.5, ld);
  if(t < L - lightSize - EPS) sh = 0.2;

  float m = 0.8;
  col = amb + (diff * (1. - m) + spec * m) * lp * sh;
  return col;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = vec2(fragCoord.x / iResolution.x, fragCoord.y / iResolution.y);
  uv -= 0.5;
  uv /= vec2(iResolution.y / iResolution.x, 1) * 0.5;

  // --- audio-driven parameters (from element react uniforms) ---
  gVolume = clamp(light_react, 0., 1.);
  gHeightScale = 3.0 + columns_react * 7.0;
  gSphRadius = 0.2 + spheres_react * 0.3;
  maxHeight = gHeightScale + gSphRadius * 2.;

  // roaming light
  lightPos.xz = sin(vec2(7, 9) * iTime * 0.2) * (3.0 + gVolume * 4.0);
  lightPos.y = 5. + sin(iTime * 0.5) * 2. + spheres_react * 3.0;

  // --- camera from the global motion rig ---
  vec3 ro = vec3(0., 15., 15.);
  ro.y += iCamHeight * 12.;
  ro.xz *= iCamDist;
  ro.xz *= rotate2D(iCamOrbit);

  vec3 ta = vec3(0., 5., 0.);
  vec3 dir = normalize(ta - ro);
  vec3 side = normalize(cross(dir, vec3(0, 1, 0)));
  vec3 up = cross(side, dir);
  float fov = iCamFov;
  vec3 rd = normalize(uv.x * side + uv.y * up + dir / tan(fov / 360. * PI));

  vec3 col = render(ro, rd);
  col = clamp(col, 0., 1.);
  col = pow(col, vec3(1. / 2.2));
  fragColor = vec4(col, 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

const imageShader = `
precision highp float;
varying vec2 vUv;
uniform vec3 iResolution;
uniform sampler2D iChannel0;
uniform float bloom_react;
uniform float bloom_visible;

vec3 bl(vec2 uv){
  vec2 r = iResolution.xy;
  vec3 col = vec3(0.);
  float spread = (2.0 + bloom_react * 4.0) / r.y;
  const int B = 3;
  for(int i = -B; i <= B; i++)
  for(int j = -B; j <= B; j++){
    vec2 o = vec2(float(i), float(j));
    col += texture2D(iChannel0, uv + o * spread).xyz;
  }
  return col / 49.;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  vec3 src = texture2D(iChannel0, uv).xyz;
  if(bloom_visible > 0.5){
    vec3 b = bl(uv);
    src += b * 0.6 * (0.4 + bloom_react);
  }
  fragColor = vec4(src, 1.);
}
void main(){ vec4 c; mainImage(c, vUv * iResolution.xy); gl_FragColor = c; }
`;

export const cathedral: ShaderDef = {
  id: 'cathedral',
  name: 'Cathedral',
  description:
    'Grid of reactive columns, spheres and a roaming light. Built to show off the camera rig — try the Motion mode (Manual / BPM / Audio).',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'columns',
      name: 'Columns',
      description: 'The forest of cylinders. React drives how tall they grow.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'spheres',
      name: 'Spheres',
      description: 'Grid nodes. React drives their radius (bass swells).',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'light',
      name: 'Roaming Light',
      description: 'The moving point light. React drives its pulse brightness.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'bloom',
      name: 'Bloom',
      description: 'Additive glow in the post pass. React drives spread.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
  ],
};
