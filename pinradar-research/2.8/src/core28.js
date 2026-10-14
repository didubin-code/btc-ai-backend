/* =====================================================================
   PIN RADAR 2.8 — CORE (pure functions; inlined into pinradar_server.js by
   build/build_server28.py and also require()d directly by the tests and the
   forward-test tools, so the shipped code is the code that is tested).

   2.8 does NOT change the 2.6 probability engine, the LOCKED threshold or
   the TRADE NOW rule. Everything here is one of:
     ECONOMICS   fee schedule from Kalshi's series record (not hard-coded),
                 exact integer fee arithmetic, per-size expected-value ladder;
     HONESTY     probability uncertainty band from measured calibration drift,
                 PREDICTED LOCKED / MATHEMATICALLY FINAL / OFFICIALLY SETTLED;
     EVIDENCE    hash-chained append-only ledger (commit before outcome),
                 anytime-valid e-processes (failure-rate alarm, proof of edge),
                 shadow policies evaluated on identical live inputs;
     OPERATIONS  latency percentiles, record-and-replay input tape.
   ===================================================================== */
'use strict';
const CORE28_VERSION = 'core28-1.1.0';
const crypto28 = require('crypto');

/* ---------------------------------------------------------------- fees
   Kalshi quadratic trade fee: mult * C * P * (1 - P) dollars, rounded UP.
   Third-party sources disagree on the rounding unit (whole cent vs $0.0001)
   and on maker fees per series; neither could be verified from this
   environment. Defaults are the conservative reading (taker 0.07, maker 0,
   cent rounding), and the live server replaces mult/maker from
   GET /series/KXBTC15M (fee_type, fee_multiplier) when Kalshi answers.
   Exact integer arithmetic (BigInt): price in $0.0001 units (pc4), multiplier
   in 1e-6 units, so 0.07 * 10 * 0.99 * 0.01 is never 0.0069300000001. */
function feeCfg28(over = {}) {
  return Object.assign({ takerMult: 0.07, makerMult: 0, seriesMultiplier: 1, rounding: 'cent', perFill: false,
    feeType: null, source: 'default (unverified: Kalshi series record not read)' }, over);
}
/* total fee in dollars for C contracts at price `priceCents` (may be fractional, e.g. 99.5) */
/* contract counts may be fractional on Kalshi's fixed-point book (e.g. "1035.60"): counted in 0.01-contract units */
function feeDollars28(priceCents, C, cfg = feeCfg28(), maker = false) {
  const c100 = Math.round(Number(C) * 100);
  if (!(c100 > 0) || !Number.isFinite(priceCents)) return 0;
  const pc4 = Math.round(priceCents * 100);                     // $0.0001 units
  if (pc4 <= 0 || pc4 >= 10000) return 0;
  const mult = (maker ? cfg.makerMult : cfg.takerMult) * (Number.isFinite(cfg.seriesMultiplier) ? cfg.seriesMultiplier : 1);
  if (!(mult > 0)) return 0;
  const m6 = BigInt(Math.round(mult * 1e6));                    // 1e-6 units
  const num = m6 * BigInt(c100) * BigInt(pc4) * BigInt(10000 - pc4); // dollars * 1e16
  const unit = cfg.rounding === 'centicent' ? 10n ** 12n : 10n ** 14n;   // $0.0001 or $0.01 in 1e-16 dollars
  const q = (num + unit - 1n) / unit;                            // ceil
  return Number(q) * (cfg.rounding === 'centicent' ? 1e-4 : 1e-2);
}
function feeCentsPerContract28(priceCents, C, cfg, maker = false) {
  const n = Math.round(Number(C) * 100) / 100; if (!(n > 0)) return 0;
  return 100 * feeDollars28(priceCents, n, cfg, maker) / n;
}
/* Walk the ask ladder [[cents, size], ...] (best first) for `size` contracts. */
function walk28(levels, size) {
  let need = Math.max(0, Number(size) || 0), cost = 0, got = 0, worst = NaN; const fills = [];
  for (const [p, s] of (levels || [])) {
    if (need <= 1e-9) break;
    const sz = Number(s);
    if (!(Number.isFinite(p) && p > 0 && p < 100 && sz > 0)) continue;
    const q = Math.min(need, sz); cost += q * p; got += q; need -= q; worst = p; fills.push([p, q]);
  }
  return { fillable: got, avgCents: got > 0 ? cost / got : NaN, worstCents: worst, fills };
}
/* Fee for an executed walk: one rounding for the whole order (perFill=false) or
   one per price level (perFill=true, conservative if Kalshi rounds per trade). */
