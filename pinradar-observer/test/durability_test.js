/* Test 7 (durability): one or more tests for each finding of the durability review (F1-F9), run one after another
   (several start real observer processes, one under a file-size limit). Production is never contacted: the observers
   here poll a closed local port. */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), OBS = path.join(ROOT, 'observer.js');
const ST = require('../lib/store');
const { pinradarSource, kalshiSource } = require('../lib/sources');
const tests = [], results = [];
const t = (n, f) => tests.push([n, f]);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'obs_dur_'));
const symKey = () => { const d = tmp(), f = path.join(d, 'k.b64'); fs.writeFileSync(f, ST.newKey(), { mode: 0o600 }); return { file: f, key: ST.loadKey(f) }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cli = (args, env = {}) => spawnSync(process.execPath, [OBS, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 26 });
const DEAD = ['--pinradar', 'http://127.0.0.1:9', '--kalshi', 'http://127.0.0.1:9/trade-api/v2'];
const FAST = { OBSERVER_INTERVAL_SCALE: '0.02', OBSERVER_BEAT_MS: '1000' };
function startObs(d, kf, { env = {}, ulimitKB = null } = {}) {
  const args = [OBS, 'run', '--data', d, '--key', kf, ...DEAD], e = { ...process.env, ...FAST, ...env };
  const p = ulimitKB ? spawn('bash', ['-c', 'ulimit -f ' + ulimitKB + '; exec "$@"', 'sh', process.execPath, ...args], { env: e }) : spawn(process.execPath, args, { env: e });
  let err = ''; p.stderr.on('data', b => { err += b; }); p.stdout.on('data', () => { });
  const exit = new Promise(r => p.on('exit', (code, sig) => r(code == null ? sig : code)));
  return { p, err: () => err, exit };
}
const healthRecs = (d, key) => [...ST.readStream(d, 'health', key)];
const halfWriteThenFail = orig => function (target, data, ...rest) {
  if (typeof target === 'number') { const s = String(data); orig.call(fs, target, s.slice(0, Math.floor(s.length / 2))); throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }); }
  return orig.call(fs, target, data, ...rest);
};

