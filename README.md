# BTC AI Backend v73.2 AI Watchdog

Keeps v73/v73.1 independent AI-first behavior while improving reliability at 5-second polling.

Changes:
- Adds backend OpenAI request timeout handling.
- Keeps v73.1 data guard fallback behavior.
- Version health returns v73.2-ai-watchdog.

Deploy:
1. Upload unzipped files to btc-ai-backend GitHub repo.
2. Commit.
3. Render Manual Deploy -> Deploy latest commit.
4. Check /health.
