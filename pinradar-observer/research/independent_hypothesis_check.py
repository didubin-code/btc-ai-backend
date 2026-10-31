#!/usr/bin/env python3
"""Independent recomputation of the r28_usdc lock/qualifying research figures.

Written from the task definitions only (hypothesis_28.js and its results were
NOT consulted). Python 3 standard library only.

Inputs (read-only):
  /home/user/data_val/replay/r28_usdc.ndjson          one object per market
  /home/user/data_val/replay/r28_usdc.trace.ndjson    one object per LOCKED /
                                                      PROVEN LOCKED / REVERSAL
                                                      WARNING decision second
  /home/user/data_val/kalshi/trades/<ticker>.json.gz  Kalshi trade prints

Output:
  research/independent_hypothesis_results.json

Design notes
  * "first" row = the row with the largest tau among those satisfying the
    condition (tau descending = earliest first). Both trace passes are
    therefore independent of file order; the script still checks that tau is
    strictly decreasing per ticker (which also rules out duplicate seconds).
  * Pass 1 finds first LOCKED / first qualifying / first qualifying with
    tau <= 120. Pass 2 scans rows with tau < q.tau for warned / dirChange /
    continuous.
  * Prices and dollar amounts use Decimal arithmetic on the string fields, so
    no float noise enters the percentiles or the capacity thresholds.
"""

import calendar
import datetime
import gzip
import json
import math
import os
import re
import sys
from decimal import Decimal

MARKETS = "/home/user/data_val/replay/r28_usdc.ndjson"
TRACE = "/home/user/data_val/replay/r28_usdc.trace.ndjson"
TRADES_DIR = "/home/user/data_val/kalshi/trades"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "independent_hypothesis_results.json")

QUAL_PF = 0.002
LOCKED_STATES = ("LOCKED", "PROVEN LOCKED")
WARN_STATE = "REVERSAL WARNING"
WINDOW_MS = 10_000
CAP_THRESHOLDS = (75_000, 10_000)
PERCENTILES = (10, 25, 50, 75, 90)

# (label, low exclusive, high inclusive); None = unbounded
INTERVALS = [
    ("300-181", 180, 300),
    ("180-121", 120, 180),
    ("120-91", 90, 120),
    ("90-61", 60, 90),
    ("60-31", 30, 60),
    ("30-0", None, 30),
]


def is_locked(st):
    return st in LOCKED_STATES


def pct(num, den):
    return None if den == 0 else 100.0 * num / den


def round_half_up(x):
    return int(math.floor(x + 0.5))


def interval_of(tau):
    for label, lo, hi in INTERVALS:
        if (lo is None or tau > lo) and tau <= hi:
            return label
    return None  # tau > 300 (never observed; reported if it happens)


# ---------------------------------------------------------------------------
# Regularized incomplete beta + Clopper-Pearson (no scipy)
# ---------------------------------------------------------------------------

def _betacf(a, b, x):
    """Continued fraction for I_x(a,b) (modified Lentz, Numerical Recipes)."""
    fpmin = 1e-300
    eps = 1e-16
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1.0 / d
    h = d
    for m in range(1, 100000):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1.0 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1.0 / d
        delta = d * c
        h *= delta
        if abs(delta - 1.0) < eps:
            return h
    raise RuntimeError("betacf did not converge (a=%r b=%r x=%r)" % (a, b, x))


