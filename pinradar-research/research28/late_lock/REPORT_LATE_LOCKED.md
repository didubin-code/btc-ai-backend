# BTC Pin Radar 2.8.1: late LOCKED, DATA UNRELIABLE, late reversals — findings and fixes

Updated 2026-10-15. **Nothing was deployed and no order was placed.** The Render services, `main` and production were not touched by this work. The code is on the research branch `claude/btc-pin-radar-research-xpe585`, in `pinradar-research/2.8.1`.

## Where the evidence comes from

| Tag | Source |
|---|---|
| [CODE] | The deployed 2.8 source, byte-identical to our build (sha256 `0efd86c9…`). |
| [SIM] | The unmodified 2.8 or 2.8.1 server, run on a fake clock with **real** 1 Hz BTC index paths: 58 KXBTC15M windows, Jul 21 – Oct 13, with official results. These windows were picked for earlier tests, so they over-represent reversals; their loss counts are not rates. Kalshi books in [SIM] are synthetic and are labelled where used. Decisions run 0.75 s into each second on venue quotes about 0.7 s old, which slightly inflates the volatility in the last ~20 s. Production quotes are usually fresher, so close-to-the-end results were re-checked at 50 ms where it matters (Oct 12, section 5). |
| [HIST] | Result files of the Oct 13 research: 2,120 holdout windows (Jul 22 – Aug 13) and 3,765 development windows (Sep 4 – Oct 13), with real Kalshi tapes. The raw tapes are not in this environment. Every [HIST] number names its file. |
| [SCREEN] | The user's two screenshots of the deployed 2.8 page, Oct 15 12:00 ET window. |
| [CP7] | A one-line note from the Oct 13 research checkpoints (2.5 engine, development data). No data or script for it exists here, so it cannot be re-checked. |

No server log of any incident window has been received. Network access to Kalshi, Coinbase and Kraken is blocked here.

## 1. Answers in brief

1. **Oct 15 12:00 ET, "LOCKED UP + DON'T TRADE", then "LOCKED — TOO LATE"** [SCREEN].
   * The decision was correct. UP was offered at 99.8 ¢ plus a 0.1 ¢ fee, so it breaks even only above a 99.9 % win probability. The model said 99.54 %.
   * The expected value was −0.36 ¢ on the point estimate and −1.07 ¢ on the conservative one. The market was more confident than the model, so this was not over-conservatism.
   * "LOCKED — TOO LATE" at T−33 was a **labelling defect**: there were no UP offers at all, not too little time. It is fixed.
2. **Oct 14 4:30 pm PT.** Two mechanisms fit, and only the server's logs can tell which happened.
   * **(a) Restart.** The user's 2.8 upload at 23:22:46 UTC restarted the server inside that window, and 2.8 cannot show LOCKED for 300 s after a start [CODE, SIM]. This fits the report "LOCKED appeared late" only if the process started between about 23:24:00 and 23:25:00. A start at 23:25 or later means no LOCKED at all.
   * **(b) The Oct 15 pattern.** LOCKED arrives when the market is already at 99 ¢ or more, then the book empties and 2.8 says "TOO LATE".
   * Both are fixed.
3. **Intermittent DATA UNRELIABLE: a demonstrated defect** [CODE, SIM].
   * The 1 Hz index sampler drifts. When it fires near half a second, two samples round to the same settlement second. One second then looks unrecorded, the coverage gate fires, and the page shows DATA UNRELIABLE for most of the final minute. Measured: **94 % of decisions in the affected windows**.
   * It is fixed: 0 % at every phase, while a real data gap still triggers the warning.
   * **A second change was withdrawn after independent review.** It rebuilt the index without one lagging venue, but it let a frozen venue keep feeding the settlement prints while the warning was suppressed. One lagging venue still shows DATA UNRELIABLE, as in 2.8.
