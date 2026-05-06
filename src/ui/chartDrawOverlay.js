// Session-only annotations on `#chartDrawOverlay` (freehand paths + text + boxes).
// Drawing mode steals pointer events from `#priceChart`; disable annotations to pan/zoom/hover the chart.
import { resizeCanvas } from '../util/dom.js';
import { handlePriceChartWheelZoom } from './pan.js';

const DRAW_FONT = '600 11px "IBM Plex Mono", Menlo, Consolas, monospace';
const PEN_WIDTH = 2;
const HIT_DIST_PATH = 10;
const HIT_PAD_TEXT = 6;
const MIN_PEN_POINTS = 2;
const MIN_SEGMENT_SKIP_SQ = 1;
const MIN_BOX_SIDE = 4;
const BOX_FILL_ALPHA = 0.22;
const HANDLE_HIT = 10;
const HANDLE_DRAW = 4;

/** @type {{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string } | { id: string, type: 'box', color: string, x: number, y: number, w: number, h: number }} */

let overlayCanvas = null;
let overlayCtx = null;
let priceWrap = null;

let interactActive = false;
let tool = 'select'; // 'select' | 'pen' | 'text' | 'box'

/** @type {Array<{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string } | { id: string, type: 'box', color: string, x: number, y: number, w: number, h: number }>} */
let objects = [];

let selectedId = null;

/** @type {{ points: { x: number, y: number }[], preview?: { x: number, y: number } } | null} */
let draftPen = null;

/** @type {{ x0: number, y0: number, pointerId: number, previewX?: number, previewY?: number } | null} */
let draftBox = null;

/** @type {{ id: string, lastX: number, lastY: number, pointerId: number, mode?: 'move' | 'resize', fx?: number, fy?: number } | null} */
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
  overlayCanvas.style.cursor =
    tool === 'pen' || tool === 'box' ? 'crosshair' : tool === 'text' ? 'text' : 'default';
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

function _boxBB(o) {
  return { minx: o.x, miny: o.y, maxx: o.x + o.w, maxy: o.y + o.h };
}

/** @returns {'nw'|'ne'|'sw'|'se'|null} */
function _nearestBoxHandle(px, py, o) {
  /** @type {Array<{ name: 'nw'|'ne'|'sw'|'se', cx: number, cy: number }>} */
  const corners = [
    { name: 'nw', cx: o.x, cy: o.y },
    { name: 'ne', cx: o.x + o.w, cy: o.y },
    { name: 'sw', cx: o.x, cy: o.y + o.h },
    { name: 'se', cx: o.x + o.w, cy: o.y + o.h },
  ];
  let best = null;
  let bestD = HANDLE_HIT + 1;
  for (const c of corners) {
    const d = Math.hypot(px - c.cx, py - c.cy);
    if (d <= HANDLE_HIT && d <= bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return best;
}

/** @returns {{ id: string, handle: 'nw'|'ne'|'sw'|'se' } | null} */
function _hitBoxResizeTop(px, py) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type !== 'box') continue;
    const h = _nearestBoxHandle(px, py, o);
    if (h) return { id: o.id, handle: h };
  }
  return null;
}

