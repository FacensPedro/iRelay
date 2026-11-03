'use strict';
// Updates iRelay at start without an installer: the newest release's
// application archive (app-X.Y.Z.asar, checked against its SHA-256) is saved
// to %APPDATA%\iRelay\versions and iRelay restarts into it (see shell/main.js).
const crypto = require('crypto');
const path = require('path');
const fs = require('original-fs');
const { app } = require('electron');

const REPO = 'FacensPedro/iRelay';

function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

async function json(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'iRelay', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/// Resolves with the version installed (iRelay should restart), or null.
async function check(current, status) {
  status('Checking for updates…');
  const release = await json(`https://api.github.com/repos/${REPO}/releases/latest`);
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newer(version, current)) return null;
  const name = `app-${version}.asar`;
  const asset = (release.assets || []).find((item) => item.name === name);
  const hash = (release.assets || []).find((item) => item.name === `${name}.sha256`);
  if (!asset || !hash) return null;
  status(`Downloading iRelay ${version}…`);
  const [data, sum] = await Promise.all([
    fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120000) }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(hash.browser_download_url, { signal: AbortSignal.timeout(20000) }).then((r) => r.text()),
  ]);
  const buffer = Buffer.from(data);
  const expected = sum.trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expected !== actual) throw new Error('The update did not match its checksum');
  const dir = path.join(app.getPath('userData'), 'versions');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  fs.writeFileSync(`${target}.part`, buffer);
  fs.renameSync(`${target}.part`, target);
  // Older downloads are no longer needed.
  for (const old of fs.readdirSync(dir)) {
    if (old !== name && /^app-.*\.asar(\.part)?$/.test(old)) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* in use until restart */ }
    }
  }
  return version;
}

module.exports = { check };
