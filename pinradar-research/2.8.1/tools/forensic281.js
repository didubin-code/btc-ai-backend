#!/usr/bin/env node
/* Forensic reconstruction of one KXBTC15M window from a running Pin Radar 2.8 / 2.8.1 server's own logs.
   Reads only files the user saved from the server (nothing is fetched, nothing is invented: a field the logs do
   not contain is reported as null with the reason).

   usage: node tools/forensic281.js --ticker KXBTC15M-26OCT141930-30
            [--tape tape.ndjson]            GET /tape?format=ndjson   (1 Hz index samples + every decision's inputs: Kalshi book, index, quality)
            [--pred predictions.json]       GET /predictions?ticker=...   (per-second state, probabilities, settlement panel, gate counts)
            [--signals signals.json]        GET /signals?n=5000       (what /radar returned to the page, with the gate texts)
            [--health health.json --health-at <ISO time the file was saved>]   GET /health (uptimeSec -> process start)
            [--ledger ledger.json]          GET /ledger?n=5000        (boot / heartbeat entries -> process start)
            [--server dist/pinradar_server.js]   replay the tape through this build (default: 2.8.1 dist) for the counterfactual
            [--out report.json]

   Output: process start, the window's milestones (first HIGH CONFIDENCE, first second the model alone supported
   LOCKED, first LOCKED shown, first TRADE NOW / TOO LATE), the fixed-time table (60/45/30/20/15/10/5 s), the Kalshi
   book near the close, data ages, what the page received and when, a cause classification, and the same inputs
   replayed through 2.8.1.                                                                                         */
'use strict';
const fs = require('fs'), path = require('path');

function args(argv) { const o = {}; for (let i = 2; i < argv.length; i++) if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } return o; }
const readJson = f => { const t = fs.readFileSync(f, 'utf8').trim(); try { return JSON.parse(t); } catch (_) { return t.split('\n').filter(Boolean).map(l => JSON.parse(l)); } };
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const isLocked = s => s === 'LOCKED' || s === 'PROVEN LOCKED';
const askOf = (ob, side) => {
  if (!ob) return null;
  /* a YES ask is a NO bid seen from the other side (2.8 bookFromKal, zero-size levels dropped) */
  const lv = (side === 'UP' ? (ob.no || []) : (ob.yes || [])).filter(([, s]) => s > 0).map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]).sort((a, b) => a[0] - b[0]);
  return lv.length ? { best: lv[0][0], size: lv[0][1], depthAt99: lv.filter(l => l[0] <= 99).reduce((a, l) => a + l[1], 0), levels: lv.slice(0, 5) } : { best: null, size: 0, depthAt99: 0, levels: [] };
};

function processStart(o) {
  const out = [];
  if (o.health) {
    const h = readJson(o.health), at = o['health-at'] ? Date.parse(o['health-at']) : (Number.isFinite(h.ts) ? h.ts : NaN);
    if (Number.isFinite(h.uptimeSec) && Number.isFinite(at)) out.push({ source: '/health uptimeSec', bootMs: at - h.uptimeSec * 1000, version: h.version, build: h.build });
  }
  if (o.ledger) {
    const L = readJson(o.ledger), rows = Array.isArray(L) ? L : (L.rows || L.entries || []);
    for (const e of rows) {
      if (e.type === 'boot' && Number.isFinite(e.ts)) out.push({ source: 'ledger boot entry', bootMs: e.ts });
      if (e.type === 'heartbeat' && e.body && Number.isFinite(e.body.uptimeSec) && Number.isFinite(e.ts)) { out.push({ source: 'ledger heartbeat', bootMs: e.ts - e.body.uptimeSec * 1000 }); break; }
    }
  }
  return out;
}

