/* Unit tests: Tests 4 (pricing, no look-ahead, clocks), 7 (durability), 8 (security), 9 (missing data), the signal
   classifications, the collectors (against fake HTTP), and one test for every defect found by the adversarial reviews
   (each is labelled "review:"). */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const ST = require('../lib/store'), D = require('../lib/derive'), F = require('../lib/fills'), R = require('../lib/report');
const { mkClient, PINRADAR_PATHS, KALSHI_PATHS } = require('../lib/http');
const { pinradarSource, kalshiSource } = require('../lib/sources');
const ROOT = path.join(__dirname, '..'), OBS = path.join(ROOT, 'observer.js');
const results = [], pending = [];
const t = (n, f) => pending.push((async () => { try { await f(); results.push([true, n]); } catch (e) { results.push([false, n + ' :: ' + e.message]); } })());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obs_unit_'));
const cli = (args, env = {}) => spawnSync(process.execPath, [OBS, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const symKey = () => { const d = tmp(), f = path.join(d, 'k.b64'); fs.writeFileSync(f, ST.newKey(), { mode: 0o600 }); return { file: f, key: ST.loadKey(f) }; };

/* a synthetic market: close at C (observer clock); Pin Radar clock = observer + OFF */
const C = Date.UTC(2026, 9, 30, 12, 0, 0), OFF = 1000;
const mk = (tk, result = 'yes', closeMs = C, extra = {}) => ({ kind: 'k.market', ticker: tk, tRecv: closeMs + 10e3, market: { ticker: tk, open_time: new Date(closeMs - 900e3).toISOString(), close_time: new Date(closeMs).toISOString(),
  floor_strike: 80000, status: 'finalized', result, expiration_value: '80010.5', settlement_ts: new Date(closeMs + 2500).toISOString(), rules_primary: 'rules', ...extra } });
/* rows for seconds-remaining s = 300..1 (tau s - 0.25: floors 299..0, every second of the final 300) */
const rowsFor = (tk, fn, closeMs = C) => { const out = []; for (let s = 300; s >= 1; s--) { const st = fn(s); if (st) out.push({ ts: closeMs + OFF - s * 1000 + 250, ticker: tk, tau: s - 0.25, strike: 80000, ...st }); } return out; };
const hAt = (tRecv, off = OFF, rtt = 20) => ({ kind: 'pr.health', tSent: tRecv - rtt, tRecv, body: { ts: tRecv - rtt / 2 + off, tiers: { lockMaxFlip: 0.005 }, build: 'b1', version: 'pin-radar-2.8' } });
const health = hAt(C - 600e3);
const book = (tk, tRecv, yesAsk, size = 500) => ({ kind: 'k.book', ticker: tk, tSent: tRecv - 30, tRecv, hash: 'h' + tRecv, book: { orderbook_fp: { no_dollars: [[((100 - yesAsk) / 100).toFixed(4), String(size)]], yes_dollars: [['0.0100', '100']] } } });
const L = (side, pFlip = 0.001) => ({ state: 'LOCKED', side, pFlip, pFlipCons: pFlip * 2, ask: 97 });
const H = side => ({ state: 'HIGH CONFIDENCE', side, pFlip: 0.02 });
const one = raw => D.build(raw).markets[0];
let uid = 0; const tkn = () => 'KXBTC15M-T' + (++uid);

/* ================= pricing and clocks (Test 4) ================= */
t('Test 4: the price at a signal is the newest book RECEIVED before the signal (clock offset applied), never a later one', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('UP') : L('UP'));
  const sigObs = C - 100e3 + 250;
  const d = D.build([health, mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs - 500, 97), book(tk, sigObs + 200, 95)]); const m = d.markets[0];
  assert.strictEqual(d.clock.medianOffsetMs, OFF);
  const p = m.pricing.qualified; assert.ok(p.clock.verified && p.clock.offsetLoMs <= OFF && p.clock.offsetHiMs >= OFF, JSON.stringify(p.clock));
  assert.strictEqual(p.atSignal.bestAskCents, 97, JSON.stringify(p.atSignal)); assert.strictEqual(p.afterSignal.bestAskCents, 95); assert.ok(p.atSignal.ageMs >= 0);
});
t('Test 4: a book older than 3 s, or none at all, gives "unavailable" (no price is invented)', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('DOWN') : L('DOWN')), sigObs = C - 100e3 + 250;
  assert.ok(/old/.test(one([health, mk(tk, 'no'), { kind: 'pr.predictions', rows }, book(tk, sigObs - 5000, 3)]).pricing.qualified.atSignal.unavailable));
  assert.ok(/no book/.test(one([health, mk(tk, 'no'), { kind: 'pr.predictions', rows }]).pricing.qualified.atSignal.unavailable));
});
t('Test 4: a book received inside the clock uncertainty of the signal is not used', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('UP') : L('UP')), sigObs = C - 100e3 + 250;
  assert.ok(one([health, mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs - 2, 97)]).pricing.qualified.atSignal.unavailable);
});
t('review: a production clock step (nearby clock samples disagree) leaves the signal unpriced, never priced from a later book', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('UP') : L('UP')), sigObs = C - 100e3 + 250;
  const m = one([hAt(C - 400e3, OFF), hAt(C - 300e3, OFF + 10000), mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs + 9500, 99), book(tk, sigObs - 800, 90)]);
  assert.ok(/clock unverified/.test(m.pricing.qualified.atSignal.unavailable), JSON.stringify(m.pricing.qualified.atSignal));
});
t('review: no clock sample within 15 min of a signal = unpriced (clock unverified)', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('UP') : L('UP')), sigObs = C - 100e3 + 250;
  const m = one([hAt(C - 3600e3), mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs - 500, 97)]);
  assert.ok(/no clock sample/.test(m.pricing.qualified.atSignal.unavailable));
});
t('Test 4: theoretical sizes walk the recorded depth and say when the book runs out', () => {
  const th = F.theoretical([[96, 100], [97, 2000]], [100, 75000], 0.07, true).sizes;
  assert.strictEqual(th[0].fullyFillable, true); assert.strictEqual(th[1].fullyFillable, false); assert.strictEqual(th[1].stoppedBy, 'book');
  assert.ok(th[1].capitalUsd < 2100 && th[1].contracts === 2100);
});
t('review: the fee multiplier is validated like production (null or out of range -> 0.07, labelled ASSUMED); a later fee record is labelled', () => {
  const tk = tkn(), rows = rowsFor(tk, s => s > 100 ? H('UP') : L('UP')), sigObs = C - 100e3 + 250;
  let m = one([health, mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs - 500, 97), { kind: 'k.series', tRecv: C - 500e3, series: { fee_type: 'quadratic', fee_multiplier: null } }]);
  assert.ok(/ASSUMED/.test(m.pricing.qualified.fee.source)); assert.strictEqual(m.pricing.qualified.fee.rate, 0.07);
  m = one([health, mk(tk), { kind: 'pr.predictions', rows }, book(tk, sigObs - 500, 97), { kind: 'k.series', tRecv: C + 30 * 864e5, series: { fee_type: 'quadratic', fee_multiplier: 2 } }]);
  assert.ok(/after the signal/.test(m.pricing.qualified.fee.source)); assert.strictEqual(m.pricing.qualified.fee.rate, 0.14);
});

