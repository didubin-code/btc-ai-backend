# Late LOCKED signals: investigation of the Oct 14 2026 4:30 pm PT window, and the 2.8.1 fix

Written 2026-10-15. **Nothing was deployed. No order was placed. The Render services and `main` were not touched by this work.**

## How to read this report

Every number below comes from one of four sources, named next to it:

* **[CODE]** — reading the 2.8 source you deployed. It is byte-identical to our 2.8 build: sha256 `0efd86c9…` (server) and `cf9fce39…` (page).
* **[SIM]** — the unmodified 2.8 or 2.8.1 server code, driven on a fake clock with **real** 1 Hz BTC index paths. There are 58 KXBTC15M windows, Jul 21 – Oct 13 2026, with their official settlement values. Any Kalshi order book used here is synthetic and is labelled so.
* **[HIST]** — results of the earlier research on 2,120 holdout and 3,765 development windows.
  * They used real Kalshi trade tapes.
  * Those raw files are not in this environment; only their result files are (`pkg27/research/results`).
* **[OCT14]** — your server's logs of the incident window. **None are available yet.**
  * Network access to Kalshi, Coinbase and Kraken is blocked here.
  * Nothing for that window is invented below.
  * `2.8.1/tools/forensic281.js` produces the exact reconstruction as soon as you upload the saved `/tape`, `/predictions`, `/signals` and `/health` files.

## 1. What happened on Oct 14 (root cause)

| Time (UTC) | Event | Source |
|---|---|---|
| 23:15:00 | Window `KXBTC15M-26OCT141930-30` opens; it closes at 23:30:00 (4:30 pm PT). | |
| 23:22:30 | `pinradar_server.js` deleted from `btc-ai-backend` `main`. | git `fa50b0e` |
| 23:22:46 | 2.8 server uploaded. | git `2b0d593`, sha `0efd86c9…` = our 2.8 build |
| 23:23:42 | 2.8 page uploaded as `btc_pin_radar.html`. | git `4426774`, sha `cf9fce39…` = our 2.8 page |
| about 23:24–23:27 | Render rebuilds and starts the new process, inside the window. | estimate; `/health` `uptimeSec` gives the exact time |
| 23:30:00 | Close. | |

What a fresh 2.8 process does **[CODE]**:

* Volatility is `rms(σ120, σ900)`. `ringRmsVol(900)` needs at least 300 one-second samples.
* For the first 300 s after any start, the soft gate *"volatility estimate warming up (needs ~5 min of index history after a restart)"* withholds LOCKED. The page shows HIGH CONFIDENCE / WAIT instead.
* The index history is not saved across restarts (`saveState` keeps only the basis model and the ledger, and only with a state file).
* A process that started 300 s or less before the close therefore **cannot show LOCKED in that window at all**. One that started 330 s before can show it only from T−30.

The same mechanism, measured on real windows **[SIM]**:

* **Restart 300 s or less before the close:** 2.8 shows LOCKED in **0 of 58** windows. A server already running shows it in 54 of 58, with a median of 78 s before the close.
* **Restart 330 s before the close:** 2.8 shows its first LOCKED at **T−29** in every window that locks (P10 = median = P90 = 29 s).
* **Restart 360–420 s before the close:** 2.8 delays LOCKED by 40–60 s on average.

**Classification: software/deployment defect (restart warm-up), not a mathematical limit.** The model itself typically supports LOCKED well before the close. In the fixture of this mechanism, the model supported LOCKED at T−103 while the gate held it back until T−31.

To confirm Oct 14 specifically, read `/health` `uptimeSec`, or Render's deploy log. A start at about 23:25:00 or later means no LOCKED was possible before the close. A start between 23:24:30 and 23:25:00 means LOCKED only in the last 30 s.

Two more restart defects found **[CODE + SIM]**:

* **(a) Unvalidated volatility for 15 minutes after a start.** From 300 s to 900 s after a start, 2.8 treats the volatility as warm but builds the "900 s" estimate from 300–899 s of data. That estimate was never validated.
  * Restarted 600–900 s before the close, 2.8 LOCKED 57 windows with **2 wrong**; the warm engine LOCKs 54 with 1 wrong.
  * The extra wrong call is the Oct 12 20:45 ET reversal: LOCKED UP at T−17 to T−22.
