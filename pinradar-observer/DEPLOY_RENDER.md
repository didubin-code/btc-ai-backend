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

## Persistent disk (verified 31 Oct 2026)

* **Attached:** disk `dsk-dbj3bd49v7es7390tucg`, 10 GB, mounted at `/var/observer`, at 18:38 UTC.
* **Restart test, 18:45 UTC:**
  * the host signing key was reused (signer `bf68a97ec3178ab8`), not recreated;
  * the store resumed at raw 436 / health 16 records, with the newest stored record at 18:45:43 UTC from before the restart;
  * `[storage]` reported 5.3 MB of data and 9.72 GB free.
* **Collection on the disk** started at 18:40 UTC. On the first start of the current code, production's memory was back-filled from 30 Oct 17:46 UTC.

## Notifications and backups (owner action)

* **Alerts:**
  * Create a free check at healthchecks.io: period 10 minutes, grace 30 minutes.
  * Set its ping URL as `OBSERVER_HEARTBEAT_URL` on this service.
  * The host then pings `<url>/fail` when the disk is missing or over 80 % full, or collection stalls. Silence also alerts.
* **Backups:**
  * Check the Disks tab for Render's automatic snapshots.
  * For an off-Render copy, add your Mac's SSH key in Render (Account Settings → SSH Public Keys), then run:
    `rsync -av srv-dbj1i87f3r2c73en4ukg@ssh.oregon.render.com:/var/observer/data/ /Volumes/<Drive>/pinradar-observer/`
  * Never copy `host.sign.pem` off the host.

## Logs

Each settled window produces one `[window]` line, showing:
* coverage, or `UNOBSERVED`;
* the first qualifying LOCKED second at ≤ 0.2 %, or `NONE`;
* the ask and the size at the ask;
* lost LOCKED, reversal warning and direction reversal, each separately;
* Kalshi's result, and whether the signal was CORRECT or WRONG.

There are also hourly `[prod] /health` lines. To stop the plain-text window lines, set `OBSERVER_LOG_WINDOWS=0`.