function main() {
  const o = args(process.argv);
  if (!o.ticker) { console.error('missing --ticker'); process.exit(2); }
  const T = o.ticker, rep = { ticker: T, generated: new Date().toISOString(), sources: {}, notes: [] };
  rep.processStart = processStart(o);

  /* ---- tape: inputs as the server used them ---- */
  let tape = [], samples = [];
  if (o.tape) {
    const lines = readJson(o.tape);
    samples = lines.filter(l => l.k === 's').map(l => [l.t, l.v]).sort((a, b) => a[0] - b[0]);
    tape = lines.filter(l => l.k === 'd' && l.kal && l.kal.ticker === T).sort((a, b) => a.ts - b.ts);
    rep.sources.tape = { records: tape.length, samples: samples.length, firstSample: iso(samples.length ? samples[0][0] : NaN) };
    if (samples.length) rep.notes.push(`the tape's index history starts ${iso(samples[0][0])}: a server keeps no index history from before it started`);
  }
  const closeMs = tape.length ? tape[0].kal.closeMs : null;
  /* ---- prediction log ---- */
  let pred = [];
  if (o.pred) { const P = readJson(o.pred); pred = (Array.isArray(P) ? P : P.rows || []).filter(r => r.ticker === T).sort((a, b) => a.ts - b.ts); rep.sources.predictions = { rows: pred.length }; }
  const close = closeMs || (pred.length ? pred[0].ts + pred[0].tau * 1000 : null);
  rep.closeTime = iso(close);
  /* ---- signals returned to the page ---- */
  let sigs = [];
  if (o.signals) { const G = readJson(o.signals); sigs = (Array.isArray(G) ? G : G.signals || []).filter(s => s.ticker === T).sort((a, b) => a.ts - b.ts); rep.sources.signals = { rows: sigs.length }; }

  const boot = rep.processStart.length ? rep.processStart[0].bootMs : (samples.length ? samples[0][0] : null);
  if (boot && close) rep.restart = { processStart: iso(boot), secondsBeforeClose: r2((close - boot) / 1000),
    lockedPossibleFrom: { '2.8 (300 s warm-up)': iso(boot + 300000), '2.8.1 (120 s minimum, envelope until 900 s)': iso(boot + 120000) },
    insideWindow: close - boot < 900000 };

  /* ---- milestones from the per-second prediction log (falls back to the tape's recorded outputs) ---- */
  const seq = pred.length ? pred.map(r => ({ ts: r.ts, tau: r.tau, state: r.state, side: r.side, pWin: r.pWin, pFlip: r.pFlip, action: r.action, ask: r.ask, idx: r.idx, gap: r.gap, sigma: r.sigma,
    soft: r.gatesSoft, hard: r.gatesHard, n: r.n, recAvg: r.recAvg, crit: r.crit, ref: r.ref }))
    : tape.map(r => ({ ts: r.ts, tau: (r.kal.closeMs - r.ts) / 1000, state: r.out && r.out.state, side: r.out && r.out.side, pWin: r.out && r.out.pWin, pFlip: r.out && r.out.pFlip, action: r.out && r.out.action, idx: r.liveIdx && r.liveIdx.value }));
  const first = f => { const r = seq.find(f); return r ? { time: iso(r.ts), tau: r2(r.tau), state: r.state, side: r.side, pWin: r.pWin, pFlip: r.pFlip, action: r.action, index: r2(r.idx), gapUsd: r.gap, sigmaBps: r.sigma, softGates: r.soft } : null; };
  rep.milestones = {
    firstHighConfidence: first(r => r.state === 'HIGH CONFIDENCE' || isLocked(r.state)),
    firstModelSupportedLocked: first(r => r.pFlip != null && r.pFlip <= 0.005 && !r.hard),
    firstLockedShown: first(r => isLocked(r.state)),
    firstTradeNow: first(r => r.action === 'TRADE NOW'),
    firstTooLate: first(r => r.action && /TOO LATE/.test(r.action)),
    lockedWithheldSeconds: seq.filter(r => r.state === 'HIGH CONFIDENCE' && r.pFlip != null && r.pFlip <= 0.005).length
  };
  rep.fixedTimes = [60, 45, 30, 20, 15, 10, 5].map(t => {
    const r = seq.filter(x => x.tau <= t + 0.5).sort((a, b) => b.tau - a.tau)[0] || null;
    const tr = tape.filter(x => (x.kal.closeMs - x.ts) / 1000 <= t + 0.5).sort((a, b) => a.ts - b.ts)[0] || null;   // first record at or after T-t
    const side = r && r.side ? r.side : null;
    const bk = tr && side ? askOf(tr.ob, side) : null;
    return { tau: t, at: r ? iso(r.ts) : null, state: r ? r.state : null, side, winPct: r && r.pWin != null ? r2(100 * r.pWin) : null, reversalPct: r && r.pFlip != null ? +(100 * r.pFlip).toFixed(3) : null,
      index: r ? r2(r.idx) : null, recordedPrints: r ? r.n : null, recordedAvg: r ? r.recAvg : null, criticalRemainingAvg: r ? r.crit : null, sigmaBps: r ? r.sigma : null,
      action: r ? r.action : null, leaderAskCents: bk ? bk.best : null, leaderAskSize: bk ? bk.size : null, bookAgeMs: tr && tr.obTs ? tr.ts - tr.obTs : null, indexInputAgeMs: tr ? tr.ageMs : null };
  });
  /* ---- Kalshi book near the close ---- */
  if (tape.length) {
    const side = (rep.milestones.firstLockedShown || rep.milestones.firstHighConfidence || {}).side || null;
    const withOffers = tape.filter(x => side && askOf(x.ob, side) && askOf(x.ob, side).best != null);
    const lastOffer = withOffers.length ? withOffers[withOffers.length - 1] : null;
    const at99 = side ? tape.find(x => { const a = askOf(x.ob, side); return a && a.best != null && a.best >= 99; }) : null;
    rep.kalshi = { leaderSide: side, lastSecondWithLeaderOffers: lastOffer ? { time: iso(lastOffer.ts), tau: r2((lastOffer.kal.closeMs - lastOffer.ts) / 1000), ask: askOf(lastOffer.ob, side) } : null,
      leaderFirstAt99c: at99 ? { time: iso(at99.ts), tau: r2((at99.kal.closeMs - at99.ts) / 1000) } : null,
      bookAgeMs: (() => { const a = tape.map(x => x.obTs ? x.ts - x.obTs : null).filter(Number.isFinite).sort((p, q) => p - q); return a.length ? { p50: a[Math.floor(a.length / 2)], max: a[a.length - 1] } : null; })(),
      note: 'Kalshi does not publish when it stops accepting orders in this feed; the last second with offers on the leading side is the last executable moment the server saw' };
  } else rep.kalshi = { note: 'no tape: the order book is not in the prediction log' };
  /* ---- what the page received (each /radar response is logged when the state, side or action changes) ---- */
  if (sigs.length) {
    const fl = sigs.find(s => isLocked(s.state)), fh = sigs.find(s => s.state === 'HIGH CONFIDENCE' || isLocked(s.state));
    rep.page = { firstHighConfidenceServed: fh ? { time: iso(fh.ts), tau: fh.tau, soft: fh.soft } : null, firstLockedServed: fl ? { time: iso(fl.ts), tau: fl.tau, trade: fl.trade, ask: fl.ask } : null,
      gateTexts: [...new Set(sigs.flatMap(s => (s.soft || []).concat(s.hard || [])))].slice(0, 12) };
  }
  /* ---- cause ---- */
  const m = rep.milestones, causes = [];
  const softTxt = rep.page ? rep.page.gateTexts.join(' | ') : '';
  if (rep.restart && rep.restart.insideWindow) causes.push(`SOFTWARE/DEPLOYMENT: the server process started ${rep.restart.secondsBeforeClose} s before the close (inside the window); 2.8 cannot show LOCKED for 300 s after a start`);
  if (/warming up/.test(softTxt)) causes.push('the page was told "volatility estimate warming up" (restart warm-up gate)');
  if (m.lockedWithheldSeconds > 0) causes.push(`the model alone supported LOCKED for ${m.lockedWithheldSeconds} s while a gate withheld it`);
  if (m.firstModelSupportedLocked && m.firstLockedShown && m.firstModelSupportedLocked.tau - m.firstLockedShown.tau > 1.5) causes.push(`LOCKED shown ${r2(m.firstModelSupportedLocked.tau - m.firstLockedShown.tau)} s after the model supported it`);
  if (!m.firstModelSupportedLocked) causes.push('MATHEMATICAL/THRESHOLD: the model never reached the 0.5 % flip standard in the logged seconds');
  else if (!m.lockedWithheldSeconds && m.firstLockedShown && m.firstLockedShown.tau < 15) causes.push('MATHEMATICAL/THRESHOLD: the 0.5 % standard was first met late (cushion small for the remaining time)');
  if (rep.kalshi && rep.kalshi.leaderFirstAt99c && m.firstLockedShown && rep.kalshi.leaderFirstAt99c.tau > m.firstLockedShown.tau) causes.push(`MARKET FIRST: Kalshi priced the leader at >= 99c ${r2(rep.kalshi.leaderFirstAt99c.tau - m.firstLockedShown.tau)} s before LOCKED`);
  rep.cause = causes.length ? causes : ['not determined from the files given'];

  /* ---- counterfactual: the same recorded inputs through another build (default 2.8.1) ---- */
  if (tape.length && o.server !== 'none') {
    try {
      process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
      const S = require(path.resolve(o.server || path.join(__dirname, '..', 'dist', 'pinradar_server.js')));
      const { restoreAndDecide } = require(path.join(__dirname, 'replay_tape281.js'));
      const rows = [];
      for (const rec of tape) {
        const sn = restoreAndDecide(S, rec, samples).signal;
        rows.push({ ts: rec.ts, tau: r2((rec.kal.closeMs - rec.ts) / 1000), state: sn.state, side: sn.side, pFlip: sn.pFlip, action: sn.trade ? sn.trade.action : null, exec: sn.exec ? sn.exec.state : null });
      }
      const f = g => { const r = rows.find(g); return r ? { time: iso(r.ts), tau: r.tau, state: r.state, side: r.side, action: r.action, exec: r.exec } : null; };
      rep.counterfactual = { server: o.server || '2.8.1 dist', firstLocked: f(r => isLocked(r.state)), firstTradeNow: f(r => r.action === 'TRADE NOW'),
        firstTooLate: f(r => r.exec === 'TOO LATE TO TRADE'), note: 'same recorded inputs (index samples since the process started, Kalshi book, quality) through the other build; no pre-start index history exists' };
    } catch (e) { rep.counterfactual = { error: String(e && e.message || e) }; }
  }
  const out = JSON.stringify(rep, null, 1);
  if (o.out) fs.writeFileSync(o.out, out);
  console.log(out);
}
if (require.main === module) main();
module.exports = { askOf, processStart };
