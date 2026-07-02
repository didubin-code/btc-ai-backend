# BTC Signal v61 AI Copilot Backend

This backend keeps your OpenAI API key off GitHub Pages. The dashboard sends live snapshots to this server, and the server returns advisory JSON for the AI Copilot panel.

## Setup

```bash
cd v61_ai_backend
cp .env.example .env
# edit .env and set OPENAI_API_KEY and OPENAI_MODEL
npm install
npm start
```

Then open the v61 HTML file and leave the backend URL as:

```text
http://localhost:8787/api/ai-review
```

Click **AI local test** first, then **Start AI monitor**.

## Safety rules

The AI is advisory only. It does not execute trades, does not change thresholds, and does not override hard gates. During live trading it should flag problems and explain the dashboard state, not rewrite code.

## Deployment

For non-local use, deploy this backend on a server you control and set `ALLOWED_ORIGIN` to your GitHub Pages domain. Never put `OPENAI_API_KEY` in the HTML file.
