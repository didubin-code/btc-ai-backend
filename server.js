import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import OpenAI from 'openai';

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 8000);
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

function mean(a){ return a.length ? a.reduce((x,y)=>x+y,0)/a.length : null; }
function stdev(a){ if(a.length < 2) return null; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function erf(x){
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const t=1/(1+p*x); const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function Phi(x){ return 0.5*(1+erf(x/Math.SQRT2)); }
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function pct01(x){ return Math.round(clamp01(x)*1000)/10; }
function computeRawIndependentModel(features){
  const f = features || {};
  const sample = f.rawMarketSample || {};
  const series = Array.isArray(sample.recentSeries) ? sample.recentSeries
    .filter(x => Number.isFinite(Number(x.p)))
    .map(x => ({age:Number(x.t), p:Number(x.p)}))
    .sort((a,b)=>b.age-a.age) : []; // oldest -> newest because age desc
  const last = Number.isFinite(Number(f.lastPrice)) ? Number(f.lastPrice) : (series.length ? series[series.length-1].p : null);
  const target = Number.isFinite(Number(f.target)) ? Number(f.target) : null;
  const returns=[];
  for(let i=1;i<series.length;i++){
    if(series[i-1].p>0 && series[i].p>0) returns.push(Math.log(series[i].p/series[i-1].p));
  }
  const sigma1s = stdev(returns) || null;
  const secondsLeft = Number.isFinite(Number(f.timerMinutesLeft)) ? Math.max(1, Number(f.timerMinutesLeft)*60) : 300;
  const effectiveSeconds = Math.max(10, secondsLeft - 40); // settlement average reduces terminal variance somewhat
  const sigmaT = sigma1s ? Math.max(0.00005, sigma1s*Math.sqrt(effectiveSeconds)) : null;
  let pAbove = 0.5;
  if(last && target && sigmaT) pAbove = Phi(Math.log(last/target)/sigmaT);
  const pBelow = 1 - pAbove;
  const move60 = Number.isFinite(Number(f.move60Bps)) ? Number(f.move60Bps) : 0;
  const move180 = Number.isFinite(Number(f.move180Bps)) ? Number(f.move180Bps) : 0;
  const trend = Math.abs(move60) < 1.5 && Math.abs(move180) < 3 ? 'FLAT' : (move60 > 0 && move180 >= -2 ? 'UP' : (move60 < 0 && move180 <= 2 ? 'DOWN' : 'MIXED'));
  const volBps60 = sigma1s ? sigma1s*Math.sqrt(60)*10000 : null;
  const volatility = volBps60 == null ? 'UNKNOWN' : volBps60 > 18 ? 'HIGH' : volBps60 > 9 ? 'MEDIUM' : 'LOW';
  const dispersion = Number.isFinite(Number(f.venueDispersionDollars)) ? Number(f.venueDispersionDollars) : null;
  const spread = Number.isFinite(Number(f.avgSpreadBps)) ? Number(f.avgSpreadBps) : null;
  const dist = Number.isFinite(Number(f.distanceToTargetBps)) ? Number(f.distanceToTargetBps) : null;
  const dataUsable = !!f.dataUsable && (sigmaT != null) && last && target;
  let regime = 'RANGE';
  if(volatility === 'HIGH' && trend === 'MIXED') regime = 'CHOP';
  else if(trend === 'UP' || trend === 'DOWN') regime = volatility === 'HIGH' ? 'VOLATILE_TREND' : 'TREND';
  else if(volatility === 'LOW') regime = 'QUIET_RANGE';
  const upCost = Number.isFinite(Number(f.upCost)) ? Number(f.upCost) : null;
  const downCost = Number.isFinite(Number(f.downCost)) ? Number(f.downCost) : null;
  const edgeAbove = upCost == null ? pAbove - 0.5 : pAbove - upCost;
  const edgeBelow = downCost == null ? pBelow - 0.5 : pBelow - downCost;
  const evAbove = upCost == null ? null : pAbove - upCost;
  const evBelow = downCost == null ? null : pBelow - downCost;
  const safety = (dispersion || 0) > 30 || (spread || 0) > 8 ? 18 : (volatility === 'HIGH' ? 8 : 0);
  const baseConf = Math.max(pAbove, pBelow)*100;
  const confidence = Math.max(0, Math.min(100, baseConf - safety));
  const tooClose = dist != null && sigmaT != null && Math.abs(Math.log(last/target)) < Math.max(0.00012, sigmaT*0.20);
  const bestSide = pAbove >= pBelow ? 'ABOVE' : 'BELOW';
  const bestProb = Math.max(pAbove, pBelow);
  const bestEdge = bestSide === 'ABOVE' ? edgeAbove : edgeBelow;
  const bestCost = bestSide === 'ABOVE' ? upCost : downCost;
  const bestEv = bestSide === 'ABOVE' ? evAbove : evBelow;
  const sideTrendOK = (bestSide === 'ABOVE' && (trend === 'UP' || trend === 'FLAT')) || (bestSide === 'BELOW' && (trend === 'DOWN' || trend === 'FLAT')) || trend === 'MIXED';
  const severeDataRisk = (dispersion || 0) > 90 || (spread || 0) > 18 || ((f.freshVenueCount || 0) < 1 && !String(f.dataTier||'').includes('FALLBACK'));
  const lateFragile = secondsLeft < 90 && bestProb < 0.82;
  let decision = 'SIT_OUT';          // directional decision: ABOVE / BELOW / SIT_OUT / FIX_DATA
  let action_stage = 'SIT_OUT';      // practical instruction: ACT_NOW / PREPARE / WAIT / SIT_OUT / FIX_DATA
  let blocker = 'no positive EV edge';
  if(!dataUsable){ decision = 'FIX_DATA'; action_stage = 'FIX_DATA'; blocker = 'raw market data insufficient — no usable live consensus/series fallback'; }
  else if(severeDataRisk){ decision = 'SIT_OUT'; action_stage = 'SIT_OUT'; blocker = 'raw venue/spread risk too high'; }
  else if(lateFragile){ decision = 'SIT_OUT'; action_stage = 'SIT_OUT'; blocker = 'late entry without enough EV cushion'; }
  else if(bestProb >= 0.78 && bestEdge > 0.025 && confidence >= 60 && (!tooClose || bestEdge > 0.055)){
    decision = bestSide; action_stage = 'ACT_NOW'; blocker = 'none';
  }
  else if(bestProb >= 0.68 && bestEdge > 0.012 && confidence >= 55 && sideTrendOK){
    decision = bestSide; action_stage = 'PREPARE'; blocker = tooClose ? 'directional edge forming but target cushion is still thin' : 'edge forming; wait for cleaner confirmation';
  }
  else if(bestProb >= 0.60 && bestEdge > 0.005){
    decision = bestSide; action_stage = 'WAIT'; blocker = 'weak positive edge; not enough to enter yet';
  }
  else { blocker = confidence < 55 ? 'raw confidence below practical threshold' : 'contract price/edge not attractive'; }
  const fairMaxAbove = Math.max(0.01, Math.min(0.99, pAbove - 0.025));
  const fairMaxBelow = Math.max(0.01, Math.min(0.99, pBelow - 0.025));
  const hiddenRisks = [];
  if(tooClose) hiddenRisks.push('target is too close to live price for a clean read');
  if(volatility === 'HIGH') hiddenRisks.push('volatility expansion can flip a short-horizon signal');
  if(trend === 'MIXED') hiddenRisks.push('multi-window trend is mixed, increasing false-read risk');
  if(dispersion != null && dispersion > 20) hiddenRisks.push('venues are dispersed enough to weaken settlement proxy confidence');
  if(secondsLeft < 150) hiddenRisks.push('late-contract timing makes new entries more fragile');
  return {
    decision, confidence: Math.round(confidence), prob_above: pct01(pAbove), prob_below: pct01(pBelow),
    fair_max_above: Number(fairMaxAbove.toFixed(2)), fair_max_below: Number(fairMaxBelow.toFixed(2)),
    trend, regime, volatility, blocker,
    raw_stats: { lastPrice:last, target, distanceToTargetBps:dist, move60Bps:move60, move180Bps:move180, volBps60:volBps60 == null ? null : Number(volBps60.toFixed(2)), venueDispersionDollars:dispersion, avgSpreadBps:spread, freshVenueCount:f.freshVenueCount, quotedVenueCount:f.quotedVenueCount, softFreshVenueCount:f.softFreshVenueCount, softQuotedVenueCount:f.softQuotedVenueCount, dataTier:f.dataTier, secondsLeft:Math.round(secondsLeft) },
    hidden_risks: hiddenRisks.slice(0,5),
    practical_action: action_stage,
    best_side: bestSide,
    best_probability: pct01(bestProb),
    best_edge: Number(bestEdge.toFixed(4)),
    expected_value: bestEv == null ? null : Number(bestEv.toFixed(4)),
    reasons: [
      `raw probability Above ${pct01(pAbove)}% / Below ${pct01(pBelow)}%`,
      `trend ${trend}, regime ${regime}, volatility ${volatility}`,
      dist == null ? 'target distance unavailable' : `target distance ${Number(dist).toFixed(1)} bps`,
      `data tier ${f.dataTier || 'UNKNOWN'}; fresh venues ${f.freshVenueCount}, quoted venues ${f.quotedVenueCount}`,
      `best side ${bestSide}, EV edge ${bestEv == null ? 'unknown' : (bestEv*100).toFixed(1)+' pts'}, stage ${action_stage}`,
      `fair max Above $${fairMaxAbove.toFixed(2)} / Below $${fairMaxBelow.toFixed(2)}`
    ]
  };
}
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
  const series = Array.isArray(rm.recentSeries) ? rm.recentSeries
    .filter(x => Number.isFinite(Number(x.p)))
    .map(x => ({t:Number(x.t), p:Number(x.p)})) : [];
  // v73.1: use a tiered feed model. A single stale venue should not kill AI if the
  // dashboard has a fresh consensus/price path. Keep strict data preferred, but allow
  // soft/consensus/series fallback so FIX_DATA only appears when truly unusable.
  const strictFresh = venues.filter(v => Number(v.ageMs) < 4500 && Number.isFinite(Number(v.price)));
  const softFresh = venues.filter(v => Number(v.ageMs) < 12000 && Number.isFinite(Number(v.price)));
  const strictQuoted = strictFresh.filter(v => Number.isFinite(Number(v.mid)) || Number.isFinite(Number(v.price)));
  const softQuoted = softFresh.filter(v => Number.isFinite(Number(v.mid)) || Number.isFinite(Number(v.price)));
  const prices = (strictQuoted.length ? strictQuoted : softQuoted).map(v => Number(v.mid ?? v.price)).filter(Number.isFinite);
  const seriesLast = series.length ? series[series.length-1].p : null;
  const summaryLast = finite(rm.summary?.priceLast);
  const livePrice = finite(raw.live?.price);
  const last = seriesLast ?? livePrice ?? summaryLast;
  const first60 = series.filter(x => Number(x.t) <= 60)[0]?.p ?? series[0]?.p ?? null;
  const first180 = series[0]?.p ?? null;
  const move60Bps = finite(rm.summary?.move60Bps) ?? bps(first60, last);
  const move180Bps = finite(rm.summary?.move180Bps) ?? bps(first180, last);
  const dispersion = prices.length > 1 ? Math.max(...prices)-Math.min(...prices) : null;
  const spreadVals = (strictFresh.length ? strictFresh : softFresh).map(v => finite(v.spreadBps)).filter(x=>x!=null);
  const avgSpread = spreadVals.length ? spreadVals.reduce((a,b)=>a+b,0)/spreadVals.length : null;
  const target = finite(raw.setup?.target);
  const distBps = target && last ? ((last/target)-1)*10000 : null;
  const upCost = finite(raw.setup?.upCost), downCost = finite(raw.setup?.downCost);
  const timerMinutesLeft = finite(raw.timer?.minutesLeft);
  const brtiConfidence = finite(raw.brti?.confidence);
  const hasSeriesPath = series.length >= 6 && last && target;
  const hasConsensus = livePrice && target && (brtiConfidence == null || brtiConfidence >= 35);
  const strictOk = strictQuoted.length >= 2 && hasSeriesPath && (dispersion == null || dispersion <= 45);
  const softOk = softQuoted.length >= 2 && hasSeriesPath && (dispersion == null || dispersion <= 75);
  const consensusOk = hasConsensus && hasSeriesPath;
  const seriesOk = hasSeriesPath && series.length >= 10;
  const dataTier = strictOk ? 'LIVE_STRICT' : softOk ? 'LIVE_SOFT' : consensusOk ? 'CONSENSUS_FALLBACK' : seriesOk ? 'SERIES_FALLBACK' : 'FIX_DATA';
  return {
    freshVenueCount: strictFresh.length,
    softFreshVenueCount: softFresh.length,
    quotedVenueCount: strictQuoted.length,
    softQuotedVenueCount: softQuoted.length,
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
    dataTier,
    dataUsable: dataTier !== 'FIX_DATA',
    rawMarketSample: { venues: venues.slice(0,8), recentSeries: series.slice(-120), summary: rm.summary || null }
  };
}
function normalizeSnapshot(input) {
  const raw = input?.snapshot || input || {};
  const features = calcFeatures(raw);
  const rawIndependentModel = computeRawIndependentModel(features);
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
    rawIndependentModel,
    engineExtracted: { decision: engineDecision, confidenceHint: Math.max(parsePercent(raw.engineRead?.chanceUp)||0, parsePercent(raw.engineRead?.chanceDown)||0) || null }
  };
}

