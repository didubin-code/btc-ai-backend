# Pin Radar 2.8 independent observer: final report (31 Oct 2026)

**Status:**
* The observer is **built and tested**.
* It is **not deployed** and **has not observed production**: production and Render are unreachable from the build environment.
* **Production is unchanged.**
* No continuous history exists yet. Collection starts only once the observer runs on a host you approve.

Details are in `README.md` (design, schema, operation), `VALIDATION.md` (tests and reviews, with verbatim output) and `research/RESULTS.md` (the hypothesis).

## 1. Architecture

* **A separate program**, `pinradar-observer/`. It reads only what production already publishes: `/predictions`, `/signals`, `/ledger`, `/health`, `/calibration`, `/shadow` and `/brti-status`. That is about 6 small GET requests a minute.
* **Kalshi data** comes from Kalshi's public market API: order books every second in each market's final 300 s, then results and fee schedules.
* **No exposure.** It opens no network port, sends no writes and holds no credentials.
* **Why this design.** With its default settings, production keeps its history only in memory and loses it at every restart. Its read-only exports already exist. Every alternative needed a production change or produced only reconstructed data (`README.md` §1–2).
* **Evidence store:**
  * every record is compressed and encrypted (AES-256-GCM) to **your** RSA-3072 public key, so the host can write but cannot read;
  * records are hash-chained;
  * checkpoints are signed with the host's own key;
  * anchors are kept off the host;
  * backups are append-only;
  * a gap is always recorded, never filled.

## 2. Evidence that production was not touched

* **Production code.** btc-ai-backend `main` is still `2b0d593`. `pinradar_server.js` SHA-256 is `0efd86c9…`, byte-identical to the validated 2.8 build.
* **Repository.** Since the pre-observer commit `b97eed6`, **0 files changed outside `pinradar-observer/`**. Every added or changed file is inside it, on branch `claude/btc-pin-radar-research-xpe585` only. Nothing was merged into `main`.
* **Trader 5.0** (Btc-signal): no commit in this work.
* **Render.** No restart, redeploy, configuration change, environment variable, disk or service change. There was no access, and none was attempted beyond a read-only reachability check, which the network policy refused.
* **Isolation test** (`test/isolation_test.js`): 20/20.

## 3. Implementation status

| Part | Status |
|---|---|
| Observer, store, derivation, reports, backups | **Done and tested** (all suites pass, §5) |
| Deployment and 24/7 collection | **Not started.** Needs a host and your approval of any cost |
| Live validation against production | **Not run.** Production unreachable from the build environment |
| Continuous history | **None yet.** It begins at deployment; earlier history cannot be recovered beyond the ~25 h still in production's memory |
| Production URL and settings | **Unconfirmed** (`btc-pin-radar-28.onrender.com` per the repository). The first `/health` record will show them |

## 4. Data schema

Covered in `README.md` §4:
* raw record kinds: Pin Radar rows as published, books, results, fees;
* health records: start, stop, gaps, write failures, stalls, checkpoints;
* the derived per-market record: market, settlement, production build and threshold, second-by-second coverage, first LOCKED and first 0.2 % signal with won/category/flags, T−120 state, events, and pricing at the signal with theoretical purchases at $100–$250k.

## 5. Validation

* **Tests 1–10** were all run offline on the final code, against **production's own code** in replay, and **all pass**:
  * isolation 20/20;
  * unit 53/53;
  * durability 14/14;
  * independent math 2,544/2,544 values;
  * end-to-end 12/12.
* **Not yet run:** the live parts of Tests 2 and 10 (`VALIDATION.md` §3).
* **Three adversarial reviews** covered integrity, security and durability. Every confirmed finding is fixed, and each has its own test.
* **Durability review.** The latest review found nine defects:
  * a failed write desynchronising the chain;
  * stale writer locks;
  * running out of memory on long histories;
  * backups taken during writing;
  * a one-shot catch-up;
  * a lost state file;
  * quadratic checks;
  * a blocked book lane;
  * a usage text.

  All nine are fixed and tested, including under a real disk-size limit and with competing observer processes (`VALIDATION.md` §5).
* **Defect caught before commit.** A defect I introduced in `report` during this work was caught by the new tests before it was committed. `report` is now also tested end to end.

