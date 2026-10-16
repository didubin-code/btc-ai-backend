# BTC Pin Radar — historical validation, independent data and stress test: final report (2026-10-16)

## Verdict first

**H. Ready for real-money deployment?**

| Use | Verdict | Deciding evidence |
|---|---|---|
| **The intended trade: about $50,000 at about 99.9 ¢** | **NO** | The pre-registered NO rule triggered. Kalshi's real prints show 50,046 contracts at ≤ 99.9 ¢ in the 12 s after a T−20 entry in **1 of 15,772** unseen windows. Buying at the *first* LOCKED is worse: it is wrong 0.17 % of the time (28 of 16,773 unseen calls, 95 % CI 0.11–0.24 %), and break-even is 0.093 %. |
| Small sizes (10–1,000 contracts), first LOCKED, 90 ¢ guard | **NOT YET VALIDATED** | On 6 unseen months it earned +0.41 ¢ per contract (95 % CI +0.35 to +0.47) at 100 contracts, against about 0 for a market-only rule. That is about $4,300 in 6 months. The fill model is an upper bound; the live index differs from the replay feed; and the edge was smaller in later months. A forward test with real small orders is the next step. |
| As a forecast display (directional certainty) | supported, with known limits | LOCKED means "flip risk ≤ 0.5 %". On unseen data it was wrong 0.17 % of the time. Its errors are concentrated in calls made in the last 15 s and in DOWN calls. |

Evidence is a backtest. It bounds the risk; it does not guarantee future results.

**Evidence tags used below:**

| Tag | Meaning |
|---|---|
| [RUN] | Executed in this session on the data described in `DATA_PROVENANCE.md`. Every number is reproducible with the commands at the end. |
| [SCREEN] | Read from your photo. |
| [EXPLORATORY] | Found or designed after looking at the decisive data. Hypothesis-generating, not validated. |

All tables are generated from the result files by `pipeline/final_tables.py` into `RESULTS_TABLES.md`. Figures quoted here are copied from those files.

---

## What was done

| Phase | What was executed |
|---|---|
| 1. Audit of logs and software | Every file in both repositories was inventoried. The deployed server's logs (ledger, predictions, tape) are **not** available here: no file holds them, and the server was not contacted (your Render services were not touched). The 58 saved real windows and your photos were used. The full 2.8.1 test suite was run: all checks pass (`2.8.1/TEST_RESULTS.md`). |
| 2. Independent data | Every settled Kalshi KXBTC15M contract that publishes its official settlement values: **25,994 contracts, 2026-01-13 → 2026-10-16** (9 months; the series does not go further back with these values). Kalshi trade prints for each window's last 300 s. Binance 1 s BTC prices **2023-10-01 → 2026-10-15** (37 months, checksums verified). Coinbase and Kraken trades for cross-checks. Provenance: `DATA_PROVENANCE.md`. |
| 3–4. Hypothesis and reliability | The current engine was replayed second by second over every contract, with no look-ahead (`replay_chrono.js`). That is 25,982 windows and about 7.8 million decisions per run, on five configurations. Scoring followed the pre-registered splits (`VALIDATION_PREREG.md`, committed before any data were fetched). A separate 27-month proxy study used 80,159 windows. |
| 5. Profitability | Break-even (`economics.js`). Executable volume, and P&L at 10 / 100 / 1,000 / 10,000 / 50,046 contracts, from Kalshi's real prints: VWAP and worst-fill, latency 0 / 2 / 5 s, fee included, day-block bootstrap (`execution.py`, `trading_eval.py`). |
| 6. Break the software | Three adversarial review rounds of 2.8.1; fault injection; restart, stale-data and race tests; feed, latency, settlement-lag and timing sensitivity on the real data; an independent audit of this validation's own claims (section "Corrections"). |
| 7. Improve and retest | Two candidate changes, built into 2.8.1 behind switches that are **off by default**, replayed over all contracts. They are labelled exploratory because they were designed after seeing unseen-period results. |

**Splits (pre-registered):**

| Split | Period | Status |
|---|---|---|
| **U2** | 2026-01-13 → 07-21 | unseen, decisive (17,841 windows) |
| **U1** | 2026-10-14 → 10-16 | unseen, decisive (185 windows) |
| **Seen** | 2026-07-22 → 10-13 | used while building 2.6–2.8: reported, not decisive (7,956 windows) |
| **P (proxy)** | 2023-10-01 → 2026-01-13 | Binance prices only; outcome defined by the proxy itself; never pooled with contract results |

