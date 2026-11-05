## What's Changed
- Improved recovery when Steam content servers return HTTP 503 or other temporary errors.
- Added automatic CDN server rotation and bounded retry delays to keep game downloads progressing.
- Reduced repeated requests to overloaded Steam servers while preserving download verification and transfer integrity.
- Added regression tests for Steam CDN outages and safe handling of server authorization.