function _hexToRgbaFill(hex, alpha) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return `rgba(38,166,154,${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

/** Resize box so `(fx,fy)` stays fixed and the diagonal follows `(mx,my)`. */
function _resizeBoxDiagonal(o, fx, fy, mx, my) {
  const signx = fx <= mx ? 1 : -1;
  const signy = fy <= my ? 1 : -1;
  let w = Math.max(MIN_BOX_SIDE, Math.abs(mx - fx));
  let h = Math.max(MIN_BOX_SIDE, Math.abs(my - fy));
  let x = signx >= 0 ? fx : fx - w;
  let y = signy >= 0 ? fy : fy - h;
  o.x = x;
  o.y = y;
  o.w = w;
  o.h = h;
}

/** @returns {{ fx: number, fy: number }} fixed corner opposite the dragged handle */
function _oppositeCornerForHandle(o, handle) {
  switch (handle) {
    case 'nw':
      return { fx: o.x + o.w, fy: o.y + o.h };
    case 'ne':
      return { fx: o.x, fy: o.y + o.h };
    case 'sw':
      return { fx: o.x + o.w, fy: o.y };
    case 'se':
    default:
      return { fx: o.x, fy: o.y };
  }
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
    } else if (o.type === 'box') {
      const bb = _boxBB(o);
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
  } else if (o.type === 'box') {
    ctx.strokeRect(o.x, o.y, o.w, o.h);
    ctx.setLineDash([]);
    const hs = HANDLE_DRAW;
    const corners = [
      [o.x, o.y],
      [o.x + o.w, o.y],
      [o.x, o.y + o.h],
      [o.x + o.w, o.y + o.h],
    ];
    for (const [cx, cy] of corners) {
      ctx.fillStyle = 'rgba(40,40,48,0.95)';
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }
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
    } else if (o.type === 'box') {
      overlayCtx.fillStyle = _hexToRgbaFill(o.color, BOX_FILL_ALPHA);
      overlayCtx.fillRect(o.x, o.y, o.w, o.h);
      overlayCtx.strokeStyle = o.color;
      overlayCtx.lineWidth = PEN_WIDTH;
      overlayCtx.strokeRect(o.x + 0.5, o.y + 0.5, o.w - 1, o.h - 1);
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

  if (draftBox) {
    const x0 = draftBox.x0;
    const y0 = draftBox.y0;
    const x1 = draftBox.previewX ?? x0;
    const y1 = draftBox.previewY ?? y0;
    const nx = Math.min(x0, x1);
    const ny = Math.min(y0, y1);
    const rw = Math.abs(x1 - x0);
    const rh = Math.abs(y1 - y0);
    const col = _colorInputValue();
    overlayCtx.save();
    overlayCtx.fillStyle = _hexToRgbaFill(col, BOX_FILL_ALPHA * 0.85);
    overlayCtx.strokeStyle = col;
    overlayCtx.lineWidth = PEN_WIDTH;
    overlayCtx.fillRect(nx, ny, rw, rh);
    overlayCtx.strokeRect(nx + 0.5, ny + 0.5, Math.max(0, rw - 1), Math.max(0, rh - 1));
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

function _finalizeDraftBox(x1, y1) {
  const x0 = draftBox?.x0;
  const y0 = draftBox?.y0;
  draftBox = null;
  if (x0 === undefined || y0 === undefined) {
    redrawChartDrawOverlay();
    return;
  }
  const nx = Math.min(x0, x1);
  const ny = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const h = Math.abs(y1 - y0);
  if (w < MIN_BOX_SIDE || h < MIN_BOX_SIDE) {
    redrawChartDrawOverlay();
    return;
  }
  objects.push({
    id: _nid(),
    type: 'box',
    color: _colorInputValue(),
    x: nx,
    y: ny,
    w,
    h,
  });
  selectedId = objects[objects.length - 1].id;
  _syncDeleteBtn();
  redrawChartDrawOverlay();
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
  draftBox = null;
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
    draftBox = null;
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

    if (tool === 'box') {
      draftBox = { x0: x, y0: y, pointerId: e.pointerId };
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

    // select — box corners resize before body hit-testing
    const rs = _hitBoxResizeTop(x, y);
    if (rs) {
      const o = objects.find(z => z.id === rs.id && z.type === 'box');
      if (o) {
        const { fx, fy } = _oppositeCornerForHandle(o, rs.handle);
        selectedId = rs.id;
        _syncDeleteBtn();
        if (colorEl) colorEl.value = o.color;
        dragMove = {
          id: o.id,
          lastX: x,
          lastY: y,
          pointerId: e.pointerId,
          mode: 'resize',
          fx,
          fy,
        };
        overlayCanvas.setPointerCapture(e.pointerId);
        redrawChartDrawOverlay();
        return;
      }
    }

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

    if (
      dragMove?.mode === 'resize' &&
      dragMove.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      const o = objects.find(z => z.id === dragMove.id);
      if (o && o.type === 'box' && dragMove.fx !== undefined && dragMove.fy !== undefined) {
        _resizeBoxDiagonal(o, dragMove.fx, dragMove.fy, x, y);
      }
      redrawChartDrawOverlay();
      return;
    }

    if (
      draftBox &&
      tool === 'box' &&
      draftBox.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      draftBox.previewX = x;
      draftBox.previewY = y;
      redrawChartDrawOverlay();
      return;
    }

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
        } else if (o.type === 'box') {
          o.x += dx;
          o.y += dy;
        }
      }
      redrawChartDrawOverlay();
    }
  });

  overlayCanvas.addEventListener('pointerup', e => {
    if (
      tool === 'box' &&
      draftBox &&
      draftBox.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      overlayCanvas.releasePointerCapture(e.pointerId);
      const xy = _localXY(e);
      _finalizeDraftBox(xy.x, xy.y);
      return;
    }
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
      draftBox &&
      typeof overlayCanvas.hasPointerCapture === 'function' &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      try {
        overlayCanvas.releasePointerCapture(e.pointerId);
      } catch (_) { /* noop */ }
      draftBox = null;
      redrawChartDrawOverlay();
    }
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
