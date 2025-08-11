// js/render/backends/raytrace_shader.js
// GLSL sources for the deterministic single-bounce ray tracer.
// Returns an object { vs, fs } matching the WebGL1 program builder.
//
// WebGL1 caveats handled:
//  - No dynamic indexing into uniform arrays: use helper fetchers with constant-loop indexing.

export function buildRaytraceSources(lims, maxMats, maxPL, maxDL) {
  const vs = `
attribute vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const fs = `
#ifdef GL_ES
precision highp float;
precision highp int;
#endif

#define MAX_SPHERES ${lims.MAX_SPHERES}
#define MAX_PLANES  ${lims.MAX_PLANES}
#define MAX_TRIS    ${lims.MAX_TRIS}
#define MAX_MATS    ${maxMats}
#define MAX_PL      ${maxPL}
#define MAX_DL      ${maxDL}

uniform vec3  iResolution;   // (w, h, 1)
uniform float uFovY;
uniform vec3  uCamPos;
uniform float uYaw;
uniform float uPitch;
uniform float uPixAspect;

// Geometry
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

// Materials (RT: mirror or diffuse)
uniform int   uNumMats;
uniform vec3  uMatAlbedo[MAX_MATS];
uniform int   uMatReflective[MAX_MATS]; // 1=mirror, 0=diffuse

// Lights
uniform int   uNumPL;
uniform vec3  uPLPos[MAX_PL];
uniform vec3  uPLCol[MAX_PL]; // intensity premultiplied

uniform int   uNumDL;
uniform vec3  uDLDir[MAX_DL]; // direction TOWARDS light (normalized)
uniform vec3  uDLCol[MAX_DL]; // intensity premultiplied

uniform vec3  uEnv; // environment color

const float EPS = 1e-4;
const float FAR = 1e6;

// Camera mapping identical to PT:
// look = vec3(cos(pitch)*cos(yaw), sin(pitch), cos(pitch)*sin(yaw))
vec3 camDir(float yaw, float pitch){
  float cp = cos(pitch), sp = sin(pitch);
  float cy = cos(yaw),   sy = sin(yaw);
  return normalize(vec3(cp*cy, sp, cp*sy));
}

// ---- uniform array fetchers (avoid dynamic indexing in WebGL1)
vec3 fetchMatAlbedo(int idx){
  vec3 v = vec3(0.8);
  for (int i=0;i<MAX_MATS;++i){ if (i==idx) v = uMatAlbedo[i]; }
  return v;
}
int fetchMatReflective(int idx){
  int v = 0;
  for (int i=0;i<MAX_MATS;++i){ if (i==idx) v = uMatReflective[i]; }
  return v;
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

float iTri(vec3 ro, vec3 rd, vec3 a, vec3 b, vec3 c, out vec3 n){
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

struct Hit { float t; int m; vec3 n; };

Hit intersect(vec3 ro, vec3 rd){
  Hit H; H.t = FAR; H.m = -1; H.n = vec3(0);
  // spheres
  for (int i=0;i<MAX_SPHERES;++i){
    if (i>=uNumS) break;
    float t = iSphere(ro, rd, uSpheres[i]);
    if (t>EPS && t<H.t){ H.t=t; H.m=uSm[i]; vec3 pos=ro+rd*t; H.n=nSphere(pos,uSpheres[i]); }
  }
  // planes
  for (int i=0;i<MAX_PLANES;++i){
    if (i>=uNumP) break;
    float t = iPlane(ro, rd, uPlanes[i]);
    if (t>EPS && t<H.t){ H.t=t; H.m=uPm[i]; H.n=uPlanes[i].xyz; }
  }
  // triangles
  for (int i=0;i<MAX_TRIS;++i){
    if (i>=uNumT) break;
    vec3 n; float t = iTri(ro, rd, uTa[i], uTb[i], uTc[i], n);
    if (t>EPS && t<H.t){ H.t=t; H.m=uTm[i]; H.n=n; }
  }
  return H;
}

bool occluded(vec3 ro, vec3 rd, float maxT){
  // spheres
  for (int i=0;i<MAX_SPHERES;++i){
    if (i>=uNumS) break;
    float t = iSphere(ro, rd, uSpheres[i]);
    if (t>EPS && t<maxT) return true;
  }
  // triangles (planes omitted for speed, like PT shadows)
  for (int i=0;i<MAX_TRIS;++i){
    if (i>=uNumT) break;
    vec3 dummy; float t = iTri(ro, rd, uTa[i], uTb[i], uTc[i], dummy);
    if (t>EPS && t<maxT) return true;
  }
  return false;
}

vec3 shadeDiffuse(vec3 pos, vec3 N, vec3 albedo){
  vec3 Lo = uEnv * max(N.y*0.0, 0.0);
  // Directional lights
  for (int i=0;i<MAX_DL;++i){
    if (i>=uNumDL) break;
    vec3 L = normalize(-uDLDir[i]); // uDLDir is towards the light
    float ndl = max(dot(N, L), 0.0);
    if (ndl > 0.0){
      bool occ = occluded(pos + N*EPS, L, 1e5);
      if (!occ) Lo += albedo * uDLCol[i] * ndl;
    }
  }
  // Point lights
  for (int i=0;i<MAX_PL;++i){
    if (i>=uNumPL) break;
    vec3 Lvec = uPLPos[i] - pos;
    float dist2 = max(dot(Lvec, Lvec), 1e-6);
    vec3  L = Lvec * inversesqrt(dist2);
    float ndl = max(dot(N, L), 0.0);
    if (ndl > 0.0){
      bool occ = occluded(pos + N*EPS, L, sqrt(dist2) - 2.0*EPS);
      if (!occ){
        float att = 1.0 / (1.0 + dist2*0.05); // mild attenuation
        Lo += albedo * uPLCol[i] * (ndl * att);
      }
    }
  }
  return Lo;
}

void main(){
  // NDC ray dir, respect pixel aspect like the path tracer
  vec2 p = -1.0 + 2.0 * (gl_FragCoord.xy / iResolution.xy);
  p.x *= (iResolution.x / iResolution.y) * max(uPixAspect, 1e-6);

  vec3 ww = camDir(uYaw, uPitch);
  vec3 uu = normalize(cross(ww, vec3(0,1,0)));
  if (length(uu) < 1e-3) uu = vec3(1,0,0);
  vec3 vv = normalize(cross(uu, ww));
  float focal = 1.0 / max(1e-6, tan(0.5*uFovY));

  vec3 ro = uCamPos;
  vec3 rd = normalize(p.x*uu + p.y*vv + focal*ww);

  // Primary hit
  Hit H = intersect(ro, rd);
  if (H.m < 0) { gl_FragColor = vec4(clamp(uEnv,0.0,1.0), 1.0); return; }

  vec3 hit = ro + rd*H.t;
  vec3 N   = normalize(H.n);
  int  mi  = int(clamp(float(H.m), 0.0, float(uNumMats-1)));
  vec3 albedo = fetchMatAlbedo(mi);
  bool refl   = (fetchMatReflective(mi) != 0);

  vec3 col;
  if (!refl){
    // Diffuse: direct lighting only
    col = shadeDiffuse(hit, N, albedo);
  } else {
    // Perfect reflection with a SINGLE deterministic bounce
    vec3 rdir = reflect(rd, N);
    Hit H2 = intersect(hit + N*EPS, rdir);
    if (H2.m < 0) {
      col = uEnv; // reflect to environment
    } else {
      vec3 hit2 = (hit + N*EPS) + rdir*H2.t;
      vec3 N2   = normalize(H2.n);
      int  m2   = int(clamp(float(H2.m), 0.0, float(uNumMats-1)));
      vec3 alb2 = fetchMatAlbedo(m2);
      col = shadeDiffuse(hit2, N2, alb2);
    }
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
  return { vs, fs };
}
