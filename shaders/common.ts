/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full-screen-quad vertex shader shared by every pass. Used with a 2x2
 * PlaneGeometry so `position.xy` already spans clip space [-1, 1].
 */
export const commonVertex = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * GLSL ES 3.00 variant of {@link commonVertex} for shaders that need WebGL2
 * features (uint/bit ops, `texture()`, dynamic-ish loops). Used with
 * `glslVersion: THREE.GLSL3`; Three prepends the `#version 300 es` directive.
 */
export const commonVertex3 = `
precision highp float;
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