/* ================= classification ================= */
const cls = (fn, result, extraRaw = []) => { const tk = tkn(); return one([health, mk(tk, result), { kind: 'pr.predictions', rows: rowsFor(tk, fn) }, ...extraRaw]); };
t('classification: continuous LOCKED to the close and won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : L('UP'), 'yes').qualified.category, 'continuous-won'));
t('classification: LOCKED, unlocked, re-locked, won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? H('UP') : L('UP'), 'yes').qualified.category, 'unlocked-won'));
t('classification: reversal warning after LOCKED, won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? { state: 'REVERSAL WARNING', side: 'UP', pFlip: 0.2 } : L('UP'), 'yes').qualified.category, 'warned-won'));
t('classification: direction changed after LOCKED (first call won anyway)', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? L('DOWN') : L('UP'), 'yes').qualified.category, 'changed-direction-won'));
t('classification: wrong prediction', () => { const m = cls(s => s > 150 ? H('UP') : L('UP'), 'no'); assert.strictEqual(m.qualified.category, 'wrong'); assert.strictEqual(m.qualified.won, false); });
t('classification: LOCKED above 0.2 % is a LOCKED signal but not a qualifying one', () => { const m = cls(s => s > 150 ? H('UP') : L('UP', 0.004), 'yes'); assert.ok(m.signal && !m.qualified); });
t('timing: state at T-120 and "qualified anywhere in the last 120 s"', () => { const m = cls(s => s > 110 ? H('UP') : L('UP'), 'yes'); assert.strictEqual(m.atT120.state, 'HIGH CONFIDENCE'); assert.strictEqual(m.lockedAnywhereInLast120, true); assert.ok(m.qualified.tau <= 110); });
t('review: a missing second AFTER the signal (even the last one) means the win is not clean ("won-partially-observed")', () => {
  assert.strictEqual(cls(s => s === 1 ? null : s > 150 ? H('UP') : L('UP'), 'yes').qualified.category, 'won-partially-observed');
  assert.strictEqual(cls(s => (s > 40 && s < 44) ? null : s > 150 ? H('UP') : L('UP'), 'yes').qualified.category, 'won-partially-observed');
});
t('review: a production restart inside the final 300 s makes the window partial and the win not clean', () => {
  const m = cls(s => s > 150 ? H('UP') : L('UP'), 'yes', [{ kind: 'pr.restart', at: C - 40e3, approxRestartAt: C - 47e3 }]);
  assert.strictEqual(m.coverage.status, 'partial'); assert.strictEqual(m.coverage.pinradarRestartInFinal300s, true); assert.strictEqual(m.qualified.category, 'won-partially-observed');
});
t('review: seconds remaining going UP (a production clock step) is an anomaly: the window is partial', () => {
  const tk = tkn(); const rows = rowsFor(tk, s => s > 150 ? H('UP') : L('UP'));
  rows.push({ ts: C + OFF - 95e3 - 20300, ticker: tk, tau: 95.05 + 20.3, strike: 80000, state: 'REVERSAL WARNING', side: 'UP', pFlip: 0.3 });
  const m = one([health, mk(tk), { kind: 'pr.predictions', rows }]);
  assert.strictEqual(m.coverage.status, 'partial', JSON.stringify(m.coverage)); assert.ok(m.coverage.anomalies.length);
});

/* ================= reports ================= */
t('review: a WRONG call always counts, even in a partially observed window', () => {
  const ms = []; for (let i = 0; i < 9; i++) ms.push(cls(s => s > 150 ? H('UP') : L('UP'), 'yes'));
  ms.push(cls(s => (s > 283 && s < 291) ? null : s > 100 ? H('UP') : L('UP'), 'no'));
  const s = R.summarize(ms);
  assert.strictEqual(s.qualified.n, 10); assert.strictEqual(s.qualified.wrong, 1); assert.strictEqual(s.wrongCalls.length, 1); assert.strictEqual(s.qualified.accuracyPct, 90);
  assert.strictEqual(s.qualifiedCompleteWindows.n, 9);
});
t('timing: a signal after unobserved earlier seconds is not "timing certain" and stays out of the timing table', () => {
  const m = cls(s => (s > 250 && s < 260) ? null : s > 100 ? H('UP') : L('UP'), 'yes'); assert.strictEqual(m.qualified.timingCertain, false);
  const s = R.summarize([m]); assert.strictEqual(s.byFirstQualifiedTime.timingUncertain, 1); assert.strictEqual(s.qualified.n, 1);
});
t('review: every quarter-hour window with no record at all is counted as unobserved', () => {
  const a = tkn(), b = tkn();
  const d = D.build([health, mk(a, 'yes', C), { kind: 'pr.predictions', rows: rowsFor(a, s => L('UP'), C) }, mk(b, 'yes', C + 1800e3), { kind: 'pr.predictions', rows: rowsFor(b, s => L('UP'), C + 1800e3) }]);
  const s = R.summarize(d.markets); assert.strictEqual(s.coverage.windowsExpected, 3); assert.strictEqual(s.coverage.windowsWithNoRecord, 1);
});
t('review: each market carries the production build and threshold in force; the report splits by them', () => {
  const m = cls(s => s > 150 ? H('UP') : L('UP'), 'yes'); assert.strictEqual(m.production.build, 'b1'); assert.strictEqual(m.production.lockMaxFlip, 0.005);
  assert.ok(R.summarize([m]).byProductionBuild['b1 / LOCK_MAX_FLIP 0.005']);
});

/* ================= missing data (Test 9) ================= */
t('Test 9: duplicate and out-of-order rows (overlapping pulls) are counted once', () => {
  const tk = tkn(), rows = rowsFor(tk, s => L('UP'));
  const m = one([health, mk(tk), { kind: 'pr.predictions', rows: rows.slice(0, 200).reverse() }, { kind: 'pr.predictions', rows: rows.slice(150) }]);
  assert.strictEqual(m.coverage.secondsObserved, 300); assert.strictEqual(m.coverage.status, 'complete');
});
t('Test 9: no recorded result -> outcome unknown, excluded from accuracy (never assumed a win)', () => {
  const tk = tkn(), m = one([health, { kind: 'pr.predictions', rows: rowsFor(tk, s => L('UP')) }]);
  assert.strictEqual(m.qualified.category, 'outcome-unknown'); assert.strictEqual(R.summarize([m]).qualified.n, 0);
});
t('Test 9: an unobserved market is reported as unobserved, with no signal', () => { const m = one([health, mk(tkn())]); assert.strictEqual(m.coverage.status, 'unobserved'); assert.strictEqual(m.signal, null); });
t('review: failed book requests are counted as failures, not as snapshots', () => {
  const tk = tkn(), raw = [health, mk(tk), { kind: 'pr.predictions', rows: rowsFor(tk, s => L('UP')) }];
  for (let i = 0; i < 20; i++) raw.push({ kind: 'k.book', ticker: tk, tSent: C - 100e3 + i * 1000, tRecv: C - 100e3 + i * 1000 + 30, status: 429, book: null });
  const m = one(raw); assert.strictEqual(m.coverage.books.usableSnapshotsInFinal300s, 0); assert.strictEqual(m.coverage.books.failedRequests, 20);
});

/* ================= collectors (fake HTTP) ================= */
const fakeHttp = (route) => { const calls = []; let clock = 1e12; return { calls, get: async (url) => { calls.push(url); const u = new URL(url); clock += 1000; const r = route(u, calls.length) || { ok: false, status: 404, text: '' }; return { tSent: clock - 20, tRecv: clock, date: null, bytes: (r.text || '').length, ...r }; } }; };
t('review: /predictions is requested with a 120 s overlap; a non-integer ts never becomes the cursor', async () => {
  const P0 = 1.7e12;
  const http = fakeHttp(u => u.pathname === '/predictions' ? { ok: true, status: 200, text: [{ ts: '9&ticker=X', ticker: 'KXBTC15M-A' }, { ts: P0 + 5000, ticker: 'KXBTC15M-A' }].map(x => JSON.stringify(x)).join('\n') } : null);
  const P = pinradarSource({ base: 'https://pr', http, emit: () => { }, state: { predTs: P0 } });
  await P.step(Date.now());
  assert.ok(http.calls.some(c => c.includes('/predictions?since=' + (P0 - 120e3) + '&')), http.calls.join(' '));
  assert.strictEqual(P.state.predTs, P0 + 5000);
});
t('review: after an outage (a full page), every market that closed in the gap is listed from Kalshi and fetched by ticker', async () => {
  const P0 = 1.7e12; const page = Array.from({ length: 2000 }, (_, i) => JSON.stringify({ ts: P0 + 1e6 + i, ticker: 'KXBTC15M-Z' })).join('\n');
  const http = fakeHttp(u => u.pathname === '/predictions' ? { ok: true, status: 200, text: u.searchParams.get('ticker') ? '' : page } : null);
  let asked = null; const P = pinradarSource({ base: 'https://pr', http, emit: () => { }, state: { predTs: P0 }, listTickers: async (a, b) => { asked = [a, b]; return ['KXBTC15M-A', 'KXBTC15M-B'] } });
  await P.step(Date.now());
  assert.ok(asked && asked[0] === P0 - 120e3);
  assert.deepStrictEqual(http.calls.filter(c => /ticker=/.test(c)).map(c => new URL(c).searchParams.get('ticker')), ['KXBTC15M-A', 'KXBTC15M-B']);
});
t('review: a new production ledger chain (restart without a ledger file) is detected and pulled from seq 1; dropped entries are recorded as a gap', async () => {
  const em = []; const rows = Array.from({ length: 10 }, (_, i) => JSON.stringify({ seq: i + 1, hash: 'x' + i })).join('\n');
  const http = fakeHttp(u => u.pathname !== '/ledger' ? null : u.searchParams.get('format') ? { ok: true, status: 200, text: u.searchParams.get('since') === '0' ? rows : '' } : { ok: true, status: 200, text: JSON.stringify({ chainId: 'new', seq: 10, inMemoryFrom: 1, rows: [] }) });
  const P = pinradarSource({ base: 'https://pr', http, emit: o => em.push(o), state: { chainId: 'old', ledgerSeq: 500 } });
  await P.step(Date.now());
  assert.ok(em.some(e => e.kind === 'pr.ledger.newchain')); assert.strictEqual(P.state.ledgerSeq, 10);
  const em2 = []; const http2 = fakeHttp(u => u.pathname !== '/ledger' ? null : u.searchParams.get('format') ? { ok: true, status: 200, text: '' } : { ok: true, status: 200, text: JSON.stringify({ chainId: 'c', seq: 400, inMemoryFrom: 300, rows: [] }) });
  const P2 = pinradarSource({ base: 'https://pr', http: http2, emit: o => em2.push(o), state: { chainId: 'c', ledgerSeq: 100 } });
  await P2.step(Date.now());
  const g = em2.find(e => e.kind === 'pr.ledger.gap'); assert.ok(g && g.from === 101 && g.to === 299); assert.strictEqual(P2.state.ledgerSeq, 299);
});
t('Test 9: a production restart is detected from its uptime', async () => {
  const em = []; let n = 0; const http = fakeHttp(u => u.pathname === '/health' ? { ok: true, status: 200, text: JSON.stringify({ uptimeSec: ++n === 1 ? 5000 : 12, build: 'b1', ts: 1 }) } : null);
  const P = pinradarSource({ base: 'https://pr', http, emit: o => em.push(o) });
  await P.step(1e12); P.state.due = {}; await P.step(1e12 + 60e3);
  assert.ok(em.some(e => e.kind === 'pr.restart'));
});
t('review: the first book of the final 300 s is taken at its start; results are still polled 7 h after the close (flagged once)', async () => {
  const now = Date.now(), http = fakeHttp(u => /orderbook$/.test(u.pathname) ? { ok: true, status: 200, text: JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }) } : /\/markets\/KXBTC15M/.test(u.pathname) ? { ok: true, status: 200, text: JSON.stringify({ market: { status: 'closed', result: '' } }) } : null);
  const em = [];
  const K = kalshiSource({ base: 'https://k/trade-api/v2', http, emit: o => em.push(o), state: { markets: { 'KXBTC15M-A': { ticker: 'KXBTC15M-A', closeMs: now + 305e3 }, 'KXBTC15M-B': { ticker: 'KXBTC15M-B', closeMs: now - 7 * 3600e3 } } } });
  K.state.due.discover = now + 1e9; K.state.due.series = now + 1e9;
  await K.step(now);
  assert.strictEqual(K.state.due['b:KXBTC15M-A'], now + 305e3 - 300e3);
  assert.ok(http.calls.some(c => /markets\/KXBTC15M-B$/.test(new URL(c).pathname))); assert.strictEqual(em.filter(e => e.kind === 'k.result.missing').length, 1);
  assert.ok(K.state.markets['KXBTC15M-B']);
});

