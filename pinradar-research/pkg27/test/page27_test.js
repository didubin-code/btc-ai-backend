/* jsdom test of dist27/btc_pin_radar_27.html driven by signal objects produced by the REAL 2.7 code path
   (classify25 -> settlePanel27 -> brtiAfterClassify27 in dist27/pinradar_server.js, in-process, no network).
   usage: node test/page27_test.js <dist dir> <jsdom path> */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path');
const DIST = path.resolve(process.argv[2] || 'dist27');
const { JSDOM, VirtualConsole } = require(process.argv[3] || 'jsdom');
const S = require(path.join(DIST, 'pinradar_server.js'));
const html = fs.readFileSync(path.join(DIST, fs.existsSync(path.join(DIST, 'btc_pin_radar_27.html')) ? 'btc_pin_radar_27.html' : 'btc_pin_radar.html'), 'utf8');

const results = []; const ok = (name, pass, got) => results.push({ name, pass: !!pass, got: String(got).slice(0, 200) });
const now0 = Date.now();
function mkGeo(pUp, extra = {}) {
  return { tau: 30, index: 83425.83, n: 30, nRemaining: 30, nLock: 30, lockedObserved: 30, lockedCoverage: 1, lockedMean: 83429.09,
    expectedSettle: 83427.4, gapUsd: -173.3, gapPct: -0.2073, leader: pUp >= 0.5 ? 'UP' : 'DOWN', pUp, pUpCons: pUp >= 0.5 ? pUp - 0.002 : pUp + 0.002,
    sigmaBps: 0.42, sigmaRawBps: 0.41, sigmaWarm: true, sigmaParts: [], sigmaPathUsd: 6.1, basisSdUsd: 4.8, basisMeanUsd: 0.9,
    cushionSigma: 22.2, requiredMoveUsd: 346.6, inputAgeMs: 120, volInflation: 1.001, provenUp: false, ...extra };
}
function signal({ pUp, tau = 30, book, hard = [], soft = [], lockedSide = null, ticker = 'KXBTC15M-TEST', contracts = 10 }) {
  S.KAL.ob = book ? { ticker, yes: book.yes, no: book.no } : null; S.KAL.obTs = Date.now() - (book && book.ageMs || 100);
  Object.assign(S.LOCK25, { ticker, hist: [], lockedSide, lockedAtTau: lockedSide ? 80 : null, revNoted: false });
  const now = Date.now(), closeMs = now + tau * 1000, geo = mkGeo(pUp, { tau });
  const panel = S.settlePanel27({ now, closeMs, strike: 83600.72, geo, tau });
  const gates = { hard, soft, budgetMs: 1000 }; S.brtiGate27(gates, panel, geo);
  return S.brtiAfterClassify27(S.classify25({ now, tau, ticker, closeMs, strike: 83600.72, geo,
    gates, kal: { ok: true, ticker }, contracts, mutate: false }), panel, ticker);
}
function response(sig, extra = {}) {
  const closeMs = sig.closeMs;
  return { ok: true, version: 'pin-radar-2.7', build: '2.7-test', ts: Date.now(), serverComputeMs: 0.9, signal: sig,
    price: 83425.83, strike: 83600.72, secondsLeft: Math.round(sig.tau), pinPressure: 2, level: 'GREEN', verdict: 'CLEAR', stale: false, gated: false,
    gapUsd: -173.3, sigmasOfCushion: 20.01, reasons: ['31% of the 60 settlement prints have printed'], components: { geometry: 0, flow: 0, kalshi: 0, sentinel: 0 },
    settlement: { gapUsd: -173.3, sigmasOfCushion: 20.01 }, market: { ticker: sig.ticker, strike: 83600.72, closeMs, yesBid: 0.1, yesAsk: 0.2, impliedAbove: 0.0015 },
    index: { value: 83425.83, liveAgeMs: 120, ageMs: 300, venuesUsed: ['coinbase', 'kraken', 'bitstamp'], dispersionBps: 0.5 },
    quality: { grade: 'GOOD', problems: [], warnings: [], clockSkewMs: 40 }, kalshi: { ageMs: 200, obAgeMs: 150 }, sources: {}, ...extra };
}

