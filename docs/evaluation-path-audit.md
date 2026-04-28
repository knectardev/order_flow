# Evaluation Path Audit (Pre-Refactor Baseline)

## Backend Evaluation/Emission

- Pipeline aggregation emits canonical fires in `pipeline/src/orderflow_pipeline/cli.py` via `derive_fires_from_bars`.
- Backtest ON path reads DB `fires` in `pipeline/src/orderflow_pipeline/backtest_engine.py`.
- Backtest OFF compare path derives fires from bars in the same Python strategy module.

## Frontend Evaluation/Consumption

- API mode consumes canonical fires from `/fires` in `src/data/replay.js`.
- Frontend canonical evaluators remain in `src/analytics/canonical.js` for synthetic mode and guarded API fallback display behavior.
- API-mode canonical fire emission is disabled in `_commitRealBar` (`emitFrontendCanonicalFires` guard).

## Baseline Snapshot Artifacts

- Fire baseline snapshot: `pipeline/tests/baseline/pre_refactor_fires.json`.
- Baseline captured with: `python scripts/capture_pre_refactor_fires.py`.
- Post-change parity report: `docs/ssot-refactor-parity-report.md` from `python scripts/verify_fire_parity.py`.
