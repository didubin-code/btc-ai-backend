# Oct 15 2026, window KXBTC15M-26OCT151200-00 (close 16:00 UTC): "LOCKED UP + DO NOT TRADE", then "LOCKED — TOO LATE"

**Source.** Two screenshots of the deployed 2.8 page sent by the user. No server log has been uploaded yet. Every number below is read off those screens.

## At T−70 s (screen 1)

| Item | Value |
|---|---|
| State | PREDICTED LOCKED UP |
| First LOCKED | T−96 s ("UP at T−96s first LOCKED this window") |
| P(UP) | 99.54 % (flip 0.46 %) |
| Conservative flip | 1.17 % (active-tape ratio 0.52) |
| Index / strike | $82,391.47 vs $82,310.03 (+$81) |
| Cushion / volatility | 3.3σ; 0.53 bps/√s |
| Kalshi UP ask | 99.8 ¢, at least 100 contracts at 99.8 ¢ on the ladder |
| Fee | 0.10 ¢ per contract for 10 contracts |
| Book age / depth | 526 ms; 10+ |
| Index age | 340 ms |
| Expected value | −0.36 ¢ (point), −1.07 ¢ (conservative), against the 0.5 ¢ minimum edge |

## At T−33 s (screen 2)

* P(UP) 99.99 %. No UP offers on Kalshi (depth 0). The page showed "LOCKED — TOO LATE: no UP offers left on Kalshi".
* Official BRTI accumulator: 26/60 recorded, average $82,392.16, +$82.13 vs the strike. The remaining 34 prints would have to average ≤ $82,247.22 to flip it.

## Answers

1. **LOCKED UP and DO NOT TRADE at the same time is correct.** They answer different questions.
   * LOCKED is about the outcome: flip risk ≤ 0.5 %.
   * TRADE NOW is about the price. At 99.8 ¢ plus a 0.1 ¢ fee, a win pays +0.1 ¢ and a loss costs 99.9 ¢, so the break-even win probability is 99.9 %. The model's 99.54 % is below that.
   * The market was more confident than the model. Even the point estimate had negative expected value (−0.36 ¢), so this is not over-conservatism.
2. **The condition that blocked TRADE NOW** was `evConsCents (−1.07) < MIN_EDGE_CENTS (0.5)`. Book freshness, depth and time were all satisfied. At any ask of 99.4 ¢ or more, no probability can clear a 0.5 ¢ edge after the fee.
3. **LOCKED was not late.** It was on from T−96. At T−33 the book had no UP sellers, and 2.8 maps "no offers" to the label "LOCKED — TOO LATE". **This is a labelling defect:** the cause was the market, not timing.
4. **Classification:**
   * the decision was correct, a pricing limit: there was no edge at 99.8 ¢;
   * the "TOO LATE" text was a coding defect (wrong label);
   * there was no data latency (index 340 ms, book 526 ms) and no excess conservatism (the point estimate was also negative).
5. **An earlier, safe and profitable entry** would have needed the UP ask at or below about 98.2 ¢ while the model was LOCKED (from T−96). That is the cautious 98.83 % win probability, minus the 0.1 ¢ fee, minus the 0.5 ¢ minimum edge. Whether that happened is in the server's `/tape` and `/predictions` for this ticker; it can't be determined from the screenshots. Before T−96 the model was below the LOCKED standard. The prior research does not support buying there at market prices: when the market is cheap, the call is weaker (adverse-selection fit, pooling weight 0.66 on the market).

## Fix (2.8.1, research branch, not deployed)

* **No offers is no longer shown as too late.** While time remains it is **PREDICTED LOCKED — NO OFFERS** ("nobody is selling UP below 100 ¢"); the trade box says "LOCKED — NO OFFERS". TOO LATE TO TRADE is used only past the last moment an order can be placed. The decision is unchanged.
* **No edge is explained, with the price that would qualify.** Example: "NO EDGE — Kalshi already prices UP at 99.8 ¢ (≈99.8 % sure) vs the model's 99.54 %: … It would qualify only at ≤ 98.2 ¢."
* **Stale data downgrades the action banner too.** If the backend goes stale, or the window closes, the banner now says STALE — DO NOT TRADE or WINDOW CLOSED. This was an adversarial-review finding.
* **No threshold or probability changes, so reversal risk is unchanged.** Tests:
  * `late281_test.js` S9: a replica of these two screens on a real UP window (99.8 ¢ → NO EDGE, never TRADE NOW; empty book → NO OFFERS; under 13 s → TOO LATE; with a 97 ¢ ask → TRADE NOW at 13 s or more);
  * `page281_test.js`: the two screens, and the stale banner.
