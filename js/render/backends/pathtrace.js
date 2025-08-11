// js/render/backends/pathtrace.js
// Path tracer backend following the same contract as raster/raytrace:
//   setScene(), render(), renderRaw(), getPixels(), dispose()
// Keeps all tracer logic intact; this file only adapts it to the backend API.

import {
  createGL, createFboWithTex, flipAndCopy,
  compile, link, bindQuadAttrib
} from '../gl/context.js';
import { buildTracerSources } from './pathtrace_shader.js';
import { config } from '../../config.js';
import { camera as LiveCamera } from '../../camera.js';

/* ------------------------------- TracerPass ------------------------------- */
// (unchanged, except it now imports buildTracerSources from ./pathtrace_shader.js)
export class TracerPass {
  constructor(gl, quadVbo, PT) {
    // Soft limits (small defaults to stay within WebGL1 uniform caps)
    this.lims = {
      MAX_SPHERES: (PT?.LIMITS?.MAX_SPHERES ?? 32) | 0,
      MAX_PLANES:  (PT?.LIMITS?.MAX_PLANES  ?? 16) | 0,
      MAX_TRIS:    (PT?.LIMITS?.MAX_TRIS    ?? 64) | 0,
    };

    const { vs, fs } = buildTracerSources({ ...PT, LIMITS: this.lims });
    const v = compile(gl, gl.VERTEX_SHADER,   vs);
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    this.prog = link(gl, v, f);
    gl.deleteShader(v); gl.deleteShader(f);

    gl.useProgram(this.prog);
    this.uRes   = gl.getUniformLocation(this.prog, 'iResolution');
    this.uTime  = gl.getUniformLocation(this.prog, 'iTime');
    this.uMouse = gl.getUniformLocation(this.prog, 'iMouse');
    this.uPos   = gl.getUniformLocation(this.prog, 'uCamPos');
    this.uYaw   = gl.getUniformLocation(this.prog, 'uYaw');
    this.uPitch = gl.getUniformLocation(this.prog, 'uPitch');
    this.uFovY  = gl.getUniformLocation(this.prog, 'uFovY');
    this.uGamma = gl.getUniformLocation(this.prog, 'uGamma');

    // Scene uniforms
    this.uNumS  = gl.getUniformLocation(this.prog, 'uNumSpheres');
    this.uNumP  = gl.getUniformLocation(this.prog, 'uNumPlanes');
    this.uNumT  = gl.getUniformLocation(this.prog, 'uNumTris');

    // Array bases (use [0] to upload packed arrays)
    this.uSpheres = gl.getUniformLocation(this.prog, 'uSpheres[0]');
    this.uSphereM = gl.getUniformLocation(this.prog, 'uSphereM[0]');

    this.uPlanes  = gl.getUniformLocation(this.prog, 'uPlanes[0]');
    this.uPlaneM  = gl.getUniformLocation(this.prog, 'uPlaneM[0]');

    this.uTriA    = gl.getUniformLocation(this.prog, 'uTriA[0]');
    this.uTriB    = gl.getUniformLocation(this.prog, 'uTriB[0]');
    this.uTriC    = gl.getUniformLocation(this.prog, 'uTriC[0]');
    this.uTriM    = gl.getUniformLocation(this.prog, 'uTriM[0]');

    // Light: static or animated
    this.uLightC    = gl.getUniformLocation(this.prog, 'uLightCenter');
    this.uLightR    = gl.getUniformLocation(this.prog, 'uLightRadius');
    this.uLightAuto = gl.getUniformLocation(this.prog, 'uLightAuto');

    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    bindQuadAttrib(gl, quadVbo);

    // Scratch CPU buffers to avoid re-allocs
    const { MAX_SPHERES, MAX_PLANES, MAX_TRIS } = this.lims;
    this._bufS  = new Float32Array(MAX_SPHERES * 4);
    this._bufSm = new Float32Array(MAX_SPHERES);
    this._bufP  = new Float32Array(MAX_PLANES  * 4);
    this._bufPm = new Float32Array(MAX_PLANES);
    this._bufTa = new Float32Array(MAX_TRIS * 3);
    this._bufTb = new Float32Array(MAX_TRIS * 3);
    this._bufTc = new Float32Array(MAX_TRIS * 3);
    this._bufTm = new Float32Array(MAX_TRIS);
  }

