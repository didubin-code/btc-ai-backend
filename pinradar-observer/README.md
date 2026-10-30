# Pin Radar 2.8 independent observer

This is a separate program that records the evidence of production BTC Pin Radar 2.8, around the clock and without touching it. For every Kalshi 15-minute BTC market it records:
* what Pin Radar showed;
* what the Kalshi order book offered at that moment;
* how the market settled.

From these records it builds an auditable per-market record, theoretical (never executed) trades and statistics.

**It does not modify Pin Radar.** It changes no code, configuration, deployment, polling rate or environment variable. It writes nothing to production and is not part of Trader 5.0. It only reads what production already publishes, using about 5 small GET requests a minute, and Kalshi's public market data.

## 1. What production keeps, and for how long

This was established from the production source: btc-ai-backend `main` `2b0d593`, `pinradar_server.js`, SHA-256 `0efd86c9…`. That file is byte-identical to the validated 2.8 research build; see `BASELINE.json`.

| Record | Where it lives in production | Survives a restart? | Read-only export |
|---|---|---|---|
| Prediction log: one row per second plus every state change, final 300 s of each window. Fields: state, side, `pFlip`, `pFlipCons`, action, displayed ask, official-reference panel, gates. | memory, 30,000 rows (about 25 h) | only if `PRED_LOG_FILE` is set (default: not) | `GET /predictions?since=&ticker=&n=&format=ndjson` |
| Signal transitions with gates | memory, 5,000 entries | no | `GET /signals?n=` |
| 2.8 hash-chained ledger (calls committed before outcomes, calibration, digests) | memory, plus a file if `LEDGER_FILE` is set | only with the file | `GET /ledger?since=<seq>&n=&format=ndjson` |
| Index tape | memory, 3,000 samples | only with `TAPE_FILE` | `GET /tape` |
| Basis model and closed-window ledger | memory, plus a file if `PINRADAR_STATE_FILE` is set | only with the file | `/calibration`, `/health` |
| Shadow first calls priced on the visible book | memory | no | `GET /shadow` |
| Configured LOCKED threshold, uptime, build, clock skew, prediction-log status | runtime | — | `GET /health`, `GET /calibration` |

* **Defaults.** In code, all four `*_FILE` variables default to empty, and on Render the default path is `/tmp`, which is lost at every redeploy. With defaults, **production's history disappears at every restart or redeploy**.
* **Unknown production settings.** Whether production sets any of these variables could not be checked, because Render was not reachable from the build environment. The observer records `/health`, which reports `predictionLog.file`, `stateFile` and the ledger status, so the first observation answers it.
* **Past data.** Anything production lost before the observer starts cannot be recovered. History still in its memory, up to about 25 h of prediction rows, is collected on the first pull.

**Production's LOCKED threshold is 0.5 % by default** (`LOCK_MAX_FLIP` = 0.005) unless its environment sets it. So a production "LOCKED" is not the same as the 0.2 % hypothesis. The observer records production's configured threshold from `/health` and `/calibration`, and tests the 0.2 % condition separately, on the displayed `pFlip`.

## 2. Architecture chosen, and the alternatives

| Option | Fidelity | Production risk | Verdict |
|---|---|---|---|
| **A. Separate observer pulling production's own read-only exports, plus Kalshi public data** | Direct: production's own per-second record | About 5 GETs a minute against small, paged handlers; no writes | **Chosen** |
| B. Passive recorder of the web page's `/radar` calls | Same data, but `/radar` is a POST that runs the engine and may call OpenAI | Adds engine work and possibly cost on every call | Rejected |
| C. Existing log exports (Render logs, files on disk) | Production writes no signal history to its log; files need a disk or shell access | Needs Render access or configuration changes | Not available without changes |
| D. Independent replica of the algorithm on independent feeds | Reconstructed, not observed; differs in feeds and timing | None | Kept only as research (§8), always labelled "reconstructed" |

Option A records what production actually showed, at second resolution, through endpoints production already serves to anyone with its URL.
* The order books are the observer's own: 1 Hz in each market's final 300 s, every 15 s before that.
* Results come from Kalshi's public API: `result`, `expiration_value` and `settlement_ts`.

## 3. Components

```
observer.js          CLI: keypair | keygen | run | verify | derive | report | export | backup | restore-test
lib/http.js          GET-only client with an allowlist of read-only paths (Pin Radar and Kalshi public market data only)
lib/sources.js       collectors: Pin Radar exports (cursors, restart detection, catch-up) and Kalshi public data
lib/store.js         append-only, hash-chained, compressed and encrypted segment store (crash-safe)
lib/derive.js        per-market evidence, rebuilt from the raw records at any time
lib/fills.js         book normalisation, theoretical purchases with Kalshi's fee
lib/stats.js         Clopper-Pearson, Wilson, Bayesian posteriors, day-block bootstrap, Monte Carlo, drawdown
lib/report.js        daily, weekly and monthly summaries
research/            reconstructed historical analysis of the 0.2 % / two-minute hypothesis (§8)
test/                isolation, unit, independent math, end-to-end against production's own code
BASELINE.json        read-only baseline of the production source and repositories
```

