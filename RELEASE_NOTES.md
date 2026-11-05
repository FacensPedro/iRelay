## What's Changed
- Hardened Steam chunk validation for AES-256 keys and checksums.
- Restricted Steam downloads to verified HTTPS content servers.
- Limited concurrent download buffers and decoder workers to reduce memory and CPU usage.
- Removed the local TCP listener for download processing and restricted access to USB connections.
- Removed connected-device information from About.
