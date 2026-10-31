/* Collectors. Each one stores what it saw, as received, with request and response times (observer UTC ms).
   Nothing is inferred here; interpretation happens in derive.js, which can be re-run on the raw records at any time.

   Pin Radar (production, read-only exports it already publishes):
     /predictions  every 30 s  one row per second + every state change in each window's final 300 s (its own record).
                               Requested from (newest ts seen - 120 s): the overlap absorbs a production clock step; the
                               duplicates are removed in derive. After an outage (a full page), every market that closed
                               in the gap is listed from Kalshi and fetched one by one, so none is silently skipped.
     /signals      every 60 s  state transitions with gates
     /ledger       every 60 s  its hash-chained ledger by sequence number; a new chain (production restarted without a
                               ledger file) and entries already dropped from its memory are detected and recorded
     /health       every 60 s  version, build, uptime (restart detection), configured LOCKED threshold, clock (ts)
     /calibration, /shadow, /brti-status every 5-10 min
   Kalshi (public market data only, no credentials):
     open KXBTC15M markets every 30 s; each market's book every 1 s in its final 300 s (the first one at the start of
     that period) and every 15 s before; the result after the close until it is finalized (backing off, for 7 days);
     the series (fee schedule) every 6 h.
   Load on Pin Radar: about 6 small GET requests a minute. */
'use strict';
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const SCALE = Number(process.env.OBSERVER_INTERVAL_SCALE || 1);          // tests only: shortens the Pin Radar polling intervals
const parse = t => { try { return JSON.parse(t); } catch (_) { return null; } };
const ndjson = t => String(t || '').split('\n').filter(Boolean).map(l => parse(l)).filter(Boolean);
const okInt = x => Number.isSafeInteger(x) && x >= 0;                   // values copied into later queries must be plain integers
const OVERLAP_MS = 120e3;

