// js/render/scene_api.js
// Unified scene representation + backward-compatible builder for all backends.
// Goals:
//  - One authoring API usable by raster, raytrace, and pathtrace backends.
//  - Identical *input* structure for all backends (materials, geometry, lights, camera).
//  - Adapter methods that return legacy/PT/raster/RT-friendly shapes without breaking
//    existing code (e.g. sb.toObject() still returns the legacy Path Tracer shape).
//
// Design highlights:
//  - Materials are explicit objects: { albedo, emissive, emission, reflective, roughness }.
//    * albedo:    [r,g,b] 0..1, used by all backends.
//    * emissive:  boolean  (PT-only). If true, 'emission' color is used as light when hit.
//    * emission:  [r,g,b]  radiance when emissive=true (PT-only).
//    * reflective:boolean  flat perfect mirror for RT; specular/dielectric branch for PT.
//    * roughness: 0..1     PT-only; others ignore (RT is perfect mirror or diffuse).
//  - Lights:
//    * points:       used by RT + raster.
//    * directionals: used by raster (and optionally RT).
//    * env:          used by raster (background tint) and PT internally via environment fn.
//    * area (sphere): used by PT for NEE sampling (matches current renderer).
//
// Back-compat:
//  - We keep export { Materials, createSceneBuilder } with the same method names.
//  - sb.toObject() returns the *legacy Path Tracer* shape the current shader expects.
//  - You can also call sb.toUnified(), sb.toPathTracer(), sb.toRaster(), sb.toRaytrace().

export const Materials = Object.freeze({
  LIGHT: 0.0,
  WHITE: 1.0,
  GREEN: 2.0,
  RED:   3.0,
  GLASS: 6.0,         // legacy: tracer treats m>4.5 as specular/dielectric
  MIRROR: 7.0,        // new convenience for a perfect reflector (RT), maps to GLASS in PT
});

function _isFinite3(a){ return Array.isArray(a) && a.length === 3 && a.every(Number.isFinite); }
function _norm3(v){ const L = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/L, v[1]/L, v[2]/L]; }
function _clamp01(x){ return Math.min(1, Math.max(0, +x)); }
function _vec3(x=0,y=0,z=0){ return [ +x, +y, +z ]; }
function _copy3(v){ return [ +v[0], +v[1], +v[2] ]; }
function _eq3(a,b,eps=1e-6){ return Math.abs(a[0]-b[0])<eps && Math.abs(a[1]-b[1])<eps && Math.abs(a[2]-b[2])<eps; }

// Default palette used for the legacy PT shader's hard-coded diffuse colors.
const PT_COLOR_PRESETS = {
  WHITE: [0.7295, 0.7355, 0.7290],
  GREEN: [0.1170, 0.4125, 0.1150],
  RED:   [0.6110, 0.0555, 0.0620],
  LIGHT: [16.86, 10.76, 8.2],
};

// ----- Unified material helpers ------------------------------------------------
function _mkMaterial({
  name = '',
  albedo = [0.8,0.8,0.8],
  emissive = false,
  emission = [0,0,0],
  reflective = false,
  roughness = 0.0,
} = {}){
  const a = _copy3(albedo).map(_clamp01);
  const e = _copy3(emission).map(x => +x);
  return { name:String(name||''), albedo:a, emissive:!!emissive, emission:e, reflective:!!reflective, roughness:_clamp01(roughness) };
}

function _nearestPresetName(rgb){
  // Map arbitrary albedo to nearest of WHITE/GREEN/RED for the legacy shader.
  const keys = ['WHITE','GREEN','RED'];
  const presets = keys.map(k => PT_COLOR_PRESETS[k]);
  let bestK = 'WHITE', bestD = 1e9;
  for (let i=0;i<presets.length;i++){
    const p = presets[i];
    const dx = p[0]-rgb[0], dy = p[1]-rgb[1], dz = p[2]-rgb[2];
    const d = dx*dx + dy*dy + dz*dz;
    if (d < bestD){ bestD = d; bestK = keys[i]; }
  }
  return bestK;
}

// Encode a unified material to the single float 'm' used by the legacy path tracer.
function _encodePTMaterial(mat){
  if (mat.emissive) return Materials.LIGHT;
  if (mat.reflective) return Materials.GLASS; // PT uses dielectric/specular branch
  const preset = _nearestPresetName(mat.albedo);
  return Materials[preset];
}

