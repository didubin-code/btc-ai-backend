/* Unit / property / Monte-Carlo tests for 2.8 core (src/core28.js).
   usage: node test/core28_test.js [path/to/2.7-or-2.8 server for parity deps]   (no network) */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const path = require('path'), fs = require('fs');
const C = require(path.join(__dirname, '..', 'src', 'core28.js'));
const SRV = process.argv[2] ? require(path.resolve(process.argv[2])) : require(path.join(__dirname, '..', '..', 'versions', '2.7', 'pinradar_server.js'));
let pass = 0, fail = 0; const fails = [];
function ok(name, cond, got) { if (cond) pass++; else { fail++; fails.push(name + ' :: ' + JSON.stringify(got)); } }
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(2808);

/* ---------------- fees ---------------- */
const cfgC = C.feeCfg28(), cfgCC = C.feeCfg28({ rounding: 'centicent' });
// independent exact reference: integer arithmetic in units of 1e-8 dollars with price in whole 1e-4 dollars
function refFeeDollars(pc, n, mult, unitDollars) {
  const pc4 = Math.round(pc * 100);
  const num = BigInt(Math.round(mult * 1e6)) * BigInt(n) * BigInt(pc4) * BigInt(10000 - pc4); // 1e-14 $
  const u = BigInt(Math.round(unitDollars * 1e14));
  return Number((num + u - 1n) / u) * unitDollars;
}
let feeBad = 0;
for (let i = 0; i < 20000; i++) {
  const pc = Math.round((1 + R() * 98) * 100) / 100, n = 1 + Math.floor(R() * 500);
  const a = C.feeDollars28(pc, n, cfgC), b = refFeeDollars(pc, n, 0.07, 0.01);
  const a2 = C.feeDollars28(pc, n, cfgCC), b2 = refFeeDollars(pc, n, 0.07, 0.0001);
  if (Math.abs(a - b) > 1e-12 || Math.abs(a2 - b2) > 1e-12) feeBad++;
}
ok('fee: exact integer arithmetic matches independent reference (20k random cases, both rounding units)', feeBad === 0, feeBad);
ok('fee: 4 contracts at 50c = exactly 7c (float trap 7.000000000000001 must not round to 8c)', Math.abs(C.feeDollars28(50, 4, cfgC) - 0.07) < 1e-12, C.feeDollars28(50, 4, cfgC));
ok('fee: 1 contract at 99c = 1c with cent rounding (the whole 1c gross edge)', Math.abs(C.feeDollars28(99, 1, cfgC) - 0.01) < 1e-12, C.feeDollars28(99, 1, cfgC));
ok('fee: 1 contract at 99c = $0.0007 with centicent rounding', Math.abs(C.feeDollars28(99, 1, cfgCC) - 0.0007) < 1e-12, C.feeDollars28(99, 1, cfgCC));
ok('fee: 10 contracts at 99c = 1c total (0.1c/contract)', Math.abs(C.feeCentsPerContract28(99, 10, cfgC) - 0.1) < 1e-9, C.feeCentsPerContract28(99, 10, cfgC));
ok('fee: maker multiplier 0 -> no maker fee by default', C.feeDollars28(97, 10, cfgC, true) === 0, C.feeDollars28(97, 10, cfgC, true));
ok('fee: series multiplier scales the fee', Math.abs(C.feeDollars28(50, 100, C.feeCfg28({ seriesMultiplier: 0.5 })) - 0.88) < 1e-12, C.feeDollars28(50, 100, C.feeCfg28({ seriesMultiplier: 0.5 })));
ok('fee: zero at 0c/100c/invalid size', C.feeDollars28(100, 5, cfgC) === 0 && C.feeDollars28(0, 5, cfgC) === 0 && C.feeDollars28(50, 0, cfgC) === 0 && C.feeDollars28(NaN, 5, cfgC) === 0, 'ok');
// parity with the 2.6 single-level fee (kalshiFeeCents) at whole-cent prices, 2.6's own rounding
let par = 0;
for (let p = 1; p <= 99; p++) for (const n of [1, 2, 3, 5, 7, 10, 13, 25, 50, 100, 250]) {
  if (Math.abs(SRV.kalshiFeeCents(p, n) - C.feeCentsPerContract28(p, n, cfgC)) > 1e-9) par++;
}
ok('fee: identical to the 2.6 fee for every whole-cent price x 11 sizes (single price level)', par === 0, par);
let monoBad = 0;
for (let p = 1; p <= 99; p += 0.5) { let prev = -1; for (let n = 1; n <= 300; n++) { const f = C.feeDollars28(p, n, cfgC); if (f < prev - 1e-12) monoBad++; prev = f; } }
ok('fee: total fee non-decreasing in order size', monoBad === 0, monoBad);

