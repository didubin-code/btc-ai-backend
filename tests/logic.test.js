'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateSnapshot,
  localIndependentRead,
  publicResponse,
  normalizeAiJson
} = require('../backend/logic');

function samplePayload(overrides={}){
  const now = Date.now();
  const series = [];
  for(let i=20;i>=0;i--){ series.push({t: now - i*2000, p: 61800 + (20-i)*1.8}); }
  return {
    version:'test', client_id:'test-client', ts:new Date(now).toISOString(),
    timer:{display:'12:00', minutesLeft:12},
    setup:{target:61820, position:'none', upCost:0.48, downCost:0.52},
    live:{price:61840, health:'GOOD'},
    rawMarket:{
      venues:[
        {name:'Coinbase', mid:61839, ageMs:100},
        {name:'Kraken', mid:61841, ageMs:120},
        {name:'Bitstamp', mid:61840, ageMs:150},
        {name:'Gemini', mid:61838, ageMs:220}
      ],
      recentSeries:series,
      summary:{freshVenueCount:4, quotedVenueCount:4}
    },
    engineRead:{trade:'PREPARE', logic:'test'},
    ...overrides
  };
}

test('valid snapshot passes and returns actionable shaped response', () => {
  const state = {};
  const p = samplePayload();
  const v = validateSnapshot(p, state, Date.now());
  assert.equal(v.ok, true);
  const read = localIndependentRead(p, v);
  assert.match(read.trade_read, /ACT_NOW|PREPARE|WAIT|SIT_OUT|DO_NOT_CHASE/);
  assert.ok(read.independent_ai.prob_above >= 1 && read.independent_ai.prob_above <= 99);
  const out = publicResponse(read, v, Date.now());
  assert.equal(out.version, 'v73.3-streamguard');
  assert.ok(out.independent_ai);
});

test('stale client timestamp becomes FIX_DATA', () => {
  const p = samplePayload({ts:new Date(Date.now()-60000).toISOString()});
  const v = validateSnapshot(p, {}, Date.now());
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(e=>/stale/i.test(e)));
  const read = localIndependentRead(p, v);
  assert.equal(read.trade_read, 'FIX_DATA');
});

test('insufficient fresh venues becomes FIX_DATA', () => {
  const p = samplePayload();
  p.rawMarket.venues = [{name:'Coinbase',mid:61840,ageMs:100},{name:'Kraken',mid:61841,ageMs:20000}];
  const v = validateSnapshot(p, {}, Date.now());
  assert.equal(v.ok, false);
  const read = localIndependentRead(p, v);
  assert.equal(read.trade_read, 'FIX_DATA');
});

test('repeated snapshots are detected by stream state', () => {
  const p = samplePayload();
  const st = {};
  assert.equal(validateSnapshot(p, st, Date.now()).ok, true);
  assert.equal(validateSnapshot(p, st, Date.now()).ok, true);
  const v3 = validateSnapshot(p, st, Date.now());
  assert.equal(v3.ok, false);
  assert.ok(v3.errors.some(e=>/repeated/i.test(e)));
});

test('AI cannot override invalid data into ACT_NOW', () => {
  const p = samplePayload({ts:new Date(Date.now()-60000).toISOString()});
  const v = validateSnapshot(p, {}, Date.now());
  const local = localIndependentRead(p, v);
  const ai = normalizeAiJson({trade_read:'ACT_NOW', independent_ai:{decision:'ABOVE',prob_above:99,prob_below:1}}, local, v);
  assert.equal(ai.trade_read, 'FIX_DATA');
});
