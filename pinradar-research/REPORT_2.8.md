# BTC Pin Radar: research report and 2.8 candidate (Oct 14 2026)

## Verdict

**CONDITIONAL PASS for 2.8 as decision-support software.**
* It keeps the 2.6 prediction engine unchanged, except where a confirmed defect is fixed (D1–D6).
* It adds tested economics, evidence and monitoring layers.
* An independent adversarial review (round 3, section R3) confirmed 36 defect reports plus 1 found during
  verification, and refuted none. All are fixed, with a regression test each.
* It still needs the pre-registered forward test (`PREREGISTRATION.md` v2) before it replaces anything.

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
   * The model's information is mostly already priced. TRADE NOW fires in about 7 % of windows on dev (261/3,765),
     1.5 % on the holdout (32/2,120) and 5 % pooled. Those are the moments the market disagrees, which is where
     adverse selection lives.
2. **Adverse selection is suggested, not established** (exploratory; development data only; corrected in round 3,
   CVE-10). Among LOCKED calls, the realised loss rate appears to rise as the ask falls:
   * logit(loss) = −2.61 + 0.66 · logit(1 − ask), LR test p = 0.037. That p-value treats the 4,558 per-ask rows
     (14 losses) as independent, but there are 3,484 windows and 12 losses. Rescaled to windows, p ≈ 0.07. The fit
     also hinges on one loss among the 10 rows priced below 90 ¢ (without it b ≈ 0.29, p ≈ 0.47);
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
   * Caveat (CVE-17): one window whose leader lost usually crosses several bands, and the Poisson CIs count it in
     each. With a design effect of about 1.9–2.5, the normal-regime CIs nearly touch. The quiet-regime separation
     survives.
   * The high-volatility adjustment you suspected after Oct 12 is the **best-supported** part of the recalibration:
     it is calibrated in both periods.
4. **Settlement-flipping risk concentrates before the last few seconds.** A shock of size X at τ seconds moves the
   60-print average by X·(τ+1)/60. In 204 settlement-flipping injected jumps, none happened in the last 3 s, even at
   $150. The final-second risk is real but small. Risk from T−60 to T−10 is where losses come from.
5. **Pareto analysis of the 15 prior variants.** No deployable variant dominates 2.6 in both periods:
   * on the holdout, 2.6 is dominated by C (no recalibration);
   * on dev, only by AgS (needs the official-feed entitlement).

   The defensible decision is to keep 2.6 and resolve the contenders prospectively.
6. **Statistical power** (corrected in round 3: CVE-06, CVE-11).
   * **LOCKED reliability.** The earlier "about 1,400 windows" was the median-outcome sample size, i.e. only about
     50 % power. With the exact one-sided Clopper–Pearson bound, showing a rate below 0.75 % with 85 % power at a
     true 0.37 % takes about 3,000 LOCKED windows (about 35 days); the power is 47 % if the true rate is 0.5 %.
     The pre-registration (v2) now uses that design.
   * **TRADE NOW edge.** The pre-registered test is an anytime-valid e-process, not a z-test. At about 4.7 trades a
     day (98.15 ¢ average plus 0.2 ¢ fee), the chance it reaches e ≥ 20 within the 90-day maximum (about 420
     trades) is about 9 % at +0.86 ¢ and about 34 % at +1.32 ¢ (Monte Carlo). An edge above 1.65 ¢ is impossible at
     that price.
   * The economics will almost surely remain unproven within the pre-registered test.
7. **Six real defects in the 2.6/2.7 engine** (section G): D1–D3 found in the first audit, D4–D6 in the round-3
   review. D1 and D4 can produce a wrong actionable signal; D4's trigger is practically impossible.

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
    flip. 2.6/2.7/2.8 compute exactly this.
  * `test/props28.js` checks 20,000 random integer-cent states × 7 remaining averages (140,000 checks): 0
    violations. The 60/60 final rounding is also checked against exact integer arithmetic (20,000 checks, ties
    included).
  * The projected leader at an exact half-cent tie was DOWN in 166 of 1,611 tie states in 2.7 (float error). It
    is UP in all of them in 2.8 (CVE-13; display only).
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
* **Software failures found here:** D1–D6 in the engine (section G), and the evidence-layer defects of the round-3 review (section R3).

## E. Economic analysis

