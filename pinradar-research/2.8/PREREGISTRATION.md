# Pin Radar 2.8 — forward-test pre-registration `pinradar-2.8-prereg-v2`

Written and committed **before any forward data exists** (2026-10-14). The git commit timestamp of this file is
the pre-commitment. Nothing below may be changed after the first forward outcome is recorded. A change creates
`…-prereg-v3`, and evidence collected under v2 stays scored under v2.

v2 replaces v1 (same day, still before any forward data). An independent adversarial review found that the
evaluation tool and the server could miscount or lose evidence. Section 7 lists every change. No forward outcome
was ever recorded under v1.

## 1. Why a forward test

Every historical window available to this project has already been examined. Jul 22 – Aug 13 2026 was the
holdout, and it was used to compare at least 15 variants. Sep 4 – Oct 13 was walk-forward development. The raw
tapes are not in this environment, and its network cannot reach Kalshi, Coinbase or Kraken. So no
untouched history exists here. The only clean evidence left is prospective: predictions committed to the
hash-chained ledger before Kalshi publishes the result.

## 2. Frozen configuration

* Server: `2.8/dist/pinradar_server.js`, the build of `2.8/build/build_server28.py` on the preserved 2.7 file.
  The SHA-256 is printed by the build and listed in `2.8/SHA256SUMS.txt`.
* Decision configuration hash: `CONFIG28_HASH`. It is shown on `/v28` and in the ledger's `boot` entry, and it
  covers all thresholds, recalibration ratios, policies, the pooling prior and the uncertainty band. It is a
  different number if any decision parameter or environment override changes. A forward record counts only if
  its boot entry carries the frozen hash.
* Production policy `A-2.6`:
  * LOCKED at recalibrated flip risk ≤ 0.5 % (`LOCK_MAX_FLIP=0.005`).
  * TRADE NOW at ≥ 0.5 ¢ conservative edge for 10 contracts, with a book ≤ 1.5 s old, ≥ 3 s left and an ask ≥ 90 ¢.
* Shadow policies, evaluated on the same inputs every tick. They never change what the page shows.

  | id | model | definition (frozen) |
  |---|---|---|
  | `C1-strict-0.2` | C | LOCKED at flip ≤ 0.2 % |
  | `C2-no-active-recal` | C | active-tape recalibration ratio 1.0 instead of 0.52 |
  | `D-impulse-veto` | D | no LOCKED / TRADE NOW while an adverse taker impulse is live and τ ≤ 90 s |
  | `E-official-ensemble` | E | flip = max(proxy model, official-reference model) when the official BRTI accumulator is live; otherwise = A |
  | `F-market-pooled-value` | F | TRADE NOW only if 100·(1 − max(pFlipCons, σ(−2.609 + 0.659·logit(1 − ask)))) − avg − fee ≥ 0.5 ¢ |

## 3. Unit of analysis and data rules

* Unit: one settled KXBTC15M window. For each policy, the evidence is the first LOCKED call (side, τ, flip risk)
  and the first TRADE NOW (side, ask, average fill price for 10 contracts, fee) committed to the ledger before the
  `outcome` entry for that window. The evaluation reads these from the committed `call` entries, the first per
  window, policy and event, including across restarts. It never reads them from the outcome's own copy.
* Counted windows have an `outcome` entry carrying Kalshi's official result. Each ticker is counted once. Some
  windows are reported but not scored:
  * windows marked `unresolved`;
  * windows that have a `window` or `call` entry but no outcome 45 min after the close (dropped, e.g. by a restart).

  Together these must stay under 2 % of windows (integrity gate).
* Fills are hypothetical: the visible Kalshi book at the decision second. They are never called executed or
  realised. Only real fills can establish real-money profitability.
* Never: retrospective entry times, later prices, dropping windows, per-second rows counted as independent outcomes.

## 4. Primary endpoints and acceptance gates (production policy A)

