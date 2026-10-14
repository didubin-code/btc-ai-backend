#!/usr/bin/env node
/* Independent forward-test evaluation of Pin Radar 2.8 from its hash-chained ledger (and optionally the
   record/replay tape and a /latency snapshot), exactly as pre-registered in PREREGISTRATION.md
   (pinradar-2.8-prereg-v2). Does not trust any summary computed by the server: everything is recomputed from
   committed entries. The evidence for a window is each policy's FIRST committed call (ledger 'call' entries,
   earlier than the outcome), never the outcome's own copy; calibration (G5) is read from the committed 'calib'
   entries (the tape is only a fallback). A chain may restart only at seq 1 from its boot genesis: any other break,
   gap, unparsable row or unanchored start fails G2.
   No gate passes by default: missing evidence (G1 not attested, too little calibration coverage, a missing latency
   series) makes the verdict INCOMPLETE, never PASS. Only the first 90 days of outcomes are scored.
   usage: node tools/forward_report28.js --ledger ledger28.ndjson [--g1 PASS] [--tape tape.ndjson] [--latency latency.json]
                                         [--config <CONFIG28_HASH>] [--since <ms epoch>] [--anchor <hash>[,<hash>...]]
                                         [--out report.json]
   --g1 PASS = you ran run_all28.sh and GET /selftest on the deployed build and both passed (G1 is an attestation).   */
'use strict';
const fs = require('fs'), path = require('path');
const C = require(path.join(__dirname, '..', 'src', 'core28.js'));
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
/* a final line without a newline may be a write in progress (or cut by a crash): reported, not fatal; any other
   unparsable line is an integrity failure */
function readNd(f) {
  const text = fs.readFileSync(f, 'utf8'), parts = text.split('\n'), rows = [], bad = [];
  const tornTail = parts.length && parts[parts.length - 1] !== '' ? parts.pop() : (parts.pop(), null);
  parts.forEach((l, i) => { if (!l.trim()) return; try { rows.push(JSON.parse(l)); } catch (_) { bad.push(i + 1); } });
  return { rows, bad, tornTail: tornTail ? tornTail.length : 0 };
}
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
const ND = readNd(LEDGER), rows = ND.rows, SINCE = Number(arg('since') || 0), CONF = arg('config');
const ANCHORS = (arg('anchor') || '').split(',').map(x => x.trim()).filter(Boolean);
/* ---- chain segments: a new chain begins only at seq 1, anchored at its boot entry's genesis ---- */
const segs = []; let cur = null;
rows.forEach((e, i) => { Object.defineProperty(e, '_i', { value: i, enumerable: false }); });   // file position: the only order valid across restarts (seq restarts at 1)
for (const e of rows) { if (!cur || e.seq === 1) { cur = []; segs.push(cur); } cur.push(e); }
const segVerify = segs.map(s => {
  const v = C.verifyLedger28(s, s[0].seq === 1 ? s[0].prev : null);
  const b = s[0].body || {};
  const anchored = s[0].seq === 1 && s[0].type === 'boot' && s[0].prev === C.sha28('genesis|pinradar-2.8|' + b.configHash);
  return { ...v, firstSeq: s[0].seq, lastSeq: s[s.length - 1].seq, head: s[s.length - 1].hash, anchored, ok: v.ok && anchored, ...(anchored ? {} : { why: v.ok ? 'segment does not start at a boot genesis (earlier entries missing)' : v.why }) };
});
const hashIdx = new Map(rows.map(e => [e.hash, e._i]));
const anchorsMissing = ANCHORS.filter(h => !hashIdx.has(h));
/* a chain proves internal consistency only: a whole segment can be deleted or fabricated by whoever holds the file
   (the genesis formula is public). Only heads published outside the file (--anchor) rule that out: every segment
   must contain one, and the last one must come after the last scored outcome. Segments must also be in time order. */
const anchorIdx = ANCHORS.filter(h => hashIdx.has(h)).map(h => hashIdx.get(h));
segVerify.forEach((v, k) => { const a = segs[k][0]._i, z = segs[k][segs[k].length - 1]._i; v.hasAnchor = anchorIdx.some(i => i >= a && i <= z); });
const segOrderOk = segs.every((sg, k) => k === 0 || (sg[0].ts || 0) >= (segs[k - 1][segs[k - 1].length - 1].ts || 0));
/* ---- windows: first committed call per ticker|policy|event (across segments, i.e. across restarts) ---- */
const issues = { callAfterOutcome: 0, missingCommit: 0, recordMismatch: 0, wrongConfig: 0, configSpan: 0, unresolved: 0, droppedWindows: 0, duplicateOutcome: 0, segmentsOutOfOrder: segOrderOk ? 0 : 1,
  unparsableRows: ND.bad.length, tornFinalLine: ND.tornTail, anchorsMissing: anchorsMissing.length };
