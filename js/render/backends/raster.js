// js/render/backends/raster.js
// WebGL1 forward rasterizer backend consuming the unified scene.
// Contract: setScene(), render(), renderRaw(), getPixels(), dispose()
//
// Camera mapping & pixel aspect are identical to the path tracer,
// and we render into an offscreen RGBA8 FBO with a depth buffer.

import { createGL, compile, link, createFboWithTex, flipAndCopy } from '../gl/context.js';
import { config } from '../../config.js';
import { camera as LiveCamera } from '../../camera.js';
import { buildRasterSources } from './raster_shader.js';

/* ----------------------------- Tiny math ---------------------------------- */
function mat4Identity(){ return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); }
function mat4Perspective(out, fovyRad, aspect, near, far){
  const f = 1/Math.tan(Math.max(1e-6, fovyRad*0.5)), nf = 1/(near-far);
  out[0]=f/aspect; out[1]=0; out[2]=0; out[3]=0;
  out[4]=0; out[5]=f; out[6]=0; out[7]=0;
  out[8]=0; out[9]=0; out[10]=(far+near)*nf; out[11]=-1;
  out[12]=0; out[13]=0; out[14]=2*far*near*nf; out[15]=0;
  return out;
}
function vec3(x=0,y=0,z=0){ return {x,y,z}; }
function sub(a,b){ return vec3(a.x-b.x, a.y-b.y, a.z-b.z); }
function add(a,b){ return vec3(a.x+b.x, a.y+b.y, a.z+b.z); }
function dot(a,b){ return a.x*b.x + a.y*b.y + a.z*b.z; }
function cross(a,b){ return vec3(a.y*b.z-a.z*b.y, a.z*b.x-a.x*b.z, a.x*b.y-a.y*b.x); }
function length(v){ return Math.hypot(v.x,v.y,v.z); }
function normalize(v){ const L=length(v)||1; return vec3(v.x/L, v.y/L, v.z/L); }
function mat4LookAt(out, eye, center, up){
  const f=normalize(sub(center,eye));
  const s=normalize(cross(f, up));
  const u=cross(s, f);
  out[0]=s.x; out[1]=u.x; out[2]=-f.x; out[3]=0;
  out[4]=s.y; out[5]=u.y; out[6]=-f.y; out[7]=0;
  out[8]=s.z; out[9]=u.z; out[10]=-f.z; out[11]=0;
  out[12]=-dot(s,eye); out[13]=-dot(u,eye); out[14]=dot(f,eye); out[15]=1;
  return out;
}
// MATCH PT: x = cos(pitch)*cos(yaw), y = sin(pitch), z = cos(pitch)*sin(yaw)
function yawPitchToDir(yaw, pitch){
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw),   sy = Math.sin(yaw);
  return vec3(cp*cy, sp, cp*sy);
}

const clamp01 = v => Math.min(1, Math.max(0, v));
const LEGACY_COLORS = { 0:[5,5,5], 1:[0.9,0.9,0.9], 2:[0.7,0.9,0.7], 3:[0.95,0.45,0.45], 6:[0.9,0.95,1.0] };

/* -------------------------------- Backend --------------------------------- */
export class RasterBackend {
  constructor(){
    this.name = 'raster';
    this._gl = null; this._prog = null;
    this._attribs = null; this._uniforms = null;
    this._quad = null;

    this._fbo = null; this._width = 0; this._height = 0;

    this._vbo = null; this._ibo = null; this._indexCount = 0; this._indexType = 0;

    this._scene = null;
    this._lastPixels = null;

    // defaults if scene omits lights
    this._ambient    = [0.15, 0.18, 0.22];
    this._lightDir   = [0.25, -1.0, 0.15];
    this._lightColor = [1.2, 1.15, 1.1];

    this._MAX_PL = 8; // keep in sync with shader builder
  }

