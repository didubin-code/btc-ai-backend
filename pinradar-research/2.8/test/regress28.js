/* Regression tests for the defects found by the round-3 adversarial review (each check reproduces the defect's
   trigger; it FAILS on a build that has the defect). Runs against a whole tree so the tools are tested too.
   usage: node test/regress28.js <pinradar-research dir>          (writes only to a temp dir)                    */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const SRV = path.join(ROOT, '2.8', 'dist', 'pinradar_server.js'), TOOLS = path.join(ROOT, '2.8', 'tools');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'regress28-'));
process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
const S = require(SRV);
let fail = 0; const out = [];
const ok = (id, name, cond, got) => { out.push(`${cond ? 'PASS' : 'FAIL'} ${id} ${name}${cond ? '' : ' :: ' + JSON.stringify(got).slice(0, 400)}`); if (!cond) fail++; };
const child = (env, code) => { const r = cp.spawnSync(process.execPath, ['-e', code], { env: { ...process.env, ENABLE_WS: '0', PINRADAR_REPLAY: '', LEDGER_FILE: '', TAPE_FILE: '', ...env }, encoding: 'utf8', timeout: 120000 });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch (_) { return { error: (r.stderr || r.stdout || '').slice(-600) }; } };
const report = (args) => { const o = path.join(TMP, 'rep-' + Math.random().toString(36).slice(2) + '.json');
  const r = cp.spawnSync(process.execPath, [path.join(TOOLS, 'forward_report28.js'), ...args, '--out', o], { encoding: 'utf8', timeout: 120000 });
  try { return JSON.parse(fs.readFileSync(o, 'utf8')); } catch (_) { return { crashed: true, stderr: (r.stderr || '').slice(-400) }; } };
const writeNd = (f, rows, tail = '') => fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + '\n' + tail);

/* ======================= LOCKED decision / display ======================= */
(function d4() {
  const panel = { reference: 'OFFICIAL', officialPUp: 0.30, divergenceUsd: 3 };            // official: UP flip 70 %
  const geo = { pUp: 0.99999, pUpCons: 0.9999, provenUp: true, sigmaWarm: true };
  const g = { hard: [], soft: [] }; S.brtiGate27(g, panel, geo);
  const d = S.m25Decide({ tau: 20, pUp: 0.99999, pUpCons: 0.9999, gates: g, book: { ok: true, ageMs: 100, yesAsks: [[99, 50]], noAsks: [[2, 50]] }, cfg: S.m25Cfg(10), hist: [], provenSide: 'UP' });
  ok('F3/D4', 'PROVEN LOCKED + TRADE NOW is withheld when the official reference disagrees', d.state !== 'PROVEN LOCKED' && !(d.trade && d.trade.action === 'TRADE NOW'), { state: d.state, action: d.trade && d.trade.action, gates: g });
})();
(function d5() {
  const l25 = { ...S.LOCK25, hist: S.LOCK25.hist.slice() };
  try {
    Object.assign(S.LOCK25, { ticker: 'RG-R', hist: [], lockedSide: 'UP', lockedAtTau: 40, revNoted: false });
    const panel = { reference: 'OFFICIAL', officialPUp: 0.6, criticalVsStrike: 1 };
    const sig = S.brtiAfterClassify27({ ts: Date.now(), ticker: 'RG-R', tau: 12, strike: 80000, state: 'LOCKED', side: 'UP', pWin: 0.9995, pFlip: 0.0005, pFlipCons: 0.0007,
      pWinLabel: '99.95%', pFlipLabel: '0.05%', guarantee: 'prediction', reasons: [], trade: { action: 'TRADE NOW' } }, panel, 'RG-R');
    ok('F4/D5', 'official REVERSAL WARNING shows the official 40 % flip risk, not the proxy 0.05 %', sig.state === 'REVERSAL WARNING' && Math.abs(sig.pFlip - 0.4) < 1e-9 && sig.guarantee == null, { state: sig.state, pFlip: sig.pFlip, label: sig.pFlipLabel });
    S.enrich28(sig, { geo: { recal: { group: 'normal' } }, settle: panel, kal: null, now: Date.now(), tau: 12 });
    ok('F15', 'the 2.8 OUTCOME box during an official reversal is built from the official numbers', Math.abs(sig.v28.outcome.flipProbability - 0.4) < 1e-9 && !/>99\.9/.test(sig.v28.outcome.winLabel || ''), sig.v28.outcome);
  } finally { Object.assign(S.LOCK25, l25); }
})();
(function d6() {
  const bs = { enabled: S.BRTI.enabled, last: S.BRTI.last, last5: S.BRTI.last5, win: S.BRTI.win };
  try {
    const C = Math.ceil(Date.now() / 900000) * 900000, now = C + 1000, sk = Number.isFinite(S.SKEW.estMs) ? S.SKEW.estMs : 0;
    Object.assign(S.BRTI, { enabled: true, last5: null, last: { value: 80000, sourceTs: now - 100 - sk, localTs: now - 50, receivedAt: now - 50 }, win: { closeMs: C, size: 58, value: 80000.004, localTs: now - 50 } });
    const p = S.settlePanel27({ now, closeMs: C, strike: 80000, geo: null, tau: -1 });
    const des = S.designation28({ tau: -1, panel: p, strike: 80000 });
    ok('F11/D6', 'after the close, 58 of 60 official values are not "MATHEMATICALLY FINAL 60/60"', des.code !== 'MATHEMATICALLY_FINAL' && p && !p.decided, { decided: p && p.decided, recorded: p && p.recorded, des: des.label });
  } finally { Object.assign(S.BRTI, bs); }
})();

