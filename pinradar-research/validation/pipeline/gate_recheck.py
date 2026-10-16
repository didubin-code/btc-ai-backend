"""Why were large-margin windows never LOCKED? Replays each never-LOCKED window with |official margin| >= --min-margin on its own
(1 h warm-up, so the basis model is nearly cold; the states at T-30 ... T-3 match the main replay) with the current replay_chrono.js,
which records the gate reason at each fixed time, and tallies the reasons and the volatility readings.
  python3 gate_recheck.py --records replay.ndjson --server ../../2.8.1/dist/pinradar_server.js --sec sec --markets markets_clean.ndjson --work dir --out gate_recheck.json [--reuse]"""
import argparse, collections, concurrent.futures, datetime, json, os, re, subprocess


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', required=True)
    ap.add_argument('--server', required=True)
    ap.add_argument('--sec', required=True)
    ap.add_argument('--markets', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--min-margin', type=float, default=100)
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--reuse', action='store_true', help='tally existing per-window outputs in --work without replaying')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)
    iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    sel = []
    for l in open(a.records):
        r = json.loads(l)
        if r.get('truth') in ('UP', 'DOWN') and not r.get('firstLocked') and abs(r['marginUsd']) >= a.min_margin:
            sel.append(r)
    here = os.path.dirname(os.path.abspath(__file__))

    def run(r):
        out = os.path.join(a.work, r['ticker'] + '.ndjson')
        if not (a.reuse and os.path.exists(out)):
            subprocess.run(['node', os.path.join(here, '..', 'replay_chrono.js'), '--server', a.server, '--sec', a.sec, '--venues', 'proxy', '--proxy-dir', 'usdc',
                            '--markets', a.markets, '--from', iso(r['closeTs'] - 60), '--to', iso(r['closeTs'] + 1), '--warm', '3600', '--out', out],
                           check=True, stderr=subprocess.DEVNULL)
        return out
    with concurrent.futures.ThreadPoolExecutor(a.jobs) as ex:
        outs = list(ex.map(run, sel))
    reasons, lows, allv, locked = collections.Counter(), [], [], 0
    for fn in outs:
        for l in open(fn):
            x = json.loads(l)
            locked += bool(x.get('firstLocked'))
            g = [v['gate'] for v in x['fixed'].values() if v and v.get('gate')]
            reasons[tuple(sorted(set('volatility outside validated range' if s.startswith('volatility') else s[:60] for s in g)))] += 1
            vs = [float(re.search(r'volatility ([0-9.]+)', s).group(1)) for s in g if s.startswith('volatility')]
            if vs:
                lows.append(min(vs))
                allv += vs
    res = {'windows': len(sel), 'lockedInRerun': locked, 'gateReasons': {' + '.join(k) or 'none': v for k, v in reasons.items()},
           'perWindowLowestVolatility': [min(lows), max(lows)] if lows else None, 'allVolatilityReadings': [min(allv), max(allv)] if allv else None,
           'byMonth': collections.Counter(iso(r['closeTs'])[:7] for r in sel)}
    json.dump(res, open(a.out, 'w'), indent=1)
    print(json.dumps(res))


if __name__ == '__main__':
    main()
