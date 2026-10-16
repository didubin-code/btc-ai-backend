"""Pre-registered decisive figures (VALIDATION_PREREG.md) on U = U1 (from 2026-10-14) + U2 (before 2026-07-22), from replay records,
plus the same on the seen splits, for several replay runs. Execution columns come from execution.py rows (Kalshi prints).
  python3 decisive.py --data /home/user/data_val --out decisive.json"""
import argparse, json, math, os

U2_END, U1_START = 1784678400, 1791936000          # 2026-07-22, 2026-10-14 (UTC)
BREAK_EVEN = 0.093                                   # % at 99.9 c, validation/economics.js
TIMES = ('120', '90', '60', '45', '30', '20', '15', '10', '5', '3')


def binom_cdf(k, n, p):
    if p <= 0:
        return 1.0
    if p >= 1:
        return 0.0 if k < n else 1.0
    return min(1.0, sum(math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * math.log(p) + (n - i) * math.log1p(-p)) for i in range(k + 1)))


def upper(k, n, a):
    if n == 0 or k >= n:
        return 1.0
    lo, hi = k / n, 1.0
    for _ in range(100):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if binom_cdf(k, n, m) > a else (lo, m)
    return hi


def lower(k, n, a):
    """p with P(X >= k | p) = a (Clopper-Pearson lower limit)."""
    if k == 0:
        return 0.0
    lo, hi = 0.0, k / n
    for _ in range(100):
        m = (lo + hi) / 2
        lo, hi = (m, hi) if 1 - binom_cdf(k - 1, n, m) < a else (lo, m)
    return lo


def stat(k, n):
    return {'k': k, 'n': n, 'ratePct': round(100 * k / n, 4) if n else None, 'ci95Pct': [round(100 * lower(k, n, 0.025), 4), round(100 * upper(k, n, 0.025), 4)] if n else None,
            'upper95OneSidedPct': round(100 * upper(k, n, 0.05), 4) if n else None}


def split_of(t):
    if t < U2_END:
        return 'U2'
    if t >= U1_START:
        return 'U1'
    return 'seen'


def summarize(recs):
    out = {'windows': len(recs)}
    fl = [r for r in recs if r.get('firstLocked')]
    out['coveragePct'] = round(100 * len(fl) / len(recs), 2) if recs else None
    out['firstLocked'] = stat(sum(1 for r in fl if not r['firstLocked']['correct']), len(fl))
    out['fixed'] = {}
    for T in TIMES:
        L = [r for r in recs if (r['fixed'].get(T) or {}).get('st') in ('LOCKED', 'PROVEN LOCKED')]
        out['fixed'][T] = stat(sum(1 for r in L if r['fixed'][T]['side'] != r['truth']), len(L))
        out['fixed'][T]['wrong'] = [r['ticker'] for r in L if r['fixed'][T]['side'] != r['truth']]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    D = a.data
    res = {}
    for run in ('r281_usdc', 'r28_usdc', 'r281_usdt', 'cand_usdc', 'cand_usdt', 'thr02_usdc'):
        fn = os.path.join(D, 'replay', run + '.ndjson')
        if not os.path.exists(fn):
            continue
        recs = [json.loads(l) for l in open(fn)]
        recs = [r for r in recs if r.get('truth') in ('UP', 'DOWN')]
        res[run] = {'U (U1+U2)': summarize([r for r in recs if split_of(r['closeTs']) != 'seen']),
                    'U2': summarize([r for r in recs if split_of(r['closeTs']) == 'U2']),
                    'U1': summarize([r for r in recs if split_of(r['closeTs']) == 'U1']),
                    'seen (Jul 22 - Oct 13)': summarize([r for r in recs if split_of(r['closeTs']) == 'seen']),
                    'all': summarize(recs)}
    # pre-registered verdict rules on U, primary engine
    p = res['r281_usdc']['U (U1+U2)']['fixed']['20']
    rows = [json.loads(l) for l in open(os.path.join(D, 'exec_r281_usdc_full_rows.ndjson'))]
    e20 = [r for r in rows if r['rule'] == 'T20' and split_of(r['closeTs']) != 'seen' and not r.get('noTape')]
    vol_ok = sum(1 for r in e20 if r['contractsAtOrBelowLimit'] >= 50046)
    fails = [{k: r.get(k) for k in ('ticker', 'side', 'marginUsd', 'lastCalledSidePriceCents', 'guardBlocks', 'contractsAtOrBelowLimit')} for r in rows
             if r['rule'] == 'T20' and split_of(r['closeTs']) != 'seen' and not r['won']]
    res['prereg'] = {
        'rule1_E20_upper95_below_break_even': {'upper95OneSidedPct': p['upper95OneSidedPct'], 'breakEvenPct': BREAK_EVEN, 'k': p['k'], 'n': p['n'], 'pass': p['upper95OneSidedPct'] < BREAK_EVEN},
        'rule2_volume_50k_in_half_of_E20': {'entriesWithTape': len(e20), 'withAtLeast50046': vol_ok, 'sharePct': round(100 * vol_ok / len(e20), 4) if e20 else None, 'pass': bool(e20) and vol_ok >= len(e20) / 2},
        'rule3_E20_failures_on_U': fails,
        'NO_if_CI_wholly_above': p['ci95Pct'][0] > BREAK_EVEN,
        'NO_if_volume_below_10pct': bool(e20) and vol_ok < 0.1 * len(e20),
    }
    json.dump(res, open(a.out, 'w'), indent=1)
    for run, v in res.items():
        if run == 'prereg':
            continue
        for sp, s in v.items():
            f = s['firstLocked']
            print('%-10s %-24s win %6d cov %5.1f%% first %3d/%5d %.3f%% [%s]  ' % (run, sp, s['windows'], s['coveragePct'] or 0, f['k'], f['n'], f['ratePct'] or 0, '-'.join('%.3f' % x for x in f['ci95Pct'] or [])) +
                  ' '.join('T%s %d/%d' % (T, s['fixed'][T]['k'], s['fixed'][T]['n']) for T in ('60', '30', '20', '15', '10', '5')))
    print(json.dumps(res['prereg'], indent=1))


if __name__ == '__main__':
    main()
