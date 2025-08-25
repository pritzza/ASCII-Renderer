// js/render/scene_api.js
// Path Tracer scene representation + builder (PT-only).
// Goals:
//  - Only support: spheres, triangles, quads.
//  - Each primitive carries a uint materialId to look up into a materials map.
//  - Triangles & quads store per-vertex UVs as uint16 intended for texelFetch()
//    on a single RGBA8 atlas (no filtering).
//  - Keep a simple PT light sphere & optional env for NEE and background.
//  - toObject()/toPathTracer() return the PT-friendly shape the renderer expects.

export const MaterialIds = Object.freeze({
  // Suggested convenience IDs (you can add your own)
  LIGHT: 0,
  WHITE: 1,
  GREEN: 2,
  RED:   3,
  GLASS: 6,
  MIRROR: 7,
});

const DEFAULT_MAT_ID = MaterialIds.WHITE;
const DBG = false; // toggle tiny debug prints

function _isFinite3(a){ return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite); }
function _copy3(v){ return [ +v[0], +v[1], +v[2] ]; }
function _norm3(v){ const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/L, v[1]/L, v[2]/L]; }

function _u16(x){
  const n = (x|0);
  return n < 0 ? 0 : (n > 0xFFFF ? 0xFFFF : n);
}
function _u32(x){
  let n = Math.floor(+x);
  if (!Number.isFinite(n) || n < 0) n = 0;
  // clamp to 32-bit unsigned
  return n >>> 0;
}

function _mkMaterial({
  name = '',
  albedo = [0.8,0.8,0.8],   // [0..1]
  emissive = false,
  emission = [0,0,0],       // radiance if emissive
  reflective = false,       // perfect mirror / dielectric branch handled in PT
  roughness = 0.0,          // PT only (can be ignored by your shader)
} = {}){
  const a = _copy3(albedo).map(v => Math.min(1, Math.max(0, +v)));
  const e = _copy3(emission).map(v => +v);
  return { name:String(name||''), albedo:a, emissive:!!emissive, emission:e, reflective:!!reflective, roughness:Math.min(1, Math.max(0, +roughness)) };
}

export class SceneBuilder {
  constructor(maxSpheres = 64, maxTris = 4096, maxQuads = 4096){
    this._maxS = maxSpheres|0;
    this._maxT = maxTris|0;
    this._maxQ = maxQuads|0;

    // Materials: id (uint) -> descriptor
    this._materials = new Map();  // Map<uint, material>

    // Geometry
    this._geom = {
      spheres: [], // { p:[x,y,z], r:number, matId:uint }
      tris:    [], // { a:[x,y,z], b:[x,y,z], c:[x,y,z], matId:uint, uvA:[u16,u16], uvB:[u16,u16], uvC:[u16,u16] }
      quads:   [], // { a:[x,y,z], b:[x,y,z], c:[x,y,z], d:[x,y,z], matId:uint, uv0:[u16,u16], uv1:[u16,u16], uv2:[u16,u16], uv3:[u16,u16] }
    };

    // Single texture atlas info for integer texelFetch (no filtering)
    this._atlas = { width: 0, height: 0 }; // set via setTextureAtlasSize(w,h)

    // Minimal PT lights
    this._lights = {
      env: { color:[0,0,0], intensity: 0.0 },     // optional background tint
      area: { center:[3,2.8,3], radius:0.5, auto:true }, // PT light sphere for NEE
    };

    // Camera
    this._camera = { pos:[2.78, 2.73, -8.00], yaw: 0.0, pitch: 0.0, fovY: 80 * Math.PI/180 };

    // Some handy defaults
    this.addMaterial(MaterialIds.LIGHT,  _mkMaterial({ name:'LIGHT',  albedo:[1,1,1], emissive:true,  emission:[16.86,10.76,8.2], reflective:false, roughness:0.0 }));
    this.addMaterial(MaterialIds.WHITE,  _mkMaterial({ name:'WHITE',  albedo:[0.7295,0.7355,0.7290], emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }));
    this.addMaterial(MaterialIds.GREEN,  _mkMaterial({ name:'GREEN',  albedo:[0.1170,0.4125,0.1150], emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }));
    this.addMaterial(MaterialIds.RED,    _mkMaterial({ name:'RED',    albedo:[0.6110,0.0555,0.0620], emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }));
    this.addMaterial(MaterialIds.GLASS,  _mkMaterial({ name:'GLASS',  albedo:[1,1,1], emissive:false, emission:[0,0,0], reflective:true,  roughness:0.0 }));
    this.addMaterial(MaterialIds.MIRROR, _mkMaterial({ name:'MIRROR', albedo:[1,1,1], emissive:false, emission:[0,0,0], reflective:true,  roughness:0.0 }));
  }

