"""Scores replay_chrono.js records (one JSON line per window). Exact Clopper-Pearson intervals; results by split, direction, time of
the first LOCKED, cushion, volatility regime, month; fixed-time LOCKED accuracy; reversals after LOCKED; missed opportunities.
  python3 analyze.py --records out.ndjson [--splits 'name|fromISO|toISO,...'] --out summary.json"""
import argparse, collections, datetime, json, math


def logc(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def cdf(k, n, p):
    if k < 0:
        return 0.0
    if k >= n or p <= 0:
        return 1.0
    if p >= 1:
        return 0.0
    return min(1.0, sum(math.exp(logc(n, i) + i * math.log(p) + (n - i) * math.log1p(-p)) for i in range(k + 1)))


def bis(f, lo=0.0, hi=1.0):
    for _ in range(200):
        m = (lo + hi) / 2
        lo, hi = (lo, m) if f(m) else (m, hi)
    return (lo + hi) / 2


def cp(k, n, conf=0.95):
    if n == 0:
        return None
    a = (1 - conf) / 2
    lo = 0.0 if k == 0 else bis(lambda p: 1 - cdf(k - 1, n, p) >= a)
    hi = 1.0 if k >= n else bis(lambda p: cdf(k, n, p) <= a)
    up1 = 1.0 if k >= n else bis(lambda p: cdf(k, n, p) <= 1 - conf)
    return {'k': k, 'n': n, 'ratePct': round(100 * k / n, 4), 'ci95Pct': [round(100 * lo, 4), round(100 * hi, 4)], 'upper95OneSidedPct': round(100 * up1, 4)}


def bucket(x, edges):
    for e in edges:
        if x < e:
            return '<%g' % e
    return '>=%g' % edges[-1]


def summarize(rs):
    scored = [r for r in rs if r.get('truth') in ('UP', 'DOWN')]
    fl = [r for r in scored if r.get('firstLocked')]
    wrong = [r for r in fl if not r['firstLocked']['correct']]
    by = lambda key: {k: cp(sum(1 for r in v if not r['firstLocked']['correct']), len(v)) for k, v in sorted(group(fl, key).items())}
    out = {'windows': len(scored), 'firstLocked': cp(len(wrong), len(fl)), 'coveragePct': round(100 * len(fl) / len(scored), 2) if scored else None,
           'wrong': [{'ticker': r['ticker'], 'tau': r['firstLocked']['tau'], 'side': r['firstLocked']['side'], 'margin': r['marginUsd'],
                      'pFlip': r['firstLocked']['pFlip'], 'cushion': r['firstLocked']['cushionSigma'], 'momentum': r['firstLocked']['momentum']} for r in wrong],
           'byDirection': by(lambda r: r['firstLocked']['side']),
           'byFirstLockedTau': by(lambda r: bucket(r['firstLocked']['tau'], [15, 30, 60, 90, 120, 180, 301])),
           'byCushionSigma': by(lambda r: bucket(r['firstLocked']['cushionSigma'] or 0, [3, 4, 5, 7, 10])),
           'byVolBucket': by(lambda r: str(r['firstLocked']['bucket'])),
           'byMonth': by(lambda r: datetime.datetime.fromtimestamp(r['closeTs'], datetime.timezone.utc).strftime('%Y-%m')),
           'reversalWarningAfterLocked': sum(1 for r in fl if r.get('reversalAfterLocked')),
           'reversalWarningsOnCorrectCalls': sum(1 for r in fl if r.get('reversalAfterLocked') and r['firstLocked']['correct']),
           'fixedTime': {}, 'missed': {}}
    for T in ['120', '90', '60', '45', '30', '20', '15', '10', '5', '3']:
        c = [r['fixed'][T] for r in scored if r['fixed'].get(T) and r['fixed'][T]['st'] in ('LOCKED', 'PROVEN LOCKED')]
        out['fixedTime'][T] = cp(sum(1 for x in c if not x['correct']), len(c)) if c else None
    never = [r for r in scored if not r.get('firstLocked')]
    out['missed'] = {'neverLocked': len(never), 'neverLockedByAbsMargin': dict(collections.Counter(bucket(abs(r['marginUsd'] or 0), [5, 20, 50, 100]) for r in never)),
                     'dataUnreliableWindows': sum(1 for r in scored if r.get('dataUnreliable'))}
    return out


def group(rs, key):
    g = collections.defaultdict(list)
    for r in rs:
        g[key(r)].append(r)
    return g


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--records', required=True)
    p.add_argument('--splits', default='')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    rs = [json.loads(l) for l in open(a.records) if l.strip()]
    res = {'all': summarize(rs)}
    for s in filter(None, a.splits.split(',')):
        name, f, t = s.split('|')
        tf, tt = datetime.datetime.fromisoformat(f).timestamp(), datetime.datetime.fromisoformat(t).timestamp()
        res[name] = summarize([r for r in rs if tf <= r['closeTs'] < tt])
    json.dump(res, open(a.out, 'w'), indent=1)
    a0 = res['all']
    print(json.dumps({'windows': a0['windows'], 'firstLocked': a0['firstLocked'], 'fixed20': a0['fixedTime'].get('20'), 'wrong': len(a0['wrong'])}))


if __name__ == '__main__':
    main()
