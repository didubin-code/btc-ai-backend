/* =====================================================================
   PIN RADAR 2.7 — EXACT SETTLEMENT PANEL + OFFICIAL SETTLEMENT REFERENCE
   Contract (Kalshi KXBTC15M record): YES iff the simple average of the 60
   one-second CF Benchmarks BRTI values in (close - 60 s, close], rounded to
   the cent, is >= the strike. round2(avg) >= K  <=>  avg >= K - 0.005.

   Official reference (needs the CF Benchmarks entitlement on your Kalshi
   API key; checked live, reported on /brti-status):
     Kalshi WebSocket channel `cfbenchmarks_value`, index BRTI, ~1 tick/s.
     msg.last_60s_windowed_average_15min = Kalshi's running settlement
     accumulator: average of the ticks in (close - 60 s, close];
     window_size = ticks counted (1 at :01 ... 60 at the close tick).
     msg.avg_60s_data is a TRAILING 60 s average and is never used here.
     Optional `cfbenchmarks_value_5hz` (BRTI_5HZ=1) refreshes the spot only;
     5 Hz ticks are never counted as settlement observations.
   The validated 2.6 probability model is unchanged. The official feed:
     (1) feeds the settlement panel exactly (recorded average, n, critical
         remaining average) instead of the exchange-index proxy;
     (2) GATE: LOCKED is withheld when the official reference disagrees with
         the proxy model (other side leads, or > 5 % flip risk) - it can only
         remove calls (back-test: removed 1 of 13 wrong 2.6 LOCKED calls);
     (3) REVERSAL WARNING also fires when the official reference puts the
         LOCKED side at >= REV_FLIP flip risk (can only add warnings);
     (4) its own flip-risk estimate is logged (shadow) for validation.
   Without the entitlement every number is labelled PROXY and the engine
   behaves exactly like 2.6.
   ===================================================================== */
const SETTLE_TICKS = 60;
function settleRound2(x) { return Math.round((x + (x >= 0 ? 1e-9 : -1e-9)) * 100) / 100; }
/* recordedAvg/recordedN: ticks already in the settlement window. remaining: ticks still to come (incl. the close tick).
   spot: latest index value. Exact state of the settlement, the critical average the remaining ticks must reach to flip
   the leader, and the move from spot that requires. */
function settleMath({ strike, recordedAvg = null, recordedN = 0, remaining, spot }) {
  const n = Math.max(0, recordedN | 0), r = Math.max(0, remaining | 0);
  const N = n + r;
  if (!(N > 0) || !Number.isFinite(strike) || (n > 0 && !Number.isFinite(recordedAvg)) || (r > 0 && !Number.isFinite(spot))) return null;
  const sumRec = n > 0 ? recordedAvg * n : 0;
  const thr = strike - 0.005;
  const expected = r > 0 ? (sumRec + r * spot) / N : sumRec / N;
  const leader = expected >= thr ? 'UP' : 'DOWN';
  const out = { strike, N, recordedN: n, recordedAvg: n > 0 ? recordedAvg : null, remaining: r, spot,
    expectedSettle: expected, expectedRounded: settleRound2(expected), leader, decided: r === 0 };
  if (r === 0) { out.final = settleRound2(sumRec / N); out.result = out.final >= strike ? 'UP' : 'DOWN'; return out; }
  const critical = (N * thr - sumRec) / r;
  out.criticalRemainingAvg = critical;
  out.criticalVsStrike = critical - strike;
  out.requiredMove = leader === 'UP' ? spot - critical : critical - spot;
  out.recordedVsStrike = n > 0 ? recordedAvg - strike : null;
  out.jumpNeeded = k => (k >= r ? Infinity : out.requiredMove * r / (r - k));
  return out;
}

