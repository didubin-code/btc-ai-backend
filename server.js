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
const SERVER_VERSION = 'btc-copilot-core-1.1-reversal';
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
    const r=await fetch(url,{signal:ac.signal,headers:{'User-Agent':'btc-copilot-core-1.1-reversal','Accept':'application/json'}});
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

function requirementsFor(f){
  const t=f.secondsLeft;
  if(t>720) return {minP:0.88,minGap:5.2,maxTouch:0.18,maxRev:24,label:'very early'};
  if(t>540) return {minP:0.84,minGap:4.0,maxTouch:0.20,maxRev:28,label:'early'};
  if(t>360) return {minP:0.79,minGap:2.7,maxTouch:0.24,maxRev:34,label:'mid early'};
  if(t>180) return {minP:0.73,minGap:1.55,maxTouch:0.30,maxRev:42,label:'mid late'};
  if(t>75) return {minP:0.68,minGap:0.75,maxTouch:0.38,maxRev:50,label:'late'};
  if(t>25) return {minP:0.64,minGap:0.35,maxTouch:0.46,maxRev:58,label:'very late'};
  return {minP:0.70,minGap:0.25,maxTouch:0.42,maxRev:50,label:'last seconds'};
}

function candidateDecision(f){
  const invalid=[];
  if(!Number.isFinite(f.price) || f.price<=1000) invalid.push('NO_PRICE');
  if(!Number.isFinite(f.target) || f.target<=0) invalid.push('NO_TARGET');
  if(!Number.isFinite(f.secondsLeft)) invalid.push('NO_TIMER');
  if(f.stale) invalid.push('STALE_MARKET_DATA');
  if(f.dataQuality<35) invalid.push('LOW_DATA_QUALITY');
  const active=f.activeSide;
  if(invalid.length){
    return {command:active?`EXIT_${active}`:'SIT_OUT', side:null, candidateCommand:active?`EXIT_${active}`:'SIT_OUT', blocked:true, veto:invalid.join('|'), score:0, entryQuality:'F', reason:`Cannot issue fresh entry: ${invalid.join(', ')}`, invalidation:'Data/target/timer must be valid and fresh.'};
  }
  const side=f.side; const r=requirementsFor(f);
  const pSide=f.pSide; const pTouch=f.pTouchStrike; const pOpp=f.pSettleOpposite;
  const rv=f.reversal || {};
  const gapOk=f.gapBps>=r.minGap || (f.secondsLeft<75 && pSide>=r.minP+0.08 && pTouch<r.maxTouch && rv.call!=='LIKELY_OPPOSITE');
  const pOk=pSide>=r.minP;
  const touchOk=pTouch<=r.maxTouch;
  const revOk=f.reversalScore<=r.maxRev && !['LIKELY_TOUCH','LIKELY_OPPOSITE'].includes(rv.call);
  const hardReverseRisk=(rv.pHardReverse??0)>0.22 || (rv.pCrossStrike??0)>0.34 || (rv.pSettleOpposite??0)>0.30;
  const momentumBad=f.sideMomentum < -0.45 || f.adverse2 > Math.max(0.65, f.gapBps*0.26) || f.adverse5 > Math.max(0.95, f.gapBps*0.34) || f.adverse15 > Math.max(1.15, f.gapBps*0.46) || hardReverseRisk;
  const reversalPenalty=(f.reversalScore*0.42)+(pTouch*26)+((rv.pCrossStrike??0)*22)+((rv.pHardReverse??0)*28)+((rv.call==='WATCH')?5:0)+((rv.call==='LIKELY_TOUCH')?16:0)+((rv.call==='LIKELY_OPPOSITE')?28:0);
  const score=clamp((pSide-0.5)*112 + Math.min(30,(f.gapBps/r.minGap)*18) + Math.max(-20,Math.min(20,f.sideMomentum*3.3)) - reversalPenalty,0,100);
  const entryPass=pOk && gapOk && touchOk && revOk && !momentumBad && f.secondsLeft>5;
  let command='SIT_OUT';
  if(active){
    const same=active===side;
    const exitRisk = rv.call==='LIKELY_OPPOSITE' || rv.call==='LIKELY_TOUCH' || hardReverseRisk || pTouch>0.46 || pOpp>0.34 || f.reversalScore>62 || momentumBad;
    const holdOk=same && pSide>=Math.max(0.56,r.minP-0.10) && !exitRisk;
    command=holdOk?`HOLD_${active}`:`EXIT_${active}`;
  } else if(entryPass) command=`TRADE_${side}`;
  const entryQuality= score>=84?'A+':score>=74?'A':score>=64?'B':score>=52?'C':'D';
  const fail=[];
  if(!pOk) fail.push(`pSide ${pct(pSide)}% < ${Math.round(r.minP*100)}%`);
  if(!gapOk) fail.push(`gap ${round(f.gapBps,2)}bps < ${round(r.minGap,2)}bps`);
  if(!touchOk) fail.push(`touch ${pct(pTouch)}% > ${Math.round(r.maxTouch*100)}%`);
  if(!revOk) fail.push(`reversal ${rv.call||'score'} ${round(f.reversalScore,1)} > ${r.maxRev}`);
  if(momentumBad) fail.push('adverse/reversal tape');
  const rvText=`reversal ${rv.call||'NONE'} / touch ${pct(pTouch)} / cross ${pct(rv.pCrossStrike)} / opposite ${pct(pOpp)}`;
  return {command, side, candidateCommand:command, blocked:false, veto:command==='SIT_OUT'?fail.join(' | ')||'NO_EDGE':'NONE', score:round(score,1), entryQuality, reason: command.startsWith('TRADE')?`${side} thesis passes calibrated ${r.label} requirements: pSide ${pct(pSide)}%, gap ${round(f.gapBps,2)}bps, ${rvText}.`: active?`${command}: active ${active}, live side ${side}, pSide ${pct(pSide)}%, ${rvText}.`:`SIT_OUT: ${fail.join('; ') || 'edge not strong enough'}; ${rvText}.`, invalidation:`Invalidate ${side||'thesis'} if ${rv.direction||'reversal'} moves to WATCH/LIKELY_TOUCH, pTouch rises, pCross rises, data goes stale, or adverse acceleration confirms.`};
}

