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
/* The frontend compares this with === against its own VERSION constant.
   Bump BOTH files in the same commit, or the handshake alarm latches on
   and can no longer detect a genuinely stale deployment. */
const SERVER_VERSION = 'pin-radar-2.4';
/* Build marker so a DEPLOYED instance can be identified from /health
   without diffing files. Bump with every functional change. */
const BUILD_ID = '2.4-2026-10-12';
const BUILD_FIXES = ['settlement-tail-law', 'impulse-onset-gate', 'index-resolution-floor',
  'strike-override-guard', 'capital-weighted-book', 'kalshi-poll-race-guard',
  'adaptive-kalshi-cadence', 'strike-plausibility-guard', 'coinbase-last-match-excluded',
  'index-age-oldest-input', 'kalshi-ws-ticker-match', 'locked-window-coverage',
  // v2.4 (Oct 12 20:45 ET audit)
  'central-signal-classifier', 'basis-risk-in-probability', 'discrete-settlement-variance',
  'fast-vol-expansion', 'tau-scaled-staleness-gate', 'flat-mode-sticky-side', 'ai-off-hot-path',
  'settlement-tracker', 'signal-ledger', 'proven-lock-price-bound'];
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

/* Kalshi poll cadence. Measured from the Render region: /markets p50
   23 ms, /orderbook p50 50 ms, full cycle p50 72 ms. The fetch was never
   the bottleneck - the fixed 1 s interval was, contributing up to
   1,072 ms of strike/book staleness at the moment of decision. */
const KALSHI_POLL_MS = clampEnv(process.env.KALSHI_POLL_MS, 1000, 100, 10000);
const KALSHI_POLL_FAST_MS = clampEnv(process.env.KALSHI_POLL_FAST_MS, 250, 100, 10000);
const KALSHI_FAST_TAU_SEC = clampEnv(process.env.KALSHI_FAST_TAU_SEC, 120, 0, 900);

/* A client-supplied strike is a what-if override, never authority. If it
   disagrees with Kalshi's own strike it must not be able to render GREEN. */
const STRIKE_OVERRIDE_TOL_USD = clampEnv(process.env.STRIKE_OVERRIDE_TOL_USD, 1, 0, 1000);
/* v2.3 BUGFIX - STRIKE PLAUSIBILITY. Kalshi's own market record for
   KXBTC15M-26APR131115-15 carries floor_strike 7.243729 against a true
   strike of $72,437.29 (yes_sub_title; confirmed by the prior window's
   expiration_value). 26APR131130-30 has the same decimal shift. Nothing
   validated the field, so a $72k index read as 99 sigmas above a $7
   strike: GREEN / CLEAR / pAdverse 0.02%. A KXBTC15M strike is the
   previous window's settlement, so it cannot sit far from the live index;
   the largest |settle - strike| in 24,932 settled markets is $2,499 (~3%).
   20% is a corruption detector, not a market filter. */
const STRIKE_MAX_DEV_FRAC = clampEnv(process.env.STRIKE_MAX_DEV_FRAC, 0.2, 0.01, 1);

/* A venue's book can legitimately sit unchanged in a quiet market. We
   separate SOCKET liveness (messages, incl. heartbeats) from QUOTE change. */
const VENUE_SILENT_MS = Number(process.env.VENUE_SILENT_MS || 6000);
const VENUE_QUOTE_MAX_MS = Number(process.env.VENUE_QUOTE_MAX_MS || 30000);
const ENABLE_WS = /^(0|false|no)$/i.test(process.env.ENABLE_WS || '') ? false : true;
const REST_FALLBACK_MS = Number(process.env.REST_FALLBACK_MS || 1500);

/* =====================================================================
   v2.4 — LOCK-RISK ENGINE CONFIG  (2026-10-12 audit; see AUDIT_2.4)
   ---------------------------------------------------------------------
   Every default below was fitted on the TRAIN partition of the audit
   dataset (authentic Coinbase+Kraken tape, Kalshi official settlements)
   and checked on VALIDATION; none was tuned on the TEST partition or on
   the Oct 12 20:45 ET incident window.
   ===================================================================== */
const MODEL_VERSION = 'lockrisk-2.4.0';
/* Settlement print alignment: the 60 RTI prints are taken to sit at
   close-59 .. close (incl) - chosen because it minimised the proxy-vs-
   official error on TRAIN. 'excl' = close-60 .. close-1. */
const SETTLE_ALIGN = /^excl/i.test(process.env.SETTLE_ALIGN || '') ? 'excl' : 'incl';
/* Basis = official BRTI 60 s average minus our proxy's 60 s average.
   Prior from the audit dataset; updated online from every settled window
   (BASIS tracker). Student-t with BASIS_DF degrees of freedom. */
/* Audit (Sep 28 - Oct 12, 1,326 settled windows): official - proxy averaged
   +$1.88 (sd $3.59, max |e| $14.63) and its sign changed between periods,
   so the mean is tracked online (EWMA, half-life BASIS_EWMA_HL windows,
   which minimised TRAIN prediction error) and the spread is the EWMA
   prediction-error sd: TRAIN $3.14, VALIDATION $3.51 -> prior $3.5, t(8). */
const BASIS_MEAN_USD = clampEnv(process.env.BASIS_MEAN_USD, 0, -50, 50);
const BASIS_SD_USD = clampEnv(process.env.BASIS_SD_USD, 3.5, 0.1, 100);
const BASIS_DF = clampEnv(process.env.BASIS_DF, 8, 2.1, 1000);
const BASIS_PRIOR_N = clampEnv(process.env.BASIS_PRIOR_N, 50, 1, 100000);
const BASIS_EWMA_HL = clampEnv(process.env.BASIS_EWMA_HL, 4, 0.5, 1000);
const BASIS_MAX_SAMPLES = clampEnv(process.env.BASIS_MAX_SAMPLES, 400, 20, 100000);
/* Path model (selected on TRAIN): sigma = max(2.3 slow estimator, RMS over
   VOL_FAST_SEC, RMS over VOL_LONG_SEC). Residual law fitted to the ONE-SIDED
   toward-strike tail (the direction that flips the outcome), with a sigma
   multiplier KAPPA calibrated by maximum likelihood on TRAIN flip outcomes.
   Knots (tau seconds, A, B, KAPPA), log-tau interpolated, flat outside. */
const VOL_FAST_SEC = clampEnv(process.env.VOL_FAST_SEC, 30, 5, 300);
const VOL_LONG_SEC = clampEnv(process.env.VOL_LONG_SEC, 300, 60, 900);
const VOL_FAST_WEIGHT = clampEnv(process.env.VOL_FAST_WEIGHT, 1, 0, 3);
const PATH_KNOTS = [[3, 0.456, 0.878, 1.216], [25, 1.025, 1.739, 1.216], [130, 1.664, 2.577, 1.044]];
function pathLawForTau(tau) {
  const t = Math.min(PATH_KNOTS[PATH_KNOTS.length - 1][0], Math.max(PATH_KNOTS[0][0], Number(tau) || 0));
  const lt = Math.log(t);
  for (let i = 0; i < PATH_KNOTS.length - 1; i++) {
    const a = PATH_KNOTS[i], b = PATH_KNOTS[i + 1];
    if (t <= b[0]) { const f = (lt - Math.log(a[0])) / (Math.log(b[0]) - Math.log(a[0]));
      return { A: a[1] + f * (b[1] - a[1]), B: a[2] + f * (b[2] - a[2]), kappa: a[3] + f * (b[3] - a[3]) }; }
  }
  const k = PATH_KNOTS[PATH_KNOTS.length - 1]; return { A: k[1], B: k[2], kappa: k[3] };
}
const PATH_TAIL_A = PATH_KNOTS[2][1];
const PATH_TAIL_B = PATH_KNOTS[2][2];
/* Short-horizon momentum: E[future prints - X0] = MOMENTUM_BETA * (X0 - X_{-k}),
   k = MOMENTUM_LAG_SEC. 0 disables. Only enabled if it beat 0 out-of-sample. */
const MOMENTUM_BETA = clampEnv(process.env.MOMENTUM_BETA, 0, -2, 2);
const MOMENTUM_LAG_SEC = clampEnv(process.env.MOMENTUM_LAG_SEC, 5, 1, 60);
/* Conservative (decision) bound: vol x VOL_UNC_MULT, basis sd at its
   upper confidence bound, basis mean shifted adversely by BASIS_MEAN_UNC_K
   standard errors. Tiers are assigned on the conservative loss probability. */
const VOL_UNC_MULT = clampEnv(process.env.VOL_UNC_MULT, 1.25, 1, 3);
const BASIS_MEAN_UNC_K = clampEnv(process.env.BASIS_MEAN_UNC_K, 2, 0, 6);
/* Tier thresholds on the CONSERVATIVE loss probability (fractions). */
const TIER_LOCK_MAX = clampEnv(process.env.TIER_LOCK_MAX, 0.01, 1e-5, 0.2);
const TIER_HIGH_MAX = clampEnv(process.env.TIER_HIGH_MAX, 0.05, 1e-4, 0.4);
const TIER_MOD_MAX = clampEnv(process.env.TIER_MOD_MAX, 0.2, 1e-3, 0.5);
/* Reversal warning: the side you hold or were told is safe now carries at
   least this point loss probability. */
const REVERSAL_P = clampEnv(process.env.REVERSAL_P, 0.1, 0.01, 0.6);
const REVERSAL_JUMP_X = clampEnv(process.env.REVERSAL_JUMP_X, 4, 1.5, 100);
/* PROVEN LOCKED margin: every locked print may be overstated by this
   fraction of price and YES must still clear the strike with all remaining
   prints at $0. NO can never be proven before the last print. */
const PROVEN_MARGIN_FRAC = clampEnv(process.env.PROVEN_MARGIN_FRAC, 0.0025, 0, 0.1);
/* Data-age budget for lock-grade signals, shrinking with time-to-close:
   budget = clamp(STALE_BUDGET_FRAC * tau, STALE_BUDGET_MIN_MS, STALE_BUDGET_MAX_MS) */
const STALE_BUDGET_FRAC = clampEnv(process.env.STALE_BUDGET_FRAC, 100, 10, 1000);   // ms per second of tau
const STALE_BUDGET_MIN_MS = clampEnv(process.env.STALE_BUDGET_MIN_MS, 750, 100, 10000);
const STALE_BUDGET_MAX_MS = clampEnv(process.env.STALE_BUDGET_MAX_MS, 3000, 250, 30000);
const LOCK_VENUE_QUOTE_MAX_MS = clampEnv(process.env.LOCK_VENUE_QUOTE_MAX_MS, 2500, 100, 30000);
const MAX_DISPERSION_BPS_LOCK = clampEnv(process.env.MAX_DISPERSION_BPS_LOCK, 8, 0.5, 100);
/* Background classifier + ledger. */
const BG_TICK_MS = clampEnv(process.env.BG_TICK_MS, 500, 100, 10000);
const STATE_FILE = process.env.PINRADAR_STATE_FILE || '';
const SETTLE_POLL_MS = clampEnv(process.env.SETTLE_POLL_MS, 2000, 250, 60000);

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