---

## A. Does the underlying hypothesis hold?

**Partly.** Distance, σ-cushion, time left, volatility and settlement-average mathematics do identify moments when the outcome is very likely. The engine's flip probabilities are honest or conservative over most of the window. **But they cannot get the failure rate at the moment LOCKED first appears below the 0.093 % that a $50,000-for-$47 trade needs.** Where the rate does fall low enough (still LOCKED at T−30 … T−15), the market has already priced the outcome at 99.9–100 ¢ and there is almost nothing left to buy.

**What the evidence supports [RUN]**, primary engine 2.8.1, BTCUSDC feed, unseen U:

| Moment | Wrong / LOCKED | Rate | 95 % CI or one-sided bound | vs 0.093 % break-even |
|---|---|---|---|---|
| First LOCKED second | 28 / 16,773 | 0.167 % | 0.111–0.241 % | **above** |
| Still LOCKED at T−60 | 3 / 10,376 | 0.029 % | ≤ 0.075 % | below |
| Still LOCKED at T−30 | 2 / 14,842 | 0.013 % | ≤ 0.042 % | below |
| **Still LOCKED at T−20** | **2 / 15,936** | 0.013 % | **≤ 0.040 %** | below |
| Still LOCKED at T−15 | 3 / 16,276 | 0.018 % | ≤ 0.048 % | below |
| Still LOCKED at T−10 | 4 / 16,479 | 0.024 % | ≤ 0.056 % | below |
| Still LOCKED at T−5 | 8 / 16,536 | 0.048 % | ≤ 0.087 % | borderline |

* Coverage: 93.0 % of unseen windows were LOCKED at some point.
* The fixed-time cells overlap: the same windows are counted at different times. T−20 was named as the primary entry rule **before** the data were seen.
* **The 27-month proxy agrees on the shape** [RUN]. Over 80,159 windows from Oct 2023 to Jan 2026, first LOCKED was wrong 188 / 74,811 times (0.251 %, CI 0.217–0.290 %). Still LOCKED at T−20 was wrong 3 / 71,414 times, and at T−10, 0 / 73,487.

**What the evidence does not support:**

1. **A LOCKED call made early is not near-certain.** It is a "≤ 0.5 % flip" call, and the engine's probabilities say so.
   * On the proxy, where there is no feed-vs-index error, failures were 0.6–0.9× what the engine predicted at T−120 … T−60, and 0.4× at T−45 … T−15 (`calibration.json`).
   * On contracts, unseen data gave 0.1–0.5× at T−120 … T−30.
   * LOCKED is honestly calibrated to a threshold five times looser than your trade needs.
2. **Momentum does not predict the failures** [RUN, `anatomy.json`].
   * Calls made while the price was moving against them (adverse momentum ≥ 1): 1 wrong of 438.
   * The rest: 27 of 16,335.
   * Fisher p = 0.52 on unseen data. Across all periods it is 3 / 686 against 44 / 23,317, p = 0.15.
3. **Volatility regime does not separate them.** Failure rates are 0.10–0.30 % in every volatility band.
4. **Required move and cushion help only a little.**
   * Below 3σ cushion: 0.50 % wrong (11 / 2,199).
   * 3–4σ: 0.15 %.
   * Above 4σ: 0.08 % (5 / 6,454).
   * Even the best band is near break-even.
5. **DOWN calls fail more often than UP** [EXPLORATORY: not a pre-registered hypothesis].
   * Unseen: 20 / 8,421 against 8 / 8,352 (Fisher p = 0.036).
   * All periods: 32 / 12,051 against 15 / 11,952 (p = 0.019).
   * The proxy shows no asymmetry (94 / 37,014 against 94 / 37,797). The asymmetry is therefore likely in the feed-vs-BRTI basis, not in BTC itself.

## B. Can the newest Pin Radar be relied on for sufficiently accurate LOCKED signals?

**As a forecast: yes, with documented limits. As a trigger for $50,000 trades: no.**

**Demonstrated failure rates (all periods, primary engine) [RUN]:**

