"""Kalshi KXBTC15M history (public market-data endpoints; no account, no orders).
UNTESTED until api.elections.kalshi.com is reachable: run `probe` first; it prints each endpoint's status and field names so the
parsers below can be checked against the live format before any bulk download.

  python3 fetch_kalshi.py probe
  python3 fetch_kalshi.py markets  --out data/kalshi            # every settled KXBTC15M market -> markets_raw/*.json + markets.ndjson
  python3 fetch_kalshi.py trades   --out data/kalshi --last 300 # each market's trade prints in its final N seconds -> trades/<ticker>.json.gz
  python3 fetch_kalshi.py candles  --out data/kalshi            # 1-minute bid/ask candles over each window -> candles/<ticker>.json.gz

markets.ndjson rows: {ticker, openTs, closeTs, strike, official, result, rawStatus}. `official` is Kalshi's expiration_value (the
CF Benchmarks BRTI average the contract settles on); `result` is Kalshi's own yes/no. Nothing is derived or filled in."""
import argparse, datetime, glob, gzip, json, os, sys
import http_util as H

BASE = 'https://api.elections.kalshi.com/trade-api/v2'
SERIES = 'KXBTC15M'


def ts(iso):
    return int(datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp()) if iso else None


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def probe(_a):
    tries = [('markets', BASE + '/markets', {'series_ticker': SERIES, 'limit': 2}),
             ('markets settled', BASE + '/markets', {'series_ticker': SERIES, 'status': 'settled', 'limit': 2}),
             ('series', BASE + '/series/' + SERIES, None),
             ('historical markets', BASE + '/historical/markets', {'series_ticker': SERIES, 'limit': 2}),
             ('historical cutoff', BASE + '/historical/cutoff', None)]
    sample = None
    for name, url, p in tries:
        try:
            r = H.get(url, p, ok_404=True)
            j = r.json() if r.headers.get('content-type', '').startswith('application/json') else {}
            ks = list(j.keys())
            ms = j.get('markets') or []
            print('%-20s %s keys=%s' % (name, r.status_code, ks))
            if ms:
                print('   market fields:', sorted(ms[0].keys()))
                print('   example:', {k: ms[0].get(k) for k in ('ticker', 'open_time', 'close_time', 'floor_strike', 'result', 'expiration_value', 'status')})
                sample = sample or ms[0]['ticker']
        except Exception as e:  # noqa: BLE001
            print('%-20s ERROR %s' % (name, e))
    if sample:
        for name, url, p in [('trades', BASE + '/markets/trades', {'ticker': sample, 'limit': 2}),
                             ('candlesticks', BASE + '/series/%s/markets/%s/candlesticks' % (SERIES, sample), {'period_interval': 1})]:
            try:
                r = H.get(url, p, ok_404=True)
                j = r.json()
                print('%-20s %s keys=%s' % (name, r.status_code, list(j.keys())))
                for k in ('trades', 'candlesticks'):
                    if j.get(k):
                        print('   fields:', sorted(j[k][0].keys()), '\n   example:', j[k][0])
            except Exception as e:  # noqa: BLE001
                print('%-20s ERROR %s' % (name, e))


def page_all(url, params, key):
    cursor, n = None, 0
    while True:
        p = dict(params)
        if cursor:
            p['cursor'] = cursor
        j = H.get(url, p).json()
        yield j
        n += len(j.get(key) or [])
        cursor = j.get('cursor')
        if not cursor or not j.get(key):
            return


def markets(a):
    os.makedirs(os.path.join(a.out, 'markets_raw'), exist_ok=True)
    seen = {}
    for src, url in (('live', BASE + '/markets'), ('historical', BASE + '/historical/markets')):
        try:
            for i, j in enumerate(page_all(url, {'series_ticker': SERIES, 'status': 'settled', 'limit': 1000}, 'markets')):
                with open(os.path.join(a.out, 'markets_raw', '%s_%05d.json' % (src, i)), 'w') as f:
                    json.dump(j, f)
                for m in j.get('markets') or []:
                    seen.setdefault(m['ticker'], m)
                print(src, 'page', i, 'markets so far', len(seen), file=sys.stderr)
        except Exception as e:  # noqa: BLE001
            print(src, 'endpoint failed:', e, file=sys.stderr)
    rows = []
    for m in seen.values():
        rows.append({'ticker': m['ticker'], 'openTs': ts(m.get('open_time')), 'closeTs': ts(m.get('close_time')),
                     'strike': fnum(m.get('floor_strike')), 'official': fnum(m.get('expiration_value')),
                     'result': m.get('result'), 'rawStatus': m.get('status')})
    rows.sort(key=lambda r: r['closeTs'] or 0)
    with open(os.path.join(a.out, 'markets.ndjson'), 'w') as f:
        for r in rows:
            f.write(json.dumps(r) + '\n')
    print(json.dumps({'markets': len(rows), 'first': rows[0]['closeTs'] if rows else None, 'last': rows[-1]['closeTs'] if rows else None}))


def per_market(a, sub, fetch_one):
    os.makedirs(os.path.join(a.out, sub), exist_ok=True)
    ms = [json.loads(l) for l in open(os.path.join(a.out, a.markets))]
    if a.since:
        ms = [m for m in ms if m['closeTs'] >= ts(a.since)]
    done = 0
    for m in ms:
        fn = os.path.join(a.out, sub, m['ticker'] + '.json.gz')
        if os.path.exists(fn):
            continue                                   # resumable
        data = fetch_one(m)
        with gzip.open(fn + '.tmp', 'wt') as f:
            json.dump(data, f)
        os.replace(fn + '.tmp', fn)
        done += 1
        if done % 200 == 0:
            print(sub, done, 'of', len(ms), file=sys.stderr)
    print(json.dumps({sub: done, 'markets': len(ms)}))


HIST_CUT = None


def trades(a):
    global HIST_CUT
    if HIST_CUT is None:                               # trades before this moment live in the historical store
        HIST_CUT = ts(H.get(BASE + '/historical/cutoff').json().get('trades_created_ts'))

    def one(m):
        out, src = [], ('/historical/trades' if HIST_CUT and m['closeTs'] < HIST_CUT else '/markets/trades')
        for path in (src, '/markets/trades' if src != '/markets/trades' else '/historical/trades'):
            for j in page_all(BASE + path, {'ticker': m['ticker'], 'limit': 1000, 'min_ts': m['closeTs'] - a.last, 'max_ts': m['closeTs'] + 5}, 'trades'):
                out.extend(j.get('trades') or [])
            if out:
                src = path
                break
        return {'ticker': m['ticker'], 'closeTs': m['closeTs'], 'window': a.last, 'source': src, 'trades': out}
    per_market(a, 'trades', one)


def candles(a):
    def one(m):
        j = H.get(BASE + '/series/%s/markets/%s/candlesticks' % (SERIES, m['ticker']),
                  {'start_ts': m['closeTs'] - 900, 'end_ts': m['closeTs'], 'period_interval': 1}, ok_404=True)
        return {'ticker': m['ticker'], 'status': j.status_code, 'body': j.json() if j.status_code == 200 else None}
    per_market(a, 'candles', one)


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('cmd', choices=['probe', 'markets', 'trades', 'candles'])
    p.add_argument('--out', default='data/kalshi')
    p.add_argument('--last', type=int, default=300)
    p.add_argument('--since', default=None)
    p.add_argument('--markets', default='markets.ndjson')
    a = p.parse_args()
    H.init(os.path.join(a.out, 'PROVENANCE.ndjson'))
    {'probe': probe, 'markets': markets, 'trades': trades, 'candles': candles}[a.cmd](a)
