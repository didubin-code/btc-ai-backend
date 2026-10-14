#!/usr/bin/env node
/* Independent forward-test evaluation of Pin Radar 2.8 from its hash-chained ledger (and optionally the
   record/replay tape and a /latency snapshot), exactly as pre-registered in PREREGISTRATION.md
   (pinradar-2.8-prereg-v1). Does not trust any summary computed by the server: everything is recomputed from
   committed entries, and every scored call must have been committed before its window's outcome.
   usage: node tools/forward_report28.js --ledger ledger28.ndjson [--tape tape.ndjson] [--latency latency.json]
                                         [--config <CONFIG28_HASH>] [--since <ms epoch>] [--out report.json]      */
'use strict';
const fs = require('fs'), path = require('path');
const C = require(path.join(__dirname, '..', 'src', 'core28.js'));
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const readNd = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
function binomSf(k, n, p = 0.5) { let s = 0; for (let i = k; i <= n; i++) s += Math.exp(lnC(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); return Math.min(1, s); }   // P(X >= k)
function lnG(z) { const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]; if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnG(1 - z); z -= 1; let a = c[0]; const t = z + 7.5; for (let i = 1; i < 9; i++) a += c[i] / (z + i); return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a); }
function lnC(n, k) { return lnG(n + 1) - lnG(k + 1) - lnG(n - k + 1); }
function poisCi(O) { // exact 95 % CI for a Poisson count via chi-square <-> gamma; bisection on the Poisson CDF
  const cdf = (k, mu) => { let s = 0, t = Math.exp(-mu); for (let i = 0; i <= k; i++) { s += t; t *= mu / (i + 1); } return s; };
  const solve = (f, lo, hi) => { for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m)) hi = m; else lo = m; } return (lo + hi) / 2; };
  const lo = O === 0 ? 0 : solve(mu => 1 - cdf(O - 1, mu) >= 0.025, 0, O * 5 + 10), hi = solve(mu => cdf(O, mu) <= 0.025, 0, O * 5 + 20);
  return [lo, hi];
}