| Item | Value |
|---|---|
| First LOCKED wrong | 47 / 24,003 = 0.196 % (CI 0.144–0.260 %) |
| By period | unseen 0.167 %; seen 0.263 % (19 / 7,230) |
| Deployed 2.8 | the same 47 wrong calls (47 / 24,004; 2.8 has one extra, correct, LOCKED window). 2.8.1 does not change the probability model. |
| Current 2.8.1 build vs the pre-registered build | byte-identical decisions with the candidate switches off (287-window parity replay, 86,400 decisions) |
| REVERSAL WARNING after a LOCKED call | on 34 of 47 wrong calls (32 with ≥ 15 s left); on 211 of 23,956 correct calls (0.9 % false alarms) |
| Windows never LOCKED | 1,979 of 25,982. By official margin: 1,018 under $5 and 640 of $5–20 (genuine toss-ups); 30 of $20–100; **291 of $100 or more** (missed: section D). |
| DATA UNRELIABLE windows | 0 in the replays. The replay feeds have no gaps; live gaps are covered by the 2.8.1 fault-injection tests. |

**Where the failures are** (unseen, 28 wrong first-LOCKED calls) [RUN]:

| Time left at the first LOCKED | Calls | Wrong | Rate |
|---|---|---|---|
| under 15 s | 362 | 9 | **2.49 %** |
| 15–30 s | 1,419 | 5 | 0.35 % |
| 30–60 s | 4,383 | 3 | 0.07 % |
| 60–120 s | 5,757 | 4 | 0.07 % |
| 120–300 s | 4,852 | 7 | 0.14 % |

**Two failure classes:**

1. **Near-strike settlements.** 19 of the 28 settled within $10 of the strike; 13 of those were called in the last 30 s.
   * Here the difference between the replay's exchange feed and CF Benchmarks' BRTI decides the outcome.
   * Calibration shows the engine is **over-confident in the last 15 s on the replay feed**: observed / predicted failures were 2.3× at T−15, 6× at T−10 and 46× at T−5 on unseen data (`calibration.json`).
   * It is **not** over-confident on the proxy, where the feed *is* the reference: 0 failures from T−10.
   * So the error is the basis (feed vs official index), not the price model. The live server has a three-venue index and an official-BRTI panel for the final minute. The replay could not reproduce either (Kalshi publishes the live BRTI only over an authenticated stream). Live behaviour in the last 15 s is therefore **untested** here, in either direction.
2. **Real reversals.** 9 of the 28 settled $10–244 on the other side of the strike.
   * 8 of them were called 97–288 s before the close, with the market agreeing: the called side last traded at 97.8–99.8 ¢.
   * This includes two DOWN calls overturned by $244 and $220.
   * The ninth was called at T−9 while the market priced the called side at 0.9 ¢. That is a feed error, and the 15 s buffer and the guard both block it.
   * This is the Oct 15 20:30 ET class (`INCIDENT_OCT15_2030ET.md`). No observable at the call separated them from correct calls.

**Generalisation.** The rate on unseen data (0.167 %) is lower than on the period used to build the software (0.263 %). Overfitting would show the opposite.

**Feed sensitivity** [RUN]:

| Feed | First LOCKED wrong (unseen) | T−20 (unseen) | T−20 (all) |
|---|---|---|---|
| Binance BTCUSDC (primary) | 0.167 % | 2 / 15,936 | 2 / 22,751 |
| Binance BTCUSDT | 0.273 % (46 / 16,839) | 5 / 16,035, bound 0.066 % | 12 / 22,900, bound 0.085 % |

* On the seen period the USDT feed gives 7 / 6,865 at T−20 (bound 0.19 %). That is above break-even, so the late-window reliability depends on how well the index tracks BRTI.
* **Feed tracking** (one-step error of the server's own basis predictor against Kalshi's official value; Coinbase covers Sep 15 – Oct 4 only, Kraken partial days):

  | Feed | Error sd | Errors over $10 |
  |---|---|---|
  | BTCUSDC | $4.93 | 2.8 % |
  | BTCUSDT | $6.30 | 7.7 % |
  | Coinbase | $4.00 | 1.4 % |
  | Kraken | $9.03 | 23.9 % |

## C. How many historical failures would the new software have prevented?

**Exact numbers [RUN, `prevented.json`].** For the 28 wrong first-LOCKED calls on unseen data, all with a Kalshi tape, and for the 47 across all periods:

