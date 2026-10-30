/* Order-book normalisation and theoretical (never executed) purchases.

   Kalshi's public book lists BIDS only, in dollars, with 0.1 c steps and fractional sizes:
     { orderbook_fp: { yes_dollars: [[price, size], ...], no_dollars: [...] } }     (older form: orderbook.yes / .no in cents)
   A YES ask at p is a NO bid at 100 - p, and vice versa. So the asks of the side a signal calls are:
     UP (buy YES)  <- NO bids, price 100 - bid;   DOWN (buy NO) <- YES bids, price 100 - bid.

   A theoretical purchase walks those asks from the cheapest, as a taker, against the snapshot exactly as recorded:
   no queue position, no latency, no price improvement, and nobody else trading. That is an upper bound on what an order
   sent at that instant could have obtained. Fees: Kalshi's quadratic taker fee per fill level,
   ceil(rate x C x P x (1 - P)) to the cent, with rate = 0.07 x the series fee multiplier (recorded from /series). */
'use strict';
const r2 = x => Math.round(x * 100) / 100, r4 = x => Math.round(x * 1e4) / 1e4;

function levels(arr, dollars) {
  return (arr || []).map(([p, s]) => [dollars ? Number(p) * 100 : Number(p), Number(s)]).filter(([p, s]) => p > 0 && p < 100 && s > 0);
}
/* -> { yesAsks: [[cents, size]...] ascending, noAsks, yesBids, noBids } */
function normaliseBook(body) {
  if (!body) return null;
  const fp = body.orderbook_fp, ob = body.orderbook;
  const yesB = fp ? levels(fp.yes_dollars, true) : levels(ob && ob.yes, false);
  const noB = fp ? levels(fp.no_dollars, true) : levels(ob && ob.no, false);
  const asc = (a, b) => a[0] - b[0];
  return {
    yesBids: yesB.slice().sort((a, b) => b[0] - a[0]), noBids: noB.slice().sort((a, b) => b[0] - a[0]),
    yesAsks: noB.map(([p, s]) => [r4(100 - p), s]).sort(asc), noAsks: yesB.map(([p, s]) => [r4(100 - p), s]).sort(asc),
  };
}
function feeUsd(pCents, C, rate) { const P = pCents / 100; return Math.ceil(rate * C * P * (1 - P) * 100 - 1e-9) / 100; }

/* buy as much as budgetUsd allows (cost + fees <= budget), contracts in steps of `step` (Kalshi: 0.01 when fractional) */
function walk(asks, budgetUsd, rate, step = 0.01) {
  let spent = 0, fees = 0, C = 0, cost = 0, stoppedBy = 'book'; const used = [];
  for (const [p, size] of asks) {
    const unit = p / 100;
    let n = Math.min(size, Math.floor(((budgetUsd - spent) / unit) / step) * step);
    while (n > 0 && spent + n * unit + feeUsd(p, n, rate) > budgetUsd + 1e-9) n = Math.round((n - step) / step) * step;
    if (n <= 0) { stoppedBy = 'budget'; break; }
    const f = feeUsd(p, n, rate);
    spent += n * unit + f; fees += f; C += n; cost += n * unit; used.push([p, r2(n)]);
    if (n < size - 1e-9) { stoppedBy = 'budget'; break; }   // budget exhausted inside this level
  }
  return { contracts: r2(C), costUsd: r2(cost), feesUsd: r2(fees), capitalUsd: r2(spent), avgPriceCents: C ? r4(100 * cost / C) : null,
    worstPriceCents: used.length ? used[used.length - 1][0] : null, levelsUsed: used.length, stoppedBy };
}

/* theoretical results at each size for the called side; outcome: true (won) / false (lost) / null (unknown) */
function theoretical(asks, sizes, rate, outcome) {
  const totalDepthUsd = r2(asks.reduce((a, [p, s]) => a + p / 100 * s, 0));
  const out = sizes.map(budget => {
    const w = walk(asks, budget, rate);
    const payoutIfWin = r2(w.contracts);
    /* fully fillable: the whole budget went in and the book still had offers left; otherwise the book ran out first */
    return { budgetUsd: budget, ...w, fullyFillable: w.contracts > 0 && w.stoppedBy === 'budget', unfilledUsd: r2(budget - w.capitalUsd),
      payoutIfWinUsd: payoutIfWin, netIfWinUsd: r2(payoutIfWin - w.capitalUsd), netIfLossUsd: r2(-w.capitalUsd),
      netUsd: outcome == null ? null : r2(outcome ? payoutIfWin - w.capitalUsd : -w.capitalUsd),
      returnPct: outcome == null || !w.capitalUsd ? null : r4(100 * (outcome ? payoutIfWin - w.capitalUsd : -w.capitalUsd) / w.capitalUsd) };
  });
  return { totalAskDepthUsd: totalDepthUsd, sizes: out };
}
module.exports = { normaliseBook, feeUsd, walk, theoretical };
