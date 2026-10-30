/* Statistics for rare events (implemented from first principles; no third-party code):
   * Clopper-Pearson exact interval (two-sided and one-sided upper bound) for a binomial proportion
   * Wilson score interval
   * Beta posteriors for an error rate under several priors (uniform, Jeffreys, a skeptical prior centred on the model's own
     0.2 % claim, and a pessimistic one), to show how much the conclusion depends on the prior
   * moving-block (by UTC day) bootstrap for statistics of correlated observations
   * Monte Carlo of cumulative P&L and drawdown with the error rate drawn from its posterior (parameter uncertainty included)
   All random numbers come from a seeded generator, so every figure is reproducible. */
'use strict';

/* regularised incomplete beta I_x(a,b) (Lentz continued fraction) */
function lgamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log(2.5066282746310005 * s / x);
}
function betacf(a, b, x) {
  const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
function ibeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
function betaQuantile(p, a, b) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (ibeta(m, a, b) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
/* Clopper-Pearson: lower = B(alpha/2; k, n-k+1), upper = B(1-alpha/2; k+1, n-k) */
function clopperPearson(k, n, conf = 0.95) {
  if (!n) return { k, n, p: null, lo: null, hi: null };
  const a = 1 - conf;
  return { k, n, p: k / n, lo: k === 0 ? 0 : betaQuantile(a / 2, k, n - k + 1), hi: k === n ? 1 : betaQuantile(1 - a / 2, k + 1, n - k) };
}
function upperBound(k, n, conf = 0.95) { return !n ? null : k === n ? 1 : betaQuantile(conf, k + 1, n - k); }   // one-sided
function wilson(k, n, z = 1.959963984540054) {
  if (!n) return { lo: null, hi: null };
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return { lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}
const PRIORS = { uniform: [1, 1], jeffreys: [0.5, 0.5], modelClaim02pct: [2, 998], pessimistic1pct: [10, 990] };
function posteriors(errors, n) {
  const out = {};
  for (const [name, [a, b]] of Object.entries(PRIORS)) {
    const A = a + errors, B = b + n - errors;
    out[name] = { prior: [a, b], mean: A / (A + B), lo95: betaQuantile(0.025, A, B), hi95: betaQuantile(0.975, A, B), p99: betaQuantile(0.99, A, B) };
  }
  return out;
}
/* seeded PRNG (mulberry32) */
function rng(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ t >>> 15, 1 | t); r ^= r + Math.imul(r ^ r >>> 7, 61 | r); return ((r ^ r >>> 14) >>> 0) / 4294967296; }; }
/* moving-block bootstrap over blocks (e.g. UTC days): resample whole blocks with replacement, recompute stat(flat items) */
function blockBootstrap(blocks, stat, B = 2000, seed = 12345, conf = 0.95) {
  const R = rng(seed), vals = [];
  if (!blocks.length) return null;
  for (let b = 0; b < B; b++) { const s = []; for (let i = 0; i < blocks.length; i++) s.push(...blocks[Math.floor(R() * blocks.length)]); const v = stat(s); if (Number.isFinite(v)) vals.push(v); }
  vals.sort((x, y) => x - y);
  const q = p => vals[Math.min(vals.length - 1, Math.max(0, Math.floor(p * vals.length)))];
  return { B: vals.length, lo: q((1 - conf) / 2), hi: q(1 - (1 - conf) / 2), median: q(0.5) };
}
function maxDrawdown(pnls) { let peak = 0, cum = 0, dd = 0; for (const x of pnls) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); } return dd; }
/* Monte Carlo: each trade wins `winNet` or loses `lossNet`; the loss probability is drawn per path from Beta(a+k, b+n-k) */
function monteCarlo({ trades, errors, n, prior = PRIORS.jeffreys, paths = 5000, seed = 777 }) {
  const R = rng(seed), A = prior[0] + errors, B = prior[1] + n - errors;
  const tot = [], dds = [];
  const draw = () => {   // Beta(A,B) by inversion (adequate for these sizes)
    return betaQuantile(R(), A, B);
  };
  for (let p = 0; p < paths; p++) {
    const q = draw(); const series = trades.map(t => R() < q ? t.lossNet : t.winNet);
    tot.push(series.reduce((a, b) => a + b, 0)); dds.push(maxDrawdown(series));
  }
  tot.sort((a, b) => a - b); dds.sort((a, b) => a - b);
  const qt = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(p * arr.length))];
  return { paths, totalPnl: { p05: qt(tot, 0.05), median: qt(tot, 0.5), p95: qt(tot, 0.95), probLoss: tot.filter(x => x < 0).length / paths },
    maxDrawdown: { median: qt(dds, 0.5), p95: qt(dds, 0.95), p99: qt(dds, 0.99) } };
}
module.exports = { ibeta, betaQuantile, clopperPearson, upperBound, wilson, posteriors, PRIORS, rng, blockBootstrap, maxDrawdown, monteCarlo };
