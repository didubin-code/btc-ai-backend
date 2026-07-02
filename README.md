# BTC AI Backend v76 — OpenAI-Resilient AI Feed

Changes from v75:
- Prevents a temporary OpenAI/API failure from killing the AI panel.
- Uses a compact current-market packet to reduce latency and token size.
- Adds OpenAI timeout/retry handling.
- Falls back to a fresh local EV model from the same current snapshot if OpenAI is temporarily unavailable.
- Keeps data-tier fallback logic from v75.

Deploy by uploading these unzipped files to the Render-connected GitHub backend repo, then Manual Deploy latest commit.