function pinradarSource({ base, http, emit, now = Date.now, state = {}, onTickers = null, listTickers = null }) {
  base = String(base).replace(/\/+$/, '');
  const S = Object.assign({ predTs: 0, ledgerSeq: 0, chainId: null, uptimeSec: null, buildId: null, healthAt: null, sigTs: 0, catchupRetryAt: 0, due: {} }, state);
  /* rows already stored (bounded to the overlap window): the 120 s overlap re-reads them, they are not stored twice */
  const seen = new Map();
  const rowKey = x => x.ticker + '|' + x.ts + '|' + x.state + '|' + x.side;
  const fresh = rows => { const out = []; for (const x of rows) { const k = rowKey(x); if (!seen.has(k)) { seen.set(k, x.ts); out.push(x); } }
    const cut = S.predTs - 3 * OVERLAP_MS; for (const [k, ts] of seen) if (ts < cut) seen.delete(k); return out; };
  const tasks = [['health', 60e3], ['predictions', 30e3], ['signals', 60e3], ['ledger', 60e3], ['calibration', 600e3], ['shadow', 300e3], ['brti', 300e3]]
    .map(([n, ms]) => [n, Math.max(1000, ms * (SCALE > 0 ? SCALE : 1))]);
  const meta = r => ({ status: r.status, tSent: r.tSent, tRecv: r.tRecv, date: r.date || null, bytes: r.bytes || 0, error: r.error || null });
  const PAGE = 2000;
  async function pullPred(query, extra = {}) {
    const r = await http.get(`${base}/predictions?${query}&format=ndjson`);
    const all = r.ok ? ndjson(r.text) : [];
    /* production returns rows in the order it wrote them: a timestamp going backwards in that order is a production clock
       step (its ts and seconds-remaining shift together, so the rows alone would look normal). Checked on the FULL reply. */
    const orderBreaks = []; for (let i = 1; i < all.length; i++) if (okInt(all[i].ts) && okInt(all[i - 1].ts) && all[i].ts < all[i - 1].ts - 1000) orderBreaks.push({ from: all[i - 1].ts, to: all[i].ts });
    const rows = fresh(all);
    emit({ kind: 'pr.predictions', ...meta(r), query, ...extra, received: all.length, alreadyStored: all.length - rows.length, orderBreaks, rows });
    return { ok: r.ok, all };
  }
  const run = {
    async health() {
      const r = await http.get(base + '/health'); const j = r.ok ? parse(r.text) : null;
      emit({ kind: 'pr.health', ...meta(r), body: j });
      /* production clock vs ours: [ts - tRecv, ts - tSent] must contain the offset. A new interval that does not overlap the
         previous one is a clock step; if production's clock went BACK, rows written after the step carry earlier
         timestamps, so the /predictions cursor is moved back by the step (plus the overlap) to fetch them */
      if (j && Number.isFinite(j.ts)) {
        const iv = [j.ts - r.tRecv, j.ts - r.tSent];
        if (S.clockIv && (iv[1] < S.clockIv[0] - 250 || iv[0] > S.clockIv[1] + 250)) {
          const delta = ((iv[0] + iv[1]) - (S.clockIv[0] + S.clockIv[1])) / 2;
          emit({ kind: 'pr.clockstep', at: r.tRecv, deltaMs: Math.round(delta), prev: S.clockIv, now: iv });
          if (delta < 0) S.predTs = Math.max(0, Math.round(S.predTs + delta));
        }
        S.clockIv = iv;
      }
      if (j && Number.isFinite(j.uptimeSec)) {
        const expected = S.uptimeSec != null && S.healthAt ? S.uptimeSec + (r.tRecv - S.healthAt) / 1000 : null;
        const restarted = expected != null && j.uptimeSec + 30 < expected;
        if (restarted || (S.buildId && j.build && j.build !== S.buildId)) emit({ kind: 'pr.restart', prevUptimeSec: S.uptimeSec, uptimeSec: j.uptimeSec, prevBuild: S.buildId, build: j.build, at: r.tRecv, approxRestartAt: r.tRecv - j.uptimeSec * 1000 });
        S.uptimeSec = j.uptimeSec; S.buildId = j.build || S.buildId; S.healthAt = r.tRecv;
      }
    },
    async predictions() {
      const since = Math.max(0, S.predTs - OVERLAP_MS);
      const { ok, all: rows } = await pullPred(`since=${since}&n=${PAGE}`, { since });
      if (!ok) return;                                                   // the cursor stays: the next poll asks again
      let newest = S.predTs;
      for (const x of rows) if (okInt(x.ts) && x.ts > newest) newest = x.ts;
      if (onTickers) onTickers([...new Set(rows.map(x => x.ticker).filter(t => typeof t === 'string'))]);
      /* a full page: the endpoint returns the NEWEST rows, so older ones may be missing. Fetch every market that closed
         after the cursor, one by one (each has at most ~310 rows), using Kalshi's list so none is skipped. The cursor
         moves only when the list and every per-market pull succeeded; otherwise it stays and the catch-up is retried
         (backing off 5 min, so a failing dependency cannot multiply the load on production). */
      if (rows.length >= PAGE && S.predTs > 0) {
        if (now() < S.catchupRetryAt) return;
        const tks = listTickers ? await listTickers(since, newest + 900e3) : null;
        let complete = Array.isArray(tks);
        emit({ kind: 'pr.predictions.catchup', since, until: newest, tickers: tks || [], listOk: complete });
        for (const tk of tks || []) { const q = await pullPred(`since=${since}&ticker=${encodeURIComponent(tk)}&n=${PAGE}`, { since, ticker: tk }); if (!q.ok) complete = false; }
        if (!complete) { S.catchupRetryAt = now() + 300e3; emit({ kind: 'pr.predictions.catchup.incomplete', since, retryAt: S.catchupRetryAt }); return; }
      }
      S.predTs = newest;
    },
    async signals() {
      /* production returns its newest entries; only the ones not stored before are kept (ts after the cursor) */
      const r = await http.get(base + '/signals?n=1000'); const j = r.ok ? parse(r.text) : null;
      const all = j && Array.isArray(j.signals) ? j.signals : null;
      const neu = all ? all.filter(x => x && okInt(x.ts) && x.ts > S.sigTs) : null;
      emit({ kind: 'pr.signals', ...meta(r), received: all ? all.length : 0, signals: neu, oldestReceivedTs: all && all.length ? all[0].ts : null, cursor: S.sigTs });
      if (neu && neu.length) S.sigTs = Math.max(...neu.map(x => x.ts));
    },
    async ledger() {
      /* chain identity and the oldest entry still in production's memory */
      const r0 = await http.get(`${base}/ledger?since=0&n=1`); const j0 = r0.ok ? parse(r0.text) : null;
      if (!j0) { emit({ kind: 'pr.ledger', ...meta(r0), rows: [], note: 'ledger info unavailable' }); return; }
      if (S.chainId && j0.chainId && j0.chainId !== S.chainId) { emit({ kind: 'pr.ledger.newchain', prevChainId: S.chainId, prevSeq: S.ledgerSeq, chainId: j0.chainId, seq: j0.seq }); S.ledgerSeq = 0; }
      if (j0.chainId) S.chainId = j0.chainId;
      if (okInt(j0.inMemoryFrom) && j0.inMemoryFrom > S.ledgerSeq + 1) {
        emit({ kind: 'pr.ledger.gap', from: S.ledgerSeq + 1, to: j0.inMemoryFrom - 1, note: 'entries no longer held in production memory' });
        S.ledgerSeq = j0.inMemoryFrom - 1;
      }
      for (let page = 0; page < 20; page++) {
        const r = await http.get(`${base}/ledger?since=${S.ledgerSeq}&n=5000&format=ndjson`);
        const rows = r.ok ? ndjson(r.text) : [];
        emit({ kind: 'pr.ledger', ...meta(r), since: S.ledgerSeq, chainId: S.chainId, rows });
        const last = rows.length ? rows[rows.length - 1].seq : null;
        if (!okInt(last) || last <= S.ledgerSeq) break;
        S.ledgerSeq = last;
        if (rows.length < 5000) break;
      }
    },
    async calibration() { const r = await http.get(base + '/calibration'); const j = r.ok ? parse(r.text) : null; emit({ kind: 'pr.calibration', ...meta(r), tiers: j && j.tiers || null, live: j && j.live || null }); },
    async shadow() { const r = await http.get(base + '/shadow'); emit({ kind: 'pr.shadow', ...meta(r), body: r.ok ? parse(r.text) : null }); },
    async brti() { const r = await http.get(base + '/brti-status'); emit({ kind: 'pr.brti', ...meta(r), body: r.ok ? parse(r.text) : null }); },
  };
  async function step(t = now()) {
    for (const [name, every] of tasks) {
      if (t < (S.due[name] || 0)) continue;
      S.due[name] = t + every;
      try { await run[name](); } catch (e) { emit({ kind: 'pr.error', task: name, error: String(e && e.message || e) }); }
    }
  }
  return { step, state: S };
}

