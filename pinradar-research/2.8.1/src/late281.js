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
const COLD_FULL_SEC = 900;
const COLD_MIN_SEC = clampEnv(process.env.COLD_MIN_SEC, 120, 120, 900);
/* [m seconds of history, K(m), F(m) bps/sqrt s]: research28/late_lock/calib_coldvol.js (99.9th pct x 1.15, monotone) */
const COLD_TABLE281 = [[60, 4.345, 0.715], [75, 3.965, 0.714], [90, 3.857, 0.713], [120, 3.638, 0.54], [150, 3.59, 0.531], [180, 3.555, 0.531],
  [240, 3.434, 0.528], [300, 3.304, 0.519], [360, 3.176, 0.364], [450, 2.881, 0.342], [600, 2.542, 0.282], [750, 2.093, 0.282], [850, 1.782, 0.278]];
const COLD_GRID281 = 9;
const BASIS_WARM_N = clampEnv(process.env.BASIS_WARM_N, 12, 0, 10000);
const BASIS_COLD_LO = clampEnv(process.env.BASIS_COLD_LO, -7, -100, 0);
const BASIS_COLD_HI = clampEnv(process.env.BASIS_COLD_HI, 9, 0, 100);
const EXEC_SEC = clampEnv(process.env.EXEC_SEC, 10, 0, 120);
const EXEC_STRESS_Z = clampEnv(process.env.EXEC_STRESS_Z, 1.645, 0, 6);
const PREPARE_SEC281 = 20;

