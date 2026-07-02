import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const API_KEY = process.env.OPENAI_API_KEY;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

if (!API_KEY) {
  console.error('[FATAL] OPENAI_API_KEY is missing. Add it in Render Environment Variables.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: API_KEY });
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin(origin, cb) { if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) return cb(null, true); return cb(new Error('CORS origin blocked')); }}));
app.use(express.json({ limit: '900kb' }));

const buckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown', now = Date.now(), windowMs = 60_000, limit = Number(process.env.RATE_LIMIT_PER_MIN || 30);
  const cur = buckets.get(ip) || { start: now, count: 0 };
  if (now - cur.start > windowMs) { cur.start = now; cur.count = 0; }
  cur.count += 1; buckets.set(ip, cur);
  if (cur.count > limit) return res.status(429).json({ ok:false, health:'BROKEN', trade_read:'NO_READ', reason:'Backend rate limit hit. Wait one minute or raise RATE_LIMIT_PER_MIN.', main_blocker:'rate_limit', max_price:null, anomaly_warning:'backend_rate_limit', confidence:0 });
  next();
}

const finite = x => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const text = (x, lim=2000) => x == null ? null : String(x).trim().slice(0, lim) || null;
const clamp = (x, a=0, b=100, fallback=0) => { const n=Number(x); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : fallback; };
function parsePercent(s){ const m=String(s ?? '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; }
function sideFromEngine(engineRead={}) {
  const s = `${engineRead.trade||''} ${engineRead.logic||''} ${engineRead.chanceUp||''} ${engineRead.chanceDown||''}`.toUpperCase();
  if (/DO NOT|SIT|WAIT|NO TRADE|BLOCK|FIX DATA/.test(s)) return 'SIT_OUT';
  if (/ABOVE|\bUP\b/.test(s)) return 'ABOVE';
  if (/BELOW|\bDOWN\b/.test(s)) return 'BELOW';
  const up=parsePercent(engineRead.chanceUp), down=parsePercent(engineRead.chanceDown);
  if (up != null && down != null) return up > down ? 'ABOVE' : down > up ? 'BELOW' : 'UNKNOWN';
  return 'UNKNOWN';
}
function bps(a,b){ return a && b ? ((b/a)-1)*10000 : null; }
function calcFeatures(raw={}) {
  const rm = raw.rawMarket || {};
  const venues = Array.isArray(rm.venues) ? rm.venues : [];
  const series = Array.isArray(rm.recentSeries) ? rm.recentSeries.filter(x => Number.isFinite(Number(x.p))).map(x => ({t:Number(x.t), p:Number(x.p)})) : [];
  const fresh = venues.filter(v => Number(v.ageMs) < 3500 && Number.isFinite(Number(v.price)));
  const quoted = fresh.filter(v => Number.isFinite(Number(v.mid)));
  const prices = fresh.map(v => Number(v.mid ?? v.price)).filter(Number.isFinite);
  const last = series.length ? series[series.length-1].p : finite(raw.live?.price);
  const first60 = series.filter(x => Number(x.t) <= 60)[0]?.p ?? series[0]?.p ?? null;
  const first180 = series[0]?.p ?? null;
  const move60Bps = finite(rm.summary?.move60Bps) ?? bps(first60, last);
  const move180Bps = finite(rm.summary?.move180Bps) ?? bps(first180, last);
  const dispersion = prices.length > 1 ? Math.max(...prices)-Math.min(...prices) : null;
  const avgSpread = fresh.length ? fresh.map(v => finite(v.spreadBps)).filter(x=>x!=null).reduce((a,b)=>a+b,0) / Math.max(1,fresh.map(v => finite(v.spreadBps)).filter(x=>x!=null).length) : null;
  const target = finite(raw.setup?.target);
  const distBps = target && last ? ((last/target)-1)*10000 : null;
  const upCost = finite(raw.setup?.upCost), downCost = finite(raw.setup?.downCost);
  const timerMinutesLeft = finite(raw.timer?.minutesLeft);
  return {
    freshVenueCount: fresh.length,
    quotedVenueCount: quoted.length,
    lastPrice: last,
    target,
    distanceToTargetBps: distBps,
    move60Bps,
    move180Bps,
    venueDispersionDollars: dispersion,
    avgSpreadBps: avgSpread,
    upCost,
    downCost,
    timerMinutesLeft,
    dataUsable: fresh.length >= 3 && quoted.length >= 2 && (dispersion == null || dispersion <= 30),
    rawMarketSample: { venues: venues.slice(0,8), recentSeries: series.slice(-90), summary: rm.summary || null }
  };
}
function normalizeSnapshot(input) {
  const raw = input?.snapshot || input || {};
  const features = calcFeatures(raw);
  const engineDecision = sideFromEngine(raw.engineRead || {});
  return {
    timestamp: raw.timestamp || raw.ts || new Date().toISOString(),
    version: raw.version || 'unknown',
    trigger: raw.reason || 'manual',
    timer: raw.timer || {},
    setup: raw.setup || {},
    live: raw.live || {},
    brti: raw.brti || {},
    probabilities: raw.probabilities || {},
    decision: raw.decision || {},
    risk: raw.risk || {},
    rawMarket: raw.rawMarket || {},
    engineRead: raw.engineRead || {},
    evidenceTail: Array.isArray(raw.evidenceTail) ? raw.evidenceTail.slice(-20) : [],
    independentFeatures: features,
    engineExtracted: { decision: engineDecision, confidenceHint: Math.max(parsePercent(raw.engineRead?.chanceUp)||0, parsePercent(raw.engineRead?.chanceDown)||0) || null }
  };
}
function normalizeAiForFrontend(obj, snapshot = {}) {
  const independent = obj?.independent_ai && typeof obj.independent_ai === 'object' ? obj.independent_ai : {};
  const engine = obj?.engine_read && typeof obj.engine_read === 'object' ? obj.engine_read : {};
  const consensus = obj?.consensus && typeof obj.consensus === 'object' ? obj.consensus : {};
  const independentDecision = String(independent.decision || obj?.independent_read || 'NO_READ').toUpperCase().slice(0,80);
  const independentConfidence = clamp(independent.confidence ?? obj?.independent_confidence,0,100,0);
  const engineDecision = String(engine.decision || snapshot?.engineExtracted?.decision || 'UNKNOWN').toUpperCase().slice(0,80);
  const consensusLabel = String(consensus.label || obj?.consensus_label || 'NO_CONSENSUS').toUpperCase().slice(0,120);
  const finalRead = String(obj?.trade_read || consensus.final_read || independentDecision || 'NO_READ').toUpperCase().slice(0,80);
  const reason = String(obj?.reason || consensus.reason || independent.reason || 'No explanation returned.').slice(0,1200);
  return {
    ok: Boolean(obj?.ok ?? true),
    health: String(obj?.health || 'OK').toUpperCase().slice(0,40),
    trade_read: finalRead,
    reason,
    main_blocker: String(obj?.main_blocker || independent.blocker || consensus.blocker || '—').slice(0,280),
    max_price: Number.isFinite(Number(obj?.max_price ?? independent.max_price)) ? Number(obj.max_price ?? independent.max_price) : null,
    anomaly_warning: obj?.anomaly_warning ?? null,
    confidence: clamp(obj?.confidence ?? consensus.confidence ?? independentConfidence,0,100,50),
    independent_ai: { decision: independentDecision, confidence: independentConfidence, reason: String(independent.reason||'').slice(0,700), blocker: String(independent.blocker||'').slice(0,240), max_price: Number.isFinite(Number(independent.max_price))?Number(independent.max_price):null, reasons: Array.isArray(independent.reasons)?independent.reasons.slice(0,5).map(x=>String(x).slice(0,180)):[] },
    engine_read: { decision: engineDecision, confidence: clamp(engine.confidence ?? snapshot?.engineExtracted?.confidenceHint,0,100,0), reason: String(engine.reason || snapshot?.decision?.why || '').slice(0,500) },
    consensus: { label: consensusLabel, final_read: String(consensus.final_read || finalRead).toUpperCase().slice(0,80), confidence: clamp(consensus.confidence ?? obj?.confidence,0,100,50), reason: String(consensus.reason || '').slice(0,700) }
  };
}

app.get('/', (_req,res)=>res.json({ok:true,service:'btc-ai-copilot-backend',version:'v69.1-independent-raw-first',endpoints:['/health','/analyze','/api/ai-review'],model:MODEL}));
app.get('/health', (_req,res)=>res.json({ok:true,status:'healthy',version:'v69.1-independent-raw-first',time:new Date().toISOString(),model:MODEL}));

async function handleAnalyze(req,res){
  let snapshot;
  try { snapshot = normalizeSnapshot(req.body); } catch (err) { return res.status(400).json({ ok:false, health:'BROKEN', trade_read:'NO_READ', reason:'Invalid dashboard snapshot: '+err.message, main_blocker:'invalid_snapshot', max_price:null, anomaly_warning:'frontend_payload_mismatch', confidence:0 }); }
  const system = `You are a raw-market-first AI analyst for BTC 15-minute prediction contracts. You are not a financial adviser and must not guarantee profit. You MUST follow this exact order: (1) Ignore the deterministic engine and analyze ONLY independentFeatures and rawMarket. (2) Choose your independent decision: ABOVE, BELOW, SIT_OUT, or FIX_DATA. (3) Give raw-market reasons: venue agreement/freshness, target distance, momentum, volatility/chop, timer, and contract price if available. (4) Only after that, compare your independent decision to engineExtracted/engineRead. (5) If AI and engine conflict, consensus usually stands down. Do not parrot the engine. Do not use dashboard blockers as your independent reason unless raw market data independently supports them. Return JSON only.`;
  const user = `RAW-MARKET-FIRST ANALYSIS INPUT:\n${JSON.stringify({ independentFeatures:snapshot.independentFeatures, rawMarket:snapshot.rawMarket, setup:snapshot.setup, timer:snapshot.timer }, null, 2)}\n\nENGINE COMPARISON INPUT, USE ONLY AFTER INDEPENDENT DECISION:\n${JSON.stringify({ engineExtracted:snapshot.engineExtracted, engineRead:snapshot.engineRead, dashboardDecision:snapshot.decision, dashboardRisk:snapshot.risk }, null, 2)}\n\nReturn exactly this JSON shape:\n{\n  "health":"OK|WATCH|DEGRADED|BROKEN",\n  "independent_ai":{"decision":"ABOVE|BELOW|SIT_OUT|FIX_DATA","confidence":0-100,"reason":"raw-market-only reason","blocker":"main raw-market blocker or none","max_price":number|null,"reasons":["up to five raw-market reasons"]},\n  "engine_read":{"decision":"ABOVE|BELOW|SIT_OUT|UNKNOWN","confidence":0-100,"reason":"brief summary of engine after comparison"},\n  "consensus":{"label":"AGREE_STRONG|AGREE_WEAK|AI_MORE_CONSERVATIVE|ENGINE_MORE_CONSERVATIVE|CONFLICT_STAND_DOWN|DATA_NOT_USABLE","final_read":"ACT_NOW|PREPARE|WAIT|SIT_OUT|FIX_DATA|NO_READ","confidence":0-100,"reason":"final comparison reason"},\n  "trade_read":"ACT_NOW|PREPARE|WAIT|SIT_OUT|FIX_DATA|NO_READ",\n  "reason":"one-sentence final instruction",\n  "main_blocker":"single biggest blocker",\n  "max_price":number|null,\n  "anomaly_warning":string|null,\n  "confidence":0-100\n}`;
  try {
    const completion = await openai.chat.completions.create({ model: MODEL, temperature:0.08, response_format:{type:'json_object'}, messages:[{role:'system',content:system},{role:'user',content:user}] });
    let ai; const out = completion.choices?.[0]?.message?.content || '{}';
    try { ai = JSON.parse(out); } catch { ai = {health:'BROKEN',trade_read:'NO_READ',reason:out,main_blocker:'ai_json_parse',max_price:null,anomaly_warning:'AI returned non-JSON',confidence:0}; }
    const front = normalizeAiForFrontend(ai, snapshot);
    res.json({ ...front, ai:front, snapshotSummary:{ independentFeatures:snapshot.independentFeatures, engineExtracted:snapshot.engineExtracted }, model:MODEL, time:new Date().toISOString(), backend_version:'v69.1-independent-raw-first' });
  } catch (err) {
    const msg = err?.message || String(err); console.error('[AI_ERROR]', msg);
    res.status(502).json({ ok:false, health:'BROKEN', trade_read:'NO_READ', reason:msg, main_blocker:'openai_request_failed', max_price:null, anomaly_warning:'backend_openai_error', confidence:0, error:'openai_request_failed' });
  }
}
app.post('/analyze', rateLimit, handleAnalyze);
app.post('/api/ai-review', rateLimit, handleAnalyze);
app.use((err,_req,res,_next)=>{ console.error('[SERVER_ERROR]', err?.message || err); res.status(500).json({ok:false,health:'BROKEN',trade_read:'NO_READ',reason:err?.message||'Server error',main_blocker:'server_error',max_price:null,anomaly_warning:'backend_server_error',confidence:0}); });
app.listen(PORT, () => console.log(`BTC AI backend v69.1 listening on port ${PORT}`));
