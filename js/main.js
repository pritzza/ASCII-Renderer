// js/main.js
import { config } from './config.js';
import { createBuffer } from './utils.js';
import { camera, keysPressed, updateCamera } from './camera.js';
import { createScene } from './scene.js';
import { renderUI, compositeAndQuantize } from './renderer.js';
import { renderScene } from './gpu_renderer.js';
import { setBackend, listBackends, getBackend, setScene } from './gpu_renderer.js';

const state = {
  // grid/viewport
  charWidth: 0, charHeight: 0,
  cols: config.VIRTUAL_GRID_WIDTH,
  rows: config.VIRTUAL_GRID_HEIGHT,
  visibleCols: 0, visibleRows: 0,
  gridOffsetX: 0, gridOffsetY: 0,
  viewportEl: null, scrollerEl: null, windowEl: null,

  // CPU buffers
  framebuffer: null,       // compatibility pointer (points at displayBuffer)
  uiBuffer: null,
  dataBuffer_chars: null,
  dataBuffer_colors: null,

  // DOM helpers
  nodePool: [],
  colorClassMap: new Map(),

  // loop/time
  animationId: null,
  lastUpdateTime: 0,
  time: 0,

  // scene & UI
  scene: [],
  uiEffects: [],
  isScrolling: false,
  scrollTimeout: null,

  // pointer-lock / mouselook
  lookActive: false,

  // preview canvas
  previewCanvas: null,
  previewCtx: null,
  previewImageData: null,

  // --- GPU/CPU double-buffering for one-frame latency ---
  fbA: null,
  fbB: null,
  displayBuffer: null, // last finished frame (CPU)
  workBuffer: null,    // where GPU will write next result (CPU)
  gpuInFlight: false,
  frameReady: false,

  // --- Dirty-tracking for minimal DOM updates (Step 1) ---
  _lastChars: null,
  _lastColors: null,
  _dirty: [],
};

// --- add near the top ---
function hasDebugFlag() {
    const p = new URLSearchParams(location.search);
    if (!p.has('debug')) return false;
    const v = (p.get('debug') || '').toLowerCase();
    return v === '' || v === '1' || v === 'true' || v === 'yes';
  }  

// ---------------- camera input glue ----------------
function attachInput() {
  // Keys (prevent page scroll on arrows/space)
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
    keysPressed.add(k);
  });
  window.addEventListener('keyup', (e) => keysPressed.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keysPressed.clear());

  // Right/middle click -> pointer lock for mouse look
  state.viewportEl.addEventListener('mousedown', (e) => {
    if (e.button === 1 || e.button === 2) {
      e.preventDefault();
      state.viewportEl.requestPointerLock?.();
    }
  });
  // Don’t show context menu (we use right-click)
  state.viewportEl.addEventListener('contextmenu', (e) => e.preventDefault());

  // Pointer lock state changes
  document.addEventListener('pointerlockchange', () => {
    state.lookActive = (document.pointerLockElement === state.viewportEl);
  });

  // Mouse look while locked
  document.addEventListener('mousemove', (e) => {
    if (!state.lookActive) return;
    const sens = camera.sensitivity * 0.002; // tune factor
    camera.yaw   += e.movementX * sens;
    camera.pitch -= e.movementY * sens;

    // clamp pitch to avoid flip
    const lim = Math.PI * 0.5 - 0.1;
    if (camera.pitch >  lim) camera.pitch =  lim;
    if (camera.pitch < -lim) camera.pitch = -lim;

    // wrap yaw for numerical stability
    if (camera.yaw >  Math.PI) camera.yaw -= Math.PI * 2;
    if (camera.yaw < -Math.PI) camera.yaw += Math.PI * 2;
  });

  // Optional: mouse wheel = speed tweak
  state.viewportEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return; // hold Ctrl to modify speed
    e.preventDefault();
    const s = Math.max(0.25, Math.min(20, camera.speed * (e.deltaY < 0 ? 1.1 : 0.9)));
    camera.speed = s;
  }, { passive: false });
}

// ---------------- app setup ----------------
function packColor(r, g, b) { return (r << 16) | (g << 8) | b; }

