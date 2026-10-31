# Starting the observer on Render

This takes about 10 minutes. It creates a **new, separate** Render service. The existing Pin Radar service is not opened, changed, restarted or redeployed.

**Cost.** Render's free plan has no background workers or disks. This setup uses a Starter background worker (about $7 a month) plus a 10 GB disk (about $2.50 a month). Check Render's pricing page for current prices.

## Steps

1. Log in to Render at https://dashboard.render.com. Your existing account is fine, and so is a new one.
2. Click **New +**, then **Background Worker**.
3. Connect GitHub if Render asks, then choose the repository **didubin-code/btc-ai-backend**.
4. Fill in the form exactly as follows:

| Field | Value |
|---|---|
| Name | `pinradar-observer` |
| Branch | `claude/btc-pin-radar-research-xpe585` |
| Root Directory | `pinradar-observer` |
| Runtime / Language | `Node` |
| Build Command | `node --version` |
| Start Command | `node observer.js run --data /var/observer/data --key keys/owner.public.pem --sign-key /var/observer/host.sign.pem --create-sign-key --pinradar https://btc-pin-radar-28.onrender.com` |
| Instance Type | `Starter` |

5. Open **Advanced** and click **Add Disk**:
   * Name: `observer-data`;
   * Mount Path: `/var/observer`;
   * Size: `10` GB.
6. In **Advanced**, set **Auto-Deploy** to **No**. Collection then runs without interruption, and is never restarted by a code change.
7. Click **Create Background Worker**.

## Checking that it works

After a minute or two, open the new service's **Logs**. You should see:
* `[pinradar-observer-1.2] observing https://btc-pin-radar-28.onrender.com (read-only)`;
* a block starting `-----BEGIN PUBLIC KEY-----` under "checkpoints signed by …".

Copy that block into a note and keep it. It proves later that the records were written by this service.

## Keep safe

* **`owner.private.pem`** (sent to you separately) is the only key that can read the recorded data.
* Keep it in at least two private places, for example your computer and a USB stick or password manager.
* Never upload it to Render or GitHub.
* If it is lost, the recorded data cannot be read by anyone.
