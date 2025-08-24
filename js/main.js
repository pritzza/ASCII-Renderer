// js/main.js
// Overlay sits above the canvas. RMB behavior:
// - Right-click highlighted text: DOM context menu (no lock)
// - Right-click non-highlighted text: enter pointer lock
// - While locked, any right-click: exit pointer lock
// Overlay DOM text updates incrementally (1 row per frame by default).

import { config } from './config.js';
import { createBuffer } from './utils.js';
import { camera, keysPressed, updateCamera } from './camera.js';
import { createScene } from './scene.js';
import { renderUI } from './renderer.js';
import { renderScene } from './gpu_renderer.js';
import { setBackend, setScene } from './gpu_renderer.js';
import { AsciiPass } from './ascii_pass.js';
import { TextOverlay } from './text_overlay.js';

const state = {
  // grid/viewport sizing
  charWidth: 0, charHeight: 0,
  cols: config.VIRTUAL_GRID_WIDTH,
  rows: config.VIRTUAL_GRID_HEIGHT,

  // DOM refs
  viewportEl: null,
  outputCanvas: null,
  previewCanvas: null, previewCtx: null, previewImageData: null,

  // scene & UI
  scene: [],
  uiEffects: [],

  // input/loop
  lookActive: false,
  animationId: null,
  lastUpdateTime: 0,
  time: 0,

  // CPU double buffers
  fbA: null, fbB: null,
  displayBuffer: null,
  workBuffer: null,
  framebuffer: null,
  gpuInFlight: false,
  frameReady: false,

  // UI buffer
  uiBuffer: null,

  // ascii pass
  ascii: null,
  debug: false,

  // overlay
  overlay: null,

  // overlay update cadence
  overlayRowCursor: 0,
  overlayFrameCount: 0,
  // 'row' = update 1 row each frame; 'interval' = refresh all rows every N frames; 'off' disables
  overlayUpdateMode: 'row',
  overlayIntervalN: 60,
};

function hasDebugFlag() {
  const p = new URLSearchParams(location.search);
  if (!p.has('debug')) return false;
  const v = (p.get('debug') || '').toLowerCase();
  return v === '' || v === '1' || v === 'true' || v === 'yes';
}

/* --- snap the canvas to device pixels (with flip) --- */
function snapToDevicePixels(el) {
  const dpr = window.devicePixelRatio || 1;
  const r = el.getBoundingClientRect();
  const fx = (r.left * dpr) - Math.round(r.left * dpr);
  const fy = (r.top  * dpr) - Math.round(r.top  * dpr);
  const tx = -fx / dpr;
  const ty = -fy / dpr;
  el.style.transform = `translate(${tx}px, ${ty}px) scaleY(-1)`;
}

/* ----------------------------- Input setup ----------------------------- */
function attachInput() {
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    keysPressed.add(k);
  });
  window.addEventListener('keyup', (e) => keysPressed.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keysPressed.clear());

  // Only MIDDLE button directly requests pointer lock here.
  // RMB is fully handled by the overlay (so DOM menu can appear when needed).
  state.viewportEl.addEventListener('mousedown', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      state.viewportEl.requestPointerLock?.();
    }
  });

  // DO NOT blanket-prevent context menus here; overlay decides when to allow it.

  document.addEventListener('pointerlockchange', () => {
    state.lookActive = (document.pointerLockElement === state.viewportEl);
  });

  document.addEventListener('mousemove', (e) => {
    if (!state.lookActive) return;
    const sens = camera.sensitivity * 0.002;
    camera.yaw   += e.movementX * sens;
    camera.pitch -= e.movementY * sens;
    const lim = Math.PI * 0.5 - 0.1;
    if (camera.pitch >  lim) camera.pitch =  lim;
    if (camera.pitch < -lim) camera.pitch = -lim;
    if (camera.yaw >  Math.PI) camera.yaw -= Math.PI * 2;
    if (camera.yaw < -Math.PI) camera.yaw += Math.PI * 2;
  });

  state.viewportEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const s = Math.max(0.25, Math.min(20, camera.speed * (e.deltaY < 0 ? 1.1 : 0.9)));
    camera.speed = s;
  }, { passive: false });

  // MINIMAL FIX: while in pointer lock, a right-click exits lock
  document.addEventListener('mousedown', (e) => {
    if (e.button === 2 && document.pointerLockElement === state.viewportEl) {
      e.preventDefault();           // avoid context menu on exit
      document.exitPointerLock?.();
    }
  }, true); // capture so we run before anything else

}

