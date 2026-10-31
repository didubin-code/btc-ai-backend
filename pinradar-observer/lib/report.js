/* Daily / weekly / monthly summaries from derived market records. Every figure carries its sample size.
   * Accuracy is over every observed qualifying signal whose market has an official result: a WRONG call always counts,
     whatever the coverage of its window. The subset whose windows were observed second by second is shown alongside.
   * Timing tables (by seconds remaining at the first qualifying signal) use only signals whose earlier seconds were all
     observed ("timing certain"); the others are counted separately.
   * Every 15-minute window in the period with no record at all is counted as unobserved.
   * Theoretical P&L uses only books received BEFORE the signal (never a later one).
   * Results are split by production build and LOCKED threshold in force, so a redeploy is never pooled silently. */
'use strict';
const S = require('./stats');
const BUCKETS = [['>180', 180, 1e9], ['180-121', 120, 180], ['120-91', 90, 120], ['90-61', 60, 90], ['60-31', 30, 60], ['30-0', -1, 30]];
const bucketOf = tau => (BUCKETS.find(([, lo, hi]) => tau > lo && tau <= hi) || ['?'])[0];
const pct = (a, b) => b ? Math.round(10000 * a / b) / 100 : null;
const q = (arr, p) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const closeOf = m => m.market && Date.parse(m.market.closeTime);