| Safeguard (in which version) | Wrong calls kept out of a trade | Correct calls also kept out (cost) |
|---|---|---|
| 15 s buffer: no TRADE NOW with < 15 s left (2.8.1) | 9 of 28 (all: 11 of 47) | 353 of 16,745 |
| 90 ¢ market-disagreement guard (2.8 and 2.8.1) | 12 of 28 (all: 13 of 30 with a tape) | 114 |
| Either of the two | **13 of 28** | 449 |
| Not prevented: traded at the first LOCKED with the market at 94–99.8 ¢ | **15 of 28** (all: 16 of 30 with a tape) | — |
| Entry only if still LOCKED on the same side at T−20 | 26 of 28 (all: 45 of 47) | 811 correct first-LOCKED calls not LOCKED the same way at T−20 |

* **Not prevented by any 2.8.1 change: the displayed LOCKED itself.** 2.8 and 2.8.1 show the same wrong LOCKED calls, all 47.
* 2.8.1's other fixes address failures that a replay cannot contain. Each is demonstrated by a test that fails on 2.8 and passes on 2.8.1 (`2.8.1/TEST_RESULTS.md`):
  * restart and cold-start errors: restart errors 2 → 0 in the restart simulations;
  * DATA UNRELIABLE false alarms from the sampler phase: up to 94 % of final-minute decisions → 0 %;
  * stale TRADE NOW on slow links;
  * "TOO LATE" shown on empty books.
* **The Oct 15 20:30 ET loss** [RUN, `INCIDENT_OCT15_2030ET.md`]:
  * DOWN traded at 79 ¢ when LOCKED DOWN appeared, so the 90 ¢ guard (2.8 and 2.8.1) would have refused TRADE NOW.
  * The T−20 rule would not have entered.
  * The LOCKED display itself is not prevented.

## D. Missed opportunities

* **Never LOCKED, with an official margin of $100 or more: 291 windows** (1.1 %).
  * In **all 291**, the engine's volatility estimate (above 1.767 bps/√s) was outside the range its tables were validated on, so the soft gate held the call at HIGH CONFIDENCE.
  * This was checked by replaying each window again with the gate reasons recorded (`replay_chrono.js --warm 3600`, one window at a time).
  * 148 of them are from February 2026.
  * These are real misses, but recovering them would mean extrapolating the probability tables beyond their tested range. That was **not** done: you asked not to weaken risk controls for more signals.
  * **What they were worth** [RUN, `missed_value.py`]. Buying the side the engine leaned to at T−60, with the same fill rule:
    * 262 of the 291 have a tape. The leaned side won 261 times.
    * Only 56 could fill 100 contracts; the called side last traded at a median of 99.0 ¢.
    * Total value at 100 contracts: **$106 over 9 months**.
    * The exclusion costs almost nothing, so there is no case for loosening it.
  * The 1,658 never-locked windows with margins under $20 are genuine toss-ups.
* **Trades missed for lack of a price, not a signal.** At T−20 the median number of called-side contracts bought at ≤ 99.9 ¢ in the next 12 s was **0**; the 90th percentile was 711. Only 2,305 of 15,710 unseen T−20 entries could fill even 100 contracts.
* **Recovering them would need buying earlier, at the first LOCKED.** That has more fills (10,586 of 16,477 at 100 contracts), but it is where the failure rate is 0.17 %.
  * At small sizes that rate is affordable, because the fills are cheaper: median VWAP 99.73 ¢, interquartile range 99.16–99.87 ¢.
  * At $50,000 it is not.
* **The page's TRADE NOW edge rule** (cautious value − price − fee ≥ 0.5 ¢) picks the cheapest asks. On unseen data it made 392 trades at 100 contracts and lost 4 (1.0 %), for +1.97 ¢ per contract (CI +1.21 to +2.58), or $772.
  * It trades rarely, and the cheap price is itself a warning: 4 losses in 392 is 6× the first-LOCKED rate.

## E. At least one year of independently sourced data

* **Contracts.** Kalshi publishes KXBTC15M official values from **2026-01-13** only. Earlier markets (Dec 2025 – Jan 2026, 2,878) used a different strike rule and carry no values; they are excluded and listed.
  * Contract-level validation therefore covers **9 months: 25,994 contracts**. 18,026 of them are unseen.
