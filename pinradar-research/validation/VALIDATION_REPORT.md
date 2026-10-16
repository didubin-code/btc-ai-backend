# BTC Pin Radar — historical validation: interim report (2026-10-16)

**Status.** Everything that can be executed with the data in this environment has been executed, and the results are below. The independent public-data phase (≥ 12 months) is **blocked**: this environment's network policy refuses every market-data host (Kalshi, Binance, Coinbase, Kraken, Bitstamp, Gemini, CF Benchmarks all return HTTP 403 at the proxy). The complete pipeline for it is written, unit-checked offline, and committed, and the rules it will be judged by are pre-registered (`VALIDATION_PREREG.md`). It runs as one command once the hosts are allowed (section E). No result below is simulated unless it says [SIM], and nothing was invented to fill the gap.

**Evidence tags:**

| Tag | Meaning |
|---|---|
| [RUN] | Executed in this session, on data present here. |
| [HIST] | Read from the saved result files of the Oct 13 walk-forward study: 5,885 KXBTC15M windows, Jul 22 – Oct 13 2026, built from Kalshi's official settlement values and real Kalshi / Coinbase / Kraken tapes. The tapes themselves are not in this environment, so these counts cannot be re-executed here. |
| [SCREEN] | Read from your photos of the live page. |

## Data actually available here (Phase 1 audit)

| Data | What it is | Use |
|---|---|---|
| 58 real windows (`pkg27/test/data`) | 1 Hz index paths (1,901 s each), strike, Kalshi's official settlement average and result, walk-forward basis. 42 windows carry one historical trade entry each (side, price, time); 16 are consecutive (Jul 22 01:15–05:00 UTC). | [RUN] chronological replays of the current engine |
| Saved results of the Oct 13 study | Per-set counts: first LOCKED, LOCKED at fixed times, TRADE NOW fills from Kalshi tapes, regimes, momentum, shocks | [HIST] |
| Your live page | Forward record "0 of 83 LOCKED calls lost"; the Oct 15 20:30 ET incident | [SCREEN] |
| Everything else checked | Large files under `/home/user/work/reviews` are synthetic test ledgers; the `Btc-signal` repo holds page versions only. No raw historical trading log, Kalshi tape or exchange tape exists here. | none |

The 58 windows were picked for earlier tests and over-represent reversals, so their counts are not failure rates. Rates come from [HIST], and will come from the pipeline.

## A. Does the hypothesis hold?

Distance, cushion, time left, volatility and settlement-average mathematics **do** identify a LOCKED state that is right far more often than the market price alone would suggest. **But the remaining failure rate is not small enough for the trade you intend, at the moment LOCKED first appears.**

* **First LOCKED [HIST].**
  * Holdout: 3 of 1,879 wrong (0.16 %, 95 % CI 0.03–0.47 %).
  * Development: 13 of 3,484 (0.37 %, CI 0.20–0.64 %).
  * Pooled: 16 of 5,363 (0.30 %, CI 0.17–0.48 %).
  * The failure rate is flat across volatility regimes.
  * Momentum at the call predicted none of the failures: there were 0 losses among calls made against adverse momentum.
* **How they fail.** Every recorded loss was called 54–300 s before the close and overturned by a sharp move afterwards [HIST].
  * In the two real paths available here, the move was 1.4–1.6× the move required, within 12–44 s [RUN].
  * The Oct 15 20:30 ET incident has the same shape [SCREEN]: LOCKED DOWN at T−89, then a reversal warning at T−71.
* **Where it holds best.** The call is far more reliable if it is **still** LOCKED close to the end [HIST]:

  | Still LOCKED at | Wrong / LOCKED (pooled) | 95 % CI |
  |---|---|---|
  | T−60 s | 2 / 3,280 | 0.007–0.22 % |
  | T−45 s | 1 / 4,033 | 0.0006–0.14 % |
  | T−30 s | 0 / 4,732 | 0–0.078 % |
  | T−20 s | 0 / 5,106 | 0–0.072 % |
  | T−15 s | 0 / 5,218 | 0–0.071 % |
  | T−10 s | 1 / 5,301 | 0.0005–0.105 % |

  * These cells overlap (the same windows at different times).
  * T−20 / T−15 look best only after the fact.
  * The data are 62 days of one market regime.

## B. Can LOCKED be relied on?

