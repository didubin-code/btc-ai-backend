# The "0.2 % LOCKED with two minutes left" hypothesis: RECONSTRUCTED evidence

> **RECONSTRUCTED, not observed.** Every signal below comes from replaying **production's own Pin Radar 2.8 code** (`main:pinradar_server.js`, SHA-256 `0efd86c9…`) over **25,982 real Kalshi KXBTC15M contracts** (13 Jan – 15 Oct 2026).
> * The engine was driven by a **substitute 1 Hz Binance BTCUSDC feed**, not production's live feeds.
> * It made one decision per second, 750 ms into the second; production decides every 500 ms.
> * Outcomes are Kalshi's official results. Prices are Kalshi's public trade prints; Kalshi publishes no order-book history.
> * None of this is an observed production signal. The observer (`../README.md`) exists to replace it with observed signals and recorded order books once it runs.

Sources: `hypothesis_28.js` → `hypothesis_28_results.json`; `montecarlo_28.js`; and the independent re-implementation `independent_hypothesis_check.py` → `independent_hypothesis_results.json`. The replay is `pinradar-research/validation/replay_chrono.js`. Data provenance is in `pinradar-research/validation/DATA_PROVENANCE.md`.

## 1. Verdict

| Claim | Verdict | Evidence |
|---|---|---|
| LOCKED with ≤ 2 min left **and** reversal probability ≤ 0.2 % is **nearly 100 % accurate** | **Supported: 99.91 %** (not literally 100 %) | **21 wrong of 23,884** first qualifying signals at or after T−120: 99.91 %. Exact 95 % interval for the error rate: 0.054 %–0.134 %, so 100 % lies outside it. |
| About **98 %** of markets qualify | **Not supported** | **91.93 %** of markets qualify at some point in the last 120 s (23,884 of 25,982). 91.94 % ever qualify. |
| What the data do support | An error rate near **0.09 % (about 1 in 1,100)** | 22 wrong of 23,889 first qualifying signals. 14 of the 22 came with ≤ 30 s left. |

Exactly at T−120, 3,505 markets qualified and **none** was wrong. That is not "100 %": with 3,505 calls, an error rate up to 0.105 % is consistent with zero errors (exact 95 % bound).

## 2. Definitions (fixed before the results, not tuned)

* **LOCKED**: engine state `LOCKED` or `PROVEN LOCKED`. Production's own LOCKED threshold is a modelled flip risk ≤ 0.5 %.
* **Qualifying**: LOCKED **and** the displayed modelled flip risk `pFlip` ≤ 0.002 (the 0.2 % hypothesis).
* **First qualifying signal**: the first qualifying decision second of the window. Its side is the prediction; `won` means that side matches Kalshi's result.
* **At or after T−120**: the first qualifying second with ≤ 120 s left.
* **Continuous**: every decision second from the first qualifying one to the close is LOCKED on the same side.

## 3. Accuracy

| Set | n | Wrong | Accuracy | Exact 95 % CI of the error | One-sided 95 % upper bound |
|---|---|---|---|---|---|
| First qualifying signal | 23,889 | 22 | 99.91 % | 0.058 %–0.139 % | 0.132 % |
| First qualifying at or after T−120 | 23,884 | 21 | 99.91 % | 0.054 %–0.134 % | 0.127 % |
| Qualifying exactly at T−120 | 3,505 | 0 | 100 % | 0 %–0.105 % | 0.085 % |

* **Day-block bootstrap** (calls on one day are correlated): error rate 0.054 %–0.133 %, median 0.091 % (2,000 resamples of days).
* **Bayesian posteriors** for the first qualifying error rate (mean; 97.5th percentile):
  * uniform prior: 0.096 %; 0.139 %;
  * Jeffreys: 0.094 %; 0.137 %;
  * a prior centred on the model's own 0.2 % claim, Beta(2, 998): 0.096 %; 0.139 %;
  * a pessimistic prior centred on 1 %, Beta(10, 990): 0.129 %; 0.177 %.

Every method agrees: roughly 0.06 %–0.18 %, never zero.

## 4. By time of the first qualifying signal

| Seconds left at the first qualifying signal | n | Wrong | Accuracy | Exact 95 % CI of the error |
|---|---|---|---|---|
| 300–181 | 1,183 | 0 | 100 % | 0 %–0.311 % |
| 180–121 | 2,586 | 2 | 99.92 % | 0.009 %–0.279 % |
| 120–91 | 3,005 | 0 | 100 % | 0 %–0.123 % |
| 90–61 | 5,500 | 2 | 99.96 % | 0.004 %–0.131 % |
| 60–31 | 7,868 | 4 | 99.95 % | 0.014 %–0.130 % |
| 30–0 | 3,747 | 14 | 99.63 % | 0.204 %–0.626 % |

The last 30 s are clearly worse: 0.37 % against about 0.05 % earlier. A signal that first qualifies with ≤ 30 s left is a different, riskier event. The replay is also least faithful there, because the substitute feed matters most in the final seconds.

