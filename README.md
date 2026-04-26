# Order Flow Dashboard — ES Real-Data Build

A single-file HTML/CSS/JS prototype that visualizes order flow microstructure
(volume profile, anchored VWAP, aggressor delta, sweeps, absorption,
divergence, stop-runs) overlaid with a 5×5 probabilistic regime matrix and
two canonical entry watches (Breakout, Fade).

The original prototype shipped with a synthetic random-walk simulator. This
repo extends it with a Python pipeline that decodes Databento DBN/Trades
files for the front-month **ES** (E-mini S&P 500) future and aggregates them
into 1-minute bars consumable by the dashboard. The visualization layer,
event detection, and modal architecture are unchanged in synthetic mode and
behave identically until a real session is loaded.

See [`databento_real_data_integration_a0cf86bb.plan.md`](databento_real_data_integration_a0cf86bb.plan.md)
for the full design rationale.

## Layout

```
order_flow/
├── orderflow_dashboard.html   # the dashboard, reads bars/index.json on load
├── data/
│   ├── raw/                   # gitignored — Databento .dbn.zst downloads
│   │   ├── GLBX-20260426-6CCNUHXDNK/   # ES.FUT, 2026-04-19 → 2026-04-24 (working)
│   │   └── GLBX-20260426-SKK8MTRW7S/   # MES.FUT, same window (comparison)
│   └── bars/                  # CHECKED IN — small JSON, dashboard works after clone
│       ├── index.json
│       └── es_2026-04-{20..24}_rth.json
├── pipeline/                  # Python pipeline (decode → aggregate → JSON)
├── notes.txt
└── requirements.md            # original dashboard design doc
```

## Quick start (use existing bars)

```powershell
# from repo root, serve the dashboard so fetch() can reach data/bars/index.json
python -m http.server 8000
# then open http://localhost:8000/orderflow_dashboard.html
```

The dashboard auto-loads the most recent ES session, switches the badge to
**Real · ES · v1 regime proxy**, and surfaces the replay controls (session
dropdown, scrubber, step ◀/▶, time readout). Click **Start Stream** to
play, **Reset** to rewind to bar 0, drag the scrubber to seek, or use the
repurposed **Jump to next ★/◆** buttons inside the matrix watches to
fast-forward to canonical fires.

If the page is opened directly via `file://` (no server), the `fetch()` for
`data/bars/index.json` fails silently and the dashboard stays in synthetic
mode — useful for the original demo.

## Re-aggregate from raw

```powershell
# Once: install the pipeline package
python -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e pipeline/

# Aggregate ES into 1-minute RTH bars
python -m orderflow_pipeline aggregate `
    --raw-dir data\raw\GLBX-20260426-6CCNUHXDNK `
    --out-dir data\bars `
    --symbol ES --session rth

# Inspect bar-level distributions and side-by-side detection rule counts
python -m orderflow_pipeline calibrate `
    --bars-dir data\bars `
    --date 2026-04-21 --symbol es --session rth
```

`aggregate` writes one JSON file per RTH session (~78 KB / file) plus an
`index.json` manifest. Each session JSON carries a `tunings` block (the
event-detection thresholds, `largePrintThreshold`, etc.) and the
`sessionStart` / `sessionEnd` UTC timestamps used by the dashboard to anchor
VWAP at the cash-session open.

`calibrate` prints volume / range / `avgTradeSize` / `largePrintRatio`
percentiles, per-ET-hour volume buckets to expose the "smile", and
side-by-side sweep counts under three rules: the original 1.65× multiplier,
a z-score (>2σ), and a robust median+MAD (>2× MAD). Use it to pick
calibrated thresholds for ES, then re-run `aggregate` with the override
flags (`--sweep-vol-mult`, `--absorb-vol-mult`, `--absorb-range-mult`,
`--divergence-flow-mult`, `--large-print-threshold`).

## What's preserved vs. changed

| Surface                      | Synthetic mode             | Real-data mode                                    |
|------------------------------|----------------------------|---------------------------------------------------|
| `step()`                     | `generateBar` + wiggle     | Pull next bar from `replay.allBars`, no wiggle    |
| `evolveSimState`             | random walk                | replaced by `deriveRegimeState` (session quintiles)|
| `volState`                   | random walk in [0..4]      | range bucket vs session quintiles                  |
| `depthState`                 | random walk in [0..4]      | (avgTradeSize z + largePrintRatio z) bucket       |
| `computeAnchoredVWAP`        | rolling-window anchor      | pinned to `sessionStart` (09:30 ET)               |
| Detection thresholds         | inline `1.65×`, `1.75×`    | read from JSON `tunings` block (defaults match)   |
| `Force ★` / `Force ◆`        | scenario-lock + prime      | "Jump to next" (pre-scanned canonical fires)      |
| `Reset` button               | clear all state            | seek to bar 0 (preserves loaded session)          |

The synthetic path is byte-identical to the original prototype until a
session is fetched.

## Validation

The pipeline has been validated against the 2026-04-19 → 2026-04-24 ES
batch:

- **Front-month identification:** ESM6 wins ≥ 99.55% of daily volume on
  every day. Spread legs and back-month outrights account for the rest and
  are dropped automatically.
- **OHLC sanity:** session opens / closes / ranges land where ESM6 traded
  on broker charts. ES was at ~$7100 in this window with daily ranges of
  ~$80–$120.
- **Cumulative delta:** stays within ±5% of session volume — no monotonic
  drift, confirming the A/B/N side mapping is correct.
- **Detection threshold caveat:** the synthetic-tuned `1.65×` sweep
  multiplier over-fires by 3-5× on real ES (calibration mode shows
  ~30-46 sweeps per session vs. the 3-10 target band). Use
  `aggregate --sweep-vol-mult ...` to ship calibrated values; the
  dashboard reads them per-session from the `tunings` block.

## Out of scope (deferred)

- Live Databento streaming (would need `databento.Live` + websockets).
- MBP-10 book reconstruction (we use `trades` only; depth is a proxy).
- Backtesting / P&L simulation.
- Multiple symbols simultaneously (ES front-month only).
- Visible session-gap rendering (currently one session at a time).
- Z-score / median-MAD detection in the *synthetic* path (kept as multiplier
  per the prototype's hard constraints).
