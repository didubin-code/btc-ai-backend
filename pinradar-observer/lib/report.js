/* Daily / weekly / monthly summaries from derived market records. Every figure carries its sample size; accuracy is
   computed only over markets whose final 300 s were completely observed AND whose official result was recorded.
   Theoretical P&L uses the book the observer had received BEFORE the signal (never a later one). */
'use strict';
const S = require('./stats');
const BUCKETS = [['>180', 180, 1e9], ['180-121', 120, 180], ['120-91', 90, 120], ['90-61', 60, 90], ['60-31', 30, 60], ['30-0', -1, 30]];
const bucketOf = tau => (BUCKETS.find(([, lo, hi]) => tau > lo && tau <= hi) || ['?'])[0];
const pct = (a, b) => b ? Math.round(10000 * a / b) / 100 : null;
const q = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function inPeriod(m, from, to) { const c = m.market && Date.parse(m.market.closeTime); return c >= from && c < to; }

function summarize(markets, { from = 0, to = 8.64e15, label = 'all' } = {}) {
  const M = markets.filter(m => inPeriod(m, from, to));
  const cov = { discovered: M.length, complete: 0, partial: 0, unobserved: 0, settled: 0, settlementMissing: 0 };
  for (const m of M) { cov[m.coverage ? m.coverage.status : 'unobserved']++; if (m.settlement && m.settlement.outcome) cov.settled++; else cov.settlementMissing++; }
  const scored = M.filter(m => m.coverage && m.coverage.status === 'complete' && m.settlement && m.settlement.outcome);
  const sig = key => scored.filter(m => m[key]);
  const acc = (list, key) => { const k = list.filter(m => m[key].won === false).length; return { n: list.length, wrong: k, accuracyPct: pct(list.length - k, list.length),
    errorCI95: S.clopperPearson(k, list.length), errorUpper95: S.upperBound(k, list.length), posteriors: list.length ? S.posteriors(k, list.length) : null }; };
  const out = { label, period: { from: new Date(from).toISOString(), to: to > 8e15 ? null : new Date(to).toISOString() }, coverage: cov,
    basis: 'accuracy over completely observed and settled markets only (' + scored.length + ')' };
  const L = sig('signal'), Q = sig('qualified');
  out.rates = {
    lockedPct: pct(L.length, scored.length), qualifiedPct: pct(Q.length, scored.length),
    lockedByT120Pct: pct(scored.filter(m => m.atT120 && !m.atT120.unobserved && (m.atT120.state === 'LOCKED' || m.atT120.state === 'PROVEN LOCKED')).length, scored.length),
    qualifiedAtT120Pct: pct(scored.filter(m => m.atT120 && m.atT120.qualifies).length, scored.length),
    firstQualifiedInLast120Pct: pct(Q.filter(m => m.qualified.tau <= 120).length, scored.length),
    qualifiedAnywhereInLast120Pct: pct(scored.filter(m => m.lockedAnywhereInLast120).length, scored.length),
    continuousToClosePct: pct(Q.filter(m => m.qualified.category === 'continuous-won').length, Q.length),
    warnedAfterQualifiedPct: pct(Q.filter(m => m.qualified.flags.reversalWarningLater).length, Q.length),
  };
  out.firstLocked = acc(L, 'signal');
  out.qualified = acc(Q, 'qualified');
  out.categories = Object.fromEntries(['continuous-won', 'unlocked-won', 'warned-won', 'changed-direction-won', 'wrong'].map(c => [c, Q.filter(m => m.qualified.category === c).length]));
  out.byFirstQualifiedTime = Object.fromEntries(BUCKETS.map(([b]) => { const l = Q.filter(m => bucketOf(m.qualified.tau) === b); return [b, acc(l, 'qualified')]; }));
  out.firstQualifiedTauSec = { p10: q(Q.map(m => m.qualified.tau), 0.1), median: q(Q.map(m => m.qualified.tau), 0.5), p90: q(Q.map(m => m.qualified.tau), 0.9) };
  /* prices and theoretical results at the qualifying signal */
  const priced = Q.filter(m => m.pricing && m.pricing.qualified && m.pricing.qualified.atSignal && m.pricing.qualified.atSignal.theoretical);
  out.pricing = { withContemporaneousBook: priced.length, withoutBook: Q.length - priced.length,
    calledSideBestAskCents: { p10: q(priced.map(m => m.pricing.qualified.atSignal.bestAskCents).filter(x => x != null), 0.1),
      median: q(priced.map(m => m.pricing.qualified.atSignal.bestAskCents).filter(x => x != null), 0.5),
      p90: q(priced.map(m => m.pricing.qualified.atSignal.bestAskCents).filter(x => x != null), 0.9) },
    noOffersAtSignal: priced.filter(m => m.pricing.qualified.atSignal.bestAskCents == null).length };
  const sizes = priced.length ? priced[0].pricing.qualified.atSignal.theoretical.sizes.map(s => s.budgetUsd) : [];
  out.theoretical = {};
  for (const sz of sizes) {
    const rows = priced.map(m => ({ m, s: m.pricing.qualified.atSignal.theoretical.sizes.find(x => x.budgetUsd === sz) })).filter(x => x.s && x.s.contracts > 0);
    const full = rows.filter(x => x.s.fullyFillable);
    const net = rows.reduce((a, x) => a + (x.s.netUsd || 0), 0);
    const byDay = {}; for (const x of rows) { const d = x.m.market.closeTime.slice(0, 10); (byDay[d] = byDay[d] || []).push(x.s.netUsd || 0); }
    const bb = S.blockBootstrap(Object.values(byDay), v => v.reduce((a, b) => a + b, 0) / v.length, 1000, 4242);
    out.theoretical[sz] = { opportunitiesWithAnyFill: rows.length, fullyFillable: full.length, fullyFillablePct: pct(full.length, priced.length),
      totalNetUsd: Math.round(net * 100) / 100, meanNetPerTradeUsd: rows.length ? Math.round(net / rows.length * 100) / 100 : null,
      meanNetCI95ByDayBootstrap: bb, totalCapitalUsd: Math.round(rows.reduce((a, x) => a + x.s.capitalUsd, 0)), losses: rows.filter(x => x.s.netUsd < 0).length };
  }
  out.limitations = ['theoretical fills assume the recorded book stayed untouched for the order (no queue, latency or competition): an upper bound',
    'accuracy is over completely observed markets only; partial and unobserved markets are listed in coverage and never counted as wins',
    'production\'s own threshold for LOCKED is recorded separately (configs); the 0.2 % criterion here is applied to Pin Radar\'s displayed flip risk'];
  return out;
}
function periods(markets, kind, now = Date.now()) {
  const day = 864e5, out = [];
  const closes = markets.map(m => m.market && Date.parse(m.market.closeTime)).filter(Number.isFinite);
  if (!closes.length) return out;
  const start = Math.min(...closes), end = Math.min(now, Math.max(...closes) + 1);
  const floorDay = t => Math.floor(t / day) * day;
  if (kind === 'daily') for (let t = floorDay(start); t < end; t += day) out.push(summarize(markets, { from: t, to: t + day, label: new Date(t).toISOString().slice(0, 10) }));
  if (kind === 'weekly') { let t = floorDay(start); t -= ((new Date(t).getUTCDay() + 6) % 7) * day; for (; t < end; t += 7 * day) out.push(summarize(markets, { from: t, to: t + 7 * day, label: 'week of ' + new Date(t).toISOString().slice(0, 10) })); }
  if (kind === 'monthly') { const d = new Date(start); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (t < end) { const n = new Date(t); const t2 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1); out.push(summarize(markets, { from: t, to: t2, label: new Date(t).toISOString().slice(0, 7) })); t = t2; } }
  return out;
}
module.exports = { summarize, periods, bucketOf, BUCKETS };
