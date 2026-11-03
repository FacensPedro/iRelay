'use strict';
// Updates iRelay without an installer: the newest release's application
// archive (app-X.Y.Z.asar, checked against its SHA-256) is saved to
// %APPDATA%\iRelay\versions and iRelay restarts into it (see shell/main.js).
// Runs at start and from the Update button. A private repository's releases
// need a GitHub token (About › GitHub token), kept encrypted by Windows.
const crypto = require('crypto');
const path = require('path');
const fs = require('original-fs');
const { app, safeStorage } = require('electron');

const REPO = 'FacensPedro/iRelay';

function tokenFile() { return path.join(app.getPath('userData'), 'github-token.bin'); }

function getToken() {
  try {
    const data = fs.readFileSync(tokenFile());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(data) : '';
  } catch { return ''; }
}

function setToken(token) {
  const value = String(token || '').trim();
  if (!value) { try { fs.unlinkSync(tokenFile()); } catch { /* none */ } return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows cannot encrypt the token on this PC.');
  fs.mkdirSync(path.dirname(tokenFile()), { recursive: true });
  fs.writeFileSync(tokenFile(), safeStorage.encryptString(value));
}

function headers(accept) {
  const token = getToken();
  return { 'User-Agent': 'iRelay', Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/// An asset's bytes through the API (works for private repositories). The
/// redirect to GitHub's storage is followed without the token.
async function asset(item, timeout) {
  const first = await fetch(item.url, { headers: headers('application/octet-stream'), redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  let response = first;
  if (first.status >= 300 && first.status < 400 && first.headers.get('location')) {
    response = await fetch(first.headers.get('location'), { signal: AbortSignal.timeout(timeout) });
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/// { version, installed } — installed is the version saved (restart into it),
/// null when this is already the newest.
async function check(current, status) {
  status('Checking for updates…');
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`,
    { headers: headers('application/vnd.github+json'), signal: AbortSignal.timeout(10000) });
  if (response.status === 404) {
    throw new Error(getToken()
      ? 'GitHub refused the token, or there is no release yet.'
      : 'The repository is private: add a GitHub token in About, or make the repository public.');
  }
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
  const release = await response.json();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The latest release has no version number.');
  if (!newer(version, current)) return { version, installed: null };
  const name = `app-${version}.asar`;
  const archive = (release.assets || []).find((item) => item.name === name);
  const hash = (release.assets || []).find((item) => item.name === `${name}.sha256`);
  if (!archive || !hash) throw new Error(`Release ${version} has no update archive.`);
  status(`Downloading iRelay ${version}…`);
  const [buffer, sum] = await Promise.all([asset(archive, 180000), asset(hash, 20000)]);
  const expected = sum.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expected !== actual) throw new Error('The update did not match its checksum.');
  const dir = path.join(app.getPath('userData'), 'versions');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(`${target}.part`, buffer);
  fs.renameSync(`${target}.part`, target);
  for (const old of fs.readdirSync(dir)) {
    if (old !== name && /^app-.*\.asar(\.part)?$/.test(old)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* in use until restart */ }
    }
  }
  return { version, installed: version };
}

/// Restarts iRelay into the downloaded version (the installed iRelay.exe; for
/// an older portable copy, the file the user opened).
function restart() {
  const execPath = process.env.PORTABLE_EXECUTABLE_FILE;
  app.releaseSingleInstanceLock();
  app.relaunch(execPath ? { execPath } : undefined);
  app.exit(0);
}

module.exports = { check, restart, getToken, setToken };
