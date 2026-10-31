/* Monte Carlo of one month of theoretical $1,000 purchases at the first 0.2 % qualifying signal (RECONSTRUCTED replay data).
   Assumptions (disclosed, deliberately simple):
     * trades per month = priced signals in the replay / 9.6 months, in the price buckets observed;
     * each price bucket has its OWN loss probability, drawn per path from its posterior Beta(a + k_b, b + n_b - k_b)
       (k_b losses in n_b priced trades of that bucket): parameter uncertainty is included, and a bucket where the market
       disagreed (cheap prints) keeps its much higher observed loss rate;
     * a win pays the bucket's observed average net win; a loss costs about $1,000 (the stake);
     * losses independent between trades (calls on one day are not; the day-block bootstrap in the main results checks that);
     * fills at the last print price with no slippage or competition (optimistic, see RESULTS.md).
   usage: node research/montecarlo_28.js research/hypothesis_28_results.json */
'use strict';
const S = require('../lib/stats');
const j = require(require('path').resolve(process.argv[2] || 'research/hypothesis_28_results.json'));
const p = j.pricesFromPrints.firstQualifying;
const MONTHS = 9.6, PATHS = 4000;
const buckets = Object.entries(p.pnlPer1000.byPrice).filter(([, c]) => c.n).map(([b, c]) => ({ b, n: c.n, k: c.losses,
  winNet: (c.n * c.meanNetUsdPer1000 + c.losses * 1000) / Math.max(1, c.n - c.losses), perMonth: Math.round(c.n / MONTHS) }));
function simulate(keep, prior, seed) {
  const R = S.rng(seed), tot = [], dds = [];
  const B = buckets.filter(x => keep(x.b));
  for (let path = 0; path < PATHS; path++) {
    const q = B.map(x => S.betaQuantile(R(), prior[0] + x.k, prior[1] + x.n - x.k));
    const seq = []; B.forEach((x, i) => { for (let t = 0; t < x.perMonth; t++) seq.push(R() < q[i] ? -1000 : x.winNet); });
    for (let i = seq.length - 1; i > 0; i--) { const r = Math.floor(R() * (i + 1)); [seq[i], seq[r]] = [seq[r], seq[i]]; }   // trades interleaved over the month
    tot.push(seq.reduce((a, v) => a + v, 0)); dds.push(S.maxDrawdown(seq));
  }
  tot.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const qt = (a, x) => Math.round(a[Math.min(a.length - 1, Math.floor(x * a.length))]);
  return { tradesPerMonth: B.reduce((a, x) => a + x.perMonth, 0), monthlyPnlUsd: { p05: qt(tot, 0.05), median: qt(tot, 0.5), p95: qt(tot, 0.95) },
    probLosingMonth: tot.filter(v => v < 0).length / PATHS, maxDrawdownUsd: { median: qt(dds, 0.5), p95: qt(dds, 0.95), p99: qt(dds, 0.99) } };
}
const out = { assumptions: 'see file header', buckets: buckets.map(x => ({ priceCents: x.b, priced: x.n, losses: x.k, avgWinNetUsdPer1000: Math.round(x.winNet * 100) / 100, perMonth: x.perMonth,
  breakEvenLossRatePct: +(100 * x.winNet / (x.winNet + 1000)).toFixed(4), observedLossRatePct: +(100 * x.k / x.n).toFixed(4) })), scenarios: {} };
for (const [label, keep] of [['all print prices', () => true], ['90 c and above', b => b !== '0-90'], ['99.5 c and above only (the most common prices)', b => b === '99.5-100']])
  out.scenarios[label] = { jeffreys: simulate(keep, S.PRIORS.jeffreys, 2828), pessimistic1pct: simulate(keep, S.PRIORS.pessimistic1pct, 2829) };
console.log(JSON.stringify(out, null, 1));