function isDirectional(x){ return x === 'ABOVE' || x === 'BELOW'; }
function normalizeAction(x){
  const s = String(x || '').toUpperCase();
  if (/ACT|BUY|ENTER|TRADE_NOW/.test(s)) return 'ACT_NOW';
  if (/PREP/.test(s)) return 'PREPARE';
  if (/CHASE|LATE/.test(s)) return 'DO_NOT_CHASE';
  if (/WAIT|WATCH/.test(s)) return 'WAIT';
  if (/FIX|DATA/.test(s)) return 'FIX_DATA';
  if (/SIT|NO|BLOCK/.test(s)) return 'SIT_OUT';
  return null;
}
function independentPolicy(ai, snapshot){
  // Enforce the architecture the UI expects: independent AI decides first; engine comparison is advisory
  // unless the data is unusable or the two systems point in opposite directions.
  const out = ai && typeof ai === 'object' ? {...ai} : {};
  const raw = snapshot?.rawIndependentModel || {};
  const ind = out.independent_ai && typeof out.independent_ai === 'object' ? {...out.independent_ai} : {};
  const engine = out.engine_read && typeof out.engine_read === 'object' ? {...out.engine_read} : {};
  const consensus = out.consensus && typeof out.consensus === 'object' ? {...out.consensus} : {};

  const indDir = String(ind.decision || raw.decision || 'SIT_OUT').toUpperCase();
  const engineDir = String(engine.decision || snapshot?.engineExtracted?.decision || 'UNKNOWN').toUpperCase();
  const rawAction = normalizeAction(ind.trade_action || ind.action_stage || raw.practical_action || out.trade_read) || (isDirectional(indDir) ? 'WAIT' : indDir);
  const dataBad = indDir === 'FIX_DATA' || raw.decision === 'FIX_DATA' || raw.blocker === 'raw market data insufficient';
  const opposite = isDirectional(indDir) && isDirectional(engineDir) && indDir !== engineDir;
  const engineConservative = isDirectional(indDir) && engineDir === 'SIT_OUT';
  const aiConservative = indDir === 'SIT_OUT' && isDirectional(engineDir);

  let finalRead = rawAction;
  let label = consensus.label || 'NO_CONSENSUS';
  let reason = out.reason || ind.reason || raw.reasons?.[0] || 'Independent raw-market read complete.';
  let blocker = out.main_blocker || ind.blocker || raw.blocker || 'none';

  if(dataBad){
    finalRead = 'FIX_DATA'; label = 'DATA_NOT_USABLE'; reason = 'Raw market data is insufficient or unusable.'; blocker = 'raw market data insufficient';
  } else if(opposite){
    finalRead = 'SIT_OUT'; label = 'OPPOSITE_DIRECTION_STAND_DOWN'; reason = `Independent AI says ${indDir}, engine says ${engineDir}; opposite-direction conflict, stand down.`; blocker = 'opposite direction conflict';
  } else if(engineConservative){
    // Do NOT veto the AI just because the engine is conservative. Show the independent action.
    label = rawAction === 'ACT_NOW' ? 'AI_ACT_ENGINE_CONSERVATIVE' : 'ENGINE_MORE_CONSERVATIVE';
    reason = `${rawAction}: independent raw-market read favors ${indDir}; engine is more conservative. Use smaller size or require manual confirmation, but this is not an automatic AI sit-out.`;
    blocker = rawAction === 'ACT_NOW' ? 'engine conservative warning' : blocker;
  } else if(aiConservative){
    finalRead = 'SIT_OUT'; label = 'AI_MORE_CONSERVATIVE'; reason = 'AI raw-market read is more conservative than the engine; stand down.';
  } else if(isDirectional(indDir) && indDir === engineDir){
    label = rawAction === 'ACT_NOW' ? 'AGREE_STRONG' : 'AGREE_WEAK';
    reason = `${rawAction}: AI and engine agree on ${indDir}; ${reason}`;
  } else if(isDirectional(indDir)){
    label = 'AI_INDEPENDENT_READ';
  }

  const fair = indDir === 'ABOVE' ? (ind.fair_max_above ?? raw.fair_max_above) : indDir === 'BELOW' ? (ind.fair_max_below ?? raw.fair_max_below) : null;
  out.independent_ai = {
    ...ind,
    decision: indDir,
    trade_action: finalRead === 'FIX_DATA' ? 'FIX_DATA' : rawAction,
    confidence: clamp(ind.confidence ?? raw.confidence,0,100,0),
    prob_above: ind.prob_above ?? raw.prob_above,
    prob_below: ind.prob_below ?? raw.prob_below,
    fair_max_above: ind.fair_max_above ?? raw.fair_max_above,
    fair_max_below: ind.fair_max_below ?? raw.fair_max_below,
    max_price: ind.max_price ?? fair,
    blocker: ind.blocker ?? raw.blocker,
    reasons: Array.isArray(ind.reasons) && ind.reasons.length ? ind.reasons : (Array.isArray(raw.reasons) ? raw.reasons : []),
    hidden_risks: Array.isArray(ind.hidden_risks) && ind.hidden_risks.length ? ind.hidden_risks : (Array.isArray(raw.hidden_risks) ? raw.hidden_risks : [])
  };
  out.engine_read = { ...engine, decision: engineDir, confidence: clamp(engine.confidence ?? snapshot?.engineExtracted?.confidenceHint,0,100,0) };
  out.consensus = { ...consensus, label, final_read: finalRead, confidence: clamp(consensus.confidence ?? out.independent_ai.confidence,0,100,50), reason };
  out.trade_read = finalRead;
  out.reason = reason;
  out.main_blocker = blocker;
  out.max_price = Number.isFinite(Number(out.max_price ?? out.independent_ai.max_price)) ? Number(out.max_price ?? out.independent_ai.max_price) : null;
  out.confidence = clamp(out.confidence ?? out.independent_ai.confidence,0,100,50);
  return out;
}

