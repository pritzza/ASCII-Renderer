// js/ascii_pass.js
// GPU ASCII pass that matches DOM rendering:
//  • Colored glyphs (quantized like the DOM path unless USE_GRAYSCALE=true)
//  • Glyph weight matched via alpha gamma and pixel-center sampling
//  • Exact sizing: CSS size from #measure (fractional), device size = CSS * DPR
//  • Atlas baked in DEVICE pixels with the same font as #measure (NEAREST)

import { config } from './config.js';

const GL_OPTS = {
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  desynchronized: true,
};

/* -------------------------- DOM measurement (ground truth) -------------------------- */
function readMeasure() {
  const el = document.getElementById('measure');
  if (!el) {
    return {
      cwCSS: 8, chCSS: 16,
      family: 'monospace',
      weight: '400',
      style: 'normal',
      stretch: 'normal',
      sizeCSS: 16,
    };
  }
  const cs = getComputedStyle(el);
  const rect = el.getBoundingClientRect(); // fractional CSS px allowed
  return {
    cwCSS: rect.width,
    chCSS: rect.height,
    family: cs.fontFamily || 'monospace',
    weight: cs.fontWeight || '400',
    style: cs.fontStyle || 'normal',
    stretch: cs.fontStretch || 'normal',
    sizeCSS: parseFloat(cs.fontSize) || 16,
  };
}

/* ------------------------------ Glyph atlas (DEVICE px) ------------------------------ */
// Build a 256-glyph ASCII atlas (index == ASCII code).
function buildAtlas(gl, cellWDevice, cellHDevice, fontDesc, alphaGamma) {
  const count = 256; // full byte range
  const pad = 2;
  const tileW = cellWDevice + pad * 2;
  const tileH = cellHDevice + pad * 2;

  const tilesPerRow = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / tilesPerRow);

  const atlasW = tilesPerRow * tileW;
  const atlasH = rows * tileH;

  const cvs = document.createElement('canvas');
  cvs.width = atlasW;
  cvs.height = atlasH;
  const ctx = cvs.getContext('2d');

  const fam = (fontDesc && fontDesc.family) || 'monospace';
  const style = (fontDesc && fontDesc.style) || 'normal';
  const weight = (fontDesc && fontDesc.weight) || '400';
  const stretch = (fontDesc && fontDesc.stretch) || 'normal';
  const fontStr = `${style} ${weight} ${stretch} ${cellHDevice}px/${cellHDevice}px ${fam}`;

  ctx.save();
  ctx.font = fontStr;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.clearRect(0, 0, atlasW, atlasH);

  const mt = ctx.measureText('M');
  const ascent = (mt.actualBoundingBoxAscent ?? cellHDevice * 0.8);
  const descent = (mt.actualBoundingBoxDescent ?? cellHDevice * 0.2);
  const glyphH = ascent + descent;
  // No rounding: keep subpixel baseline so glyphs aren’t quantized vertically
  const baselineOffsetY = (cellHDevice - glyphH) * 0.5 + ascent;

  for (let i = 0; i < count; i++) {
    const gx = (i % tilesPerRow);
    const gy = Math.floor(i / tilesPerRow);
    const ox = gx * tileW + pad;
    const oy = gy * tileH + pad;
    // No rounding: keep subpixel x/y draw positions
    ctx.fillText(String.fromCharCode(i), ox, oy + baselineOffsetY);
  }
  ctx.restore();

  if (alphaGamma && Math.abs(alphaGamma - 1) > 1e-3) {
    const img = ctx.getImageData(0, 0, atlasW, atlasH);
    const d = img.data;
    for (let p = 0; p < d.length; p += 4) {
      const a = d[p + 3] / 255;
      d[p + 3] = Math.max(0, Math.min(255, Math.round(Math.pow(a, alphaGamma) * 255)));
      d[p] = d[p + 1] = d[p + 2] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cvs);

  return { tex, tileW, tileH, tilesPerRow, count, pad, rows };
}

/* ---------------------------------- GL helpers ---------------------------------- */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('Shader compile error: ' + log);
  }
  return s;
}

function link(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error('Program link error: ' + log);
  }
  return p;
}

function createQuad(gl) {
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([
      -1, -1, 1, -1, -1, 1,
      1, -1, 1, 1, -1, 1,
    ]),
    gl.STATIC_DRAW
  );
  return vbo;
}

