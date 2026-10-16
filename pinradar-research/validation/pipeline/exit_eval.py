"""Does exiting on REVERSAL WARNING help? For first-LOCKED entries that filled (same fill rule as trading_eval.py), if the replay showed a
REVERSAL WARNING later in the window, sell at the first warning: the price is the VWAP at which the called side could be SOLD in the next
order time, read from Kalshi prints where a taker bought the OTHER side (a sale of the called side at 100 - that price). If too few
contracts traded, the exit fails and the position is held. Fees are paid on both legs. Compared with holding to settlement.
  python3 exit_eval.py --exec-rows exec_rows.ndjson --trace trace.ndjson --trades data/kalshi/trades --C 100 --out exit.json"""
import argparse, collections, datetime, gzip, json, math, os


def fee_c(p, C, rate=0.07):
    P = p / 100
    return math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / C


def load(d, tk):
    fn = os.path.join(d, tk + '.json.gz')
    if not os.path.exists(fn):
        return None
    out = []
    for t in json.load(gzip.open(fn, 'rt'))['trades']:
        ts = datetime.datetime.fromisoformat(t['created_time'].replace('Z', '+00:00')).timestamp()
        out.append((ts, t.get('taker_outcome_side') or t.get('taker_side'), 100 * float(t['yes_price_dollars']), 100 * float(t['no_price_dollars']), float(t.get('count_fp') or 0)))
    out.sort()
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--exec-rows', required=True)
    p.add_argument('--trace', required=True)
    p.add_argument('--trades', required=True)
    p.add_argument('--C', type=int, default=100)
    p.add_argument('--order-sec', type=float, default=12)
    p.add_argument('--to', default=None)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    tt = datetime.datetime.fromisoformat(a.to).timestamp() if a.to else 1e18
    first_lock, first_rev = {}, {}
    for l in open(a.trace):
        x = json.loads(l)
        if x['st'] in ('LOCKED', 'PROVEN LOCKED') and x['tk'] not in first_lock:
            first_lock[x['tk']] = x
        elif x['st'] == 'REVERSAL WARNING' and x['tk'] in first_lock and x['tk'] not in first_rev:
            first_rev[x['tk']] = x
    hold, exitp, n, warned, exited, warned_lost, warned_won = 0.0, 0.0, 0, 0, 0, 0, 0
    detail = []
    for l in open(a.exec_rows):
        r = json.loads(l)
        if r['rule'] != 'first' or r.get('noTape') or r['guardBlocks'] or r['contractsAtOrBelowLimit'] < a.C or r['closeTs'] >= tt:
            continue
        buy = r['vwapCents']
        fb = fee_c(buy, a.C)
        held = (100 - buy - fb) if r['won'] else -(buy + fb)
        hold += held
        res = held
        rv = first_rev.get(r['ticker'])
        if rv:
            warned += 1
            warned_lost += (not r['won'])
            warned_won += r['won']
            tr = load(a.trades, r['ticker'])
            t0 = rv['ts'] / 1000
            other = 'no' if r['side'] == 'UP' else 'yes'
            sells = [((100 - (x[2] if other == 'yes' else x[3])), x[4]) for x in (tr or []) if t0 <= x[0] <= t0 + a.order_sec and x[1] == other]
            vol = sum(c for _, c in sells)
            if vol >= a.C:
                sp = sum(pq * c for pq, c in sells) / vol
                res = sp - buy - fb - fee_c(sp, a.C)
                exited += 1
                detail.append({'ticker': r['ticker'], 'won': r['won'], 'buy': round(buy, 2), 'sell': round(sp, 2), 'held': round(held, 2), 'exit': round(res, 2), 'revTau': rv['tau']})
        exitp += res
        n += 1
    out = {'C': a.C, 'entries': n, 'warned': warned, 'warnedLost': warned_lost, 'warnedWon': warned_won, 'exitedWithFills': exited,
           'holdTotalCentsPerContractSum': round(hold, 2), 'exitTotalCentsPerContractSum': round(exitp, 2),
           'holdMean': round(hold / n, 4) if n else None, 'exitMean': round(exitp / n, 4) if n else None,
           'holdUsd': round(hold * a.C / 100, 2), 'exitUsd': round(exitp * a.C / 100, 2), 'detail': detail}
    json.dump(out, open(a.out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != 'detail'}, indent=1))
    lost = [d for d in detail if not d['won']]
    won = [d for d in detail if d['won']]
    print('exits on losing calls: %d, mean sell %.1f c (held: -%.1f c)' % (len(lost), sum(d['sell'] for d in lost) / max(1, len(lost)), sum(d['buy'] for d in lost) / max(1, len(lost))))
    print('exits on winning calls (false alarms): %d, mean sell %.1f c, mean give-up %.2f c' % (len(won), sum(d['sell'] for d in won) / max(1, len(won)), sum(d['held'] - d['exit'] for d in won) / max(1, len(won))))


if __name__ == '__main__':
    main()
