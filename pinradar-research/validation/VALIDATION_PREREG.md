# Pin Radar validation pre-registration (written 2026-10-16, before any new data was fetched)

The git commit that adds this file fixes the rules below. Results computed under these rules are reported whatever they show.

## Engine under test

* **Primary:** `2.8.1/dist/pinradar_server.js`, the build in the same commit as this file (SHA-256 in `2.8.1/SHA256SUMS.txt`), default configuration.
* **Baseline:** `2.8/dist/pinradar_server.js` (the deployed 2.8).
* **Runner:** `validation/replay_chrono.js`. It is a continuous chronological replay:
  * second-by-second prices;
  * decisions in each window's final 300 s at 0.75 s into the second, with a 50 ms venue quote age;
  * official values reach the engine's basis model only 5 s after each close;
  * 4 h of warm-up before the first scored window.
* No parameter of the engine is changed for the evaluation.

## Data and splits

| Split | Period (UTC) | Status |
|---|---|---|
| **S0 development** | 2026-09-04 – 2026-10-13 | The probability tables were fitted here. Not independent: reported only. |
| **S1 earlier holdout** | 2026-07-22 – 2026-08-13 | Used to check 2.6 on Oct 13. Seen: reported, not decisive. |
| **S2 training gap** | 2026-08-14 – 2026-09-03 | Used to fit fold 1. Seen: reported only. |
| **U1 unseen, after** | 2026-10-14 00:00 → end of the fetched data | Never used for fitting or threshold choice. **Decisive.** |
| **U2 unseen, before** | everything before 2026-07-22 that Kalshi publishes for KXBTC15M | Never used. **Decisive**, if it exists. |
| **P proxy, long horizon** | Binance BTCUSDT 1 s, 2023-10-01 → 2026-07-21 | Outcomes are defined by the proxy itself (`make_proxy_markets.py`). It tests the price-path model only, never the BRTI basis or execution. Reported separately and never pooled with contract results. |

Contract windows use Kalshi's own `result` and `expiration_value`. Nothing is imputed. A window with fewer than 57 of its 60 settlement-minute prints in the 1 Hz history is excluded, and the count is reported.

## Hypotheses and metrics (U1 ∪ U2 decisive; S0–S2 and P reported)

* **H1 — first-LOCKED reliability.** Wrong first LOCKED calls / first LOCKED calls, with a 95 % Clopper-Pearson interval. Also reported:
  * by direction;
  * by the time of the first LOCKED;
  * by the cushion in σ;
  * by volatility regime;
  * by month.
* **H2 — LOCKED at the entry moment.** For entry rules E30, E20 and E15 (the call is LOCKED at T−30 / T−20 / T−15 s): wrong / LOCKED, with the one-sided 95 % upper bound. E20 is the primary rule. E30 and E15 are reported, not chosen after the fact.
* **H3 — the intended trade (about $50,000 per trade at about 99.9 ¢).**
  * Break-even failure probability: 0.093 % at 99.9 ¢, 0.186 % at 99.8 ¢ (`validation/economics.js`, Kalshi taker fee included).
  * Executable volume: leader-side taker prints at ≤ 99.9 ¢ within the 12 s order time after the entry moment (`pipeline/execution.py`).
* **H4 — reversals and misses.**
  * REVERSAL WARNING after a LOCKED call, on correct and on wrong calls.
  * Windows never LOCKED, by official margin.
  * DATA UNRELIABLE windows.

## Verdict rules (fixed now)

* **YES (supported for the $50,000 / 99.9 ¢ trade)** requires all three, on U1 ∪ U2:
  1. The E20 one-sided 95 % upper bound is below 0.093 %. That needs at least 3,220 E20 windows with no failure.
  2. Executable taker volume at ≤ 99.9 ¢ in the order time is ≥ 50,000 contracts in at least half of the E20 entries.
  3. No failure on U1 ∪ U2 at E20 that a reasonable trader could not have avoided.
* **NO** if either holds:
  * the E20 failure rate's two-sided 95 % interval lies wholly above 0.093 %;
  * executable volume reaches 50,000 contracts in fewer than 10 % of E20 entries.
* **NOT YET VALIDATED** otherwise. This includes too few unseen windows to reach rule 1.
* The same rules are applied at smaller sizes (for example 10 contracts) and other prices, and reported. The headline verdict is for the size the user named.

## Improvements

* A candidate change may only be designed on S0, S1, S2 or P. It is then evaluated once on U1 ∪ U2 next to the primary engine.
* A candidate that improves the failure rate by removing most entries is reported as such and not adopted. The reported comparison is:
  * entries kept;
  * failures removed;
  * expected value at the named size.
* Tuning on U1 or U2 is not allowed. If a candidate is changed after seeing U results, its U results are labelled exploratory.