// ----- Builder ----------------------------------------------------------------
export class SceneBuilder {
  constructor(maxSpheres = 64, maxPlanes = 32, maxTris = 4096){
    this._maxS = maxSpheres|0;
    this._maxP = maxPlanes|0;
    this._maxT = maxTris|0;

    // unified store
    this._materials = [];         // array of unified materials
    this._matIndex = new Map();   // name -> index (optional)
    this._geom = { spheres:[], planes:[], tris:[] };
    this._lights = {
      points: [],                 // [{p:[x,y,z], color:[r,g,b], intensity}]
      directionals: [],           // [{dir:[x,y,z], color:[r,g,b], intensity}]
      env: { color:[0,0,0], intensity: 0.0 },
      area: { center:[3,2.8,3], radius:0.5, auto:true }, // PT light sphere
    };
    this._camera = { pos:[2.78, 2.73, -8.00], yaw: 0.0, pitch: 0.0, fovY: 80 * Math.PI/180 };

    // default materials (ids align with legacy "Materials" enum)
    this._defaults = {
      [Materials.LIGHT]:  this.addMaterial({ name:'LIGHT',  albedo:[1,1,1], emissive:true,  emission:PT_COLOR_PRESETS.LIGHT, reflective:false, roughness:0 }),
      [Materials.WHITE]:  this.addMaterial({ name:'WHITE',  albedo:PT_COLOR_PRESETS.WHITE, emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }),
      [Materials.GREEN]:  this.addMaterial({ name:'GREEN',  albedo:PT_COLOR_PRESETS.GREEN, emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }),
      [Materials.RED]:    this.addMaterial({ name:'RED',    albedo:PT_COLOR_PRESETS.RED,   emissive:false, emission:[0,0,0], reflective:false, roughness:0.6 }),
      [Materials.GLASS]:  this.addMaterial({ name:'GLASS',  albedo:[1,1,1], emissive:false, emission:[0,0,0], reflective:true,  roughness:0.0 }),
      [Materials.MIRROR]: this.addMaterial({ name:'MIRROR', albedo:[1,1,1], emissive:false, emission:[0,0,0], reflective:true,  roughness:0.0 }),
    };
  }

  // --- Materials API ----------------------------------------------------------
  addMaterial(def){ 
    const m = _mkMaterial(def||{});
    const nameKey = m.name ? String(m.name) : '';
    // de-duplicate by name if provided
    if (nameKey && this._matIndex.has(nameKey)) {
      const idx = this._matIndex.get(nameKey);
      this._materials[idx] = m;
      return idx;
    }
    const idx = this._materials.length;
    this._materials.push(m);
    if (nameKey) this._matIndex.set(nameKey, idx);
    return idx;
  }
  getMaterialIndex(ref){
    // Accept numeric (legacy enum or explicit index), string name, or material object
    if (typeof ref === 'number') {
      if (ref in this._defaults) return this._defaults[ref]; // map enum -> index
      // otherwise assume caller passed an explicit material index
      if (ref >= 0 && ref < this._materials.length) return ref|0;
    }
    if (typeof ref === 'string') {
      return this._matIndex.has(ref) ? this._matIndex.get(ref) : this.addMaterial({ name:ref });
    }
    if (ref && typeof ref === 'object') {
      return this.addMaterial(ref);
    }
    // fallback: WHITE
    return this._defaults[Materials.WHITE];
  }

  // --- Camera -----------------------------------------------------------------
  setCameraPose(pos=[2.78,2.73,-8.00], { yaw=0.0, pitch=0.0, fovYDeg=80 } = {}){
    if (!_isFinite3(pos) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) {
      throw new Error('setCameraPose: bad args');
    }
    this._camera = { pos:[+pos[0],+pos[1],+pos[2]], yaw:+yaw, pitch:+pitch, fovY: (+fovYDeg) * Math.PI/180 };
    return this;
  }

  // --- Lights -----------------------------------------------------------------
  setEnvLight(color=[0,0,0], intensity=0.0){
    if (!_isFinite3(color) || !Number.isFinite(intensity)) throw new Error('setEnvLight: bad args');
    this._lights.env = { color:[+color[0],+color[1],+color[2]], intensity:+intensity };
    return this;
  }
  addPointLight(pos=[0,0,0], color=[1,1,1], intensity=1.0){
    if (!_isFinite3(pos) || !_isFinite3(color) || !Number.isFinite(intensity)) throw new Error('addPointLight: bad args');
    this._lights.points.push({ p:[+pos[0],+pos[1],+pos[2]], color:[+color[0],+color[1],+color[2]], intensity:+intensity });
    return this;
  }
  addDirectionalLight(dir=[0,-1,0], color=[1,1,1], intensity=0.0){
    if (!_isFinite3(dir) || !_isFinite3(color) || !Number.isFinite(intensity)) throw new Error('addDirectionalLight: bad args');
    const d = _norm3(dir);
    this._lights.directionals.push({ dir:d, color:[+color[0],+color[1],+color[2]], intensity:+intensity });
    return this;
  }
  setLight(center=[3,2.8,3], radius=0.5, { auto=true } = {}){
    if (!_isFinite3(center) || !Number.isFinite(radius)) throw new Error('setLight: bad args');
    this._lights.area = { center:[+center[0],+center[1],+center[2]], radius:+radius, auto:!!auto };
    return this;
  }
  // Back-compat alias for older scene code.
// Replaces (or creates) the primary directional light at index 0.
setDirLight(dir = [0, -1, 0], color = [1, 1, 1], intensity = 1.0) {
  if (!_isFinite3(dir) || !_isFinite3(color) || !Number.isFinite(intensity)) {
    throw new Error('setDirLight: bad args');
  }
  const d = _norm3(dir);
  const L = {
    dir: [d[0], d[1], d[2]],
    color: [ +color[0], +color[1], +color[2] ],
    intensity: +intensity
  };
  if (this._lights.directionals.length) {
    this._lights.directionals[0] = L;
  } else {
    this._lights.directionals.push(L);
  }
  return this;
}


