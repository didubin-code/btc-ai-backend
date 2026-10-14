/* Live paper test of the 2.7 server: polls /radar like the page does and logs every response, including the 2.7
   settlement panel and decision block (no orders). usage: node paper_logger27.js <base> <out.ndjson> */
'use strict';
const fs = require('fs');
const BASE = process.argv[2] || 'http://127.0.0.1:10127', OUT = process.argv[3];
const out = fs.createWriteStream(OUT, { flags: 'a' });
let inFlight = false, last = null;
async function poll() {
  if (inFlight) return; inFlight = true;
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/radar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contracts: 10 }) });
    const d = await r.json(); const rtt = Date.now() - t0; last = d;
    const s = d.signal || {};
    out.write(JSON.stringify({ t: t0, rtt, ms: d.serverComputeMs, tk: s.ticker, tau: s.tau, st: s.state, side: s.side, pWin: s.pWin, pFlip: s.pFlip,
      pFlipCons: s.pFlipCons, status: s.status, act: s.trade && s.trade.action, ask: s.trade && s.trade.askCents, depth: s.trade && s.trade.depth,
      ev: s.trade && s.trade.evConsCents, bookAge: s.book && s.book.ageMs, idxAge: s.geometry && s.geometry.inputAgeMs, gap: s.geometry && s.geometry.gapUsd,
      sig: s.geometry && s.geometry.sigmaBps, warm: s.geometry && s.geometry.sigmaWarm, reg: s.geometry && s.geometry.regime && s.geometry.regime.bucket,
      hard: s.gates && s.gates.hard, soft: s.gates && s.gates.soft, lvl: d.level, q: d.quality && d.quality.grade, idx: d.index && d.index.value,
      ver: d.version, ref: s.settle && s.settle.reference, n: s.settle && s.settle.recorded, recAvg: s.settle && s.settle.recordedAvg, crit: s.settle && s.settle.criticalRemainingAvg,
      critVs: s.settle && s.settle.criticalVsStrike, move: s.settle && s.settle.requiredMove, offWhy: s.settle && s.settle.officialReasons && s.settle.officialReasons[0], d27: s.display27 || null }) + '\n');
  } catch (e) { out.write(JSON.stringify({ t: t0, err: String(e.message || e) }) + '\n'); }
  finally { inFlight = false; }
}
function loop() {
  const s = last && last.signal; const tau = s && s.closeMs ? (s.closeMs - Date.now()) / 1000 : 999;
  poll(); setTimeout(loop, tau <= 150 && tau > -5 ? 250 : 2000);
}
loop(); console.log('paper logging ->', OUT);
