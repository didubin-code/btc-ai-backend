"""Supplementary analyses requested by the independent check of VALIDATION_REPORT.md (all from existing replay records, execution rows,
the 1 Hz BTCUSDC feed and Kalshi tapes; outcomes used for scoring only).
  1  wrong first-LOCKED calls classified by what the replay FEED did: did the feed's own 60-s settlement average also end on the other side
     of the strike (the price itself moved through it: a real reversal), or did only the official average (feed-vs-BRTI basis decided)?
  2  more candidate predictors at the first LOCKED second: required move, prior adverse excursion (60 s), change of volatility (last 60 s
     vs the 240 s before), engine volatility-regime bucket; Fisher tests for the top band
  3  day-block bootstrap intervals for the reliability rates (correlated windows)
  4  near-threshold calls (HIGH CONFIDENCE, flip 0.5-2 %) at T-120 / T-90 / T-60: how often wrong (cost of the conservative threshold)
  5  a 0.2 % LOCKED threshold, approximated from the trace (first LOCKED second with flip <= 0.2 %)
  6  direction: first LOCKED and T-20 by side; P&L by side (first LOCKED, guard, U2)
  7  2.8 vs 2.8.1 decision differences
  8  the 90 c guard re-checked every later LOCKED second (does it delay or prevent?), value of guard-blocked and buffer-blocked trades
  9  pre-registered verdict rules at other sizes and prices
 10  first-LOCKED losses at 1,000 contracts: fill price vs the market price at entry; exit-rule recoveries
 11  missed-value with the guard; never-LOCKED windows with margins $20-100
 12  data facts: excluded markets, Kraken coverage days, tape coverage by month
  python3 supplement.py --data /home/user/data_val --out supplement.json"""
import argparse, collections, datetime, json, math, os, random, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from decisive import stat  # noqa: E402
from trading_eval import load_trades, fills, fee_c, last_price  # noqa: E402

U2_END, U1_START = 1784678400, 1791936000
isU = lambda t: t < U2_END or t >= U1_START
day = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%d')