function normalizeAiForFrontend(obj, snapshot = {}) {
  const independent = obj?.independent_ai && typeof obj.independent_ai === 'object' ? obj.independent_ai : {};
  const engine = obj?.engine_read && typeof obj.engine_read === 'object' ? obj.engine_read : {};
  const consensus = obj?.consensus && typeof obj.consensus === 'object' ? obj.consensus : {};
  const rawModel = snapshot?.rawIndependentModel || {};
  const independentDecision = String(independent.decision || obj?.independent_read || rawModel.decision || 'NO_READ').toUpperCase().slice(0,80);
  const independentConfidence = clamp(independent.confidence ?? obj?.independent_confidence ?? rawModel.confidence,0,100,0);
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
    max_price: Number.isFinite(Number(obj?.max_price ?? independent.max_price ?? (independentDecision==='ABOVE'?rawModel.fair_max_above:independentDecision==='BELOW'?rawModel.fair_max_below:null))) ? Number(obj.max_price ?? independent.max_price ?? (independentDecision==='ABOVE'?rawModel.fair_max_above:independentDecision==='BELOW'?rawModel.fair_max_below:null)) : null,
    anomaly_warning: obj?.anomaly_warning ?? (Array.isArray(independent.hidden_risks)&&independent.hidden_risks.length?independent.hidden_risks.join('; '):(Array.isArray(rawModel.hidden_risks)&&rawModel.hidden_risks.length?rawModel.hidden_risks.join('; '):null)),
    confidence: clamp(obj?.confidence ?? consensus.confidence ?? independentConfidence,0,100,50),
    independent_ai: { decision: independentDecision, confidence: independentConfidence, prob_above: Number.isFinite(Number(independent.prob_above ?? rawModel.prob_above))?Number(independent.prob_above ?? rawModel.prob_above):null, prob_below: Number.isFinite(Number(independent.prob_below ?? rawModel.prob_below))?Number(independent.prob_below ?? rawModel.prob_below):null, trend: String(independent.trend || rawModel.trend || 'UNKNOWN').slice(0,80), regime: String(independent.regime || rawModel.regime || 'UNKNOWN').slice(0,80), volatility: String(independent.volatility || rawModel.volatility || 'UNKNOWN').slice(0,80), fair_max_above: Number.isFinite(Number(independent.fair_max_above ?? rawModel.fair_max_above))?Number(independent.fair_max_above ?? rawModel.fair_max_above):null, fair_max_below: Number.isFinite(Number(independent.fair_max_below ?? rawModel.fair_max_below))?Number(independent.fair_max_below ?? rawModel.fair_max_below):null, reason: String(independent.reason||rawModel.reasons?.[0]||'').slice(0,700), blocker: String(independent.blocker||rawModel.blocker||'').slice(0,240), max_price: Number.isFinite(Number(independent.max_price))?Number(independent.max_price):null, reasons: Array.isArray(independent.reasons)?independent.reasons.slice(0,5).map(x=>String(x).slice(0,180)):(Array.isArray(rawModel.reasons)?rawModel.reasons.slice(0,5):[]), hidden_risks: Array.isArray(independent.hidden_risks)?independent.hidden_risks.slice(0,5).map(x=>String(x).slice(0,180)):(Array.isArray(rawModel.hidden_risks)?rawModel.hidden_risks.slice(0,5):[]) },
    engine_read: { decision: engineDecision, confidence: clamp(engine.confidence ?? snapshot?.engineExtracted?.confidenceHint,0,100,0), reason: String(engine.reason || snapshot?.decision?.why || '').slice(0,500) },
    consensus: { label: consensusLabel, final_read: String(consensus.final_read || finalRead).toUpperCase().slice(0,80), confidence: clamp(consensus.confidence ?? obj?.confidence,0,100,50), reason: String(consensus.reason || '').slice(0,700) }
  };
}

