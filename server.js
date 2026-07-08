'use strict';

/*
  BTC Copilot Core 1.1 Backend
  Clean architecture reset: one authoritative decision brain.
  - No frontend/local-engine trade overrides.
  - No generic WAIT command.
  - AI cannot invent probabilities; backend computes calibrated probabilities and AI may approve/veto/explain the thesis.
  - If OpenAI authority is unavailable, the system will not issue entry trades.

  Endpoints:
    GET  /health
    GET  /market
    POST /decide   (aliases: /analyze, /ai-trader, /copilot/auto)
    POST /replay
    GET  /selftest
*/

const http = require('http');
const { URL } = require('url');

function envNumber(name, fallback, min = -Infinity, max = Infinity) {
  const n = Number(process.env[name]);
  const v = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, v));
}

const PORT = envNumber('PORT', 10000, 1, 65535);
const SERVER_VERSION = 'btc-copilot-2.0-ai-brain';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENABLE_OPENAI = /^(0|false|no)$/i.test(process.env.ENABLE_OPENAI || '') ? false : (/^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI || '') || !!OPENAI_API_KEY);
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').replace('gpt-40', 'gpt-4o');
const OPENAI_TIMEOUT_MS = envNumber('OPENAI_TIMEOUT_MS', 7000, 2500, 20000);
const OPENAI_MAX_TOKENS = envNumber('OPENAI_MAX_TOKENS', 450, 150, 1200);
const AI_MAX_CALLS_PER_DAY = envNumber('AI_MAX_CALLS_PER_DAY', 5000, 100, 20000);
const MARKET_TIMEOUT_MS = envNumber('MARKET_TIMEOUT_MS', 3200, 1200, 10000);
const MARKET_CACHE_MS = envNumber('MARKET_CACHE_MS', 700, 150, 5000);
const MARKET_STALE_MS = envNumber('MARKET_STALE_MS', 8000, 1500, 30000);
const DECISION_LOCK_MS = envNumber('DECISION_LOCK_MS', 8500, 2500, 20000);
const AI_CACHE_MS = envNumber('AI_CACHE_MS', 2500, 0, 10000);

const COMMANDS = new Set(['SIT_OUT','TRADE_ABOVE','TRADE_BELOW','HOLD_ABOVE','HOLD_BELOW','EXIT_ABOVE','EXIT_BELOW']);
let marketCache = { t: 0, data: null };
let dayKey = new Date().toISOString().slice(0, 10);
let dayCalls = 0;
const sessions = new Map();

