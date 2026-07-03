# BTC AI Backend v73.1 — Data Guard Independent AI

This keeps the v73 AI-first independent execution behavior but fixes repeated false FIX_DATA interruptions.

Changes:
- Tiered market data validation: LIVE_STRICT, LIVE_SOFT, CONSENSUS_FALLBACK, SERIES_FALLBACK.
- FIX_DATA only when there is no usable live consensus or recent price path.
- Backend accepts soft/stale-but-usable feed packets instead of rejecting them immediately.
- Keeps engine disagreement advisory unless data is truly unusable or there is true opposite-direction conflict.
- render.yaml is set to Starter so the backend does not intentionally revert to Free when deployed via blueprint.

Use with frontend: index_v73_1_data_guard_ai.html
Endpoint: /analyze
Health: /health
