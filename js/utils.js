// ------- Color packing helpers -------
export function packColor(r, g, b) {
    return (r << 16) | (g << 8) | b;
  }
  export function unpackColor(packed) {
    return {
      r: (packed >> 16) & 255,
      g: (packed >> 8) & 255,
      b: packed & 255,
    };
  }
  
  // ------- 2D buffer helper -------
  export function createBuffer(width, height, fillValue) {
    return Array.from({ length: height }, () => Array(width).fill(fillValue));
  }
  
  // ------- Minimal vec3 helpers (needed by camera.js & renderer) -------
  export function vec3(x = 0, y = 0, z = 0) { return { x, y, z }; }
  export function add(a, b)  { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
  export function sub(a, b)  { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
  export function scale(v, s){ return { x: v.x * s,   y: v.y * s,   z: v.z * s   }; }
  
  export function dot(a, b)  { return a.x*b.x + a.y*b.y + a.z*b.z; }
  export function cross(a, b){
    return {
      x: a.y*b.z - a.z*b.y,
      y: a.z*b.x - a.x*b.z,
      z: a.x*b.y - a.y*b.x
    };
  }
  export function length(v)  { return Math.hypot(v.x, v.y, v.z); }
  export function normalize(v) {
    const L = length(v) || 1;
    return { x: v.x / L, y: v.y / L, z: v.z / L };
  }
  
  // Interpolation / math utils commonly used in shaders & UI overlays
  export function lerp(a, b, t) { return a + (b - a) * t; }
  export const mix = lerp;              // alias, parity with GLSL
  export function clamp(x, min=0, max=1) { return Math.min(max, Math.max(min, x)); }
  export function saturate(x) { return clamp(x, 0, 1); }
  export function toRad(deg) { return deg * Math.PI / 180; }
  export function toDeg(rad) { return rad * 180 / Math.PI; }
  
  // Handy vec3 extras (non-allocating patterns kept simple)
  export function distance(a, b) { return length(sub(a, b)); }
  export function copyVec3(v) { return { x: v.x, y: v.y, z: v.z }; }
  export function equalsVec3(a, b, eps = 1e-6) {
    return Math.abs(a.x - b.x) <= eps &&
           Math.abs(a.y - b.y) <= eps &&
           Math.abs(a.z - b.z) <= eps;
  }
  