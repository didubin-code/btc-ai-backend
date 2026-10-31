/* Evidence store: append-only, hash-chained, encrypted at rest, crash-safe, single writer.

   One stream = a directory of segment files (<stream>/<YYYY-MM-DD>.jsonl, UTC). Every line is one record:
     data record  { s: seq, t: observer UTC ms, p: previous hash, i: IV, c: ciphertext, g: GCM tag, h: hash }
     key record   { s, t, p, wk: data key wrapped with the owner's public key, kid, h }      (public-key mode)
   * Confidentiality: payload = JSON, raw-DEFLATE compressed, then AES-256-GCM (96-bit IV, 128-bit tag) with s|t|p as AAD.
   * Chain: h = SHA-256 over the record's fields, p = the previous record's h. verify() and readStream() BOTH check
     sequence, previous hash and h of every record: a deleted, inserted, reordered or altered record stops any read.
   * What the chain cannot show by itself: that nobody rewrote the whole history from the start, or cut its end. In
     public-key mode anyone with the PUBLIC key can produce validly encrypted records. That is closed by (a) checkpoints
     signed with the host's own signing key (observer.js run --sign-key) and (b) heads anchored outside the host
     (observer.js anchor / verify --anchors). See README "What verification proves".
   * Crash safety: one write of whole lines + fsync per batch. A final fragment without a newline (torn write) is moved
     byte for byte to <stream>/quarantine/ and recorded; any other damage stops the store from opening (never repaired).
   * Single writer: <stream>/.writer.lock (pid@host); a second writer is refused; a lock left by a dead process is
     taken over and recorded. Segment names never go backwards (a clock stepping back cannot split the chain). */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib'), os = require('os');

const GENESIS = 'GENESIS-pinradar-observer-v1';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const lineHash = r => r.wk ? sha(`${r.s}|${r.t}|${r.p}|wk|${r.wk}|${r.kid}`) : sha(`${r.s}|${r.t}|${r.p}|${r.i}|${r.c}|${r.g}`);
const dayOf = t => new Date(t).toISOString().slice(0, 10);
const MIN_RSA_BITS = 3072;

/* Key files:
     symmetric   32 random bytes, base64            writes and reads (testing; the host could read what it stored)
     public PEM  -----BEGIN PUBLIC KEY-----          WRITE ONLY: the host appends evidence but cannot read it
     private PEM -----BEGIN (ENCRYPTED) PRIVATE KEY- reads everything; keep it with the owner, never on the host;
                                                      a passphrase is read from OBSERVER_KEY_PASSPHRASE
   Symmetric and private key files must not be readable by group or others. */
function loadKey(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  const st = fs.statSync(file);
  if (/BEGIN PUBLIC KEY/.test(raw)) { const pub = crypto.createPublicKey(raw); checkBits(pub); return { type: 'pub', pub, kid: kidOf(pub) }; }
  if ((st.mode & 0o077) !== 0) throw new Error('key file ' + file + ' is readable by group/others (chmod 600 it)');
  if (/BEGIN (RSA |ENCRYPTED )?PRIVATE KEY/.test(raw)) {
    const priv = crypto.createPrivateKey({ key: raw, passphrase: process.env.OBSERVER_KEY_PASSPHRASE || undefined });
    const pub = crypto.createPublicKey(priv); checkBits(pub); return { type: 'priv', priv, pub, kid: kidOf(pub) };
  }
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('observer key must be 32 bytes base64, or a PEM public/private key');
  return { type: 'sym', key: k };
}
function checkBits(pub) { const d = pub.asymmetricKeyDetails; if (pub.asymmetricKeyType !== 'rsa' || !(d && d.modulusLength >= MIN_RSA_BITS)) throw new Error('the encryption key must be RSA with at least ' + MIN_RSA_BITS + ' bits'); }
const kidOf = pub => sha(pub.export({ type: 'spki', format: 'der' }).toString('base64')).slice(0, 16);
const norm = K => Buffer.isBuffer(K) ? { type: 'sym', key: K } : K;
function newKey() { return crypto.randomBytes(32).toString('base64'); }
function newKeyPair(passphrase) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: MIN_RSA_BITS });
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }),
    priv: privateKey.export(passphrase ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase } : { type: 'pkcs8', format: 'pem' }) };
}
const wrap = (pub, dek) => crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dek).toString('base64');
const unwrap = (priv, wk) => crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(wk, 'base64'));

