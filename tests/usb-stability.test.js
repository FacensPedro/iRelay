'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const usbmux = require('../app/usbmux');
const device = require('../app/device');

test('packaged Windows runtime must bundle Node.js 24', () => {
  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8');
  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(pkg.devDependencies.electron.split('.')[0], '42');
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /runtime check passed electron=42/);
  assert.match(main, /nodeMajor < 24/);
  assert.match(main, /Open iRelay releases/);
});

test('transient network socket errors do not trigger a fatal dialog', () => {
  const shell = fs.readFileSync(path.join(__dirname, '../shell/main.js'), 'utf8');
  assert.match(shell, /function transientUSB\(error\)/);
  assert.match(shell, /socket hang up/);
  assert.match(shell, /if \(transientUSB\(error\)\)/);
  assert.match(shell, /USB transport warning \(recoverable\)/);
});

test('a rejected usbmux handshake reduces active device writes to one', async () => {
  const original = usbmux.connect;
  const server = http.createServer();
  let active = 0;
  let peak = 0;
  server.on('request', (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    req.resume();
    req.on('end', () => setTimeout(() => {
      const data = JSON.stringify({ ok: true });
      res.writeHead(200, { 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data), 'Connection': 'keep-alive' });
      res.end(data);
      active -= 1;
    }, 20));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let rejectFirst = true;
  usbmux.connect = async (_deviceId, port) => {
    assert.equal(port, 27093);
    if (rejectFirst) {
      rejectFirst = false;
      const error = new Error('iDeck USB service unavailable');
      error.code = 'EREFUSED';
      throw error;
    }
    return new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  };
  try {
    await assert.rejects(device.info(776), /unavailable/);
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      device.write(776, 'SteamLibrary/common/Game', 'game.bin',
        i * 128, 4096, 'a'.repeat(40), Buffer.alloc(128, i))));
    assert.equal(responses.length, 10);
    assert.ok(responses.every((value) => value.ok));
    assert.equal(peak, 1, 'USB recovery must serialize writes until stable');
  } finally {
    device.closeOtherConnections(null);
    usbmux.connect = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
