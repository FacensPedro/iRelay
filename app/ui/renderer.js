'use strict';
/* global irelay */

const TITLES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', tasks: 'Transfers', about: 'About', 'bugs-irelay': 'iRelay bugs', 'bugs-ideck': 'iDeck bugs' };
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
  const pc = (state && state.pc[store]) || {};
  return list.map((game) => {
    if (store === 'steam') {
      const local = pc[game.appId];
      return { store, id: game.appId, title: game.name, cover: steamArt(game.appId), hero: steamArt(game.appId, 'hero'),
        onPC: !!(local && local.complete), installingPC: !!(local && !local.complete), onIPad: game.installed, raw: game, local };
    }
    if (store === 'epic') {
      const local = pc[game.appName];
      return { store, id: game.appName, title: game.title, cover: game.cover, hero: game.cover,
        onPC: !!(local && local.complete), installingPC: !!(local && !local.complete), onIPad: game.installed, raw: game, local };
    }
    const local = pc[game.id];
    return { store, id: game.id, title: game.title, cover: game.cover, hero: game.cover,
      onPC: !!local, installingPC: false, onIPad: game.installed, raw: game, local };
  }).sort((a, b) => a.title.localeCompare(b.title));
}

function busy(store, id) {
  return (state.tasks || []).some((task) => !task.finished && task.store === store && task.title && task.ref === `${store}:${id}`);
}

// MARK: Rendering

function render() {
  if (!state) return;
  $('version').textContent = `v${state.version}`;
  renderDevice();
  renderUpdate();
  renderGate();
  for (const store of ['steam', 'epic', 'gog']) {
    const count = games(store).length;
    $(`count-${store}`).textContent = count ? count : '';
  }
  const active = (state.tasks || []).filter((task) => !task.finished).length + (state.relay || []).filter((job) => job.sent < job.total).length;
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
  else if (view.startsWith('bugs-')) renderBugs();
  else renderAbout();
  renderDrawer();
}

