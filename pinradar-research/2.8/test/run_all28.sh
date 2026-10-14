#!/bin/bash
# Pin Radar 2.8: every offline check (no network, no orders). Needs Node 20+; npm installs jsdom for the page test.
# usage: bash pinradar-research/2.8/test/run_all28.sh            (from the btc-ai-backend repo root or anywhere)
set -euo pipefail
cd "$(dirname "$0")/.."            # pinradar-research/2.8
R=..                               # pinradar-research
D=$R/pkg27/test/data
PAGE27=${PAGE27:-$R/../../Btc-signal/pinradar-research/versions/2.7/btc_pin_radar_27.html}
[ -d test/node_modules/jsdom ] || (cd test && npm install --no-audit --no-fund --silent jsdom@24.1.3 >/dev/null)
echo "== build (sha-checked patches of the preserved 2.7 files)"
python3 build/build_server28.py
PAGE27="$PAGE27" python3 build/build_page28.py
echo "== 1. server self-test"
node $R/pkg27/test/run_selftest.js dist/pinradar_server.js
echo "== 2. core28 unit / property / Monte-Carlo tests"
node test/core28_test.js dist/pinradar_server.js | head -1
echo "== 3. page (jsdom, real signal objects)"
node test/page28_test.js dist "$(pwd)/test/node_modules/jsdom" | tail -1
echo "== 4. fuzz: 20,000 hostile cases, 2.8 vs 2.7 invariants"
node $R/pkg27/test/fuzz27.js dist/pinradar_server.js $R/versions/2.7/pinradar_server.js | tail -1
echo "== 5. replay parity 2.7 vs 2.8: 58 real contracts, every second T-300..0, PROXY + synthetic OFFICIAL"
node $R/pkg27/test/replay27.js $R/versions/2.7/pinradar_server.js dist/pinradar_server.js $D/replay_sample.ndjson "$(mktemp)" 1 $D/consecutive_sample.ndjson | tail -1 | python3 -c "import json,sys; d=json.load(sys.stdin); print('contracts',d['contracts'],'evals',d['evals'],'proxyMismatches',d['proxyMismatches'],'officialStateDiffs',d['official']['stateDiffs']); sys.exit(1 if d['proxyMismatches'] or d['official']['stateDiffs'] else 0)"
echo "== 6. live path on a fake clock + LIVE==REPLAY through computeLockSnapshot + ledger/tape integrity"
node test/live_sim28.js dist/pinradar_server.js $D/consecutive_sample.ndjson | tail -1
echo "== 7. adversarial scenarios 1-20"
node test/adversarial28.js dist/pinradar_server.js $D/replay_sample.ndjson $D/consecutive_sample.ndjson results/adversarial28.json | tail -1
echo "== 8. settlement arithmetic (2.7 suite on the preserved 2.3 and 2.6 engines + the 2.8 build) and BRTI history tool (mock Kalshi)"
SM=$(mktemp -d); mkdir -p $SM/src $SM/dist26 $SM/test
cp $R/pkg27/research/src/settle27.js $SM/src/; cp $R/pkg27/research/test/settlement_math_test.js $SM/test/
cp dist/pinradar_server.js $SM/dist26/pinradar_server.js; cp $R/versions/2.3/pinradar_server.js $SM/srv23.js
(cd $SM && node test/settlement_math_test.js | tail -1); rm -rf $SM
(cd $R/pkg27/test && node brti_history_mock_test.js | tail -1)
echo "== 9. regressions for the round-3 review findings (decisions, ledger restarts/write failures, forward_report28)"
node test/regress28.js "$(cd $R && pwd)" | tail -1
echo "ALL 2.8 CHECKS PASSED"
