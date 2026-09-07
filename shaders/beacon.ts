/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Beacon" — a flight past glowing halos strung along a folded lattice: a
 * three-fold polar fold builds a cage of blue light-tubes, a small kaleidoscopic
 * cluster of boxes and frames tumbles inside it, and warm halos hang on the
 * centre line. The camera passes straight through the halos rather than
 * stopping at them, so they read as light rather than surface.
 *
 * Adapted from balkhan's "Distance glow" with aiekick's phantom-mode march.
 *
 * Two things are made configurable, as asked:
 *   - the size of the tumbling objects (the round box and the wireframe box
 *     inside deObj);
 *   - the halo's shape. The original's halo is a hard-coded sphere
 *     (length(q) - 1.5); it now steps through five primitives.
 *
 * Ported to GLSL-ES 1.00: the polar-fold loop had a bound computed from its
 * argument (constant bound with an early break now), round() does not exist
 * (floor(x + 0.5)), and the original left fragColor's alpha undefined, which
 * would blank the pass when it draws straight to the screen.
 *
 * Elements:
 *   size  -> size of the tumbling objects
 *   halo  -> which halo shape (level 0..2 steps through five)
 *   orbs  -> halo size and glow; hideable
 *   tubes -> the blue light-tube cage; hideable
 *   speed -> flight speed along the lattice
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

uniform float size_react;
uniform float halo_react;
uniform float orbs_react;
uniform float orbs_visible;
uniform float tubes_react;
uniform float tubes_visible;
uniform float speed_react;

#define opRepEven(p,s) mod(p,s)-0.5*s
#define rot(a) mat2(cos(a),sin(a),-sin(a),cos(a))

/* Odd repeat. round() does not exist in ES 1.00, so floor(x + 0.5). */
float opRepOdd(float p, float s){ return p - s * floor(p / s + 0.5); }

float lpNorm(vec3 p, float n){
  p = pow(abs(p), vec3(n));
  return pow(p.x + p.y + p.z, 1.0 / n);
}

/* Polar smooth fold. The original's loop bound came from its argument; ES 1.00
 * needs a constant bound, so it runs to a fixed cap and breaks. */
vec2 pSFold(vec2 p, float n){
  float h = floor(log2(n));
  float a = 6.2831 * exp2(h) / n;
  for(int i = 0; i < 8; i++){
    if(float(i) >= h + 2.0) break;
    vec2 v = vec2(-cos(a), sin(a));
    float g = dot(p, v);
    p -= (g - sqrt(g * g + 5e-3)) * v;
    a *= 0.5;
  }
  return p;
}

vec2 sFold45(vec2 p, float k){
  vec2 v = vec2(-1, 1) * 0.7071;
  float g = dot(p, v);
  return p - (g - sqrt(g * g + k)) * v;
}

float frameBox(vec3 p, vec3 s, float r){
  p = abs(p) - s;
  p.yz = sFold45(p.yz, 1e-3);
  p.xy = sFold45(p.xy, 1e-3);
  p.x = max(0.0, p.x);
  return lpNorm(p, 5.0) - r;
}

