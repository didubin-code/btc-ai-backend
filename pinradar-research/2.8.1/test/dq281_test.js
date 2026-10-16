/* Pin Radar 2.8.1 — DATA UNRELIABLE tests on the REAL server code and REAL 1 Hz index paths.
     Q1  sampler phase: with the 1 Hz sampler firing near x.5 s (where Node's drifting setInterval regularly passes), 2.8 reports
         "only k/n locked prints sampled" -> DATA UNRELIABLE for most of the final minute; 2.8.1 never does, at any phase.
     Q2  a REAL gap (no index sample for 5 s inside the settlement minute) still makes 2.8.1 DATA UNRELIABLE (not suppressed).
     Q3  the aligned sampler, run on real timers for ~8 s under timer load, samples once per second at the second + SAMPLE_PHASE_MS
         (no drift, no duplicate sample of the same second).
     Q4  one lagging venue (quote 2.6 s old) in the final 20 s: DATA UNRELIABLE in 2.8 AND 2.8.1 (a legitimate warning: the 1 Hz settlement
         ring samples every venue, so the index cannot simply be rebuilt without the lagging one; review round 2 withdrew that change).
     Q6  a FROZEN venue (price stuck, heartbeats alive) from T-28 and from T-45 on 12 real windows: 2.8.1 is DATA UNRELIABLE wherever 2.8 is,
         and never shows LOCKED / TRADE NOW where the same window without the freeze does not (regression for the review-round-2 finding).
     Q5  /dq diagnostics record the hard-gate reason and the venue state.
   usage: node test/dq281_test.js <2.8 server> <2.8.1 server>                                                                    */
'use strict';
const path = require('path'), { execFileSync } = require('child_process');
const L = require(path.join(__dirname, '..', '..', 'research28', 'late_lock', 'sim_lib.js'));
const F28 = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '2.8', 'dist', 'pinradar_server.js'));
const F281 = path.resolve(process.argv[3] || path.join(__dirname, '..', 'dist', 'pinradar_server.js'));
const S28 = L.loadServer(F28), S1 = L.loadServer(F281);
const W = L.loadWindows();
let fail = 0; const res = {};
const ok = (name, cond, got) => { res[name] = got; if (!cond) { fail++; console.log('FAIL ' + name + ' :: ' + JSON.stringify(got).slice(0, 500)); } };
let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

