/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';
import {
  LINEWORK_PALETTES, lineworkElements, lineworkImage, lineworkLib, lineworkUniforms,
} from './linework';

/*
 * LINEWORK — Weave. String art: straight lines strung between two curves in
 * space, so the surface they describe exists only as its rulings. An hourglass
 * pulled through itself, a twisted sheet, a curling band, and a fan gathered
 * to a point.
 *
 * Line k joins A(s) to B(s) at s = k/(n-1). Both curves live in 3D and are
 * projected through the shared orbit camera, so the twist turns as the camera
 * does — the curves you see bend in the gaps between the lines are envelopes,
 * not anything drawn.
 */

const FORMS = ['Hourglass', 'Twist', 'Band', 'Fan'];

const bufferShader = `
${lineworkUniforms}
uniform float twist_react;
${lineworkLib}

int gForm = 0;
float gAmp = 0.5;
float gTw = 1.0;

void endsWv(float s, float t, out vec3 A, out vec3 B){
  if(gForm == 0){
    // Top edge to the bottom edge run backwards: every line crosses the waist.
    float d = 0.35 * gAmp * sin(PI * s + t * 0.5);
    A = vec3(-1.1 + 2.2 * s, 0.75, d);
    B = vec3(1.1 - 2.2 * mix(s, s * s * (3.0 - 2.0 * s), 0.5 * gTw), -0.75, -d);
  } else if(gForm == 1){
    // A hyperbolic paraboloid: two skew edges, joined.
    float lift = 0.7 * gTw;
    A = mix(vec3(-1.0, -lift, -0.7), vec3(1.0, lift, -0.7), s);
    B = mix(vec3(-1.0, lift, 0.7), vec3(1.0, -lift, 0.7), s);
    A.y += 0.15 * gAmp * sin(s * TAU + t);
    B.y -= 0.15 * gAmp * sin(s * TAU + t * 0.8);
  } else if(gForm == 2){
    // A band curling round an axis, its two edges turned against each other.
    float th = s * PI * 1.3 + t * 0.15;
    float ph = 0.9 * gTw;
    A = vec3(cos(th), -0.55 + 0.25 * gAmp * sin(2.0 * th + t * 0.5), sin(th)) * vec3(1.0, 1.0, 0.8);
    B = vec3(cos(th + ph), 0.55 + 0.25 * gAmp * sin(2.0 * th + 1.0 + t * 0.4), sin(th + ph)) * vec3(0.85, 1.0, 0.7);
  } else {
    // A fan: one end gathered almost to a point, the other strung along a wave.
    A = vec3(-1.05, -0.15 + 0.12 * s, 0.0);
    B = vec3(0.95, -0.85 + 1.7 * s, 0.6 * gTw * sin(PI * s * 2.0 + t * 0.6));
    B.x += 0.15 * gAmp * sin(s * 7.0 + t);
  }
}

void main(){
  vec2 uv = uvLw();
  float px = pxLw();
  float t = iTime;
  float kick = beatLw();
  gForm = formLw(4.0);
  gAmp = 0.35 + clamp(swell_react, 0.0, 2.5) * 0.55 + kick * 0.2;
  gTw = 0.4 + clamp(twist_react, 0.0, 2.0) * 0.6;
  float n = floor(30.0 + clamp(density_react, 0.0, 2.5) * 28.0);

  vec3 ro, rd;
  vec3 target = vec3(0.0);
  cameraLw(uv, target, 2.75, 0.2, ro, rd);
  // The projection basis is the same for every line and every pixel, so it is
  // built once here rather than inside the loop, which was most of the cost.
  vec3 cfw = normalize(target - ro);
  vec3 crt = normalize(cross(cfw, vec3(0.0, 1.0, 0.0)));
  vec3 cup = cross(crt, cfw);
  float foc = 0.5 / tan(radians(clamp(iCamFov, 20.0, 110.0) * 0.5));
  // The sheet and the band are turned to three-quarters, or the twist is seen
  // edge-on and reads as two flat triangles.
  float ry = (gForm == 1 || gForm == 2) ? 0.75 : 0.0;
  float rx = (gForm == 1) ? 0.35 : 0.0;
  mat3 turn = mat3(cos(ry), 0.0, -sin(ry), 0.0, 1.0, 0.0, sin(ry), 0.0, cos(ry))
            * mat3(1.0, 0.0, 0.0, 0.0, cos(rx), sin(rx), 0.0, -sin(rx), cos(rx));

  vec3 ink = inkLw();
  vec3 acc = accentLw();
  vec3 col = paperLw();

  for(int i = 0; i < 96; i++){
    float fi = float(i);
    if(fi >= n) break;
    float s = fi / max(n - 1.0, 1.0);
    vec3 A, B;
    endsWv(s, t, A, B);
    vec3 qa = turn * A - ro, qb = turn * B - ro;
    float za = dot(qa, cfw), zb = dot(qb, cfw);
    vec3 a = vec3(vec2(dot(qa, crt), dot(qa, cup)) * foc / max(za, 1e-3), za);
    vec3 b = vec3(vec2(dot(qb, crt), dot(qb, cup)) * foc / max(zb, 1e-3), zb);
    vec2 pa = uv - a.xy, ba = b.xy - a.xy;
    float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    float dpx = length(pa - ba * h) / px;
    float c = strokeLw(dpx, 0.42);
    // Further along the view, a little dimmer — depth without shading.
    float z = mix(a.z, b.z, h);
    float dim = mix(1.0, 0.55, smoothstep(2.0, 3.8, z));
    col = mix(col, mix(ink, acc, s * 0.8) * dim, c * 0.85);
  }

  fragColor = vec4(clamp(finishLw(col, uv), 0.0, 1.0), 1.0);
}
`;

export const lwWeave: ShaderDef = {
  id: 'lw_weave',
  name: 'Linework — Weave',
  description:
    'String art in space: straight lines strung between two curves — an hourglass, a twisted sheet, a curling band, a fan.',
  glsl3: true,
  bufferShader,
  imageShader: lineworkImage,
  palettes: LINEWORK_PALETTES,
  elements: lineworkElements(
    FORMS,
    'The weave: an hourglass pulled through itself, a twisted sheet, a band curling round an axis, or a fan gathered to a point.',
    {
      id: 'twist',
      name: 'Twist',
      description: 'How far the two ends turn against each other.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ),
};
