// js/render/backends/pathtrace_shader.js
// Stable, scene-driven path tracer (spheres/planes/tris + light).
// Output is linear (no gamma). uGamma kept for ABI (0-weight referenced).

export function buildTracerSources(PT) {
  const LIGHT   = (PT?.LIGHT_COLOR ?? [16.86, 10.76, 8.2]).map(Number);
  const SAMPLES = Math.max(1, (PT?.SAMPLES_PER_BATCH | 0) || 12);
  const BOUNCES = Math.max(1, (PT?.MAX_BOUNCES       | 0) || 4);
  const PIXASP  = Number(PT?.PIXEL_ASPECT ?? 1.0);
  const LIM     = PT?.LIMITS ?? {};
  const MAXS    = (LIM.MAX_SPHERES ?? 32) | 0;
  const MAXP    = (LIM.MAX_PLANES  ?? 16) | 0;
  const MAXT    = (LIM.MAX_TRIS    ?? 64) | 0;

  const defines = `
#define SAMPLES        ${SAMPLES}
#define EYEPATHLENGTH  ${BOUNCES}
#define PIXEL_ASPECT   ${(isFinite(PIXASP) && PIXASP > 0) ? PIXASP.toFixed(6) : '1.0'}

#define MAX_SPHERES ${MAXS}
#define MAX_PLANES  ${MAXP}
#define MAX_TRIS    ${MAXT}

${(PT?.ANIMATE_NOISE ?? true) ? '#define ANIMATENOISE' : ''}
${(PT?.DIRECT_LIGHT_SAMPLING ?? true) ? '#define DIRECT_LIGHT_SAMPLING' : ''}

#define LIGHTCOLOR  vec3(${LIGHT[0].toFixed(4)}, ${LIGHT[1].toFixed(4)}, ${LIGHT[2].toFixed(4)})*1.3
#define WHITECOLOR  vec3(0.7295, 0.7355, 0.7290)*0.7
#define GREENCOLOR  vec3(0.1170, 0.4125, 0.1150)*0.7
#define REDCOLOR    vec3(0.6110, 0.0555, 0.0620)*0.7
`;

  const vs = `
attribute vec2 aPosition;
void main(){ gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

  const fs = `
// --- BEGIN PT FRAGMENT SHADER ---
#ifdef GL_ES
precision highp float;
precision highp int;
#endif

uniform vec3  iResolution;
uniform float iTime;
uniform vec4  iMouse;

uniform vec3  uCamPos;
uniform float uYaw;
uniform float uPitch;
uniform float uFovY;
uniform float uGamma; // ABI only; referenced with 0 weight

// ***** SCENE UNIFORMS (RESTORED) *****
uniform int   uNumSpheres;
uniform vec4  uSpheres[MAX_SPHERES];  // xyz=ctr, w=radius
uniform float uSphereM[MAX_SPHERES];

uniform int   uNumPlanes;
uniform vec4  uPlanes[MAX_PLANES];    // xyz=normal (unit), w=d
uniform float uPlaneM[MAX_PLANES];

uniform int   uNumTris;
uniform vec3  uTriA[MAX_TRIS];
uniform vec3  uTriB[MAX_TRIS];
uniform vec3  uTriC[MAX_TRIS];
uniform float uTriM[MAX_TRIS];
// *************************************

// Light (animated or fixed)
uniform vec3  uLightCenter;
uniform float uLightRadius;
uniform float uLightAuto;

#define eps 1e-3

// RNG
float hash1(inout float seed){ return fract(sin(seed += 0.1)*43758.5453123); }
vec2  hash2(inout float seed){ return fract(sin(vec2(seed+=0.1,seed+=0.1))*vec2(43758.5453123,22578.1459123)); }

// Environment: sky/ground gradient
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
  if (t1 > eps) return t1;
  if (t2 > eps) return t2;
  return -1.0;
}
vec3 nSphere(vec3 pos, vec4 sph){ return (pos - sph.xyz)/max(sph.w, 1e-6); }

float iPlane(vec3 ro, vec3 rd, vec4 pla){
  float denom = dot(pla.xyz, rd);
  if (abs(denom) < 1e-6) return -1.0;
  float t = (-pla.w - dot(pla.xyz, ro)) / denom;
  return (t > eps) ? t : -1.0;
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
  float tt = dot(e2, q) * invDet; if (tt <= eps) { n=vec3(0); return -1.0; }
  n = normalize(cross(e1, e2));
  if (dot(n, rd) > 0.0) n = -n;
  return tt;
}

