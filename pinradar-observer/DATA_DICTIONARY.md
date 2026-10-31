# Data dictionary and capture audit

Everything is stored encrypted, append-only and hash-chained under `/var/observer/data` on the Render disk. `derive` and `report` rebuild every derived figure from the raw records, so an independent reviewer holding the private key can reproduce every result. Export the decrypted raw data with `observer.js export`.

## Primary evaluation rule (frozen)

`rules/primary_v1.json`, id `pinradar-primary-v1`, frozen 2026-10-31T18:05Z, before any outcome on the Render disk was evaluated.
* **Freeze evidence.** Every `obs.start` record stores the rule's SHA-256, and every derived market record carries `primary.rule` and `primary.ruleSha256`.
* **Other rules.** Any other rule is exploratory. It must be saved as a new versioned file and validated only on data collected after its own freeze date.

## Raw records (stream `raw`; each carries the observer's send/receive times `tSent`/`tRecv`, HTTP status, server `date` and any error)

| kind | source (read-only) | contents |
|---|---|---|
| `pr.predictions` | Pin Radar `/predictions` every 30 s, plus a back-fill of up to ~25 h at first start | Production's own rows, **as published**: one per second plus every state change in each market's final 300 s. Fields: `ts` (production clock), `ticker`, `tau` (seconds left), `strike`, `state`, `side`, `pWin`, `pFlip` (reversal probability), `pFlipCons` (conservative bound), `action`, `ask` (displayed), `lockedSide`, `idx` (index), `gap`, `sigma` (volatility), `regime`, `ref` (official-reference estimate), `recAvg`, `crit`, `offPUp`, `offDiv`, `brtiAgeMs` (freshness), `gatesSoft`, `gatesHard`, `offRev`, `ms`. Also `orderBreaks` (production clock steps) |
| `pr.health` | `/health` every 60 s | Version, build, uptime (restart detection), LOCKED threshold (`tiers.lockMaxFlip`), production clock (used for per-signal clock bounds), prediction-log and state-file settings |
| `pr.signals`, `pr.ledger`, `pr.calibration`, `pr.shadow`, `pr.brti` | the corresponding endpoints | State transitions with gates; production's hash-chained ledger; calibration; shadow calls; BRTI status (production's accumulator against the official value) |
| `pr.restart`, `pr.clockstep`, `pr.ledger.newchain`, `pr.ledger.gap`, `pr.predictions.catchup*` | detected | Production restarts and clock steps, new or partly lost ledger chains, catch-up pulls and their failures |
| `k.markets`, `k.market` | Kalshi public API | Ticker, open, close and expiration times, `floor_strike`, rules text, price structure, `status`, `result`, `expiration_value` (official 60 s BRTI average), `settlement_ts` |
| `k.book` / `k.book.same` | Kalshi `/orderbook?depth=100` | Both sides' bids, up to 100 levels each (asks follow as 100 − the other side's bids), with sizes. Snapshots every 1 s in the final 300 s and every 15 s before that. `k.book.same` records that the book was unchanged at that time |
| `k.series` | Kalshi `/series/KXBTC15M` every 6 h | Fee type and multiplier, the fee source used for theoretical results |
| `k.result.missing`, `k.result.changed` | detected | A result still not final after 6 h; a finalized result that changed when re-checked 24 h later |

Stream `health` holds:
* `obs.start`: cursors, the rule's SHA-256, the newest stored record;
* `obs.stop`, `obs.heartbeat`, and checkpoints signed by the host key;
* `obs.gap`: an outage, or a write failure that lost records;
* `obs.writefail`: writes delayed but nothing lost;
* `obs.stall`, `obs.error`, `store.recovered`.

Stream `audit` records who ran which command. Stream `derived` holds output digests.

## Derived market record (one per 15-minute market, all 96 a day)

* **Market, settlement and production identity.** Includes the build and LOCKED threshold in force, and the source and retrieval time of every settlement value.
* **`coverage`:**
  * seconds 0–299 observed or missing, and the longest gap;
  * observer gaps, production restarts, clock anomalies;
  * book snapshots and failed book requests.
  * A window with no Pin Radar rows is `unobserved`; a missing quarter-hour is counted as a missing window.
* **`primary` (rule v1):**
  * `status`: `entry`, `no-qualifying-signal` (final 120 s fully observed), or `not-determinable` (never counted as "no signal" or a win);
  * the entry's time, seconds left, side, `pFlip`, `pFlipCons`, state, displayed ask and gates;
  * `entryType`: `existing-lock`, `new-crossing` or `unknown-prior`;
  * `timingCertain`; `won`; `observedToClose`; `category`;
  * `firstLater`: the first time LOCKED was lost, `pFlip` rose above 0.002, a reversal warning appeared, or the direction flipped, each a separate event.
* **`pricing.primary`:**
  * Only a book **received before** the earliest possible signal time is used; a stale (> 3 s) or uncertain book gives "unavailable".
  * It records ask and size on both sides, spread, age, and the called side's levels.
  * Theoretical purchases at $100–$250k walk the recorded book with Kalshi's fee, stating fully fillable or unfilled dollars.
  * The next book after the signal is labelled and never used as the signal's price.
* **Exploratory fields:** `signal` (first LOCKED anywhere), `qualified` (first ≤ 0.2 % anywhere), `atT120`, `events[]` (every state and side change). These support the broad analysis by time, threshold, price, liquidity, volatility (`sigma`, `regime`), weekday and hour.

## Not capturable without changing production (flagged, not invented)

* **Sub-second decisions.** Production decides every 500 ms but publishes one row per second plus state changes. A `pFlip` move inside a second without a state change is not visible.
* **Per-venue index ticks** (Coinbase, Kraken, Bitstamp). Only production's aggregates (`idx`, `gap`, `ref`, `recAvg`) are published.
* **Official BRTI ticks.** These are licensed by CF Benchmarks. Captured instead: Kalshi's official `expiration_value` and production's `/brti-status`.
* **Momentum,** as a published field. It can be derived later from the 1 Hz `idx` series.
* **Order-book depth beyond 100 levels a side,** and any book before the observer was running. Books are never reconstructed.
* **Actual fills.** Nothing is traded, so all purchase results are hypothetical upper bounds. Other traders' executions are public in Kalshi's trade history and can be fetched later. They are not stored live, because that would roughly double the storage (about 8,000 trades in one market's final 120 s, measured).

## Reports (`observer.js report`)

* **Coverage:** expected, recorded and missing windows, and exclusions.
* **Primary rule:** entries, no-signal, not-determinable, accuracy with exact and Bayesian intervals, entry types, and later-event frequencies.
* **Calibration and timing tables.**
* **Pricing and theoretical results:** by order size, with day-block bootstrap intervals. Days, not seconds or windows, are the resampling unit for dependence.
* **Not yet built (planned, from the stored data):**
  * a prospectively defined warning-exit policy, kept separate from hold-to-settlement results;
  * drawdown and worst-loss tables by order size.
