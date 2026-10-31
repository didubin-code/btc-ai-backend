/* RECONSTRUCTED evidence for the 0.2 % / two-minute hypothesis, from the earlier chronological replay of the PRODUCTION
   Pin Radar 2.8 engine (validation/replay_chrono.js, build sha 0efd86c9..., = btc-ai-backend main) over 25,982 real Kalshi
   KXBTC15M contracts (Jan 13 - Oct 15 2026). These are NOT observed production signals:
     * the price feed is Binance BTCUSDC 1 Hz driving the three index venues, not production's live feeds;
     * one decision per second, 750 ms into the second (production decides every 500 ms);
     * outcomes are Kalshi's official results; prices are Kalshi's public trade prints (no order-book history exists).
   Definitions (fixed in advance, not tuned):
     LOCKED       engine state LOCKED or PROVEN LOCKED (production threshold: modelled flip risk <= 0.5 %)
     qualifying   LOCKED with the displayed modelled flip risk pFlip <= 0.002 (the 0.2 % hypothesis)
     first        the first qualifying second of the window; its side is the prediction; won = side equals the result
     continuous   every decision second from the first qualifying one to the close is LOCKED on the same side
   usage: node research/hypothesis_28.js [dataDir] > results.json */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), readline = require('readline');
const S = require('../lib/stats');
const DATA = process.argv[2] || process.env.PR_DATA || '/home/user/data_val';
const REC = path.join(DATA, 'replay', 'r28_usdc.ndjson'), TRACE = path.join(DATA, 'replay', 'r28_usdc.trace.ndjson'), TRADES = path.join(DATA, 'kalshi', 'trades');
const isL = s => s === 'LOCKED' || s === 'PROVEN LOCKED';
const TH = 0.002;
const BK = [['300-181', 180, 300], ['180-121', 120, 180], ['120-91', 90, 120], ['90-61', 60, 90], ['60-31', 30, 60], ['30-0', -1, 30]];
const bucket = tau => (BK.find(([, lo, hi]) => tau > lo && tau <= hi) || ['?'])[0];
const fee = (pC, C) => Math.ceil(0.07 * C * (pC / 100) * (1 - pC / 100) * 100 - 1e-9) / 100;
/* Kalshi created_time: ISO with 0-6 fractional digits ("...:33Z", "...:33.1Z", "...:33.009864Z") -> microseconds */
const tsUs = s => { const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(String(s)); if (!m) return NaN; return Date.parse(m[1] + 'Z') * 1000 + Number(((m[2] || '') + '000000').slice(0, 6)); };

