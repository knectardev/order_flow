#!/usr/bin/env python3
"""Validate broker default JSON documents (no jsonschema dependency).

Reads:
  - config/backtest_defaults.json (if present)
  - ORDERFLOW_BACKTEST_CONFIG if set and the file exists
"""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(ROOT / "pipeline" / "src"))

from orderflow_pipeline.backtest_defaults import (  # noqa: E402
    validate_backtest_defaults_document,
)


def main() -> int:
    paths: list[Path] = []
    p_env = os.environ.get("ORDERFLOW_BACKTEST_CONFIG", "").strip()
    if p_env:
        pe = Path(p_env)
        pe = pe if pe.is_absolute() else (Path.cwd() / pe).resolve()
        if pe.is_file():
            paths.append(pe)
        else:
            print(f"[warn] ORDERFLOW_BACKTEST_CONFIG not found: {pe}", flush=True)

    repo_default = ROOT / "config" / "backtest_defaults.json"
    if repo_default.is_file() and repo_default not in paths:
        paths.insert(0, repo_default)

    if not paths:
        print("[error] No backtest_defaults JSON files to validate.", flush=True)
        return 2

    failed = False
    for doc_path in paths:
        try:
            data = json.loads(doc_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"[error] Cannot read JSON {doc_path}: {exc}", flush=True)
            failed = True
            continue
        if not isinstance(data, dict):
            print(f"[error] {doc_path}: root must be object", flush=True)
            failed = True
            continue
        errs = validate_backtest_defaults_document(data)
        if errs:
            failed = True
            for e in errs:
                print(f"[error] {doc_path}: {e}", flush=True)
        else:
            print(f"[ok] {doc_path}", flush=True)

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
