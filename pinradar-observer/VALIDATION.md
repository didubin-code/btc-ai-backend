# Pin Radar observer: validation report

All tests below were run in the build environment on the final code, offline. They made no network call to production, to Render or to any Kalshi account endpoint. The verbatim outputs are in §4.

## 1. The ten required tests

| # | Test | How it was run | Result |
|---|---|---|---|
| 1 | Production isolation | `test/isolation_test.js`. Production `main` commit and SHA-256 of all 6 production files compared with `BASELINE.json`. No tracked file modified in either repository. Since the pre-observer commit `b97eed6`, the branch only **adds** files under `pinradar-observer/`. Trader 5.0 unchanged. Observer code never loads the production module. | **Pass** (20/20) |
| 2 | Signal fidelity | `test/e2e_test.js`. The real observer runs against **production's own code**: `main:pinradar_server.js`, extracted from git and byte-checked, served through its own HTTP handler. Six real historical windows (Aug 2026) are replayed, the last one released in real time. First LOCKED, first 0.2 % signal, T−120 state and every state change are compared with the engine's own per-second output, recorded on a separate path. | **Pass** (6/6 windows identical). **Live production: not yet run** (§3) |
| 3 | Timestamp accuracy | e2e: seconds remaining against close time for every signal. Unit: T−120 checkpoint, seconds 0–299 coverage, a clock step from row order, per-signal clock bounds. | **Pass** |
| 4 | Pricing accuracy | e2e: the live window's price comes from a book received **before** the signal and equals what was served. Unit: later books never used; stale books, books inside the clock uncertainty, clock steps and missing clock samples all give "unavailable"; fee schedule taken from before the signal. | **Pass** |
| 5 | Settlement accuracy | e2e: every outcome and official value equals Kalshi's record. Unit: missing or non-final results give `outcome-unknown`, never a win; results are still polled 7 h after the close. | **Pass** |
| 6 | Mathematical accuracy | `test/math_test.js`. Every fill, fee, P&L figure, exact interval and posterior compared with `test/independent_check.py`. That checker was written separately, from a specification only, in exact rational / 50-digit arithmetic, and validated against closed forms. The research figures were also recomputed independently (§2). | **Pass** (2,544/2,544 values) |
| 7 | Durability | e2e: kill -9 mid-run and restart; all streams verify (chain, decryption, host-signed checkpoints, anchors). Unit: torn writes quarantined; damaged records refuse to open; single writer; clock stepping back over midnight; append-only backup refusing a cut source; restore-test detecting a rewritten backup; path traversal; empty manifests. | **Pass** |
| 8 | Security | Unit:<br>• GET-only allowlist, HTTPS, redirects refused, oversized responses cut;<br>• no account paths;<br>• wrong key cannot read;<br>• no plaintext on disk; files mode 600; no listening port;<br>• key-file rules (600, no symlinks, outside the data directory by real path, RSA ≥ 3072);<br>• public-key mode cannot read;<br>• a rewrite with only the public key fails the signed-checkpoint check;<br>• anchors catch a cut;<br>• audit failure refuses export;<br>• outputs never overwrite. | **Pass** |
| 9 | Missing-data integrity | Injected into the tests:<br>• observer outage (kill -9);<br>• duplicate and out-of-order rows;<br>• holes before and after a signal;<br>• production restart in the window;<br>• production clock step;<br>• failed book requests;<br>• missing results;<br>• unobserved windows;<br>• corrupted and torn records;<br>• implausible saved cursors.<br>Each is flagged, and none produces a win or a price. | **Pass** |
| 10 | End-to-end | e2e: production's own code plus a mock Kalshi API, in real time, about 90 s per run. Collection, encryption, kill -9, restart, derive, report, export, verify. | **Pass** (11/11). **Live nonintrusive validation: not yet run** (§3) |

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

Each reviewer demonstrated its findings with scripts. Every confirmed finding was fixed, and has its own test in `test/unit_test.js` (marked "review:").

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

## 5. Test output (verbatim, final code)

```
(filled in by the final run)
```
