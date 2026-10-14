"""LOCKED (2.6) at fixed seconds before the close: accuracy, Kalshi price, and what buying then would have earned.
At each T in (60,45,30,20,15,10,5,3): every window 2.6 shows LOCKED at T; ask = last taker price of that side in the
10 s before (public tape); 'eligible' = TRADE NOW rule (ask 90c..conservative limit); P&L after fee per contract,
cautious fills (losers always filled at ask+1c, winners need >= 10 contracts traded at or below the limit within 2-7 s)
and at the price seen (ask+1c). out: results/fixed_time_trade.json"""
import json, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L
from common import kalshi_fee_cents
from actionable import quote, fwd_fill
out = {}
for sname, rows in L.SETS.items():
    out[sname] = {}
    for T in (60, 45, 30, 20, 15, 10, 5, 3):
        n = lost = priced = elig = 0; asks = []; pc = []; pv = []
        for i in rows:
            f = L.FL['A'][i, T]
            if not (f <= L.LIM + 1e-12): continue
            side = int(L.SD['A'][i, T]); won = (side > 0) == bool(L.yes[i]); n += 1; lost += (not won)
            tp = L.get_tape(i)
            if tp is None: continue
            t = float(L.C[i] - T); si = 0 if side > 0 else 1
            q = quote(tp[si], t)
            if q is None: continue
            priced += 1; asks.append(q)
            lim = L.limit_for(1 - float(L.FC['A'][i, T]))
            if lim <= 0.5 or q > lim + 1e-9 or q < 0.90 - 1e-9: continue
            elig += 1
            pxv = min(lim, q + 0.01); pv.append(100 * ((1.0 if won else 0.0) - pxv - kalshi_fee_cents(pxv, 10) / 100))
            if not won: pc.append(100 * (0 - pxv - kalshi_fee_cents(pxv, 10) / 100))
            else:
                px = fwd_fill(tp[si], t, lim, 2.0, 5.0, 10, 0.01)
                if px is not None: pc.append(100 * (1 - px - kalshi_fee_cents(px, 10) / 100))
        out[sname][T] = {'locked': n, 'lost': lost, 'with_price': priced, 'median_ask_c': round(100 * float(np.median(asks)), 1) if asks else None,
                         'share_ask_le_99c_pct': round(100 * float(np.mean(np.array(asks) <= 0.99)), 1) if asks else None,
                         'trade_now_eligible': elig, 'cautious_fills': len(pc), 'cautious_pnl_c': round(float(np.mean(pc)), 2) if pc else None,
                         'cautious_total_usd_10lot': round(float(np.sum(pc)) / 10, 2) if pc else 0.0,
                         'visible_pnl_c': round(float(np.mean(pv)), 2) if pv else None, 'visible_total_usd_10lot': round(float(np.sum(pv)) / 10, 2) if pv else 0.0}
        print(sname, T, out[sname][T], flush=True)
json.dump(out, open(os.path.join(L.ROOT, 'results/fixed_time_trade.json'), 'w'), indent=1)
