'use strict';
const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clearUnusedCache } = require('../app/cache');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-cache-'));
  fs.mkdirSync(path.join(root, 'versions'));
  return root;
}
function session(before = 100, after = 0) {
  let cleared = false;
  return {
    getCacheSize: async () => cleared ? after : before,
    clearCache: async () => { cleared = true; },
  };
}

test('clears cached images and obsolete updates while preserving current, newest and user data', async () => {
  const root = fixture();
  try {
    for (const file of ['settings.json', 'device.json', 'irelay.log']) fs.writeFileSync(path.join(root, file), 'keep');
    const versions = path.join(root, 'versions');
    for (const file of ['app-3.4.0.asar', 'app-3.4.4.asar', 'app-3.4.12.asar', 'app-3.4.13.asar.part', 'notes.txt']) {
      fs.writeFileSync(path.join(versions, file), '12345');
    }
    fs.mkdirSync(path.join(versions, 'app-1.0.0.asar'));
    const result = await clearUnusedCache({ session: session(250, 30), userData: root, currentRoot: path.join(versions, 'app-3.4.4.asar') });
    assert.deepEqual(result, { freedBytes: 230, removedFiles: 2, warnings: [] });
    assert.equal(fs.existsSync(path.join(versions, 'app-3.4.0.asar')), false);
    assert.equal(fs.existsSync(path.join(versions, 'app-3.4.13.asar.part')), false);
    for (const file of ['app-3.4.4.asar', 'app-3.4.12.asar', 'notes.txt', 'app-1.0.0.asar']) assert.equal(fs.existsSync(path.join(versions, file)), true);
    for (const file of ['settings.json', 'device.json', 'irelay.log']) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), 'keep');
    const again = await clearUnusedCache({ session: session(0, 0), userData: root, currentRoot: path.join(versions, 'app-3.4.4.asar') });
    assert.deepEqual(again, { freedBytes: 0, removedFiles: 0, warnings: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('does not traverse a redirected versions directory', async () => {
  const root = fixture();
  const outside = fixture();
  try {
    const file = path.join(outside, 'app-1.0.0.asar.part');
    fs.writeFileSync(file, 'keep');
    fs.rmdirSync(path.join(root, 'versions'));
    fs.symlinkSync(outside, path.join(root, 'versions'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await clearUnusedCache({ session: session(0, 0), userData: root });
    assert.equal(result.removedFiles, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('locked files and a failed browser cache cleanup report partial results', async () => {
  const root = fixture();
  const locked = path.join(root, 'versions', 'app-1.0.0.asar.part');
  fs.writeFileSync(locked, 'locked');
  const unlink = fs.unlinkSync;
  const stub = mock.method(fs, 'unlinkSync', (file) => {
    if (file === locked) throw Object.assign(new Error('in use'), { code: 'EBUSY' });
    return unlink(file);
  });
  try {
    const result = await clearUnusedCache({
      session: { getCacheSize: async () => 100, clearCache: async () => { throw new Error('cache unavailable'); } }, userData: root,
    });
    assert.equal(result.freedBytes, 0);
    assert.equal(result.removedFiles, 0);
    assert.equal(result.warnings.length, 2);
    assert.equal(fs.existsSync(locked), true);
  } finally {
    stub.mock.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('works before updates exist and never reports negative freed space', async () => {
  const root = fixture();
  try {
    fs.rmdirSync(path.join(root, 'versions'));
    const result = await clearUnusedCache({ session: session(10, 20), userData: root });
    assert.deepEqual(result, { freedBytes: 0, removedFiles: 0, warnings: [] });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