  /* ----------------------------- GL / Program ------------------------------ */
  _ensureGL(){
    if (this._gl) return;
    const { gl } = createGL(); // WebGL1
    this._gl = gl;

    const { vs, fs, MAX_POINT_LIGHTS } = buildRasterSources();
    this._MAX_PL = MAX_POINT_LIGHTS;

    const vso = compile(gl, gl.VERTEX_SHADER, vs);
    const fso = compile(gl, gl.FRAGMENT_SHADER, fs);
    this._prog = link(gl, vso, fso);

    this._attribs = {
      a_pos: gl.getAttribLocation(this._prog, 'a_pos'),
      a_nrm: gl.getAttribLocation(this._prog, 'a_nrm'),
      a_col: gl.getAttribLocation(this._prog, 'a_col'),
    };
    const U = (n) => gl.getUniformLocation(this._prog, n);
    this._uniforms = {
      uProj: U('uProj'), uView: U('uView'),
      uLightDir: U('uLightDir'), uLightColor: U('uLightColor'), uAmbient: U('uAmbient'),
      uPLCount: U('uPLCount'),
      uPLPos0:  U('uPLPos[0]'),
      uPLCol0:  U('uPLCol[0]'),
    };

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  _ensureTarget(w,h){
    this._ensureGL();
    const gl = this._gl;
    if (this._fbo && this._width===w && this._height===h) return;
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._fbo = createFboWithTex(gl, w|0, h|0); // includes depth RB (see context.js)
    this._width = w|0; this._height = h|0;
  }

  dispose(){
    const gl = this._gl; if (!gl) return;
    if (this._ibo) gl.deleteBuffer(this._ibo);
    if (this._vbo) gl.deleteBuffer(this._vbo);
    if (this._prog) gl.deleteProgram(this._prog);
    if (this._fbo?.fb) gl.deleteFramebuffer(this._fbo.fb);
    if (this._fbo?.tex) gl.deleteTexture(this._fbo.tex);
    if (this._fbo?.rb) gl.deleteRenderbuffer(this._fbo.rb);
    this._ibo = this._vbo = this._prog = null;
    this._fbo = null; this._gl = null; this._lastPixels = null;
    this._indexCount = 0;
  }

  /* ------------------------------ Scene ingest ---------------------------- */
  setScene(scene){
    this._scene = scene || null;
    this._rebuildGeometry();
  }

  _resolveColor({ mat, m }){
    if (Array.isArray(this._scene?.materials) && Number.isFinite(mat)) {
      const M = this._scene.materials[mat|0];
      if (M?.albedo) return [
        clamp01(+M.albedo[0]||0),
        clamp01(+M.albedo[1]||0),
        clamp01(+M.albedo[2]||0),
      ];
    }
    if (Number.isFinite(m)) return LEGACY_COLORS[m|0] || [0.8,0.8,0.8];
    return [0.8,0.8,0.8];
  }

  _rebuildGeometry(){
    this._ensureGL();
    const gl = this._gl;

    if (!this._scene){
      if (this._ibo) gl.deleteBuffer(this._ibo), this._ibo=null;
      if (this._vbo) gl.deleteBuffer(this._vbo), this._vbo=null;
      this._indexCount = 0; return;
    }

    const positions=[], normals=[], colors=[], indices=[];
    const pushTri = (a,b,c,col)=>{
      const U={x:b[0]-a[0], y:b[1]-a[1], z:b[2]-a[2]};
      const V={x:c[0]-a[0], y:c[1]-a[1], z:c[2]-a[2]};
      let N=cross(U,V); const L=Math.hypot(N.x,N.y,N.z);
      if (L>1e-8){ N.x/=L; N.y/=L; N.z/=L; } else { N={x:0,y:1,z:0}; }
      const base=positions.length/3;
      positions.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
      normals.push(N.x,N.y,N.z, N.x,N.y,N.z, N.x,N.y,N.z);
      colors.push(col[0],col[1],col[2], col[0],col[1],col[2], col[0],col[1],col[2]);
      indices.push(base, base+1, base+2);
    };

    const tris = this._scene.tris || this._scene.geometry?.tris || [];
    for (const t of tris){
      pushTri(t.a||[0,0,0], t.b||[1,0,0], t.c||[0,1,0], this._resolveColor({mat:t.mat,m:t.m}));
    }

    // Planes -> finite big quads, oriented properly
    const planes = this._scene.planes || this._scene.geometry?.planes || [];
    for (const p of planes){
      const n = p.n || [0,1,0];
      const d = Number.isFinite(p.d) ? p.d : 0;
      const col = this._resolveColor({mat:p.mat,m:p.m});
      const N = normalize(vec3(n[0],n[1],n[2]));
      const P0 = vec3(-d*N.x, -d*N.y, -d*N.z);
      const tmp = Math.abs(N.y) < 0.99 ? vec3(0,1,0) : vec3(1,0,0);
      const b1 = normalize(cross(N, tmp));
      const b2 = normalize(cross(N, b1));
      const S = 20.0;
      const v0=[P0.x+(-S*b1.x - S*b2.x), P0.y+(-S*b1.y - S*b2.y), P0.z+(-S*b1.z - S*b2.z)];
      const v1=[P0.x+( S*b1.x - S*b2.x), P0.y+( S*b1.y - S*b2.y), P0.z+( S*b1.z - S*b2.z)];
      const v2=[P0.x+( S*b1.x + S*b2.x), P0.y+( S*b1.y + S*b2.y), P0.z+( S*b1.z + S*b2.z)];
      const v3=[P0.x+(-S*b1.x + S*b2.x), P0.y+(-S*b1.y + S*b2.y), P0.z+(-S*b1.z + S*b2.z)];
      pushTri(v0,v1,v2,col); pushTri(v0,v2,v3,col);
    }

    // Spheres -> low-res UV mesh
    const spheres = this._scene.spheres || this._scene.geometry?.spheres || [];
    const SLAT=12, SLON=16;
    for (const s of spheres){
      const c=s.p||[0,0,0], r=Number.isFinite(s.r)?s.r:1;
      const col=this._resolveColor({mat:s.mat,m:s.m});
      const baseVert=positions.length/3;
      for (let iy=0; iy<=SLAT; iy++){
        const v=iy/SLAT, phi=v*Math.PI, sp=Math.sin(phi), cp=Math.cos(phi);
        for (let ix=0; ix<=SLON; ix++){
          const u=ix/SLON, th=u*2*Math.PI, st=Math.sin(th), ct=Math.cos(th);
          const nx=ct*sp, ny=cp, nz=st*sp;
          positions.push(c[0]+r*nx, c[1]+r*ny, c[2]+r*nz);
          normals.push(nx,ny,nz);
          colors.push(col[0],col[1],col[2]);
        }
      }
      for (let iy=0; iy<SLAT; iy++){
        for (let ix=0; ix<SLON; ix++){
          const i0=baseVert + iy*(SLON+1) + ix;
          const i1=i0+1, i2=i0+(SLON+1), i3=i2+1;
          indices.push(i0,i2,i1, i1,i2,i3);
        }
      }
    }

    // Upload
    const vertCount = positions.length/3;
    const vStride = 9;
    const vData = new Float32Array(vertCount * vStride);
    for (let i=0;i<vertCount;i++){
      const pOff=i*3, vOff=i*vStride;
      vData[vOff+0]=positions[pOff+0];
      vData[vOff+1]=positions[pOff+1];
      vData[vOff+2]=positions[pOff+2];
      vData[vOff+3]=normals[pOff+0];
      vData[vOff+4]=normals[pOff+1];
      vData[vOff+5]=normals[pOff+2];
      vData[vOff+6]=colors[pOff+0];
      vData[vOff+7]=colors[pOff+1];
      vData[vOff+8]=colors[pOff+2];
    }

    if (this._vbo) gl.deleteBuffer(this._vbo);
    if (this._ibo) gl.deleteBuffer(this._ibo);
    this._vbo = gl.createBuffer();
    this._ibo = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vData, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    const canUint = !!gl.getExtension('OES_element_index_uint');
    if (canUint){
      const i32 = new Uint32Array(indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, i32, gl.STATIC_DRAW);
      this._indexCount = i32.length; this._indexType = gl.UNSIGNED_INT;
    } else {
      if (vertCount > 65535) console.warn('[RasterBackend] >65k verts; enable OES_element_index_uint.');
      const i16 = new Uint16Array(indices.map(x => Math.min(x, 65535)));
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, i16, gl.STATIC_DRAW);
      this._indexCount = i16.length; this._indexType = gl.UNSIGNED_SHORT;
    }

    const strideBytes = vStride * 4;
    gl.enableVertexAttribArray(this._attribs.a_pos);
    gl.vertexAttribPointer(this._attribs.a_pos, 3, gl.FLOAT, false, strideBytes, 0);
    gl.enableVertexAttribArray(this._attribs.a_nrm);
    gl.vertexAttribPointer(this._attribs.a_nrm, 3, gl.FLOAT, false, strideBytes, 3*4);
    gl.enableVertexAttribArray(this._attribs.a_col);
    gl.vertexAttribPointer(this._attribs.a_col, 3, gl.FLOAT, false, strideBytes, 6*4);
  }

