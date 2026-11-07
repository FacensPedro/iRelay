'use strict';
// Games Ubisoft Connect installed on this PC, and copying one into iDeck.
// Ubisoft Connect records each install under
//   HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\<id>  InstallDir
// iDeck receives the folder under its Ubisoft games root and starts the game's
// own executable, or Ubisoft Connect (uplay://launch/<id>/0) when installed there.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DEVICE_ROOT = 'Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games';
const REGISTRY_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs',
  'HKLM\\SOFTWARE\\Ubisoft\\Launcher\\Installs',
];

/// `reg query <key> /s` output to [{ id, installDir }].
function parseRegistry(text) {
  const games = new Map();
  let id = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const key = /\\Installs\\([0-9A-Za-z]+)$/.exec(line);
    if (key) { id = key[1]; continue; }
    const value = /^InstallDir\s+REG_SZ\s+(.+)$/i.exec(line);
    if (value && id) games.set(id, { id, installDir: value[1].trim().replace(/\//g, '\\').replace(/\\+$/, '') });
  }
  return [...games.values()];
}

function regQuery(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/s'], { windowsHide: true, timeout: 10000 }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

/// A folder name iDeck accepts: no separators, no dots at the ends.
function safeName(text) {
  const cleaned = String(text).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  return (cleaned || 'game').slice(0, 120);
}

async function folderSize(folder) {
  let total = 0;
  for (const file of walk(folder)) total += file.size;
  return total;
}

/// Ubisoft Connect's installs on this PC whose folder exists.
async function installedOnPC() {
  if (process.platform !== 'win32') return [];
  const found = new Map();
  for (const key of REGISTRY_KEYS) {
    for (const game of parseRegistry(await regQuery(key))) {
      if (found.has(game.id)) continue;
      try { if (!fs.statSync(game.installDir).isDirectory()) continue; } catch { continue; }
      found.set(game.id, { ...game, title: path.win32.basename(game.installDir), folderName: safeName(path.win32.basename(game.installDir)) });
    }
  }
  return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/// Every regular file under `folder`: { local, relative (forward slashes), size, mtime }.
function* walk(folder, base = folder) {
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { yield* walk(full, base); continue; }
    if (!entry.isFile()) continue;
    const stat = fs.statSync(full);
    yield { local: full, relative: path.relative(base, full).split(path.sep).join('/'), size: stat.size, mtime: Math.floor(stat.mtimeMs / 1000) };
  }
}

const PARALLEL_UPLOADS = 4;

/// Copies one game: only files iDeck lacks or that differ in size or time, then
/// the install record. `progress({ done, total })` follows copied bytes.
async function copyToDevice(device, deviceId, game, { progress = () => {}, cancelled = () => false } = {}) {
  const root = `${DEVICE_ROOT}/${game.folderName}`;
  const files = [...walk(game.installDir)];
  const total = files.reduce((sum, file) => sum + file.size, 0);
  let existing = new Map();
  try {
    const listing = await device.files(deviceId, root);
    existing = new Map((listing.files || []).map((file) => [file.p, file]));
  } catch { /* a first copy: nothing there yet */ }
  let done = 0;
  // Several files at once: small files no longer wait for one round trip
  // each, and the device's connection pool bounds the total.
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.min(PARALLEL_UPLOADS, queue.length) }, async () => {
    while (queue.length) {
      if (cancelled()) throw new Error('Transfer stopped');
      const file = queue.shift();
      const there = existing.get(file.relative);
      if (!there || there.s !== file.size || Math.abs((there.m || 0) - file.mtime) > 2) {
        await device.upload(deviceId, root, file.relative, file.local, file.size, file.mtime);
      }
      done += file.size;
      progress({ done, total });
    }
  }));
  await device.finish(deviceId, { store: 'ubisoft', id: game.id, title: game.title, folder: root, size: total });
  return { root, total, files: files.length };
}

module.exports = { DEVICE_ROOT, parseRegistry, safeName, installedOnPC, copyToDevice, folderSize, walk };
