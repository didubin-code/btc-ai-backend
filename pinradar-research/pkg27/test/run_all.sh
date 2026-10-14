#!/bin/bash
# Re-runs the offline checks on the files in ../upload (no network, no orders). Needs Node 20+ and npm (installs jsdom locally).
set -e
cd "$(dirname "$0")"
[ -d node_modules/jsdom ] || npm install --no-audit --no-fund jsdom@24.1.3 >/dev/null
node run_selftest.js ../upload/btc-ai-backend/pinradar_server.js
T=$(mktemp -d); cp ../upload/btc-ai-backend/pinradar_server.js "$T/pinradar_server.js"; cp ../upload/Btc-signal/btc_pin_radar_27.html "$T/btc_pin_radar_27.html"
node page27_test.js "$T" "$(pwd)/node_modules/jsdom"
node fuzz27.js ../upload/btc-ai-backend/pinradar_server.js ref/pinradar_server_26.js
node replay27.js ref/pinradar_server_26.js ../upload/btc-ai-backend/pinradar_server.js data/replay_sample.ndjson "$T/replay27.json" 1
node brti_history_mock_test.js
echo "ALL CHECKS PASSED"
