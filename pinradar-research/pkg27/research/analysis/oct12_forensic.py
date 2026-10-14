"""Second-by-second reconstruction of KXBTC15M-26OCT122045-45 (Oct 12 2026 5:45 PM PT, settled DOWN by $2.55).
Inputs: our 1 Hz index (Coinbase/Kraken proxy; no historical BRTI without Kalshi credentials), the official strike and
settlement, the exact 2.6 replay (special_out.ndjson), the model tables (model_final.json, Python implementation with
verified parity), Kalshi's public trade tape for the contract.
'Official-emulated' values add the window's measured basis B = official average - our-index average (assumed constant
within the minute: an approximation, stated as such).   out: archive2/out/oct12_forensic.json + printed table"""
import gzip, json, math, sys
import numpy as np
sys.argv = ['x', '/home/claude/pr25/build/out/model_final.json']
src = open('/home/claude/pr25/test/parity_model.py').read(); src = src[: src.index('rng = np.random.default_rng(7)')]
ns = {}; exec(compile(src, 'parity_model', 'exec'), ns)
sys.path.insert(0, '/home/claude/pr25/analysis'); sys.path.insert(0, '/home/claude/pr25/src')
from evidence26 import recal
M = ns['M']; edges = M['regime']['edges']
TK = 'KXBTC15M-26OCT122045-45'
w = next(json.loads(l) for l in open('/home/claude/pr25/archive2/special_in.ndjson') if TK in l)
o = next(json.loads(l) for l in open('/home/claude/pr25/archive2/special_out.ndjson') if TK in l)
C, T0, idx, K, A, mu = w['C'], w['T_first'], w['idx'], w['K'], w['A'], w['mu']
at = lambda T: idx[T - T0]
prints = [at(C - off) for off in range(60)]                  # off 0 = close tick ... 59
proxy_avg = sum(prints) / 60; B = A - proxy_avg
rows = {r[0]: r for r in o['rows'] if r[18] is None}
# Kalshi tape: last taker-buy price of each side in the 10 s before t
tape = {'yes': [], 'no': []}
with gzip.open(f'/home/claude/pr25/data/kalshi/tapes/{TK}.csv.gz', 'rt') as fh:
    for line in fh:
        p = line.rstrip().split(',')
        if p[1] in tape: tape[p[1]].append((float(p[0]), float(p[2]) if p[1] == 'yes' else round(1 - float(p[2]), 4)))
def seen(side, t):
    xs = [px for ts, px in tape[side] if t - 10 < ts <= t]
    return xs[-1] if xs else None
def u_units(tau):
    d = sorted(x for x in (tau - off for off in range(60)) if x > 1e-9); n = len(d)
    return sum(d[i] * (2 * (n - 1 - i) + 1) for i in range(n)) / 3600, n
