'use strict';
// Full iRelay upgrades are made with the verified Windows installer, not by
// replacing app.asar alone. The installer updates Electron/Node, shell,
// resources and native dependencies together; a declined UAC leaves the
// currently installed program intact.
const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('original-fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { app, shell } = require('electron');

const REPO = 'FacensPedro/iRelay';
const MAX_INSTALLER_ZIP_BYTES = 450 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function newer(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

function approvedAsset(item, version, filename) {
  if (!item || item.name !== filename) return false;
  try {
    const url = new URL(item.browser_download_url);
    const prefix = '/' + REPO + '/releases/download/v' + version + '/';
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.username === '' && url.password === '' && url.port === '' &&
      url.pathname === prefix + filename && url.search === '';
  } catch {
    return false;
  }
}

async function latestRelease() {
  const response = await fetch('https://api.github.com/repos/' + REPO + '/releases/latest', {
    headers: { 'User-Agent': 'iRelay', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) throw new Error('The public iRelay release is unavailable.');
  if (!response.ok) throw new Error('GitHub release check HTTP ' + response.status);
  return response.json();
}

// Only inspect version at startup: do not download or install a whole EXE
// while the user has an active USB transfer or has not approved an installer.
async function check(current, status) {
  status('Checking for updates…');
  const release = await latestRelease();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('The latest release has no valid version number.');
  }
  return { version, available: newer(version, current), release };
}

async function responseFor(item, version, name) {
  if (!approvedAsset(item, version, name)) {
    throw new Error('Update asset is not from the official iRelay release.');
  }
  const response = await fetch(item.browser_download_url, {
    headers: { 'User-Agent': 'iRelay' },
    signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) throw new Error('Release download HTTP ' + response.status);
  return response;
}

function checksumText(text, filename) {
  const match = /^([a-f0-9]{64})\s+\*?([^\r\n]+)\s*$/i.exec(text.trim());
  if (!match || match[2].trim() !== filename) {
    throw new Error('Installer ZIP has no valid SHA-256 receipt.');
  }
  return match[1].toLowerCase();
}

async function prepare(release, status) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid installer version.');
  const name = 'iRelay-' + version + '-win-x64.zip';
  const assets = release.assets || [];
  const archive = assets.find((item) => approvedAsset(item, version, name));
  const receipt = assets.find((item) => approvedAsset(item, version, name + '.sha256'));
  if (!archive || !receipt) {
    throw new Error('This release has no verified full Windows installer. Download it from the official Releases page.');
  }
  status('Verifying complete iRelay installer…');
  const hashResponse = await responseFor(receipt, version, name + '.sha256');
  const hashText = await hashResponse.text();
  if (hashText.length > 256) throw new Error('Invalid installer checksum size.');
  const expected = checksumText(hashText, name);

  const root = path.join(app.getPath('userData'), 'updates');
  const folder = path.join(root, version);
  fs.mkdirSync(folder, { recursive: true });
  const zip = path.join(folder, name);
  const temp = zip + '.part';
  const installer = path.join(folder, 'iRelay-Setup.exe');
  try {
    status('Downloading full iRelay ' + version + ' update…');
    const response = await responseFor(archive, version, name);
    if (!response.body) throw new Error('Installer download had no content.');
    let total = 0;
    const digest = crypto.createHash('sha256');
    const verify = new Transform({
      transform(chunk, _encoding, done) {
        total += chunk.length;
        if (total > MAX_INSTALLER_ZIP_BYTES) {
          done(new Error('Installer package exceeds the safety limit.'));
          return;
        }
        digest.update(chunk);
        done(null, chunk);
      },
    });
    fs.rmSync(temp, { force: true });
    await pipeline(Readable.fromWeb(response.body), verify, fs.createWriteStream(temp, { flags: 'wx' }));
    if (digest.digest('hex') !== expected) throw new Error('Full installer ZIP SHA-256 mismatch.');
    fs.renameSync(temp, zip);

    // Windows 11 ships tar.exe (libarchive), which can safely select one named
    // entry from a ZIP. Never run script files or unpack arbitrary paths.
    status('Preparing verified iRelay installer…');
    fs.rmSync(installer, { force: true });
    await execFileAsync(process.platform === 'win32' ? 'tar.exe' : 'tar',
      ['-xf', zip, '-C', folder, 'iRelay-Setup.exe'],
      { timeout: 120000, windowsHide: true });
    const details = fs.lstatSync(installer);
    if (!details.isFile() || details.isSymbolicLink() || details.size < 1024 * 1024) {
      throw new Error('The release does not contain a valid full Windows installer.');
    }
    return { version, installer };
  } catch (error) {
    fs.rmSync(temp, { force: true });
    fs.rmSync(installer, { force: true });
    throw error;
  }
}

async function install(prepared) {
  const file = prepared?.installer;
  if (typeof file !== 'string' || path.basename(file) !== 'iRelay-Setup.exe' ||
      !path.isAbsolute(file) || !fs.statSync(file).isFile()) {
    throw new Error('The verified installer is not available.');
  }
  // NSIS requests administrator approval if the existing per-machine install
  // needs it. Do not force a silent update or claim success before Windows
  // finishes the installer. Its runAfterFinish starts the new executable.
  const error = await shell.openPath(file);
  if (error) throw new Error('Windows could not open the installer: ' + error);
  app.quit();
}

module.exports = { check, prepare, install, newer, checksumText, approvedAsset };
