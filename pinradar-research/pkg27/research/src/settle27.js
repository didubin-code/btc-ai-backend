/* ===== v2.7 exact settlement arithmetic (pure functions, no I/O) =====
   Contract terms (Kalshi market record, KXBTC15M): YES iff the simple average of the 60 one-second CF Benchmarks BRTI
   values before the close, rounded to the nearest cent, is at least the strike (= the previous window's official value,
   already rounded to the cent). Kalshi's cfbenchmarks_value feed accumulates exactly that window: ticks in
   (close - 60 s, close], window_size = ticks counted so far (1 at :01 ... 60 at the close tick).
   "Rounded to the nearest 2 decimal places" -> round2(avg) >= K  <=>  avg >= K - 0.005 (half-up). */
const SETTLE_TICKS = 60;
function settleRound2(x) { return Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
/* recordedAvg/recordedN: ticks already in the settlement window (official accumulator, or our index fallback).
   remaining: ticks still to come including the close tick. spot: latest index value.
   Returns the exact state of the settlement, the critical average the remaining ticks must reach to flip the
   leader, and the move (from the current spot) that requires. */
function settleMath({ strike, recordedAvg = null, recordedN = 0, remaining, spot }) {
  const n = Math.max(0, recordedN | 0), r = Math.max(0, remaining | 0);
  const N = n + r;
  if (!(N > 0) || !Number.isFinite(strike)) return null;
  const sumRec = n > 0 ? recordedAvg * n : 0;
  const thr = strike - 0.005;
  const expected = r > 0 ? (sumRec + r * spot) / N : sumRec / N;
  const leader = expected >= thr ? 'UP' : 'DOWN';
  const out = { strike, N, recordedN: n, recordedAvg: n > 0 ? recordedAvg : null, remaining: r, spot,
    expectedSettle: expected, expectedRounded: settleRound2(expected), leader, decided: r === 0 };
  if (r === 0) { out.final = settleRound2(sumRec / N); out.result = out.final >= strike ? 'UP' : 'DOWN'; return out; }
  const critical = (N * thr - sumRec) / r;                 // remaining ticks averaging exactly this -> rounded settlement = strike boundary
  out.criticalRemainingAvg = critical;
  out.criticalVsStrike = critical - strike;                // e.g. -11.67 = the rest must average $11.67 below the strike
  out.requiredMove = leader === 'UP' ? spot - critical : critical - spot;   // > 0: adverse distance from spot to the critical average
  out.recordedVsStrike = n > 0 ? recordedAvg - strike : null;
  // a single sudden move held to the close: needed now, or k seconds from now (only the last r - k ticks carry it)
  out.jumpNeeded = k => (k >= r ? Infinity : out.requiredMove * r / (r - k));
  return out;
}