  // (logic unchanged; just fixed radius upload previously)
  uploadScene(gl, scene){
    if (!scene) {
      gl.uniform1i(this.uNumS, 0);
      gl.uniform1i(this.uNumP, 0);
      gl.uniform1i(this.uNumT, 0);
      gl.uniform3f(this.uLightC, 3, 2.8, 3);
      gl.uniform1f(this.uLightR, 0.5);
      gl.uniform1f(this.uLightAuto, 1.0);
      return;
    }

    // Light (static or animated)
    const lc = scene.light?.c ?? [3,2.8,3];
    const lr = scene.light?.r ?? 0.5;
    const la = !!scene.light?.auto;
    gl.uniform3f(this.uLightC, lc[0], lc[1], lc[2]);
    gl.uniform1f(this.uLightR, lr);
    gl.uniform1f(this.uLightAuto, la ? 1.0 : 0.0);

    // Spheres
    const S = scene.spheres ?? [];
    const nS = Math.min(S.length|0, this.lims.MAX_SPHERES);
    this._bufS.fill(0); this._bufSm.fill(0);
    for (let i = 0; i < nS; i++) {
      const s = S[i];
      const p = s.p || [0,0,0];
      const r = (+s.r || 0);
      const m = (+s.m || 0);
      const off = i * 4;
      this._bufS[off + 0] = p[0] || 0;
      this._bufS[off + 1] = p[1] || 0;
      this._bufS[off + 2] = p[2] || 0;
      this._bufS[off + 3] = r;            // radius (was missing in the bug)
      this._bufSm[i] = m;
    }
    gl.uniform1i(this.uNumS, nS);
    if (nS > 0) {
      gl.uniform4fv(this.uSpheres, this._bufS);
      gl.uniform1fv(this.uSphereM, this._bufSm);
    }

    // Planes
    const P = scene.planes ?? [];
    const nP = Math.min(P.length|0, this.lims.MAX_PLANES);
    this._bufP.fill(0); this._bufPm.fill(0);
    for (let i = 0; i < nP; i++) {
      const p = P[i].p || [0,1,0,0];
      const m = (+P[i].m || 0);
      const off = i * 4;
      this._bufP[off + 0] = p[0] || 0;
      this._bufP[off + 1] = p[1] || 0;
      this._bufP[off + 2] = p[2] || 0;
      this._bufP[off + 3] = p[3] || 0;
      this._bufPm[i] = m;
    }
    gl.uniform1i(this.uNumP, nP);
    if (nP > 0) {
      gl.uniform4fv(this.uPlanes, this._bufP);
      gl.uniform1fv(this.uPlaneM, this._bufPm);
    }

    // Triangles
    const T = scene.tris ?? [];
    const nT = Math.min(T.length|0, this.lims.MAX_TRIS);
    this._bufTa.fill(0); this._bufTb.fill(0); this._bufTc.fill(0); this._bufTm.fill(0);
    for (let i = 0; i < nT; i++) {
      const t = T[i];
      const a = t.a || [0,0,0];
      const b = t.b || [1,0,0];
      const c = t.c || [0,1,0];
      const m = (+t.m || 0);
      const off = i * 3;
      this._bufTa[off + 0] = a[0] || 0; this._bufTa[off + 1] = a[1] || 0; this._bufTa[off + 2] = a[2] || 0;
      this._bufTb[off + 0] = b[0] || 0; this._bufTb[off + 1] = b[1] || 0; this._bufTb[off + 2] = b[2] || 0;
      this._bufTc[off + 0] = c[0] || 0; this._bufTc[off + 1] = c[1] || 0; this._bufTc[off + 2] = c[2] || 0;
      this._bufTm[i] = m;
    }
    gl.uniform1i(this.uNumT, nT);
    if (nT > 0) {
      gl.uniform3fv(this.uTriA, this._bufTa);
      gl.uniform3fv(this.uTriB, this._bufTb);
      gl.uniform3fv(this.uTriC, this._bufTc);
      gl.uniform1fv(this.uTriM, this._bufTm);
    }
  }

