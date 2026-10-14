"""Does recent momentum toward the strike predict reversals beyond the model's flip risk?
For every window and second (tau 1..300) where a variant's flip risk is in [0.1 %, 5 %]: realized flip frequency vs
mean predicted, split by 15 s momentum relative to the leader (adverse = moving toward the strike) and by tau zone.
Pooled over windows (each window contributes many correlated seconds -> also report window-level counts)."""
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import settle_metrics_lib as L
out = {}
for v in ('A', 'As'):
    out[v] = {}
    for sname, rows in L.SETS.items():
        f = L.FL[v][rows][:, 1:301]; sd = L.SD[L.SIDEOF[v]][rows][:, 1:301]; m = L.mom[rows][:, 1:301]
        y = L.yes[rows][:, None]
        lost = ((sd > 0) != y) & (sd != 0)
        adv = -np.sign(sd) * m                                   # > 0: price moving toward the strike (against the leader)
        taus = np.arange(1, 301)[None, :].repeat(len(rows), 0)
        res = {}
        for zone, (a, b) in (('final 20 s', (1, 21)), ('20-60 s', (21, 61)), ('60-300 s', (61, 301))):
            for band, (lo, hi) in (('0.1-0.5%', (0.001, 0.005)), ('0.5-2%', (0.005, 0.02)), ('2-5%', (0.02, 0.05))):
                for mb, (ml, mh) in (('adverse >=2s', (2, 99)), ('adverse 1-2s', (1, 2)), ('flat', (-1, 1)), ('favourable', (-99, -1))):
                    q = np.isfinite(f) & (f >= lo) & (f < hi) & (taus >= a) & (taus < b) & np.isfinite(adv) & (adv >= ml) & (adv < mh)
                    if q.sum() < 50: continue
                    wins = np.unique(np.nonzero(q)[0])
                    res[f'{zone} | {band} | {mb}'] = {'seconds': int(q.sum()), 'windows': int(len(wins)), 'pred_pct': round(100 * float(f[q].mean()), 3),
                                                      'obs_pct_seconds': round(100 * float(lost[q].mean()), 3),
                                                      'windows_lost': int(lost[wins, :].any(axis=1).sum()) if False else int(sum(lost[w][q[w]].any() for w in wins))}
        out[v][sname] = res
json.dump(out, open(os.path.join(L.ROOT, 'results/momentum_diag.json'), 'w'), indent=1)
for v in out:
    for s in out[v]:
        print('==', v, s)
        for k, x in out[v][s].items(): print(f'  {k:42s} sec {x["seconds"]:7d} win {x["windows"]:5d} pred {x["pred_pct"]:6.3f}% obs {x["obs_pct_seconds"]:6.3f}% windows_lost {x["windows_lost"]}')