const calls = new Map(), opened = new Map(), outcomeTickers = new Set(), resolvedOrUnres = new Set();
const calibs = new Map();                                  // ticker -> [{seq, body}]
let lastTs = 0, boot = null;
let scored = [];
const latencyEntries = [];
for (const seg of segs) {
  boot = null;
  for (const e of seg) {
    lastTs = Math.max(lastTs, e.ts || 0);
    const b = e.body || {};
    if (e.type === 'boot') boot = b;
    /* a window belongs to the configuration in force when it was opened (its calls were made under it) */
    if (e.type === 'window' && !opened.has(b.ticker)) opened.set(b.ticker, { closeMs: b.closeMs, idx: e._i, config: boot ? boot.configHash : null });
    if (e.type === 'call') { const k = b.ticker + '|' + b.policy + '|' + b.event; if (!calls.has(k)) calls.set(k, e); if (!opened.has(b.ticker)) opened.set(b.ticker, { closeMs: b.closeMs, idx: e._i, config: boot ? boot.configHash : null }); }
    if (e.type === 'calib') (calibs.get(b.ticker) || calibs.set(b.ticker, []).get(b.ticker)).push(e);
    if (e.type === 'latency' && e.ts >= SINCE && (!CONF || (boot && boot.configHash === CONF))) latencyEntries.push(e);
    if (e.type === 'unresolved') { resolvedOrUnres.add(b.ticker); if (e.ts >= SINCE) issues.unresolved++; }
    if (e.type !== 'outcome') continue;
    resolvedOrUnres.add(b.ticker);
    if (outcomeTickers.has(b.ticker)) { issues.duplicateOutcome++; continue; }   // a re-pulled or forked copy never counts twice
    outcomeTickers.add(b.ticker);
    if (e.ts < SINCE) continue;
    const op = opened.get(b.ticker), wConf = op && op.config != null ? op.config : (boot ? boot.configHash : null);
    if (op && boot && op.config != null && op.config !== boot.configHash) issues.configSpan++;   // calls under one config, outcome under another (reported)
    if (CONF && wConf !== CONF) { issues.wrongConfig++; continue; }
    const recs = {};
    for (const pid of C.SHADOW_POLICIES28.map(p => p.id)) {
      const own = (b.records || {})[pid] || null, r = { firstLock: null, firstTrade: null, firstReversal: null };
      for (const ev of ['firstLock', 'firstTrade', 'firstReversal']) {
        const c = calls.get(b.ticker + '|' + pid + '|' + ev);
        if (c && c._i < e._i) r[ev] = c.body.rec; else if (c) issues.callAfterOutcome++;
        if (own && own[ev] && !c) issues.missingCommit++;                         // scored by the server but never committed
        if (ev !== 'firstReversal' && c && c._i < e._i && C.canon28(own && own[ev] || null) !== C.canon28(c.body.rec)) issues.recordMismatch++;
      }
      recs[pid] = r.firstLock || r.firstTrade || r.firstReversal ? r : null;
    }
    scored.push({ ...b, records: recs, outcomeSeq: e.seq, outcomeIdx: e._i });
  }
}
/* a window with committed calls (or a window entry) but neither an outcome nor an 'unresolved' entry, 45 min after
   its close, was dropped (e.g. by a restart): it counts as unresolved */
