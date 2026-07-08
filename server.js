'use strict';

/*
  BTC v120 Practical AI Backend
  Purpose: independent second-trader analysis for 15-minute BTC event contracts.
  Endpoints:
    GET  /health
    GET  /market
    POST /analyze  (also /ai-trader and /copilot/auto)
    GET  /selftest

  Env:
    ENABLE_OPENAI=true to use OpenAI. If false, uses the same practical local model.
    OPENAI_API_KEY required when ENABLE_OPENAI=true.
    OPENAI_MODEL default gpt-4o-mini.
*/

const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const SERVER_VERSION = 'v120-practical-ai-governor';
const ENABLE_OPENAI = /^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI || 'false');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').replace('gpt-40', 'gpt-4o');
const OPENAI_TIMEOUT_MS = Math.max(2500, Number(process.env.OPENAI_TIMEOUT_MS || 9000));
const AI_MAX_CALLS_PER_DAY = Math.max(100, Number(process.env.AI_MAX_CALLS_PER_DAY || 5000));
const AI_MAX_OUTPUT_TOKENS = Math.max(250, Number(process.env.AI_MAX_OUTPUT_TOKENS || 650));
const MARKET_TIMEOUT_MS = Math.max(1200, Number(process.env.MARKET_TIMEOUT_MS || 3200));
const MARKET_CACHE_MS = Math.max(250, Number(process.env.MARKET_CACHE_MS || 900));
const MARKET_STALE_MS = Math.max(3000, Number(process.env.MARKET_STALE_MS || 15000));

let marketCache = { t: 0, data: null };
let dayKey = new Date().toISOString().slice(0, 10);
let dayCalls = 0;
const sessions = new Map();