function acc(list, key) {
  const k = list.filter(m => m[key].won === false).length;
  return { n: list.length, wrong: k, accuracyPct: pct(list.length - k, list.length), errorCI95: S.clopperPearson(k, list.length), errorUpper95: S.upperBound(k, list.length),
    posteriors: list.length ? S.posteriors(k, list.length) : null };
}
function summarize(markets, { from = 0, to = 8.64e15, label = 'all' } = {}) {
  const M = markets.filter(m => { const c = closeOf(m); return c >= from && c < to; });
  /* every quarter-hour close in the period that has no record at all is unobserved */
  const closes = new Set(M.map(closeOf).filter(Number.isFinite));
  let expected = 0, missingWindows = 0;
  if (closes.size) { let lo = Infinity, hi = -Infinity; for (const c of closes) { if (c < lo) lo = c; if (c > hi) hi = c; }      // windows are 15 min apart: walk that grid
    for (let t = lo; t <= hi; t += 900e3) { expected++; if (!closes.has(t)) missingWindows++; } }
  const cov = { windowsExpected: expected, recorded: M.length, windowsWithNoRecord: missingWindows, complete: 0, partial: 0, unobserved: missingWindows, settled: 0, settlementMissing: 0 };
  for (const m of M) { cov[m.coverage ? m.coverage.status : 'unobserved']++; if (m.settlement && m.settlement.outcome) cov.settled++; else cov.settlementMissing++; }
  const settled = M.filter(m => m.settlement && m.settlement.outcome);
  const L = settled.filter(m => m.signal), Q = settled.filter(m => m.qualified);
  const Qc = Q.filter(m => m.coverage && m.coverage.status === 'complete');
  const out = { label, period: { from: new Date(from).toISOString(), to: to > 8e15 ? null : new Date(to).toISOString() }, coverage: cov,
    basis: 'accuracy over every observed signal with an official result (' + Q.length + ' qualifying); wrong calls always count' };
  const base = settled.filter(m => m.coverage && m.coverage.status !== 'unobserved');
  out.rates = {
    denominator: base.length + ' settled windows with Pin Radar records',
    lockedPct: pct(base.filter(m => m.signal).length, base.length), qualifiedPct: pct(base.filter(m => m.qualified).length, base.length),
    lockedAtT120Pct: pct(base.filter(m => m.atT120 && !m.atT120.unobserved && (m.atT120.state === 'LOCKED' || m.atT120.state === 'PROVEN LOCKED')).length, base.length),
    qualifiedAtT120Pct: pct(base.filter(m => m.atT120 && m.atT120.qualifies).length, base.length),
    firstQualifiedInLast120Pct: pct(base.filter(m => m.qualified && m.qualified.timingCertain && m.qualified.tau <= 120).length, base.length),
    qualifiedAnywhereInLast120Pct: pct(base.filter(m => m.lockedAnywhereInLast120).length, base.length),
    continuousToClosePct: pct(Q.filter(m => m.qualified.category === 'continuous-won').length, Q.length),
    warnedAfterQualifiedPct: pct(Q.filter(m => m.qualified.flags.reversalWarningLater).length, Q.length),
  };
  /* the frozen primary rule (rules/primary_v1.json): one entry per market at most, held to settlement. The PROSPECTIVE
     live dataset (whole final 300 s observed live, books recorded) is the validation set; the retrospective back-fill is
     reported separately and never pooled with it. Unpriced entries are excluded from profit and capacity, and counted. */
  const dsOf = m => m.provenance ? m.provenance.dataset : 'retrospective-backfill';
  const block = ML => {
    const S = ML.filter(m => m.settlement && m.settlement.outcome), PE = S.filter(m => m.primary && m.primary.status === 'entry');
    const cnt = (k) => ({ observed: PE.filter(m => m.primary.firstLater && m.primary.firstLater[k] && m.primary.firstLater[k] !== 'indeterminate').length,
      indeterminate: PE.filter(m => m.primary.firstLater && m.primary.firstLater[k] === 'indeterminate').length });
    const priced = PE.filter(m => m.pricing && m.pricing.primary && m.pricing.primary.atSignal && m.pricing.primary.atSignal.theoretical);
    const pricedSet = new Set(priced);
    const sizes = priced.length ? priced[0].pricing.primary.atSignal.theoretical.sizes.map(x => x.budgetUsd) : [];
    const theo = {};
    for (const sz of sizes) {
      const rows = priced.map(m => ({ m, s: m.pricing.primary.atSignal.theoretical.sizes.find(x => x.budgetUsd === sz) })).filter(x => x.s && x.s.contracts > 0);
      const byDay = {}; for (const x of rows) { const d = x.m.market.closeTime.slice(0, 10); (byDay[d] = byDay[d] || []).push(x.s.netUsd || 0); }
      const seq = rows.map(x => x.s.netUsd || 0);
      theo[sz] = { withAnyFill: rows.length, fullyFillable: rows.filter(x => x.s.fullyFillable).length, totalNetUsd: Math.round(seq.reduce((a, b) => a + b, 0) * 100) / 100,
        worstTradeUsd: seq.length ? seq.reduce((a, b) => Math.min(a, b), Infinity) : null,
        meanNetCI95ByDayBootstrap: Object.keys(byDay).length ? require('./stats').blockBootstrap(Object.values(byDay), v => v.reduce((a, b) => a + b, 0) / v.length, 1000, 4242) : null };
      theo[sz].maxDrawdownUsd = require('./stats').maxDrawdown(seq);
    }
    return { windows: { recorded: ML.length, settled: S.length, entry: ML.filter(m => m.primary && m.primary.status === 'entry').length,
        noQualifyingSignal: ML.filter(m => m.primary && m.primary.status === 'no-qualifying-signal').length, notDeterminable: ML.filter(m => !m.primary || m.primary.status === 'not-determinable').length,
        entryUnsettled: ML.filter(m => m.primary && m.primary.status === 'entry' && !(m.settlement && m.settlement.outcome)).length },
      accuracy: acc(PE, 'primary'), timingCertainOnly: acc(PE.filter(m => m.primary.timingCertain), 'primary'),
      entryType: PE.reduce((a, m) => { a[m.primary.entryType] = (a[m.primary.entryType] || 0) + 1; return a; }, {}),
      laterEvents: { lostLocked: cnt('lostLocked'), riskAboveThreshold: cnt('riskAboveThreshold'), reversalWarning: cnt('reversalWarning'), directionFlip: cnt('directionFlip') },
      wrong: PE.filter(m => m.primary.won === false).map(m => ({ ticker: m.ticker, tau: m.primary.tau, side: m.primary.side, pFlip: m.primary.pFlip, entryType: m.primary.entryType, result: m.settlement.result })),
      pricing: { priced: priced.length, excludedUnpriced: PE.length - priced.length,
        excludedReasons: PE.filter(m => !pricedSet.has(m)).reduce((a, m) => { const at = m.pricing && m.pricing.primary && m.pricing.primary.atSignal; const w = at ? String(at.unavailable || 'no offer on the called side').replace(/[0-9]+/g, '#') : 'no pricing'; a[w] = (a[w] || 0) + 1; return a; }, {}),
        theoreticalHoldToSettlement: theo, note: 'hypothetical taker fills against the recorded book, hold to settlement; not executions' } };
  };
  const PM = M.find(m => m.primary);
  out.primary = { rule: PM ? PM.primary.rule : null, ruleSha256: PM ? PM.primary.ruleSha256 : null,
    prospectiveLive: block(M.filter(m => dsOf(m) === 'prospective-live')),
    retrospectiveBackfill: block(M.filter(m => dsOf(m) === 'retrospective-backfill')),
    missingWindowsInPeriod: missingWindows };
  out.firstLocked = acc(L, 'signal');
  out.qualified = acc(Q, 'qualified');
  out.qualifiedCompleteWindows = acc(Qc, 'qualified');
  out.wrongCalls = Q.filter(m => m.qualified.won === false).map(m => ({ ticker: m.ticker, tau: m.qualified.tau, side: m.qualified.side, pFlip: m.qualified.pFlip, coverage: m.coverage && m.coverage.status, result: m.settlement.result }));
  out.categories = Object.fromEntries(['continuous-won', 'unlocked-won', 'warned-won', 'changed-direction-won', 'won-partially-observed', 'wrong'].map(c => [c, Q.filter(m => m.qualified.category === c).length]));
  const Qt = Q.filter(m => m.qualified.timingCertain);
  out.byFirstQualifiedTime = { timingCertain: Qt.length, timingUncertain: Q.length - Qt.length, ...Object.fromEntries(BUCKETS.map(([b]) => [b, acc(Qt.filter(m => bucketOf(m.qualified.tau) === b), 'qualified')])) };
  out.firstQualifiedTauSec = { p10: q(Qt.map(m => m.qualified.tau), 0.1), median: q(Qt.map(m => m.qualified.tau), 0.5), p90: q(Qt.map(m => m.qualified.tau), 0.9) };
  const byBuild = {}; for (const m of Q) { const k = (m.production && m.production.build || '?') + ' / LOCK_MAX_FLIP ' + (m.production && m.production.lockMaxFlip); (byBuild[k] = byBuild[k] || []).push(m); }
  out.byProductionBuild = Object.fromEntries(Object.entries(byBuild).map(([k, l]) => [k, acc(l, 'qualified')]));
  /* prices and theoretical results at the qualifying signal */
  const priced = Q.filter(m => m.pricing && m.pricing.qualified && m.pricing.qualified.atSignal && m.pricing.qualified.atSignal.theoretical);
  const asks = priced.map(m => m.pricing.qualified.atSignal.bestAskCents).filter(x => x != null), pricedSet = new Set(priced);
  out.pricing = { withContemporaneousBook: priced.length, withoutBook: Q.length - priced.length,
    unavailableReasons: Q.filter(m => !pricedSet.has(m)).reduce((a, m) => { const w = m.pricing && m.pricing.qualified && m.pricing.qualified.atSignal ? String(m.pricing.qualified.atSignal.unavailable || '?').replace(/[0-9]+/g, '#') : 'no pricing'; a[w] = (a[w] || 0) + 1; return a; }, {}),
    calledSideBestAskCents: { p10: q(asks, 0.1), median: q(asks, 0.5), p90: q(asks, 0.9) }, noOffersAtSignal: priced.length - asks.length };
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
  out.limitations = ['theoretical fills assume the recorded book stayed untouched for the order (no queue, latency or competition): an upper bound, never a realised result',
    'a wrong call always counts; a win in a window not observed second by second from the signal to the close is "won-partially-observed", not a clean win',
    'production\'s own LOCKED threshold is shown per build; the 0.2 % criterion is applied to Pin Radar\'s displayed flip risk'];
  return out;
}
/* the fields of a market record that summarize() and periods() use: a report over a long history keeps these only */
const slimPrice = at => ({ atSignal: !at ? at : at.theoretical ? { bestAskCents: at.bestAskCents, theoretical: { sizes: at.theoretical.sizes.map(x => ({ budgetUsd: x.budgetUsd, contracts: x.contracts, fullyFillable: x.fullyFillable, netUsd: x.netUsd, capitalUsd: x.capitalUsd })) } } : { unavailable: at.unavailable } });
function slim(m) {
  const q = m.qualified, at = m.pricing && m.pricing.qualified && m.pricing.qualified.atSignal;
  return { ticker: m.ticker, market: m.market && { closeTime: m.market.closeTime }, coverage: m.coverage && { status: m.coverage.status },
    settlement: m.settlement && { outcome: m.settlement.outcome, result: m.settlement.result }, signal: m.signal && { won: m.signal.won },
    qualified: q && { won: q.won, tau: q.tau, timingCertain: q.timingCertain, category: q.category, side: q.side, pFlip: q.pFlip, flags: { reversalWarningLater: q.flags.reversalWarningLater } },
    atT120: m.atT120 && { unobserved: m.atT120.unobserved, state: m.atT120.state, qualifies: m.atT120.qualifies }, lockedAnywhereInLast120: m.lockedAnywhereInLast120,
    production: m.production && { build: m.production.build, lockMaxFlip: m.production.lockMaxFlip },
    provenance: m.provenance && { dataset: m.provenance.dataset },
    primary: m.primary && { rule: m.primary.rule, ruleSha256: m.primary.ruleSha256, status: m.primary.status, entryType: m.primary.entryType, won: m.primary.won, tau: m.primary.tau, side: m.primary.side, pFlip: m.primary.pFlip, timingCertain: m.primary.timingCertain, firstLater: m.primary.firstLater },
    pricing: { primary: slimPrice(m.pricing && m.pricing.primary && m.pricing.primary.atSignal), qualified: { atSignal: !at ? at : at.theoretical ? { bestAskCents: at.bestAskCents, theoretical: { sizes: at.theoretical.sizes.map(x => ({ budgetUsd: x.budgetUsd, contracts: x.contracts, fullyFillable: x.fullyFillable, netUsd: x.netUsd, capitalUsd: x.capitalUsd })) } } : { unavailable: at.unavailable } } } };
}
function periods(markets, kind, now = Date.now()) {
  const day = 864e5, out = [];
  const closes = markets.map(closeOf).filter(Number.isFinite);
  if (!closes.length) return out;
  let start = Infinity, last = -Infinity; for (const c of closes) { if (c < start) start = c; if (c > last) last = c; }
  const end = Math.min(now, last + 1);
  const floorDay = t => Math.floor(t / day) * day;
  if (kind === 'daily') for (let t = floorDay(start); t < end; t += day) out.push(summarize(markets, { from: t, to: t + day, label: new Date(t).toISOString().slice(0, 10) }));
  if (kind === 'weekly') { let t = floorDay(start); t -= ((new Date(t).getUTCDay() + 6) % 7) * day; for (; t < end; t += 7 * day) out.push(summarize(markets, { from: t, to: t + 7 * day, label: 'week of ' + new Date(t).toISOString().slice(0, 10) })); }
  if (kind === 'monthly') { const d = new Date(start); let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    while (t < end) { const n = new Date(t); const t2 = Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1); out.push(summarize(markets, { from: t, to: t2, label: new Date(t).toISOString().slice(0, 7) })); t = t2; } }
  return out;
}
module.exports = { summarize, periods, slim, bucketOf, BUCKETS };
