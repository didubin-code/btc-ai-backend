# BTC AI Backend v69.0 — Independent AI Analyst

This backend analyzes raw market data first, then compares the independent AI read against the deterministic dashboard engine.

Deploy on Render exactly like before: upload these files to the `btc-ai-backend` GitHub repo, then in Render click **Manual Deploy → Deploy latest commit**. Keep `OPENAI_API_KEY` in Render environment variables only.

Endpoints:
- `GET /health`
- `POST /analyze`
- `POST /api/ai-review`

The response includes:
- `independent_ai.decision`
- `engine_read.decision`
- `consensus.label`
- frontend-compatible `trade_read`, `reason`, `main_blocker`, `max_price`

