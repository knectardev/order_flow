# orderflow-pipeline

Decode Databento DBN/Trades files for the front-month ES future and aggregate
them into 1-minute OHLCV+delta bars consumable by `orderflow_dashboard.html`.

## Install

```bash
# from repo root
python -m venv .venv
.venv\Scripts\activate          # PowerShell: .venv\Scripts\Activate.ps1
pip install -e pipeline/
```

## Usage

```bash
# aggregate one or more days into bars/<symbol>_<date>_<session>.json + index.json
python -m orderflow_pipeline aggregate ^
    --raw-dir   data/raw/GLBX-20260426-6CCNUHXDNK ^
    --out-dir   data/bars ^
    --symbol    ES ^
    --session   rth

# print calibration distributions and side-by-side detection counts
python -m orderflow_pipeline calibrate ^
    --bars-dir  data/bars ^
    --date      2026-04-21
```

## Layout

```
src/orderflow_pipeline/
  decode.py       DBN.zst -> normalized trade iterator
  symbology.py    parent symbol -> per-day front-month instrument_id
  aggregate.py    trades -> 1-min OHLCV+delta+microstructure bars
  serialize.py    bars -> JSON (with tunings + sessionStart/End)
  calibrate.py    histograms + side-by-side detection rule comparison
  cli.py          argparse entrypoint
```

See the build plan (`databento_real_data_integration_a0cf86bb.plan.md`) for
design rationale on each stage.
