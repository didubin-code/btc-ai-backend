/* Lead-time structure on the 58 real windows (warm, validated configuration, 2.8 decisions):
   first LOCKED tau vs official margin |A-K|, volatility, basis; share LOCKED in time for the default 12 s order time (15 s buffer);
   accuracy of the "if BTC holds, LOCKED in ~X s" projection used by 2.8.1's GET READY note.
   usage: node lead_analysis.js <pinradar_server.js> <out.json>                                               */
'use strict';
const L = require('./sim_lib.js');
const S = L.loadServer(process.argv[2]);
const W = L.loadWindows();
const rank = a => { const s = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length); s.forEach(([, i], k) => (r[i] = k)); return r; };
const corr = (x, y) => { const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
const spearman = (x, y) => +corr(rank(x), rank(y)).toFixed(3);
const rows = []; const proj = { said: 0, cameWithin: 0, cameStrict: 0, gainedS: [], never: 0 };
for (const w of W) {
  const r = L.runWindow(S, w, w.C - 1300, { basisMu: w.mu, decide: (S2, snap) => ({ pj: snap.signal.projection }) });
  const fl = r.find(x => L.isLocked(x.state));
  const at300 = r[0];
  if (fl) rows.push({ t: w.ticker, lockTau: fl.tau, margin: Math.abs(w.A - w.K), sigma: at300 ? at300.sigmaRaw : null, sigmaAtLock: fl.sigmaRaw, basis: Math.abs(w.basis || 0), correct: fl.side === L.truth(w) });
  /* projection: first second the projection says LOCKED within <= 20 s while the call is not yet LOCKED */
  const p = r.find(x => !L.isLocked(x.state) && x.pj && x.pj.lockInSec != null && x.pj.lockInSec <= 20);
  if (p) { proj.said++; if (fl && fl.tau <= p.tau && fl.side === p.pj.side && p.tau - fl.tau <= p.pj.lockInSec + 0.5) proj.cameStrict++;
    if (fl && fl.tau <= p.tau && p.tau - fl.tau <= p.pj.lockInSec + 10 && fl.side === p.pj.side) { proj.cameWithin++; proj.gainedS.push(+(p.tau - fl.tau).toFixed(1)); } else if (!fl) proj.never++; }
}
const lt = rows.map(r => r.lockTau).sort((a, b) => a - b), q = p => lt[Math.min(lt.length - 1, Math.floor(p * (lt.length - 1) + 0.5))];
const out = {
  windows: W.length, locked: rows.length, wrong: rows.filter(r => !r.correct).length,
  leadToClose: { mean: +(lt.reduce((a, b) => a + b, 0) / lt.length).toFixed(1), p10: q(0.1), median: q(0.5), p90: q(0.9) },
  inTimeFor12sOrder: rows.filter(r => r.lockTau >= 15).length, tooLateFor12sOrder: rows.filter(r => r.lockTau < 15).length,
  spearman_lockTau_vs: { officialMargin: spearman(rows.map(r => r.lockTau), rows.map(r => r.margin)), sigmaAtT300: spearman(rows.map(r => r.lockTau), rows.map(r => r.sigma)), absBasis: spearman(rows.map(r => r.lockTau), rows.map(r => r.basis)) },
  byMargin: [[0, 20], [20, 50], [50, 100], [100, 1e9]].map(([a, b]) => { const s = rows.filter(r => r.margin >= a && r.margin < b).map(r => r.lockTau).sort((x, y) => x - y); return { margin: `$${a}-${b > 1e8 ? '' : b}`, n: s.length, medianLockTau: s.length ? s[Math.floor(s.length / 2)] : null, lockedAfterT15: s.filter(x => x < 15).length }; }),
  neverLocked: W.length - rows.length,
  projection: { firstSaidWithin20s: proj.said, lockedWithinProjectedTime: proj.cameStrict, lockedWithinProjectedTimePlus10s: proj.cameWithin, neverLocked: proj.never, medianWarningSecondsBeforeLocked: proj.gainedS.length ? proj.gainedS.sort((a, b) => a - b)[Math.floor(proj.gainedS.length / 2)] : null },
  rows
};
require('fs').writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
const { rows: _r, ...summary } = out; console.log(JSON.stringify(summary, null, 1));