/* ---------------- book walk + ladder ---------------- */
let walkBad = 0;
for (let i = 0; i < 5000; i++) {
  const L = []; let p = 90 + Math.floor(R() * 9);
  for (let k = 0; k < 1 + Math.floor(R() * 6); k++) { L.push([p, Math.floor(R() * 40)]); p += 1 + Math.floor(R() * 2); if (p >= 100) break; }
  const size = 1 + Math.floor(R() * 80);
  const w = C.walk28(L, size);
  // brute force: expand into unit contracts
  const units = []; for (const [pp, s] of L) for (let j = 0; j < s && pp > 0 && pp < 100; j++) units.push(pp);
  const take = units.slice(0, size);
  const avg = take.length ? take.reduce((a, b) => a + b, 0) / take.length : NaN;
  if (w.fillable !== take.length || (take.length && Math.abs(w.avgCents - avg) > 1e-9)) walkBad++;
}
ok('walk: fillable and average price equal brute force (5k random books)', walkBad === 0, walkBad);
ok('walk: skips zero-size, 0c and 100c levels', C.walk28([[95, 0], [0, 5], [100, 5], [96, 3]], 2).avgCents === 96, C.walk28([[95, 0], [0, 5], [100, 5], [96, 3]], 2));
let fillFeeBad = 0;
for (let i = 0; i < 3000; i++) {
  const L = [[90 + Math.floor(R() * 5), 1 + Math.floor(R() * 7)], [96 + Math.floor(R() * 3), 1 + Math.floor(R() * 9)]];
  const w = C.walk28(L, 1 + Math.floor(R() * 15));
  const perOrder = C.walkFeeCents28(w.fills, cfgC), perFill = C.walkFeeCents28(w.fills, C.feeCfg28({ perFill: true }));
  if (perFill + 1e-9 < perOrder) fillFeeBad++;
}
ok('fee: per-fill rounding is never cheaper than whole-order rounding (conservative mode is conservative)', fillFeeBad === 0, fillFeeBad);
const lad = C.evLadder28({ levels: [[98, 12], [99, 100]], pWin: 0.997, pWinCons: 0.995, pWinStress: 0.992, sizes: [1, 10, 25, 200] });
ok('ladder: 1 contract at 98c pays a 1c fee -> EV 0.7c point', Math.abs(lad[0].evCents - (99.7 - 98 - 1)) < 1e-6, lad[0]);
ok('ladder: 10 contracts at 98c: fee 0.2c/contract, conservative EV 1.3c', Math.abs(lad[1].evConsCents - (99.5 - 98 - 0.2)) < 1e-6, lad[1]);
ok('ladder: 25 contracts walks into 99c (avg 98.52c)', Math.abs(lad[2].avgCents - (12 * 98 + 13 * 99) / 25) < 1e-6, lad[2]);
ok('ladder: 200 contracts only 112 fillable, flagged not full', lad[3].fillable === 112 && lad[3].full === false, lad[3]);
ok('ladder: break-even win % = avg price + fee per contract', Math.abs(lad[1].breakEvenWinPct - 98.2) < 1e-6, lad[1].breakEvenWinPct);
ok('ladder: empty book -> nulls, no NaN', C.evLadder28({ levels: [], pWin: 0.99, pWinCons: 0.98 })[0].evCents === null, 'ok');

