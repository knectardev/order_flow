#!/usr/bin/env python3
"""PHAT wick liquidity empirical distribution (read-only DuckDB diagnostic).

Matches spec in docs/cursor-prompt-wick-liquidity-histogram.md.
Does not modify pipeline metrics or schema.
"""
from __future__ import annotations

import argparse
import csv
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO_ROOT / "data" / "orderflow.duckdb"
DEFAULT_CSV_OUT = REPO_ROOT / "data" / "phat_wick_liquidity_analysis.csv"

# Same default exhaustion ring threshold as dashboard (`state.js`).
EXHAUSTION_FILL_THRESHOLD = 0.55


def _median(xs: list[float]) -> float:
    if not xs:
        return float("nan")
    ys = sorted(xs)
    n = len(ys)
    m = n // 2
    if n % 2:
        return ys[m]
    return (ys[m - 1] + ys[m]) / 2.0


def _is_exact_zero(x: float | None) -> bool:
    if x is None:
        return False
    return abs(float(x)) <= 1e-12


def _is_exact_one(x: float | None) -> bool:
    if x is None:
        return False
    return float(x) >= 1.0 - 1e-12


def _bin_index_20(x: float) -> int:
    """20 bins on [0, 1]: [0,0.05) ... [0.95, 1.0]; 1.0 maps to last bin."""
    if _is_exact_one(x) or x > 0.999999:
        return 19
    if _is_exact_zero(x) or x < 0.0:
        return 0
    b = int(float(x) * 20.0)
    return max(0, min(19, b))


def _wick_ticks(open_: float, high: float, low: float, close: float, tick_size: float) -> tuple[int, int]:
    """Upper / lower wick span in tick indices (aligned with phat.py rounding)."""
    body_hi = max(open_, close)
    body_lo = min(open_, close)
    top_body_tick = round(body_hi / tick_size)
    bot_body_tick = round(body_lo / tick_size)
    high_tick = round(high / tick_size)
    low_tick = round(low / tick_size)
    upper = max(0, high_tick - top_body_tick)
    lower = max(0, bot_body_tick - low_tick)
    return upper, lower


def _fmt_pct(num: float, den: int) -> str:
    if den <= 0:
        return "-"
    return f"{100.0 * num / den:6.2f}%"


def _print_table(title: str, headers: tuple[str, ...], rows: list[tuple]) -> None:
    print()
    print(title)
    print("-" * min(120, max(40, 12 + sum(12 for _ in headers))))
    colw = [max(len(h), 12) for h in headers]
    print("  " + "  ".join(h.ljust(colw[i]) for i, h in enumerate(headers)))
    print("  " + "  ".join("-" * colw[i] for i in range(len(headers))))
    for row in rows:
        cells = []
        for i, c in enumerate(row):
            s = c if isinstance(c, str) else str(c)
            cells.append(s[: colw[i] + 5].ljust(colw[i]))
        print("  " + "  ".join(cells))


