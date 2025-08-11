// Shared GLSL chunks used by BOTH PT and RT.
// This file intentionally contains no backend-specific logic.
// Everything here is "pure" or "common declarations".
// ------------------------------------------------------------------------------------

// 1) Shared camera/time uniforms (identical in PT/RT)
export const TRACING_SHARED_UNIFORMS_GLSL = `
uniform vec3  iResolution;   // (width, height, 1)
uniform float iTime;         // seconds
uniform vec4  iMouse;        // ABI / optional

// Camera (identical)
uniform vec3  uCamPos;
uniform float uYaw;
uniform float uPitch;
uniform float uFovY;
uniform float uGamma;        // ABI (PT uses 0 weight)
uniform float uPixAspect;    // extra pixel aspect multiplier (1.0 default)
`;

// 2) Defines + Scene Uniform Declarations (identical in PT/RT)
// Build-time function so you can pass the MAX_* counts from JS.
export function buildSceneDecls({ MAX_SPHERES, MAX_PLANES, MAX_TRIS, MAX_MATS, MAX_PL, MAX_DL }) {
  return `
// ---- common scene defines ----
#define MAX_SPHERES ${MAX_SPHERES}
#define MAX_PLANES  ${MAX_PLANES}
#define MAX_TRIS    ${MAX_TRIS}
#define MAX_MATS    ${MAX_MATS}
#define MAX_PL      ${MAX_PL}
#define MAX_DL      ${MAX_DL}

// ---- geometry (shared) ----
uniform int   uNumS;
uniform vec4  uSpheres[MAX_SPHERES]; // xyz=center, w=radius
uniform int   uSm[MAX_SPHERES];      // material index

uniform int   uNumP;
uniform vec4  uPlanes[MAX_PLANES];   // xyz=normal (unit), w=d
uniform int   uPm[MAX_PLANES];

uniform int   uNumT;
uniform vec3  uTa[MAX_TRIS];
uniform vec3  uTb[MAX_TRIS];
uniform vec3  uTc[MAX_TRIS];
uniform int   uTm[MAX_TRIS];

// ---- materials (shared) ----
uniform int   uNumMats;
uniform vec3  uMatAlbedo[MAX_MATS];
uniform int   uMatReflective[MAX_MATS]; // 1 = mirror/specular, 0 = diffuse

// ---- lights (shared) ----
uniform int   uNumPL;
uniform vec3  uPLPos[MAX_PL]; // point light pos
uniform vec3  uPLCol[MAX_PL]; // premultiplied intensity

uniform int   uNumDL;
uniform vec3  uDLDir[MAX_DL]; // direction TOWARDS light (normalized)
uniform vec3  uDLCol[MAX_DL]; // premultiplied intensity

// ---- environment (shared) ----
uniform vec3  uEnv;           // environment color

const float FAR = 1e6;
`;
}

// 3) Shared pure helpers (RNG, camera, environment, intersections)
export const TRACING_COMMON_GLSL = `
#ifndef EPS
#define EPS 1e-4
#endif
#ifndef eps
#define eps 1e-3
#endif

// RNG
float hash1(inout float seed){ return fract(sin(seed += 0.1)*43758.5453123); }
vec2  hash2(inout float seed){ return fract(sin(vec2(seed+=0.1,seed+=0.1))*vec2(43758.5453123,22578.1459123)); }

// Camera mapping (identical across renderers)
vec3 yawPitchToDir(float yaw, float pitch){
  float cp = cos(pitch), sp = sin(pitch);
  float cy = cos(yaw),   sy = sin(yaw);
  return normalize(vec3(cp*cy, sp, cp*sy));
}
void camBasis(out vec3 ww, out vec3 uu, out vec3 vv, float yaw, float pitch){
  ww = yawPitchToDir(yaw, pitch);
  uu = normalize(cross(ww, vec3(0.0,1.0,0.0)));
  if (length(uu) < 1e-3) uu = vec3(1.0,0.0,0.0);
  vv = normalize(cross(uu, ww));
}

// Environment
vec3 environment(vec3 rd){
  float t = clamp(rd.y*0.5+0.5, 0.0, 1.0);
  vec3 sky  = mix(vec3(0.90,0.95,1.00), vec3(0.45,0.65,0.95), pow(t,1.2));
  vec3 grd  = vec3(0.18,0.15,0.12);
  return mix(grd*0.35, sky, smoothstep(-0.05, 0.05, rd.y));
}

// Intersections
float iSphere(vec3 ro, vec3 rd, vec4 sph){
  vec3 oc = ro - sph.xyz;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - sph.w*sph.w;
  float h = b*b - c;
  if (h < 0.0) return -1.0;
  float s  = sqrt(h);
  float t1 = -b - s;
  float t2 = -b + s;
  if (t1 > EPS) return t1;
  if (t2 > EPS) return t2;
  return -1.0;
}
vec3 nSphere(vec3 p, vec4 sph){ return (p - sph.xyz)/max(sph.w, 1e-6); }

float iPlane(vec3 ro, vec3 rd, vec4 pl){
  float denom = dot(pl.xyz, rd);
  if (abs(denom) < 1e-6) return -1.0;
  float t = (-pl.w - dot(pl.xyz, ro)) / denom;
  return (t > EPS) ? t : -1.0;
}

// Möller–Trumbore
float iTriangle(vec3 ro, vec3 rd, vec3 a, vec3 b, vec3 c, out vec3 n){
  vec3 e1 = b - a, e2 = c - a;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-6) { n=vec3(0); return -1.0; }
  float invDet = 1.0/det;
  vec3 t = ro - a;
  float u = dot(t, p) * invDet; if (u < 0.0 || u > 1.0) { n=vec3(0); return -1.0; }
  vec3 q = cross(t, e1);
  float v = dot(rd, q) * invDet; if (v < 0.0 || u + v > 1.0) { n=vec3(0); return -1.0; }
  float tt = dot(e2, q) * invDet; if (tt <= EPS) { n=vec3(0); return -1.0; }
  n = normalize(cross(e1, e2));
  if (dot(n, rd) > 0.0) n = -n;
  return tt;
}
// Alias for legacy name
float iTri(vec3 ro, vec3 rd, vec3 a, vec3 b, vec3 c, out vec3 n){
  return iTriangle(ro, rd, a, b, c, n);
}
`;

// 4) Material fetchers (constant-loop, WebGL1-safe) — shared by both now
export const TRACING_MATERIAL_FETCHERS_GLSL = `
vec3 fetchMatAlbedo(int idx){
  vec3 v = vec3(0.8);
  for (int i=0; i<MAX_MATS; ++i) { if (i == idx) v = uMatAlbedo[i]; }
  return v;
}
int fetchMatReflective(int idx){
  int v = 0;
  for (int i=0; i<MAX_MATS; ++i) { if (i == idx) v = uMatReflective[i]; }
  return v;
}
`;