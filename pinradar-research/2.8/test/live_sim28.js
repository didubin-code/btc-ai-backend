/* End-to-end test of the 2.8 LIVE code path on a fake clock.
   16 consecutive real KXBTC15M windows (Jul 21-22 2026, real 1 Hz index paths, real official settlement
   values, strike chain) are driven through the server exactly as live: sampleIndex() every second,
   bgTick() twice a second (the real background classifier -> computeLockSnapshot -> shadow policies ->
   ledger -> tape), rollover via noteWindowClosed(), settlement via finalizeWindow().
   The Kalshi book, the official BRTI messages (value = index + the window's measured basis) and the
   injected faults are SYNTHETIC: this tests mechanics and LIVE/REPLAY identity, not market economics.
   Injected faults: venue-quorum failure (D1), official ticks with an old source time (D2), zero-size book
   levels (D3), stale books, an adverse taker impulse.
   Then: the tape is replayed through a FRESH instance of the same server's computeLockSnapshot (must be
   0 mismatches), the hash chain is verified, endpoints are queried over HTTP.
   usage: node test/live_sim28.js <pinradar_server.js> <consecutive_sample.ndjson>                    */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sim28-'));
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
process.env.TAPE_FILE = path.join(TMP, 'tape.ndjson'); process.env.TAPE_MAX = '100000';
process.env.LEDGER_FILE = path.join(TMP, 'ledger.ndjson');
const SRV = path.resolve(process.argv[2]);
const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
const S = require(SRV);
const { replayTape } = require(path.join(__dirname, '..', 'tools', 'replay_tape28.js'));
const W = fs.readFileSync(process.argv[3], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).sort((a, b) => a.C - b.C);
let seed = 28; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const px = new Map(); for (const w of W) w.idx.forEach((v, i) => { if (v != null) px.set(w.T_first + i, v); });
const results = { ticks: 0, decisions: {}, faults: { quorumTicks: 0, quorumDecisionsNotUnreliable: 0, staleOfficialTicks: 0, impulseTicks: 0 }, settled: 0 };
let fail = 0; const fails = []; const ok = (n, c, g) => { if (!c) { fail++; fails.push(n + ' :: ' + JSON.stringify(g)); } };

for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20;
const startT = W[0].C - 1300, endT = W[W.length - 1].C + 6;
let curMarket = null, pendingFinal = [];
const brtiState = { seq: 1000, sum: 0, cnt: 0, close: null };

