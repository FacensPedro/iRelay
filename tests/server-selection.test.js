'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ServerSelector = require('../app/servers');

test('CDN selection probes public official hosts and prefers the shortest HTTPS round trip', async () => {
  const seen = [];
  const selector = new ServerSelector({
    fetcher: async (url, options) => {
      seen.push({ url, options });
      await new Promise((resolve) => setTimeout(resolve, url.includes('slow.') ? 20 : 2));
      return { status: 403, body: { cancel: async () => {} } };
    },
  });
  const original = ['https://slow.steamcontent.com', 'https://fast.steamcontent.com'];
  const ranked = await selector.rank('steam', original);
  assert.deepEqual(ranked, [...original].reverse());
  assert.equal(seen.length, 2);
  assert.ok(seen.every(({ url, options }) => options.method === 'HEAD' && url.endsWith('/')));
  await selector.rank('steam', original);
  assert.equal(seen.length, 2, 'subsequent jobs use the cached latencies');
});

test('reject private and non-provider hosts from latency probes', async () => {
  const called = [];
  const selector = new ServerSelector({
    fetcher: async (url) => { called.push(url); return { status: 200 }; },
  });
  const urls = [
    'https://127.0.0.1/',
    'https://localhost/',
    'http://cdn.gog.com',
    'https://private.example.net',
    'https://cdn.gog.com',
  ];
  assert.deepEqual(await selector.rank('gog', urls), [urls[4], ...urls.slice(0, 4)]);
  assert.deepEqual(called, ['https://cdn.gog.com/']);
  assert.equal(ServerSelector.origin('steam', 'https://localhost'), null);
  assert.equal(ServerSelector.origin('steam', 'https://example.org'), null);
});

test('GOG and Epic server ranking use provider allowlists and preserve fallback order', async () => {
  const selector = new ServerSelector({
    fetcher: async (url) => ({ status: url.includes('fast.') ? 200 : 500 }),
  });
  assert.deepEqual(await selector.rank('gog', [
    'https://slow.gogcdn.net/path', 'https://fast.gog.com/path',
  ]), ['https://fast.gog.com/path', 'https://slow.gogcdn.net/path']);
  assert.deepEqual(await selector.rank('epic', [
    'https://slow.epicgames.com/path', 'https://fast.cloudfront.net/path',
  ]), ['https://fast.cloudfront.net/path', 'https://slow.epicgames.com/path']);

  const failed = new ServerSelector({ fetcher: async () => { throw new Error('offline'); } });
  const sources = ['https://slow.steamcontent.com', 'https://fast.steamcontent.com'];
  assert.deepEqual(await failed.rank('steam', sources), sources);
});
