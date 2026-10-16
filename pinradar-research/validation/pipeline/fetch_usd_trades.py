"""USD venue trade tapes -> 1 Hz last-trade series (the constituents the live server uses: Coinbase BTC-USD, Kraken XBT/USD).
UNTESTED until api.exchange.coinbase.com / api.kraken.com are reachable. Output per UTC day: <out>/<cb|kr>/<YYYY-MM-DD>.f64 = 86,400
float64 LE: the last trade price at or before each second if that trade is at most --stale seconds old, else NaN.

  python3 fetch_usd_trades.py --venue kr --from 2026-07-01 --to 2026-10-16 --out data/sec
  python3 fetch_usd_trades.py --venue cb --from 2026-07-01 --to 2026-10-16 --out data/sec

Coinbase pages backwards by trade id (CB-AFTER header); the start id is found by bisection on trade ids. Kraken pages forward with
`since` (nanoseconds). Both write a per-day checkpoint so an interrupted run resumes."""
import argparse, bisect, datetime, json, math, os, struct, sys
import http_util as H

CB = 'https://api.exchange.coinbase.com/products/BTC-USD/trades'
KR = 'https://api.kraken.com/0/public/Trades'


def day_bounds(d):
    t0 = int(datetime.datetime(d.year, d.month, d.day, tzinfo=datetime.timezone.utc).timestamp())
    return t0, t0 + 86400


def to_series(trades, t0, stale):
    """trades: [(unix_seconds_float, price)] sorted by time -> last price at or before each second within `stale` s."""
    arr = [math.nan] * 86400
    ts = [t for t, _ in trades]
    for k in range(86400):
        s = t0 + k + 1                                  # strictly before the end of second k
        i = bisect.bisect_left(ts, s) - 1
        if i >= 0 and s - ts[i] <= stale:
            arr[k] = trades[i][1]
    return arr


def kraken_day(d):
    t0, t1 = day_bounds(d)
    since, out = str(t0 * 10 ** 9), []
    while True:
        j = H.get(KR, {'pair': 'XBTUSD', 'since': since}, host_min_interval=1.1).json()
        if j.get('error'):
            raise RuntimeError(str(j['error']))
        res = j['result']
        key = [k for k in res if k != 'last'][0]
        rows = res[key]
        for r in rows:
            t = float(r[2])
            if t0 <= t < t1:
                out.append((t, float(r[0])))
        last = res['last']
        if not rows or float(rows[-1][2]) >= t1 or last == since:
            break
        since = last
    out.sort()
    return out


def cb_page(after=None):
    p = {'limit': 1000}
    if after:
        p['after'] = after
    r = H.get(CB, p, host_min_interval=0.2)
    return r.json(), r.headers.get('CB-AFTER')


def cb_time(t):
    return datetime.datetime.fromisoformat(t['time'].replace('Z', '+00:00')).timestamp()


def cb_find_id(target_ts, hi_id):
    """smallest trade id whose time is >= target_ts (bisection on ids; each probe is one request)."""
    lo, hi = 1, hi_id
    while hi - lo > 1000:
        mid = (lo + hi) // 2
        page, _ = cb_page(after=mid + 1)               # trades with id < mid+1, newest first
        if not page:
            lo = mid
            continue
        if cb_time(page[0]) < target_ts:
            lo = mid
        else:
            hi = mid
    return hi


def coinbase_day(d, latest_id):
    t0, t1 = day_bounds(d)
    end_id = cb_find_id(t1, latest_id)
    out, after = [], end_id + 1
    while True:
        page, nxt = cb_page(after=after)
        if not page:
            break
        for t in page:
            tt = cb_time(t)
            if t0 <= tt < t1:
                out.append((tt, float(t['price'])))
        if cb_time(page[-1]) < t0 or not nxt:
            break
        after = nxt
    out.sort()
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--venue', choices=['cb', 'kr'], required=True)
    p.add_argument('--from', dest='frm', required=True)
    p.add_argument('--to', required=True)
    p.add_argument('--out', default='data/sec')
    p.add_argument('--stale', type=float, default=30.0)
    a = p.parse_args()
    od = os.path.join(a.out, a.venue)
    os.makedirs(od, exist_ok=True)
    H.init(os.path.join(a.out, 'PROVENANCE_%s.ndjson' % a.venue))
    latest = None
    if a.venue == 'cb':
        page, _ = cb_page()
        latest = page[0]['trade_id']
    d = datetime.date.fromisoformat(a.frm)
    while d < datetime.date.fromisoformat(a.to):
        fn = os.path.join(od, d.isoformat() + '.f64')
        if not os.path.exists(fn):
            trades = kraken_day(d) if a.venue == 'kr' else coinbase_day(d, latest)
            t0, _ = day_bounds(d)
            arr = to_series(trades, t0, a.stale)
            with open(fn + '.tmp', 'wb') as f:
                f.write(struct.pack('<86400d', *arr))
            os.replace(fn + '.tmp', fn)
            with open(fn.replace('.f64', '.json'), 'w') as f:
                json.dump({'day': d.isoformat(), 'venue': a.venue, 'trades': len(trades), 'secondsWithoutPrice': sum(1 for x in arr if math.isnan(x)), 'staleSec': a.stale}, f)
            print(a.venue, d, len(trades), 'trades', file=sys.stderr)
        d += datetime.timedelta(days=1)


if __name__ == '__main__':
    main()