function clamp(x, lo, hi) {
  const n = Number(x);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function finite(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
function median(vals) {
  const a = vals.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function bps(a, b) {
  a = Number(a); b = Number(b);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? ((a - b) / b) * 10000 : NaN;
}
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
function rawActionText(a) { return String(a || 'WAIT').toUpperCase().trim().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }
function sideFromAction(a) {
  const s = rawActionText(a);
  if (s.includes('ABOVE')) return 'ABOVE';
  if (s.includes('BELOW')) return 'BELOW';
  return null;
}
function normalizeAction(a) {
  const s = rawActionText(a);
  const side = sideFromAction(s);
  if (s === 'EXIT' || s.startsWith('EXIT')) return 'EXIT';
  if (side && s.includes('HOLD')) return 'HOLD_' + side;
  if (side && (s.includes('TRADE') || s.includes('ENTER') || s.includes('BUY') || s.includes('TAKE'))) return 'TRADE_' + side;
  return 'WAIT';
}
function nowIsoDate() { return new Date().toISOString().slice(0, 10); }
function resetDailyIfNeeded() {
  const k = nowIsoDate();
  if (k !== dayKey) { dayKey = k; dayCalls = 0; sessions.clear(); }
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auto-AI-Call, X-Manual-AI-Call');
  res.setHeader('Cache-Control', 'no-store');
}
function send(res, code, obj) {
  cors(res);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 250000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { reject(new Error('Payload too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
async function fetchJson(url, timeoutMs = MARKET_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch (_) {} }, timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'btc-v120-practical-ai/1.0', accept: 'application/json' } });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function getMarket() {
  const now = Date.now();
  if (marketCache.data && now - marketCache.t < MARKET_CACHE_MS) return { ...marketCache.data, cached: true, ts: now };
  const jobs = await Promise.allSettled([
    fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(j => ({ venue: 'coinbase', price: Number(j?.data?.amount) })),
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then(j => { const k = Object.keys(j?.result || {})[0]; return { venue: 'kraken', price: Number(j?.result?.[k]?.c?.[0]) }; }),
    fetchJson('https://www.bitstamp.net/api/v2/ticker/btcusd/').then(j => ({ venue: 'bitstamp', price: Number(j?.last) })),
    fetchJson('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD').then(j => ({ venue: 'binanceus', price: Number(j?.price) }))
  ]);
  const venues = [];
  const errors = [];
  for (const j of jobs) {
    if (j.status === 'fulfilled' && j.value && Number.isFinite(j.value.price) && j.value.price > 1000) venues.push(j.value);
    else errors.push(String(j.reason?.message || j.reason || 'bad venue'));
  }
  if (!venues.length) {
    if (marketCache.data && now - marketCache.t <= MARKET_STALE_MS) {
      return { ...marketCache.data, ok: true, stale: true, staleAgeMs: now - marketCache.t, upstreamError: errors.slice(0, 4).join(' | '), ts: now };
    }
    throw new Error('No live BTC venue returned valid data: ' + errors.slice(0, 4).join(' | '));
  }
  const prices = venues.map(v => v.price);
  const proxy = median(prices);
  const spreadBps = proxy ? ((Math.max(...prices) - Math.min(...prices)) / proxy) * 10000 : NaN;
  const confidence = Math.round(clamp(100 - (Number.isFinite(spreadBps) ? spreadBps * 5 : 30), 40, 100));
  const data = {
    ok: true,
    version: SERVER_VERSION,
    ts: now,
    price: proxy,
    proxy,
    confidence,
    spreadBps,
    venueCount: venues.length,
    source: venues.map(v => v.venue).join(', '),
    venues
  };
  marketCache = { t: now, data };
  return data;
}

function getSession(id) {
  const key = String(id || 'default').slice(0, 80);
  if (!sessions.has(key)) sessions.set(key, { thesis: 'NONE', thesisStartedAt: 0, lastAction: 'WAIT', lastConfidence: 0, flips: 0, history: [] });
  return sessions.get(key);
}
function compactSnapshot(s) {
  return {
    timer: s.timer || {},
    target: finite(s.target),
    activeTrade: s.activeTrade || null,
    market: s.market || {},
    derived: s.derived || {},
    localAdvisory: s.localAdvisory || {},
    tapeDigest: s.tapeDigest || null,
    recentTape: Array.isArray(s.recentTape) ? s.recentTape.slice(-12) : []
  };
}
function numberFrom(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}
function derivePractical(snapshot) {
  const d = snapshot.derived || {};
  const timer = snapshot.timer || {};
  const m = snapshot.market || {};
  const price = numberFrom(m.price, m.proxy, d.price);
  const target = numberFrom(snapshot.target, d.target);
  const secondsLeft = clamp(numberFrom(timer.secondsLeft, d.secondsLeft, timer.remainingSec), 0, 900);
  const gap = Number.isFinite(price) && Number.isFinite(target) ? Math.abs(price - target) : NaN;
  const gapBps = Number.isFinite(price) && Number.isFinite(target) ? Math.abs(bps(price, target)) : numberFrom(d.gapBps);
  const signedGapBps = Number.isFinite(price) && Number.isFinite(target) ? bps(price, target) : numberFrom(d.signedGapBps);
  const pAboveRaw = numberFrom(d.pAbove, d.pSettleAbove, d.p_settle_above);
  let pAbove = Number.isFinite(pAboveRaw) ? clamp(pAboveRaw, 0, 1) : NaN;
  const drift = numberFrom(d.driftBpsPerSec, d.drift, d.driftEwma, d.driftEWMA);
  const m2 = numberFrom(d.m2, d.move2);
  const m15 = numberFrom(d.m15, d.move15);
  const m30 = numberFrom(d.m30, d.move30);
  const vol = clamp(numberFrom(d.volBpsPerSec, d.vol, d.sigmaBpsPerSec), 0.025, 2.5);
  const expectedMove = Number.isFinite(d.expectedMove) ? Math.abs(Number(d.expectedMove)) : vol * Math.sqrt(Math.max(secondsLeft, 1));
  if (!Number.isFinite(pAbove) && Number.isFinite(price) && Number.isFinite(target)) {
    const sd = Math.max(0.18, expectedMove);
    const z = ((price - target) / target * 10000 + (Number.isFinite(drift) ? drift * secondsLeft : 0)) / sd;
    pAbove = clamp(normCdf(0.72 * z), 0.01, 0.99);
  }
  const pBelow = Number.isFinite(pAbove) ? 1 - pAbove : NaN;
  const pSide = Number.isFinite(pAbove) ? Math.max(pAbove, pBelow) : NaN;
  const side = Number.isFinite(pAbove) ? (pAbove >= 0.5 ? 'ABOVE' : 'BELOW') : null;
  const sideSign = side === 'ABOVE' ? 1 : side === 'BELOW' ? -1 : 0;
  const sideMomentum = sideSign * (0.15 * (Number.isFinite(m2) ? m2 : 0) + 0.35 * (Number.isFinite(m15) ? m15 : 0) + 0.50 * (Number.isFinite(m30) ? m30 : 0));
  const opposingMomentum = -sideMomentum;
  const accel = numberFrom(d.accel, d.acceleration, (Number.isFinite(m15) && Number.isFinite(m30)) ? m15 - m30 / 2 : NaN);
  const opposingAccel = -sideSign * (Number.isFinite(accel) ? accel : 0);
  let reversalScore = Number.isFinite(Number(d.reversalScore)) ? clamp(Number(d.reversalScore), 0, 100) : 0;
  if (!Number.isFinite(Number(d.reversalScore))) {
    reversalScore = clamp(
      (opposingMomentum > 0 ? opposingMomentum * 13 : 0) +
      (opposingAccel > 0 ? opposingAccel * 10 : 0) +
      (Number.isFinite(gapBps) && gapBps < 4 ? (4 - gapBps) * 7 : 0) +
      (Number.isFinite(pSide) ? (1 - pSide) * 35 : 20), 0, 100);
  }
  const trendQuality = clamp(50 + sideMomentum * 10 - opposingAccel * 7 - reversalScore * 0.22, 0, 100);
  return { price, target, secondsLeft, gap, gapBps, signedGapBps, pAbove, pBelow, pSide, side, drift, m2, m15, m30, vol, expectedMove, sideMomentum, opposingMomentum, opposingAccel, reversalScore, trendQuality };
}
function dynamicRisk(pr) {
  const t = pr.secondsLeft;
  const expected = Number.isFinite(pr.expectedMove) ? pr.expectedMove : 5;
  let reqP;
  if (t > 720) reqP = 0.91;
  else if (t > 540) reqP = 0.88;
  else if (t > 360) reqP = 0.84;
  else if (t > 180) reqP = 0.79;
  else if (t > 75) reqP = 0.74;
  else reqP = 0.69;
  const minGapBps = Math.max(t > 720 ? 6.0 : t > 540 ? 4.6 : t > 360 ? 3.2 : t > 180 ? 2.0 : 0.9, expected * (t > 720 ? 0.58 : t > 540 ? 0.46 : t > 360 ? 0.34 : t > 180 ? 0.22 : 0.10));
  const canOverrideGapWithTape = pr.sideMomentum >= (t > 720 ? 3.4 : t > 540 ? 2.7 : t > 360 ? 2.0 : 1.4) && pr.reversalScore < 55;
  return { reqP, minGapBps, canOverrideGapWithTape };
}
function localPracticalDecision(snapshot) {
  const pr = derivePractical(snapshot);
  const active = String(snapshot.activeTrade || '').toUpperCase();
  if (!Number.isFinite(pr.price) || !Number.isFinite(pr.target) || !Number.isFinite(pr.secondsLeft) || pr.secondsLeft <= 0) {
    return { action: 'WAIT', confidence: 0, pSettle: null, thesis: 'NONE', timing: 'WAIT', why: 'Waiting for live price, target, and timer.', risk: 'missing_data', invalidation: 'Start data and enter strike.', evidence: [], practical: pr };
  }
  const risk = dynamicRisk(pr);
  const side = pr.side || 'NONE';
  const pSide = pr.pSide;
  const confidence = Math.round(clamp((Number.isFinite(pSide) ? pSide * 100 : 0) + (pr.trendQuality - 50) * 0.16 - pr.reversalScore * 0.06, 0, 99));
  const pSettle = side === 'ABOVE' ? pr.pAbove : side === 'BELOW' ? pr.pBelow : null;
  const thinEarly = pr.secondsLeft > 720 && pr.gapBps < risk.minGapBps && !risk.canOverrideGapWithTape;
  const notEnoughGap = pr.gapBps < risk.minGapBps && !risk.canOverrideGapWithTape;
  const notEnoughP = !(Number.isFinite(pSide) && pSide >= risk.reqP);
  const reversalHot = pr.reversalScore >= (pr.secondsLeft > 360 ? 62 : 76);
  if (active === 'ABOVE' || active === 'BELOW') {
    const pWin = active === 'ABOVE' ? pr.pAbove : pr.pBelow;
    const against = active === 'ABOVE' ? -pr.sideMomentum : pr.sideMomentum;
    if ((Number.isFinite(pWin) && pWin < (pr.secondsLeft > 240 ? 0.38 : 0.32)) || (against > 3.0 && pr.reversalScore > 76)) {
      return { action: 'EXIT', confidence: Math.round(clamp(100 - (pWin || 0) * 100, 55, 96)), pSettle: pWin, thesis: 'NONE', timing: 'NOW', why: 'Open position lost practical edge; exit before a confirmed flip turns into a full loss.', risk: 'position_edge_broken', invalidation: 'If pWin recovers above 0.55 with favorable tape, reassess.', evidence: [`pWin ${Math.round((pWin || 0) * 100)}%`, `reversal ${Math.round(pr.reversalScore)}`], practical: pr, dynamicRisk: risk };
    }
    return { action: 'HOLD_' + active, confidence: Math.round(clamp((pWin || 0) * 100, 1, 98)), pSettle: pWin, thesis: active, timing: 'WAIT', why: 'Position edge is still intact; no exit trigger confirmed.', risk: 'normal BTC reversal risk', invalidation: 'Exit if pWin breaks the floor with adverse acceleration.', evidence: [`pWin ${Math.round((pWin || 0) * 100)}%`, `reversal ${Math.round(pr.reversalScore)}`], practical: pr, dynamicRisk: risk };
  }
  if (thinEarly) {
    return { action: 'WAIT', confidence, pSettle, thesis: side, timing: 'WAIT', why: `Lean ${side}, but gap is too thin this early: ${pr.gapBps.toFixed(2)} bps vs practical ${risk.minGapBps.toFixed(2)} bps.`, risk: 'early_thin_gap_flip_risk', invalidation: 'Trade only if gap expands, time decays, or tape becomes one-way enough to override gap risk.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `t ${Math.round(pr.secondsLeft)}s`, `gap ${pr.gapBps.toFixed(2)}bps`], practical: pr, dynamicRisk: risk };
  }
  if (notEnoughP || notEnoughGap || reversalHot) {
    const reason = notEnoughP ? `probability ${Math.round(pSide * 100)}% below practical ${Math.round(risk.reqP * 100)}%` : notEnoughGap ? `gap ${pr.gapBps.toFixed(2)} bps below practical ${risk.minGapBps.toFixed(2)} bps` : `reversal pressure ${Math.round(pr.reversalScore)} is hot`;
    return { action: 'WAIT', confidence, pSettle, thesis: side, timing: 'WAIT', why: `Lean ${side}, but not executable now: ${reason}.`, risk: 'not_actionable_yet', invalidation: 'Trade only after probability, gap, and tape line up together.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `gap ${pr.gapBps.toFixed(2)}bps`, `rev ${Math.round(pr.reversalScore)}`], practical: pr, dynamicRisk: risk };
  }
  return { action: 'TRADE_' + side, confidence, pSettle, thesis: side, timing: 'NOW', why: `Practical entry is aligned: ${Math.round(pSide * 100)}% settle ${side}, gap ${pr.gapBps.toFixed(2)} bps, tape quality ${Math.round(pr.trendQuality)}.`, risk: 'BTC can still reverse; use entered-side tracking.', invalidation: 'Exit if pWin breaks floor or reversal pressure confirms against the side.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `gap ${pr.gapBps.toFixed(2)}bps`, `trendQ ${Math.round(pr.trendQuality)}`], practical: pr, dynamicRisk: risk };
}
function normalizeDecision(d) {
  const obj = d && typeof d === 'object' ? d : {};
  const action = normalizeAction(obj.action);
  const side = sideFromAction(action) || String(obj.thesis || 'NONE').toUpperCase();
  return {
    action,
    confidence: Math.round(clamp(Number(obj.confidence || obj.conf || 0), 0, 100)),
    pSettle: Number.isFinite(Number(obj.pSettle)) ? clamp(Number(obj.pSettle), 0, 1) : null,
    thesis: side === 'ABOVE' || side === 'BELOW' ? side : 'NONE',
    timing: String(obj.timing || (action.startsWith('TRADE') || action === 'EXIT' ? 'NOW' : 'WAIT')).toUpperCase(),
    why: String(obj.why || obj.reason || obj.thesis || '').slice(0, 500) || 'No AI reason returned.',
    risk: String(obj.risk || '').slice(0, 280),
    invalidation: String(obj.invalidation || '').slice(0, 280),
    invalidation_hit: obj.invalidation_hit === true,
    evidence: Array.isArray(obj.evidence) ? obj.evidence.slice(0, 5).map(x => String(x).slice(0, 80)) : []
  };
}
function reviewDecision(snapshot, decision) {
  const local = localPracticalDecision(snapshot);
  let d = normalizeDecision(decision);
  const active = String(snapshot.activeTrade || '').toUpperCase();
  const pr = local.practical;
  const risk = local.dynamicRisk || dynamicRisk(pr);
  const aiSide = sideFromAction(d.action) || (d.thesis === 'ABOVE' || d.thesis === 'BELOW' ? d.thesis : null);
  const localSide = local.thesis;
  // A flat account cannot HOLD or EXIT. This prevents the old false EXIT/HOLD behavior.
  if (!(active === 'ABOVE' || active === 'BELOW') && (d.action === 'EXIT' || d.action.startsWith('HOLD'))) {
    d = { ...d, action: 'WAIT', timing: 'WAIT', why: 'Flat account: AI produced a position-management command, so it was converted to WAIT. ' + d.why };
  }
  // Do not let any model convert a marginal early lean into a real trade.
  if (!(active === 'ABOVE' || active === 'BELOW') && d.action.startsWith('TRADE')) {
    const pForAi = aiSide === 'ABOVE' ? pr.pAbove : aiSide === 'BELOW' ? pr.pBelow : NaN;
    const sameSide = aiSide && localSide && aiSide === localSide;
    const earlyThin = pr.secondsLeft > 720 && pr.gapBps < risk.minGapBps && !risk.canOverrideGapWithTape;
    const badP = !(Number.isFinite(pForAi) && pForAi >= risk.reqP);
    const badGap = pr.gapBps < risk.minGapBps && !risk.canOverrideGapWithTape;
    const badRev = pr.reversalScore >= (pr.secondsLeft > 360 ? 62 : 76);
    if (!sameSide || earlyThin || badP || badGap || badRev) {
      const whyBits = [];
      if (!sameSide) whyBits.push('AI side does not match live settlement geometry');
      if (earlyThin) whyBits.push(`early thin gap ${pr.gapBps.toFixed(2)}bps < ${risk.minGapBps.toFixed(2)}bps`);
      if (badP) whyBits.push(`p ${Number.isFinite(pForAi) ? Math.round(pForAi * 100) + '%' : 'n/a'} < ${Math.round(risk.reqP * 100)}% practical`);
      if (badGap && !earlyThin) whyBits.push(`gap ${pr.gapBps.toFixed(2)}bps < ${risk.minGapBps.toFixed(2)}bps`);
      if (badRev) whyBits.push(`reversal ${Math.round(pr.reversalScore)} hot`);
      d = { ...d, action: 'WAIT', timing: 'WAIT', thesis: aiSide || localSide || 'NONE', why: `AI lean ${aiSide || localSide || 'NONE'} rejected for execution: ${whyBits.join('; ')}.`, risk: 'practical_execution_veto', evidence: (d.evidence || []).concat(whyBits.slice(0, 3)) };
    }
  }
  // If AI is timid but local practical model sees a complete A setup, allow local to be the independent fallback only when OpenAI is unavailable/timid.
  if (d.action === 'WAIT' && local.action.startsWith('TRADE') && d.confidence < 55) {
    d = { ...local, why: 'Local practical model supplied executable trade because AI returned low-confidence WAIT. ' + local.why, source: 'LOCAL_PRACTICAL' };
  }
  d.review = {
    localAction: local.action,
    localWhy: local.why,
    dynamicReqP: risk.reqP,
    dynamicMinGapBps: risk.minGapBps,
    pSide: pr.pSide,
    gapBps: pr.gapBps,
    secondsLeft: pr.secondsLeft,
    reversalScore: pr.reversalScore,
    sideMomentum: pr.sideMomentum
  };
  return d;
}
function updateSession(st, decision) {
  const action = normalizeAction(decision.action);
  const side = sideFromAction(action) || decision.thesis || 'NONE';
  if (side !== st.thesis && st.thesis !== 'NONE' && side !== 'NONE') st.flips++;
  if (side !== st.thesis) { st.thesis = side; st.thesisStartedAt = Date.now(); }
  st.lastAction = action;
  st.lastConfidence = decision.confidence || 0;
  st.history.push({ t: Date.now(), action, confidence: st.lastConfidence, thesis: st.thesis, why: String(decision.why || '').slice(0, 180) });
  st.history = st.history.slice(-8);
}
function sessionForPrompt(st) {
  return { currentThesis: st.thesis, thesisAgeSec: st.thesisStartedAt ? Math.round((Date.now() - st.thesisStartedAt) / 1000) : 0, lastAction: st.lastAction, lastConfidence: st.lastConfidence, thesisFlips: st.flips, lastDecisions: st.history };
}
async function callOpenAI(snapshot, st) {
  if (!ENABLE_OPENAI || !OPENAI_API_KEY) return { ...localPracticalDecision(snapshot), source: ENABLE_OPENAI ? 'LOCAL_NO_KEY' : 'LOCAL_OPENAI_DISABLED' };
  const system = `You are an independent second trader for 15-minute BTC ABOVE/BELOW event contracts. Your job is not to repeat the local engine. Decide whether an entry is PRACTICALLY EXECUTABLE NOW. You may disagree with localAdvisory. Critical instruction: do NOT trade from probability alone. With more than 12 minutes left, a small gap near the strike is usually a WAIT unless the tape is clearly one-way and accelerating. For a flat account, final actions are WAIT, TRADE_ABOVE, TRADE_BELOW only. For an open position, use HOLD_ABOVE, HOLD_BELOW, or EXIT. WATCH is not a final action; express watch as WAIT with timing WAIT. Return compact JSON only with keys action, confidence, pSettle, thesis, why, risk, invalidation, invalidation_hit, timing, evidence.`;
  const user = { prior_ai_state: sessionForPrompt(st), live_snapshot: snapshot, instruction: 'Act independently. Output one practical command. Prefer WAIT when early/small-gap flip risk makes the edge non-executable.' };
  const body = { model: OPENAI_MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }], temperature: 0.08, max_tokens: AI_MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' } };
  const ac = new AbortController();
  const t = setTimeout(() => { try { ac.abort(); } catch (_) {} }, OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` }, body: JSON.stringify(body) });
    const raw = await r.text();
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${raw.slice(0, 500)}`);
    const j = JSON.parse(raw);
    const content = j?.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(content); } catch (_) {
      const start = content.indexOf('{'), end = content.lastIndexOf('}');
      parsed = start >= 0 && end > start ? JSON.parse(content.slice(start, end + 1)) : { action: 'WAIT', confidence: 0, why: content.slice(0, 300) };
    }
    parsed.source = 'OPENAI';
    parsed.modelUsed = OPENAI_MODEL;
    parsed.usage = j.usage || null;
    return parsed;
  } finally { clearTimeout(t); }
}
async function handleAi(req, res) {
  resetDailyIfNeeded();
  if (dayCalls >= AI_MAX_CALLS_PER_DAY) return send(res, 429, { ok: false, error: 'AI daily cap reached', dayCalls, cap: AI_MAX_CALLS_PER_DAY });
  const body = await readBody(req);
  const st = getSession(body.sessionId || body?.snapshot?.sessionId);
  const snapshot = compactSnapshot(body.snapshot || body);
  const started = Date.now();
  dayCalls++;
  try {
    const raw = await callOpenAI(snapshot, st);
    const decision = reviewDecision(snapshot, raw);
    updateSession(st, decision);
    return send(res, 200, { ok: true, version: SERVER_VERSION, model: raw.modelUsed || raw.source || 'local', dayCalls, cap: AI_MAX_CALLS_PER_DAY, latencyMs: Date.now() - started, decision, aiState: sessionForPrompt(st) });
  } catch (e) {
    const fallback = reviewDecision(snapshot, localPracticalDecision(snapshot));
    fallback.source = 'LOCAL_AFTER_AI_ERROR';
    fallback.aiError = String(e.message || e).slice(0, 300);
    updateSession(st, fallback);
    return send(res, 200, { ok: true, version: SERVER_VERSION, model: 'local-fallback', warning: fallback.aiError, dayCalls, cap: AI_MAX_CALLS_PER_DAY, latencyMs: Date.now() - started, decision: fallback, aiState: sessionForPrompt(st) });
  }
}
function runSelfTests() {
  const base = { sessionId: 'test', target: 61910.33, activeTrade: null, market: { price: 61892.34, spreadBps: 2.68 }, timer: { secondsLeft: 860 }, derived: { pAbove: 0.19, gapBps: 2.91, expectedMove: 8.0, m2: 0.25, m15: 0.43, m30: -2.06, driftBpsPerSec: -0.03, reversalScore: 38 } };
  const d1 = reviewDecision(base, { action: 'TRADE_BELOW', confidence: 90, pSettle: 0.81, thesis: 'BELOW', why: 'test' });
  const strong = { ...base, timer: { secondsLeft: 290 }, market: { price: 61730, spreadBps: 1.1 }, derived: { pAbove: 0.08, gapBps: 29.1, expectedMove: 4.0, m2: -1.5, m15: -4.1, m30: -8.5, driftBpsPerSec: -0.09, reversalScore: 18 } };
  const d2 = reviewDecision(strong, { action: 'TRADE_BELOW', confidence: 94, pSettle: 0.92, thesis: 'BELOW', why: 'test' });
  const flatExit = reviewDecision(base, { action: 'EXIT', confidence: 80, thesis: 'NONE', why: 'test' });
  const activeBad = { ...base, activeTrade: 'ABOVE', timer: { secondsLeft: 250 }, derived: { pAbove: 0.22, gapBps: 12, expectedMove: 3, m2: -1, m15: -4, m30: -7, reversalScore: 84 } };
  const d4 = localPracticalDecision(activeBad);
  return [
    { name: 'screenshot scenario is WAIT, not TRADE', pass: d1.action === 'WAIT', got: d1.action, why: d1.why },
    { name: 'strong late below still trades', pass: d2.action === 'TRADE_BELOW', got: d2.action },
    { name: 'flat EXIT converts to WAIT', pass: flatExit.action === 'WAIT', got: flatExit.action },
    { name: 'open losing position exits', pass: d4.action === 'EXIT', got: d4.action }
  ];
}

if (require.main === module && process.env.RUN_SELF_TESTS === 'true') {
  const tests = runSelfTests();
  console.log(JSON.stringify({ ok: tests.every(t => t.pass), tests }, null, 2));
  process.exit(tests.every(t => t.pass) ? 0 : 1);
}

const server = http.createServer(async (req, res) => {
  try {
    cors(res);
    if (req.method === 'OPTIONS') return res.end();
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/health')) return send(res, 200, { ok: true, service: 'btc-ai-backend', version: SERVER_VERSION, openaiEnabled: ENABLE_OPENAI, model: OPENAI_MODEL, dayCalls, cap: AI_MAX_CALLS_PER_DAY, ts: Date.now() });
    if (req.method === 'GET' && (u.pathname === '/market' || u.pathname === '/btc')) return send(res, 200, await getMarket());
    if (req.method === 'GET' && u.pathname === '/selftest') return send(res, 200, { ok: true, tests: runSelfTests() });
    if (req.method === 'POST' && (u.pathname === '/analyze' || u.pathname === '/ai-trader' || u.pathname === '/copilot/auto')) return await handleAi(req, res);
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    return send(res, 500, { ok: false, error: String(e.message || e), version: SERVER_VERSION });
  }
});

server.listen(PORT, () => console.log(`btc-ai-backend ${SERVER_VERSION} listening on ${PORT}, openai=${ENABLE_OPENAI}, model=${OPENAI_MODEL}`));