/* ================= F1 (high): a failed or short write desynchronised the head from the disk ================= */
t('F1: a short write followed by an error is cut back; the head does not move; the next append continues the chain', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key);
  s.append([{ a: 1 }, { a: 2 }]);
  const f = ST.segments(path.join(d, 'raw'))[0], size0 = fs.statSync(f).size, head0 = s.head();
  const orig = fs.writeFileSync; fs.writeFileSync = halfWriteThenFail(orig);
  try { assert.throws(() => s.append([{ a: 3 }, { a: 4 }, { a: 5 }]), /ENOSPC/); } finally { fs.writeFileSync = orig; }
  assert.strictEqual(fs.statSync(f).size, size0, 'file cut back to its size before the batch'); assert.deepStrictEqual(s.head(), head0); assert.strictEqual(s.isBroken(), false);
  s.append([{ a: 3 }]); s.close();
  assert.deepStrictEqual([...ST.readStream(d, 'raw', key)].map(r => r.a), [1, 2, 3]); assert.strictEqual(ST.verify(d, 'raw', key).ok, true);
});
t('F1: if even the cut-back fails, the stream refuses further appends; reopening quarantines the fragment and the chain verifies', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key); s.append([{ a: 1 }, { a: 2 }]);
  const ow = fs.writeFileSync, ot = fs.ftruncateSync; fs.writeFileSync = halfWriteThenFail(ow); fs.ftruncateSync = () => { throw new Error('EIO: i/o error'); };
  try { assert.throws(() => s.append([{ a: 3 }, { a: 4 }, { a: 5 }]), /ENOSPC/); } finally { fs.writeFileSync = ow; fs.ftruncateSync = ot; }   // half of 3 lines: one whole, one torn
  assert.strictEqual(s.isBroken(), true); assert.throws(() => s.append({ a: 9 }), /could not be rolled back/); s.close();
  const s2 = ST.openStream(d, 'raw', key); assert.ok(s2.recovered && s2.recovered.bytesQuarantined > 0, JSON.stringify(s2.recovered)); s2.append({ a: 7 }); s2.close();
  const v = ST.verify(d, 'raw', key); assert.strictEqual(v.ok, true, JSON.stringify(v));
  const got = [...ST.readStream(d, 'raw', key)];
  /* complete lines of the failed batch that reached the disk are valid records (the observer's queue writes the batch
     again: duplicates, which derive removes); the torn one is in quarantine; nothing is lost from the chain */
  assert.deepStrictEqual(got.filter(r => r.a != null && r.a <= 2).map(r => r.a), [1, 2]); assert.ok(got.some(r => r.kind === 'store.recovered')); assert.strictEqual(got[got.length - 1].a, 7);
});
t('F1: a real observer under a 16 KiB file-size limit: writes fail (EFBIG), nothing partial reaches the disk, records stay queued, and the loss is recorded at stop and at the next start', async () => {
  const d = tmp(), { file: kf, key } = symKey();
  const s = ST.openStream(d, 'raw', key); let i = 0; s.append({ pre: i++ }); const seg = ST.segments(path.join(d, 'raw'))[0];
  while (fs.statSync(seg).size < 16000) s.append({ pre: i++, pad: 'p'.repeat(40) }); s.close();
  const pre = ST.verify(d, 'raw').seq, startedAt = Date.now();
  const o = startObs(d, kf, { ulimitKB: 16 }); await sleep(4500); o.p.kill('SIGTERM'); const code = await o.exit;
  assert.strictEqual(code, 0, o.err()); assert.ok(/write failed \(records kept in memory and retried/.test(o.err()), o.err());
  const buf = fs.readFileSync(seg); assert.ok(buf.length <= 16384 && buf[buf.length - 1] === 0x0a, 'no partial record on disk');
  const v = ST.verify(d, 'raw', key); assert.ok(v.ok && v.seq === pre && v.unterminatedTailBytes === 0, JSON.stringify(v));
  const g = healthRecs(d, key).find(r => r.kind === 'obs.gap' && r.stream === 'raw');
  assert.ok(g && /could not be written before the observer stopped/.test(g.reason) && g.droppedRecords > 0 && g.from <= startedAt + 3000, JSON.stringify(g));
  const lastRawBefore = ST.lastTime(d, 'raw');
  const o2 = startObs(d, kf); await sleep(2500); o2.p.kill('SIGTERM'); assert.strictEqual(await o2.exit, 0, o2.err());
  const g2 = healthRecs(d, key).filter(r => r.kind === 'obs.gap').pop();
  assert.ok(g2 && g2.from === lastRawBefore, 'the restart gap starts at the newest raw record (raw stopped being written, health did not): ' + JSON.stringify(g2));
  assert.ok(ST.verify(d, 'raw', key).seq > pre && ST.verify(d, 'health', key).ok);
});

/* ================= F2 (high): a stale lock (container PID 1, recycled PID, new host name) ================= */
t('F2: a fresh lease held elsewhere is refused (another host; this pid after a container restart; a live recycled pid); once expired it is taken over and recorded', async () => {
  const { key } = symKey(); const live = spawn('sleep', ['30']); await sleep(100);
  try {
    for (const [label, lease] of [['another host', { pid: 4242, host: 'some-other-host' }], ['this pid but not held (container restarted as the same PID)', { pid: process.pid, host: os.hostname() }], ['a live process (recycled pid)', { pid: live.pid, host: os.hostname() }]]) {
      const d = tmp(); fs.mkdirSync(path.join(d, 'raw'), { recursive: true }); const lf = path.join(d, 'raw', '.writer.lock');
      fs.writeFileSync(lf, JSON.stringify({ ...lease, at: Date.now(), token: 'old' }));
      let err = null; try { ST.openStream(d, 'raw', key).close(); } catch (e) { err = e; }
      assert.ok(err && err.code === 'ELOCKED' && err.expiresInMs > ST.LEASE_MS - 5000, label + ': ' + (err && err.message));
      fs.writeFileSync(lf, JSON.stringify({ ...lease, at: Date.now() - ST.LEASE_MS - 1000, token: 'old' }));
      const s = ST.openStream(d, 'raw', key); assert.strictEqual(s.staleLockTakenOver, true, label); s.close();
      const rec = [...ST.readStream(d, 'raw', key)].find(r => r.kind === 'store.recovered'); assert.ok(rec && rec.staleLock && rec.staleLock.pid === lease.pid, label + ' ' + JSON.stringify(rec));
      assert.ok(fs.readdirSync(path.join(d, 'raw')).some(f => /^\.writer\.lock\.stale\./.test(f)), 'the old lease is kept as evidence');
    }
  } finally { live.kill(); }
});
t('F2: a writer whose lease was taken over stops: refresh and append throw ELEASELOST, and closing never removes the other writer\'s lease', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key); s.append({ a: 1 });
  const lf = path.join(d, 'raw', '.writer.lock'), other = JSON.stringify({ pid: 4242, host: 'some-other-host', at: Date.now(), token: 'theirs' }); fs.writeFileSync(lf, other);
  assert.throws(() => s.refresh(), e => e.code === 'ELEASELOST'); assert.throws(() => s.append({ a: 2 }), e => e.code === 'ELEASELOST');
  s.close(); assert.strictEqual(fs.readFileSync(lf, 'utf8'), other); assert.strictEqual([...ST.readStream(d, 'raw', key)].length, 1);
});
t('F2: real observers on one directory: a second one waits out the lease once, then refuses; a first one frozen past its lease is taken over and, on waking, stops without writing (exit 3)', async () => {
  const d = tmp(), { file: kf, key } = symKey(), env = { OBSERVER_LEASE_MS: '3000' };
  const a = startObs(d, kf, { env }); await sleep(1500);
  const b = startObs(d, kf, { env }); const bCode = await b.exit;
  assert.strictEqual(bCode, 2, b.err()); assert.ok(/waiting \d+ s for that lease/.test(b.err()) && /another observer is writing/.test(b.err()), b.err());
  a.p.kill('SIGSTOP'); await sleep(3600);
  const c = startObs(d, kf, { env }); await sleep(2500);
  a.p.kill('SIGCONT'); const aCode = await a.exit;
  assert.strictEqual(aCode, 3, 'exit ' + aCode + ' ' + a.err()); assert.ok(/no longer ours/.test(a.err()), a.err());
  await sleep(1200); c.p.kill('SIGTERM'); assert.strictEqual(await c.exit, 0, c.err());
  for (const n of ['raw', 'health']) { const v = ST.verify(d, n, key); assert.strictEqual(v.ok, true, n + ' ' + JSON.stringify(v)); }
  const starts = healthRecs(d, key).filter(r => r.kind === 'obs.start'); assert.strictEqual(starts.length, 2); assert.ok(starts[1].staleLock && starts[1].staleLock.pid === a.p.pid, JSON.stringify(starts[1].staleLock));
});

