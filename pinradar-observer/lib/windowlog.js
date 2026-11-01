/* Optional plain-text log of each settled 15-minute window (OBSERVER_LOG_WINDOWS=1), so the operator can see from the
   host's private logs that real observations are being recorded. It reuses derive.js on the records of that one window;
   the encrypted store remains the evidence. One line per window, after Kalshi finalizes it:
     coverage   complete / partial (seconds observed, missing) / UNOBSERVED (no Pin Radar rows: a missing observation,
                never reported as "no signal")
     signal     the first LOCKED second with pFlip <= 0.2 %: time, seconds left, side, pFlip, the ask and size on the book
                received before it; or NONE (fully observed, no qualifying second) / none seen (not fully observed)
     after      lost LOCKED later, reversal warning later, direction reversed later (each separately)
     outcome    Kalshi's official result, and whether the signal was CORRECT or WRONG */
'use strict';
const D = require('./derive');
const iso = t => new Date(t).toISOString();

function line(m, startedAt = null) {
  const c = m.coverage, q = m.primary && m.primary.status === 'entry' ? m.primary : null, s = m.settlement;
  const cov = !c ? 'coverage=UNKNOWN (no market times)' : c.status === 'unobserved' ? 'coverage=UNOBSERVED (no Pin Radar rows: missing observation, not "no signal")'
    : `coverage=${c.status} ${c.secondsObserved}/300s missing=${c.missingSeconds}${c.pinradarRestartInFinal300s ? ' PRODUCTION-RESTART' : ''}${c.anomalies.length ? ' anomalies=' + c.anomalies.join('; ') : ''} books=${c.books.usableSnapshotsInFinal300s}`;
  let sig;
  if (!q) sig = m.primary && m.primary.status === 'no-qualifying-signal' ? 'primary=NONE (final 120 s fully observed: no LOCKED second at <= 0.2 %)' : 'primary=NOT DETERMINABLE (' + ((m.primary && m.primary.reason) || 'final 120 s not fully observed') + '; never counted as "no signal")';
  else {
    const at = m.pricing && m.pricing.primary && m.pricing.primary.atSignal;
    const k1 = at && at.theoretical ? at.theoretical.sizes.find(x => x.budgetUsd === 1000) : null;
    const px = !at ? 'price=n/a' : at.unavailable ? 'price=UNAVAILABLE (' + at.unavailable + ')'
      : at.bestAskCents == null ? `NO OFFER on the called side (book received ${at.ageMs} ms before the signal had no asks for ${q.side}; other side's best ask ${q.side === 'UP' ? at.downBestAsk : at.upBestAsk}c)`
      : `ask=${at.bestAskCents}c sizeAtAsk=${at.calledSideLevels && at.calledSideLevels[0] ? at.calledSideLevels[0][1] : 0} askDepthUsd=${at.theoretical.totalAskDepthUsd} bookAgeMs=${at.ageMs} $1000fillable=${k1 ? k1.fullyFillable : 'n/a'}`;
    const ev = k => q.firstLater && q.firstLater[k] ? q.firstLater[k].tau + 's' : 'no';
    sig = `primary(${m.primary.rule}) ${q.entryType} at ${q.utc} tau=${q.tau}s ${q.side} pFlip=${q.pFlip} ${q.state} ${px} timingCertain=${q.timingCertain}`
      + ` | later: lostLocked=${ev('lostLocked')} pFlip>0.2%=${ev('riskAboveThreshold')} warning=${ev('reversalWarning')} directionFlip=${ev('directionFlip')}`
      + ` observedToClose=${q.observedToClose}`;
  }
  const out = !s || !s.outcome ? 'settlement=UNKNOWN' : `settlement=${s.result} (${s.outcome}) value=${s.expirationValue}` + (q ? ` => signal ${q.won ? 'CORRECT' : 'WRONG'} [${q.category}]` : '');
  const prod = m.production ? ` prod=${m.production.version || '?'}/lockMaxFlip=${m.production.lockMaxFlip}` : '';
  const ds = m.provenance ? ` dataset=${m.provenance.dataset}` : '';
  const note = startedAt != null && m.market && Date.parse(m.market.closeTime) - 300e3 < startedAt ? ` | NOTE: this line uses only records seen since this process started (${new Date(startedAt).toISOString()}); the stored record is authoritative` : '';
  return `[window] ${m.ticker} close=${m.market ? m.market.closeTime : '?'}${prod}${ds} | ${cov} | ${sig} | ${out}${note}`;
}

