/* Unit tests for Tests 4 (pricing, no look-ahead), 7 (durability: torn writes, backup, restore), 8 (security),
   9 (missing data: outages, stale feeds, missing snapshots, duplicates, corrupted records) and the signal classifications. */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const ST = require('../lib/store'), D = require('../lib/derive'), F = require('../lib/fills'), R = require('../lib/report');
const { mkClient, PINRADAR_PATHS, KALSHI_PATHS } = require('../lib/http');
const ROOT = path.join(__dirname, '..');
const results = [], pending = [];
const t = (n, f) => pending.push((async () => { try { await f(); results.push([true, n]); } catch (e) { results.push([false, n + ' :: ' + e.message]); } })());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obs_unit_'));

/* a synthetic market: close at C (observer clock); Pin Radar clock = observer + OFF */
const C = Date.UTC(2026, 9, 30, 12, 0, 0), OFF = 1000;
const mk = (tk, result = 'yes', extra = {}) => ({ kind: 'k.market', ticker: tk, tRecv: C + 10e3, market: { ticker: tk, open_time: new Date(C - 900e3).toISOString(), close_time: new Date(C).toISOString(),
  floor_strike: 80000, status: 'finalized', result, expiration_value: '80010.5', settlement_ts: new Date(C + 2500).toISOString(), rules_primary: 'rules', ...extra } });
const rowsFor = (tk, fn) => { const out = []; for (let s = 300; s >= 1; s--) { const st = fn(s); if (st) out.push({ ts: C + OFF - s * 1000 + 250, ticker: tk, tau: s - 0.25, strike: 80000, ...st }); } return out; };
const health = { kind: 'pr.health', tSent: C - 600e3, tRecv: C - 600e3 + 20, body: { ts: C - 600e3 + 10 + OFF, tiers: { lockMaxFlip: 0.005 }, build: 'b1', version: 'pin-radar-2.8' } };
const book = (tk, tRecv, yesAsk, size = 500) => ({ kind: 'k.book', ticker: tk, tSent: tRecv - 30, tRecv, hash: 'h' + tRecv, book: { orderbook_fp: { no_dollars: [[((100 - yesAsk) / 100).toFixed(4), String(size)]], yes_dollars: [['0.0100', '100']] } } });
const L = (side, pFlip = 0.001) => ({ state: 'LOCKED', side, pFlip, pFlipCons: pFlip * 2, ask: 97 });
const H = side => ({ state: 'HIGH CONFIDENCE', side, pFlip: 0.02 });

/* ---- Test 4: pricing ---- */
t('Test 4: the price at a signal is the newest book RECEIVED before the signal (clock offset applied), never a later one', () => {
  const rows = rowsFor('KXBTC15M-A', s => s > 100 ? H('UP') : L('UP'));
  const sigObs = C - 100e3 + 250;                                    // first LOCKED at tau 99.75 on the observer's clock
  const raw = [health, mk('KXBTC15M-A'), { kind: 'pr.predictions', rows }, book('KXBTC15M-A', sigObs - 500, 97), book('KXBTC15M-A', sigObs + 200, 95)];
  const d = D.build(raw); const m = d.markets[0];
  assert.strictEqual(d.clock.offsetMs, OFF);
  assert.strictEqual(m.pricing.qualified.atSignal.bestAskCents, 97, JSON.stringify(m.pricing.qualified.atSignal));
  assert.strictEqual(m.pricing.qualified.afterSignal.bestAskCents, 95);
  assert.ok(m.pricing.qualified.atSignal.ageMs >= 0);
});
t('Test 4: a book older than 3 s, or none at all, gives "unavailable" (no price is invented)', () => {
  const rows = rowsFor('KXBTC15M-B', s => s > 100 ? H('DOWN') : L('DOWN'));
  const sigObs = C - 100e3 + 250;
  let m = D.build([health, mk('KXBTC15M-B', 'no'), { kind: 'pr.predictions', rows }, book('KXBTC15M-B', sigObs - 5000, 3)]).markets[0];
  assert.ok(/old/.test(m.pricing.qualified.atSignal.unavailable), JSON.stringify(m.pricing.qualified.atSignal));
  m = D.build([health, mk('KXBTC15M-B', 'no'), { kind: 'pr.predictions', rows }]).markets[0];
  assert.ok(/no book/.test(m.pricing.qualified.atSignal.unavailable));
});
t('Test 4: a book received within the clock uncertainty of the signal is not used', () => {
  const rows = rowsFor('KXBTC15M-U', s => s > 100 ? H('UP') : L('UP'));
  const sigObs = C - 100e3 + 250;
  const m = D.build([health, mk('KXBTC15M-U'), { kind: 'pr.predictions', rows }, book('KXBTC15M-U', sigObs - 2, 97)]).markets[0];
  assert.ok(m.pricing.qualified.atSignal.unavailable, 'a book 2 ms before the signal is inside the ~11 ms clock uncertainty');
});
t('Test 4: theoretical sizes walk the recorded depth and say when the book runs out', () => {
  const asks = [[96, 100], [97, 2000]];
  const th = F.theoretical(asks, [100, 75000], 0.07, true).sizes;
  assert.strictEqual(th[0].fullyFillable, true); assert.strictEqual(th[1].fullyFillable, false); assert.strictEqual(th[1].stoppedBy, 'book');
  assert.ok(th[1].capitalUsd < 2100 && th[1].contracts === 2100);
});

