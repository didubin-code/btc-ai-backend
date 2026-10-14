/* Stress test of the REAL engine code: windows the engine had LOCKED at second T-s (real historical 1 Hz paths), then
   an adverse jump of $X (against the locked side) right after T-s, held to the close. Runs lockGeometry25 + classify25
   (mutate = true: the live per-window state machine) every second from T-(s+5) to the close.
   usage: node test/stress_engine.js <server.js> <cases.ndjson> <out.json> [settle27.js-capable server: 'official']
   Output per case x X: state/flip just before the shock, state/flip 1, 2, 3 s after, first REVERSAL WARNING second,
   whether the jump flips the actual settlement (exact arithmetic: shifted ticks x X / 60 vs the official margin). */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path');
const S = require(path.resolve(process.argv[2]));
const cases = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const OUT = process.argv[4];
const XS = [5, 10, 25, 50, 65, 100];
const r6 = x => (x == null || !Number.isFinite(x)) ? null : +x.toPrecision(6);
const res = [];
const t0 = Date.now(); let evals = 0, evalMs = 0;
for (const w of cases) {
  for (const X of [0, ...XS]) {
    const C = w.C, T0 = w.T_first, s = w.shock_tau, sign = w.leader;
    const at = T => { const v = (T >= T0 && T - T0 < w.idx.length) ? w.idx[T - T0] : null; return v == null ? null : (T > C - s ? v - sign * X : v); };
    const tk = w.ticker + '#' + X;                                  // fresh per-window state for each scenario
    const states = {};
    for (let tau = s + 5; tau >= Math.max(0, s - 12); tau--) {
      const T = C - tau, nowMs = T * 1000, S0 = at(T);
      const ring = []; for (let q = T - 960; q <= T; q++) { const v = at(q); if (v != null) ring.push([q * 1000, v]); }
      const e0 = process.hrtime.bigint();
      const geo = S.lockGeometry25({ indexNow: S0, strike: w.K, closeMs: C * 1000, now: nowMs, inputAgeMs: 0, ring, basisMu: w.mu });
      const sig = S.classify25({ now: nowMs, tau, ticker: tk, closeMs: C * 1000, strike: w.K, geo, gates: { hard: [], soft: [], budgetMs: 1000 }, kal: { ok: false }, contracts: 10, mutate: true });
      evalMs += Number(process.hrtime.bigint() - e0) / 1e6; evals++;
      states[tau] = { state: sig.state, side: sig.side, flip: r6(sig.pFlip), status: sig.status, req: geo ? r6(geo.requiredMoveUsd) : null };
    }
    const pre = states[s];
    const lockedSide = sign > 0 ? 'UP' : 'DOWN';
    const shifted = Math.min(s, 60);                                 // window ticks after the shock (incl alignment: C-59..C)
    const margin = (w.A - w.K) * sign;                               // official margin in the locked side's favour
    const flips = margin - X * shifted / 60 < -0.005 + 1e-9 ? true : (margin - X * shifted / 60 < 0 ? 'tie-zone' : false);
    let firstRev = null; for (let tau = s - 1; tau >= Math.max(0, s - 12); tau--) if (states[tau].state === 'REVERSAL WARNING') { firstRev = tau; break; }
    let firstNotLocked = null; for (let tau = s - 1; tau >= Math.max(0, s - 12); tau--) if (!['LOCKED', 'PROVEN LOCKED'].includes(states[tau].state)) { firstNotLocked = tau; break; }
    res.push({ ticker: w.ticker, set: w.set, shock_tau: s, X, locked_side: lockedSide, pre_state: pre.state, pre_side: pre.side, pre_flip: pre.flip,
      after1: states[s - 1] || null, after2: states[s - 2] || null, after3: states[s - 3] || null,
      first_reversal_warning_tau: firstRev, first_not_locked_tau: firstNotLocked, settlement_flips: flips, official_margin: r6(w.A - w.K) });
  }
}
fs.writeFileSync(OUT, JSON.stringify({ server: process.argv[2], cases: cases.length, evals, mean_eval_ms: +(evalMs / evals).toFixed(4), wall_s: (Date.now() - t0) / 1000, rows: res }));
console.log('stress rows', res.length, 'evals', evals, 'mean engine ms/eval', (evalMs / evals).toFixed(4));
