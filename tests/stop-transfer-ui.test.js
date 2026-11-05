'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Processor = require('../app/process');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test('stopping a Steam transfer drains in-flight PC writes before device cleanup', async () => {
  const pending = [];
  const processor = new Processor({ write: async () => {}, onChange() {}, log() {} });
  processor.pool = { resize() {} };
  processor.one = (_chunk, job) => new Promise((resolve) => {
    pending.push({ resolve, job });
  });
  const job = processor.start({
    appId: 731490, name: 'Test game',
    depots: [{ files: [{ chunks: [{ sha: 'a'.repeat(40), size: 4096, compressed: 1024 }] }] }],
  });
  await nextTick();
  assert.equal(pending.length, 1);
  let settled = false;
  const cleanup = processor.cancelApp(731490).then(() => { settled = true; });
  await nextTick();
  assert.equal(job.cancelled, true);
  assert.equal(settled, false, 'cleanup must not happen before the last write finishes');
  pending[0].resolve();
  await cleanup;
  assert.equal(job.finished, true);
  assert.equal(settled, true);
});

test('Stop pauses iDeck then drains Steam processing before discarding staged installation', () => {
  const main = read('app/main.js');
  const start = main.indexOf("ipcMain.handle('controlDownload'");
  const end = main.indexOf("ipcMain.handle('uninstall'", start);
  const block = main.slice(start, end);
  const pause = block.indexOf("action: 'pause'");
  const drain = block.indexOf("processor.cancelApp(id)");
  const remove = block.indexOf("device.controlDownload(deviceId, { store, id, action })");
  assert.ok(pause >= 0 && drain > pause && remove > drain);
  assert.match(block, /await refreshLibrary\(\)/);
});

test('Transfers show compact game artwork and Bugs pages have summary and diagnostic sections', () => {
  const renderer = read('app/ui/renderer.js');
  const css = read('app/ui/styles.css');
  assert.match(renderer, /transferArtwork\(item.store, item.id\)/);
  assert.match(renderer, /transferArtwork\('steam', job.appId\)/);
  assert.match(renderer, /class="bug-summary"/);
  assert.match(renderer, /class="bug-toolbar-label"/);
  assert.match(renderer, /aria-expanded="\$\{bugsOpen\}"/);
  assert.match(css, /\.transfer-cover \{/);
  assert.match(css, /\.bug-dashboard \{/);
});
