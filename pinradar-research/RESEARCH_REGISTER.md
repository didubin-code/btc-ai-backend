# BTC Pin Radar — research register

Every experiment, its data, its result, and whether it influenced model selection. Failed and rejected ideas are
recorded with the same care as accepted ones.

Data labels:
* **HOLD**: Jul 22 – Aug 13 2026, 2,120 windows. Untouched when 2.6 was built; examined during the 2.7 comparison.
* **DEV**: Sep 4 – Oct 13, 3,765 windows, walk-forward.
* **SIM**: synthetic.
* **FWD**: prospective, committed before the outcome.

Rows **P1–P16** were run by the previous research session (Oct 13). They are recovered from
`pkg27/research/CHECKPOINTS.md` and `pkg27/research/results/`. Their raw data is not available here, so they are
**reported, not reproduced**. Rows **R1–R22** were run in this session (Oct 14) and are reproducible from this branch.

## Prior session (reported; raw data unavailable)

| id | hypothesis / question | data | result | influenced selection? | status |
|---|---|---|---|---|---|
| P1 | 2.3 "CLEAR" is a usable outcome call | DEV | 2.3 CLEAR ≤60 s lost 145/4,304 (3.4 %); cautious P&L −4.1 ¢/contract | yes (motivated 2.5) | rejected |
| P2 | empirical fat-tail path tables beat a Gaussian | DEV + HOLD | Gaussian (B): 160/3,563 lost vs 13/3,484 | yes | accepted |
| P3 | standardised tails depend on the vol level (quiet tape → fat tails) | DEV | 7 sigma-bucket tables | yes | accepted |
| P4 | regime recalibration ratios (quiet 2.02 / normal 1 / active 0.52) | DEV walk-forward | dev 13/3,484 vs 15/3,486 without | yes (2.6) | accepted |
| P5 | LOCKED threshold 0.2 / 0.3 / 0.5 / 1.0 % | DEV + HOLD | 0.2 %: dev 5/3,471, lead 78 s; 0.5 %: 13/3,484, lead 100 s; 1.0 %: 40/3,512 | 0.5 % kept | trade-off |
| P6 | no active-tape down-weighting (Aq) | DEV + HOLD | dev 8/3,480 (vs 13), 177 trades (vs 261); hold identical | no | open → shadow C2 |
| P7 | short-horizon momentum predicts flips | DEV | weak, inconsistent sign | no | rejected |
| P8 | exit on REVERSAL WARNING improves P&L | DEV + HOLD | 11/12 losers warned, but 25 winners too; net −$6.6 to +$41 per 10-lot over 7 weeks; holdout negative | no | rejected |
| P9 | official-feed model (As) locks safely | DEV + HOLD (emulated) | more coverage (99.9 %) but dev 21/3,763 lost (0.56 %) | no (gate only) | rejected as a LOCK source |
| P10 | official gate on 2.6 (AgS) | DEV + HOLD (emulated) | removes 1 of 13 dev losses, no coverage cost | yes (2.7) | accepted, needs entitlement |
| P11 | TRADE NOW is profitable | DEV + HOLD | cautious 261 trades, 2 lost, +0.86 ¢ (CI −0.21..+1.92); visible fills +1.32 ¢ | — | unproven |
| P12 | market price below 90 ¢ on a LOCKED call = data problem | DEV | 1 of 10 lost | yes (guard) | accepted |
| P13 | jump stress (960 LOCKED windows, $5–100) | DEV + HOLD + SIM jumps | 437 flipping jumps, never stayed LOCKED; REVERSAL within 1 s in 436 | — | passed |
| P14 | Oct 12 20:45 ET incident | real tape | 2.6 HIGH 99.43 % at T−18 (raw 1.09 %, active ratio → 0.57 %), never LOCKED; UP ask 99.8 ¢ | no | rare event |
| P15 | 2.7 = 2.6 decisions without the official feed | replay of 2,049 contracts | 0 mismatches in 616,749 s | — | passed |
| P16 | market leader at 95–99 ¢ is mispriced | DEV | slightly over-priced unconditionally; LOCKED calls lose ~0.5× market-implied | — | informative |

## This session

