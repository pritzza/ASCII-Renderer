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

const DBG = false; // toggle tiny debug prints

/* ------------------------------- TracerPass ------------------------------- */
// (unchanged, except it now imports buildTracerSources from ./pathtrace_shader.js)
export class TracerPass {
  constructor(gl, quadVbo, PT) {
    // Soft limits (small defaults to stay within WebGL uniform caps)
    this.lims = {
      MAX_SPHERES: (PT?.LIMITS?.MAX_SPHERES ?? 8) | 0,
      MAX_TRIS:    (PT?.LIMITS?.MAX_TRIS    ?? 64) | 0,
      MAX_QUADS:   (PT?.LIMITS?.MAX_QUADS   ?? 32) | 0,
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

    // Scene uniforms (counts)
    this.uNumS  = gl.getUniformLocation(this.prog, 'uNumSpheres');
    this.uNumT  = gl.getUniformLocation(this.prog, 'uNumTris');
    this.uNumQ  = gl.getUniformLocation(this.prog, 'uNumQuads');

    // Spheres
    this.uSpheres     = gl.getUniformLocation(this.prog, 'uSpheres[0]');       // vec4 xyzr
    this.uSphereMatId = gl.getUniformLocation(this.prog, 'uSphereMatId[0]');   // uint[]

    // Triangles
    this.uTriA        = gl.getUniformLocation(this.prog, 'uTriA[0]');          // vec3[]
    this.uTriB        = gl.getUniformLocation(this.prog, 'uTriB[0]');          // vec3[]
    this.uTriC        = gl.getUniformLocation(this.prog, 'uTriC[0]');          // vec3[]
    this.uTriMatId    = gl.getUniformLocation(this.prog, 'uTriMatId[0]');      // uint[]
    this.uTriUVA      = gl.getUniformLocation(this.prog, 'uTriUVA[0]');        // uvec2[]
    this.uTriUVB      = gl.getUniformLocation(this.prog, 'uTriUVB[0]');        // uvec2[]
    this.uTriUVC      = gl.getUniformLocation(this.prog, 'uTriUVC[0]');        // uvec2[]

    // Quads
    this.uQuadA       = gl.getUniformLocation(this.prog, 'uQuadA[0]');         // vec3[]
    this.uQuadB       = gl.getUniformLocation(this.prog, 'uQuadB[0]');         // vec3[]
    this.uQuadC       = gl.getUniformLocation(this.prog, 'uQuadC[0]');         // vec3[]
    this.uQuadD       = gl.getUniformLocation(this.prog, 'uQuadD[0]');         // vec3[]
    this.uQuadMatId   = gl.getUniformLocation(this.prog, 'uQuadMatId[0]');     // uint[]
    this.uQuadUV0     = gl.getUniformLocation(this.prog, 'uQuadUV0[0]');       // uvec2[]
    this.uQuadUV1     = gl.getUniformLocation(this.prog, 'uQuadUV1[0]');       // uvec2[]
    this.uQuadUV2     = gl.getUniformLocation(this.prog, 'uQuadUV2[0]');       // uvec2[]
    this.uQuadUV3     = gl.getUniformLocation(this.prog, 'uQuadUV3[0]');       // uvec2[]

    // Texture atlas (RGBA8, nearest, texelFetch sampling)
    this.uAtlas      = gl.getUniformLocation(this.prog, 'uAtlas');
    this.uAtlasSize  = gl.getUniformLocation(this.prog, 'uAtlasSize');         // ivec2

    // Light: static or animated
    this.uLightC    = gl.getUniformLocation(this.prog, 'uLightCenter');
    this.uLightR    = gl.getUniformLocation(this.prog, 'uLightRadius');
    this.uLightAuto = gl.getUniformLocation(this.prog, 'uLightAuto');

    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    bindQuadAttrib(gl, quadVbo);

    // Scratch CPU buffers to avoid re-allocs
    const { MAX_SPHERES, MAX_TRIS, MAX_QUADS } = this.lims;

    // spheres
    this._bufS_xyzr = new Float32Array(MAX_SPHERES * 4);
    this._bufS_mat  = new Uint32Array(MAX_SPHERES);

    // tris
    this._bufTa = new Float32Array(MAX_TRIS * 3);
    this._bufTb = new Float32Array(MAX_TRIS * 3);
    this._bufTc = new Float32Array(MAX_TRIS * 3);
    this._bufTm = new Uint32Array(MAX_TRIS);
    this._bufTuvA = new Uint32Array(MAX_TRIS * 2);
    this._bufTuvB = new Uint32Array(MAX_TRIS * 2);
    this._bufTuvC = new Uint32Array(MAX_TRIS * 2);

    // quads
    this._bufQa = new Float32Array(MAX_QUADS * 3);
    this._bufQb = new Float32Array(MAX_QUADS * 3);
    this._bufQc = new Float32Array(MAX_QUADS * 3);
    this._bufQd = new Float32Array(MAX_QUADS * 3);
    this._bufQm = new Uint32Array(MAX_QUADS);
    this._bufQuv0 = new Uint32Array(MAX_QUADS * 2);
    this._bufQuv1 = new Uint32Array(MAX_QUADS * 2);
    this._bufQuv2 = new Uint32Array(MAX_QUADS * 2);
    this._bufQuv3 = new Uint32Array(MAX_QUADS * 2);

    if (DBG) console.log('[PT] TracerPass init', this.lims);
  }

  // (logic unchanged; just fixed radius upload previously)
  uploadScene(gl, scene){
    if (!scene) {
      gl.uniform1i(this.uNumS, 0);
      gl.uniform1i(this.uNumT, 0);
      gl.uniform1i(this.uNumQ, 0);
      gl.uniform3f(this.uLightC, 3, 2.8, 3);
      gl.uniform1f(this.uLightR, 0.5);
      gl.uniform1f(this.uLightAuto, 1.0);
      gl.uniform2i(this.uAtlasSize, 1, 1);
      if (DBG) console.log('[PT] uploadScene: empty');
      return;
    }

    // --- LIGHT (support new lights.area + legacy light) ---
    let lc = [3,2.8,3], lr = 0.5, la = true;
    if (scene.lights && scene.lights.area) {
      const A = scene.lights.area;
      lc = A.center || lc; lr = (A.radius ?? lr); la = !!A.auto;
    } else if (scene.light) {
      const L = scene.light;
      lc = L.c || lc; lr = (L.r ?? lr); la = !!L.auto;
    }
    gl.uniform3f(this.uLightC, lc[0], lc[1], lc[2]);
    gl.uniform1f(this.uLightR, lr);
    gl.uniform1f(this.uLightAuto, la ? 1.0 : 0.0);

    // --- ATLAS ---
    const aw = (scene.atlas?.width|0) || 1;
    const ah = (scene.atlas?.height|0) || 1;
    gl.uniform2i(this.uAtlasSize, aw, ah);

    // --- GEOMETRY (support new scene.geometry.*, with fallback to legacy top-level) ---
    const G = scene.geometry || scene;
    const S = Array.isArray(G.spheres) ? G.spheres : [];
    const T = Array.isArray(G.tris)    ? G.tris    : [];
    const Q = Array.isArray(G.quads)   ? G.quads   : [];

    // Spheres
    const nS = Math.min(S.length|0, this.lims.MAX_SPHERES);
    this._bufS_xyzr.fill(0); this._bufS_mat.fill(0);
    for (let i = 0; i < nS; i++) {
      const s = S[i];
      const p = s.p || [0,0,0];
      const r = (+s.r || 0);
      const m = (s.matId>>>0) || 0;
      const off = i * 4;
      this._bufS_xyzr[off + 0] = p[0] || 0;
      this._bufS_xyzr[off + 1] = p[1] || 0;
      this._bufS_xyzr[off + 2] = p[2] || 0;
      this._bufS_xyzr[off + 3] = r;            // radius
      this._bufS_mat[i] = m>>>0;
    }
    gl.uniform1i(this.uNumS, nS);
    if (nS > 0) {
      gl.uniform4fv(this.uSpheres, this._bufS_xyzr);
      gl.uniform1uiv(this.uSphereMatId, this._bufS_mat);
    }

    // Triangles
    const nT = Math.min(T.length|0, this.lims.MAX_TRIS);
    this._bufTa.fill(0); this._bufTb.fill(0); this._bufTc.fill(0);
    this._bufTm.fill(0);
    this._bufTuvA.fill(0); this._bufTuvB.fill(0); this._bufTuvC.fill(0);
    for (let i = 0; i < nT; i++) {
      const t = T[i];
      const a = t.a || [0,0,0];
      const b = t.b || [1,0,0];
      const c = t.c || [0,1,0];
      const m = (t.matId>>>0) || 0;
      const uvA = t.uvA || [0,0];
      const uvB = t.uvB || [0,0];
      const uvC = t.uvC || [0,0];
      const off = i * 3;
      this._bufTa[off + 0] = a[0] || 0; this._bufTa[off + 1] = a[1] || 0; this._bufTa[off + 2] = a[2] || 0;
      this._bufTb[off + 0] = b[0] || 0; this._bufTb[off + 1] = b[1] || 0; this._bufTb[off + 2] = b[2] || 0;
      this._bufTc[off + 0] = c[0] || 0; this._bufTc[off + 1] = c[1] || 0; this._bufTc[off + 2] = c[2] || 0;
      this._bufTm[i] = m>>>0;
      const uvOff = i * 2;
      this._bufTuvA[uvOff + 0] = (uvA[0]|0)>>>0; this._bufTuvA[uvOff + 1] = (uvA[1]|0)>>>0;
      this._bufTuvB[uvOff + 0] = (uvB[0]|0)>>>0; this._bufTuvB[uvOff + 1] = (uvB[1]|0)>>>0;
      this._bufTuvC[uvOff + 0] = (uvC[0]|0)>>>0; this._bufTuvC[uvOff + 1] = (uvC[1]|0)>>>0;
    }
    gl.uniform1i(this.uNumT, nT);
    if (nT > 0) {
      gl.uniform3fv(this.uTriA, this._bufTa);
      gl.uniform3fv(this.uTriB, this._bufTb);
      gl.uniform3fv(this.uTriC, this._bufTc);
      gl.uniform1uiv(this.uTriMatId, this._bufTm);
      gl.uniform2uiv(this.uTriUVA, this._bufTuvA);
      gl.uniform2uiv(this.uTriUVB, this._bufTuvB);
      gl.uniform2uiv(this.uTriUVC, this._bufTuvC);
    }

    // Quads
    const nQ = Math.min(Q.length|0, this.lims.MAX_QUADS);
    this._bufQa.fill(0); this._bufQb.fill(0); this._bufQc.fill(0); this._bufQd.fill(0);
    this._bufQm.fill(0);
    this._bufQuv0.fill(0); this._bufQuv1.fill(0); this._bufQuv2.fill(0); this._bufQuv3.fill(0);
    for (let i = 0; i < nQ; i++) {
      const q = Q[i];
      const a = q.a || [0,0,0];
      const b = q.b || [1,0,0];
      const c = q.c || [1,1,0];
      const d = q.d || [0,1,0];
      const m = (q.matId>>>0) || 0;
      const uv0 = q.uv0 || [0,0];
      const uv1 = q.uv1 || [0,0];
      const uv2 = q.uv2 || [0,0];
      const uv3 = q.uv3 || [0,0];
      const off = i * 3;
      this._bufQa[off + 0] = a[0] || 0; this._bufQa[off + 1] = a[1] || 0; this._bufQa[off + 2] = a[2] || 0;
      this._bufQb[off + 0] = b[0] || 0; this._bufQb[off + 1] = b[1] || 0; this._bufQb[off + 2] = b[2] || 0;
      this._bufQc[off + 0] = c[0] || 0; this._bufQc[off + 1] = c[1] || 0; this._bufQc[off + 2] = c[2] || 0;
      this._bufQd[off + 0] = d[0] || 0; this._bufQd[off + 1] = d[1] || 0; this._bufQd[off + 2] = d[2] || 0;
      this._bufQm[i] = m>>>0;
      const uvOff = i * 2;
      this._bufQuv0[uvOff + 0] = (uv0[0]|0)>>>0; this._bufQuv0[uvOff + 1] = (uv0[1]|0)>>>0;
      this._bufQuv1[uvOff + 0] = (uv1[0]|0)>>>0; this._bufQuv1[uvOff + 1] = (uv1[1]|0)>>>0;
      this._bufQuv2[uvOff + 0] = (uv2[0]|0)>>>0; this._bufQuv2[uvOff + 1] = (uv2[1]|0)>>>0;
      this._bufQuv3[uvOff + 0] = (uv3[0]|0)>>>0; this._bufQuv3[uvOff + 1] = (uv3[1]|0)>>>0;
    }
    gl.uniform1i(this.uNumQ, nQ);
    if (nQ > 0) {
      gl.uniform3fv(this.uQuadA, this._bufQa);
      gl.uniform3fv(this.uQuadB, this._bufQb);
      gl.uniform3fv(this.uQuadC, this._bufQc);
      gl.uniform3fv(this.uQuadD, this._bufQd);
      gl.uniform1uiv(this.uQuadMatId, this._bufQm);
      gl.uniform2uiv(this.uQuadUV0, this._bufQuv0);
      gl.uniform2uiv(this.uQuadUV1, this._bufQuv1);
      gl.uniform2uiv(this.uQuadUV2, this._bufQuv2);
      gl.uniform2uiv(this.uQuadUV3, this._bufQuv3);
    }

    if (DBG) console.log('[PT] uploadScene', { S:nS, T:nT, Q:nQ, atlas:[aw,ah] });
  }

  draw(gl, { time, width, height, cam, fovY, gamma, scene, atlasTex }) {
    gl.useProgram(this.prog);

    // Scene first
    this.uploadScene(gl, scene);

    // Bind atlas (unit 2)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(this.uAtlas, 2);

    gl.uniform3f(this.uRes,  width, height, 1.0);
    gl.uniform1f(this.uTime, time);
    gl.uniform4f(this.uMouse, 0, 0, 0, 0);
    gl.uniform3f(this.uPos,   cam.x, cam.y, cam.z);
    gl.uniform1f(this.uYaw,   cam.yaw);
    gl.uniform1f(this.uPitch, cam.pitch);
    gl.uniform1f(this.uFovY,  fovY);
    gl.uniform1f(this.uGamma, gamma);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (DBG) console.log('[PT] draw', { w:width, h:height });
  }

  dispose(gl) {
    if (this.prog) gl.deleteProgram(this.prog);
    this.prog = null;
    if (DBG) console.log('[PT] TracerPass dispose');
  }
}

/* ---------------------------- PathtraceBackend ---------------------------- */
export class PathtraceBackend {
  constructor(){
    this.name = 'pathtrace';
    this._gl = null;
    this._fbo = null; this._width = 0; this._height = 0;

    this._quad = null;   // screen quad VBO
    this._pass = null;   // TracerPass instance
    this._scene = null;  // PT-shaped scene: { geometry:{spheres,tris,quads}, lights:{area}, atlas:{width,height,…} }
    this._atlasTex = null; // WebGLTexture for RGBA8 atlas
    this._lastPixels = null;
  }

