/* Test fixture: the REAL production Pin Radar code (btc-ai-backend main:pinradar_server.js, extracted from git, read-only)
   replayed over real historical windows, then served through its OWN HTTP handler, next to a mock of Kalshi's public API.

   * Prices: Binance BTCUSDC 1 Hz (the validation data set); strikes, results and official values: real Kalshi records.
   * The windows are shifted in time so the last one closes LIVE_AFTER seconds after start: its rows are released in real
     time (a row becomes visible only once its timestamp has passed), so the observer sees it the way it would see production.
   * Ground truth is recorded on a separate path: every second's signal straight from computeLockSnapshot (not from the
     prediction log), every book the mock served with the time it served it, and the real results.
   usage: node test/fixture_server.js <outGroundTruth.json>   (prints "READY <pinradarPort> <kalshiPort> <t0>")  */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), zlib = require('zlib'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const DATA = process.env.PR_DATA || '/home/user/data_val';
const REPO = process.env.PR_BACKEND_REPO || path.join(__dirname, '..', '..');
const OUT = process.argv[2];
const N_WIN = Number(process.env.FIX_WINDOWS || 6), LIVE_AFTER = Number(process.env.FIX_LIVE_AFTER || 75), FROM = process.env.FIX_FROM || '2026-08-01T00:00:00Z';
const WARM = Number(process.env.FIX_WARM || 4 * 3600);

/* the production file exactly as on main */
const prodSrc = execFileSync('git', ['-C', REPO, 'show', 'origin/main:pinradar_server.js'], { maxBuffer: 64 << 20 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prfix_'));
const ENGINE = path.join(tmp, 'pinradar_server.js'); fs.writeFileSync(ENGINE, prodSrc);
const prodSha = crypto.createHash('sha256').update(prodSrc).digest('hex');
Object.assign(process.env, { ENABLE_WS: '0', PINRADAR_REPLAY: '1' });
const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
const S = require(ENGINE);

const t0real = Math.floor(realNow() / 1000);
const markets = fs.readFileSync(path.join(DATA, 'kalshi', 'markets_usdc.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  .filter(m => m.closeTs > Date.parse(FROM) / 1000).sort((a, b) => a.closeTs - b.closeTs).slice(0, N_WIN);
const SHIFT = (t0real + LIVE_AFTER) - markets[markets.length - 1].closeTs;           // historical second + SHIFT = served second
const cache = new Map();
function px(t) { const d = new Date(t * 1000).toISOString().slice(0, 10); let a = cache.get(d);
  if (a === undefined) { const f = path.join(DATA, 'sec', 'usdc', d + '.f64'); a = fs.existsSync(f) ? (b => new Float64Array(b.buffer, b.byteOffset, b.length / 8))(fs.readFileSync(f)) : null; cache.set(d, a); }
  if (!a) return NaN; const v = a[t - Date.parse(d + 'T00:00:00Z') / 1000]; return v > 0 ? v : NaN; }
const prints = new Map();
function loadPrints(tk) { if (prints.has(tk)) return prints.get(tk); const f = path.join(DATA, 'kalshi', 'trades', tk + '.json.gz'); let p = [];
  if (fs.existsSync(f)) p = (JSON.parse(zlib.gunzipSync(fs.readFileSync(f))).trades || []).map(x => ({ ms: Date.parse(String(x.created_time).slice(0, 23) + 'Z'), y: Math.round(Number(x.yes_price_dollars) * 1e4) / 100, n: Number(x.count_fp), taker: x.taker_side })).sort((a, b) => a.ms - b.ms);
  prints.set(tk, p); return p; }
/* a book from the prints of the previous 15 s of history (bids per side, Kalshi's public dollar format) */
function histBook(tk, histMs) {
  const yes = new Map(), no = new Map();
  for (const p of loadPrints(tk)) { if (p.ms > histMs) break; if (p.ms <= histMs - 15000) continue;
    if (p.taker === 'yes') no.set(Math.round((100 - p.y) * 100) / 100, (no.get(Math.round((100 - p.y) * 100) / 100) || 0) + p.n); else yes.set(p.y, (yes.get(p.y) || 0) + p.n); }
  const fmt = m => [...m].sort((a, b) => a[0] - b[0]).map(([c, s]) => [(c / 100).toFixed(4), s.toFixed(2)]);
  return { orderbook_fp: { yes_dollars: fmt(yes), no_dollars: fmt(no) } };
}
function engineBook(b) { const f = l => l.map(([p, s]) => [Math.round(Number(p) * 1e4) / 100, Number(s)]); return { yes: f(b.orderbook_fp.yes_dollars), no: f(b.orderbook_fp.no_dollars) }; }

/* ---- replay (same procedure as validation/replay_chrono.js) ---- */
S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20;
S.IDX.ring.length = 0; if (S.BASIS) { S.BASIS.samples.length = 0; S.BASIS.byKey.clear(); }
const VM = [['coinbase', 0.4], ['kraken', -0.4], ['bitstamp', 0]];
const truth = {}; const settleQ = [];
const first = markets[0].closeTs - 900, last = markets[markets.length - 1].closeTs;
let mi = 0;
for (let th = first - WARM; th <= last; th++) {
  const ts = th + SHIFT;
  NOW = ts * 1000 + 100;
  const v = px(th);
  for (const [n, off] of VM) { const V = S.VENUES[n]; if (V && Number.isFinite(v)) Object.assign(V, { mid: v + off, bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 40, lastMsgTs: NOW }); }
  S.sampleIndex();
  while (settleQ.length && settleQ[0].at <= th) { const { m } = settleQ.shift(); const pa = S.proxyWindowAverage((m.closeTs + SHIFT) * 1000); if (pa.n >= 57 && Number.isFinite(m.official)) S.addBasisSample('close:' + (m.closeTs + SHIFT) * 1000, pa.mean, m.official, { ticker: m.ticker, n: pa.n }); }
  while (mi < markets.length && markets[mi].closeTs < th) { settleQ.push({ m: markets[mi], at: markets[mi].closeTs + 5 }); mi++; }
  const m = markets[mi] && markets[mi].closeTs - 900 < th && th <= markets[mi].closeTs ? markets[mi] : null;
  if (!m) continue;
  const closeMs = (m.closeTs + SHIFT) * 1000;
  S.KAL.market = { ticker: m.ticker, strike: m.strike, closeMs, openMs: closeMs - 900e3, status: 'active', yesBid: 50, yesAsk: 51 };
  const tau = m.closeTs - th - 0.75;
  if (!(tau > 0 && tau <= 300)) continue;
  NOW = ts * 1000 + 750; S.KAL.ts = NOW - 120;
  for (const [n] of VM) { const V = S.VENUES[n]; if (V && V.lastQuoteTs > ts * 1000) V.lastQuoteTs = NOW - 50; }
  const b = histBook(m.ticker, th * 1000 + 750); S.KAL.ob = { ticker: m.ticker, ...engineBook(b) }; S.KAL.obTs = NOW - 200;
  const kal = S.getKalshiContext(), liveIdx = S.computeIndex(NOW);
  const used = liveIdx ? Object.values(S.VENUES).filter(x => liveIdx.used.includes(x.name)) : [];
  const age = used.length ? Math.max(...used.map(x => NOW - x.lastQuoteTs)) : Infinity;
  const snap = S.computeLockSnapshot({ now: NOW, kal, strike: kal.strike, strikeIssue: null, overrides: [], quality: S.assessQuality(NOW, kal), liveIdx, liveIndexAgeMs: age, side: null, mutate: true });
  S.predLog27(snap.signal, snap.geo, snap.settle, snap.gates, 0.1);                       // exactly what production's background tick logs
  const sg = snap.signal; (truth[m.ticker] = truth[m.ticker] || []).push({ ts: sg.ts, tau: sg.tau, state: sg.state, side: sg.side, pFlip: sg.pFlip });
}
Date.now = realNow;
/* release the prediction log in real time through production's own /predictions handler */
const pending = S.PRED27.rows.splice(0).sort((a, b) => a.ts - b.ts);
let pi = 0; const release = () => { const n = Date.now(); while (pi < pending.length && pending[pi].ts <= n) S.PRED27.rows.push(pending[pi++]); };
release(); setInterval(release, 50);
const prodServer = S.server; prodServer.listen(0, '127.0.0.1');

/* ---- mock Kalshi public API ---- */
const served = [];
const mkt = m => { const close = (m.closeTs + SHIFT) * 1000, n = Date.now(); const fin = n >= close + 3000;
  return { ticker: m.ticker, open_time: new Date(close - 900e3).toISOString(), close_time: new Date(close).toISOString(), expiration_time: new Date(close + 7 * 864e5).toISOString(),
    floor_strike: m.strike, status: fin ? 'finalized' : n >= close ? 'closed' : 'active', result: fin ? m.result : '', expiration_value: fin ? String(m.official) : '',
    settlement_ts: fin ? new Date(close + 2500).toISOString() : null, rules_primary: 'fixture: real ' + m.ticker + ' shifted by ' + SHIFT + ' s', price_level_structure: 'tapered_deci_cent' }; };
const ks = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (c, o) => { res.statusCode = c; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
  const p = u.pathname.replace(/^\/trade-api\/v2/, '');
  if (p === '/markets') return send(200, { markets: markets.map(mkt).filter(m => m.status === 'active' && Date.parse(m.open_time) <= Date.now()), cursor: '' });
  if (p === '/series/KXBTC15M') return send(200, { series: { ticker: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: 1 } });
  let mm = p.match(/^\/markets\/(KXBTC15M-[A-Z0-9-]+)\/orderbook$/);
  if (mm) { const m = markets.find(x => x.ticker === mm[1]); if (!m) return send(404, {}); const t = Date.now(); const b = histBook(m.ticker, t - SHIFT * 1000);
    const nb = engineBook(b); served.push({ ticker: m.ticker, servedAt: t, bestYesAsk: nb.no.length ? Math.round((100 - Math.max(...nb.no.map(x => x[0]))) * 100) / 100 : null, bestNoAsk: nb.yes.length ? Math.round((100 - Math.max(...nb.yes.map(x => x[0]))) * 100) / 100 : null });
    return send(200, b); }
  mm = p.match(/^\/markets\/(KXBTC15M-[A-Z0-9-]+)$/);
  if (mm) { const m = markets.find(x => x.ticker === mm[1]); return m ? send(200, { market: mkt(m) }) : send(404, {}); }
  return send(404, { error: 'mock: ' + p });
});
ks.listen(0, '127.0.0.1', () => {
  setTimeout(() => console.log('READY ' + prodServer.address().port + ' ' + ks.address().port + ' ' + t0real), 50);
});
const dump = () => { fs.writeFileSync(OUT, JSON.stringify({ prodSha, shift: SHIFT, markets: markets.map(m => ({ ...m, closeMs: (m.closeTs + SHIFT) * 1000 })), truth, served, rows: pending.length })); };
process.on('SIGTERM', () => { dump(); process.exit(0); });
