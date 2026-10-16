"""Execution evidence from Kalshi's real trade prints (no order-book history exists, so this is what can be supported).

For each window and entry rule, at the entry moment t:
  * the called side's last traded price before t (any taker; a NO buy at p means YES traded at 100 - p): what the market thought;
  * the 90 c market-disagreement guard of 2.8.1 (MIN_TRADE_ASK_CENTS): if that price is below 90 c, TRADE NOW is refused;
  * the called side's TAKER BUYS in [t, t + order time] at <= the limit price: offers existed at those prices and that many contracts
    were taken. It is an UPPER bound on what you could have bought (you would have competed for the same offers), not a guarantee;
  * whether the called side won (Kalshi's own result).
Entry rules: 'first' = the first LOCKED second; 'T60' ... 'T10' = the call is LOCKED at that fixed time (taken from the replay record).
Kalshi field meaning (docs.kalshi.com, order direction / Get Trades): taker_outcome_side (deprecated alias taker_side) is the outcome the
taker BOUGHT; yes_price_dollars / no_price_dollars are that trade's prices; count_fp may be fractional.
  python3 execution.py --records replay.ndjson --trace trace.ndjson --trades data/kalshi/trades --order-sec 12 --limit 99.9 --budget 50000 --out exec.json"""
import argparse, collections, datetime, gzip, json, math, os

RULES = ('first', 'T60', 'T45', 'T30', 'T20', 'T15', 'T10')


def price_cents(t, side):
    k = side + '_price'
    if t.get(k) is not None:
        return float(t[k])
    if t.get(k + '_dollars') is not None:
        return 100 * float(t[k + '_dollars'])
    other = 'no' if side == 'yes' else 'yes'
    if t.get(other + '_price') is not None:
        return 100 - float(t[other + '_price'])
    if t.get(other + '_price_dollars') is not None:
        return 100 - 100 * float(t[other + '_price_dollars'])
    return math.nan


def tsec(t):
    v = t.get('created_time') or t.get('ts')
    if isinstance(v, (int, float)):
        return float(v)
    return datetime.datetime.fromisoformat(v.replace('Z', '+00:00')).timestamp()


def load_trades(d, ticker):
    fn = os.path.join(d, ticker + '.json.gz')
    if not os.path.exists(fn):
        return None
    with gzip.open(fn, 'rt') as f:
        tr = json.load(f)['trades']
    out = []
    for t in tr:
        side = t.get('taker_outcome_side') or t.get('taker_side')
        out.append((tsec(t), side, price_cents(t, 'yes'), price_cents(t, 'no'), float(t.get('count') or t.get('count_fp') or 0)))
    out.sort()
    return out