function init() {
  
  // --- Choose backend from URL or config ---
  // usage: ?backend=raster  or  ?backend=pathtrace  (default)
  const params = new URLSearchParams(location.search);
  const requested = (params.get('backend') || params.get('renderer') || (config.DEFAULT_BACKEND || 'pathtrace')).toLowerCase();
  try {
    if (typeof setBackend === 'function') setBackend(requested);
  } catch (err) {
    console.warn(`[init] setBackend("${requested}") failed; falling back to "pathtrace"`, err);
    try { setBackend('pt'); } catch {}
  }

  // --- Debug preview toggle (URL: ?debug or ?debug=1/true/yes) ---
  state.debug = hasDebugFlag();
  
  // DO NOT REMOVE
  //setBackend('pt'); // path tracer
  //setBackend('rt'); // ray tracer
  //setBackend('r');  // rasterizer
  
  // --- DOM refs ---
  state.viewportEl = document.getElementById('grid-viewport');
  state.scrollerEl = document.getElementById('grid-scroller');
  state.windowEl   = document.getElementById('grid-window');

  // --- Preview canvas (create only when debug is ON) ---
  const previewWrap = document.getElementById('preview-wrap');
  if (previewWrap) previewWrap.style.display = state.debug ? 'block' : 'none';
  if (state.debug) {
    state.previewCanvas = document.getElementById('preview');
    state.previewCtx    = state.previewCanvas.getContext('2d', { willReadFrequently: false });
    state.previewCanvas.width  = state.cols;
    state.previewCanvas.height = state.rows;
    state.previewImageData = new ImageData(state.cols, state.rows);
  } else {
    state.previewCanvas = null;
    state.previewCtx = null;
    state.previewImageData = null;
  }

  // --- Scene (programmatic) -> GPU ---
  state.scene = createScene();

  // Sync camera from scene (if scene provides a camera)
  if (state.scene?.camera?.pos) {
    const c = state.scene.camera;
    camera.pos.x = c.pos[0]; camera.pos.y = c.pos[1]; camera.pos.z = c.pos[2];
    if (Number.isFinite(c.yaw))   camera.yaw   = c.yaw;
    if (Number.isFinite(c.pitch)) camera.pitch = c.pitch;
  }

  // Forward unified scene to the ACTIVE backend (now that backend is set)
  if (typeof setScene === 'function') setScene(state.scene);

  // --- Cell metrics & pixel aspect for the tracer ---
  measureCharSize();
  // Make camera rays match the non-square ASCII cell aspect (w/h)
  config.PATH_TRACER.PIXEL_ASPECT = state.charWidth / state.charHeight;

  // --- CPU side buffers for ASCII compositing ---
  const n = state.cols * state.rows;
  state.dataBuffer_chars  = new Uint32Array(n);
  state.dataBuffer_colors = new Uint32Array(n);

  // Dirty-tracking caches
  state._lastChars  = new Uint32Array(n);
  state._lastColors = new Uint32Array(n);
  state._dirty = [];

  // --- CSS color classes (reduced palette + containment) ---
  createStaticStylesheet(state);

  // --- Virtual scroller sizing ---
  state.scrollerEl.style.width  = `${state.cols * state.charWidth}px`;
  state.scrollerEl.style.height = `${state.rows * state.charHeight}px`;

  const buffer = 2;
  state.visibleCols = Math.ceil(state.viewportEl.clientWidth  / state.charWidth)  + buffer;
  state.visibleRows = Math.ceil(state.viewportEl.clientHeight / state.charHeight) + buffer;

  state.windowEl.style.gridTemplateColumns = `repeat(${state.visibleCols}, ${state.charWidth}px)`;
  state.windowEl.style.gridTemplateRows    = `repeat(${state.visibleRows}, ${state.charHeight}px)`;

  // --- Create visible DOM cells (pooled) ---
  state.nodePool.length = 0;
  for (let i = 0; i < state.visibleCols * state.visibleRows; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    state.windowEl.appendChild(cell);
    state.nodePool.push(cell);
  }

  // --- Double-buffered CPU targets (one-frame latency with GPU) ---
  const byteCount = n * 4; // RGBA
  state.fbA = new Uint8ClampedArray(byteCount);
  state.fbB = new Uint8ClampedArray(byteCount);
  state.displayBuffer = state.fbA; // last finished frame (CPU)
  state.workBuffer    = state.fbB; // where GPU writes next result (CPU)
  state.framebuffer   = state.displayBuffer; // compatibility pointer

  // --- UI buffer (ASCII overlay) ---
  state.uiBuffer = createBuffer(state.cols, state.rows, null);

  // --- Input & events ---
  attachInput();
  window.addEventListener('resize', () => window.location.reload());
  state.viewportEl.addEventListener('scroll', handleScroll, { passive: true });
  state.windowEl.addEventListener('click', handleClick);

  // Initial layout & timebase
  handleScroll();
  state.lastUpdateTime = performance.now();
  state.time = state.lastUpdateTime;

  // --- Kick the first GPU job; we'll display it next rAF ---
  kickGPU(performance.now() * 0.001);

  // --- Start the pipelined loop (DOM draws frame N while GPU renders N+1) ---
  animationLoop();
}

