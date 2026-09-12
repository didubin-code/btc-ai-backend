/* =====================================================================
   BTC PIN RADAR — streaming server
   v2.0  (2026-09-10)

   WHAT CHANGED FROM 1.5 (see UPGRADE_NOTES.md for the full audit):
   -------------------------------------------------------------------
   1. REST polling in the request path is GONE. Coinbase / Kraken /
      Bitstamp are now persistent WebSockets ingested continuously into
      memory. /radar reads memory and returns in ~1ms.
   2. A 1.1 MB Coinbase `book?level=2` REST call (72 ms of blocking
      JSON.parse, 66 of 21,070 levels actually used) was being pulled
      twice per cycle. Replaced by the streaming `level2_50` book.
   3. Price is now a BRTI-PROXY INDEX: outlier-rejected, liquidity-
      weighted consensus across the three US-reachable BRTI constituent
      venues, sampled at 1 Hz to mirror the real index cadence.
   4. SETTLEMENT-AWARE GEOMETRY. Kalshi KXBTC15M settles on the simple
      average of the 60 seconds of CF Benchmarks BRTI before the close
      (verbatim from the live market record's rules_primary). The old
      model measured distance-to-strike against a spot point estimate,
      which is the wrong random variable. We now model the variance of
      the trailing-60s average directly. See settlementGeometry().
   5. Kalshi market discovery FIXED. The old query
      (`/markets?status=open&limit=200&min_close_ts=..`) matched ZERO
      BTC markets in production — BTC is not in the first 200 rows.
      Now uses series_ticker=KXBTC15M.
   6. `close_ts` DOES NOT EXIST on the Kalshi market record. The old code
      read Number(m.close_ts||0) === 0 for every market, collapsing the
      window grouping. Now uses close_time (ISO) as authority, and the
      countdown is derived from it instead of a hand-typed timer.
   7. `yes_bid`/`yes_ask` DO NOT EXIST either — the fields are
      `yes_bid_dollars`/`yes_ask_dollars`. Fixed.
   8. Binance removed from the hot path: api.binance.com returns HTTP 451
      from US hosts (verified). It was dead weight on every fallback.
   9. Clock-skew estimation against exchange timestamps. All freshness
      ages are computed in a skew-corrected domain.
  10. FAIL-SAFE GATING. Degraded data can no longer render as GREEN.
      Every response carries a machine-readable `quality` block and the
      level is floored at DEGRADED/STALE when inputs are not trustworthy.

   Legacy fusion (computePinPressure) is preserved byte-for-byte in
   behaviour and still exported, so 1.5 self-tests and any downstream
   consumer keep working. It runs alongside the new model and is
   reported under `legacy` for A/B comparison.
   ===================================================================== */
'use strict';
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');

/* WebSocket: Node >=21 has a global. Fall back to `ws` if present. */
let WSImpl = globalThis.WebSocket || null;
if (!WSImpl) { try { WSImpl = require('ws'); } catch (_) { WSImpl = null; } }
const WS_AVAILABLE = !!WSImpl;

function clampEnv(v, dflt, lo, hi){const n=Number(v);return Number.isFinite(n)?Math.max(lo,Math.min(hi,n)):dflt;}

/* ----------------------------- config ----------------------------- */
const PORT = Number(process.env.PORT || 10000);
const SERVER_VERSION = 'pin-radar-2.0';
const KALSHI_BASE = (process.env.KALSHI_BASE || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/+$/, '');
const KALSHI_SERIES = String(process.env.KALSHI_SERIES || 'KXBTC15M');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ENABLE_OPENAI = /^(0|false|no)$/i.test(process.env.ENABLE_OPENAI || '') ? false
  : (/^(1|true|yes)$/i.test(process.env.ENABLE_OPENAI || '') || !!OPENAI_API_KEY);
const OPENAI_MODEL = String(process.env.OPENAI_MODEL || 'gpt-4o-mini').replace('gpt-40', 'gpt-4o');

/* Kalshi private API (optional). Without these we use public REST at 1 Hz.
   Kalshi's WS returns HTTP 401 on an unauthenticated handshake (verified). */
const KALSHI_KEY_ID = (process.env.KALSHI_KEY_ID || '').trim();
const KALSHI_WS_URL = process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2';

/* --------------------------------------------------------------------
   PRIVATE KEY HANDLING

   The key is read from the environment ONLY. It is never logged, never
   returned by any endpoint, never sent to the browser, and never
   embedded in an error message. The only thing ever exposed about it is
   a SHA-256 fingerprint of the DERIVED PUBLIC key, which is safe to
   show and is enough to confirm the right key is loaded.

   Accepted formats, so you do not have to fight your shell:
     - real multi-line PEM  (Render's secret-file / multiline value box)
     - single-line PEM with literal \n escapes
     - PEM wrapped in quotes
     - bare base64 body with no PEM header/footer
   -------------------------------------------------------------------- */
function normalisePem(raw) {
  let k = String(raw || '');
  if (!k) return '';
  k = k.trim();
  // strip a wrapping pair of quotes if the shell kept them
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  k = k.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (k.includes('-----BEGIN')) {
    // Re-flow: some dashboards collapse the body onto one line.
    const m = k.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
    if (m) {
      const body = m[2].replace(/\s+/g, '');
      const lines = body.match(/.{1,64}/g) || [];
      k = `-----BEGIN ${m[1]}-----\n${lines.join('\n')}\n-----END ${m[1]}-----\n`;
    }
    return k;
  }
  // bare base64 body -> assume PKCS#8, which is what Kalshi hands out
  const body = k.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=]+$/.test(body) && body.length > 200) {
    const lines = body.match(/.{1,64}/g) || [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  }
  return k;
}
const KALSHI_PRIVATE_KEY = normalisePem(process.env.KALSHI_PRIVATE_KEY);

/* Never let key bytes reach a log line or an HTTP response. */
function redact(err) {
  let m = String((err && (err.message || err)) || 'error');
  if (KALSHI_PRIVATE_KEY) {
    for (const frag of [KALSHI_PRIVATE_KEY, KALSHI_PRIVATE_KEY.replace(/\n/g, '')]) {
      if (frag.length > 24) m = m.split(frag).join('[redacted]');
    }
  }
  if (KALSHI_KEY_ID && KALSHI_KEY_ID.length > 6) m = m.split(KALSHI_KEY_ID).join('[key-id]');
  // belt and braces: strip anything that looks like PEM content
  m = m.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[redacted-pem]');
  return m.slice(0, 200);
}

/* Validate at boot. Returns only safe metadata — type, size, fingerprint. */
const KALSHI_KEY_INFO = (() => {
  if (!KALSHI_PRIVATE_KEY) return { present: false, valid: false, error: 'KALSHI_PRIVATE_KEY not set' };
  if (/-----BEGIN (RSA )?PUBLIC KEY-----/.test(KALSHI_PRIVATE_KEY)) {
    return { present: true, valid: false, error: 'that is a PUBLIC key — Kalshi signing needs the PRIVATE key' };
  }
  try {
    const key = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
    if (key.asymmetricKeyType !== 'rsa') {
      return { present: true, valid: false, error: 'key type is ' + key.asymmetricKeyType + ', Kalshi requires RSA' };
    }
    const bits = key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength;
    if (bits && bits < 2048) return { present: true, valid: false, error: 'RSA key is only ' + bits + ' bits' };
    const pubDer = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
    const fingerprint = crypto.createHash('sha256').update(pubDer).digest('hex').slice(0, 16);
    return { present: true, valid: true, type: 'rsa', bits: bits || null, fingerprint, error: null };
  } catch (e) {
    return { present: true, valid: false, error: 'unreadable key: ' + redact(e) };
  }
})();
const KALSHI_HAVE_CREDS = !!(KALSHI_KEY_ID && KALSHI_KEY_INFO.valid);

/* Freshness budgets (ms). Anything past these degrades the reading. */
const VENUE_STALE_MS = Number(process.env.VENUE_STALE_MS || 3000);
const INDEX_STALE_MS = Number(process.env.INDEX_STALE_MS || 2500);
const INDEX_HARD_STALE_MS = Number(process.env.INDEX_HARD_STALE_MS || 10000);
const KALSHI_STALE_MS = Number(process.env.KALSHI_STALE_MS || 6000);
const MIN_INDEX_VENUES = Number(process.env.MIN_INDEX_VENUES || 2);
const OUTLIER_BPS = Number(process.env.OUTLIER_BPS || 25);   // venue vs median
const SETTLE_WINDOW_SEC = Number(process.env.SETTLE_WINDOW_SEC || 60);
/* Drift projection damping — see settlementGeometry(). */
const DRIFT_HORIZON_SEC = Number(process.env.DRIFT_HORIZON_SEC || 90);
const DRIFT_SHRINK = clampEnv(process.env.DRIFT_SHRINK, 0.35, 0, 1);
/* Vol prior. A short or very quiet ring produces an estimate far below
   anything BTC actually realises; in live testing a 30 s ring drove sigma
   to the old 0.05 floor and the model reported 99.95% confidence against a
   market pricing 69.5%. We shrink the sample estimate toward a prior with
   weight n/(n+VOL_SHRINK_N) and floor it. Measured reference points:
   realised ~0.46, market-implied ~0.58 bps/root-s. */
const VOL_PRIOR = clampEnv(process.env.VOL_PRIOR, 0.55, 0.05, 5);
const VOL_SHRINK_N = Number(process.env.VOL_SHRINK_N || 40);
const VOL_MIN_SAMPLES = Number(process.env.VOL_MIN_SAMPLES || 45);

/* =====================================================================
   v2.1 — SETTLEMENT RESIDUAL TAIL LAW  (2026-09-11 post-mortem)
   ---------------------------------------------------------------------
   The 2.0 model standardised the settlement residual and pushed it
   through normCdf(). That is a specification error, not a rounding one.
   Measured on 217,000 (tau, z) pairs reconstructed from the BRTI-
   constituent tape (Coinbase + Kraken + Bitstamp, 1 Hz, 5 h):

        |z|     observed P(|Z|>z)     Gaussian
          3          2.81%            2.7e-1 %
          6          0.579%           2.0e-7 %
         12          0.0995%          0
         30          0.0046%          0

   The residual is a power law with tail index ~2.5, not a Gaussian.
   Consequence in the 2026-09-11 19:45 PT window: at tau=13 the model
   reported an 11.75-sigma cushion and pAdverse at its 0.01 clamp floor.
   A Gaussian 11.75 sigma is 1e-31. The empirical figure is ~1e-3.
   The displayed safety margin was wrong by ~28 orders of magnitude.

   Replacement two-sided survival, fit under the constraint that it may
   never UNDER-state observed risk for |z| >= 1 (max under-fit 1.00x,
   worst over-fit 1.29x across |z| in [2,20]):

        P(|Z| > x) = (1 + (x/a)^2) ^ (-b),   a = 0.804, b = 1.268
   ===================================================================== */
const SETTLE_TAIL_A = clampEnv(process.env.SETTLE_TAIL_A, 0.804, 0.2, 4);
const SETTLE_TAIL_B = clampEnv(process.env.SETTLE_TAIL_B, 1.268, 0.5, 4);
/* The old [0.01, 0.99] clamp flattened every state in the final 40 s to
   an identical 1%, which is why an $8 cushion and an $80 cushion both
   rendered GREEN. Widened so resolution survives; still not 0/1. */
const P_CLAMP_LO = clampEnv(process.env.P_CLAMP_LO, 0.0002, 1e-6, 0.05);

/* =====================================================================
   v2.1 — TAKER IMPULSE DETECTOR
   ---------------------------------------------------------------------
   The 19:45 PT reversal was a taker impulse, not a diffusion excursion.
   At 02:59:48Z the trailing-5s taker notional went from $219 to
   $360,755 (18x the trailing-120s median, 99.9th pct of the session)
   with +0.59 buy imbalance and cross-venue dispersion at 2.08 bps
   (Coinbase leading Bitstamp by $16.03). The index had moved $5.58 and
   the projected settlement was still $6.73 on the safe side. One second
   later it had crossed.

   The 120 s realised-vol estimator cannot see this: it read 0.20
   bps/root-s at that instant and 0.45 two seconds later. It is a
   lagging estimator by construction, so no tuning of it fixes this.

   Conditional power measured over the same 5 h (34 impulse onsets):

     P(adverse mean-move >= $20 over next 12 s)
        quiet tape .................. 0.56%
        impulse continuing .......... 7.69%   (13.7x)
        impulse ONSET ............... 20.59%  (36.8x)

   Exponential fit, P(move >= R) = exp(-R / (K * sqrt(h))):
        K = 3.6 onset, 2.25 continuing, 1.1 quiet.
   Residuals at R = $10/$20/$35, onset: 45.4/20.6/6.3% fitted vs
   44.1/20.6/5.9% observed.
   ===================================================================== */
const IMP_SURGE_MIN = clampEnv(process.env.IMP_SURGE_MIN, 8, 1, 1000);
const IMP_NOTIONAL_MIN = clampEnv(process.env.IMP_NOTIONAL_MIN, 300000, 1000, 1e9);
const IMP_IMBALANCE_MIN = clampEnv(process.env.IMP_IMBALANCE_MIN, 0.35, 0, 1);
const IMP_BASELINE_FLOOR = clampEnv(process.env.IMP_BASELINE_FLOOR, 20000, 1000, 1e9);
const IMP_QUIET_GAP_SEC = clampEnv(process.env.IMP_QUIET_GAP_SEC, 8, 1, 60);
const REACH_K_ONSET = clampEnv(process.env.REACH_K_ONSET, 3.6, 0.5, 20);
const REACH_K_LIVE = clampEnv(process.env.REACH_K_LIVE, 2.25, 0.5, 20);
const REACH_K_QUIET = clampEnv(process.env.REACH_K_QUIET, 1.1, 0.2, 20);
/* Impulse escalation only applies inside this horizon: past it the
   settlement average has enough unlocked time to absorb an impulse and
   the gate would fire on noise. */
const IMP_MAX_TAU = clampEnv(process.env.IMP_MAX_TAU, 90, 5, 900);

/* =====================================================================
   v2.1 — INDEX RESOLUTION FLOOR
   ---------------------------------------------------------------------
   The index is a 3-venue proxy for CF Benchmarks BRTI, not BRTI. Its
   error was measured directly against Kalshi's own published strikes,
   which are defined as the 60 s BRTI average before the window open —
   the identical statistic this server computes:

       19 windows, mean |error| $2.71, max $6.12, sd ~$3.3

   A cushion of $8.02 (the 19:45 PT window) is therefore only ~3x the
   mean instrument error. Below INDEX_ERR_USD * GREEN_MIN_CUSHION_K the
   server cannot resolve which side of the strike the settlement average
   lands on, and reporting CLEAR is a statement about the instrument
   that the instrument cannot support. This floors the level at YELLOW
   (WATCH) — it is a resolution warning, not a cross prediction, so it
   deliberately does NOT escalate to AMBER/RED. */
const INDEX_ERR_USD = clampEnv(process.env.INDEX_ERR_USD, 2.71, 0, 100);
const GREEN_MIN_CUSHION_K = clampEnv(process.env.GREEN_MIN_CUSHION_K, 3, 0, 20);
const RESOLUTION_MAX_TAU = clampEnv(process.env.RESOLUTION_MAX_TAU, 120, 0, 900);

/* A venue's book can legitimately sit unchanged in a quiet market. We
   separate SOCKET liveness (messages, incl. heartbeats) from QUOTE change. */
const VENUE_SILENT_MS = Number(process.env.VENUE_SILENT_MS || 6000);
const VENUE_QUOTE_MAX_MS = Number(process.env.VENUE_QUOTE_MAX_MS || 30000);
const ENABLE_WS = /^(0|false|no)$/i.test(process.env.ENABLE_WS || '') ? false : true;
const REST_FALLBACK_MS = Number(process.env.REST_FALLBACK_MS || 1500);

/* ----------------------------- helpers ----------------------------- */
function clamp(x, lo, hi) { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; }
function round(x, d = 4) { const n = Number(x); return Number.isFinite(n) ? Number(n.toFixed(d)) : null; }
function erf(x) { const s = x < 0 ? -1 : 1; x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return s * y; }
function normCdf(x) { return 0.5 * (1 + erf(x / Math.SQRT2)); }
/* Two-sided survival of the standardised settlement residual under the
   empirically fitted power law. See SETTLE_TAIL_A/B above. */
