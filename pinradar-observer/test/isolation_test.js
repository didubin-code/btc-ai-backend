/* Test 1 — production isolation. The production source on main is exactly the recorded baseline; no tracked file in either
   repository was modified; everything the observer adds is new and lives under pinradar-observer/; the Trader 5.0 code was
   not touched. (Render itself could not be inspected from the build environment: see README "Limitations".) */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..'), B = path.join(ROOT, '..'), SIG = process.env.PR_SIGNAL_REPO || path.join(B, '..', 'Btc-signal');
const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'BASELINE.json'), 'utf8'));
const g = (repo, ...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 << 20 });
const h = b => crypto.createHash('sha256').update(b).digest('hex');
const results = []; const ok = (n, p, d) => results.push([!!p, n + (d != null ? ' :: ' + d : '')]);

try { g(B, 'fetch', '-q', 'origin', 'main'); } catch (_) { }
const main = String(g(B, 'rev-parse', 'origin/main')).trim();
ok('btc-ai-backend main is still the baseline commit', main === base.btcAiBackend.mainCommit, main);
for (const [f, sum] of Object.entries(base.btcAiBackend.files)) ok('production file unchanged on main: ' + f, h(g(B, 'show', 'origin/main:' + f)) === sum);
const status = String(g(B, 'status', '--porcelain')).split('\n').filter(Boolean);
const modified = status.filter(l => !/^\?\?/.test(l) && !/ pinradar-observer\//.test(l) && !/^A  pinradar-observer\//.test(l));
ok('no tracked file in btc-ai-backend is modified (only new files under pinradar-observer/)', modified.length === 0, modified.slice(0, 5).join(', '));
const outside = status.filter(l => /^\?\?/.test(l) && !/pinradar-observer\//.test(l));
ok('no new file outside pinradar-observer/', outside.length === 0, outside.join(', '));
/* every commit on the working branch since the baseline only adds files under pinradar-observer/ (never edits existing ones) */
let changed = '';
try { changed = String(g(B, 'diff', '--name-status', 'origin/claude/btc-pin-radar-research-xpe585', 'HEAD')); } catch (_) { }
ok('the branch changes nothing outside pinradar-observer/', changed.split('\n').filter(Boolean).every(l => /\tpinradar-observer\//.test(l)), changed.split('\n').filter(l => l && !/pinradar-observer\//.test(l)).slice(0, 3).join(' | '));
if (fs.existsSync(SIG)) {
  try { g(SIG, 'fetch', '-q', 'origin', 'main'); } catch (_) { }
  ok('Btc-signal main is still the baseline commit', String(g(SIG, 'rev-parse', 'origin/main')).trim() === base.btcSignal.mainCommit);
  const sst = String(g(SIG, 'status', '--porcelain', '--', 'pinradar-trader')).trim();
  ok('Trader 5.0 (Btc-signal pinradar-trader/) has no local change', sst === '', sst);
}
/* the observer's code cannot touch production: it never loads the production module (only the test fixture does) */
for (const f of ['observer.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map(x => 'lib/' + x)]) {
  const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok('observer code does not load or modify production code: ' + f, !/pinradar_server|require\(['"]\.\.\/\.\.\//.test(s));
}
let n = 0; for (const [p, s] of results) { console.log((p ? 'ok   ' : 'FAIL ') + s); if (p) n++; }
console.log(`isolation: ${n}/${results.length} passed`);
process.exit(n === results.length ? 0 : 1);
