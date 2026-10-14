/* =====================================================================
   PIN RADAR 2.8 — SERVER GLUE (inserted by build/build_server28.py after the
   core28 block; uses the server's globals). Decisions are those of 2.7 (=2.6
   without the official feed) except where a confirmed defect is fixed:
     D1 live-index quorum failure: the last good 1 Hz value was used as if it
        were 0 ms old with no gate -> LOCKED / TRADE NOW possible on a stale
        index. Now a hard gate (DATA UNRELIABLE).
     D2 official BRTI freshness was judged by receipt time only: a value 60 s
        old at the source was "fresh". Now max(receipt age, source age).
     D3 a zero-size best ask level was shown as the "buy at <=" price.
     D4 PROVEN LOCKED (a proxy price-only bound) bypassed the official-BRTI
        gates: TRADE NOW + MATHEMATICALLY FINAL while the official reference
        disagreed. Now withheld (HIGH CONFIDENCE) like an ordinary LOCKED.
     D5 an official REVERSAL WARNING kept the proxy's >99.9 % / <0.1 % and the
        guarantee text. Now the official reference's numbers are shown.
     D6 after the close, 58-59 official values (clock tolerance) counted as
        "decided" and were labelled MATHEMATICALLY FINAL 60/60. Now 60/60 only.
   ===================================================================== */
