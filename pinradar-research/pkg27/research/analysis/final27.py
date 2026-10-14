"""Final comparison table (requested metrics) + every disagreement of the deployed 2.7 official-mode rule with 2.6.
Inputs: results/settle_metrics.json, results/settle_extra.json, data/derived/settle_eval.npz.
out: results/final27_table.json, results/final27_table.csv, results/settle_disagreements_27.csv"""
import csv, json, os, sys
from collections import Counter
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L

M = json.load(open(os.path.join(L.ROOT, 'results/settle_metrics.json')))
X = json.load(open(os.path.join(L.ROOT, 'results/settle_extra.json')))
COLS = [('A', 'BTC Pin Radar 2.6 (= 2.7 without the official feed)'), ('AgS', '2.7 with official BRTI (gate) [emulated]'),
        ('As', 'official BRTI, no basis term, same threshold [emulated]'), ('Asr', 'official BRTI recalibrated [emulated]'),
        ('As@0.2%', 'official BRTI, LOCKED <= 0.2% [emulated]'), ('A@0.2%', '2.6 with LOCKED <= 0.2%'),
        ('Aq', '2.6 without the active-tape factor'), ('C', '2.5 (no regime factors)'), ('B', 'Gaussian settlement model')]
def get(sname, v):
    if v in M[sname]['variants']: return M[sname]['variants'][v]
    return X[sname][v]
rows = []
for sname in ('holdout', 'dev_folds1_6'):
    for v, label in COLS:
        r = get(sname, v)
        L_ = r['locked']
        ece = r['ece_pct_at_fixed_times']
        tc, tv = r['trade_now_CONS'], r['trade_now_VISIBLE']
        def acc(b): return None if not b['n'] else f"{b['n'] - b['lost']}/{b['n']} ({100 * (b['n'] - b['lost']) / b['n']:.2f}%)"
        rows.append({'set': sname, 'model': v, 'label': label, 'windows': M[sname]['windows'],
                     'LOCKED predictions': L_['n'], 'LOCKED wins': L_['n'] - L_['lost'], 'LOCKED losses': L_['lost'],
                     'False LOCKED rate %': L_['false_pct'], 'False LOCKED 95% CI %': L_['ci95_pct'],
                     'Accuracy, first LOCKED under 60 s': acc(r['first_lock_under_60s']), 'Accuracy, first LOCKED at 15-20 s': acc(r['first_lock_15_20s']),
                     'Accuracy, first LOCKED under 10 s': acc(r['first_lock_under_10s']),
                     'Calibration error (ECE %, mean of T-60..T-3)': round(float(np.mean([float(x) for x in ece.values()])), 3),
                     'ECE % at T-30 / T-10': f"{ece['30']} / {ece['10']}",
                     'Actionable opportunities (TRADE NOW, cautious / visible fills)': f"{tc.get('trades', 0)} / {tv.get('trades', 0)}",
                     'TRADE NOW losses (cautious / visible)': f"{tc.get('losses', 0)} / {tv.get('losses', 0)}",
                     'Average lead time s (mean / median)': f"{r['lead_mean_s']} / {r['lead_median_s']}",
                     'Missed opportunities (windows never LOCKED)': r['missed_windows'],
                     'Net profit after fees, $ per 10-lot (cautious / visible)': f"{tc.get('usd_per_10lot', 0)} / {tv.get('usd_per_10lot', 0)}",
                     'Profit per contract c (cautious, 95% CI)': f"{tc.get('pnl_c_per_contract')} {tc.get('pnl_ci95_c')}",
                     'LOCKED shown at T-60/30/15/10/5/3 (lost)': ' '.join(f"{x['locked']}({x['lost']})" for T, x in r['locked_at_fixed_times'].items() if T in ('60', '30', '15', '10', '5', '3'))})
json.dump(rows, open(os.path.join(L.ROOT, 'results/final27_table.json'), 'w'), indent=1)
with open(os.path.join(L.ROOT, 'results/final27_table.csv'), 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); [w.writerow({k: (json.dumps(v) if isinstance(v, list) else v) for k, v in r.items()}) for r in rows]
for r in rows:
    print(r['set'][:4], f"{r['model']:7s}", 'LOCK', r['LOCKED predictions'], 'lost', r['LOCKED losses'], f"{r['False LOCKED rate %']}%", '| <60', r['Accuracy, first LOCKED under 60 s'],
          '| 15-20', r['Accuracy, first LOCKED at 15-20 s'], '| <10', r['Accuracy, first LOCKED under 10 s'], '| ECE', r['Calibration error (ECE %, mean of T-60..T-3)'],
          '| TN', r['Actionable opportunities (TRADE NOW, cautious / visible fills)'], '| lead', r['Average lead time s (mean / median)'], '| missed', r['Missed opportunities (windows never LOCKED)'],
          '| $', r['Net profit after fees, $ per 10-lot (cautious / visible)'])

# ---- every disagreement of the official-mode rule (AgS) with 2.6, first LOCKED per window ----
fa, fs = L.FL['A'], L.FL['As']; sa, ss = L.SD['A'], L.SD['S']
agree = (sa == ss) & (sa != 0)
L.FL['AgS'] = np.where(agree & (fs <= 0.05), fa, np.maximum(fa, 0.0501)).astype(np.float32); L.FC['AgS'] = np.maximum(L.FC['A'], L.FL['AgS']); L.SIDEOF['AgS'] = 'A'
dis = []; cnt = Counter()
for sname, rws in L.SETS.items():
    fA = L.first_lock('A', rws); fG = L.first_lock('AgS', rws)
    for k, i in enumerate(rws):
        a_, g_ = fA[k], fG[k]
        if a_ == g_: continue
        y = bool(L.yes[i]); ca = None if a_ is None else ((a_[1] > 0) == y); cg = None if g_ is None else ((g_[1] > 0) == y)
        if ca is False and cg is not False: kind = 'improvement: wrong 2.6 LOCKED withheld'
        elif ca and cg is None: kind = 'coverage loss: correct 2.6 LOCKED withheld'
        elif ca and cg: kind = 'same correct call, later'
        elif ca is False and cg is False: kind = 'same wrong call, later'
        else: kind = 'other'
        cnt[(sname, kind)] += 1
        dis.append({'set': sname, 'contract': str(L.tick[i]), 'actual': 'UP' if y else 'DOWN', '2.6 first LOCKED': None if a_ is None else f"{'UP' if a_[1] > 0 else 'DOWN'} at T-{a_[0]}",
                    '2.7 official-mode first LOCKED': None if g_ is None else f"{'UP' if g_[1] > 0 else 'DOWN'} at T-{g_[0]}", 'kind': kind, 'official margin $': round(float(L.A[i] - L.K[i]), 2)})
with open(os.path.join(L.ROOT, 'results/settle_disagreements_27.csv'), 'w', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=list(dis[0].keys()) if dis else ['set']); w.writeheader(); [w.writerow(d) for d in dis]
print('AgS vs 2.6 disagreements:', dict(cnt))
for d in dis:
    if 'improvement' in d['kind'] or 'loss' in d['kind'] or 'wrong' in d['kind']: print(d)
