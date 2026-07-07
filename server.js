'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const ENABLE_OPENAI = String(process.env.ENABLE_OPENAI || 'false').toLowerCase() === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 9000);
const AI_MAX_CALLS_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY || 5000);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 130);
const MOCK_OPENAI = String(process.env.MOCK_OPENAI || 'false').toLowerCase() === 'true';
const RAW_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_MODEL = RAW_MODEL.replace('gpt-40', 'gpt-4o'); // protects against zero-vs-letter-o typo

let dayKey = new Date().toISOString().slice(0, 10);
let dayCalls = 0;
const sessions = new Map();

function resetDailyIfNeeded() {
  const k = new Date().toISOString().slice(0, 10);
  if (k !== dayKey) {
    dayKey = k;
    dayCalls = 0;
    sessions.clear();
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 250000) {
        reject(new Error('Payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, timeoutMs = 3500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'btc-ai-backend/1.0' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function median(vals) {
  const a = vals.filter(v => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

async function getMarket() {
  const sources = await Promise.allSettled([
    fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(j => ({ venue: 'coinbase', price: Number(j?.data?.amount) })),
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then(j => {
      const key = Object.keys(j?.result || {})[0];
      return { venue: 'kraken', price: Number(j?.result?.[key]?.c?.[0]) };
    }),
    fetchJson('https://www.bitstamp.net/api/v2/ticker/btcusd/').then(j => ({ venue: 'bitstamp', price: Number(j?.last) })),
    fetchJson('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD').then(j => ({ venue: 'binanceus', price: Number(j?.price) }))
  ]);

  const venues = [];
  for (const s of sources) {
    if (s.status === 'fulfilled' && s.value && Number.isFinite(s.value.price) && s.value.price > 1000) venues.push(s.value);
  }
  if (!venues.length) throw new Error('No live BTC venues returned valid data');
  const prices = venues.map(v => v.price);
  const proxy = median(prices);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const spreadBps = proxy ? ((max - min) / proxy) * 10000 : null;
  const confidence = Math.max(45, Math.min(100, Math.round(100 - (spreadBps || 0) * 4)));
  return {
    ok: true,
    ts: Date.now(),
    proxy,
    confidence,
    spreadBps,
    venues,
    source: venues.map(v => v.venue).join(', ')
  };
}

function compactSnapshot(s) {
  return {
    timer: s.timer,
    target: s.target,
    activeTrade: s.activeTrade,
    market: s.market,
    derived: s.derived,
    localAdvisory: s.localAdvisory,
    recentTape: Array.isArray(s.recentTape) ? s.recentTape.slice(-45) : []
  };
}

function normalizeAction(a) {
  const s = String(a || 'WAIT').toUpperCase().replace(/\s+/g, '_');
  const allowed = new Set(['WAIT','WATCH_ABOVE','WATCH_BELOW','TRADE_ABOVE','TRADE_BELOW','HOLD_ABOVE','HOLD_BELOW','EXIT']);
  return allowed.has(s) ? s : 'WAIT';
}

function getSession(sessionId) {
  const id = String(sessionId || 'default').slice(0, 80);
  if (!sessions.has(id)) {
    sessions.set(id, {
      thesis: 'NONE',
      thesisReason: '',
      thesisStartedAt: null,
      confidence: 0,
      invalidation: '',
      history: []
    });
  }
  return sessions.get(id);
}

function updateSession(st, decision) {
  const now = Date.now();
  const action = normalizeAction(decision.action);
  let newThesis = st.thesis || 'NONE';
  if (action.includes('ABOVE')) newThesis = 'ABOVE';
  else if (action.includes('BELOW')) newThesis = 'BELOW';
  else if (action === 'EXIT') newThesis = 'NONE';

  if (newThesis !== st.thesis) {
    st.thesis = newThesis;
    st.thesisStartedAt = now;
    st.thesisReason = decision.why || decision.thesis || '';
  }
  st.confidence = Number(decision.confidence || decision.conf || 0) || 0;
  st.invalidation = decision.invalidation || '';
  st.history.push({
    t: now,
    action,
    confidence: st.confidence,
    thesis: st.thesis,
    why: String(decision.why || decision.thesis || '').slice(0, 240)
  });
  st.history = st.history.slice(-8);
}

function sessionForPrompt(st) {
  return {
    currentThesis: st.thesis || 'NONE',
    thesisAgeSec: st.thesisStartedAt ? Math.round((Date.now() - st.thesisStartedAt) / 1000) : 0,
    thesisReason: st.thesisReason || '',
    lastConfidence: st.confidence || 0,
    invalidation: st.invalidation || '',
    lastDecisions: st.history || []
  };
}

function mockDecision(snapshot, st) {
  const d = snapshot.derived || {};
  const trend = Number(d.move30Bps || 0);
  const accel = Number(d.accelBps || 0);
  const pressure = Number(d.pressureScore || 0);
  const gap = Number(d.distanceTargetBps || 0);
  let action = 'WAIT';
  let confidence = 62;
  let why = 'No sufficiently clean autonomous edge; waiting for stronger confirmation.';
  if (trend > 2.0 && accel > 0.35 && pressure > 60) { action = 'TRADE_ABOVE'; confidence = 78; why = 'Upside tape pressure is expanding with positive acceleration and target proximity.'; }
  if (trend < -2.0 && accel < -0.35 && pressure < -60) { action = 'TRADE_BELOW'; confidence = 78; why = 'Downside tape pressure is expanding with negative acceleration and target proximity.'; }
  if (Math.abs(gap) < 1.5) { action = 'WAIT'; confidence = 70; why = 'Price is too close to target/strike; avoid noisy entry unless tape confirms continuation.'; }
  return { action, confidence, thesis: action.replace('TRADE_', '').replace('WATCH_', ''), why, risk: 'Fast BTC reversal/chop risk.', invalidation: 'Opposite 15/30s pressure with acceleration.', timing: action === 'WAIT' ? 'WAIT' : 'NOW', evidence: ['trend', 'acceleration', 'pressure'], mock: true };
}

async function callOpenAI(snapshot, st) {
  if (MOCK_OPENAI) return mockDecision(snapshot, st);
  if (!ENABLE_OPENAI) throw new Error('ENABLE_OPENAI is not true');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const system = `You are an autonomous BTC 15-minute-window trader. You are NOT a narrator and NOT a rules mirror. You receive live microstructure, venue spread, target/strike gap, active trade state, timer, recent tape, local advisory, and your own prior thesis memory. Your job is to decide independently whether to WAIT, WATCH_ABOVE, WATCH_BELOW, TRADE_ABOVE, TRADE_BELOW, HOLD_ABOVE, HOLD_BELOW, or EXIT. Maintain a thesis until the evidence actually invalidates it. Do not flip direction just because one short metric wiggles. If evidence is mixed, choose WAIT or WATCH, not the opposite trade. Identify small details that can lead to larger changes: acceleration, pressure divergence, spread instability, target proximity, reversal setup, and time left. Return compact JSON only with fields: action, confidence, thesis, why, risk, invalidation, timing, evidence. Confidence is 0-100.`;

  const user = {
    prior_ai_state: sessionForPrompt(st),
    live_snapshot: snapshot,
    instruction: 'Act as the independent AI trader. Local engine is advisory only. Give the clean actionable command, thesis, risk, and invalidation. JSON only.'
  };

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(user) }
    ],
    temperature: 0.12,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    response_format: { type: 'json_object' }
  };

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(body)
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { parsed = { action: 'WAIT', confidence: 0, why: content.slice(0, 500), risk: 'parse_error', invalidation: '' }; }
    parsed.usage = j.usage || null;
    return parsed;
  } finally {
    clearTimeout(t);
  }
}

async function handleAi(req, res) {
  resetDailyIfNeeded();
  if (dayCalls >= AI_MAX_CALLS_PER_DAY) {
    return send(res, 429, { ok: false, error: 'AI daily cap reached', dayCalls, cap: AI_MAX_CALLS_PER_DAY });
  }
  const body = await readBody(req);
  const st = getSession(body.sessionId);
  const snapshot = compactSnapshot(body.snapshot || body);
  const started = Date.now();
  dayCalls += 1;
  try {
    const decision = await callOpenAI(snapshot, st);
    decision.action = normalizeAction(decision.action);
    decision.confidence = Math.max(0, Math.min(100, Number(decision.confidence || decision.conf || 0) || 0));
    updateSession(st, decision);
    return send(res, 200, {
      ok: true,
      model: OPENAI_MODEL,
      dayCalls,
      cap: AI_MAX_CALLS_PER_DAY,
      latencyMs: Date.now() - started,
      decision,
      aiState: sessionForPrompt(st)
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      error: String(e.message || e),
      dayCalls,
      cap: AI_MAX_CALLS_PER_DAY,
      aiState: sessionForPrompt(st)
    });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.end();
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health')) {
      return send(res, 200, { ok: true, service: 'btc-ai-backend', openaiEnabled: ENABLE_OPENAI, model: OPENAI_MODEL, dayCalls, cap: AI_MAX_CALLS_PER_DAY, ts: Date.now() });
    }
    if (req.method === 'GET' && (u.pathname === '/market' || u.pathname === '/btc')) {
      try { return send(res, 200, await getMarket()); }
      catch (e) { return send(res, 502, { ok: false, error: String(e.message || e), ts: Date.now() }); }
    }
    if (req.method === 'POST' && (u.pathname === '/ai-trader' || u.pathname === '/analyze')) {
      return await handleAi(req, res);
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`btc-ai-backend listening on ${PORT}, model=${OPENAI_MODEL}`));