/* ================= store: integrity and durability (Tests 7, 9) ================= */
t('Test 9 / 7: a torn final write is quarantined byte for byte; a corrupted record stops the store from opening', () => {
  const d = tmp(), { key: k } = symKey(); let s = ST.openStream(d, 'raw', k); s.append([{ a: 1 }, { a: 2 }, { a: 3 }]); s.close();
  const f = ST.segments(path.join(d, 'raw'))[0]; fs.appendFileSync(f, '{"s":4,"t":12');
  s = ST.openStream(d, 'raw', k); assert.ok(s.recovered && s.recovered.bytesQuarantined === 13); s.close();
  assert.strictEqual(fs.readFileSync(path.join(d, 'raw', 'quarantine', fs.readdirSync(path.join(d, 'raw', 'quarantine'))[0]), 'utf8'), '{"s":4,"t":12');
  assert.strictEqual(ST.verify(d, 'raw', k).ok, true);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); lines[lines.length - 1] = lines[lines.length - 1].replace('"h":"', '"h":"0'); fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.throws(() => ST.openStream(d, 'raw', k), /does not verify/);
});
t('review: reading enforces the chain: one deleted record stops readStream, and derive refuses to run', () => {
  const d = tmp(), { file, key } = symKey(); const s = ST.openStream(d, 'raw', key); for (let i = 0; i < 5; i++) s.append({ kind: 'x', i }); s.close();
  const f = ST.segments(path.join(d, 'raw'))[0]; const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); lines.splice(2, 1); fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.throws(() => [...ST.readStream(d, 'raw', key)], /sequence gap/);
  const r = cli(['derive', '--data', d, '--key', file]); assert.notStrictEqual(r.status, 0); assert.ok(/does not verify/.test(r.stderr), r.stderr);
});
t('review: a single writer per stream (a second writer is refused); a dead writer\'s lock is taken over and recorded', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key);
  assert.throws(() => ST.openStream(d, 'raw', key), /locked by another writer|already open for writing/); s.close();
  fs.writeFileSync(path.join(d, 'raw', '.writer.lock'), '999999@' + os.hostname());
  const s2 = ST.openStream(d, 'raw', key); assert.strictEqual(s2.staleLockTakenOver, true); s2.close();
  assert.ok([...ST.readStream(d, 'raw', key)].some(r => r.kind === 'store.recovered' && r.staleLockTakenOver));
});
t('review: a clock stepping back across UTC midnight cannot split the chain (segment names never go backwards)', () => {
  const d = tmp(), { key } = symKey(); let T = Date.UTC(2026, 9, 31, 0, 0, 10);
  let s = ST.openStream(d, 'raw', key, { now: () => T }); s.append({ a: 1 }); T = Date.UTC(2026, 9, 30, 23, 59, 50); s.append({ a: 2 }); s.close();
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'raw')).filter(f => f.endsWith('.jsonl')), ['2026-10-31.jsonl']);
  s = ST.openStream(d, 'raw', key, { now: () => T }); s.append({ a: 3 }); s.close();
  assert.strictEqual(ST.verify(d, 'raw', key).ok, true);
});
t('review: a truncated GCM tag is rejected (128-bit tags only)', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key); s.append({ a: 1 }); s.close();
  const f = ST.segments(path.join(d, 'raw'))[0]; const r = JSON.parse(fs.readFileSync(f, 'utf8').trim());
  r.g = Buffer.from(r.g, 'base64').subarray(0, 4).toString('base64'); r.h = ST.lineHash(r); fs.writeFileSync(f, JSON.stringify(r) + '\n');
  assert.strictEqual(ST.verify(d, 'raw', key).ok, false); assert.throws(() => [...ST.readStream(d, 'raw', key)]);
});