/* =====================================================================
   v2.4 — LOCK-RISK MATH (pure functions, exported, unit-tested)
   ===================================================================== */
/* Residual law for the standardised settlement path residual (refit 2.4). */
function pathTailSurvival(x, A = PATH_TAIL_A, B = PATH_TAIL_B) {
  const z = Math.abs(Number(x)); if (!Number.isFinite(z)) return 1;
  const r = z / A; return Math.pow(1 + r * r, -B);
}
function pathTailCdf(x, A, B) { const s = pathTailSurvival(x, A, B) / 2; return x >= 0 ? 1 - s : s; }

/* Exact variance units of the 60-print simple average under a 1 Hz
   driftless random walk. Prints at close-59..close ('incl') or
   close-60..close-1 ('excl'); a print is "remaining" if it is strictly in
   the future. Var[S] = sigma^2 * units, sigma per root-second.
   Returns { units, nRemaining }. The 2.3 continuous formula understated
   the settlement sigma by 1.08x at t=10 s, 1.25x at 3 s, 1.73x at 1 s. */
function settleVarUnitsDiscrete(t, W = SETTLE_WINDOW_SEC, align = SETTLE_ALIGN) {
  const tt = Math.max(0, Number(t) || 0);
  const u = [];
  for (let j = 0; j < W; j++) {
    const off = align === 'excl' ? j + 1 : j;      // seconds before close
    const uu = tt - off;
    if (uu > 1e-9) u.push(uu);
  }
  u.sort((a, b) => a - b);
  const n = u.length; let s = 0;
  for (let i = 0; i < n; i++) s += u[i] * (2 * (n - 1 - i) + 1);
  return { units: s / (W * W), nRemaining: n };
}

/* Student-t density (location 0, scale 1). */
function tPdf(x, df) {
  if (df > 300) return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  const lg = v => { // Lanczos log-gamma
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (v < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * v)) - lg(1 - v);
    v -= 1; let a = c[0]; const t = v + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (v + i);
    return 0.5 * Math.log(2 * Math.PI) + (v + 0.5) * Math.log(t) - t + Math.log(a);
  };
  const lc = lg((df + 1) / 2) - lg(df / 2) - 0.5 * Math.log(df * Math.PI);
  return Math.exp(lc - (df + 1) / 2 * Math.log(1 + x * x / df));
}
/* Regularised incomplete beta I_x(a,b) (continued fraction, Lentz). */
function incBeta(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const lg = v => { const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (v < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * v)) - lg(1 - v);
    v -= 1; let s = c[0]; const t = v + g + 0.5; for (let i = 1; i < g + 2; i++) s += c[i] / (v + i);
    return 0.5 * Math.log(2 * Math.PI) + (v + 0.5) * Math.log(t) - t + Math.log(s); };
  const bt = Math.exp(lg(a + b) - lg(a) - lg(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (x, a, b) => {
    const FP = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FP) d = FP; d = 1 / d; let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? bt * cf(x, a, b) / a : 1 - bt * cf(1 - x, b, a) / b;
}
/* Student-t CDF (location 0, scale 1). */
function tCdfExact(x, df) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  if (df > 300) return normCdf(x);
  const ib = incBeta(df / (df + x * x), df / 2, 0.5);
  return x >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}
/* Hot-path version: a 0.001-step table over [-80, 80] built once per df
   (measured max interpolation error 2.9e-8 absolute, 3e-7 relative below
   a CDF of 0.05; checked in selftest). */
const T_CDF_TABLES = new Map();
function tCdf(x, df) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  if (df > 300) return normCdf(x);
  const key = Math.round(df * 100) / 100;
  let tb = T_CDF_TABLES.get(key);
  if (!tb) { const N = 160000, h = 160 / N, v = new Float64Array(N + 1); for (let i = 0; i <= N; i++) v[i] = tCdfExact(-80 + i * h, key); tb = { v, h, N }; T_CDF_TABLES.set(key, tb); }
  if (x <= -80 || x >= 80) return tCdfExact(x, key);
  const f = (x + 80) / tb.h, i = Math.floor(f), r = f - i;
  return tb.v[i] + r * (tb.v[i + 1] - tb.v[i]);
}
/* Density of the signed standardised path residual implied by the
   two-sided survival (1+(z/A)^2)^-B. */
function pathDensity(z, A = PATH_TAIL_A, B = PATH_TAIL_B) {
  const a2 = A * A; return B * Math.abs(z) / a2 * Math.pow(1 + z * z / a2, -B - 1);
}
/* sinh-spaced Simpson grid on [-R, R]: dense near 0, reaches far tails. */
function sinhGrid(R, N = 400) {
  const U = Math.asinh(R), pts = [];
  for (let i = 0; i <= N; i++) {
    const u = -U + 2 * U * i / N;
    pts.push([Math.sinh(u), (i === 0 || i === N ? 1 : (i % 2 ? 4 : 2)) * (2 * U / N) / 3 * Math.cosh(u)]);
  }
  return pts;
}
const PATH_GRID = sinhGrid(400, 600);
const PATH_W = new Map();
function pathWeights(A = PATH_TAIL_A, B = PATH_TAIL_B) {
  const k = A.toFixed(4) + ':' + B.toFixed(4);
  if (PATH_W.has(k)) return PATH_W.get(k);
  let tot = 0; const w = PATH_GRID.map(([z, wq]) => { const v = pathDensity(z, A, B) * wq; tot += v; return v; });
  const out = w.map(v => v / tot); PATH_W.set(k, out); return out;
}
/* P(official settlement lands on the losing side for `side`).
     gapUsd     = E[proxy settlement] - strike
     sigmaUsd   = scale of the proxy-settlement path residual (tail law)
     basis      = { mean, sd, df }:  S_true = S_proxy + e, e ~ mean + scale*t(df)
   YES (ABOVE) loses iff S_true < K ; NO (BELOW) loses iff S_true >= K.
   The narrower of the two error terms is integrated numerically against
   the closed-form CDF of the wider one, so neither limit (sigma -> 0 in the
   last second, or basis -> 0) produces a discontinuous integrand. */
