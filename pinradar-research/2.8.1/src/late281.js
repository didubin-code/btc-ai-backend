/* ===================================================================================================
   v2.8.1 — restart-aware LOCKED and execution-aware actions (Oct 14 2026 late-LOCKED investigation)

   1. COLD-START VOLATILITY ENVELOPE. The validated volatility is rms(sigma_120, sigma_900) on a full 900 s
      index history. After a restart 2.8 withheld LOCKED for 300 s ("warming up") and then used a 900 s
      estimate built from as little as 300 s. 2.8.1: from COLD_MIN_SEC (120 s) of history until 900 s, the
      unknown sigma_900 is bracketed by
        lower  sqrt(m/900) * sigma_m        (exact: the unseen 900-m seconds cannot have negative variance)
        upper  max(K(m) * sigma_m, F(m))    (empirical, 1 Hz index Jul-Aug 2026; validation Sep-Oct: 100 % covered)
      and the call uses the WORST probability over that bracket. Whenever the bracket holds the true sigma_900,
      a cold LOCKED is a LOCKED the warm, validated engine would also show at that second.
   2. COLD BASIS ENVELOPE. The basis model (official settlement minus our index) restarts at its prior mean 0
      and needs hours of settled windows. Until BASIS_WARM_N live samples, the call uses the worst probability
      over basis means BASIS_COLD_LO..BASIS_COLD_HI (the range of walk-forward means seen Jul-Oct, rounded out).
   3. ORDER TIME. TRADE NOW needs tau >= MIN_EXEC_TAU + the trader's order time (EXEC_SEC, or the page's
      setting): a signal you cannot act on in time is TOO LATE TO TRADE, never TRADE NOW.
   4. EXECUTION STRESS. TRADE NOW also needs a non-negative expected value if BTC moves against the call by
      a one-sided EXEC_STRESS_Z quantile during the order time (then the rest of the window is random as usual).
   5. ACTION STATES for the page: TRADE NOW / PREDICTED LOCKED (not tradable now: why) / TOO LATE TO TRADE /
      SIT OUT / FINAL (awaiting settlement, mathematically final, officially settled), with the last moment
      an order can still be placed, a "get ready" note when LOCKED is projected within the order time, and
      the restart / warm-up status.
   Decisions are identical to 2.8 when the server has >= 900 s of index history, >= BASIS_WARM_N live basis
   samples and EXEC_SEC = 0 (checked by test/late281_test.js).
   =================================================================================================== */
const COLD281_ON = String(process.env.COLD_START_ENVELOPE ?? '1') !== '0';
const DQ_FIXES281 = String(process.env.DQ_FIXES ?? '1') !== '0';           // data-quality fixes (print mapping, aligned sampler, fresh quorum)
const COLD_FULL_SEC = 900;
const COLD_MIN_SEC = clampEnv(process.env.COLD_MIN_SEC, 120, 120, 900);
/* [m seconds of history, K(m), F(m) bps/sqrt s]: research28/late_lock/calib_coldvol.js (99.9th pct x 1.15, monotone) */
const COLD_TABLE281 = [[60, 4.345, 0.715], [75, 3.965, 0.714], [90, 3.857, 0.713], [120, 3.638, 0.54], [150, 3.59, 0.531], [180, 3.555, 0.531],
  [240, 3.434, 0.528], [300, 3.304, 0.519], [360, 3.176, 0.364], [450, 2.881, 0.342], [600, 2.542, 0.282], [750, 2.093, 0.282], [850, 1.782, 0.278]];
const COLD_GRID281 = 9;
const BASIS_WARM_N = clampEnv(process.env.BASIS_WARM_N, 12, 0, 10000);
const BASIS_COLD_LO = clampEnv(process.env.BASIS_COLD_LO, -7, -100, 0);
const BASIS_COLD_HI = clampEnv(process.env.BASIS_COLD_HI, 9, 0, 100);
const EXEC_SEC = clampEnv(process.env.EXEC_SEC, 12, 0, 120);          // 12 s order time + MIN_EXEC_TAU 3 s = a 15 s execution buffer
const EXEC_STRESS_Z = clampEnv(process.env.EXEC_STRESS_Z, 1.645, 0, 6);
const PREPARE_SEC281 = 20;