/* ================= security (Test 8) ================= */
t('Test 8: GET only, allowlisted read-only paths only, HTTPS only (loopback excepted)', async () => {
  const c = mkClient({ allow: PINRADAR_PATHS, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.strictEqual(typeof c.post, 'undefined');
  for (const p of ['/radar', '/pin', '/ledger/verify', '/selftest', '/kalshi-auth', '/health/../radar', '/tape']) await assert.rejects(c.get('https://x' + p), /allowlist/);
  await assert.rejects(c.get('http://pinradar.example/health'), /https required/);
  await assert.rejects(c.get('https://u:p@x/health'), /credentials/);
});
t('review: a redirect is refused, never followed (no path or host outside the allowlist can be reached)', async () => {
  const c = mkClient({ allow: PINRADAR_PATHS, fetchImpl: async (u, o) => { assert.strictEqual(o.redirect, 'manual'); return { status: 302, ok: false, type: 'basic', headers: { get: () => '/selftest' }, body: null }; } });
  const r = await c.get('https://x/health'); assert.strictEqual(r.ok, false); assert.ok(/redirect refused/.test(r.error));
});
t('review: an oversized response is cut while streaming (memory cannot be exhausted)', async () => {
  const chunk = new Uint8Array(1024).fill(65); let n = 0;
  const c = mkClient({ allow: PINRADAR_PATHS, maxBytes: 4096, fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => null }, body: { getReader: () => ({ read: async () => (++n > 100 ? { done: true } : { done: false, value: chunk }), cancel: async () => { } }) } }) });
  const r = await c.get('https://x/health'); assert.strictEqual(r.ok, false); assert.strictEqual(r.truncated, true); assert.ok(n < 10);
});
t('Test 8: the Kalshi client is limited to public market data (no portfolio, orders or account paths)', async () => {
  const c = mkClient({ allow: KALSHI_PATHS, fetchImpl: async () => { throw new Error('must not be called'); } });
  for (const p of ['/trade-api/v2/portfolio/balance', '/trade-api/v2/portfolio/orders', '/trade-api/v2/portfolio/positions', '/trade-api/v2/markets/OTHER-1']) await assert.rejects(c.get('https://k' + p), /allowlist/);
});
t('Test 8: a wrong key cannot read the data; segment files are private to the owner', () => {
  const d = tmp(), { key: k } = symKey(), { key: k2 } = symKey();
  const s = ST.openStream(d, 'raw', k); s.append({ secret: 'LOCKED UP 0.001' }); s.close();
  assert.strictEqual(ST.verify(d, 'raw', k2).ok, false); assert.throws(() => [...ST.readStream(d, 'raw', k2)]);
  const f = ST.segments(path.join(d, 'raw'))[0]; assert.ok(!/LOCKED/.test(fs.readFileSync(f, 'utf8'))); assert.strictEqual(fs.statSync(f).mode & 0o077, 0);
});
t('Test 8: the observer opens no network port and has no write path (static check of the shipped code)', () => {
  for (const f of ['observer.js', 'lib/http.js', 'lib/sources.js', 'lib/store.js', 'lib/derive.js', 'lib/fills.js', 'lib/report.js', 'lib/stats.js'])
    assert.ok(!/createServer|\.listen\(|method:\s*'(POST|PUT|DELETE|PATCH)'/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f);
});
t('review: key files: 600 mode required for secret keys; keygen never writes through a symlink; RSA keys need >= 3072 bits', () => {
  const d = tmp(), f = path.join(d, 'k.b64'); fs.writeFileSync(f, ST.newKey(), { mode: 0o644 }); fs.chmodSync(f, 0o644);
  assert.throws(() => ST.loadKey(f), /readable by group/);
  const link = path.join(d, 'link.b64'), target = path.join(d, 'target.b64'); fs.symlinkSync(target, link);
  assert.notStrictEqual(cli(['keygen', '--key', link]).status, 0); assert.ok(!fs.existsSync(target));
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); const pf = path.join(d, 'small.pem'); fs.writeFileSync(pf, publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => ST.loadKey(pf), /3072/);
});
t('review: run refuses a key inside the data directory, also when the data directory is reached through a symlink', () => {
  const d = tmp(), kf = path.join(d, 'k.b64'); fs.writeFileSync(kf, ST.newKey(), { mode: 0o600 });
  let r = cli(['run', '--data', d, '--key', kf, '--pinradar', 'http://127.0.0.1:9']); assert.ok(/outside the data directory/.test(r.stderr), r.stderr);
  const via = path.join(tmp(), 'via'); fs.symlinkSync(d, via);
  r = cli(['run', '--data', via, '--key', kf, '--pinradar', 'http://127.0.0.1:9']); assert.ok(/outside the data directory/.test(r.stderr), r.stderr);
});
t('Test 8: with only the public key the observer writes but cannot read; the private key reads; the chain verifies without any key', () => {
  const d = tmp(), kd = tmp(); assert.strictEqual(cli(['keypair', '--out', path.join(kd, 'owner')]).status, 0);
  const pub = ST.loadKey(path.join(kd, 'owner.public.pem')), priv = ST.loadKey(path.join(kd, 'owner.private.pem'));
  assert.strictEqual(fs.statSync(path.join(kd, 'owner.private.pem')).mode & 0o077, 0);
  let s = ST.openStream(d, 'raw', pub); s.append([{ a: 'LOCKED UP' }, { a: 2 }]); s.close();
  s = ST.openStream(d, 'raw', pub); s.append({ a: 3 }); s.close();
  assert.throws(() => [...ST.readStream(d, 'raw', pub)], /private key/);
  assert.deepStrictEqual([...ST.readStream(d, 'raw', priv)].map(x => x.a), ['LOCKED UP', 2, 3]);
  assert.strictEqual(ST.verify(d, 'raw').ok, true); assert.strictEqual(ST.verify(d, 'raw', priv).ok, true);
  assert.throws(() => ST.openStream(d, 'raw', priv), /public/);
  assert.ok(!/LOCKED/.test(fs.readFileSync(ST.segments(path.join(d, 'raw'))[0], 'utf8')));
});
t('review: a history rewritten with only the public key passes the chain check but FAILS the signed-checkpoint check', () => {
  const d = tmp(), kd = tmp(); cli(['keypair', '--out', path.join(kd, 'owner')]); cli(['signkey', '--out', path.join(kd, 'host')]);
  const pub = ST.loadKey(path.join(kd, 'owner.public.pem')), sk = crypto.createPrivateKey(fs.readFileSync(path.join(kd, 'host.sign.pem')));
  const canon = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  const signer = crypto.createHash('sha256').update(crypto.createPublicKey(sk).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  let raw = ST.openStream(d, 'raw', pub); raw.append({ kind: 'k.market', ticker: 'KXBTC15M-X', market: { result: 'no' } });
  const health = ST.openStream(d, 'health', pub);
  const body = { kind: 'obs.checkpoint', at: 1, version: 'v', heads: { raw: raw.head(), health: health.head() } };
  health.append({ ...body, sig: crypto.sign(null, Buffer.from(canon(body)), sk).toString('base64'), signer }); raw.close(); health.close();
  const args = ['verify', '--data', d, '--key', path.join(kd, 'owner.private.pem'), '--sign-pub', path.join(kd, 'host.sign.pub.pem')];
  assert.strictEqual(cli(args).status, 0, cli(args).stdout);
  fs.rmSync(path.join(d, 'raw'), { recursive: true });
  raw = ST.openStream(d, 'raw', pub); raw.append({ kind: 'k.market', ticker: 'KXBTC15M-X', market: { result: 'yes' } }); raw.close();
  const plain = cli(['verify', '--data', d]); assert.strictEqual(plain.status, 0); assert.ok(/NO checkpoint check/.test(plain.stdout));
  const r = cli(args); assert.notStrictEqual(r.status, 0); assert.ok(/not in the chain/.test(r.stdout), r.stdout);
});
t('review: anchors kept off the host detect a cut of the newest records', () => {
  const d = tmp(), kd = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key); for (let i = 0; i < 6; i++) s.append({ i }); s.close();
  const af = path.join(kd, 'anchors.ndjson'); assert.strictEqual(cli(['anchor', '--data', d, '--out', af]).status, 0);
  const f = ST.segments(path.join(d, 'raw'))[0]; const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(f, lines.slice(0, 4).join('\n') + '\n');
  assert.strictEqual(cli(['verify', '--data', d]).status, 0, 'a cut tail is still a valid shorter chain');
  const r = cli(['verify', '--data', d, '--anchors', af]); assert.notStrictEqual(r.status, 0); assert.ok(/missing/.test(r.stdout));
});

