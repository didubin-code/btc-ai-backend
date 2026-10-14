"""Extra candidate models built from the same per-second arrays (no new information, no tuning on the holdout):
  Asr   official-feed emulation (As inputs, no basis term) RE-CALIBRATED for itself: walk-forward ratios per vol group
        = (observed + 2) / (predicted + 2) flips at each window's first 99 % crossing, fitted on earlier dev folds only;
        holdout uses ratios from all dev folds (same procedure that produced 2.6's ratios)
  AgS   2.6 + official-reference gate: LOCKED only if the official-reference model agrees on the side and puts the
        flip risk below 5 % (only removes calls; cannot add any)
  AnAs  both models at <= 0.5 % on the same side (strict intersection)
  A_lim LOCKED threshold sweep for 2.6 (0.2 %, 0.3 %, 1 %) and As (0.2 %, 0.3 %) - reported for the trade-off curve only
out: results/settle_extra.json"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L
from evidence26 import recal, GROUP

fold, hold = L.fold, L.hold
Wn = len(L.C)
grp = np.vectorize(lambda b: GROUP.get(int(b), 1))(L.bucket)            # [Wn, 301]
lost_side = lambda sd, i: (sd > 0) != bool(L.yes[i])

def ratios(raw, side, sel):
    obs = np.zeros(3); pred = np.zeros(3)
    for i in np.nonzero(sel)[0]:
        f = raw[i, 1:301][::-1]; ok = np.isfinite(f) & (f <= 0.01)
        if not ok.any(): continue
        j = int(np.argmax(ok)); tau = 300 - j
        g = grp[i, tau]; obs[g] += lost_side(side[i, tau], i); pred[g] += float(raw[i, tau])
    return [float((obs[g] + 2) / (pred[g] + 2)) for g in range(3)], obs.tolist(), pred.tolist()

raw, rawc, sideS = L.FL['Cs'], L.FC['Cs'], L.SD['S']
vrec = np.vectorize(recal)
FLr = np.full_like(raw, np.nan); FCr = np.full_like(rawc, np.nan)
R = {}
dev = (~hold) & (fold >= 0)
for k in sorted(set(int(x) for x in np.unique(fold) if x >= -1)):
    sel_rows = (fold == k)
    trainsel = dev & (fold < k) if k >= 0 else dev
    r, o, p = ratios(raw, sideS, trainsel)
    R[k] = {'ratios_quiet_normal_active': [round(x, 3) for x in r], 'obs': o, 'pred': [round(x, 2) for x in p]}
    rr = np.array(r)[grp[sel_rows]]
    a = raw[sel_rows]; b = rawc[sel_rows]
    q = np.isfinite(a); a2 = np.full_like(a, np.nan); a2[q] = vrec(a[q], rr[q]); FLr[sel_rows] = a2
    q = np.isfinite(b); b2 = np.full_like(b, np.nan); b2[q] = vrec(b[q], rr[q]); FCr[sel_rows] = b2
    print('fold', k, R[k], flush=True)
L.FL['Asr'] = FLr.astype(np.float32); L.FC['Asr'] = FCr.astype(np.float32); L.SIDEOF['Asr'] = 'S'
# official-reference gate on 2.6
fa, fs = L.FL['A'], L.FL['As']; sa, ss = L.SD['A'], L.SD['S']
agree = (sa == ss) & (sa != 0)
L.FL['AgS'] = np.where(agree & (fs <= 0.05), fa, np.maximum(fa, 0.0501)).astype(np.float32); L.FC['AgS'] = np.maximum(L.FC['A'], L.FL['AgS']); L.SIDEOF['AgS'] = 'A'
L.FL['AnAs'] = np.where(agree, np.maximum(fa, fs), 0.5).astype(np.float32); L.FC['AnAs'] = np.maximum(L.FC['A'], L.FL['AnAs']); L.SIDEOF['AnAs'] = 'A'
out = {'asr_ratios_by_fold': R}
for sname, rows in L.SETS.items():
    out[sname] = {}
    for v, lim in (('Asr', L.LIM), ('AgS', L.LIM), ('AnAs', L.LIM), ('A', 0.002), ('A', 0.003), ('A', 0.01), ('As', 0.002), ('As', 0.003), ('Asr', 0.003)):
        r, fl = L.evaluate_variant(v, rows, lim)
        key = v if abs(lim - L.LIM) < 1e-12 else f'{v}@{100 * lim:.1f}%'
        out[sname][key] = r
        print(sname, key, 'locked', r['locked']['n'], 'lost', r['locked']['lost'], f"{r['locked']['false_pct']}%", 'cov', r['coverage_pct'], 'lead', r['lead_mean_s'], '/', r['lead_median_s'],
              '| <60', r['first_lock_under_60s']['n'], r['first_lock_under_60s']['lost'], '| TN cons', r['trade_now_CONS'].get('trades'), r['trade_now_CONS'].get('losses'), r['trade_now_CONS'].get('pnl_c_per_contract'),
              '| vis', r['trade_now_VISIBLE'].get('trades'), r['trade_now_VISIBLE'].get('losses'), r['trade_now_VISIBLE'].get('pnl_c_per_contract'), flush=True)
json.dump(out, open(os.path.join(L.ROOT, 'results/settle_extra.json'), 'w'), indent=1, default=float)
print('saved')