function execSec281(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);   // anything else -> the default
  return Number.isFinite(n) && n >= 0 ? Math.min(120, n) : EXEC_SEC;
}
function coldK281(m) { let row = COLD_TABLE281[0]; for (const r of COLD_TABLE281) if (r[0] <= m) row = r; return row; }
/* how much index history this process holds, and the sigma_900 bracket while it is short */
function coldVol281(now, ring) {
  const span = ring.length ? Math.max(0, (now - ring[0][0]) / 1000) : 0;
  if (span >= COLD_FULL_SEC) return { cold: false, span: round(span, 1) };
  const L = Math.max(1, Math.min(COLD_FULL_SEC, Math.ceil(span)));
  const all = ringRmsVol(L, now, ring), s120 = ringRmsVol(120, now, ring);
  /* m = returns actually observed (an index outage after the start leaves a hole: the bracket is looked up for what was seen, not for wall-clock) */
  const m = all.n || 0;
  const warm28 = ringRmsVol(COLD_FULL_SEC, now, ring).v != null;       // 2.8's own warm flag (>= 300 returns), used when the envelope is off
  const usable = COLD281_ON && m >= COLD_MIN_SEC && all.v != null && s120.v != null;
  if (!usable) return { cold: true, usable: false, span: round(span, 1), m, warm28 };
  const [, K, F] = coldK281(m);
  /* lower bound: sigma_900^2 >= (m/900) sigma_m^2 whatever the unseen returns were (with fewer than 900 - m unseen returns it is higher still) */
  const lo = Math.sqrt(Math.min(1, m / COLD_FULL_SEC)) * all.v, hi = Math.max(K * all.v, F, lo);
  return { cold: true, usable: true, span: round(span, 1), m, warm28, sigmaM: all.v, sigma120: s120.v, lo, hi, K, F };
}
function basisCold281(basisMu, basisLiveN) {
  const n = Number.isFinite(basisLiveN) ? basisLiveN : (basisMu == null ? BASIS.samples.length : Infinity);
  return { cold: COLD281_ON && n < BASIS_WARM_N, n: Number.isFinite(n) ? n : null };
}
/* worst case over the cold brackets (lockGeometry25 is unchanged; only its sigma / basis inputs vary).
   - P is not monotone in sigma: the tail table and the recalibration ratio change at the regime edges, and the flip risk is largest
     just BELOW an edge. The candidates are a log grid, the measured value, and the left limit of every regime edge inside the bracket
     (within one regime the flip risk grows with sigma, so the worst is at an end of the bracket or at an edge's left limit).
   - A side is called only if it leads under EVERY candidate; otherwise there is no call (P = 1/2, TOSS-UP). The worst case is never
     the opposite side presented as a confident call. */
