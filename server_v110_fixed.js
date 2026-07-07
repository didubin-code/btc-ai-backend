'use strict';

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const ENABLE_OPENAI = String(process.env.ENABLE_OPENAI || 'false').toLowerCase() === 'true';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 9000);
const AI_MAX_CALLS_PER_DAY = Number(process.env.AI_MAX_CALLS_PER_DAY || 5000);
const AI_MAX_OUTPUT_TOKENS = Number(process.env.AI_MAX_OUTPUT_TOKENS || 500);
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

function rawActionText(a) {
  return String(a || 'WAIT').toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function sideFromAction(a) {
  const s = rawActionText(a);
  if (s.includes('ABOVE')) return 'ABOVE';
  if (s.includes('BELOW')) return 'BELOW';
  return null;
}

function normalizeAction(a) {
  const s = rawActionText(a);
  const side = sideFromAction(s);
  if (s === 'EXIT' || s.startsWith('EXIT_')) return 'EXIT';
  if (side && s.includes('HOLD')) return 'HOLD_' + side;
  if (side && (s.includes('TRADE') || s.includes('ENTER') || s.includes('BUY') || s.includes('TAKE'))) return 'TRADE_' + side;
  return 'WAIT';
}

function normalizeDecision(decision) {
  const d = decision && typeof decision === 'object' ? decision : { action: 'WAIT', confidence: 0, why: 'Invalid AI decision object.' };
  const raw = rawActionText(d.action);
  const side = sideFromAction(raw);
  const conf = Math.max(0, Math.min(100, Number(d.confidence || d.conf || 0) || 0));
  const p = Math.max(0, Math.min(1, Number(d.pSettle ?? d.p_settle ?? d.p ?? NaN)));

  // Backstop for older prompts/models: WATCH is never allowed to be a final executable command.
  // High-confidence WATCH is promoted to TRADE; weak WATCH becomes WAIT.
  if (raw.includes('WATCH') && side) {
    if (conf >= 75 || (Number.isFinite(p) && p >= 0.75)) {
      d.action = 'TRADE_' + side;
      d.promoted_from_watch = true;
      d.why = 'Promoted high-confidence WATCH_' + side + ' to TRADE_' + side + '. ' + String(d.why || d.thesis || '').slice(0, 240);
    } else {
      d.action = 'WAIT';
      d.demoted_from_watch = true;
      d.why = 'WATCH is not an executable final command; weak watch became WAIT. ' + String(d.why || d.thesis || '').slice(0, 240);
    }
  } else {
    d.action = normalizeAction(raw);
  }

  d.confidence = conf;
  return d;
}

function parseAiContent(content) {
  const raw = String(content || '').trim();
  if (!raw) return { action: 'WAIT', confidence: 0, why: 'Empty OpenAI response.', risk: 'empty_response', invalidation: '' };

  try { return JSON.parse(raw); } catch (_) {}

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }

  const actionMatch = raw.match(/"action"\s*:\s*"([^"]+)/i);
  const confMatch = raw.match(/"confidence"\s*:\s*"?(-?\d+(?:\.\d+)?)/i);
  const pMatch = raw.match(/"pSettle"\s*:\s*"?(-?\d+(?:\.\d+)?)/i);
  const thesisMatch = raw.match(/"thesis"\s*:\s*"([^"]{0,240})/i);
  const whyMatch = raw.match(/"why"\s*:\s*"([^"]{0,360})/i);

  return {
    action: actionMatch ? actionMatch[1] : 'WAIT',
    confidence: confMatch ? Number(confMatch[1]) : 0,
    pSettle: pMatch ? Number(pMatch[1]) : NaN,
    thesis: thesisMatch ? thesisMatch[1] : '',
    why: whyMatch ? whyMatch[1] : 'Recovered partial OpenAI JSON; response was not valid complete JSON.',
    risk: 'partial_json_recovered',
    invalidation: '',
    partial_parse: true
  };
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
    else if (pA >= 0.60) { action = 'WAIT'; confidence = Math.round(pA * 100); why = 'Leaning ABOVE, but not decisive enough for executable entry.'; }
    else if (pA <= 0.40) { action = 'WAIT'; confidence = Math.round((1 - pA) * 100); why = 'Leaning BELOW, but not decisive enough for executable entry.'; }
  }
  return { action, confidence, thesis: action.replace(/^(TRADE_|WATCH_|HOLD_)/, ''), why, risk: 'Fast BTC reversal/chop risk.', invalidation: 'Settlement probability crossing back through 0.5 with adverse drift.', timing: action.startsWith('TRADE') || action === 'EXIT' ? 'NOW' : 'WAIT', evidence: ['pSettleAbove', 'drift', 'pEnteredWin'], mock: true };
}

async function callOpenAI(snapshot, st) {
  if (MOCK_OPENAI) return mockDecision(snapshot, st);
  if (!ENABLE_OPENAI) throw new Error('ENABLE_OPENAI is not true');
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

  const system = `You are an INDEPENDENT SECOND TRADER for 15-minute BTC binary event contracts that settle ABOVE or BELOW a strike. You receive live market data, pSettleAbove, drift, momentum, reversal score, seconds remaining, activeTrade, pEnteredWin, local advisory, and prior AI thesis memory. Priority: (1) EXIT immediately if activeTrade is broken: pEnteredWin under about 0.35 with adverse drift/acceleration; action EXIT. (2) Predict settlement, not current spot. Weight drift, acceleration, and probability trajectory. (3) Maintain thesis; do not flip on noise. (4) Disagree with local advisory when warranted. FINAL ACTIONS ONLY: WAIT, TRADE_ABOVE, TRADE_BELOW, HOLD_ABOVE, HOLD_BELOW, EXIT. WATCH is forbidden as a final action. If you have a side with confidence >=75 or pSettle for that side >=0.75, return TRADE_ABOVE or TRADE_BELOW, not WAIT. If not executable now, return WAIT. Return valid compact JSON only with exactly these keys: {"action":"WAIT|TRADE_ABOVE|TRADE_BELOW|HOLD_ABOVE|HOLD_BELOW|EXIT","confidence":0-100,"pSettle":0-1,"thesis":"ABOVE|BELOW|NONE","why":"one decisive sentence","risk":"short risk","invalidation":"concrete check","invalidation_hit":false,"timing":"NOW|WAIT","evidence":["p","drift","momentum"]}.`;

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
    const parsed = parseAiContent(content);
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
    decision = normalizeDecision(decision);
    decision = enforceCommitment(st, decision, snapshot);
    decision = normalizeDecision(decision);
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
