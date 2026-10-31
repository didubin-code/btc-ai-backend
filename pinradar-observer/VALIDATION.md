# Pin Radar observer: validation report

All tests below were run in the build environment on the final code, offline (`node test/run_all.js`). They made no network call to production, to Render or to any Kalshi account endpoint. The verbatim output is in §6.

## 1. The ten required tests

| # | Test | How it was run | Result |
|---|---|---|---|
| 1 | Production isolation | `test/isolation_test.js`. Production `main` commit and SHA-256 of all 6 production files compared with `BASELINE.json`. No tracked file modified in either repository. Since the pre-observer commit `b97eed6`, the branch only **adds** files under `pinradar-observer/`. Trader 5.0 unchanged. Observer code never loads the production module. | **Pass** (20/20) |
| 2 | Signal fidelity | `test/e2e_test.js`. The real observer runs against **production's own code**: `main:pinradar_server.js`, extracted from git and byte-checked, served through its own HTTP handler. Six real historical windows (Aug 2026) are replayed, the last one released in real time. First LOCKED, first 0.2 % signal, T−120 state and every state change are compared with the engine's own per-second output, recorded on a separate path. | **Pass** (6/6 windows identical). **Live production: not yet run** (§3) |
| 3 | Timestamp accuracy | e2e: seconds remaining against close time for every signal. Unit: T−120 checkpoint, seconds 0–299 coverage, a clock step from row order, per-signal clock bounds. | **Pass** |
| 4 | Pricing accuracy | e2e: the live window's price comes from a book received **before** the signal and equals what was served. Unit: later books never used; stale books, books inside the clock uncertainty, clock steps and missing clock samples all give "unavailable"; fee schedule taken from before the signal. | **Pass** |
| 5 | Settlement accuracy | e2e: every outcome and official value equals Kalshi's record. Unit: missing or non-final results give `outcome-unknown`, never a win; results are still polled 7 h after the close. | **Pass** |
| 6 | Mathematical accuracy | `test/math_test.js`. Every fill, fee, P&L figure, exact interval and posterior compared with `test/independent_check.py`. That checker was written separately, from a specification only, in exact rational / 50-digit arithmetic, and validated against closed forms. The research figures were also recomputed independently (§2). | **Pass** (2,544/2,544 values) |
| 7 | Durability | e2e: kill -9 mid-run and restart; all streams verify (chain, decryption, host-signed checkpoints, anchors). Unit: torn writes quarantined; damaged records refuse to open; single writer; clock stepping back over midnight; append-only backup refusing a cut source; restore-test detecting a rewritten backup; path traversal; empty manifests. `test/durability_test.js`: one or more tests per durability-review finding (§5), including a real observer under a 16 KiB file-size limit, real observers competing for one directory (one frozen past its lease), a 4,000-market derive under a 96 MB heap, and backups taken while a writer appends. | **Pass** (unit 53/53, durability 14/14) |
| 8 | Security | Unit:<br>• GET-only allowlist, HTTPS, redirects refused, oversized responses cut;<br>• no account paths;<br>• wrong key cannot read;<br>• no plaintext on disk; files mode 600; no listening port;<br>• key-file rules (600, no symlinks, outside the data directory by real path, RSA ≥ 3072);<br>• public-key mode cannot read;<br>• a rewrite with only the public key fails the signed-checkpoint check;<br>• anchors catch a cut;<br>• audit failure refuses export;<br>• outputs never overwrite. | **Pass** |
| 9 | Missing-data integrity | Injected into the tests:<br>• observer outage (kill -9);<br>• duplicate and out-of-order rows;<br>• holes before and after a signal;<br>• production restart in the window;<br>• production clock step;<br>• failed book requests;<br>• missing results;<br>• unobserved windows;<br>• corrupted and torn records;<br>• implausible saved cursors.<br>Each is flagged, and none produces a win or a price. | **Pass** |
| 10 | End-to-end | e2e: production's own code plus a mock Kalshi API, in real time, about 90 s per run. Collection, encryption, kill -9, restart, derive, `report` (command line, daily), export, verify. | **Pass** (12/12). **Live nonintrusive validation: not yet run** (§3) |

## 2. Independent checks of the research figures

