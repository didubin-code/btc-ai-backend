"""Which observable features at the first LOCKED second predict that the call is wrong? (Phase 3 / 4 of the validation.)
Reads replay records; outcome used for scoring only. Groups: direction, time left, cushion, volatility regime, ADVERSE momentum (the engine's
momentum ratio r signed against the call: r for a DOWN call, -r for an UP call; >= 1 means the price was moving against the call), required move.
Also: REVERSAL WARNING after the call on wrong and on correct calls, and a two-way split of the wrong calls by settlement margin.
Fisher's exact test (two-sided) for direction and for adverse momentum >= 1 vs < 1.
  python3 anatomy.py --records replay.ndjson --out anatomy.json"""
import argparse, json, math

U2_END, U1_START = 1784678400, 1791936000


def lchoose(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def fisher(a, b, c, d):
    """two-sided Fisher exact p for [[a, b], [c, d]] (a = wrong in group 1, b = right in group 1, ...)."""
    r1, r2, c1, n = a + b, c + d, a + c, a + b + c + d
    pf = lambda x: math.exp(lchoose(r1, x) + lchoose(r2, c1 - x) - lchoose(n, c1))
    p0 = pf(a)
    return min(1.0, sum(pf(x) for x in range(max(0, c1 - r2), min(r1, c1) + 1) if pf(x) <= p0 * (1 + 1e-9)))


def grp(calls, key, edges):
    out = {}
    for lo, hi in zip(edges[:-1], edges[1:]):
        xs = [c for c in calls if key(c) is not None and lo <= key(c) < hi]
        k = sum(1 for c in xs if not c['correct'])
        out['[%g, %g)' % (lo, hi)] = {'n': len(xs), 'wrong': k, 'ratePct': round(100 * k / len(xs), 3) if xs else None}
    return out


def analyse(recs):
    calls = []
    for r in recs:
        f = r.get('firstLocked')
        if not f or f.get('correct') is None:
            continue
        m = f.get('momentum')
        adv = None if m is None else (m if f['side'] == 'DOWN' else -m)
        calls.append({**f, 'adv': adv, 'margin': r['marginUsd'], 'rev': r.get('reversalAfterLocked')})
    W = [c for c in calls if not c['correct']]
    up = [c for c in calls if c['side'] == 'UP']
    dn = [c for c in calls if c['side'] == 'DOWN']
    a1 = [c for c in calls if c['adv'] is not None and c['adv'] >= 1]
    a0 = [c for c in calls if c['adv'] is not None and c['adv'] < 1]
    wk = lambda xs: sum(1 for c in xs if not c['correct'])
    res = {
        'calls': len(calls), 'wrong': len(W),
        'direction': {'UP': [wk(up), len(up)], 'DOWN': [wk(dn), len(dn)], 'fisherP': round(fisher(wk(dn), len(dn) - wk(dn), wk(up), len(up) - wk(up)), 4)},
        'adverseMomentum': {'>=1 (moving against the call)': [wk(a1), len(a1)], '<1': [wk(a0), len(a0)],
                            'fisherP': round(fisher(wk(a1), len(a1) - wk(a1), wk(a0), len(a0) - wk(a0)), 4) if a1 and a0 else None,
                            'byBucket': grp(calls, lambda c: c['adv'], [-1e9, -2, -1, 0, 1, 2, 1e9])},
        'secondsLeft': grp(calls, lambda c: c['tau'], [0, 15, 30, 60, 120, 301]),
        'cushionSigma': grp(calls, lambda c: c['cushionSigma'], [0, 3, 4, 5, 7, 1e9]),
        'volBucket': grp(calls, lambda c: c['bucket'], [0, 1, 2, 3, 4, 5, 6, 7]),
        'sigmaRawBps': grp(calls, lambda c: c['sigmaRawBps'], [0, 0.2, 0.4, 0.6, 1.0, 1e9]),
        'wrongBySettlementMargin': {'|margin| < $10 (near the strike: basis / settlement-average noise decides)': sum(1 for c in W if abs(c['margin']) < 10),
                                    '|margin| >= $10 (price moved through the strike: reversal)': sum(1 for c in W if abs(c['margin']) >= 10)},
        'wrongNearStrikeAndLate': sum(1 for c in W if abs(c['margin']) < 10 and c['tau'] < 30),
        'reversalWarning': {'onWrongCalls': sum(1 for c in W if c['rev']), 'wrongCalls': len(W),
                            'onCorrectCalls': sum(1 for c in calls if c['correct'] and c['rev']), 'correctCalls': len(calls) - len(W),
                            'wrongCallsWarnedWithAtLeast15sLeft': sum(1 for c in W if c['rev'] and c['rev']['tau'] >= 15)},
    }
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    recs = [json.loads(l) for l in open(a.records)]
    recs = [r for r in recs if r.get('truth') in ('UP', 'DOWN')]
    res = {'U (U1+U2)': analyse([r for r in recs if r['closeTs'] < U2_END or r['closeTs'] >= U1_START]),
           'seen': analyse([r for r in recs if U2_END <= r['closeTs'] < U1_START]), 'all': analyse(recs)}
    json.dump(res, open(a.out, 'w'), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
