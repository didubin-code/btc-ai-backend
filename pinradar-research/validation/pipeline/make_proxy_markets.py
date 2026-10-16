"""Long-horizon PROXY windows (clearly not Kalshi contracts): one window per UTC quarter hour over the 1 Hz proxy history.
  strike   = the proxy price at the window's open second (C - 900)
  official = round2(mean of the 60 proxy prints C-59 .. C)       (all 60 present, else the window is skipped)
  result   = 'yes' iff official >= strike
These test the engine's price-path model (volatility, jumps, settlement averaging) over years of BTC behaviour. They do NOT test
the proxy-to-BRTI basis or Kalshi execution: outcomes are defined by the same proxy the engine sees.
  python3 make_proxy_markets.py --sec data/sec --from 2023-10-01 --to 2026-10-16 --out data/proxy_markets.ndjson"""
import argparse, datetime, json, math, os, struct


def load(sec, day):
    fn = os.path.join(sec, 'proxy', day + '.f64')
    if not os.path.exists(fn):
        return None
    b = open(fn, 'rb').read()
    return struct.unpack('<86400d', b)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--sec', default='data/sec')
    p.add_argument('--from', dest='frm', required=True)
    p.add_argument('--to', required=True)
    p.add_argument('--out', required=True)
    a = p.parse_args()
    d, end = datetime.date.fromisoformat(a.frm), datetime.date.fromisoformat(a.to)
    n = skipped = 0
    with open(a.out, 'w') as f:
        prev = None
        while d < end:
            arr = load(a.sec, d.isoformat())
            if arr is None:
                d += datetime.timedelta(days=1)
                prev = None
                continue
            t0 = int(datetime.datetime(d.year, d.month, d.day, tzinfo=datetime.timezone.utc).timestamp())
            for q in range(1, 97):                     # closes at 00:15 ... 24:00
                C = t0 + q * 900
                k_open = q * 900 - 900
                strike = arr[k_open] if k_open < 86400 else math.nan
                last = [arr[k] if k < 86400 else math.nan for k in range(q * 900 - 59, q * 900 + 1)]
                if q == 96:                            # the close second 24:00:00 is the next day's second 0
                    nxt = load(a.sec, (d + datetime.timedelta(days=1)).isoformat())
                    last[-1] = nxt[0] if nxt else math.nan
                if math.isnan(strike) or any(math.isnan(x) for x in last):
                    skipped += 1
                    continue
                off = round(sum(last) / 60 + 1e-9, 2)
                f.write(json.dumps({'ticker': 'PROXY15M-' + datetime.datetime.fromtimestamp(C, datetime.timezone.utc).strftime('%Y%m%dT%H%M'),
                                    'openTs': C - 900, 'closeTs': C, 'strike': round(strike, 2), 'official': off,
                                    'result': 'yes' if off >= round(strike, 2) else 'no', 'proxy': True}) + '\n')
                n += 1
            d += datetime.timedelta(days=1)
    print(json.dumps({'windows': n, 'skipped': skipped}))


if __name__ == '__main__':
    main()
