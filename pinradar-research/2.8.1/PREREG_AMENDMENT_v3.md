# Forward-test pre-registration `pinradar-2.8.1-prereg-v3` (amendment to v2)

Written on 2026-10-15, before any 2.8.1 forward data exists. The git commit timestamp of this file is the
pre-commitment.

**Revision 1 (2026-10-15).** 2.8.1 has never been deployed, so no forward data exists for any version of this file. The changes are listed at the end. The binding version is the one in the git commit whose `SHA256SUMS.txt` matches the deployed server.

Everything in `2.8/PREREGISTRATION.md` (v2) applies unchanged, except the items below:

1. **Frozen configuration.**
   * The server is `2.8.1/dist/pinradar_server.js` (SHA-256 in `2.8.1/SHA256SUMS.txt`).
   * The configuration hash is the `CONFIG28_HASH` shown on `/v28` of that build. The hash covers the new environment keys `EXEC_SEC`, `EXEC_STRESS_Z`, `DQ_FIXES`, `SAMPLE_PHASE_MS`, `COLD_START_ENVELOPE`, `COLD_MIN_SEC`, `BASIS_WARM_N`, `BASIS_COLD_LO` and `BASIS_COLD_HI`.
   * The pre-registration id is `pinradar-2.8.1-prereg-v3`.
2. **Production policy `A-2.6` as amended.**
   * TRADE NOW requires τ ≥ 3 s + `EXEC_SEC`. The default `EXEC_SEC` is 12 s, so TRADE NOW requires τ ≥ 15 s.
   * The stress test with z = 1.645 is applied to TRADE NOW. Under the stress, BTC has already moved against the call by 1.645σ√(order time), and the full remaining time is still random. The cautious value after fees (the probability standard of `evConsCents`) must stay ≥ 0.
   * The data-quality fixes (`DQ_FIXES=1`) apply: the aligned sampler and nearest-sample print matching. One lagging venue is DATA UNRELIABLE, as in 2.8.
   * After a restart, the cold-start volatility and basis envelopes apply.
   * The shadow policies use the same order time and stress input.
3. **G1–G6 gates, stop rule and evidence rules.** Same as v2. Windows decided while either envelope was active are reported separately as well as pooled, with the boot entry's timestamp as the split.
4. **Evidence from 2.8 (v2) stays scored under v2.** The 2.8 deployment of Oct 14 had no ledger file, so its ledger is in memory and lost at any restart. It counts only if the user saved `/ledger` before the restart.
5. **Data-quality reporting.** The DATA UNRELIABLE rate and its reasons (`/dq`) are reported per day. They are a monitored quantity, not a gate.

**Changes in revision 1** (all made before deployment, none based on 2.8.1 forward data):
* The default `EXEC_SEC` went from 10 to 12, so the buffer is 15 s.
* The stress test now keeps the full remaining time random. Before, it removed the order time, which could make the stressed call more confident than the live one. It now uses the cautious probability, not the point probability.
* The "fresh-venue quorum" was withdrawn: it let a frozen venue bias the settlement prints while the warning was suppressed.
* The data-quality fixes and the `DQ_FIXES` / `SAMPLE_PHASE_MS` keys were added.
* Item 5 was added.