function coldGeometry281(base, args, cv, bc) {
  if (!base || base.pUp == null) return base;
  const spec = (M25_MODEL && M25_MODEL.sigma) || { kind: 'single', Ls: [900] };
  const sigmas = [];
  if (cv.cold && cv.usable) {
    const comb = s900 => { const v = spec.Ls.map(L => L >= COLD_FULL_SEC ? s900 : (L <= 120 ? cv.sigma120 : s900));
      return spec.kind === 'rms' ? Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length) : spec.kind === 'max' ? Math.max(...v) : v[0]; };
    for (let i = 0; i < COLD_GRID281; i++) sigmas.push(comb(cv.lo * Math.pow(cv.hi / cv.lo, i / (COLD_GRID281 - 1))));
    sigmas.push(comb(cv.sigmaM));
    const cLo = comb(cv.lo), cHi = comb(cv.hi);
    const edges = (M25_MODEL && M25_MODEL.regime && M25_MODEL.regime.kind === 'sig' && M25_MODEL.regime.edges) || [];
    for (const e of edges) {
      if (!(e > cLo && e <= cHi)) continue;
      let a = cv.lo, b = cv.hi;                                                   // comb is increasing in s900: bisect comb(s) = e
      for (let k = 0; k < 60; k++) { const mid = (a + b) / 2; if (comb(mid) < e) a = mid; else b = mid; }
      sigmas.push(Math.min(comb(a), e * (1 - 1e-9)));
    }
  } else sigmas.push(null);                                                       // the base sigma
  const mus = bc.cold ? [BASIS_COLD_LO, base.basisMeanUsd, BASIS_COLD_HI] : [args.basisMu];
  let minG = null, maxG = null, minCons = Infinity, maxCons = -Infinity, n = 0;
  for (const sv of sigmas) for (const mu of mus) {
    const g = lockGeometry25({ ...args, sigma: sv == null ? null : { value: sv, warm: true, parts: [] }, basisMu: mu });
    if (!g || g.pUp == null) continue; n++;
    if (!minG || g.pUp < minG.pUp) minG = g;
    if (!maxG || g.pUp > maxG.pUp) maxG = g;
    const pc = g.pUpCons == null ? g.pUp : g.pUpCons; minCons = Math.min(minCons, pc); maxCons = Math.max(maxCons, pc);
  }
  if (!minG) return base;
  let out, side;
  if (minG.pUp >= 0.5) { side = 'UP'; out = { ...minG, pUpCons: Math.min(minCons, minG.pUp) }; }
  else if (maxG.pUp < 0.5) { side = 'DOWN'; out = { ...maxG, pUpCons: Math.max(maxCons, maxG.pUp) }; }
  else { side = null; out = { ...base, pUp: 0.5, pUpCons: 0.5, pUpModel: 0.5, pUpConsModel: 0.5 }; }   // the candidates disagree on the leader: no call
  /* the volatility counts as warm only if it is (>= 900 s) or the envelope covers it; a basis-only envelope keeps the 2.8 flag */
  Object.assign(out, { sigmaWarm: cv.cold ? !!cv.usable : base.sigmaWarm,
    cold281: { active: true, volEnvelope: !!(cv.cold && cv.usable), basisEnvelope: !!bc.cold, historySec: cv.span, returnsSeen: cv.m,
      sigmaBand: cv.cold && cv.usable ? [round(cv.lo, 4), round(cv.hi, 4)] : null, sigmaMeasured: cv.sigmaM != null ? round(cv.sigmaM, 4) : null,
      basisBand: bc.cold ? [BASIS_COLD_LO, BASIS_COLD_HI] : null, basisLiveN: bc.n, candidates: n, leaderUnderAllCandidates: side,
      basePUp: base.pUp, pUpRange: [minG.pUp, maxG.pUp], worstSigmaBps: side ? out.sigmaRawBps : null, worstBasisUsd: side ? out.basisMeanUsd : null,
      note: side ? 'restart: the call uses the worst probability over the volatility / basis values the server cannot yet pin down'
        : 'restart: the leader depends on volatility / basis values the server cannot yet pin down: no call' } });
  if (cv.cold && cv.usable) out.sigmaParts = [{ L: 120, bps: round(cv.sigma120, 4), n: null }, { L: COLD_FULL_SEC, bps: null, band: [round(cv.lo, 4), round(cv.hi, 4)] }];
  return out;
}
/* execution stress: BTC has ALREADY moved against the call by a one-sided z quantile of the order-time move, and the whole remaining
   time is still random (the order-time diffusion is not removed): never less risky than the live call, and riskier the longer the order time */