/* ================= F3 (high): derive and report held the whole history in memory ================= */
const DERIVE = JSON.stringify(path.join(ROOT, 'lib/derive'));
const synth = N => `
  const N = ${N}, C0 = Date.UTC(2026, 0, 1), iso = t => new Date(t).toISOString();
  function* gen() {
    for (let k = 0; k < N; k++) {
      const close = C0 + k * 900e3, tk = 'KXBTC15M-M' + k, m = { ticker: tk, open_time: iso(close - 900e3), close_time: iso(close), floor_strike: 80000, rules_primary: 'rules ' + k };
      yield { kind: 'k.markets', t: close - 900e3, tRecv: close - 900e3, markets: [{ ...m, status: 'active' }] };
      yield { kind: 'pr.health', t: close - 300e3, tSent: close - 300e3 - 20, tRecv: close - 300e3, body: { ts: close - 300e3 - 10, build: 'b', tiers: { lockMaxFlip: 0.005 } } };
      for (let sec = 300; sec >= 1; sec--) {
        yield { kind: 'pr.predictions', t: close - sec * 1000, rows: [{ ts: close - sec * 1000 + 250, ticker: tk, tau: sec - 0.25, state: sec < 100 ? 'LOCKED' : 'HIGH CONFIDENCE', side: 'UP', pFlip: 0.001, ask: 97, pad: 'r' + k + '-' + sec + 'x'.repeat(300) }] };
        yield { kind: 'k.book', t: close - sec * 1000, ticker: tk, tSent: close - sec * 1000 - 30, tRecv: close - sec * 1000, hash: 'h' + k + '_' + sec,
          book: { orderbook_fp: { yes_dollars: [['0.0100', '100'], ['0.0200', '100']], no_dollars: [['0.0300', '500'], ['0.0200', '100' + sec]] } } };
      }
      yield { kind: 'k.market', t: close + 10e3, ticker: tk, tRecv: close + 10e3, market: { ...m, status: 'finalized', result: 'yes', expiration_value: '80010' } };
    }
  }`;
