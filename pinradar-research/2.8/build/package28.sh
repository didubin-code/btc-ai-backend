#!/bin/bash
# Package Pin Radar 2.8 as a self-contained archive (upload files, rollback files, every source, test and tool,
# the preserved versions and the prior 2.7 research package). usage: bash package28.sh <output dir>
set -euo pipefail
OUTDIR=$(cd "${1:?usage: package28.sh <output dir>}" && pwd)
R=$(cd "$(dirname "$0")/../.." && pwd)                      # pinradar-research
SIG=${BTC_SIGNAL_DIR:-$R/../../Btc-signal}
T=$(mktemp -d); P=$T/pinradar-2.8
mkdir -p $P/upload/btc-ai-backend $P/upload/Btc-signal $P/rollback/btc-ai-backend $P/rollback/Btc-signal
cp $R/2.8/dist/pinradar_server.js $P/upload/btc-ai-backend/pinradar_server.js
cp $R/2.8/dist/btc_pin_radar_28.html $P/upload/Btc-signal/btc_pin_radar_28.html
cp $R/versions/2.3/pinradar_server.js $P/rollback/btc-ai-backend/pinradar_server.js
cp $SIG/pinradar-research/versions/2.3/btc_pin_radar.html $P/rollback/Btc-signal/btc_pin_radar.html
(cd $R/.. && tar --exclude=node_modules --exclude=package-lock.json -cf - pinradar-research) | (cd $P && tar -xf -)
mkdir -p $P/pinradar-research/versions/pages      # pkg27_page (the 2.7 page source) is part of the tree
for v in 2.3 2.4 2.7; do mkdir -p $P/pinradar-research/versions/pages/$v && cp $SIG/pinradar-research/versions/$v/*.html $P/pinradar-research/versions/pages/$v/; done
cp $R/2.8/README_2.8.md $P/README.md
cp $R/REPORT_2.8.md $R/RESEARCH_REGISTER.md $R/2.8/PREREGISTRATION.md $P/
(cd $P && find . -type f ! -name SHA256SUMS.txt -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS.txt)
(cd $T && rm -f "$OUTDIR/pinradar-2.8.zip" && python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'pinradar-2.8')" "$OUTDIR/pinradar-2.8" "$T")
rm -rf $T
ls -la "$OUTDIR/pinradar-2.8.zip"
