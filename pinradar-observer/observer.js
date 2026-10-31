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
     node observer.js backup --data <dir> --to <dir>   append-only copy of the encrypted segments + manifest (with heads)
     node observer.js anchor --data <dir> --out <file> append every stream's head (seq, hash) to an anchor file KEPT OFF the host
   Anywhere (with the private key, on the owner's computer):
     node observer.js verify  --data <dir> [--key <private.pem>] [--sign-pub <host.sign.pub.pem>] [--anchors <file>]
     node observer.js derive  --data <dir> --key <private.pem> [--sign-pub <file>] [--out <new file>]
     node observer.js report  --data <dir> --key <private.pem> [--period daily|weekly|monthly|all] [--out <new file>]
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
const VERSION = 'pinradar-observer-1.1';
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

/* ---------------------------------------------------------------- run ---------------------------------------------------------------- */
async function run() {
  const dataDir = A.data || die('--data required'), key = ST.loadKey(A.key || die('--key required'));
  const pinradar = A.pinradar || die('--pinradar <url> required');
  if (key.type === 'priv') die('run with the PUBLIC key (owner.public.pem): the private key must not be on the observer host');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const realData = fs.realpathSync(dataDir), realKey = fs.realpathSync(A.key);
  if (realKey === realData || realKey.startsWith(realData + path.sep)) die('keep the key file outside the data directory (a backup of the data must not contain the key)');
  const signKey = A['sign-key'] ? loadSignKey(A['sign-key']) : null;
  if (signKey && fs.realpathSync(A['sign-key']).startsWith(realData + path.sep)) die('keep the signing key outside the data directory');
  const raw = ST.openStream(dataDir, 'raw', key), health = ST.openStream(dataDir, 'health', key);
  const stateFile = path.join(dataDir, 'state.json');
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { }
  const now = Date.now();
  /* saved cursors are untrusted input: anything implausible is reset (and said so), never allowed to pause collection */
  const clean = { notes: [] };
  const sanDue = (d, label) => { const o = {}; for (const [k, v] of Object.entries(d || {})) { if (Number.isFinite(v) && v <= now + 3600e3) o[k] = v; else clean.notes.push(label + '.due.' + k + ' reset'); } return o; };
  const pst = saved.pinradar || {};
  const pState = { ...pst, due: sanDue(pst.due, 'pinradar') };
  if (!(Number.isSafeInteger(pState.predTs) && pState.predTs >= 0 && pState.predTs <= now + 864e5)) { if (pst.predTs != null) clean.notes.push('predTs reset'); pState.predTs = 0; }
  if (!(Number.isSafeInteger(pState.ledgerSeq) && pState.ledgerSeq >= 0)) { if (pst.ledgerSeq != null) clean.notes.push('ledgerSeq reset'); pState.ledgerSeq = 0; }
  const kMarkets = {}; for (const [tk, m] of Object.entries((saved.kalshi && saved.kalshi.markets) || {})) if (/^KXBTC15M-[A-Z0-9-]+$/.test(tk) && m && Number.isFinite(m.closeMs)) kMarkets[tk] = m;
  const buf = [], hbuf = [];
  const emit = o => buf.push(o), hemit = o => hbuf.push(o);
  const ks = kalshiSource({ base: A.kalshi, http: mkClient({ allow: KALSHI_PATHS }), emit, state: { markets: kMarkets } });
  const pr = pinradarSource({ base: pinradar, http: mkClient({ allow: PINRADAR_PATHS }), emit, state: pState, onTickers: tks => ks.track(tks), listTickers: (a, b) => ks.listTickers(a, b) });
  hemit({ kind: 'obs.start', version: VERSION, pid: process.pid, host: os.hostname(), pinradar, at: now, encryptionKid: key.kid || null, signer: signKey ? signerId(crypto.createPublicKey(signKey)) : null,
    recoveredTail: raw.recovered || null, restoredCursors: { predTs: pState.predTs, ledgerSeq: pState.ledgerSeq, markets: Object.keys(kMarkets).length }, sanitised: clean.notes });
  if (saved.lastBeat && !saved.cleanStop) hemit({ kind: 'obs.gap', from: saved.lastBeat, to: now, reason: 'observer was not running (crash or host restart)' });
  if (saved.lastBeat && saved.cleanStop && now - saved.lastBeat > 5000) hemit({ kind: 'obs.gap', from: saved.lastBeat, to: now, reason: 'observer was stopped' });
  const lanes = { kalshi: { last: now, every: 250, step: t => ks.step(t) }, pinradar: { last: now, every: 1000, step: t => pr.step(t) } };
  let stopping = false, errors = 0, lastBeat = now, flushOk = true, lastErrorsSeen = 0;
  const flush = () => {
    if (buf.length) raw.append(buf.splice(0));
    if (hbuf.length) health.append(hbuf.splice(0));
    const st = { pinradar: { ...pr.state }, kalshi: { markets: ks.state.markets }, lastBeat, cleanStop: stopping, version: VERSION };
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(st), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile);
    fs.writeFileSync(path.join(dataDir, 'status.json.tmp'), JSON.stringify({ ok: flushOk && errors < 50, version: VERSION, lastBeat: new Date(lastBeat).toISOString(), rawRecords: raw.head().s, errorsSinceStart: errors }), { mode: 0o600 });
    fs.renameSync(path.join(dataDir, 'status.json.tmp'), path.join(dataDir, 'status.json'));
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
  const hbUrl = A['heartbeat-url'] ? new URL(A['heartbeat-url']) : null;
  const hbClient = hbUrl ? mkClient({ allow: [new RegExp('^' + hbUrl.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')] }) : null;
  const beat = setInterval(() => {
    lastBeat = Date.now();
    const healthy = flushOk && Object.values(lanes).every(L => lastBeat - L.last < 120e3) && errors - lastErrorsSeen < 30;
    lastErrorsSeen = errors;
    hemit({ kind: 'obs.heartbeat', at: lastBeat, healthy, rawHead: raw.head().s, markets: Object.keys(ks.state.markets).length, predCursor: pr.state.predTs, ledgerSeq: pr.state.ledgerSeq, errors });
    if (signKey) {   /* a checkpoint signed with the host's key: the heads of raw and health as they stand */
      try { flush(); } catch (_) { }
      const body = { kind: 'obs.checkpoint', at: lastBeat, version: VERSION, heads: { raw: raw.head(), health: health.head() } };
      hemit({ ...body, sig: crypto.sign(null, Buffer.from(canon(body)), signKey).toString('base64'), signer: signerId(crypto.createPublicKey(signKey)) });
    }
    if (healthy && hbClient) hbClient.get(hbUrl.toString()).catch(() => { });
  }, Number(process.env.OBSERVER_BEAT_MS || 60e3));
  const fl = setInterval(() => { try { flush(); flushOk = true; } catch (e) { errors++; flushOk = false; console.error('flush failed: ' + e.message); } }, 1000);
  const stop = () => { if (stopping) return; stopping = true; lastBeat = Date.now(); hemit({ kind: 'obs.stop', at: lastBeat }); clearInterval(beat); clearInterval(fl); try { flush(); } catch (_) { } raw.close(); health.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  console.log(`[${VERSION}] observing ${pinradar} (read-only); data in ${dataDir}`);
}

/* ------------------------------------------------------ verification helpers ------------------------------------------------------ */
function checkpoints(dataDir, key, signPub) {
  const pubKey = crypto.createPublicKey(fs.readFileSync(signPub)); const sid = signerId(pubKey);
  const out = { checkpoints: 0, bad: [], lastSigned: {}, signer: sid };
  for (const r of ST.readStream(dataDir, 'health', key)) {
    if (r.kind !== 'obs.checkpoint') continue;
    const body = { kind: r.kind, at: r.at, version: r.version, heads: r.heads };
    const okSig = r.signer === sid && crypto.verify(null, Buffer.from(canon(body)), pubKey, Buffer.from(String(r.sig), 'base64'));
    if (!okSig) { out.bad.push({ s: r.s, why: 'signature invalid or from another key' }); continue; }
    for (const [st, h] of Object.entries(r.heads || {})) { if (h.s > 0 && ST.hashAt(dataDir, st, h.s) !== h.h) out.bad.push({ s: r.s, why: 'signed head ' + st + '@' + h.s + ' is not in the chain (history rewritten)' }); else out.lastSigned[st] = h.s; }
    out.checkpoints++;
  }
  return out;
}
function anchorsCheck(dir, file) {
  const bad = [];
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    const a = JSON.parse(l); if (!STREAMS.includes(a.stream) || !Number.isSafeInteger(a.s)) continue;
    const h = ST.hashAt(dir, a.stream, a.s);
    if (h !== a.h) bad.push(a.stream + '@' + a.s + (h == null ? ' missing (history cut or rolled back)' : ' differs (history rewritten)'));
  }
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
    auditOrDie(dataDir, key, cmd + (A.period ? ' ' + A.period : ''));
    const ver = verifyAll(dataDir, key);
    for (const [s, v] of Object.entries(ver)) if (!v.ok) die('stream ' + s + ' does not verify (' + v.why + ' at ' + v.at + '): refusing to ' + cmd);
    const cps = A['sign-pub'] ? checkpoints(dataDir, key, A['sign-pub']) : null;
    if (cps && cps.bad.length) die('checkpoint check failed: ' + JSON.stringify(cps.bad.slice(0, 3)));
    const raw = [...ST.readStream(dataDir, 'raw', key), ...(fs.existsSync(path.join(dataDir, 'health')) ? ST.readStream(dataDir, 'health', key) : [])];
    const d = D.build(raw);
    const evidence = { streams: Object.fromEntries(Object.entries(ver).map(([s, v]) => [s, { records: v.records, seq: v.seq, head: v.head }])), checkpoints: cps ? { count: cps.checkpoints, lastSigned: cps.lastSigned, signer: cps.signer } : 'not checked (no --sign-pub)' };
    const out = cmd === 'derive' ? { version: VERSION, evidence, ...d } : { version: VERSION, generatedAt: new Date().toISOString(), evidence, clock: d.clock,
      all: R.summarize(d.markets), periods: A.period && A.period !== 'all' ? R.periods(d.markets, A.period) : undefined };
    const ds = ST.openStream(dataDir, 'derived', writerKey(key));
    try { ds.append({ kind: cmd === 'derive' ? 'derived.markets' : 'derived.report', at: Date.now(), evidence, body: out }); } finally { ds.close(); }
    if (A.out) { newFile(A.out, JSON.stringify(out, null, 1)); console.log('written (decrypted) to ' + A.out); } else console.log(JSON.stringify(cmd === 'report' ? out : { markets: d.markets.length, clock: d.clock, evidence }, null, 1));
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
    const v = verifyAll(dataDir, null);
    for (const [s, r] of Object.entries(v)) if (!r.ok) die('stream ' + s + ' does not verify (' + r.why + '): backup refused (the last good backup is kept as it is)');
    const prevMan = fs.existsSync(path.join(to, 'MANIFEST.json')) ? JSON.parse(fs.readFileSync(path.join(to, 'MANIFEST.json'), 'utf8')) : null;
    const man = { at: new Date().toISOString(), files: {}, heads: Object.fromEntries(Object.entries(v).map(([s, r]) => [s, { s: r.seq, h: r.head }])) };
    for (const s of STREAMS) for (const f of ST.segments(path.join(dataDir, s))) {
      const rel = s + '/' + path.basename(f), dst = path.join(to, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
      const src = fs.readFileSync(f);
      if (fs.existsSync(dst)) {
        if (fs.lstatSync(dst).isSymbolicLink()) die('backup file ' + rel + ' is a symlink: refused');
        const old = fs.readFileSync(dst);
        if (old.length > src.length) die('backup copy of ' + rel + ' is LONGER than the source: the source may have been cut; investigate (backup left unchanged)');
        if (sha256(src.subarray(0, old.length)) !== sha256(old)) die('backup copy of ' + rel + ' is not a prefix of the source: history differs; investigate (backup left unchanged)');
        if (src.length > old.length) fs.appendFileSync(dst, src.subarray(old.length));
      } else fs.writeFileSync(dst, src, { flag: 'wx', mode: 0o600 });
      man.files[rel] = sha256file(dst);
      if (man.files[rel] !== sha256(src)) die('backup copy differs from the source after copying: ' + rel);
    }
    if (prevMan) for (const rel of Object.keys(prevMan.files || {})) if (!man.files[rel]) die('segment ' + rel + ' is in the previous backup but missing from the source: refused');
    fs.writeFileSync(path.join(to, 'MANIFEST-' + man.at.replace(/[:.]/g, '-') + '.json'), JSON.stringify(man, null, 1), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(to, 'MANIFEST.json.tmp'), JSON.stringify(man, null, 1), { mode: 0o600 }); fs.renameSync(path.join(to, 'MANIFEST.json.tmp'), path.join(to, 'MANIFEST.json'));
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
    for (const mf of manifests) { const m = JSON.parse(fs.readFileSync(path.join(from, mf), 'utf8'));
      for (const [s, h] of Object.entries(m.heads || {})) if (h.s > 0) { const got = ST.hashAt(tmp, s, h.s); if (got !== h.h) { ok = false; out.headChecks.push(mf + ': ' + s + '@' + h.s + (got == null ? ' missing' : ' differs')); } } }
    for (const [s, h] of Object.entries(man.heads || {})) if (out.verify[s] && (out.verify[s].seq !== h.s || out.verify[s].head !== h.h)) { ok = false; out.headChecks.push('MANIFEST.json: ' + s + ' head differs'); }
    if (A.anchors) { out.anchorFailures = anchorsCheck(tmp, A.anchors); ok = ok && !out.anchorFailures.length; }
    console.log(JSON.stringify(out, null, 1)); code = ok ? 0 : 1;
  } catch (e) { console.error(e.message); code = 1; }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.exit(code);
}

if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
module.exports = { VERSION };
