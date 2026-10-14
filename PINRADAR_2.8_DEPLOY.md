# BTC Pin Radar 2.8 — isolated deployment branch `pinradar-2.8`

This branch is `main` (c9e0df6) with exactly one file replaced, plus this note:

* `pinradar_server.js` is the 2.8 build. It was verified on the research branch `claude/btc-pin-radar-research-xpe585`; the sha256 is in `pinradar-research/2.8/SHA256SUMS.txt` there.
* `server.js`, `package.json`, `render.yaml` and everything else are identical to `main`.

**Never merge this branch into `main`.** `main` runs your existing services.

## The fourth Render service (create it only after explicit approval)

Create it as a plain **New → Web Service**. Do *not* create it as a Blueprint: `render.yaml` here describes the existing `btc-ai-backend` service.

| Setting | Value |
|---|---|
| Name | `btc-pin-radar-28` (URL `https://btc-pin-radar-28.onrender.com`, or Render's suffixed variant) |
| Repository / branch | `didubin-code/btc-ai-backend` / **`pinradar-2.8`** |
| Runtime | Node (Node 20 or newer) |
| Build command | `npm install` |
| Start command | `node pinradar_server.js` |
| Instance type | Starter ($7/month); always on, which the forward test needs. Free instances sleep after 15 minutes idle. |
| Auto-Deploy | Off recommended, so a push to this branch redeploys only when you click Deploy |
| Environment variables | none required. Do **not** copy Kalshi keys from the existing services (keeps 2.8 fully separate; it runs in PROXY mode on public data). |
| Persistent disk (optional) | 1 GB at `/var/data` ($0.25/month), then set `LEDGER_FILE=/var/data/ledger28.ndjson`, `TAPE_FILE=/var/data/tape28.ndjson` |

2.8 needs no database and no secrets, and it does not call any of your existing services.

## Check after deploy

* `/health` shows `pin-radar-2.8`.
* `/selftest` shows 134/134.
* `/v28` shows the `configHash`; write it down, the forward test needs it.

Then open the 2.8 page (`btc_pin_radar_28.html` from the `pinradar-2.8` branch of `Btc-signal`) and enter the new service URL as the backend URL.

## Rollback

Suspend or delete the `btc-pin-radar-28` service. Nothing else changed.