/* ---------------- uncertainty band ---------------- */
let bandBad = 0;
for (const g of ['quiet', 'normal', 'active', 'weird']) for (let i = 0; i < 1000; i++) { const p = R() * 0.3; const b = C.band28(p, g); if (!(b.lo <= p + 1e-15 && b.hi >= p * 1.0 - 1e-15 && b.lo >= 0 && b.hi <= 0.5)) bandBad++; }
ok('band: lo <= p <= hi, within [0, 0.5], unknown group -> widest band', bandBad === 0 && C.band28(0.01, 'weird').group === 'unknown', bandBad);
ok('band: 0.5 % quiet -> plausible 0.08-0.8 %', C.band28(0.005, 'quiet').label === '≈0.5% (plausible 0.08%–0.8%)', C.band28(0.005, 'quiet').label);
ok('band: tiny probability shown as a bound', /^<0\.1%/.test(C.band28(0.0002, 'active').label), C.band28(0.0002, 'active').label);

/* ---------------- designation ---------------- */
const D = C.designation28;
ok('designation: LOCKED -> PREDICTED LOCKED (not a guarantee)', D({ state: 'LOCKED', tau: 40 }).code === 'PREDICTED_LOCKED', D({ state: 'LOCKED', tau: 40 }));
ok('designation: PROVEN LOCKED -> MATHEMATICALLY FINAL (price-only)', D({ state: 'PROVEN LOCKED', tau: 3 }).code === 'MATHEMATICALLY_FINAL', 'x');
ok('designation: after the close on PROXY -> AWAITING SETTLEMENT, never FINAL', D({ state: 'LOCKED', tau: -1, panel: { reference: 'PROXY', decided: true, final: 100 }, strike: 99 }).code === 'AWAITING_SETTLEMENT', 'x');
ok('designation: after the close on OFFICIAL 60/60 -> MATHEMATICALLY FINAL with side', /DOWN/.test(D({ state: 'LOCKED', tau: -1, panel: { reference: 'OFFICIAL', decided: true, final: 98.99 }, strike: 99 }).label), D({ state: 'LOCKED', tau: -1, panel: { reference: 'OFFICIAL', decided: true, final: 98.99 }, strike: 99 }).label);
ok('designation: tie at exactly the strike -> UP', /— UP/.test(D({ tau: 0, panel: { reference: 'OFFICIAL', decided: true, final: 99 }, strike: 99 }).label), 'x');
ok('designation: Kalshi result -> OFFICIALLY SETTLED (overrides everything)', D({ state: 'LOCKED', tau: -5, settled: { result: 'no', official: 1 } }).code === 'OFFICIALLY_SETTLED', 'x');
ok('designation: HIGH CONFIDENCE -> not locked', D({ state: 'HIGH CONFIDENCE', tau: 30 }).code === 'NOT_LOCKED', 'x');

