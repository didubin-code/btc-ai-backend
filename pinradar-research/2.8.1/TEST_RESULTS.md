# Pin Radar 2.8.1 — test results (actually run, 2026-10-16T02:31Z)

Command: `bash pinradar-research/2.8.1/test/run_all281.sh` (offline; no network, no orders). Output, verbatim:

```
== build (sha-checked patches of the delivered 2.8 files) into a temp dir; the committed dist must be identical
dist/pinradar_server.js is the build of these sources (95367709cca2172c)
dist/btc_pin_radar_281.html is the build of these sources (900509eb07de1d15)
== 1. server self-test (default config, and with the new features off)
selftest 149/149 OK (pin-radar-2.8.1)
selftest 149/149 OK (pin-radar-2.8.1)
== 2. late-LOCKED suite on 58 real windows: warm parity, restarts (Oct 14 mechanism), Oct 12 reversal, scenarios
late281: 15/15 passed
== 2b. DATA UNRELIABLE: sampler phase, real gaps, aligned sampler on real timers, one lagging venue, /dq diagnostics
dq281: 6/6 passed
== 3. page (jsdom, real 2.8.1 signal objects)
page281: 17/17 passed
== 4. forensic tool on a fixture of the Oct 14 mechanism (2.8 started 330 s before a real window's close)
forensic281: restart found 330s before the close; model supported LOCKED at T-102.75, 2.8 showed it at T-30.75; 2.8.1 on the same inputs at T-56.75 -> PASS
== 5. cold-start volatility band: calibration Jul-Aug, coverage on Sep-Oct
cold-vol band: validation coverage min over m = 100.000% (12 series)
== 6. the 2.8 suites against 2.8.1 with the new features off (COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0): must behave as 2.8
core28 tests: 61/61 passed
fuzz27: 20000 cases, OFFICIAL panels 8709, PROXY/NONE 11291, official gate fired 1076, official reversal 9, LOCKED 351, TRADE NOW 65, violations 0
replay parity vs 2.7: contracts 58 evals 17458 proxyMismatches 0 officialStateDiffs 0
adversarial28: 24/24 checks passed
props28: all checks passed
live_sim28: all checks passed
ALL 2.8.1 CHECKS PASSED
exit 0
```

Detail of the late-LOCKED suite (`test/late281_test.js` on the same build, server sha256 95367709cca2172c…, run separately so its JSON could be kept). LAST = 3 s fill + 12 s default order time = 15 s:

* **P1 warm parity**: 2.8.1 (EXEC_SEC=0) = 2.8 on every second
  `{"seconds": 17400, "differences": 0, "ex": []}`
* **P2 warm, default order time**: identical probabilities/states; actions differ only by TOO LATE (< LAST) or the stress test, and the stress test does refuse some
  `{"seconds": 17400, "probabilityDiffs": 0, "lockedActionToTooLateUnderLast": 637, "tradeNowToStressRefusal": 76, "otherActionDiffs": 0, "ex": []}`
* **R1 Oct 14 mechanism**: restart 300 s before the close -> 2.8 never LOCKED; 2.8.1 LOCKED, wrong only where the warm engine is wrong
  `{"2.8": 0, "2.8.1": 50, "wrong281": [], "warmWrong": ["KXBTC15M-26SEP022315-15"]}`
* **reported**
  `{"R2 held-out windows (not used to calibrate the volatility band)": {"windows": 12, "note": "per-window detail in restartDetail; the basis band [-7, 9] was set from the range of these same 58 walk-forward means, so the basis half of R2 cannot fail on this data set"}, "S1 the warm engine with a KNOWN basis on Oct 12 (a model limit 2.8.1 does not change)": {"input age ~0.7 s": {"firstLocked": "never LOCKED", "firstTradeNow": "never TRADE NOW", "truth": "DOWN"}, "input age 50 ms": {"firstLocked": "LOCKED UP T-17.25", "firstTradeNow": "never TRADE NOW", "truth": "DOWN"}}, "S3 narrowly ahead (offic …`