function stressPUp281(geo, tau, execSec, z = EXEC_STRESS_Z) {
  if (!geo || geo.pUp == null || !Number.isFinite(tau) || !(execSec > 0) || !(z >= 0) || !M25_MODEL) return null;
  const sgn = geo.pUp >= 0.5 ? 1 : -1, d = Math.min(execSec, Math.max(0, tau));
  const shift = z * geo.sigmaBps * 1e-4 * geo.index * Math.sqrt(d), frac = Math.min(1, (geo.nRemaining == null ? 60 : geo.nRemaining) / 60);
  const b = geo.regime ? geo.regime.bucket : m25Bucket(M25_MODEL, 0);
  return recalPUp26(m25PUp(M25_MODEL, { tau: Math.max(0, tau), gap: geo.gapUsd - sgn * shift * frac, sigBps: geo.sigmaBps, S: geo.index, mu: geo.basisMeanUsd, bucket: b }), recalRatio26(b));
}
const EXEC281 = { windows: new Map(), keep: 200 };
function warmup281(now, cv, bc) {
  const up = bootTs ? Math.round((now - bootTs) / 1000) : null;
  const avail = !cv.cold || (COLD281_ON ? !!cv.usable : !!cv.warm28);
  const need = COLD281_ON ? COLD_MIN_SEC : 300;                       // envelope off = 2.8: ringRmsVol(900) needs >= 300 returns
  const seen = cv.m != null ? cv.m : cv.span;
  const lockIn = avail ? 0 : Math.max(1, Math.ceil(need - seen));
  return { uptimeSec: up, indexHistorySec: cv.span, volEnvelope: !!(cv.cold && cv.usable), lockedAvailable: avail,
    lockedAvailableInSec: lockIn, fullHistoryInSec: cv.cold ? Math.ceil(COLD_FULL_SEC - cv.span) : 0, basisLiveN: bc.n, basisCold: bc.cold,
    label: !cv.cold && !bc.cold ? null : (!avail ? `restarted: LOCKED unavailable for ~${lockIn} s more (index history ${Math.floor(seen)} s, needs ${need} s)`
      : (cv.cold ? (cv.usable ? `restarted ${Math.floor(cv.span)} s ago: conservative volatility envelope (full history in ${Math.ceil(COLD_FULL_SEC - cv.span)} s)`
        : `restarted ${Math.floor(cv.span)} s ago: volatility from partial history (2.8 behaviour, envelope off)`) : '')
        + (bc.cold ? `${cv.cold ? '; ' : ''}basis model cold (${bc.n}/${BASIS_WARM_N} settled windows): conservative basis range` : '')) };
}
/* the single action a trader should take now */
function exec281(sig, { tau, execSec, now, mutate = false }) {
  if (!sig) return sig;
  const tr = sig.trade || {}, st = sig.state, a = tr.action || '', lastOrderTau = MIN_EXEC_TAU + execSec;
  const left = Number.isFinite(tau) ? tau - lastOrderTau : null;
  let state, why, prepare = null;
  const des = sig.v28 && sig.v28.designation;
  if (Number.isFinite(tau) && tau <= 0) { state = 'FINAL'; why = (des && des.label) || 'window closed: awaiting settlement'; }
  else if (st === 'LOCKED' || st === 'PROVEN LOCKED') {
    if (left != null && left < 0) { state = 'TOO LATE TO TRADE'; why = /TOO LATE/.test(a) && !tr.noOffers ? tr.why : `${Math.max(0, tau).toFixed(1)} s left: past the last moment to place an order (T−${lastOrderTau} s with a ${execSec} s order time)`; }
    else if (a === 'TRADE NOW') { state = 'TRADE NOW'; why = tr.why; }
    else if (/TOO LATE/.test(a) && tr.noOffers) { state = 'PREDICTED LOCKED'; why = 'NO OFFERS — ' + tr.why + '; nothing to buy (not a timing problem)'; }
    else if (/TOO LATE/.test(a)) { state = 'TOO LATE TO TRADE'; why = tr.why; }
    else if (a === 'LOCKED — DO NOT TRADE' && tr.askCents != null && sig.pWin != null && !/survive/.test(tr.why || '')) {
      /* no edge: say plainly that the market is already at least as sure as the model, and at what price the trade would qualify */
      const pW = 100 * sig.pWin, pC = 100 * (1 - (sig.pFlipCons != null ? sig.pFlipCons : sig.pFlip)), fee = tr.feeCents || 0;
      const maxAsk = Math.floor((pC - fee - MIN_EDGE_CENTS) * 10) / 10;
      state = 'PREDICTED LOCKED';
      why = `NO EDGE — Kalshi already prices ${sig.side} at ${tr.askCents}¢ (≈${tr.askCents}% sure) vs the model's ${pW.toFixed(2)}%: buying at ${tr.avgCents}¢ + ${fee}¢ fee has expected value ${tr.evCents}¢ (cautious ${tr.evConsCents}¢) per contract. `
        + (maxAsk > 0 ? `It would qualify only at ≤ ${maxAsk}¢.` : 'No price qualifies.');
      sig.exec_edge = { askCents: tr.askCents, avgCents: tr.avgCents, feeCents: fee, modelWinPct: round(pW, 3), cautiousWinPct: round(pC, 3), evCents: tr.evCents, evConsCents: tr.evConsCents, maxAskForTradeNow: maxAsk };
    }
    else { state = 'PREDICTED LOCKED'; why = 'not tradable now — ' + (tr.why || a); }
  } else {
    state = 'SIT OUT';
    why = st === 'REVERSAL WARNING' ? 'REVERSAL WARNING: the LOCKED call is breaking down' : st === 'DATA UNRELIABLE' ? ('data unreliable: ' + ((sig.gates && sig.gates.hard[0]) || ''))
      : st === 'HIGH CONFIDENCE' ? ('not LOCKED' + (tr.why ? ' — ' + tr.why : '')) : `no LOCKED call (${st})`;
    const pj = sig.projection;
    const soft = (sig.gates && sig.gates.soft) || [], wu = sig.warmup;
    const gatesOk = soft.every(t => /outside the validated LOCKED horizon/.test(t)) && (!soft.length || (pj && pj.atTau != null && pj.atTau <= LOCK_MAX_TAU));
    if (st === 'HIGH CONFIDENCE' && gatesOk && (!wu || wu.lockedAvailable) && pj && pj.lockInSec != null && pj.lockInSec <= PREPARE_SEC281 && left != null && left - pj.lockInSec >= 0)
      prepare = `GET READY: LOCKED ${pj.side} projected in ~${Math.round(pj.lockInSec)} s if BTC holds — open the Kalshi ${pj.side === 'UP' ? 'YES' : 'NO'} ticket now; submit only on TRADE NOW`;
  }
  const edge = sig.exec_edge || null; delete sig.exec_edge;
  /* the three-word decision the page leads with, the reversal risk, and ONE short reason (no arithmetic left to the trader) */
  const locked = st === 'LOCKED' || st === 'PROVEN LOCKED', sd = sig.side || '';
  const headline = state === 'TRADE NOW' ? 'TRADE NOW' : (state === 'TOO LATE TO TRADE' || state === 'FINAL') ? 'TOO LATE' : 'SIT OUT';
  let reason;
  if (state === 'FINAL') reason = 'window closed: ' + ((des && des.label) || 'awaiting settlement');
  else if (state === 'TRADE NOW') reason = `buy ${sd === 'UP' ? 'YES (UP)' : 'NO (DOWN)'} at ≤ ${tr.askCents}¢: ${tr.evConsCents >= 0 ? '+' : ''}${tr.evConsCents}¢ per contract after fees (cautious)`;
  else if (state === 'TOO LATE TO TRADE') reason = `LOCKED ${sd} with ${Math.max(0, tau).toFixed(0)} s left: an order needs ${lastOrderTau} s`;
  else if (locked && edge) reason = `LOCKED ${sd}, but no edge at ${edge.askCents}¢` + (edge.maxAskForTradeNow > 0 ? ` (worth it only at ≤ ${edge.maxAskForTradeNow}¢)` : '');
  else if (locked && tr.noOffers) reason = `LOCKED ${sd}, but nobody is selling ${sd}: the market treats it as decided`;
  else if (locked && /survive/.test(tr.why || '')) reason = `LOCKED ${sd}, but the edge is too thin for a ${execSec} s order time`;
  else if (locked && /BOOK STALE|NO BOOK/.test(a)) reason = `LOCKED ${sd}, but the Kalshi order book is ${/NO BOOK/.test(a) ? 'missing' : 'stale'}`;
  else if (locked && /TOO THIN/.test(a)) reason = `LOCKED ${sd}, but ${tr.why || 'too few contracts offered'}`;
  else if (locked && /MARKET DISAGREES/.test(a)) reason = `LOCKED ${sd}, but Kalshi offers it at ${tr.askCents}¢: check the index and strike`;
  else if (locked) reason = `LOCKED ${sd}, not tradable: ${tr.why || a}`;
  else if (st === 'REVERSAL WARNING') reason = `REVERSAL WARNING: the earlier LOCKED ${sd} call is breaking down`;
  else if (st === 'DATA UNRELIABLE') reason = 'data unreliable: ' + ((sig.gates && sig.gates.hard[0]) || 'see the data panel');
  else if (st === 'HIGH CONFIDENCE') reason = `not LOCKED yet (${sd} ${sig.pWin != null ? (100 * sig.pWin).toFixed(2) + ' %' : ''})` + (sig.warmup && !sig.warmup.lockedAvailable ? ': server restarted, LOCKED unavailable for now' : '');
  else reason = `no reliable call (${st})`;
  const reversalPct = st === 'DATA UNRELIABLE' || sig.pFlip == null ? null : round(100 * sig.pFlip, 3);
  sig.exec = { headline, reversalPct, reason, state, why, prepare, execSec, lastOrderTau, secondsToLastOrder: left == null ? null : round(left, 1), edge, noOffers: !!tr.noOffers,
    note: 'TRADE NOW needs LOCKED, a fresh book with enough offers, a positive conservative edge after fees that survives an adverse move during your order time, and at least ' + lastOrderTau + ' s left' };
  /* per-window record of when the call became tradable / too late (diagnostic, /exec): background classifier only (default order time) */
  if (mutate && sig.ticker && Number.isFinite(tau) && tau > 0) {
    let w = EXEC281.windows.get(sig.ticker);
    if (!w) { w = { ticker: sig.ticker, closeMs: sig.closeMs, firstLockedTau: null, firstTradeTau: null, firstTooLateTau: null, lastOrderTau, side: null }; EXEC281.windows.set(sig.ticker, w);
      while (EXEC281.windows.size > EXEC281.keep) EXEC281.windows.delete(EXEC281.windows.keys().next().value); }
    if ((st === 'LOCKED' || st === 'PROVEN LOCKED') && w.firstLockedTau == null) { w.firstLockedTau = round(tau, 1); w.side = sig.side; }
    if (state === 'TRADE NOW' && w.firstTradeTau == null) w.firstTradeTau = round(tau, 1);
    if (state === 'TOO LATE TO TRADE' && w.firstTooLateTau == null) w.firstTooLateTau = round(tau, 1);
    if ((st === 'LOCKED' || st === 'PROVEN LOCKED') && state !== 'TRADE NOW' && w.firstBlock == null)
      w.firstBlock = { tau: round(tau, 1), state, reason: /^NO EDGE/.test(why) ? 'no edge' : /^NO OFFERS/.test(why) ? 'no offers' : state === 'TOO LATE TO TRADE' ? 'time'
        : /survive/.test(why) ? 'stress' : /STALE|NO BOOK|fresh/.test(why) ? 'book' : /THIN|contracts offered/.test(why) ? 'depth' : /MARKET DISAGREES|< 90/.test(why) ? 'market disagrees' : 'other' };
  }
  return sig;
}
function exec281Summary() {
  const ws = [...EXEC281.windows.values()].filter(w => w.closeMs < Date.now());
  const locked = ws.filter(w => w.firstLockedTau != null);
  const actionable = locked.filter(w => w.firstLockedTau >= w.lastOrderTau);
  return { windows: ws.length, locked: locked.length, lockedBeforeLastOrder: actionable.length, tradeNow: ws.filter(w => w.firstTradeTau != null).length,
    lockedOnlyAfterLastOrderMoment: locked.filter(w => w.firstLockedTau < w.lastOrderTau).length,
    lockedNotTradableBy: locked.filter(w => w.firstTradeTau == null && w.firstBlock).reduce((o, w) => { o[w.firstBlock.reason] = (o[w.firstBlock.reason] || 0) + 1; return o; }, {}), recent: ws.slice(-20),
    note: 'background classifier with the default order time (EXEC_SEC); since this process started' };
}

