# Forward-test pre-registration `pinradar-2.8.1-prereg-v3` (amendment to v2)

Written on 2026-10-15, before any 2.8.1 forward data exists. The git commit timestamp of this file is the
pre-commitment.

Everything in `2.8/PREREGISTRATION.md` (v2) applies unchanged, except the items below:

1. **Frozen configuration.**
   * The server is `2.8.1/dist/pinradar_server.js` (SHA-256 in `2.8.1/SHA256SUMS.txt`).
   * The configuration hash is the `CONFIG28_HASH` shown on `/v28` of that build. The hash covers the new environment keys `EXEC_SEC`, `EXEC_STRESS_Z`, `COLD_START_ENVELOPE`, `COLD_MIN_SEC`, `BASIS_WARM_N`, `BASIS_COLD_LO` and `BASIS_COLD_HI`.
   * The pre-registration id is `pinradar-2.8.1-prereg-v3`.
2. **Production policy `A-2.6` as amended.**
   * TRADE NOW requires τ ≥ 3 s + `EXEC_SEC`. The default `EXEC_SEC` is 10 s, so TRADE NOW requires τ ≥ 13 s.
   * The stress test with z = 1.645 is applied to TRADE NOW.
   * After a restart, the cold-start volatility and basis envelopes apply.
   * The shadow policies use the same order time and stress input.
3. **G1–G6 gates, stop rule and evidence rules.** Same as v2. Windows decided while either envelope was active are reported separately as well as pooled, with the boot entry's timestamp as the split.
4. **Evidence from 2.8 (v2) stays scored under v2.** The 2.8 deployment of Oct 14 had no ledger file, so its ledger is in memory and lost at any restart. It counts only if the user saved `/ledger` before the restart.
