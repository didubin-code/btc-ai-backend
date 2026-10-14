# BTC Pin Radar: research report and 2.8 candidate (Oct 14 2026)

## Verdict

**CONDITIONAL PASS for 2.8 as decision-support software.** It keeps the 2.6 prediction engine unchanged, fixes
three confirmed defects, and adds tested economics, evidence and monitoring layers. It still needs the
pre-registered forward test before it replaces anything.

On the question you asked most directly, whether there is a *genuine, repeatable, economically meaningful
trading advantage*, the answer is **not demonstrated**:
* The best historical estimate is about +1 ¢ per contract on about 5 trades a day.
* That is roughly $0.50 a day per 10-lot.
* Its 95 % interval includes zero.
* Even if the edge is real, the market already prices most LOCKED outcomes at 99.9 ¢, which caps the size of any edge.

Production 2.3 is untouched. Nothing was deployed and no order was placed.

## 0. What could and could not be done here

* **Recovered and verified.**
  * Versions 2.3 (live), 2.4 (reverted), 2.6 and 2.7 are preserved with SHA-256 provenance (`versions/VERSIONS.md`).
  * The whole 2.7 package (`pkg27/`) is preserved. Its offline suite reproduces exactly.
* **Not recoverable.** The raw tapes behind every backtest number:
  * Coinbase/Kraken trades, Jul 22 – Oct 13;
  * Kalshi market records and trade tapes;
  * the derived arrays.

  They lived in the previous session's container, and some analysis scripts the package imports are also missing.
  Prior headline numbers can therefore be checked for consistency, but not recomputed.
* **No new market data could be fetched.** This environment's network policy denies the hosts:
  * `api.elections.kalshi.com`
  * `api.exchange.coinbase.com`
  * `api.kraken.com`
  * `www.bitstamp.net`
  * `docs.kalshi.com`

  Network access is set in the cloud environment's settings (environment menu → Edit → Network access, or add
  these under Allowed domains). With access, a future session can pull the windows since Oct 13: genuinely
  untouched history.
* **Consequence.** No genuinely independent historical evaluation was possible. The holdout (Jul 22 – Aug 13) was
  examined during the 2.7 comparison of 15+ variants, so it is "previously examined" evidence. The independent
  evidence must come from the forward test, which 2.8 makes rigorous and tamper-evident.

## A. Research findings: what was investigated, beyond re-checking

1. **The trading opportunity is structurally small.**
   * When 2.6 is LOCKED at fixed times from T−60 to T−3, the median Kalshi ask is 99.9 ¢. Only 0.5–4 % of those
     windows offered ≤ 99 ¢.
   * The model's information is mostly already priced. TRADE NOW fires in about 7 % of windows, and those are the
     moments the market disagrees, which is where adverse selection lives.
2. **Adverse selection is measurable** (new; development data only). Among LOCKED calls, the realised loss rate
   rises as the ask falls:
   * logit(loss) = −2.61 + 0.66 · logit(1 − ask), LR test p = 0.037;
   * implied loss 0.36 % at 99 ¢, 0.56 % at 98 ¢ and 1.05 % at 95 ¢, against a model claim of ≤ 0.5 %;
   * the edge survives at mid prices on this fit (98 ¢: about +1.2 ¢).

   This becomes the pre-registered shadow candidate **F**. It is not a production change, because it was fitted
   on development data.
3. **Calibration is not stationary, and it is the quiet regime that drifts, not the volatile one.**
   * Observed/expected flips for the recalibrated 2.6:

     | Regime | Jul–Aug holdout | Sep–Oct dev | CIs overlap? |
     |---|---|---|---|
     | quiet | 0.25 | 1.24 | no |
     | normal | 0.53 | 1.11 | no |
     | active | 0.91 | 0.89 | yes |

   * The same displayed probability has meant realised rates differing by up to 5×. 2.8 therefore shows the flip
     risk with a band of that range (display only).
   * The high-volatility adjustment you suspected after Oct 12 is the **best-supported** part of the recalibration:
     it is calibrated in both periods.
4. **Settlement-flipping risk concentrates before the last few seconds.** A shock of size X at τ seconds moves the
   60-print average by X·(τ+1)/60. In 204 settlement-flipping injected jumps, none happened in the last 3 s, even at
   $150. The final-second risk is real but small. Risk from T−60 to T−10 is where losses come from.
