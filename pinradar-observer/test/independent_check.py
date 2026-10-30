#!/usr/bin/env python3
"""Independent verification implementation of the pinradar-observer math.

Written only from the written specification (NOT from lib/ or observer.js),
using the Python 3 standard library only.

Usage:
    python3 independent_check.py math_cases.json independent_results.json

Input : {"fills": [{asks, budgets, rate, outcome}, ...], "binomial": [{k, n}, ...]}
Output: {"fills": [{"sizes": [...], "totalAskDepthUsd": x}, ...],
         "binomial": [{k, n, cpLo, cpHi, upper95, wilsonLo, wilsonHi, post}, ...]}

Numerics
  * Fills ("walk"): all arithmetic is EXACT (fractions.Fraction); input floats
    are converted through their shortest repr (99.7 -> 997/10).  Rounding to
    2 / 4 decimals is exact round-half-away-from-zero; exact ties are reported
    on stderr because the rounding mode is a possible source of disagreement.
  * Binomial: decimal.Decimal at 50 significant digits.  Every Beta quantile is
    computed twice with two unrelated methods and the results are compared:
      A) finite exact formulas: binomial-sum identity for integer (a, b);
         for half-integer (a, b) (Jeffreys) the DLMF 8.17.20/21 recurrences
         started from I_x(1/2,1/2) = (2/pi) asin(sqrt x);
      B) the Lentz continued fraction for I_x(a, b).
    Inversion is safeguarded Newton (bisection fallback) started from a float
    bisection estimate, followed by a bracket check at +-1e-15 relative.
    Output uses method A.
  Diagnostics (A vs B agreement, closed-form checks, rounding ties) go to stderr.
"""
import json
import math
import sys
from decimal import Decimal, getcontext
from fractions import Fraction

PREC = 50
getcontext().prec = PREC

# ----------------------------------------------------------------------------
# generic helpers
# ----------------------------------------------------------------------------

def to_frac(x):
    if isinstance(x, bool):
        raise TypeError("bool is not a number here")
    if isinstance(x, int):
        return Fraction(x)
    if isinstance(x, float):
        return Fraction(repr(x))
    if isinstance(x, str):
        return Fraction(x)
    raise TypeError("unsupported number %r" % (x,))


TIES = []  # (label, exact value as float, places)


def rnd(x, places, label=""):
    """Exact round half away from zero of a Fraction; returns a Fraction."""
    scale = 10 ** places
    q = x * scale
    neg = q < 0
    aq = -q if neg else q
    fl = math.floor(aq)
    frac = aq - fl
    if frac == Fraction(1, 2):
        TIES.append((label, float(x), places))
    r = fl + 1 if frac >= Fraction(1, 2) else fl
    return Fraction(-r if neg else r, scale)


def num(fr):
    """Fraction -> float (correctly rounded), with -0.0 normalised to 0.0."""
    if fr is None:
        return None
    v = float(fr)
    return 0.0 if v == 0 else v


def dec(fr):
    """Fraction -> Decimal at context precision."""
    return Decimal(fr.numerator) / Decimal(fr.denominator)


# ----------------------------------------------------------------------------
# A) theoretical purchase ("walk")
# ----------------------------------------------------------------------------

EPS = Fraction(1, 10 ** 9)
STEP = Fraction(1, 100)


def fee_usd(rate, p_cents, n):
    """ceil(rate * C * P * (1-P) * 100 - 1e-9) / 100 dollars, P = p/100."""
    P = p_cents / 100
    raw = rate * n * P * (1 - P) * 100 - EPS
    return Fraction(math.ceil(raw), 100)


