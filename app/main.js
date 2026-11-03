'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const usbmux = require('./usbmux');
const device = require('./device');
const lockdown = require('./lockdown');
const fs = require('fs');
const transfer = require('./transfer');
const updater = require('./updater');
const Relay = require('./relay');
const steam = require('./stores/steam');
const epic = require('./stores/epic');
const gog = require('./stores/gog');

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
    ready: false,
    steamRunning: null,
    cable: { status: 'searching', message: 'Looking for a connected device…', device: null },
    devices: [],
    selected: null,
    library: null,
    libraryError: null,
    pc: { steam: {}, epic: {}, gog: {} },
    tasks: [],
    relay: [],
  };
  let deviceId = null;
  let relay = null;

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
    window.webContents.on('console-message', (_, level, message) => { if (level >= 2) log(`page: ${message}`); });
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

  // MARK: Tasks

  function addTask(task) {
    const entry = { id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, phase: 'Queued', done: 0, total: 0, error: null, finished: false, ...task };
    state.tasks.unshift(entry);
    state.tasks = state.tasks.slice(0, 40);
    push();
    return entry;
  }

  const refOf = (job) => `${job.store}:${job.appId || job.appName || job.id}`;
  const waiting = []; // installs on the PC to send once complete
  let sending = Promise.resolve();

  function queueSend(job) {
    const task = addTask({ kind: 'send', store: job.store, title: job.title, ref: refOf(job) });
    sending = sending.then(() => runSend(job, task)).catch(() => {});
  }

  async function runSend(job, task) {
    try {
      if (!deviceId) throw new Error('Connect a device with iDeck by cable first.');
      const progress = (update) => { Object.assign(task, update); push(); };
      if (job.store === 'steam') {
        const pc = (await steam.installed())[job.appId];
        if (!pc || !pc.complete) throw new Error('The game is not fully installed on this PC.');
        const root = `Program Files (x86)/Steam/steamapps/common/${pc.installDir}`;
        const sent = await transfer.sync(deviceId, root, pc.folder, progress, () => task.cancelled);
        const fs = require('fs');
        const onIPad = libraryGame('steam', job.appId);
        const dlc = pc.dlc.filter((id) => !(onIPad && (onIPad.dlc || []).some((d) => d.appId === id && d.installed)));
        // A DLC sent alone owns the files that changed; sent with its game it owns none
        // (iDeck must never delete the game's files when the DLC is removed).
        const dlcOnly = job.dlcOnly && onIPad && onIPad.installed;
        progress({ phase: 'Finishing' });
        await device.finish(deviceId, {
          store: 'steam', appId: job.appId, title: pc.name, acf: fs.readFileSync(pc.acfPath, 'utf8'),
          dlc, files: dlcOnly ? sent.map((p) => `${pc.installDir}/${p}`) : [],
        });
      } else if (job.store === 'epic') {
        const pc = epic.installed()[job.appName];
        if (!pc || !pc.complete) throw new Error('The game is not fully installed on this PC.');
        const folderName = path.basename(pc.folder);
        const root = `Program Files/Epic Games/${folderName}`;
        await transfer.sync(deviceId, root, pc.folder, progress, () => task.cancelled);
        progress({ phase: 'Finishing' });
        await device.finish(deviceId, {
          store: 'epic', title: pc.title,
          record: {
            appName: pc.appName, title: pc.title, namespace: pc.namespace, catalogItemID: pc.catalogItemId,
            folder: root, buildVersion: pc.buildVersion, launchExe: pc.launchExe, launchCommand: pc.launchCommand,
            installBytes: pc.installBytes, canRunOffline: pc.canRunOffline, requiresOwnershipToken: pc.requiresOwnershipToken,
          },
        });
      } else if (job.store === 'gog') {
        const pc = (await gog.installed())[job.id];
        if (!pc) throw new Error('The game is not installed on this PC.');
        const root = `GOG Games/${path.basename(pc.folder)}`;
        await transfer.sync(deviceId, root, pc.folder, progress, () => task.cancelled);
        progress({ phase: 'Finishing' });
        await device.finish(deviceId, { store: 'gog', title: pc.title });
      }
      // The game is on the device now: its files on this PC are removed.
      progress({ phase: 'Removing from this PC' });
      await removeFromPC(job);
      Object.assign(task, { phase: 'On the device', finished: true, done: task.total });
      refreshLibrary();
    } catch (error) {
      Object.assign(task, { phase: 'Failed', error: error.message, finished: true });
      log(`copy failed: ${job.title}: ${error.message}`);
    }
    push();
  }

  /// Deletes a copied game from this PC: its folder and the launcher's install
  /// record (Steam's appmanifest, Epic's manifest item). GOG's registry entry
  /// points at a folder that is gone, which iRelay then ignores.
  async function removeFromPC(job) {
    try {
      if (job.store === 'steam') {
        const pc = (await steam.installed())[job.appId];
        if (!pc) return;
        await fs.promises.rm(pc.folder, { recursive: true, force: true });
        await fs.promises.rm(pc.acfPath, { force: true });
      } else if (job.store === 'epic') {
        const pc = epic.installed()[job.appName];
        if (!pc) return;
        await fs.promises.rm(pc.folder, { recursive: true, force: true });
        if (pc.itemPath) await fs.promises.rm(pc.itemPath, { force: true });
      } else if (job.store === 'gog') {
        const pc = (await gog.installed())[job.id];
        if (pc) await fs.promises.rm(pc.folder, { recursive: true, force: true });
      }
      log(`removed from this PC after copying: ${job.title}`);
    } catch (error) {
      log(`could not remove ${job.title} from this PC: ${error.message}`);
    }
  }

  function libraryGame(store, id) {
    const list = state.library && state.library[store] && state.library[store].games;
    if (!list) return null;
    if (store === 'steam') return list.find((game) => game.appId === id);
    if (store === 'gog') return list.find((game) => game.id === id);
    return list.find((game) => game.appName === id);
  }

  // MARK: Polling

  async function pollPC() {
    try {
      state.steamRunning = await steam.isRunning();
      const [steamApps, gogGames] = await Promise.all([steam.installed(), gog.installed()]);
      state.pc = { steam: steamApps, epic: epic.installed(), gog: gogGames };
      // Installs waiting on the PC.
      for (const item of [...waiting]) {
        let ready = false;
        if (item.store === 'steam') {
          const pc = steamApps[item.appId];
          ready = !!pc && pc.complete && (!item.dlcId || pc.dlc.includes(item.dlcId));
          if (pc && item.task) Object.assign(item.task, { phase: pc.complete ? 'Installed on PC' : 'Installing on PC (Steam)', done: pc.progress, total: 1 });
        } else if (item.store === 'epic') {
          const pc = state.pc.epic[item.appName];
          ready = !!pc && pc.complete;
        } else if (item.store === 'gog') {
          ready = !!gogGames[item.id];
        }
        if (ready) {
          waiting.splice(waiting.indexOf(item), 1);
          if (item.task) Object.assign(item.task, { phase: 'Installed on PC', finished: true, done: 1, total: 1 });
          if (item.send) queueSend(item);
        }
      }
    } catch { /* next poll */ }
    if (relay) state.relay = relay.jobs.map(({ cancelled, ...job }) => job);
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
        state.cable = { status: 'waiting', message: `Open iDeck on ${current.name} and turn on iRelay in Settings › iRelay.`, device: { name: current.name, model: current.model, iosVersion: current.iosVersion } };
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
  ipcMain.handle('openSteam', () => steam.open());
  ipcMain.handle('openExternal', (_, url) => (/^https:\/\//.test(url) ? shell.openExternal(url) : null));
  ipcMain.handle('steamDLC', async (_, appId) => {
    if (!deviceId) return [];
    const result = await device.steamDLC(deviceId, appId);
    const game = libraryGame('steam', appId);
    if (game) game.dlc = result.dlc || [];
    push();
    return result.dlc || [];
  });
  ipcMain.handle('install', async (_, request) => {
    const { store, send } = request;
    if (!state.steamRunning) throw new Error('Steam must be running on this PC.');
    if (store === 'steam') {
      const appId = Number(request.appId);
      const dlcId = request.dlcId ? Number(request.dlcId) : null;
      const pc = state.pc.steam[appId];
      if (dlcId && !(pc && pc.complete)) throw new Error('Install the game on this PC first.');
      const title = request.title || (pc && pc.name) || `App ${appId}`;
      const ready = dlcId ? pc.dlc.includes(dlcId) : pc && pc.complete;
      if (ready) {
        if (send) queueSend({ store, appId, title, dlcOnly: !!dlcId });
        return;
      }
      await steam.install(dlcId || appId);
      const task = addTask({ kind: 'install', store, title: dlcId ? `${title} — DLC` : title, phase: 'Installing on PC (Steam)', ref: refOf({ store, appId }) });
      waiting.push({ store, appId, dlcId, title, send, task, dlcOnly: !!dlcId });
    } else if (store === 'epic') {
      const pc = state.pc.epic[request.appName];
      if (pc && pc.complete) { if (send) queueSend({ store, appName: request.appName, title: pc.title }); return; }
      await epic.install(request);
      const task = addTask({ kind: 'install', store, title: request.title, phase: 'Installing on PC (Epic Games Launcher)', ref: refOf({ store, appName: request.appName }) });
      waiting.push({ store, appName: request.appName, title: request.title, send, task });
    } else if (store === 'gog') {
      const id = Number(request.id);
      if (state.pc.gog[id]) { if (send) queueSend({ store, id, title: request.title }); return; }
      await gog.install(id);
      const task = addTask({ kind: 'install', store, title: request.title, phase: 'Install it in GOG Galaxy (opened)', ref: refOf({ store, id }) });
      waiting.push({ store, id, title: request.title, send, task });
    }
    push();
  });
  ipcMain.handle('send', (_, request) => {
    queueSend({ ...request, appId: request.appId && Number(request.appId), id: request.id && Number(request.id) });
  });
  ipcMain.handle('cancel', (_, id) => {
    const task = state.tasks.find((item) => item.id === id);
    if (task) task.cancelled = true;
    const index = waiting.findIndex((item) => item.task && item.task.id === id);
    if (index >= 0) {
      waiting.splice(index, 1);
      Object.assign(task, { phase: 'Cancelled', finished: true });
    }
    push();
  });
  ipcMain.handle('selectDevice', (_, udid) => {
    chosen = udid;
    try { fs.writeFileSync(choiceFile, JSON.stringify({ udid })); } catch { /* not remembered */ }
    pollCable();
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
    for (const task of state.tasks) if (task.error) issues.unshift(`${task.title}: ${task.error}`);
    return { issues, log: lines.slice(-300).join('\n') };
  });
  ipcMain.handle('ideckBugs', async () => {
    if (!deviceId) throw new Error('Connect a device with iDeck first.');
    return device.logs(deviceId);
  });
  ipcMain.handle('clearCache', () => {
    try { if (relay) relay.clearCache(); } catch (error) { log(`clear cache: ${error.message}`); }
  });

  // MARK: Start

  app.whenReady().then(async () => {
    createWindow();
    const status = (text) => { state.boot = text; push(); };
    log(`iRelay ${VERSION} ready`);
    if (app.isPackaged && !SMOKE) {
      try {
        const installed = await updater.check(VERSION, status);
        if (installed) {
          status(`Restarting into iRelay ${installed}…`);
          // Release the single-instance lock first, or the new copy would see
          // this one and quit at once.
          log(`updated to ${installed}; restarting`);
          setTimeout(() => { app.releaseSingleInstanceLock(); app.relaunch(); app.exit(0); }, 600);
          return;
        }
      } catch (error) {
        // Offline or GitHub unreachable: start this version.
        log(`update check skipped: ${error.message}`);
      }
    }
    // Not 'cache': on Windows that is Chromium's own Cache folder (names ignore case).
    relay = new Relay(path.join(app.getPath('userData'), 'relay-chunks'), push);
    try { relay.start(); } catch (error) { log(`relay not started: ${error.message}`); }
    state.ready = true;
    state.boot = '';
    every(2000, pollCable);
    every(4000, pollPC);
    push();
  });

  app.on('second-instance', () => {
    if (window) { if (window.isMinimized()) window.restore(); window.focus(); }
  });
  app.on('window-all-closed', () => app.quit());
}