// Materials
vec3 matColor(float m){
  vec3 albedo = vec3(0.,0.95,0.);
  if (m < 3.5) albedo = REDCOLOR;
  if (m < 2.5) albedo = GREENCOLOR;
  if (m < 1.5) albedo = WHITECOLOR;
  if (m < 0.5) albedo = LIGHTCOLOR; // emissive marker
  return albedo;
}
bool matIsSpecular(float m){ return m > 4.5; }
bool matIsLight(float m){ return m < 0.5; }

// Light sphere
vec4 getLightSphere(float time){
  if (uLightAuto > 0.5) {
    return vec4(
      3.0 + 2.0*sin(time),
      2.8 + 2.0*sin(time*0.9),
      3.0 + 4.0*cos(time*0.7),
      uLightRadius
    );
  }
  return vec4(uLightCenter, uLightRadius);
}

// Sampling
vec3 cosWeightedHemisphere(const vec3 n, inout float seed){
  vec2 r = hash2(seed);
  float phi = 6.28318530718 * r.x;
  float r2  = r.y;
  float s2  = sqrt(1.0 - r2);
  vec3 uu = normalize( abs(n.y) < 0.999 ? cross(n, vec3(0,1,0)) : cross(n, vec3(1,0,0)) );
  vec3 vv = cross(uu, n);
  return normalize(s2*cos(phi)*uu + s2*sin(phi)*vv + sqrt(r2)*n);
}
vec3 sampleLight(in vec3 ro, inout float seed, vec4 light){
  vec2 h = hash2(seed) * vec2(2., 6.28318530718) - vec2(1., 0.);
  float phi = h.y;
  vec3 n = vec3(sqrt(1.-h.x*h.x)*vec2(sin(phi),cos(phi)), h.x);
  return light.xyz + light.w * n;
}

// Scene intersection
vec2 intersect(in vec3 ro, in vec3 rd, out vec3 normal, vec4 lightSphere){
  vec2 res = vec2(1e20, -1.0);
  float t; vec3 n;

  for (int i=0; i<MAX_SPHERES; ++i){
    if (i>=uNumSpheres) break;
    t = iSphere(ro, rd, uSpheres[i]);
    if (t>eps && t<res.x) { res=vec2(t, uSphereM[i]); normal = nSphere(ro+t*rd, uSpheres[i]); }
  }
  for (int i=0; i<MAX_PLANES; ++i){
    if (i>=uNumPlanes) break;
    t = iPlane(ro, rd, uPlanes[i]);
    if (t>eps && t<res.x) { res=vec2(t, uPlaneM[i]); normal = uPlanes[i].xyz; }
  }
  for (int i=0; i<MAX_TRIS; ++i){
    if (i>=uNumTris) break;
    vec3 nt; t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], nt);
    if (t>eps && t<res.x) { res=vec2(t, uTriM[i]); normal = nt; }
  }

  // Light as geometry
  t = iSphere(ro, rd, lightSphere);
  if (t>eps && t<res.x) { res=vec2(t, 0.0); normal = (ro+t*rd - lightSphere.xyz)/max(lightSphere.w,1.0e-6); }

  return res;
}

bool intersectShadow(in vec3 ro, in vec3 rd, in float dist){
  float t; vec3 n;
  for (int i=0; i<MAX_SPHERES; ++i){ if (i>=uNumSpheres) break; t = iSphere(ro, rd, uSpheres[i]); if (t>eps && t<dist) return true; }
  // planes omitted for speed
  for (int i=0; i<MAX_TRIS; ++i){ if (i>=uNumTris) break; t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], n); if (t>eps && t<dist) return true; }
  return false;
}

// BRDF (diffuse + dielectric w/ Fresnel + TIR)
vec3 nextDirection(vec3 n, const vec3 rd, float m, inout bool specularBounce, inout float seed){
  specularBounce = false;
  if (!matIsSpecular(m)) return cosWeightedHemisphere(n, seed);
  specularBounce = true;

  float n1, n2, ndotr = dot(rd, n);
  if (ndotr > 0.0) { n1=1.0; n2=1.5; n = -n; } else { n1=1.5; n2=1.0; }
  float r0 = (n1-n2)/(n1+n2); r0 *= r0;
  float fres = r0 + (1.0 - r0) * pow(1.0 - abs(ndotr), 5.0);

  vec3 ref = refract(rd, n, n2/n1);
  if (length(ref) < 1e-5 || hash1(seed) < fres) ref = reflect(rd, n);
  return normalize(ref);
}

