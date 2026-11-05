## What's Changed
- Improved USB transfer throughput by reusing persistent connections to iDeck.
- Added a bounded connection pool for concurrent Steam chunk writes.
- Streamed large file uploads with backpressure and lower memory overhead.
- Closed inactive USB connections automatically when switching or disconnecting devices.