* **Longer horizon.** The ≥ 12-month requirement is met by the proxy: Binance BTCUSDT 1 s, **2023-10-01 → 2026-01-13, 27.5 months, 80,159 windows**, checksums verified.
  * Its outcome is the proxy's own 60 s averages, so it tests the price-path model only, not the BRTI basis or execution.
  * Results: section A table, and `RESULTS_TABLES.md`. By month, the first-LOCKED failure rate ranged 0.07–0.37 % (28 months).
* **Method.** Continuous chronological replay of the actual server build:
  * prices fed second by second;
  * decisions at 0.75 s into each second, with a 50 ms quote age;
  * official values reach the basis model 5 s after each close, as in production;
  * month chunks with 24 h warm-up.
  * Outcomes are Kalshi's `result`.
  * Execution is scored from Kalshi's real prints.
* **Provenance.** Every HTTP response is logged with URL, status, size, SHA-256 and time (`PROVENANCE*.ndjson`). Every excluded market is listed with its reason. Nothing was imputed.

## F. Would the strategy have been profitable at the intended amounts?

**Theoretical settlement accuracy vs realistic execution — kept separate.**

**1. The arithmetic of the intended trade** (`economics.js`, Kalshi taker fee `ceil(0.07 × C × P × (1−P))`):

| Price | Contracts for $50k | Win | Loss | Break-even failure rate |
|---|---|---|---|---|
| 99.9 ¢ | 50,046 | +$46.55 | −$49,999 | 0.093 % |
| 99.8 ¢ | 50,093 | +$93.19 | −$50,000 | 0.186 % |
| 99.0 ¢ | 50,469 | +$469.71 | −$49,999 | 0.93 % |

**2. Settlement accuracy alone (no execution).**
* At the first LOCKED: 0.167 % wrong, against 0.093 %. **Negative EV: about −$37 per $50k trade** (0.00167 × 50,000 vs 0.99833 × 46.55).
* Still LOCKED at T−20: 0.013 % wrong. The bound of 0.040 % is below break-even, so positive in theory.

**3. Real execution (Kalshi prints) [RUN].**
* **Capacity at $50,000.** 50,046 contracts at ≤ 99.9 ¢ within 12 s:
  * T−20, unseen: **1 of 15,772 entries (0.006 %)**;
  * all periods: T−20 4 / 17,703, T−30 0.06 %, first LOCKED 0.44 %.
  * The trade does not exist at that size in this market. **Pre-registered NO.**
* **Unseen U2 (Jan 13 – Jul 21), complete tapes: P&L per contract after fees.** VWAP fill, 95 % day-block CI:

{{TRADING_U2}}

**4. Sensitivity** [RUN]:

| Change | model: first LOCKED at C = 100 |
|---|---|
| Fill at the worst print instead of VWAP | +0.25 ¢ (CI +0.18 to +0.31) |
| + 0.1 ¢ slippage | +0.32 ¢ |
| Entry latency 2 s | {{LAT2}} |
| Entry latency 5 s | {{LAT5}} |
| Market-only rule at worst fill | −0.44 ¢ (CI −0.59 to −0.29) |

**5. Over time and on the seen period** [RUN]:

{{MONTHLY}}

**6. Exit on REVERSAL WARNING** [RUN]:

{{EXIT}}

**Answer.**
* **At $50,000: no.** The size cannot be filled, and at the moment it could be (first LOCKED) the failure rate is above break-even.
* **At 100–1,000 contracts: yes, on unseen data.**
  * The strategy is roughly 0.4 ¢ per contract better than the market's own price-following rule.
  * At 1,000 contracts that was $26,600 in 6 months, with 7 losing trades of about $1,000 each.
  * The fill model assumes you got the prints other traders got. That is an **upper bound**.
* **At 10,000 contracts** it filled only 873 times in 6 months. The VWAP result (+0.46 ¢) is not robust to worst-fill pricing (+0.09 ¢, CI −0.20 to +0.22).

## Phase 6. Attempts to break the software

