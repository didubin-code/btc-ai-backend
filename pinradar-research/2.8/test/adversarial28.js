/* Adversarial statistical + software scenarios (directive Part 9, scenarios 1-20) against the REAL server code.
   Statistical scenarios use real 1 Hz index paths (58 Jul 2026 windows: replay + consecutive samples) with
   SYNTHETIC injected shocks; they test whether the engine recognises risk after the shock, not how often
   shocks happen. Nothing here can show the engine will not lose in future: a stress test is not a guarantee.
   usage: node test/adversarial28.js <server.js> <replay_sample.ndjson> <consecutive_sample.ndjson> [out.json]  */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path'), os = require('os');
const SRVP = path.resolve(process.argv[2]);
const S = require(SRVP);
const W = [process.argv[3], process.argv[4]].flatMap(f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)));
const OUT = process.argv[5];
const out = { server: S.CONFIG28 ? S.CONFIG28.build : 'n/a', scenarios: {} };
let fail = 0; const fails = [];
const check = (id, name, cond, got) => { const r = { name, pass: !!cond, got }; (out.scenarios[id] = out.scenarios[id] || { checks: [] }).checks.push(r); if (!cond) { fail++; fails.push(id + ' ' + name + ' :: ' + JSON.stringify(got).slice(0, 300)); } };
const note = (id, k, v) => { (out.scenarios[id] = out.scenarios[id] || { checks: [] })[k] = v; };

/* ---- one decision at an instant, real classify path, synthetic deep book at `ask` on the leader ---- */
function decide(w, path1Hz, nowMs, tk, opt = {}) {
  const T = Math.floor(nowMs / 1000), C = w.C, tau = (C * 1000 - nowMs) / 1000;
  const at = t => path1Hz.get(t);
  const S0 = at(T); if (S0 == null) return null;
  const ring = []; for (let s = T - 960; s <= T; s++) { const v = at(s); if (v != null) ring.push([s * 1000, v]); }
  const geo = S.lockGeometry25({ indexNow: S0, strike: w.K, closeMs: C * 1000, now: nowMs, inputAgeMs: opt.inputAgeMs ?? 250, ring, basisMu: w.mu });
  const hard = [...(opt.hard || [])], soft = [];
  if (geo && geo.nLock > 0 && geo.lockedCoverage < 0.9) hard.push('coverage');
  const gates = { hard, soft, budgetMs: 1000 };
  const lead = geo && geo.pUp != null ? (geo.pUp >= 0.5 ? 'UP' : 'DOWN') : 'UP';
  const ask = opt.ask ?? 98, size = 500;
  const leadBids = [[Math.round((100 - ask) * 100) / 100, size]], lagBids = [[Math.round((ask - 1) * 100) / 100, size]];
  S.KAL.ob = { ticker: tk, yes: lead === 'UP' ? lagBids : leadBids, no: lead === 'UP' ? leadBids : lagBids }; S.KAL.obTs = nowMs - (opt.bookAgeMs ?? 150);
  const kal = { ok: true, ticker: tk };
  const panel = S.settlePanel27 ? S.settlePanel27({ now: nowMs, closeMs: C * 1000, strike: w.K, geo, tau }) : null;
  if (S.brtiGate27) S.brtiGate27(gates, panel, geo);
  let sig = S.classify25({ now: nowMs, tau, ticker: tk, closeMs: C * 1000, strike: w.K, geo, gates, kal, contracts: 10, mutate: true });
  if (S.brtiAfterClassify27) sig = S.brtiAfterClassify27(sig, panel, tk);
  return { sig, geo, gates, panel };
}
const realDateNow = Date.now;
function withClock(ms, fn) { Date.now = () => ms; try { return fn(); } finally { Date.now = realDateNow; } }
function baseMap(w) { const m = new Map(); w.idx.forEach((v, i) => { if (v != null) m.set(w.T_first + i, v); }); return m; }
function settleOf(w, m) {           // official settlement implied by the path: the window's measured basis + path average of prints C-59..C
  let s = 0, n = 0; for (let t = w.C - 59; t <= w.C; t++) { const v = m.get(t); if (v != null) { s += v; n++; } }
  const base = baseMap(w); let s0 = 0, n0 = 0; for (let t = w.C - 59; t <= w.C; t++) { const v = base.get(t); if (v != null) { s0 += v; n0++; } }
  const basis = w.A - s0 / n0; return Math.round((s / n + basis) * 100) / 100;
}