`research/independent_hypothesis_check.py` was written by a separate implementer from written definitions, without access to `research/hypothesis_28.js`. Over the 25,982 replayed contracts it reproduces every one of these:
* every rate;
* the 22 wrong calls of 23,889;
* every time-interval table;
* every month;
* the continuity, warning and direction-change counts;
* the capacity figures.

It found one difference: 14,403 against 14,275 signals priced within 10 s. The cause was a timestamp-parsing bug in `hypothesis_28.js`: prints without a full fractional second were dropped. It was fixed, and the figures were rerun; see `research/RESULTS.md`.

## 3. What has NOT been validated, and why

* **Live production.** The build environment cannot reach `*.onrender.com` (its network policy blocks it) or Render's API, and no computer of yours was connected. So the observer has never observed production.
  * Test 2 against live data, and the live part of Test 10, are the first things to run after deployment.
  * Run `observer.js run` for one hour, then compare `report` with what the Pin Radar page showed for the same windows.
* **Production's settings.** It is unknown whether production sets `PRED_LOG_FILE`, `LEDGER_FILE` or `LOCK_MAX_FLIP`. The first `/health` record shows them.
* **The production URL.** The repository names `btc-pin-radar-28.onrender.com`. This is unconfirmed.

## 4. Adversarial reviews and their fixes

Three independent reviews covered:
* evidence integrity and look-ahead;
* security, confidentiality and isolation;
* durability and missing data.

Each reviewer demonstrated its findings with scripts. Every confirmed finding was fixed and has its own test:
* the first two reviews (and earlier missing-data findings) are below, tested in `test/unit_test.js` (marked "review:");
* the durability review's nine findings are in §5, tested in `test/durability_test.js`.

