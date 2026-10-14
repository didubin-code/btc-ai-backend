/* BTC Pin Radar 2.7 — official BRTI history check (run it yourself; it needs YOUR Kalshi API key with the
   CF Benchmarks entitlement; nothing is sent anywhere except Kalshi).
   What it does:
     1. entitlement check: GET /trade-api/v2/cfbenchmarks/values?id=BRTI (signed like the radar's Kalshi calls)
     2. downloads BRTI history hour by hour: GET /trade-api/v2/cfbenchmarks/history/values?id=BRTI&timespan=HOUR&timestamp=...
        (50 read tokens per call: the script waits 600 ms between calls, ~1.7 calls/s)
     3. for every settled KXBTC15M market closing inside those hours: the average of the 60 one-second BRTI values in
        (close - 60 s, close], rounded to the cent, vs Kalshi's official expiration_value and result
     4. writes brti_seconds.ndjson (one line per second: {"t": unix_s, "v": value}) and brti_check.json (per market)
   usage:
     KALSHI_KEY_ID=... KALSHI_PRIVATE_KEY="$(cat key.pem)" node brti_history_check.js --hours 6 [--end 2026-10-13T20:00:00Z] [--out dir]
     optional: KALSHI_API_BASE (default https://api.elections.kalshi.com/trade-api/v2)
   Raw responses are saved (raw_*.json) so the payload format can be inspected if the parser finds nothing. */
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]]) : a), []));
const BASE = (process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/$/, '');
const KEY_ID = (process.env.KALSHI_KEY_ID || '').trim();
const PEM = (process.env.KALSHI_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
const HOURS = Math.max(1, Math.min(24 * 14, Number(args.hours || 6)));
const OUTDIR = path.resolve(String(args.out || 'brti_check_out'));
const END = args.end ? Date.parse(String(args.end)) : Math.floor(Date.now() / 3600000) * 3600000;
const SLEEP_MS = Number(args.sleep || 600);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sign(pathNoQuery) {
  const ts = String(Date.now());
  const sig = crypto.sign('sha256', Buffer.from(ts + 'GET' + pathNoQuery), { key: crypto.createPrivateKey(PEM), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }).toString('base64');
  return { 'KALSHI-ACCESS-KEY': KEY_ID, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts };
}
async function get(rel, signed) {
  const u = new URL(BASE + rel);
  const headers = { 'Accept': 'application/json', 'User-Agent': 'pin-radar-2.7-brti-check' };
  if (signed) Object.assign(headers, sign(u.pathname));            // the signature covers the path WITHOUT the query string
  const r = await fetch(u, { headers });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch (_) { }
  return { status: r.status, json: j, text };
}
/* collect {t, v} pairs from any nesting: objects carrying a value and a time */
function extractTicks(x, out = []) {
  if (Array.isArray(x)) { for (const e of x) extractTicks(e, out); return out; }
  if (x && typeof x === 'object') {
    const v = x.value ?? x.v ?? x.price, t = x.time ?? x.t ?? x.timestamp ?? x.ts;
    const vn = Number(typeof v === 'string' ? v.replace(/,/g, '') : v), tn = typeof t === 'string' && !/^\d+$/.test(t) ? Date.parse(t) : Number(t);
    if (Number.isFinite(vn) && vn > 0 && Number.isFinite(tn) && tn > 1e9) out.push({ tMs: tn < 1e12 ? tn * 1000 : tn, v: vn });
    for (const k of Object.keys(x)) if (x[k] && typeof x[k] === 'object') extractTicks(x[k], out);
  }
  return out;
}
const round2 = x => Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100;
/* one value per second: the last tick at or before each whole second (the 1 Hz observation the settlement uses) */
function perSecond(ticks) {
  const bySec = new Map();
  for (const k of ticks) { const s = Math.ceil(k.tMs / 1000 - 1e-9); const cur = bySec.get(s); if (!cur || k.tMs >= cur.tMs) bySec.set(s, k); }
  return bySec;
}
function windowAverage(bySec, closeS) {
  const vals = [];
  for (let s = closeS - 59; s <= closeS; s++) { const k = bySec.get(s); if (k) vals.push(k.v); }
  return { n: vals.length, avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN };
}
async function settledMarkets(minClose, maxClose) {
  const out = []; let cursor = '';
  for (let page = 0; page < 40; page++) {
    const q = `/markets?series_ticker=KXBTC15M&status=settled&min_close_ts=${Math.floor(minClose / 1000)}&max_close_ts=${Math.floor(maxClose / 1000)}&limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
    const r = await get(q, false);
    if (r.status !== 200 || !r.json) break;
    for (const m of r.json.markets || []) out.push(m);
    cursor = r.json.cursor || ''; if (!cursor) break;
    await sleep(250);
  }
  return out;
}
(async () => {
  if (!KEY_ID || !PEM) { console.error('set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY (the same values your radar uses)'); process.exit(2); }
  fs.mkdirSync(OUTDIR, { recursive: true });
  const ent = await get('/cfbenchmarks/values?id=BRTI', true);
  fs.writeFileSync(path.join(OUTDIR, 'raw_latest.json'), ent.text);
  console.log('entitlement check: HTTP', ent.status, ent.status === 200 ? 'OK (BRTI passthrough available)' : '- ' + ent.text.slice(0, 200));
  if (ent.status !== 200) process.exit(1);
  const ticks = [];
  for (let h = HOURS; h >= 1; h--) {
    const ts = new Date(END - h * 3600000).toISOString();
    const r = await get(`/cfbenchmarks/history/values?id=BRTI&timespan=HOUR&timestamp=${encodeURIComponent(ts)}`, true);
    fs.writeFileSync(path.join(OUTDIR, `raw_${ts.replace(/[:.]/g, '-')}.json`), r.text);
    const got = r.status === 200 && r.json ? extractTicks(r.json.data ?? r.json) : [];
    console.log('hour', ts, 'HTTP', r.status, 'ticks', got.length);
    ticks.push(...got);
    await sleep(SLEEP_MS);
  }
  if (!ticks.length) { console.error('no ticks parsed: inspect the raw_*.json files and send them to me'); process.exit(1); }
  const bySec = perSecond(ticks);
  const secs = [...bySec.keys()].sort((a, b) => a - b);
  fs.writeFileSync(path.join(OUTDIR, 'brti_seconds.ndjson'), secs.map(s => JSON.stringify({ t: s, v: bySec.get(s).v })).join('\n') + '\n');
  const ms = await settledMarkets(END - HOURS * 3600000 + 60000, END - 1000);   // windows fully inside the downloaded hours
  const rows = [];
  for (const m of ms) {
    const closeS = Math.round(Date.parse(m.close_time) / 1000);
    const off = Number(String(m.expiration_value ?? '').replace(/,/g, '')), K = Number(String(m.floor_strike ?? '').replace(/,/g, ''));
    const w = windowAverage(bySec, closeS);
    rows.push({ ticker: m.ticker, close: m.close_time, strike: K, official: off, result: m.result, brtiTicks: w.n, brtiAvg: Number.isFinite(w.avg) ? +w.avg.toFixed(6) : null,
      brtiRounded: Number.isFinite(w.avg) ? round2(w.avg) : null, diffUsd: Number.isFinite(w.avg) && Number.isFinite(off) ? +(round2(w.avg) - off).toFixed(4) : null,
      resultFromBrti: Number.isFinite(w.avg) && Number.isFinite(K) ? (round2(w.avg) >= K ? 'yes' : 'no') : null });
  }
  const full = rows.filter(r => r.brtiTicks === 60 && r.diffUsd != null);
  const exact = full.filter(r => Math.abs(r.diffUsd) < 0.005).length, within1c = full.filter(r => Math.abs(r.diffUsd) <= 0.011).length;
  const resOk = full.filter(r => r.resultFromBrti === r.result).length;
  const summary = { hours: HOURS, end: new Date(END).toISOString(), secondsWithBrti: secs.length, markets: rows.length, marketsWith60Ticks: full.length,
    exactMatch: exact, within1c, resultMatches: resOk, note: 'exact matches confirm the window (close-60 s, close], one value per second and round-to-cent' };
  fs.writeFileSync(path.join(OUTDIR, 'brti_check.json'), JSON.stringify({ summary, rows }, null, 1));
  console.log(JSON.stringify(summary));
})().catch(e => { console.error(e); process.exit(1); });
