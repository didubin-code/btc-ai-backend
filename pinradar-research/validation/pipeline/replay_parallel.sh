#!/bin/bash
# Splits a long chronological replay into month chunks run in parallel (each chunk starts with its own 4 h warm-up, so the basis
# model and the volatility ring are warm before its first scored window), then concatenates the records in time order.
# usage: bash replay_parallel.sh <server.js> <secDir> <venues> <markets.ndjson> <fromYYYY-MM> <toYYYY-MM(excl)> <out.ndjson> [jobs]
set -euo pipefail
SRV=$1; SEC=$2; VEN=$3; MK=$4; FROM=$5; TO=$6; OUT=$7; JOBS=${8:-$(nproc)}
HERE="$(cd "$(dirname "$0")/.." && pwd)"; TMP=$(mktemp -d)
months=$(python3 -c "
import datetime
y,m=map(int,'$FROM'.split('-')); ye,me=map(int,'$TO'.split('-'))
while (y,m)<(ye,me):
    n=(y+(m==12), m%12+1); print('%04d-%02d-01T00:00:00Z %04d-%02d-01T00:00:00Z' % (y,m,n[0],n[1])); y,m=n")
i=0
while read -r F T; do
  i=$((i+1)); while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do sleep 2; done
  node "$HERE/replay_chrono.js" --server "$SRV" --sec "$SEC" --venues "$VEN" --markets "$MK" --from "$F" --to "$T" \
    --out "$TMP/$(printf %04d $i).ndjson" --trace "$TMP/$(printf %04d $i).trace" 2> "$TMP/$(printf %04d $i).log" &
done <<< "$months"
wait
cat "$TMP"/*.ndjson > "$OUT"; cat "$TMP"/*.trace > "${OUT%.ndjson}.trace.ndjson"; cat "$TMP"/*.log >&2; rm -rf "$TMP"
echo "replay_parallel: $(wc -l < "$OUT") windows -> $OUT" >&2
