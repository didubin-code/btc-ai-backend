BTC OpenAI Copilot Backend v1.0

Upload these files to the ROOT of your Render backend GitHub repo:

1. server.js        (rename btc_openai_backend_server.js to server.js if needed)
2. package.json    (rename btc_openai_backend_package.json to package.json if needed)
3. render.yaml     (optional)

Render settings:
- Build command: npm install
- Start command: npm start
- Environment variable: OPENAI_API_KEY = your OpenAI API key
- Optional environment variable: OPENAI_MODEL = gpt-5.4-mini

After Render deploys, test:
https://YOUR-RENDER-SERVICE.onrender.com/health

Then in frontend backend URL field, use:
https://YOUR-RENDER-SERVICE.onrender.com

The frontend will call /analyze automatically.

Expected frontend result after Start AI:
AI status: RUNNING
AI action: ACT_NOW_ABOVE / ACT_NOW_BELOW / WAIT_EARLY_REVERSAL / WAIT_NO_TRADE / HOLD_ABOVE / HOLD_BELOW / EXIT_NOW_CONFIRMED
AI blocker should NOT show BACKEND_SCHEMA_MISMATCH.