/* ----------------------------------- Pass ----------------------------------- */
export class AsciiPass {
  constructor(arg1 = {}, maybeOpts = {}) {
    let opts = {};
    if (arg1 instanceof HTMLCanvasElement) {
      this.canvas = arg1;
      opts = maybeOpts || {};
    } else {
      opts = arg1 || {};
      this.canvas = null;
    }

    // Config
    this.ramp = String(opts.ramp ?? config.ASCII_RAMP ?? '@%#*+=-:. ');
    this.grayscaleText = !!opts.grayscaleText;
    // Add these properties (defaults tuned for canvas AA -> DOM look)
    this.alphaGamma = Number.isFinite(opts.alphaGamma) ? opts.alphaGamma : 1.20; // thins a bit
    this.alphaBias = Number.isFinite(opts.alphaBias) ? opts.alphaBias : 0.045; // erode a hair
    // NEW: toggle for discarding transparent glyph texels (transparent background for glyph)
    this.transparentBackground = opts.transparentBackground !== undefined ? !!opts.transparentBackground : true;

    // --- Read DOM font metrics from #measure ---
    const measEl = document.getElementById('measure');
    let meas = { cwCSS: 8, chCSS: 16, family: 'monospace', sizeCSS: 16 };
    if (measEl) {
      const cs = getComputedStyle(measEl);
      const rect = measEl.getBoundingClientRect();
      meas = {
        cwCSS: rect.width,
        chCSS: rect.height,
        family: cs.fontFamily || 'monospace',
        sizeCSS: parseFloat(cs.fontSize) || rect.height,
      };
    }
    this.cwCSS = meas.cwCSS;
    this.chCSS = meas.chCSS;
    this.family = meas.family;
    this.dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));

    // Grid from config
    this.cols = (config.VIRTUAL_GRID_WIDTH | 0) || 1;
    this.rows = (config.VIRTUAL_GRID_HEIGHT | 0) || 1;

    // Device-pixel cell size
    this.cellWDevice = Math.max(1, Math.round(this.cwCSS * this.dpr));
    this.cellHDevice = Math.max(1, Math.round(this.chCSS * this.dpr));

    // Ensure canvas
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      (opts.mount || document.body).appendChild(this.canvas);
    }
    this._sizeCanvasToGrid();

    // Visuals
    this.canvas.style.display = 'block';
    this.canvas.style.background = '#fff';
    this.canvas.style.imageRendering = 'pixelated';
    this.canvas.style.transformOrigin = 'center';
    this.canvas.style.transform = 'scaleY(-1)';

    // GL init
    const gl = this.canvas.getContext('webgl2', GL_OPTS) || this.canvas.getContext('webgl', GL_OPTS);
    if (!gl) throw new Error('WebGL not supported for AsciiPass');
    this.gl = gl;
    gl.clearColor(1, 1, 1, 1);

    // Geometry & program
    this._quad = createQuad(gl);
    this._buildProgram(gl); // compiles with the current ramp length

    // Glyph atlas – now 256-ASCII regardless of ramp
    this._atlas = buildAtlas(
      gl,
      this.cellWDevice,
      this.cellHDevice,
      { family: this.family },
      this.alphaGamma
    );

    // Source texture
    this._srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.cols, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  setGridSize(cols, rows) {
    const c = cols | 0, r = rows | 0;
    if (c <= 0 || r <= 0) return;
    if (c === this.cols && r === this.rows) return;

    this.cols = c;
    this.rows = r;
    this._sizeCanvasToGrid();

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.cols, this.rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }

  drawFromBuffer(rgbaBuffer, srcCols, srcRows) {
    this.blit(rgbaBuffer, srcCols, srcRows);
    this.draw();
  }

  blit(rgbaBuffer, srcCols, srcRows) {
    if (!rgbaBuffer) return;

    // Resize grid/texture if the source size changed
    if ((srcCols | 0) !== (this.cols | 0) || (srcRows | 0) !== (this.rows | 0)) {
      this.setGridSize(srcCols | 0, srcRows | 0);
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // we flip via CSS, not here
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.cols, this.rows, gl.RGBA, gl.UNSIGNED_BYTE, rgbaBuffer);
  }

  draw() {
    const gl = this.gl;

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._prog);

    // fullscreen quad
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // bind source (grid RGBA) and atlas
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.uniform1i(this._u.srcTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this._atlas.tex);
    gl.uniform1i(this._u.atlasTex, 1);

    // uniforms
    gl.uniform2f(this._u.gridSize, this.cols, this.rows);
    gl.uniform2f(this._u.cellPx, this.cellWDevice, this.cellHDevice);
    gl.uniform2f(this._u.canvasPx, this.canvas.width, this.canvas.height);
    gl.uniform4f(
      this._u.atlasLayout,
      this._atlas.tileW, this._atlas.tileH,
      this._atlas.tilesPerRow, this._atlas.count
    );
    gl.uniform1f(this._u.padPx, this._atlas.pad || 2);
    gl.uniform1f(this._u.alphaGamma, this.alphaGamma);
    gl.uniform1f(this._u.gray, this.grayscaleText ? 1.0 : 0.0);
    // NEW: pass the toggle to the shader (0.0 or 1.0)
    gl.uniform1f(this._u.transparentBG, this.transparentBackground ? 1.0 : 0.0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  setCellSize(cwCSS, chCSS) {
    // Use provided CSS size or read from DOM
    if (!cwCSS || !chCSS) {
      const measEl = document.getElementById('measure');
      if (measEl) {
        const cs = getComputedStyle(measEl);
        const rect = measEl.getBoundingClientRect();
        cwCSS = rect.width;
        chCSS = rect.height;
        this.family = cs.fontFamily || this.family;
      }
    }

    this.cwCSS = Math.max(0.5, +cwCSS);
    this.chCSS = Math.max(0.5, +chCSS);
    this.dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.cellWDevice = Math.max(1, Math.round(this.cwCSS * this.dpr));
    this.cellHDevice = Math.max(1, Math.round(this.chCSS * this.dpr));
    this._sizeCanvasToGrid();

    const gl = this.gl;
    if (this._atlas?.tex) gl.deleteTexture(this._atlas.tex);
    this._atlas = buildAtlas(gl, this.cellWDevice, this.cellHDevice, { family: this.family }, this.alphaGamma);
  }

  // replace _sizeCanvasToGrid()
  _sizeCanvasToGrid() {
    // CSS sizes (fractional allowed) — these define *visual* positions
    const cssW = this.cols * this.cwCSS;
    const cssH = this.rows * this.chCSS;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    // Backing store: round ONCE at the total size to avoid per-cell accumulation
    const Wdev = Math.max(1, Math.round(cssW * this.dpr));
    const Hdev = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.width = Wdev;
    this.canvas.height = Hdev;

    // Device "cell size" used for shader addressing (can be fractional)
    // These keep GL math exactly aligned to DOM cell edges in CSS space.
    this.cellWDevice = Wdev / this.cols;
    this.cellHDevice = Hdev / this.rows;

    // Atlas tiles are still baked at *integer* device px close to CSS*DPR
    this._atlasCellW = Math.max(1, Math.round(this.cwCSS * this.dpr));
    this._atlasCellH = Math.max(1, Math.round(this.chCSS * this.dpr));
  }

  // replace _buildProgram(gl)
  _buildProgram(gl) {
    const RAMP_LEN = Math.max(1, this.ramp.length) | 0;

    const vs = `
      attribute vec2 aPos;
      varying vec2 vUv;
      void main(){
        vUv = aPos * 0.5 + 0.5;
        gl_Position = vec4(aPos, 0.0, 1.0);
      }
    `;// Build a tiny mapper: ramp index -> ASCII code for the character at that index.
    const _ramp = Array.from(this.ramp);
    const GLSL_RAMPIDX_TO_ASCII = `
int asciiFromRampIndex(int idx){
  ${_ramp.map((ch, i) =>
      `${i === 0 ? '' : 'else '}if (idx == ${i}) return ${ch.charCodeAt(0)};`
    ).join('\n  ')}
  return 32; // fallback to space if out of range
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

// Simple average intensity, to match CPU path: (r+g+b)/3
float avgRGB(vec3 c){ return (c.r + c.g + c.b) / 3.0; }
bool texelIsTransparent(float a){ return a <= 0.0; }

// JS-injected mapper: ramp index -> ASCII code
${GLSL_RAMPIDX_TO_ASCII}

// Ramp length as a compile-time constant for the luminance path
const int RAMP_LEN = ${this.ramp.length};

void main(){
  vec2 pix = gl_FragCoord.xy;

  // Cell index
  vec2 cell = floor(pix / uCellPx);
  cell = clamp(cell, vec2(0.0), uGridSize - vec2(1.0));

  // Source sample at cell center
  vec2 srcUV     = (cell + 0.5) / uGridSize;
  vec4 srcSample = texture2D(uSrc, srcUV);
  vec3 srcColor  = srcSample.rgb;

  // Decide glyph (atlas index == ASCII code)
  float aByte = srcSample.a * 255.0 + 0.5;
  int   aInt  = int(floor(aByte));
  bool useAsciiOverride = (aInt >= 2 && aInt <= 254);

  int asciiCode;
  if (useAsciiOverride) {
    // Draw the exact ASCII glyph from the atlas
    asciiCode = aInt;
  } else {
  // Quantize by simple average (CPU match) with a tiny epsilon to avoid exact-top-bin flips
  float iF   = avgRGB(srcColor);
  iF         = clamp(iF, 0.0, 1.0 - 1e-6);                // <- epsilon here
  float idxF = floor(iF * float(RAMP_LEN - 1) + 0.5);     // round()
  idxF       = clamp(idxF, 0.0, float(RAMP_LEN - 1));     // WebGL1-safe clamp
  int   rIdx = int(idxF);
  asciiCode  = asciiFromRampIndex(rIdx);
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
  vec3 tint   = mix(srcColor, vec3(0.0), uGray);
  vec3 outCol = mix(vec3(1.0), tint, cov);
  gl_FragColor = vec4(outCol, 1.0);
}
`;

    const vso = compile(gl, gl.VERTEX_SHADER, vs);
    const fso = compile(gl, gl.FRAGMENT_SHADER, fs);
    const prog = link(gl, vso, fso);
    gl.deleteShader(vso); gl.deleteShader(fso);

    this._prog = prog;
    const U = (n) => gl.getUniformLocation(prog, n);
    this._u = {
      srcTex: U('uSrc'),
      atlasTex: U('uAtlas'),
      gridSize: U('uGridSize'),
      cellPx: U('uCellPx'),
      canvasPx: U('uCanvasPx'),
      atlasLayout: U('uAtlasLayout'),
      padPx: U('uPadPx'),
      alphaGamma: U('uAlphaGamma'),
      gray: U('uGray'),
      transparentBG: U('uTransparentBG'),
    };
  }
}