function canKeepLockedTrade(prev, f){
  if(!prev || !prev.command || !prev.command.startsWith('TRADE_')) return false;
  const side=sideFromCommand(prev.command);
  const age=Date.now()-(prev.ts||0);
  if(age>DECISION_LOCK_MS) return false;
  if(f.stale || f.dataQuality<35 || !Number.isFinite(f.target) || !Number.isFinite(f.price)) return false;
  if(side!==f.side) return false;
  if(f.pSide<0.60 || f.pTouchStrike>0.46 || f.pCrossStrike>0.30 || f.pHardReverse>0.20 || f.reversalScore>60 || (f.reversal&&['LIKELY_TOUCH','LIKELY_OPPOSITE'].includes(f.reversal.call))) return false;
  return true;
}

function sanitizeAi(raw){
  const empty={ok:false,approve:false,preferredCommand:'SIT_OUT',riskLevel:'unknown',reason:'No AI thesis.',redFlags:[]};
  if(!raw || typeof raw!=='object') return empty;
  const preferred=cleanCommand(raw.preferredCommand || raw.command || raw.action || 'SIT_OUT');
  const risk=String(raw.riskLevel || raw.risk || 'medium').toLowerCase();
  return {ok:true,approve:Boolean(raw.approveCandidate ?? raw.approve ?? raw.supportsEntry ?? false),preferredCommand:preferred,riskLevel:['low','medium','high','critical'].includes(risk)?risk:'medium',reason:String(raw.reason || raw.rationale || '').slice(0,500),redFlags:Array.isArray(raw.redFlags)?raw.redFlags.slice(0,6).map(x=>String(x).slice(0,120)):[]};
}

