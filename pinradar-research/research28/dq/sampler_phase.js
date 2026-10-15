/* DATA UNRELIABLE from sampler timing: drive the REAL server with the 1 Hz index sampler firing at a chosen phase within each second
   (plus small jitter), as Node's drifting setInterval does over time, and count hard gates in the final 60 s of real windows.
   usage: node sampler_phase.js <pinradar_server.js> [jitterMs=15] [windows=20]                                             */
'use strict';
const path = require('path');
const L = require(path.join(__dirname, '..', 'late_lock', 'sim_lib.js'));
const S = L.loadServer(process.argv[2]);
const JIT = Number(process.argv[3] || 15), NW = Number(process.argv[4] || 20);
const W = L.loadWindows().slice(0, NW);
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const out = {};
for (const phase of (process.env.PHASES ? process.env.PHASES.split(",").map(Number) : [100, 300, 450, 480, 500, 520, 550, 700, 900])) {
  let dec = 0, hardCov = 0, other = 0; const reasons = {};
  for (const w of W) {
    const px = L.priceAt(w);
    const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
    try {
      S.IDX.ring.length = 0; S.IDX.value = NaN; S.IDX.ts = 0;
      Object.assign(S.LOCK25, { ticker: null, hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
      S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; S.KAL.ob = null; S.RESTF.active = false;
      S.KAL.market = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
      for (let T = w.C - 1300; T < w.C; T++) {
        const x = px.get(T); if (x == null) continue;
        NOW = T * 1000 + phase + Math.round((rnd() - 0.5) * 2 * JIT);              // the sampler tick
        for (const v of Object.values(S.VENUES)) Object.assign(v, { mid: x + (v.name === 'coinbase' ? 0.4 : v.name === 'kraken' ? -0.4 : 0), bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 50, lastMsgTs: NOW });
        S.sampleIndex();
        const tau = w.C - T;
        if (tau > 60) continue;
        NOW = T * 1000 + 950; S.KAL.ts = NOW - 100;                             // a decision late in the second
        const kal = S.getKalshiContext(), liveIdx = S.computeIndex(NOW), q = S.assessQuality(NOW, kal);
        const snap = S.computeLockSnapshot({ now: NOW, kal, strike: kal.strike, strikeIssue: null, overrides: [], quality: q, liveIdx, liveIndexAgeMs: 100, side: null, mutate: true, basisMu: w.mu });
        dec++;
        const h = (snap.signal.gates || snap.gates).hard;
        if (h.some(t => /locked prints sampled/.test(t))) hardCov++; else if (h.length) other++;
        for (const t of h) { const k = t.replace(/[0-9.]+/g, '#'); reasons[k] = (reasons[k] || 0) + 1; }
      }
    } finally { Date.now = realNow; }
  }
  out[`phase ${phase} ms`] = { decisionsInFinal60s: dec, dataUnreliableFromCoverage: hardCov, pct: +(100 * hardCov / dec).toFixed(2), otherHard: other, reasons };
}
console.log(JSON.stringify({ jitterMs: JIT, windows: W.length, server: process.argv[2] }, null, 0));
for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify(v));