* **R2 restart subset**: at every second 2.8.1 shows LOCKED after a restart, the warm validated engine gives that side >= 99.5 %
  `{"2.8.1 lockedSeconds": 26368, "2.8.1 unsupported": 0, "2.8 lockedSeconds": 21858, "2.8 unsupported (for comparison)": 1181, "byConfig": {"boot T-600 basis cold": {"2.8": [57, ["26SEP022315-15", "26OCT122045-45"], 359], "2.8.1": [50, [], 0]}, "boot T-600 basis warm": {"2.8": [55, ["26SEP022315-15", "26OCT122045-45"], 296], "2.8.1": [53, [], 0]}, "boot T-420 basis cold": {"2.8": [57, ["26SEP022315-15", "26OCT122045-45"], 279], "2.8.1": [50, [], 0]}, "boot T-420 basis warm": {"2.8": [55, ["26SEP022315-15", "26OCT122045-45"], 181], "2.8.1": [53, [], 0]}, "boot T-330 basis cold": {"2.8": [56, ["26 …`
* **R3 pin cases, cold basis**: no LOCKED on the side opposite to the base leader; wrong first LOCKED <= basis-known engine
  `{"combos": 348, "lockedCold": 7, "wrongCold": 3, "lockedKnown": 53, "wrongKnown": 13, "oppositeSideLockedSeconds": 0, "ex": []}`
* **R4 bracket robustness**: no LOCKED second after a restart has a sigma_900 inside the bracket with flip > 0.5 %
  `{"checked": 1987, "notRobust": 0, "maxWorstOverShownRatio": 486140.821, "ex": []}`
* **S1 Oct 12 20:45 ET adverse reversal**: with a cold basis 2.8.1 never LOCKED / TRADE NOW; with a known basis no LOCKED the warm engine does not show (both input ages)
  `{"input age ~0.7 s": {"warm basis known": {"2.8.1": "never LOCKED", "2.8": "never LOCKED", "lockedNotInWarmEngine": 0}, "warm basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-17.25", "lockedNotInWarmEngine": 0}, "boot T-900 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-17.25", "lockedNotInWarmEngine": 0}, "boot T-900 basis known": {"2.8.1": "never LOCKED", "2.8": "never LOCKED", "lockedNotInWarmEngine": 0}, "boot T-600 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-22.25", "lockedNotInWarmEngine": 0}, "boot T-600 basis known": {"2.8.1": "never LOCKED", "2.8": …`
* **S2 safely ahead (synthetic 97c book)**: TRADE NOW only at >= LAST s, TOO LATE TO TRADE only below
  `{"windows": 26, "tradeNowSeconds": 3130, "tooLateSeconds": 390, "violations": 0}`
* **S4 final-second adverse jump**: the LOCKED call is dropped / REVERSAL WARNING within 1 s; no TRADE NOW
  `{"windows": 15, "warnedWithin1s": 15, "tradeNowAfterJump": 0}`
* **S4b adverse jump at T-35**: TRADE NOW existed just before; none in the jump second or after
  `{"windows": 15, "hadTradeBefore": 15, "tradeNowAtOrAfterJump": 0}`
* **S5 late data**: stale index -> no LOCKED/TRADE NOW (SIT OUT); stale book -> PREDICTED LOCKED, never TRADE NOW
  `{"staleIndexStates": ["DATA UNRELIABLE/SIT OUT"], "staleBookExec": ["SIT OUT", "PREDICTED LOCKED", "TOO LATE TO TRADE"]}`