5. **Pareto analysis of the 15 prior variants.** No deployable variant dominates 2.6 in both periods:
   * on the holdout, 2.6 is dominated by C (no recalibration);
   * on dev, only by AgS (needs the official-feed entitlement).

   The defensible decision is to keep 2.6 and resolve the contenders prospectively.
6. **Statistical power** (new; this sets expectations).
   * **LOCKED reliability:** if the true LOCKED loss rate is 0.37 %, proving it is below 0.75 % takes about 1,400
     forward LOCKED windows (about 17 days); below 0.5 % takes about 8,700 (about 100 days).
   * **TRADE NOW edge:** a +0.86 ¢ edge needs about 630 trades (about 90 days) for 80 % power.
   * Anything shorter cannot settle the economics.
7. **Three real defects in 2.6/2.7** (section G). One can produce a wrong actionable signal.

## B. Model competition

| Model | What it is | Evidence | Outcome |
|---|---|---|---|
| A — 2.6 | empirical fat-tail settlement-path tables by vol regime + regime recalibration + basis mixture | hold 3/1,879 (0.16 %), dev 13/3,484 (0.37 %) | **retained** (production policy of 2.8) |
| B — settlement-path Gaussian | same exact settlement arithmetic, Gaussian residual | hold 50/1,928, dev 160/3,563 | rejected (prior) |
| C — regime variants | strict 0.2 % (C1); no active down-weighting (C2); no recalibration (C) | C1 dev 5/3,471 but 22 s later and 35 % fewer trades; C2 dev 8/3,480, fewer trades; C better on holdout, worse on dev | **shadow C1, C2** |
| D — microstructure | veto LOCKED while an adverse taker impulse (2.1 detector) is live | no data here to test | **shadow D** |
| E — ensemble with the official reference | max(proxy, official) flip | emulated only; needs entitlement | **shadow E** |
| F — original: adverse-selection-aware value | TRADE NOW only if the edge survives the market-pooled prior | dev fit, p = 0.037 | **shadow F** |

All five candidates run in 2.8's shadow layer on the same live inputs. Each first call is committed to the ledger
before the outcome. The decision rules, with Holm-corrected multiplicity control, are frozen in
`2.8/PREREGISTRATION.md`.

## C. Mathematical explanation

* **Settlement.** YES iff round₂(avg of 60 one-second BRTI values in (close−60 s, close]) ≥ K.
  * With n recorded at average A, the remaining r = 60 − n must average below c = (60·(K − 0.005) − n·A)/r for a
    flip. 2.6/2.7 compute exactly this; it is verified against brute force on 20,000 states with 0 violations.
  * The flip probability is P(mean of the remaining path ≤ c). Its scale shrinks like
    √(Σ remaining-print variance) ≈ σ·√(r³/3)/60. That is why late cushions look enormous in "sigmas".
  * Those sigmas are not probabilities. The tail is fat, which is why the Gaussian model loses 10× more often.
* **What makes 2.6 work.** It replaces the Gaussian with empirical standardised path tables per horizon and per
  volatility bucket. Quiet tape has fatter standardised tails: jumps do not scale with diffusive volatility. It
  then integrates over the empirical basis (proxy versus official) distribution.
* **What it lacks.** No new information source beat it in the evidence available. The documented gaps are:
  * non-stationary calibration in quiet regimes;
  * no use of the market price as information, beyond the 90 ¢ guard;
  * a proxy index instead of the official BRTI unless the key is entitled.

## D. Failure analysis

* **Historical losing LOCKED calls** (prior session; tapes unavailable here):
  * 3 holdout and 13 dev for 2.6.
  * Of the 15 losses in 2.5 (same engine before recalibration), 12 were genuine path reversals and 3 were basis
    errors (proxy versus official, all DOWN calls, basis +$5 to +$8.5). 13 of the 15 were in the three lowest volatility buckets (0–2: all of quiet and part of normal).
  * The quiet tape has the worst calibration drift, which is consistent with finding A3.
* **Oct 12 20:45 ET.**
  * 2.6 was never LOCKED, only HIGH CONFIDENCE. It peaked at 99.43 % at T−18 (raw 1.09 % flip, 0.57 % after the
    active-regime ratio).
  * That required the remaining 18 prints to average $48.66 below spot.
  * The empirical frequency of a ≥ $50 remaining-average shift at T−20 is 0.27 % two-sided, and active tape runs
    about 3× the average excursion rate. That gives roughly 0.4–0.5 % one-sided. In the active 0.5–1 % band,
    realised flips were 0.82 % against 0.875 % predicted (dev).
  * **Conclusion:** an appropriately modelled rare event, not a miscalibration. Nothing was weakened or
    strengthened to make it disappear.
  * Economically, UP at 99.8 ¢ had negative EV at 99.43 %, and 2.6 correctly issued no TRADE NOW.
