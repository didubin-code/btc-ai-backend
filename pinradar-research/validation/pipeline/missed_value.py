"""Value of the windows the engine never called LOCKED although the official margin was large (Question D).
For each never-LOCKED window with |official margin| >= --min-margin and a Kalshi tape: the side the engine leaned to at T-60
(HIGH CONFIDENCE side), whether it won, and the P&L of buying C contracts of it at T-60 with the same fill rule as trading_eval.py
(other takers' buys at <= 99.9 c in the next 12 s, VWAP, Kalshi fee).
  python3 missed_value.py --records replay.ndjson --trades data/kalshi/trades --out missed.json"""
import argparse, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from trading_eval import load_trades, fills, fee_c, last_price


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', required=True)
    ap.add_argument('--trades', required=True)
    ap.add_argument('--min-margin', type=float, default=100)
    ap.add_argument('--C', type=int, default=100)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    rows = []
    for l in open(a.records):
        r = json.loads(l)
        if r.get('truth') not in ('UP', 'DOWN') or r.get('firstLocked') or abs(r['marginUsd']) < a.min_margin:
            continue
        f = r['fixed'].get('60') or {}
        if not f.get('side'):
            continue
        tr = load_trades(a.trades, r['ticker'])
        if tr is None:
            rows.append({'ticker': r['ticker'], 'noTape': True})
            continue
        t_in = r['closeTs'] - 60
        vol, vwap, worst = fills(tr, t_in, f['side'], 12, 99.9)
        won = f['side'] == r['truth']
        pnl = None
        if vol >= a.C and vwap is not None:
            fe = fee_c(vwap, a.C)
            pnl = (100 - vwap - fe) if won else -(vwap + fe)
        rows.append({'ticker': r['ticker'], 'state60': f.get('st'), 'side': f['side'], 'won': won, 'margin': r['marginUsd'], 'lastPx': last_price(tr, t_in, f['side']),
                     'vol': round(vol, 2), 'vwap': vwap, 'pnlCentsPerContract': None if pnl is None else round(pnl, 4)})
    tape = [x for x in rows if not x.get('noTape')]
    filled = [x for x in tape if x['pnlCentsPerContract'] is not None]
    px = sorted(x['lastPx'] for x in tape if x['lastPx'] is not None)
    out = {'windows': len(rows), 'withTape': len(tape), 'leanedSideWon': sum(1 for x in tape if x['won']), 'filledAtC': len(filled), 'C': a.C,
           'totalUsdAtC': round(sum(x['pnlCentsPerContract'] for x in filled) * a.C / 100, 2),
           'meanCentsPerContract': round(sum(x['pnlCentsPerContract'] for x in filled) / len(filled), 4) if filled else None,
           'medianLastPriceOfLeanedSide': px[len(px) // 2] if px else None, 'rows': rows}
    json.dump(out, open(a.out, 'w'), indent=1)
    print(json.dumps({k: v for k, v in out.items() if k != 'rows'}))


if __name__ == '__main__':
    main()
