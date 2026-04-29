#!/usr/bin/env python3
"""Validate strategy JSON files using the pipeline's built-in rules.

Validates:
  - config/strategy_defaults.json (if present)
  - every *.json under config/profiles/

Does not require the ``jsonschema`` package; see config/strategy_defaults.schema.json
for editor / IDE hints. Exit code 1 if any file has validation errors.

Usage (from repository root):

  python scripts/validate_strategy_config.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PIPELINE_SRC = ROOT / "pipeline" / "src"
if str(PIPELINE_SRC) not in sys.path:
    sys.path.insert(0, str(PIPELINE_SRC))

from orderflow_pipeline.strategy_json import validate_strategy_document  # noqa: E402


def _check(path: Path) -> list[str]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [f"{path}: {exc}"]
    if not isinstance(raw, dict):
        return [f"{path}: root must be a JSON object"]
    return [f"{path}: {e}" for e in validate_strategy_document(raw)]


def main() -> int:
    errors: list[str] = []
    default_path = ROOT / "config" / "strategy_defaults.json"
    if default_path.exists():
        errors.extend(_check(default_path))
    profiles_dir = ROOT / "config" / "profiles"
    if profiles_dir.is_dir():
        for p in sorted(profiles_dir.glob("*.json")):
            errors.extend(_check(p))
    for line in errors:
        print(line, file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