| | trades | lost | avg price | break-even loss | 95 % upper loss | mean P&L / contract | edge proven at 95 %? |
|---|---|---|---|---|---|---|---|
| holdout, cautious fills | 32 | 0 | 97.75 ¢ | 2.05 % | 8.94 % | +2.05 ¢ | no |
| dev, cautious fills | 261 | 2 | 98.2 ¢ | 1.60 % | 2.39 % | +0.86 ¢ (CI −0.21..+1.92) | no |
| dev, fills at the price seen | 336 | 2 | 97.9 ¢ | 1.90 % | 1.86 % | +1.32 ¢ | barely (optimistic fill) |
| pooled cautious | 293 | 2 | 98.15 ¢ | 1.65 % | 2.13 % | +0.97 ¢ | no (Jeffreys P(edge) 0.92) |

* **Scale.** About 4.7 cautious trades a day at about $0.47 a day per 10-lot. Maximum drawdown is at least one full
  loss, about −98 ¢ per contract. That erases about 60 winning trades: a win earns +1.65 ¢ at 98.15 ¢ plus a 0.2 ¢ fee, and a loss costs 98.35 ¢.
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
| Prospective | none yet. 2.8 makes it possible: commit-before-outcome hash-chained ledger, frozen config hash, independent evaluator (`tools/forward_report28.js`) and pre-registered gates (v2). Minimum 21 days and 3,000 LOCKED windows (about 35 days); published ledger heads required. |

## G. Engineering improvements (implemented and tested)

* **D1 (major; actionable).** When the live index failed venue quorum (≥ 2 venues alive but no consensus), the
  engine used the last good 1 Hz value as if it were 0 ms old. No gate fired and quality read GOOD.
  * Reproduced on 2.6 and 2.7 as LOCKED UP + TRADE NOW at T−45 with the live index unavailable.
  * Exposure lasts up to about 2.5 s per incident. 2.8 makes it a hard gate (DATA UNRELIABLE).
* **D2 (major; display).** Official BRTI ticks were judged fresh by arrival time, so a value 60 s old at its source
  was accepted and labelled OFFICIAL. 2.8 uses the source time too.
* **D3 (minor).** A zero-size best ask level was shown as the "buy at ≤" price. 2.8 filters it.
* **D4 (major; actionable; trigger practically impossible).** PROVEN LOCKED (a proxy price-only bound) skipped the
  official-BRTI gates.
  * The page could show TRADE NOW and "MATHEMATICALLY FINAL" while the official reference disagreed.
  * The verifier showed the same states and actions in 2.7. It needs the proxy and official values to differ by
    thousands of dollars, which is exactly the failure the gate exists for.
  * Now that state is withheld, like an ordinary LOCKED.
* **D5 (major; display).** An official REVERSAL WARNING kept the proxy's ">99.9 %" and its guarantee text. It is
  realistic: proxy/official gaps of $4–40 trigger it, in 1,192 of 1,664 grid cases. Now the official numbers are
  shown, and the trade-value box is voided.
* **D6 (major; display).** After the close, 58 or 59 official values counted as decided and were labelled
  "MATHEMATICALLY FINAL 60/60". With $0.60-lower final prints, a 58-value UP becomes DOWN. Now the label requires
  exactly 60/60.
* **Fee schedule** from Kalshi's series record, exact integer fee arithmetic, and an expected-value table by order size.
* **Display.** The three decisions are shown separately (outcome confidence, trade value, execution readiness); flip
  risk has an uncertainty band; and the designations are PREDICTED LOCKED / MATHEMATICALLY FINAL / OFFICIALLY SETTLED.
* **Ledger and monitors.** A hash-chained, append-only ledger and anytime-valid failure-alarm and proof-of-edge
  monitors, both latched at the first crossing.
  * The ledger resumes across restarts when on disk: streaming, torn-line and corrupt-row safe, with open windows
    restored. Section R3 lists the defects fixed there.
  * Monte-Carlo type-I error of the latched monitors: failure 2.8 % (3,000 windows at p = p0), edge 1.8 % (1,500
    trades at zero edge), against a 5 % limit.
* **Shadow and replay.** Five shadow candidate policies run on identical inputs. A record/replay tape lets the
  production `computeLockSnapshot` reproduce any live decision:
  * LIVE = REPLAY on 4,800 decisions (file tape) and on the in-memory `/tape`;
  * the same tape through **2.7's** `computeLockSnapshot` gives 0 differences, apart from the 7 D1 seconds.
* **Operations.** Latency percentiles at every stage (snapshot, `/radar`, index age, book age, browser display age);
  `/ledger`, `/ledger/verify`, `/shadow`, `/monitors`, `/latency`, `/fees`, `/tape`, `/v28`.