* **(b) Basis model resets to $0.** Every restart puts the basis model (official settlement minus our index) at its prior mean of $0. The walk-forward mean is typically about +$4.5 (range −$6 to +$8 in the sample).
  * With the basis at $0, even a warm 2.8 LOCKs the Oct 12 window UP at T−17, which is wrong.
  * After the deploy, your live 2.8 is running in this state until about a dozen windows have settled.

## 2. Why LOCKED is "late" even without a restart

| | Value | Source |
|---|---|---|
| Lead before the close, first LOCKED | mean 100 s, median 77 s | [HIST] holdout; dev 100.5 / 77 |
| P10 of that lead | between 20 and 30 s | [HIST] 89.7 % of holdout LOCKED windows are LOCKED by T−30, 96.3 % by T−20 |
| P10 / median / P90 | 36 / 78 / 184 s | [SIM] 58 windows, warm |
| First LOCKED in the last 60 s | 36.5 % holdout (686 of 1,879), 36.7 % dev (1,277 of 3,484) | [HIST] |
| First LOCKED after T−15 (too late for a 10 s order) | about 1.9 % holdout (35), 3.2 % dev (110) | [HIST] fixed-time counts |
| Spearman correlation of first-LOCK τ with the official margin, volatility, basis | **0.85**, 0.20, 0.07 | [SIM] |
| Median first LOCKED by official margin | $0–20: T−46 s · $20–50: T−53 s · $50–100: T−84 s · > $100: T−151 s | [SIM] |
| Kalshi ask for the leader when LOCKED (T−60 … T−3) | **median 99.9 ¢**; ask ≤ 99 ¢ in only 0.5–4 % of LOCKED windows | [HIST] |
| Market at 99 ¢ before the model's LOCKED | 85 % of windows | [HIST] Oct 13 research, CP7 |
| LOCKED windows with an executable +EV trade (TRADE NOW, cautious fills) | **1.7 %** holdout (32 / 1,879), **7.5 %** dev (261 / 3,484); visible fills 2.3 % / 9.6 % | [HIST] |
| Median τ of those TRADE NOWs | 57.5 s holdout, 76 s dev | [HIST] |
| Accuracy of those actionable LOCKED calls | holdout 32 / 32; dev 259 / 261 (2 lost, 0.77 %) | [HIST] |

* **Why "~100 s average lead" and "LOCKED came too late" are both true.**
  * The 100 s is lead before the **close**.
  * The binding constraint is the **market**. In 85 % of windows Kalshi prices the leader at 99 ¢ or more before the model reaches 99.5 %.
  * A LOCKED call then has nothing left to buy. 2.8 says "LOCKED — DO NOT TRADE", which reads like a missed signal; 2.8.1 says **PREDICTED LOCKED — NOT TRADABLE NOW** and gives the reason.
* **Accuracy of actionable LOCKED calls.** The dev loss rate (0.77 %) is about twice the all-LOCKED rate (0.37 %). This is consistent with the adverse-selection fit: a cheaper ask is evidence the call is weaker (pooling weight on the market 0.66, LR test p = 0.037) **[HIST]**.
* **Late LOCKED is mostly strike proximity, not volatility or data.** Lock time is driven by the official margin (Spearman 0.85), not by volatility (0.20) or the basis (0.07).

## 3. Earliest mathematically justified entry

**The rule.**

* YES if and only if `round2(avg of the 60 BRTI seconds in (close−60, close]) ≥ K`, i.e. `avg ≥ K − 0.005`.
* With n prints recorded at average A and r = 60 − n to come, the call flips only if the remaining prints average at least `c = (60(K−0.005) − nA)/r` the other way.
* An index jump X at τ seconds moves the settlement average by `X·(τ+1)/60` inside the window, and by the whole of X before it.
* So the reversal risk at time τ is the probability that the remaining path plus the basis error crosses that critical value.
* 2.8 prices this with empirical, volatility-bucketed tail tables and regime recalibration (validated **[HIST]**). The "sigma cushion" on the page is a display; it is not the decision variable.

**Can LOCKED come earlier without losing accuracy?** The threshold sweep on the same model **[HIST]**:

| LOCKED at flip ≤ | holdout lost / LOCKED | dev lost / LOCKED | mean lead (holdout / dev) | TRADE NOW (dev, cautious) |
|---|---|---|---|---|
| 0.2 % | 1 / 1,870 | 5 / 3,471 (0.14 %) | 79 / 78 s | 170 trades, +0.60 ¢ |
| 0.3 % | 1 / 1,872 | 8 / 3,477 (0.23 %) | 88 / 87 s | 184 trades, +0.23 ¢ |
| **0.5 % (production)** | 3 / 1,879 | 13 / 3,484 (0.37 %) | 100 / 100.5 s | 261 trades, +0.86 ¢ |
| 1.0 % | 5 / 1,885 | **40 / 3,512 (1.14 %)** | 120 / 122 s | 336 trades, +0.46 ¢ |

