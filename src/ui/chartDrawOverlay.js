// Session-only annotations on `#chartDrawOverlay` (freehand paths + text).
// Drawing mode steals pointer events from `#priceChart`; disable annotations to pan/zoom/hover the chart.
import { resizeCanvas } from '../util/dom.js';
import { handlePriceChartWheelZoom } from './pan.js';

const DRAW_FONT = '600 11px "IBM Plex Mono", Menlo, Consolas, monospace';
const PEN_WIDTH = 2;
const HIT_DIST_PATH = 10;
const HIT_PAD_TEXT = 6;
const MIN_PEN_POINTS = 2;
const MIN_SEGMENT_SKIP_SQ = 1;

/** @type {{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string }} */

let overlayCanvas = null;
let overlayCtx = null;
let priceWrap = null;

let interactActive = false;
let tool = 'select'; // 'select' | 'pen' | 'text'

/** @type {Array<{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string }>} */
let objects = [];

let selectedId = null;

/** @type {{ points: { x: number, y: number }[], preview?: { x: number, y: number } } | null} */
let draftPen = null;

/** @type {{ id: string, lastX: number, lastY: number, pointerId: number } | null} */
let dragMove = null;

function _nid() {
  return `ann_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function _colorInputValue() {
  const el = document.getElementById('chartDrawColor');
  return el && /^#[0-9a-fA-F]{6}$/.test(el.value) ? el.value : '#26a69a';
}

function _syncDeleteBtn() {
  const btn = document.getElementById('chartDrawDeleteBtn');
  if (btn) btn.disabled = !selectedId;
}

function _syncToolButtons() {
  document.querySelectorAll('.chart-draw-tool[data-draw-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.drawTool === tool);
  });
}

function _updateOverlayCursor() {
  if (!overlayCanvas) return;
  if (!interactActive) {
    overlayCanvas.style.cursor = '';
    return;
  }
  overlayCanvas.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'text' ? 'text' : 'default';
}

function _localXY(e) {
  const r = overlayCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function _distPointSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

function _pathDist(px, py, points) {
  let d = Infinity;
  for (let i = 1; i < points.length; i++) {
    d = Math.min(
      d,
      _distPointSeg(px, py, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y),
    );
  }
  return d;
}

function _pathBBox(points) {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of points) {
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  return { minx, miny, maxx, maxy };
}

function _textBBox(ctx, o) {
  ctx.font = DRAW_FONT;
  const m = ctx.measureText(o.text);
  const w = Math.max(m.width, 8);
  const ascent = m.actualBoundingBoxAscent ?? 10;
  const descent = m.actualBoundingBoxDescent ?? 3;
  const pad = HIT_PAD_TEXT;
  return {
    minx: o.x - pad,
    miny: o.y - ascent - pad,
    maxx: o.x + w + pad,
    maxy: o.y + descent + pad,
  };
}

function _pointInBBox(px, py, bb) {
  return px >= bb.minx && px <= bb.maxx && py >= bb.miny && py <= bb.maxy;
}

function _hitTest(px, py) {
  if (!overlayCtx) return null;
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type === 'path') {
      const bb = _pathBBox(o.points);
      const pad = HIT_DIST_PATH;
      if (
        px >= bb.minx - pad &&
        px <= bb.maxx + pad &&
        py >= bb.miny - pad &&
        py <= bb.maxy + pad &&
        _pathDist(px, py, o.points) <= HIT_DIST_PATH
      ) {
        return o.id;
      }
    } else if (o.type === 'text') {
      const bb = _textBBox(overlayCtx, o);
      if (_pointInBBox(px, py, bb)) return o.id;
    }
  }
  return null;
}

function _drawSelection(ctx, o) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  if (o.type === 'path') {
    const bb = _pathBBox(o.points);
    ctx.strokeRect(bb.minx - 4, bb.miny - 4, bb.maxx - bb.minx + 8, bb.maxy - bb.miny + 8);
  } else if (o.type === 'text') {
    const bb = _textBBox(ctx, o);
    ctx.strokeRect(bb.minx, bb.miny, bb.maxx - bb.minx, bb.maxy - bb.miny);
  }
  ctx.restore();
}

export function redrawChartDrawOverlay() {
  overlayCanvas = document.getElementById('chartDrawOverlay');
  priceWrap = document.getElementById('priceChartWrap');
  if (!overlayCanvas || !priceWrap) return;

  const { w, h } = resizeCanvas(overlayCanvas);
  overlayCtx = overlayCanvas.getContext('2d');
  overlayCtx.clearRect(0, 0, w, h);

  for (const o of objects) {
    overlayCtx.save();
    overlayCtx.strokeStyle = o.color;
    overlayCtx.fillStyle = o.color;
    if (o.type === 'path') {
      overlayCtx.lineWidth = PEN_WIDTH;
      overlayCtx.lineJoin = overlayCtx.lineCap = 'round';
      overlayCtx.beginPath();
      for (let i = 0; i < o.points.length; i++) {
        const p = o.points[i];
        if (i === 0) overlayCtx.moveTo(p.x, p.y);
        else overlayCtx.lineTo(p.x, p.y);
      }
      overlayCtx.stroke();
    } else if (o.type === 'text') {
      overlayCtx.font = DRAW_FONT;
      overlayCtx.textBaseline = 'alphabetic';
      overlayCtx.fillText(o.text, o.x, o.y);
    }
    overlayCtx.restore();
  }

  if (draftPen && draftPen.points.length) {
    overlayCtx.save();
    overlayCtx.strokeStyle = _colorInputValue();
    overlayCtx.lineWidth = PEN_WIDTH;
    overlayCtx.lineJoin = overlayCtx.lineCap = 'round';
    overlayCtx.beginPath();
    draftPen.points.forEach((p, i) => {
      if (i === 0) overlayCtx.moveTo(p.x, p.y);
      else overlayCtx.lineTo(p.x, p.y);
    });
    if (draftPen.preview) overlayCtx.lineTo(draftPen.preview.x, draftPen.preview.y);
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  if (selectedId) {
    const o = objects.find(x => x.id === selectedId);
    if (o) _drawSelection(overlayCtx, o);
  }
}

function _maybeAppendPenPoint(pt) {
  if (!draftPen || draftPen.points.length === 0) {
    draftPen.points.push(pt);
    return;
  }
  const last = draftPen.points[draftPen.points.length - 1];
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  if (dx * dx + dy * dy >= MIN_SEGMENT_SKIP_SQ) draftPen.points.push(pt);
}

function _finalizeDraftPen() {
  const col = _colorInputValue();
  if (!draftPen || draftPen.points.length < MIN_PEN_POINTS) {
    draftPen = null;
    redrawChartDrawOverlay();
    return;
  }
  objects.push({
    id: _nid(),
    type: 'path',
    color: col,
    points: draftPen.points.map(p => ({ ...p })),
  });
  draftPen = null;
  selectedId = null;
  _syncDeleteBtn();
  redrawChartDrawOverlay();
}

function _setInteract(on) {
  interactActive = on;
  if (priceWrap) priceWrap.classList.toggle('chart-wrap-annotations-active', on);
  const tb = document.getElementById('chartDrawToolbar');
  const toggle = document.getElementById('chartDrawToggleBtn');
  if (tb) tb.hidden = !on;
  if (toggle) toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  draftPen = null;
  dragMove = null;
  if (!on) selectedId = null;
  _syncDeleteBtn();
  _updateOverlayCursor();
  redrawChartDrawOverlay();
}

export function bindChartDrawUI() {
  overlayCanvas = document.getElementById('chartDrawOverlay');
  priceWrap = document.getElementById('priceChartWrap');
  const toggle = document.getElementById('chartDrawToggleBtn');
  const toolbar = document.getElementById('chartDrawToolbar');
  const colorEl = document.getElementById('chartDrawColor');
  const deleteBtn = document.getElementById('chartDrawDeleteBtn');

  if (!overlayCanvas || !priceWrap || !toggle || !toolbar) return;

  toggle.addEventListener('click', () => {
    _setInteract(!interactActive);
  });

  toolbar.addEventListener('click', e => {
    const btn = e.target.closest('[data-draw-tool]');
    if (!btn) return;
    tool = btn.dataset.drawTool || 'select';
    draftPen = null;
    _syncToolButtons();
    _updateOverlayCursor();
    redrawChartDrawOverlay();
  });

  if (colorEl) {
    colorEl.addEventListener('input', () => {
      const sel = objects.find(o => o.id === selectedId);
      if (sel) {
        sel.color = colorEl.value;
        redrawChartDrawOverlay();
      }
    });
  }

  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      if (!selectedId) return;
      objects = objects.filter(o => o.id !== selectedId);
      selectedId = null;
      _syncDeleteBtn();
      redrawChartDrawOverlay();
    });
  }

  overlayCanvas.addEventListener('wheel', e => {
    if (handlePriceChartWheelZoom(e)) redrawChartDrawOverlay();
  }, { passive: false });

  overlayCanvas.addEventListener('pointerdown', e => {
    if (!interactActive || e.button !== 0) return;
    const { x, y } = _localXY(e);

    if (tool === 'pen') {
      draftPen = { points: [{ x, y }] };
      overlayCanvas.setPointerCapture(e.pointerId);
      redrawChartDrawOverlay();
      return;
    }

    if (tool === 'text') {
      const raw = window.prompt('Annotation text:', '');
      if (raw != null && String(raw).trim()) {
        objects.push({
          id: _nid(),
          type: 'text',
          color: _colorInputValue(),
          x,
          y,
          text: String(raw).trim(),
        });
        selectedId = objects[objects.length - 1].id;
        _syncDeleteBtn();
      }
      redrawChartDrawOverlay();
      return;
    }

    // select
    const hit = _hitTest(x, y);
    selectedId = hit;
    _syncDeleteBtn();
    if (hit && colorEl) {
      const o = objects.find(z => z.id === hit);
      if (o) colorEl.value = o.color;
    }
    if (hit) {
      dragMove = { id: hit, lastX: x, lastY: y, pointerId: e.pointerId };
      overlayCanvas.setPointerCapture(e.pointerId);
    }
    redrawChartDrawOverlay();
  });

  overlayCanvas.addEventListener('pointermove', e => {
    if (!interactActive) return;
    const { x, y } = _localXY(e);

    if (tool === 'pen' && draftPen && overlayCanvas.hasPointerCapture(e.pointerId)) {
      _maybeAppendPenPoint({ x, y });
      draftPen.preview = { x, y };
      redrawChartDrawOverlay();
      return;
    }

    if (dragMove && dragMove.pointerId === e.pointerId && overlayCanvas.hasPointerCapture(e.pointerId)) {
      const dx = x - dragMove.lastX;
      const dy = y - dragMove.lastY;
      dragMove.lastX = x;
      dragMove.lastY = y;
      const o = objects.find(z => z.id === dragMove.id);
      if (o && (dx !== 0 || dy !== 0)) {
        if (o.type === 'path') {
          for (const p of o.points) {
            p.x += dx;
            p.y += dy;
          }
        } else if (o.type === 'text') {
          o.x += dx;
          o.y += dy;
        }
      }
      redrawChartDrawOverlay();
    }
  });

  overlayCanvas.addEventListener('pointerup', e => {
    if (tool === 'pen' && draftPen && overlayCanvas.hasPointerCapture(e.pointerId)) {
      overlayCanvas.releasePointerCapture(e.pointerId);
      if (draftPen.preview) {
        _maybeAppendPenPoint(draftPen.preview);
        draftPen.preview = undefined;
      }
      _finalizeDraftPen();
      return;
    }
    if (dragMove && dragMove.pointerId === e.pointerId && overlayCanvas.hasPointerCapture(e.pointerId)) {
      overlayCanvas.releasePointerCapture(e.pointerId);
      dragMove = null;
    }
  });

  overlayCanvas.addEventListener('pointercancel', e => {
    if (
      draftPen &&
      typeof overlayCanvas.hasPointerCapture === 'function' &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      try {
        overlayCanvas.releasePointerCapture(e.pointerId);
      } catch (_) { /* noop */ }
      draftPen = null;
      redrawChartDrawOverlay();
    }
    dragMove = null;
  });

  document.addEventListener('keydown', e => {
    if (!interactActive) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      _setInteract(false);
      return;
    }
    if (!selectedId) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.code !== 'Delete' && e.code !== 'Backspace') return;
    e.preventDefault();
    objects = objects.filter(o => o.id !== selectedId);
    selectedId = null;
    _syncDeleteBtn();
    redrawChartDrawOverlay();
  });

  _syncToolButtons();
  redrawChartDrawOverlay();
}