/* ================= backup and restore (Test 7) ================= */
t('Test 7: backup copies the encrypted segments with a manifest; restore-test verifies them; a damaged backup fails; backups are audited', () => {
  const d = tmp(), b = tmp(), { file: kf, key: k } = symKey();
  const s = ST.openStream(d, 'raw', k); for (let i = 0; i < 50; i++) s.append({ i }); s.close();
  let r = cli(['backup', '--data', d, '--to', b, '--key', kf]); assert.strictEqual(r.status, 0, r.stderr);
  r = cli(['restore-test', '--from', b, '--key', kf]); assert.strictEqual(r.status, 0, r.stdout + r.stderr); assert.strictEqual(JSON.parse(r.stdout).verify.raw.records, 50);
  const seg = path.join(b, 'raw', fs.readdirSync(path.join(b, 'raw')).find(f => f.endsWith('.jsonl'))); fs.appendFileSync(seg, 'x');
  assert.notStrictEqual(cli(['restore-test', '--from', b, '--key', kf]).status, 0);
  assert.ok([...ST.readStream(d, 'audit', k)].some(x => /^backup/.test(x.command)));
});
t('review: backup is append-only: a source cut after a backup is refused, and the good backup is kept', () => {
  const d = tmp(), b = tmp(), { file: kf, key: k } = symKey();
  const s = ST.openStream(d, 'raw', k); for (let i = 0; i < 10; i++) s.append({ i }); s.close();
  assert.strictEqual(cli(['backup', '--data', d, '--to', b, '--key', kf]).status, 0);
  const f = ST.segments(path.join(d, 'raw'))[0]; const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); fs.writeFileSync(f, lines.slice(0, 6).join('\n') + '\n');
  const before = fs.readFileSync(path.join(b, 'raw', path.basename(f)), 'utf8');
  const r = cli(['backup', '--data', d, '--to', b, '--key', kf]); assert.notStrictEqual(r.status, 0); assert.ok(/LONGER than the source/.test(r.stderr), r.stderr);
  assert.strictEqual(fs.readFileSync(path.join(b, 'raw', path.basename(f)), 'utf8'), before);
});
t('review: restore-test fails when a backup was rewritten after an earlier backup (heads of earlier manifests are checked)', () => {
  const d = tmp(), b = tmp(), { file: kf, key: k } = symKey();
  let s = ST.openStream(d, 'raw', k); for (let i = 0; i < 5; i++) s.append({ i }); s.close();
  assert.strictEqual(cli(['backup', '--data', d, '--to', b, '--key', kf]).status, 0);
  /* an attacker with the backup rewrites it with a different valid chain and a fresh manifest */
  const d2 = tmp(); s = ST.openStream(d2, 'raw', k); for (let i = 0; i < 7; i++) s.append({ forged: i }); s.close();
  const seg = ST.segments(path.join(d2, 'raw'))[0], rel = 'raw/' + path.basename(seg);
  fs.copyFileSync(seg, path.join(b, rel)); const man = JSON.parse(fs.readFileSync(path.join(b, 'MANIFEST.json'), 'utf8'));
  man.files = { [rel]: crypto.createHash('sha256').update(fs.readFileSync(seg)).digest('hex') }; man.heads = { raw: { s: ST.verify(d2, 'raw').seq, h: ST.verify(d2, 'raw').head } };
  fs.writeFileSync(path.join(b, 'MANIFEST.json'), JSON.stringify(man));
  const r = cli(['restore-test', '--from', b, '--key', kf]); assert.notStrictEqual(r.status, 0); assert.ok(/differs|missing/.test(r.stdout), r.stdout);
});
t('review: restore-test refuses manifest paths that escape the restore directory, and an empty manifest', () => {
  const b = tmp(), { file: kf } = symKey(); const evil = path.join(os.tmpdir(), 'obs_evil_' + process.pid + '.txt');
  fs.writeFileSync(path.join(b, 'MANIFEST.json'), JSON.stringify({ files: { ['../' + path.basename(evil)]: 'x' } }));
  assert.notStrictEqual(cli(['restore-test', '--from', b, '--key', kf]).status, 0); assert.ok(!fs.existsSync(evil));
  fs.writeFileSync(path.join(b, 'MANIFEST.json'), JSON.stringify({ files: {} }));
  assert.notStrictEqual(cli(['restore-test', '--from', b, '--key', kf]).status, 0);
});
t('review: if the audit trail cannot be written, export refuses to run (and writes nothing)', () => {
  const d = tmp(), { file: kf, key: k } = symKey(); let s = ST.openStream(d, 'raw', k); s.append({ a: 1 }); s.close();
  s = ST.openStream(d, 'audit', k); s.append({ kind: 'audit' }); s.close();
  const f = ST.segments(path.join(d, 'audit'))[0]; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"h":"', '"h":"0'));
  const out = path.join(tmp(), 'exp'); const r = cli(['export', '--data', d, '--key', kf, '--out', out]);
  assert.notStrictEqual(r.status, 0); assert.ok(/audit trail/.test(r.stderr), r.stderr); assert.ok(!fs.existsSync(out));
});
t('review: plaintext outputs never overwrite: export needs a new or empty directory, report --out a new file', () => {
  const d = tmp(), { file: kf, key: k } = symKey(); const s = ST.openStream(d, 'raw', k); s.append({ kind: 'x' }); s.close();
  const full = tmp(); fs.writeFileSync(path.join(full, 'raw.ndjson'), 'old', { mode: 0o666 });
  assert.notStrictEqual(cli(['export', '--data', d, '--key', kf, '--out', full]).status, 0);
  const existing = path.join(tmp(), 'r.json'); fs.writeFileSync(existing, 'x');
  assert.notStrictEqual(cli(['report', '--data', d, '--key', kf, '--out', existing]).status, 0); assert.strictEqual(fs.readFileSync(existing, 'utf8'), 'x');
});
t('review: implausible saved cursors are reset and recorded; an unclean stop is recorded as a gap; state.json is private', async () => {
  const d = tmp(), { file: kf, key: k } = symKey();
  fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify({ pinradar: { predTs: Date.now() + 1e10, ledgerSeq: '9#', due: { health: Date.now() + 1e10 } }, lastBeat: Date.now() - 10000, cleanStop: false }));
  const p = spawn(process.execPath, [OBS, 'run', '--data', d, '--key', kf, '--pinradar', 'http://127.0.0.1:9', '--kalshi', 'http://127.0.0.1:9/trade-api/v2']);
  await new Promise(r => setTimeout(r, 3000)); p.kill('SIGTERM'); await new Promise(r => p.on('exit', r));
  const h = [...ST.readStream(d, 'health', k)];
  const st = h.find(x => x.kind === 'obs.start'); assert.ok(st && st.sanitised.includes('predTs reset') && st.sanitised.includes('ledgerSeq reset') && st.sanitised.some(n => /due\.health/.test(n)), JSON.stringify(st && st.sanitised));
  assert.ok(h.some(x => x.kind === 'obs.gap' && /not running/.test(x.reason)));
  assert.strictEqual(fs.statSync(path.join(d, 'state.json')).mode & 0o077, 0);
});

