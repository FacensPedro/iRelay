## What's Changed
- Fixed transient USB failures that incorrectly marked iDeck as disconnected during Steam transfers.
- Added automatic recovery after Apple Mobile Device Service timeouts and iDeck restarts.
- Prevented overlapping USB tunnel reconnection attempts and uncaught socket-error dialogs.
- Retried interrupted Steam chunk writes instead of immediately falling back to downloading the remaining game on iDeck.
- Reduced USB transfer memory pressure with smaller concurrent chunk budgets and fewer active device connections.