async function callOpenAI(f, candidate){
  resetDailyIfNeeded();
  if(!ENABLE_OPENAI || !OPENAI_API_KEY) return {ok:false,error:'NO_OPENAI_AUTHORITY'};
  if(dayCalls>=AI_MAX_CALLS_PER_DAY) return {ok:false,error:'AI_DAILY_CAP'};
  dayCalls++;
  const facts={price:f.price,target:f.target,secondsLeft:f.secondsLeft,side:f.side,gapBps:f.gapBps,pAbove:f.pAbove,pBelow:f.pBelow,pTouchStrike:f.pTouchStrike,pCrossStrike:f.pCrossStrike,pSettleOpposite:f.pSettleOpposite,pHardReverse:f.pHardReverse,reversalScore:f.reversalScore,reversal:f.reversal,move2:f.move2,move5:f.move5,move10:f.move10,move15:f.move15,move30:f.move30,move60:f.move60,sideMomentum:f.sideMomentum,adverse2:f.adverse2,adverse5:f.adverse5,adverse15:f.adverse15,dataQuality:f.dataQuality,activeSide:f.activeSide||'NONE'};
  const system='You are a BTC 15-minute event-contract copilot. You are a reasoning supervisor, not a probability generator. The backend calibrated probabilities and reversal module are authoritative. Your most important job is to audit reversal/touch/opposite risk. Never invent 99% certainty. Return only JSON.';
  const user={task:'Audit the calibrated candidate decision with special focus on reversal risk. Approve entry only if pTouchStrike/pCrossStrike/pSettleOpposite/pHardReverse and reversal.call genuinely support the side. Prefer SIT_OUT when flat and reversal risk is uncertain. If active position exists, choose HOLD_SIDE or EXIT_SIDE. No generic WAIT is allowed.',allowedCommands:[...COMMANDS],facts,candidate:{command:candidate.command,score:candidate.score,entryQuality:candidate.entryQuality,reason:candidate.reason},requiredJson:{approveCandidate:'boolean',preferredCommand:'one allowed command',riskLevel:'low|medium|high|critical',reason:'short practical reason',redFlags:['short strings']}};
  const ac=new AbortController(); const timer=setTimeout(()=>{try{ac.abort();}catch(_){}} , OPENAI_TIMEOUT_MS);
  try{
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:ac.signal,headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},body:JSON.stringify({model:OPENAI_MODEL,temperature:0.1,max_tokens:OPENAI_MAX_TOKENS,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:JSON.stringify(user)}]})});
    const txt=await r.text();
    if(!r.ok) return {ok:false,error:`OPENAI_${r.status}: ${txt.slice(0,180)}`};
    const j=JSON.parse(txt); const content=j?.choices?.[0]?.message?.content || '{}';
    return sanitizeAi(JSON.parse(content));
  } catch(e){ return {ok:false,error:String(e.message||e)}; }
  finally{ clearTimeout(timer); }
}

