'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme, dialog } = require('electron');
const usbmux = require('./usbmux');
const device = require('./device');
const lockdown = require('./lockdown');
const fs = require('fs');
const updater = require('./updater');
const Relay = require('./relay');
const Processor = require('./process');
const Settings = require('./settings');
const { clearUnusedCache } = require('./cache');
const settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));

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
    settings: { ...settings.value },
    boot: 'Starting…',
    update: { busy: false, message: '' },
    cache: { busy: false, result: null, error: '' },
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
      if (SMOKE) setTimeout(async () => {
        try {
          await window.webContents.executeJavaScript(`(async () => {
            const wait = async (check) => {
              for (let i = 0; i < 100; i++) {
                if (await check()) return;
                await new Promise(resolve => setTimeout(resolve, 100));
              }
              throw new Error('Settings smoke test timed out');
            };
            await wait(async () => (await irelay.state()).ready);
            document.querySelector('[data-view="settings"]').click();
            const toggle = () => document.getElementById('download-acceleration');
            if (!toggle()) throw new Error('Download acceleration button missing');
            const original = (await irelay.state()).settings.accelerateDownloads;
            toggle().click();
            await wait(async () => !toggle().disabled &&
              toggle().getAttribute('aria-checked') === String(!original) &&
              (await irelay.state()).settings.accelerateDownloads === !original);
            toggle().click();
            await wait(async () => !toggle().disabled &&
              toggle().getAttribute('aria-checked') === String(original) &&
              (await irelay.state()).settings.accelerateDownloads === original);
            const cleanup = document.getElementById('clear-unused-cache');
            if (!cleanup) throw new Error('Clear unused cache button missing');
            cleanup.click();
            await wait(async () => {
              const state = await irelay.state();
              return !state.cache.busy && !!state.cache.result;
            });
            document.querySelector('[data-view="steam"]').click();
          })()`);
          log('settings navigation, acceleration and cache cleanup smoke test passed');
          log('smoke test passed');
          app.exit(0);
        } catch (error) {
          log(`smoke test failed: ${error.message}`);
          app.exit(1);
        }
      }, 5000);
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
      const wasActive = state.installs.some((item) => item.phase !== 'failed' && item.phase !== 'paused');
      state.installs = (await device.installs(deviceId)).installs || [];
      // A download just ended: the library shows it installed.
      if (wasActive && !state.installs.some((item) => item.phase !== 'failed' && item.phase !== 'paused')) await refreshLibrary();
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
  let lastHealthyCable = null;
  let lastHealthyAt = 0;
  const CABLE_RECOVERY_GRACE_MS = 45000;

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
        // iDeck can temporarily stop accepting HTTP probes while receiving
        // Steam chunks or under memory pressure. Do not invalidate the USB
        // device ID on a single failed probe: this used to fail every active
        // chunk immediately with "device not connected".
        const recovering = lastHealthyCable &&
          current.udid === lastHealthyCable.udid &&
          current.id === lastHealthyCable.id &&
          Date.now() - lastHealthyAt < CABLE_RECOVERY_GRACE_MS;
        deviceId = recovering ? current.id : null;
        state.cable = {
          status: 'waiting',
          message: recovering
            ? 'iDeck connection interrupted — reconnecting over USB…'
            : `Open iDeck on ${current.name}.`,
          device: { name: current.name, model: current.model, iosVersion: current.iosVersion },
        };
        if (recovering) relay.tunnels([current]).catch(() => {});
      } else {
        const first = deviceId !== current.id;
        if (state.cable.status === 'waiting' && lastHealthyCable &&
            lastHealthyCable.id === current.id) log('iDeck USB service responded again');
        lastHealthyCable = { id: current.id, udid: current.udid };
        lastHealthyAt = Date.now();
        deviceId = current.id;
        state.cable = {
          status: 'connected', message: `Connected to ${current.name}`,
          device: { ...current.ideck, name: current.name, model: current.model, iosVersion: current.iosVersion },
        };
        if (first) { state.library = null; refreshLibrary(); } else if (!state.library) refreshLibrary();
        relay.tunnels(devices.filter((entry) => entry.ideck)).catch(() => {});
      }
    } catch (error) {
      // A temporary Apple Mobile Device Service timeout is not proof that the
      // iPad was unplugged. Preserve the last working transfer channel for a
      // bounded recovery window; a real disconnect will expire automatically.
      const recovering = deviceId != null && lastHealthyCable &&
        deviceId === lastHealthyCable.id &&
        Date.now() - lastHealthyAt < CABLE_RECOVERY_GRACE_MS;
      if (!recovering) deviceId = null;
      if (!recovering) state.devices = [];
      state.cable = {
        status: 'service', device: null,
        message: recovering
          ? 'Apple USB service is temporarily unavailable — retrying…'
          : 'Check Apple Mobile Device Service and reconnect the USB cable.',
      };
    }
    // Reclaim keep-alive USB transports when switching or unplugging devices.
    device.closeOtherConnections(deviceId);
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
  ipcMain.handle('setDownloadAcceleration', (_, enabled) => {
    state.settings = settings.setDownloadAcceleration(enabled);
    if (processor) processor.setAccelerated(enabled);
    log(`download acceleration ${enabled ? 'enabled' : 'disabled'}`);
    push();
    return state.settings;
  });
  ipcMain.handle('clearUnusedCache', async () => {
    if (!state.ready) throw new Error('Wait for iRelay to finish starting.');
    if (state.update.busy) throw new Error('Wait for the update to finish before clearing cache.');
    if (state.cache.busy) throw new Error('Cache cleanup is already running.');
    state.cache = { busy: true, result: null, error: '' };
    push();
    try {
      state.cache.result = await clearUnusedCache({
        session: window.webContents.session,
        userData: app.getPath('userData'),
        currentRoot: global.irelay && global.irelay.root,
      });
      log(`unused cache cleared: ${state.cache.result.freedBytes} bytes, ${state.cache.result.removedFiles} update files`);
      return state.cache.result;
    } catch (error) {
      state.cache.error = `Could not clear unused cache: ${error.message}`;
      throw new Error(state.cache.error);
    } finally {
      state.cache.busy = false;
      push();
    }
  });
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
  // iDeck owns each install. Stop halts PC-side writes before iDeck removes
  // only the incomplete files owned by this install; existing games remain safe.
  ipcMain.handle('controlDownload', async (_, control) => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    if (Number(state.cable.device?.protocol || 0) < 3) {
      throw new Error('Update iDeck to a version that supports download controls.');
    }
    const { store, action } = control || {};
    if (!['steam', 'epic', 'gog'].includes(store) ||
        !['pause', 'resume', 'stop'].includes(action)) {
      throw new Error('Invalid download control.');
    }
    const id = store === 'epic' ? String(control.id || '') : Number(control.id);
    if ((store === 'epic' && !id) || (store !== 'epic' && !Number.isSafeInteger(id))) {
      throw new Error('Invalid game ID.');
    }
    if (action === 'stop' && store === 'steam' && processor) {
      // Prevent a late PC-side /write from re-creating files after iDeck has
      // deleted the incomplete install. Pause the device first, drain writes,
      // and only then ask iDeck to discard its owned staged files.
      await device.controlDownload(deviceId, { store, id, action: 'pause' });
      await processor.cancelApp(id);
    }
    await device.controlDownload(deviceId, { store, id, action });
    if (store === 'steam' && action === 'stop') delete state.dlcQueue[id];
    log(`download ${action}: ${store} ${id}`);
    await pollInstalls();
    if (action === 'stop') await refreshLibrary();
    return { ok: true };
  });
  // Uninstall removes the game (or one DLC) from iDeck's drive.
  ipcMain.handle('uninstall', async (_, request) => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    const body = { store: request.store };
    if (request.store === 'steam') {
      body.appId = Number(request.appId);
      if (request.dlcId) body.dlcId = Number(request.dlcId);
    } else if (request.store === 'gog') body.id = Number(request.id);
    else body.appName = request.appName;
    await device.uninstall(deviceId, body);
    log(`uninstalled from the device: ${request.title || body.appId || body.id || body.appName}${body.dlcId ? ` (DLC ${body.dlcId})` : ''}`);
    await refreshLibrary();
  });
  // Bugs: iRelay's own log, and iDeck's (read from the device over the cable).
  const clearedErrors = new Set();
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
      .map((line) => line.replace(/^\S+Z /, '')))].reverse();
    for (const item of state.installs) {
      const line = `${item.title}: ${item.error}`;
      if (item.error && !clearedErrors.has(line)) issues.unshift(line);
    }
    return { issues, log: lines.slice(-300).join('\n') };
  });
  // Clear: iRelay's log (this run's lines start again) and iDeck's logs on the device.
  ipcMain.handle('clearIrelayBugs', () => {
    // The log file is emptied; failed downloads iDeck still reports (it keeps
    // them until it restarts) are remembered as cleared, so they stay out.
    try { fs.writeFileSync(path.join(app.getPath('userData'), 'irelay.log'), ''); } catch { /* none */ }
    global.irelayLogOffset = 0;
    for (const item of state.installs) if (item.error) clearedErrors.add(`${item.title}: ${item.error}`);
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
    if (state.update.busy || state.cache.busy) return;
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
    // Updating an .asar does not upgrade Electron or its embedded Node.js.
    // Existing 3.5.7 installs can load the updated app code in an Electron 31
    // executable; require a new Windows installer before USB transfers begin.
    const electronMajor = Number(process.versions.electron?.split('.')[0] || 0);
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (electronMajor < 42 || nodeMajor < 24) {
      log(`legacy runtime electron=${process.versions.electron} node=${process.versions.node}; full installer required`);
      const choice = await dialog.showMessageBox({
        type: 'warning', title: 'iRelay needs an updated installer',
        message: 'An updated iRelay.exe is required for Node.js 24.',
        detail: 'Application-only updates cannot replace the Node.js runtime bundled with Electron. Install the latest Windows version of iRelay.',
        buttons: ['Open iRelay releases', 'Close'], defaultId: 0, cancelId: 1,
      });
      if (choice.response === 0) {
        try { await shell.openExternal('https://github.com/FacensPedro/iRelay/releases/latest'); }
        catch (error) { log(`could not open releases: ${error.message}`); }
      }
      app.quit();
      return;
    }
    if (SMOKE) log(`runtime check passed electron=${process.versions.electron} node=${process.versions.node}`);
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
      accelerated: state.settings.accelerateDownloads,
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
    every(5000, pollCable);
    // The device's library again every 30 s, so games copied earlier or
    // installed in iDeck itself show up without a reconnect.
    every(30000, () => (deviceId &&
      !(processor && [...processor.jobs.values()].some((job) => !job.finished))
      ? refreshLibrary() : null));
    every(5000, pollInstalls);
    push();
  });

  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
}