// Path tracer (with environment on miss)
vec3 traceEyePath(in vec3 ro, in vec3 rd, bool useDLS, inout float seed, vec4 lightSphere){
  vec3 Lo = vec3(0.0);
  vec3 T  = vec3(1.0);
  bool specularBounce = true;

  for (int j=0; j<EYEPATHLENGTH; ++j) {
    vec3 n;
    vec2 res = intersect(ro, rd, n, lightSphere);
    float t   = res.x;
    float mat = res.y;

    if (mat < -0.5) { Lo += T * environment(rd); break; }

    vec3 hit = ro + t * rd;

    if (matIsLight(mat)) {
#ifdef DIRECT_LIGHT_SAMPLING
      if (useDLS) { if (specularBounce) Lo += T * LIGHTCOLOR; }
      else        { Lo += T * LIGHTCOLOR; }
#else
      Lo += T * LIGHTCOLOR;
#endif
      break;
    }

    vec3 ndir = nextDirection(n, rd, mat, specularBounce, seed);
    if (!specularBounce || dot(ndir, n) < 0.0) T *= matColor(mat);

#ifdef DIRECT_LIGHT_SAMPLING
    if (useDLS && !specularBounce && j < EYEPATHLENGTH-1) {
      vec3  Lpos = sampleLight(hit, seed, lightSphere);
      vec3  Ldir = normalize(Lpos - hit);
      float dist = length(Lpos - hit);
      if (!intersectShadow(hit + n*eps, Ldir, dist)) {
        float cos_a_max = sqrt(1.0 - clamp(lightSphere.w*lightSphere.w /
                          dot(lightSphere.xyz - hit, lightSphere.xyz - hit), 0.0, 1.0));
        float weight = 2.0 * (1.0 - cos_a_max);
        Lo += T * LIGHTCOLOR * (weight * max(dot(Ldir, n), 0.0));
      }
    }
#endif

    rd = ndir;
    float side = (dot(rd, n) > 0.0) ? 1.0 : -1.0;
    ro = hit + n * side * eps;

    if (j >= 2) {
      float p = clamp(max(T.r, max(T.g, T.b)), 0.05, 0.95);
      if (hash1(seed) > p) break;
      T /= p;
    }
  }
  return Lo;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 p = -1.0 + 2.0 * fragCoord.xy / iResolution.xy;
  float aspect = (iResolution.x / iResolution.y) * PIXEL_ASPECT;
  p.x *= aspect;

#ifdef DIRECT_LIGHT_SAMPLING
  const bool DLS = true;
#else
  const bool DLS = false;
#endif

#ifdef ANIMATENOISE
  float seed = p.x + p.y * 3.43121412313 + fract(1.12345314312 * iTime);
#else
  float seed = p.x + p.y * 3.43121412313;
#endif

  // Camera
  vec3 look = vec3(cos(uPitch)*cos(uYaw), sin(uPitch), cos(uPitch)*sin(uYaw));
  vec3 ww   = normalize(look);
  vec3 uu   = normalize(cross(ww, vec3(0.0,1.0,0.0)));
  if (length(uu) < 1e-3) uu = vec3(1.0,0.0,0.0);
  vec3 vv   = normalize(cross(uu, ww));
  vec3 ro   = uCamPos;
  float focal = 1.0 / max(1e-6, tan(0.5 * uFovY));

  vec4 lSphere = getLightSphere(iTime);

  vec3 tot = vec3(0.0);
  for (int a=0; a<SAMPLES; ++a) {
    vec2 rpof = 2.0 * (hash2(seed) - vec2(0.5)) / iResolution.y;
    rpof.x *= aspect;
    vec3 rd = normalize((p.x+rpof.x)*uu + (p.y+rpof.y)*vv + focal*ww);

    vec3 col = traceEyePath(ro, rd, DLS, seed, lSphere);
    tot += col;
    seed = mod(seed * 1.1234567893490423, 13.0);
  }

  tot /= float(SAMPLES);
  tot *= (1.0 + 0.0 * uGamma); // keep ABI

  fragColor = vec4(clamp(tot, 0.0, 1.0), 1.0);
}

void main(){ vec4 c; mainImage(c, gl_FragCoord.xy); gl_FragColor = c; }
// --- END PT FRAGMENT SHADER ---
`;

  return { vs, fs: defines + fs };
}
