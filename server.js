import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import OpenAI from 'openai';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!API_KEY) {
  console.error('[FATAL] OPENAI_API_KEY is missing. Add it in Render Environment Variables.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: API_KEY });
const app = express();

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS origin blocked'));
  }
}));
app.use(express.json({ limit: '750kb' }));

const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const limit = Number(process.env.RATE_LIMIT_PER_MIN || 30);
  const cur = buckets.get(ip) || { start: now, count: 0 };
  if (now - cur.start > windowMs) { cur.start = now; cur.count = 0; }
  cur.count += 1;
  buckets.set(ip, cur);
  if (cur.count > limit) return res.status(429).json({ ok: false, error: 'rate_limited', reason: 'Backend rate limit hit. Wait one minute or raise RATE_LIMIT_PER_MIN.' });
  next();
}

const SnapshotSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).optional(),
  ts: z.union([z.string(), z.number()]).optional(),
  version: z.string().optional(),
  reason: z.string().optional(),
  price: z.number().optional().nullable(),
  target: z.number().optional().nullable(),
  timerSec: z.number().optional().nullable(),
  side: z.string().optional().nullable(),
  chanceUp: z.number().optional().nullable(),
  chanceDown: z.number().optional().nullable(),
  dataMode: z.string().optional().nullable(),
  readiness: z.string().optional().nullable(),
  blockers: z.array(z.string()).optional().default([]),
  upCost: z.number().optional().nullable(),
  downCost: z.number().optional().nullable(),
  marketSanity: z.string().optional().nullable(),
  edgeCents: z.number().optional().nullable(),
  volatility: z.string().optional().nullable(),
  lateGuard: z.string().optional().nullable(),
  reversalRisk: z.string().optional().nullable(),
  reliability: z.number().optional().nullable(),
  tradeQuality: z.number().optional().nullable(),
  notes: z.string().optional().nullable()
}).passthrough();

function finiteOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function textOrNull(x) {
  if (x == null) return null;
  const s = String(x).trim();
  return s ? s.slice(0, 2000) : null;
}
function normalizeSnapshot(input) {
  const raw = input?.snapshot || input || {};
  const s = SnapshotSchema.parse(raw);
  // v64 compatibility: current HTML sends a rich object with nested timer/setup/live/brti/etc.
  const nested = raw;
  return {
    timestamp: s.timestamp || s.ts || new Date().toISOString(),
    version: s.version || nested.version || 'unknown',
    trigger: s.reason || nested.reason || 'manual',
    price: finiteOrNull(s.price ?? nested.live?.price),
    target: finiteOrNull(s.target ?? nested.setup?.target),
    timer: textOrNull(nested.timer?.display) || (finiteOrNull(s.timerSec ?? nested.timer?.minutesLeft) != null ? String(s.timerSec ?? nested.timer?.minutesLeft) : null),
    timerMinutesLeft: finiteOrNull(s.timerSec ?? nested.timer?.minutesLeft),
    position: textOrNull(s.side ?? nested.setup?.position),
    upCost: finiteOrNull(s.upCost ?? nested.setup?.upCost),
    downCost: finiteOrNull(s.downCost ?? nested.setup?.downCost),
    liveHealth: textOrNull(nested.live?.health),
    runStatus: textOrNull(nested.live?.runStatus),
    brtiOk: Boolean(s.brtiOk ?? nested.brti?.ok),
    brtiConfidence: finiteOrNull(nested.brti?.confidence),
    brtiError: finiteOrNull(nested.brti?.error),
    brtiReason: textOrNull(nested.brti?.reason),
    chanceUp: textOrNull(s.chanceUp ?? nested.probabilities?.chanceUp),
    chanceDown: textOrNull(s.chanceDown ?? nested.probabilities?.chanceDown),
    distance: textOrNull(nested.probabilities?.distance),
    entryScore: textOrNull(nested.probabilities?.entryScore),
    adaptiveBar: textOrNull(nested.probabilities?.adaptiveBar),
    probabilityStability: textOrNull(nested.probabilities?.stability),
    signal: textOrNull(nested.decision?.signal ?? s.readiness),
    readiness: textOrNull(nested.decision?.readiness ?? s.readiness),
    why: textOrNull(nested.decision?.why),
    readyNext: textOrNull(nested.decision?.readyNext),
    gates: textOrNull(nested.decision?.gates || (Array.isArray(s.blockers) ? s.blockers.join('\n') : '')),
    marketSanity: textOrNull(s.marketSanity ?? nested.risk?.marketSanity),
    marketPrice: nested.risk?.marketPrice || null,
    edge: textOrNull(s.edgeCents ?? nested.risk?.edge),
    lateGuard: textOrNull(s.lateGuard ?? nested.risk?.lateGuard),
    reversal: textOrNull(s.reversalRisk ?? nested.risk?.reversal),
    evidenceTail: Array.isArray(nested.evidenceTail) ? nested.evidenceTail.slice(-20) : []
  };
}

