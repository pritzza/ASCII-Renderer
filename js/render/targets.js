// js/render/targets.js
import { createFboWithTex } from './gl/context.js';

export class Targets {
  constructor(gl) {
    this.gl = gl;
    this.width = 0;
    this.height = 0;

    this.current = { tex: null, fb: null };
    this.accum   = [{ tex: null, fb: null }, { tex: null, fb: null }];
    this.historyIdx = 0;
    this.scratch = null;

    this.maskTex = null;     // WxH per-pixel active mask (LUMINANCE)
    this.maskOneTex = null;  // 1x1 LUMINANCE=255 (always active)

    // Create the 1x1 mask once (value = 255)
    this.maskOneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskOneTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const one = new Uint8Array([255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 1, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, one);
  }

  ensure(width, height) {
    if (width === this.width && height === this.height) return;
    const gl = this.gl;

    this.width  = width;
    this.height = height;

    gl.canvas.width  = width;
    gl.canvas.height = height;

    // current
    if (this.current.fb) gl.deleteFramebuffer(this.current.fb);
    if (this.current.tex) gl.deleteTexture(this.current.tex);
    this.current = createFboWithTex(gl, width, height);

    // accum ping-pong
    for (let i = 0; i < 2; i++) {
      if (this.accum[i].fb) gl.deleteFramebuffer(this.accum[i].fb);
      if (this.accum[i].tex) gl.deleteTexture(this.accum[i].tex);
      this.accum[i] = createFboWithTex(gl, width, height);

      // clear to zero so first read has defined contents
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum[i].fb);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.historyIdx = 0;

    // WxH adaptive mask (contents will be filled by renderer via texSubImage2D)
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);

    // CPU scratch for readPixels()
    this.scratch = new Uint8Array(width * height * 4);
  }

  dispose() {
    const gl = this.gl;
    if (this.current.fb) gl.deleteFramebuffer(this.current.fb);
    if (this.current.tex) gl.deleteTexture(this.current.tex);
    for (let i = 0; i < 2; i++) {
      if (this.accum[i].fb) gl.deleteFramebuffer(this.accum[i].fb);
      if (this.accum[i].tex) gl.deleteTexture(this.accum[i].tex);
    }
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    if (this.maskOneTex) gl.deleteTexture(this.maskOneTex);

    this.current = { tex: null, fb: null };
    this.accum   = [{ tex: null, fb: null }, { tex: null, fb: null }];
    this.maskTex = null;
    this.maskOneTex = null;
    this.historyIdx = 0;
    this.scratch = null;
  }
}