// ---------------- UI / DOM ----------------
function createStaticStylesheet() {
  const numColorBands = config.ASCII_RAMP.length;
  if (numColorBands === 0) return;

  const styleEl = document.createElement('style');
  let styleContent = '';
  let classCounter = 0;

  for (let rStep = 0; rStep < numColorBands; rStep++) {
    const r = (numColorBands === 1) ? 255 : Math.round((rStep / (numColorBands - 1)) * 255);
    for (let gStep = 0; gStep < numColorBands; gStep++) {
      const g = (numColorBands === 1) ? 255 : Math.round((gStep / (numColorBands - 1)) * 255);
      for (let bStep = 0; bStep < numColorBands; bStep++) {
        const b = (numColorBands === 1) ? 255 : Math.round((bStep / (numColorBands - 1)) * 255);
        const packedColor = packColor(r, g, b);
        const className = `c${classCounter++}`;
        styleContent += `.${className}{color:rgb(${r},${g},${b});}`;
        state.colorClassMap.set(packedColor, className);
      }
    }
  }

  const blackPacked = packColor(0, 0, 0);
  if (!state.colorClassMap.has(blackPacked)) {
    const className = `c${classCounter++}`;
    styleContent += `.${className}{color:#000;}`;
    state.colorClassMap.set(blackPacked, className);
  }

  styleEl.textContent = styleContent;
  document.head.appendChild(styleEl);
}

function measureCharSize() {
  const measureEl = document.getElementById('measure');
  const rect = measureEl.getBoundingClientRect();
  state.charWidth = rect.width;
  state.charHeight = rect.height;
}

function handleClick(e) {
  // preserve your ripple UI on left click
  if (e.button !== 0) return;
  const virtualX = state.gridOffsetX + Math.floor(e.offsetX / state.charWidth);
  const virtualY = state.gridOffsetY + Math.floor(e.offsetY / state.charHeight);
  if (virtualY < state.rows && virtualX < state.cols) {
    state.uiEffects.push({ type: 'ripple', center: { x: virtualX, y: virtualY }, startTime: performance.now() });
  }
}

function handleScroll() {
  state.isScrolling = true;
  clearTimeout(state.scrollTimeout);
  state.scrollTimeout = setTimeout(() => { state.isScrolling = false; }, 150);

  const newGridOffsetX = Math.floor(state.viewportEl.scrollLeft / state.charWidth);
  const newGridOffsetY = Math.floor(state.viewportEl.scrollTop  / state.charHeight);

  if (newGridOffsetX !== state.gridOffsetX || newGridOffsetY !== state.gridOffsetY) {
    state.gridOffsetX = newGridOffsetX;
    state.gridOffsetY = newGridOffsetY;
    state.windowEl.style.transform = `translate(${newGridOffsetX * state.charWidth}px, ${newGridOffsetY * state.charHeight}px)`;
    updateDOM(true); // full redraw on scroll (kept for correctness)
  }
}

// Full redraw (kept exactly as before for non-regression on force cases)
function updateDOM(forceRedraw = false) {
  for (let y = 0; y < state.visibleRows; y++) {
    for (let x = 0; x < state.visibleCols; x++) {
      const nodeIndex = y * state.visibleCols + x;
      const node = state.nodePool[nodeIndex];
      const virtualX = x + state.gridOffsetX;
      const virtualY = y + state.gridOffsetY;

      if (virtualX >= state.cols || virtualY >= state.rows) {
        if (node.textContent !== '') node.textContent = '';
        continue;
      }

      const dataIndex  = virtualY * state.cols + virtualX;
      const charCode   = state.dataBuffer_chars[dataIndex];
      const packedColor= state.dataBuffer_colors[dataIndex];

      if (forceRedraw || node._lastCharCode !== charCode) {
        node.textContent = String.fromCharCode(charCode);
        node._lastCharCode = charCode;
      }

      const colorClass = state.colorClassMap.get(packedColor);
      if (forceRedraw || node._lastColorClass !== colorClass) {
        node.className = 'cell ' + colorClass;
        node._lastColorClass = colorClass;
      }
    }
  }
}

