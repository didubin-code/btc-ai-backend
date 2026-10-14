"""Settlement-aware model comparison on IDENTICAL inputs, every second from T-300 to T-0, for every KXBTC15M window
Jul 22 - Oct 13 2026.
Development = walk-forward weekly folds Aug 28 - Oct 13 (tables / basis / regime ratios learned only before each fold).
Holdout     = every window that closed before Aug 13 12:00 UTC: never used to build, tune or choose anything.
              Its tables = the shipped 2.6 tables (all data Aug 13 12:00 - Oct 13), ratios = shipped 2.6 ratios.
Variants (flip risk of the leading side):
  A   2.6 shipped: empirical remaining-average path law per vol band + basis mixture (our index vs official) + regime ratios
  C   2.5: A without the regime ratios
  Aq  A with the quiet-tape ratio only (active-tape ratio 1.0)
  B   Gaussian settlement arithmetic: exact remaining-tick variance, normal tails, normal basis
  As  A fed the official settlement reference: our index + the window's measured basis (assumed constant inside the
      minute) and no basis uncertainty  -> emulates Kalshi's cfbenchmarks_value BRTI feed (upper bound of its benefit)
  Cs  C fed the same emulated official reference
Outputs data/derived/settle_eval.npz (flip arrays, float32) for the metrics script."""
import json, math, os, sys, time
import numpy as np
from math import erf
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, load_sec, var_units
from build_windows import rolling_vol
from model import sigma_hat, TAU_GRID, ewma_basis, regime_var, regime_bucket, NB
from predict import basis_quantiles, p_up_fast, folds_weekly
from fit import clean_mask, all_Z, tables_from
from evidence26 import recal, GROUP

DER = os.path.join(ROOT, 'data/derived')
TAUS = np.arange(0, 301)
DEV_START = 1786622400                     # Aug 13 12:00 UTC (first second of the shipped model's data)
t0 = time.time()
def log(*a): print(f'[{time.time() - t0:6.0f}s]', *a, flush=True)

# ---------------- model tables from the development data (exactly the research / shipped pipeline) ----------------
sec = load_sec(); T0 = int(sec['T0']); idx = sec['idx']
vols = {L: rolling_vol(idx, L)[0] for L in (120, 900)}
sig = sigma_hat(vols, 'rms:120,900')
clean = clean_mask(sec)
Zs = {}
for tau in TAU_GRID:
    Zs[int(tau)] = all_Z(idx, sig, clean, int(tau)).astype(np.float32)
bsec = regime_bucket(regime_var(idx, sig))
log('Z built', len(Zs))
del vols

# ---------------- windows for every market Jul 22 - Oct 13 from the extended index ----------------
SA = np.load(os.path.join(DER, 'sec_all.npz')); TA = int(SA['T0']); ia = SA['idx']
vA = {L: rolling_vol(ia, L)[0] for L in (15, 120, 900)}
sigA = sigma_hat({120: vA[120], 900: vA[900]}, 'rms:120,900')
bA = regime_bucket(regime_var(ia, sigA))
def num(x):
    try: return float(str(x).replace(',', ''))
    except (TypeError, ValueError): return None
hist = json.load(open(os.path.join(ROOT, 'data/kalshi/markets_hist.json'))); live = json.load(open(os.path.join(ROOT, 'data/kalshi/markets.json')))
CUT = 1786665600
mk = {m['ticker']: m for m in hist if m['close'] < CUT}; mk.update({m['ticker']: m for m in live if m['close'] >= CUT})
order = sorted(mk.values(), key=lambda m: m['close'])
prevA = {b['ticker']: num(a.get('expiration_value')) for a, b in zip(order, order[1:]) if int(round(b['close'] - a['close'])) == 900}
rows = []
for m in order:
    if m.get('result') not in ('yes', 'no'): continue
    K = num(m.get('floor_strike')); A = num(m.get('expiration_value'))
    if K is None: K = prevA.get(m['ticker'])
    C = int(round(m['close']))
    if K is None or A is None or C - 1900 < TA or C > TA + len(ia) - 1: continue
    rows.append((C, m['ticker'], K, A, m['result'] == 'yes'))
