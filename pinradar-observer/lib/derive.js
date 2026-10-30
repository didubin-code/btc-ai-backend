/* Derived evidence: one record per 15-minute market, rebuilt deterministically from the raw records at any time.
   Raw records are never changed; this file only reads them. Every derived value says where it came from:
     observed  = Pin Radar's own published record (/predictions rows, one per second + every state change)
     kalshi    = Kalshi's public market data recorded by the observer (books, final result)
     computed  = arithmetic on the above (theoretical purchases, classifications)
   Rules that keep the evidence honest:
     * a price is used for a signal only if the observer RECEIVED that book before the signal's time (clock-offset
       corrected, with the offset's uncertainty against us); later books are reported separately as "after the signal";
     * a market whose final 300 s were not fully observed is never counted as a clean win: it is "partial" or "unobserved";
     * no missing second, price or result is filled in. */
'use strict';
const { normaliseBook, theoretical } = require('./fills');

const SIZES = [100, 1000, 5000, 10000, 25000, 50000, 75000, 100000, 250000];
const THRESHOLD = 0.002;                                   // the 0.2 % hypothesis threshold (fixed; the production threshold is recorded separately)
const isL = st => st === 'LOCKED' || st === 'PROVEN LOCKED';
const r1 = x => x == null ? null : Math.round(x * 10) / 10;

/* clock offset production - observer from /health: production 'ts' vs the request midpoint */
function clockModel(healthRecs) {
  const pts = [];
  for (const h of healthRecs) {
    const ts = h.body && (h.body.ts || (h.body.v28 && h.body.v28.ts));
    if (Number.isFinite(ts) && h.tSent && h.tRecv) pts.push({ at: h.tRecv, off: ts - (h.tSent + h.tRecv) / 2, unc: (h.tRecv - h.tSent) / 2 + 1 });
  }
  pts.sort((a, b) => a.unc - b.unc);
  const best = pts.slice(0, Math.max(1, Math.ceil(pts.length / 4)));           // the tightest quarter of round trips
  if (!best.length || !best[0]) return { offsetMs: 0, uncertaintyMs: 2000, samples: 0, note: 'no clock samples: 2 s uncertainty assumed' };
  const offs = best.map(p => p.off).sort((a, b) => a - b), med = offs[Math.floor(offs.length / 2)];
  return { offsetMs: Math.round(med), uncertaintyMs: Math.round(Math.max(...best.map(p => p.unc)) + (offs[offs.length - 1] - offs[0]) / 2), samples: pts.length };
}