* **Prospective.** The prior session's live paper runs on Oct 13 (a handful of windows) were all correct. That is
  far too few to mean anything. There is no forward record yet; it starts when 2.8 is deployed.
* **Software failures found here: D1–D3** (section G).

## E. Economic analysis

| | trades | lost | avg price | break-even loss | 95 % upper loss | mean P&L / contract | edge proven at 95 %? |
|---|---|---|---|---|---|---|---|
| holdout, cautious fills | 32 | 0 | 97.75 ¢ | 2.05 % | 8.94 % | +2.05 ¢ | no |
| dev, cautious fills | 261 | 2 | 98.2 ¢ | 1.60 % | 2.39 % | +0.86 ¢ (CI −0.21..+1.92) | no |
| dev, fills at the price seen | 336 | 2 | 97.9 ¢ | 1.90 % | 1.86 % | +1.32 ¢ | barely (optimistic fill) |
| pooled cautious | 293 | 2 | 98.15 ¢ | 1.65 % | 2.13 % | +0.97 ¢ | no (Jeffreys P(edge) 0.92) |

* **Scale.** About 4.7 cautious trades a day at about $0.47 a day per 10-lot. Maximum drawdown is at least one full
  loss, about −98 ¢ per contract, which erases about 100 winning trades.
* **Order size matters at these prices.** The fee is rounded up per order: 1 contract at 99 ¢ pays 1 ¢ (the whole
  gross edge), 10 contracts pay 0.1 ¢ each. 2.8 shows the expected value for 1/5/10/25/50/100 contracts from the
  live ask ladder.
* **Unverified fee inputs.** Third-party sources disagree on cent versus $0.0001 rounding and on maker fees for this
  series. 2.8 reads `fee_type` / `fee_multiplier` from Kalshi's series record at runtime and assumes cent rounding,
  the conservative reading.
* **Exit on REVERSAL WARNING** roughly breaks even (prior): not a source of edge.
* **Entry timing.** Earlier LOCKED calls (1 % threshold) add trades but not profit per trade (dev +0.46 ¢). Later
  ones (0.2 %) cut losses but also the opportunity count. No timing policy showed a demonstrable economic
  improvement over 2.6.

## F. Independent validation

| Evidence | Status |
|---|---|
| Truly untouched history | none available in this environment (network blocked; prior tapes lost) |
| Holdout Jul 22 – Aug 13 | clean with respect to the 2.6 tail tables (fitted Aug 13 – Oct 13), but examined during the 2.7 variant comparison |
| Dev Sep 4 – Oct 13 | overlaps the tail-table fit period; out-of-sample only if the missing walk-forward script refit per fold (unverifiable here) |
| Prospective | none yet. 2.8 makes it possible: commit-before-outcome hash-chained ledger, frozen config hash, independent evaluator (`tools/forward_report28.js`) and pre-registered gates. Minimum 21 days and 1,500 LOCKED windows. |

## G. Engineering improvements (implemented and tested)

* **D1 (major; actionable).** When the live index failed venue quorum (≥ 2 venues alive but no consensus), the
  engine used the last good 1 Hz value as if it were 0 ms old. No gate fired and quality read GOOD.
  * Reproduced on 2.6 and 2.7 as LOCKED UP + TRADE NOW at T−45 with the live index unavailable.
  * Exposure lasts up to about 2.5 s per incident. 2.8 makes it a hard gate (DATA UNRELIABLE).
* **D2 (major; display).** Official BRTI ticks were judged fresh by arrival time, so a value 60 s old at its source
  was accepted and labelled OFFICIAL. 2.8 uses the source time too.
* **D3 (minor).** A zero-size best ask level was shown as the "buy at ≤" price. 2.8 filters it.
* **Fee schedule** from Kalshi's series record, exact integer fee arithmetic, and an expected-value table by order size.
* **Display.** The three decisions are shown separately (outcome confidence, trade value, execution readiness); flip
  risk has an uncertainty band; and the designations are PREDICTED LOCKED / MATHEMATICALLY FINAL / OFFICIALLY SETTLED.