| Gate | Requirement | Basis |
|---|---|---|
| G1 correctness | `run_all28.sh` passes on the deployed build; every `/selftest` check passes | build integrity |
| G2 integrity | Each chain segment starts at seq 1 from its boot entry's genesis and verifies with no break. Any edited, deleted or unparsable row, sequence gap or unanchored start fails. Every head hash written down (`--anchor`) appears in the chain. Every scored call precedes its outcome. Unresolved plus dropped windows < 2 % | evidence validity |
| G3a reliability, stage 1 | ≥ 700 LOCKED windows: one-sided 95 % Clopper–Pearson upper bound ≤ 1.0 % | standard 0.5 % with 2× tolerance |
| G3b reliability, stage 2 | ≥ 1,500 LOCKED windows: upper bound ≤ 0.75 % | dev 0.37 % (13/3,484) |
| G3c stop rule | the anytime-valid failure monitor (H0: loss rate ≤ 0.5 %) must never alarm: e ≥ 20 at any point (running maximum; the alarm is latched, because Ville's inequality bounds sup E). Also more than 3 losses in any 200 consecutive LOCKED windows is an operational stop | 2.7 README rule |
| G4 coverage | LOCKED in ≥ 85 % of scored windows; mean first-LOCKED lead ≥ 60 s | 2.6 holdout 88.6 % / 100 s |
| G5 calibration | at τ = 60, 30 and 10 s, expected calibration error ≤ 1.5 pp. Pooled first-entry observed / expected flips over the 0.2–5 % bands has a 95 % CI whose lower end is ≤ 1.25 (no significant over-confidence beyond 25 %). Computed from the ledger's `calib` entries, committed before the outcome: the displayed P(UP) at the first tick at or below each τ (within 1 s) and at the first entry into each band. DATA UNRELIABLE states are not forecasts and are excluded. The tape is a diagnostic fallback only | 2.6 holdout/dev ECE 0.3–1.4 pp; drift 0.25–1.24 |
| G6 latency | p99 index input age at decision ≤ 3,000 ms; p99 snapshot compute ≤ 25 ms; p99 `/radar` compute ≤ 50 ms; p99 signal age when displayed ≤ 1,500 ms | staleness budget, page STALE rule |
| G7 economics (separate claim) | edge e-process (H0: mean P&L per contract ≤ 0) ≥ 20 on hypothetical fills ⇒ "edge established on visible-book fills". Otherwise TRADE NOW profitability stays **unproven**, whatever the point estimate | Ville's inequality |

Minimum period: 21 days and 1,500 LOCKED windows, whichever is later. Maximum: 90 days. Gates are evaluated
with `tools/forward_report28.js` on the pulled ledger, never on a server's in-memory summary alone.

Verdicts:
* Production adoption (decision support): G1–G6 pass.
* TRADE NOW profitability: G7 also passes, and then still only on hypothetical fills.
* An alarm in G3c, a failure of G2, or G3a failing at stage 1 ends the test with FAIL.

## 5. Candidate comparisons (secondary, multiplicity-controlled)

A candidate replaces A only if, on the same scored windows:

1. **Not less reliable.** Over windows where exactly one of the pair lost a first-LOCKED call, the candidate does
   not lose significantly more often (exact binomial on discordant pairs, one-sided α = 0.05).
2. **Better on its own pre-stated objective,** at Holm-adjusted α = 0.05 across the five candidates:

   | Candidate | Objective |
   |---|---|
   | C1 | fewer first-LOCKED losses (discordant-pair test), with coverage loss ≤ 2 pp and mean-lead loss ≤ 25 s |
   | C2 | fewer losses, with TRADE NOW count ≥ 85 % of A's |
   | D | vetoed windows' A-loss rate higher than A's overall rate (exact binomial) |
   | E | fewer losses at coverage within 1 pp of A. Requires the CF Benchmarks entitlement; otherwise not evaluable |
   | F | higher mean hypothetical P&L per TRADE NOW on windows where A traded (paired), without a lower total. Test: among A's trades that F declined, an exact one-sided binomial of A's losses against the mean break-even loss rate (100 − avg − fee)/100 of those trades. p = 1 if F's paired total is below A's |

   Holm is the step-down procedure: adjusted p-values are made monotone with a running maximum. A candidate whose
   objective cannot be evaluated has p = 1 and still counts in m = 5.

3. **Every production gate G1–G6 passes for the candidate.**

Expected power, stated in advance: at loss rates near 0.3 %, discordant pairs will number in the single digits
for months. The default outcome is therefore **keep A**. A candidate that is "not significantly different" is
not adopted.

## 6. What is explicitly not claimed

No pre-expiration state is a guarantee. "MATHEMATICALLY FINAL" before the close appears only for the price-only
bound (practically never), and never while the official reference disagrees. After the close it appears only with
the official accumulator at exactly 60/60. Absence of a failure alarm is not proof of safety. Hypothetical fills
are not executions.

## 7. Changes from v1 (before any forward data)

All changes come from the round-3 adversarial review (`REPORT_2.8.md` section R3). Each has a regression test
in `test/regress28.js` that fails on the v1 build.

| v1 problem | v2 rule |
|---|---|
| A chain break anywhere started a new "segment" that verified on its own, so an edited or deleted entry passed G2 | Segments start only at seq 1, from the boot genesis. Any other break fails G2 |
| Windows were scored from the outcome's own copy of the calls, so a restart could replace or erase a committed call | Scored from the committed `call` entries. The server also restores open windows at boot |
| A window dropped by a restart left no trace | Committed but unresolved windows count as unresolved |
| G3c read only the final e-value | Running maximum (latched alarm) |
| Holm was not step-down monotone, and F had no test (m = 4) | Monotone step-down over five candidates, with F's test defined |
| G5 used a tape that the in-memory endpoint keeps for only about 2.5 h, and included DATA UNRELIABLE rows | Committed `calib` ledger entries, DATA UNRELIABLE excluded |
| G1 named a fixed self-test count | Every self-test check passes |