function settleTailSurvival(x) {
  const z = Math.abs(Number(x));
  if (!Number.isFinite(z)) return 1;
  const r = z / SETTLE_TAIL_A;
  return Math.pow(1 + r * r, -SETTLE_TAIL_B);
}
/* CDF analogue of normCdf under the same law: P(Z <= x). Symmetric. */
function settleTailCdf(x) {
  const s = settleTailSurvival(x) / 2;          // one tail
  return x >= 0 ? 1 - s : s;
}
/* P(the index's mean over the next `h` seconds moves at least `reqUsd`
   in the adverse direction), conditional on tape regime. Exponential fit
   to 5 h of BRTI-constituent tape; see IMPULSE DETECTOR block. */
function reachProbability(reqUsd, h, regime) {
  const R = Math.max(0, Number(reqUsd));
  const H = Math.max(1, Number(h) || 1);
  if (!Number.isFinite(R)) return null;
  const K = regime === 'onset' ? REACH_K_ONSET : regime === 'live' ? REACH_K_LIVE : REACH_K_QUIET;
  return clamp(Math.exp(-R / (K * Math.sqrt(H))), 1e-6, 0.99);
}
function median(a) { if (!a || !a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function cors(res) { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Cache-Control', 'no-store'); }
function send(res, code, obj) { cors(res); res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); }
function readBody(req, limit = 200000) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { if (!d) return resolve({}); try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
async function fetchJson(url, opts = {}, timeoutMs = 4000) {
  const ac = new AbortController(); const t = setTimeout(() => { try { ac.abort(); } catch (_) { } }, timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' }, ...opts });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* =====================================================================
   CLOCK SKEW
   Exchange message timestamps are authoritative for event time; our own
   Date.now() is not. Measured -35 ms against Coinbase on a clean host.
   We track a robust (median) estimate of (localClock - exchangeClock)
   per venue and expose the consensus so ages are never silently wrong.
   ===================================================================== */
const SKEW = { samples: [], estMs: 0, n: 0, lastUpdate: 0 };
function noteSkew(localMs, exchangeMs) {
  if (!Number.isFinite(exchangeMs) || !Number.isFinite(localMs)) return;
  const d = localMs - exchangeMs;
  if (Math.abs(d) > 120000) return;            // nonsense; ignore
  SKEW.samples.push(d);
  if (SKEW.samples.length > 401) SKEW.samples.shift();
  SKEW.n++;
  if (SKEW.samples.length >= 5) { SKEW.estMs = median(SKEW.samples); SKEW.lastUpdate = localMs; }
}
/* Age of an event that carried an exchange timestamp, corrected for skew. */
function ageOfExchangeTs(exchangeMs, now = Date.now()) {
  if (!Number.isFinite(exchangeMs)) return null;
  return (now - SKEW.estMs) - exchangeMs;
}

/* =====================================================================
   STREAMING VENUE MANAGER
   One resilient socket per venue. Exponential backoff with jitter,
   watchdog on message silence, explicit state so /health can prove it.
   ===================================================================== */
function mkVenue(name, cfg) {
  return {
    name, cfg,
    ws: null, state: 'init',            // init|connecting|open|closed|failed|disabled
    bid: NaN, ask: NaN, mid: NaN,
    bidDepth: 0, askDepth: 0,           // size within BAND of mid
    book: { bids: new Map(), asks: new Map() },
    lastMsgTs: 0, lastQuoteTs: 0, lastExchangeTs: NaN,
    trades: [],                         // [localTs, signedNotional, price]
    msgCount: 0, reconnects: 0, seqGaps: 0,
    lastError: null, lastErrorTs: 0,
    backoffMs: 500, connectTimer: null, watchdog: null
  };
}
const BAND_FRAC = 0.0006;   // ±6 bps around mid — same band the 1.5 code used
const VENUES = {
  coinbase: mkVenue('coinbase', { weight: 1.0, maxLevels: 50 }),
  kraken: mkVenue('kraken', { weight: 0.8, maxLevels: 10 }),
  bitstamp: mkVenue('bitstamp', { weight: 0.5, maxLevels: 100 })
};
const VENUE_LIST = () => Object.values(VENUES);

function bookApply(v, side, price, size, ts) {
  const m = side === 'bid' ? v.book.bids : v.book.asks;
  if (!(size > 0)) m.delete(price); else m.set(price, [size, ts || Date.now()]);
  /* A FIXED-DEPTH feed (Kraken depth=10) only ever describes its top N
     levels. Levels that fall out of the top N are not always explicitly
     removed, so they accumulate — and eventually a stale bid sits above
     the live ask. bookRecompute rejects crossed books, so the venue's
     quote then freezes FOREVER and silently drops out of the index.
     Observed in production: Kraken quote 138 s stale while the socket was
     still delivering 2,160 messages. Truncate to the feed's real depth. */
  const cap = (v.cfg && v.cfg.maxLevels) || 200;
  if (m.size > cap * 2) {
    // Drop the STALEST levels, not the worst-priced ones.
    const keys = [...m.entries()].sort((a, b) => b[1][1] - a[1][1]).map(e => e[0]);
    for (const k of keys.slice(cap)) m.delete(k);
  }
}
function bookRecompute(v, now) {
  let bb = NaN, ba = NaN;
  for (const p of v.book.bids.keys()) if (!(p <= bb)) bb = p;
  for (const p of v.book.asks.keys()) if (!(p >= ba)) ba = p;
  if (!Number.isFinite(bb) || !Number.isFinite(ba)) return;
  /* On a fixed-depth feed a level that falls out of the top N is not always
     explicitly removed. Price-based truncation alone cannot fix this: it
     keeps the HIGHEST bids, which are exactly the stale ones after a move
     down. Evict by RECENCY — when the book is crossed, the side carrying
     the older timestamps is the stale one. */
  let guard = 0;
  while (ba <= bb && guard++ < 200) {
    const bAge = (v.book.bids.get(bb) || [0, 0])[1];
    const aAge = (v.book.asks.get(ba) || [0, 0])[1];
    if (bAge <= aAge) { v.book.bids.delete(bb); bb = NaN; for (const p of v.book.bids.keys()) if (!(p <= bb)) bb = p; }
    else { v.book.asks.delete(ba); ba = NaN; for (const p of v.book.asks.keys()) if (!(p >= ba)) ba = p; }
    if (!Number.isFinite(bb) || !Number.isFinite(ba)) return;
    v.staleLevelsEvicted = (v.staleLevelsEvicted || 0) + 1;
  }
  if (ba <= bb) {
    /* Reject the tick, and if it stays crossed, throw the book away so the
       next snapshot can rebuild it rather than freezing indefinitely. */
    v.crossedSince = v.crossedSince || now;
    if (now - v.crossedSince > 3000) {
      v.book.bids.clear(); v.book.asks.clear();
      v.crossedSince = 0; v.bookResets = (v.bookResets || 0) + 1;
      v.lastError = 'book crossed >3s, cleared for rebuild'; v.lastErrorTs = now;
      try { if (v.ws && v.ws.close) v.ws.close(); } catch (_) { }   // force a fresh snapshot
    }
    return;
  }
  v.crossedSince = 0;
  const mid = (bb + ba) / 2;
  const band = mid * BAND_FRAC;
  let bd = 0, ad = 0;
  for (const [p, e] of v.book.bids) if (mid - p <= band && p <= mid) bd += e[0];
  for (const [p, e] of v.book.asks) if (p - mid <= band && p >= mid) ad += e[0];
  v.bid = bb; v.ask = ba; v.mid = mid; v.bidDepth = bd; v.askDepth = ad; v.lastQuoteTs = now;
}
function setTopOfBook(v, bb, ba, now) {
  if (!Number.isFinite(bb) || !Number.isFinite(ba) || ba <= bb) return;
  v.bid = bb; v.ask = ba; v.mid = (bb + ba) / 2; v.lastQuoteTs = now;
}
function pushTrade(v, localTs, signedNotional, price) {
  v.trades.push([localTs, signedNotional, price]);
  const cut = localTs - 120000;
  while (v.trades.length && v.trades[0][0] < cut) v.trades.shift();
  if (v.trades.length > 6000) v.trades.splice(0, v.trades.length - 6000);
}

/* ------------------------------- adapters ------------------------------- */
const ADAPTERS = {
  coinbase: {
    url: 'wss://ws-feed.exchange.coinbase.com',
    sub: { type: 'subscribe', product_ids: ['BTC-USD'], channels: ['ticker', 'matches', 'level2_batch'] },
    onMsg(v, j, now) {
      if (j.type === 'ticker') {
        const bb = Number(j.best_bid), ba = Number(j.best_ask);
        setTopOfBook(v, bb, ba, now);
        const ets = Date.parse(j.time); if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
        return true;
      }
      if (j.type === 'match' || j.type === 'last_match') {
        const p = Number(j.price), s = Number(j.size);
        if (Number.isFinite(p) && Number.isFinite(s)) {
          // Coinbase `side` is the MAKER side. maker=sell => taker bought => +.
          const sign = j.side === 'sell' ? 1 : -1;
          const ets = Date.parse(j.time);
          if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
          pushTrade(v, now, sign * p * s, p);
        }
        return true;
      }
      if (j.type === 'snapshot') {
        v.book.bids.clear(); v.book.asks.clear();
        for (const [p, s] of (j.bids || [])) bookApply(v, 'bid', Number(p), Number(s), now);
        for (const [p, s] of (j.asks || [])) bookApply(v, 'ask', Number(p), Number(s), now);
        bookRecompute(v, now); return true;
      }
      if (j.type === 'l2update') {
        for (const ch of (j.changes || [])) {
          const side = ch[0] === 'buy' ? 'bid' : 'ask';
          bookApply(v, side, Number(ch[1]), Number(ch[2]), now);
        }
        bookRecompute(v, now); return true;
      }
      if (j.type === 'error') { v.lastError = String(j.message || 'feed error'); v.lastErrorTs = now; }
      return false;
    }
  },
  kraken: {
    url: 'wss://ws.kraken.com/v2',
    sub: { method: 'subscribe', params: { channel: 'book', symbol: ['BTC/USD'], depth: 10 } },
    sub2: { method: 'subscribe', params: { channel: 'trade', symbol: ['BTC/USD'] } },
    /* Independent of the delta book: a direct quote on every BBO change,
       so a book-state problem can never freeze this venue's price. */
    sub3: { method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'], event_trigger: 'bbo' } },
    onMsg(v, j, now) {
      if (j.channel === 'book' && Array.isArray(j.data)) {
        const d = j.data[0]; if (!d) return false;
        if (j.type === 'snapshot') { v.book.bids.clear(); v.book.asks.clear(); }
        for (const b of (d.bids || [])) bookApply(v, 'bid', Number(b.price), Number(b.qty), now);
        for (const a of (d.asks || [])) bookApply(v, 'ask', Number(a.price), Number(a.qty), now);
        bookRecompute(v, now);
        const ets = Date.parse(d.timestamp); if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
        return true;
      }
      if (j.channel === 'trade' && Array.isArray(j.data)) {
        for (const t of j.data) {
          const p = Number(t.price), q = Number(t.qty);
          if (!Number.isFinite(p) || !Number.isFinite(q)) continue;
          const ets = Date.parse(t.timestamp);
          if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
          pushTrade(v, now, (t.side === 'buy' ? 1 : -1) * p * q, p);
        }
        return true;
      }
      if (j.channel === 'ticker' && Array.isArray(j.data) && j.data[0]) {
        const t = j.data[0];
        setTopOfBook(v, Number(t.bid), Number(t.ask), now);
        return true;
      }
      if (j.channel === 'heartbeat') return true;
      return false;
    }
  },
  bitstamp: {
    url: 'wss://ws.bitstamp.net',
    sub: { event: 'bts:subscribe', data: { channel: 'order_book_btcusd' } },
    sub2: { event: 'bts:subscribe', data: { channel: 'live_trades_btcusd' } },
    onMsg(v, j, now) {
      if (j.event === 'data' && j.data && Array.isArray(j.data.bids)) {
        v.book.bids.clear(); v.book.asks.clear();
        for (const [p, s] of j.data.bids) bookApply(v, 'bid', Number(p), Number(s), now);
        for (const [p, s] of j.data.asks) bookApply(v, 'ask', Number(p), Number(s), now);
        bookRecompute(v, now);
        const ets = Math.round(Number(j.data.microtimestamp) / 1000);
        if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
        return true;
      }
      if (j.event === 'trade' && j.data) {
        const p = Number(j.data.price), q = Number(j.data.amount);
        if (Number.isFinite(p) && Number.isFinite(q)) {
          const ets = Math.round(Number(j.data.microtimestamp) / 1000);
          if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
          // Bitstamp type: 0 = buy (taker bought), 1 = sell
          pushTrade(v, now, (Number(j.data.type) === 0 ? 1 : -1) * p * q, p);
        }
        return true;
      }
      if (j.event === 'bts:request_reconnect') { scheduleReconnect(v, 'server asked'); return true; }
      return false;
    }
  }
};

function connectVenue(name) {
  const v = VENUES[name], a = ADAPTERS[name];
  if (!v || !a) return;
  if (!ENABLE_WS || !WS_AVAILABLE) { v.state = 'disabled'; return; }
  if (v.state === 'connecting' || v.state === 'open') return;
  v.state = 'connecting';
  let ws;
  try { ws = new WSImpl(a.url); } catch (e) { v.lastError = String(e.message || e); v.lastErrorTs = Date.now(); return scheduleReconnect(v, 'ctor'); }
  v.ws = ws;
  const onOpen = () => {
    v.state = 'open'; v.backoffMs = 500; v.lastMsgTs = Date.now(); v.lastError = null;
    try { ws.send(JSON.stringify(a.sub)); if (a.sub2) ws.send(JSON.stringify(a.sub2)); if (a.sub3) ws.send(JSON.stringify(a.sub3)); } catch (_) { }
    armWatchdog(v);
  };
  const onMessage = (ev) => {
    const now = Date.now(); v.lastMsgTs = now; v.msgCount++;
    let j; try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (_) { return; }
    try { a.onMsg(v, j, now); } catch (e) { v.lastError = String(e.message || e); v.lastErrorTs = now; }
  };
  const onClose = () => { v.state = 'closed'; scheduleReconnect(v, 'close'); };
  const onError = (e) => { v.lastError = String((e && (e.message || e.error)) || 'ws error'); v.lastErrorTs = Date.now(); };
  if (ws.on) { ws.on('open', onOpen); ws.on('message', d => onMessage({ data: d })); ws.on('close', onClose); ws.on('error', onError); }
  else { ws.onopen = onOpen; ws.onmessage = onMessage; ws.onclose = onClose; ws.onerror = onError; }
}
function scheduleReconnect(v, why) {
  if (v.connectTimer) return;
  v.reconnects++;
  const jitter = Math.random() * 0.4 + 0.8;
  const wait = Math.min(20000, Math.round(v.backoffMs * jitter));
  v.backoffMs = Math.min(20000, v.backoffMs * 2);
  v.connectTimer = setTimeout(() => { v.connectTimer = null; try { if (v.ws && v.ws.close) v.ws.close(); } catch (_) { } connectVenue(v.name); }, wait);
  if (v.connectTimer.unref) v.connectTimer.unref();
}
function armWatchdog(v) {
  if (v.watchdog) clearInterval(v.watchdog);
  v.watchdog = setInterval(() => {
    const silent = Date.now() - v.lastMsgTs;
    if (silent > 15000 && v.state === 'open') {
      v.lastError = 'watchdog: ' + silent + 'ms silence'; v.lastErrorTs = Date.now();
      v.state = 'closed'; try { v.ws.close(); } catch (_) { } scheduleReconnect(v, 'watchdog');
    }
  }, 5000);
  if (v.watchdog.unref) v.watchdog.unref();
}

/* =====================================================================
   BRTI-PROXY INDEX
   Kalshi settles on CF Benchmarks BRTI: a constituent-weighted,
   time-weighted consensus across regulated USD venues. We cannot license
   the real feed, so we reconstruct a proxy from the same constituent
   family (Coinbase / Kraken / Bitstamp are all BRTI constituents and are
   all reachable from US hosts; Binance is not — it 451s).

   Robustness rules, in order:
     - a venue must be fresh (quote age <= VENUE_STALE_MS)
     - a venue must not be an outlier (>OUTLIER_BPS from the median)
     - we need >= MIN_INDEX_VENUES survivors or the index is NOT PUBLISHED
   The index is then sampled at 1 Hz into a 120 s ring, mirroring the
   real BRTI's one-print-per-second cadence, which is the cadence the
   settlement average is actually computed over.
   ===================================================================== */
const IDX = {
  value: NaN, ts: 0, venuesUsed: [], venuesRejected: [], dispersionBps: null,
  ring: [],                 // [tsMs, value] at ~1 Hz
  sampler: null, lastSampleTs: 0, publishFails: 0, lastReason: null
};
function venueFresh(v, now) {
  if (!Number.isFinite(v.mid) || !(v.lastQuoteTs > 0)) return false;
  const quoteAge = now - v.lastQuoteTs;
  if (quoteAge <= VENUE_STALE_MS) return true;
  // Quiet book: the socket is still alive (heartbeats/other channels) and
  // the last quote is recent enough to still describe the market.
  const socketAge = v.lastMsgTs ? now - v.lastMsgTs : Infinity;
  return socketAge <= VENUE_SILENT_MS && quoteAge <= VENUE_QUOTE_MAX_MS;
}
function venueQuoteAge(v, now) { return v.lastQuoteTs ? now - v.lastQuoteTs : null; }
function computeIndex(now = Date.now()) {
  const live = VENUE_LIST().filter(v => venueFresh(v, now));
  if (live.length === 0) { IDX.lastReason = 'no live venue'; return null; }
  const mids = live.map(v => v.mid);
  const med = median(mids);
  const kept = [], rejected = [];
  for (const v of live) {
    const bps = Math.abs(v.mid - med) / med * 1e4;
    if (bps > OUTLIER_BPS) rejected.push({ venue: v.name, mid: round(v.mid, 2), bps: round(bps, 1) });
    else kept.push(v);
  }
  if (kept.length < MIN_INDEX_VENUES) {
    // Degenerate case: exactly one venue alive. We still publish, but the
    // quality block will mark it single-source so the UI cannot show green.
    if (kept.length === 1 && live.length === 1) {
      IDX.lastReason = 'single venue';
      return { value: kept[0].mid, used: [kept[0].name], rejected, dispersionBps: 0, single: true };
    }
    IDX.lastReason = 'quorum ' + kept.length + '/' + MIN_INDEX_VENUES;
    return null;
  }
  // Liquidity-weighted: configured constituent weight x near-touch depth.
  let wsum = 0, acc = 0;
  for (const v of kept) {
    const depth = (v.bidDepth + v.askDepth) || 0;
    const w = v.cfg.weight * (1 + Math.log1p(Math.max(0, depth)));
    wsum += w; acc += w * v.mid;
  }
  const value = wsum > 0 ? acc / wsum : median(kept.map(v => v.mid));
  const spread = Math.max(...kept.map(v => v.mid)) - Math.min(...kept.map(v => v.mid));
  return { value, used: kept.map(v => v.name), rejected, dispersionBps: value ? (spread / value) * 1e4 : 0, single: false };
}
function sampleIndex() {
  const now = Date.now();
  const r = computeIndex(now);
  if (!r) { IDX.publishFails++; return; }
  IDX.value = r.value; IDX.ts = now; IDX.venuesUsed = r.used; IDX.venuesRejected = r.rejected;
  IDX.dispersionBps = round(r.dispersionBps, 2); IDX.single = !!r.single; IDX.publishFails = 0;
  IDX.ring.push([now, r.value]);
  const cut = now - 130000;
  while (IDX.ring.length && IDX.ring[0][0] < cut) IDX.ring.shift();
  IDX.lastSampleTs = now;
}
function startSampler() {
  if (IDX.sampler) return;
  IDX.sampler = setInterval(sampleIndex, 1000);
  if (IDX.sampler.unref) IDX.sampler.unref();
  sampleIndex();
}
/* Trailing mean of the index over the last `sec` seconds. */
function trailingMean(sec, now = Date.now()) {
  const cut = now - sec * 1000;
  const pts = IDX.ring.filter(p => p[0] >= cut);
  if (!pts.length) return { mean: NaN, n: 0, coverSec: 0 };
  const mean = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return { mean, n: pts.length, coverSec: round((now - pts[0][0]) / 1000, 1) };
}
/* Realised vol of the index, bps per sqrt(second), from the 1 Hz ring. */
function indexVolBpsPerRootSec(lookbackSec = 120) {
  const now = Date.now(), cut = now - lookbackSec * 1000;
  const pts = IDX.ring.filter(p => p[0] >= cut);
  if (pts.length < 10) return null;
  const rets = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0.25, (pts[i][0] - pts[i - 1][0]) / 1000);
    if (pts[i - 1][1] <= 0) continue;
    const r = (pts[i][1] - pts[i - 1][1]) / pts[i - 1][1] * 1e4 / Math.sqrt(dt);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 8) return null;
  /* Use the UNCENTERED second moment (RMS), not the demeaned stdev.
     A smooth directional ramp has near-zero demeaned variance — in fault
     testing a $400/60s slide measured 0.43 bps/root-s demeaned vs 0.61
     RMS. Demeaning would let the single most dangerous market state (a
     fast one-way grind into the strike) read as low risk. The drift term
     is separately damped, so RMS here is the conservative choice: the
     trend shows up as uncertainty rather than as a confident forecast. */
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1));
  const rms = Math.sqrt(rets.reduce((a, b) => a + b * b, 0) / rets.length);
  const est = Math.max(sd, rms);
  /* Shrink toward the prior by sample size. Never let a short or quiet
     window manufacture false confidence. */
  const w = rets.length / (rets.length + VOL_SHRINK_N);
  return clamp(w * est + (1 - w) * VOL_PRIOR, 0.15, 8);
}
/* True when the ring is long enough for the vol estimate to stand on its
   own rather than mostly on the prior. */
function volWarm() { return IDX.ring.length >= VOL_MIN_SAMPLES; }
/* Drift of the index, bps per second, half-life weighted. */
function indexDriftBpsPerSec(lookbackSec = 90) {
  const now = Date.now(), cut = now - lookbackSec * 1000;
  const pts = IDX.ring.filter(p => p[0] >= cut);
  if (pts.length < 6) return 0;
  const HL = 25; let num = 0, den = 0; const t1 = pts[pts.length - 1][0];
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0.25, (pts[i][0] - pts[i - 1][0]) / 1000);
    if (pts[i - 1][1] <= 0) continue;
    const r = (pts[i][1] - pts[i - 1][1]) / pts[i - 1][1] * 1e4 / dt;
    const w = Math.pow(0.5, ((t1 - pts[i][0]) / 1000) / HL);
    if (Number.isFinite(r)) { num += w * r; den += w; }
  }
  return den ? clamp(num / den, -6, 6) : 0;
}

