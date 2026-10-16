# BTC Pin Radar — historical validation, independent data and stress test: final report (2026-10-16)

## Verdict first

**H. Ready for real-money deployment?**

| Use | Verdict | Deciding evidence |
|---|---|---|
| **The intended trade: about $50,000 at about 99.9 ¢** | **NO** | See the four points below this table. |
| Small sizes (10–1,000 contracts), first LOCKED, 90 ¢ guard, 15 s buffer | **NOT YET VALIDATED** | See below. |
| As a forecast display (directional certainty) | usable, with documented limits; not a guarantee | See below. |

**Why NO at $50,000.**
1. **The pre-registered NO rule triggered.** On unseen data, 50,046 contracts at ≤ 99.9 ¢ were available in the 12 s after a T−20 entry in 1 of 15,772 entries with a Kalshi tape.
2. **The failure rate is too high where the size can be filled.** At the first LOCKED, where the size can sometimes be filled, the call is wrong 0.17 % of the time (28 of 16,773 unseen calls, 95 % CI 0.11–0.24 %), against a 0.093 % break-even.
3. **The recent large fills lost money at worst-fill prices.** Recent months have more volume: 201 first-LOCKED $50k fills in the partial Jul 22 – Oct 16 tapes. Those trades made +$15,900 at VWAP but **−$37,000 at worst-fill prices**, with 1 loss.
4. **The live record has a loss.** The deployed page lost its 84th forward LOCKED call (Oct 15 20:30 ET).

**Why small sizes are NOT YET VALIDATED.**
* **It looked positive on unseen data.** On 6 unseen months (Jan 13 – Jul 21) this rule beat a market-only rule by about +0.4 ¢ per contract under an optimistic fill model.
* **It fell with the page's own timing.** With the page's own 12 s order time it fell to **+0.24 ¢** (CI +0.15 to +0.32): about $1,800 in 6 months at 100 contracts.
* **The edge has decayed.** It fell from +1.1–1.2 ¢ in Jan–Feb to +0.2–0.3 ¢ in Apr–Aug, with +0.06 ¢ in the September tapes so far. On Jul 22 – Oct 16 it is not significantly better than the market-only ≥ 99.5 ¢ rule.
* **The rule was not pre-registered.** This strategy was defined after the pre-registration and is exploratory.
* **What the pre-registered rules say.** Applied at these sizes, they give NOT YET VALIDATED at 10–100 contracts and NO at 1,000 or more.
* Only a forward test with real small orders can decide.

**What the forecast display does and does not deliver.**
* **The design and the unseen record.** LOCKED is designed as "flip risk ≤ 0.5 %". On unseen data it was wrong 0.17 % of the time.
* **On another feed, recent months broke the design.** On a BTCUSDT feed, the recent (seen) months were wrong 0.58 % of the time, above its own 0.5 % design.
* **Failures are mostly real price reversals.** 19 of 28 unseen failures were the price itself moving back through the strike, and the market agreed with 13 of those calls.
* **The forward record is too small.** The page's own record is 1 wrong in 84 LOCKED calls (1.2 %, CI 0.03–6.5 %). It cannot estimate a rate near 0.1 %, and it is not reassuring.

**What the evidence is.** A backtest on a substitute price feed. Its intervals describe past data under stated assumptions: a stable market, and a replay feed that behaves like the live index. They do not bound future risk and do not guarantee future results.

**Evidence tags:**

| Tag | Meaning |
|---|---|
| [RUN] | Executed in this session on the data described in `DATA_PROVENANCE.md`; the result file is named. |
| [EXPLORATORY] | Defined, found or designed after looking at the decisive data, or not pre-registered. Hypothesis-generating, not validated. |
| [EARLIER WORK] | From earlier project work (review rounds, simulations); raw files not retained in this package, not re-run here. |
| [SIM] | A synthetic or simulated condition, not an observed rate. |
| [SCREEN] | Read from your photo. |

Generated tables: `RESULTS_TABLES.md` (`pipeline/final_tables.py`). Per-analysis result files are listed in "Reproduce".

---

## What was done

| Phase | What was executed |
|---|---|
| 1. Audit of logs and software | Both repositories were inventoried. The deployed server's logs (ledger, predictions, tape) are **not** available: no file holds them, and the server was not contacted (your Render services were not touched). The full 2.8.1 test suite was run: all checks pass (`2.8.1/TEST_RESULTS.md`). |
| 2. Independent data | Settled Kalshi KXBTC15M contracts with official settlement values: **25,994 contracts, 2026-01-13 → 2026-10-16** (9 months; earlier contracts publish no values). Kalshi trade prints for each window's last 300 s: complete for Jan 13 – Jul 21, partial afterwards (see section E). Binance 1 s BTC prices 2023-10-01 → 2026-10-15 (checksums verified). Coinbase trades (Sep 15 – Oct 16) and Kraken trades (93 days) for cross-checks. `DATA_PROVENANCE.md`. |
| 3–4. Hypothesis and reliability | The current engine was replayed second by second over **25,982 of the 25,994 contracts**; the 12 closing after the Binance archive ends are not covered (section E). It ran in month chunks with a 24 h warm-up each, on the Binance BTCUSDC feed (primary) and BTCUSDT. That is about 300 decisions per window and 7.8 million per run, with no use of outcomes before each window ends. Separately, a 27-month proxy study (80,159 windows) and two-venue Coinbase + Kraken replays of Oct 14–16. |
| 5. Profitability | Break-even; executable volume and P&L at 10–50,046 contracts from Kalshi's real prints; VWAP and worst-fill; latency 0 / 2 / 5 / 12 s; fee included; day-block bootstrap. |
| 6. Break the software | 2.8.1 test suite (fault injection, restart, stale data, fuzz) [EARLIER WORK for the review rounds]; on real data: feed, latency and timing sensitivity, calibration, failure anatomy; an independent check of this report (corrections listed at the end). |
| 7. Improve and retest | ADAPTIVE_BASIS (replayed); a 0.2 % LOCKED threshold (replayed); a volatility-jump filter (tested out of sample); MARKET_VETO (assessed from prints). |

**Splits (pre-registered):**

| Split | Period (UTC closes) | Status |
|---|---|---|
| **U2** | 2026-01-13 → 07-21 | unseen, decisive: 17,841 windows, all with Kalshi tapes |
| **U1** | 2026-10-14 → 10-16 00:00 | unseen, decisive: **185 of the 197 U1 contracts**. The 12 closing Oct 16 00:15–03:00, which include the Oct 15 20:30 ET live loss, are beyond the Binance archive and are not scored. No Kalshi tapes yet. |
| **Seen** | 2026-07-22 → 10-13 | used while building 2.6–2.8: reported, not decisive (7,956 windows) |
| **P (proxy)** | 2023-10-01 → 2026-01-13 | Binance prices only; outcomes defined by the proxy itself; never pooled with contract results |

U2 lies *before* the period the probability tables were fitted on. It is out-of-sample, but backward in time. The only forward holdout, U1, is far too small to bound a rate near 0.1 %: 0 of 170 wrong, upper bound 2.15 %.

---

## A. Does the underlying hypothesis hold?

**Partly.**
* **What works.** Distance, σ-cushion, time left, volatility and settlement-average mathematics do identify moments when one outcome is very likely, and the engine's probabilities are honest or conservative over most of the window.
* **What does not.** They do not bring the failure rate at the moment LOCKED first appears below the 0.093 % that a $50,000-for-$47 trade needs.
* **Late in the window, the volume is gone.** Where the rate is low enough (LOCKED at T−60 or later), there is almost nothing left to buy at ≤ 99.9 ¢. At T−20, no contract of the called side was bought at ≤ 99.9 ¢ in the next 12 s in 82.7 % of unseen entries.

