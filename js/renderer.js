// renderer.js
// Provides: renderUI(...) and compositeAndQuantize(...)

import { config } from './config.js';
import { createBuffer } from './utils.js';

function packColor(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

// Compute the number of color steps per channel used for CSS classes.
// Stored on state so quantization matches the stylesheet exactly.
function computeStepsPerChannel(state) {
  if (state._stepsPerChannel) return state._stepsPerChannel;
  const rampLen = Math.max(2, config.ASCII_RAMP.length);
  const steps = Math.max(3, rampLen );
  state._stepsPerChannel = steps;
  return steps;
}

export function compositeAndQuantize(state) {
  const { cols, rows, framebuffer, uiBuffer, dataBuffer_chars, dataBuffer_colors } = state;

  const ramp = config.ASCII_RAMP;
  const rampLen = ramp.length;

  // Steps per channel must match stylesheet
  const stepsPerChannel = computeStepsPerChannel(state);
  const stepVal = 255 / (stepsPerChannel - 1);
  const qChan = (u8) => Math.round(Math.round((u8 / 255) * (stepsPerChannel - 1)) * stepVal);

  for (let y = 0; y < rows; y++) {
    const row = uiBuffer[y];
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const p = i * 4;

      // UI overlay wins (drawn in black)
      const uiChar = row[x];
      if (uiChar !== null) {
        const ch = uiChar.charCodeAt(0);
        const packed = packColor(0, 0, 0);
        dataBuffer_chars[i]  = ch;
        dataBuffer_colors[i] = packed;

        // NEW: also mirror the chosen char into the framebuffer alpha (ASCII code)
        if (framebuffer) framebuffer[p + 3] = ch & 0xFF;

        if (state._dirty && state._lastChars && state._lastColors) {
          if (state._lastChars[i] !== ch || state._lastColors[i] !== packed) {
            state._lastChars[i]  = ch;
            state._lastColors[i] = packed;
            state._dirty.push(i);
          }
        }
        continue;
      }

      const r = framebuffer[p + 0];
      const g = framebuffer[p + 1];
      const b = framebuffer[p + 2];

      // NEW: mark this cell as "no override"
if (framebuffer) framebuffer[p + 3] = 1;

      // SIMPLE intensity: average of sRGB bytes (0..255)
      const intensity = (r + g + b) / 3;

      // Linear mapping to ASCII ramp
      const idx = Math.min(rampLen - 1, Math.max(0, Math.round((intensity / 255) * (rampLen - 1))));
      const ch = ramp.charCodeAt(idx);
      dataBuffer_chars[i] = ch;

      // Color quantization to match stylesheet classes
      let rq, gq, bq;
      if (config.USE_GRAYSCALE) {
        rq = gq = bq = 0; // black text
      } else {
        rq = qChan(r);
        gq = qChan(g);
        bq = qChan(b);
      }
      const packed = packColor(rq, gq, bq);
      dataBuffer_colors[i] = packed;

      // Note: we do NOT overwrite framebuffer alpha here for normal (quantized) cells.
      // Alpha==0/1 means "use luminance ramp" in the GPU path. Any UI char sets alpha>1.

      // Optional dirty tracking (only if state set these arrays)
      if (state._dirty && state._lastChars && state._lastColors) {
        if (state._lastChars[i] !== ch || state._lastColors[i] !== packed) {
          state._lastChars[i]  = ch;
          state._lastColors[i] = packed;
          state._dirty.push(i);
        }
      }
    }
  }
}

function setPointOnBuffer(buffer, x, y, char, state) {
  const { cols, rows } = state;
  if (x >= 0 && x < cols && y >= 0 && y < rows) {
    buffer[y][x] = char;
  }
}

function drawCircleOnBuffer(buffer, cx, cy, r, char, state) {
  cx = Math.round(cx); cy = Math.round(cy); r = Math.round(r);
  let x = r, y = 0, err = 0;
  while (x >= y) {
    setPointOnBuffer(buffer, cx + x, cy + y, char, state);
    setPointOnBuffer(buffer, cx + y, cy + x, char, state);
    setPointOnBuffer(buffer, cx - y, cy + x, char, state);
    setPointOnBuffer(buffer, cx - x, cy + y, char, state);
    setPointOnBuffer(buffer, cx - x, cy - y, char, state);
    setPointOnBuffer(buffer, cx - y, cy - x, char, state);
    setPointOnBuffer(buffer, cx + y, cy - x, char, state);
    setPointOnBuffer(buffer, cx + x, cy - y, char, state);
    if (err <= 0) { y++; err += 2*y+1; }
    if (err > 0)  { x--; err -= 2*x+1; }
  }
}

export function renderUI(fps, state) {
  const { cols, rows, uiEffects, time } = state;
  state.uiBuffer = createBuffer(cols, rows, null);

  // Border with PI digits
  for (let x = 0; x < cols; x++) {
    setPointOnBuffer(state.uiBuffer, x, 0, config.PI_DIGITS[x % config.PI_DIGITS.length], state);
    setPointOnBuffer(state.uiBuffer, x, rows - 1, config.PI_DIGITS[x % config.PI_DIGITS.length], state);
  }
  for (let y = 0; y < rows; y++) {
    setPointOnBuffer(state.uiBuffer, 0, y, config.PI_DIGITS[y % config.PI_DIGITS.length], state);
    setPointOnBuffer(state.uiBuffer, cols - 1, y, config.PI_DIGITS[y % config.PI_DIGITS.length], state);
  }

  // FPS (bottom-right)
  const s = String(fps);
  const startX = cols - s.length - 1;
  const startY = rows - 1;
  for (let i = 0; i < s.length; i++) {
    if (startX + i < cols && startY >= 0) {
      state.uiBuffer[startY][startX + i] = s[i];
    }
  }

  // Click ripples
  if (uiEffects) {
    for (const effect of uiEffects) {
      if (effect.type === 'ripple') {
        const age = time - effect.startTime;
        const radius = age * config.RIPPLE_SPEED;
        drawCircleOnBuffer(state.uiBuffer, effect.center.x, effect.center.y, radius, '*', state);
      }
    }
  }
}

/* ----------------- Stylesheet: fewer classes + containment ----------------- */
export function createStaticStylesheet(state) {
  const stepsPerChannel = computeStepsPerChannel(state);
  const styleEl = document.createElement('style');
  let styleContent = `
#grid-window{will-change:transform;contain:layout paint style;}
.cell{contain:content;display:block;line-height:1;white-space:pre;}
`;

  let classCounter = 0;
  state.colorClassMap.clear();

  for (let rStep = 0; rStep < stepsPerChannel; rStep++) {
    const r = Math.round((rStep / (stepsPerChannel - 1)) * 255);
    for (let gStep = 0; gStep < stepsPerChannel; gStep++) {
      const g = Math.round((gStep / (stepsPerChannel - 1)) * 255);
      for (let bStep = 0; bStep < stepsPerChannel; bStep++) {
        const b = Math.round((bStep / (stepsPerChannel - 1)) * 255);
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
