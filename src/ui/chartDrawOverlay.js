// Session-only annotations on `#chartDrawOverlay` (freehand paths + text + boxes + long/short zones).
// Drawing mode steals pointer events from `#priceChart`; disable annotations to pan/zoom/hover the chart.
import { resizeCanvas } from '../util/dom.js';
import { handlePriceChartWheelZoom } from './pan.js';

const DRAW_FONT = '600 11px "IBM Plex Mono", Menlo, Consolas, monospace';
const LS_LABEL_FONT = '600 10px "IBM Plex Mono", Menlo, Consolas, monospace';
const PEN_WIDTH = 2;
const HIT_DIST_PATH = 10;
const HIT_PAD_TEXT = 6;
const MIN_PEN_POINTS = 2;
const MIN_SEGMENT_SKIP_SQ = 1;
const MIN_BOX_SIDE = 4;
const BOX_FILL_ALPHA = 0.22;
const LONG_SHORT_FILL_ALPHA = 0.24;
/** Profit / loss tint (match dashboard candle palette; fills ignore `longShort.color`). */
const LS_PROFIT_HEX = '#00c087';
const LS_LOSS_HEX = '#ff3b30';
const LS_HANDLE_DRAW_R = 4.5;
const LS_LABEL_RADIUS = 3;
const HANDLE_HIT = 10;
const HANDLE_DRAW = 4;

/** @type {{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string } | { id: string, type: 'box', color: string, x: number, y: number, w: number, h: number } | { id: string, type: 'longShort', side?: 'long'|'short', color: string, x: number, yEntry: number, w: number, hProfit: number, hLoss: number } }} */

let overlayCanvas = null;
let overlayCtx = null;
let priceWrap = null;

let interactActive = false;
let tool = 'select'; // 'select' | 'pen' | 'text' | 'box' | 'longShort'
/** Orientation for placing **L** / **S** anchors (`hProfit` = green reward span, `hLoss` = red risk span). */
let longShortPlaceSide = 'long'; // 'long' | 'short'

/** @type {Array<{ id: string, type: 'path', color: string, points: { x: number, y: number }[] } | { id: string, type: 'text', color: string, x: number, y: number, text: string } | { id: string, type: 'box', color: string, x: number, y: number, w: number, h: number } | { id: string, type: 'longShort', side?: 'long'|'short', color: string, x: number, yEntry: number, w: number, hProfit: number, hLoss: number }>} */
let objects = [];

let selectedId = null;

/** @type {{ points: { x: number, y: number }[], preview?: { x: number, y: number } } | null} */
let draftPen = null;

/** @type {{ x0: number, y0: number, pointerId: number, previewX?: number, previewY?: number } | null} */
let draftBox = null;

/** @type {{ x0: number, y0: number, pointerId: number, side: 'long'|'short', previewX?: number, previewY?: number } | null} */
let draftLongShort = null;

/** @type {{ id: string, lastX: number, lastY: number, pointerId: number, mode?: 'move' | 'resize' | 'resizeLongShort', fx?: number, fy?: number, lsHandle?: 'tl' | 'ml' | 'mr' | 'bl', xr?: number, xl?: number, yEntry?: number } | null} */
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
    const dt = btn.dataset.drawTool ?? 'select';
    if (dt === 'longShort' && btn.dataset.lsSide) {
      btn.classList.toggle(
        'active',
        tool === 'longShort' &&
          btn.dataset.lsSide === longShortPlaceSide,
      );
    } else {
      btn.classList.toggle('active', dt === tool);
    }
  });
}

function _updateOverlayCursor() {
  if (!overlayCanvas) return;
  if (!interactActive) {
    overlayCanvas.style.cursor = '';
    return;
  }
  overlayCanvas.style.cursor =
    tool === 'pen' || tool === 'box' || tool === 'longShort'
      ? 'crosshair'
      : tool === 'text'
        ? 'text'
        : 'default';
}

function _localXY(e) {
  const r = overlayCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Reward (green) / risk (red) geometry; omit `side` → long. */
function _lsSide(o) {
  return o.side === 'short' ? 'short' : 'long';
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

/** @returns {{ kind: 'box', id: string, handle: 'nw'|'ne'|'sw'|'se' } | { kind: 'longShort', id: string, handle: 'tl'|'ml'|'mr'|'bl' } | null} */
function _hitAnnotationResizeTop(px, py) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.type === 'longShort') {
      const h = _nearestLsHandle(px, py, o);
      if (h) return { kind: 'longShort', id: o.id, handle: h };
    } else if (o.type === 'box') {
      const h = _nearestBoxHandle(px, py, o);
      if (h) return { kind: 'box', id: o.id, handle: h };
    }
  }
  return null;
}