function walkFeeCents28(fills, cfg, maker = false) {
  if (!fills || !fills.length) return 0;
  if (cfg.perFill) return fills.reduce((a, [p, q]) => a + 100 * feeDollars28(p, q, cfg, maker), 0);
  /* whole-order rounding: exact sum of the unrounded fee, rounded once */
  const mult = (maker ? cfg.makerMult : cfg.takerMult) * (Number.isFinite(cfg.seriesMultiplier) ? cfg.seriesMultiplier : 1);
  if (!(mult > 0)) return 0;
  const m6 = BigInt(Math.round(mult * 1e6)); let num = 0n;
  for (const [p, q] of fills) { const pc4 = Math.round(p * 100), c100 = Math.round(q * 100); if (pc4 > 0 && pc4 < 10000 && c100 > 0) num += m6 * BigInt(c100) * BigInt(pc4) * BigInt(10000 - pc4); }
  const unit = cfg.rounding === 'centicent' ? 10n ** 12n : 10n ** 14n;
  return 100 * Number((num + unit - 1n) / unit) * (cfg.rounding === 'centicent' ? 1e-4 : 1e-2);
}
/* Expected value per contract and in total for each order size.
   pWin: model win probability; pWinCons: 2.6 conservative; pWinStress: lower end
   of the calibration-drift band. EV = 100*p - avg price - fee (cents/contract). */
function evLadder28({ levels, pWin, pWinCons, pWinStress, sizes = [1, 5, 10, 25, 50, 100], cfg = feeCfg28() }) {
  const rows = [];
  for (const size of sizes) {
    const w = walk28(levels, size);
    const row = { size, fillable: w.fillable, full: w.fillable >= size, avgCents: null, worstCents: null, feeCents: null, feeCentsPerContract: null,
      evCents: null, evConsCents: null, evStressCents: null, totalEvConsCents: null, breakEvenWinPct: null };
    if (w.fillable > 0) {
      const fee = walkFeeCents28(w.fills, cfg);
      const fpc = fee / w.fillable;
      row.avgCents = r4(w.avgCents); row.worstCents = w.worstCents; row.feeCents = r4(fee); row.feeCentsPerContract = r4(fpc);
      if (Number.isFinite(pWin)) row.evCents = r4(100 * pWin - w.avgCents - fpc);
      if (Number.isFinite(pWinCons)) { row.evConsCents = r4(100 * pWinCons - w.avgCents - fpc); row.totalEvConsCents = r4(row.evConsCents * w.fillable); }
      if (Number.isFinite(pWinStress)) row.evStressCents = r4(100 * pWinStress - w.avgCents - fpc);
      row.breakEvenWinPct = r4(w.avgCents + fpc);
    }
    rows.push(row);
  }
  return rows;
}
function r4(x) { return Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null; }

/* ---------------------------------------------------------------- uncertainty band
   Measured calibration drift of the recalibrated 2.6 flip risk (first entry per
   window into each 0.2-5 % band; observed / expected events with exact Poisson
   95 % CIs, holdout Jul 22-Aug 13 and walk-forward Sep 4-Oct 13 2026):
     quiet  0.25 [0.15,0.40] holdout   1.24 [1.00,1.53] dev
     normal 0.53 [0.34,0.77] holdout   1.11 [0.92,1.33] dev
     active 0.91 [0.50,1.53] holdout   0.89 [0.69,1.14] dev
   (research28/results/reanalysis.json). The band is [lowest lower CI, highest
   upper CI] per regime: the range of realised rates the same displayed number
   has meant. It is display-only: decisions keep the validated 2.6 rule. Below
   0.2 % the factors are an extrapolation (no band events measured there). */
const UNC28 = Object.freeze({ quiet: [0.15, 1.53], normal: [0.34, 1.33], active: [0.50, 1.53], unknown: [0.15, 1.53],
  source: 'research28 reanalysis: calibration drift between Jul 22-Aug 13 and Sep 4-Oct 13 2026' });
function band28(pFlip, group) {
  if (!Number.isFinite(pFlip)) return null;
  const f = UNC28[group] || UNC28.unknown;
  const lo = Math.max(0, pFlip * f[0]), hi = Math.min(0.5, pFlip * f[1]);
  return { flip: pFlip, lo, hi, factors: f, group: UNC28[group] ? group : 'unknown', label: fmtBand28(pFlip, lo, hi) };
}
/* one significant figure inside a band that spans more than x2: precision the evidence supports */
function sig1(p) {
  if (!(p > 0)) return '0%';
  const v = 100 * p; const d = Math.max(0, -Math.floor(Math.log10(v)));
  return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d) + '%';
}
function fmtBand28(p, lo, hi) {
  if (!Number.isFinite(p)) return null;
  if (hi < 0.001) return '<0.1% (model range below 0.1%)';
  return `≈${sig1(p)} (plausible ${sig1(lo)}–${sig1(hi)})`;
}

