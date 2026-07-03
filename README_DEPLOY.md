# BTC v74.1 BRTIReplica

Backend uses a 3-tier automatic data hierarchy:
1. Licensed/fresh CF BRTI public page if it is fresh enough.
2. Public L1 order-book midpoint replica from constituent-like venues, calibrated to delayed CF BRTI when available.
3. DATA_NOT_USABLE if replica quality is insufficient.

Important: without licensed CF WebSocket/API credentials, this is not the official settlement feed. It is the closest automatic, no-manual-input approximation with hard quality labels.