for (const [tk, w] of opened) if (!resolvedOrUnres.has(tk) && Number.isFinite(w.closeMs) && lastTs - w.closeMs > 45 * 60000 && w.closeMs >= SINCE) { issues.droppedWindows++; issues.unresolved++; }
/* pre-registered maximum: 90 days from the first scored window */
const T90 = scored.length ? scored[0].closeMs + 90 * 86400000 : Infinity;
issues.beyond90Days = scored.filter(o => o.closeMs > T90).length;
scored = scored.filter(o => o.closeMs <= T90);
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
/* F's objective (prereg v2 section 5): on windows where A traded, the trades F declined lost money on balance.
   Exact one-sided binomial: losses among A's trades that F declined vs the mean break-even loss rate of those trades
   ((100 - avg - fee)/100 per trade); p = 1 unless F's paired total is at least A's (no lower total). */
{
  let n = 0, lost = 0, q = 0, totA = 0, totF = 0;
  for (const o of scored) {
    const pa = pnlOf(o, 'A-2.6'); if (pa == null) continue;
    const pf = pnlOf(o, 'F-market-pooled-value'); totA += pa; totF += pf ?? 0;
    if (pf == null) { const t = o.records['A-2.6'].firstTrade; n++; if (t.side !== o.winner) lost++; q += Math.max(1e-9, (100 - t.avgCents - (t.feeCents || 0)) / 100); }
  }
  paired['F-market-pooled-value'].declined = { n, aLostThere: lost, breakEvenLossRate: n ? +(q / n).toFixed(5) : null, totalA: +totA.toFixed(3), totalF: +totF.toFixed(3),
    pDeclinedWorse: n ? (totF >= totA ? binomSf(lost, n, q / n) : 1) : null };
}
/* Holm step-down over ALL five candidates (an objective with no data has p = 1: it cannot be adopted and still counts in m) */
const objP = { 'C1-strict-0.2': paired['C1-strict-0.2'].pCandidateBetter, 'C2-no-active-recal': paired['C2-no-active-recal'].pCandidateBetter,
  'D-impulse-veto': paired['D-impulse-veto'].vetoed.pVetoedWorse, 'E-official-ensemble': paired['E-official-ensemble'].pCandidateBetter,
  'F-market-pooled-value': paired['F-market-pooled-value'].declined.pDeclinedWorse };
