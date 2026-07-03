'use strict';

const http = require('http');
const { URL } = require('url');
const {
  VERSION,
  validateSnapshot,
  localIndependentRead,
  normalizeAiJson,
  publicResponse
} = require('./logic');

const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 750000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 4500);
const VENUE_TIMEOUT_MS = Number(process.env.VENUE_TIMEOUT_MS || 3500);
const CF_BRTI_URL = process.env.CF_BRTI_URL || 'https://www.cfbenchmarks.com/data/indices/BRTI';
const CF_TIMEOUT_MS = Number(process.env.CF_TIMEOUT_MS || 3500);
const CF_MAX_AGE_MS = Number(process.env.CF_MAX_AGE_MS || 9000);

const streamStates = new Map();
function clientKey(payload, req){
  const id = String(payload?.client_id || payload?.session_id || req.headers['x-client-id'] || 'default').slice(0,80);
  return id || 'default';
}
function getStreamState(key){
  const now = Date.now();
  for(const [k,v] of streamStates){ if(now - (v.lastSeenAt || 0) > 30*60*1000) streamStates.delete(k); }
  if(!streamStates.has(key)) streamStates.set(key, { repeatCount: 0, lastDigest: '', lastSeenAt: now });
  return streamStates.get(key);
}
function send(res, status, obj){
  const body = status === 204 ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-btc-ai-version,x-client-id',
    'access-control-max-age': '86400'
  });
  res.end(body);
}
function notFound(res){ send(res, 404, { ok:false, error:'not_found', version:VERSION, endpoints:['/','/health','/market','/analyze','/api/ai-review'] }); }
function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if(size > MAX_BODY_BYTES){ reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try{
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch(e){ reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}
function extractJsonText(text){
  if(!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/```$/,'').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if(start >= 0 && end > start) s = s.slice(start, end+1);
  try{ return JSON.parse(s); } catch(_){ return null; }
}
function buildPrompt(payload, local, validation){
  const compact = {
    timer: payload.timer,
    setup: payload.setup,
    live: payload.live,
    brti: payload.brti,
    rawMarket: {
      summary: payload.rawMarket?.summary,
      venues: (payload.rawMarket?.venues || []).slice(0,8),
      recentSeriesTail: (payload.rawMarket?.recentSeries || []).slice(-12)
    },
    engineRead: payload.engineRead,
    localIndependentModel: local.independent_ai,
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings }
  };
  return [
    { role: 'system', content: 'Independent BTC 15-min above/below copilot. Use raw BRTI/replica stream, target, timer, fair max, drift/volatility first; compare engine second. Return ONLY compact JSON. If stale/invalid: FIX_DATA. Weak edge: WAIT/SIT_OUT. Values trade_read: ACT_NOW, PREPARE, WAIT, SIT_OUT, DO_NOT_CHASE, FIX_DATA. decision: ABOVE, BELOW, SIT_OUT.' },
    { role: 'user', content: `Return JSON: software_health, trade_read, reason, main_blocker, confidence, max_price, anomaly_warning, independent_ai{decision,confidence,prob_above,prob_below,regime,trend,reason}. Snapshot=${JSON.stringify(compact)}` }
  ];
}
async function callOpenAI(payload, local, validation){
  if(!OPENAI_API_KEY) return { used:false, error:'OPENAI_API_KEY missing' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try{
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type':'application/json', 'authorization':`Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.1, max_tokens: 320, response_format: { type: 'json_object' }, messages: buildPrompt(payload, local, validation) }),
      signal: controller.signal
    });
    clearTimeout(t);
    if(!resp.ok){
      const errText = await resp.text().catch(()=>String(resp.status));
      return { used:false, error:`OpenAI HTTP ${resp.status}: ${errText.slice(0,220)}` };
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content || '';
    const parsed = extractJsonText(content);
    if(!parsed) return { used:false, error:'OpenAI returned non-JSON content' };
    return { used:true, json: parsed };
  } catch(e){
    clearTimeout(t);
    return { used:false, error: e?.name === 'AbortError' ? 'OpenAI timeout' : (e?.message || String(e)) };
  }
}
function healthPayload(){
  return { ok:true, service:'btc-ai-copilot-backend', version:VERSION, endpoints:['/health','/brti','/market','/analyze','/api/ai-review'], settlement_source:'CF_BRTI_PUBLIC_PAGE_PLUS_METHOD_REPLICA', model:OPENAI_MODEL, openai_configured:!!OPENAI_API_KEY, openai_timeout_ms:OPENAI_TIMEOUT_MS, server_ts:new Date().toISOString() };
}
function median(arr){
  const xs = arr.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!xs.length) return null;
  const m = Math.floor(xs.length/2);
  return xs.length % 2 ? xs[m] : (xs[m-1]+xs[m])/2;
}

