# iRelay

iRelay is a Windows companion for [iDeck](https://github.com/FacensPedro/iDeck). Connect your device with a **USB cable** and pick a Steam, Epic Games or GOG game. It goes straight into iDeck. Nothing is installed on Windows.

## Features

- **Your libraries:** iRelay shows the Steam, Epic Games and GOG libraries iDeck is signed in to, and marks what is already on the device.
- **Install on device:** choose a game, and tick any of its Steam DLC to install right after it, or add DLC to a game already on the device. iDeck starts the download.
- **Steam processed on the PC:** iRelay downloads encrypted Steam chunks over verified HTTPS, decrypts them using Steam's AES-256 format, validates their manifest checksums, decompresses them, and transfers them to iDeck. The device verifies chunks again and retries failures. Steam's AES-256-CBC/SHA-1 format is fixed by Steam and cannot be replaced with another cipher without breaking compatibility.
- **USB-only local service:** iRelay no longer listens on a Windows TCP port for chunk processing. It accepts requests only through the USB connections provided by the trusted device. The USB protocol is not end-to-end TLS encrypted; this change reduces local attack surface and requires no iDeck protocol change.
- **Faster USB file transfers:** a bounded pool of up to eight persistent USB connections now carries Steam chunk writes and file uploads, avoiding one usbmux handshake per request. Large files stream with backpressure and 256 KiB read buffers instead of allocating whole files in memory. Actual speed depends on the cable, device and storage; no hardware throughput has been verified.
- **Epic Games and GOG:** iDeck downloads these itself. When connected, iRelay measures the latency of the official CDN hosts and helps iDeck choose their order.
- **Bugs:** **iRelay bugs** lists this run's problems. **iDeck bugs** reads the ones iDeck found on the device. **Clear** empties either log.
- **Download acceleration:** enable **Accelerate downloads** under **Settings** to use a bounded adaptive queue (32–64 simultaneous Steam requests) and at most four CPU decoder workers. In-flight chunk allocations are budgeted to approximately 96 MiB, with no artificial bandwidth cap. Official CDN servers are ranked by latency and accessed only over verified HTTPS. The throughput target is up to 100 MB/s where the network, server, USB connection and iDeck storage permit it; this rate has not been measured on a real device.
- **Clear unused cache:** in **Settings**, choose **Clear** under **Unused cache** to remove cached images, incomplete update downloads and older update archives. iRelay shows the space freed, preserves the running version and the newest downloaded update, and keeps settings, libraries and active Steam transfers. Cleanup waits until any update has finished.
- **Updates:** iRelay updates itself at start, or from **Update iRelay**, without running the installer again.
- **Folders:** **About** opens iRelay's data folder (log, updates, settings) and its program folder.

## Requirements

- Windows 10 or 11 (64-bit).
- **iTunes** or the **Apple Devices** app. iRelay reaches the device over USB through Apple's device service, the same way [iloader](https://github.com/nab138/iloader) does.
- iDeck on the device, open. It connects by itself; there is nothing to turn on.

## Getting started

1. Download `iRelay-<version>-win-x64.zip` from [Releases](../../releases), take `iRelay-Setup.exe` out of it and run it. Windows asks for administrator rights once.
2. Start iRelay from the desktop or the Start menu.
3. Connect the device with a USB cable, unlock it, tap **Trust** and open iDeck.
4. Pick a game and choose **Install on device**.

Keep iDeck open while a game downloads, because iOS and iPadOS pause apps in the background.

## How it works

iRelay connects the way [iloader](https://github.com/nab138/iloader) does (through the [idevice](https://github.com/jkcoxson/idevice) crate):

1. **usbmuxd** lists the devices connected by USB.
2. **The pair record** shows whether the device trusts this PC.
3. **lockdownd** gives the device's name, model and iOS version.
4. **iDeck's ports:** iRelay connects to the ports where iDeck listens.

| Device port | Purpose |
|---|---|
| 62078 | lockdownd: device name, model and iOS version |
| 27093 | iDeck's service: libraries, starting installs, writing chunks (`PUT /write`), logs |
| 27091 | Connections iDeck uses to reach iRelay's local server (`127.0.0.1:27090`): `POST /process` hands over a Steam download |

## Antivirus

The installer adds iRelay's install folder (by default `C:\Program Files\iRelay`) to Microsoft Defender Antivirus' exclusions, so Defender does not scan or quarantine iRelay's own files. Uninstalling iRelay removes the exclusion. Nothing else is excluded, and nothing else on the PC is changed.

Defender can still check the installer itself before it runs. Code signing removes that warning: add the repository secrets `WIN_CSC_LINK` (the base64 of a code-signing `.pfx`) and `WIN_CSC_KEY_PASSWORD`, and every build is signed. If SmartScreen warns about an unknown publisher, choose **More info › Run anyway**. If Defender flags a release, submit it at <https://www.microsoft.com/wdsi/filesubmission> as a false positive.

## Updating

iRelay updates itself when it starts. **Update iRelay**, in the sidebar or in About, checks and updates at any time. Neither needs an installer: the new version is downloaded, verified and loaded on restart.

Updates need this repository to be public: GitHub does not publish a private repository's releases to programs.

## Building

Requires Node.js 24.

```
npm ci
npm run check
npm test
npm run build
```

`dist/iRelay.exe` is the program. `dist/app-<version>.asar` (with its `.sha256`) is the archive the updater downloads. Raising `version` in `package.json` on `main` publishes a new release automatically.

## License

MIT
