"""Calibration of the engine's flip probability at fixed times before the close, from replay records (outcomes used for scoring only).
For each fixed time T and each split: among windows whose call at T has pFlip <= 0.5 % (the LOCKED region), expected failures = sum of pFlip,
observed = calls on the wrong side. Ratio observed / expected > 1 means the engine is over-confident there. 95 % interval for the observed
count: exact Poisson (Garwood), divided by the expected count.
  python3 calibration.py --records replay.ndjson [--records2 ...] --out calib.json"""
import argparse, json, math

U2_END, U1_START = 1784678400, 1791936000


def pois_ci(k, a=0.05):
    # Garwood exact interval via the chi-square / gamma relation, solved by bisection on the Poisson CDF
    def cdf(k, m):
        return sum(math.exp(-m + i * math.log(m) - math.lgamma(i + 1)) for i in range(k + 1)) if m > 0 else 1.0
    lo = 0.0
    if k > 0:
        a_, b_ = 0.0, k
        for _ in range(100):
            m = (a_ + b_) / 2
            a_, b_ = (m, b_) if 1 - cdf(k - 1, m) < a / 2 else (a_, m)
        lo = a_
    a_, b_ = k, k + 10 + 10 * math.sqrt(k + 1)
    for _ in range(100):
        m = (a_ + b_) / 2
        a_, b_ = (m, b_) if cdf(k, m) > a / 2 else (a_, m)
    return lo, b_


def calib(recs, cap=0.005):
    out = {}
    for T in ('120', '90', '60', '45', '30', '20', '15', '10', '5', '3'):
        xs = [(r['fixed'][T]['pFlip'], r['fixed'][T]['side'] != r['truth']) for r in recs if r['fixed'].get(T) and r['fixed'][T].get('pFlip') is not None and r['fixed'][T]['pFlip'] <= cap]
        exp = sum(p for p, _ in xs)
        obs = sum(1 for _, w in xs if w)
        lo, hi = pois_ci(obs)
        out[T] = {'calls': len(xs), 'expectedFailures': round(exp, 3), 'observed': obs, 'ratio': round(obs / exp, 2) if exp > 0 else None,
                  'ratioCi95': [round(lo / exp, 2), round(hi / exp, 2)] if exp > 0 else None}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', action='append', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    res = {}
    for fn in a.records:
        recs = [json.loads(l) for l in open(fn)]
        recs = [r for r in recs if r.get('truth') in ('UP', 'DOWN')]
        name = fn.rsplit('/', 1)[-1].replace('.ndjson', '')
        res[name] = {'U (U1+U2)': calib([r for r in recs if r['closeTs'] < U2_END or r['closeTs'] >= U1_START]),
                     'seen': calib([r for r in recs if U2_END <= r['closeTs'] < U1_START]), 'all': calib(recs)}
        for sp, v in res[name].items():
            print('%-16s %-10s ' % (name, sp) + '  '.join('T%s %d/%.1f=%s' % (T, x['observed'], x['expectedFailures'], x['ratio']) for T, x in v.items()))
    json.dump(res, open(a.out, 'w'), indent=1)


if __name__ == '__main__':
    main()