def walk(asks, budget, rate):
    spent = Fraction(0)
    cost = Fraction(0)
    fees = Fraction(0)
    contracts = Fraction(0)
    worst = None          # index into asks of the last level bought from
    levels = 0
    stopped = None
    per_level = []        # (index, n) for cross-checking
    for idx, (p, size) in enumerate(asks):
        unit = p / 100
        n = min(size, math.floor(((budget - spent) / unit) / STEP) * STEP)
        while n > 0 and spent + n * unit + fee_usd(rate, p, n) > budget + EPS:
            n -= STEP
        if n <= 0:
            stopped = "budget"
            break
        f = fee_usd(rate, p, n)
        spent += n * unit + f
        fees += f
        contracts += n
        cost += n * unit
        worst = idx
        levels += 1
        per_level.append((idx, n))
        if n < size - EPS:
            stopped = "budget"
            break
    else:
        stopped = "book"
    return dict(spent=spent, cost=cost, fees=fees, contracts=contracts,
                worst=worst, levels=levels, stopped=stopped, per_level=per_level)


def walk_alt(asks, budget, rate):
    """Cross-check: same rule, but each level's quantity is found as the
    LARGEST grid quantity <= min(size, budget-limited) that fits, by binary
    search over integer hundredths (valid because n*unit + fee(n) is
    non-decreasing in n).  Must agree exactly with walk()."""
    spent = Fraction(0)
    out = []
    for idx, (p, size) in enumerate(asks):
        unit = p / 100
        hi_c = math.floor(min(size, ((budget - spent) / unit)) * 100)
        if size * 100 != math.floor(size * 100):
            return None  # off-grid size: binary-search form not applicable
        fits = lambda c: spent + Fraction(c, 100) * unit + fee_usd(rate, p, Fraction(c, 100)) <= budget + EPS
        lo_c = 0
        if hi_c <= 0 or not fits(1):
            break
        lo_c = 1
        while lo_c < hi_c:
            mid = (lo_c + hi_c + 1) // 2
            if fits(mid):
                lo_c = mid
            else:
                hi_c = mid - 1
        n = Fraction(lo_c, 100)
        spent += n * unit + fee_usd(rate, p, n)
        out.append((idx, n))
        if n < size - EPS:
            break
    return out


def fill_case(case, ci, problems):
    asks_raw = case.get("asks") or []
    asks = [(to_frac(p), to_frac(s)) for p, s in asks_raw]
    for i in range(1, len(asks)):
        if asks[i][0] < asks[i - 1][0]:
            problems.append("fills[%d]: asks not sorted ascending" % ci)
    rate = to_frac(case["rate"])
    outcome = case.get("outcome")
    sizes = []
    total_size = sum((s for _, s in asks), Fraction(0))
    for budget_raw in case["budgets"]:
        budget = to_frac(budget_raw)
        w = walk(asks, budget, rate)
        lab = "fills[%d] budget=%s" % (ci, budget_raw)

        # ---- invariants / cross-checks (diagnostics only)
        alt = walk_alt(asks, budget, rate)
        if alt is not None and alt != w["per_level"]:
            problems.append(lab + ": walk vs binary-search walk disagree")
        if w["spent"] > budget:
            problems.append(lab + ": spent exceeds budget")
        if w["spent"] != w["cost"] + w["fees"]:
            problems.append(lab + ": spent != cost + fees")
        if w["stopped"] == "book" and w["contracts"] != total_size:
            problems.append(lab + ": stopped by book but book not fully bought")
        for _, n in w["per_level"]:
            if n * 100 != math.floor(n * 100):
                problems.append(lab + ": quantity off the 0.01 grid")

        contracts_r = rnd(w["contracts"], 2, lab + " contracts")
        cost_r = rnd(w["cost"], 2, lab + " costUsd")
        fees_r = rnd(w["fees"], 2, lab + " feesUsd")
        cap_r = rnd(w["spent"], 2, lab + " capitalUsd")
        avg = None
        if w["contracts"] > 0:
            avg = rnd(100 * w["cost"] / w["contracts"], 4, lab + " avgPriceCents")
        worst = None if w["worst"] is None else asks_raw[w["worst"]][0]
        fully = bool(w["contracts"] > 0 and w["stopped"] == "budget")
        unfilled = rnd(budget - cap_r, 2, lab + " unfilledUsd")
        payout = contracts_r
        net_win = payout - cap_r
        net_loss = -cap_r
        if outcome is None:
            net = None
        else:
            net = net_win if outcome else net_loss
        if outcome is None or cap_r == 0:
            ret = None
        else:
            ret = rnd(100 * net / cap_r, 4, lab + " returnPct")
        sizes.append({
            "budgetUsd": budget_raw,
            "contracts": num(contracts_r),
            "costUsd": num(cost_r),
            "feesUsd": num(fees_r),
            "capitalUsd": num(cap_r),
            "avgPriceCents": num(avg),
            "worstPriceCents": worst,
            "levelsUsed": w["levels"],
            "stoppedBy": w["stopped"],
            "fullyFillable": fully,
            "unfilledUsd": num(unfilled),
            "payoutIfWinUsd": num(payout),
            "netIfWinUsd": num(net_win),
            "netIfLossUsd": num(net_loss),
            "netUsd": num(net),
            "returnPct": num(ret),
        })
    depth = sum((p / 100 * s for p, s in asks), Fraction(0))
    return {"sizes": sizes,
            "totalAskDepthUsd": num(rnd(depth, 2, "fills[%d] totalAskDepthUsd" % ci))}


