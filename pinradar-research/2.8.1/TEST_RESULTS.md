# Pin Radar 2.8.1 — test results (actually run, 2026-10-15T00:37Z)

Command: `bash pinradar-research/2.8.1/test/run_all281.sh` (offline; no network, no orders). Output, verbatim:

```
== build (sha-checked patches of the delivered 2.8 files) into a temp dir; the committed dist must be identical
dist/pinradar_server.js is the build of these sources (631a5b280b0a0721)
dist/btc_pin_radar_281.html is the build of these sources (faea61c58af0d5fe)
== 1. server self-test (default config, and with the new features off)
selftest 144/144 OK (pin-radar-2.8.1)
selftest 144/144 OK (pin-radar-2.8.1)
== 2. late-LOCKED suite on 58 real windows: warm parity, restarts (Oct 14 mechanism), Oct 12 reversal, scenarios
late281: 12/12 passed
== 3. page (jsdom, real 2.8.1 signal objects)
page281: 11/11 passed
== 4. forensic tool on a fixture of the Oct 14 mechanism (2.8 started 330 s before a real window's close)
forensic281: restart found 330s before the close; model supported LOCKED at T-102.75, 2.8 showed it at T-30.75; 2.8.1 on the same inputs at T-57.75 -> PASS
== 5. cold-start volatility band: calibration Jul-Aug, coverage on Sep-Oct
cold-vol band: validation coverage min over m = 100.000% (12 series)
== 6. the 2.8 suites against 2.8.1 with the new features off (COLD_START_ENVELOPE=0 EXEC_SEC=0): must behave as 2.8
core28 tests: 61/61 passed
fuzz27: 20000 cases, OFFICIAL panels 8709, PROXY/NONE 11291, official gate fired 1076, official reversal 9, LOCKED 351, TRADE NOW 65, violations 0
replay parity vs 2.7: contracts 58 evals 17458 proxyMismatches 0 officialStateDiffs 0
adversarial28: 24/24 checks passed
props28: all checks passed
live_sim28: all checks passed
ALL 2.8.1 CHECKS PASSED
exit 0
```

Detail of the late-LOCKED suite (test/late281_test.js):

* **P1 warm parity** 2.8.1 (EXEC_SEC=0) = 2.8 on every second
  `{"seconds": 17400, "differences": 0, "ex": []}`
* **P2 warm, 10 s order time** identical probabilities/states; actions differ only by TOO LATE (<13 s) or the stress test
  `{"seconds": 17400, "probabilityDiffs": 0, "lockedActionToTooLateUnder13s": 533, "tradeNowToStressRefusal": 0, "otherActionDiffs": 0, "ex": []}`
* **R1 Oct 14 mechanism** restart 300 s before the close -> 2.8 never LOCKED; 2.8.1 LOCKED, wrong only where the warm engine is wrong
  `{"2.8": 0, "2.8.1": 50, "wrong281": [], "warmWrong": ["KXBTC15M-26SEP022315-15"]}`
* **R2 restart subset** at every second 2.8.1 shows LOCKED after a restart, the warm validated engine gives that side >= 99.5 %
  `{"2.8.1 lockedSeconds": 26696, "2.8.1 unsupported": 0, "2.8 lockedSeconds": 21858, "2.8 unsupported (for comparison)": 1181, "byConfig": {"boot T-600 basis cold": {"2.8": [57, ["26SEP022315-15", "26OCT122045-45"], 359], "2.8.1": [50, [], 0]}, "boot T-600 basis warm": {"2.8": [55, ["26SEP022315-15", "26OCT122045-45"], 296], "2.8.1": [53, ["26SEP022315-15"], 0]}, "boot T-420 basis cold": {"2.8": [57, ["26SEP022315-15", "26OCT122045-45"], 279], "2.8.1": [50, ["26SEP022315-15"], 0]}, "boot T-420 basis warm": {"2.8": [55, ["26SEP022315-15", "26OCT122045-45"], 181], "2.8.1": [53, ["26SEP022315-15"], 0]}, "boot T-330 basis cold": {"2.8": [56, ["26OCT122045-45"], 61], "2.8.1": [50, [], 0]}, "boot T-`
* **S1 Oct 12 20** 45 ET adverse reversal: 2.8.1 never LOCKED and never TRADE NOW (all restart / basis configurations)
  `{"warm basis known": {"2.8.1": "never LOCKED", "2.8": "never LOCKED"}, "warm basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-17.25"}, "boot T-900 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-17.25"}, "boot T-900 basis known": {"2.8.1": "never LOCKED", "2.8": "never LOCKED"}, "boot T-600 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-22.25"}, "boot T-600 basis known": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-17.25"}, "boot T-420 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-23.25"}, "boot T-420 basis known": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-22.25"}, "boot T-330 basis cold": {"2.8.1": "never LOCKED", "2.8": "LOCKED UP T-23.25"`
* **S2 safely ahead (synthetic 97c book)** TRADE NOW only at >= 13 s, TOO LATE TO TRADE only below
  `{"windows": 26, "tradeNowSeconds": 3212, "tooLateSeconds": 338, "violations": 0}`
* **S3 narrowly ahead (official $1 above the strike)** no TRADE NOW in the last 13 s; LOCKED / TRADE NOW outcomes reported
  `{"windows": 20, "lockedWindows": 4, "lockedWrongSide": 1, "tradeNowSeconds": 1, "tradeNowWrongSide": 1, "tradeNowUnder13s": 0, "note": "a $1 settlement margin is decided by the basis (official minus our index); LOCKED on the wrong side here is the model limit the forward test measures"}`
* **S4 final-second adverse jump** the LOCKED call is dropped / REVERSAL WARNING within 1 s; no TRADE NOW
  `{"windows": 15, "warnedWithin1s": 15, "tradeNowAfterJump": 0}`
* **S5 late data** stale index -> no LOCKED/TRADE NOW (SIT OUT); stale book -> PREDICTED LOCKED, never TRADE NOW
  `{"staleIndexStates": ["DATA UNRELIABLE/SIT OUT"], "staleBookExec": ["SIT OUT", "PREDICTED LOCKED", "TOO LATE TO TRADE"]}`
* S6 LOCKED after the book has no offers on the called side -> TOO LATE TO TRADE
  `["TOO LATE TO TRADE: no DOWN offers left on Kalshi", "TOO LATE TO TRADE: 12.3 s left: an order needs ~10 s to place + 3 s to fill (last moment was T−13 s)"]`
* **S7 valid LOCKED with 9 s left** 10 s order time -> TOO LATE TO TRADE; 3 s order time -> TRADE NOW
  `["TOO LATE TO TRADE", "TRADE NOW", "9.3 s left: an order needs ~10 s to place + 3 s to fill (last moment was T−13 s)"]`
* **S8 after the close** FINAL (never TRADE NOW, never an opportunity)
  `[{"state": "FINAL", "why": "AWAITING SETTLEMENT", "prepare": null, "execSec": 10, "lastOrderTau": 13, "secondsToLastOrder": -14, "note": "TRADE NOW needs LOCKED, a fresh book with enough offers, a positive conservative edge after fees that survives an adverse move during your order time, and at least 13 s left"}, "FINAL"]`
