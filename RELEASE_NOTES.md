## What's Changed
- Shipped a fresh Electron 42 Windows executable with embedded Node.js 24, not just an application archive.
- Warned users running an older executable to install the new Windows package so the Node.js runtime is actually updated.
- Prevented transient USB socket errors from opening misleading fatal startup dialogs.
- Reduced iDeck USB requests after connection failures and gradually restored concurrency after recovery.
- Retried already-verified Steam chunks for longer with backoff, preventing a burst of simultaneous reconnection attempts.
- Reduced USB health and transfer polling while Steam chunks are being written.
- Added regression tests for USB recovery and packaged runtime verification.