function lossProbability({ gapUsd, sigmaUsd, basis, side, tailA = PATH_TAIL_A, tailB = PATH_TAIL_B }) {
  if (!Number.isFinite(gapUsd)) return null;
  const b = basis || { mean: 0, sd: 0, df: 1000 };
  const df = Math.max(2.1, b.df || 1000);
  const mean = b.mean || 0;
  const scaleE = (b.sd || 0) > 0 ? b.sd * Math.sqrt(df > 300 ? 1 : (df - 2) / df) : 0;
  const sig = Math.max(0, Number(sigmaUsd) || 0);
  const y0 = -(gapUsd + mean);                 // YES loses iff R + e' < y0, e' = e - mean
  let p;
  if (sig < 1e-9 && scaleE < 1e-9) p = y0 > 0 ? 1 : (y0 === 0 ? 0.5 : 0);
  else if (sig <= scaleE) {
    if (sig < 1e-9) p = tCdf(y0 / scaleE, df);
    else { const w = pathWeights(tailA, tailB); p = 0;
      for (let i = 0; i < PATH_GRID.length; i++) p += w[i] * tCdf((y0 - sig * PATH_GRID[i][0]) / scaleE, df); }
  } else {
    if (scaleE < 1e-9) p = pathTailCdf(y0 / sig, tailA, tailB);
    else { const w = tWeights(df); p = 0;
      for (let i = 0; i < BASIS_GRID.length; i++) p += w[i] * pathTailCdf((y0 - scaleE * BASIS_GRID[i][0]) / sig, tailA, tailB); }
  }
  p = Math.min(1, Math.max(0, p));
  return side === 'BELOW' ? 1 - p : p;
}
const BASIS_GRID = sinhGrid(200, 600);
const T_WEIGHTS = new Map();
function tWeights(df) {
  const k = Math.round(df * 100) / 100;
  if (T_WEIGHTS.has(k)) return T_WEIGHTS.get(k);
  let tot = 0; const w = BASIS_GRID.map(([x, wq]) => { const v = tPdf(x, k) * wq; tot += v; return v; });
  const out = w.map(v => v / tot); T_WEIGHTS.set(k, out); return out;
}
/* Budget for the age of any lock-critical input, shrinking into the close. */
function staleBudgetMs(tau) {
  return clamp(STALE_BUDGET_FRAC * Math.max(0, Number(tau) || 0), STALE_BUDGET_MIN_MS, STALE_BUDGET_MAX_MS);
}
/* Upper 95% one-sided Clopper-Pearson bound for k losses in n trials. */
function binomUpper(k, n, conf = 0.95) {
  if (!(n > 0)) return 1;
  if (k >= n) return 1;
  const cdf = (p) => { // P(X <= k | n, p)
    let s = 0, lp = n * Math.log(1 - p);
    for (let i = 0; i <= k; i++) {
      if (i > 0) lp += Math.log((n - i + 1) / i) + Math.log(p) - Math.log(1 - p);
      s += Math.exp(lp);
    }
    return s;
  };
  let lo = k / n, hi = 1 - 1e-12;
  for (let it = 0; it < 80; it++) { const m = (lo + hi) / 2; if (cdf(m) > 1 - conf) lo = m; else hi = m; }
  return hi;
}
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
        /* v2.4: Coinbase ticker sequence numbers are monotonic per product;
           never let an older message overwrite a newer quote. */
        const seq = Number(j.sequence);
        if (Number.isFinite(seq) && Number.isFinite(v.lastTickerSeq) && seq <= v.lastTickerSeq) { v.outOfOrder = (v.outOfOrder || 0) + 1; return true; }
        if (Number.isFinite(seq)) v.lastTickerSeq = seq;
        const bb = Number(j.best_bid), ba = Number(j.best_ask);
        setTopOfBook(v, bb, ba, now);
        const ets = Date.parse(j.time); if (Number.isFinite(ets)) { v.lastExchangeTs = ets; noteSkew(now, ets); }
        return true;
      }
      /* v2.3 BUGFIX. Coinbase sends `last_match` as the FIRST message after
         every matches subscription: the most recent historical trade, which
         may be minutes old. It was stamped with local receipt time and
         pushed into the live taker window on every (re)connect, where a
         single stale print can satisfy every impulse gate. Its exchange
         timestamp would also pollute the skew median. Ignore it. */
      if (j.type === 'last_match') return true;
      if (j.type === 'match') {
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
  const cut = now - (Math.max(130, VOL_LONG_SEC + 10)) * 1000;     // v2.4: 310 s for the long vol window
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
   v2.4 — LOCK GEOMETRY
   Same settled quantity as settlementGeometry() (60 s simple average) but:
     - locked prints are taken from the ring by the ACTUAL close timestamp,
       not by "the last W-t seconds" (robust to sampler phase and gaps);
     - exact 1 Hz discrete variance (settleVarUnitsDiscrete);
     - fast realised vol joins the slow estimator (max), so a vol
       expansion is priced within VOL_FAST_SEC instead of ~120 s;
     - variance is inflated for the age of the newest input;
     - basis (proxy vs official BRTI) risk is integrated into the loss
       probability for BOTH sides, point and conservative;
     - a price-only PROVEN check (YES only, zero-floor bound).
   ===================================================================== */
function indexVolFast(lookbackSec = VOL_FAST_SEC, now = Date.now()) {
  const cut = now - lookbackSec * 1000;
  const pts = IDX.ring.filter(p => p[0] >= cut);
  if (pts.length < Math.max(5, Math.floor(lookbackSec / 3))) return null;
  let s2 = 0, n = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = Math.max(0.25, (pts[i][0] - pts[i - 1][0]) / 1000);
    if (!(pts[i - 1][1] > 0)) continue;
    const r = (pts[i][1] - pts[i - 1][1]) / pts[i - 1][1] * 1e4 / Math.sqrt(dt);
    if (Number.isFinite(r)) { s2 += r * r; n++; }
  }
  return n >= 4 ? Math.sqrt(s2 / n) : null;
}
function indexAt(msAgo, now = Date.now()) {
  const target = now - msAgo; let best = null;
  for (let i = IDX.ring.length - 1; i >= 0; i--) { if (IDX.ring[i][0] <= target) { best = IDX.ring[i]; break; } }
  return best ? best[1] : NaN;
}
function lockGeometry({ indexNow, strike, closeMs, now = Date.now(), sigmaSlow, sigmaFast, sigmaLong, inputAgeMs = 0,
  basis, ring = IDX.ring, momentumRef = NaN }) {
  const W = SETTLE_WINDOW_SEC;
  if (!Number.isFinite(indexNow) || !Number.isFinite(strike) || !Number.isFinite(closeMs)) return null;
  const tau = (closeMs - now) / 1000;
  const { units, nRemaining } = settleVarUnitsDiscrete(tau, W, SETTLE_ALIGN);
  const nLock = W - nRemaining;
  // locked prints: ring samples inside the settlement window, up to now
  const winStart = closeMs - (SETTLE_ALIGN === 'excl' ? W + 1 : W) * 1000 + 500;
  let lsum = 0, lobs = 0;
  if (nLock > 0) for (const p of ring) if (p[0] >= winStart && p[0] <= now) { lsum += p[1]; lobs++; }
  const lockedMean = lobs ? lsum / lobs : NaN;
  const coverage = nLock > 0 ? lobs / nLock : 1;
  const sSlow = Number.isFinite(sigmaSlow) ? sigmaSlow : VOL_PRIOR;
  const sFast = Number.isFinite(sigmaFast) ? sigmaFast * VOL_FAST_WEIGHT : 0;
  const sLong = Number.isFinite(sigmaLong) ? sigmaLong : 0;
  const sigBps = Math.max(sSlow, sFast, sLong);
  const law = pathLawForTau(tau);
  const mom = (MOMENTUM_BETA !== 0 && Number.isFinite(momentumRef)) ? MOMENTUM_BETA * (indexNow - momentumRef) : 0;
  const fut = indexNow + mom;
  let expSettle;
  if (nLock > 0 && Number.isFinite(lockedMean)) expSettle = (lockedMean * nLock + fut * nRemaining) / W;
  else expSettle = fut;
  const gapUsd = expSettle - strike;
  // staleness: the newest input is `a` seconds old; the unobserved move
  // over that interval feeds every remaining print and the prints locked
  // during the stale interval.
  const a = Math.max(0, inputAgeMs) / 1000;
  const staleUnits = a * Math.pow(Math.min(W, nRemaining + Math.min(nLock, a)) / W, 2);
  const pxPerBps = indexNow / 1e4;
  const sigmaUsd = law.kappa * sigBps * pxPerBps * Math.sqrt(Math.max(0, units + staleUnits));
  const sigmaUsdCons = sigmaUsd * VOL_UNC_MULT;
  const b = basis || basisModel();
  const bPoint = { mean: b.mean, sd: b.sd, df: b.df };
  const consFor = side => ({ mean: b.mean + (side === 'ABOVE' ? -1 : 1) * BASIS_MEAN_UNC_K * b.se, sd: b.sdUpper, df: b.df });
  const pYesLoss = lossProbability({ gapUsd, sigmaUsd, basis: bPoint, side: 'ABOVE', tailA: law.A, tailB: law.B });
  const pl = { ABOVE: pYesLoss, BELOW: pYesLoss == null ? null : 1 - pYesLoss };
  const plc = {
    ABOVE: lossProbability({ gapUsd, sigmaUsd: sigmaUsdCons, basis: consFor('ABOVE'), side: 'ABOVE', tailA: law.A, tailB: law.B }),
    BELOW: lossProbability({ gapUsd, sigmaUsd: sigmaUsdCons, basis: consFor('BELOW'), side: 'BELOW', tailA: law.A, tailB: law.B })
  };
  // PROVEN (price-only) for YES: locked observed prints, each discounted by
  // the margin, with every missing locked print and every remaining print
  // taken as $0, must still average >= strike.
  const provenYes = nLock > 0 && lobs > 0 && ((1 - PROVEN_MARGIN_FRAC) * lsum) / W >= strike;
  return {
    model: MODEL_VERSION, tau: round(tau, 3), nRemaining, nLock, lockedObserved: lobs,
    lockedCoverage: round(coverage, 3), lockedMean: Number.isFinite(lockedMean) ? round(lockedMean, 2) : null,
    expectedSettle: round(expSettle, 2), gapUsd: round(gapUsd, 2), cushionUsd: round(Math.abs(gapUsd), 2),
    leader: gapUsd >= 0 ? 'ABOVE' : 'BELOW',
    sigmaBps: round(sigBps, 4), sigmaSlowBps: round(sSlow, 4), sigmaFastBps: Number.isFinite(sigmaFast) ? round(sigmaFast, 4) : null,
    sigmaLongBps: Number.isFinite(sigmaLong) ? round(sigmaLong, 4) : null, kappa: round(law.kappa, 4), tailA: round(law.A, 4), tailB: round(law.B, 4),
    varUnits: round(units, 6), staleUnits: round(staleUnits, 6), inputAgeMs: Math.round(Math.max(0, inputAgeMs)),
    sigmaUsd: round(sigmaUsd, 3), sigmaUsdCons: round(sigmaUsdCons, 3), momentumUsd: round(mom, 2),
    basis: { mean: round(b.mean, 3), sd: round(b.sd, 3), sdUpper: round(b.sdUpper, 3), se: round(b.se, 3), df: b.df, n: b.n, source: b.source },
    pLoss: { ABOVE: pl.ABOVE, BELOW: pl.BELOW },
    pLossCons: { ABOVE: plc.ABOVE, BELOW: plc.BELOW },
    proven: { ABOVE: provenYes, BELOW: false },
    requiredIndexMoveUsd: nRemaining > 0 ? round(Math.abs(gapUsd) * W / nRemaining, 2) : null
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
  inFlight: false, seq: 0, overlapSkips: 0, stopped: false,
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
  /* v2.2 RACE FIX. This was driven by setInterval(fn, 1000) while the
     body can block up to 3.5 s on a fetch timeout. Two invocations could
     therefore overlap, and the slower one's older response could land
     last and overwrite fresher state. Entry is now guarded and every
     write is stamped with a monotonic sequence so a late response from
     an earlier attempt is discarded. */
  if (KAL.inFlight) { KAL.overlapSkips = (KAL.overlapSkips || 0) + 1; return; }
  KAL.inFlight = true;
  const seq = ++KAL.seq;
  const t0 = Date.now();
  try {
    /* `status=open` returns ONLY the single currently-active window, so at
       every 15-minute rollover it briefly returns nothing and the radar
       goes blind (observed: 24 s of STALE in a live calibration run).
       Upcoming windows carry status=initialized. A bounded close_ts query
       with no status filter returns the active window AND the next one. */
    const nowSec = Math.floor(Date.now() / 1000);
    /* In the late window we already know the ticker, so we poll the
       single market (2,131 B measured) instead of the series query
       (4,148 B measured). Smaller payload, lower latency, and it halves
       the bandwidth cost of the faster cadence. We still fall back to
       the wide query near the rollover so the next window is discovered. */
    const cur = KAL.market;
    const tauNow = cur && Number.isFinite(cur.closeMs) ? (cur.closeMs - Date.now()) / 1000 : Infinity;
    const useSingle = !!(cur && Number.isFinite(cur.strike) && tauNow > 3 && tauNow <= KALSHI_FAST_TAU_SEC);
    let mk;
    if (useSingle) {
      const sj = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(cur.ticker)}`, {}, 2500);
      mk = parseKalshiMarket(sj && (sj.market || sj));
      if (!mk || !Number.isFinite(mk.closeMs) || mk.closeMs <= Date.now()) mk = null;
    }
    if (!mk) {
      const mj = await fetchJson(`${KALSHI_BASE}/markets?series_ticker=${encodeURIComponent(KALSHI_SERIES)}&min_close_ts=${nowSec}&max_close_ts=${nowSec + 1800}&limit=20`, {}, 3500);
      mk = chooseMarket(Array.isArray(mj.markets) ? mj.markets : [], Date.now());
    }
    if (!mk) throw new Error('no open ' + KALSHI_SERIES + ' market');
    if (seq !== KAL.seq) return;                 // a newer poll already won
    // Fetch the book only if we changed market or the book is >1.5 s old.
    let needBook = !KAL.ob || KAL.ob.ticker !== mk.ticker || (Date.now() - KAL.obTs) > 1500;
    if (needBook) {
      const ob = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(mk.ticker)}/orderbook?depth=20`, {}, 3000).catch(() => null);
      if (ob && seq === KAL.seq) { KAL.ob = normaliseOrderbook(ob, mk.ticker); KAL.obTs = Date.now(); }
    }
    if (seq !== KAL.seq) return;
    /* v2.4: a rollover hands the just-closed window to the settlement
       tracker (AWAITING SETTLEMENT -> SETTLED) and freezes our own proxy
       estimate of its 60 s average for the basis tracker. */
    if (KAL.market && KAL.market.ticker !== mk.ticker && Number.isFinite(KAL.market.closeMs)
      && KAL.market.closeMs <= Date.now() + 1500) noteWindowClosed(KAL.market);
    KAL.market = mk; KAL.ts = Date.now(); KAL.err = null; KAL.consecutiveFails = 0;
    kalshiWsSync();
    KAL.rateLimited = false; KAL.lastLatencyMs = Date.now() - t0;
  } catch (e) {
    const msg = String(e.message || e);
    KAL.err = msg; KAL.consecutiveFails++;
    if (/429/.test(msg)) { KAL.rateLimited = true; KAL.rateLimitedUntil = Date.now() + 5000; }
    KAL.lastLatencyMs = Date.now() - t0;
  } finally { KAL.inFlight = false; }
}
/* Self-scheduling replacement for setInterval: never overlaps, and runs
   fast inside the final KALSHI_FAST_TAU_SEC where strike/book staleness
   actually changes a decision. */