/* ================= 1-7: sudden adverse jumps at fixed times ================= */
const SIZES = [5, 10, 25, 50, 70, 100, 150], TAUS = [60, 30, 20, 10, 3, 1];
const jumpTable = {};
let runId = 0;
for (const ts of TAUS) for (const X of SIZES) {
  const key = `T-${ts} $${X}`; const r = { lockedAtShock: 0, flips: 0, flipStillLocked1s: 0, flipTradeNowAfter: 0, flipRevWithin1s: 0, flipRevWithin3s: 0, noFlipStillLocked1s: 0, noFlipRev: 0 };
  for (const w of W) {
    const base = baseMap(w); const tk = 'ADV-' + (++runId);
    /* warm per-window state on the real path: T-300 .. shock */
    let lockedSide = null, ok0 = true;
    for (let tau = 300; tau >= ts; tau--) { const d = withClock((w.C - tau) * 1000 + 250, () => decide(w, base, (w.C - tau) * 1000 + 250, tk)); if (!d) { ok0 = false; break; } if (tau === ts) lockedSide = (d.sig.state === 'LOCKED') ? d.sig.side : null; }
    if (!ok0 || !lockedSide) continue;
    r.lockedAtShock++;
    const sign = lockedSide === 'UP' ? -1 : 1;
    const m2 = new Map(base); for (let t = w.C - ts + 1; t <= w.C + 2; t++) if (m2.has(t)) m2.set(t, m2.get(t) + sign * X);   // jump lands right after the shock second
    const before = settleOf(w, base) >= w.K ? 'UP' : 'DOWN', after = settleOf(w, m2) >= w.K ? 'UP' : 'DOWN';
    const flipped = before === lockedSide && after !== lockedSide;
    let still1 = false, rev1 = false, rev3 = false, tradeAfter = false;
    for (let k = 1; k <= Math.min(3, ts); k++) {
      const nowMs = (w.C - ts + k) * 1000 + 250;
      const d = withClock(nowMs, () => decide(w, m2, nowMs, tk)); if (!d) continue;
      const lockedSame = (d.sig.state === 'LOCKED' || d.sig.state === 'PROVEN LOCKED') && d.sig.side === lockedSide;
      if (k === 1) { still1 = lockedSame; rev1 = d.sig.state === 'REVERSAL WARNING'; }
      if (d.sig.state === 'REVERSAL WARNING') rev3 = true;
      if (d.sig.trade && d.sig.trade.action === 'TRADE NOW' && d.sig.side === lockedSide) tradeAfter = true;
    }
    if (flipped) { r.flips++; if (still1) r.flipStillLocked1s++; if (tradeAfter) r.flipTradeNowAfter++; if (rev1) r.flipRevWithin1s++; if (rev3) r.flipRevWithin3s++; }
    else { if (still1) r.noFlipStillLocked1s++; if (rev3) r.noFlipRev++; }
  }
  jumpTable[key] = r;
}
note('S1-S7 jumps', 'table', jumpTable);
const agg = Object.values(jumpTable).reduce((a, r) => { for (const k in r) a[k] = (a[k] || 0) + r[k]; return a; }, {});
note('S1-S7 jumps', 'totals', agg);
check('S1-S7 jumps', 'a jump that flips the settlement never leaves the old side LOCKED one second later', agg.flipStillLocked1s === 0, agg);
check('S1-S7 jumps', 'no TRADE NOW on the old side after a settlement-flipping jump', agg.flipTradeNowAfter === 0, agg);
check('S1-S7 jumps', 'flipping jumps were actually exercised', agg.flips >= 20 && agg.lockedAtShock >= 200, agg);
note('S6 final second', 'reading', 'T-1 jumps: the engine has no later second to react in; recognition is irrelevant because the final print is already being recorded - this is irreducible risk, priced only by the tail tables');

