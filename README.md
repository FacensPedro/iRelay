# iRelay

iRelay is a Windows companion for [iDeck](https://github.com/FacensPedro/iDeck). It installs your **Steam**, **Epic Games** and **GOG** games on your PC with their own launchers and copies them into iDeck on your iPad over a **USB cable**.

## Features

- **Your libraries:** iRelay shows the Steam, Epic Games and GOG libraries iDeck is signed in to, and marks which games are on the PC and which are on the iPad.
- **Install and copy:** choose a game and iRelay installs it on the PC with Steam, the Epic Games Launcher or GOG Galaxy. When the install finishes, iRelay copies it into the right iDeck folder, and the game shows up in iDeck as installed.
- **DLC:** for Steam games that are already installed on the PC, you can install a DLC and copy just its files to the iPad.
- **Updates:** copying a game that is already on the iPad sends only the files that changed. Files that exist only on the iPad, such as saves and settings, are never deleted.
- **Download relay:** when you start a Steam download in iDeck itself, the PC downloads the same pieces at its own speed. The iPad takes each piece over the cable as soon as it arrives.
- **Automatic updates:** each time it starts, iRelay checks GitHub Releases and switches to the newest version. You never need to run an installer.

## Requirements

- Windows 10 or 11 (64-bit).
- The **Steam client running** on the PC. iRelay waits until Steam is open.
- The **Apple Devices** app (Microsoft Store) or **iTunes**. iRelay uses Apple's device service to reach the iPad over USB.
- **Epic Games Launcher** for Epic games and **GOG Galaxy** for GOG games.
- iDeck with **Settings › Steam › iRelay** turned on.

## Getting started

1. Download `iRelay-<version>-win-x64.zip` from [Releases](../../releases) and extract it anywhere you like, for example `Documents\iRelay`.
2. Start Steam, then run `iRelay.exe`.
3. Connect the iPad with a USB cable, unlock it and tap **Trust**.
4. In iDeck, open **Settings › Steam › iRelay** and turn on **Use iRelay (USB cable)**.
5. In iRelay, pick a game and choose **Install and copy to iPad**.

Keep iDeck open on the iPad while a copy is running, because iPadOS pauses apps in the background.

## How it works

iPadOS doesn't allow apps to open network connections over USB, so iRelay starts every connection itself. It goes through Apple's usbmux service (`127.0.0.1:27015`) to ports on the iPad where iDeck listens. These ports are only reachable from a PC the iPad trusts.

| iPad port | Purpose |
|---|---|
| 27093 | iDeck's service: libraries, file listings, file uploads and install records |
| 27091 | Connections iDeck uses to fetch download pieces from iRelay's local server (`127.0.0.1:27090`) |

Games are copied into the folders iDeck uses for each store, inside its Windows drive (`drive_c`):

| Store | Folder in iDeck | Install record |
|---|---|---|
| Steam | `Program Files (x86)/Steam/steamapps/common/<installdir>` | `appmanifest_<appid>.acf`, plus DLC records |
| Epic Games | `Program Files/Epic Games/<folder>` | iDeck's Epic install record |
| GOG | `GOG Games/<folder>` | The game's `goggame-<id>.info` |

## Antivirus

iRelay is built so that Microsoft Defender has nothing suspicious to flag:

- **Unmodified Electron:** it is a standard Electron app (Node.js 20) shipped as a plain folder, with no self-extracting archive and no installer.
- **Visible behaviour:** it changes no system settings, adds no antivirus exclusions and runs no hidden scripts. It only reads Steam's, Epic's and GOG's install records and the registry keys that point to them (`reg query`), and checks whether Steam is running (`tasklist`).
- **Verified updates:** updates are downloaded only from this repository's releases and checked against a SHA-256 checksum before use.

If SmartScreen warns about an unknown publisher, choose **More info › Run anyway**. Builds are not code-signed yet.

## Building

Requires Node.js 20.

```
npm ci
npm run check
npm run build
```

`dist/iRelay-win32-x64` is the program folder. `dist/app-<version>.asar` (with its `.sha256`) is the archive the updater downloads. Raising `version` in `package.json` on `main` publishes a new release automatically.

## License

MIT
