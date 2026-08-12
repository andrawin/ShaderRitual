/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import type { ShaderDef } from '../types';

/*
 * "Vectors" — Xor's folded vector field: a volumetric lattice of glowing
 * filaments built by accumulating a rotating sine field along a ray.
 *
 * Adapted from Xor's Shadertoy original (audio-reactive edit by PAEz). The
 * original read three FFT ranges via texelFetch; here they map to the engine's
 * low / mid / high band uniforms. Ported to GLSL-ES 1.00 (no texelFetch, tanh
 * via a helper, constant loop bounds).
 *
 * Beyond the original's parameter nudges, the reactivity is structural: the
 * grid element can collapse the lattice into a smooth field, burst throws the
 * whole volume outward on a hit, and spin twists the field on the beat.
 *
 * Elements:
 *   flow  -> depth of the field (pulls the lattice toward the camera)
 *   grid  -> lattice density + spacing; hide for a smooth filament field
 *   glow  -> brightness / bloom of the filaments
 *   burst -> radial expansion + hue kick on a hit
 *   spin  -> rotation of the whole field
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
uniform float grid_react;
uniform float grid_visible;
uniform float glow_react;
uniform float burst_react;
uniform float spin_react;

float tanh1(float x){
  x = clamp(x, -8., 8.);
  float e = exp(2. * x);
  return (e - 1.) / (e + 1.);
}
mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  float low = clamp(flow_react, 0., 1.5);
  float high = clamp(grid_react, 0., 1.5);
  float bst = clamp(burst_react, 0., 1.5);

  // Audio-driven parameters (the original's mix() ranges).
  float DEPTH_OFFSET = mix(10.0, 5.0, min(low, 1.));
  float FREQUENCY_SCALAR = mix(1.0, 1.50, min(high, 1.));
  // Hiding the grid element locks the lattice terms flat -> smooth field.
  float GRID_SPACING = grid_visible > 0.5 ? mix(1.0, 2.0, min(high, 1.)) : 1.0;
  // Kept above zero when hidden: at exactly 0 the step length collapses and the
  // accumulator blows out instead of smoothing.
  float GRID_DENSITY = grid_visible > 0.5 ? mix(1.0, 3.0, min(high, 1.)) : 0.4;
  float GLOW = mix(1.0, 0.8, min(high, 1.));
  float DEPTH = mix(4.0, 0.0, min(high, 1.));
  float BRIGHT = mix(1.0, 0.8, min(high, 1.)) * (1.0 + glow_react * 1.2);

  vec2 resolution = iResolution.xy;
  vec3 pixelCoord = vec3(fragCoord, 0.0);
  float time = iTime;
  vec4 outputColor = vec4(0.0);

  float depth = DEPTH;

  // Camera rig: fov zooms the ray, burst throws the volume outward.
  float zoom = (60.0 / iCamFov) / max(iCamDist, 0.3);
  float expand = 1.0 + bst * 0.85;
  float twist = iCamOrbit * 0.35 + spin_react * 1.6;

  for(float iteration = 0.0; iteration < 70.0; iteration++){
    vec3 position = depth * normalize(pixelCoord.rgb * (2.0 * zoom) - resolution.xyy);
    position.xy *= rot(twist);
    position /= expand;

    vec3 animationVector = normalize(sin(time / 4.0 + vec3(0.0, 2.0, 4.0)));
    vec3 tempVector;

    position.z += DEPTH_OFFSET + iCamHeight * 3.0;
    tempVector = animationVector =
      dot(animationVector, position) * animationVector + cross(animationVector, position);

    // GLSL ES 1.00 requires the loop index to be declared in the init clause.
    for(float k = 2.0; k < 9.0; k++){
      animationVector += sin(ceil(animationVector * k * GRID_SPACING) * GLOW - time).yzx / k;
    }

    float sd = 0.10 * length(sin(animationVector * animationVector * FREQUENCY_SCALAR)) * GLOW
             * sqrt(length(tempVector * sin(tempVector.yzx * GRID_DENSITY)));
    sd = max(sd, 1e-3);
    depth += sd;
    outputColor += vec4(9.0, iteration, depth, 1.0) / sd * BRIGHT;
  }

  outputColor = outputColor / 60000.0;
  vec4 c = vec4(tanh1(outputColor.x), tanh1(outputColor.y), tanh1(outputColor.z), 1.0);

  // A hit warms the palette as well as expanding the field.
  c.rgb = mix(c.rgb, c.rgb * vec3(1.4, 0.75, 1.25), min(bst, 1.));
  fragColor = vec4(clamp(c.rgb, 0., 1.), 1.0);
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

export const vectors: ShaderDef = {
  id: 'vectors',
  name: 'Vectors',
  description:
    "Xor's folded vector field — a volumetric lattice of glowing filaments that expands and twists on the beat.",
  bufferShader,
  imageShader,
  elements: [
    {
      id: 'flow',
      name: 'Field Depth',
      description: 'Pulls the lattice toward the camera. React drives it on the bass.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'grid',
      name: 'Lattice',
      description: 'Grid density and spacing. Hide it to collapse into a smooth filament field.',
      defaultBand: 'high',
      defaultAmount: 1.0,
      canHide: true,
      defaultVisible: true,
    },
    {
      id: 'glow',
      name: 'Glow',
      description: 'Brightness of the filaments. React blooms them.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'burst',
      name: 'Burst',
      description: 'Throws the whole volume outward and warms the palette on a hit.',
      defaultBand: 'low',
      defaultAmount: 1.0,
      canHide: false,
      defaultVisible: true,
    },
    {
      id: 'spin',
      name: 'Twist',
      description: 'Rotates the field. React twists it on the beat.',
      defaultBand: 'mid',
      defaultAmount: 0.8,
      canHide: false,
      defaultVisible: true,
    },
  ],
};
