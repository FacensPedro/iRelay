'use strict';
/* global irelay */

const TITLES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', tasks: 'Transfers', settings: 'Settings', about: 'About', 'bugs-irelay': 'iRelay bugs', 'bugs-ideck': 'iDeck bugs' };
let bugs = { 'bugs-irelay': null, 'bugs-ideck': null };
let state = null;
let view = 'steam';
let filter = 'all';
let query = '';
let selected = null; // { store, id }
let lastGrid = '';

const $ = (id) => document.getElementById(id);
const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function size(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function steamArt(id, kind) {
  const base = `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/`;
  return base + (kind === 'hero' ? 'library_hero.jpg' : kind === 'header' ? 'header.jpg' : 'library_600x900.jpg');
}

/// The games of a store, merged with what is on this PC.
function games(store) {
  const library = state && state.library && state.library[store];
  const list = (library && library.games) || [];
  return list.map((game) => {
    const id = store === 'steam' ? game.appId : store === 'epic' ? game.appName : game.id;
    const download = (state.installs || []).find((item) => item.store === store && String(item.id) === String(id));
    const title = store === 'steam' ? game.name : game.title;
    const cover = store === 'steam' ? steamArt(game.appId) : game.cover;
    return { store, id, title, cover, hero: store === 'steam' ? steamArt(game.appId, 'hero') : game.cover,
      onIPad: game.installed, update: !!game.update, size: game.size || 0, download: download && download.phase !== 'failed' ? download : null,
      failed: download && download.error ? download.error : null, raw: game };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function bytes(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 3 ? 2 : i ? 1 : 0)} ${units[i]}`;
}

function percent(item) {
  return item && item.total ? Math.min(100, Math.round(100 * item.done / item.total)) : 0;
}

// MARK: Rendering

function render() {
  if (!state) return;
  $('version').textContent = `v${state.version}`;
  renderDevice();
  renderGate();
  for (const store of ['steam', 'epic', 'gog']) {
    const count = games(store).length;
    $(`count-${store}`).textContent = count ? count : '';
  }
  const active = (state.installs || []).filter((item) => !item.error).length + (state.jobs || []).filter((job) => !job.finished).length;
  $('count-tasks').textContent = active ? active : '';
  $('view-title').textContent = TITLES[view];
  const library = ['steam', 'epic', 'gog'].includes(view);
  $('filter').style.visibility = library ? 'visible' : 'hidden';
  $('search').style.visibility = library ? 'visible' : 'hidden';
  $('refresh').style.visibility = library || view.startsWith('bugs-') ? 'visible' : 'hidden';
  for (const kind of ['bugs-irelay', 'bugs-ideck']) {
    const found = bugs[kind] && bugs[kind].issues ? bugs[kind].issues.length : 0;
    $(`count-${kind}`).textContent = found ? found : '';
  }
  if (library) renderLibrary();
  else if (view === 'tasks') renderTasks();
  else if (view === 'settings') renderSettings();
  else if (view.startsWith('bugs-')) renderBugs();
  else renderAbout();
  renderDrawer();
}

function renderDevice() {
  const cable = state.cable || {};
  $('device-dot').className = `device-dot ${cable.status === 'connected' ? 'on' : cable.status === 'waiting' ? 'warn' : ''}`;
  const info = cable.device;
  $('device-title').textContent = info ? info.name : 'No device';
  const model = info ? [info.model, info.iosVersion && `iOS ${info.iosVersion}`].filter(Boolean).join(' · ') : '';
  $('device-text').textContent = cable.status === 'connected'
    ? `${model} · iDeck ${info.version} · ${size(info.freeBytes)} free`
    : [model, cable.message].filter(Boolean).join(' — ');
  const select = $('device-select');
  const devices = state.devices || [];
  select.classList.toggle('hidden', devices.length < 2);
  const options = devices.map((item) => `<option value="${esc(item.udid)}" ${item.udid === state.selected ? 'selected' : ''}>${esc(item.name)} (${esc(item.model)})</option>`).join('');
  if (select.dataset.html !== options) { select.innerHTML = options; select.dataset.html = options; }
}

function renderGate() {
  const gate = $('gate');
  if (!state.ready) {
    gate.classList.remove('hidden');
    $('gate-title').textContent = 'iRelay';
    $('gate-text').textContent = state.boot || 'Starting…';
    $('gate-button').classList.add('hidden');
    $('gate-button').style.display = 'none';
    gate.querySelector('.gate-icon').innerHTML = '<div class="spinner"></div>';
    return;
  }
  if (false) {
    gate.classList.remove('hidden');
    $('gate-title').textContent = 'Steam is not running';
    $('gate-text').textContent = 'iRelay installs games through the Steam client on this PC. Open Steam and sign in; iRelay continues automatically.';
    $('gate-button').style.display = '';
    gate.querySelector('.gate-icon').innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 0 0-9.95 9.1l5.35 2.2a2.8 2.8 0 0 1 1.6-.5h.15l2.4-3.45v-.05a3.8 3.8 0 1 1 3.8 3.8h-.08l-3.4 2.45v.12a2.85 2.85 0 0 1-5.65.5L2.4 14.6A10 10 0 1 0 12 2Z"/></svg>';
    return;
  }
  gate.classList.add('hidden');
}

function emptyState(title, text) {
  return `<div class="empty"><div><h2>${esc(title)}</h2><p>${esc(text)}</p></div></div>`;
}

function renderLibrary() {
  const store = view;
  if (!state.cable || state.cable.status !== 'connected') {
    setContent(emptyState('Connect a device', state.cable ? state.cable.message : ''));
    return;
  }
  const library = state.library && state.library[store];
  if (!library) {
    setContent(state.libraryError ? emptyState('Could not read iDeck’s library', state.libraryError) : emptyState('Loading your library…', 'iDeck is reading its libraries.'));
    return;
  }
  if (!library.signedIn) {
    setContent(emptyState(`Sign in to ${TITLES[store]} in iDeck`, `iRelay shows the ${TITLES[store]} library iDeck is signed in to. Sign in from iDeck’s Settings, then reload.`));
    return;
  }
  let list = games(store);
  if (filter === 'pc') list = list.filter((game) => game.download);
  if (filter === 'ipad') list = list.filter((game) => game.onIPad);
  if (query) list = list.filter((game) => game.title.toLowerCase().includes(query));
  if (!list.length) {
    setContent(emptyState('Nothing here', query ? 'No game matches your search.' : 'No games in this view.'));
    return;
  }
  const html = `<div class="grid">${list.map((game) => {
    const meta = [
      game.download ? `<span class="busy">Installing ${percent(game.download)}%</span>` : '',
      game.onIPad && !game.download ? '<span class="ipad">Device</span>' : '',
    ].join('');
    return `<button class="card" data-store="${store}" data-id="${esc(game.id)}">
      <div class="cover">${game.cover ? `<img src="${esc(game.cover)}" loading="lazy" alt="">` : ''}</div>
      <div class="card-title">${esc(game.title)}</div><div class="card-meta">${meta}</div></button>`;
  }).join('')}</div>`;
  setContent(html);
}

function setContent(html) {
  if (html === lastGrid) return;
  lastGrid = html;
  $('content').innerHTML = html;
  $('content').querySelectorAll('.cover img').forEach((img) => {
    img.addEventListener('error', () => img.remove());
  });
}

const hidden = new Set();
function itemKey(kind, item) { return kind === 'install' ? `i:${item.store}:${item.id}:${item.error || ''}` : `j:${item.id}`; }

function renderTasks() {
  const installs = (state.installs || []).filter((item) => !hidden.has(itemKey('install', item)));
  const jobs = (state.jobs || []).filter((job) => !hidden.has(itemKey('job', job)));
  if (!installs.length && !jobs.length) {
    setContent(emptyState('No transfers yet', 'Downloads to the connected device appear here.'));
    return;
  }
  const installHTML = installs.map((item) => `<div class="task"><div class="task-head"><div><div class="task-title">${esc(item.title)}</div>
    <div class="task-meta">${item.error ? `<span class="error">${esc(item.error)}</span>` : `${esc(TITLES[item.store] || item.store)} · ${esc(item.phase)} · ${percent(item)}%`}</div></div>
    ${item.error ? `<button class="link" data-hide="${esc(itemKey('install', item))}" title="Remove">✕</button>` : ''}</div>
    <div class="bar"><span class="sent" style="width:${percent(item)}%"></span></div></div>`).join('');
  const jobHTML = jobs.map((job) => {
    const done = Math.round(100 * job.done / Math.max(1, job.total));
    const speed = job.seconds > 0 ? job.bytes / job.seconds : 0;
    return `<div class="task"><div class="task-head"><div><div class="task-title">${esc(job.name)}</div>
      <div class="task-meta">Processed on this PC · ${done}% · ${size(job.bytes)} of ${size(job.totalBytes)}${job.finished ? '' : ` · ${size(speed)}/s`}${job.failed ? ` · ${job.failed} left to iDeck` : ''}</div></div>
      ${job.finished ? `<button class="link" data-hide="${esc(itemKey('job', job))}" title="Remove">✕</button>` : ''}</div>
      <div class="bar"><span style="width:${done}%"></span></div></div>`;
  }).join('');
  setContent(`<div class="tasks">${installHTML}${jobHTML}</div>`);
}

let savingSettings = false;
let settingsError = '';
function renderSettings() {
  const enabled = state.settings && state.settings.accelerateDownloads === true;
  setContent(`<div class="settings">
    <div class="panel settings-panel">
      <div class="settings-copy"><h3 id="acceleration-label">Accelerate downloads</h3>
        <p id="acceleration-description">Download and process more Steam chunks at the same time on this PC. Uses more CPU, memory and bandwidth. Speed depends on your connection and device.</p></div>
      <button class="acceleration-switch" id="download-acceleration" role="switch" aria-checked="${enabled}"
        aria-labelledby="acceleration-label" aria-describedby="acceleration-description" ${savingSettings ? 'disabled' : ''}>
        <span>${savingSettings ? 'Saving…' : enabled ? 'On' : 'Off'}</span><span class="switch-track" aria-hidden="true"><span></span></span>
      </button>
    </div>
    <p class="note">Applies to current and future Steam downloads processed by iRelay. Epic Games and GOG downloads run on the device.</p>
    <div class="error" role="status" aria-live="polite">${esc(settingsError)}</div>
  </div>`);
  $('download-acceleration').onclick = async () => {
    if (savingSettings) return;
    savingSettings = true;
    settingsError = '';
    renderSettings();
    try {
      const saved = await irelay.setDownloadAcceleration(!enabled);
      state.settings = saved;
    } catch (error) {
      settingsError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      savingSettings = false;
      lastGrid = '';
      render();
      if (view === 'settings') $('download-acceleration').focus();
    }
  };
}

function renderAbout() {
  const update = state.update || {};
  setContent(`<div class="about">
    <div class="panel"><h3>iRelay ${esc(state.version)}</h3><p>${esc(state.cable.message)}</p>
      <div class="bugs-bar" style="margin:12px 0 0"><button class="primary" id="about-update" ${update.busy ? 'disabled' : ''}>Update iRelay</button>
      <button class="secondary" id="open-data">iRelay folder</button>
      <button class="secondary" id="open-program">Program folder</button>
      <button class="secondary" id="source">GitHub</button></div>
      ${update.message ? `<div class="update-note">${esc(update.message)}</div>` : ''}</div>
  </div>`);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('about-update', () => irelay.checkUpdate());
  on('source', () => irelay.openExternal('https://github.com/FacensPedro/iRelay'));
  on('open-data', () => irelay.openFolder('data'));
  on('open-program', () => irelay.openFolder('program'));
}

// MARK: Bugs

async function loadBugs(kind) {
  try {
    bugs[kind] = kind === 'bugs-irelay' ? await irelay.irelayBugs() : await irelay.ideckBugs();
  } catch (failure) {
    bugs[kind] = { error: String(failure.message || failure).replace(/^Error invoking remote method '\w+': (Error: )?/, '') };
  }
  lastGrid = '';
  render();
}

let bugsOpen = false;
let logOpen = false;
function renderBugs() {
  const data = bugs[view];
  if (!data) { setContent(emptyState('Reading logs…', '')); return; }
  if (data.error) { setContent(emptyState('Logs unavailable', data.error)); return; }
  const issues = data.issues || [];
  const list = issues.map((line) => `<div class="bug ${/error|fatal|crash|exception/i.test(line) ? 'err' : ''}">${esc(line)}</div>`).join('');
  // Lists start collapsed; their headers open them.
  setContent(`<div class="bugs-bar"><button class="secondary" id="copy-bugs">Copy</button>
    <button class="secondary" id="clear-bugs">Clear</button></div>
    ${issues.length ? `<button class="fold" id="fold-bugs">${bugsOpen ? '▾' : '▸'} Bugs (${issues.length})</button>
      ${bugsOpen ? `<div class="bugs">${list}</div>` : ''}` : emptyState('No bugs found', '')}
    ${data.log ? `<button class="fold" id="fold-log">${logOpen ? '▾' : '▸'} Log</button>${logOpen ? `<div class="logtail">${esc(data.log)}</div>` : ''}` : ''}`);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('copy-bugs', () => navigator.clipboard.writeText([...issues, '', data.log || ''].join('\n')));
  on('fold-bugs', () => { bugsOpen = !bugsOpen; lastGrid = ''; render(); });
  on('clear-bugs', async () => {
    const kind = view;
    try {
      if (kind === 'bugs-irelay') await irelay.clearIrelayBugs(); else await irelay.clearIdeckBugs();
    } catch (failure) {
      bugs[kind] = { error: 'Could not clear: ' + String(failure.message || failure).replace(/^Error invoking remote method '\w+': (Error: )?/, '')
        + (kind === 'bugs-ideck' ? ' (update iDeck to clear its log from here)' : '') };
      lastGrid = '';
      render();
      return;
    }
    loadBugs(kind);
  });
  on('fold-log', () => { logOpen = !logOpen; lastGrid = ''; render(); });
}

// MARK: Drawer

let drawerKey = '';
const picked = new Set();   // DLC chosen to install with the game
function renderDrawer() {
  const drawer = $('drawer');
  if (!selected) { drawer.classList.add('hidden'); drawerKey = ''; return; }
  const game = games(selected.store).find((item) => String(item.id) === String(selected.id));
  if (!game) { drawer.classList.add('hidden'); return; }
  const store = TITLES[game.store];
  let actions;
  if (game.download) {
    actions = `<div class="task" style="margin:0"><div class="task-meta">${esc(game.download.phase)} · ${percent(game.download)}%</div>
      <div class="bar"><span class="sent" style="width:${percent(game.download)}%"></span></div></div>`;
  } else {
    if (!game.onIPad) actions = '<button class="primary" data-action="install">Install on device</button>';
    else {
      actions = (game.update ? '<button class="primary" data-action="install">Update on device</button>' : '')
        + '<button class="secondary" data-action="uninstall">Uninstall</button>';
    }
  }
  const queued = (state.dlcQueue || {})[game.id] || [];
  let dlc = '';
  if (game.store === 'steam') {
    const list = game.raw.dlc || [];
    dlc = '<div class="section-title">DLC</div>' + (list.length ? list.map((item) => {
      let control;
      if (item.installed) control = `<button class="secondary" data-undlc="${item.appId}" ${game.download ? 'disabled' : ''}>Uninstall</button>`;
      else if (queued.includes(item.appId)) control = '<button class="secondary" disabled>Queued</button>';
      else if (!game.onIPad) {
        // Chosen DLC install right after the game.
        control = `<label class="dlc-pick"><input type="checkbox" data-pick="${item.appId}" ${picked.has(item.appId) ? 'checked' : ''}> With the game</label>`;
      } else control = `<button class="secondary" data-dlc="${item.appId}" ${game.download ? 'disabled' : ''}>Install</button>`;
      return `<div class="dlc"><img src="${esc(steamArt(item.appId, 'header'))}" alt="" loading="lazy">
        <div class="dlc-name"><div>${esc(item.name)}</div><div class="muted small">${item.installed ? 'On device' : 'Not installed'}${item.size ? ` · ${bytes(item.size)}` : ''}</div></div>
        ${control}</div>`;
    }).join('')
      : '<div class="note">No DLC loaded. <button class="link" data-action="load-dlc">Load DLC</button></div>');
  }
  const html = `<div class="hero" style="background-image:url('${esc(game.hero || '')}')"></div>
    <button class="drawer-close" data-action="close">✕</button>
    <div class="drawer-body"><h2>${esc(game.title)}</h2><div class="muted">${esc(store)}</div>
      <div class="status-row">
        <div class="status"><div class="label">Device</div><div class="value ${game.onIPad ? 'yes' : ''}">${game.onIPad ? (game.update ? 'Update available' : 'Installed') : 'Not installed'}</div></div>
        ${game.size ? `<div class="status"><div class="label">Size</div><div class="value">${bytes(game.size)}</div></div>` : ''}
      </div>
      <div class="actions">${actions}</div>
      <div class="note">${game.store === 'steam' ? 'This PC downloads and unpacks the game and writes it straight into iDeck. Nothing is installed on Windows.' : 'iDeck downloads the game. Nothing is installed on Windows.'}</div>
      ${game.failed ? `<div class="error">${esc(game.failed)}</div>` : ''}
      <div class="error" id="drawer-error"></div>
      ${dlc}
    </div>`;
  const key = html;
  drawer.classList.remove('hidden');
  if (key === drawerKey) return;
  drawerKey = key;
  drawer.innerHTML = html;
  drawer.querySelectorAll('img').forEach((img) => img.addEventListener('error', () => { img.style.visibility = 'hidden'; }));
  const hero = drawer.querySelector('.hero');
  if (game.store === 'steam') {
    const probe = new Image();
    probe.onerror = () => { hero.style.backgroundImage = `url('${steamArt(game.id, 'header')}')`; };
    probe.src = game.hero;
  }
}

function request(game) {
  if (game.store === 'steam') return { store: 'steam', appId: game.id, title: game.title };
  if (game.store === 'epic') return { store: 'epic', appName: game.id, title: game.title, namespace: game.raw.namespace, catalogItemId: game.raw.catalogItemId };
  return { store: 'gog', id: game.id, title: game.title };
}

async function act(action, extra = {}) {
  const game = games(selected.store).find((item) => String(item.id) === String(selected.id));
  if (!game) return;
  const error = $('drawer-error');
  try {
    if (action === 'close') { selected = null; render(); return; }
    if (action === 'load-dlc') { await irelay.steamDLC(game.id); return; }
    if (action === 'install') await irelay.install({ ...request(game), withDLC: game.store === 'steam' && !game.onIPad ? [...picked] : [] });
    if (action === 'dlc') await irelay.install({ ...request(game), dlcId: extra.dlc });
    if (action === 'uninstall' || action === 'undlc') {
      if (!confirm(action === 'undlc' ? 'Remove this DLC from the device?' : `Remove ${game.title} from the device?`)) return;
      await irelay.uninstall({ ...request(game), dlcId: extra.dlc });
      drawerKey = '';
      lastGrid = '';
      render();
      return;
    }
    view = 'tasks';
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    selected = null;
    lastGrid = '';
    render();
  } catch (failure) {
    if (error) error.textContent = String(failure.message || failure).replace(/^Error invoking remote method '\w+': (Error: )?/, '');
  }
}

// MARK: Events

document.querySelectorAll('.nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    view = button.dataset.view;
    selected = null;
    if (view.startsWith('bugs-')) loadBugs(view);
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === button));
    lastGrid = '';
    render();
  });
});
document.querySelectorAll('#filter button').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('#filter button').forEach((item) => item.classList.toggle('active', item === button));
    render();
  });
});
$('search').addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); render(); });
$('refresh').addEventListener('click', () => (view.startsWith('bugs-') ? loadBugs(view) : irelay.refresh()));
$('device-select').addEventListener('change', (event) => irelay.selectDevice(event.target.value));
$('content').addEventListener('click', (event) => {
  const hide = event.target.closest('[data-hide]');
  if (hide) { hidden.add(hide.dataset.hide); lastGrid = ''; render(); return; }
  const card = event.target.closest('.card');
  if (!card) return;
  selected = { store: card.dataset.store, id: card.dataset.id };
  picked.clear();
  drawerKey = '';
  render();
  if (selected.store === 'steam') {
    const game = games('steam').find((item) => String(item.id) === selected.id);
    if (game && !(game.raw.dlc || []).length) irelay.steamDLC(game.id).catch(() => {});
  }
});
$('drawer').addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]');
  if (action) { act(action.dataset.action); return; }
  const pick = event.target.closest('[data-pick]');
  if (pick) { const id = Number(pick.dataset.pick); if (pick.checked) picked.add(id); else picked.delete(id); return; }
  const dlc = event.target.closest('[data-dlc]');
  if (dlc) { act('dlc', { dlc: Number(dlc.dataset.dlc) }); return; }
  const undlc = event.target.closest('[data-undlc]');
  if (undlc) act('undlc', { dlc: Number(undlc.dataset.undlc) });
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && selected) { selected = null; render(); } });

irelay.onState((next) => { state = next; render(); });
irelay.state().then((next) => { state = next; render(); });
