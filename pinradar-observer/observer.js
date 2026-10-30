#!/usr/bin/env node
/* Pin Radar 2.8 independent observer. A client only: it opens no network port, sends only GET requests to an allowlist of
   read-only paths, and has no credentials for Pin Radar, Render or any Kalshi account.

   node observer.js keygen  --key <file>                     create the 32-byte data key (keep it off the data disk; back it up)
   node observer.js run     --data <dir> --key <file> --pinradar <url> [--kalshi <url>] [--heartbeat-url <url>]
                            --heartbeat-url: a dead-man's switch (e.g. a healthchecks-style URL). A plain GET, with no data,
                            is sent once a minute ONLY while the observer is healthy; the external service alerts when pings stop.
   node observer.js verify  --data <dir> [--key <file>]       chain check of every stream (no key) / plus decryption (key)
   node observer.js derive  --data <dir> --key <file> [--out <file.json>]
   node observer.js report  --data <dir> --key <file> [--period daily|weekly|monthly|all] [--out <file.json>]
   node observer.js export  --data <dir> --key <file> --out <dir>       decrypted copy of everything, for the key holder
   node observer.js backup  --data <dir> --to <dir>           copies new or grown segments (still encrypted) + a SHA-256 manifest
   node observer.js restore-test --from <backup dir> --key <file>         restores into a temporary directory and verifies
   Every command except run writes an entry to the 'audit' stream (who, what, when). */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const ST = require('./lib/store');
const { mkClient, PINRADAR_PATHS, KALSHI_PATHS } = require('./lib/http');
const { pinradarSource, kalshiSource } = require('./lib/sources');
const D = require('./lib/derive');
const R = require('./lib/report');
const VERSION = 'pinradar-observer-1.0';

