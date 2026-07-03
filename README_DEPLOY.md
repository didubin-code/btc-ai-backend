# BTC Signal v74.0 BRTITruth

Purpose: stop trading from exchange-proxy BTC prices. Backend attempts to pull the CF Benchmarks BRTI public page and exposes it through `/market` and `/brti`.

Important: this uses CF Benchmarks public BRTI page parsing, not a contracted licensed CF/CME data API. If CF changes or blocks the page, `/market` returns `DATA_NOT_SETTLEMENT_GRADE` and the frontend must not be used for ACT_NOW trades.

Deploy order:
1. Backend repo `btc-ai-backend`: upload the `backend/` folder. Keep Render Root Directory = `backend`. Deploy with clear build cache. Verify `/health` shows `v74.0-brtitruth`, then `/brti` and `/market` show `settlementGrade:true` / `settlement_grade:true`.
2. Frontend repo `Btc-signal`: upload `frontend/index_v74_brtitruth.html` as `index.html`; upload `frontend/engine_v74_brtitruth.html` as `engine.html`.

Use only if the page shows `BRTI GOOD`. Do not trade from `PROXY ONLY`, `DATA NOT BRTI`, or `DATA_NOT_SETTLEMENT_GRADE`.
