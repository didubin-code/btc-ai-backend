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

const child = spawn(process.execPath, [path.join(__dirname, 'observer.js'), 'run', '--data', path.join(dir, 'data'), '--key', path.join(__dirname, 'keys', 'owner.public.pem'),
  '--sign-key', path.join(dir, 'host.sign.pem'), '--create-sign-key', '--pinradar', pinradar], { stdio: 'inherit', env: { ...process.env, OBSERVER_LOG_WINDOWS: process.env.OBSERVER_LOG_WINDOWS || '1' } });
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
}).listen(Number(process.env.PORT || 10000));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => { console.log(`[host] observer exited (${code == null ? signal : code})`); server.close(); process.exit(code == null ? 1 : code); });