**Reliability at each moment** [RUN, `decisive.json`, `supplement.json`]. Primary engine 2.8.1, BTCUSDC feed, unseen U:

| State at that second | Wrong / LOCKED | Rate | 95 % CI, or one-sided upper bound | Day-block bootstrap | vs 0.093 % break-even |
|---|---|---|---|---|---|
| First LOCKED second | 28 / 16,773 | 0.167 % | 0.111–0.241 % | 0.107–0.241 % | **above** |
| LOCKED at T−60 | 3 / 10,376 | 0.029 % | ≤ 0.075 % | — | below |
| LOCKED at T−30 | 2 / 14,842 | 0.013 % | ≤ 0.042 % | — | below |
| **LOCKED at T−20** (pre-registered entry) | **2 / 15,936** | 0.013 % | **≤ 0.040 %** | ≤ 0.031 % | below |
| LOCKED at T−15 | 3 / 16,276 | 0.018 % | ≤ 0.048 % | — | below |
| LOCKED at T−10 | 4 / 16,479 | 0.024 % | ≤ 0.056 % | — | below |
| LOCKED at T−5 | 8 / 16,536 | 0.048 % | ≤ 0.087 % | — | borderline |

* "LOCKED at T−x" is the state at that second, including calls first made then. For example, 176 of the 15,936 at T−20 were first LOCKED at T−20, and one of the two T−20 failures was such a fresh call.
* The cells overlap, because the same windows appear at several times.
* Treating each day as a block (correlated windows) gives similar intervals, so the conclusions do not rest on independence.
* **Feed dependence.** On the BTCUSDT feed, T−20 on U is 5 / 16,035 (bound 0.066 %). On the seen period it is 7 / 6,865 (bound 0.19 %, **above** break-even).
* **The 27-month proxy** [RUN]: first LOCKED 188 / 74,811 (0.251 %, CI 0.217–0.290 %); T−20 3 / 71,414; T−10 0 / 73,487.

**Which observables at the first LOCKED predict a failure?** [RUN, `anatomy_r281_usdc.json`, `supplement.json`; unseen U]

