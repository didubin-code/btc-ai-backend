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
const AI_MIN_FLIP_AGE_SEC = Number(process.env.AI_MIN_FLIP_AGE_SEC || 40);
const AI_FLIP_CONF = Number(process.env.AI_FLIP_CONF || 74);
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
      flips: 0,
      flipsBlocked: 0,
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
    if (st.thesis && st.thesis !== 'NONE' && newThesis !== 'NONE') st.flips = (st.flips || 0) + 1;
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
    thesisFlips: st.flips || 0,
    flipsBlocked: st.flipsBlocked || 0,
    lastDecisions: st.history || []
  };
}

function enforceCommitment(st, decision, snapshot) {
  const action = normalizeAction(decision.action);
  const side = action.includes('ABOVE') ? 'ABOVE' : action.includes('BELOW') ? 'BELOW' : null;
  const prev = st.thesis && st.thesis !== 'NONE' ? st.thesis : null;
  const ageSec = st.thesisStartedAt ? (Date.now() - st.thesisStartedAt) / 1000 : Infinity;
  const conf = Math.max(0, Math.min(100, Number(decision.confidence || decision.conf || 0) || 0));
  const active = snapshot?.activeTrade || null;
  const d = snapshot?.derived || {};
  const pEnteredWin = Number(d.pEnteredWin);
  const invalidationHit = decision.invalidation_hit === true || /invalidat/i.test(String(decision.why || '')) && conf >= 65;

  // Rule 1: never signal the opposite TRADE while the human holds a position — EXIT comes first.
  if (active && side && side !== active && action.startsWith('TRADE')) {
    decision.action = 'EXIT';
    decision.why = 'Conviction now opposes your open ' + active + ' position — exit first, re-enter only after flat. ' + String(decision.why || '');
    decision.enforced = 'OPPOSITE_TRADE_TO_EXIT';
    return decision;
  }
  // Rule 2: exit priority — if the open position win probability is conclusively broken, force EXIT even if the model said HOLD/WAIT.
  if (active && Number.isFinite(pEnteredWin) && pEnteredWin < 0.22 && action !== 'EXIT') {
    decision.action = 'EXIT';
    decision.why = 'CONCLUSIVE: P(win ' + active + ') = ' + Math.round(pEnteredWin * 100) + '% — below 22% floor. ' + String(decision.why || '');
    decision.enforced = 'EXIT_FLOOR';
    return decision;
  }
  // Rule 3: anti-waffle — directional flips need age >= AI_MIN_FLIP_AGE_SEC OR confidence >= AI_FLIP_CONF OR invalidation hit.
  if (prev && side && side !== prev && ageSec < AI_MIN_FLIP_AGE_SEC && conf < AI_FLIP_CONF && !invalidationHit) {
    st.flipsBlocked = (st.flipsBlocked || 0) + 1;
    decision.action = 'WAIT';
    decision.why = 'FLIP SUPPRESSED: thesis ' + prev + ' is only ' + Math.round(ageSec) + 's old and flip confidence ' + conf + ' < ' + AI_FLIP_CONF + '. Holding discipline. Original view: ' + String(decision.why || '');
    decision.enforced = 'FLIP_SUPPRESSED';
    return decision;
  }
  return decision;
}

function mockDecision(snapshot, st) {
  const d = snapshot.derived || {};
  const pA = Number(d.pSettleAbove);
  const pWin = Number(d.pEnteredWin);
  const active = snapshot.activeTrade || null;
  let action = 'WAIT', confidence = 60, why = 'Mixed evidence; waiting.';
  if (active && Number.isFinite(pWin)) {
    if (pWin < 0.35) { action = 'EXIT'; confidence = 82; why = 'Open ' + active + ' win probability ' + Math.round(pWin * 100) + '% below floor.'; }
    else { action = 'HOLD_' + active; confidence = Math.round(pWin * 100); why = 'Position win probability intact.'; }
  } else if (Number.isFinite(pA)) {
    if (pA >= 0.76) { action = 'TRADE_ABOVE'; confidence = Math.round(pA * 100); why = 'Terminal distribution strongly favors ABOVE.'; }
    else if (pA <= 0.24) { action = 'TRADE_BELOW'; confidence = Math.round((1 - pA) * 100); why = 'Terminal distribution strongly favors BELOW.'; }
    else if (pA >= 0.60) { action = 'WATCH_ABOVE'; confidence = Math.round(pA * 100); why = 'Leaning ABOVE, not decisive.'; }
    else if (pA <= 0.40) { action = 'WATCH_BELOW'; confidence = Math.round((1 - pA) * 100); why = 'Leaning BELOW, not decisive.'; }
  }
  return { action, confidence, thesis: action.replace(/^(TRADE_|WATCH_|HOLD_)/, ''), why, risk: 'Fast BTC reversal/chop risk.', invalidation: 'Settlement probability crossing back through 0.5 with adverse drift.', timing: action.startsWith('TRADE') || action === 'EXIT' ? 'NOW' : 'WAIT', evidence: ['pSettleAbove', 'drift', 'pEnteredWin'], mock: true };
}

async function callOpenAI(snapshot, st) {
  if (MOCK_OPENAI) return mockDecision(snapshot, st);
  if (!ENABLE_OPENAI) throw new Error('ENABLE_OPENAI is not true');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const system = `You are an INDEPENDENT SECOND TRADER for 15-minute BTC binary event contracts that settle ABOVE or BELOW a strike. You receive: live multi-venue market data, a quantitative terminal-distribution model (pSettleAbove = probability price settles above strike, from EWMA drift + realized vol), microstructure (2/15/30s moves, acceleration, drift bps/sec), reversal score, venue spread, seconds remaining, the human's open position (activeTrade) with its live win probability (pEnteredWin), the local advisory engine's view, and your own prior thesis memory. Your duties, in priority order: (1) EXIT PRIORITY: if activeTrade exists and pEnteredWin or your own analysis shows the position is conclusively broken (win probability under ~0.35 with adverse drift/acceleration), command EXIT immediately with a decisive one-line reason. Do not soften it. (2) BE PREDICTIVE, NOT REACTIVE: weight drift, acceleration, and the probability trajectory over the raw current gap. Anticipate where price settles, not where it is. (3) MAINTAIN A THESIS: once you commit to a side, hold it until your stated invalidation is hit or evidence is overwhelming. Never flip direction on single-metric noise. If evidence is mixed, output WAIT or WATCH — never the opposite trade. (4) Disagree with the local advisory engine when your analysis warrants; you are independent, not a mirror. Allowed actions: WAIT, WATCH_ABOVE, WATCH_BELOW, TRADE_ABOVE, TRADE_BELOW, HOLD_ABOVE, HOLD_BELOW, EXIT. Return compact JSON only: {"action","confidence"(0-100),"pSettle"(your own 0-1 estimate for your thesis side),"thesis","why"(one decisive sentence),"risk","invalidation"(concrete, checkable),"invalidation_hit"(boolean, true only if your prior invalidation just triggered),"timing","evidence"(array)}.`;

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
    let decision = await callOpenAI(snapshot, st);
    decision.action = normalizeAction(decision.action);
    decision.confidence = Math.max(0, Math.min(100, Number(decision.confidence || decision.conf || 0) || 0));
    decision = enforceCommitment(st, decision, snapshot);
    decision.action = normalizeAction(decision.action);
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
    if (req.method === 'POST' && (u.pathname === '/ai-trader' || u.pathname === '/analyze' || u.pathname === '/copilot/auto')) {
      return await handleAi(req, res);
    }
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, () => console.log(`btc-ai-backend listening on ${PORT}, model=${OPENAI_MODEL}`));
