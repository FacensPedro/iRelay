# iRelay

iRelay is a Windows companion for [iDeck](https://github.com/FacensPedro/iDeck). Put the PC and the iPad on the same network, pair them once and pick a Steam, Epic Games or GOG game. It goes straight into iDeck. Nothing is installed on Windows.

## Features

- **Your libraries:** iRelay shows the Steam, Epic Games and GOG libraries iDeck is signed in to, and marks what is already on the device.
- **Install on device:** choose a game, and tick any of its Steam DLC to install right after it, or add DLC to a game already on the device. iDeck starts the download.
- **Steam processed on the PC:** iRelay downloads encrypted Steam chunks over verified HTTPS, decrypts them using Steam's AES-256 format, validates their manifest checksums, decompresses them, and transfers them to iDeck. The device verifies chunks again and retries failures. Steam's AES-256-CBC/SHA-1 format is fixed by Steam and cannot be replaced with another cipher without breaking compatibility.
- **Local network, paired:** iRelay talks to iDeck over Wi-Fi or Ethernet. Every request carries the 8-character pairing code shown in iDeck › Settings › iRelay; iDeck refuses a PC for a minute after five wrong codes. Nothing listens on the PC, so Windows Firewall needs no rule. The traffic is not TLS-encrypted: use it on a network you trust.
- **Persistent connections:** a bounded pool of keep-alive connections carries Steam chunk writes and file uploads. Large files stream with backpressure and 256 KiB read buffers instead of allocating whole files in memory. Actual speed depends on the network, device and storage.
- **EA app:** iRelay shows the EA library iDeck is signed in to. **Install on device** makes iDeck download the game from EA's servers; it starts on iDeck without the EA app (iDeck uses Madeira's EA support).
- **Epic Games and GOG:** iDeck downloads these itself. When connected, iRelay measures the latency of the official CDN hosts and helps iDeck choose their order.
- **Bugs:** **iRelay bugs** and **iDeck bugs** show issue counts, categorized diagnostics, and expandable logs with copy and clear controls.\n- **Stop and clean up:** stopping a Steam download waits for outstanding PC writes to finish before iDeck removes the incomplete game-owned files. Existing installed games and update data are preserved when not owned by the cancelled install.
- **Download acceleration:** enable **Accelerate downloads** under **Settings** to use a bounded adaptive queue (32–64 simultaneous Steam requests) and at most four CPU decoder workers. In-flight chunk allocations are budgeted to approximately 96 MiB, with no artificial bandwidth cap. Official CDN servers are ranked by latency and accessed only over verified HTTPS. The throughput target is up to 100 MB/s where the network, server and iDeck storage permit it; this rate has not been measured on a real device.
- **Clear unused cache:** in **Settings**, choose **Clear** under **Unused cache** to remove cached images, incomplete update downloads and older update archives. iRelay shows the space freed, preserves the running version and the newest downloaded update, and keeps settings, libraries and active Steam transfers. Cleanup waits until any update has finished.
- **Updates:** iRelay checks for new versions at startup. **Update iRelay** in About downloads and verifies the full Windows installer and asks for Windows approval, updating Electron, Node.js, native resources, and application code together. Downloads are not interrupted by automatic updates.
- **Folders:** **About** opens iRelay's data folder (log, updates, settings) and its program folder.

## Requirements

- Windows 10 or 11 (64-bit).
- The PC and the iPad on the same local network (Wi-Fi or Ethernet).
- iDeck on the device, open.

## Getting started

1. Download `iRelay-<version>-win-x64.zip` from [Releases](../../releases), take `iRelay-Setup.exe` out of it and run it. Windows asks for administrator rights once.
2. Start iRelay from the desktop or the Start menu.
3. On the iPad, open iDeck › **Settings › iRelay**: it shows the iPad's address and a pairing code.
4. In iRelay, choose **Find iPads on this network** (or type the address), enter the pairing code and choose **Pair**.
5. Pick a game and choose **Install on device**.

Keep iDeck open while a game downloads, because iOS and iPadOS pause apps in the background.

## How it works

iRelay finds iDeck by asking each address of the PC's private networks for `GET /info` on port 27093 (the only request answered without the pairing code), or uses the address you type. All connections go from the PC to the iPad:

| iPad port | Purpose |
|---|---|
| 27093 | iDeck's service: libraries, starting installs, writing chunks (`PUT /write`), logs. Header `X-iDeck-Code` |
| 27091 | Connections iDeck uses to reach iRelay (`POST /process` hands over a Steam download). Each starts with `IRELAY <code>` |

## Antivirus

The installer adds iRelay's install folder (by default `C:\Program Files\iRelay`) to Microsoft Defender Antivirus' exclusions, so Defender does not scan or quarantine iRelay's own files. Uninstalling iRelay removes the exclusion. Nothing else is excluded, and nothing else on the PC is changed.

Defender can still check the installer itself before it runs. Code signing removes that warning: add the repository secrets `WIN_CSC_LINK` (the base64 of a code-signing `.pfx`) and `WIN_CSC_KEY_PASSWORD`, and every build is signed. If SmartScreen warns about an unknown publisher, choose **More info › Run anyway**. If Defender flags a release, submit it at <https://www.microsoft.com/wdsi/filesubmission> as a false positive.

## Updating

iRelay checks for updates on startup without changing the installed program. Choose **Update iRelay** in **About** to download the complete Windows installer, validate the published ZIP's SHA-256, and open it. Approve the Windows installer prompt to replace all app, Electron/Node.js, executable and resource files. Active Steam transfers must finish or be paused before an update. Older ASAR-only overlays are ignored by updated executables.

Updates need this repository to be public: GitHub does not publish a private repository's releases to programs.

## Building

Requires Node.js 24.

```
npm ci
npm run check
npm test
npm run build
```

`dist/iRelay-Setup.exe` is the complete installer. The release includes `iRelay-<version>-win-x64.zip` with a `.sha256` receipt. ASAR artifacts remain for compatibility with older clients but are **not** the update mechanism for current installations. Raising `version` in `package.json` on `main` publishes a new release after successful Windows verification.

## License

MIT

### Recovery during large Steam installs

A brief network interruption does not immediately drop a paired iDeck. The connection remains in recovery for up to 45 seconds, Steam writes retry transient errors, and iRelay waits up to 90 seconds without a progress poll before abandoning a PC-side processing job. Reopening iDeck after an iOS process exit may allow installation to resume using the existing Steam journals; this does not guarantee that iOS will retain the process under critical memory pressure. The PC-side in-flight buffer budget is approximately 64 MiB, and at most four device-side HTTP requests run at once.
