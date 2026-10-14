# BTC Pin Radar 2.7: settlement-aware LOCKED call — install, verify, roll back

Built Oct 13 2026. **Nothing in this package places orders. None of it has been deployed.**

**What you run today:** backend `btc-pin-radar` reports `pin-radar-2.3`, build `2.3-2026-09-21`. Page `btc_pin_radar.html` is the 2.3 page (sha-256 `70a6aabf…`). Both were checked Oct 13 at 20:0x PT. The `rollback/` files are byte-identical to them. 2.6 was never deployed.

## 1. What 2.7 is

* **Same probability engine as 2.6.**
  * LOCKED means the leading side's flip risk is 0.5% or less.
  * Without the official feed, every 2.7 decision is identical to 2.6: 0 differences in 616,749 replayed seconds (2,049 contracts).
  * No tested model beat it on both data sets. See section 2.
* **New: exact settlement panel.** For the current window it shows:
  * how many of the 60 settlement observations are recorded, and their average versus the strike;
  * the critical average the remaining observations must reach to flip the result;
  * the move from spot that needs, if it is held from now and if it starts in 5 s.

  Every number is labelled **OFFICIAL** or **PROXY**.
* **New: decision block, in the format you asked for:** `LOCKED — PREDICTED UP`, `WIN PROBABILITY`, `REVERSAL PROBABILITY`, `SECONDS REMAINING`, `CRITICAL REMAINING AVERAGE $X BELOW STRIKE`.
  * LOCKED is labelled a predictive classification, not a guarantee.
* **New: official CF Benchmarks BRTI from Kalshi.** It uses the `cfbenchmarks_value` channel on the same authenticated Kalshi socket the radar already uses. It only works if your API key has Kalshi's CF Benchmarks entitlement; `/brti-status` tells you about 15 s after start.

  When the official feed is live:
  * the panel uses Kalshi's own settlement accumulator (`last_60s_windowed_average_15min`, with its `window_size`);
  * LOCKED is **withheld** when the official reference disagrees. That means the other side leads, or the flip risk on the official reference is above 5%, or official and proxy differ by more than $40. This check can only remove calls, never add them;
  * a **REVERSAL WARNING** is also raised when the official reference puts an earlier LOCKED side at 10% flip risk or more. This can only add warnings.

  When it is not live, everything is labelled PROXY and the engine behaves exactly like 2.6.
* **New endpoints.**
  * `/brti-status`: entitlement, ticks, sequence gaps, latency, and accumulator versus Kalshi's official settlement for each window.
  * `/brti-messages`: the last 600 raw official messages.
  * `/predictions`: a per-second log of every call inside the 300 s LOCKED horizon (`?format=ndjson`, `?ticker=`, `?since=`).

## 2. Evidence (out of sample; full tables in `research/results/`)

**Data sets.**
* **Untouched holdout:** 2,120 windows, Jul 22 – Aug 13. Never used to build, tune or choose anything.
* **Walk-forward development:** 3,765 windows, Sep 4 – Oct 13. Each week is judged only with what was known before it.

| | **2.6 = 2.7 without official feed** | 2.7 with official feed *(emulated)* | Official feed, no gate *(emulated)* | Gaussian settlement model |
|---|---|---|---|---|
| Holdout: LOCKED / lost | **1,879 / 3 (0.16%)** | 1,879 / 3 | 2,118 / 2 | 1,928 / 50 (2.6%) |
| Dev: LOCKED / lost | **3,484 / 13 (0.37%)** | 3,483 / 12 | 3,763 / 21 (0.56%) | 3,563 / 160 (4.5%) |
| First LOCKED under 60 s, correct (holdout · dev) | 686/686 · 1,275/1,277 | 686/686 · 1,275/1,276 | 921/921 · 1,562/1,567 | 194/194 · 483/493 |
| Mean / median lead (dev) | 100 s / 77 s | 100 s / 77 s | 94 s / 70 s | 187 s / 194 s |
| Windows never LOCKED (dev) | 281 | 282 | 2 | 202 |
| TRADE NOW, cautious fills (dev): trades / losses / per contract | 261 / 2 / +0.86¢ | 261 / 2 / +0.86¢ | 307 / 4 / +0.28¢ | 2,234 / 101 / −2.0¢ |

*Emulated* means the official feed was imitated as our index plus each window's measured offset to the official settlement. No historical BRTI is available without the entitlement, so this is an upper bound.