/* ------------------------------ App setup ------------------------------ */
function measureCharSize() {
  const el = document.getElementById('measure');
  const rect = el.getBoundingClientRect();
  state.charWidth  = Math.max(0.5, rect.width);
  state.charHeight = Math.max(0.5, rect.height);
}

function init() {
  const params = new URLSearchParams(location.search);
  const requested = (params.get('backend') || params.get('renderer') || (config.DEFAULT_BACKEND || 'pathtrace')).toLowerCase();
  try { if (typeof setBackend === 'function') setBackend(requested); }
  catch (err) {
    console.warn(`[init] setBackend("${requested}") failed; falling back to "pathtrace"`, err);
    try { setBackend('pt'); } catch {}
  }

  state.debug = hasDebugFlag();

  state.viewportEl = document.getElementById('grid-viewport');

  // Create / attach our canvas if not present
  let out = document.getElementById('ascii-canvas');
  if (!out) {
    out = document.createElement('canvas');
    out.id = 'ascii-canvas';
    out.style.display = 'block';
    out.style.removeProperty('width');
    out.style.removeProperty('height');
    out.style.imageRendering = 'pixelated';
    state.viewportEl.innerHTML = '';
    state.viewportEl.appendChild(out);
  }
  state.outputCanvas = out;

  // Ensure canvas is positioned and underlayed
  state.outputCanvas.style.position = 'absolute';
  state.outputCanvas.style.top = '0';
  state.outputCanvas.style.left = '0';
  state.outputCanvas.style.zIndex = '1';

  const previewWrap = document.getElementById('preview-wrap');
  if (previewWrap) previewWrap.style.display = state.debug ? 'block' : 'none';
  if (state.debug) {
    state.previewCanvas = document.getElementById('preview');
    state.previewCtx    = state.previewCanvas.getContext('2d', { willReadFrequently: false });
  } else {
    state.previewCanvas = null; state.previewCtx = null;
  }

  // Measure cell size and propagate aspect
  measureCharSize();
  config.PATH_TRACER.PIXEL_ASPECT = state.charWidth / state.charHeight;

  // Scene and camera
  state.scene = createScene();
  if (state.scene?.camera?.pos) {
    const c = state.scene.camera;
    camera.pos.x = c.pos[0]; camera.pos.y = c.pos[1]; camera.pos.z = c.pos[2];
    if (Number.isFinite(c.yaw))   camera.yaw   = c.yaw;
    if (Number.isFinite(c.pitch)) camera.pitch = c.pitch;
  }
  if (typeof setScene === 'function') setScene(state.scene);

  // CPU buffers
  const n = state.cols * state.rows * 4;
  state.fbA = new Uint8ClampedArray(n);
  state.fbB = new Uint8ClampedArray(n);
  state.displayBuffer = state.fbA;
  state.workBuffer    = state.fbB;
  state.framebuffer   = state.displayBuffer;

  // UI buffer
  state.uiBuffer = createBuffer(state.cols, state.rows, null);

  // Initialize ASCII GPU pass
  state.ascii = new AsciiPass(state.outputCanvas, {
    grayscaleText: !!config.USE_GRAYSCALE,
    alphaGamma: 1.32,
    alphaKnee: 0.3,
    alphaBiasPre: 0.1,
    alphaCutoff: 0.4,
    alphaBiasPost: 0.05,
    transparentBackground: true
  });
  state.ascii.setCellSize(state.charWidth, state.charHeight);

  // Snap canvas to device pixels
  snapToDevicePixels(state.outputCanvas);

  // Input
  attachInput();

  // Overlay (above canvas) — RMB logic handled inside TextOverlay
  state.overlay = new TextOverlay({
    mountEl: state.viewportEl,
    canvasEl: state.outputCanvas,
    pointerLockEl: state.viewportEl,
    getGrid: () => ({ cols: state.cols, rows: state.rows, charWidth: state.charWidth, charHeight: state.charHeight }),
    getDisplayBuffer: () => state.displayBuffer,
    ramp: config.ASCII_RAMP,
    frozen: false,
    onMouseDown: (info, e) => {
      // Forward to game logic:
      if (e.button === 0) handleGameClickAt(info.x, info.y, 0);
      if (e.button === 2) {
        // Only forward RMB to game if NOT on selection (onSelection => pure DOM menu)
        if (!info.onSelection) handleGameClickAt(info.x, info.y, 2);
      }
    },
    onClick: () => {},
    onContextMenu: () => {}, // overlay decides whether to allow the menu
  }).init();

  window.addEventListener('resize', () => {
    measureCharSize();
    state.ascii.setCellSize(state.charWidth, state.charHeight);
    snapToDevicePixels(state.outputCanvas);
    state.overlay.sizeToGrid();
    state.overlay.refreshAllRows();
  });

  state.viewportEl.addEventListener('scroll', () => {
    snapToDevicePixels(state.outputCanvas);
    state.overlay.alignToDevicePixels();
  }, { passive: true });

  // Timebase
  state.lastUpdateTime = performance.now();
  state.time = state.lastUpdateTime;

  // Kick first GPU job
  kickGPU(performance.now() * 0.001);

  // Loop
  animationLoop();
}

