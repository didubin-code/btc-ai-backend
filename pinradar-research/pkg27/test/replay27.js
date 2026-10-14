/* 2.7 vs 2.6 on identical historical inputs, every second T-300..T-0, in time order with the live per-window state
   machine (mutate = true), reproducing computeLockSnapshot's 2.7 additions exactly (panel -> gate -> classify ->
   official reversal/display).
   Mode PROXY   : no official feed (the default for a key without the CF Benchmarks entitlement).
                  Requirement: every state, side, probability and trade action identical to 2.6.
   Mode OFFICIAL: schema-conformant cfbenchmarks_value messages are replayed through the real message handler,
                  one per second, delivered 150 ms after the tick. They are SYNTHETIC: value = our 1 Hz index + the
                  window's measured basis (no historical BRTI is available without the entitlement), so this tests the
                  mechanics (parsing, accumulator, counts, panel, gate, warnings, latency), not BRTI accuracy.
   usage: node test/replay27.js <dist26 server> <dist27 server> <replay_in.ndjson> <out.json> [every_k] [extra.ndjson]  */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path');
const S26 = require(path.resolve(process.argv[2]));
const S27 = require(path.resolve(process.argv[3]));
const IN = process.argv[4], OUT = process.argv[5], EVERY = Number(process.argv[6] || 1), EXTRA = process.argv[7];
const lines = fs.readFileSync(IN, 'utf8').split('\n').filter(Boolean).filter((_, k) => k % EVERY === 0);
if (EXTRA && fs.existsSync(EXTRA)) for (const l of fs.readFileSync(EXTRA, 'utf8').split('\n').filter(Boolean)) lines.push(l);
const r6 = x => (x == null || !Number.isFinite(x)) ? null : +x.toPrecision(8);
const res = { contracts: 0, evals: 0, proxy: { mismatches: 0, examples: [] }, official: { evals: 0, gateWithheld: 0, officialReversals: 0, stateDiffs: 0, panelArithErrMax: 0,
  accumulatorErrMax: 0, windowsWithGate: [], windowsWithOfficialRev: [], refCounts: {} }, timing: {} };