/* ---- data quality ---- */
/* the live index for a decision: if its oldest input would exceed the stale budget for this tau, rebuild it from the venues whose quotes
   are within the budget when they still form a quorum (one lagging venue must not poison an index two fresh, agreeing venues provide) */
function liveIndexFor281(now, tau) {
  const idx = computeIndex(now);
  if (!idx || !DQ_FIXES281) return { idx, freshQuorum: false };
  const ageOf = ix => Math.max(...VENUE_LIST().filter(v => ix.used.includes(v.name)).map(v => now - v.lastQuoteTs));
  const age = ageOf(idx);
  if (!Number.isFinite(tau) || tau <= 0) return { idx, freshQuorum: false };
  const budget = staleBudgetMs(tau);
  if (!(age > budget)) return { idx, freshQuorum: false };
  const keepReason = IDX.lastReason;
  const f = computeIndex(now, budget);
  if (f && !f.single && f.used.length >= MIN_INDEX_VENUES) return { idx: { ...f, freshQuorum: true, droppedStale: idx.used.filter(n => !f.used.includes(n)) }, freshQuorum: true };
  IDX.lastReason = keepReason;
  return { idx, freshQuorum: false };
}
/* every hard data gate the background classifier hits, with the venue state at that moment (/dq; summary on /health) */
const DQ281 = { counts: {}, recent: [], since: null, decisions: 0, unreliable: 0, keep: 200 };
function dqNote281(now, tau, ticker, gates) {
  if (!DQ281.since) DQ281.since = now;
  DQ281.decisions++;
  const hard = (gates && gates.hard) || [];
  if (!hard.length) return;
  DQ281.unreliable++;
  for (const h of hard) { const k = String(h).replace(/\$?-?[0-9][0-9.,]*/g, '#'); DQ281.counts[k] = (DQ281.counts[k] || 0) + 1; }
  DQ281.recent.push({ ts: now, ticker, tau: Number.isFinite(tau) ? round(tau, 1) : null, hard: hard.slice(),
    venues: VENUE_LIST().map(v => ({ name: v.name, state: v.state, fresh: venueFresh(v, now), quoteAgeMs: v.lastQuoteTs ? now - v.lastQuoteTs : null, msgAgeMs: v.lastMsgTs ? now - v.lastMsgTs : null, lastError: v.lastError || null })),
    ringSamples: IDX.ring.length, skewMs: Math.round(SKEW.estMs) });
  while (DQ281.recent.length > DQ281.keep) DQ281.recent.shift();
}
function dqSummary281(brief = false) {
  const top = Object.entries(DQ281.counts).sort((a, b) => b[1] - a[1]);
  const o = { since: DQ281.since ? new Date(DQ281.since).toISOString() : null, backgroundDecisions: DQ281.decisions, dataUnreliable: DQ281.unreliable,
    pct: DQ281.decisions ? round(100 * DQ281.unreliable / DQ281.decisions, 3) : null, reasons: Object.fromEntries(top.slice(0, brief ? 5 : 50)) };
  if (!brief) o.recent = DQ281.recent.slice(-100);
  return o;
}