t('F3: derive streams: 4,000 markets (2.4 million records, 42 days) are derived under a 96 MB heap; 1,500 markets materialised as an array exhaust the same heap', () => {
  const ok = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', synth(4000) + `
    let n = 0, complete = 0;
    require(${DERIVE}).build(() => gen(), { onMarket: m => { n++; if (m.coverage && m.coverage.status === 'complete' && m.qualified && m.qualified.won) complete++; } });
    console.log(JSON.stringify({ markets: n, complete, heapMB: Math.round(process.memoryUsage().heapUsed / 1048576) }));`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.strictEqual(ok.status, 0, ok.stderr.slice(-600)); const o = JSON.parse(ok.stdout); assert.strictEqual(o.markets, 4000); assert.strictEqual(o.complete, 4000);
  const all = spawnSync(process.execPath, ['--max-old-space-size=96', '-e', synth(1500) + `const a = [...gen()]; require(${DERIVE}).build(a); console.log('fit');`], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.notStrictEqual(all.status, 0, 'materialising the history must not fit in the same heap (otherwise this test proves nothing)');
});
t('F3: observer.js derive reads the encrypted store record by record: 12 days, 576 markets (about 180 MB of plaintext) under a 96 MB heap', () => {
  const d = tmp(), { file: kf, key } = symKey(); const C0 = Date.UTC(2026, 0, 1), iso = x => new Date(x).toISOString();
  let T = C0; const s = ST.openStream(d, 'raw', key, { now: () => T });
  let plain = 0;
  for (let k = 0; k < 576; k++) {
    const close = C0 + k * 1800e3, tk = 'KXBTC15M-D' + k, m = { ticker: tk, open_time: iso(close - 900e3), close_time: iso(close), floor_strike: 80000, rules_primary: 'rules ' + k };
    const recs = [{ kind: 'k.markets', tRecv: close - 900e3, markets: [{ ...m, status: 'active' }] }, { kind: 'pr.health', tSent: close - 300e3 - 20, tRecv: close - 300e3, body: { ts: close - 300e3 - 10, build: 'b', tiers: { lockMaxFlip: 0.005 } } }];
    for (let p = 0; p < 10; p++) { const rows = []; for (let sec = 300 - p * 30; sec > 300 - (p + 1) * 30; sec--) rows.push({ ts: close - sec * 1000 + 250, ticker: tk, tau: sec - 0.25, state: sec < 100 ? 'LOCKED' : 'HIGH CONFIDENCE', side: 'UP', pFlip: 0.001, ask: 97, pad: crypto.randomBytes(150).toString('hex') }); recs.push({ kind: 'pr.predictions', rows }); }
    for (let sec = 300; sec >= 1; sec--) recs.push({ kind: 'k.book', ticker: tk, tSent: close - sec * 1000 - 30, tRecv: close - sec * 1000, hash: 'h' + k + '_' + sec,
      book: { orderbook_fp: { yes_dollars: Array.from({ length: 10 }, (_, j) => [(0.01 * (j + 1)).toFixed(4), String(100 + sec)]), no_dollars: Array.from({ length: 10 }, (_, j) => [(0.03 - 0.001 * j).toFixed(4), String(500 + j)]) } } });
    recs.push({ kind: 'k.market', ticker: tk, tRecv: close + 10e3, market: { ...m, status: 'finalized', result: 'yes', expiration_value: '80010' } });
    for (const r of recs) plain += JSON.stringify(r).length;
    T = close + 30e3; s.append(recs);
  }
  s.close();
  assert.ok(plain > 150e6, 'plaintext ' + Math.round(plain / 1e6) + ' MB'); assert.ok(ST.segments(path.join(d, 'raw')).length >= 12);
  const out = path.join(tmp(), 'derived.json');
  const r = spawnSync(process.execPath, ['--max-old-space-size=96', OBS, 'derive', '--data', d, '--key', kf, '--out', out], { encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.strictEqual(r.status, 0, (r.stderr || '').slice(-600));
  const j = JSON.parse(fs.readFileSync(out, 'utf8')); assert.strictEqual(j.markets.length, 576); assert.ok(j.markets.every(x => x.coverage.status === 'complete' && x.qualified.won === true));
  const digest = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  const rec = [...ST.readStream(d, 'derived', key)].pop(); assert.ok(rec.kind === 'derived.markets' && rec.outputSha256 === digest && rec.markets === 576 && !rec.body, 'the derived stream keeps the digest of the output, not a copy');
  const w = cli(['report', '--data', d, '--key', kf, '--since', iso(C0 + 100 * 1800e3), '--until', iso(C0 + 200 * 1800e3)]);
  assert.strictEqual(w.status, 0, w.stderr.slice(-400)); assert.strictEqual(JSON.parse(w.stdout).all.coverage.recorded, 100, '--since/--until select markets by close time');
});

/* ================= F4 (medium): restore-test failed on a backup taken while the observer was writing ================= */
t('F4: backups taken while a writer appends copy whole lines only, carry the heads of what they copied, and pass restore-test every time', async () => {
  const d = tmp(), b = tmp(), { file: kf, key } = symKey();
  const w = spawn(process.execPath, ['-e', `const ST = require(${JSON.stringify(path.join(ROOT, 'lib/store'))}); const s = ST.openStream(${JSON.stringify(d)}, 'raw', ST.loadKey(${JSON.stringify(kf)}));
    let i = 0; const end = Date.now() + 4000; (function go() { if (Date.now() > end) { s.close(); return; } const b = []; for (let j = 0; j < 20; j++) b.push({ i: i++, pad: require('crypto').randomBytes(500).toString('hex') }); s.append(b); setTimeout(go, 10); })();`]);
  const done = new Promise(r => w.on('exit', r)); let finished = false; done.then(() => { finished = true; });
  await sleep(300); let runs = 0;
  while (!finished) {
    const r = cli(['backup', '--data', d, '--to', b, '--key', kf]); assert.strictEqual(r.status, 0, 'backup ' + runs + ': ' + r.stderr);
    const rt = cli(['restore-test', '--from', b, '--key', kf]); assert.strictEqual(rt.status, 0, 'restore-test ' + runs + ': ' + rt.stdout + rt.stderr);
    const man = JSON.parse(fs.readFileSync(path.join(b, 'MANIFEST.json'), 'utf8')), vb = ST.verify(b, 'raw');
    assert.ok(man.heads.raw.s === vb.seq && man.heads.raw.h === vb.head, 'manifest heads = heads of the copy');
    runs++; await sleep(50);
  }
  assert.ok(runs >= 2, runs + ' backups during writing');
  /* a write in progress (a fragment without its newline) is never copied; verify of the live store reports it */
  const seg = ST.segments(path.join(d, 'raw')).pop(); fs.appendFileSync(seg, '{"s":999999,"partial');
  const v = ST.verify(d, 'raw', key); assert.ok(v.ok && v.unterminatedTailBytes > 0, JSON.stringify(v));
  assert.strictEqual(cli(['backup', '--data', d, '--to', b, '--key', kf]).status, 0);
  const copy = fs.readFileSync(path.join(b, 'raw', path.basename(seg))); assert.strictEqual(copy[copy.length - 1], 0x0a); assert.ok(!copy.includes('partial'));
  const rt = cli(['restore-test', '--from', b, '--key', kf]); assert.strictEqual(rt.status, 0, rt.stdout + rt.stderr);
  assert.strictEqual(JSON.parse(rt.stdout).verify.raw.records, ST.verify(d, 'raw').records);
});

/* ================= F5 (medium): the catch-up after an outage ran once ================= */
t('F5: a catch-up that fails is retried (after 5 min, not more often) and the cursor does not move until it succeeds', async () => {
  let T = Date.UTC(2026, 9, 31, 12), lists = 0, failList = true;
  const page = Array.from({ length: 2000 }, (_, i) => ({ ts: T - 60e3 + i * 10, ticker: 'KXBTC15M-A', tau: 100, state: 'LOCKED', side: 'UP' }));
  const http = { get: async url => { const u = new URL(url); if (u.pathname === '/predictions') { const rows = u.searchParams.get('ticker') ? page.slice(0, 5) : page; return { ok: true, status: 200, tSent: T, tRecv: T, text: rows.map(r => JSON.stringify(r)).join('\n') }; }
    return { ok: false, status: 404, tSent: T, tRecv: T, text: '' }; } };
  const recs = [];
  const pr = pinradarSource({ base: 'http://127.0.0.1:1', http, emit: o => recs.push(o), now: () => T, state: { predTs: T - 3600e3 }, listTickers: async () => { lists++; return failList ? null : ['KXBTC15M-A', 'KXBTC15M-B']; } });
  const c0 = pr.state.predTs;
  await pr.step(T); assert.strictEqual(pr.state.predTs, c0); assert.ok(recs.some(r => r.kind === 'pr.predictions.catchup.incomplete')); assert.strictEqual(lists, 1);
  T += 60e3; await pr.step(T); assert.strictEqual(lists, 1, 'no retry before the back-off'); assert.strictEqual(pr.state.predTs, c0);
  failList = false; T += 300e3; await pr.step(T);
  assert.strictEqual(lists, 2); assert.ok(pr.state.predTs > c0, 'cursor moves once the catch-up completed');
  assert.deepStrictEqual(recs.filter(r => r.kind === 'pr.predictions' && r.ticker).map(r => r.ticker), ['KXBTC15M-A', 'KXBTC15M-B']);
});

/* ================= F6 (medium): losing state.json broke the gap record and the catch-up ================= */
t('F6: with state.json missing, damaged or stale, the gap starts at the newest stored record and collection restarts 15 min before it', async () => {
  const d = tmp(), { file: kf, key } = symKey(), sf = path.join(d, 'state.json');
  let o = startObs(d, kf); await sleep(2500); o.p.kill('SIGKILL'); await o.exit;
  const stale = fs.readFileSync(sf, 'utf8');
  for (const [label, prep, want] of [['missing', () => fs.rmSync(sf), /state file missing/], ['damaged', () => fs.writeFileSync(sf, '{"pinr'), /state file unreadable/], ['stale', () => fs.writeFileSync(sf, stale), /state file older than the newest stored record/]]) {
    await sleep(1200); o = startObs(d, kf); await sleep(1500); o.p.kill('SIGKILL'); await o.exit;   // a run that leaves fresh records behind
    const newest = Math.min(ST.lastTime(d, 'raw'), ST.lastTime(d, 'health'));
    prep(); o = startObs(d, kf); await sleep(2000); o.p.kill('SIGTERM'); assert.strictEqual(await o.exit, 0, o.err());
    const h = healthRecs(d, key), st = h.filter(r => r.kind === 'obs.start').pop(), gap = h.filter(r => r.kind === 'obs.gap').pop();
    assert.ok(gap && want.test(gap.reason) && gap.from === newest, label + ': ' + JSON.stringify(gap) + ' newest ' + newest);
    assert.ok(/newest stored record minus 15 min/.test(st.predTsFrom) && st.restoredCursors.predTs === Math.round(newest - 15 * 60e3), label + ': ' + JSON.stringify(st));
  }
  const sj = fs.readFileSync(sf, 'utf8'); assert.ok(JSON.parse(sj).cleanStop === true && Number.isFinite(JSON.parse(sj).flushedAt)); assert.strictEqual(fs.statSync(sf).mode & 0o077, 0);
  assert.ok(!fs.existsSync(sf + '.tmp'));
});

/* ================= F7 (medium): anchors, checkpoints and manifest heads were checked one chain walk per head ================= */
t('F7: 3,000 anchors and 300 signed checkpoints are each checked in ONE walk of the chain (not one walk per head)', () => {
  const d = tmp(), { key } = symKey(); const s = ST.openStream(d, 'raw', key); for (let i = 0; i < 30; i++) s.append(Array.from({ length: 100 }, (_, j) => ({ i, j }))); s.close();
  const af = path.join(tmp(), 'anchors.ndjson'); const lines = []; for (const r of ST.chain(d, 'raw')) lines.push(JSON.stringify({ stream: 'raw', s: r.s, h: r.h })); fs.writeFileSync(af, lines.join('\n') + '\n');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519'); const pf = path.join(tmp(), 'sign.pub.pem'); fs.writeFileSync(pf, publicKey.export({ type: 'spki', format: 'pem' }));
  const O = require('../observer.js'); const sid = crypto.createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  const h = ST.openStream(d, 'health', key); const heads = [...ST.chain(d, 'raw')].filter((r, i) => i % 10 === 9).map(r => ({ s: r.s, h: r.h }));
  for (const hd of heads) { const body = { kind: 'obs.checkpoint', at: hd.s, version: 'v', heads: { raw: hd } }; h.append({ ...body, sig: crypto.sign(null, Buffer.from(O.canon(body)), privateKey).toString('base64'), signer: sid }); }
  h.close();
  const seg = ST.segments(path.join(d, 'raw'))[0]; let reads = 0; const orig = fs.readFileSync;
  fs.readFileSync = function (f, ...a) { if (f === seg) reads++; return orig.call(fs, f, ...a); };
  let bad, cps; try { bad = O.anchorsCheck(d, af); const r1 = reads; cps = O.checkpoints(d, key, pf); reads = [r1, reads - r1]; } finally { fs.readFileSync = orig; }
  assert.deepStrictEqual(bad, []); assert.ok(reads[0] <= 1, reads[0] + ' reads of the raw segment for 3,000 anchors');
  assert.strictEqual(cps.checkpoints, 300); assert.deepStrictEqual(cps.bad, []); assert.ok(reads[1] <= 1, reads[1] + ' reads of the raw segment for 300 checkpoints');
  const af2 = path.join(tmp(), 'bad.ndjson'); fs.writeFileSync(af2, '{"stream":"raw","s":5,"h":"00"}\nnot json\n');
  assert.strictEqual(O.anchorsCheck(d, af2).length, 2, 'a wrong anchor and a damaged anchor line both fail');
});

/* ================= F8 (low): a slow Kalshi request blocked the 1 Hz book lane ================= */
t('F8: Kalshi books run in their own lane: with every metadata request hanging, the 1 Hz book snapshots continue', async () => {
  let T = Date.UTC(2026, 9, 31, 12); const tk = 'KXBTC15M-26OCT311215-15', close = T + 200e3; let books = 0;
  const http = { get: url => { if (/\/orderbook$/.test(new URL(url).pathname)) { books++; return Promise.resolve({ ok: true, status: 200, tSent: T, tRecv: T, text: JSON.stringify({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }) }); } return new Promise(() => { }); } };
  const ks = kalshiSource({ base: 'http://127.0.0.1:1/trade-api/v2', http, emit: () => { }, now: () => T, state: { markets: { [tk]: { ticker: tk, closeMs: close, openMs: close - 900e3 } } } });
  ks.stepMeta(T);                                                     // never returns: discovery and series hang
  for (let i = 0; i < 5; i++) { await ks.stepBooks(T); T += 1000; }
  assert.strictEqual(books, 5);
  const src = fs.readFileSync(OBS, 'utf8'); assert.ok(/kbooks: \{[^}]*ks\.stepBooks/.test(src) && /kmeta: \{[^}]*ks\.stepMeta/.test(src), 'the observer runs books and metadata in separate lanes');
});

/* ================= F9 (low): the backup usage text omitted --key ================= */
t('F9: the backup usage names --key (observer.js and README), and backup without --key says what is missing', () => {
  const src = fs.readFileSync(OBS, 'utf8'), readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(/backup --data <dir> --key <owner\.public\.pem> --to <dir>/.test(src));
  assert.ok(readme.split('\n').filter(l => /\bbackup --data\b/.test(l)).every(l => /--key/.test(l)), 'every backup example in the README has --key');
  const r = cli(['backup', '--data', tmp(), '--to', tmp()]); assert.notStrictEqual(r.status, 0); assert.ok(/--key required/.test(r.stderr), r.stderr);
});

(async () => {
  const only = process.env.ONLY;                                       // run a subset: ONLY=<part of a test name>
  for (const [n, f] of tests) { if (only && !n.includes(only)) continue; const t0 = Date.now(); try { await f(); results.push([true, n, Date.now() - t0]); } catch (e) { results.push([false, n + ' :: ' + (e && e.stack || e), Date.now() - t0]); } }
  let n = 0; for (const [p, s, ms] of results) { console.log((p ? 'ok   ' : 'FAIL ') + s + '  (' + (ms / 1000).toFixed(1) + ' s)'); if (p) n++; }
  console.log(`durability: ${n}/${results.length} passed`);
  process.exit(n === results.length ? 0 : 1);
})();