/* =====================================================================
   SETTLEMENT GEOMETRY  — the core accuracy fix.

   Kalshi KXBTC15M rules_primary, read verbatim off the live market:
     "If the simple average of the sixty seconds of CF Benchmarks' BRTI
      before <close> is at least the simple average of the sixty seconds
      of BRTI before <open>, then the market resolves to Yes."

   So the settled quantity is S = mean of BRTI over the final 60 s,
   NOT the spot print at the close. Modelling S as a point estimate of
   spot is a specification error that gets worse as tau shrinks.

   Let tau = seconds to close, W = 60 s averaging window, sigma =
   per-sqrt-second vol of the index (bps).

   Case tau >= W  (averaging window entirely in the future):
     S = X0 + (1/W) * integral of the driftless increment over [tau-W, tau]
     Var[S] = sigma^2 * (tau - W + W/3)          <-- "effective tau"
     At W=60: effective tau = tau - 40.
     tau=900 -> 860 (negligible). tau=60 -> 20, i.e. sigma_eff = 0.58x spot.

   Case tau < W  (part of the averaging window has already printed):
     A known block of (W - tau) seconds is already locked in memory.
     E[S]   = (knownMean*(W-tau) + X0*tau) / W
     Var[S] = sigma^2 * tau^3 / (3 * W^2)
     tau=30 -> 2.5 sigma^2 vs 30 sigma^2 for spot: sigma_eff = 0.29x.
     tau=10 -> 0.093 sigma^2 vs 10:            sigma_eff = 0.10x.

   Consequence: in the last minute the old model screams RED on spot
   geometry when the settlement average is already largely locked and
   physically cannot reach the strike. It also under-warns in the mirror
   case, where the running average is already the wrong side of the
   strike and spot looks fine.
   ===================================================================== */
function settlementGeometry({ indexNow, strike, tau, sigmaBpsRootSec, driftBpsSec, strikeType }) {
  const W = SETTLE_WINDOW_SEC;
  if (!Number.isFinite(indexNow) || !Number.isFinite(strike) || !Number.isFinite(tau)) return null;
  const sigma = Number.isFinite(sigmaBpsRootSec) ? sigmaBpsRootSec : 0.45;
  const drift = Number.isFinite(driftBpsSec) ? driftBpsSec : 0;
  const t = Math.max(0, tau);

  /* Drift projection is DAMPED. A drift measured over ~90 s carries no
     predictive power at a 13-minute horizon — BTC is close to a
     martingale over a 15-minute window. Projecting it linearly produced
     an expected settlement $788 away from spot in live testing, which is
     nonsense. We therefore project over an effective horizon capped at
     DRIFT_HORIZON_SEC and shrink by DRIFT_SHRINK. */
  const effHorizon = h => Math.min(Math.max(0, h), DRIFT_HORIZON_SEC) * DRIFT_SHRINK;

  let expectedBps, varUnits, knownMean = null, lockedFrac = 0, coverage = null;
  if (t >= W) {
    // whole averaging window still ahead of us
    const centre = t - W / 2;                       // mean time of the window
    expectedBps = drift * effHorizon(centre);       // damped drift to window centre
    varUnits = Math.max(1e-6, t - W + W / 3);
  } else {
    const tm = trailingMean(W - t);
    knownMean = tm.mean; coverage = tm;
    lockedFrac = (W - t) / W;
    if (!Number.isFinite(knownMean) || tm.n < 3) {
      // We do not have the locked block. Fall back to the >=W formula
      // rather than inventing it. Flagged to the caller.
      expectedBps = drift * effHorizon(Math.max(0, t - W / 2));
      varUnits = Math.max(1e-6, t * t * t / (3 * W * W));
      knownMean = null;
    } else {
      varUnits = Math.max(1e-6, t * t * t / (3 * W * W));
      expectedBps = drift * effHorizon(t / 2) * (t / W);   // future block's damped drift
    }
  }
  const sigmaSettleBps = sigma * Math.sqrt(varUnits);

  // Expected settlement level in price terms
  let expSettle;
  if (knownMean != null) expSettle = (knownMean * (W - t) + indexNow * t) / W;
  else expSettle = indexNow;
  expSettle = expSettle * (1 + expectedBps / 1e4);

  const gapUsd = expSettle - strike;
  const gapBps = strike ? (gapUsd / strike) * 1e4 : NaN;

  // sigmas of cushion measured on the SETTLEMENT variable
  const sigmasOfCushion = sigmaSettleBps > 0 ? Math.abs(gapBps) / sigmaSettleBps : null;

  // P(settle lands on the adverse side). strike_type greater_or_equal:
  // YES wins if S >= strike.
  const z = sigmaSettleBps > 0 ? gapBps / sigmaSettleBps : (gapBps > 0 ? 9 : -9);
  /* v2.1: the standardised residual is NOT Gaussian. It is a power law
     with tail index ~2.5 (see SETTLE_TAIL_A/B). normCdf() here is what
     turned an 11.75-sigma reading into "cushion healthy" on a cushion
     that was $8.02 wide. Clamp floor widened from 0.01 to P_CLAMP_LO so
     the final minute keeps resolution between a thin and a fat cushion. */
  const pAbove = clamp(settleTailCdf(z), P_CLAMP_LO, 1 - P_CLAMP_LO);
  const pAboveGaussian = clamp(normCdf(z), 0.0001, 0.9999);   // retained for A/B only

  // Spot-only comparison, i.e. what 1.5 was implicitly computing.
  const sigmaSpotBps = sigma * Math.sqrt(Math.max(1, t));
  const spotGapBps = strike ? ((indexNow - strike) / strike) * 1e4 : NaN;
  const spotSigmas = sigmaSpotBps > 0 ? Math.abs(spotGapBps) / sigmaSpotBps : null;

  return {
    model: 'settlement-avg-' + W + 's',
    tau: round(t, 1), lockedFrac: round(lockedFrac, 3),
    knownMean: knownMean == null ? null : round(knownMean, 2),
    knownCoverSec: coverage ? coverage.coverSec : null,
    knownSamples: coverage ? coverage.n : null,
    expectedSettle: round(expSettle, 2),
    gapUsd: round(gapUsd, 2), gapBps: round(gapBps, 2),
    sigmaSettleBps: round(sigmaSettleBps, 3),
    /* sigmasOfCushion is |gap| / sigmaSettle, and sigmaSettle collapses as
       tau^1.5. In the 19:45 PT replay it read 9.5 at tau=15, 117 at tau=1
       and 1107 at tau=0 — purely denominator collapse, not safety. It is
       capped for display; the raw value is kept for diagnostics and NOTHING
       downstream may treat it as a probability. Use pAboveStrike. */
    sigmasOfCushion: sigmasOfCushion == null ? null : round(Math.min(sigmasOfCushion, 99), 3),
    sigmasOfCushionRaw: sigmasOfCushion == null ? null : round(sigmasOfCushion, 3),
    cushionUsd: round(Math.abs(gapUsd), 2),
    /* The physically meaningful quantity: every remaining second carries
       1/W of the settlement average, so flipping a $C cushion with t
       seconds unlocked needs the index to average C*W/t away from here. */
    requiredIndexMoveUsd: round(t > 0 && t < W ? Math.abs(gapUsd) * W / t : Math.abs(gapUsd), 2),
    pAboveStrike: round(pAbove, 4),
    pAboveStrikeGaussian: round(pAboveGaussian, 6),
    strikeType: strikeType || 'greater_or_equal',
    varianceRatioVsSpot: round(varUnits / Math.max(1, t), 4),
    spotCompare: {
      spotGapBps: round(spotGapBps, 2),
      sigmaSpotBps: round(sigmaSpotBps, 3),
      spotSigmasOfCushion: spotSigmas == null ? null : round(spotSigmas, 3)
    }
  };
}

/* =====================================================================
   KALSHI
   REST at 1 Hz against series_ticker (the old broad query returned zero
   BTC markets in production). WS is wired but gated on credentials
   because an unauthenticated handshake is rejected with HTTP 401.
   ===================================================================== */
const KAL = {
  market: null, ts: 0, err: null, consecutiveFails: 0, timer: null,
  ob: null, obTs: 0, lastLatencyMs: null, rateLimited: false, rateLimitedUntil: 0,
  wsState: KALSHI_HAVE_CREDS ? 'init' : 'no-credentials', wsMsgs: 0,
  wsSubscribedTicker: null, wsResubscribes: 0, wsLastError: null
};
function pickNum(m, ...keys) { for (const k of keys) { const n = Number(m && m[k]); if (Number.isFinite(n)) return n; } return NaN; }
function parseKalshiMarket(m) {
  if (!m) return null;
  const closeMs = Date.parse(m.close_time);
  const openMs = Date.parse(m.open_time);
  const strike = pickNum(m, 'floor_strike', 'cap_strike', 'strike');
  // *_dollars are strings in dollars; legacy *_bid/*_ask (cents) may not exist.
  const yb = pickNum(m, 'yes_bid_dollars') * 100, ya = pickNum(m, 'yes_ask_dollars') * 100;
  const yesBid = Number.isFinite(yb) ? yb : pickNum(m, 'yes_bid');
  const yesAsk = Number.isFinite(ya) ? ya : pickNum(m, 'yes_ask');
  const last = pickNum(m, 'last_price_dollars') * 100;
  return {
    ticker: m.ticker, title: m.title || m.yes_sub_title || '',
    strike: Number.isFinite(strike) ? strike : NaN,
    strikeType: m.strike_type || 'greater_or_equal',
    closeMs: Number.isFinite(closeMs) ? closeMs : NaN,
    openMs: Number.isFinite(openMs) ? openMs : NaN,
    status: String(m.status || ''),
    yesBid, yesAsk, lastPrice: Number.isFinite(last) ? last : NaN,
    yesBidSize: pickNum(m, 'yes_bid_size_fp', 'yes_bid_size'),
    yesAskSize: pickNum(m, 'yes_ask_size_fp', 'yes_ask_size'),
    rules: String(m.rules_primary || '').slice(0, 400)
  };
}
/* Pick the market whose window CONTAINS now, not merely the soonest close.
   The 1.5 code sorted by a close_ts field that does not exist. */