* **Loosening to 1 % is not justified.** It buys about 20 s of lead, but triples false LOCKED calls on development data. It also lowers total development profit (336 × 0.46 ¢ < 261 × 0.86 ¢), because the extra calls come when the market is already at 99 ¢ or more, where the break-even loss rate is below 1 %.
* **The sigma cushion and thresholds are not delaying signals unnecessarily.**
* **An EV-based entry below LOCKED (HIGH CONFIDENCE at a cheap ask) cannot be validated here.** It needs the Kalshi prices across all historical windows (not in this environment). The evidence that exists points against it: the market price carries information the model lacks (pooling weight 0.66), and the market leader at 95–99 ¢ was slightly overpriced. It is not offered.

**What does move the usable entry earlier, without changing any probability:**

1. **Fix the restart defect (2.8.1).** After a restart 300 s before the close: 0 → 50 of 58 windows LOCKED, 0 wrong, median T−46 s **[SIM]**.
2. **GET READY.** When the model projects LOCKED within about 20 s if BTC holds, the page tells you to open the order ticket.
   * In the 58 windows, the projection was right in 45 of 53 cases, about 15 s before the LOCKED call (median) **[SIM]**.
   * Preparing the ticket shortens your real order time, so more LOCKED calls stay tradable.
3. **The order-time rule.** It does not make anything earlier. It stops a too-late call from being shown as an opportunity.

## 4. The fix: 2.8.1

The code, install steps and rollback are in `2.8.1/README_2.8.1.md`.

* **Cold-start volatility envelope.** Volatility is bracketed until 900 s of history; LOCKED is possible from 120 s.
  * Lower bound: `sqrt(m/900)·σ_m`. This is exact.
  * Upper bound: `max(K(m)·σ_m, F(m))`, the 99.9th percentile × 1.15 on Jul–Aug paths.
  * The call uses the worst probability across the bracket.
  * Coverage on Sep–Oct paths: 100 % (12 series, 6,012 evaluations per history length) **[SIM]**.
* **Cold basis envelope.** Until 12 windows have settled, the call uses the worst probability over basis means of −$7 to +$9.
* **Order time.** TRADE NOW requires τ ≥ 3 s + order time (10 s default, set on the page); later than that is TOO LATE TO TRADE.
* **Execution stress.** The edge after fees must survive a 1.645σ adverse BTC move during the order time.
  * On the 58 windows it refused 0 TRADE NOWs that 2.8 would have made **[SIM]**.
  * It removes only fragile calls; on first LOCKED calls the stressed flip stayed under 0.42 % in 9 of 10 cases.
* **Action states:**
  * TRADE NOW — BUY YES/NO, with the last moment to place the order;
  * PREDICTED LOCKED — NOT TRADABLE NOW, with the reason;
  * TOO LATE TO TRADE;
  * SIT OUT, plus GET READY;
  * WINDOW CLOSED — FINAL / SETTLEMENT (never an opportunity);
  * a restart banner.

### Comparison: 2.8 (deployed) vs 2.8.1 (proposed)

