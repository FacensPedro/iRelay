'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const device = require('../app/device');
const usbmux = require('../app/usbmux');

async function withMockDevice(run) {
  const original = usbmux.connect;
  let connections = 0;
  let activeConnections = 0;
  let peakConnections = 0;
  let transferred = 0;
  let uploads = 0;
  const server = http.createServer((req, res) => {
    let length = 0;
    req.on('data', (chunk) => { length += chunk.length; });
    req.on('end', () => {
      transferred += length;
      if (req.url.startsWith('/file?')) uploads += 1;
      const body = JSON.stringify(req.url === '/info'
        ? { protocol: 3, name: 'Test iDeck' }
        : { ok: true, received: length });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'keep-alive',
      });
      res.end(body);
    });
  });
  server.keepAliveTimeout = 10000;
  server.on('connection', (socket) => {
    connections += 1;
    activeConnections += 1;
    peakConnections = Math.max(peakConnections, activeConnections);
    socket.once('close', () => { activeConnections -= 1; });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  usbmux.connect = async (_deviceId, port) => {
    assert.equal(port, 27093);
    return await new Promise((resolve, reject) => {
      const socket = net.connect(server.address().port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  };
  try {
    await run(() => ({ connections, peakConnections, transferred, uploads }));
  } finally {
    device.closeOtherConnections(null);
    usbmux.connect = original;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Steam chunk writes reuse USB connections with at most eight live sockets', async () => {
  await withMockDevice(async (stats) => {
    for (let i = 0; i < 20; i += 1) {
      const result = await device.write(42, 'SteamLibrary/common/Game', 'game.bin',
        i * 128, 50000, 'a'.repeat(40), Buffer.alloc(128, i));
      assert.equal(result.received, 128);
    }
    assert.equal(stats().connections, 1, 'sequential transfers must reuse the same USB tunnel');

    const values = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      device.write(42, 'SteamLibrary/common/Game', 'game.bin',
        i * 1024, 65536, 'a'.repeat(40), Buffer.alloc(1024, i))));
    assert.equal(values.length, 40);
    assert.ok(values.every((v) => v.received === 1024));
    assert.ok(stats().peakConnections <= 4, 'pool must cap simultaneously active USB sockets; peak=' + stats().peakConnections);
  });
});

test('large file uploads stream over USB with fixed-size buffers', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-usb-stream-'));
  const filename = path.join(directory, 'payload.bin');
  const bytes = 3 * 1024 * 1024 + 123;
  fs.writeFileSync(filename, Buffer.alloc(bytes, 0x5a));
  try {
    await withMockDevice(async (stats) => {
      const response = await device.upload(43, 'GOG Games/Game', 'payload.bin',
        filename, bytes, 1700000000);
      assert.equal(response.received, bytes);
      assert.equal(stats().uploads, 1);
      assert.equal(stats().transferred, bytes);
      const info = await device.info(43);
      assert.equal(info.protocol, 3);
      assert.equal(stats().connections, 1, 'the uploaded file must leave the USB socket reusable');
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