class Feed:
    def __init__(self, d):
        self.d, self.c = d, {}

    def arr(self, dd):
        if dd not in self.c:
            fn = os.path.join(self.d, dd + '.f64')
            self.c[dd] = np.fromfile(fn, dtype='<f8') if os.path.exists(fn) else None
            if len(self.c) > 8:
                self.c.pop(next(iter(self.c)))
        return self.c[dd]

    def seg(self, t0, t1):
        """prices for whole seconds t0..t1-1 (unix)."""
        out = []
        for t in range(int(t0), int(t1)):
            a = self.arr(day(t))
            v = a[t - int(datetime.datetime.strptime(day(t), '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc).timestamp())] if a is not None else np.nan
            out.append(v)
        return np.array(out)


def lchoose(n, k):
    return math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)


def fisher(a, b, c, d):
    r1, r2, c1, n = a + b, c + d, a + c, a + b + c + d
    pf = lambda x: math.exp(lchoose(r1, x) + lchoose(r2, c1 - x) - lchoose(n, c1))
    p0 = pf(a)
    return round(min(1.0, sum(pf(x) for x in range(max(0, c1 - r2), min(r1, c1) + 1) if pf(x) <= p0 * (1 + 1e-9))), 4)


def bands(rows, key, edges):
    out = {}
    for lo, hi in zip(edges[:-1], edges[1:]):
        xs = [r for r in rows if key(r) is not None and lo <= key(r) < hi]
        k = sum(1 for r in xs if not r['correct'])
        out['[%g, %g)' % (lo, hi)] = stat(k, len(xs)) if xs else {'k': 0, 'n': 0}
    return out


def boot_rate(rows, wrong, n=2000, seed=3):
    by = collections.defaultdict(lambda: [0, 0])
    for r in rows:
        by[day(r['closeTs'])][0] += wrong(r)
        by[day(r['closeTs'])][1] += 1
    days = list(by)
    rnd = random.Random(seed)
    v = []
    for _ in range(n):
        k = m = 0
        for _ in days:
            a, b = by[days[rnd.randrange(len(days))]]
            k += a
            m += b
        v.append(100 * k / m)
    v.sort()
    return [round(v[int(0.025 * n)], 4), round(v[int(0.975 * n)], 4), round(v[int(0.95 * n)], 4)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    D = a.data
    res = {}
    R = [json.loads(l) for l in open(os.path.join(D, 'replay/r281_usdc.ndjson'))]
    R = [r for r in R if r.get('truth') in ('UP', 'DOWN')]
    RU = [r for r in R if isU(r['closeTs'])]
    ex = collections.defaultdict(dict)
    for l in open(os.path.join(D, 'exec_r281_usdc_full_rows.ndjson')):
        x = json.loads(l)
        ex[x['rule']][x['ticker']] = x
    feed = Feed(os.path.join(D, 'sec/usdc'))
    tapes = set(f[:-8] for f in os.listdir(os.path.join(D, 'kalshi/trades')) if f.endswith('.json.gz'))

    # ---- 1. failure classes by what the feed did
    cls = {}
    for name, RR in (('U', RU), ('all', R)):
        rows = []
        for r in RR:
            f = r.get('firstLocked')
            if not f or f['correct']:
                continue
            p = feed.seg(r['closeTs'] - 60, r['closeTs'])
            favg = float(np.nanmean(p)) if np.isfinite(p).sum() >= 57 else None
            e = ex['first'].get(r['ticker'], {})
            sgn = 1 if f['side'] == 'UP' else -1
            raw_through = favg is not None and sgn * (favg - r['strike']) < 0
            corr_through = favg is not None and sgn * (favg + (f.get('basisMu') or 0) - r['strike']) < 0
            rows.append({'ticker': r['ticker'], 'side': f['side'], 'tau': f['tau'], 'margin': r['marginUsd'], 'feedAvgMinusStrike': None if favg is None else round(favg - r['strike'], 2),
                         'basisMu': f.get('basisMu'), 'feedThroughStrike': raw_through, 'feedPlusBasisThroughStrike': corr_through,
                         'lastPx': e.get('lastCalledSidePriceCents'), 'tape': bool(e) and not e.get('noTape'),
                         'blocked': f['tau'] < 15 or bool(e.get('guardBlocks'))})
        real = [x for x in rows if x['feedThroughStrike']]
        basis = [x for x in rows if not x['feedThroughStrike']]
        cls[name] = {'wrong': len(rows), 'realReversal_feedThroughStrike': len(real), 'basisDecided': len(basis),
                     'realReversalCorrectedBasis': sum(1 for x in rows if x['feedPlusBasisThroughStrike']),
                     'real_bySide': collections.Counter(x['side'] for x in real), 'basis_bySide': collections.Counter(x['side'] for x in basis),
                     'real_notBlocked_marketAgreeing': [x for x in real if not x['blocked'] and x['tape'] and (x['lastPx'] or 0) >= 90],
                     'real_tauRange': [min((x['tau'] for x in real), default=None), max((x['tau'] for x in real), default=None)],
                     'basis_tauUnder30': sum(1 for x in basis if x['tau'] < 30), 'rows': rows}
        n_calls = sum(1 for r in RR if r.get('firstLocked'))
        cls[name]['realNotBlockedRatePct'] = round(100 * len(cls[name]['real_notBlocked_marketAgreeing']) / n_calls, 4)
    res['1_failureClasses'] = cls

    # ---- 2. predictors at the first LOCKED second (U)
    calls = []
    for r in RU:
        f = r.get('firstLocked')
        if not f:
            continue
        t = int(r['closeTs'] - f['tau'] - 0.75)
        p = feed.seg(t - 300, t + 1)
        now = p[-1]
        S = now if np.isfinite(now) else r['strike']
        sig1 = (f.get('sigmaRawBps') or 0) * S * 1e-4
        last60 = p[-61:]
        adv = None
        if np.isfinite(last60).sum() > 50 and np.isfinite(now) and sig1 > 0:
            adv = float((np.nanmax(last60) - now) if f['side'] == 'UP' else (now - np.nanmin(last60))) / (sig1 * math.sqrt(60))
        d = np.diff(p)
        volchg = None
        if np.isfinite(d[-60:]).sum() > 50 and np.isfinite(d[:-60]).sum() > 200:
            v1, v0 = np.nanstd(d[-60:]), np.nanstd(d[:-60])
            volchg = float(v1 / v0) if v0 > 0 else None
        calls.append({'correct': f['correct'], 'req': f.get('requiredMoveUsd'), 'adv': adv, 'volchg': volchg, 'bucket': f.get('bucket'), 'side': f['side'], 'tau': f['tau'], 'closeTs': r['closeTs']})
    def top(key, thr):
        hi = [c for c in calls if key(c) is not None and key(c) >= thr]
        lo = [c for c in calls if key(c) is not None and key(c) < thr]
        wk = lambda xs: sum(1 for c in xs if not c['correct'])
        return {'>=%g' % thr: [wk(hi), len(hi)], '<%g' % thr: [wk(lo), len(lo)], 'fisherP': fisher(wk(hi), len(hi) - wk(hi), wk(lo), len(lo) - wk(lo)) if hi and lo else None}
    res['2_predictors_U'] = {
        'requiredMoveUsd': bands(calls, lambda c: c['req'], [0, 20, 50, 100, 200, 1e9]),
        'priorAdverseExcursion60s_sigma': bands(calls, lambda c: c['adv'], [0, 0.5, 1, 1.5, 2, 3, 1e9]), 'adverseTop': top(lambda c: c['adv'], 1.5),
        'volChange_last60_vs_prev240': bands(calls, lambda c: c['volchg'], [0, 0.5, 0.8, 1.25, 2, 1e9]), 'volChangeTop': top(lambda c: c['volchg'], 2),
        'engineVolBucket': bands(calls, lambda c: c['bucket'], [0, 1, 2, 3, 4, 5, 6, 7]),
        'cushionBelow3_vs_rest': None,
    }
    cu = [{'correct': r['firstLocked']['correct'], 'c': r['firstLocked'].get('cushionSigma')} for r in RU if r.get('firstLocked')]
    w3 = [x for x in cu if x['c'] is not None and x['c'] < 3]
    r3 = [x for x in cu if x['c'] is not None and x['c'] >= 3]
    wk = lambda xs: sum(1 for x in xs if not x['correct'])
    res['2_predictors_U']['cushionBelow3_vs_rest'] = {'<3': [wk(w3), len(w3)], '>=3': [wk(r3), len(r3)], 'fisherP': fisher(wk(w3), len(w3) - wk(w3), wk(r3), len(r3) - wk(r3)), 'rateAtOrAbove3': stat(wk(r3), len(r3))}

    # ---- 3. day-block bootstrap of reliability rates (U)
    fl = [r for r in RU if r.get('firstLocked')]
    t20 = [r for r in RU if (r['fixed'].get('20') or {}).get('st') in ('LOCKED', 'PROVEN LOCKED')]
    res['3_dayBlockBootstrap_U'] = {'firstLocked_ci95_and_upper95': boot_rate(fl, lambda r: not r['firstLocked']['correct']),
                                    'T20_ci95_and_upper95': boot_rate(t20, lambda r: r['fixed']['20']['side'] != r['truth']),
                                    'T20_firstLockedAtT20': sum(1 for r in t20 if r.get('firstLocked') and r['firstLocked']['tau'] <= 20.25 + 1e-9)}

    # ---- 4. near-threshold calls
    nt = {}
    for T in ('120', '90', '60'):
        xs = [r for r in RU if (r['fixed'].get(T) or {}).get('st') == 'HIGH CONFIDENCE' and 0.005 < (r['fixed'][T].get('pFlip') or 0) <= 0.02]
        k = sum(1 for r in xs if r['fixed'][T]['side'] != r['truth'])
        nt['T' + T] = {**stat(k, len(xs)), 'meanPredictedPct': round(100 * sum(r['fixed'][T]['pFlip'] for r in xs) / len(xs), 3) if xs else None}
    res['4_nearThreshold_highConfidence_0.5to2pct_U'] = nt

    # ---- 5. 0.2 % threshold (approximation from the trace)
    first02 = {}
    for l in open(os.path.join(D, 'replay/r281_usdc.trace.ndjson')):
        x = json.loads(l)
        if x['st'] in ('LOCKED', 'PROVEN LOCKED') and x['pf'] is not None and x['pf'] <= 0.002 and x['tk'] not in first02:
            first02[x['tk']] = x
    tr = {r['ticker']: r for r in RU}
    sel = [(first02[tk], tr[tk]) for tk in first02 if tk in tr]
    k = sum(1 for x, r in sel if x['side'] != r['truth'])
    res['5_threshold02_approx_U'] = {**stat(k, len(sel)), 'windowsCalled': len(sel), 'vsCurrentCalled': len(fl),
                                     'medianTauFirst': sorted(x['tau'] for x, _ in sel)[len(sel) // 2] if sel else None,
                                     'medianTauCurrent': sorted(r['firstLocked']['tau'] for r in fl)[len(fl) // 2]}

    # ---- 6. direction
    dr = {}
    for side in ('UP', 'DOWN'):
        a1 = [r for r in fl if r['firstLocked']['side'] == side]
        a2 = [r for r in t20 if r['fixed']['20']['side'] == side]
        dr[side] = {'firstLocked': stat(sum(1 for r in a1 if not r['firstLocked']['correct']), len(a1)), 'T20': stat(sum(1 for r in a2 if r['fixed']['20']['side'] != r['truth']), len(a2))}
    # P&L by side, model:first, U2, guard, C=100/1000 (VWAP), same rules as trading_eval
    pnl_side = {s: {100: [], 1000: []} for s in ('UP', 'DOWN')}
    guard_val = {100: [], 1000: []}
    buf_val = {100: [], 1000: []}
    delayed = []
    trace_by = collections.defaultdict(list)
    for l in open(os.path.join(D, 'replay/r281_usdc.trace.ndjson')):
        x = json.loads(l)
        if x['st'] in ('LOCKED', 'PROVEN LOCKED'):
            trace_by[x['tk']].append(x)
    for r in R:
        f = r.get('firstLocked')
        if not f or r['ticker'] not in tapes:
            continue
        trd = load_trades(os.path.join(D, 'kalshi/trades'), r['ticker'])
        t_in = r['closeTs'] - f['tau']
        lp = last_price(trd, t_in, f['side'])
        vol, vwap, worst = fills(trd, t_in, f['side'], 12, 99.9)
        blocked_g = lp is not None and lp < 90
        for C in (100, 1000):
            if vol >= C and vwap is not None:
                v = (100 - vwap - fee_c(vwap, C)) if f['correct'] else -(vwap + fee_c(vwap, C))
                if blocked_g:
                    guard_val[C].append(v)
                elif r['closeTs'] < U2_END:
                    pnl_side[f['side']][C].append(v)
                if f['tau'] < 15 and not blocked_g:
                    buf_val[C].append(v)
        if blocked_g and not f['correct'] and isU(r['closeTs']):
            later = None
            for x in trace_by[r['ticker']]:
                if x['side'] != f['side'] or x['tau'] < 15 or x['tau'] >= f['tau']:
                    continue
                t2 = r['closeTs'] - x['tau']
                lp2 = last_price(trd, t2, f['side'])
                v2, w2, _ = fills(trd, t2, f['side'], 12, 99.9)
                if lp2 is not None and lp2 >= 90 and v2 >= 100:
                    later = {'tau': x['tau'], 'lastPx': lp2, 'vol': round(v2, 1), 'vwap': w2}
                    break
            delayed.append({'ticker': r['ticker'], 'tau': f['tau'], 'lastPxAtFirst': lp, 'laterEntryPossible': later})
    summ = lambda v, C: {'trades': len(v), 'lost': sum(1 for x in v if x < 0), 'meanCents': round(sum(v) / len(v), 4) if v else None, 'totalUsd': round(sum(v) * C / 100, 2)}
    dr['pnl_U2_firstLocked_guard'] = {s: {C: summ(pnl_side[s][C], C) for C in (100, 1000)} for s in pnl_side}
    res['6_direction_U'] = dr
    res['8_guard'] = {'wrongGuardBlockedU_laterEntry': delayed, 'delayedNotPrevented': sum(1 for x in delayed if x['laterEntryPossible']),
                      'valueOfGuardBlockedTrades_allPeriods': {C: summ(guard_val[C], C) for C in (100, 1000)},
                      'valueOfBufferBlockedTrades_allPeriods': {C: summ(buf_val[C], C) for C in (100, 1000)}}

    # ---- 7. 2.8 vs 2.8.1
    R28 = {}
    for l in open(os.path.join(D, 'replay/r28_usdc.ndjson')):
        x = json.loads(l)
        R28[x['ticker']] = x
    diff = []
    for r in R:
        o = R28.get(r['ticker'])
        if not o:
            continue
        a1, b1 = r.get('firstLocked'), o.get('firstLocked')
        st = [T for T in r['fixed'] if (r['fixed'][T] or {}).get('st') != (o['fixed'].get(T) or {}).get('st')]
        if (bool(a1) != bool(b1)) or (a1 and b1 and (a1['tau'] != b1['tau'] or a1['side'] != b1['side'])) or st:
            diff.append({'ticker': r['ticker'], 'closeTs': r['closeTs'], '281': a1 and [a1['side'], a1['tau']], '28': b1 and [b1['side'], b1['tau']], 'fixedStateDiffs': st})
    res['7_28_vs_281'] = {'windowsDiffering': len(diff), 'lastDifferingClose': max((x['closeTs'] for x in diff), default=None), 'firstClose': R[0]['closeTs'], 'rows': diff}

    # ---- 9. pre-registered rules at other sizes and prices (U, E20 with tape)
    e20 = [r for r in RU if (r['fixed'].get('20') or {}).get('st') in ('LOCKED', 'PROVEN LOCKED') and r['ticker'] in tapes and r['closeTs'] < U2_END]
    vols = []
    for r in e20:
        trd = load_trades(os.path.join(D, 'kalshi/trades'), r['ticker'])
        side = r['fixed']['20']['side']
        t_in = r['closeTs'] - 20
        vols.append({lim: fills(trd, t_in, side, 12, lim)[0] for lim in (99.9, 99.8, 99.0)})
    k20 = sum(1 for r in RU if (r['fixed'].get('20') or {}).get('st') in ('LOCKED', 'PROVEN LOCKED') and r['fixed']['20']['side'] != r['truth'])
    n20 = sum(1 for r in RU if (r['fixed'].get('20') or {}).get('st') in ('LOCKED', 'PROVEN LOCKED'))
    ub = stat(k20, n20)['upper95OneSidedPct']
    be = {99.9: 0.093, 99.8: 0.186, 99.0: 0.93}
    rules = []
    for lim in (99.9, 99.8, 99.0):
        big = {99.9: 50046, 99.8: 50093, 99.0: 50469}[lim]           # contracts that $50,000 buys at that price, fee included (economics.js)
        for C in (10, 100, 1000, 10000, big):
            share = 100 * sum(1 for v in vols if v[lim] >= C) / len(vols)
            y1, y2 = ub < be[lim], share >= 50
            nob = share < 10
            rules.append({'price': lim, 'contracts': C, 'breakEvenPct': be[lim], 'E20upperPct': ub, 'YES1': y1, 'volumeSharePct': round(share, 3), 'YES2': y2, 'YES3': False,
                          'NOb': nob, 'verdict': 'NO' if nob else ('YES' if (y1 and y2) else 'NOT YET VALIDATED')})
    res['9_preregRulesBySizePrice'] = {'E20entriesWithTape': len(vols), 'note': 'YES-3 fails at every size (KXBTC15M-26JAN171615-15 passes the guard)', 'rows': rules}

    # ---- 10. losses at C=1000 and exit recoveries
    loss = []
    for r in R:
        f = r.get('firstLocked')
        if not f or f['correct'] or r['closeTs'] >= U2_END or r['ticker'] not in tapes:
            continue
        trd = load_trades(os.path.join(D, 'kalshi/trades'), r['ticker'])
        t_in = r['closeTs'] - f['tau']
        lp = last_price(trd, t_in, f['side'])
        vol, vwap, worst = fills(trd, t_in, f['side'], 12, 99.9)
        if lp is not None and lp >= 90 and vol >= 1000:
            loss.append({'ticker': r['ticker'], 'lastPxAtEntry': lp, 'vwap': vwap, 'worst': worst, 'lossUsdAt1000': round(-(vwap + fee_c(vwap, 1000)) * 10, 2)})
    ex100 = json.load(open(os.path.join(D, 'exit_full_C100.json')))
    lost = [d for d in ex100['detail'] if not d['won']]
    res['10_losses'] = {'C1000_U2_losses': loss, 'meanLossUsd': round(sum(x['lossUsdAt1000'] for x in loss) / len(loss), 2) if loss else None,
                        'exitC100_losingCalls_meanSell': round(sum(d['sell'] for d in lost) / len(lost), 2) if lost else None, 'exitC100_losingCalls': len(lost)}

    # ---- 11. missed value with guard; $20-100 never-locked
    mv = json.load(open(os.path.join(D, 'missed_value.json')))
    g = [x for x in mv['rows'] if not x.get('noTape') and x['pnlCentsPerContract'] is not None and (x['lastPx'] or 0) >= 90]
    mid = [r for r in R if not r.get('firstLocked') and 20 <= abs(r['marginUsd']) < 100]
    res['11_missed'] = {'withGuard_filledAtC100': len(g), 'withGuard_totalUsd': round(sum(x['pnlCentsPerContract'] for x in g), 2),
                        'neverLocked_20to100': len(mid), 'their_T20_highConfidenceCorrect': sum(1 for r in mid if (r['fixed'].get('20') or {}).get('st') == 'HIGH CONFIDENCE' and r['fixed']['20']['side'] == r['truth'])}

    # ---- 12. data facts
    exc = [json.loads(l) for l in open(os.path.join(D, 'kalshi/excluded.ndjson'))]
    cut = 1768345200   # 2026-01-13 23:00 UTC, first used close
    res['12_data'] = {'excluded': len(exc), 'excludedBeforeFirstUsedClose': sum(1 for x in exc if (x.get('closeTs') or 0) < cut),
                      'excludedInPeriod': sum(1 for x in exc if (x.get('closeTs') or 0) >= cut),
                      'excludedReasons': collections.Counter(x.get('why', '?') for x in exc).most_common(6),
                      'krakenDays': sorted(f[:-4] for f in os.listdir(os.path.join(D, 'sec/kr')) if f.endswith('.f64')),
                      'coinbaseDays': sorted(f[:-4] for f in os.listdir(os.path.join(D, 'sec/cb')) if f.endswith('.f64')),
                      'tapesByMonth': collections.Counter(day(json.loads(l)['closeTs'])[:7] for l in open(os.path.join(D, 'kalshi/markets_clean.ndjson')) if json.loads(l)['ticker'] in tapes),
                      'marketsByMonth': collections.Counter(day(json.loads(l)['closeTs'])[:7] for l in open(os.path.join(D, 'kalshi/markets_clean.ndjson'))),
                      'U1contracts': sum(1 for l in open(os.path.join(D, 'kalshi/markets_clean.ndjson')) if json.loads(l)['closeTs'] >= U1_START),
                      'U1replayed': sum(1 for r in R if r['closeTs'] >= U1_START)}
    json.dump(res, open(a.out, 'w'), indent=1, default=str)
    short = {k: v for k, v in res.items()}
    short['1_failureClasses'] = {k: {x: y for x, y in v.items() if x != 'rows'} for k, v in res['1_failureClasses'].items()}
    short['7_28_vs_281'] = {k: v for k, v in res['7_28_vs_281'].items() if k != 'rows'}
    print(json.dumps(short, indent=1, default=str)[:30000])


if __name__ == '__main__':
    main()
