"""Build dist27/pinradar_server.js (Pin Radar 2.7) from the delivered 2.6 build (dist26/pinradar_server.js, sha 141c0613...).
Every patch must match exactly once.  usage: python3 build/build_server27.py
2.7 = 2.6 probability engine UNCHANGED + exact settlement panel (recorded average, observations, critical remaining
      average, move/jump needed) + Kalshi cfbenchmarks_value BRTI client on the existing authenticated socket
      (official settlement accumulator; gate that can only withhold LOCKED; official REVERSAL WARNING that can only add
      warnings; shadow official-reference flip risk) + per-second prediction log + /brti-status, /brti-messages, /predictions."""
import hashlib, os, subprocess

ROOT = '/home/claude/pr25'
src = os.path.join(ROOT, 'dist26/pinradar_server.js')
s = open(src).read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('141c0613cf3bda8a'):
    raise SystemExit('build27: dist26/pinradar_server.js is not the delivered 2.6 build (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        raise SystemExit(f'build27: expected {count} match(es), found {n}: {old[:100]!r}')
    return s.replace(old, new)


s = rep(s, "const SERVER_VERSION = 'pin-radar-2.6';", "const SERVER_VERSION = 'pin-radar-2.7';")
s = rep(s, "const BUILD_ID = '2.6-2026-10-13';", "const BUILD_ID = '2.7-2026-10-13';")
s = rep(s, "  'regime-recalibrated-flip-risk', 'lock-horizon-300s', 'market-disagreement-guard', 'lock-evidence-lines'];",
        "  'regime-recalibrated-flip-risk', 'lock-horizon-300s', 'market-disagreement-guard', 'lock-evidence-lines',\n"
        "  // v2.7 (Oct 13: exact settlement mathematics on screen; official CF Benchmarks BRTI reference when the key is entitled)\n"
        "  'exact-settlement-panel', 'official-brti-reference', 'official-brti-lock-gate', 'official-brti-reversal-warning', 'per-second-prediction-log'];")

# --- 2.7 block (settlement arithmetic, BRTI client state machine, panel, gate, display, prediction log) ---
B27 = open(os.path.join(ROOT, 'src/brti27.js')).read()
s = rep(s, "/* One snapshot shared by /radar and the background classifier. */",
        B27 + "\n/* One snapshot shared by /radar and the background classifier. */")

# --- snapshot: panel before the gates, official gate, official reversal + display after classification ---
s = rep(s, "  const signal = classify25({ now, tau, ticker: kal && kal.ticker, closeMs, strike, geo, gates, kal, contracts, mutate });\n  return { geo, gates, signal };",
        "  const settle = settlePanel27({ now, closeMs, strike, geo, tau });            // v2.7: OFFICIAL when live, else PROXY\n"
        "  brtiGate27(gates, settle, geo);                                              // v2.7: can only withhold LOCKED\n"
        "  const signal = brtiAfterClassify27(classify25({ now, tau, ticker: kal && kal.ticker, closeMs, strike, geo, gates, kal, contracts, mutate }), settle, kal && kal.ticker);\n"
        "  return { geo, gates, signal, settle };")
s = rep(s, "    const snap = computeLockSnapshot({ now, kal, strike: kal.strike, strikeIssue, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true });\n"
           "    BG.ticks++; logSignal(snap.signal);",
        "    const c0 = process.hrtime.bigint();\n"
        "    const snap = computeLockSnapshot({ now, kal, strike: kal.strike, strikeIssue, overrides: [], quality, liveIdx, liveIndexAgeMs: age, side: null, mutate: true });\n"
        "    BG.ticks++; logSignal(snap.signal);\n"
        "    predLog27(snap.signal, snap.geo, snap.settle, snap.gates, Number(process.hrtime.bigint() - c0) / 1e6);   // v2.7")

# --- Kalshi socket: subscribe BRTI on every open, route BRTI messages, mark closes ---
s = rep(s, "    KAL.wsState = 'open'; kalshiWsBackoff = 1000; KAL.wsSubscribedTicker = null;\n    kalshiWsSync();\n  });",
        "    KAL.wsState = 'open'; kalshiWsBackoff = 1000; KAL.wsSubscribedTicker = null;\n    kalshiWsSync();\n"
        "    brtiSubscribe27(ws, () => ++kalshiWsMsgId);                                  // v2.7 official BRTI (needs entitlement)\n  });")
s = rep(s, "  ws.on('close', () => { KAL.wsState = 'closed'; KAL.wsSubscribedTicker = null; scheduleKalshiWs(); });",
        "  ws.on('close', () => { KAL.wsState = 'closed'; KAL.wsSubscribedTicker = null; brtiSocketClosed27(); scheduleKalshiWs(); });")
s = rep(s, "    const j = JSON.parse(String(d));\n",
        "    const j = JSON.parse(String(d));\n    if (brtiHandle27(j, Date.now(), d)) return;                                   // v2.7 BRTI messages\n")

# --- health + routes ---
s = rep(s, "        clockSkewMs: Math.round(SKEW.estMs), clockSkewSamples: SKEW.samples.length,\n        ts: now\n      });",
        "        clockSkewMs: Math.round(SKEW.estMs), clockSkewSamples: SKEW.samples.length,\n"
        "        brti: (() => { brtiHousekeeping27(now); return { enabled: BRTI.enabled, state: BRTI.state, msgs: BRTI.msgs, lastMsgAgeMs: BRTI.lastMsgAt ? now - BRTI.lastMsgAt : null, seqGaps: BRTI.seqGaps }; })(),\n"
        "        predictionLog: { rows: PRED27.rows.length, dropped: PRED27.dropped, file: PRED_LOG_FILE || null, fileErr: PRED27.fileErr },\n"
        "        ts: now\n      });")
ROUTES = r"""    /* v2.7: official BRTI reference status (entitlement, ticks, accumulator vs Kalshi's official settlements, latency) */
    if (req.method === 'GET' && u.pathname === '/brti-status') { ensureStarted(); return send(res, 200, brtiStatus27(Date.now())); }
    /* v2.7: the last raw cfbenchmarks_value messages exactly as received (for replay tests) */
    if (req.method === 'GET' && u.pathname === '/brti-messages') {
      const n = clamp(Number(u.searchParams.get('n') || 600), 1, 600);
      return send(res, 200, { ok: true, version: SERVER_VERSION, n: Math.min(n, BRTI.raw.length), messages: BRTI.raw.slice(-n) });
    }
    /* v2.7: per-second prediction log (every background tick inside the 300 s LOCKED horizon) */
    if (req.method === 'GET' && u.pathname === '/predictions') {
      const since = Number(u.searchParams.get('since') || 0), tk = u.searchParams.get('ticker');
      const n = clamp(Number(u.searchParams.get('n') || 5000), 1, PRED_LOG_MAX);
      const rows = PRED27.rows.filter(r => r.ts >= since && (!tk || r.ticker === tk)).slice(-n);
      if (u.searchParams.get('format') === 'ndjson') { cors(res); res.setHeader('Content-Type', 'application/x-ndjson'); return res.end(rows.map(r => JSON.stringify(r)).join('\n') + '\n'); }
      return send(res, 200, { ok: true, version: SERVER_VERSION, n: rows.length, dropped: PRED27.dropped, rows });
    }
"""
s = rep(s, "    if (req.method === 'GET' && u.pathname === '/basis') {", ROUTES + "    if (req.method === 'GET' && u.pathname === '/basis') {")

# --- self-tests + exports ---
ST = open(os.path.join(ROOT, 'src/selftest27.js')).read()
s = rep(s, "  const failed = checks.filter(c => !c.pass);", ST + "\n  const failed = checks.filter(c => !c.pass);")
s = rep(s, "  recalFlip26, recalPUp26, recalRatio26, recalGroup26, evidence26, RECAL_QUIET, RECAL_NORMAL, RECAL_ACTIVE, MIN_TRADE_ASK_CENTS, LOCK_MAX_TAU\n};",
        "  recalFlip26, recalPUp26, recalRatio26, recalGroup26, evidence26, RECAL_QUIET, RECAL_NORMAL, RECAL_ACTIVE, MIN_TRADE_ASK_CENTS, LOCK_MAX_TAU,\n"
        "  // v2.7\n  SETTLE_TICKS, settleRound2, settleMath, BRTI, PRED27, brtiSubscribe27, brtiSocketClosed27, brtiHandle27, brtiHousekeeping27, brtiOfficialState27,\n"
        "  settlePanel27, brtiGate27, brtiAfterClassify27, predLog27, brtiStatus27, BRTI_STALE_MS, BRTI_GATE_MAX_FLIP, BRTI_MAX_DIVERGENCE_USD, BRTI_COUNT_TOL\n};")

os.makedirs(os.path.join(ROOT, 'dist27'), exist_ok=True)
out = os.path.join(ROOT, 'dist27/pinradar_server.js')
open(out, 'w').write(s)
r = subprocess.run(['node', '--check', out], capture_output=True, text=True)
print('built', out, len(s), 'bytes;', 'syntax OK' if r.returncode == 0 else 'SYNTAX ERROR\n' + r.stderr)
