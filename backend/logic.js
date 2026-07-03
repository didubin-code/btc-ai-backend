'use strict';

const VERSION = 'v73.3-streamguard';

function nowMs(){ return Date.now(); }
function finite(x){ const n = Number(x); return Number.isFinite(n) ? n : null; }
function clamp(x,a,b){ return Math.max(a, Math.min(b, x)); }
function median(arr){
  const xs = arr.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!xs.length) return null;
  const mid = Math.floor(xs.length/2);
  return xs.length % 2 ? xs[mid] : (xs[mid-1]+xs[mid])/2;
}
function mean(arr){ const xs=arr.map(Number).filter(Number.isFinite); return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : null; }
function std(arr){
  const xs=arr.map(Number).filter(Number.isFinite);
  if(xs.length < 2) return null;
  const m = mean(xs);
  const v = xs.reduce((s,x)=>s+(x-m)*(x-m),0)/(xs.length-1);
  return Math.sqrt(v);
}
function erf(x){
  // Abramowitz and Stegun approximation
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const t = 1/(1+p*x);
  const y = 1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normalCdf(z){ return 0.5*(1+erf(z/Math.SQRT2)); }
function safeText(v, max=400){
  return String(v == null ? '' : v).replace(/[\u0000-\u001F\u007F]/g,' ').slice(0,max).trim();
}
function pctTextToNum(s){
  if(typeof s === 'number') return Number.isFinite(s) ? s : null;
  const m = String(s || '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function digestSnapshot(payload){
  const live = payload && payload.live || {};
  const raw = payload && payload.rawMarket || {};
  const series = Array.isArray(raw.recentSeries) ? raw.recentSeries : [];
  const tail = series.slice(-4).map(p=>[Math.round(finite(p.t)||0), Math.round((finite(p.p)||0)*100)]);
  const venues = Array.isArray(raw.venues) ? raw.venues : [];
  const vtail = venues.map(v=>[safeText(v.name,20), Math.round((finite(v.mid)||0)*100), Math.round(finite(v.ageMs)||999999)]).sort();
  return JSON.stringify({price:Math.round((finite(live.price)||0)*100), target:Math.round((finite(payload?.setup?.target)||0)*100), tail, vtail});
}
function extractSeries(payload){
  const raw = payload && payload.rawMarket || {};
  let series = Array.isArray(raw.recentSeries) ? raw.recentSeries : [];
  series = series.map(p => ({ t: finite(p.t) || finite(p.ts) || 0, p: finite(p.p) || finite(p.price) })).filter(p => Number.isFinite(p.p));
  if(!series.length && finite(payload?.live?.price)) series = [{ t: nowMs(), p: finite(payload.live.price) }];
  series.sort((a,b)=>a.t-b.t);
  return series;
}
function venueStats(payload, now=nowMs()){
  const raw = payload && payload.rawMarket || {};
  const venues = Array.isArray(raw.venues) ? raw.venues : [];
  const parsed = venues.map(v => {
    const mid = finite(v.mid ?? v.price ?? v.last);
    const ageMs = finite(v.ageMs);
    const t = finite(v.t ?? v.ts);
    const derivedAge = ageMs != null ? ageMs : (t ? Math.max(0, now - t) : null);
    return { name: safeText(v.name || v.exchange || 'venue', 32), mid, ageMs: derivedAge == null ? 999999 : derivedAge };
  }).filter(v => Number.isFinite(v.mid));
  const fresh = parsed.filter(v => v.ageMs <= 6000);
  return {
    venues: parsed,
    quotedVenueCount: parsed.length,
    freshVenueCount: fresh.length,
    medianMid: median(fresh.map(v=>v.mid)) ?? median(parsed.map(v=>v.mid)),
    maxSpreadBps: fresh.length >= 2 ? ((Math.max(...fresh.map(v=>v.mid)) - Math.min(...fresh.map(v=>v.mid))) / median(fresh.map(v=>v.mid))) * 10000 : null
  };
}
function validateSnapshot(payload, streamState, now=nowMs()){
  const errors = [];
  const warnings = [];
  if(!payload || typeof payload !== 'object') errors.push('payload missing');
  const ts = Date.parse(payload?.ts || payload?.client_ts || '');
  const snapshotAgeMs = Number.isFinite(ts) ? Math.max(0, now - ts) : null;
  if(snapshotAgeMs == null) warnings.push('snapshot timestamp missing');
  else if(snapshotAgeMs > 15000) errors.push(`snapshot stale ${Math.round(snapshotAgeMs/1000)}s`);

  const target = finite(payload?.setup?.target);
  const price = finite(payload?.live?.price) ?? venueStats(payload, now).medianMid;
  const minutesLeft = finite(payload?.timer?.minutesLeft);
  if(!Number.isFinite(target) || target <= 0) errors.push('target price missing');
  if(!Number.isFinite(price) || price <= 0) errors.push('live price missing');
  if(!Number.isFinite(minutesLeft) || minutesLeft <= 0) warnings.push('timer not running or minutes left missing');

  const vs = venueStats(payload, now);
  if(vs.freshVenueCount < 2) errors.push(`not enough fresh venues (${vs.freshVenueCount})`);
  if(vs.maxSpreadBps != null && vs.maxSpreadBps > 20) warnings.push(`venue spread wide ${vs.maxSpreadBps.toFixed(1)} bps`);

  const series = extractSeries(payload);
  if(series.length < 4) warnings.push('short price series');
  const digest = digestSnapshot(payload);
  if(streamState){
    if(streamState.lastDigest === digest) streamState.repeatCount = (streamState.repeatCount || 0) + 1;
    else streamState.repeatCount = 0;
    streamState.lastDigest = digest;
    streamState.lastSeenAt = now;
    if(streamState.repeatCount >= 2) errors.push('snapshot repeated; market stream not changing');
  }

  return { ok: errors.length === 0, errors, warnings, snapshotAgeMs, target, price, minutesLeft, venue: vs, series, digest };
}
function estimateVolBps(series){
  if(!series || series.length < 3) return 8;
  const returns = [];
  for(let i=1;i<series.length;i++){
    const a=series[i-1].p, b=series[i].p;
    if(Number.isFinite(a)&&Number.isFinite(b)&&a>0) returns.push(Math.log(b/a)*10000);
  }
  const s = std(returns);
  if(!Number.isFinite(s)) return 8;
  // Return std per tick; convert to 1-minute-ish sigma by scaling conservatively.
  return clamp(s * Math.sqrt(Math.max(1, Math.min(12, returns.length))/Math.max(1, returns.length/6)), 3, 80);
}
function seriesMoveBps(series, windowMs){
  if(!series || series.length < 2) return 0;
  const last = series[series.length-1];
  const cutoff = last.t - windowMs;
  let first = series[0];
  for(const p of series){ if(p.t >= cutoff){ first = p; break; } }
  return first.p > 0 ? (last.p / first.p - 1) * 10000 : 0;
}
function localIndependentRead(payload, validation){
  const v = validation || validateSnapshot(payload, null);
  const target = v.target;
  const price = v.price;
  const minutesLeft = finite(v.minutesLeft) || 1;
  const upCost = finite(payload?.setup?.upCost);
  const downCost = finite(payload?.setup?.downCost);
  const series = v.series || extractSeries(payload);
  const targetBps = target > 0 && price > 0 ? ((price-target)/price)*10000 : 0;
  const volBps1m = estimateVolBps(series);
  const move60 = seriesMoveBps(series, 60000);
  const move180 = seriesMoveBps(series, 180000);
  const driftBps = clamp(move60 * 0.45 + move180 * 0.15, -25, 25);
  const timeScale = Math.sqrt(clamp(minutesLeft, 0.5, 15));
  const sigmaToExpiryBps = clamp(volBps1m * timeScale, 4, 260);
  // Positive z means above target. Add small drift adjustment.
  const z = (targetBps + driftBps) / sigmaToExpiryBps;
  let probAbove = clamp(normalCdf(z) * 100, 1, 99);
  // Very close strike: avoid fake certainty; force uncertainty band.
  if(Math.abs(targetBps) < volBps1m * 0.25){ probAbove = clamp(probAbove, 38, 62); }
  const probBelow = 100 - probAbove;
  const fairAbove = clamp(probAbove / 100 - 0.02, 0.01, 0.99);
  const fairBelow = clamp(probBelow / 100 - 0.02, 0.01, 0.99);
  const evAbove = upCost != null ? probAbove/100 - upCost : null;
  const evBelow = downCost != null ? probBelow/100 - downCost : null;
  const bestSide = (evAbove != null || evBelow != null)
    ? ((evAbove ?? -999) >= (evBelow ?? -999) ? 'ABOVE' : 'BELOW')
    : (probAbove >= probBelow ? 'ABOVE' : 'BELOW');
  const bestProb = bestSide === 'ABOVE' ? probAbove : probBelow;
  const bestEV = bestSide === 'ABOVE' ? evAbove : evBelow;
  const dataTier = !v.ok ? 'F' : (v.venue.freshVenueCount >= 4 && (v.venue.maxSpreadBps == null || v.venue.maxSpreadBps <= 8) && series.length >= 12 ? 'A' : (v.venue.freshVenueCount >= 3 ? 'B' : 'C'));
  let tradeRead = 'WAIT';
  let blocker = 'waiting for stronger EV / timing';
  if(!v.ok){ tradeRead = 'FIX_DATA'; blocker = v.errors.join('; '); }
  else if(bestProb < 53){ tradeRead = 'SIT_OUT'; blocker = 'no meaningful directional edge'; }
  else if(bestEV != null && bestEV < -0.015){ tradeRead = 'SIT_OUT'; blocker = 'contract price above fair value'; }
  else if(bestEV != null && bestEV >= 0.06 && bestProb >= 62 && dataTier !== 'C'){ tradeRead = 'ACT_NOW'; blocker = 'positive EV with usable data'; }
  else if((bestEV != null && bestEV >= 0.025) || bestProb >= 58){ tradeRead = 'PREPARE'; blocker = 'possible edge; wait for cleaner confirmation or price'; }
  else { tradeRead = 'WAIT'; blocker = 'edge not strong enough yet'; }
  if(minutesLeft < 1.2 && tradeRead === 'ACT_NOW'){ tradeRead = 'DO_NOT_CHASE'; blocker = 'too late; reversal/settlement risk'; }
  const regime = volBps1m > 30 ? 'HIGH_VOL' : volBps1m < 7 ? 'COMPRESSED' : 'NORMAL_VOL';
  const trend = Math.abs(move60) < 4 ? 'FLAT' : (move60 > 0 ? 'UP' : 'DOWN');
  const confidence = clamp(Math.round(Math.max(bestProb, 100-bestProb) * (dataTier === 'A' ? 1 : dataTier === 'B' ? 0.95 : 0.88)), 1, 99);
  const reason = `${tradeRead}: ${bestSide} ${Math.round(bestProb)}%, EV ${bestEV == null ? 'n/a' : (bestEV*100).toFixed(1)+' pts'}, ${regime}/${trend}, ${v.venue.freshVenueCount} fresh venues.`;
  return {
    software_health: v.ok ? 'OK' : 'FIX_DATA',
    trade_read: tradeRead,
    reason,
    main_blocker: blocker,
    confidence,
    max_price: bestSide === 'ABOVE' ? fairAbove : fairBelow,
    anomaly_warning: v.warnings.length ? v.warnings.join('; ') : '—',
    independent_ai: {
      decision: bestSide,
      confidence,
      prob_above: probAbove,
      prob_below: probBelow,
      fair_max_above: fairAbove,
      fair_max_below: fairBelow,
      ev_above: evAbove,
      ev_below: evBelow,
      data_tier: dataTier,
      regime,
      trend,
      target_bps: targetBps,
      vol_bps_1m: volBps1m,
      move_60_bps: move60,
      move_180_bps: move180,
      reason
    },
    engine_read: {
      decision: safeText(payload?.engineRead?.trade || payload?.decision?.signal || '—', 80),
      best_time: safeText(payload?.engineRead?.bestTime || payload?.probabilities?.bestTime || '—', 120),
      logic: safeText(payload?.engineRead?.logic || payload?.decision?.why || '—', 240)
    },
    consensus: { label: 'LOCAL_INDEPENDENT_READ' },
    debug: { data_tier: dataTier, target_bps: targetBps, sigmaToExpiryBps, volBps1m, move60, move180, freshVenueCount: v.venue.freshVenueCount, maxSpreadBps: v.venue.maxSpreadBps }
  };
}
function normalizeAiJson(aiJson, local, validation){
  if(!aiJson || typeof aiJson !== 'object') return local;
  const independent = aiJson.independent_ai || aiJson.independent || {};
  const trade = safeText(aiJson.trade_read || aiJson.action || local.trade_read, 40).toUpperCase();
  const allowed = new Set(['ACT_NOW','PREPARE','WAIT','SIT_OUT','DO_NOT_CHASE','FIX_DATA']);
  let trade_read = allowed.has(trade) ? trade : local.trade_read;
  if(!validation.ok) trade_read = 'FIX_DATA';
  // Do not let model override a clear negative local EV into ACT_NOW.
  const side = safeText(independent.decision || aiJson.direction || local.independent_ai.decision, 20).toUpperCase();
  const ev = side === 'BELOW' ? local.independent_ai.ev_below : local.independent_ai.ev_above;
  if(trade_read === 'ACT_NOW' && ev != null && ev < 0.015) trade_read = local.trade_read === 'ACT_NOW' ? 'PREPARE' : local.trade_read;
  return {
    ...local,
    software_health: validation.ok ? safeText(aiJson.software_health || aiJson.health || 'OK', 40).toUpperCase() : 'FIX_DATA',
    trade_read,
    reason: safeText(aiJson.reason || local.reason, 1000),
    main_blocker: safeText(aiJson.main_blocker || aiJson.blocker || local.main_blocker, 360),
    confidence: clamp(Math.round(finite(aiJson.confidence) ?? local.confidence), 1, 99),
    max_price: finite(aiJson.max_price) ?? local.max_price,
    anomaly_warning: safeText(aiJson.anomaly_warning || aiJson.warning || local.anomaly_warning, 360),
    independent_ai: {
      ...local.independent_ai,
      decision: /ABOVE|BELOW|SIT_OUT/.test(side) ? side : local.independent_ai.decision,
      confidence: clamp(Math.round(finite(independent.confidence) ?? finite(aiJson.confidence) ?? local.independent_ai.confidence), 1, 99),
      prob_above: clamp(finite(independent.prob_above) ?? finite(aiJson.prob_above) ?? local.independent_ai.prob_above, 1, 99),
      prob_below: clamp(finite(independent.prob_below) ?? finite(aiJson.prob_below) ?? local.independent_ai.prob_below, 1, 99),
      regime: safeText(independent.regime || local.independent_ai.regime, 80),
      trend: safeText(independent.trend || local.independent_ai.trend, 80),
      reason: safeText(independent.reason || aiJson.reason || local.independent_ai.reason, 1000)
    },
    consensus: { label: safeText(aiJson.consensus || aiJson.engine_comparison || local.consensus.label, 120) || local.consensus.label }
  };
}
function publicResponse(read, validation, startedAt=nowMs()){
  const latency = nowMs() - startedAt;
  return {
    ok: validation.ok,
    service: 'btc-ai-copilot-backend',
    version: VERSION,
    server_ts: new Date().toISOString(),
    backend_latency_ms: latency,
    snapshot_age_ms: validation.snapshotAgeMs,
    health: read.software_health,
    software_health: read.software_health,
    trade_read: read.trade_read,
    reason: read.reason,
    main_blocker: read.main_blocker,
    max_price: read.max_price,
    anomaly_warning: read.anomaly_warning,
    confidence: read.confidence,
    independent_ai: read.independent_ai,
    engine_read: read.engine_read,
    consensus: read.consensus,
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings, freshVenueCount: validation.venue.freshVenueCount, quotedVenueCount: validation.venue.quotedVenueCount, maxSpreadBps: validation.venue.maxSpreadBps },
    debug: read.debug,
    ai: {
      health: read.software_health,
      trade_read: read.trade_read,
      reason: read.reason,
      main_blocker: read.main_blocker,
      max_price: read.max_price,
      anomaly_warning: read.anomaly_warning,
      confidence: read.confidence,
      independent_ai: read.independent_ai,
      engine_read: read.engine_read,
      consensus: read.consensus
    }
  };
}

module.exports = {
  VERSION, finite, clamp, median, std, normalCdf, digestSnapshot, extractSeries, venueStats,
  validateSnapshot, localIndependentRead, normalizeAiJson, publicResponse, pctTextToNum
};