const holm = C.holm28(objP);
/* ---- calibration (G5): committed 'calib' entries; the tape only when the ledger has none ---- */
let calib = null;
const TAPE = arg('tape');
const winner = new Map(scored.map(o => [o.ticker, o.winner])), outIdx = new Map(scored.map(o => [o.ticker, o.outcomeIdx]));
const fromLedger = scored.some(o => calibs.has(o.ticker));
if (fromLedger || TAPE) {
  const tauPts = { 60: [], 30: [], 10: [] }, bandFirst = new Map();     // ticker -> {band: pUp}
  if (fromLedger) {
    for (const [tk, arr] of calibs) {
      if (!winner.has(tk)) continue;
      const seen = new Set();
      for (const e of arr) {
        if (e._i > outIdx.get(tk)) continue;                               // committed before the outcome only (file order)
        const b = e.body; if (b.pUp == null || b.state === 'DATA UNRELIABLE') continue;
        const key = b.kind === 'tau' ? 't' + b.target : 'b' + b.band; if (seen.has(key)) continue; seen.add(key);
        if (b.kind === 'tau' && tauPts[b.target]) tauPts[b.target].push([b.pUp, winner.get(tk) === 'UP' ? 1 : 0]);
        if (b.kind === 'band') (bandFirst.get(tk) || bandFirst.set(tk, {}).get(tk))[b.band] = b.pUp;
      }
    }
  } else {
    const byT = new Map();
    for (const r of readNd(TAPE).rows) if (r.k === 'd' && r.out && r.out.pWin != null && r.out.state !== 'DATA UNRELIABLE' && r.kal && winner.has(r.kal.ticker) && r.ts >= SINCE) {
      const tau = (r.kal.closeMs - r.ts) / 1000, pUp = r.out.side === 'UP' ? r.out.pWin : 1 - r.out.pWin;
      (byT.get(r.kal.ticker) || byT.set(r.kal.ticker, []).get(r.kal.ticker)).push({ tau, pUp });
    }
    for (const tt of [60, 30, 10]) for (const [tk, arr] of byT) { let best = null; for (const x of arr) if (Math.abs(x.tau - tt) <= 0.6 && (!best || Math.abs(x.tau - tt) < Math.abs(best.tau - tt))) best = x; if (best) tauPts[tt].push([best.pUp, winner.get(tk) === 'UP' ? 1 : 0]); }
    for (const [tk, arr] of byT) for (const [lo, hi] of [[0.002, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.05]]) {
      const s = [...arr].sort((a, b) => b.tau - a.tau).find(x => { const f = Math.min(x.pUp, 1 - x.pUp); return f >= lo && f < hi && x.tau <= 300; });
      if (s) (bandFirst.get(tk) || bandFirst.set(tk, {}).get(tk))[`${100 * lo}-${100 * hi}%`] = s.pUp;
    }
  }
  calib = { source: fromLedger ? 'ledger calib commitments' : 'tape (fallback: may be partial)', windowsWithTau60: tauPts[60].length, scoredWindows: scored.length,
    coveragePct: scored.length ? +(100 * tauPts[60].length / scored.length).toFixed(2) : null, fixedTau: {}, bands: {} };
  for (const tt of [60, 30, 10]) {
    const pts = tauPts[tt];
    if (!pts.length) continue;
    const brier = pts.reduce((a, [p, y]) => a + (p - y) * (p - y), 0) / pts.length;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
    for (const [p, y] of pts) { const b = bins[Math.min(9, Math.floor(p * 10))]; b.n++; b.p += p; b.y += y; }
    const ece = bins.reduce((a, b) => a + (b.n ? Math.abs(b.p / b.n - b.y / b.n) * b.n : 0), 0) / pts.length;
    calib.fixedTau[tt] = { n: pts.length, brier: +brier.toFixed(5), ecePp: +(100 * ece).toFixed(3) };
  }
  let O = 0, E = 0;
  for (const [lo, hi] of [[0.002, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.05]]) {
    let o = 0, e = 0, n = 0; const k = `${100 * lo}-${100 * hi}%`;
    for (const [tk, m] of bandFirst) {
      const p = m[k]; if (p == null) continue;
      n++; const lead = p >= 0.5 ? 'UP' : 'DOWN'; e += Math.min(p, 1 - p); if (lead !== winner.get(tk)) o++;
    }
    calib.bands[`${100 * lo}-${100 * hi}%`] = { n, observed: o, expected: +e.toFixed(3) }; O += o; E += e;
  }
  const ci = poisCi(O); calib.pooled = { observed: O, expected: +E.toFixed(3), oOverE: E ? +(O / E).toFixed(3) : null, ci95: E ? [+(ci[0] / E).toFixed(3), +(ci[1] / E).toFixed(3)] : null };
}
/* ---- latency: hourly histograms committed to the ledger (whole period); a /latency snapshot only as a fallback ---- */
let lat = null, latSource = null; const LAT = arg('latency');
const LAT_KEYS = ['decisionIndexInputAgeMs', 'bgSnapshotMs', 'radarComputeMs', 'clientSignalAgeAtDisplayMs'];
if (latencyEntries.length) {
  lat = {}; latSource = `ledger: ${latencyEntries.length} hourly histograms`;
  for (const k of LAT_KEYS) { const pairs = latencyEntries.flatMap(e => (e.body.hist || {})[k] || []); const q = C.latHistQuantile28(pairs, 0.99); if (q) lat[k] = { n: q.n, p99: q.value }; }
} else if (LAT) { const j = JSON.parse(fs.readFileSync(LAT, 'utf8')); lat = j.latency || j; latSource = 'snapshot of GET /latency (rolling buffer: covers only the last ~3,000 samples)'; }
/* ---- gates (PREREGISTRATION.md section 4) ---- */
const A = summary['A-2.6'], g = {};
const windowsScored = scored.length;
const G1 = String(arg('g1') || '').toUpperCase();
g.G1 = { attested: G1 === 'PASS', failed: G1 === 'FAIL', how: 'bash pinradar-research/2.8/test/run_all28.sh and GET /selftest on the deployed build; then --g1 PASS (or FAIL)' };
const lastScoredIdx = scored.length ? scored[scored.length - 1].outcomeIdx : -1;
const anchoredAll = ANCHORS.length > 0 && segVerify.every(v => v.hasAnchor) && Math.max(-1, ...anchorIdx) >= lastScoredIdx;
g.G2 = { anchoredAll, anchorsGiven: ANCHORS.length,
  pass: segVerify.length > 0 && segVerify.every(v => v.ok) && segOrderOk && issues.unparsableRows === 0 && issues.anchorsMissing === 0 && issues.callAfterOutcome === 0 && issues.missingCommit === 0
  && (windowsScored ? issues.unresolved / (windowsScored + issues.unresolved) < 0.02 : true),
  segments: segVerify, issues, anchorsMissing, note: 'recordMismatch/duplicateOutcome are reported, not failed: windows are scored from the committed calls, each ticker once' };
let lossRun = 0; { const seq = scored.filter(o => lockedOf(o, 'A-2.6')).map(o => lostOf(o, 'A-2.6') ? 1 : 0); for (let i = 0; i < seq.length; i++) { let s = 0; for (let j = Math.max(0, i - 199); j <= i; j++) s += seq[j]; lossRun = Math.max(lossRun, s); } }
/* G3 (prereg v2): FAIL only on evidence of harm (stop rule); success = one-sided 95 % CP upper <= 0.75 % at >= 3,000
   LOCKED windows (85 % power at the dev rate 0.37 %); fewer windows at the 90-day cap or a higher bound = NOT DEMONSTRATED */
