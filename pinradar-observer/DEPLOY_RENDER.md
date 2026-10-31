# The observer on Render

**Deployed 31 Oct 2026** in the workspace "BTC AI" as the web service **`pinradar-observer`** (`srv-dbj1i87f3r2c73en4ukg`, Oregon, Starter).
* **Code:** branch `claude/btc-pin-radar-research-xpe585` of `didubin-code/btc-ai-backend`.
* **Deploys:** Auto-Deploy is **off**, so collection is never restarted by a push.
* **Start command:** `node pinradar-observer/render_host.js`.
* **Environment variables:**
  * `OBSERVER_PINRADAR=https://btc-pin-radar.onrender.com` (the production service `btc-pin-radar`, read only);
  * `OBSERVER_DIR=/var/observer`;
  * `NODE_VERSION=22`.

`render_host.js` opens the port Render requires for a web service. It serves no data: `GET /healthz` returns `ok`, and everything else returns 404. It runs `observer.js` and restarts with it. The data is encrypted to `keys/owner.public.pem`; only your `owner.private.pem` can read it.

## Remaining dashboard step: attach a persistent disk

Without a disk, the recorded data is lost at every restart or deploy. The service logs a warning every hour until a disk is attached.

1. In Render, open **pinradar-observer**, then **Disks**, then **Add disk**.
2. Fill in:
   * Mount path: `/var/observer`;
   * Size: `10` GB.
3. Save. Render redeploys this service only. The production `btc-pin-radar` is not touched.
4. In the logs, check for `[host] data directory /var/observer (persistent disk)`.

## Logs

Each settled window produces one `[window]` line, showing:
* coverage, or `UNOBSERVED`;
* the first qualifying LOCKED second at ≤ 0.2 %, or `NONE`;
* the ask and the size at the ask;
* lost LOCKED, reversal warning and direction reversal, each separately;
* Kalshi's result, and whether the signal was CORRECT or WRONG.

There are also hourly `[prod] /health` lines. To stop the plain-text window lines, set `OBSERVER_LOG_WINDOWS=0`.
