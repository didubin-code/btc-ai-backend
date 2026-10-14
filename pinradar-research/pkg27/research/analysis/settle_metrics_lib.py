"""Shared loaders for the settlement-model evaluation scripts (settle_eval.npz + Kalshi tapes)."""
import gzip, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, kalshi_fee_cents
from actionable import quote, fwd_fill

D = np.load(os.path.join(ROOT, 'data/derived/settle_eval.npz'), allow_pickle=True)
tick, C, K, A, yes, fold, hold = D['tick'], D['C'], D['K'], D['A'], D['yes'], D['fold'], D['hold']
TAUS = D['taus']; mom = D['mom15']; bucket = D['bucket']
VAR = ('A', 'C', 'Aq', 'B', 'As', 'Cs')
SIDEOF = {'A': 'A', 'C': 'A', 'Aq': 'A', 'B': 'B', 'As': 'S', 'Cs': 'S'}
FL = {v: D[f'FL_{v}'] for v in VAR}; FC = {v: D[f'FC_{v}'] for v in VAR}; SD = {k: D[f'SIDE_{k}'] for k in ('A', 'S', 'B')}
LIM = 0.005
SETS = {'holdout': np.nonzero(hold & (fold == -1))[0], 'dev_folds1_6': np.nonzero((~hold) & (fold >= 1))[0]}

_tpz = np.load(os.path.join(ROOT, 'data/derived/tapes.npz')); TP = {k: _tpz[k] for k in _tpz.files}   # decompress once
tp_ix = {str(t): i for i, t in enumerate(TP['ticker'])}
def tape(tk):
    if tk in tp_ix:
        i = tp_ix[tk]; a, b = TP['off'][i], TP['off'][i + 1]
        ts, sd, px, n = TP['ts'][a:b], TP['side'][a:b], TP['px'][a:b].astype(float), TP['n'][a:b].astype(float)
        return [(ts[sd == s], px[sd == s], n[sd == s]) for s in (0, 1)]
    fn = os.path.join(ROOT, 'data/kalshi/tapes', tk + '.csv.gz')
    if not os.path.exists(fn): return None
    o = {0: [], 1: []}
    with gzip.open(fn, 'rt') as fh:
        for line in fh:
            p = line.rstrip().split(',')
            if len(p) < 4 or p[1] not in ('yes', 'no'): continue
            s = 0 if p[1] == 'yes' else 1; yp = float(p[2]); o[s].append((float(p[0]), yp if s == 0 else round(1 - yp, 4), float(p[3])))
    res = []
    for s in (0, 1):
        a = sorted(o[s]); res.append((np.array([x[0] for x in a]), np.array([x[1] for x in a]), np.array([x[2] for x in a])))
    return res
TAPE = {}
def get_tape(i):
    tk = str(tick[i])
    if tk not in TAPE: TAPE[tk] = tape(tk)
    return TAPE[tk]

def limit_for(pwc, size=10, min_edge=0.005, cap=0.99):
    lim = min(cap, math.floor((pwc - min_edge) * 100) / 100)
    while lim > 0.5 and pwc - lim - kalshi_fee_cents(lim, size) / 100 < min_edge: lim = round(lim - 0.01, 2)
    return lim

# ---------------- metric helpers (same definitions as settle_metrics.py) ----------------
from study import cp_two
def first_lock(v, rows, lim=LIM):
    f = FL[v][rows][:, 1:][:, ::-1]
    hit = np.nan_to_num(f, nan=1.0) <= lim + 1e-12
    anyh = hit.any(axis=1); j = np.argmax(hit, axis=1)
    taus = TAUS[1:][::-1]
    out = []
    for k, i in enumerate(rows):
        if not anyh[k]: out.append(None); continue
        tau = int(taus[j[k]]); out.append((tau, int(SD[SIDEOF[v]][i, tau])))
    return out

def blk(n, k):
    return {'n': n, 'lost': k, 'acc_pct': None if not n else round(100 * (n - k) / n, 3), 'false_pct': None if not n else round(100 * k / n, 3),
            'ci95_pct': [None if x is None else round(100 * x, 3) for x in cp_two(k, n)]}