* **As a forecast**, at the 0.5 % standard it was built for: yes. Its observed failure rate is within that standard, and calibration error is 0.3–1.4 percentage points [HIST].
* **As a trade trigger for $50,000 positions: not as it stands.**
  * Zero observed failures does not mean impossible. The forward record (0 of 83 before Oct 15 20:30 ET) has a 95 % upper bound of 3.5 % [SCREEN].
* **On the 58 real windows, current engine 2.8.1, chronological replay, production-like 50 ms data age [RUN]:**
  * 55 first-LOCKED calls, 2 wrong: Sep 2 23:15 at T−97, and Oct 12 20:45 at T−17.
  * Still LOCKED at T−60 … T−3: 0 wrong.
  * 2.8 is identical on these windows.

## C. Failures the new software prevents

**Prevented by 2.8.1 [RUN, SIM]:**
* The restart failures: restart errors go from 2 to 0 in the restart simulations, at the harness's input age.
* The Oct 12 call made with a cold basis model.
* "TOO LATE" mislabels on empty books.
* DATA UNRELIABLE false alarms from the sampler phase: up to 94 % of final-minute decisions in affected windows, now 0 %.
* TRADE NOW inside the last 15 s.
* Stale TRADE NOW displays on slow links.

**Not prevented:** the main failure class, sharp reversals after an early call.
* The 15 recorded losses would all still have been called LOCKED by 2.8.1.
* So would Oct 12 with a known basis. Tonight's call came from the same probability model (2.8), which 2.8.1 does not change.
* A 0.2 % threshold would have prevented 8 of 13 development and 2 of 3 holdout losses, but halves trading profit [HIST]; it is not adopted.
* Momentum, volatility and the 15 s buffer prevent none of them.

## D. Missed opportunities

* **LOCKED calls missed:** almost none [HIST]. In the holdout, 241 of 2,120 windows were never LOCKED. Their official margins were under $5 (157) or $5–20 (84), so these are genuine toss-ups.
* **Trades missed:** the binding limit is the **price**, not the model [HIST].
  * Where a price existed, the leader's median ask was **99.9 ¢** at every time from T−60 to T−3.
  * An ask at or below 99 ¢ appeared in only 0.5–4 % of priced LOCKED windows.
  * At T−20 only 1,383 of 5,106 LOCKED windows (27 %) showed any leader trade at all.
* **Recovering more trades means buying when the market is cheaper.** That is exactly when the call appears weaker: TRADE NOW lost 2 of 261 (0.77 %, CI 0.09–2.74 %) against 0.37 % for LOCKED overall. The difference is not significant.

## E. At least one year of independent data — NOT EXECUTED (blocked)

* **What is blocked.** Every source returned HTTP 403 at this environment's proxy (checked twice): `api.elections.kalshi.com`, `data.binance.vision`, `api.exchange.coinbase.com`, `api.kraken.com`, `www.bitstamp.net`, `api.gemini.com`, `www.cfbenchmarks.com`.
* **Ready to run** (`pipeline/run_pipeline.sh`; every step resumable, every response logged with its SHA-256):
  1. Every settled KXBTC15M market from Kalshi, with its official `expiration_value` (the CF Benchmarks BRTI 60-second average the contract settles on) and its result.
  2. Kalshi trade prints for each window's last 300 s.
  3. Coinbase and Kraken trades converted to the 1 Hz USD index the live server uses.
  4. Binance BTCUSDT 1-second archives from 2023-10-01 for a long-horizon **proxy** study. Its outcomes are defined by the proxy itself and are never pooled with contract results.
  5. A continuous chronological replay of 2.8.1 and 2.8 with the live basis model learning only from windows already settled.
  6. Scoring by the pre-registered splits.
  7. Execution scoring against Kalshi's real prints.
* **Tested offline:**
  * the replay, on the 16 consecutive real windows: 4,500 decisions in 2.3 s, so about 1.5 h per contract-year;
  * the scoring, on the replay output;
  * the 1 Hz converters (trade staleness rule, millisecond and microsecond kline timestamps);
  * the Kalshi price parsers (both field formats).
* **Not tested:** the network calls themselves. `fetch_kalshi.py probe` prints every endpoint's fields first so the parsers can be checked against the live format.
* **What the BRTI allows.** CF Benchmarks' BRTI history itself is licensed. Kalshi's `expiration_value` gives the exact official settlement average per contract, which is what the outcome needs. The second-by-second index before the close is reconstructed from the USD constituents, with the proxy-to-BRTI basis learned walk-forward from those official values; this is how the live server works too.
* **How much contract history exists.** If Kalshi's KXBTC15M history starts around July 2026 (the Oct 13 study found Jul 22 onward), contract-level validation cannot reach a year. The long-horizon question is then answered by the proxy study, labelled as such.