/* ================= 8: volatility regime change ================= */
{
  const res = { windows: 0, sigmaBefore: [], sigmaAfter: [], lockedT60base: 0, lockedT60vol: 0 };
  for (const w of W) {
    const base = baseMap(w), m2 = new Map(base);
    let prevB = null, acc = 0;
    for (let t = w.C - 180; t <= w.C; t++) { const v = base.get(t); if (v == null) continue; if (prevB != null) acc += 3 * (v - prevB); prevB = v; m2.set(t, v + acc); }   // 4x increments from T-180
    const nowMs = (w.C - 60) * 1000 + 250;
    const a = withClock(nowMs, () => decide(w, base, nowMs, 'VOLA-' + w.ticker)), b = withClock(nowMs, () => decide(w, m2, nowMs, 'VOLB-' + w.ticker));
    if (!a || !b) continue; res.windows++;
    res.sigmaBefore.push(a.geo.sigmaRawBps); res.sigmaAfter.push(b.geo.sigmaRawBps);
    if (a.sig.state === 'LOCKED') res.lockedT60base++; if (b.sig.state === 'LOCKED') res.lockedT60vol++;
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  const r = { windows: res.windows, medianSigmaBefore: med(res.sigmaBefore), medianSigmaAfter: med(res.sigmaAfter), lockedAtT60: { base: res.lockedT60base, after4xVol: res.lockedT60vol } };
  note('S8 vol regime change', 'result', r);
  check('S8 vol regime change', 'a 4x volatility burst over the last 120 s raises the live sigma estimate (120 s + 900 s RMS)', r.medianSigmaAfter > 1.5 * r.medianSigmaBefore, r);
  note('S8 vol regime change', 'limitation', 'the 900 s component dilutes a fresh regime change: sigma rises ~2x not 4x within 120 s; tail tables by sigma bucket partly compensate');
}

/* ================= software scenarios 9-20 ================= */
const now0 = Date.now(), K = 80000;
const mkKal = (tk, tau) => ({ ok: true, ticker: tk, closeMs: now0 + tau * 1000, openMs: now0 + tau * 1000 - 900000, strike: K });
function liveSetup(x, { venuesOk = true } = {}) {
  S.IDX.ring.length = 0;
  let v = x, seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; const pts = [];
  for (let i = 0; i < 960; i++) { v += (rnd() - 0.5) * 8.4; pts.push(v); } const off = x - pts[pts.length - 1];
  for (let i = 0; i < 960; i++) S.IDX.ring.push([now0 - 400 - (959 - i) * 1000, pts[i] + off]);
  Object.assign(S.IDX, { value: x, ts: now0 - 400, venuesUsed: ['coinbase', 'kraken', 'bitstamp'], dispersionBps: 1, lastReason: null });
  for (const [n, d] of [['coinbase', 0.3], ['kraken', -0.3], ['bitstamp', 0]]) Object.assign(S.VENUES[n], { mid: x + d, bidDepth: 2, askDepth: 2, lastQuoteTs: venuesOk ? now0 - 40 : now0 - 20000, lastMsgTs: venuesOk ? now0 : now0 - 20000 });
  S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; S.RESTF.active = false;
}
function snapshot({ tau = 45, x = 80120, kalOver = {}, quality = { grade: 'GOOD', problems: [], warnings: [] }, book = { ask: 98, ageMs: 150 }, liveIdx } = {}) {
  const kal = { ...mkKal('SW-' + (++runId), tau), ...kalOver };
  S.KAL.ob = book ? { ticker: kal.ticker, yes: [[book.ask - 1, 300]], no: [[Math.round((100 - book.ask) * 100) / 100, 300]] } : null; S.KAL.obTs = now0 - (book ? book.ageMs : 0);
  const li = liveIdx === undefined ? S.computeIndex(now0) : liveIdx;
  const age = li ? Math.max(...['coinbase', 'kraken', 'bitstamp'].filter(n => li.used.includes(n)).map(n => now0 - S.VENUES[n].lastQuoteTs)) : Infinity;
  return withClock(now0, () => S.computeLockSnapshot({ now: now0, kal, strike: kal.strike, strikeIssue: kalOver.strikeIssue || null, overrides: [], quality, liveIdx: li, liveIndexAgeMs: age, side: null, mutate: false }));
}
liveSetup(80120);
const s0 = snapshot();
check('baseline', 'healthy inputs, $120 cushion at T-45 -> LOCKED UP + TRADE NOW at 98c', s0.signal.state === 'LOCKED' && s0.signal.trade.action === 'TRADE NOW', [s0.signal.state, s0.signal.trade.action, s0.gates]);

/* 9 settlement-reference discrepancy: official BRTI $45 away from the proxy -> LOCKED withheld */
{
  const tau = 45, closeMs = now0 + tau * 1000;
  Object.assign(S.BRTI, { enabled: true, state: 'live', last5: null, last: { value: 80120 + 45, sourceTs: now0 - 300, receivedAt: now0 - 200, sendingTs: now0 - 150, localTs: now0 - 100, amended: false },
    win: { closeMs, value: 80165, size: 15, localTs: now0 - 100 } });
  const kal = { ok: true, ticker: 'SW-OFF', closeMs, openMs: closeMs - 900000, strike: K };
  S.KAL.ob = { ticker: 'SW-OFF', yes: [[97, 300]], no: [[2, 300]] }; S.KAL.obTs = now0 - 150;
  const sn = withClock(now0, () => S.computeLockSnapshot({ now: now0, kal, strike: K, strikeIssue: null, overrides: [], quality: { grade: 'GOOD', problems: [], warnings: [] }, liveIdx: S.computeIndex(now0), liveIndexAgeMs: 40, side: null, mutate: false }));
  check('S9 reference discrepancy', 'official vs proxy divergence > $40 withholds LOCKED (soft gate) and TRADE NOW', sn.signal.state !== 'LOCKED' && sn.gates.soft.some(g => /differ by/.test(g)), [sn.signal.state, sn.gates.soft]);
  /* 10 missing BRTI observations: accumulator 6 ticks behind the clock -> official not used, PROXY fallback */
  S.BRTI.last.value = 80121; S.BRTI.win = { closeMs, value: 80121, size: 9, localTs: now0 - 100 };
  const pn = S.settlePanel27({ now: now0, closeMs, strike: K, geo: sn.geo, tau });
  check('S10 missing BRTI observations', 'accumulator count inconsistent with the clock -> panel falls back to PROXY, reason shown', pn.reference === 'PROXY' && pn.officialReasons.some(r => /window_size/.test(r)), [pn.reference, pn.officialReasons]);
  Object.assign(S.BRTI, { last: null, win: null, state: 'test: off' });
}
/* 11 stale websocket data: venue quotes 3.5 s old at T-45 (budget 3 s) -> hard gate */
{
  liveSetup(80120);
  for (const n of ['coinbase', 'kraken', 'bitstamp']) Object.assign(S.VENUES[n], { lastQuoteTs: now0 - 3500, lastMsgTs: now0 - 100 });
  const sn = snapshot();
  check('S11 stale websocket data', 'index inputs older than the staleness budget -> DATA UNRELIABLE, no trade', sn.signal.state === 'DATA UNRELIABLE' && sn.signal.trade.action === 'NO TRADE', [sn.signal.state, sn.gates.hard]);
  liveSetup(80120);
}
/* 12 delayed order-book messages */
{
  const sn = snapshot({ book: { ask: 98, ageMs: 2600 } });
  check('S12 delayed order book', 'book older than 1.5 s -> LOCKED kept, TRADE NOW replaced by BOOK STALE', sn.signal.state === 'LOCKED' && /BOOK STALE/.test(sn.signal.trade.action) && sn.signal.v28.execution.ready === false, [sn.signal.state, sn.signal.trade.action]);
}
/* 13 out-of-order events */
{
  const v = S.VENUES.coinbase; const t0 = Date.now();
  S.ADAPTERS.coinbase.onMsg(v, { type: 'ticker', sequence: 1000, best_bid: '80100.00', best_ask: '80100.02', time: new Date(t0).toISOString() }, t0);
  S.ADAPTERS.coinbase.onMsg(v, { type: 'ticker', sequence: 999, best_bid: '79000.00', best_ask: '79000.02', time: new Date(t0 - 500).toISOString() }, t0 + 5);
  check('S13 out-of-order events', 'an older Coinbase ticker (lower sequence) cannot overwrite a newer quote', Math.abs(v.mid - 80100.01) < 1e-6 && v.outOfOrder >= 1, [v.mid, v.outOfOrder]);
  const g0 = S.BRTI.seqGaps; Object.assign(S.BRTI, { enabled: true, lastSeq: null });
  for (const q of [1, 2, 4, 3]) S.brtiHandle27({ type: 'cfbenchmarks_value', seq: q, msg: { index_id: 'BRTI', data: JSON.stringify({ time: t0, value: '80100' }) } }, t0);
  check('S13 out-of-order events', 'official BRTI sequence gaps / reordering are counted (visible on /brti-status)', S.BRTI.seqGaps - g0 >= 2, S.BRTI.seqGaps - g0);
  Object.assign(S.BRTI, { last: null, win: null, state: 'test: off' });
  liveSetup(80120);
}
/* 14 incorrect contract metadata */
{
  const p = S.parseKalshiMarket({ ticker: 'X', close_time: new Date(now0 + 45000).toISOString(), open_time: new Date(now0 - 855000).toISOString(), floor_strike: 8.012, strike_type: 'greater_or_equal' });
  check('S14 incorrect metadata', 'decimal-shifted strike is parsed as-is (8.012) and must be caught downstream', p.strike === 8.012, p.strike);
  const sn = snapshot({ kalOver: { strike: 8.012, strikeIssue: 'strike implausible vs index' } });
  check('S14 incorrect metadata', 'implausible strike -> no geometry, DATA UNRELIABLE', sn.signal.state === 'DATA UNRELIABLE' && !sn.geo, [sn.signal.state, sn.gates.hard]);
  /* strike chain: the previous window's official settlement must equal this strike */
  const kal = mkKal('SW-CHAIN', 45); S.SETTLE.done.unshift({ ticker: 'PREV', closeMs: kal.openMs, status: 'SETTLED', official: K + 12.34 });
  const sc = withClock(now0, () => S.computeLockSnapshot({ now: now0, kal, strike: K, strikeIssue: null, overrides: [], quality: { grade: 'GOOD', problems: [], warnings: [] }, liveIdx: S.computeIndex(now0), liveIndexAgeMs: 40, side: null, mutate: false }));
  check('S14 incorrect metadata', 'strike != previous window official settlement -> hard gate (contract mapping wrong)', sc.signal.state === 'DATA UNRELIABLE' && sc.gates.hard.some(g => /previous window/.test(g)), sc.gates.hard);
  S.SETTLE.done.shift();
}
/* 15 incorrect rounding: ties and half-cent boundaries */
{
  const a = S.settleMath({ strike: 80000, recordedAvg: 79999.995, recordedN: 60, remaining: 0, spot: 0 });
  const b = S.settleMath({ strike: 80000, recordedAvg: 79999.994, recordedN: 60, remaining: 0, spot: 0 });
  const c = S.settleMath({ strike: 80000, recordedAvg: 80000, recordedN: 60, remaining: 0, spot: 0 });
  check('S15 rounding', 'average 79,999.995 rounds to the strike -> UP; 79,999.994 -> DOWN; exact tie -> UP', a.result === 'UP' && b.result === 'DOWN' && c.result === 'UP', [a.final, a.result, b.final, b.result, c.result]);
  note('S15 rounding', 'unverified', 'Kalshi rounding mode at exactly half a cent (half-up vs half-even) is not documented in the record we have; affects only averages ending in exactly .xx5');
}
/* 16 network interruptions: Kalshi record 7 s stale; no live venue at all */
{
  const k = { ...mkKal('SW-NET', 45), ok: false };
  const sn = snapshot({ kalOver: k });
  check('S16 network interruption', 'Kalshi market record unavailable -> DATA UNRELIABLE', sn.signal.state === 'DATA UNRELIABLE' && sn.gates.hard.some(g => /Kalshi/.test(g)), sn.gates.hard);
  liveSetup(80120, { venuesOk: false });
  const sn2 = snapshot({ quality: S.assessQuality(now0, { ok: true, pending: false, obAgeMs: 100 }) });
  check('S16 network interruption', 'all exchange feeds down -> DATA UNRELIABLE (D1 gate and BAD quality)', sn2.signal.state === 'DATA UNRELIABLE', [sn2.signal.state, sn2.gates.hard.slice(0, 3)]);
  liveSetup(80120);
}
/* 17 backend restart: the ledger chain continues across a restart from its file; cold vol estimate withholds LOCKED */
{
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'adv28-')); const LF = path.join(TMP, 'ledger.ndjson');
  const run = (code) => require('child_process').execFileSync(process.execPath, ['-e', code], { env: { ...process.env, PINRADAR_REPLAY: '', ENABLE_WS: '0', LEDGER_FILE: LF }, encoding: 'utf8' });
  const code = `const S=require(${JSON.stringify(SRVP)}); S.ledgerAppend28(S.L28,'call',{x:1}); console.log(JSON.stringify({seq:S.L28.seq, head:S.L28.head, resumed:S.L28.resumed})); process.exit(0);`;
  const a = JSON.parse(run(code).trim().split('\n').pop()), b = JSON.parse(run(code).trim().split('\n').pop());
  const rows = fs.readFileSync(LF, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const v = S.verifyLedger28(rows, rows[0].prev);
  check('S17 backend restart', 'second boot resumes the same chain from the file (seq continues, whole file verifies)', b.resumed && b.resumed.n === a.seq && b.seq === a.seq + 2 && v.ok, { a, b, verify: v });
  fs.rmSync(TMP, { recursive: true, force: true });
  S.IDX.ring.length = 0; for (let i = 0; i < 100; i++) S.IDX.ring.push([now0 - 400 - (99 - i) * 1000, 80120 + (i % 3)]);
  const sn = snapshot();
  check('S17 backend restart', 'cold start (100 s of history) -> vol warming soft gate: no LOCKED, no TRADE NOW', sn.signal.state !== 'LOCKED' && sn.signal.trade.action !== 'TRADE NOW', [sn.signal.state, sn.signal.reliability && sn.signal.reliability.notes]);
  liveSetup(80120);
}
/* 18 high computational load: 5,000 full snapshots + an 18,000-trade impulse scan */
{
  const tms = []; for (let i = 0; i < 5000; i++) { const t0 = process.hrtime.bigint(); snapshot(); tms.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  tms.sort((a, b) => a - b); const q = p => +tms[Math.floor(p * tms.length)].toFixed(3);
  for (const n of ['coinbase', 'kraken', 'bitstamp']) { const v = S.VENUES[n]; v.trades.length = 0; for (let i = 0; i < 6000; i++) v.trades.push([now0 - 120000 + i * 20, (i % 2 ? 1 : -1) * 5000, 80120]); }
  const t1 = process.hrtime.bigint(); const imp = S.impulseState(now0); const impMs = Number(process.hrtime.bigint() - t1) / 1e6;
  for (const n of ['coinbase', 'kraken', 'bitstamp']) S.VENUES[n].trades.length = 0;
  note('S18 load', 'result', { snapshotMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +tms[tms.length - 1].toFixed(3) }, impulseScan18kTradesMs: +impMs.toFixed(2), impulseOk: imp.ok });
  check('S18 load', 'p99 full decision snapshot (incl. 2.8 enrichment) < 25 ms', q(0.99) < 25, q(0.99));
  check('S18 load', 'worst-case impulse scan over 18,000 trades < 100 ms (it only runs inside 90 s, shadow policy D)', impMs < 100, impMs);
}
/* 19 unexpectedly large calibration error: true loss rate 4x the standard -> the failure alarm fires */
{
  const M = S.mkFailMonitor28(0.005); let at = null; let seed = 19; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 1; i <= 3000; i++) { S.failUpdate28(M, rnd() < 0.02); if (!at && S.failState28(M).alarm) at = i; }
  check('S19 calibration error', 'a 2 % LOCKED loss rate (4x the 0.5 % standard) raises the anytime-valid alarm', at != null, { alarmAfterCalls: at, state: S.failState28(M) });
  note('S19 calibration error', 'response', 'alarm = stop relying on LOCKED and investigate; no parameter is retuned automatically');
}
/* 20 a highly confident prediction that loses: LOCKED UP, then a $70 crash, settles DOWN */
{
  let picked = null;
  for (const w of W) {
    const base = baseMap(w); const tk = 'S20-' + w.ticker; let lockedAt = null;
    for (let tau = 300; tau >= 20; tau--) { const d = withClock((w.C - tau) * 1000 + 250, () => decide(w, base, (w.C - tau) * 1000 + 250, tk)); if (d && d.sig.state === 'LOCKED' && d.sig.side === 'UP') { lockedAt = tau; break; } }
    if (lockedAt == null || lockedAt < 25) continue;
    const ts = 18, m2 = new Map(base); let need = null;
    { const d = withClock((w.C - ts) * 1000 + 250, () => decide(w, base, (w.C - ts) * 1000 + 250, tk)); need = d && d.geo ? d.geo.requiredMoveUsd : null; }
    if (need == null) continue;
    const X = need + 25; for (let t = w.C - ts + 1; t <= w.C + 2; t++) if (m2.has(t)) m2.set(t, m2.get(t) - X);
    if (settleOf(w, m2) >= w.K) continue;
    const seen = [];
    for (let k = 1; k <= ts; k++) { const nowMs = (w.C - ts + k) * 1000 + 250; const d = withClock(nowMs, () => decide(w, m2, nowMs, tk)); if (d) seen.push(d.sig.state + '/' + (d.sig.trade && d.sig.trade.action)); }
    picked = { ticker: w.ticker, lockedAtTau: lockedAt, shockAtTau: ts, jumpUsd: +X.toFixed(2), requiredMoveUsd: need, statesAfter: seen.slice(0, 4), anyLockedUpAfter: seen.some(s => /^LOCKED/.test(s)), anyTradeNowAfter: seen.some(s => /TRADE NOW/.test(s)) };
    break;
  }
  note('S20 confident loss', 'case', picked);
  check('S20 confident loss', 'after the crash: REVERSAL WARNING / EXIT, never LOCKED UP or TRADE NOW again', picked && !picked.anyLockedUpAfter && !picked.anyTradeNowAfter && /REVERSAL WARNING/.test(picked.statesAfter[0]), picked);
  /* the loss reaches the evidence: shadow ledger scores it and the monitor counts it */
  const st = S.mkShadowStats28(); const Wn = {};
  S.shadowNote28(Wn, 'A-2.6', { state: 'LOCKED', side: 'UP', pFlip: 0.004, pFlipCons: 0.005, trade: { action: 'TRADE NOW', askCents: 99, avgCents: 99, feeCents: 0.1, contracts: 10, depth: 10 } }, { tau: 40, now: 1 });
  S.shadowAccumulate28(st, 'A-2.6', Wn['A-2.6'], 'DOWN');
  const sm = S.shadowSummary28(st)['A-2.6'];
  check('S20 confident loss', 'the losing LOCKED call and the losing paper trade are counted (no survivorship)', sm.lost === 1 && sm.tradeLosses === 1 && sm.pnlCentsPerContractMean === -99.1, sm);
}

console.log(JSON.stringify({ jumpTotals: agg, s8: out.scenarios['S8 vol regime change'].result, s18: out.scenarios['S18 load'].result, s19: out.scenarios['S19 calibration error'].checks[0].got.alarmAfterCalls, s20: out.scenarios['S20 confident loss'].case }));
for (const [k, v] of Object.entries(jumpTable)) console.log(k.padEnd(12), JSON.stringify(v));
const total = Object.values(out.scenarios).reduce((a, s) => a + s.checks.length, 0);
console.log(`adversarial28: ${total - fail}/${total} checks passed` + (fail ? '\n  FAIL ' + fails.join('\n  FAIL ') : ''));
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
process.exit(fail ? 1 : 0);