Wn = len(rows)
C = np.array([r[0] for r in rows]); tick = np.array([r[1] for r in rows]); K = np.array([r[2] for r in rows]); A = np.array([r[3] for r in rows]); yes = np.array([r[4] for r in rows])
offs = np.arange(0, 60)
Pr = ia[(C[:, None] - offs[None, :]) - TA]                                   # the 60 ticks (incl alignment: C-59 .. C)
proxy_avg = Pr.mean(axis=1); basis = A - proxy_avg
t = C[:, None] - TAUS[None, :]
S = ia[t - TA]
known = offs[None, :] >= TAUS[:, None]                                        # [tau, 60] tick known at decision time
F = np.nan_to_num(Pr) @ known.T.astype(float)
m = known.sum(axis=1)[None, :].repeat(Wn, 0)
known_nan = (np.isnan(Pr).astype(float) @ known.T.astype(float)) > 0
gap = (F + (60 - m) * S) / 60.0 - K[:, None]
sw = sigA[t - TA]; bw = bA[t - TA]
mom15 = (S - ia[t - 15 - TA]) / (sw * S * 1e-4 * math.sqrt(15))             # 15 s index move in sigma units (signed)
ok = np.isfinite(S) & ~known_nan & np.isfinite(sw) & (sw > 0)
mu = np.full(Wn, np.nan)
dev = C > DEV_START; hold = ~dev
for sel in (hold, dev):                                                        # one-step-ahead EWMA inside each period
    ii = np.nonzero(sel)[0]; mu[ii] = ewma_basis(basis[ii], 4)
resid = basis - mu
log('windows', Wn, 'holdout', int(hold.sum()), 'dev', int(dev.sum()))

# ---------------- predictions ----------------
VAR = ('A', 'C', 'Aq', 'B', 'As', 'Cs')
FL = {v: np.full((Wn, len(TAUS)), np.nan, np.float32) for v in VAR}
FC = {v: np.full((Wn, len(TAUS)), np.nan, np.float32) for v in VAR}    # conservative flip (vol x1.25, basis x1.25) for the trade limit
SIDE = {k: np.zeros((Wn, len(TAUS)), np.int8) for k in ('A', 'S', 'B')}     # leader per reference: A/C/Aq use 'A', As/Cs 'S', B 'B'
fold_of = np.full(Wn, -2)
Rf = json.load(open(os.path.join(ROOT, 'results/evidence26.json')))['recal']['ratiosByFold']
FINAL_R = [2.02, 1.00, 0.52]
def ratios_for(k): return [float(x) for x in Rf[str(k)]] if k >= 0 else FINAL_R
def gauss_up(g, s_, S_, tau, sdb, vm=1.0):
    u, n = var_units(int(tau))
    sp = s_ * vm * S_ * 1e-4 * math.sqrt(max(u, 0))
    z = g / np.sqrt(sp * sp + sdb * sdb + 1e-18)
    return 0.5 * (1 + np.vectorize(erf)(z / math.sqrt(2)))
sets = [(-1, hold, len(idx), dev)]                                             # holdout: final tables, basis from all dev windows
for k, (a, b) in enumerate(folds_weekly(1787875200, 1791904500)):           # Aug 28 00:00 -> Oct 13 15:15 UTC
    sets.append((k, dev & (C >= a) & (C < b), max(0, a - T0 - 310), dev & (C < a)))
