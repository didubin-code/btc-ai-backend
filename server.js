'use strict';

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const ENABLE_OPENAI = String(process.env.ENABLE_OPENAI || 'true').toLowerCase() === 'true';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_AUTO_INTERVAL_MS = Math.max(2500, Number(process.env.AI_AUTO_INTERVAL_MS || 8000));
const AI_EVENT_COOLDOWN_MS = Math.max(1800, Number(process.env.AI_EVENT_COOLDOWN_MS || 3000));
const AI_MAX_BODY_CHARS = Number(process.env.AI_MAX_BODY_CHARS || 2600);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 130);
const AI_MAX_CALLS_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY || 5000);
const AI_DUPLICATE_TTL_MS = Number(process.env.AI_DUPLICATE_TTL_MS || 15000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 9000);

let aiInFlight = false;
let aiDay = new Date().toISOString().slice(0, 10);
let aiCallsToday = 0;
const aiLastCallByIp = new Map();
const aiSemanticCache = new Map();

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
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
async function fetchWithTimeout(url, ms = 4500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'btc-ai-copilot-v99-smart-trader' } });
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
    version: 'v99-smart-trader-server',
    price: proxy,
    proxy,
    brtiProxy: proxy,
    venues: good.length,
    spreadBps,
    confidence,
    sources: good,
    timestamp: new Date().toISOString(),
    latencyMs: Date.now() - started,
    openAiEnabled: ENABLE_OPENAI,
    aiCallsToday,
    aiDailyCap: AI_MAX_CALLS_PER_DAY
  };
}
function readBody(req, limit = 9000) {
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
  if (d !== aiDay) { aiDay = d; aiCallsToday = 0; aiSemanticCache.clear(); }
}
function cleanAiCache() {
  const cutoff = Date.now() - Math.max(AI_DUPLICATE_TTL_MS, 5000);
  for (const [k, v] of aiSemanticCache.entries()) if (v.t < cutoff) aiSemanticCache.delete(k);
}
function responseTextFromOpenAI(j) {
  if (typeof j.output_text === 'string') return j.output_text.trim();
  if (Array.isArray(j.output)) {
    return j.output.map(o => Array.isArray(o.content) ? o.content.map(c => c.text || '').join('') : '').join('\n').trim();
  }
  return '';
}
async function callOpenAI(prompt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, input: prompt, max_output_tokens: AI_MAX_OUTPUT_TOKENS, temperature: 0.15 })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI request failed');
    return responseTextFromOpenAI(j) || 'ACTION: WAIT | CONF: 0 | WHY: no text returned | WATCH: refresh AI';
  } finally { clearTimeout(timer); }
}
async function handleCopilot(req, res, mode) {
  if (!ENABLE_OPENAI) return send(res, 503, { ok: false, error: 'OpenAI disabled. Set ENABLE_OPENAI=true.' });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { ok: false, error: 'OPENAI_API_KEY missing.' });
  if (mode === 'auto' && req.headers['x-auto-ai-call'] !== 'true') return send(res, 403, { ok: false, error: 'Auto AI header required.' });
  if (mode === 'manual' && req.headers['x-manual-ai-call'] !== 'true') return send(res, 403, { ok: false, error: 'Manual AI header required.' });

  resetDailyAiCounterIfNeeded();
  cleanAiCache();
  if (aiCallsToday >= AI_MAX_CALLS_PER_DAY) return send(res, 429, { ok: false, error: 'Daily AI call cap reached.', callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });
  if (aiInFlight) return send(res, 429, { ok: false, error: 'AI already analyzing current snapshot. Skipped overlap.', callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });

  const raw = await readBody(req, Math.max(AI_MAX_BODY_CHARS + 1200, 6000));
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { return send(res, 400, { ok: false, error: 'Invalid JSON' }); }
  const snapshot = String(payload.snapshot || '').slice(0, AI_MAX_BODY_CHARS);
  if (!snapshot.trim()) return send(res, 400, { ok: false, error: 'Missing snapshot.' });

  const critical = String(req.headers['x-critical-ai-call'] || '').toLowerCase() === 'true' || Boolean(payload.critical);
  const force = Boolean(payload.forced) || mode === 'manual';
  const semanticKey = String(payload.semanticKey || '').slice(0, 220) || crypto.createHash('sha256').update(snapshot.replace(/time=.*/g, '').replace(/price=\d+\.\d+/g, 'price=bucket')).digest('hex');
  const cached = aiSemanticCache.get(semanticKey);
  if (!force && mode === 'auto' && cached && Date.now() - cached.t < AI_DUPLICATE_TTL_MS) {
    return send(res, 200, { ok: true, text: cached.text, cached: true, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY, semanticKey });
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const last = aiLastCallByIp.get(ip) || 0;
  const cooldown = force ? 1800 : (critical ? AI_EVENT_COOLDOWN_MS : AI_AUTO_INTERVAL_MS);
  const waitMs = cooldown - (Date.now() - last);
  if (waitMs > 0) return send(res, 429, { ok: false, error: 'AI cooldown active.', retryAfterMs: waitMs, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });

  const prompt = [
    'You are an independent BTC 15-minute execution copilot/trader.',
    'Use only the snapshot. Be fast, skeptical, and focused on small microstructure details that could cause a reversal.',
    'Do NOT simply repeat the local engine. Agree or disagree based on momentum, acceleration, volatility, target distance, timer, and reversal pressure.',
    'Return exactly this compact format, one line only:',
    'ACTION: <WAIT|TRADE_ABOVE|TRADE_BELOW|HOLD_ABOVE|HOLD_BELOW|EXIT_ABOVE|EXIT_BELOW> | CONF: <0-100> | WHY: <specific micro detail> | WATCH: <specific trigger>',
    '',
    snapshot
  ].join('\n');

  aiInFlight = true;
  aiLastCallByIp.set(ip, Date.now());
  aiCallsToday++;
  try {
    const text = (await callOpenAI(prompt)).replace(/\s+/g, ' ').trim().slice(0, 520);
    aiSemanticCache.set(semanticKey, { t: Date.now(), text });
    return send(res, 200, { ok: true, text, cached: false, callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY, model: OPENAI_MODEL, semanticKey });
  } catch (err) {
    return send(res, 502, { ok: false, error: err.message || String(err), callsToday: aiCallsToday, dailyCap: AI_MAX_CALLS_PER_DAY });
  } finally { aiInFlight = false; }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return send(res, 200, { ok: true, service: 'btc-ai-copilot-v99-smart-trader', openAiEnabled: ENABLE_OPENAI, model: OPENAI_MODEL, aiCallsToday, aiDailyCap: AI_MAX_CALLS_PER_DAY, aiAutoIntervalMs: AI_AUTO_INTERVAL_MS, aiEventCooldownMs: AI_EVENT_COOLDOWN_MS, duplicateTtlMs: AI_DUPLICATE_TTL_MS, time: new Date().toISOString() });
    }
    if (req.method === 'GET' && url.pathname === '/market') return send(res, 200, await marketSnapshot());
    if (req.method === 'POST' && url.pathname === '/copilot/auto') return await handleCopilot(req, res, 'auto');
    if (req.method === 'POST' && url.pathname === '/copilot/analyze') return await handleCopilot(req, res, 'manual');
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
});
server.listen(PORT, () => console.log(`btc-ai-copilot-v99-smart-trader listening on ${PORT}`));