function chooseMarket(markets, now) {
  const parsed = markets.map(parseKalshiMarket).filter(m => m && Number.isFinite(m.closeMs));
  const future = parsed.filter(m => m.closeMs > now);
  if (!future.length) return null;
  future.sort((a, b) => a.closeMs - b.closeMs);
  // A window is tradeable once it has opened AND its strike is set (the
  // strike IS the opening 60 s index average, so it does not exist before
  // the open). Prefer that; otherwise hand back the next upcoming window
  // so the countdown still works, flagged as not-yet-priced.
  const tradeable = future.filter(m => (!Number.isFinite(m.openMs) || m.openMs <= now) && Number.isFinite(m.strike));
  return tradeable.length ? tradeable[0] : future[0];
}
async function kalshiPollOnce() {
  const now = Date.now();
  if (KAL.rateLimited && now < KAL.rateLimitedUntil) return;
  const t0 = Date.now();
  try {
    /* `status=open` returns ONLY the single currently-active window, so at
       every 15-minute rollover it briefly returns nothing and the radar
       goes blind (observed: 24 s of STALE in a live calibration run).
       Upcoming windows carry status=initialized. A bounded close_ts query
       with no status filter returns the active window AND the next one. */
    const nowSec = Math.floor(Date.now() / 1000);
    const mj = await fetchJson(`${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(KALSHI_SERIES)}&min_close_ts=${nowSec}&max_close_ts=${nowSec + 1800}&limit=20`, {}, 3500);
    const mk = chooseMarket(Array.isArray(mj.markets) ? mj.markets : [], Date.now());
    if (!mk) throw new Error('no open ' + KALSHI_SERIES + ' market');
    // Fetch the book only if we changed market or the book is >1.5 s old.
    let needBook = !KAL.ob || KAL.ob.ticker !== mk.ticker || (Date.now() - KAL.obTs) > 1500;
    if (needBook) {
      const ob = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(mk.ticker)}/orderbook?depth=20`, {}, 3000).catch(() => null);
      if (ob) { KAL.ob = normaliseOrderbook(ob, mk.ticker); KAL.obTs = Date.now(); }
    }
    KAL.market = mk; KAL.ts = Date.now(); KAL.err = null; KAL.consecutiveFails = 0;
    kalshiWsSync();
    KAL.rateLimited = false; KAL.lastLatencyMs = Date.now() - t0;
  } catch (e) {
    const msg = String(e.message || e);
    KAL.err = msg; KAL.consecutiveFails++;
    if (/429/.test(msg)) { KAL.rateLimited = true; KAL.rateLimitedUntil = Date.now() + 5000; }
    KAL.lastLatencyMs = Date.now() - t0;
  }
}
function normaliseOrderbook(ob, ticker) {
  const fp = ob && ob.orderbook_fp;
  const src = fp || (ob && ob.orderbook) || null;
  const norm = a => (Array.isArray(a) ? a : [])
    .filter(x => Array.isArray(x) && x.length >= 2)
    .map(x => [Number(x[0]) * (fp ? 100 : 1), Number(x[1])])
    .filter(x => Number.isFinite(x[0]) && x[0] > 0 && x[0] < 100 && Number.isFinite(x[1]));
  const yes = src ? norm(fp ? src.yes_dollars : src.yes) : [];
  const no = src ? norm(fp ? src.no_dollars : src.no) : [];
  const bestYes = yes.length ? Math.max(...yes.map(x => x[0])) : NaN;
  const bestNo = no.length ? Math.max(...no.map(x => x[0])) : NaN;
  // Near-touch depth (within 5c of the touch) is the tradeable signal.
  // Summing 20 raw levels lets far resting size dominate, which is what
  // 1.5 did and why the kalshi component was noise.
  const nearYes = yes.filter(x => bestYes - x[0] <= 5).reduce((a, x) => a + x[1], 0);
  const nearNo = no.filter(x => bestNo - x[0] <= 5).reduce((a, x) => a + x[1], 0);
  const yesDepth = yes.reduce((a, x) => a + x[1], 0);
  const noDepth = no.reduce((a, x) => a + x[1], 0);
  const denom = nearYes + nearNo;
  return {
    ticker, yes, no, bestYes, bestNo,
    yesDepth: round(yesDepth, 0), noDepth: round(noDepth, 0),
    nearYesDepth: round(nearYes, 0), nearNoDepth: round(nearNo, 0),
    bookImbalance: denom > 0 ? round((nearYes - nearNo) / denom, 3) : 0,
    wideBookImbalance: (yesDepth + noDepth) > 0 ? round((yesDepth - noDepth) / (yesDepth + noDepth), 3) : 0
  };
}
function kalshiContext() {
  const now = Date.now();
  const m = KAL.market;
  if (!m) return { ok: false, error: KAL.err || 'not polled yet', ageMs: null };
  const ageMs = now - KAL.ts;
  const pending = !Number.isFinite(m.strike);
  const ob = (KAL.ob && KAL.ob.ticker === m.ticker) ? KAL.ob : null;
  const yesBid = ob && Number.isFinite(ob.bestYes) ? ob.bestYes : m.yesBid;
  const yesAsk = ob && Number.isFinite(ob.bestNo) ? (100 - ob.bestNo) : m.yesAsk;
  const implied = (Number.isFinite(yesBid) && Number.isFinite(yesAsk)) ? (yesBid + yesAsk) / 200 : NaN;
  const secondsToClose = Number.isFinite(m.closeMs) ? Math.max(0, (m.closeMs - now) / 1000) : NaN;
  return {
    ok: ageMs <= KALSHI_STALE_MS,
    stale: ageMs > KALSHI_STALE_MS,
    pending,
    error: ageMs > KALSHI_STALE_MS ? ('stale ' + ageMs + 'ms: ' + (KAL.err || 'no refresh'))
      : (pending ? ('window ' + m.ticker + ' opens in '
          + Math.max(0, Math.round((m.openMs - now) / 1000)) + 's — strike is not set until then') : null),
    ticker: m.ticker, title: m.title, strike: m.strike, strikeType: m.strikeType,
    closeMs: m.closeMs, openMs: m.openMs, secondsToClose: round(secondsToClose, 1),
    yesBid, yesAsk, lastPrice: m.lastPrice,
    impliedAbove: Number.isFinite(implied) ? round(implied, 4) : null,
    bookImbalance: ob ? ob.bookImbalance : 0,
    wideBookImbalance: ob ? ob.wideBookImbalance : 0,
    nearYesDepth: ob ? ob.nearYesDepth : null, nearNoDepth: ob ? ob.nearNoDepth : null,
    yesDepth: ob ? ob.yesDepth : null, noDepth: ob ? ob.noDepth : null,
    obAgeMs: KAL.obTs ? now - KAL.obTs : null,
    ageMs, latencyMs: KAL.lastLatencyMs, rateLimited: KAL.rateLimited,
    rules: m.rules
  };
}
function startKalshi() {
  if (KAL.timer) return;
  kalshiPollOnce();
  KAL.timer = setInterval(kalshiPollOnce, 1000);
  if (KAL.timer.unref) KAL.timer.unref();
  if (KALSHI_HAVE_CREDS && ENABLE_WS && WS_AVAILABLE) startKalshiWs();
}
/* Kalshi WS: RSA-PSS SHA256 over timestamp + "GET" + path, sent as
   handshake headers. Only reachable with credentials. */
let KALSHI_SIGNING_KEY = null;
function kalshiAuthHeaders(path) {
  if (!KALSHI_SIGNING_KEY) KALSHI_SIGNING_KEY = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
  const ts = String(Date.now());
  const msg = ts + 'GET' + path;
  const sig = crypto.sign('sha256', Buffer.from(msg), {
    key: KALSHI_SIGNING_KEY, padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
  }).toString('base64');
  return { 'KALSHI-ACCESS-KEY': KALSHI_KEY_ID, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts };
}
/* Proves signing works end to end without revealing anything. */
function kalshiSelfSignCheck() {
  if (!KALSHI_HAVE_CREDS) return { ok: false, error: KALSHI_KEY_INFO.error || 'no credentials' };
  try {
    const ts = String(Date.now());
    const msg = ts + 'GET' + '/trade-api/ws/v2';
    const key = crypto.createPrivateKey(KALSHI_PRIVATE_KEY);
    const sig = crypto.sign('sha256', Buffer.from(msg), {
      key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    });
    const verified = crypto.verify('sha256', Buffer.from(msg), {
      key: crypto.createPublicKey(key), padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    }, sig);
    return { ok: verified, signatureBytes: sig.length, error: verified ? null : 'signature failed self-verification' };
  } catch (e) { return { ok: false, error: redact(e) }; }
}
let kalshiWs = null, kalshiWsBackoff = 1000, kalshiWsMsgId = 0;
function startKalshiWs() {
  if (!KALSHI_HAVE_CREDS) { KAL.wsState = 'no-credentials'; return; }
  let headers;
  try { headers = kalshiAuthHeaders('/trade-api/ws/v2'); }
  catch (e) { KAL.wsState = 'bad-key'; KAL.wsLastError = redact(e); return; }
  KAL.wsState = 'connecting';
  let ws;
  try {
    // Header injection on the upgrade needs the `ws` package; the WHATWG
    // global cannot set request headers.
    const NodeWs = (WSImpl && WSImpl.Server) ? WSImpl : (() => { try { return require('ws'); } catch (_) { return null; } })();
    if (!NodeWs) { KAL.wsState = 'needs-ws-package'; return; }
    ws = new NodeWs(KALSHI_WS_URL, { headers });
  } catch (e) { KAL.wsState = 'ctor-failed'; KAL.wsLastError = redact(e); return; }
  kalshiWs = ws;
  ws.on('open', () => {
    KAL.wsState = 'open'; kalshiWsBackoff = 1000; KAL.wsSubscribedTicker = null;
    kalshiWsSync();
  });
  ws.on('message', d => {
    KAL.wsMsgs++;
    try {
      const j = JSON.parse(String(d));
      if (j.type === 'ticker' || j.type === 'ticker_v2') {
        const m = j.msg || {};
        if (KAL.market) {
          const yb = Number(m.yes_bid), ya = Number(m.yes_ask);
          if (Number.isFinite(yb)) KAL.market.yesBid = yb;
          if (Number.isFinite(ya)) KAL.market.yesAsk = ya;
          KAL.ts = Date.now();
        }
      }
    } catch (_) { }
  });
  ws.on('close', () => { KAL.wsState = 'closed'; KAL.wsSubscribedTicker = null; scheduleKalshiWs(); });
  ws.on('error', e => { KAL.wsState = 'error: ' + redact(e); KAL.wsLastError = redact(e); });
  ws.on('unexpected-response', (q, r) => {
    KAL.wsState = 'http-' + r.statusCode;
    KAL.wsLastError = r.statusCode === 401
      ? 'HTTP 401 — Kalshi rejected the signature. Check KALSHI_KEY_ID matches the key, and that server time is correct.'
      : 'HTTP ' + r.statusCode;
  });
}
/* KXBTC15M rolls to a new ticker every 15 minutes. Without this the socket
   stays subscribed to a dead market for the rest of the session. */
function kalshiWsSync() {
  if (!kalshiWs || KAL.wsState !== 'open') return;
  const t = KAL.market && KAL.market.ticker;
  if (!t || t === KAL.wsSubscribedTicker) return;
  try {
    if (KAL.wsSubscribedTicker) {
      kalshiWs.send(JSON.stringify({ id: ++kalshiWsMsgId, cmd: 'unsubscribe',
        params: { channels: ['ticker_v2', 'orderbook_delta', 'trade'], market_tickers: [KAL.wsSubscribedTicker] } }));
    }
    kalshiWs.send(JSON.stringify({ id: ++kalshiWsMsgId, cmd: 'subscribe',
      params: { channels: ['ticker_v2', 'orderbook_delta', 'trade'], market_tickers: [t] } }));
    KAL.wsSubscribedTicker = t; KAL.wsResubscribes++;
  } catch (e) { KAL.wsLastError = redact(e); }
}
function scheduleKalshiWs() {
  const t = setTimeout(() => { kalshiWsBackoff = Math.min(30000, kalshiWsBackoff * 2); startKalshiWs(); }, kalshiWsBackoff);
  if (t.unref) t.unref();
}

/* =====================================================================
   SENTINEL — cross-venue lead/divergence
   In 1.5 the sentinel polled Coinbase and then set perpMid = spotMid = the
   same number, so the basis term was identically zero (15% of the score
   was dead) and the remaining terms were the SAME Coinbase data already
   feeding `flow` — the fusion was double-counting one venue.
   The sentinel now measures things the index cannot: aggressive-flow
   divergence from price, burst intensity, near-touch depth withdrawal,
   and genuine cross-venue basis (leader venue vs index).
   ===================================================================== */
function ewmaZ(alpha) { let m = null, v = null; return { update(x) { if (m === null) { m = x; v = 1e-9; return 0; } const d = x - m; m += alpha * d; v = (1 - alpha) * (v + alpha * d * d); return d / Math.sqrt(Math.max(v, 1e-9)); } }; }
const zToScore = z => clamp(z / 3.5, -1, 1) * 100;
const SENT = {
  z: { div: ewmaZ(0.03), burst: ewmaZ(0.03), basis: ewmaZ(0.03) },
  depthHist: [], basisEwma: null, timer: null, lastCompute: 0, read: { ok: false, error: 'warming up' }
};
function sentSampleDepth() {
  const now = Date.now();
  let bd = 0, ad = 0, n = 0;
  for (const v of VENUE_LIST()) if (venueFresh(v, now) && (v.bidDepth || v.askDepth)) { bd += v.bidDepth; ad += v.askDepth; n++; }
  if (n) { SENT.depthHist.push([now, bd, ad]); }
  const cut = now - 300000;
  while (SENT.depthHist.length && SENT.depthHist[0][0] < cut) SENT.depthHist.shift();
}
function sentCompute() {
  const now = Date.now();
  const alive = VENUE_LIST().filter(v => venueFresh(v, now));
  if (!alive.length || IDX.ring.length < 8) return { ok: false, error: 'warming up', ageSec: 0 };
  // aggregate signed notional over 90 s across all live venues
  let netFlow = 0, burst30 = 0;
  const cut90 = now - 90000, cut30 = now - 30000;
  for (const v of alive) for (let i = v.trades.length - 1; i >= 0; i--) {
    const t = v.trades[i]; if (t[0] < cut90) break;
    netFlow += t[1]; if (t[0] >= cut30) burst30 += Math.abs(t[1]);
  }
  const tm90 = IDX.ring.filter(p => p[0] >= cut90);
  const dPxPct = tm90.length >= 2 && tm90[0][1] ? (tm90[tm90.length - 1][1] - tm90[0][1]) / tm90[0][1] : 0;
  // Money pushed in, net of what the price actually did. Positive = buying
  // pressure that has NOT yet been paid for in price -> leads.
  const div = netFlow / 1e6 - dPxPct * 20000;
  const cvdDiv = zToScore(SENT.z.div.update(div));
  const burst = zToScore(SENT.z.burst.update(burst30 / 1e6));
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] || 1e-6; };
  let bookPull = 0;
  if (SENT.depthHist.length >= 8) {
    let bd = 0, ad = 0; for (const v of alive) { bd += v.bidDepth; ad += v.askDepth; }
    const bidRatio = bd / Math.max(med(SENT.depthHist.map(d => d[1])), 1e-6);
    const askRatio = ad / Math.max(med(SENT.depthHist.map(d => d[2])), 1e-6);
    bookPull = clamp((bidRatio - askRatio) * 100, -100, 100);
  }
  // Real basis: fastest venue (coinbase) vs the consensus index.
  let basisScore = 0, basisUsd = null;
  const lead = VENUES.coinbase;
  if (venueFresh(lead, now) && Number.isFinite(IDX.value)) {
    basisUsd = lead.mid - IDX.value;
    if (SENT.basisEwma === null) SENT.basisEwma = basisUsd;
    SENT.basisEwma += 0.05 * (basisUsd - SENT.basisEwma);
    basisScore = zToScore(SENT.z.basis.update(basisUsd - SENT.basisEwma));
  }
  const pressure = clamp(0.35 * cvdDiv + 0.20 * burst + 0.30 * bookPull + 0.15 * basisScore, -100, 100);
  SENT.lastCompute = now;
  return {
    ok: true, error: null, pressure: Math.round(pressure),
    components: { cvdDiv: Math.round(cvdDiv), burst: Math.round(burst), bookPull: Math.round(bookPull), basis: Math.round(basisScore) },
    basisUsd: basisUsd == null ? null : round(basisUsd, 2),
    leadVenue: 'coinbase', venues: alive.map(v => v.name),
    ageSec: 0
  };
}
function startSentinel() {
  if (SENT.timer) return;
  SENT.timer = setInterval(() => { sentSampleDepth(); SENT.read = sentCompute(); }, 1000);
  if (SENT.timer.unref) SENT.timer.unref();
}

/* =====================================================================
   REST FALLBACK — only runs when the streaming layer is not producing.
   Cheap endpoints only. No 1.1 MB books.
   ===================================================================== */
const REST_VENUES = [
  { name: 'coinbase', url: 'https://api.exchange.coinbase.com/products/BTC-USD/book?level=1', pick: j => { const b = Number(j?.bids?.[0]?.[0]), a = Number(j?.asks?.[0]?.[0]); return (Number.isFinite(b) && Number.isFinite(a) && a > b) ? { bid: b, ask: a } : null; } },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', pick: j => { const r = j?.result; const k = r && Object.keys(r)[0]; const b = Number(r?.[k]?.b?.[0]), a = Number(r?.[k]?.a?.[0]); return (Number.isFinite(b) && Number.isFinite(a) && a > b) ? { bid: b, ask: a } : null; } },
  { name: 'bitstamp', url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/', pick: j => { const b = Number(j?.bid), a = Number(j?.ask); return (Number.isFinite(b) && Number.isFinite(a) && a > b) ? { bid: b, ask: a } : null; } }
];
const RESTF = { timer: null, active: false, lastRun: 0, ok: 0, fail: 0, lastError: null };
function streamingHealthy(now = Date.now()) {
  return VENUE_LIST().filter(v => venueFresh(v, now)).length >= 1;
}
async function restFallbackTick() {
  const now = Date.now();
  if (streamingHealthy(now)) { RESTF.active = false; return; }
  RESTF.active = true; RESTF.lastRun = now;
  await Promise.all(REST_VENUES.map(async rv => {
    try {
      const j = await fetchJson(rv.url, {}, 2500);
      const q = rv.pick(j);
      if (!q) throw new Error('no quote');
      const v = VENUES[rv.name];
      setTopOfBook(v, q.bid, q.ask, Date.now());
      RESTF.ok++;
    } catch (e) { RESTF.fail++; RESTF.lastError = rv.name + ': ' + String(e.message || e); }
  }));
}
function startRestFallback() {
  if (RESTF.timer) return;
  RESTF.timer = setInterval(restFallbackTick, REST_FALLBACK_MS);
  if (RESTF.timer.unref) RESTF.timer.unref();
}

/* =====================================================================
   LEGACY FUSION — preserved verbatim from 1.5 so existing self-tests and
   any downstream consumer keep working. Reported under `legacy`.
   ===================================================================== */
function volFromTape(tape) {
  if (!Array.isArray(tape) || tape.length < 8) return 0.45;
  const rets = [];
  for (let i = 1; i < tape.length; i++) {
    const dt = Math.max(0.5, (tape[i].ts - tape[i - 1].ts) / 1000);
    const r = (tape[i].price - tape[i - 1].price) / tape[i - 1].price * 1e4 / Math.sqrt(dt);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 4) return 0.45;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = Math.sqrt(rets.reduce((a, b) => a + (b - m) * (b - m), 0) / (rets.length - 1));
  return clamp(v, 0.12, 4);
}
function driftFromTape(tape) {
  if (!Array.isArray(tape) || tape.length < 6) return 0;
  const recent = tape.slice(-Math.min(tape.length, 90));
  const HL = 25; let num = 0, den = 0; const now = recent[recent.length - 1].ts;
  for (let i = 1; i < recent.length; i++) {
    const dt = Math.max(0.5, (recent[i].ts - recent[i - 1].ts) / 1000);
    const r = (recent[i].price - recent[i - 1].price) / recent[i - 1].price * 1e4 / dt;
    const age = (now - recent[i].ts) / 1000; const w = Math.pow(0.5, age / HL);
    if (Number.isFinite(r)) { num += w * r; den += w; }
  }
  return den ? clamp(num / den, -3, 3) : 0;
}
function computePinPressure(input) {
  const { price, strike, secondsLeft, side, spotFlow, kalshi, tape, sentinel } = input;
  const gapUsd = Number.isFinite(price) && Number.isFinite(strike) ? price - strike : NaN;
  const gapBps = Number.isFinite(gapUsd) && price ? (gapUsd / price) * 1e4 : NaN;
  const haveGeometry = Number.isFinite(gapBps);
  const naturalSide = haveGeometry ? (gapBps >= 0 ? 'ABOVE' : 'BELOW') : null;
  const mySide = side || naturalSide;
  const sideSign = mySide === 'ABOVE' ? 1 : -1;
  const time = Math.max(1, secondsLeft);
  const vol = volFromTape(tape);
  const drift = driftFromTape(tape);
  const sigma = Math.max(0.45, vol * Math.sqrt(time));
  const sigmasOfCushion = haveGeometry ? Math.abs(gapBps) / sigma : null;
  const adverseDriftPerSec = -sideSign * (Number.isFinite(drift) ? drift : 0);
  const projectedAdverseBps = adverseDriftPerSec * time;
  const zCross = haveGeometry ? (Math.abs(gapBps) - Math.max(0, projectedAdverseBps)) / sigma : NaN;
  const pCross = clamp(Number.isFinite(zCross) ? (1 - normCdf(zCross)) : 0.02, 0.002, 0.97);

  let flowScore = 0, flowNote = 'no flow data';
  if (spotFlow && spotFlow.ok) {
    const towardStrikeFlow = -sideSign * (spotFlow.flowImbalance || 0);
    const towardStrikeBook = -sideSign * (spotFlow.bookImbalance || 0);
    flowScore = clamp(towardStrikeFlow * 46 + towardStrikeBook * 20, -40, 66);
    flowNote = `flow ${spotFlow.flowImbalance > 0 ? '+' : ''}${spotFlow.flowImbalance} (${towardStrikeFlow > 0.12 ? 'toward strike' : towardStrikeFlow < -0.12 ? 'away' : 'neutral'}), book ${spotFlow.bookImbalance}`;
  }
  let kalshiScore = 0, kalshiNote = 'no kalshi book';
  if (kalshi && kalshi.ok) {
    const towardStrikeK = sideSign > 0 ? -(kalshi.bookImbalance || 0) : (kalshi.bookImbalance || 0);
    kalshiScore = clamp(towardStrikeK * 30, -20, 34);
    kalshiNote = `kalshi resting ${kalshi.bookImbalance > 0 ? 'YES/above' : 'NO/below'}-heavy (${kalshi.bookImbalance})`;
  }
  let sentScore = 0, sentNote = 'no sentinel data';
  if (sentinel && sentinel.ok && Number.isFinite(sentinel.pressure)) {
    const towardStrikeS = -sideSign * (sentinel.pressure / 100);
    sentScore = clamp(towardStrikeS * 62, -35, 62);
    sentNote = `perp pressure ${sentinel.pressure > 0 ? '+' : ''}${sentinel.pressure} (${towardStrikeS > 0.2 ? 'toward strike' : towardStrikeS < -0.2 ? 'away' : 'neutral'})`;
  }
  const lateWeight = clamp((240 - secondsLeft) / 240, 0, 1);
  const thinCushion = haveGeometry ? clamp((1.6 - sigmasOfCushion) * 1.0, 0, 1.6) : 0;
  const geometryScore = clamp(pCross * 70 + thinCushion * 22, 0, 92);
  const raw = geometryScore * (0.55 + 0.45 * lateWeight) + Math.max(0, flowScore) * (0.45 + 0.65 * lateWeight) + Math.max(0, kalshiScore) * (0.5 + 0.6 * lateWeight) + Math.max(0, sentScore) * (0.5 + 0.7 * lateWeight);
  const lateFlowFloor = (secondsLeft <= 120 && flowScore >= 28) ? clamp(28 + (flowScore - 28) * 0.9 + Math.max(0, kalshiScore) * 0.5, 0, 62) : 0;
  const lateSentFloor = (secondsLeft <= 180 && sentScore >= 30) ? clamp(30 + (sentScore - 30) * 1.0 + Math.max(0, flowScore) * 0.4, 0, 70) : 0;
  const pinPressure = clamp(Math.round(Math.max(raw, lateFlowFloor, lateSentFloor)), 0, 100);
  let etaSec = null;
  if (adverseDriftPerSec > 0.003 && haveGeometry && Math.abs(gapBps) > 0) {
    etaSec = Math.round(Math.abs(gapBps) / adverseDriftPerSec);
    if (etaSec > secondsLeft) etaSec = null;
  }
  const stale = !Number.isFinite(price) || !Number.isFinite(strike);
  let level, verdict;
  if (stale) { level = 'STALE'; verdict = 'NO DATA'; }
  else if (pinPressure >= 66) { level = 'RED'; verdict = 'CROSS LIKELY'; }
  else if (pinPressure >= 40) { level = 'AMBER'; verdict = 'ELEVATED'; }
  else if (pinPressure >= 22) { level = 'YELLOW'; verdict = 'WATCH'; }
  else { level = 'GREEN'; verdict = 'CLEAR'; }
  const reasons = [];
  if (stale) reasons.push('no live price/strike this tick — reading held/stale');
  else {
    if (sigmasOfCushion != null && sigmasOfCushion < 1.2) reasons.push(`thin cushion: ${sigmasOfCushion.toFixed(2)} sigma to strike`);
    if (projectedAdverseBps > Math.abs(gapBps) * 0.5 && adverseDriftPerSec > 0.003) reasons.push(`drift projects ${projectedAdverseBps.toFixed(1)}bps toward strike`);
    if (flowScore > 18) reasons.push('aggressive spot flow toward strike');
    if (sentScore > 20) reasons.push('upstream flow building toward strike (leads index)');
    if (kalshiScore > 14) reasons.push('kalshi book leaning against your side');
    if (secondsLeft <= 120 && sigmasOfCushion != null && sigmasOfCushion < 1.6) reasons.push('final 2 minutes, near strike');
    if (!reasons.length) reasons.push(secondsLeft > 240 ? 'outside danger window' : 'cushion healthy');
  }
  return {
    pinPressure: stale ? 0 : pinPressure, level, verdict, stale,
    gapUsd: round(gapUsd, 2), gapBps: round(gapBps, 2), mySide, naturalSide,
    secondsLeft, sigmasOfCushion: sigmasOfCushion == null ? null : round(sigmasOfCushion, 2),
    pCrossBeforeExpiry: round(pCross, 3), projectedAdverseBps: round(projectedAdverseBps, 2),
    etaTouchSec: etaSec, drift: round(drift, 4), vol: round(vol, 3),
    components: { geometry: round(geometryScore, 1), flow: round(flowScore, 1), kalshi: round(kalshiScore, 1), sentinel: round(sentScore, 1), lateWeight: round(lateWeight, 2) },
    notes: { flow: flowNote, kalshi: kalshiNote, sentinel: sentNote },
    reasons
  };
}

/* =====================================================================
   SETTLEMENT-AWARE FUSION (primary path in 2.0)
   ===================================================================== */
/* =====================================================================
   TAKER IMPULSE DETECTOR (v2.1)
   Deliberately STATELESS: everything is recomputed from the 120 s trade
   ring on each call, including the retrospective "was it already firing
   a second ago" test used for onset. That makes it identical under live
   operation and under replay, with no hidden accumulator to desync.
   Strictly causal — window [t - len, t), never [t - len, t].
   `trades` may be injected (replay/tests); defaults to the live rings.
   ===================================================================== */
function takerWindow(trades, endTs, lenMs) {
  let buy = 0, sell = 0; const cut = endTs - lenMs;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i];
    if (t[0] >= endTs) continue;
    if (t[0] < cut) break;
    if (t[1] >= 0) buy += t[1]; else sell += -t[1];
  }
  const tot = buy + sell;
  return { buy, sell, total: tot, imbalance: tot > 0 ? (buy - sell) / tot : 0 };
}
function impulseState(now = Date.now(), trades = null) {
  let tr = trades;
  if (!tr) {
    tr = [];
    for (const v of VENUE_LIST()) if (venueFresh(v, now)) for (const t of v.trades) tr.push(t);
    tr.sort((a, b) => a[0] - b[0]);
  }
  if (!tr.length) return { ok: false, error: 'no trades' };
  const fire = (t) => {
    const w = takerWindow(tr, t, 5000);
    const base = [];
    for (let k = t - 120000; k <= t - 5000; k += 5000) base.push(takerWindow(tr, k, 5000).total);
    base.sort((a, b) => a - b);
    const med = base.length ? base[base.length >> 1] : 0;
    const surge = w.total / Math.max(IMP_BASELINE_FLOOR, med);
    const live = surge >= IMP_SURGE_MIN && w.total >= IMP_NOTIONAL_MIN && Math.abs(w.imbalance) >= IMP_IMBALANCE_MIN;
    return { w, surge, live, baselineUsd: med };
  };
  const cur = fire(now);
  let onset = false;
  if (cur.live) {
    onset = true;
    for (let k = 1; k <= IMP_QUIET_GAP_SEC; k++) if (fire(now - k * 1000).live) { onset = false; break; }
  }
  const mids = VENUE_LIST().filter(v => venueFresh(v, now) && Number.isFinite(v.mid)).map(v => v.mid);
  const ref = Number.isFinite(IDX.value) ? IDX.value : (mids.length ? median(mids) : NaN);
  const dispersionBps = mids.length > 1 && Number.isFinite(ref) && ref
    ? (Math.max(...mids) - Math.min(...mids)) / ref * 1e4 : 0;
  return {
    ok: true,
    regime: onset ? 'onset' : cur.live ? 'live' : 'quiet',
    live: cur.live, onset,
    notional5sUsd: round(cur.w.total, 0),
    baseline5sUsd: round(cur.baselineUsd, 0),
    surge: round(cur.surge, 2),
    imbalance5s: round(cur.w.imbalance, 3),
    /* +1 = taker buying (pushes the index up), -1 = taker selling. */
    direction: cur.w.imbalance >= 0 ? 1 : -1,
    dispersionBps: round(dispersionBps, 2)
  };
}
function aggregateSpotFlow(now = Date.now()) {
  const alive = VENUE_LIST().filter(v => venueFresh(v, now));
  if (!alive.length) return { ok: false, error: 'no live venue' };
  let buy = 0, sell = 0, bd = 0, ad = 0;
  const cut = now - 60000;
  for (const v of alive) {
    for (let i = v.trades.length - 1; i >= 0; i--) {
      const t = v.trades[i]; if (t[0] < cut) break;
      if (t[1] >= 0) buy += t[1]; else sell += -t[1];
    }
    bd += v.bidDepth; ad += v.askDepth;
  }
  const tot = buy + sell, dep = bd + ad;
  return {
    ok: true, venue: alive.map(v => v.name).join('+'),
    last: Number.isFinite(IDX.value) ? IDX.value : alive[0].mid,
    mid: Number.isFinite(IDX.value) ? IDX.value : alive[0].mid,
    buyVol: round(buy, 0), sellVol: round(sell, 0),
    flowImbalance: tot > 0 ? round((buy - sell) / tot, 3) : 0,
    bookImbalance: dep > 0 ? round((bd - ad) / dep, 3) : 0,
    bidDepth: round(bd, 3), askDepth: round(ad, 3),
    tradeCount60s: alive.reduce((a, v) => a + v.trades.filter(t => t[0] >= cut).length, 0)
  };
}

/* Data-quality gate. This is the fail-safe. */
function assessQuality(now, kal) {
  const problems = [], warnings = [];
  const live = VENUE_LIST().filter(v => venueFresh(v, now));
  const idxAge = IDX.ts ? now - IDX.ts : Infinity;
  if (!Number.isFinite(IDX.value)) problems.push('index unavailable: ' + (IDX.lastReason || 'unknown'));
  if (idxAge > INDEX_HARD_STALE_MS) problems.push('index hard-stale ' + Math.round(idxAge) + 'ms');
  else if (idxAge > INDEX_STALE_MS) warnings.push('index stale ' + Math.round(idxAge) + 'ms');
  if (live.length === 0) problems.push('no live venue');
  else if (live.length < MIN_INDEX_VENUES) warnings.push('single-source index (' + live.map(v => v.name).join(',') + ')');
  if (IDX.venuesRejected && IDX.venuesRejected.length) warnings.push('venue outlier rejected: ' + IDX.venuesRejected.map(r => r.venue + ' ' + r.bps + 'bps').join(','));
  if (IDX.dispersionBps != null && IDX.dispersionBps > OUTLIER_BPS * 0.6) warnings.push('cross-venue dispersion ' + IDX.dispersionBps + 'bps');
  if (!kal || !kal.ok) problems.push('kalshi context unavailable: ' + ((kal && kal.error) || 'unknown'));
  else if (kal.pending) problems.push(kal.error || 'next window not yet priced');
  else if (kal.obAgeMs != null && kal.obAgeMs > 4000) warnings.push('kalshi book ' + kal.obAgeMs + 'ms old');
  if (SKEW.samples.length < 5) warnings.push('clock skew not yet estimated');
  else if (Math.abs(SKEW.estMs) > 2000) warnings.push('clock skew ' + Math.round(SKEW.estMs) + 'ms');
  if (!volWarm()) warnings.push('vol estimate warming up (' + IDX.ring.length + '/' + VOL_MIN_SAMPLES + ' index samples)');
  if (RESTF.active) warnings.push('running on REST fallback, not streaming');
  const grade = problems.length ? 'BAD' : warnings.length ? 'DEGRADED' : 'GOOD';
  return {
    grade, problems, warnings,
    indexAgeMs: Number.isFinite(idxAge) ? Math.round(idxAge) : null,
    liveVenues: live.map(v => v.name),
    venueAges: Object.fromEntries(VENUE_LIST().map(v => [v.name, v.lastQuoteTs ? now - v.lastQuoteTs : null])),
    clockSkewMs: Math.round(SKEW.estMs), clockSkewSamples: SKEW.samples.length,
    streaming: !RESTF.active && WS_AVAILABLE && ENABLE_WS
  };
}

const LEVEL_RANK = { GREEN: 0, YELLOW: 1, AMBER: 2, RED: 3 };
function fuse({ sg, flow, kal, sent, side, tau, quality, impulse }) {
  // Adverse direction: your side is the one that loses if the settlement
  // average crosses. ABOVE = you need settle >= strike.
  const naturalSide = sg ? (sg.gapBps >= 0 ? 'ABOVE' : 'BELOW') : null;
  const mySide = side || naturalSide;
  const sideSign = mySide === 'ABOVE' ? 1 : -1;

  // Probability that settlement lands on the wrong side FOR YOU.
  const pGeom = sg ? (mySide === 'ABOVE' ? 1 - sg.pAboveStrike : sg.pAboveStrike) : null;

  /* ---- IMPULSE REACHABILITY (v2.1) -------------------------------
     The diffusion model cannot price a live taker impulse: its vol
     input is a 120 s trailing estimate that only reacts after the move
     has already printed. So we bound the risk a second way — how far
     must the index average over the remaining unlocked seconds to flip
     the settlement, and how likely is a move that size given what the
     tape is doing RIGHT NOW. pAdverse is the worse of the two. */
  let pReach = null, impulseAdverse = false, reachRegime = null;
  if (sg && impulse && impulse.ok && tau > 0 && tau <= IMP_MAX_TAU) {
    // adverse = the impulse pushes the settlement toward the side you lose on
    impulseAdverse = (sideSign > 0 && impulse.direction < 0) || (sideSign < 0 && impulse.direction > 0);
    reachRegime = impulse.regime;
    if (impulseAdverse && impulse.live) {
      const horizon = Math.max(1, Math.min(tau, SETTLE_WINDOW_SEC));
      pReach = reachProbability(sg.requiredIndexMoveUsd, horizon, impulse.regime);
    }
  }
  const pAdverse = pGeom == null ? null
    : (pReach == null ? pGeom : Math.max(pGeom, pReach));

  let geometryScore = 0;
  if (sg && pAdverse != null) {
    const thin = clamp((1.6 - (sg.sigmasOfCushion == null ? 9 : sg.sigmasOfCushion)), 0, 1.6);
    geometryScore = clamp(pAdverse * 82 + thin * 12, 0, 92);
  }
  let flowScore = 0, flowNote = 'no flow data';
  if (flow && flow.ok) {
    const tf = -sideSign * (flow.flowImbalance || 0);
    const tb = -sideSign * (flow.bookImbalance || 0);
    flowScore = clamp(tf * 46 + tb * 20, -40, 66);
    flowNote = `net taker flow ${flow.flowImbalance} (${tf > 0.12 ? 'toward strike' : tf < -0.12 ? 'away' : 'neutral'}), near-touch book ${flow.bookImbalance}`;
  }
  let kalshiScore = 0, kalshiNote = 'no kalshi book';
  if (kal && kal.ok) {
    const tk = sideSign > 0 ? -(kal.bookImbalance || 0) : (kal.bookImbalance || 0);
    kalshiScore = clamp(tk * 30, -20, 34);
    kalshiNote = `kalshi near-touch ${kal.bookImbalance > 0 ? 'YES' : 'NO'}-heavy (${kal.bookImbalance})`;
  }
  let sentScore = 0, sentNote = 'no sentinel data';
  if (sent && sent.ok && Number.isFinite(sent.pressure)) {
    const ts = -sideSign * (sent.pressure / 100);
    sentScore = clamp(ts * 62, -35, 62);
    sentNote = `cross-venue lead pressure ${sent.pressure > 0 ? '+' : ''}${sent.pressure} (${ts > 0.2 ? 'toward strike' : ts < -0.2 ? 'away' : 'neutral'})`;
  }
  // Kalshi's own implied probability is the market's answer. Use it as a
  // sanity cross-check, not as an input we can double-count.
  let disagreementPP = null, impliedAdverse = null;
  if (kal && kal.ok && kal.impliedAbove != null && pAdverse != null) {
    impliedAdverse = mySide === 'ABOVE' ? 1 - kal.impliedAbove : kal.impliedAbove;
    disagreementPP = round((pAdverse - impliedAdverse) * 100, 1);
  }

  // Late-window weighting is now driven by how much of the settlement
  // average is still unlocked, not by raw seconds.
  const unlocked = sg ? clamp(1 - sg.lockedFrac, 0, 1) : 1;
  const lateWeight = clamp((240 - tau) / 240, 0, 1);
  const raw = geometryScore * (0.55 + 0.45 * lateWeight)
    + Math.max(0, flowScore) * (0.45 + 0.65 * lateWeight) * unlocked
    + Math.max(0, kalshiScore) * (0.5 + 0.6 * lateWeight)
    + Math.max(0, sentScore) * (0.5 + 0.7 * lateWeight) * unlocked;
  const lateFlowFloor = (tau <= 120 && flowScore >= 28) ? clamp(28 + (flowScore - 28) * 0.9 + Math.max(0, kalshiScore) * 0.5, 0, 62) * unlocked : 0;
  const lateSentFloor = (tau <= 180 && sentScore >= 30) ? clamp(30 + (sentScore - 30) * 1.0 + Math.max(0, flowScore) * 0.4, 0, 70) * unlocked : 0;
  /* Impulse escalation floor. An adverse impulse with the required move
     inside its demonstrated reach is never allowed to render as CLEAR,
     no matter how many nominal sigmas of cushion the geometry reports.
     Onset is scored harder than continuation because onset is where the
     predictive lift lives (36.8x vs 13.7x over quiet tape). */
  let impulseFloor = 0;
  if (pReach != null && impulseAdverse) {
    const base = reachRegime === 'onset' ? 74 : 52;
    impulseFloor = clamp(Math.round(base * clamp(pReach / 0.05, 0.25, 1.35)), 0, 96);
  }
  let pinPressure = clamp(Math.round(Math.max(raw, lateFlowFloor, lateSentFloor, impulseFloor)), 0, 100);

  /* Resolution floor: a cushion inside the index's own measurement error
     cannot be called CLEAR. See INDEX_ERR_USD above. */
  const resolutionFloorUsd = INDEX_ERR_USD * GREEN_MIN_CUSHION_K;
  const belowResolution = !!(sg && sg.cushionUsd != null && tau <= RESOLUTION_MAX_TAU
    && sg.cushionUsd < resolutionFloorUsd);
  if (belowResolution) pinPressure = Math.max(pinPressure, 22);

  let level, verdict;
  if (pinPressure >= 66) { level = 'RED'; verdict = 'CROSS LIKELY'; }
  else if (pinPressure >= 40) { level = 'AMBER'; verdict = 'ELEVATED'; }
  else if (pinPressure >= 22) { level = 'YELLOW'; verdict = 'WATCH'; }
  else { level = 'GREEN'; verdict = 'CLEAR'; }

  /* ---- FAIL-SAFE GATE ----
     Bad data never renders as a tradeable verdict. Degraded data can
     never show GREEN — the worst outcome for this tool is telling the
     trader "clear" on a feed that has actually gone dark. */
  let gated = false;
  if (!sg || quality.grade === 'BAD') {
    level = 'STALE'; verdict = 'NO DATA'; pinPressure = 0; gated = true;
  } else if (quality.grade === 'DEGRADED' && LEVEL_RANK[level] < LEVEL_RANK.YELLOW) {
    level = 'DEGRADED'; verdict = 'DATA SUSPECT'; gated = true;
  }

  const reasons = [];
  if (level === 'STALE') {
    reasons.push('feed unusable: ' + (quality.problems[0] || 'no settlement geometry'));
  } else {
    if (level === 'DEGRADED') reasons.push('data quality degraded: ' + (quality.warnings[0] || 'unknown'));
    if (pReach != null && impulseAdverse) {
      reasons.unshift(`ADVERSE TAKER IMPULSE${reachRegime === 'onset' ? ' (onset)' : ''}: $${Math.round(impulse.notional5sUsd).toLocaleString('en-US')} in 5s = ${impulse.surge}x baseline, imbalance ${impulse.imbalance5s > 0 ? '+' : ''}${impulse.imbalance5s}; settlement needs only $${sg.requiredIndexMoveUsd} of index move to flip — ${(pReach * 100).toFixed(1)}% on current tape`);
    }
    if (belowResolution) reasons.push(`cushion $${sg.cushionUsd} is inside the index's own measurement error (+/-$${INDEX_ERR_USD} vs BRTI) — the side is not resolvable from this feed`);
    if (sg && sg.sigmasOfCushion != null && sg.sigmasOfCushion < 1.2) reasons.push(`thin cushion: ${sg.sigmasOfCushion.toFixed(2)}σ of the settlement average`);
    else if (sg && sg.cushionUsd != null && tau <= 60 && sg.requiredIndexMoveUsd != null && sg.requiredIndexMoveUsd < 40) reasons.push(`cushion is $${sg.cushionUsd}; a $${sg.requiredIndexMoveUsd} index move over the remaining ${Math.round(tau)}s still flips it`);
    if (sg && sg.lockedFrac > 0.15) reasons.push(`${Math.round(sg.lockedFrac * 100)}% of the 60s settlement average is already locked at $${sg.knownMean ?? '?'}`);
    if (flowScore > 18) reasons.push('aggressive taker flow toward strike');
    if (sentScore > 20) reasons.push('cross-venue lead flow building toward strike');
    if (kalshiScore > 14) reasons.push('kalshi near-touch book leaning against your side');
    if (disagreementPP != null && Math.abs(disagreementPP) >= 12) {
      reasons.push(`model ${disagreementPP > 0 ? 'more' : 'less'} bearish than kalshi by ${Math.abs(disagreementPP)}pp — verify before acting`);
    }
    if (tau <= 120 && sg && sg.sigmasOfCushion != null && sg.sigmasOfCushion < 1.6) reasons.push('final 2 minutes, near strike on the settlement average');
    if (!reasons.length) reasons.push(tau > 240 ? 'outside danger window' : 'cushion healthy on the settlement average');
  }

  // ETA is now to the SETTLEMENT AVERAGE touching the strike, which is
  // slower than spot touching it because the average has inertia.
  let etaSec = null;
  if (sg) {
    const adverseDrift = -sideSign * (indexDriftBpsPerSec() || 0);
    if (adverseDrift > 0.003 && Math.abs(sg.gapBps) > 0) {
      const e = Math.round(Math.abs(sg.gapBps) / (adverseDrift * Math.max(0.15, 1 - sg.lockedFrac)));
      etaSec = e > tau ? null : e;
    }
  }
  return {
    pinPressure, level, verdict, gated, mySide, naturalSide,
    pAdverse: pAdverse == null ? null : round(pAdverse, 4),
    pAdverseGeometry: pGeom == null ? null : round(pGeom, 4),
    pAdverseReach: pReach == null ? null : round(pReach, 4),
    impulse: impulse && impulse.ok ? { ...impulse, adverse: impulseAdverse } : null,
    belowResolution, resolutionFloorUsd: round(resolutionFloorUsd, 2),
    impliedAdverse: impliedAdverse == null ? null : round(impliedAdverse, 4),
    disagreementPP, etaTouchSec: etaSec,
    components: { geometry: round(geometryScore, 1), flow: round(flowScore, 1), kalshi: round(kalshiScore, 1), sentinel: round(sentScore, 1), lateWeight: round(lateWeight, 2), unlocked: round(unlocked, 2) },
    notes: { flow: flowNote, kalshi: kalshiNote, sentinel: sentNote },
    reasons
  };
}