for (let T = startT; T <= endT; T++) {
  const x = px.get(T); if (x == null) continue;
  const w = W.find(q => T * 1000 >= (q.C - 900) * 1000 && T * 1000 < q.C * 1000) || null;
  const wi = w ? W.indexOf(w) : -1;
  const tau = w ? w.C - T : NaN;
  NOW = T * 1000 + 100;
  /* venues (D1 fault: window 5, tau 44..38 -> two venues 80 bps apart, third dead) */
  const quorumFault = wi === 4 && tau <= 44 && tau >= 38;
  const vs = S.VENUES;
  if (quorumFault) {
    Object.assign(vs.coinbase, { mid: x * (1 - 0.004), lastQuoteTs: NOW - 30, lastMsgTs: NOW });
    Object.assign(vs.kraken, { mid: x * (1 + 0.004), lastQuoteTs: NOW - 30, lastMsgTs: NOW });
    Object.assign(vs.bitstamp, { mid: NaN, lastQuoteTs: 0, lastMsgTs: 0 });
    results.faults.quorumTicks++;
  } else {
    Object.assign(vs.coinbase, { mid: x + 0.4, bidDepth: 3, askDepth: 3, lastQuoteTs: NOW - 40, lastMsgTs: NOW });
    Object.assign(vs.kraken, { mid: x - 0.4, bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 60, lastMsgTs: NOW });
    Object.assign(vs.bitstamp, { mid: x, bidDepth: 1, askDepth: 1, lastQuoteTs: NOW - 80, lastMsgTs: NOW });
  }
  /* adverse taker impulse for policy D: window 8, tau 60..50, heavy selling on coinbase */
  if (wi === 7 && tau <= 60 && tau >= 50) { for (let k = 0; k < 4; k++) vs.coinbase.trades.push([NOW - 900 + k * 200, -150000, x]); results.faults.impulseTicks++; }
  for (const v of Object.values(vs)) while (v.trades.length && v.trades[0][0] < NOW - 120000) v.trades.shift();
  S.sampleIndex();
  /* Kalshi market record + rollover + settlement */
  if (w && (!curMarket || curMarket.ticker !== w.ticker)) {
    if (curMarket) { S.noteWindowClosed(curMarket); pendingFinal.push({ ticker: curMarket.ticker, at: curMarket.closeMs + 3000, w: curMarket.w }); }
    curMarket = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51, w };
  }
  if (curMarket) { S.KAL.market = curMarket; S.KAL.ts = NOW - 120; }
  for (const pf of pendingFinal.filter(p => NOW >= p.at)) {
    const p = S.SETTLE.pending.get(pf.ticker);
    if (p) { S.finalizeWindow(p, pf.w.yes ? 'yes' : 'no', pf.w.A, 'sim'); results.settled++; }
  }
  pendingFinal = pendingFinal.filter(p => NOW < p.at);
  /* synthetic book in the final 300 s (D3: zero-size levels; some stale books) */
  if (w && tau <= 300) {
    const lead = x >= w.K ? 'UP' : 'DOWN';
    const a = [99.9, 99.8, 99.5, 99, 98.5, 98, 97, 95][Math.floor(R() * 8)];
    const sz = () => [0, 3, 10, 25, 200][Math.floor(R() * 5)];
    const leadAsks = [[a, sz()], [Math.min(99.9, a + 0.5), sz()], [99.9, 500]];
    const lagAsks = [[Math.max(0.5, 101 - a), 300]];
    const toBids = asks => asks.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]);
    const yesAsks = lead === 'UP' ? leadAsks : lagAsks, noAsks = lead === 'UP' ? lagAsks : leadAsks;
    S.KAL.ob = { ticker: w.ticker, yes: toBids(noAsks), no: toBids(yesAsks) };
    S.KAL.obTs = (T % 37 === 0) ? NOW - 2600 : NOW - 150;
  }
  /* official BRTI messages for windows 9-16 (D2: window 12, tau 30..27 delivered with a 9 s old source time) */
  if (w && wi >= 8) {
    const B = Number.isFinite(w.basis) ? w.basis : 0, val = +(x + B).toFixed(2);
    if (brtiState.close !== w.C) { brtiState.close = w.C; brtiState.sum = 0; brtiState.cnt = 0; }
    const inWin = T > w.C - 60 && T <= w.C;
    if (inWin) { brtiState.sum += val; brtiState.cnt++; }
    const staleSrc = wi === 11 && tau <= 30 && tau >= 27; if (staleSrc) results.faults.staleOfficialTicks++;
    const srcT = staleSrc ? (T - 9) * 1000 : T * 1000;
    const msg = { type: 'cfbenchmarks_value', sid: 3, seq: ++brtiState.seq, sending_ts_ms: T * 1000 + 60,
      msg: { index_id: 'BRTI', received_at: T * 1000 + 40, data: JSON.stringify({ type: 'value', id: 'BRTI', time: srcT, value: String(val) }),
        ...(inWin ? { last_60s_windowed_average_15min: { value: (brtiState.sum / brtiState.cnt).toFixed(8), window_size: brtiState.cnt, window_start_ts_ms: w.C * 1000 - 60000, window_end_ts_exclusive: w.C * 1000 + 1 } } : {}) } };
    S.brtiHandle27(msg, T * 1000 + 80, JSON.stringify(msg));
  } else if (wi >= 0 && wi < 8) { S.BRTI.last = null; S.BRTI.win = null; }
  /* the real background classifier, twice a second */
  for (const off of [250, 750]) {
    NOW = T * 1000 + off;
    const snap = S.bgTick(NOW);
    results.ticks++;
    if (snap && snap.signal) {
      const st = snap.signal.state; results.decisions[st] = (results.decisions[st] || 0) + 1;
      if (quorumFault && st !== 'DATA UNRELIABLE') results.faults.quorumDecisionsNotUnreliable++;
    }
  }
}
Date.now = realNow;

