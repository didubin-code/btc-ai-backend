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
   ===================================================================== */
function envNum28(k, d, lo, hi) { const n = Number(process.env[k]); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; }
const LADDER_SIZES28 = String(process.env.LADDER_SIZES || '1,5,10,25,50,100').split(',').map(Number).filter(x => Number.isFinite(x) && x >= 1 && x <= 100000).slice(0, 10);
const LEDGER28_FILE = String(process.env.LEDGER_FILE || '').trim();
const TAPE28_FILE = String(process.env.TAPE_FILE || '').trim();
const TAPE28_MAX = envNum28('TAPE_MAX', 3000, 200, 200000);
const SHADOW28_P0 = envNum28('MONITOR_P0', LOCK_MAX_FLIP, 0.0005, 0.1);          // failure alarm H0: loss rate <= the LOCKED standard
const PREREG28_ID = 'pinradar-2.8-prereg-v1';                                     // PREREGISTRATION.md, frozen before any forward data

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
    const mult = Number(s.fee_multiplier), type = s.fee_type != null ? String(s.fee_type) : null;
    const before = JSON.stringify(FEE28.cfg);
    if (Number.isFinite(mult) && mult >= 0 && mult <= 10) FEE28.cfg.seriesMultiplier = mult;
    if (type) {
      FEE28.cfg.feeType = type;
      /* maker fees exist only on series whose fee_type names them (third-party documentation: 0.0175 maker
         coefficient); an explicit FEE_MAKER_MULT env value always wins */
      if (!process.env.FEE_MAKER_MULT) FEE28.cfg.makerMult = /maker/i.test(type) ? 0.0175 : 0;
    }
    FEE28.cfg.source = `Kalshi series record ${KALSHI_SERIES}: fee_type ${type ?? 'absent'}, fee_multiplier ${Number.isFinite(mult) ? mult : 'absent'}`
      + ' (rounding unit and taker coefficient 0.07 are not in the record: ' + FEE28.cfg.rounding + ' rounding assumed)';
    FEE28.verified = Number.isFinite(mult) || !!type; FEE28.fetchedAt = Date.now(); FEE28.error = null;
    FEE28.series = { fee_type: type, fee_multiplier: Number.isFinite(mult) ? mult : null, ticker: s.ticker || KALSHI_SERIES };
    fee28Recompute();
    if (JSON.stringify(FEE28.cfg) !== before) { FEE28.history.push({ ts: Date.now(), cfg: { ...FEE28.cfg } }); if (typeof L28 !== 'undefined') ledgerAppend28(L28, 'fees', { cfg: FEE28.cfg, isDefault: FEE28.isDefault }); }
  } catch (e) { FEE28.error = String(e && e.message || e); FEE28.fetchedAt = Date.now(); }
}

/* ---------------------------------------------------------------- ledger, shadow state, monitors, latency */
const BOOT28 = { id: crypto.randomBytes(6).toString('hex'), ts: Date.now() };
const CONFIG28 = { server: SERVER_VERSION, build: BUILD_ID, core: CORE28_VERSION, model: MODEL_VERSION, prereg: PREREG28_ID,
  lockMaxFlip: LOCK_MAX_FLIP, highMaxFlip: HIGH_MAX_FLIP, revFlip: REV_FLIP, minEdgeCents: MIN_EDGE_CENTS, minExecTau: MIN_EXEC_TAU,
  contracts: DEFAULT_CONTRACTS, maxBookAgeMs: MAX_BOOK_AGE_MS, recal: [RECAL_QUIET, RECAL_NORMAL, RECAL_ACTIVE], liveVolScale: LIVE_VOL_SCALE,
  minTradeAskCents: MIN_TRADE_ASK_CENTS, lockMaxTau: LOCK_MAX_TAU, policies: SHADOW_POLICIES28.map(p => p.id), pool: POOL28, unc: UNC28, monitorP0: SHADOW28_P0 };