def main() -> int:
    ap = argparse.ArgumentParser(description="PHAT wick liquidity histograms (read-only DuckDB)")
    ap.add_argument("--db-path", type=Path, default=Path(os.environ.get("ORDERFLOW_DB_PATH", str(DEFAULT_DB))))
    ap.add_argument("--timeframe", default="1m")
    ap.add_argument("--symbol", default="", help="Reserved (bars table has no symbol column in current schema).")
    ap.add_argument(
        "--session-date",
        default="all",
        help='Restrict to one session date (YYYY-MM-DD), or "all".',
    )
    ap.add_argument(
        "--tick-size",
        type=float,
        default=0.25,
        help="Instrument tick size in price points (default 0.25 = ES).",
    )
    ap.add_argument(
        "--max-rows",
        type=int,
        default=0,
        help="If >0, sample at most this many rows (ORDER BY random()). Default: all matching rows.",
    )
    ap.add_argument(
        "--csv-out",
        type=Path,
        default=DEFAULT_CSV_OUT,
        help=f"Write summary CSV (default: {DEFAULT_CSV_OUT}).",
    )
    args = ap.parse_args()

    if args.symbol:
        print(
            "# Note: --symbol is ignored; `bars` has no symbol column (single-instrument DB).\n",
            file=sys.stderr,
        )

    if not args.db_path.is_file():
        print(f"[FAIL] DuckDB not found: {args.db_path}", file=sys.stderr)
        return 1

    try:
        import duckdb
    except ImportError:
        print("[FAIL] pip install duckdb", file=sys.stderr)
        return 1

    tick_size = args.tick_size
    if tick_size <= 0:
        print("[FAIL] tick-size must be > 0", file=sys.stderr)
        return 1

    tf = args.timeframe
    sess = (args.session_date or "").strip().lower()
    filters = ["timeframe = ?", "(upper_wick_liquidity IS NOT NULL OR lower_wick_liquidity IS NOT NULL)"]
    params: list = [tf]

    if sess and sess != "all":
        filters.append("session_date = ?::DATE")
        params.append(args.session_date)

    where_sql = " AND ".join(filters)
    base_from = f"""
        SELECT
            session_date,
            bar_time,
            open, high, low, close,
            upper_wick_liquidity,
            lower_wick_liquidity,
            rejection_side,
            rejection_type
        FROM bars
        WHERE {where_sql}
    """

    con = duckdb.connect(str(args.db_path), read_only=True)
    try:
        if args.max_rows and args.max_rows > 0:
            q = f"SELECT * FROM ({base_from}) AS q ORDER BY random() LIMIT {int(args.max_rows)}"
            cur = con.execute(q, params)
        else:
            cur = con.execute(base_from, params)
        colnames = [d[0] for d in cur.description]
        raw_rows = cur.fetchall()
        rows = [dict(zip(colnames, r)) for r in raw_rows]
    except Exception as e:
        print(f"[FAIL] Query: {e}", file=sys.stderr)
        return 1
    finally:
        con.close()

    n = len(rows)
    print(f"=== PHAT wick liquidity distribution ===")
    print(f"db={args.db_path}  timeframe={tf}  session_date={sess or 'all'}")
    print(f"tick_size={tick_size}  rows_loaded={n:,}")
    if n == 0:
        print("No rows - widen filters or rebuild DB.")
        return 0

    # Collect series per side (skip null liquidity on that side only when building side-specific histograms)
    upper_liq: list[float] = []
    lower_liq: list[float] = []
    upper_len: list[int] = []
    lower_len: list[int] = []

    for r in rows:
        o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        uw, lw = _wick_ticks(o, h, lo, c, tick_size)
        upper_len.append(uw)
        lower_len.append(lw)

        u = r.get("upper_wick_liquidity")
        l = r.get("lower_wick_liquidity")
        if u is not None:
            upper_liq.append(float(u))
        if l is not None:
            lower_liq.append(float(l))

    def hist20(series: list[float]) -> tuple[list[int], int, int]:
        bins = [0] * 20
        n0 = n1 = 0
        for x in series:
            if _is_exact_zero(x):
                n0 += 1
            if _is_exact_one(x):
                n1 += 1
            bins[_bin_index_20(x)] += 1
        return bins, n0, n1

    def hist_len(series: list[int]) -> list[int]:
        # buckets 0..19 individual, index 20 = 20+
        out = [0] * 21
        for v in series:
            if v >= 20:
                out[20] += 1
            else:
                out[v] += 1
        return out

    ub, u0, u1 = hist20(upper_liq)
    lb, l0, l1 = hist20(lower_liq)
    nu, nl = len(upper_liq), len(lower_liq)

    # --- A: liquidity histogram ---
    print("\n### A. Overall liquidity (20 bins on [0, 1], width 0.05)")
    rows_a: list[tuple] = []
    for i in range(20):
        lo_b = i / 20.0
        hi_b = (i + 1) / 20.0 if i < 19 else 1.0
        label = f"[{lo_b:.2f},{hi_b:.2f}]" if i < 19 else "[0.95,1.00]"
        uc, lc = ub[i], lb[i]
        rows_a.append(
            (
                label,
                uc,
                _fmt_pct(uc, nu) if nu else "-",
                lc,
                _fmt_pct(lc, nl) if nl else "-",
            )
        )
    _print_table(
        "Bin (upper / lower counts and % within side)",
        ("bin", "upper_n", "upper_%", "lower_n", "lower_%"),
        rows_a,
    )
    print(f"\n  Endpoint detail (exact float match tolerance 1e-12 for 0, >=1-1e-12 for 1):")
    print(f"    upper: count @ 0.0 = {u0:,} ({_fmt_pct(u0, nu)})   @ 1.0 = {u1:,} ({_fmt_pct(u1, nu)})   n_side={nu:,}")
    print(f"    lower: count @ 0.0 = {l0:,} ({_fmt_pct(l0, nl)})   @ 1.0 = {l1:,} ({_fmt_pct(l1, nl)})   n_side={nl:,}")

    # --- B: wick length histogram ---
    uh = hist_len(upper_len)
    lh = hist_len(lower_len)
    rows_b: list[tuple] = []
    for k in range(20):
        rows_b.append((str(k), uh[k], _fmt_pct(uh[k], n), lh[k], _fmt_pct(lh[k], n)))
    rows_b.append(("20+", uh[20], _fmt_pct(uh[20], n), lh[20], _fmt_pct(lh[20], n)))
    _print_table(
        "### B. Wick length in ticks (same rounding as phat body/high/low ticks)",
        ("ticks", "upper_n", "upper_%", "lower_n", "lower_%"),
        rows_b,
    )

    # --- C: conditional on wick-length bucket ---
    buckets = [
        ("0", lambda t: t == 0),
        ("1", lambda t: t == 1),
        ("2", lambda t: t == 2),
        ("3-5", lambda t: 3 <= t <= 5),
        ("6-10", lambda t: 6 <= t <= 10),
        ("11+", lambda t: t >= 11),
    ]

    def cond_stats(lengths: list[int], liqs: list[float]) -> list[tuple]:
        out = []
        mlen = min(len(lengths), len(liqs))
        for label, pred in buckets:
            xs = [liqs[i] for i in range(mlen) if pred(lengths[i])]
            if not xs:
                out.append((label, 0, "-", "-", "-", "-"))
                continue
            m = len(xs)
            mean = sum(xs) / m
            med = _median(xs)
            p1 = sum(1 for x in xs if _is_exact_one(x)) / m
            p55 = sum(1 for x in xs if x >= EXHAUSTION_FILL_THRESHOLD) / m
            out.append((label, m, f"{mean:.4f}", f"{med:.4f}", f"{100 * p1:.2f}%", f"{100 * p55:.2f}%"))
        return out

    # For C we need per-row aligned upper/lower (skip-null paths above).
    # We built upper_len for ALL rows; upper_liq only where not null. Safer: iterate rows again with aligned arrays.

    def aligned_series(side: str) -> tuple[list[int], list[float]]:
        lens, liqs = [], []
        for r in rows:
            o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
            uw, lw = _wick_ticks(o, h, lo, c, tick_size)
            if side == "upper":
                v = r.get("upper_wick_liquidity")
                L = uw
            else:
                v = r.get("lower_wick_liquidity")
                L = lw
            if v is None:
                continue
            lens.append(L)
            liqs.append(float(v))
        return lens, liqs

    u_lens, u_liqs = aligned_series("upper")
    l_lens, l_liqs = aligned_series("lower")

    rows_cu = cond_stats(u_lens, u_liqs)
    rows_cl = cond_stats(l_lens, l_liqs)
    _print_table(
        "### C. Upper wick: liquidity by wick-length bucket",
        ("wick_ticks", "n", "mean_liq", "median_liq", "pct==1.0", f"pct>={EXHAUSTION_FILL_THRESHOLD}"),
        rows_cu,
    )
    _print_table(
        "### C. Lower wick: liquidity by wick-length bucket",
        ("wick_ticks", "n", "mean_liq", "median_liq", "pct==1.0", f"pct>={EXHAUSTION_FILL_THRESHOLD}"),
        rows_cl,
    )

    # --- D: summary ---
    u_eq1 = sum(1 for x in upper_liq if _is_exact_one(x))
    l_eq1 = sum(1 for x in lower_liq if _is_exact_one(x))

    def short_where_eq1(side: str) -> tuple[int, int]:
        ok = sh = 0
        for r in rows:
            o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
            uw, lw = _wick_ticks(o, h, lo, c, tick_size)
            if side == "upper":
                v = r.get("upper_wick_liquidity")
                L = uw
            else:
                v = r.get("lower_wick_liquidity")
                L = lw
            if v is None or not _is_exact_one(float(v)):
                continue
            ok += 1
            if L <= 2:
                sh += 1
        return ok, sh

    u1_ok, u1_short = short_where_eq1("upper")
    l1_ok, l1_short = short_where_eq1("lower")

    # Filled exhaustion: exhaustion + side liquidity >= threshold (dashboard rule)
    fe_total = fe_short = 0
    for r in rows:
        rs = (r.get("rejection_side") or "").strip().lower()
        rt = (r.get("rejection_type") or "").strip().lower()
        if rt != "exhaustion" or rs not in ("high", "low"):
            continue
        if rs == "high":
            v = r.get("upper_wick_liquidity")
            wt = _wick_ticks(float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), tick_size)[0]
        else:
            v = r.get("lower_wick_liquidity")
            wt = _wick_ticks(float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), tick_size)[1]
        if v is None or float(v) < EXHAUSTION_FILL_THRESHOLD:
            continue
        fe_total += 1
        if wt <= 2:
            fe_short += 1

    print("\n### D. Summary statistics")
    print(f"  Bars analyzed: {n:,}")
    print(f"  Upper wick - samples with non-null liquidity: {nu:,}")
    print(f"    Fraction liquidity ~1.0: {u_eq1:,} / {nu:,} = {_fmt_pct(u_eq1, nu)}")
    print(f"    Of those ~1.0, fraction wick length <=2 ticks: {u1_short:,} / {u1_ok:,} = {_fmt_pct(u1_short, u1_ok) if u1_ok else '-'}")
    print(f"  Lower wick - samples with non-null liquidity: {nl:,}")
    print(f"    Fraction liquidity ~1.0: {l_eq1:,} / {nl:,} = {_fmt_pct(l_eq1, nl)}")
    print(f"    Of those ~1.0, fraction wick length <=2 ticks: {l1_short:,} / {l1_ok:,} = {_fmt_pct(l1_short, l1_ok) if l1_ok else '-'}")
    print(
        f"  Filled exhaustion rings (exhaustion + side liq >= {EXHAUSTION_FILL_THRESHOLD}): {fe_total:,} bars"
    )
    print(
        f"    ...of which wick length on rejection side <=2 ticks: {fe_short:,} ({_fmt_pct(fe_short, fe_total) if fe_total else '-'})"
    )

    # --- E: absorption vs exhaustion by rejection-side wick length (pre-implementation check) ---
    def _rej_side_ticks(r: dict) -> int | None:
        rs = (r.get("rejection_side") or "").strip().lower()
        if rs not in ("high", "low"):
            return None
        o, h, lo, c = float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"])
        uw, lw = _wick_ticks(o, h, lo, c, tick_size)
        return uw if rs == "high" else lw

    def _wick_bucket(t: int | None) -> str | None:
        if t is None:
            return None
        if t <= 0:
            return "0"
        if t == 1:
            return "1"
        if t == 2:
            return "2"
        if t <= 5:
            return "3-5"
        if t <= 10:
            return "6-10"
        return "11+"

    abs_rows = []
    exh_rows = []
    for r in rows:
        rt = (r.get("rejection_type") or "").strip().lower()
        if rt == "absorption":
            abs_rows.append(r)
        elif rt == "exhaustion":
            exh_rows.append(r)

    def _bucket_counts(rows_subset: list[dict]) -> dict[str, int]:
        out = {"0": 0, "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11+": 0}
        for r in rows_subset:
            w = _rej_side_ticks(r)
            b = _wick_bucket(w)
            if b:
                out[b] += 1
        return out

    def _short_frac(rows_subset: list[dict]) -> tuple[float, int]:
        ok = sh = 0
        for r in rows_subset:
            w = _rej_side_ticks(r)
            if w is None:
                continue
            ok += 1
            if w <= 2:
                sh += 1
        return (sh / ok if ok else 0.0, ok)

    bc_abs = _bucket_counts(abs_rows)
    bc_exh = _bucket_counts(exh_rows)
    sf_abs, n_abs = _short_frac(abs_rows)
    sf_exh, n_exh = _short_frac(exh_rows)

    print("\n### E. Rejection-side wick length by classification (absorption vs exhaustion)")
    print(f"  Absorption bars (rejection typed): {len(abs_rows):,}; with valid side: {n_abs:,}")
    print(f"  Exhaustion bars (rejection typed): {len(exh_rows):,}; with valid side: {n_exh:,}")
    rows_e: list[tuple] = []
    for lab in ("0", "1", "2", "3-5", "6-10", "11+"):
        a, e = bc_abs[lab], bc_exh[lab]
        rows_e.append((lab, a, _fmt_pct(a, len(abs_rows)) if abs_rows else "-", e, _fmt_pct(e, len(exh_rows)) if exh_rows else "-"))
    _print_table(
        "Bucket (rejection-side wick ticks)",
        ("bucket", "abs_n", "abs_%", "exh_n", "exh_%"),
        rows_e,
    )
    print(
        "  Fraction rejection-side wick length <= 2 ticks: absorption "
        f"{100.0 * sf_abs:.2f}% (n={n_abs}) vs exhaustion {100.0 * sf_exh:.2f}% (n={n_exh})"
    )
    # Recommend symmetric wick-length gate for absorption rings if short-wick concentration is comparable or worse than exhaustion.
    sym_msg = "UNDECIDED (insufficient absorption or exhaustion samples)"
    if n_abs >= 30 and n_exh >= 30:
        if sf_abs >= sf_exh - 0.02:
            sym_msg = (
                "YES - apply the same min-wick-ticks gate to absorption ring fill as exhaustion "
                "(absorption short-wick share is not materially lower than exhaustion; parallel artifact risk)."
            )
        else:
            sym_msg = (
                "OPTIONAL - absorption appears less concentrated on short wicks than exhaustion; "
                "you may gate absorption rings only after manual review, or keep asymmetric v1."
            )
    print(f"\n  Recommendation (symmetric absorption ring gating): {sym_msg}")

    # --- CSV ---
    csv_rows: list[dict[str, str]] = []

    def cr(section: str, **kv: str | int | float) -> None:
        row = {"section": section, **{k: str(v) for k, v in kv.items()}}
        csv_rows.append(row)

    cr("meta", rows=str(n), timeframe=tf, session_date=sess or "all", tick_size=str(tick_size))
    for i in range(20):
        lo_b = i / 20.0
        hi_b = (i + 1) / 20.0 if i < 19 else 1.0
        label = f"{lo_b:.2f}-{hi_b:.2f}"
        cr("A_liquidity_bin", bin=label, upper_count=ub[i], lower_count=lb[i])
    cr("A_endpoints", upper_at_0=u0, upper_at_1=u1, lower_at_0=l0, lower_at_1=l1)
    for k in range(20):
        cr("B_wick_len", ticks=str(k), upper_count=uh[k], lower_count=lh[k])
    cr("B_wick_len", ticks="20+", upper_count=uh[20], lower_count=lh[20])
    for row in rows_cu:
        cr("C_upper_by_len", wick_bucket=row[0], n=row[1], mean=row[2], median=row[3], pct_eq1=row[4], pct_ge_thr=row[5])
    for row in rows_cl:
        cr("C_lower_by_len", wick_bucket=row[0], n=row[1], mean=row[2], median=row[3], pct_eq1=row[4], pct_ge_thr=row[5])
    cr(
        "D_summary",
        bars=n,
        upper_eq1=u_eq1,
        upper_eq1_short_wick_frac=u1_short / u1_ok if u1_ok else "",
        lower_eq1=l_eq1,
        lower_eq1_short_wick_frac=l1_short / l1_ok if l1_ok else "",
        filled_exhaustion_n=fe_total,
        filled_exhaustion_short_wick_frac=fe_short / fe_total if fe_total else "",
    )
    cr(
        "E_absorption_exhaustion",
        absorption_n=len(abs_rows),
        exhaustion_n=len(exh_rows),
        absorption_short_wick_frac=sf_abs,
        exhaustion_short_wick_frac=sf_exh,
        symmetric_gate_recommended=("yes" if n_abs >= 30 and n_exh >= 30 and sf_abs >= sf_exh - 0.02 else "review"),
    )

    out_path = args.csv_out.expanduser()
    if not out_path.is_absolute():
        out_path = Path.cwd() / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = sorted({k for row in csv_rows for k in row.keys()})
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(csv_rows)
    print(f"\nWrote {out_path} ({len(csv_rows)} rows).")

    return 0


if __name__ == "__main__":
    sys.exit(main())