for k, sel, upto, trw in sets:
    rows_ = np.nonzero(sel)[0]
    if not len(rows_): continue
    fold_of[rows_] = k
    tabs = tables_from(Zs, upto, bsec)
    good = trw & np.isfinite(resid)
    bq = basis_quantiles(resid[good]); sdb = float(np.std(bq))
    rat = ratios_for(k)
    for j, tau in enumerate(TAUS):
        g = gap[rows_, j]; s_ = sw[rows_, j]; S_ = S[rows_, j]; mm = mu[rows_]; bb_ = basis[rows_]
        okk = ok[rows_, j] & np.isfinite(g) & np.isfinite(mm) & np.isfinite(bb_)
        bk = bw[rows_, j]
        pa = np.full(len(rows_), np.nan); pac = pa.copy(); ps = pa.copy(); psc = pa.copy()
        for b in np.unique(bk[okk]):
            q = okk & (bk == b)
            pa[q] = p_up_fast(tabs[b], int(tau), g[q], s_[q], S_[q], mm[q], bq)
            pac[q] = p_up_fast(tabs[b], int(tau), g[q], s_[q], S_[q], mm[q], bq, 1.25, 1.25)
            ps[q] = p_up_fast(tabs[b], int(tau), g[q], s_[q], S_[q], bb_[q], bq, 1.0, 0.0)
            psc[q] = p_up_fast(tabs[b], int(tau), g[q], s_[q], S_[q], bb_[q], bq, 1.25, 0.0)
        pg = np.where(okk, gauss_up(np.where(okk, g + mm, 0), np.where(okk, s_, 1), np.where(okk, S_, 1), tau, sdb), np.nan)
        pgc = np.where(okk, gauss_up(np.where(okk, g + mm, 0), np.where(okk, s_, 1), np.where(okk, S_, 1), tau, 1.25 * sdb, 1.25), np.nan)
        SIDE['A'][rows_, j] = np.where(np.isfinite(pa), np.where(pa >= 0.5, 1, -1), 0)
        SIDE['S'][rows_, j] = np.where(np.isfinite(ps), np.where(ps >= 0.5, 1, -1), 0)
        SIDE['B'][rows_, j] = np.where(np.isfinite(pg), np.where(pg >= 0.5, 1, -1), 0)
        grp = np.array([GROUP.get(int(x), 1) for x in bk])
        rr = np.array(rat)[grp]; rq = np.where(grp == 0, rat[0], 1.0)
        f_raw = np.minimum(pa, 1 - pa); f_rawc = np.maximum(f_raw, np.minimum(pac, 1 - pac))
        fs_raw = np.minimum(ps, 1 - ps); fs_rawc = np.maximum(fs_raw, np.minimum(psc, 1 - psc))
        vrec = np.vectorize(recal)
        def rc(f, r):
            o = np.full(len(f), np.nan); q = np.isfinite(f); o[q] = vrec(f[q], r[q]); return o
        FL['C'][rows_, j] = f_raw; FC['C'][rows_, j] = f_rawc
        FL['A'][rows_, j] = rc(f_raw, rr); FC['A'][rows_, j] = rc(f_rawc, rr)
        FL['Aq'][rows_, j] = rc(f_raw, rq); FC['Aq'][rows_, j] = rc(f_rawc, rq)
        FL['B'][rows_, j] = np.minimum(pg, 1 - pg); FC['B'][rows_, j] = np.maximum(FL['B'][rows_, j], np.minimum(pgc, 1 - pgc))
        FL['Cs'][rows_, j] = fs_raw; FC['Cs'][rows_, j] = fs_rawc
        FL['As'][rows_, j] = rc(fs_raw, rr); FC['As'][rows_, j] = rc(fs_rawc, rr)
    log('set', k, 'windows', len(rows_))
np.savez_compressed(os.path.join(DER, 'settle_eval.npz'), tick=tick, C=C, K=K, A=A, yes=yes, fold=fold_of, hold=hold, basis=basis, mu=mu,
                    gap=gap.astype(np.float32), S=S.astype(np.float32), sig=sw.astype(np.float32), bucket=bw, mom15=mom15.astype(np.float32),
                    taus=TAUS, **{f'FL_{v}': FL[v] for v in VAR}, **{f'FC_{v}': FC[v] for v in VAR}, **{f'SIDE_{k}': SIDE[k] for k in SIDE})
log('saved')