4. **Late reversals are not late signals.** All 15 recorded losing LOCKED calls were made 54–300 s before the close, and were overturned by sharp moves afterwards [HIST]. Two real paths available here show 1.4–1.6× the required move arriving within seconds [SIM].
   * Safeguards based on momentum, volatility or the execution buffer would have prevented none of the 15.
   * A 0.2 % threshold would have prevented about two thirds of them, at the cost of about half the trading profit (section 5).
   * **Oct 12 20:45 ET (a real reversal).** 2.8.1 avoids it only while its basis model is cold, i.e. for about 3 h after a restart. With a known basis and production-like input ages, the model calls LOCKED UP at about T−17 in 2.8 and 2.8.1 alike, and BTC then fell $75 in 12 s. 2.8.1 does not fix this model limit.
5. **The trading edge is not established.** Development TRADE NOW: +0.86 ¢ per contract, 95 % CI −0.21 to +1.92 ¢ (cautious fills) [HIST]. The opportunity is small: about 5 trades a day, about 1–2 ¢ per contract.

## 2. Oct 15 12:00 ET (KXBTC15M-26OCT151200-00) [SCREEN]

| | T−70 s | T−33 s |
|---|---|---|
| State | PREDICTED LOCKED UP (first LOCKED at T−96) | PREDICTED LOCKED UP |
| P(UP) | 99.54 % (conservative flip 1.17 %) | 99.99 % |
| UP ask / size | 99.8 ¢ / 10+ (ladder ≥ 100 at 99.8 ¢) | none (depth 0) |
| EV after fee (10 lot) | −0.36 ¢ point, −1.07 ¢ conservative | — |
| Book age / index age | 526 ms / 340 ms | 522 ms / 107 ms |
| 2.8 action | LOCKED — DO NOT TRADE | LOCKED — TOO LATE ("no UP offers left") |
| **2.8.1 action** | **SIT OUT** — "LOCKED UP, but no edge at 99.8 ¢ (worth it only at ≤ X ¢)" (X below) | **SIT OUT** — "LOCKED UP, but nobody is selling UP: the market treats it as decided" |

* **Nothing blocked TRADE NOW except the price.** At any ask above 99.4 ¢, no win probability can clear a 0.5 ¢ edge after the fee.
* **An entry was worth taking only at about ≤ 98.1 ¢ while LOCKED** (from T−96), on the cautious edge alone.
  * The fee at 98.2 ¢ is 0.2 ¢, not 0.1 ¢. An earlier version of this report said 98.2 ¢; the review caught that.
  * 2.8.1's stress test for a 12 s order time lowers the price further. By how much needs the server's geometry, which the screenshots don't show. The same situation replayed on a real window gave 97.1 ¢ (`late281` S9). Whether such an ask existed between T−96 and T−70 is in the server's `/tape` and `/predictions` for that ticker; the screenshots don't show it.
* **Before T−96 the model was below the LOCKED standard.** Buying the leader there at market prices is not supported by the historical evidence: the market leader at 95–99 ¢ was slightly overpriced [CP7]. The fitted "cheaper ask means a weaker call" effect is exploratory, not established: per-window p ≈ 0.07, and without the one sub-90 ¢ loss b ≈ 0.29 with p ≈ 0.47 (round-3 review CVE-10).

## 3. Intermittent DATA UNRELIABLE

### What triggers it in 2.8 [CODE]

* Every hard data gate forces DATA UNRELIABLE:
  * no geometry;
  * data quality BAD (index unavailable or more than 10 s old, no live venue, Kalshi context more than 6 s old, or strike not yet set);
  * strike implausible;
  * an override is active;
  * the index uses fewer than 2 venues;
  * the oldest index input is older than the budget;
  * fewer than 90 % of the settlement prints so far were sampled;
  * the REST fallback is active;
  * clock skew is unknown or more than 1 s;
  * the live index is unavailable (D1);
  * the official BRTI gate (soft only).
* **Input-age budget.** It is `clamp(100 ms × seconds left, 750 ms, 3 s)`, applied to the oldest of the three venue quotes. In the final 30 s it tightens to 0.1 s per second left.

