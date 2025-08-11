// js/gpu_renderer.js
// Runtime rendering router for multiple WebGL backends.
//
// Stable public API:
//   renderScene(timeSec, framebuffer, appState)
//   renderRaw(args)
//   getPixels(args)
//   disposeGPU()
// Extra controls:
//   setBackend(name)      // 'pathtrace' | 'raster' | 'raytrace' (also: 'pt','r','rt')
//   getBackend()
//   listBackends()
//   registerBackend(name, factory)
//   setScene(scene)

import { PathtraceBackend } from './render/backends/pathtrace.js';
import { RasterBackend    } from './render/backends/raster.js';
import { RaytraceBackend  } from './render/backends/raytrace.js';

// Canonical backends
const _registry = new Map([
  ['pathtrace', () => new PathtraceBackend()],
  ['raster',    () => new RasterBackend()],
  ['raytrace',  () => new RaytraceBackend()],
]);

// Friendly aliases
const _alias = new Map([
  ['pt','pathtrace'], ['path','pathtrace'], ['pathtracer','pathtrace'],
  ['r','raster'], ['rasterizer','raster'],
  ['rt','raytrace'], ['ray','raytrace'],
]);

let _active = null;
let _activeName = null;
let __lastScene = null;

function _canonical(name) {
  const n = String(name || '').toLowerCase();
  if (_registry.has(n)) return n;
  const a = _alias.get(n);
  return _registry.has(a) ? a : null;
}

function _ensureActive() {
  if (_active) return;
  setBackend('pathtrace'); // default
}

/* ----------------------- Runtime backend management ------------------------ */

export function registerBackend(name, factory) {
  if (!name || typeof factory !== 'function') {
    throw new Error('registerBackend(name, factory): invalid args');
  }
  _registry.set(String(name).toLowerCase(), factory);
}

export function listBackends() {
  return Array.from(_registry.keys());
}

export function getBackend() {
  _ensureActive();
  return _activeName;
}

export function setBackend(name) {
  const key = _canonical(name);
  if (!key) throw new Error(`Unknown backend "${name}". Known: ${listBackends().join(', ')}`);
  if (_active?.dispose) {
    try { _active.dispose(); } catch {}
  }
  _active = _registry.get(key)();
  _activeName = key;
  if (__lastScene && _active?.setScene) {
    try { _active.setScene(__lastScene); } catch {}
  }
  return _activeName;
}

/* ------------------------------- Scene pipe -------------------------------- */

export function setScene(scene) {
  __lastScene = scene || null;
  _ensureActive();
  if (_active?.setScene) _active.setScene(__lastScene);
}

/* ------------------------------ Stable facade ------------------------------ */

export function renderScene(timeSec, framebuffer, appState) {
  _ensureActive();
  return _active.render(timeSec, framebuffer, appState);
}

export function renderRaw(args) {
  _ensureActive();
  return _active.renderRaw?.(args);
}

export function getPixels(args) {
  _ensureActive();
  return _active.getPixels?.(args);
}

export function disposeGPU() {
  if (_active?.dispose) _active.dispose();
  _active = null;
  _activeName = null;
}
