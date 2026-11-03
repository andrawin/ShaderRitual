/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/*
 * Loads the GLBs behind scene shaders. The file is fetched once per URL and
 * the bytes kept, so a second layer showing the same scene parses its own
 * copy without going back to the network — each layer needs its own object
 * tree, because one THREE.Object3D cannot sit in two scenes at once.
 */

let loader: GLTFLoader | null = null;
function getLoader(): GLTFLoader {
  if (loader) return loader;
  loader = new GLTFLoader();
  const draco = new DRACOLoader();
  // Shipped with the app, not fetched from a CDN: a venue laptop is often offline.
  draco.setDecoderPath(new URL('draco/', document.baseURI).href);
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

const bytes = new Map<string, Promise<ArrayBuffer>>();

export function loadSceneGLB(url: string): Promise<THREE.Object3D> {
  let p = bytes.get(url);
  if (!p) {
    p = fetch(new URL(url, document.baseURI).href).then((r) => {
      if (!r.ok) throw new Error(`${r.status} fetching ${url}`);
      return r.arrayBuffer();
    });
    bytes.set(url, p);
    // A failed fetch should be retried next time, not remembered.
    p.catch(() => bytes.delete(url));
  }
  return p.then(
    (buf) =>
      new Promise<THREE.Object3D>((resolve, reject) => {
        getLoader().parse(buf, '', (gltf) => resolve(gltf.scene), reject);
      }),
  );
}