g.G3 = { locked: A.locked, lost: A.lost, cp95UpperPct: A.lossCp95UpperPct,
  interim700: A.locked >= 700 ? `upper ${A.lossCp95UpperPct}% (informational)` : `pending (${A.locked}/700)`,
  final: A.locked >= 3000 || issues.beyond90Days > 0 ? (A.lossCp95UpperPct != null && A.lossCp95UpperPct <= 0.75 ? 'PASS' : 'NOT DEMONSTRATED') : `pending (${A.locked}/3000 LOCKED windows)`,
  stopRule: { failureAlarm: A.failure.alarm, eValue: A.failure.eValue, supEValue: A.failure.supEValue, firstAlarmAtWindow: A.failure.firstAlarmAtWindow, maxLossesIn200: lossRun,
    triggered: A.failure.alarm || lossRun > 3 } };                       // alarm = latched: e reached 20 at ANY point (Ville)
g.G4 = { coveragePct: A.coveragePct, leadMeanS: A.leadMeanS, pass: windowsScored ? (A.coveragePct >= 85 && A.leadMeanS >= 60) : null };
/* G5 needs calibration points for >= 85 % of scored windows at each of tau 60/30/10 s */
const g5cov = calib ? Object.fromEntries([60, 30, 10].map(t => [t, windowsScored ? +(100 * ((calib.fixedTau[t] || {}).n || 0) / windowsScored).toFixed(2) : 0])) : null;
const g5ok = !!calib && windowsScored > 0 && Object.values(g5cov).every(c => c >= 85) && !!calib.pooled;
g.G5 = calib ? { ...calib, coverageByTauPct: g5cov, sufficient: g5ok,
  pass: g5ok ? Object.values(calib.fixedTau).every(x => x.ecePp <= 1.5) && (!calib.pooled.ci95 || calib.pooled.ci95[0] <= 1.25) : null } : { sufficient: false, pass: null, status: 'no calibration evidence (ledger calib entries or --tape)' };
const G6_KEYS = ['decisionIndexInputAgeMs', 'bgSnapshotMs', 'radarComputeMs'];
const latMissing = G6_KEYS.filter(k => !(lat && lat[k] && Number.isFinite(lat[k].p99)));
g.G6 = { source: latSource, missing: latMissing, sufficient: !!lat && latMissing.length === 0,
  pass: lat && latMissing.length === 0 ? lat.decisionIndexInputAgeMs.p99 <= 3000 && lat.bgSnapshotMs.p99 <= 25 && lat.radarComputeMs.p99 <= 50 : null,
  informational: { clientSignalAgeAtDisplayMs: lat && lat.clientSignalAgeAtDisplayMs || null, target: 'p99 <= 1500 ms', note: 'reported by browsers: unauthenticated, so it cannot decide a gate (any client can post values); clamped and rate-limited by the server' },
  latency: lat };
g.G7 = { edge: A.edge, trades: A.trades, tradeLosses: A.tradeLosses, meanCents: A.pnlCentsPerContractMean, claim: A.edge.proven ? 'edge established on visible-book (hypothetical) fills' : 'TRADE NOW profitability UNPROVEN' };
const spanDays = scored.length ? (scored[scored.length - 1].closeMs - scored[0].closeMs) / 86400000 : 0;
const ended = issues.beyond90Days > 0 || (A.locked >= 3000 && spanDays >= 21);
const missing = [!g.G1.attested && 'G1 attestation (--g1 PASS)', !g.G2.anchoredAll && 'G2 published anchors (--anchor: one per chain segment, the last after the last outcome)',
  !g.G5.sufficient && 'G5 calibration coverage', !g.G6.sufficient && `G6 latency (${latMissing.join(', ') || 'no data'})`].filter(Boolean);
const failed = [g.G1.failed && 'G1', g.G4.pass === false && 'G4', g.G5.pass === false && 'G5', g.G6.pass === false && 'G6'].filter(Boolean);
const verdict = (!g.G2.pass || g.G3.stopRule.triggered) ? 'FAIL' + (!g.G2.pass ? ' (G2 integrity)' : ' (G3c stop rule)')
  : (!ended ? `IN PROGRESS (${A.locked}/3,000 LOCKED windows, ${spanDays.toFixed(1)}/21 days; maximum 90 days)`
    : (failed.length ? `FAIL (${failed.join(', ')})`
      : (g.G3.final !== 'PASS' ? 'NOT DEMONSTRATED (G3: reliability bound not reached)'
        : (missing.length ? `INCOMPLETE (missing: ${missing.join('; ')})`
          : 'PASS (decision support)' + (A.edge.proven ? ' + edge on hypothetical fills' : '; TRADE NOW profitability unproven')))));