## 5. Behaviour after the first qualifying signal

* **Reach:**
  * LOCKED at some point: 92.39 %;
  * LOCKED at T−120: 23.05 %;
  * qualifying at T−120: 13.49 %;
  * first qualifying within the last 120 s: 77.44 %;
  * qualifying anywhere in the last 120 s: 91.93 %.
* **After the first qualifying signal** (23,889 calls):
  * stayed LOCKED on the same side every second to the close: 95.77 % (22,878);
  * unlocked, then re-locked or ended unlocked: 3.97 %;
  * reversal warning later: 0.26 % (63);
  * direction change while LOCKED: 0.
* **Categories:**
  * continuous and won: 22,869;
  * unlocked and won: 944;
  * warned and won: 54;
  * changed direction and won: 0;
  * wrong: 22.
* **The 22 wrong calls:**
  * 9 were continuous LOCKED to the close and still lost;
  * 9 were followed by a reversal warning;
  * 4 unlocked without a warning.
  * 13 settled within $5 of the strike, and 6 within $1. At that margin the substitute feed's error is comparable to the margin itself.

## 6. Is the modelled flip risk calibrated?

| Modelled `pFlip` at the first qualifying signal | n | Wrong | Mean modelled | Observed | Observed 95 % CI |
|---|---|---|---|---|---|
| 0–0.02 % | 102 | 1 | 0.006 % | 0.98 % | 0.02 %–5.34 % |
| 0.02–0.05 % | 104 | 1 | 0.036 % | 0.96 % | 0.02 %–5.24 % |
| 0.05–0.10 % | 415 | 1 | 0.079 % | 0.24 % | 0.01 %–1.34 % |
| 0.10–0.15 % | 1,702 | 3 | 0.131 % | 0.18 % | 0.04 %–0.51 % |
| 0.15–0.20 % | 21,566 | 16 | 0.186 % | 0.074 % | 0.042 %–0.121 % |

* In the 0.15–0.20 % band, which holds 90 % of the calls, the model is **conservative**: it predicts 0.186 % and 0.074 % is observed.
* At very low modelled risk the samples are tiny (one error in about 100 calls). The intervals are wide, but they do not support the model's claim that these readings are safer. **Do not treat a lower displayed `pFlip` as more reliable.**

## 7. Stability over time

| Month | n | Wrong | One-sided 95 % upper bound |
|---|---|---|---|
| Jan | 1,610 | 2 | 0.39 % |
| Feb | 2,392 | 2 | 0.26 % |
| Mar | 2,732 | 1 | 0.17 % |
| Apr | 2,624 | 7 | 0.50 % |
| May | 2,720 | 3 | 0.28 % |
| Jun | 2,609 | 0 | 0.11 % |
| Jul | 2,685 | 0 | 0.11 % |
| Aug | 2,561 | 3 | 0.30 % |
| Sep | 2,655 | 2 | 0.24 % |
| Oct (to the 15th) | 1,301 | 2 | 0.48 % |

* Errors occur in 8 of 10 months.
* April had 7, so regimes matter.
* By volatility bucket (0 = calmest), errors are spread across all seven buckets: 1, 2, 2, 4, 6, 2 and 5.

## 8. Prices and theoretical results (from trade prints)

* **Priced signals.** 14,403 of the 23,889 first qualifying signals had a **called-side trade print within 10 s before** the signal. Those are priced; the rest are not.
* **Called-side price:** 10th percentile 99.0 ¢, median 99.8 ¢, 90th percentile 99.9 ¢.
* **Theoretical $1,000 per signal**, filled at that print price with Kalshi's fee, no slippage, never executed:

| Price at the signal | n | Losses | Mean net per $1,000 |
|---|---|---|---|
| below 90 ¢ | 49 | 10 | +$2,517 (not credible, see below) |
| 90–95 ¢ | 66 | 2 | +$44.95 |
| 95–98 ¢ | 226 | 1 | +$27.91 |
| 98–99 ¢ | 567 | 0 | +$15.18 |
| 99–99.5 ¢ | 2,770 | 0 | +$8.58 |
| 99.5–100 ¢ | 10,725 | 3 | +$1.47 |

* **The common case is 99.5 ¢ or more** (74 % of priced signals). It earns **$1.47 per $1,000**, with 3 losses in 10,725.
  * At those prices, a single loss wipes out about 570 wins.
  * The break-even loss rate is 0.175 %, against 0.028 % observed.
* **The overall mean of +$12.55 per trade is misleading.** It is driven by 49 prints below 90 ¢, almost all in the final 30 s, at moments when the market disagreed with the call.
  * Buying $1,000 at those prints is not plausible.
  * Without them, the mean is about **+$4.00 per $1,000**.
