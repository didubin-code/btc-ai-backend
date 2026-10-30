/* Evidence store: append-only, hash-chained, encrypted at rest, crash-safe.

   One stream = a directory of daily segment files (<stream>/<YYYY-MM-DD>.jsonl, UTC). Every line is one record:
     { s: seq, t: observer UTC ms, p: previous record hash, i: IV, c: ciphertext, g: GCM tag, h: hash }
   * Confidentiality: the payload is compressed (raw DEFLATE) and then AES-256-GCM encrypted with a 32-byte key that only the operator holds (OBSERVER_KEY_FILE);
     seq, time and previous hash are bound as additional authenticated data, so a payload cannot be moved or relabelled.
   * Tamper evidence: h = SHA-256(s|t|p|i|c|g) chains every record to the previous one across segments. The chain can be
     verified WITHOUT the key (verifyChain), and the payloads authenticated WITH the key (verify with decrypt).
   * Crash safety: each append is one write of whole lines followed by fsync. On open, a torn last line (power loss mid-write)
     is moved byte-for-byte to <stream>/quarantine/ (never silently discarded) and a 'store.recovered' record says so.
   Nothing here deletes or rewrites a stored record. */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const GENESIS = 'GENESIS-pinradar-observer-v1';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
/* a data record carries i/c/g; a key record (public-key mode) carries wk = a fresh data key wrapped with the owner's public key */
const lineHash = r => r.wk ? sha(`${r.s}|${r.t}|${r.p}|wk|${r.wk}|${r.kid}`) : sha(`${r.s}|${r.t}|${r.p}|${r.i}|${r.c}|${r.g}`);
const dayOf = t => new Date(t).toISOString().slice(0, 10);

/* Key files:
     symmetric   32 random bytes, base64            the same key writes and reads (the host can read what it stored)
     public PEM  -----BEGIN PUBLIC KEY-----          WRITE ONLY: the host can append evidence but cannot read any of it
     private PEM -----BEGIN PRIVATE KEY-----         reads (and verifies) everything; keep it off the host, with the owner
   Returns { type: 'sym'|'pub'|'priv', key?, pub?, priv?, kid? } (a plain Buffer is accepted as a symmetric key). */
function loadKey(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (/BEGIN PUBLIC KEY/.test(raw)) { const pub = crypto.createPublicKey(raw); return { type: 'pub', pub, kid: kidOf(pub) }; }
  if (/BEGIN (RSA )?PRIVATE KEY/.test(raw)) { const priv = crypto.createPrivateKey(raw); const pub = crypto.createPublicKey(priv); return { type: 'priv', priv, pub, kid: kidOf(pub) }; }
  const k = Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('observer key must be 32 bytes base64, or a PEM public/private key');
  return { type: 'sym', key: k };
}
const kidOf = pub => sha(pub.export({ type: 'spki', format: 'der' }).toString('base64')).slice(0, 16);
const norm = K => Buffer.isBuffer(K) ? { type: 'sym', key: K } : K;
function newKey() { return crypto.randomBytes(32).toString('base64'); }
function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
  return { pub: publicKey.export({ type: 'spki', format: 'pem' }), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const wrap = (pub, dek) => crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dek).toString('base64');
const unwrap = (priv, wk) => crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(wk, 'base64'));

function encrypt(key, s, t, p, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(`${s}|${t}|${p}`));
  const ct = Buffer.concat([c.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), 'utf8'))), c.final()]);   // compressed, then encrypted
  return { i: iv.toString('base64'), c: ct.toString('base64'), g: c.getAuthTag().toString('base64') };
}
function decrypt(key, r) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(r.i, 'base64'));
  d.setAAD(Buffer.from(`${r.s}|${r.t}|${r.p}`));
  d.setAuthTag(Buffer.from(r.g, 'base64'));
  return JSON.parse(zlib.inflateRawSync(Buffer.concat([d.update(Buffer.from(r.c, 'base64')), d.final()])).toString('utf8'));
}

function segments(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map(f => path.join(dir, f));
}