### Defect 1: sampler phase, demonstrated

`setInterval(1000)` drifts: here, 1.2 ms per tick when idle. The phase of the 1 Hz sample therefore sweeps through the whole second about every 14 minutes, and faster under load. In 2.8, each sample is assigned to one settlement print by rounding. Near a phase of 0.5 s, two consecutive samples round to the same print, and the next print gets none.

Real 2.8 code, 12 real windows, `research28/dq/sampler_phase.js`:

| Sampler phase (±60 ms jitter) | 420 | 450 | 470–530 | 550 | 580 ms |
|---|---|---|---|---|---|
| Decisions in the final 60 s that are DATA UNRELIABLE ("only k/n locked prints sampled") | 0 % | 34 % | 89–94 % | 30 % | 0 % |

**Fix (2.8.1):**
1. Every print takes its nearest sample within 600 ms.
2. The sampler is aligned to the second plus 100 ms, and re-aligned on every tick.
3. Result: 0 % at every phase.
4. A real 5 s gap is still DATA UNRELIABLE, in 8 of 8 windows (`test/dq281_test.js` Q1–Q3).

### One lagging venue: a legitimate warning (the change for it was withdrawn)

* **The mechanism.** The input age is the age of the **oldest** venue in the index. One venue whose quote was 2.6 s old made the call DATA UNRELIABLE in the final 20 s, even with two fresh venues that agreed.
* **The withdrawn change.** A first version of 2.8.1 rebuilt the decision's index from the fresh venues only.
  * The independent review showed the flaw: the 1 Hz settlement ring kept sampling every venue, including a frozen one whose socket was still alive.
  * With a Kraken quote frozen from T−28 on 12 real windows, 2.8 flagged 312 of 336 decisions; that version flagged none. It also showed 3 LOCKED seconds the unfrozen data did not support.
* **Now.** 2.8.1 behaves as 2.8 here: one lagging venue is DATA UNRELIABLE.
  * `dq281` Q4 checks this.
  * Q6 checks the frozen-venue case through the server's own background path. It fails on the withdrawn version and passes now.
* **Whether this case is common in production is unknown.** `/dq` will show it.

**Not yet confirmed from production.** Which of these fires on the deployed server needs its logs. 2.8.1 adds `/dq`, which counts every hard-gate reason with the venue state at that moment; the same counts are on `/health`. On the deployed 2.8, `/signals?n=5000` holds the gate texts.

## 4. Restarts (the Oct 14 mechanism)

* **Volatility warm-up** [CODE]. Volatility is rms(σ120, σ900), and `ringRmsVol(900)` needs 300 samples. So LOCKED is withheld for 300 s after any start. From 300 s to 900 s, 2.8 uses an unvalidated partial σ900.
* **Basis reset.** The basis model (official settlement minus our index) restarts at $0.

**2.8.1 fix:**
* From 120 s of history until 900 s, σ900 is bracketed:
  * lower bound `sqrt(m/900)·σ_m` (exact);
  * upper bound `max(K(m)·σ_m, F(m))` (empirical);
  * m is the number of returns actually observed.
* Until 12 windows have settled, the basis mean is bracketed to −$7…+$9.
* A side is called only if it leads under every candidate.
* The worst probability is taken over a grid, the measured value, and the left limit of every regime edge inside the bracket. Within a regime the flip risk grows with σ, so the worst case is at a bracket end or at an edge's left limit.

**Independent review (round 4)** found and confirmed:
* the cold basis could flip a narrow DOWN leader into LOCKED UP;
* the 9-point grid missed the regime-edge worst case.

Both are fixed. Tests: R3 (348 near-strike cases, 0 opposite-side LOCKED) and R4 (1,987 LOCKED seconds after restarts, a dense σ scan of the bracket, 0 above 0.5 %).

[SIM], 58 windows: LOCKED windows / wrong / median lead in seconds. "Basis cold" is a real restart; "basis known" isolates the volatility warm-up.