/* ---------------------- optional OpenAI plain-English read ---------------------- */
async function aiRead(pin, evidence) {
  if (!ENABLE_OPENAI || !OPENAI_API_KEY) return null;
  const ac = new AbortController(); const t = setTimeout(() => { try { ac.abort(); } catch (_) { } }, 6000);
  try {
    const sys = 'You are a terse trading-desk risk assistant watching late-window BTC settlement risk. The contract settles on the 60-second average of an index, not the last spot print. Given the snapshot, write ONE short sentence (max 24 words) telling the trader plainly whether the settlement average is at risk of crossing the strike and why. No preamble. No JSON.';
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, temperature: 0.2, max_tokens: 80, messages: [{ role: 'system', content: sys }, { role: 'user', content: JSON.stringify({ pin, evidence }) }] })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j?.choices?.[0]?.message?.content || '').trim().slice(0, 180);
  } catch (_) { return null; } finally { clearTimeout(t); }
}

/* ---------------------- main radar endpoint ---------------------- */
let bootTs = 0;
function ensureStarted() {
  if (bootTs) return;
  bootTs = Date.now();
  if (ENABLE_WS && WS_AVAILABLE) for (const n of Object.keys(VENUES)) connectVenue(n);
  startSampler(); startSentinel(); startKalshi(); startRestFallback();
}

