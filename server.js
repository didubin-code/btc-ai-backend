/*
  BTC OpenAI Copilot Backend v1.0
  Standalone Render Node service for BTC Signal frontend v85+.
  Endpoints: GET /health, POST /analyze
  Env: OPENAI_API_KEY required for real OpenAI; OPENAI_MODEL optional.
*/
'use strict';

const http = require('http');
const { URL } = require('url');

const VERSION = 'btc-openai-backend-v1.0';
const PORT = Number(process.env.PORT || 10000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const OPENAI_TIMEOUT_MS = Math.max(1200, Number(process.env.OPENAI_TIMEOUT_MS || 3500));
const MOCK_OPENAI = /^(1|true|yes)$/i.test(process.env.MOCK_OPENAI || '');

function now(){ return Date.now(); }
function num(v){ const n=Number(v); return Number.isFinite(n)?n:null; }
function firstNum(...vals){ for(const v of vals){ const n=num(v); if(n!==null) return n; } return null; }
function clamp(x,lo,hi){ x=Number(x); return Number.isFinite(x)?Math.max(lo,Math.min(hi,x)):lo; }
function sideSign(side){ return String(side||'').toUpperCase()==='ABOVE' ? 1 : -1; }
function safeJson(obj){ return JSON.stringify(obj); }

function send(res, code, body, headers={}){
  const json = typeof body === 'string' ? body : safeJson(body);
  res.writeHead(code, {
    'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Cache-Control':'no-store',
    ...headers
  });
  res.end(json);
}

function readBody(req, limit=1_200_000){
  return new Promise((resolve,reject)=>{
    let data='';
    req.on('data', chunk=>{
      data += chunk;
      if(Buffer.byteLength(data)>limit){ reject(new Error('request body too large')); req.destroy(); }
    });
    req.on('end',()=>resolve(data));
    req.on('error',reject);
  });
}

function flattenVenues(body){
  const out=[];
  const add=(v,k)=>{
    if(!v) return;
    const name = String(v.name || v.venue || k || '').toLowerCase() || 'venue';
    const price = firstNum(v.mid, v.price, v.last, v.current_price, v.live_price);
    const bid = firstNum(v.bid);
    const ask = firstNum(v.ask);
    const age_ms = firstNum(v.age_ms, v.ageMs, v.age) ?? (v.t ? Math.max(0, now()-Number(v.t)) : null);
    if(price!==null) out.push({name, venue:name, price, mid:price, bid, ask, age_ms, fresh: age_ms===null ? true : age_ms <= 5000});
  };
  const candidates = [body.venue_list, body.venues_array, body.market?.venue_list, body.market?.venues, body.snapshot?.venues];
  for(const c of candidates){
    if(Array.isArray(c)) c.forEach(add);
    else if(c && typeof c==='object') Object.entries(c).forEach(([k,v])=>add(v,k));
  }
  if(body.venues && typeof body.venues==='object') Object.entries(body.venues).forEach(([k,v])=>add(v,k));
  const seen = new Set();
  return out.filter(v=>{ const key=v.name+':'+Math.round(v.price*100); if(seen.has(key)) return false; seen.add(key); return true; });
}

function extractPacket(body){
  const m = body.market || body.market_data || body.snapshot || body.data || {};
  const target = firstNum(body.target_price, body.targetPrice, body.target, body.strike_price, body.strike,
                          m.target_price, m.targetPrice, m.target, m.strike_price, m.strike);
  const live = firstNum(body.live_price, body.current_price, body.price, body.brti_proxy, body.brti,
                        m.live_price, m.current_price, m.price, m.brti_proxy, body.consensus?.price);
  const secondsLeft = firstNum(body.seconds_left, body.secondsLeft, body.time_left_seconds, body.timer_seconds,
                               m.seconds_left, m.secondsLeft, m.time_left_seconds, m.timer_seconds);
  const venues = flattenVenues(body);
  const freshVenues = venues.filter(v=>v.fresh !== false);
  const analysis = body.analysis || body.local_analysis || {};
  const position = body.position || body.active_trade || null;
  const memory = body.memory || {};
  const history = Array.isArray(body.price_history) ? body.price_history : (Array.isArray(body.history) ? body.history : []);
  return {target, live, secondsLeft, venues, freshVenues, analysis, position, memory, history};
}

function computeSignals(pkt){
  const {target, live, secondsLeft, freshVenues, history, position, analysis} = pkt;
  const valid = target!==null && live!==null && secondsLeft!==null && freshVenues.length >= 2;
  const distBps = valid ? ((live/target)-1)*10000 : null;
  const rawSide = valid ? (live >= target ? 'ABOVE' : 'BELOW') : null;
  const localSide = String(analysis.side || analysis.recommendation_side || '').toUpperCase();
  const side = localSide === 'ABOVE' || localSide === 'BELOW' ? localSide : rawSide;
  const pts = [];
  const tnow = now();
  for(const h of history){
    const price = firstNum(h.price, h.mid, h.p);
    const t = firstNum(h.t, h.ts, h.timestamp);
    if(price!==null && t!==null) pts.push({t, price});
  }
  pts.sort((a,b)=>a.t-b.t);
  const since = ms => pts.filter(p => p.t >= tnow-ms);
  const move = ms => { const a=since(ms); if(!a.length || live===null) return 0; return ((live/a[0].price)-1)*10000; };
  const move2 = move(2000), move5 = move(5000), move15 = move(15000), move30 = move(30000);
  const support = side ? (side==='ABOVE' ? move5 + move15*0.5 + Math.max(0, distBps||0)*0.07 : -move5 - move15*0.5 + Math.max(0, -(distBps||0))*0.07) : 0;
  const edgePts = valid ? Math.min(49, Math.abs(distBps)*0.9 + Math.abs(move15)*1.3 + Math.abs(move30)*0.4) : 0;
  const confidence = valid ? Math.round(clamp(50 + edgePts + Math.abs(support)*0.55 + (freshVenues.length-2)*4, 1, 99)) : 0;
  const activeSide = position ? String(position.side||'').toUpperCase() : null;
  let oppositeConfirmed = false;
  if(valid && activeSide){
    if(activeSide==='ABOVE') oppositeConfirmed = live < target && move5 < -2.5 && move15 < -4 && move30 < -3;
    if(activeSide==='BELOW') oppositeConfirmed = live > target && move5 > 2.5 && move15 > 4 && move30 > 3;
  }
  const earlyWarning = valid && !position && side && ((side==='ABOVE' && (move2 < -0.8 || move5 < -1.8)) || (side==='BELOW' && (move2 > 0.8 || move5 > 1.8)));
  return {valid, distBps, side, localSide, rawSide, confidence, move2, move5, move15, move30, support, activeSide, oppositeConfirmed, earlyWarning};
}

function localDecision(pkt){
  const s = computeSignals(pkt);
  if(!s.valid){
    return {final_action:'FIX_DATA', direction:'—', confidence:0, reason:'Need target, live BTC price, timer, and at least 2 fresh venues.', main_blocker:'LOCAL_DATA_INCOMPLETE', local_signals:s, ai_used:false, backend_version:VERSION};
  }
  if(s.activeSide){
    if(s.oppositeConfirmed){
      return {final_action:'EXIT_NOW_CONFIRMED', direction:s.activeSide==='ABOVE'?'BELOW':'ABOVE', confidence:Math.max(80,s.confidence), reason:'Active trade has sustained opposite-side evidence; exit first, do not reverse-stack.', main_blocker:'SUSTAINED_OPPOSITE_CONFIRMED', local_signals:s, ai_used:false, backend_version:VERSION};
    }
    return {final_action:'HOLD_'+s.activeSide, direction:s.activeSide, confidence:s.confidence, reason:'Active trade remains supported or reversal is not sustained enough to exit.', main_blocker:'NONE', local_signals:s, ai_used:false, backend_version:VERSION};
  }
  if(s.earlyWarning){
    return {final_action:'WAIT_EARLY_REVERSAL', direction:s.side, confidence:s.confidence, reason:'Fresh microstructure is moving against the apparent direction; wait for resolution.', main_blocker:'EARLY_REVERSAL_RISK', local_signals:s, ai_used:false, backend_version:VERSION};
  }
  if(s.confidence >= 78 && Math.abs(s.distBps) > 6){
    return {final_action:'ACT_NOW_'+s.side, direction:s.side, confidence:s.confidence, reason:'Live price, target distance, venue quorum, and recent tape support entry side.', main_blocker:'NONE', local_signals:s, ai_used:false, backend_version:VERSION};
  }
  return {final_action:'WAIT_NO_TRADE', direction:s.side, confidence:s.confidence, reason:'Evidence exists but is not strong enough for execution.', main_blocker:'INSUFFICIENT_EDGE', local_signals:s, ai_used:false, backend_version:VERSION};
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    final_action: {type:'string'},
    direction: {type:'string'},
    confidence: {type:'number'},
    reason: {type:'string'},
    main_blocker: {type:'string'},
    early_reversal_warning: {type:'boolean'},
    in_trade_exit_confirmed: {type:'boolean'},
    should_trade: {type:'boolean'},
    should_exit: {type:'boolean'},
    ai_used: {type:'boolean'},
    backend_version: {type:'string'}
  },
  required: ['final_action','direction','confidence','reason','main_blocker','early_reversal_warning','in_trade_exit_confirmed','should_trade','should_exit','ai_used','backend_version']
};

