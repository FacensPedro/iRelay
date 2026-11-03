'use strict';
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

const MANIFESTS = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');

/// The Epic Games Launcher's installs, from its manifest (.item) files.
class Epic {
  installed() {
    const result = {};
    let names = [];
    try { names = fs.readdirSync(MANIFESTS); } catch { return result; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.item')) continue;
      let item;
      try { item = JSON.parse(fs.readFileSync(path.join(MANIFESTS, name), 'utf8')); } catch { continue; }
      if (!item.AppName || !item.InstallLocation) continue;
      result[item.AppName] = {
        appName: item.AppName,
        title: item.DisplayName || item.AppName,
        namespace: item.CatalogNamespace || '',
        catalogItemId: item.CatalogItemId || '',
        folder: item.InstallLocation,
        buildVersion: item.AppVersionString || '',
        launchExe: String(item.LaunchExecutable || '').replace(/\\/g, '/'),
        launchCommand: item.LaunchCommand || '',
        installBytes: Number(item.InstallSize || 0),
        canRunOffline: item.bCanRunOffline !== false,
        requiresOwnershipToken: String(item.OwnershipToken || 'false').toLowerCase() === 'true',
        complete: !item.bIsIncompleteInstall && fs.existsSync(item.InstallLocation),
      };
    }
    return result;
  }

  install(game) {
    const id = encodeURIComponent(`${game.namespace}:${game.catalogItemId}:${game.appName}`);
    return shell.openExternal(`com.epicgames.launcher://apps/${id}?action=install&silent=true`);
  }
}

module.exports = new Epic();