def betainc(a, b, x):
    """Regularized incomplete beta I_x(a, b) for a, b > 0."""
    if x <= 0.0:
        return 0.0
    if x >= 1.0:
        return 1.0
    ln_bt = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
             + a * math.log(x) + b * math.log1p(-x))
    bt = math.exp(ln_bt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf(a, b, x) / a
    return 1.0 - bt * _betacf(b, a, 1.0 - x) / b


def beta_ppf(p, a, b):
    """Inverse of I_x(a,b) in x by bisection (I is monotone in x)."""
    lo, hi = 0.0, 1.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            break
        if betainc(a, b, mid) < p:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def clopper_pearson(k, n, conf=0.95):
    """Exact two-sided interval and one-sided upper bound for k/n errors."""
    if n == 0:
        return None
    alpha = 1.0 - conf
    lower = 0.0 if k == 0 else beta_ppf(alpha / 2.0, k, n - k + 1)
    upper = 1.0 if k == n else beta_ppf(1.0 - alpha / 2.0, k + 1, n - k)
    upper1 = 1.0 if k == n else beta_ppf(conf, k + 1, n - k)
    return {
        "k": k,
        "n": n,
        "rate": k / n,
        "two_sided_95_lower": lower,
        "two_sided_95_upper": upper,
        "one_sided_95_upper": upper1,
    }


def _self_test_beta():
    # I_0.5(a, a) = 0.5
    for a in (0.5, 1.0, 3.0, 50.0, 2000.0):
        assert abs(betainc(a, a, 0.5) - 0.5) < 1e-10, a
    # I_x(1, b) = 1 - (1-x)^b ; I_x(a, 1) = x^a
    for x in (1e-6, 0.01, 0.3, 0.9):
        for b in (1.0, 7.0, 5000.0):
            assert abs(betainc(1.0, b, x) - (1.0 - (1.0 - x) ** b)) < 1e-10
            assert abs(betainc(b, 1.0, x) - x ** b) < 1e-10
    # Clopper-Pearson closed forms at the boundaries
    for n in (1, 10, 500, 20000):
        cp = clopper_pearson(0, n)
        assert abs(cp["two_sided_95_upper"] - (1 - 0.025 ** (1 / n))) < 1e-12
        assert abs(cp["one_sided_95_upper"] - (1 - 0.05 ** (1 / n))) < 1e-12
        cp = clopper_pearson(n, n)
        assert abs(cp["two_sided_95_lower"] - 0.025 ** (1 / n)) < 1e-12
    # Coverage identity: at the upper bound P(X <= k) = alpha/2 (binomial cdf
    # computed directly in log space for a mid-size case)
    k, n = 7, 3000
    u = clopper_pearson(k, n)["two_sided_95_upper"]
    cdf = sum(math.exp(math.lgamma(n + 1) - math.lgamma(i + 1)
                       - math.lgamma(n - i + 1) + i * math.log(u)
                       + (n - i) * math.log1p(-u)) for i in range(k + 1))
    assert abs(cdf - 0.025) < 1e-9, cdf


# ---------------------------------------------------------------------------
# Trade-print helpers
# ---------------------------------------------------------------------------

_ISO_RE = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$")


_SECS_CACHE = {}


def parse_created_time(s):
    """Parse ISO time -> (unix ms, unix us).

    ms truncates (does not round) the fraction to 3 digits, short fractions
    are right-padded. us (6 digits) is used only to break same-ms ties.
    """
    m = _ISO_RE.match(s)
    if not m:
        raise ValueError("unparseable created_time %r" % s)
    y, mo, d, hh, mi, ss, frac, tz = m.groups()
    key = (y, mo, d, hh, mi, ss, tz)
    secs = _SECS_CACHE.get(key)
    if secs is None:
        secs = calendar.timegm((int(y), int(mo), int(d), int(hh), int(mi), int(ss), 0, 0, 0))
        if tz and tz != "Z":
            sign = 1 if tz[0] == "+" else -1
            secs -= sign * (int(tz[1:3]) * 3600 + int(tz[4:6]) * 60)
        if len(_SECS_CACHE) > 200000:
            _SECS_CACHE.clear()
        _SECS_CACHE[key] = secs
    frac = (frac or "")
    return (secs * 1000 + int(frac[:3].ljust(3, "0")),
            secs * 1_000_000 + int(frac[:6].ljust(6, "0")))


def _self_test_time():
    assert parse_created_time("1970-01-01T00:00:01.2Z") == (1200, 1_200_000)
    assert parse_created_time("2026-04-01T03:55:00.11547Z")[0] == 1775015700115
    assert parse_created_time("2026-04-01T03:55:00.999999Z")[0] == 1775015700999
    assert parse_created_time("2026-04-01T03:55:00Z")[0] == 1775015700000
    assert parse_created_time("2026-04-01T05:55:00.5+02:00")[0] == 1775015700500


HUNDRED = Decimal(100)


def load_called_side_prints(ticker, side):
    """Return (prints, meta) or (None, None) if no trades file.

    prints: list of (ms, us, file_index, price_cents Decimal, count Decimal)
    for prints whose taker_side matches the called side.
    """
    path = os.path.join(TRADES_DIR, ticker + ".json.gz")
    if not os.path.exists(path):
        return None, None
    with gzip.open(path, "rt") as fh:
        data = json.load(fh)
    want = "yes" if side == "UP" else "no"
    out = []
    meta = {"n_all": 0, "n_side": 0, "block_side": 0, "newest_first": True}
    prev_us = None
    for i, t in enumerate(data.get("trades") or []):
        meta["n_all"] += 1
        if t.get("taker_side") != want:
            continue
        yes = Decimal(t["yes_price_dollars"])
        price = HUNDRED * yes if side == "UP" else HUNDRED - HUNDRED * yes
        ms, us = parse_created_time(t["created_time"])
        if prev_us is not None and us > prev_us:
            meta["newest_first"] = False
        prev_us = us
        out.append((ms, us, i, price, Decimal(t["count_fp"])))
        meta["n_side"] += 1
        if t.get("is_block_trade"):
            meta["block_side"] += 1
    return out, meta


def pick_percentile(sorted_vals, p_percent):
    """Element at floor(p*len), capped at len-1 (integer arithmetic)."""
    n = len(sorted_vals)
    if n == 0:
        return None
    return sorted_vals[min((p_percent * n) // 100, n - 1)]


def dec_out(x):
    return None if x is None else float(x)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    _self_test_beta()
    _self_test_time()

    # ---- markets -----------------------------------------------------------
    markets = {}
    n_lines = 0
    n_null_truth = 0
    for line in open(MARKETS):
        line = line.strip()
        if not line:
            continue
        n_lines += 1
        m = json.loads(line)
        if m.get("truth") is None:
            n_null_truth += 1
            continue
        if m["ticker"] in markets:
            raise RuntimeError("duplicate ticker %s" % m["ticker"])
        markets[m["ticker"]] = {
            "closeTs": m["closeTs"],
            "truth": m["truth"],
            "f120": (m.get("fixed") or {}).get("120"),
        }
    N = len(markets)

    # ---- trace pass 1: first LOCKED / first qualifying ---------------------
    first_locked = {}      # tk -> (tau, side)
    first_qual = {}        # tk -> dict
    first_qual_120 = {}    # tk -> dict (tau <= 120)
    trace_rows = 0
    trace_rows_outside_N = 0
    order_ok = True
    last_tau = {}
    trace_tickers = set()
    any_row_120_25 = {}    # diagnostics: trace row at tau 120.25 / 119.25
    any_row_119_25 = {}
    st_counts = {}
    pf_null_locked = 0

    for line in open(TRACE):
        if not line.strip():
            continue
        r = json.loads(line)
        trace_rows += 1
        tk = r["tk"]
        if tk not in markets:
            trace_rows_outside_N += 1
            continue
        tau = r["tau"]
        st = r["st"]
        st_counts[st] = st_counts.get(st, 0) + 1
        trace_tickers.add(tk)
        prev = last_tau.get(tk)
        if prev is not None and not tau < prev:
            order_ok = False
        last_tau[tk] = tau
        if tau == 120.25:
            any_row_120_25[tk] = (st, r["side"], r["pf"])
        elif tau == 119.25:
            any_row_119_25[tk] = (st, r["side"], r["pf"])
        if not is_locked(st):
            continue
        fl = first_locked.get(tk)
        if fl is None or tau > fl[0]:
            first_locked[tk] = (tau, r["side"])
        pf = r.get("pf")
        if pf is None:
            pf_null_locked += 1
            continue
        if pf <= QUAL_PF:
            row = {"tau": tau, "side": r["side"], "pf": pf, "ts": r["ts"], "st": st}
            fq = first_qual.get(tk)
            if fq is None or tau > fq["tau"]:
                first_qual[tk] = row
            if tau <= 120:
                fq = first_qual_120.get(tk)
                if fq is None or tau > fq["tau"]:
                    first_qual_120[tk] = row

    # ---- trace pass 2: behaviour after the first qualifying row ------------
    after = {tk: {"warned": False, "dirChange": False, "sameSideLocked": 0,
                  "rowsAfter": 0} for tk in first_qual}
    for line in open(TRACE):
        if not line.strip():
            continue
        r = json.loads(line)
        q = first_qual.get(r["tk"])
        if q is None or not r["tau"] < q["tau"]:
            continue
        a = after[r["tk"]]
        a["rowsAfter"] += 1
        st = r["st"]
        if st == WARN_STATE:
            a["warned"] = True
        elif is_locked(st):
            if r["side"] != q["side"]:
                a["dirChange"] = True
            else:
                a["sameSideLocked"] += 1

    # ---- item 1 ------------------------------------------------------------
    c = {k: 0 for k in ("reachLocked", "lockedAtT120", "firstLockedTauLe120",
                        "reachQualifying", "qualifyingAtT120",
                        "firstQualifyingTauLe120", "anyQualifyingTauLe120")}
    for tk, m in markets.items():
        f = m["f120"]
        locked120 = f is not None and is_locked(f.get("st"))
        qual120 = locked120 and f.get("pFlip") is not None and f["pFlip"] <= QUAL_PF
        fl = first_locked.get(tk)
        fq = first_qual.get(tk)
        c["reachLocked"] += fl is not None
        c["lockedAtT120"] += locked120
        c["firstLockedTauLe120"] += fl is not None and fl[0] <= 120
        c["reachQualifying"] += fq is not None
        c["qualifyingAtT120"] += qual120
        c["firstQualifyingTauLe120"] += fq is not None and fq["tau"] <= 120
        c["anyQualifyingTauLe120"] += tk in first_qual_120
    item1 = {"N": N, "counts": c, "percentOfN": {k: pct(v, N) for k, v in c.items()}}

    # ---- item 2 ------------------------------------------------------------
    nQ = len(first_qual)
    wrongQ = cont = warned = dirc = 0
    for tk, q in first_qual.items():
        a = after[tk]
        q["won"] = q["side"] == markets[tk]["truth"]
        q["warned"] = a["warned"]
        q["dirChange"] = a["dirChange"]
        q["sameSideLockedAfter"] = a["sameSideLocked"]
        q["requiredSeconds"] = round_half_up(q["tau"] - 0.25)
        q["continuous"] = (a["sameSideLocked"] >= q["requiredSeconds"]
                           and not a["warned"] and not a["dirChange"])
        wrongQ += not q["won"]
        cont += q["continuous"]
        warned += a["warned"]
        dirc += a["dirChange"]
    item2 = {
        "Q": nQ, "wrong": wrongQ,
        "continuous": cont, "warned": warned, "dirChange": dirc,
        "pctContinuous": pct(cont, nQ), "pctWarned": pct(warned, nQ),
        "pctDirChange": pct(dirc, nQ),
    }

    # ---- item 3 + 4 --------------------------------------------------------
    def wn(rows):
        n = len(rows)
        w = sum(1 for won in rows if not won)
        return {"n": n, "wrong": w, "errorRatePct": pct(w, n)}

    fq_won = [q["won"] for q in first_qual.values()]
    fq120_won = [q["side"] == markets[tk]["truth"] for tk, q in first_qual_120.items()]
    q120_won = []
    l120_won = []
    for tk, m in markets.items():
        f = m["f120"]
        if f is not None and is_locked(f.get("st")):
            l120_won.append(f["side"] == m["truth"])
            if f.get("pFlip") is not None and f["pFlip"] <= QUAL_PF:
                q120_won.append(f["side"] == m["truth"])
    fl_won = [fl[1] == markets[tk]["truth"] for tk, fl in first_locked.items()]

    by_interval = {label: [] for label, _, _ in INTERVALS}
    out_of_range = 0
    for q in first_qual.values():
        label = interval_of(q["tau"])
        q["interval"] = label
        if label is None:
            out_of_range += 1
        else:
            by_interval[label].append(q["won"])

    item3 = {
        "firstQualifying": wn(fq_won),
        "firstQualifyingLast120s": wn(fq120_won),
        "qualifyingAtT120": wn(q120_won),
        "byIntervalOfFirstQualifyingTau": {k: wn(v) for k, v in by_interval.items()},
        "firstQualifyingTauOutsideIntervals": out_of_range,
        "extra_not_requested": {
            "firstLocked": wn(fl_won),
            "lockedAtT120": wn(l120_won),
        },
    }
    cp = lambda rows: clopper_pearson(sum(1 for w in rows if not w), len(rows))
    item4 = {
        "firstQualifying": cp(fq_won),
        "byIntervalOfFirstQualifyingTau": {k: cp(v) for k, v in by_interval.items()},
        "extra_not_requested": {
            "firstQualifyingLast120s": cp(fq120_won),
            "qualifyingAtT120": cp(q120_won),
        },
    }

    # ---- item 5 ------------------------------------------------------------
    months = {}
    for tk, q in first_qual.items():
        mo = datetime.datetime.fromtimestamp(markets[tk]["closeTs"],
                                             tz=datetime.timezone.utc).strftime("%Y-%m")
        e = months.setdefault(mo, {"n": 0, "wrong": 0})
        e["n"] += 1
        e["wrong"] += not q["won"]
    for e in months.values():
        e["errorRatePct"] = pct(e["wrong"], e["n"])
    item5 = dict(sorted(months.items()))

    # ---- item 6 ------------------------------------------------------------
    item6 = sorted(
        ({"ticker": tk, "tau": q["tau"], "side": q["side"], "pf": q["pf"],
          "truth": markets[tk]["truth"], "ts": q["ts"],
          "interval": q["interval"], "continuous": q["continuous"],
          "warned": q["warned"], "dirChange": q["dirChange"]}
         for tk, q in first_qual.items() if not q["won"]),
        key=lambda d: (markets[d["ticker"]]["closeTs"], d["ticker"]))

    # ---- items 7 + 8 -------------------------------------------------------
    with_file = 0
    without_file = 0
    any_prior = 0
    within_le = 0           # ts - print_ms <= 10000  (primary)
    within_lt = 0           # ts - print_ms <  10000  (sensitivity)
    prices_within = []
    prices_any_prior = []
    tie_ambiguous = 0       # last print shares its ms with another called-side
                            # print at a different price
    tie_ambiguous_us = 0    # ... and even its microsecond
    # tie-break sensitivity: alternative choices of "the last print" inside the
    # latest-ms group (all have the same ms, so the 10 s test is unaffected)
    alt_prices = {"largestFileIndexInMsGroup": [], "minPriceInMsGroup": [],
                  "maxPriceInMsGroup": []}
    files_not_newest_first = 0
    caps = []
    caps_by_tk = {}
    block_side_total = 0
    side_prints_total = 0
    empty_files = 0
    for tk, q in first_qual.items():
        prints, meta = load_called_side_prints(tk, q["side"])
        if prints is None:
            without_file += 1
            continue
        with_file += 1
        if meta["n_all"] == 0:
            empty_files += 1
        block_side_total += meta["block_side"]
        files_not_newest_first += not meta["newest_first"]
        side_prints_total += meta["n_side"]
        ts = q["ts"]
        prior = [p for p in prints if p[0] <= ts]
        if prior:
            any_prior += 1
            # latest by ms, then by full microsecond time; among exact
            # duplicates the smaller file index wins (files are newest-first)
            last = max(prior, key=lambda p: (p[0], p[1], -p[2]))
            same_ms = [p for p in prior if p[0] == last[0]]
            if len({p[3] for p in same_ms}) > 1:
                tie_ambiguous += 1
                if len({p[3] for p in same_ms if p[1] == last[1]}) > 1:
                    tie_ambiguous_us += 1
            prices_any_prior.append(last[3])
            gap = ts - last[0]
            if gap <= WINDOW_MS:
                within_le += 1
                prices_within.append(last[3])
                alt_prices["largestFileIndexInMsGroup"].append(
                    max(same_ms, key=lambda p: p[2])[3])
                alt_prices["minPriceInMsGroup"].append(min(p[3] for p in same_ms))
                alt_prices["maxPriceInMsGroup"].append(max(p[3] for p in same_ms))
            if gap < WINDOW_MS:
                within_lt += 1
        dollars = sum((p[3] / HUNDRED * p[4] for p in prints if p[0] > ts), Decimal(0))
        caps.append(dollars)
        caps_by_tk[tk] = dollars

    prices_within.sort()
    prices_any_prior.sort()
    caps.sort()
    item7 = {
        "signalsQ": nQ,
        "signalsWithTradesFile": with_file,
        "signalsWithoutTradesFile": without_file,
        "tradesFilesWithZeroPrints": empty_files,
        "signalsWithAnyCalledSidePrintAtOrBeforeTs": any_prior,
        "signalsWithCalledSidePrintWithin10sBefore": within_le,
        "signalsWithCalledSidePrintWithin10sBefore_strictLt10000ms": within_lt,
        "pctOfSignalsWithFile_within10s": pct(within_le, with_file),
        "percentilesCents_within10s": {
            "p%d" % p: dec_out(pick_percentile(prices_within, p)) for p in PERCENTILES},
        "sensitivity_percentilesCents_anyPriorPrint": {
            "p%d" % p: dec_out(pick_percentile(prices_any_prior, p)) for p in PERCENTILES},
        "signalsWhereLastPrintMsTiesAtDifferentPrices": tie_ambiguous,
        "signalsWhereLastPrintMicrosecondTiesAtDifferentPrices": tie_ambiguous_us,
        "sensitivity_tieBreak_percentilesCents_within10s": {
            name: {"p%d" % p: dec_out(pick_percentile(sorted(v), p)) for p in PERCENTILES}
            for name, v in alt_prices.items()},
        "tradesFilesNotNewestFirstOnCalledSide": files_not_newest_first,
        "calledSidePrintsInFiles": side_prints_total,
        "calledSideBlockTradesInFiles": block_side_total,
    }
    item8 = {
        "signalsWithTradesFile": len(caps),
        "medianCalledSideDollarsAfterSignal": dec_out(
            caps[len(caps) // 2] if caps else None),
        "count_ge_75000": sum(1 for x in caps if x >= CAP_THRESHOLDS[0]),
        "count_ge_10000": sum(1 for x in caps if x >= CAP_THRESHOLDS[1]),
        "pct_ge_75000": pct(sum(1 for x in caps if x >= CAP_THRESHOLDS[0]), len(caps)),
        "pct_ge_10000": pct(sum(1 for x in caps if x >= CAP_THRESHOLDS[1]), len(caps)),
        "count_zero": sum(1 for x in caps if x == 0),
        "quartilesDollars": {"p%d" % p: dec_out(pick_percentile(caps, p))
                             for p in PERCENTILES},
    }
    # wrong signals: attach price/capacity context
    for d in item6:
        d["capacityDollarsAfter"] = dec_out(caps_by_tk.get(d["ticker"]))

    # ---- diagnostics -------------------------------------------------------
    agree_12025 = agree_11925 = 0
    lockedT120 = 0
    for tk, m in markets.items():
        f = m["f120"]
        if f is None or not is_locked(f.get("st")):
            continue
        lockedT120 += 1
        r = any_row_120_25.get(tk)
        if r and is_locked(r[0]) and r[1] == f["side"] and r[2] == f.get("pFlip"):
            agree_12025 += 1
        r = any_row_119_25.get(tk)
        if r and is_locked(r[0]) and r[1] == f["side"] and r[2] == f.get("pFlip"):
            agree_11925 += 1
    diagnostics = {
        "marketLines": n_lines,
        "marketsWithNullTruthExcluded": n_null_truth,
        "traceRows": trace_rows,
        "traceRowsForTickersOutsideN": trace_rows_outside_N,
        "traceTickers": len(trace_tickers),
        "traceStateCounts": st_counts,
        "traceTauStrictlyDecreasingPerTicker": order_ok,
        "lockedTraceRowsWithNullPf": pf_null_locked,
        "fixed120LockedMarkets": lockedT120,
        "fixed120MatchesTraceRowAtTau120.25(st/side/pf)": agree_12025,
        "fixed120MatchesTraceRowAtTau119.25(st/side/pf)": agree_11925,
        "firstQualifyingRowsThatArePROVEN_LOCKED": sum(
            1 for q in first_qual.values() if q["st"] == "PROVEN LOCKED"),
    }

    result = {
        "generatedBy": os.path.basename(__file__),
        "inputs": {"markets": MARKETS, "trace": TRACE, "tradesDir": TRADES_DIR},
        "parameters": {"qualifyingPf": QUAL_PF, "lockedStates": list(LOCKED_STATES),
                       "printWindowMs": WINDOW_MS, "percentiles": list(PERCENTILES),
                       "capacityThresholdsUsd": list(CAP_THRESHOLDS)},
        "item1_reach": item1,
        "item2_firstQualifyingBehaviour": item2,
        "item3_wrongCounts": item3,
        "item4_clopperPearson": item4,
        "item5_byMonthFirstQualifying": item5,
        "item6_wrongFirstQualifying": item6,
        "item7_entryPrices": item7,
        "item8_capacity": item8,
        "diagnostics": diagnostics,
        "interpretationChoices": [
            "Every truth is non-null in this file, so N equals the line count.",
            "'first' row = largest tau satisfying the condition; tau <= 120 is "
            "applied to the row's tau (so 120.25 is excluded, 119.25 is the "
            "first eligible second).",
            "LOCKED at T-120 uses fixed['120'].st in {LOCKED, PROVEN LOCKED}; "
            "fixed['120'].gate is ignored.",
            "continuous: count of LOCKED/PROVEN LOCKED rows after q (tau < q.tau) "
            "with side == q.side >= round(q.tau - 0.25), and not warned, not "
            "dirChange. q.tau - 0.25 is always integral so rounding mode is moot.",
            "created_time parsed to ms by truncating (not rounding) the fraction "
            "to 3 digits; short fractions are right-padded.",
            "'within 10 s before' = 0 <= signal ts - print ms <= 10000 (the strict "
            "< 10000 count is also reported). Percentiles in item 7 are over the "
            "signals that have such a print; percentiles over any prior print are "
            "given as a sensitivity.",
            "Last print ties on the same ms are broken by the microsecond time, "
            "then by the smaller file index (files are newest-first); the number "
            "of signals where a same-ms tie had different prices is reported, "
            "with percentiles under alternative tie-breaks.",
            "All prints with the called taker_side are used, including block trades.",
            "Capacity uses prints with parsed ms > signal ts; signals with a "
            "trades file but no later called-side print count as $0. Denominator "
            "for item 8 percentages is signals with a trades file.",
            "Percentile index uses integer arithmetic floor(p*len/100).",
        ],
    }
    with open(OUT, "w") as fh:
        json.dump(result, fh, indent=2)
    print(json.dumps({k: result[k] for k in (
        "item1_reach", "item2_firstQualifyingBehaviour", "item3_wrongCounts",
        "item4_clopperPearson", "item5_byMonthFirstQualifying", "item7_entryPrices",
        "item8_capacity", "diagnostics")}, indent=1))
    print("wrong first-qualifying:", len(item6))
    for d in item6:
        print(" ", d["ticker"], d["tau"], d["side"], d["pf"], d["truth"])
    print("wrote", OUT)


if __name__ == "__main__":
    sys.exit(main())
