'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Processor = require('../app/process');

const sha = 'f'.repeat(40);
const depot = {
  depotId: 731490,
  hosts: ['https://a.steamcontent.com', 'https://b.steamcontent.com'],
  auth: { 'https://a.steamcontent.com': '?auth=onlyA', 'https://b.steamcontent.com': '?auth=onlyB' },
};

test('HTTP 503 rotates to another authorized Steam host without failing the chunk', async () => {
  const seen = [];
  const lines = [];
  const processor = new Processor({
    write: async () => {}, onChange() {}, log: (line) => lines.push(line),
    fetcher: async (url, opts) => {
      seen.push(url);
      assert.equal(opts.redirect, 'error');
      if (url.startsWith('https://a.')) {
        return { ok: false, status: 503, headers: new Map(), body: { cancel: async () => {} } };
      }
      return { ok: true, status: 200, headers: new Map(), body: null, arrayBuffer: async () => Buffer.alloc(64) };
    },
  });
  processor.servers = { rank: async (_store, hosts) => hosts };
  const result = await processor.download(depot, sha);
  assert.equal(result.length, 64);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /a\.steamcontent\.com.*\?auth=onlyA/);
  assert.match(seen[1], /b\.steamcontent\.com.*\?auth=onlyB/);
  assert.equal(lines.filter((line) => /HTTP 503/.test(line)).length, 1);
});

test('HTTP 503 exhaustion remains bounded and never downgrades HTTPS', async () => {
  const seen = [];
  const processor = new Processor({
    write: async () => {}, onChange() {}, log() {},
    fetcher: async (url) => {
      seen.push(url);
      return { ok: false, status: 503, headers: new Map([['retry-after', '0']]), body: { cancel: async () => {} } };
    },
  });
  processor.servers = { rank: async (_, urls) => urls };
  await assert.rejects(
    processor.download({ depotId: 731490, hosts: ['https://a.steamcontent.com'] }, sha),
    /HTTP 503|remained unavailable/,
  );
  assert.ok(seen.length <= 6, 'retry budget must stay bounded');
  assert.ok(seen.every((url) => url.startsWith('https://a.steamcontent.com/')));
});

test('Steam authentication fragments never become part of logs', async () => {
  const lines = [];
  const processor = new Processor({
    write: async () => {}, onChange() {}, log: (line) => lines.push(line),
    fetcher: async () => ({
      ok: false, status: 503, headers: new Map(), body: { cancel: async () => {} },
    }),
  });
  processor.servers = { rank: async (_, urls) => urls };
  await assert.rejects(processor.download({
    depotId: 731490,
    hosts: ['https://a.steamcontent.com', 'https://b.steamcontent.com'],
    auth: { 'https://a.steamcontent.com': '?auth=secret', 'https://b.steamcontent.com': '?auth=secret2' },
  }, sha));
  assert.equal(lines.some((line) => line.includes('secret')), false);
});
