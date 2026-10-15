/* Pin Radar 2.8.1 — late-LOCKED tests on the REAL server code and REAL 1 Hz index paths (58 KXBTC15M windows with
   official results, pkg27/test/data). The Kalshi order book is synthetic where a test needs one (none is stored for
   these windows); every check that depends on the book says so.
     P1  warm parity: 2.8.1 with EXEC_SEC=0 makes exactly 2.8's decisions on every second (state, side, P, action, EV)
     P2  warm, default order time: probabilities and states identical to 2.8; actions differ only by the order-time
         TOO LATE rule (tau < 13 s) or the execution stress test
     R1  Oct 14 mechanism: a restart 300 s before the close -> 2.8 shows no LOCKED at all; 2.8.1 does, and every wrong
         2.8.1 call is a window the warm validated engine also gets wrong
     R2  restart subset property: every second 2.8.1 shows LOCKED after a restart, the warm validated engine shows
         LOCKED on the same side (counted over boots 600/420/330/300/180 s before the close, basis cold and warm)
     S1  Oct 12 20:45 ET adverse reversal (real window): never LOCKED UP in 2.8.1 in any restart configuration
     S2  safely ahead: TRADE NOW only with >= 13 s left; TOO LATE TO TRADE after the last order moment
     S3  narrowly ahead (real path moved so the settlement lands $1 from the strike): no TRADE NOW
     S4  final-second adverse jump: REVERSAL WARNING within 1 s, never TRADE NOW after the jump
     S5  late data: stale index input -> DATA UNRELIABLE / SIT OUT; stale book -> PREDICTED LOCKED, never TRADE NOW
     S6  signal after the book closes: LOCKED with no offers -> TOO LATE TO TRADE
     S7  valid signal with insufficient time: 9 s left, 10 s order time -> TOO LATE TO TRADE; 3 s order time -> TRADE NOW
     S8  after the close: FINAL, never an opportunity
   usage: node test/late281_test.js <2.8 server> <2.8.1 server> [out.json]                                          */
'use strict';
const path = require('path'), fs = require('fs');
const L = require(path.join(__dirname, '..', '..', 'research28', 'late_lock', 'sim_lib.js'));
const S28 = L.loadServer(process.argv[2] || path.join(__dirname, '..', '..', '2.8', 'dist', 'pinradar_server.js'));
const F281 = process.argv[3] || path.join(__dirname, '..', 'dist', 'pinradar_server.js');
process.env.EXEC_SEC = '0'; const S0 = L.loadServer(F281);
delete process.env.EXEC_SEC; const S1 = L.loadServer(F281);
const W = L.loadWindows();
const res = {}; let fail = 0; const fails = [];
const ok = (name, cond, got) => { res[name] = got; if (!cond) { fail++; fails.push(name + ' :: ' + JSON.stringify(got).slice(0, 400)); } };
let seed = 281; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
/* synthetic book: varied asks / sizes on the leader, occasionally stale; deterministic per (window, second) */
const bookFor = (stale = true) => (T, tau, x, w) => {
  seed = (T * 7919 + 13) % 2147483647 || 1;
  const lead = x >= w.K ? 'UP' : 'DOWN', a = [99.9, 99.8, 99.5, 99, 98.5, 98, 97, 95][Math.floor(rnd() * 8)];
  const sz = [3, 10, 25, 200][Math.floor(rnd() * 4)];
  const leadAsks = [[a, sz], [Math.min(99.9, a + 0.5), 300]], lagAsks = [[Math.max(0.5, Math.round((101 - a) * 10) / 10), 300]];
  const toBids = asks => asks.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]);
  return { yes: toBids(lead === 'UP' ? lagAsks : leadAsks), no: toBids(lead === 'UP' ? leadAsks : lagAsks), ageMs: stale && T % 37 === 0 ? 2600 : 150 };
};
const key = r => [r.state, r.side, r.pWin, r.pFlip, r.pFlipCons, r.action, r.ev].join('|');
const keyP = r => [r.state, r.side, r.pWin, r.pFlip, r.pFlipCons].join('|');
const execOf = (S, snap) => ({ exec: snap.signal.exec ? snap.signal.exec.state : null, why: snap.signal.trade ? snap.signal.trade.why : null });

