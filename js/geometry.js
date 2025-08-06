// js/geometry.js
import { sub, dot, cross } from './utils.js';
import { config } from './config.js';

/**
 * Intersection functions for ray tracing.
 */
export function intersectSphere(ro, rd, sc, sr) {
    const oc = sub(ro, sc);
    const a = dot(rd, rd);
    const b = 2.0 * dot(oc, rd);
    const c = dot(oc, oc) - sr * sr;
    const d = b * b - 4 * a * c;
    if (d < 0) return -1.0;
    const t1 = (-b - Math.sqrt(d)) / (2.0 * a);
    if (t1 > config.EPSILON) return t1;
    const t2 = (-b + Math.sqrt(d)) / (2.0 * a);
    if (t2 > config.EPSILON) return t2;
    return -1.0;
}

export function intersectTriangle(ro, rd, v0, v1, v2) {
    const edge1 = sub(v1, v0);
    const edge2 = sub(v2, v0);
    const h = cross(rd, edge2);
    const a = dot(edge1, h);
    if (a > -config.EPSILON && a < config.EPSILON) return -1.0;
    const f = 1.0 / a;
    const s = sub(ro, v0);
    const u = f * dot(s, h);
    if (u < 0.0 || u > 1.0) return -1.0;
    const q = cross(s, edge1);
    const v = f * dot(rd, q);
    if (v < 0.0 || u + v > 1.0) return -1.0;
    const t = f * dot(edge2, q);
    if (t > config.EPSILON) return t;
    return -1.0;
}