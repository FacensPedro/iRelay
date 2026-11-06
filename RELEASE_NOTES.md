## What's Changed
- Reduced simultaneous USB writes to avoid overwhelming the connected iPhone or iPad during large Steam installations.
- Extended the recovery cooldown after a connection reset and reduced the number of buffered chunks during USB congestion.
- Improved diagnostics when iDeck stops polling a running Steam transfer.
- Suppressed duplicate recoverable USB warning stack traces and routine per-chunk cancellation messages.
- Retained authenticated Steam CDN downloads, SHA-1 verification, already installed game data, and the existing download-and-transfer pipeline.
