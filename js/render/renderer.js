// js/render/renderer.js
import { camera } from '../camera.js';
import { config } from '../config.js';
import { createGL, createQuad, bindQuadAttrib, flipAndCopy } from './gl/context.js';
import { TracerPass } from './passes/tracerPass.js';
import { AccumPass } from './passes/accumPass.js';
import { Targets } from './targets.js';

let gl, canvas, quadVbo;
let tracerPass, accumPass, targets;
let aState = null;
let lastCam = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN };

// Debug gate (only prints if ?debug is in the URL)
const __DEBUG = (() => {
  try { return new URLSearchParams(location.search).has('debug'); }
  catch { return false; }
})();

function __camLookDir(cam) {
  return {
    x: Math.cos(cam.pitch) * Math.cos(cam.yaw),
    y: Math.sin(cam.pitch),
    z: Math.cos(cam.pitch) * Math.sin(cam.yaw),
  };
}

let __lastLogTime = 0;
function __logCamera(cam) {
  if (!__DEBUG) return;
  const now = performance.now();
  if (now - __lastLogTime < 200) return; // throttle: 5 logs/sec max
  const l = __camLookDir(cam);
  console.log(
    `[camera] pos=(${cam.pos.x.toFixed(3)}, ${cam.pos.y.toFixed(3)}, ${cam.pos.z.toFixed(3)}) `
    + `look=(${l.x.toFixed(3)}, ${l.y.toFixed(3)}, ${l.z.toFixed(3)}) `
    + `yaw=${cam.yaw.toFixed(3)} pitch=${cam.pitch.toFixed(3)}`
  );
  __lastLogTime = now;
}

function ensureRenderer() {
  if (!gl || gl.isContextLost?.()) {
    ({ gl, canvas } = createGL());
    quadVbo = createQuad(gl);
    bindQuadAttrib(gl, quadVbo);
  } else if (!quadVbo) {
    quadVbo = createQuad(gl);
    bindQuadAttrib(gl, quadVbo);
  }
  if (!targets)    targets    = new Targets(gl);
  if (!tracerPass) tracerPass = new TracerPass(gl, quadVbo, (config.PATH_TRACER ?? {}));
  if (!accumPass)  accumPass  = new AccumPass(gl, quadVbo, (config.TEMPORAL ?? {}));
}

function ensureTargets() {
  ensureRenderer();
  const w = (config.VIRTUAL_GRID_WIDTH  | 0) || 1;
  const h = (config.VIRTUAL_GRID_HEIGHT | 0) || 1;
  targets.ensure(w, h);
  ensureAdaptiveState(w, h);
  return { w, h };
}

function ensureAdaptiveState(w, h) {
  const AD = config.ADAPTIVE ?? {};
  const enabled = !!AD.ENABLED;
  const size = w * h;
  const batch = (config.PATH_TRACER?.SAMPLES_PER_BATCH ?? 12) | 0;

  const needsNew =
    !aState ||
    aState.size !== size ||
    aState.enabled !== enabled ||
    aState.batch !== batch ||
    aState.maxTol !== (AD.MAX_TOLERANCE ?? 0.05) ||
    aState.maxSamples !== ((AD.MAX_SAMPLES ?? 2048) | 0);

  if (!needsNew) return;

  aState = {
    enabled,
    batch: batch > 0 ? batch : 1,
    maxTol: AD.MAX_TOLERANCE ?? 0.05,
    maxSamples: (AD.MAX_SAMPLES ?? 2048) | 0,
    k: new Uint32Array(size),
    mean: new Float32Array(size),
    M2: new Float32Array(size),
    active: new Uint8Array(size).fill(255),
    activeCount: size,
    size,
  };

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, targets.maskTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.LUMINANCE, gl.UNSIGNED_BYTE, aState.active);
  targets.historyIdx = 0;
}

function cameraMoved() {
  const TP = config.TEMPORAL ?? {};
  if (!TP.RESET_ON_CAMERA_CHANGE) {
    lastCam = { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z, yaw: camera.yaw, pitch: camera.pitch };
    return false;
  }

  const dx = camera.pos.x - (lastCam.x || 0);
  const dy = camera.pos.y - (lastCam.y || 0);
  const dz = camera.pos.z - (lastCam.z || 0);
  const dp = Math.abs(camera.pitch - (lastCam.pitch || 0));
  const dyaw = Math.abs(camera.yaw - (lastCam.yaw || 0));

  const posThresh = TP.POS_EPS ?? 1e-4;
  const angThresh = TP.ANG_EPS ?? 1e-4;

  const moved = (dx*dx + dy*dy + dz*dz) > posThresh || dp > angThresh || dyaw > angThresh;

  // Update last snapshot
  lastCam = { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z, yaw: camera.yaw, pitch: camera.pitch };

  if (moved) __logCamera(camera);
  return moved;
}

function passTrace(time, w, h, scene) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.current.fb);
  gl.viewport(0, 0, w, h);
  tracerPass.draw(gl, {
    time,
    width: w, height: h,
    cam: { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z, yaw: camera.yaw, pitch: camera.pitch },
    fovY: (config.CAMERA?.FOVY_DEG ?? 80) * Math.PI / 180,
    gamma: (config.PATH_TRACER?.GAMMA_EXP ?? 0.45),
    scene, // <-- NEW
  });
}

