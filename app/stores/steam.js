'use strict';
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const vdf = require('../vdf');
const system = require('../system');

/// Valve's Steam client on this PC: where it is, its library folders, the
/// games and DLC it has installed. iRelay requires it to be running: games
/// are installed on the PC by Steam itself (steam://install).
class Steam {
  constructor() {
    this.root = null;
  }

  async locate() {
    if (this.root && fs.existsSync(this.root)) return this.root;
    const keys = await system.registry('HKCU\\Software\\Valve\\Steam');
    const values = Object.values(keys)[0] || {};
    let root = values.SteamPath && values.SteamPath.replace(/\//g, '\\');
    if (!root || !fs.existsSync(root)) {
      const machine = await system.registry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam');
      root = (Object.values(machine)[0] || {}).InstallPath;
    }
    this.root = root && fs.existsSync(root) ? root : null;
    return this.root;
  }

  isRunning() {
    return system.isRunning('steam.exe');
  }

  open() {
    return shell.openExternal('steam://open/main');
  }

  async libraries() {
    const root = await this.locate();
    if (!root) return [];
    const folders = new Set([path.join(root, 'steamapps')]);
    try {
      const data = vdf.parse(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
      const list = vdf.get(data, 'libraryfolders') || {};
      for (const entry of Object.values(list)) {
        const folder = typeof entry === 'string' ? entry : vdf.get(entry, 'path');
        if (folder) folders.add(path.join(folder.replace(/\\\\/g, '\\'), 'steamapps'));
      }
    } catch { /* only the main library */ }
    return [...folders].filter((folder) => fs.existsSync(folder));
  }

  /// Installed apps by app ID: { appId, name, installDir, folder, acfPath,
  /// complete, buildId, sizeOnDisk, dlc: [installed DLC app IDs], progress }.
  async installed() {
    const result = {};
    for (const library of await this.libraries()) {
      let names = [];
      try { names = fs.readdirSync(library); } catch { continue; }
      for (const name of names) {
        const match = /^appmanifest_(\d+)\.acf$/.exec(name);
        if (!match) continue;
        const acfPath = path.join(library, name);
        let state;
        try { state = vdf.get(vdf.parse(fs.readFileSync(acfPath, 'utf8')), 'AppState'); } catch { continue; }
        if (!state) continue;
        const installDir = vdf.get(state, 'installdir') || '';
        const flags = Number(vdf.get(state, 'StateFlags') || 0);
        const depots = vdf.get(state, 'InstalledDepots') || {};
        const dlc = Object.values(depots).map((depot) => Number(vdf.get(depot, 'dlcappid') || 0)).filter(Boolean);
        const toDownload = Number(vdf.get(state, 'BytesToDownload') || 0);
        const downloaded = Number(vdf.get(state, 'BytesDownloaded') || 0);
        result[match[1]] = {
          appId: Number(match[1]),
          name: vdf.get(state, 'name') || `App ${match[1]}`,
          installDir,
          folder: path.join(library, 'common', installDir),
          acfPath,
          // 4: fully installed; other flags: downloading, staging, updating.
          complete: flags === 4 && installDir !== '',
          buildId: vdf.get(state, 'buildid') || '',
          sizeOnDisk: Number(vdf.get(state, 'SizeOnDisk') || 0),
          dlc: [...new Set(dlc)],
          progress: toDownload > 0 ? Math.min(1, downloaded / toDownload) : (flags === 4 ? 1 : 0),
        };
      }
    }
    return result;
  }

  /// Asks Steam to install a game or one of its DLC.
  install(appId) {
    return shell.openExternal(`steam://install/${appId}`);
  }
}

module.exports = new Steam();
