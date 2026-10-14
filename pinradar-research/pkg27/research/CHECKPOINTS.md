# Pin Radar 2.5 — checkpoints (resume from here after any interruption)

Work dir: /home/claude/pr25   (survives container restarts; /tmp and processes do not)

## CP0 — production state (verified 2026-10-13 18:35 UTC)
- LIVE backend: btc-ai-backend@c9e0df6 (uploaded 09:40 PT Oct 13) pinradar_server.js == 2.3 (39e8514), sha256 92363239c94efd6c…
  /health: version pin-radar-2.3, build 2.3-2026-09-21. Render redeploy wiped the 2.4 in-memory ledger.
- LIVE page: Btc-signal@f3eb239 btc_pin_radar.html == 2.3 (f4b90bd), sha256 70a6aabf9d609ae9…
- Local copies: srv23.js / page23.html (live), srv24.js / page24.html (abandoned 2.4).
- 2.4 live ledger snapshot saved before the revert: data/live/*_20261013T150905Z.json (5000 signals, 127 closed ledger records).

## CP1 — root cause of "too conservative" (verified from code + live 2.4 signal log)
- 2.3 page headline = pin pressure (CLEAR = pinPressure < 22). It never shows direction or P(win).
- "settlement N% locked" (page23.html lvLock, line ~642) = (60 - tau)/60: elapsed seconds of the averaging window, not an outcome call.
- 2.4 server DID call Oct 13 11:00 ET window: HIGH CONF DOWN T-126, PREDICTED LOCK DOWN T-101 (pLoss 0.3%), but the 2.3 page cannot display it.
- Kalshi tape KXBTC15M-26OCT131100-00: DOWN traded 99.5-99.8c at T-120..105, 99.8-99.9c by T-101, last DOWN taker buy T-46. Official 83431.86 vs strike 83600.72 -> NO.
- 2.3 sigmasOfCushion = |gap| / (sigma * sqrt(t^3/(3W^2))): denominator collapses as tau^1.5 -> 20σ at T-37 is not a probability; capped at 99.

## CP2 — data (resumable downloads; relaunch with analysis/launch.sh, see logs/)
- data/kalshi/markets.json: 5,757 KXBTC15M markets Aug 14 00:00 -> Oct 13 15:15 UTC, all finalized, official expiration_value.
- data/kalshi/tapes/<ticker>.csv.gz: final-200 s trade tape (ts, taker_side, yes_price, count). Fetcher: analysis/fetch_kalshi_pool.py (skips done files).
- data/cb, data/kr: Coinbase / Kraken trade tapes Aug 13 12:00 -> Oct 13 15:17 UTC, chunked, checkpointed per range (_ckpt_*.json).
  Relaunch: cb ranges in /tmp/claude-0/cb_ranges.txt (8 ranges, see logs/cb*.log); kr: krA 1787622256.067..1789763457, krB 1789763457..1791904658.
- Rules verified from Kalshi market record: YES iff mean of 60 BRTI seconds before close >= mean of 60 s before open (= floor_strike); rounded 2 dp.

## CP3 — research code (analysis/)
- build_index.py -> data/derived/sec.npz (1 Hz proxy = cb 1.0 / kr 0.8 last-trade, 30 s staleness)
- build_windows.py -> data/derived/windows.npz (per window x tau 0..300: S, F, m, gap, rolling vols, basis)
- model.py: empirical standardized-path tables Z(tau) (both tails), basis mixture, P(UP)
- predict.py: walk-forward predictions; evaluate.py: reliability; kexec.py: Kalshi tape fill model
- export_replay.py + replay.js: replays UNMODIFIED 2.3 / 2.4 engines on the same history (tested on 20 windows OK)
- First look (partial data): Z tails strongly vol-estimator dependent; 60 s vol -> huge tails (|Z|>6 in 4%),
  900 s or rms(120,900) -> q99.99% ~13 at every tau. Basis (official - 2-venue trade proxy): sd ~6.7, fat tails (partial data).

## Next
- finish downloads -> rebuild sec/windows -> walk-forward model selection -> thresholds -> exec study -> old-vs-new replay
- implement 2.5 server (2.4 plumbing + new lock engine + legacy 2.3 fields) + 2.5 page (2.3 page + LOCKED headline)

## CP4 — 2.5 engine code (11:58 PT)
- src/m25.js: model (empirical tables, P(UP)), fee, book walk, m25Decide (LOCKED/HIGH/LEANING/TOSS-UP/REVERSAL/DATA; trade action).
- src/srv25_parts.js: config env vars, live sigma (ringRmsVol/m25SigmaBps), lockGeometry25, bookFromKal, classify25, lockProjection.
- src/selftest25.js: 27 checks inserted into runSelfTest.
- build/build_server.py <model.json> <audit.json> <min_edge> <cons_vol> <cons_basis> <parity.json> -> dist/pinradar_server.js
  (base = srv24.js; every patch asserted to match once). Debug build: 78/78 selftest pass; JS/Python parity max err 3e-16 (3,004 cases).
- analysis/export_model.py <vol_kind> <cutoff|all> <out.json>; test/parity_model.py <model.json> <cases.json>.
- Kalshi WS handler in 2.3/2.4 does NOT maintain the book (ticker only); 2.5 uses REST book, refreshed every 400 ms in final 150 s, TRADE NOW gated on book age <= 1500 ms.
- Live recorder running (pid file logs/recorder.pid) with local 2.3 server on :10123 (logs/live23.pid) -> data/live/rec_*.ndjson.

## CP5 — results (13:10 PT)  [all walk-forward OOS, 4,428 windows Aug 28 - Oct 13, 46.6 days]
- Data complete: 5,757 Kalshi markets + tapes; Coinbase/Kraken Aug 13 - Oct 13 15:17Z; sec.npz 61.1 d, 99.8% two-venue.
- Root cause of 1.5-2x overconfidence at T-60..120: standardized tails depend on VOL LEVEL (quiet tape -> fat tails);
  momentum & quarter-hour alignment ruled out. Fix: 7 sigma-level regime tables (REGIME_KIND=sig, edges .15/.22/.30/.40/.55/.80).
- LOCKED first-call false rate: 0.99 -> 1.02% (UB 1.31%); 0.995 -> 0.37% (15/4109, UB 0.56%, median T-76); 0.999 -> 0.07%.
- Same windows: 2.3 GREEN<=60 false 3.37% (145/4304); 2.4 PREDICTED LOCK 0.35%; 2.5@0.995 0.36%. On Aug28-Sep11 (2.4 never saw): 2.3 4.35%, 2.4 0.54%, 2.5 0.37%.
- TRADE NOW (0.995 + >=10 fillable + >=0.5c cons edge): 515 trades, 2 losses, +1.41c/contract, both halves positive (H1 +1.28, H2 +1.88).
- Final: LOCK_MAX_FLIP 0.005, MIN_EDGE 0.5, CONS 1.25/1.25, LIVE_VOL_SCALE 1.03; model build/out/model_final.json; audit build/out/audit_final.json.
- dist/ built: selftest 78/78, page tests 19/19, parity 5.6e-16. rp25 (JS replay of dist) running -> analysis/parity_real.py.
- Oct 12 incident: 2.5 max 99.0% (HIGH) at T-18, never LOCKED. Oct 13 shot: LOCKED DOWN from T-101 at 99.8c (no edge); T-37 TOO LATE.

## CP6 — delivered (12:55 PT)
- Fix: print-sampling flicker (lockGeometry25 maps ring samples to print seconds; just-passed unsampled print = live index). Self-test 80/80.
- dist/ + pkg/ + pinradar-2.5.zip; deliver/ sent to user (zip, pinradar_server.js sha fadef5e4..., btc_pin_radar_25.html sha 88c179a6..., README).
- Report doc: https://claude.ai/code/artifact/75f2574b-9bf4-4908-8172-a301f69af5be (body node d7bfed41-92ac).
- Live paper: run1 (pre-fix) KXBTC15M-26OCT131545-45 LOCKED DOWN T-73.6, TRADE NOW at 98.7c, settled NO (correct).
  run2 (fixed build) started 12:46:50 PT -> data/live/paper25.ndjson; score with official results.
- Production untouched: btc-pin-radar = 2.3 (c9e0df6), page 2.3 (f3eb239).
- 13:01 PT live run2 (fixed build) KXBTC15M-26OCT131600-00: first LOCKED UP T-139.7 (99.58%), DO NOT TRADE (ask 99.2c), settled YES (correct).
  0 DATA UNRELIABLE in final 60 s; book age p50 342 ms max 1955 ms; compute p50 1.08 ms; 0 errors. Doc updated (rev 13).
- Still running in background (harmless, research only): live25 (2.5 on :10125) + paper logger, live23 (:10123) + recorder.

## CP7 — critical re-investigation (14:30 PT Oct 13) — results in results/*.json, scripts analysis/*.py
- Container restarted 13:38; relaunched live23 (:10123), live25 (:10125), recorder, paper logger (paper25_run3), log23 (live 2.3 engine -> data/live/live23_run1.ndjson).
- data/derived/tapes.npz (tapecache.py): all final-200 s Kalshi tapes merged (26.6 M rows).
- audit_failures.py -> results/audit_failures.json, failures_23.csv, failures_25.csv:
  2.3 145 wrong: 114 PATH / 31 BASIS; at the call 2.5 P(win) <0.95 in 124, none >=0.995; sigma-cushion <3 in 135. 142 later left GREEN >=10 s before close.
  All 2.3 calls by 2.5 P at same second: >=0.995 2616 calls 0 wrong. 2.3 replay omits flow/kalshi/sentinel terms, which can only ADD pressure -> replay GREEN set >= live.
  2.5 15 wrong: 12 PATH / 3 BASIS (all 3 basis = DOWN calls, basis +5..+8.5); 13/15 in vol buckets 0-2; quiet b0-1 wrong 10/1077 (0.93%) vs active b4-6 1/1341.
- actionable.py + run_actionable.py -> results/actionable.json (exec models CONS / VISIBLE / NEUTRAL / HARSH). KEY: old 515 trades/2 losses/+1.41c was optimistic
  (fill evidence censors losers). 2.5 TRADE NOW: CONS 257 tr 4 L +0.41c (CI -1.06..+1.89); VISIBLE 356/4 +1.33c. 2.3 CLEAR<=60 FIRST: CONS -4.11c, VISIBLE -0.46c.
- market_vs_model.py: market leader at 95-99c is slightly OVERpriced; model LOCKED loses ~0.5x market-implied in every price bucket; market hits 99c before model LOCKED in 85%.
- alternatives.py (folds 1-6): RECAL>=0.995 (flip x r_g walk-forward; final r = quiet 2.02 / mid 1.00 / active 0.52) wrong 12/3484, uniform by regime; VALUE CONS 250 tr 3 L +0.74c.
- sigma23_rules.py: 2.3 sigma>=k & CLEAR dominated by RECAL (e.g. 23S>=6&CLEAR 0.26% wrong med tau 57 vs RECAL>=0.997 0.23% tau 68).
- validate_fill_proxy.py (9 live windows w/ real books): tape price within 1c of real ask 92-95% of seconds; fwd fill evidence present 94-95% when ask existed.
- test/leak_truncation.py PASS. Known: table margin 310 s vs 900 s horizons leaks <=600 s only for tau>310 (not used in LOCKED results).
- NEXT: build 2.6 = 2.5 + regime recal + evidence lines + market-disagreement guard (<90c); tests; report; deliver.

## CP8 — 2.6 built and tested (14:30 PT)
- results/final_compare.json (folds 1-6, 3,766 windows): wrong LOCKED 2.3 131/3655 (3.58%), 2.4 12/3376, 2.5 14/3486, 2.6 12/3484 (uniform by regime).
  FIRST CONS pnl/contract: 2.3 -4.44c, 2.4 -0.39, 2.5 -0.11, 2.6 +0.65; VALUE CONS 2.5 +0.03 (223 tr/4 L), 2.6 +0.80 (247/2); VISIBLE 2.6 +1.30 (319/2).
- build/build_server26.py (patches dist/pinradar_server.js -> dist26/pinradar_server.js), src/selftest26.js, build/build_page26.py -> dist26/btc_pin_radar_26.html.
  Recal ratios quiet 2.02 / normal 1.00 / active 0.52 (results/alternatives_recal.json final_ratios_all_folds); LOCK_MAX_TAU 300; MIN_TRADE_ASK_CENTS 90 (LOCKED or PROVEN).
- Tests: selftest 94/94; page26 23/23; fuzz26 20k cases 0 violations (found+fixed PROVEN-LOCKED guard gap); parity26: recal layer exact (1.5e-10), raw model == current 2.5 build (subset 383 windows, diff 0);
  rp25b differs 0.0075 only because it was replayed with LIVE_VOL_SCALE=1. leak_truncation PASS.
- Live research processes: live26 (:10126) + paper26 -> data/live/paper26_run1.ndjson; live25 + paper25_run3; live23 + log23 + recorder.
- sha256 dist26: server b41c4908e358cc2c..., page 875ed613cb40f6cb...
- NEXT: package pkg26 (upload/rollback/test/research + README), update report doc (correct the optimistic 515/+1.41c claim), deliver.

## CP9 — delivered (14:50 PT Oct 13)
- Fixes after CP8: stale book -> 'LOCKED — BOOK STALE' / 'LOCKED — NO BOOK' (not TOO LATE); BOOK_FAST_TAU 300; guard covers PROVEN. selftest 94/94, page 23/23, fuzz 0 violations.
- pkg26/ + pinradar-2.6.zip (README, upload/, rollback/ == live 2.3, test/run_all.sh, research/). sha256 server 141c0613cf3b..., page 7b55e88ccb5e...
- Report doc rewritten in place (rev 27): https://claude.ai/code/artifact/75f2574b-9bf4-4908-8172-a301f69af5be — "Pin Radar 2.6 — LOCKED certification audit".
- Correction issued: interim message said "market right 36%" for 2.3 CLEAR <90c — that was the cautious (asymmetric) fill count; symmetric: 99 of 438 lost (23%).
- Live paper (no orders): 2.5 engine 5/5 LOCKED correct, 2 TRADE NOW both won (windows 15:45-17:30 ET); 2.6 live since 14:35 PT (data/live/paper26_run1.ndjson), score with analysis/score_paper.py.
- Production untouched: btc-pin-radar /health = pin-radar-2.3 2.3-2026-09-21.

## CP10 — archive replay (Archive_2.zip, 16:30 PT Oct 13) — all in archive2/
- Parsed 344 files (172 unique): 4,288 unique trades on 4,094 contracts (Jul 23 - Oct 12), 570 real-money LIVE_FILL orders.
- Data added: data/cb_ext, data/kr_ext (Jul 22 - Aug 13), data/derived/sec_all.npz (Jul 22 - Oct 13), Kalshi historical store
  (data/kalshi/markets_hist.json, tapes for Jul 23 - Aug 13 contracts) via analysis/fetch_kalshi_hist.py.
- Exact dist26 replay (archive2/replay_archive.js) of every contract: entries + every second T-300..0 -> rp_archive_p0/p1.ndjson.
- Results (out/summary.json): LOCKED 3,731 / lost 15 (0.40%); holdout Jul23-Aug13 1/1,408; Aug13-Oct12 14/2,323; first LOCK <60 s 1/1,350, >=60 s 14/2,381.
  TRADE NOW cons 326/3 +0.72c; visible 410/3 +1.02c. Old engine claimed 78.2% won 64.7%; 2.6 at same moments 64.8%/64.7%.
- Oct 12 17:45 PT contract (not in archive trades): 2.6 HIGH CONFIDENCE UP peak 99.43% at T-18, never LOCKED, settled DOWN by $2.55.
- Workbook: out/PinRadar26_historical_replay.xlsx (formulas recalculated, 0 errors). verify_sample.py PASS (400 seconds).

## CP11 — settlement-aware investigation (request 19:16 PT Oct 13; full text notes/request_1916.md)
- Docs (verified 19:2x PT): cfbenchmarks_value (1 Hz, auth WS) msg fields index_id, received_at, data (raw CF frame string), avg_60s_data
  (trailing [ts-60s, ts) - NOT settlement), last_60s_windowed_average_15min {value, window_size, window_start_ts_ms, window_end_ts_exclusive}
  only in final minute, accumulates (close-60s, close], window_size = second within minute (:01 -> 1 ... close tick -> 60).
  cfbenchmarks_value_5hz: value_usd, source_ts_ms, received_at; lean ticks, no averages (BRTI/ETH/SOL/XRP/DOGE).
  REST passthrough GET /trade-api/v2/cfbenchmarks/values?id=BRTI and /history/values (sign path w/o query; entitlement; 50 read tokens ~4 req/s Basic).
  Unauthenticated probes: REST 401 token_authentication_failure; WS /trade-api/ws/v2 401. Entitlement of David's key UNVERIFIED.
- src/settle27.js (exact arithmetic) + test/settlement_math_test.js 18/18 PASS (2.6 lockGeometry25 = exact arithmetic on its own index).
- archive2/oct12_forensic.py -> archive2/out/oct12_forensic.json (T-18: move needed $48.66, 2.6 flip 0.566%, raw 1.089%, official-feed 0.371%).
- analysis/settle_eval.py -> data/derived/settle_eval.npz (7,924 windows; holdout <= Aug 13 12:00 UTC 2,120; variants A C Aq B As Cs).
- analysis/settle_metrics.py -> results/settle_metrics.json + results/settle_disagreements.csv.
  HOLDOUT first-LOCKED: A 3/1879 (0.16%) lead mean 100 s | C 3/1883 | Aq 3/1879 | B gaussian 50/1928 (2.59%) | As (official-feed emulation) 2/2118 | Cs 3/2119.
- NEXT: dev-fold metrics, warnings-with-execution, stress tests, decide 2.7 (BRTI client + settle display + As model when official feed live), build/test/package.

## CP12 — model comparison results (20:3x PT Oct 13)
- results/settle_metrics.json (holdout 2,120 windows Jul 22-Aug 13; dev folds 1-6 3,765 windows Sep 4-Oct 13):
  first-LOCKED lost/locked: A(2.6) holdout 3/1879 dev 13/3484 | C(no recal) 3/1883, 15/3486 | Aq(no active ratio) 3/1879, 8/3480 |
  B gaussian 50/1928, 160/3563 | As(official emul.) 2/2118, 21/3763 | Cs 3/2119, 19/3763.
- results/settle_extra.json: Asr (As recalibrated walk-forward) 2/2118, 19/3763 | AgS (2.6 + official gate) 3/1879, 12/3483 | AnAs 2/1879, 12/3483
  threshold sweep A@0.2% 1/1870, 5/3471 (lead mean 78 s vs 100) | A@1% 5/1885, 40/3512 | As@0.2% 1/2117, 7/3760.
- Q4 calibration (first entry per band, by vol group): raw model overstates active-tape flips 2-5x (dev and holdout); A calibrated on dev; holdout A conservative.
- momentum_diag.json: weak, inconsistent momentum effect; not usable.
- warning_eval.json: W10 (2.6) warned 11/12 dev losers (median bid ~68c CONS, ~64 s left) but 25 false alarms; exit-on-warning ~break-even
  (CONS -$6.6 / VISIBLE +$41 per 10-lot over 7 weeks, holdout negative). Lower thresholds worse. Most reversals are single jumps:
  W1 and W10 fire in the same second. Official model does not warn earlier.
- shock_frequency.json + stress/stress26.json (test/stress_engine.js, real 2.6 code, 960 LOCKED windows x $5..$100 jumps):
  in 437 jump scenarios that flip the settlement, 2.6 never stayed LOCKED; REVERSAL WARNING within 1 s in 436 (1 = proxy basis error).
- Production verified 20:3x PT: btc-pin-radar.onrender.com /health 2.3 build 2.3-2026-09-21 (uptime 10 h); page sha 70a6aabf.. = 2.3.
- DECISION: retain 2.6 probability engine; 2.7 = 2.6 + exact settlement panel + Kalshi BRTI client (official gate AgS when entitled,
  shadow As logging) + per-second prediction log + BRTI-history validation script. No change to LOCKED thresholds by default.

## CP13 — 2.7 built and tested (20:06 PT Oct 13)
- src/brti27.js (settlement arithmetic, BRTI client state, official state checks, settlePanel27, brtiGate27, brtiAfterClassify27,
  predLog27, brtiStatus27) + src/selftest27.js; build/build_server27.py (dist26 sha-checked -> dist27/pinradar_server.js);
  build/build_page27.py (dist26 page sha-checked -> dist27/btc_pin_radar_27.html).
- Tests: selftest 118/118; test/page27_test.js 28/28; test/fuzz27.js 20,000 cases 0 violations (found+fixed: garbage official value
  accepted when injected directly); test/settlement_math_test.js 18/18; test/brti_history_mock_test.js 4/4
  (research27/brti_history_check.js for David's key); test/replay27.js (2.6 vs 2.7, PROXY parity + synthetic OFFICIAL) running -> stress/replay27.json.
- Live (local, no Kalshi creds): live27 :10127 + paper27 -> data/live/paper27_run1.ndjson; live26 :10126 + paper26b -> data/live/paper26_run2.ndjson.
- Mock end-to-end: test/mock_kalshi_ws.js :18765 (RSA-PSS handshake check, documented schema, outage + seq-gap injection) +
  live27m :10128 (KALSHI_WS_URL -> mock, test key stress/mockkey) PRED_LOG_FILE data/live/pred27m_run1.ndjson; mock log data/live/mock_ws_run1.ndjson.
- NEXT: collect live/mock results after 2 closes, package pkg27 (upload/rollback/test/research), report doc update, final answer Q1-Q10.

## CP14 — delivered state (20:4x PT Oct 13)
- Results: results/final27_table.{json,csv}, settle_disagreements_27.csv, official_upside.json, fixed_time_trade.json, stress/replay27.json
  (2,049 contracts, 616,749 s, 0 PROXY mismatches), stress/stress26.json.
- Mock end-to-end (live27m + mock_kalshi_ws): OFFICIAL panel in final minutes, PROXY fallback at 2.9 s stale during the injected
  6 s outage, gaps counted, /brti-status finals reconcile with Kalshi official. Stopped after 2 windows.
- Live paper proxy (no creds): 2.7 and 2.6 identical first LOCKED (T-62, T-69), both correct; loggers still running.
- Report doc updated: https://claude.ai/code/artifact/75f2574b-9bf4-4908-8172-a301f69af5be — new first tab "2.7 settlement investigation"
  (body node f8ebdc96-57a8), old tab renamed "2.6 LOCKED certification audit"; doc renamed.
- Package pkg27/ (README, upload sha bd7cacbb.. server / 804638dd.. page, rollback = live 2.3, test/run_all.sh all pass,
  tools/brti_history_check.js, research/) -> pinradar-2.7.zip.
- Production untouched (2.3). Nothing deployed. No orders.
