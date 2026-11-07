'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const root = path.join(__dirname, '..');
const Settings = require('../app/settings');
const Relay = require('../app/relay');

test('pairing form never reads fields a state update has just rebuilt', () => {
  const renderer = fs.readFileSync(path.join(root, 'app/ui/renderer.js'), 'utf8');
  const submit = renderer.split("target.id === 'pair-submit'")[1].split('} else if')[0];
  assert.doesNotMatch(submit, /\$\('pair-host'\)\.value/);
  assert.doesNotMatch(submit, /\$\('pair-code'\)\.value/);
  assert.match(submit, /irelay\.pairDevice\(host, code\)/);
  // The draft is taken before the "Connecting…" render that rebuilds the panel.
  assert.ok(submit.indexOf('pairDraft.host') < submit.indexOf('render()'));
  assert.match(renderer, /value="\$\{esc\(pairDraft\.host\)\}"/);
  assert.match(renderer, /value="\$\{esc\(pairDraft\.code\)\}"/);
  assert.match(renderer, /if \(event\.target\.id === 'pair-code'\) pairDraft\.code = event\.target\.value;/);
});

test('pairing waits for a poll already in flight', () => {
  const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8');
  const pair = main.split("ipcMain.handle('pairDevice'")[1].split('ipcMain.handle(')[0];
  assert.match(pair, /relay\?\.allow\(address\)/);
  assert.match(pair, /await pollCable\(\{ fresh: true \}\)/);
});

test('a paired iPad keeps its code and identifier when its address changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-pair-'));
  const file = path.join(dir, 'settings.json');
  const settings = new Settings(file);
  settings.pair('192.168.1.20', 'abcd-efgh');
  settings.setDeviceId('192.168.1.20', 'DEVICE-1');
  settings.move('192.168.1.20', '192.168.1.33');
  const reloaded = new Settings(file);
  assert.deepEqual(reloaded.value.pairings, { '192.168.1.33': 'ABCDEFGH' });
  assert.deepEqual(reloaded.value.deviceIds, { '192.168.1.33': 'DEVICE-1' });
  assert.equal(reloaded.value.selected, '192.168.1.33');
  reloaded.unpair('192.168.1.33');
  assert.deepEqual(new Settings(file).value.deviceIds, {});
});

test('a tunnel refused by iDeck stops further tunnels until paired again', async () => {
  const preambles = [];
  const server = net.createServer((socket) => {
    socket.once('data', (data) => {
      preambles.push(data.toString());
      socket.end('IRELAY-DENIED\n');
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(27091, '127.0.0.1', resolve); });
  try {
    const relay = new Relay({}, () => {});
    relay.start();
    const denied = new Promise((resolve) => { relay.onDenied = resolve; });
    await relay.tunnels([{ id: '127.0.0.1', code: 'ABCDEFGH' }]);
    assert.equal(await denied, '127.0.0.1');
    assert.ok(relay.denied.has('127.0.0.1'));
    assert.equal(preambles[0], 'IRELAY ABCDEFGH\n');
    const opened = preambles.length;
    relay.idle.clear();
    await relay.tunnels([{ id: '127.0.0.1', code: 'ABCDEFGH' }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(preambles.length, opened);
    relay.allow('127.0.0.1');
    assert.ok(!relay.denied.has('127.0.0.1'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Ubisoft copies upload several files at once', () => {
  const ubisoft = fs.readFileSync(path.join(root, 'app/ubisoft.js'), 'utf8');
  assert.match(ubisoft, /const PARALLEL_UPLOADS = 4;/);
  assert.match(ubisoft, /Promise\.all\(Array\.from\(\{ length: Math\.min\(PARALLEL_UPLOADS, queue\.length\) \}/);
  const device = fs.readFileSync(path.join(root, 'app/device.js'), 'utf8');
  assert.match(device, /const MAX_DEVICE_SOCKETS = 4;/);
  assert.match(device, /highWaterMark: 1024 \* 1024/);
});
