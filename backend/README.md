# BTC AI Backend v73.3 StreamGuard

Endpoints:

- `GET /` and `GET /health` — health check.
- `POST /analyze` — main AI copilot endpoint.
- `POST /api/ai-review` — alias for older frontends.

Deploy on Render:

1. Upload the `backend` folder to GitHub.
2. Render → New Web Service → select repo/folder.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variable `OPENAI_API_KEY`.
6. Optional: `OPENAI_MODEL=gpt-4o-mini`.

The backend always returns HTTP 200 for analysis results when it can parse the request. Bad market data returns `trade_read: FIX_DATA` rather than crashing. If OpenAI is unavailable, it returns a fresh local independent fallback and labels the anomaly.
