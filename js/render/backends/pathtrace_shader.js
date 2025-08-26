// js/render/backends/pathtrace_shader.js
// Application-level shader builder: defines + uniforms + path tracing loop + main image.
// Imports shaderUtils and composes final shader string.

import { shaderUtils } from './shader_utils.js';

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

  // Uniforms (kept identical to original)
  const uniforms = `precision highp float;
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
`;

  // Application functions: traceEyePath (now with outPrimaryFetched) and mainImage (uses fetchedTexel logic)
  const appFuncs = `
// ---------------- Path tracer ----------------
// outAlphaOverride: 0.0 => none; otherwise = ASCII_code / 255.0 (only for primary ray hits).
// outPrimaryFetched: 0 => primary ray did NOT hit any atlas texel; 1 => did hit an atlas texel.
vec3 traceEyePath(in vec3 ro, in vec3 rd, inout float seed, vec4 lightSphere, out float outAlphaOverride, out int outPrimaryFetched){
  vec3 Lo = vec3(0.0);
  vec3 T  = vec3(1.0);
  bool specularBounce = true;
  outAlphaOverride = 0.0;
  outPrimaryFetched = 0;

  for (int j=0; j<EYEPATHLENGTH; ++j) {
    HitInfo H = intersect(ro, rd, lightSphere);
    if (H.kind == 0) { Lo += T * environment(rd); break; }

    vec3 hit = ro + H.t * rd;

    if (matIsLight(H.matId) || H.kind == 5) {
      if (specularBounce) Lo += T * LIGHTCOLOR;
      break;
    }

    // Sample atlas (if any)
    vec3 texRGB; int aByte = 0; bool sampled = false;
    if (H.kind == 3) {
      sampled = sampleTriFetch(H.index, H.bc, texRGB, aByte);
    } else if (H.kind == 4) {
      sampled = sampleQuadFetch(H.index, H.triSel, H.bc, texRGB, aByte);
    }

    // If this is the PRIMARY ray (j == 0) then record whether we sampled an atlas texel.
    if (j == 0 && sampled) {
      outPrimaryFetched = 1;
    }

    // ASCII texel handling:
    //  • Primary ray (j==0): pass-through color, set alpha override, STOP (not emissive to scene).
    //  • Non-primary rays: treat as solid albedo (truncate alpha to 1), continue shading.
    if (sampled && aByte >= 32 && aByte <= 126) {
      if (j == 0) {
        Lo = texRGB;
        outAlphaOverride = float(aByte) / 255.0;
        break;
      } else {
        aByte = 1; // truncate to solid for secondary bounces
      }
    }

    // Albedo: solid texel (A==1) wins, else material color
    vec3 albedo = (sampled && aByte == 1) ? texRGB : matColor(H.matId);

    // Bounce
    vec3 ndir = nextDirection(H.n, rd, H.matId, specularBounce, seed);
    if (!specularBounce || dot(ndir, H.n) < 0.0) T *= albedo;

    // NEE on diffuse bounces
    if (!specularBounce && j < EYEPATHLENGTH-1) {
      vec3  Lpos = sampleLight(hit, seed, lightSphere);
      vec3  Ldir = normalize(Lpos - hit);
      float dist = length(Lpos - hit);
      if (!intersectShadow(hit + H.n*eps, Ldir, dist)) {
        float cos_a_max = sqrt(1.0 - clamp(lightSphere.w*lightSphere.w /
                          dot(lightSphere.xyz - hit, lightSphere.xyz - hit), 0.0, 1.0));
        float weight = 2.0 * (1.0 - cos_a_max);
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

  vec3  tot = vec3(0.0);
  float overrideA = 0.0;

  // Per-pixel fetchedTexel control.
  // Initially set to true as requested.
  bool fetchedTexel = true;
  bool decided = false;

  for (int a=0; a<SAMPLES; ++a) {
    // Determine rpof: either center (vec2(0.0)) if fetchedTexel==true, or randomized if false.
    vec2 rpof;
    if (!decided) {
      // For the first sample (a==0), use the current fetchedTexel value (initially true).
      // All samples will be forced to use the same bool after we observe the primary ray.
      rpof = (fetchedTexel) ? vec2(0.0) : 2.0 * (hash2(seed) - vec2(0.5)) / iResolution.y;
      rpof.x *= aspect;
    } else {
      // After decision, all subsequent samples follow fetchedTexel
      if (fetchedTexel) {
        rpof = vec2(0.0);
      } else {
        rpof = 2.0 * (hash2(seed) - vec2(0.5)) / iResolution.y;
        rpof.x *= aspect;
      }
    }

    vec3 rd = normalize((p.x+rpof.x)*uu + (p.y+rpof.y)*vv + focal*ww);

    float aOut = 0.0;
    int primaryFetched = 0;
    vec3 col = traceEyePath(ro, rd, seed, lSphere, aOut, primaryFetched);

    // After the first primary ray sample for this pixel, decide the fetchedTexel flag
    if (!decided) {
      fetchedTexel = (primaryFetched != 0);
      decided = true;
      // If we changed fetchedTexel from initial and need to change sampling strategy for subsequent samples,
      // we simply continue — the next loop iteration will use the new fetchedTexel value.
    }

    // If the PRIMARY ray hit an ASCII texel, aOut>0.0; take it directly and stop sampling
    if (aOut > 0.0) {
      tot = col;
      overrideA = aOut;
      break;
    }

    tot += col;
    seed = mod(seed * 1.1234567893490423, 13.0);
  }

  if (overrideA > 0.0) {
    outColor = vec4(clamp(tot, 0.0, 1.0), overrideA);
  } else {
    tot /= float(SAMPLES);
    tot *= (1.0 + 0.0 * uGamma);
    outColor = vec4(clamp(tot, 0.0, 1.0), 1.0);
  }
}

void main(){ vec4 c; mainImage(c, gl_FragCoord.xy); fragColor = c; }
`;

  // Compose final fragment shader: version + defines + uniforms + shader utils + application functions.
  const fsFinal = `#version 300 es
${defines}
${uniforms}
${shaderUtils}
${appFuncs}
`;

  return { vs, fs: fsFinal };
}
