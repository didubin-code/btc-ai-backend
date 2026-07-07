'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ENABLE_OPENAI = String(process.env.ENABLE_OPENAI || '').toLowerCase() === 'true';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_AUTO_INTERVAL_MS = Math.max(3000, Number(process.env.AI_AUTO_INTERVAL_MS || 5000));
const AI_EVENT_COOLDOWN_MS = Math.max(2000, Number(process.env.AI_EVENT_COOLDOWN_MS || 3000));
const AI_MAX_BODY_CHARS = Number(process.env.AI_MAX_BODY_CHARS || 2600);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 170);
const AI_MAX_CALLS_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY || 1000);
const AI_DUPLICATE_TTL_MS = Number(process.env.AI_DUPLICATE_TTL_MS || 10000);

let aiInFlight = false;
let aiDay = new Date().toISOString().slice(0, 10);
let aiCallsToday = 0;
const aiLastCallByIp = new Map();
const aiHashCache = new Map();

const sources = [
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', parse: j => Number(j && j.data && j.data.amount) },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse: j => Number(j && j.result && ((j.result.XXBTZUSD && j.result.XXBTZUSD.c && j.result.XXBTZUSD.c[0]) || (j.result.XBTUSD && j.result.XBTUSD.c && j.result.XBTUSD.c[0]))) },
  { name: 'bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse: j => Number(j && j.last) },
  { name: 'binanceus', url: 'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD', parse: j => Number(j && j.price) }
];

function send(res, code, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-auto-ai-call,x-manual-ai-call,x-critical-ai-call',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
async function fetchWithTimeout(url, ms = 4500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'btc-engine-v102-autonomous-ai-trader' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
async function marketSnapshot() {
  const started = Date.now();
  const settled = await Promise.allSettled(sources.map(async s => {
    const j = await fetchWithTimeout(s.url, 4200);
    const price = s.parse(j);
    if (!Number.isFinite(price) || price < 1000) throw new Error('bad price');
    return { name: s.name, price };
  }));
  const good = settled.filter(x => x.status === 'fulfilled').map(x => x.value);
  if (!good.length) throw new Error('No market sources responded');
  const prices = good.map(g => g.price);
  const proxy = median(prices);
  const spreadBps = prices.length > 1 ? ((Math.max(...prices) - Math.min(...prices)) / proxy) * 10000 : 0;
  const confidence = Math.round(clamp(55 + good.length * 12 - clamp(spreadBps * 8, 0, 35), 35, 100));
  return {
    version: 'v102-autonomous-ai-trader-server',
    price: proxy,
    proxy,
    brtiProxy: proxy,
    venues: good.length,
    spreadBps,
    confidence,
    sources: good,
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - started,
    aiAutoCalls: ENABLE_OPENAI,
    aiIntervalMs: AI_AUTO_INTERVAL_MS
  };
}
function readBody(req, limit = 8000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > limit) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function resetDailyAiCounterIfNeeded() {
  const d = new Date().toISOString().slice(0, 10);
  if (d !== aiDay) { aiDay = d; aiCallsToday = 0; aiHashCache.clear(); }
}
function cleanHashCache() {
  const cutoff = Date.now() - AI_DUPLICATE_TTL_MS;
  for (const [k, v] of aiHashCache.entries()) if (v.t < cutoff) aiHashCache.delete(k);
}
async function handleCopilot(req, res, mode) {
  if (!ENABLE_OPENAI) return send(res, 503, { ok: false, error: 'OpenAI disabled. Set ENABLE_OPENAI=true for continuous copilot. Market data is unaffected.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok: false, error: 'OPENAI_API_KEY missing.' });
  if (mode === 'auto' && req.headers['x-auto-ai-call'] !== 'true') return send(res, 403, { ok: false, error: 'Auto AI header required.' });
  if (mode === 'manual' && req.headers['x-manual-ai-call'] !== 'true') return send(res, 403, { ok: false, error: 'Manual AI header required.' });

  resetDailyAiCounterIfNeeded();
  cleanHashCache();
  if (aiCallsToday >= AI_MAX_CALLS_PER_DAY) return send(res, 429, { ok: false, error: 'Daily AI call cap reached.', callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });
  if (aiInFlight) return send(res, 429, { ok: false, error: 'AI request already in flight. Skipping duplicate.' });

  const ip = req.socket.remoteAddress || 'unknown';
  const last = aiLastCallByIp.get(ip) || 0;
  const critical = String(req.headers['x-critical-ai-call'] || '').toLowerCase() === 'true';
  const cooldown = mode === 'auto' ? (critical ? AI_EVENT_COOLDOWN_MS : AI_AUTO_INTERVAL_MS) : Math.max(3000, Math.floor(AI_AUTO_INTERVAL_MS / 2));
  const waitMs = cooldown - (Date.now() - last);
  if (waitMs > 0) return send(res, 429, { ok: false, error: 'AI cooldown active.', retryAfterMs: waitMs, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY, eventCooldownMs: AI_EVENT_COOLDOWN_MS, intervalMs: AI_AUTO_INTERVAL_MS });

  const raw = await readBody(req, Math.max(AI_MAX_BODY_CHARS + 1000, 5000));
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'Invalid JSON' }); }
  const snapshot = String(payload.snapshot || '').slice(0, AI_MAX_BODY_CHARS);
  if (!snapshot.trim()) return send(res, 400, { ok: false, error: 'Missing snapshot.' });

  const normalized = snapshot.replace(/time=.*/g, '').replace(/\s+/g, ' ').trim();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex');
  const cached = aiHashCache.get(hash);
  if (mode === 'auto' && cached && Date.now() - cached.t < AI_DUPLICATE_TTL_MS) {
    return send(res, 200, { ok: true, text: cached.text, cached: true, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });
  }

  const prompt = [
    'You are an autonomous BTC microstructure execution trader for a very short 15-minute decision window.',
    'You are NOT a rule engine and you are NOT required to agree with the local engine. The local engine is only one advisory input.',
    'Your job: make the best independent execution decision from the live snapshot, including price, target gap, timer, entered side, momentum, acceleration, reversal risk, venue spread, probability pack, and prior AI thesis.',
    'Think probabilistically and forward-looking: identify whether the next material move is more likely toward ABOVE, BELOW, or reversal/exit. Do not chase every tiny tick. Update thesis only when the evidence actually invalidates it or improves it.',
    'If evidence is mixed, say WAIT or WATCH_ABOVE/WATCH_BELOW. If evidence supports action, say TRADE_ABOVE or TRADE_BELOW. If already in a trade, say HOLD_ABOVE/HOLD_BELOW or EXIT_ABOVE/EXIT_BELOW.',
    'Return ONLY compact JSON with keys: action, confidence, thesis, why, risk, invalidation. No markdown. No extra prose.',
    'Allowed actions: WAIT, WATCH_ABOVE, WATCH_BELOW, TRADE_ABOVE, TRADE_BELOW, HOLD_ABOVE, HOLD_BELOW, EXIT_ABOVE, EXIT_BELOW.',
    'Confidence is 0-100. Be decisive only when the evidence is strong enough for practical trading. Otherwise preserve capital.',
    '',
    snapshot
  ].join('\n');

  aiInFlight = true;
  aiLastCallByIp.set(ip, Date.now());
  aiCallsToday++;
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, input: prompt, max_output_tokens: AI_MAX_OUTPUT_TOKENS })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return send(res, r.status, { ok: false, error: (j.error && j.error.message) || 'OpenAI request failed', callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });
    const text = (j.output_text || (Array.isArray(j.output) ? j.output.map(o => (o.content || []).map(c => c.text || '').join('')).join('\n') : '') || '').trim();
    const finalText = text.slice(0, 500) || 'AI returned no text.';
    aiHashCache.set(hash, { t: Date.now(), text: finalText });
    return send(res, 200, { ok: true, text: finalText, cached: false, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY, intervalMs: AI_AUTO_INTERVAL_MS, eventCooldownMs: AI_EVENT_COOLDOWN_MS, model: OPENAI_MODEL });
  } finally {
    aiInFlight = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return send(res, 200, {
        ok: true,
        service: 'btc-engine-v102-autonomous-ai-trader',
        openAiEnabled: ENABLE_OPENAI,
        aiAutoCalls: ENABLE_OPENAI,
        aiIntervalMs: AI_AUTO_INTERVAL_MS,
        aiEventCooldownMs: AI_EVENT_COOLDOWN_MS,
        aiCallsToday,
        aiDailyCap: AI_MAX_CALLS_PER_DAY,
        time: new Date().toISOString()
      });
    }
    if (req.method === 'GET' && url.pathname === '/market') return send(res, 200, await marketSnapshot());
    if (req.method === 'POST' && url.pathname === '/copilot/auto') return await handleCopilot(req, res, 'auto');
    if (req.method === 'POST' && url.pathname === '/copilot/analyze') return await handleCopilot(req, res, 'manual');
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
});
server.listen(PORT, () => console.log(`btc-engine-v102-autonomous-ai-trader listening on ${PORT}`));