/* ---- signal classification (the five cases the evidence must keep apart) ---- */
const cls = (fn, result) => { const tk = 'KXBTC15M-' + Math.random().toString(36).slice(2, 7).toUpperCase(); return D.build([health, mk(tk, result), { kind: 'pr.predictions', rows: rowsFor(tk, fn) }]).markets[0]; };
t('classification: continuous LOCKED to the close and won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : L('UP'), 'yes').qualified.category, 'continuous-won'));
t('classification: LOCKED, unlocked, re-locked, won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? H('UP') : L('UP'), 'yes').qualified.category, 'unlocked-won'));
t('classification: reversal warning after LOCKED, won', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? { state: 'REVERSAL WARNING', side: 'UP', pFlip: 0.2 } : L('UP'), 'yes').qualified.category, 'warned-won'));
t('classification: direction changed after LOCKED (first call won anyway)', () => assert.strictEqual(cls(s => s > 150 ? H('UP') : (s > 80 && s < 90) ? L('DOWN') : L('UP'), 'yes').qualified.category, 'changed-direction-won'));
t('classification: wrong prediction', () => { const m = cls(s => s > 150 ? H('UP') : L('UP'), 'no'); assert.strictEqual(m.qualified.category, 'wrong'); assert.strictEqual(m.qualified.won, false); });
t('classification: LOCKED above 0.2 % is a LOCKED signal but not a qualifying one', () => { const m = cls(s => s > 150 ? H('UP') : L('UP', 0.004), 'yes'); assert.ok(m.signal && !m.qualified); });
t('timing: state at T-120 and "qualified anywhere in the last 120 s"', () => { const m = cls(s => s > 110 ? H('UP') : L('UP'), 'yes'); assert.strictEqual(m.atT120.state, 'HIGH CONFIDENCE'); assert.strictEqual(m.lockedAnywhereInLast120, true); assert.ok(m.qualified.tau <= 110); });