* **S6 LOCKED with no offers on the called side**: PREDICTED LOCKED (NO OFFERS) while time remains; TOO LATE TO TRADE only past the last order moment
  `["PREDICTED LOCKED: NO OFFERS — no DOWN offers on Kalshi: nobody is selling DOWN below 100¢ (the market alread", "TOO LATE TO TRADE: 14.3 s left: an order needs ~12 s to place + 3 s to fill (last moment was T−15 s)", "TOO LATE TO TRADE: 13.3 s left: an order needs ~12 s to place + 3 s to fill (last moment was T−15 s)"]`
* **S7 valid LOCKED with 9 s left**: 10 s order time -> TOO LATE TO TRADE; 3 s order time -> TRADE NOW
  `["TOO LATE TO TRADE", "TRADE NOW", "9.3 s left: an order needs ~10 s to place + 3 s to fill (last moment was T−13 s)"]`
* **S8 after the close**: FINAL (never TRADE NOW, never an opportunity)
  `[{"headline": "TOO LATE", "reversalPct": null, "reason": "window closed: AWAITING SETTLEMENT", "state": "FINAL", "why": "AWAITING SETTLEMENT", "prepare": null, "execSec": 10, "lastOrderTau": 13, "secondsToLastOrder": -14, "edge": null, "noOffers": false, "note": "TRADE NOW needs LOCKED, a fresh book with enough offers, a positive conservative edge after fees that survives an adverse move during your order time, and at least 13 s left"}, "FINAL"]`
* **S9 Oct 15 replica**: 99.8c ask -> PREDICTED LOCKED (NO EDGE, qualifying price shown), empty book -> NO OFFERS, < LAST -> TOO LATE, never TRADE NOW; a 97c ask -> TRADE NOW at >= LAST s
  `{"window": "KXBTC15M-26JUL212215-15", "firstLockedTau": 65.25, "noEdgeSeconds": 31, "exampleWhy": "NO EDGE — Kalshi already prices UP at 99.8¢ (≈99.8% sure) vs the model's 99.51%: buying at 99.8¢ + 0.1¢ fee has expected value -0.39¢ (cautious -1.07¢) per contract. It would qualify only at ≤ 97.1¢.", "maxAskForTradeNow": 97.1, "noOffersSeconds": 19, "tooLateSeconds": 15, "tradeNowSecondsAt97c": 32}`

Per-configuration restart detail (R2), 2.8 vs 2.8.1: [locked windows, wrong windows, locked seconds the warm engine does not support]:

* boot T-600 basis cold: 2.8 [57, ['26SEP022315-15', '26OCT122045-45'], 359 of 5157 s]; 2.8.1 [50, none, 0 of 2651 s]
* boot T-600 basis warm: 2.8 [55, ['26SEP022315-15', '26OCT122045-45'], 296 of 5132 s]; 2.8.1 [53, none, 0 of 3013 s]
* boot T-420 basis cold: 2.8 [57, ['26SEP022315-15', '26OCT122045-45'], 279 of 4257 s]; 2.8.1 [50, none, 0 of 2577 s]
* boot T-420 basis warm: 2.8 [55, ['26SEP022315-15', '26OCT122045-45'], 181 of 4146 s]; 2.8.1 [53, none, 0 of 2941 s]
* boot T-330 basis cold: 2.8 [56, ['26OCT122045-45'], 61 of 1611 s]; 2.8.1 [50, none, 0 of 2517 s]
* boot T-330 basis warm: 2.8 [54, ['26OCT122045-45'], 5 of 1555 s]; 2.8.1 [53, none, 0 of 2871 s]
* boot T-300 basis cold: 2.8 [0, none, 0 of 0 s]; 2.8.1 [50, none, 0 of 2493 s]
* boot T-300 basis warm: 2.8 [0, none, 0 of 0 s]; 2.8.1 [53, none, 0 of 2829 s]
* boot T-180 basis cold: 2.8 [0, none, 0 of 0 s]; 2.8.1 [50, none, 0 of 2119 s]
* boot T-180 basis warm: 2.8 [0, none, 0 of 0 s]; 2.8.1 [53, none, 0 of 2357 s]
