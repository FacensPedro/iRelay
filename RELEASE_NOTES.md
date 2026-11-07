## What's Changed
- Fixed pairing with iDeck: the address and pairing code typed in the Connect to iDeck form were cleared before being sent.
- Typed values and the cursor now stay in place while the connection status updates.
- Pairing now waits for the connection check in progress, so a correct code is no longer reported as a failure.
- iRelay stops reconnecting with a code iDeck refused, instead of locking itself out for a minute, and asks for the new code.
- A paired iPad is found again automatically when the network gives it a new address (requires iDeck 1.2.1).
- Updated the Windows installer and in-app update package to version 3.7.2.