/* ---- Test 9: missing data ---- */
t('Test 9: duplicate and out-of-order rows (overlapping pulls) are counted once', () => {
  const tk = 'KXBTC15M-DUP', rows = rowsFor(tk, s => L('UP'));
  const m = D.build([health, mk(tk), { kind: 'pr.predictions', rows: rows.slice(0, 200).reverse() }, { kind: 'pr.predictions', rows: rows.slice(150) }]).markets[0];
  assert.strictEqual(m.coverage.secondsObserved, 299); assert.strictEqual(m.coverage.status, 'complete');
});
t('Test 9: a hole in Pin Radar\'s rows (its restart or a stale feed) makes the window partial and keeps it out of accuracy', () => {
  const tk = 'KXBTC15M-GAP', rows = rowsFor(tk, s => (s < 160 && s > 140) ? null : L('UP'));
  const raw = [health, mk(tk, 'no'), { kind: 'pr.predictions', rows }, { kind: 'pr.restart', at: C - 150e3 }];
  const m = D.build(raw).markets[0];
  assert.strictEqual(m.coverage.status, 'partial'); assert.strictEqual(m.coverage.pinradarRestartNear, true);
  const s = R.summarize([m]); assert.strictEqual(s.qualified.n, 0, 'a partially observed window must not enter the accuracy figures');
});
t('Test 9: no recorded result -> outcome unknown, excluded from accuracy (never assumed a win)', () => {
  const tk = 'KXBTC15M-NORES', rows = rowsFor(tk, s => L('UP'));
  const m = D.build([health, { kind: 'pr.predictions', rows }]).markets[0];
  assert.strictEqual(m.qualified.category, 'outcome-unknown'); assert.strictEqual(R.summarize([m]).qualified.n, 0);
});
t('Test 9: an unobserved market is reported as unobserved, with no signal', () => {
  const m = D.build([health, mk('KXBTC15M-NONE')]).markets[0]; assert.strictEqual(m.coverage.status, 'unobserved'); assert.strictEqual(m.signal, null);
});
t('Test 9 / 7: a torn final write is quarantined byte for byte; a corrupted middle record stops the store from opening', () => {
  const d = tmp(), k = Buffer.from(ST.newKey(), 'base64'); const s = ST.openStream(d, 'raw', k); s.append([{ a: 1 }, { a: 2 }, { a: 3 }]);
  const f = ST.segments(path.join(d, 'raw'))[0]; fs.appendFileSync(f, '{"s":4,"t":12');
  const s2 = ST.openStream(d, 'raw', k); assert.ok(s2.recovered && s2.recovered.bytesQuarantined === 13);
  assert.strictEqual(fs.readFileSync(path.join(d, 'raw', 'quarantine', fs.readdirSync(path.join(d, 'raw', 'quarantine'))[0]), 'utf8'), '{"s":4,"t":12');
  assert.strictEqual(ST.verify(d, 'raw', k).ok, true);
  const lines = fs.readFileSync(f, 'utf8').split('\n'); lines[1] = lines[1].replace('"t":', '"t":1'); fs.writeFileSync(f, lines.join('\n'));
  assert.strictEqual(ST.verify(d, 'raw').ok, false);
  const lines2 = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); lines2[lines2.length - 1] = lines2[lines2.length - 1].replace('"h":"', '"h":"0'); fs.writeFileSync(f, lines2.join('\n') + '\n');
  assert.throws(() => ST.openStream(d, 'raw', k), /does not verify/);
});

/* ---- Test 8: security ---- */
t('Test 8: the client cannot send anything but GET, and only to allowlisted read-only paths', async () => {
  const c = mkClient({ allow: PINRADAR_PATHS, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.strictEqual(typeof c.post, 'undefined');
  for (const p of ['/radar', '/pin', '/ledger/verify', '/selftest', '/kalshi-auth', '/health/../radar', '/tape']) await assert.rejects(c.get('http://x' + p), /allowlist/);
});
t('Test 8: the Kalshi client is limited to public market data (no portfolio, orders or account paths)', async () => {
  const c = mkClient({ allow: KALSHI_PATHS, fetchImpl: async () => { throw new Error('must not be called'); } });
  for (const p of ['/trade-api/v2/portfolio/balance', '/trade-api/v2/portfolio/orders', '/trade-api/v2/portfolio/positions', '/trade-api/v2/markets/OTHER-1']) await assert.rejects(c.get('https://k' + p), /allowlist/);
});
t('Test 8: a wrong key cannot read the data (authenticated encryption)', () => {
  const d = tmp(), k = Buffer.from(ST.newKey(), 'base64'), k2 = Buffer.from(ST.newKey(), 'base64');
  ST.openStream(d, 'raw', k).append({ secret: 'LOCKED UP 0.001' });
  assert.strictEqual(ST.verify(d, 'raw', k2).ok, false); assert.throws(() => [...ST.readStream(d, 'raw', k2)]);
  assert.ok(!/LOCKED/.test(fs.readFileSync(ST.segments(path.join(d, 'raw'))[0], 'utf8')));
  assert.strictEqual(fs.statSync(ST.segments(path.join(d, 'raw'))[0]).mode & 0o077, 0, 'segment files are private to the owner');
});
t('Test 8: the observer opens no network port and has no write path (static check of the shipped code)', () => {
  for (const f of ['observer.js', 'lib/http.js', 'lib/sources.js', 'lib/store.js', 'lib/derive.js', 'lib/fills.js', 'lib/report.js', 'lib/stats.js']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/createServer|\.listen\(|method:\s*'(POST|PUT|DELETE|PATCH)'/.test(s), f);
  }
});
t('Test 8: keygen writes a 600-mode key and refuses to overwrite; run refuses a key stored inside the data directory', () => {
  const d = tmp(), kf = path.join(d, 'k.b64');
  spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'keygen', '--key', kf]);
  assert.strictEqual(fs.statSync(kf).mode & 0o777, 0o600);
  assert.notStrictEqual(spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'keygen', '--key', kf]).status, 0);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'run', '--data', d, '--key', kf, '--pinradar', 'http://127.0.0.1:9'], { encoding: 'utf8' });
  assert.ok(/outside the data directory/.test(r.stderr), r.stderr);
});

