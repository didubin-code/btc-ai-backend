# BTC Pin Radar 2.8.1: restart-aware LOCKED and execution-aware actions

2.8.1 is a patch of 2.8. It fixes the cause of the Oct 14 2026 late LOCKED signal and adds a "what to do now" layer. The full investigation is in `../research28/late_lock/REPORT_LATE_LOCKED.md`.

**Nothing has been deployed.** Your services, `main` and production are untouched by this work.

## What changed

1. **Restart handling (the Oct 14 cause).**
   * In 2.8, every server start (any upload to `main` redeploys the service) withheld LOCKED for 300 s.
   * After that, 2.8 used a 900 s volatility estimate built from as little as 300 s of data, which was never validated.
   * 2.8.1 can show LOCKED once it has 120 s of index history. Until it has 900 s, the call uses the worst probability over every volatility value the short history allows. The lower bound is exact; the upper bound is empirical (100 % coverage on Sep–Oct data).
   * The basis model (official settlement minus our index) restarts empty. Until 12 windows have settled, the call uses the worst probability over basis means of −$7 to +$9.
2. **Order time.**
   * TRADE NOW requires at least 3 s plus your order time before the close. The default order time is 10 s; set it on the page.
   * A LOCKED call that arrives later than that is **TOO LATE TO TRADE**, never TRADE NOW.
3. **Execution stress test.** TRADE NOW also requires the edge after fees to survive a 95 % adverse BTC move (1.645σ) during your order time.
4. **One action line at the top of the page:**

   | Action | Meaning |
   |---|---|
   | **TRADE NOW — BUY YES/NO** | All conditions hold. Shows the last moment to place the order. |
   | **PREDICTED LOCKED — NOT TRADABLE NOW** | The call is LOCKED, but there is no edge (usually the market is already at 99.9¢), the book is thin or stale, or the market disagrees. The reason is shown. |
   | **TOO LATE TO TRADE** | LOCKED, but there is not enough time left for your order, or there are no offers left. |
   | **SIT OUT** | Not LOCKED, data unreliable, or a reversal warning. A yellow **GET READY** note appears when LOCKED is projected within about 20 s if BTC holds. |
   | **WINDOW CLOSED — FINAL / SETTLEMENT** | After the close. Never an opportunity. |

   A dashed amber banner also says when the server restarted recently and what that limits.
5. **New endpoint `/exec`.** For each window it records when LOCKED, TRADE NOW and TOO LATE first appeared. `/health` adds `warmup` and `execution`.

The probability model, the LOCKED threshold (0.5 %) and all 2.8 evidence and forward-test machinery are unchanged.

## Equivalence with 2.8

* **Warm server, `EXEC_SEC=0`:** with at least 900 s of index history and a warm basis model, 2.8.1 makes 2.8's exact decisions on every second. This was tested on 17,400 decision-seconds.
* **Default order time (10 s):** probabilities and states are identical. Actions differ only where a LOCKED call falls inside the last 13 s (it becomes TOO LATE) or fails the stress test.
* **New features off (`COLD_START_ENVELOPE=0 EXEC_SEC=0`):** 2.8.1 makes 2.8's exact decisions everywhere, and the 2.8 test suites pass against it.

## Install (only when you decide to)

Same procedure you used for 2.8. Two files:

1. **Server.** `2.8.1/dist/pinradar_server.js` replaces `pinradar_server.js` on the branch your `btc-pin-radar` Render service deploys from.
2. **Page.** `2.8.1/dist/btc_pin_radar_281.html` replaces `btc_pin_radar.html` in `Btc-signal`.
3. **Upload right after a quarter-hour close**, for example at :00:30, :15:30, :30:30 or :45:30.
   * A deploy restarts the server.
   * 2.8.1 needs 120 s before LOCKED is possible, and 900 s before its volatility is fully pinned down.
   * Its basis model needs about 3 hours (12 settled windows) before it stops using the conservative basis range. It is safe in that period, just less often LOCKED.
   * Uploading in the last 5 minutes of a window you want to trade is what happened on Oct 14.
4. **Environment variables:** none required. Optional:

   | Variable | Default | Meaning |
   |---|---|---|
   | `EXEC_SEC` | 10 | Default order time, used by the background classifier and ledger. The page's own setting is used for what you see. |
   | `EXEC_STRESS_Z` | 1.645 | Size of the adverse move in the stress test. 0 turns the test off. |
   | `COLD_START_ENVELOPE` | 1 | 0 restores the 2.8 restart behaviour. |
   | `COLD_MIN_SEC` | 120 | Index history needed before LOCKED is possible. |
   | `BASIS_WARM_N` | 12 | Settled windows before the basis model counts as warm. |
   | `BASIS_COLD_LO` / `BASIS_COLD_HI` | −7 / 9 | Basis-mean range (dollars) used while it is cold. |

5. **Check after deploy:**
   * `/health` shows `pin-radar-2.8.1` and `warmup.lockedAvailable`.
   * `/selftest` shows 144/144.
   * The page shows the action line.
6. **Rollback:** re-upload `2.8/dist/pinradar_server.js` and `2.8/dist/btc_pin_radar_28.html` (2.8), or `versions/2.3/` (2.3).

The forward test of 2.8 (pre-registration v2) is tied to the 2.8 config hash. 2.8.1 has a new hash and pre-registration id `pinradar-2.8.1-prereg-v3`; see `PREREG_AMENDMENT_v3.md`. Its forward test starts at its own first boot.

## Reproduce

```
cd btc-ai-backend && git checkout claude/btc-pin-radar-research-xpe585
bash pinradar-research/2.8.1/test/run_all281.sh
```

## Forensics for a window you saved logs for

```
node pinradar-research/2.8.1/tools/forensic281.js --ticker KXBTC15M-26OCT141930-30 \
  --tape tape.ndjson --pred predictions.json --signals signals.json --health health.json --health-at 2026-10-15T00:10:00Z
```

| Source | Endpoint |
|---|---|
| tape | `/tape?format=ndjson` |
| predictions | `/predictions?ticker=...` |
| signals | `/signals?n=5000` |
| health | `/health`, with the time you saved it |

The tool reports, from those files only:

* the process start time;
* the first HIGH CONFIDENCE, the first second the model supported LOCKED, and the first LOCKED shown;
* the 60/45/30/20/15/10/5 s table, with the Kalshi ask and size;
* the last second with offers on the leading side;
* what the page was sent, with the gate texts;
* a cause classification;
* the same inputs replayed through 2.8.1.
