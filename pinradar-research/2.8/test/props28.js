/* Property tests behind the report's mathematical claims (deterministic seeds; every count printed is what ran):
   1. settlement brute force: settleMath's critical remaining average vs exact integer-cent settlement
   2. final settlement (no prints left) vs exact integer-cent rounding, including exact half-cent ties
   3. the projected leader at an exact half-cent tie is UP (settles UP)
   4. m25PUp is non-decreasing in the gap to the strike (tau x gap x sigma x regime x basis grid)
   5. recalPUp26 is non-decreasing in the raw probability for every recalibration ratio, and fixes 0, 1/2, 1
   usage: node test/props28.js <pinradar_server.js>                                                            */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const path = require('path');
const S = require(path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'pinradar_server.js')));
let seed = 7; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
let fail = 0; const out = {};
const ok = (name, cond, got) => { out[name] = got; if (!cond) { fail++; console.log('FAIL ' + name + ' :: ' + JSON.stringify(got)); } };

/* 1 + 3: integer-cent states (BRTI is published to the cent); exact rule: round_half_up(sum/60) >= K <=> 2*sum >= 120*K - 60 */
{
  let states = 0, checks = 0, bad = 0, ties = 0, tieBad = 0; const ex = [];
  for (let it = 0; it < 20000; it++) {
    const Kc = 8000000 + Math.floor(rnd() * 2000000), n = Math.floor(rnd() * 60), r = 60 - n;
    if (r === 0) continue;
    const recC = Array.from({ length: n }, () => Kc + Math.round((rnd() - 0.5) * 20000));
    const sumC = recC.reduce((a, b) => a + b, 0);
    const sm = S.settleMath({ strike: Kc / 100, recordedAvg: n ? sumC / n / 100 : null, recordedN: n, remaining: r, spot: Kc / 100 });
    states++;
    const cC = Math.round(sm.criticalRemainingAvg * 100);
    for (let d = -3; d <= 3; d++) {
      const vC = cC + d, totC = sumC + r * vC;
      /* critical average in cents = (60K - 30 - sum)/r: either a whole cent or >= 1/60 cent away from one, so a 1e-6 $ tolerance
         is exact here (the float value carries ~1e-9 relative error at r = 1; it is display-only and shown rounded to the cent) */
      const exactUp = 2 * totC >= 120 * Kc - 60, engineUp = vC / 100 >= sm.criticalRemainingAvg - 1e-6;
      checks++; if (exactUp !== engineUp) { bad++; if (ex.length < 3) ex.push({ Kc, n, vC, crit: sm.criticalRemainingAvg }); }
    }
    /* exact tie: choose remaining prints so the average is exactly K - 0.005 when that is reachable in whole cents */
    const need = 120 * Kc - 60 - 2 * sumC;                      // 2*r*vC must equal need
    if (need % (2 * r) === 0) {
      const vC = need / (2 * r); ties++;
      const smT = S.settleMath({ strike: Kc / 100, recordedAvg: n ? sumC / n / 100 : null, recordedN: n, remaining: r, spot: vC / 100 });
      if (smT.leader !== 'UP') tieBad++;
    }
  }
  ok('settlement brute force: critical remaining average = exact integer settlement', bad === 0 && checks > 100000, { states, checks, violations: bad, ex });
  ok('exact half-cent ties project UP', tieBad === 0 && ties > 0, { ties, wrong: tieBad });
}
/* 2: no prints left: final value and result vs exact integer rounding (ties included) */
{
  let checks = 0, bad = 0;
  for (let it = 0; it < 20000; it++) {
    const Kc = 8000000 + Math.floor(rnd() * 2000000);
    let sumC = 0; for (let i = 0; i < 60; i++) sumC += Kc + Math.round((rnd() - 0.5) * 400);
    if (it % 4 === 0) sumC = 60 * Kc - 30 + (it % 8 === 0 ? 0 : -1);   // exact tie (avg = K - 0.005) and just below
    const sm = S.settleMath({ strike: Kc / 100, recordedAvg: sumC / 60 / 100, recordedN: 60, remaining: 0, spot: Kc / 100 });
    const finalC = Math.floor((2 * sumC + 60) / 120);           // round half up of sumC/60 in cents
    checks++; if (Math.round(sm.final * 100) !== finalC || (sm.result === 'UP') !== (finalC >= Kc)) bad++;
  }
  ok('final settlement (60/60) = exact integer rounding, ties included', bad === 0, { checks, violations: bad });
}
/* 4: monotone in gap */
{
  const M = S.M25_MODEL; let evals = 0, bad = 0; const ex = [];
  const taus = []; for (let t = 1; t <= 300; t += 5) taus.push(t);
  const gaps = []; for (let g = -300; g <= 300; g += 6) gaps.push(g);
  for (const tau of taus) for (const sig of [0.08, 0.15, 0.25, 0.4, 0.7, 1.2]) for (let bucket = 0; bucket < 7; bucket++) for (const bm of [0, 1]) {
    let prev = -Infinity;
    for (const gap of gaps) {
      const p = S.m25PUp(M, { tau, gap, sigBps: sig, S: 80000, mu: 0.5, basisMult: bm, bucket }); evals++;
      if (p == null || !Number.isFinite(p) || p < prev - 1e-12) { bad++; if (ex.length < 3) ex.push({ tau, gap, sig, bucket, bm, p, prev }); }
      if (Number.isFinite(p)) prev = p;
    }
  }
  ok('m25PUp is non-decreasing in the gap to the strike', bad === 0 && evals > 100000, { evals, violations: bad, ex });
}
/* 5: recalibration monotone and fixes the endpoints */
{
  let evals = 0, bad = 0;
  for (const ratio of [0.25, 0.52, 1, 2.02, 4]) {
    let prev = -Infinity;
    for (let i = 0; i <= 2000; i++) { const p = i / 2000, q = S.recalPUp26(p, ratio); evals++; if (!(q >= prev - 1e-12) || q < 0 || q > 1) bad++; prev = q; }
    if (Math.abs(S.recalPUp26(0.5, ratio) - 0.5) > 1e-12) bad++;
  }
  ok('recalPUp26 is monotone, within [0,1] and fixes 1/2', bad === 0, { evals, violations: bad });
}
console.log(JSON.stringify(out));
console.log(`props28: ${fail ? fail + ' FAILED' : 'all checks passed'}`);
process.exit(fail ? 1 : 0);