const BRTI_ENABLE = !/^(0|false|off|no)$/i.test(String(process.env.BRTI_ENABLE || '1').trim());
const BRTI_INDEX_ID = String(process.env.BRTI_INDEX_ID || 'BRTI').trim();
const BRTI_5HZ = /^(1|true|on|yes)$/i.test(String(process.env.BRTI_5HZ || '0').trim());
const BRTI_STALE_MS = clampEnv(process.env.BRTI_STALE_MS, 2500, 500, 15000);
const BRTI_GATE = !/^(0|false|off|no)$/i.test(String(process.env.BRTI_GATE || '1').trim());
const BRTI_GATE_MAX_FLIP = clampEnv(process.env.BRTI_GATE_MAX_FLIP, 0.05, 0.005, 0.5);
const BRTI_MAX_DIVERGENCE_USD = clampEnv(process.env.BRTI_MAX_DIVERGENCE_USD, 40, 5, 1000);
const BRTI_COUNT_TOL = clampEnv(process.env.BRTI_COUNT_TOL, 2, 0, 10);
const BRTI_NODATA_MS = clampEnv(process.env.BRTI_NODATA_MS, 15000, 3000, 120000);
const PRED_LOG_MAX = clampEnv(process.env.PRED_LOG_MAX, 30000, 1000, 500000);
const PRED_LOG_FILE = String(process.env.PRED_LOG_FILE || '').trim();

