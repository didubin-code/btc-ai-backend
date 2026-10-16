"""Which wrong LOCKED calls would each safeguard have kept out of a trade? (Question C of the validation.)
For every wrong first-LOCKED call in the replay: seconds left, whether Kalshi's tape exists, the called side's last traded price, and whether
  * the 15 s buffer of 2.8.1 refuses TRADE NOW (first LOCKED with < 15 s left; 2.8 had no buffer),
  * the 90 c market-disagreement guard refuses TRADE NOW (last traded price of the called side < 90 c; present in 2.8 and 2.8.1),
  * the call is no longer LOCKED on the same side at T-20 (the 'still LOCKED at T-20' entry rule).
The same counts for correct calls show what each safeguard costs.
  python3 prevented.py --records replay.ndjson --exec-rows exec_rows.ndjson --out prevented.json"""
import argparse, json

U2_END, U1_START = 1784678400, 1791936000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--records', required=True)
    ap.add_argument('--exec-rows', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    ex = {}
    for l in open(a.exec_rows):
        r = json.loads(l)
        if r['rule'] == 'first':
            ex[r['ticker']] = r
    res = {}
    recs = [json.loads(l) for l in open(a.records)]
    for sp, keep in (('U (U1+U2)', lambda t: t < U2_END or t >= U1_START), ('all', lambda t: True)):
        rows = []
        for r in recs:
            f = r.get('firstLocked')
            if not f or f.get('correct') is None or not keep(r['closeTs']):
                continue
            e = ex.get(r['ticker'], {})
            tape = bool(e) and not e.get('noTape', False)
            t20 = r['fixed'].get('20') or {}
            rows.append({'ticker': r['ticker'], 'correct': f['correct'], 'tau': f['tau'], 'side': f['side'], 'margin': r['marginUsd'], 'tape': tape,
                         'lastPx': e.get('lastCalledSidePriceCents'), 'buffer15': f['tau'] < 15, 'guard90': bool(tape and e.get('guardBlocks')),
                         'notLockedSameSideAtT20': not (t20.get('st') in ('LOCKED', 'PROVEN LOCKED') and t20.get('side') == f['side'])})
        W = [x for x in rows if not x['correct']]
        C = [x for x in rows if x['correct']]
        cnt = lambda xs, k: sum(1 for x in xs if x[k])
        res[sp] = {'wrongFirstLocked': len(W), 'correctFirstLocked': len(C), 'wrongWithTape': cnt(W, 'tape'), 'correctWithTape': cnt(C, 'tape'),
                   'blockedBy15sBuffer': {'wrong': cnt(W, 'buffer15'), 'correct': cnt(C, 'buffer15')},
                   'blockedBy90cGuard (tape only)': {'wrong': cnt(W, 'guard90'), 'correct': cnt(C, 'guard90')},
                   'blockedByBufferOrGuard': {'wrong': sum(1 for x in W if x['buffer15'] or x['guard90']), 'correct': sum(1 for x in C if x['buffer15'] or x['guard90'])},
                   'wrongWithTapeNotBlocked': [x for x in W if x['tape'] and not (x['buffer15'] or x['guard90'])],
                   'wrongNoTapeNotBuffered': sum(1 for x in W if not x['tape'] and not x['buffer15']),
                   'T20ruleAvoids': {'wrong': cnt(W, 'notLockedSameSideAtT20'), 'correctAlsoSkipped': cnt(C, 'notLockedSameSideAtT20')}}
    json.dump(res, open(a.out, 'w'), indent=1)
    for sp, v in res.items():
        print(sp, json.dumps({k: (len(x) if isinstance(x, list) else x) for k, x in v.items()}))
        for x in v['wrongWithTapeNotBlocked']:
            print('   not blocked:', x['ticker'], x['side'], 'tau', x['tau'], 'margin', x['margin'], 'last px', x['lastPx'])


if __name__ == '__main__':
    main()
