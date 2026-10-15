"""Build 2.8.1/dist/pinradar_server.js from the 2.8 build (2.8/dist/pinradar_server.js, sha 0efd86c9...), which is
byte-identical to what the user deployed on Oct 14 23:22 UTC. Every patch must match exactly once (the build aborts otherwise).
usage: python3 2.8.1/build/build_server281.py

2.8.1 = 2.8 + the late-LOCKED fixes (src/late281.js):
  cold-start volatility envelope and cold basis envelope after a restart (worst probability over what the server cannot pin down yet),
  order time (EXEC_SEC / page setting) in the TOO LATE rule, execution stress test for TRADE NOW,
  action states (TRADE NOW / PREDICTED LOCKED / TOO LATE TO TRADE / SIT OUT / FINAL), warm-up status, /exec diagnostics.
With >= 900 s of index history, >= BASIS_WARM_N live basis samples and EXEC_SEC=0 the decisions equal 2.8's."""
import hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
R281 = os.path.abspath(os.path.join(HERE, '..'))
SRC = os.path.abspath(os.path.join(R281, '..', '2.8', 'dist', 'pinradar_server.js'))
OUT = os.path.join(os.environ.get('BUILD281_OUT_DIR') or os.path.join(R281, 'dist'), 'pinradar_server.js')
s = open(SRC, encoding='utf8').read()
sha = hashlib.sha256(s.encode()).hexdigest()
if not sha.startswith('0efd86c9050a3be6'):
    sys.exit('build281: 2.8/dist/pinradar_server.js is not the delivered 2.8 build (sha ' + sha[:16] + ')')


def rep(s, old, new, count=1):
    n = s.count(old)
    if n != count:
        sys.exit(f'build281: expected {count} match(es), found {n}: {old[:140]!r}')
    return s.replace(old, new)


s = rep(s, "const SERVER_VERSION = 'pin-radar-2.8';", "const SERVER_VERSION = 'pin-radar-2.8.1';")
s = rep(s, "const BUILD_ID = '2.8-2026-10-14';", "const BUILD_ID = '2.8.1-2026-10-15';")
s = rep(s, "  'D4-proven-needs-official-agreement', 'D5-official-reversal-numbers', 'D6-final-needs-60-of-60'];",
        "  'D4-proven-needs-official-agreement', 'D5-official-reversal-numbers', 'D6-final-needs-60-of-60',\n"
        "  // v2.8.1 (Oct 15: late-LOCKED investigation of the Oct 14 23:30 UTC window)\n"
        "  'cold-start-volatility-envelope', 'cold-basis-envelope', 'order-time-too-late-rule', 'execution-stress-test', 'action-states', 'warm-up-status'];")
s = rep(s, "const PREREG28_ID = 'pinradar-2.8-prereg-v2';", "const PREREG28_ID = 'pinradar-2.8.1-prereg-v3';")

# order time: TOO LATE when tau < MIN_EXEC_TAU + order time (one place, so production, shadows and the ledger agree)
s = rep(s, """function m25Cfg(contracts) {
  return { lockMaxFlip: LOCK_MAX_FLIP, highMaxFlip: HIGH_MAX_FLIP, leanMaxFlip: LEAN_MAX_FLIP, revFlip: REV_FLIP,
    minEdgeCents: MIN_EDGE_CENTS, minExecTau: MIN_EXEC_TAU, maxBookAgeMs: MAX_BOOK_AGE_MS,""",
        """function m25Cfg(contracts, execSec) {
  const ex = typeof execSec281 === 'function' ? execSec281(execSec) : 0;          // v2.8.1: the trader's order time
  return { lockMaxFlip: LOCK_MAX_FLIP, highMaxFlip: HIGH_MAX_FLIP, leanMaxFlip: LEAN_MAX_FLIP, revFlip: REV_FLIP,
    minEdgeCents: MIN_EDGE_CENTS, minExecTau: MIN_EXEC_TAU + ex, execSec: ex, maxBookAgeMs: MAX_BOOK_AGE_MS,""")
# m25Decide: stress input; time is checked before the book (a closed window is TOO LATE whatever the book says)
s = rep(s, "function m25Decide({ tau, pUp, pUpCons, gates, book, cfg, hist = [], lockedSide = null, provenSide = null }) {",
        "function m25Decide({ tau, pUp, pUpCons, pUpStress = null, gates, book, cfg, hist = [], lockedSide = null, provenSide = null }) {")