function encrypt(key, s, t, p, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(`${s}|${t}|${p}`));
  const ct = Buffer.concat([c.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'))), c.final()]);
  return { i: iv.toString('base64'), c: ct.toString('base64'), g: c.getAuthTag().toString('base64') };
}
function decrypt(key, r) {
  const iv = Buffer.from(r.i, 'base64'), tag = Buffer.from(r.g, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('bad IV or tag length');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(Buffer.from(`${r.s}|${r.t}|${r.p}`));
  d.setAuthTag(tag);
  return JSON.parse(zlib.inflateRawSync(Buffer.concat([d.update(Buffer.from(r.c, 'base64')), d.final()])).toString('utf8'));
}

function segments(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map(f => path.join(dir, f));
}

/* exclusive writer lock for a stream directory */
function lock(dir) {
  const f = path.join(dir, '.writer.lock'), me = process.pid + '@' + os.hostname();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(f, me, { flag: 'wx', mode: 0o600 }); return { file: f, stale: attempt > 0 }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const [pid, host] = String(fs.readFileSync(f, 'utf8')).split('@');
      let alive = host !== os.hostname();                         // a lock from another host cannot be checked: treat as held
      if (!alive) { try { process.kill(Number(pid), 0); alive = true; } catch (er) { alive = er.code === 'EPERM'; } }
      if (alive) throw new Error('stream ' + dir + ' is locked by another writer (' + pid + '@' + host + '); refusing to fork the chain');
      fs.renameSync(f, f + '.stale.' + Date.now());               // dead writer: keep its lock file as evidence, take over
    }
  }
  throw new Error('could not take the writer lock for ' + dir);
}

/* open (or create) a stream for appending; recovers a torn tail; returns { append, head, close, dir, recovered } */
function openStream(root, name, keyIn, { now = Date.now } = {}) {
  const K = norm(keyIn);
  if (K.type === 'priv') throw new Error('write with the public (or symmetric) key; the private key is for reading');
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lk = lock(dir);
  let dek = K.type === 'sym' ? K.key : null, dekDay = null;
  let head = { s: 0, h: GENESIS }, headDay = null;
  let recovered = null;
  try {
    const segs = segments(dir);
    if (segs.length) {
      const last = segs[segs.length - 1];
      const buf = fs.readFileSync(last);
      const keepBytes = buf.lastIndexOf(0x0a) + 1;
      if (keepBytes < buf.length) {
        const qdir = path.join(dir, 'quarantine'); fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
        const qf = path.join(qdir, path.basename(last) + '.' + now() + '.tail');
        fs.writeFileSync(qf, buf.subarray(keepBytes), { mode: 0o600, flag: 'wx' });
        fs.truncateSync(last, keepBytes);
        recovered = { segment: path.basename(last), bytesQuarantined: buf.length - keepBytes, quarantineFile: path.basename(qf) };
      }
      let tail = null;
      for (let k = segs.length - 1; k >= 0 && !tail; k--) {
        const ls = fs.readFileSync(segs[k], 'utf8').split('\n').filter(Boolean);
        if (ls.length) { try { tail = JSON.parse(ls[ls.length - 1]); } catch (_) { tail = { bad: true }; } }
      }
      if (tail) {
        if (tail.bad || lineHash(tail) !== tail.h) throw new Error('store ' + name + ': the last record does not verify; run verify and investigate (not repaired automatically)');
        head = { s: tail.s, h: tail.h };
      }
      headDay = path.basename(last).slice(0, 10);
    }
  } catch (e) { try { fs.unlinkSync(lk.file); } catch (_) { } throw e; }
  let closed = false;
  const onExit = () => { try { fs.unlinkSync(lk.file); } catch (_) { } };
  const close = () => { if (!closed) { closed = true; process.removeListener('exit', onExit); onExit(); } };
  process.on('exit', onExit);
  function append(objs) {
    if (closed) throw new Error('stream closed');
    const list = Array.isArray(objs) ? objs : [objs];
    if (!list.length) return head;
    const t = now();
    const day = headDay && headDay > dayOf(t) ? headDay : dayOf(t);   // never write to a segment that sorts before the head
    let out = '';
    if (K.type === 'pub' && dekDay !== day) {
      dek = crypto.randomBytes(32); dekDay = day;
      const s = head.s + 1, p = head.h, r = { s, t, p, wk: wrap(K.pub, dek), kid: K.kid };
      r.h = lineHash(r); out += JSON.stringify(r) + '\n'; head = { s, h: r.h };
    }
    for (const o of list) {
      const s = head.s + 1, p = head.h;
      const r = { s, t, p, ...encrypt(dek, s, t, p, o) };
      r.h = lineHash(r);
      out += JSON.stringify(r) + '\n';
      head = { s, h: r.h };
    }
    const f = path.join(dir, day + '.jsonl');
    const fd = fs.openSync(f, 'a', 0o600);
    try { fs.writeSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    headDay = day;
    return head;
  }
  const api = { dir, append, close, head: () => ({ ...head }), recovered, staleLockTakenOver: lk.stale, kid: K.kid || null };
  if (recovered || lk.stale) append({ kind: 'store.recovered', ...(recovered || {}), staleLockTakenOver: lk.stale });
  return api;
}

/* walk a stream checking the chain; yields raw records in order; throws at the first defect */
function* chain(root, name) {
  let prev = GENESIS, s = 0;
  for (const f of segments(path.join(root, name))) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      const at = path.basename(f) + ':' + (i + 1);
      let r; try { r = JSON.parse(l); } catch (_) { throw Object.assign(new Error('not JSON at ' + at), { at, why: 'not JSON' }); }
      if (r.s !== s + 1) throw Object.assign(new Error('sequence gap or duplicate at ' + at), { at, why: 'sequence gap or duplicate (expected ' + (s + 1) + ', got ' + r.s + ')' });
      if (r.p !== prev) throw Object.assign(new Error('chain broken at ' + at), { at, why: 'chain broken (previous hash differs)' });
      if (lineHash(r) !== r.h) throw Object.assign(new Error('record altered at ' + at), { at, why: 'record altered (hash mismatch)' });
      prev = r.h; s = r.s;
      yield r;
    }
  }
}