function kalshiScheduleNext() {
  if (KAL.stopped) return;
  const m = KAL.market;
  const tau = m && Number.isFinite(m.closeMs) ? (m.closeMs - Date.now()) / 1000 : Infinity;
  const delay = tau <= KALSHI_FAST_TAU_SEC ? KALSHI_POLL_FAST_MS : KALSHI_POLL_MS;
  KAL.timer = setTimeout(async () => { await kalshiPollOnce(); kalshiScheduleNext(); }, delay);
  if (KAL.timer.unref) KAL.timer.unref();
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
  /* v2.2 BUGFIX - CAPITAL-WEIGHTED BOOK IMBALANCE.
     Contract counts are not comparable across the two sides of a binary
     book, because one side is cheap. Measured live on
     KXBTC15M-26SEP121430-30 at 98.3/98.8:
        near-touch YES    8,910 contracts @ ~98c  = $8,733 at risk
        near-touch NO   470,598 contracts @ ~1.3c = $6,118 at risk
     Count ratio 53:1 (imbalance -0.963); capital ratio 1.43:1
     (imbalance +0.176). The count version fed up to 37 points of
     pinPressure at tau->0 purely because the contract was near-certain,
     which is exactly when this tool is used. Imbalance is now measured
     in capital at risk; the count version is kept for diagnostics only
     and is NOT used in any decision. */
  const nearYesCap = yes.filter(x => bestYes - x[0] <= 5).reduce((a, x) => a + x[0] * x[1], 0) / 100;
  const nearNoCap = no.filter(x => bestNo - x[0] <= 5).reduce((a, x) => a + x[0] * x[1], 0) / 100;
  const capDenom = nearYesCap + nearNoCap;
  return {
    ticker, yes, no, bestYes, bestNo,
    yesDepth: round(yesDepth, 0), noDepth: round(noDepth, 0),
    nearYesDepth: round(nearYes, 0), nearNoDepth: round(nearNo, 0),
    nearYesCapitalUsd: round(nearYesCap, 0), nearNoCapitalUsd: round(nearNoCap, 0),
    bookImbalance: capDenom > 0 ? round((nearYesCap - nearNoCap) / capDenom, 3) : 0,
    bookImbalanceCount: denom > 0 ? round((nearYes - nearNo) / denom, 3) : 0,
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
    bookImbalanceCount: ob ? ob.bookImbalanceCount : 0,
    nearYesCapitalUsd: ob ? ob.nearYesCapitalUsd : null,
    nearNoCapitalUsd: ob ? ob.nearNoCapitalUsd : null,
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
  KAL.stopped = false;
  kalshiPollOnce().then(kalshiScheduleNext, kalshiScheduleNext);
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
  ws.on('message', kalshiWsHandleMessage);
  ws.on('close', () => { KAL.wsState = 'closed'; KAL.wsSubscribedTicker = null; scheduleKalshiWs(); });
  ws.on('error', e => { KAL.wsState = 'error: ' + redact(e); KAL.wsLastError = redact(e); });
  ws.on('unexpected-response', (q, r) => {
    KAL.wsState = 'http-' + r.statusCode;
    KAL.wsLastError = r.statusCode === 401
      ? 'HTTP 401 — Kalshi rejected the signature. Check KALSHI_KEY_ID matches the key, and that server time is correct.'
      : 'HTTP ' + r.statusCode;
  });
}
/* v2.3 BUGFIX. At every 15-minute rollover the REST poller swaps KAL.market
   to the new window while the socket is still subscribed to the old one
   (the unsubscribe is sent afterwards, and in-flight messages still land).
   The handler wrote any ticker's yes_bid/yes_ask into the CURRENT market
   and refreshed KAL.ts, so the just-settled window's ~99c quote could be
   shown as the new window's price, marked fresh. A message that names a
   different market is now ignored; one with no market_ticker keeps the
   previous behaviour. Behaviour is otherwise unchanged. */
function kalshiWsHandleMessage(d) {
  KAL.wsMsgs++;
  try {
    const j = JSON.parse(String(d));
    if (j.type === 'ticker' || j.type === 'ticker_v2') {
      const m = j.msg || {};
      if (KAL.market && (!m.market_ticker || m.market_ticker === KAL.market.ticker)) {
        const yb = Number(m.yes_bid), ya = Number(m.yes_ask);
        if (Number.isFinite(yb)) KAL.market.yesBid = yb;
        if (Number.isFinite(ya)) KAL.market.yesAsk = ya;
        KAL.ts = Date.now();
      }
    }
  } catch (_) { }
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
    if (sg && sg.lockedFrac > 0.15) reasons.push(`${Math.round(sg.lockedFrac * 100)}% of the 60 settlement prints have printed (average so far $${sg.knownMean ?? '?'}) - elapsed time, not outcome certainty`);
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

/* =====================================================================
   v2.4 — BASIS TRACKER (proxy vs official BRTI 60 s average)
   One sample per settled window: e = official expiration_value minus our
   own ring average over the same 60 prints. Seeds from the audit prior and
   learns online, so the engine measures its own instrument error instead
   of assuming it.
   ===================================================================== */
const BASIS = { samples: [], byKey: new Set() };
function chi2LowerQuantile(k, z = -1.6449) {           // Wilson-Hilferty, 5% lower
  const a = 2 / (9 * k); return Math.max(1e-6, k * Math.pow(1 - a + z * Math.sqrt(a), 3));
}
function basisModel() {
  /* Mean = EWMA of past errors (the prediction for the NEXT window);
     spread = sd of the one-step EWMA prediction errors, pooled with the
     audit prior. This is exactly the quantity validated in the audit. */
  const n = BASIS.samples.length, n0 = BASIS_PRIOR_N, a = 1 - Math.pow(0.5, 1 / BASIS_EWMA_HL);
  let m = BASIS_MEAN_USD, ss = 0;
  for (const s of BASIS.samples) { const pe = s.e - m; ss += pe * pe; m += a * pe; }
  const N = n0 + n, k = Math.max(2, N - 1);
  const sd = Math.sqrt((n0 * BASIS_SD_USD * BASIS_SD_USD + ss) / k);
  return { mean: m, sd, sdUpper: sd * Math.sqrt(k / chi2LowerQuantile(k)), se: sd / Math.sqrt(n0), df: BASIS_DF, n,
    source: n ? `audit prior (n0=${n0}) + ${n} live windows, EWMA hl ${BASIS_EWMA_HL}` : `audit prior (n0=${n0}), EWMA hl ${BASIS_EWMA_HL}` };
}
function addBasisSample(key, proxyAvg, official, meta = {}) {
  if (!Number.isFinite(proxyAvg) || !Number.isFinite(official) || BASIS.byKey.has(key)) return false;
  const e = official - proxyAvg;
  if (Math.abs(e) > Math.max(250, official * 0.005)) return false;   // corrupted-record guard
  BASIS.byKey.add(key);
  BASIS.samples.push({ key, e: round(e, 2), proxy: round(proxyAvg, 2), official, ts: Date.now(), ...meta });
  BASIS.samples.sort((x, y) => String(x.key).localeCompare(String(y.key)));
  while (BASIS.samples.length > BASIS_MAX_SAMPLES) { const x = BASIS.samples.shift(); BASIS.byKey.delete(x.key); }
  return true;
}

/* =====================================================================
   v2.4 — SETTLEMENT TRACKER
   AWAITING SETTLEMENT from the close until Kalshi publishes the result
   (observed 4.6 s after the Oct 12 20:45 ET close), then SETTLED.
   ===================================================================== */
const SETTLE = { pending: new Map(), done: [], timer: null };
function proxyWindowAverage(closeMs) {
  const W = SETTLE_WINDOW_SEC;
  const start = closeMs - (SETTLE_ALIGN === 'excl' ? W + 1 : W) * 1000 + 500;
  const end = closeMs + 500 - (SETTLE_ALIGN === 'excl' ? 1000 : 0);
  let s = 0, n = 0; for (const p of IDX.ring) if (p[0] >= start && p[0] <= end) { s += p[1]; n++; }
  return { mean: n ? s / n : NaN, n };
}
function noteWindowClosed(m) {
  if (!m || !m.ticker || SETTLE.pending.has(m.ticker) || SETTLE.done.some(d => d.ticker === m.ticker)) return;
  SETTLE.pending.set(m.ticker, { ticker: m.ticker, closeMs: m.closeMs, openMs: m.openMs, strike: m.strike,
    proxyAvg: NaN, proxyN: 0, notedAt: Date.now(), polls: 0, status: 'AWAITING SETTLEMENT' });
  if (!SETTLE.timer && !process.env.PINRADAR_REPLAY) {
    SETTLE.timer = setInterval(() => { settlePollOnce().catch(() => { }); }, SETTLE_POLL_MS);
    if (SETTLE.timer.unref) SETTLE.timer.unref();
  }
}
function finalizeWindow(p, result, official, source) {
  p.status = 'SETTLED'; p.result = result; p.official = official; p.settledAt = Date.now(); p.source = source;
  if (Number.isFinite(p.proxyAvg) && p.proxyN >= SETTLE_WINDOW_SEC - 3) {
    p.proxyErr = round(official - p.proxyAvg, 2);
    addBasisSample('close:' + p.closeMs, p.proxyAvg, official, { ticker: p.ticker, n: p.proxyN });
  }
  ledgerFinalize(p.ticker, result, official);
  SETTLE.pending.delete(p.ticker);
  SETTLE.done.unshift(p); if (SETTLE.done.length > 50) SETTLE.done.pop();
  saveStateSoon();
}
async function settlePollOnce(now = Date.now()) {
  for (const p of [...SETTLE.pending.values()]) {
    if (!Number.isFinite(p.proxyAvg) && now >= p.closeMs + 1500) {
      const pa = proxyWindowAverage(p.closeMs); p.proxyAvg = pa.mean; p.proxyN = pa.n;
    }
    if (now < p.closeMs + 2500) continue;
    if (now - p.closeMs > 30 * 60000) { p.status = 'UNRESOLVED'; SETTLE.pending.delete(p.ticker); SETTLE.done.unshift(p); continue; }
    p.polls++;
    try {
      const j = await fetchJson(`${KALSHI_BASE}/markets/${encodeURIComponent(p.ticker)}`, {}, 2500);
      const m = j && (j.market || j);
      const res = m && String(m.result || '').toLowerCase();
      const ev = Number(m && m.expiration_value);
      if ((res === 'yes' || res === 'no') && Number.isFinite(ev)) finalizeWindow(p, res, ev, 'kalshi-result');
    } catch (_) { /* retried next tick */ }
  }
}

/* =====================================================================
   v2.4 — SIGNAL LEDGER (out-of-sample validation that accrues in prod)
   The background classifier evaluates BOTH sides every BG_TICK_MS whether
   or not anyone is watching, records the FIRST time each side reaches each
   tier in each window, and scores it against Kalshi's official result.
   One record per (window, side, tier): repeated ticks inside a window are
   never counted as independent evidence.
   ===================================================================== */
const LEDGER = { open: new Map(), closed: [], version: 0, statsCache: null, statsVersion: -1 };
const LEDGER_TIERS = ['PROVEN LOCKED', 'PREDICTED LOCK', 'HIGH CONFIDENCE', 'MODERATE CONFIDENCE'];
const STATE_RANK = { 'DATA UNRELIABLE': -1, 'SIT OUT': 1, 'REVERSAL WARNING': 1, 'MODERATE CONFIDENCE': 2,
  'HIGH CONFIDENCE': 3, 'PREDICTED LOCK': 4, 'PROVEN LOCKED': 5 };
function ledgerNote(ticker, closeMs, strike, side, tier, info) {
  if (!ticker) return;
  let w = LEDGER.open.get(ticker);
  if (!w) { w = { ticker, closeMs, strike, ev: { ABOVE: {}, BELOW: {} } }; LEDGER.open.set(ticker, w); }
  const slot = w.ev[side]; if (!slot || slot[tier]) return;
  slot[tier] = info;
}
function ledgerFinalize(ticker, result, official) {
  const w = LEDGER.open.get(ticker); if (!w) return;
  LEDGER.open.delete(ticker);
  const winner = result === 'yes' ? 'ABOVE' : 'BELOW';
  for (const side of ['ABOVE', 'BELOW']) for (const [tier, info] of Object.entries(w.ev[side])) {
    LEDGER.closed.push({ ticker, closeMs: w.closeMs, side, tier, won: side === winner, official, strike: w.strike, ...info });
  }
  if (LEDGER.closed.length > 20000) LEDGER.closed.splice(0, LEDGER.closed.length - 20000);
  LEDGER.version++;
}
const TAU_BUCKETS = [[0, 10], [10, 30], [30, 60], [60, 120], [120, 300], [300, 900]];
function ledgerStats(records = LEDGER.closed) {
  /* cached: /radar reads this on every poll; it only changes at settlement */
  if (records === LEDGER.closed && LEDGER.statsCache && LEDGER.statsVersion === LEDGER.version) return LEDGER.statsCache;
  const out = {};
  for (const tier of [...LEDGER_TIERS, 'REVERSAL WARNING']) {
    const rs = records.filter(r => r.tier === tier);
    const losses = rs.filter(r => (tier === 'REVERSAL WARNING') ? r.won : !r.won).length;
    const n = rs.length;
    out[tier] = { n, losses, rate: n ? round(losses / n, 4) : null, upper95: n ? round(binomUpper(losses, n), 4) : null,
      meanTau: n ? round(rs.reduce((a, r) => a + (r.tau || 0), 0) / n, 1) : null,
      byTau: TAU_BUCKETS.map(([a, b]) => { const q = rs.filter(r => r.tau >= a && r.tau < b); const l = q.filter(r => tier === 'REVERSAL WARNING' ? r.won : !r.won).length; return { tau: a + '-' + b, n: q.length, losses: l }; }) };
  }
  out.windows = new Set(records.map(r => r.ticker)).size;
  out.note = 'losses = records whose side did NOT win (REVERSAL WARNING: warned side that went on to win, i.e. false alarms)';
  if (records === LEDGER.closed) { LEDGER.statsCache = out; LEDGER.statsVersion = LEDGER.version; }
  return out;
}
/* Measured on the untouched TEST partition of the audit: 398 settled windows,
   KXBTC15M-26OCT081900-00 .. KXBTC15M-26OCT122215-15 (Oct 8 19:00 - Oct 12 22:15 ET),
   authentic Coinbase+Kraken tape replayed through this file, official Kalshi results.
   n = first call per (window, side, tier); upper95 = Clopper-Pearson one-sided 95%.
   REVERSAL WARNING: losses = false alarms (warned side went on to win), as in ledgerStats().
   Shown next to the live ledger; never used for decisions. Stale once any tier env var changes. */
const AUDIT_TIER_STATS = Object.freeze({
  'PROVEN LOCKED': { n: 0, losses: 0, rate: null, upper95: null, windows: 0, meanTau: null,
    note: 'price-only condition never met in 2,944 settled windows (Sep 12 - Oct 13 2026)' },
  'PREDICTED LOCK': { n: 341, losses: 0, rate: 0, upper95: 0.0087, windows: 341, meanTau: 92.9 },
  'HIGH CONFIDENCE': { n: 366, losses: 5, rate: 0.0137, upper95: 0.0285, windows: 364, meanTau: 155.8 },
  'MODERATE CONFIDENCE': { n: 457, losses: 68, rate: 0.1488, upper95: 0.179, windows: 395, meanTau: 367.1 },
  'REVERSAL WARNING': { n: 74, losses: 69, rate: 0.9324, upper95: 0.973, windows: null, meanTau: 158.9,
    note: '5 of 74 warned sides lost; every losing HIGH CONFIDENCE call was warned first' },
  source: 'audit TEST partition, 398 windows, Oct 8-12 2026, model lockrisk-2.4.0'
});

/* =====================================================================
   v2.4 — CENTRAL SIGNAL CLASSIFIER
   The ONLY place a lock-grade state can be assigned. The frontend may
   downgrade a state (stale reading, local feed disagreement); it can
   never upgrade one. PROVEN LOCKED requires the price-only bound; no
   probability, however small, can produce it.
   ===================================================================== */
const LOCKSTATE = { ticker: null, sticky: null, sides: null };
function mkSideState() { return { wasFavored: false, hist: [], reversalTs: null }; }
function lockStateFor(ticker) {
  if (LOCKSTATE.ticker !== ticker) { LOCKSTATE.ticker = ticker; LOCKSTATE.sticky = null; LOCKSTATE.sides = { ABOVE: mkSideState(), BELOW: mkSideState() }; }
  return LOCKSTATE;
}
function tierFor(pc, pp, proven, softCapped) {
  if (proven) return 'PROVEN LOCKED';
  if (pc != null && pc <= TIER_LOCK_MAX && !softCapped) return 'PREDICTED LOCK';
  if (pc != null && pc <= TIER_HIGH_MAX) return 'HIGH CONFIDENCE';
  if (pp != null && pp <= TIER_MOD_MAX) return 'MODERATE CONFIDENCE';
  return 'SIT OUT';
}
function lockGates({ quality, tau, inputAgeMs, venuesUsed, dispersionBps, geo, strikeIssue, kal, volIsWarm, overrides }) {
  const hard = [], soft = [];
  const budget = staleBudgetMs(tau);
  if (!geo) hard.push('no settlement geometry');
  if (quality && quality.grade === 'BAD') hard.push(quality.problems[0] || 'data quality BAD');
  if (strikeIssue) hard.push(strikeIssue);
  if (overrides && overrides.length) hard.push('what-if override active: ' + overrides.join(', '));
  if (!kal || !kal.ok) hard.push('Kalshi market record unavailable');
  if ((venuesUsed || []).length < MIN_INDEX_VENUES) hard.push(`index built from ${(venuesUsed || []).length} venue(s)`);
  if (Number.isFinite(inputAgeMs) && inputAgeMs > budget) hard.push(`oldest index input ${Math.round(inputAgeMs)} ms > ${Math.round(budget)} ms budget at ${Math.round(tau)} s to close`);
  if (geo && geo.nLock > 0 && geo.lockedCoverage < 0.9) hard.push(`only ${geo.lockedObserved}/${geo.nLock} locked prints sampled`);
  if (RESTF.active) hard.push('running on REST fallback');
  if (SKEW.samples.length < 5 || Math.abs(SKEW.estMs) > 1000) hard.push('clock skew unknown or > 1 s');
  if (!volIsWarm) soft.push('vol estimate warming up');
  if (dispersionBps != null && dispersionBps > MAX_DISPERSION_BPS_LOCK) soft.push(`cross-venue dispersion ${dispersionBps} bps`);
  if (quality && quality.grade === 'DEGRADED') soft.push('quality degraded: ' + (quality.warnings[0] || ''));
  return { hard, soft, budgetMs: Math.round(budget) };
}
function evFor(side, pWin, kal) {
  if (!kal || !kal.ok || !Number.isFinite(pWin)) return null;
  const askC = side === 'ABOVE' ? kal.yesAsk : (Number.isFinite(kal.yesBid) ? 100 - kal.yesBid : NaN);
  if (!Number.isFinite(askC) || askC <= 0 || askC >= 100) return null;
  const P = askC / 100, feeC = 7 * P * (1 - P);                 // Kalshi quadratic fee (fee_multiplier 1), cents/contract
  return { side, askCents: round(askC, 2), feeCents: round(feeC, 3), fairCents: round(100 * pWin, 2),
    edgeCents: round(100 * pWin - askC - feeC, 2), note: 'per contract; fee rounds up per order, so small orders pay more' };
}
const SIDE_LABEL = { ABOVE: 'YES (above)', BELOW: 'NO (below)' };
let SIGNAL_SEQ = 0;
const SIGNAL_LOG = [];
function classifySignal({ now = Date.now(), tau, ticker, closeMs, strike, geo, gates, side, kal, mutate = false }) {
  const ls = lockStateFor(ticker);
  const sides = {};
  for (const s of ['ABOVE', 'BELOW']) {
    const pp = geo ? geo.pLoss[s] : null, pc = geo ? geo.pLossCons[s] : null;
    sides[s] = { pLoss: pp, pLossCons: pc, pWin: pp == null ? null : 1 - pp,
      tier: geo ? tierFor(pc, pp, !!geo.proven[s], gates.soft.length > 0) : 'DATA UNRELIABLE' };
  }
  // history + favoured flags (background tick mutates; requests read)
  if (mutate && geo) for (const s of ['ABOVE', 'BELOW']) {
    const st = ls.sides[s]; st.hist.push([now, sides[s].pLoss]);
    while (st.hist.length && st.hist[0][0] < now - 15000) st.hist.shift();
    if (!gates.hard.length && sides[s].pLoss <= TIER_MOD_MAX) st.wasFavored = true;
    if (!gates.hard.length && !ls.sticky && STATE_RANK[sides[s].tier] >= STATE_RANK['HIGH CONFIDENCE']) ls.sticky = s;
  }
  let evalSide, evaluatedBy;
  if (side === 'ABOVE' || side === 'BELOW') { evalSide = side; evaluatedBy = 'your position'; }
  else if (ls.sticky) { evalSide = ls.sticky; evaluatedBy = 'side called earlier this window'; }
  else { evalSide = geo ? geo.leader : 'ABOVE'; evaluatedBy = 'current leader'; }
  const me = sides[evalSide], other = sides[evalSide === 'ABOVE' ? 'BELOW' : 'ABOVE'];
  const st = ls.sides[evalSide];
  const reasons = [];
  let state;
  if (Number.isFinite(tau) && tau <= 0) state = 'AWAITING SETTLEMENT';
  else if (gates.hard.length) { state = 'DATA UNRELIABLE'; reasons.push(...gates.hard); }
  else {
    state = me.tier;
    const held = evaluatedBy !== 'current leader';
    if (held && st.wasFavored && me.pLoss != null) {
      const prev = st.hist.find(h => h[0] >= now - 5500);
      const jump = prev && prev[1] != null && me.pLoss >= 0.03 && me.pLoss >= REVERSAL_JUMP_X * Math.max(prev[1], 1e-6);
      if (me.pLoss >= REVERSAL_P || jump) {
        state = 'REVERSAL WARNING';
        reasons.push(`${SIDE_LABEL[evalSide]} loss risk now ${(100 * me.pLoss).toFixed(1)}%`
          + (jump ? ` (was ${(100 * prev[1]).toFixed(2)}% ${Math.round((now - prev[0]) / 1000)} s ago)` : ''));
        if (mutate && !st.reversalTs) st.reversalTs = now;
      }
    } else if (evaluatedBy === 'your position' && me.pLoss != null && me.pLoss >= 0.5) {
      state = 'SIT OUT'; reasons.push(`your side trails: P(win) ${(100 * me.pWin).toFixed(1)}%`);
    }
    if (gates.soft.length && STATE_RANK[state] >= STATE_RANK['HIGH CONFIDENCE'] && me.tier !== 'PROVEN LOCKED')
      reasons.push('lock tier withheld: ' + gates.soft.join('; '));
  }
  if (geo && state !== 'DATA UNRELIABLE') {
    if (geo.nLock > 0) reasons.push(`${geo.nLock}/60 settlement prints already in the average (mean $${geo.lockedMean}); ${geo.nRemaining} still to print`);
    reasons.push(`expected settlement $${geo.expectedSettle} vs strike $${strike} (${geo.gapUsd >= 0 ? '+' : ''}${geo.gapUsd}); path σ $${geo.sigmaUsd}, basis ${geo.basis.mean >= 0 ? '+' : ''}${geo.basis.mean}±${geo.basis.sd} USD`);
  }
  const pLoss = me.pLoss, pLossCons = me.pLossCons;
  const sig = {
    id: (++SIGNAL_SEQ).toString(36) + '-' + now.toString(36), ts: now, modelVersion: MODEL_VERSION, serverVersion: SERVER_VERSION,
    ticker, closeMs, strike, tau: Number.isFinite(tau) ? round(tau, 2) : null,
    state, side: evalSide, sideLabel: SIDE_LABEL[evalSide], evaluatedBy,
    pWin: me.pWin == null ? null : round(me.pWin, 6), pLoss: pLoss == null ? null : round(pLoss, 6),
    pLossCons: pLossCons == null ? null : round(pLossCons, 6),
    /* Below 0.1% the audit sample (1,326 windows) cannot resolve the
       probability; it is reported as a bound, never as a precise number. */
    oneIn: pLoss >= 0.001 ? Math.round(1 / pLoss) : null,
    pLossLabel: pLoss == null ? null : (pLoss < 0.001 ? '<0.1%' : (100 * pLoss).toFixed(pLoss < 0.01 ? 2 : 1) + '%'),
    other: { side: evalSide === 'ABOVE' ? 'BELOW' : 'ABOVE', tier: other.tier, pWin: other.pWin == null ? null : round(other.pWin, 6) },
    sides: { ABOVE: { tier: sides.ABOVE.tier, pLoss: round(sides.ABOVE.pLoss, 6), pLossCons: round(sides.ABOVE.pLossCons, 6) },
      BELOW: { tier: sides.BELOW.tier, pLoss: round(sides.BELOW.pLoss, 6), pLossCons: round(sides.BELOW.pLossCons, 6) } },
    guarantee: state === 'PROVEN LOCKED'
      ? 'price-only: even at $0 the remaining prints cannot pull the average under the strike; the contract still resolves NO if CF Benchmarks data is missing or incomplete'
      : (['PREDICTED LOCK', 'HIGH CONFIDENCE', 'MODERATE CONFIDENCE'].includes(state) ? 'none - model estimate, still reversible' : null),
    reasons, gates, ev: evFor(evalSide, me.pWin, kal),
    validation: { tier: state, live: null, audit: AUDIT_TIER_STATS[state] || null },
    geometry: geo ? { expectedSettle: geo.expectedSettle, gapUsd: geo.gapUsd, nLock: geo.nLock, nRemaining: geo.nRemaining,
      lockedMean: geo.lockedMean, sigmaUsd: geo.sigmaUsd, sigmaBps: geo.sigmaBps, sigmaFastBps: geo.sigmaFastBps,
      sigmaSlowBps: geo.sigmaSlowBps, inputAgeMs: geo.inputAgeMs, basis: geo.basis, momentumUsd: geo.momentumUsd,
      requiredIndexMoveUsd: geo.requiredIndexMoveUsd } : null
  };
  if (mutate && !gates.hard.length && geo) for (const s of ['ABOVE', 'BELOW']) {
    const t = sides[s].tier;
    for (const tier of LEDGER_TIERS) if (STATE_RANK[t] >= STATE_RANK[tier])
      ledgerNote(ticker, closeMs, strike, s, tier, { ts: now, tau: round(tau, 2), pLoss: round(sides[s].pLoss, 6), pLossCons: round(sides[s].pLossCons, 6),
        askCents: (evFor(s, sides[s].pWin, kal) || {}).askCents ?? null });
    const ss = ls.sides[s];
    if (ss.reversalTs === now) ledgerNote(ticker, closeMs, strike, s, 'REVERSAL WARNING', { ts: now, tau: round(tau, 2), pLoss: round(sides[s].pLoss, 6) });
  }
  return sig;
}
function logSignal(sig, extra) {
  const prev = SIGNAL_LOG.length ? SIGNAL_LOG[SIGNAL_LOG.length - 1] : null;
  if (prev && prev.ticker === sig.ticker && prev.state === sig.state && prev.side === sig.side && sig.ts - prev.ts < 5000 && !extra) return;
  SIGNAL_LOG.push({ id: sig.id, ts: sig.ts, ticker: sig.ticker, tau: sig.tau, state: sig.state, side: sig.side, evaluatedBy: sig.evaluatedBy,
    pLoss: sig.pLoss, pLossCons: sig.pLossCons, gapUsd: sig.geometry && sig.geometry.gapUsd, sigmaUsd: sig.geometry && sig.geometry.sigmaUsd,
    inputAgeMs: sig.geometry && sig.geometry.inputAgeMs, hard: sig.gates.hard, soft: sig.gates.soft, model: sig.modelVersion, ...(extra || {}) });
  if (SIGNAL_LOG.length > 5000) SIGNAL_LOG.splice(0, SIGNAL_LOG.length - 5000);
}
function lastWindowSummary(now = Date.now()) {
  const p = [...SETTLE.pending.values()].sort((a, b) => b.closeMs - a.closeMs)[0];
  const d = SETTLE.done[0];
  const w = (p && (!d || p.closeMs >= d.closeMs)) ? p : d;
  if (!w) return null;
  return { ticker: w.ticker, closeMs: w.closeMs, strike: w.strike, status: w.status, result: w.result || null,
    official: w.official ?? null, proxyAvg: Number.isFinite(w.proxyAvg) ? round(w.proxyAvg, 2) : null,
    proxyErr: w.proxyErr ?? null, secondsSinceClose: round((now - w.closeMs) / 1000, 1),
    proxySaid: Number.isFinite(w.proxyAvg) && Number.isFinite(w.strike) ? (w.proxyAvg >= w.strike ? 'yes' : 'no') : null };
}

/* One snapshot shared by /radar and the background classifier. */
function computeLockSnapshot({ now = Date.now(), kal, strike, strikeIssue, overrides, quality, liveIdx, liveIndexAgeMs, side, mutate = false, indexOverride }) {
  const closeMs = kal && kal.ok ? kal.closeMs : NaN;
  /* v2.4 strike-chain check: a KXBTC15M strike IS the previous window's
     official settlement (verified on 2,939 consecutive pairs). If we hold
     that settlement and it disagrees, the market mapping is wrong. */
  if (!strikeIssue && kal && kal.ok && Number.isFinite(strike) && Number.isFinite(kal.openMs)) {
    const prev = SETTLE.done.find(d => d.closeMs === kal.openMs && d.status === 'SETTLED' && Number.isFinite(d.official));
    if (prev && Math.abs(prev.official - strike) > 0.011)
      strikeIssue = `strike $${strike} != previous window ${prev.ticker} official settlement $${prev.official}`;
  }
  const tau = Number.isFinite(closeMs) ? (closeMs - now) / 1000 : NaN;
  const indexNow = Number.isFinite(indexOverride) ? indexOverride : (liveIdx ? liveIdx.value : IDX.value);
  const sigSlow = indexVolBpsPerRootSec();
  const sigFast = indexVolFast(VOL_FAST_SEC, now);
  const sigLong = indexVolFast(VOL_LONG_SEC, now);
  const momRef = MOMENTUM_BETA ? indexAt(MOMENTUM_LAG_SEC * 1000, now) : NaN;
  const geo = (!strikeIssue && Number.isFinite(strike) && Number.isFinite(closeMs))
    ? lockGeometry({ indexNow, strike, closeMs, now, sigmaSlow: sigSlow, sigmaFast: sigFast, sigmaLong: sigLong,
      inputAgeMs: Number.isFinite(liveIndexAgeMs) ? liveIndexAgeMs : 0, momentumRef: momRef }) : null;
  const gates = lockGates({ quality, tau, inputAgeMs: liveIndexAgeMs, venuesUsed: liveIdx ? liveIdx.used : IDX.venuesUsed,
    dispersionBps: liveIdx ? round(liveIdx.dispersionBps, 2) : IDX.dispersionBps, geo, strikeIssue, kal,
    volIsWarm: volWarm(), overrides });
  const signal = classifySignal({ now, tau, ticker: kal && kal.ticker, closeMs, strike, geo, gates, side, kal, mutate });
  return { geo, gates, signal };
}
/* Background classifier: keeps the sticky-side/reversal state and the
   ledger current even when no browser is polling. */
const BG = { timer: null, ticks: 0, lastErr: null };
function bgTick(now = Date.now()) {
  try {
    const kal = kalshiContext();
    if (!kal.ok || !Number.isFinite(kal.strike)) return null;
    if (Number.isFinite(kal.closeMs) && kal.closeMs - now < 0) return null;
    const liveIdx = computeIndex(now);
    const used = liveIdx ? VENUE_LIST().filter(v => liveIdx.used.includes(v.name)) : [];
    const age = used.length ? Math.max(...used.map(v => now - v.lastQuoteTs)) : Infinity;
    const quality = assessQuality(now, kal);
    const strikeIssue = (liveIdx && Math.abs(kal.strike / liveIdx.value - 1) > STRIKE_MAX_DEV_FRAC) ? 'strike implausible vs index' : null;
    const snap = computeLockSnapshot({ now, kal, strike: kal.strike, strikeIssue, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true });
    BG.ticks++; logSignal(snap.signal);
    return snap;
  } catch (e) { BG.lastErr = String(e && e.message || e); return null; }
}
function startBackground() {
  if (BG.timer || process.env.PINRADAR_REPLAY) return;
  BG.timer = setInterval(() => bgTick(), BG_TICK_MS);
  if (BG.timer.unref) BG.timer.unref();
  loadState();
  const st = setInterval(saveState, 30000); if (st.unref) st.unref();
}
/* Persistence (best effort). Render's disk is ephemeral unless a persistent
   disk is attached; set PINRADAR_STATE_FILE to a path on that disk. */
function saveState() {
  if (!STATE_FILE) return;
  try {
    require('fs').writeFileSync(STATE_FILE + '.tmp', JSON.stringify({ v: 1, model: MODEL_VERSION, basis: BASIS.samples, ledger: LEDGER.closed.slice(-20000) }));
    require('fs').renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (_) { }
}
let SAVE_PENDING = null;
function saveStateSoon() { if (SAVE_PENDING || !STATE_FILE) return; SAVE_PENDING = setTimeout(() => { SAVE_PENDING = null; saveState(); }, 2000); if (SAVE_PENDING.unref) SAVE_PENDING.unref(); }
function loadState() {
  if (!STATE_FILE) return;
  try {
    const j = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8'));
    for (const s of (j.basis || [])) if (s && s.key && !BASIS.byKey.has(s.key)) { BASIS.byKey.add(s.key); BASIS.samples.push(s); }
    for (const r of (j.ledger || [])) LEDGER.closed.push(r);
    LEDGER.version++;
  } catch (_) { }
}
/* AI read is OFF the hot path in 2.4: it is refreshed in the background and
   the last answer is attached if fresh. /radar never awaits the network. */
const AI = { text: null, ts: 0, key: null, inFlight: false };
function aiRefreshAsync(key, pin, evidence) {
  if (!ENABLE_OPENAI || !OPENAI_API_KEY || AI.inFlight || (AI.key === key && Date.now() - AI.ts < 15000)) return;
  AI.inFlight = true;
  aiRead(pin, evidence).then(t => { if (t) { AI.text = t; AI.ts = Date.now(); AI.key = key; } })
    .catch(() => { }).finally(() => { AI.inFlight = false; });
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
  startSampler(); startSentinel(); startKalshi(); startRestFallback(); startBackground();
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
  /* v2.2 BUGFIX - STRIKE OVERRIDE CANNOT MASQUERADE AS AUTHORITY.
     The frontend persisted the strike box in localStorage and replayed
     it on every later session, and radar() gave the client override
     unconditional precedence over Kalshi's own strike. A value typed
     during an earlier window therefore silently redefined the strike,
     and every cushion, sigma, probability and level downstream was
     computed against the wrong number with no indication in the
     verdict. The override is still honoured - it is a legitimate
     what-if - but when it disagrees with the live market it is a data
     defect and the response can no longer render CLEAR. */
  const kalStrike = kal.ok && Number.isFinite(kal.strike) ? kal.strike : NaN;
  const strikeOverridden = Number.isFinite(overrideStrike) && overrideStrike > 0;
  const strikeMismatchUsd = (strikeOverridden && Number.isFinite(kalStrike))
    ? round(overrideStrike - kalStrike, 2) : null;
  if (strikeMismatchUsd != null && Math.abs(strikeMismatchUsd) > STRIKE_OVERRIDE_TOL_USD) {
    quality.warnings.unshift('client strike override $' + overrideStrike
      + ' disagrees with ' + kal.ticker + ' strike $' + kalStrike
      + ' by $' + strikeMismatchUsd + ' - clear the override or it will drive every number below');
    if (quality.grade === 'GOOD') quality.grade = 'DEGRADED';
  }
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
  /* v2.3 BUGFIX. The index is a weighted mean of every venue in `used`, so
     its information age is that of its OLDEST input. Math.min reported the
     freshest venue: a 20 ms Coinbase quote masked a 2.8 s Kraken quote. */
  const liveIndexAgeMs = liveIdx ? Math.round(Math.max(...VENUE_LIST().filter(v => liveIdx.used.includes(v.name)).map(v => now - v.lastQuoteTs))) : null;

  /* v2.3 BUGFIX - see STRIKE_MAX_DEV_FRAC. An implausible strike is a data
     defect: geometry is withheld and the quality gate renders STALE. */
  const strikeImplausible = Number.isFinite(strike) && Number.isFinite(indexNow) && indexNow > 0
    && Math.abs(strike / indexNow - 1) > STRIKE_MAX_DEV_FRAC;
  if (strikeImplausible) {
    quality.problems.unshift('strike $' + strike + ' (' + strikeSource + ') is '
      + round(Math.abs(strike / indexNow - 1) * 100, 1) + '% from the $' + round(indexNow, 2)
      + ' index - corrupted market record, not a tradeable strike');
    quality.grade = 'BAD';
  }
  const strikeForGeometry = strikeImplausible ? NaN : strike;

  const sigma = indexVolBpsPerRootSec();
  const drift = indexDriftBpsPerSec();
  const sg = settlementGeometry({
    indexNow, strike: strikeForGeometry, tau,
    sigmaBpsRootSec: sigma, driftBpsSec: drift,
    strikeType: kal.ok ? kal.strikeType : 'greater_or_equal'
  });

  /* v2.3 BUGFIX - LOCKED-WINDOW COVERAGE. Inside the final 60 s the known
     part of the settlement average is the mean of whatever 1 Hz ring
     samples exist; only n < 3 was rejected. After a quorum outage, 6
     samples could stand in for 50 locked seconds with grade GOOD and no
     warning. Missing observations are now reported, and such a reading
     cannot render GREEN (DEGRADED never suppresses a real RED/AMBER). */
  if (sg && sg.lockedFrac > 0) {
    const lockedSec = sg.lockedFrac * SETTLE_WINDOW_SEC;
    const have = Number.isFinite(sg.knownSamples) ? sg.knownSamples : 0;
    if (have < 0.8 * lockedSec - 1) {
      quality.warnings.unshift('settlement window only ' + have + ' of ~' + Math.round(lockedSec)
        + ' locked seconds sampled - running average is incomplete');
      if (quality.grade === 'GOOD') quality.grade = 'DEGRADED';
    }
  }

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
  /* Legacy A/B line gets the same validated strike: a rejected strike must
     not print "legacy 1.5 model would say: GREEN" under a NO DATA verdict. */
  const legacy = computePinPressure({
    price: indexNow, strike: strikeForGeometry, secondsLeft: Math.round(tau), side,
    spotFlow: flow, kalshi: kal, tape, sentinel: sent
  });

  /* ---- v2.4 central signal (the only source of lock-grade states) ---- */
  const overrides = [];
  if (strikeOverridden) overrides.push('strike');
  if (Number.isFinite(priceOverride)) overrides.push('price');
  if (tauSource === 'client-timer') overrides.push('countdown');
  const strikeIssue = strikeImplausible ? 'strike implausible vs index (corrupted market record)'
    : (strikeMismatchUsd != null && Math.abs(strikeMismatchUsd) > STRIKE_OVERRIDE_TOL_USD ? 'strike override disagrees with Kalshi by $' + strikeMismatchUsd : null);
  const lock = computeLockSnapshot({ now, kal, strike: strikeForGeometry, strikeIssue, overrides, quality, liveIdx,
    liveIndexAgeMs, side, mutate: false, indexOverride: Number.isFinite(priceOverride) ? priceOverride : undefined });
  lock.signal.validation.live = ledgerStats()[lock.signal.state] || null;
  logSignal(lock.signal, { via: 'radar' });

  /* v2.4: the AI read never blocks /radar (2.3 awaited it for up to 6 s on
     every AMBER/RED tick, delaying exactly the warnings that matter). */
  if (payload.ai !== false && (out.level === 'AMBER' || out.level === 'RED' || lock.signal.state === 'REVERSAL WARNING')) {
    aiRefreshAsync((kal.ticker || '') + ':' + lock.signal.state,
      { state: lock.signal.state, pLoss: lock.signal.pLoss, level: out.level, reasons: lock.signal.reasons.slice(0, 3) },
      { gapUsd: lock.geo && lock.geo.gapUsd, tau, sigmaUsd: lock.geo && lock.geo.sigmaUsd, nLock: lock.geo && lock.geo.nLock, flow: out.notes.flow });
  }
  const ai = (AI.text && Date.now() - AI.ts < 30000) ? AI.text : null;

  const serverMs = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    ok: true, version: SERVER_VERSION, build: BUILD_ID, ts: Date.now(), serverComputeMs: round(serverMs, 3),
    /* ---- v2.4 ---- */
    signal: lock.signal, lastWindow: lastWindowSummary(now), modelVersion: MODEL_VERSION,
    /* ---- headline (backward-compatible field names) ---- */
    price: round(indexNow, 2), strike: Number.isFinite(strike) ? strike : null,
    strikeSource, strikeOverridden, kalshiStrike: Number.isFinite(kalStrike) ? kalStrike : null,
    strikeMismatchUsd, strikeImplausible,
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
    tauSource, priceSource,
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

  /* --- v2.4 lock-risk engine checks (pure functions; no live data) --- */
  {
    const u = settleVarUnitsDiscrete(10).units;
    push('2.4 discrete variance exact at t=10 (385/3600)', Math.abs(u - 385 / 3600) < 1e-12, u);
    const r1 = settleVarUnitsDiscrete(1).units / (1 / (3 * 3600));
    push('2.4 discrete sigma at t=1 is 1.73x the 2.3 continuous value', Math.abs(Math.sqrt(r1) - Math.sqrt(3)) < 1e-9, round(Math.sqrt(r1), 4));
    const p0 = lossProbability({ gapUsd: 5, sigmaUsd: 0, basis: { mean: 0, sd: 3.3, df: 4 }, side: 'ABOVE' });
    push('2.4 lossProbability(sigma=0) == Student-t CDF (scipy 0.04939124)', Math.abs(p0 - 0.0493912363) < 1e-7, p0);
    let tErr = 0; for (let x = -25; x <= 25; x += 0.0731) tErr = Math.max(tErr, Math.abs(tCdf(x, 8) - tCdfExact(x, 8)));
    push('2.4 tabulated t-CDF within 5e-8 of the exact CDF', tErr < 5e-8, tErr);
    const p1 = lossProbability({ gapUsd: 40, sigmaUsd: 8, basis: { mean: 0, sd: 3.3, df: 4 }, side: 'ABOVE', tailA: 0.804, tailB: 1.268 });
    push('2.4 lossProbability convolution matches scipy quad (0.0048923)', Math.abs(p1 - 0.004892273) < 2e-8, p1);
    const sY = lossProbability({ gapUsd: 3, sigmaUsd: 2, basis: { mean: 1, sd: 3.5, df: 8 }, side: 'ABOVE' });
    const sN = lossProbability({ gapUsd: 3, sigmaUsd: 2, basis: { mean: 1, sd: 3.5, df: 8 }, side: 'BELOW' });
    push('2.4 YES/NO loss probabilities complementary', Math.abs(sY + sN - 1) < 1e-12, round(sY + sN, 12));
    push('2.4 binomial upper bound 0/300 = 0.99%', Math.abs(binomUpper(0, 300) - 0.009936) < 2e-5, round(binomUpper(0, 300), 6));
    push('2.4 stale budget shrinks into the close', staleBudgetMs(5) === 750 && staleBudgetMs(20) === 2000 && staleBudgetMs(300) === 3000, [staleBudgetMs(5), staleBudgetMs(20), staleBudgetMs(300)].join('/'));
    const L1 = pathLawForTau(25), L2 = pathLawForTau(24.999);
    push('2.4 path law continuous across knots', Math.abs(L1.A - L2.A) < 1e-3 && Math.abs(L1.kappa - L2.kappa) < 1e-3, JSON.stringify(L1));
    push('2.4 a probability alone can never produce PROVEN LOCKED', tierFor(0, 0, false, false) === 'PREDICTED LOCK' && tierFor(0.5, 0.5, true, true) === 'PROVEN LOCKED', tierFor(0, 0, false, false));
    push('2.4 soft gate withholds PREDICTED LOCK', tierFor(0.001, 0.001, false, true) === 'HIGH CONFIDENCE', tierFor(0.001, 0.001, false, true));
    const g = lockGates({ quality: { grade: 'GOOD', problems: [], warnings: [] }, tau: 5, inputAgeMs: 900, venuesUsed: ['a', 'b'], dispersionBps: 1,
      geo: { nLock: 55, lockedCoverage: 1 }, strikeIssue: null, kal: { ok: true }, volIsWarm: true, overrides: [] });
    push('2.4 900 ms input at T-5 breaches the 750 ms budget', g.hard.some(x => /budget/.test(x)), g.hard.join('|'));
    const fakeGeo = (gap) => ({ leader: gap >= 0 ? 'ABOVE' : 'BELOW', pLoss: { ABOVE: gap >= 0 ? 0.002 : 0.9, BELOW: gap >= 0 ? 0.998 : 0.1 },
      pLossCons: { ABOVE: gap >= 0 ? 0.004 : 0.95, BELOW: gap >= 0 ? 0.999 : 0.2 }, proven: { ABOVE: false, BELOW: false },
      nLock: 30, nRemaining: 30, lockedMean: 1, expectedSettle: 1, gapUsd: gap, sigmaUsd: 1, basis: { mean: 0, sd: 3.5 } });
    const okGates = { hard: [], soft: [] };
    const snap = JSON.parse(JSON.stringify(LOCKSTATE));
    LOCKSTATE.ticker = null;
    const a = classifySignal({ now: 1000, tau: 40, ticker: 'SELFTEST', closeMs: 41000, strike: 1, geo: fakeGeo(20), gates: okGates, side: null, kal: { ok: false }, mutate: true });
    const b = classifySignal({ now: 3000, tau: 38, ticker: 'SELFTEST', closeMs: 41000, strike: 1, geo: fakeGeo(-20), gates: okGates, side: null, kal: { ok: false }, mutate: true });
    push('2.4 FLAT mode keeps the called side: leader flip -> REVERSAL WARNING (not a fresh call on the other side)',
      a.state === 'PREDICTED LOCK' && a.side === 'ABOVE' && b.side === 'ABOVE' && b.state === 'REVERSAL WARNING', `${a.state}/${a.side} -> ${b.state}/${b.side}`);
    Object.assign(LOCKSTATE, snap);
  }

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
        build: BUILD_ID, fixes: BUILD_FIXES,
        openaiEnabled: ENABLE_OPENAI, model: OPENAI_MODEL,
        uptimeSec: Math.round((now - bootTs) / 1000),
        streaming: WS_AVAILABLE && ENABLE_WS, wsImpl: WS_AVAILABLE ? (globalThis.WebSocket ? 'node-global' : 'ws-package') : 'none',
        venues: Object.fromEntries(VENUE_LIST().map(v => [v.name, {
          state: v.state, quoteAgeMs: v.lastQuoteTs ? now - v.lastQuoteTs : null,
          msgs: v.msgCount, reconnects: v.reconnects, mid: round(v.mid, 2),
          lastError: v.lastError, bookResets: v.bookResets || 0, trades60s: v.trades.filter(t => t[0] > now - 60000).length
        }])),
        index: { value: round(IDX.value, 2), ageMs: IDX.ts ? now - IDX.ts : null, venuesUsed: IDX.venuesUsed, dispersionBps: IDX.dispersionBps, ringSamples: IDX.ring.length, publishFails: IDX.publishFails, lastReason: IDX.lastReason },
        kalshi: { ticker: KAL.market && KAL.market.ticker, ageMs: KAL.ts ? now - KAL.ts : null, err: KAL.err, fails: KAL.consecutiveFails, latencyMs: KAL.lastLatencyMs, rateLimited: KAL.rateLimited, wsState: KAL.wsState, wsMsgs: KAL.wsMsgs, overlapSkips: KAL.overlapSkips, pollSeq: KAL.seq },
        restFallbackActive: RESTF.active,
        modelVersion: MODEL_VERSION, settleAlign: SETTLE_ALIGN,
        basis: (() => { const b = basisModel(); return { mean: round(b.mean, 3), sd: round(b.sd, 3), sdUpper: round(b.sdUpper, 3), n: b.n, source: b.source }; })(),
        tiers: { lockMax: TIER_LOCK_MAX, highMax: TIER_HIGH_MAX, modMax: TIER_MOD_MAX, reversalP: REVERSAL_P },
        background: { ticks: BG.ticks, lastErr: BG.lastErr, ledgerOpen: LEDGER.open.size, ledgerClosed: LEDGER.closed.length,
          settlePending: SETTLE.pending.size, stateFile: STATE_FILE || null },
        clockSkewMs: Math.round(SKEW.estMs), clockSkewSamples: SKEW.samples.length,
        ts: now
      });
    }
    if (req.method === 'GET' && u.pathname === '/selftest') { const r = runSelfTest(); return send(res, r.ok ? 200 : 500, r); }
    /* v2.4: every displayed signal is traceable here (id, inputs, model). */
    if (req.method === 'GET' && u.pathname === '/signals') {
      const n = clamp(Number(u.searchParams.get('n') || 500), 1, 5000);
      return send(res, 200, { ok: true, version: SERVER_VERSION, model: MODEL_VERSION, signals: SIGNAL_LOG.slice(-n) });
    }
    if (req.method === 'GET' && u.pathname === '/calibration') {
      return send(res, 200, { ok: true, version: SERVER_VERSION, model: MODEL_VERSION, live: ledgerStats(), audit: AUDIT_TIER_STATS,
        tiers: { lockMax: TIER_LOCK_MAX, highMax: TIER_HIGH_MAX, modMax: TIER_MOD_MAX }, records: u.searchParams.get('records') ? LEDGER.closed.slice(-2000) : undefined });
    }
    if (req.method === 'GET' && u.pathname === '/basis') {
      const b = basisModel();
      return send(res, 200, { ok: true, version: SERVER_VERSION, model: b, samples: BASIS.samples.slice(-200), settlement: { pending: [...SETTLE.pending.values()], done: SETTLE.done.slice(0, 20) } });
    }
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
        /* PRE-EXISTING BUG (also present in 2.0): serialising RESTF whole
           pulls in RESTF.timer, a Node Timeout whose _idlePrev/_idleNext
           form a cycle, so JSON.stringify threw and /diag returned HTTP
           500 every time - the one endpoint you reach for when something
           is already wrong. Scalars only. */
        restFallback: { active: RESTF.active, ok: RESTF.ok, fail: RESTF.fail,
          lastError: RESTF.lastError, lastRunAgeMs: RESTF.lastRun ? now - RESTF.lastRun : null },
        kalshi: {
          market: KAL.market && KAL.market.ticker, ageMs: KAL.ts ? now - KAL.ts : null,
          err: KAL.err, consecutiveFails: KAL.consecutiveFails, latencyMs: KAL.lastLatencyMs,
          overlapSkips: KAL.overlapSkips, pollSeq: KAL.seq,
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
  normalisePem, redact, kalshiSelfSignCheck, kalshiWsSync, kalshiWsHandleMessage, KALSHI_KEY_INFO,
  VENUES, IDX, SKEW, KAL, SENT, RESTF, server, ADAPTERS, kalshiPollOnce, sampleIndex, restFallbackTick, venueFresh,
  // v2.4
  MODEL_VERSION, settleVarUnitsDiscrete, lossProbability, pathTailCdf, pathTailSurvival, tPdf, staleBudgetMs, binomUpper,
  lockGeometry, indexVolFast, indexAt, basisModel, addBasisSample, BASIS, SETTLE, noteWindowClosed, finalizeWindow,
  settlePollOnce, proxyWindowAverage, LEDGER, ledgerNote, ledgerFinalize, ledgerStats, LOCKSTATE, lockStateFor,
  tierFor, lockGates, classifySignal, computeLockSnapshot, bgTick, evFor, SIGNAL_LOG, lastWindowSummary,
  AUDIT_TIER_STATS, STATE_RANK, TIER_LOCK_MAX, TIER_HIGH_MAX, TIER_MOD_MAX, REVERSAL_P
};
