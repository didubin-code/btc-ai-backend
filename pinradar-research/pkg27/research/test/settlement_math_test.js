/* Deterministic tests: does each engine compute the evolving 60-tick settlement average and the move the remaining ticks
   need to flip the result?  Runs the REAL code of 2.3 (production) and 2.6 against the exact arithmetic.
   usage: node test/settlement_math_test.js */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/settle27.js'), 'utf8') + '\nthis.settleMath=settleMath;this.settleRound2=settleRound2;', ctx);
const { settleMath, settleRound2 } = ctx;
const S26 = require(path.join(ROOT, 'dist26/pinradar_server.js'));
const res = []; const ok = (name, pass, got) => { res.push({ name, pass: !!pass, got }); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

/* 1. exact arithmetic: the user's example (42 ticks in, 18 to go) */
const K = 80000;
const a = settleMath({ strike: K, recordedAvg: K + 5, recordedN: 42, remaining: 18, spot: K + 5 });
ok('42 in at +$5 -> remaining 18 must average $11.67 below the strike', near(a.criticalVsStrike, -11.6667 - 0.005 * 60 / 18, 1e-3), a.criticalVsStrike.toFixed(4));
const b = settleMath({ strike: K, recordedAvg: K + 0.5, recordedN: 42, remaining: 18, spot: K + 0.5 });
ok('42 in at +$0.50 -> remaining 18 must average $1.17 below the strike', near(b.criticalVsStrike, -1.1667 - 0.005 * 60 / 18, 1e-3), b.criticalVsStrike.toFixed(4));
const c = settleMath({ strike: K, recordedAvg: K + 5, recordedN: 42, remaining: 18, spot: K - 3 });
ok('critical average depends on the recorded ticks, not on where spot is now', near(c.criticalRemainingAvg, a.criticalRemainingAvg, 1e-9) && near(c.requiredMove, (K - 3) - c.criticalRemainingAvg, 1e-9),
  `critical ${c.criticalRemainingAvg.toFixed(3)}, move from spot ${c.requiredMove.toFixed(3)}`);
const tie = settleMath({ strike: 100, recordedAvg: 99.995, recordedN: 60, remaining: 0, spot: 99.995 });
const below = settleMath({ strike: 100, recordedAvg: 99.9949, recordedN: 60, remaining: 0, spot: 99.9949 });
ok('rounding/tie: 99.995 rounds to 100.00 and wins (>=); 99.9949 rounds to 99.99 and loses', tie.result === 'UP' && below.result === 'DOWN', `${tie.final} ${tie.result} / ${below.final} ${below.result}`);
ok('a $Δ jump in 6 s must be 18/12 times the move needed now', near(a.jumpNeeded(6), a.requiredMove * 18 / 12, 1e-9), a.jumpNeeded(6).toFixed(2));

/* 2. the 2.6 engine (lockGeometry25) on rings that encode those situations */
function ring26(nowMs, closeMs, recordedLevel, spotLevel) {
  const ring = [];
  for (let s = Math.floor(nowMs / 1000) - 960; s <= Math.floor(nowMs / 1000); s++) {
    const tMs = s * 1000;
    const inWindow = tMs > closeMs - 60000 && tMs <= nowMs;
    ring.push([tMs, inWindow ? recordedLevel : recordedLevel]);
  }
  ring[ring.length - 1][1] = spotLevel;            // the latest sample is the spot (the print at 'now')
  return ring;
}
const closeMs = 1_800_000_000_000, nowMs = closeMs - 18000;
for (const [label, rec, spot, want] of [['+$5 recorded, spot +$5', K + 5, K + 5, a], ['+$0.50 recorded, spot +$0.50', K + 0.5, K + 0.5, b], ['+$5 recorded, spot -$3', K + 5, K - 3, null]]) {
  const ring = ring26(nowMs, closeMs, rec, spot);
  const g = S26.lockGeometry25({ indexNow: spot, strike: K, closeMs, now: nowMs, inputAgeMs: 0, ring, sigma: { value: 0.3, warm: true, parts: [] }, basisMu: 0 });
  // engine: 42 locked prints (the print at 'now' counts as locked), 18 to come
  const ref = settleMath({ strike: K, recordedAvg: (41 * rec + spot) / 42, recordedN: 42, remaining: 18, spot });
  ok(`2.6 ${label}: 42 prints recorded, 18 to come`, g.nLock === 42 && g.nRemaining === 18, `${g.nLock}/${g.nRemaining}`);
  ok(`2.6 ${label}: expected settlement and move-needed equal the exact arithmetic`, near(g.expectedSettle, ref.expectedSettle, 0.006) && near(g.requiredMoveUsd, Math.abs(ref.expectedSettle - K) * 60 / 18, 0.02),
    `engine settle ${g.expectedSettle} need ${g.requiredMoveUsd} | exact settle ${ref.expectedSettle.toFixed(2)} critical ${ref.criticalVsStrike.toFixed(2)}`);
  if (want) ok(`2.6 ${label}: flip risk`, true, (100 * Math.min(g.pUp, 1 - g.pUp)).toFixed(4) + '%');
}
const gA = S26.lockGeometry25({ indexNow: K + 5, strike: K, closeMs, now: nowMs, inputAgeMs: 0, ring: ring26(nowMs, closeMs, K + 5, K + 5), sigma: { value: 0.3, warm: true, parts: [] }, basisMu: 0 });
const gB = S26.lockGeometry25({ indexNow: K + 0.5, strike: K, closeMs, now: nowMs, inputAgeMs: 0, ring: ring26(nowMs, closeMs, K + 0.5, K + 0.5), sigma: { value: 0.3, warm: true, parts: [] }, basisMu: 0 });
ok('2.6 distinguishes the two cases (flip risk +$0.50 case > 3x the +$5 case)', Math.min(gB.pUp, 1 - gB.pUp) > 3 * Math.min(gA.pUp, 1 - gA.pUp), `${(100 * (1 - gA.pUp)).toFixed(4)}% vs ${(100 * (1 - gB.pUp)).toFixed(4)}%`);
/* what the index-vs-BRTI uncertainty costs: same +$5 case with the basis term removed (as with the official BRTI feed) */
const M = S26.M25_MODEL, sv = gA.sigmaBps;
const pNoBasis = S26.m25PUp({ ...M, basisQ: M.basisQ.map(() => 0) }, { tau: 18, gap: gA.gapUsd, sigBps: sv, S: K + 5, mu: 0, bucket: gA.regime.bucket });
ok('INFO +$5 case: flip risk with our-index basis uncertainty vs with the official feed (no basis term)', true,
  `${(100 * (1 - gA.pUp)).toFixed(3)}% vs ${(100 * (1 - pNoBasis)).toFixed(3)}% (basis sd $${gA.basisSdUsd}, remaining-path sd $${gA.sigmaPathUsd})`);

/* 3. production 2.3 (settlementGeometry + trailingMean over its own ring) on the same situations */
const S23 = require(path.join(ROOT, 'srv23.js'));
for (const [label, rec, spot] of [['+$5 recorded, spot +$5', K + 5, K + 5], ['+$0.50 recorded, spot +$0.50', K + 0.5, K + 0.5], ['+$5 recorded, spot -$3', K + 5, K - 3]]) {
  const now = Date.now();
  S23.IDX.ring.length = 0;
  for (let s = 0; s <= 300; s++) S23.IDX.ring.push([now - (300 - s) * 1000, s >= 258 ? rec : rec]);
  S23.IDX.ring[S23.IDX.ring.length - 1][1] = spot;
  const g = S23.settlementGeometry({ indexNow: spot, strike: K, tau: 18, sigmaBpsRootSec: 0.3, driftBpsSec: 0 });
  const ref = settleMath({ strike: K, recordedAvg: rec, recordedN: 42, remaining: 18, spot });
  ok(`2.3 ${label}: expected settlement uses its trailing 42 s mean`, g && near(g.expSettle != null ? g.expSettle : g.expectedSettle, ref.expectedSettle, 0.2),
    JSON.stringify({ exp: g && (g.expSettle ?? g.expectedSettle), gap: g && g.gapUsd, sig: g && g.sigmasOfCushion, exact: +ref.expectedSettle.toFixed(2) }));
}
for (const r of res) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + ' :: ' + r.got);
const f = res.filter(r => !r.pass).length; console.log(`settlement math: ${res.length - f}/${res.length} passed`); process.exit(f ? 1 : 0);
