/* Continuous chronological replay of a REAL Pin Radar server build over a 1 Hz price history and a list of Kalshi
   KXBTC15M markets, as the live server would have seen them.

   No look-ahead, by construction:
     * second t: the venues get the prices OF second t only; sampleIndex() records them (the same 1 Hz ring the live server keeps);
     * decisions in each window's final HORIZON seconds use only the ring and the strike (known at the window's open);
     * a window's official value (Kalshi expiration_value) reaches the engine only SETTLE_LAG seconds AFTER its close, through the
       server's own addBasisSample() (the live basis model), exactly as finalizeWindow() does live;
     * the outcome is used for scoring only after the replay of that window, in the output record.
   Kalshi order books are not replayed (no history exists): the trade action is NO BOOK; execution is scored separately from
   Kalshi's trade prints (execution.py).

   Inputs
     --server <pinradar_server.js>        the build under test (any 2.x build with the 2.5+ API)
     --sec <dir>                          1 Hz prices: <dir>/<venue>/<YYYY-MM-DD>.f64 (86,400 float64 LE, NaN = no price that second)
     --venues proxy | cb,kr[,bs]          'proxy': <dir>/proxy/*.f64 drives all three venues (+0.4 / -0.4 / 0 $ offsets);
                                          otherwise each listed venue reads its own directory (missing venue = never fresh)
     --markets <markets.ndjson>           {ticker, openTs, closeTs, strike, official, result} (unix s; official = expiration_value)
     --from / --to <ISO>                  closes in [from, to) are scored; sampling starts --warm seconds before --from
     --warm 14400 (4 h, so the basis model has settled windows)  --horizon 300  --phase 750 (ms into the second of the decision)  --qa 50 (venue quote age at the decision, ms)
     --settle-lag 5  --exec-sec <n> (default: the build's)  --out <records.ndjson>  [--trace <locked_seconds.ndjson>]     */
