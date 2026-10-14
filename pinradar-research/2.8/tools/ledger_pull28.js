#!/usr/bin/env node
/* Pull a running 2.8 server's hash-chained ledger into a local append-only file, verifying the chain on
   every pull. Safe to run from cron every few minutes. Handles restarts: when the server restarted without a
   persistent ledger file, a new chain (seq 1) begins; it is appended as a new segment and verified on its own.
   usage: node tools/ledger_pull28.js https://btc-pin-radar-28.onrender.com ledger28.ndjson [--anchors anchors28.txt]
   exit codes: 0 ok · 3 FORK (nothing appended) · 4 appended, but the server has entries it could not store yet  */
'use strict';
const fs = require('fs'), path = require('path');
const C = require(path.join(__dirname, '..', 'src', 'core28.js'));
async function main() {
  const base = String(process.argv[2] || '').replace(/\/+$/, ''), file = process.argv[3] || 'ledger28.ndjson';
  if (!base) { console.error('usage: node tools/ledger_pull28.js <server url> [file]'); process.exit(2); }
  /* a previous pull cut mid-write leaves a final fragment without a newline: cut it off (it is re-pulled) */
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text && !text.endsWith('\n')) { const keep = text.lastIndexOf('\n') + 1; fs.truncateSync(file, Buffer.byteLength(text.slice(0, keep))); text = text.slice(0, keep); console.error('dropped a torn final line from the previous pull'); }
  const have = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const last = have.length ? have[have.length - 1] : null;
  const info = await (await fetch(base + '/ledger?since=0&n=1')).json();
  /* chain identity = hash of the chain's seq-1 entry (the genesis is the same for every chain of one configuration) */
  let ourChain = null; for (let i = have.length - 1; i >= 0; i--) if (have[i].seq === 1) { ourChain = have[i].hash; break; }
  const fork = why => { console.error(`FORK: ${why}. Nothing appended. Keep this file as evidence and investigate; continuing would need a new file (G2 will fail).`); process.exit(3); };
  let since = 0;
  if (last && info.chainId && ourChain) {
    if (info.chainId !== ourChain) since = 0;                                    // a new chain (restart without the file): appended as a new segment from seq 1
    else {
      if (info.seq < last.seq) fork(`the server's chain is at seq ${info.seq}, behind our ${last.seq} on the same chain (it resumed from a shorter file)`);
      const chk = await (await fetch(`${base}/ledger?since=${last.seq - 1}&n=1`)).json();
      if (chk.rows && chk.rows[0] && chk.rows[0].seq === last.seq) { if (chk.rows[0].hash !== last.hash) fork(`the server's entry ${last.seq} differs from ours on the same chain`); since = last.seq; }
      else if (chk.inMemoryFrom && chk.inMemoryFrom > last.seq) { console.error('GAP: the server no longer holds the entries after our last one (in-memory window moved on). The gap stays visible and fails G2 in forward_report28; pull more often or use a persistent disk'); since = chk.inMemoryFrom - 1; }
      else since = last.seq;                                                      // our last entry is not served (yet): nothing new is durable
    }
  } else if (last && info.seq >= last.seq) {                                     // server without chainId (older build): compare the entry at our last seq
    const chk = await (await fetch(`${base}/ledger?since=${last.seq - 1}&n=1`)).json();
    if (chk.rows && chk.rows[0] && chk.rows[0].hash === last.hash) since = last.seq;
    else if (chk.inMemoryFrom && chk.inMemoryFrom > last.seq) { console.error('GAP: the server no longer holds the entries after our last one'); since = chk.inMemoryFrom - 1; }
  }
  const rows = [];
  for (;;) {
    const page = await (await fetch(`${base}/ledger?since=${since + rows.length}&n=5000`)).json();
    if (!page.rows || !page.rows.length) break;
    rows.push(...page.rows); if (page.rows.length < 5000) break;
  }
  const anchorsFile = (() => { const i = process.argv.indexOf('--anchors'); return i > 0 ? process.argv[i + 1] : null; })();
  /* the head of the PULLED file is what you publish (--anchors appends it with a time); /ledger/verify's head can include entries not yet pulled */
  const recordAnchor = (seq, head) => { if (anchorsFile && head) fs.appendFileSync(anchorsFile, `${new Date().toISOString()} ${seq} ${head}\n`); };
  const durableWarn = () => { if (info.pendingWrites > 0) { console.error(`WARNING: ${info.pendingWrites} entries are not yet on the server's disk (disk problem? see /v28 ledger.fileErr). They are not served until stored.`); return true; } return false; };
  if (!rows.length) { recordAnchor(last && last.seq, last && last.hash); console.log(JSON.stringify({ ok: true, appended: 0, head: last && last.hash })); process.exit(durableWarn() ? 4 : 0); }
  const contiguous = last && rows[0].seq === last.seq + 1 && rows[0].prev === last.hash;
  const v = C.verifyLedger28(rows, rows[0].seq === 1 ? rows[0].prev : null);
  if (!v.ok) { console.error('pulled rows do not verify', v); process.exit(1); }
  if (last && !contiguous) console.error(`new chain segment (server restart or gap): local last seq ${last.seq}, remote first seq ${rows[0].seq}`);
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  recordAnchor(rows[rows.length - 1].seq, v.head);
  console.log(JSON.stringify({ ok: true, appended: rows.length, newSegment: !!(last && !contiguous), head: v.head, seq: rows[rows.length - 1].seq }));
  if (durableWarn()) process.exit(4);
}
main().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