/* ---------------- ledger ---------------- */
const L = C.mkLedger28({ genesisSeed: 'test' });
for (let i = 0; i < 200; i++) C.ledgerAppend28(L, i % 3 ? 'call' : 'outcome', { i, x: R(), nested: { b: 2, a: [1, { z: 1, y: null }] } }, 1000 + i);
ok('ledger: verifies end to end from genesis', C.verifyLedger28(L.rows, L.genesis).ok, C.verifyLedger28(L.rows, L.genesis));
const tam = JSON.parse(JSON.stringify(L.rows)); tam[57].body.x = 0.5;
ok('ledger: altering one body is detected at that entry', C.verifyLedger28(tam, L.genesis).at === 58, C.verifyLedger28(tam, L.genesis));
const del = JSON.parse(JSON.stringify(L.rows)); del.splice(100, 1);
ok('ledger: deleting an entry is detected', !C.verifyLedger28(del, L.genesis).ok, C.verifyLedger28(del, L.genesis));
const re = JSON.parse(JSON.stringify(L.rows)); [re[10], re[11]] = [re[11], re[10]];
ok('ledger: reordering is detected', !C.verifyLedger28(re, L.genesis).ok, 'x');
const fake = JSON.parse(JSON.stringify(L.rows)); fake[199].body.i = 9999; fake[199].hash = C.entryHash28(fake[199].prev, fake[199]);
ok('ledger: rewriting the last entry and its hash changes the head (detectable against a published head)', C.verifyLedger28(fake, L.genesis).head !== L.head, 'x');
ok('ledger: canonical JSON is key-order independent', C.canon28({ b: 1, a: { d: 2, c: 3 } }) === C.canon28({ a: { c: 3, d: 2 }, b: 1 }), 'x');
ok('ledger: a mid-stream segment verifies from its own first prev', C.verifyLedger28(L.rows.slice(50, 120)).ok, 'x');
const tmp = path.join(require('os').tmpdir(), 'ledger28_test_' + process.pid + '.ndjson');
const LF = C.mkLedger28({ genesisSeed: 'file', file: tmp, fs });
for (let i = 0; i < 20; i++) C.ledgerAppend28(LF, 'call', { i }, i);
const back = fs.readFileSync(tmp, 'utf8').trim().split('\n').map(JSON.parse); fs.unlinkSync(tmp);
ok('ledger: the append-only file round-trips and verifies', back.length === 20 && C.verifyLedger28(back, LF.genesis).ok, back.length);

/* ---------------- binomial bounds ---------------- */
ok('cp: 0/300 one-sided 95% = 0.99%', Math.abs(C.cpUpper28(0, 300) - 0.009936) < 2e-5, C.cpUpper28(0, 300));
ok('cp: 3/1879 one-sided 95% = 0.412% (scipy)', Math.abs(C.cpUpper28(3, 1879) - 0.004118) < 2e-5, C.cpUpper28(3, 1879));
ok('cp: 13/3484 one-sided 95% = 0.593% (scipy)', Math.abs(C.cpUpper28(13, 3484) - 0.005929) < 3e-5, C.cpUpper28(13, 3484));

/* ---------------- e-processes: Monte Carlo validity and power ---------------- */
function simFail(p, n, sims, seed) { const r = rng(seed); let alarms = 0; for (let s = 0; s < sims; s++) { const M = C.mkFailMonitor28(0.005); for (let i = 0; i < n; i++) { C.failUpdate28(M, r() < p); if (C.failState28(M).alarm) { alarms++; break; } } } return alarms / sims; }
const t1 = simFail(0.005, 4000, 1500, 11);
ok('failure alarm: type-I error <= 5% at the boundary p = 0.5% over 4,000 LOCKED calls (Ville)', t1 <= 0.05 + 0.02, t1);
const pw = simFail(0.015, 2000, 400, 12);
ok('failure alarm: detects a 3x worse loss rate (1.5%) within 2,000 calls in >= 80% of runs', pw >= 0.8, pw);
const pw2 = simFail(0.01, 2000, 400, 13);
function simEdge(edgeC, px, n, sims, seed) {
  const r = rng(seed); const fee = 0.2; const pLoss = (100 - px - fee - edgeC) / 100; let hits = 0;
  for (let s = 0; s < sims; s++) { const M = C.mkEdgeMonitor28(); for (let i = 0; i < n; i++) { const lost = r() < pLoss; C.edgeUpdate28(M, ((lost ? 0 : 100) - px - fee) / 100); if (C.edgeState28(M).proven) { hits++; break; } } }
  return hits / sims;
}
const te = simEdge(0, 98, 3000, 1500, 21);
ok('proof of edge: type-I error <= 5% when the true edge is exactly 0 (98c, 3,000 trades)', te <= 0.05 + 0.02, te);
const pe1 = simEdge(1.0, 98, 600, 400, 22), pe2 = simEdge(1.0, 98, 1500, 400, 23);
ok('proof of edge: power reported (1c edge at 98c)', pe1 >= 0 && pe2 >= pe1 - 0.05, { n600: pe1, n1500: pe2 });