const LEDGER = arg('ledger'); if (!LEDGER) { console.error('usage: --ledger <file> [--tape f] [--latency f] [--config hash] [--since ms] [--out f]'); process.exit(2); }
const rows = readNd(LEDGER), SINCE = Number(arg('since') || 0), CONF = arg('config');
/* ---- chain segments ---- */
const segs = []; let cur = null;
for (const e of rows) { if (!cur || e.seq === 1 || e.prev !== cur[cur.length - 1].hash) { cur = []; segs.push(cur); } cur.push(e); }
const segVerify = segs.map(s => C.verifyLedger28(s, s[0].seq === 1 ? s[0].prev : null));
/* ---- outcomes, with commit-before-outcome and config checks ---- */
const scored = [], issues = { callAfterOutcome: 0, missingCommit: 0, wrongConfig: 0, unresolved: 0 };
for (const seg of segs) {
  let boot = null; const calls = new Map();
  for (const e of seg) {
    if (e.type === 'boot') boot = e.body;
    if (e.type === 'call') { const k = e.body.ticker + '|' + e.body.policy + '|' + e.body.event; if (!calls.has(k)) calls.set(k, e); }
    if (e.type === 'unresolved' && e.ts >= SINCE) issues.unresolved++;
    if (e.type !== 'outcome' || e.ts < SINCE) continue;
    if (CONF && (!boot || boot.configHash !== CONF)) { issues.wrongConfig++; continue; }
    const recs = e.body.records || {};
    for (const [pid, r] of Object.entries(recs)) {
      if (!r) continue;
      for (const ev of ['firstLock', 'firstTrade']) if (r[ev]) {
        const c = calls.get(e.body.ticker + '|' + pid + '|' + ev);
        if (!c) issues.missingCommit++; else if (c.seq > e.seq) issues.callAfterOutcome++;
      }
    }
    scored.push(e.body);
  }
}
const policies = C.SHADOW_POLICIES28.map(p => p.id);
const stats = C.mkShadowStats28(C.SHADOW_POLICIES28, 0.005);
for (const o of scored) for (const pid of policies) C.shadowAccumulate28(stats, pid, o.records[pid] || null, o.winner);
const summary = C.shadowSummary28(stats);
/* ---- paired candidate comparisons vs A ---- */
const lostOf = (o, pid) => { const r = o.records[pid]; return r && r.firstLock ? r.firstLock.side !== o.winner : false; };
const lockedOf = (o, pid) => !!(o.records[pid] && o.records[pid].firstLock);
const pnlOf = (o, pid) => { const r = o.records[pid]; if (!r || !r.firstTrade) return null; const t = r.firstTrade; return (t.side === o.winner ? 100 : 0) - t.avgCents - (t.feeCents || 0); };
const paired = {};
for (const pid of policies.filter(p => p !== 'A-2.6')) {
  let aOnly = 0, cOnly = 0, vetoN = 0, vetoLostA = 0, fPairs = [];
  for (const o of scored) {
    const la = lostOf(o, 'A-2.6'), lc = lostOf(o, pid);
    if (la && !lc) aOnly++; if (lc && !la) cOnly++;
    if (lockedOf(o, 'A-2.6') && !lockedOf(o, pid)) { vetoN++; if (la) vetoLostA++; }
    const pa = pnlOf(o, 'A-2.6'); if (pa != null) fPairs.push([pa, pnlOf(o, pid) ?? 0]);
  }
  const n = aOnly + cOnly;
  const sA = summary['A-2.6'], sC = summary[pid];
  paired[pid] = { discordantLosses: { aOnly, candidateOnly: cOnly }, pCandidateWorse: n ? binomSf(cOnly, n) : null, pCandidateBetter: n ? binomSf(aOnly, n) : null,
    coverageDeltaPp: sA.coveragePct != null && sC.coveragePct != null ? +(sC.coveragePct - sA.coveragePct).toFixed(3) : null,
    leadDeltaS: sA.leadMeanS != null && sC.leadMeanS != null ? +(sC.leadMeanS - sA.leadMeanS).toFixed(2) : null,
    tradesRatio: sA.trades ? +(sC.trades / sA.trades).toFixed(3) : null,
    vetoed: { windows: vetoN, aLostThere: vetoLostA, aOverallLossRate: sA.locked ? sA.lost / sA.locked : null, pVetoedWorse: vetoN && sA.locked ? binomSf(vetoLostA, vetoN, Math.max(1e-9, sA.lost / sA.locked)) : null },
    pnlPairsOnATrades: fPairs.length ? { n: fPairs.length, meanA: +(fPairs.reduce((a, x) => a + x[0], 0) / fPairs.length).toFixed(3), meanCandidate: +(fPairs.reduce((a, x) => a + x[1], 0) / fPairs.length).toFixed(3) } : null };
}
/* Holm adjustment over the five candidates' "better" p-values (objective-specific) */
const objP = { 'C1-strict-0.2': paired['C1-strict-0.2'].pCandidateBetter, 'C2-no-active-recal': paired['C2-no-active-recal'].pCandidateBetter,
  'D-impulse-veto': paired['D-impulse-veto'].vetoed.pVetoedWorse, 'E-official-ensemble': paired['E-official-ensemble'].pCandidateBetter, 'F-market-pooled-value': null };
