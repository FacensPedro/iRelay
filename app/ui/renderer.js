'use strict';
/* global irelay */

const TITLES = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', ea: 'EA app', ubisoft: 'Ubisoft Connect', tasks: 'Transfers', settings: 'Settings', about: 'About', 'bugs-irelay': 'iRelay bugs', 'bugs-ideck': 'iDeck bugs' };
let bugs = { 'bugs-irelay': null, 'bugs-ideck': null };
let bugAction = { kind: '', confirm: false, busy: false, notice: '', failed: false };
let state = null;
let view = 'steam';
let filter = 'all';
let query = '';
let selected = null; // { store, id }
let lastGrid = '';
let transferError = '';
const downloadControlsSupported = () => Number(state?.cable?.device?.protocol || 0) >= 3;

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
      onIPad: game.installed, update: !!game.update, size: game.size || 0,
      sizeSource: game.sizeSource || 'metadata', requiredSpaceGB: game.requiredSpaceGB || 0,
      download: download && download.phase !== 'failed' ? download : null,
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

function remainingLabel(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0 || value > 604800) return '';
  const remaining = Math.ceil(value);
  if (remaining < 60) return remaining + 's left';
  if (remaining < 3600) return Math.ceil(remaining / 60) + 'm left';
  if (remaining < 86400) return Math.floor(remaining / 3600) + 'h ' + Math.ceil((remaining % 3600) / 60) + 'm left';
  return Math.floor(remaining / 86400) + 'd ' + Math.floor((remaining % 86400) / 3600) + 'h left';
}

