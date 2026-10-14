#!/usr/bin/env python3
"""Pin Radar 2.8 research — independent re-analysis of the 2.6/2.7 evidence.

Inputs are ONLY the aggregate tables shipped in pinradar-2.7.zip (pkg27/research/results) and the
AUDIT_25 block embedded in the 2.7 server. The raw tapes are not available, so nothing here is
new market evidence: every number is derived from development / previously-examined data and is
used to (a) check the prior claims, (b) quantify uncertainty, (c) pre-register what the forward
test must show. Run:  python3 reanalysis.py  (needs numpy, scipy) -> ../results/reanalysis.json
"""
import json, math, os, re, sys
import numpy as np
from scipy import stats, optimize

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
RES = os.path.join(ROOT, 'pkg27', 'research', 'results')
SERVER27 = os.path.join(ROOT, 'versions', '2.7', 'pinradar_server.js')
OUT = os.path.join(HERE, '..', 'results', 'reanalysis.json')


def cp_two_sided(k, n, conf=0.95):
    a = 1 - conf
    lo = 0.0 if k == 0 else stats.beta.ppf(a / 2, k, n - k + 1)
    hi = 1.0 if k == n else stats.beta.ppf(1 - a / 2, k + 1, n - k)
    return lo, hi


def cp_upper_one_sided(k, n, conf=0.95):
    return 1.0 if k == n else stats.beta.ppf(conf, k + 1, n - k)


def load(name):
    with open(os.path.join(RES, name)) as f:
        return json.load(f)


def audit25():
    src = open(SERVER27, encoding='utf8').read()
    m = re.search(r'const AUDIT_25 = Object\.freeze\((\{.*?\})\);\n', src)
    return json.loads(m.group(1))


out = {'_note': 'derived from the prior session\'s development/holdout aggregates; not independent evidence'}

# ---------------------------------------------------------------- 1. LOCKED failure-rate bounds
sm, se = load('settle_metrics.json'), load('settle_extra.json')
rows = []
for part in ('holdout', 'dev_folds1_6'):
    variants = dict(sm[part]['variants'])
    variants.update({k: v for k, v in se[part].items() if isinstance(v, dict) and 'locked' in v})
    for name, v in variants.items():
        L = v['locked']
        k, n = L['lost'], L['n']
        lo, hi = cp_two_sided(k, n)
        rows.append({'period': part, 'variant': name, 'locked': n, 'lost': k, 'rate_pct': round(100 * k / n, 3),
                     'cp95_two_sided_pct': [round(100 * lo, 3), round(100 * hi, 3)],
                     'cp95_upper_one_sided_pct': round(100 * cp_upper_one_sided(k, n), 3),
                     'reported_ci95_pct': L.get('ci95_pct'),
                     'reported_matches_two_sided_cp': bool(L.get('ci95_pct') is not None and
                                                        abs(L['ci95_pct'][0] - 100 * lo) < 0.002 and abs(L['ci95_pct'][1] - 100 * hi) < 0.002),
                     'coverage_pct': v.get('coverage_pct'), 'lead_mean_s': v.get('lead_mean_s'), 'lead_median_s': v.get('lead_median_s'),
                     'trade_cons': {kk: v.get('trade_now_CONS', {}).get(kk) for kk in ('trades', 'losses', 'avg_px_c', 'pnl_c_per_contract', 'pnl_ci95_c')},
                     'trade_visible': {kk: v.get('trade_now_VISIBLE', {}).get(kk) for kk in ('trades', 'losses', 'avg_px_c', 'pnl_c_per_contract', 'pnl_ci95_c')}})
out['locked_bounds'] = rows
# 2.6 pooled over both periods (they do not overlap: Jul 22-Aug 13 vs Sep 4-Oct 13)
k, n = 3 + 13, 1879 + 3484
out['locked_2_6_pooled'] = {'lost': k, 'locked': n, 'rate_pct': round(100 * k / n, 3),
                            'cp95_two_sided_pct': [round(100 * x, 3) for x in cp_two_sided(k, n)],
                            'cp95_upper_one_sided_pct': round(100 * cp_upper_one_sided(k, n), 3),
                            'claimed_standard_pct': 0.5,
                            'note': 'holdout was examined during 2.7 model comparison; pooled figure is previously-examined evidence'}
# heterogeneity between periods for 2.6 (Fisher exact)
tab = [[3, 1879 - 3], [13, 3484 - 13]]
out['locked_2_6_period_heterogeneity'] = {'fisher_p_two_sided': round(stats.fisher_exact(tab)[1], 4)}

# ---------------------------------------------------------------- 2. TRADE NOW economics
def fee_cents_per_contract(price_c, C, mult=0.07):
    P = price_c / 100.0
    return math.ceil(100 * mult * C * P * (1 - P) - 1e-9) / C


