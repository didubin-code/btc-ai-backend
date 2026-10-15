#!/bin/bash
# Pin Radar 2.8.1: every offline check (no network, no orders). Needs Node 20+ and python3; jsdom from 2.8/test.
# usage: bash pinradar-research/2.8.1/test/run_all281.sh          (writes nothing tracked; builds into a temp dir)
set -euo pipefail
cd "$(dirname "$0")/.."            # pinradar-research/2.8.1
R=..; D=$R/pkg27/test/data; T=$(mktemp -d)
[ -d $R/2.8/test/node_modules/jsdom ] || (cd $R/2.8/test && npm install --no-audit --no-fund --silent jsdom@24.1.3 >/dev/null)
JSDOM="$(cd $R/2.8/test/node_modules/jsdom && pwd)"
echo "== build (sha-checked patches of the delivered 2.8 files) into a temp dir; the committed dist must be identical"
BUILD281_OUT_DIR=$T python3 build/build_server281.py >/dev/null
BUILD281_OUT_DIR=$T python3 build/build_page281.py >/dev/null
for f in pinradar_server.js btc_pin_radar_281.html; do
  if cmp -s "$T/$f" "dist/$f"; then echo "dist/$f is the build of these sources ($(sha256sum dist/$f | cut -c1-16))"; else echo "dist/$f differs from the build: run build_server281.py / build_page281.py"; exit 1; fi
done
echo "== 1. server self-test (default config, and with the new features off)"
node $R/pkg27/test/run_selftest.js dist/pinradar_server.js
COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0 node $R/pkg27/test/run_selftest.js dist/pinradar_server.js
echo "== 2. late-LOCKED suite on 58 real windows: warm parity, restarts (Oct 14 mechanism), Oct 12 reversal, scenarios"
node test/late281_test.js $R/2.8/dist/pinradar_server.js dist/pinradar_server.js $T/late281.json | tail -1
echo "== 2b. DATA UNRELIABLE: sampler phase, real gaps, aligned sampler on real timers, one lagging venue, /dq diagnostics"
node test/dq281_test.js $R/2.8/dist/pinradar_server.js dist/pinradar_server.js | tail -1
echo "== 3. page (jsdom, real 2.8.1 signal objects)"
node test/page281_test.js dist "$JSDOM" | tail -1
echo "== 4. forensic tool on a fixture of the Oct 14 mechanism (2.8 started 330 s before a real window's close)"
node test/make_incident_fixture.js $R/2.8/dist/pinradar_server.js $T/fx 330 >/dev/null
node tools/forensic281.js --ticker KXBTC15M-26OCT131100-00 --tape $T/fx/tape.ndjson --pred $T/fx/predictions.json --signals $T/fx/signals.json --health $T/fx/health.json --out $T/fx/report.json >/dev/null
python3 - "$T/fx/report.json" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1])); m = r['milestones']; c = r.get('counterfactual') or {}
ok = (r['restart']['secondsBeforeClose'] == 330 and any('SOFTWARE/DEPLOYMENT' in x for x in r['cause'])
      and m['lockedWithheldSeconds'] > 0 and m['firstModelSupportedLocked']['tau'] > m['firstLockedShown']['tau']
      and c.get('firstLocked') and c['firstLocked']['tau'] > m['firstLockedShown']['tau'])
print('forensic281: restart found %ss before the close; model supported LOCKED at T-%s, 2.8 showed it at T-%s; 2.8.1 on the same inputs at T-%s -> %s'
      % (r['restart']['secondsBeforeClose'], m['firstModelSupportedLocked']['tau'], m['firstLockedShown']['tau'], c.get('firstLocked', {}).get('tau'), 'PASS' if ok else 'FAIL'))
sys.exit(0 if ok else 1)
EOF
echo "== 5. cold-start volatility band: calibration Jul-Aug, coverage on Sep-Oct"
node $R/research28/late_lock/calib_coldvol.js $T/calib.json >/dev/null
python3 -c "
import json,sys; d=json.load(open('$T/calib.json')); v=d['coverage']['validation']; worst=min(x['coveragePct'] for x in v.values())
print('cold-vol band: validation coverage min over m = %.3f%% (%d series)' % (worst, d['valSeries'])); sys.exit(0 if worst >= 99.9 else 1)"
echo "== 6. the 2.8 suites against 2.8.1 with the new features off (COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0): must behave as 2.8"
export COLD_START_ENVELOPE=0 EXEC_SEC=0 DQ_FIXES=0
(cd $R/2.8 && node test/core28_test.js ../2.8.1/dist/pinradar_server.js | head -1)
node $R/pkg27/test/fuzz27.js dist/pinradar_server.js $R/versions/2.7/pinradar_server.js | tail -1
node $R/pkg27/test/replay27.js $R/versions/2.7/pinradar_server.js dist/pinradar_server.js $D/replay_sample.ndjson "$T/rp.json" 1 $D/consecutive_sample.ndjson | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('replay parity vs 2.7: contracts',d['contracts'],'evals',d['evals'],'proxyMismatches',d['proxyMismatches'],'officialStateDiffs',d['official']['stateDiffs']); sys.exit(1 if d['proxyMismatches'] or d['official']['stateDiffs'] else 0)"
(cd $R/2.8 && node test/adversarial28.js ../2.8.1/dist/pinradar_server.js $D/replay_sample.ndjson $D/consecutive_sample.ndjson $T/adv.json | tail -1)
(cd $R/2.8 && node test/props28.js ../2.8.1/dist/pinradar_server.js | tail -1)
(cd $R/2.8 && node test/live_sim28.js ../2.8.1/dist/pinradar_server.js $D/consecutive_sample.ndjson | tail -1)
unset COLD_START_ENVELOPE EXEC_SEC DQ_FIXES
rm -rf $T
echo "ALL 2.8.1 CHECKS PASSED"