// BRTI is calculated from constituent exchange order-book mids. Without licensed CF credentials,
// this backend builds the closest automatic replica from public best bid/ask feeds and calibrates it
// against the public CF BRTI page when that page updates. This is not the licensed settlement feed.
const replicaState = { history: [], calibration: null, lastCfTs: 0 };
const MAX_REPLICA_HISTORY_MS = Number(process.env.MAX_REPLICA_HISTORY_MS || 10*60*1000);
const CALIBRATION_MAX_AGE_MS = Number(process.env.CALIBRATION_MAX_AGE_MS || 5*60*1000);
const REPLICA_MAX_SPREAD_BPS = Number(process.env.REPLICA_MAX_SPREAD_BPS || 12);
const VENUES = [
  { name:'Coinbase', url:'https://api.exchange.coinbase.com/products/BTC-USD/ticker', parse:j=>({ bid:Number(j?.bid), ask:Number(j?.ask), last:Number(j?.price) }) },
  { name:'Kraken', url:'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', parse:j=>{ const x=j?.result?.XXBTZUSD || j?.result?.XBTUSD || Object.values(j?.result||{})[0] || {}; return { bid:Number(x?.b?.[0]), ask:Number(x?.a?.[0]), last:Number(x?.c?.[0]) }; } },
  { name:'Bitstamp', url:'https://www.bitstamp.net/api/v2/ticker/btcusd/', parse:j=>({ bid:Number(j?.bid), ask:Number(j?.ask), last:Number(j?.last) }) },
  { name:'Gemini', url:'https://api.gemini.com/v1/pubticker/btcusd', parse:j=>({ bid:Number(j?.bid), ask:Number(j?.ask), last:Number(j?.last) }) }
];
async function fetchVenue(v){
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), VENUE_TIMEOUT_MS);
  try{
    const r = await fetch(v.url, { cache:'no-store', signal: ctrl.signal, headers:{ 'accept':'application/json', 'cache-control':'no-cache', 'pragma':'no-cache', 'user-agent':'btc-brti-replica/74.1' } });
    clearTimeout(t);
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const q = v.parse(j) || {};
    const bid = Number(q.bid), ask = Number(q.ask), last = Number(q.last);
    let mid = (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0 && ask >= bid) ? (bid + ask) / 2 : last;
    if(!Number.isFinite(mid) || mid <= 0) throw new Error('bad price');
    return { name:v.name, ok:true, bid:Number.isFinite(bid)?bid:null, ask:Number.isFinite(ask)?ask:null, last:Number.isFinite(last)?last:null, mid, ageMs:Date.now()-started, t:Date.now(), source:'PUBLIC_L1_MID' };
  } catch(e){
    clearTimeout(t);
    return { name:v.name, ok:false, mid:null, ageMs:999999, error:e?.name === 'AbortError' ? 'timeout' : (e?.message || String(e)), t:Date.now() };
  }
}
function computeReplica(venues, now=Date.now()){
  const fresh = (venues||[]).filter(v => v.ok && Number.isFinite(v.mid) && v.ageMs < 6000);
  const rawMedian = median(fresh.map(v => v.mid));
  if(!Number.isFinite(rawMedian)) return { ok:false, price:null, rawMedian:null, venues:fresh, freshVenueCount:fresh.length, maxSpreadBps:null, error:'no fresh venue mids' };
  // CF methodology screens out extreme outliers vs median. Use a conservative public replica screen.
  const screened = fresh.filter(v => Math.abs((v.mid - rawMedian) / rawMedian * 10000) <= 25);
  const priceRaw = median(screened.map(v => v.mid));
  const max = screened.length ? Math.max(...screened.map(v=>v.mid)) : null;
  const min = screened.length ? Math.min(...screened.map(v=>v.mid)) : null;
  const maxSpreadBps = Number.isFinite(priceRaw) && max && min ? ((max-min)/priceRaw)*10000 : null;
  const ok = screened.length >= 3 && Number.isFinite(priceRaw) && (maxSpreadBps == null || maxSpreadBps <= REPLICA_MAX_SPREAD_BPS);
  return { ok, priceRaw, price:priceRaw, rawMedian, venues:screened, freshVenueCount:screened.length, maxSpreadBps, error: ok ? null : 'replica venue quality insufficient' };
}
function rememberReplica(price, now=Date.now()){
  if(!Number.isFinite(price)) return;
  replicaState.history.push({ t: now, price });
  replicaState.history = replicaState.history.filter(p => now - p.t <= MAX_REPLICA_HISTORY_MS);
}
function calibrateReplicaFromCf(brti, now=Date.now()){
  if(!brti || !brti.ok || !Number.isFinite(brti.price) || !Number.isFinite(brti.t)) return null;
  const cfTs = Number.isFinite(Date.parse(brti.last_updated || '')) ? Date.parse(brti.last_updated) : (brti.t - (brti.ageMs || 0));
  if(!Number.isFinite(cfTs)) return null;
  let best = null, bestDt = Infinity;
  for(const p of replicaState.history){ const dt = Math.abs(p.t - cfTs); if(dt < bestDt){ best=p; bestDt=dt; } }
  if(best && bestDt <= 15000){
    const offset = brti.price - best.price;
    const old = replicaState.calibration;
    const smooth = old && now - old.createdAt < CALIBRATION_MAX_AGE_MS ? old.offset * 0.65 + offset * 0.35 : offset;
    replicaState.calibration = { offset:smooth, rawOffset:offset, cfPrice:brti.price, replicaAtCf:best.price, cfTs, matchedReplicaTs:best.t, matchErrorMs:bestDt, createdAt:now };
    replicaState.lastCfTs = cfTs;
  }
  return replicaState.calibration;
}
function calibratedPrice(replica, brti, now=Date.now()){
  calibrateReplicaFromCf(brti, now);
  const cal = replicaState.calibration;
  const usableCal = cal && now - cal.createdAt <= CALIBRATION_MAX_AGE_MS;
  const price = Number.isFinite(replica?.price) ? replica.price + (usableCal ? cal.offset : 0) : null;
  return { price, calibration: usableCal ? cal : null, calibrationAgeMs: usableCal ? now - cal.createdAt : null, calibrated: !!usableCal };
}