function clampNumber(x, min, max, fallback) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function normalizeAiForFrontend(obj, snapshot = {}) {
  const independent = obj?.independent_ai && typeof obj.independent_ai === 'object' ? obj.independent_ai : {};
  const engine = obj?.engine_read && typeof obj.engine_read === 'object' ? obj.engine_read : {};
  const consensus = obj?.consensus && typeof obj.consensus === 'object' ? obj.consensus : {};

  const independentDecision = String(independent.decision || obj?.independent_read || 'NO_READ').toUpperCase().slice(0, 80);
  const independentConfidence = clampNumber(independent.confidence ?? obj?.independent_confidence, 0, 100, 0);
  const engineDecision = String(engine.decision || obj?.engine_read_text || snapshot?.engineRead?.trade || snapshot?.signal || 'UNKNOWN').toUpperCase().slice(0, 100);
  const consensusLabel = String(consensus.label || obj?.consensus_label || 'NO_CONSENSUS').toUpperCase().slice(0, 120);
  const finalRead = String(obj?.trade_read || obj?.tradeRead || obj?.action || consensus.final_read || independentDecision || 'NO_READ').toUpperCase().slice(0, 80);
  const reason = String(obj?.reason || consensus.reason || independent.reason || obj?.advisory || obj?.summary || 'No explanation returned.').slice(0, 1200);
  const health = String(obj?.health || obj?.software_health || 'OK').toUpperCase().slice(0, 40);

  return {
    ok: Boolean(obj?.ok ?? true),
    health,
    trade_read: finalRead,
    reason,
    main_blocker: String(obj?.main_blocker || obj?.blocker || independent.blocker || consensus.blocker || '—').slice(0, 280),
    max_price: Number.isFinite(Number(obj?.max_price ?? independent.max_price)) ? Number(obj.max_price ?? independent.max_price) : null,
    anomaly_warning: obj?.anomaly_warning ?? obj?.anomaly ?? obj?.bug_warning ?? null,
    confidence: clampNumber(obj?.confidence ?? consensus.confidence ?? independentConfidence, 0, 100, 50),
    independent_ai: {
      decision: independentDecision,
      confidence: independentConfidence,
      reason: String(independent.reason || '').slice(0, 700),
      blocker: String(independent.blocker || '').slice(0, 240),
      max_price: Number.isFinite(Number(independent.max_price)) ? Number(independent.max_price) : null,
      reasons: Array.isArray(independent.reasons) ? independent.reasons.slice(0, 5).map(x => String(x).slice(0, 180)) : []
    },
    engine_read: {
      decision: engineDecision,
      confidence: clampNumber(engine.confidence, 0, 100, 0),
      reason: String(engine.reason || snapshot?.why || '').slice(0, 500)
    },
    consensus: {
      label: consensusLabel,
      final_read: String(consensus.final_read || finalRead).toUpperCase().slice(0, 80),
      confidence: clampNumber(consensus.confidence ?? obj?.confidence, 0, 100, 50),
      reason: String(consensus.reason || '').slice(0, 700)
    }
  };
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'btc-ai-copilot-backend', version: 'v69.0-independent-ai', endpoints: ['/health', '/analyze', '/api/ai-review'], model: MODEL });
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy', version: 'v69.0-independent-ai', time: new Date().toISOString(), model: MODEL });
});