## 4. Data schema

**Raw stream** (`data/raw/YYYY-MM-DD.jsonl`, one encrypted record per line, never changed):

| kind | contents |
|---|---|
| `pr.predictions` | `since`, `rows[]` as published: `ts` (production ms), `ticker`, `tau`, `strike`, `state`, `side`, `pWin`, `pFlip`, `pFlipCons`, `action`, `ask`, `lockedSide`, `idx`, `gap`, `sigma`, `regime`, `ref`, `recAvg`, `crit`, `offPUp`, `offDiv`, `brtiAgeMs`, `gatesSoft`, `gatesHard`, `offRev`, `ms` |
| `pr.signals`, `pr.ledger`, `pr.shadow`, `pr.calibration`, `pr.brti`, `pr.health` | the response as published |
| `pr.restart`, `pr.ledger.newchain`, `pr.predictions.catchup` | detected production restarts, new ledger chains, catch-up pulls |
| `k.markets` | open KXBTC15M markets: times, strike, rules text, price-level structure |
| `k.book` | full order book: bids for both sides, dollar prices, fractional sizes |
| `k.book.same` | a timestamped reference to an identical earlier book (evidence the book was unchanged) |
| `k.market` | market detail after the close: `status`, `result`, `expiration_value`, `settlement_ts` |
| `k.series` | fee type and multiplier |
| `k.result.missing` | no final result within 6 h |

Every raw record also carries `tSent`, `tRecv` (observer UTC ms), HTTP `status`, the server `date` header and any `error`.

**Other streams** (same record format):
* `health`: `obs.start`, `obs.stop`, `obs.heartbeat`, `obs.gap` (observer down or a lane stalled, with from/to), `obs.error`, `store.recovered`.
* `derived`: derived market sets and reports, with the raw record count they were built from.
* `audit`: who ran which command, and when.

**Record format.** Each record is stored as:
```
{ s: seq, t: ms, p: prevHash, i: iv, c: ciphertext, g: tag, h: SHA-256(s|t|p|i|c|g) }
```
A key record (public-key mode) is stored as:
```
{ s, t, p, wk: wrapped data key, kid, h }
```

