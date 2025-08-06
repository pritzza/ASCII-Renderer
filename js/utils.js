// js/utils.js

export const vec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const add = (v1, v2) => vec3(v1.x + v2.x, v1.y + v2.y, v1.z + v2.z);
export const sub = (v1, v2) => vec3(v1.x - v2.x, v1.y - v2.y, v1.z - v2.z);
export const scale = (v, s) => vec3(v.x * s, v.y * s, v.z * s);
export const dot = (v1, v2) => v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
export const cross = (v1, v2) => vec3(v1.y * v2.z - v1.z * v2.y, v1.z * v2.x - v1.x * v2.z, v1.x * v2.y - v1.y * v2.x);
export const normalize = (v) => { const l = Math.sqrt(dot(v, v)); return l > 0 ? scale(v, 1 / l) : vec3(0, 0, 0); };
export const lerp = (v1, v2, t) => add(scale(v1, 1 - t), scale(v2, t));

export function transformPoint(p, m) { return vec3( p.x * m[0] + p.y * m[3] + p.z * m[6], p.x * m[1] + p.y * m[4] + p.z * m[7], p.x * m[2] + p.y * m[5] + p.z * m[8] ); }
export function rotationMatrixY(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [c, 0, s, 0, 1, 0, -s, 0, c]; }
export function rotationMatrixX(angle) { const c = Math.cos(angle), s = Math.sin(angle); return [1, 0, 0, 0, c, -s, 0, s, c]; }

/**
 * Packs an RGB color into a single 32-bit integer.
 */
export function packColor(r, g, b) {
    return (r << 16) | (g << 8) | b;
}

/**
 * Unpacks a 32-bit integer back into an RGB color object.
 */
export function unpackColor(packed) {
    return {
        r: (packed >> 16) & 255,
        g: (packed >> 8) & 255,
        b: packed & 255,
    };
}

/**
 * Creates a 2D array buffer of a given size, filled with a value.
 */
export function createBuffer(width, height, fillValue) {
    return Array.from({ length: height }, () => Array(width).fill(fillValue));
}