const CONFIG28_HASH = sha28(canon28(CONFIG28));
const L28 = (() => {
  let L = mkLedger28({ genesisSeed: 'pinradar-2.8|' + CONFIG28_HASH, file: LEDGER28_FILE, fs: LEDGER28_FILE ? require('fs') : null, maxMem: envNum28('LEDGER_MAX', 50000, 1000, 1000000) });
  L.resumed = null;
  /* continue an existing chain across restarts when the file survives (persistent disk) */
  if (LEDGER28_FILE && !process.env.PINRADAR_REPLAY) {
    try {
      const fs = require('fs');
      if (fs.existsSync(LEDGER28_FILE)) {
        const rows = fs.readFileSync(LEDGER28_FILE, 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x));
        const v = verifyLedger28(rows, rows.length && rows[0].seq === 1 ? rows[0].prev : null);
        if (v.ok && rows.length) { L.head = v.head; L.seq = rows[rows.length - 1].seq; L.genesis = rows[0].prev; L.rows = rows.slice(-L.maxMem); L.resumed = { n: rows.length, head: v.head }; }
        else if (rows.length) { const bad = LEDGER28_FILE + '.broken-' + Date.now(); fs.renameSync(LEDGER28_FILE, bad); L.resumed = { brokenFileMovedTo: bad, why: v.why, at: v.at }; }
      }
    } catch (e) { L.fileErr = 'resume failed: ' + String(e && e.message || e); }
  }
  return L;
})();
const SHADOW28 = { windows: new Map(), stats: mkShadowStats28(SHADOW_POLICIES28, SHADOW28_P0), scored: 0, lastScore: null };
const LAT28 = mkLat28(3000);
const TAPE28 = { rows: [], samples: [], lastSampleTs: 0, sinceDigest: [], lastDigestTs: 0, dropped: 0, fileErr: null };
const HB28 = { lastTs: 0 };
/* rebuild the monitors from committed outcomes so a restart does not reset the evidence */
(function rebuild28() {
  for (const e of L28.rows) if (e.type === 'outcome' && e.body && e.body.records) {
    for (const [pid, rec] of Object.entries(e.body.records)) shadowAccumulate28(SHADOW28.stats, pid, rec, e.body.winner);
    SHADOW28.scored++;
  }
})();
ledgerAppend28(L28, 'boot', { boot: BOOT28.id, config: CONFIG28, configHash: CONFIG28_HASH, resumed: L28.resumed, fees: FEE28.cfg });

