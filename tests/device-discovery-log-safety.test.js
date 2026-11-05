'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/ui/renderer.js'), 'utf8');

test('fast USB scans cannot overlap and device info is reused briefly', () => {
  assert.match(main, /every\(2000, pollCable\)/);
  assert.match(main, /let cablePollInFlight = false/);
  assert.match(main, /if \(cablePollInFlight\) return;/);
  assert.match(main, /Date\.now\(\) - lastDeviceProbeAt < 5000/);
  assert.match(main, /cablePollInFlight = false;/);
});

test('connected device name is not duplicated in the metadata line', () => {
  const display = renderer.split('function renderDevice()')[1].split('function renderGate()')[0];
  assert.match(display, /info\.iosVersion/);
  assert.match(display, /info\.freeBytes/);
  assert.match(display, /info\.version/);
  assert.doesNotMatch(display, /\$\{model\}/);
  assert.doesNotMatch(display, /info\.model/);
});

test('clear logs is prevented for active PC and iDeck jobs', () => {
  const first = main.split("ipcMain.handle('clearIrelayBugs'")[1].split("ipcMain.handle('clearIdeckBugs'")[0];
  const second = main.split("ipcMain.handle('clearIdeckBugs'")[1].split("ipcMain.handle('ideckBugs'")[0];
  for (const handler of [first, second]) {
    assert.match(handler, /processor\.jobs\.values\(\)/);
    assert.match(handler, /state\.installs\.some/);
    assert.match(handler, /Finish or pause the active download and USB transfer/);
  }
});