/* ---------------------------------------------------------------- settlement designation
   Three distinct statements the page must never conflate. */
function designation28({ state, tau, panel, settled, strike }) {
  if (settled && (settled.result === 'yes' || settled.result === 'no'))
    return { code: 'OFFICIALLY_SETTLED', label: `OFFICIALLY SETTLED — ${settled.result === 'yes' ? 'UP (YES)' : 'DOWN (NO)'}`,
      basis: `Kalshi published the result (expiration value $${settled.official})` };
  if (Number.isFinite(tau) && tau <= 0) {
    /* 60/60 exactly: the clock tolerance (BRTI_COUNT_TOL) must never let 58-59 recorded values count as final */
    if (panel && panel.reference === 'OFFICIAL' && panel.decided && panel.recorded === 60 && Number.isFinite(panel.final) && Number.isFinite(strike))
      return { code: 'MATHEMATICALLY_FINAL', label: `MATHEMATICALLY FINAL — ${panel.final >= strike ? 'UP' : 'DOWN'} (official accumulator 60/60, $${panel.final})`,
        basis: 'all 60 official BRTI observations are recorded; awaiting Kalshi publication' };
    return { code: 'AWAITING_SETTLEMENT', label: 'AWAITING SETTLEMENT — official value unknown',
      basis: 'all observations are in, but only the proxy index is available here: the proxy cannot make the result final' };
  }
  if (state === 'PROVEN LOCKED')
    return { code: 'MATHEMATICALLY_FINAL', label: 'MATHEMATICALLY FINAL (price-only bound)',
      basis: 'the recorded observations (proxy index, discounted by a 0.25 % margin for the proxy-official difference) keep the average above the strike even if every remaining value were $0; subject to CF Benchmarks data availability' };
  if (state === 'LOCKED')
    return { code: 'PREDICTED_LOCKED', label: 'PREDICTED LOCKED — not a guarantee', basis: 'validated statistical classification: calibrated flip risk ≤ the LOCKED standard; a large enough BTC move can still reverse it' };
  return { code: 'NOT_LOCKED', label: null, basis: null };
}

/* ---------------------------------------------------------------- hash-chained ledger
   Every entry: {seq, ts, type, body, prev, hash}; hash = sha256(prev | canonical).
   Predictions are committed BEFORE the outcome exists; outcomes are appended
   later and cite the commitments. Tampering with any past entry breaks every
   later hash (verifyLedger28). Persisted append-only when a file is configured. */
function canon28(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : (typeof v === 'number' && !Number.isFinite(v) ? null : v));
  if (Array.isArray(v)) return '[' + v.map(canon28).join(',') + ']';
  return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon28(v[k])).join(',') + '}';
}
function sha28(s) { return crypto28.createHash('sha256').update(s).digest('hex'); }
function entryHash28(prev, e) { return sha28(prev + '|' + canon28({ seq: e.seq, ts: e.ts, type: e.type, body: e.body })); }
function mkLedger28({ genesisSeed = 'pinradar-2.8', file = '', maxMem = 50000, fs = null, maxPending = 100000 } = {}) {
  const genesis = sha28('genesis|' + genesisSeed);
  return { genesis, head: genesis, seq: 0, rows: [], dropped: 0, file, maxMem, fs, fileErr: null, fileBytes: null, pending: [], maxPending, writeFailures: 0, fileStopped: null };
}
function ledgerAppend28(L, type, body, ts = Date.now()) {
  /* the body is copied before hashing: a later change to the caller's object (e.g. the live fee schedule) must never
     alter an entry that is already hashed (JSON copy = what canon28 and the file see: NaN/undefined -> null/absent) */
  const e = { seq: ++L.seq, ts, type, body: body === undefined ? null : JSON.parse(JSON.stringify(body)), prev: L.head };
  e.hash = entryHash28(L.head, e); L.head = e.hash;
  L.rows.push(e); if (L.rows.length > L.maxMem) { L.rows.shift(); L.dropped++; }
  if (L.file && L.fs && !L.fileStopped) { L.pending.push(JSON.stringify(e) + '\n'); ledgerFlush28(L); }
  return e;
}
/* The file is always a contiguous prefix of the chain. A failed write is retried, in order, before any later entry
   (never skipped), and a partial write is cut back to the last whole line first (fileBytes = bytes known good). */