| Scenario | How tested | Result |
|---|---|---|
| Abrupt reversals, extreme momentum, volatility spikes | real data: anatomy of all 47 / 28 wrong calls | the main residual risk; not predictable from momentum or volatility (section A) |
| Final-second moves, settlement-reference divergence | real data: calibration by time left; two feeds; proxy | over-confident in the last 15 s on exchange feeds (basis); TRADE NOW is already barred there (15 s buffer) |
| Settlement-average maths | every contract: `round2(expiration_value) ≥ floor_strike ⇔ result = yes` holds for all 25,994; engine self-test 150 / 150 | no error found |
| Stale or missing data, WebSocket loss, one lagging venue | fault injection (`dq281_test.js` 6 / 6); real gaps; frozen venue | 2.8.1 detects them; three earlier holes were fixed in review |
| Clock and time synchronisation | sampler phase sweep; kline timing shifted 0.9 s | phase bug fixed in 2.8.1; timing shift changes T−20 failures 2 → 4 and first LOCKED 47 → 44–47 |
| Settlement lag | official value fed 5 s vs later | negligible |
| Race conditions, contradictory states | 20,000-case fuzz (0 violations); page tests 17 / 17; restart simulations | consistent; restart errors fixed in 2.8.1 |
| Latency between prediction and execution | 0 / 2 / 5 s in the P&L | edge shrinks but stays positive at small sizes (section F) |
| Liquidity shocks | real prints | depth at 99.9 ¢ is thin; median 0 contracts at T−20 |
| Restart / cold start | 330 s-before-close restart fixture (the Oct 14 mechanism) | 2.8 withheld a supported LOCKED until T−31; 2.8.1 at T−57 |

**Synthetic stress tests are labelled as such in `2.8.1/TEST_RESULTS.md`.** No synthetic result is used as evidence of a failure rate.

## G. Improvements: what is empirically justified

**Justified and in 2.8.1 (default on):** the operational fixes listed in section C, each with a regression test. 2.8.1 makes the same decisions as 2.8 on every replayed window, and adds:
* the 15 s TRADE NOW buffer (keeps 9 of 28 unseen wrong calls out of a trade);
* restart envelopes;
* the DATA UNRELIABLE sampler fix;
* honest TRADE NOW / SIT OUT / TOO LATE states.

**Directional certainty vs execution readiness.** 2.8.1 shows them separately and consistently: LOCKED / REVERSAL WARNING for direction; TRADE NOW / SIT OUT / TOO LATE / NO BOOK for execution, with the qualifying price and the 90 ¢ guard. This is tested in `page281_test.js`.

**Candidates.** Built into 2.8.1 behind switches that are **off by default**. Replayed over all contracts. [EXPLORATORY]: designed after seeing the unseen-period calibration, so their unseen results are not independent validation.

1. **`ADAPTIVE_BASIS=1`.** It widens the basis uncertainty when the recent feed-vs-official errors are large. This targets failure class 1 (near-strike settlements in the last 15 s).

   | Metric (unseen U) | 2.8.1 | Candidate, USDC | Candidate, USDT |
   |---|---|---|---|
   | First LOCKED wrong | 28 / 16,773 (0.167 %) | 16 / 16,527 (0.097 %) | 23 / 15,910 (0.145 %) |
   | T−20 wrong | 2 / 15,936 | 0 / 15,750 | 3 / 15,248 |
   | Calibration at T−5 (observed / predicted) | 46× | 9.8× | — |
   | Coverage | 93.0 % | 91.7 % | 88.3 % |

   * Coverage drops by 1.4 points (USDC) or 5.5 points (USDT, all periods).
   * Trading on U2: {{CAND_TRADING}}
   * It does nothing for failure class 2 (real reversals).
   * Status: **promising, not validated.** It needs a forward test on the live index before it can be switched on.
2. **`MARKET_VETO_CENTS=90`.** It shows the 90 ¢ guard on the LOCKED headline itself, not only on TRADE NOW.
   * In-sample: the guard fired on 132 of 18,623 first-LOCKED calls, and 13 of those were wrong (9.8 %, CI 5.3–16.3 %). The other 18,491 calls had 17 wrong (0.092 %).
   * Not pre-registered as a test. **Not validated.**

**Rejected or not adopted:**
* **The 0.2 % LOCKED threshold.** It removes many calls; designed on seen data.
* **Extrapolating the volatility tables** to recover the 291 large-margin misses. That would weaken a risk control.
* **Exit on REVERSAL WARNING.** It is neutral to slightly negative (section F).
* **Momentum filters.** Not predictive (section A).

