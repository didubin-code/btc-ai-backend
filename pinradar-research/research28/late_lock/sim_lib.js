/* Shared driver for the late-LOCKED investigation (research only; nothing here is deployed).

   Drives a REAL Pin Radar server build (the unmodified dist file) on a fake clock with REAL 1 Hz index paths
   from pkg27/test/data (58 KXBTC15M windows, Jul 21 - Oct 13 2026, official settlement values and strikes).
   The live code path is used exactly as in production: sampleIndex() every second (the same 1 Hz ring the
   volatility estimator reads), then computeLockSnapshot() with the Kalshi context, live index and data-quality
   grade computed by the server's own functions.

   A "boot" at time B is modelled exactly as a process start: the index ring is empty and every per-window state
   (LOCK25 history, locked side) is reset; samples before B never reach the ring.

   The Kalshi order book is NOT historical (none is stored for these windows); runs that need one pass a book
   function and say so. Timing of LOCKED and the model's probabilities do not depend on the book.          */
'use strict';
const fs = require('fs'), path = require('path');
const DATA = path.join(__dirname, '..', '..', 'pkg27', 'test', 'data');

function loadWindows() {
  const W = [];
  for (const f of ['replay_sample.ndjson', 'consecutive_sample.ndjson']) {
    for (const l of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').filter(Boolean)) {
      const w = JSON.parse(l); w.src = f.split('_')[0]; W.push(w);
    }
  }
  W.sort((a, b) => a.C - b.C);
  return W;
}
/* one shared price map per window (the consecutive sample's windows overlap in time) */
function priceAt(w) { const m = new Map(); w.idx.forEach((v, i) => { if (v != null) m.set(w.T_first + i, v); }); return m; }

function loadServer(file) {
  process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
  const p = path.resolve(file); delete require.cache[p];
  return require(p);
}

/* Run one window from bootT (unix s) to the close. opts:
     fromTau   record decisions only when tau <= fromTau (default 300, the LOCKED horizon)
     book(T, tau, x, w)  -> { yes:[[px,size]...], no:[[px,size]...], ageMs } | null   (Kalshi book, optional)
     contracts default 10
     decide(S, snap, ctx) optional extra hook (the proposed execution layer)                               */
function runWindow(S, w, bootT, opts = {}) {
  const fromTau = opts.fromTau == null ? 300 : opts.fromTau;
  const px = opts.px || priceAt(w);
  const realNow = Date.now; let NOW = bootT * 1000; Date.now = () => NOW;
  try {
    /* process start: empty ring, fresh per-window state, no clock-skew estimate yet */
    S.IDX.ring.length = 0; S.IDX.value = NaN; S.IDX.ts = 0; S.IDX.publishFails = 0;
    Object.assign(S.LOCK25, { ticker: null, hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
    S.SKEW.samples.length = 0; S.SKEW.estMs = 0; S.KAL.ob = null; S.KAL.obTs = 0; S.RESTF.active = false;
    if (S.BASIS) { S.BASIS.samples.length = 0; S.BASIS.byKey.clear(); }   // a restarted process has no live basis samples
    S.KAL.market = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
    const rows = [];
    for (let T = bootT; T < w.C; T++) {
      const x = px.get(T); if (x == null) continue;
      NOW = T * 1000 + 100;
      const vs = S.VENUES;
      Object.assign(vs.coinbase, { mid: x + 0.4, bidDepth: 3, askDepth: 3, lastQuoteTs: NOW - 40, lastMsgTs: NOW });
      Object.assign(vs.kraken, { mid: x - 0.4, bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 60, lastMsgTs: NOW });
      Object.assign(vs.bitstamp, { mid: x, bidDepth: 1, askDepth: 1, lastQuoteTs: NOW - 80, lastMsgTs: NOW });
      if (opts.before) opts.before(S, T, w.C - T, NOW);                          // scenario hook (stale feeds etc.)
      S.sampleIndex();
      /* the clock-skew estimate needs 5 Kalshi responses after a start (about 5 s at 1 Hz polling) */
      if (T - bootT === 5) { for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; }
      const tau = w.C - T - 0.25;
      if (tau > fromTau) continue;
      NOW = T * 1000 + 750;
      S.KAL.ts = NOW - 120;
      if (opts.book) {
        const b = opts.book(T, tau, x, w);
        if (b) { S.KAL.ob = { ticker: w.ticker, yes: b.yes, no: b.no }; S.KAL.obTs = NOW - (b.ageMs == null ? 150 : b.ageMs); }
        else { S.KAL.ob = null; S.KAL.obTs = 0; }
      }
      const kal = S.getKalshiContext();
      const liveIdx = S.computeIndex(NOW);
      const used = liveIdx ? Object.values(S.VENUES).filter(v => liveIdx.used.includes(v.name)) : [];
      const age = used.length ? Math.max(...used.map(v => NOW - v.lastQuoteTs)) : Infinity;
      const quality = S.assessQuality(NOW, kal);
      const snap = S.computeLockSnapshot({ now: NOW, kal, strike: kal.strike, strikeIssue: null, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true, contracts: opts.contracts || 10, basisMu: opts.basisMu == null ? null : opts.basisMu, execSec: opts.execSec, basisLiveN: opts.basisLiveN });
      const s = snap.signal, g = snap.geo || {};
      const row = { T, tau: Math.round((w.C * 1000 - NOW) / 10) / 100, x, state: s.state, side: s.side, pWin: s.pWin, pFlip: s.pFlip, pFlipCons: s.pFlipCons,
        action: s.trade ? s.trade.action : null, ask: s.trade ? s.trade.askCents : null, ev: s.trade ? s.trade.evConsCents : null,
        soft: (s.gates || snap.gates).soft.slice(), hard: (s.gates || snap.gates).hard.slice(), sigmaWarm: g.sigmaWarm, sigmaRaw: g.sigmaRawBps, sigma: g.sigmaBps,
        bucket: g.regime ? g.regime.bucket : null, gap: g.gapUsd, cushion: g.cushionSigma, nLock: g.nLock, lockedMean: g.lockedMean,
        expSettle: g.expectedSettle, reqMove: g.requiredMoveUsd, ring: S.IDX.ring.length };
      if (opts.decide) Object.assign(row, opts.decide(S, snap, { T, tau, x, w, NOW }) || {});
      rows.push(row);
    }
    return rows;
  } finally { Date.now = realNow; }
}
const isLocked = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
const truth = w => (w.yes ? 'UP' : 'DOWN');
function summarize(w, rows) {
  const first = f => { const r = rows.find(f); return r ? r : null; };
  const fl = first(r => isLocked(r.state)), fh = first(r => r.state === 'HIGH CONFIDENCE' || isLocked(r.state));
  const raw = first(r => r.pFlip != null && r.pFlip <= 0.005 && !r.hard.length);           // model alone would have supported LOCKED
  const withheld = rows.filter(r => r.state === 'HIGH CONFIDENCE' && r.pFlip <= 0.005).length;
  return { ticker: w.ticker, truth: truth(w), firstLockedTau: fl ? fl.tau : null, firstLockedSide: fl ? fl.side : null,
    lockedCorrect: fl ? fl.side === truth(w) : null, firstHighTau: fh ? fh.tau : null, firstRawLockTau: raw ? raw.tau : null,
    rawSide: raw ? raw.side : null, withheldSeconds: withheld };
}
module.exports = { loadWindows, priceAt, loadServer, runWindow, summarize, isLocked, truth };
