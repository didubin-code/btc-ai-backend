  /* --- v2.8 checks (core arithmetic, ledger, monitors, and regressions for defects D1-D3) --- */
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
    /* D3: zero-size levels are not offers */
    const obS = KAL.ob, obT = KAL.obTs;
    try {
      KAL.ob = { ticker: 'SELFTEST-28', yes: [[97, 0], [96, 5]], no: [[3, 0], [2, 7]] }; KAL.obTs = Date.now();
      const bk = bookFromKal({ ok: true, ticker: 'SELFTEST-28' }, Date.now());
      push('2.8 D3: a zero-size best level is never shown as the ask', bk.yesAsks.length === 1 && bk.yesAsks[0][0] === 98 && bk.noAsks[0][0] === 4, bk);
    } finally { KAL.ob = obS; KAL.obTs = obT; }
  }
