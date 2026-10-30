/* Test 6 — mathematical accuracy. test/independent_check.py was written separately from a written specification only
   (without access to lib/), in exact rational / 50-digit decimal arithmetic. This test runs it on test/math_cases.json and
   compares every number with lib/fills.js and lib/stats.js.
   Tolerances: contracts and levels exact; dollars within 1 cent (the independent version rounds exact half-cent ties away from
   zero, ours rounds the float value); average price within 1e-4 c; probabilities within 1e-9 absolute or 1e-7 relative. */
'use strict';
const fs = require('fs'), path = require('path');
const { spawnSync } = require('child_process');
const F = require('../lib/fills'), S = require('../lib/stats');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'math_cases.json'), 'utf8'));
const outFile = path.join(require('os').tmpdir(), 'indep_' + process.pid + '.json');
const r = spawnSync('python3', [path.join(__dirname, 'independent_check.py'), path.join(__dirname, 'math_cases.json'), outFile], { encoding: 'utf8' });
if (r.status !== 0) { console.log('independent checker failed: ' + r.stderr.slice(-500)); process.exit(1); }
const ind = JSON.parse(fs.readFileSync(outFile, 'utf8')); fs.unlinkSync(outFile);
const bad = []; let checks = 0;
const near = (a, b, tol) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol);
cases.fills.forEach((c, i) => {
  const mine = F.theoretical(c.asks, c.budgets, c.rate, c.outcome), theirs = ind.fills[i];
  if (!near(mine.totalAskDepthUsd, theirs.totalAskDepthUsd, 0.0100001)) bad.push(`fills[${i}] depth ${mine.totalAskDepthUsd} vs ${theirs.totalAskDepthUsd}`);
  mine.sizes.forEach((m, j) => {
    const t = theirs.sizes[j];
    for (const [k, tol] of [['contracts', 1e-9], ['levelsUsed', 0], ['costUsd', 0.0100001], ['feesUsd', 0.0100001], ['capitalUsd', 0.0100001], ['avgPriceCents', 1e-4], ['worstPriceCents', 1e-9],
      ['unfilledUsd', 0.0100001], ['payoutIfWinUsd', 1e-9], ['netIfWinUsd', 0.0100001], ['netIfLossUsd', 0.0100001], ['netUsd', 0.0100001], ['returnPct', 0.02]]) {
      checks++; if (!near(m[k], t[k], tol)) bad.push(`fills[${i}] $${c.budgets[j]} ${k}: ours ${m[k]} independent ${t[k]}`);
    }
    checks += 2; if (m.stoppedBy !== t.stoppedBy) bad.push(`fills[${i}] $${c.budgets[j]} stoppedBy ${m.stoppedBy} vs ${t.stoppedBy}`); if (m.fullyFillable !== t.fullyFillable) bad.push(`fills[${i}] $${c.budgets[j]} fullyFillable`);
  });
});
const pn = (a, b) => (a === b) || Math.abs(a - b) <= Math.max(1e-9, 1e-7 * Math.abs(b));
cases.binomial.forEach(({ k, n }, i) => {
  const t = ind.binomial[i], cp = S.clopperPearson(k, n), w = S.wilson(k, n), po = S.posteriors(k, n);
  for (const [name, a, b] of [['cpLo', cp.lo, t.cpLo], ['cpHi', cp.hi, t.cpHi], ['upper95', S.upperBound(k, n), t.upper95], ['wilsonLo', w.lo, t.wilsonLo], ['wilsonHi', w.hi, t.wilsonHi],
    ...['uniform', 'jeffreys', 'modelClaim02pct', 'pessimistic1pct'].flatMap(p => [[p + '.mean', po[p].mean, t.post[p].mean], [p + '.lo95', po[p].lo95, t.post[p].lo95], [p + '.hi95', po[p].hi95, t.post[p].hi95]])]) {
    checks++; if (!pn(a, b)) bad.push(`binomial ${k}/${n} ${name}: ours ${a} independent ${b}`);
  }
});
for (const b of bad.slice(0, 20)) console.log('FAIL ' + b);
console.log(`math: ${checks - bad.length}/${checks} values agree with the independent implementation`);
process.exit(bad.length ? 1 : 0);
