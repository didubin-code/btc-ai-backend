/* Real-time end-to-end test harness: a mock Kalshi WebSocket that (1) enforces the same RSA-PSS handshake headers as
   Kalshi, (2) answers subscribe commands, and (3) streams cfbenchmarks_value messages in Kalshi's documented schema
   once per second, including last_60s_windowed_average_15min in each quarter-hour's final minute.
   The BRTI values are SYNTHETIC: the radar's own live index (read from its /health) + a fixed $1.37 offset + noise.
   Fault injection: a 6 s outage at :20-:26 of the final minute of every 2nd quarter-hour, one sequence gap per window.
   usage: NODE_PATH=test/node/node_modules node test/mock_kalshi_ws.js <port> <pubkey.pem> <radar base url> <log.ndjson> */
'use strict';
const crypto = require('crypto'), fs = require('fs'), http = require('http');
const { WebSocketServer } = require('ws');
const PORT = Number(process.argv[2] || 18765), PUB = fs.readFileSync(process.argv[3], 'utf8'), RADAR = process.argv[4] || 'http://127.0.0.1:10128';
const LOG = fs.createWriteStream(process.argv[5] || 'mock_ws.ndjson', { flags: 'a' });
const pub = crypto.createPublicKey(PUB);
const srv = http.createServer((q, r) => { r.writeHead(404); r.end(); });
const wss = new WebSocketServer({ noServer: true });
srv.on('upgrade', (req, socket, head) => {
  const ts = req.headers['kalshi-access-timestamp'], sig = req.headers['kalshi-access-signature'];
  const path = new URL(req.url, 'http://x').pathname;
  let ok = false;
  try { ok = !!ts && !!sig && crypto.verify('sha256', Buffer.from(ts + 'GET' + path), { key: pub, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(sig, 'base64')); } catch (_) { ok = false; }
  LOG.write(JSON.stringify({ t: Date.now(), ev: 'handshake', path, ok }) + '\n');
  if (!ok) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
let latest = null;
async function pollIndex() {
  try { const r = await fetch(RADAR + '/health'); const j = await r.json(); if (j.index && j.index.value > 0) latest = j.index.value; } catch (_) { }
}
setInterval(pollIndex, 250); pollIndex();
wss.on('connection', ws => {
  let sid = 0, seq = 0, brtiSid = null, sum = 0, cnt = 0, curClose = null, gapDone = new Set();
  ws.on('message', m => {
    let j; try { j = JSON.parse(String(m)); } catch (_) { return; }
    LOG.write(JSON.stringify({ t: Date.now(), ev: 'client', j }) + '\n');
    if (j.cmd === 'subscribe') {
      const chans = (j.params && j.params.channels) || [];
      for (const ch of chans) {
        const s = ++sid;
        if (ch === 'cfbenchmarks_value') brtiSid = s;
        ws.send(JSON.stringify({ id: j.id, type: 'subscribed', msg: { channel: ch, sid: s } }));
      }
    }
  });
  const tick = () => {
    if (ws.readyState !== 1) return;
    const now = Date.now(), sec = Math.floor(now / 1000), srcTs = sec * 1000;
    setTimeout(tick, 1000 - (Date.now() % 1000) + 120);
    if (!brtiSid || !(latest > 0)) return;
    const close = Math.ceil(sec / 900) * 900, inFinal = sec > close - 60 && sec <= close;
    const outage = inFinal && (close / 900) % 2 === 0 && (sec - (close - 60)) >= 20 && (sec - (close - 60)) < 26;
    const value = +(latest + 1.37 + (Math.random() - 0.5) * 0.4).toFixed(2);
    if (inFinal) { if (curClose !== close) { curClose = close; sum = 0; cnt = 0; } sum += value; cnt++; }
    if (outage) { LOG.write(JSON.stringify({ t: now, ev: 'outage', sec }) + '\n'); return; }
    seq++;
    if (inFinal && !gapDone.has(close) && (sec - (close - 60)) === 40) { seq++; gapDone.add(close); }      // one sequence gap per window
    const msg = { type: 'cfbenchmarks_value', sid: brtiSid, seq, sending_ts_ms: Date.now(),
      msg: { index_id: 'BRTI', received_at: srcTs + 60, data: JSON.stringify({ type: 'value', id: 'BRTI', time: srcTs, value: value.toFixed(2) }),
        avg_60s_data: { value: value.toFixed(8), window_size: 60, window_start_ts_ms: srcTs - 60000, window_end_ts_exclusive: srcTs },
        ...(inFinal ? { last_60s_windowed_average_15min: { value: (sum / cnt).toFixed(8), window_size: cnt, window_start_ts_ms: close * 1000 - 60000, window_end_ts_exclusive: close * 1000 + 1 } } : {}) } };
    ws.send(JSON.stringify(msg));
    LOG.write(JSON.stringify({ t: now, ev: 'sent', sec, value, inFinal, cnt: inFinal ? cnt : null, avg: inFinal ? +(sum / cnt).toFixed(4) : null }) + '\n');
  };
  setTimeout(tick, 1000 - (Date.now() % 1000) + 120);
});
srv.listen(PORT, '127.0.0.1', () => console.log('mock kalshi ws on', PORT));
