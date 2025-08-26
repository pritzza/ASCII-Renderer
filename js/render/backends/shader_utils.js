// js/render/backends/shader_utils.js
// Reusable GLSL utilities for the path tracer.
export const shaderUtils = `
// Robust epsilon (used by many helpers)
const float eps = 1e-3;

// ---------------- RNG ----------------
float hash1(inout float seed){
  seed += 0.1;
  return fract(sin(seed)*43758.5453123);
}
vec2 hash2(inout float seed){
  seed += 0.1; float s1 = seed;
  seed += 0.1; float s2 = seed;
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

// ---------------- Materials (LUT + masks) ----------------
#define MAT_LUT_SIZE 9
const vec3 kMatLUT[MAT_LUT_SIZE] = vec3[](
  LIGHTCOLOR,  // 0 LIGHT
  WHITECOLOR,  // 1 WHITE
  GREENCOLOR,  // 2 GREEN
  REDCOLOR,    // 3 RED
  vec3(0.8),   // 4
  vec3(0.8),   // 5
  vec3(1.0),   // 6 GLASS
  vec3(1.0),   // 7 MIRROR
  vec3(0.8)    // 8 default
);
vec3 matColor(uint id){
  int idx = int(min(id, uint(MAT_LUT_SIZE - 1)));
  return kMatLUT[idx];
}
const uint SPEC_MASK  = (1u<<6) | (1u<<7);
const uint LIGHT_MASK = (1u<<0);
bool matIsSpecular(uint id){ uint bit = 1u << min(id, 31u); return (SPEC_MASK & bit) != 0u; }
bool matIsLight  (uint id){ uint bit = 1u << min(id, 31u); return (LIGHT_MASK & bit) != 0u; }

// ---------------- Light sphere ----------------
vec4 getLightSphere(float time){
  if (uLightAuto > 0.5) {
    return vec4(3.0 + 2.0*sin(time),
                2.8 + 2.0*sin(time*0.9),
                3.0 + 4.0*cos(time*0.7),
                uLightRadius);
  }
  return vec4(uLightCenter, uLightRadius);
}

// ---------------- Atlas helpers ----------------
bool atlasEnabled(){ return (uAtlasSize.x > 1 && uAtlasSize.y > 1); }
bool texelInBounds(ivec2 tc){
  return tc.x >= 0 && tc.y >= 0 && tc.x < uAtlasSize.x && tc.y < uAtlasSize.y;
}
// Atlas is authored with (0,0) at top-left; texelFetch expects bottom-left.
// We uploaded the atlas unflipped, so flip only the Y coordinate when fetching.
void fetchAtlas(ivec2 tc, out vec3 rgb, out int aByte){
  ivec2 tf = ivec2(tc.x, uAtlasSize.y - 1 - tc.y);
  vec4 t = texelFetch(uAtlas, tf, 0);
  rgb   = t.rgb;
  aByte = int(floor(t.a * 255.0 + 0.5));
}

// ---------------- UV sampling (tris/quads) ----------------
bool sampleTriFetch(int i, vec3 bc, out vec3 albedo, out int aByte){
  albedo = vec3(0.0); aByte = 0;
  if (!atlasEnabled()) return false;
  vec2 uvf = bc.x * vec2(uTriUVA[i]) + bc.y * vec2(uTriUVB[i]) + bc.z * vec2(uTriUVC[i]);
  ivec2 tc = ivec2(floor(uvf + 0.5));
  if (!texelInBounds(tc)) return false;
  fetchAtlas(tc, albedo, aByte);
  if (aByte == 0) return false; // clear → no texture
  return true;
}
bool sampleQuadFetch(int i, int triSel, vec3 bc, out vec3 albedo, out int aByte){
  albedo = vec3(0.0); aByte = 0;
  if (!atlasEnabled()) return false;
  bool useABC = (triSel == 0);
  uvec2 U0 = uQuadUV0[i];
  uvec2 U1 = useABC ? uQuadUV1[i] : uQuadUV2[i];
  uvec2 U2 = useABC ? uQuadUV2[i] : uQuadUV3[i];
  if (all(equal(U0, uvec2(0))) && all(equal(U1, uvec2(0))) && all(equal(U2, uvec2(0)))) return false;
  vec2 uvf = bc.x * vec2(U0) + bc.y * vec2(U1) + bc.z * vec2(U2);
  ivec2 tc = ivec2(floor(uvf + 0.5));
  if (!texelInBounds(tc)) return false;
  fetchAtlas(tc, albedo, aByte);
  if (aByte == 0) return false; // clear → no texture
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
  int   triSel; // for quads: 0=(A,B,C), 1=(A,C,D), -1=n/a
  vec3  n;      // geometric normal
  vec3  bc;     // barycentric for tris/quads
};
HitInfo makeNone(){ HitInfo h; h.t=1e20; h.matId=0u; h.kind=0; h.index=-1; h.triSel=-1; h.n=vec3(0); h.bc=vec3(0); return h; }

// ---------------- Scene intersection wrappers ----------------
HitInfo intersect(in vec3 ro, in vec3 rd, vec4 lightSphere){
  HitInfo best = makeNone();

  for (int i=0; i<MAX_SPHERES; ++i){
    if (i>=uNumSpheres) break;
    float t = iSphere(ro, rd, uSpheres[i]);
    if (t>eps && t<best.t) {
      best.t = t; best.kind = 1; best.index = i; best.matId = uSphereMatId[i];
      best.n = nSphere(ro+t*rd, uSpheres[i]);
    }
  }

  for (int i=0; i<MAX_TRIS; ++i){
    if (i>=uNumTris) break;
    vec3 nt, bc;
    float t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], nt, bc);
    if (t>eps && t<best.t) {
      best.t = t; best.kind = 3; best.index = i; best.matId = uTriMatId[i];
      best.n = nt; best.bc = bc;
    }
  }

  for (int i=0; i<MAX_QUADS; ++i){
    if (i>=uNumQuads) break;
    vec3 a=uQuadA[i], b=uQuadB[i], c=uQuadC[i], d=uQuadD[i];
    vec3 n1, n2, bc1, bc2;
    float t1 = iTriangle(ro, rd, a, b, c, n1, bc1);
    float t2 = iTriangle(ro, rd, a, c, d, n2, bc2);
    if (t1>eps && t1<best.t) { best.t=t1; best.kind=4; best.index=i; best.matId=uQuadMatId[i]; best.triSel=0; best.n=n1; best.bc=bc1; }
    if (t2>eps && t2<best.t) { best.t=t2; best.kind=4; best.index=i; best.matId=uQuadMatId[i]; best.triSel=1; best.n=n2; best.bc=bc2; }
  }

  float tl = iSphere(ro, rd, lightSphere);
  if (tl>eps && tl<best.t) {
    best.t = tl; best.kind = 5; best.index = -1; best.matId = MAT_LIGHT;
    best.n = (ro+tl*rd - lightSphere.xyz)/max(lightSphere.w,1.0e-6);
  }

  return best;
}

bool intersectShadow(in vec3 ro, in vec3 rd, in float dist){
  float t; vec3 n, bc;
  for (int i=0; i<MAX_SPHERES; ++i){ if (i>=uNumSpheres) break; t = iSphere(ro, rd, uSpheres[i]); if (t>eps && t<dist) return true; }
  for (int i=0; i<MAX_TRIS; ++i){ if (i>=uNumTris) break; t = iTriangle(ro, rd, uTriA[i], uTriB[i], uTriC[i], n, bc); if (t>eps && t<dist) return true; }
  for (int i=0; i<MAX_QUADS; ++i){ if (i>=uNumQuads) break;
    t = iTriangle(ro, rd, uQuadA[i], uQuadB[i], uQuadC[i], n, bc); if (t>eps && t<dist) return true;
    t = iTriangle(ro, rd, uQuadA[i], uQuadC[i], uQuadD[i], n, bc); if (t>eps && t<dist) return true; }
  return false;
}

// ---------------- BRDF ----------------
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
`;