| Configuration | 2.8 | 2.8.1 |
|---|---|---|
| Server running for over 15 min, basis known (the validated setup) | 54 / 1 / 78 | 54 / 1 / 78 (identical every second) |
| Running, basis model empty | 57 / 2 / 72 | 51 / 1 / 74 |
| Restart 900 s before close, basis known | 54 / 1 / 77 | 52 / 0 / 54 |
| Restart 900 s before close, basis cold | 57 / 2 / 69 | 49 / 0 / 49 |
| Restart 600 s before close, basis known | 55 / 2 / 76 | 53 / 0 / 50 |
| Restart 330 s before close | 56 / 1 / 29 (51 of 56 at T−29) | 50 / 0 / 46 |
| Restart 300 s before close | **0** / 0 / — | **50 / 0 / 46** |
| Restart 180 s before close | 0 / 0 / — | 50 / 0 / 47 |

* **Input age.** These runs use the harness's ~0.7 s input age. At a production-like 50 ms, the warm, known-basis engine also calls Oct 12 LOCKED UP (wrong) at T−17.25, so its true count here is 2 wrong, in 2.8 and 2.8.1 alike (`late281` S1, reported).
* **The one 2.8 error that is the volatility warm-up alone** is Oct 12 at a 600 s restart. The other extra 2.8 errors come from the basis reset; Sep 2 is wrong on the warm engine too.
* **The cost is a more conservative server after a restart:** fewer and later LOCKED calls for 15 min (volatility), and some for about 3 h (basis), until 12 windows settle.
* **Evidence is limited.**
  * Only 12 of the 58 windows were outside the volatility-band calibration period.
  * Band coverage on them is 100 %, but on roughly 12–24 effectively independent σ900 values.
  * The basis band was set from these same windows' walk-forward means.

## 5. Late reversals and the proposed safeguards

### The 15 recorded losing LOCKED calls [HIST]

From `settle_extra.json` (AgS = 2.7/2.8 behaviour):
* holdout: 3 of 1,879;
* development: 12 of 3,483.

| Losing call | Seconds before close |
|---|---|
| UP | 270, 300, 100, 117, 94, 73, 167, 264 |
| DOWN | 87, 70, 103, 82, 145, 156, 54 |

None was made in the last 50 s. Losses are flat across regimes: quiet 3/898, normal 5/1,438, active 4/1,148 (`AUDIT_25`).

By 30 s momentum at the first LOCKED (`settle_metrics.json`):

| Momentum | Development | Holdout |
|---|---|---|
| Adverse ≥ 2σ | 0/7 | 0/5 |
| Adverse 1–2σ | 0/77 | 0/39 |
| Flat | 8/2,327 | 3/1,290 |
| Favourable | 5/1,073 | 0/545 |

### The two real losing paths available here [SIM]

`research28/losers/reconstruct.js`:

| | Sep 2 23:15 ET (warm engine) | Oct 12 20:45 ET (basis cold) |
|---|---|---|
| Call | LOCKED DOWN at T−97, flip 0.44 % | LOCKED UP at T−17, flip 0.45 % |
| Gap / cushion / required move | −$80.6 / 5.8σ / $80.6 | +$15.6 / 3.0σ / $52.0 |
| Volatility, regime, momentum | 0.22 bps/√s, normal, +1.45 | 0.62 bps/√s, active, −0.8 |
| What happened | BTC +$128 in 44 s (1.59× required) | BTC −$75 in 12 s (1.44× required) |
| 2.8.1 | same LOCKED (warm and cold) | never LOCKED with a cold basis; with a known basis and 50 ms input age, LOCKED UP at T−17.25 like 2.8 (a model limit) |

### What each safeguard would have done