**The approach that would actually fit your objective.**
* What the data say: certainty is reached late, after the market already prices it, while early calls are not certain enough for 1,000:1 risk.
* The objective of $50,000 at 99.9 ¢ is not reachable with this signal in this market.
* What the evidence supports instead is **small sizes (100–1,000 contracts) at the first LOCKED, with the 90 ¢ guard and the 15 s buffer**:
  * the edge is +0.4 ¢ per contract over the market's own price;
  * worst case per trade is about the stake.
* This has to be confirmed with a live forward test of real small orders before more money is risked.

## Corrections made after an independent audit of this validation

A separate audit pass re-derived every headline claim from the raw files. Confirmed corrections, all applied above:

1. **The market baseline had a look-ahead.** It counted the very print that triggered the entry as a fill.
   * Fixed: the baseline now fills only on prints strictly after the trigger, and fills are recomputed from one tape snapshot for every strategy. Parity with `execution.py`: 62,882 rows, 0 mismatches.
   * The earlier claim "the market-only baseline lost money" is **withdrawn**. Corrected, it is about 0 (+0.05 ¢, CI −0.10 to +0.20).
2. **"No T−20 entry ever had $50,000 of volume" was false.** The full-period figure is 4 of 17,703 (0.023 %), and 1 of 15,772 on unseen data. The verdict is unchanged.
3. **The model-minus-baseline gap is +0.36 ¢** (paired, CI +0.21 to +0.53) on unseen data, not the earlier +0.60.
4. **Robustness checks.**
   * Latency 2–3 s reduces the edge to about +0.37 ¢.
   * Kline timing and settlement lag change results only slightly.
   * Coverage of 92–93 % is an upper bound: live-only gates (official panel, venue quorum) can only lower it.

## Deviations from the pre-registration (disclosed)

* **The proxy period** was set to Oct 2023 → Jan 13 2026, not → Jul 21 2026, so that it does not overlap the contract period.
* **The "57 of 60 settlement-minute prices" exclusion** excluded 0 windows: the Binance archives have no empty seconds. It was applied to the basis-model samples.
* **Trading on the seen period** uses only the tapes downloaded so far: 2,911 of 8,153 markets when the tables were built. It is reported as partial and is not decisive.
* **U1 is small** (185 windows, Oct 14–16).

## What is still missing, and what you can provide

1. **The live server's logs** for the forward period. With these, `forensic281.js` can score the deployed engine on its own index, which no replay can reproduce:
   * `/ledger?since=0&n=5000`
   * `/predictions`
   * `/tape?format=ndjson`
   * `/signals`
   * `/health`
2. **Your Kalshi fill history** (CSV). It would replace the print-based fill model with real fills.
3. **A forward test with small real orders.** It needs your explicit authorisation; nothing in this work places orders.

## Reproduce

Data (about 2 GB, not committed): `pipeline/run_pipeline.sh` (resumable). Then:

```
bash pipeline/replay_parallel.sh   ...                      # contract replays (see script header for feeds/configs)
python3 pipeline/decisive.py   --data DATA --out DATA/decisive.json
python3 pipeline/calibration.py --records DATA/replay/r281_usdc.ndjson ... --out DATA/calibration.json
python3 pipeline/anatomy.py    --records DATA/replay/r281_usdc.ndjson --out DATA/anatomy_r281_usdc.json
python3 pipeline/prevented.py  --records DATA/replay/r281_usdc.ndjson --exec-rows DATA/exec_r281_usdc_full_rows.ndjson --out DATA/prevented_r281_usdc.json
python3 pipeline/execution.py  --records ... --trace ... --trades DATA/kalshi/trades --out DATA/exec_r281_usdc_full.json
python3 pipeline/trading_eval.py --exec-rows DATA/exec_r281_usdc_full_rows.ndjson --markets DATA/kalshi/markets_clean.ndjson --trades DATA/kalshi/trades \
        --records DATA/replay/r281_usdc.ndjson --to 2026-07-22T00:00:00+00:00 [--latency 2] --out DATA/trading2_U2_L0.json
python3 pipeline/exit_eval.py ... ; python3 pipeline/final_tables.py --data DATA --out RESULTS_TABLES.md
bash ../2.8.1/test/run_all281.sh                              # software suite
```