/* ---- checks on the live run ---- */
ok('D1: every decision during the injected quorum failure is DATA UNRELIABLE', results.faults.quorumTicks > 0 && results.faults.quorumDecisionsNotUnreliable === 0, results.faults);
ok('all 15 completed windows settled through finalizeWindow', results.settled >= 15, results.settled);
const L = S.L28;
const fileRows = fs.readFileSync(process.env.LEDGER_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const v = S.verifyLedger28(fileRows, L.genesis);
ok('ledger file verifies from genesis (hash chain intact)', v.ok && v.head === L.head, v);
const types = {}; for (const e of fileRows) types[e.type] = (types[e.type] || 0) + 1;
ok('ledger holds boot, window, call, digest and outcome entries', types.boot === 1 && types.window >= 15 && types.call > 15 && types.digest > 10 && types.outcome >= 15, types);
/* commitments precede outcomes: every call for a window is earlier in the chain than its outcome */
const outSeq = new Map(fileRows.filter(e => e.type === 'outcome').map(e => [e.body.ticker, e.seq]));
let late = 0; for (const e of fileRows) if (e.type === 'call' && outSeq.has(e.body.ticker) && e.seq > outSeq.get(e.body.ticker)) late++;
ok('every committed call precedes its window\'s outcome in the chain', late === 0, late);
const sm = S.shadowSummary28(S.SHADOW28.stats);
ok('shadow: all six policies scored the same windows', Object.values(sm).every(s => s.windows === sm['A-2.6'].windows) && sm['A-2.6'].windows >= 15, Object.fromEntries(Object.entries(sm).map(([k, s]) => [k, s.windows])));
ok('shadow: C1 (0.2 %) locks no more windows than A (0.5 %)', sm['C1-strict-0.2'].locked <= sm['A-2.6'].locked, [sm['C1-strict-0.2'].locked, sm['A-2.6'].locked]);
ok('shadow: F (market-pooled) trades no more than A', sm['F-market-pooled-value'].trades <= sm['A-2.6'].trades, [sm['F-market-pooled-value'].trades, sm['A-2.6'].trades]);
/* tape replay through a FRESH server instance */
const tapeLines = fs.readFileSync(process.env.TAPE_FILE, 'utf8').trim().split('\n').map(l => JSON.parse(l));
delete require.cache[SRV];
const S2 = require(SRV);
const rp = replayTape(S2, tapeLines);
ok('LIVE == REPLAY: every recorded decision reproduced exactly by the production function', rp.records > 3000 && rp.mismatches === 0, { records: rp.records, mismatches: rp.mismatches, ex: rp.examples.slice(0, 3) });
/* tape digests in the ledger match the tape */
const crypto = require('crypto');
const recHashes = tapeLines.filter(o => o.k === 'd').map(o => S.sha28(S.canon28(o)));
const digests = fileRows.filter(e => e.type === 'digest'); let pos = 0, dBad = 0;
for (const d of digests) { const h = S.sha28(recHashes.slice(pos, pos + d.body.n).join('')); if (h !== d.body.sha) dBad++; pos += d.body.n; }
ok('tape digests committed in the ledger match the tape records', digests.length > 10 && dBad === 0 && pos <= recHashes.length, { digests: digests.length, bad: dBad, covered: pos, records: recHashes.length });
/* endpoints over HTTP */
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { try { res({ code: r.statusCode, j: JSON.parse(d) }); } catch (e) { res({ code: r.statusCode, raw: d.slice(0, 200) }); } }); }).on('error', rej));
(async () => {
  await new Promise(r => S.server.listen(0, '127.0.0.1', r));
  const port = S.server.address().port;
  const lv = await get(port, '/ledger/verify'), sh = await get(port, '/shadow'), mo = await get(port, '/monitors'), lt = await get(port, '/latency'), tp = await get(port, '/tape'), lg = await get(port, '/ledger?since=0&n=5');
  ok('GET /ledger/verify ok', lv.code === 200 && lv.j.ok === true, lv.j && lv.j.verify);
  ok('GET /shadow returns six policies and a summary', sh.code === 200 && sh.j.policies.length === 6 && sh.j.summary['A-2.6'].windows >= 15, sh.code);
  ok('GET /monitors has failure + edge monitors per policy', mo.code === 200 && Object.keys(mo.j.policies).length === 6, mo.code);
  ok('GET /latency has percentiles', lt.code === 200 && lt.j.latency.bgSnapshotMs && lt.j.latency.bgSnapshotMs.p99 != null, lt.j && lt.j.latency && lt.j.latency.bgSnapshotMs);
  ok('GET /tape and /ledger answer', tp.code === 200 && lg.code === 200 && lg.j.rows.length === 5, [tp.code, lg.code]);
  S.server.close();
  const lat = S.latSummary28(S.LAT28);
  console.log(JSON.stringify({ ticks: results.ticks, decisions: results.decisions, faults: results.faults, ledgerTypes: types, replay: { records: rp.records, mismatches: rp.mismatches, byState: rp.byState },
    shadow: Object.fromEntries(Object.entries(sm).map(([k, s]) => [k, { windows: s.windows, locked: s.locked, lost: s.lost, leadMeanS: s.leadMeanS, trades: s.trades, tradeLosses: s.tradeLosses, pnl: s.pnlCentsPerContractMean }])),
    latencyMs: { bgSnapshot: lat.bgSnapshotMs, decisionIndexInputAge: lat.decisionIndexInputAgeMs, decisionBookAge: lat.decisionBookAgeMs } }));
  console.log(`live_sim28: ${fail ? fail + ' FAILED' : 'all checks passed'}` + (fail ? '\n  FAIL ' + fails.join('\n  FAIL ') : ''));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