/* ---------------------------------------------------------------- signal enrichment (every snapshot) */
function settledFor28(ticker) {
  if (typeof SETTLE === 'undefined' || !ticker) return null;
  const d = SETTLE.done.find(x => x.ticker === ticker && x.status === 'SETTLED');
  return d ? { result: d.result, official: d.official } : null;
}
function enrich28(sig, { geo, settle, kal, now, tau }) {
  if (!sig) return sig;
  const group = geo && geo.recal ? geo.recal.group : 'unknown';
  const band = sig.pFlip != null && sig.state !== 'DATA UNRELIABLE' ? band28(sig.pFlip, group) : null;
  const book = bookFromKal(kal, now);
  const lv = book.ok && sig.side ? (sig.side === 'UP' ? book.yesAsks : book.noAsks) : null;
  const pWin = sig.pWin, pWinCons = sig.pFlipCons != null ? 1 - sig.pFlipCons : null, pWinStress = band ? 1 - Math.max(band.hi, sig.pFlipCons || 0) : null;
  const ladder = lv && lv.length ? evLadder28({ levels: lv, pWin, pWinCons, pWinStress, sizes: LADDER_SIZES28, cfg: FEE28.cfg }) : [];
  const tr = sig.trade || {};
  const locked = sig.state === 'LOCKED' || sig.state === 'PROVEN LOCKED';
  const bookFresh = !!(book.ok && book.ageMs != null && book.ageMs <= MAX_BOOK_AGE_MS);
  const contracts = tr.contracts || DEFAULT_CONTRACTS;
  sig.v28 = {
    outcome: { state: sig.state, side: sig.side, locked, winProbability: pWin, flipProbability: sig.pFlip,
      flipBand: band, winLabel: band ? `${fmtWin(pWin)} (plausible ${fmtWin(1 - band.hi)}–${fmtWin(1 - band.lo)})` : null, flipLabel: band ? band.label : null,
      note: band ? 'band = range of realised loss rates this displayed probability has corresponded to (Jul-Oct 2026 calibration drift); decisions use the validated point rule' : null },
    value: { minEdgeCents: MIN_EDGE_CENTS, contracts, askCents: tr.askCents ?? null, avgCents: tr.avgCents ?? null, feeCents: tr.feeCents ?? null,
      evCents: tr.evCents ?? null, evConsCents: tr.evConsCents ?? null, positive: tr.evConsCents != null && tr.evConsCents >= MIN_EDGE_CENTS,
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
  const panel = fin ? { reference: 'OFFICIAL', decided: true, final: settleRound2(fin.value) } : { reference: 'PROXY', decided: true };
  return designation28({ tau: -1, panel, settled: w.status === 'SETTLED' ? { result: w.result, official: w.official } : null, strike: w.strike });
}

/* ---------------------------------------------------------------- record & replay tape */
function tapePre28({ now, kal, liveIdx, age, quality, strikeIssue }) {
  const prev = (typeof SETTLE !== 'undefined' && kal && Number.isFinite(kal.openMs)) ? SETTLE.done.find(d => d.closeMs === kal.openMs && d.status === 'SETTLED' && Number.isFinite(d.official)) : null;
  return { ts: now, kal: kal ? { ok: kal.ok, ticker: kal.ticker, closeMs: kal.closeMs, openMs: kal.openMs, strike: kal.strike } : null,
    liveIdx: liveIdx ? { value: liveIdx.value, used: liveIdx.used.slice(), dispersionBps: liveIdx.dispersionBps } : null,
    ageMs: Number.isFinite(age) ? age : null, quality: { grade: quality.grade, problems: quality.problems.slice(), warnings: quality.warnings.slice() },
    strikeIssue: strikeIssue || null, prevSettled: prev ? { ticker: prev.ticker, closeMs: prev.closeMs, official: prev.official } : null,
    ob: KAL.ob && kal && KAL.ob.ticker === kal.ticker ? { ticker: KAL.ob.ticker, yes: KAL.ob.yes.slice(0, 20), no: KAL.ob.no.slice(0, 20) } : null, obTs: KAL.obTs || 0,
    skew: { n: SKEW.samples.length, est: SKEW.estMs }, rest: !!RESTF.active,
    lock25: { ticker: LOCK25.ticker, hist: LOCK25.hist.map(h => ({ t: h.t, pUp: h.pUp })), lockedSide: LOCK25.lockedSide, lockedAtTau: LOCK25.lockedAtTau, revNoted: LOCK25.revNoted },
    brti: { enabled: BRTI.enabled, last: BRTI.last, last5: BRTI.last5, win: BRTI.win } };
}
function tapeSample28() {
  const last = IDX.ring.length ? IDX.ring[IDX.ring.length - 1] : null;
  if (!last || last[0] <= TAPE28.lastSampleTs) return;
  for (const p of IDX.ring) if (p[0] > TAPE28.lastSampleTs) { TAPE28.samples.push([p[0], p[1]]); if (TAPE28_FILE) tapeWrite28({ k: 's', t: p[0], v: p[1] }); }
  TAPE28.lastSampleTs = last[0];
  while (TAPE28.samples.length > 4000) TAPE28.samples.shift();
}
function tapeWrite28(o) { try { require('fs').appendFileSync(TAPE28_FILE, JSON.stringify(o) + '\n'); } catch (e) { TAPE28.fileErr = String(e && e.message || e); } }
function tapeRecord28(pre, snap) {
  const s = snap.signal;
  const rec = { k: 'd', ...pre, basisMu: snap.geo ? snap.geo.basisMeanUsd : null,
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
    const cfg = m25Cfg(DEFAULT_CONTRACTS);
    let imp = null; if (tau <= 90) { try { imp = impulseState(now); } catch (_) { imp = null; } }   // policy D acts only inside 90 s
    for (const p of SHADOW_POLICIES28) {
      const rec = w.recs[p.id];
      let d;
      try { d = shadowDecide28(p.id, { snap: view, deps: { m25Decide, recalPUp26, recalRatio26 }, cfg, lockedSide: rec ? rec.lockedSide : null, hist: LOCK25.hist, impulse: imp, tau }); }
      catch (e) { d = null; BG.lastErr = 'shadow ' + p.id + ': ' + String(e && e.message || e); }
      const ev = shadowNote28(w.recs, p.id, d, { tau, now, bookAgeMs: book.ok ? book.ageMs : null });
      if (ev) for (const k of ev.events) ledgerAppend28(L28, 'call', { ticker: s.ticker, closeMs: s.closeMs, strike: s.strike, policy: p.id, event: k, rec: ev.rec[k] }, now);
    }
    if (snap.geo) latNote28(LAT28, 'decisionIndexInputAgeMs', snap.geo.inputAgeMs);
    if (book.ok && book.ageMs != null) latNote28(LAT28, 'decisionBookAgeMs', book.ageMs);
  }
  /* commit the per-second tape every 15 s (hash of the records, not the records) */
  if (TAPE28.sinceDigest.length && now - TAPE28.lastDigestTs >= 15000) {
    ledgerAppend28(L28, 'digest', { n: TAPE28.sinceDigest.length, sha: sha28(TAPE28.sinceDigest.join('')) }, now);
    TAPE28.sinceDigest = []; TAPE28.lastDigestTs = now;
  }
}
/* every 60 s whether or not a window is live: feed health goes on the record even when the engine is blind */
function heartbeat28(now = Date.now()) {
  HB28.lastTs = now;
  ledgerAppend28(L28, 'heartbeat', { uptimeSec: Math.round((now - BOOT28.ts) / 1000), live: VENUE_LIST().filter(v => venueFresh(v, now)).map(v => v.name),
    kalshi: KAL.market ? KAL.market.ticker : null, kalshiAgeMs: KAL.ts ? now - KAL.ts : null, brti: BRTI.state, bgTicks: BG.ticks, bgErr: BG.lastErr, scored: SHADOW28.scored }, now);
}
/* settlement: score every policy's first calls for this window, commit the outcome */
function shadowFinalize28(ticker, result, official) {
  const w = SHADOW28.windows.get(ticker); if (!w) return null;
  SHADOW28.windows.delete(ticker);
  const winner = result === 'yes' ? 'UP' : 'DOWN';
  const scores = {}, records = {};
  for (const p of SHADOW_POLICIES28) { records[p.id] = w.recs[p.id] || null; scores[p.id] = shadowAccumulate28(SHADOW28.stats, p.id, w.recs[p.id] || null, winner); }
  SHADOW28.scored++; SHADOW28.lastScore = { ticker, winner, ts: Date.now() };
  ledgerAppend28(L28, 'outcome', { ticker, closeMs: w.closeMs, strike: w.strike, result, official, winner, records, scores });
  return scores;
}
function shadowExpire28(now = Date.now()) {
  for (const [tk, w] of SHADOW28.windows) if (now - w.closeMs > 45 * 60000) { SHADOW28.windows.delete(tk); ledgerAppend28(L28, 'unresolved', { ticker: tk, closeMs: w.closeMs }); }
}
function v28Summary(now = Date.now()) {
  return { ok: true, version: SERVER_VERSION, build: BUILD_ID, core: CORE28_VERSION, prereg: PREREG28_ID, configHash: CONFIG28_HASH, boot: BOOT28.id,
    ledger: { head: L28.head, seq: L28.seq, inMemory: L28.rows.length, dropped: L28.dropped, file: LEDGER28_FILE || null, fileErr: L28.fileErr, resumed: L28.resumed },
    shadow: { openWindows: SHADOW28.windows.size, scoredWindows: SHADOW28.scored, lastScore: SHADOW28.lastScore },
    fees: { ...FEE28.cfg, isDefault: FEE28.isDefault, verified: FEE28.verified, error: FEE28.error, fetchedAt: FEE28.fetchedAt },
    tape: { records: TAPE28.rows.length, samples: TAPE28.samples.length, dropped: TAPE28.dropped, file: TAPE28_FILE || null, fileErr: TAPE28.fileErr },
    latency: latSummary28(LAT28) };
}
function start28() {
  if (process.env.PINRADAR_REPLAY || START28.done) return; START28.done = true;
  fee28Refresh(); const t = setInterval(fee28Refresh, 6 * 3600 * 1000); if (t.unref) t.unref();
  const t2 = setInterval(() => { shadowExpire28(); heartbeat28(); }, 60000); if (t2.unref) t2.unref();
}
const START28 = { done: false };