/* P1 / P2: warm parity */
{
  let n = 0, d0 = 0, dP = 0, dTooLate = 0, dStress = 0, dOther = 0; const ex = [], ex2 = [];
  for (const w of W) {
    const opt = { basisMu: w.mu, book: bookFor() };
    const a = L.runWindow(S28, w, w.C - 1300, opt), b = L.runWindow(S0, w, w.C - 1300, opt), c = L.runWindow(S1, w, w.C - 1300, { ...opt, decide: execOf });
    for (let i = 0; i < a.length; i++) {
      n++;
      if (key(a[i]) !== key(b[i])) { d0++; if (ex.length < 3) ex.push({ t: w.ticker, tau: a[i].tau, a: key(a[i]), b: key(b[i]) }); }
      if (keyP(a[i]) !== keyP(c[i])) dP++;
      else if (a[i].action !== c[i].action) {
        /* allowed by design: past the last order moment (13 s) every LOCKED action is TOO LATE; the stress test refuses fragile TRADE NOWs */
        if (c[i].action === 'LOCKED — TOO LATE' && c[i].tau < 13 && /^(TRADE NOW|LOCKED)/.test(a[i].action)) dTooLate++;
        else if (a[i].action === 'TRADE NOW' && c[i].action === 'LOCKED — DO NOT TRADE' && /survive/.test(c[i].why || '')) dStress++;
        else { dOther++; if (ex2.length < 4) ex2.push({ t: w.ticker, tau: a[i].tau, a: a[i].action, c: c[i].action, why: c[i].why }); }
      }
    }
  }
  ok('P1 warm parity: 2.8.1 (EXEC_SEC=0) = 2.8 on every second', d0 === 0 && n > 15000, { seconds: n, differences: d0, ex });
  ok('P2 warm, 10 s order time: identical probabilities/states; actions differ only by TOO LATE (<13 s) or the stress test',
    dP === 0 && dOther === 0, { seconds: n, probabilityDiffs: dP, lockedActionToTooLateUnder13s: dTooLate, tradeNowToStressRefusal: dStress, otherActionDiffs: dOther, ex: ex2 });
}

