// js/render/backends/raytrace.js
// Deterministic single-bounce ray tracer (WebGL1).
// Same contract as other backends:
//   - setScene(scene)
//   - render(timeSec, framebuffer, appState)
//   - renderRaw(args)
//   - getPixels({ framebuffer, width, height, flipY })
//   - dispose()
//
// Reads the unified scene (materials/lights/geometry). If a legacy PT
// shape is passed, we adapt it losslessly (no regressions).
//
// Notes:
// - No RNG, no accumulation.
// - Perfect mirror or diffuse only (materials.reflective flag).
// - Direct lighting from point + directional lights, hard shadows.
// - Environment tint on miss: lights.env.color * intensity.

import { createGL, compile, link, createFboWithTex, flipAndCopy } from '../gl/context.js';
import { config } from '../../config.js';
import { camera as LiveCamera } from '../../camera.js';
import { buildRaytraceSources } from './raytrace_shader.js';

export class RaytraceBackend {
  constructor() {
    this.name = 'raytrace';
    this._gl = null;
    this._prog = null;
    this._attribs = null;
    this._uniforms = null;
    this._quad = null; // { vbo, count }

    this._fbo = null;
    this._width = 0;
    this._height = 0;

    this._scene = null;
    this._limits = null;

    // cached packed data for uniforms
    this._cache = {};
    this._lastPixels = null;
  }

  /* ---------------------------- GL setup / FBO ---------------------------- */

  _ensureGL() {
    if (this._gl) return;
    const { gl } = createGL();
    this._gl = gl;

    // Limits (aligned with path tracer defaults, small enough for WebGL1)
    const LIM = (config.PATH_TRACER?.LIMITS) || {};
    const MAX_SPHERES = (LIM.MAX_SPHERES ?? 32) | 0;
    const MAX_PLANES  = (LIM.MAX_PLANES  ?? 16) | 0;
    const MAX_TRIS    = (LIM.MAX_TRIS    ?? 64) | 0;
    const MAX_MATS    = 64; // material table
    const MAX_PL      = 8;  // point lights
    const MAX_DL      = 2;  // directional lights

    this._limits = { MAX_SPHERES, MAX_PLANES, MAX_TRIS, MAX_MATS, MAX_PL, MAX_DL };

    // Build + link shader program
    const { vs, fs } = buildRaytraceSources(this._limits, MAX_MATS, MAX_PL, MAX_DL);
    const vso = compile(gl, gl.VERTEX_SHADER, vs);
    const fso = compile(gl, gl.FRAGMENT_SHADER, fs);
    this._prog = link(gl, vso, fso);

    // Attributes
    this._attribs = { aPos: gl.getAttribLocation(this._prog, 'aPos') };

    // Uniform locations
    const U = (n) => gl.getUniformLocation(this._prog, n);
    this._uniforms = {
      iResolution: U('iResolution'),
      uFovY: U('uFovY'),
      uCamPos: U('uCamPos'),
      uYaw: U('uYaw'),
      uPitch: U('uPitch'),
      uPixAspect: U('uPixAspect'),

      uNumS: U('uNumS'), uSpheres: U('uSpheres[0]'), uSm: U('uSm[0]'),
      uNumP: U('uNumP'), uPlanes:  U('uPlanes[0]'),  uPm: U('uPm[0]'),
      uNumT: U('uNumT'), uTa: U('uTa[0]'), uTb: U('uTb[0]'), uTc: U('uTc[0]'), uTm: U('uTm[0]'),

      uNumMats: U('uNumMats'),
      uMatAlbedo: U('uMatAlbedo[0]'),
      uMatReflective: U('uMatReflective[0]'),

      uNumPL: U('uNumPL'), uPLPos: U('uPLPos[0]'), uPLCol: U('uPLCol[0]'),
      uNumDL: U('uNumDL'), uDLDir: U('uDLDir[0]'), uDLCol: U('uDLCol[0]'),

      uEnv: U('uEnv'),
    };

    // Fullscreen triangle-list quad
    const verts = new Float32Array([
      -1, -1,   1, -1,   1,  1,
      -1, -1,   1,  1,  -1,  1,
    ]);
    this._quad = { vbo: gl.createBuffer(), count: 6 };
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  }

  _ensureTarget(w, h) {
    this._ensureGL();
    const gl = this._gl;
    if (this._fbo && this._width === w && this._height === h) return;
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._fbo = createFboWithTex(gl, w, h); // has a depth RB from your context.js fix
    this._width = w;
    this._height = h;
  }

