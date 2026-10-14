  /* --- v2.7 checks: exact settlement arithmetic, official BRTI message handling, panel, gate, reversal, display --- */
  {
    const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
    const savedBRTI = JSON.parse(JSON.stringify(BRTI)), savedLOCK = JSON.parse(JSON.stringify(LOCK25));
    try {
      /* 1. arithmetic (the user's example: 42 recorded, 18 to come) */
      const K = 80000;
      const a = settleMath({ strike: K, recordedAvg: K + 5, recordedN: 42, remaining: 18, spot: K + 5 });
      const b = settleMath({ strike: K, recordedAvg: K + 0.5, recordedN: 42, remaining: 18, spot: K + 0.5 });
      push('2.7 42 recorded at +$5: the 18 remaining must average $11.68 below the strike (incl. the half-cent rounding)', near(a.criticalVsStrike, -(5 * 42 / 18) - 0.005 * 60 / 18, 1e-9), a.criticalVsStrike.toFixed(4));
      push('2.7 42 recorded at +$0.50: only $1.18 below', near(b.criticalVsStrike, -(0.5 * 42 / 18) - 0.005 * 60 / 18, 1e-9), b.criticalVsStrike.toFixed(4));
      const c = settleMath({ strike: K, recordedAvg: K + 5, recordedN: 42, remaining: 18, spot: K - 3 });
      push('2.7 critical average depends on the recorded ticks, not on spot; move = spot - critical', near(c.criticalRemainingAvg, a.criticalRemainingAvg) && near(c.requiredMove, (K - 3) - c.criticalRemainingAvg), c.requiredMove.toFixed(3));
      const tie = settleMath({ strike: 100, recordedAvg: 99.995, recordedN: 60, remaining: 0, spot: 99.995 });
      const below = settleMath({ strike: 100, recordedAvg: 99.9949, recordedN: 60, remaining: 0, spot: 99.9949 });
      push('2.7 rounding: 99.995 -> 100.00 wins (>=), 99.9949 -> 99.99 loses', tie.result === 'UP' && below.result === 'DOWN', tie.final + ' / ' + below.final);
      push('2.7 a jump starting in k s must be r/(r-k) times the move needed now', near(a.jumpNeeded(6), a.requiredMove * 18 / 12), a.jumpNeeded(6).toFixed(2));
      push('2.7 settleMath rejects incomplete inputs', settleMath({ strike: K, recordedN: 10, remaining: 50, spot: K }) === null && settleMath({ strike: NaN, recordedN: 0, remaining: 60, spot: K }) === null, 'null');

      /* 2. official message handling (documented cfbenchmarks_value schema) */
      Object.assign(BRTI, { enabled: true, last: null, last5: null, win: null, finals: [], ticks: [], raw: [], lastSeq: null, seqGaps: 0, msgs: 0, badMsgs: 0, subId: 901, subId5: null, state: 'subscribing' });
      const C = 1_800_000_900_000;                                   // a quarter-hour close
      const mk = (seq, srcTs, value, win) => JSON.stringify({ type: 'cfbenchmarks_value', sid: 7, seq, sending_ts_ms: srcTs + 180,
        msg: { index_id: 'BRTI', received_at: srcTs + 120, data: JSON.stringify({ type: 'value', id: 'BRTI', time: srcTs, value: String(value) }),
          avg_60s_data: { value: String(value - 1), window_size: 59, window_start_ts_ms: srcTs - 60000, window_end_ts_exclusive: srcTs },
          ...(win ? { last_60s_windowed_average_15min: { value: win.value.toFixed(8), window_size: win.size, window_start_ts_ms: C - 60000, window_end_ts_exclusive: C + 1 } } : {}) } });
      brtiHandle27({ type: 'subscribed', id: 901, msg: { channel: 'cfbenchmarks_value', sid: 7 } }, C - 50000);
      push('2.7 BRTI subscribe acknowledged', BRTI.sid === 7, BRTI.state);
      const t42 = C - 18000;
      const consumed = brtiHandle27(JSON.parse(mk(100, t42, 80004.25, { value: 80005.0, size: 42 })), t42 + 300, mk(100, t42, 80004.25, { value: 80005.0, size: 42 }));
      push('2.7 BRTI tick parsed: value from the raw CF frame, accumulator from last_60s_windowed_average_15min (not avg_60s_data)',
        consumed && BRTI.last && near(BRTI.last.value, 80004.25) && BRTI.win && near(BRTI.win.value, 80005.0) && BRTI.win.size === 42 && BRTI.win.closeMs === C,
        JSON.stringify(BRTI.win));
      brtiHandle27(JSON.parse(mk(102, t42 + 1000, 80004.0, { value: 80004.98, size: 43 })), t42 + 1300);
      push('2.7 sequence gap detected (100 -> 102)', BRTI.seqGaps === 1, BRTI.seqGaps);
      push('2.7 other index ids ignored', brtiHandle27({ type: 'cfbenchmarks_value', seq: 103, msg: { index_id: 'ETHUSD_RTI', data: '{"value":"3000"}' } }, t42 + 1400) === true && near(BRTI.last.value, 80004.0), BRTI.last.value);
      push('2.7 non-BRTI messages pass through to the 2.6 handler', brtiHandle27({ type: 'ticker_v2', msg: {} }, t42) === false, 'ok');

      /* 3. official state: fresh / stale / count mismatch / wrong window */
      const nowA = t42 + 1400, tauA = (C - nowA) / 1000;            // 16.6 s left: 43 ticks expected
      const oA = brtiOfficialState27(nowA, C, tauA);
      push('2.7 official state usable: fresh, this window, window_size matches the clock', oA.ok && oA.n === 43 && near(oA.recAvg, 80004.98), JSON.stringify(oA));
      const oStale = brtiOfficialState27(nowA + BRTI_STALE_MS + 500, C, tauA - (BRTI_STALE_MS + 500) / 1000);
      push('2.7 stale official data is rejected', !oStale.ok && /old/.test(oStale.reasons.join(' ')), oStale.reasons.join(' '));
      const oOther = brtiOfficialState27(nowA, C + 900000, tauA);
      push('2.7 accumulator of another window is never used', !oOther.ok, oOther.reasons.join(' '));
      BRTI.win.size = 30;
      const oCount = brtiOfficialState27(nowA, C, tauA);
      push('2.7 window_size inconsistent with the clock is rejected', !oCount.ok && /window_size/.test(oCount.reasons.join(' ')), oCount.reasons.join(' '));
      BRTI.win.size = 43;

      /* 4. panel: OFFICIAL numbers are the exact arithmetic; PROXY labelled and basis-adjusted */
      const geoT = { index: 80003.1, basisMeanUsd: 0.9, basisSdUsd: 3.3, nLock: 43, lockedMean: 80003.9, sigmaBps: 0.3, pUp: 0.9995,
        regime: { bucket: 3 }, recal: { group: 'normal', ratio: 1 } };
      const pO = settlePanel27({ now: nowA, closeMs: C, strike: K, geo: geoT, tau: tauA });
      const exO = settleMath({ strike: K, recordedAvg: 80004.98, recordedN: 43, remaining: 17, spot: 80004.0 });
      push('2.7 OFFICIAL panel = exact arithmetic on the official accumulator and spot', pO.reference === 'OFFICIAL' && pO.recorded === 43 && pO.remaining === 17
        && near(pO.criticalRemainingAvg, round(exO.criticalRemainingAvg, 2), 0.006) && pO.officialPUp != null, JSON.stringify({ crit: pO.criticalRemainingAvg, offPUp: pO.officialPUp, div: pO.divergenceUsd }));
      const pP = settlePanel27({ now: nowA + 60000, closeMs: C, strike: K, geo: geoT, tau: tauA });
      const exP = settleMath({ strike: K, recordedAvg: 80003.9 + 0.9, recordedN: 43, remaining: 17, spot: 80003.1 + 0.9 });
      push('2.7 PROXY panel when the official feed is stale: index + basis mean, labelled PROXY', pP.reference === 'PROXY' && near(pP.criticalRemainingAvg, round(exP.criticalRemainingAvg, 2), 0.006)
        && pP.basisSdUsd === 3.3 && pP.officialPUp == null, JSON.stringify({ ref: pP.reference, crit: pP.criticalRemainingAvg, why: pP.officialReasons }));

      /* 5. gate: only ever adds a soft gate (withholds LOCKED) */
      const gOk = { hard: [], soft: [] }; brtiGate27(gOk, pO, geoT);
      const gProxy = { hard: [], soft: [] }; brtiGate27(gProxy, pP, geoT);
      const pBad = { ...pO, officialPUp: 0.3 }; const gBad = { hard: [], soft: [] }; brtiGate27(gBad, pBad, geoT);
      const pDiv = { ...pO, divergenceUsd: 55 }; const gDiv = { hard: [], soft: [] }; brtiGate27(gDiv, pDiv, geoT);
      push('2.7 gate: official agrees -> nothing; PROXY -> nothing; official disagrees -> LOCKED withheld; $55 divergence -> withheld',
        gOk.soft.length === 0 && gProxy.soft.length === 0 && gBad.soft.length === 1 && gDiv.soft.length >= 1, JSON.stringify([gOk.soft, gBad.soft, gDiv.soft]));
      const dW = m25Decide({ tau: 20, pUp: 0.9995, pUpCons: 0.999, gates: gBad, book: { ok: false }, cfg: m25Cfg(10), hist: [] });
      push('2.7 a gated LOCKED shows HIGH CONFIDENCE with the reason', dW.state === 'HIGH CONFIDENCE' && /official BRTI/.test(dW.reasons.join(' ')), dW.state + ' ' + dW.reasons.join(' '));

      /* 6. official REVERSAL WARNING + the requested display lines */
      Object.assign(LOCK25, { ticker: 'SELFTEST27', hist: [], lockedSide: 'UP', lockedAtTau: 40, revNoted: false });
      const sigL = { ts: nowA, ticker: 'SELFTEST27', tau: 16.6, strike: K, state: 'LOCKED', side: 'UP', pWin: 0.9995, pFlip: 0.0005, reasons: [], trade: { action: 'TRADE NOW' } };
      const rv = brtiAfterClassify27({ ...sigL }, { ...pO, officialPUp: 0.8 }, 'SELFTEST27');
      push('2.7 official reference puts the LOCKED side at 20% -> REVERSAL WARNING, EXIT / NO TRADE', rv.state === 'REVERSAL WARNING' && rv.officialReversal && rv.trade.action === 'EXIT / NO TRADE', rv.state + ' ' + rv.trade.action);
      const nv = brtiAfterClassify27({ ...sigL }, pP, 'SELFTEST27');
      push('2.7 PROXY panel never changes the 2.6 decision', nv.state === 'LOCKED' && !nv.officialReversal && nv.trade.action === 'TRADE NOW', nv.state);
      const dsp = nv.display27;
      push('2.7 display: LOCKED — PREDICTED UP / win / reversal / seconds / critical remaining average', dsp && dsp.headline === 'LOCKED — PREDICTED UP' && dsp.winProbability && dsp.reversalProbability
        && dsp.secondsRemaining === 17 && /BELOW STRIKE$/.test(dsp.criticalRemainingAverage || '') && dsp.reference === 'PROXY', JSON.stringify(dsp));

      /* 7. entitlement error and 5 Hz never counted as observations */
      brtiHandle27({ type: 'error', id: 901, msg: { code: 9, msg: 'not entitled to this channel' } }, nowA);
      push('2.7 entitlement error recognised', BRTI.state === 'not-entitled', BRTI.state);
      const before = BRTI.win.size;
      BRTI.subId5 = 902;
      brtiHandle27({ type: 'cfbenchmarks_value_5hz', seq: 5, msg: { index_id: 'BRTI', value_usd: '80001.00000000', source_ts_ms: nowA + 200, received_at: nowA + 260 } }, nowA + 300);
      push('2.7 5 Hz ticks refresh the spot only, never the settlement accumulator', BRTI.last5 && near(BRTI.last5.value, 80001) && BRTI.win.size === before, JSON.stringify({ last5: BRTI.last5 && BRTI.last5.value, size: BRTI.win.size }));
    } catch (e) {
      push('2.7 self-test block ran without throwing', false, String(e && e.stack || e).slice(0, 300));
    } finally {
      for (const k of Object.keys(BRTI)) delete BRTI[k];
      Object.assign(BRTI, savedBRTI);
      for (const k of Object.keys(LOCK25)) delete LOCK25[k];
      Object.assign(LOCK25, savedLOCK);
    }
  }