s = rep(s, """  else if (locked) {
    if (!bookOk) { tr.action = book && book.ok ? 'LOCKED — BOOK STALE' : 'LOCKED — NO BOOK';""",
        """  else if (locked) {
    const ex = cfg.execSec || 0;
    /* v2.8.1: with an order time, time is checked first (past the last order moment nothing else matters); EXEC_SEC=0 keeps 2.8's order */
    if (ex > 0 && Number.isFinite(tau) && tau < cfg.minExecTau) { tr.action = 'LOCKED — TOO LATE'; tr.why = `${Math.max(0, tau).toFixed(1)} s left: an order needs ~${ex} s to place + ${MIN_EXEC_TAU} s to fill (last moment was T−${cfg.minExecTau} s)`; }
    else if (!bookOk) { tr.action = book && book.ok ? 'LOCKED — BOOK STALE' : 'LOCKED — NO BOOK';""")
s = rep(s, """    else if (!(tr.evConsCents >= cfg.minEdgeCents)) { tr.action = 'LOCKED — DO NOT TRADE'; tr.why = `price ${tr.avgCents}¢ + fee ${tr.feeCents}¢ leaves ${tr.evConsCents}¢ conservative edge (< ${cfg.minEdgeCents}¢)`; }
    else { tr.action = 'TRADE NOW';""",
        """    else if (!(tr.evConsCents >= cfg.minEdgeCents)) { tr.action = 'LOCKED — DO NOT TRADE'; tr.why = `price ${tr.avgCents}¢ + fee ${tr.feeCents}¢ leaves ${tr.evConsCents}¢ conservative edge (< ${cfg.minEdgeCents}¢)`; }
    else if (pUpStress != null && Number.isFinite(pUpStress) && (100 * (out.side === 'UP' ? pUpStress : 1 - pUpStress) - tr.avgCents - tr.feeCents) < 0) {   // v2.8.1
      tr.evStressCents = Math.round((100 * (out.side === 'UP' ? pUpStress : 1 - pUpStress) - tr.avgCents - tr.feeCents) * 100) / 100;
      tr.action = 'LOCKED — DO NOT TRADE'; tr.why = `the edge does not survive a ${EXEC_STRESS_Z}σ BTC move against ${out.side} during your ${cfg.execSec || 0} s order time (stress value ${tr.evStressCents}¢)`; }
    else { tr.action = 'TRADE NOW';""")

# no offers on the called side is a MARKET state (nobody sells below 100c), not a timing state: keep 2.8's action string
# (compatibility) but flag it and say what it means; exec281 shows it as PREDICTED LOCKED (NO OFFERS), not TOO LATE
s = rep(s, "    else if (!lv || !lv.length) { tr.action = 'LOCKED — TOO LATE'; tr.why = `no ${out.side} offers left on Kalshi`; }",
        "    else if (!lv || !lv.length) { tr.action = 'LOCKED — TOO LATE'; tr.noOffers = true; tr.why = `no ${out.side} offers on Kalshi: nobody is selling ${out.side} below 100¢ (the market already treats it as decided)`; }   // v2.8.1")
# classify25: order time and stress; the 2.8 warm-up gate stays for the first COLD_MIN_SEC (geo.sigmaWarm is true once the envelope covers it)
s = rep(s, "function classify25({ now = Date.now(), tau, ticker, closeMs, strike, geo, gates, kal, contracts, mutate = false }) {\n  const ls = lock25For(ticker);\n  const cfg = m25Cfg(contracts);",
        "function classify25({ now = Date.now(), tau, ticker, closeMs, strike, geo, gates, kal, contracts, mutate = false, execSec }) {\n  const ls = lock25For(ticker);\n  const cfg = m25Cfg(contracts, execSec);")
s = rep(s, "  if (geo && !geo.sigmaWarm) g.soft.push('volatility estimate warming up (needs ~5 min of index history after a restart)');",
        "  if (geo && !geo.sigmaWarm) g.soft.push(`volatility estimate warming up (LOCKED needs ${typeof COLD_MIN_SEC !== 'undefined' ? COLD_MIN_SEC : 300} s of index history after a restart)`);")