function ledgerFlush28(L) {
  if (!L.file || !L.fs) return;
  while (L.pending.length) {
    try {
      if (L.fileBytes == null) L.fileBytes = L.fs.existsSync(L.file) ? L.fs.statSync(L.file).size : 0;
      if (L.fileErr) { const sz = L.fs.statSync(L.file).size; if (sz > L.fileBytes) L.fs.truncateSync(L.file, L.fileBytes); }
      L.fs.appendFileSync(L.file, L.pending[0]);
      L.fileBytes += Buffer.byteLength(L.pending[0]); L.pending.shift();
      if (L.fileErr) { L.lastRecovered = { ts: Date.now(), after: L.fileErr }; L.fileErr = null; }
    } catch (err) {
      L.fileErr = String(err && err.message || err); L.writeFailures++;
      if (L.pending.length > L.maxPending) { L.fileStopped = { ts: Date.now(), why: L.fileErr, atSeq: JSON.parse(L.pending[0]).seq }; L.pending = []; }
      return;
    }
  }
}
/* Resume a chain from its file, streaming (bounded memory): every row is parsed and verified in order. A final
   fragment without a newline (a write cut by a crash) is moved to <file>.torn-<ts> and cut off. Anything else that
   does not verify stops the resume there: the original is kept as <file>.broken-<ts> and the file is cut back to
   the verified prefix, so the chain continues from the last good entry and nothing verified is thrown away.
   onRow(row) sees every verified row (monitor rebuild, open-window restore). Returns what happened. */
function ledgerResume28(L, fs, file, onRow = null, now = Date.now()) {
  const info = { n: 0, head: null, firstSeq: null, lastSeq: null, tornTail: null, broken: null };
  if (!fs.existsSync(file)) return info;
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
  const CH = 1 << 20; const buf = Buffer.alloc(CH);
  let pos = 0, rest = Buffer.alloc(0), good = 0, prev = null, lastSeq = 0, stop = false;
  const keep = [];
  try {
    while (pos < size && !stop) {
      const nr = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos); if (nr <= 0) break; pos += nr;
      const data = rest.length ? Buffer.concat([rest, buf.subarray(0, nr)]) : Buffer.from(buf.subarray(0, nr));
      let start = 0, nl;
      while (!stop && (nl = data.indexOf(10, start)) !== -1) {
        const text = data.toString('utf8', start, nl); const bytes = nl - start + 1; start = nl + 1;
        if (!text.trim()) { good += bytes; continue; }
        let e = null; try { e = JSON.parse(text); } catch (_) { e = null; }
        let why = null;
        if (!e || typeof e !== 'object') why = 'unparsable line';
        else if (prev === null && e.seq !== 1) why = 'file does not start at seq 1';
        else if (prev !== null && e.seq !== lastSeq + 1) why = 'sequence gap';
        else if (prev !== null && e.prev !== prev) why = 'prev hash mismatch';
        else if (entryHash28(e.prev, e) !== e.hash) why = 'hash mismatch (entry altered)';
        if (why) { info.broken = { why, atSeq: e && e.seq != null ? e.seq : lastSeq + 1, afterBytes: good }; stop = true; break; }
        if (prev === null) { info.firstSeq = e.seq; L.genesis = e.prev; }
        prev = e.hash; lastSeq = e.seq; good += bytes; info.n++;
        keep.push(e); if (keep.length > 2 * L.maxMem) keep.splice(0, keep.length - L.maxMem);
        if (onRow) onRow(e);
      }
      rest = stop ? Buffer.alloc(0) : data.subarray(start);
    }
  } finally { fs.closeSync(fd); }
  if (!stop && rest.length) {
    info.tornTail = { bytes: rest.length, movedTo: file + '.torn-' + now };
    try { fs.writeFileSync(info.tornTail.movedTo, rest); } catch (_) { info.tornTail.movedTo = null; }
    fs.truncateSync(file, good);
  }
  if (stop) {
    const bad = file + '.broken-' + now; fs.renameSync(file, bad); fs.copyFileSync(bad, file); fs.truncateSync(file, good);
    info.broken.originalKeptAs = bad;
  }
  if (info.n) { L.head = prev; L.seq = lastSeq; L.rows = keep.slice(-L.maxMem); info.head = prev; info.lastSeq = lastSeq; }
  L.fileBytes = good;
  return info;
}
/* rows must be contiguous; `genesis` is the expected prev of the first row when it is seq 1 */
function verifyLedger28(rows, genesis = null) {
  let prev = rows.length && rows[0].seq === 1 && genesis ? genesis : (rows.length ? rows[0].prev : null);
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i];
    if (i > 0 && e.seq !== rows[i - 1].seq + 1) return { ok: false, at: e.seq, why: 'sequence gap' };
    if (e.prev !== prev) return { ok: false, at: e.seq, why: 'prev hash mismatch' };
    if (entryHash28(prev, e) !== e.hash) return { ok: false, at: e.seq, why: 'hash mismatch (entry altered)' };
    prev = e.hash;
  }
  return { ok: true, n: rows.length, head: prev };
}

