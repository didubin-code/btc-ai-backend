/* Derived evidence: one record per 15-minute market, rebuilt deterministically from the raw records at any time.
   Raw records are never changed; this file only reads them. Every derived value says where it came from:
     observed  = Pin Radar's own published record (/predictions rows, one per second + every state change)
     kalshi    = Kalshi's public market data recorded by the observer (books, final result)
     computed  = arithmetic on the above (theoretical purchases, classifications)
   Rules that keep the evidence honest:
     * CLOCKS. A Pin Radar row carries production's clock; a book carries the observer's. For each signal, the /health
       samples within 15 minutes give, each, an interval that must contain (production - observer): [ts - tRecv, ts - tSent].
       Their intersection bounds the offset; the signal happened on the observer's clock no earlier than ts - hi. A book is
       "at the signal" only if it was received before that instant. No nearby sample, or samples that disagree (a clock
       step), = the price is "unavailable (clock unverified)". Never a later book.
     * WRONG CALLS ALWAYS COUNT. A wrong call is reported whatever the coverage of its window. A WIN is called clean
       (continuous / unlocked / warned) only if every second from the signal to the close was observed and production
       did not restart in between; otherwise it is "won-partially-observed".
     * "FIRST" needs the seconds before it. A signal's timing is "certain" only if every earlier second of the final 300 s
       was observed (otherwise an earlier qualifying second could have been missed).
     * Nothing missing is filled in: no second, price, fee schedule or result is invented. */
'use strict';
const { normaliseBook, theoretical } = require('./fills');
/* the frozen primary evaluation rule (rules/primary_v1.json); its sha256 is recorded at every observer start */
const PRIMARY = require('../rules/primary_v1.json');
const PRIMARY_SHA256 = require('crypto').createHash('sha256').update(require('fs').readFileSync(require('path').join(__dirname, '..', 'rules', 'primary_v1.json'))).digest('hex');

const SIZES = [100, 1000, 5000, 10000, 25000, 50000, 75000, 100000, 250000];
const THRESHOLD = 0.002;                                   // the 0.2 % hypothesis threshold (fixed; production's own threshold is recorded separately)
const CLOCK_WINDOW_MS = 15 * 60e3, MAX_BOOK_AGE_MS = 3000;
const isL = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
const r1 = x => x == null ? null : Math.round(x * 10) / 10;

/* the offset (production - observer) is inside [ts - tRecv, ts - tSent] for every /health reply; intersect the nearby ones */
function clockSamples(healthRecs) {
  return healthRecs.map(h => { const ts = h.body && h.body.ts; return Number.isFinite(ts) && Number.isFinite(h.tSent) && Number.isFinite(h.tRecv) && h.tRecv >= h.tSent ? { at: h.tRecv, lo: ts - h.tRecv, hi: ts - h.tSent } : null; })
    .filter(Boolean).sort((a, b) => a.at - b.at);
}
function clockAt(samples, prodTs) {
  /* samples (sorted by observer time) within 15 min of prodTs, production's clock (offsets are small vs 15 min); binary search */
  let a = 0, b = samples.length;
  while (a < b) { const m = (a + b) >> 1; if (samples[m].at < prodTs - CLOCK_WINDOW_MS) a = m + 1; else b = m; }
  let lo = -Infinity, hi = Infinity, n = 0;
  for (let i = a; i < samples.length && samples[i].at <= prodTs + CLOCK_WINDOW_MS; i++) { if (samples[i].lo > lo) lo = samples[i].lo; if (samples[i].hi < hi) hi = samples[i].hi; n++; }
  if (!n) return { verified: false, why: 'no clock sample within 15 min of the signal' };
  if (lo > hi) return { verified: false, why: 'clock samples within 15 min disagree (production clock step?)', samples: n };
  return { verified: true, offsetLoMs: lo, offsetHiMs: hi, samples: n };
}
function summaryClock(samples) {
  if (!samples.length) return { samples: 0 };
  const mids = samples.map(s => (s.lo + s.hi) / 2).sort((a, b) => a - b);
  return { samples: samples.length, medianOffsetMs: Math.round(mids[Math.floor(mids.length / 2)]), spreadMs: Math.round(mids[mids.length - 1] - mids[0]) };
}
/* Kalshi's fee multiplier as production validates it: a number in [0.1, 4]; otherwise the default 0.07 rate, labelled */
function feeFor(seriesRecs, atObs) {
  const ok = s => s && Number.isFinite(Number(s.series && s.series.fee_multiplier)) && s.series.fee_multiplier !== null && Number(s.series.fee_multiplier) >= 0.1 && Number(s.series.fee_multiplier) <= 4;
  const before = seriesRecs.filter(s => s.tRecv <= atObs && ok(s)).pop();
  const any = before || seriesRecs.find(ok);
  if (!any) return { rate: 0.07, source: 'ASSUMED 0.07 (no valid /series record)' };
  return { rate: 0.07 * Number(any.series.fee_multiplier), source: 'kalshi /series ' + any.series.fee_type + ' x ' + any.series.fee_multiplier + (before ? '' : ' (recorded after the signal: assumed unchanged)') };
}