  dispose() {
    const gl = this._gl;
    if (!gl) return;
    if (this._quad?.vbo) gl.deleteBuffer(this._quad.vbo);
    if (this._prog) gl.deleteProgram(this._prog);
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._quad = null;
    this._prog = null;
    this._fbo = null;
    this._gl = null;
    this._lastPixels = null;
  }

  /* ----------------------------- Scene ingest ----------------------------- */

  setScene(scene) {
    this._scene = scene || null;
    this._packScene();
  }

  _resolveUnified() {
    // If it already looks unified, return as-is
    const S = this._scene || {};
    if (S.geometry || S.materials || S.lights) return S;

    // Legacy PT shape -> synthesize unified form
    // { spheres:{p,r,m}, planes{p,m}, tris{a,b,c,m}, envLight, dirLight }
    const uni = {
      camera: S.camera || null,
      geometry: { spheres: [], planes: [], tris: [] },
      materials: [],
      lights: { points: [], directionals: [], env: { color: [0, 0, 0], intensity: 0 } },
    };

    const pushMatFromM = (m) => {
      const idx = uni.materials.length;
      const pal = {
        0: [5, 5, 5],      // emissive marker in PT; unused here
        1: [0.9, 0.9, 0.9],
        2: [0.7, 0.9, 0.7],
        3: [0.95, 0.45, 0.45],
        6: [0.9, 0.95, 1.0],
      };
      const albedo = pal[m | 0] || [0.8, 0.8, 0.8];
      const reflective = (m | 0) > 4; // GLASS in PT -> mirror here
      uni.materials.push({ albedo, emissive: false, emission: [0, 0, 0], reflective, roughness: 0 });
      return idx;
    };

    (S.spheres || []).forEach((s) =>
      uni.geometry.spheres.push({ p: s.p, r: s.r, mat: pushMatFromM(s.m || 1) })
    );
    (S.planes || []).forEach((p) =>
      uni.geometry.planes.push({ n: [p.p[0], p.p[1], p.p[2]], d: p.p[3], mat: pushMatFromM(p.m || 1) })
    );
    (S.tris || []).forEach((t) =>
      uni.geometry.tris.push({ a: t.a, b: t.b, c: t.c, mat: pushMatFromM(t.m || 1) })
    );

    if (S.envLight) {
      uni.lights.env = {
        color: S.envLight.color || [0, 0, 0],
        intensity: S.envLight.intensity || 0,
      };
    }
    if (S.dirLight) {
      uni.lights.directionals.push({
        dir: S.dirLight.dir || [0, -1, 0],
        color: S.dirLight.color || [1, 1, 1],
        intensity: S.dirLight.intensity || 0,
      });
    }
    return uni;
  }

