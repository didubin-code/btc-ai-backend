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
| D. Independent replica of the algorithm on independent feeds | Reconstructed, not observed; differs in feeds and timing | None | Kept only as research (`research/RESULTS.md`), always labelled "reconstructed" |

Option A records what production actually showed, at second resolution, through endpoints production already serves to anyone with its URL.
* The order books are the observer's own: 1 Hz in each market's final 300 s, every 15 s before that.
* Results come from Kalshi's public API: `result`, `expiration_value` and `settlement_ts`.

## 3. Components

```
observer.js          CLI: keypair | signkey | run | verify | anchor | derive | report | export | backup | restore-test | keygen (tests)
lib/http.js          GET-only client with an allowlist of read-only paths (Pin Radar and Kalshi public market data only)
lib/sources.js       collectors: Pin Radar exports (cursors, restart detection, catch-up) and Kalshi public data
lib/store.js         append-only, hash-chained, compressed and encrypted segment store (crash-safe)
lib/derive.js        per-market evidence, rebuilt from the raw records at any time
lib/fills.js         book normalisation, theoretical purchases with Kalshi's fee
lib/stats.js         Clopper-Pearson, Wilson, Bayesian posteriors, day-block bootstrap, Monte Carlo, drawdown
lib/report.js        daily, weekly and monthly summaries
research/            reconstructed historical analysis of the 0.2 % / two-minute hypothesis (research/RESULTS.md)
test/                isolation, unit, durability (one test per durability-review finding), independent math, end-to-end
                     against production's own code (run them all with node test/run_all.js)
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
* `health`:
  * `obs.start`: cursors, where they came from, state-file status, the newest stored record;
  * `obs.stop`, `obs.heartbeat`;
  * `obs.gap`, with from/to and the reason: the observer was down, or records could not be written;
  * `obs.writefail`: writes failed and were retried, nothing lost;
  * `obs.stall`: a polling lane was busy;
  * `obs.checkpoint`, `obs.error`, `store.recovered`.
* `derived`: one entry per derive (the SHA-256 of its output and the evidence it was built from) and per report (the full report).
* `audit`: who ran which command, and when.

**Record format.** Each record is stored as:
```
{ s: seq, t: ms, p: prevHash, i: iv, c: ciphertext, g: tag, h: SHA-256(s|t|p|i|c|g) }
```
A key record (public-key mode) is stored as:
```
{ s, t, p, wk: wrapped data key, kid, h }
```

**Derived market record.** `derive` writes one record per market, as soon as the market is final. The output also carries `evidence`: each stream's records, sequence and head hash, the checkpoint check, and the `--since` / `--until` window by close time. Each record has:
* `market`: open, close and expiration times, strike, rules, source.
* `settlement`: `result`, `outcome` (UP/DOWN), `expirationValue` (Kalshi's official 60 s BRTI average), `settlementTs`, `status`, `recordedAt`, `source`.
* `production`: build, version and `lockMaxFlip` in force (from the nearest `/health`).
* `coverage`:
  * seconds observed out of 300 (seconds 0–299 of the final 300 s, from Pin Radar's own rows), missing seconds, longest gap;
  * observer gap, production restart inside the final 300 s, anomalies (a production clock step from row order, duplicate seconds far apart);
  * `status`: `complete`, `partial` or `unobserved`;
  * `books`: usable snapshots, failed requests, longest gap.
* `signal` (first LOCKED) and `qualified` (first LOCKED with `pFlip` ≤ 0.002). Each has:
  * `ts`, `utc`, `tau`, `side`, `state`, `pFlip`, `pFlipCons`, displayed ask, action, gates, official reference;
  * `won`;
  * `observedToClose`: every second from the signal to the close observed, with no production restart in between;
  * `timingCertain`: every earlier second observed, so this really is the first such second;
  * `flags`: `unlockedLater`, `directionChangedLater`, `reversalWarningLater`, `riskRoseAboveThresholdLater`;
  * `category`: one of `continuous-won`, `unlocked-won`, `warned-won`, `changed-direction-won`, `wrong`, `won-partially-observed`, `outcome-unknown`.
* `atT120`: the state at close − 120 s (or `unobserved`). `lockedAnywhereInLast120`.
* `events[]`: every state or side change, every rise of `pFlip` above 0.2 % while LOCKED, and every official-reversal flag.
* `pricing.{qualified,firstLocked}`:
  * `clock`: verified, with the offset interval [`offsetLoMs`, `offsetHiMs`] from `/health` samples within 15 min;
  * `fee`: rate and source;
  * production's displayed ask;
  * `atSignal`: the newest book **received before the earliest possible time of the signal**. It gives the UP ask, DOWN ask, spread, called-side levels and age, and theoretical purchases at $100, $1k, $5k, $10k, $25k, $50k, $75k, $100k and $250k. Each purchase shows contracts, average and worst price, fees, capital, net if won or lost, net for the actual outcome, return, fully fillable, and unfilled dollars.
  * `atSignal` is instead `unavailable` with the reason: no book, stale book, or clock unverified.
  * `afterSignal`: the next book after the latest possible signal time, with prices only (no theoretical purchases). It is labelled as such and never used as the signal's price.

**Retention.** Nothing is deleted. One-second books are compressed before encryption, and unchanged books are stored as references.
* Estimate: about 300 book snapshots a market at roughly 1–1.5 KB each, 96 markets a day, plus prediction rows. That is roughly 1–1.5 GB a month.
* Measure it in the first week; the `status.json` record count helps.

## 5. Confidentiality, security and what verification proves

* **Encryption at rest.** Every record is compressed, then encrypted with AES-256-GCM (96-bit IV, 128-bit tag; sequence, time and previous hash bound as authenticated data).
  * **Recommended: public-key mode.** The host holds only the owner's **public** key (RSA-3072-OAEP), so it can write evidence but cannot read any of it. Each day and each process start gets a fresh random data key, wrapped with that public key.
  * The **private key stays on your computer**. It can be passphrase-protected (`OBSERVER_KEY_PASSPHRASE`).
  * Secret key files must be mode 600, and key files must live outside the data directory. Both rules are enforced on real paths, so a symlink cannot get round them.
* **No exposure surface.** The observer opens **no network port**: no dashboard and no API. Reports and exports are produced on your computer, by you, with the private key. The only plaintext the observer writes is `state.json` (cursors) and `status.json` (counts and times), both mode 600 and neither holding proprietary data. An optional dead-man's-switch ping (`--heartbeat-url`) is a plain GET with no data.
* **No write path.** The HTTP client can only GET, follows **no redirects**, requires HTTPS (except loopback), and caps response size while reading. Its allowlist covers Pin Radar's read-only exports and Kalshi's public market endpoints. Any `/portfolio` path, any POST and any other path is refused before sending. It holds no credentials for Pin Radar, Render or any Kalshi account.
* **No third parties.** Kalshi's public API receives only public tickers. No analytics, telemetry or AI service ever receives the data.
* **Note on the source.** Production serves these endpoints without authentication. The observer protects its copy, but the source itself is readable by anyone with the URL. That is production's existing behaviour, and the observer does not change it.

**What each check proves**

| Check | Proves | Does not prove |
|---|---|---|
| `verify` (no key) | No record was altered, inserted, removed or reordered after the first one | That the history was not rewritten from the start or cut at the end |
| `verify --key private.pem` | Plus: every payload is authentic for the key holder, i.e. "encrypted to the owner" | In public-key mode, "written by the observer": anyone holding the public key can produce validly encrypted records |
| `verify --sign-pub host.sign.pub.pem` | Plus: every checkpoint, written every 60 s and signed with the host's own Ed25519 key, matches the chain. A rewrite by anyone without the host's signing key fails. | That the host itself did not rewrite history; anything after the last checkpoint (`unsignedTail`) |
| `verify --anchors anchors.ndjson` | Plus: history up to each anchor is unchanged, which catches cuts and rollbacks | Changes after the newest anchor |

Run `observer.js anchor` regularly and keep the anchor file **off the host**, for example on your computer, in a private repository, by e-mail to yourself, or with a timestamping service. Anchors are only sequence numbers and hashes, so they reveal nothing proprietary. With anchors and the signing key both off the host's control, the remaining trust is limited to:
* the host operating honestly between anchors;
* Pin Radar's own responses, which are trusted as published.

**Audit trail.** derive, report, export, backup and verify-with-a-key write a "started" entry **before** decrypting, and refuse to run if they cannot. The entries record who, what and when. They document honest use; they are not an access control, because the key holder can read files directly.

## 6. Durability

Every item here has a test in `test/durability_test.js`, one or more per finding of the durability review.
* **Writes.**
  * Each batch is one `write` plus `fsync`.
  * A failed or short write (disk full, I/O error) is cut back to where it started, so the files never hold part of a batch and the head never moves past what is on disk.
  * The records stay **queued in memory** and are written when the disk works again. The interval is recorded as `obs.writefail`, or as `obs.gap` if records had to be dropped (beyond 50,000 queued) or the observer stopped first.
  * If even the cut-back fails, the stream is reopened, which re-reads its real tail.
* **One writer per stream.** A lease (`.writer.lock`: pid, host, time, random token) is renewed every 15 s.
  * A second observer on the same directory waits out the lease once, then refuses to start.
  * An expired lease (2 min), or one naming a dead process on this host, is taken over; the takeover is recorded and the old lease kept.
  * A container restarted under the same PID waits for its old lease to expire (at most 2 min, recorded) rather than guess.
  * A writer that finds its lease taken over stops at once (exit 3), so a chain can never fork.
* **Damage.** A torn final line is quarantined byte-for-byte and recorded. Any other damage **stops the store from opening**; it is never repaired automatically. A final fragment still being written is skipped by readers and reported by `verify` (`unterminatedTailBytes`).
* **Restarts.** The time not observed is measured from the **newest stored record**: the older of the two streams' newest records, so a stream that stopped being written cannot hide behind the other. It is recorded as an `obs.gap` and does not depend on `state.json`.
  * `state.json` (cursors) is replaced atomically with `fsync`, and only when nothing is queued, so it never points past data that is not on disk.
  * If it is missing, damaged or older than the store, that is recorded. Collection restarts 15 min before the newest stored record, and the catch-up fetches every market since. Implausible saved values are reset, and the reset is recorded.
  * Production's memory (about 25 h of prediction rows) is pulled again with a 120 s overlap. After a long outage, every market that closed in the gap is listed from Kalshi and fetched one by one. A catch-up that fails is retried every 5 min, and the cursor does not move until it succeeds.
  * Order books missed during an outage are gone. Those signals are priced "unavailable".
* **Polling lanes.** Kalshi books (1 Hz in the final 300 s), Kalshi metadata and results, and Pin Radar run in separate lanes, so a slow request in one never delays the others.
* **Production restarts.** These are detected from uptime and build. A new production ledger chain, or entries already dropped from production's memory, are detected and recorded.
* **Backups.** `backup --data <dir> --key owner.public.pem --to <dir>` is **append-only**: a destination copy must be a byte-prefix of the source. If the source got shorter or differs, the backup is refused and the last good backup is left untouched.
  * It is safe while the observer runs. Only whole lines are copied, so a write in progress is left for the next backup.
  * The manifest's heads are read from the copy itself.
  * Every backup keeps a manifest history.
* **Restore test.** `restore-test --from <dir>` restores into a temporary directory and checks:
  * every file against the manifest, refusing paths outside the expected layout;
  * the chain and decryption;
  * that **every head recorded by every earlier backup** is still present, so a rollback or rewrite of the backup fails.

  Do not run it while a backup into the same directory is running.
* **Large histories.** `derive` and `report` read the store record by record, in two passes that stop at the verified heads, so their memory stays at about one day of rows and books. In the test, 4,000 markets fitted in a 96 MB heap. `derive` writes each market as soon as it is final; `report` keeps one small summary per market. `--since` / `--until` select markets by close time.
* **Schedule.** Run backup daily to a second disk or a private cloud folder, then run restore-test.

## 7. Deployment

Deployment needs your approval because it needs a host.

1. **On your computer:** `node observer.js keypair --out owner`. Keep `owner.private.pem` and back it up.
2. **On the host:** `node observer.js signkey --out host`. Keep `host.sign.pem` on the host and copy `host.sign.pub.pem` to your computer.
3. **On the host**, with `owner.public.pem` and `host.sign.pem` **outside** the data directory, run:
   `node observer.js run --data /path/data --key owner.public.pem --sign-key host.sign.pem --pinradar https://<your-pin-radar-url>`
   Keep it running under a supervisor (systemd, launchd, or a background worker with a persistent disk). Optionally add `--heartbeat-url <dead-man's-switch URL>`.