const tm = { g26: [], g27: [] };
function evalSecond(S, w, nowMs, at, tk, official) {
  const C = w.C, T = Math.floor(nowMs / 1000), tau = (C * 1000 - nowMs) / 1000;
  const S0 = at(T); if (S0 == null) return null;
  const ring = []; for (let s = T - 960; s <= T; s++) { const v = at(s); if (v != null) ring.push([s * 1000, v]); }
  const t0 = process.hrtime.bigint();
  const geo = S.lockGeometry25({ indexNow: S0, strike: w.K, closeMs: C * 1000, now: nowMs, inputAgeMs: nowMs - T * 1000, ring, basisMu: w.mu });
  const hard = [], soft = [];
  if (!(w.nven[T - w.T_first] >= 1)) hard.push('no fresh index venue');
  if (geo && geo.nLock > 0 && geo.lockedCoverage < 0.9) hard.push(`only ${geo.lockedObserved}/${geo.nLock} locked prints sampled`);
  const dsp = w.disp ? w.disp[T - w.T_first] : null; if (dsp != null && dsp > 8) soft.push(`cross-venue dispersion ${dsp} bps`);
  const gates = { hard, soft, budgetMs: 1000 };
  let panel = null, sig;
  if (S.settlePanel27) {
    panel = S.settlePanel27({ now: nowMs, closeMs: C * 1000, strike: w.K, geo, tau });
    S.brtiGate27(gates, panel, geo);
    sig = S.brtiAfterClassify27(S.classify25({ now: nowMs, tau, ticker: tk, closeMs: C * 1000, strike: w.K, geo, gates, kal: { ok: false }, contracts: 10, mutate: true }), panel, tk);
  } else sig = S.classify25({ now: nowMs, tau, ticker: tk, closeMs: C * 1000, strike: w.K, geo, gates, kal: { ok: false }, contracts: 10, mutate: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { sig, geo, panel, ms, gates };
}
const t0 = Date.now();
for (const line of lines) {
  const w = JSON.parse(line); const C = w.C, T0 = w.T_first;
  const at = T => (T >= T0 && T - T0 < w.idx.length) ? w.idx[T - T0] : null;
  res.contracts++;
  /* ---- PROXY mode: 2.7 must equal 2.6 ---- */
  S27.BRTI.last = null; S27.BRTI.win = null; S27.BRTI.state = 'replay: no official feed';
  for (let tau = 300; tau >= 0; tau--) {
    const nowMs = (C - tau) * 1000 + 250;
    const a = evalSecond(S26, w, nowMs, at, w.ticker + '#26', false), b = evalSecond(S27, w, nowMs, at, w.ticker + '#27p', false);
    if (!a || !b) continue;
    res.evals++; tm.g26.push(a.ms); tm.g27.push(b.ms);
    const fa = [a.sig.state, a.sig.side, r6(a.sig.pWin), r6(a.sig.pFlip), a.sig.trade && a.sig.trade.action].join('|');
    const fb = [b.sig.state, b.sig.side, r6(b.sig.pWin), r6(b.sig.pFlip), b.sig.trade && b.sig.trade.action].join('|');
    if (fa !== fb) { res.proxy.mismatches++; if (res.proxy.examples.length < 10) res.proxy.examples.push({ ticker: w.ticker, tau, a: fa, b: fb }); }
    if (!b.panel || b.panel.reference !== 'PROXY') { res.proxy.mismatches++; if (res.proxy.examples.length < 10) res.proxy.examples.push({ ticker: w.ticker, tau, panel: b.panel && b.panel.reference }); }
  }
  /* ---- OFFICIAL mode: synthetic schema-conformant messages through the real handler ---- */
  const B = Number.isFinite(w.basis) ? w.basis : 0;
  Object.assign(S27.BRTI, { enabled: true, last: null, last5: null, win: null, finals: [], ticks: [], raw: [], lastSeq: null, seqGaps: 0, msgs: 0, state: 'replay', subId: 1 });
  let seq = 1000, sum = 0, cnt = 0, gateHit = false, revHit = false;
  const sendTick = T => {
    const v = at(T); if (v == null) return;
    const val = +(v + B).toFixed(2);
    const inWin = T > C - 60 && T <= C;
    if (inWin) { sum += val; cnt++; }
    const msg = { type: 'cfbenchmarks_value', sid: 3, seq: ++seq, sending_ts_ms: T * 1000 + 140,
      msg: { index_id: 'BRTI', received_at: T * 1000 + 90, data: JSON.stringify({ type: 'value', id: 'BRTI', time: T * 1000, value: String(val) }),
        avg_60s_data: { value: val.toFixed(8), window_size: 60, window_start_ts_ms: T * 1000 - 60000, window_end_ts_exclusive: T * 1000 },
        ...(inWin ? { last_60s_windowed_average_15min: { value: (sum / cnt).toFixed(8), window_size: cnt, window_start_ts_ms: C * 1000 - 60000, window_end_ts_exclusive: C * 1000 + 1 } } : {}) } };
    const raw = JSON.stringify(msg);
    S27.brtiHandle27(JSON.parse(raw), T * 1000 + 150, raw);
  };
  for (let T = C - 305; T <= C - 301; T++) sendTick(T);
  for (let tau = 300; tau >= 0; tau--) {
    const T = C - tau; sendTick(T);
    const nowMs = T * 1000 + 250;
    const a = evalSecond(S26, w, nowMs, at, w.ticker + '#26o', false), b = evalSecond(S27, w, nowMs, at, w.ticker + '#27o', true);
    if (!a || !b) continue;
    res.official.evals++;
    const ref = b.panel ? b.panel.reference : 'NONE'; res.official.refCounts[ref] = (res.official.refCounts[ref] || 0) + 1;
    if (b.gates.soft.some(x => /official BRTI/.test(x))) { if (a.sig.state === 'LOCKED' && b.sig.state !== 'LOCKED') { res.official.gateWithheld++; gateHit = true; } }
    if (b.sig.officialReversal) { res.official.officialReversals++; revHit = true; }
    if (a.sig.state !== b.sig.state) res.official.stateDiffs++;
    if (b.panel && b.panel.reference === 'OFFICIAL' && b.panel.criticalRemainingAvg != null) {
      const n = b.panel.recorded, recAvg = n > 0 ? S27.BRTI.win.value : null, spot = S27.BRTI.last.value;
      const ex = S27.settleMath({ strike: w.K, recordedAvg: recAvg, recordedN: n, remaining: 60 - n, spot });
      if (ex) res.official.panelArithErrMax = Math.max(res.official.panelArithErrMax, Math.abs(ex.criticalRemainingAvg - b.panel.criticalRemainingAvg));
    }
  }
  if (cnt === 60) res.official.accumulatorErrMax = Math.max(res.official.accumulatorErrMax, Math.abs(S27.BRTI.win.value - sum / 60));
  if (gateHit) res.official.windowsWithGate.push({ ticker: w.ticker, yes: w.yes, A_minus_K: +(w.A - w.K).toFixed(2) });
  if (revHit) res.official.windowsWithOfficialRev.push({ ticker: w.ticker, yes: w.yes, A_minus_K: +(w.A - w.K).toFixed(2) });
  if (res.contracts % 100 === 0) console.log('contracts', res.contracts, ((Date.now() - t0) / 1000).toFixed(0) + 's', 'proxy mismatches', res.proxy.mismatches);
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(4); };
res.timing = { engine26_ms: { p50: q(tm.g26, 0.5), p99: q(tm.g26, 0.99), max: q(tm.g26, 1) }, engine27_ms: { p50: q(tm.g27, 0.5), p99: q(tm.g27, 0.99), max: q(tm.g27, 1) } };
res.wall_s = (Date.now() - t0) / 1000;
fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ contracts: res.contracts, evals: res.evals, proxyMismatches: res.proxy.mismatches, official: { ...res.official, windowsWithGate: res.official.windowsWithGate.length, windowsWithOfficialRev: res.official.windowsWithOfficialRev.length }, timing: res.timing }));
