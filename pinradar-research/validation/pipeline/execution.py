"""Execution evidence from Kalshi's real trade prints (no order book history exists, so this is what can be supported):
for each window and entry rule, the leader-side taker buys in [entry, entry + order time] show that offers existed at those prices;
their total count bounds how many contracts were actually available to a taker in that interval (others took them; you would have
competed for them, so this is an UPPER bound on what you could have bought, not a guarantee).

Entry rules: 'first' = the first LOCKED second; 'T20' / 'T30' / 'T15' = still LOCKED at that fixed time.
  python3 execution.py --records out.ndjson --trace trace.ndjson --trades data/kalshi/trades --order-sec 12 --budget 50000 --out exec.json"""
import argparse, collections, gzip, json, math, os


def price_cents(t, side):
    """Kalshi trade print -> price paid for `side` ('yes' or 'no') in cents. Handles integer-cent and *_dollars string fields."""
    k = side + '_price'
    if t.get(k) is not None:
        return float(t[k])
    if t.get(k + '_dollars') is not None:
        return 100 * float(t[k + '_dollars'])
    other = 'no' if side == 'yes' else 'yes'
    if t.get(other + '_price') is not None:
        return 100 - float(t[other + '_price'])
    return math.nan


def tsec(t):
    import datetime
    v = t.get('created_time') or t.get('ts')
    if isinstance(v, (int, float)):
        return float(v)
    return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp()


def load_trades(d, ticker):
    fn = os.path.join(d, ticker + '.json.gz')
    if not os.path.exists(fn):
        return None
    with gzip.open(fn, 'rt') as f:
        return json.load(f)['trades']


def entries(rec, trace_rows, rule):
    if rule == 'first':
        fl = rec.get('firstLocked')
        if not fl:
            return None
        r = next((x for x in trace_rows if x['st'] in ('LOCKED', 'PROVEN LOCKED')), None)
        return (r['ts'] / 1000, fl['side'], fl['tau']) if r else None
    T = rule[1:]
    fx = rec['fixed'].get(T)
    if not fx or fx['st'] not in ('LOCKED', 'PROVEN LOCKED'):
        return None
    return (rec['closeTs'] - float(T), fx['side'], float(T))


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--records', required=True)
    p.add_argument('--trace', required=True)
    p.add_argument('--trades', required=True)
    p.add_argument('--order-sec', type=float, default=12)
    p.add_argument('--budget', type=float, default=50000)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    tr = collections.defaultdict(list)
    for l in open(a.trace):
        x = json.loads(l)
        tr[x['tk']].append(x)
    res = {}
    for rule in ('first', 'T30', 'T20', 'T15'):
        rows = []
        for l in open(a.records):
            rec = json.loads(l)
            if rec.get('truth') not in ('UP', 'DOWN'):
                continue
            e = entries(rec, tr.get(rec['ticker'], []), rule)
            if not e:
                continue
            t_in, side, tau = e
            trades = load_trades(a.trades, rec['ticker'])
            if trades is None:
                rows.append({'ticker': rec['ticker'], 'noTape': True})
                continue
            ks = 'yes' if side == 'UP' else 'no'
            buys = [(tsec(t), price_cents(t, ks), float(t.get('count') or t.get('count_fp') or 0)) for t in trades if t.get('taker_side') == ks]
            win = [(s, pr, c) for s, pr, c in buys if t_in <= s <= t_in + a.order_sec and pr <= 99.9]
            rest = [(s, pr, c) for s, pr, c in buys if t_in <= s <= rec['closeTs'] - 3 and pr <= 99.9]
            vol = sum(c for _, _, c in win)
            vwap = sum(pr * c for _, pr, c in win) / vol if vol else None
            worst = max((pr for _, pr, _ in win), default=None)
            won = side == rec['truth']
            need = a.budget / ((worst or 99.9) / 100)
            rows.append({'ticker': rec['ticker'], 'tau': tau, 'side': side, 'won': won, 'fillsInOrderTime': len(win), 'contractsInOrderTime': vol,
                         'vwapCents': vwap, 'worstCents': worst, 'contractsUntilClose': sum(c for _, _, c in rest),
                         'budgetFeasible': vol >= need, 'pnlCentsPerContractAtWorst': (100 - worst if won else -worst) if worst is not None else None})
        priced = [r for r in rows if r.get('worstCents') is not None]
        res[rule] = {'entries': len(rows), 'withTape': sum(1 for r in rows if not r.get('noTape')), 'withLeaderFills': len(priced),
                     'lost': sum(1 for r in priced if not r['won']), 'lostAll': sum(1 for r in rows if 'won' in r and not r['won']),
                     'medianWorstCents': sorted(r['worstCents'] for r in priced)[len(priced) // 2] if priced else None,
                     'meanPnlCentsAtWorst': round(sum(r['pnlCentsPerContractAtWorst'] for r in priced) / len(priced), 4) if priced else None,
                     'medianContractsInOrderTime': sorted(r['contractsInOrderTime'] for r in priced)[len(priced) // 2] if priced else None,
                     'budgetFeasibleWindows': sum(1 for r in priced if r['budgetFeasible']), 'rows': rows}
    json.dump(res, open(a.out, 'w'), indent=1)
    print(json.dumps({k: {x: v[x] for x in v if x != 'rows'} for k, v in res.items()}))


if __name__ == '__main__':
    main()