  draw(gl, { time, width, height, cam, fovY, gamma, scene }) {
    gl.useProgram(this.prog);

    // Scene first
    this.uploadScene(gl, scene);

    gl.uniform3f(this.uRes,  width, height, 1.0);
    gl.uniform1f(this.uTime, time);
    gl.uniform4f(this.uMouse, 0, 0, 0, 0);
    gl.uniform3f(this.uPos,   cam.x, cam.y, cam.z);
    gl.uniform1f(this.uYaw,   cam.yaw);
    gl.uniform1f(this.uPitch, cam.pitch);
    gl.uniform1f(this.uFovY,  fovY);
    gl.uniform1f(this.uGamma, gamma);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose(gl) { if (this.prog) gl.deleteProgram(this.prog); this.prog = null; }
}

/* ---------------------------- PathtraceBackend ---------------------------- */
export class PathtraceBackend {
  constructor(){
    this.name = 'pathtrace';
    this._gl = null;
    this._fbo = null; this._width = 0; this._height = 0;

    this._quad = null;   // screen quad VBO
    this._pass = null;   // TracerPass instance
    this._scene = null;  // PT-shaped scene: {spheres, planes, tris, light, ...}
    this._lastPixels = null;
  }

  _ensureGL(){
    if (this._gl) return;
    const { gl } = createGL(); // WebGL1
    this._gl = gl;

    // Fullscreen quad
    this._quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1,-1,  1,-1,  1, 1,
      -1,-1,  1, 1, -1, 1,
    ]), gl.STATIC_DRAW);

    // PT config (honor config.PATH_TRACER but don't alter behavior)
    const PT = { ...(config.PATH_TRACER||{}) };
    this._pass = new TracerPass(gl, this._quad, PT);
  }

  _ensureTarget(w,h){
    this._ensureGL();
    const gl = this._gl;
    if (this._fbo && this._width===w && this._height===h) return;
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._fbo = createFboWithTex(gl, w|0, h|0);
    this._width = w|0; this._height = h|0;
  }

  dispose(){
    const gl = this._gl; if (!gl) return;
    if (this._pass) this._pass.dispose(gl);
    if (this._quad) gl.deleteBuffer(this._quad);
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._gl = null; this._quad = null; this._pass = null; this._fbo = null;
    this._lastPixels = null;
  }

  // Accept PT-shaped scene directly. If a unified scene slips in, we’ll
  // pass it through untouched (the app’s SceneBuilder should already
  // provide PT shape via toPathTracer()).
  setScene(scene){ this._scene = scene || null; }

  render(timeSec, framebuffer, appState){
    const gl = (this._ensureGL(), this._gl);
    const w  = (appState?.cols|0) || (config.VIRTUAL_GRID_WIDTH|0) || 1;
    const h  = (appState?.rows|0) || (config.VIRTUAL_GRID_HEIGHT|0) || 1;
    this._ensureTarget(w, h);
    if (!this._scene) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo.fb);
    gl.viewport(0,0,w,h);

    // Camera (live)
    const camLive = LiveCamera
      ? { x: LiveCamera.pos.x, y: LiveCamera.pos.y, z: LiveCamera.pos.z, yaw: LiveCamera.yaw, pitch: LiveCamera.pitch }
      : { x: 0, y: 0, z: 5, yaw: 0, pitch: 0 };

    const fovY = ((config.FOVY_DEG || 80) * Math.PI / 180);
    const gamma = 1.0; // uGamma is referenced with zero weight in shader

    this._pass.draw(gl, {
      time: timeSec, width: w, height: h,
      cam: camLive, fovY, gamma,
      scene: this._scene,
    });

    // Readback
    const px = new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE, px);
    if (framebuffer && framebuffer.length === px.length) flipAndCopy(px, framebuffer, w, h);
    this._lastPixels = px;
  }

  renderRaw(args){
    if (args?.framebuffer && args?.appState) {
      return this.render(args.time||0, args.framebuffer, args.appState);
    }
  }

  getPixels({ framebuffer, width, height, flipY=true } = {}){
    if (!this._lastPixels) return null;
    const w = width  || this._width;
    const h = height || this._height;
    if (framebuffer && framebuffer.length >= w*h*4){
      if (flipY) flipAndCopy(this._lastPixels, framebuffer, w, h);
      else framebuffer.set(this._lastPixels);
      return framebuffer;
    }
    return this._lastPixels;
  }
}