function finalDecisionFromAi(f,candidate,ai,session){
  let command=candidate.command;
  let source='CALIBRATED_BRAIN';
  let veto=candidate.veto;
  const active=f.activeSide;
  const aiOk=ai && ai.ok;
  const aiPref=aiOk?cleanCommand(ai.preferredCommand):'SIT_OUT';
  const aiType=commandType(aiPref);
  const candType=commandType(candidate.command);
  const candSide=sideFromCommand(candidate.command);
  const aiSide=sideFromCommand(aiPref);

  if(candType==='TRADE'){
    if(!aiOk){ command='SIT_OUT'; veto=ai?.error || 'NO_OPENAI_AUTHORITY'; source='NO_AI_NO_ENTRY'; }
    else if(!ai.approve || ai.riskLevel==='critical' || (aiType==='TRADE' && aiSide!==candSide) || aiType==='SIT_OUT') { command='SIT_OUT'; veto='AI_VETO'; source='AI_VETO'; }
    else { command=candidate.command; veto='NONE'; source='AI_APPROVED_ENTRY'; }
  } else if(active){
    if(aiOk && aiType==='EXIT' && aiSide===active) { command=`EXIT_${active}`; veto='AI_EXIT'; source='AI_ACTIVE_POSITION'; }
    else if(aiOk && aiType==='HOLD' && aiSide===active && candidate.command.startsWith('HOLD')) { command=`HOLD_${active}`; veto='NONE'; source='AI_ACTIVE_POSITION'; }
    else { command=candidate.command; source='POSITION_STATE_MACHINE'; }
  } else {
    command='SIT_OUT'; source=aiOk?'AI_OR_BRAIN_SIT_OUT':'NO_AI_SIT_OUT';
  }

  const prev=session.lastDecision;
  if(command==='SIT_OUT' && canKeepLockedTrade(prev,f)){
    command=prev.command; source='LOCKED_THESIS_REVALIDATED'; veto='NONE';
  }
  if(!COMMANDS.has(command)) command='SIT_OUT';
  const finiteProb=x=>(x===null||x===undefined||x==='')?0.5:(Number.isFinite(Number(x))?clamp(Number(x),0,1):0.5);
  const sideProb=finiteProb(f.pSide), touchProb=finiteProb(f.pTouchStrike), crossProb=finiteProb(f.pCrossStrike), hardProb=finiteProb(f.pHardReverse), oppProb=finiteProb(f.pSettleOpposite);
  let confidence;
  if(command.startsWith('TRADE') || command.startsWith('HOLD')) confidence=Math.min(sideProb, 1-Math.max(touchProb*0.55, crossProb*0.75, hardProb*0.85));
  else if(command.startsWith('EXIT')) confidence=Math.max(touchProb,crossProb,hardProb,oppProb);
  else confidence=Math.min(0.96, Math.max(0.50, 1-sideProb, touchProb, crossProb, hardProb, oppProb));
  return {ok:true,version:SERVER_VERSION,ts:Date.now(),command,side:sideFromCommand(command)||f.side,source,veto,confidence:round(confidence,4),confidencePct:pct(confidence),entryQuality:candidate.entryQuality,score:candidate.score,features:f,ai:aiOk?ai:{ok:false,error:ai?.error||'NO_OPENAI_AUTHORITY'},reason: command.startsWith('TRADE')?candidate.reason:(command.startsWith('HOLD')||command.startsWith('EXIT')?candidate.reason:(aiOk&&ai.reason?ai.reason:candidate.reason)),invalidation:candidate.invalidation};
}

async function decide(payload){
  const session=sessionFor(payload.sessionId || payload.session || 'default');
  const features=buildFeatures(payload);
  let candidate=candidateDecision(features);
  let ai=session.lastAi;
  const candidateKey=JSON.stringify({p:round(features.price,1),t:round(features.target,1),s:features.secondsLeft,side:features.side,cmd:candidate.command,active:features.activeSide||''});
  const reusableAi=ai && ai.key===candidateKey && Date.now()-ai.ts<AI_CACHE_MS;
  if(!reusableAi) {
    const aiResult=await callOpenAI(features,candidate);
    ai={...aiResult,key:candidateKey,ts:Date.now()};
    session.lastAi=ai;
  }
  const final=finalDecisionFromAi(features,candidate,ai,session);
  session.lastDecision=final;
  session.history.push({ts:final.ts,command:final.command,price:features.price,target:features.target,secondsLeft:features.secondsLeft,pAbove:features.pAbove,pBelow:features.pBelow,pTouchStrike:features.pTouchStrike,pCrossStrike:features.pCrossStrike,pSettleOpposite:features.pSettleOpposite,pHardReverse:features.pHardReverse,reversalCall:features.reversal&&features.reversal.call});
  if(session.history.length>500) session.history=session.history.slice(-500);
  return final;
}