/* Books are kept compactly (typed arrays of [price, size] for the asks of each side, plus the best YES bid); an unchanged
   book shares the previous one's arrays */
const pack = lv => { const a = new Float64Array(lv.length * 2); lv.forEach(([p, z], i) => { a[2 * i] = p; a[2 * i + 1] = z; }); return a; };
const unpack = a => { const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };
/* a reply with no bids on EITHER side is not a real book (Kalshi returns such replies now and then, observed live on
   31 Oct 2026, seconds apart from full books): it is counted as a failed snapshot, never as "no offers". A book with
   one empty side is real: near the close the sellers of the winning side often withdraw. */
function compactBook(body) { const nb = normaliseBook(body); if (!nb || (!nb.yesBids.length && !nb.noBids.length)) return null;
  return { ya: pack(nb.yesAsks), na: pack(nb.noAsks), yb: nb.yesBids.length ? nb.yesBids[0][0] : null }; }
const emptyBook = body => compactBook(body) === null;
const FINALIZE_AFTER_MS = 26 * 3600e3;     // production keeps ~25 h of prediction rows: a market can still receive rows (catch-up) until then
/* the market fields a record uses (the rules text is kept once per market) */
const slim = m => ({ ticker: m.ticker, open_time: m.open_time, close_time: m.close_time, expiration_time: m.expiration_time, floor_strike: m.floor_strike,
  price_level_structure: m.price_level_structure, status: m.status, result: m.result, expiration_value: m.expiration_value, settlement_ts: m.settlement_ts });

/* build(input, { sinceMs, untilMs, onMarket }): input is an array of records, or a function returning a fresh iterator
   over them (the store is read twice, record by record). With onMarket, each market record is handed over as soon as it
   is final and not kept: memory is then bounded by about a day of rows and books, not by the length of the history.
   Without it, the records are returned in `markets`, sorted by ticker. */