function build(raw, opts = {}) {
  const rate = opts.feeRate;
  const preds = new Map(), books = new Map(), mk = new Map(), health = [], gaps = [], restarts = [], configs = [];
  let series = null;
  const bookByHash = new Map();
  for (const r of raw) {
    switch (r.kind) {
      case 'pr.predictions': for (const x of r.rows || []) { if (!x || !x.ticker) continue; const k = x.ticker + '|' + x.ts + '|' + x.state + '|' + x.side; const m = preds.get(x.ticker) || new Map(); m.set(k, x); preds.set(x.ticker, m); } break;
      case 'pr.health': health.push(r); if (r.body && r.body.tiers) configs.push({ at: r.tRecv, lockMaxFlip: r.body.tiers.lockMaxFlip, build: r.body.build, version: r.body.version }); break;
      case 'pr.restart': restarts.push(r); break;
      case 'obs.gap': gaps.push(r); break;
      case 'k.series': if (r.series) series = r.series; break;
      case 'k.markets': for (const m of r.markets || []) { const o = mk.get(m.ticker) || {}; mk.set(m.ticker, { ...o, open: m, seenAt: o.seenAt || r.tRecv }); } break;
      case 'k.market': if (r.market) { const o = mk.get(r.ticker) || {}; mk.set(r.ticker, { ...o, final: r.market, finalAt: r.tRecv }); } break;
      case 'k.book': if (r.book) bookByHash.set(r.hash, r.book); { const l = books.get(r.ticker) || []; l.push({ tSent: r.tSent, tRecv: r.tRecv, hash: r.hash, body: r.book }); books.set(r.ticker, l); } break;
      case 'k.book.same': { const l = books.get(r.ticker) || []; l.push({ tSent: r.tSent, tRecv: r.tRecv, hash: r.ref, body: null, same: true }); books.set(r.ticker, l); } break;
    }
  }
  for (const l of books.values()) { l.sort((a, b) => a.tRecv - b.tRecv); for (const b of l) if (!b.body) b.body = bookByHash.get(b.hash) || null; }
  const clock = clockModel(health);
  const feeRate = rate != null ? rate : series && Number.isFinite(Number(series.fee_multiplier)) ? 0.07 * Number(series.fee_multiplier) : 0.07;
  const feeSource = rate != null ? 'option' : series ? 'kalshi /series (' + series.fee_type + ' x ' + series.fee_multiplier + ')' : 'ASSUMED 0.07 (no /series record)';

  const tickers = new Set([...preds.keys(), ...mk.keys()]);
  const markets = [];
  for (const tk of [...tickers].sort()) {
    const m = mk.get(tk) || {};
    const def = m.final || m.open || null;
    const closeMs = def ? Date.parse(def.close_time) : null;
    const rows = [...(preds.get(tk) || new Map()).values()].sort((a, b) => a.ts - b.ts);
    const fin = m.final && m.final.status === 'finalized' ? m.final : null;
    const result = fin ? String(fin.result || '') : null;
    const outcomeSide = result === 'yes' ? 'UP' : result === 'no' ? 'DOWN' : null;
    const rec = {
      ticker: tk,
      market: def ? { openTime: def.open_time, closeTime: def.close_time, expirationTime: def.expiration_time, strike: def.floor_strike ?? null,
        rules: def.rules_primary || null, priceLevelStructure: def.price_level_structure || null, source: 'kalshi public API' } : null,
      settlement: fin ? { result, outcome: outcomeSide, expirationValue: fin.expiration_value === '' ? null : Number(fin.expiration_value),
        settlementTs: fin.settlement_ts || null, status: fin.status, recordedAt: m.finalAt, source: 'kalshi public API (expiration_value = Kalshi\'s official BRTI 60 s average)' } : { result: null, outcome: null, status: m.final ? m.final.status : 'not recorded' },
      coverage: null, signal: null, qualified: null, atT120: null, events: [], pricing: null,
    };
    /* coverage of the final 300 s by Pin Radar's own per-second rows */
    if (closeMs) {
      const secs = new Set(rows.map(x => Math.floor(x.tau)).filter(s => s >= 1 && s < 300));
      const missing = []; for (let s = 1; s < 300; s++) if (!secs.has(s)) missing.push(s);
      let maxGap = 0, run = 0; for (let s = 1; s < 300; s++) { if (!secs.has(s)) { run++; maxGap = Math.max(maxGap, run); } else run = 0; }
      const obsGap = gaps.some(g => g.from < closeMs && g.to > closeMs - 300e3);
      const prRestart = restarts.some(x => x.at > closeMs - 300e3 && x.at < closeMs + 600e3);
      /* the signal record is Pin Radar's own (kept in its memory): complete when its per-second rows are. Order books are the
         observer's own and are lost while it is down: their coverage is reported separately and a signal without a book
         before it is priced as "unavailable" */
      const bl = (books.get(tk) || []).filter(b => b.tRecv > closeMs - 300e3 && b.tRecv <= closeMs);
      let bGap = bl.length ? (bl[0].tRecv - (closeMs - 300e3)) / 1000 : 300;
      for (let i = 1; i < bl.length; i++) bGap = Math.max(bGap, (bl[i].tRecv - bl[i - 1].tRecv) / 1000);
      if (bl.length) bGap = Math.max(bGap, (closeMs - bl[bl.length - 1].tRecv) / 1000);
      rec.coverage = { secondsObserved: secs.size, secondsExpected: 299, missingSeconds: missing.length, longestGapSec: maxGap,
        observerGapInFinal300s: obsGap, pinradarRestartNear: prRestart,
        status: !rows.length ? 'unobserved' : (missing.length <= 6 && maxGap <= 3) ? 'complete' : 'partial',
        books: { snapshotsInFinal300s: bl.length, longestGapSec: Math.round(bGap * 10) / 10 } };
    }
    if (rows.length) {
      const first = rows.find(x => isL(x.state));
      const firstQ = rows.find(x => isL(x.state) && x.pFlip != null && x.pFlip <= THRESHOLD);
      const pick = x => x && { ts: x.ts, utc: new Date(x.ts).toISOString(), tau: r1(x.tau), side: x.side, state: x.state, pFlip: x.pFlip, pFlipCons: x.pFlipCons,
        displayedAskCents: x.ask, action: x.action, gatesHard: x.gatesHard, officialReference: x.ref ?? null };
      /* the state at T-120: the last row at or before close - 120 s, and only if it is within 2 s of the checkpoint */
      const at120 = closeMs ? rows.filter(x => x.ts <= closeMs - 120e3).pop() : null;
      rec.atT120 = at120 && closeMs - 120e3 - at120.ts <= 2000 ? { ...pick(at120), qualifies: isL(at120.state) && at120.pFlip <= THRESHOLD } : { unobserved: true };
      /* every change of state or side, every reversal warning, every rise of the flip risk above the threshold while LOCKED */
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
        const complete = rec.coverage && rec.coverage.status === 'complete';
        const category = won == null ? 'outcome-unknown' : won === false ? 'wrong' : !complete ? 'won-partially-observed'
          : dirChange ? 'changed-direction-won' : warned ? 'warned-won' : unlock ? 'unlocked-won' : 'continuous-won';
        return { ...pick(s0), won, flags: { unlockedLater: unlock, directionChangedLater: dirChange, reversalWarningLater: warned, riskRoseAboveThresholdLater: riskUp }, category };
      };
      rec.signal = classify(first);
      rec.qualified = classify(firstQ);
      rec.lockedAnywhereInLast120 = rows.some(x => x.tau <= 120 && isL(x.state) && x.pFlip <= THRESHOLD);
    }
    /* pricing at the qualifying signal (and at the first LOCKED), from books the observer had already received */
    const priceAt = (sg) => {
      if (!sg) return null;
      const l = books.get(tk) || [];
      const tObs = sg.ts - clock.offsetMs;                                         // the signal time on the observer's clock
      const before = l.filter(b => b.body && b.tRecv <= tObs - clock.uncertaintyMs).pop() || null;
      const after = l.find(b => b.body && b.tSent >= tObs) || null;
      const side = sg.side === 'UP' ? 'yesAsks' : 'noAsks';
      const won = sg.won;
      const at = b => { if (!b) return null; const nb = normaliseBook(b.body); const asks = nb[side];
        return { receivedAt: new Date(b.tRecv).toISOString(), ageMs: Math.round(tObs - b.tRecv), bestAskCents: asks.length ? asks[0][0] : null,
          upBestAsk: nb.yesAsks[0] ? nb.yesAsks[0][0] : null, downBestAsk: nb.noAsks[0] ? nb.noAsks[0][0] : null,
          spreadCents: nb.yesAsks[0] && nb.yesBids[0] ? Math.round((nb.yesAsks[0][0] - nb.yesBids[0][0]) * 1e4) / 1e4 : null,
          calledSideLevels: asks.slice(0, 20), theoretical: theoretical(asks, SIZES, feeRate, won) }; };
      const stale = before && tObs - before.tRecv > 3000;
      return { clock: { offsetMs: clock.offsetMs, uncertaintyMs: clock.uncertaintyMs }, displayedAskCents: sg.displayedAskCents,
        atSignal: stale ? { unavailable: 'newest book received before the signal is ' + Math.round((tObs - before.tRecv) / 1000) + ' s old' } : before ? at(before) : { unavailable: 'no book received before the signal' },
        afterSignal: at(after) };
    };
    rec.pricing = { qualified: priceAt(rec.qualified), firstLocked: priceAt(rec.signal) };
    markets.push(rec);
  }
  return { generatedFrom: raw.length, clock, feeRate, feeSource, threshold: THRESHOLD, configs: dedupeConfigs(configs), restarts: restarts.length, markets };
}
function dedupeConfigs(c) { const out = []; for (const x of c) { const l = out[out.length - 1]; if (!l || l.lockMaxFlip !== x.lockMaxFlip || l.build !== x.build) out.push(x); } return out; }
module.exports = { build, clockModel, SIZES, THRESHOLD, isL };