function replay(logs){
  const rows=Array.isArray(logs)?logs:[];
  const trades=rows.filter(r=>String(r.command||'').startsWith('TRADE_') && (r.outcome==='ABOVE'||r.outcome==='BELOW'));
  let wins=0; const buckets={};
  for(const r of trades){ const side=sideFromCommand(r.command); const win=side===r.outcome; if(win) wins++; const k=r.secondsLeft>360?'early':r.secondsLeft>120?'mid':'late'; buckets[k] ||= {n:0,w:0}; buckets[k].n++; if(win)buckets[k].w++; }
  for(const k of Object.keys(buckets)) buckets[k].winRate=buckets[k].n?round(buckets[k].w/buckets[k].n,4):null;
  return {ok:true,totalRows:rows.length,trades:trades.length,wins,losses:trades.length-wins,winRate:trades.length?round(wins/trades.length,4):null,buckets,note:'Replay uses rows that include final outcome. Export logs from the frontend and mark final side for each window.'};
}

async function handleDecide(req,res){ try{ const body=await readBody(req); return send(res,200,await decide(body)); } catch(e){ return send(res,500,{ok:false,version:SERVER_VERSION,command:'SIT_OUT',veto:'SERVER_ERROR',error:String(e.message||e)}); }}
async function handleReplay(req,res){ try{ const body=await readBody(req,1000000); return send(res,200,replay(body.logs||body)); } catch(e){ return send(res,500,{ok:false,error:String(e.message||e)}); }}

function runSelfTests(){
  const base={sessionId:'test-'+Math.random(),market:{price:62000,priceTs:Date.now(),responseTs:Date.now(),confidence:92,spreadBps:2,venueCount:4,source:'test'},target:61950,timer:{secondsLeft:150},recentTape:[{ts:Date.now()-30000,price:61940},{ts:Date.now()-15000,price:61970},{ts:Date.now(),price:62000}]};
  const tests=[]; const add=(name,fn)=>{try{tests.push({name,pass:!!fn()});}catch(e){tests.push({name,pass:false,error:String(e.message||e)});}};
  add('commands enum has no WAIT',()=>!COMMANDS.has('WAIT')&&COMMANDS.has('SIT_OUT'));
  add('features valid',()=>{const f=buildFeatures(base); return f.side==='ABOVE'&&f.gapBps>0&&f.pAbove>0.5;});
  add('blank target blocks',()=>candidateDecision(buildFeatures({...base,target:''})).veto.includes('NO_TARGET'));
  add('stale market blocks',()=>candidateDecision(buildFeatures({...base,market:{...base.market,stale:true}})).veto.includes('STALE_MARKET_DATA'));
  add('no fake 99 cap',()=>{const f=buildFeatures({...base,market:{...base.market,price:62150},target:61950,timer:{secondsLeft:120},recentTape:[{ts:Date.now()-30000,price:62000},{ts:Date.now(),price:62150}]}); return f.pAbove<0.99 && f.pTouchStrike>=0.005;});
  add('reversal module present',()=>{const f=buildFeatures(base); return f.reversal && Number.isFinite(f.pCrossStrike) && Number.isFinite(f.pHardReverse) && typeof f.reversal.call==='string';});
  add('hard adverse reversal blocks entry',()=>{const t=Date.now(); const f=buildFeatures({...base,market:{...base.market,price:62004},target:61995,timer:{secondsLeft:55},recentTape:[{ts:t-30000,price:62075},{ts:t-15000,price:62050},{ts:t-5000,price:62020},{ts:t,price:62004}]}); const c=candidateDecision(f); return f.reversal.call!=='NONE' && c.command==='SIT_OUT';});
  add('active position exits on likely touch',()=>{const t=Date.now(); const f=buildFeatures({...base,activePosition:'ABOVE',market:{...base.market,price:62004},target:61995,timer:{secondsLeft:55},recentTape:[{ts:t-30000,price:62075},{ts:t-15000,price:62050},{ts:t-5000,price:62020},{ts:t,price:62004}]}); return candidateDecision(f).command==='EXIT_ABOVE';});
  add('active command explicit',()=>{const c=candidateDecision(buildFeatures({...base,activePosition:'ABOVE'})).command; return c==='HOLD_ABOVE'||c==='EXIT_ABOVE';});
  add('flat command explicit',()=>COMMANDS.has(candidateDecision(buildFeatures(base)).command));
  add('late opposite exits active',()=>{const f=buildFeatures({...base,market:{...base.market,price:61880},target:61950,activePosition:'ABOVE',timer:{secondsLeft:45}}); return candidateDecision(f).command==='EXIT_ABOVE';});
  add('replay computes wins',()=>replay([{command:'TRADE_ABOVE',outcome:'ABOVE',secondsLeft:60},{command:'TRADE_BELOW',outcome:'ABOVE',secondsLeft:60}]).wins===1);
  add('cleanCommand rejects garbage',()=>cleanCommand('WAIT')==='SIT_OUT'&&cleanCommand('trade above')==='TRADE_ABOVE');
  add('no openai flag prevents entry final',()=>{const s={lastDecision:null,lastAi:null,history:[]}; const f=buildFeatures(base); const cand={...candidateDecision(f),command:'TRADE_ABOVE'}; return finalDecisionFromAi(f,cand,{ok:false,error:'NO_OPENAI_AUTHORITY'},s).command==='SIT_OUT';});
  add('locked thesis can hold only if still valid',()=>{const s={lastDecision:{command:'TRADE_ABOVE',ts:Date.now()},lastAi:null,history:[]}; const f=buildFeatures(base); return finalDecisionFromAi(f,{...candidateDecision(f),command:'SIT_OUT'},{ok:true,approve:false,preferredCommand:'SIT_OUT'},s).command==='TRADE_ABOVE';});
  return tests;
}
function selftestSummary(){ const tests=runSelfTests(); const failed=tests.filter(t=>!t.pass); return {ok:failed.length===0,version:SERVER_VERSION,total:tests.length,passed:tests.length-failed.length,failed:failed.length,tests}; }