float sdRoundBox(vec3 p, vec3 b, float r){
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

/* The tumbling objects. Their size is the first configurable knob. */
float deObj(vec3 p){
  float sz = 0.65 + size_react * 0.85;
  return min(sdRoundBox(p, vec3(0.3 * sz), 0.05 * sz),
             frameBox(p, vec3(0.8 * sz), 0.1 * sz));
}

/*
 * The halo. The original hard-coded a sphere; these are the five shapes the
 * Halo element steps through. Each is scaled about the same radius so the
 * glow falloff stays comparable between them.
 */
float haloShape(vec3 q, float sel, float rad){
  if(sel < 0.5) return length(q) - rad;                                  // sphere
  if(sel < 1.5) return sdRoundBox(q, vec3(rad * 0.72), rad * 0.28);      // rounded cube
  if(sel < 2.5){                                                         // torus
    vec2 t = vec2(length(q.xz) - rad * 0.72, q.y);
    return length(t) - rad * 0.36;
  }
  if(sel < 3.5) return lpNorm(q, 5.0) - rad;                             // squircle
  return (abs(q.x) + abs(q.y) + abs(q.z) - rad * 1.45) * 0.5773;         // octahedron
}

float g1 = 0.0, g2 = 0.0, pm = 0.0;
bool fs = false;

float map(vec3 p){
  float de = 1.0;
  p.z -= iTime * (0.6 + speed_react * 1.1);
  vec3 q = p;

  p.xy = pSFold(-p.xy, 3.0);
  p.y -= 8.5;
  p.xz = opRepEven(p.xz, 8.5);

  // The blue light-tube cage.
  if(tubes_visible > 0.5){
    float de1 = length(p.yz) - 1.0;
    g1 += 0.1 / (0.1 + de1 * de1) * (1.0 + tubes_react * 1.2);
    de = min(de, de1);
  }

  p.xz = pSFold(p.xz, 8.0);
  p.z -= 2.0;
  float rate = 0.5;
  float s = 1.0;
  for(int i = 0; i < 3; i++){
    p.xy = abs(p.xy) - 0.8;
    p.xz = abs(p.xz) - 0.5;
    p.xy *= rot(0.2);
    p.xz *= rot(-0.9);
    s *= rate;
    p *= rate;
    de = min(de, deObj(p / s));
  }

  if(fs) return de;

  if(orbs_visible > 0.5){
    q.z = opRepOdd(q.z, 8.5);   // halos strung along the centre line
    float sel = floor(clamp(halo_react, 0.0, 1.99) * 2.51);
    float rad = 1.5 * (0.75 + orbs_react * 0.55);
    float de0 = haloShape(q, sel, rad);
    pm = step(de0, de);
    g2 += 0.1 / (0.1 + de0 * de0) * (1.0 + orbs_react * 0.8);
    de = min(de, de0);
  }
  return de;
}

vec3 calcNormal(vec3 pos){
  vec2 e = vec2(1, -1) * 0.002;
  return normalize(
    e.xyy * map(pos + e.xyy) + e.yyx * map(pos + e.yyx) +
    e.yxy * map(pos + e.yxy) + e.xxx * map(pos + e.xxx));
}

/* Phantom march: steps straight through a halo instead of stopping on it. */
float march(vec3 ro, vec3 rd, float near, float far){
  float t = near;
  float d = 0.0;
  for(int i = 0; i < 100; i++){
    d = map(ro + rd * t);
    t += d;
    if(d < 0.001){
      if(pm < 0.5) return t;
      t += 3.5;
    }
    if(t >= far) return far;
  }
  return far;
}

float calcShadow(vec3 light, vec3 ld, float len){
  fs = true;
  float depth = march(light, ld, 0.0, len);
  return step(len - depth, 0.01);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  g1 = 0.0; g2 = 0.0; pm = 0.0; fs = false;

  vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;
  uv *= (iCamFov / 60.0);

  vec3 ta = vec3(0);
  vec3 ro = vec3(-4, -3, 3) * max(iCamDist, 0.4);
  ro.xz *= rot(iCamOrbit * 0.3);
  ro.y += iCamHeight * 2.0;

  vec3 w = normalize(ta - ro);
  vec3 u = normalize(cross(w, normalize(vec3(0, 1, 3))));
  vec3 rd = mat3(u, cross(u, w), w) * normalize(vec3(uv, 1.5));

  vec3 col = vec3(0.0);
  float maxd = 50.0;
  float t = march(ro, rd, 0.5, maxd);

  if(t < maxd){
    vec3 p = ro + rd * t;
    col = vec3(1);
    vec3 n = calcNormal(p);
    vec3 lightPos = vec3(1, 3, -2);
    vec3 li = lightPos - p;
    float len = length(li);
    li /= len;
    float dif = clamp(dot(n, li), 0.0, 1.0) * 0.86;
    float sha = calcShadow(lightPos, -li, len);
    col *= vec3(1, 0.6, 0.2) * max(sha * dif, 0.2);
    float rimd = pow(clamp(1.0 - dot(reflect(-li, n), -rd), 0.0, 1.0), 2.5);
    col *= (rimd + 2.2 * (1.0 - rimd)) * 0.8;
    col *= max(0.5 + 0.5 * n.y, 0.0);
    col *= exp2(-2.0 * pow(max(0.0, 1.0 - map(p + n * 0.3) / 0.3), 2.0));
    col += vec3(1, 0.6, 0.2) * pow(clamp(dot(reflect(rd, n), li), 0.0, 1.0), 20.0);
  }

  col += vec3(0.1, 0.3, 0.5) * g1 * 0.12 + vec3(1, 0.6, 0.2) * g2 * 0.1;
  col = pow(max(col, 0.0), vec3(2.5, 1.3, 0.8));

  // The original left alpha undefined; opaque here.
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

export const beacon: ShaderDef = {
  id: 'beacon',
  name: 'Beacon',
  description:
    'A flight past glowing halos on a folded lattice — a cage of blue light-tubes, tumbling boxes and warm halos you pass straight through.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'size',
      name: 'Object Size',
      description: 'Size of the tumbling boxes and wireframe frames. React swells them on the beat.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'halo',
      name: 'Halo Shape',
      description:
        'Which shape the halo takes. Level steps through five: 0 sphere, 0.4 rounded cube, 0.8 torus, 1.2 squircle, 1.6 octahedron. Assign a band to flip shape on a hit.',
      defaultBand: 'none',
      defaultAmount: 1.0,
      defaultLevel: 0.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'orbs',
      name: 'Halos',
      description: 'Size and glow of the halos. React swells them; hide to strip them out.',
      defaultBand: 'mid',
      defaultAmount: 1.0,
      defaultLevel: 0.3,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tubes',
      name: 'Light Tubes',
      description: 'The blue tube cage running through the lattice. Hide for halos alone.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'speed',
      name: 'Flight',
      description: 'Speed along the lattice. React surges the run.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
