# BTC AI Backend v72 — Practical Entry Independent AI

This backend keeps the raw-market-first independent AI architecture but changes the goal from "wait for near-certainty" to practical expected-value entries.

## v72 changes

- Independent model produces staged instructions: WAIT, PREPARE, ACT_NOW, SIT_OUT, FIX_DATA.
- It uses raw probabilities, contract costs, EV edge, volatility, target cushion, venue freshness, and time remaining.
- It no longer requires 99% certainty before becoming useful.
- It still stands down on severe data risk, late fragile entries, or engine/AI conflict.
- No real quantum computing is used; this is an advanced deterministic + AI ensemble approach.

## Render

Build command: `npm install`
Start command: `npm start`
Required env: `OPENAI_API_KEY`
