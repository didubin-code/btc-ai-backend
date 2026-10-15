/* jsdom test of 2.8.1/dist/btc_pin_radar_281.html driven by signal objects from the REAL 2.8.1 code path
   (classify25 -> settlePanel27 -> brtiAfterClassify27 -> enrich28 -> exec281, in-process, no network).
   usage: node test/page281_test.js <2.8.1 dist dir> <jsdom path>                                               */
'use strict';
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const fs = require('fs'), path = require('path');
const DIST = path.resolve(process.argv[2] || 'dist');
const { JSDOM, VirtualConsole } = require(process.argv[3] || 'jsdom');
const S = require(path.join(DIST, 'pinradar_server.js'));
const html = fs.readFileSync(path.join(DIST, 'btc_pin_radar_281.html'), 'utf8');
const results = []; const ok = (name, pass, got) => results.push({ name, pass: !!pass, got: String(got).slice(0, 240) });

function mkGeo(pUp, extra = {}) {
  return { tau: 30, index: 83425.83, n: 30, nRemaining: 30, nLock: 30, lockedObserved: 30, lockedCoverage: 1, lockedMean: 83429.09,
    expectedSettle: 83427.4, gapUsd: -173.3, gapPct: -0.2073, leader: pUp >= 0.5 ? 'UP' : 'DOWN', pUp, pUpCons: pUp >= 0.5 ? pUp - 0.002 : pUp + 0.002,
    sigmaBps: 0.42, sigmaRawBps: 0.41, sigmaWarm: true, sigmaParts: [], sigmaPathUsd: 6.1, basisSdUsd: 4.8, basisMeanUsd: 0.9,
    cushionSigma: 22.2, requiredMoveUsd: 346.6, inputAgeMs: 120, volInflation: 1.001, provenUp: false, regime: { kind: 'sig', bucket: 3 }, ...extra };
}
function signal({ pUp, tau = 30, book, execSec = 10, warmup = null, ticker = 'KXBTC15M-TEST' }) {
  S.KAL.ob = book ? { ticker, yes: book.yes, no: book.no } : null; S.KAL.obTs = Date.now() - (book && book.ageMs || 100);
  Object.assign(S.LOCK25, { ticker, hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
  const now = Date.now(), closeMs = now + tau * 1000, geo = mkGeo(pUp, { tau });
  const panel = S.settlePanel27({ now, closeMs, strike: 83600.72, geo, tau });
  const gates = { hard: [], soft: [], budgetMs: 1000 }; S.brtiGate27(gates, panel, geo);
  const sig = S.enrich28(S.brtiAfterClassify27(S.classify25({ now, tau, ticker, closeMs, strike: 83600.72, geo, gates, kal: { ok: true, ticker }, contracts: 10, mutate: false, execSec }), panel, ticker),
    { geo, settle: panel, kal: { ok: true, ticker }, now, tau });
  if (warmup) sig.warmup = warmup;
  return S.exec281(sig, { tau, execSec, now });
}
function response(sig) {
  return { ok: true, version: 'pin-radar-2.8.1', build: '2.8.1-test', ts: Date.now(), serverComputeMs: 0.9, signal: sig, price: 83425.83, strike: 83600.72, secondsLeft: Math.round(sig.tau),
    pinPressure: 2, level: 'GREEN', verdict: 'CLEAR', stale: false, gated: false, gapUsd: -173.3, sigmasOfCushion: 20.01, reasons: [], components: { geometry: 0, flow: 0, kalshi: 0, sentinel: 0 },
    settlement: { gapUsd: -173.3, sigmasOfCushion: 20.01 }, market: { ticker: sig.ticker, strike: 83600.72, closeMs: sig.closeMs, yesBid: 0.1, yesAsk: 0.2, impliedAbove: 0.0015 },
    index: { value: 83425.83, liveAgeMs: 120, ageMs: 300, venuesUsed: ['coinbase', 'kraken', 'bitstamp'], dispersionBps: 0.5 },
    quality: { grade: 'GOOD', problems: [], warnings: [], clockSkewMs: 40 }, kalshi: { ageMs: 200, obAgeMs: 150 }, sources: {} };
}
const bookDown = (askNo, size = 500, ageMs = 100) => ({ yes: [[100 - askNo, size]], no: [[99.8, 900]], ageMs });

(async () => {
  const vc = new VirtualConsole(); const errs = [];
  vc.on('jsdomError', e => errs.push(String(e && e.message || e)));
  let current = null, lastBody = null;
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://didubin-code.github.io/Btc-signal/btc_pin_radar.html', virtualConsole: vc,
    beforeParse(w) {
      w.WebSocket = class { constructor() { setTimeout(() => this.onclose && this.onclose(), 10); } send() { } close() { } };
      w.AudioContext = function () { return { createOscillator() { return { connect() { }, start() { }, stop() { }, frequency: {} }; }, createGain() { return { connect() { }, gain: { setValueAtTime() { }, exponentialRampToValueAtTime() { } } }; }, currentTime: 0, destination: {} }; };
      w.fetch = async (url, opts) => { if (opts && opts.body) lastBody = opts.body; const body = /\/health$/.test(url) ? { ok: true, version: 'pin-radar-2.8.1', streaming: true } : current; return { ok: true, status: 200, text: async () => JSON.stringify(body) }; };
    } });
  const w = dom.window, $ = id => w.document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  await sleep(400);
  $('localFeedToggle').checked = false; $('backendUrl').value = 'https://example.test';
  const show = async (resp, ms = 700) => { current = resp; w.PIN_RADAR.state.nextPollAt = 0; await sleep(ms); };
  const txt = id => $(id).textContent.replace(/\s+/g, ' ').trim();

  current = response(signal({ pUp: 0.004, book: bookDown(96) }));
  $('startBtn').click(); await sleep(900);
  ok('TRADE NOW banner: buy NO (DOWN), green, with the last order moment', /^TRADE NOW — BUY NO \(DOWN\)$/.test(txt('act281S')) && $('act281').className.includes('go') && /last moment to place an order: T−13 s/.test(txt('act281C')), [txt('act281S'), $('act281').className, txt('act281C')]);
  ok('the request carries the order time (default 10 s)', lastBody && JSON.parse(lastBody).execSec === 10, lastBody && JSON.parse(lastBody).execSec);
  await show(response(signal({ pUp: 0.004, book: bookDown(99.9) })));
  ok('LOCKED with no edge -> PREDICTED LOCKED DOWN — NOT TRADABLE NOW, with the reason', /^PREDICTED LOCKED DOWN — NOT TRADABLE NOW$/.test(txt('act281S')) && /NO EDGE|not tradable now/.test(txt('act281W')) && $('act281').className.includes('pred'), [txt('act281S'), txt('act281W')]);
  await show(response(signal({ pUp: 0.004, tau: 9, book: bookDown(96) })));
  ok('LOCKED with 9 s left and a 10 s order time -> TOO LATE TO TRADE (amber), never TRADE NOW', txt('act281S') === 'TOO LATE TO TRADE' && $('act281').className.includes('late') && /past the last moment/.test(txt('act281C')), [txt('act281S'), txt('act281W'), txt('act281C')]);
  await show(response(signal({ pUp: 0.03, book: bookDown(96) })));
  ok('HIGH CONFIDENCE -> SIT OUT', txt('act281S') === 'SIT OUT' && $('act281').className.includes('sit'), txt('act281S'));
  await show(response(signal({ pUp: 0.004, tau: -2, book: bookDown(96) })));
  ok('after the close -> WINDOW CLOSED — FINAL / SETTLEMENT (never an opportunity)', /WINDOW CLOSED/.test(txt('act281S')) && !/TRADE NOW/.test(txt('act281S')) && txt('act281C') === '', [txt('act281S'), txt('act281C')]);
  await show(response(signal({ pUp: 0.004, book: bookDown(96), warmup: { label: 'restarted 150 s ago: conservative volatility envelope (full history in 750 s)' } })));
  ok('restart banner shown when the server reports a warm-up', $('warm281').style.display === 'block' && /restarted 150 s ago/.test(txt('warm281')), txt('warm281'));
  await show(response(signal({ pUp: 0.004, book: bookDown(96) })));
  ok('restart banner hidden when warm', $('warm281').style.display === 'none', $('warm281').style.display);
  $('execSec').value = '4'; $('execSec').dispatchEvent(new w.Event('change'));
  await show(response(signal({ pUp: 0.004, book: bookDown(96), execSec: 4 })));
  ok('order time setting is sent (4 s)', lastBody && JSON.parse(lastBody).execSec === 4, lastBody && JSON.parse(lastBody).execSec);
  /* backend without 2.8.1 (no exec field): the banner says so instead of guessing */
  const s0 = signal({ pUp: 0.004, book: bookDown(96) }); delete s0.exec;
  await show(response(s0));
  ok('a 2.8 backend (no exec field) -> NO ACTION DATA, not TRADE NOW', txt('act281S') === 'NO ACTION DATA', txt('act281S'));
  /* the Oct 15 12:00 ET screens: LOCKED UP at 99.8c (no edge), then no UP offers */
  const bookUp = (askYes, size = 500) => ({ yes: [[0.3, 900]], no: askYes == null ? [] : [[Math.round((100 - askYes) * 100) / 100, size]], ageMs: 520 });
  await show(response(signal({ pUp: 0.9954, tau: 70, book: bookUp(99.8) })));
  ok('Oct 15 replica, 99.8c: PREDICTED LOCKED UP — NOT TRADABLE NOW, NO EDGE with the price that would qualify', /^PREDICTED LOCKED UP — NOT TRADABLE NOW$/.test(txt('act281S')) && /NO EDGE/.test(txt('act281W')) && /qualify only at ≤/.test(txt('act281W')), [txt('act281S'), txt('act281W')]);
  await show(response(signal({ pUp: 0.9999, tau: 33, book: bookUp(null) })));
  ok('Oct 15 replica, no UP offers at T-33: NO OFFERS (not TOO LATE) in the banner and the trade box', /NO OFFERS/.test(txt('act281W')) && txt('act281S') !== 'TOO LATE TO TRADE' && txt('tradeAct') === 'LOCKED — NO OFFERS', [txt('act281S'), txt('act281W'), txt('tradeAct')]);
  /* review finding: the banner must be downgraded when the backend goes stale (the page may downgrade, never upgrade) */
  await show(response(signal({ pUp: 0.004, tau: 30, book: bookDown(96) })));
  const okBefore = txt('act281S');
  w.fetch = async () => { throw new Error('network down'); };
  await sleep(3200);
  ok('backend stale after a TRADE NOW -> the banner says STALE — DO NOT TRADE', /TRADE NOW/.test(okBefore) && txt('act281S') === 'STALE — DO NOT TRADE' && $('act281').className.includes('bad'), [okBefore, txt('act281S'), $('act281').className]);
  ok('no script errors', errs.length === 0, errs.join(' | '));
  const failed = results.filter(r => !r.pass);
  for (const f of failed) console.log('FAIL', f.name, '::', f.got);
  console.log(`page281: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