/* ---- Test 8: write-only public-key mode (the host cannot read what it records) ---- */
t('Test 8: with only the public key, the observer can write but not read; the private key reads; the chain verifies without any key', () => {
  const d = tmp(), kp = ST.newKeyPair(), kd = tmp();
  fs.writeFileSync(path.join(kd, 'pub.pem'), kp.pub); fs.writeFileSync(path.join(kd, 'priv.pem'), kp.priv);
  const pub = ST.loadKey(path.join(kd, 'pub.pem')), priv = ST.loadKey(path.join(kd, 'priv.pem'));
  assert.strictEqual(pub.type, 'pub'); assert.strictEqual(priv.type, 'priv');
  let s = ST.openStream(d, 'raw', pub); s.append([{ a: 'LOCKED UP' }, { a: 2 }]);
  s = ST.openStream(d, 'raw', pub); s.append({ a: 3 });                     // a restart: a new data key, wrapped again
  assert.throws(() => [...ST.readStream(d, 'raw', pub)], /private key/);
  assert.deepStrictEqual([...ST.readStream(d, 'raw', priv)].map(x => x.a), ['LOCKED UP', 2, 3]);
  assert.strictEqual(ST.verify(d, 'raw').ok, true); assert.strictEqual(ST.verify(d, 'raw', priv).ok, true);
  const other = ST.newKeyPair(); fs.writeFileSync(path.join(kd, 'o.pem'), other.priv);
  assert.strictEqual(ST.verify(d, 'raw', ST.loadKey(path.join(kd, 'o.pem'))).ok, false);
  assert.throws(() => ST.openStream(d, 'raw', priv), /public/);
  assert.ok(!/LOCKED/.test(fs.readFileSync(ST.segments(path.join(d, 'raw'))[0], 'utf8')));
});

/* ---- Test 7: backup and restore ---- */
t('Test 7: backup copies the encrypted segments with a checksum manifest; restore-test verifies them; a damaged backup fails', () => {
  const d = tmp(), b = tmp(), kf = path.join(tmp(), 'k.b64');
  spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'keygen', '--key', kf]);
  const k = ST.loadKey(kf); const s = ST.openStream(path.join(d), 'raw', k); for (let i = 0; i < 50; i++) s.append({ i });
  let r = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'backup', '--data', d, '--to', b, '--key', kf], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'restore-test', '--from', b, '--key', kf], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).verify.raw.records, 50);
  const seg = path.join(b, 'raw', fs.readdirSync(path.join(b, 'raw')).find(f => f.endsWith('.jsonl'))); fs.appendFileSync(seg, 'x');
  r = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'restore-test', '--from', b, '--key', kf], { encoding: 'utf8' }); assert.notStrictEqual(r.status, 0);
  const audit = [...ST.readStream(d, 'audit', k)].map(x => x.command); assert.ok(audit.some(c => /^backup/.test(c)), 'backups are written to the audit trail');
});

(async () => {
  await Promise.all(pending);
  let n = 0; for (const [p, s] of results) { console.log((p ? 'ok   ' : 'FAIL ') + s); if (p) n++; }
  console.log(`unit: ${n}/${results.length} passed`);
  process.exit(n === results.length ? 0 : 1);
})();
