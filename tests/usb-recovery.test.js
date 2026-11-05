'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Processor = require('../app/process');
const Relay = require('../app/relay');
const usbmux = require('../app/usbmux');

test('a transient USB refusal retries the same decoded Steam chunk', async () => {
  let attempts = 0;
  const saved = [];
  const processor = new Processor({
    onChange() {}, log: (line) => saved.push(line),
    write: async (_root, _file, _offset, _size, _sha, data) => {
      attempts += 1;
      if (attempts < 3) throw new Error('iDeck is not listening');
      assert.equal(data.length, 128);
    },
  });
  processor.download = async () => Buffer.alloc(40);
  processor.pool = { decode: async () => Buffer.alloc(128) };
  await processor.one({
    depot: { root: 'Steam', key: 'a'.repeat(64) },
    file: { path: 'game.bin', size: 128 },
    chunk: { sha: 'b'.repeat(40), size: 128, offset: 0, crc: 0 },
  }, { cancelled: false });
  assert.equal(attempts, 3);
  assert.equal(saved.filter((line) => /USB interrupted/.test(line)).length, 1);
});

test('usb tunnel refill runs once when multiple connection polls overlap', async () => {
  const oldConnect = usbmux.connect;
  let handshakes = 0;
  usbmux.connect = async () => {
    handshakes += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return new EventEmitter();
  };
  try {
    const relay = new Relay({ rankServers: async () => [] });
    await Promise.all([
      relay.tunnels([{ id: 7 }]),
      relay.tunnels([{ id: 7 }]),
      relay.tunnels([{ id: 7 }]),
    ]);
    assert.equal(handshakes, 3, '3 idle sockets must not become 9 during repeated polls');
    assert.equal(relay.idle.get(7), 3);
  } finally {
    usbmux.connect = oldConnect;
  }
});

test('a single failed iDeck probe keeps the same USB device during bounded recovery', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const mux = fs.readFileSync(path.join(__dirname, '../app/usbmux.js'), 'utf8');
  assert.match(main, /CABLE_RECOVERY_GRACE_MS = 45000/);
  assert.match(main, /deviceId = recovering \? current\.id : null/);
  assert.match(mux, /error\.code = 'ETIMEDOUT'/);
  assert.match(mux, /socket\.on\('error', \(\) => \{\}\)/);
});
