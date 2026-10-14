"""Reversal-warning effectiveness after a realistic entry, with Kalshi's public trade tape for prices.
For every variant in settle_eval.npz and every warning rule, two position sets:
  TRADES  = the variant's TRADE NOW entries (same rule as settle_metrics: first LOCKED second with a visible ask
            90c..limit; CONS fill model = losers always filled at visible+1c, winners need fill evidence)
  ALLLOCK = a position at EVERY window's first LOCKED second bought at the visible ask + 1c (no price filter) -
            the worst case of following LOCKED blindly; gives far more losing positions to test warnings on.
Timeline per position (decision second tau_d, from the close):
  fill            tau_d - 2   (1 s detection + 1 s order latency)
  warning         first second tau_w < tau_d at which the LOCKED side's flip risk >= the rule's threshold
  classes         'before fill' (tau_d - 2 < tau_w < tau_d) | 'too late' (tau_w < 3: exit cannot complete)
                  | 'exit possible' (exit evidence on the tape) | 'no exit liquidity' | 'no warning'
  exit price      CONS: 1 - (highest opposite-side taker price in [t_w+2, t_w+7]) - 1c, needs >= 10 contracts traded
                  VISIBLE: 1 - (last opposite-side taker price seen in the 10 s before t_w) - 1c
  fees            Kalshi taker fee ceil(0.07 C P (1-P)) on entry and on exit (10-lot)
Outputs results/warning_eval.json"""
import json, math, os, sys
from collections import Counter, defaultdict
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, kalshi_fee_cents
from actionable import quote
import settle_metrics_lib as L

D = L.D; FL, FC, SD, SIDEOF = L.FL, L.FC, L.SD, L.SIDEOF
C, yes, tick = L.C, L.yes, L.tick
RULES = {'W10 (2.6 shipped: flip >= 10%)': 0.10, 'W5 (flip >= 5%)': 0.05, 'W2 (flip >= 2%)': 0.02, 'W1 (flip >= 1%)': 0.01}
VARS = ('A', 'C', 'As', 'B')
LAT = 2

def side_flip(v, i, tau, side):
    """flip risk of `side` (+1 UP / -1 DOWN) at second tau under variant v"""
    f = FL[v][i, tau]
    if not np.isfinite(f): return np.nan
    lead = SD[SIDEOF[v]][i, tau]
    return float(f) if lead == side else 1.0 - float(f)

def exit_price(tp, side, t, mode):
    """sell `side` at its bid = 1 - opposite side's ask, read from opposite-side taker prints"""
    opp = tp[1 if side > 0 else 0]
    ts, px, n = opp
    if mode == 'VISIBLE':
        q = quote(opp, t)
        return None if q is None else max(0.0, 1 - q - 0.01)
    a = np.searchsorted(ts, t + LAT, side='left'); b = np.searchsorted(ts, t + LAT + 5, side='right')
    if a >= b or n[a:b].sum() < 10: return None
    return max(0.0, 1 - float(px[a:b].max()) - 0.01)

def entries(v, rows, kind, mode):
    out = []
    for i in rows:
        tp = L.get_tape(i)
        if tp is None: continue
        y = bool(yes[i])
        for tau in range(min(197, 300), 2, -1):
            f = FL[v][i, tau]
            if not (f <= L.LIM + 1e-12): continue
            side = int(SD[SIDEOF[v]][i, tau]); si = 0 if side > 0 else 1; t = float(C[i] - tau)
            q = quote(tp[si], t)
            if kind == 'ALLLOCK':
                if q is None: break                      # first LOCKED second only; no price -> no position
                won = (side > 0) == y; px = min(0.99, q + 0.01)
            else:
                if q is None: continue
                lim = L.limit_for(1 - float(FC[v][i, tau]))
                if lim <= 0.5 or q > lim + 1e-9 or q < 0.90 - 1e-9: continue
                won = (side > 0) == y
                if mode == 'VISIBLE' or not won: px = min(lim, q + 0.01)
                else:
                    px = L.fwd_fill(tp[si], t, lim, 2.0, 5.0, 10, 0.01)
                    if px is None: continue
            out.append((int(i), tau, side, won, px))
            break
    return out