  /* ----------------------------- Materials API ----------------------------- */
  addMaterial(id, def){
    const matId = _u32(id);
    const m = _mkMaterial(def||{});
    this._materials.set(matId, m);
    return matId;
  }
  hasMaterial(id){ return this._materials.has(_u32(id)); }
  getMaterial(id){ return this._materials.get(_u32(id)); }

  /* -------------------------------- Camera -------------------------------- */
  setCameraPose(pos=[2.78,2.73,-8.00], { yaw=0.0, pitch=0.0, fovYDeg=80 } = {}){
    if (!_isFinite3(pos) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      throw new Error('setCameraPose: bad args');
    }
    this._camera = { pos:[+pos[0],+pos[1],+pos[2]], yaw:+yaw, pitch:+pitch, fovY: (+fovYDeg) * Math.PI/180 };
    if (DBG) console.log('[PT] setCameraPose ok');
    return this;
  }

  /* -------------------------------- Lights -------------------------------- */
  setEnvLight(color=[0,0,0], intensity=0.0){
    if (!_isFinite3(color) || !Number.isFinite(intensity)) throw new Error('setEnvLight: bad args');
    this._lights.env = { color:[+color[0],+color[1],+color[2]], intensity:+intensity };
    return this;
  }
  setAreaLight(center=[3,2.8,3], radius=0.5, { auto=true } = {}){
    if (!_isFinite3(center) || !Number.isFinite(radius)) throw new Error('setAreaLight: bad args');
    this._lights.area = { center:[+center[0],+center[1],+center[2]], radius:+radius, auto:!!auto };
    return this;
  }

  /* ------------------------- Texture atlas descriptor ---------------------- */
  setTextureAtlasSize(width, height){
    const w = Math.max(0, width|0);
    const h = Math.max(0, height|0);
    this._atlas = { width:w, height:h };
    return this;
  }

  /* ------------------------------ Geometry -------------------------------- */
  addSphere(center=[0,0,0], radius=1.0, materialId=DEFAULT_MAT_ID){
    if (!_isFinite3(center) || !Number.isFinite(radius)) throw new Error('addSphere: bad args');
    if (this._geom.spheres.length >= this._maxS) return this;
    const matId = this.hasMaterial(materialId) ? _u32(materialId) : DEFAULT_MAT_ID;
    this._geom.spheres.push({ p:[+center[0],+center[1],+center[2]], r:+radius, matId });
    return this;
  }

  // Tri with uint16 UVs per vertex (u,v in texel space for integer sampling)
  addTriangle(a=[0,0,0], b=[1,0,0], c=[0,1,0],
              materialId=DEFAULT_MAT_ID,
              uvA=[0,0], uvB=[0,0], uvC=[0,0]){
    if (!_isFinite3(a) || !_isFinite3(b) || !_isFinite3(c)) throw new Error('addTriangle: bad args');
    if (this._geom.tris.length >= this._maxT) return this;
    const matId = this.hasMaterial(materialId) ? _u32(materialId) : DEFAULT_MAT_ID;
    const U = (uv)=>[ _u16(uv[0]||0), _u16(uv[1]||0) ];
    this._geom.tris.push({ a:_copy3(a), b:_copy3(b), c:_copy3(c), matId, uvA:U(uvA), uvB:U(uvB), uvC:U(uvC) });
    return this;
  }

