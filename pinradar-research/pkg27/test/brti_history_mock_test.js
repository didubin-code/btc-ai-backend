/* Mock test of research27/brti_history_check.js: a local server that imitates Kalshi's documented passthrough
   (signed GET, {data:{serverTime,payload}} wrapper) and public markets endpoint. BRTI ticks are SYNTHETIC
   (our 1 Hz index + each window's measured basis, with sub-second jitter and extra 5 Hz ticks), so the 60-tick
   average equals Kalshi's official value by construction: this tests the script (signing, parsing, one value per
   second, window (close-60 s, close], rounding, comparison), not BRTI itself.
   usage: node test/brti_history_mock_test.js */
'use strict';
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), os = require('os');
const W = fs.readFileSync(path.join(__dirname, 'data/consecutive_sample.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
/* pick 3 consecutive hours that are fully covered */
const byClose = new Map(W.map(w => [w.C, w]));
const hourStart = Math.floor((W[0].C - 900) / 3600) * 3600;
const hours = [hourStart, hourStart + 3600, hourStart + 7200];
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_ID = 'mock-key-id';
let sigOk = 0, sigBad = 0;
function verify(req, u) {
  const ts = req.headers['kalshi-access-timestamp'], sg = req.headers['kalshi-access-signature'], kid = req.headers['kalshi-access-key'];
  if (kid !== KEY_ID || !ts || !sg) return false;
  return crypto.verify('sha256', Buffer.from(ts + 'GET' + u.pathname), { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sg, 'base64'));
}
function ticksForHour(h0) {
  const out = [];
  for (let s = h0; s < h0 + 3600; s++) {
    const C = Math.ceil(s / 900) * 900, w = byClose.get(C);
    if (!w) continue;
    const v = w.idx[s - w.T_first]; if (v == null) continue;
    const val = v + (Number.isFinite(w.basis) ? w.basis : 0);
    out.push({ value: val.toFixed(2), time: s * 1000 - 37 });                                   // the 1 Hz value for second s
    out.push({ value: (val + 0.37).toFixed(2), time: s * 1000 - 600 });                         // an earlier intra-second tick
  }
  return out;
}
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname.startsWith('/trade-api/v2/cfbenchmarks/')) {
    if (!verify(req, u)) { sigBad++; return send(401, { error: { code: 'token_authentication_failure' } }); }
    sigOk++;
    if (u.pathname.endsWith('/history/values')) {
      const h0 = Math.floor(Date.parse(u.searchParams.get('timestamp')) / 1000);
      return send(200, { data: { serverTime: new Date().toISOString(), payload: ticksForHour(h0) } });
    }
    return send(200, { data: { serverTime: new Date().toISOString(), payload: [{ value: '68000.12', time: Date.now() }] } });
  }
  if (u.pathname === '/trade-api/v2/markets') {
    const lo = Number(u.searchParams.get('min_close_ts')), hi = Number(u.searchParams.get('max_close_ts'));
    const ms = W.filter(w => w.C >= lo && w.C <= hi).map(w => ({ ticker: w.ticker, close_time: new Date(w.C * 1000).toISOString(), floor_strike: w.K, expiration_value: String(w.A), result: w.yes ? 'yes' : 'no' }));
    return send(200, { markets: ms, cursor: '' });
  }
  send(404, {});
});
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'brti_mock_'));
  const end = new Date((hourStart + 3 * 3600) * 1000).toISOString();
  const ch = spawn(process.execPath, [path.join(__dirname, '../tools/brti_history_check.js'), '--hours', '3', '--end', end, '--out', out, '--sleep', '20'], {
    env: { ...process.env, KALSHI_KEY_ID: KEY_ID, KALSHI_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }), KALSHI_API_BASE: `http://127.0.0.1:${port}/trade-api/v2` } });
  let so = '', se = ''; ch.stdout.on('data', d => so += d); ch.stderr.on('data', d => se += d);
  ch.on('close', status => { srv.close(); const r = { status, stdout: so, stderr: se }; finish(r, out); });
});
function finish(r, out) {
  console.log(r.stdout.trim()); if (r.stderr.trim()) console.log('stderr:', r.stderr.trim().slice(0, 500));
  const res = []; const ok = (n, p, g) => res.push({ n, p: !!p, g });
  ok('script exited 0', r.status === 0, r.status);
  ok('every passthrough request carried a valid RSA-PSS signature over the path without the query', sigOk === 4 && sigBad === 0, `${sigOk} ok / ${sigBad} bad`);
  let j = null; try { j = JSON.parse(fs.readFileSync(path.join(out, 'brti_check.json'), 'utf8')); } catch (_) { }
  const s = j && j.summary;
  ok('markets in the 3 hours found and each window had exactly 60 one-second values', s && s.markets >= 10 && s.marketsWith60Ticks === s.markets, s && JSON.stringify(s));
  ok('rounded 60-value average equals the official value for every market (window, per-second selection, rounding)', s && s.exactMatch === s.marketsWith60Ticks && s.resultMatches === s.marketsWith60Ticks, s && `${s.exactMatch}/${s.marketsWith60Ticks}`);
  for (const x of res) console.log((x.p ? 'PASS ' : 'FAIL ') + x.n + ' :: ' + x.g);
  const f = res.filter(x => !x.p).length; console.log(`brti history mock: ${res.length - f}/${res.length} passed`); process.exit(f ? 1 : 0);
}
