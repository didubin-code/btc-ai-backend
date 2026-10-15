/* Cold-start volatility envelope: calibration (index paths before 2026-09-01) and validation (after).
   A server that started m seconds ago has measured sigma_m (RMS of its m one-second returns, bps). The warm server's
   900 s volatility sigma_900 is unknown but bounded:
     lower: sigma_900^2 = (m sigma_m^2 + (900-m) sigma_pre^2)/900 >= (m/900) sigma_m^2   -> exact bound sqrt(m/900) sigma_m
     upper: no exact bound (the 900-m seconds before the start are unseen) -> empirical:
            sigma_900 <= max(K(m) sigma_m, F(m)),  K = ratio bound when the tape is not near-flat (sigma_m >= 0.2),
                                                   F = absolute bound covering near-flat tapes (sigma_m < 0.2)
   K and F are the calibration-set 99.9th percentiles x 1.15, then made monotone (non-increasing in m).
   No settlement outcome is used: this is a property of the BTC index paths only.
   usage: node calib_coldvol.js <out.json>                                                                          */
'use strict';
const L = require('./sim_lib.js');
const W = L.loadWindows();
const series = [];
{ const m = new Map(); for (const w of W.filter(w => w.src === 'consecutive')) w.idx.forEach((v, i) => m.set(w.T_first + i, v));
  const ts = [...m.keys()].sort((a, b) => a - b); series.push({ end: ts[ts.length - 1], pts: ts.map(t => [t, m.get(t)]) }); }
for (const w of W.filter(w => w.src === 'replay')) series.push({ end: w.C, pts: w.idx.map((v, i) => [w.T_first + i, v]) });
const SPLIT = Date.UTC(2026, 8, 1) / 1000;
const MS = [60, 75, 90, 120, 150, 180, 240, 300, 360, 450, 600, 750, 850];
const rets = pts => { const r = []; for (let i = 1; i < pts.length; i++) r.push((pts[i][1] - pts[i - 1][1]) / pts[i - 1][1] * 1e4); return r; };
const rms = a => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
const obs = { cal: [], val: [] };
for (const s of series) {
  const r = rets(s.pts), set = s.end < SPLIT ? 'cal' : 'val';
  for (let e = 900; e <= r.length; e += 2) {
    const s900 = rms(r.slice(e - 900, e));
    for (const m of MS) obs[set].push({ m, sm: rms(r.slice(e - m, e)), s900 });
  }
}
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round(p * (b.length - 1))))]; };
const K = {}, F = {};
for (const m of MS) {
  const A = obs.cal.filter(o => o.m === m);
  K[m] = 1.15 * q(A.filter(o => o.sm >= 0.2).map(o => o.s900 / o.sm), 0.999);
  F[m] = 1.15 * q(A.filter(o => o.sm < 0.2).map(o => o.s900), 0.999);
}
/* monotone: more history can only narrow the band */
for (let i = 1; i < MS.length; i++) { K[MS[i]] = Math.min(K[MS[i]], K[MS[i - 1]]); F[MS[i]] = Math.min(F[MS[i]], F[MS[i - 1]]); }
const table = MS.map(m => [m, +K[m].toFixed(3), +F[m].toFixed(3)]);
const bandAt = (m, sm) => { let j = 0; while (j + 1 < MS.length && MS[j + 1] <= m) j++; return { lo: Math.sqrt(m / 900) * sm, hi: Math.max(K[MS[j]] * sm, F[MS[j]]) }; };
const cover = set => {
  const out = {};
  for (const m of MS) {
    const A = obs[set].filter(o => o.m === m); let below = 0, above = 0;
    for (const o of A) { const b = bandAt(m, o.sm); if (o.s900 < b.lo - 1e-12) below++; if (o.s900 > b.hi + 1e-12) above++; }
    out[m] = { n: A.length, below, above, coveragePct: +(100 * (1 - (below + above) / A.length)).toFixed(3) };
  }
  return out;
};
const res = { note: 'band for the 900 s volatility after a restart: [sqrt(m/900) sigma_m, max(K(m) sigma_m, F(m))] (bps per second)',
  series: series.length, calSeries: series.filter(s => s.end < SPLIT).length, valSeries: series.filter(s => s.end >= SPLIT).length,
  table_m_K_F: table, coverage: { calibration: cover('cal'), validation: cover('val') } };
require('fs').writeFileSync(process.argv[2], JSON.stringify(res, null, 1));
console.log(JSON.stringify(table));
for (const m of MS) console.log(m, JSON.stringify(res.coverage.calibration[m]), JSON.stringify(res.coverage.validation[m]));