async function radar(payload) {
  ensureStarted();
  const t0 = process.hrtime.bigint();
  const now = Date.now();
  const kal = kalshiContext();

  /* Window & strike authority: Kalshi's own market record. The client may
     override for what-if analysis, but it is no longer the source of truth. */
  const overrideStrike = Number(payload.target);
  const overrideSeconds = Number(payload?.timer?.secondsLeft ?? payload.secondsLeft);
  const strike = Number.isFinite(overrideStrike) && overrideStrike > 0 ? overrideStrike
    : (kal.ok && Number.isFinite(kal.strike) ? kal.strike : NaN);
  const strikeSource = (Number.isFinite(overrideStrike) && overrideStrike > 0) ? 'client-override'
    : (kal.ok && Number.isFinite(kal.strike) ? 'kalshi:' + kal.ticker : 'none');
  let tau, tauSource;
  if (kal.ok && Number.isFinite(kal.secondsToClose)) { tau = kal.secondsToClose; tauSource = 'kalshi-close_time'; }
  else if (Number.isFinite(overrideSeconds)) { tau = Math.max(0, overrideSeconds); tauSource = 'client-timer'; }
  else { tau = 900; tauSource = 'default'; }

  const quality = assessQuality(now, kal);
  const priceOverride = Number(payload?.market?.price);
  /* Use a LIVE index for the current level (venue quotes are 10-40 ms
     fresh) and keep the 1 Hz ring for the settlement average and vol,
     which must mirror BRTI's one-print-per-second cadence. */
  const liveIdx = computeIndex(now);
  const liveValue = liveIdx ? liveIdx.value : IDX.value;
  const indexNow = Number.isFinite(priceOverride) ? priceOverride : liveValue;
  const priceSource = Number.isFinite(priceOverride) ? 'client-override'
    : (liveIdx ? 'index-live:' + liveIdx.used.join('+')
      : (Number.isFinite(IDX.value) ? 'index-ring:' + IDX.venuesUsed.join('+') : 'none'));
  const liveIndexAgeMs = liveIdx ? Math.round(Math.min(...VENUE_LIST().filter(v => liveIdx.used.includes(v.name)).map(v => now - v.lastQuoteTs))) : null;

  const sigma = indexVolBpsPerRootSec();
  const drift = indexDriftBpsPerSec();
  const sg = settlementGeometry({
    indexNow, strike, tau,
    sigmaBpsRootSec: sigma, driftBpsSec: drift,
    strikeType: kal.ok ? kal.strikeType : 'greater_or_equal'
  });

  const flow = aggregateSpotFlow(now);
  const imp = impulseState(now);
  const sent = SENT.read || { ok: false, error: 'not started' };
  const side = payload.activePosition || null;

  const out = fuse({ sg, flow, kal, sent, side, tau, quality, impulse: imp });

  /* Legacy 1.5 model, for A/B. Uses the client tape when supplied so its
     numbers stay comparable to what 1.5 produced. */
  const tape = Array.isArray(payload.recentTape) && payload.recentTape.length
    ? payload.recentTape
    : IDX.ring.slice(-180).map(p => ({ ts: p[0], price: p[1] }));
  const legacy = computePinPressure({
    price: indexNow, strike, secondsLeft: Math.round(tau), side,
    spotFlow: flow, kalshi: kal, tape, sentinel: sent
  });

  let ai = null;
  if (payload.ai !== false && (out.level === 'AMBER' || out.level === 'RED')) {
    ai = await aiRead(
      { pinPressure: out.pinPressure, level: out.level, verdict: out.verdict, reasons: out.reasons },
      { gapBps: sg && sg.gapBps, tau, sigmasOfSettlement: sg && sg.sigmasOfCushion, lockedFrac: sg && sg.lockedFrac, flow: out.notes.flow, kalshi: out.notes.kalshi, sentinel: out.notes.sentinel, eta: out.etaTouchSec }
    );
  }

  const serverMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    ok: true, version: SERVER_VERSION, ts: Date.now(), serverComputeMs: round(serverMs, 3),
    /* ---- headline (backward-compatible field names) ---- */
    price: round(indexNow, 2), strike: Number.isFinite(strike) ? strike : null,
    secondsLeft: Math.round(tau),
    pinPressure: out.pinPressure, level: out.level, verdict: out.verdict,
    stale: out.level === 'STALE', gated: out.gated,
    gapUsd: sg ? sg.gapUsd : null, gapBps: sg ? sg.gapBps : null,
    sigmasOfCushion: sg ? sg.sigmasOfCushion : null,
    cushionUsd: sg ? sg.cushionUsd : null,
    requiredIndexMoveUsd: sg ? sg.requiredIndexMoveUsd : null,
    impulse: out.impulse, pAdverseGeometry: out.pAdverseGeometry, pAdverseReach: out.pAdverseReach,
    pCrossBeforeExpiry: out.pAdverse, etaTouchSec: out.etaTouchSec,
    impliedAdverse: out.impliedAdverse, disagreementPP: out.disagreementPP,
    mySide: out.mySide, naturalSide: out.naturalSide,
    components: out.components, notes: out.notes, reasons: out.reasons, ai,
    drift: round(drift, 4), vol: round(sigma, 3),
    /* ---- new in 2.0 ---- */
    settlement: sg,
    market: kal.ok ? {
      ticker: kal.ticker, strike: kal.strike, strikeType: kal.strikeType,
      closeMs: kal.closeMs, openMs: kal.openMs, secondsToClose: kal.secondsToClose,
      yesBid: kal.yesBid, yesAsk: kal.yesAsk, impliedAbove: kal.impliedAbove,
      rules: kal.rules
    } : null,
    strikeSource, tauSource, priceSource,
    index: {
      value: round(liveValue, 2), liveAgeMs: liveIndexAgeMs,
      ringValue: round(IDX.value, 2), ageMs: IDX.ts ? now - IDX.ts : null,
      venuesUsed: IDX.venuesUsed, venuesRejected: IDX.venuesRejected,
      dispersionBps: IDX.dispersionBps, ringSamples: IDX.ring.length,
      single: !!IDX.single
    },
    quality,
    sources: {
      spotFlow: flow.ok ? flow.venue : ('offline: ' + (flow.error || '?')),
      kalshi: kal.ok ? kal.ticker : ('offline: ' + (kal.error || '?')),
      sentinel: sent.ok ? (sent.venues || []).join('+') : ('offline: ' + (sent.error || '?')),
      index: Number.isFinite(IDX.value) ? IDX.venuesUsed.join('+') : 'offline'
    },
    spotFlow: flow.ok ? flow : null,
    kalshi: kal.ok ? kal : null,
    sentinel: sent.ok ? sent : null,
    legacy: { pinPressure: legacy.pinPressure, level: legacy.level, verdict: legacy.verdict, sigmasOfCushion: legacy.sigmasOfCushion, pCrossBeforeExpiry: legacy.pCrossBeforeExpiry, components: legacy.components }
  };
}

