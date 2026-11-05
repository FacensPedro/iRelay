'use strict';
// iRelay's fixed entry point. Only application code bundled with this
// installed Electron executable may run. Older versions downloaded an ASAR
// overlay; those overlays are obsolete and must not override updated Node,
// native DLLs, USB drivers, Electron or shell files. Full upgrades use NSIS.
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

// A legacy app-*.asar cache is never executed by this full-installer build.
const legacy = path.join(app.getPath('userData'), 'versions');
try {
  for (const name of fs.readdirSync(legacy)) {
    if (/^app-\d+\.\d+\.\d+\.asar(?:\.part)?$/.test(name)) {
      try { fs.unlinkSync(path.join(legacy, name)); } catch { /* in-use cache */ }
    }
  }
} catch { /* no legacy updates */ }

global.irelay = { bundledRoot, bundledVersion, version: bundledVersion, root: bundledRoot };
try {
  require(path.join(bundledRoot, 'main.js'));
} catch (error) {
  fatal(error);
  app.exit(1);
}