function parseCfBrtiHtml(html){
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  const priceMatch = text.match(/CME CF Bitcoin Real Time Index\s+BRTI\s+\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?|[0-9]+(?:\.\d+)?)/i) || text.match(/BRTI\s+\$?([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?|[0-9]+(?:\.\d+)?)/i) || text.match(/\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d+)?)/);
  const updatedMatch = text.match(/Last updated:\s*([^|]*?GMT)/i) || text.match(/Last updated:\s*([A-Z][a-z]{2},\s*\d{2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i);
  const price = priceMatch ? Number(priceMatch[1].replace(/,/g,'')) : null;
  const lastUpdatedText = updatedMatch ? updatedMatch[1].trim() : null;
  const lastUpdatedMs = lastUpdatedText ? Date.parse(lastUpdatedText) : null;
  return { price, lastUpdatedText, lastUpdatedMs };
}
async function fetchCfBrti(){
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CF_TIMEOUT_MS);
  const cacheBust = 't=' + Date.now();
  const url = CF_BRTI_URL + (CF_BRTI_URL.includes('?') ? '&' : '?') + cacheBust;
  try{
    const r = await fetch(url, { cache:'no-store', signal:ctrl.signal, headers:{ 'accept':'text/html,application/xhtml+xml', 'cache-control':'no-cache', 'pragma':'no-cache', 'user-agent':'Mozilla/5.0 btc-signal-brti-truth/74.0' } });
    clearTimeout(t);
    if(!r.ok) throw new Error(`CF HTTP ${r.status}`);
    const html = await r.text();
    const parsed = parseCfBrtiHtml(html);
    if(!Number.isFinite(parsed.price) || parsed.price <= 0) throw new Error('CF BRTI price parse failed');
    const now = Date.now();
    const ageMs = Number.isFinite(parsed.lastUpdatedMs) ? Math.max(0, now - parsed.lastUpdatedMs) : (now - started);
    return { ok:true, source:'CF_BRTI', settlementGrade: ageMs <= CF_MAX_AGE_MS, price:parsed.price, mid:parsed.price, ageMs, t:now, last_updated: parsed.lastUpdatedText, latency_ms: now-started, url: CF_BRTI_URL };
  } catch(e){
    clearTimeout(t);
    return { ok:false, source:'CF_BRTI', settlementGrade:false, price:null, mid:null, ageMs:999999, t:Date.now(), error:e?.name === 'AbortError' ? 'CF BRTI timeout' : (e?.message || String(e)), url: CF_BRTI_URL };
  }
}
async function handleMarket(req, res){
  const started = Date.now();
  const now = Date.now();
  const [brti, venueResults] = await Promise.all([fetchCfBrti(), Promise.all(VENUES.map(fetchVenue)).catch(()=>[])]);
  const venues = Array.isArray(venueResults) ? venueResults : [];
  const replica = computeReplica(venues, now);
  if(Number.isFinite(replica.price)) rememberReplica(replica.price, now);
  const cal = calibratedPrice(replica, brti, now);
  const officialOk = !!(brti.ok && brti.settlementGrade && Number.isFinite(brti.price));
  const replicaOk = !!(replica.ok && Number.isFinite(cal.price));
  const price = officialOk ? brti.price : (replicaOk ? cal.price : replica.price);
  const health = officialOk ? 'BRTI_GOOD' : (replicaOk ? (cal.calibrated ? 'BRTI_REPLICA_CALIBRATED' : 'BRTI_REPLICA_UNCALIBRATED') : 'DATA_NOT_USABLE');
  const source = officialOk ? 'CF_BRTI' : (replicaOk ? (cal.calibrated ? 'BRTI_REPLICA_PUBLIC_L1_CALIBRATED_TO_CF_DELAYED' : 'BRTI_REPLICA_PUBLIC_L1') : 'NONE');
  const venueRows = replica.venues.map(v => ({ ...v, ok:true, settlementGrade:officialOk, replica:true }));
  const proxyDelta = brti.ok && Number.isFinite(replica.price) ? brti.price - replica.price : null;
  const proxyDeltaBps = Number.isFinite(proxyDelta) && brti.price ? (proxyDelta / brti.price) * 10000 : null;
  send(res, 200, {
    ok: officialOk || replicaOk,
    health, version:VERSION, server_ts:new Date().toISOString(), backend_latency_ms:Date.now()-started,
    price,
    source,
    settlement_grade: officialOk,
    official_settlement_grade: officialOk,
    replica_grade: replicaOk,
    brti,
    calibration: cal.calibration ? { ...cal.calibration, ageMs: cal.calibrationAgeMs } : null,
    venues: venueRows,
    proxy: { price:replica.price, venues, freshVenueCount:replica.freshVenueCount, maxSpreadBps:replica.maxSpreadBps, delta:proxyDelta, deltaBps:proxyDeltaBps, diagnosticOnly:!replicaOk },
    summary:{ freshVenueCount:venueRows.length, quotedVenueCount:venues.length, settlementGrade:officialOk, replicaGrade:replicaOk, source, proxyFreshVenueCount:replica.freshVenueCount, proxyDelta, proxyDeltaBps, calibrationActive:!!cal.calibration, calibrationAgeMs:cal.calibrationAgeMs, maxSpreadBps:replica.maxSpreadBps }
  });
}
async function handleAnalyze(req, res){
  const started = Date.now();
  let payload;
  try{ payload = await readBody(req); }
  catch(e){ return send(res, 400, { ok:false, health:'FIX_DATA', trade_read:'FIX_DATA', reason:e.message, version:VERSION }); }
  const key = clientKey(payload, req);
  const state = getStreamState(key);
  const validation = validateSnapshot(payload, state, Date.now());
  let local = localIndependentRead(payload, validation);
  let finalRead = local;
  let openaiMeta = { used:false, error:null };
  if(validation.ok){
    openaiMeta = await callOpenAI(payload, local, validation);
    if(openaiMeta.used){
      finalRead = normalizeAiJson(openaiMeta.json, local, validation);
      finalRead.consensus = finalRead.consensus || {};
      finalRead.consensus.label = finalRead.consensus.label || 'AI_REVIEWED_WITH_LOCAL_GUARD';
    } else {
      finalRead.anomaly_warning = local.anomaly_warning && local.anomaly_warning !== '—'
        ? `${local.anomaly_warning}; OpenAI unavailable — local independent fallback used (${openaiMeta.error})`
        : `OpenAI unavailable — local independent fallback used (${openaiMeta.error})`;
      finalRead.consensus = { label: 'LOCAL_FALLBACK_OPENAI_UNAVAILABLE' };
    }
  }
  const out = publicResponse(finalRead, validation, started);
  out.openai = { used:!!openaiMeta.used, model:OPENAI_MODEL, error:openaiMeta.used ? null : openaiMeta.error };
  out.stream = { client_id:key, repeat_count:state.repeatCount || 0 };
  return send(res, 200, out);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-btc-ai-version,x-client-id');
  if(req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try{
    if(req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) return send(res, 200, healthPayload());
    if(req.method === 'GET' && url.pathname === '/brti') return send(res, 200, await fetchCfBrti());
    if(req.method === 'GET' && url.pathname === '/market') return handleMarket(req, res);
    if(req.method === 'POST' && (url.pathname === '/analyze' || url.pathname === '/api/ai-review')) return handleAnalyze(req, res);
    return notFound(res);
  } catch(e){
    return send(res, 500, { ok:false, health:'BACKEND_ERROR', trade_read:'FIX_DATA', reason:e?.message || String(e), version:VERSION });
  }
});

server.listen(PORT, () => console.log(`${VERSION} backend listening on ${PORT}`));
