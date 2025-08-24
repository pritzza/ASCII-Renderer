// js/text_overlay.js
// Invisible, selectable ASCII text overlay ABOVE the canvas.
// RMB rules implemented here:
// - Right-click highlighted text: allow DOM context menu (no pointer lock)
// - Right-click non-highlighted text: enter pointer lock
// - While locked, any right-click: exit pointer lock
// Passes info.onSelection to callbacks.

export class TextOverlay {
  constructor(opts = {}) {
    this.mountEl = opts.mountEl;                 // required: container (e.g., #grid-viewport)
    this.canvasEl = opts.canvasEl;               // required: the WebGL canvas to mirror/cover
    this.pointerLockEl = opts.pointerLockEl || this.mountEl; // where to request pointer lock
    this.getGrid = opts.getGrid;                 // required: () => { cols, rows, charWidth, charHeight }
    this.getDisplayBuffer = opts.getDisplayBuffer; // required: () => Uint8ClampedArray
    this.ramp = String(opts.ramp ?? '@%#*+=-:. ');

    // Callbacks into game/app
    this.onMouseDown = opts.onMouseDown || null;       // (info, event)
    this.onClick = opts.onClick || null;               // (info, event)
    this.onContextMenu = opts.onContextMenu || null;   // (info, event)

    // Behavior
    this.frozen = opts.frozen !== undefined ? !!opts.frozen : true;

    // DOM
    this.el = null;            // root overlay element
    this.rowsEls = [];         // div.row nodes
    this.cols = 0; this.rows = 0;
    this.charWidth = 0; this.charHeight = 0;

    // State
    this.primed = false;
    this.clicks = [];
    this._suppressNextContextMenu = false;
  }

  /* ----------------------- internal helpers ----------------------- */

  _ensureStyles() {
    if (document.getElementById('ascii-text-layer-style')) return;
    const style = document.createElement('style');
    style.id = 'ascii-text-layer-style';
    style.textContent = `
#ascii-text-layer{
  position:absolute;
  top:0; left:0;
  white-space:pre;
  background:transparent;
  color:transparent;          /* invisible text; still selectable/copyable */
  caret-color:transparent;
  user-select:text;
  pointer-events:auto;        /* overlay gets events FIRST */
  z-index:3;                  /* ABOVE the canvas */
  contain:content;
  will-change:transform;
}
#ascii-text-layer .row{
  contain:content;
  width:100%;
  height:1em; /* set precisely by JS */
}
`;
    document.head.appendChild(style);
  }

  _readMeasureFont() {
    const m = document.getElementById('measure');
    const cs = m ? getComputedStyle(m) : null;
    return {
      family: (cs && cs.fontFamily) || 'monospace',
      size:   (cs && cs.fontSize)   || '16px',
      weight: (cs && cs.fontWeight) || '400',
      style:  (cs && cs.fontStyle)  || 'normal',
      lineHeight: (cs && cs.lineHeight) || '1',
    };
  }

  _snapToDevicePixelsNoFlip(el) {
    const dpr = window.devicePixelRatio || 1;
    const r = el.getBoundingClientRect();
    const fx = (r.left * dpr) - Math.round(r.left * dpr);
    const fy = (r.top  * dpr) - Math.round(r.top  * dpr);
    const tx = -fx / dpr;
    const ty = -fy / dpr;
    el.style.transform = `translate(${tx}px, ${ty}px)`;
  }

  _eventToVirtualXY(e) {
    const rect = this.canvasEl.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const x = Math.floor(px / this.charWidth);
    const y = Math.floor(py / this.charHeight);
    return { x, y, inBounds: (x >= 0 && x < this.cols && y >= 0 && y < this.rows) };
  }

  _isLocked() {
    return document.pointerLockElement === this.pointerLockEl;
  }

  _toggleLock(on) {
    if (typeof on === 'boolean') {
      if (on && !this._isLocked()) this.pointerLockEl?.requestPointerLock?.();
      if (!on && this._isLocked()) document.exitPointerLock?.();
      return;
    }
    if (this._isLocked()) document.exitPointerLock?.();
    else this.pointerLockEl?.requestPointerLock?.();
  }

