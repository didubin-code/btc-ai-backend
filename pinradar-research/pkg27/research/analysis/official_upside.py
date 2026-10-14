"""Upper-bound value of the official feed in close calls: windows 2.6 never LOCKED, where the official-reference model
(As, emulated with the window's realised basis = hindsight) reaches <= 0.2 % flip risk with <= 20 s left. What did Kalshi
offer at that second, and what would buying at the visible ask + 1c have earned? (EMULATION, not validated with real BRTI)
out: results/official_upside.json"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L
from common import kalshi_fee_cents
from actionable import quote
out = {}
for sname, rows in L.SETS.items():
    fA = L.first_lock('A', rows)
    res = []
    for k, i in enumerate(rows):
        if fA[k] is not None: continue
        tp = L.get_tape(i)
        for tau in range(20, 2, -1):
            f = L.FL['As'][i, tau]
            if not (f <= 0.002): continue
            side = int(L.SD['S'][i, tau]); won = (side > 0) == bool(L.yes[i])
            q = quote(tp[0 if side > 0 else 1], float(L.C[i] - tau)) if tp else None
            res.append({'contract': str(L.tick[i]), 'tau': tau, 'side': 'UP' if side > 0 else 'DOWN', 'won': won, 'ask': q, 'margin': round(float(L.A[i] - L.K[i]), 2)})
            break
    priced = [r for r in res if r['ask'] is not None]
    def pnl(rs): return [100 * ((1 if r['won'] else 0) - min(0.99, r['ask'] + 0.01) - kalshi_fee_cents(min(0.99, r['ask'] + 0.01), 10) / 100) for r in rs]
    p_all = pnl(priced); p90 = pnl([r for r in priced if r['ask'] >= 0.90])
    out[sname] = {'windows_2_6_never_locked': int(sum(1 for x in fA if x is None)), 'official_locks_le_20s': len(res), 'won': sum(r['won'] for r in res),
                  'with_visible_ask': len(priced), 'ask_quartiles_c': [round(100 * float(np.percentile([r['ask'] for r in priced], q)), 1) for q in (25, 50, 75)] if priced else None,
                  'pnl_c_per_contract_any_ask': round(float(np.mean(p_all)), 2) if p_all else None, 'n_any_ask': len(p_all),
                  'pnl_c_per_contract_ask_ge_90': round(float(np.mean(p90)), 2) if p90 else None, 'n_ask_ge_90': len(p90),
                  'losers': [r for r in res if not r['won']]}
    print(sname, {k: v for k, v in out[sname].items() if k != 'losers'}, 'losers', out[sname]['losers'])
json.dump(out, open(os.path.join(L.ROOT, 'results/official_upside.json'), 'w'), indent=1)
