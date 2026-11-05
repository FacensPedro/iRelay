'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { Readable } = require('node:stream');
const Processor = require('../app/process');
const Relay = require('../app/relay');
const steamchunk = require('../app/steamchunk');
const fs = require('node:fs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('Steam chunks retain AES-256 decryption and strict constant-time digest validation', () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const plain = Buffer.alloc(4096, 0x21);
  const ecb = crypto.createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const wrappedIV = Buffer.concat([ecb.update(iv), ecb.final()]);
  const cbc = crypto.createCipheriv('aes-256-cbc', key, iv);
  const raw = Buffer.concat([wrappedIV, cbc.update(plain), cbc.final()]);
  const sha = crypto.createHash('sha1').update(plain).digest('hex');
  const checksum = steamchunk.adler32(plain);
  assert.deepEqual(steamchunk.decode(raw, key.toString('hex'), plain.length, checksum, sha, null), plain);
  assert.throws(() => steamchunk.decode(raw, 'ab', plain.length, checksum, sha, null), /AES-256 depot key/);
  assert.throws(() => steamchunk.decode(raw, key.toString('hex'), plain.length, checksum, 'bad', null), /chunk digest/);
  assert.throws(() => steamchunk.decode(raw, key.toString('hex'), plain.length, checksum, '0'.repeat(40), null), /SHA-1 mismatch/);
});

test('Steam downloads use verified provider HTTPS hosts and reject redirects', async () => {
  const requested = [];
  const processor = new Processor({
    write: async () => {}, log: () => {}, onChange: () => {},
    fetcher: async (url, options) => {
      requested.push({ url, options });
      return { ok: true, headers: new Map(), body: Readable.from([Buffer.alloc(64)]) };
    },
  });
  processor.servers = { rank: async (store, urls) => {
    assert.equal(store, 'steam');
    return urls;
  } };
  const sha = 'a'.repeat(40);
  const data = await processor.download({
    depotId: 42,
    hosts: ['http://bad.steamcontent.com', 'https://127.0.0.1', 'https://cdn.steamcontent.com'],
    auth: { 'https://cdn.steamcontent.com': '?token=example' },
  }, sha);
  assert.equal(data.length, 64);
  assert.deepEqual(requested.map((r) => r.url), [
    'https://cdn.steamcontent.com/depot/42/chunk/' + sha + '?token=example',
  ]);
  assert.equal(requested[0].options.redirect, 'error');
  await assert.rejects(processor.download({ depotId: 42, hosts: ['http://cdn.steamcontent.com'] }, sha), /verified HTTPS/);
  await assert.rejects(processor.download({ depotId: 42, hosts: ['https://cdn.steamcontent.com'] }, '../../etc'), /chunk digest/);
});

test('accelerated queue limits in-flight decoded data without throttling the network', async () => {
  const pending = [];
  const processor = new Processor({ write: async () => {}, log: () => {}, onChange: () => {} });
  processor.pool = { resize() {} };
  processor.one = () => new Promise((resolve) => pending.push(resolve));
  processor.setAccelerated(true);
  assert.ok(processor.workerCount <= 4);
  const chunks = Array.from({ length: 40 }, (_, index) => ({
    sha: String(index), size: 4 * 1024 * 1024, compressed: 2 * 1024 * 1024,
  }));
  const job = processor.start({ appId: 1, depots: [{ files: [{ chunks }] }] });
  await flush();
  // Each in-flight chunk reserves 2x decoded + 2x compressed (12 MiB).
  assert.equal(pending.length, 5);
  pending.shift()();
  await flush();
  assert.equal(pending.length, 5, 'the freed memory slot is reused immediately');
  processor.cancel(job.id);
  pending.splice(0).forEach((resolve) => resolve());
  await flush();
  assert.equal(job.finished, true);
  assert.equal(job.chunksDone, 6);
  assert.equal(job.failed.length, 34);
});

test('relay HTTP endpoints are accessible through USB sockets, not a listening Windows TCP port', async () => {
  const relay = new Relay({ rankServers: async () => [] }, () => {});
  relay.start();
  assert.equal(relay.server.listening, false);
  const bridge = net.createServer((socket) => relay.serve(1, socket));
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  try {
    const payload = await new Promise((resolve, reject) => {
      const socket = net.connect(bridge.address().port, '127.0.0.1');
      socket.setTimeout(5000, () => socket.destroy(new Error('USB relay test timed out')));
      let response = '';
      socket.on('connect', () =>
        socket.write('GET /ping HTTP/1.1\r\nHost: ideck\r\nConnection: close\r\n\r\n'));
      socket.on('data', (chunk) => { response += chunk.toString('utf8'); });
      socket.on('end', () => resolve(response));
      socket.on('error', reject);
    });
    assert.match(payload, /HTTP\/1\.1 200/);
    assert.match(payload, /"name":"iRelay"/);
  } finally {
    bridge.closeAllConnections?.();
    await new Promise((resolve) => bridge.close(resolve));
    relay.server.closeAllConnections?.();
    // An HTTP parser that was never bound to TCP does not need close().
  }
});

test('About does not disclose connected-device details', () => {
  const renderer = fs.readFileSync(require('node:path').join(__dirname, '../app/ui/renderer.js'), 'utf8');
  const about = renderer.split('function renderAbout() {')[1].split('// MARK: Bugs')[0];
  assert.doesNotMatch(about, /state\.cable\.message/);
  assert.doesNotMatch(about, /device-title|device-text|connected device/i);
});