  // --- Geometry ---------------------------------------------------------------
  addSphere(center=[0,0,0], radius=1.0, material=Materials.WHITE){
    if (!_isFinite3(center) || !Number.isFinite(radius)) throw new Error('addSphere: bad args');
    if (this._geom.spheres.length >= this._maxS) return this;
    const mi = this.getMaterialIndex(material);
    this._geom.spheres.push({ p:[+center[0],+center[1],+center[2]], r:+radius, mat: mi });
    return this;
  }
  addPlane(normal=[0,1,0], d=0.0, material=Materials.WHITE){
    if (!_isFinite3(normal) || !Number.isFinite(d)) throw new Error('addPlane: bad args');
    if (this._geom.planes.length >= this._maxP) return this;
    const n = _norm3(normal);
    const mi = this.getMaterialIndex(material);
    this._geom.planes.push({ n:[n[0],n[1],n[2]], d:+d, mat: mi });
    return this;
  }
  addTriangle(a=[0,0,0], b=[1,0,0], c=[0,1,0], material=Materials.WHITE){
    if (!_isFinite3(a) || !_isFinite3(b) || !_isFinite3(c)) throw new Error('addTriangle: bad args');
    if (this._geom.tris.length >= this._maxT) return this;
    const mi = this.getMaterialIndex(material);
    this._geom.tris.push({ a:_copy3(a), b:_copy3(b), c:_copy3(c), mat: mi });
    return this;
  }
  addQuad(p00, p10, p11, p01, material=Materials.WHITE){
    this.addTriangle(p00, p10, p11, material);
    this.addTriangle(p00, p11, p01, material);
    return this;
  }
  addMesh({ positions, indices = null, material = Materials.WHITE }){
    if (!Array.isArray(positions) || positions.length % 3 !== 0) return this;
    const V = positions.length / 3;
    const getV = (i) => [ positions[3*i], positions[3*i+1], positions[3*i+2] ];
    if (indices && indices.length % 3 === 0) {
      for (let t=0; t<indices.length; t+=3) {
        const i0=indices[t]|0, i1=indices[t+1]|0, i2=indices[t+2]|0;
        if (i0<0||i0>=V||i1<0||i1>=V||i2<0||i2>=V) continue;
        this.addTriangle(getV(i0), getV(i1), getV(i2), material);
      }
    } else {
      for (let i=0; i+8<positions.length; i+=9) {
        this.addTriangle(
          [positions[i+0], positions[i+1], positions[i+2]],
          [positions[i+3], positions[i+4], positions[i+5]],
          [positions[i+6], positions[i+7], positions[i+8]],
          material
        );
      }
    }
    return this;
  }

  // --- Output adapters --------------------------------------------------------
  toUnified(){
    // deep-ish clone to keep builder reusable
    return {
      version: 1,
      camera: { ...this._camera, pos: _copy3(this._camera.pos) },
      materials: this._materials.map(m => ({ ...m, albedo:_copy3(m.albedo), emission:_copy3(m.emission) })),
      geometry: {
        spheres: this._geom.spheres.map(s => ({ p:_copy3(s.p), r:+s.r, mat:(s.mat|0) })),
        planes:  this._geom.planes.map(p => ({ n:_copy3(p.n), d:+p.d, mat:(p.mat|0) })),
        tris:    this._geom.tris.map(t => ({ a:_copy3(t.a), b:_copy3(t.b), c:_copy3(t.c), mat:(t.mat|0) })),
      },
      lights: {
        points: this._lights.points.map(l => ({ p:_copy3(l.p), color:_copy3(l.color), intensity:+l.intensity })),
        directionals: this._lights.directionals.map(l => ({ dir:_copy3(l.dir), color:_copy3(l.color), intensity:+l.intensity })),
        env: { color:_copy3(this._lights.env.color), intensity:+this._lights.env.intensity },
        area: { center:_copy3(this._lights.area.center), radius:+this._lights.area.radius, auto:!!this._lights.area.auto },
      },
    };
  }