  _pointInSelection(clientX, clientY) {
    const sel = window.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const rects = range.getClientRects?.();
      for (const rect of rects) {
        if (clientX >= rect.left && clientX <= rect.right &&
            clientY >= rect.top  && clientY <= rect.bottom) {
          return true;
        }
      }
    }
    return false;
  }

  _computeRowString(y) {
    const db = this.getDisplayBuffer?.();
    if (!db) return '';
    const ramp = this.ramp;
    const rampLen = ramp.length;
    const start = y * this.cols * 4;
    let out = '';
    for (let x = 0; x < this.cols; x++) {
      const p = start + x * 4;
      const a = db[p + 3] | 0;
      if (a >= 2 && a <= 254) {
        out += String.fromCharCode(a);
      } else {
        const r = db[p], g = db[p + 1], b = db[p + 2];
        const intensity = (r + g + b) / 3;
        const idx = Math.min(rampLen - 1, Math.max(0, Math.round((intensity / 255) * (rampLen - 1))));
        out += ramp[idx];
      }
    }
    return out;
  }

  /* ---------------------------- lifecycle ---------------------------- */

  init() {
    if (!this.mountEl || !this.canvasEl || !this.getGrid || !this.getDisplayBuffer) {
      throw new Error('[TextOverlay] Missing required opts: mountEl, canvasEl, getGrid, getDisplayBuffer');
    }
    this._ensureStyles();

    // Create root
    const el = document.createElement('div');
    el.id = 'ascii-text-layer';
    const font = this._readMeasureFont();
    el.style.fontFamily = font.family;
    el.style.fontSize   = font.size;
    el.style.fontWeight = font.weight;
    el.style.fontStyle  = font.style;
    el.style.lineHeight = font.lineHeight;

    // Build rows for current grid
    const { cols, rows, charWidth, charHeight } = this.getGrid();
    this.cols = cols; this.rows = rows;
    this.charWidth = charWidth; this.charHeight = charHeight;

    this.rowsEls = [];
    for (let y = 0; y < this.rows; y++) {
      const r = document.createElement('div');
      r.className = 'row';
      r.textContent = '';
      r.style.height = `${this.charHeight}px`;
      el.appendChild(r);
      this.rowsEls.push(r);
    }

    this.mountEl.appendChild(el);
    this.el = el;
    this.sizeToGrid(); // position, size, snap

    // Events: overlay FIRST, then forward to callbacks (game logic)
    el.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        const onSelection = this._pointInSelection(e.clientX, e.clientY);
        const info = { ...this._eventToVirtualXY(e), onSelection };

        if (this._isLocked()) {
          // In lock: RMB exits lock, no DOM menu
          e.preventDefault();
          e.stopPropagation();
          this._suppressNextContextMenu = true;
          document.exitPointerLock?.();
          if (this.onMouseDown) this.onMouseDown(info, e);
          return;
        }

        if (onSelection) {
          // Allow native context menu; do NOT lock
          // (no preventDefault; let the event bubble)
          if (this.onMouseDown) this.onMouseDown(info, e);
          return;
        }

        // Not locked, not on selection => enter lock and suppress menu
        e.preventDefault();
        e.stopPropagation();
        this._suppressNextContextMenu = true;
        this.pointerLockEl?.requestPointerLock?.();
        if (this.onMouseDown) this.onMouseDown(info, e);
        return;
      }

      // Non-RMB path
      const info = { ...this._eventToVirtualXY(e), onSelection: false };
      if (this.onMouseDown) this.onMouseDown(info, e);
    });

    // Left-click path; use capture so click fires even after selection
    el.addEventListener('click', (e) => {
      const info = { ...this._eventToVirtualXY(e), onSelection: false };
      if (this.onClick) this.onClick(info, e);
    }, true);

    // Context menu: allow only when we didn't intentionally suppress it
    el.addEventListener('contextmenu', (e) => {
      if (this._suppressNextContextMenu) {
        e.preventDefault();
        this._suppressNextContextMenu = false;
      }
      const info = { ...this._eventToVirtualXY(e), onSelection: this._pointInSelection(e.clientX, e.clientY) };
      if (this.onContextMenu) this.onContextMenu(info, e);
    });

    return this;
  }

  sizeToGrid() {
    if (!this.el) return;
    const { cols, rows, charWidth, charHeight } = this.getGrid();
    this.cols = cols; this.rows = rows;
    this.charWidth = charWidth; this.charHeight = charHeight;

    // Width/height in CSS px
    const cssW = this.cols * this.charWidth;
    const cssH = this.rows * this.charHeight;
    this.el.style.width = `${cssW}px`;
    this.el.style.height = `${cssH}px`;

    // Rebuild rows if needed
    if (this.rowsEls.length !== this.rows) {
      this.el.innerHTML = '';
      this.rowsEls.length = 0;
      for (let y = 0; y < this.rows; y++) {
        const r = document.createElement('div');
        r.className = 'row';
        r.textContent = '';
        this.el.appendChild(r);
        this.rowsEls.push(r);
      }
    }
    // Ensure per-row height exactly matches cell height
    for (let y = 0; y < this.rows; y++) {
      const r = this.rowsEls[y];
      r.style.height = `${this.charHeight}px`;
    }

    this._snapToDevicePixelsNoFlip(this.el);
  }

  alignToDevicePixels() {
    if (!this.el) return;
    this._snapToDevicePixelsNoFlip(this.el);
  }

  refreshAllRows() {
    if (!this.el) return;
    for (let y = 0; y < this.rows; y++) {
      this.rowsEls[y].textContent = this._computeRowString(y);
    }
  }

  refreshRow(y) {
    if (!this.el) return;
    if (y < 0 || y >= this.rows) return;
    this.rowsEls[y].textContent = this._computeRowString(y);
  }

  primeOnceStatic() {
    if (this.primed) return;
    this.refreshAllRows();
    this.primed = true;
  }

  setFrozen(on) { this.frozen = !!on; }
}