const ps = Object.entries(objP).filter(([, p]) => p != null).sort((a, b) => a[1] - b[1]); const holm = {};
ps.forEach(([k, p], i) => { holm[k] = Math.min(1, p * (ps.length - i)); });
/* ---- calibration from the tape ---- */
let calib = null;
const TAPE = arg('tape');
if (TAPE) {
  const winner = new Map(scored.map(o => [o.ticker, o.winner]));
  const byT = new Map();
  for (const r of readNd(TAPE)) if (r.k === 'd' && r.out && r.out.pWin != null && r.kal && winner.has(r.kal.ticker) && r.ts >= SINCE) {
    const tau = (r.kal.closeMs - r.ts) / 1000, pUp = r.out.side === 'UP' ? r.out.pWin : 1 - r.out.pWin;
    (byT.get(r.kal.ticker) || byT.set(r.kal.ticker, []).get(r.kal.ticker)).push({ tau, pUp });
  }
  calib = { windows: byT.size, fixedTau: {}, bands: {} };
  for (const tt of [60, 30, 10]) {
    const pts = [];
    for (const [tk, arr] of byT) { let best = null; for (const x of arr) if (Math.abs(x.tau - tt) <= 0.6 && (!best || Math.abs(x.tau - tt) < Math.abs(best.tau - tt))) best = x; if (best) pts.push([best.pUp, winner.get(tk) === 'UP' ? 1 : 0]); }
    if (!pts.length) continue;
    const brier = pts.reduce((a, [p, y]) => a + (p - y) * (p - y), 0) / pts.length;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const [p, y] of pts) { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += y; }
    const ece = bins.reduce((a, b) => a + (b.n ? Math.abs(b.p / b.n - b.y / b.n) * b.n : 0), 0) / pts.length;
    calib.fixedTau[tt] = { n: pts.length, brier: +brier.toFixed(5), ecePp: +(100 * ece).toFixed(3) };
  }
  let O = 0, E = 0;
  for (const [lo, hi] of [[0.002, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.05]]) {
    let o = 0, e = 0, n = 0;
    for (const [tk, arr] of byT) {
      const s = [...arr].sort((a, b) => b.tau - a.tau).find(x => { const f = Math.min(x.pUp, 1 - x.pUp); return f >= lo && f < hi && x.tau <= 300; });
      if (!s) continue; n++; const lead = s.pUp >= 0.5 ? 'UP' : 'DOWN'; e += Math.min(s.pUp, 1 - s.pUp); if (lead !== winner.get(tk)) o++;
    }
    calib.bands[`${100 * lo}-${100 * hi}%`] = { n, observed: o, expected: +e.toFixed(3) }; O += o; E += e;
  }
  const ci = poisCi(O); calib.pooled = { observed: O, expected: +E.toFixed(3), oOverE: E ? +(O / E).toFixed(3) : null, ci95: E ? [+(ci[0] / E).toFixed(3), +(ci[1] / E).toFixed(3)] : null };
}
/* ---- latency ---- */
let lat = null; const LAT = arg('latency');
if (LAT) { const j = JSON.parse(fs.readFileSync(LAT, 'utf8')); lat = j.latency || j; }
/* ---- gates (PREREGISTRATION.md section 4) ---- */
const A = summary['A-2.6'], g = {};
const windowsScored = scored.length;
g.G1 = { status: 'run separately', how: 'bash pinradar-research/2.8/test/run_all28.sh and GET /selftest' };
g.G2 = { pass: segVerify.every(v => v.ok) && issues.callAfterOutcome === 0 && issues.missingCommit === 0 && (windowsScored ? issues.unresolved / (windowsScored + issues.unresolved) < 0.02 : true),
  segments: segVerify, issues };
let lossRun = 0; { const seq = scored.filter(o => lockedOf(o, 'A-2.6')).map(o => lostOf(o, 'A-2.6') ? 1 : 0); for (let i = 0; i < seq.length; i++) { let s = 0; for (let j = Math.max(0, i - 199); j <= i; j++) s += seq[j]; lossRun = Math.max(lossRun, s); } }
g.G3 = { locked: A.locked, lost: A.lost, cp95UpperPct: A.lossCp95UpperPct,
  stage1: A.locked >= 700 ? (A.lossCp95UpperPct <= 1.0 ? 'PASS' : 'FAIL') : `pending (${A.locked}/700 LOCKED windows)`,
  stage2: A.locked >= 1500 ? (A.lossCp95UpperPct <= 0.75 ? 'PASS' : 'FAIL') : `pending (${A.locked}/1500)`,
  stopRule: { failureAlarm: A.failure.alarm, eValue: A.failure.eValue, maxLossesIn200: lossRun, triggered: A.failure.alarm || lossRun > 3 } };
