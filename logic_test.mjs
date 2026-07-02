import fs from 'fs';
import vm from 'vm';
const src = fs.readFileSync('./server.js','utf8');
const start = src.indexOf('const finite');
const end = src.indexOf('function buildRawFallbackAi');
if (start < 0 || end < 0) throw new Error('extract markers missing');
const logic = src.slice(start, end) + `\nthis.normalizeSnapshot = normalizeSnapshot; this.computeRawIndependentModel = computeRawIndependentModel;`;
const ctx = { console, Math, Number, String, Date, Array, Boolean, RegExp, JSON, isFinite };
vm.createContext(ctx);
vm.runInContext(logic, ctx);
function recent(nowPrice=100000){
  const now = Date.now();
  const arr=[];
  for(let i=60;i>=0;i-=10){ arr.push({t:i,p:nowPrice-(i*0.5)}); }
  return arr;
}
const base={
  version:'test', ts:new Date().toISOString(),
  timer:{minutesLeft:5}, setup:{target:99900, upCost:.60, downCost:.40}, live:{price:100000, age:'1200 ms'},
  rawMarket:{recentSeries:recent(), consensus:{price:100000, ageMs:1200, count:3, quoted:3, ok:true}, venues:[
    {name:'Coinbase WS', price:100000, mid:100000, spreadBps:1, ageMs:1000},
    {name:'Kraken WS', price:100002, mid:100002, spreadBps:1, ageMs:1100},
    {name:'Bitstamp WS', price:99999, mid:99999, spreadBps:1, ageMs:900}
  ]},
  engineRead:{trade:'WAIT', chanceUp:'70%', chanceDown:'30%'}
};
const strict=ctx.normalizeSnapshot(base);
if(strict.independentFeatures.dataTier!=='LIVE_STRICT') throw new Error('strict tier failed: '+strict.independentFeatures.dataTier);
if(strict.rawIndependentModel.decision==='FIX_DATA') throw new Error('strict produced FIX_DATA');
const soft=JSON.parse(JSON.stringify(base));
soft.rawMarket.venues.forEach((v,i)=>v.ageMs=5000+i*200);
const softSnap=ctx.normalizeSnapshot(soft);
if(softSnap.independentFeatures.dataTier!=='LIVE_SOFT') throw new Error('soft tier failed: '+softSnap.independentFeatures.dataTier);
if(softSnap.rawIndependentModel.decision==='FIX_DATA') throw new Error('soft produced FIX_DATA');
const seriesOnly=JSON.parse(JSON.stringify(base));
seriesOnly.rawMarket.venues=[];
seriesOnly.rawMarket.consensus={price:100000, ageMs:9000, count:0, quoted:0, ok:false};
const seriesSnap=ctx.normalizeSnapshot(seriesOnly);
if(seriesSnap.independentFeatures.dataTier!=='SERIES_FALLBACK') throw new Error('series tier failed: '+seriesSnap.independentFeatures.dataTier);
if(seriesSnap.rawIndependentModel.decision==='FIX_DATA') throw new Error('series fallback produced FIX_DATA');
const broken=JSON.parse(JSON.stringify(base));
broken.setup.target=null; broken.rawMarket.venues=[]; broken.rawMarket.recentSeries=[]; broken.live.price=null;
const bad=ctx.normalizeSnapshot(broken);
if(bad.rawIndependentModel.decision!=='FIX_DATA') throw new Error('broken should produce FIX_DATA');
console.log('v76 logic tests passed:', strict.independentFeatures.dataTier, softSnap.independentFeatures.dataTier, seriesSnap.independentFeatures.dataTier, bad.rawIndependentModel.decision);
