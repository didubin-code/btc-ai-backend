#!/usr/bin/env node
/* Pull a running 2.8 server's hash-chained ledger into a local append-only file, verifying the chain on
   every pull. Safe to run from cron every few minutes. Handles restarts: when the server restarted without a
   persistent ledger file, a new chain (seq 1) begins; it is appended as a new segment and verified on its own.
   usage: node tools/ledger_pull28.js https://btc-pin-radar-28.onrender.com ledger28.ndjson                    */
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
  let since = 0;
  if (last && info.seq >= last.seq) {
    /* same chain? fetch the entry with our last seq and compare hashes */
    const chk = await (await fetch(`${base}/ledger?since=${last.seq - 1}&n=1`)).json();
    if (chk.rows && chk.rows[0] && chk.rows[0].hash === last.hash) since = last.seq;
    else if (chk.inMemoryFrom && chk.inMemoryFrom > last.seq) { console.error('GAP: the server no longer holds the entries after our last one (in-memory window moved on). The gap is kept visible and fails G2 integrity in forward_report28; pull more often or set LEDGER_FILE on a persistent disk'); since = chk.inMemoryFrom - 1; }
  }
  const rows = [];
  for (;;) {
    const page = await (await fetch(`${base}/ledger?since=${since + rows.length}&n=5000`)).json();
    if (!page.rows || !page.rows.length) break;
    rows.push(...page.rows); if (page.rows.length < 5000) break;
  }
  if (!rows.length) { console.log(JSON.stringify({ ok: true, appended: 0, head: last && last.hash })); return; }
  const contiguous = last && rows[0].seq === last.seq + 1 && rows[0].prev === last.hash;
  const v = C.verifyLedger28(rows, rows[0].seq === 1 ? rows[0].prev : null);
  if (!v.ok) { console.error('pulled rows do not verify', v); process.exit(1); }
  if (last && !contiguous) console.error(`new chain segment (server restart or gap): local last seq ${last.seq}, remote first seq ${rows[0].seq}`);
  fs.appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, appended: rows.length, newSegment: !!(last && !contiguous), head: v.head, seq: rows[rows.length - 1].seq }));
}
main().catch(e => { console.error(String(e && e.stack || e)); process.exit(1); });
