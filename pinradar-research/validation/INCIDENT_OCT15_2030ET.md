# Oct 15 2026, 20:30 ET window (KXBTC15M-26OCT152030-30, close 00:30 UTC Oct 16): LOCKED DOWN was wrong

**Sources:**
* your photo of the deployed 2.8 page (IMG_7268), taken at T−71 s;
* Kalshi's settled market record and its full trade tape for the last 300 s (37,042 prints), fetched from Kalshi's public API on 2026-10-16;
* chronological replays of 2.8 and 2.8.1 (`replay_chrono.js`) in two set-ups:
  * Kraken trades driving the whole index (`--venues proxy --proxy-dir kr`);
  * Coinbase and Kraken trades as two real venues (`--venues cb,kr`).

**Not available:** the live server's own logs. Without them, the replays approximate the live inputs but cannot reproduce them exactly.

**This window is not among the 25,982 replayed contracts** in `VALIDATION_REPORT.md`, because it closes after the Binance archive ends. It is disclosed there as a deviation.

## Outcome

| Item | Value | Source |
|---|---|---|
| Strike (60 s average BRTI before the open) | $82,263.34 | Kalshi `floor_strike` |
| Settlement (60 s average BRTI before the close) | $82,273.40 | Kalshi `expiration_value` |
| Result | **YES = UP, by $10.06** | Kalshi `result` |
| Live call | LOCKED **DOWN** from T−89 s; REVERSAL WARNING ("EXIT / NO TRADE") by T−71 s | photo |

**The LOCKED call was wrong.** It is the first loss in the page's forward record: 1 of 84 LOCKED calls (1.19 %, 95 % CI 0.03–6.46 %). That record is far too small to estimate a rate near 0.1 %. The 26,000-contract replay (`VALIDATION_REPORT.md`) is the evidence on rates.

## What the market showed (Kalshi's tape)

Last print before each moment. T−95.25 and T−82.25 are the Kraken replay's first LOCKED and first REVERSAL WARNING; whole-second rows use whole seconds:

| Moment | DOWN traded at | UP traded at |
|---|---|---|
| T−120 s | 92.2 ¢ | 7.8 ¢ |
| T−95.25 s | 84 ¢ | 16 ¢ |
| **T−89 s (first LOCKED on the live page)** | **79 ¢** | 21 ¢ |
| T−85 s | 63 ¢ | 37 ¢ |
| T−82.25 s | 42 ¢ | 58 ¢ |
| T−80 s | 12 ¢ | 88 ¢ |
| T−71 s (photo; the page showed DOWN offered at 8.8 ¢) | 3.1 ¢ | 96.9 ¢ |
| T−20 s | 0.9 ¢ | 99.1 ¢ |

* **The market did not agree with a 99.5 % DOWN call.** At the moment LOCKED DOWN first appeared, DOWN traded at 79 ¢, and it had fallen from 92 ¢ thirty seconds earlier.
* **Both 2.8 and 2.8.1 contain the 90 ¢ market-disagreement guard** (`MIN_TRADE_ASK_CENTS = 90`). It refuses TRADE NOW while the called side is offered below 90 ¢.
  * The guard reads the live ask. The tape shows trades, not asks: DOWN taker buys in the 12 s after T−89 were at 8–81 ¢.
  * The guard therefore would almost certainly have refused the trade. The page would still have *shown* LOCKED; the guard blocks only the trade.
* **The guard was already in the deployed 2.8.** So 2.8.1 adds nothing for this window: it shows the same LOCKED DOWN. Whether the live page showed TRADE NOW cannot be known without the server's logs.
* **What the guard does across all 20,354 first-LOCKED calls with a Kalshi tape** (in-sample, not a pre-registered test; tape snapshot of 22,071 markets):
  * It fired on 138 calls, and 14 of those were wrong (10.1 %).
  * But it caught only 14 of the 39 wrong calls. Among the 20,216 calls it passed, 25 were wrong (**0.124 %, above the 0.093 % break-even**).
  * Most of the calls it catches were made in the last seconds or near the strike. In the backtest, the early reversals that passed it were calls the market priced at 90–99.8 ¢.
  * This window is the opposite: the market disagreed when the call was made.

## Replays of the same window

| Feed | 2.8 / 2.8.1 at T−90 | First LOCKED | Then |
|---|---|---|---|
| Kraken trades driving the whole index | LOCKED DOWN | **DOWN at T−95.25**: gap −$92.71, 5.36σ, flip 0.49 %; lowest flip 0.30 % at T−86 | REVERSAL WARNING at T−82.25 (the gap shrank to −$32, then −$17 one second later); DOWN never recovers |
| Coinbase + Kraken trades as two real venues | HIGH CONFIDENCE DOWN, flip **0.58 %**; lowest **0.52 %** at T−86 (LOCKED needs ≤ 0.5 %) | **UP at T−17** (correct) | stays LOCKED UP to the close |
| Kraken as the only real venue | DATA UNRELIABLE (venue quorum not met) throughout | — | — |
| Binance BTCUSDC / BTCUSDT | not covered: the daily archives end at 2026-10-15 23:59:59 UTC | — | — |

* 2.8 and 2.8.1 make identical decisions in both replays. 2.8.1 does not change the probability model.
* **What the replays do and do not show.**
  * The live page used order-book mid-prices from three venues (Coinbase, Kraken, Bitstamp). The replays use last-trade prices from one or two venues.
  * When the Kraken-driven replay first locked (T−95.25), both set-ups had the same gap (−$92.7).
  * The difference was the volatility estimate: 0.268 bps/√s on Kraken's sparse, mostly flat last-trade series, against 0.290 on two venues.
  * From T−91 the Kraken index also sat about $6 lower (gap −$95.8 against −$89.5).
  * With two venues the flip came within 0.02 percentage points of the threshold without locking.
  * So the call was borderline. It depended on which venues' prices, and which volatility estimate, the engine had in those seconds.
* **Size of the move.** BTC rose by about $85 on Coinbase and $98 on Kraken in 7 seconds (T−87 → T−80).
  * At the time of the call the engine measured 0.27 bps/√s (Kraken-driven) and 0.28–0.29 (two venues). One σ over 7 s is about $6, so the move was roughly 14–17σ.
  * That is a jump, not ordinary diffusion.
  * It resembles the replay set's real price reversals (19 of 28 unseen failures; `VALIDATION_REPORT.md`, section B) with one difference. In the 13 reversals that passed the safeguards, the market agreed with the call (97.8–99.8 ¢); here it disagreed (79 ¢).

## What would have avoided the loss

| Rule | This window | Cost across 26,000 contracts (`VALIDATION_REPORT.md`) |
|---|---|---|
| The 90 ¢ guard (in 2.8 and 2.8.1) | **almost certainly blocks the trade** (DOWN traded at 79 ¢; the ask is not known) | already in force |
| Enter only if still LOCKED at T−20 | **no entry**: REVERSAL WARNING / UP by then in every replay | far fewer fills (section F) |
| Exit on REVERSAL WARNING | the warning came at T−82.25 / T−71, when DOWN traded at 42 ¢ / 3 ¢: an exit would have recovered little | neutral on average (section F) |
| A 0.2 % threshold | the Kraken-driven replay's flip never went below 0.30 % before the reversal, so **no LOCKED** | see section G |

## Still unknown without the server's logs

* What the live page's TRADE NOW panel showed between T−89 and T−71.
* The exact index and quotes the live engine used.

`2.8.1/tools/forensic281.js` reconstructs both from `/tape?format=ndjson`, `/predictions?ticker=KXBTC15M-26OCT152030-30`, `/signals` and `/health`, saved from the running server.