function execSec281(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(120, n) : EXEC_SEC; }
function coldK281(m) { let row = COLD_TABLE281[0]; for (const r of COLD_TABLE281) if (r[0] <= m) row = r; return row; }
/* how much index history this process holds, and the sigma_900 bracket while it is short */
function coldVol281(now, ring) {
  const span = ring.length ? Math.max(0, (now - ring[0][0]) / 1000) : 0;
  if (span >= COLD_FULL_SEC) return { cold: false, span: round(span, 1) };
  const L = Math.max(1, Math.min(COLD_FULL_SEC, Math.floor(span)));
  const all = ringRmsVol(L, now, ring), s120 = ringRmsVol(120, now, ring);
  const usable = COLD281_ON && span >= COLD_MIN_SEC && all.v != null && s120.v != null;
  if (!usable) return { cold: true, usable: false, span: round(span, 1) };
  const [, K, F] = coldK281(span);
  const lo = Math.sqrt(Math.min(1, span / COLD_FULL_SEC)) * all.v, hi = Math.max(K * all.v, F, lo);
  return { cold: true, usable: true, span: round(span, 1), sigmaM: all.v, sigma120: s120.v, lo, hi, K, F };
}
function basisCold281(basisMu, basisLiveN) {
  const n = Number.isFinite(basisLiveN) ? basisLiveN : (basisMu == null ? BASIS.samples.length : Infinity);
  return { cold: COLD281_ON && n < BASIS_WARM_N, n: Number.isFinite(n) ? n : null };
}
/* worst-case geometry over the cold brackets (lockGeometry25 is unchanged; only its sigma / basis inputs vary) */
function coldGeometry281(base, args, cv, bc) {
  if (!base || base.pUp == null) return base;
  const spec = (M25_MODEL && M25_MODEL.sigma) || { kind: 'single', Ls: [900] };
  const sigmas = [];
  if (cv.cold && cv.usable) {
    const comb = s900 => { const v = spec.Ls.map(L => L >= COLD_FULL_SEC ? s900 : (L <= 120 ? cv.sigma120 : s900));
      return spec.kind === 'rms' ? Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length) : spec.kind === 'max' ? Math.max(...v) : v[0]; };
    for (let i = 0; i < COLD_GRID281; i++) sigmas.push(comb(cv.lo * Math.pow(cv.hi / cv.lo, i / (COLD_GRID281 - 1))));
    sigmas.push(comb(cv.sigmaM));
  } else sigmas.push(null);                                                       // the base sigma
  const mus = bc.cold ? [BASIS_COLD_LO, base.basisMeanUsd, BASIS_COLD_HI] : [args.basisMu];
  const side = base.pUp >= 0.5 ? 'UP' : 'DOWN', win = p => (side === 'UP' ? p : 1 - p);
  let worst = null, worstCons = Infinity, n = 0;
  for (const sv of sigmas) for (const mu of mus) {
    const g = lockGeometry25({ ...args, sigma: sv == null ? null : { value: sv, warm: true, parts: [] }, basisMu: mu });
    if (!g || g.pUp == null) continue; n++;
    if (!worst || win(g.pUp) < win(worst.pUp)) worst = g;
    worstCons = Math.min(worstCons, win(g.pUpCons == null ? g.pUp : g.pUpCons));
  }
  if (!worst) return base;
  /* the volatility counts as warm only if it is (>= 900 s) or the envelope covers it; a basis-only envelope keeps the 2.8 flag */
  const out = { ...worst, pUpCons: side === 'UP' ? worstCons : 1 - worstCons, sigmaWarm: cv.cold ? !!cv.usable : base.sigmaWarm,
    cold281: { active: true, volEnvelope: !!(cv.cold && cv.usable), basisEnvelope: !!bc.cold, historySec: cv.span,
      sigmaBand: cv.cold && cv.usable ? [round(cv.lo, 4), round(cv.hi, 4)] : null, sigmaMeasured: cv.sigmaM != null ? round(cv.sigmaM, 4) : null,
      basisBand: bc.cold ? [BASIS_COLD_LO, BASIS_COLD_HI] : null, basisLiveN: bc.n, candidates: n,
      basePUp: base.pUp, worstSigmaBps: worst.sigmaRawBps, worstBasisUsd: worst.basisMeanUsd,
      note: 'restart: the call uses the worst probability over the volatility / basis values the server cannot yet pin down' } };
  if (cv.cold && cv.usable) out.sigmaParts = [{ L: 120, bps: round(cv.sigma120, 4), n: null }, { L: COLD_FULL_SEC, bps: null, band: [round(cv.lo, 4), round(cv.hi, 4)] }];
  return out;
}
/* execution stress: BTC moves against the call by a one-sided z quantile while the order is being placed */
function stressPUp281(geo, tau, execSec, z = EXEC_STRESS_Z) {
  if (!geo || geo.pUp == null || !Number.isFinite(tau) || !(execSec > 0) || !(z >= 0) || !M25_MODEL) return null;
  const sgn = geo.pUp >= 0.5 ? 1 : -1, d = Math.min(execSec, Math.max(0, tau));
  const shift = z * geo.sigmaBps * 1e-4 * geo.index * Math.sqrt(d), frac = Math.min(1, (geo.nRemaining == null ? 60 : geo.nRemaining) / 60);
  const b = geo.regime ? geo.regime.bucket : m25Bucket(M25_MODEL, 0);
  return recalPUp26(m25PUp(M25_MODEL, { tau: Math.max(0, tau - d), gap: geo.gapUsd - sgn * shift * frac, sigBps: geo.sigmaBps, S: geo.index, mu: geo.basisMeanUsd, bucket: b }), recalRatio26(b));
}
const EXEC281 = { windows: new Map(), keep: 200 };
function warmup281(now, cv, bc) {
  const up = bootTs ? Math.round((now - bootTs) / 1000) : null;
  const lockIn = cv.span >= COLD_MIN_SEC ? 0 : Math.ceil(COLD_MIN_SEC - cv.span);
  return { uptimeSec: up, indexHistorySec: cv.span, volEnvelope: !!(cv.cold && cv.usable), lockedAvailable: cv.span >= COLD_MIN_SEC,
    lockedAvailableInSec: lockIn, fullHistoryInSec: cv.cold ? Math.ceil(COLD_FULL_SEC - cv.span) : 0, basisLiveN: bc.n, basisCold: bc.cold,
    label: !cv.cold && !bc.cold ? null : (cv.span < COLD_MIN_SEC ? `restarted: LOCKED unavailable for ${lockIn} s more (index history ${Math.floor(cv.span)} s)`
      : (cv.cold ? `restarted ${Math.floor(cv.span)} s ago: conservative volatility envelope (full history in ${Math.ceil(COLD_FULL_SEC - cv.span)} s)` : '')
        + (bc.cold ? `${cv.cold ? '; ' : ''}basis model cold (${bc.n}/${BASIS_WARM_N} settled windows): conservative basis range` : '')) };
}
/* the single action a trader should take now */
function exec281(sig, { tau, execSec, now }) {
  if (!sig) return sig;
  const tr = sig.trade || {}, st = sig.state, a = tr.action || '', lastOrderTau = MIN_EXEC_TAU + execSec;
  const left = Number.isFinite(tau) ? tau - lastOrderTau : null;
  let state, why, prepare = null;
  const des = sig.v28 && sig.v28.designation;
  if (Number.isFinite(tau) && tau <= 0) { state = 'FINAL'; why = (des && des.label) || 'window closed: awaiting settlement'; }
  else if (st === 'LOCKED' || st === 'PROVEN LOCKED') {
    if (a === 'TRADE NOW') { state = 'TRADE NOW'; why = tr.why; }
    else if (/TOO LATE/.test(a)) { state = 'TOO LATE TO TRADE'; why = tr.why; }
    else { state = 'PREDICTED LOCKED'; why = 'not tradable now — ' + (tr.why || a); }
  } else {
    state = 'SIT OUT';
    why = st === 'REVERSAL WARNING' ? 'REVERSAL WARNING: the LOCKED call is breaking down' : st === 'DATA UNRELIABLE' ? ('data unreliable: ' + ((sig.gates && sig.gates.hard[0]) || ''))
      : st === 'HIGH CONFIDENCE' ? ('not LOCKED' + (tr.why ? ' — ' + tr.why : '')) : `no LOCKED call (${st})`;
    const pj = sig.projection;
    if (st === 'HIGH CONFIDENCE' && pj && pj.lockInSec != null && pj.lockInSec <= PREPARE_SEC281 && left != null && left - pj.lockInSec >= 0)
      prepare = `GET READY: LOCKED ${pj.side} projected in ~${Math.round(pj.lockInSec)} s if BTC holds — open the Kalshi ${pj.side === 'UP' ? 'YES' : 'NO'} ticket now; submit only on TRADE NOW`;
  }
  sig.exec = { state, why, prepare, execSec, lastOrderTau, secondsToLastOrder: left == null ? null : round(left, 1),
    note: 'TRADE NOW needs LOCKED, a fresh book with enough offers, a positive conservative edge after fees that survives an adverse move during your order time, and at least ' + lastOrderTau + ' s left' };
  /* per-window record of when the call became tradable / too late (diagnostic, /exec) */
  if (sig.ticker && Number.isFinite(tau) && tau > 0) {
    let w = EXEC281.windows.get(sig.ticker);
    if (!w) { w = { ticker: sig.ticker, closeMs: sig.closeMs, firstLockedTau: null, firstTradeTau: null, firstTooLateTau: null, lastOrderTau, side: null }; EXEC281.windows.set(sig.ticker, w);
      while (EXEC281.windows.size > EXEC281.keep) EXEC281.windows.delete(EXEC281.windows.keys().next().value); }
    if ((st === 'LOCKED' || st === 'PROVEN LOCKED') && w.firstLockedTau == null) { w.firstLockedTau = round(tau, 1); w.side = sig.side; }
    if (state === 'TRADE NOW' && w.firstTradeTau == null) w.firstTradeTau = round(tau, 1);
    if (state === 'TOO LATE TO TRADE' && w.firstTooLateTau == null) w.firstTooLateTau = round(tau, 1);
  }
  return sig;
}
function exec281Summary() {
  const ws = [...EXEC281.windows.values()].filter(w => w.closeMs < Date.now());
  const locked = ws.filter(w => w.firstLockedTau != null);
  const actionable = locked.filter(w => w.firstLockedTau >= w.lastOrderTau);
  return { windows: ws.length, locked: locked.length, lockedBeforeLastOrder: actionable.length, tradeNow: ws.filter(w => w.firstTradeTau != null).length,
    tooLateOnly: locked.filter(w => w.firstTradeTau == null && w.firstTooLateTau != null).length, recent: ws.slice(-20),
    note: 'background classifier with the default order time (EXEC_SEC); since this process started' };
}
