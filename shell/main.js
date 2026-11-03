'use strict';
// iRelay's fixed entry point. The application itself lives in an asar archive:
// the one shipped with this build (../app) or a newer one the updater
// downloaded into %APPDATA%\iRelay\versions. Updating replaces only that
// archive, so no installer is ever needed.
const { app } = require('electron');
const path = require('path');
const fs = require('original-fs');

app.setName('iRelay');
app.setAppUserModelId('com.facenspedro.irelay');

const bundledRoot = path.join(__dirname, '..', 'app');
const bundledVersion = require('../package.json').version;

function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

function newestUpdate() {
  const dir = path.join(app.getPath('userData'), 'versions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const found = names
    .map((name) => /^app-(\d+\.\d+\.\d+)\.asar$/.exec(name))
    .filter(Boolean)
    .map((match) => ({ version: match[1], file: path.join(dir, match[0]) }))
    .filter((entry) => compare(entry.version, bundledVersion) > 0)
    .sort((a, b) => compare(b.version, a.version));
  return found[0] || null;
}

const update = newestUpdate();
global.irelay = { bundledRoot, bundledVersion, version: bundledVersion, root: bundledRoot };
if (update) {
  try {
    global.irelay.version = update.version;
    global.irelay.root = update.file;
    require(path.join(update.file, 'main.js'));
  } catch (error) {
    // A damaged download: remove it and start the shipped version.
    try { fs.unlinkSync(update.file); } catch { /* ignore */ }
    global.irelay.version = bundledVersion;
    global.irelay.root = bundledRoot;
    require(path.join(bundledRoot, 'main.js'));
  }
} else {
  require(path.join(bundledRoot, 'main.js'));
}
