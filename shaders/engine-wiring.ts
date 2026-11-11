/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';
import RIG from './engine-cables.json';

/*
 * The Engine Room's wiring: cables strung between the deckhead and the pipes
 * (positions surveyed by tools/engine-cables.py), current pulsing along the
 * live ones, and the cut ends throwing sparks.
 */

// The reference's colours: greens, teal, cream, red, orange, pale blue.
const COLOURS = ['#2f7d4f', '#46b36c', '#5fc9b4', '#e4dcc0', '#b8322a', '#d9782a', '#9cc7dd'];

export interface Wiring {
  cables: THREE.Mesh;
  sparks: THREE.Points;
  lights: THREE.PointLight[];
  update(t: number, dt: number, o: { glow: number; pulse: number; pulseColour: THREE.Color; sparks: number; sparkColour: THREE.Color; burst: boolean; show: boolean }): void;
}

export function buildWiring(): Wiring {
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], along: number[] = [], seed: number[] = [];
  const index: number[] = [];
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  const tan = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3(), q = new THREE.Vector3();
  const RAD = 5;

  const tube = (pts: THREE.Vector3[], radius: number, colour: number, sd: number) => {
    c.set(COLOURS[colour % COLOURS.length]).convertSRGBToLinear();
    // A little variation, as real cable sheathing never quite matches.
    const k = 0.8 + 0.4 * ((sd * 7.31) % 1);
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      tan.subVectors(b, a).normalize();
      n1.crossVectors(tan, up);
      if (n1.lengthSq() < 1e-4) n1.set(1, 0, 0);
      n1.normalize();
      n2.crossVectors(tan, n1).normalize();
      for (let r = 0; r < RAD; r++) {
        const ang = (r / RAD) * Math.PI * 2;
        q.copy(n1).multiplyScalar(Math.cos(ang)).addScaledVector(n2, Math.sin(ang));
        pos.push(pts[i].x + q.x * radius, pts[i].y + q.y * radius, pts[i].z + q.z * radius);
        nrm.push(q.x, q.y, q.z);
        col.push(c.r * k, c.g * k, c.b * k);
        along.push(i / (pts.length - 1));
        seed.push(sd);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      for (let r = 0; r < RAD; r++) {
        const a = base + i * RAD + r, b = base + i * RAD + ((r + 1) % RAD);
        const d = a + RAD, e = b + RAD;
        index.push(a, d, b, b, d, e);
      }
    }
  };

  for (const k of RIG.cables as number[][]) {
    const [ax, ay, az, bx, by, bz, sag, radius, colour, sd] = k;
    const a = new THREE.Vector3(ax, ay, az), b = new THREE.Vector3(bx, by, bz);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      const p = a.clone().lerp(b, t);
      p.y -= sag * 4 * t * (1 - t);
      pts.push(p);
    }
    tube(pts, radius * 1.7, colour, sd);
  }
  const ends: THREE.Vector3[] = [];
  (RIG.dangling as number[][]).forEach((k, j) => {
    const [ax, ay, az, len, sway, radius, colour] = k;
    const dir = new THREE.Vector3(Math.cos(j * 2.4), 0, Math.sin(j * 2.4));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const s = i / 10;
      pts.push(new THREE.Vector3(ax, ay - len * s, az).addScaledVector(dir, sway * Math.sin(s * Math.PI * 0.5)));
    }
    tube(pts, radius * 1.7, colour, 0.999);
    ends.push(pts[pts.length - 1].clone());
  });

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('aAlong', new THREE.Float32BufferAttribute(along, 1));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seed, 1));
  geo.setIndex(index);

  // Current: bright packets running along the live cables (about a third).
  const pulse = { uPulseTime: { value: 0 }, uPulse: { value: 0 }, uPulseColor: { value: new THREE.Color() }, uGlow: { value: 0 } };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.05 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, pulse);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlong;\nattribute float aSeed;\nvarying float vAlong;\nvarying float vSeed;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlong = aAlong;\nvSeed = aSeed;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uPulseTime;\nuniform float uPulse;\nuniform vec3 uPulseColor;\nuniform float uGlow;\nvarying float vAlong;\nvarying float vSeed;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float live = step(vSeed, 0.35);
  float x = fract(vAlong * 1.5 - uPulseTime * (0.6 + vSeed * 1.4) - vSeed * 7.0);
  totalEmissiveRadiance += uPulseColor * live * uPulse * (exp(-x * 25.0) * 3.0 + 0.04);
  // Their own colour, faintly: the worklight catching the sheathing.
  totalEmissiveRadiance += vColor * uGlow;
}`,
      );
  };
  mat.customProgramCacheKey = () => 'engine-cables';
  const cables = new THREE.Mesh(geo, mat);
  cables.frustumCulled = false;

  // Sparks: a pool of particles, flung from the cut ends and falling.
  const MAX = 2400;
  const sp = new Float32Array(MAX * 3), vel = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX), span = new Float32Array(MAX);
  let next = 0;
  const sgeo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(sp, 3).setUsage(THREE.DynamicDrawUsage);
  const lifeAttr = new THREE.BufferAttribute(life, 1).setUsage(THREE.DynamicDrawUsage);
  sgeo.setAttribute('position', posAttr);
  sgeo.setAttribute('aLife', lifeAttr);
  const su = { uSparkColor: { value: new THREE.Color() }, uSize: { value: 5 } };
  const sparks = new THREE.Points(sgeo, new THREE.ShaderMaterial({
    uniforms: su,
    vertexShader: `
