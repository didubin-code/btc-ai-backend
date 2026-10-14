  /* --- v2.8 checks (core arithmetic, ledger, monitors, and regressions for defects D1-D6) --- */
  {
    let fb = 0;
    for (let p = 1; p <= 99; p += 7) for (const n of [1, 10, 100]) if (Math.abs(Math.ceil(7 * n * (p / 100) * (1 - p / 100) - 1e-9) / n - feeCentsPerContract28(p, n, feeCfg28())) > 1e-9) fb++;
    push('2.8 fee: exact integer fee equals the 2.6 fee at whole-cent prices', fb === 0, fb);
    push('2.8 fee: 4 contracts at 50c = 7c exactly (no float overshoot to 8c)', Math.abs(feeDollars28(50, 4, feeCfg28()) - 0.07) < 1e-12, feeDollars28(50, 4, feeCfg28()));
    const Lt = mkLedger28({ genesisSeed: 'selftest' }); for (let i = 0; i < 10; i++) ledgerAppend28(Lt, 't', { i }, i);
    const tam = JSON.parse(JSON.stringify(Lt.rows)); tam[4].body.i = 99;
    push('2.8 ledger: verifies and detects an altered entry', verifyLedger28(Lt.rows, Lt.genesis).ok && verifyLedger28(tam, Lt.genesis).at === 5, 'ok');
    const lv = verifyLedger28(L28.rows, L28.rows.length && L28.rows[0].seq === 1 ? L28.genesis : null);
    push('2.8 ledger: the live chain verifies', lv.ok, lv);
    const b = band28(0.004, 'quiet');
    push('2.8 band: brackets the point estimate', b.lo < 0.004 && b.hi > 0.004, b.label);
    push('2.8 designation: LOCKED = PREDICTED LOCKED; proxy after the close is never FINAL',
      designation28({ state: 'LOCKED', tau: 30 }).code === 'PREDICTED_LOCKED' && designation28({ state: 'LOCKED', tau: -1, panel: { reference: 'PROXY', decided: true } }).code === 'AWAITING_SETTLEMENT', 'ok');
    const fm = mkFailMonitor28(0.005); for (let i = 0; i < 200; i++) failUpdate28(fm, false);
    const fm2 = mkFailMonitor28(0.005); for (let i = 0; i < 100; i++) failUpdate28(fm2, i % 10 === 0);
    push('2.8 failure alarm: silent after 200 wins, fires at a 10 % loss rate', !failState28(fm).alarm && failState28(fm2).alarm, [failState28(fm).eValue, failState28(fm2).eValue]);
    /* D1: no live index -> hard gate (state restored afterwards; nothing else is mutated) */
    const l25 = { ticker: LOCK25.ticker, hist: LOCK25.hist.slice(), lockedSide: LOCK25.lockedSide, lockedAtTau: LOCK25.lockedAtTau, revNoted: LOCK25.revNoted };
    try {
      const nowS = Date.now();
      const sn = computeLockSnapshot({ now: nowS, kal: { ok: true, ticker: 'SELFTEST-28', closeMs: nowS + 40000, openMs: nowS - 860000, strike: 80000 }, strike: 80000,
        strikeIssue: null, overrides: [], quality: { grade: 'GOOD', problems: [], warnings: [] }, liveIdx: null, liveIndexAgeMs: Infinity, side: null, mutate: false });
      push('2.8 D1: live-index quorum failure is a hard gate (never LOCKED / TRADE NOW on the last stale value)',
        sn.gates.hard.some(x => /live index unavailable/.test(x)) && sn.signal.state !== 'LOCKED' && !(sn.signal.trade && sn.signal.trade.action === 'TRADE NOW'), sn.gates.hard);
    } finally { Object.assign(LOCK25, l25); }
    /* D2: an official tick 60 s old at the source is stale even if it arrived just now */
    const bs = { enabled: BRTI.enabled, last: BRTI.last, last5: BRTI.last5, win: BRTI.win };
    try {
      const nowB = Date.now();
      Object.assign(BRTI, { enabled: true, last5: null, win: null, last: { value: 80000, sourceTs: nowB - 60000, receivedAt: nowB - 10, sendingTs: nowB - 5, localTs: nowB, amended: false, seq: null } });
      const st = brtiOfficialState27(nowB, nowB + 90000, 90);
      push('2.8 D2: official BRTI freshness uses the source timestamp', !st.ok && st.ageMs >= 59000, st.reasons);
    } finally { Object.assign(BRTI, bs); }
    /* round 2: with a non-default fee schedule (here per-fill rounding) the decision's fee is computed on the walked fills */
    const fcS = { ...FEE28.cfg }, fdS = FEE28.isDefault;
    try {
      FEE28.cfg = { ...FEE28.cfg, perFill: true }; fee28Recompute();
      const bk = { ok: true, ageMs: 100, yesAsks: [[97, 3], [98, 7]], noAsks: [[3, 50]] };
      const d = m25Decide({ tau: 40, pUp: 0.9995, pUpCons: 0.999, gates: { hard: [], soft: [] }, book: bk, cfg: m25Cfg(10), hist: [] });
      const want = walkFeeCents28(walk28(bk.yesAsks, 10).fills, FEE28.cfg) / 10;
      push('2.8 fee: per-fill rounding (non-default schedule) reaches the TRADE NOW decision', !FEE28.isDefault && Math.abs(d.trade.feeCents - Math.round(want * 1000) / 1000) < 1e-9 && d.trade.feeCents > kalshiFeeCents(d.trade.avgCents, 10) - 1e-9, [d.trade.feeCents, want]);
    } finally { FEE28.cfg = fcS; FEE28.isDefault = fdS; fee28Recompute(); }
    /* round 3: a ledger entry is a snapshot -- changing the caller's object afterwards (the fee refresh did) cannot break the chain */
    const Ls = mkLedger28({ genesisSeed: 'selftest-snap' }); const ob28 = { a: 1, cfg: { m: 1 } }; ledgerAppend28(Ls, 'fees', ob28, 1); ob28.a = 2; ob28.cfg.m = 3; ledgerAppend28(Ls, 't', {}, 2);
    push('2.8 ledger: entries are snapshots (a later change to the source object leaves the chain valid)', verifyLedger28(Ls.rows, Ls.genesis).ok && Ls.rows[0].body.a === 1 && Ls.rows[0].body.cfg.m === 1, verifyLedger28(Ls.rows, Ls.genesis));
    const fm3 = mkFailMonitor28(0.005); for (let i = 0; i < 20; i++) failUpdate28(fm3, i < 4); for (let i = 0; i < 2000; i++) failUpdate28(fm3, false);
    const st3 = failState28(fm3);
    push('2.8 failure alarm is latched (Ville bounds sup E): an alarm that later decays below 20 stays an alarm', st3.alarm && !st3.alarmNow && st3.firstAlarmAtWindow != null && st3.supEValue >= 20, [st3.eValue, st3.supEValue, st3.firstAlarmAtWindow]);
    /* D4: a price-only PROVEN bound never overrides an official-reference disagreement */
    const bkP = { ok: true, ageMs: 100, yesAsks: [[99, 50]], noAsks: [[2, 50]] };
    const dPg = m25Decide({ tau: 20, pUp: 0.99999, pUpCons: 0.9999, gates: { hard: [], soft: ['official BRTI disagrees'], official: ['official flip risk'] }, book: bkP, cfg: m25Cfg(10), hist: [], provenSide: 'UP' });
    const dPo = m25Decide({ tau: 20, pUp: 0.99999, pUpCons: 0.9999, gates: { hard: [], soft: ['volatility estimate warming up'], official: [] }, book: bkP, cfg: m25Cfg(10), hist: [], provenSide: 'UP' });
    push('2.8 D4: PROVEN LOCKED is withheld when the official reference disagrees (and only then)', dPg.state === 'HIGH CONFIDENCE' && !(dPg.trade && dPg.trade.action === 'TRADE NOW') && dPo.state === 'PROVEN LOCKED', [dPg.state, dPg.trade && dPg.trade.action, dPo.state]);
    /* D5 + D6 (LOCK25 / BRTI restored afterwards) */
    const l25b = { ticker: LOCK25.ticker, hist: LOCK25.hist.slice(), lockedSide: LOCK25.lockedSide, lockedAtTau: LOCK25.lockedAtTau, revNoted: LOCK25.revNoted };
    const bs6 = { enabled: BRTI.enabled, last: BRTI.last, last5: BRTI.last5, win: BRTI.win };
    try {
      Object.assign(LOCK25, { ticker: 'SELFTEST-28R', hist: [], lockedSide: 'UP', lockedAtTau: 40, revNoted: false });
      const rv = brtiAfterClassify27({ ts: Date.now(), ticker: 'SELFTEST-28R', tau: 12, strike: 80000, state: 'LOCKED', side: 'UP', pWin: 0.9995, pFlip: 0.0005, pFlipCons: 0.0007,
        pWinLabel: '99.95%', pFlipLabel: '0.05%', guarantee: 'prediction, not a guarantee', reasons: [], trade: { action: 'TRADE NOW' } }, { reference: 'OFFICIAL', officialPUp: 0.8, criticalVsStrike: 1 }, 'SELFTEST-28R');
      push('2.8 D5: an official REVERSAL WARNING shows the official numbers (20 % flip), not the proxy\'s', rv.state === 'REVERSAL WARNING' && Math.abs(rv.pFlip - 0.2) < 1e-9 && Math.abs(rv.pWin - 0.8) < 1e-9
        && rv.guarantee == null && rv.display27.reversalProbability === fmtFlip(0.2), [rv.state, rv.pWin, rv.pFlip, rv.display27 && rv.display27.reversalProbability]);
      const C6 = Math.ceil(Date.now() / 900000) * 900000, now6 = C6 + 1000;
      Object.assign(BRTI, { enabled: true, last5: null, last: { value: 80000, sourceTs: now6 - 100 - (Number.isFinite(SKEW.estMs) ? SKEW.estMs : 0), localTs: now6 - 50, receivedAt: now6 - 50 },
        win: { closeMs: C6, size: 58, value: 80000.004, localTs: now6 - 50 } });
      const p58 = settlePanel27({ now: now6, closeMs: C6, strike: 80000, geo: null, tau: -1 });
      BRTI.win = { closeMs: C6, size: 60, value: 80000.004, localTs: now6 - 50 };
      const p60 = settlePanel27({ now: now6, closeMs: C6, strike: 80000, geo: null, tau: -1 });
      const d58 = designation28({ tau: -1, panel: p58, strike: 80000 }), d60 = designation28({ tau: -1, panel: p60, strike: 80000 });
      push('2.8 D6: after the close 58/60 official values are not final; 60/60 is', p58 && p58.reference === 'OFFICIAL' && !p58.decided && p58.remaining === 2 && d58.code !== 'MATHEMATICALLY_FINAL'
        && p60 && p60.decided && d60.code === 'MATHEMATICALLY_FINAL', [p58 && p58.remaining, p58 && p58.decided, d58.code, d60.code]);
    } finally { Object.assign(LOCK25, l25b); Object.assign(BRTI, bs6); }
    /* D3: zero-size levels are not offers */
    const obS = KAL.ob, obT = KAL.obTs;
    try {
      KAL.ob = { ticker: 'SELFTEST-28', yes: [[97, 0], [96, 5]], no: [[3, 0], [2, 7]] }; KAL.obTs = Date.now();
      const bk = bookFromKal({ ok: true, ticker: 'SELFTEST-28' }, Date.now());
      push('2.8 D3: a zero-size best level is never shown as the ask', bk.yesAsks.length === 1 && bk.yesAsks[0][0] === 98 && bk.noAsks[0][0] === 4, bk);
    } finally { KAL.ob = obS; KAL.obTs = obT; }
  }
