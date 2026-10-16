# Oct 15 2026, 20:30 ET window (KXBTC15M-26OCT152030-30, close 00:30 UTC Oct 16): LOCKED DOWN, then REVERSAL WARNING

**Source:** one photo of the deployed 2.8 page (IMG_7268), taken at T−71 s. The outcome and the server's logs are not available here: Kalshi's API is blocked in this environment, and no log has been uploaded. Every number below is read off the photo.

## What the page showed at T−71 s

| Item | Value |
|---|---|
| Headline | **REVERSAL WARNING — DOWN AT RISK**: "earlier LOCKED call breaking down", "EXIT / NO TRADE" |
| First LOCKED | DOWN at T−89 s |
| Model | P(DOWN) 53.82 %, flip risk 46.18 % (conservative ≤ 46.85 %), active-tape recalibration ×0.52 |
| Index (3 venues) vs strike | $82,259.41 vs $82,263.34: **$3.93 below**; expected settlement −$4; cushion 0.2σ |
| Volatility | 0.45 bps/√s, about $15.7 per 1σ over 18 s at this price |
| Official BRTI panel | 0/60 prints recorded; "spot −$7.25", proxy difference −$5.22 (572 ms old); flip 37.73 % on the official reference |
| Kalshi | **DOWN offered at 8.8 ¢**, i.e. the market priced UP at about 91 % |
| Execution readiness | READY (book 487 ms old, depth 10) |
| Forward record shown | "0 of 83 forward LOCKED calls lost"; edge not established (16 paper trades, mean +1.99 ¢) |

## What this does and does not show

1. **The engine called LOCKED DOWN at T−89 s, and within 18 s BTC moved up to about $4 below the strike.**
   * LOCKED needs a flip risk of at most 0.5 %. At about 0.45 bps/√s that implies a cushion of several tens of dollars at T−89, so the move was several σ in 18 s.
   * This is the same failure class as all 15 recorded losing LOCKED calls ([HIST]): a call made 54–300 s before the close, then overturned by a sharp move. The 2.8.1 safeguards do not change this class; the 0.2 % threshold would have prevented about two thirds of past cases (`REPORT_LATE_LOCKED.md`, section 5).
2. **The warning worked as designed.** The call was withdrawn (REVERSAL WARNING, EXIT / NO TRADE) at least 18 s before the settlement minute began.
   * A trader who bought DOWN at the first LOCKED would have been holding a position the model then rated about 54 / 46.
   * A trader following the rule "trade only if still LOCKED at T−20" would not have entered, unless the window re-locked DOWN later.
3. **The market disagreed strongly.** At T−71, Kalshi priced DOWN at 8.8 ¢ while both our index and the official BRTI had BTC below the strike. The market saw something our three venues did not, most plausibly continuing upward momentum or other BRTI constituents.
   * The earlier research saw a pattern in the same direction, but it is not statistically established. TRADE NOW, which only happens when the leader is offered cheaply, lost 2 of 261 times in development (0.77 %, 95 % CI 0.09–2.74 %), against 13 of 3,484 for LOCKED overall (0.37 %). The "cheap ask means a weaker call" fit was labelled exploratory.
   * Whether the market already disagreed at T−89 is the key fact for a possible "market-disagreement veto". It needs the server's tape.
4. **Not known yet: the outcome.** If the window settled UP, the forward record becomes 1 loss in 84 LOCKED calls (1.19 %, 95 % CI 0.03–6.46 %). The forward record is still far too small to estimate a rate near 0.1 %.

## What would settle it

* **Kalshi:** the market's `result` and `expiration_value` (`fetch_kalshi.py markets`, once `api.elections.kalshi.com` is allowed), and its trade prints from T−120 to the close (`fetch_kalshi.py trades`).
* **The server's logs, saved by you:**
  * `/tape?format=ndjson`;
  * `/predictions?ticker=KXBTC15M-26OCT152030-30`;
  * `/signals?n=5000`;
  * `/ledger?since=0&n=5000`;
  * `/health`, with the time saved.

  `2.8.1/tools/forensic281.js` then reconstructs, second by second:
  * the gap at T−89;
  * the official-vs-proxy difference;
  * the Kalshi price when LOCKED was first shown;
  * whether 2.8.1 would have called it.
