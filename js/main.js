import { config } from './config.js';
import { createBuffer } from './utils.js';
import { keysPressed, updateCamera } from './camera.js';
import { renderScene, renderUI, compositeAndQuantize } from './renderer.js';
import { createScene } from './scene.js';

const state = {
    charWidth: 0, charHeight: 0,
    cols: config.VIRTUAL_GRID_WIDTH,
    rows: config.VIRTUAL_GRID_HEIGHT,
    visibleCols: 0, visibleRows: 0,
    gridOffsetX: 0, gridOffsetY: 0,
    viewportEl: null, scrollerEl: null, windowEl: null,
    framebuffer: null, uiBuffer: null,
    nodePool: [],
    animationId: null, lastUpdateTime: 0,
    time: 0, scene: [], uiEffects: [],
    isScrolling: false, scrollTimeout: null,
    // --- OPTIMIZED STATIC RENDER STATE ---
    dataBuffer_chars: null,
    dataBuffer_colors: null,
    colorClassMap: new Map(),
    // --- PROFILER STATE ---
    profiler: {
        history: { camera: [], scene: [], ui: [], composite: [], dom: [], total: [] },
        avg: { camera: 0, scene: 0, ui: 0, composite: 0, dom: 0, total: 0 },
        frameCount: 0,
        HISTORY_LENGTH: 10,
    }
};

function packColor(r, g, b) {
    return (r << 16) | (g << 8) | b;
}

function init() {
    state.viewportEl = document.getElementById('grid-viewport');
    state.scrollerEl = document.getElementById('grid-scroller');
    state.windowEl = document.getElementById('grid-window');
    state.scene = createScene();
    
    measureCharSize();

    state.dataBuffer_chars = new Uint32Array(state.cols * state.rows);
    state.dataBuffer_colors = new Uint32Array(state.cols * state.rows);
    
    // [OPTIMIZED] Pre-generate a static stylesheet. This is now safe and fast.
    createStaticStylesheet();

    state.scrollerEl.style.width = `${state.cols * state.charWidth}px`;
    state.scrollerEl.style.height = `${state.rows * state.charHeight}px`;

    const buffer = 2;
    state.visibleCols = Math.ceil(state.viewportEl.clientWidth / state.charWidth) + buffer;
    state.visibleRows = Math.ceil(state.viewportEl.clientHeight / state.charHeight) + buffer;
    
    state.windowEl.style.gridTemplateColumns = `repeat(${state.visibleCols}, ${state.charWidth}px)`;
    state.windowEl.style.gridTemplateRows = `repeat(${state.visibleRows}, ${state.charHeight}px)`;

    for (let i = 0; i < state.visibleCols * state.visibleRows; i++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        state.windowEl.appendChild(cell);
        state.nodePool.push(cell);
    }
    
    state.framebuffer = new Uint8ClampedArray(state.cols * state.rows * 4);
    state.uiBuffer = createBuffer(state.cols, state.rows, null);
    
    window.addEventListener('keydown', (e) => keysPressed.add(e.key.toLowerCase()));
    window.addEventListener('keyup', (e) => keysPressed.delete(e.key.toLowerCase()));
    window.addEventListener('resize', () => window.location.reload());
    state.viewportEl.addEventListener('scroll', handleScroll, { passive: true });
    state.windowEl.addEventListener('click', handleClick);
    state.windowEl.addEventListener('contextmenu', (e) => e.preventDefault());

    handleScroll();
    state.lastUpdateTime = performance.now();
    animationLoop();
}

/**
 * [FIXED] Generates a static stylesheet for all possible quantized colors.
 * The number of colors is now correctly based on the ASCII ramp length, preventing the RangeError.
 */
function createStaticStylesheet() {
    const numColorBands = config.ASCII_RAMP.length;
    if (numColorBands === 0) return; // Guard against empty ramp

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
    const newGridOffsetY = Math.floor(state.viewportEl.scrollTop / state.charHeight);

    if (newGridOffsetX !== state.gridOffsetX || newGridOffsetY !== state.gridOffsetY) {
        state.gridOffsetX = newGridOffsetX;
        state.gridOffsetY = newGridOffsetY;
        state.windowEl.style.transform = `translate(${newGridOffsetX * state.charWidth}px, ${newGridOffsetY * state.charHeight}px)`;
        updateDOM(true);
    }
}

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

            const dataIndex = virtualY * state.cols + virtualX;
            const charCode = state.dataBuffer_chars[dataIndex];
            const packedColor = state.dataBuffer_colors[dataIndex];

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

function logTimings(timings, fps) {
    console.clear();
    const profiler = state.profiler;
    for (const key in timings) {
        profiler.history[key].push(timings[key]);
        if (profiler.history[key].length > profiler.HISTORY_LENGTH) profiler.history[key].shift();
        profiler.avg[key] = profiler.history[key].reduce((a, b) => a + b, 0) / profiler.history[key].length;
    }
    console.log(
        `--- Frame #${profiler.frameCount++} | ${fps.toFixed(1)} FPS ---\n` +
        `Camera Update:\t ${profiler.avg.camera.toFixed(2)}ms\n` +
        `Scene Render:\t ${profiler.avg.scene.toFixed(2)}ms\n` +
        `UI Render:\t\t ${profiler.avg.ui.toFixed(2)}ms\n` +
        `Composite:\t\t ${profiler.avg.composite.toFixed(2)}ms\n` +
        `DOM Update:\t\t ${profiler.avg.dom.toFixed(2)}ms\n` +
        `---------------------------\n` +
        `Total JS Time:\t ${profiler.avg.total.toFixed(2)}ms`
    );
}

function animationLoop(currentTime) {
    state.animationId = requestAnimationFrame(animationLoop);
    const elapsed = currentTime - state.lastUpdateTime;
    const frameInterval = 1000 / config.TARGET_FPS;
    if (elapsed < frameInterval) return;

    const t0 = performance.now();
    state.lastUpdateTime = currentTime;
    state.time = currentTime;
    const deltaTime = elapsed / 1000.0;
    const fps = 1 / deltaTime;

    updateCamera(deltaTime);
    const t1 = performance.now();

    renderScene(currentTime * 0.001, state.framebuffer, state);
    const t2 = performance.now();

    renderUI(Math.round(fps), state);
    const t3 = performance.now();
    
    compositeAndQuantize(state);
    const t4 = performance.now();

    state.uiEffects = state.uiEffects.filter(effect => {
        const age = currentTime - effect.startTime;
        const radius = age * config.RIPPLE_SPEED;
        return radius < config.MAX_RIPPLE_RADIUS;
    });

    if (!state.isScrolling) {
        updateDOM();
    }
    const t5 = performance.now();

    logTimings({
        camera: t1 - t0, scene: t2 - t1, ui: t3 - t2,
        composite: t4 - t3, dom: t5 - t4, total: t5 - t0
    }, fps);
}

document.addEventListener('DOMContentLoaded', init);