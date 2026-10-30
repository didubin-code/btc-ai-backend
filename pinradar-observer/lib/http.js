/* Read-only HTTP client. The observer can only issue GET requests to an explicit allowlist of read-only paths:
   any other method or path throws before a request is made (it can never write to Pin Radar or to Kalshi).
   No credentials are sent anywhere: Kalshi data comes from its public market-data endpoints, so the observer has no
   way to see any account, order or position. Each response is returned with its timing for the evidence record. */
'use strict';

const PINRADAR_PATHS = [/^\/health$/, /^\/calibration$/, /^\/predictions$/, /^\/signals$/, /^\/ledger$/, /^\/shadow$/, /^\/brti-status$/];
const KALSHI_PATHS = [/^\/trade-api\/v2\/markets$/, /^\/trade-api\/v2\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/trade-api\/v2\/markets\/KXBTC15M-[A-Z0-9-]+\/orderbook$/,
  /^\/trade-api\/v2\/series\/KXBTC15M$/];

function mkClient({ allow, timeoutMs = 8000, fetchImpl = fetch, now = Date.now, maxBytes = 32 << 20 }) {
  async function get(url) {
    const u = new URL(url);
    if (!allow.some(re => re.test(u.pathname))) throw new Error('blocked by the read-only allowlist: ' + u.pathname);
    const tSent = now();
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(u.toString(), { method: 'GET', headers: { Accept: 'application/json' }, signal: ac.signal });
      const text = await r.text();
      const tRecv = now();
      return { ok: r.ok, status: r.status, tSent, tRecv, date: r.headers.get('date'), bytes: text.length, text: text.length > maxBytes ? text.slice(0, maxBytes) : text, truncated: text.length > maxBytes };
    } catch (e) {
      return { ok: false, status: 0, tSent, tRecv: now(), error: String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e) };
    } finally { clearTimeout(tm); }
  }
  return { get };
}
module.exports = { mkClient, PINRADAR_PATHS, KALSHI_PATHS };