/* ---------------- shadow policies on the real 2.7 engine ---------------- */
const lines = fs.readFileSync(path.join(__dirname, '..', '..', 'pkg27', 'test', 'data', 'replay_sample.ndjson'), 'utf8').trim().split('\n').slice(0, 25).map(JSON.parse);
const deps = { m25Decide: SRV.m25Decide, recalPUp26: SRV.recalPUp26, recalRatio26: SRV.recalRatio26 };
let polBad = { A: 0, C1: 0, F: 0, E: 0, D: 0, mono: 0 }, nTicks = 0, nLockA = 0, nLockC1 = 0, nTradeA = 0, nTradeF = 0;
for (const w of lines) {
  const at = T => (T >= w.T_first && T - w.T_first < w.idx.length) ? w.idx[T - w.T_first] : null;
  for (let tau = 300; tau >= 1; tau -= 3) {
    const nowMs = (w.C - tau) * 1000 + 250, T = Math.floor(nowMs / 1000), S0 = at(T); if (S0 == null) continue;
    const ring = []; for (let s = T - 960; s <= T; s++) { const v = at(s); if (v != null) ring.push([s * 1000, v]); }
    const geo = SRV.lockGeometry25({ indexNow: S0, strike: w.K, closeMs: w.C * 1000, now: nowMs, inputAgeMs: 250, ring, basisMu: w.mu });
    if (!geo || geo.pUp == null) continue;
    const lead = geo.pUp >= 0.5 ? 'UP' : 'DOWN';
    const ask = 90 + Math.floor(R() * 10) + (R() < 0.5 ? 0.5 : 0);
    const lv = [[ask, 5 + Math.floor(R() * 50)], [Math.min(99.9, ask + 1), 100]];
    const book = { ok: true, ageMs: 300, yesAsks: lead === 'UP' ? lv : [[2, 100]], noAsks: lead === 'DOWN' ? lv : [[2, 100]] };
    const gates = { hard: [], soft: [] }, cfg = SRV.m25Cfg(10);
    const base = SRV.m25Decide({ tau, pUp: geo.pUp, pUpCons: geo.pUpCons, gates, book, cfg, hist: [], lockedSide: null, provenSide: geo.provenUp ? 'UP' : null });
    const snap = { geo, gates, book, decision: base, panel: { reference: 'PROXY' } };
    const get = id => C.shadowDecide28(id, { snap, deps, cfg, tau, impulse: { ok: true, live: true, direction: lead === 'UP' ? -1 : 1 } });
    const a = get('A-2.6'), c1 = get('C1-strict-0.2'), f = get('F-market-pooled-value'), e = get('E-official-ensemble'), d = get('D-impulse-veto');
    nTicks++;
    if (a !== base) polBad.A++;
    if (c1.state === 'LOCKED' && !(c1.pFlip <= 0.002)) polBad.C1++;
    if (c1.state === 'LOCKED' && base.state !== 'LOCKED') polBad.mono++;             // stricter can never lock when 2.6 does not
    if (f.trade.action === 'TRADE NOW' && base.trade.action !== 'TRADE NOW') polBad.F++;  // F only removes trades
    if (JSON.stringify(e) !== JSON.stringify(base)) polBad.E++;                           // no official feed -> identical to A
    if (d.state === 'LOCKED' && tau <= 90) polBad.D++;                                    // adverse impulse live -> never LOCKED inside 90 s
    if (base.state === 'LOCKED') nLockA++; if (c1.state === 'LOCKED') nLockC1++;
    if (base.trade.action === 'TRADE NOW') nTradeA++; if (f.trade.action === 'TRADE NOW') nTradeF++;
  }
}
ok('shadow A returns the production decision object itself', polBad.A === 0, polBad.A);
ok('shadow C1 LOCKs only at flip <= 0.2 % and never where 2.6 does not', polBad.C1 === 0 && polBad.mono === 0, polBad);
ok('shadow F can only remove TRADE NOW, never add one', polBad.F === 0, polBad.F);
ok('shadow E is identical to A when the official feed is not live', polBad.E === 0, polBad.E);
ok('shadow D never LOCKs inside 90 s while an adverse impulse is live', polBad.D === 0, polBad.D);
ok('shadow: exercised real decisions', nTicks > 1000 && nLockA > 50, { nTicks, nLockA, nLockC1, nTradeA, nTradeF });
ok('pooled flip: 99c -> 0.355 %, 95c -> 1.047 % (python reanalysis values)', Math.abs(C.marketPooledFlip28(99) - 0.00355) < 2e-5 && Math.abs(C.marketPooledFlip28(95) - 0.01047) < 5e-5, [C.marketPooledFlip28(99), C.marketPooledFlip28(95)]);