  // Quad with uint16 UVs per vertex, vertex order: a->b->c->d (consistent winding)
  addQuad(a=[0,0,0], b=[1,0,0], c=[1,1,0], d=[0,1,0],
          materialId=DEFAULT_MAT_ID,
          uv0=[0,0], uv1=[0,0], uv2=[0,0], uv3=[0,0]){
    if (!_isFinite3(a) || !_isFinite3(b) || !_isFinite3(c) || !_isFinite3(d)) throw new Error('addQuad: bad args');
    if (this._geom.quads.length >= this._maxQ) return this;
    const matId = this.hasMaterial(materialId) ? _u32(materialId) : DEFAULT_MAT_ID;
    const U = (uv)=>[ _u16(uv[0]||0), _u16(uv[1]||0) ];
    this._geom.quads.push({ a:_copy3(a), b:_copy3(b), c:_copy3(c), d:_copy3(d), matId, uv0:U(uv0), uv1:U(uv1), uv2:U(uv2), uv3:U(uv3) });
    return this;
  }

  // Convenience: split a rect (p00->p10->p11->p01) into a quad
  addRect(p00, p10, p11, p01, materialId=DEFAULT_MAT_ID,
          uv00=[0,0], uv10=[0,0], uv11=[0,0], uv01=[0,0]){
    return this.addQuad(p00,p10,p11,p01, materialId, uv00,uv10,uv11,uv01);
  }

  // Optional helper for triangle meshes; if 'uvs' provided, they are uint16 pairs per-vertex
  addMesh({ positions, indices=null, uvs=null, materialId=DEFAULT_MAT_ID }){
    if (!Array.isArray(positions) || positions.length % 3 !== 0) return this;
    const V = positions.length / 3;
    const getV = (i) => [ positions[3*i], positions[3*i+1], positions[3*i+2] ];
    const getUV = (i) => {
      if (!uvs || uvs.length < 2*(i+1)) return [0,0];
      return [ _u16(uvs[2*i]|0), _u16(uvs[2*i+1]|0) ];
    };
    if (indices && indices.length % 3 === 0) {
      for (let t=0; t<indices.length; t+=3) {
        const i0=indices[t]|0, i1=indices[t+1]|0, i2=indices[t+2]|0;
        if (i0<0||i0>=V||i1<0||i1>=V||i2<0||i2>=V) continue;
        this.addTriangle(getV(i0), getV(i1), getV(i2), materialId, getUV(i0), getUV(i1), getUV(i2));
      }
    } else {
      for (let i=0; i+8<positions.length; i+=9) {
        const v0=[positions[i+0], positions[i+1], positions[i+2]];
        const v1=[positions[i+3], positions[i+4], positions[i+5]];
        const v2=[positions[i+6], positions[i+7], positions[i+8]];
        this.addTriangle(v0, v1, v2, materialId, [0,0],[0,0],[0,0]);
      }
    }
    return this;
  }

  /* ------------------------------- Outputs -------------------------------- */
  toUnified(){
    // Materials map → plain object with numeric string keys for JSON friendliness
    const matTable = {};
    for (const [id, m] of this._materials.entries()) matTable[id] = {
      name:m.name, albedo:_copy3(m.albedo), emissive:m.emissive, emission:_copy3(m.emission),
      reflective:m.reflective, roughness:m.roughness
    };

    const out = {
      version: 2,
      camera: { ...this._camera, pos: _copy3(this._camera.pos) },
      atlas: { width: this._atlas.width|0, height: this._atlas.height|0 },
      materials: { table: matTable }, // id:string -> material
      geometry: {
        spheres: this._geom.spheres.map(s => ({ p:_copy3(s.p), r:+s.r, matId:s.matId>>>0 })),
        tris:    this._geom.tris.map(t => ({
          a:_copy3(t.a), b:_copy3(t.b), c:_copy3(t.c),
          matId:t.matId>>>0,
          uvA:[t.uvA[0]|0, t.uvA[1]|0],
          uvB:[t.uvB[0]|0, t.uvB[1]|0],
          uvC:[t.uvC[0]|0, t.uvC[1]|0],
        })),
        quads:   this._geom.quads.map(q => ({
          a:_copy3(q.a), b:_copy3(q.b), c:_copy3(q.c), d:_copy3(q.d),
          matId:q.matId>>>0,
          uv0:[q.uv0[0]|0, q.uv0[1]|0],
          uv1:[q.uv1[0]|0, q.uv1[1]|0],
          uv2:[q.uv2[0]|0, q.uv2[1]|0],
          uv3:[q.uv3[0]|0, q.uv3[1]|0],
        })),
      },
      lights: {
        env:  { color:_copy3(this._lights.env.color), intensity:+this._lights.env.intensity },
        area: { center:_copy3(this._lights.area.center), radius:+this._lights.area.radius, auto:!!this._lights.area.auto },
      },
    };
    if (DBG) {
      const g = out.geometry;
      console.log('[PT] toUnified', { S:g.spheres.length, T:g.tris.length, Q:g.quads.length, atlas: out.atlas });
    }
    return out;
  }

