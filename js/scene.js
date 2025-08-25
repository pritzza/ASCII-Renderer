// js/scene.js
import { createSceneBuilder, MaterialIds } from './render/scene_api.js';

function addCube(sb, center, size, material = MaterialIds.WHITE) {
  const [cx, cy, cz] = center;
  const [sx, sy, sz] = Array.isArray(size) ? size : [size, size, size];
  const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
  const x0 = cx - hx, x1 = cx + hx;
  const y0 = cy - hy, y1 = cy + hy;
  const z0 = cz - hz, z1 = cz + hz;

  const v000 = [x0, y0, z0], v100 = [x1, y0, z0], v110 = [x1, y1, z0], v010 = [x0, y1, z0];
  const v001 = [x0, y0, z1], v101 = [x1, y0, z1], v111 = [x1, y1, z1], v011 = [x0, y1, z1];

  sb.addQuad(v001, v101, v111, v011, material); // +Z
  sb.addQuad(v100, v000, v010, v110, material); // -Z
  sb.addQuad(v101, v100, v110, v111, material); // +X
  sb.addQuad(v000, v001, v011, v010, material); // -X
  sb.addQuad(v010, v011, v111, v110, material); // +Y (top)
  sb.addQuad(v000, v100, v101, v001, material); // -Y (bottom)
  return sb;
}

export function createScene() {
  const sb = createSceneBuilder();

  // Camera pose (from your log)
  sb.setCameraPose([-2.023, 2.500, 7.376], { yaw: -1.0, pitch: -0.4 });

  // Ground (quad instead of infinite plane; PT-only geometry)
  const G = 20.0;
  const g00 = [-G, 0.0, -G], g10 = [ G, 0.0, -G], g11 = [ G, 0.0,  G], g01 = [-G, 0.0,  G];
  sb.addQuad(g00, g10, g11, g01, MaterialIds.WHITE);

  // Spheres
  sb.addSphere([-2.0, 1.0,  3.2], 1.0,  MaterialIds.WHITE);
  sb.addSphere([ 0.6, 0.75, 2.1], 0.75, MaterialIds.GLASS);
  sb.addSphere([ 2.4, 1.25, 4.2], 1.25, MaterialIds.RED);

  // Cubes
  addCube(sb, [-3.2, 0.50, 5.0],  1.0,               MaterialIds.WHITE);
  addCube(sb, [ 1.8, 0.60, 5.4], [1.2, 1.2, 1.2],    MaterialIds.GREEN);

  // Static emissives
  sb.addSphere([3.6, 0.5, 3.0], 0.30, MaterialIds.LIGHT);
  addCube(sb, [0.0, 0.25, 1.2], 0.50, MaterialIds.LIGHT);

  // Area light sphere (PT uses this for NEE)
  sb.setAreaLight([0.0, 4.5, 2.5], 0.75, { auto: false });

  // Optional: integer atlas size (only needed if you plan to texelFetch from it)
  // sb.setTextureAtlasSize(1024, 1024);

  return sb.toObject();
}
