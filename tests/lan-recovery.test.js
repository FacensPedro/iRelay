'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const Processor = require('../app/process');
const Relay = require('../app/relay');
const lan = require('../app/lan');

test('a transient network refusal retries the same decoded Steam chunk', async () => {
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
  assert.equal(saved.filter((line) => /Connection interrupted/.test(line)).length, 1);
});

test('tunnel refill runs once when polls overlap and each tunnel starts with the pairing code', async () => {
  const oldConnect = lan.connect;
  let handshakes = 0;
  const preambles = [];
  lan.connect = async () => {
    handshakes += 1;
    await new Promise((resolve) => setImmediate(resolve));
    const socket = new EventEmitter();
    socket.write = (text) => preambles.push(text);
    return socket;
  };
  try {
    const relay = new Relay({ rankServers: async () => [] });
    await Promise.all([
      relay.tunnels([{ id: '192.168.1.20', code: 'ABCDEFGH' }]),
      relay.tunnels([{ id: '192.168.1.20', code: 'ABCDEFGH' }]),
      relay.tunnels([{ id: '192.168.1.20', code: 'ABCDEFGH' }]),
    ]);
    assert.equal(handshakes, 3, '3 idle sockets must not become 9 during repeated polls');
    assert.equal(relay.idle.get('192.168.1.20'), 3);
    assert.deepEqual(preambles, ['IRELAY ABCDEFGH\n', 'IRELAY ABCDEFGH\n', 'IRELAY ABCDEFGH\n']);
  } finally {
    lan.connect = oldConnect;
  }
});

test('a single failed iDeck probe keeps the same iPad during bounded recovery', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const network = fs.readFileSync(path.join(__dirname, '../app/lan.js'), 'utf8');
  assert.match(main, /RECOVERY_GRACE_MS = 45000/);
  assert.match(main, /deviceId = recovering \? host : null/);
  assert.match(network, /socket\.on\('error', \(\) => \{\}\)/);
  assert.match(network, /CONNECT_TIMEOUT_MS/);
});

test('pairing codes are normalized and only private addresses are scanned', () => {
  assert.equal(lan.normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(lan.normalizeCode('ABCD EFGH'), 'ABCDEFGH');
  assert.equal(lan.normalizeCode('ABCD1FGH'), null);
  assert.equal(lan.isIPv4('192.168.0.4'), true);
  assert.equal(lan.isIPv4('ideck.local'), false);
  for (const prefix of lan.localPrefixes()) assert.match(prefix, /^(10|172|192)\./);
});

test('no USB transport remains', () => {
  for (const name of ['usbmux.js', 'lockdown.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '../app', name)), false);
  }
  const device = fs.readFileSync(path.join(__dirname, '../app/device.js'), 'utf8');
  assert.match(device, /'X-iDeck-Code': codes\.get\(deviceId\)/);
  assert.match(device, /lan\.connect\(deviceId, SERVICE_PORT\)/);
});
