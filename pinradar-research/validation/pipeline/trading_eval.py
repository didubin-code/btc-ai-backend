"""Profitability of LOCKED-based entries at realistic sizes, from Kalshi's real trade prints, against a MARKET-ONLY baseline.

Fill model (same for every strategy): at the entry moment t, an order of C contracts on the chosen side fills only if other takers bought at
least C contracts of that side at <= the limit (99.9 c) in [t, t + order time]; it fills at their VWAP (or, for the sensitivity, at the
worst of those prints), plus optional slippage, plus Kalshi's taker fee for one order of C contracts. These prints show offers that
existed and were taken; you would have competed for them, so fills are an UPPER bound on what you could have obtained.

Strategies
  model:first      2.8.1's first LOCKED second (replay), 90 c market-disagreement guard applied
  model:T30/T20/T15 the call is still LOCKED at that time (replay), guard applied
  market:99        no model: the first second in the final 300 s at which a side's last traded price is >= 99 c; buy that side
  market:99.5      the same at >= 99.5 c
Confidence intervals: day-level block bootstrap (2,000 resamples), so clustered losses are not treated as independent.
  python3 trading_eval.py --exec-rows exec_rows.ndjson --markets markets_clean.ndjson --trades data/kalshi/trades --out trading.json"""
import argparse, collections, datetime, gzip, json, math, os, random


def fee_c(p, C, rate=0.07):
    P = p / 100
    return math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / C


def load_trades(d, ticker):
    fn = os.path.join(d, ticker + '.json.gz')
    if not os.path.exists(fn):
        return None
    with gzip.open(fn, 'rt') as f:
        tr = json.load(f)['trades']
    out = []
    for t in tr:
        side = t.get('taker_outcome_side') or t.get('taker_side')
        ts = datetime.datetime.fromisoformat(t['created_time'].replace('Z', '+00:00')).timestamp()
        y = 100 * float(t['yes_price_dollars']) if t.get('yes_price_dollars') is not None else float(t.get('yes_price'))
        n = 100 * float(t['no_price_dollars']) if t.get('no_price_dollars') is not None else float(t.get('no_price'))
        out.append((ts, side, y, n, float(t.get('count_fp') or t.get('count') or 0)))
    out.sort()
    return out


def fills(trades, t_in, side, order_sec, limit):
    ks = 'yes' if side == 'UP' else 'no'
    w = [((x[2] if ks == 'yes' else x[3]), x[4]) for x in trades if t_in <= x[0] <= t_in + order_sec and x[1] == ks]
    ok = [(p, c) for p, c in w if p <= limit + 1e-9]
    vol = sum(c for _, c in ok)
    return vol, (sum(p * c for p, c in ok) / vol if vol else None), max((p for p, _ in ok), default=None)


def market_entry(trades, close, thr):
    """first second in the final 300 s at which a side's last traded price is >= thr -> (t, side)."""
    for x in trades:
        if x[0] < close - 300 or x[0] > close - 3:
            continue
        if x[2] >= thr:
            return x[0], 'UP'
        if x[3] >= thr:
            return x[0], 'DOWN'
    return None


def pnl(rows, C, fillkey='vwap', slip=0.0):
    out = []
    for r in rows:
        if r['vol'] < C or r[fillkey] is None:
            continue
        p = min(99.99, r[fillkey] + slip)
        f = fee_c(p, C)
        out.append((r['day'], (100 - p - f) if r['won'] else -(p + f), r['won']))
    return out


def boot(vals, n=2000, seed=7):
    if not vals:
        return None
    rnd = random.Random(seed)
    by = collections.defaultdict(list)
    for d, v, _ in vals:
        by[d].append(v)
    days = list(by)
    ms = []
    for _ in range(n):
        s = c = 0
        for _ in days:
            xs = by[days[rnd.randrange(len(days))]]
            s += sum(xs)
            c += len(xs)
        ms.append(s / c if c else 0)
    ms.sort()
    return [round(ms[int(0.025 * n)], 4), round(ms[int(0.975 * n)], 4)]


def summarize(name, rows, sizes=(10, 100, 1000, 10000), fills_=(('vwap', 0.0), ('worst', 0.0), ('vwap', 0.1))):
    res = {'entries': len(rows), 'lostAll': sum(1 for r in rows if not r['won'])}
    for C in sizes:
        for fk, sl in fills_:
            v = pnl(rows, C, fk, sl)
            if not v:
                continue
            m = sum(x for _, x, _ in v) / len(v)
            res['C%d_%s%s' % (C, fk, '+%.1f' % sl if sl else '')] = {'trades': len(v), 'lost': sum(1 for *_, w in v if not w), 'meanCentsPerContract': round(m, 4),
                                                                  'ci95BootDays': boot(v), 'totalUsd': round(m * len(v) * C / 100, 2)}
    return res


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--exec-rows', required=True)
    p.add_argument('--markets', required=True)
    p.add_argument('--trades', required=True)
    p.add_argument('--order-sec', type=float, default=12)
    p.add_argument('--limit', type=float, default=99.9)
    p.add_argument('--from', dest='frm', default=None)
    p.add_argument('--to', default=None)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    tf = datetime.datetime.fromisoformat(a.frm).timestamp() if a.frm else -1e18
    tt = datetime.datetime.fromisoformat(a.to).timestamp() if a.to else 1e18
    day = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%d')
    strat = collections.defaultdict(list)
    for l in open(a.exec_rows):
        r = json.loads(l)
        if r.get('noTape') or not (tf <= r['closeTs'] < tt) or r['rule'] not in ('first', 'T30', 'T20', 'T15'):
            continue
        if r['guardBlocks']:
            continue
        strat['model:' + r['rule']].append({'day': day(r['closeTs']), 'won': r['won'], 'vol': r['contractsAtOrBelowLimit'], 'vwap': r['vwapCents'], 'worst': r['worstCents']})
    truth = {}
    for l in open(a.markets):
        m = json.loads(l)
        if tf <= m['closeTs'] < tt:
            truth[m['ticker']] = m
    for tk, m in truth.items():
        trades = load_trades(a.trades, tk)
        if trades is None:
            continue
        for thr in (99.0, 99.5):
            e = market_entry(trades, m['closeTs'], thr)
            if not e:
                continue
            t_in, side = e
            vol, vwap, worst = fills(trades, t_in, side, a.order_sec, a.limit)
            strat['market:%g' % thr].append({'day': day(m['closeTs']), 'won': (side == 'UP') == (m['result'] == 'yes'), 'vol': vol, 'vwap': vwap, 'worst': worst})
    res = {k: summarize(k, v) for k, v in sorted(strat.items())}
    res['_params'] = {'orderSec': a.order_sec, 'limitCents': a.limit, 'from': a.frm, 'to': a.to, 'marketsWithTape': sum(1 for tk in truth if os.path.exists(os.path.join(a.trades, tk + '.json.gz')))}
    json.dump(res, open(a.out, 'w'), indent=1)
    for k, v in res.items():
        if k.startswith('_'):
            continue
        line = ['%-14s entries %5d lost %3d' % (k, v['entries'], v['lostAll'])]
        for C in (100, 1000):
            x = v.get('C%d_vwap' % C)
            if x:
                line.append('C%d: %d trades, %d lost, %+.3f c [%s] $%s' % (C, x['trades'], x['lost'], x['meanCentsPerContract'], ','.join('%+.3f' % q for q in x['ci95BootDays']), x['totalUsd']))
        print(' | '.join(line))


if __name__ == '__main__':
    main()