* **Ledger and monitors.** A hash-chained, append-only ledger (resumes across restarts when on disk) and anytime-valid
  failure-alarm and proof-of-edge monitors. Their Monte-Carlo type-I error is 3.2 % and 2.1 %, against a 5 % limit.
* **Shadow and replay.** Five shadow candidate policies run on identical inputs. A record/replay tape lets the
  production `computeLockSnapshot` reproduce any live decision: LIVE = REPLAY shown on 4,800 decisions.
* **Operations.** Latency percentiles at every stage (snapshot, `/radar`, index age, book age, browser display age);
  `/ledger`, `/ledger/verify`, `/shadow`, `/monitors`, `/latency`, `/fees`, `/tape`, `/v28`.
* **Tests:**

  | Suite | Result |
  |---|---|
  | selftest | 128/128 |
  | core | 55/55 |
  | page | 38/38 |
  | fuzz | 20,000 cases, 0 violations |
  | replay parity with 2.7 | 0 mismatches / 17,458 |
  | live-path simulation | pass |
  | adversarial scenarios 1–20 | 24/24 |
  | settlement arithmetic | 18/18 |
  | BRTI mock | 4/4 |

  `bash pinradar-research/2.8/test/run_all28.sh` re-runs everything in about 4 minutes.

## H. Performance measurements (directive table)

Historical rows come from the prior session's development / holdout results. They are reported, not recomputed;
raw data unavailable. 2.8's decisions equal 2.6's on these inputs: verified on a 58-contract real sample, and by
construction elsewhere except D1–D3 situations.

| Measure | 2.6 baseline | 2.8 candidate | Difference | Data |
|---|---|---|---|---|
| Independent contracts evaluated | 2,120 hold / 3,765 dev | same | — | previously examined |
| LOCKED predictions | 1,879 / 3,484 | same | 0 | hold / dev |
| Incorrect LOCKED | 3 / 13 | same | 0 | hold / dev |
| False-LOCKED rate | 0.16 % / 0.37 % | same | 0 | hold / dev |
| 95 % bounds (two-sided CP; one-sided upper) | [0.03, 0.47] %, 0.41 % / [0.20, 0.64] %, 0.59 % | same | — | hold / dev |
| Brier score | not in the surviving results | — | — | unavailable |
| Calibration error (ECE at T−60…T−3) | 0.34–1.40 pp / 0.36–0.74 pp | same | 0 | hold / dev |
| Actionable opportunities (TRADE NOW, cautious) | 32 / 261 | same | 0 | hold / dev |
| Mean / median lead | 100 s / 77 s (both) | same | 0 | hold / dev |
| Realistically fillable trades | 32–43 / 261–336 (cautious–visible) | same | 0 | estimated from Kalshi tape |
| Net profit after fees | +2.05 ¢ / +0.86 ¢ per contract | same | 0 | estimated; CI includes 0 on dev |
| Maximum drawdown | ≥ 1 full loss (≈ −98 ¢ / contract) | same | — | estimated |
| p99 decision compute | 0.113 ms | 0.123 ms | +0.01 ms | measured here (benchmark) |
| p99 end-to-end signal latency | not instrumented | instrumented (`/latency`) | — | measurable only after deploy |
| Data-integrity failure on venue quorum loss | LOCKED/TRADE NOW possible | DATA UNRELIABLE | fixed | reproduced (SIM) |

## I. Implementation

See `2.8/README_2.8.md`:
* exact files and paths;
* side-by-side Render install on a new branch;
* page as a new file;
* environment variables;
* verification;
* forward-test procedure;
* rollback.

Built artifacts:
* `btc-ai-backend: pinradar-research/2.8/dist/pinradar_server.js`;
* `Btc-signal: pinradar-research/2.8/btc_pin_radar_28.html`.

Both are built by sha-checked patch scripts from the preserved 2.7 files.

## J. Verdict, precisely

**CONDITIONAL PASS.**

Supported:
* The candidate preserves the validated 2.6 decisions (0 mismatches on every replay and fuzz check).
* It fixes three reproduced defects, one of which could issue a TRADE NOW on stale data.
* It passes every integrity, invariant and adversarial test run here.
* It adds the instrumentation that makes the next claim testable.

Not supported:
* Any predictive improvement: none was claimed and none was shown.
* Any economic improvement: the edge is unproven.
* Performance on independent data: none was obtainable.

Adoption requires the pre-registered forward gates G1–G6. Any profitability claim additionally requires G7 and,
ultimately, real fills.
