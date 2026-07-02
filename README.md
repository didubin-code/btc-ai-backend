# BTC Signal AI Copilot Backend v64

Render-ready backend for the BTC Signal AI Copilot.

## What changed in v64

- Fixes the frontend/backend JSON mismatch that caused the dashboard to show `UNKNOWN — No explanation returned`.
- Returns AI fields at the top level, exactly as the dashboard expects:
  - `health`
  - `trade_read`
  - `reason`
  - `main_blocker`
  - `max_price`
  - `anomaly_warning`
  - `confidence`
- Keeps nested `ai` output too, so old and new dashboard versions both work.
- Supports both endpoints:
  - `POST /analyze`
  - `POST /api/ai-review`
- Accepts the current dashboard's nested snapshot payload.

## Render settings

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Environment variable:

```bash
OPENAI_API_KEY=your_key_here
```

Optional:

```bash
OPENAI_MODEL=gpt-4o-mini
RATE_LIMIT_PER_MIN=30
ALLOWED_ORIGINS=*
```

## Test locally

```bash
npm install
npm test
npm start
```

Then open:

```text
http://localhost:3000/health
```

## Dashboard URL

Use either:

```text
https://YOUR-RENDER-URL.onrender.com/analyze
```

or:

```text
https://YOUR-RENDER-URL.onrender.com/api/ai-review
```