const A = {}; const argv = process.argv.slice(2); const cmd = argv[0];
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { A[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const die = m => { console.error(m); process.exit(2); };
const sha256file = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/* writing needs only the public half: with a private key, records are written with its public key */
const writerKey = K => K && K.type === 'priv' ? { type: 'pub', pub: K.pub, kid: K.kid } : K;
function audit(dataDir, key, what) {
  try { const s = ST.openStream(dataDir, 'audit', writerKey(key)); s.append({ kind: 'audit', by: os.userInfo().username, host: os.hostname(), command: what, version: VERSION, at: new Date().toISOString() }); } catch (_) { }
}
function readAll(dataDir, key, stream = 'raw') { return [...ST.readStream(dataDir, stream, key)]; }

async function run() {
  const dataDir = A.data || die('--data required'), key = ST.loadKey(A.key || die('--key required'));
  const pinradar = A.pinradar || die('--pinradar <url> required');
  if (path.resolve(A.key).startsWith(path.resolve(dataDir) + path.sep)) die('keep the key file outside the data directory (a backup of the data must not contain the key)');
  const raw = ST.openStream(dataDir, 'raw', key), health = ST.openStream(dataDir, 'health', key);
  const stateFile = path.join(dataDir, 'state.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { }
  const buf = [], hbuf = [];
  const emit = o => buf.push(o), hemit = o => hbuf.push(o);
  const ks = kalshiSource({ base: A.kalshi, http: mkClient({ allow: KALSHI_PATHS }), emit, state: saved.kalshi ? { markets: saved.kalshi.markets || {} } : {} });
  const pr = pinradarSource({ base: pinradar, http: mkClient({ allow: PINRADAR_PATHS }), emit, state: saved.pinradar || {}, onTickers: tks => ks.track(tks) });
  const now = Date.now();
  hemit({ kind: 'obs.start', version: VERSION, pid: process.pid, host: os.hostname(), pinradar, at: now, recoveredTail: raw.recovered || null });
  if (saved.lastBeat && !saved.cleanStop) hemit({ kind: 'obs.gap', from: saved.lastBeat, to: now, reason: 'observer was not running (crash or host restart)' });
  if (saved.lastBeat && saved.cleanStop && now - saved.lastBeat > 5000) hemit({ kind: 'obs.gap', from: saved.lastBeat, to: now, reason: 'observer was stopped' });
  const lanes = { kalshi: { last: now, every: 250, step: t => ks.step(t) }, pinradar: { last: now, every: 1000, step: t => pr.step(t, ks.tickers()) } };
  let stopping = false, errors = 0, lastBeat = now;
  const flush = () => {
    if (buf.length) { raw.append(buf.splice(0)); }
    if (hbuf.length) { health.append(hbuf.splice(0)); }
    const st = { pinradar: { ...pr.state }, kalshi: { markets: ks.state.markets }, lastBeat, cleanStop: stopping, version: VERSION };
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(st)); fs.renameSync(stateFile + '.tmp', stateFile);
    fs.writeFileSync(path.join(dataDir, 'status.json'), JSON.stringify({ ok: errors < 50, version: VERSION, lastBeat: new Date(lastBeat).toISOString(), rawRecords: raw.head().s, errorsSinceStart: errors }));
  };
  for (const [name, L] of Object.entries(lanes)) (async () => {
    while (!stopping) {
      const t = Date.now();
      if (t - L.last > 5000) hemit({ kind: 'obs.gap', lane: name, from: L.last, to: t, reason: 'lane stalled' });
      L.last = t;
      try { await L.step(t); } catch (e) { errors++; hemit({ kind: 'obs.error', lane: name, error: String(e && e.message || e) }); }
      await new Promise(r => setTimeout(r, Math.max(0, L.every - (Date.now() - t))));
    }
  })();
  /* healthy = both lanes stepped within 2 minutes and the store accepted the last flush */
  let flushOk = true, lastErrorsSeen = 0;
  const hbUrl = A['heartbeat-url'] ? new URL(A['heartbeat-url']) : null;
  const hbClient = hbUrl ? mkClient({ allow: [new RegExp('^' + hbUrl.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')] }) : null;
  const beat = setInterval(() => {
    lastBeat = Date.now();
    const healthy = flushOk && Object.values(lanes).every(L => lastBeat - L.last < 120e3) && errors - lastErrorsSeen < 30;
    lastErrorsSeen = errors;
    hemit({ kind: 'obs.heartbeat', at: lastBeat, healthy, rawHead: raw.head().s, markets: Object.keys(ks.state.markets).length, predCursor: pr.state.predTs, ledgerSeq: pr.state.ledgerSeq, errors });
    if (healthy && hbClient) hbClient.get(hbUrl.toString()).catch(() => { });
  }, 60e3);
  const fl = setInterval(() => { try { flush(); flushOk = true; } catch (e) { errors++; flushOk = false; console.error('flush failed: ' + e.message); } }, 1000);
  const stop = () => { if (stopping) return; stopping = true; lastBeat = Date.now(); hemit({ kind: 'obs.stop', at: lastBeat }); clearInterval(beat); clearInterval(fl); flush(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.log(`[${VERSION}] observing ${pinradar} (read-only); data in ${dataDir}`);
}

async function main() {
  if (cmd === 'keygen') { const f = A.key || die('--key <file>'); if (fs.existsSync(f)) die('refusing to overwrite an existing key file'); fs.writeFileSync(f, ST.newKey() + '\n', { mode: 0o600 }); console.log('key written to ' + f + ' (mode 600). Back it up separately: without it the data cannot be read.'); return; }
  if (cmd === 'keypair') {   /* recommended: the host gets only the public key and cannot read what it records */
    const pfx = A.out || die('--out <prefix>'); const pubF = pfx + '.public.pem', privF = pfx + '.private.pem';
    if (fs.existsSync(pubF) || fs.existsSync(privF)) die('refusing to overwrite existing key files');
    const kp = ST.newKeyPair(); fs.writeFileSync(privF, kp.priv, { mode: 0o600 }); fs.writeFileSync(pubF, kp.pub, { mode: 0o644 });
    console.log('public key (copy to the observer host): ' + pubF + '\nprivate key (keep on your own computer, back it up; never on the host): ' + privF); return;
  }
  if (cmd === 'run') return run();
  const dataDir = A.data;
  const key = A.key ? ST.loadKey(A.key) : null;
  if (cmd === 'verify') {
    const out = {}; for (const s of ['raw', 'health', 'derived', 'audit']) if (fs.existsSync(path.join(dataDir, s))) out[s] = ST.verify(dataDir, s, key);
    if (key) audit(dataDir, key, 'verify');
    console.log(JSON.stringify(out, null, 1)); process.exit(Object.values(out).every(v => v.ok) ? 0 : 1);
  }
  if (!key) die('--key required');
  if (cmd === 'derive' || cmd === 'report') {
    const raw = readAll(dataDir, key, 'raw').concat(fs.existsSync(path.join(dataDir, 'health')) ? readAll(dataDir, key, 'health') : []);
    const d = D.build(raw);
    const out = cmd === 'derive' ? d : { version: VERSION, generatedAt: new Date().toISOString(), clock: d.clock, feeRate: d.feeRate, feeSource: d.feeSource, configs: d.configs,
      all: R.summarize(d.markets), periods: A.period && A.period !== 'all' ? R.periods(d.markets, A.period) : undefined };
    ST.openStream(dataDir, 'derived', writerKey(key)).append({ kind: cmd === 'derive' ? 'derived.markets' : 'derived.report', at: Date.now(), rawRecords: raw.length, body: out });
    audit(dataDir, key, cmd + (A.period ? ' ' + A.period : ''));
    if (A.out) { fs.writeFileSync(A.out, JSON.stringify(out, null, 1), { mode: 0o600 }); console.log('written (decrypted) to ' + A.out); } else console.log(JSON.stringify(cmd === 'report' ? out : { markets: d.markets.length, clock: d.clock }, null, 1));
    return;
  }
  if (cmd === 'export') {
    const outDir = A.out || die('--out <dir>'); fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    for (const s of ['raw', 'health', 'derived', 'audit']) if (fs.existsSync(path.join(dataDir, s))) {
      const fd = fs.openSync(path.join(outDir, s + '.ndjson'), 'w', 0o600); for (const r of ST.readStream(dataDir, s, key)) fs.writeSync(fd, JSON.stringify(r) + '\n'); fs.closeSync(fd);
    }
    audit(dataDir, key, 'export to ' + outDir); console.log('exported (decrypted) to ' + outDir); return;
  }
  if (cmd === 'backup') {
    const to = A.to || die('--to <dir>'); const man = { at: new Date().toISOString(), files: {} };
    for (const s of ['raw', 'health', 'derived', 'audit']) for (const f of ST.segments(path.join(dataDir, s))) {
      const rel = path.join(s, path.basename(f)), dst = path.join(to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(f).size) fs.copyFileSync(f, dst);
      man.files[rel] = sha256file(dst);
      if (man.files[rel] !== sha256file(f)) die('backup copy differs from the source: ' + rel);
    }
    fs.writeFileSync(path.join(to, 'MANIFEST.json'), JSON.stringify(man, null, 1));
    audit(dataDir, key, 'backup to ' + to); console.log('backed up ' + Object.keys(man.files).length + ' segments to ' + to); return;
  }
  die('unknown command');
}
if (cmd === 'restore-test') {
  (async () => {
    const from = A.from || die('--from <backup dir>'), key = ST.loadKey(A.key || die('--key'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observer_restore_'));
    const man = JSON.parse(fs.readFileSync(path.join(from, 'MANIFEST.json'), 'utf8'));
    for (const [rel, h] of Object.entries(man.files)) { const dst = path.join(tmp, rel); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(path.join(from, rel), dst); if (sha256file(dst) !== h) die('restore: checksum mismatch ' + rel); }
    const out = {}; for (const s of ['raw', 'health', 'derived', 'audit']) if (fs.existsSync(path.join(tmp, s))) out[s] = ST.verify(tmp, s, key);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(JSON.stringify({ restored: Object.keys(man.files).length, verify: out }, null, 1)); process.exit(Object.values(out).every(v => v.ok) ? 0 : 1);
  })();
} else if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { VERSION };