  _packScene() {
    this._ensureGL();
    const L = this._limits;
    const U = this._resolveUnified();

    const spheres = U.geometry?.spheres || [];
    const planes  = U.geometry?.planes  || [];
    const tris    = U.geometry?.tris    || [];
    const mats    = U.materials || [];
    const lights  = U.lights || {};

    // Pre-allocate fixed arrays for uniform uploads
    const S4 = new Float32Array(L.MAX_SPHERES * 4);
    const Si = new Int32Array   (L.MAX_SPHERES);
    const P4 = new Float32Array(L.MAX_PLANES  * 4);
    const Pi = new Int32Array   (L.MAX_PLANES);
    const Ta = new Float32Array(L.MAX_TRIS    * 3);
    const Tb = new Float32Array(L.MAX_TRIS    * 3);
    const Tc = new Float32Array(L.MAX_TRIS    * 3);
    const Ti = new Int32Array   (L.MAX_TRIS);

    const Ma = new Float32Array(L.MAX_MATS * 3);
    const Mr = new Int32Array   (L.MAX_MATS);

    let numMats = Math.min(mats.length, L.MAX_MATS);
    for (let i = 0; i < numMats; i++) {
      const m = mats[i] || {};
      Ma[i * 3 + 0] = +m.albedo?.[0] || 0;
      Ma[i * 3 + 1] = +m.albedo?.[1] || 0;
      Ma[i * 3 + 2] = +m.albedo?.[2] || 0;
      Mr[i] = m.reflective ? 1 : 0;
    }
    if (numMats === 0) {
      // Ensure at least one default white diffuse
      Ma[0] = Ma[1] = Ma[2] = 0.8; Mr[0] = 0; numMats = 1;
    }

    const numS = Math.min(spheres.length, L.MAX_SPHERES);
    for (let i = 0; i < numS; i++) {
      const s = spheres[i];
      const off = i * 4;
      S4[off + 0] = +s.p?.[0] || 0;
      S4[off + 1] = +s.p?.[1] || 0;
      S4[off + 2] = +s.p?.[2] || 0;
      S4[off + 3] = +s.r || 0;
      Si[i] = s.mat | 0;
    }

    const numP = Math.min(planes.length, L.MAX_PLANES);
    for (let i = 0; i < numP; i++) {
      const p = planes[i];
      const off = i * 4;
      const n = p.n || [0, 1, 0];
      P4[off + 0] = +n[0] || 0;
      P4[off + 1] = +n[1] || 0;
      P4[off + 2] = +n[2] || 0;
      P4[off + 3] = +p.d || 0;
      Pi[i] = p.mat | 0;
    }

    const numT = Math.min(tris.length, L.MAX_TRIS);
    for (let i = 0; i < numT; i++) {
      const t = tris[i];
      const off = i * 3;
      Ta[off + 0] = +t.a?.[0] || 0; Ta[off + 1] = +t.a?.[1] || 0; Ta[off + 2] = +t.a?.[2] || 0;
      Tb[off + 0] = +t.b?.[0] || 0; Tb[off + 1] = +t.b?.[1] || 0; Tb[off + 2] = +t.b?.[2] || 0;
      Tc[off + 0] = +t.c?.[0] || 0; Tc[off + 1] = +t.c?.[1] || 0; Tc[off + 2] = +t.c?.[2] || 0;
      Ti[i] = t.mat | 0;
    }

    // Lights
    const Ppos = new Float32Array(L.MAX_PL * 3);
    const Pcol = new Float32Array(L.MAX_PL * 3);
    const Ddir = new Float32Array(L.MAX_DL * 3);
    const Dcol = new Float32Array(L.MAX_DL * 3);

    let numPL = 0, numDL = 0;
    if (Array.isArray(lights.points)) {
      numPL = Math.min(lights.points.length, L.MAX_PL);
      for (let i = 0; i < numPL; i++) {
        const Lp = lights.points[i];
        const p = Lp.p || [0, 0, 0];
        const c = Lp.color || [1, 1, 1];
        const k = +Lp.intensity || 0;
        Ppos[i * 3 + 0] = +p[0] || 0; Ppos[i * 3 + 1] = +p[1] || 0; Ppos[i * 3 + 2] = +p[2] || 0;
        Pcol[i * 3 + 0] = (+c[0] || 0) * k; Pcol[i * 3 + 1] = (+c[1] || 0) * k; Pcol[i * 3 + 2] = (+c[2] || 0) * k;
      }
    }
    if (Array.isArray(lights.directionals)) {
      numDL = Math.min(lights.directionals.length, L.MAX_DL);
      for (let i = 0; i < numDL; i++) {
        const Ld = lights.directionals[i];
        const d = Ld.dir || [0, -1, 0];
        const c = Ld.color || [1, 1, 1];
        const k = +Ld.intensity || 0;
        Ddir[i * 3 + 0] = +d[0] || 0; Ddir[i * 3 + 1] = +d[1] || 0; Ddir[i * 3 + 2] = +d[2] || 0;
        Dcol[i * 3 + 0] = (+c[0] || 0) * k; Dcol[i * 3 + 1] = (+c[1] || 0) * k; Dcol[i * 3 + 2] = (+c[2] || 0) * k;
      }
    }

    const envCol = lights.env
      ? [
          (+lights.env.color?.[0] || 0) * (+lights.env.intensity || 0),
          (+lights.env.color?.[1] || 0) * (+lights.env.intensity || 0),
          (+lights.env.color?.[2] || 0) * (+lights.env.intensity || 0),
        ]
      : [0, 0, 0];

    this._cache = {
      numS: numS | 0, S4, Si,
      numP: numP | 0, P4, Pi,
      numT: numT | 0, Ta, Tb, Tc, Ti,
      numMats: numMats | 0, Ma, Mr,
      numPL: numPL | 0, Ppos, Pcol,
      numDL: numDL | 0, Ddir, Dcol,
      envCol,
    };
  }

  /* -------------------------------- Render -------------------------------- */

