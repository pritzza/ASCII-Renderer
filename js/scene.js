// js/scene.js
import { createSceneBuilder, MaterialIds } from './render/scene_api.js';

export function createScene() {
  const sb = createSceneBuilder();

  // ---------------- Camera ----------------
  const camPos = [0.0, 1.5, 6.0];
  sb.setCameraPose(camPos, { yaw: 0.0, pitch: 0.0 });

  // ---------------- Large White Cube (6 quads) ----------------
  const L = 8.0; // half-size
  const H = 16.0; // full cube height

  // floor
  sb.addQuad([-L, 0, -L], [ L, 0, -L], [ L, 0, L], [-L, 0, L], MaterialIds.WHITE);
  // ceiling
  sb.addQuad([-L, H, -L], [ L, H, -L], [ L, H, L], [-L, H, L], MaterialIds.WHITE);
  // back wall
  sb.addQuad([-L, 0, -L], [ L, 0, -L], [ L, H, -L], [-L, H, -L], MaterialIds.WHITE);
  // front wall
  sb.addQuad([-L, 0, L], [ L, 0, L], [ L, H, L], [-L, H, L], MaterialIds.WHITE);
  // left wall
  sb.addQuad([-L, 0, -L], [-L, 0, L], [-L, H, L], [-L, H, -L], MaterialIds.WHITE);
  // right wall
  sb.addQuad([ L, 0, -L], [ L, 0, L], [ L, H, L], [ L, H, -L], MaterialIds.WHITE);

  // ---------------- Poster Quad ----------------
  const texW = 26, texH = 24;
  const posterScale = 0.12;
  const posterW = texW * posterScale;
  const posterH = texH * posterScale * 2;

  const posterZ = camPos[2] - 3.0;
  const px = camPos[0];
  const py = camPos[1] + 1;

  const A = [px - posterW * 0.5, py - posterH * 0.5, posterZ];
  const B = [px + posterW * 0.5, py - posterH * 0.5, posterZ];
  const C = [px + posterW * 0.5, py + posterH * 0.5, posterZ];
  const D = [px - posterW * 0.5, py + posterH * 0.5, posterZ];

  const uvA = [0, 24];
  const uvB = [26, 24];
  const uvC = [26, 0];
  const uvD = [0, 0];

  sb.addQuad(A, B, C, D, MaterialIds.WHITE, uvA, uvB, uvC, uvD);

  // ---------------- Spheres ----------------
  sb.addSphere([-3.0, 1.2, camPos[2] - 2.0], 1.0, MaterialIds.GLASS); // glass sphere
  sb.addSphere([ 3.0, 1.2, camPos[2] - 2.5], 1.0, MaterialIds.RED);   // colored sphere

  // ---------------- Colored Lights ----------------
  const lightSize = 3;
  const cy = 6.0;

  function addLight(cx, cz, mat) {
    const A = [cx - lightSize, cy, cz - lightSize];
    const B = [cx + lightSize, cy, cz - lightSize];
    const C = [cx + lightSize, cy, cz + lightSize];
    const D = [cx - lightSize, cy, cz + lightSize];
    sb.addQuad(A, B, C, D, mat);
  }

  addLight(-4.0, camPos[2], MaterialIds.LIGHT_RED);
  addLight( 4.0, camPos[2], MaterialIds.LIGHT_BLUE);
  addLight( 0.0, camPos[2] - 5.0, MaterialIds.LIGHT_GREEN);
  addLight( 0.0, camPos[2] + 5.0, MaterialIds.LIGHT_YELLOW);

  return sb.toObject();
}
