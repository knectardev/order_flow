import { BREAKOUT_CELL, DEPTH_LABELS, FADE_CELL, MATRIX_COLS, MATRIX_ROWS, VOL_LABELS } from '../config/constants.js';
import { state } from '../state.js';
import { computeConfidence, topCells } from '../analytics/regime.js';

function buildMatrix() {
  const grid = document.getElementById('matrixGrid');
  grid.innerHTML = '';

  for (let r = 0; r < MATRIX_ROWS; r++) {
    const labelDiv = document.createElement('div');
    labelDiv.className = 'row-label';
    labelDiv.innerHTML = `<span class="num">${5-r}</span>${VOL_LABELS[r]}`;
    grid.appendChild(labelDiv);

    for (let c = 0; c < MATRIX_COLS; c++) {
      const cell = document.createElement('div');
      cell.className = 'matrix-cell';
      cell.dataset.r = r;
      cell.dataset.c = c;
      cell.innerHTML = `
        <div class="score-fill"></div>
        <div class="trail-dot"></div>
        <span class="watch-mark">◢</span>
      `;
      grid.appendChild(cell);
    }
  }

  // X-axis row
  const xRow = document.createElement('div');
  xRow.className = 'x-axis-row';
  const blank = document.createElement('div');
  xRow.appendChild(blank);
  for (let c = 0; c < MATRIX_COLS; c++) {
    const x = document.createElement('div');
    x.className = 'x-label';
    x.innerHTML = `<span class="num">${c+1}</span><br>${DEPTH_LABELS[c]}`;
    xRow.appendChild(x);
  }
  grid.appendChild(xRow);
}

function renderMatrix(breakoutCanonical, fadeCanonical) {
  const cells = document.querySelectorAll('.matrix-cell');
  const maxScore = Math.max(...state.matrixScores.flat());
  const top = topCells(state.matrixScores, 2);
  const breakoutFired = breakoutCanonical && breakoutCanonical.fired;
  const fadeFired     = fadeCanonical     && fadeCanonical.fired;

  cells.forEach(cell => {
    const r = +cell.dataset.r;
    const c = +cell.dataset.c;
    const s = state.matrixScores[r][c];
    const norm = s / Math.max(maxScore, 0.0001);
    const fill = cell.querySelector('.score-fill');
    fill.style.opacity = (norm * 0.45).toFixed(3);

    const isBreakoutCell = (r === BREAKOUT_CELL.r && c === BREAKOUT_CELL.c);
    const isFadeCell     = (r === FADE_CELL.r     && c === FADE_CELL.c);
    cell.classList.toggle('watched',       isBreakoutCell);
    cell.classList.toggle('watched-fade',  isFadeCell);
    cell.classList.toggle('current',       r === top[0].r && c === top[0].c);
    cell.classList.toggle('has-trail',           state.trail.some(t => t.r === r && t.c === c));
    cell.classList.toggle('fired',         isBreakoutCell && breakoutFired);
    cell.classList.toggle('fired-fade',    isFadeCell     && fadeFired);
  });

  // Confidence bar
  const conf = computeConfidence(state.matrixScores);
  document.getElementById('confFill').style.width = (conf * 100).toFixed(0) + '%';
  document.getElementById('confVal').textContent = conf.toFixed(2);

  // Status
  const cellName = (rc) => `${VOL_LABELS[rc.r]} · ${DEPTH_LABELS[rc.c]}`;
  document.getElementById('topCell').textContent = cellName(top[0]);
  document.getElementById('topCellScore').textContent = `score ${top[0].s.toFixed(3)} · cell [${5-top[0].r},${top[0].c+1}]`;
  document.getElementById('altCell').textContent = cellName(top[1]);
  document.getElementById('altCellScore').textContent = `score ${top[1].s.toFixed(3)} · cell [${5-top[1].r},${top[1].c+1}]`;
}

export { buildMatrix, renderMatrix };