  render(_timeSec, framebuffer, appState) {
    const gl = (this._ensureGL(), this._gl);
    const w = (appState?.cols | 0) || (config.VIRTUAL_GRID_WIDTH | 0) || 1;
    const h = (appState?.rows | 0) || (config.VIRTUAL_GRID_HEIGHT | 0) || 1;
    this._ensureTarget(w, h);
    if (!this._scene) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo.fb);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this._prog);

    // Camera (use live controls to match PT/raster behavior)
    const cam = LiveCamera
      ? { pos: LiveCamera.pos, yaw: LiveCamera.yaw, pitch: LiveCamera.pitch }
      : (appState?.camera || { pos: { x: 0, y: 0, z: 5 }, yaw: 0, pitch: 0 });

    const fovRad = ((config.FOVY_DEG || 80) * Math.PI) / 180;
    const pixAsp = Number.isFinite(config.PATH_TRACER?.PIXEL_ASPECT)
      ? Math.max(1e-6, config.PATH_TRACER.PIXEL_ASPECT)
      : 1.0;

    // Core uniforms
    gl.uniform3f(this._uniforms.iResolution, w, h, 1.0);
    gl.uniform1f(this._uniforms.uFovY, fovRad);
    gl.uniform3f(this._uniforms.uCamPos, cam.pos.x, cam.pos.y, cam.pos.z);
    gl.uniform1f(this._uniforms.uYaw, cam.yaw || 0);
    gl.uniform1f(this._uniforms.uPitch, cam.pitch || 0);
    gl.uniform1f(this._uniforms.uPixAspect, pixAsp);

    // Scene uniforms
    const C = this._cache;

    gl.uniform1i(this._uniforms.uNumS, C.numS);
    if (C.numS > 0) {
      gl.uniform4fv(this._uniforms.uSpheres, C.S4);
      gl.uniform1iv(this._uniforms.uSm, C.Si);
    }

    gl.uniform1i(this._uniforms.uNumP, C.numP);
    if (C.numP > 0) {
      gl.uniform4fv(this._uniforms.uPlanes, C.P4);
      gl.uniform1iv(this._uniforms.uPm, C.Pi);
    }

    gl.uniform1i(this._uniforms.uNumT, C.numT);
    if (C.numT > 0) {
      gl.uniform3fv(this._uniforms.uTa, C.Ta);
      gl.uniform3fv(this._uniforms.uTb, C.Tb);
      gl.uniform3fv(this._uniforms.uTc, C.Tc);
      gl.uniform1iv(this._uniforms.uTm, C.Ti);
    }

    gl.uniform1i(this._uniforms.uNumMats, C.numMats);
    if (C.numMats > 0) {
      gl.uniform3fv(this._uniforms.uMatAlbedo, C.Ma);
      gl.uniform1iv(this._uniforms.uMatReflective, C.Mr);
    }

    gl.uniform1i(this._uniforms.uNumPL, C.numPL);
    if (C.numPL > 0) {
      gl.uniform3fv(this._uniforms.uPLPos, C.Ppos);
      gl.uniform3fv(this._uniforms.uPLCol, C.Pcol);
    }

    gl.uniform1i(this._uniforms.uNumDL, C.numDL);
    if (C.numDL > 0) {
      gl.uniform3fv(this._uniforms.uDLDir, C.Ddir);
      gl.uniform3fv(this._uniforms.uDLCol, C.Dcol);
    }

    gl.uniform3f(this._uniforms.uEnv, C.envCol[0], C.envCol[1], C.envCol[2]);

    // Draw FSQ
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quad.vbo);
    gl.enableVertexAttribArray(this._attribs.aPos);
    gl.vertexAttribPointer(this._attribs.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this._quad.count);

    // Read back -> matches ASCII compositing format (RGBA8)
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    if (framebuffer && framebuffer.length === px.length) {
      flipAndCopy(px, framebuffer, w, h);
    }
    this._lastPixels = px;
  }

  renderRaw(args) {
    if (args?.framebuffer && args?.appState) {
      return this.render(args.time || 0, args.framebuffer, args.appState);
    }
  }

  getPixels({ framebuffer, width, height, flipY = true } = {}) {
    if (!this._lastPixels) return null;
    const w = width || this._width, h = height || this._height;
    if (framebuffer && framebuffer.length >= w * h * 4) {
      if (flipY) flipAndCopy(this._lastPixels, framebuffer, w, h);
      else framebuffer.set(this._lastPixels);
      return framebuffer;
    }
    return this._lastPixels;
  }
}