s = rep(s, "  const d = m25Decide({ tau, pUp: geo ? geo.pUp : null, pUpCons: geo ? geo.pUpCons : null, gates: g, book, cfg, hist,",
        "  const pUpStress = geo && typeof stressPUp281 === 'function' ? stressPUp281(geo, tau, cfg.execSec) : null;   // v2.8.1\n"
        "  const d = m25Decide({ tau, pUp: geo ? geo.pUp : null, pUpCons: geo ? geo.pUpCons : null, pUpStress, gates: g, book, cfg, hist,")

# late281 module
LATE = open(os.path.join(R281, 'src', 'late281.js'), encoding='utf8').read()
s = rep(s, "/* One snapshot shared by /radar and the background classifier. */",
        LATE + "\n/* One snapshot shared by /radar and the background classifier. */")

# snapshot: cold envelopes, order time, action states
s = rep(s, "function computeLockSnapshot({ now = Date.now(), kal, strike, strikeIssue, overrides, quality, liveIdx, liveIndexAgeMs, side, mutate = false, indexOverride, contracts, basisMu = null }) {",
        "function computeLockSnapshot({ now = Date.now(), kal, strike, strikeIssue, overrides, quality, liveIdx, liveIndexAgeMs, side, mutate = false, indexOverride, contracts, basisMu = null, execSec, basisLiveN }) {\n"
        "  const ex281 = execSec281(execSec);")
s = rep(s, "  const geo = (!strikeIssue && Number.isFinite(strike) && Number.isFinite(closeMs))\n"
           "    ? lockGeometry25({ indexNow, strike, closeMs, now, inputAgeMs: Number.isFinite(liveIndexAgeMs) ? liveIndexAgeMs : (IDX.ts ? Math.max(0, now - IDX.ts) : 0), basisMu }) : null;",
        "  const geoArgs = { indexNow, strike, closeMs, now, inputAgeMs: Number.isFinite(liveIndexAgeMs) ? liveIndexAgeMs : (IDX.ts ? Math.max(0, now - IDX.ts) : 0), basisMu };\n"
        "  const geo0 = (!strikeIssue && Number.isFinite(strike) && Number.isFinite(closeMs)) ? lockGeometry25(geoArgs) : null;\n"
        "  /* v2.8.1: after a restart the call uses the worst probability over the volatility / basis the server cannot yet pin down */\n"
        "  const cv281 = coldVol281(now, IDX.ring), bc281 = basisCold281(basisMu, basisLiveN);\n"
        "  const geo = geo0 && ((cv281.cold && cv281.usable) || bc281.cold) ? coldGeometry281(geo0, geoArgs, cv281, bc281) : geo0;")
s = rep(s, "  const signal = brtiAfterClassify27(classify25({ now, tau, ticker: kal && kal.ticker, closeMs, strike, geo, gates, kal, contracts, mutate }), settle, kal && kal.ticker);",
        "  const signal = brtiAfterClassify27(classify25({ now, tau, ticker: kal && kal.ticker, closeMs, strike, geo, gates, kal, contracts, mutate, execSec: ex281 }), settle, kal && kal.ticker);")
s = rep(s, "  enrich28(signal, { geo, settle, kal, now, tau });             // v2.8: display-only enrichment\n  return { geo, gates, signal, settle };",
        "  enrich28(signal, { geo, settle, kal, now, tau });             // v2.8: display-only enrichment\n"
        "  if (signal) { signal.warmup = warmup281(now, cv281, bc281); signal.cold = geo && geo.cold281 ? geo.cold281 : null;\n"
        "    if (signal.v28 && signal.v28.execution) { signal.v28.execution.enoughTime = Number.isFinite(tau) && tau >= MIN_EXEC_TAU + ex281; signal.v28.execution.orderTimeSec = ex281;\n"
        "      signal.v28.execution.ready = !!(signal.v28.execution.ready && signal.v28.execution.enoughTime); } }\n"
        "  exec281(signal, { tau, execSec: ex281, now });               // v2.8.1: the action a trader should take now\n"
        "  return { geo, gates, signal, settle };")
# /radar: the page's order time
s = rep(s, "    liveIndexAgeMs, side, mutate: false, indexOverride: Number.isFinite(priceOverride) ? priceOverride : undefined,\n    contracts: payload.contracts });",
        "    liveIndexAgeMs, side, mutate: false, indexOverride: Number.isFinite(priceOverride) ? priceOverride : undefined,\n    contracts: payload.contracts, execSec: payload.execSec });")