function clamp(x, lo, hi) { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function finite(x) { const n = Number(x); return Number.isFinite(n) ? n : NaN; }
function round(x, d=4) { const n = Number(x); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function pct(x) { const n = Number(x); return Number.isFinite(n) ? Math.round(clamp(n, 0, 1) * 100) : null; }
function bps(price, ref) { price = Number(price); ref = Number(ref); return Number.isFinite(price) && Number.isFinite(ref) && ref !== 0 ? ((price-ref)/ref)*10000 : NaN; }
function median(arr) { const a=arr.map(Number).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length) return NaN; const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function erf(x) { const sign=x<0?-1:1; x=Math.abs(x); const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const t=1/(1+p*x); const y=1-(((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)); return sign*y; }
function normCdf(x) { return 0.5*(1+erf(x/Math.SQRT2)); }
function nowDate() { return new Date().toISOString().slice(0,10); }
function resetDailyIfNeeded(){ const k=nowDate(); if(k!==dayKey){dayKey=k; dayCalls=0; sessions.clear();}}
function sideFromCommand(c){ c=String(c||'').toUpperCase(); if(c.includes('ABOVE')) return 'ABOVE'; if(c.includes('BELOW')) return 'BELOW'; return null; }
function commandType(c){ c=String(c||'SIT_OUT').toUpperCase(); if(c.startsWith('TRADE')) return 'TRADE'; if(c.startsWith('HOLD')) return 'HOLD'; if(c.startsWith('EXIT')) return 'EXIT'; return 'SIT_OUT'; }
function cleanCommand(c){ c=String(c||'SIT_OUT').toUpperCase().replace(/[^A-Z_]/g,'_').replace(/_+/g,'_').replace(/^_|_$/g,''); return COMMANDS.has(c)?c:'SIT_OUT'; }
function activeSide(value){ const s=String(value||'').toUpperCase(); if(s.includes('ABOVE')) return 'ABOVE'; if(s.includes('BELOW')) return 'BELOW'; return null; }
function cors(res){ res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization'); res.setHeader('Cache-Control','no-store'); }
function send(res, code, obj){ cors(res); res.statusCode=code; res.setHeader('Content-Type','application/json; charset=utf-8'); res.end(JSON.stringify(obj)); }
function readBody(req, limit=350000){ return new Promise((resolve,reject)=>{ let data=''; req.on('data', chunk=>{ data+=chunk; if(data.length>limit){ reject(new Error('Payload too large')); req.destroy(); }}); req.on('end',()=>{ if(!data) return resolve({}); try{ resolve(JSON.parse(data)); } catch(e){ reject(new Error('Invalid JSON body')); }}); req.on('error', reject); }); }

async function fetchJson(url, timeoutMs=MARKET_TIMEOUT_MS){
  const ac=new AbortController(); const timer=setTimeout(()=>{try{ac.abort();}catch(_){}} , timeoutMs);
  try{
    const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'btc-copilot-core-1.1-authority-locked','Accept':'application/json'}});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

async function getMarket(){
  const now=Date.now();
  if(marketCache.data && now-marketCache.t < MARKET_CACHE_MS) return {...marketCache.data, cached:true, responseTs:now, stale:false, staleAgeMs:0};
  const jobs=await Promise.allSettled([
    fetchJson('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(j=>({venue:'coinbase',price:Number(j?.data?.amount)})),
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then(j=>{const k=Object.keys(j?.result||{})[0]; return {venue:'kraken',price:Number(j?.result?.[k]?.c?.[0])};}),
    fetchJson('https://www.bitstamp.net/api/v2/ticker/btcusd/').then(j=>({venue:'bitstamp',price:Number(j?.last)})),
    fetchJson('https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD').then(j=>({venue:'binanceus',price:Number(j?.price)}))
  ]);
  const venues=[]; const errors=[];
  for(const j of jobs){
    if(j.status==='fulfilled' && j.value && Number.isFinite(j.value.price) && j.value.price>1000) venues.push(j.value);
    else errors.push(String(j.reason?.message || j.reason || 'bad venue'));
  }
  if(!venues.length){
    if(marketCache.data && now-marketCache.t <= MARKET_STALE_MS){
      return {...marketCache.data, ok:true, cached:true, stale:true, responseTs:now, staleAgeMs:now-marketCache.t, upstreamError:errors.slice(0,4).join(' | ')};
    }
    throw new Error('No live BTC venues returned valid data: '+errors.slice(0,4).join(' | '));
  }
  const prices=venues.map(v=>v.price); const proxy=median(prices); const spreadBps=proxy?((Math.max(...prices)-Math.min(...prices))/proxy)*10000:NaN;
  const confidence=Math.round(clamp(100-(Number.isFinite(spreadBps)?spreadBps*5:35),35,100));
  const data={ok:true,version:SERVER_VERSION,price:proxy,proxy,priceTs:now,responseTs:now,stale:false,staleAgeMs:0,confidence,spreadBps,venueCount:venues.length,source:venues.map(v=>v.venue).join(', '),venues};
  marketCache={t:now,data};
  return data;
}

function sessionFor(id){ const key=String(id||'default').slice(0,80); if(!sessions.has(key)) sessions.set(key,{lastDecision:null,lastAi:null,history:[]}); return sessions.get(key); }
function normalizeTape(tape){
  if(!Array.isArray(tape)) return [];
  return tape.map(x=>({ts:finite(x.ts ?? x.t), price:finite(x.price ?? x.p)})).filter(x=>Number.isFinite(x.ts)&&Number.isFinite(x.price)&&x.price>1000).sort((a,b)=>a.ts-b.ts).slice(-240);
}
function regressionSlopeBpsPerSec(tape, ref){
  if(!tape || tape.length<3 || !Number.isFinite(ref) || ref<=0) return NaN;
  const last=tape[tape.length-1].ts; const xs=[], ys=[];
  for(const p of tape){ const age=(p.ts-last)/1000; if(age>=-150){ xs.push(age); ys.push(bps(p.price, ref)); }}
  if(xs.length<3) return NaN;
  const mx=xs.reduce((a,b)=>a+b,0)/xs.length, my=ys.reduce((a,b)=>a+b,0)/ys.length;
  let num=0, den=0; for(let i=0;i<xs.length;i++){ num+=(xs[i]-mx)*(ys[i]-my); den+=(xs[i]-mx)*(xs[i]-mx); }
  return den>0?num/den:NaN;
}
function realizedVolBpsPerSqrtSec(tape, ref){
  if(!tape || tape.length<4 || !Number.isFinite(ref) || ref<=0) return NaN;
  const returns=[];
  for(let i=1;i<tape.length;i++){
    const dt=(tape[i].ts-tape[i-1].ts)/1000; if(dt<=0 || dt>20) continue;
    const r=bps(tape[i].price,tape[i-1].price)/Math.sqrt(dt);
    if(Number.isFinite(r)) returns.push(r);
  }
  if(returns.length<3) return NaN;
  const m=returns.reduce((a,b)=>a+b,0)/returns.length;
  const v=returns.reduce((a,b)=>a+(b-m)*(b-m),0)/(returns.length-1);
  return Math.sqrt(v);
}
function moveBps(tape, lookbackSec, ref){
  if(!tape || tape.length<2 || !Number.isFinite(ref)) return NaN;
  const last=tape[tape.length-1]; const cutoff=last.ts-lookbackSec*1000;
  let p0=tape[0]; for(const p of tape){ if(p.ts>=cutoff){p0=p; break;} }
  return bps(last.price, p0.price);
}
function monotonicityScore(tape, side){
  if(!tape || tape.length<5) return 0;
  let good=0,total=0; const s=side==='ABOVE'?1:-1;
  for(let i=1;i<tape.length;i++){ const dp=tape[i].price-tape[i-1].price; if(dp!==0){ total++; if(s*dp>0) good++; }}
  return total?((good/total)-0.5)*2:0;
}

function finiteMove(tape, sec, ref){
  const v=moveBps(tape, sec, ref);
  return Number.isFinite(v)?v:0;
}
function reversalAnalytics({tape, side, sideSign, gapBps, secondsLeft, vol, move2, move5, move10, move15, move30, move60, move90, sideMomentum, drift, mono, pSettleSideRaw}){
  const adverse = sec => -sideSign*finiteMove(tape, sec, 1); // unused fallback-free placeholder
  const a2=-sideSign*(Number.isFinite(move2)?move2:0);
  const a5=-sideSign*(Number.isFinite(move5)?move5:0);
  const a10=-sideSign*(Number.isFinite(move10)?move10:0);
  const a15=-sideSign*(Number.isFinite(move15)?move15:0);
  const a30=-sideSign*(Number.isFinite(move30)?move30:0);
  const a60=-sideSign*(Number.isFinite(move60)?move60:0);
  const towardStrikeBps=Math.max(0,a2,a5,a10,a15,a30*0.80,a60*0.60);
  const confirmingAwayBps=Math.max(0,sideSign*(Number.isFinite(move15)?move15:0),sideSign*(Number.isFinite(move30)?move30:0));
  const adverseVelocityBpsPerSec=Math.max(0,a2/2,a5/5,a10/10,a15/15,a30/30,a60/60);
  const recentAdverseVelocity=Math.max(0,a2/2,a5/5,a10/10);
  const baseAdverseVelocity=Math.max(0.0001,a30/30,a60/60,a90Safe(a60)/90);
  const adverseAccelerationBpsPerSec=Math.max(0,recentAdverseVelocity-baseAdverseVelocity);
  const adverseBurst = a2>Math.max(0.55,gapBps*0.24) || a5>Math.max(0.85,gapBps*0.34) || a10>Math.max(1.25,gapBps*0.46);
  const adverseTrend = a15>Math.max(0.9,gapBps*0.28) || a30>Math.max(1.4,gapBps*0.38);
  const exhaustion = confirmingAwayBps>1.2 && a5>0.20 && a2>0.05;
  const time=Math.max(1,secondsLeft);
  const expectedAdverse=Math.max(0, -sideSign*(Number.isFinite(drift)?drift:0))*time + adverseVelocityBpsPerSec*time*0.38 + adverseAccelerationBpsPerSec*time*time*0.20;
  const sigma=Math.max(0.45, vol*Math.sqrt(time));
  const z=(gapBps-expectedAdverse)/sigma;
  const diffusionHit=1-normCdf(z);
  const jumpFloor=clamp(0.006 + Math.min(0.20, vol*0.030) + Math.min(0.20, adverseVelocityBpsPerSec*0.62) + (adverseBurst?0.10:0) + (adverseTrend?0.06:0),0.006,0.55);
  const nearStrikeBoost=gapBps<1.2?0.18:gapBps<2.5?0.08:0;
  let pTouch=clamp(Math.max(diffusionHit*0.72 + jumpFloor + nearStrikeBoost, jumpFloor),0.004,0.94);
  const crossConditional=clamp(0.12 + adverseVelocityBpsPerSec*0.55 + adverseAccelerationBpsPerSec*1.8 + (adverseBurst?0.18:0) + (adverseTrend?0.10:0) - confirmingAwayBps*0.035,0.05,0.82);
  const pCross=clamp(pTouch*crossConditional,0.002,0.88);
  const settleConditional=clamp(0.10 + adverseVelocityBpsPerSec*0.40 + adverseAccelerationBpsPerSec*1.25 + (secondsLeft<45?0.08:0) + (adverseBurst?0.10:0) - confirmingAwayBps*0.030,0.03,0.70);
  const pSettleOpposite=clamp(Math.max(1-(Number.isFinite(pSettleSideRaw)?pSettleSideRaw:0.5), pCross*settleConditional),0.002,0.78);
  const pHardReverse=clamp(pCross*(0.35 + Math.min(0.35, adverseVelocityBpsPerSec*0.50) + (adverseBurst?0.18:0)),0.001,0.72);
  const etaRaw=adverseVelocityBpsPerSec>0.035 ? gapBps/adverseVelocityBpsPerSec : null;
  const etaTouchSec=etaRaw && Number.isFinite(etaRaw) ? Math.max(1,Math.round(etaRaw)) : null;
  const pressureScore=clamp(
    pTouch*42 + pCross*22 + pSettleOpposite*18 + pHardReverse*18 +
    Math.max(0,a2)*4.5 + Math.max(0,a5)*2.5 + Math.max(0,a15)*1.35 +
    adverseAccelerationBpsPerSec*26 + (adverseBurst?14:0) + (adverseTrend?9:0) + (exhaustion?6:0) + (mono<0?-mono*10:0), 0, 100);
  let call='NONE';
  if(pSettleOpposite>=0.38 || pressureScore>=78 || pHardReverse>=0.34) call='LIKELY_OPPOSITE';
  else if(pTouch>=0.45 || pressureScore>=60 || (etaTouchSec!==null && etaTouchSec<=Math.max(10,secondsLeft*0.45))) call='LIKELY_TOUCH';
  else if(pTouch>=0.28 || pressureScore>=42 || adverseBurst || adverseTrend) call='WATCH';
  const direction=side==='ABOVE'?'DOWN_TO_TARGET_OR_BELOW':'UP_TO_TARGET_OR_ABOVE';
  const label=pressureScore>=78?'CRITICAL':pressureScore>=60?'HIGH':pressureScore>=42?'ELEVATED':pressureScore>=25?'WATCH':'LOW';
  const reasons=[];
  if(adverseBurst) reasons.push('fresh adverse burst');
  if(adverseTrend) reasons.push('multi-horizon adverse pressure');
  if(exhaustion) reasons.push('possible trend exhaustion');
  if(etaTouchSec!==null && etaTouchSec<=secondsLeft) reasons.push(`projected touch in ~${etaTouchSec}s`);
  if(!reasons.length) reasons.push('no confirmed reversal pressure');
  return {direction,call,label,score:round(pressureScore,1),pTouchStrike:round(pTouch,4),pCrossStrike:round(pCross,4),pSettleOpposite:round(pSettleOpposite,4),pHardReverse:round(pHardReverse,4),etaTouchSec,adverseVelocityBpsPerSec:round(adverseVelocityBpsPerSec,4),adverseAccelerationBpsPerSec:round(adverseAccelerationBpsPerSec,4),towardStrikeBps:round(towardStrikeBps,3),confirmingAwayBps:round(confirmingAwayBps,3),adverseBurst,adverseTrend,exhaustion,reasons};
}
function a90Safe(x){ return Number.isFinite(x)?x:0; }

function buildFeatures(payload){
  const m=payload.market || {};
  const timer=payload.timer || {};
  const target=finite(payload.target ?? payload.strike ?? payload.targetStrike);
  const price=finite(m.price ?? m.proxy ?? payload.price);
  const secondsLeft=clamp(finite(timer.secondsLeft ?? timer.remainingSec ?? payload.secondsLeft),0,900);
  const marketTs=finite(m.priceTs ?? m.ts ?? m.responseTs);
  const responseTs=finite(m.responseTs ?? Date.now());
  const marketAgeMs=Number.isFinite(marketTs)?Date.now()-marketTs:Infinity;
  const stale=Boolean(m.stale) || marketAgeMs>MARKET_STALE_MS;
  const tape=normalizeTape(payload.recentTape || payload.tape || []);
  if(tape.length && Number.isFinite(price)) tape.push({ts:Date.now(), price});
  const validGeometry=Number.isFinite(price)&&price>1000&&Number.isFinite(target)&&target>0;
  const signedGapBps=validGeometry?bps(price,target):NaN;
  const gapBps=validGeometry?Math.abs(signedGapBps):NaN;
  if(!validGeometry){
    const contractCents=finite(payload.contractCents ?? payload.contractPriceCents ?? payload.contractPrice);
    const reversal={direction:'NONE',call:'NONE',label:'NO_GEOMETRY',score:null,pTouchStrike:null,pCrossStrike:null,pSettleOpposite:null,pHardReverse:null,etaTouchSec:null,adverseVelocityBpsPerSec:null,adverseAccelerationBpsPerSec:null,towardStrikeBps:null,confirmingAwayBps:null,adverseBurst:false,adverseTrend:false,exhaustion:false,reasons:['valid price and target required']};
    return {version:SERVER_VERSION,ts:Date.now(),price,target,secondsLeft,marketTs,responseTs,marketAgeMs,stale,spreadBps:finite(m.spreadBps),venueCount:finite(m.venueCount),source:m.source||'',signedGapBps,gapBps,side:null,drift:null,vol:null,move2:null,move5:null,move10:null,move15:null,move30:null,move60:null,move90:null,sideMomentum:null,adverse2:null,adverse5:null,adverse15:null,pAbove:null,pBelow:null,pSide:null,pTouchStrike:null,pSettleOpposite:null,pCrossStrike:null,pHardReverse:null,reversalScore:null,reversal,dataQuality:0,contractCents:Number.isFinite(contractCents)?contractCents:null,activeSide:activeSide(payload.activePosition || payload.activeTrade),tapeCount:tape.length};
  }
  const side=signedGapBps>=0?'ABOVE':'BELOW';
  const sideSign=side==='ABOVE'?1:-1;
  const drift=regressionSlopeBpsPerSec(tape, target);
  const volRaw=realizedVolBpsPerSqrtSec(tape, target);
  const vol=clamp(Number.isFinite(volRaw)?volRaw:0.30,0.10,4.8);
  const move2=moveBps(tape,2,target), move5=moveBps(tape,5,target), move10=moveBps(tape,10,target), move15=moveBps(tape,15,target), move30=moveBps(tape,30,target), move60=moveBps(tape,60,target), move90=moveBps(tape,90,target);
  const weightedMove=(Number.isFinite(move10)?move10:0)*0.16+(Number.isFinite(move15)?move15:0)*0.23+(Number.isFinite(move30)?move30:0)*0.32+(Number.isFinite(move60)?move60:0)*0.20+(Number.isFinite(move90)?move90:0)*0.09;
  const sideMomentum=sideSign*weightedMove;
  const adverse2=-sideSign*(Number.isFinite(move2)?move2:0);
  const adverse5=-sideSign*(Number.isFinite(move5)?move5:0);
  const adverse15=-sideSign*(Number.isFinite(move15)?move15:0);
  const mono=monotonicityScore(tape.slice(-36), side);
  const projectedGap=signedGapBps + (Number.isFinite(drift)?drift*secondsLeft:0);
  const sigmaSettle=Math.max(0.65, vol*Math.sqrt(Math.max(secondsLeft,1)));
  let pAboveRaw=normCdf(projectedGap/sigmaSettle);
  let pBelowRaw=1-pAboveRaw;
  const rawPSide=side==='ABOVE'?pAboveRaw:pBelowRaw;
  const rev = reversalAnalytics({tape,side,sideSign,gapBps,secondsLeft,vol,move2,move5,move10,move15,move30,move60,move90,sideMomentum,drift,mono,pSettleSideRaw:rawPSide});
  let pTouch=rev.pTouchStrike;
  let pOpposite=rev.pSettleOpposite;
  const maxSideP=clamp(1-Math.max(pTouch*0.62, pOpposite*0.88, rev.pHardReverse*0.90),0.50, secondsLeft<=20?0.975:secondsLeft<=60?0.955:secondsLeft<=180?0.935:0.915);
  let calibratedPSide=clamp(Math.min(rawPSide,maxSideP),0.01,0.985);
  let pAbove, pBelow;
  if(side==='ABOVE'){ pAbove=calibratedPSide; pBelow=1-calibratedPSide; } else { pBelow=calibratedPSide; pAbove=1-calibratedPSide; }
  pOpposite=clamp(Math.max(pOpposite, side==='ABOVE'?pBelow:pAbove),0.002,0.82);
  const reversalScore=rev.score;
  const dataQuality=(!Number.isFinite(price)||!Number.isFinite(target)||target<=0)?0:(stale?15:clamp((m.confidence??70)-Math.max(0,(m.spreadBps??0)-4)*4,25,100));
  const contractCents=finite(payload.contractCents ?? payload.contractPriceCents ?? payload.contractPrice);
  const reversal={...rev,pTouchStrike:round(pTouch,4),pSettleOpposite:round(pOpposite,4)};
  return {version:SERVER_VERSION,ts:Date.now(),price,target,secondsLeft,marketTs,responseTs,marketAgeMs,stale,spreadBps:finite(m.spreadBps),venueCount:finite(m.venueCount),source:m.source||'',signedGapBps,gapBps,side,drift:round(drift,5),vol:round(vol,4),move2:round(move2,3),move5:round(move5,3),move10:round(move10,3),move15:round(move15,3),move30:round(move30,3),move60:round(move60,3),move90:round(move90,3),sideMomentum:round(sideMomentum,3),adverse2:round(adverse2,3),adverse5:round(adverse5,3),adverse15:round(adverse15,3),pAbove:round(pAbove,4),pBelow:round(pBelow,4),pSide:round(side==='ABOVE'?pAbove:pBelow,4),pTouchStrike:round(pTouch,4),pSettleOpposite:round(pOpposite,4),pCrossStrike:round(rev.pCrossStrike,4),pHardReverse:round(rev.pHardReverse,4),reversalScore:round(reversalScore,1),reversal,dataQuality:round(dataQuality,1),contractCents:Number.isFinite(contractCents)?contractCents:null,activeSide:activeSide(payload.activePosition || payload.activeTrade),tapeCount:tape.length};
}

/* =========================================================================
   AI BRAIN — the OpenAI model is the analyst and decision-maker.
   The math above is EVIDENCE handed to the model, not a competing decision.
   ========================================================================= */

function worryFromFeatures(f, side){
  // 0-100 worry score for an active position on `side`. Pure math fallback + AI prior.
  if(!f || !side) return 0;
  const pOpp = side==='ABOVE' ? f.pBelow : f.pAbove;
  const pTouch = f.pTouchStrike ?? 0;
  const pCross = f.pCrossStrike ?? 0;
  const pHard = f.pHardReverse ?? 0;
  const rev = f.reversalScore ?? 0;
  // Settle-opposite dominates (that's the real loss); touch alone is a scare.
  const w = clamp(pOpp*58 + pCross*20 + pHard*22 + rev*0.28 + pTouch*10, 0, 100);
  return round(w,0);
}
function verdictFromWorry(w){
  if(w>=62) return 'EXIT NOW';
  if(w>=34) return 'WATCH';
  return 'IGNORE';
}

function buildEvidence(f){
  // Compact, LLM-legible evidence packet — trajectories, not raw ticks.
  const side = f.side;
  return {
    secondsLeft: f.secondsLeft,
    price: f.price,
    target: f.target,
    gapBps: round(f.gapBps,2),
    signedGapBps: round(f.signedGapBps,2),
    naturalSide: side,                              // which side price is currently on
    driftBpsPerSec: f.drift,
    volBpsPerSqrtSec: f.vol,
    moves: { s2:f.move2, s5:f.move5, s15:f.move15, s30:f.move30, s60:f.move60, s90:f.move90 },
    momentumTowardSide: f.sideMomentum,
    probabilities: {
      settleAbove: f.pAbove, settleBelow: f.pBelow,
      touchTarget: f.pTouchStrike, crossTarget: f.pCrossStrike,
      settleOpposite: f.pSettleOpposite, hardReverse: f.pHardReverse
    },
    reversal: {
      score: f.reversalScore, call: f.reversal?.call, label: f.reversal?.label,
      etaTouchSec: f.reversal?.etaTouchSec, adverseBurst: f.reversal?.adverseBurst,
      adverseTrend: f.reversal?.adverseTrend, reasons: f.reversal?.reasons
    },
    dataQuality: f.dataQuality,
    stale: f.stale,
    activePosition: f.activeSide || null
  };
}

const AI_SYSTEM = [
  'You are the sole trading brain for 15-minute Bitcoin binary options that settle ABOVE or BELOW a strike price.',
  'You independently decide the call. The provided math (probabilities, reversal geometry, drift, volatility) is EVIDENCE for your judgment — weigh it, do not merely echo it.',
  'Your job each call: (1) decide the best action, (2) rate a 0-100 reversal WORRY score for any open position, (3) say plainly whether to hold or abort.',
  'Actions: SIT_OUT (no clear edge), TRADE_ABOVE, TRADE_BELOW (only when no position is open and you see a real edge), HOLD_ABOVE, HOLD_BELOW (keep an open position), EXIT_ABOVE, EXIT_BELOW (abort an open position now).',
  'BE PREDICTIVE, not reactive: weight drift, momentum, and the probability trajectory over the raw current gap. Anticipate where price SETTLES in the remaining time, not where it is this second.',
  'FIRMNESS: once a position is open, bias hard toward HOLD. Only command EXIT on strong, confirmed reversal evidence — settleOpposite probability genuinely rising, a confirmed adverse trend, or hardReverse risk. A brief wobble against the position with settleOpposite still low is NOISE: hold and set worry accordingly. Whipsawing in and out costs money; do not do it.',
  'WORRY score guide: 0-33 = noise, ignore (position healthy). 34-61 = watch, real but unconfirmed pressure. 62-100 = confirmed reversal, exit. Keep it stable between calls unless evidence materially moves.',
  'Every TRADE or EXIT must cite at least two concrete evidence values in "evidence" (e.g. "settleOpposite 0.28 rising", "drift -0.05 toward strike", "gap 9bps widening"). Calls without cited evidence are rejected by the system.',
  'Confidence = your probability the SETTLED side matches your call, 0-100. Do not sandbag or inflate.',
  'Reply ONLY with compact JSON: {"action","confidence","worry","hold_or_abort","pSettleMySide","reversalRisk":{"tempReverse","settleOpposite"},"why","evidence":[...],"invalidation"}'
].join(' ');

function aiUserPayload(evidence, session){
  return JSON.stringify({
    task: 'Decide the trade, score reversal worry, and give hold/abort guidance.',
    evidence,
    yourPriorCall: session?.lastAi ? {
      action: session.lastAi.action, side: session.lastAi.side,
      confidence: session.lastAi.confidence, worry: session.lastAi.worry,
      ageSec: session.lastAi.ts ? Math.round((Date.now()-session.lastAi.ts)/1000) : null
    } : null,
    reminder: 'If nothing material changed vs your prior call, keep the same action and a stable worry score. Reverse only with cited evidence.'
  });
}

async function callOpenAI(evidence, session){
  if(!ENABLE_OPENAI || !OPENAI_API_KEY) return { ok:false, error:'NO_OPENAI_AUTHORITY' };
  const ac=new AbortController(); const timer=setTimeout(()=>{try{ac.abort();}catch(_){}} , OPENAI_TIMEOUT_MS);
  try{
    const seed = Math.abs(String(session?.id||'default').split('').reduce((a,c)=>(a*31+c.charCodeAt(0))|0,7))%1000000;
    const r=await fetch('https://api.openai.com/v1/chat/completions',{
      method:'POST', signal:ac.signal,
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},
      body:JSON.stringify({
        model:OPENAI_MODEL, temperature:0.1, seed, max_tokens:OPENAI_MAX_TOKENS,
        response_format:{type:'json_object'},
        messages:[{role:'system',content:AI_SYSTEM},{role:'user',content:aiUserPayload(evidence,session)}]
      })
    });
    if(!r.ok){ const t=await r.text().catch(()=>''); return {ok:false,error:`OPENAI_${r.status}`,detail:t.slice(0,200)}; }
    const j=await r.json();
    const content=j?.choices?.[0]?.message?.content || '';
    return { ok:true, content, model:OPENAI_MODEL };
  } catch(e){ return {ok:false,error:String(e.name==='AbortError'?'OPENAI_TIMEOUT':e.message||e)}; }
  finally{ clearTimeout(timer); }
}

function parseAiJson(content){
  if(!content) return null;
  let txt=String(content).trim().replace(/^```json/i,'').replace(/^```/,'').replace(/```$/,'').trim();
  try{ return JSON.parse(txt); }catch(_){}
  const s=txt.indexOf('{'); if(s<0) return null;
  // tolerant recovery of truncated/trailing JSON
  for(let e=txt.length; e>s; e--){ const frag=txt.slice(s,e); try{ return JSON.parse(frag); }catch(_){} }
  // field-level regex fallback
  const grab=(k)=>{ const m=txt.match(new RegExp('"'+k+'"\\s*:\\s*"?([A-Za-z_0-9.\\-]+)"?')); return m?m[1]:null; };
  const action=grab('action'); if(!action) return null;
  return { action, confidence:Number(grab('confidence'))||0, worry:Number(grab('worry')), why:'(recovered partial AI response)', evidence:[], partial:true };
}

function normalizeAiDecision(raw, f){
  const action=cleanCommand(raw?.action);
  const side=sideFromCommand(action);
  const conf=clamp(Number(raw?.confidence)||0,0,100);
  let worry=Number(raw?.worry);
  if(!Number.isFinite(worry)) worry=worryFromFeatures(f, f.activeSide||side);
  worry=clamp(worry,0,100);
  const rr=raw?.reversalRisk||{};
  return {
    action, side, confidence:Math.round(conf), worry:Math.round(worry),
    verdict: verdictFromWorry(worry),
    holdOrAbort: String(raw?.hold_or_abort||'').toUpperCase() || (worry>=62?'ABORT':'HOLD'),
    pSettleMySide: clamp(Number(raw?.pSettleMySide),0,1),
    tempReverse: clamp(Number(rr.tempReverse ?? f.pTouchStrike),0,1),
    settleOpposite: clamp(Number(rr.settleOpposite ?? f.pSettleOpposite),0,1),
    why: String(raw?.why||'').slice(0,400),
    evidence: Array.isArray(raw?.evidence)?raw.evidence.map(x=>String(x).slice(0,80)).slice(0,6):[],
    invalidation: String(raw?.invalidation||'').slice(0,300),
    partial: !!raw?.partial
  };
}

// Committed-stance layer: firmness + anti-waffle. Runs on the AI's raw call.
function enforceFirmness(session, d, f){
  const active=f.activeSide;
  const s=session;

  // EXIT logic: only abort an open position on confirmed reversal; otherwise defer once.
  if(active && d.action.startsWith('EXIT')){
    // Confirmed only when the AIs worry is high AND the math corroborates a real settle-opposite risk.
    const mathCorroborates = (f.pSettleOpposite>=0.42) || (f.reversal && f.reversal.call==='LIKELY_OPPOSITE') || (f.pHardReverse>=0.30);
    const confirmed = (d.worry>=62 && mathCorroborates) || d.worry>=80 || f.pSettleOpposite>=0.55;
    if(confirmed){ s.pendingExit=null; d.enforced='EXIT_CONFIRMED'; return d; }
    const pe=s.pendingExit;
    if(pe && (Date.now()-pe.ts)<=45000){ s.pendingExit=null; d.enforced='EXIT_CONFIRMED_2READ'; return d; }
    s.pendingExit={ts:Date.now()};
    d.action='HOLD_'+active; d.side=active; d.enforced='EXIT_DEFERRED';
    d.holdOrAbort='HOLD';
    d.why='Abort urged but reversal not confirmed (worry '+d.worry+', settleOpposite '+pct(f.pSettleOpposite)+'%). Holding — confirm on next read. '+d.why;
    return d;
  }
  if(!d.action.startsWith('EXIT')) s.pendingExit=null;

  // If holding a position, keep it unless the AI produced a confirmed exit above.
  if(active && (d.action==='SIT_OUT')){
    d.action='HOLD_'+active; d.side=active; d.enforced='HOLD_ACTIVE';
    return d;
  }

  // Entry firmness: require cited evidence for a fresh TRADE.
  if(!active && d.action.startsWith('TRADE')){
    if(d.evidence.length<2 && !d.partial){
      d.action='SIT_OUT'; d.side=null; d.enforced='EVIDENCE_REQUIRED';
      d.why='Entry needs two cited evidence points. '+d.why;
      return d;
    }
    // Anti-waffle on the natural side: don't flip a fresh entry within 40s unless strong.
    const prev=s.committed;
    if(prev && prev.side && d.side && d.side!==prev.side && (Date.now()-prev.ts)<40000 && d.confidence<74){
      d.action='SIT_OUT'; d.side=null; d.enforced='FLIP_SUPPRESSED';
      d.why='Direction flip within 40s without strong conviction — suppressed. '+d.why;
      return d;
    }
    s.committed={side:d.side, ts:Date.now(), confidence:d.confidence};
  }
  return d;
}

function mathFallbackDecision(f){
  // Used only when AI is unavailable. Clearly labeled MATH_ONLY on the client.
  if(!f || !f.side) return { action:'SIT_OUT', side:null, confidence:0, worry:0, verdict:'IGNORE', holdOrAbort:'HOLD', why:'No valid price/target geometry.', evidence:[], source:'MATH_ONLY' };
  const active=f.activeSide;
  const pSide=f.pSide ?? 0;
  const worry=worryFromFeatures(f, active||f.side);
  if(active){
    const confirmed = worry>=62 || (f.pSettleOpposite>=0.42) || (f.reversal?.call==='LIKELY_OPPOSITE');
    return {
      action: confirmed?('EXIT_'+active):('HOLD_'+active), side:active,
      confidence: Math.round(pSide*100), worry, verdict:verdictFromWorry(worry),
      holdOrAbort: confirmed?'ABORT':'HOLD',
      pSettleMySide: active==='ABOVE'?f.pAbove:f.pBelow,
      tempReverse:f.pTouchStrike, settleOpposite:f.pSettleOpposite,
      why:`MATH ONLY (AI offline): pSide ${pct(pSide)}%, worry ${worry}, reversal ${f.reversal?.call||'NONE'}.`,
      evidence:[`pSide ${pct(pSide)}%`,`settleOpposite ${pct(f.pSettleOpposite)}%`],
      source:'MATH_ONLY'
    };
  }
  // entry: strong, low-reversal only
  const strong = pSide>=0.72 && (f.pTouchStrike??1)<=0.42 && (f.pSettleOpposite??1)<=0.34 && (f.reversalScore??100)<=55 && f.secondsLeft>5;
  return {
    action: strong?('TRADE_'+f.side):'SIT_OUT', side: strong?f.side:null,
    confidence: Math.round(pSide*100), worry, verdict:verdictFromWorry(worry),
    holdOrAbort:'HOLD', pSettleMySide:pSide, tempReverse:f.pTouchStrike, settleOpposite:f.pSettleOpposite,
    why:`MATH ONLY (AI offline): ${strong?('edge on '+f.side):'no strong edge'} — pSide ${pct(pSide)}%, reversal ${f.reversal?.call||'NONE'}.`,
    evidence: strong?[`pSide ${pct(pSide)}%`,`reversal ${f.reversal?.call||'LOW'}`]:[],
    source:'MATH_ONLY'
  };
}

async function decide(payload){
  const market = payload.market || (await getMarket().catch(()=>null));
  const f = buildFeatures({ ...payload, market });
  const session = sessionFor(payload.sessionId);
  session.id = payload.sessionId || 'default';

  const evidence = f.side ? buildEvidence(f) : null;
  let decision, source, aiError=null, model=null;

  const ai = evidence ? await callOpenAI(evidence, session) : {ok:false,error:'NO_GEOMETRY'};
  if(ai.ok){
    const parsed = parseAiJson(ai.content);
    if(parsed){
      decision = normalizeAiDecision(parsed, f);
      decision = enforceFirmness(session, decision, f);
      decision.source = 'AI';
      model = ai.model;
      session.lastAi = { action:decision.action, side:decision.side, confidence:decision.confidence, worry:decision.worry, ts:Date.now() };
      source='AI';
    } else {
      aiError='AI_PARSE_FAILED';
    }
  } else {
    aiError = ai.error;
  }
  if(!decision){
    decision = mathFallbackDecision(f);
    decision = enforceFirmness(session, decision, f);
    source='MATH_ONLY';
  }

  // Always attach the full reversal picture (math-computed) for the UI.
  const reversalWatch = {
    worry: decision.worry,
    verdict: decision.verdict,
    pTempReverse: round(decision.tempReverse ?? f.pTouchStrike, 3),
    pSettleOpposite: round(decision.settleOpposite ?? f.pSettleOpposite, 3),
    pTouchTarget: round(f.pTouchStrike,3),
    pCrossTarget: round(f.pCrossStrike,3),
    pHardReverse: round(f.pHardReverse,3),
    call: f.reversal?.call || 'NONE',
    label: f.reversal?.label || 'LOW',
    etaTouchSec: f.reversal?.etaTouchSec ?? null,
    reasons: f.reversal?.reasons || []
  };

  session.lastDecision = decision;
  return {
    ok:true, version:SERVER_VERSION, ts:Date.now(),
    source, model, aiError,
    command: decision.action, side: decision.side,
    confidence: decision.confidence,
    holdOrAbort: decision.holdOrAbort,
    reason: decision.why, invalidation: decision.invalidation || '',
    evidence: decision.evidence || [],
    enforced: decision.enforced || null,
    reversalWatch,
    features: {
      price:f.price, target:f.target, secondsLeft:f.secondsLeft, gapBps:round(f.gapBps,2),
      pAbove:f.pAbove, pBelow:f.pBelow, pSide:f.pSide,
      drift:f.drift, vol:f.vol, dataQuality:f.dataQuality, stale:f.stale,
      spreadBps:f.spreadBps, venueCount:f.venueCount, source:f.source,
      activeSide:f.activeSide, reversalScore:f.reversalScore
    }
  };
}

/* ============================ HTTP ROUTER ============================ */
const server = http.createServer(async (req, res) => {
  resetDailyIfNeeded();
  const u = new URL(req.url, `http://${req.headers.host}`);
  if(req.method==='OPTIONS'){ cors(res); res.statusCode=204; return res.end(); }

  try{
    if(req.method==='GET' && u.pathname==='/health'){
      return send(res,200,{ ok:true, version:SERVER_VERSION, service:'btc-copilot-ai-brain',
        openaiEnabled:ENABLE_OPENAI, model:OPENAI_MODEL, dayCalls, cap:AI_MAX_CALLS_PER_DAY, ts:Date.now() });
    }
    if(req.method==='GET' && (u.pathname==='/market' || u.pathname==='/btc')){
      try{ const m=await getMarket(); return send(res,200,{...m, version:SERVER_VERSION}); }
      catch(e){ return send(res,200,{ ok:false, version:SERVER_VERSION, error:String(e.message||e) }); }
    }
    if(req.method==='POST' && ['/decide','/analyze','/ai-trader','/copilot/auto'].includes(u.pathname)){
      if(dayCalls>=AI_MAX_CALLS_PER_DAY) return send(res,200,{ ok:false, error:'DAILY_CAP_REACHED', cap:AI_MAX_CALLS_PER_DAY });
      dayCalls+=1;
      const body=await readBody(req);
      const out=await decide(body);
      return send(res,200,out);
    }
    if(req.method==='GET' && u.pathname==='/selftest'){
      const out=await runSelfTest();
      return send(res, out.ok?200:500, out);
    }
    return send(res,404,{ ok:false, error:'NOT_FOUND', path:u.pathname });
  } catch(e){
    return send(res,500,{ ok:false, error:String(e.message||e) });
  }
});

async function runSelfTest(){
  const checks=[];
  const mkTape=(fn,n=90,stepMs=1000)=>{ const now=Date.now(); const t=[]; for(let i=0;i<n;i++) t.push({ts:now-(n-1-i)*stepMs, price:fn(i)}); return t; };
  // 1. strong below → math fallback should TRADE_BELOW when AI off
  const belowTape=mkTape(i=>62000-8*(i/90*10));
  const f1=buildFeatures({ market:{price:belowTape[belowTape.length-1].price, priceTs:Date.now(), responseTs:Date.now(), confidence:88, spreadBps:3, venueCount:4, source:'test'}, target:62050, timer:{secondsLeft:300}, recentTape:belowTape });
  const d1=mathFallbackDecision(f1);
  checks.push({name:'below trend → math side BELOW', pass:f1.side==='BELOW', got:f1.side});
  // 2. worry monotonic: rising settle-opposite raises worry
  const wLow=worryFromFeatures({pBelow:0.9,pAbove:0.1,pTouchStrike:0.1,pCrossStrike:0.05,pHardReverse:0.02,reversalScore:15},'ABOVE');
  const wHigh=worryFromFeatures({pBelow:0.9,pAbove:0.1,pTouchStrike:0.5,pCrossStrike:0.4,pHardReverse:0.3,reversalScore:70},'ABOVE');
  checks.push({name:'worry rises with reversal pressure', pass:wHigh>wLow, got:`${wLow} < ${wHigh}`});
  // 3. verdict thresholds
  checks.push({name:'verdict bands', pass:verdictFromWorry(10)==='IGNORE'&&verdictFromWorry(45)==='WATCH'&&verdictFromWorry(80)==='EXIT NOW', got:`${verdictFromWorry(10)}/${verdictFromWorry(45)}/${verdictFromWorry(80)}`});
  // 4. firmness: unconfirmed exit on healthy position defers to HOLD
  const s={id:'t',committed:null,pendingExit:null,history:[]};
  const fHealthy={activeSide:'BELOW',pSettleOpposite:0.15,pBelow:0.9,pAbove:0.1,pTouchStrike:0.2,pCrossStrike:0.05,pHardReverse:0.03,reversalScore:20,reversal:{call:'WATCH'},side:'BELOW'};
  let dEx=normalizeAiDecision({action:'EXIT_BELOW',confidence:60,worry:30,why:'wobble'},fHealthy);
  dEx=enforceFirmness(s,dEx,fHealthy);
  checks.push({name:'unconfirmed exit → deferred HOLD', pass:dEx.action==='HOLD_BELOW'&&dEx.enforced==='EXIT_DEFERRED', got:dEx.action+'/'+dEx.enforced});
  // 5. firmness: confirmed exit passes
  const s2={id:'t2',committed:null,pendingExit:null,history:[]};
  const fBroken={activeSide:'BELOW',pSettleOpposite:0.5,pBelow:0.4,pAbove:0.6,pTouchStrike:0.6,pCrossStrike:0.4,pHardReverse:0.3,reversalScore:75,reversal:{call:'LIKELY_OPPOSITE'},side:'BELOW'};
  let dEx2=normalizeAiDecision({action:'EXIT_BELOW',confidence:70,worry:80,why:'confirmed'},fBroken);
  dEx2=enforceFirmness(s2,dEx2,fBroken);
  checks.push({name:'confirmed exit passes', pass:dEx2.action==='EXIT_BELOW'&&dEx2.enforced==='EXIT_CONFIRMED', got:dEx2.action+'/'+dEx2.enforced});
  // 6. entry without evidence suppressed
  const s3={id:'t3',committed:null,pendingExit:null,history:[]};
  const fEntry={activeSide:null,side:'BELOW',pBelow:0.8,pAbove:0.2,pSettleOpposite:0.2,pTouchStrike:0.3,pCrossStrike:0.1,pHardReverse:0.05,reversalScore:30,reversal:{call:'LOW'}};
  let dEn=normalizeAiDecision({action:'TRADE_BELOW',confidence:80,worry:20,why:'x',evidence:[]},fEntry);
  dEn=enforceFirmness(s3,dEn,fEntry);
  checks.push({name:'entry w/o evidence suppressed', pass:dEn.action==='SIT_OUT'&&dEn.enforced==='EVIDENCE_REQUIRED', got:dEn.action+'/'+dEn.enforced});
  // 7. parse truncated JSON
  const p=parseAiJson('{"action":"TRADE_BELOW","confidence":78,"worry":22,"why":"trend down","evidence":["a","b"');
  checks.push({name:'truncated JSON recovered', pass:p&&p.action==='TRADE_BELOW', got:p&&p.action});
  const failed=checks.filter(c=>!c.pass);
  return { ok:failed.length===0, version:SERVER_VERSION, passed:checks.length-failed.length, total:checks.length, checks };
}

if(require.main===module){
  server.listen(PORT, ()=>{ console.log(`btc-copilot-ai-brain listening on ${PORT}, model=${OPENAI_MODEL}, openai=${ENABLE_OPENAI}`); });
}
module.exports = { buildFeatures, reversalAnalytics, worryFromFeatures, verdictFromWorry, normalizeAiDecision, enforceFirmness, mathFallbackDecision, parseAiJson, decide, runSelfTest, getMarket };
