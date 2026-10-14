/* Invariant test of the 2.7 code path: 20,000 random (often hostile) inputs through the real lockGeometry25 ->
   settlePanel27 -> brtiGate27 -> classify25 -> brtiAfterClassify27, with random official-feed states (none, fresh,
   stale, wrong window, wrong count, diverging, garbage values). Each case is also classified by the unmodified 2.6 path.
   Invariants:
     - no exception; probabilities null or in [0, 1]
     - all 2.6 invariants (LOCKED only <= LOCK_MAX_FLIP without gates inside the horizon; TRADE NOW rules; hard gates)
     - 2.7 never ADDS a LOCKED call or a TRADE NOW that 2.6 would not make
     - with a PROXY panel the 2.7 decision is identical to 2.6 (state, side, probabilities, action)
     - panel arithmetic: (n * recordedAvg + r * critical) / 60 = strike - 0.005 (to the displayed cent)
   usage: node test/fuzz27.js <dist27 server.js> <dist26 server.js> */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const path = require('path');
const S = require(path.resolve(process.argv[2] || 'dist27/pinradar_server.js'));
const S26 = require(path.resolve(process.argv[3] || 'dist26/pinradar_server.js'));
let seed = 2727; const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const bad = []; const cnt = { locked: 0, trade: 0, official: 0, proxy: 0, gated: 0, offRev: 0 };
const key = s => [s.state, s.side, s.pWin, s.pFlip, s.trade && s.trade.action].join('|');
for (let it = 0; it < 20000; it++) {
  const now = 1_800_000_000_000 + Math.floor(rnd() * 1e9);
  const tau = pick([-2, 0, 0.4, 2, 2.9, 3, 5, 15, 18, 30, 45, 59.5, 60, 61, 90, 120, 200, 299, 300, 301, 420, NaN]);
  const strike = pick([80000, 80000.01, 79990, 0, NaN, 1e9]);
  const level = 80000 + (rnd() - 0.5) * pick([2, 20, 200, 2000]);
  const vol = pick([0, 0.01, 0.2, 0.5, 2, 20]);
  const ring = []; let v = level;
  const len = pick([0, 3, 100, 600, 960]);
  for (let k = len; k >= 0; k--) { v *= 1 + vol * 1e-4 * (rnd() - 0.5) * 3.4; if (rnd() > 0.02) ring.push([now - k * 1000 - Math.floor(rnd() * 900), v]); }
  const indexNow = pick([v, v, v, NaN, null]);
  const closeMs = now + tau * 1000;
  const basisMu = pick([0, 0.9, -5, null]), inputAgeMs = pick([0, 100, 900, 4000]);
  /* official feed state */
  const mode = pick(['none', 'fresh', 'fresh', 'fresh', 'stale', 'otherWindow', 'badCount', 'diverge', 'garbage']);
  const qClose = Number.isFinite(closeMs) ? Math.round(closeMs) : NaN;
  const expN = Number.isFinite(tau) && tau < 60 ? Math.max(0, Math.min(60, 60 - Math.ceil(tau - 1e-9))) : 0;
  const offLevel = (Number.isFinite(v) ? v : 80000) + (mode === 'diverge' ? pick([-80, 60]) : (rnd() - 0.5) * 6);
  if (mode === 'none') Object.assign(S.BRTI, { enabled: true, last: null, win: null, state: 'fuzz: none' });
  else Object.assign(S.BRTI, { enabled: true, state: 'live',
    last: { value: mode === 'garbage' ? pick([NaN, -1, 0]) : offLevel, sourceTs: now - 300, receivedAt: now - 200, sendingTs: now - 150, localTs: mode === 'stale' ? now - 9000 : now - pick([10, 400, 2400]), amended: false },
    win: { closeMs: mode === 'otherWindow' ? qClose + 900000 : qClose, value: offLevel + (rnd() - 0.5) * 20, size: mode === 'badCount' ? (expN + 7) % 61 : expN, localTs: now - 20 } });
  let geo = null, panel = null, sig, sig26;
  const askSide = pick([null, 50, 85, 89.9, 90, 95, 96, 98.5, 99.4, 99.9]);
  const book = askSide == null ? null : { yes: [[100 - askSide, pick([1, 5, 10, 500])]], no: [[100 - askSide, pick([1, 5, 10, 500])]] };
  const obTs = now - pick([50, 400, 1400, 1600, 10000]);
  const hard = rnd() < 0.15 ? ['index stale'] : [], soft = rnd() < 0.15 ? ['quality degraded'] : [];
  const lockedSide = pick([null, null, 'UP', 'DOWN']); const contracts = pick([1, 10, 100]);
  try {
    geo = S.lockGeometry25({ indexNow, strike, closeMs, now, inputAgeMs, ring, basisMu });
    panel = S.settlePanel27({ now, closeMs, strike, geo, tau });
    const gates = { hard: [...hard], soft: [...soft], budgetMs: 1000 };
    S.brtiGate27(gates, panel, geo);
    if (gates.hard.length !== hard.length || gates.soft.length < soft.length) bad.push({ it, why: 'gate removed a gate' });
    S.KAL.ob = book ? { ticker: 'FUZZ', ...book } : null; S.KAL.obTs = obTs;
    Object.assign(S.LOCK25, { ticker: 'FUZZ', hist: [], lockedSide, lockedAtTau: 80, revNoted: false });
    sig = S.brtiAfterClassify27(S.classify25({ now, tau, ticker: 'FUZZ', closeMs, strike, geo, gates, kal: { ok: true, ticker: 'FUZZ' }, contracts, mutate: false }), panel, 'FUZZ');
    if (gates.soft.length > soft.length) cnt.gated++;
    /* the same inputs through unmodified 2.6 */
    const g26 = S26.lockGeometry25({ indexNow, strike, closeMs, now, inputAgeMs, ring, basisMu });
    S26.KAL.ob = book ? { ticker: 'FUZZ', ...book } : null; S26.KAL.obTs = obTs;
    Object.assign(S26.LOCK25, { ticker: 'FUZZ', hist: [], lockedSide, lockedAtTau: 80, revNoted: false });
    sig26 = S26.classify25({ now, tau, ticker: 'FUZZ', closeMs, strike, geo: g26, gates: { hard: [...hard], soft: [...soft], budgetMs: 1000 }, kal: { ok: true, ticker: 'FUZZ' }, contracts, mutate: false });
  } catch (e) { bad.push({ it, mode, e: String(e && e.stack || e).slice(0, 300) }); continue; }
  if (geo && geo.pUp != null && !(geo.pUp >= 0 && geo.pUp <= 1)) bad.push({ it, why: 'pUp out of range' });
  if (panel && panel.officialPUp != null && !(panel.officialPUp >= 0 && panel.officialPUp <= 1)) bad.push({ it, why: 'officialPUp out of range', p: panel.officialPUp });
  const ref = panel ? panel.reference : 'NONE';
  if (ref === 'OFFICIAL') cnt.official++; else cnt.proxy++;
  if (['stale', 'otherWindow', 'garbage', 'none'].includes(mode) && ref === 'OFFICIAL' && !(mode === 'otherWindow' && expN <= 1)) bad.push({ it, why: 'unusable official data used', mode, tau });
  if (mode === 'badCount' && ref === 'OFFICIAL' && Number.isFinite(tau) && tau < 60 && expN > 1) bad.push({ it, why: 'inconsistent window_size used', tau });
  const t = sig.trade || {};
  if (sig.state === 'LOCKED') {
    cnt.locked++;
    if (!(sig.pFlip <= S.LOCK_MAX_FLIP + 1e-12)) bad.push({ it, why: 'LOCKED above flip limit' });
    if (hard.length || soft.length) bad.push({ it, why: 'LOCKED with a gate' });
    if (!(tau <= S.LOCK_MAX_TAU)) bad.push({ it, why: 'LOCKED outside horizon', tau });
  }
  if (hard.length && (sig.state === 'LOCKED' || t.action === 'TRADE NOW')) bad.push({ it, why: 'hard gate leaked' });
  if (t.action === 'TRADE NOW') {
    cnt.trade++;
    if (sig.state !== 'LOCKED' && sig.state !== 'PROVEN LOCKED') bad.push({ it, why: 'TRADE NOW without LOCKED' });
    if (!(t.askCents >= S.MIN_TRADE_ASK_CENTS)) bad.push({ it, why: 'TRADE NOW below ask floor' });
    if (!(tau >= S.MIN_EXEC_TAU)) bad.push({ it, why: 'TRADE NOW too late' });
  }
  if (sig.state === 'LOCKED' && sig26.state !== 'LOCKED') bad.push({ it, why: '2.7 added a LOCKED call', s26: sig26.state, ref });
  if (t.action === 'TRADE NOW' && !(sig26.trade && sig26.trade.action === 'TRADE NOW')) bad.push({ it, why: '2.7 added a TRADE NOW' });
  if (sig.officialReversal) cnt.offRev++;
  if (ref !== 'OFFICIAL' && key(sig) !== key(sig26)) bad.push({ it, why: 'PROXY decision differs from 2.6', a: key(sig26), b: key(sig) });
  if (panel && panel.criticalRemainingAvg != null && panel.remaining > 0) {
    const n = panel.recorded, r = panel.remaining, A = n > 0 ? panel.recordedAvg : 0;
    const lhs = (n * A + r * panel.criticalRemainingAvg) / 60, rhs = strike - 0.005;
    if (Math.abs(lhs - rhs) > 0.011) bad.push({ it, why: 'panel identity broken', lhs, rhs, n, r });
  }
}
Object.assign(S.BRTI, { last: null, win: null, state: 'fuzz done' });
console.log(`fuzz27: 20000 cases, OFFICIAL panels ${cnt.official}, PROXY/NONE ${cnt.proxy}, official gate fired ${cnt.gated}, official reversal ${cnt.offRev}, LOCKED ${cnt.locked}, TRADE NOW ${cnt.trade}, violations ${bad.length}`);
for (const b of bad.slice(0, 12)) console.log(JSON.stringify(b));
process.exit(bad.length ? 1 : 0);
