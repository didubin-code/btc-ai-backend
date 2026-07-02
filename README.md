# BTC AI Backend v71 — Full Independent AI

This backend performs a raw-market-first independent analysis before comparing against the deterministic dashboard engine.

## v71 changes
- Computes a server-side `rawIndependentModel` from venue mids, spreads, freshness, target distance, recent price path, volatility, timer, and costs.
- Sends the AI raw market state plus the raw independent model first.
- Engine output is provided only for the comparison stage.
- Returns independent AI probabilities, trend/regime/volatility, fair max prices, hidden risks, and Engine vs AI consensus.

## Render
Build command: `npm install`
Start command: `npm start`
Environment variable: `OPENAI_API_KEY`