function transferETA(item) {
  if (!item || item.error || item.phase === 'paused' || item.phase === 'finishing' ||
      item.phase === 'checking' || item.phase === 'preparing') return '';
  return remainingLabel(item.etaSeconds);
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
  else if (view === 'ea' || view === 'ubisoft') renderLauncher();
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
  // The device's name appears only above. Show system version, storage and
  // iDeck version in the subtitle, never duplicate model/name information.
  $('device-text').textContent = cable.status === 'connected'
    ? [info.iosVersion && `iOS ${info.iosVersion}`,
       Number.isFinite(info.freeBytes) && `${size(info.freeBytes)} free`,
       info.version && `iDeck ${info.version}`].filter(Boolean).join(' · ')
    : cable.message || 'Waiting for a device…';
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
      game.download ? `<span class="busy">${game.download.phase === 'paused' ? 'Paused' : 'Installing'} ${percent(game.download)}%</span>` : '',
      game.onIPad && !game.download ? '<span class="ipad">Device</span>' : '',
    ].join('');
    const canInstall = !game.onIPad && !game.download;
    return `<div class="card">
      <div class="cover ${canInstall ? 'cover-installable' : ''}">
        <button class="cover-details" data-card data-store="${store}" data-id="${esc(game.id)}" aria-label="Details: ${esc(game.title)}">
          ${game.cover ? `<img src="${esc(game.cover)}" loading="lazy" alt="">` : ''}
        </button>
        ${canInstall ? `<button class="cover-download" data-download data-store="${store}" data-id="${esc(game.id)}" aria-label="Install ${esc(game.title)} on iDeck"><img src="img/download.png" alt=""></button>` : ''}
      </div>
      <button class="card-title card-title-button" data-card data-store="${store}" data-id="${esc(game.id)}">${esc(game.title)}</button>
      <div class="card-meta">${meta}</div></div>`;
  }).join('')}</div>`;
  setContent(html);
}

function setContent(html) {
  if (html === lastGrid) return;
  lastGrid = html;
  $('content').innerHTML = html;
  $('content').querySelectorAll('.cover img, .transfer-cover img').forEach((img) => {
    img.addEventListener('error', () => img.remove());
  });
}

const hidden = new Set();
function itemKey(kind, item) { return kind === 'install' ? `i:${item.store}:${item.id}:${item.error || ''}` : `j:${item.id}`; }

function transferCover(store, id) {
  const game = games(store).find((candidate) => String(candidate.id) === String(id));
  const candidate = game?.cover || (store === 'steam' && /^[0-9]+$/.test(String(id)) ? steamArt(id) : '');
  // Provider images are only loaded from HTTPS, never from a local file or an
  // untrusted URL scheme received from library metadata.
  return typeof candidate === 'string' && /^https:\/\//i.test(candidate) ? candidate : '';
}

function transferArtwork(store, id) {
  const cover = transferCover(store, id);
  return `<div class="transfer-cover" aria-hidden="true">${cover ? `<img src="${esc(cover)}" loading="lazy" alt="">` : '<span>▣</span>'}</div>`;
}

function renderTasks() {
  const installs = (state.installs || []).filter((item) => !hidden.has(itemKey('install', item)));
  const jobs = (state.jobs || []).filter((job) => !hidden.has(itemKey('job', job)));
  if (!installs.length && !jobs.length) {
    setContent((transferError ? `<div class="error" role="alert">${esc(transferError)}</div>` : '') +
      emptyState('No transfers yet', 'Downloads to the connected device appear here.'));
    return;
  }
  const installHTML = installs.map((item) => `<div class="task"><div class="task-head"><div class="task-identity">
    ${transferArtwork(item.store, item.id)}
    <div class="task-copy"><div class="task-title">${esc(item.title)}</div>
    <div class="task-meta">${item.error ? `<span class="error">${esc(item.error)}</span>` : `${esc(TITLES[item.store] || item.store)} · ${esc(item.phase)} · ${percent(item)}%${transferETA(item) ? ' · ' + transferETA(item) : ''}`}</div></div></div>
    <div class="transfer-actions">
      ${!item.error && downloadControlsSupported() ? `
        <button class="secondary" data-control="${item.phase === 'paused' ? 'resume' : 'pause'}"
          data-store="${esc(item.store)}" data-id="${esc(item.id)}">${item.phase === 'paused' ? 'Resume' : 'Pause'}</button>
        <button class="secondary" data-control="stop" data-store="${esc(item.store)}" data-id="${esc(item.id)}">Stop</button>` : ''}
      ${item.error ? `<button class="link" data-hide="${esc(itemKey('install', item))}" title="Remove">✕</button>` : ''}
    </div></div>
    <div class="bar"><span class="sent" style="width:${percent(item)}%"></span></div></div>`).join('');
  const jobHTML = jobs.map((job) => {
    const done = Math.round(100 * job.done / Math.max(1, job.total));
    const speed = job.seconds > 0 ? job.bytes / job.seconds : 0;
    const jobETA = !job.finished && job.seconds > 1 && speed > 1024 && job.totalBytes > job.bytes
      ? remainingLabel((job.totalBytes - job.bytes) / speed) : '';
    return `<div class="task"><div class="task-head"><div class="task-identity">
      ${transferArtwork('steam', job.appId)}
      <div class="task-copy"><div class="task-title">${esc(job.name)}</div>
      <div class="task-meta">Processed on this PC · ${done}% · ${size(job.bytes)} of ${size(job.totalBytes)}${job.finished ? '' : ` · ${size(speed)}/s${jobETA ? ' · ' + jobETA : ''}`}${job.failed ? ` · ${job.failed} left to iDeck` : ''}</div></div></div>
      <div class="transfer-actions">
        ${!job.finished && downloadControlsSupported() && job.appId ? `
          <button class="secondary" data-control="pause" data-store="steam" data-id="${esc(job.appId)}">Pause</button>
          <button class="secondary" data-control="stop" data-store="steam" data-id="${esc(job.appId)}">Stop</button>` : ''}
        ${job.finished ? `<button class="link" data-hide="${esc(itemKey('job', job))}" title="Remove">✕</button>` : ''}
      </div></div>
      <div class="bar"><span style="width:${done}%"></span></div></div>`;
  }).join('');
  setContent(`<div class="tasks">${transferError ? `<div class="error" role="alert">${esc(transferError)}</div>` : ''}
    ${installHTML}${jobHTML}</div>`);
}

let savingSettings = false;
let settingsError = '';
let clearingCache = false;
function renderSettings() {
  const enabled = state.settings && state.settings.accelerateDownloads === true;
  const cache = state.cache || {};
  const cacheBusy = clearingCache || cache.busy;
  const cacheMessage = cache.error || (cache.result
    ? (cache.result.freedBytes > 0 ? `${size(cache.result.freedBytes)} freed.` : 'No unused cache found.')
      + (cache.result.warnings.length ? ' ' + cache.result.warnings.join(' ') : '') : '');
  setContent(`<div class="settings">
    <div class="panel settings-panel">
      <div class="settings-copy"><h3 id="acceleration-label">Accelerate downloads</h3></div>
      <button class="acceleration-switch" id="download-acceleration" role="switch" aria-checked="${enabled}"
        aria-labelledby="acceleration-label" ${savingSettings ? 'disabled' : ''}>
        <span>${savingSettings ? 'Saving…' : enabled ? 'On' : 'Off'}</span><span class="switch-track" aria-hidden="true"><span></span></span>
      </button>
    </div>
    <div class="panel settings-panel">
      <div class="settings-copy"><h3>Unused cache</h3></div>
      <button class="secondary" id="clear-unused-cache" ${cacheBusy || (state.update && state.update.busy) ? 'disabled' : ''}>${cacheBusy ? 'Clearing…' : 'Clear'}</button>
    </div>
    <p class="note" role="status" aria-live="polite">${esc(cacheMessage)}</p>
    <div class="error" role="status" aria-live="polite">${esc(settingsError)}</div>
  </div>`);
  $('clear-unused-cache').onclick = async () => {
    if (clearingCache) return;
    clearingCache = true;
    settingsError = '';
    renderSettings();
    try {
      const result = await irelay.clearUnusedCache();
      state.cache = { busy: false, result, error: '' };
    } catch (error) {
      settingsError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      clearingCache = false;
      lastGrid = '';
      render();
      if (view === 'settings') $('clear-unused-cache').focus();
    }
  };
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

function renderLauncher() {
  const launcher = view;
  const name = TITLES[launcher];
  const logo = launcher === 'ea' ? 'img/ea.jpg' : 'img/ubisoft.jpg';
  const help = launcher === 'ea'
    ? 'https://www.ea.com/ea-app'
    : 'https://www.ubisoft.com/pt-br/ubisoft-connect/download';
  const transfer = state.launcherUploads?.[launcher] || {};
  const connected = state.cable?.status === 'connected';
  const supported = connected && Number(state.cable?.device?.protocol || 0) >= 4;
  const busy = transfer.phase === 'uploading';
  setContent(`<div class="settings">
    <div class="panel">
      <div class="launcher-heading"><img src="${logo}" alt="" class="launcher-logo">
        <div><h3>${esc(name)}</h3><p class="note">Transfer the official Windows installer to iDeck over USB.</p></div></div>
      <div class="bugs-bar">
        <button class="primary" id="launcher-upload" ${!supported || busy ? 'disabled' : ''}>${busy ? 'Transferring…' : 'Transfer Windows installer'}</button>
        <button class="secondary" id="launcher-official">Official download page</button>
      </div>
      <p class="note">${!connected ? 'Connect iDeck over USB first.' :
        !supported ? 'Update iDeck to a build supporting launcher installer transfers.' :
        'Select a Windows .exe installer downloaded from the publisher.'}</p>
      <p class="note">Once transferred, open iDeck > Settings > Launchers to run the installer through Wine. Installer transfer does not guarantee launcher sign-in, DRM, or game compatibility.</p>
      <p class="${transfer.phase === 'failed' ? 'error' : 'note'}" role="status">${esc(transfer.message || '')}</p>
    </div>
  </div>`);
  $('launcher-official')?.addEventListener('click', () => irelay.openExternal(help));
  $('launcher-upload')?.addEventListener('click', async () => {
    try {
      await irelay.uploadLauncherInstaller(launcher);
    } catch (error) {
      const status = $('content').querySelector('[role="status"]');
      if (status) status.textContent = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
  });
}

function renderAbout() {
  const update = state.update || {};
  setContent(`<div class="about">
    <div class="panel"><h3>iRelay ${esc(state.version)}</h3>
      <div class="bugs-bar" style="margin:12px 0 0"><button class="primary" id="about-update" ${update.busy || (state.cache && state.cache.busy) ? 'disabled' : ''}>Update iRelay</button>
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
  if (bugAction.kind !== view) {
    bugAction = { kind: view, confirm: false, busy: false, notice: '', failed: false };
  }
  const issues = data.issues || [];
  const critical = issues.filter((line) => /error|fatal|crash|exception|failed/i.test(line)).length;
  const list = issues.map((line, index) => {
    const severe = /error|fatal|crash|exception|failed/i.test(line);
    return `<div class="bug ${severe ? 'err' : ''}">
      <span class="bug-index">${String(index + 1).padStart(2, '0')}</span>
      <span class="bug-message">${esc(line)}</span>
      <span class="bug-level ${severe ? 'critical' : ''}">${severe ? 'Error' : 'Notice'}</span>
    </div>`;
  }).join('');
  const source = view === 'bugs-irelay' ? 'iRelay' : 'iDeck';
  const status = issues.length ? 'Issues detected' : 'No issues detected';
  const available = !!(issues.length || data.log);
  const transferActive = (state.jobs || []).some((job) => !job.finished) ||
    (state.installs || []).some((item) => !['failed', 'paused', 'completed', 'installed'].includes(item.phase));
  const copyIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
  const trashIcon = '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/></svg>';
  const busy = bugAction.busy;
  const confirmation = bugAction.confirm ? `<div class="bug-confirm" role="group" aria-label="Confirm clearing ${source} logs">
    <div class="bug-confirm-copy"><strong>Clear ${source} diagnostic logs?</strong>
      <span>This cannot be undone. Installed games and settings will not be changed.</span></div>
    <div class="bug-confirm-actions">
      <button type="button" class="bug-action bug-action-neutral" id="cancel-clear-bugs">Cancel</button>
      <button type="button" class="bug-action bug-action-confirm" id="confirm-clear-bugs" ${busy ? 'disabled' : ''}>${busy ? 'Clearing…' : 'Clear logs'}</button>
    </div>
  </div>` : '';
  setContent(`<div class="bug-dashboard">
    <div class="panel bug-summary">
      <div><span class="bug-eyebrow">${source} diagnostics</span><h3>${status}</h3>
        <p>Review the reported issues and complete diagnostic log.</p></div>
      <div class="bug-count" aria-label="${issues.length} issues">${issues.length}<span>Issues</span></div>
    </div>
    <div class="bug-toolbar" aria-label="${source} report actions">
      <span class="bug-toolbar-label">${critical} critical · ${issues.length - critical} other</span>
      <div class="bug-actions">
        <button type="button" class="bug-action bug-action-copy" id="copy-bugs" ${!available || busy ? 'disabled' : ''}
          title="Copy issues and diagnostic log to clipboard">${copyIcon}<span>Copy report</span></button>
        <button type="button" class="bug-action bug-action-clear" id="clear-bugs" ${!available || busy || transferActive ? 'disabled' : ''}
          title="${transferActive ? 'Pause or finish active downloads and transfers first' : 'Clear diagnostic logs (confirmation required)'}">${trashIcon}<span>Clear logs</span></button>
      </div>
    </div>
    ${confirmation}
    ${bugAction.notice ? `<div class="bug-feedback ${bugAction.failed ? 'bug-feedback-error' : ''}" role="status" aria-live="polite">${esc(bugAction.notice)}</div>` : ''}
    <section class="panel bug-section">
      <button class="fold" id="fold-bugs" aria-expanded="${bugsOpen}" aria-controls="bug-issues">
        <span>Reported issues <span class="bug-inline-count">${issues.length}</span></span>
        <span class="fold-chevron">${bugsOpen ? '▾' : '▸'}</span>
      </button>
      ${bugsOpen ? `<div id="bug-issues" class="bugs">${list || '<p class="bug-empty">No reported issues.</p>'}</div>` : ''}
    </section>
    <section class="panel bug-section">
      <button class="fold" id="fold-log" aria-expanded="${logOpen}" aria-controls="bug-raw-log">
        <span>Diagnostic log</span><span class="fold-chevron">${logOpen ? '▾' : '▸'}</span>
      </button>
      ${logOpen ? `<pre id="bug-raw-log" class="logtail">${esc(data.log || 'No diagnostic log available.')}</pre>` : ''}
    </section>
  </div>`);
  const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
  on('copy-bugs', async () => {
    if (bugAction.busy) return;
    const kind = view;
    const report = [`${source} diagnostic report`, ...issues, '', data.log || ''].join('\n');
    try {
      await navigator.clipboard.writeText(report);
      if (view !== kind) return;
      bugAction.notice = 'Diagnostic report copied to clipboard.';
      bugAction.failed = false;
    } catch {
      if (view !== kind) return;
      bugAction.notice = 'Could not copy the report. Check clipboard permissions and try again.';
      bugAction.failed = true;
    }
    render();
  });
  on('clear-bugs', () => {
    if (bugAction.busy) return;
    bugAction.confirm = true;
    bugAction.notice = '';
    render();
    $('cancel-clear-bugs')?.focus();
  });
  on('cancel-clear-bugs', () => {
    bugAction.confirm = false;
    bugAction.notice = '';
    render();
    $('clear-bugs')?.focus();
  });
  on('confirm-clear-bugs', async () => {
    if (bugAction.busy) return;
    const kind = view;
    bugAction.busy = true;
    bugAction.notice = '';
    render();
    try {
      if (kind === 'bugs-irelay') await irelay.clearIrelayBugs();
      else await irelay.clearIdeckBugs();
      if (kind !== view) return;
      bugAction.confirm = false;
      bugAction.notice = `${source} diagnostic logs cleared.`;
      bugAction.failed = false;
      await loadBugs(kind);
    } catch (failure) {
      if (kind !== view) return;
      const reason = String(failure.message || failure).replace(/^Error invoking remote method '\w+': (Error: )?/, '');
      bugAction.notice = `Could not clear ${source} logs: ${reason}`;
      bugAction.failed = true;
    } finally {
      bugAction.busy = false;
      if (view === kind) render();
    }
  });
  on('fold-bugs', () => { bugsOpen = !bugsOpen; lastGrid = ''; render(); });
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
    actions = `<div class="task" style="margin:0"><div class="task-meta">${esc(game.download.phase)} · ${percent(game.download)}%${transferETA(game.download) ? ' · ' + transferETA(game.download) : ''}</div>
      <div class="bar"><span class="sent" style="width:${percent(game.download)}%"></span></div></div>`
      + (downloadControlsSupported() ? `<div class="transfer-actions">
        <button class="secondary" data-action="${game.download.phase === 'paused' ? 'resume-download' : 'pause-download'}">${game.download.phase === 'paused' ? 'Resume' : 'Pause'}</button>
        <button class="secondary" data-action="stop-download">Stop</button></div>` : '');
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
        ${game.size ? `<div class="status"><div class="label">${game.sizeSource === 'requirements' ? 'Minimum space' : 'Size'}</div><div class="value">${game.sizeSource === 'requirements' ? `≈ ${Number(game.requiredSpaceGB).toFixed(1)} GB` : bytes(game.size)}</div></div>` : ''}
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
    if (['pause-download', 'resume-download', 'stop-download'].includes(action)) {
      const operation = action.split('-')[0];
      if (operation === 'stop' && !confirm('Stop this transfer and remove its incomplete files?')) return;
      await irelay.controlDownload({ store: game.store, id: game.id, action: operation });
      drawerKey = '';
      lastGrid = '';
      render();
      return;
    }
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
$('content').addEventListener('click', async (event) => {
  const control = event.target.closest('[data-control]');
  if (control) {
    const action = control.dataset.control;
    if (action === 'stop' && !confirm('Stop this transfer and remove its incomplete files?')) return;
    control.disabled = true;
    transferError = '';
    try {
      await irelay.controlDownload({ store: control.dataset.store, id: control.dataset.id, action });
    } catch (error) {
      transferError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      view = 'tasks';
      document.querySelectorAll('.nav-item').forEach((item) =>
        item.classList.toggle('active', item.dataset.view === view));
    }
    lastGrid = '';
    render();
    return;
  }
  const hide = event.target.closest('[data-hide]');
  if (hide) { hidden.add(hide.dataset.hide); lastGrid = ''; render(); return; }
  const directDownload = event.target.closest('[data-download]');
  if (directDownload) {
    const store = directDownload.dataset.store;
    const id = directDownload.dataset.id;
    const game = games(store).find((item) => String(item.id) === id);
    if (!game || game.onIPad || game.download) return;
    directDownload.disabled = true;
    transferError = '';
    try {
      await irelay.install({ ...request(game), withDLC: [] });
      view = 'tasks';
      document.querySelectorAll('.nav-item').forEach((item) =>
        item.classList.toggle('active', item.dataset.view === view));
    } catch (error) {
      transferError = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    }
    lastGrid = '';
    render();
    return;
  }
  const card = event.target.closest('[data-card]');
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