function renderUpdate() {
  const update = state.update || {};
  $('update-button').disabled = !!update.busy || !state.ready;
  $('update-text').textContent = update.busy ? (update.message || 'Updating…') : 'Update iRelay';
  $('update-button').title = update.message || '';
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
  if (state.steamRunning === false) {
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
  if (filter === 'pc') list = list.filter((game) => game.onPC || game.installingPC);
  if (filter === 'ipad') list = list.filter((game) => game.onIPad);
  if (query) list = list.filter((game) => game.title.toLowerCase().includes(query));
  if (!list.length) {
    setContent(emptyState('Nothing here', query ? 'No game matches your search.' : 'No games in this view.'));
    return;
  }
  const html = `<div class="grid">${list.map((game) => {
    const meta = [
      game.onPC ? '<span class="pc">PC</span>' : '',
      game.installingPC ? '<span class="busy">Installing</span>' : '',
      game.onIPad ? '<span class="ipad">Device</span>' : '',
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

function taskHTML(task) {
  const fraction = task.total ? Math.min(1, task.done / task.total) : (task.finished && !task.error ? 1 : 0);
  const meta = task.error ? `<span class="error">${esc(task.error)}</span>`
    : task.total > 1 ? `${esc(task.phase)} · ${size(task.done)} of ${size(task.total)}${task.fileCount ? ` · ${task.files || 0}/${task.fileCount} files` : ''}`
      : esc(task.phase);
  return `<div class="task"><div class="task-head"><div><div class="task-title">${esc(task.title)}</div>
    <div class="task-meta">${meta}</div></div>
    ${task.finished ? '' : `<button class="link" data-cancel="${esc(task.id)}">Cancel</button>`}</div>
    <div class="bar"><span ${task.error ? '' : 'class="sent"'} style="width:${(fraction * 100).toFixed(1)}%"></span></div></div>`;
}

function renderTasks() {
  const tasks = state.tasks || [];
  const relay = state.relay || [];
  if (!tasks.length && !relay.length) {
    setContent(emptyState('No transfers yet', 'Installs on this PC and copies to the connected device appear here.'));
    return;
  }
  const relayHTML = relay.map((job) => `<div class="task"><div class="task-head"><div><div class="task-title">${esc(job.name)}</div>
    <div class="task-meta">Download started in iDeck · ${Math.round(100 * job.downloaded / Math.max(1, job.total))}% on this PC · ${Math.round(100 * job.sent / Math.max(1, job.total))}% on device · ${size(job.bytes)}${job.failed ? ` · ${job.failed} failed` : ''}</div></div></div>
    <div class="bar"><span style="width:${(100 * job.downloaded / Math.max(1, job.total)).toFixed(1)}%"></span><span class="sent" style="width:${(100 * job.sent / Math.max(1, job.total)).toFixed(1)}%"></span></div></div>`).join('');
  setContent(`<div class="tasks">${tasks.map(taskHTML).join('')}${relayHTML}</div>`);
}

function renderAbout() {
  const update = state.update || {};
  setContent(`<div class="about">
    <div class="panel"><h3>iRelay ${esc(state.version)}</h3><p>${esc(state.cable.message)}</p>
      <div class="bugs-bar" style="margin:12px 0 0"><button class="primary" id="about-update" ${update.busy ? 'disabled' : ''}>Update iRelay</button>
      <button class="secondary" id="clear-cache">Clear cache</button>
      <button class="secondary" id="source">GitHub</button></div>
      ${update.message ? `<div class="update-note">${esc(update.message)}</div>` : ''}</div>
    <div class="panel"><h3>GitHub token</h3><p>${update.hasToken ? 'Saved.' : 'Only for a private repository.'}</p>
      <div class="token-row"><input id="token" type="password" placeholder="github_pat_…" autocomplete="off">
      <button class="secondary" id="save-token">Save</button>${update.hasToken ? '<button class="secondary" id="remove-token">Remove</button>' : ''}</div></div>
  </div>`);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('about-update', () => irelay.checkUpdate());
  on('clear-cache', () => irelay.clearCache());
  on('source', () => irelay.openExternal('https://github.com/FacensPedro/iRelay'));
  on('save-token', () => { const value = $('token').value.trim(); if (value) irelay.setToken(value); });
  on('remove-token', () => irelay.setToken(''));
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

function renderBugs() {
  const data = bugs[view];
  if (!data) { setContent(emptyState('Reading logs…', '')); return; }
  if (data.error) { setContent(emptyState('Logs unavailable', data.error)); return; }
  const issues = data.issues || [];
  const list = issues.length
    ? issues.map((line) => `<div class="bug ${/error|fatal|crash|exception/i.test(line) ? 'err' : ''}">${esc(line)}</div>`).join('')
    : emptyState('No bugs found', '');
  setContent(`<div class="bugs-bar"><button class="secondary" id="copy-bugs">Copy</button></div>
    <div class="bugs">${list}</div>
    ${data.log ? `<div class="section-title">Log</div><div class="logtail">${esc(data.log)}</div>` : ''}`);
  const copy = $('copy-bugs');
  if (copy) copy.onclick = () => navigator.clipboard.writeText([...issues, '', data.log || ''].join('\n'));
}

// MARK: Drawer

let drawerKey = '';
function renderDrawer() {
  const drawer = $('drawer');
  if (!selected) { drawer.classList.add('hidden'); drawerKey = ''; return; }
  const game = games(selected.store).find((item) => String(item.id) === String(selected.id));
  if (!game) { drawer.classList.add('hidden'); return; }
  const task = (state.tasks || []).find((item) => !item.finished && item.ref === `${game.store}:${game.id}`);
  const store = TITLES[game.store];
  const pcText = game.onPC ? 'Installed' : game.installingPC ? `Installing${game.local && game.local.progress ? ` · ${Math.round(game.local.progress * 100)}%` : ''}` : 'Not installed';
  const launcher = game.store === 'steam' ? 'Steam' : game.store === 'epic' ? 'the Epic Games Launcher' : 'GOG Galaxy';
  let actions = '';
  if (task) {
    actions = `<div class="task" style="margin:0">${taskHTML(task).replace(/^<div class="task">|<\/div>$/g, '')}</div>`;
  } else if (game.onPC) {
    actions = `<button class="primary" data-action="send">${game.onIPad ? 'Update on device' : 'Copy to device'}</button>`;
  } else {
    actions = `<button class="primary" data-action="install-send">Install and copy to device</button>
      <button class="secondary" data-action="install">Install on this PC only</button>`;
  }
  let dlc = '';
  if (game.store === 'steam') {
    const list = game.raw.dlc || [];
    const local = game.local || { dlc: [] };
    dlc = `<div class="section-title">DLC</div>` + (list.length ? list.map((item) => {
      const onPC = (local.dlc || []).includes(item.appId);
      const label = item.installed ? 'On device' : onPC ? 'Copy to device' : 'Install';
      const disabled = item.installed || !game.onPC ? 'disabled' : '';
      return `<div class="dlc"><img src="${esc(steamArt(item.appId, 'header'))}" alt="" loading="lazy">
        <div class="dlc-name"><div>${esc(item.name)}</div><div class="muted small">${onPC ? 'On this PC' : 'Not on this PC'}${item.installed ? ' · On device' : ''}</div></div>
        <button class="secondary" data-dlc="${item.appId}" ${disabled}>${label}</button></div>`;
    }).join('') + (game.onPC ? '' : '<div class="note">Install the game on this PC to add its DLC.</div>')
      : `<div class="note">No DLC loaded. <button class="link" data-action="load-dlc">Load DLC</button></div>`);
  }
  const html = `<div class="hero" style="background-image:url('${esc(game.hero || '')}')"></div>
    <button class="drawer-close" data-action="close">✕</button>
    <div class="drawer-body"><h2>${esc(game.title)}</h2><div class="muted">${esc(store)}</div>
      <div class="status-row">
        <div class="status"><div class="label">This PC</div><div class="value ${game.onPC ? 'yes' : ''}">${esc(pcText)}</div></div>
        <div class="status"><div class="label">Device</div><div class="value ${game.onIPad ? 'yes' : ''}">${game.onIPad ? 'Installed' : 'Not installed'}</div></div>
      </div>
      <div class="actions">${actions}</div>
      <div class="note">${game.onPC ? 'Only missing files are copied, then the game is removed from this PC.' : `Installed by ${esc(launcher)}, copied to the device, then removed from this PC.`}</div>
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
    if (action === 'send') await irelay.send({ ...request(game), ref: `${game.store}:${game.id}` });
    if (action === 'install') await irelay.install({ ...request(game), send: false });
    if (action === 'install-send') await irelay.install({ ...request(game), send: true });
    if (action === 'dlc') await irelay.install({ ...request(game), dlcId: extra.dlc, send: true });
    view = 'tasks';
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
    selected = null;
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
$('gate-button').addEventListener('click', () => irelay.openSteam());
$('update-button').addEventListener('click', () => irelay.checkUpdate());
$('device-select').addEventListener('change', (event) => irelay.selectDevice(event.target.value));
$('content').addEventListener('click', (event) => {
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) { irelay.cancel(cancel.dataset.cancel); return; }
  const card = event.target.closest('.card');
  if (!card) return;
  selected = { store: card.dataset.store, id: card.dataset.id };
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
  const dlc = event.target.closest('[data-dlc]');
  if (dlc) act('dlc', { dlc: Number(dlc.dataset.dlc) });
  const cancel = event.target.closest('[data-cancel]');
  if (cancel) irelay.cancel(cancel.dataset.cancel);
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && selected) { selected = null; render(); } });

irelay.onState((next) => { state = next; render(); });
irelay.state().then((next) => { state = next; render(); });
