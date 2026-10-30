/* Collectors. Each one stores what it saw, as received, with request and response times (observer UTC ms).
   Nothing is inferred here; interpretation happens in derive.js, which can be re-run on the raw records at any time.

   Pin Radar (production, read-only exports it already publishes):
     /predictions  every 30 s  one row per second + every state change in each window's final 300 s (its own record)
     /signals      every 60 s  state transitions with gates
     /ledger       every 60 s  its hash-chained ledger (calls committed before outcomes), pulled by sequence number
     /health       every 60 s  version, build, uptime (restart detection), configured LOCKED threshold, clock skew
     /calibration, /shadow, /brti-status every 5-10 min
   Kalshi (public market data only, no credentials):
     open KXBTC15M markets every 30 s; each market's order book every 1 s in its final 300 s and every 15 s before;
     its final result after the close (until finalized); the series (fee schedule, settlement source) every 6 h.
   Load on Pin Radar: about 5 small GET requests a minute in total. */
'use strict';
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
const SCALE = Number(process.env.OBSERVER_INTERVAL_SCALE || 1);          // tests only: shortens the Pin Radar polling intervals
const parse = t => { try { return JSON.parse(t); } catch (_) { return null; } };
const ndjson = t => String(t || '').split('\n').filter(Boolean).map(l => parse(l)).filter(Boolean);

function pinradarSource({ base, http, emit, now = Date.now, state = {}, onTickers = null }) {
  base = String(base).replace(/\/+$/, '');
  const S = Object.assign({ predTs: 0, ledgerSeq: 0, chainId: null, uptimeSec: null, buildId: null, due: {} }, state);
  const tasks = [
    ['health', 60e3], ['predictions', 30e3], ['signals', 60e3], ['ledger', 60e3], ['calibration', 600e3], ['shadow', 300e3], ['brti', 300e3],
  ].map(([n, ms]) => [n, ms * SCALE]);
  const meta = r => ({ status: r.status, tSent: r.tSent, tRecv: r.tRecv, date: r.date || null, bytes: r.bytes || 0, error: r.error || null });
  const run = {
    async health() {
      const r = await http.get(base + '/health'); const j = r.ok ? parse(r.text) : null;
      emit({ kind: 'pr.health', ...meta(r), body: j });
      if (j) {
        const restarted = S.uptimeSec != null && Number.isFinite(j.uptimeSec) && j.uptimeSec + 5 < S.uptimeSec + (r.tRecv - (S.healthAt || r.tRecv)) / 1000;
        if (restarted || (S.buildId && j.build && j.build !== S.buildId)) emit({ kind: 'pr.restart', prevUptimeSec: S.uptimeSec, uptimeSec: j.uptimeSec, prevBuild: S.buildId, build: j.build, at: r.tRecv });
        S.uptimeSec = j.uptimeSec; S.buildId = j.build || S.buildId; S.healthAt = r.tRecv;
      }
    },
    async predictions(knownTickers = []) {
      const n = 2000;
      const r = await http.get(`${base}/predictions?since=${S.predTs}&n=${n}&format=ndjson`);
      const rows = r.ok ? ndjson(r.text) : [];
      emit({ kind: 'pr.predictions', ...meta(r), since: S.predTs, rows });
      /* a full page means older rows may have been cut (the endpoint returns the newest n): fetch window by window */
      if (rows.length >= n) {
        emit({ kind: 'pr.predictions.catchup', since: S.predTs, tickers: knownTickers });
        for (const tk of knownTickers) {
          const q = await http.get(`${base}/predictions?since=${S.predTs}&ticker=${encodeURIComponent(tk)}&n=${n}&format=ndjson`);
          emit({ kind: 'pr.predictions', ...meta(q), since: S.predTs, ticker: tk, rows: q.ok ? ndjson(q.text) : [] });
        }
      }
      for (const x of rows) if (x.ts > S.predTs) S.predTs = x.ts;
      if (onTickers) onTickers([...new Set(rows.map(x => x.ticker).filter(Boolean))]);
    },
    async signals() {
      const r = await http.get(base + '/signals?n=1000'); const j = r.ok ? parse(r.text) : null;
      emit({ kind: 'pr.signals', ...meta(r), signals: j && Array.isArray(j.signals) ? j.signals : null });
    },
    async ledger() {
      for (let page = 0; page < 20; page++) {
        const r = await http.get(`${base}/ledger?since=${S.ledgerSeq}&n=5000&format=ndjson`);
        const rows = r.ok ? ndjson(r.text) : [];
        if (rows.length && rows[0].seq === 1 && S.ledgerSeq > 0) emit({ kind: 'pr.ledger.newchain', prevSeq: S.ledgerSeq, chainId: rows[0].hash });
        emit({ kind: 'pr.ledger', ...meta(r), since: S.ledgerSeq, rows });
        if (!rows.length) break;
        S.ledgerSeq = rows[rows.length - 1].seq;
        if (rows.length < 5000) break;
      }
    },
    async calibration() { const r = await http.get(base + '/calibration'); const j = r.ok ? parse(r.text) : null; emit({ kind: 'pr.calibration', ...meta(r), tiers: j && j.tiers || null, live: j && j.live || null }); },
    async shadow() { const r = await http.get(base + '/shadow'); emit({ kind: 'pr.shadow', ...meta(r), body: r.ok ? parse(r.text) : null }); },
    async brti() { const r = await http.get(base + '/brti-status'); emit({ kind: 'pr.brti', ...meta(r), body: r.ok ? parse(r.text) : null }); },
  };
  async function step(t = now(), knownTickers = []) {
    for (const [name, every] of tasks) {
      if (t < (S.due[name] || 0)) continue;
      S.due[name] = t + every;
      try { await run[name](knownTickers); } catch (e) { emit({ kind: 'pr.error', task: name, error: String(e && e.message || e) }); }
    }
  }
  /* a production restart resets its ledger sequence when it keeps no ledger file: the next pull starts at seq 1 */
  return { step, state: S };
}