**What the evidence says.**
* **2.6 already does the settlement mathematics.** Recorded average plus remaining observations is algebraically identical to your critical-average formula, apart from a $0.005 rounding term that 2.7 now includes. The 18 deterministic checks pass.
* **A Gaussian "settlement-aware" model is far worse.** The fat tails, not the arithmetic, are what keep LOCKED reliable.
* **The official feed raises coverage, mostly in the last 20 s.** But at the same threshold it does not lower the first-LOCKED loss rate (dev 0.37% → 0.56%). Without the proxy's basis uncertainty, it locks close calls that the remaining path can still reverse. The Oct 12 window is one of them.
  * In windows 2.6 never locked, Kalshi already priced the extra late calls at a median 99.6¢. That is worth +0.3¢ to +1.1¢ per contract.
* **Exiting on REVERSAL WARNING roughly breaks even.**
  * 11 of 12 losing 2.6 LOCKED calls were warned while an exit was possible.
  * But 25 winners were also warned, and most reversals are single jumps: the warning and the market's own repricing arrive in the same second.
  * Over Sep 4 – Oct 13 the net was −$6.6 (cautious fills) to +$41 (fills at the price seen) per 10-lot. More sensitive warnings did worse.
* **Stress test** (real 2.6/2.7 code, 960 real LOCKED windows, sudden $5–$100 adverse jumps):
  * the engine never stayed LOCKED after a jump that flips the settlement;
  * it showed REVERSAL WARNING within 1 s in 436 of 437 such cases. The exception was a proxy-index error that the official feed would catch.

## 3. Files

| Package path | Goes to | Action |
|---|---|---|
| `upload/btc-ai-backend/pinradar_server.js` | repo `didubin-code/btc-ai-backend`, **new branch `pinradar-2.7`**, repo root | create it in that branch |
| `upload/Btc-signal/btc_pin_radar_27.html` | repo `didubin-code/Btc-signal`, `main`, repo root | **new file** (the 2.3 page is not touched) |
| `rollback/…` | only if you ever replace the main files | byte-identical to the live 2.3 backend and page |
| `test/` | not uploaded | `bash test/run_all.sh` re-runs every offline check |
| `tools/brti_history_check.js` | not uploaded | run it with your key (section 6) |
| `research/` | not uploaded | every script and result behind section 2 |

SHA-256: see `SHA256SUMS.txt`. No new dependencies: still only `ws`, which your backend already uses for the Kalshi socket. No new required environment variables.

## 4. Install next to 2.3 (production keeps running)

### Backend
1. In GitHub, open `didubin-code/btc-ai-backend`. Open the branch menu (**main ▾**), type `pinradar-2.7`, and choose **Create branch: pinradar-2.7 from main**.
2. On branch `pinradar-2.7`, choose **Add file → Upload files**. Upload `upload/btc-ai-backend/pinradar_server.js` and choose **Commit directly to the `pinradar-2.7` branch**.
   A commit to a non-`main` branch does not redeploy anything that tracks `main`.
3. In Render, choose **New + → Web Service**, then repo `didubin-code/btc-ai-backend` and **branch `pinradar-2.7`**. Settings:

   | Setting | Value |
   |---|---|
   | Name | `btc-pin-radar-27` |
   | Runtime | Node |
   | Build command | `npm install` |
   | Start command | `node pinradar_server.js` |
   | Instance type | same as `btc-pin-radar` |

4. Copy **`KALSHI_KEY_ID`** and **`KALSHI_PRIVATE_KEY`** from `btc-pin-radar` (same values). They are required for the official BRTI feed.
   * Optional: `PRED_LOG_FILE=/var/data/pred27.ndjson` if you attach a persistent disk.
5. About 3–4 minutes after the deploy, check:
   * `https://btc-pin-radar-27.onrender.com/health` shows `"version":"pin-radar-2.7"`, `"build":"2.7-2026-10-13"` and `"streaming":true`.
   * `…/selftest` shows `"ok":true,"passed":118,"total":118`.
   * `…/kalshi-auth` shows `"hint":"authenticated websocket is live"`.
   * `…/brti-status`, about 15 s after start. The `state` field tells you which case you are in:

     | `state` | Meaning |
     |---|---|
     | `live` | Your key has the entitlement. The panel will show OFFICIAL. |
     | `not-entitled`, or `no BRTI ticks … (entitlement?)` | Your key does not have it. Everything runs as PROXY, which is exactly 2.6. To get access, contact Kalshi support and ask for the CF Benchmarks data entitlement on your API key. |

### Page
1. In `didubin-code/Btc-signal`, choose **Add file → Upload files**, upload `upload/Btc-signal/btc_pin_radar_27.html` and commit to `main`.
2. Open `https://didubin-code.github.io/Btc-signal/btc_pin_radar_27.html`, set **Radar backend URL** to `https://btc-pin-radar-27.onrender.com`, then press **Start radar**.
   2.7 saves its settings separately, so it cannot change your 2.3 page's backend URL.

