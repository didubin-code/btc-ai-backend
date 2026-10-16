#!/bin/bash
# Phase 2 end to end, once the network allows api.elections.kalshi.com, data.binance.vision, api.exchange.coinbase.com, api.kraken.com.
# Every step is resumable; raw responses and their SHA-256 are logged under DATA/*/PROVENANCE*.ndjson.
# usage: bash validation/pipeline/run_pipeline.sh [DATA_DIR] [PROXY_FROM]      (from the pinradar-research directory)
set -euo pipefail
cd "$(dirname "$0")"
DATA=${1:-$PWD/../data}; PFROM=${2:-2023-10-01}; TODAY=$(date -u +%F)
mkdir -p "$DATA"
echo "== 1. Kalshi: endpoint probe, then every settled KXBTC15M market (official expiration_value + result)"
python3 fetch_kalshi.py probe --out "$DATA/kalshi"
python3 fetch_kalshi.py markets --out "$DATA/kalshi"
FIRST=$(python3 -c "import json,datetime;r=[json.loads(l) for l in open('$DATA/kalshi/markets.ndjson')];print(datetime.datetime.fromtimestamp(min(x['closeTs'] for x in r if x['closeTs']),datetime.timezone.utc).date())")
echo "   KXBTC15M history starts $FIRST"
echo "== 2. Kalshi trade prints in each window's final 300 s (execution evidence)"
python3 fetch_kalshi.py trades --out "$DATA/kalshi" --last 300
echo "== 3. 1 Hz prices: Coinbase + Kraken (USD constituents) over the contract history; Binance 1 s for the long-horizon proxy study"
python3 fetch_usd_trades.py --venue kr --from "$FIRST" --to "$TODAY" --out "$DATA/sec"
python3 fetch_usd_trades.py --venue cb --from "$FIRST" --to "$TODAY" --out "$DATA/sec"
python3 fetch_binance_1s.py --from "$PFROM" --to "$TODAY" --out "$DATA/sec"
python3 make_proxy_markets.py --sec "$DATA/sec" --from "$PFROM" --to "$FIRST" --out "$DATA/proxy_markets.ndjson"
echo "== 4. chronological replays (primary 2.8.1 and baseline 2.8), contract windows on cb+kr, proxy windows on Binance"
for V in 2.8.1 2.8; do
  node ../replay_chrono.js --server ../../$V/dist/pinradar_server.js --sec "$DATA/sec" --venues cb,kr --markets "$DATA/kalshi/markets.ndjson" \
    --from "${FIRST}T00:00:00Z" --to "${TODAY}T00:00:00Z" --out "$DATA/replay_${V}_contracts.ndjson" --trace "$DATA/trace_${V}_contracts.ndjson"
  bash replay_parallel.sh ../../$V/dist/pinradar_server.js "$DATA/sec" proxy "$DATA/proxy_markets.ndjson" "${PFROM:0:7}" "${FIRST:0:7}" "$DATA/replay_${V}_proxy.ndjson"
done
echo "== 5. scoring by the pre-registered splits (VALIDATION_PREREG.md)"
SPL="S1|2026-07-22T00:00:00+00:00|2026-08-14T00:00:00+00:00,S2|2026-08-14T00:00:00+00:00|2026-09-04T00:00:00+00:00,S0|2026-09-04T00:00:00+00:00|2026-10-14T00:00:00+00:00,U1|2026-10-14T00:00:00+00:00|2100-01-01T00:00:00+00:00,U2|2000-01-01T00:00:00+00:00|2026-07-22T00:00:00+00:00"
for V in 2.8.1 2.8; do
  python3 analyze.py --records "$DATA/replay_${V}_contracts.ndjson" --splits "$SPL" --out "$DATA/summary_${V}_contracts.json"
  python3 analyze.py --records "$DATA/replay_${V}_proxy.ndjson" --out "$DATA/summary_${V}_proxy.json"
  python3 execution.py --records "$DATA/replay_${V}_contracts.ndjson" --trace "$DATA/trace_${V}_contracts.ndjson" --trades "$DATA/kalshi/trades" --out "$DATA/exec_${V}.json"
done
echo "PIPELINE DONE: $DATA/summary_*.json, $DATA/exec_*.json"
