/* Long-run soak of the 2.8 live path on a fake clock: a synthetic random-walk index for N simulated hours,
   96 windows/day with rollover and settlement, bgTick at 2 Hz. Checks that every 2.8 in-memory structure stays
   bounded and that per-tick cost does not grow. SYNTHETIC prices: mechanics only.
   usage: node test/soak28.js <pinradar_server.js> [hours=24]                                               */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const path = require('path');
const realNow = Date.now; let NOW = 0; Date.now = () => NOW;
const S = require(path.resolve(process.argv[2]));
const HOURS = Number(process.argv[3] || 24);
let seed = 7; const R = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const T0 = 1_790_000_100 - (1_790_000_100 % 900), T1 = T0 + HOURS * 3600;
for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20;
let x = 80000, cur = null, strike = 80000; const pend = [], sumWin = new Map();
const snapMem = () => ({ heapMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1), ledger: S.L28.rows.length, tapeRows: S.TAPE28.rows.length, tapeSamples: S.TAPE28.samples.length,
  shadowOpen: S.SHADOW28.windows.size, lat: Object.values(S.LAT28.series).reduce((a, s) => a + s.length, 0), pred: S.PRED27.rows.length, sig: S.SIGNAL_LOG.length,
  settleDone: S.SETTLE.done.length, ledgerOpen: S.LEDGER.open.size, ledgerClosed: S.LEDGER.closed.length, ring: S.IDX.ring.length });
const hourly = []; let tickMs = [], ticks = 0;
for (let T = T0 - 1000; T < T1; T++) {
  x += (R() - 0.5) * 2 * 6 + (R() < 0.0005 ? (R() - 0.5) * 400 : 0);
  NOW = T * 1000 + 100;
  for (const [n, d] of [['coinbase', 0.4], ['kraken', -0.4], ['bitstamp', 0]]) Object.assign(S.VENUES[n], { mid: x + d, bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 40, lastMsgTs: NOW });
  S.sampleIndex();
  const C = Math.ceil((T + 1) / 900) * 900;            // current window closes at C
  /* settlement prints: the second T belongs to the window closing at ceil(T/900)*900 (the close tick included) */
  { const Cp = Math.ceil(T / 900) * 900; if (Cp - T <= 59) sumWin.set('SOAK-' + Cp, (sumWin.get('SOAK-' + Cp) || 0) + x); }
  if (T >= T0) {
    if (!cur || cur.closeMs !== C * 1000) {
      if (cur) { S.noteWindowClosed(cur); pend.push({ tk: cur.ticker, at: cur.closeMs + 3000 }); strike = +(sumWin.get(cur.ticker) / 60).toFixed(2); }
      cur = { ticker: 'SOAK-' + C, strike, closeMs: C * 1000, openMs: (C - 900) * 1000, status: 'active' };
    }
    S.KAL.market = cur; S.KAL.ts = NOW - 100;
    if (C - T <= 300) { const a = [99.9, 99, 98, 97][Math.floor(R() * 4)], lead = x >= cur.strike; S.KAL.ob = { ticker: cur.ticker, yes: lead ? [[2, 300]] : [[100 - a, 200]], no: lead ? [[100 - a, 200]] : [[2, 300]] }; S.KAL.obTs = NOW - 150; }
    for (const p of pend.filter(q => NOW >= q.at)) { const sp = S.SETTLE.pending.get(p.tk); if (sp) { const off = sumWin.get(p.tk) / 60; S.finalizeWindow(sp, off >= sp.strike ? 'yes' : 'no', +off.toFixed(2), 'soak'); sumWin.delete(p.tk); } }
    for (let i = pend.length - 1; i >= 0; i--) if (NOW >= pend[i].at) pend.splice(i, 1);
    for (const off of [250, 750]) { NOW = T * 1000 + off; const t0 = process.hrtime.bigint(); S.bgTick(NOW); tickMs.push(Number(process.hrtime.bigint() - t0) / 1e6); ticks++; }
    if (T % 900 === 0) { NOW = T * 1000 + 900; S.shadowExpire28(NOW); S.heartbeat28(NOW); }
    if ((T - T0) % 3600 === 3599) { const s = [...tickMs].sort((a, b) => a - b); hourly.push({ hour: hourly.length + 1, p50: +s[s.length >> 1].toFixed(3), p99: +s[Math.floor(0.99 * s.length)].toFixed(3), ...snapMem() }); tickMs = []; }
  }
}
Date.now = realNow;
const first = hourly[0], last = hourly[hourly.length - 1];
const v = S.verifyLedger28(S.L28.rows, S.L28.rows[0].seq === 1 ? S.L28.genesis : null);
const res = { hours: HOURS, ticks, scored: S.SHADOW28.scored, first, last, ledgerVerify: v.ok, shadow: S.shadowSummary28(S.SHADOW28.stats)['A-2.6'] };
let fail = 0; const bad = [];
const ok = (n, c, g) => { if (!c) { fail++; bad.push(n + ' :: ' + JSON.stringify(g)); } };
ok('every bounded structure stays within its cap', last.ledger <= 50000 && last.tapeRows <= 3000 && last.tapeSamples <= 4 * 3000 + 1000 && last.shadowOpen <= 3 && last.lat <= 3000 * 12 && last.pred <= 30000 && last.sig <= 5000 && last.settleDone <= 50, last);
ok('per-tick p99 does not grow over the run (last hour <= 3x first hour + 0.5 ms)', last.p99 <= 3 * first.p99 + 0.5, { first: first.p99, last: last.p99 });
ok('heap does not keep growing in the second half (last <= 1.5x the midpoint + 20 MB)', last.heapMB <= 1.5 * hourly[Math.floor(hourly.length / 2)].heapMB + 20, hourly.map(h => h.heapMB));
ok('windows scored ~4 per hour and the chain verifies', S.SHADOW28.scored >= HOURS * 4 - 3 && v.ok, { scored: S.SHADOW28.scored, v });
const A = S.shadowSummary28(S.SHADOW28.stats)['A-2.6'];
ok('harness sanity: synthetic settlements are consistent (LOCKED calls do not lose at a coin-flip rate)', A.locked > 0 && A.lost / A.locked < 0.1, { locked: A.locked, lost: A.lost });
console.log(JSON.stringify(res));
console.log('hourly:', JSON.stringify(hourly.filter((h, i) => i === 0 || (i + 1) % 6 === 0).map(h => ({ h: h.hour, p99: h.p99, heap: h.heapMB, ledger: h.ledger, tape: h.tapeRows, lat: h.lat, ledgerClosed: h.ledgerClosed }))));
console.log(`soak28: ${fail ? fail + ' FAILED\n  ' + bad.join('\n  ') : 'all checks passed'}`);
process.exit(fail ? 1 : 0);