def entry(rec, trace_rows, rule):
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
    p.add_argument('--limit', type=float, default=99.9)
    p.add_argument('--budget', type=float, default=50000)
    p.add_argument('--guard', type=float, default=90)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    recs = [json.loads(l) for l in open(a.records)]
    recs = [r for r in recs if r.get('truth') in ('UP', 'DOWN')]
    first_ts = {}                                     # ticker -> [its first LOCKED trace row]
    for l in open(a.trace):
        x = json.loads(l)
        if x['st'] in ('LOCKED', 'PROVEN LOCKED') and x['tk'] not in first_ts:
            first_ts[x['tk']] = [x]
    res = {}
    rows_by_rule = {r: [] for r in RULES}
    for rec in recs:
        trades = load_trades(a.trades, rec['ticker'])
        for rule in RULES:
            e = entry(rec, first_ts.get(rec['ticker'], []), rule)
            if not e:
                continue
            t_in, side, tau = e
            row = {'ticker': rec['ticker'], 'closeTs': rec['closeTs'], 'tau': tau, 'side': side, 'won': side == rec['truth'], 'marginUsd': rec['marginUsd']}
            if trades is None:
                row['noTape'] = True
                rows_by_rule[rule].append(row)
                continue
            ks = 'yes' if side == 'UP' else 'no'
            before = [x for x in trades if x[0] < t_in]
            last = before[-1] if before else None
            last_px = (last[2] if ks == 'yes' else last[3]) if last else None
            win = [x for x in trades if t_in <= x[0] <= t_in + a.order_sec and x[1] == ks]
            pxs = [((x[2] if ks == 'yes' else x[3]), x[4]) for x in win]
            ok = [(pr, c) for pr, c in pxs if pr <= a.limit + 1e-9]
            vol = sum(c for _, c in ok)
            until_close = sum(x[4] for x in trades if t_in <= x[0] <= rec['closeTs'] - 3 and x[1] == ks and (x[2] if ks == 'yes' else x[3]) <= a.limit + 1e-9)
            row.update({'lastCalledSidePriceCents': last_px, 'lastTradeAgeSec': round(t_in - last[0], 1) if last else None,
                        'guardBlocks': last_px is not None and last_px < a.guard,
                        'takerBuysInOrderTime': len(win), 'contractsAtOrBelowLimit': round(vol, 2),
                        'vwapCents': round(sum(pr * c for pr, c in ok) / vol, 3) if vol else None, 'worstCents': max((pr for pr, _ in ok), default=None),
                        'contractsAtOrBelowLimitUntilClose': round(until_close, 2)})
            rows_by_rule[rule].append(row)
    need = a.budget / (a.limit / 100)
    for rule, rows in rows_by_rule.items():
        tape = [r for r in rows if not r.get('noTape')]
        traded = [r for r in tape if not r['guardBlocks'] and r['contractsAtOrBelowLimit'] > 0]
        res[rule] = {
            'entries': len(rows), 'withTape': len(tape), 'lost': sum(1 for r in rows if not r['won']),
            'lostWithTape': [{'ticker': r['ticker'], 'tau': r['tau'], 'side': r['side'], 'margin': r['marginUsd'], 'lastPx': r.get('lastCalledSidePriceCents'),
                              'guardBlocks': r.get('guardBlocks'), 'contracts': r.get('contractsAtOrBelowLimit')} for r in tape if not r['won']],
            'guardBlocked': sum(1 for r in tape if r['guardBlocks']), 'guardBlockedLost': sum(1 for r in tape if r['guardBlocks'] and not r['won']),
            'withFillsAtOrBelowLimit': len(traded), 'lostAmongFilled': sum(1 for r in traded if not r['won']),
            'contractsInOrderTime': {q: (sorted(r['contractsAtOrBelowLimit'] for r in tape)[int(q * (len(tape) - 1))] if tape else None) for q in (0.5, 0.75, 0.9, 0.99)},
            'shareWithAtLeastBudgetContracts': round(sum(1 for r in tape if r['contractsAtOrBelowLimit'] >= need) / len(tape), 5) if tape else None,
            'shareWithAtLeastBudgetContractsUntilClose': round(sum(1 for r in tape if r['contractsAtOrBelowLimitUntilClose'] >= need) / len(tape), 5) if tape else None,
            'medianLastCalledSidePrice': sorted(r['lastCalledSidePriceCents'] for r in tape if r['lastCalledSidePriceCents'] is not None)[len(tape) // 2] if tape else None,
        }
    out = {'params': {'orderSec': a.order_sec, 'limitCents': a.limit, 'budgetUsd': a.budget, 'contractsForBudget': round(need), 'guardCents': a.guard}, 'rules': res}
    json.dump(out, open(a.out, 'w'), indent=1)
    with open(a.out.replace('.json', '_rows.ndjson'), 'w') as f:
        for rule, rows in rows_by_rule.items():
            for r in rows:
                f.write(json.dumps({'rule': rule, **r}) + '\n')
    print(json.dumps({k: {x: v[x] for x in v if x != 'lostWithTape'} for k, v in res.items()}, indent=1))


if __name__ == '__main__':
    main()