**Derived market record** (`derive`):
* `market`: open, close and expiration times, strike, rules, source.
* `settlement`: `result`, `outcome` (UP/DOWN), `expirationValue` (Kalshi's official 60 s BRTI average), `settlementTs`, `status`, `recordedAt`, `source`.
* `coverage`: per-second coverage of the final 300 s (`complete`, `partial` or `unobserved`), longest gap, observer gap, production restart near the window, and book coverage.
* `signal` (first LOCKED) and `qualified` (first LOCKED with `pFlip` ≤ 0.002). Each has:
  * `ts`, `utc`, `tau`, `side`, `state`, `pFlip`, `pFlipCons`, displayed ask, action, gates, official reference;
  * `won`;
  * `flags`: `unlockedLater`, `directionChangedLater`, `reversalWarningLater`, `riskRoseAboveThresholdLater`;
  * `category`: one of `continuous-won`, `unlocked-won`, `warned-won`, `changed-direction-won`, `wrong`, `won-partially-observed`, `outcome-unknown`.
* `atT120`: the state at close − 120 s (or `unobserved`). `lockedAnywhereInLast120`.
* `events[]`: every state or side change, every rise of `pFlip` above 0.2 % while LOCKED, and every official-reversal flag.
* `pricing.{qualified,firstLocked}`:
  * `clock` offset and uncertainty;
  * production's displayed ask;
  * `atSignal`: the newest book **received before** the signal. It gives the UP ask, DOWN ask, spread, called-side levels and age, and theoretical purchases at $100, $1k, $5k, $10k, $25k, $50k, $75k, $100k and $250k. Each purchase shows contracts, average and worst price, fees, capital, net if won or lost, net for the actual outcome, return, fully fillable, and unfilled dollars.
  * `afterSignal`: the next book, labelled as after the signal and never used as the signal's price.

**Retention.** Nothing is deleted. One-second books are compressed before encryption, and unchanged books are stored as references. Expect roughly 1–2 GB a month; measure it in the first week.

## 5. Confidentiality and security

* **Encryption at rest.**
  * Every record is compressed, then encrypted with AES-256-GCM, with sequence, time and previous hash bound as authenticated data.
  * **Recommended: public-key mode** (`observer.js keypair`). The 24/7 host holds only a **public** key: it can write evidence but **cannot read any of it**. Each day, and each process start, gets a fresh random data key, wrapped with RSA-3072-OAEP. Reading, deriving and reporting need the **private key, which stays on your computer**. So the host, its provider, or anyone who breaks into it cannot read stored data.
  * A symmetric key mode exists for testing only.
* **In transit.** Kalshi is reached over HTTPS. Pin Radar is HTTPS if its URL is.
* **No exposure surface.** The observer opens **no network port**: no dashboard, no API, nothing anonymous.
  * Reports and exports are produced on your own computer, by you, with the private key.
  * Optional health signals are the plaintext `status.json` (counts and times only) and an alert only if you configure one. Neither contains proprietary data.
* **No write path.** The HTTP client can only GET. Its allowlist covers Pin Radar's read-only exports and Kalshi's public market endpoints. Any `/portfolio` path, any POST and any other path is refused before sending. It holds no credentials for Pin Radar, Render or any Kalshi account, so it cannot see your trades, balance or positions.
* **No third parties.** No analytics, telemetry or AI service ever receives the data.
* **Tamper evidence and audit.**
  * The hash chain detects any altered, inserted, reordered or removed record (`verify`), without needing the key.
  * The authentication tags detect altered ciphertext (`verify` with the key).
  * The `audit` stream records each verify, derive, report, export and backup.
* **Remaining trust dependencies (not removed by any design).**
  * The host's administrator can stop the observer, delete files or roll the whole directory back to an older copy. Deleting the newest records leaves a valid shorter chain. **Off-host backups plus periodically noting the chain head** (`verify` prints it) close that gap.
  * Pin Radar's own responses are trusted as published: the observer cannot know whether production misreports itself.
  * Anyone holding the private key can read everything.

## 6. Durability

* **Writes.** Each batch is one write plus `fsync`. A torn final line, from a crash or power loss, is moved byte-for-byte to `quarantine/`, recorded, and the stream continues. A corrupted earlier record **stops the store from opening**: it is evidence, and is never repaired automatically.
* **Restarts.** The observer resumes from `state.json` and records the outage as an `obs.gap`. Production's memory (about 25 h of prediction rows) lets it recover the signal rows it missed. Order books missed during an outage are gone, and those windows are priced "unavailable".
* **Backups.** `backup --to <dir>` copies the encrypted segments, which remain unreadable without the private key, and writes a SHA-256 manifest. `restore-test --from <dir>` restores into a temporary directory and verifies the chain and decryption. Run both daily, to a second disk or a private cloud folder.

## 7. Deployment

Deployment needs your approval because it needs a host.

1. Run `node observer.js keypair --out owner` **on your computer**. Keep `owner.private.pem` there and back it up.
2. On the host, put `owner.public.pem` **outside** the data directory, then run:
   `node observer.js run --data /path/data --key owner.public.pem --pinradar https://<your-pin-radar-url>`
   Keep it running under a supervisor (systemd, launchd, or a Render background worker with a persistent disk).
3. Every day: `backup --to <off-host dir>`, then `restore-test`.
4. To review, on your computer:
   * `verify --data <copy> --key owner.private.pem`
   * `report --data <copy> --key owner.private.pem --period daily --out report.json`
   * `export --data <copy> --key owner.private.pem --out <dir>` gives the complete dataset as NDJSON.

**Host options:**
* **(a) An always-on computer of yours.** No new cost; data never leaves your control. Uptime is that computer's.
* **(b) A new small Render background worker with a persistent disk, or a small VM.** A paid resource, which **needs your approval of the cost**. Better uptime. Its provider can stop or delete it, but cannot read the data in public-key mode.

**Do not attach anything to the production service.**

## 8. Limitations (precise)

* **No live observation yet.** The build environment could not reach the production URL or Render, so the observer has not observed production. Live checks — Test 2 on live data and the live part of Test 10 — are pending the first deployment. Everything else was tested against production's own code (§9).
* **Production identity.** The production URL could not be confirmed. Documents name `btc-pin-radar-28.onrender.com`. The first `/health` record shows the build.
* **Timing resolution.** Production evaluates every 500 ms, but its prediction log keeps one row per second plus every state change. First-LOCKED timing is therefore exact to the logged second, and state changes are exact to the millisecond.
* **Prices.** Order-book prices are the observer's own 1 Hz snapshots. A theoretical fill assumes the recorded book was there for the order: no queue, latency or competition. It is an upper bound.
* **Settlement source.** CF Benchmarks BRTI ticks are not independently available without a CF Benchmarks licence. The official value is Kalshi's `expiration_value`. Production's `/brti-status`, recorded when available, compares its own accumulator with it.
* **History.** Nothing before the observer starts can be recovered beyond what production still holds in memory.
