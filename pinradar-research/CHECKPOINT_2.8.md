# Pin Radar 2.8 — working checkpoint (resume file)

Updated: 2026-10-14, **round 3 complete**. **Nothing deployed. No orders. Production 2.3 untouched.**
* `btc-ai-backend` `main` is still `c9e0df6`.
* `Btc-signal` `main` is still `f3eb239`.

## Where the code is

| What | Where |
|---|---|
| 2.8 final candidate | branch `claude/btc-pin-radar-research-xpe585` of both repos. Rebuild: `python3 2.8/build/build_server28.py` and `build_page28.py`; run_all checks that the committed `dist` is byte-identical to the build. |
| Server dist | `2.8/dist/pinradar_server.js` (sha in `2.8/SHA256SUMS.txt`) |
| Page | `2.8/dist/btc_pin_radar_28.html`; also `Btc-signal: pinradar-research/2.8/btc_pin_radar_28.html` |
| Preserved baselines (never edited) | `pinradar-research/versions/{2.3,2.4,2.6,2.7}`; 2.7 page in `pinradar-research/pkg27_page` |

## Round 3: independent adversarial review (complete)

Workflow `pinradar28-adversarial-review`, run `wf_cc847d80-36a`; the session resumed it twice after usage limits.

| Step | Result |
|---|---|
| Triage | 2 agents re-ran an interrupted reviewer's 23 scripts: F1–F18 |
| Finders | live integration (LI-1…11) and claims vs evidence (CVE-01…18); 11 restated triage items |
| Verification | 7 independent agents: **36/36 confirmed real, 0 refuted**, plus NEW-band28-reversal |
| Fix review, round 1 | R1–R10 found in my fixes: all reproduced and fixed |
| Fix review, round 2 | N1–N10 found: all fixed; N11 by design (value vs execution) |

Every fix has a check in `2.8/test/regress28.js` (54 checks). Each fails on the build that had the defect and passes here.

## Final test results (actually run on the final tree)

| Check | Result |
|---|---|
| `run_all28.sh` | ALL PASSED |
| build reproducible | dist identical |
| selftest | 134/134 |
| core | 61/61 |
| page | 41/41 |
| fuzz | 0 / 20,000 |
| replay parity | 0 / 17,458 |
| live_sim | LIVE = REPLAY; 2.8 = 2.7 on 4,800 decisions except 7 D1 seconds |
| adversarial | 24/24 |
| settle | 18/18 |
| BRTI mock | 4/4 |
| props | 140,000 + 1,611 ties + 509,040 + 10,005 evaluations, 0 violations |
| regress | 54/54 |
| soak 24 h (`--expose-gc`) | pass; heap 18 → 42 MB; per-tick p99 about 0.9–1.3 ms |

## Outstanding (needs the user or the network)

* Deployment is the user's decision. README section 3 covers a side-by-side Render service and a disk, which is a cost decision.
* Not verifiable here:
  * the official BRTI path with real messages (entitlement);
  * Kalshi fee rounding;
  * any data after Oct 13.
* The forward test itself: pre-registration v2, at least 21 days and 3,000 LOCKED windows.

## Resume / reproduce

```
cd btc-ai-backend && git checkout claude/btc-pin-radar-research-xpe585 && git pull
bash pinradar-research/2.8/test/run_all28.sh
(cd pinradar-research/2.8 && node --expose-gc test/soak28.js dist/pinradar_server.js 24)
```

## Late-LOCKED investigation (started 2026-10-14 23:36 UTC) — resume notes

* Trigger: user report, Oct 14 KXBTC15M-26OCT141930-30 (close 23:30 UTC): LOCKED shown only after the opportunity was gone.
* FOUND: the user uploaded the 2.8 dist to `main` of both repos themselves: btc-ai-backend 2b0d593 (23:22:46 UTC, sha 0efd86c9 = our 2.8 dist),
  Btc-signal 4426774 (23:23:42 UTC, page sha cf9fce39 = our 2.8 page). So production = 2.8, restarted ~23:24-23:27 UTC, inside the incident window.
* Mechanism (code): sigma = rms(120 s, 900 s); ringRmsVol(900) needs >= 300 samples -> soft gate 'volatility estimate warming up' withholds
  LOCKED for 300 s after every restart; no ring persistence (saveState stores basis+ledger only, and only with a state file).
  Basis model also restarts at prior mean 0 (BASIS_MEAN_USD) -> walk-forward mu (median +4.5 in the sample) lost for hours.
* Real-code experiment (research28/late_lock/restart_experiment.js, 58 real windows): boot <= T-300 -> 0 LOCKED in all windows;
  boot T-330 -> LOCKED only at T-29; warm validated setup 54 LOCKED / 1 wrong; mu=0 (fresh basis) 57 / 2 wrong (Oct 12 20:45 ET LOCKED UP wrongly at T-17).
* Asked the user to save /health, /tape?format=ndjson (ring of 10 windows x 300 s, rolls out ~02:00 UTC), /predictions?ticker=..., /signals, /ledger, /latency.
* Plan: 2.8.1 candidate in pinradar-research/2.8.1 (built from the 2.8 dist, sha-checked): cold-start sigma envelope (exact lower bound sqrt(m/900),
  empirical upper), cold-basis mu envelope [-7, 9] until 12 live samples, execution layer (order time, TOO LATE TO TRADE, PREDICTED LOCKED,
  FINAL/SETTLED, SIT OUT, stress test), warm-up status; page action banner + order-time input; forensic tool for the user's logs.
