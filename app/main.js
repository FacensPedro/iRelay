'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const usbmux = require('./usbmux');
const device = require('./device');
const lockdown = require('./lockdown');
const fs = require('fs');
const updater = require('./updater');
const Relay = require('./relay');
const Processor = require('./process');

const VERSION = (global.irelay && global.irelay.version) || app.getVersion();
const log = global.irelayLog || (() => {});
const SMOKE = process.argv.includes('--smoke-test');

if (!SMOKE && !app.requestSingleInstanceLock()) {
  log('another iRelay is running; focusing it');
  app.quit();
} else {
  nativeTheme.themeSource = 'dark';

  let window = null;
  const state = {
    version: VERSION,
    boot: 'Starting…',
    update: { busy: false, message: '' },
    ready: false,
    cable: { status: 'searching', message: 'Looking for a connected device…', device: null },
    devices: [],
    selected: null,
    library: null,
    libraryError: null,
    installs: [],   // iDeck's own downloads (GET /installs)
    jobs: [],       // Steam downloads this PC processes for iDeck
    dlcQueue: {},   // appId -> DLC to install once the game is on the device
  };
  let deviceId = null;
  let relay = null;
  let processor = null;

  function push() {
    if (window && !window.isDestroyed()) window.webContents.send('state', state);
  }

  function createWindow() {
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 980,
      minHeight: 640,
      backgroundColor: '#000000',
      title: 'iRelay',
      show: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#000000', symbolColor: '#a1a1aa', height: 40 },
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.setMenuBarVisibility(false);
    window.once('ready-to-show', () => window.show());
    // Never stay invisible: show after a few seconds even if the page is slow.
    setTimeout(() => { if (window && !window.isDestroyed() && !window.isVisible()) window.show(); }, 4000);
    window.webContents.on('render-process-gone', (_, details) => log(`renderer gone: ${details.reason}`));
    window.webContents.on('did-fail-load', (_, code, text) => log(`page failed to load: ${code} ${text}`));
    // Electron 42: one event object (level 'warning' / 'error').
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') log(`page: ${event.message}`);
    });
    window.webContents.on('did-finish-load', () => {
      log('window loaded');
      if (SMOKE) setTimeout(() => { log('smoke test passed'); app.exit(0); }, 5000);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.loadFile(path.join(__dirname, 'ui', 'index.html'));
  }

  function libraryGame(store, id) {
    const list = state.library && state.library[store] && state.library[store].games;
    if (!list) return null;
    if (store === 'steam') return list.find((game) => game.appId === id);
    if (store === 'gog') return list.find((game) => game.id === id);
    return list.find((game) => game.appName === id);
  }

  /// DLC chosen with a game: installed one at a time once the game is on the device.
  async function runDLCQueue() {
    for (const [key, list] of Object.entries(state.dlcQueue)) {
      const appId = Number(key);
      if (!list.length) { delete state.dlcQueue[key]; continue; }
      const busy = state.installs.some((item) => item.store === 'steam' && Number(item.id) === appId && !item.error);
      const game = libraryGame('steam', appId);
      if (busy || !game || !game.installed) continue;
      const dlcId = list.shift();
      try {
        await device.install(deviceId, { store: 'steam', appId, dlcId });
        log(`DLC ${dlcId} of ${game.name} started after the game`);
      } catch (error) {
        log(`DLC ${dlcId} of ${game.name}: ${error.message}`);
      }
      return;
    }
  }

  async function pollInstalls() {
    if (processor) state.jobs = processor.list();
    if (!deviceId) { state.installs = []; push(); return; }
    try {
      const wasActive = state.installs.some((item) => item.phase !== 'failed');
      state.installs = (await device.installs(deviceId)).installs || [];
      // A download just ended: the library shows it installed.
      if (wasActive && !state.installs.some((item) => item.phase !== 'failed')) await refreshLibrary();
      if (Object.keys(state.dlcQueue).length) await runDLCQueue();
    } catch { /* next poll */ }
    push();
  }

  // Devices as iloader finds them: usbmuxd's list, the pair record (Trust)
  // and lockdownd's name, model and iOS version; then iDeck's own service.
  const known = new Map(); // usbmux id -> lockdown info
  const choiceFile = path.join(app.getPath('userData'), 'device.json');
  let chosen = null;
  try { chosen = JSON.parse(fs.readFileSync(choiceFile, 'utf8')).udid || null; } catch { /* first start */ }

  async function pollCable() {
    try {
      const found = await usbmux.listDevices();
      const devices = [];
      for (const entry of found) {
        // lockdownd answers these values even before Trust; iDeck's service
        // only once the device trusts this PC.
        let info = known.get(entry.id);
        if (!info) {
          try { info = await lockdown.deviceInfo(entry.id); known.set(entry.id, info); } catch { info = null; }
        }
        let ideck = null;
        try { ideck = await device.info(entry.id); } catch { ideck = null; }
        const trusted = !!ideck || await usbmux.hasPairRecord(entry.serial);
        devices.push({ id: entry.id, udid: entry.serial, trusted, ...(info || { name: 'Device', model: 'Device' }), ideck });
      }
      for (const id of [...known.keys()]) if (!found.some((entry) => entry.id === id)) known.delete(id);
      state.devices = devices.map(({ id, ...rest }) => rest);
      const current = devices.find((entry) => entry.udid === chosen) || devices.find((entry) => entry.ideck) || devices[0];
      state.selected = current ? current.udid : null;
      if (!current) {
        deviceId = null;
        state.cable = { status: 'none', message: 'Connect a device with a USB cable.', device: null };
      } else if (!current.trusted) {
        deviceId = null;
        state.cable = { status: 'waiting', message: `Unlock ${current.name === 'Device' ? 'the device' : current.name} and tap Trust.`, device: null };
      } else if (!current.ideck) {
        deviceId = null;
        state.cable = { status: 'waiting', message: `Open iDeck on ${current.name}.`, device: { name: current.name, model: current.model, iosVersion: current.iosVersion } };
      } else {
        const first = deviceId !== current.id;
        deviceId = current.id;
        state.cable = {
          status: 'connected', message: `Connected to ${current.name}`,
          device: { ...current.ideck, name: current.name, model: current.model, iosVersion: current.iosVersion },
        };
        if (first) { state.library = null; refreshLibrary(); } else if (!state.library) refreshLibrary();
        relay.tunnels(devices.filter((entry) => entry.ideck)).catch(() => {});
      }
    } catch {
      deviceId = null;
      state.devices = [];
      state.cable = {
        status: 'service', device: null,
        message: 'Install iTunes (or the Apple Devices app) so iRelay can reach devices over USB, as iloader does.',
      };
    }
    push();
  }

  let loadingLibrary = false;
  async function refreshLibrary() {
    if (!deviceId || loadingLibrary) return;
    loadingLibrary = true;
    try {
      state.library = await device.library(deviceId);
      state.libraryError = null;
    } catch (error) {
      state.libraryError = error.message;
    }
    loadingLibrary = false;
    push();
  }

  function every(ms, fn) {
    const loop = async () => { await fn(); setTimeout(loop, ms); };
    loop();
  }

  // MARK: IPC

  ipcMain.handle('state', () => state);
  ipcMain.handle('refresh', () => refreshLibrary());
  ipcMain.handle('openExternal', (_, url) => (/^https:\/\//.test(url) ? shell.openExternal(url) : null));
  ipcMain.handle('steamDLC', async (_, appId) => {
    if (!deviceId) return [];
    const result = await device.steamDLC(deviceId, appId);
    const game = libraryGame('steam', appId);
    if (game) game.dlc = result.dlc || [];
    push();
    return result.dlc || [];
  });
  // Installs run in iDeck: nothing is installed on Windows. Steam downloads
  // come back here to be processed (POST /process from iDeck, process.js).
  ipcMain.handle('install', async (_, request) => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    const body = { store: request.store };
    if (request.store === 'steam') {
      body.appId = Number(request.appId);
      if (request.dlcId) body.dlcId = Number(request.dlcId);
    } else if (request.store === 'gog') body.id = Number(request.id);
    else body.appName = request.appName;
    await device.install(deviceId, body);
    log(`install started on the device: ${request.title || body.appId || body.id || body.appName}`);
    if (request.store === 'steam' && Array.isArray(request.withDLC) && request.withDLC.length) {
      state.dlcQueue[body.appId] = request.withDLC.map(Number);
    }
    setTimeout(pollInstalls, 500);
  });
  // Bugs: iRelay's own log, and iDeck's (read from the device over the cable).
  ipcMain.handle('irelayBugs', () => {
    let text = '';
    try {
      // Only this run: problems an earlier version logged (and fixed since) stay out.
      const all = fs.readFileSync(path.join(app.getPath('userData'), 'irelay.log'));
      text = all.subarray(Math.min(global.irelayLogOffset || 0, all.length)).toString('utf8');
    } catch { /* none yet */ }
    const lines = text.split(/\r?\n/).filter(Boolean);
    const issues = [...new Set(lines.filter((line) => /fatal|error|failed|refused|could not|cannot|timeout/i.test(line)
      && !/another iRelay is running|update check skipped/i.test(line))
      .map((line) => line.replace(/^\S+Z /, '')))].reverse().slice(0, 300);
    for (const item of state.installs) if (item.error) issues.unshift(`${item.title}: ${item.error}`);
    return { issues, log: lines.slice(-300).join('\n') };
  });
  // Clear: iRelay's log (this run's lines start again) and iDeck's logs on the device.
  ipcMain.handle('clearIrelayBugs', () => {
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'irelay.log'), ''); } catch { /* none */ }
    global.irelayLogOffset = 0;
    state.installs = state.installs.filter((item) => !item.error);
  });
  ipcMain.handle('clearIdeckBugs', async () => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    await device.clearLogs(deviceId);
  });
  ipcMain.handle('ideckBugs', async () => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    return device.logs(deviceId);
  });
  // The Update button: the same update as at start, then a restart into it.
  ipcMain.handle('openFolder', (_, which) => {
    const folder = which === 'program' ? path.dirname(process.execPath) : app.getPath('userData');
    return shell.openPath(folder);
  });
  ipcMain.handle('checkUpdate', async () => {
    if (state.update.busy) return;
    state.update = { ...state.update, busy: true, message: 'Checking for updates…' };
    push();
    try {
      const result = await updater.check(VERSION, (text) => { state.update.message = text; push(); });
      if (result.installed) {
        state.update.message = `Restarting into iRelay ${result.installed}…`;
        push();
        log(`updated to ${result.installed} (Update button); restarting`);
        setTimeout(() => updater.restart(), 800);
        return;
      }
      state.update = { ...state.update, busy: false, message: `iRelay ${VERSION} is the latest version.` };
    } catch (error) {
      log(`update failed: ${error.message}`);
      state.update = { ...state.update, busy: false, message: error.message };
    }
    push();
  });


  // MARK: Start

  app.whenReady().then(async () => {
    createWindow();
    const status = (text) => { state.boot = text; push(); };
    log(`iRelay ${VERSION} ready`);
    if (app.isPackaged && !SMOKE) {
      try {
        const result = await updater.check(VERSION, status);
        if (result.installed) {
          status(`Restarting into iRelay ${result.installed}…`);
          log(`updated to ${result.installed}; restarting`);
          setTimeout(() => updater.restart(), 600);
          return;
        }
      } catch (error) {
        // Offline or GitHub unreachable: start this version.
        log(`update check skipped: ${error.message}`);
        state.update.message = error.message;
      }
    }
    // Not 'cache': on Windows that is Chromium's own Cache folder (names ignore case).
    processor = new Processor({
      write: (root, file, offset, size, sha, data) => {
        if (!deviceId) return Promise.reject(new Error('device not connected'));
        return device.write(deviceId, root, file, offset, size, sha, data);
      },
      onChange: push,
      log,
    });
    relay = new Relay(processor, log);
    try { relay.start(); } catch (error) { log(`relay not started: ${error.message}`); }
    // A GitHub token saved by iRelay 2.3-3.2 is no longer used: removed.
    try { fs.unlinkSync(path.join(app.getPath('userData'), 'github-token.bin')); } catch { /* none */ }
    state.ready = true;
    state.boot = '';
    every(2000, pollCable);
    // The device's library again every 30 s, so games copied earlier or
    // installed in iDeck itself show up without a reconnect.
    every(30000, () => (deviceId ? refreshLibrary() : null));
    every(2000, pollInstalls);
    push();
  });

  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
}
