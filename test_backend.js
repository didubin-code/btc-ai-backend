'use strict';
const {spawn} = require('child_process');
const assert = require('assert');
const PORT = 19999;
const proc = spawn(process.execPath, ['/mnt/data/btc_openai_backend_server.js'], {env:{...process.env, PORT:String(PORT), MOCK_OPENAI:'1'}, stdio:['ignore','pipe','pipe']});
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
async function main(){
  await wait(500);
  let r = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(r.status, 200);
  const health = await r.json();
  assert.equal(health.ok, true);
  const now = Date.now();
  const packet = {
    target_price: 61980.12,
    live_price: 62431.93,
    seconds_left: 276,
    venue_list: [
      {name:'coinbase', price:62431.9, age_ms:100},
      {name:'kraken', price:62432.1, age_ms:200},
      {name:'bitstamp', price:62431.7, age_ms:300}
    ],
    price_history: [
      {t: now-30000, price:62380},
      {t: now-15000, price:62405},
      {t: now-5000, price:62420},
      {t: now-1000, price:62431.93}
    ],
    analysis:{side:'ABOVE', execScore:95},
    memory:{regime:'trend_stable'}
  };
  r = await fetch(`http://127.0.0.1:${PORT}/analyze`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(packet)});
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.ok(data.final_action);
  assert.equal(data.direction, 'ABOVE');
  assert.ok(data.confidence > 0);
  assert.notEqual(data.main_blocker, 'LOCAL_DATA_INCOMPLETE');
  assert.ok(data.ai_used);
  const active = {...packet, position:{side:'ABOVE', entryPrice:62400, entryTime:now-60000}};
  r = await fetch(`http://127.0.0.1:${PORT}/analyze`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(active)});
  const hold = await r.json();
  assert.notEqual(hold.final_action, 'EXIT_NOW_CONFIRMED');
  console.log('BTC backend tests PASSED');
}
main().catch(e=>{ console.error(e); process.exitCode=1; }).finally(()=>proc.kill());
