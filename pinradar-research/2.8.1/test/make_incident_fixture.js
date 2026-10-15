/* Builds a TEST FIXTURE of the Oct 14 incident's mechanism (not Oct 14 data): the unmodified 2.8 server is started
   B seconds before the close of a real window (default: KXBTC15M-26OCT131100-00, real 1 Hz index path, real strike and
   official result), driven exactly as live (sampleIndex every second, the background classifier twice a second, a
   /radar call every second as the page does), and its own endpoints' payloads are written as the user would save them:
   tape.ndjson (/tape?format=ndjson), predictions.json (/predictions), signals.json (/signals), health.json (/health).
   The Kalshi book is SYNTHETIC (a leader ask that tightens as the gap grows); it exists to test the forensic tool.
   usage: node test/make_incident_fixture.js <pinradar_server.js> <outDir> [bootSecondsBeforeClose=330] [ticker] [book=ladder|noedge]
   book 'noedge' reproduces the Oct 15 12:00 ET screens: leader offered at 99.8c, then no leader offers from T-33.   */
'use strict';
const fs = require('fs'), path = require('path');
const SRV = path.resolve(process.argv[2]), OUT = path.resolve(process.argv[3]);
const BOOT = Number(process.argv[4] || 330), TK = process.argv[5] || 'KXBTC15M-26OCT131100-00', BOOK = process.argv[6] || 'ladder';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1'; process.env.TAPE_MAX = '100000';
const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
const DATA = path.join(__dirname, '..', '..', 'pkg27', 'test', 'data');
const W = [];
for (const f of ['replay_sample.ndjson', 'consecutive_sample.ndjson']) for (const l of fs.readFileSync(path.join(DATA, f), 'utf8').split('\n').filter(Boolean)) W.push(JSON.parse(l));
const w = W.find(x => x.ticker === TK); if (!w) throw new Error('window not in sample: ' + TK);
const px = new Map(); w.idx.forEach((v, i) => px.set(w.T_first + i, v));
NOW = (w.C - BOOT) * 1000;
const S = require(SRV);
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  S.KAL.market = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
  for (let T = w.C - BOOT; T <= w.C + 3; T++) {
    const x = px.get(Math.min(T, w.C)); NOW = T * 1000 + 100;
    Object.assign(S.VENUES.coinbase, { mid: x + 0.4, bidDepth: 3, askDepth: 3, lastQuoteTs: NOW - 40, lastMsgTs: NOW });
    Object.assign(S.VENUES.kraken, { mid: x - 0.4, bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 60, lastMsgTs: NOW });
    Object.assign(S.VENUES.bitstamp, { mid: x, bidDepth: 1, askDepth: 1, lastQuoteTs: NOW - 80, lastMsgTs: NOW });
    S.sampleIndex();
    if (T - (w.C - BOOT) === 5) { for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; }
    S.KAL.ts = NOW - 120;
    const tau = w.C - T;
    if (tau > 0) {
      /* synthetic book: the leader's ask tightens with the distance to the strike; empty in the last 2 s */
      const lead = x >= w.K ? 'UP' : 'DOWN', g = Math.abs(x - w.K);
      const a = BOOK === 'noedge' ? (tau <= 33 ? null : 99.8) : (tau <= 2 ? null : Math.min(99.9, Math.round((100 - 40 / (1 + g / 8)) * 10) / 10));
      const leadAsks = a == null ? [] : [[a, 40], [Math.min(99.9, a + 0.3), 200]], lagAsks = [[Math.max(1, Math.round((101 - (a || 99)) * 10) / 10), 300]];
      const toBids = asks => asks.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]);
      S.KAL.ob = { ticker: w.ticker, yes: toBids(lead === 'UP' ? lagAsks : leadAsks), no: toBids(lead === 'UP' ? leadAsks : lagAsks) };
      S.KAL.obTs = NOW - 180;
    }
    for (const off of [250, 750]) { NOW = T * 1000 + off; S.bgTick(NOW); }
    NOW = T * 1000 + 900;
    try { await S.radar({ contracts: 10 }); } catch (_) { /* radar needs the full live context; the background log still records */ }
  }
  NOW = (w.C + 5) * 1000;
  const healthAt = NOW;
  const tapeLines = S.TAPE28.samples.map(p => JSON.stringify({ k: 's', t: p[0], v: p[1] })).concat(S.TAPE28.rows.map(r => JSON.stringify(r)));
  fs.writeFileSync(path.join(OUT, 'tape.ndjson'), tapeLines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT, 'tape.json'), '\uFEFF' + JSON.stringify({ ok: true, version: 'pin-radar-2.8', samples: S.TAPE28.samples.length, records: S.TAPE28.rows.length, dropped: 0, sampleRows: S.TAPE28.samples, rows: S.TAPE28.rows }));   // default /tape JSON, saved with a BOM
  fs.writeFileSync(path.join(OUT, 'ledger.json'), JSON.stringify({ ok: true, rows: S.L28.rows }));
  fs.writeFileSync(path.join(OUT, 'predictions.json'), JSON.stringify({ ok: true, rows: S.PRED27.rows.filter(r => r.ticker === w.ticker) }));
  fs.writeFileSync(path.join(OUT, 'signals.json'), JSON.stringify({ ok: true, signals: S.SIGNAL_LOG }));
  fs.writeFileSync(path.join(OUT, 'health.json'), JSON.stringify({ ok: true, version: 'pin-radar-2.8', uptimeSec: Math.round((healthAt - (w.C - BOOT) * 1000) / 1000), ts: healthAt }));
  fs.writeFileSync(path.join(OUT, 'fixture.json'), JSON.stringify({ ticker: w.ticker, bootSecondsBeforeClose: BOOT, closeIso: new Date(w.C * 1000).toISOString(), healthAt: new Date(healthAt).toISOString(), truth: w.yes ? 'UP' : 'DOWN', book: 'synthetic' }));
  Date.now = realNow;
  console.log(JSON.stringify({ ok: true, tapeRecords: S.TAPE28.rows.length, samples: S.TAPE28.samples.length, predictions: S.PRED27.rows.length, signals: S.SIGNAL_LOG.length }));
  process.exit(0);
})();