(async () => {
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message || e)));
  let current = null, failNext = false;
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://didubin-code.github.io/Btc-signal/btc_pin_radar.html', virtualConsole: vc,
    beforeParse(w) {
      w.WebSocket = class { constructor() { setTimeout(() => this.onclose && this.onclose(), 10); } send() { } close() { } };
      w.AudioContext = function () { return { createOscillator() { return { connect() { }, start() { }, stop() { }, frequency: {} }; }, createGain() { return { connect() { }, gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } } }; }, currentTime: 0, destination: {} }; };
      w.fetch = async (url, opts) => {
        if (failNext) throw new Error('network down');
        const body = /\/health$/.test(url) ? { ok: true, version: current && current.version || 'pin-radar-2.7', streaming: true } : current;
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      };
    } });
  const w = dom.window, $ = id => w.document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(400);   // the page binds its handlers on DOMContentLoaded
  $('localFeedToggle').checked = false; $('backendUrl').value = 'https://example.test';
  const show = async (resp, ms = 700) => { current = resp; w.PIN_RADAR.state.nextPollAt = 0; await sleep(ms); };
  const txt = id => $(id).textContent.replace(/\s+/g, ' ').trim();

  const bookDown = (askNo, size = 500, ageMs = 100) => ({ yes: [[100 - askNo, size]], no: [[99.8, 900]], ageMs });   // NO ask = 100 - best YES bid
  current = response(signal({ pUp: 0.004, book: bookDown(96) }));
  $('startBtn').click(); await sleep(900);
  ok('LOCKED — PREDICTED DOWN headline from a 0.4% UP probability', /LOCKED — PREDICTED DOWN/.test(txt('callHead')), txt('callHead') + ' // status: ' + txt('status'));
  ok('win and flip probabilities shown', /PREDICTED 99\.6%/.test(txt('callProb')) && /FLIP RISK 0\.4%/.test(txt('callProb')), txt('callProb'));
  ok('TRADE NOW with the ask and edge', txt('tradeAct') === 'TRADE NOW' && /96/.test(txt('kAsk')), txt('tradeAct') + ' | ' + txt('tradeWhy') + ' | ' + txt('kAsk'));
  ok('call panel highlighted for TRADE NOW', $('call').className.includes('trade'), $('call').className);
  ok('pin pressure dial still renders CLEAR as a diagnostic', txt('verdict') === 'CLEAR' && /diagnostic/i.test(w.document.querySelector('.diagLabel').textContent), txt('verdict'));
  ok('2.6: P(UP) / P(DOWN) and the conservative bound are shown', /P\(UP\) 0\.40% · P\(DOWN\) 99\.60%/.test(txt('callProb')) && /conservative flip ≤/.test(txt('callProb')), txt('callProb'));
  ok('2.6: evidence for the LOCKED call (standard, record, not a guarantee)', /LOCKED standard/.test(txt('valid')) && /first LOCKED calls lost/.test(txt('valid')) && /Not a guarantee/.test(txt('valid')), txt('valid').slice(0, 180));
  ok('distance shown in dollars and percent', /−\$173 \(-0\.207%\)/.test(txt('kDist')), txt('kDist'));
  ok('the live strip no longer says "% locked"', !/locked/i.test(txt('lvLock')), txt('lvLock'));
  ok('2.7: decision block (win / reversal / seconds / critical remaining average, labelled PROXY)', /WIN PROBABILITY 99\.6%/.test(txt('d27')) && /REVERSAL PROBABILITY 0\.4%/.test(txt('d27'))
    && /SECONDS REMAINING 30/.test(txt('d27')) && /CRITICAL REMAINING AVERAGE \$170\.7\d ABOVE STRIKE \(PROXY\)/.test(txt('d27')), txt('d27'));
  ok('2.7: settlement panel PROXY: 30/60 recorded, critical average, move from spot, official feed not live', txt('sRef') === 'PROXY' && /30\/60 recorded/.test(txt('sRecL'))
    && /\$170\.7\d above/.test(txt('sCrit')) && /remaining 30 must average ≥ \$83771\.4\d to flip DOWN/.test(txt('sCritL')) && /^\$344\.7\d$/.test(txt('sMove')) && txt('sOff') === 'not live', [txt('sRef'), txt('sRecL'), txt('sCrit'), txt('sCritL'), txt('sMove'), txt('sOff')].join(' | '));
  ok('2.7: PROXY note states the basis adjustment and that it is not the official BRTI', /PROXY: our Coinbase\/Kraken\/Bitstamp index/.test(txt('sNote')) && /Not identical to the official BRTI/.test(txt('sNote')), txt('sNote').slice(0, 160));
  /* OFFICIAL: fresh official accumulator for this window -> OFFICIAL badge and exact official numbers */
  {
    const nowO = Date.now(), tauO = 30, closeO = Math.round((nowO + tauO * 1000) / 1000) * 1000;
    Object.assign(S.BRTI, { enabled: true, state: 'live', last: { value: 83426.0, sourceTs: nowO - 150, receivedAt: nowO - 100, sendingTs: nowO - 60, localTs: nowO - 20, amended: false },
      win: { closeMs: closeO, value: 83430.5, size: 30, localTs: nowO - 20 } });
    const geo = mkGeo(0.004, { tau: tauO });
    const panel = S.settlePanel27({ now: nowO, closeMs: closeO, strike: 83600.72, geo, tau: (closeO - nowO) / 1000 });
    const gates = { hard: [], soft: [], budgetMs: 1000 }; S.brtiGate27(gates, panel, geo);
    S.KAL.ob = { ticker: 'KXBTC15M-TEST', yes: [[4, 500]], no: [[99.8, 900]] }; S.KAL.obTs = Date.now() - 100;
    Object.assign(S.LOCK25, { ticker: 'KXBTC15M-TEST', hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
    const sgO = S.brtiAfterClassify27(S.classify25({ now: nowO, tau: (closeO - nowO) / 1000, ticker: 'KXBTC15M-TEST', closeMs: closeO, strike: 83600.72, geo, gates, kal: { ok: true, ticker: 'KXBTC15M-TEST' }, contracts: 10, mutate: false }), panel, 'KXBTC15M-TEST');
    await show(response(sgO));
    ok('2.7: OFFICIAL badge, official accumulator values and official flip risk shown', txt('sRef') === 'OFFICIAL BRTI' && /30\/60 recorded · avg \$83430\.50/.test(txt('sRecL'))
      && /^flip /.test(txt('sOff')) && /official settlement accumulator/.test(txt('sNote')) && /\(OFFICIAL\)/.test(txt('d27')), [txt('sRef'), txt('sRecL'), txt('sOff'), txt('d27')].join(' | '));
    /* the official reference breaks an earlier LOCKED UP call -> REVERSAL WARNING even though the proxy model still says UP */
    Object.assign(S.BRTI.last, { value: 83590.0, localTs: Date.now() - 20 }); S.BRTI.win.value = 83598.0;
    const geoU = mkGeo(0.9995, { tau: tauO, index: 83640.0, lockedMean: 83641.0, gapUsd: 40.0 });
    const pU = S.settlePanel27({ now: Date.now(), closeMs: closeO, strike: 83600.72, geo: geoU, tau: (closeO - Date.now()) / 1000 });
    Object.assign(S.LOCK25, { ticker: 'KXBTC15M-TEST', hist: [], lockedSide: 'UP', lockedAtTau: 80, revNoted: false });
    const gU = { hard: [], soft: [], budgetMs: 1000 }; S.brtiGate27(gU, pU, geoU);
    const sgU = S.brtiAfterClassify27(S.classify25({ now: Date.now(), tau: (closeO - Date.now()) / 1000, ticker: 'KXBTC15M-TEST', closeMs: closeO, strike: 83600.72, geo: geoU, gates: gU, kal: { ok: true, ticker: 'KXBTC15M-TEST' }, contracts: 10, mutate: false }), pU, 'KXBTC15M-TEST');
    await show(response(sgU));
    ok('2.7: official reference below the strike after a LOCKED UP -> REVERSAL WARNING, EXIT / NO TRADE', /REVERSAL WARNING — UP AT RISK/.test(txt('callHead')) && txt('tradeAct') === 'EXIT / NO TRADE',
      txt('callHead') + ' | ' + txt('tradeAct') + ' | ' + JSON.stringify({ off: pU.officialPUp, gates: gU.soft }));
    Object.assign(S.BRTI, { last: null, win: null, state: 'test: off' });
  }

  await show(response(signal({ pUp: 0.004, book: { yes: [], no: [[99.8, 900]] } })));
  ok('LOCKED with no offers -> LOCKED, TOO LATE (call still displayed)', /LOCKED — PREDICTED DOWN/.test(txt('callHead')) && txt('tradeAct') === 'LOCKED — TOO LATE', txt('callHead') + ' | ' + txt('tradeAct'));
  await show(response(signal({ pUp: 0.004, book: bookDown(99.9, 5000) })));
  ok('LOCKED at 99.9c -> LOCKED, DO NOT TRADE', txt('tradeAct') === 'LOCKED — DO NOT TRADE', txt('tradeAct') + ' | ' + txt('tradeWhy'));
  await show(response(signal({ pUp: 0.004, book: bookDown(85) })));
  ok('2.6: LOCKED offered at 85c -> LOCKED — MARKET DISAGREES (red, no TRADE NOW)', txt('tradeAct') === 'LOCKED — MARKET DISAGREES' && $('tradeBox').className.includes('bad'), txt('tradeAct') + ' | ' + $('tradeBox').className);
  await show(response(signal({ pUp: 0.03, book: bookDown(90) })));
  ok('97% -> HIGH CONFIDENCE — DOWN (not locked) + WAIT', /HIGH CONFIDENCE — DOWN \(not locked\)/.test(txt('callHead')) && txt('tradeAct') === 'WAIT', txt('callHead') + ' | ' + txt('tradeAct'));
  ok('2.6: HIGH CONFIDENCE carries its own (weaker) record and is never called LOCKED', /HIGH CONFIDENCE = flip risk ≤ 5% \(not LOCKED\)/.test(txt('valid')), txt('valid').slice(0, 160));
  await show(response(signal({ pUp: 0.52, book: bookDown(50) })));
  ok('52% -> TOSS-UP / SIT OUT', /TOSS-UP/.test(txt('callHead')) && txt('tradeAct') === 'SIT OUT', txt('callHead') + ' | ' + txt('tradeAct'));
  await show(response(signal({ pUp: 0.85, book: bookDown(20), lockedSide: 'UP' })));
  ok('earlier LOCKED UP now 85% -> REVERSAL WARNING', /REVERSAL WARNING/.test(txt('callHead')) && $('call').className.includes('rev'), txt('callHead') + ' | ' + txt('callStatus'));
  await show(response(signal({ pUp: 0.004, book: bookDown(96), hard: ['oldest index input 3100 ms > 1000 ms budget'] })));
  ok('hard data gate -> DATA UNRELIABLE, NO TRADE', /DATA UNRELIABLE/.test(txt('callHead')) && txt('tradeAct') === 'NO TRADE', txt('callHead') + ' | ' + txt('tradeAct'));
  await show(response(signal({ pUp: 0.0004, book: bookDown(96) })));
  ok('flip risk < 0.1% shown as a bound', /FLIP RISK <0\.1%/.test(txt('callProb')) && />99\.9%/.test(txt('callProb')), txt('callProb'));

  /* staleness: backend stops answering -> within ~1.5 s the call is marked STALE (tau < 120) */
  current = response(signal({ pUp: 0.004, book: bookDown(96), tau: 40 }));
  w.PIN_RADAR.state.nextPollAt = 0; await sleep(500);
  failNext = true; await sleep(2600);
  ok('no fresh server reading for >1.5 s -> STALE, DO NOT TRADE', txt('tradeAct') === 'STALE — DO NOT TRADE' && $('call').className.includes('stale'), txt('tradeAct') + ' | ' + $('call').className);
  failNext = false; await sleep(1200);

  /* local feed disagreement: browser index $40 away from the backend -> DATA SUSPECT */
  Object.assign(w.PIN_RADAR.state.venues.coinbase, { mid: 83465.83, bid: 83465.82, ask: 83465.84, lastQuote: Date.now() + 60000, lastMsg: Date.now() + 60000, state: 'open' });
  await show(response(signal({ pUp: 0.004, book: bookDown(96) })), 600);
  ok('browser feed disagreeing with the backend downgrades LOCKED to DATA SUSPECT', /DATA SUSPECT/.test(txt('callHead')) && txt('tradeAct') === 'NO TRADE', txt('callHead') + ' | ' + txt('tradeAct'));
  Object.assign(w.PIN_RADAR.state.venues.coinbase, { mid: NaN, lastQuote: 0, lastMsg: 0, state: 'off' });

  /* backend still on 2.3: no signal object -> clear message, legacy panel keeps working */
  const r23 = response(signal({ pUp: 0.004, book: bookDown(96) })); delete r23.signal; r23.version = 'pin-radar-2.3';
  await show(r23);
  ok('2.3 backend -> page says the LOCKED engine is missing, dial still works', /HAS NO LOCKED ENGINE/.test(txt('callHead')) && txt('verdict') === 'CLEAR', txt('callHead'));
  ok('countdown renders with tenths inside the final minute', /^0:\d\d\.\d$/.test(txt('bigTau')), txt('bigTau'));
  ok('no script errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log((r.pass ? 'PASS ' : 'FAIL ') + r.name + (r.pass ? '' : ' :: ' + r.got));
  console.log(`page tests: ${results.length - failed.length}/${results.length} passed`);
  w.close(); process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
