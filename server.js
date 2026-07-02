import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';

const app = express();
const port = Number(process.env.PORT || 8787);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: allowedOrigin === '*' ? true : allowedOrigin }));
app.use(express.json({ limit: '1mb' }));

const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

function localFallback(snapshot) {
  const text = JSON.stringify(snapshot || {}).toUpperCase();
  let health = 'OK';
  let trade_read = 'SIT_OUT';
  let reason = 'Local fallback: backend received the snapshot, but OPENAI_API_KEY is not set. Hard math gates remain authoritative.';
  let main_blocker = 'AI key not configured';
  let anomaly_warning = 'AI model not connected';
  let max_price = null;

  if (text.includes('FIX DATA') || text.includes('STALE') || text.includes('DISAGREE') || text.includes('BROKEN')) {
    health = 'DEGRADED'; trade_read = 'NO_TRADE'; main_blocker = 'data quality';
  } else if (text.includes('TRADE NOW') || text.includes('ACT NOW') || text.includes('AHEAD NOW')) {
    trade_read = 'REVIEW_TRADE_NOW'; main_blocker = 'verify live market cost before execution'; reason = 'Local fallback sees an actionable dashboard state. Confirm cost/edge and hard gates.';
  } else if (text.includes('COUNTDOWN') || text.includes('AHEAD PREP') || text.includes('PREP')) {
    trade_read = 'PREPARE_ONLY'; main_blocker = 'clock or entry gate not complete';
  }
  return { health, trade_read, reason, main_blocker, max_price, anomaly_warning, confidence: 50 };
}

const outputSchema = {
  name: 'ai_trade_review',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      health: { type: 'string', enum: ['OK', 'DEGRADED', 'BROKEN', 'UNKNOWN'] },
      trade_read: { type: 'string', enum: ['TRADE_NOW', 'PREPARE_ONLY', 'SIT_OUT', 'NO_TRADE', 'FIX_DATA', 'REVIEW_TRADE_NOW'] },
      reason: { type: 'string' },
      main_blocker: { type: 'string' },
      max_price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      anomaly_warning: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 100 }
    },
    required: ['health', 'trade_read', 'reason', 'main_blocker', 'max_price', 'anomaly_warning', 'confidence']
  },
  strict: true
};

app.get('/health', (_req, res) => res.json({ ok: true, model, aiConfigured: !!client }));

app.post('/api/ai-review', async (req, res) => {
  const snapshot = req.body || {};
  if (!client) return res.json(localFallback(snapshot));

  try {
    const response = await client.responses.create({
      model,
      input: [
        {
          role: 'system',
          content: 'You are an advisory AI copilot for a BTC prediction-contract dashboard. You do not execute trades, do not override hard gates, do not promise certainty, and do not rewrite code during live trading. Review the snapshot for software-health problems, data-quality problems, edge quality, price-expensiveness, reversal risk, and whether the dashboard state supports TRADE_NOW, PREPARE_ONLY, SIT_OUT, NO_TRADE, or FIX_DATA. Be conservative. Return only the requested JSON.'
        },
        { role: 'user', content: JSON.stringify(snapshot).slice(0, 30000) }
      ],
      text: { format: { type: 'json_schema', ...outputSchema } }
    });

    const raw = response.output_text || '{}';
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (err) {
    console.error(err);
    res.status(502).json({
      health: 'DEGRADED',
      trade_read: 'NO_TRADE',
      reason: 'AI backend error. Do not rely on AI review until backend recovers.',
      main_blocker: err?.message || 'AI API error',
      max_price: null,
      anomaly_warning: 'AI backend failed',
      confidence: 0
    });
  }
});

app.listen(port, () => {
  console.log(`BTC Signal AI Copilot backend running on http://localhost:${port}`);
});
