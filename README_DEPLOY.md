# BTC Signal v73.3 StreamGuard Deployment

## Frontend
Upload this file to GitHub Pages:

`frontend/index_v73_3_streamguard.html`

Use that as the new page. The backend URL box defaults to:

`https://btc-ai-backend-oz7g.onrender.com/analyze`

If you accidentally paste only the root Render URL, the frontend auto-adds `/analyze`.

## Backend
Deploy the `backend` folder to Render.

Render settings:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `OPENAI_API_KEY` = your OpenAI API key
  - `OPENAI_MODEL` = `gpt-4o-mini` unless you intentionally change it

## Verify live
In the frontend:

1. Click **Start live data**.
2. Enter target and contract costs.
3. Start the 15:00 timer.
4. Click **Self check**.
5. Click **Start AI monitor**.

Working indicators:

- AI state: `AI FRESH`
- Age resets every cycle
- Last HTTP: `200`
- Backend snapshot age: `0s`, `1s`, or very low
- Fresh venues: `2+`, ideally `3–4`
- Clean cycles increases

Do not rely on the AI panel when it says `AI STALE`, `FIX DATA`, `DATA STOP`, or when clean cycles reset to 0.