/* R1 / R2: restarts */
{
  const BOOTS = [600, 420, 330, 300, 180];
  const warmRef = new Map();                 // ticker -> Map(T -> row) of the warm validated engine (2.8.1 warm == 2.8 warm by P1)
  for (const w of W) { const m = new Map(); for (const r of L.runWindow(S0, w, w.C - 1300, { basisMu: w.mu })) m.set(r.T, r); warmRef.set(w.ticker, m); }
  const warmWrong = new Set(W.filter(w => { const f = [...warmRef.get(w.ticker).values()].find(r => L.isLocked(r.state)); return f && f.side !== L.truth(w); }).map(w => w.ticker));
  const out = {};
  for (const B of BOOTS) for (const basis of ['cold', 'warm']) {
    const o = { '2.8': { lockedWindows: 0, wrong: [], unsupportedSeconds: 0, lockedSeconds: 0 }, '2.8.1': { lockedWindows: 0, wrong: [], unsupportedSeconds: 0, lockedSeconds: 0, ex: [] } };
    for (const w of W) {
      const ref = warmRef.get(w.ticker);
      for (const [name, S] of [['2.8', S28], ['2.8.1', S0]]) {
        const rows = L.runWindow(S, w, w.C - B, { basisMu: basis === 'warm' ? w.mu : null });
        const fl = rows.find(r => L.isLocked(r.state));
        if (fl) { o[name].lockedWindows++; if (fl.side !== L.truth(w)) o[name].wrong.push(w.ticker.slice(9)); }
        for (const r of rows) if (r.state === 'LOCKED') {
          o[name].lockedSeconds++;
          const q = ref.get(r.T);
          /* supported = the warm validated engine gives the same side a win probability >= 99.5 % at this second (its displayed state can be a
             REVERSAL WARNING about an earlier LOCKED call on the other side, which is history, not probability) */
          const pw = q && q.pFlip != null && !q.hard.length ? (q.side === r.side ? 1 - q.pFlip : q.pFlip) : null;
          if (pw == null || pw < 1 - 0.005 - 1e-12) { o[name].unsupportedSeconds++; if (o[name].ex && o[name].ex.length < 3) o[name].ex.push({ t: w.ticker.slice(9), tau: r.tau, warm: q && q.state, pFlipWarm: q && q.pFlip, pFlip: r.pFlip }); }
        }
      }
    }
    out[`boot T-${B} basis ${basis}`] = o;
  }
  const t300 = out['boot T-300 basis cold'];
  ok('R1 Oct 14 mechanism: restart 300 s before the close -> 2.8 never LOCKED; 2.8.1 LOCKED, wrong only where the warm engine is wrong',
    t300['2.8'].lockedWindows === 0 && t300['2.8.1'].lockedWindows > 0 && t300['2.8.1'].wrong.every(t => warmWrong.has('KXBTC15M-' + t)),
    { '2.8': t300['2.8'].lockedWindows, '2.8.1': t300['2.8.1'].lockedWindows, wrong281: t300['2.8.1'].wrong, warmWrong: [...warmRef.keys()].length ? [...warmWrong] : [] });
  let u281 = 0, s281 = 0, u28 = 0, s28 = 0;
  for (const o of Object.values(out)) { u281 += o['2.8.1'].unsupportedSeconds; s281 += o['2.8.1'].lockedSeconds; u28 += o['2.8'].unsupportedSeconds; s28 += o['2.8'].lockedSeconds; }
  ok('R2 restart subset: at every second 2.8.1 shows LOCKED after a restart, the warm validated engine gives that side >= 99.5 %',
    u281 === 0 && s281 > 1000, { '2.8.1 lockedSeconds': s281, '2.8.1 unsupported': u281, '2.8 lockedSeconds': s28, '2.8 unsupported (for comparison)': u28,
      byConfig: Object.fromEntries(Object.entries(out).map(([k, o]) => [k, { '2.8': [o['2.8'].lockedWindows, o['2.8'].wrong, o['2.8'].unsupportedSeconds], '2.8.1': [o['2.8.1'].lockedWindows, o['2.8.1'].wrong, o['2.8.1'].unsupportedSeconds] }])) });
  res.restartDetail = out;
}

/* S1: Oct 12 20:45 ET (= 5:45 pm PT) adverse reversal */
{
  const w = W.find(x => x.ticker === 'KXBTC15M-26OCT122045-45');
  const cfgs = [['warm basis known', w.C - 1300, w.mu], ['warm basis cold', w.C - 1300, null]];
  for (const B of [900, 600, 420, 330, 300, 180]) cfgs.push([`boot T-${B} basis cold`, w.C - B, null], [`boot T-${B} basis known`, w.C - B, w.mu]);
  const got = {}; let bad = 0;
  for (const [name, boot, mu] of cfgs) {
    const r1 = L.runWindow(S1, w, boot, { basisMu: mu, book: bookFor(false), decide: execOf });
    const r8 = L.runWindow(S28, w, boot, { basisMu: mu });
    const l1 = r1.find(r => L.isLocked(r.state)), l8 = r8.find(r => L.isLocked(r.state));
    if (l1 || r1.some(r => r.exec === 'TRADE NOW')) bad++;
    got[name] = { '2.8.1': l1 ? `LOCKED ${l1.side} T-${l1.tau}` : 'never LOCKED', '2.8': l8 ? `LOCKED ${l8.side} T-${l8.tau}` : 'never LOCKED' };
  }
  ok('S1 Oct 12 20:45 ET adverse reversal: 2.8.1 never LOCKED and never TRADE NOW (all restart / basis configurations)', bad === 0, got);
}