/* open (or create) a stream; recovers a torn tail; returns { append, head, dir } */
function openStream(root, name, keyIn, { now = Date.now } = {}) {
  const K = norm(keyIn);
  if (K.type === 'priv') throw new Error('write with the public (or symmetric) key; the private key is for reading');
  let dek = K.type === 'sym' ? K.key : null, dekDay = null;   // public-key mode: a new data key per day and per process start
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let head = { s: 0, h: GENESIS };
  let recovered = null;
  const segs = segments(dir);
  if (segs.length) {
    const last = segs[segs.length - 1];
    const buf = fs.readFileSync(last);
    /* only a final fragment without a newline is a torn write: it is moved, byte for byte, to quarantine. Anything else
       that does not verify (a corrupt or altered whole line) is evidence: the store refuses to open instead of repairing it. */
    const nl = buf.lastIndexOf(0x0a);
    const keepBytes = nl + 1;
    if (keepBytes < buf.length) {
      const qdir = path.join(dir, 'quarantine'); fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
      const qf = path.join(qdir, path.basename(last) + '.' + now() + '.tail');
      fs.writeFileSync(qf, buf.subarray(keepBytes), { mode: 0o600 });
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
  }
  function append(objs) {
    const list = Array.isArray(objs) ? objs : [objs];
    if (!list.length) return head;
    const t = now();
    let out = '';
    const recs = [];
    if (K.type === 'pub' && dekDay !== dayOf(t)) {
      dek = crypto.randomBytes(32); dekDay = dayOf(t);
      const s = head.s + 1, p = head.h, r = { s, t, p, wk: wrap(K.pub, dek), kid: K.kid };
      r.h = lineHash(r); out += JSON.stringify(r) + '\n'; head = { s, h: r.h };
    }
    for (const o of list) {
      const s = head.s + 1, p = head.h;
      const r = { s, t, p, ...encrypt(dek, s, t, p, o) };
      r.h = lineHash(r);
      out += JSON.stringify(r) + '\n'; recs.push(r);
      head = { s, h: r.h };
    }
    const f = path.join(dir, dayOf(t) + '.jsonl');
    const fd = fs.openSync(f, 'a', 0o600);
    try { fs.writeSync(fd, out); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return head;
  }
  const api = { dir, append, head: () => ({ ...head }), recovered };
  if (recovered) append({ kind: 'store.recovered', ...recovered });
  return api;
}

/* read records in order; with a key, decrypt (throws on any authentication failure). Public-key mode needs the private key. */
function* readStream(root, name, keyIn) {
  const K = keyIn ? norm(keyIn) : null;
  if (K && K.type === 'pub') throw new Error('a public key can only write: reading needs the private key');
  let dek = K && K.type === 'sym' ? K.key : null;
  for (const f of segments(path.join(root, name))) {
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue;
      const r = JSON.parse(l);
      if (r.wk) { if (K) dek = unwrap(K.priv, r.wk); continue; }
      yield K ? { s: r.s, t: r.t, ...decrypt(dek, r) } : r;
    }
  }
}

/* verify the chain of a stream; with a key, also authenticate and decrypt every payload */
function verify(root, name, keyIn = null) {
  const K = keyIn ? norm(keyIn) : null;
  if (K && K.type === 'pub') return verify(root, name, null);           // a public key cannot authenticate payloads: chain only
  let prev = GENESIS, n = 0, s = 0, dek = K && K.type === 'sym' ? K.key : null;
  const segs = segments(path.join(root, name));
  for (const f of segs) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      let r; try { r = JSON.parse(l); } catch (_) { return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'not JSON' }; }
      if (r.s !== s + 1) return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'sequence gap or duplicate (expected ' + (s + 1) + ', got ' + r.s + ')' };
      if (r.p !== prev) return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'chain broken (previous hash differs)' };
      if (lineHash(r) !== r.h) return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'record altered (hash mismatch)' };
      if (K && r.wk) { try { dek = unwrap(K.priv, r.wk); } catch (_) { return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'data key cannot be unwrapped (wrong private key)' }; } }
      else if (K) { try { decrypt(dek, r); } catch (_) { return { ok: false, at: path.basename(f) + ':' + (i + 1), why: 'authentication failed (wrong key or altered ciphertext)' }; } }
      prev = r.h; s = r.s; n++;
    }
  }
  return { ok: true, records: n, head: prev, segments: segs.length };
}

module.exports = { openStream, readStream, verify, loadKey, newKey, newKeyPair, encrypt, decrypt, lineHash, GENESIS, segments };
