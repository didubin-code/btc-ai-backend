"""Out-of-sample test of an EXPLORATORY finding: first-LOCKED calls made right after a volatility jump (realised 1-s volatility in the last 60 s
at least 2x that of the 240 s before) were wrong 5 / 630 times on unseen contracts, against 23 / 16,143 otherwise (supplement.py, found on U).
Here the same rule, unchanged, is scored on data it was not found on: the seen contract period (BTCUSDC feed) and the 27-month proxy study
(Binance BTCUSDT, proxy outcomes). The threshold 2.0 is fixed in advance; nothing is tuned.
  python3 volchange.py --records replay.ndjson --sec-dir sec/usdc [--from-ts T --to-ts T] --out out.json"""
import argparse, datetime, json, math, os
import numpy as np


def lchoose(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def fisher(a, b, c, d):
    r1, r2, c1, n = a + b, c + d, a + c, a + b + c + d
    pf = lambda x: math.exp(lchoose(r1, x) + lchoose(r2, c1 - x) - lchoose(n, c1))
    p0 = pf(a)
    return round(min(1.0, sum(pf(x) for x in range(max(0, c1 - r2), min(r1, c1) + 1) if pf(x) <= p0 * (1 + 1e-9))), 5)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', required=True)
    ap.add_argument('--sec-dir', required=True)
    ap.add_argument('--from-ts', type=float, default=-1e18)
    ap.add_argument('--to-ts', type=float, default=1e18)
    ap.add_argument('--thr', type=float, default=2.0)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    cache = {}

    def arr(day):
        if day not in cache:
            fn = os.path.join(a.sec_dir, day + '.f64')
            cache[day] = np.fromfile(fn, dtype='<f8') if os.path.exists(fn) else None
            if len(cache) > 6:
                cache.pop(next(iter(cache)))
        return cache[day]

    def seg(t0, t1):
        d0 = datetime.datetime.fromtimestamp(t0, datetime.timezone.utc).strftime('%Y-%m-%d')
        d1 = datetime.datetime.fromtimestamp(t1 - 1, datetime.timezone.utc).strftime('%Y-%m-%d')
        base = int(datetime.datetime.strptime(d0, '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc).timestamp())
        x = arr(d0)
        if x is None:
            return None
        if d0 == d1:
            return x[t0 - base:t1 - base]
        y = arr(d1)
        if y is None:
            return None
        return np.concatenate([x[t0 - base:], y[:t1 - base - 86400]])

    hi = lo = khi = klo = 0
    for l in open(a.records):
        r = json.loads(l)
        f = r.get('firstLocked')
        if not f or r.get('truth') not in ('UP', 'DOWN') or not (a.from_ts <= r['closeTs'] < a.to_ts):
            continue
        t = int(r['closeTs'] - f['tau'] - 0.75)
        p = seg(t - 300, t + 1)
        if p is None or len(p) != 301:
            continue
        d = np.diff(p)
        if np.isfinite(d[-60:]).sum() <= 50 or np.isfinite(d[:-60]).sum() <= 200:
            continue
        v0 = np.nanstd(d[:-60])
        if not v0 > 0:
            continue
        jump = np.nanstd(d[-60:]) / v0 >= a.thr
        w = not f['correct']
        if jump:
            hi += 1
            khi += w
        else:
            lo += 1
            klo += w
    res = {'thr': a.thr, 'jump': [khi, hi, round(100 * khi / hi, 4) if hi else None], 'rest': [klo, lo, round(100 * klo / lo, 4) if lo else None],
           'ratio': round((khi / hi) / (klo / lo), 2) if hi and lo and klo else None, 'fisherP': fisher(khi, hi - khi, klo, lo - klo) if hi and lo else None,
           'shareOfCallsFlagged': round(100 * hi / (hi + lo), 2) if hi + lo else None}
    json.dump(res, open(a.out, 'w'), indent=1)
    print(json.dumps(res))


if __name__ == '__main__':
    main()
