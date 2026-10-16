# Pin Radar Trader 5.0 (pointer)

The automated trader built on this engine is in **didubin-code/Btc-signal**, branch `claude/btc-pin-radar-research-xpe585`, directory `pinradar-trader/`. It replaces live-trader-4.17, which is archived and checksummed in `trader-archive/live-trader-4.17/` and unchanged on `main`.

* **Engine:** `2.8.1/dist/pinradar_server.js` from this repository, copied byte-identically (SHA-256 `55d0555c…522a0d`). It runs with `LOCK_MAX_FLIP=0.002`, the 0.2 % threshold of `validation/VALIDATION_REPORT.md` §G and `thr02_summary.md`.
* **Regression:** the trader's engine readings reproduce `replay/thr02_usdc.ndjson`. The first LOCKED second and side are identical in 663/663 windows (Aug 1–8, 2026). See `pinradar-trader/TEST_RESULTS.md` there.
* **Status:** dry run by default, $5 maximum per trade, not deployed, no real orders.