# ----------------------------------------------------------------------------
# B) Beta functions in Decimal
# ----------------------------------------------------------------------------

PI = Decimal("3.14159265358979323846264338327950288419716939937510"
             "58209749445923078164062862089986280348253421170679")
LN2 = Decimal(2).ln()
LNPI = PI.ln()
HALF = Fraction(1, 2)

_lnfact_cache = {}


def ln_bigint(N):
    """ln of a positive (possibly huge) integer, to ~PREC digits."""
    s = max(0, N.bit_length() - 340)
    return Decimal(N >> s).ln() + s * LN2


def lnfact(m):
    if m not in _lnfact_cache:
        _lnfact_cache[m] = Decimal(0) if m < 2 else ln_bigint(math.factorial(m))
    return _lnfact_cache[m]


def lngamma_2(a2):
    """ln Gamma(a2 / 2) for a positive integer a2 (integer or half-integer a)."""
    if a2 % 2 == 0:
        return lnfact(a2 // 2 - 1)
    m = (a2 - 1) // 2        # a = m + 1/2: Gamma = (2m)! sqrt(pi) / (4^m m!)
    return lnfact(2 * m) - lnfact(m) - (2 * m) * LN2 + LNPI / 2


_lnbeta_cache = {}


def lnbeta(a, b):
    key = (a, b)
    if key not in _lnbeta_cache:
        a2, b2 = 2 * a, 2 * b
        if a2.denominator != 1 or b2.denominator != 1 or a <= 0 or b <= 0:
            raise ValueError("only positive integer / half-integer parameters supported")
        a2, b2 = int(a2), int(b2)
        _lnbeta_cache[key] = lngamma_2(a2) + lngamma_2(b2) - lngamma_2(a2 + b2)
    return _lnbeta_cache[key]


def d_atan(y):
    """arctan for Decimal y >= 0."""
    if y == 0:
        return Decimal(0)
    if y > 1:
        return PI / 2 - d_atan(1 / y)
    k = 0
    small = Decimal("0.001")
    while y > small:
        y = y / (1 + (1 + y * y).sqrt())
        k += 1
    y2 = y * y
    term = y
    s = y
    i = 1
    eps = Decimal(10) ** (-(PREC + 5))
    while True:
        term = -term * y2
        i += 2
        t = term / i
        s += t
        if abs(t) <= eps * abs(s):
            break
    return s * (2 ** k)


def asin_sqrt(x):
    """asin(sqrt(x)) for Decimal 0 <= x <= 1."""
    if x <= Decimal("0.5"):
        return d_atan((x / (1 - x)).sqrt())
    return PI / 2 - d_atan(((1 - x) / x).sqrt())


# ---- method A: finite exact formulas

def I_int(a, b, x):
    """I_x(a,b) for integer a,b >= 1:  P(Binomial(a+b-1, x) >= a)."""
    a, b = int(a), int(b)
    if x <= 0:
        return Decimal(0)
    if x >= 1:
        return Decimal(1)
    n = a + b - 1
    y = 1 - x
    if a <= b:
        t = y ** n                 # j = 0 term
        s = t
        r = x / y
        for j in range(0, a - 1):  # produce terms j+1 = 1 .. a-1
            t = t * (n - j) / (j + 1) * r
            s += t
        return 1 - s
    t = x ** n                     # j = n term
    s = t
    r = y / x
    for j in range(n, a, -1):      # produce terms j-1 = n-1 .. a
        t = t * j / (n - j + 1) * r
        s += t
    return s


def I_halfhalf(a, b, x):
    """I_x(a,b) for a, b both half-odd-integers, via DLMF 8.17.20/8.17.21:
       I(a,b+1) = I(a,b) + u(a,b)/b ;  I(a+1,b) = I(a,b) - u(a,b)/a,
       u(a,b) = x^a (1-x)^b / B(a,b),  I(1/2,1/2) = (2/pi) asin(sqrt x)."""
    if x <= 0:
        return Decimal(0)
    if x >= 1:
        return Decimal(1)
    ka = int(a - HALF)
    kb = int(b - HALF)
    y = 1 - x
    I = 2 * asin_sqrt(x) / PI
    u = (x * y).sqrt() / PI       # u(1/2, 1/2), since B(1/2,1/2) = pi
    ca = Decimal("0.5")
    cb = Decimal("0.5")
    for _ in range(kb):
        I += u / cb
        u = u * y * (ca + cb) / cb
        cb += 1
    for _ in range(ka):
        I -= u / ca
        u = u * x * (ca + cb) / ca
        ca += 1
    return I


def I_exact(a, b, x):
    if a.denominator == 1 and b.denominator == 1:
        return I_int(a, b, x)
    if a.denominator == 2 and b.denominator == 2:
        return I_halfhalf(a, b, x)
    raise ValueError("mixed integer/half-integer parameters not supported")


# ---- method B: continued fraction (modified Lentz)

def _betacf(a, b, x):
    fpmin = Decimal("1e-300")
    tol = Decimal("1e-46")
    qab = a + b
    qap = a + 1
    qam = a - 1
    c = Decimal(1)
    d = 1 - qab * x / qap
    if abs(d) < fpmin:
        d = fpmin
    d = 1 / d
    h = d
    for m in range(1, 200000):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < fpmin:
            d = fpmin
        c = 1 + aa / c
        if abs(c) < fpmin:
            c = fpmin
        d = 1 / d
        de = d * c
        h *= de
        if abs(de - 1) < tol:
            return h
    raise RuntimeError("continued fraction did not converge")


def I_cf(a, b, x):
    if x <= 0:
        return Decimal(0)
    if x >= 1:
        return Decimal(1)
    A, B = dec(a), dec(b)
    bt = (A * x.ln() + B * (1 - x).ln() - lnbeta(a, b)).exp()
    if x < (A + 1) / (A + B + 2):
        return bt * _betacf(A, B, x) / A
    return 1 - bt * _betacf(B, A, 1 - x) / B


# ---- float estimate (starting point only)

def _betacf_f(a, b, x):
    fpmin = 1e-300
    qab, qap, qam = a + b, a + 1.0, a - 1.0
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
        d = fpmin if abs(d) < fpmin else d
        c = 1.0 + aa / c
        c = fpmin if abs(c) < fpmin else c
        d = 1.0 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1.0 + aa * d
        d = fpmin if abs(d) < fpmin else d
        c = 1.0 + aa / c
        c = fpmin if abs(c) < fpmin else c
        d = 1.0 / d
        de = d * c
        h *= de
        if abs(de - 1.0) < 1e-15:
            break
    return h


def I_float(a, b, x):
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    lbt = (math.lgamma(a + b) - math.lgamma(a) - math.lgamma(b)
           + a * math.log(x) + b * math.log1p(-x))
    bt = math.exp(lbt)
    if x < (a + 1.0) / (a + b + 2.0):
        return bt * _betacf_f(a, b, x) / a
    return 1.0 - bt * _betacf_f(b, a, 1.0 - x) / b


def inv_float(a, b, q):
    lo, hi = 0.0, 1.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if mid == lo or mid == hi:
            break
        if I_float(a, b, mid) < q:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ---- inversion

def beta_quantile(a, b, q, Ifunc):
    """x with I_x(a,b) = q (a, b Fractions, q Decimal)."""
    A, B = dec(a), dec(b)
    lb = lnbeta(a, b)
    x0 = inv_float(float(a), float(b), float(q))
    lo, hi = Decimal(0), Decimal(1)
    x = Decimal(repr(x0)) if 0 < x0 < 1 else Decimal("0.5")
    result = None
    for _ in range(400):
        f = Ifunc(a, b, x) - q
        if f == 0:
            result = x
            break
        if f > 0:
            hi = x
        else:
            lo = x
        pdf = ((A - 1) * x.ln() + (B - 1) * (1 - x).ln() - lb).exp()
        xn = x - f / pdf
        if not (lo < xn < hi):
            xn = (lo + hi) / 2
        if abs(xn - x) <= abs(x) * Decimal("1e-38"):
            result = xn
            break
        x = xn
    if result is None:
        raise RuntimeError("quantile did not converge a=%s b=%s q=%s" % (a, b, q))
    # bracket verification at +-1e-15 relative
    r = Decimal("1e-15")
    if not (Ifunc(a, b, result * (1 - r)) < q < Ifunc(a, b, result * (1 + r))):
        raise RuntimeError("bracket check failed a=%s b=%s q=%s" % (a, b, q))
    return result


QCHECK = []   # (label, a, b, q, xA, xB)


def quantile(a, b, qstr, label):
    q = Decimal(qstr)
    xa = beta_quantile(a, b, q, I_exact)
    xb = beta_quantile(a, b, q, I_cf)
    QCHECK.append((label, a, b, q, xa, xb))
    return xa


def binomial_case(case):
    k = int(case["k"])
    n = int(case["n"])
    if not (0 <= k <= n and n >= 1):
        raise ValueError("bad binomial case %r" % (case,))
    K, N = Fraction(k), Fraction(n)
    lab = "k=%d n=%d" % (k, n)
    cp_lo = Decimal(0) if k == 0 else quantile(K, N - K + 1, "0.025", lab + " cpLo")
    cp_hi = Decimal(1) if k == n else quantile(K + 1, N - K, "0.975", lab + " cpHi")
    up95 = Decimal(1) if k == n else quantile(K + 1, N - K, "0.95", lab + " upper95")

    z = Decimal("1.959963984540054")
    z2 = z * z
    nd = Decimal(n)
    p = Decimal(k) / nd
    denom = 1 + z2 / nd
    center = (p + z2 / (2 * nd)) / denom
    half = z * (p * (1 - p) / nd + z2 / (4 * nd * nd)).sqrt() / denom
    w_lo = Decimal(0) if k == 0 else max(Decimal(0), center - half)
    w_hi = Decimal(1) if k == n else min(Decimal(1), center + half)

    priors = [("uniform", Fraction(1), Fraction(1)),
              ("jeffreys", HALF, HALF),
              ("modelClaim02pct", Fraction(2), Fraction(998)),
              ("pessimistic1pct", Fraction(10), Fraction(990))]
    post = {}
    for name, pa, pb in priors:
        a, b = pa + K, pb + N - K
        post[name] = {
            "mean": float(a / (a + b)),
            "lo95": float(quantile(a, b, "0.025", lab + " " + name + " lo95")),
            "hi95": float(quantile(a, b, "0.975", lab + " " + name + " hi95")),
        }
    return {"k": k, "n": n,
            "cpLo": float(cp_lo), "cpHi": float(cp_hi), "upper95": float(up95),
            "wilsonLo": float(w_lo), "wilsonHi": float(w_hi),
            "post": post}


# ----------------------------------------------------------------------------
# diagnostics
# ----------------------------------------------------------------------------

def closed_form_checks(binom_out):
    """Return list of (label, computed, closed form, rel. diff)."""
    rows = []

    def pw(base, e):  # base^e in Decimal, e a Fraction
        return (dec(e) * Decimal(base).ln()).exp()

    for r in binom_out:
        k, n = r["k"], r["n"]
        N = Fraction(n)
        if k == 0:
            rows.append(("k=0 n=%d cpHi = 1-0.025^(1/n)" % n, r["cpHi"], 1 - pw("0.025", 1 / N)))
            rows.append(("k=0 n=%d upper95 = 1-0.05^(1/n)" % n, r["upper95"], 1 - pw("0.05", 1 / N)))
        if k == n:
            rows.append(("k=n=%d cpLo = 0.025^(1/n)" % n, r["cpLo"], pw("0.025", 1 / N)))
    # every quantile with a == 1 or b == 1 has a closed form:
    #   Beta(1,b): 1-(1-q)^(1/b);   Beta(a,1): q^(1/a)
    for label, a, b, q, xa, xb in QCHECK:
        if a == 1:
            rows.append((label + " [Beta(1,b) closed form]", float(xa), 1 - pw(1 - q, 1 / b)))
        if b == 1:
            rows.append((label + " [Beta(a,1) closed form]", float(xa), pw(q, 1 / a)))
    out = []
    for lab, got, want in rows:
        want_f = float(want)
        rel = abs(got - want_f) / abs(want_f) if want_f != 0 else abs(got)
        out.append((lab, got, want_f, rel))
    return out


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: %s cases.json results.json\n" % sys.argv[0])
        sys.exit(2)
    with open(sys.argv[1]) as fh:
        cases = json.load(fh)

    problems = []
    fills_out = [fill_case(c, i, problems) for i, c in enumerate(cases.get("fills", []))]
    binom_out = [binomial_case(c) for c in cases.get("binomial", [])]

    with open(sys.argv[2], "w") as fh:
        json.dump({"fills": fills_out, "binomial": binom_out}, fh, indent=1)
        fh.write("\n")

    err = sys.stderr
    err.write("wrote %s: %d fill cases, %d binomial cases\n"
              % (sys.argv[2], len(fills_out), len(binom_out)))
    err.write("fill invariant/cross-check problems: %d\n" % len(problems))
    for p in problems:
        err.write("  PROBLEM " + p + "\n")
    err.write("exact rounding ties (half-away-from-zero applied): %d\n" % len(TIES))
    for t in TIES:
        err.write("  TIE %s exact=%r places=%d\n" % t)

    worst = max(((abs(xa - xb) / xa if xa != 0 else abs(xb)), lab)
                for lab, a, b, q, xa, xb in QCHECK) if QCHECK else (0, "")
    err.write("beta quantiles: %d computed twice; max rel diff finite-formula vs "
              "continued-fraction = %.3e (%s)\n" % (len(QCHECK), float(worst[0]), worst[1]))
    cf = closed_form_checks(binom_out)
    mx = max((r[3] for r in cf), default=0.0)
    err.write("closed-form checks: %d, max rel diff = %.3e\n" % (len(cf), mx))
    for lab, got, want, rel in cf:
        err.write("  %-55s got=%.17g closed=%.17g rel=%.2e\n" % (lab, got, want, rel))
    if problems or float(worst[0]) > 1e-12 or mx > 1e-12:
        err.write("SELF-CHECK FAILED\n")
        sys.exit(1)
    err.write("self-checks OK\n")


if __name__ == "__main__":
    main()
