'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const usbmux = require('../app/usbmux');
const device = require('../app/device');

const root = path.join(__dirname, '..');
const read = (pathName) => fs.readFileSync(path.join(root, pathName), 'utf8');

test('USB requests cap at two simultaneous requests on a healthy connected iPad', async () => {
  const original = usbmux.connect;
  const server = http.createServer();
  let active = 0;
  let peak = 0;
  server.on('request', (req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    req.resume();
    req.on('end', () => setTimeout(() => {
      const body = '{"ok":true}';
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'keep-alive',
      });
      res.end(body);
      active -= 1;
    }, 25));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  usbmux.connect = async (_deviceId, port) => {
    assert.equal(port, 27093);
    return new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  };
  try {
    const requests = Array.from({ length: 12 }, (_, i) =>
      device.write(99113, 'SteamLibrary/common/Game', 'game.bin', i * 64,
        4096, 'b'.repeat(40), Buffer.alloc(64, i)));
    const results = await Promise.all(requests);
    assert.ok(results.every((value) => value.ok));
    assert.ok(peak > 0 && peak <= 2, 'healthy USB transfer should use at most two concurrent connections');
    assert.match(read('app/device.js'), /USB_RECOVERY_COOLDOWN_MS = 60000/);
    assert.match(read('app/device.js'), /USB_RAMP_SUCCESS_COUNT = 32/);
  } finally {
    device.closeOtherConnections(null);
    usbmux.connect = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('USB congestion reduces Steam in-flight chunk budget without stopping concurrent downloads', () => {
  const processor = read('app/process.js');
  assert.match(processor, /job\.usbCongested \? Math\.min\(4, this\.concurrency\)/);
  assert.match(processor, /processing \$\{job\.name\} stopped: no status polls from iDeck/);
  assert.match(processor, /error\.message !== 'Transfer stopped'/);
  assert.match(processor, /job\.failed\.push\(item\.chunk\.sha\)/);
});

test('Recoverable USB warnings are summarized without repeated stack traces', () => {
  const shell = read('shell/main.js');
  assert.match(shell, /const USB_WARNING_DEDUP_MS = 30000/);
  assert.match(shell, /recentUSBWarnings\.get\(key\)/);
  assert.match(shell, /error\?\.message \|\| error/);
  assert.match(shell, /USB transport warning \(recoverable\)/);
  assert.doesNotMatch(shell, /USB transport warning \(recoverable\): \$\{details\}/);
  assert.match(shell, /log\(.*FATAL/);
});