/* S2: safely ahead (official margin >= $50): TRADE NOW only with >= 13 s left, then TOO LATE TO TRADE */
{
  let tn = 0, tnLate = 0, tooLate = 0, windows = 0;
  for (const w of W.filter(w => Math.abs(w.A - w.K) >= 50)) {
    windows++;
    const book = (T, tau, x, w2) => { const lead = x >= w2.K ? 'UP' : 'DOWN'; const L1 = [[97, 500]], L2 = [[4, 500]]; const tb = a => a.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]);
      return { yes: tb(lead === 'UP' ? L2 : L1), no: tb(lead === 'UP' ? L1 : L2), ageMs: 120 }; };
    for (const r of L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book, decide: execOf })) {
      if (r.exec === 'TRADE NOW') { tn++; if (r.tau < 13) tnLate++; }
      if (r.exec === 'TOO LATE TO TRADE') { tooLate++; if (r.tau >= 13) tnLate++; }
    }
  }
  ok('S2 safely ahead (synthetic 97c book): TRADE NOW only at >= 13 s, TOO LATE TO TRADE only below', tn > 0 && tooLate > 0 && tnLate === 0, { windows, tradeNowSeconds: tn, tooLateSeconds: tooLate, violations: tnLate });
}

/* S3: narrowly ahead: a real path moved so that the official settlement lands $1 above the strike (index + the window's basis) */
{
  let windows = 0, tnSeconds = 0, tnWrong = 0, tnLate = 0, lockedWins = 0, lockedWrong = 0;
  for (const w0 of W.slice(0, 20)) {
    const shift = (w0.K + 1) - w0.A, w = { ...w0, A: w0.K + 1, yes: true };
    const px = new Map(); w0.idx.forEach((v, i) => px.set(w0.T_first + i, v + shift)); windows++;
    const rows = L.runWindow(S1, w, w.C - 1300, { px, basisMu: w0.mu, book: bookFor(false), decide: execOf });
    const fl = rows.find(r => L.isLocked(r.state)); if (fl) { lockedWins++; if (fl.side !== 'UP') lockedWrong++; }
    for (const r of rows) if (r.exec === 'TRADE NOW') { tnSeconds++; if (r.side !== 'UP') tnWrong++; if (r.tau < 13) tnLate++; }
  }
  ok('S3 narrowly ahead (official $1 above the strike): no TRADE NOW in the last 13 s; LOCKED / TRADE NOW outcomes reported', tnLate === 0,
    { windows, lockedWindows: lockedWins, lockedWrongSide: lockedWrong, tradeNowSeconds: tnSeconds, tradeNowWrongSide: tnWrong, tradeNowUnder13s: tnLate,
      note: 'a $1 settlement margin is decided by the basis (official minus our index); LOCKED on the wrong side here is the model limit the forward test measures' });
}

/* S4: final-second adverse jump on LOCKED windows (jump flips the settlement at tau 4) */
{
  let windows = 0, warned = 0, tnAfter = 0;
  for (const w of W.filter(w => Math.abs(w.A - w.K) >= 20).slice(0, 15)) {
    const lead = w.A >= w.K ? 1 : -1, px = new Map(); w.idx.forEach((v, i) => px.set(w.T_first + i, v));
    /* from tau 4 the index sits far enough on the other side that the 60 s average crosses: 60*(A-K)/4 plus margin */
    const J = (60 * Math.abs(w.A - w.K)) / 4 + 50;
    for (let T = w.C - 4; T <= w.C; T++) px.set(T, px.get(T) - lead * J);
    const rows = L.runWindow(S1, w, w.C - 1300, { px, basisMu: w.mu, book: bookFor(false), decide: execOf });
    if (!rows.some(r => L.isLocked(r.state) && r.tau > 4)) continue;
    windows++;
    const after = rows.filter(r => r.tau <= 3.8);
    if (after.length && (after[0].state === 'REVERSAL WARNING' || !L.isLocked(after[0].state))) warned++;
    tnAfter += after.filter(r => r.exec === 'TRADE NOW').length;
  }
  ok('S4 final-second adverse jump: the LOCKED call is dropped / REVERSAL WARNING within 1 s; no TRADE NOW', windows > 5 && warned === windows && tnAfter === 0, { windows, warnedWithin1s: warned, tradeNowAfterJump: tnAfter });
}