if(process.argv.includes('--selftest')){ const s=selftestSummary(); console.log(JSON.stringify(s,null,2)); process.exit(s.ok?0:1); }

const server=http.createServer(async(req,res)=>{
  try{
    cors(res);
    if(req.method==='OPTIONS') return res.end();
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(req.method==='GET' && (u.pathname==='/'||u.pathname==='/health')){ resetDailyIfNeeded(); return send(res,200,{ok:true,service:'btc-copilot-core-reversal',version:SERVER_VERSION,openaiEnabled:ENABLE_OPENAI&&!!OPENAI_API_KEY,model:OPENAI_MODEL,dayCalls,cap:AI_MAX_CALLS_PER_DAY,commands:[...COMMANDS],ts:Date.now()}); }
    if(req.method==='GET' && (u.pathname==='/market'||u.pathname==='/btc')) return send(res,200,await getMarket());
    if(req.method==='GET' && u.pathname==='/selftest') return send(res,200,selftestSummary());
    if(req.method==='POST' && (u.pathname==='/decide'||u.pathname==='/analyze'||u.pathname==='/ai-trader'||u.pathname==='/copilot/auto')) return handleDecide(req,res);
    if(req.method==='POST' && u.pathname==='/replay') return handleReplay(req,res);
    return send(res,404,{ok:false,error:'Not found',version:SERVER_VERSION});
  } catch(e){ return send(res,500,{ok:false,version:SERVER_VERSION,command:'SIT_OUT',veto:'SERVER_ERROR',error:String(e.message||e)}); }
});
server.listen(PORT,()=>console.log(`${SERVER_VERSION} listening on ${PORT}; openai=${ENABLE_OPENAI&&!!OPENAI_API_KEY}; model=${OPENAI_MODEL}`));
