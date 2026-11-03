'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, nativeTheme } = require('electron');
const usbmux = require('./usbmux');
const device = require('./device');
const transfer = require('./transfer');
const updater = require('./updater');
const Relay = require('./relay');
const steam = require('./stores/steam');
const epic = require('./stores/epic');
const gog = require('./stores/gog');

const VERSION = (global.irelay && global.irelay.version) || app.getVersion();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  nativeTheme.themeSource = 'dark';

  let window = null;
  const state = {
    version: VERSION,
    boot: 'Starting…',
    ready: false,
    steamRunning: null,
    cable: { status: 'searching', message: 'Looking for your iPad…', device: null },
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
      if (!deviceId) throw new Error('Connect your iPad by cable first.');
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
      Object.assign(task, { phase: 'On your iPad', finished: true, done: task.total });
      refreshLibrary();
    } catch (error) {
      Object.assign(task, { phase: 'Failed', error: error.message, finished: true });
    }
    push();
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

  async function pollCable() {
    try {
      const devices = await usbmux.listDevices();
      if (!devices.length) {
        deviceId = null;
        state.cable = { status: 'none', message: 'Connect your iPad with a USB cable and tap Trust.', device: null };
      } else {
        const candidate = devices[0].id;
        try {
          const info = await device.info(candidate);
          const first = deviceId !== candidate;
          deviceId = candidate;
          state.cable = { status: 'connected', message: `Connected to ${info.name}`, device: info };
          if (first || !state.library) refreshLibrary();
          relay.tunnels(devices).catch(() => {});
        } catch (error) {
          deviceId = null;
          state.cable = { status: 'waiting', message: 'iPad connected. Open iDeck and turn on iRelay in Settings › Steam.', device: null };
        }
      }
    } catch {
      deviceId = null;
      state.cable = {
        status: 'service', device: null,
        message: 'Install the Apple Devices app (Microsoft Store) or iTunes so iRelay can reach your iPad over USB.',
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
  ipcMain.handle('clearCache', () => relay && relay.clearCache());

  // MARK: Start

  app.whenReady().then(async () => {
    createWindow();
    const status = (text) => { state.boot = text; push(); };
    if (app.isPackaged) {
      try {
        const installed = await updater.check(VERSION, status);
        if (installed) {
          status(`Restarting into iRelay ${installed}…`);
          setTimeout(() => { app.relaunch(); app.exit(0); }, 600);
          return;
        }
      } catch {
        // Offline or GitHub unreachable: start this version.
      }
    }
    relay = new Relay(path.join(app.getPath('userData'), 'cache'), push);
    relay.start();
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