function envNum28(k, d, lo, hi) { const n = Number(process.env[k]); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
const LADDER_SIZES28 = String(process.env.LADDER_SIZES || '1,5,10,25,50,100').split(',').map(Number).filter(x => Number.isFinite(x) && x >= 1 && x <= 100000).slice(0, 10);
const LEDGER28_FILE = String(process.env.LEDGER_FILE || '').trim();
const TAPE28_FILE = String(process.env.TAPE_FILE || '').trim();
const TAPE28_MAX = envNum28('TAPE_MAX', 3000, 200, 200000);
const TAPE28_FILE_MAX = envNum28('TAPE_FILE_MAX_MB', 256, 1, 100000) * 1048576;          // rotation size of TAPE_FILE (see tapeWrite28)
const SHADOW28_P0 = envNum28('MONITOR_P0', LOCK_MAX_FLIP, 0.0005, 0.1);          // failure alarm H0: loss rate <= the LOCKED standard
const PREREG28_ID = 'pinradar-2.8-prereg-v2';                                     // PREREGISTRATION.md, frozen before any forward data

/* ---------------------------------------------------------------- fee schedule (not hard-coded) */
var FEE28 = { cfg: feeCfg28({ takerMult: envNum28('FEE_TAKER_MULT', 0.07, 0, 1), makerMult: envNum28('FEE_MAKER_MULT', 0, 0, 1),
  rounding: /^centi/i.test(process.env.FEE_ROUNDING || '') ? 'centicent' : 'cent', perFill: /^(1|true|yes)$/i.test(process.env.FEE_PER_FILL || '') }),
  isDefault: true, verified: false, fetchedAt: null, error: null, series: null, history: [] };
function fee28Recompute() {
  const c = FEE28.cfg;
  FEE28.isDefault = Math.abs(c.takerMult * (Number.isFinite(c.seriesMultiplier) ? c.seriesMultiplier : 1) - 0.07) < 1e-12 && c.rounding === 'cent' && !c.perFill;
}
fee28Recompute();
async function fee28Refresh() {
  try {
    const j = await fetchJson(`${KALSHI_BASE}/series/${encodeURIComponent(KALSHI_SERIES)}`, {}, 4000);
    const s = j && (j.series || j);
    if (!s || typeof s !== 'object') throw new Error('no series record');
    /* strict: only a JSON number or a plain numeric string in [0.1, 4] is a multiplier (Number(null/''/false) is 0,
       which would zero the decision fee); anything else keeps the current multiplier and is NOT "verified" */
    const raw = s.fee_multiplier, type = s.fee_type != null ? String(s.fee_type) : null;
    const mult = typeof raw === 'number' || (typeof raw === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(raw)) ? Number(raw) : NaN;
    const multOk = Number.isFinite(mult) && mult >= 0.1 && mult <= 4;   // a garbled tiny/huge value never reaches the decision fee
    const before = JSON.stringify(FEE28.cfg);
    const cfg = { ...FEE28.cfg };                       // replaced, never mutated in place (entries already hashed may hold the old one)
    if (multOk) cfg.seriesMultiplier = mult;
    if (type) {
      cfg.feeType = type;
      /* maker fees exist only on series whose fee_type names them (third-party documentation: 0.0175 maker
         coefficient); an explicit FEE_MAKER_MULT env value always wins */
      if (!process.env.FEE_MAKER_MULT) cfg.makerMult = /maker/i.test(type) ? 0.0175 : 0;
    }
    cfg.source = `Kalshi series record ${KALSHI_SERIES}: fee_type ${type ?? 'absent'}, fee_multiplier ${raw === undefined ? 'absent' : JSON.stringify(raw)}`
      + (raw !== undefined && !multOk ? ` (rejected: not a number in [0.1, 4]; multiplier ${cfg.seriesMultiplier ?? 1} kept)` : '')
      + ' (rounding unit and taker coefficient 0.07 are not in the record: ' + cfg.rounding + ' rounding assumed)';
    FEE28.cfg = cfg;
    FEE28.verified = multOk; FEE28.fetchedAt = Date.now(); FEE28.error = null;
    FEE28.series = { fee_type: type, fee_multiplier: multOk ? mult : null, fee_multiplier_raw: raw === undefined ? null : raw, ticker: s.ticker || KALSHI_SERIES };
    fee28Recompute();
    if (JSON.stringify(FEE28.cfg) !== before) { FEE28.history.push({ ts: Date.now(), cfg: { ...FEE28.cfg } }); if (typeof L28 !== 'undefined') ledgerAppend28(L28, 'fees', { cfg: { ...FEE28.cfg }, isDefault: FEE28.isDefault }); }
  } catch (e) { FEE28.error = String(e && e.message || e); FEE28.fetchedAt = Date.now(); }
}

/* ---------------------------------------------------------------- evidence shown with every call
   The settlement-aware re-evaluation of the 2.6 rule (pkg27/research/results/settle_metrics.json, variant A), not the
   earlier 2.5 audit embedded in AUDIT_25 (12 of 3,484). The development period is labelled for what it is: the tail
   tables were fitted on Aug 13 - Oct 13, which overlaps it. Per-regime and per-ask splits of the old audit are not
   shown (they sum to the old totals, and the per-ask rows count windows more than once). */
const AUDIT28 = (() => {
  const A = AUDIT_25 || {}, T = A['TRADE NOW'];
  return Object.freeze({ ...A,
    LOCKED: A.LOCKED ? { ...A.LOCKED, n: 3484, losses: 13, rate: 0.00373, upper95: 0.00593, byAsk: null, byRegime: null, coverage: 0.9254, medianFirstTau: 77,
      label: 'Development (walk-forward Sep 4 - Oct 13 2026; not independent: the tail tables were fitted on Aug 13 - Oct 13)',
      period: 'holdout Jul 22 - Aug 13 2026: 3 of 1,879 lost (one-sided 95% upper bound 0.41%). Settlement-aware re-evaluation; forward evidence: /shadow' } : null,
    'TRADE NOW': T ? { ...T, CONS: { ...T.CONS, n: 261, losses: 2, avgPxCents: 98.2, pnlCentsPerContract: 0.86, pnlCi95Cents: [-0.21, 1.92] },
      VISIBLE: { ...T.VISIBLE, n: 336, losses: 2, avgPxCents: 97.9, pnlCentsPerContract: 1.32 } } : null,
    'HIGH CONFIDENCE': A['HIGH CONFIDENCE'] ? { ...A['HIGH CONFIDENCE'], label: 'Development (walk-forward, earlier 2.5 audit)' } : null,
    source: 'pkg27/research/results/settle_metrics.json variant A (settlement-aware); REPORT_2.8.md sections B/E' });
})();

/* ---------------------------------------------------------------- ledger, shadow state, monitors, latency */
const BOOT28 = { id: crypto.randomBytes(6).toString('hex'), ts: Date.now() };
/* every environment variable the server reads (list generated at build time) except secrets and I/O paths: an
   override of ANY decision input changes CONFIG28_HASH; the embedded model tables are hashed too */
const ENV_KEYS28 = /*ENV_KEYS28*/[];
const ENV_EXCLUDE28 = /^(KALSHI_PRIVATE_KEY|KALSHI_KEY_ID|OPENAI_API_KEY|OPENAI_MODEL|ENABLE_OPENAI|PORT|PINRADAR_STATE_FILE|PRED_LOG_FILE|LEDGER_FILE|TAPE_FILE|PINRADAR_REPLAY|ENABLE_WS|KALSHI_WS_URL|PRED_LOG_MAX|LEDGER_MAX|TAPE_MAX|TAPE_FILE_MAX_MB)$/;
function config28Env() { return Object.fromEntries(ENV_KEYS28.filter(k => !ENV_EXCLUDE28.test(k) && process.env[k] !== undefined && process.env[k] !== '').sort().map(k => [k, String(process.env[k])])); }
const MODEL28_SHA = sha28(JSON.stringify(M25_MODEL ? { v: M25_MODEL.version, fit: M25_MODEL.fit, sigma: M25_MODEL.sigma, regime: M25_MODEL.regime,
  tauGrid: M25_MODEL.tauGrid, zGrid: M25_MODEL.zGrid, basisQ: M25_MODEL.basisQ, tabs: M25_MODEL.tabs } : null));
const CONFIG28 = { server: SERVER_VERSION, build: BUILD_ID, core: CORE28_VERSION, model: MODEL_VERSION, modelSha: MODEL28_SHA, env: config28Env(), prereg: PREREG28_ID,
  lockMaxFlip: LOCK_MAX_FLIP, highMaxFlip: HIGH_MAX_FLIP, revFlip: REV_FLIP, minEdgeCents: MIN_EDGE_CENTS, minExecTau: MIN_EXEC_TAU,
  contracts: DEFAULT_CONTRACTS, maxBookAgeMs: MAX_BOOK_AGE_MS, recal: [RECAL_QUIET, RECAL_NORMAL, RECAL_ACTIVE], liveVolScale: LIVE_VOL_SCALE,
  minTradeAskCents: MIN_TRADE_ASK_CENTS, lockMaxTau: LOCK_MAX_TAU, policies: SHADOW_POLICIES28.map(p => p.id), pool: POOL28, unc: UNC28, monitorP0: SHADOW28_P0,
  officialFeed: !!(KALSHI_HAVE_CREDS && BRTI_ENABLE), streaming: !!(WS_AVAILABLE && ENABLE_WS) };   // credentials switch the official gates (D4/D5, policy E)
const CONFIG28_HASH = sha28(canon28(CONFIG28));
const SHADOW28 = { windows: new Map(), stats: mkShadowStats28(SHADOW_POLICIES28, SHADOW28_P0), scored: 0, lastScore: null, restored: [] };
/* one committed ledger row, replayed at boot: outcomes rebuild the monitors (the whole file counts, not just the
   in-memory tail); a window with committed calls but no outcome yet is restored with exactly those calls */
function rebuildRow28(e, open) {
  const b = e.body || {};
  if (e.type === 'outcome' && b.records) {
    for (const [pid, rec] of Object.entries(b.records)) shadowAccumulate28(SHADOW28.stats, pid, rec, b.winner);
    SHADOW28.scored++; open.delete(b.ticker);
  } else if (e.type === 'unresolved') open.delete(b.ticker);
  else if (e.type === 'window' && b.ticker) { if (!open.has(b.ticker)) open.set(b.ticker, { ticker: b.ticker, closeMs: b.closeMs, strike: b.strike, recs: {}, opened: e.ts, restored: true }); }
  else if (e.type === 'call' && b.ticker && b.policy && b.event) {
    const w = open.get(b.ticker); if (!w) return;
    const r = w.recs[b.policy] || (w.recs[b.policy] = { firstLock: null, firstTrade: null, firstReversal: null, lockedSide: null, maxTau: null });
    if (!r[b.event]) { r[b.event] = b.rec || null; if (b.event === 'firstLock' && b.rec) r.lockedSide = b.rec.side; }
  }
}
const L28 = (() => {
  const L = mkLedger28({ genesisSeed: 'pinradar-2.8|' + CONFIG28_HASH, file: LEDGER28_FILE, fs: LEDGER28_FILE ? require('fs') : null, maxMem: envNum28('LEDGER_MAX', 50000, 1000, 1000000) });
  L.resumed = null;
  /* continue an existing chain across restarts when the file survives (persistent disk): streamed and verified
     row by row; a torn last line is cut off, a bad row stops the resume there (original kept as .broken-<ts>) */
  if (LEDGER28_FILE && !process.env.PINRADAR_REPLAY) {
    const open = new Map(), g0 = L.genesis;
    try {
      L.resumed = ledgerResume28(L, require('fs'), LEDGER28_FILE, e => rebuildRow28(e, open));
      const now = Date.now();
      for (const w of open.values()) { w.restoredAt = now; SHADOW28.windows.set(w.ticker, w); SHADOW28.restored.push(w.ticker); }
      L.resumed.openWindowsRestored = open.size;
      /* a window still live keeps its LOCKED side, so a reversal of a call made before the restart is still warned */
      const live = [...open.values()].find(w => w.closeMs > now && w.recs['A-2.6'] && w.recs['A-2.6'].firstLock);
      if (live) Object.assign(LOCK25, { ticker: live.ticker, hist: [], lockedSide: live.recs['A-2.6'].firstLock.side, lockedAtTau: live.recs['A-2.6'].firstLock.tau, revNoted: false });
    } catch (e) {
      /* never append to a file that could not be read: keep it untouched, run in memory, say so */
      L.fileErr = 'resume failed: ' + String(e && e.message || e); L.fileStopped = { ts: Date.now(), why: L.fileErr }; L.resumeFailed = true;
      L.genesis = g0; L.head = g0; L.seq = 0; L.rows = []; L.fileBytes = null; SHADOW28.stats = mkShadowStats28(SHADOW_POLICIES28, SHADOW28_P0); SHADOW28.scored = 0;
    }
  }
  return L;
})();
const LAT28 = mkLat28(3000);
const TAPE28 = { rows: [], samples: [], lastSampleTs: 0, sinceDigest: [], lastDigestTs: 0, dropped: 0, fileErr: null };
const HB28 = { lastTs: 0 };
ledgerAppend28(L28, 'boot', { boot: BOOT28.id, config: CONFIG28, configHash: CONFIG28_HASH, resumed: L28.resumed, fees: FEE28.cfg });
if (TAPE28_FILE && !process.env.PINRADAR_REPLAY) tapeWrite28({ k: 'boot', ts: BOOT28.ts, boot: BOOT28.id });   // replay: no ring history across a restart

/* ---------------------------------------------------------------- signal enrichment (every snapshot) */
function settledFor28(ticker) {
  if (typeof SETTLE === 'undefined' || !ticker) return null;
  const d = SETTLE.done.find(x => x.ticker === ticker && x.status === 'SETTLED');
  return d ? { result: d.result, official: d.official } : null;
}
function enrich28(sig, { geo, settle, kal, now, tau }) {
  if (!sig) return sig;
  const group = geo && geo.recal ? geo.recal.group : 'unknown';
  const shown = sig.pFlip != null && sig.state !== 'DATA UNRELIABLE';
  /* the calibration-drift band is measured on the leader's flip risk; it says nothing about a call that is breaking */
  const band = shown && sig.state !== 'REVERSAL WARNING' ? band28(sig.pFlip, group) : null;
  const book = bookFromKal(kal, now);
  const lv = book.ok && sig.side ? (sig.side === 'UP' ? book.yesAsks : book.noAsks) : null;
  const pWin = sig.pWin, pWinCons = sig.pFlipCons != null ? 1 - sig.pFlipCons : null, pWinStress = band ? 1 - Math.max(band.hi, sig.pFlipCons || 0) : null;
  const tr = sig.trade || {};
  /* the trade numbers are the proxy decision's: void once the call is breaking (REVERSAL WARNING, official or proxy)
     or the data are unreliable; a trade the guards refused is never shown as positive value */
  const voidValue = sig.state === 'REVERSAL WARNING' || sig.state === 'DATA UNRELIABLE' || sig.state === 'AWAITING SETTLEMENT' || !!sig.officialReversal;
  const lockedState = sig.state === 'LOCKED' || sig.state === 'PROVEN LOCKED';
  const veto = voidValue ? sig.state : (!lockedState ? `not LOCKED (${sig.state})` : (tr.action && /MARKET DISAGREES|DO NOT TRADE|EXIT/.test(tr.action) ? tr.action : null));
  const ladder = !voidValue && lv && lv.length ? evLadder28({ levels: lv, pWin, pWinCons, pWinStress, sizes: LADDER_SIZES28, cfg: FEE28.cfg }) : [];
  const locked = sig.state === 'LOCKED' || sig.state === 'PROVEN LOCKED';
  const bookFresh = !!(book.ok && book.ageMs != null && book.ageMs <= MAX_BOOK_AGE_MS);
  const contracts = tr.contracts || DEFAULT_CONTRACTS;
  sig.v28 = {
    outcome: { state: sig.state, side: sig.side, locked, winProbability: pWin, flipProbability: sig.pFlip,
      flipBand: band, winLabel: band ? `${fmtWin(pWin)} (plausible ${fmtWin(1 - band.hi)}–${fmtWin(1 - band.lo)})` : (shown && pWin != null ? fmtWin(pWin) : null),
      flipLabel: band ? band.label : (shown ? fmtFlip(sig.pFlip) : null),
      note: band ? 'band = range of realised loss rates this displayed probability has corresponded to (Jul-Oct 2026 calibration drift); decisions use the validated point rule' : null },
    value: { minEdgeCents: MIN_EDGE_CENTS, contracts, askCents: tr.askCents ?? null, avgCents: tr.avgCents ?? null, feeCents: tr.feeCents ?? null,
      evCents: voidValue ? null : (tr.evCents ?? null), evConsCents: voidValue ? null : (tr.evConsCents ?? null), veto,
      positive: !veto && tr.evConsCents != null && tr.evConsCents >= MIN_EDGE_CENTS,
      stressEvCents: (() => { const r = ladder.find(x => x.size === contracts) || null; return r ? r.evStressCents : null; })() },
    execution: { bookAgeMs: book.ok ? book.ageMs : null, bookFresh, depth: tr.depth ?? null, enoughDepth: tr.depth != null && tr.depth >= contracts,
      secondsLeft: Number.isFinite(tau) ? Math.max(0, tau) : null, enoughTime: Number.isFinite(tau) && tau >= MIN_EXEC_TAU,
      ready: bookFresh && tr.depth != null && tr.depth >= contracts && Number.isFinite(tau) && tau >= MIN_EXEC_TAU },
    tradeNow: tr.action === 'TRADE NOW', action: tr.action || null,
    ladder, ladderNote: 'expected value per contract for each order size from the live ask ladder: point = model, cons = 2.6 conservative, stress = upper end of the calibration band. Hypothetical fills on the visible book.',
    designation: designation28({ state: sig.state, tau, panel: settle, settled: settledFor28(sig.ticker), strike: sig.strike }),
    fees: { source: FEE28.cfg.source, verified: FEE28.verified, isDefault: FEE28.isDefault, takerMult: FEE28.cfg.takerMult, seriesMultiplier: FEE28.cfg.seriesMultiplier,
      makerMult: FEE28.cfg.makerMult, rounding: FEE28.cfg.rounding, perFill: FEE28.cfg.perFill },
    monitor: (() => { const s = SHADOW28.stats['A-2.6']; return s ? { failure: failState28(s.fail), edge: edgeState28(s.edge), windowsScored: s.windows } : null; })(),
    ledgerHead: L28.head.slice(0, 16), prereg: PREREG28_ID
  };
  return sig;
}
function lastWindowDesignation28(w) {
  if (!w) return null;
  const fin = BRTI.finals.find(f => f.closeMs === w.closeMs && f.size === SETTLE_TICKS);
  const panel = fin ? { reference: 'OFFICIAL', decided: true, recorded: fin.size, final: settleRound2(fin.value) } : { reference: 'PROXY', decided: true };
  return designation28({ tau: -1, panel, settled: w.status === 'SETTLED' ? { result: w.result, official: w.official } : null, strike: w.strike });
}

/* client-reported latencies (POST /radar) are unauthenticated: negative values are dropped, values are capped at
   60 s, and all clients together add at most 4 samples/s, so nobody can rewrite the G6 series in seconds */
const CLAT28 = { tokens: 4, last: 0, dropped: 0 };
function clientLat28(payload, now = Date.now()) {
  const rtt = Number(payload && payload.clientRttMs), disp = Number(payload && payload.clientDisplayDelayMs);
  if (!(Number.isFinite(rtt) && rtt >= 0) && !(Number.isFinite(disp) && disp >= 0)) return false;   // invalid posts never use a token
  CLAT28.tokens = Math.min(4, CLAT28.tokens + Math.max(0, now - CLAT28.last) * 4 / 1000); CLAT28.last = now;
  if (CLAT28.tokens < 1) { CLAT28.dropped++; return false; } CLAT28.tokens -= 1;
  if (Number.isFinite(rtt) && rtt >= 0) latNote28(LAT28, 'clientRoundTripMs', Math.min(60000, rtt));
  if (Number.isFinite(disp) && disp >= 0) latNote28(LAT28, 'clientSignalAgeAtDisplayMs', Math.min(60000, disp));
  return true;
}
/* GET /ledger/verify: re-checks only the rows added since the last check (rows are immutable snapshots); a full
   re-hash of the in-memory chain (?full=1, ~0.4 s at 50,000 rows) runs at most once a minute */
const LV28 = { seq: 0, hash: null, ok: true, why: null, at: null, fullTs: 0, full: null };
function ledgerVerify28(full = false, now = Date.now()) {
  const rows = L28.rows; if (!rows.length) return { ok: true, n: 0, head: L28.head, mode: 'empty' };
  const first = rows[0], last = rows[rows.length - 1];
  if (full && LV28.full && now - LV28.fullTs < 60000) return { ...LV28.full, mode: 'full (cached, at most once a minute)' };
  let from = 0;
  if (!full && LV28.ok && LV28.hash && LV28.seq >= first.seq && LV28.seq <= last.seq && rows[LV28.seq - first.seq].hash === LV28.hash) from = LV28.seq - first.seq;
  if (!full && !LV28.ok) return { ok: false, at: LV28.at, why: LV28.why, mode: 'cached failure' };
  const v = verifyLedger28(from ? rows.slice(from) : rows, from === 0 && first.seq === 1 ? L28.genesis : null);
  Object.assign(LV28, { ok: v.ok, why: v.why || null, at: v.at || null, seq: v.ok ? last.seq : 0, hash: v.ok ? v.head : null });
  const res = { ...v, n: rows.length, mode: full || from === 0 ? 'full' : 'incremental' };
  if (full || from === 0) { LV28.full = res; LV28.fullTs = now; }
  return res;
}

/* ---------------------------------------------------------------- record & replay tape */
function tapePre28({ now, kal, liveIdx, age, quality, strikeIssue }) {
  const prev = (typeof SETTLE !== 'undefined' && kal && Number.isFinite(kal.openMs)) ? SETTLE.done.find(d => d.closeMs === kal.openMs && d.status === 'SETTLED' && Number.isFinite(d.official)) : null;
  return { ts: now, kal: kal ? { ok: kal.ok, ticker: kal.ticker, closeMs: kal.closeMs, openMs: kal.openMs, strike: kal.strike } : null,
    liveIdx: liveIdx ? { value: liveIdx.value, used: liveIdx.used.slice(), dispersionBps: liveIdx.dispersionBps } : null,
    ageMs: Number.isFinite(age) ? age : null, quality: { grade: quality.grade, problems: quality.problems.slice(), warnings: quality.warnings.slice() },
    strikeIssue: strikeIssue || null, prevSettled: prev ? { ticker: prev.ticker, closeMs: prev.closeMs, official: prev.official } : null,
    ob: KAL.ob && kal && KAL.ob.ticker === kal.ticker ? { ticker: KAL.ob.ticker, yes: KAL.ob.yes.slice(0, 20), no: KAL.ob.no.slice(0, 20) } : null, obTs: KAL.obTs || 0,
    skew: { n: SKEW.samples.length, est: SKEW.estMs }, rest: !!RESTF.active, basisMu: basisMean25().mean,
    idx: { value: IDX.value, ts: IDX.ts, venuesUsed: IDX.venuesUsed.slice(), dispersionBps: IDX.dispersionBps, lastReason: IDX.lastReason },
    lock25: { ticker: LOCK25.ticker, hist: LOCK25.hist.map(h => ({ t: h.t, pUp: h.pUp })), lockedSide: LOCK25.lockedSide, lockedAtTau: LOCK25.lockedAtTau, revNoted: LOCK25.revNoted },
    brti: { enabled: BRTI.enabled, last: BRTI.last, last5: BRTI.last5, win: BRTI.win },
    fee: FEE28.isDefault ? null : { cfg: { ...FEE28.cfg } } };
}
function tapeSample28() {
  const last = IDX.ring.length ? IDX.ring[IDX.ring.length - 1] : null;
  if (!last || last[0] <= TAPE28.lastSampleTs) return;
  for (const p of IDX.ring) if (p[0] > TAPE28.lastSampleTs) { TAPE28.samples.push([p[0], p[1]]); if (TAPE28_FILE) tapeWrite28({ k: 's', t: p[0], v: p[1] }); }
  TAPE28.lastSampleTs = last[0];
  /* keep the 960 s ring history of every decision record still held, so a pulled /tape replays */
  const keepFrom = (TAPE28.rows.length ? TAPE28.rows[0].ts : last[0]) - 960000;
  while (TAPE28.samples.length && (TAPE28.samples[0][0] < keepFrom || TAPE28.samples.length > 4 * TAPE28_MAX + 1000)) TAPE28.samples.shift();
}
/* the tape is diagnostic and large (~80 MB/day): it rotates at TAPE_FILE_MAX_MB (current + one .prev file) so it can
   never fill the disk the ledger is on; a new file starts with the 960 s ring history its first records need */
function tapeWrite28(o) {
  try {
    const fs = require('fs'), line = JSON.stringify(o) + '\n';
    if (TAPE28.fileBytes == null) TAPE28.fileBytes = fs.existsSync(TAPE28_FILE) ? fs.statSync(TAPE28_FILE).size : 0;
    if (!TAPE28.rotating && TAPE28.fileBytes + line.length > TAPE28_FILE_MAX) {
      TAPE28.rotating = true;
      try {
        fs.renameSync(TAPE28_FILE, TAPE28_FILE + '.prev'); TAPE28.fileBytes = 0; TAPE28.rotations = (TAPE28.rotations || 0) + 1;
        tapeWrite28({ k: 'rotate', ts: Date.now(), boot: BOOT28.id });
        for (const p of IDX.ring) if (!(o.k === 's' && p[0] >= o.t)) tapeWrite28({ k: 's', t: p[0], v: p[1] });
      } finally { TAPE28.rotating = false; }
    }
    fs.appendFileSync(TAPE28_FILE, line); TAPE28.fileBytes += Buffer.byteLength(line);
    if (TAPE28.fileErr) { TAPE28.lastFileErr = TAPE28.fileErr; TAPE28.fileErr = null; }
  } catch (e) { TAPE28.fileErr = String(e && e.message || e); }
}
function tapeRecord28(pre, snap) {
  const s = snap.signal;
  const rec = { k: 'd', ...pre,
    out: s ? { state: s.state, side: s.side, pWin: s.pWin, pFlip: s.pFlip, pFlipCons: s.pFlipCons, action: s.trade ? s.trade.action : null, ev: s.trade ? s.trade.evConsCents : null } : null };
  TAPE28.rows.push(rec); if (TAPE28.rows.length > TAPE28_MAX) { TAPE28.rows.shift(); TAPE28.dropped++; }
  if (TAPE28_FILE) tapeWrite28(rec);
  TAPE28.sinceDigest.push(sha28(canon28(rec)));
}

/* ---------------------------------------------------------------- background: shadow policies + ledger */
function shadowWindow28(ticker, closeMs, strike) {
  let w = SHADOW28.windows.get(ticker);
  if (!w) { w = { ticker, closeMs, strike, recs: {}, opened: Date.now() }; SHADOW28.windows.set(ticker, w); ledgerAppend28(L28, 'window', { ticker, closeMs, strike }); }
  return w;
}
function bg28(snap, pre, now) {
  const s = snap.signal; if (!s || !s.ticker) return;
  const tau = s.tau;
  tapeSample28();
  if (Number.isFinite(tau) && tau <= LOCK_MAX_TAU && tau > 0) {
    /* one tape record per second inside the LOCKED horizon */
    const sec = Math.floor(now / 1000);
    if (sec !== TAPE28.lastRecSec) { TAPE28.lastRecSec = sec; tapeRecord28(pre, snap); }
    const w = shadowWindow28(s.ticker, s.closeMs, s.strike);
    const kal = pre.kal || { ok: false };
    const book = bookFromKal(kal, now);
    const base = { state: s.state, side: s.side, pWin: s.pWin, pFlip: s.pFlip, pFlipCons: s.pFlipCons, trade: s.trade };
    const view = { geo: snap.geo, gates: s.gates || snap.gates, book, decision: base, panel: snap.settle };
    const cfg = { ...m25Cfg(DEFAULT_CONTRACTS), minTradeAskCents: MIN_TRADE_ASK_CENTS };
    let imp = null; if (tau <= 90) { try { imp = impulseState(now); } catch (_) { imp = null; } }   // policy D acts only inside 90 s
    for (const p of SHADOW_POLICIES28) {
      const rec = w.recs[p.id];
      let d;
      try { d = shadowDecide28(p.id, { snap: view, deps: { m25Decide, recalPUp26, recalRatio26 }, cfg, lockedSide: rec ? rec.lockedSide : null, hist: LOCK25.hist, impulse: imp, tau }); }
      catch (e) { d = null; BG.lastErr = 'shadow ' + p.id + ': ' + String(e && e.message || e); }
      const ev = shadowNote28(w.recs, p.id, d, { tau, now, bookAgeMs: book.ok ? book.ageMs : null });
      if (ev) for (const k of ev.events) ledgerAppend28(L28, 'call', { ticker: s.ticker, closeMs: s.closeMs, strike: s.strike, policy: p.id, event: k, rec: ev.rec[k] }, now);
    }
    calib28(w, s, tau, now);
    if (snap.geo) latNote28(LAT28, 'decisionIndexInputAgeMs', snap.geo.inputAgeMs);
    if (book.ok && book.ageMs != null) latNote28(LAT28, 'decisionBookAgeMs', book.ageMs);
  }
  /* commit the per-second tape every 15 s (hash of the records, not the records) */
  if (TAPE28.sinceDigest.length && now - TAPE28.lastDigestTs >= 15000) {
    ledgerAppend28(L28, 'digest', { n: TAPE28.sinceDigest.length, sha: sha28(TAPE28.sinceDigest.join('')) }, now);
    TAPE28.sinceDigest = []; TAPE28.lastDigestTs = now;
  }
}
/* G5 calibration evidence, committed to the ledger before the outcome (the tape is diagnostic and may be partial):
   the displayed P(UP) at tau 60/30/10 s (first tick at or below, within 1 s) and at the first entry into each
   0.2-5 % flip band inside the LOCKED horizon. A DATA UNRELIABLE state is not a forecast and is never recorded. */
const CALIB28_TAUS = [60, 30, 10], CALIB28_BANDS = [[0.002, 0.005], [0.005, 0.01], [0.01, 0.02], [0.02, 0.05]];
function calib28(w, s, tau, now) {
  const c = w.calib || (w.calib = { taus: {}, bands: {} });
  const ok = s.pWin != null && Number.isFinite(s.pWin) && (s.side === 'UP' || s.side === 'DOWN') && s.state !== 'DATA UNRELIABLE' && s.state !== 'AWAITING SETTLEMENT';
  const pUp = ok ? Math.round((s.side === 'UP' ? s.pWin : 1 - s.pWin) * 1e6) / 1e6 : null;
  for (const tt of CALIB28_TAUS) if (c.taus[tt] == null && tau <= tt) {
    c.taus[tt] = ok && tau > tt - 1;
    if (c.taus[tt]) ledgerAppend28(L28, 'calib', { ticker: s.ticker, closeMs: s.closeMs, kind: 'tau', target: tt, tau: r4(tau), pUp, state: s.state }, now);
  }
  if (!ok) return;
  const flip = Math.min(pUp, 1 - pUp);
  for (const [lo, hi] of CALIB28_BANDS) { const k = `${100 * lo}-${100 * hi}%`;
    if (!c.bands[k] && flip >= lo && flip < hi) { c.bands[k] = 1; ledgerAppend28(L28, 'calib', { ticker: s.ticker, closeMs: s.closeMs, kind: 'band', band: k, tau: r4(tau), pUp, state: s.state }, now); } }
}
/* every 60 s whether or not a window is live: feed health goes on the record even when the engine is blind */
function heartbeat28(now = Date.now()) {
  HB28.lastTs = now;
  /* latency histograms every 5 min (and at SIGTERM): G6 is evaluated on the whole test period from these, not on a
     rolling /latency snapshot, and a restart loses at most the last few minutes */
  if (!HB28.latTs) HB28.latTs = now;
  if (now - HB28.latTs >= 300000) latCommit28(now);
  ledgerAppend28(L28, 'heartbeat', { uptimeSec: Math.round((now - BOOT28.ts) / 1000), live: VENUE_LIST().filter(v => venueFresh(v, now)).map(v => v.name),
    kalshi: KAL.market ? KAL.market.ticker : null, kalshiAgeMs: KAL.ts ? now - KAL.ts : null, brti: BRTI.state, bgTicks: BG.ticks, bgErr: BG.lastErr, scored: SHADOW28.scored }, now);
}
function latCommit28(now = Date.now()) {
  const hist = latFlush28(LAT28);
  if (Object.keys(hist).length) ledgerAppend28(L28, 'latency', { since: HB28.latTs || now, until: now, hist }, now);
  HB28.latTs = now;
}
/* settlement: score every policy's first calls for this window, commit the outcome */
function shadowFinalize28(ticker, result, official) {
  const w = SHADOW28.windows.get(ticker); if (!w) return null;
  SHADOW28.windows.delete(ticker);
  const winner = result === 'yes' ? 'UP' : 'DOWN';
  const scores = {}, records = {};
  for (const p of SHADOW_POLICIES28) { records[p.id] = w.recs[p.id] || null; scores[p.id] = shadowAccumulate28(SHADOW28.stats, p.id, w.recs[p.id] || null, winner); }
  SHADOW28.scored++; SHADOW28.lastScore = { ticker, winner, ts: Date.now() };
  ledgerAppend28(L28, 'outcome', { ticker, closeMs: w.closeMs, strike: w.strike, result, official, winner, records, scores, ...(w.restored ? { restoredAfterRestart: true } : {}) });
  return scores;
}
function shadowExpire28(now = Date.now()) {
  for (const [tk, w] of SHADOW28.windows) if (now - Math.max(w.closeMs, w.restoredAt || 0) > 45 * 60000) { SHADOW28.windows.delete(tk); ledgerAppend28(L28, 'unresolved', { ticker: tk, closeMs: w.closeMs, ...(w.restored ? { restoredAfterRestart: true } : {}) }); }
}
/* windows restored after a restart that closed before this process saw them roll over: the 2.7 settlement tracker
   never learns of them, so ask Kalshi directly (every minute until settled or expired) */
async function settleRestored28(now = Date.now()) {
  for (const w of [...SHADOW28.windows.values()]) {
    if (!w.restored || now < w.closeMs + 2500 || (typeof SETTLE !== 'undefined' && SETTLE.pending.has(w.ticker))) continue;
    try {
      const j = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(w.ticker)}`, {}, 2500);
      const m = j && (j.market || j); const res = m && String(m.result || '').toLowerCase(), ev = Number(m && m.expiration_value);
      if ((res === 'yes' || res === 'no') && Number.isFinite(ev) && SHADOW28.windows.has(w.ticker)) shadowFinalize28(w.ticker, res, ev);
    } catch (_) { /* next minute */ }
  }
}
function v28Summary(now = Date.now()) {
  return { ok: true, version: SERVER_VERSION, build: BUILD_ID, core: CORE28_VERSION, prereg: PREREG28_ID, configHash: CONFIG28_HASH, boot: BOOT28.id,
    ledger: { head: L28.head, seq: L28.seq, inMemory: L28.rows.length, dropped: L28.dropped, file: LEDGER28_FILE || null, fileErr: L28.fileErr, resumed: L28.resumed,
      writeFailures: L28.writeFailures, pendingWrites: L28.pending.length, durableSeq: LEDGER28_FILE && !L28.memoryOnly ? L28.fileSeq : null, memoryOnly: !!L28.memoryOnly,
      chainId: L28.chainId || null, fileStopped: L28.fileStopped, lastRecovered: L28.lastRecovered || null },
    shadow: { openWindows: SHADOW28.windows.size, scoredWindows: SHADOW28.scored, lastScore: SHADOW28.lastScore, restoredAfterRestart: SHADOW28.restored },
    fees: { ...FEE28.cfg, isDefault: FEE28.isDefault, verified: FEE28.verified, error: FEE28.error, fetchedAt: FEE28.fetchedAt },
    tape: { records: TAPE28.rows.length, samples: TAPE28.samples.length, dropped: TAPE28.dropped, file: TAPE28_FILE || null, fileErr: TAPE28.fileErr, fileBytes: TAPE28.fileBytes ?? null, rotations: TAPE28.rotations || 0 },
    clientLatency: { unauthenticated: true, rateLimitedPerSec: 4, droppedSamples: CLAT28.dropped },
    latency: latSummary28(LAT28) };
}
function start28() {
  if (process.env.PINRADAR_REPLAY || START28.done) return; START28.done = true;
  fee28Refresh(); const t = setInterval(fee28Refresh, 6 * 3600 * 1000); if (t.unref) t.unref();
  settleRestored28().catch(() => { });
  /* a deploy or restart sends SIGTERM: commit the partial latency histogram first (there is no other handler, so exit as the default would) */
  if (!process.listenerCount('SIGTERM')) process.once('SIGTERM', () => { try { latCommit28(); ledgerAppend28(L28, 'shutdown', { boot: BOOT28.id, signal: 'SIGTERM' }); } catch (_) { } process.exit(0); });
  const t2 = setInterval(() => { settleRestored28().catch(() => { }); shadowExpire28(); heartbeat28(); }, 60000); if (t2.unref) t2.unref();
}
const START28 = { done: false };