/* ---------------------------------------------------------------- anytime-valid monitors
   Test martingales (Ville's inequality: P(sup E >= 1/alpha) <= alpha under H0),
   so the numbers can be checked every day without inflating false alarms.
   FAILURE ALARM  H0: first-LOCKED loss rate <= p0. Mixture of likelihood ratios
                  over alternatives p1 > p0 (equal weights).
   PROOF OF EDGE  H0: mean P&L per contract <= 0. Mixture of betting martingales
                  prod(1 + lambda * x), x = P&L in dollars per contract. */
const FAIL_ALTS28 = [1.5, 2, 3, 4, 6, 10, 20];                 // p1 = p0 * k
function mkFailMonitor28(p0 = 0.005, alpha = 0.05) {
  return { kind: 'failure-rate', p0, alpha, n: 0, losses: 0, logW: FAIL_ALTS28.map(() => 0), alts: FAIL_ALTS28.map(k => Math.min(0.5, p0 * k)), supE: 1, firstAlarmN: null };
}
function failE28(M) { const mx = Math.max(...M.logW); return Math.exp(mx) * M.logW.reduce((a, l) => a + Math.exp(l - mx), 0) / M.logW.length; }
function failUpdate28(M, lost) {
  M.n++; if (lost) M.losses++;
  for (let i = 0; i < M.alts.length; i++) { const p1 = M.alts[i]; M.logW[i] += lost ? Math.log(p1 / M.p0) : Math.log((1 - p1) / (1 - M.p0)); }
  /* Ville's inequality bounds sup_t E_t: once E reaches 1/alpha the alarm is latched, even if later wins decay E */
  const e = failE28(M); if (e > M.supE) M.supE = e;
  if (M.firstAlarmN == null && e >= 1 / M.alpha) M.firstAlarmN = M.n;
  return M;
}
function failState28(M) {
  const e = failE28(M), latched = M.firstAlarmN != null;
  return { kind: M.kind, H0: `loss rate <= ${(100 * M.p0).toFixed(2)}%`, n: M.n, losses: M.losses, eValue: r4(e), supEValue: r4(M.supE), threshold: 1 / M.alpha,
    alarm: latched, alarmNow: e >= 1 / M.alpha, firstAlarmAtWindow: M.firstAlarmN,
    meaning: latched ? `ALARM (latched at LOCKED window ${M.firstAlarmN}, peak e ${r4(M.supE)}): anytime-valid ${(100 * (1 - M.alpha)).toFixed(0)}% evidence that the loss rate exceeds ${(100 * M.p0).toFixed(2)}% — stop relying on LOCKED and investigate; do not retune on these few outcomes`
      : 'no evidence the loss rate exceeds the standard (absence of alarm is not proof of safety)' };
}
const EDGE_LAMBDAS28 = [0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9];
function mkEdgeMonitor28(alpha = 0.05) { return { kind: 'proof-of-edge', alpha, n: 0, sum: 0, sumSq: 0, logW: EDGE_LAMBDAS28.map(() => 0), dd: { peak: 0, cum: 0, max: 0 } }; }
function edgeUpdate28(M, pnlDollarsPerContract) {
  const x = Number(pnlDollarsPerContract); if (!Number.isFinite(x)) return M;
  M.n++; M.sum += x; M.sumSq += x * x;
  for (let i = 0; i < EDGE_LAMBDAS28.length; i++) { const f = 1 + EDGE_LAMBDAS28[i] * x; M.logW[i] += f > 0 ? Math.log(f) : -Infinity; }
  M.dd.cum += x; M.dd.peak = Math.max(M.dd.peak, M.dd.cum); M.dd.max = Math.max(M.dd.max, M.dd.peak - M.dd.cum);
  return M;
}
function edgeState28(M) {
  const fin = M.logW.filter(Number.isFinite); let e = 0;
  if (fin.length) { const mx = Math.max(...fin); e = Math.exp(mx) * fin.reduce((a, l) => a + Math.exp(l - mx), 0) / M.logW.length; }
  const mean = M.n ? M.sum / M.n : null;
  return { kind: M.kind, H0: 'mean P&L per contract <= 0', n: M.n, meanCentsPerContract: mean == null ? null : r4(100 * mean),
    totalCentsPerContractSum: r4(100 * M.sum), maxDrawdownCentsPerContract: r4(100 * M.dd.max), eValue: r4(e), threshold: 1 / M.alpha,
    proven: e >= 1 / M.alpha, meaning: e >= 1 / M.alpha ? `positive edge established (anytime-valid ${(100 * (1 - M.alpha)).toFixed(0)}%) on these fills`
      : 'edge NOT established — treat TRADE NOW profitability as unproven' };
}