  // PT shape (what your PT uploader/renderer should ingest)
  toPathTracer(){
    // For PT, we pass the unified form as-is; adjust here if your PT needs a tighter ABI.
    return this.toUnified();
  }

  // Back-compat alias used by app code.
  toObject(){ return this.toPathTracer(); }

  // Reset to defaults (keeps existing materials)
  reset(){
    this._geom = { spheres:[], tris:[], quads:[] };
    this._atlas = { width:0, height:0 };
    this._lights = {
      env: { color:[0,0,0], intensity: 0.0 },
      area: { center:[3,2.8,3], radius:0.5, auto:true },
    };
    this._camera = { pos:[2.78, 2.73, -8.00], yaw: 0.0, pitch: 0.0, fovY: 80 * Math.PI/180 };
    return this;
  }
}

// Factory
export function createSceneBuilder(maxSpheres, maxTris, maxQuads){
  return new SceneBuilder(maxSpheres, maxTris, maxQuads);
}

// Build from plain-ish object (matching the unified schema)
export function fromObject(obj){
  const sb = new SceneBuilder();
  if (!obj || typeof obj !== 'object') return sb;

  // camera
  if (obj.camera){
    const pos = obj.camera.pos ?? [2.78,2.73,-8.00];
    const yaw = Number.isFinite(obj.camera.yaw) ? +obj.camera.yaw : 0.0;
    const pitch = Number.isFinite(obj.camera.pitch) ? +obj.camera.pitch : 0.0;
    const fovY = Number.isFinite(obj.camera.fovY) ? (+obj.camera.fovY) : 80*Math.PI/180;
    sb.setCameraPose(pos, { yaw, pitch, fovYDeg: (fovY * 180/Math.PI) });
  }

  // atlas
  if (obj.atlas){
    const w = obj.atlas.width|0, h = obj.atlas.height|0;
    sb.setTextureAtlasSize(w,h);
  }

  // materials (table: id -> desc)
  if (obj.materials && obj.materials.table){
    for (const k of Object.keys(obj.materials.table)){
      const id = _u32(k);
      sb.addMaterial(id, obj.materials.table[k]);
    }
  }

  // lights
  if (obj.lights){
    if (obj.lights.env)  sb.setEnvLight(obj.lights.env.color ?? [0,0,0], obj.lights.env.intensity ?? 0.0);
    if (obj.lights.area) sb.setAreaLight(obj.lights.area.center ?? [3,2.8,3], +obj.lights.area.radius || 0.5, { auto: !!obj.lights.area.auto });
  }

  // geometry
  for (const s of (obj.geometry?.spheres ?? []))
    sb.addSphere(s.p ?? [0,0,0], Number(s.r)||1, _u32(s.matId ?? DEFAULT_MAT_ID));

  for (const t of (obj.geometry?.tris ?? []))
    sb.addTriangle(
      t.a ?? [0,0,0], t.b ?? [1,0,0], t.c ?? [0,1,0],
      _u32(t.matId ?? DEFAULT_MAT_ID),
      t.uvA ?? [0,0], t.uvB ?? [0,0], t.uvC ?? [0,0]
    );

  for (const q of (obj.geometry?.quads ?? []))
    sb.addQuad(
      q.a ?? [0,0,0], q.b ?? [1,0,0], q.c ?? [1,1,0], q.d ?? [0,1,0],
      _u32(q.matId ?? DEFAULT_MAT_ID),
      q.uv0 ?? [0,0], q.uv1 ?? [0,0], q.uv2 ?? [0,0], q.uv3 ?? [0,0]
    );

  if (DBG) console.log('[PT] fromObject ok');
  return sb;
}