function build(input, opts = {}) {
  const iter = () => typeof input === 'function' ? input() : input;
  const sinceMs = opts.sinceMs || 0, untilMs = opts.untilMs || Infinity;
  /* ---- pass 1: small indices ---- */
  const mk = new Map(), health = [], gaps = [], restarts = [], series = [], bookFail = new Map(), clockSteps = [], cfgs = new Map();
  let nRaw = 0, firstStart = Infinity;
  for (const r of iter()) {
    nRaw++;
    switch (r.kind) {
      case 'pr.predictions': {
        for (const b of r.orderBreaks || []) clockSteps.push(b);       // found by the collector on production's full reply
        let prevTs = null;
        for (const x of r.rows || []) { if (!x || !Number.isFinite(x.ts)) continue; if (prevTs != null && x.ts < prevTs - 1000) clockSteps.push({ from: prevTs, to: x.ts }); prevTs = x.ts; }
        break;
      }
      case 'pr.health': if (r.body) {
        const c = { build: r.body.build || null, version: r.body.version || null, lockMaxFlip: r.body.tiers ? r.body.tiers.lockMaxFlip ?? null : null }, ck = JSON.stringify(c);
        if (!cfgs.has(ck)) cfgs.set(ck, c);                            // one shared object per distinct configuration
        health.push({ tSent: r.tSent, tRecv: r.tRecv, body: { ts: r.body.ts }, cfg: cfgs.get(ck) });
      } break;
      case 'pr.restart': restarts.push(r); break;
      case 'pr.clockstep': clockSteps.push({ from: r.at, to: r.at + r.deltaMs }); break;
      case 'obs.gap': gaps.push({ from: r.from, to: r.to }); break;
      case 'obs.start': if (Number.isFinite(r.at) && !(firstStart <= r.at)) firstStart = r.at; break;
      case 'k.series': if (r.series) series.push({ tRecv: r.tRecv, series: { fee_type: r.series.fee_type, fee_multiplier: r.series.fee_multiplier } }); break;
      case 'k.markets': for (const m of r.markets || []) { if (!m || !m.ticker) continue; const o = mk.get(m.ticker) || {}, fin = m.status === 'finalized';
        /* a finalized market in Kalshi's list carries its official result too (back-filled markets are often only seen this way) */
        mk.set(m.ticker, { ...o, open: o.open || slim(m), rules: o.rules || m.rules_primary || null, seenAt: o.seenAt || r.tRecv,
          final: o.final || (fin ? slim(m) : undefined), finalAt: o.finalAt || (fin ? r.tRecv : undefined), finalVia: o.finalVia || (fin ? 'kalshi /markets list' : undefined) }); } break;
      case 'k.market': if (r.market) { const o = mk.get(r.ticker) || {}, fin = r.market.status === 'finalized';
        mk.set(r.ticker, { ...o, final: fin ? (o.final || slim(r.market)) : o.final, last: slim(r.market), rules: o.rules || r.market.rules_primary || null, finalAt: fin ? (o.finalAt || r.tRecv) : o.finalAt, finalVia: o.finalVia || (fin ? 'kalshi /markets/<ticker>' : undefined) }); } break;
      case 'k.book': if (!r.book || emptyBook(r.book)) bookFail.set(r.ticker, (bookFail.get(r.ticker) || 0) + 1); break;
    }
  }
  series.sort((a, b) => a.tRecv - b.tRecv); health.sort((a, b) => a.tRecv - b.tRecv);
  const samples = clockSamples(health);
  /* the configuration in force: the last /health reply received up to 15 min after t (binary search) */
  const configAt = t => { let a = 0, b = health.length; while (a < b) { const m = (a + b) >> 1; if (health[m].tRecv <= t + CLOCK_WINDOW_MS) a = m + 1; else b = m; }
    return a ? { ...health[a - 1].cfg } : null; };
  for (const m of mk.values()) { const d = m.final || m.last || m.open; const c = d ? Date.parse(d.close_time) : NaN; m.closeMs = Number.isFinite(c) ? c : null; }
  const closeOf = tk => { const m = mk.get(tk); return m ? m.closeMs : null; };

  /* ---- pass 2: rows and books market by market; a market is finished 26 h (stream time) after its close ---- */
  const preds = new Map(), books = new Map(), lastBook = new Map(), done = new Set(), markets = [];
  const put = opts.onMarket || (rec => markets.push(rec));
  let lateRows = 0, n2 = 0, emitted = 0, dupRows = 0;
  const finalize = tk => { if (done.has(tk)) return; done.add(tk); const c = closeOf(tk); if (c == null || (c >= sinceMs && c < untilMs)) { put(market(tk)); emitted++; } preds.delete(tk); books.delete(tk); lastBook.delete(tk); };
  for (const r of iter()) {
    n2++;
    if (r.kind === 'pr.predictions') for (const x of r.rows || []) {
      if (!x || typeof x.ticker !== 'string' || !Number.isFinite(x.ts)) continue;
      if (done.has(x.ticker)) { lateRows++; continue; }
      const k = x.ticker + '|' + x.ts + '|' + x.state + '|' + x.side; let m = preds.get(x.ticker); if (!m) preds.set(x.ticker, m = new Map());
      /* the FIRST ingestion of a row is kept (later copies from overlapping pulls are counted, not stored twice) */
      if (m.has(k)) { dupRows++; continue; } m.set(k, { ...x, _rcv: r.tRecv, _via: r.ticker ? 'catch-up' : 'poll' });
    }
    else if (r.kind === 'k.book' || r.kind === 'k.book.same') {
      const tk = r.ticker, c = closeOf(tk); if (done.has(tk)) continue;
      let cb = null;
      if (r.kind === 'k.book' && r.book) { cb = compactBook(r.book); lastBook.set(tk, { hash: r.hash, cb }); }
      else if (r.kind === 'k.book.same') { const lb = lastBook.get(tk); cb = lb && lb.hash === r.ref ? lb.cb : null; }
      if (cb && (c == null || (r.tRecv >= c - 305e3 && r.tRecv <= c + 5e3))) { let l = books.get(tk); if (!l) books.set(tk, l = []); l.push({ tSent: r.tSent, tRecv: r.tRecv, cb }); }
    }
    if (Number.isFinite(r.t) && n2 % 5000 === 0) for (const tk of new Set([...preds.keys(), ...books.keys()])) { const c = closeOf(tk); if (c != null && r.t - c > FINALIZE_AFTER_MS) finalize(tk); }
  }
  for (const tk of new Set([...preds.keys(), ...books.keys(), ...mk.keys()])) finalize(tk);
  markets.sort((a, b) => a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0);
  return { generatedFrom: nRaw, lateRowsIgnored: lateRows, duplicateRowsRemoved: dupRows, observerFirstStart: Number.isFinite(firstStart) ? new Date(firstStart).toISOString() : null, clock: summaryClock(samples), threshold: THRESHOLD, restarts: restarts.length, marketCount: emitted, markets };

  function market(tk) {
    const m = mk.get(tk) || {};
    const def = m.final || m.last || m.open || null;
    const closeMs = m.closeMs ?? null;
    const rows = [...(preds.get(tk) || new Map()).values()].sort((a, b) => a.ts - b.ts);
    const bl0 = (books.get(tk) || []).sort((a, b) => a.tRecv - b.tRecv);
    const fin = m.final || null;
    const result = fin ? String(fin.result || '') : null;
    const outcomeSide = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : null;
    const rec = {
      ticker: tk,
      market: def ? { openTime: def.open_time, closeTime: def.close_time, expirationTime: def.expiration_time, strike: def.floor_strike ?? null,
        rules: m.rules || null, priceLevelStructure: def.price_level_structure || null, source: 'kalshi public API' } : null,
      settlement: fin ? { result, outcome: outcomeSide, expirationValue: fin.expiration_value === '' || fin.expiration_value == null ? null : Number(fin.expiration_value),
        settlementTs: fin.settlement_ts || null, status: fin.status, recordedAt: m.finalAt ? new Date(m.finalAt).toISOString() : null, retrievedVia: m.finalVia || null, source: 'kalshi public API (expiration_value = Kalshi\'s official BRTI 60 s average)' }
        : { result: null, outcome: null, status: m.last ? m.last.status : 'not recorded' },
      production: closeMs ? configAt(closeMs) : null,
      coverage: null, signal: null, qualified: null, primary: null, atT120: null, events: [], pricing: null,
    };
    /* coverage of the final 300 s by Pin Radar's own per-second rows: seconds 0..299 by floor(tau) */
    let secs = new Set(), anomalies = [];
    if (closeMs) {
      const bySec = new Map();
      for (const x of rows) { const s = Math.floor(x.tau); if (s < 0 || s >= 300) continue; secs.add(s); const p = bySec.get(s); if (p && Math.abs(p - x.ts) > 1500) anomalies.push('two rows for second ' + s + ' are ' + Math.abs(p - x.ts) + ' ms apart'); if (!p) bySec.set(s, x.ts); }
      for (let i = 1; i < rows.length; i++) if (rows[i].tau > rows[i - 1].tau + 0.5) anomalies.push('seconds remaining went up at ' + rows[i].ts + ' (clock step?)');
      for (const c of clockSteps) if ((c.from > closeMs - 330e3 && c.from < closeMs + 5e3) || (c.to > closeMs - 330e3 && c.to < closeMs + 5e3)) anomalies.push('production clock stepped ' + Math.round((c.to - c.from) / 1000) + ' s near ' + new Date(c.to).toISOString());
      const missing = []; for (let s = 0; s < 300; s++) if (!secs.has(s)) missing.push(s);
      let maxGap = 0, run = 0; for (let s = 0; s < 300; s++) { if (!secs.has(s)) { run++; maxGap = Math.max(maxGap, run); } else run = 0; }
      const obsGap = gaps.some(g => g.from < closeMs && g.to > closeMs - 300e3);
      const restartIn = restarts.filter(x => (x.approxRestartAt || x.at) > closeMs - 300e3 && (x.approxRestartAt || x.at) < closeMs);
      const bl = bl0.filter(b => b.tRecv > closeMs - 300e3 && b.tRecv <= closeMs);
      let bGap = bl.length ? (bl[0].tRecv - (closeMs - 300e3)) / 1000 : 300;
      for (let i = 1; i < bl.length; i++) bGap = Math.max(bGap, (bl[i].tRecv - bl[i - 1].tRecv) / 1000);
      if (bl.length) bGap = Math.max(bGap, (closeMs - bl[bl.length - 1].tRecv) / 1000);
      rec.coverage = { secondsObserved: secs.size, secondsExpected: 300, missingSeconds: missing.length, longestGapSec: maxGap,
        observerGapInFinal300s: obsGap, pinradarRestartInFinal300s: restartIn.length > 0, anomalies: anomalies.slice(0, 5),
        status: !rows.length ? 'unobserved' : (missing.length === 0 && !restartIn.length && !anomalies.length) ? 'complete' : 'partial',
        books: { usableSnapshotsInFinal300s: bl.length, failedRequests: bookFail.get(tk) || 0, longestGapSec: Math.round(bGap * 10) / 10 } };
    }
    const allSecs = (from, to) => { for (let s = from; s <= to; s++) if (!secs.has(s)) return false; return true; };
    const restartBetween = (a, b) => restarts.some(x => (x.approxRestartAt || x.at) > a && (x.approxRestartAt || x.at) < b);
    if (rows.length) {
      const first = rows.find(x => isL(x.state));
      const firstQ = rows.find(x => isL(x.state) && x.pFlip != null && x.pFlip <= THRESHOLD);
      const pick = x => x && { ts: x.ts, utc: new Date(x.ts).toISOString(), tau: r1(x.tau), side: x.side, state: x.state, pFlip: x.pFlip, pFlipCons: x.pFlipCons,
        displayedAskCents: x.ask, action: x.action, gatesHard: x.gatesHard, officialReference: x.ref ?? null };
      const at120 = closeMs ? rows.filter(x => x.ts <= closeMs - 120e3).pop() : null;
      rec.atT120 = at120 && closeMs - 120e3 - at120.ts <= 2000 ? { ...pick(at120), qualifies: isL(at120.state) && at120.pFlip <= THRESHOLD } : { unobserved: true };
      let prev = null;
      for (const x of rows) {
        if (!prev || x.state !== prev.state || x.side !== prev.side) rec.events.push({ ts: x.ts, tau: r1(x.tau), type: 'state', from: prev ? prev.state + '/' + prev.side : null, to: x.state + '/' + x.side, pFlip: x.pFlip });
        if (prev && isL(prev.state) && isL(x.state) && prev.pFlip <= THRESHOLD && x.pFlip > THRESHOLD) rec.events.push({ ts: x.ts, tau: r1(x.tau), type: 'risk-above-threshold', pFlip: x.pFlip });
        if (x.offRev && !(prev && prev.offRev)) rec.events.push({ ts: x.ts, tau: r1(x.tau), type: 'official-reversal-flag' });
        prev = x;
      }
      const classify = (s0) => {
        if (!s0) return null;
        const after = rows.filter(x => x.ts > s0.ts);
        const unlock = after.some(x => !isL(x.state));
        const dirChange = after.some(x => isL(x.state) && x.side !== s0.side);
        const warned = after.some(x => x.state === 'REVERSAL WARNING');
        const riskUp = after.some(x => isL(x.state) && x.pFlip > THRESHOLD);
        const won = outcomeSide ? s0.side === outcomeSide : null;
        const sec = Math.floor(s0.tau);
        const observedToClose = closeMs != null && allSecs(0, sec) && !restartBetween(s0.ts - 1000, closeMs) && !anomalies.length;
        const timingCertain = closeMs != null && allSecs(sec + 1, 299);
        const category = won == null ? 'outcome-unknown' : won === false ? 'wrong' : !observedToClose ? 'won-partially-observed'
          : dirChange ? 'changed-direction-won' : warned ? 'warned-won' : unlock ? 'unlocked-won' : 'continuous-won';
        /* an event that was seen is reported; an event NOT seen counts as "did not happen" only if every second from the
           entry to the close was observed; otherwise it is null (indeterminate), never inferred stable */
        const seen = (yes) => yes ? true : observedToClose ? false : null;
        const at = f => { const x = after.find(f); return x ? { ts: x.ts, utc: new Date(x.ts).toISOString(), tau: r1(x.tau), state: x.state, side: x.side, pFlip: x.pFlip } : observedToClose ? null : 'indeterminate'; };
        return { ...pick(s0), won, observedToClose, timingCertain, flags: { unlockedLater: seen(unlock), directionChangedLater: seen(dirChange), reversalWarningLater: seen(warned), riskRoseAboveThresholdLater: seen(riskUp) },
          firstLater: { lostLocked: at(x => !isL(x.state)), riskAboveThreshold: at(x => isL(x.state) && x.pFlip > THRESHOLD), reversalWarning: at(x => x.state === 'REVERSAL WARNING'), directionFlip: at(x => isL(x.state) && x.side !== s0.side) },
          category };
      };
      rec.signal = classify(first);
      rec.qualified = classify(firstQ);
      rec.lockedAnywhereInLast120 = rows.some(x => x.tau <= 120 && isL(x.state) && x.pFlip <= THRESHOLD);
    /* PRIMARY rule v1 (frozen): the first observed row with 0 < tau <= 120, LOCKED / PROVEN LOCKED, pFlip <= 0.002 */
    {
      const P = PRIMARY.parameters, ok = x => P.states.includes(x.state) && x.pFlip != null && x.pFlip <= P.pFlipMaxInclusive;
      const pe = rows.find(x => x.tau > P.minTauSecExclusive && x.tau <= P.maxTauSecInclusive && ok(x));
      const final120 = closeMs != null && allSecs(0, P.maxTauSecInclusive - 1);
      if (!rows.length) rec.primary = { rule: PRIMARY.id, ruleSha256: PRIMARY_SHA256, entry: null, status: 'not-determinable', reason: 'window unobserved' };
      else if (!pe) rec.primary = { rule: PRIMARY.id, ruleSha256: PRIMARY_SHA256, entry: null, status: final120 ? 'no-qualifying-signal' : 'not-determinable', reason: final120 ? null : 'final 120 s not fully observed' };
      else {
        const before = rows.filter(x => x.tau > P.maxTauSecInclusive).pop();
        const entryType = !before || before.tau > P.maxTauSecInclusive + 10 ? 'unknown-prior' : ok(before) && before.side === pe.side ? 'existing-lock' : 'new-crossing';
        const c = classify(pe);
        rec.primary = { rule: PRIMARY.id, ruleSha256: PRIMARY_SHA256, status: 'entry', entryType, ...c, timingCertain: closeMs != null && allSecs(Math.floor(pe.tau) + 1, P.maxTauSecInclusive - 1) };
      }
    }
    }
    if (!rec.primary) rec.primary = { rule: PRIMARY.id, ruleSha256: PRIMARY_SHA256, entry: null, status: 'not-determinable', reason: 'window unobserved' };
    /* pricing at a signal: only a book received before the earliest possible observer-clock time of the signal */
    const priceAt = (sg) => {
      if (!sg) return null;
      const ck = clockAt(samples, sg.ts);
      const fee = feeFor(series, ck.verified ? sg.ts - ck.offsetHiMs : sg.ts);
      const sideKey = sg.side === 'UP' ? 'ya' : 'na';
      /* the theoretical purchases are computed only at the signal; the book after it is shown for its prices only */
      const at = (b, tRef, fills = true) => { if (!b) return null; const asks = unpack(b.cb[sideKey]), ya = unpack(b.cb.ya), na = unpack(b.cb.na);
        const o = { receivedAt: new Date(b.tRecv).toISOString(), ageMs: tRef != null ? Math.round(tRef - b.tRecv) : null, bestAskCents: asks.length ? asks[0][0] : null,
          upBestAsk: ya[0] ? ya[0][0] : null, downBestAsk: na[0] ? na[0][0] : null,
          spreadCents: ya[0] && b.cb.yb != null ? Math.round((ya[0][0] - b.cb.yb) * 1e4) / 1e4 : null };
        if (fills) { o.calledSideLevels = asks.slice(0, 20); o.theoretical = theoretical(asks, SIZES, fee.rate, sg.won); }
        return o; };
      if (!ck.verified) return { clock: ck, fee, displayedAskCents: sg.displayedAskCents, atSignal: { unavailable: 'clock unverified: ' + ck.why }, afterSignal: null };
      const earliest = sg.ts - ck.offsetHiMs, latest = sg.ts - ck.offsetLoMs;          // the signal's time on the observer clock lies in [earliest, latest]
      let before = null; for (const b of bl0) { if (b.tRecv < earliest) before = b; else break; }
      const after = bl0.find(b => b.tSent > latest) || null;
      const stale = before && earliest - before.tRecv > MAX_BOOK_AGE_MS;
      return { clock: ck, fee, displayedAskCents: sg.displayedAskCents,
        atSignal: !before ? { unavailable: 'no book received before the signal' } : stale ? { unavailable: 'newest book received before the signal is ' + Math.round((earliest - before.tRecv) / 1000) + ' s old' } : at(before, earliest),
        afterSignal: at(after, null, false) };
    };
    /* provenance: production's observation times, the observer's ingestion times, and the dataset the market belongs to.
       prospective-live = the whole final 300 s came after the observer's first start on this data directory (rows polled
       live and order books recorded); everything else (back-fill from production's memory) is retrospective-backfill */
    if (rows.length || closeMs) {
      const rc = rows.map(x => x._rcv).filter(Number.isFinite);
      const live = closeMs != null && Number.isFinite(firstStart) && closeMs - 300e3 >= firstStart;
      rec.provenance = { dataset: live ? 'prospective-live' : 'retrospective-backfill', observerFirstStart: Number.isFinite(firstStart) ? new Date(firstStart).toISOString() : null,
        rows: rows.length, rowsVia: { poll: rows.filter(x => x._via === 'poll').length, catchUp: rows.filter(x => x._via === 'catch-up').length },
        firstObservedAt: rows.length ? new Date(rows[0].ts).toISOString() : null, lastObservedAt: rows.length ? new Date(rows[rows.length - 1].ts).toISOString() : null,
        firstIngestedAt: rc.length ? new Date(Math.min(...rc)).toISOString() : null, lastIngestedAt: rc.length ? new Date(Math.max(...rc)).toISOString() : null,
        source: 'Pin Radar /predictions (production clock ts), Kalshi public API (observer clock tRecv)' };
    }
    rec.pricing = { primary: rec.primary && rec.primary.status === 'entry' ? priceAt(rec.primary) : null, qualified: priceAt(rec.qualified), firstLocked: priceAt(rec.signal) };
    return rec;
  }
}
module.exports = { build, clockAt, clockSamples, feeFor, SIZES, THRESHOLD, isL, PRIMARY, PRIMARY_SHA256 };
