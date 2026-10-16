"""markets.ndjson -> markets_clean.ndjson: keeps markets with Kalshi's own strike, official value and result; logs every exclusion.
No value is repaired or inferred (e.g. a strike of 7.24 is excluded, not rebuilt from the subtitle)."""
import json, sys
src, dst, log = sys.argv[1], sys.argv[2], sys.argv[3]
keep, drop = [], []
for l in open(src):
    r = json.loads(l)
    why = None
    if r['official'] is None or r['strike'] is None:
        why = 'no strike or official value published (early rule, Dec 2025 - Jan 2026, or missing field)'
    elif r['result'] not in ('yes', 'no'):
        why = 'no result'
    elif not (0.5 < r['strike'] / r['official'] < 2):
        why = 'implausible strike %s vs official %s' % (r['strike'], r['official'])
    elif (round(r['official'], 2) >= r['strike']) != (r['result'] == 'yes'):
        why = 'result inconsistent with official >= strike'
    (drop if why else keep).append((r, why))
with open(dst, 'w') as f:
    for r, _ in keep:
        f.write(json.dumps(r) + '\n')
with open(log, 'w') as f:
    for r, why in drop:
        f.write(json.dumps({'ticker': r['ticker'], 'closeTs': r['closeTs'], 'why': why}) + '\n')
print(json.dumps({'kept': len(keep), 'excluded': len(drop)}))