function updateDomOverlay() {
  if (!state.overlay) return;
  state.overlayFrameCount++;

  switch (state.overlayUpdateMode) {
    case 'off':
      return;

    case 'row': {
      // cheapest: mutate one DOM row per frame
      state.overlay.refreshRow(state.overlayRowCursor);
      state.overlayRowCursor = (state.overlayRowCursor + 1) % state.rows;
      return;
    }

    case 'interval': {
      // full refresh every N frames
      if (state.overlayFrameCount % Math.max(1, state.overlayIntervalN) === 0) {
        state.overlay.refreshAllRows();
      }
      return;
    }
  }
}

/* ------------------------ UI overlay into framebuffer ------------------------ */
function applyUIToFrameRGBA() {
  const { cols, rows, uiBuffer, displayBuffer } = state;
  if (!uiBuffer || !displayBuffer) return;
  for (let y = 0; y < rows; y++) {
    const row = uiBuffer[y];
    for (let x = 0; x < cols; x++) {
      if (row[x] == null) continue;
      const i = (y * cols + x) * 4;

      // Draw UI as black (same as before)...
      displayBuffer[i + 0] = 0;
      displayBuffer[i + 1] = 0;
      displayBuffer[i + 2] = 0;

      // Encode ASCII override directly: A = ASCII code (>=2 means “override”)
      const chCode = row[x].charCodeAt(0) & 0xFF;
      displayBuffer[i + 3] = chCode; // reserve 0/1 as “no override”
    }
  }
}

/* ------------------------------ GPU dispatch ----------------------------- */
function kickGPU(timeSec) {
  if (state.gpuInFlight) return;
  state.gpuInFlight = true;

  const defer = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
  defer(() => {
    renderScene(timeSec, state.workBuffer, state);
    state.frameReady = true;
    state.gpuInFlight = false;
    state.workBuffer = (state.workBuffer === state.fbA) ? state.fbB : state.fbA;
  });
}

/* ------------------------------ Game clicks ------------------------------ */
function handleGameClickAt(virtualX, virtualY, button) {
  if (button === 0) {
    state.uiEffects.push({
      type: 'ripple',
      center: { x: virtualX, y: virtualY },
      startTime: performance.now()
    });
  }
  if (button === 2) {
    // hook your RMB logic if any (placing markers, opening radial menus, etc.)
  }
}

/* --------------------------------- Loop ---------------------------------- */
function animationLoop(currentTime) {
  state.animationId = requestAnimationFrame(animationLoop);

  const elapsed = currentTime - state.lastUpdateTime;
  const frameInterval = 1000 / config.TARGET_FPS;
  if (elapsed < frameInterval) return;

  state.lastUpdateTime = currentTime;
  state.time = currentTime;
  const deltaTime = elapsed / 1000;
  const fps = 1 / Math.max(deltaTime, 1e-6);

  updateCamera(deltaTime);

  if (state.frameReady) {
    state.frameReady = false;
    state.displayBuffer = (state.workBuffer === state.fbA) ? state.fbB : state.fbA;
    state.framebuffer   = state.displayBuffer;

    if (state.debug && state.previewCtx && state.previewCanvas) {
      if (!state.previewImageData ||
          state.previewImageData.width  !== state.cols ||
          state.previewImageData.height !== state.rows) {
        state.previewImageData = new ImageData(state.cols, state.rows);
      }
      state.previewImageData.data.set(state.displayBuffer);
      state.previewCtx.putImageData(state.previewImageData, 0, 0);
    }

    renderUI(Math.round(fps), state);
    applyUIToFrameRGBA();

    state.ascii.drawFromBuffer(state.displayBuffer, state.cols, state.rows);

    // Update the invisible DOM text on your chosen cadence
    updateDomOverlay();
  }

  kickGPU(currentTime * 0.001);
}

document.addEventListener('DOMContentLoaded', init);