| Variable | Result |
|---|---|
| σ-cushion | **The strongest separator.** Below 3σ: 0.50 % (11 / 2,199). At 3σ and above: 0.117 % (17 / 14,574); Fisher p = 0.0005. Even ≥ 3σ is above break-even; only the 4σ-and-above group (0.08 %, 5 / 6,454) is near it. |
| Required move to flip | Falls steadily: under $20, 0.44 % (3 / 680); $20–50, 0.29 %; $50–100, 0.14 %; $100–200, 0.10 %; $200 and above, 0.15 %. No band is below break-even. |
| Time left at the call | Under 15 s: 2.49 % (9 / 362); 15–30 s: 0.35 %; 30–120 s: 0.07 %; 120–300 s: 0.14 %. |
| Direction | DOWN 20 / 8,421 against UP 8 / 8,352 (p = 0.036). At T−20 there is no difference: 1 / 8,001 against 1 / 7,935. [EXPLORATORY; see B for where the DOWN excess comes from.] |
| Adverse momentum at the call (engine's ratio ≥ 1) | 1 / 438 against 27 / 16,335 (p = 0.52). All periods: 3 / 686 against 44 / 23,317 (p = 0.15). **No significant association.** The test has little power, so a 2–7× higher rate cannot be excluded. |
| Prior extreme adverse move (largest move against the call in the last 60 s, in σ units) | No association. ≥ 1.5σ: 0 / 247. |
| Volatility level, raw σ bands | 0.10–0.30 % in every band. |
| Volatility level, engine regime buckets | 0.05–0.55 %, highest in the calmest bucket (3 / 543). Not significant; small samples. |
| **Changing volatility** (last 60 s vs the 240 s before, ratio ≥ 2) | On U: 5 / 630 (0.79 %) against 23 / 16,143 (0.14 %), p = 0.004. [EXPLORATORY]: found on U, then tested unchanged on data it was not found on. **It did not replicate**: seen 0 / 463 against 19 / 6,766 (p = 0.63); 27-month proxy 7 / 3,295 (0.21 %) against 181 / 71,516 (0.25 %), p = 0.86. It is a chance finding and not adopted (`volchange_*.json`). |
| Calibration | Early in the window the engine is conservative. On the proxy, observed / predicted failures were 0.6–0.9× at T−120 … T−60. On contracts (U) they were 0.1–0.5× at T−120 … T−30. In the last seconds it is over-confident; see B. |
| Near-threshold calls | HIGH CONFIDENCE calls with predicted flip 0.5–2 % (mean 1.05 %) at T−120 / T−90 / T−60 failed 0.29 % / 0.21 % / 0.29 % of the time. That is far below prediction, but about the same as first-LOCKED calls and above break-even. |

**What this means.** The LOCKED threshold is honestly calibrated to "≤ 0.5 %", five times looser than your trade needs.
* Loosening it would add small-size opportunities at roughly the current first-LOCKED failure rate.
* Tightening it (section G) lowers the rate toward break-even, but not below it.
* No single observable at the call isolates the remaining failures.

## B. Can the newest Pin Radar be relied on for sufficiently accurate LOCKED signals?

**As a forecast: usable, with the limits below. As a trigger for $50,000 trades: no.**

| Item | Value [RUN] |
|---|---|
| First LOCKED wrong, all replayed periods | 47 / 24,003 = 0.196 % (CI 0.144–0.260 %) |
| Unseen vs seen | 0.167 % vs 0.263 % (p = 0.15) |
| Same split on BTCUSDT | 0.273 % unseen vs **0.580 %** seen (p = 0.0007) |
| Deployed 2.8 vs 2.8.1 | The same 47 wrong calls. Decisions differ in only 10 windows, all in the first 3 h of the replay while the basis model is cold. There, 2.8.1's cold-start envelope delays LOCKED by 1–32 s and once withholds it. The warm probability model is unchanged. |
| REVERSAL WARNING after a LOCKED call (unseen) | on 18 of 28 wrong calls (16 with ≥ 15 s left); on 155 of 16,745 correct calls (0.9 %). All periods: 34 / 47 and 211 / 23,956. |
| Never LOCKED (all periods) | 1,979 of 25,982. By official margin: 1,018 under $5 and 640 of $5–20 (toss-ups); 30 of $20–100; 291 of $100 or more (section D). |
| DATA UNRELIABLE windows | 0 in the replays. The feeds have no gaps, so this is not a test of live data faults. |

**First-LOCKED failure rate by month, contracts** [RUN, `summary_r281_usdc.json`, `summary_r281_usdt.json`]:

| Month | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct (partial) |
|---|---|---|---|---|---|---|---|---|---|---|
| BTCUSDC | 0.25 % | 0.17 % | 0.04 % | 0.34 % | 0.26 % | 0.11 % | 0.04 % | 0.27 % | 0.34 % | 0.15 % |
| BTCUSDT | 0.68 % | 0.25 % | 0.07 % | 0.30 % | 0.29 % | 0.38 % | 0.07 % | 0.62 % | 0.71 % | 0.46 % |

* **Generalisation.** There is no sign of overfitting: the unseen rate is not higher than the development rate.
* But the most recent full months (Aug–Sep) are among the worst on both feeds. The rate may be drifting upward, so a forward period may be worse than the unseen backtest.
* Earlier project work also found the calibration non-stationary [EARLIER WORK].

**Two failure classes, classified by what the replay feed itself showed** [RUN, `supplement.json` §1]. For each wrong first-LOCKED call, the question is whether the feed's own 60-s settlement average also ended on the other side of the strike.

1. **Real price reversals: 19 of 28 unseen failures** (34 of 47 overall).
   * The price itself moved back through the strike after the call.
   * 16 of the 19 are DOWN calls; this is where the DOWN excess lives.
   * **13 of them passed both safeguards with the market agreeing**: the called side last traded at 97.8–99.8 ¢, they were called 26–288 s before the close, and they settled $2.48–$244 on the other side.
   * These 13 are **0.078 % of all unseen first-LOCKED calls**. That is the irreducible rate at the first LOCKED, and it alone is close to break-even.
   * The proxy shows no direction asymmetry over 2023–2026 (94 / 37,014 against 94 / 37,797). The DOWN excess is therefore more likely a feature of the 2026 market than of the method. **Cause undetermined** [EXPLORATORY].
2. **Basis-decided: 9 of 28.** The feed showed the called side winning, and only the official BRTI average ended on the other side. 8 of the 9 were called in the last 30 s.

**Calibration in the last seconds** [RUN, `calibration.json`]:

| Feed | T−20 | T−15 | T−10 | T−5 |
|---|---|---|---|---|
| BTCUSDC, U | 0.9× | 2.3× (CI 0.5–6.6) | **6.3× (CI 1.7–16)** | **46×** |
| BTCUSDT, all periods | **3.8× (CI 2.0–6.7)** | 12× | 29× | 122× |

* The cells are observed / predicted failures among LOCKED-region calls.
* So *how late* the engine stays reliable depends on the feed.
* The live server uses its own three-venue index and, in the final minute, the official BRTI panel. Neither could be replayed: the live BRTI needs an authenticated stream, and the three-venue index was approximated only for Oct 14–16.
* **Live behaviour in the last 20 s is untested, in either direction.**

**Feed tracking** (one-step error of the server's basis predictor against Kalshi's official value) [RUN, `basis_all.json`]:

| Feed | Error sd | Errors over $10 | Period |
|---|---|---|---|
| BTCUSDC | $4.93 | 2.8 % | Jan 13 – Oct 15 |
| BTCUSDT | $6.30 | 7.7 % | Jan 13 – Oct 15 |
| Coinbase | $4.00 | 1.4 % | Sep 15 – Oct 4 |
| Kraken | $9.03 | 23.9 % | partial days |

## C. How many historical failures would the new software have prevented?

**Counts [RUN, `prevented_r281_usdc.json`, `supplement.json` §8].** These assume an entry at the first LOCKED second, with the guard approximated by the last traded price; the live guard reads the ask. They cover the 28 unseen wrong first-LOCKED calls, all with a Kalshi tape.

| Safeguard (version) | Wrong calls kept out | Correct calls also kept out | Value of the blocked trades at 100 contracts (all periods) |
|---|---|---|---|
| 15 s buffer: no TRADE NOW with < 15 s left (2.8.1) | 9 of 28 | 353 | 235 trades, 1 lost, +$62 |
| 90 ¢ market-disagreement guard (2.8 and 2.8.1) | 12 of 28 at the first second; **10 of 28** if the trader keeps watching | 114 | 119 trades, 14 lost, **+$524** (+4.4 ¢ each: cheap asks) |
| Either | **11 of 28** | 449 | — |
| **Not prevented** | **17 of 28** | — | — |
| Entry only if LOCKED on the same side at T−20 | 26 of 28 | 811 | far fewer fills (section F) |

* The guard is re-checked every second. For 2 of the 12 wrong calls it blocked at the first second, the call stayed LOCKED and the price later rose above 90 ¢ with fills available, so the guard only **delayed** the entry. Those are KXBTC15M-26JAN171615-15 (at T−30, 94 ¢) and -26FEB272330-30 (at T−47, 98 ¢).
* **The 15 unseen calls that neither safeguard blocks at the first second** (side, seconds left, settlement margin, called-side price):

  | Ticker (KXBTC15M-26…) | Side | Seconds left | Margin | Price |
  |---|---|---|---|---|
  | JAN171245 | DOWN | 26 | +$2.48 | 99 ¢ |
  | JAN301130 | DOWN | 288 | +$93.57 | 98 ¢ |
  | FEB131715 | UP | 175 | −$22.80 | 99 ¢ |
  | FEB271330 | DOWN | 116 | +$6.30 | 99 ¢ |
  | FEB280845 | DOWN | 90 | +$5.64 | 99 ¢ |
  | APR172245 | UP | 63 | −$5.74 | 99.4 ¢ |
  | APR220400 | UP | 18 | −$1.57 | 94 ¢ |
  | APR241145 | DOWN | 41 | +$4.49 | 99 ¢ |
  | MAY030345 | UP | 26 | −$1.50 | 98.8 ¢ |
  | MAY141300 | DOWN | 224 | +$244.41 | 97.8 ¢ |
  | MAY221330 | DOWN | 141 | +$35.47 | 99.8 ¢ |
  | MAY281015 | DOWN | 200 | +$219.77 | 99.8 ¢ |
  | JUN050645 | DOWN | 121 | +$35.15 | 99.7 ¢ |
  | JUN070115 | DOWN | 97 | +$10.29 | 99.8 ¢ |
  | JUN181330 | DOWN | 150 | +$53.15 | 99.5 ¢ |

* **All periods.** Of 47 wrong calls, 16 are blocked by the buffer or the guard and 16 are not. **15 are undetermined**: seen period, no tape yet.
* **Not prevented by any 2.8.1 change: the LOCKED display itself.** 2.8 and 2.8.1 show the same 47 wrong calls.
* **The Oct 15 20:30 ET loss** (`INCIDENT_OCT15_2030ET.md`; not among the counts above, because it closes after the replay data end).
  * DOWN traded at 79 ¢ when LOCKED DOWN appeared, so the 90 ¢ guard would almost certainly have refused TRADE NOW. Only trades are available, not the ask.
  * That guard was already in the deployed 2.8. **2.8.1 adds nothing for this window.** It shows the same LOCKED DOWN.
  * Whether TRADE NOW appeared cannot be known without the server's logs.
* **2.8.1's operational fixes** concern failures a replay cannot contain (`2.8.1/TEST_RESULTS.md`):
  * Restart errors and the sampler-phase DATA UNRELIABLE alarms are shown by tests that compare 2.8 with 2.8.1.
    * In the sampler test, 2.8 is DATA UNRELIABLE in more than half of final-minute decisions at the affected phase, and 2.8.1 in none [SIM].
    * Earlier work measured up to 94 % at that phase [EARLIER WORK, SIM].
    * The restart test uses the same 58 windows the cold-start band was set from, so it is in-sample.
  * The stale-book and empty-book behaviours are tested on 2.8.1 only. Those tests show correct behaviour, not a 2.8 failure.

## D. Missed opportunities

* **Never LOCKED, with an official margin of $100 or more: 291 windows (1.1 %).**
  * In **all 291**, the volatility estimate (1.77–6.64 bps/√s) was above the range the tables were validated on (up to 1.767), so the soft gate held the call at HIGH CONFIDENCE. This was checked by replaying each window with the gate reasons recorded.
  * 148 of the 291 are from February 2026.
  * **Value** [RUN, `missed_value.py`, `supplement.json` §11]: buy the side the engine leaned to at T−60, with the same fill rule.
    * 262 of the 291 windows have a tape, and the leaned side won in 261.
    * With the 90 ¢ guard, 47 could fill 100 contracts, worth **$43 over 9 months** at that size. Without the guard it was 56 fills and $106.
    * Recovering them would mean extrapolating the tables beyond their tested range. It is not done: it would weaken a risk control for almost no value.
* **Never LOCKED, margin $20–100: 30 windows.** At T−20, 23 of them were HIGH CONFIDENCE on the correct side.
* **Never LOCKED, margin under $20: 1,658 windows.** Genuine toss-ups.
* **Calls that came late or stayed at HIGH CONFIDENCE.** HIGH CONFIDENCE calls with predicted flip 0.5–2 % failed only 0.21–0.29 % of the time (section A). The threshold is conservative there. But those calls are no safer than first-LOCKED calls, so they would add small-size trades at about the same risk.
* **Trades missed for lack of a price, not a signal** (U2, T−20 entries with a tape):
  * Before the guard: 15,772 entries. The median volume in the next 12 s was 0 contracts, the 90th percentile 751, and there was no volume at all in 82.7 %.
  * After the 90 ¢ guard: 15,710 entries, 90th percentile 731.
  * Only 2,305 could fill 100 contracts.
* **The page's TRADE NOW edge rule** (cautious value − price − fee ≥ 0.5 ¢) is shown in the trading tables. In the simulation, the rule is evaluated at the **realised 12-s VWAP fill price**, which a live page cannot know at the decision. So it is an approximation with a look-ahead, and its results are optimistic.
  * On U2: 392 trades at 100 contracts, 4 lost (1.0 %), +1.97 ¢ (CI +1.21 to +2.58).
  * That loss rate is about **12×** the 0.085 % of all first-LOCKED trades filled at 100 contracts: cheap prices are themselves a warning.
  * It is fragile. With 5 s latency it made +1.23 ¢ (CI −0.40 to +2.58) and lost 6 of 246. With the page's 12 s order time it made +0.81 ¢ (CI −1.51 to +3.00) and lost 7 of 194. On Jul 22 – Oct 16 it made −0.03 ¢ (2 of 51 lost).

## E. At least one year of independently sourced data

* **The one-year requirement is only partly met.**
  * Kalshi publishes KXBTC15M settlement values only from 2026-01-13, so contract-level evidence (outcomes, BRTI basis, execution) covers **9 months: 25,994 contracts**.
  * 18,038 of them are unseen, and 18,026 of those were replayed.
  * The 27.4-month Binance proxy (2023-10-01 → 2026-01-13, 80,159 windows, checksums verified) extends the price-path test. It has self-defined outcomes and tests neither settlement nor execution.
  * Coinbase (32 days) and Kraken (93 days: Jan 13 – Apr 7, Sep 14–18, Oct 14–16) were fetched for cross-checks only. Bitstamp, a live index venue, was not fetched.
* **Excluded markets: 2,880, each listed with its reason.**
  * 2,806 closed before the first usable contract (2026-01-13 23:00) and publish no strike or official value.
  * 72 within the period lack one field: 65 in U2 and 7 seen.
  * 2 have corrupted strikes.
  * Nothing was imputed.
* **Proxy results by month:** the first-LOCKED failure rate ranged **0.04–0.48 %** over 28 months. 24 of the 28 months were above the 0.093 % break-even.
* **Method.** Chronological replay of the actual server build:
  * one 1 Hz price per second;
  * a decision 0.75 s into each second, with a 50 ms quote age;
  * official values reach the basis model 5 s after each close;
  * month chunks with a 24 h warm-up each;
  * outcomes are Kalshi's `result`;
  * execution is scored from Kalshi's prints.
  * **Timing caveat.** Each second's price is that second's closing price, known only at the end of the second. It is used for the decision 0.75 s into the second, so inputs lead real time by up to 0.25 s. A test shifting the feed by 0.9 s changed T−20 failures from 2 to 4 (Phase 6) [EARLIER WORK].
  * The 5 s settlement delay is an assumption. Production's timing is not documented here.
* **Tapes.** Complete for U2. For Jul 22 – Oct 16, 3,275 of 8,153 markets had a tape when the trading tables were built. Coverage was uneven: all of late July, roughly half of August, a small part of September, and none of October, so U1 has none. Seen-period trading results may therefore be biased by month. The download is still running.
* **Provenance.** Every HTTP response is logged with URL, status, size, SHA-256 and time (`PROVENANCE*.ndjson`).

## F. Would the strategy have been profitable at the intended amounts?

**1. The arithmetic of the intended trade** (`economics.js`; Kalshi taker fee `ceil(0.07 × C × P × (1−P))`):

| Price | Contracts for $50k | Win | Loss | Break-even failure rate |
|---|---|---|---|---|
| 99.9 ¢ | 50,046 | +$46.55 | −$49,999 | 0.093 % |
| 99.8 ¢ | 50,093 | +$93.19 | −$50,000 | 0.186 % |
| 99.0 ¢ | 50,469 | +$469.71 | −$49,999 | 0.93 % |

**2. Settlement accuracy alone (no execution).**
* At the first LOCKED: 0.167 % wrong against 0.093 %, so negative EV: about **−$37 per $50k trade** at 99.9 ¢.
* LOCKED at T−20: 0.013 % wrong, bound 0.040 %, so positive in theory.

**3. The pre-registered verdict rules** [RUN, `decisive.json`, `supplement.json` §9; E20 = LOCKED at T−20; volume from U2 tapes]:

| Price | Contracts | Break-even | E20 entries with that volume within 12 s | YES-1 | YES-2 | NO-b (< 10 %) | Verdict |
|---|---|---|---|---|---|---|---|
| 99.9 ¢ | 10 | 0.093 % | 16.618 % | pass | fail | — | **NOT YET VALIDATED** |
| 99.9 ¢ | 100 | 0.093 % | 14.830 % | pass | fail | — | **NOT YET VALIDATED** |
| 99.9 ¢ | 1,000 | 0.093 % | 8.845 % | pass | fail | triggers | **NO** |
| 99.9 ¢ | 10,000 | 0.093 % | 1.122 % | pass | fail | triggers | **NO** |
| 99.9 ¢ | 50,046 | 0.093 % | 0.006 % | pass | fail | triggers | **NO** |
| 99.8 ¢ | 10 | 0.186 % | 9.048 % | pass | fail | triggers | **NO** |
| 99.8 ¢ | 100 | 0.186 % | 7.868 % | pass | fail | triggers | **NO** |
| 99.8 ¢ | 1,000 | 0.186 % | 3.937 % | pass | fail | triggers | **NO** |
| 99.8 ¢ | 10,000 | 0.186 % | 0.355 % | pass | fail | triggers | **NO** |
| 99.8 ¢ | 50,046 | 0.186 % | 0.000 % | pass | fail | triggers | **NO** |
| 99.0 ¢ | 10 | 0.930 % | 3.411 % | pass | fail | triggers | **NO** |
| 99.0 ¢ | 100 | 0.930 % | 2.853 % | pass | fail | triggers | **NO** |
| 99.0 ¢ | 1,000 | 0.930 % | 1.236 % | pass | fail | triggers | **NO** |
| 99.0 ¢ | 10,000 | 0.930 % | 0.120 % | pass | fail | triggers | **NO** |
| 99.0 ¢ | 50,046 | 0.930 % | 0.000 % | pass | fail | triggers | **NO** |

E20 entries with a tape: 15,772 (U2; U1 has no tapes).

* YES-1 passes everywhere: the E20 bound is 0.040 %.
* YES-3 fails everywhere. KXBTC15M-26JAN171615-15 was LOCKED UP at T−20 while UP last traded at 93 ¢, so the guard passes, and it settled $3.43 below the strike.
* **Verdict for the intended trade: NO.** No size or price reaches YES.

**4. Real execution at $50,000** [RUN, `trading2_U2_L0.json`, `trading2_seen_L0.json`]:

| Entry | Period | Entries that could fill 50,046 contracts | Lost | Result |
|---|---|---|---|---|
| LOCKED at T−20 | U2 | 1 of 15,710 | 0 | +$47 |
| LOCKED at T−20 | Jul 22 – Oct 16 (partial tapes) | 16 of 2,703 | 0 | +$3,486 VWAP, +$1,024 at worst fill |
| First LOCKED | U2 | 7 of 16,477 | 0 | +$2,278 VWAP |
| First LOCKED | Jul 22 – Oct 16 (partial tapes) | **201 of 2,840** | **1** | +$15,908 VWAP; **−$37,011 at worst fill** |

* Capacity has grown in recent months.
* **Where the size could be filled (first LOCKED), it did not make money robustly, and it carries the 0.17 % failure rate.**

**5. Small sizes, unseen U2 (Jan 13 – Jul 21)** [EXPLORATORY strategy definitions; U2 data]. VWAP fill, 95 % day-block CI, no latency, 90 ¢ guard, no time buffer:

| Strategy | Contracts | Trades | Lost | ¢ / contract (95 % CI) | at worst fill | Total |
|---|---|---|---|---|---|---|
| model: first LOCKED (90 ¢ guard) | 10 | 11,518 | 12 | +0.33 (+0.27 to +0.40) | +0.17 | $383 |
| model: first LOCKED (90 ¢ guard) | 100 | 10,586 | 9 | +0.41 (+0.35 to +0.47) | +0.25 | $4,341 |
| model: first LOCKED (90 ¢ guard) | 1,000 | 7,138 | 7 | +0.37 (+0.31 to +0.44) | +0.18 | $26,633 |
| model: first LOCKED (90 ¢ guard) | 10,000 | 873 | 1 | +0.46 (+0.24 to +0.64) | +0.08 | $40,188 |
| model: first LOCKED + page edge rule † | 10 | 404 | 4 | +2.06 (+1.31 to +2.70) | +1.50 | $83 |
| model: first LOCKED + page edge rule † | 100 | 392 | 4 | +1.97 (+1.21 to +2.58) | +1.15 | $772 |
| model: first LOCKED + page edge rule † | 1,000 | 249 | 4 | +1.74 (+0.48 to +2.70) | +0.10 | $4,342 |
| model: first LOCKED + page edge rule † | 10,000 | 60 | 1 | +2.33 (-0.80 to +4.48) | +2.61 | $14,004 |
| model: LOCKED at T−30 | 10 | 2,756 | 2 | +0.19 (+0.06 to +0.30) | +0.06 | $52 |
| model: LOCKED at T−30 | 100 | 2,459 | 2 | +0.25 (+0.11 to +0.37) | +0.12 | $608 |
| model: LOCKED at T−30 | 1,000 | 1,490 | 1 | +0.20 (+0.04 to +0.30) | +0.09 | $2,980 |
| model: LOCKED at T−30 | 10,000 | 151 | 0 | +0.32 (+0.22 to +0.45) | +0.14 | $4,896 |
| model: LOCKED at T−20 | 10 | 2,582 | 1 | +0.24 (+0.13 to +0.35) | +0.13 | $62 |
| model: LOCKED at T−20 | 100 | 2,305 | 1 | +0.29 (+0.18 to +0.40) | +0.18 | $673 |
| model: LOCKED at T−20 | 1,000 | 1,380 | 0 | +0.27 (+0.24 to +0.30) | +0.14 | $3,677 |
| model: LOCKED at T−20 | 10,000 | 172 | 0 | +0.39 (+0.31 to +0.47) | +0.11 | $6,687 |
| model: LOCKED at T−15 | 10 | 2,257 | 1 | +0.21 (+0.11 to +0.31) | +0.11 | $48 |
| model: LOCKED at T−15 | 100 | 2,006 | 1 | +0.25 (+0.13 to +0.33) | +0.14 | $503 |
| model: LOCKED at T−15 | 1,000 | 1,185 | 0 | +0.27 (+0.24 to +0.31) | +0.14 | $3,234 |
| model: LOCKED at T−15 | 10,000 | 174 | 0 | +0.38 (+0.29 to +0.49) | +0.11 | $6,684 |
| market only: side first trades ≥ 99 ¢ | 10 | 16,819 | 209 | -0.00 (-0.16 to +0.15) | -0.49 | $-6 |
| market only: side first trades ≥ 99 ¢ | 100 | 16,025 | 195 | +0.05 (-0.10 to +0.20) | -0.44 | $756 |
| market only: side first trades ≥ 99 ¢ | 1,000 | 12,357 | 152 | -0.02 (-0.21 to +0.16) | -0.54 | $-2,424 |
| market only: side first trades ≥ 99 ¢ | 10,000 | 2,248 | 37 | -0.07 (-0.58 to +0.37) | -1.01 | $-16,661 |
| market only: side first trades ≥ 99.5 ¢ | 10 | 10,968 | 59 | -0.04 (-0.16 to +0.09) | -0.32 | $-39 |
| market only: side first trades ≥ 99.5 ¢ | 100 | 10,158 | 58 | -0.00 (-0.13 to +0.13) | -0.29 | $-3 |
| market only: side first trades ≥ 99.5 ¢ | 1,000 | 7,227 | 47 | -0.05 (-0.21 to +0.11) | -0.40 | $-3,709 |
| market only: side first trades ≥ 99.5 ¢ | 10,000 | 888 | 14 | -0.54 (-1.34 to +0.06) | -1.41 | $-47,893 |

† the edge test is applied at the realised 12-s VWAP (look-ahead; section D).

Paired difference on the same days (model − market-only), ¢ per contract:

| Comparison | C = 100 | C = 1,000 |
|---|---|---|
| model:first − market:99 | +0.36 (+0.21 to +0.53) | +0.39 (+0.21 to +0.59) |
| model:first − market:99.5 | +0.41 (+0.28 to +0.54) | +0.42 (+0.27 to +0.60) |
| model:T20 − market:99 | +0.24 (+0.05 to +0.45) | +0.29 (+0.11 to +0.47) |
| model:T20 − market:99.5 | +0.29 (+0.12 to +0.46) | +0.32 (+0.17 to +0.49) |

Markets in U2: 17,841, all with a Kalshi tape. Fill parity with `execution.py`: 62,882 rows, 0 mismatches.

**How optimistic the fill model is.** An order of C contracts is assumed to fill completely, at the average price of the called-side prints in the 12 s after the signal, whenever at least C contracts printed. Otherwise it is skipped; partial fills are not modelled, and order-book depth is unknown because Kalshi publishes no book history.
* **Losses are booked at collapsed prices.** On losing trades this books prints made after the market had already turned. At 1,000 contracts, 4 of the 7 U2 losses were booked at 35–82 ¢ although the called side traded at 94–99.4 ¢ at entry. The mean loss was $791 instead of about $1,000.
* **It assumes a large share of the volume.** At 1,000 contracts it assumes you obtain a median 31 % of all contracts other takers bought in those 12 s, and more than half in 28.5 % of trades.
* **Treat VWAP totals as upper bounds;** the worst-fill column is the more conservative reading.
* For the edge rule, the worst-fill figures cover only the trades that still pass the rule at the worse price (153 / 125 / 54 / 5 trades). They are not comparable with the VWAP column.

**6. Sensitivity** (first LOCKED, U2, 100 contracts) [RUN]:

| Setting | model: first LOCKED | market only ≥ 99.5 ¢ |
|---|---|---|
| No latency, no time buffer (table above) | +0.41 ¢ (CI +0.35 to +0.47), 10,586 trades, 9 lost, $4,341 | -0.00 ¢ |
| Worst print instead of VWAP | +0.25 ¢ | -0.29 ¢ |
| + 0.1 ¢ slippage | +0.32 ¢ | -0.09 ¢ |
| Latency 2 s | +0.37 ¢ (CI +0.31 to +0.43), 10,113 trades, 9 lost, $3,750 | -0.00 ¢ |
| Latency 5 s | +0.28 ¢ (CI +0.21 to +0.35), 9,426 trades, 13 lost, $2,669 | -0.00 ¢ |
| 15 s buffer (2.8.1 TRADE NOW rule) | +0.41 ¢ (CI +0.35 to +0.47), 10,399 trades, 8 lost, $4,296 | -0.00 ¢ |
| **15 s buffer + the page's 12 s order time** | **+0.24 ¢ (CI +0.15 to +0.32), 7,684 trades, 12 lost, $1,816** | +0.02 ¢ |
| same, 1,000 contracts | +0.21 ¢ (CI +0.12 to +0.31), 4,818 trades, 8 lost, $10,315 | — |
| same, paired vs market ≥ 99.5 ¢ | +0.22 ¢ (CI +0.08 to +0.35) | — |

**7. Over time, and the recent period** [RUN, `trading2_full_L0.json`, `trading2_seen_L0.json`]:

| Month | model: first LOCKED | model: T−20 | market only ≥ 99 ¢ | market only ≥ 99.5 ¢ |
|---|---|---|---|---|
| 2026-01 | +1.24 ¢ (372, 0 lost) | +0.97 ¢ (81, 1 lost) | +0.31 ¢ (909, 17 lost) | — |
| 2026-02 | +1.07 ¢ (970, 1 lost) | +1.63 ¢ (91, 0 lost) | -0.06 ¢ (2,219, 35 lost) | — |
| 2026-03 | +0.62 ¢ (1,084, 0 lost) | +0.34 ¢ (194, 0 lost) | +0.14 ¢ (2,638, 29 lost) | +0.13 ¢ (871, 4 lost) |
| 2026-04 | +0.20 ¢ (1,910, 4 lost) | +0.24 ¢ (491, 0 lost) | -0.10 ¢ (2,655, 33 lost) | -0.00 ¢ (2,149, 14 lost) |
| 2026-05 | +0.25 ¢ (2,178, 2 lost) | +0.20 ¢ (635, 0 lost) | -0.17 ¢ (2,832, 36 lost) | -0.15 ¢ (2,526, 18 lost) |
| 2026-06 | +0.32 ¢ (2,433, 2 lost) | +0.17 ¢ (573, 0 lost) | +0.23 ¢ (2,789, 25 lost) | -0.01 ¢ (2,649, 14 lost) |
| 2026-07 (to Jul 21 unseen, then seen) | +0.22 ¢ (2,297, 1 lost) | +0.15 ¢ (307, 0 lost) | +0.19 ¢ (2,910, 30 lost) | +0.13 ¢ (2,884, 13 lost) |
| 2026-08 (seen, partial tapes) | +0.27 ¢ (1,192, 1 lost) | +0.19 ¢ (162, 0 lost) | -0.46 ¢ (1,766, 30 lost) | +0.15 ¢ (1,749, 7 lost) |
| 2026-09 (seen, partial tapes) | +0.06 ¢ (439, 2 lost) | +0.20 ¢ (82, 0 lost) | +0.03 ¢ (494, 4 lost) | +0.01 ¢ (489, 2 lost) |
| 2026-10 (seen, partial tapes) | — | — | +12.29 ¢ (1, 0 lost) | +0.68 ¢ (1, 0 lost) |

C = 100, VWAP, no buffer; all periods, 21,057 of 25,994 markets with a tape when this ran.

**The edge is shrinking — the most important unfavourable finding for small sizes.**
* First LOCKED made +1.1 to +1.2 ¢ per contract in Jan–Feb and +0.6 ¢ in Mar.
* From Apr to Aug it made +0.2 to +0.3 ¢ in every month, and +0.06 ¢ in the September tapes so far.
* The market-only rules ranged from −0.46 to +0.31 ¢ (≥ 99 ¢) by month.
* On Jul 22 – Oct 16 alone (3,275 of 8,153 markets with tapes), first LOCKED at 100 contracts made +0.17 ¢ (CI +0.02 to +0.31), 2,337 trades, 4 lost, $399. At worst fill it made +0.04 ¢, and at 10 contracts +0.09 ¢ (CI -0.05 to +0.23).
* Its margin over the ≥ 99.5 ¢ market rule there was +0.09 ¢ (CI -0.18 to +0.39): **not significant**.

**8. Exit on REVERSAL WARNING** [RUN, `exit_full_C*.json`; all periods with a tape at the time of the execution run]:

| Contracts | Entries that filled | Warned later | of which lost / won | Hold: ¢ / contract | Exit at the warning: ¢ / contract |
|---|---|---|---|---|---|
| 100 | 12,166 | 114 | 9 / 105 | +0.384 | +0.360 |
| 1,000 | 8,604 | 73 | 7 / 66 | +0.345 | +0.333 |

* Selling at the first warning recovered a mean 69.5 ¢ on the 9 losing calls (100 contracts) and gave up a mean 8.9 ¢ on each of the 101 false alarms that could be exited.
* Net, it is slightly worse than holding (−0.02 ¢ per contract). It is not adopted, and it is not harmful.

**Answer.**
* **At $50,000: NO.** The pre-registered rules say NO. Where the size can be filled, the call is wrong too often and the realistic-fill result is negative.
* **At 100–1,000 contracts: NOT YET VALIDATED.** On Jan–Jul unseen data, the first-LOCKED rule beat the market-only rules by about +0.4 ¢ per contract under the optimistic fill model, and by +0.24 ¢ with the page's own 12 s order time.
  * About $1,800 at 100 contracts and $10,300 at 1,000 contracts in 6 months, with 12 and 8 losing trades.
  * The edge has since shrunk to about +0.06–0.3 ¢ and is not significantly better than the ≥ 99.5 ¢ market rule on Jul 22 – Oct 16.
  * The pre-registered rules give NO at 1,000 contracts.

## Phase 6. Attempts to break the software

| Scenario | How tested | Result |
|---|---|---|
| Abrupt reversals, adverse momentum, volatility spikes | real data: anatomy of all wrong calls; momentum, prior adverse move, changing volatility | real reversals are 19 of 28 unseen failures; none of these observables predicts them (the volatility-jump signal did not replicate) |
| Final-second moves, settlement-reference divergence | calibration by time left on two feeds; proxy | over-confident in the final seconds: from about T−10 on BTCUSDC and from T−20 on BTCUSDT; not on the proxy. TRADE NOW is barred below 3 s + the order time: 15 s with the default 12 s, but a shorter order time on the page moves that later. |
| Settlement-average maths | every contract: `round2(expiration_value) ≥ floor_strike ⇔ result = yes` holds for all 25,994; engine self-test 150 / 150 | no error found |
| Stale / missing data, WebSocket loss, one lagging venue | fault injection (`dq281_test.js` 6 / 6) [SIM]; with Kraken as the only real venue, the replay shows DATA UNRELIABLE throughout the incident window | detected |
| Clock / time synchronisation | sampler-phase sweep [SIM]; feed timing shifted 0.9 s [EARLIER WORK] | phase bug fixed in 2.8.1; the timing shift **doubled T−20 failures (2 → 4)**, though the bound stays below break-even, and gave 44–47 first-LOCKED failures |
| Settlement lag | official value fed later than 5 s [EARLIER WORK] | negligible |
| Race conditions, contradictory states | 20,000-case fuzz with 0 violations, run on 2.8.1 **with its new features off** (2.8 behaviour); the default configuration was not fuzzed. Page tests 17 / 17. | consistent |
| Restart / cold start | 330 s-before-close restart fixture [SIM]; restart simulations on the 58 saved windows (in-sample) | 2.8 withheld a supported LOCKED until T−31, 2.8.1 at T−57; restart errors 2 → 0 |
| Latency between prediction and execution | 0 / 2 / 5 / 12 s in the P&L | the edge shrinks with latency; at 12 s, +0.24 ¢ |
| Liquidity | typical depth measured from prints | thin: no T−20 volume in 82.7 % of entries |
| **Not tested** | injected faulty volatility estimates; liquidity shocks (sudden book withdrawal); the live three-venue index over the full period | — |

Synthetic or simulated items in `2.8.1/TEST_RESULTS.md`:
* the injected final-second and T−35 jumps (S4, S4b);
* the stale-data and empty-book cases (S5–S7);
* the "Oct 15 replica" with assumed asks (S9);
* the restart fixtures and the sampler-phase sweep.

They test the logic. They are not evidence of a failure rate.

## G. Improvements: what is empirically justified

**In 2.8.1 (default on):** the operational fixes in section C, each with a regression test.
* The probability model is unchanged.
* Decisions match 2.8 except in 10 cold-start windows.
* The page shows **directional certainty** (LOCKED / REVERSAL WARNING) and **execution readiness** (TRADE NOW / SIT OUT / TOO LATE / NO BOOK, with the qualifying price and the 90 ¢ guard) as separate lines (`page281_test.js`).

**Candidates** (in 2.8.1 behind switches, **off by default**; none is validated):

1. **0.2 % LOCKED threshold** (`LOCK_MAX_FLIP=0.002`).
   * It was designed on seen data in earlier work.
   * It was replayed here with the real engine over all contracts: an evaluation on U as the pre-registration allows.

   | | 2.8.1 (0.5 %) | 0.2 % threshold |
   |---|---|---|
   | U: first LOCKED wrong | 28 / 16,773 (0.167 %, CI 0.111–0.241 %) | 15 / 16,700 (0.090 %, CI 0.050–0.148 %) |
   | U: LOCKED at T−20 wrong | 2 / 15,936 (bound 0.040 %) | 1 / 15,601 (bound 0.030 %) |
   | U: coverage | 93.0 % | 92.6 % |
   | U: median seconds left at first LOCKED | 76 | 62 |
   | seen (in-sample for this candidate): first LOCKED wrong | 19 / 7,230 (0.263 %, CI 0.158–0.410 %) | 7 / 7,205 (0.097 %, CI 0.039–0.200 %) |
   | U2 trading, first LOCKED, 100 contracts, 15 s buffer | +0.41 ¢ (CI +0.35 to +0.47), 10,399 trades, 8 lost, $4,296 | +0.28 ¢ (CI +0.23 to +0.32), 8,080 trades, 2 lost, $2,249 |
   | same with the page's 12 s order time | +0.24 ¢ (CI +0.15 to +0.32), 7,684 trades, 12 lost, $1,816 | +0.22 ¢ (CI +0.14 to +0.29), 5,158 trades, 2 lost, $1,110 |
   | same, 1,000 contracts, 12 s order time | +0.21 ¢ (CI +0.12 to +0.31), 4,818 trades, 8 lost, $10,315 | +0.19 ¢ (CI +0.11 to +0.29), 3,097 trades, 1 lost, $5,979 |

   * **The strongest candidate.** On unseen data it halves the first-LOCKED failure rate (0.167 % → 0.090 %) at almost no cost in coverage, and calls a median 14 s later.
   * At small sizes it cuts losing trades from 8 to 2 (no latency) and from 12 to 2 (12 s order time).
   * The edge per contract is a little lower and the total profit roughly halves, because the cheapest early entries disappear.
   * It is **not enough for the $50,000 trade**: 0.090 % is at break-even, and its interval reaches 0.148 %.
   * The seen-period figures are in-sample, because the threshold was chosen there in earlier work.
   * Status: **the most defensible change for a small-size forward test**, not validated.

2. **`ADAPTIVE_BASIS=1`** widens the basis uncertainty when recent feed-vs-official errors are large. [EXPLORATORY: designed after seeing U2 calibration, so its U results are not independent.]

   | Unseen U | 2.8.1, USDC | Candidate, USDC | 2.8.1, USDT | Candidate, USDT |
   |---|---|---|---|---|
   | First LOCKED wrong | 28 / 16,773 (0.167 %) | 16 / 16,527 (0.097 %) | 46 / 16,839 (0.273 %) | 23 / 15,910 (0.145 %) |
   | T−20 wrong | 2 / 15,936 | 0 / 15,750 | 5 / 16,035 | 3 / 15,248 |
   | Coverage | 93.0 % | 91.7 % | 93.4 % | 88.3 % |

   * **On the seen period, which its design did not look at:** it removes only 1 of 19 wrong first-LOCKED calls on BTCUSDC (0.263 % → 0.253 %).
   * It remains over-confident at T−5 (9.8×).
   * Its first-LOCKED rate stays above break-even.
   * Trading on U2: first LOCKED at 100 contracts: +0.40 ¢ (CI +0.35 to +0.46), 10,374 trades, 7 lost, against 2.8.1's +0.41 ¢, 10,586 trades, 9 lost (same fill model, no buffer).
   * It addresses basis-decided failures only, not real reversals.
3. **`MARKET_VETO_CENTS=90`** shows the guard on the LOCKED headline itself.
   * It cannot be replayed, because there is no order-book history.
   * Assessed from last prints over all periods (in-sample): the guard fired on 132 of 18,623 first-LOCKED calls, and 13 were wrong (9.8 %). Of the other 18,491, 17 were wrong (0.092 %).
   * At small sizes the blocked trades were profitable on average (+$524 at 100 contracts), so the veto costs money there. At $50,000 it is essential.
4. **Volatility-jump filter.** It did not replicate out of sample (section A), so it is rejected.

**Also not adopted:**
* extrapolating the volatility tables to recover the 291 large-margin misses, which would weaken a risk control for $43;
* exit on REVERSAL WARNING (neutral);
* momentum filters (no detectable effect).

**What fits your objective.** What the data show:
* certainty arrives late, after the market has priced it, at a size the market cannot absorb;
* early calls are not certain enough for 1,000:1 risk.

$50,000 at 99.9 ¢ is not reachable with this signal in this market. What the evidence leaves open is small sizes with the 90 ¢ guard and the 15 s buffer, preferably with the 0.2 % threshold.
* On Jan–Jul data with the page's 12 s order time, the current threshold made about +0.24 ¢ per contract with 12 losing trades, and the 0.2 % threshold +0.22 ¢ with 2.
* The edge is shrinking. It can only be confirmed by a forward test with real small orders, which needs your authorisation.

## Corrections made after independent checks of this validation

**First audit:**
* The market baseline counted its own trigger print as a fill (look-ahead). This is fixed, and "the baseline lost money" was withdrawn.
* "No T−20 entry ever had $50,000 of volume" was false.
* The model-minus-baseline gap on U2 is +0.36 ¢, not +0.60.

**Second check (this revision):**
1. The 12 unreplayed U1 contracts, including the Oct 15 loss, are now disclosed.
2. "Yes at 100–1,000 contracts" was replaced by NOT YET VALIDATED, and the pre-registered rules were applied at all sizes and prices.
3. Failure classes are now split by what the feed showed. The earlier "19 near-strike, basis-decided" was wrong: 19 of 28 are real price reversals.
4. The DOWN excess is no longer attributed to the basis.
5. The momentum claim was weakened to "no significant association".
6. Corrections to the incident analysis:
   * The Kraken replay drove the index from Kraken alone.
   * The volatility at the call was about 0.27–0.29 bps/√s, so the move was about 14–17σ.
   * The two-venue flip bottomed at 0.52 %.
   * The guard was already in 2.8.
7. Proxy monthly range: 0.04–0.48 %, not 0.07–0.37 %.
8. The edge rule's look-ahead (decision at the realised fill price) is disclosed.
9. The 15 s buffer is now applied in the trading evaluation, and the page's 12 s order time was added.
10. The 2.8 vs 2.8.1 difference: 10 cold-start windows.
11. Capacity growth and the worst-fill loss of the recent $50k fills are reported.
12. The fill-model biases are quantified.
13. Untested scenarios are listed.
14. Earlier-work and simulated items are tagged.
15. The 0.2 % threshold, designed on seen data in earlier work, was replayed with the real engine and evaluated on U (section G).

## Deviations from the pre-registration

* **Primary feed.** The pre-registered plan listed Coinbase + Kraken. The primary feed is Binance BTCUSDC driving the index, because Coinbase / Kraken history was available only for weeks. Coinbase + Kraken were used for Oct 14–16 only.
* **Replay mode.** Month chunks with a 24 h warm-up each, instead of one continuous replay with 4 h.
* **U1 contracts dropped.** 12 U1 contracts (closes Oct 16 00:15–03:00 UTC), including KXBTC15M-26OCT152030-30, have 0 of 60 settlement-minute prices in the Binance archive. They were removed before the replay, which is what the 57-of-60 exclusion rule implies. No other window was excluded.
* **U1 is small** (185 windows) and **has no Kalshi tapes**. All execution evidence is U2 only.
  * Replays of Oct 14–16 that include the 12 windows give 3 wrong of 170 first-LOCKED calls when Kraken drives the index. With Coinbase + Kraken as two real venues, they give 0 of 169.
* **Proxy period.** Oct 2023 → Jan 13 2026, not → Jul 21 2026, so it does not overlap the contracts.
* **Trading strategies.** The small-size strategies (first LOCKED with the guard, the edge rule, the market-only baselines) were not pre-registered, and the baseline was corrected after U2 had been seen. They are labelled exploratory.
* **Pre-registered reporting added late.** The rules at smaller sizes and other prices, and contract failure rates by month, were pre-registered but first reported in this revision.
* **Candidate rules not followed.** ADAPTIVE_BASIS was designed after seeing U2 results, and MARKET_VETO was assessed in-sample, contrary to the improvement rule. Both are labelled exploratory.
* **Seen-period tapes are partial** (3,275 of 8,153 markets).

## What is still missing, and what you can provide

1. **The live server's logs**:
   * `/ledger?since=0&n=5000` holds the committed calls for scoring the forward period;
   * `/predictions?ticker=<window>` and `/tape?format=ndjson` (recent windows only) let `forensic281.js` reconstruct individual windows on the server's own index;
   * also `/signals?n=5000` and `/health`.
2. **Your Kalshi fill history** (CSV), to replace the print-based fill model with real fills.
3. **A forward test with small real orders.** It needs your explicit authorisation; nothing in this work places orders.
4. **Not done here:**
   * a full-period replay on the live three-venue index (Coinbase, Kraken and Bitstamp public trades);
   * faulty-volatility injection and liquidity-shock tests.

## Reproduce

Data (about 2 GB, not committed): `pipeline/run_pipeline.sh` fetches Kalshi markets and tapes, and Binance 1 s archives (`fetch_binance_1s.py --symbol BTCUSDC --subdir usdc` for the primary feed). `clean_markets.py` produces `markets_clean.ndjson`. `markets_usdc.ndjson` is `markets_clean.ndjson` restricted to closes ≤ 2026-10-16 00:00 UTC (the BTCUSDC archive end).

```
# contract replays (run from pinradar-research; D = data dir); prefix LOCK_MAX_FLIP=0.002 or ADAPTIVE_BASIS=1 for the candidates
bash validation/pipeline/replay_parallel.sh 2.8.1/dist/pinradar_server.js $D/sec proxy $D/kalshi/markets_usdc.ndjson 2026-01 2026-11 $D/replay/r281_usdc.ndjson 4 --proxy-dir usdc
#   2.8: 2.8/dist/pinradar_server.js ; BTCUSDT: --proxy-dir proxy ; proxy study: make_proxy_markets.py, then the same with --proxy-dir proxy
node validation/replay_chrono.js --server 2.8.1/dist/pinradar_server.js --sec $D/sec --venues cb,kr --markets $D/kalshi/markets_clean.ndjson --from 2026-10-14T04:00:00Z --to 2026-10-16T03:00:00Z --out $D/replay/cbkr_oct_2.8.1.ndjson
#   Kraken driving the index: --venues proxy --proxy-dir kr
cd validation/pipeline
python3 analyze.py --records $D/replay/<run>.ndjson --splits "<U2|S1|S2|S0|U1 as in VALIDATION_PREREG.md>" --out $D/summary_<run>.json
python3 decisive.py --data $D --out $D/decisive.json
python3 calibration.py --records $D/replay/r281_usdc.ndjson --records $D/replay/r281_usdt.ndjson --records $D/replay/cand_usdc.ndjson --records $D/replay/r281_proxy27m.ndjson --out $D/calibration.json
python3 anatomy.py --records $D/replay/r281_usdc.ndjson --out $D/anatomy_r281_usdc.json
python3 execution.py --records $D/replay/r281_usdc.ndjson --trace $D/replay/r281_usdc.trace.ndjson --trades $D/kalshi/trades --out $D/exec_r281_usdc_full.json && cp $D/exec_r281_usdc_full.json $D/exec_r281_full.json
python3 prevented.py --records $D/replay/r281_usdc.ndjson --exec-rows $D/exec_r281_usdc_full_rows.ndjson --out $D/prevented_r281_usdc.json
python3 missed_value.py --records $D/replay/r281_usdc.ndjson --trades $D/kalshi/trades --out $D/missed_value.json
python3 supplement.py --data $D --out $D/supplement.json
python3 volchange.py --records $D/replay/r281_usdc.ndjson --sec-dir $D/sec/usdc --from-ts 1784678400 --to-ts 1791936000 --out $D/volchange_seen.json
python3 volchange.py --records $D/replay/r281_proxy27m.ndjson --sec-dir $D/sec/proxy --out $D/volchange_proxy.json
for L in 0 2 5; do python3 trading_eval.py --exec-rows $D/exec_r281_usdc_full_rows.ndjson --markets $D/kalshi/markets_clean.ndjson --trades $D/kalshi/trades --records $D/replay/r281_usdc.ndjson --to 2026-07-22T00:00:00+00:00 --latency $L --out $D/trading2_U2_L$L.json; done
#   buffer: --min-tau 15 (trading2_U2_L0_buf15), plus --latency 12 (trading2_U2_L12_buf15); seen: --from 2026-07-22T00:00:00+00:00 (trading2_seen_L0); all: no --from/--to (trading2_full_L0)
#   candidates: the same with the candidate's execution rows and records (trading2_cand_U2_L0, trading2_thr02_U2_L0)
python3 exit_eval.py --exec-rows $D/exec_r281_usdc_full_rows.ndjson --trace $D/replay/r281_usdc.trace.ndjson --trades $D/kalshi/trades --C 100 --out $D/exit_full_C100.json   # and --C 1000
python3 final_tables.py --data $D --out ../RESULTS_TABLES.md
bash ../../2.8.1/test/run_all281.sh                                      # software suite
```