g.G4 = { coveragePct: A.coveragePct, leadMeanS: A.leadMeanS, pass: windowsScored ? (A.coveragePct >= 85 && A.leadMeanS >= 60) : null };
g.G5 = calib ? { ...calib, pass: Object.values(calib.fixedTau).every(x => x.ecePp <= 1.5) && (!calib.pooled.ci95 || calib.pooled.ci95[0] <= 1.25) } : { status: 'needs --tape' };
g.G6 = lat ? { pass: (lat.decisionIndexInputAgeMs ? lat.decisionIndexInputAgeMs.p99 <= 3000 : true) && (lat.bgSnapshotMs ? lat.bgSnapshotMs.p99 <= 25 : true)
  && (lat.radarComputeMs ? lat.radarComputeMs.p99 <= 50 : true) && (lat.clientSignalAgeAtDisplayMs ? lat.clientSignalAgeAtDisplayMs.p99 <= 1500 : true), latency: lat } : { status: 'needs --latency (save GET /latency)' };
g.G7 = { edge: A.edge, trades: A.trades, tradeLosses: A.tradeLosses, meanCents: A.pnlCentsPerContractMean, claim: A.edge.proven ? 'edge established on visible-book (hypothetical) fills' : 'TRADE NOW profitability UNPROVEN' };
const minPeriodMet = A.locked >= 1500 && scored.length && (scored[scored.length - 1].closeMs - scored[0].closeMs) >= 21 * 86400000;
const verdict = (!g.G2.pass || g.G3.stopRule.triggered || g.G3.stage1 === 'FAIL') ? 'FAIL'
  : (!minPeriodMet ? 'IN PROGRESS (minimum period: 21 days and 1,500 LOCKED windows)'
    : (g.G3.stage2 === 'PASS' && g.G4.pass && g.G5.pass !== false && g.G6.pass !== false ? 'PASS (decision support)' + (A.edge.proven ? ' + edge on hypothetical fills' : '; TRADE NOW profitability unproven') : 'FAIL'));
const report = { prereg: 'pinradar-2.8-prereg-v1', generated: new Date().toISOString(), ledgerRows: rows.length, segments: segs.length, windowsScored, since: SINCE || null, configRequired: CONF || null,
  verdict, gates: g, policies: summary, paired, holmAdjusted: holm };
if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 1));
console.log(`forward report (${report.prereg}): ${windowsScored} scored windows, ${segs.length} chain segment(s), verdict: ${verdict}`);
console.log(`  A-2.6: LOCKED ${A.locked}, lost ${A.lost}, CP95 upper ${A.lossCp95UpperPct}% · coverage ${A.coveragePct}% · lead ${A.leadMeanS}s · failure e=${A.failure.eValue}${A.failure.alarm ? ' ALARM' : ''}`);
console.log(`  TRADE NOW (hypothetical fills): ${A.trades} trades, ${A.tradeLosses} lost, mean ${A.pnlCentsPerContractMean}c/contract, edge e=${A.edge.eValue} -> ${g.G7.claim}`);
for (const pid of policies.filter(p => p !== 'A-2.6')) { const s = summary[pid], pr = paired[pid]; console.log(`  ${pid.padEnd(22)} LOCKED ${s.locked} lost ${s.lost} · lead ${s.leadMeanS}s · trades ${s.trades} · discordant A-only ${pr.discordantLosses.aOnly} / cand-only ${pr.discordantLosses.candidateOnly}`); }
console.log(`  gates: G2 ${g.G2.pass ? 'PASS' : 'FAIL'} · G3 stage1 ${g.G3.stage1} · stage2 ${g.G3.stage2} · G4 ${g.G4.pass} · G5 ${g.G5.pass ?? g.G5.status} · G6 ${g.G6.pass ?? g.G6.status}`);
process.exit(verdict === 'FAIL' ? 1 : 0);