out = []
print(f'{TK}: strike {K}, official {A} (DOWN by {K - A:.2f}); our-index 60-tick average {proxy_avg:.2f}; basis B = {B:+.2f}')
print(' T-  n  recAvg-K(idx) recAvg-K(off) spot-K(off) critical-K  move_needed  jump_in_5s  restAvg-K(actual) | 2.6 flip  raw flip  noBasis flip  gauss flip | UP ask  DOWN ask')
for tau in (60, 50, 45, 40, 35, 30, 25, 20, 18, 16, 15, 14, 13, 12, 10, 8, 5, 3, 1):
    t = C - tau; n = 60 - tau; r = tau
    rec = [at(C - off) for off in range(tau, 60)]
    S = at(t); S_off = S + B
    rec_avg = sum(rec) / n if n else S; rec_off = rec_avg + B
    crit = (60 * (K - 0.005) - n * rec_off) / r
    exp_set = (n * rec_off + r * S_off) / 60
    lead = 'UP' if exp_set >= K - 0.005 else 'DOWN'
    move = (S_off - crit) if lead == 'UP' else (crit - S_off)
    rest_actual = sum(at(C - off) for off in range(0, tau)) / r + B
    rr = rows.get(tau)
    flip26 = rr[4] if rr else None; praw = rr[7] if rr else None
    raw_flip = min(praw, 1 - praw) if praw is not None else None
    sig = rr[12] if rr else None; gap = rr[9] if rr else None
    bk = int(np.searchsorted(edges, sig / 1.03, side='right')) if sig else 3
    # same model with the basis term removed and the official-emulated gap (what the authoritative feed would give)
    pnb = ns['p_up'](tau, gap + B - mu, sig, S, 0.0, bk) if sig else None
    Mb = dict(M); M['basisQ'] = [0.0] * len(M['basisQ']); pnb = ns['p_up'](tau, gap + B, sig, S, 0.0, bk); M.update(Mb)
    flip_nb = min(pnb, 1 - pnb)
    flip_nb26 = recal(flip_nb, 0.52 if rr and rr[13] == 'active' else (2.02 if rr and rr[13] == 'quiet' else 1.0))
    uu, nn = u_units(tau); sp = sig * S * 1e-4 * math.sqrt(uu); sdb = float(np.std(M['basisQ']))
    from math import erf
    gz = (gap + mu) / math.sqrt(sp * sp + sdb * sdb); pg = 0.5 * (1 + erf(gz / math.sqrt(2)))
    ya, na = seen('yes', t), seen('no', t)
    rec_d = {'tau': tau, 'n_recorded': n, 'recorded_avg_minus_K_our_index': round(rec_avg - K, 2), 'recorded_avg_minus_K_official_emulated': round(rec_off - K, 2),
             'spot_minus_K_official_emulated': round(S_off - K, 2), 'critical_remaining_avg_minus_K': round(crit - K, 2), 'leader': lead,
             'move_needed_from_spot': round(move, 2), 'jump_needed_if_it_starts_in_5s': round(move * r / (r - 5), 2) if r > 5 else None,
             'actual_rest_avg_minus_K': round(rest_actual - K, 2), 'flip_2_6_pct': round(100 * flip26, 3) if flip26 is not None else None,
             'flip_raw_model_pct': round(100 * raw_flip, 3) if raw_flip is not None else None, 'flip_official_feed_2_6_pct': round(100 * flip_nb26, 3),
             'flip_gaussian_pct': round(100 * min(pg, 1 - pg), 3), 'sigma_bps': sig, 'regime': rr[13] if rr else None,
             'remaining_path_sd_usd': round(sp, 2), 'state_2_6': rr[1] if rr else None, 'up_ask_seen_c': None if ya is None else round(100 * ya, 1), 'down_ask_seen_c': None if na is None else round(100 * na, 1)}
    out.append(rec_d)
    print(f"{tau:3d} {n:2d} {rec_avg - K:12.2f} {rec_off - K:13.2f} {S_off - K:11.2f} {crit - K:11.2f} {move:12.2f} {str(rec_d['jump_needed_if_it_starts_in_5s']):>11s} {rest_actual - K:16.2f}  | "
          f"{rec_d['flip_2_6_pct']:7} {rec_d['flip_raw_model_pct']:8} {rec_d['flip_official_feed_2_6_pct']:11} {rec_d['flip_gaussian_pct']:10} | {rec_d['up_ask_seen_c']} {rec_d['down_ask_seen_c']}  {rec_d['state_2_6']}")
json.dump({'ticker': TK, 'strike': K, 'official': A, 'our_index_avg': round(proxy_avg, 2), 'basis': round(B, 2), 'mu_used_by_engine': round(mu, 2), 'rows': out},
          open('/home/claude/pr25/archive2/out/oct12_forensic.json', 'w'), indent=1)
# index path in the final 20 s
print('index - K, last 20 s:', [round(at(C - k) - K, 1) for k in range(20, -1, -1)])