| Finding (reviewer's severity) | Fix |
|---|---|
| One global clock offset could price a signal from a book received after it, by up to 9.5 s in a demonstration (high) | Per-signal clock bounds from `/health` samples within 15 min. A book counts only if received before the earliest possible signal time. Disagreeing or missing samples mean the signal is unpriced. |
| Wrong calls in incompletely observed windows disappeared from the report (high) | Wrong calls always count. Clean wins need every second from the signal to the close. Unobserved quarter-hours are counted. |
| In public-key mode, anyone holding the public key could rewrite history that verified (high) | Host-signed checkpoints (`--sign-key` / `--sign-pub`) and off-host anchors. `verify` states what it proves. |
| Deleting one record changed the accuracy figure; derive and report did not check the chain (medium-high) | `readStream` enforces the chain. derive, report and export verify first and embed the heads. |
| A cut, deleted segment or rollback was undetected, and backup spread it (medium-high) | Append-only backup with prefix check, manifest history with heads, restore-test checks against earlier heads, anchors. |
| Redirects bypassed the allowlist (medium) | Redirects refused; HTTPS required; responses capped while streaming. |
| restore-test path traversal (medium) | Strict manifest paths, no symlinks, resolved-path check, always cleans up. |
| Two writers could fork a chain (medium) | Writer lock per stream. |
| Clock step at midnight split the chain (low-medium) | Segment names never go backwards. |
| Production clock step hid rows; restart and tolerance gave false clean wins (medium) | 120 s overlap; clock steps detected from row order; restart in window means partial; zero-missing-second rule. |
| A long outage silently skipped whole markets (medium) | Catch-up of every market closed in the gap, via Kalshi's list. Unobserved windows counted. |
| Fee taken from a later record; a null multiplier gave zero fees (medium) | Validated like production; taken from before the signal; labelled. |
| Truncated GCM tags were accepted (low) | 128-bit tags only. |
| Audit failures were silent (low-medium) | Audit written before decrypting; refuse if it cannot be written. |
| Plaintext outputs reused existing files and symlinks (low) | New files and new or empty directories only, mode 600/700. |
| Key handling: realpath, permissions, symlink, passphrase, RSA size (low) | All enforced. |
| `state.json` world-readable and able to pause collection (low) | Mode 600; implausible values reset and recorded. |
| Non-integer cursor values injected into queries (low) | Only safe integers become cursors. |
| New production ledger chain never pulled (found while testing) | `chainId` and `inMemoryFrom` checked on every pull. |
| Failed book requests counted as snapshots; book gap at the start of the final 300 s; results abandoned after 6 h; builds pooled (low) | All fixed. |

## 5. Durability review and its fixes

A third reviewer tried to break durability: crashes, full disks, stale locks, lost state, long histories and live backups. It confirmed nine defects, each demonstrated with a script. All nine are fixed. Each has its own test in `test/durability_test.js`, named after the finding (F1–F9).

| Finding (reviewer's severity) | What went wrong | Fix | Test |
|---|---|---|---|
| F1 A failed or short write desynchronised the head (high) | After a write error, the observer believed records were stored that were not, or half-stored. The next batch then broke the chain. | The batch is written in full and fsynced before the head moves; on any error the file is cut back to its size before the batch. If even that fails, the stream refuses appends and is reopened, which re-reads the real tail. The observer keeps records queued in memory through failures and records the interval (`obs.writefail`, or `obs.gap` if anything was dropped or the observer stopped first). | Injected short writes; a failed cut-back; a **real observer under a 16 KiB file-size limit** (`EFBIG`) |
| F2 A stale lock was mistaken for a live one, or the reverse (high) | Container restarts as PID 1, recycled PIDs and host-name changes defeated the pid@host lock. | A lease with a random token, renewed every 15 s. Only an expired lease, or one naming a dead process on this host, is taken over (recorded). A writer that finds its lease taken over stops (exit 3). | Leases from another host, from this PID, and from a live recycled PID; a takeover; real observers, one frozen past its lease |
| F3 derive and report ran out of memory on a long history (high) | Every record was loaded into memory, and so was every market record. | Two streaming passes that stop at the verified heads. Market records are handed over as each market becomes final: `derive` writes them to the file, and `report` keeps a small summary. | 4,000 markets (2.4 million records) under a 96 MB heap, where 1,500 markets materialised do not fit; the command-line derive of 12 days (about 180 MB of plaintext) under 96 MB |
| F4 restore-test failed on a backup taken while the observer wrote (medium) | The manifest's heads were taken before the copy, and a write in progress could be copied half. | Only whole lines are copied. The heads are read from the copy. Readers skip a fragment still being written, and verify reports it. | Repeated backup and restore-test while a writer appends; an explicit fragment |
| F5 The catch-up after an outage ran only once (medium) | One failure of Kalshi's list left the cursor jumped past unfetched markets. | The cursor moves only after a complete catch-up; a failed one is retried every 5 min. | Failure, no retry before the back-off, then success |
| F6 Losing `state.json` broke the gap record and the catch-up (medium) | The outage was measured from the state file, so a missing or stale file hid it. | The gap is measured from the newest stored record of the two streams. The state file is fsynced, written only when nothing is queued, and checked against the store. Without a usable cursor, collection restarts 15 min before the newest record. | Missing, damaged and stale state files on a real observer |
| F7 Anchors, checkpoints and manifest heads took one chain walk each (medium) | Quadratic time in the history length. | One walk per stream for all of them. | 3,000 anchors and 300 signed checkpoints: one read of the segment each |
| F8 A slow Kalshi request delayed the 1 Hz book snapshots (low) | One lane served books, discovery and results. | Separate lanes: books, Kalshi metadata, Pin Radar. | Books continue while every metadata request hangs |
| F9 The backup usage text omitted `--key` (low) | The documented command failed. | Usage and README corrected. | Static check, and the error message |

**One more defect, found while testing.** The new F3 test found that the `report` command always failed: a local variable shadowed the key, so writing the encrypted report record threw.
* No earlier test had run `report` from the command line successfully. One test checks only that `report` refuses to overwrite a file, and it passed for the wrong reason.
* The defect is fixed. The end-to-end test now runs `report --period daily` on the encrypted store, and `report` now refuses an existing output file before doing any work.

## 6. Test output (verbatim, final code)

`node test/run_all.js` on 2026-10-31:
```
PASS isolation_test.js   isolation: 20/20 passed  (0.9 s)
PASS unit_test.js        unit: 53/53 passed  (4.9 s)
PASS durability_test.js  durability: 14/14 passed  (96.6 s)
PASS math_test.js        math: 2544/2544 values agree with the independent implementation  (2.0 s)
PASS e2e_test.js         e2e: 12/12 passed  (90.5 s)
all suites passed
```
The durability and end-to-end suites, test by test (run separately on the same code; long lines are cut at 240 characters):
```
ok   F1: a short write followed by an error is cut back; the head does not move; the next append continues the chain  (0.0 s)
ok   F1: if even the cut-back fails, the stream refuses further appends; reopening quarantines the fragment and the chain verifies  (0.0 s)
ok   F1: a real observer under a 16 KiB file-size limit: writes fail (EFBIG), nothing partial reaches the disk, records stay queued, and the loss is recorded at stop and at the next start  (7.1 s)
ok   F2: a fresh lease held elsewhere is refused (another host; this pid after a container restart; a live recycled pid); once expired it is taken over and recorded  (0.1 s)
ok   F2: a writer whose lease was taken over stops: refresh and append throw ELEASELOST, and closing never removes the other writer's lease  (0.0 s)
ok   F2: real observers on one directory: a second one waits out the lease once, then refuses; a first one frozen past its lease is taken over and, on waking, stops without writing (exit 3)  (12.4 s)
ok   F3: derive streams: 4,000 markets (2.4 million records, 42 days) are derived under a 96 MB heap; 1,500 markets materialised as an array exhaust the same heap  (11.4 s)
ok   F3: observer.js derive reads the encrypted store record by record: 12 days, 576 markets (about 180 MB of plaintext) under a 96 MB heap  (44.3 s)
ok   F4: backups taken while a writer appends copy whole lines only, carry the heads of what they copied, and pass restore-test every time  (5.1 s)
ok   F5: a catch-up that fails is retried (after 5 min, not more often) and the cursor does not move until it succeeds  (0.0 s)
ok   F6: with state.json missing, damaged or stale, the gap starts at the newest stored record and collection restarts 15 min before it  (16.7 s)
ok   F7: 3,000 anchors and 300 signed checkpoints are each checked in ONE walk of the chain (not one walk per head)  (0.4 s)
ok   F8: Kalshi books run in their own lane: with every metadata request hanging, the 1 Hz book snapshots continue  (0.0 s)
ok   F9: the backup usage names --key (observer.js and README), and backup without --key says what is missing  (0.0 s)
durability: 14/14 passed
ok   fixture ran production main:pinradar_server.js byte for byte :: 0efd86c9050a3be6
ok   Test 7: every stream verifies (chain + decryption + host-signed checkpoints + anchors) after a kill -9 and restart :: {"streams":{"raw":{"ok":true,"records":160,"seq":160,"head":"3f497483528766c14a9908f8327f41274259e50d495594411f5eb...
ok   Test 9: the observer outage is recorded as a gap (never silently bridged) :: {"s":16,"t":1793411097116,"kind":"obs.gap","from":1793411089638,"to":1793411096076,"reason":"observer was not running (crash or host restart)"}
ok   Test 8: no plaintext Pin Radar data on disk (raw segments are ciphertext only)
ok   Test 2: first LOCKED, first 0.2 % signal, T-120 state and every state change equal the engine's own per-second output :: 6/6 
ok   Test 3: seconds remaining agree with the close time for every first-LOCKED signal :: 6
ok   Test 5: every outcome and official value equals Kalshi's record :: 6
ok   Test 9: windows are complete except where the observer was down (none here: production kept the rows in memory) :: 6/6 
ok   Test 4: the price at the signal comes from a book received before it, and equals what Kalshi served :: {"receivedAt":"2026-10-31T01:44:41.874Z","signal":"2026-10-31T01:44:42.750Z","got":99.7,"want":99.7}
ok   Test 10: order books recorded about once a second in the live window (outside the outage) :: 68 snapshots
ok   Test 10: report builds with coverage, accuracy, timing, prices and theoretical sizes
ok   Test 10: observer.js report (daily) runs on the encrypted store and counts every market :: {"windowsExpected":6,"recorded":6,"windowsWithNoRecord":0,"complete":6,"partial":0,"unobserved":0,"settled":6,"settlementMissing":0}
e2e: 12/12 passed
```