## F. Profitable at your intended size?

A $50,000 position, one order, with Kalshi's taker fee `ceil(0.07 × C × P × (1−P))` [RUN, `economics.js`]:

| Ask | Contracts | Win | Loss | Break-even failure rate | Clean wins needed to show it (95 %) |
|---|---|---|---|---|---|
| 99.9 ¢ | 50,046 | +$46.55 | −$49,999 | **0.093 %** | 3,220 |
| 99.8 ¢ | 50,093 | +$93.19 | −$50,000 | 0.186 % | 1,609 |
| 99.0 ¢ | 50,469 | +$469.71 | −$49,999 | 0.93 % | 321 |

* **Buying at the first LOCKED at 99.9 ¢ loses money: NO.**
  * The pooled failure rate is 0.30 %, with a CI of 0.17–0.48 %. That interval lies wholly above the 0.093 % break-even.
  * Expected value: about **−$103 per trade**.
* **Buying only while still LOCKED at T−30 … T−15, at 99.9 ¢: NOT YET VALIDATED.**
  * 0 failures in 4,732–5,218 windows. The one-sided 95 % upper bounds (0.057–0.063 %) are below break-even, which gives +$15 to +$18 per trade at the bound and +$46.55 at the point estimate.
  * But the cells were chosen after seeing the data, and the period is 62 days.
  * Capacity is unverified. Only about 27 % of those windows showed any leader trade at T−20. Whether 50,000 contracts at ≤ 99.9 ¢ were available in 12 s is unknown; the saved files hold prices, not sizes.
  * One loss in about 1,000 such trades erases about 1,000 wins.
* **At 10 contracts, the model's own TRADE NOW [HIST]:**
  * holdout: 32 trades, 0 lost, +2.05 ¢ per contract (CI 1.38–2.73);
  * development: 261 trades, 2 lost, +0.86 ¢ (CI −0.21 to +1.92);
  * in total about $22 over 40 days at 10 contracts.
  * The edge is not established.

## G. Improvements

**Measured and adopted in 2.8.1** (each with a test that fails on the old code and passes on the new) [RUN]:
* restart envelopes;
* the sampler-phase DATA UNRELIABLE fix, plus its follow-up that never samples a second twice;
* withdrawal of a change that hid a frozen venue;
* the cautious stress test, with the worst case after a restart;
* a qualifying price that never quotes an untradable price;
* honest TRADE NOW / SIT OUT / TOO LATE states;
* page timing that cannot show an old TRADE NOW.

Each of the last three independent adversarial review rounds found real defects, among them a hidden frozen-venue hole, a duplicate-sample volatility bias, stress and pricing errors, and page timing. All were fixed, each with a regression test. The 2.8 suites pass with the new features switched off.

**Candidates — designed on seen data, NOT validated; evaluated once on unseen data by the pre-registered rules:**
1. **Entry window: TRADE NOW only while still LOCKED at T−30 … T−15.** This is the strongest candidate for the large-size trade.
2. **Market-disagreement veto on LOCKED** (not only on TRADE NOW). The Oct 15 20:30 ET window had DOWN priced at 8.8 ¢ while the call was DOWN.
3. **The 0.2 % threshold.** It is already in the forward test as shadow policy C1.

## H. Ready for real-money deployment?

**NO** for the intended trade at the first LOCKED. Its failure rate is measurably above the 0.093 % break-even.

**NOT YET VALIDATED** for every other form: the late-entry rule, smaller sizes, cheaper asks.
* The decisive tests need data this environment cannot reach.
* The forward record is about 100 times too small for a rate near 0.1 %.
* Tonight's call may be its first loss.

A backtest, however long, is not a guarantee. The rare-event risk here (a $50,000 loss for a $47 gain) can only be bounded, never excluded.

## What I need from you

1. **Allow these hosts** (environment settings → Network access → Allowed domains):
   * `api.elections.kalshi.com`
   * `data.binance.vision`
   * `api.exchange.coinbase.com`
   * `api.kraken.com`
2. **The live server's logs**, saved as files, for the Oct 15 20:30 ET window and the forward record:
   * `/ledger?since=0&n=5000`
   * `/predictions?ticker=KXBTC15M-26OCT152030-30`
   * `/tape?format=ndjson`
   * `/signals?n=5000`
   * `/health`
3. **Optional:** your own Kalshi fill history (CSV export), if you want your actual past trades scored.