| id | hypothesis / question | data | pre-stated success criterion | result | influenced 2.8? | status |
|---|---|---|---|---|---|---|
| R1 | the delivered files are what the reports say | git + package | hashes match the checkpoints and git | all match; rollback = live 2.3 byte-for-byte | — | verified |
| R2 | the 2.7 offline suite reproduces | package tests | all pass | 118/118, 28/28, fuzz 0, parity 0/12,642, mock 4/4 | — | verified (sample-limited) |
| R3 | reported CIs are correct | result tables | Clopper–Pearson match | every reported 95 % CI matches two-sided CP | — | verified |
| R4 | TRADE NOW edge is established | DEV + HOLD aggregates | CP95 upper loss < break-even | pooled cautious: 2/293 lost, upper bound 2.13 % > break-even 1.65 %; Jeffreys P(edge) 0.92 | yes (G7) | **not established** |
| R5 | the opportunity is economically meaningful | DEV + HOLD aggregates | — | ≈4.7 cautious trades/day, ≈$0.47/day per 10-lot at the reported edge; median ask when LOCKED 99.9 ¢ | yes (framing) | finding |
| R6 | adverse selection: a cheaper ask means a weaker LOCKED call | DEV (AUDIT_25 byAsk) | b > 0 at p < 0.05 | b = 0.66 (CI 0.05–1.14), LR p = 0.037; implied loss 0.36 % at 99 ¢, 1.05 % at 95 ¢ | shadow F only | promising, dev-only |
| R7 | calibration is stable across periods | HOLD vs DEV | O/E CIs overlap per regime | quiet 0.25 vs 1.24, normal 0.53 vs 1.11 (no overlap); active 0.91 vs 0.89 (stable) | yes (display band) | **unstable in quiet/normal** |
| R8 | the active-tape (high-vol) adjustment is the weak part (Oct 12 hypothesis) | HOLD vs DEV | — | the opposite: active is the only regime calibrated in both periods | no change | rejected hypothesis |
| R9 | Oct 12 was a modelled rare event, not miscalibration | shock tables + calibration | model flip within the empirical range | |avg shift| ≥ $50 at T−20: 0.27 % two-sided; active ≈ 3× → ≈0.4–0.5 % one-sided vs 0.57 % shown; active band 0.5–1 %: dev 0.82 % observed vs 0.875 % predicted | no change | consistent with a rare event |
| R10 | a variant dominates 2.6 on both periods (Pareto) | HOLD + DEV aggregates | dominance in both | none: C beats A on HOLD, AgS on DEV (needs feed), no proxy variant dominates in both | yes (keep A, shadow C1/C2) | finding |
| R11 | D1: index quorum failure is gated | code + repro | LOCKED impossible on a stale index | FAILED on 2.6 and 2.7: LOCKED + TRADE NOW with input age reported 0 ms | yes (fix) | defect fixed |
| R12 | D2: official freshness uses source time | code + repro | 60 s old source rejected | FAILED: age 0 → accepted as OFFICIAL | yes (fix) | defect fixed |
| R13 | D3: zero-size ask levels | code + repro | never the displayed ask | FAILED (display) | yes (fix) | defect fixed |
| R14 | probability monotone in cushion | 640,400 evals | 0 violations | 0 | — | passed |
| R15 | settlement arithmetic (critical average, rounding, tie) exact | 20,000 brute-force states | 0 violations | 0 | — | passed |
| R16 | fee arithmetic exact; 2.6 fee parity | 20,000 random + grid | 0 differences | 0; float trap 4×50 ¢ = 7 ¢ handled | — | passed |
| R17 | anytime-valid monitors control false alarms | SIM (Monte Carlo) | type-I ≤ 5 % | failure alarm 3.2 %, edge 2.1 %; power: 3× loss rate 99 % within 2,000 calls; 1 ¢ edge 77 % by 1,500 trades | yes | passed |
| R18 | 2.8 decisions = 2.7 decisions outside D1–D3 | 58 real contracts / 17,458 s + 20,000 fuzz | 0 mismatches | 0 / 0 | — | passed |
| R19 | LIVE = REPLAY through the production function | SIM clock, real July paths, 16 windows | 0 mismatches | 4,800 decisions, 0 mismatches; ledger/tape digests verified | — | passed |
| R20 | adversarial scenarios 1–20 | real paths + SIM shocks/faults | no flipping jump leaves LOCKED / TRADE NOW | 204 flipping jumps: 0 still LOCKED, 0 TRADE NOW, REVERSAL ≤1 s in 200 (4 marginal flips below the 10 % warning line); 24/24 checks | — | passed (not a guarantee) |
| R21 | jumps in the last 3 s can flip a settlement | SIM shocks | — | none did, even at $150: one shock moves at most 3/60 of the average | — | finding |
| R22 | tail tables were fitted outside the evaluation data | embedded model metadata | fit period disjoint from DEV | fit Aug 13 – Oct 13 overlaps DEV; DEV numbers are out-of-sample only if the (missing) walk-forward script refit per fold; HOLD precedes the fit | — | **limitation** |

## Candidates carried into the forward test (pre-registered, `2.8/PREREGISTRATION.md`)

`C1-strict-0.2` (P5) · `C2-no-active-recal` (P6) · `D-impulse-veto` (2.1 taker-impulse detector) ·
`E-official-ensemble` (P9/P10, needs entitlement) · `F-market-pooled-value` (R6).

## Considered and not built

| idea | why not |
|---|---|
| regime-free jump-hazard floor (absolute-dollar jumps) | it would block most quiet-tape LOCKED calls. Quiet calibration swung between 0.25× and 1.24× (R7), so a floor tuned to one period mis-fits the other. No raw data to fit it on here. |
| online recalibration from live outcomes | about 85 LOCKED calls a day at a ~0.3 % loss rate means a few losses a month: far too few to update ratios without chasing noise. The anytime-valid alarm (R17) is the evidence-based response instead. |
| microstructure features beyond the impulse detector (order-book imbalance, cross-venue lead) | 2.3 already computes them for the pin-pressure dial. No raw tape is available to test their incremental value, so they are logged via the tape for future study. |
| LLM in the decision loop | excluded by design: not reproducible, too slow. The 2.4+ AI read is off the hot path. |