  _ensureGL(){
    if (this._gl) return;
    const { gl } = createGL(); // Prefer WebGL2 inside createGL; required for texelFetch/int uniforms
    // Guard: require WebGL2
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('WebGL2 is required for the path tracer (texelFetch + integer uniforms).');
    }
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

    // Create a 1x1 fallback atlas
    this._atlasTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0,0,0,255]));
    if (DBG) console.log('[PT] GL2 ready');
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
    if (DBG) console.log('[PT] target', {w:this._width,h:this._height});
  }

  _ensureAtlasTexture(){
    const gl = this._gl;
    const A = this._scene?.atlas;
    if (!A || !A.pixels || !A.width || !A.height) return; // nothing to upload
    // Upload or re-upload atlas (RGBA8, nearest)
    gl.bindTexture(gl.TEXTURE_2D, this._atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const data = (A.pixels instanceof Uint8Array) ? A.pixels : new Uint8Array(A.pixels);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, A.width|0, A.height|0, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    if (DBG) console.log('[PT] atlas upload', {w:A.width|0,h:A.height|0});
  }

  dispose(){
    const gl = this._gl; if (!gl) return;
    if (this._pass) this._pass.dispose(gl);
    if (this._quad) gl.deleteBuffer(this._quad);
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    if (this._atlasTex) gl.deleteTexture(this._atlasTex);
    this._gl = null; this._quad = null; this._pass = null; this._fbo = null;
    this._atlasTex = null;
    this._lastPixels = null;
    if (DBG) console.log('[PT] backend dispose');
  }

  // Accept PT-shaped scene directly.
  // If you include { atlas: { width, height, pixels: Uint8Array } } it will be uploaded to uAtlas.
  setScene(scene){
    this._scene = scene || null;
    if (DBG && scene) {
      const G = scene.geometry || scene;
      console.log('[PT] setScene', {
        v: scene.version, S: (G.spheres||[]).length, T: (G.tris||[]).length, Q: (G.quads||[]).length,
        atlas: scene.atlas ? [scene.atlas.width|0, scene.atlas.height|0] : [0,0]
      });
    }
  }

  render(timeSec, framebuffer, appState){
    const gl = (this._ensureGL(), this._gl);
    const w  = (appState?.cols|0) || (config.VIRTUAL_GRID_WIDTH|0) || 1;
    const h  = (appState?.rows|0) || (config.VIRTUAL_GRID_HEIGHT|0) || 1;
    this._ensureTarget(w, h);
    if (!this._scene) return;

    // Ensure atlas upload if provided on scene
    this._ensureAtlasTexture();

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
      atlasTex: this._atlasTex,
    });

    // Readback
    const px = new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE, px);
    if (framebuffer && framebuffer.length === px.length) flipAndCopy(px, framebuffer, w, h);
    this._lastPixels = px;
    if (DBG) console.log('[PT] frame done');
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