  // Legacy path tracer shape (what TracerPass.uploadScene expects today).
  toPathTracer(){
    const U = this.toUnified();
    const spheres = U.geometry.spheres.map(s => ({ p:s.p, r:s.r, m:_encodePTMaterial(U.materials[s.mat]) }));
    const planes  = U.geometry.planes.map(p => ({ p:[p.n[0], p.n[1], p.n[2], p.d], m:_encodePTMaterial(U.materials[p.mat]) }));
    const tris    = U.geometry.tris.map(t => ({ a:t.a, b:t.b, c:t.c, m:_encodePTMaterial(U.materials[t.mat]) }));
    const light   = { c: U.lights.area.center, r: U.lights.area.radius, auto: U.lights.area.auto };
    // Optional passthroughs (not used by current shader, kept for future)
    const envLight = { color: U.lights.env.color, intensity: U.lights.env.intensity };
    const dirLight = U.lights.directionals[0] ? { dir: U.lights.directionals[0].dir, color: U.lights.directionals[0].color, intensity: U.lights.directionals[0].intensity } : { dir:[0,-1,0], color:[1,1,1], intensity:0.0 };
    return { spheres, planes, tris, light, envLight, dirLight, camera: { pos: this._camera.pos, yaw: this._camera.yaw, pitch: this._camera.pitch } };
  }

  // Raster backend: prefer explicit materials + lights (points + dir + env)
  toRaster(){
    const U = this.toUnified();
    return U; // the raster backend can consume the unified structure directly
  }

  // Deterministic primary-ray + direct lighting backend.
  toRaytrace(){
    const U = this.toUnified();
    // Enforce RT constraints at material-level: perfect diffuse or perfect mirror
    const mats = U.materials.map(m => ({
      ...m,
      emissive: false, // ignored by RT
      emission: [0,0,0],
      reflective: !!m.reflective,
      roughness: 0.0,  // unused by RT
    }));
    return { ...U, materials: mats };
  }

  // Back-compat alias used by the current app code.
  toObject(){ return this.toPathTracer(); }

  // Reset to defaults (keeps default materials)
  reset(){
    this._geom = { spheres:[], planes:[], tris:[] };
    this._lights = {
      points: [],
      directionals: [],
      env: { color:[0,0,0], intensity: 0.0 },
      area: { center:[3,2.8,3], radius:0.5, auto:true },
    };
    this._camera = { pos:[2.78, 2.73, -8.00], yaw: 0.0, pitch: 0.0, fovY: 80 * Math.PI/180 };
    return this;
  }
}

// Factory
export function createSceneBuilder(maxSpheres, maxPlanes, maxTris){
  return new SceneBuilder(maxSpheres, maxPlanes, maxTris);
}

// Utility: create builder from a plain object roughly matching the unified schema.
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

  // materials (optional)
  if (Array.isArray(obj.materials)){
    for (const m of obj.materials){
      sb.addMaterial(m);
    }
  }

  // lights
  if (obj.lights){
    if (obj.lights.env) sb.setEnvLight(obj.lights.env.color ?? [0,0,0], obj.lights.env.intensity ?? 0.0);
    if (Array.isArray(obj.lights.points)){
      for (const L of obj.lights.points) sb.addPointLight(L.p ?? [0,0,0], L.color ?? [1,1,1], +L.intensity || 0.0);
    }
    if (Array.isArray(obj.lights.directionals)){
      for (const L of obj.lights.directionals) sb.addDirectionalLight(L.dir ?? [0,-1,0], L.color ?? [1,1,1], +L.intensity || 0.0);
    }
    if (obj.lights.area){
      sb.setLight(obj.lights.area.center ?? [3,2.8,3], +obj.lights.area.radius || 0.5, { auto: !!obj.lights.area.auto });
    }
  }

  // geometry
  for (const p of (obj.geometry?.planes ?? []))  sb.addPlane(p.n ?? [0,1,0], Number(p.d)||0, p.mat ?? Materials.WHITE);
  for (const s of (obj.geometry?.spheres ?? [])) sb.addSphere(s.p ?? [0,0,0], Number(s.r)||1, s.mat ?? Materials.WHITE);
  for (const t of (obj.geometry?.tris ?? []))    sb.addTriangle(t.a ?? [0,0,0], t.b ?? [1,0,0], t.c ?? [0,1,0], t.mat ?? Materials.WHITE);

  return sb;
}