attribute float aLife;
uniform float uSize;
varying float vLife;
void main(){
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Sharp points: small, and capped however close the camera gets.
  gl_PointSize = aLife > 0.0 ? min(7.0, uSize * (0.35 + aLife) / max(-mv.z, 0.3)) : 0.0;
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `
uniform vec3 uSparkColor;
varying float vLife;
void main(){
  if(vLife <= 0.0) discard;
  float a = smoothstep(0.5, 0.15, length(gl_PointCoord - 0.5));
  // White hot when fresh, through the spark colour, to a dull orange as it dies.
  vec3 c = mix(mix(vec3(1.0, 0.45, 0.1), uSparkColor, smoothstep(0.1, 0.5, vLife)), vec3(1.0), smoothstep(0.7, 1.0, vLife));
  gl_FragColor = vec4(c * a * (0.3 + 3.0 * vLife), 1.0);
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  sparks.frustumCulled = false;

  const emit = (at: THREE.Vector3, n: number, power: number) => {
    for (let i = 0; i < n; i++) {
      const k = next;
      next = (next + 1) % MAX;
      sp[k * 3] = at.x; sp[k * 3 + 1] = at.y; sp[k * 3 + 2] = at.z;
      const a = Math.random() * Math.PI * 2;
      const s = (0.8 + Math.random() * 3.2) * power;
      vel[k * 3] = Math.cos(a) * s * 0.7;
      vel[k * 3 + 1] = (Math.random() * 1.6 - 0.4) * s;
      vel[k * 3 + 2] = Math.sin(a) * s * 0.7;
      span[k] = 0.25 + Math.random() * 0.7;
      life[k] = 1;
    }
  };

  // Each cut end arcs on its own clock; a burst flashes a light where it is.
  const lights = [0, 1, 2].map(() => new THREE.PointLight(0xffffff, 0, 6, 2));
  const flash = [0, 0, 0];
  let li = 0;
  const arcs = ends.map((_, i) => ({ next: Math.random() * 2, id: i }));
  const burstAt = (e: THREE.Vector3, n: number, power: number, fl: number) => {
    emit(e, n, power);
    lights[li].position.copy(e);
    flash[li] = Math.max(flash[li], fl);
    li = (li + 1) % lights.length;
  };

  return {
    cables, sparks, lights,
    update(t, dt, o) {
      cables.visible = o.show;
      pulse.uPulseTime.value = t;
      pulse.uPulse.value = o.show ? o.pulse : 0;
      pulse.uGlow.value = o.glow;
      pulse.uPulseColor.value.copy(o.pulseColour);
      su.uSparkColor.value.copy(o.sparkColour);

      if (o.show && o.sparks > 0.01) {
        for (const a of arcs) {
          if (t >= a.next) {
            // More signal, shorter gaps between sputters.
            a.next = t + (0.2 + Math.random() * 2.5) / (0.3 + o.sparks * 2);
            burstAt(ends[a.id], Math.round(6 + o.sparks * 30), 0.8, 0.5 * o.sparks);
          }
        }
        if (o.burst) {
          for (let k = 0; k < 3; k++) {
            const e = ends[Math.floor(Math.random() * ends.length)];
            burstAt(e, Math.round(40 + o.sparks * 80), 1.3, 1.2 * Math.min(1.5, o.sparks + 0.3));
          }
        }
      }
      for (let k = 0; k < MAX; k++) {
        if (life[k] <= 0) continue;
        vel[k * 3 + 1] -= 9.8 * dt;
        sp[k * 3] += vel[k * 3] * dt;
        sp[k * 3 + 1] += vel[k * 3 + 1] * dt;
        sp[k * 3 + 2] += vel[k * 3 + 2] * dt;
        life[k] -= dt / span[k];
        if (life[k] < 0) life[k] = 0;
      }
      posAttr.needsUpdate = true;
      lifeAttr.needsUpdate = true;
      lights.forEach((l, i) => {
        flash[i] *= Math.exp(-dt * 14);
        l.color.copy(o.sparkColour);
        l.intensity = flash[i] * 6 * (0.6 + 0.4 * Math.random());
      });
    },
  };
}