const BRTI = {
  enabled: BRTI_ENABLE, state: BRTI_ENABLE ? 'waiting-for-kalshi-websocket' : 'disabled (BRTI_ENABLE=0)',
  subId: null, subId5: null, sid: null, sid5: null, subscribedAt: null, firstMsgAt: null, lastMsgAt: null,
  msgs: 0, msgs5: 0, badMsgs: 0, seqGaps: 0, seqGaps5: 0, lastSeq: null, lastSeq5: null,
  last: null, last5: null, win: null, finals: [], ticks: [], amended: 0,
  lastError: null, errors: [], lat: { srcToKalshi: [], kalshiToUs: [], srcToUs: [] }, raw: []
};
function brtiNum(x) { const v = typeof x === 'string' ? Number(x.replace(/,/g, '').trim()) : Number(x); return Number.isFinite(v) ? v : NaN; }
function brtiPushLat(arr, v) { if (Number.isFinite(v) && Math.abs(v) < 600000) { arr.push(v); if (arr.length > 300) arr.shift(); } }
function brtiQ(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y), q = p => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  return { n: a.length, p50: q(0.5), p95: q(0.95), max: a[a.length - 1] };
}
function brtiNote(kind, text) { BRTI.errors.push({ ts: Date.now(), kind, text: String(text).slice(0, 300) }); if (BRTI.errors.length > 30) BRTI.errors.shift(); }
/* subscribe on the already-authenticated Kalshi socket (called on every 'open') */
function brtiSubscribe27(ws, nextId) {
  if (!BRTI.enabled || !ws) return;
  try {
    BRTI.subId = nextId();
    ws.send(JSON.stringify({ id: BRTI.subId, cmd: 'subscribe', params: { channels: ['cfbenchmarks_value'], index_ids: [BRTI_INDEX_ID] } }));
    if (BRTI_5HZ) {
      BRTI.subId5 = nextId();
      ws.send(JSON.stringify({ id: BRTI.subId5, cmd: 'subscribe', params: { channels: ['cfbenchmarks_value_5hz'], index_ids: [BRTI_INDEX_ID] } }));
    }
    BRTI.state = 'subscribing'; BRTI.subscribedAt = Date.now(); BRTI.lastSeq = null; BRTI.lastSeq5 = null;
  } catch (e) { BRTI.state = 'subscribe-failed'; BRTI.lastError = String(e && e.message || e); brtiNote('subscribe', BRTI.lastError); }
}
function brtiSocketClosed27() { if (BRTI.enabled) { BRTI.state = 'websocket-closed'; BRTI.sid = null; BRTI.sid5 = null; } }
/* Every Kalshi WS message passes through here first; returns true when it was a BRTI message. */
function brtiHandle27(j, localTs = Date.now(), rawText = null) {
  if (!j || typeof j.type !== 'string') return false;
  const ours = j.id != null && (j.id === BRTI.subId || j.id === BRTI.subId5);
  if (j.type === 'subscribed') {
    const ch = j.msg && j.msg.channel;
    if (ours || ch === 'cfbenchmarks_value' || ch === 'cfbenchmarks_value_5hz') {
      if (ch === 'cfbenchmarks_value_5hz' || j.id === BRTI.subId5) BRTI.sid5 = j.msg && j.msg.sid;
      else { BRTI.sid = j.msg && j.msg.sid; if (!BRTI.last) BRTI.state = 'subscribed (waiting for the first tick)'; }
      return true;
    }
    return false;
  }
  if (j.type === 'error' && ours) {
    const m = (j.msg && (j.msg.msg || j.msg.message)) || JSON.stringify(j.msg || {});
    const code = j.msg && j.msg.code;
    BRTI.lastError = `code ${code ?? '?'}: ${m}`; brtiNote('error', BRTI.lastError);
    BRTI.state = /entitle|permission|not allowed|forbidden|unauthori[sz]ed|access/i.test(m) ? 'not-entitled' : 'error';
    return true;
  }
  if (j.type === 'cfbenchmarks_value_indexlist') { BRTI.indexList = j.msg && j.msg.index_ids; return true; }
  if (j.type !== 'cfbenchmarks_value' && j.type !== 'cfbenchmarks_value_5hz') return false;
  const m = j.msg || {};
  if (m.index_id && m.index_id !== BRTI_INDEX_ID) return true;
  const five = j.type === 'cfbenchmarks_value_5hz';
  const seq = Number(j.seq);
  if (Number.isFinite(seq)) {
    const prev = five ? BRTI.lastSeq5 : BRTI.lastSeq;
    if (prev != null && seq !== prev + 1) { if (five) BRTI.seqGaps5++; else BRTI.seqGaps++; }
    if (five) BRTI.lastSeq5 = seq; else BRTI.lastSeq = seq;
  }
  let frame = null;
  if (typeof m.data === 'string') { try { frame = JSON.parse(m.data); } catch (_) { frame = null; } }
  else if (m.data && typeof m.data === 'object') frame = m.data;
  const value = brtiNum(m.value_usd != null ? m.value_usd : frame && frame.value);
  const sourceTs = brtiNum(m.source_ts_ms != null ? m.source_ts_ms : frame && frame.time);
  const receivedAt = brtiNum(m.received_at), sendingTs = brtiNum(j.sending_ts_ms);
  if (!(value > 0)) { BRTI.badMsgs++; brtiNote('bad-message', 'no parsable BRTI value'); return true; }
  if (rawText) { BRTI.raw.push(String(rawText).slice(0, 2000)); if (BRTI.raw.length > 600) BRTI.raw.shift(); }
  const amended = !!(frame && frame.amendTime != null);
  if (amended) BRTI.amended++;
  const tick = { value, sourceTs, receivedAt, sendingTs, localTs, amended, seq: Number.isFinite(seq) ? seq : null };
  if (five) { BRTI.msgs5++; BRTI.last5 = tick; }
  else {
    BRTI.msgs++; BRTI.last = tick;
    const sec = Number.isFinite(sourceTs) ? Math.round(sourceTs / 1000) : Math.round(localTs / 1000);
    const tl = BRTI.ticks;
    if (tl.length && tl[tl.length - 1].sec === sec) tl[tl.length - 1] = { sec, ...tick }; else tl.push({ sec, ...tick });
    while (tl.length > 240) tl.shift();
    brtiPushLat(BRTI.lat.srcToKalshi, receivedAt - sourceTs);
    brtiPushLat(BRTI.lat.kalshiToUs, localTs - (Number.isFinite(sendingTs) ? sendingTs : receivedAt));
    brtiPushLat(BRTI.lat.srcToUs, localTs - sourceTs);
    const w = m.last_60s_windowed_average_15min;
    if (w && w.value != null) {
      const v = brtiNum(w.value), size = Number(w.window_size), st = brtiNum(w.window_start_ts_ms), en = brtiNum(w.window_end_ts_exclusive);
      const closeMs = Number.isFinite(st) ? Math.round((st + 60000) / 900000) * 900000 : (Number.isFinite(en) ? Math.round(en / 900000) * 900000 : NaN);
      if (Number.isFinite(v) && Number.isFinite(size) && Number.isFinite(closeMs)) {
        BRTI.win = { closeMs, value: v, size, startMs: st, endExclMs: en, localTs, sourceTs };
        const f = BRTI.finals.find(x => x.closeMs === closeMs);
        if (f) Object.assign(f, { value: v, size, localTs }); else { BRTI.finals.push({ closeMs, value: v, size, localTs }); if (BRTI.finals.length > 24) BRTI.finals.shift(); }
      }
    }
  }
  if (!BRTI.firstMsgAt) BRTI.firstMsgAt = localTs;
  BRTI.lastMsgAt = localTs;
  BRTI.state = 'live';
  return true;
}
/* periodic health: subscribed but silent -> most likely no entitlement for this key */
function brtiHousekeeping27(now = Date.now()) {
  if (!BRTI.enabled) return;
  if (typeof KALSHI_HAVE_CREDS !== 'undefined' && !KALSHI_HAVE_CREDS && !BRTI.last) { BRTI.state = 'no Kalshi API credentials (KALSHI_KEY_ID / KALSHI_PRIVATE_KEY): official BRTI unavailable'; return; }
  if (BRTI.subscribedAt && !BRTI.firstMsgAt && now - BRTI.subscribedAt > BRTI_NODATA_MS && !/not-entitled|error/.test(BRTI.state))
    BRTI.state = `no BRTI ticks ${Math.round((now - BRTI.subscribedAt) / 1000)} s after subscribing (entitlement?)`;
  if (BRTI.state === 'live' && BRTI.last && now - BRTI.last.localTs > BRTI_STALE_MS) BRTI.state = 'stale';
}
/* the official settlement state usable for this window right now, or why not */
function brtiOfficialState27(now, closeMs, tau) {
  const out = { ok: false, reasons: [] };
  if (!BRTI.enabled) { out.reasons.push('official BRTI feed disabled (BRTI_ENABLE=0)'); return out; }
  if (!BRTI.last) { out.reasons.push('no official BRTI data: ' + BRTI.state); return out; }
  const last = BRTI_5HZ && BRTI.last5 && BRTI.last5.localTs > BRTI.last.localTs ? BRTI.last5 : BRTI.last;
  const age = now - last.localTs;
  out.ageMs = age; out.spot = last.value; out.sourceTs = last.sourceTs;
  if (!(Number.isFinite(last.value) && last.value > 0)) { out.reasons.push('official BRTI value invalid'); return out; }
  if (age > BRTI_STALE_MS) { out.reasons.push(`official BRTI ${Math.round(age)} ms old (limit ${BRTI_STALE_MS} ms)`); return out; }
  if (Number.isFinite(tau) && tau < SETTLE_TICKS) {
    const exp = Math.max(0, Math.min(SETTLE_TICKS, SETTLE_TICKS - Math.ceil(tau - 1e-9)));
    const w = BRTI.win;
    out.expectedN = exp;
    if (!w || w.closeMs !== closeMs) {
      if (exp <= 1) { out.n = 0; out.recAvg = null; out.ok = true; out.reasons.push('settlement minute just opened'); return out; }
      out.reasons.push('official settlement accumulator not received for this window'); return out;
    }
    if (!(w.size >= 0 && w.size <= SETTLE_TICKS) || Math.abs(w.size - exp) > BRTI_COUNT_TOL) {
      out.reasons.push(`official window_size ${w.size} vs ${exp} expected from the clock`); return out;
    }
    if (w.size > 0 && !(Number.isFinite(w.value) && w.value > 0 && Math.abs(w.value / last.value - 1) < 0.05)) {
      out.reasons.push('official accumulator value implausible'); return out;
    }
    out.n = w.size; out.recAvg = w.size > 0 ? w.value : null; out.winAgeMs = now - w.localTs;
  } else { out.n = 0; out.recAvg = null; }
  out.ok = true;
  return out;
}
/* Exact settlement panel: OFFICIAL when the feed is live and consistent, else PROXY (exchange index + basis estimate). */
function settlePanel27({ now = Date.now(), closeMs, strike, geo, tau }) {
  if (!Number.isFinite(strike) || !Number.isFinite(closeMs) || !Number.isFinite(tau)) return null;
  const off = brtiOfficialState27(now, closeMs, tau);
  const mu = geo && Number.isFinite(geo.basisMeanUsd) ? geo.basisMeanUsd : 0;
  let reference, n, recAvg, spot;
  if (off.ok) { reference = 'OFFICIAL'; n = off.n; recAvg = off.recAvg; spot = off.spot; }
  else if (geo && Number.isFinite(geo.index)) {
    reference = 'PROXY'; n = tau >= SETTLE_TICKS ? 0 : Math.max(0, Math.min(SETTLE_TICKS, geo.nLock || 0));
    recAvg = n > 0 && Number.isFinite(geo.lockedMean) ? geo.lockedMean + mu : null; spot = geo.index + mu;
    if (n > 0 && recAvg == null) n = 0;
  } else return { reference: 'NONE', officialReasons: off.reasons };
  const r = tau <= 0 ? 0 : SETTLE_TICKS - n;
  const sm = settleMath({ strike, recordedAvg: recAvg, recordedN: n, remaining: r, spot });
  if (!sm) return { reference: 'NONE', officialReasons: off.reasons };
  const R2 = x => (x == null || !Number.isFinite(x)) ? null : round(x, 2);
  const p = {
    reference, label: reference === 'OFFICIAL' ? 'OFFICIAL · CF Benchmarks BRTI via Kalshi' : 'PROXY · exchange index + basis estimate',
    recorded: n, remaining: r, recordedAvg: R2(sm.recordedAvg), recordedVsStrike: R2(sm.recordedVsStrike), spot: R2(spot), spotVsStrike: R2(spot - strike),
    expectedSettle: R2(sm.expectedSettle), expectedVsStrike: R2(sm.expectedSettle - strike), leader: sm.leader,
    criticalRemainingAvg: R2(sm.criticalRemainingAvg), criticalVsStrike: R2(sm.criticalVsStrike), requiredMove: R2(sm.requiredMove),
    jumpIn5s: r > 5 && sm.jumpNeeded ? R2(sm.jumpNeeded(5)) : null, decided: sm.decided, final: sm.final ?? null,
    basisMeanUsd: reference === 'PROXY' ? R2(mu) : null, basisSdUsd: reference === 'PROXY' && geo ? geo.basisSdUsd : null,
    officialReasons: off.reasons, brtiAgeMs: off.ageMs != null ? Math.round(off.ageMs) : null, brtiState: BRTI.state
  };
  if (reference === 'PROXY' && off.spot != null && off.ageMs != null && off.ageMs <= BRTI_STALE_MS) p.officialSpot = R2(off.spot);
  /* official reference: divergence from the proxy, and its own flip risk (shadow model, also used by the gate) */
  if (reference === 'OFFICIAL' && geo && Number.isFinite(geo.index)) {
    p.proxySpot = R2(geo.index + mu); p.divergenceUsd = R2(spot - (geo.index + mu));
    if (geo.sigmaBps != null && geo.pUp != null) {
      const bk = geo.regime ? geo.regime.bucket : null;
      const raw = m25PUp(M25_MODEL, { tau: Math.max(0, tau), gap: sm.expectedSettle - (strike - 0.005), sigBps: geo.sigmaBps, S: spot, mu: 0, basisMult: 0, bucket: bk });
      if (raw != null) {
        const pu = recalPUp26(raw, geo.recal ? geo.recal.ratio : 1);
        p.officialPUp = round(pu, 6); p.officialLeader = pu >= 0.5 ? 'UP' : 'DOWN'; p.officialFlip = round(Math.min(pu, 1 - pu), 6);
      }
    }
  }
  return p;
}
/* gate: only ever removes LOCKED (soft gate -> HIGH CONFIDENCE with the reason shown) */
function brtiGate27(gates, panel, geo) {
  if (!panel || panel.reference !== 'OFFICIAL' || !geo || geo.pUp == null) return;
  if (panel.divergenceUsd != null && Math.abs(panel.divergenceUsd) > BRTI_MAX_DIVERGENCE_USD)
    gates.soft.push(`official BRTI and the proxy index differ by $${Math.abs(panel.divergenceUsd).toFixed(2)} (> $${BRTI_MAX_DIVERGENCE_USD})`);
  if (!BRTI_GATE || panel.officialPUp == null) return;
  const side = geo.pUp >= 0.5 ? 'UP' : 'DOWN';
  const f = side === 'UP' ? 1 - panel.officialPUp : panel.officialPUp;
  if (f > BRTI_GATE_MAX_FLIP) gates.soft.push(`official BRTI disagrees: ${side} flip risk ${fmtFlip(f)} on the official settlement reference`);
}
/* after classification: official REVERSAL WARNING (only adds warnings), the requested display lines, panel attached */
function brtiAfterClassify27(sig, panel, ticker) {
  if (!sig) return sig;
  sig.settle = panel || null;
  const ls = LOCK25.ticker === ticker ? LOCK25 : null;
  if (panel && panel.reference === 'OFFICIAL' && panel.officialPUp != null && ls && ls.lockedSide
    && !['REVERSAL WARNING', 'DATA UNRELIABLE', 'AWAITING SETTLEMENT'].includes(sig.state)) {
    const f = ls.lockedSide === 'UP' ? 1 - panel.officialPUp : panel.officialPUp;
    if (f >= REV_FLIP) {
      sig.state = 'REVERSAL WARNING'; sig.side = ls.lockedSide; sig.status = 'invalidated';
      sig.headline = `REVERSAL WARNING — ${ls.lockedSide} AT RISK`;
      sig.reasons = [`official BRTI reference: ${ls.lockedSide} (LOCKED earlier) now has ${fmtFlip(f)} flip risk`, ...(sig.reasons || [])];
      sig.trade = { ...(sig.trade || {}), action: 'EXIT / NO TRADE', why: 'the LOCKED call is breaking down on the official settlement reference' };
      sig.officialReversal = true;
    }
  }
  const st = sig.state, side = sig.side;
  const head = st === 'LOCKED' ? `LOCKED — PREDICTED ${side}` : st === 'PROVEN LOCKED' ? `PROVEN — ${side}` : st === 'HIGH CONFIDENCE' ? `HIGH CONFIDENCE — ${side} (not locked)`
    : st === 'LEANING' ? `LEANING ${side}` : st === 'REVERSAL WARNING' ? `REVERSAL WARNING — ${side} AT RISK` : st;
  const cv = panel && panel.criticalVsStrike != null ? panel.criticalVsStrike : null;
  sig.display27 = {
    headline: head,
    winProbability: sig.pWin != null && st !== 'DATA UNRELIABLE' ? fmtWin(sig.pWin) : null,
    reversalProbability: sig.pFlip != null && st !== 'DATA UNRELIABLE' ? fmtFlip(sig.pFlip) : null,
    secondsRemaining: Number.isFinite(sig.tau) ? Math.max(0, Math.round(sig.tau)) : null,
    criticalRemainingAverage: cv == null ? (panel && panel.decided ? 'settled: no observations left' : null)
      : `$${Math.abs(cv).toFixed(2)} ${cv < 0 ? 'BELOW' : 'ABOVE'} STRIKE`,
    reference: panel ? panel.reference : 'NONE',
    note: st === 'LOCKED' ? 'predictive classification (validated flip risk), not a guarantee of the settlement' : null
  };
  return sig;
}
/* per-second prediction log (every bg tick inside the 300 s LOCKED horizon) */
const PRED27 = { rows: [], dropped: 0, fileErr: null, lastKey: null, lastState: null };
function predLog27(sig, geo, panel, gates, computeMs) {
  if (!sig || !Number.isFinite(sig.tau) || sig.tau > 300 || sig.tau < -5) return;
  const key = sig.ticker + '|' + Math.floor(sig.tau);                  // one row per second, plus every state change
  if (key === PRED27.lastKey && sig.state === PRED27.lastState) return;
  PRED27.lastKey = key; PRED27.lastState = sig.state;
  const row = { ts: sig.ts, ticker: sig.ticker, tau: sig.tau, strike: sig.strike, state: sig.state, side: sig.side,
    pWin: sig.pWin, pFlip: sig.pFlip, pFlipCons: sig.pFlipCons, action: sig.trade ? sig.trade.action : null, ask: sig.trade ? sig.trade.askCents : null,
    lockedSide: sig.lockedSide, idx: geo ? geo.index : null, gap: geo ? geo.gapUsd : null, sigma: geo ? geo.sigmaBps : null, regime: geo && geo.regime ? geo.regime.bucket : null,
    ref: panel ? panel.reference : null, n: panel ? panel.recorded : null, recAvg: panel ? panel.recordedAvg : null, crit: panel ? panel.criticalRemainingAvg : null,
    spot: panel ? panel.spot : null, offPUp: panel ? panel.officialPUp ?? null : null, offDiv: panel ? panel.divergenceUsd ?? null : null,
    brtiAgeMs: panel ? panel.brtiAgeMs : null, gatesSoft: gates ? gates.soft.length : null, gatesHard: gates ? gates.hard.length : null,
    offRev: !!sig.officialReversal, ms: computeMs != null ? round(computeMs, 3) : null };
  PRED27.rows.push(row);
  if (PRED27.rows.length > PRED_LOG_MAX) { PRED27.rows.shift(); PRED27.dropped++; }
  if (PRED_LOG_FILE) { try { require('fs').appendFileSync(PRED_LOG_FILE, JSON.stringify(row) + '\n'); } catch (e) { PRED27.fileErr = String(e && e.message || e); } }
}
function brtiStatus27(now = Date.now()) {
  brtiHousekeeping27(now);
  const fin = BRTI.finals.map(f => {
    const d = typeof SETTLE !== 'undefined' && SETTLE.done ? SETTLE.done.find(x => x.closeMs === f.closeMs && Number.isFinite(x.official)) : null;
    return { closeMs: f.closeMs, close: new Date(f.closeMs).toISOString(), accumulator: f.value, windowSize: f.size,
      kalshiOfficial: d ? d.official : null, diffUsd: d && f.size === SETTLE_TICKS ? round(f.value - d.official, 4) : null };
  });
  return { ok: true, version: SERVER_VERSION, enabled: BRTI.enabled, indexId: BRTI_INDEX_ID, state: BRTI.state, fiveHz: BRTI_5HZ,
    kalshiWsState: typeof KAL !== 'undefined' ? KAL.wsState : null, haveCredentials: typeof KALSHI_HAVE_CREDS !== 'undefined' ? KALSHI_HAVE_CREDS : null,
    subscribedAt: BRTI.subscribedAt, firstMsgAt: BRTI.firstMsgAt, lastMsgAgeMs: BRTI.lastMsgAt ? now - BRTI.lastMsgAt : null,
    msgs: BRTI.msgs, msgs5hz: BRTI.msgs5, badMsgs: BRTI.badMsgs, seqGaps: BRTI.seqGaps, seqGaps5hz: BRTI.seqGaps5, amendedTicks: BRTI.amended,
    last: BRTI.last, last5hz: BRTI.last5, window: BRTI.win, finals: fin,
    latencyMs: { sourceToKalshi: brtiQ(BRTI.lat.srcToKalshi), kalshiToServer: brtiQ(BRTI.lat.kalshiToUs), sourceToServer: brtiQ(BRTI.lat.srcToUs) },
    lastError: BRTI.lastError, errors: BRTI.errors.slice(-10),
    config: { BRTI_STALE_MS, BRTI_GATE, BRTI_GATE_MAX_FLIP, BRTI_MAX_DIVERGENCE_USD, BRTI_COUNT_TOL },
    meaning: BRTI.state === 'live' ? 'official settlement reference live: the settlement panel shows OFFICIAL values'
      : 'official reference not live: every settlement number is labelled PROXY and decisions are exactly 2.6' };
}