/* drive one window: sampler at T*1000 + phase(T), decision late in the second; hooks can alter venues / skip samples */
function run(S, w, { phase = () => 100, skip = () => false, venues = null, pre = null, from = 60, book = false } = {}) {
  const px = L.priceAt(w), realNow = Date.now; let NOW = 0; Date.now = () => NOW;
  const rows = [];
  try {
    S.IDX.ring.length = 0; S.IDX.value = NaN; S.IDX.ts = 0;
    Object.assign(S.LOCK25, { ticker: null, hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
    S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; S.KAL.ob = null; S.RESTF.active = false;
    S.KAL.market = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
    for (let T = w.C - 1300; T < w.C; T++) {
      const x = px.get(T); if (x == null) continue;
      NOW = T * 1000 + phase(T);
      for (const v of Object.values(S.VENUES)) Object.assign(v, { mid: x + (v.name === 'coinbase' ? 0.4 : v.name === 'kraken' ? -0.4 : 0), bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 50, lastMsgTs: NOW });
      if (pre) pre(S, NOW, w.C - T, x);
      if (!skip(w.C - T)) S.sampleIndex();
      const tau = w.C - T; if (tau > from) continue;
      NOW = T * 1000 + 950; S.KAL.ts = NOW - 100;
      if (venues) venues(S, NOW, tau, x);
      if (book) { S.KAL.ob = { ticker: w.ticker, yes: [[3, 500]], no: [[3, 500]] }; S.KAL.obTs = NOW - 100; }   // a 97c ask on both sides, deep
      const kal = S.getKalshiContext();
      const li = S.computeIndex(NOW);
      const used = li ? Object.values(S.VENUES).filter(v => li.used.includes(v.name)) : [];
      const age = used.length ? Math.max(...used.map(v => NOW - v.lastQuoteTs)) : Infinity;
      const q = S.assessQuality(NOW, kal);
      const snap = S.computeLockSnapshot({ now: NOW, kal, strike: kal.strike, strikeIssue: null, overrides: [], quality: q, liveIdx: li, liveIndexAgeMs: age, side: null, mutate: true, basisMu: w.mu });
      rows.push({ tau, state: snap.signal.state, side: snap.signal.side, act: snap.signal.exec ? snap.signal.exec.headline : null, hard: (snap.signal.gates || snap.gates).hard.slice(), used: li ? li.used.slice() : [] });
    }
  } finally { Date.now = realNow; }
  return rows;
}

/* Q1 */
{
  const ws = W.slice(0, 8), out = {};
  for (const ph of [100, 470, 490, 500, 510, 530, 900]) {
    const cnt = { '2.8': 0, '2.8.1': 0, n: 0 };
    for (const w of ws) for (const [name, S] of [['2.8', S28], ['2.8.1', S1]]) {
      const rows = run(S, w, { phase: () => ph + Math.round((rnd() - 0.5) * 2 * 40) });
      if (name === '2.8') cnt.n += rows.length;
      cnt[name] += rows.filter(r => r.hard.some(h => /locked prints sampled/.test(h))).length;
    }
    out[ph] = cnt;
  }
  ok('Q1 sampler near x.5 s: 2.8 DATA UNRELIABLE from missing prints, 2.8.1 never (any phase, +/-40 ms jitter)',
    out[500]['2.8'] > out[500].n / 2 && Object.values(out).every(c => c['2.8.1'] === 0), out);
}
/* Q2 */
{
  let windows = 0, flagged = 0;
  for (const w of W.slice(0, 8)) {
    const rows = run(S1, w, { skip: tau => tau <= 52 && tau >= 48 });
    windows++;
    if (rows.some(r => r.tau <= 47 && r.tau >= 40 && r.state === 'DATA UNRELIABLE' && r.hard.some(h => /locked prints sampled/.test(h)))) flagged++;
  }
  ok('Q2 a real 5 s index gap inside the settlement minute is still DATA UNRELIABLE in 2.8.1', flagged === windows, { windows, flagged });
}
/* Q3: real timers, separate process: the aligned sampler must not drift AND must never sample the same second twice (review round 2: a
   timer firing ~1 ms early re-targeted the same second; the zero return biased the volatility low). Run with other timer work (8 ms busy
   every 500 ms, like bgTick), which made the defect appear in ~17 % of seconds. */
{
  const code = `process.env.ENABLE_WS='0';process.env.PINRADAR_REPLAY='1';const S=require(${JSON.stringify(F281)});
    for (const v of Object.values(S.VENUES)) Object.assign(v,{mid:80000,bidDepth:1,askDepth:1});
    const keep=setInterval(()=>{for(const v of Object.values(S.VENUES)){v.lastQuoteTs=Date.now();v.lastMsgTs=Date.now();}},20);
    const busy=setInterval(()=>{const t=Date.now();while(Date.now()-t<8){}},500);
    S.startSampler();
    setTimeout(()=>{clearInterval(keep);clearInterval(busy);const r=S.IDX.ring.map(p=>p[0]);console.log(JSON.stringify({ph:r.slice(1).map(t=>t%1000),dt:r.slice(1).map((t,i)=>t-r[i])}));process.exit(0);},8300);`;
  const o = JSON.parse(execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }).trim());
  ok('Q3 aligned sampler on real timers under load: every tick at the second + ~100 ms, exactly one sample per second (no duplicates, no gaps)',
    o.ph.length >= 6 && o.ph.every(p => p >= 95 && p < 250) && o.dt.every(d => d >= 500 && d <= 1500), o);
}
/* Q4 */
{
  const w = W.find(x => x.ticker === 'KXBTC15M-26OCT131100-00');
  const oneStale = (S, NOW, tau) => { if (tau <= 20 && tau >= 10) S.VENUES.bitstamp.lastQuoteTs = NOW - 2600; };
  const a = run(S28, w, { venues: oneStale }).filter(r => r.tau <= 20 && r.tau >= 10);
  const b = run(S1, w, { venues: oneStale }).filter(r => r.tau <= 20 && r.tau >= 10);
  ok('Q4 one lagging venue in the final 20 s: DATA UNRELIABLE in 2.8 and in 2.8.1 (legitimate; not suppressed)',
    a.length > 5 && a.every(r => r.state === 'DATA UNRELIABLE') && b.every(r => r.state === 'DATA UNRELIABLE'),
    { '2.8': [...new Set(a.map(r => r.state))], '2.8.1': [...new Set(b.map(r => r.state))], example: b[0] && b[0].hard[0] });
}
/* Q6: through the server's OWN background path (bgTick: its live index, its gates, its snapshot), as in production */
function runBg(S, w, { freezeAt = null, from = 60 } = {}) {
  const px = L.priceAt(w), realNow = Date.now; let NOW = 0; Date.now = () => NOW;
  const rows = []; let fz = null;
  try {
    S.IDX.ring.length = 0; S.IDX.value = NaN; S.IDX.ts = 0;
    Object.assign(S.LOCK25, { ticker: null, hist: [], lockedSide: null, lockedAtTau: null, revNoted: false });
    S.SKEW.samples.length = 0; for (let i = 0; i < 10; i++) S.SKEW.samples.push(20); S.SKEW.estMs = 20; S.RESTF.active = false;
    S.BASIS.samples.length = 0; S.BASIS.byKey.clear();
    for (let i = 0; i < 20; i++) { S.BASIS.samples.push({ key: 'q6-' + i, e: 0, proxy: 0, official: 0, ts: 0 }); S.BASIS.byKey.add('q6-' + i); }   // a warm basis model (mean 0)
    S.KAL.market = { ticker: w.ticker, strike: w.K, closeMs: w.C * 1000, openMs: (w.C - 900) * 1000, status: 'active', yesBid: 50, yesAsk: 51 };
    const setV = (NOW, x, tau) => {
      for (const v of Object.values(S.VENUES)) Object.assign(v, { mid: x + (v.name === 'coinbase' ? 0.4 : v.name === 'kraken' ? -0.4 : 0), bidDepth: 2, askDepth: 2, lastQuoteTs: NOW - 50, lastMsgTs: NOW });
      if (freezeAt != null && tau <= freezeAt) { if (!fz) fz = { mid: S.VENUES.kraken.mid, ts: NOW - 50 }; Object.assign(S.VENUES.kraken, { mid: fz.mid, lastQuoteTs: fz.ts, lastMsgTs: NOW }); }
    };
    for (let T = w.C - 1300; T < w.C; T++) {
      const x = px.get(T); if (x == null) continue; const tau = w.C - T;
      NOW = T * 1000 + 100; setV(NOW, x, tau); S.sampleIndex();
      if (tau > from) continue;
      NOW = T * 1000 + 950; setV(NOW, x, tau); S.KAL.ts = NOW - 100;
      S.KAL.ob = { ticker: w.ticker, yes: [[3, 500]], no: [[3, 500]] }; S.KAL.obTs = NOW - 100;   // a 97c ask on both sides, deep
      const snap = S.bgTick(NOW); if (!snap || !snap.signal) continue;
      const sg = snap.signal;
      rows.push({ tau, state: sg.state, side: sg.side, act: sg.exec ? sg.exec.headline : (sg.trade && sg.trade.action === 'TRADE NOW' ? 'TRADE NOW' : null), hard: (sg.gates || snap.gates).hard.slice() });
    }
  } finally { Date.now = realNow; }
  return rows;
}
{
  const out = {}; let bad = 0; const ex = [];
  const isL = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
  for (const FZ of [28, 45]) {
    const c = { decisions: 0, unreliable28: 0, unreliable281: 0, unreliable281not28: 0, locked281NotClean: 0, tradeNow281NotClean: 0, lockedClean: 0 };
    for (const w of W.slice(-12)) {
      const f28 = runBg(S28, w, { freezeAt: FZ, from: FZ }), f281 = runBg(S1, w, { freezeAt: FZ, from: FZ }), clean = runBg(S1, w, { from: FZ });
      for (const r of f281) {
        const o = f28.find(x => x.tau === r.tau), t = clean.find(x => x.tau === r.tau); if (!o || !t) continue;
        c.decisions++; if (o.state === 'DATA UNRELIABLE') c.unreliable28++; if (r.state === 'DATA UNRELIABLE') c.unreliable281++; if (isL(t.state)) c.lockedClean++;
        if (o.state === 'DATA UNRELIABLE' && r.state !== 'DATA UNRELIABLE') { c.unreliable281not28++; bad++; if (ex.length < 3) ex.push({ ticker: w.ticker, FZ, tau: r.tau, s281: r.state, s28: o.state }); }
        if (isL(r.state) && !(isL(t.state) && t.side === r.side)) { c.locked281NotClean++; bad++; if (ex.length < 3) ex.push({ ticker: w.ticker, FZ, tau: r.tau, frozen: r.state + ' ' + r.side, clean: t.state + ' ' + t.side }); }
        if (r.act === 'TRADE NOW' && t.act !== 'TRADE NOW') { c.tradeNow281NotClean++; bad++; }
      }
    }
    out['frozen from T-' + FZ] = c;
  }
  ok('Q6 frozen venue (price stuck, heartbeats alive), server background path: 2.8.1 DATA UNRELIABLE wherever 2.8 is; no LOCKED / TRADE NOW the unfrozen window would not show',
    bad === 0 && Object.values(out).every(c => c.decisions > 100 && c.unreliable281 > 0 && c.lockedClean > 0), { ...out, ex });
}
/* Q5 */
{
  const d = S1.dqSummary281();
  ok('Q5 /dq records hard-gate reasons with the venue state', d.dataUnreliable > 0 && Object.keys(d.reasons).length > 0 && d.recent.length > 0 && Array.isArray(d.recent[0].venues), { unreliable: d.dataUnreliable, reasons: d.reasons });
}
const n = Object.keys(res).length;
console.log(`dq281: ${n - fail}/${n} passed`);
process.exit(fail ? 1 : 0);
