#!/usr/bin/env node
/* Pin Radar 2.8 independent observer. A client only: it opens no network port, sends only GET requests to an allowlist of
   read-only paths, follows no redirects, and has no credentials for Pin Radar, Render or any Kalshi account.

   On the OWNER's computer:
     node observer.js keypair --out <prefix>           RSA-3072 encryption key pair (OBSERVER_KEY_PASSPHRASE encrypts the private key)
   On the observer HOST:
     node observer.js signkey --out <prefix>           Ed25519 checkpoint-signing key: <prefix>.sign.pem stays on the host,
                                                       <prefix>.sign.pub.pem goes to the owner
     node observer.js run --data <dir> --key <owner.public.pem> --sign-key <host.sign.pem> --pinradar <url>
                          [--kalshi <url>] [--heartbeat-url <url>]
     node observer.js backup --data <dir> --key <owner.public.pem> --to <dir>
                                                       append-only copy of the encrypted records (whole lines only) and a
                                                       manifest with the heads of what was copied
     node observer.js anchor --data <dir> --out <file> append every stream's head (seq, hash) to an anchor file KEPT OFF the host
   Anywhere (with the private key, on the owner's computer):
     node observer.js verify  --data <dir> [--key <private.pem>] [--sign-pub <host.sign.pub.pem>] [--anchors <file>]
     node observer.js derive  --data <dir> --key <private.pem> [--sign-pub <file>] [--since <date>] [--until <date>] [--out <new file>]
     node observer.js report  --data <dir> --key <private.pem> [--period daily|weekly|monthly|all] [--since <date>] [--until <date>] [--out <new file>]
     node observer.js export  --data <dir> --key <private.pem> --out <new or empty dir>
     node observer.js restore-test --from <backup dir> --key <private.pem> [--anchors <file>]
   derive, report, export, backup and verify-with-a-key write a "started" entry to the 'audit' stream BEFORE they run
   (and refuse to run if they cannot). verify without a key and restore-test write no audit entry (no key / no data dir).
   keygen --key <file> (a symmetric key) exists for tests only. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const ST = require('./lib/store');
const { mkClient, PINRADAR_PATHS, KALSHI_PATHS } = require('./lib/http');
const { pinradarSource, kalshiSource } = require('./lib/sources');
const D = require('./lib/derive');
const R = require('./lib/report');
const VERSION = 'pinradar-observer-1.2';
const STREAMS = ['raw', 'health', 'derived', 'audit'];
const SEG_RE = /^(raw|health|derived|audit)\/\d{4}-\d{2}-\d{2}\.jsonl$/;

const A = {}; const argv = process.argv.slice(2); const cmd = argv[0];
for (let i = 1; i < argv.length; i++) if (argv[i].startsWith('--')) { A[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
const die = m => { console.error(m); process.exit(2); };
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const sha256file = f => sha256(fs.readFileSync(f));
const canon = v => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
/* writing needs only the public half: with a private key, records are written with its public key */
const writerKey = K => K && K.type === 'priv' ? { type: 'pub', pub: K.pub, kid: K.kid } : K;
const newFile = (f, content) => { try { fs.writeFileSync(f, content, { flag: 'wx', mode: 0o600 }); } catch (e) { die('refusing to write ' + f + ': ' + (e.code === 'EEXIST' ? 'it already exists (choose a new file)' : e.message)); } };
function audit(dataDir, key, what) {
  const s = ST.openStream(dataDir, 'audit', writerKey(key));
  try { s.append({ kind: 'audit', by: os.userInfo().username, host: os.hostname(), command: what, version: VERSION, at: new Date().toISOString() }); } finally { s.close(); }
}
function auditOrDie(dataDir, key, what) { try { audit(dataDir, key, what); } catch (e) { die('cannot write the audit trail (' + e.message + '): refusing to run ' + what); } }
function loadSignKey(f) {
  const st = fs.statSync(f); if (st.mode & 0o077) die('signing key ' + f + ' is readable by group/others (chmod 600 it)');
  const k = crypto.createPrivateKey(fs.readFileSync(f)); if (k.asymmetricKeyType !== 'ed25519') die('the signing key must be Ed25519 (observer.js signkey)');
  return k;
}
const signerId = pub => sha256(pub.export({ type: 'spki', format: 'der' })).slice(0, 16);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseT = (v, label) => { if (v == null) return undefined; if (v === true) die('--' + label + ' needs a value');
  const n = /^\d{10,}$/.test(v) ? Number(v) : Date.parse(v); if (!Number.isFinite(n)) die('--' + label + ' must be a date such as 2026-10-31 or 2026-10-31T12:00Z, or epoch ms'); return n; };
/* a small file replaced atomically and durably: a crash leaves the old or the new version, never a torn one */
function writeDurable(f, content) {
  const tmp = f + '.tmp', fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, f);
  try { const dfd = fs.openSync(path.dirname(f), 'r'); try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); } } catch (_) { }
}
/* One write queue per stream: records are appended in order, in atomic batches. A failed write keeps them (beyond
   MAX_QUEUE the oldest are dropped, and counted); a stream left broken by a failed rollback is reopened, which re-reads
   its real tail. When writing works again, onResume gets the interval, the first error and the number dropped. */
