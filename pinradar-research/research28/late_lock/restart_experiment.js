/* Experiment R1: what a process restart does to LOCKED, on 58 real windows, with the real server code.
   warm      : server booted 1,300 s before the close, basis mean = the window's walk-forward value (the validated setup)
   warm-mu0  : same, but the basis model empty (prior mean 0 in 2.8; 2.8.1 uses its cold-basis range), as after any restart without a state file
   boot T-B  : process started B s before the close (empty ring AND empty basis model: a real restart)
   boot T-B vol-only : started B s before the close, basis mean kept (isolates the volatility warm-up)
   usage: node restart_experiment.js <pinradar_server.js> <out.json>                                              */
'use strict';
const L = require('./sim_lib.js');
const S = L.loadServer(process.argv[2]);
const W = L.loadWindows();
const BOOTS = [900, 600, 420, 390, 360, 330, 300, 270, 240, 180, 120, 60];
const out = { server: process.argv[2], windows: W.length, perWindow: [], byConfig: {} };
for (const w of W) {
  const px = L.priceAt(w);
  const rec = { ticker: w.ticker, truth: L.truth(w), mu: w.mu, cfg: {} };
  rec.cfg.warm = L.summarize(w, L.runWindow(S, w, w.C - 1300, { px, basisMu: w.mu }));
  rec.cfg['warm-mu0'] = L.summarize(w, L.runWindow(S, w, w.C - 1300, { px, basisMu: null }));
  for (const B of BOOTS) {
    rec.cfg['boot T-' + B] = L.summarize(w, L.runWindow(S, w, w.C - B, { px, basisMu: null }));
    rec.cfg['boot T-' + B + ' vol-only'] = L.summarize(w, L.runWindow(S, w, w.C - B, { px, basisMu: w.mu }));
  }
  out.perWindow.push(rec);
}
const q = (a, p) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * (b.length - 1) + 0.5))]; };
for (const k of Object.keys(out.perWindow[0].cfg)) {
  const list = out.perWindow.map(r => ({ s: r.cfg[k], warm: r.cfg.warm }));
  const locked = list.filter(x => x.s.firstLockedTau != null), leads = locked.map(x => x.s.firstLockedTau);
  let lostCalls = 0, delayed = 0, delaySum = 0, extra = 0;
  for (const x of list) {
    const wt = x.warm.firstLockedTau, bt = x.s.firstLockedTau;
    if (wt != null && bt == null) lostCalls++;
    if (wt == null && bt != null) extra++;
    if (wt != null && bt != null && bt < wt - 0.5) { delayed++; delaySum += wt - bt; }
  }
  out.byConfig[k] = { locked: locked.length, wrong: locked.filter(x => !x.s.lockedCorrect).length,
    leadMean: leads.length ? +(leads.reduce((a, b) => a + b, 0) / leads.length).toFixed(1) : null, leadP10: q(leads, 0.1), leadMedian: q(leads, 0.5), leadP90: q(leads, 0.9),
    warmCallsLost: lostCalls, warmCallsDelayed: delayed, meanDelayS: delayed ? +(delaySum / delayed).toFixed(1) : null, callsNotInWarm: extra,
    windowsWithheld: list.filter(x => x.s.withheldSeconds > 0).length };
}
require('fs').writeFileSync(process.argv[3], JSON.stringify(out, null, 1));
console.table(out.byConfig);
