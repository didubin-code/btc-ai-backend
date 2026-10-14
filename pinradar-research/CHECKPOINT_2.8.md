# Pin Radar 2.8 — working checkpoint (resume file)

Updated: 2026-10-14 (checkpoint 3), round 3 in progress. **Nothing deployed. No orders. Production 2.3 untouched.**
* `btc-ai-backend` `main` is still `c9e0df6`.
* `Btc-signal` `main` is still `f3eb239`.

## Where the code is

| What | Where |
|---|---|
| Round-1 2.8 (reviewed build, dist sha 70a165b9…) | commit `266c3f3` on `claude/btc-pin-radar-research-xpe585` |
| Round-2 + round-3 fixes (this WIP commit) | `pinradar-research/2.8/` on the same branch. The dist is rebuilt by `python3 2.8/build/build_server28.py`. |
| Preserved baselines (never edited) | `pinradar-research/versions/{2.3,2.4,2.6,2.7}` (sha in `versions/VERSIONS.md`) |

## Review status (round 3: independent adversarial review)

The workflow `pinradar28-adversarial-review` (run `wf_cc847d80-36a`) is resumable with `Workflow({scriptPath, resumeFromRunId:'wf_cc847d80-36a'})`. Completed steps replay from cache.

| Step | Status |
|---|---|
| triage-a, triage-b (re-ran the interrupted reviewer's 23 scripts) | done: 18 new candidates F1–F18 |
| find-live-integration | done: LI-1…LI-11 (LI-1 = F9, LI-3 = F2, LI-4 = F7, LI-5 = F6, LI-6 = F11; new: LI-2, LI-7, LI-8, LI-9, LI-10, LI-11) |
| find-claims-vs-evidence | done: CVE-01…CVE-18 (CVE-01 = F1, CVE-02 = F10, CVE-05 = F2/F5, CVE-07 = F12/F17, CVE-14 = F2; new: CVE-03, CVE-04 latency part, CVE-06, CVE-08, CVE-09, CVE-10, CVE-11, CVE-12, CVE-13, CVE-15, CVE-16, CVE-17) |
| find-evidence-chain | dropped (duplicate coverage) |
| verify-1 (F3, F4, F11, F15) | done: all four real; plus NEW-band28-reversal (minor, real) |
| verify-2…verify-6 (re-run) | done: every finding they covered is real (F1, F2, F5–F10, F12–F14, F16–F18, LI-2/7/8/9/10/11, CVE-06/10/11/12/15/17) |
| verify-7 (CVE-03/04/08/09/13/16) | done: all real. **Workflow total: 36/36 confirmed, 0 refuted, + NEW-band28-reversal** |
| fix review of the fixes (separate agent, snapshot `snap_r3a`) | done: R1–R10 found in my fixes, all reproduced and fixed in checkpoint 2 |

## Fixed in this WIP (each has a check in `2.8/test/regress28.js` that FAILS on `266c3f3` and passes here)

| Area | Findings |
|---|---|
| Decisions | D4 = F3 (PROVEN withheld when the official reference disagrees) · D5 = F4/F15 (official reversal numbers) · D6 = F11 (FINAL only at 60/60) |
| Ledger and server | F9/LI-1 (entries are snapshots) · F13 (write retry, file stays a contiguous prefix) · F14 (torn line cut) · F2/F5 (open windows restored, settled after a restart, LOCKED side restored) · F18 (streaming resume) · K4 (monitors from the whole file) |
| Forward report | F1/CVE-01 (segments only at seq 1 from the boot genesis) · F2/CVE-14 (score the committed calls) · F5 (dropped windows counted as unresolved) · F10/CVE-02 (latched alarm) · F12 and F17/CVE-07 (Holm step-down over 5 candidates, F's test) · F16 (DATA UNRELIABLE excluded) · F6/CVE-04 (G5 from the ledger's `calib` commitments) |
| Tape and replay | F6/LI-5 (samples kept for the record span) · F7/LI-4 (fee schedule on the tape) · F8 (boot markers) |
| Live integration | LI-2 (strict fee_multiplier parse) · LI-7/LI-9 (no +EV next to a refused or breaking call) · LI-8 (client latency clamped and rate-limited) · LI-10 (paged `/ledger`, incremental verify) · LI-11 (tape rotation) |
| Round 2 | K1 (config hash covers every env override and the model) · K2 (per-fill fee in the decision) · K3 (shadow MIN_TRADE_ASK guard) · K5 (fractional contracts) · K6 (PROVEN wording) |
| Pre-registration | amended to `pinradar-2.8-prereg-v2` before any forward data (section 7 lists the changes) |

## Test results on this WIP (actually run)

The full suite was run on the round-3 tree (`prcopy`) before the live-integration fixes:

| Check | Result |
|---|---|
| run_all28.sh | ALL PASSED |
| selftest | 134/134 |
| core | 61/61 |
| page | 38/38 |
| fuzz | 0 / 20,000 |
| parity 2.7 | 0 / 17,458 (official state diffs 0) |
| live_sim | pass |
| adversarial | 24/24 |
| settle | 18/18 |
| brti mock | 4/4 |
| regress28 | 22/22 here; 22/22 fail on `266c3f3` |
| soak 24 h | pass |
| live_sim in-memory /tape replay | 0 mismatches here; 3,583 / 4,800 on `266c3f3` |
| 90-day ledger resume (248 MB) | 4.0 s, RSS 313 MB, all 10,575 outcomes rebuilt. Old: 4.7 s, RSS 666 MB, 1,250 rebuilt |

After the live-integration fixes (`prcopy3`) only part of the suite was re-run:
* selftest 134/134
* page 38/38
* regress28 28/28; all 28 fail on `266c3f3`

**The full run_all28 and the soak are still to be repeated on the final tree.**

## Checkpoint 2 additions (all in `regress28.js`: 44 checks; each new check fails on `snap_r3a` or `266c3f3`)

| Item | Fix |
|---|---|
| NEW-band28-reversal | band28 is undefined for flip > 50 %; no band in REVERSAL WARNING |
| CVE-13 | settleMath tie epsilon |
| CVE-09 | AUDIT28: 13/3,484 labelled development, holdout 3/1,879, TRADE NOW CI, no per-regime/per-ask rows |
| CVE-03 | INCOMPLETE without G1 attestation, G5 coverage or G6 data; 90-day cap |
| CVE-06 | G3 = 0.75 % bound at >= 3,000 LOCKED windows (85 % power); FAIL only through the stop rule |
| CVE-04 | hourly latency histograms committed to the ledger |
| CVE-08 | live_sim replays the 2.8 tape through 2.7 `computeLockSnapshot`: 0 differences outside D1. A promote-to-LOCKED mutant now fails (253 differences) |
| CVE-16 | run_all builds into a temp dir and checks the committed dist; the 2.7 page is vendored in `pkg27_page` |
| CVE-12 | `test/props28.js` (brute force 140,000, ties, monotonicity 509,040, recalibration) |
| R1 | file order across segments |
| R2 | tape constant TDZ |
| R3 | value positive only for a LOCKED call nobody refused; WAIT reason names the gate |
| R4 | `/ledger` serves only durable rows; the puller stops on a fork |
| R5 | anchors: one per segment and after the last outcome, else INCOMPLETE; segment time order |
| R6 | config of the window's calls |
| R7 | a complete last row without its newline is kept |
| R8 | invalid latency posts take no token; the client latency is informational, not G6 |
| R9 | fee multiplier only in [0.1, 4] |
| R10 | `CONFIG28` includes officialFeed and streaming |
| Candidates | section 5 verdicts computed (not worse, constraints, Holm, own G3/G4) |

Full run_all28 passed on the tree before R1–R10 (all 9 stages). After R1–R10, these were run: selftest 134/134, regress 44/44, props pass. **A final full run and the soak are still to be done.**

## Checkpoint 3

* Docs updated:
  * PREREGISTRATION v2 (gates and verdict table);
  * README sections 1–6 and 8;
  * REPORT (sections A, C, E, G, H, R3 and J);
  * REGISTER R6, R14, R15, R17, R18 and R23–R28.
* The edge monitor is latched (type-I 1.8 %; failure 2.8 %).
* page28_test is now 41/41; its 3 new checks fail on 266c3f3.
* The soak measures the heap after GC: 18 → 42 MB over 24 h, pass.
* The full run_all28 passed on the tree before the N fixes.
* Second fix review (round 2, snapshot snap_r3b) found N1–N11:
  * N1: G3 not frozen at the end (optional stopping);
  * N2: `--since`, `--config` and the `--latency` fallback can change the verdict;
  * N3: the tail after a segment's last anchor is unverified;
  * N4: the puller identified chains by genesis (false or missed forks);
  * N5: an unwritable LEDGER_FILE hid the ledger;
  * N6: latency histograms hourly (the partial hour was lost at restart);
  * N7: candidate adoption ignores the candidate's stop rule;
  * N8: downtime not measured;
  * N9: anchor the puller's head;
  * N10: README stale (fixed);
  * N11: value vs execution, by design.
* In this commit, N4, N5 and N6 are done in the server, core, routes and puller (`chainId`, memory-only fallback, 5-min + SIGTERM latency flush, puller `--anchors`, exit codes 3/4). N1–N3, N7, N8 (forward_report) and their tests are next.

## Outstanding

1. Re-run verify-2…6 (triage groups 2–4 + finder findings) and the fix review.
2. Fix:
   * NEW-band28-reversal;
   * CVE-03 (no PASS without G1/G5/G6 evidence; 90-day cap);
   * CVE-04 (latency summaries committed to the ledger);
   * CVE-08 (cross-version computeLockSnapshot replay vs 2.7 in run_all);
   * CVE-09 (AUDIT_25 text shown with LOCKED: 13/3,484, "development" label);
   * CVE-13 (settleMath tie epsilon);
   * CVE-16 (run_all must not rewrite tracked files; PAGE27 documented).
3. Correct the report and register for CVE-06, CVE-10, CVE-11, CVE-12, CVE-15 and CVE-17.
4. Final:
   * full run_all28 + soak + regress on the final tree;
   * SHA256SUMS, README, REPORT and REGISTER;
   * package28.sh;
   * push both repos; final report.

## Resume commands

```
cd /home/user/btc-ai-backend && git fetch origin claude/btc-pin-radar-research-xpe585 && git checkout claude/btc-pin-radar-research-xpe585 && git pull
cd pinradar-research && python3 2.8/build/build_server28.py && PAGE27=/home/user/Btc-signal/pinradar-research/versions/2.7/btc_pin_radar_27.html python3 2.8/build/build_page28.py
PAGE27=… bash 2.8/test/run_all28.sh ; node 2.8/test/regress28.js "$(pwd)" ; (cd 2.8 && node test/soak28.js dist/pinradar_server.js 24)
```
