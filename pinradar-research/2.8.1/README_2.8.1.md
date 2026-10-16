# BTC Pin Radar 2.8.1: restart-aware LOCKED, reliable data checks, and one action line

2.8.1 is a patch of 2.8. It addresses:
* the late LOCKED signals of Oct 14 and Oct 15;
* the intermittent DATA UNRELIABLE warning;
* the request for a single "what to do now" line.

The full investigation is in `../research28/late_lock/REPORT_LATE_LOCKED.md`.

**Nothing has been deployed.** Your three Render services, `main` and production 2.3 are untouched by this work.

**What 2.8.1 does not do: it does not establish a trading edge.** The development trade record is +0.86 ¢ per contract, with a 95 % CI of −0.21 to +1.92 ¢. Only the forward test can settle that.

## What changed

1. **Intermittent DATA UNRELIABLE: a demonstrated defect, fixed.**
   * **The cause.** In 2.8 the 1 Hz index sampler drifts (`setInterval`). When its phase passes about half a second, two samples round to the same settlement second. The next second then looks unrecorded, and the "only k/n locked prints sampled" gate fires. That made up to 94 % of final-minute decisions DATA UNRELIABLE in the affected windows.
   * **The fix:**
     * every settlement print takes its nearest sample;
     * the sampler is aligned to the second plus 100 ms, re-aligned on every tick, and takes exactly one sample per second. A second review found that an earlier 2.8.1 build sometimes sampled the same second twice, which made volatility read low; that is fixed and tested on real timers under load.
   * **A real data gap still triggers the warning.**
   * **One lagging venue still triggers it, as in 2.8.** A change that rebuilt the index without that venue was withdrawn after review: it let a frozen venue keep feeding the settlement prints while the warning was suppressed.
   * **New endpoint `/dq`.** It counts every hard-gate reason with the venue state at that moment. `/health` shows the same counts.
2. **Restart handling (the Oct 14 mechanism).**
   * In 2.8, every server start (any upload to `main` redeploys the service) withheld LOCKED for 300 s.
   * After that, 2.8 used a 900 s volatility estimate built from as little as 300 s of data, which was never validated.
   * 2.8.1 can show LOCKED once it has 120 s of index history. Until it has 900 s, the call uses the worst probability over every volatility value the short history allows. The lower bound is exact; the upper bound is empirical (100 % coverage on Sep–Oct data).
   * If the leading side itself depends on that unknown, there is no call.
   * The basis model (official settlement minus our index) restarts empty. Until 12 windows have settled, the call uses the worst probability over basis means of −$7 to +$9.
3. **15 s execution buffer.** TRADE NOW requires at least 3 s fill time plus your order time (default 12 s) before the close. A LOCKED call that arrives later than that is **TOO LATE**, never TRADE NOW.
4. **Execution stress test.** TRADE NOW also requires the cautious value after fees to stay ≥ 0 in this case: BTC has already moved against the call by 1.645σ of your order time, and the whole remaining time is still random.
   * After a restart it takes the worst case over the whole volatility / basis envelope, like the call itself.
   * This is a conservative choice. It refused 3.3 % of TRADE NOW seconds on a synthetic book; its cost in real trades cannot be measured without historical books.
   * `EXEC_STRESS_Z=0` turns it off.
5. **One action line at the top of the page:** **TRADE NOW — BUY YES/NO**, **SIT OUT** or **TOO LATE**, followed by the reversal risk (%) and one reason.

   | Situation | What the line says |
   |---|---|
   | All conditions hold | TRADE NOW — BUY YES (UP) at ≤ 97¢: +1.2¢ per contract after fees (cautious) |
   | LOCKED, but the market is already at the model's confidence | SIT OUT — LOCKED UP, but no edge at 99.8¢ (worth it only at ≤ 97.1¢); the price includes the fee at that price and the stress test, and is never below 90¢ (below that the server treats a cheap leader as the market disagreeing and never says TRADE NOW) |
   | LOCKED, but nobody is selling the called side | SIT OUT — LOCKED UP, but nobody is selling UP: the market treats it as decided |
   | LOCKED, but less than 15 s left | TOO LATE — LOCKED UP with 9 s left: an order needs 15 s |
   | Not LOCKED, data unreliable, or a reversal warning | SIT OUT with the reason |

   * The outcome headline (PREDICTED LOCKED — UP) is unchanged and stays separate from the trade line.
   * A yellow **GET READY** note appears only when LOCKED is projected within about 20 s, no other gate blocks it, and there would still be time to trade.
   * A dashed amber banner says when the server restarted recently and what that limits.
   * If the backend goes stale or the window closes, the line drops to STALE or WINDOW CLOSED.
   * TRADE NOW turns into TOO LATE at the last order moment, and into STALE when the reading may be more than 1.5 s old. Both are judged conservatively: a reading's age counts from when the page requested it, so a slow connection never shows an old TRADE NOW as current. The trade box, the card and the alert sound follow the action line.
   * The page layout is otherwise the 2.8 layout.
