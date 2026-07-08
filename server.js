'use strict';

/*
  BTC v123 Independent AI Copilot Backend
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
const SERVER_VERSION = 'v123-independent-ai-copilot';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENABLE_OPENAI = /^(0|false|no)$/i.test(process.env.ENABLE_OPENAI || '') ? false : (/^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI || '') || !!OPENAI_API_KEY);
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
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'btc-v121-practical-ai/1.0', accept: 'application/json' } });
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
    openaiEnabled: ENABLE_OPENAI && !!OPENAI_API_KEY,
    model: OPENAI_MODEL,
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
  const driftTowardStrike = Number.isFinite(signedGapBps) && Number.isFinite(drift) ? (signedGapBps > 0 ? -drift : drift) : 0;
  const touchScale = Math.max(0.20, expectedMove * (driftTowardStrike > 0 ? 1.15 : 0.92));
  const pTouchStrike = Number.isFinite(gapBps) && Number.isFinite(touchScale)
    ? clamp(2 * (1 - normCdf(gapBps / touchScale)) + (driftTowardStrike > 0 ? Math.min(0.18, driftTowardStrike * secondsLeft / Math.max(1, expectedMove) * 0.08) : 0), 0.01, 0.99)
    : numberFrom(d.pTouchStrike, d.p_touch_strike);
  const pSettleOpposite = side === 'ABOVE' ? pBelow : side === 'BELOW' ? pAbove : numberFrom(d.pSettleOpposite, d.p_settle_opposite);
  return { price, target, secondsLeft, gap, gapBps, signedGapBps, pAbove, pBelow, pSide, side, pTouchStrike, pSettleOpposite, drift, m2, m15, m30, vol, expectedMove, sideMomentum, opposingMomentum, opposingAccel, reversalScore, trendQuality };
}
function dynamicRisk(pr) {
  const t = pr.secondsLeft;
  const expected = Number.isFinite(pr.expectedMove) ? pr.expectedMove : 5;
  let softP;
  if (t > 720) softP = 0.86;
  else if (t > 540) softP = 0.80;
  else if (t > 360) softP = 0.73;
  else if (t > 180) softP = 0.66;
  else if (t > 75) softP = 0.61;
  else softP = 0.57;
  const softGapBps = Math.max(
    t > 720 ? 4.4 : t > 540 ? 3.0 : t > 360 ? 1.9 : t > 180 ? 1.05 : 0.45,
    expected * (t > 720 ? 0.36 : t > 540 ? 0.28 : t > 360 ? 0.20 : t > 180 ? 0.12 : 0.05)
  );
  const scoreNeed = t > 720 ? 66 : t > 540 ? 58 : t > 360 ? 50 : t > 180 ? 42 : t > 75 ? 34 : 28;
  const canOverrideGapWithTape = pr.sideMomentum >= (t > 720 ? 2.65 : t > 540 ? 2.05 : t > 360 ? 1.45 : 0.90) && pr.reversalScore < 58;
  return { reqP: softP, minGapBps: softGapBps, scoreNeed, canOverrideGapWithTape };
}
function opportunityScore(pr, risk) {
  const p = Number.isFinite(pr.pSide) ? pr.pSide : 0.5;
  const pEdge = Math.max(0, (p - 0.50) * 115);
  const gapFit = Number.isFinite(pr.gapBps) && risk.minGapBps > 0 ? clamp((pr.gapBps / risk.minGapBps) * 22, 0, 34) : 0;
  const tapeFit = clamp(pr.sideMomentum * 7.5, -28, 34);
  const trendFit = clamp((pr.trendQuality - 50) * 0.35, -18, 18);
  const timeFit = pr.secondsLeft > 720 ? -8 : pr.secondsLeft > 540 ? -2 : pr.secondsLeft > 360 ? 5 : pr.secondsLeft > 180 ? 10 : 12;
  const revPenalty = clamp(pr.reversalScore * 0.38, 0, 36);
  return clamp(pEdge + gapFit + tapeFit + trendFit + timeFit - revPenalty, 0, 100);
}
function unsafeEarlyThin(pr, risk) {
  if (pr.secondsLeft <= 720) return false;
  const smallGap = pr.gapBps < Math.max(3.7, risk.minGapBps * 0.86);
  const notOneWay = pr.sideMomentum < 2.65 || pr.trendQuality < 66;
  return smallGap && notOneWay;
}
function localPracticalDecision(snapshot) {
  const pr = derivePractical(snapshot);
  const active = String(snapshot.activeTrade || '').toUpperCase();
  if (!Number.isFinite(pr.price) || !Number.isFinite(pr.target) || !Number.isFinite(pr.secondsLeft) || pr.secondsLeft <= 0) {
    return { action: 'WAIT', confidence: 0, pSettle: null, thesis: 'NONE', timing: 'WAIT', why: 'Waiting for live price, target, and timer.', risk: 'missing_data', invalidation: 'Start data and enter strike.', evidence: [], practical: pr, dynamicRisk: dynamicRisk(pr), veto: 'NO_DATA_OR_TARGET' };
  }
  const risk = dynamicRisk(pr);
  const side = pr.side || 'NONE';
  const pSide = pr.pSide;
  const pSettle = side === 'ABOVE' ? pr.pAbove : side === 'BELOW' ? pr.pBelow : null;
  const score = opportunityScore(pr, risk);
  const confidence = Math.round(clamp(score * 0.55 + (Number.isFinite(pSide) ? pSide * 100 : 0) * 0.45, 0, 99));
  if (active === 'ABOVE' || active === 'BELOW') {
    const pWin = active === 'ABOVE' ? pr.pAbove : pr.pBelow;
    const against = active === 'ABOVE' ? -pr.sideMomentum : pr.sideMomentum;
    if ((Number.isFinite(pWin) && pWin < (pr.secondsLeft > 240 ? 0.40 : 0.34)) || (against > 2.6 && pr.reversalScore > 72)) {
      return { action: 'EXIT', confidence: Math.round(clamp(100 - (pWin || 0) * 100, 55, 96)), pSettle: pWin, thesis: 'NONE', timing: 'NOW', why: 'Open position lost practical edge; exit before the opposing move becomes a full loss.', risk: 'position_edge_broken', invalidation: 'If pWin recovers above 0.55 with favorable tape, reassess.', evidence: [`pWin ${Math.round((pWin || 0) * 100)}%`, `reversal ${Math.round(pr.reversalScore)}`, `score ${Math.round(score)}`], practical: pr, dynamicRisk: risk, score, veto: 'NONE' };
    }
    return { action: 'HOLD_' + active, confidence: Math.round(clamp((pWin || 0) * 100, 1, 98)), pSettle: pWin, thesis: active, timing: 'WAIT', why: 'Position edge is still intact; no exit trigger confirmed.', risk: 'normal BTC reversal risk', invalidation: 'Exit if pWin breaks the floor with adverse acceleration.', evidence: [`pWin ${Math.round((pWin || 0) * 100)}%`, `reversal ${Math.round(pr.reversalScore)}`, `score ${Math.round(score)}`], practical: pr, dynamicRisk: risk, score, veto: 'NONE' };
  }
  const earlyThin = unsafeEarlyThin(pr, risk);
  const reversalHot = pr.reversalScore >= (pr.secondsLeft > 360 ? 74 : 84);
  const probabilityFloorMiss = !(Number.isFinite(pSide) && pSide >= risk.reqP);
  const scoreMiss = score < risk.scoreNeed;
  const gapTooWeak = pr.gapBps < risk.minGapBps * 0.55 && !risk.canOverrideGapWithTape && pr.secondsLeft > 180;
  if (earlyThin) {
    return { action: 'WAIT', confidence, pSettle, thesis: side, timing: 'WAIT', why: `Lean ${side}, but still too early/thin for a practical entry: ${pr.gapBps.toFixed(2)} bps with ${Math.round(pr.secondsLeft)}s left.`, risk: 'early_thin_gap_flip_risk', invalidation: 'Trade only if gap expands, time decays, or tape becomes clearly one-way.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `score ${Math.round(score)}/${risk.scoreNeed}`, `gap ${pr.gapBps.toFixed(2)}bps`], practical: pr, dynamicRisk: risk, score, veto: 'EARLY_THIN_GAP' };
  }
  if (reversalHot || probabilityFloorMiss || scoreMiss || gapTooWeak) {
    const bits = [];
    if (reversalHot) bits.push(`reversal ${Math.round(pr.reversalScore)} hot`);
    if (probabilityFloorMiss) bits.push(`p ${Math.round(pSide * 100)}% < soft floor ${Math.round(risk.reqP * 100)}%`);
    if (scoreMiss) bits.push(`score ${Math.round(score)} < ${risk.scoreNeed}`);
    if (gapTooWeak) bits.push(`gap ${pr.gapBps.toFixed(2)}bps too weak`);
    return { action: 'WAIT', confidence, pSettle, thesis: side, timing: 'WAIT', why: `Lean ${side}, but not executable yet: ${bits.join('; ')}.`, risk: 'not_actionable_yet', invalidation: 'Trade once score, probability, gap/tape, and reversal pressure line up.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `score ${Math.round(score)}/${risk.scoreNeed}`, `rev ${Math.round(pr.reversalScore)}`], practical: pr, dynamicRisk: risk, score, veto: 'SOFT_SCORE_NOT_READY' };
  }
  return { action: 'TRADE_' + side, confidence, pSettle, thesis: side, timing: 'NOW', why: `Executable practical entry: score ${Math.round(score)}/${risk.scoreNeed}, ${Math.round(pSide * 100)}% settle ${side}, gap ${pr.gapBps.toFixed(2)} bps, tape ${pr.sideMomentum.toFixed(2)}.`, risk: 'BTC can still reverse; track entered side.', invalidation: 'Exit if pWin breaks floor or reversal pressure confirms against the side.', evidence: [`pSide ${Math.round(pSide * 100)}%`, `score ${Math.round(score)}`, `gap ${pr.gapBps.toFixed(2)}bps`], practical: pr, dynamicRisk: risk, score, veto: 'NONE' };
}

function practicalContext(snapshot) {
  const pr = derivePractical(snapshot);
  const risk = dynamicRisk(pr);
  const local = localPracticalDecision(snapshot);
  const side = pr.side || 'NONE';
  const gapUsd = Number.isFinite(pr.gap) ? pr.gap : null;
  const pSide = side === 'ABOVE' ? pr.pAbove : side === 'BELOW' ? pr.pBelow : null;
  const facts = {
    price: Number.isFinite(pr.price) ? Number(pr.price.toFixed(2)) : null,
    target: Number.isFinite(pr.target) ? Number(pr.target.toFixed(2)) : null,
    secondsLeft: Number.isFinite(pr.secondsLeft) ? Math.round(pr.secondsLeft) : null,
    sideFromSettlementGeometry: side,
    signedGapBps: Number.isFinite(pr.signedGapBps) ? Number(pr.signedGapBps.toFixed(2)) : null,
    gapBps: Number.isFinite(pr.gapBps) ? Number(pr.gapBps.toFixed(2)) : null,
    gapUsd: Number.isFinite(gapUsd) ? Number(gapUsd.toFixed(2)) : null,
    pSettleAbove: Number.isFinite(pr.pAbove) ? Number(pr.pAbove.toFixed(4)) : null,
    pSettleBelow: Number.isFinite(pr.pBelow) ? Number(pr.pBelow.toFixed(4)) : null,
    pSettleSide: Number.isFinite(pSide) ? Number(pSide.toFixed(4)) : null,
    pTouchStrike: Number.isFinite(pr.pTouchStrike) ? Number(pr.pTouchStrike.toFixed(4)) : null,
    pSettleOpposite: Number.isFinite(pr.pSettleOpposite) ? Number(pr.pSettleOpposite.toFixed(4)) : null,
    move2Bps: Number.isFinite(pr.m2) ? Number(pr.m2.toFixed(2)) : null,
    move15Bps: Number.isFinite(pr.m15) ? Number(pr.m15.toFixed(2)) : null,
    move30Bps: Number.isFinite(pr.m30) ? Number(pr.m30.toFixed(2)) : null,
    driftBpsPerSec: Number.isFinite(pr.drift) ? Number(pr.drift.toFixed(4)) : null,
    sideMomentum: Number.isFinite(pr.sideMomentum) ? Number(pr.sideMomentum.toFixed(2)) : null,
    reversalScore: Number.isFinite(pr.reversalScore) ? Math.round(pr.reversalScore) : null,
    expectedMoveBps: Number.isFinite(pr.expectedMove) ? Number(pr.expectedMove.toFixed(2)) : null,
    dynamicReqP: Number.isFinite(risk.reqP) ? Number(risk.reqP.toFixed(3)) : null,
    dynamicMinGapBps: Number.isFinite(risk.minGapBps) ? Number(risk.minGapBps.toFixed(2)) : null,
    opportunityScore: Number.isFinite(local.score) ? Math.round(local.score) : null,
    localTelemetryCommand: local.action,
    localTelemetryVeto: local.veto || 'NONE',
    localTelemetryWhy: local.why
  };
  const readable = [
    `Price is ${facts.price} and strike/target is ${facts.target}.`,
    `Geometry side is ${side}; signed gap is ${facts.signedGapBps} bps (${facts.gapUsd} dollars).`,
    `${facts.secondsLeft}s remain; P(ABOVE) ${Math.round((pr.pAbove || 0) * 100)}%, P(BELOW) ${Math.round((pr.pBelow || 0) * 100)}%.`,
    `P(touch strike) ${Math.round((pr.pTouchStrike || 0) * 100)}%; P(settle opposite) ${Math.round((pr.pSettleOpposite || 0) * 100)}%.`,
    `Tape 2/15/30s = ${facts.move2Bps}/${facts.move15Bps}/${facts.move30Bps} bps; reversal score ${facts.reversalScore}.`,
    `Local telemetry says ${local.action}; treat that as instrument data, not an order.`
  ];
  return { facts, readable, practical: pr, risk, local };
}
function needsAiSecondLook(snapshot, reviewed) {
  const ctx = practicalContext(snapshot);
  const pr = ctx.practical;
  const local = ctx.local;
  const action = normalizeAction(reviewed && reviewed.action);
  const text = String(reviewed?.why || '') + ' ' + String(reviewed?.risk || '') + ' ' + (Array.isArray(reviewed?.evidence) ? reviewed.evidence.join(' ') : '');
  const localSide = sideFromAction(local.action) || local.thesis;
  const strongGeometry = local.action === 'TRADE_' + localSide && Number.isFinite(pr.pSide) && pr.pSide >= 0.965 && Number.isFinite(pr.pSettleOpposite) && pr.pSettleOpposite <= 0.045 && Number.isFinite(pr.gapBps) && pr.gapBps >= 7.5 && pr.secondsLeft <= 420 && pr.reversalScore < 62;
  const lowTouch = Number.isFinite(pr.pTouchStrike) && pr.pTouchStrike <= 0.25;
  const factualLanguageMismatch = (/small distance|notable touch|touching the strike is notable|close to the strike/i.test(text) && ((Number.isFinite(pr.gapBps) && pr.gapBps >= 7.5) || lowTouch));
  const geometryDisagreement = action === 'WAIT' && strongGeometry && lowTouch;
  const noThesisDespiteGeometry = action === 'WAIT' && (reviewed?.thesis === 'NONE' || !reviewed?.thesis) && Number.isFinite(pr.pSide) && pr.pSide >= 0.95;
  return Boolean(factualLanguageMismatch || geometryDisagreement || noThesisDespiteGeometry);
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
    evidence: Array.isArray(obj.evidence) ? obj.evidence.slice(0, 5).map(x => String(x).slice(0, 80)) : [],
    pTouchStrike: Number.isFinite(Number(obj.pTouchStrike)) ? clamp(Number(obj.pTouchStrike), 0, 1) : null,
    pSettleOpposite: Number.isFinite(Number(obj.pSettleOpposite)) ? clamp(Number(obj.pSettleOpposite), 0, 1) : null,
    reasoning_class: String(obj.reasoning_class || '').slice(0, 80),
    source: obj.source || undefined
  };
}
function reviewDecision(snapshot, decision) {
  const local = localPracticalDecision(snapshot);
  let d = normalizeDecision(decision);
  const rawSource = String(decision?.source || d.source || '').toUpperCase();
  const active = String(snapshot.activeTrade || '').toUpperCase();
  const pr = local.practical;
  const risk = local.dynamicRisk || dynamicRisk(pr);
  const aiSide = sideFromAction(d.action) || (d.thesis === 'ABOVE' || d.thesis === 'BELOW' ? d.thesis : null);
  const localSide = local.thesis;
  const score = Number.isFinite(local.score) ? local.score : opportunityScore(pr, risk);
  if (d.pTouchStrike == null && Number.isFinite(pr.pTouchStrike)) d.pTouchStrike = pr.pTouchStrike;
  if (d.pSettleOpposite == null && Number.isFinite(pr.pSettleOpposite)) d.pSettleOpposite = pr.pSettleOpposite;
  if (!(active === 'ABOVE' || active === 'BELOW') && (d.action === 'EXIT' || d.action.startsWith('HOLD'))) {
    d = { ...d, action: 'WAIT', timing: 'WAIT', thesis: 'NONE', why: 'Flat account: AI produced a position-management command, so it was converted to WAIT. ' + d.why, veto: 'FLAT_POSITION_AI_HOLD_EXIT' };
  }
  if (!(active === 'ABOVE' || active === 'BELOW') && d.action.startsWith('TRADE')) {
    const pForAi = aiSide === 'ABOVE' ? pr.pAbove : aiSide === 'BELOW' ? pr.pBelow : NaN;
    const noMarket = !Number.isFinite(pr.price) || !Number.isFinite(pr.target) || pr.secondsLeft <= 0;
    const impossibleSide = !aiSide || !Number.isFinite(pForAi) || pForAi < 0.43;
    const lastMinuteMismatch = aiSide && localSide && aiSide !== localSide && pr.secondsLeft < 75;
    const earlyThin = unsafeEarlyThin(pr, risk);
    const highTouch = Number.isFinite(pr.pTouchStrike) && pr.pTouchStrike >= 0.52;
    const explicitException = /one[- ]?way|accelerat|decisive|exception|breakaway|momentum override/i.test(String(d.why || '') + ' ' + String(d.risk || '') + ' ' + (d.evidence || []).join(' '));
    if (noMarket || impossibleSide || lastMinuteMismatch || (earlyThin && highTouch && !explicitException)) {
      const whyBits = [];
      if (noMarket) whyBits.push('missing live market/target/timer');
      if (impossibleSide) whyBits.push(`AI side probability ${Number.isFinite(pForAi) ? Math.round(pForAi * 100) + '%' : 'n/a'} is not executable`);
      if (lastMinuteMismatch) whyBits.push('last-minute side mismatch with settlement geometry');
      if (earlyThin && highTouch && !explicitException) whyBits.push(`early thin gap with ${Math.round((pr.pTouchStrike || 0) * 100)}% touch-strike risk`);
      d = { ...d, action: 'WAIT', timing: 'WAIT', thesis: aiSide || localSide || 'NONE', why: `AI trade rejected only by sanity governor: ${whyBits.join('; ')}.`, risk: 'sanity_governor', evidence: (d.evidence || []).concat(whyBits.slice(0, 3)), veto: earlyThin ? 'EARLY_THIN_TOUCH_RISK' : 'SANITY_GOVERNOR', pTouchStrike: pr.pTouchStrike, pSettleOpposite: pr.pSettleOpposite };
    }
  }
  // v122: no local rapid-catchup override of an OpenAI WAIT. If the model says WAIT, WAIT remains final.
  // LocalPracticalDecision is retained for telemetry and offline fallback only.
  d.review = { localAction: local.action, localWhy: local.why, dynamicReqP: risk.reqP, dynamicMinGapBps: risk.minGapBps, scoreNeed: risk.scoreNeed, opportunityScore: score, pSide: pr.pSide, pTouchStrike: pr.pTouchStrike, pSettleOpposite: pr.pSettleOpposite, gapBps: pr.gapBps, secondsLeft: pr.secondsLeft, reversalScore: pr.reversalScore, sideMomentum: pr.sideMomentum, rawSource };
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

function aiSystemPrompt(kind) {
  const base = `You are the independent AI Copilot for 15-minute BTC ABOVE/BELOW event contracts. You are the decision-maker, not a formatter for the local engine. Local telemetry is instrument data only, not an order. Decide what a practical human second trader should do NOW: WAIT, TRADE_ABOVE, TRADE_BELOW when flat; HOLD_ABOVE/HOLD_BELOW/EXIT when in a position. Use judgment across time left, distance to strike, P(settle), P(touch strike), P(settle opposite), drift, fresh 2/15/30s tape, venue spread, acceleration, reversal pressure, and contract price if supplied. Do not trade from probability alone. Do not wait for perfection when geometry is decisive and touch/opposite risk is low. Ground your conclusion in the facts: do not call a 7+ bps gap "small" unless the computed touch probability and tape justify that; do not call touch risk "notable" when P(touch strike) is low unless you identify a live adverse tape reason. Return compact JSON only with keys: action, confidence, pSettle, pTouchStrike, pSettleOpposite, thesis, timing, why, risk, invalidation, invalidation_hit, reasoning_class, evidence.`;
  if (kind === 'audit') return base + ` You are now doing a second-look audit because the first AI answer may have contradicted the numeric facts. Be independent, but reconcile the facts explicitly. If you still choose WAIT while P(settle side) is very high, P(touch strike) is low, and P(settle opposite) is very low, name the concrete adverse tape/venue/liquidity reason. Otherwise issue the practical trade command.`;
  return base;
}
async function openAIJson(messages) {
  const body = { model: OPENAI_MODEL, messages, temperature: 0.06, max_tokens: AI_MAX_OUTPUT_TOKENS, response_format: { type: 'json_object' } };
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
    parsed.modelUsed = OPENAI_MODEL;
    parsed.usage = j.usage || null;
    return parsed;
  } finally { clearTimeout(t); }
}
async function callOpenAI(snapshot, st) {
  const ctx = practicalContext(snapshot);
  if (!ENABLE_OPENAI || !OPENAI_API_KEY) return { action: 'WAIT', confidence: 0, pSettle: null, thesis: 'NONE', timing: 'WAIT', why: 'Backend AI is OFF or missing OPENAI_API_KEY; refusing to issue a fake local-engine trade.', risk: 'no_openai_authority', invalidation: 'Set OPENAI_API_KEY on Render and confirm backend health shows AI ON.', evidence: ctx.readable.slice(0, 4), source: ENABLE_OPENAI ? 'LOCAL_NO_KEY_WAIT' : 'LOCAL_OPENAI_DISABLED_WAIT' };
  const user1 = {
    prior_ai_state: sessionForPrompt(st),
    decision_facts: ctx.facts,
    plain_english_facts: ctx.readable,
    live_snapshot: snapshot,
    instruction: 'Act independently and issue one practical command now. The facts are authoritative; localTelemetry is only an instrument. Do not describe a far/low-touch strike as small/high-touch.'
  };
  const first = await openAIJson([{ role: 'system', content: aiSystemPrompt('normal') }, { role: 'user', content: JSON.stringify(user1) }]);
  first.source = 'OPENAI';
  const firstReviewed = reviewDecision(snapshot, first);
  if (needsAiSecondLook(snapshot, firstReviewed)) {
    const user2 = {
      prior_ai_state: sessionForPrompt(st),
      first_ai_decision: firstReviewed,
      decision_facts: ctx.facts,
      plain_english_facts: ctx.readable,
      instruction: 'Second-look audit: the first answer appears inconsistent with numeric facts or ignored a decisive setup. Re-decide independently. Do not follow localTelemetry mechanically, but do not contradict the authoritative facts.'
    };
    const second = await openAIJson([{ role: 'system', content: aiSystemPrompt('audit') }, { role: 'user', content: JSON.stringify(user2) }]);
    second.source = 'OPENAI_AUDIT';
    second.auditTriggered = true;
    second.firstDecision = { action: firstReviewed.action, confidence: firstReviewed.confidence, why: firstReviewed.why, veto: firstReviewed.veto || 'NONE' };
    return second;
  }
  return first;
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
    return send(res, 200, { ok: true, version: SERVER_VERSION, openaiEnabled: ENABLE_OPENAI && !!OPENAI_API_KEY, model: raw.modelUsed || raw.source || 'local', dayCalls, cap: AI_MAX_CALLS_PER_DAY, latencyMs: Date.now() - started, decision, aiState: sessionForPrompt(st) });
  } catch (e) {
    const local = localPracticalDecision(snapshot);
    const fallback = reviewDecision(snapshot, { action: 'WAIT', confidence: 0, thesis: 'NONE', timing: 'WAIT', why: 'AI backend error; refusing to issue a fake local-engine trade. ' + String(e.message || e).slice(0, 200), risk: 'ai_error_no_authority', invalidation: 'Check Render logs / OpenAI billing / model access.', evidence: (local.evidence || []).slice(0, 3), source: 'LOCAL_AFTER_AI_ERROR_WAIT' });
    updateSession(st, fallback);
    return send(res, 200, { ok: true, version: SERVER_VERSION, openaiEnabled: ENABLE_OPENAI && !!OPENAI_API_KEY, model: fallback.source, warning: String(e.message || e).slice(0, 300), dayCalls, cap: AI_MAX_CALLS_PER_DAY, latencyMs: Date.now() - started, decision: fallback, aiState: sessionForPrompt(st) });
  }
}
function runSelfTests() {
  const base = { sessionId: 'test', target: 61910.33, activeTrade: null, market: { price: 61892.34, spreadBps: 2.68 }, timer: { secondsLeft: 860 }, derived: { pAbove: 0.19, pBelow: 0.81, pTouchStrike: 0.67, pSettleOpposite: 0.19, gapBps: 2.91, expectedMove: 8.0, m2: 0.25, m15: 0.43, m30: -2.06, driftBpsPerSec: -0.03, reversalScore: 38 } };
  const d1 = reviewDecision(base, { source: 'OPENAI', action: 'TRADE_BELOW', confidence: 90, pSettle: 0.81, pTouchStrike: 0.67, pSettleOpposite: 0.19, thesis: 'BELOW', why: 'trade from probability only' });
  const strong = { ...base, timer: { secondsLeft: 290 }, market: { price: 61730, spreadBps: 1.1 }, derived: { pAbove: 0.08, pBelow: 0.92, pTouchStrike: 0.08, pSettleOpposite: 0.08, gapBps: 29.1, expectedMove: 4.0, m2: -1.5, m15: -4.1, m30: -8.5, driftBpsPerSec: -0.09, reversalScore: 18 } };
  const d2 = reviewDecision(strong, { source: 'OPENAI', action: 'TRADE_BELOW', confidence: 94, pSettle: 0.92, pTouchStrike: 0.08, pSettleOpposite: 0.08, thesis: 'BELOW', why: 'decisive one-way acceleration; momentum override', evidence: ['one-way acceleration'] });
  const missed = { ...base, timer: { secondsLeft: 470 }, market: { price: 61870, spreadBps: 1.0 }, derived: { pAbove: 0.23, pBelow: 0.77, pTouchStrike: 0.22, pSettleOpposite: 0.23, gapBps: 6.5, expectedMove: 6.0, m2: -0.8, m15: -2.7, m30: -5.0, driftBpsPerSec: -0.055, reversalScore: 24 } };
  const d3 = reviewDecision(missed, { source: 'OPENAI', action: 'TRADE_BELOW', confidence: 88, pSettle: 0.77, pTouchStrike: 0.22, pSettleOpposite: 0.23, thesis: 'BELOW', why: 'AI catch-up trade: decisive one-way tape, not waiting for perfection.', evidence: ['decisive one-way'] });
  const flatExit = reviewDecision(base, { source: 'OPENAI', action: 'EXIT', confidence: 80, thesis: 'NONE', why: 'test' });
  return [
    { name: 'early thin high-touch trade rejected by sanity governor', pass: d1.action === 'WAIT' && d1.veto === 'EARLY_THIN_TOUCH_RISK', got: d1.action + ' ' + d1.veto, why: d1.why },
    { name: 'strong late below obeys AI trade', pass: d2.action === 'TRADE_BELOW', got: d2.action },
    { name: 'mid-window catch-up obeys AI trade', pass: d3.action === 'TRADE_BELOW', got: d3.action },
    { name: 'flat EXIT converts to WAIT', pass: flatExit.action === 'WAIT', got: flatExit.action },
    { name: 'second-look trigger catches bad AI WAIT on far/low-touch setup', pass: needsAiSecondLook({ target: 61756.60, timer: { secondsLeft: 124 }, market: { price: 61911.32, spreadBps: 1.83 }, derived: { pAbove: .99, pBelow: .01, pTouchStrike: .15, pSettleOpposite: .01, gapBps: 25.05, signedGapBps: 25.05, m2: .04, m15: -1.11, m30: 2.64, driftBpsPerSec: -.069, reversalScore: 25, sideMomentum: 1.10 } }, { action: 'WAIT', confidence: 1, thesis: 'NONE', why: 'small distance to the strike and notable probability of touching the strike' }) === true, got: 'trigger' },
    { name: 'pTouchStrike and pSettleOpposite present', pass: Number.isFinite(d2.pTouchStrike) && Number.isFinite(d2.pSettleOpposite), got: { pTouchStrike: d2.pTouchStrike, pSettleOpposite: d2.pSettleOpposite } }
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