def trade_econ(trades, losses, avg_px_c, C=10):
    fee = fee_cents_per_contract(avg_px_c, C)
    be_loss = (100 - avg_px_c - fee) / 100.0          # break-even loss probability
    p_hat = losses / trades
    ub = cp_upper_one_sided(losses, trades)
    lo2, hi2 = cp_two_sided(losses, trades)
    # exact posterior (Jeffreys) probability that the true loss rate is below break-even
    post = stats.beta(losses + 0.5, trades - losses + 0.5)
    return {'trades': trades, 'losses': losses, 'avg_px_c': avg_px_c, 'fee_c_per_contract_10lot': round(fee, 3),
            'break_even_loss_pct': round(100 * be_loss, 3), 'observed_loss_pct': round(100 * p_hat, 3),
            'loss_cp95_two_sided_pct': [round(100 * lo2, 3), round(100 * hi2, 3)],
            'loss_cp95_upper_pct': round(100 * ub, 3),
            'edge_proven_at_95pct': bool(ub < be_loss),
            'jeffreys_P_true_loss_below_break_even': round(float(post.cdf(be_loss)), 4),
            'ev_c_per_contract_at_observed_loss': round(100 * (1 - p_hat) - avg_px_c - fee, 3),
            'ev_c_per_contract_at_cp95_upper_loss': round(100 * (1 - ub) - avg_px_c - fee, 3)}


econ = {}
for part in ('holdout', 'dev_folds1_6'):
    A = sm[part]['variants']['A']
    for kind in ('CONS', 'VISIBLE'):
        t = A['trade_now_' + kind]
        econ[f'{part}:{kind}'] = trade_econ(t['trades'], t['losses'], t['avg_px_c'])
# pooled cautious fills, both periods
tH, tD = sm['holdout']['variants']['A']['trade_now_CONS'], sm['dev_folds1_6']['variants']['A']['trade_now_CONS']
n_all = tH['trades'] + tD['trades']
px_all = (tH['trades'] * tH['avg_px_c'] + tD['trades'] * tD['avg_px_c']) / n_all
econ['pooled:CONS'] = trade_econ(n_all, tH['losses'] + tD['losses'], round(px_all, 2))
# absolute scale of the opportunity
days = sm['holdout']['days'] + sm['dev_folds1_6']['days']
econ['scale'] = {'days': round(days, 2), 'cons_trades_per_day': round(n_all / days, 2),
                 'cons_usd_per_day_10lot_at_reported_pnl': round((tH['usd_per_10lot'] + tD['usd_per_10lot']) / days, 3),
                 'note': 'reported pnl per 10-lot summed over both periods / days'}
out['trade_now_economics'] = econ

# order-size fee table (per-order rounding makes small orders expensive near 99c)
sizes = [1, 2, 5, 10, 25, 50, 100]
prices = [90, 95, 97, 98, 98.5, 99, 99.5, 99.8, 99.9]
out['fee_cents_per_contract'] = {str(p): {str(C): round(fee_cents_per_contract(p, C), 3) for C in sizes} for p in prices}
out['max_gross_edge_cents'] = {str(p): round(100 - p, 2) for p in prices}

# ---------------------------------------------------------------- 3. adverse selection: loss rate vs market price
a25 = audit25()
byask = a25['LOCKED']['byAsk']
m = np.array([b['marketImpliedLoss'] for b in byask])
k_ = np.array([b['losses'] for b in byask], float)
n_ = np.array([b['n'] for b in byask], float)
lg = lambda p: np.log(p / (1 - p))
# model: logit(loss) = a + b * logit(market-implied loss). b = 0 -> market price uninformative given LOCKED;
# b = 1, a = 0 -> the market is right; 0 < b < 1 -> partial pooling.
def nll(th):
    a, b = th
    z = a + b * lg(np.clip(m, 1e-4, 1 - 1e-4))
    p = 1 / (1 + np.exp(-z))
    return -np.sum(k_ * np.log(p) + (n_ - k_) * np.log(1 - p))
fit = optimize.minimize(nll, [lg(0.003), 0.3], method='Nelder-Mead')
a_hat, b_hat = fit.x
# profile-likelihood 95% CI for b
def prof(b):
    r = optimize.minimize_scalar(lambda a: nll([a, b]), bounds=(-15, 5), method='bounded')
    return r.fun
bs = np.linspace(-0.5, 1.5, 401)
pl = np.array([prof(b) for b in bs])
ok = bs[pl - fit.fun <= 0.5 * stats.chi2.ppf(0.95, 1)]
null0 = prof(0.0)
out['adverse_selection'] = {
    'data': [{'ask_lo': b['lo'], 'ask_hi': b['hi'], 'n': b['n'], 'losses': b['losses'], 'market_implied_loss_pct': round(100 * b['marketImpliedLoss'], 2),
              'observed_loss_pct': round(100 * b['losses'] / b['n'], 2)} for b in byask],
    'fit': {'a': round(float(a_hat), 3), 'b_pooling_weight_on_market': round(float(b_hat), 3),
            'b_profile_ci95': [round(float(ok.min()), 3), round(float(ok.max()), 3)],
            'LR_test_b_eq_0_p': round(float(stats.chi2.sf(2 * (null0 - fit.fun), 1)), 4)},
    'interpretation': 'b > 0 means a cheaper ask is evidence the LOCKED call is weaker than the model says (adverse selection). '
                      'Derived on development data (Sep 4-Oct 13) -> hypothesis for the forward test, not a validated parameter.'}