t('window log: one line per settled window keeps lost LOCKED, reversal warning, direction reversal and a WRONG outcome apart, and never calls an unobserved window "no signal"', () => {
  const { windowLogger } = require('../lib/windowlog'); const out = []; const wl = windowLogger({ log: x => out.push(x), delayMs: 0 });
  const tk = tkn(), rows = rowsFor(tk, s => s > 150 ? H('UP') : (s > 80 && s < 90) ? { state: 'REVERSAL WARNING', side: 'UP', pFlip: 0.03 } : (s > 40 && s < 50) ? L('DOWN') : L('UP'));
  wl.tap(health); wl.tap({ kind: 'pr.predictions', rows }); wl.tap(book(tk, C - 150e3 + 100, 97)); wl.tap(mk(tk, 'no')); wl.summarize(tk);
  const l1 = out.find(x => x.includes(tk)); assert.ok(/coverage=complete 300\/300s/.test(l1) && /tau=149\.8s UP/.test(l1) && /ask=97c/.test(l1), l1);
  assert.ok(/lostLocked=true reversalWarning=true directionReversed=true/.test(l1) && /settlement=no \(DOWN\)/.test(l1) && /signal WRONG \[wrong\]/.test(l1), l1);
  const t2 = tkn(); wl.tap(mk(t2, 'yes')); wl.summarize(t2); const l2 = out.find(x => x.includes(t2)); assert.ok(/UNOBSERVED/.test(l2) && /none seen \(not fully observed/.test(l2), l2);
  const t3 = tkn(); wl.tap({ kind: 'pr.predictions', rows: rowsFor(t3, () => H('UP')) }); wl.tap(mk(t3, 'yes')); wl.summarize(t3); const l3 = out.find(x => x.includes(t3)); assert.ok(/qualifying=NONE \(fully observed/.test(l3), l3);
});

(async () => {
  await Promise.all(pending);
  let n = 0; for (const [p, s] of results) { console.log((p ? 'ok   ' : 'FAIL ') + s); if (p) n++; }
  console.log(`unit: ${n}/${results.length} passed`);
  process.exit(n === results.length ? 0 : 1);
})();
