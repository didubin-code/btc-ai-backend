/* Reconstruct the losing / dangerous LOCKED calls whose real 1 Hz paths are available here (Sep 2 23:15 ET: the warm validated engine
   LOCKED DOWN and lost; Oct 12 20:45 ET: LOCKED UP wrongly whenever the basis model is cold), with the variables at the call and the move
   that reversed it, and which safeguards would have stopped it.   usage: node reconstruct.js <2.8 server> <2.8.1 server> <out.json> */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'late_lock', 'sim_lib.js'));
const S28 = L.loadServer(process.argv[2]), S1 = L.loadServer(process.argv[3]);
const W = L.loadWindows();
const out = [];
const cap = (S, snap, c) => { const g = snap.geo || {}; return { gap: g.gapUsd, cushion: g.cushionSigma, reqMove: g.requiredMoveUsd, sigmaRaw: g.sigmaRawBps, bucket: g.regime ? g.regime.bucket : null,
  mom: g.momentum ? g.momentum.r : null, nLock: g.nLock, lockedMean: g.lockedMean, expSettle: g.expectedSettle, pFlipCons: snap.signal.pFlipCons, recal: g.recal ? g.recal.group : null }; };
for (const [tk, cfg] of [['KXBTC15M-26SEP022315-15', { basisMu: 'w' }], ['KXBTC15M-26OCT122045-45', { basisMu: 0 }]]) {
  const w = W.find(x => x.ticker === tk); const mu = cfg.basisMu === 'w' ? w.mu : cfg.basisMu;
  const r28 = L.runWindow(S28, w, w.C - 1300, { basisMu: mu, decide: cap });
  const r1 = L.runWindow(S1, w, w.C - 1300, { basisMu: mu, decide: cap });
  const r1cold = L.runWindow(S1, w, w.C - 1300, { basisMu: null, decide: cap });
  const fl = r28.find(r => L.isLocked(r.state));
  if (!fl) { out.push({ ticker: tk, note: 'no LOCKED call with this configuration' }); continue; }
  /* the move that reversed it: index after the call vs the index at the call, against the called side */
  const px = L.priceAt(w), sgn = fl.side === 'UP' ? 1 : -1;
  let worst = 0, worstTau = null; for (let T = w.C - Math.floor(fl.tau); T <= w.C; T++) { const v = px.get(T); if (v == null) continue; const adv = sgn * (fl.x - v); if (adv > worst) { worst = adv; worstTau = w.C - T; } }
  const atT = t => r28.find(r => r.tau <= t + 0.5) || null;
  out.push({ ticker: tk, basisMuUsed: mu, truth: L.truth(w), officialMinusStrike: +(w.A - w.K).toFixed(2), realisedBasis: w.basis == null ? null : +w.basis.toFixed(2),
    call: { side: fl.side, tau: fl.tau, pFlip: fl.pFlip, pFlipCons: fl.pFlipCons, index: fl.x, gapUsd: fl.gap, cushionSigma: fl.cushion, requiredMoveUsd: fl.reqMove, sigmaRawBps: fl.sigmaRaw, regime: fl.recal, momentum30s: fl.mom, recordedPrints: fl.nLock },
    reversal: { maxAdverseIndexMoveUsd: +worst.toFixed(2), atTau: worstTau, requiredAtCall: fl.reqMove, ratio: fl.reqMove ? +(worst / fl.reqMove).toFixed(2) : null },
    pathAfterCall: [60, 45, 30, 20, 10, 5].map(t => { const r = atT(t); return r ? { tau: t, state: r.state, side: r.side, pFlip: r.pFlip, index: r.x } : null; }),
    safeguards: {
      'threshold 0.2 %': fl.pFlip > 0.002 ? 'would NOT have LOCKED at the call (flip ' + (100 * fl.pFlip).toFixed(3) + ' %)' : 'would still LOCK',
      '15 s execution buffer': fl.tau >= 15 ? 'no effect (call at T-' + fl.tau + ')' : 'blocks a trade',
      '2.8.1 same inputs (basis as here)': (b => b ? `LOCKED ${b.side} at T-${b.tau}` : 'never LOCKED')(r1.find(r => L.isLocked(r.state))),
      '2.8.1 after a restart (basis model cold)': (b => b ? `LOCKED ${b.side} at T-${b.tau}` : 'never LOCKED')(r1cold.find(r => L.isLocked(r.state))) } });
}
require('fs').writeFileSync(process.argv[4], JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
