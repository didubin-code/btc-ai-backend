/* =====================================================================
   BTC PIN RADAR — standalone late-window reversal early-warning server
   v1.5 (patched): resilient multi-venue price feed w/ logging + auto-recover;
   v1.4: (A) never fabricate 99σ on a missing tick — return null
   + STALE level; (B) server-side last-good-price hold (<=15s) so a single
   failed spot fetch doesn't blank the gap; (C) Coinbase-primary sentinel
   (Binance perp is geo-blocked from Render US) so the sentinel warms up.
   Fusion math is UNCHANGED from 1.3.
   ===================================================================== */
'use strict';
const http = require('http');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 10000);
const SERVER_VERSION = 'pin-radar-1.5';
const KALSHI_BASE = (process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/+$/,'');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENABLE_OPENAI = /^(0|false|no)$/i.test(process.env.ENABLE_OPENAI||'') ? false : (/^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI||'') || !!OPENAI_API_KEY);
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').replace('gpt-40','gpt-4o');
// PATCH C: sentinel source preference. 'coinbase' (default, US-reachable) or 'binance'.
const SENTINEL_PRIMARY = String(process.env.SENTINEL_PRIMARY || 'coinbase').toLowerCase();

/* ----------------------------- helpers ----------------------------- */
function clamp(x,lo,hi){const n=Number(x);return Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):lo;}
function round(x,d=4){const n=Number(x);return Number.isFinite(n)?Number(n.toFixed(d)):null;}
function erf(x){const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+0.3275911*x);const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);return s*y;}
function normCdf(x){return 0.5*(1+erf(x/Math.SQRT2));}
function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');res.setHeader('Cache-Control','no-store');}
function send(res,code,obj){cors(res);res.statusCode=code;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(obj));}
function readBody(req,limit=200000){return new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>limit){reject(new Error('too large'));req.destroy();}});req.on('end',()=>{if(!d)return resolve({});try{resolve(JSON.parse(d));}catch(e){reject(new Error('bad json'));}});req.on('error',reject);});}
async function fetchJson(url,opts={},timeoutMs=4000){
  const ac=new AbortController();const t=setTimeout(()=>{try{ac.abort();}catch(_){}} ,timeoutMs);
  try{const r=await fetch(url,{signal:ac.signal,headers:{accept:'application/json'},...opts});
    if(!r.ok)throw new Error('HTTP '+r.status);return await r.json();}
  finally{clearTimeout(t);}
}

/* ---------------------- spot flow (Coinbase/Binance) ---------------------- */
async function coinbaseFlow(){
  const [trades, book] = await Promise.all([
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=120').catch(()=>null),
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2').catch(()=>null)
  ]);
  let cvd=0, buyVol=0, sellVol=0, last=null;
  if(Array.isArray(trades)){
    for(const t of trades){
      const sz=Number(t.size)||0; last=Number(t.price)||last;
      if(t.side==='sell'){buyVol+=sz;cvd+=sz;} else if(t.side==='buy'){sellVol+=sz;cvd-=sz;}
    }
  }
  let bidDepth=0, askDepth=0, spread=null, mid=last;
  if(book&&Array.isArray(book.bids)&&Array.isArray(book.asks)){
    const bestBid=Number(book.bids[0]?.[0]), bestAsk=Number(book.asks[0]?.[0]);
    if(Number.isFinite(bestBid)&&Number.isFinite(bestAsk)){mid=(bestBid+bestAsk)/2;spread=bestAsk-bestBid;}
    const band=mid*0.0006;
    for(const b of book.bids){const p=Number(b[0]),s=Number(b[1]);if(mid-p<=band)bidDepth+=s;else break;}
    for(const a of book.asks){const p=Number(a[0]),s=Number(a[1]);if(p-mid<=band)askDepth+=s;else break;}
  }
  const totalVol=buyVol+sellVol;
  const flowImbalance = totalVol>0 ? (buyVol-sellVol)/totalVol : 0;
  const depthTotal=bidDepth+askDepth;
  const bookImbalance = depthTotal>0 ? (bidDepth-askDepth)/depthTotal : 0;
  return { ok:true, venue:'coinbase', last, mid, cvd:round(cvd,3), buyVol:round(buyVol,3), sellVol:round(sellVol,3),
    flowImbalance:round(flowImbalance,3), bookImbalance:round(bookImbalance,3),
    bidDepth:round(bidDepth,3), askDepth:round(askDepth,3), spread:round(spread,2) };
}
async function binanceFlow(){
  const [trades, book] = await Promise.all([
    fetchJson('https://api.binance.com/api/v3/aggTrades?symbol=BTCUSDT&limit=200').catch(()=>null),
    fetchJson('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=100').catch(()=>null)
  ]);
  let cvd=0,buyVol=0,sellVol=0,last=null;
  if(Array.isArray(trades)){
    for(const t of trades){
      const sz=Number(t.q)||0; last=Number(t.p)||last;
      if(t.m===false){buyVol+=sz;cvd+=sz;} else {sellVol+=sz;cvd-=sz;}
    }
  }
  let bidDepth=0,askDepth=0,spread=null,mid=last;
  if(book&&Array.isArray(book.bids)&&Array.isArray(book.asks)){
    const bestBid=Number(book.bids[0]?.[0]),bestAsk=Number(book.asks[0]?.[0]);
    if(Number.isFinite(bestBid)&&Number.isFinite(bestAsk)){mid=(bestBid+bestAsk)/2;spread=bestAsk-bestBid;}
    const band=mid*0.0006;
    for(const b of book.bids){const p=Number(b[0]),s=Number(b[1]);if(mid-p<=band)bidDepth+=s;else break;}
    for(const a of book.asks){const p=Number(a[0]),s=Number(a[1]);if(p-mid<=band)askDepth+=s;else break;}
  }
  const totalVol=buyVol+sellVol;
  return { ok:true, venue:'binance', last, mid, cvd:round(cvd,3), buyVol:round(buyVol,3), sellVol:round(sellVol,3),
    flowImbalance: totalVol>0?round((buyVol-sellVol)/totalVol,3):0,
    bookImbalance: (bidDepth+askDepth)>0?round((bidDepth-askDepth)/(bidDepth+askDepth),3):0,
    bidDepth:round(bidDepth,3), askDepth:round(askDepth,3), spread:round(spread,2) };
}
async function getSpotFlow(){
  const cb=await coinbaseFlow().catch(e=>({ok:false,error:String(e.message||e)}));
  if(cb.ok && Number.isFinite(cb.last)) return cb;
  console.error('[spotflow] coinbase unusable: '+(cb.error||'no last price'));
  const bn=await binanceFlow().catch(e=>({ok:false,error:String(e.message||e)}));
  if(bn.ok && Number.isFinite(bn.last)) return bn;
  console.error('[spotflow] binance unusable: '+(bn.error||'no last price'));
  return { ok:false, error:'no spot flow source reachable (cb: '+(cb.error||'no price')+'; bn: '+(bn.error||'no price')+')' };
}