pred = lambda mm: float(1 / (1 + np.exp(-(a_hat + b_hat * lg(mm)))))
out['adverse_selection']['implied_loss_pct_at_ask'] = {f'{c}c': round(100 * pred(1 - c / 100), 3) for c in (90, 95, 97, 98, 99, 99.5, 99.8)}

# ---------------------------------------------------------------- 4. calibration drift between periods
q4 = sm['q4_calibration_by_vol_group']
drift = []
for g in ('quiet', 'normal', 'active'):
    for band in ('0.2-0.5%', '0.5-1.0%', '1.0-2.0%', '2.0-5.0%'):
        key = f'{g} {band}'
        r = {'group': g, 'band': band}
        for part in ('holdout', 'dev_folds1_6'):
            c = q4[part]['A'][key]
            kk = round(c['n'] * c['observed_pct'] / 100)
            exp_ = c['n'] * c['mean_pred_pct'] / 100
            lo, hi = cp_two_sided(kk, c['n'])
            r[part] = {'n': c['n'], 'obs_events': kk, 'expected': round(exp_, 2), 'obs_over_pred': round(kk / exp_, 2),
                       'ratio_ci95': [round(c['n'] * lo / exp_, 2), round(c['n'] * hi / exp_, 2)]}
        drift.append(r)
out['calibration_drift'] = drift
# pooled over bands, per group and period: Poisson ratio O/E with exact CI
pooled = {}
for g in ('quiet', 'normal', 'active'):
    for part in ('holdout', 'dev_folds1_6'):
        O = sum(x[part]['obs_events'] for x in drift if x['group'] == g)
        E = sum(x[part]['expected'] for x in drift if x['group'] == g)
        lo = stats.chi2.ppf(0.025, 2 * O) / 2 if O > 0 else 0.0
        hi = stats.chi2.ppf(0.975, 2 * O + 2) / 2
        pooled[f'{g}:{part}'] = {'O': O, 'E': round(E, 1), 'O_over_E': round(O / E, 2), 'ci95': [round(lo / E, 2), round(hi / E, 2)]}
out['calibration_drift_pooled'] = pooled
ratios = [v['O_over_E'] for v in pooled.values()]
out['calibration_drift_summary'] = {'min_O_over_E': min(ratios), 'max_O_over_E': max(ratios),
                                    'spread_factor': round(max(ratios) / max(min(ratios), 1e-9), 2),
                                    'note': 'first-entry-per-band events, recalibrated 2.6 probabilities; the same displayed '
                                            'probability corresponded to realised rates differing by this factor across periods/regimes'}

# ---------------------------------------------------------------- 5. forward-test sample-size planning
calls_per_day = 85.0   # README section 5 (expected first-LOCKED calls per day)
plan = {}
for true_rate in (0.002, 0.0037, 0.005):
    for target_ub in (0.005, 0.0075, 0.01):
        # smallest n such that the expected-loss CP 95% upper bound is below target
        n = 50
        while n < 200000:
            k = int(round(true_rate * n))
            if cp_upper_one_sided(k, n) < target_ub:
                break
            n = int(n * 1.05) + 1
        plan[f'true {100*true_rate:.2f}% -> CP95 upper < {100*target_ub:.2f}%'] = {'locked_calls': n, 'days_at_85_per_day': round(n / calls_per_day, 1)}
out['forward_plan_locked'] = plan
# TRADE NOW: trades needed to show edge > 0 at 95% (one-sided) if the true edge equals the dev estimate
pnl = {}
for edge_c, px in ((0.855, 98.2), (1.315, 97.9), (2.0, 97.75)):
    p_loss = (100 - px - fee_cents_per_contract(px, 10) - edge_c) / 100
    sd_c = 100 * math.sqrt(p_loss * (1 - p_loss))     # per-contract P&L sd in cents (binary payoff)
    n = math.ceil((1.645 * sd_c / edge_c) ** 2)
    n80 = math.ceil(((1.645 + 0.8416) * sd_c / edge_c) ** 2)
    pnl[f'edge {edge_c}c at {px}c'] = {'implied_loss_pct': round(100 * p_loss, 3), 'pnl_sd_c': round(sd_c, 2),
                                       'trades_for_z_1.645_at_expectation': n, 'trades_for_80pct_power': n80,
                                       'days_at_7_per_day': round(n80 / 7.0, 1)}
out['forward_plan_trade_now'] = pnl

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(out, f, indent=1)
print(json.dumps(out, indent=1)[:200])
print('wrote', OUT)