| Safeguard (tested as a hypothesis) | Losing LOCKED calls prevented | Opportunities removed | Verdict |
|---|---|---|---|
| LOCKED at flip ≤ 0.2 % (instead of 0.5 %) [HIST] | development 13 → 5 losses (8 prevented), holdout 2 of 3. This sweep's rule set counts 13 development losses at 0.5 %; the 2.7/2.8 rule set above counts 12 | development TRADE NOW 261 → 170, cautious profit per contract +0.86 → +0.60 ¢, total −55 %; holdout 32 → 25 trades, total −42 %; mean lead −22 s | Not adopted as the trade rule. Already in the forward test (shadow C1). |
| LOCKED at flip ≤ 1.0 % [HIST] | none (development losses 13 → 40) | — | Rejected. |
| ≥ 15 s execution buffer | 0 of 15 (no loss was called that late) | TRADE NOW in the last 15 s: ≤ 8 of 261 development trades by the fixed-time counts (not measured exactly) | **Adopted** (12 s order time + 3 s), for executability, not for risk. |
| Momentum veto | 0 (no loss in the adverse classes) | 84 development / 44 holdout calls | Rejected. |
| Exit on REVERSAL WARNING (flip ≥ 10 %) [HIST] | warned 11 of 12 development losers; exits about break-even | 25 false alarms | Unchanged (a warning, not an exit rule). |
| Restart envelopes [SIM] | Oct 12 basis-cold error (not its known-basis error); restart errors 2 → 0 at the harness input age | about 8 of 58 LOCKED windows in the first 15 min after a restart | **Adopted.** |
| Execution stress test (1.645σ during the order time) [SIM] | not measurable here (no historical books) | 76 of 2,291 TRADE NOW seconds refused (3.3 %, synthetic book, 12 s order time) | **Adopted as a conservative choice; its cost in real trades is unmeasured.** Requires the cautious value to stay ≥ 0 after the adverse move. The stressed cautious flip at the first LOCKED has a median of 1.56 / 2.11 / 3.09 % for 3 / 12 / 30 s order times (`results_stress.json`). `EXEC_STRESS_Z=0` turns it off. |

The LOCKED threshold stays at 0.5 % (development total profit: 0.2 % → 101, 0.3 % → 42, **0.5 % → 223**, 1.0 % → 153 cent-contracts). On holdout, 1.0 % did best (99 vs 66), so the choice is not robust either way. The forward test's shadow policies keep measuring it.

## 6. Why LOCKED is rarely tradable, and what the economics are

| Measure | Value | Source |
|---|---|---|
| First LOCKED, development (3,484 calls) | 0–15 s: 85 (2.4 %, 1 loss) · 15–30 s: 321 · 30–60 s: 872 · 60–90 s: 743 · 90–120 s: 446 · 120–180 s: 495 · 180–300 s: 522 | AUDIT_25 in the server |
| Lead before the close | mean 100 s, median 77 s (both sets); P10 ≈ 28 s (development); P10 / median / P90 on 58 windows: 36 / 78 / 184 s | [HIST] / [SIM] |
| Correlation of first-LOCKED time with the official margin / volatility / basis | Spearman 0.85 / 0.20 / 0.07 | [SIM] |
| Leader ask in LOCKED windows that had a price | median 99.9 ¢; ≤ 99 ¢ in 0.2–4.0 % (holdout T−3: 1 of 99 priced) | `fixed_time_trade.json` |
| Market at 99 ¢ before the model's LOCKED | 85 % of windows | [CP7], 2.5 engine, not reproducible here |
| LOCKED windows with a +EV TRADE NOW | 1.7 % holdout (32/1,879), 7.5 % development (261/3,484) | `settle_metrics.json` |
| TRADE NOW, cautious fills | holdout 32 trades, 0 lost, +2.05 ¢ (CI +1.38 to +2.73); development 261, 2 lost, +0.86 ¢ (CI −0.21 to +1.92) | `settle_metrics.json` |
| Forward, user's live 2.8 (screen) | 0 of 51 LOCKED lost; 9 paper trades, mean +2.12 ¢ | [SCREEN] |
| "LOCKED within ~20 s if BTC holds" (GET READY) | right within the projected time 37 of 53; within +10 s 45 of 53; median 15 s warning | [SIM] |