'use strict';
const fs = require('fs'), path = require('path');
const A = {}; for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
for (const k of ['server', 'sec', 'markets', 'from', 'to', 'out']) if (!A[k]) { console.error('missing --' + k); process.exit(2); }
const WARM = +(A.warm || 14400), HOR = +(A.horizon || 300), PHASE = +(A.phase || 750), QA = +(A.qa || 50), LAG = +(A['settle-lag'] || 5);
const VEN = (A.venues || 'proxy').split(',');
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
const S = require(path.resolve(A.server));
const t0 = Math.floor(Date.parse(A.from) / 1000), t1 = Math.floor(Date.parse(A.to) / 1000);
const markets = fs.readFileSync(A.markets, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(m => m.closeTs > t0 - WARM && m.closeTs <= t1 + 900).sort((a, b) => a.closeTs - b.closeTs);
/* ---- 1 Hz price access (one day per file, cached) ---- */
const cache = new Map();
function dayArr(venue, day) {
  const k = venue + '/' + day; if (cache.has(k)) return cache.get(k);
  const f = path.join(A.sec, venue, day + '.f64'); let a = null;
  if (fs.existsSync(f)) { const b = fs.readFileSync(f); a = new Float64Array(b.buffer, b.byteOffset, b.length / 8); }
  cache.set(k, a); if (cache.size > 12) cache.delete(cache.keys().next().value); return a;
}
function px(venue, t) { const d = new Date(t * 1000).toISOString().slice(0, 10), a = dayArr(venue, d); if (!a) return NaN; const v = a[t - Date.parse(d + 'T00:00:00Z') / 1000]; return v > 0 ? v : NaN; }
const VMAP = VEN[0] === 'proxy' ? [['coinbase', 'proxy', 0.4], ['kraken', 'proxy', -0.4], ['bitstamp', 'proxy', 0]]
  : [['coinbase', 'cb', 0], ['kraken', 'kr', 0], ['bitstamp', 'bs', 0]].filter(x => VEN.includes(x[1]));
const lastSeen = {};
function setVenues(t, nowMs) {
  for (const [name, src, off] of VMAP) {
    const v = px(src, t), V = S.VENUES[name]; if (!V) continue;
    if (Number.isFinite(v)) { Object.assign(V, { mid: v + off, bidDepth: 2, askDepth: 2, lastQuoteTs: nowMs - 40, lastMsgTs: nowMs }); lastSeen[name] = nowMs - 40; }
    else if (lastSeen[name]) { V.lastMsgTs = nowMs; }          // socket alive, no new quote this second (the server's freshness rules decide)
  }
  for (const name of ['coinbase', 'kraken', 'bitstamp']) if (!VMAP.some(x => x[0] === name) && S.VENUES[name]) Object.assign(S.VENUES[name], { mid: NaN, lastQuoteTs: 0, lastMsgTs: 0 });
}
/* ---- replay ---- */
const isL = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
const FIX = [120, 90, 60, 45, 30, 20, 15, 10, 5, 3];
const out = fs.createWriteStream(A.out), trace = A.trace ? fs.createWriteStream(A.trace) : null;
S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20;
S.IDX.ring.length = 0; if (S.BASIS) { S.BASIS.samples.length = 0; S.BASIS.byKey.clear(); }
let mi = 0, cur = null, rows = [], settleQ = [], nOut = 0, nDec = 0;
const tStart = t0 - WARM;
function emit(m, rs) {
  const truth = m.result === 'yes' ? 'UP' : m.result === 'no' ? 'DOWN' : null;
  const fl = rs.find(r => isL(r.st)), after = fl ? rs.filter(r => r.tau < fl.tau) : [];
  const rev = fl ? after.find(r => r.st === 'REVERSAL WARNING' || (isL(r.st) && r.side !== fl.side)) : null;
  const at = T => rs.find(r => r.tau <= T + 1e-9 && r.tau > T - 1) || null;
  const rec = { ticker: m.ticker, closeTs: m.closeTs, strike: m.strike, official: m.official, truth, marginUsd: m.official != null ? +(m.official - m.strike).toFixed(2) : null,
    decisions: rs.length, dataUnreliable: rs.filter(r => r.st === 'DATA UNRELIABLE').length,
    firstLocked: fl ? { tau: fl.tau, side: fl.side, correct: truth ? fl.side === truth : null, pFlip: fl.pf, pFlipCons: fl.pfc, gapUsd: fl.gap, cushionSigma: fl.cush,
      sigmaRawBps: fl.sig, bucket: fl.bk, momentum: fl.mom, nLock: fl.nl, requiredMoveUsd: fl.req, basisMu: fl.mu } : null,
    reversalAfterLocked: rev ? { tau: rev.tau, st: rev.st, side: rev.side, pFlip: rev.pf } : null,
    lockedSeconds: rs.filter(r => isL(r.st)).length, wrongLockedSeconds: truth ? rs.filter(r => isL(r.st) && r.side !== truth).length : null,
    fixed: Object.fromEntries(FIX.map(T => { const r = at(T); return [T, r ? { st: r.st, side: r.side, pFlip: r.pf, correct: isL(r.st) && truth ? r.side === truth : null } : null]; })),
    basisN: S.BASIS ? S.BASIS.samples.length : null };
  out.write(JSON.stringify(rec) + '\n'); nOut++;
  if (trace) for (const r of rs) if (isL(r.st) || r.st === 'REVERSAL WARNING') trace.write(JSON.stringify({ tk: m.ticker, ts: r.ts, tau: r.tau, st: r.st, side: r.side, pf: r.pf, pfc: r.pfc, gap: r.gap }) + '\n');
}
const wall = realNow();
try {
  for (let t = tStart; t < t1; t++) {
    NOW = t * 1000 + 100;
    setVenues(t, NOW);
    S.sampleIndex();
    while (mi < markets.length && markets[mi].closeTs < t) mi++;
    const m = markets[mi] && markets[mi].closeTs - 900 < t && t <= markets[mi].closeTs ? markets[mi] : null;
    if (m !== cur) {
      if (cur && cur.closeTs >= t0) emit(cur, rows);
      if (cur) settleQ.push({ m: cur, at: cur.closeTs + LAG });
      cur = m; rows = [];
    }
    while (settleQ.length && settleQ[0].at <= t) {                      // the official value arrives after the close
      const { m: sm } = settleQ.shift();
      if (Number.isFinite(sm.official)) { const pa = S.proxyWindowAverage(sm.closeTs * 1000);
        if (pa.n >= 57) S.addBasisSample('close:' + sm.closeTs * 1000, pa.mean, sm.official, { ticker: sm.ticker, n: pa.n }); }
    }
    if (!m) continue;
    S.KAL.market = { ticker: m.ticker, strike: m.strike, closeMs: m.closeTs * 1000, openMs: (m.closeTs - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
    S.KAL.ob = null; S.KAL.obTs = 0;
    const tau = m.closeTs - t - PHASE / 1000;
    if (!(tau > 0 && tau <= HOR) || m.closeTs < t0) continue;
    NOW = t * 1000 + PHASE; S.KAL.ts = NOW - 120;
    for (const [name] of VMAP) { const V = S.VENUES[name]; if (V && V.lastQuoteTs > t * 1000) V.lastQuoteTs = NOW - QA; }
    const kal = S.getKalshiContext(), liveIdx = S.computeIndex(NOW);
    const used = liveIdx ? Object.values(S.VENUES).filter(v => liveIdx.used.includes(v.name)) : [];
    const age = used.length ? Math.max(...used.map(v => NOW - v.lastQuoteTs)) : Infinity;
    const snap = S.computeLockSnapshot({ now: NOW, kal, strike: kal.strike, strikeIssue: null, overrides: [], quality: S.assessQuality(NOW, kal), liveIdx, liveIndexAgeMs: age,
      side: null, mutate: true, contracts: 10, basisMu: null, execSec: A['exec-sec'] != null ? +A['exec-sec'] : undefined });
    const s = snap.signal, g = snap.geo || {}; nDec++;
    rows.push({ ts: NOW, tau: +tau.toFixed(2), st: s.state, side: s.side, pf: s.pFlip, pfc: s.pFlipCons, gap: g.gapUsd, cush: g.cushionSigma, sig: g.sigmaRawBps,
      bk: g.regime ? g.regime.bucket : null, mom: g.momentum ? g.momentum.r : null, nl: g.nLock, req: g.requiredMoveUsd, mu: g.basisMeanUsd });
  }
  if (cur && cur.closeTs >= t0 && cur.closeTs < t1) emit(cur, rows);
} finally { Date.now = realNow; }
out.end(); if (trace) trace.end();
console.error(JSON.stringify({ windows: nOut, decisions: nDec, basisSamples: S.BASIS ? S.BASIS.samples.length : null, wallSec: +((realNow() - wall) / 1000).toFixed(1) }));
