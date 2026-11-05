'use strict';
// iRelay's fixed entry point. The application itself lives in an asar archive:
// the one shipped with this build (../app) or a newer one the updater
// downloaded into %APPDATA%\iRelay\versions. Updating replaces only that
// archive, so no installer is ever needed.
const { app, dialog } = require('electron');
const path = require('path');
const fs = require('original-fs');

app.setName('iRelay');
app.setAppUserModelId('com.facenspedro.irelay');

// Everything that goes wrong at start is written to %APPDATA%\iRelay\irelay.log
// and shown, instead of iRelay silently not opening.
const logFile = path.join(app.getPath('userData'), 'irelay.log');
function log(line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch { /* nowhere to write */ }
}
global.irelayLog = log;
// USB sockets may close while iPadOS suspends the listener or usbmux
// reconnects. These errors are recoverable by the transfer scheduler; never
// show a blocking "could not start" dialog for one such socket.
function transientUSB(error) {
  const code = String(error?.code || '');
  if (['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTCONN', 'EREFUSED',
       'ERR_STREAM_PREMATURE_CLOSE'].includes(code)) return true;
  return /socket hang up|iDeck is not listening|iDeck USB service unavailable|usbmux timeout|usbmux refused|Apple Mobile Device connection closed|USB device disconnected|cable connection closed/i
    .test(String(error?.message || error));
}
function fatal(error) {
  const details = (error && error.stack) || String(error);
  if (transientUSB(error)) {
    log(`USB transport warning (recoverable): ${details}`);
    return;
  }
  log(`FATAL ${details}`);
  try { dialog.showErrorBox('iRelay could not start', `${details}\n\nLog: ${logFile}`); } catch { /* no UI */ }
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', (reason) => log(`unhandled rejection ${(reason && reason.stack) || reason}`));
// Where this run's lines begin: iRelay bugs lists only problems of this run.
try { global.irelayLogOffset = fs.statSync(logFile).size; } catch { global.irelayLogOffset = 0; }
log(`start ${process.argv.slice(1).join(' ')} electron=${process.versions.electron} node=${process.versions.node}`);

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
    log(`update ${update.version} failed to load: ${(error && error.stack) || error}`);
    try { fs.unlinkSync(update.file); } catch { /* ignore */ }
    global.irelay.version = bundledVersion;
    global.irelay.root = bundledRoot;
    require(path.join(bundledRoot, 'main.js'));
  }
} else {
  try {
    require(path.join(bundledRoot, 'main.js'));
  } catch (error) {
    fatal(error);
    app.exit(1);
  }
}
