#!/usr/bin/env node
/* Host wrapper for a Render web service. Render requires a web service to open a port; this one serves no data
   (GET /healthz -> "ok", anything else 404). It runs observer.js as a child process and exits when the child exits, so
   Render restarts the service. observer.js itself still opens no port and writes nothing to production.
   Environment:
     OBSERVER_PINRADAR   production Pin Radar base URL (read-only exports)            required
     OBSERVER_DIR        persistent disk mount (data + host signing key)              default /var/observer
   If OBSERVER_DIR is not a mounted disk, the data lives on the instance's ephemeral filesystem and is LOST at every
   restart or deploy; this is logged at start and every hour until a disk is attached. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const pinradar = process.env.OBSERVER_PINRADAR;
if (!pinradar) { console.error('OBSERVER_PINRADAR is required'); process.exit(2); }
let dir = process.env.OBSERVER_DIR || '/var/observer', mounted = false;
try {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.accessSync(dir, fs.constants.W_OK);
  mounted = fs.statSync(dir).dev !== fs.statSync(path.dirname(path.resolve(dir))).dev;   // a disk is its own device
} catch (_) { dir = path.join(__dirname, '..', '.observer-ephemeral'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
const warn = () => { if (!mounted) console.error(`[host] WARNING: ${dir} is NOT a persistent disk. Recorded data is lost at every restart or deploy. Attach a disk at ${process.env.OBSERVER_DIR || '/var/observer'}.`); };
console.log(`[host] data directory ${dir} (${mounted ? 'persistent disk' : 'EPHEMERAL'})`); warn();
setInterval(warn, 3600e3).unref();

/* hourly storage line: bytes per stream, free space, and a warning before the disk fills (nothing is ever deleted) */
const sizeOf = d => { let n = 0; try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); n += e.isDirectory() ? sizeOf(f) : e.isFile() ? fs.statSync(f).size : 0; } } catch (_) { } return n; };
const MB = b => (b / 1048576).toFixed(1) + ' MB';
const storage = () => {
  const data = path.join(dir, 'data'), per = {}; let tot = 0;
  for (const s of ['raw', 'health', 'derived', 'audit']) { per[s] = sizeOf(path.join(data, s)); tot += per[s]; }
  let free = null, size = null; try { const f = fs.statfsSync(dir); free = f.bavail * f.bsize; size = f.blocks * f.bsize; } catch (_) { }
  const used = size ? 1 - free / size : null;
  console.log(`[storage] data ${MB(tot)} (raw ${MB(per.raw)}, health ${MB(per.health)}, derived ${MB(per.derived)}, audit ${MB(per.audit)})` + (size ? `; filesystem ${(used * 100).toFixed(1)} % used, ${(free / 1073741824).toFixed(2)} GB free` : ''));
  if (used != null && used > 0.8) console.error(`[storage] WARNING: the data filesystem is ${(used * 100).toFixed(0)} % full; enlarge the disk before it fills (writes would then fail and be recorded as gaps)`);
};
setTimeout(storage, 60e3).unref(); setInterval(storage, 3600e3).unref();

/* OBSERVER_HEARTBEAT_URL (optional, e.g. a free Healthchecks.io check): every 10 min a plain GET of the URL when all is
   well, or of <URL>/fail when the disk is not mounted or more than 80 % full, or collection has stalled. The check's
   service e-mails the owner when a /fail arrives or the pings stop. Only the ping is sent: no data, no headers of ours. */
const hb = process.env.OBSERVER_HEARTBEAT_URL;
if (hb) {
  const https = require('https');
  const beat = () => {
    let problem = mounted ? null : 'no persistent disk';
    try { const f = fs.statfsSync(dir); if (1 - f.bavail / f.blocks > 0.8) problem = 'disk over 80 % full'; } catch (_) { }
    try { const st = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'status.json'), 'utf8')); if (!st.ok || Date.now() - Date.parse(st.at) > 600e3) problem = problem || 'collection stalled or writes failing'; } catch (_) { problem = problem || 'no status yet'; }
    const url = hb.replace(/\/+$/, '') + (problem ? '/fail' : '');
    https.get(url, { timeout: 10e3 }, r => r.resume()).on('error', () => { }).on('timeout', function () { this.destroy(); });
    if (problem) console.error('[host] heartbeat FAIL sent: ' + problem);
  };
  setTimeout(beat, 120e3).unref(); setInterval(beat, 600e3).unref();
}

const child = spawn(process.execPath, [path.join(__dirname, 'observer.js'), 'run', '--data', path.join(dir, 'data'), '--key', path.join(__dirname, 'keys', 'owner.public.pem'),
  '--sign-key', path.join(dir, 'host.sign.pem'), '--create-sign-key', '--pinradar', pinradar], { stdio: 'inherit', env: { ...process.env, OBSERVER_LOG_WINDOWS: process.env.OBSERVER_LOG_WINDOWS || '1' } });
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT || 10000));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => { console.log(`[host] observer exited (${code == null ? signal : code})`); server.close(); process.exit(code == null ? 1 : code); });