/* ---- candidate verdicts (PREREGISTRATION section 5): not worse on discordant pairs, the stated constraints, the
   objective at Holm-adjusted 0.05 over five, and the candidate's own G3 and G4; G1, G2 and G6 are shared system gates;
   G5 cannot be measured per candidate (only production's displayed probability is committed) ---- */
const candidates = {};
for (const pid of policies.filter(p => p !== 'A-2.6')) {
  const pr = paired[pid], sC = summary[pid];
  const notWorse = !(pr.pCandidateWorse != null && pr.pCandidateWorse <= 0.05);
  const constraints = { 'C1-strict-0.2': pr.coverageDeltaPp != null && pr.coverageDeltaPp >= -2 && pr.leadDeltaS != null && pr.leadDeltaS >= -25,
    'C2-no-active-recal': pr.tradesRatio != null && pr.tradesRatio >= 0.85, 'D-impulse-veto': true,
    'E-official-ensemble': pr.coverageDeltaPp != null && pr.coverageDeltaPp >= -1, 'F-market-pooled-value': true }[pid];
  const G3c = sC.locked >= 3000 || issues.beyond90Days > 0 ? sC.lossCp95UpperPct != null && sC.lossCp95UpperPct <= 0.75 : null;
  const G4c = windowsScored ? sC.coveragePct >= 85 && sC.leadMeanS >= 60 : null;
  const objective = holm[pid] <= 0.05;
  candidates[pid] = { notWorse, pCandidateWorse: pr.pCandidateWorse, constraints, objectiveHolmP: holm[pid], objective, G3: G3c, G4: G4c,
    adopt: !!(notWorse && constraints && objective && G3c === true && G4c === true && g.G1.attested && g.G2.pass && g.G2.anchoredAll && g.G6.pass === true) };
}
const report = { prereg: 'pinradar-2.8-prereg-v2', generated: new Date().toISOString(), ledgerRows: rows.length, segments: segs.length, windowsScored, since: SINCE || null, configRequired: CONF || null,
  verdict, gates: g, policies: summary, paired, holmAdjusted: holm, candidates };
if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(report, null, 1));
console.log(`forward report (${report.prereg}): ${windowsScored} scored windows, ${segs.length} chain segment(s), verdict: ${verdict}`);
if (!g.G2.pass) console.log(`  G2 FAIL: ${JSON.stringify({ segments: segVerify.filter(v => !v.ok).map(v => ({ first: v.firstSeq, at: v.at, why: v.why })), ...issues })}`);
console.log(`  A-2.6: LOCKED ${A.locked}, lost ${A.lost}, CP95 upper ${A.lossCp95UpperPct}% · coverage ${A.coveragePct}% · lead ${A.leadMeanS}s · failure e=${A.failure.eValue}${A.failure.alarm ? ' ALARM' : ''}`);
console.log(`  TRADE NOW (hypothetical fills): ${A.trades} trades, ${A.tradeLosses} lost, mean ${A.pnlCentsPerContractMean}c/contract, edge e=${A.edge.eValue} -> ${g.G7.claim}`);
for (const pid of policies.filter(p => p !== 'A-2.6')) { const s = summary[pid], pr = paired[pid]; console.log(`  ${pid.padEnd(22)} LOCKED ${s.locked} lost ${s.lost} · lead ${s.leadMeanS}s · trades ${s.trades} · discordant A-only ${pr.discordantLosses.aOnly} / cand-only ${pr.discordantLosses.candidateOnly}`); }
console.log(`  gates: G1 ${g.G1.attested ? 'attested' : (g.G1.failed ? 'FAIL' : 'not attested')} · G2 ${g.G2.pass ? 'PASS' : 'FAIL'} · G3 ${g.G3.final} (interim ${g.G3.interim700}) · G4 ${g.G4.pass} · G5 ${g.G5.sufficient ? g.G5.pass : 'insufficient'} · G6 ${g.G6.sufficient ? g.G6.pass : 'insufficient: ' + latMissing.join(',')}`);
process.exit(/^FAIL/.test(verdict) ? 1 : 0);
