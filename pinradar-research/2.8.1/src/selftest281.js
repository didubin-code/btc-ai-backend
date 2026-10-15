  /* --- v2.8.1 checks (restart envelopes, order time, execution stress, action states) --- */
  {
    const nowS = Date.now();
    /* cold-vol bracket: exact lower bound, empirical upper bound, none once 900 s are held */
    const ringC = []; for (let i = 0; i < 200; i++) ringC.push([nowS - (199 - i) * 1000, 80000 + 3 * Math.sin(i / 7)]);
    const cvC = coldVol281(nowS, ringC);
    push(COLD281_ON ? '2.8.1 cold vol: 199 s of history -> usable bracket [sqrt(m/900) sigma_m, max(K sigma_m, F)]' : '2.8.1 cold vol: COLD_START_ENVELOPE=0 -> no bracket (2.8 warm-up behaviour)',
      COLD281_ON ? (cvC.cold && cvC.usable && Math.abs(cvC.lo - Math.sqrt(cvC.span / 900) * cvC.sigmaM) < 1e-9 && cvC.hi >= Math.max(cvC.K * cvC.sigmaM, cvC.F) - 1e-12) : (cvC.cold && !cvC.usable), cvC);
    const ringW = []; for (let i = 0; i < 960; i++) ringW.push([nowS - (959 - i) * 1000, 80000 + 3 * Math.sin(i / 7)]);
    push('2.8.1 cold vol: 960 s of history -> warm (no envelope)', coldVol281(nowS, ringW).cold === false, coldVol281(nowS, ringW));
    const ringS = ringC.slice(-90);
    push('2.8.1 cold vol: < COLD_MIN_SEC of history -> not usable (LOCKED stays withheld)', coldVol281(nowS, ringS).usable === false, coldVol281(nowS, ringS).span);
    /* envelope is never more confident than the measured-sigma geometry it brackets */
    const args = { indexNow: 80040, strike: 80000, closeMs: nowS + 45000, now: nowS, inputAgeMs: 100, ring: ringC, basisMu: 0 };
    const g0 = lockGeometry25(args), gE = coldGeometry281(g0, args, cvC, { cold: false, n: 99 });
    const win = (g, s) => (s === 'UP' ? g.pUp : 1 - g.pUp);
    push('2.8.1 cold envelope: worst-case win probability <= the measured-sigma value' + (COLD281_ON ? ', volatility counted as covered' : ' (envelope off: no change)'),
      gE && g0 && win(gE, 'UP') <= win(g0, 'UP') + 1e-12 && (COLD281_ON ? (gE.sigmaWarm === true && gE.cold281 && gE.cold281.volEnvelope) : gE.pUp === g0.pUp), [g0 && g0.pUp, gE && gE.pUp]);
    const gB = coldGeometry281(g0, args, { cold: false, span: 999 }, { cold: true, n: 0 });
    push('2.8.1 cold basis: worst case over the basis range is no more confident than the prior mean', gB && win(gB, 'UP') <= win(g0, 'UP') + 1e-12 && gB.cold281.basisEnvelope, [g0 && g0.pUp, gB && gB.pUp]);
    /* review blocker: a cold basis must never present the OPPOSITE side as a confident call (DOWN leader, tiny gap, near the close) */
    {
      const ringD = []; for (let i = 0; i < 960; i++) ringD.push([nowS - (959 - i) * 1000, 80000 - 0.5 + 0.2 * Math.sin(i / 5)]);
      const aD = { indexNow: 79999.5, strike: 80000, closeMs: nowS + 6000, now: nowS, inputAgeMs: 100, ring: ringD, basisMu: 0 };
      const gD0 = lockGeometry25(aD), gDB = coldGeometry281(gD0, aD, { cold: false, span: 999 }, { cold: true, n: 0 });
      const flipped = gDB && gD0 && gD0.pUp < 0.5 && gDB.pUp > 0.5;
      push('2.8.1 cold basis: a DOWN leader is never turned into an UP call (no side unless it leads under every candidate)', gDB && !flipped && (gDB.pUp === 0.5 || gDB.pUp <= gD0.pUp + 1e-12), [gD0 && gD0.pUp, gDB && gDB.pUp, gDB && gDB.cold281 && gDB.cold281.leaderUnderAllCandidates]);
    }
    /* review finding: the warm-up gate text must state the real requirement (300 s when the envelope is off, as in 2.8) */
    {
      const gC = { ...lockGeometry25({ ...args, ring: ringS }), sigmaWarm: false };
      const dC = classify25({ now: nowS, tau: 45, ticker: 'SELFTEST-281', closeMs: nowS + 45000, strike: 80000, geo: gC, gates: { hard: [], soft: [], official: [] }, kal: { ok: true, ticker: 'SELFTEST-281' }, contracts: 10, mutate: false });
      const need = COLD281_ON ? COLD_MIN_SEC : 300;
      push('2.8.1 warm-up gate text states the real requirement (' + need + ' s)', dC.gates.soft.some(t => t.includes(`LOCKED needs ${need} s`)), dC.gates.soft);
    }
    /* order time and stress */
    push('2.8.1 order time: m25Cfg adds the order time to the 3 s fill margin', m25Cfg(10, 10).minExecTau === MIN_EXEC_TAU + 10 && m25Cfg(10, 0).minExecTau === MIN_EXEC_TAU, [m25Cfg(10, 10).minExecTau, m25Cfg(10, 0).minExecTau]);
    const bk = { ok: true, ageMs: 100, yesAsks: [[97, 500]], noAsks: [[4, 500]] };
    const dLate = m25Decide({ tau: 9, pUp: 0.9999, pUpCons: 0.9995, gates: { hard: [], soft: [], official: [] }, book: bk, cfg: m25Cfg(10, 10), hist: [] });
    const dOk = m25Decide({ tau: 30, pUp: 0.9999, pUpCons: 0.9995, gates: { hard: [], soft: [], official: [] }, book: bk, cfg: m25Cfg(10, 10), hist: [] });
    const dStress = m25Decide({ tau: 30, pUp: 0.9999, pUpCons: 0.9995, pUpStress: 0.90, gates: { hard: [], soft: [], official: [] }, book: bk, cfg: m25Cfg(10, 10), hist: [] });
    push('2.8.1 order time: a valid LOCKED with 9 s left and a 10 s order time is TOO LATE, with 30 s left it is TRADE NOW',
      dLate.trade.action === 'LOCKED — TOO LATE' && dOk.trade.action === 'TRADE NOW', [dLate.trade.action, dOk.trade.action]);
    push('2.8.1 stress: TRADE NOW is refused when an adverse move during the order time removes the edge', dStress.trade.action === 'LOCKED — DO NOT TRADE' && /survive/.test(dStress.trade.why), dStress.trade);
    const gS = lockGeometry25({ ...args, ring: ringW });
    const ps0 = stressPUp281(gS, 45, 10, 0), ps3 = stressPUp281(gS, 45, 3), ps10 = stressPUp281(gS, 45, 10), ps30 = stressPUp281(gS, 45, 30);
    push('2.8.1 stress: never more confident than the live call, and less confident the longer the order time',
      gS && ps0 != null && Math.abs(ps0 - gS.pUp) < 1e-5 && ps3 <= ps0 + 1e-12 && ps10 <= ps3 + 1e-12 && ps30 <= ps10 + 1e-12, [gS && gS.pUp, ps0, ps3, ps10, ps30]);   // ps0: z = 0 (geo fields are rounded, so not bit-equal to pUp)
    /* action states */
    const a1 = exec281({ state: 'LOCKED', side: 'UP', trade: { action: 'LOCKED — DO NOT TRADE', why: 'x' }, ticker: null }, { tau: 40, execSec: 10, now: nowS });
    const a2 = exec281({ state: 'LOCKED', side: 'UP', trade: { action: 'LOCKED — TOO LATE', why: 'y' }, ticker: null }, { tau: 8, execSec: 10, now: nowS });
    const a3 = exec281({ state: 'LOCKED', side: 'UP', trade: { action: 'TRADE NOW', why: 'z' }, ticker: null }, { tau: -2, execSec: 10, now: nowS });
    const a4 = exec281({ state: 'HIGH CONFIDENCE', side: 'UP', trade: { action: 'WAIT' }, ticker: null }, { tau: 40, execSec: 10, now: nowS });
    push('2.8.1 actions: no edge -> PREDICTED LOCKED, late -> TOO LATE TO TRADE, after the close -> FINAL (never an opportunity), HIGH -> SIT OUT',
      a1.exec.state === 'PREDICTED LOCKED' && a2.exec.state === 'TOO LATE TO TRADE' && a3.exec.state === 'FINAL' && a4.exec.state === 'SIT OUT', [a1.exec.state, a2.exec.state, a3.exec.state, a4.exec.state]);
  }
