'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ubisoft = require('../app/ubisoft');

test('Ubisoft Connect installs are read from reg query output', () => {
  const text = [
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\46',
    '    InstallDir    REG_SZ    C:/Program Files (x86)/Ubisoft/Ubisoft Game Launcher/games/Far Cry 3/',
    '',
    'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\635',
    '    InstallDir    REG_SZ    D:\\Games\\Assassins Creed Origins\\',
  ].join('\r\n');
  assert.deepEqual(ubisoft.parseRegistry(text), [
    { id: '46', installDir: 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\games\\Far Cry 3' },
    { id: '635', installDir: 'D:\\Games\\Assassins Creed Origins' },
  ]);
  assert.equal(ubisoft.safeName('..Far: Cry?3. '), 'Far_ Cry_3');
});

test('a Ubisoft copy sends only changed files, then the install record', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-ubi-'));
  try {
    fs.mkdirSync(path.join(folder, 'bin'));
    fs.writeFileSync(path.join(folder, 'bin', 'game.exe'), 'MZ-game');
    fs.writeFileSync(path.join(folder, 'data.pak'), 'data');
    const dataTime = Math.floor(fs.statSync(path.join(folder, 'data.pak')).mtimeMs / 1000);
    const calls = [];
    const device = {
      files: async (_id, root) => { calls.push(['files', root]); return { files: [{ p: 'data.pak', s: 4, m: dataTime }] }; },
      upload: async (_id, root, relative, local, size) => { calls.push(['upload', root, relative, size]); },
      finish: async (_id, payload) => { calls.push(['finish', payload]); },
    };
    const game = { id: '46', title: 'Far Cry 3', installDir: folder, folderName: 'Far Cry 3' };
    const result = await ubisoft.copyToDevice(device, '10.0.0.2', game);
    const root = `${ubisoft.DEVICE_ROOT}/Far Cry 3`;
    assert.deepEqual(calls, [
      ['files', root],
      ['upload', root, 'bin/game.exe', 7],
      ['finish', { store: 'ubisoft', id: '46', title: 'Far Cry 3', folder: root, size: 11 }],
    ]);
    assert.equal(result.files, 2);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('launcher installer transfers are gone and EA installs go to iDeck', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../app/ui/renderer.js'), 'utf8');
  assert.equal(fs.existsSync(path.join(__dirname, '../app/launcher-installers.js')), false);
  assert.doesNotMatch(main + renderer, /uploadLauncherInstaller|Transfer Windows installer/);
  assert.match(main, /else if \(request\.store === 'ea'\) body\.id = String\(request\.id \|\| ''\);/);
  assert.match(main, /library\.ubisoft = await ubisoftLibrary\(library\.ubisoft\);/);
  assert.match(renderer, /if \(game\.store === 'ea'\) return \{ store: 'ea', id: game\.id, title: game\.title \};/);
});