## 5. Verify live (no money, at least 2 weeks)

* [ ] The settlement panel shows a badge: **OFFICIAL BRTI** or **PROXY**. In the final minute the count rises 1/60 … 60/60, and the critical average moves away from the strike as observations are recorded.
* [ ] **If OFFICIAL:**
  * `/brti-status → finals` lists each window's final accumulator next to Kalshi's official settlement. `diffUsd` should be `0` (60 ticks, rounded). Any non-zero difference: stop and send me `/brti-status`.
  * Also send me `/brti-messages` once, so the parser can be checked against real messages.
* [ ] **Daily:**
  * `/predictions?format=ndjson` saves the per-second record of every call.
  * `/calibration` gives first LOCKED calls and losses. Expect about 85 calls a day and about 1 loss every 3–7 days. Stop if losses exceed 3 in any 200 LOCKED calls.
* [ ] **Each TRADE NOW (on paper):** note the time, side, ask, whether a 10-lot was really available, and the result.

## 6. Check the official data yourself (optional, recommended before relying on OFFICIAL)

```
KALSHI_KEY_ID=... KALSHI_PRIVATE_KEY="$(cat your_key.pem)" node tools/brti_history_check.js --hours 24
```

This downloads 24 hours of official BRTI through Kalshi's CF Benchmarks passthrough (signed, about 1.7 requests/s). For every settled KXBTC15M window it recomputes the 60-value average and compares it with Kalshi's official value.

Send me `brti_check_out/brti_check.json` and `brti_seconds.ndjson`. With them I can:
* validate the official-feed model on real BRTI instead of the emulation;
* decide whether OFFICIAL may ever issue LOCKED calls the proxy model cannot.

## 7. Roll back
* **Side-by-side install:** suspend or delete `btc-pin-radar-27` and the `btc_pin_radar_27.html` file. Production was never changed.
* **If you replaced the main files:**
  1. Upload `rollback/btc-ai-backend/pinradar_server.js` to `btc-ai-backend` `main`.
  2. Upload `rollback/Btc-signal/btc_pin_radar.html` to `Btc-signal` `main`.
  3. Check that `https://btc-pin-radar.onrender.com/health` shows `"version":"pin-radar-2.3"`.
* **A merge to `main` redeploys every Render service that auto-deploys from this repo, including the live trader.** Do it with no open positions.

## 8. Settings (all optional; defaults are the validated values)

| Env var | Default | Meaning |
|---|---|---|
| `LOCK_MAX_FLIP` | `0.005` | LOCKED at a flip risk of 0.5% or less. `0.002` is stricter: dev losses 13 → 5, holdout 3 → 1, but first LOCKED about 22 s later and about 35% fewer TRADE NOW signals. |
| `BRTI_ENABLE` | `1` | `0` turns the official feed off (pure 2.6 behaviour) |
| `BRTI_GATE` / `BRTI_GATE_MAX_FLIP` | `1` / `0.05` | withhold LOCKED when the official reference gives the called side more than 5% flip risk |
| `BRTI_MAX_DIVERGENCE_USD` | `40` | withhold LOCKED when official and proxy differ by more than this |
| `BRTI_STALE_MS` | `2500` | official data older than this is not used (falls back to PROXY) |
| `BRTI_COUNT_TOL` | `2` | `window_size` must match the clock within this many ticks |
| `BRTI_5HZ` | `0` | `1` also subscribes `cfbenchmarks_value_5hz`. It refreshes the spot only; 5 Hz ticks are never counted as settlement observations. |
| `PRED_LOG_FILE` / `PRED_LOG_MAX` | – / `30000` | per-second prediction log file (persistent disk) and in-memory rows |
| all 2.6 settings | unchanged | `RECAL_*`, `LOCK_MAX_TAU`, `MIN_TRADE_ASK_CENTS`, `MIN_EDGE_CENTS`, `BOOK_*`, `HIGH_MAX_FLIP`, `REV_FLIP`, … |

## 9. What is not verified
* **Whether your key has the CF Benchmarks entitlement.** Without credentials Kalshi answers 401, so this can only be checked from your account.
* **Real `cfbenchmarks_value` messages.** The parser follows Kalshi's documented schema and passed tests with schema-identical replayed messages, including a real-time mock Kalshi socket with the same RSA-PSS handshake, sequence gaps and outages. It has not seen a real message.
* **Accuracy of any decision made on official BRTI.** That rests on emulation until `tools/brti_history_check.js` data is analysed. This is why 2.7 only lets the official feed withhold LOCKED or add warnings.
* **Profitability.** TRADE NOW is positive in back-tests, but with 2–4 losses the result is not statistically proven.