* **Capacity.**
  * The median dollar amount of called-side contracts printed between the signal and the close is **$1,202**.
  * At least $10k printed in 19.6 % of windows, and at least $75k in **3.26 %**.
  * These are upper bounds on what one taker could have bought. Orders of $25k–$75k at these prices would mostly not have been fillable. The observer's recorded books will measure this properly.

## 9. The most defensible combination

* **Rule.** The expected value is "defensible" only with the loss rate set to its exact **one-sided 95 % upper bound**, not to the observed rate. Wins are taken at their observed average.
* **The 99.5 ¢+ bucket.** By this rule, almost every cell at 99.5 ¢ or more is **negative**. The price leaves too little margin to absorb an error rate that, at 95 % confidence, could be 0.15 %–0.8 %.
* **Cells with at least 30 priced signals and a positive conservative value:**

| Seconds left | Price | n | Losses | Observed mean per $1,000 | Conservative per $1,000 |
|---|---|---|---|---|---|
| 60–31 | 99–99.5 ¢ | 1,051 | 0 | +$8.72 | **+$5.85** |
| 30–0 | 99–99.5 ¢ | 632 | 0 | +$8.79 | +$4.02 |
| 30–0 | 98–99 ¢ | 245 | 0 | +$15.58 | +$3.24 |
| 90–61 | 99–99.5 ¢ | 473 | 0 | +$8.68 | +$2.31 |
| 60–31 | 98–99 ¢ | 214 | 0 | +$15.47 | +$1.35 |
| 30–0 | 90–98 ¢ | 180 | 2 | +$33.15 | +$8.53 |

**Best defensible combination: first qualifying with 60–31 s left, called side priced 99.0–99.5 ¢.** It gives about +$5.85 per $1,000 conservatively, with 1,051 cases and no loss.

The 30–0 s / 90–98 ¢ cell shows a higher figure but is not ranked first:
* it lies in the final 30 s, where the error rate is five times higher (§4) and the reconstruction is least faithful;
* its value rests on 2 losses in 180 cases;
* one more loss would remove most of it.

That figure needs four qualifications:
* the signals are reconstructed;
* the prices are prints, not executable books;
* more than 25 cells were examined, so the best one is optimistic by selection;
* typical capacity is about $1,000, not $50,000.

Treat it as the hypothesis for the observer to test **out of sample**, not as a result.

## 10. Monte Carlo: one month at $1,000 per signal

Model (`montecarlo_28.js`), 4,000 paths:
* Each price bucket has its own loss probability, drawn from its Beta posterior. Parameter uncertainty is therefore included.
* Trades per month follow the replay's frequency.
* A win pays the bucket's average win; a loss costs about $1,000.
* Fills are at the print price.

| Signals traded | Prior | Trades a month | Median month | 5th percentile | P(losing month) | Max drawdown, 95th percentile |
|---|---|---|---|---|---|---|
| 99.5 ¢ and above | Jeffreys | 1,117 | +$1,955 | −$49 | 6.2 % | $1,000 |
| 99.5 ¢ and above | pessimistic (1 %) | 1,117 | +$953 | −$1,050 | **33.5 %** | $2,505 |
| 90 ¢ and above | Jeffreys | 1,496 | +$5,651 | +$3,572 | 0 % | $1,609 |
| 90 ¢ and above | pessimistic (1 %) | 1,496 | +$4,543 | +$612 | 2.4 % | $2,680 |

The "all print prices" scenario is omitted: it is dominated by the non-credible prints below 90 ¢.

With the pessimistic prior, one month in three loses money in the 99.5 ¢+ bucket. That is the bucket where most signals fall. The edge there is thin and fragile.

## 11. Limitations

* **Reconstructed signals**, from a substitute feed. Production's live feeds differ, most of all in the last ~20 s, which is where most errors are.
* **Decision timing:** one per second in the replay, every 500 ms in production.
* **Prints are not order books.** A print shows that a price traded. It does not show that the price was available, or available in size.
* **Correlation:** calls on one day share a regime, so day-block intervals are given alongside binomial ones.
* **Selection:** the time × price grid was searched. The best cell is optimistic.

## 12. Independent check

`independent_hypothesis_check.py` was written separately, from written definitions only, without access to `hypothesis_28.js`. It reproduces every count above:
* reach rates;
* the 22 and 21 wrong calls;
* every interval table;
* every month;
* continuity, warning and direction-change counts;
* prices and capacity.

Its one disagreement, 14,403 against 14,275 priced signals, was traced to a timestamp-parsing bug in `hypothesis_28.js`. Prints without a full fractional second had been dropped. The bug is fixed, and the figures here are from the corrected run.

## 13. Reproduce

```
node research/hypothesis_28.js <data dir> > research/hypothesis_28_results.json
node research/montecarlo_28.js research/hypothesis_28_results.json
python3 -I research/independent_hypothesis_check.py
```

The data directory (replay outputs and Kalshi public data, about 6 GB) is not in the repository. `pinradar-research/validation/DATA_PROVENANCE.md` describes how it was fetched, with every response's URL and SHA-256.
