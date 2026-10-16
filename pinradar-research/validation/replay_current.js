/* Phase 1 / 4: chronological replay of a Pin Radar engine build (the REAL server file) over real 1 Hz windows.
   Each window is replayed second by second from 1,300 s before the close (900 s of history before the LOCKED horizon): the index ring
   receives only samples up to the current second, decisions see only data up to that second, and the outcome (official average A,
   result `yes`) is read only after the replay, for scoring. The basis mean is the walk-forward value stored with each window
   (`mu`, computed from earlier windows only). Kalshi books are NOT historical here: no execution claim is made from this replay.
   usage: node replay_current.js <pinradar_server.js> <windows.ndjson[,more.ndjson]> <out.json> [decisionQuoteAgeMs|default]           */
'use strict';
const fs = require('fs'), path = require('path');
const L = require(path.join(__dirname, '..', 'research28', 'late_lock', 'sim_lib.js'));
const S = require('./stats_lib.js');
const SRV = path.resolve(process.argv[2]), FILES = process.argv[3].split(','), OUT = process.argv[4];
const QA = process.argv[5] && process.argv[5] !== 'default' ? Number(process.argv[5]) : null;
const E = L.loadServer(SRV);
const W = []; for (const f of FILES) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) W.push(JSON.parse(l));
W.sort((a, b) => a.C - b.C);
const FIX = [60, 45, 30, 20, 15, 10, 5, 3];
const isL = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
const rows = [];
for (const w of W) {
  if (!(w.T_first <= w.C - 1300)) { rows.push({ ticker: w.ticker, skipped: 'less than 1,300 s of index history' }); continue; }
  const entries = (w.entries || []).map(e => ({ ...e, tau: +(w.C - e.ts).toFixed(2) }));
  const fromTau = Math.max(300, ...entries.map(e => Math.ceil(e.tau) + 1));
  const recs = L.runWindow(E, w, w.C - 1300, { fromTau, basisMu: w.mu, decisionQuoteAgeMs: QA,
    decide: (S2, snap) => { const g = snap.geo || {}, s = snap.signal;
      return { mom: g.momentum ? g.momentum.r : null, exec: s.exec ? s.exec.headline : null, reason: s.exec ? s.exec.reason : null, status: s.status }; } });
  const truth = w.yes ? 'UP' : 'DOWN';
  const fl = recs.find(r => isL(r.state));
  const after = fl ? recs.filter(r => r.tau < fl.tau) : [];
  const rev = fl ? after.find(r => r.state === 'REVERSAL WARNING' || (isL(r.state) && r.side !== fl.side)) : null;
  const at = t => { let best = null; for (const r of recs) if (r.tau <= t + 1e-9 && r.tau > t - 1) { best = r; break; } return best; };
  const fixed = Object.fromEntries(FIX.map(t => { const r = at(t); return [t, r ? { state: r.state, side: r.side, pFlip: r.pFlip, locked: isL(r.state), correct: isL(r.state) ? r.side === truth : null } : null]; }));
  const ent = entries.map(e => { const r = recs.filter(x => x.tau >= e.tau - 1e-9).pop() || null;   // the last decision at or before the entry time
    const side = e.side === 'YES' ? 'UP' : 'DOWN', won = side === truth;
    return { trade: e.trade, tau: e.tau, side, px: e.px, won, pnlCentsPerContract: +((won ? 100 - 100 * e.px : -100 * e.px)).toFixed(2),
      engineAtEntry: r ? { tau: r.tau, state: r.state, side: r.side, pWin: r.pWin, exec: r.exec, reason: r.reason } : null }; });
  rows.push({ ticker: w.ticker, closeUtc: new Date(w.C * 1000).toISOString(), strike: w.K, official: w.A, marginUsd: +(w.A - w.K).toFixed(2), truth, basisMu: w.mu,
    firstLocked: fl ? { tau: fl.tau, side: fl.side, correct: fl.side === truth, pFlip: fl.pFlip, gapUsd: fl.gap, cushionSigma: fl.cushion, sigmaRawBps: fl.sigmaRaw,
      regimeBucket: fl.bucket, momentum: fl.mom, requiredMoveUsd: fl.reqMove } : null,
    reversalAfterLocked: rev ? { tau: rev.tau, state: rev.state, side: rev.side, pFlip: rev.pFlip } : null,
    lockedSeconds: recs.filter(r => isL(r.state)).length, wrongLockedSeconds: recs.filter(r => isL(r.state) && r.side !== truth).length,
    tradeNowSeconds: recs.filter(r => r.exec === 'TRADE NOW').length, fixed, entries: ent });
}
const ok = rows.filter(r => !r.skipped), fls = ok.filter(r => r.firstLocked);
const sum = { engine: path.basename(path.dirname(path.dirname(SRV))) + '/' + path.basename(SRV), files: FILES.map(f => path.basename(f)), decisionQuoteAgeMs: QA == null ? 'harness default (~0.7 s)' : QA,
  windows: ok.length, skipped: rows.length - ok.length,
  firstLocked: { n: fls.length, wrong: fls.filter(r => !r.firstLocked.correct).length, up: fls.filter(r => r.firstLocked.side === 'UP').length, down: fls.filter(r => r.firstLocked.side === 'DOWN').length,
    wrongUp: fls.filter(r => r.firstLocked.side === 'UP' && !r.firstLocked.correct).length, wrongDown: fls.filter(r => r.firstLocked.side === 'DOWN' && !r.firstLocked.correct).length,
    reversalWarnings: fls.filter(r => r.reversalAfterLocked).length, wrongTickers: fls.filter(r => !r.firstLocked.correct).map(r => r.ticker) },
  neverLocked: ok.length - fls.length,
  fixedTimes: Object.fromEntries(FIX.map(t => { const c = ok.map(r => r.fixed[t]).filter(x => x && x.locked); return [t, { locked: c.length, wrong: c.filter(x => !x.correct).length }]; })),
  userEntries: (() => { const es = ok.flatMap(r => r.entries); return { n: es.length, won: es.filter(e => e.won).length, engineLockedSameSideAtEntry: es.filter(e => e.engineAtEntry && isL(e.engineAtEntry.state) && e.engineAtEntry.side === e.side).length,
    engineTradeNowAtEntry: es.filter(e => e.engineAtEntry && e.engineAtEntry.exec === 'TRADE NOW').length, lostTradesEngineLockedSameSide: es.filter(e => !e.won && e.engineAtEntry && isL(e.engineAtEntry.state) && e.engineAtEntry.side === e.side).length,
    entryTauMedian: es.length ? es.map(e => e.tau).sort((a, b) => a - b)[Math.floor(es.length / 2)] : null, sumPnlCentsPerContract: +es.reduce((a, e) => a + e.pnlCentsPerContract, 0).toFixed(2) }; })(),
  note: 'These 58 windows were selected for earlier tests (42 around sampled historical trade entries, 16 consecutive) and over-represent reversals: counts are NOT failure rates.' };
sum.firstLocked.ci95 = fls.length ? S.cp(sum.firstLocked.wrong, fls.length) : null;
fs.writeFileSync(OUT, JSON.stringify({ summary: sum, windows: rows }, null, 1));
console.log(JSON.stringify(sum, null, 1));
