'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const lan = require('../app/lan');
const device = require('../app/device');

const root = path.join(__dirname, '..');
const read = (pathName) => fs.readFileSync(path.join(root, pathName), 'utf8');

test('Network requests cap at four simultaneous requests on a healthy connected iPad', async () => {
  const original = lan.connect;
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
  lan.connect = async (_deviceId, port) => {
    assert.equal(port, 27093);
    return new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  };
  try {
    const requests = Array.from({ length: 12 }, (_, i) =>
      device.write('10.0.0.113', 'SteamLibrary/common/Game', 'game.bin', i * 64,
        4096, 'b'.repeat(40), Buffer.alloc(64, i)));
    const results = await Promise.all(requests);
    assert.ok(results.every((value) => value.ok));
    assert.ok(peak > 2 && peak <= 4, 'a healthy transfer uses up to four concurrent connections; peak=' + peak);
    assert.match(read('app/device.js'), /RECOVERY_COOLDOWN_MS = 60000/);
    assert.match(read('app/device.js'), /RAMP_SUCCESS_COUNT = 32/);
  } finally {
    device.closeOtherConnections(null);
    lan.connect = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Network congestion reduces Steam in-flight chunk budget without stopping concurrent downloads', () => {
  const processor = read('app/process.js');
  assert.match(processor, /job\.usbCongested \? Math\.min\(4, this\.concurrency\)/);
  assert.match(processor, /processing \$\{job\.name\} stopped: no status polls from iDeck/);
  assert.match(processor, /error\.message !== 'Transfer stopped'/);
  assert.match(processor, /job\.failed\.push\(item\.chunk\.sha\)/);
});

test('Recoverable network warnings are summarized without repeated stack traces', () => {
  const shell = read('shell/main.js');
  assert.match(shell, /const NETWORK_WARNING_DEDUP_MS = 30000/);
  assert.match(shell, /recentNetworkWarnings\.get\(key\)/);
  assert.match(shell, /error\?\.message \|\| error/);
  assert.match(shell, /Network warning \(recoverable\)/);
  assert.doesNotMatch(shell, /Network warning \(recoverable\): \$\{details\}/);
  assert.match(shell, /log\(.*FATAL/);
});