4. **Every day on the host:** `backup --data /path/data --to <off-host dir> --key owner.public.pem` and `anchor --data /path/data --out <file you then copy off the host>`.
5. **Review, on your computer**, against a backup copy:
   * `restore-test --from <backup> --key owner.private.pem --anchors anchors.ndjson`
   * `verify --data <copy> --key owner.private.pem --sign-pub host.sign.pub.pem --anchors anchors.ndjson`
   * `report --data <copy> --key owner.private.pem --sign-pub host.sign.pub.pem --period daily --out report.json`
   * `export --data <copy> --key owner.private.pem --out <new dir>` gives the complete dataset as NDJSON.

**Host options:**
* **(a) An always-on computer of yours.** No new cost; data never leaves your control. Uptime is that computer's.
* **(b) A new small background worker with a persistent disk, or a small VM.** A paid resource, which needs **your approval of the cost**. Better uptime. The provider can stop or delete it, but cannot read the data, and cannot rewrite it undetectably past your anchors.

**Do not attach anything to the production service.**

## 8. Limitations (precise)

* **No live observation yet.** The build environment could not reach the production URL or Render, so the observer has not observed production. Live checks — Test 2 on live data and the live part of Test 10 — are pending the first deployment. Everything else was tested against production's own code (`VALIDATION.md`).
* **Production identity.** The production URL could not be confirmed. Documents name `btc-pin-radar.onrender.com`. The first `/health` record shows the build.
* **Timing resolution.** Production evaluates every 500 ms, but its prediction log keeps one row per second plus every state change. First-LOCKED timing is therefore exact to the logged second, and state changes are exact to the millisecond.
* **Prices.** Order-book prices are the observer's own 1 Hz snapshots. A theoretical fill assumes the recorded book was there for the order: no queue, latency or competition. It is an upper bound.
* **Settlement source.** CF Benchmarks BRTI ticks are not independently available without a CF Benchmarks licence. The official value is Kalshi's `expiration_value`. Production's `/brti-status`, recorded when available, compares its own accumulator with it.
* **History.** Nothing before the observer starts can be recovered beyond what production still holds in memory.