| Measure | 2.8 | 2.8.1 | Source |
|---|---|---|---|
| **Steady state (server up more than 15 min, basis warm)** | | | |
| LOCKED decisions | — | identical every second; 17,400 decision-seconds | [SIM] P1 |
| LOCKED accuracy / false-LOCKED rate | holdout 3 / 1,879 (0.16 %), dev 13 / 3,484 (0.37 %) | same (identical decisions) | [HIST] |
| Actionable LOCKED (first LOCKED with ≥ 13 s left) | 53 of 54 | 53 of 54 | [SIM] |
| LOCKED signals too late for a 10 s order | 1 of 54, still shown as LOCKED (TRADE NOW possible down to T−3) | 1 of 54, shown as TOO LATE TO TRADE | [SIM] |
| Average usable lead (first LOCKED − 13 s) | 83 s | 83 s | [SIM] |
| TRADE NOW in the last 13 s (synthetic book) | allowed until T−3 | 0 | [SIM] P2 |
| TRADE NOW opportunities | holdout 32 / dev 261 (cautious) | same, minus those in the last 13 s (≈ 1–3 %) | [HIST] |
| Profit per contract (cautious) | holdout +2.05 ¢, dev +0.86 ¢ (95 % CI −0.21 to +1.92) | not re-estimable here; ≈ same | [HIST] |
| **Restart 300 s before the close (the Oct 14 mechanism)** | | | |
| LOCKED windows / wrong | **0 / 0** | **50 / 0** | [SIM] |
| Actionable (≥ 13 s) / median lead / mean usable lead | 0 / — / — | 49 / 46 s / 38 s | [SIM] |
| **Restart 330 s before the close** | | | |
| LOCKED / wrong | 56 / 1 (Oct 12 UP, wrong) | 50 / 0 | [SIM] |
| Median lead | 29 s | 47 s | [SIM] |
| **Restart 600–900 s before the close** | | | |
| LOCKED / wrong | 57 / **2** (unvalidated partial volatility) | 49–50 / **0** | [SIM] |
| Median lead | 72 s | 48–49 s | [SIM] |
| **Oct 12 20:45 ET (5:45 pm PT) adverse reversal** | | | |
| Basis known | never LOCKED | never LOCKED | [SIM] |
| Basis model cold, or restarted | LOCKED UP (wrong) at T−17 to T−23 | never LOCKED in any configuration | [SIM] S1 |

The price of the fix is that 2.8.1 is more conservative from 2 to 15 minutes after a restart: about 8 fewer LOCKED windows of 58, and a shorter lead. The calls 2.8 makes in that period rest on an unvalidated volatility estimate, and they include the two wrong calls above.

## 5. Tests

`bash pinradar-research/2.8.1/test/run_all281.sh` runs every check offline:

* a reproducible build;
* self-test 144/144, with the default config and with the new features off;
* the late-LOCKED suite on real windows:
  * P1, P2: warm parity with 2.8;
  * R1: the Oct 14 mechanism;
  * R2: every LOCKED second after a restart is supported by the warm validated engine;
  * S1: the Oct 12 reversal;
  * S2: safely ahead;
  * S3: narrowly ahead (official settlement $1 from the strike);
  * S4: a final-second adverse jump;
  * S5: late index and late book data;
  * S6: a LOCKED call after the book has no offers;
  * S7: a valid signal with insufficient time;
  * S8: after the close;
* the page in jsdom;
* the forensic tool on a fixture of the mechanism;
* cold-band coverage;
* all 2.8 suites against 2.8.1 with the new features off:
  * core 61/61;
  * fuzz: 20,000 cases, 0 violations;
  * replay parity vs 2.7: 17,458 decision-seconds, 0 mismatches;
  * adversarial;
  * properties;
  * live simulation, including live = replay.

The results of the final run are in `2.8.1/TEST_RESULTS.md`.

## 6. What is still needed from you

1. **For the exact Oct 14 reconstruction**, the saved `/health`, `/tape?format=ndjson`, `/predictions?ticker=KXBTC15M-26OCT141930-30` and `/signals?n=5000`. The tape keeps the last 10 windows' final 5 minutes, so the Oct 14 window drops out after about 150 minutes, and any restart erases everything.
   * Alternatively, allow `api.elections.kalshi.com`, `api.exchange.coinbase.com` and `api.kraken.com` in this environment's network settings. I can then rebuild the window from public data: Kalshi's trades and settlement, and the exchange trades for the index.
2. **Deployment of 2.8.1 is your decision.** If you deploy, upload right after a quarter-hour close, never inside a window you intend to trade.

## Files

* `research28/late_lock/`
  * `sim_lib.js` — driver
  * `restart_experiment.js` and `results_restart_2.8*.json` — restart experiment and results
  * `calib_coldvol.js` and `results_coldvol_calib.json` — cold-volatility calibration
  * `lead_analysis.js` and `results_lead_analysis.json` — lead analysis
  * this report
* `2.8.1/`
  * `src/` — `late281.js`, `selftest281.js`
  * `build/` — server and page builds, sha-checked against the deployed 2.8 files
  * `dist/`
  * `test/` — `late281_test.js`, `page281_test.js`, `make_incident_fixture.js`, `run_all281.sh`
  * `tools/` — `forensic281.js`, `replay_tape281.js`
  * `README_2.8.1.md`, `PREREG_AMENDMENT_v3.md`, `SHA256SUMS.txt`