function windowLogger({ log = console.log, delayMs = 90e3, now = Date.now } = {}) {
  const startedAt = now();
  const per = new Map(), health = [], misc = []; let series = null, lastHealthLog = 0, healthFails = 0, rows = 0, rowsSince = now();
  const get = tk => { let w = per.get(tk); if (!w) per.set(tk, w = { recs: [], first: now() }); return w; };
  function summarize(tk) {
    const w = per.get(tk); if (!w) return;
    try {
      const d = D.build([...health, ...(series ? [series] : []), ...misc, ...w.recs]);
      const m = d.markets.find(x => x.ticker === tk);
      if (m) log(line(m, startedAt));
    } catch (e) { log('[window] ' + tk + ' summary failed: ' + e.message); }
    per.delete(tk);
  }
  function tap(r) {
    switch (r.kind) {
      case 'pr.predictions': {
        const by = new Map();
        for (const x of r.rows || []) if (x && typeof x.ticker === 'string') { if (!by.has(x.ticker)) by.set(x.ticker, []); by.get(x.ticker).push(x); }
        for (const [tk, rs] of by) { get(tk).recs.push({ kind: 'pr.predictions', rows: rs }); rows += rs.length; }
        if (now() - rowsSince >= 3600e3) { log(`[prod] ${rows} new Pin Radar rows in the last hour`); rows = 0; rowsSince = now(); }
        break;
      }
      case 'k.book': case 'k.book.same': if (r.ticker) get(r.ticker).recs.push(r); break;
      case 'k.markets': for (const m of r.markets || []) if (m && /^KXBTC15M-/.test(m.ticker || '')) { const w = get(m.ticker);
        if (!w.meta || (m.status === 'finalized' && !w.done)) { w.meta = true; w.recs.push({ kind: 'k.markets', tRecv: r.tRecv, markets: [m] }); }
        if (m.status === 'finalized' && !w.done) { w.done = true; setTimeout(() => summarize(m.ticker), delayMs).unref?.(); } } break;
      case 'k.market':
        if (r.ticker) { const w = get(r.ticker); w.recs.push(r); if (r.market && r.market.status === 'finalized' && !w.done) { w.done = true; setTimeout(() => summarize(r.ticker), delayMs).unref?.(); } }
        break;
      case 'pr.health':
        health.push(r); if (health.length > 180) health.shift();
        if (r.body && r.status === 200) { healthFails = 0; if (now() - lastHealthLog >= 3600e3) { lastHealthLog = now(); log(`[prod] /health 200 version=${r.body.version} build=${r.body.build} uptimeSec=${r.body.uptimeSec} lockMaxFlip=${r.body.tiers && r.body.tiers.lockMaxFlip}`); } }
        else if (++healthFails === 1 || healthFails % 30 === 0) log(`[prod] /health FAILED (${r.status} ${r.error || ''}) x${healthFails}`);
        break;
      case 'k.series': series = r; break;
      case 'obs.start': misc.push(r); break;   // the data directory's first start decides live vs back-fill
      case 'pr.restart': case 'pr.clockstep': case 'obs.gap': misc.push(r); if (misc.length > 500) misc.shift(); if (r.kind !== 'pr.clockstep') log(`[${r.kind}] ${JSON.stringify({ from: r.from && iso(r.from), to: r.to && iso(r.to), reason: r.reason, at: r.at && iso(r.at) })}`); break;
    }
    for (const [tk, w] of per) if (now() - w.first > 26 * 3600e3) per.delete(tk);   // bounded memory
  }
  return { tap, summarize, line };
}
module.exports = { windowLogger, line };
