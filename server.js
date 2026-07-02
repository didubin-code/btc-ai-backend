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
  if (cur.count > limit) return res.status(429).json({ ok: false, error: 'rate_limited' });
  next();
}

const SnapshotSchema = z.object({
  timestamp: z.union([z.string(), z.number()]).optional(),
  version: z.string().optional(),
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
  notes: z.string().optional().nullable(),
  raw: z.record(z.any()).optional()
}).passthrough();

function safeNumber(x) { return Number.isFinite(x) ? x : null; }
function normalizeSnapshot(input) {
  const s = SnapshotSchema.parse(input || {});
  return {
    timestamp: s.timestamp || new Date().toISOString(),
    version: s.version || 'unknown',
    price: safeNumber(s.price),
    target: safeNumber(s.target),
    timerSec: safeNumber(s.timerSec),
    side: s.side || null,
    chanceUp: safeNumber(s.chanceUp),
    chanceDown: safeNumber(s.chanceDown),
    dataMode: s.dataMode || null,
    readiness: s.readiness || null,
    blockers: Array.isArray(s.blockers) ? s.blockers.slice(0, 20) : [],
    upCost: safeNumber(s.upCost),
    downCost: safeNumber(s.downCost),
    marketSanity: s.marketSanity || null,
    edgeCents: safeNumber(s.edgeCents),
    volatility: s.volatility || null,
    lateGuard: s.lateGuard || null,
    reversalRisk: s.reversalRisk || null,
    reliability: safeNumber(s.reliability),
    tradeQuality: safeNumber(s.tradeQuality),
    notes: s.notes || null
  };
}

app.get('/', (_req, res) => {
  res.json({ ok: true, service: 'btc-ai-copilot-backend', endpoints: ['/health', '/analyze'], model: MODEL });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, status: 'healthy', time: new Date().toISOString(), model: MODEL });
});

app.post('/analyze', rateLimit, async (req, res) => {
  let snapshot;
  try {
    snapshot = normalizeSnapshot(req.body?.snapshot || req.body || {});
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'invalid_snapshot', detail: err.message });
  }

  const system = `You are an AI copilot monitoring a BTC 15-minute prediction-contract decision dashboard. You are NOT a financial adviser and must not guarantee results. Your job is to sanity-check the software state, explain blockers, flag data/software anomalies, and provide a conservative advisory read. Never override hard data/safety gates. Return only valid JSON.`;
  const user = `Analyze this live dashboard snapshot. Keep it concise, practical, and risk-aware. If data is bad or edge is missing, say so clearly. Snapshot JSON:\n${JSON.stringify(snapshot, null, 2)}\n\nReturn JSON with exactly these keys: ok(boolean), health(string), advisory(string), action(string), main_blocker(string), max_price(number|null), risk(string), anomaly(string|null), confidence(number 0-100).`;

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    });
    const text = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { ok: false, health: 'AI parse error', advisory: text, action: 'DO_NOT_TRADE', main_blocker: 'invalid_ai_json', max_price: null, risk: 'Ignore this AI output until fixed.', anomaly: 'AI returned non-JSON', confidence: 0 }; }
    return res.json({ ok: true, ai: parsed, snapshotSummary: snapshot, model: MODEL, time: new Date().toISOString() });
  } catch (err) {
    console.error('[AI_ERROR]', err?.message || err);
    return res.status(502).json({ ok: false, error: 'openai_request_failed', detail: err?.message || String(err) });
  }
});

app.use((err, _req, res, _next) => {
  console.error('[SERVER_ERROR]', err?.message || err);
  res.status(500).json({ ok: false, error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`BTC AI Copilot backend listening on port ${PORT}`);
});