# tape: the basis model's sample count (the cold-basis envelope depends on it)
s = rep(s, "  return { ts: now, kal: kal ? { ok: kal.ok, ticker: kal.ticker, closeMs: kal.closeMs, openMs: kal.openMs, strike: kal.strike } : null,",
        "  return { ts: now, basisN: BASIS.samples.length, kal: kal ? { ok: kal.ok, ticker: kal.ticker, closeMs: kal.closeMs, openMs: kal.openMs, strike: kal.strike } : null,")
# shadow candidates see the same stress input as production
s = rep(s, "  const dec = (pUp, pUpCons, c = cfg) => guard(deps.m25Decide({ tau, pUp, pUpCons, gates, book, cfg: c, hist, lockedSide, provenSide: geo.provenUp ? 'UP' : null }));",
        "  const dec = (pUp, pUpCons, c = cfg) => guard(deps.m25Decide({ tau, pUp, pUpCons, pUpStress: deps.stressPUp ? deps.stressPUp(geo, tau, c.execSec) : null, gates, book, cfg: c, hist, lockedSide, provenSide: geo.provenUp ? 'UP' : null }));")
s = rep(s, "      try { d = shadowDecide28(p.id, { snap: view, deps: { m25Decide, recalPUp26, recalRatio26 }, cfg, lockedSide: rec ? rec.lockedSide : null, hist: LOCK25.hist, impulse: imp, tau }); }",
        "      try { d = shadowDecide28(p.id, { snap: view, deps: { m25Decide, recalPUp26, recalRatio26, stressPUp: stressPUp281 }, cfg, lockedSide: rec ? rec.lockedSide : null, hist: LOCK25.hist, impulse: imp, tau }); }")

# health + /exec
s = rep(s, "        v28: v28Summary(now),\n        ts: now\n      });",
        "        v28: v28Summary(now),\n"
        "        warmup: (() => { const cv = coldVol281(now, IDX.ring), bc = basisCold281(null); return warmup281(now, cv, bc); })(),   // v2.8.1\n"
        "        execution: { orderTimeSec: EXEC_SEC, stressZ: EXEC_STRESS_Z, minExecTau: MIN_EXEC_TAU, coldEnvelope: COLD281_ON, coldMinSec: COLD_MIN_SEC, basisWarmN: BASIS_WARM_N, basisColdRange: [BASIS_COLD_LO, BASIS_COLD_HI] },\n"
        "        ts: now\n      });")
s = rep(s, "    if (req.method === 'GET' && u.pathname === '/basis') {",
        "    if (req.method === 'GET' && u.pathname === '/exec') return send(res, 200, { ok: true, version: SERVER_VERSION, ...exec281Summary() });   // v2.8.1\n"
        "    if (req.method === 'GET' && u.pathname === '/basis') {")

# self-test additions
ST = open(os.path.join(R281, 'src', 'selftest281.js'), encoding='utf8').read()
s = rep(s, "  const failed = checks.filter(c => !c.pass);", ST + "\n  const failed = checks.filter(c => !c.pass);")

# exports
s = rep(s, "  clientLat28, ledgerVerify28, tapeWrite28, TAPE28_FILE_MAX\n};",
        "  clientLat28, ledgerVerify28, tapeWrite28, TAPE28_FILE_MAX,\n"
        "  // v2.8.1\n  coldVol281, basisCold281, coldGeometry281, stressPUp281, exec281, exec281Summary, warmup281, execSec281, EXEC281, COLD_TABLE281,\n"
        "  COLD_MIN_SEC, COLD_FULL_SEC, COLD281_ON, BASIS_WARM_N, BASIS_COLD_LO, BASIS_COLD_HI, EXEC_SEC, EXEC_STRESS_Z\n};")

# the environment variables the server reads (config hash input): recomputed over the final source
m = re.search(r'const ENV_KEYS28 = (\[[^\]]*\]);', s)
if not m:
    sys.exit('build281: ENV_KEYS28 literal not found')
old = json.loads(m.group(1))
keys = sorted(set(old) | set(re.findall(r'process\.env\.([A-Z0-9_]+)', s)))
s = s.replace(m.group(0), 'const ENV_KEYS28 = ' + json.dumps(keys) + ';', 1)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, 'w', encoding='utf8').write(s)
print('built', OUT, 'sha256', hashlib.sha256(s.encode()).hexdigest(), len(s.splitlines()), 'lines', 'new env keys', sorted(set(keys) - set(old)))
