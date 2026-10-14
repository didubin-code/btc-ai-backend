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
