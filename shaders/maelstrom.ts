/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Maelstrom" — a log-polar vortex: every march step maps its position into
 * (log R, radial falloff, angle) space and subtracts a stack of doubling noise
 * octaves from it, so the same field repeats at every scale and the tunnel
 * appears to fall inward forever. Glow is accumulated along the ray rather
 * than shaded at a surface, which is why it reads as smoke rather than solid.
 *
 * Adapted from a fork of a Shadertoy golf. Two things about the original are
 * worth knowing, because they drove the port:
 *
 *   - it read q, p, e, R and s before ever writing them. Uninitialised locals
 *     happen to start at zero on most desktop drivers, which is why it looks
 *     right there; it is undefined behaviour, and on a different GPU it is
 *     noise or black. Every one is explicitly seeded here with the zero the
 *     original was relying on.
 *   - its palette line is clamp(..., 1., 1.), which is a constant vec3(1) —
 *     the fork threw the colour away and left the fixed amber that the
 *     1/vec3(27.6, 67.3, 184.6) divisor produces. That amber is the default
 *     here, and the Tint element dials the discarded banded palette back in.
 *
 * Ported to GLSL-ES 1.00: neither loop declared an index in its init clause
 * (the outer ran on i++ < 250. as its condition, the inner on s < 4e2 with
 * s += s as its step), which is the exact construct that silently fails to
 * compile here; both are counted loops now, the inner one with a constant cap
 * and an early break so the octave count stays adjustable. The pre-decrement
 * e = --p.y and the chained p = q += ... are spelled out, log() and the
 * division by R are floored, and atan(0, 0) is short-circuited so a centred
 * ray cannot punch a NaN through the frame.
 *
 * Elements:
 *   flow   -> how fast the tunnel falls inward
 *   detail -> number of noise octaves, 3..8; the main cost knob
 *   depth  -> march steps, 90..250; reach and brightness, the other cost knob
 *   swirl  -> how far the vanishing point wanders; hideable to centre it
 *   tint   -> 0 is the fork's amber, up dials in the original banded palette
 *   glow   -> overall exposure
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

uniform float flow_react;
uniform float detail_react;
uniform float depth_react;
uniform float swirl_react;
uniform float swirl_visible;
uniform float tint_react;
uniform float glow_react;

mat2 rot2(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;

  // The wandering vanishing point. At amp 1.0 this is the original; hiding
  // Swirl parks it dead centre.
  float amp = swirl_visible > 0.5 ? (0.5 + swirl_react * 0.6) : 0.0;
  vec2 ctr = vec2(0.5 + cos(iTime) * 0.4 * amp,
                  -0.1 - cos(iTime * 0.34) * 0.6 * amp);

  vec3 d = vec3((uv - ctr) * (iCamFov / 60.0) * max(iCamDist, 0.3), 0.4);
  d.xy *= rot2(iCamOrbit * 0.4);

  // The zeroes the original was reading out of uninitialised locals.
  vec3 q = vec3(0.0, -0.5, -0.5);
  q.y += iCamHeight * 0.3;
  vec3 p = vec3(0.0);
  vec3 acc = vec3(0.0);
  float e = 0.0;
  float R = 0.0;
  float s = 0.0;

  float speed = 0.2 + flow_react * 0.35;
  float oct = 3.0 + floor(clamp(detail_react, 0.0, 1.99) * 3.01);
  float steps = 90.0 + floor(clamp(depth_react, 0.0, 2.0) * 80.0);

  for(int i = 0; i < 250; i++){
    if(float(i) >= steps) break;

    // Accumulate with the previous step's e and s — the golf's ordering, and
    // what gives the glow its one-step smear.
    vec3 c = vec3(1.0);
    if(tint_react > 0.001){
      vec3 band = abs(mod(e * 38.3 + cos(iTime) + vec3(-12.0, -60.0, -20.0), -23.0) - 11.0);
      c = mix(c, clamp(band, 0.0, 1.0), clamp(tint_react, 0.0, 1.0));
    }
    acc += c * min(e * s, 1.0 - e) / vec3(27.6, 67.3, 184.6);

    s = 7.5;
    q += d * e * R * 0.5;
    p = q;
    R = max(length(p), 1e-4);

    // atan(0, 0) is undefined and would poison the rest of the march.
    float ang = (abs(p.x) + abs(p.y) < 1e-6) ? 0.0 : atan(p.x, p.y);
    p = vec3(log(R) - iTime * speed, exp(-p.z / R + 0.55), ang);

    p.y -= 1.0;
    e = p.y;

    for(int k = 0; k < 8; k++){
      if(float(k) >= oct) break;
      e -= abs(dot(cos(p.zxy * s) - sin(p.yzx), 0.3 - sin(p * s))) / s;
      s += s;
    }
  }

  acc *= 0.6 + glow_react * 0.9;
  fragColor = vec4(clamp(acc, 0.0, 1.0), 1.0);
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

export const maelstrom: ShaderDef = {
  id: 'maelstrom',
  name: 'Maelstrom',
  description:
    'A log-polar vortex of amber smoke — self-similar noise falling inward forever, accumulated as glow along the ray rather than shaded at a surface.',
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'flow',
      name: 'Flow',
      description: 'How fast the tunnel falls inward. React surges the drop.',
      defaultBand: 'low',
      defaultAmount: 0.8,
      defaultLevel: 0.4,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'detail',
      name: 'Detail',
      description:
        'Number of noise octaves, 3 to 8 across the level. Level 1.0 is the original 6. This is the main cost knob — drop it if the projector struggles.',
      defaultBand: 'high',
      defaultAmount: 0.3,
      defaultLevel: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'depth',
      name: 'Depth',
      description:
        'March steps, 90 to 250. Longer reach into the vortex and a brighter build-up, at proportional cost. Level 2.0 is the original 250.',
      defaultBand: 'mid',
      defaultAmount: 0.3,
      defaultLevel: 1.5,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'swirl',
      name: 'Swirl',
      description:
        'How far the vanishing point wanders off centre. Level 0.5 is the original throw; hide to lock it centred.',
      defaultBand: 'low',
      defaultAmount: 0.4,
      defaultLevel: 0.5,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'tint',
      name: 'Tint',
      description:
        'At 0, the fork\'s fixed amber. Raise it to dial in the banded palette the fork clamped away — react flashes colour through the smoke on a hit.',
      defaultBand: 'mid',
      defaultAmount: 0.5,
      defaultLevel: 0.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Overall exposure of the accumulated smoke.',
      defaultBand: 'low',
      defaultAmount: 0.5,
      defaultLevel: 0.45,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
