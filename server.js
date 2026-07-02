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
function normalizeAiForFrontend(obj) {
  const action = String(obj?.trade_read || obj?.tradeRead || obj?.action || 'NO_READ').toUpperCase().slice(0, 80);
  const reason = String(obj?.reason || obj?.advisory || obj?.summary || obj?.risk || 'No explanation returned.').slice(0, 900);
  const health = String(obj?.health || obj?.software_health || 'OK').toUpperCase().slice(0, 40);
  return {
    ok: Boolean(obj?.ok ?? true),
    health,
    trade_read: action,
    reason,
    main_blocker: String(obj?.main_blocker || obj?.blocker || obj?.mainBlocker || '—').slice(0, 240),
    max_price: Number.isFinite(Number(obj?.max_price)) ? Number(obj.max_price) : null,
    anomaly_warning: obj?.anomaly_warning ?? obj?.anomaly ?? obj?.bug_warning ?? null,
    confidence: clampNumber(obj?.confidence, 0, 100, 50)
  };
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'btc-ai-copilot-backend', version: 'v64-frontend-compatible', endpoints: ['/health', '/analyze', '/api/ai-review'], model: MODEL });
});
app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy', version: 'v64-frontend-compatible', time: new Date().toISOString(), model: MODEL });
});

async function handleAnalyze(req, res) {
  let snapshot;
  try {
    snapshot = normalizeSnapshot(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, health: 'BROKEN', trade_read: 'NO_READ', reason: 'Invalid dashboard snapshot: ' + err.message, main_blocker: 'invalid_snapshot', max_price: null, anomaly_warning: 'frontend_payload_mismatch', confidence: 0 });
  }

  const system = `You are an AI copilot monitoring a BTC 15-minute prediction-contract dashboard. You are not a financial adviser. Do not guarantee profit or certainty. Do not override hard safety gates. Your job: explain current software/data health, edge quality, main blocker, and whether the user should sit out, wait, prepare, or consider action only if the dashboard's own gates allow it. Return only valid JSON with the exact keys requested.`;
  const user = `Analyze this dashboard snapshot for a trading decision aid. Be concise and practical. If data is bad, edge is absent, confidence is unstable, or price is too expensive, say so clearly. Do not tell the user to trade if the dashboard has blockers.\n\nSnapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nReturn JSON with exactly these keys:\nhealth: string (OK, WATCH, DEGRADED, BROKEN)\ntrade_read: string (ACT_NOW, PREPARE, WAIT, SIT_OUT, FIX_DATA, NO_READ)\nreason: string\nmain_blocker: string\nmax_price: number or null\nanomaly_warning: string or null\nconfidence: number 0-100`;

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
    const front = normalizeAiForFrontend(ai);
    // v64: return both top-level frontend keys AND nested ai object so old/new dashboards both parse it.
    return res.json({
      ...front,
      ai: front,
      snapshotSummary: snapshot,
      model: MODEL,
      time: new Date().toISOString(),
      backend_version: 'v64-frontend-compatible'
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
  console.log(`BTC AI Copilot backend v64 listening on port ${PORT}`);
});
