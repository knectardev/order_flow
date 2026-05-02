# CVD subchart, size imbalance, swings, and divergence — implementation plan

This file summarizes the agreed roadmap (see `docs/cursor-prompt-cvd-divergence-size-imbalance.md`). **Pipeline computes, frontend renders.** Ingest parameters are stored on `swing_events` / `divergence_events` rows; changing K or divergence thresholds requires a **rebuild**.

## Phases

1. **Session CVD** — `session_cvd` on bars; API `sessionCvd`; UI: separate **delta histogram** panel and **CVD line** panel (separate canvases, separate Y-axes); remove viewport-only cumulative sparkline; hover sync.
2. **Size imbalance** — `aggressive_*` counts/averages, `size_imbalance_ratio` on bars; API only (no UI).
3. **Swings** — `swing_events` table; fractal detection on price OHLC and `session_cvd`; `swing_lookback` column on every row; `GET /swing-events`.
4. **Phase 3b** — Calibrate divergence thresholds from swing distributions (`scripts/calibrate_divergence_thresholds.py`); no fixed a priori defaults in code beyond pipeline CLI after analysis.
5. **Divergences** — `divergence_events` with threshold columns + `size_confirmation`; `GET /divergence-events`; connecting lines on price + CVD panels.
6. **Integration** — Bar tooltip mentions CVD divergences; matrix point highlight for selected divergence; queryable for backtest.

## Schema notes

- `bars.session_cvd`: BIGINT (session cumulative delta).
- `swing_events`: includes `swing_lookback` (NOT NULL).
- `divergence_events`: includes `swing_lookback`, `min_price_delta`, `min_cvd_delta`, `max_swing_bar_distance` (ingest stamps).

## UI layout (decided)

Price chart → delta histogram (`flowChart`) → session CVD line (`cvdChart`); toggles in state for panel visibility.
