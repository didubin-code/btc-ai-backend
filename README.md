# BTC AI Backend v78 — AI-Priority Continuous Stream

Adds v73-style AI-priority independent execution on top of v77 evidence calibration.

Key changes:
- Rolling AI data stream payload support from frontend.
- Backend preserves last clean AI read per browser session and can hold it briefly during temporary OpenAI failures if the current market stream has not materially changed.
- Longer OpenAI timeout and extra retry.
- Local EV fallback remains available, but it no longer needlessly interrupts a recent valid AI read.
- Engine conservatism remains a warning, not an automatic veto, unless data is unusable or there is true opposite-direction conflict.

Deploy to Render with OPENAI_API_KEY set.