const MAX_QUEUE = Number(process.env.OBSERVER_MAX_QUEUE || 50000), BATCH = 2000;
function writeQueue(first, reopen, onResume) {
  let s = first, q = [], failSince = null, firstError = null, dropped = 0, okAt = Date.now();
  return {
    push(o) { q.push(o); if (q.length > MAX_QUEUE) { q.shift(); dropped++; } },
    size: () => q.length, stream: () => s, pendingSince: () => failSince ?? okAt,
    flush() {
      try {
        if (s.isBroken()) { try { s.close(); } catch (_) { } s = reopen(); }
        while (q.length) { const b = q.slice(0, BATCH); s.append(b); q.splice(0, b.length); }
      } catch (e) { if (failSince == null) { failSince = okAt; firstError = e.message; } throw e; }
      okAt = Date.now();
      if (failSince != null) { const info = { from: failSince, to: okAt, error: firstError, droppedRecords: dropped }; failSince = null; firstError = null; dropped = 0; onResume(info); }
    },
  };
}

/* ---------------------------------------------------------------- run ---------------------------------------------------------------- */
async function run() {
  const dataDir = A.data || die('--data required'), key = ST.loadKey(A.key || die('--key required'));
  const pinradar = A.pinradar || die('--pinradar <url> required');
  if (key.type === 'priv') die('run with the PUBLIC key (owner.public.pem): the private key must not be on the observer host');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const realData = fs.realpathSync(dataDir), realKey = fs.realpathSync(A.key);
  if (realKey === realData || realKey.startsWith(realData + path.sep)) die('keep the key file outside the data directory (a backup of the data must not contain the key)');
  /* --create-sign-key: on a fresh host (e.g. a new Render worker) the host creates its own signing key on its persistent
     disk on the first start; the private half never leaves the host, the public half is printed to the log for the owner */
  if (A['sign-key'] && A['create-sign-key'] && !fs.existsSync(A['sign-key'])) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.dirname(path.resolve(A['sign-key'])), { recursive: true, mode: 0o700 });
    fs.writeFileSync(A['sign-key'], privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
    console.log('created the host signing key ' + A['sign-key'] + ' (signer id ' + signerId(publicKey) + '); its public half, for the owner:\n' + publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const signKey = A['sign-key'] ? loadSignKey(A['sign-key']) : null;
  if (signKey) console.log('checkpoints signed by ' + signerId(crypto.createPublicKey(signKey)) + '; public half:\n' + crypto.createPublicKey(signKey).export({ type: 'spki', format: 'pem' }));
  if (signKey && fs.realpathSync(A['sign-key']).startsWith(realData + path.sep)) die('keep the signing key outside the data directory');
  /* up to when is this data directory complete? The OLDER of the two streams' newest records (read before opening:
     opening may append a recovery record). If one stream stopped being written, its loss is not hidden by the other. */
  const ends = ['raw', 'health'].map(n => ST.lastTime(dataDir, n)).filter(Number.isFinite);
  const lastStored = ends.length ? Math.min(...ends) : NaN;
  const hasStore = Number.isFinite(lastStored);
  /* both writer leases, or neither: a fresh lease held elsewhere is waited out once; renewed meanwhile = another writer */
  let streams = null, waitedForLeaseMs = 0;
  for (let attempt = 0; !streams; attempt++) {
    const opened = [];
    try { for (const n of ['raw', 'health']) opened.push(ST.openStream(dataDir, n, key)); streams = opened; }
    catch (e) {
      for (const x of opened) x.close();
      if (e.code !== 'ELOCKED') throw e;
      if (attempt) die('another observer is writing to ' + dataDir + ' (its lease was renewed): refusing to start a second writer');
      waitedForLeaseMs = e.expiresInMs + 1000;
      console.error(e.message + '\nwaiting ' + Math.ceil(waitedForLeaseMs / 1000) + ' s for that lease to expire (a running observer renews it every ' + Math.round(ST.LEASE_MS / 8000) + ' s)');
      await sleep(waitedForLeaseMs);
    }
  }
  const stateFile = path.join(dataDir, 'state.json');
  let saved = {}, stateProblem = null;
  try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not an object'); }
  catch (e) { saved = {}; stateProblem = e.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  if (!stateProblem && hasStore && !(Number.isFinite(saved.flushedAt) && saved.flushedAt >= lastStored - 10e3)) stateProblem = 'older than the newest stored record';
  const now = Date.now();
  /* saved cursors are untrusted input: anything implausible is reset (and said so), never allowed to pause collection */
  const clean = { notes: [] };
  const sanDue = (d, label) => { const o = {}; for (const [k, v] of Object.entries(d || {})) { if (Number.isFinite(v) && v <= now + 3600e3) o[k] = v; else clean.notes.push(label + '.due.' + k + ' reset'); } return o; };
  const pst = saved.pinradar || {};
  const pState = { ...pst, due: sanDue(pst.due, 'pinradar') };
  if (!(Number.isSafeInteger(pState.predTs) && pState.predTs >= 0 && pState.predTs <= now + 864e5)) { if (pst.predTs != null) clean.notes.push('predTs reset'); pState.predTs = 0; }
  if (!(Number.isSafeInteger(pState.ledgerSeq) && pState.ledgerSeq >= 0)) { if (pst.ledgerSeq != null) clean.notes.push('ledgerSeq reset'); pState.ledgerSeq = 0; }
  if (!(Number.isSafeInteger(pState.sigTs) && pState.sigTs >= 0 && pState.sigTs <= now + 864e5)) { if (pst.sigTs != null) clean.notes.push('sigTs reset'); pState.sigTs = 0; }
  /* no usable cursor but data on disk: start 15 min before the newest stored record, so the catch-up (a full page) fetches
     every market since then by ticker instead of only the newest rows. Duplicates are removed in derive. */
  let predTsFrom = 'state file';
  if (!(pState.predTs > 0)) {
    if (hasStore) { pState.predTs = Math.max(0, Math.round(lastStored - 15 * 60e3)); predTsFrom = 'newest stored record minus 15 min (state file ' + (stateProblem || 'had no cursor') + ')'; }
    else { pState.predTs = Math.max(0, now - 25 * 3600e3); predTsFrom = 'first run: back-filled from production memory (up to ~25 h, market by market)'; }
  }
  const kMarkets = {}; for (const [tk, m] of Object.entries((saved.kalshi && saved.kalshi.markets) || {})) if (/^KXBTC15M-[A-Z0-9-]+$/.test(tk) && m && Number.isFinite(m.closeMs)) kMarkets[tk] = m;
  const Q = {};
  /* OBSERVER_LOG_WINDOWS=1: one plain-text line per settled window in the host's (private) log, for operations */
  const wl = process.env.OBSERVER_LOG_WINDOWS === '1' ? require('./lib/windowlog').windowLogger() : null;
  const tap = o => { if (wl) { try { wl.tap(o); } catch (_) { } } };
  const emit = o => { Q.raw.push(o); tap(o); }, hemit = o => { Q.health.push(o); tap(o); };
  const resumed = name => info => hemit(info.droppedRecords > 0
    ? { kind: 'obs.gap', stream: name, from: info.from, to: info.to, reason: 'writes failed (' + info.error + '); ' + info.droppedRecords + ' queued records could not be kept', droppedRecords: info.droppedRecords }
    : { kind: 'obs.writefail', stream: name, from: info.from, to: info.to, error: info.error, note: 'writes failed and were retried: no record was lost (they were stored late)' });
  Q.raw = writeQueue(streams[0], () => ST.openStream(dataDir, 'raw', key), resumed('raw'));
  Q.health = writeQueue(streams[1], () => ST.openStream(dataDir, 'health', key), resumed('health'));
  const ks = kalshiSource({ base: A.kalshi, http: mkClient({ allow: KALSHI_PATHS }), emit, state: { markets: kMarkets } });
  const pr = pinradarSource({ base: pinradar, http: mkClient({ allow: PINRADAR_PATHS }), emit, state: pState, onTickers: tks => ks.track(tks), listTickers: (a, b) => ks.listTickers(a, b) });
  hemit({ kind: 'obs.start', version: VERSION, pid: process.pid, host: os.hostname(), pinradar, at: now, encryptionKid: key.kid || null, signer: signKey ? signerId(crypto.createPublicKey(signKey)) : null,
    recoveredTail: streams[0].recovered || null, healthRecoveredTail: streams[1].recovered || null, staleLock: streams[0].staleLock || streams[1].staleLock || null, waitedForLeaseMs,
    newestStoredRecordAt: hasStore ? lastStored : null, stateFile: stateProblem || 'ok', predTsFrom, primaryRule: { id: D.PRIMARY.id, frozenAt: D.PRIMARY.frozenAt, sha256: D.PRIMARY_SHA256 },
    restoredCursors: { predTs: pState.predTs, ledgerSeq: pState.ledgerSeq, markets: Object.keys(kMarkets).length }, sanitised: clean.notes });
  /* the time not observed is measured from the newest STORED record (not from state.json, which can be lost or stale) */
  if (hasStore) {
    if (!(!stateProblem && saved.cleanStop === true)) hemit({ kind: 'obs.gap', from: lastStored, to: now, reason: stateProblem ? 'observer was not running; state file ' + stateProblem + ' (gap measured from the newest stored record)' : 'observer was not running (crash or host restart)' });
    else if (now - lastStored > 5000) hemit({ kind: 'obs.gap', from: lastStored, to: now, reason: 'observer was stopped' });
  } else if (saved.lastBeat) hemit({ kind: 'obs.gap', from: saved.lastBeat, to: now, reason: 'observer was not running; no stored record found (store empty or removed)' });
  /* three lanes: Kalshi books (1 Hz in the final 300 s) never wait for Kalshi metadata/results or for Pin Radar */
  const lanes = { kbooks: { last: now, every: 250, step: t => ks.stepBooks(t) }, kmeta: { last: now, every: 1000, step: t => ks.stepMeta(t) }, pinradar: { last: now, every: 1000, step: t => pr.step(t) } };
  let stopping = false, errors = 0, lastBeat = now, flushOk = true, lastRefresh = Date.now(), lastState = 0, lastStatus = 0, lastErrPrint = 0;
  const writeState = () => writeDurable(stateFile, JSON.stringify({ pinradar: { ...pr.state }, kalshi: { markets: ks.state.markets }, lastBeat, flushedAt: Date.now(), cleanStop: stopping, version: VERSION }));
  const writeStatus = () => writeDurable(path.join(dataDir, 'status.json'), JSON.stringify({ ok: flushOk, version: VERSION, at: new Date().toISOString(), lastBeat: new Date(lastBeat).toISOString(),
    rawRecords: Q.raw.stream().head().s, queued: { raw: Q.raw.size(), health: Q.health.size() }, errorsSinceStart: errors }));
  /* every second: renew the leases (every 15 s), append what is queued, and save the cursors ONLY when nothing is queued
     (so state.json never points past records that are not on disk) */
  const flush = () => {
    const t = Date.now(); let err = null;
    if (t - lastRefresh > ST.LEASE_MS / 8) { for (const q of [Q.raw, Q.health]) { if (q.stream().isBroken()) continue; try { q.stream().refresh(); } catch (e) { if (e.code === 'ELEASELOST') throw e; err = err || e; } } lastRefresh = t; }
    for (const q of [Q.raw, Q.health]) { try { q.flush(); } catch (e) { if (e.code === 'ELEASELOST' || e.code === 'ELOCKED') throw e; err = err || e; } }
    if (!err && !Q.raw.size() && !Q.health.size() && (stopping || t - lastState >= 5000)) { writeState(); lastState = t; }
    if (stopping || t - lastStatus >= 5000) { try { writeStatus(); } catch (_) { } lastStatus = t; }
    if (err) throw err;
  };
  const fatal = e => { console.error('stopping: ' + e.message); flushOk = false; try { writeStatus(); } catch (_) { } process.exit(3); };
  for (const [name, L] of Object.entries(lanes)) (async () => {
    while (!stopping) {
      const t = Date.now();
      if (t - L.last > 5000) hemit({ kind: 'obs.stall', lane: name, from: L.last, to: t, note: 'lane busy or blocked; coverage is measured from the records themselves' });
      L.last = t;
      try { await L.step(t); } catch (e) { errors++; hemit({ kind: 'obs.error', lane: name, error: String(e && e.message || e) }); }
      await sleep(Math.max(0, L.every - (Date.now() - t)));
    }
  })();
  const hbUrl = A['heartbeat-url'] ? new URL(A['heartbeat-url']) : null;
  const hbClient = hbUrl ? mkClient({ allow: [new RegExp('^' + hbUrl.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')] }) : null;
  const beat = setInterval(() => {
    lastBeat = Date.now();
    const healthy = flushOk && Object.values(lanes).every(L => lastBeat - L.last < 120e3);
    hemit({ kind: 'obs.heartbeat', at: lastBeat, healthy, rawHead: Q.raw.stream().head().s, queued: { raw: Q.raw.size(), health: Q.health.size() }, markets: Object.keys(ks.state.markets).length, predCursor: pr.state.predTs, ledgerSeq: pr.state.ledgerSeq, errors });
    if (signKey) {   /* a checkpoint signed with the host's key: the heads of raw and health as they stand on disk */
      try { flush(); } catch (_) { }
      const body = { kind: 'obs.checkpoint', at: lastBeat, version: VERSION, heads: { raw: Q.raw.stream().head(), health: Q.health.stream().head() } };
      hemit({ ...body, sig: crypto.sign(null, Buffer.from(canon(body)), signKey).toString('base64'), signer: signerId(crypto.createPublicKey(signKey)) });
    }
    if (healthy && hbClient) hbClient.get(hbUrl.toString()).catch(() => { });
  }, Number(process.env.OBSERVER_BEAT_MS || 60e3));
  const fl = setInterval(() => {
    try { flush(); flushOk = true; }
    catch (e) {
      if (e.code === 'ELEASELOST' || e.code === 'ELOCKED') return fatal(e);
      errors++; flushOk = false;
      if (Date.now() - lastErrPrint > 60e3) { lastErrPrint = Date.now(); console.error('write failed (records kept in memory and retried; ' + (Q.raw.size() + Q.health.size()) + ' queued): ' + e.message); }
    }
  }, 1000);
  const stop = () => {
    if (stopping) return; stopping = true; lastBeat = Date.now(); hemit({ kind: 'obs.stop', at: lastBeat }); clearInterval(beat); clearInterval(fl);
    /* records still queued after a write failure will not be written by this process: record the interval as a gap */
    try { flush(); } catch (_) { }
    for (const [name, q] of [['raw', Q.raw], ['health', Q.health]]) if (q.size()) hemit({ kind: 'obs.gap', stream: name, from: q.pendingSince(), to: Date.now(), reason: q.size() + ' records could not be written before the observer stopped', droppedRecords: q.size() });
    try { flush(); } catch (e) { console.error('final write failed (' + e.message + '): the next start records the gap from the newest stored record'); }
    for (const q of [Q.raw, Q.health]) { try { q.stream().close(); } catch (_) { } }
    process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.log(`[${VERSION}] observing ${pinradar} (read-only); data in ${dataDir}`);
}

/* ------------------------------------------------------ verification helpers ------------------------------------------------------ */
/* a forward cursor over a stream's chain: the hash of record seq. Ascending queries walk the chain ONCE; a query behind the
   cursor (never the case for checkpoints written by one observer) falls back to a single lookup */
function chainCursor(dir, name) {
  let it = null, cur = null, done = false;
  return seq => {
    if (!it) it = ST.chain(dir, name);
    if (cur && cur.s === seq) return cur.h;
    if (cur && cur.s > seq) return ST.hashAt(dir, name, seq);
    while (!done) { let n; try { n = it.next(); } catch (_) { done = true; break; } if (n.done) { done = true; break; } cur = n.value; if (cur.s === seq) return cur.h; if (cur.s > seq) return null; }
    return null;
  };
}
function checkpoints(dataDir, key, signPub) {
  const pubKey = crypto.createPublicKey(fs.readFileSync(signPub)); const sid = signerId(pubKey);
  const out = { checkpoints: 0, bad: [], lastSigned: {}, signer: sid };
  const cur = { raw: chainCursor(dataDir, 'raw'), health: chainCursor(dataDir, 'health') };
  for (const r of ST.readStream(dataDir, 'health', key)) {
    if (r.kind !== 'obs.checkpoint') continue;
    const body = { kind: r.kind, at: r.at, version: r.version, heads: r.heads };
    const okSig = r.signer === sid && crypto.verify(null, Buffer.from(canon(body)), pubKey, Buffer.from(String(r.sig), 'base64'));
    if (!okSig) { out.bad.push({ s: r.s, why: 'signature invalid or from another key' }); continue; }
    for (const [st, h] of Object.entries(r.heads || {})) {
      if (!cur[st] || !h || !(h.s > 0)) continue;
      if (cur[st](h.s) !== h.h) out.bad.push({ s: r.s, why: 'signed head ' + st + '@' + h.s + ' is not in the chain (history rewritten)' });
      else out.lastSigned[st] = Math.max(out.lastSigned[st] || 0, h.s);
    }
    out.checkpoints++;
  }
  return out;
}
/* every anchored head must still be in the chain; one walk per stream, however many anchors */
function anchorsCheck(dir, file) {
  const want = {}, list = [], bad = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    let a; try { a = JSON.parse(l); } catch (_) { bad.push('an anchor line is not JSON (the anchor file is damaged)'); continue; }
    if (!STREAMS.includes(a.stream) || !Number.isSafeInteger(a.s) || a.s <= 0) continue;
    (want[a.stream] = want[a.stream] || []).push(a.s); list.push(a);
  }
  const got = Object.fromEntries(Object.entries(want).map(([st, seqs]) => [st, ST.hashesAt(dir, st, seqs)]));
  for (const a of list) { const h = got[a.stream].get(a.s) || null; if (h !== a.h) bad.push(a.stream + '@' + a.s + (h == null ? ' missing (history cut or rolled back)' : ' differs (history rewritten)')); }
  return bad;
}
function verifyAll(dataDir, key) { const out = {}; for (const s of STREAMS) if (fs.existsSync(path.join(dataDir, s))) out[s] = ST.verify(dataDir, s, key); return out; }

/* ---------------------------------------------------------------- main ---------------------------------------------------------------- */
async function main() {
  if (cmd === 'keygen') { const f = A.key || die('--key <file>'); newFile(f, ST.newKey() + '\n'); console.log('symmetric key (tests only) written to ' + f); return; }
  if (cmd === 'keypair') {
    const pfx = A.out || die('--out <prefix>'); const kp = ST.newKeyPair(process.env.OBSERVER_KEY_PASSPHRASE || null);
    newFile(pfx + '.private.pem', kp.priv); try { fs.writeFileSync(pfx + '.public.pem', kp.pub, { flag: 'wx', mode: 0o644 }); } catch (e) { die('refusing to write ' + pfx + '.public.pem: ' + e.message); }
    console.log('public key (copy to the observer host): ' + pfx + '.public.pem\nprivate key (keep on your computer, back it up, never on the host): ' + pfx + '.private.pem'); return;
  }
  if (cmd === 'signkey') {
    const pfx = A.out || die('--out <prefix>'); const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    newFile(pfx + '.sign.pem', privateKey.export({ type: 'pkcs8', format: 'pem' })); try { fs.writeFileSync(pfx + '.sign.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 }); } catch (e) { die(e.message); }
    console.log('signing key (stays on the observer host): ' + pfx + '.sign.pem\nverification key (give to the owner): ' + pfx + '.sign.pub.pem\nsigner id ' + signerId(publicKey)); return;
  }
  if (cmd === 'run') return run();
  if (cmd === 'restore-test') return restoreTest();
  const dataDir = A.data || die('--data required');
  const key = A.key ? ST.loadKey(A.key) : null;
  if (cmd === 'anchor') {
    const f = A.out || die('--out <anchor file kept off the host>'); const v = verifyAll(dataDir, null); const at = new Date().toISOString();
    for (const [s, r] of Object.entries(v)) { if (!r.ok) die('stream ' + s + ' does not verify (' + r.why + '): not anchored'); if (r.seq > 0) fs.appendFileSync(f, JSON.stringify({ at, stream: s, s: r.seq, h: r.head }) + '\n', { mode: 0o600 }); }
    console.log('anchored ' + Object.keys(v).length + ' stream heads in ' + f + ' (keep this file off the host)'); return;
  }
  if (cmd === 'verify') {
    if (key) auditOrDie(dataDir, key, 'verify');
    const out = { streams: verifyAll(dataDir, key) };
    let ok = Object.values(out.streams).every(v => v.ok);
    if (A['sign-pub']) { if (!key || key.type === 'pub') die('--sign-pub needs the private key (checkpoints are encrypted)'); out.checkpoints = checkpoints(dataDir, key, A['sign-pub']);
      out.checkpoints.unsignedTail = Object.fromEntries(['raw', 'health'].map(s => [s, (out.streams[s] ? out.streams[s].seq : 0) - (out.checkpoints.lastSigned[s] || 0)]));
      ok = ok && !out.checkpoints.bad.length && out.checkpoints.checkpoints > 0; }
    if (A.anchors) { out.anchorFailures = anchorsCheck(dataDir, A.anchors); ok = ok && !out.anchorFailures.length; }
    out.proves = 'chain: no record altered, inserted, removed or reordered after the first; ' + (key && key.type !== 'pub' ? 'payloads: authentic for the key holder (in public-key mode this shows "encrypted to the owner", not "written by the observer"); ' : '')
      + (A['sign-pub'] ? 'checkpoints: the observer host signed these heads; ' : 'NO checkpoint check (--sign-pub): a rewrite by anyone holding the public key would not be detected; ')
      + (A.anchors ? 'anchors: history up to each anchor is unchanged.' : 'NO anchor check (--anchors): a cut of the newest records would not be detected.');
    console.log(JSON.stringify(out, null, 1)); process.exit(ok ? 0 : 1);
  }
  const needPriv = () => { if (!key || key.type === 'pub') die('--key <private key> required for ' + cmd); };
  if (cmd === 'derive' || cmd === 'report') {
    needPriv();
    if (A.out && (A.out === true || fs.existsSync(A.out))) die('refusing to write ' + A.out + ': ' + (A.out === true ? '--out needs a file name' : 'it already exists (choose a new file)'));
    const sinceMs = parseT(A.since, 'since'), untilMs = parseT(A.until, 'until');
    auditOrDie(dataDir, key, cmd + (A.period ? ' ' + A.period : '') + (A.since ? ' since ' + A.since : '') + (A.until ? ' until ' + A.until : ''));
    /* every chain first (no record altered, inserted, removed or reordered). Every raw and health payload is then decrypted
       and authenticated as it is read (any failure stops the run). Reading stops at the verified heads, so records
       appended meanwhile cannot make the two passes disagree. Memory: about a day of rows and books, not the history. */
    const ver = verifyAll(dataDir, null);
    for (const [s, v] of Object.entries(ver)) if (!v.ok) die('stream ' + s + ' does not verify (' + v.why + ' at ' + v.at + '): refusing to ' + cmd);
    const cps = A['sign-pub'] ? checkpoints(dataDir, key, A['sign-pub']) : null;
    if (cps && cps.bad.length) die('checkpoint check failed: ' + JSON.stringify(cps.bad.slice(0, 3)));
    const upTo = name => function* () { if (!ver[name]) return; for (const r of ST.readStream(dataDir, name, key)) { if (r.s > ver[name].seq) return; yield r; } };
    const src = () => (function* () { yield* upTo('raw')(); yield* upTo('health')(); })();
    const failed = e => die('a record could not be read or authenticated (' + e.message + '): refusing to ' + cmd);
    const evidence = { streams: Object.fromEntries(Object.entries(ver).map(([s, v]) => [s, { records: v.records, seq: v.seq, head: v.head }])),
      payloads: 'every raw and health record up to these heads was decrypted and authenticated (AES-256-GCM) while deriving',
      window: { since: sinceMs != null ? new Date(sinceMs).toISOString() : null, until: untilMs != null ? new Date(untilMs).toISOString() : null, by: 'market close time' },
      checkpoints: cps ? { count: cps.checkpoints, lastSigned: cps.lastSigned, signer: cps.signer } : 'not checked (no --sign-pub)' };
    if (cmd === 'report') {
      /* a report keeps only the fields it summarises, one small object per market */
      const slims = []; let d; try { d = D.build(src, { sinceMs, untilMs, onMarket: m => slims.push(R.slim(m)) }); } catch (e) { failed(e); }
      const order = m => (m.market ? m.market.closeTime : '') + '|' + m.ticker;
      slims.sort((a, b) => { const x = order(a), y = order(b); return x < y ? -1 : x > y ? 1 : 0; });
      const out = { version: VERSION, generatedAt: new Date().toISOString(), evidence, clock: d.clock,
        all: R.summarize(slims, { from: sinceMs || 0, to: untilMs || 8.64e15 }), periods: A.period && A.period !== 'all' ? R.periods(slims, A.period) : undefined };
      const ds = ST.openStream(dataDir, 'derived', writerKey(key));
      try { ds.append({ kind: 'derived.report', at: Date.now(), evidence, body: out }); } finally { ds.close(); }
      if (A.out) { newFile(A.out, JSON.stringify(out, null, 1)); console.log('written (decrypted) to ' + A.out); } else console.log(JSON.stringify(out, null, 1));
      return;
    }
    /* derive: each market record is written as soon as it is final (one per line, in the order they become final), so
       the history never has to fit in memory; only the digest of the output goes into the 'derived' stream (the records
       can be rebuilt from the raw records at any time) */
    const hash = crypto.createHash('sha256'); let fd = null, n = 0;
    if (A.out) { try { fd = fs.openSync(A.out, 'wx', 0o600); } catch (e) { die('refusing to write ' + A.out + ': ' + (e.code === 'EEXIST' ? 'it already exists (choose a new file)' : e.message)); } }
    const put = str => { hash.update(str); if (fd != null) fs.writeSync(fd, str); };
    put(JSON.stringify({ version: VERSION, evidence }).slice(0, -1) + ',"markets":[\n');
    let d; try { d = D.build(src, { sinceMs, untilMs, onMarket: m => put((n++ ? ',\n' : '') + JSON.stringify(m)) }); }
    catch (e) { if (fd != null) { fs.closeSync(fd); fs.rmSync(A.out, { force: true }); } failed(e); }
    const { markets: _unused, ...meta } = d;
    put('\n],' + JSON.stringify(meta).slice(1) + '\n');
    if (fd != null) { fs.fsyncSync(fd); fs.closeSync(fd); }
    const digest = hash.digest('hex');
    const ds = ST.openStream(dataDir, 'derived', writerKey(key));
    try { ds.append({ kind: 'derived.markets', at: Date.now(), evidence, markets: n, outputSha256: digest, version: VERSION }); } finally { ds.close(); }
    if (A.out) console.log('written (decrypted) to ' + A.out + ' (' + n + ' markets, sha256 ' + digest + ')');
    else console.log(JSON.stringify({ markets: n, clock: d.clock, evidence, outputSha256: digest }, null, 1));
    return;
  }
  if (cmd === 'export') {
    needPriv();
    const outDir = A.out || die('--out <new or empty dir>');
    if (fs.existsSync(outDir) && (fs.lstatSync(outDir).isSymbolicLink() || fs.readdirSync(outDir).length)) die('export directory must be new or empty (and not a symlink)');
    auditOrDie(dataDir, key, 'export to ' + outDir);
    for (const [s, v] of Object.entries(verifyAll(dataDir, key))) if (!v.ok) die('stream ' + s + ' does not verify: refusing to export');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    for (const s of STREAMS) if (fs.existsSync(path.join(dataDir, s))) {
      const fd = fs.openSync(path.join(outDir, s + '.ndjson'), 'wx', 0o600); for (const r of ST.readStream(dataDir, s, key)) fs.writeSync(fd, JSON.stringify(r) + '\n'); fs.closeSync(fd);
    }
    console.log('exported (decrypted) to ' + outDir); return;
  }
  if (cmd === 'backup') {
    const to = A.to || die('--to <dir>');
    if (!key) die('--key required (the public key is enough: it is used only to write the audit entry)');
    auditOrDie(dataDir, key, 'backup to ' + to);
    const v0 = verifyAll(dataDir, null);
    for (const [s, r] of Object.entries(v0)) if (!r.ok) die('stream ' + s + ' does not verify (' + r.why + '): backup refused (the last good backup is kept as it is)');
    const prevMan = fs.existsSync(path.join(to, 'MANIFEST.json')) ? JSON.parse(fs.readFileSync(path.join(to, 'MANIFEST.json'), 'utf8')) : null;
    const man = { at: new Date().toISOString(), files: {}, heads: null };
    /* the observer may be writing while this runs: only whole lines are copied (a write in progress is left for the next
       backup), and the heads in the manifest are read from the COPY, so they always match what was copied */
    for (const s of STREAMS) for (const f of ST.segments(path.join(dataDir, s))) {
      const rel = s + '/' + path.basename(f), dst = path.join(to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      const all = fs.readFileSync(f), src = all.subarray(0, all.lastIndexOf(0x0a) + 1);
      if (fs.existsSync(dst)) {
        if (fs.lstatSync(dst).isSymbolicLink()) die('backup file ' + rel + ' is a symlink: refused');
        const old = fs.readFileSync(dst);
        if (old.length > src.length) die('backup copy of ' + rel + ' is LONGER than the source: the source may have been cut; investigate (backup left unchanged)');
        if (sha256(src.subarray(0, old.length)) !== sha256(old)) die('backup copy of ' + rel + ' is not a prefix of the source: history differs; investigate (backup left unchanged)');
        if (src.length > old.length) { const fd = fs.openSync(dst, 'a', 0o600); try { fs.writeFileSync(fd, src.subarray(old.length)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      } else { const fd = fs.openSync(dst, 'wx', 0o600); try { fs.writeFileSync(fd, src); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
      man.files[rel] = sha256file(dst);
      if (man.files[rel] !== sha256(src)) die('backup copy differs from the source after copying: ' + rel);
    }
    if (prevMan) for (const rel of Object.keys(prevMan.files || {})) if (!man.files[rel]) die('segment ' + rel + ' is in the previous backup but missing from the source: refused');
    const v = verifyAll(to, null);
    for (const [s, r] of Object.entries(v)) if (!r.ok) die('the backup copy of ' + s + ' does not verify (' + r.why + '): manifest not written');
    man.heads = Object.fromEntries(Object.entries(v).map(([s, r]) => [s, { s: r.seq, h: r.head }]));
    fs.writeFileSync(path.join(to, 'MANIFEST-' + man.at.replace(/[:.]/g, '-') + '.json'), JSON.stringify(man, null, 1), { flag: 'wx', mode: 0o600 });
    writeDurable(path.join(to, 'MANIFEST.json'), JSON.stringify(man, null, 1));
    console.log('backed up ' + Object.keys(man.files).length + ' segments to ' + to); return;
  }
  die('unknown command');
}

/* restore the backup into a temporary directory, check every file against the manifest, verify every stream, and check that
   every head recorded by every earlier manifest is still in the restored chains (a rollback or rewrite fails) */
function restoreTest() {
  const from = A.from || die('--from <backup dir>'), key = ST.loadKey(A.key || die('--key'));
  const man = JSON.parse(fs.readFileSync(path.join(from, 'MANIFEST.json'), 'utf8'));
  const rels = Object.keys(man.files || {});
  if (!rels.length) die('restore: the manifest lists no files');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observer_restore_'));
  let code = 1;
  try {
    for (const rel of rels) {
      if (!SEG_RE.test(rel)) throw new Error('restore: unexpected path in manifest: ' + rel);
      const src = path.join(from, rel); const st = fs.lstatSync(src); if (!st.isFile()) throw new Error('restore: not a regular file: ' + rel);
      const dst = path.resolve(tmp, rel); if (!dst.startsWith(tmp + path.sep)) throw new Error('restore: path escapes the restore directory: ' + rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 }); fs.copyFileSync(src, dst);
      if (sha256file(dst) !== man.files[rel]) throw new Error('restore: checksum mismatch ' + rel);
    }
    const out = { restored: rels.length, verify: verifyAll(tmp, key), headChecks: [] };
    let ok = Object.values(out.verify).every(v => v.ok);
    const manifests = fs.readdirSync(from).filter(f => /^MANIFEST-.*\.json$/.test(f)).sort();
    const heads = [];
    for (const mf of manifests) { const m = JSON.parse(fs.readFileSync(path.join(from, mf), 'utf8'));
      for (const [s, h] of Object.entries(m.heads || {})) if (STREAMS.includes(s) && h && Number.isSafeInteger(h.s) && h.s > 0) heads.push({ mf, s, h }); }
    const got = {}; for (const s of STREAMS) { const seqs = heads.filter(x => x.s === s).map(x => x.h.s); if (seqs.length) got[s] = ST.hashesAt(tmp, s, seqs); }
    for (const x of heads) { const g = got[x.s].get(x.h.s) || null; if (g !== x.h.h) { ok = false; out.headChecks.push(x.mf + ': ' + x.s + '@' + x.h.s + (g == null ? ' missing' : ' differs')); } }
    for (const [s, h] of Object.entries(man.heads || {})) if (out.verify[s] && (out.verify[s].seq !== h.s || out.verify[s].head !== h.h)) { ok = false; out.headChecks.push('MANIFEST.json: ' + s + ' head differs'); }
    if (A.anchors) { out.anchorFailures = anchorsCheck(tmp, A.anchors); ok = ok && !out.anchorFailures.length; }
    console.log(JSON.stringify(out, null, 1)); code = ok ? 0 : 1;
  } catch (e) { console.error(e.message); code = 1; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { VERSION, writeQueue, anchorsCheck, checkpoints, canon };