* **Tests:**

  | Suite | Result |
  |---|---|
  | selftest | 134/134 |
  | core | 61/61 |
  | page | 38/38 |
  | fuzz | 20,000 cases, 0 violations |
  | replay parity with 2.7 | 0 mismatches / 17,458 |
  | live-path simulation | pass |
  | adversarial scenarios 1–20 | 24/24 |
  | settlement arithmetic | 18/18 |
  | BRTI mock | 4/4 |
  | property tests (`props28.js`) | 140,000 settlement checks, 1,611 ties, 509,040 monotonicity evaluations, 10,005 recalibration evaluations: 0 violations |
  | round-3 regressions (`regress28.js`) | 44/44; every check fails on the build that had the defect |
  | 24 h soak | pass |

  `bash pinradar-research/2.8/test/run_all28.sh` re-runs everything in about 5 minutes and writes nothing tracked.

## H. Performance measurements (directive table)

Historical rows come from the prior session's development / holdout results. They are reported, not recomputed;
raw data unavailable. 2.8's decisions equal 2.6's on these inputs: verified on a 58-contract real sample, and by
construction elsewhere except D1–D6 situations.

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
| p99 background tick (snapshot + all 2.8 work) | 1.00 ms | 1.12 ms | +0.12 ms | independent reviewer's harness, same inputs (round 3). The earlier 0.113 / 0.123 ms figures had no script on the branch (CVE-12) and are withdrawn |
| p99 end-to-end signal latency | not instrumented | instrumented (`/latency`) | — | measurable only after deploy |
| Data-integrity failure on venue quorum loss | LOCKED/TRADE NOW possible | DATA UNRELIABLE | fixed | reproduced (SIM) |
| PROVEN LOCKED while the official reference disagrees | TRADE NOW + "PROVEN" possible | withheld | fixed (D4) | reproduced; trigger practically impossible |
| Numbers shown in an official REVERSAL WARNING | proxy ">99.9 %" | official flip risk | fixed (D5) | reproduced (1,192/1,664 grid cases) |
| "FINAL 60/60" with 58–59 official values | possible | 60/60 only | fixed (D6) | reproduced |

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

## R3. Independent adversarial review (round 3)

**Method.**
* A previous reviewer had written 23 scripts and was interrupted. Two agents re-ran and triaged them (18
  candidates).
* Two fresh finders worked in parallel: live integration (11) and claims vs evidence (18). Findings that
  restated a triage item were mapped to it and verified once.
* Seven verifier agents each tried to reproduce and refute every candidate with their own scripts on the
  unchanged round-1 build, and stated whether it was already in 2.6/2.7.
* A separate agent then reviewed the fixes themselves, in two rounds.
* The usage limit interrupted the run twice. Completed agent results were replayed from the workflow cache and
  never re-run.

**Outcome:**
* 36 of 36 candidates confirmed real, none refuted, plus 1 more found during verification.
* The fix review found 10 defects in the first round of fixes (R1–R10). All were reproduced and fixed.
* `test/regress28.js` has a check for every item. Each check fails on the build that had the defect and passes
  on the final build.