/* S5: late data updates */
{
  const w = W.find(x => x.ticker === 'KXBTC15M-26OCT131100-00');
  const staleIdx = L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book: bookFor(false), decide: execOf,
    before: (S, T, tau, NOW) => { if (tau <= 40 && tau >= 30) for (const v of Object.values(S.VENUES)) { v.lastQuoteTs = NOW - 6000; } } });
  const inStale = staleIdx.filter(r => r.tau <= 39 && r.tau >= 31);
  const staleBook = L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book: (T, tau, x, w2) => ({ ...bookFor(false)(T, tau, x, w2), ageMs: 2600 }), decide: execOf });
  ok('S5 late data: stale index -> no LOCKED/TRADE NOW (SIT OUT); stale book -> PREDICTED LOCKED, never TRADE NOW',
    inStale.length > 5 && inStale.every(r => !L.isLocked(r.state) && r.exec === 'SIT OUT') && staleBook.some(r => r.exec === 'PREDICTED LOCKED') && !staleBook.some(r => r.exec === 'TRADE NOW'),
    { staleIndexStates: [...new Set(inStale.map(r => r.state + '/' + r.exec))], staleBookExec: [...new Set(staleBook.map(r => r.exec))] });
}

/* S6 / S7 / S8: book gone, insufficient time, after the close (real geometry of a LOCKED window) */
{
  const w = W.find(x => x.ticker === 'KXBTC15M-26OCT131100-00');
  const empty = L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book: (T, tau, x) => (tau <= 25 ? { yes: [], no: [[96, 300]], ageMs: 100 } : bookFor(false)(T, tau, x, w)), decide: execOf });   // DOWN call: no NO offers left
  const e25 = empty.filter(r => r.tau <= 24.8 && L.isLocked(r.state));
  ok('S6 LOCKED after the book has no offers on the called side -> TOO LATE TO TRADE', e25.length > 5 && e25.every(r => r.exec === 'TOO LATE TO TRADE'), [...new Set(e25.map(r => r.exec + ': ' + r.why))].slice(0, 2));
  const deep = () => { const tb = a => a.map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]); return { yes: tb([[97, 500]]), no: tb([[4, 500]]), ageMs: 100 }; };   // NO asks 97c, YES asks 4c
  const r10 = L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book: deep, execSec: 10, decide: execOf }).find(r => r.tau <= 9.3 && r.tau > 8.5);
  const r3 = L.runWindow(S1, w, w.C - 1300, { basisMu: w.mu, book: deep, execSec: 3, decide: execOf }).find(r => r.tau <= 9.3 && r.tau > 8.5);
  ok('S7 valid LOCKED with 9 s left: 10 s order time -> TOO LATE TO TRADE; 3 s order time -> TRADE NOW', r10 && r3 && r10.exec === 'TOO LATE TO TRADE' && r3.exec === 'TRADE NOW', [r10 && r10.exec, r3 && r3.exec, r10 && r10.why]);
  const a = S1.exec281({ state: 'AWAITING SETTLEMENT', side: 'DOWN', trade: { action: 'TRADE NOW' }, ticker: null, v28: { designation: { label: 'AWAITING SETTLEMENT' } } }, { tau: -1, execSec: 10, now: Date.now() });
  const b = S1.exec281({ state: 'LOCKED', side: 'DOWN', trade: { action: 'TRADE NOW' }, ticker: null }, { tau: 0, execSec: 10, now: Date.now() });
  ok('S8 after the close: FINAL (never TRADE NOW, never an opportunity)', a.exec.state === 'FINAL' && b.exec.state === 'FINAL', [a.exec, b.exec.state]);
}

console.log(JSON.stringify({ fails }, null, 1));
if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(res, null, 1));
const names = Object.keys(res).filter(k => k !== 'restartDetail');
console.log(`late281: ${names.length - fail}/${names.length} passed`);
process.exit(fail ? 1 : 0);
