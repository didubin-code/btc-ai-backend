#!/usr/bin/env node
/* Forensic reconstruction of one KXBTC15M window from a running Pin Radar 2.8 / 2.8.1 server's own logs.
   Reads only files saved from the server; nothing is fetched and nothing is invented (a field the logs do not contain is
   reported as null with the reason).

   usage: node tools/forensic281.js --ticker KXBTC15M-26OCT141930-30
            [--tape tape.ndjson]          GET /tape?format=ndjson, the default JSON /tape, or the server's TAPE_FILE (boot lines are used)
            [--pred predictions.json]     GET /predictions?ticker=...   (per-second state, probabilities, ask, settlement panel, gate counts)
            [--signals signals.json]      GET /signals?n=5000            (/radar responses are the entries with via='radar')
            [--health health.json --health-at <ISO time the file was saved>]   (uptimeSec -> process start)
            [--ledger a.json,b.json]      GET /ledger?since=0&n=5000 (and later pages), or a ledger_pull28 file: boot and heartbeat entries,
                                          and what the server committed for the window before the outcome (calib, calls, outcome)
            [--server dist/pinradar_server.js]   replay the tape through this build (default: 2.8.1 dist); --server none to skip
            [--out report.json]                                                                                        */
'use strict';
const fs = require('fs'), path = require('path');

function args(argv) { const o = {}; for (let i = 2; i < argv.length; i++) if (argv[i].startsWith('--')) { o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } return o; }
/* a browser- or editor-saved file may start with a BOM; accept one JSON document or newline-delimited JSON */
function readAny(f) {
  const t = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
  try { return JSON.parse(t); } catch (_) { return t.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l)); }
}
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const r2 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const isLocked = s => s === 'LOCKED' || s === 'PROVEN LOCKED';
const askOf = (ob, side) => {
  if (!ob) return null;
  /* a YES ask is a NO bid seen from the other side (2.8 bookFromKal, zero-size levels dropped) */
  const lv = (side === 'UP' ? (ob.no || []) : (ob.yes || [])).filter(([, s]) => s > 0).map(([p, s]) => [Math.round((100 - p) * 100) / 100, s]).sort((a, b) => a[0] - b[0]);
  return lv.length ? { best: lv[0][0], size: lv[0][1], depthAt99: lv.filter(l => l[0] <= 99).reduce((a, l) => a + l[1], 0), levels: lv.slice(0, 5) } : { best: null, size: 0, depthAt99: 0, levels: [] };
};
/* /tape: ndjson lines, or the default JSON {sampleRows:[[t,v]], rows:[...]} */
function tapeLines(x) {
  if (Array.isArray(x)) return x;
  if (x && (x.sampleRows || x.rows)) return (x.sampleRows || []).map(([t, v]) => ({ k: 's', t, v })).concat(x.rows || []);
  return [];
}
/* what the server committed to its hash-chained ledger for one window, before Kalshi published the result */
function ledgerWindow(rows, T) {
  const mine = rows.filter(e => e && e.body && e.body.ticker === T);
  if (!mine.length) return null;
  const win = mine.find(e => e.type === 'window');
  const calib = mine.filter(e => e.type === 'calib').map(e => ({ committed: iso(e.ts), at: e.body.kind === 'tau' ? `T-${e.body.target}` : `flip ${e.body.band}`,
    tau: e.body.tau, pUp: e.body.pUp, state: e.body.state }));
  const calls = {};
  for (const e of mine.filter(e => e.type === 'call')) {
    const rec = e.body.rec || null;                         // bg28 commits rec = the event's own record (firstLock / firstTrade / firstReversal)
    const p = calls[e.body.policy] || (calls[e.body.policy] = {});
    if (!p[e.body.event]) p[e.body.event] = { committed: iso(e.ts), ...(rec || {}), time: rec && rec.ts ? iso(rec.ts) : null };
  }
  const out = mine.find(e => e.type === 'outcome');
  return { firstSeen: win ? { time: iso(win.ts), closeMs: win.body.closeMs, strike: win.body.strike, note: 'first background tick inside the 300 s LOCKED horizon' } : null,
    calib, production: calls['A-2.6'] || null, shadow: Object.fromEntries(Object.entries(calls).filter(([k]) => k !== 'A-2.6')),
    outcome: out ? { committed: iso(out.ts), result: out.body.result, official: out.body.official, winner: out.body.winner, restoredAfterRestart: !!out.body.restoredAfterRestart } : null };
}

