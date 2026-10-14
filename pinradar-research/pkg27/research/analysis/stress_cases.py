"""Stress-test inputs: real historical 1 Hz paths of windows that 2.6 had LOCKED at the shock second, plus every
window's final-minute path for the empirical shock frequencies.
out: stress/cases.ndjson (one window per line, replay_archive.js format + shock_tau, leader)
     results/shock_frequency.json"""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L
from evidence26 import GROUP
SA = np.load(os.path.join(L.ROOT, 'data/derived/sec_all.npz')); TA = int(SA['T0']); ia = SA['idx']; nv = SA['nven']
rng = np.random.default_rng(27)
rows = np.concatenate([L.SETS['holdout'], L.SETS['dev_folds1_6']])
TAUS = (60, 45, 30, 20, 15, 10, 5, 3)
n_out = 0
with open(os.path.join(L.ROOT, 'stress/cases.ndjson'), 'w') as fh:
    for ts in TAUS:
        cand = [i for i in rows if np.isfinite(L.FL['A'][i, ts]) and L.FL['A'][i, ts] <= 0.005]
        pick = rng.choice(cand, size=min(120, len(cand)), replace=False)
        for i in pick:
            C = int(L.C[i]); T_first = C - 1300
            idx = ia[T_first - TA: C - TA + 1]
            if not np.all(np.isfinite(idx)): continue
            fh.write(json.dumps({'ticker': str(L.tick[i]), 'C': C, 'K': float(L.K[i]), 'A': float(L.A[i]), 'yes': bool(L.yes[i]), 'mu': float(L.D['mu'][i]),
                                 'T_first': T_first, 'idx': [round(float(x), 2) for x in idx], 'nven': [int(x) for x in nv[T_first - TA: C - TA + 1]],
                                 'shock_tau': ts, 'leader': int(L.SD['A'][i, ts]), 'set': 'holdout' if L.hold[i] else 'dev'}) + '\n')
            n_out += 1
print('cases', n_out)
# empirical frequency of moves of each size inside the final minute (all windows, both sets)
out = {}
grp = lambda i, t: ['quiet', 'normal', 'active'][GROUP.get(int(L.bucket[i, t]), 1)]
for ts in TAUS:
    C = L.C[rows]; base = ia[C - ts - TA]
    path = np.stack([ia[C - k - TA] for k in range(ts - 1, -1, -1)], axis=1)        # seconds after the decision, to the close
    dev = path - base[:, None]
    worst = np.maximum(np.nanmax(dev, axis=1), -np.nanmin(dev, axis=1))                 # largest excursion either way before the close
    remavg = np.abs(np.nanmean(dev, axis=1))                                             # |remaining-window average - spot| (what moves the settlement)
    g = np.array([grp(i, ts) for i in rows])
    res = {}
    for X in (5, 10, 25, 50, 65, 100):
        res[f'${X}'] = {'P_excursion_ge_X_pct': round(100 * float(np.mean(worst >= X)), 3),
                        'P_remaining_avg_shift_ge_X_pct': round(100 * float(np.mean(remavg >= X)), 3),
                        'by_regime_excursion_pct': {gg: round(100 * float(np.mean(worst[g == gg] >= X)), 3) for gg in ('quiet', 'normal', 'active')}}
    out[f'T-{ts}'] = {'windows': int(len(rows)), 'median_abs_excursion_usd': round(float(np.median(worst)), 2), 'p99_abs_excursion_usd': round(float(np.percentile(worst, 99)), 2), 'X': res}
json.dump(out, open(os.path.join(L.ROOT, 'results/shock_frequency.json'), 'w'), indent=1)
for k, v in out.items(): print(k, v['median_abs_excursion_usd'], v['p99_abs_excursion_usd'], {x: (y['P_excursion_ge_X_pct'], y['P_remaining_avg_shift_ge_X_pct']) for x, y in v['X'].items()})