  /* -------------------------------- Render -------------------------------- */
  render(timeSec, framebuffer, appState){
    const gl = (this._ensureGL(), this._gl);
    const w = (appState?.cols|0) || (config.VIRTUAL_GRID_WIDTH|0) || 1;
    const h = (appState?.rows|0) || (config.VIRTUAL_GRID_HEIGHT|0) || 1;
    this._ensureTarget(w, h);
    if (!this._vbo || !this._ibo || this._indexCount===0) return;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this._fbo.fb);
    gl.viewport(0,0,this._width,this._height);
    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this._prog);

    // Camera (live), identical mapping to PT
    const cam = LiveCamera
      ? { pos: LiveCamera.pos, yaw: LiveCamera.yaw, pitch: LiveCamera.pitch }
      : (appState?.camera || { pos:{x:0,y:0,z:5}, yaw:0, pitch:0 });

    const eye = vec3(cam.pos.x, cam.pos.y, cam.pos.z);
    const dir = yawPitchToDir(cam.yaw||0, cam.pitch||0);
    const center = add(eye, dir);
    const up = vec3(0,1,0);

    const pixAsp = (config.PATH_TRACER && Number.isFinite(config.PATH_TRACER.PIXEL_ASPECT))
      ? Math.max(1e-6, config.PATH_TRACER.PIXEL_ASPECT)
      : 1.0;
    const proj = mat4Identity();
    const fovRad = ((config.FOVY_DEG || 80) * Math.PI / 180);
    const aspect = Math.max(1e-6, (w / Math.max(1, h)) * pixAsp);
    mat4Perspective(proj, fovRad, aspect, 0.05, 100.0);
    const view = mat4Identity();
    mat4LookAt(view, eye, center, up);

    gl.uniformMatrix4fv(this._uniforms.uProj, false, proj);
    gl.uniformMatrix4fv(this._uniforms.uView, false, view);

    // Lights (unified or legacy passthrough)
    let ambient=this._ambient, dirDir=this._lightDir, dirCol=this._lightColor;
    const U=this._scene||{}, L = U.lights||null;
    if (L?.env){
      const e=L.env; ambient=[(e.color?.[0]||0)*(e.intensity||0),(e.color?.[1]||0)*(e.intensity||0),(e.color?.[2]||0)*(e.intensity||0)];
    } else if (U.envLight?.color){ ambient=U.envLight.color; }
    if (L?.directionals?.length){
      const d0=L.directionals[0]; dirDir=d0.dir||dirDir;
      const k=(d0.intensity||0); dirCol=[(d0.color?.[0]||1)*k,(d0.color?.[1]||1)*k,(d0.color?.[2]||1)*k];
    } else if (U.dirLight?.dir){ dirDir=U.dirLight.dir; dirCol=U.dirLight.color||dirCol; }

    gl.uniform3f(this._uniforms.uAmbient, ambient[0], ambient[1], ambient[2]);
    gl.uniform3f(this._uniforms.uLightDir, dirDir[0], dirDir[1], dirDir[2]);
    gl.uniform3f(this._uniforms.uLightColor, dirCol[0], dirCol[1], dirCol[2]);

    // Point lights: pack into arrays and upload in one call each
    let plCount = 0;
    if (L?.points?.length){
      plCount = Math.min(this._MAX_PL, L.points.length);
      const pos = new Float32Array(this._MAX_PL*3);
      const col = new Float32Array(this._MAX_PL*3);
      for (let i=0;i<plCount;i++){
        const p = L.points[i].p || [0,0,0];
        const c = L.points[i].color || [1,1,1];
        const k = +L.points[i].intensity || 0;
        pos[i*3+0]=p[0]; pos[i*3+1]=p[1]; pos[i*3+2]=p[2];
        col[i*3+0]=c[0]*k; col[i*3+1]=c[1]*k; col[i*3+2]=c[2]*k;
      }
      // upload starting from [0]
      gl.uniform3fv(this._uniforms.uPLPos0, pos);
      gl.uniform3fv(this._uniforms.uPLCol0, col);
    } else {
      // zero-out to be safe
      gl.uniform3fv(this._uniforms.uPLPos0, new Float32Array(this._MAX_PL*3));
      gl.uniform3fv(this._uniforms.uPLCol0, new Float32Array(this._MAX_PL*3));
    }
    gl.uniform1i(this._uniforms.uPLCount, plCount|0);

    // Bind geometry
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
    const strideBytes = 9*4;
    gl.vertexAttribPointer(this._attribs.a_pos, 3, gl.FLOAT, false, strideBytes, 0);
    gl.enableVertexAttribArray(this._attribs.a_pos);
    gl.vertexAttribPointer(this._attribs.a_nrm, 3, gl.FLOAT, false, strideBytes, 3*4);
    gl.enableVertexAttribArray(this._attribs.a_nrm);
    gl.vertexAttribPointer(this._attribs.a_col, 3, gl.FLOAT, false, strideBytes, 6*4);
    gl.enableVertexAttribArray(this._attribs.a_col);

    gl.drawElements(gl.TRIANGLES, this._indexCount, this._indexType, 0);

    // Readback for ASCII stage
    const px = new Uint8Array(w*h*4);
    gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);
    if (framebuffer && framebuffer.length === px.length) flipAndCopy(px, framebuffer, w, h);
    this._lastPixels = px;
  }

  renderRaw(args){ if (args?.framebuffer && args?.appState) return this.render(args.time||0, args.framebuffer, args.appState); }

  getPixels({ framebuffer, width, height, flipY=true } = {}){
    if (!this._lastPixels) return null;
    const w = width || this._width, h = height || this._height;
    if (framebuffer && framebuffer.length >= w*h*4){
      if (flipY) flipAndCopy(this._lastPixels, framebuffer, w, h);
      else framebuffer.set(this._lastPixels);
      return framebuffer;
    }
    return this._lastPixels;
  }
}
