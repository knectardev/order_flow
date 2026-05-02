# Unified Signals Migration Runbook

## Objective

Make DuckDB `fires` the single source of truth for chart halos and backtest
entries while preserving Value Edge performance parity.

## Steps

1. Rebuild DB so pipeline-generated bars (including regime **`vol_score` / `depth_score`** — see `requirements.md` §4.3) and fires are refreshed:
   - `python -m orderflow_pipeline.cli rebuild --raw-dir <raw> --out-dir <out> --db-path data/orderflow.duckdb`
2. Confirm Value Edge fire count in DB for the target window:
   - `SELECT COUNT(*) FROM fires WHERE timeframe='1m' AND watch_id='valueEdgeReject' AND bar_time BETWEEN ...`
3. Run two backtests over the exact same window:
   - baseline run id: previous high-Sharpe reference
   - candidate run id: unified DB-fire run
4. Validate strict parity:
   - `python scripts/value_edge_parity_check.py --baseline-run-id <id> --candidate-run-id <id>`
5. Inspect skipped-fire diagnostics:
   - `GET /api/backtest/skipped-fires?runId=<candidate-id>`
   - verify reason summary explains chart-bullseye vs executed-trade gaps.

## Success Criteria

- Chart (API mode) displays fires loaded from `/fires`.
- Backtest reports `signalSource = db`.
- Sharpe is exactly equal to baseline.
- Equity point sequence is exactly equal to baseline.
- Skip reasons are persisted and queryable for every non-executed fire.

