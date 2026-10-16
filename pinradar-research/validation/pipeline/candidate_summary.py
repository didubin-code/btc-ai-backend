"""Side-by-side summary of the 0.2 % LOCKED-threshold candidate (replay/thr02_usdc.ndjson) and 2.8.1 on U and seen, plus U2 trading
(trading2[_thr02]_U2_L0_buf15 / _L12_buf15). Writes thr02_summary.json and thr02_summary.md in the data dir.  python3 candidate_summary.py"""
import json, sys
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from decisive import stat
D = '/home/user/data_val'
U2_END, U1_START = 1784678400, 1791936000
def load(fn):
    R = [json.loads(l) for l in open(fn)]
    return [r for r in R if r.get('truth') in ('UP', 'DOWN')]
def summ(R):
    fl = [r for r in R if r.get('firstLocked')]
    t20 = [r for r in R if (r['fixed'].get('20') or {}).get('st') in ('LOCKED', 'PROVEN LOCKED')]
    return {'windows': len(R), 'coverage': round(100 * len(fl) / len(R), 2), 'first': stat(sum(1 for r in fl if not r['firstLocked']['correct']), len(fl)),
            't20': stat(sum(1 for r in t20 if r['fixed']['20']['side'] != r['truth']), len(t20)), 'medTau': sorted(r['firstLocked']['tau'] for r in fl)[len(fl) // 2]}
out = {}
for name, fn in (('2.8.1', 'replay/r281_usdc.ndjson'), ('thr02', 'replay/thr02_usdc.ndjson')):
    R = load(f'{D}/{fn}')
    out[name] = {'U': summ([r for r in R if r['closeTs'] < U2_END or r['closeTs'] >= U1_START]), 'seen': summ([r for r in R if U2_END <= r['closeTs'] < U1_START])}
a = json.load(open(f'{D}/trading2_U2_L0_buf15.json')); b = json.load(open(f'{D}/trading2_thr02_U2_L0_buf15.json'))
a12 = json.load(open(f'{D}/trading2_U2_L12_buf15.json')); b12 = json.load(open(f'{D}/trading2_thr02_U2_L12_buf15.json'))
out['trading'] = {k: {C: (t['model:first']['C%d_vwap' % C]) for C in (100, 1000)} for k, t in (('2.8.1', a), ('thr02', b), ('2.8.1_L12', a12), ('thr02_L12', b12))}
json.dump(out, open(f'{D}/thr02_summary.json', 'w'), indent=1)
f = lambda s: '%d / %s (%.3f %%, CI %.3f–%.3f %%)' % (s['k'], format(s['n'], ','), s['ratePct'], *s['ci95Pct'])
g = lambda s: '%d / %s (bound %.3f %%)' % (s['k'], format(s['n'], ','), s['upper95OneSidedPct'])
tr = lambda x: '%+.2f ¢ (CI %+.2f to %+.2f), %s trades, %d lost, $%s' % (x['meanCentsPerContract'], *x['ci95BootDays'], format(x['trades'], ','), x['lost'], format(round(x['totalUsd']), ','))
o = out
md = ['   | | 2.8.1 (0.5 %) | 0.2 % threshold |', '   |---|---|---|',
      '   | U: first LOCKED wrong | %s | %s |' % (f(o['2.8.1']['U']['first']), f(o['thr02']['U']['first'])),
      '   | U: LOCKED at T−20 wrong | %s | %s |' % (g(o['2.8.1']['U']['t20']), g(o['thr02']['U']['t20'])),
      '   | U: coverage | %.1f %% | %.1f %% |' % (o['2.8.1']['U']['coverage'], o['thr02']['U']['coverage']),
      '   | U: median seconds left at first LOCKED | %.0f | %.0f |' % (o['2.8.1']['U']['medTau'], o['thr02']['U']['medTau']),
      '   | seen (in-sample for this candidate): first LOCKED wrong | %s | %s |' % (f(o['2.8.1']['seen']['first']), f(o['thr02']['seen']['first'])),
      '   | U2 trading, first LOCKED, 100 contracts, 15 s buffer | %s | %s |' % (tr(o['trading']['2.8.1'][100]), tr(o['trading']['thr02'][100])),
      '   | same with the page\'s 12 s order time | %s | %s |' % (tr(o['trading']['2.8.1_L12'][100]), tr(o['trading']['thr02_L12'][100])),
      '   | same, 1,000 contracts, 12 s order time | %s | %s |' % (tr(o['trading']['2.8.1_L12'][1000]), tr(o['trading']['thr02_L12'][1000]))]
open(f'{D}/thr02_summary.md', 'w').write('\n'.join(md) + '\n')
print('\n'.join(md))