/* shadow bookkeeping */
const W = {}; const dLock = { state: 'LOCKED', side: 'UP', pFlip: 0.003, pFlipCons: 0.004, trade: { action: 'TRADE NOW', askCents: 98, avgCents: 98, feeCents: 0.2, contracts: 10, depth: 10, evConsCents: 1.4 } };
const n1 = C.shadowNote28(W, 'A-2.6', dLock, { tau: 80, now: 1, bookAgeMs: 100 });
const n2 = C.shadowNote28(W, 'A-2.6', Object.assign({}, dLock, { side: 'DOWN' }), { tau: 70, now: 2 });
ok('shadow note: only the FIRST lock/trade per window is recorded', n1.events.join() === 'firstLock,firstTrade' && n2 === null && W['A-2.6'].firstLock.side === 'UP', [n1 && n1.events, n2]);
const st = C.mkShadowStats28();
const sc = C.shadowAccumulate28(st, 'A-2.6', W['A-2.6'], 'DOWN');
ok('shadow score: a lost LOCKED call and a losing trade (-98.2c) are counted', sc.lost === true && Math.abs(sc.trade.pnlCentsPerContract + 98.2) < 1e-9 && st['A-2.6'].lost === 1, sc);
const sm = C.shadowSummary28(st);
ok('shadow summary: CP upper bound (1 of 1 lost -> 100 %) and monitors present', sm['A-2.6'].lossCp95UpperPct === 100 && sm['A-2.6'].failure.n === 1 && sm['A-2.6'].edge.n === 1, sm['A-2.6']);

/* ---------------- latency summary ---------------- */
const LT = C.mkLat28(100); for (let i = 1; i <= 1000; i++) C.latNote28(LT, 'x', i); C.latNote28(LT, 'x', NaN);
const ls = C.latSummary28(LT).x;
ok('latency: bounded buffer, percentiles over the last N, NaN ignored', ls.n === 100 && ls.p50 === 951 && ls.max === 1000, ls);

console.log(`core28 tests: ${pass}/${pass + fail} passed` + (fail ? '\n  FAIL ' + fails.join('\n  FAIL ') : ''));
console.log(JSON.stringify({ monteCarlo: { failureTypeI: t1, failurePower3x: pw, failurePower2x: pw2, edgeTypeI: te, edgePower1c_600: pe1, edgePower1c_1500: pe2 }, shadowCounts: { nTicks, nLockA, nLockC1, nTradeA, nTradeF } }));
process.exit(fail ? 1 : 0);
