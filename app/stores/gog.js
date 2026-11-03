'use strict';
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const system = require('../system');

/// GOG games installed on this PC (GOG Galaxy or offline installers), from
/// the registry entries GOG's installers write.
class GOG {
  async installed() {
    const result = {};
    const keys = {
      ...(await system.registry('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', true)),
      ...(await system.registry('HKLM\\SOFTWARE\\GOG.com\\Games', true)),
    };
    for (const [key, values] of Object.entries(keys)) {
      const match = /\\Games\\(\d+)$/i.exec(key);
      const folder = values.path || values.PATH;
      if (!match || !folder || !fs.existsSync(folder)) continue;
      // Only the game itself, not its DLC entries (they share the folder).
      const id = Number(match[1]);
      const info = path.join(folder, `goggame-${id}.info`);
      if (!fs.existsSync(info)) continue;
      let root = id;
      try { root = Number(JSON.parse(fs.readFileSync(info, 'utf8')).rootGameId || id); } catch { /* keep */ }
      if (root !== id) continue;
      result[id] = { id, title: values.gameName || values.GAMENAME || `GOG ${id}`, folder, complete: true };
    }
    return result;
  }

  install(id) {
    return shell.openExternal(`goggalaxy://openGameView/${id}`);
  }
}

module.exports = new GOG();