function compactPayload(pkt, local){
  return {
    target_price: pkt.target,
    live_price: pkt.live,
    seconds_left: pkt.secondsLeft,
    fresh_venues: pkt.freshVenues.length,
    venues: pkt.freshVenues.slice(0,6),
    local_analysis: pkt.analysis,
    active_trade: pkt.position,
    memory: pkt.memory,
    local_decision: local,
    recent_price_history: pkt.history.slice(-60),
    requirements: {
      no_contract_prices: true,
      entry_buttons_only: 'Entered ABOVE / Entered BELOW',
      avoid_false_exits: true,
      exit_only_on_sustained_opposite_evidence: true,
      detect_early_reversal_before_large_move: true,
      return_json_only: true
    }
  };
}

async function callOpenAI(pkt, local){
  if(MOCK_OPENAI){
    return {...local, ai_used:true, backend_version:VERSION, reason:'MOCK_OPENAI enabled. '+local.reason};
  }
  if(!OPENAI_API_KEY){
    return {...local, final_action:'BACKEND_CONFIG_ERROR', main_blocker:'OPENAI_API_KEY_MISSING', reason:'Render backend is running, but OPENAI_API_KEY is not set. '+local.reason, ai_used:false, backend_version:VERSION};
  }
  const controller = new AbortController();
  const tid = setTimeout(()=>controller.abort(), OPENAI_TIMEOUT_MS);
  const input = [
    {role:'system', content:[{type:'input_text', text:
`You are a BTC binary-options execution copilot. Analyze live BTC venue data, target/strike, timer, microstructure, active trade, and session memory.
Rules:
- User cannot provide up/down contract prices. Never require them.
- Output must be strict JSON matching schema.
- If no active trade: recommend ACT_NOW_ABOVE/ACT_NOW_BELOW only when evidence is strong; otherwise WAIT_EARLY_REVERSAL or WAIT_NO_TRADE.
- If active trade: do not panic-exit on small adverse wiggles. EXIT_NOW_CONFIRMED only if sustained opposite-side evidence confirms failure. Do not reverse-stack; exit first.
- If local evidence is valid, do not claim target/live price/fresh venues are missing.
- Be ahead of curve: identify adverse microstructure and failed continuation before a large flip.
- This is decision support, not a guarantee.`}]},
    {role:'user', content:[{type:'input_text', text: JSON.stringify(compactPayload(pkt, local))}]}
  ];
  const body = {
    model: OPENAI_MODEL,
    input,
    store: false,
    max_output_tokens: 650,
    text: { format: { type:'json_schema', name:'btc_copilot_signal', strict:true, schema: RESPONSE_SCHEMA } }
  };
  try{
    const res = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      headers:{'Authorization':`Bearer ${OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const raw = await res.text();
    if(!res.ok){
      return {...local, final_action:'OPENAI_ERROR', main_blocker:'OPENAI_HTTP_'+res.status, reason:`OpenAI error ${res.status}: ${raw.slice(0,180)}. Local fallback: ${local.reason}`, ai_used:false, backend_version:VERSION};
    }
    let data = JSON.parse(raw);
    let txt = data.output_text;
    if(!txt && Array.isArray(data.output)){
      const msg = data.output.find(x=>x.type==='message');
      const part = msg?.content?.find(c=>c.type==='output_text');
      txt = part?.text;
    }
    if(!txt) throw new Error('missing output_text');
    const parsed = JSON.parse(txt);
    return {
      ...parsed,
      confidence: clamp(parsed.confidence,0,99),
      ai_used:true,
      backend_version:VERSION,
      local_fallback_action: local.final_action,
      local_signals: local.local_signals
    };
  }catch(e){
    const msg = e.name==='AbortError' ? 'OpenAI timeout' : String(e.message||e);
    return {...local, final_action:'OPENAI_TIMEOUT_FALLBACK', main_blocker:'OPENAI_TIMEOUT_OR_PARSE', reason:`${msg}. Local fallback: ${local.reason}`, ai_used:false, backend_version:VERSION};
  }finally{
    clearTimeout(tid);
  }
}

async function handleAnalyze(req, res){
  const text = await readBody(req);
  let body;
  try{ body = text ? JSON.parse(text) : {}; }catch(e){ return send(res, 400, {final_action:'FIX_DATA', direction:'—', confidence:0, reason:'Invalid JSON request body.', main_blocker:'BAD_JSON', ai_used:false, backend_version:VERSION}); }
  const pkt = extractPacket(body);
  const local = localDecision(pkt);
  const out = await callOpenAI(pkt, local);
  send(res, 200, out);
}

const server = http.createServer(async (req,res)=>{
  try{
    if(req.method==='OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(req.method==='GET' && (url.pathname==='/' || url.pathname==='/health')){
      return send(res, 200, {ok:true, version:VERSION, model:OPENAI_MODEL, openai_configured:!!OPENAI_API_KEY, mock:MOCK_OPENAI});
    }
    if(req.method==='POST' && url.pathname==='/analyze') return await handleAnalyze(req,res);
    return send(res, 404, {ok:false, error:'not_found', version:VERSION});
  }catch(e){
    send(res, 500, {final_action:'BACKEND_ERROR', direction:'—', confidence:0, reason:String(e.message||e), main_blocker:'BACKEND_EXCEPTION', ai_used:false, backend_version:VERSION});
  }
});

server.listen(PORT, '0.0.0.0', ()=>{
  console.log(`${VERSION} listening on ${PORT}`);
});