def evaluate(v, ents, mode):
    res = {}
    for rname, thr in RULES.items():
        cls = Counter(); d_loss = []; d_win = []; bid_at = []; lead_s = []
        hold_pnl = 0.0; pol_pnl = 0.0
        for (i, tau_d, side, won, px) in ents:
            tp = L.get_tape(i)
            fee_in = kalshi_fee_cents(px, 10) / 100
            hp = (1.0 if won else 0.0) - px - fee_in
            hold_pnl += hp
            tw = None
            for tau in range(tau_d - 1, 0, -1):
                fl = side_flip(v, i, tau, side)
                if np.isfinite(fl) and fl >= thr: tw = tau; break
            if tw is None: c = 'no warning'; pp = hp
            elif tw > tau_d - LAT: c = 'after LOCKED, before fill'; pp = hp
            elif tw < 3: c = 'too late (< 3 s left)'; pp = hp
            else:
                ex = exit_price(tp, side, float(C[i] - tw), mode)
                if ex is None: c = 'no exit liquidity'; pp = hp
                else:
                    c = 'exit possible'; fee_out = kalshi_fee_cents(ex, 10) / 100 if ex > 0 else 0.0
                    pp = ex - fee_out - px - fee_in
                    bid_at.append(ex + 0.01); lead_s.append(tw)
                    (d_win if won else d_loss).append(pp - hp)
            cls[(c, 'won' if won else 'lost')] += 1
            pol_pnl += pp
        n = len(ents)
        res[rname] = {'positions': n, 'lost_positions': sum(1 for e in ents if not e[3]),
                      'classes': {f'{a} | {b}': k for (a, b), k in sorted(cls.items())},
                      'losers_exited': len(d_loss), 'losers_saved_c_per_contract_total': round(100 * sum(d_loss), 1),
                      'winners_exited_false_alarm': len(d_win), 'winners_cost_c_per_contract_total': round(100 * sum(d_win), 1),
                      'hold_pnl_c_per_contract': round(100 * hold_pnl / max(1, n), 3), 'exit_policy_pnl_c_per_contract': round(100 * pol_pnl / max(1, n), 3),
                      'delta_usd_per_10lot_total': round(10 * (pol_pnl - hold_pnl), 2),
                      'median_bid_at_exit_c': round(100 * float(np.median(bid_at)), 1) if bid_at else None,
                      'median_seconds_left_at_warning': float(np.median(lead_s)) if lead_s else None}
    return res

out = {}
for sname, rows in L.SETS.items():
    out[sname] = {}
    for v in VARS:
        out[sname][v] = {}
        for kind, mode in (('TRADES', 'CONS'), ('TRADES', 'VISIBLE'), ('ALLLOCK', 'CONS'), ('ALLLOCK', 'VISIBLE')):
            ents = entries(v, rows, kind, mode)
            out[sname][v][f'{kind} {mode}'] = evaluate(v, ents, mode)
            w = out[sname][v][f'{kind} {mode}']['W10 (2.6 shipped: flip >= 10%)']
            print(sname, v, kind, mode, 'positions', w['positions'], 'lost', w['lost_positions'], '| W10', w['classes'], flush=True)
# every losing first-LOCKED position of A and As: the warning timeline (seconds left, bid) for the report
detail = []
for sname, rows in L.SETS.items():
    for v in ('A', 'As'):
        for (i, tau_d, side, won, px) in entries(v, rows, 'ALLLOCK', 'VISIBLE'):
            if won: continue
            tp = L.get_tape(i); tl = []
            for thr in (0.01, 0.02, 0.05, 0.10):
                tw = next((tau for tau in range(tau_d - 1, 0, -1) if np.isfinite(side_flip(v, i, tau, side)) and side_flip(v, i, tau, side) >= thr), None)
                tl.append({'thr_pct': 100 * thr, 'tau': tw, 'bid_visible_c': None if tw is None else (lambda e: None if e is None else round(100 * (e + 0.01), 1))(exit_price(tp, side, float(C[i] - tw), 'VISIBLE'))})
            detail.append({'set': sname, 'variant': v, 'contract': str(tick[i]), 'locked': ('UP' if side > 0 else 'DOWN'), 'locked_at_tau': tau_d,
                           'entry_px_c': round(100 * px, 1), 'official_margin': round(float(L.A[i] - L.K[i]), 2), 'warnings': tl})
out['losing_first_locks_timeline'] = detail
json.dump(out, open(os.path.join(ROOT, 'results/warning_eval.json'), 'w'), indent=1, default=float)
print('saved')
