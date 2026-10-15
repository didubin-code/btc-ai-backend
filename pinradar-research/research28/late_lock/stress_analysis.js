/* Execution stress test, measured (review finding: the earlier figures had no committed source).
   Warm server, basis known, 58 real windows: stressed CAUTIOUS flip risk (the standard TRADE NOW's edge uses) at the first LOCKED second
   for order times 3/12/30 s, and how many TRADE NOW seconds the stress test refuses with the default 12 s order time and a synthetic book
   (leader ask 95-99.9c, 300 contracts).
   usage: node stress_analysis.js <pinradar_server.js 2.8.1> <out.json>                                                         */
'use strict';
const L = require('./sim_lib.js');
const S = L.loadServer(process.argv[2]);
const W = L.loadWindows();
const q = (a, p) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))]; };
const out = { firstLocked: {}, tradeNow: {} };
for (const ex of [3, 12, 30]) {
  const f = [];
  for (const w of W) {
    let done = false;
    L.runWindow(S, w, w.C - 1300, { basisMu: w.mu, decide: (S2, snap, c) => {
      if (done || !L.isLocked(snap.signal.state) || c.tau < 3 + ex) return {};
      done = true; const p = S2.stressPUp281(snap.geo, c.tau, ex); if (p != null) f.push(snap.signal.side === 'UP' ? 1 - p : p); return {};
    } });
  }
  out.firstLocked[`order ${ex} s`] = { n: f.length, stressedFlipPct: { p10: +(100 * q(f, 0.1)).toFixed(3), median: +(100 * q(f, 0.5)).toFixed(3), p90: +(100 * q(f, 0.9)).toFixed(3) },
    shareUnder05pct: +(f.filter(x => x <= 0.005).length / f.length).toFixed(3) };
}
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const book = (T, tau, x, w) => { seed = (T * 7919 + 13) % 2147483647 || 1; const lead = x >= w.K ? 'UP' : 'DOWN', a = [99.9, 99.8, 99.5, 99, 98.5, 98, 97, 95][Math.floor(rnd() * 8)];
  const tb = asks => asks.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]); const la = [[a, 300]], lg = [[Math.max(0.5, Math.round((101 - a) * 10) / 10), 300]];
  return { yes: tb(lead === 'UP' ? lg : la), no: tb(lead === 'UP' ? la : lg), ageMs: 150 }; };
let tn = 0, refused = 0;
for (const w of W) for (const r of L.runWindow(S, w, w.C - 1300, { basisMu: w.mu, book, execSec: 12, decide: (S2, snap) => ({ why: snap.signal.trade ? snap.signal.trade.why : '' }) })) {
  if (r.action === 'TRADE NOW') tn++;
  if (r.action === 'LOCKED — DO NOT TRADE' && /survive/.test(r.why || '')) refused++;
}
out.tradeNow = { orderTimeSec: 12, z: S.EXEC_STRESS_Z, tradeNowSeconds: tn, refusedByStress: refused, book: 'synthetic leader ask 95-99.9c, 300 contracts' };
require('fs').writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