function passAccumulate(w, h, { forceCopy, useTemporalAlways }) {
  const TP = config.TEMPORAL ?? {};
  const readIdx  = targets.historyIdx;
  const writeIdx = readIdx ^ 1;

  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.accum[writeIdx].fb);
  gl.viewport(0, 0, w, h);

  const useTemporal = (useTemporalAlways || TP.ENABLED) && !forceCopy;
  const texMask = forceCopy ? targets.maskOneTex : targets.maskTex;

  accumPass.draw(gl, {
    width: w, height: h,
    texCurrent:     targets.current.tex,
    texAccumPrev:   targets.accum[readIdx].tex,
    texActiveMask:  texMask,
    sigma:      TP.SIGMA ?? 1.5,
    diffScale:  TP.DIFF_SCALE ?? 0.3,
    diffPower:  TP.DIFF_POWER ?? 0.5,
    minBlend:   forceCopy ? 1.0 : (TP.MIN_BLEND ?? 0.1),
    useTemporal,
    gammaExp:   config.PATH_TRACER?.GAMMA_EXP ?? 0.45,
  });

  targets.historyIdx = writeIdx;
}

function updateAdaptiveFromBatch(scratchRGBA, w, h) {
  if (!aState || !aState.enabled) return;
  const size = w * h;
  const inv255 = 1/255;
  const gamma = config.PATH_TRACER?.GAMMA_EXP ?? 0.45;
  const invGamma = gamma > 0 ? (1/gamma) : 1.0;
  const maxTol = aState.maxTol;
  const batchSize = Math.max(1, aState.batch);
  const maxSamples = Math.max(batchSize, aState.maxSamples);

  let activeCount = 0;
  for (let i=0, p=0; i<size; i++, p+=4){
    if (aState.active[i] === 0) continue;
    const r = Math.pow(scratchRGBA[p]*inv255, invGamma);
    const g = Math.pow(scratchRGBA[p+1]*inv255, invGamma);
    const b = Math.pow(scratchRGBA[p+2]*inv255, invGamma);
    const y = 0.3*r + 0.59*g + 0.11*b;

    const kNew = (aState.k[i] + 1) >>> 0;
    const delta = y - aState.mean[i];
    const meanNew = aState.mean[i] + delta / kNew;
    const delta2 = y - meanNew;
    const M2New = aState.M2[i] + delta * delta2;

    aState.k[i] = kNew;
    aState.mean[i] = meanNew;
    aState.M2[i] = M2New;

    let converged = false;
    if (kNew >= 2) {
      const variance = M2New / (kNew - 1);
      const I = 1.96 * Math.sqrt(variance / kNew);
      if (I <= maxTol * Math.max(meanNew, 1e-8)) converged = true;
    }
    if (!converged && (kNew * batchSize >= maxSamples)) converged = true;

    if (converged) aState.active[i] = 0; else activeCount++;
  }
  aState.activeCount = activeCount;

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, targets.maskTex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.LUMINANCE, gl.UNSIGNED_BYTE, aState.active);
}

// Public API
export function renderScene(timeSec, framebuffer, appState) {
  ensureRenderer();
  const { w, h } = ensureTargets();

  const moved = cameraMoved();
  const firstAccum = (targets.historyIdx === 0);

  // 1) Trace batch with current scene
  const scene = appState?.scene;
  passTrace(timeSec, w, h, scene);

  // 2) Adaptive stats
  if (aState?.enabled) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets.current.fb);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, targets.scratch);
    updateAdaptiveFromBatch(targets.scratch, w, h);
  }

  // 3) Accumulate
  passAccumulate(w, h, { forceCopy: moved || firstAccum, useTemporalAlways: !!(aState?.enabled) });

  // 4) Read back
  gl.bindFramebuffer(gl.FRAMEBUFFER, targets.accum[targets.historyIdx].fb);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, targets.scratch);
  flipAndCopy(targets.scratch, framebuffer, w, h);
}

export function renderRaw({ time, mouse=[0,0,0,0], resolution, framebuffer=null }) {
  ensureRenderer();
  const w = (resolution?.[0] ?? config.VIRTUAL_GRID_WIDTH);
  const h = (resolution?.[1] ?? config.VIRTUAL_GRID_HEIGHT);
  targets.ensure(w, h);
  ensureAdaptiveState(w, h);

  const moved = cameraMoved();
  passTrace(time, w, h, null);

  if (!framebuffer && (config.TEMPORAL?.ENABLED)) {
    passAccumulate(w, h, { forceCopy: moved || targets.historyIdx === 0, useTemporalAlways: !!(aState?.enabled) });
  }

  if (framebuffer) gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
}

export function getPixels({ framebuffer=null, width, height, flipY=true }) {
  ensureRenderer();
  const w = (width  ?? targets.width  ?? config.VIRTUAL_GRID_WIDTH);
  const h = (height ?? targets.height ?? config.VIRTUAL_GRID_HEIGHT);
  targets.ensure(w, h);

  const out = new Uint8Array(w*h*4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer ?? targets.current.fb);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
  if (!flipY) return out;
  const flipped = new Uint8Array(out.length);
  flipAndCopy(out, flipped, w, h);
  return flipped;
}

export function disposeGPU() {
  if (!gl) return;
  tracerPass?.dispose(gl);
  accumPass?.dispose(gl);
  targets?.dispose();
  if (quadVbo) gl.deleteBuffer(quadVbo);
  tracerPass = accumPass = targets = null;
  quadVbo = null;
  gl = null;
  canvas = null;
  lastCam = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN };
  aState = null;
}