function kalshiSource({ base = 'https://api.elections.kalshi.com/trade-api/v2', http, emit, now = Date.now, state = {} }) {
  base = String(base).replace(/\/+$/, '');
  const S = Object.assign({ markets: {}, due: {}, lastBook: {} }, state);
  const meta = r => ({ status: r.status, tSent: r.tSent, tRecv: r.tRecv, date: r.date || null, error: r.error || null });
  const addMarket = (m, t) => { if (m && /^KXBTC15M-[A-Z0-9-]+$/.test(m.ticker) && !S.markets[m.ticker] && m.close_time) S.markets[m.ticker] = { ticker: m.ticker, closeMs: Date.parse(m.close_time), openMs: Date.parse(m.open_time), final: m.status === 'finalized', firstSeen: t }; };
  async function discover(t) {
    const r = await http.get(base + '/markets?series_ticker=KXBTC15M&status=open&limit=100');
    const j = r.ok ? parse(r.text) : null;
    emit({ kind: 'k.markets', ...meta(r), markets: j && j.markets || null });
    for (const m of (j && j.markets) || []) addMarket(m, t);
  }
  /* every KXBTC15M market that closed in [fromMs, toMs] (for catch-up after an outage); recorded, and tracked for results */
  async function listTickers(fromMs, toMs) {
    const r = await http.get(`${base}/markets?series_ticker=KXBTC15M&min_close_ts=${Math.floor(fromMs / 1000)}&max_close_ts=${Math.ceil(toMs / 1000)}&limit=1000`);
    const j = r.ok ? parse(r.text) : null;
    emit({ kind: 'k.markets', ...meta(r), range: [fromMs, toMs], markets: j && j.markets || null });
    if (!j || !Array.isArray(j.markets)) return null;                  // failure: the caller keeps its cursor and retries
    const out = [];
    for (const m of (j && j.markets) || []) { addMarket(m, now()); if (/^KXBTC15M-[A-Z0-9-]+$/.test(m.ticker)) out.push(m.ticker); }
    return out;
  }
  const pending = new Set();
  function track(tickers) { for (const tk of tickers) if (/^KXBTC15M-[A-Z0-9-]+$/.test(tk) && !S.markets[tk]) pending.add(tk); }
  async function learn() {
    for (const tk of [...pending]) {
      pending.delete(tk);
      const r = await http.get(`${base}/markets/${encodeURIComponent(tk)}`);
      const j = r.ok ? parse(r.text) : null; const m = j && (j.market || j);
      emit({ kind: 'k.market', ticker: tk, ...meta(r), market: m || null, via: 'tracked from Pin Radar records' });
      if (m) addMarket(m, now());
    }
  }
  async function book(tk) {
    const r = await http.get(`${base}/markets/${encodeURIComponent(tk)}/orderbook?depth=100`);
    const j = r.ok ? parse(r.text) : null;
    const h = j ? sha(r.text) : null;
    /* an unchanged book is stored as a timestamped reference to the previous identical one (evidence it was still there) */
    if (j && S.lastBook[tk] === h) emit({ kind: 'k.book.same', ticker: tk, ...meta(r), ref: h });
    else emit({ kind: 'k.book', ticker: tk, ...meta(r), hash: h, book: j });
    if (h) S.lastBook[tk] = h;
  }
  async function result(tk) {
    const r = await http.get(`${base}/markets/${encodeURIComponent(tk)}`);
    const j = r.ok ? parse(r.text) : null; const m = j && (j.market || j);
    emit({ kind: 'k.market', ticker: tk, ...meta(r), market: m || null });
    if (m && m.status === 'finalized' && S.markets[tk]) S.markets[tk].final = true;
  }
  /* books run in their own lane (stepBooks), so a slow discovery or result request never delays the 1 Hz snapshots */
  async function stepBooks(t = now()) {
    for (const m of Object.values(S.markets)) {
      const tau = (m.closeMs - t) / 1000;
      if (!(tau > 0 && tau <= 900)) continue;
      const key = 'b:' + m.ticker;
      if (t >= (S.due[key] || 0)) {
        /* 1 s inside the final 300 s; 15 s before, but never later than the start of the final 300 s */
        S.due[key] = tau <= 300 ? t + 1000 : Math.min(t + 15000, m.closeMs - 300e3);
        try { await book(m.ticker); } catch (e) { emit({ kind: 'k.error', task: 'book', ticker: m.ticker, error: String(e.message || e) }); }
      }
    }
  }
  async function stepMeta(t = now()) {
    if (pending.size) { try { await learn(); } catch (e) { emit({ kind: 'k.error', task: 'learn', error: String(e.message || e) }); } }
    if (t >= (S.due.discover || 0)) { S.due.discover = t + 30e3; try { await discover(t); } catch (e) { emit({ kind: 'k.error', task: 'discover', error: String(e.message || e) }); } }
    if (t >= (S.due.series || 0)) { S.due.series = t + 6 * 3600e3; try { const r = await http.get(base + '/series/KXBTC15M'); emit({ kind: 'k.series', ...meta(r), series: r.ok ? (parse(r.text) || {}).series || null : null }); } catch (e) { emit({ kind: 'k.error', task: 'series', error: String(e.message || e) }); } }
    for (const m of Object.values(S.markets)) {
      const tau = (m.closeMs - t) / 1000;
      if (tau <= -5 && !m.final) {
        const key = 'r:' + m.ticker, since = t - m.closeMs;
        if (t >= (S.due[key] || 0)) {
          S.due[key] = t + (since < 3600e3 ? 15e3 : since < 24 * 3600e3 ? 300e3 : 3600e3);   // back off, never give up within 7 days
          try { await result(m.ticker); } catch (e) { emit({ kind: 'k.error', task: 'result', ticker: m.ticker, error: String(e.message || e) }); }
        }
        if (since > 6 * 3600e3 && !m.flagged) { m.flagged = true; emit({ kind: 'k.result.missing', ticker: m.ticker, closeMs: m.closeMs, note: 'not finalized 6 h after the close; still polling' }); }
      }
    }
    for (const [tk, m] of Object.entries(S.markets)) if ((m.final && t - m.closeMs > 24 * 3600e3) || t - m.closeMs > 7 * 864e5) { delete S.markets[tk]; delete S.lastBook[tk]; delete S.due['b:' + tk]; delete S.due['r:' + tk]; }
  }
  async function step(t = now()) { await stepMeta(t); await stepBooks(t); }
  return { step, stepBooks, stepMeta, track, listTickers, state: S, tickers: () => Object.keys(S.markets) };
}
module.exports = { pinradarSource, kalshiSource, ndjson, OVERLAP_MS };