/* ---------------------- self-test ---------------------- */
function mkTape(fn, n = 90, step = 1000) { const now = Date.now(); const t = []; for (let i = 0; i < n; i++)t.push({ ts: now - (n - 1 - i) * step, price: fn(i) }); return t; }
function runSelfTest() {
  const checks = [];
  const push = (name, pass, got) => checks.push({ name, pass: !!pass, got });
  const strike = 62050;

  /* --- legacy 1.5 checks, preserved verbatim --- */
  const grindTape = mkTape(i => 61995 + 40 * (i / 89));
  const a = computePinPressure({ price: 62035, strike, secondsLeft: 45, side: 'BELOW', spotFlow: { ok: true, flowImbalance: 0.4, bookImbalance: 0.2, venue: 'test', last: 62035 }, kalshi: { ok: true, bookImbalance: 0.5 }, tape: grindTape });
  push('legacy: grind-to-strike late -> RED/AMBER', ['RED', 'AMBER'].includes(a.level), a.level + ' ' + a.pinPressure);
  push('legacy: grind -> high cross prob', a.pCrossBeforeExpiry > 0.3, a.pCrossBeforeExpiry);
  const b = computePinPressure({ price: 61930, strike, secondsLeft: 400, side: 'BELOW', spotFlow: { ok: true, flowImbalance: 0, bookImbalance: 0, venue: 'test', last: 61930 }, kalshi: { ok: false }, tape: mkTape(() => 61930) });
  push('legacy: flat far-from-strike -> GREEN', b.level === 'GREEN', b.level + ' ' + b.pinPressure);
  const c = computePinPressure({ price: 61980, strike, secondsLeft: 45, side: 'BELOW', spotFlow: { ok: true, flowImbalance: -0.3, bookImbalance: -0.2, venue: 'test', last: 61980 }, kalshi: { ok: false }, tape: mkTape(i => 62010 - 30 * (i / 89)) });
  push('legacy: moving away late -> not RED', c.level !== 'RED', c.level + ' ' + c.pinPressure);
  const base = { price: 62030, strike, secondsLeft: 90, side: 'BELOW', kalshi: { ok: false }, tape: mkTape(i => 62000 + 30 * (i / 89)) };
  const neutral = computePinPressure({ ...base, spotFlow: { ok: true, flowImbalance: 0, bookImbalance: 0, venue: 't', last: 62030 } });
  const adverse = computePinPressure({ ...base, spotFlow: { ok: true, flowImbalance: 0.6, bookImbalance: 0.4, venue: 't', last: 62030 } });
  push('legacy: adverse spot flow raises pressure', adverse.pinPressure > neutral.pinPressure, neutral.pinPressure + ' < ' + adverse.pinPressure);
  push('legacy: ETA present on adverse grind', Number.isFinite(a.etaTouchSec), a.etaTouchSec);
  const down = computePinPressure({ price: 62065, strike, secondsLeft: 45, side: 'ABOVE', spotFlow: { ok: true, flowImbalance: -0.4, bookImbalance: -0.2, venue: 't', last: 62065 }, kalshi: { ok: true, bookImbalance: -0.5 }, tape: mkTape(i => 62105 - 40 * (i / 89)) });
  push('legacy: symmetric ABOVE-grind-down -> elevated', ['RED', 'AMBER'].includes(down.level), down.level + ' ' + down.pinPressure);
  const gBase = { price: 62030, strike, secondsLeft: 90, side: 'BELOW', kalshi: { ok: false }, tape: mkTape(i => 62000 + 30 * (i / 89)), spotFlow: { ok: true, flowImbalance: 0, bookImbalance: 0, venue: 't', last: 62030 } };
  push('legacy: adverse sentinel raises pressure',
    computePinPressure({ ...gBase, sentinel: { ok: true, pressure: 70 } }).pinPressure > computePinPressure({ ...gBase }).pinPressure, 'ok');
  const h = computePinPressure({ price: 62160, strike, secondsLeft: 150, side: 'ABOVE', spotFlow: { ok: true, flowImbalance: 0, bookImbalance: 0, venue: 't', last: 62160 }, kalshi: { ok: false }, tape: mkTape(() => 62160), sentinel: { ok: true, pressure: -70 } });
  push('legacy: sentinel fires before price moves (floor)', h.level !== 'GREEN', h.level + ' ' + h.pinPressure);

  /* --- new settlement-model checks --- */
  const SG = o => settlementGeometry({ indexNow: 62030, strike: 62050, sigmaBpsRootSec: 0.5, driftBpsSec: 0, strikeType: 'greater_or_equal', ...o });
  const far = SG({ tau: 900 }), near = SG({ tau: 60 });
  push('settle: variance ratio ~1 at long tau', far.varianceRatioVsSpot > 0.9 && far.varianceRatioVsSpot < 1.0, far.varianceRatioVsSpot);
  push('settle: variance ratio = 1/3 at tau=60', Math.abs(near.varianceRatioVsSpot - 1 / 3) < 0.01, near.varianceRatioVsSpot);
  push('settle: settlement sigma < spot sigma near close', near.sigmaSettleBps < near.spotCompare.sigmaSpotBps, near.sigmaSettleBps + ' < ' + near.spotCompare.sigmaSpotBps);
  push('settle: cushion in settlement sigmas > cushion in spot sigmas near close',
    near.sigmasOfCushion > near.spotCompare.spotSigmasOfCushion, near.sigmasOfCushion + ' > ' + near.spotCompare.spotSigmasOfCushion);
  const mono = [300, 200, 120, 90, 61].map(t => SG({ tau: t }).sigmaSettleBps);
  push('settle: sigma shrinks monotonically into the close', mono.every((x, i) => i === 0 || x < mono[i - 1]), mono.join(' > '));
  push('settle: null on missing inputs', SG({ tau: 100, indexNow: NaN }) === null && settlementGeometry({ indexNow: 1, strike: NaN, tau: 1 }) === null, 'ok');
  push('settle: tau=0 does not divide by zero', Number.isFinite(SG({ tau: 0 }).sigmaSettleBps), SG({ tau: 0 }).sigmaSettleBps);
  const sgAbove = settlementGeometry({ indexNow: 62100, strike: 62050, tau: 120, sigmaBpsRootSec: 0.5, driftBpsSec: 0 });
  const sgBelow = settlementGeometry({ indexNow: 62000, strike: 62050, tau: 120, sigmaBpsRootSec: 0.5, driftBpsSec: 0 });
  push('settle: pAbove symmetric around the strike', Math.abs((sgAbove.pAboveStrike + sgBelow.pAboveStrike) - 1) < 0.02, sgAbove.pAboveStrike + '/' + sgBelow.pAboveStrike);

  /* --- REGRESSION: drift extrapolation blowup (found in live testing) ---
     A -0.13 bps/s drift measured over 90 s must NOT be projected across a
     13-minute window. Before the fix this produced an expected settlement
     $788 away from spot on a $77k index. */
  const blow = settlementGeometry({ indexNow: 77191, strike: 77198, tau: 821, sigmaBpsRootSec: 0.463, driftBpsSec: -0.1278 });
  push('regression: drift is not extrapolated over a 13-min horizon',
    Math.abs(blow.expectedSettle - 77191) < 60, 'expectedSettle=' + blow.expectedSettle + ' vs index 77191');
  push('regression: coin-flip geometry does not read as 0.05% adverse',
    blow.pAboveStrike > 0.15 && blow.pAboveStrike < 0.85, blow.pAboveStrike);
  const bigDrift = settlementGeometry({ indexNow: 77191, strike: 77198, tau: 3000, sigmaBpsRootSec: 0.5, driftBpsSec: 3 });
  push('regression: drift displacement is bounded at any tau',
    Math.abs(bigDrift.expectedSettle - 77191) / 77191 * 1e4 <= DRIFT_HORIZON_SEC * 3 * DRIFT_SHRINK + 1,
    round(Math.abs(bigDrift.expectedSettle - 77191) / 77191 * 1e4, 1) + 'bps');

  /* --- REGRESSION: cold start must not manufacture false confidence --- */
  {
    const ringSnap = IDX.ring.slice();
    const nowC = Date.now(); IDX.ring.length = 0;
    for (let i = 0; i < 25; i++) IDX.ring.push([nowC - (24 - i) * 1000, 77000 + (i % 2) * 0.05]);
    const vCold = indexVolBpsPerRootSec();
    push('regression: a 25-sample near-flat ring does not drive sigma to the floor',
      vCold > 0.3, vCold);
    push('regression: short ring is flagged not-warm', !volWarm(), IDX.ring.length + ' samples');
    const sgCold = settlementGeometry({ indexNow: 77217, strike: 77256.51, tau: 709, sigmaBpsRootSec: vCold, driftBpsSec: 0 });
    push('regression: cold-start geometry does not report >99% confidence',
      sgCold.pAboveStrike > 0.01 && sgCold.pAboveStrike < 0.99, sgCold.pAboveStrike);
    for (let i = 0; i < 120; i++) IDX.ring.push([nowC - (119 - i) * 1000, 77000]);
    push('regression: warm ring clears the warming flag', volWarm(), IDX.ring.length + ' samples');
    IDX.ring.length = 0; ringSnap.forEach(x => IDX.ring.push(x));
  }

  /* --- REGRESSION: a directional ramp must not read as low vol --- */
  {
    const ringSnap = IDX.ring.slice();
    const nowR = Date.now(); IDX.ring.length = 0;
    for (let i = 0; i < 120; i++) IDX.ring.push([nowR - (119 - i) * 1000, i < 60 ? 77400 : 77400 - (i - 60) * (400 / 60)]);
    const vRamp = indexVolBpsPerRootSec();
    push('regression: a one-way $400/60s grind is not scored as low vol', vRamp > 0.55, vRamp);
    IDX.ring.length = 0; ringSnap.forEach(x => IDX.ring.push(x));
  }

  /* --- REGRESSION: a quiet book is not a dead feed --- */
  const qv = mkVenue('quiet', { weight: 1 });
  const nowQ = Date.now();
  qv.mid = 62000; qv.lastQuoteTs = nowQ - 8000; qv.lastMsgTs = nowQ - 200;   // heartbeats flowing
  push('freshness: quiet book with live socket counts as fresh', venueFresh(qv, nowQ), 'quoteAge=8s socketAge=0.2s');
  qv.lastMsgTs = nowQ - 20000;                                              // socket gone silent
  push('freshness: silent socket is NOT fresh', !venueFresh(qv, nowQ), 'quoteAge=8s socketAge=20s');
  qv.lastMsgTs = nowQ - 200; qv.lastQuoteTs = nowQ - 60000;                 // quote ancient
  push('freshness: ancient quote is NOT fresh even on a live socket', !venueFresh(qv, nowQ), 'quoteAge=60s');

  /* --- fail-safe gate checks --- */
  const goodQ = { grade: 'GOOD', problems: [], warnings: [] };
  const degQ = { grade: 'DEGRADED', problems: [], warnings: ['index stale 4000ms'] };
  const badQ = { grade: 'BAD', problems: ['no live venue'], warnings: [] };
  const calm = settlementGeometry({ indexNow: 62500, strike: 62050, tau: 600, sigmaBpsRootSec: 0.4, driftBpsSec: 0 });
  const fGood = fuse({ sg: calm, flow: { ok: false }, kal: { ok: false }, sent: { ok: false }, side: 'ABOVE', tau: 600, quality: goodQ });
  push('gate: clean+calm can be GREEN', fGood.level === 'GREEN', fGood.level);
  const fDeg = fuse({ sg: calm, flow: { ok: false }, kal: { ok: false }, sent: { ok: false }, side: 'ABOVE', tau: 600, quality: degQ });
  push('gate: DEGRADED data can never render GREEN', fDeg.level === 'DEGRADED' && fDeg.gated, fDeg.level);
  const fBad = fuse({ sg: calm, flow: { ok: false }, kal: { ok: false }, sent: { ok: false }, side: 'ABOVE', tau: 600, quality: badQ });
  push('gate: BAD data -> STALE/NO DATA, pressure 0', fBad.level === 'STALE' && fBad.pinPressure === 0, fBad.level + ' ' + fBad.pinPressure);
  const fNoGeo = fuse({ sg: null, flow: { ok: true, flowImbalance: 0.9, bookImbalance: 0.9 }, kal: { ok: false }, sent: { ok: false }, side: 'ABOVE', tau: 30, quality: goodQ });
  push('gate: no geometry -> STALE even with strong flow', fNoGeo.level === 'STALE', fNoGeo.level);
  const danger = settlementGeometry({ indexNow: 62055, strike: 62050, tau: 90, sigmaBpsRootSec: 1.2, driftBpsSec: -0.02 });
  const fDang = fuse({ sg: danger, flow: { ok: true, flowImbalance: -0.7, bookImbalance: -0.5 }, kal: { ok: true, bookImbalance: 0.6, impliedAbove: 0.5 }, sent: { ok: true, pressure: -70 }, side: 'ABOVE', tau: 90, quality: degQ });
  push('gate: DEGRADED does not suppress a real RED/AMBER', ['RED', 'AMBER'].includes(fDang.level), fDang.level + ' ' + fDang.pinPressure);

  /* --- Kalshi parsing checks (against the real field names) --- */
  const realRecord = {
    ticker: 'KXBTC15M-26SEP101145-45', close_time: '2026-09-10T15:45:00Z', open_time: '2026-09-10T15:30:00Z',
    floor_strike: 77098.91, strike_type: 'greater_or_equal',
    yes_bid_dollars: '0.7000', yes_ask_dollars: '0.7100', last_price_dollars: '0.7100',
    yes_bid_size_fp: '4453.10', yes_ask_size_fp: '4538.86', rules_primary: 'If the simple average of the sixty seconds...'
  };
  const pm = parseKalshiMarket(realRecord);
  push('kalshi: parses *_dollars into cents', pm.yesBid === 70 && pm.yesAsk === 71, pm.yesBid + '/' + pm.yesAsk);
  push('kalshi: parses close_time (no close_ts field exists)', pm.closeMs === Date.parse('2026-09-10T15:45:00Z'), pm.closeMs);
  push('kalshi: reads floor_strike', pm.strike === 77098.91, pm.strike);
  const t0 = Date.parse('2026-09-10T15:35:00Z');
  const chosen = chooseMarket([
    { ...realRecord, ticker: 'NEXT', close_time: '2026-09-10T16:00:00Z', open_time: '2026-09-10T15:45:00Z' },
    realRecord
  ], t0);
  push('kalshi: picks the CURRENT window, not the next one', chosen.ticker === 'KXBTC15M-26SEP101145-45', chosen.ticker);
  // Far resting size (0.30 on the NO side, 47c below its touch) must NOT
  // contaminate the near-touch imbalance — that contamination is exactly
  // why the 1.5 kalshi component was noise.
  const obN = normaliseOrderbook({
    orderbook_fp: {
      yes_dollars: [['0.7800', '1035.60'], ['0.8200', '6215.06']],
      no_dollars: [['0.0300', '900000.00'], ['0.1300', '2000.00'], ['0.1700', '2500.00']]
    }
  }, 'X');
  push('kalshi: orderbook_fp dollars -> cents', obN.bestYes === 82 && obN.bestNo === 17, obN.bestYes + '/' + obN.bestNo);
  push('kalshi: near-touch imbalance ignores far resting size',
    obN.bookImbalance > 0 && obN.wideBookImbalance < 0,
    'near=' + obN.bookImbalance + ' wide=' + obN.wideBookImbalance);

  /* --- REGRESSION: 15-minute window rollover must not blind the radar ---
     status=open returns only the active window; upcoming ones are
     status=initialized with NO floor_strike. */
  const nowRo = Date.parse('2026-09-10T15:45:00Z');   // exact rollover instant
  const active = { ...realRecord };
  const upcoming = {
    ticker: 'KXBTC15M-26SEP101600-00', status: 'initialized',
    open_time: '2026-09-10T15:45:00Z', close_time: '2026-09-10T16:00:00Z',
    strike_type: 'greater_or_equal'
  };
  const gap = chooseMarket([upcoming], nowRo + 500);
  push('rollover: an unpriced upcoming window is still returned (countdown lives)',
    gap && gap.ticker === upcoming.ticker, gap && gap.ticker);
  push('rollover: an unpriced window reports NaN strike, never a guess',
    gap && !Number.isFinite(gap.strike), String(gap && gap.strike));
  const both = chooseMarket([upcoming, active], Date.parse('2026-09-10T15:40:00Z'));
  push('rollover: a priced active window beats an unpriced upcoming one',
    both.ticker === realRecord.ticker, both.ticker);
  const pendQ = assessQuality(Date.now(), { ok: true, pending: true, error: 'window X opens in 4s — strike is not set until then', obAgeMs: 0 });
  push('rollover: pending window is a QUALITY PROBLEM, so the level gates to STALE',
    pendQ.grade === 'BAD' && /not set until then/.test(JSON.stringify(pendQ.problems)), pendQ.grade);

  /* --- index robustness checks --- */
  const snap = VENUE_LIST().map(v => ({ mid: v.mid, ts: v.lastQuoteTs, bd: v.bidDepth, ad: v.askDepth }));
  const nowT = Date.now();
  VENUES.coinbase.mid = 62000; VENUES.coinbase.lastQuoteTs = nowT; VENUES.coinbase.bidDepth = 5; VENUES.coinbase.askDepth = 5;
  VENUES.kraken.mid = 62010; VENUES.kraken.lastQuoteTs = nowT; VENUES.kraken.bidDepth = 5; VENUES.kraken.askDepth = 5;
  VENUES.bitstamp.mid = 71000; VENUES.bitstamp.lastQuoteTs = nowT; VENUES.bitstamp.bidDepth = 5; VENUES.bitstamp.askDepth = 5;
  const r1 = computeIndex(nowT);
  push('index: rejects the 14%-off outlier venue', r1 && r1.rejected.some(x => x.venue === 'bitstamp') && !r1.used.includes('bitstamp'), JSON.stringify(r1 && r1.used));
  push('index: consensus lands between the two good venues', r1 && r1.value > 61999 && r1.value < 62011, r1 && round(r1.value, 2));
  VENUES.kraken.lastQuoteTs = nowT - 999999; VENUES.bitstamp.lastQuoteTs = nowT - 999999;
  const r2 = computeIndex(nowT);
  push('index: single surviving venue is flagged single-source', r2 && r2.single === true, JSON.stringify(r2 && r2.used));
  VENUES.coinbase.lastQuoteTs = nowT - 999999;
  push('index: all venues stale -> no index published', computeIndex(nowT) === null, 'null');
  VENUE_LIST().forEach((v, i) => { v.mid = snap[i].mid; v.lastQuoteTs = snap[i].ts; v.bidDepth = snap[i].bd; v.askDepth = snap[i].ad; });

  /* --- crossed / locked book rejection --- */
  const tv = mkVenue('t', { weight: 1 });
  tv.book.bids.set(100, 1); tv.book.asks.set(99, 1); bookRecompute(tv, nowT);
  push('book: crossed book is rejected, no mid published', !Number.isFinite(tv.mid), String(tv.mid));
  tv.book.asks.clear(); tv.book.asks.set(101, 1); bookRecompute(tv, nowT);
  push('book: valid book publishes a mid', tv.mid === 100.5, tv.mid);

  /* --- clock skew --- */
  const skewSnap = [...SKEW.samples];
  SKEW.samples.length = 0;
  for (let i = 0; i < 20; i++) noteSkew(1000000 + i, 1000000 + i - 250);
  push('skew: median estimate recovers a 250ms offset', Math.abs(SKEW.estMs - 250) < 1, SKEW.estMs);
  noteSkew(1000000, 1000000 - 500000);
  push('skew: absurd sample is discarded', Math.abs(SKEW.estMs - 250) < 1, SKEW.estMs);
  SKEW.samples.length = 0; skewSnap.forEach(s => SKEW.samples.push(s));
  if (SKEW.samples.length >= 5) SKEW.estMs = median(SKEW.samples); else SKEW.estMs = 0;

  const failed = checks.filter(c => !c.pass);
  return { ok: failed.length === 0, version: SERVER_VERSION, passed: checks.length - failed.length, total: checks.length, failed: failed.map(f => f.name), checks };
}