6. **New endpoint `/exec`.** For each window it records when LOCKED, TRADE NOW and TOO LATE first appeared. `/health` adds `warmup`, `execution` and `dataQuality`.

**Unchanged:** the probability model, the LOCKED threshold (0.5 %), and all 2.8 evidence and forward-test machinery.

**Proposed but not adopted** (evidence in report section 5):
* A 0.2 % threshold would have prevented about two thirds of the losing LOCKED calls: development 13 → 5, holdout 3 → 1. It would also have cut TRADE NOW profit by about half. The shadow policy C1 keeps measuring it in the forward test.
* A momentum veto would have prevented none of the 15 losses.

**Not fixed: a model limit.** Oct 12 20:45 ET reversed after the model's LOCKED UP at about T−17. 2.8.1 avoids that call only while its basis model is cold, i.e. for about 3 h after a restart. With a known basis, it makes the same call as 2.8.

## Equivalence with 2.8

* **Warm server, `EXEC_SEC=0`:** with at least 900 s of index history and a warm basis model, 2.8.1 makes 2.8's exact decisions on every second. This was tested on 17,400 decision-seconds.
* **Default order time (12 s):** probabilities and states are identical. Actions differ only where a LOCKED call falls inside the last 15 s (it becomes TOO LATE) or fails the stress test.
* **The sampler fix** changes the sampling times (once per second at +100 ms instead of a drifting interval) and which sample is matched to which settlement print. A matched sample can come from a neighbouring phase.
* **New features off (`COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0`):** 2.8.1 makes 2.8's exact decisions everywhere, and the 2.8 test suites pass against it.

## Install (only when you decide to)

Same procedure you used for 2.8.

1. **Server.** `2.8.1/dist/pinradar_server.js` replaces `pinradar_server.js` on the branch your `btc-pin-radar` Render service deploys from.
2. **Page.** `2.8.1/dist/btc_pin_radar_281.html` replaces `btc_pin_radar.html` in `Btc-signal`. The same file is in `Btc-signal`, branch `claude/btc-pin-radar-research-xpe585`, folder `pinradar-research/2.8.1/`.
3. **Upload right after a quarter-hour close**, for example at :00:30, :15:30, :30:30 or :45:30.
   * A deploy restarts the server.
   * 2.8.1 needs 120 s before LOCKED is possible, and 900 s before its volatility is fully pinned down.
   * Its basis model needs about 3 hours (12 settled windows) before it stops using the conservative basis range. It is safe in that period, just less often LOCKED.
   * Uploading in the last 5 minutes of a window you want to trade is the Oct 14 mechanism.
4. **Environment variables:** none required. Optional:

   | Variable | Default | Meaning |
   |---|---|---|
   | `EXEC_SEC` | 12 | Default order time (buffer = 3 s + this), used by the background classifier and ledger. The page's own order-time box is used for what you see. |
   | `EXEC_STRESS_Z` | 1.645 | Size of the adverse move in the stress test. 0 turns the test off. |
   | `DQ_FIXES` | 1 | 0 restores the 2.8 sampler and venue handling. |
   | `SAMPLE_PHASE_MS` | 100 | Sampler offset within the second. |
   | `COLD_START_ENVELOPE` | 1 | 0 restores the 2.8 restart behaviour. |
   | `COLD_MIN_SEC` | 120 | Index history needed before LOCKED is possible. |
   | `BASIS_WARM_N` | 12 | Settled windows before the basis model counts as warm. |
   | `BASIS_COLD_LO` / `BASIS_COLD_HI` | −7 / 9 | Basis-mean range (dollars) used while it is cold. |
   | `ADAPTIVE_BASIS` | 0 | **Candidate, off by default.** 1 scales the model's basis spread by the error the server measures on its own index (never below the trained level). In the real-contract replay it cut wrong first-LOCKED calls by about a quarter, mostly in the last 15 s, for about 1.5 % fewer LOCKED calls. Exploratory: it was designed after the calibration result it fixes. See `validation/VALIDATION_REPORT.md`. |
   | `MARKET_VETO_CENTS` | 0 | **Candidate, off by default.** For example 90: a LOCKED call is shown as HIGH CONFIDENCE while Kalshi offers the called side below that price, i.e. while the market strongly disagrees. In the real data, first LOCKED calls whose side last traded below 90 ¢ were wrong about 10 % of the time, against 0.1–0.4 % otherwise. |

5. **Check after deploy:**
   * `/health` shows `pin-radar-2.8.1` and `warmup.lockedAvailable`.
   * `/selftest` shows 149/149.
   * `/dq` shows how often, and why, data was unreliable.
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
