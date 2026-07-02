# BTC AI Backend v75 — Data-Hardened AI Feed

Deploy on Render with Node 20+.

## Required environment variables
- `OPENAI_API_KEY`

## Optional environment variables
- `OPENAI_MODEL` default `gpt-4o-mini`
- `ALLOWED_ORIGINS` default `*`
- `RATE_LIMIT_PER_MIN` default `30`

## Endpoints
- `GET /health`
- `POST /analyze`
- `POST /api/ai-review`

## v75 purpose
Reduces false `FIX_DATA` outcomes by sending and using a tiered data packet: strict live venue mids, soft freshness fallback, consensus/BRTI packet, recent price-path fallback, timer, target, costs, and data diagnostics.
