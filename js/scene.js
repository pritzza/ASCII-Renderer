// js/scene.js
import { createSceneBuilder, Materials } from './render/scene_api.js';

function addCube(sb, center, size, material = Materials.WHITE) {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = Array.isArray(size) ? size : [size, size, size];
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const x0 = cx - hx, x1 = cx + hx;
  const y0 = cy - hy, y1 = cy + hy;
  const z0 = cz - hz, z1 = cz + hz;
  const v000 = [x0, y0, z0], v100 = [x1, y0, z0], v110 = [x1, y1, z0], v010 = [x0, y1, z0];
  const v001 = [x0, y0, z1], v101 = [x1, y0, z1], v111 = [x1, y1, z1], v011 = [x0, y1, z1];
  sb.addQuad(v001, v101, v111, v011, material);
  sb.addQuad(v100, v000, v010, v110, material);
  sb.addQuad(v101, v100, v110, v111, material);
  sb.addQuad(v000, v001, v011, v010, material);
  sb.addQuad(v010, v011, v111, v110, material);
  sb.addQuad(v000, v100, v101, v001, material);
  return sb;
}

export function createScene() {
  const sb = createSceneBuilder();

  // Camera pose (NEW) — from your log:
  // pos=(-1.719, 0.499, 6.879), yaw=-1.025, pitch=-0.325
  sb.setCameraPose([-2.023, 2.500, 7.376], { yaw: -1., pitch: -0.4 });

  // Infinite ground
  sb.addPlane([0, 1, 0], 0.0, Materials.WHITE);

  // Spheres
  sb.addSphere([-2.0, 1.0,  3.2], 1.0,  Materials.WHITE);
  sb.addSphere([ 0.6, 0.75, 2.1], 0.75, Materials.GLASS);
  sb.addSphere([ 2.4, 1.25, 4.2], 1.25, Materials.RED);

  // Cubes
  addCube(sb, [-3.2, 0.50, 5.0],  1.0,               Materials.WHITE);
  addCube(sb, [ 1.8, 0.60, 5.4], [1.2, 1.2, 1.2],    Materials.GREEN);

  // Static emissives
  sb.addSphere([3.6, 0.5, 3.0], 0.30, Materials.LIGHT);
  addCube(sb, [0.0, 0.25, 1.2], 0.50, Materials.LIGHT);

  // Lights
  sb.setLight([0.0, 4.5, 2.5], 0.75, { auto: false });                  // area light
  sb.setEnvLight([0.20, 0.30, 0.50], 0.7);                              // sky env
  sb.setDirLight([0.25, -1.0, 0.15], [1.0, 0.95, 0.90], 1.8);           // sun

  return sb.toObject();
}