async function handleAnalyze(req, res) {
  let snapshot;
  try {
    snapshot = normalizeSnapshot(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, health: 'BROKEN', trade_read: 'NO_READ', reason: 'Invalid dashboard snapshot: ' + err.message, main_blocker: 'invalid_snapshot', max_price: null, anomaly_warning: 'frontend_payload_mismatch', confidence: 0 });
  }

  const system = `You are an independent AI market analyst for a BTC 15-minute prediction-contract dashboard. You are not a financial adviser and must not guarantee profit. You must follow this order exactly:
1) Ignore the dashboard engine conclusion.
2) Independently analyze the raw market state: venue prices, quote freshness, venue agreement, raw recent price path, momentum/acceleration, target distance, time remaining, volatility/chop, reversal risk, and contract costs when available.
3) Produce your own independent decision: ABOVE, BELOW, or SIT_OUT. Use FIX_DATA only if market data is unusable.
4) Only after your independent decision is formed, compare it to the deterministic engine read.
5) If independent AI and engine disagree, final trade_read should usually be WAIT or SIT_OUT unless raw data strongly resolves the conflict. Never force agreement.
6) If data is thin, stale, choppy, near-strike, late, or edge is priced out, prefer SIT_OUT.
Return only valid JSON. Do not include markdown.`;
  const user = `Make an independent trading read from this snapshot. Do NOT simply restate the engine. The object contains rawMarket and engineRead separately.

Snapshot:
${JSON.stringify(snapshot, null, 2)}

Return JSON with exactly these top-level keys:
{
  "health": "OK|WATCH|DEGRADED|BROKEN",
  "independent_ai": {
    "decision": "ABOVE|BELOW|SIT_OUT|FIX_DATA",
    "confidence": 0-100,
    "reason": "short independent reasoning based on rawMarket only",
    "blocker": "main raw-market blocker or none",
    "max_price": number|null,
    "reasons": ["up to five raw-market reasons"]
  },
  "engine_read": {
    "decision": "ABOVE|BELOW|SIT_OUT|UNKNOWN",
    "confidence": 0-100,
    "reason": "how the provided engineRead appears to lean"
  },
  "consensus": {
    "label": "AGREE_STRONG|AGREE_WEAK|AI_MORE_CONSERVATIVE|ENGINE_MORE_CONSERVATIVE|CONFLICT_STAND_DOWN|DATA_NOT_USABLE",
    "final_read": "ACT_NOW|PREPARE|WAIT|SIT_OUT|FIX_DATA|NO_READ",
    "confidence": 0-100,
    "reason": "why final read follows from independent AI vs engine comparison"
  },
  "trade_read": "ACT_NOW|PREPARE|WAIT|SIT_OUT|FIX_DATA|NO_READ",
  "reason": "plain-English final instruction for the trader",
  "main_blocker": "single biggest blocker",
  "max_price": number|null,
  "anomaly_warning": string|null,
  "confidence": 0-100
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.12,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });
    const text = completion.choices?.[0]?.message?.content || '{}';
    let ai;
    try { ai = JSON.parse(text); } catch { ai = { health: 'BROKEN', trade_read: 'NO_READ', reason: text, main_blocker: 'ai_json_parse', max_price: null, anomaly_warning: 'AI returned non-JSON', confidence: 0 }; }
    const front = normalizeAiForFrontend(ai, snapshot);
    // v64: return both top-level frontend keys AND nested ai object so old/new dashboards both parse it.
    return res.json({
      ...front,
      ai: front,
      snapshotSummary: snapshot,
      model: MODEL,
      time: new Date().toISOString(),
      backend_version: 'v69.0-independent-ai'
    });
  } catch (err) {
    const msg = err?.message || String(err);
    console.error('[AI_ERROR]', msg);
    return res.status(502).json({ ok: false, health: 'BROKEN', trade_read: 'NO_READ', reason: msg, main_blocker: 'openai_request_failed', max_price: null, anomaly_warning: 'backend_openai_error', confidence: 0, error: 'openai_request_failed' });
  }
}

app.post('/analyze', rateLimit, handleAnalyze);
app.post('/api/ai-review', rateLimit, handleAnalyze);

app.use((err, _req, res, _next) => {
  console.error('[SERVER_ERROR]', err?.message || err);
  res.status(500).json({ ok: false, health: 'BROKEN', trade_read: 'NO_READ', reason: err?.message || 'Server error', main_blocker: 'server_error', max_price: null, anomaly_warning: 'backend_server_error', confidence: 0 });
});

app.listen(PORT, () => {
  console.log(`BTC AI Copilot backend v69.0 listening on port ${PORT}`);
});
