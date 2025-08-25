// js/render/backends/pathtrace_shader.js
// Stable, scene-driven path tracer (spheres/tris/quads + light).
// Output is linear (no gamma). uGamma kept for ABI (0-weight referenced).

export function buildTracerSources(PT) {
  const LIGHT   = (PT?.LIGHT_COLOR ?? [16.86, 10.76, 8.2]).map(Number);
  const SAMPLES = Math.max(1, (PT?.SAMPLES_PER_BATCH | 0) || 12);
  const BOUNCES = Math.max(1, (PT?.MAX_BOUNCES       | 0) || 4);
  const PIXASP  = Number(PT?.PIXEL_ASPECT ?? 1.0);
  const LIM     = PT?.LIMITS ?? {};
  const MAXS    = (LIM.MAX_SPHERES ?? 4) | 0;
  const MAXT    = (LIM.MAX_TRIS    ?? 4) | 0;
  const MAXQ    = (LIM.MAX_QUADS   ?? 4) | 0;

  const defines = `
#define SAMPLES        ${SAMPLES}
#define EYEPATHLENGTH  ${BOUNCES}
#define PIXEL_ASPECT   ${(isFinite(PIXASP) && PIXASP > 0) ? PIXASP.toFixed(6) : '1.0'}

#define MAX_SPHERES ${MAXS}
#define MAX_TRIS    ${MAXT}
#define MAX_QUADS   ${MAXQ}

// (Temporal anti-aliasing removed: no ANIMATENOISE define)
${(PT?.DIRECT_LIGHT_SAMPLING ?? true) ? '#define DIRECT_LIGHT_SAMPLING' : ''}

#define LIGHTCOLOR  vec3(${LIGHT[0].toFixed(4)}, ${LIGHT[1].toFixed(4)}, ${LIGHT[2].toFixed(4)})*1.3
#define WHITECOLOR  vec3(0.7295, 0.7355, 0.7290)*0.7
#define GREENCOLOR  vec3(0.1170, 0.4125, 0.1150)*0.7
#define REDCOLOR    vec3(0.6110, 0.0555, 0.0620)*0.7

// Material ID conventions (uint) matching legacy enums:
#define MAT_LIGHT   0u
#define MAT_WHITE   1u
#define MAT_GREEN   2u
#define MAT_RED     3u
#define MAT_GLASS   6u
#define MAT_MIRROR  7u
`;

  const vs = `#version 300 es
in vec2 aPosition;
void main(){ gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

  const fs = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform vec3  iResolution;
uniform float iTime;
uniform vec4  iMouse;

uniform vec3  uCamPos;
uniform float uYaw;
uniform float uPitch;
uniform float uFovY;
uniform float uGamma; // ABI only; referenced with 0 weight

// ***** SCENE UNIFORMS (sizes come from injected #defines) *****
// Spheres
uniform int   uNumSpheres;
uniform vec4  uSpheres[MAX_SPHERES];      // xyz=ctr, w=radius
uniform uint  uSphereMatId[MAX_SPHERES];  // material ID per sphere

// Triangles
uniform int   uNumTris;
uniform vec3  uTriA[MAX_TRIS];
uniform vec3  uTriB[MAX_TRIS];
uniform vec3  uTriC[MAX_TRIS];
uniform uint  uTriMatId[MAX_TRIS];        // material ID per tri
uniform uvec2 uTriUVA[MAX_TRIS];          // per-vertex integer UVs (atlas texel coords)
uniform uvec2 uTriUVB[MAX_TRIS];
uniform uvec2 uTriUVC[MAX_TRIS];

// Quads (two-tri split at shading time)
uniform int   uNumQuads;
uniform vec3  uQuadA[MAX_QUADS];
uniform vec3  uQuadB[MAX_QUADS];
uniform vec3  uQuadC[MAX_QUADS];
uniform vec3  uQuadD[MAX_QUADS];
uniform uint  uQuadMatId[MAX_QUADS];      // material ID per quad
uniform uvec2 uQuadUV0[MAX_QUADS];
uniform uvec2 uQuadUV1[MAX_QUADS];
uniform uvec2 uQuadUV2[MAX_QUADS];
uniform uvec2 uQuadUV3[MAX_QUADS];

// Texture atlas (RGBA8, NEAREST). texelFetch only; no filtering.
uniform sampler2D uAtlas;
uniform ivec2     uAtlasSize;             // (width, height) in texels
// **********************************************

// Light (animated or fixed)
uniform vec3  uLightCenter;
uniform float uLightRadius;
uniform float uLightAuto;

// Scene color constants are injected by JS via #define (LIGHTCOLOR, etc.)

// Robust epsilon
const float eps = 1e-3;

// ---------------- RNG (deterministic, no UB) ----------------
float hash1(inout float seed){
  seed += 0.1;                       // advance exactly once per call
  return fract(sin(seed)*43758.5453123);
}

vec2 hash2(inout float seed){
  seed += 0.1; float s1 = seed;      // first advance
  seed += 0.1; float s2 = seed;      // second advance
  vec2 v = sin(vec2(s1, s2)) * vec2(43758.5453123, 22578.1459123);
  return fract(v);
}

// ---------------- Environment ----------------
vec3 environment(vec3 rd){
  float t = clamp(rd.y*0.5+0.5, 0.0, 1.0);
  vec3 sky  = mix(vec3(0.90,0.95,1.00), vec3(0.45,0.65,0.95), pow(t,1.2));
  vec3 grd  = vec3(0.18,0.15,0.12);
  return mix(grd*0.35, sky, smoothstep(-0.05, 0.05, rd.y));
}

// ---------------- Intersections ----------------
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

// Möller–Trumbore returning barycentric (b0,b1,b2) for the hit tri
float iTriangle(vec3 ro, vec3 rd, vec3 a, vec3 b, vec3 c, out vec3 n, out vec3 bc){
  vec3 e1 = b - a, e2 = c - a;
  vec3 p = cross(rd, e2);
  float det = dot(e1, p);
  if (abs(det) < 1e-6) { n=vec3(0); bc=vec3(0); return -1.0; }
  float invDet = 1.0/det;
  vec3 t = ro - a;
  float u = dot(t, p) * invDet; if (u < 0.0 || u > 1.0) { n=vec3(0); bc=vec3(0); return -1.0; }
  vec3 q = cross(t, e1);
  float v = dot(rd, q) * invDet; if (v < 0.0 || u + v > 1.0) { n=vec3(0); bc=vec3(0); return -1.0; }
  float tt = dot(e2, q) * invDet; if (tt <= eps) { n=vec3(0); bc=vec3(0); return -1.0; }
  n = normalize(cross(e1, e2));
  if (dot(n, rd) > 0.0) n = -n;
  bc = vec3(1.0 - u - v, u, v);
  return tt;
}

// ---------------- Materials (branch-lean via LUT + masks) ----------------
// Dense ID→color lookup. Indexes 0..7 map to known materials; index 8 is default gray.
#define MAT_LUT_SIZE 9
const vec3 kMatLUT[MAT_LUT_SIZE] = vec3[](
  LIGHTCOLOR,  // 0 LIGHT
  WHITECOLOR,  // 1 WHITE
  GREENCOLOR,  // 2 GREEN
  REDCOLOR,    // 3 RED
  vec3(0.8),   // 4 (unused) → gray
  vec3(0.8),   // 5 (unused) → gray
  vec3(1.0),   // 6 GLASS     → white carrier
  vec3(1.0),   // 7 MIRROR    → white
  vec3(0.8)    // 8 DEFAULT   → gray (for any id ≥ 8)
);

vec3 matColor(uint id){
  int idx = int(min(id, uint(MAT_LUT_SIZE - 1)));
  return kMatLUT[idx];
}

// Bit masks avoid chains for specular/light classification.
const uint SPEC_MASK  = (1u<<6) | (1u<<7); // GLASS, MIRROR
const uint LIGHT_MASK = (1u<<0);           // LIGHT

bool matIsSpecular(uint id){
  uint bit = 1u << min(id, 31u);
  return (SPEC_MASK & bit) != 0u;
}
bool matIsLight(uint id){
  uint bit = 1u << min(id, 31u);
  return (LIGHT_MASK & bit) != 0u;
}
  
// ---------------- Light sphere ----------------
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

// ---------------- Atlas helpers (NEAREST via texelFetch) ----------------
// Only consider atlas "enabled" if it is at least 2x2. A 1x1 fallback should not drive texturing.
bool atlasEnabled(){ return (uAtlasSize.x > 1 && uAtlasSize.y > 1); }
bool texelInBounds(ivec2 tc){
  return tc.x >= 0 && tc.y >= 0 && tc.x < uAtlasSize.x && tc.y < uAtlasSize.y;
}
vec3 fetchAtlasRGB(ivec2 tc){
  vec4 t = texelFetch(uAtlas, tc, 0);
  return t.rgb;
}
bool allZero(uvec2 a, uvec2 b, uvec2 c){
  return all(equal(a, uvec2(0))) && all(equal(b, uvec2(0))) && all(equal(c, uvec2(0)));
}

// ---------------- UV sampling (tris/quads) ----------------
bool sampleTriAlbedo(int i, vec3 bc, out vec3 albedo){
  if (!atlasEnabled()) return false;
  // If all three vertices have (0,0) UVs, treat as "no texture".
  if (allZero(uTriUVA[i], uTriUVB[i], uTriUVC[i])) return false;

  // Barycentric interpolation of integer texel coordinates, then round to nearest texel
  vec2 uvf = bc.x * vec2(uTriUVA[i]) + bc.y * vec2(uTriUVB[i]) + bc.z * vec2(uTriUVC[i]);
  ivec2 tc = ivec2(floor(uvf + 0.5));

  // Zero/negative or out-of-bounds UVs → not valid for atlas sampling.
  if (tc.x <= 0 || tc.y <= 0) return false;
  if (!texelInBounds(tc)) return false;

  albedo = fetchAtlasRGB(tc);
  return true;
}

bool sampleQuadAlbedo(int i, int triSel, vec3 bc, out vec3 albedo){
  if (!atlasEnabled()) return false;

  // Use the chosen diagonal and its three vertex UVs.
  bool useABC = (triSel == 0);
  uvec2 U0 = uQuadUV0[i];
  uvec2 U1 = useABC ? uQuadUV1[i] : uQuadUV2[i];
  uvec2 U2 = useABC ? uQuadUV2[i] : uQuadUV3[i];

  // If all three are (0,0), consider UVs invalid and fall back to material color.
  if (allZero(U0, U1, U2)) return false;

  vec2 uvf =
      bc.x * vec2(U0) +
      bc.y * vec2(U1) +
      bc.z * vec2(U2);

  ivec2 tc = ivec2(floor(uvf + 0.5));

  // Zero/negative or out-of-bounds UVs → not valid for atlas sampling.
  if (tc.x <= 0 || tc.y <= 0) return false;
  if (!texelInBounds(tc)) return false;

  albedo = fetchAtlasRGB(tc);
  return true;
}

// ---------------- Sampling ----------------
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

// ---------------- Hit record ----------------
struct HitInfo {
  float t;
  uint  matId;
  int   kind;   // 0=none, 1=sphere, 3=tri, 4=quad, 5=light
  int   index;  // primitive index
  int   triSel; // for quads: 0 = (A,B,C), 1 = (A,C,D), -1 = n/a
  vec3  n;      // geometric normal (face-corrected)
  vec3  bc;     // barycentric for tris/quads
};

HitInfo makeNone(){ HitInfo h; h.t=1e20; h.matId=0u; h.kind=0; h.index=-1; h.triSel=-1; h.n=vec3(0); h.bc=vec3(0); return h; }

// ---------------- Scene intersection wrappers ----------------
HitInfo intersect(in vec3 ro, in vec3 rd, vec4 lightSphere){
  HitInfo best = makeNone();

  // Spheres
  for (int i=0; i<MAX_SPHERES; ++i){
    if (i>=uNumSpheres) break;
    float t = iSphere(ro, rd, uSpheres[i]);
    if (t>eps && t<best.t) {
      best.t = t; best.kind = 1; best.index = i; best.matId = uSphereMatId[i];
      best.n = nSphere(ro+t*rd, uSpheres[i]);
    }
  }

  // Triangles
  for (int i=0; i<MAX_TRIS; ++i){
    if (i>=uNumTris) break;
    vec3 nt, bc;
    float t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], nt, bc);
    if (t>eps && t<best.t) {
      best.t = t; best.kind = 3; best.index = i; best.matId = uTriMatId[i];
      best.n = nt; best.bc = bc;
    }
  }

  // Quads (test both triangles per quad)
  for (int i=0; i<MAX_QUADS; ++i){
    if (i>=uNumQuads) break;
    vec3 a=uQuadA[i], b=uQuadB[i], c=uQuadC[i], d=uQuadD[i];
    vec3 n1, n2, bc1, bc2;
    float t1 = iTriangle(ro, rd, a, b, c, n1, bc1);
    float t2 = iTriangle(ro, rd, a, c, d, n2, bc2);

    if (t1>eps && t1<best.t) { best.t=t1; best.kind=4; best.index=i; best.matId=uQuadMatId[i]; best.triSel=0; best.n=n1; best.bc=bc1; }
    if (t2>eps && t2<best.t) { best.t=t2; best.kind=4; best.index=i; best.matId=uQuadMatId[i]; best.triSel=1; best.n=n2; best.bc=bc2; }
  }

  // Light as geometry
  float tl = iSphere(ro, rd, lightSphere);
  if (tl>eps && tl<best.t) {
    best.t = tl; best.kind = 5; best.index = -1; best.matId = MAT_LIGHT;
    best.n = (ro+tl*rd - lightSphere.xyz)/max(lightSphere.w,1.0e-6);
  }

  return best;
}

bool intersectShadow(in vec3 ro, in vec3 rd, in float dist){
  float t; vec3 n, bc;

  for (int i=0; i<MAX_SPHERES; ++i){
    if (i>=uNumSpheres) break;
    t = iSphere(ro, rd, uSpheres[i]);
    if (t>eps && t<dist) return true;
  }
  for (int i=0; i<MAX_TRIS; ++i){
    if (i>=uNumTris) break;
    t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], n, bc);
    if (t>eps && t<dist) return true;
  }
  for (int i=0; i<MAX_QUADS; ++i){
    if (i>=uNumQuads) break;
    t = iTriangle(ro, rd, uQuadA[i], uQuadB[i], uQuadC[i], n, bc); if (t>eps && t<dist) return true;
    t = iTriangle(ro, rd, uQuadA[i], uQuadC[i], uQuadD[i], n, bc); if (t>eps && t<dist) return true;
  }
  return false;
}

// ---------------- BRDF (diffuse + dielectric w/ Fresnel + TIR) ----------------
vec3 nextDirection(vec3 n, const vec3 rd, uint matId, inout bool specularBounce, inout float seed){
  specularBounce = false;
  if (!matIsSpecular(matId)) return cosWeightedHemisphere(n, seed);
  specularBounce = true;

  float n1, n2, ndotr = dot(rd, n);
  if (ndotr > 0.0) { n1=1.0; n2=1.5; n = -n; } else { n1=1.5; n2=1.0; }
  float r0 = (n1-n2)/(n1+n2); r0 *= r0;
  float fres = r0 + (1.0 - r0) * pow(1.0 - abs(ndotr), 5.0);

  vec3 ref = refract(rd, n, n2/n1);
  if (length(ref) < 1e-5 || hash1(seed) < fres) ref = reflect(rd, n);
  return normalize(ref);
}

// ---------------- Path tracer (DLS always on) ----------------
vec3 traceEyePath(in vec3 ro, in vec3 rd, inout float seed, vec4 lightSphere){
  vec3 Lo = vec3(0.0);
  vec3 T  = vec3(1.0);
  bool specularBounce = true;

  for (int j=0; j<EYEPATHLENGTH; ++j) {
    HitInfo H = intersect(ro, rd, lightSphere);
    if (H.kind == 0) { Lo += T * environment(rd); break; }

    vec3 hit = ro + H.t * rd;

    if (matIsLight(H.matId) || H.kind == 5) {
      // With DLS, count emission only on specular paths to avoid double-count with NEE
      if (specularBounce) Lo += T * LIGHTCOLOR;
      break;
    }

    // Decide albedo: try atlas sample for tris/quads; otherwise fall back to material ID color.
    vec3 albedo = matColor(H.matId);
    bool gotTex = false;
    if (H.kind == 3) {
      gotTex = sampleTriAlbedo(H.index, H.bc, albedo);
    } else if (H.kind == 4) {
      gotTex = sampleQuadAlbedo(H.index, H.triSel, H.bc, albedo);
    }
    // (gotTex indicates atlas use; otherwise we kept material color.)

    // Bounce
    vec3 ndir = nextDirection(H.n, rd, H.matId, specularBounce, seed);
    if (!specularBounce || dot(ndir, H.n) < 0.0) T *= albedo;

    // Next-Event Estimation (always on): sample the light on diffuse bounces
    if (!specularBounce && j < EYEPATHLENGTH-1) {
      vec3  Lpos = sampleLight(hit, seed, lightSphere);
      vec3  Ldir = normalize(Lpos - hit);
      float dist = length(Lpos - hit);
      if (!intersectShadow(hit + H.n*eps, Ldir, dist)) {
        float cos_a_max = sqrt(1.0 - clamp(lightSphere.w*lightSphere.w /
                          dot(lightSphere.xyz - hit, lightSphere.xyz - hit), 0.0, 1.0));
        float weight = 2.0 * (1.0 - cos_a_max);  // uniform-on-sphere pdf factor
        Lo += T * LIGHTCOLOR * (weight * max(dot(Ldir, H.n), 0.0));
      }
    }

    rd = ndir;
    float side = (dot(rd, H.n) > 0.0) ? 1.0 : -1.0;
    ro = hit + H.n * side * eps;

    // Russian roulette
    if (j >= 2) {
      float p = clamp(max(T.r, max(T.g, T.b)), 0.05, 0.95);
      if (hash1(seed) > p) break;
      T /= p;
    }
  }
  return Lo;
}

out vec4 fragColor;

void mainImage(out vec4 outColor, in vec2 fragCoord){
  vec2 p = -1.0 + 2.0 * fragCoord.xy / iResolution.xy;
  float aspect = (iResolution.x / iResolution.y) * PIXEL_ASPECT;
  p.x *= aspect;

  // Deterministic seed (no time dependence)
  float seed = p.x + p.y * 3.43121412313;

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

    vec3 col = traceEyePath(ro, rd, seed, lSphere);
    tot += col;

    // Deterministic advance; keeps sequence stable
    seed = mod(seed * 1.1234567893490423, 13.0);
  }

  tot /= float(SAMPLES);
  tot *= (1.0 + 0.0 * uGamma); // keep ABI

  outColor = vec4(clamp(tot, 0.0, 1.0), 1.0);
}

void main(){ vec4 c; mainImage(c, gl_FragCoord.xy); fragColor = c; }
`;

  // Ensure #version is the very first line, then inject defines right after it.
  const fsFinal = fs.replace(/^#version\s+300\s+es\s*/, `#version 300 es\n${defines}\n`);
  return { vs, fs: fsFinal };
}