/* read records in order, chain-checked; with a key, decrypted (throws on any defect). Public-key mode needs the private key. */
function* readStream(root, name, keyIn) {
  const K = keyIn ? norm(keyIn) : null;
  if (K && K.type === 'pub') throw new Error('a public key can only write: reading needs the private key');
  let dek = K && K.type === 'sym' ? K.key : null;
  for (const r of chain(root, name)) {
    if (r.wk) { if (K) dek = unwrap(K.priv, r.wk); continue; }
    yield K ? { s: r.s, t: r.t, ...decrypt(dek, r) } : r;
  }
}

/* verify a stream: chain always; with a symmetric or private key, also authenticate every payload. Reports the head and
   the encryption key ids used (more than one kid = the data was encrypted to more than one owner key). */
function verify(root, name, keyIn = null) {
  const K = keyIn ? norm(keyIn) : null;
  const auth = K && K.type !== 'pub';
  let n = 0, head = GENESIS, s = 0, dek = K && K.type === 'sym' ? K.key : null; const kids = new Set();
  try {
    for (const r of chain(root, name)) {
      if (r.wk) { kids.add(r.kid); if (auth) { try { dek = unwrap(K.priv, r.wk); } catch (_) { return { ok: false, at: r.s, why: 'data key cannot be unwrapped (wrong private key)' }; } } }
      else if (auth) { try { decrypt(dek, r); } catch (_) { return { ok: false, at: r.s, why: 'authentication failed (wrong key or altered ciphertext)' }; } }
      head = r.h; s = r.s; n++;
    }
  } catch (e) { return { ok: false, at: e.at, why: e.why || e.message }; }
  return { ok: true, records: n, seq: s, head, segments: segments(path.join(root, name)).length, payloadsAuthenticated: !!auth, kids: [...kids] };
}
/* the hash of the record with sequence number s (for anchors and checkpoints) */
function hashAt(root, name, seq) { for (const r of chain(root, name)) if (r.s === seq) return r.h; return null; }

module.exports = { openStream, readStream, verify, chain, hashAt, loadKey, newKey, newKeyPair, encrypt, decrypt, lineHash, GENESIS, segments, kidOf };
