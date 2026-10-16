/* Phase 5: can the intended trade (about $50,000 to earn about $50) be profitable given the measured LOCKED failure rates?
   Inputs are READ from the saved result files of the Oct 13 walk-forward study ([HIST]; raw tapes not in this environment) and the
   forward record shown on the user's live page ([SCREEN]). Nothing here is simulated.
   usage: node economics.js <out.json>                                                                                       */
'use strict';
const fs = require('fs'), path = require('path');
const S = require('./stats_lib.js');
const R = path.join(__dirname, '..', 'pkg27', 'research', 'results');
const sm = JSON.parse(fs.readFileSync(path.join(R, 'settle_metrics.json'), 'utf8'));
const ft = JSON.parse(fs.readFileSync(path.join(R, 'fixed_time_trade.json'), 'utf8'));
const H = sm.holdout.variants.A, D = sm.dev_folds1_6.variants.A;
const BUDGET = Number(process.env.BUDGET_USD || 50000);
const asks = [99.0, 99.5, 99.7, 99.8, 99.9];
const positions = asks.map(a => S.position(a, S.contractsForBudget(BUDGET, a)));
const evidence = [];
const add = (name, k, n, src, note) => {
  const c = S.cp(k, n), up1 = S.cpOneSidedUpper(k, n);
  evidence.push({ name, k, n, src, note, ratePct: +(100 * k / n).toFixed(4), ci95Pct: [+(100 * c.lo).toFixed(4), +(100 * c.hi).toFixed(4)], upper95OneSidedPct: +(100 * up1).toFixed(4),
    evUsd: Object.fromEntries(positions.map(p => [p.pCents + 'c', { atRate: +S.evAt(p, k / n).toFixed(2), atUpper95: +S.evAt(p, up1).toFixed(2) }])) });
};
add('first LOCKED, holdout (Jul 22 - Aug 13)', H.locked.lost, H.locked.n, 'settle_metrics.json holdout A', 'trade at the first LOCKED second');
add('first LOCKED, development (Sep 4 - Oct 13)', D.locked.lost, D.locked.n, 'settle_metrics.json dev A', 'the tables were fitted on this period: not independent');
add('first LOCKED, pooled', H.locked.lost + D.locked.lost, H.locked.n + D.locked.n, 'both', '');
for (const t of ['60', '45', '30', '20', '15', '10', '5', '3']) {
  const h = H.locked_at_fixed_times[t], d = D.locked_at_fixed_times[t];
  add(`still LOCKED at T-${t} s, pooled`, h.lost + d.lost, h.locked + d.locked, 'settle_metrics.json locked_at_fixed_times (holdout + dev)',
    `holdout ${h.lost}/${h.locked}, dev ${d.lost}/${d.locked}`);
}
add('forward, user live 2.8 page, before Oct 15 20:30 ET', 0, 83, '[SCREEN] IMG_7268 failure monitor "0 of 83 forward LOCKED calls lost"', 'first LOCKED calls');
add('forward incl. Oct 15 20:30 ET IF it settled UP (outcome not yet known here)', 1, 84, '[SCREEN] + hypothetical outcome', 'scenario, not data');
const priced = ['60', '45', '30', '20', '15', '10', '5', '3'].map(t => ({ t: +t,
  holdout: { locked: ft.holdout[t].locked, withPrice: ft.holdout[t].with_price, medianAsk: ft.holdout[t].median_ask_c, shareAskLe99Pct: ft.holdout[t].share_ask_le_99c_pct },
  dev: { locked: ft.dev_folds1_6[t].locked, withPrice: ft.dev_folds1_6[t].with_price, medianAsk: ft.dev_folds1_6[t].median_ask_c, shareAskLe99Pct: ft.dev_folds1_6[t].share_ask_le_99c_pct } }));
const out = { budgetUsd: BUDGET, positions, cleanSampleNeeded: Object.fromEntries(positions.map(p => [p.pCents + 'c', S.cleanSampleNeeded(p.breakEvenFailProb)])),
  evidence, executable: priced,
  caveats: ['[HIST] counts come from the Oct 13 walk-forward study of the 2.6 probability model (2.8 / 2.8.1 use the same model); its raw Kalshi and exchange tapes are not in this environment, so the counts cannot be re-executed here.',
    'Fixed-time cells overlap (the same windows at several times) and T-20 / T-15 were not chosen in advance: picking the best cell after seeing the data overstates it.',
    '62 days (Jul 22 - Oct 13 2026) of one market regime; rare jumps can cluster, so the effective sample is smaller than the window count.',
    'Depth: the saved files hold whether a leader price existed and its median, not the size offered. Whether 50,000 contracts could be bought at 99.9c in the last 30 s is NOT established.'] };
fs.writeFileSync(process.argv[2] || 'results_economics.json', JSON.stringify(out, null, 1));
const f = x => x.toFixed(x < 0.01 ? 4 : 3);
console.log('position ($' + BUDGET + '):'); for (const p of positions) console.log(`  ask ${p.pCents}c: ${p.contracts} contracts, fee $${p.feeUsd}, win +$${p.winUsd.toFixed(2)}, loss -$${p.lossUsd.toFixed(2)}, break-even failure ${f(100 * p.breakEvenFailProb)}% (clean wins needed to show it: ${S.cleanSampleNeeded(p.breakEvenFailProb)})`);
console.log('evidence (failure %, 95% CI, one-sided upper; EV per $' + BUDGET + ' trade at 99.9c / 99.0c at the point rate and at the upper bound):');
for (const e of evidence) console.log(`  ${e.name}: ${e.k}/${e.n} = ${e.ratePct}% [${e.ci95Pct.join(', ')}], upper ${e.upper95OneSidedPct}% | 99.9c: ${e.evUsd['99.9c'].atRate} / ${e.evUsd['99.9c'].atUpper95} | 99c: ${e.evUsd['99c'].atRate} / ${e.evUsd['99c'].atUpper95}`);
console.log('executable (a leader price existed in the Kalshi tape at T-x; median ask):');
for (const p of priced) console.log(`  T-${p.t}: holdout ${p.holdout.withPrice}/${p.holdout.locked} (median ${p.holdout.medianAsk}c), dev ${p.dev.withPrice}/${p.dev.locked} (median ${p.dev.medianAsk}c)`);
