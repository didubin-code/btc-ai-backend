"""Summarize test/stress_engine.js output: per shock time and size."""
import json, sys
from collections import defaultdict
d = json.load(open(sys.argv[1]))
rows = d['rows']
tab = defaultdict(lambda: defaultdict(int))
for r in rows:
    if r['pre_state'] not in ('LOCKED', 'PROVEN LOCKED'): continue
    k = (r['shock_tau'], r['X']); t = tab[k]
    t['n'] += 1
    a1 = r['after1'] or {}
    fl = r['settlement_flips'] is True
    t['flips'] += fl
    t['still_locked_1s'] += a1.get('state') in ('LOCKED', 'PROVEN LOCKED')
    t['rev_1s'] += a1.get('state') == 'REVERSAL WARNING'
    t['rev_any'] += r['first_reversal_warning_tau'] is not None
    if fl:
        t['flip_still_locked_1s'] += a1.get('state') in ('LOCKED', 'PROVEN LOCKED')
        t['flip_rev_1s'] += a1.get('state') == 'REVERSAL WARNING'
        t['flip_rev_any_ge3'] += (r['first_reversal_warning_tau'] or -1) >= 3
    else:
        t['noflip_rev_1s'] += a1.get('state') == 'REVERSAL WARNING'
out = {}
print(f"{'T-s':>4} {'$X':>4} {'n':>4} | {'settle flips':>12} | {'still LOCKED +1s':>16} | {'REV WARN +1s':>12} | flips: {'LOCKED+1s':>9} {'REV+1s':>6} {'REV>=T-3':>8} | no-flip REV+1s")
for (s, X), t in sorted(tab.items(), key=lambda z: (-z[0][0], z[0][1])):
    n = t['n']; f = t['flips']
    out[f'T-{s} ${X}'] = dict(t)
    print(f"{s:4d} {X:4d} {n:4d} | {f:5d} ({100*f/n:5.1f}%) | {t['still_locked_1s']:5d} ({100*t['still_locked_1s']/n:5.1f}%) | {t['rev_1s']:4d} ({100*t['rev_1s']/n:5.1f}%) | "
          f"{t['flip_still_locked_1s']:9d} {t['flip_rev_1s']:6d} {t['flip_rev_any_ge3']:8d} | {t['noflip_rev_1s']}")
json.dump({'server': d['server'], 'mean_eval_ms': d['mean_eval_ms'], 'table': out}, open(sys.argv[2], 'w'), indent=1)