**What this means:**
* Each trade risks about 98 ¢ to win 0.2–3 ¢. At the observed LOCKED loss rate (0.37 % development) the edge exists only when the ask is at or below about 99 ¢, which happens in a few percent of LOCKED windows.
* Expected profit is roughly 1–2 ¢ per contract, a few trades a day, limited by depth at good prices. One loss erases about 50–100 winning trades.
* Establishing the edge at 95 % confidence needs about 200–600 forward trades: 30–90 days at about 7 a day (`reanalysis.json` `forward_plan_trade_now`).

## 7. What the page shows (2.8.1)

**Top line:** TRADE NOW — BUY YES/NO, **SIT OUT** or **TOO LATE**, followed by the reversal risk and one reason. Examples:

| Situation | Reason shown |
|---|---|
| LOCKED but overpriced | "LOCKED UP, but no edge at 99.8 ¢ (worth it only at ≤ 97.1 ¢)". The price includes the fee at that price and the stress test. |
| LOCKED but no offers | "nobody is selling UP: the market treats it as decided" |
| LOCKED but no time | "LOCKED UP with 9 s left: an order needs 15 s" |
| After the close | "window closed" |
| Restart | "not LOCKED yet: server restarted, LOCKED unavailable for now" |

**Also on the page:**
* The last moment to place an order.
* A GET READY note, only when LOCKED could actually be shown.
* A restart banner.
* If the backend goes stale or the window closes, the line drops to STALE or WINDOW CLOSED.
* TRADE NOW also turns into TOO LATE at the last order moment by the browser's own clock, and into STALE after 1.5 s without a server reading at any time before the close. This was a review finding: before, the page waited 6 s when more than 120 s were left.

The big outcome headline (PREDICTED LOCKED — UP) is unchanged. The page layout is otherwise the 2.8 layout.

## 8. Tests

`bash pinradar-research/2.8.1/test/run_all281.sh` runs offline. Results are in `2.8.1/TEST_RESULTS.md`, and checksums in `2.8.1/SHA256SUMS.txt`.

* **Self-test:** 148/148.
* **Real-window suite (`late281`), 15 checks:**
  * P1 and P2: parity with 2.8 when warm; the stress test binds.
  * R1–R4: restarts.
  * S1–S9: scenarios, including the Oct 12 reversal, the Oct 15 replica, a jump at T−35, the empty book and insufficient time.
  * S1 runs at both input ages. With a cold basis, 2.8.1 never calls LOCKED. With a known basis, it adds no LOCKED second to the warm engine's; the warm engine's own Oct 12 call is reported.
  * S3 (narrow margins) is reported only: a $1 margin is decided by the basis, so wrong-side LOCKED there is a model limit.
* **`dq281`:** 6/6, including Q6, the frozen venue.
* **Page:** 16/16, including TRADE NOW expiring by the browser's clock and on a stale server.
* **Forensic tool:** fixture check.
* **Cold-band coverage.**
* **The 2.8 suites against 2.8.1** with every new feature off (`COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0`), confirming it behaves as 2.8.

## 9. What would settle the remaining questions

1. **The deployed server's logs,** read with `2.8.1/tools/forensic281.js`. This needs `/health` with the time you saved it, `/ledger?since=0&n=5000`, `/predictions?ticker=…`, `/signals?n=5000` and `/tape?format=ndjson`. It settles the Oct 14 cause, the DATA UNRELIABLE reasons, and the Oct 15 price path.
2. **Network access** to `api.elections.kalshi.com`, `api.exchange.coinbase.com` and `api.kraken.com`. With it the full dataset can be rebuilt and every window since Oct 13 used as a genuinely untouched test: model calibration, the threshold choice, and whether TRADE NOW makes money with real books.
3. **The forward test** (pre-registration v3 for 2.8.1). A ledger on a persistent disk is needed; without one, a restart loses the evidence.
