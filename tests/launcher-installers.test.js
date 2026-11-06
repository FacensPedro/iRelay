'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { targets, validateWindowsInstaller } = require('../app/launcher-installers');

test('launcher transfer destinations are fixed and separated', () => {
  assert.equal(targets.ea.root, 'WindowsDownloads/Launchers/EA');
  assert.equal(targets.ea.name, 'EAappInstaller.exe');
  assert.equal(targets.ubisoft.root, 'WindowsDownloads/Launchers/Ubisoft');
  assert.equal(targets.ubisoft.name, 'UbisoftConnectInstaller.exe');
});

test('installer validation accepts PE x86/x64, rejects invalid headers and machines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-launcher-'));
  const file = path.join(dir, 'installer.exe');
  const sample = Buffer.alloc(1024);
  sample.write('MZ', 0, 'ascii');
  sample.writeUInt32LE(128, 0x3c);
  sample.write('PE', 128, 'ascii');
  sample.writeUInt16LE(0x8664, 132);
  try {
    fs.writeFileSync(file, sample);
    const valid = await validateWindowsInstaller(file);
    assert.equal(valid.size, 1024);
    sample.writeUInt16LE(0x014c, 132);
    fs.writeFileSync(file, sample);
    await validateWindowsInstaller(file);

    sample.writeUInt16LE(0x01c4, 132);
    fs.writeFileSync(file, sample);
    await assert.rejects(validateWindowsInstaller(file), /architecture/);

    sample.writeUInt16LE(0x8664, 132);
    sample.write('NO', 128, 'ascii');
    fs.writeFileSync(file, sample);
    await assert.rejects(validateWindowsInstaller(file), /architecture/);

    sample.write('PE', 128, 'ascii');
    sample.writeUInt32LE(1023, 0x3c);
    fs.writeFileSync(file, sample);
    await assert.rejects(validateWindowsInstaller(file), /header/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