(async () => {
  const recs = new Map();
  for (const l of fs.readFileSync(REC, 'utf8').split('\n')) { if (!l) continue; const r = JSON.parse(l); recs.set(r.ticker, r); }
  /* stream the per-second trace (LOCKED and REVERSAL WARNING seconds only) */
  const tr = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(TRACE), crlfDelay: Infinity });
  for await (const l of rl) { if (!l) continue; const x = JSON.parse(l); let a = tr.get(x.tk); if (!a) tr.set(x.tk, a = []); a.push(x); }
  const out = { source: { records: REC, trace: TRACE, build: 'pin-radar-2.8 (sha 0efd86c9..., production main)', feed: 'Binance BTCUSDC 1 Hz (substitute)', label: 'RECONSTRUCTED (historical replay), not observed production signals' } };
  const M = [];
  for (const r of recs.values()) {
    if (!r.truth) continue;
    const t = (tr.get(r.ticker) || []).sort((a, b) => b.tau - a.tau);
    const fl = t.find(x => isL(x.st));
    const fq = t.find(x => isL(x.st) && x.pf != null && x.pf <= TH);
    const fq120 = t.find(x => x.tau <= 120 && isL(x.st) && x.pf != null && x.pf <= TH);
    const f120 = r.fixed && r.fixed['120'];
    let cont = null, warned = null, unlocked = null, dirChange = null;
    if (fq) {
      const after = t.filter(x => x.tau < fq.tau);
      const lockedSame = after.filter(x => isL(x.st) && x.side === fq.side).length;
      const expected = Math.round(fq.tau - 0.25);                         // decision seconds after the first one (tau x.25 down to 0.25)
      warned = after.some(x => x.st === 'REVERSAL WARNING');
      dirChange = after.some(x => isL(x.st) && x.side !== fq.side);
      cont = lockedSame >= expected && !warned && !dirChange;
      unlocked = !cont && !warned && !dirChange;
    }
    M.push({ tk: r.ticker, closeTs: r.closeTs, truth: r.truth, margin: r.marginUsd, dataUnreliable: r.dataUnreliable,
      locked: !!fl, flTau: fl ? fl.tau : null, flSide: fl ? fl.side : null,
      q: !!fq, qTau: fq ? fq.tau : null, qSide: fq ? fq.side : null, qPf: fq ? fq.pf : null, qTs: fq ? fq.ts : null, qWon: fq ? fq.side === r.truth : null,
      q120: !!fq120, q120Tau: fq120 ? fq120.tau : null, q120Side: fq120 ? fq120.side : null, q120Ts: fq120 ? fq120.ts : null, q120Won: fq120 ? fq120.side === r.truth : null,
      lockedAt120: !!(f120 && isL(f120.st)), qualAt120: !!(f120 && isL(f120.st) && f120.pFlip != null && f120.pFlip <= TH), at120Won: f120 && isL(f120.st) ? f120.side === r.truth : null,
      cont, warned, unlocked, dirChange, sigma: r.firstLocked ? r.firstLocked.sigmaRawBps : null, regime: r.firstLocked ? r.firstLocked.bucket : null });
  }
  const N = M.length, pct = (a, b) => b ? Math.round(1e4 * a / b) / 100 : null;
  const acc = list => { const n = list.length, k = list.filter(x => x.won === false).length; const cp = S.clopperPearson(k, n);
    return { n, wrong: k, accuracyPct: pct(n - k, n), errorPct: pct(k, n), errorCI95pct: n ? [+(100 * cp.lo).toFixed(4), +(100 * cp.hi).toFixed(4)] : null, errorUpper95OneSidedPct: n ? +(100 * S.upperBound(k, n)).toFixed(4) : null }; };
  const Q = M.filter(m => m.q).map(m => ({ ...m, won: m.qWon })), Q120 = M.filter(m => m.q120).map(m => ({ ...m, won: m.q120Won }));
  out.marketsWithOutcome = N;
  out.rates = {
    reachedLockedPct: pct(M.filter(m => m.locked).length, N), lockedAtT120Pct: pct(M.filter(m => m.lockedAt120).length, N),
    firstLockedWithinLast120Pct: pct(M.filter(m => m.locked && m.flTau <= 120).length, N),
    reachedQualifyingPct: pct(Q.length, N), qualifyingAtT120Pct: pct(M.filter(m => m.qualAt120).length, N),
    firstQualifyingWithinLast120Pct: pct(Q.filter(m => m.qTau <= 120).length, N), qualifyingAnywhereInLast120Pct: pct(Q120.length, N),
    continuousToCloseAfterQualifyingPct: pct(Q.filter(m => m.cont).length, Q.length), reversalWarningAfterQualifyingPct: pct(Q.filter(m => m.warned).length, Q.length),
    directionChangeAfterQualifyingPct: pct(Q.filter(m => m.dirChange).length, Q.length), unlockedThenRelockedOrEndedPct: pct(Q.filter(m => m.unlocked).length, Q.length) };
  out.accuracy = { firstQualifying: acc(Q), firstQualifyingAtOrAfterT120: acc(Q120), qualifiedExactlyAtT120: acc(M.filter(m => m.qualAt120).map(m => ({ ...m, won: m.at120Won }))) };
  out.accuracy.firstQualifyingPosteriors = S.posteriors(Q.filter(m => !m.won).length, Q.length);
  out.accuracy.atOrAfterT120Posteriors = S.posteriors(Q120.filter(m => !m.won).length, Q120.length);
  out.byFirstQualifyingInterval = Object.fromEntries(BK.map(([b]) => [b, acc(Q.filter(m => bucket(m.qTau) === b))]));
  out.categories = { continuousWon: Q.filter(m => m.cont && m.won).length, unlockedWon: Q.filter(m => m.unlocked && m.won).length, warnedWon: Q.filter(m => m.warned && !m.dirChange && m.won).length,
    directionChangedWon: Q.filter(m => m.dirChange && m.won).length, wrong: Q.filter(m => !m.won).length };
  const CB = [[0, 0.0002], [0.0002, 0.0005], [0.0005, 0.001], [0.001, 0.0015], [0.0015, 0.002 + 1e-12]];
  out.calibrationOfModelledFlipRisk = CB.map(([lo, hi]) => { const l = Q.filter(m => m.qPf >= lo && m.qPf < hi), k = l.filter(m => !m.won).length; const cp = S.clopperPearson(k, l.length);
    return { pFlipRange: [lo, Math.min(hi, 0.002)], n: l.length, wrong: k, meanModelledPct: l.length ? +(100 * l.reduce((a, m) => a + m.qPf, 0) / l.length).toFixed(4) : null,
      observedPct: l.length ? +(100 * k / l.length).toFixed(4) : null, observedCI95pct: l.length ? [+(100 * cp.lo).toFixed(4), +(100 * cp.hi).toFixed(4)] : null }; });
  out.wrongCalls = Q.filter(m => !m.won).map(m => ({ ticker: m.tk, firstQualifyingTau: m.qTau, side: m.qSide, pFlip: m.qPf, truth: m.truth, marginUsd: m.margin, continuous: m.cont, warnedAfter: m.warned }));
  /* by month (regime over time; the model was developed on earlier data, so later months are the more honest test) */
  const byMonth = {}; for (const m of Q) { const k = new Date(m.closeTs * 1000).toISOString().slice(0, 7); (byMonth[k] = byMonth[k] || []).push(m); }
  out.byMonth = Object.fromEntries(Object.entries(byMonth).sort().map(([k, l]) => [k, acc(l)]));
  const bySig = {}; for (const m of Q) { const k = m.regime == null ? '?' : String(m.regime); (bySig[k] = bySig[k] || []).push(m); }
  out.byVolatilityBucket = Object.fromEntries(Object.entries(bySig).sort().map(([k, l]) => [k, acc(l)]));
  /* day-block bootstrap of the error rate (calls on one day are not independent) */
  const days = {}; for (const m of Q) { const d = new Date(m.closeTs * 1000).toISOString().slice(0, 10); (days[d] = days[d] || []).push(m.won ? 0 : 1); }
  out.accuracy.firstQualifyingErrorDayBootstrap = S.blockBootstrap(Object.values(days), v => 100 * v.reduce((a, b) => a + b, 0) / v.length, 2000, 2828);

  /* prices from Kalshi's public trade prints (called side), for the first qualifying second and for the entry at T-120 or later */
  const P = [];
  for (const [label, list, tsKey, sideKey, wonKey, tauKey] of [['firstQualifying', Q, 'qTs', 'qSide', 'qWon', 'qTau'], ['atOrAfterT120', Q120, 'q120Ts', 'q120Side', 'q120Won', 'q120Tau']]) {
    const rows = [];
    for (const m of list) {
      const f = path.join(TRADES, m.tk + '.json.gz'); if (!fs.existsSync(f)) continue;
      /* files are newest-first; sort oldest-first by microsecond, and for equal times keep the file's first entry LAST (= the newest) */
      const pr = (JSON.parse(zlib.gunzipSync(fs.readFileSync(f))).trades || []).map((x, i) => ({ us: tsUs(x.created_time), i, y: Number(x.yes_price_dollars) * 100, n: Number(x.count_fp), t: x.taker_side }))
        .filter(x => Number.isFinite(x.us)).sort((a, b) => a.us - b.us || b.i - a.i).map(x => ({ ...x, ms: Math.floor(x.us / 1000) }));
      const up = m[sideKey] === 'UP', ts = m[tsKey];
      const called = pr.filter(x => (up ? x.t === 'yes' : x.t === 'no')).map(x => ({ ms: x.ms, p: Math.round((up ? x.y : 100 - x.y) * 100) / 100, n: x.n }));
      const before = called.filter(x => x.ms <= ts).pop();
      const after = called.filter(x => x.ms > ts);
      const usdAfter = after.reduce((a, x) => a + x.p / 100 * x.n, 0);
      rows.push({ tk: m.tk, day: new Date(m.closeTs * 1000).toISOString().slice(0, 10), won: m[wonKey], tau: m[tauKey], pf: label === 'firstQualifying' ? m.qPf : null, lastBefore: before ? { p: before.p, ageSec: (ts - before.ms) / 1000 } : null,
        calledSideUsdAfterSignal: Math.round(usdAfter), vwapAfter: after.length ? after.reduce((a, x) => a + x.p * x.n, 0) / after.reduce((a, x) => a + x.n, 0) : null });
    }
    const priced = rows.filter(r => r.lastBefore && r.lastBefore.ageSec <= 10);
    const ps = priced.map(r => r.lastBefore.p).sort((a, b) => a - b), q = p => ps.length ? ps[Math.min(ps.length - 1, Math.floor(p * ps.length))] : null;
    /* theoretical P&L of a $1,000 order filled at that print price (optimistic: assumes the price was still there for the size) */
    const pnl = priced.map(r => { const p = r.lastBefore.p, C = Math.floor(1000 / (p / 100)), cost = C * p / 100 + fee(p, C); return { day: r.day, net: r.won ? C - cost : -cost, p, tau: r.tau, won: r.won }; });
    /* a "defensible" expected value per $1,000: wins at their observed average, the loss rate at its exact one-sided 95 % upper bound */
    const cell = l => { if (!l.length) return { n: 0 }; const k = l.filter(x => !x.won).length, wins = l.filter(x => x.won), pU = S.upperBound(k, l.length);
      const mw = wins.length ? wins.reduce((a, x) => a + x.net, 0) / wins.length : 0, ml = k ? l.filter(x => !x.won).reduce((a, x) => a + x.net, 0) / k : -1000;
      return { n: l.length, losses: k, meanNetUsdPer1000: Math.round(l.reduce((a, x) => a + x.net, 0) / l.length * 100) / 100, medianPriceCents: l.map(x => x.p).sort((a, b) => a - b)[Math.floor(l.length / 2)],
        lossRateUpper95Pct: +(100 * pU).toFixed(4), conservativeEvUsdPer1000: Math.round(((1 - pU) * mw + pU * ml) * 100) / 100 }; };
    const PB = [[0, 90], [90, 98], [98, 99], [99, 99.5], [99.5, 99.8], [99.8, 100]];
    const byInterval = Object.fromEntries(BK.map(([b]) => [b, cell(pnl.filter(x => bucket(x.tau) === b))]));
    const grid = {}; for (const [b] of BK) for (const [lo, hi] of PB) { const c = cell(pnl.filter(x => bucket(x.tau) === b && x.p >= lo && x.p < hi)); if (c.n) grid[b + ' | ' + lo + '-' + hi + ' c'] = c; }
    const byDay = {}; for (const x of pnl) (byDay[x.day] = byDay[x.day] || []).push(x.net);
    const priceBk = [[0, 90], [90, 95], [95, 98], [98, 99], [99, 99.5], [99.5, 100]].map(([lo, hi]) => { const l = pnl.filter(x => x.p >= lo && x.p < hi);
      return [lo + '-' + hi, { n: l.length, meanNetUsdPer1000: l.length ? Math.round(l.reduce((a, x) => a + x.net, 0) / l.length * 100) / 100 : null, losses: l.filter(x => x.net < 0).length }]; });
    P.push([label, { signals: list.length, withPrints: rows.length, withCalledSidePrintWithin10sBefore: priced.length,
      calledSidePriceCents: { p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9) },
      byEntryInterval: byInterval, gridIntervalByPrice: grid,
      pnlPer1000: { n: pnl.length, totalUsd: Math.round(pnl.reduce((a, x) => a + x.net, 0)), meanUsd: pnl.length ? Math.round(pnl.reduce((a, x) => a + x.net, 0) / pnl.length * 100) / 100 : null,
        meanCI95DayBootstrap: S.blockBootstrap(Object.values(byDay), v => v.reduce((a, b) => a + b, 0) / v.length, 2000, 99), losses: pnl.filter(x => x.net < 0).length, byPrice: Object.fromEntries(priceBk) },
      capacity: { medianCalledSideUsdPrintedAfterSignal: (() => { const v = rows.map(r => r.calledSideUsdAfterSignal).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; })(),
        pctWithAtLeast75kPrintedAfterSignal: pct(rows.filter(r => r.calledSideUsdAfterSignal >= 75000).length, rows.length),
        pctWithAtLeast10kPrintedAfterSignal: pct(rows.filter(r => r.calledSideUsdAfterSignal >= 10000).length, rows.length),
        note: 'dollars other traders actually bought on the called side between the signal and the close: an upper bound on what a taker could have bought, and only if that liquidity would also have been offered to us' } }]);
  }
  out.pricesFromPrints = Object.fromEntries(P);
  out.limitations = ['RECONSTRUCTED signals from a historical replay on a substitute feed: production may differ, especially in the last ~20 s where the feed matters',
    'prices are trade prints, not order books: a print shows a price that traded, not that it was available to us or in size',
    'the $1,000 P&L assumes a fill at the last called-side print within 10 s before the signal, with no slippage: optimistic',
    'calls within a day are correlated (same market regime): day-block bootstrap intervals are given alongside the binomial ones'];
  console.log(JSON.stringify(out, null, 1));
})();
