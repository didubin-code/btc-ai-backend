/* Exact statistics and Kalshi economics for the Pin Radar validation (no dependencies).
   - binomial CDF / Clopper-Pearson exact intervals (two-sided and one-sided), computed with log-gamma and bisection
   - Kalshi taker fee: ceil(0.07 * C * P * (1 - P)) dollars rounded UP to the cent per order (P = price / 100, C contracts)
   - break-even failure probability and expected value for a position that buys C contracts at price p (cents)        */
'use strict';
function logGamma(x) {                       // Lanczos, |rel err| < 1e-14
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const logChoose = (n, k) => logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
/* P(X <= k), X ~ Bin(n, p) */
function binomCdf(k, n, p) {
  if (k < 0) return 0; if (k >= n) return 1; if (p <= 0) return 1; if (p >= 1) return 0;
  let s = 0; const lp = Math.log(p), lq = Math.log1p(-p);
  for (let i = 0; i <= k; i++) s += Math.exp(logChoose(n, i) + i * lp + (n - i) * lq);
  return Math.min(1, s);
}
function bisect(f, lo, hi, it = 200) { for (let i = 0; i < it; i++) { const m = (lo + hi) / 2; if (f(m)) hi = m; else lo = m; } return (lo + hi) / 2; }
/* exact upper bound: the p with P(X <= k | p) = alpha */
function cpUpper(k, n, alpha) { if (k >= n) return 1; return bisect(p => binomCdf(k, n, p) <= alpha, 0, 1); }
/* exact lower bound: the p with P(X >= k | p) = alpha */
function cpLower(k, n, alpha) { if (k <= 0) return 0; return bisect(p => 1 - binomCdf(k - 1, n, p) >= alpha, 0, 1); }
function cp(k, n, conf = 0.95) { const a = (1 - conf) / 2; return { k, n, rate: n ? k / n : null, lo: cpLower(k, n, a), hi: cpUpper(k, n, a), conf, sided: 'two' }; }
function cpOneSidedUpper(k, n, conf = 0.95) { return cpUpper(k, n, 1 - conf); }
/* smallest n with zero failures whose one-sided upper bound is below pMax */
function cleanSampleNeeded(pMax, conf = 0.95) { return Math.ceil(Math.log(1 - conf) / Math.log1p(-pMax)); }
/* Kalshi taker fee for ONE order of C contracts at price p cents (dollars, rounded up to the cent) */
function kalshiFeeUsd(pCents, C, rate = 0.07) { const P = pCents / 100; return Math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / 100; }
/* buy C contracts at p cents (one order): win -> +C*(100-p)/100 - fee; loss -> -C*p/100 - fee */
function position(pCents, C, rate = 0.07) {
  const fee = kalshiFeeUsd(pCents, C, rate), win = C * (100 - pCents) / 100 - fee, loss = C * pCents / 100 + fee;
  return { pCents, contracts: C, costUsd: C * pCents / 100, feeUsd: fee, winUsd: win, lossUsd: loss, breakEvenFailProb: win / (win + loss) };
}
/* contracts bought with a budget at price p (fee included) */
function contractsForBudget(budgetUsd, pCents, rate = 0.07) {
  let C = Math.floor(budgetUsd / (pCents / 100));
  while (C > 0 && C * pCents / 100 + kalshiFeeUsd(pCents, C, rate) > budgetUsd) C--;
  return C;
}
const evAt = (pos, failProb) => (1 - failProb) * pos.winUsd - failProb * pos.lossUsd;
module.exports = { logGamma, binomCdf, cp, cpUpper, cpLower, cpOneSidedUpper, cleanSampleNeeded, kalshiFeeUsd, position, contractsForBudget, evAt };