function _longShortOuterBB(o) {
  if (_lsSide(o) === 'short') {
    const yTop = o.yEntry - o.hLoss;
    const yBot = o.yEntry + o.hProfit;
    return { minx: o.x, miny: yTop, maxx: o.x + o.w, maxy: yBot };
  }
  const yTop = o.yEntry - o.hProfit;
  const yBot = o.yEntry + o.hLoss;
  return { minx: o.x, miny: yTop, maxx: o.x + o.w, maxy: yBot };
}

/** @returns {'tl'|'ml'|'mr'|'bl'|null} */
function _nearestLsHandle(px, py, o) {
  const bb = _longShortOuterBB(o);
  const yTop = bb.miny;
  const yBot = bb.maxy;
  const xr = o.x + o.w;
  /** @type {Array<{ name: 'tl'|'ml'|'mr'|'bl', cx: number, cy: number }>} */
  const handles = [
    { name: 'tl', cx: o.x, cy: yTop },
    { name: 'ml', cx: o.x, cy: o.yEntry },
    { name: 'mr', cx: xr, cy: o.yEntry },
    { name: 'bl', cx: o.x, cy: yBot },
  ];
  let best = null;
  let bestD = HANDLE_HIT + 1;
  for (const { name, cx, cy } of handles) {
    const d = Math.hypot(px - cx, py - cy);
    if (d <= HANDLE_HIT && d <= bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

/** Green reward span ÷ red risk span (pixels). */
function _longShortRiskRatioText(o) {
  if (o.hLoss < 1e-6 || !Number.isFinite(o.hLoss)) return 'Risk Ratio: —';
  const r = o.hProfit / o.hLoss;
  if (!Number.isFinite(r)) return 'Risk Ratio: —';
  return `Risk Ratio: ${r.toFixed(2)}`;
}

/** Maps drag bbox halves to stored bands; upper half ↔ first band above entry varies by side. */
function _normalizedLongShortFromDiagonal(x0, y0, x1, y1, lsSide = 'long') {
  const xl = Math.min(x0, x1);
  const xr = Math.max(x0, x1);
  const yTop = Math.min(y0, y1);
  const yBot = Math.max(y0, y1);
  const w = xr - xl;
  const yEntry = (yTop + yBot) / 2;
  const hUp = yEntry - yTop;
  const hDn = yBot - yEntry;
  if (w < MIN_BOX_SIDE || hUp < MIN_BOX_SIDE || hDn < MIN_BOX_SIDE) return null;
  if (lsSide === 'short') {
    return { x: xl, yEntry, w, hProfit: hDn, hLoss: hUp };
  }
  return { x: xl, yEntry, w, hProfit: hUp, hLoss: hDn };
}

/** Freeze geometry for resizing from the handle opposite fixed edges. */
function _longShortResizeFreeze(o, handle) {
  const xr = o.x + o.w;
  switch (handle) {
    case 'tl':
      return { xr, yEntry: o.yEntry };
    case 'bl':
      return { xr, yEntry: o.yEntry };
    case 'mr':
      return { xl: o.x };
    default:
      return {};
  }
}

/** @param {typeof dragMove} dm */
function _applyLongShortResize(o, dm, mx, my) {
  const tag = dm.lsHandle;
  const side = _lsSide(o);
  if (!tag) return;
  const xrFrozen = dm.xr;
  const yE = dm.yEntry;
  const xlFreeze = dm.xl;
  if (tag === 'tl') {
    if (xrFrozen === undefined || yE === undefined) return;
    const xl = Math.min(mx, xrFrozen - MIN_BOX_SIDE);
    const top = Math.min(my, yE - MIN_BOX_SIDE);
    o.x = xl;
    o.w = xrFrozen - xl;
    if (side === 'long') {
      o.hProfit = yE - top;
    } else {
      o.hLoss = yE - top;
    }
  } else if (tag === 'bl') {
    if (xrFrozen === undefined || yE === undefined) return;
    const xl = Math.min(mx, xrFrozen - MIN_BOX_SIDE);
    o.x = xl;
    o.w = xrFrozen - xl;
    if (side === 'long') {
      o.hLoss = Math.max(MIN_BOX_SIDE, my - yE);
    } else {
      o.hProfit = Math.max(MIN_BOX_SIDE, my - yE);
    }
  } else if (tag === 'mr') {
    if (xlFreeze === undefined) return;
    o.w = Math.max(MIN_BOX_SIDE, mx - xlFreeze);
  }
}

function _drawLsRiskBadge(ctx, o, colorEntry) {
  const text = _longShortRiskRatioText(o);
  ctx.save();
  ctx.font = LS_LABEL_FONT;
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const padX = 7;
  const padY = 4;
  const bw = Math.min(Math.max(o.w - 8, MIN_BOX_SIDE * 4), Math.max(MIN_BOX_SIDE * 10, tw + padX * 2));
  const bh = padY * 2 + 12;
  const cx = o.x + o.w / 2;

  /** Vertical center target inside green (reward) band */
  let yGreenMid;
  if (_lsSide(o) === 'short') {
    yGreenMid = o.yEntry + o.hProfit * 0.5;
  } else {
    yGreenMid = o.yEntry - o.hProfit * 0.5;
  }
  const bb = _longShortOuterBB(o);
  let cy = yGreenMid;
  cy = Math.min(bb.maxy - bh / 2 - 4, Math.max(bb.miny + bh / 2 + 4, cy));

  let bx = cx - bw / 2;
  bx = Math.max(o.x + 3, Math.min(bx, o.x + o.w - bw - 3));
  const by = cy - bh / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(bx, by, bw, bh, LS_LABEL_RADIUS);
  else ctx.rect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(22,22,26,0.92)';
  ctx.fill();
  ctx.strokeStyle = colorEntry;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(240,243,246,0.95)';
  ctx.fillText(text, bx + bw / 2, by + bh / 2);
  ctx.restore();
}

/** Draw translucent profit/loss rectangles, entry line (uses `colorEntry`), risk pill. */
function _drawLongShortBody(ctx, o, colorEntry) {
  ctx.save();
  if (_lsSide(o) === 'short') {
    ctx.fillStyle = _hexToRgbaFill(LS_LOSS_HEX, LONG_SHORT_FILL_ALPHA);
    ctx.fillRect(o.x, o.yEntry - o.hLoss, o.w, o.hLoss);
    ctx.fillStyle = _hexToRgbaFill(LS_PROFIT_HEX, LONG_SHORT_FILL_ALPHA);
    ctx.fillRect(o.x, o.yEntry, o.w, o.hProfit);
  } else {
    ctx.fillStyle = _hexToRgbaFill(LS_PROFIT_HEX, LONG_SHORT_FILL_ALPHA);
    ctx.fillRect(o.x, o.yEntry - o.hProfit, o.w, o.hProfit);
    ctx.fillStyle = _hexToRgbaFill(LS_LOSS_HEX, LONG_SHORT_FILL_ALPHA);
    ctx.fillRect(o.x, o.yEntry, o.w, o.hLoss);
  }

  ctx.strokeStyle = colorEntry;
  ctx.lineWidth = PEN_WIDTH + 0.5;
  ctx.beginPath();
  ctx.moveTo(o.x, o.yEntry);
  ctx.lineTo(o.x + o.w, o.yEntry);
  ctx.stroke();
  ctx.restore();

  _drawLsRiskBadge(ctx, o, colorEntry);
}

function _drawLsHandleDots(ctx, o) {
  const bb = _longShortOuterBB(o);
  const yTop = bb.miny;
  const yBot = bb.maxy;
  const xr = o.x + o.w;
  const pts = [
    [o.x, yTop],
    [o.x, o.yEntry],
    [xr, o.yEntry],
    [o.x, yBot],
  ];
  ctx.save();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(60,132,246,0.95)';
  ctx.strokeStyle = 'rgba(230,237,246,0.95)';
  ctx.lineWidth = 1;
  for (const [hx, hy] of pts) {
    ctx.beginPath();
    ctx.arc(hx, hy, LS_HANDLE_DRAW_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
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
    } else if (o.type === 'longShort') {
      const bb = _longShortOuterBB(o);
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
  } else if (o.type === 'longShort') {
    const bb = _longShortOuterBB(o);
    ctx.strokeRect(bb.minx - 1, bb.miny - 1, bb.maxx - bb.minx + 2, bb.maxy - bb.miny + 2);
    ctx.setLineDash([]);
    _drawLsHandleDots(ctx, o);
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
    if (o.type === 'longShort') {
      _drawLongShortBody(overlayCtx, o, o.color);
      continue;
    }
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

  if (draftLongShort) {
    const px = draftLongShort.previewX ?? draftLongShort.x0;
    const py = draftLongShort.previewY ?? draftLongShort.y0;
    const g = _normalizedLongShortFromDiagonal(
      draftLongShort.x0,
      draftLongShort.y0,
      px,
      py,
      draftLongShort.side,
    );
    const col = _colorInputValue();
    if (!g) {
      const xl = Math.min(draftLongShort.x0, px);
      const yTop = Math.min(draftLongShort.y0, py);
      const rw = Math.abs(px - draftLongShort.x0);
      const rh = Math.abs(py - draftLongShort.y0);
      overlayCtx.save();
      overlayCtx.strokeStyle = col;
      overlayCtx.lineWidth = 1;
      overlayCtx.setLineDash([4, 3]);
      overlayCtx.strokeRect(xl + 0.5, yTop + 0.5, Math.max(rw - 1, 0), Math.max(rh - 1, 0));
      overlayCtx.restore();
    } else {
      _drawLongShortBody(
        overlayCtx,
        /** @type {{ side: string, x: number, yEntry: number, w: number, hProfit: number, hLoss: number }} */
        ({ ...g, side: draftLongShort.side }),
        col,
      );
    }
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

function _finalizeDraftLongShort(x1, y1) {
  const dc = draftLongShort;
  draftLongShort = null;
  if (!dc) {
    redrawChartDrawOverlay();
    return;
  }
  const n = _normalizedLongShortFromDiagonal(dc.x0, dc.y0, x1, y1, dc.side);
  if (!n) {
    redrawChartDrawOverlay();
    return;
  }
  objects.push({
    id: _nid(),
    type: 'longShort',
    side: dc.side,
    color: _colorInputValue(),
    ...n,
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
  draftLongShort = null;
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
    if (tool === 'longShort' && (btn.dataset.lsSide === 'long' || btn.dataset.lsSide === 'short')) {
      longShortPlaceSide = btn.dataset.lsSide;
    }
    draftPen = null;
    draftBox = null;
    draftLongShort = null;
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

    if (tool === 'longShort') {
      draftLongShort = {
        x0: x,
        y0: y,
        pointerId: e.pointerId,
        side: longShortPlaceSide,
      };
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

    // select — annotation resize handles before body hit-testing
    const ar = _hitAnnotationResizeTop(x, y);
    if (ar?.kind === 'box') {
      const o = objects.find(z => z.id === ar.id && z.type === 'box');
      if (o) {
        const { fx, fy } = _oppositeCornerForHandle(o, ar.handle);
        selectedId = ar.id;
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
    } else if (ar?.kind === 'longShort') {
      const o = objects.find(z => z.id === ar.id && z.type === 'longShort');
      if (o) {
        selectedId = ar.id;
        _syncDeleteBtn();
        if (colorEl) colorEl.value = o.color;
        if (ar.handle === 'ml') {
          dragMove = { id: o.id, lastX: x, lastY: y, pointerId: e.pointerId };
        } else {
          dragMove = {
            id: o.id,
            lastX: x,
            lastY: y,
            pointerId: e.pointerId,
            mode: 'resizeLongShort',
            lsHandle: ar.handle,
            ..._longShortResizeFreeze(o, ar.handle),
          };
        }
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
      dragMove?.mode === 'resizeLongShort' &&
      dragMove.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      const o = objects.find(z => z.id === dragMove.id);
      if (o && o.type === 'longShort') {
        _applyLongShortResize(o, dragMove, x, y);
      }
      redrawChartDrawOverlay();
      return;
    }

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
      draftLongShort &&
      tool === 'longShort' &&
      draftLongShort.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      draftLongShort.previewX = x;
      draftLongShort.previewY = y;
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
        } else if (o.type === 'longShort') {
          o.x += dx;
          o.yEntry += dy;
        }
      }
      redrawChartDrawOverlay();
    }
  });

  overlayCanvas.addEventListener('pointerup', e => {
    if (
      tool === 'longShort' &&
      draftLongShort &&
      draftLongShort.pointerId === e.pointerId &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      overlayCanvas.releasePointerCapture(e.pointerId);
      const xy = _localXY(e);
      _finalizeDraftLongShort(xy.x, xy.y);
      return;
    }
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
      draftLongShort &&
      typeof overlayCanvas.hasPointerCapture === 'function' &&
      overlayCanvas.hasPointerCapture(e.pointerId)
    ) {
      try {
        overlayCanvas.releasePointerCapture(e.pointerId);
      } catch (_) { /* noop */ }
      draftLongShort = null;
      redrawChartDrawOverlay();
    }
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