/* ---------------------- HTTP ---------------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') { cors(res); res.statusCode = 204; return res.end(); }
  try {
    if (req.method === 'GET' && u.pathname === '/health') {
      ensureStarted();
      const now = Date.now();
      return send(res, 200, {
        ok: true, version: SERVER_VERSION, service: 'btc-pin-radar',
        openaiEnabled: ENABLE_OPENAI, model: OPENAI_MODEL,
        uptimeSec: Math.round((now - bootTs) / 1000),
        streaming: WS_AVAILABLE && ENABLE_WS, wsImpl: WS_AVAILABLE ? (globalThis.WebSocket ? 'node-global' : 'ws-package') : 'none',
        venues: Object.fromEntries(VENUE_LIST().map(v => [v.name, {
          state: v.state, quoteAgeMs: v.lastQuoteTs ? now - v.lastQuoteTs : null,
          msgs: v.msgCount, reconnects: v.reconnects, mid: round(v.mid, 2),
          lastError: v.lastError, bookResets: v.bookResets || 0, trades60s: v.trades.filter(t => t[0] > now - 60000).length
        }])),
        index: { value: round(IDX.value, 2), ageMs: IDX.ts ? now - IDX.ts : null, venuesUsed: IDX.venuesUsed, dispersionBps: IDX.dispersionBps, ringSamples: IDX.ring.length, publishFails: IDX.publishFails, lastReason: IDX.lastReason },
        kalshi: { ticker: KAL.market && KAL.market.ticker, ageMs: KAL.ts ? now - KAL.ts : null, err: KAL.err, fails: KAL.consecutiveFails, latencyMs: KAL.lastLatencyMs, rateLimited: KAL.rateLimited, wsState: KAL.wsState, wsMsgs: KAL.wsMsgs },
        restFallbackActive: RESTF.active,
        clockSkewMs: Math.round(SKEW.estMs), clockSkewSamples: SKEW.samples.length,
        ts: now
      });
    }
    if (req.method === 'GET' && u.pathname === '/selftest') { const r = runSelfTest(); return send(res, r.ok ? 200 : 500, r); }
    if (req.method === 'GET' && u.pathname === '/flow') { ensureStarted(); return send(res, 200, { ...aggregateSpotFlow(), version: SERVER_VERSION }); }
    if (req.method === 'GET' && u.pathname === '/sentinel') { ensureStarted(); return send(res, 200, { ...(SENT.read || { ok: false }), version: SERVER_VERSION }); }
    if (req.method === 'GET' && u.pathname === '/index') {
      ensureStarted(); const now = Date.now();
      return send(res, 200, {
        ok: Number.isFinite(IDX.value), value: round(IDX.value, 2), ageMs: IDX.ts ? now - IDX.ts : null,
        venuesUsed: IDX.venuesUsed, venuesRejected: IDX.venuesRejected, dispersionBps: IDX.dispersionBps,
        settle60s: trailingMean(60), volBpsRootSec: round(indexVolBpsPerRootSec(), 3), driftBpsSec: round(indexDriftBpsPerSec(), 4),
        ringSamples: IDX.ring.length, version: SERVER_VERSION
      });
    }
    if (req.method === 'GET' && u.pathname === '/kalshi-auth') {
      ensureStarted();
      /* Deliberately exposes NO key material. Only: is a key present, is it
         structurally valid, a fingerprint of the PUBLIC half, whether a
         test signature verifies, and the live socket state. */
      const sign = kalshiSelfSignCheck();
      return send(res, 200, {
        ok: KALSHI_HAVE_CREDS && sign.ok && KAL.wsState === 'open',
        keyIdPresent: !!KALSHI_KEY_ID,
        keyIdLength: KALSHI_KEY_ID ? KALSHI_KEY_ID.length : 0,
        privateKeyPresent: KALSHI_KEY_INFO.present,
        privateKeyValid: KALSHI_KEY_INFO.valid,
        privateKeyType: KALSHI_KEY_INFO.type || null,
        privateKeyBits: KALSHI_KEY_INFO.bits || null,
        publicKeyFingerprint: KALSHI_KEY_INFO.fingerprint || null,
        keyError: KALSHI_KEY_INFO.error || null,
        signatureSelfCheck: sign.ok,
        signatureError: sign.error,
        wsState: KAL.wsState,
        wsMessages: KAL.wsMsgs,
        wsSubscribedTicker: KAL.wsSubscribedTicker,
        wsResubscribes: KAL.wsResubscribes,
        wsLastError: KAL.wsLastError,
        usingRestFallback: !KALSHI_HAVE_CREDS || KAL.wsState !== 'open',
        wsPackageAvailable: (() => { try { require('ws'); return true; } catch (_) { return false; } })(),
        hint: !KALSHI_KEY_ID ? 'set KALSHI_KEY_ID'
          : !KALSHI_KEY_INFO.valid ? 'KALSHI_PRIVATE_KEY problem: ' + KALSHI_KEY_INFO.error
            : KAL.wsState === 'http-401' ? 'signature rejected — key id and private key are probably from different API keys'
              : KAL.wsState === 'needs-ws-package' ? 'add "ws" to package.json dependencies'
                : KAL.wsState === 'open' ? 'authenticated websocket is live' : 'connecting'
      });
    }
    if (req.method === 'GET' && u.pathname === '/diag') {
      ensureStarted(); const now = Date.now();
      return send(res, 200, {
        ok: true, version: SERVER_VERSION, ts: now,
        quality: assessQuality(now, kalshiContext()),
        venues: Object.fromEntries(VENUE_LIST().map(v => [v.name, {
          state: v.state, msgs: v.msgCount, reconnects: v.reconnects, backoffMs: v.backoffMs,
          quoteAgeMs: v.lastQuoteTs ? now - v.lastQuoteTs : null, msgAgeMs: v.lastMsgTs ? now - v.lastMsgTs : null,
          bid: round(v.bid, 2), ask: round(v.ask, 2), bidDepth: round(v.bidDepth, 3), askDepth: round(v.askDepth, 3),
          bookLevels: v.book.bids.size + v.book.asks.size, trades: v.trades.length,
          lastError: v.lastError, lastErrorAgeMs: v.lastErrorTs ? now - v.lastErrorTs : null
        }])),
        index: { value: round(IDX.value, 2), ageMs: IDX.ts ? now - IDX.ts : null, ring: IDX.ring.length, rejected: IDX.venuesRejected, dispersionBps: IDX.dispersionBps },
        restFallback: RESTF,
        kalshi: {
          market: KAL.market && KAL.market.ticker, ageMs: KAL.ts ? now - KAL.ts : null,
          err: KAL.err, consecutiveFails: KAL.consecutiveFails, latencyMs: KAL.lastLatencyMs,
          rateLimited: KAL.rateLimited, wsState: KAL.wsState, wsMsgs: KAL.wsMsgs,
          wsSubscribedTicker: KAL.wsSubscribedTicker, wsResubscribes: KAL.wsResubscribes,
          wsLastError: KAL.wsLastError, credentialsLoaded: KALSHI_HAVE_CREDS
        },
        skew: { estMs: Math.round(SKEW.estMs), n: SKEW.samples.length }
      });
    }
    if (req.method === 'POST' && (u.pathname === '/radar' || u.pathname === '/pin')) {
      const body = await readBody(req); const out = await radar(body); return send(res, 200, out);
    }
    return send(res, 404, { ok: false, error: 'NOT_FOUND', path: u.pathname });
  } catch (e) { return send(res, 500, { ok: false, error: String(e.message || e) }); }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`btc-pin-radar ${SERVER_VERSION} on ${PORT} · streaming=${WS_AVAILABLE && ENABLE_WS} · openai=${ENABLE_OPENAI} · kalshiWs=${KALSHI_HAVE_CREDS ? 'authenticated (key ' + KALSHI_KEY_INFO.fingerprint + ')' : 'REST fallback — ' + (KALSHI_KEY_INFO.error || 'no credentials')}`));
  ensureStarted();
}
module.exports = {
  computePinPressure, getSpotFlow: aggregateSpotFlow, getKalshiContext: kalshiContext, radar, runSelfTest,
  volFromTape, driftFromTape, sentCompute, ensureSentinel: ensureStarted, getLivePrice: () => ({ ok: Number.isFinite(IDX.value), price: IDX.value, source: IDX.venuesUsed.join('+'), errors: [] }),
  settlementGeometry, computeIndex, trailingMean, indexVolBpsPerRootSec, volWarm, indexDriftBpsPerSec,
  parseKalshiMarket, chooseMarket, normaliseOrderbook, assessQuality, fuse,
  settleTailSurvival, settleTailCdf, reachProbability, impulseState, takerWindow,
  noteSkew, ageOfExchangeTs, bookRecompute, bookApply, mkVenue, connectVenue,
  normalisePem, redact, kalshiSelfSignCheck, kalshiWsSync, KALSHI_KEY_INFO,
  VENUES, IDX, SKEW, KAL, SENT, RESTF, server, ADAPTERS, kalshiPollOnce, sampleIndex, restFallbackTick, venueFresh
};
