# Data provenance (validation of 2026-10-16)

All data were fetched by the scripts in `pipeline/`. Every HTTP response's URL, status, size, SHA-256 and fetch time is logged in `PROVENANCE*.ndjson` next to the data. The data themselves (about 2 GB) are not committed; the scripts rebuild them.

## Kalshi KXBTC15M contracts (public market-data API, no account)

* **Source.** `api.elections.kalshi.com/trade-api/v2`:
  * `/markets` and `/historical/markets` (`series_ticker=KXBTC15M`, `status=settled`);
  * `/markets/trades` and `/historical/trades` (each window's final 300 s).
* **The archive split.** Kalshi moves markets settled before `2026-08-16T00:00:00Z` to the historical store (`/historical/cutoff`); both stores were read.
* **Coverage.** 28,874 settled markets, closes from 2025-12-10 22:00 to 2026-10-16 03:00 UTC, every one `finalized`.
* **Excluded: 2,880 markets,** each listed in `excluded.ndjson` with the reason. Nothing was repaired or inferred.
  * 2,878 have no `floor_strike` or `expiration_value`. They used an earlier rule (Dec 2025 – Jan 2026: the strike was "the price of Bitcoin at … according to CF Benchmarks"), plus a few markets with a missing field.
  * 2 have a corrupted strike (7.24 and 7.20).
* **Used.** 25,994 markets, 2026-01-13 23:00 → 2026-10-16 03:00 UTC.
  * Of the 2,880 excluded, 2,806 close before the first used market. The other 74 fall inside the period:
    * 70 lack a field (65 in U2, 5 seen);
    * 2 seen-period markets (KXBTC15M-26AUG280800-00, -26SEP011630-30) were excluded by a parser error: Kalshi published their `expiration_value` as a comma-formatted string ('79,604.96'), which the parser read as missing. It is fixed in `fetch_kalshi.py` for future runs; these two are still excluded here;
    * 2 (U2) have the corrupted strike.
  * The BTCUSDC archive ends 2026-10-15 23:59:59, so the 12 markets closing 2026-10-16 00:15–03:00 have no 1 Hz prices and are not replayed (`markets_usdc.ndjson` = 25,982 markets).
* **The settlement rule** (`rules_primary`, 26,309 markets from January 2026): *"If the simple average of the sixty seconds of CF Benchmarks' BRTI before [close] is at least the simple average of the sixty seconds of CF Benchmarks' BRTI before [open], then the market resolves to Yes."*
  * `floor_strike` is that opening average.
  * `expiration_value` is the closing average.
  * `result` is Kalshi's own outcome.
  * Every used market satisfies `round2(expiration_value) ≥ floor_strike ⇔ result = yes`.
* **Trade prints.** For each trade: price, size (fractional sizes exist), time, and the side the taker **bought**. Per Kalshi's documentation, `taker_outcome_side` names that side and `taker_side` is its deprecated alias.
  * There is no order-book history: Kalshi does not publish one.
  * Executable volume is therefore measured from prints. It is an upper bound on what one trader could have obtained.

## 1 Hz BTC prices

| Feed | Source | Coverage | Integrity | Use |
|---|---|---|---|---|
| Binance BTCUSDT, 1 s klines (close) | `data.binance.vision` daily archives | 2023-10-01 → 2026-10-15, 1,111 days | every archive matched Binance's published SHA-256; no empty seconds | long-horizon proxy study; robustness feed |
| Binance BTCUSDC, 1 s klines (close) | same | 2026-01-13 → 2026-10-15, 276 days | SHA-256 verified; no empty seconds | **primary feed for the contract replay** (closest full-period tracker of the official value) |
| Coinbase BTC-USD trades | `api.exchange.coinbase.com` | 2026-09-15 → 2026-10-16 | last trade within 30 s, else empty | cross-check |
| Kraken XBT/USD trades | `api.kraken.com` | 93 days: 2026-01-13 → 04-07, 09-14 → 09-18, 10-14 → 10-16 | last trade within 30 s, else empty | Oct 14–16 incident replay; cross-check |

* **Not used: CF Benchmarks' BRTI history.** It is licensed and not public. Kalshi's `expiration_value` gives the exact official 60-second average for every contract, which is what the outcome needs.
* **The index before the close is a stand-in.** It comes from one of the feeds above. The engine's basis model learns *official minus feed* walk-forward, from windows already settled, exactly as the live server does with its own index.
* **What this costs:**
  * The live server's 3-venue index (Coinbase, Kraken and Bitstamp quotes) and its official-BRTI gate in the final minute could not be reproduced. Kalshi publishes the live BRTI only over an authenticated stream.
  * Results in the last ~20–30 s, where the basis decides near-strike windows, are therefore feed-dependent: BTCUSDT is already over-confident at T−20 over all periods. They are reported for two feeds.

## Timing and look-ahead

* **Real-time inputs only, up to a sub-second lead.** The replay feeds each second's price, which is that second's closing price (last trade or kline close), during that second. The decision follows 0.75 s into the second, so the input leads real time by up to 0.25 s. In earlier work (not re-run here; raw files not retained), a 0.9 s shift changed T−20 failures from 2 to 4.
* Each official value reaches the engine 5 s after its close. This is an assumption; production's timing is not documented here.
* **Outcomes are used only for scoring**, after each window.
* **Kalshi prints are used only for execution scoring.**
  * The market's last price before the entry moment (what a trader could see).
  * Prints in the order time after it (what could have been filled).
