/* Read-only HTTP client. The observer can only issue GET requests to an explicit allowlist of read-only paths:
   any other method or path throws before a request is made (it can never write to Pin Radar or to Kalshi).
   * Redirects are refused (never followed): a redirect could otherwise point the client at a path or host outside the
     allowlist, and the reply would be stored as if it came from the allowlisted endpoint.
   * HTTPS is required, except for a loopback address (tests).
   * The body is read as a stream and cut at maxBytes (a hostile or broken server cannot exhaust memory).
   No credentials are sent anywhere: Kalshi data comes from its public market-data endpoints, so the observer has no
   way to see any account, order or position. Each response is returned with its timing for the evidence record. */
'use strict';

const PINRADAR_PATHS = [/^\/health$/, /^\/calibration$/, /^\/predictions$/, /^\/signals$/, /^\/ledger$/, /^\/shadow$/, /^\/brti-status$/];
const KALSHI_PATHS = [/^\/trade-api\/v2\/markets$/, /^\/trade-api\/v2\/markets\/KXBTC15M-[A-Z0-9-]+$/, /^\/trade-api\/v2\/markets\/KXBTC15M-[A-Z0-9-]+\/orderbook$/,
  /^\/trade-api\/v2\/series\/KXBTC15M$/];
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/;

function mkClient({ allow, timeoutMs = 8000, fetchImpl = fetch, now = Date.now, maxBytes = 32 << 20 }) {
  async function get(url) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) throw new Error('blocked: https required (' + u.protocol + '//' + u.hostname + ')');
    if (u.username || u.password) throw new Error('blocked: credentials in URL');
    if (!allow.some(re => re.test(u.pathname))) throw new Error('blocked by the read-only allowlist: ' + u.pathname);
    const tSent = now();
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(u.toString(), { method: 'GET', redirect: 'manual', headers: { Accept: 'application/json' }, signal: ac.signal });
      if (r.status >= 300 && r.status < 400 || r.type === 'opaqueredirect') {
        try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (_) { }
        return { ok: false, status: r.status, tSent, tRecv: now(), error: 'redirect refused (' + (r.headers && r.headers.get ? r.headers.get('location') : '') + ')' };
      }
      let text = '', bytes = 0, truncated = false;
      if (r.body && r.body.getReader) {
        const rd = r.body.getReader(), dec = new TextDecoder();
        for (;;) {
          const { done, value } = await rd.read(); if (done) break;
          bytes += value.length;
          if (bytes > maxBytes) { truncated = true; try { await rd.cancel(); } catch (_) { } break; }
          text += dec.decode(value, { stream: true });
        }
        text += dec.decode();
      } else { text = await r.text(); bytes = text.length; if (bytes > maxBytes) { text = text.slice(0, maxBytes); truncated = true; } }
      const tRecv = now();
      return { ok: r.ok && !truncated, status: r.status, tSent, tRecv, date: r.headers.get('date'), bytes, text, truncated, error: truncated ? 'response larger than ' + maxBytes + ' bytes: cut' : null };
    } catch (e) {
      return { ok: false, status: 0, tSent, tRecv: now(), error: String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e) };
    } finally { clearTimeout(tm); }
  }
  return { get };
}
module.exports = { mkClient, PINRADAR_PATHS, KALSHI_PATHS };
