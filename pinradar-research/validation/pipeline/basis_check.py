"""How well does each 1 Hz feed track Kalshi's official settlement average? For every clean market: e = official - mean(feed prints
C-59..C). Reports the level, the one-step error of the server's own basis predictor (EWMA, half-life 4 windows, prior mean 0, n0 50),
and how often |error| exceeds $5 / $10 / $20. The feed with the smallest one-step error is the most faithful stand-in for the live
3-venue index (whose own error is learned the same way live).
  python3 basis_check.py --markets markets_clean.ndjson --sec data/sec --feeds proxy,usdc,kr,cb --out basis.json"""
import argparse, datetime, json, math, os, struct


def loader(sec, feed):
    cache = {}

    def get(t):
        d = datetime.datetime.fromtimestamp(t, datetime.timezone.utc).date().isoformat()
        if d not in cache:
            fn = os.path.join(sec, feed, d + '.f64')
            cache[d] = struct.unpack('<86400d', open(fn, 'rb').read()) if os.path.exists(fn) else None
            if len(cache) > 4:
                cache.pop(next(iter(cache)))
        a = cache[d]
        if a is None:
            return math.nan
        return a[t - int(datetime.datetime.fromisoformat(d + 'T00:00:00+00:00').timestamp())]
    return get


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--markets', required=True)
    p.add_argument('--sec', required=True)
    p.add_argument('--feeds', default='proxy,usdc')
    p.add_argument('--out', required=True)
    a = p.parse_args()
    ms = [json.loads(l) for l in open(a.markets)]
    res = {}
    for feed in a.feeds.split(','):
        get = loader(a.sec, feed)
        es = []
        for m in ms:
            v = [get(t) for t in range(m['closeTs'] - 59, m['closeTs'] + 1)]
            if any(math.isnan(x) for x in v):
                continue
            es.append((m['closeTs'], m['official'] - sum(v) / 60))
        if not es:
            res[feed] = None
            continue
        al = 1 - 0.5 ** (1 / 4)
        mu, n0, errs = 0.0, 50, []
        for _, e in es:
            errs.append(e - mu)
            mu += al * (e - mu)
        sd = lambda x: math.sqrt(sum(y * y for y in x) / len(x))
        q = sorted(abs(x) for x in errs)
        res[feed] = {'windows': len(es), 'meanLevel': round(sum(e for _, e in es) / len(es), 3), 'rawSd': round(sd([e - sum(x for _, x in es) / len(es) for _, e in es]), 3),
                     'oneStepErrSd': round(sd(errs), 3), 'oneStepAbsP50': round(q[len(q) // 2], 3), 'oneStepAbsP99': round(q[int(0.99 * (len(q) - 1))], 3),
                     'shareAbsErrOver5': round(sum(1 for x in errs if abs(x) > 5) / len(errs), 4), 'shareAbsErrOver10': round(sum(1 for x in errs if abs(x) > 10) / len(errs), 4),
                     'shareAbsErrOver20': round(sum(1 for x in errs if abs(x) > 20) / len(errs), 4),
                     'from': datetime.datetime.fromtimestamp(es[0][0], datetime.timezone.utc).isoformat(), 'to': datetime.datetime.fromtimestamp(es[-1][0], datetime.timezone.utc).isoformat()}
    json.dump(res, open(a.out, 'w'), indent=1)
    print(json.dumps(res, indent=1))


if __name__ == '__main__':
    main()
