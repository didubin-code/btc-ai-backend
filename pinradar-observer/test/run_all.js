/* npm test: every suite in its own process; each must exit 0.
     isolation  Test 1   production source, repositories and Trader 5.0 unchanged; observer only adds files
     unit       Tests 4, 7, 8, 9 + classifications (pricing without look-ahead, torn writes, backup/restore, security, missing data)
     math       Test 6   every fill, fee, P&L, interval and posterior against an independent exact implementation
     e2e        Tests 2, 3, 4, 5, 7, 9, 10  the real observer against production's own code, in real time, with a kill -9 */
'use strict';
const { spawnSync } = require('child_process'), path = require('path');
const suites = ['isolation_test.js', 'unit_test.js', 'math_test.js', 'e2e_test.js'];
let failed = 0;
for (const s of suites) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20 * 60e3 });
  const out = (r.stdout || '') + (r.stderr || '');
  const last = out.trim().split('\n').filter(l => /passed|agree|SKIPPED/.test(l)).pop() || '(no summary)';
  if (r.status !== 0) { failed++; console.log(out); }
  console.log((r.status === 0 ? 'PASS ' : 'FAIL ') + s.padEnd(18) + last + '  (' + ((Date.now() - t) / 1000).toFixed(1) + ' s)');
}
console.log(failed ? failed + ' suite(s) FAILED' : 'all suites passed');
process.exit(failed ? 1 : 0);