app.get('/', (_req,res)=>res.json({ok:true,service:'btc-ai-copilot-backend',version:'v73.2-ai-watchdog',endpoints:['/health','/analyze','/api/ai-review'],model:MODEL}));
app.get('/health', (_req,res)=>res.json({ok:true,status:'healthy',version:'v73.2-ai-watchdog',time:new Date().toISOString(),model:MODEL}));

async function handleAnalyze(req,res){
  let snapshot;
  try { snapshot = normalizeSnapshot(req.body); } catch (err) { return res.status(400).json({ ok:false, health:'BROKEN', trade_read:'NO_READ', reason:'Invalid dashboard snapshot: '+err.message, main_blocker:'invalid_snapshot', max_price:null, anomaly_warning:'frontend_payload_mismatch', confidence:0 }); }
  const system = `You are a professional raw-market-first AI analyst for BTC 15-minute prediction contracts. You are not a financial adviser and must not guarantee profit. Optimize for practical expected-value entries, not waiting for 99% certainty at the end. IMPORTANT: You are an independent execution analyst, not a narrator of the dashboard engine. CRITICAL ORDER: (1) Make your own independent direction AND trade action from rawIndependentModel, independentFeatures, rawMarket, setup costs, timer, volatility, target distance, and recent path only. Do not use the deterministic engine in this step. (2) Separate DIRECTION from TRADE ACTION: direction can be ABOVE/BELOW while trade action can be ACT_NOW/PREPARE/WAIT/SIT_OUT/DO_NOT_CHASE. (3) Use EV: a lower probability with a cheap contract can be a better trade than 99% at a 94c price. (4) ACT_NOW may be appropriate before 90-99% when probability, cost, EV edge, timing, and data are good. PREPARE means edge is forming but not clean enough to click. DO_NOT_CHASE means direction is likely but contract is overpriced or too late. (5) Only after your independent action is complete, compare with engineExtracted/engineRead. Engine disagreement is an alert, not an automatic veto. Only stand down automatically for unusable data or true opposite-direction conflict. If dataTier is LIVE_SOFT, CONSENSUS_FALLBACK, or SERIES_FALLBACK, you may still analyze, but mention reduced data tier as a caution rather than returning FIX_DATA. (6) Return JSON only. No prose outside JSON.`;
  const user = `RAW-MARKET-FIRST ANALYSIS INPUT. Use rawIndependentModel as the non-engine raw quantitative baseline, then use rawMarket to check/override it if warranted:\n${JSON.stringify({ rawIndependentModel:snapshot.rawIndependentModel, independentFeatures:snapshot.independentFeatures, rawMarket:snapshot.rawMarket, setup:snapshot.setup, timer:snapshot.timer }, null, 2)}\n\nENGINE COMPARISON INPUT, USE ONLY AFTER INDEPENDENT DECISION:\n${JSON.stringify({ engineExtracted:snapshot.engineExtracted, engineRead:snapshot.engineRead, dashboardDecision:snapshot.decision, dashboardRisk:snapshot.risk }, null, 2)}\n\nReturn exactly this JSON shape:\n{\n  "health":"OK|WATCH|DEGRADED|BROKEN",\n  "independent_ai":{"decision":"ABOVE|BELOW|SIT_OUT|FIX_DATA","trade_action":"ACT_NOW|PREPARE|WAIT|SIT_OUT|DO_NOT_CHASE|FIX_DATA","confidence":0-100,"prob_above":0-100,"prob_below":0-100,"trend":"UP|DOWN|FLAT|MIXED","regime":"TREND|VOLATILE_TREND|RANGE|QUIET_RANGE|CHOP|UNKNOWN","volatility":"LOW|MEDIUM|HIGH|UNKNOWN","fair_max_above":number|null,"fair_max_below":number|null,"reason":"raw-market-only reason","blocker":"main raw-market blocker or none","max_price":number|null,"reasons":["up to five raw-market reasons"],"hidden_risks":["up to five risks the engine may miss"]},\n  "engine_read":{"decision":"ABOVE|BELOW|SIT_OUT|UNKNOWN","confidence":0-100,"reason":"brief summary of engine after comparison"},\n  "consensus":{"label":"AGREE_STRONG|AGREE_WEAK|AI_MORE_CONSERVATIVE|ENGINE_MORE_CONSERVATIVE|OPPOSITE_DIRECTION_STAND_DOWN|DATA_NOT_USABLE","final_read":"ACT_NOW|PREPARE|WAIT|SIT_OUT|DO_NOT_CHASE|FIX_DATA|NO_READ","confidence":0-100,"reason":"final comparison reason"},\n  "trade_read":"ACT_NOW|PREPARE|WAIT|SIT_OUT|DO_NOT_CHASE|FIX_DATA|NO_READ",\n  "reason":"one-sentence final instruction",\n  "main_blocker":"single biggest blocker",\n  "max_price":number|null,\n  "anomaly_warning":string|null,\n  "confidence":0-100\n}`;
  try {
    const completion = await openai.chat.completions.create({ model: MODEL, temperature:0.08, response_format:{type:'json_object'}, messages:[{role:'system',content:system},{role:'user',content:user}] }, { timeout: OPENAI_TIMEOUT_MS });
    let ai; const out = completion.choices?.[0]?.message?.content || '{}';
    try { ai = JSON.parse(out); } catch { ai = {health:'BROKEN',trade_read:'NO_READ',reason:out,main_blocker:'ai_json_parse',max_price:null,anomaly_warning:'AI returned non-JSON',confidence:0}; }
    ai = independentPolicy(ai, snapshot);
    const front = normalizeAiForFrontend(ai, snapshot);
    res.json({ ...front, ai:front, snapshotSummary:{ independentFeatures:snapshot.independentFeatures, rawIndependentModel:snapshot.rawIndependentModel, engineExtracted:snapshot.engineExtracted }, model:MODEL, time:new Date().toISOString(), backend_version:'v73.2-ai-watchdog' });
  } catch (err) {
    const msg = err?.message || String(err); console.error('[AI_ERROR]', msg);
    res.status(502).json({ ok:false, health:'BROKEN', trade_read:'NO_READ', reason:msg, main_blocker:'openai_request_failed', max_price:null, anomaly_warning:'backend_openai_error', confidence:0, error:'openai_request_failed' });
  }
}
app.post('/analyze', rateLimit, handleAnalyze);
app.post('/api/ai-review', rateLimit, handleAnalyze);
app.use((err,_req,res,_next)=>{ console.error('[SERVER_ERROR]', err?.message || err); res.status(500).json({ok:false,health:'BROKEN',trade_read:'NO_READ',reason:err?.message||'Server error',main_blocker:'server_error',max_price:null,anomaly_warning:'backend_server_error',confidence:0}); });
app.listen(PORT, () => console.log(`BTC AI backend v73.2 listening on port ${PORT}`));