/* ======================= ledger integrity in the server ======================= */
(async function main() {
  { /* F9: a successful fee refresh must leave the in-memory chain valid */
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ series: { ticker: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: 1 } }) });
    const cfg0 = S.FEE28.cfg;
    try {
      await S.fee28Refresh();
      const v = S.verifyLedger28(S.L28.rows, S.L28.rows[0].seq === 1 ? S.L28.genesis : null);
      ok('F9', 'after a successful fee refresh the live ledger chain still verifies', v.ok && !!S.FEE28.verified, { v, verified: S.FEE28.verified });
    } finally { globalThis.fetch = realFetch; S.FEE28.cfg = cfg0; S.fee28Recompute(); }
  }
  { /* F13: one failed (partial) write must not lose the entry or break the file */
    const f = path.join(TMP, 'wf.ndjson'); let failOnce = 3, n = 0;
    const fsw = { ...fs, appendFileSync: (file, data) => { n++; if (n === failOnce) { fs.appendFileSync(file, String(data).slice(0, 25)); throw new Error('ENOSPC: no space left on device'); } return fs.appendFileSync(file, data); } };
    const L = S.mkLedger28({ genesisSeed: 'wf', file: f, fs: fsw });
    for (let i = 0; i < 8; i++) S.ledgerAppend28(L, 't', { i }, i);
    let rows = null; try { rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (_) { rows = null; }
    const v = rows ? S.verifyLedger28(rows, L.genesis) : { ok: false, why: 'file unparsable' };
    ok('F13', 'a transient partial write is retried in order: the file stays a complete, verifiable chain', !!rows && rows.length === 8 && v.ok, { n: rows && rows.length, v });
  }
  { /* LI-2: a series record with fee_multiplier null / "" / false must not zero the fee (Number(null) === 0) */
    const realFetch = globalThis.fetch, cfg0 = S.FEE28.cfg, res = [];
    try {
      for (const raw of [null, '', false, ' ', 1e6]) {
        S.FEE28.cfg = { ...cfg0 }; S.fee28Recompute();
        globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ series: { ticker: 'KXBTC15M', fee_type: 'quadratic', fee_multiplier: raw } }) });
        await S.fee28Refresh();
        res.push({ raw, mult: S.FEE28.cfg.seriesMultiplier ?? 1, isDefault: S.FEE28.isDefault, verified: S.FEE28.verified, fee: S.kalshiFeeCents(98, 10) });
      }
    } finally { globalThis.fetch = realFetch; S.FEE28.cfg = cfg0; S.fee28Recompute(); }
    ok('LI-2', 'fee_multiplier null/""/false/" "/1e6 never changes the decision fee (0.2c at 98c x10) and is not "verified"', res.every(r => Math.abs(r.fee - 0.2) < 1e-9 && r.isDefault && !r.verified), res);
  }
  { /* LI-7/LI-9: no green +EV next to a refused or breaking call */
    const l25 = { ...S.LOCK25, hist: S.LOCK25.hist.slice() };
    try {
      Object.assign(S.LOCK25, { ticker: 'RG-V', hist: [], lockedSide: 'UP', lockedAtTau: 40, revNoted: false });
      const kal = { ok: true, ticker: 'RG-V' }; const obS = S.KAL.ob, obT = S.KAL.obTs; S.KAL.ob = { ticker: 'RG-V', yes: [[3, 50]], no: [[3, 50]] }; S.KAL.obTs = Date.now();
      const tr = { action: 'TRADE NOW', askCents: 97, avgCents: 97, feeCents: 0.2, evCents: 2.7, evConsCents: 2.61, depth: 50, contracts: 10 };
      const rv = S.brtiAfterClassify27({ ts: Date.now(), ticker: 'RG-V', tau: 12, strike: 80000, state: 'LOCKED', side: 'UP', pWin: 0.9995, pFlip: 0.0005, pFlipCons: 0.0007, reasons: [], trade: { ...tr } },
        { reference: 'OFFICIAL', officialPUp: 0.017, criticalVsStrike: 1 }, 'RG-V');
      S.enrich28(rv, { geo: { recal: { group: 'normal' } }, settle: null, kal, now: Date.now(), tau: 12 });
      const md = { ts: Date.now(), ticker: 'RG-V', tau: 30, strike: 80000, state: 'LOCKED', side: 'UP', pWin: 0.9995, pFlip: 0.0005, pFlipCons: 0.0007, reasons: [], trade: { ...tr, askCents: 85, avgCents: 85, evConsCents: 14, action: 'LOCKED — MARKET DISAGREES' } };
      S.enrich28(md, { geo: { recal: { group: 'normal' } }, settle: null, kal, now: Date.now(), tau: 30 });
      S.KAL.ob = obS; S.KAL.obTs = obT;
      ok('LI-7', 'during an official REVERSAL WARNING the TRADE VALUE box shows no proxy +EV and no ladder', rv.v28.value.positive === false && rv.v28.value.evConsCents == null && rv.v28.ladder.length === 0, rv.v28.value);
      ok('LI-9', 'a LOCKED — MARKET DISAGREES call is never shown as positive trade value', md.v28.value.positive === false && /MARKET DISAGREES/.test(md.v28.value.veto || ''), md.v28.value);
    } finally { Object.assign(S.LOCK25, l25); }
  }
  { /* LI-8: client-reported latencies: negative dropped, capped, rate-limited */
    const before = (S.LAT28.series.clientSignalAgeAtDisplayMs || []).length; let acc = 0;
    if (S.clientLat28) for (let i = 0; i < 3000; i++) if (S.clientLat28({ clientRttMs: -1e9, clientDisplayDelayMs: 5 }, 1e12 + i)) acc++;
    const after = S.LAT28.series.clientSignalAgeAtDisplayMs || [], rt = S.LAT28.series.clientRoundTripMs || [];
    ok('LI-8', '3,000 forged client latency posts in 3 s add <= 16 samples and never a negative value', !!S.clientLat28 && acc <= 16 && after.length - before <= 16 && !rt.some(x => x < 0), { accepted: acc, added: after.length - before });
  }
  /* server restarts on a persistent LEDGER_FILE (child processes = real restarts) */
  const H = (env, body) => child(env, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});${body}`);
  { /* F14: torn final line */
    const f = path.join(TMP, 'torn.ndjson');
    const a = H({ LEDGER_FILE: f }, `S.ledgerAppend28(S.L28,'t',{x:1});console.log(JSON.stringify({seq:S.L28.seq}))`);
    fs.appendFileSync(f, '{"seq":3,"ts":1,"type":"t","bo');                                        // crash mid-write
    const b = H({ LEDGER_FILE: f }, `console.log(JSON.stringify({seq:S.L28.seq,resumed:S.L28.resumed,fileErr:S.L28.fileErr}))`);
    let rows = null; try { rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (_) { rows = null; }
    const v = rows ? S.verifyLedger28(rows, rows[0].prev) : { ok: false };
    ok('F14', 'a torn last line is cut off at restart; the chain continues (seq 3) and the whole file verifies', a.seq === 2 && b.seq === 3 && !!rows && v.ok, { a, b, v, parsed: !!rows });
    const rep = report(['--ledger', f]);
    ok('F14b', 'forward_report28 does not crash on a torn final line', !rep.crashed, rep.stderr);
  }
  { /* F13b: a corrupt middle row: keep the verified prefix and continue (not discard everything) */
    const f = path.join(TMP, 'mid.ndjson');
    H({ LEDGER_FILE: f }, `for(let i=0;i<20;i++)S.ledgerAppend28(S.L28,'t',{i});console.log('{}')`);
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n'); const e = JSON.parse(lines[10]); e.body.i = 999; lines[10] = JSON.stringify(e); fs.writeFileSync(f, lines.join('\n') + '\n');
    const b = H({ LEDGER_FILE: f }, `console.log(JSON.stringify({seq:S.L28.seq,resumed:S.L28.resumed}))`);
    const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    ok('F13b', 'a corrupt row 11: rows 1-10 are kept and the chain continues from them (original kept aside)', b.seq === 11 && rows.length === 11 && S.verifyLedger28(rows, rows[0].prev).ok, { b, n: rows.length });
  }
  { /* F2 + F5: a restart inside a window keeps its committed calls; a window closed before the restart is still settled */
    const f = path.join(TMP, 'restart.ndjson'), now = Date.now(), Cl = Math.ceil(now / 900000) * 900000 + 900000, Cp = Cl - 1800000;
    H({ LEDGER_FILE: f }, `const L=S.L28;
      S.ledgerAppend28(L,'window',{ticker:'RG-OLD',closeMs:${Cp},strike:80000});
      S.ledgerAppend28(L,'call',{ticker:'RG-OLD',closeMs:${Cp},strike:80000,policy:'A-2.6',event:'firstLock',rec:{side:'DOWN',tau:40,pFlip:0.004,pFlipCons:0.004,ts:${Cp - 40000}}});
      S.ledgerAppend28(L,'window',{ticker:'RG-LIVE',closeMs:${Cl},strike:80000});
      S.ledgerAppend28(L,'call',{ticker:'RG-LIVE',closeMs:${Cl},strike:80000,policy:'A-2.6',event:'firstLock',rec:{side:'UP',tau:120,pFlip:0.003,pFlipCons:0.004,ts:${now}}});
      console.log('{}')`);
    const b = H({ LEDGER_FILE: f }, `
      const w = S.SHADOW28.windows.get('RG-LIVE'), lockSide = S.LOCK25.ticker === 'RG-LIVE' ? S.LOCK25.lockedSide : null;
      const sc = S.shadowFinalize28('RG-LIVE', 'no', 79999.5);
      const o = S.L28.rows.filter(e => e.type === 'outcome').pop();
      (async () => {
        const rf = globalThis.fetch; globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ market: { result: 'yes', expiration_value: 80001.2 } }) });
        if (S.settleRestored28) await S.settleRestored28(Date.now());
        globalThis.fetch = rf;
        const o2 = S.L28.rows.filter(e => e.type === 'outcome' && e.body.ticker === 'RG-OLD').pop();
        console.log(JSON.stringify({ restored: !!w, lockSide, outcomeLock: o && o.body.records['A-2.6'] && o.body.records['A-2.6'].firstLock, lost: sc && sc['A-2.6'] && sc['A-2.6'].lost,
          old: o2 ? { lost: o2.body.scores['A-2.6'].lost } : null, failN: S.SHADOW28.stats['A-2.6'].fail.n }));
      })();`);
    ok('F2', 'after a restart the window\'s committed first LOCKED call (UP) is the one scored at settlement (lost)', b.restored && b.outcomeLock && b.outcomeLock.side === 'UP' && b.lost === true, b);
    ok('F2b', 'after a restart the live window keeps its LOCKED side (reversal warnings still work)', b.lockSide === 'UP', b);
    ok('F5', 'a window closed before the restart with a committed call is settled (not silently dropped)', b.old && b.old.lost === true && b.failN === 2, b);
  }
  { /* F18: resume streams the file (memory bounded by LEDGER_MAX, not by the file) */
    const f = path.join(TMP, 'big.ndjson');
    const L = S.mkLedger28({ genesisSeed: 'pinradar-2.8|' + S.CONFIG28_HASH, file: f, fs });
    const pad = 'x'.repeat(380);
    const fd = fs.openSync(f, 'w'); let buf = [];
    for (let i = 0; i < 120000; i++) { const e = S.ledgerAppend28({ ...L, file: '' }, 'digest', { n: i, sha: pad }, i); L.seq = e.seq; L.head = e.hash; L.rows.length = 0; buf.push(JSON.stringify(e)); if (buf.length === 5000) { fs.writeSync(fd, buf.join('\n') + '\n'); buf = []; } }
    if (buf.length) fs.writeSync(fd, buf.join('\n') + '\n'); fs.closeSync(fd);
    const mb = +(fs.statSync(f).size / 1048576).toFixed(1);
    const b = H({ LEDGER_FILE: f, LEDGER_MAX: '5000' }, `const m=process.memoryUsage();console.log(JSON.stringify({seq:S.L28.seq,rows:S.L28.rows.length,rssMB:+(m.rss/1048576).toFixed(0),heapMB:+(m.heapUsed/1048576).toFixed(0)}))`);
    ok('F18', `resume of a ${mb} MB ledger keeps every row verified and memory bounded (rss < file size + 150 MB)`, b.seq === 120001 && b.rows <= 5000 && b.rssMB < mb + 150, { ...b, fileMB: mb });
  }

  /* ======================= forward_report28 (the evaluation tool) ======================= */
  const mkChain = (spec) => {      // spec: [{ticker, a: {lockSide, tradeSide, ask}, winner}]
    const H8 = 'cafe' + '0'.repeat(60), L = S.mkLedger28({ genesisSeed: 'pinradar-2.8|' + H8, maxMem: 1e7 });   // keep every row (the default cap is 50,000)
    const t0 = 1.8e12; let t = t0;
    S.ledgerAppend28(L, 'boot', { boot: 'rg', configHash: H8 }, t);
    for (const w of spec) {
      if (w.gapBefore) t += w.gapBefore * 900000;                                       // windows with no trace at all (downtime)
      const closeMs = (t = t + 900000);
      S.ledgerAppend28(L, 'window', { ticker: w.ticker, closeMs, strike: 80000 }, closeMs - 300000);
      const recs = {};
      for (const pid of S.SHADOW_POLICIES28.map(p => p.id)) {
        const r = { firstLock: null, firstTrade: null, firstReversal: null, lockedSide: null, maxTau: null };
        const a = (w.by && w.by[pid]) || w.a;
        if (a && a.lockSide) { r.firstLock = { side: a.lockSide, tau: 100, pFlip: 0.003, pFlipCons: 0.004, ts: closeMs - 100000 }; S.ledgerAppend28(L, 'call', { ticker: w.ticker, closeMs, strike: 80000, policy: pid, event: 'firstLock', rec: r.firstLock }, closeMs - 100000); }
        if (a && a.tradeSide) { r.firstTrade = { side: a.tradeSide, tau: 90, askCents: a.ask, avgCents: a.ask, feeCents: 0.1, contracts: 10, depth: 50, evConsCents: 0.6, bookAgeMs: 100, ts: closeMs - 90000 }; S.ledgerAppend28(L, 'call', { ticker: w.ticker, closeMs, strike: 80000, policy: pid, event: 'firstTrade', rec: r.firstTrade }, closeMs - 90000); }
        recs[pid] = r.firstLock || r.firstTrade ? r : null;
      }
      if (w.calib) for (const tt of [60, 30, 10]) S.ledgerAppend28(L, 'calib', { ticker: w.ticker, closeMs, kind: 'tau', target: tt, tau: tt - 0.3, pUp: w.winner === 'UP' ? 0.999 : 0.001, state: 'LOCKED' }, closeMs - tt * 1000);
      if (w.noOutcome) continue;
      const records = w.outcomeRecords ? w.outcomeRecords(recs) : recs;
      S.ledgerAppend28(L, 'outcome', { ticker: w.ticker, closeMs, strike: 80000, result: w.winner === 'UP' ? 'yes' : 'no', official: 80000, winner: w.winner, records, scores: {} }, closeMs + 5000);
    }
    if (spec.latency) { const hb = ms => [[S.latBucket28 ? S.latBucket28(ms) : 0, 1000]];
      S.ledgerAppend28(L, 'latency', { since: t0, until: t, hist: { decisionIndexInputAgeMs: hb(400), bgSnapshotMs: hb(2), radarComputeMs: hb(3), clientSignalAgeAtDisplayMs: hb(300) } }, t + 1000); }
    S.ledgerAppend28(L, 'heartbeat', {}, t + 3600000);
    return L.rows;
  };
  const win = (i, extra = {}) => ({ ticker: 'W' + i, a: { lockSide: 'UP', tradeSide: 'UP', ask: 99 }, winner: 'UP', ...extra });
  { /* F1: an edited outcome (loss -> win) with only its own hash recomputed */
    const spec = Array.from({ length: 30 }, (_, i) => win(i)); spec[7] = win(7, { winner: 'DOWN' });
    const rows = mkChain(spec); const f = path.join(TMP, 'forge.ndjson');
    const i = rows.findIndex(e => e.type === 'outcome' && e.body.ticker === 'W7'); const e = JSON.parse(JSON.stringify(rows[i]));
    e.body.winner = 'UP'; e.body.result = 'yes'; e.hash = S.entryHash28(e.prev, e); rows[i] = e;
    writeNd(f, rows);
    const r = report(['--ledger', f]);
    ok('F1', 'forward_report28: an edited entry (hash recomputed, chain broken after it) fails G2', !r.crashed && r.gates.G2.pass === false, r.gates && r.gates.G2 && { pass: r.gates.G2.pass, segs: r.gates.G2.segments.length });
    const rows2 = mkChain(spec); rows2.splice(rows2.findIndex(e => e.type === 'outcome' && e.body.ticker === 'W7'), 1); const f2 = path.join(TMP, 'gap.ndjson'); writeNd(f2, rows2);
    const r2 = report(['--ledger', f2]);
    ok('F1b', 'forward_report28: deleting a losing outcome (sequence gap) fails G2', !r2.crashed && r2.gates.G2.pass === false, r2.gates && { pass: r2.gates.G2.pass, segs: r2.gates.G2.segments.length, lost: r2.policies['A-2.6'].lost });
  }
  { /* F2 (tool side): the outcome's own copy lost the committed first LOCKED call -> scored from the commitment */
    const spec = Array.from({ length: 20 }, (_, i) => win(i));
    spec[3] = win(3, { winner: 'DOWN', a: { lockSide: 'UP' }, outcomeRecords: recs => ({ ...recs, 'A-2.6': null }) });
    const f = path.join(TMP, 'rec.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('F2c', 'forward_report28 scores the committed first call, not the outcome\'s copy (the lost call counts)', !r.crashed && r.policies['A-2.6'].lost === 1, r.policies && r.policies['A-2.6']);
  }
  { /* F5 (tool side): committed calls, never an outcome or 'unresolved' -> counted as unresolved */
    const spec = Array.from({ length: 20 }, (_, i) => win(i)); spec[4] = win(4, { noOutcome: true });
    const f = path.join(TMP, 'drop.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('F5b', 'forward_report28 counts a window with committed calls and no outcome as unresolved (5 % > 2 % -> G2 fails)', !r.crashed && r.gates.G2.issues.unresolved === 1 && r.gates.G2.pass === false, r.gates && r.gates.G2.issues);
  }
  { /* F10: the failure alarm fires early and decays: G3c must still trigger */
    const spec = Array.from({ length: 1200 }, (_, i) => win(i, i < 15 && i % 5 === 0 ? { winner: 'DOWN' } : {}));   // 3 losses: below the 3-in-200 operational rule
    const f = path.join(TMP, 'alarm.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('F10', 'forward_report28 G3c: an alarm that fired (e >= 20) and later decayed still ends the test (FAIL)', !r.crashed && r.gates.G3.stopRule.maxLossesIn200 === 3 && r.gates.G3.stopRule.eValue < 20 && r.gates.G3.stopRule.triggered === true && /^FAIL/.test(r.verdict), r.gates && r.gates.G3.stopRule);
  }
  { /* CVE-03: 3,000 clean LOCKED windows over 31 days but no calibration, latency or G1 evidence -> never PASS; with them -> PASS */
    const spec = Array.from({ length: 3050 }, (_, i) => win(i));
    const f = path.join(TMP, 'noev.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('CVE-03', 'forward_report28: missing G1/G5/G6 evidence gives INCOMPLETE, not PASS', !r.crashed && !/^PASS/.test(r.verdict), r.verdict || r.stderr);
    const spec2 = Array.from({ length: 3050 }, (_, i) => win(i, { calib: true })); spec2.latency = true;
    const rows2 = mkChain(spec2), f2 = path.join(TMP, 'fullev.ndjson'); writeNd(f2, rows2);
    const r2 = report(['--ledger', f2, '--g1', 'PASS', '--config', 'cafe' + '0'.repeat(60), '--anchor', rows2[rows2.length - 1].hash]);
    ok('CVE-03b', 'forward_report28: with ledger calibration + latency histograms + G1 attestation the same record PASSes', !r2.crashed && /^PASS/.test(r2.verdict), { v: r2.verdict, g2: r2.gates && r2.gates.G2.issues, g5: r2.gates && r2.gates.G5.coverageByTauPct, g6: r2.gates && r2.gates.G6 });
  }
  { /* CVE-06: 3 losses in the first 700 LOCKED windows is not evidence of harm (rate 0.43 %): no FAIL at the interim */
    const spec = Array.from({ length: 760 }, (_, i) => win(i, i % 250 === 100 ? { winner: 'DOWN' } : {}));
    const f = path.join(TMP, 'interim.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('CVE-06', 'forward_report28: 3/760 losses at the interim look ends nothing (IN PROGRESS), only the stop rule can FAIL early', !r.crashed && /^IN PROGRESS/.test(r.verdict) && r.gates.G3.stopRule.triggered === false, { v: r.verdict, stop: r.gates && r.gates.G3.stopRule });
  }
  { /* NEW-band28-reversal + CVE-13 + CVE-09 */
    const b = S.band28(0.9, 'normal');
    ok('BAND', 'band28 is not defined for a flip risk above 50 % (a breaking call)', b === null, b);
    const sm = S.settleMath({ strike: 80000.01, recordedAvg: 80000.005, recordedN: 30, remaining: 30, spot: 80000.005 });
    ok('CVE-13', 'settleMath: an exact half-cent tie projects UP (settles UP)', sm && sm.leader === 'UP', sm && { leader: sm.leader, exp: sm.expectedSettle });
    const ev = S.evidence26({ state: 'LOCKED', side: 'UP', trade: { askCents: 97 } }, { recal: { group: 'normal' } });
    ok('CVE-09', 'the evidence shown with LOCKED is the settlement-aware 13 of 3,484, labelled development (not "out of sample")', /13 of 3484/.test(ev[0] || '') && !/Out of sample/.test(ev[0] || ''), ev[0]);
  }
  { /* fix-review R1: a no-disk restart inside a window (calls in segment 1, outcome in segment 2) is scored from the calls */
    const a = mkChain([win(1), win(2, { winner: 'DOWN', noOutcome: true })]);
    const H8 = 'cafe' + '0'.repeat(60), L2 = S.mkLedger28({ genesisSeed: 'pinradar-2.8|' + H8, maxMem: 1e7 });
    const c2 = a.find(e => e.type === 'window' && e.body.ticker === 'W2').body.closeMs;
    S.ledgerAppend28(L2, 'boot', { boot: 'rg2', configHash: H8 }, c2 - 30000);
    S.ledgerAppend28(L2, 'outcome', { ticker: 'W2', closeMs: c2, strike: 80000, result: 'no', official: 79999, winner: 'DOWN', records: {}, scores: {} }, c2 + 5000);
    const f = path.join(TMP, 'r1.ndjson'); writeNd(f, a.slice(0, -1).concat(L2.rows));   // drop seg-1 heartbeat so seg 2 follows in time
    const r = report(['--ledger', f]);
    ok('R1', 'calls before a no-disk restart precede the outcome after it (file order, not seq): scored, no G2 failure', !r.crashed && r.gates.G2.issues.callAfterOutcome === 0 && r.policies['A-2.6'].lost === 1 && r.gates.G2.pass, r.gates && { iss: r.gates.G2.issues, A: r.policies['A-2.6'].lost });
    /* R5: a deleted whole segment is caught by the published anchors; without anchors the verdict can never be PASS */
    const f5 = path.join(TMP, 'r5.ndjson'); writeNd(f5, a.slice(0, -1));
    const r5 = report(['--ledger', f5, '--anchor', a[a.length - 2].hash + ',' + L2.rows[L2.rows.length - 1].hash]);
    ok('R5', 'a deleted chain segment fails G2 when its published head is missing', !r5.crashed && r5.gates.G2.pass === false && r5.gates.G2.issues.anchorsMissing === 1, r5.gates && r5.gates.G2.issues);
  }
  { /* R2: the TAPE_FILE restart marker is written at boot (no temporal-dead-zone error) */
    const f = path.join(TMP, 'tb.ndjson');
    const b = child({ TAPE_FILE: f }, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});console.log(JSON.stringify({ err: S.TAPE28.fileErr }))`);
    const first = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0]) : null;
    ok('R2', 'TAPE_FILE starts with a boot marker and no tape error', !!first && first.k === 'boot' && !b.err, { first, b });
  }
  { /* R3: no green value for a refused or not-LOCKED call (here: LOCKED-grade proxy withheld by the official gate) */
    const sig = { ts: Date.now(), ticker: 'RG-W', tau: 30, strike: 80000, state: 'HIGH CONFIDENCE', side: 'UP', pWin: 0.99999, pFlip: 0.00001, pFlipCons: 0.0001, reasons: [],
      trade: { action: 'WAIT', askCents: 97, avgCents: 97, feeCents: 0.2, evCents: 2.8, evConsCents: 2.7, depth: 50, contracts: 10 } };
    S.enrich28(sig, { geo: { recal: { group: 'normal' } }, settle: null, kal: null, now: Date.now(), tau: 30 });
    ok('R3', 'TRADE VALUE is never positive for a call that is not LOCKED (veto names the state)', sig.v28.value.positive === false && /not LOCKED/.test(sig.v28.value.veto || ''), sig.v28.value);
    const d = S.m25Decide({ tau: 20, pUp: 0.99999, pUpCons: 0.9999, gates: { hard: [], soft: ['official BRTI disagrees: x'], official: ['official flip risk'] }, book: { ok: true, ageMs: 100, yesAsks: [[97, 50]], noAsks: [[4, 50]] }, cfg: S.m25Cfg(10), hist: [] });
    ok('R3b', 'a WAIT caused by a gate says so (not "confidence below the LOCKED threshold")', /LOCKED withheld/.test(d.trade && d.trade.why || ''), d.trade && d.trade.why);
  }
  { /* R4: with a ledger file, /ledger serves only rows already on disk (a restart cannot fork a pulled copy) */
    const f = path.join(TMP, 'r4.ndjson');
    const b = child({ LEDGER_FILE: f }, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});const http=require('http');
      for (let i = 0; i < 5; i++) S.ledgerAppend28(S.L28, 't', { i });
      const good = S.L28.seq; S.L28.fs = { ...require('fs'), appendFileSync() { throw new Error('ENOSPC: no space left on device'); }, statSync: require('fs').statSync, truncateSync: require('fs').truncateSync };
      for (let i = 0; i < 5; i++) S.ledgerAppend28(S.L28, 't', { j: i });
      S.server.listen(0, '127.0.0.1', () => { http.get({ host: '127.0.0.1', port: S.server.address().port, path: '/ledger?since=0&n=100' }, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => { const j = JSON.parse(d);
        console.log(JSON.stringify({ good, seq: S.L28.seq, maxServed: Math.max(...j.rows.map(e => e.seq)), durable: j.durableSeq })); process.exit(0); }); }); });`);
    ok('R4', 'rows not yet written to disk are never served by /ledger', b.maxServed === b.good && b.seq === b.good + 5, b);
  }
  { /* R7: a final row complete except for its newline is kept, its seq is not reused */
    const f = path.join(TMP, 'r7.ndjson');
    child({ LEDGER_FILE: f }, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});S.ledgerAppend28(S.L28,'outcome',{x:1});console.log('{}')`);
    fs.truncateSync(f, fs.statSync(f).size - 1);                                     // cut only the last newline
    const b = child({ LEDGER_FILE: f }, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});console.log(JSON.stringify({ seq: S.L28.seq, r: S.L28.resumed }))`);
    ok('R7', 'a complete last row without its newline is kept (new boot is seq 3, not 2)', b.seq === 3 && b.r && b.r.completedLastLine === 2, b);
  }
  { /* R8: invalid client posts do not use the rate-limit tokens */
    let accepted = 0;
    if (S.clientLat28) { for (let i = 0; i < 50; i++) S.clientLat28({ clientRttMs: -5, clientDisplayDelayMs: -5 }, 2e12); accepted = S.clientLat28({ clientRttMs: 120, clientDisplayDelayMs: 300 }, 2e12) ? 1 : 0; }
    ok('R8', 'a flood of invalid latency posts does not lock out a valid one', accepted === 1, accepted);
  }
  { /* R9 + R10 */
    const realFetch = globalThis.fetch, cfg0 = S.FEE28.cfg;
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ series: { fee_type: 'quadratic', fee_multiplier: 1e-9 } }) });
    try { S.FEE28.cfg = { ...cfg0 }; S.fee28Recompute(); await S.fee28Refresh(); ok('R9', 'fee_multiplier 1e-9 is rejected (decision fee unchanged)', Math.abs(S.kalshiFeeCents(98, 10) - 0.2) < 1e-9 && !S.FEE28.verified, S.FEE28.cfg.seriesMultiplier); }
    finally { globalThis.fetch = realFetch; S.FEE28.cfg = cfg0; S.fee28Recompute(); }
    const { privateKey } = require('crypto').generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const h = env => child(env, `const S=require(${JSON.stringify(SRV)});console.log(JSON.stringify({ h: S.CONFIG28_HASH, feed: S.CONFIG28 && S.CONFIG28.officialFeed }))`);
    const h0 = h({}), h1 = h({ KALSHI_KEY_ID: 'regress-key', KALSHI_PRIVATE_KEY: pem });
    ok('R10', 'Kalshi credentials (official gates on) change CONFIG28_HASH', h0.h && h1.h && h0.h !== h1.h && h1.feed === true, [h0, h1]);
  }
  /* ---------------- review round 2 (N1-N8) ---------------- */
  const CFG = 'cafe' + '0'.repeat(60);
  const full = (rows, extra = []) => ['--g1', 'PASS', '--config', CFG, '--anchor', rows[rows.length - 1].hash, ...extra];
  { /* N1: the test ends at 3,000 LOCKED windows / 21 days; later windows cannot turn NOT DEMONSTRATED into PASS */
    const spec = Array.from({ length: 4300 }, (_, i) => win(i, { calib: true, ...(i < 3000 && i % 200 === 50 ? { winner: 'DOWN' } : {}) })); spec.latency = true;
    const rows = mkChain(spec), f = path.join(TMP, 'n1.ndjson'); writeNd(f, rows);
    const r = report(['--ledger', f, ...full(rows)]);
    ok('N1', 'G3 is evaluated where the test ended (3,000 LOCKED, 15 lost: bound 0.77 %): NOT DEMONSTRATED, not a later PASS', !r.crashed && /^NOT DEMONSTRATED/.test(r.verdict) && r.gates.G3.locked === 3000 && r.gates.G2.issues.afterEnd === 1300, { v: r.verdict, g3: r.gates && r.gates.G3 && { locked: r.gates.G3.locked, up: r.gates.G3.cp95UpperPct }, after: r.gates && r.gates.G2.issues.afterEnd });
  }
  { /* N2: --since is exploratory; a /latency snapshot never satisfies G6 */
    const spec = Array.from({ length: 3050 }, (_, i) => win(i, { calib: true })); spec.latency = true;
    const rows = mkChain(spec), f = path.join(TMP, 'n2.ndjson'); writeNd(f, rows);
    const r = report(['--ledger', f, ...full(rows, ['--since', String(1.8e12 + 2 * 86400000)])]);
    ok('N2a', '--since gives an EXPLORATORY report, never the pre-registered verdict', !r.crashed && /^EXPLORATORY/.test(r.verdict), r.verdict);
    const spec2 = Array.from({ length: 3050 }, (_, i) => win(i, { calib: true }));
    const rows2 = mkChain(spec2), f2 = path.join(TMP, 'n2b.ndjson'); writeNd(f2, rows2);
    const lf = path.join(TMP, 'lat.json'); fs.writeFileSync(lf, JSON.stringify({ latency: { decisionIndexInputAgeMs: { p99: 10 }, bgSnapshotMs: { p99: 1 }, radarComputeMs: { p99: 1 } } }));
    const r2 = report(['--ledger', f2, ...full(rows2, ['--latency', lf])]);
    ok('N2b', 'a user-supplied /latency snapshot is information only: G6 stays insufficient (INCOMPLETE)', !r2.crashed && r2.gates.G6.sufficient === false && /^INCOMPLETE/.test(r2.verdict), r2.verdict);
  }
  { /* N3: a loss after the last published head of its segment cannot be deleted or replaced unseen: it is unverified = unresolved */
    const a = mkChain([...Array.from({ length: 30 }, (_, i) => win(i)), win(30, { winner: 'DOWN' })]);
    const anchorEarly = a.find(e => e.type === 'outcome' && e.body.ticker === 'W20').hash;
    const f = path.join(TMP, 'n3.ndjson'); writeNd(f, a);
    const r = report(['--ledger', f, '--config', CFG, '--anchor', anchorEarly]);
    ok('N3', 'outcomes after the segment\'s last anchor are not scored but counted unresolved (deleting them changes nothing)', !r.crashed && r.gates.G2.issues.unanchoredOutcomes === 10 && r.policies['A-2.6'].lost === 0 && r.gates.G2.issues.unresolved >= 10 && r.gates.G2.pass === false,
      r.gates && r.gates.G2.issues);
  }
  { /* N8: downtime: 20 % of the calendar windows missing -> G2 fails */
    const spec = Array.from({ length: 400 }, (_, i) => win(i, i % 40 === 0 && i ? { gapBefore: 10 } : {}));
    const rows = mkChain(spec), f = path.join(TMP, 'n8.ndjson'); writeNd(f, rows);
    const r = report(['--ledger', f, '--config', CFG, '--anchor', rows[rows.length - 1].hash]);
    ok('N8', 'missing calendar windows (downtime) are counted and over 5 % fail G2', !r.crashed && r.gates.G2.issues.missingWindows === 90 && r.gates.G2.pass === false, r.gates && { cal: r.gates.G2.issues.calendarWindows, miss: r.gates.G2.issues.missingWindows });
  }
  { /* N7: a candidate whose own stop rule fires is never adopted */
    const spec = Array.from({ length: 3050 }, (_, i) => win(i, { calib: true, ...(i < 200 && i % 40 === 5 ? { winner: 'DOWN', by: { 'A-2.6': {}, 'C1-strict-0.2': { lockSide: 'UP' } } } : {}) })); spec.latency = true;
    const rows = mkChain(spec), f = path.join(TMP, 'n7.ndjson'); writeNd(f, rows);
    const r = report(['--ledger', f, ...full(rows)]);
    const c1 = r.candidates && r.candidates['C1-strict-0.2'];
    ok('N7', 'candidate C1 with 5 losses in its first 200 LOCKED windows has its stop rule fired and is not adopted', !r.crashed && c1 && !!c1.G3cStop && c1.G3cStop.triggered && c1.adopt === false, c1);
  }
  { /* N6: latency histograms are committed every 5 minutes (a restart loses at most a few minutes) */
    const n0 = S.L28.rows.filter(e => e.type === 'latency').length, t0 = 5e12;
    S.latNote28(S.LAT28, 'bgSnapshotMs', 1.5, t0); S.heartbeat28(t0); S.latNote28(S.LAT28, 'bgSnapshotMs', 2.5, t0 + 1000); S.heartbeat28(t0 + 300001);
    ok('N6', 'a latency histogram is committed after 5 minutes', S.L28.rows.filter(e => e.type === 'latency').length === n0 + 1, S.L28.rows.filter(e => e.type === 'latency').length - n0);
  }
  /* N4 + N5: the puller against real server processes */
  const serve = (env, body) => new Promise(res => {
    const p = cp.spawn(process.execPath, ['-e', `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});${body};S.server.listen(0,'127.0.0.1',()=>console.log('PORT '+S.server.address().port))`],
      { env: { ...process.env, ENABLE_WS: '0', PINRADAR_REPLAY: '', LEDGER_FILE: '', TAPE_FILE: '', ...env } });
    let buf = ''; p.stdout.on('data', d => { buf += d; const m = /PORT (\d+)/.exec(buf); if (m) res({ p, port: Number(m[1]) }); });
    setTimeout(() => res({ p, port: null }), 20000);
  });
  const pull = (port, file) => new Promise(res => { const q = cp.spawn(process.execPath, [path.join(TOOLS, 'ledger_pull28.js'), `http://127.0.0.1:${port}`, file]); let o = ''; q.stdout.on('data', d => o += d); q.stderr.on('data', d => o += d); q.on('close', code => res({ code, o })); });
  {
    const pf = path.join(TMP, 'pulled.ndjson');
    let sv = await serve({}, `for(let i=0;i<30;i++)S.ledgerAppend28(S.L28,'t',{i})`); const a1 = await pull(sv.port, pf); sv.p.kill();
    sv = await serve({}, `for(let i=0;i<60;i++)S.ledgerAppend28(S.L28,'t',{j:i})`); const a2 = await pull(sv.port, pf); sv.p.kill();
    ok('N4a', 'a restart without a disk (new chain, same configuration) is appended as a new segment, not a FORK', a1.code === 0 && a2.code === 0 && /new chain segment/.test(a2.o), { a1: a1.code, a2: a2.code, o: a2.o.slice(0, 200) });
    const lf = path.join(TMP, 'disk.ndjson'), pf2 = path.join(TMP, 'pulled2.ndjson');
    sv = await serve({ LEDGER_FILE: lf }, `for(let i=0;i<40;i++)S.ledgerAppend28(S.L28,'t',{i})`); const b1 = await pull(sv.port, pf2); sv.p.kill();
    const keep = fs.readFileSync(lf, 'utf8').split('\n').slice(0, 20).join('\n') + '\n'; fs.writeFileSync(lf, keep);   // the disk copy rewinds (e.g. a corrupt row cut at resume)
    sv = await serve({ LEDGER_FILE: lf }, `0`); const b2 = await pull(sv.port, pf2); sv.p.kill();
    const pulledRows = fs.readFileSync(pf2, 'utf8').trim().split('\n').length;
    ok('N4b', 'a server that resumed a shorter copy of the same chain is a FORK: exit 3, nothing appended', b1.code === 0 && b2.code === 3 && pulledRows === 41, { b1: b1.code, b2: b2.code, rows: pulledRows, o: b2.o.slice(0, 160) });
    sv = await serve({ LEDGER_FILE: '/nonexistent-dir-regress28/ledger.ndjson' }, `for(let i=0;i<10;i++)S.ledgerAppend28(S.L28,'t',{i})`);
    const pf3 = path.join(TMP, 'pulled3.ndjson'); const c1 = await pull(sv.port, pf3); sv.p.kill();
    const n3 = fs.existsSync(pf3) ? fs.readFileSync(pf3, 'utf8').trim().split('\n').length : 0;
    ok('N5', 'an unwritable ledger file falls back to the no-disk behaviour: the chain is still served and pulled', c1.code === 0 && n3 === 11, { code: c1.code, rows: n3, o: c1.o.slice(0, 160) });
  }
  { /* F12: Holm step-down is monotone (textbook): p = .011, .012 with m = 5 -> both 0.055 */
    const h = S.holm28 ? S.holm28({ a: 0.011, b: 0.012, c: 0.5, d: 0.9, e: null }) : null;
    ok('F12', 'Holm adjusted p-values are step-down monotone (b is not rejected when a is not)', !!h && Math.abs(h.a - 0.055) < 1e-12 && Math.abs(h.b - 0.055) < 1e-12 && h.e === 1, h);
  }
  { /* F17: candidate F has an objective p-value and Holm runs over five candidates */
    const spec = Array.from({ length: 40 }, (_, i) => win(i, { by: { 'F-market-pooled-value': { lockSide: 'UP', tradeSide: i % 4 === 0 ? null : 'UP', ask: 99 } }, winner: i % 4 === 0 && i < 30 ? 'DOWN' : 'UP' }));
    const f = path.join(TMP, 'f.ndjson'); writeNd(f, mkChain(spec));
    const r = report(['--ledger', f]);
    ok('F17', 'forward_report28 tests candidate F (p-value present) and adjusts over 5 candidates', !r.crashed && r.holmAdjusted && Object.keys(r.holmAdjusted).length === 5 && r.holmAdjusted['F-market-pooled-value'] < 1, r.holmAdjusted);
  }
  { /* F16: DATA UNRELIABLE rows never enter calibration (tape fallback path) */
    const spec = Array.from({ length: 10 }, (_, i) => win(i)); const rows = mkChain(spec); const f = path.join(TMP, 'cal.ndjson'); writeNd(f, rows);
    const tape = rows.filter(e => e.type === 'outcome').map(o => ({ k: 'd', ts: o.body.closeMs - 60000, kal: { ticker: o.body.ticker, closeMs: o.body.closeMs }, out: { state: 'DATA UNRELIABLE', side: 'UP', pWin: 0.5 } }));
    const tf = path.join(TMP, 'cal.tape'); writeNd(tf, tape);
    const r = report(['--ledger', f, '--tape', tf]);
    ok('F16', 'calibration excludes DATA UNRELIABLE decisions', !r.crashed && !(r.gates.G5.fixedTau && r.gates.G5.fixedTau[60]), r.gates && r.gates.G5);
  }
  { /* F8: replay ring never reaches across a process restart */
    let rp = null; try { rp = require(path.join(TOOLS, 'replay_tape28.js')); } catch (_) { }
    const samples = Array.from({ length: 100 }, (_, i) => [1000 * i, 80000 + i]);
    const ring = rp ? rp.ringAt(samples, 80500, [50000]) : [];
    ok('F8', 'replay: samples before the latest restart are not in the replayed ring', ring.length && ring[0][0] >= 50000, ring.length ? ring[0] : null);
  }
  { /* LI-10 + LI-11 in a child: paged /ledger, incremental verify; the tape file rotates at its cap */
    const f = path.join(TMP, 'tape.ndjson');
    const b = child({ TAPE_FILE: f, TAPE_FILE_MAX_MB: '1' }, `process.env.PINRADAR_REPLAY='';const S=require(${JSON.stringify(SRV)});
      for (let i = 0; i < 12000; i++) S.ledgerAppend28(S.L28, 'digest', { n: i, sha: 'x'.repeat(200) });
      const t0 = Date.now(); const v1 = S.ledgerVerify28 ? S.ledgerVerify28(false) : null; const t1 = Date.now();
      S.ledgerAppend28(S.L28, 'digest', { n: -1 }); const v2 = S.ledgerVerify28 ? S.ledgerVerify28(false) : null; const t2 = Date.now();
      for (let i = 0; i < 9000; i++) S.tapeWrite28({ k: 'd', ts: i, pad: 'y'.repeat(200) });
      console.log(JSON.stringify({ v1: v1 && v1.ok, v2: v2 && v2.ok, mode2: v2 && v2.mode, ms1: t1 - t0, ms2: t2 - t1, rot: S.TAPE28.rotations || 0, bytes: S.TAPE28.fileBytes }))`);
    const sz = fs.existsSync(f) ? fs.statSync(f).size : 0;
    ok('LI-10', '/ledger/verify re-checks only new rows after the first full check', b.v1 === true && b.v2 === true && b.mode2 === 'incremental', b);
    ok('LI-11', 'the tape file rotates at TAPE_FILE_MAX_MB (1 MB here): current file stays under the cap, one .prev kept', b.rot >= 1 && sz <= 1048576 + 4096 && fs.existsSync(f + '.prev'), { ...b, sz });
  }
  console.log(out.join('\n'));
  console.log(`regress28 (${ROOT}): ${fail ? fail + ' FAILED' : 'all checks passed'}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