function main() {
  const o = args(process.argv);
  if (!o.ticker) { console.error('missing --ticker'); process.exit(2); }
  const T = o.ticker, rep = { ticker: T, generated: new Date().toISOString(), sources: {}, notes: [] };

  /* ---- tape ---- */
  let tape = [], samples = [], tapeBoots = [];
  if (o.tape) {
    const lines = tapeLines(readAny(o.tape));
    const seen = new Set();
    for (const l of lines) {
      if (l.k === 's' && !seen.has(l.t)) { seen.add(l.t); samples.push([l.t, l.v]); }            // a rotated TAPE_FILE repeats its ring history
      else if (l.k === 'boot' && Number.isFinite(l.ts)) tapeBoots.push(l.ts);
    }
    samples.sort((a, b) => a[0] - b[0]); tapeBoots.sort((a, b) => a - b);
    tape = lines.filter(l => l.k === 'd' && l.kal && l.kal.ticker === T).sort((a, b) => a.ts - b.ts);
    rep.sources.tape = { records: tape.length, samples: samples.length, bootLines: tapeBoots.length };
    if (!tape.length) rep.notes.push('the tape has no decision records for this window (the in-memory /tape keeps about the last 10 windows)');
  }
  /* ---- prediction log ---- */
  let pred = [];
  if (o.pred) { const P = readAny(o.pred); pred = (Array.isArray(P) ? P : P.rows || []).filter(r => r.ticker === T).sort((a, b) => a.ts - b.ts); rep.sources.predictions = { rows: pred.length }; }
  /* ---- signals: /radar responses (via='radar') vs background classifier ---- */
  let sigs = [];
  if (o.signals) { const G = readAny(o.signals); sigs = (Array.isArray(G) ? G : G.signals || []).filter(s => s.ticker === T).sort((a, b) => a.ts - b.ts); }
  const radar = sigs.filter(s => s.via === 'radar'), bgs = sigs.filter(s => s.via !== 'radar');
  if (o.signals) rep.sources.signals = { radar: radar.length, background: bgs.length };
  /* ---- ledger (one or more pages / files, oldest first) ---- */
  let ledger = [];
  if (o.ledger) for (const f of String(o.ledger).split(',')) { const L = readAny(f); ledger = ledger.concat(Array.isArray(L) ? L : (L.rows || L.entries || [])); }
  const lw = ledger.length ? ledgerWindow(ledger, T) : null;
  if (o.ledger) rep.sources.ledger = { rows: ledger.length, windowEntries: lw ? 'found' : 'none for this ticker' };
  rep.ledger = lw;

  /* ---- the close ---- */
  const close = tape.length ? tape[0].kal.closeMs : pred.length ? Math.round(pred[0].ts + pred[0].tau * 1000)
    : sigs.length && Number.isFinite(sigs[0].tau) ? Math.round(sigs[0].ts + sigs[0].tau * 1000) : lw && lw.firstSeen ? lw.firstSeen.closeMs : null;
  rep.closeTime = iso(close);
  const firstData = Math.min(...[tape[0] && tape[0].ts, pred[0] && pred[0].ts, sigs[0] && sigs[0].ts, lw && lw.firstSeen ? Date.parse(lw.firstSeen.time) : undefined].filter(Number.isFinite));

  /* ---- process start: every candidate; the latest one at or before the window's first data point ---- */
  const cands = [];
  if (o.health) { const h = readAny(o.health), at = o['health-at'] ? Date.parse(o['health-at']) : (Number.isFinite(h.ts) ? h.ts : NaN);
    if (Number.isFinite(h.uptimeSec) && Number.isFinite(at)) cands.push({ source: '/health uptimeSec', bootMs: at - h.uptimeSec * 1000, version: h.version });
    else rep.notes.push('/health given without a usable save time (--health-at) or ts: not used'); }
  for (const e of ledger) {
    if (e.type === 'boot' && Number.isFinite(e.ts)) cands.push({ source: 'ledger boot entry', bootMs: e.ts });
    if (e.type === 'heartbeat' && e.body && Number.isFinite(e.body.uptimeSec) && Number.isFinite(e.ts)) cands.push({ source: 'ledger heartbeat', bootMs: e.ts - e.body.uptimeSec * 1000 });
  }
  for (const b of tapeBoots) cands.push({ source: 'tape boot line', bootMs: b });
  const uniq = []; for (const c of cands.sort((a, b) => a.bootMs - b.bootMs)) if (!uniq.length || Math.abs(c.bootMs - uniq[uniq.length - 1].bootMs) > 3000) uniq.push(c);
  const limit = Number.isFinite(firstData) ? firstData : close;
  const usable = Number.isFinite(limit) ? uniq.filter(c => c.bootMs <= limit + 1000) : [];
  const later = Number.isFinite(limit) ? uniq.filter(c => c.bootMs > limit + 1000) : [];
  rep.processStart = { candidates: uniq.map(c => ({ ...c, time: iso(c.bootMs) })), chosen: usable.length ? { ...usable[usable.length - 1], time: iso(usable[usable.length - 1].bootMs) } : null,
    laterStartsIgnored: later.map(c => ({ source: c.source, time: iso(c.bootMs) })),
    note: 'the latest start at or before the window\'s first logged second; starts after it belong to later restarts' };
  const boot = rep.processStart.chosen ? rep.processStart.chosen.bootMs : null;
  if (boot != null && close != null) {
    const before = (close - boot) / 1000;
    rep.restart = { processStart: iso(boot), secondsBeforeClose: r2(before), insideWindow: before > 0 && before < 900,
      lockedPossibleFrom: { '2.8 (300 s warm-up)': iso(boot + 300000), '2.8.1 (120 s of history, envelope until 900 s)': iso(boot + 120000) } };
  } else rep.restart = { processStart: null, note: 'process start unknown: give /health with --health-at, the ledger, or a TAPE_FILE with boot lines' };

  /* ---- per-second sequence (predictions preferred; tape outputs otherwise) ---- */
  const seq = pred.length ? pred.map(r => ({ ts: r.ts, tau: r.tau, state: r.state, side: r.side, pWin: r.pWin, pFlip: r.pFlip, pFlipCons: r.pFlipCons, action: r.action, ask: r.ask,
    idx: r.idx, gap: r.gap, sigma: r.sigma, soft: r.gatesSoft, hard: r.gatesHard, n: r.n, recAvg: r.recAvg, crit: r.crit, ref: r.ref }))
    : tape.map(r => ({ ts: r.ts, tau: (r.kal.closeMs - r.ts) / 1000, state: r.out && r.out.state, side: r.out && r.out.side, pWin: r.out && r.out.pWin, pFlip: r.out && r.out.pFlip,
      pFlipCons: r.out && r.out.pFlipCons, action: r.out && r.out.action, idx: r.liveIdx && r.liveIdx.value, hard: r.out && r.out.state === 'DATA UNRELIABLE' ? 1 : 0 }));
  const taus = seq.map(r => r.tau).filter(Number.isFinite);
  const covers = taus.length > 100 && Math.max(...taus) >= 250 && Math.min(...taus) <= 5;
  rep.coverage = { source: pred.length ? 'predictions' : tape.length ? 'tape' : 'none', rows: seq.length, fromTau: taus.length ? r2(Math.max(...taus)) : null, toTau: taus.length ? r2(Math.min(...taus)) : null, coversWindow: covers };
  const first = f => { const r = seq.find(f); return r ? { time: iso(r.ts), tau: r2(r.tau), state: r.state, side: r.side, pWin: r.pWin, pFlip: r.pFlip, action: r.action, ask: r.ask ?? null, index: r2(r.idx), gapUsd: r.gap ?? null, sigmaBps: r.sigma ?? null, softGates: r.soft ?? null } : null; };
  const m = rep.milestones = {
    firstHighConfidence: first(r => r.state === 'HIGH CONFIDENCE' || isLocked(r.state)),
    firstModelSupportedLocked: first(r => r.pFlip != null && r.pFlip <= 0.005 && !r.hard && r.state !== 'DATA UNRELIABLE'),
    firstLockedShown: first(r => isLocked(r.state)),
    firstTradeNow: first(r => r.action === 'TRADE NOW'),
    firstTooLate: first(r => r.action && /TOO LATE/.test(r.action)),
    lockedWithheldSeconds: seq.filter(r => r.state === 'HIGH CONFIDENCE' && r.pFlip != null && r.pFlip <= 0.005).length };
  /* the ledger fills what the per-second logs no longer hold */
  if (!seq.length && lw && lw.production) {
    const pl = lw.production;
    if (pl.firstLock) m.firstLockedShown = { time: pl.firstLock.time, tau: pl.firstLock.tau, state: 'LOCKED', side: pl.firstLock.side, pFlip: pl.firstLock.pFlip, source: 'ledger call A-2.6 firstLock' };
    if (pl.firstTrade) m.firstTradeNow = { time: pl.firstTrade.time, tau: pl.firstTrade.tau, side: pl.firstTrade.side, ask: pl.firstTrade.askCents, depth: pl.firstTrade.depth, evConsCents: pl.firstTrade.evConsCents, source: 'ledger call A-2.6 firstTrade' };
    const band = (lw.calib || []).find(c => c.at === 'flip 0.2-0.5%');
    if (band) m.firstModelSupportedLocked = { tau: band.tau, state: band.state, pUp: band.pUp, source: 'ledger calib: first entry of the flip risk into 0.2-0.5 % (a later direct jump below 0.2 % is not recorded)' };
  }
  rep.fixedTimes = [60, 45, 30, 20, 15, 10, 5].map(t => {
    const r = seq.filter(x => x.tau <= t + 0.5).sort((a, b) => b.tau - a.tau)[0] || null;
    const tr = tape.filter(x => (x.kal.closeMs - x.ts) / 1000 <= t + 0.5).sort((a, b) => a.ts - b.ts)[0] || null;   // first record at or after T-t
    const side = r && r.side ? r.side : null, bk = tr && side ? askOf(tr.ob, side) : null;
    const cal = !r && lw ? (lw.calib || []).find(c => c.at === `T-${t}`) : null;
    if (!r && cal) return { tau: t, source: 'ledger calib', state: cal.state, pUp: cal.pUp };
    return { tau: t, at: r ? iso(r.ts) : null, state: r ? r.state : null, side, winPct: r && r.pWin != null ? r2(100 * r.pWin) : null, reversalPct: r && r.pFlip != null ? +(100 * r.pFlip).toFixed(3) : null,
      index: r ? r2(r.idx) : null, recordedPrints: r ? r.n ?? null : null, recordedAvg: r ? r.recAvg ?? null : null, criticalRemainingAvg: r ? r.crit ?? null : null, sigmaBps: r ? r.sigma ?? null : null,
      action: r ? r.action : null, leaderAskCents: bk ? bk.best : (r && r.ask != null ? r.ask : null), leaderAskSize: bk ? bk.size : null,
      bookAgeMs: tr && tr.obTs ? tr.ts - tr.obTs : null, indexInputAgeMs: tr ? tr.ageMs : null };
  });
  /* ---- Kalshi book near the close (tape only) ---- */
  if (tape.length) {
    const side = (m.firstLockedShown || m.firstHighConfidence || {}).side || null;
    const withOffers = tape.filter(x => side && askOf(x.ob, side) && askOf(x.ob, side).best != null);
    const lastOffer = withOffers.length ? withOffers[withOffers.length - 1] : null;
    const firstEmpty = side ? tape.find(x => x.ob && askOf(x.ob, side).best == null) : null;
    const at99 = side ? tape.find(x => { const a = askOf(x.ob, side); return a && a.best != null && a.best >= 99; }) : null;
    rep.kalshi = { leaderSide: side, lastSecondWithLeaderOffers: lastOffer ? { time: iso(lastOffer.ts), tau: r2((lastOffer.kal.closeMs - lastOffer.ts) / 1000), ask: askOf(lastOffer.ob, side) } : null,
      leaderOffersFirstGone: firstEmpty ? { time: iso(firstEmpty.ts), tau: r2((firstEmpty.kal.closeMs - firstEmpty.ts) / 1000) } : null,
      leaderFirstAt99c: at99 ? { time: iso(at99.ts), tau: r2((at99.kal.closeMs - at99.ts) / 1000) } : null,
      bookAgeMs: (() => { const a = tape.map(x => x.obTs ? x.ts - x.obTs : null).filter(Number.isFinite).sort((p, q) => p - q); return a.length ? { p50: a[Math.floor(a.length / 2)], max: a[a.length - 1] } : null; })(),
      note: 'Kalshi does not report here when it stops accepting orders; the last second with offers on the leading side is the last executable moment the server saw' };
  } else rep.kalshi = { note: 'no tape for this window: the order book is not available (the ledger keeps the ask and depth only at the first TRADE NOW)' };
  /* ---- what the page was sent (/radar) and what the background classifier logged ---- */
  if (o.signals) {
    const fl = radar.find(s => isLocked(s.state)), fh = radar.find(s => s.state === 'HIGH CONFIDENCE' || isLocked(s.state));
    rep.page = radar.length ? { firstHighConfidenceServed: fh ? { time: iso(fh.ts), tau: fh.tau, soft: fh.soft } : null, firstLockedServed: fl ? { time: iso(fl.ts), tau: fl.tau, trade: fl.trade, ask: fl.ask } : null,
      gateTexts: [...new Set(radar.flatMap(s => (s.soft || []).concat(s.hard || [])))].slice(0, 12) } : { note: 'no /radar entries for this window: the page did not poll the server then (or the signal log rotated)' };
    rep.serverClassified = bgs.length ? { firstLocked: (b => b ? { time: iso(b.ts), tau: b.tau, trade: b.trade, ask: b.ask } : null)(bgs.find(s => isLocked(s.state))),
      gateTexts: [...new Set(bgs.flatMap(s => (s.soft || []).concat(s.hard || [])))].slice(0, 12) } : null;
  }
  /* ---- cause ---- */
  const causes = [];
  /* gate texts that mattered: only inside the 300 s LOCKED horizon of this window */
  const softTxt = sigs.filter(s => Number.isFinite(s.tau) && s.tau <= 300 && s.tau > 0).flatMap(s => (s.soft || []).concat(s.hard || [])).join(' | ');
  if (rep.restart && rep.restart.insideWindow) causes.push(`SOFTWARE/DEPLOYMENT: the server process started ${rep.restart.secondsBeforeClose} s before the close (inside the window); 2.8 cannot show LOCKED for 300 s after a start`);
  if (/warming up/.test(softTxt)) causes.push('the warm-up gate ("volatility estimate warming up") was active in this window');
  if (m.lockedWithheldSeconds > 0) causes.push(`the model alone supported LOCKED for ${m.lockedWithheldSeconds} s while a gate withheld it`);
  if (m.firstModelSupportedLocked && m.firstLockedShown && m.firstModelSupportedLocked.tau - m.firstLockedShown.tau > 1.5) causes.push(`LOCKED shown ${r2(m.firstModelSupportedLocked.tau - m.firstLockedShown.tau)} s after the model supported it`);
  const lockedRows = seq.filter(r => isLocked(r.state) && r.tau >= 13);
  if (lockedRows.length && lockedRows.every(r => r.action !== 'TRADE NOW')) {
    const noEdge = lockedRows.filter(r => r.action === 'LOCKED — DO NOT TRADE').length, tooLate = lockedRows.filter(r => r.action && /TOO LATE/.test(r.action)).length;
    if (noEdge) causes.push(`PRICING: LOCKED with no edge at the offered price for ${noEdge} s with at least 13 s left (the market was at least as sure as the model)`);
    if (tooLate) causes.push(`MARKET: no offers on the called side for ${tooLate} s with at least 13 s left; 2.8 labels this "LOCKED — TOO LATE" although the cause is the empty book, not time`);
  }
  if (covers && !m.firstModelSupportedLocked) causes.push('MATHEMATICAL/THRESHOLD: the model never reached the 0.5 % flip standard in this window');
  else if (covers && !m.lockedWithheldSeconds && m.firstLockedShown && m.firstLockedShown.tau < 15) causes.push('MATHEMATICAL/THRESHOLD: the 0.5 % standard was first met late (cushion small for the remaining time)');
  if (!covers && lw && lw.production) {
    const pl = lw.production;
    if (pl.firstLock && !pl.firstTrade) causes.push(`LEDGER: LOCKED ${pl.firstLock.side} committed at T-${pl.firstLock.tau}; no TRADE NOW was committed. Why (no edge, no offers, time, book) is not in the ledger: it needs /tape or /predictions`);
    if (pl.firstLock && pl.firstTrade) causes.push(`LEDGER: LOCKED ${pl.firstLock.side} at T-${pl.firstLock.tau}; TRADE NOW at T-${pl.firstTrade.tau}, ask ${pl.firstTrade.askCents}c, depth ${pl.firstTrade.depth}`);
    if (!pl.firstLock) causes.push('LEDGER: no LOCKED call was committed for this window');
  }
  if (!covers && !lw) causes.push('no per-second rows cover this window: the timing cause cannot be determined from these files');
  if (rep.kalshi && rep.kalshi.leaderFirstAt99c && m.firstLockedShown && rep.kalshi.leaderFirstAt99c.tau > m.firstLockedShown.tau) causes.push(`MARKET FIRST: Kalshi priced the leader at >= 99c ${r2(rep.kalshi.leaderFirstAt99c.tau - m.firstLockedShown.tau)} s before LOCKED`);
  rep.cause = causes.length ? causes : ['not determined from the files given'];

  /* ---- counterfactual: the same recorded inputs through another build (default 2.8.1) ---- */
  if (tape.length && o.server !== 'none') {
    try {
      process.env.ENABLE_WS = '0'; process.env.PINRADAR_REPLAY = '1';
      const S = require(path.resolve(o.server || path.join(__dirname, '..', 'dist', 'pinradar_server.js')));
      const { restoreAndDecide } = require(path.join(__dirname, 'replay_tape281.js'));
      const boots = [...tapeBoots]; if (boot != null && !boots.includes(boot)) boots.push(boot); boots.sort((a, b) => a - b);
      /* the basis model a 2.8.1 process would have had: empty after a start inside the window, else ~1 settled window per 15 min since the start */
      const basisN = rep.restart && rep.restart.secondsBeforeClose != null ? Math.max(0, Math.floor((rep.restart.secondsBeforeClose - 900) / 900) + (rep.restart.insideWindow ? 0 : 1)) : null;
      const rows = [];
      for (const rec of tape) {
        const rr = Number.isFinite(rec.basisN) || basisN == null ? rec : { ...rec, basisN };
        const sn = restoreAndDecide(S, rr, samples, boots).signal;
        rows.push({ ts: rec.ts, tau: r2((rec.kal.closeMs - rec.ts) / 1000), state: sn.state, side: sn.side, pFlip: sn.pFlip, action: sn.trade ? sn.trade.action : null, exec: sn.exec ? sn.exec.state : null, why: sn.exec ? sn.exec.why : null });
      }
      const f = g => { const r = rows.find(g); return r ? { time: iso(r.ts), tau: r.tau, state: r.state, side: r.side, action: r.action, exec: r.exec, why: r.why } : null; };
      rep.counterfactual = { server: o.server || '2.8.1 dist', firstLocked: f(r => isLocked(r.state)), firstTradeNow: f(r => r.exec === 'TRADE NOW'), firstNotTradable: f(r => isLocked(r.state) && r.exec !== 'TRADE NOW'),
        firstTooLate: f(r => r.exec === 'TOO LATE TO TRADE'), assumptions: { processStart: iso(boot), basisLiveN: basisN == null ? 'as recorded / warm' : basisN },
        note: 'same recorded inputs (index samples the process held, Kalshi book, quality) through the other build; there is no index history from before the process started' };
    } catch (e) { rep.counterfactual = { error: String(e && e.message || e) }; }
  }
  const out = JSON.stringify(rep, null, 1);
  if (o.out) fs.writeFileSync(o.out, out);
  console.log(out);
}
if (require.main === module) main();
module.exports = { askOf, tapeLines, ledgerWindow, readAny };