function kalshiSource({ base = 'https://api.elections.kalshi.com/trade-api/v2', http, emit, now = Date.now, state = {} }) {
  base = String(base).replace(/\/+$/, '');
  const S = Object.assign({ markets: {}, due: {}, lastBook: {} }, state);
  const meta = r => ({ status: r.status, tSent: r.tSent, tRecv: r.tRecv, date: r.date || null, error: r.error || null });
  async function discover(t) {
    const r = await http.get(base + '/markets?series_ticker=KXBTC15M&status=open&limit=100');
    const j = r.ok ? parse(r.text) : null;
    emit({ kind: 'k.markets', ...meta(r), markets: j && j.markets || null });
    for (const m of (j && j.markets) || []) {
      const closeMs = Date.parse(m.close_time);
      if (!S.markets[m.ticker]) S.markets[m.ticker] = { ticker: m.ticker, closeMs, openMs: Date.parse(m.open_time), final: false, firstSeen: t };
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
    if (m && m.status === 'finalized') S.markets[tk].final = true;
  }
  /* a market seen in Pin Radar's records but not (yet) in the open list: learn its times so its result is collected too */
  const pending = new Set();
  function track(tickers) { for (const tk of tickers) if (/^KXBTC15M-/.test(tk) && !S.markets[tk]) pending.add(tk); }
  async function learn() {
    for (const tk of [...pending]) {
      pending.delete(tk);
      const r = await http.get(`${base}/markets/${encodeURIComponent(tk)}`);
      const j = r.ok ? parse(r.text) : null; const m = j && (j.market || j);
      emit({ kind: 'k.market', ticker: tk, ...meta(r), market: m || null, via: 'tracked from Pin Radar records' });
      if (m && m.close_time) S.markets[tk] = { ticker: tk, closeMs: Date.parse(m.close_time), openMs: Date.parse(m.open_time), final: m.status === 'finalized', firstSeen: now() };
    }
  }
  async function step(t = now()) {
    if (pending.size) { try { await learn(); } catch (e) { emit({ kind: 'k.error', task: 'learn', error: String(e.message || e) }); } }
    if (t >= (S.due.discover || 0)) { S.due.discover = t + 30e3; try { await discover(t); } catch (e) { emit({ kind: 'k.error', task: 'discover', error: String(e.message || e) }); } }
    if (t >= (S.due.series || 0)) { S.due.series = t + 6 * 3600e3; const r = await http.get(base + '/series/KXBTC15M'); emit({ kind: 'k.series', ...meta(r), series: r.ok ? (parse(r.text) || {}).series || null : null }); }
    for (const m of Object.values(S.markets)) {
      const tau = (m.closeMs - t) / 1000;
      if (tau > 0 && tau <= 900) {
        const every = tau <= 300 ? 1000 : 15000, key = 'b:' + m.ticker;
        if (t >= (S.due[key] || 0)) { S.due[key] = t + every; try { await book(m.ticker); } catch (e) { emit({ kind: 'k.error', task: 'book', ticker: m.ticker, error: String(e.message || e) }); } }
      } else if (tau <= -5 && !m.final && t - m.closeMs < 6 * 3600e3) {
        const key = 'r:' + m.ticker;
        if (t >= (S.due[key] || 0)) { S.due[key] = t + 15000; try { await result(m.ticker); } catch (e) { emit({ kind: 'k.error', task: 'result', ticker: m.ticker, error: String(e.message || e) }); } }
      } else if (t - m.closeMs >= 6 * 3600e3 && !m.final && !m.gaveUp) { m.gaveUp = true; emit({ kind: 'k.result.missing', ticker: m.ticker, closeMs: m.closeMs }); }
    }
    for (const [tk, m] of Object.entries(S.markets)) if (t - m.closeMs > 24 * 3600e3) delete S.markets[tk];
  }
  return { step, track, state: S, tickers: () => Object.keys(S.markets) };
}
module.exports = { pinradarSource, kalshiSource, ndjson };
