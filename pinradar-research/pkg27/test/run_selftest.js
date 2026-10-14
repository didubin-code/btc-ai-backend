/* usage: node run_selftest.js <path to pinradar_server.js>  -> prints pass/fail of the built-in self-test (no network) */
process.env.ENABLE_WS = '0';
const s = require(require('path').resolve(process.argv[2] || '../upload/btc-ai-backend/pinradar_server.js'));
const r = s.runSelfTest();
for (const c of r.checks) if (!c.pass) console.log('FAIL ' + c.name + ' :: ' + String(c.got).slice(0, 200));
console.log(`selftest ${r.passed}/${r.total} ${r.ok ? 'OK' : 'FAILED'} (${r.version})`);
process.exit(r.ok ? 0 : 1);