def trade_now(v, rows, fl_list, mode, lim_flip=LIM):
    tr = []
    for k, i in enumerate(rows):
        if fl_list[k] is None: continue
        tp = get_tape(i)
        if tp is None: continue
        y = bool(yes[i])
        for tau in range(197, 2, -1):
            f = FL[v][i, tau]
            if not (f <= lim_flip + 1e-12): continue
            side = int(SD[SIDEOF[v]][i, tau]); si = 0 if side > 0 else 1; t = float(C[i] - tau)
            q = quote(tp[si], t)
            if q is None: continue
            lim = limit_for(1 - float(FC[v][i, tau]))
            if lim <= 0.5 or q > lim + 1e-9 or q < 0.90 - 1e-9: continue
            won = (side > 0) == y
            if mode == 'VISIBLE': px = min(lim, q + 0.01)
            elif not won: px = min(lim, q + 0.01)
            else:
                px = fwd_fill(tp[si], t, lim, 2.0, 5.0, 10, 0.01)
                if px is None: continue
            tr.append({'i': int(i), 'tau': tau, 'won': won, 'px': px, 'pnl_c': 100 * ((1.0 if won else 0.0) - px - kalshi_fee_cents(px, 10) / 100)})
            break
    if not tr: return {'trades': 0}
    p = np.array([x['pnl_c'] for x in tr]); kk = sum(1 for x in tr if not x['won'])
    se = p.std(ddof=1) / math.sqrt(len(p)) if len(p) > 1 else float('nan')
    return {'trades': len(tr), 'losses': kk, 'loss_ci95_pct': [round(100 * x, 3) for x in cp_two(kk, len(tr))], 'avg_px_c': round(100 * float(np.mean([x['px'] for x in tr])), 2),
            'pnl_c_per_contract': round(float(p.mean()), 3), 'pnl_ci95_c': [round(float(p.mean() - 1.96 * se), 3), round(float(p.mean() + 1.96 * se), 3)],
            'usd_per_10lot': round(float(p.sum()) / 10, 2), 'median_tau': float(np.median([x['tau'] for x in tr]))}

def evaluate_variant(v, rows, lim=LIM):
    fl = first_lock(v, rows, lim)
    Lk = [(rows[k], x) for k, x in enumerate(fl) if x]
    wrong = [(i, x) for i, x in Lk if (x[1] > 0) != bool(yes[i])]
    taus = [x[0] for i, x in Lk]
    def sub(lo, hi):
        S_ = [(i, x) for i, x in Lk if lo <= x[0] < hi]; return blk(len(S_), sum(1 for i, x in S_ if (x[1] > 0) != bool(yes[i])))
    r = {'locked': blk(len(Lk), len(wrong)), 'coverage_pct': round(100 * len(Lk) / len(rows), 2),
         'lead_mean_s': round(float(np.mean(taus)), 1) if taus else None, 'lead_median_s': float(np.median(taus)) if taus else None,
         'first_lock_under_60s': sub(1, 60), 'first_lock_60s_plus': sub(60, 301), 'first_lock_15_20s': sub(15, 21), 'first_lock_under_10s': sub(1, 10),
         'missed_windows': len(rows) - len(Lk), 'wrong_contracts': [str(tick[i]) + f" {'UP' if x[1] > 0 else 'DOWN'}@T-{x[0]}" for i, x in wrong]}
    fx = {}; cal = {}
    for T in (60, 45, 30, 20, 15, 10, 5, 3):
        f = FL[v][rows, T]; sd = SD[SIDEOF[v]][rows, T]; okk = np.isfinite(f) & (sd != 0)
        lost = (sd > 0) != yes[rows]
        lk = okk & (f <= lim + 1e-12)
        fx[T] = {'locked': int(lk.sum()), 'lost': int((lk & lost).sum()), 'share_pct': round(100 * lk.sum() / max(1, okk.sum()), 2)}
        ece = 0.0; nn = int(okk.sum())
        for a_, b_ in ((0, .001), (.001, .005), (.005, .01), (.01, .05), (.05, .1), (.1, .25), (.25, .5001)):
            mm = okk & (f >= a_) & (f < b_)
            if mm.sum(): ece += mm.sum() * abs(float(f[mm].mean()) - float(lost[mm].mean()))
        cal[T] = round(100 * ece / max(1, nn), 4)
    r['locked_at_fixed_times'] = fx; r['ece_pct_at_fixed_times'] = cal
    r['trade_now_CONS'] = trade_now(v, rows, fl, 'CONS', lim); r['trade_now_VISIBLE'] = trade_now(v, rows, fl, 'VISIBLE', lim)
    return r, fl
