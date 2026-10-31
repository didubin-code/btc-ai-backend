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
  /* samples are on the observer clock; the signal is near prodTs on production's clock (offsets are small vs 15 min) */
  const near = samples.filter(s => Math.abs(s.at - prodTs) <= CLOCK_WINDOW_MS);
  if (!near.length) return { verified: false, why: 'no clock sample within 15 min of the signal' };
  const lo = Math.max(...near.map(s => s.lo)), hi = Math.min(...near.map(s => s.hi));
  if (lo > hi) return { verified: false, why: 'clock samples within 15 min disagree (production clock step?)', samples: near.length };
  return { verified: true, offsetLoMs: lo, offsetHiMs: hi, samples: near.length };
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

function build(raw, opts = {}) {
  const preds = new Map(), books = new Map(), mk = new Map(), health = [], gaps = [], restarts = [], series = [], bookFail = new Map(), clockSteps = [];
  const bookByHash = new Map();
  for (const r of raw) {
    switch (r.kind) {
      case 'pr.predictions': {
        /* production returns its rows in the order it wrote them: a timestamp going backwards inside one reply is a
           production clock step (its ts and seconds-remaining shift together, so the rows alone would look normal) */
        let prevTs = null;
        for (const x of r.rows || []) {
          if (!x || typeof x.ticker !== 'string' || !Number.isFinite(x.ts)) continue;
          if (prevTs != null && x.ts < prevTs - 1000) clockSteps.push({ from: prevTs, to: x.ts });
          prevTs = x.ts;
          const k = x.ticker + '|' + x.ts + '|' + x.state + '|' + x.side; const m = preds.get(x.ticker) || new Map(); m.set(k, x); preds.set(x.ticker, m);
        }
        break;
      }
      case 'pr.health': health.push(r); break;
      case 'pr.restart': restarts.push(r); break;
      case 'obs.gap': gaps.push(r); break;
      case 'k.series': if (r.series) series.push(r); break;
      case 'k.markets': for (const m of r.markets || []) { const o = mk.get(m.ticker) || {}; mk.set(m.ticker, { ...o, open: o.open || m, seenAt: o.seenAt || r.tRecv }); } break;
      case 'k.market': if (r.market) { const o = mk.get(r.ticker) || {}; mk.set(r.ticker, { ...o, final: r.market.status === 'finalized' ? r.market : o.final, last: r.market, finalAt: r.market.status === 'finalized' ? (o.finalAt || r.tRecv) : o.finalAt }); } break;
      case 'k.book':
        if (r.book) { bookByHash.set(r.hash, r.book); const l = books.get(r.ticker) || []; l.push({ tSent: r.tSent, tRecv: r.tRecv, hash: r.hash, body: r.book }); books.set(r.ticker, l); }
        else bookFail.set(r.ticker, (bookFail.get(r.ticker) || 0) + 1);
        break;
      case 'k.book.same': { const l = books.get(r.ticker) || []; l.push({ tSent: r.tSent, tRecv: r.tRecv, hash: r.ref, body: null, same: true }); books.set(r.ticker, l); } break;
    }
  }
  for (const l of books.values()) { l.sort((a, b) => a.tRecv - b.tRecv); for (const b of l) if (!b.body) b.body = bookByHash.get(b.hash) || null; }
  series.sort((a, b) => a.tRecv - b.tRecv); health.sort((a, b) => a.tRecv - b.tRecv);
  const samples = clockSamples(health);
  /* production configuration in force: the newest /health reply before a time */
  const configAt = t => { const h = health.filter(x => x.body && x.tRecv <= t + CLOCK_WINDOW_MS).pop(); return h ? { build: h.body.build || null, version: h.body.version || null, lockMaxFlip: h.body.tiers ? h.body.tiers.lockMaxFlip : null } : null; };

  const tickers = new Set([...preds.keys(), ...mk.keys()]);
  const markets = [];
  for (const tk of [...tickers].sort()) {
    const m = mk.get(tk) || {};
    const def = m.final || m.last || m.open || null;
    const closeMs = def ? Date.parse(def.close_time) : null;
    const rows = [...(preds.get(tk) || new Map()).values()].sort((a, b) => a.ts - b.ts);
    const fin = m.final || null;
    const result = fin ? String(fin.result || '') : null;
    const outcomeSide = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : null;
    const rec = {
      ticker: tk,
      market: def ? { openTime: def.open_time, closeTime: def.close_time, expirationTime: def.expiration_time, strike: def.floor_strike ?? null,
        rules: def.rules_primary || null, priceLevelStructure: def.price_level_structure || null, source: 'kalshi public API' } : null,
      settlement: fin ? { result, outcome: outcomeSide, expirationValue: fin.expiration_value === '' || fin.expiration_value == null ? null : Number(fin.expiration_value),
        settlementTs: fin.settlement_ts || null, status: fin.status, recordedAt: m.finalAt, source: 'kalshi public API (expiration_value = Kalshi\'s official BRTI 60 s average)' }
        : { result: null, outcome: null, status: m.last ? m.last.status : 'not recorded' },
      production: closeMs ? configAt(closeMs) : null,
      coverage: null, signal: null, qualified: null, atT120: null, events: [], pricing: null,
    };
    /* coverage of the final 300 s by Pin Radar's own per-second rows: seconds 0..299 by floor(tau) */
    let secs = new Set(), anomalies = [];
    if (closeMs) {
      const bySec = new Map();
      for (const x of rows) { const s = Math.floor(x.tau); if (s < 0 || s >= 300) continue; secs.add(s); const p = bySec.get(s); if (p && Math.abs(p - x.ts) > 1500) anomalies.push('two rows for second ' + s + ' are ' + Math.abs(p - x.ts) + ' ms apart'); if (!p) bySec.set(s, x.ts); }
      for (let i = 1; i < rows.length; i++) if (rows[i].tau > rows[i - 1].tau + 0.5) anomalies.push('seconds remaining went up at ' + rows[i].ts + ' (clock step?)');
      for (const c of clockSteps) if ((c.from > closeMs - 330e3 && c.from < closeMs + 5e3) || (c.to > closeMs - 330e3 && c.to < closeMs + 5e3)) anomalies.push('production clock stepped back ' + Math.round((c.from - c.to) / 1000) + ' s near ' + new Date(c.to).toISOString());
      const missing = []; for (let s = 0; s < 300; s++) if (!secs.has(s)) missing.push(s);
      let maxGap = 0, run = 0; for (let s = 0; s < 300; s++) { if (!secs.has(s)) { run++; maxGap = Math.max(maxGap, run); } else run = 0; }
      const obsGap = gaps.some(g => g.from < closeMs && g.to > closeMs - 300e3);
      const restartIn = restarts.filter(x => (x.approxRestartAt || x.at) > closeMs - 300e3 && (x.approxRestartAt || x.at) < closeMs);
      const bl = (books.get(tk) || []).filter(b => b.body && b.tRecv > closeMs - 300e3 && b.tRecv <= closeMs);
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
        return { ...pick(s0), won, observedToClose, timingCertain, flags: { unlockedLater: unlock, directionChangedLater: dirChange, reversalWarningLater: warned, riskRoseAboveThresholdLater: riskUp }, category };
      };
      rec.signal = classify(first);
      rec.qualified = classify(firstQ);
      rec.lockedAnywhereInLast120 = rows.some(x => x.tau <= 120 && isL(x.state) && x.pFlip <= THRESHOLD);
    }
    /* pricing at a signal: only a book received before the earliest possible observer-clock time of the signal */
    const priceAt = (sg) => {
      if (!sg) return null;
      const ck = clockAt(samples, sg.ts);
      const fee = feeFor(series, ck.verified ? sg.ts - ck.offsetHiMs : sg.ts);
      const side = sg.side === 'UP' ? 'yesAsks' : 'noAsks';
      const l = books.get(tk) || [];
      const at = (b, tRef) => { if (!b) return null; const nb = normaliseBook(b.body); const asks = nb[side];
        return { receivedAt: new Date(b.tRecv).toISOString(), ageMs: tRef != null ? Math.round(tRef - b.tRecv) : null, bestAskCents: asks.length ? asks[0][0] : null,
          upBestAsk: nb.yesAsks[0] ? nb.yesAsks[0][0] : null, downBestAsk: nb.noAsks[0] ? nb.noAsks[0][0] : null,
          spreadCents: nb.yesAsks[0] && nb.yesBids[0] ? Math.round((nb.yesAsks[0][0] - nb.yesBids[0][0]) * 1e4) / 1e4 : null,
          calledSideLevels: asks.slice(0, 20), theoretical: theoretical(asks, SIZES, fee.rate, sg.won) }; };
      if (!ck.verified) return { clock: ck, fee, displayedAskCents: sg.displayedAskCents, atSignal: { unavailable: 'clock unverified: ' + ck.why }, afterSignal: null };
      const earliest = sg.ts - ck.offsetHiMs, latest = sg.ts - ck.offsetLoMs;          // the signal's time on the observer clock lies in [earliest, latest]
      const before = l.filter(b => b.body && b.tRecv < earliest).pop() || null;
      const after = l.find(b => b.body && b.tSent > latest) || null;
      const stale = before && earliest - before.tRecv > MAX_BOOK_AGE_MS;
      return { clock: ck, fee, displayedAskCents: sg.displayedAskCents,
        atSignal: !before ? { unavailable: 'no book received before the signal' } : stale ? { unavailable: 'newest book received before the signal is ' + Math.round((earliest - before.tRecv) / 1000) + ' s old' } : at(before, earliest),
        afterSignal: at(after, null) };
    };
    rec.pricing = { qualified: priceAt(rec.qualified), firstLocked: priceAt(rec.signal) };
    markets.push(rec);
  }
  return { generatedFrom: raw.length, clock: summaryClock(samples), threshold: THRESHOLD, restarts: restarts.length, markets };
}
module.exports = { build, clockAt, clockSamples, feeFor, SIZES, THRESHOLD, isL };