| Area | Findings (severity) | Fix |
|---|---|---|
| **LOCKED decision** | F3 PROVEN LOCKED skips the official gates (major; trigger practically impossible; in 2.7 too) | D4: withheld when the official reference disagrees |
| **LOCKED display** | F4/F15/LI-7 official REVERSAL WARNING shows the proxy's >99.9 % and a green +EV (major; realistic). F11/LI-6 "FINAL 60/60" with 58–59 values (major). Band nonsense in a reversal (minor). CVE-09 evidence text said 12/3,484 "out of sample" (major; in 2.7 too) | D5, D6, band only for the leader, AUDIT28 (13/3,484 labelled development, holdout 3/1,879, TRADE NOW CI) |
| **Trade value display** | LI-9/R3 green +EV next to MARKET DISAGREES, WAIT, or a gate | positive only for a LOCKED call nobody refused; veto shown; WAIT names the gate |
| **Fees** | F9/LI-1 a successful fee refresh broke the in-memory chain on every boot (critical: `/selftest` 500, every pull refused). LI-2/R9 a null, empty or tiny `fee_multiplier` zeroed the decision fee and could create TRADE NOW (major) | ledger entries are snapshots; the config is replaced, never mutated; multiplier accepted only in [0.1, 4] |
| **Ledger durability** | F13 one failed write discarded the whole chain at restart. F14 a torn line made every restart fail. F18 a 90-day resume needed 563 MB. R4 rows served before being stored could fork a pulled copy. R7 a complete last row was cut | in-order write retry; streaming resume (verified prefix kept, torn tail cut, intact row kept); `/ledger` serves durable rows only; the puller stops on a fork. 248 MB ledger resumed in 4.0 s / 313 MB RSS (was 666 MB and only 1,250 of 10,575 outcomes rebuilt) |
| **Restarts** | F2/LI-3 a restart erased or replaced the window's committed first call (critical). F5 a window closed during a restart vanished (major) | open windows, their calls and LOCKED side restored; restored windows settled from Kalshi; dropped windows count as unresolved |
| **Evaluator (`forward_report28`)** | F1/CVE-01 any chain break became a "segment" (critical). CVE-14 scored the outcome's copy. F10/CVE-02 alarm read at the end only. F12 Holm not monotone. F17 F untested. CVE-03 PASS without G1/G5/G6 evidence. R1 seq compared across restarts. R5 whole segments deletable or fabricable. R6 window attributed to the wrong config | segments only at seq 1 from the boot genesis; scored from first committed calls in file order; latched alarm; monotone Holm over 5; F's test; INCOMPLETE without evidence; published anchors per segment; config at call time; per-candidate verdicts |
| **Pre-registration** | CVE-06 G3 stages had ~52 % power; stage 1 failed on absence of evidence. CVE-11 G7 power overstated | v2 (before any data): one 0.75 % bound at ≥ 3,000 LOCKED windows (85 % power), FAIL only via the stop rule; G7 latched, power stated (~9 %) |
| **Calibration and latency evidence** | F6/CVE-04/LI-5 the in-memory `/tape` and `/latency` cover hours, not the test. F16 DATA UNRELIABLE rows in G5. LI-8/R8 browser latency forgeable | `calib` and hourly `latency` histograms committed to the ledger; DATA UNRELIABLE excluded; the browser series is informational; tape sample retention fixed |
| **Replay and tape** | F7 fee schedule not on the tape. F8 replay across restarts. LI-11 tape fills the disk in about 12 days. R2 the boot marker was never written (introduced by the LI-11 fix) | fee on the tape; boot markers; rotation at `TAPE_FILE_MAX_MB` |
| **Config hash** | K1 not every override covered; R10 credentials (official gates) not covered | every env override, the model tables, officialFeed and streaming |
| **Tests and claims** | CVE-08 the equivalence claim was not tested through `computeLockSnapshot` (minor: the adversarial scenarios did catch a promote-to-LOCKED mutant). CVE-12 three numbers had no script. CVE-13 tie projection (minor; in 2.7). CVE-16 `run_all` rewrote tracked files and needed a sibling checkout. CVE-10/15/17 statistics wording | cross-version replay in live_sim (mutant: 253 differences); `props28.js`; tie epsilon; non-mutating, self-contained `run_all`; sections A/C/E/H corrected |
| **Operations** | LI-10 a large `/ledger` or `/ledger/verify` blocked the event loop for 0.35–0.5 s | pages of ≤ 5,000; incremental verify |

**What held up** (checked by the reviewers and not changed):
* the settlement arithmetic and the 2.6 probability engine;
* the recalibration;
* the D1–D3 fixes;
* exception isolation of all 2.8 code;
* event-loop cost (bgTick p99 1.00 → 1.12 ms);
* bounded memory;
* fee parity at the default schedule;
* the e-process validity (type-I ≤ 5 %).

## J. Verdict, precisely

**CONDITIONAL PASS.**

Supported:
* The candidate preserves the validated 2.6 decisions except at the six reproduced defects it fixes:
  * 0 mismatches on the inner-function replay and the fuzz;
  * 0 differences from 2.7's production `computeLockSnapshot` on 4,800 recorded live decisions, apart from the D1
    seconds.
* D1 could issue a TRADE NOW on stale data. D4 could issue one while the official reference disagreed (trigger
  practically impossible).
* It passes every integrity, invariant, property, regression and adversarial test run here (section G).
* The forward-test machinery was hardened against every way the review found to miscount, lose, forge or
  prematurely pass evidence (section R3). Its gates now have stated power.

Not supported:
* Any predictive improvement: none was claimed and none was shown.
* Any economic improvement: the edge is unproven.
* Performance on independent data: none was obtainable.

Adoption requires the pre-registered forward gates G1–G6:
* at least 21 days and 3,000 LOCKED windows, about 35 days;
* published ledger heads.

Any profitability claim additionally requires G7 and, ultimately, real fills. At the development edge, G7 has only
about 9 % power within 90 days, so expect "unproven".

Still unverified here:
* the official BRTI path with real messages (entitlement);
* Kalshi's fee rounding unit;
* the model on any data after Oct 13.
