"""Build 2.8/dist/pinradar_server.js from the preserved 2.7 server (versions/2.7, sha bd7cacbb...).
Every patch must match exactly once (the build aborts otherwise).  usage: python3 2.8/build/build_server28.py
2.8 = 2.7 decisions (= 2.6 without the official feed) + fixes D1-D3 + core28 (fees from Kalshi's series record,
order-size EV ladder, probability uncertainty band, settlement designations, hash-chained ledger, anytime-valid
monitors, shadow policies) + record/replay tape + latency percentiles + endpoints."""
import hashlib, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R28 = os.path.abspath(os.path.join(HERE, '..'))
SRC = os.path.abspath(os.path.join(R28, '..', 'versions', '2.7', 'pinradar_server.js'))
OUT = os.path.join(R28, 'dist', 'pinradar_server.js')
s = open(SRC, encoding='utf8').read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('bd7cacbb7144edbe'):
    sys.exit('build28: versions/2.7/pinradar_server.js is not the delivered 2.7 build (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'build28: expected {count} match(es), found {n}: {old[:120]!r}')
    return s.replace(old, new)


s = rep(s, "const SERVER_VERSION = 'pin-radar-2.7';", "const SERVER_VERSION = 'pin-radar-2.8';")
s = rep(s, "const BUILD_ID = '2.7-2026-10-13';", "const BUILD_ID = '2.8-2026-10-14';")
s = rep(s, "'official-brti-reversal-warning', 'per-second-prediction-log'];",
        "'official-brti-reversal-warning', 'per-second-prediction-log',\n"
        "  // v2.8 (Oct 14: decisions unchanged except three defect fixes; evidence, economics and forward-test layer)\n"
        "  'D1-live-index-quorum-gate', 'D2-brti-source-age', 'D3-zero-size-ask-level', 'fee-schedule-from-series-record',\n"
        "  'ev-ladder-by-order-size', 'probability-uncertainty-band', 'settlement-designations', 'hash-chained-ledger',\n"
        "  'anytime-valid-monitors', 'shadow-policies', 'record-replay-tape', 'latency-percentiles',\n"
        "  'D4-proven-needs-official-agreement', 'D5-official-reversal-numbers', 'D6-final-needs-60-of-60'];")

# fee: unchanged 2.6 rule while the schedule is the default; the series record can change it
s = rep(s, """function kalshiFeeCents(priceCents, contracts = 10) {
  const P = priceCents / 100, C = Math.max(1, Math.round(contracts));
  return Math.ceil(7 * C * P * (1 - P) - 1e-9) / C;
}""", """function kalshiFeeCents(priceCents, contracts = 10) {
  const P = priceCents / 100, C = Math.max(1, Math.round(contracts));
  /* v2.8: the 2.6 rule while the fee schedule is the default (0.07, cent rounding, whole order); otherwise the
     schedule read from Kalshi's series record / FEE_* env (exact integer arithmetic, core28) */
  if (typeof FEE28 === 'undefined' || !FEE28 || FEE28.isDefault) return Math.ceil(7 * C * P * (1 - P) - 1e-9) / C;
  return feeCentsPerContract28(priceCents, C, FEE28.cfg);
}""")
# fee: a non-default schedule (incl. FEE_PER_FILL) is applied to the actual walked fills, not only to the average price
s = rep(s, "    tr.feeCents = Math.round(kalshiFeeCents(a.avgCents, Math.max(1, a.fillable)) * 1000) / 1000;",
        "    tr.feeCents = Math.round(((typeof FEE28 !== 'undefined' && FEE28 && !FEE28.isDefault) ? walkFeeCents28(walk28(lv, cfg.contracts).fills, FEE28.cfg) / Math.max(1, a.fillable)\n"
        "      : kalshiFeeCents(a.avgCents, Math.max(1, a.fillable))) * 1000) / 1000;   // v2.8")
# D3: zero-size levels never become the displayed ask
s = rep(s, "  const yesAsks = (ob.no || []).map(([p, s]) => [round(100 - p, 2), s]).sort((x, y) => x[0] - y[0]);\n"
           "  const noAsks = (ob.yes || []).map(([p, s]) => [round(100 - p, 2), s]).sort((x, y) => x[0] - y[0]);",
        "  /* v2.8 D3: a level with no size is not an offer */\n"
        "  const yesAsks = (ob.no || []).filter(([p, s]) => s > 0).map(([p, s]) => [round(100 - p, 2), s]).sort((x, y) => x[0] - y[0]);\n"
        "  const noAsks = (ob.yes || []).filter(([p, s]) => s > 0).map(([p, s]) => [round(100 - p, 2), s]).sort((x, y) => x[0] - y[0]);")
# D2: official freshness by source time as well as receipt time
s = rep(s, "  const age = now - last.localTs;\n",
        "  /* v2.8 D2: a tick is as old as its SOURCE timestamp says (Kalshi can deliver a backlog), not just its arrival */\n"
        "  const srcAge = Number.isFinite(last.sourceTs) ? (now - (Number.isFinite(SKEW.estMs) ? SKEW.estMs : 0)) - last.sourceTs : NaN;\n"
        "  const age = Number.isFinite(srcAge) ? Math.max(now - last.localTs, srcAge) : now - last.localTs;\n")

# D4: a PROVEN (price-only) bound must not override the official reference: when the official BRTI disagrees with the
# proxy (official flip gate or the divergence gate), PROVEN LOCKED is withheld like an ordinary LOCKED (2.6/2.7 let it through)
s = rep(s, "    gates.soft.push(`official BRTI and the proxy index differ by",
        "    (gates.official || (gates.official = [])).push('official/proxy divergence'), gates.soft.push(`official BRTI and the proxy index differ by")
s = rep(s, "  if (f > BRTI_GATE_MAX_FLIP) gates.soft.push(",
        "  if (f > BRTI_GATE_MAX_FLIP) (gates.official || (gates.official = [])).push('official flip risk'), gates.soft.push(")
s = rep(s, "  const g = { hard: [...gates.hard], soft: [...gates.soft], budgetMs: gates.budgetMs };",
        "  const g = { hard: [...gates.hard], soft: [...gates.soft], official: [...(gates.official || [])], budgetMs: gates.budgetMs };")
s = rep(s, "  else if (provenSide && provenSide === side) out.state = 'PROVEN LOCKED';",
        "  else if (provenSide && provenSide === side && !(gates.official && gates.official.length)) out.state = 'PROVEN LOCKED';   // v2.8 D4")
# D5: an official REVERSAL WARNING shows the official reference's numbers (2.7 kept the proxy's >99.9% and its guarantee text)
s = rep(s, "      sig.officialReversal = true;",
        "      sig.officialReversal = true;\n"
        "      /* v2.8 D5: the probabilities shown are the official reference's for the LOCKED side, not the proxy's */\n"
        "      sig.pWin = round(1 - f, 6); sig.pFlip = round(f, 6); sig.pFlipCons = round(Math.max(f, sig.pFlipCons || 0), 6);\n"
        "      sig.pWinLabel = fmtWin(1 - f); sig.pFlipLabel = fmtFlip(f); sig.guarantee = null; sig.probabilityReference = 'OFFICIAL';")
# D6: after the close the official accumulator is final only at 60/60 (BRTI_COUNT_TOL let 58-59 count as decided)
s = rep(s, "  const r = tau <= 0 ? 0 : SETTLE_TICKS - n;",
        "  const r = tau <= 0 && (reference !== 'OFFICIAL' || n >= SETTLE_TICKS) ? 0 : SETTLE_TICKS - n;   // v2.8 D6")

s = rep(s, "  const head = st === 'LOCKED' ? `LOCKED — PREDICTED ${side}` : st === 'PROVEN LOCKED' ? `PROVEN — ${side}`",
        "  const head = st === 'LOCKED' ? `PREDICTED LOCKED — ${side}` : st === 'PROVEN LOCKED' ? `MATHEMATICALLY FINAL (price-only) — ${side}`")
s = rep(s, "push('2.7 display: LOCKED — PREDICTED UP / win / reversal / seconds / critical remaining average', dsp && dsp.headline === 'LOCKED — PREDICTED UP'",
        "push('2.7/2.8 display: PREDICTED LOCKED — UP / win / reversal / seconds / critical remaining average', dsp && dsp.headline === 'PREDICTED LOCKED — UP'")
CORE = open(os.path.join(R28, 'src', 'core28.js'), encoding='utf8').read()
GLUE = open(os.path.join(R28, 'src', 'server28.js'), encoding='utf8').read()
s = rep(s, "/* One snapshot shared by /radar and the background classifier. */",
        "globalThis.__CORE28_INLINE__ = true;\n" + CORE + "\n" + GLUE + "\n/* One snapshot shared by /radar and the background classifier. */")

# snapshot: D1 gate, replayable basis, enrichment
s = rep(s, "function computeLockSnapshot({ now = Date.now(), kal, strike, strikeIssue, overrides, quality, liveIdx, liveIndexAgeMs, side, mutate = false, indexOverride, contracts }) {",
        "function computeLockSnapshot({ now = Date.now(), kal, strike, strikeIssue, overrides, quality, liveIdx, liveIndexAgeMs, side, mutate = false, indexOverride, contracts, basisMu = null }) {")
s = rep(s, "    ? lockGeometry25({ indexNow, strike, closeMs, now, inputAgeMs: Number.isFinite(liveIndexAgeMs) ? liveIndexAgeMs : 0 }) : null;",
        "    ? lockGeometry25({ indexNow, strike, closeMs, now, inputAgeMs: Number.isFinite(liveIndexAgeMs) ? liveIndexAgeMs : (IDX.ts ? Math.max(0, now - IDX.ts) : 0), basisMu }) : null;")
s = rep(s, "    volIsWarm: volWarm(), overrides });\n  const settle = settlePanel27(",
        "    volIsWarm: volWarm(), overrides });\n"
        "  /* v2.8 D1: no live index (venue quorum failed) -> the last 1 Hz value is stale and was treated as 0 ms old */\n"
        "  if (!liveIdx && !Number.isFinite(indexOverride)) gates.hard.push('live index unavailable (' + (IDX.lastReason || 'no venue quorum') + '): the last good value is not used for a decision');\n"
        "  const settle = settlePanel27(")
s = rep(s, "  return { geo, gates, signal, settle };", "  enrich28(signal, { geo, settle, kal, now, tau });             // v2.8: display-only enrichment\n  return { geo, gates, signal, settle };")

# background tick: tape + shadow policies + ledger
s = rep(s, "    const c0 = process.hrtime.bigint();\n    const snap = computeLockSnapshot({ now, kal, strike: kal.strike, strikeIssue, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true });",
        "    const pre28 = tapePre28({ now, kal, liveIdx, age, quality, strikeIssue });     // v2.8: inputs exactly as used\n"
        "    const c0 = process.hrtime.bigint();\n    const snap = computeLockSnapshot({ now, kal, strike: kal.strike, strikeIssue, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true });")
s = rep(s, "    predLog27(snap.signal, snap.geo, snap.settle, snap.gates, Number(process.hrtime.bigint() - c0) / 1e6);   // v2.7\n",
        "    predLog27(snap.signal, snap.geo, snap.settle, snap.gates, Number(process.hrtime.bigint() - c0) / 1e6);   // v2.7\n"
        "    latNote28(LAT28, 'bgSnapshotMs', Number(process.hrtime.bigint() - c0) / 1e6);\n"
        "    try { bg28(snap, pre28, now); } catch (e) { BG.lastErr = '2.8: ' + String(e && e.message || e); }   // v2.8\n")
# settlement -> score the shadow policies, commit the outcome
s = rep(s, "  ledgerFinalize(p.ticker, result, official);\n", "  ledgerFinalize(p.ticker, result, official);\n  try { shadowFinalize28(p.ticker, result, official); } catch (_) { }   // v2.8\n")
s = rep(s, "startSampler(); startSentinel(); startKalshi(); startRestFallback(); startBackground();",
        "startSampler(); startSentinel(); startKalshi(); startRestFallback(); startBackground(); start28();")

# /radar: latency + designation of the window that just closed
s = rep(s, "  const serverMs = Number(process.hrtime.bigint() - t0) / 1e6;\n  return {\n    ok: true, version: SERVER_VERSION, build: BUILD_ID, ts: Date.now(), serverComputeMs: round(serverMs, 3),\n"
           "    /* ---- v2.4 ---- */\n    signal: lock.signal, lastWindow: lastWindowSummary(now), modelVersion: MODEL_VERSION,",
        "  const serverMs = Number(process.hrtime.bigint() - t0) / 1e6;\n"
        "  latNote28(LAT28, 'radarComputeMs', serverMs);                                    // v2.8\n"
        "  clientLat28(payload, Date.now());                                                  // unauthenticated: clamped + rate-limited\n"
        "  const lw28 = lastWindowSummary(now);\n"
        "  return {\n    ok: true, version: SERVER_VERSION, build: BUILD_ID, ts: Date.now(), serverComputeMs: round(serverMs, 3),\n"
        "    /* ---- v2.4 ---- */\n    signal: lock.signal, lastWindow: lw28 ? { ...lw28, designation: lastWindowDesignation28(lw28) } : null, modelVersion: MODEL_VERSION,\n"
        "    v28: { prereg: PREREG28_ID, configHash: CONFIG28_HASH, ledgerHead: L28.head, scoredWindows: SHADOW28.scored },")

# health + routes
s = rep(s, "        predictionLog: { rows: PRED27.rows.length, dropped: PRED27.dropped, file: PRED_LOG_FILE || null, fileErr: PRED27.fileErr },\n        ts: now\n      });",
        "        predictionLog: { rows: PRED27.rows.length, dropped: PRED27.dropped, file: PRED_LOG_FILE || null, fileErr: PRED27.fileErr },\n"
        "        v28: v28Summary(now),\n        ts: now\n      });")
ROUTES = open(os.path.join(R28, 'src', 'routes28.js'), encoding='utf8').read()
s = rep(s, "    if (req.method === 'GET' && u.pathname === '/basis') {", ROUTES + "    if (req.method === 'GET' && u.pathname === '/basis') {")

# self-test additions
ST = open(os.path.join(R28, 'src', 'selftest28.js'), encoding='utf8').read()
s = rep(s, "  const failed = checks.filter(c => !c.pass);", ST + "\n  const failed = checks.filter(c => !c.pass);")

# exports
s = rep(s, "BRTI_STALE_MS, BRTI_GATE_MAX_FLIP, BRTI_MAX_DIVERGENCE_USD, BRTI_COUNT_TOL\n};",
        "BRTI_STALE_MS, BRTI_GATE_MAX_FLIP, BRTI_MAX_DIVERGENCE_USD, BRTI_COUNT_TOL,\n"
        "  // v2.8\n  ...CORE28, FEE28, fee28Refresh, fee28Recompute, L28, SHADOW28, LAT28, TAPE28, CONFIG28, CONFIG28_HASH, PREREG28_ID, enrich28,\n"
        "  tapePre28, tapeRecord28, tapeSample28, bg28, shadowFinalize28, shadowExpire28, settleRestored28, heartbeat28, v28Summary, lastWindowDesignation28, settledFor28, calib28,\n"
        "  clientLat28, ledgerVerify28, tapeWrite28, TAPE28_FILE_MAX\n};")

# the list of environment variables the final server reads (static process.env.X plus the 2.8 dynamic ones)
import re, json
keys = sorted(set(re.findall(r'process\.env\.([A-Z0-9_]+)', s)) | {'FEE_TAKER_MULT', 'FEE_MAKER_MULT', 'FEE_ROUNDING', 'FEE_PER_FILL', 'LADDER_SIZES', 'MONITOR_P0', 'LEDGER_MAX', 'TAPE_MAX', 'TAPE_FILE_MAX_MB'})
s = rep(s, "const ENV_KEYS28 = /*ENV_KEYS28*/[];", "const ENV_KEYS28 = " + json.dumps(keys) + ";")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(s)
print('built', OUT, 'sha256', hashlib.sha256(s.encode()).hexdigest(), len(s.splitlines()), 'lines')