## 6. Methodology

* **Signals.**
  * Production's own per-second rows: first LOCKED; first qualifying (LOCKED with displayed `pFlip` ≤ 0.2 %); the state at T−120; every change.
  * A wrong call always counts.
  * A win counts as clean only if every second from the signal to the close was observed.
  * "First" is certain only if every earlier second was observed.
* **Prices.**
  * Only a book received **before** the earliest possible signal time is used. Per-signal clock bounds come from `/health`.
  * A stale or uncertain book means "unavailable".
  * Theoretical purchases walk the recorded book with Kalshi's fee. They are never executed and are upper bounds.
* **Settlement.** Kalshi's official `result` and `expiration_value`.
* **Statistics.**
  * exact (Clopper–Pearson) and Wilson intervals;
  * Bayesian posteriors under four priors;
  * day-block bootstrap;
  * Monte Carlo;
  * a conservative expected value, with the loss rate at its one-sided 95 % bound.

## 7. Access and trust

* **Reading the data** needs your private key, which stays on your computer. The host holds only your public key and its signing key.
* **Commands.** You run `verify`, `report`, `derive`, `export` and `restore-test` on your computer.
* **Nothing is exposed.** There are no dashboards or endpoints, and nothing goes to analytics or AI services. Kalshi sees only public market tickers.
* **What you still have to trust:**
  * The host provider. It can stop or delete the host, and anything it alters after the newest anchor goes undetected until the next anchor. It cannot read the data.
  * Pin Radar's responses, which are taken as published.
  * Production's endpoints are readable by anyone with the URL. That is production's existing behaviour, unchanged.

## 8. Research conclusions (RECONSTRUCTED, not observed)

These come from replaying production's own 2.8 code on 25,982 real Kalshi contracts, with a substitute price feed (`research/RESULTS.md`).
* **"0.2 % LOCKED with ≤ 2 min left is 100 % accurate": not supported.** 21 of 23,884 were wrong: 99.91 %, with an error rate of 0.054 %–0.134 % at 95 %.
* **"About 98 % of markets qualify": not supported.** The figure is 91.93 %.
* **Error rate.** About 0.09 % overall. Signals first qualifying with ≤ 30 s left are worst, at 0.37 %.
* **Prices.** The median called-side price is 99.8 ¢. At 99.5 ¢ or more, which covers 74 % of priced signals, a $1,000 purchase averages about +$1.47 with 3 losses in 10,725. At the 95 % worst-case loss rate, that edge disappears.
* **Most defensible combination:** first qualifying with 60–31 s left, at 99.0–99.5 ¢. It gives about +$5.85 per $1,000 conservatively (1,051 cases, no loss). Treat it as a hypothesis to test on observed data, because:
  * the signals are reconstructed;
  * the prices are trade prints;
  * it was selected from many cells;
  * typical capacity is only about $1,200.
* **Size.** Orders of $50k–$75k would rarely have filled. At least $75k traded on the called side after the signal for only 3.3 % of signals.

## 9. Safety assessment

| Risk | Status | Evidence |
|---|---|---|
| Executing trades | Impossible by construction: no Kalshi credentials, GET only, public market paths only | Unit tests (allowlist, no account paths) |
| Writing to or slowing production | GET only, about 6 small requests a minute, no write path | Unit and static tests |
| Data exposure | No port; encrypted at rest; host cannot read; outputs never overwrite | Unit and end-to-end tests |
| Undetected tampering or loss | Chain, signed checkpoints, off-host anchors, append-only backups with restore tests; gaps recorded | Unit, durability and end-to-end tests |
| Misleading results | Wrong calls always count; no invented prices or seconds; research labelled RECONSTRUCTED | Unit tests; this report |

## What is needed to start collecting

1. **Choose a host and approve it.**
   * (a) An always-on computer of yours: no cost.
   * (b) A new small worker or VM: a paid resource that needs your approval.

   Nothing is attached to the production service either way.
2. **Confirm the production URL.**
3. **Run the deployment steps** in `README.md` §7. Then run it for one hour and compare `report` with what the Pin Radar page showed: the live Test 2 and Test 10.
