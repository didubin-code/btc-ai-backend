    /* ---------------- v2.8: evidence, economics, forward test ---------------- */
    if (req.method === 'GET' && u.pathname === '/v28') { ensureStarted(); return send(res, 200, v28Summary(Date.now())); }
    /* hash-chained ledger: predictions committed before outcomes; ?since=<seq>&n=&format=ndjson */
    if (req.method === 'GET' && u.pathname === '/ledger') {
      const since = Number(u.searchParams.get('since') || 0), n = clamp(Number(u.searchParams.get('n') || 5000), 1, 5000);   // pages of <= 5,000 (event loop)
      const rows = L28.rows.filter(e => e.seq > since).slice(0, n);
      if (u.searchParams.get('format') === 'ndjson') { cors(res); res.setHeader('Content-Type', 'application/x-ndjson'); return res.end(rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); }
      return send(res, 200, { ok: true, version: SERVER_VERSION, genesis: L28.genesis, head: L28.head, seq: L28.seq, inMemoryFrom: L28.rows.length ? L28.rows[0].seq : null, n: rows.length, rows });
    }
    if (req.method === 'GET' && u.pathname === '/ledger/verify') {
      const first = L28.rows[0];
      const v = ledgerVerify28(u.searchParams.get('full') === '1');
      return send(res, 200, { ok: v.ok, version: SERVER_VERSION, verify: v, head: L28.head, seq: L28.seq, inMemoryFrom: first ? first.seq : null,
        genesis: L28.genesis, file: LEDGER28_FILE || null, fileErr: L28.fileErr, resumed: L28.resumed,
        note: 'publish or screenshot `head` now and then: any later rewrite of an earlier entry changes every subsequent hash' });
    }
    /* shadow model competition on identical live inputs, scored at Kalshi settlement */
    if (req.method === 'GET' && u.pathname === '/shadow') {
      return send(res, 200, { ok: true, version: SERVER_VERSION, prereg: PREREG28_ID, configHash: CONFIG28_HASH, policies: SHADOW_POLICIES28,
        scoredWindows: SHADOW28.scored, openWindows: [...SHADOW28.windows.values()].map(w => ({ ticker: w.ticker, closeMs: w.closeMs,
          firstLocks: Object.fromEntries(Object.entries(w.recs).map(([k, r]) => [k, r.firstLock ? { side: r.firstLock.side, tau: r.firstLock.tau } : null])) })),
        summary: shadowSummary28(SHADOW28.stats),
        note: 'forward evidence only: every first call is committed to /ledger before the outcome; fills are the visible Kalshi book at the decision second (not executed)' });
    }
    if (req.method === 'GET' && u.pathname === '/monitors') {
      const sm = shadowSummary28(SHADOW28.stats);
      return send(res, 200, { ok: true, version: SERVER_VERSION, production: sm['A-2.6'] || null,
        policies: Object.fromEntries(Object.entries(sm).map(([k, v]) => [k, { failure: v.failure, edge: v.edge }])),
        latency: latSummary28(LAT28), brtiLatency: BRTI.lat ? { sourceToServer: brtiQ(BRTI.lat.srcToUs), kalshiToServer: brtiQ(BRTI.lat.kalshiToUs) } : null,
        feeds: { liveVenues: VENUE_LIST().filter(v => venueFresh(v, Date.now())).map(v => v.name), kalshiAgeMs: KAL.ts ? Date.now() - KAL.ts : null, brti: BRTI.state, indexLastReason: IDX.lastReason },
        rule: 'an ALARM is evidence the LOCKED loss rate exceeds the standard: stop relying on LOCKED and investigate; parameters are never changed automatically' });
    }
    if (req.method === 'GET' && u.pathname === '/latency') return send(res, 200, { ok: true, version: SERVER_VERSION, latency: latSummary28(LAT28) });
    if (req.method === 'GET' && u.pathname === '/fees') { ensureStarted(); return send(res, 200, { ok: true, version: SERVER_VERSION, ...FEE28, example10at98c: kalshiFeeCents(98, 10), example1at99c: kalshiFeeCents(99, 1) }); }
    /* record/replay tape: 1 Hz index samples + every decision's exact inputs and outputs (?since=<ms>&format=ndjson) */
    if (req.method === 'GET' && u.pathname === '/tape') {
      const since = Number(u.searchParams.get('since') || 0);
      const samples = TAPE28.samples.filter(p => p[0] > since), rows = TAPE28.rows.filter(r => r.ts > since);
      if (u.searchParams.get('format') === 'ndjson') {
        cors(res); res.setHeader('Content-Type', 'application/x-ndjson');
        return res.end(samples.map(p => JSON.stringify({ k: 's', t: p[0], v: p[1] })).concat(rows.map(r => JSON.stringify(r))).join('\n') + '\n');
      }
      return send(res, 200, { ok: true, version: SERVER_VERSION, samples: samples.length, records: rows.length, dropped: TAPE28.dropped, sampleRows: samples, rows });
    }
