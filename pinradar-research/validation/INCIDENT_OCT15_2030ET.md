# Oct 15 2026, 20:30 ET window (KXBTC15M-26OCT152030-30, close 00:30 UTC Oct 16): LOCKED DOWN was wrong

**Sources:**
* your photo of the deployed 2.8 page (IMG_7268), taken at T−71 s;
* Kalshi's settled market record and its full trade tape for the last 300 s (37,042 prints), fetched from Kalshi's public API on 2026-10-16;
* chronological replays of 2.8 and 2.8.1 on Kraken trades alone, and on Coinbase + Kraken trades, as 1 Hz feeds (`replay_chrono.js`).

**Not available:** the live server's own logs. Without them, the replays approximate the live inputs but cannot reproduce them exactly.

## Outcome

| Item | Value | Source |
|---|---|---|
| Strike (60 s average BRTI before the open) | $82,263.34 | Kalshi `floor_strike` |
| Settlement (60 s average BRTI before the close) | $82,273.40 | Kalshi `expiration_value` |
| Result | **YES = UP, by $10.06** | Kalshi `result` |
| Live call | LOCKED **DOWN** from T−89 s; REVERSAL WARNING ("EXIT / NO TRADE") by T−71 s | photo |

**The LOCKED call was wrong.** It is the first loss in the page's forward record: 1 of 84 LOCKED calls (1.19 %, 95 % CI 0.03–6.46 %). That record is far too small to estimate a rate near 0.1 %. The 26,000-contract replay (`VALIDATION_REPORT.md`) is the evidence on rates.

## What the market showed (Kalshi's tape)

Last print before each moment:

| Moment | DOWN traded at | UP traded at |
|---|---|---|
| T−120 s | 92.2 ¢ | 7.8 ¢ |
| T−95 s | 84 ¢ | 16 ¢ |
| **T−89 s (first LOCKED on the live page)** | **79 ¢** | 21 ¢ |
| T−85 s | 63 ¢ | 37 ¢ |
| T−82 s | 42 ¢ | 58 ¢ |
| T−80 s | 12 ¢ | 88 ¢ |
| T−71 s (photo; the page showed DOWN offered at 8.8 ¢) | 3.1 ¢ | 96.9 ¢ |
| T−20 s | 0.9 ¢ | 99.1 ¢ |

* **The market did not agree with a 99.5 % DOWN call.** At the moment LOCKED DOWN first appeared, DOWN traded at 79 ¢, and it had fallen from 92 ¢ thirty seconds earlier.
* **Both 2.8 and 2.8.1 contain the 90 ¢ market-disagreement guard** (`MIN_TRADE_ASK_CENTS = 90`). It refuses TRADE NOW while the called side is offered below 90 ¢.
  * The guard reads the live ask. The tape shows trades, not asks: DOWN taker buys in the 12 s after T−89 were at 8–81 ¢.
  * The guard therefore would almost certainly have refused the trade. The page would still have *shown* LOCKED; the guard blocks only the trade.
* **Across all 18,623 first-LOCKED calls with a Kalshi tape, the guard matters.** It fired on 132 calls, and 13 of those were wrong (9.8 %). Among the other 18,491 calls, 17 were wrong (0.092 %). This is in-sample and was not pre-registered as a test. It supports making the guard visible on the LOCKED headline itself (`MARKET_VETO_CENTS`, a candidate, off by default; section G of the report).

## Replays of the same window

| Feed | 2.8 / 2.8.1 at T−90 | First LOCKED | Then |
|---|---|---|---|
| Kraken trades only | LOCKED DOWN | **DOWN at T−95**: gap −$92.71, 5.36σ, flip 0.49 %; lowest flip 0.30 % at T−86 | REVERSAL WARNING at T−82 (the gap shrank to −$32, then −$17 one second later); DOWN never recovers |
| Coinbase + Kraken trades | HIGH CONFIDENCE DOWN, flip **0.58 %** (LOCKED needs ≤ 0.5 %) | **UP at T−17** (correct) | stays LOCKED UP to the close |
| Binance BTCUSDC / BTCUSDT | not covered: the daily archives end at 2026-10-15 23:59:59 UTC | — | — |

* 2.8 and 2.8.1 make identical decisions in both replays. 2.8.1 does not change the probability model.
* **What the replays do and do not show.**
  * The live page used order-book mid-prices from three venues (Coinbase, Kraken, Bitstamp). The replays use last-trade prices from one or two venues.
  * Kraken traded about $8 below Coinbase in those seconds ($82,167–82,171 against $82,171–82,179).
  * With Kraken alone the index sat further below the strike, and the engine locked. With both venues it came within 0.08 percentage points of the threshold without locking.
  * So the call was borderline. It depended on which venues' prices the index held in those seconds.
* **Size of the move.** BTC rose by about $85 on Coinbase and $98 on Kraken in 7 seconds (T−87 → T−80).
  * The engine measured volatility at the call at 0.27 bps/√s (Kraken replay) and 0.47 (two-venue replay). One σ over 7 s is then $6–10, so the move was roughly 8–17σ.
  * That is a jump, not ordinary diffusion. It is the same class as every loss in the replay set: an early call overturned by a sharp move (`VALIDATION_REPORT.md`, section A).

## What would have avoided the loss

| Rule | This window | Cost across 26,000 contracts (`VALIDATION_REPORT.md`) |
|---|---|---|
| The 90 ¢ guard (in 2.8 and 2.8.1) | **blocks the trade** (DOWN at 79 ¢) | already in force |
| Enter only if still LOCKED at T−20 | **no entry**: REVERSAL WARNING / UP by then in every replay | far fewer fills (section F) |
| Exit on REVERSAL WARNING | the warning came at T−82 / T−71, when DOWN traded at 42 ¢ / 3 ¢: an exit would have recovered little | neutral on average (section F) |
| A 0.2 % threshold | the Kraken replay's flip never went below 0.30 % before the reversal, so **no LOCKED** | fewer calls; designed on seen data (section G) |

## Still unknown without the server's logs

* What the live page's TRADE NOW panel showed between T−89 and T−71.
* The exact index and quotes the live engine used.

`2.8.1/tools/forensic281.js` reconstructs both from `/tape?format=ndjson`, `/predictions?ticker=KXBTC15M-26OCT152030-30`, `/signals` and `/health`, saved from the running server.
