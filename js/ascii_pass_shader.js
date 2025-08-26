// js/ascii_pass_shader.js
// Shaders for the GPU ASCII pass, with optional modal smoothing:
//  • Vertex shader: full-screen quad pass-through
//  • Fragment shader: ramp quantization, optional modal smoothing (majority vote)
//  • Smoothing NEVER affects UI overrides (alpha-encoded ASCII), and smoothing DOES NOT
//    change glyph tint/color (color comes from the current cell only).

export function buildAsciiPassShaderSources(rampString) {
  const ramp = Array.from(String(rampString || '@%#*+=-:. '));
  const RAMP_LEN = Math.max(1, ramp.length) | 0;

  const GLSL_RAMPIDX_TO_ASCII =
`int asciiFromRampIndex(int idx){
  ${ramp.map((ch, i) => `${i === 0 ? '' : 'else '}if (idx == ${i}) return ${ch.charCodeAt(0)};`).join('\n  ')}
  return 32; // fallback to space if out of range
}`;

  const vs = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main(){
      vUv = aPos * 0.5 + 0.5;
      gl_Position = vec4(aPos, 0.0, 1.0);
    }
  `;

  const fs = `
precision highp float;
precision highp int;

uniform sampler2D uSrc;    // grid RGBA (A carries override when >=2)
uniform sampler2D uAtlas;  // 256-ASCII atlas (tile index == ASCII code)

uniform vec2  uGridSize;     // cols, rows
uniform vec2  uCellPx;       // cellW, cellH (device px)
uniform vec2  uCanvasPx;     // canvasW, canvasH (device px)
uniform vec4  uAtlasLayout;  // tileW, tileH, tilesPerRow, ATLAS_COUNT (256)
uniform float uPadPx;        // padding in atlas
uniform float uAlphaGamma;   // glyph weight tweak
uniform float uGray;         // 1 => grayscale/black text
uniform float uTransparentBG;

// Modal smoothing controls
uniform int   uModeOn;       // 0/1 toggle
uniform int   uModeRadius;   // 1 => 3x3, 2 => 5x5, 3 => 7x7
uniform int   uModeThresh;   // minimum neighbor votes for replacement

// Helper: simple average intensity, matching CPU path
float avgRGB(vec3 c){ return (c.r + c.g + c.b) / 3.0; }
bool texelIsTransparent(float a){ return a <= 0.0; }

// ES 1.00 integer helpers (abs(int) and clamp(int,...) are not available)
int iabs(int x){ return (x < 0) ? -x : x; }

// JS-injected mapper: ramp index -> ASCII code
${GLSL_RAMPIDX_TO_ASCII}

// Ramp length as a compile-time constant
const int RAMP_LEN = ${RAMP_LEN};

// Quantize a color to a ramp index [0..RAMP_LEN-1], matching CPU rounding
int quantizeToRampIndex(vec3 srcColor){
  float iF   = avgRGB(srcColor);
  iF         = clamp(iF, 0.0, 1.0 - 1e-6); // tiny epsilon avoids exact-top-bin flips
  float idxF = floor(iF * float(RAMP_LEN - 1) + 0.5); // round()
  idxF       = clamp(idxF, 0.0, float(RAMP_LEN - 1));
  return int(idxF);
}

// Clamp a float vec2 cell coordinate to the valid grid range
vec2 clampCell(vec2 cell){
  return clamp(cell, vec2(0.0), uGridSize - vec2(1.0));
}

// Majority vote on neighbors (Boyer–Moore pass + count), ignoring UI overrides.
// Returns the winning neighbor ramp index, its vote count, and the average color of the voters.
void majorityNeighbor(vec2 centerCell, out int candidateIdx, out int votes, int radius, out vec3 meanColor){
  // First pass: Boyer–Moore candidate among neighbors (ignoring center)
  int cand = -1;
  int cnt  = 0;

  // Max radius we will unroll to (keeps loops constant for ES 2.0)
  const int MAX_MODE_RADIUS = 3; // supports up to 7x7
  for (int dy = -MAX_MODE_RADIUS; dy <= MAX_MODE_RADIUS; ++dy){
    for (int dx = -MAX_MODE_RADIUS; dx <= MAX_MODE_RADIUS; ++dx){
      if (iabs(dy) > radius || iabs(dx) > radius) continue;
      if (dx == 0 && dy == 0) continue; // skip center

      vec2 ncell  = centerCell + vec2(float(dx), float(dy));
      ncell       = clampCell(ncell);

      vec2 nUV    = (ncell + 0.5) / uGridSize;
      vec4 nSamp  = texture2D(uSrc, nUV);
      float aByte = nSamp.a * 255.0 + 0.5;
      int   aInt  = int(floor(aByte));

      // Ignore UI override neighbors entirely
      if (aInt >= 2 && aInt <= 254) continue;

      int nIdx = quantizeToRampIndex(nSamp.rgb);
      if (cnt == 0) { cand = nIdx; cnt = 1; }
      else if (nIdx == cand) { cnt += 1; }
      else { cnt -= 1; }
    }
  }

  // Second pass: count true votes for the candidate (if any) and accumulate color
  int trueVotes = 0;
  vec3 sumCol = vec3(0.0);
  if (cand >= 0) {
    for (int dy = -MAX_MODE_RADIUS; dy <= MAX_MODE_RADIUS; ++dy){
      for (int dx = -MAX_MODE_RADIUS; dx <= MAX_MODE_RADIUS; ++dx){
        if (iabs(dy) > radius || iabs(dx) > radius) continue;
        if (dx == 0 && dy == 0) continue;

        vec2 ncell  = centerCell + vec2(float(dx), float(dy));
        ncell       = clampCell(ncell);

        vec2 nUV    = (ncell + 0.5) / uGridSize;
        vec4 nSamp  = texture2D(uSrc, nUV);
        float aByte = nSamp.a * 255.0 + 0.5;
        int   aInt  = int(floor(aByte));

        if (aInt >= 2 && aInt <= 254) continue; // ignore overrides

        int nIdx = quantizeToRampIndex(nSamp.rgb);
        if (nIdx == cand) {
          trueVotes += 1;
          sumCol += nSamp.rgb;
        }
      }
    }
  }

  candidateIdx = cand;
  votes = trueVotes;
  meanColor = (trueVotes > 0) ? (sumCol / float(trueVotes)) : vec3(0.0);
}

void main(){
  vec2 pix = gl_FragCoord.xy;

  // Cell index (float)
  vec2 cell = floor(pix / uCellPx);
  cell = clampCell(cell);

  // Source sample at cell center
  vec2 srcUV     = (cell + 0.5) / uGridSize;
  vec4 srcSample = texture2D(uSrc, srcUV);
  vec3 srcColor  = srcSample.rgb;

  // UI override detection
  float aByte = srcSample.a * 255.0 + 0.5;
  int   aInt  = int(floor(aByte));
  bool  useAsciiOverride = (aInt >= 2 && aInt <= 254);

  int asciiCode;
  vec3 tintSrc = srcColor; // default tint source is this cell's color

  if (useAsciiOverride) {
    // NEVER smooth UI overrides: draw the exact ASCII glyph from the atlas
    asciiCode = aInt;
  } else {
    // Base ramp index
    int baseIdx = quantizeToRampIndex(srcColor);
    int finalIdx = baseIdx;

    // Optional modal smoothing: only for non-override cells. Neighbors that are UI overrides are ignored.
    if (uModeOn == 1) {
      int candIdx, voteCount;
      vec3 majAvgColor;
      // int clamp for ES 1.00 (must match MAX_MODE_RADIUS)
      int radius = uModeRadius;
      if (radius < 1) radius = 1;
      if (radius > 3) radius = 3;

      majorityNeighbor(cell, candIdx, voteCount, radius, majAvgColor);

      // If a neighbor majority exceeds threshold AND differs from center, adopt it
      // (color stays as the current cell's color; no tint change from majority).
      if (candIdx >= 0 && voteCount >= uModeThresh && candIdx != baseIdx) {
        finalIdx = candIdx;
        // tintSrc  = majAvgColor; // disabled: modal smoothing does not affect color
      }
    }

    asciiCode = asciiFromRampIndex(finalIdx);
  }

  float glyphIdx = float(asciiCode);

  // Atlas layout
  float tileW = uAtlasLayout.x;
  float tileH = uAtlasLayout.y;
  float tilesPerRow = uAtlasLayout.z;
  float atlasCount  = uAtlasLayout.w; // should be 256

  float tileX = mod(glyphIdx, tilesPerRow);
  float tileY = floor(glyphIdx / tilesPerRow);

  // Integer-ish cell bounds → stable texel mapping
  float canvasW = uCanvasPx.x, canvasH = uCanvasPx.y;
  float cols = uGridSize.x, rows = uGridSize.y;
  float cellStartX = floor(cell.x * canvasW / cols);
  float cellStartY = floor(cell.y * canvasH / rows);

  float pxIdxX = clamp(floor(gl_FragCoord.x - 0.5) - cellStartX, 0.0, 1e9);
  float pxIdxY = clamp(floor(gl_FragCoord.y - 0.5) - cellStartY, 0.0, 1e9);

  float innerW = tileW - 2.0 * uPadPx;
  float innerH = tileH - 2.0 * uPadPx;

  float atlasX = clamp(pxIdxX + 0.5, 0.5, max(0.5, innerW - 0.5));
  float atlasY = clamp(pxIdxY + 0.5, 0.5, max(0.5, innerH - 0.5));

  vec2 atlasPx = vec2(tileX * tileW + uPadPx + atlasX,
                      tileY * tileH + uPadPx + atlasY);
  float rowsCount = ceil(atlasCount / tilesPerRow);
  vec2 atlasDim   = vec2(tilesPerRow * tileW, rowsCount * tileH);
  vec2 atlasUV    = atlasPx / atlasDim;

  // Coverage → alpha (glyph weight)
  float cov = texture2D(uAtlas, atlasUV).a;
  cov = pow(cov, uAlphaGamma);
  if (uTransparentBG > 0.5 && texelIsTransparent(cov)) { discard; }

  // Tint + composite over white
  vec3 tint   = mix(tintSrc, vec3(0.0), uGray);
  vec3 outCol = mix(vec3(1.0), tint, cov);
  gl_FragColor = vec4(outCol, 1.0);
}
`;

  return { vs, fs };
}