/* ---------------------- price feed diagnostics + multi-venue fallback (v1.5) ---------------------- */
// Rolling diagnostics so failures are visible, not swallowed.
const FEED = {
  lastPrice:null, lastPriceTs:0, lastSource:null,
  consecutiveFails:0, totalFails:0, totalOk:0,
  lastError:null, lastErrorTs:0,
  recent:[]  // rolling [{ts, source, ok, ms, err}]
};
function feedLog(rec){
  FEED.recent.push(rec);
  if(FEED.recent.length>60) FEED.recent.shift();
  if(rec.ok){ FEED.totalOk++; FEED.consecutiveFails=0; FEED.lastSource=rec.source; }
  else { FEED.totalFails++; FEED.consecutiveFails++; FEED.lastError=rec.err||'unknown'; FEED.lastErrorTs=rec.ts; }
}
// Lightweight single-value price endpoints (fast, more reliable than full trades+book).
// Ordered by preference; each returns a finite number or throws with a reason.
const PRICE_VENUES = [
  { name:'coinbase', url:'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    pick:j=>Number(j && j.price) },
  { name:'binance', url:'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    pick:j=>Number(j && j.price) },
  { name:'kraken', url:'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    pick:j=>{ const r=j&&j.result; const k=r&&Object.keys(r)[0]; return Number(k && r[k] && r[k].c && r[k].c[0]); } },
  { name:'bitstamp', url:'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    pick:j=>Number(j && j.last) },
];
async function fetchPriceFrom(v, timeoutMs=3500){
  const t0=Date.now();
  try{
    const j=await fetchJson(v.url,{},timeoutMs);
    const p=v.pick(j);
    if(!Number.isFinite(p)||p<=0) throw new Error('bad/absent price field');
    feedLog({ts:Date.now(),source:v.name,ok:true,ms:Date.now()-t0});
    return {price:p, source:v.name};
  }catch(e){
    const reason=String(e && e.message || e);
    feedLog({ts:Date.now(),source:v.name,ok:false,ms:Date.now()-t0,err:reason});
    // Explicit, visible failure log (was silently swallowed before).
    console.error('[price] '+v.name+' FAIL ('+(Date.now()-t0)+'ms): '+reason);
    throw e;
  }
}
// Try venues in order; first finite price wins. Records every attempt.
async function getLivePrice(){
  const errors=[];
  for(const v of PRICE_VENUES){
    try{
      const r=await fetchPriceFrom(v);
      FEED.lastPrice=r.price; FEED.lastPriceTs=Date.now(); FEED.lastSource=r.source;
      return { ok:true, price:r.price, source:r.source, errors };
    }catch(e){ errors.push({venue:v.name, err:String(e && e.message || e)}); }
  }
  return { ok:false, price:null, source:null, errors };
}

/* ---------------------- Kalshi contract book ---------------------- */
let kalshiCache={t:0,key:'',data:null};
function parseStrike(m){
  for(const c of [m.floor_strike,m.cap_strike,m.strike]){const n=Number(c);if(Number.isFinite(n)&&n>0)return n;}
  const tail=String(m.ticker||'').split('-').pop()||'';const n=Number(tail.replace(/[^0-9.]/g,''));
  return Number.isFinite(n)&&n>0?n:NaN;
}
async function getKalshiContext(targetStrike){
  const key=String(Math.round(Number(targetStrike)||0));
  const now=Date.now();
  if(kalshiCache.data&&kalshiCache.key===key&&now-kalshiCache.t<2500)return kalshiCache.data;
  const nowSec=Math.floor(now/1000);
  const url=KALSHI_BASE+'/markets?status=open&limit=200&min_close_ts='+nowSec+'&max_close_ts='+(nowSec+20*60);
  const mj=await fetchJson(url).catch(e=>({error:String(e.message||e)}));
  const all=Array.isArray(mj.markets)?mj.markets:[];
  const btc=all.filter(m=>/BTC/i.test(String(m.ticker||'')+' '+String(m.title||'')));
  if(!btc.length) return {ok:false,error:'no open BTC markets in next 20min'};
  const tgt=Number(targetStrike);
  btc.sort((a,b)=>{const ca=Number(a.close_ts||0),cb=Number(b.close_ts||0);if(ca!==cb)return ca-cb;return Math.abs(parseStrike(a)-tgt)-Math.abs(parseStrike(b)-tgt);});
  const firstClose=Number(btc[0].close_ts||0);
  let win=btc.filter(m=>Number(m.close_ts||0)===firstClose);
  if(Number.isFinite(tgt))win.sort((a,b)=>Math.abs(parseStrike(a)-tgt)-Math.abs(parseStrike(b)-tgt));
  const mkt=win[0];
  let yes=[],no=[];
  try{
    const or_=await fetchJson(KALSHI_BASE+'/markets/'+encodeURIComponent(mkt.ticker)+'/orderbook?depth=20');
    const fp=or_&&or_.orderbook_fp, ob=fp||((or_&&or_.orderbook)||null);
    if(ob){
      const norm=a=>(Array.isArray(a)?a:[]).filter(x=>Array.isArray(x)&&x.length>=2)
        .map(x=>[Number(x[0])*(fp?100:1),Number(x[1])])
        .filter(x=>Number.isFinite(x[0])&&x[0]>0&&x[0]<100&&Number.isFinite(x[1]));
      yes=norm(fp?ob.yes_dollars:ob.yes);
      no=norm(fp?ob.no_dollars:ob.no);
    }
  }catch(_){}
  const yesDepth=yes.reduce((a,x)=>a+(Number(x[1])||0),0);
  const noDepth=no.reduce((a,x)=>a+(Number(x[1])||0),0);
  const bestYes=yes.length?Math.max(...yes.map(x=>Number(x[0]))):Number(mkt.yes_bid);
  const bestNo=no.length?Math.max(...no.map(x=>Number(x[0]))):(Number.isFinite(Number(mkt.yes_ask))?100-Number(mkt.yes_ask):NaN);
  const yesBid=Number.isFinite(bestYes)?bestYes:Number(mkt.yes_bid);
  const yesAsk=Number.isFinite(bestNo)?100-bestNo:Number(mkt.yes_ask);
  const implied=(Number.isFinite(yesBid)&&Number.isFinite(yesAsk))?(yesBid+yesAsk)/200:NaN;
  const bookImbalance=(yesDepth+noDepth)>0?(yesDepth-noDepth)/(yesDepth+noDepth):0;
  const data={ok:true,ticker:mkt.ticker,title:mkt.title||'',strike:parseStrike(mkt),closeTs:firstClose,
    yesBid,yesAsk,impliedAbove:Number.isFinite(implied)?round(implied,3):null,
    yesDepth:round(yesDepth,0),noDepth:round(noDepth,0),bookImbalance:round(bookImbalance,3),t:now};
  kalshiCache={t:now,key,data};return data;
}

/* ==================== UPSTREAM SENTINEL ==================== */
function ewmaZ(alpha){let m=null,v=null;return{update(x){if(m===null){m=x;v=1e-9;return 0;}const d=x-m;m+=alpha*d;v=(1-alpha)*(v+alpha*d*d);return d/Math.sqrt(Math.max(v,1e-9));}};}
const zToScore=z=>clamp(z/3.5,-1,1)*100;
const SENT={
  started:false, timer:null, lastOkPoll:0, lastErr:null, lastAggId:null,
  trades:[], depthHist:[],
  curDepth:{bid:0,ask:0}, perpMid:null, spotMid:null, basisEwma:null,
  z:{div:ewmaZ(0.03), burst:ewmaZ(0.03), basis:ewmaZ(0.03)},
  read:{ok:false,error:'warming up'}, venue:null, failN:0
};
function sentPrune(now){
  const cutT=now-90000; while(SENT.trades.length&&SENT.trades[0][0]<cutT)SENT.trades.shift();
  const cutD=now-300000; while(SENT.depthHist.length&&SENT.depthHist[0][0]<cutD)SENT.depthHist.shift();
}
function sentCompute(){
  const now=Date.now(); sentPrune(now);
  if(SENT.trades.length<10||SENT.depthHist.length<8||!Number.isFinite(SENT.perpMid))
    return {ok:false,error:'warming up',ageSec:round((now-SENT.lastOkPoll)/1000,0)};
  let netFlow=0; for(const t of SENT.trades)netFlow+=t[1];
  const p0=SENT.trades[0][2], p1=SENT.trades[SENT.trades.length-1][2];
  const dPxPct=(p1-p0)/p0;
  const div=netFlow/1e6 - dPxPct*20000;
  const cvdDiv=zToScore(SENT.z.div.update(div));
  let burst30=0; const cut30=now-30000;
  for(let i=SENT.trades.length-1;i>=0&&SENT.trades[i][0]>=cut30;i--)burst30+=SENT.trades[i][1];
  const burst=zToScore(SENT.z.burst.update(burst30/1e6));
  const med=a=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)]||1e-6;};
  const bidRatio=SENT.curDepth.bid/Math.max(med(SENT.depthHist.map(d=>d[1])),1e-6);
  const askRatio=SENT.curDepth.ask/Math.max(med(SENT.depthHist.map(d=>d[2])),1e-6);
  const bookPull=clamp((bidRatio-askRatio)*100,-100,100);
  let basisScore=0, basis=null;
  if(Number.isFinite(SENT.spotMid)){
    basis=SENT.perpMid-SENT.spotMid;
    if(SENT.basisEwma===null)SENT.basisEwma=basis;
    SENT.basisEwma+=0.05*(basis-SENT.basisEwma);
    basisScore=zToScore(SENT.z.basis.update(basis-SENT.basisEwma));
  }
  const pressure=clamp(0.35*cvdDiv+0.20*burst+0.30*bookPull+0.15*basisScore,-100,100);
  const stale=(now-SENT.lastOkPoll)>12000;
  return {ok:!stale, error:stale?'stale feed':null, pressure:Math.round(pressure),
    components:{cvdDiv:Math.round(cvdDiv),burst:Math.round(burst),bookPull:Math.round(bookPull),basis:Math.round(basisScore)},
    basisUsd:basis==null?null:round(basis,2), perpMid:round(SENT.perpMid,2), spotMid:round(SENT.spotMid,2),
    ageSec:round((now-SENT.lastOkPoll)/1000,0)};
}
// PATCH C: Coinbase-primary sentinel poll (Binance perp geo-blocked from Render US).
async function sentPollCoinbase(now){
  let any=false;
  if(SENT.venue!=='coinbase-spot'){SENT.lastAggId=null;SENT.trades.length=0;SENT.venue='coinbase-spot';}
  const [trades,book]=await Promise.all([
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=100',{},3500).catch(()=>null),
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/book?level=2',{},3500).catch(()=>null)
  ]);
  if(Array.isArray(trades)){
    for(const t of trades){
      const p=Number(t.price),q=Number(t.size),id=Number(t.trade_id);
      if(!Number.isFinite(p)||!Number.isFinite(q))continue;
      if(SENT.lastAggId&&Number.isFinite(id)&&id<=SENT.lastAggId)continue;
      SENT.trades.push([Date.parse(t.time)||now,(t.side==='sell'?1:-1)*p*q,p]);
      if(Number.isFinite(id))SENT.lastAggId=Math.max(SENT.lastAggId||0,id);
    }
    any=true;
  }
  if(book&&Array.isArray(book.bids)&&Array.isArray(book.asks)){
    const bb=Number((book.bids[0]||[])[0]),ba=Number((book.asks[0]||[])[0]);
    if(Number.isFinite(bb)&&Number.isFinite(ba)){
      const mid=(bb+ba)/2,band=mid*0.0006;let bd=0,ad=0;
      for(const b of book.bids){const p=Number(b[0]),sz=Number(b[1]);if(mid-p<=band)bd+=sz;else break;}
      for(const a of book.asks){const p=Number(a[0]),sz=Number(a[1]);if(p-mid<=band)ad+=sz;else break;}
      SENT.curDepth={bid:bd,ask:ad};
      SENT.depthHist.push([now,bd,ad]);
      SENT.perpMid=mid;SENT.spotMid=mid;any=true;
    }
  }
  return any;
}
async function sentPollBinance(now){
  let any=false;
  const aggUrl='https://fapi.binance.com/fapi/v1/aggTrades?symbol=BTCUSDT'+(SENT.lastAggId?('&fromId='+(SENT.lastAggId+1)+'&limit=500'):'&limit=300');
  const [trades,depth,perpBT,spotBT]=await Promise.all([
    fetchJson(aggUrl,{},3500).catch(()=>null),
    fetchJson('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=10',{},3500).catch(()=>null),
    fetchJson('https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=BTCUSDT',{},3500).catch(()=>null),
    fetchJson('https://api.binance.com/api/v3/ticker/bookTicker?symbol=BTCUSDT',{},3500).catch(()=>null)
  ]);
  if(Array.isArray(trades)){
    for(const t of trades){
      const p=Number(t.p),q=Number(t.q);if(!Number.isFinite(p)||!Number.isFinite(q))continue;
      SENT.trades.push([Number(t.T)||now,(t.m?-1:1)*p*q,p]);
      SENT.lastAggId=Math.max(SENT.lastAggId||0,Number(t.a)||0);
    }
    any=true;
  }
  if(depth&&Array.isArray(depth.bids)&&Array.isArray(depth.asks)){
    const sum=s=>s.reduce((a,x)=>a+(Number(x[1])||0),0);
    SENT.curDepth={bid:sum(depth.bids),ask:sum(depth.asks)};
    SENT.depthHist.push([now,SENT.curDepth.bid,SENT.curDepth.ask]);
    any=true;
  }
  if(perpBT&&perpBT.bidPrice&&perpBT.askPrice)SENT.perpMid=(Number(perpBT.bidPrice)+Number(perpBT.askPrice))/2;
  if(spotBT&&spotBT.bidPrice&&spotBT.askPrice)SENT.spotMid=(Number(spotBT.bidPrice)+Number(spotBT.askPrice))/2;
  if(any)SENT.venue='binance-perp';
  return any;
}
async function sentPoll(){
  const now=Date.now();
  let any=false;
  try{
    if(SENTINEL_PRIMARY==='binance'){
      // legacy behavior: try binance, fall back to coinbase on repeated failure
      if((SENT.failN||0)<3){ any=await sentPollBinance(now); if(any)SENT.failN=0; else SENT.failN=(SENT.failN||0)+1; }
      if(!any&&(SENT.failN||0)>=3){ any=await sentPollCoinbase(now); }
    } else {
      // PATCH C default: Coinbase primary — US-reachable, actually warms.
      any=await sentPollCoinbase(now);
    }
    if(any)SENT.lastOkPoll=now;
    SENT.lastErr=null;
  }catch(e){SENT.lastErr=String(e.message||e);}
  SENT.read=sentCompute();
  if(SENT.read)SENT.read.venue=SENT.venue||null;
}
function ensureSentinel(){
  if(SENT.started)return;
  SENT.started=true;
  sentPoll();
  SENT.timer=setInterval(sentPoll,2500);
  if(SENT.timer.unref)SENT.timer.unref();
}

/* ---------------------- pin geometry + fusion ---------------------- */
function volFromTape(tape){
  if(!Array.isArray(tape)||tape.length<8)return 0.45;
  const rets=[];
  for(let i=1;i<tape.length;i++){
    const dt=Math.max(0.5,(tape[i].ts-tape[i-1].ts)/1000);
    const r=(tape[i].price-tape[i-1].price)/tape[i-1].price*1e4/Math.sqrt(dt);
    if(Number.isFinite(r))rets.push(r);
  }
  if(rets.length<4)return 0.45;
  const m=rets.reduce((a,b)=>a+b,0)/rets.length;
  const v=Math.sqrt(rets.reduce((a,b)=>a+(b-m)*(b-m),0)/(rets.length-1));
  return clamp(v,0.12,4);
}
function driftFromTape(tape){
  if(!Array.isArray(tape)||tape.length<6)return 0;
  const recent=tape.slice(-Math.min(tape.length,90));
  const HL=25;let num=0,den=0;const now=recent[recent.length-1].ts;
  for(let i=1;i<recent.length;i++){
    const dt=Math.max(0.5,(recent[i].ts-recent[i-1].ts)/1000);
    const r=(recent[i].price-recent[i-1].price)/recent[i-1].price*1e4/dt;
    const age=(now-recent[i].ts)/1000;const w=Math.pow(0.5,age/HL);
    if(Number.isFinite(r)){num+=w*r;den+=w;}
  }
  return den?clamp(num/den,-3,3):0;
}
function computePinPressure(input){
  const { price, strike, secondsLeft, side, spotFlow, kalshi, tape, sentinel } = input;
  const gapUsd = Number.isFinite(price)&&Number.isFinite(strike) ? price-strike : NaN;
  const gapBps = Number.isFinite(gapUsd)&&price ? (gapUsd/price)*1e4 : NaN;
  // PATCH A: know whether we actually have geometry this tick.
  const haveGeometry = Number.isFinite(gapBps);
  const naturalSide = haveGeometry ? (gapBps>=0?'ABOVE':'BELOW') : null;
  const mySide = side || naturalSide;
  const sideSign = mySide==='ABOVE'?1:-1;
  const time=Math.max(1,secondsLeft);
  const vol=volFromTape(tape);
  const drift=driftFromTape(tape);

  const sigma=Math.max(0.45, vol*Math.sqrt(time));
  // PATCH A: null (not 99) when geometry is missing.
  const sigmasOfCushion = haveGeometry ? Math.abs(gapBps)/sigma : null;
  const adverseDriftPerSec = -sideSign*(Number.isFinite(drift)?drift:0);
  const projectedAdverseBps = adverseDriftPerSec*time;
  const zCross = haveGeometry ? (Math.abs(gapBps)-Math.max(0,projectedAdverseBps))/sigma : NaN;
  const pCross = clamp(Number.isFinite(zCross)? (1-normCdf(zCross)) : 0.02, 0.002, 0.97);

  let flowScore=0, flowNote='no flow data';
  if(spotFlow&&spotFlow.ok){
    const towardStrikeFlow = -sideSign*(spotFlow.flowImbalance||0);
    const towardStrikeBook = -sideSign*(spotFlow.bookImbalance||0);
    flowScore = clamp(towardStrikeFlow*46 + towardStrikeBook*20, -40, 66);
    flowNote = `flow ${spotFlow.flowImbalance>0?'+':''}${spotFlow.flowImbalance} (${towardStrikeFlow>0.12?'toward strike':towardStrikeFlow<-0.12?'away':'neutral'}), book ${spotFlow.bookImbalance}`;
  }

  let kalshiScore=0, kalshiNote='no kalshi book';
  if(kalshi&&kalshi.ok){
    const towardStrikeK = sideSign>0 ? -(kalshi.bookImbalance||0) : (kalshi.bookImbalance||0);
    kalshiScore = clamp(towardStrikeK*30, -20, 34);
    kalshiNote = `kalshi resting ${kalshi.bookImbalance>0?'YES/above':'NO/below'}-heavy (${kalshi.bookImbalance})`;
  }

  let sentScore=0, sentNote='no sentinel data';
  if(sentinel&&sentinel.ok&&Number.isFinite(sentinel.pressure)){
    const towardStrikeS = -sideSign*(sentinel.pressure/100);
    sentScore = clamp(towardStrikeS*62, -35, 62);
    sentNote = `perp pressure ${sentinel.pressure>0?'+':''}${sentinel.pressure} (${towardStrikeS>0.2?'toward strike':towardStrikeS<-0.2?'away':'neutral'})`;
  }

  const lateWeight = clamp((240-secondsLeft)/240, 0, 1);
  // PATCH A: thinCushion only when we have geometry (else 0, no fake magnet).
  const thinCushion = haveGeometry ? clamp((1.6-sigmasOfCushion)*1.0, 0, 1.6) : 0;

  const geometryScore = clamp(pCross*70 + thinCushion*22, 0, 92);
  const raw = geometryScore*(0.55+0.45*lateWeight) + Math.max(0,flowScore)*(0.45+0.65*lateWeight) + Math.max(0,kalshiScore)*(0.5+0.6*lateWeight) + Math.max(0,sentScore)*(0.5+0.7*lateWeight);
  const lateFlowFloor = (secondsLeft<=120 && flowScore>=28) ? clamp(28 + (flowScore-28)*0.9 + Math.max(0,kalshiScore)*0.5, 0, 62) : 0;
  const lateSentFloor = (secondsLeft<=180 && sentScore>=30) ? clamp(30 + (sentScore-30)*1.0 + Math.max(0,flowScore)*0.4, 0, 70) : 0;
  const pinPressure = clamp(Math.round(Math.max(raw, lateFlowFloor, lateSentFloor)), 0, 100);

  let etaSec=null;
  if(adverseDriftPerSec>0.003 && haveGeometry && Math.abs(gapBps)>0){
    etaSec = Math.round(Math.abs(gapBps)/adverseDriftPerSec);
    if(etaSec>secondsLeft) etaSec=null;
  }

  // PATCH A: STALE overrides level/verdict when we had no price/strike this tick.
  const stale = !Number.isFinite(price) || !Number.isFinite(strike);
  let level, verdict;
  if(stale){ level='STALE'; verdict='NO DATA'; }
  else if(pinPressure>=66){level='RED';verdict='CROSS LIKELY';}
  else if(pinPressure>=40){level='AMBER';verdict='ELEVATED';}
  else if(pinPressure>=22){level='YELLOW';verdict='WATCH';}
  else {level='GREEN';verdict='CLEAR';}

  const reasons=[];
  if(stale){
    reasons.push('no live price/strike this tick — reading held/stale');
  } else {
    if(sigmasOfCushion!=null && sigmasOfCushion<1.2) reasons.push(`thin cushion: ${sigmasOfCushion.toFixed(2)} sigma to strike`);
    if(projectedAdverseBps>Math.abs(gapBps)*0.5&&adverseDriftPerSec>0.003) reasons.push(`drift projects ${projectedAdverseBps.toFixed(1)}bps toward strike`);
    if(flowScore>18) reasons.push('aggressive spot flow toward strike');
    if(sentScore>20) reasons.push('upstream perp flow building toward strike (leads spot)');
    if(kalshiScore>14) reasons.push('kalshi book leaning against your side');
    if(secondsLeft<=120&&sigmasOfCushion!=null&&sigmasOfCushion<1.6) reasons.push('final 2 minutes, near strike');
    if(!reasons.length) reasons.push(secondsLeft>240?'outside danger window':'cushion healthy');
  }

  return {
    pinPressure: stale?0:pinPressure, level, verdict, stale,
    gapUsd:round(gapUsd,2), gapBps:round(gapBps,2), mySide, naturalSide,
    secondsLeft, sigmasOfCushion: sigmasOfCushion==null?null:round(sigmasOfCushion,2),
    pCrossBeforeExpiry:round(pCross,3), projectedAdverseBps:round(projectedAdverseBps,2),
    etaTouchSec:etaSec, drift:round(drift,4), vol:round(vol,3),
    components:{ geometry:round(geometryScore,1), flow:round(flowScore,1), kalshi:round(kalshiScore,1), sentinel:round(sentScore,1), lateWeight:round(lateWeight,2) },
    notes:{ flow:flowNote, kalshi:kalshiNote, sentinel:sentNote },
    reasons
  };
}

/* ---------------------- optional OpenAI plain-English read ---------------------- */
async function aiRead(pin, evidence){
  if(!ENABLE_OPENAI||!OPENAI_API_KEY) return null;
  const ac=new AbortController();const t=setTimeout(()=>{try{ac.abort();}catch(_){}} ,6000);
  try{
    const sys='You are a terse trading-desk risk assistant watching for late-window BTC option pin/gamma reversals. Given a computed pin-pressure snapshot, write ONE short sentence (max 24 words) telling the trader plainly whether a reversal across the strike is brewing and why. No preamble. No JSON.';
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',signal:ac.signal,
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${OPENAI_API_KEY}`},
      body:JSON.stringify({model:OPENAI_MODEL,temperature:0.2,max_tokens:80,
        messages:[{role:'system',content:sys},{role:'user',content:JSON.stringify({pin,evidence})}]})});
    if(!r.ok)return null;const j=await r.json();return (j?.choices?.[0]?.message?.content||'').trim().slice(0,180);
  }catch(_){return null;}finally{clearTimeout(t);}
}

/* ---------------------- main radar endpoint ---------------------- */
// PATCH B: server-side last-good-price hold.
let lastGoodPrice=null, lastGoodPriceTs=0;
const PRICE_HOLD_MS = Number(process.env.PRICE_HOLD_MS || 15000);

async function radar(payload){
  ensureSentinel();
  const strike=Number(payload.target);
  const secondsLeft=Math.max(0,Math.floor(Number(payload?.timer?.secondsLeft ?? payload.secondsLeft ?? 900)));
  const side=payload.activePosition||null;
  const tape=Array.isArray(payload.recentTape)?payload.recentTape:[];
  const wantAi = payload.ai!==false;

  const [spotFlow, kalshi] = await Promise.all([
    getSpotFlow().catch(e=>({ok:false,error:String(e.message||e)})),
    Number.isFinite(strike)?getKalshiContext(strike).catch(e=>({ok:false,error:String(e.message||e)})):Promise.resolve({ok:false,error:'no strike'})
  ]);
  const sentinel = SENT.read || {ok:false,error:'not started'};

  // Price resolution, most-authoritative first:
  //   1) client override  2) full spot-flow mid/last  3) multi-venue live price (v1.5)
  //   4) held last-good (<=PRICE_HOLD_MS)  -> else STALE
  let price=Number(payload?.market?.price);
  let priceSource = Number.isFinite(price) ? 'override' : null;
  if(!Number.isFinite(price)){
    const sf=Number(spotFlow.mid ?? spotFlow.last);
    if(Number.isFinite(sf)){ price=sf; priceSource=spotFlow.venue||'spotflow'; }
  }
  let priceErrors=null;
  if(!Number.isFinite(price)){
    // (3) FALLBACK LIVE PRICE — one Coinbase failure no longer makes us stale.
    const lp=await getLivePrice();
    if(lp.ok){ price=lp.price; priceSource=lp.source; }
    priceErrors=lp.errors&&lp.errors.length?lp.errors:null;
  }
  // PATCH B: hold last good price up to PRICE_HOLD_MS so a single failed fetch doesn't blank the gap.
  let priceHeld=false;
  if(Number.isFinite(price)){ lastGoodPrice=price; lastGoodPriceTs=Date.now(); FEED.lastPrice=price; FEED.lastPriceTs=Date.now(); if(priceSource)FEED.lastSource=priceSource; }
  else if(Number.isFinite(lastGoodPrice) && (Date.now()-lastGoodPriceTs)<PRICE_HOLD_MS){ price=lastGoodPrice; priceHeld=true; priceSource='held'; }

  const pin=computePinPressure({ price, strike, secondsLeft, side, spotFlow, kalshi, tape, sentinel });

  let ai=null;
  if(wantAi && (pin.level==='AMBER'||pin.level==='RED')) {
    ai=await aiRead(
      {pinPressure:pin.pinPressure,level:pin.level,verdict:pin.verdict,reasons:pin.reasons},
      {gapBps:pin.gapBps,secondsLeft,sigmas:pin.sigmasOfCushion,flow:pin.notes.flow,kalshi:pin.notes.kalshi,sentinel:pin.notes.sentinel,eta:pin.etaTouchSec}
    );
  }

  return {
    ok:true, version:SERVER_VERSION, ts:Date.now(),
    price:round(price,2), strike:Number.isFinite(strike)?strike:null, secondsLeft,
    priceHeld, priceSource, priceErrors,
    feed:{ lastSource:FEED.lastSource, consecutiveFails:FEED.consecutiveFails, lastError:FEED.lastError,
           ageMs:FEED.lastPriceTs?Date.now()-FEED.lastPriceTs:null },
    ...pin, ai,
    sources:{ spotFlow: spotFlow.ok?spotFlow.venue:('offline: '+(spotFlow.error||'?')),
              kalshi: kalshi.ok?kalshi.ticker:('offline: '+(kalshi.error||'?')),
              sentinel: sentinel.ok?(SENT.venue||'live'):('offline: '+(sentinel.error||'?')) },
    spotFlow: spotFlow.ok?spotFlow:null,
    kalshi: kalshi.ok?kalshi:null,
    sentinel: sentinel.ok?sentinel:null
  };
}

/* ---------------------- self-test ---------------------- */
function mkTape(fn,n=90,step=1000){const now=Date.now();const t=[];for(let i=0;i<n;i++)t.push({ts:now-(n-1-i)*step,price:fn(i)});return t;}
function runSelfTest(){
  const checks=[];
  const strike=62050;
  const grindTape=mkTape(i=>61995+40*(i/89));
  const a=computePinPressure({price:62035,strike,secondsLeft:45,side:'BELOW',
    spotFlow:{ok:true,flowImbalance:0.4,bookImbalance:0.2,venue:'test',last:62035},
    kalshi:{ok:true,bookImbalance:0.5},tape:grindTape});
  checks.push({name:'grind-to-strike late -> RED/AMBER',pass:['RED','AMBER'].includes(a.level),got:a.level+' '+a.pinPressure});
  checks.push({name:'grind -> high cross prob',pass:a.pCrossBeforeExpiry>0.3,got:a.pCrossBeforeExpiry});
  const flatTape=mkTape(()=>61930);
  const b=computePinPressure({price:61930,strike,secondsLeft:400,side:'BELOW',
    spotFlow:{ok:true,flowImbalance:0,bookImbalance:0,venue:'test',last:61930},kalshi:{ok:false},tape:flatTape});
  checks.push({name:'flat far-from-strike -> GREEN',pass:b.level==='GREEN',got:b.level+' '+b.pinPressure});
  const awayTape=mkTape(i=>62010-30*(i/89));
  const c=computePinPressure({price:61980,strike,secondsLeft:45,side:'BELOW',
    spotFlow:{ok:true,flowImbalance:-0.3,bookImbalance:-0.2,venue:'test',last:61980},kalshi:{ok:false},tape:awayTape});
  checks.push({name:'moving away late -> not RED',pass:c.level!=='RED',got:c.level+' '+c.pinPressure});
  const base={price:62030,strike,secondsLeft:90,side:'BELOW',kalshi:{ok:false},tape:mkTape(i=>62000+30*(i/89))};
  const neutral=computePinPressure({...base,spotFlow:{ok:true,flowImbalance:0,bookImbalance:0,venue:'t',last:62030}});
  const adverse=computePinPressure({...base,spotFlow:{ok:true,flowImbalance:0.6,bookImbalance:0.4,venue:'t',last:62030}});
  checks.push({name:'adverse spot flow raises pressure',pass:adverse.pinPressure>neutral.pinPressure,got:neutral.pinPressure+' < '+adverse.pinPressure});
  checks.push({name:'ETA present on adverse grind',pass:Number.isFinite(a.etaTouchSec),got:a.etaTouchSec});
  const down=computePinPressure({price:62065,strike,secondsLeft:45,side:'ABOVE',
    spotFlow:{ok:true,flowImbalance:-0.4,bookImbalance:-0.2,venue:'t',last:62065},kalshi:{ok:true,bookImbalance:-0.5},tape:mkTape(i=>62105-40*(i/89))});
  checks.push({name:'symmetric ABOVE-grind-down -> elevated',pass:['RED','AMBER'].includes(down.level),got:down.level+' '+down.pinPressure});
  const gBase={price:62030,strike,secondsLeft:90,side:'BELOW',kalshi:{ok:false},tape:mkTape(i=>62000+30*(i/89)),
    spotFlow:{ok:true,flowImbalance:0,bookImbalance:0,venue:'t',last:62030}};
  const noSent=computePinPressure({...gBase});
  const withSent=computePinPressure({...gBase,sentinel:{ok:true,pressure:70}});
  checks.push({name:'adverse sentinel raises pressure',pass:withSent.pinPressure>noSent.pinPressure,got:noSent.pinPressure+' < '+withSent.pinPressure});
  const h=computePinPressure({price:62160,strike,secondsLeft:150,side:'ABOVE',
    spotFlow:{ok:true,flowImbalance:0,bookImbalance:0,venue:'t',last:62160},kalshi:{ok:false},
    tape:mkTape(()=>62160),sentinel:{ok:true,pressure:-70}});
  checks.push({name:'sentinel fires before price moves (floor)',pass:h.level!=='GREEN',got:h.level+' '+h.pinPressure});
  const failed=checks.filter(c=>!c.pass);
  return {ok:failed.length===0,version:SERVER_VERSION,passed:checks.length-failed.length,total:checks.length,checks};
}

/* ---------------------- HTTP ---------------------- */
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,`http://${req.headers.host}`);
  if(req.method==='OPTIONS'){cors(res);res.statusCode=204;return res.end();}
  try{
    if(req.method==='GET'&&u.pathname==='/health'){
      ensureSentinel();
      return send(res,200,{ok:true,version:SERVER_VERSION,service:'btc-pin-radar',openaiEnabled:ENABLE_OPENAI,model:OPENAI_MODEL,
        sentinel:(SENT.read&&SENT.read.ok)?'live':'warming/offline',sentinelVenue:SENT.venue||null,
        feed:{ lastSource:FEED.lastSource, lastPriceAgeMs:FEED.lastPriceTs?Date.now()-FEED.lastPriceTs:null,
               consecutiveFails:FEED.consecutiveFails, totalOk:FEED.totalOk, totalFails:FEED.totalFails,
               lastError:FEED.lastError, lastErrorAgeMs:FEED.lastErrorTs?Date.now()-FEED.lastErrorTs:null },
        ts:Date.now()});
    }
    if(req.method==='GET'&&u.pathname==='/selftest'){const r=runSelfTest();return send(res,r.ok?200:500,r);}
    if(req.method==='GET'&&u.pathname==='/flow'){const f=await getSpotFlow();return send(res,200,{...f,version:SERVER_VERSION});}
    if(req.method==='GET'&&u.pathname==='/sentinel'){ensureSentinel();return send(res,200,{...(SENT.read||{ok:false}),lastErr:SENT.lastErr,version:SERVER_VERSION});}
    if(req.method==='GET'&&u.pathname==='/diag'){return send(res,200,{ok:true,version:SERVER_VERSION,ts:Date.now(),
      feed:{lastSource:FEED.lastSource,lastPrice:FEED.lastPrice,lastPriceAgeMs:FEED.lastPriceTs?Date.now()-FEED.lastPriceTs:null,
            consecutiveFails:FEED.consecutiveFails,totalOk:FEED.totalOk,totalFails:FEED.totalFails,
            lastError:FEED.lastError,lastErrorAgeMs:FEED.lastErrorTs?Date.now()-FEED.lastErrorTs:null,
            recent:FEED.recent.slice(-30)},
      sentinel:{venue:SENT.venue,ok:!!(SENT.read&&SENT.read.ok),err:SENT.lastErr}});}
    if(req.method==='POST'&&(u.pathname==='/radar'||u.pathname==='/pin')){
      const body=await readBody(req);const out=await radar(body);return send(res,200,out);
    }
    return send(res,404,{ok:false,error:'NOT_FOUND',path:u.pathname});
  }catch(e){return send(res,500,{ok:false,error:String(e.message||e)});}
});
if(require.main===module){server.listen(PORT,()=>console.log(`btc-pin-radar ${SERVER_VERSION} on ${PORT}, openai=${ENABLE_OPENAI}, sentinel=${SENTINEL_PRIMARY}`));ensureSentinel();}
module.exports={ computePinPressure, getSpotFlow, getKalshiContext, radar, runSelfTest, volFromTape, driftFromTape, sentCompute, ensureSentinel, getLivePrice };
