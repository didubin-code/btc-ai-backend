# BTC Signal AI Copilot Backend v63

This is the Render-ready backend for the BTC Signal AI Copilot panel.

## What it does

- Keeps your OpenAI API key off GitHub Pages.
- Provides `GET /health` for testing.
- Provides `POST /analyze` for dashboard snapshots.
- Returns structured AI advisory JSON.
- Includes basic CORS, security headers, validation, and rate limiting.

## Render settings

Use these if Render asks:

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Root Directory: leave blank

Environment variables:

- `OPENAI_API_KEY` = paste your new OpenAI API key directly into Render, never into GitHub or ChatGPT.
- `OPENAI_MODEL` = `gpt-4o-mini` unless you want to change models.
- `RATE_LIMIT_PER_MIN` = `30`

## Test locally

```bash
npm install
npm test
OPENAI_API_KEY=your_key_here npm start
```

Open:

```text
http://localhost:3000/health
```

## Dashboard connection

After Render deploys, copy your Render URL, for example:

```text
https://btc-ai-backend-xxxx.onrender.com
```

Paste that into the AI Copilot backend URL field in the v61/v62 dashboard.

## Important

This backend provides advisory analysis only. It must not override hard safety gates or execute trades automatically.
