## What's Changed
- Changed in-app updates to install the complete Windows application, including Electron, Node.js, executable files and resources, instead of replacing only an ASAR archive.
- Added SHA-256 validation and archive verification before opening the official installer.
- Prevented application updates from interrupting active Steam USB transfers.
- Added adaptive USB backpressure to reduce buffered chunks when device transfers slow down, while keeping downloads and transfers concurrent.
- Added transfer diagnostics and regression coverage for the updater and USB pipeline.
