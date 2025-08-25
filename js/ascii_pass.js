// js/ascii_pass.js
// GPU ASCII pass that matches DOM rendering, with optional modal smoothing:
//  • Colored glyphs (quantized like the DOM path unless USE_GRAYSCALE=true)
//  • Glyph weight matched via alpha gamma and pixel-center sampling
//  • Exact sizing: CSS size from #measure (fractional), device size = CSS * DPR
//  • Atlas baked in DEVICE pixels with the same font as #measure (NEAREST)
//  • NEW: Modal (majority) smoothing of ramp-quantized glyphs (never touches UI overrides)

import { config } from './config.js';
import { buildAsciiPassShaderSources } from './ascii_pass_shader.js';

const GL_OPTS = {
  antialias: false,
  alpha: false,
  powerPreference: 'high-performance',
  desynchronized: true,
};

/* ------------------------------ Glyph atlas (DEVICE px) ------------------------------ */
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
  const baselineOffsetY = (cellHDevice - glyphH) * 0.5 + ascent;

  for (let i = 0; i < count; i++) {
    const gx = (i % tilesPerRow);
    const gy = Math.floor(i / tilesPerRow);
    const ox = gx * tileW + pad;
    const oy = gy * tileH + pad;
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
    this.alphaGamma = Number.isFinite(opts.alphaGamma) ? opts.alphaGamma : 1.20;
    this.alphaBias = Number.isFinite(opts.alphaBias) ? opts.alphaBias : 0.045;
    this.transparentBackground = opts.transparentBackground !== undefined ? !!opts.transparentBackground : true;

    // Modal smoothing controls (from config)
    this.modeFilter = !!config.ASCII_MODE_FILTER;
    const k = Math.max(3, (config.ASCII_MODE_KERNEL | 0) || 3);
    this.modeRadius = Math.max(1, ((k - 1) / 2) | 0); // 3->1, 5->2, 7->3
    this.modeThresh = Math.max(1, (config.ASCII_MODE_THRESH | 0) || 5);

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

    // Glyph atlas – 256-ASCII regardless of ramp
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

    if ((srcCols | 0) !== (this.cols | 0) || (srcRows | 0) !== (this.rows | 0)) {
      this.setGridSize(srcCols | 0, srcRows | 0);
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this._srcTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
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
    gl.uniform1f(this._u.transparentBG, this.transparentBackground ? 1.0 : 0.0);

    // modal smoothing controls
    gl.uniform1i(this._u.modeOn, this.modeFilter ? 1 : 0);
    // limit radius to shader's MAX_MODE_RADIUS
    const MAX_MODE_RADIUS = 3; // must match shader define
    const r = Math.max(1, Math.min(MAX_MODE_RADIUS, this.modeRadius | 0));
    gl.uniform1i(this._u.modeRadius, r);
    gl.uniform1i(this._u.modeThresh, this.modeThresh | 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  setCellSize(cwCSS, chCSS) {
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

  _sizeCanvasToGrid() {
    const cssW = this.cols * this.cwCSS;
    const cssH = this.rows * this.chCSS;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    const Wdev = Math.max(1, Math.round(cssW * this.dpr));
    const Hdev = Math.max(1, Math.round(cssH * this.dpr));
    this.canvas.width = Wdev;
    this.canvas.height = Hdev;

    this.cellWDevice = Wdev / this.cols;
    this.cellHDevice = Hdev / this.rows;

    this._atlasCellW = Math.max(1, Math.round(this.cwCSS * this.dpr));
    this._atlasCellH = Math.max(1, Math.round(this.chCSS * this.dpr));
  }

  _buildProgram(gl) {
    const { vs, fs } = buildAsciiPassShaderSources(this.ramp);

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
      // modal smoothing
      modeOn: U('uModeOn'),
      modeRadius: U('uModeRadius'),
      modeThresh: U('uModeThresh'),
    };
  }
}