/* ---------------------------------------------------------------- exact binomial bounds */
function lnGamma28(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma28(1 - z);
  z -= 1; let a = c[0]; const t = z + 7.5; for (let i = 1; i < 9; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}
function binomCdf28(k, n, p) {               // P(X <= k)
  if (k < 0) return 0; if (k >= n) return 1; if (p <= 0) return 1; if (p >= 1) return 0;
  let s = 0; for (let i = 0; i <= k; i++) s += Math.exp(lnGamma28(n + 1) - lnGamma28(i + 1) - lnGamma28(n - i + 1) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}
function cpUpper28(k, n, conf = 0.95) {     // one-sided Clopper-Pearson upper bound
  if (!(n > 0)) return 1; if (k >= n) return 1;
  let lo = k / n, hi = 1;
  for (let it = 0; it < 100; it++) { const m = (lo + hi) / 2; if (binomCdf28(k, n, m) > 1 - conf) lo = m; else hi = m; }
  return hi;
}

/* ---------------------------------------------------------------- shadow policies
   Candidate models evaluated on the SAME snapshot as production, every tick.
   They never affect what the page shows as the decision. Definitions are frozen
   in PREREGISTRATION.md; changing one creates a new policy id.
   deps: { m25Decide, recalPUp26, recalRatio26 } from the server. */
const POOL28 = Object.freeze({ a: -2.609, b: 0.659, source: 'logit(loss | LOCKED) = a + b*logit(1 - ask); fitted on AUDIT_25.byAsk (dev Sep 4-Oct 13), reanalysis.json' });
function logit28(p) { const q = Math.min(1 - 1e-9, Math.max(1e-9, p)); return Math.log(q / (1 - q)); }
function marketPooledFlip28(askCents) {
  if (!Number.isFinite(askCents) || askCents <= 0 || askCents >= 100) return null;
  return 1 / (1 + Math.exp(-(POOL28.a + POOL28.b * logit28(1 - askCents / 100))));
}
const SHADOW_POLICIES28 = Object.freeze([
  { id: 'A-2.6', model: 'A', desc: '2.6/2.7 production rule (control): LOCKED at recalibrated flip <= 0.5 %, TRADE NOW at >= 0.5c conservative edge' },
  { id: 'C1-strict-0.2', model: 'C', desc: 'same model, LOCKED at flip <= 0.2 % (prior dev: 5/3,471 lost, lead 78 s vs 100 s)' },
  { id: 'C2-no-active-recal', model: 'C', desc: 'regime recalibration without the active-tape down-weighting (ratio 1.0 instead of 0.52; prior dev 8/3,480, fewer trades)' },
  { id: 'D-impulse-veto', model: 'D', desc: 'microstructure: withhold LOCKED/TRADE NOW while an adverse taker impulse (2.1 detector, 3 venues) is live inside 90 s' },
  { id: 'E-official-ensemble', model: 'E', desc: 'when the official BRTI accumulator is live: flip = max(proxy model, official-reference model); else identical to A' },
  { id: 'F-market-pooled-value', model: 'F', desc: 'original: TRADE NOW only if the edge survives the adverse-selection prior (cheaper ask => weaker LOCKED), POOL28' }
]);
function shadowDecide28(policyId, { snap, deps, cfg, lockedSide = null, hist = [], impulse = null, tau }) {
  const geo = snap.geo, gates = snap.gates, book = snap.book, base = snap.decision;
  if (!geo || geo.pUp == null) return base;
  /* the same post-decision guard production applies in classify25: LOCKED but offered below MIN_TRADE_ASK_CENTS
     means the market disagrees -> no TRADE NOW (otherwise candidates would paper-trade where A refuses) */
  const guard = d => (d && d.trade && d.trade.action === 'TRADE NOW' && Number.isFinite(cfg.minTradeAskCents) && d.trade.askCents != null && d.trade.askCents < cfg.minTradeAskCents)
    ? Object.assign({}, d, { trade: Object.assign({}, d.trade, { action: 'LOCKED — MARKET DISAGREES', why: 'ask below the market-disagreement guard' }) }) : d;
  const dec = (pUp, pUpCons, c = cfg) => guard(deps.m25Decide({ tau, pUp, pUpCons, gates, book, cfg: c, hist, lockedSide, provenSide: geo.provenUp ? 'UP' : null }));
  switch (policyId) {
    case 'A-2.6': return base;
    case 'C1-strict-0.2': return dec(geo.pUp, geo.pUpCons, Object.assign({}, cfg, { lockMaxFlip: 0.002 }));
    case 'C2-no-active-recal': {
      const r = geo.recal && geo.recal.group === 'active' ? 1.0 : (geo.recal ? geo.recal.ratio : 1);
      return dec(deps.recalPUp26(geo.pUpModel, r), deps.recalPUp26(geo.pUpConsModel, r));
    }
    case 'D-impulse-veto': {
      const d = base; if (!d) return d;
      const locked = d.state === 'LOCKED' || d.state === 'PROVEN LOCKED';
      const adverse = impulse && impulse.ok && impulse.live && Number.isFinite(tau) && tau > 0 && tau <= 90
        && ((d.side === 'UP' && impulse.direction < 0) || (d.side === 'DOWN' && impulse.direction > 0));
      if (locked && adverse && d.state !== 'PROVEN LOCKED') return Object.assign({}, d, { state: 'HIGH CONFIDENCE', trade: Object.assign({}, d.trade, { action: 'WAIT', why: 'adverse taker impulse live' }) });
      return d;
    }
    case 'E-official-ensemble': {
      const p = snap.panel;
      if (!p || p.reference !== 'OFFICIAL' || p.officialPUp == null) return base;
      const up = geo.pUp >= 0.5;
      const fProxy = up ? 1 - geo.pUp : geo.pUp, fOff = up ? 1 - p.officialPUp : p.officialPUp;
      const f = Math.max(fProxy, fOff);
      const fc = Math.max(up ? 1 - geo.pUpCons : geo.pUpCons, fOff);
      return dec(up ? 1 - f : f, up ? 1 - fc : fc);
    }
    case 'F-market-pooled-value': {
      const d = base; if (!d || !d.trade || d.trade.action !== 'TRADE NOW') return d;
      const pf = marketPooledFlip28(d.trade.askCents);
      const fl = Math.max(d.pFlipCons != null ? d.pFlipCons : 0, pf == null ? 0 : pf);
      const ev = 100 * (1 - fl) - d.trade.avgCents - d.trade.feeCents;
      if (ev >= cfg.minEdgeCents) return d;
      return Object.assign({}, d, { trade: Object.assign({}, d.trade, { action: 'LOCKED — DO NOT TRADE', why: `market-adjusted edge ${ev.toFixed(2)}c < ${cfg.minEdgeCents}c` }) });
    }
    default: return base;
  }
}
/* per-window, per-policy first events (the unit of evaluation is the window) */
function shadowNote28(W, policyId, d, ctx) {
  if (!d) return null;
  const s = W[policyId] || (W[policyId] = { firstLock: null, firstTrade: null, firstReversal: null, lockedSide: null, maxTau: null });
  const ev = [];
  const locked = d.state === 'LOCKED' || d.state === 'PROVEN LOCKED';
  if (locked && !s.firstLock) { s.firstLock = { side: d.side, tau: r4(ctx.tau), pFlip: r4(d.pFlip), pFlipCons: r4(d.pFlipCons), ts: ctx.now }; s.lockedSide = d.side; ev.push('firstLock'); }
  if (d.trade && d.trade.action === 'TRADE NOW' && !s.firstTrade) {
    s.firstTrade = { side: d.side, tau: r4(ctx.tau), askCents: d.trade.askCents, avgCents: d.trade.avgCents, feeCents: d.trade.feeCents,
      contracts: d.trade.contracts, depth: d.trade.depth, evConsCents: d.trade.evConsCents, bookAgeMs: ctx.bookAgeMs, ts: ctx.now };
    ev.push('firstTrade');
  }
  if (d.state === 'REVERSAL WARNING' && !s.firstReversal) { s.firstReversal = { side: d.side, tau: r4(ctx.tau), pFlip: r4(d.pFlip), ts: ctx.now }; ev.push('firstReversal'); }
  return ev.length ? { policy: policyId, events: ev, rec: s } : null;
}
/* score one window for one policy once the official result is known */
function shadowScore28(rec, winner) {
  const out = { locked: !!(rec && rec.firstLock), lost: null, trade: null };
  if (rec && rec.firstLock) out.lost = rec.firstLock.side !== winner;
  if (rec && rec.firstTrade && Number.isFinite(rec.firstTrade.avgCents)) {
    const won = rec.firstTrade.side === winner;
    const fee = Number.isFinite(rec.firstTrade.feeCents) ? rec.firstTrade.feeCents : 0;
    out.trade = { won, pnlCentsPerContract: r4((won ? 100 : 0) - rec.firstTrade.avgCents - fee), avgCents: rec.firstTrade.avgCents };
  }
  return out;
}
function mkShadowStats28(policies = SHADOW_POLICIES28, p0 = 0.005) {
  const o = {};
  for (const p of policies) o[p.id] = { windows: 0, locked: 0, lost: 0, leadTaus: [], trades: 0, tradeLosses: 0, pnlCents: [], fail: mkFailMonitor28(p0), edge: mkEdgeMonitor28() };
  return o;
}
function shadowAccumulate28(stats, policyId, rec, winner) {
  const S = stats[policyId]; if (!S) return null;
  const sc = shadowScore28(rec, winner);
  S.windows++;
  if (sc.locked) { S.locked++; if (sc.lost) S.lost++; S.leadTaus.push(rec.firstLock.tau); failUpdate28(S.fail, !!sc.lost); }
  if (sc.trade) { S.trades++; if (!sc.trade.won) S.tradeLosses++; S.pnlCents.push(sc.trade.pnlCentsPerContract); edgeUpdate28(S.edge, sc.trade.pnlCentsPerContract / 100); }
  return sc;
}
function shadowSummary28(stats) {
  const out = {};
  for (const [id, S] of Object.entries(stats)) {
    const lt = [...S.leadTaus].sort((a, b) => a - b);
    out[id] = { windows: S.windows, locked: S.locked, lost: S.lost, lossRatePct: S.locked ? r4(100 * S.lost / S.locked) : null,
      lossCp95UpperPct: S.locked ? r4(100 * cpUpper28(S.lost, S.locked)) : null, coveragePct: S.windows ? r4(100 * S.locked / S.windows) : null,
      leadMeanS: lt.length ? r4(lt.reduce((a, b) => a + b, 0) / lt.length) : null, leadMedianS: lt.length ? lt[Math.floor(lt.length / 2)] : null,
      trades: S.trades, tradeLosses: S.tradeLosses, pnlCentsPerContractMean: S.pnlCents.length ? r4(S.pnlCents.reduce((a, b) => a + b, 0) / S.pnlCents.length) : null,
      failure: failState28(S.fail), edge: edgeState28(S.edge),
      fills: 'hypothetical: the visible Kalshi book at the decision second, not an executed order' };
  }
  return out;
}

/* Holm step-down adjusted p-values: sorted ascending, adj_(i) = max_{j<=i} min(1, (m - j + 1) p_(j)) (monotone).
   pmap: {name: p | null}; a null p (objective not evaluable) is 1 and still counts in m. */
function holm28(pmap) {
  const ps = Object.entries(pmap).map(([k, p]) => [k, p == null || !Number.isFinite(p) ? 1 : p]).sort((a, b) => a[1] - b[1]);
  const out = {}; let run = 0;
  ps.forEach(([k, p], i) => { run = Math.max(run, Math.min(1, p * (ps.length - i))); out[k] = run; });
  return out;
}

/* ---------------------------------------------------------------- latency percentiles */
function mkLat28(cap = 2000) { return { cap, series: {} }; }
function latNote28(L, key, ms) {
  if (!Number.isFinite(ms)) return; const a = L.series[key] || (L.series[key] = []);
  a.push(ms); if (a.length > L.cap) a.shift();
}
function latSummary28(L) {
  const o = {};
  for (const [k, a] of Object.entries(L.series)) {
    if (!a.length) continue; const s = [...a].sort((x, y) => x - y); const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    o[k] = { n: s.length, p50: r4(q(0.5)), p95: r4(q(0.95)), p99: r4(q(0.99)), max: r4(s[s.length - 1]) };
  }
  return o;
}

const CORE28 = { CORE28_VERSION, feeCfg28, feeDollars28, feeCentsPerContract28, walk28, walkFeeCents28, evLadder28, UNC28, band28, fmtBand28, sig1,
  designation28, canon28, sha28, entryHash28, mkLedger28, ledgerAppend28, ledgerFlush28, ledgerResume28, verifyLedger28, FAIL_ALTS28, mkFailMonitor28, failE28, failUpdate28, failState28,
  EDGE_LAMBDAS28, mkEdgeMonitor28, edgeUpdate28, edgeState28, binomCdf28, cpUpper28, POOL28, marketPooledFlip28, SHADOW_POLICIES28,
  shadowDecide28, shadowNote28, shadowScore28, mkShadowStats28, shadowAccumulate28, shadowSummary28, holm28, mkLat28, latNote28, latSummary28 };
if (typeof module !== 'undefined' && module.exports && !globalThis.__CORE28_INLINE__) module.exports = CORE28;