// --- NEW: Dirty update version (only touches changed & visible cells)
function updateDOMDirty() {
  const dirty = state._dirty;
  if (!dirty || dirty.length === 0) return;

  const { visibleCols, visibleRows, gridOffsetX, gridOffsetY, cols } = state;

  for (let k = 0; k < dirty.length; k++) {
    const i = dirty[k];

    const vx = i % cols;
    const vy = (i / cols) | 0;

    // Only update if it's on screen
    const rx = vx - gridOffsetX;
    const ry = vy - gridOffsetY;
    if (rx < 0 || ry < 0 || rx >= visibleCols || ry >= visibleRows) continue;

    const nodeIndex = ry * visibleCols + rx;
    const node = state.nodePool[nodeIndex];

    const ch = state.dataBuffer_chars[i];
    const packed = state.dataBuffer_colors[i];

    if (node._lastCharCode !== ch) {
      // Use a persistent text node to avoid re-parsing HTML
      if (!node._text) node._text = node.firstChild || node.appendChild(document.createTextNode(''));
      node._text.data = String.fromCharCode(ch);
      node._lastCharCode = ch;
    }

    const cls = state.colorClassMap.get(packed);
    if (node._lastColorClass !== cls) {
      node.className = 'cell ' + cls;
      node._lastColorClass = cls;
    }
  }

  // clear for next frame
  dirty.length = 0;
}

// ---------------- GPU kick (one-frame-ahead) ----------------
function kickGPU(timeSec) {
  if (state.gpuInFlight) return;
  state.gpuInFlight = true;

  // Yield to let the browser paint, then start the next GPU job.
  const defer = window.requestIdleCallback || ((fn) => setTimeout(fn, 0));
  defer(() => {
    // GPU path trace into the *work* CPU buffer (one-frame ahead)
    renderScene(timeSec, state.workBuffer, state);

    // Mark complete; we will publish in the next rAF
    state.frameReady = true;
    state.gpuInFlight = false;

    // Rotate buffers so we never overwrite the one we just finished
    state.workBuffer = (state.workBuffer === state.fbA) ? state.fbB : state.fbA;
  });
}

// ---------------- main loop (pipelined) ----------------
function animationLoop(currentTime) {
  state.animationId = requestAnimationFrame(animationLoop);

  const elapsed = currentTime - state.lastUpdateTime;
  const frameInterval = 1000 / config.TARGET_FPS;
  if (elapsed < frameInterval) return;

  state.lastUpdateTime = currentTime;
  state.time = currentTime;
  const deltaTime = elapsed / 1000;
  const fps = 1 / Math.max(deltaTime, 1e-6);

  // 1) Update camera from input (WASD + arrows + mouse look)
  updateCamera(deltaTime);

  // 2) If the GPU finished last frame, publish it now (display frame N)
  if (state.frameReady) {
    state.frameReady = false;

    // The buffer that was just filled is the opposite of workBuffer
    state.displayBuffer = (state.workBuffer === state.fbA) ? state.fbB : state.fbA;

    // Preview canvas
    if (state.debug && state.previewCtx) {
        state.previewImageData.data.set(state.displayBuffer);
        state.previewCtx.putImageData(state.previewImageData, 0, 0);
    }      

    // Compatibility pointer for downstream pipeline
    state.framebuffer = state.displayBuffer;

    // UI overlay + ASCII composite
    renderUI(Math.round(fps), state);
    compositeAndQuantize(state); // <- fills state.dataBuffer_* AND pushes state._dirty indices (see note below)

    // Cull finished UI effects
    state.uiEffects = state.uiEffects.filter(effect => {
      const age = currentTime - effect.startTime;
      const radius = age * config.RIPPLE_SPEED;
      return radius < config.MAX_RIPPLE_RADIUS;
    });

    // Dirty-only DOM update unless we're scrolling
    if (!state.isScrolling) {
      updateDOMDirty();
    } else {
      // during active scroll we rely on the forced redraw in handleScroll()
    }
  }

  // 3) Queue the next GPU render (produce frame N+1)
  kickGPU(currentTime * 0.001);
}

document.addEventListener('DOMContentLoaded', init);
