/* End-to-end (Tests 2, 3, 4, 5, 7, 10): the real observer CLI against production's own code (fixture_server.js) and a mock
   Kalshi API, in real time, including a kill -9 of the observer mid-run and a restart. The ground truth is recorded on a
   separate path (the engine's per-second signal, every book served with its time, the real results) and every derived
   value is compared with it. */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn, spawnSync } = require('child_process');
const DATA = process.env.PR_DATA || '/home/user/data_val';
if (!fs.existsSync(path.join(DATA, 'sec', 'usdc')) || !fs.existsSync(path.join(DATA, 'kalshi', 'markets_usdc.ndjson'))) { console.log('e2e: SKIPPED (historical data not found under ' + DATA + ')'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'obs_e2e_'));
const GT = path.join(W, 'truth.json'), DD = path.join(W, 'data');
/* the recommended deployment: the observer host holds only the PUBLIC key; reading needs the private key */
const PUB = path.join(W, 'owner.public.pem'), KEY = path.join(W, 'owner.private.pem');
const results = []; const ok = (n, p, d) => results.push([!!p, n + (d != null ? ' :: ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : '')]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIVE_AFTER = 75;

(async () => {
  const fx = spawn(process.execPath, [path.join(__dirname, 'fixture_server.js'), GT], { env: { ...process.env, FIX_WINDOWS: '6', FIX_LIVE_AFTER: String(LIVE_AFTER) } });
  let fxOut = ''; fx.stdout.on('data', d => fxOut += d); fx.stderr.on('data', d => fxOut += d);
  for (let i = 0; i < 240 && !/READY/.test(fxOut); i++) await sleep(500);
  const m = fxOut.match(/READY (\d+) (\d+) (\d+)/); if (!m) { console.log('fixture failed: ' + fxOut.slice(-800)); process.exit(1); }
  const [, p1, p2, t0] = m; const T0 = Number(t0) * 1000;
  spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'keypair', '--out', path.join(W, 'owner')]);
  spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'signkey', '--out', path.join(W, 'host')]);
  const SIGN = path.join(W, 'host.sign.pem'), SIGNPUB = path.join(W, 'host.sign.pub.pem');
  const runObs = () => { const c = spawn(process.execPath, [path.join(ROOT, 'observer.js'), 'run', '--data', DD, '--key', PUB, '--sign-key', SIGN, '--pinradar', 'http://127.0.0.1:' + p1, '--kalshi', 'http://127.0.0.1:' + p2 + '/trade-api/v2'],
    { env: { ...process.env, OBSERVER_INTERVAL_SCALE: '0.1', OBSERVER_BEAT_MS: '5000' } }); c.out = ''; c.stdout.on('data', d => c.out += d); c.stderr.on('data', d => c.out += d); return c; };
  let ob = runObs();
  /* durability: kill -9 in the middle of the live window, restart 4 s later */
  while (Date.now() < T0 + (LIVE_AFTER - 45) * 1000) await sleep(200);
  ob.kill('SIGKILL'); const killedAt = Date.now(); await sleep(4000);
  ob = runObs();
  while (Date.now() < T0 + (LIVE_AFTER + 12) * 1000) await sleep(250);
  ob.kill('SIGTERM'); await sleep(1500);
  fx.kill('SIGTERM'); await sleep(1500);
  const truth = JSON.parse(fs.readFileSync(GT, 'utf8'));

  /* Test 1 (part): the production code under test is byte-identical to main */
  const mainSha = require('crypto').createHash('sha256').update(spawnSync('git', ['-C', path.join(ROOT, '..'), 'show', 'origin/main:pinradar_server.js'], { maxBuffer: 64 << 20 }).stdout).digest('hex');
  ok('fixture ran production main:pinradar_server.js byte for byte', truth.prodSha === mainSha, truth.prodSha.slice(0, 16));

  /* store integrity after a kill -9 */
  const AN = path.join(W, 'anchors.ndjson');
  spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'anchor', '--data', DD, '--out', AN]);
  const vr = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'verify', '--data', DD, '--key', KEY, '--sign-pub', SIGNPUB, '--anchors', AN], { encoding: 'utf8' });
  const v = JSON.parse(vr.stdout);
  ok('Test 7: every stream verifies (chain + decryption + host-signed checkpoints + anchors) after a kill -9 and restart',
    vr.status === 0 && Object.values(v.streams).every(x => x.ok) && v.checkpoints.checkpoints > 0 && !v.checkpoints.bad.length && !v.anchorFailures.length, { streams: v.streams, checkpoints: v.checkpoints && { n: v.checkpoints.checkpoints, bad: v.checkpoints.bad, unsigned: v.checkpoints.unsignedTail } });
  const exp = path.join(W, 'export'); spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'export', '--data', DD, '--key', KEY, '--out', exp]);
  const health = fs.readFileSync(path.join(exp, 'health.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const gap = health.find(h => h.kind === 'obs.gap' && /not running/.test(h.reason));
  ok('Test 9: the observer outage is recorded as a gap (never silently bridged)', gap && gap.from <= killedAt && gap.to >= killedAt, gap);
  ok('Test 8: no plaintext Pin Radar data on disk (raw segments are ciphertext only)', !fs.readdirSync(path.join(DD, 'raw')).filter(f => f.endsWith('.jsonl')).some(f => /LOCKED|pFlip|KXBTC15M/.test(fs.readFileSync(path.join(DD, 'raw', f), 'utf8'))));

  /* derive and compare */
  const dj = path.join(W, 'derived.json');
  const dr = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'derive', '--data', DD, '--key', KEY, '--sign-pub', SIGNPUB, '--out', dj], { encoding: 'utf8' });
  if (dr.status !== 0) { console.log('derive failed: ' + dr.stderr); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(dj, 'utf8'));
  const byT = Object.fromEntries(d.markets.map(x => [x.ticker, x]));
  const isL = s => s === 'LOCKED' || s === 'PROVEN LOCKED';
  let sigOk = 0, sigN = 0, tOk = 0, setOk = 0, covOk = 0; const bad = [];
  for (const mk of truth.markets) {
    const g = (truth.truth[mk.ticker] || []).slice().sort((a, b) => a.ts - b.ts), x = byT[mk.ticker];
    if (!x) { bad.push(mk.ticker + ' missing'); continue; }
    /* independent recomputation from the per-second ground truth (not from the prediction log) */
    const gl = g.find(r => isL(r.state)), gq = g.find(r => isL(r.state) && r.pFlip <= 0.002);
    const g120 = g.filter(r => r.ts <= mk.closeMs - 120e3).pop();
    const gTrans = g.filter((r, i) => i === 0 || r.state !== g[i - 1].state || r.side !== g[i - 1].side).length;
    sigN++;
    const same = (a, b) => (!a && !b) || (a && b && a.ts === b.ts && a.side === b.side && a.pFlip === b.pFlip);
    if (same(gl, x.signal) && same(gq, x.qualified) && (!g120 || x.atT120.state === g120.state) && x.events.filter(e => e.type === 'state').length === gTrans) sigOk++;
    else bad.push(mk.ticker + ' signal ' + JSON.stringify({ gl: gl && [gl.ts, gl.side], xl: x.signal && [x.signal.ts, x.signal.side], gq: gq && gq.ts, xq: x.qualified && x.qualified.ts, g120: g120 && g120.state, x120: x.atT120.state, gTrans, xTrans: x.events.filter(e => e.type === 'state').length }));
    /* Test 3: remaining seconds agree with the market's close time */
    if (x.signal ? Math.abs(x.signal.tau - (mk.closeMs - x.signal.ts) / 1000) < 0.06 : true) tOk++;
    /* Test 5: settlement equals the real Kalshi result */
    if (x.settlement && x.settlement.outcome === (mk.result === 'yes' ? 'UP' : 'DOWN') && Math.abs(x.settlement.expirationValue - mk.official) < 1e-6) setOk++;
    if (x.coverage && x.coverage.status === 'complete') covOk++; else bad.push(mk.ticker + ' coverage ' + JSON.stringify(x.coverage));
  }
  ok('Test 2: first LOCKED, first 0.2 % signal, T-120 state and every state change equal the engine\'s own per-second output', sigOk === sigN && sigN === truth.markets.length, sigOk + '/' + sigN + ' ' + bad.slice(0, 2).join(' | '));
  ok('Test 3: seconds remaining agree with the close time for every first-LOCKED signal', tOk === truth.markets.length, tOk);
  ok('Test 5: every outcome and official value equals Kalshi\'s record', setOk === truth.markets.length, setOk);
  ok('Test 9: windows are complete except where the observer was down (none here: production kept the rows in memory)', covOk === truth.markets.length, covOk + '/' + truth.markets.length + ' ' + bad.filter(b => /coverage/.test(b)).slice(0, 1));

  /* Test 4: the live window's price comes only from a book served BEFORE the signal, and equals it */
  const live = truth.markets[truth.markets.length - 1], lx = byT[live.ticker];
  const sg = lx.qualified || lx.signal;
  if (sg && lx.pricing) {
    const pr = (lx.qualified ? lx.pricing.qualified : lx.pricing.firstLocked);
    const at = pr.atSignal;
    if (sg.ts < T0 + 2000 || (at && at.unavailable)) ok('Test 4: live-window price (signal before the observer started, or no book in time: reported unavailable, not invented)', at && (at.unavailable || Date.parse(at.receivedAt) <= sg.ts), at);
    else {
      const srv = truth.served.filter(s => s.ticker === live.ticker && s.servedAt <= Date.parse(at.receivedAt)).pop();
      const want = sg.side === 'UP' ? srv && srv.bestYesAsk : srv && srv.bestNoAsk;
      ok('Test 4: the price at the signal comes from a book received before it, and equals what Kalshi served', Date.parse(at.receivedAt) <= sg.ts && want === at.bestAskCents, { receivedAt: at.receivedAt, signal: new Date(sg.ts).toISOString(), got: at.bestAskCents, want });
    }
  } else ok('Test 4: the live window had no LOCKED signal (pricing check not applicable)', true, null);

  /* Test 10: books were captured every second in the live window's final seconds */
  const raw = fs.readFileSync(path.join(exp, 'raw.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const bk = raw.filter(r => (r.kind === 'k.book' || r.kind === 'k.book.same') && r.ticker === live.ticker);
  ok('Test 10: order books recorded about once a second in the live window (outside the outage)', bk.length >= (LIVE_AFTER - 10) * 0.7, bk.length + ' snapshots');
  ok('Test 10: report builds with coverage, accuracy, timing, prices and theoretical sizes', (() => { const R = require('../lib/report'); const s = R.summarize(d.markets); return s.coverage.recorded === truth.markets.length && s.coverage.windowsWithNoRecord === 0 && s.qualified.n >= 0 && s.theoretical != null; })(), null);

  const rp = path.join(W, 'report.json');
  const rr = spawnSync(process.execPath, [path.join(ROOT, 'observer.js'), 'report', '--data', DD, '--key', KEY, '--sign-pub', SIGNPUB, '--period', 'daily', '--out', rp], { encoding: 'utf8' });
  const rep = rr.status === 0 ? JSON.parse(fs.readFileSync(rp, 'utf8')) : null;
  ok('Test 10: observer.js report (daily) runs on the encrypted store and counts every market', rep && rep.all.coverage.recorded === truth.markets.length && rep.periods.length >= 1 && rep.evidence.checkpoints.count > 0, rr.stderr.slice(-300) || (rep && rep.all.coverage));
  fs.rmSync(W, { recursive: true, force: true });
  let n = 0; for (const [p, s] of results) { console.log((p ? 'ok   ' : 'FAIL ') + s); if (p) n++; }
  console.log(`e2e: ${n}/${results.length} passed`);
  process.exit(n === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
