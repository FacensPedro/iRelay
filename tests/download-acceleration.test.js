'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Settings = require('../app/settings');
const Processor = require('../app/process');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function request(count) {
  return { appId: 1, depots: [{ files: [{ chunks: Array.from({ length: count }, (_, i) => ({ sha: String(i), size: 10, compressed: 5 })) }] }] };
}

function processor(onChange = () => {}) {
  const value = new Processor({ write: async () => {}, onChange, log: () => {} });
  value.pool = { resize() {} };
  return value;
}

test('setting persists across restarts, validates input and survives failed writes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'irelay-settings-'));
  try {
    const file = path.join(directory, 'settings.json');
    const settings = new Settings(file);
    assert.equal(settings.value.accelerateDownloads, false);
    assert.equal(settings.setDownloadAcceleration(true).accelerateDownloads, true);
    assert.equal(new Settings(file).value.accelerateDownloads, true);
    settings.setDownloadAcceleration(false);
    assert.equal(new Settings(file).value.accelerateDownloads, false);
    assert.throws(() => settings.setDownloadAcceleration('true'), TypeError);
    fs.mkdirSync(`${file}.tmp`);
    assert.throws(() => settings.setDownloadAcceleration(true), /Could not save settings/);
    assert.equal(settings.value.accelerateDownloads, false);
    assert.equal(new Settings(file).value.accelerateDownloads, false);
    fs.rmdirSync(`${file}.tmp`);
    settings.pair('192.168.1.20', '12 34');
    assert.deepEqual(new Settings(file).value.pairings, { '192.168.1.20': '1234' });
    assert.equal(new Settings(file).value.selected, '192.168.1.20');
    assert.throws(() => settings.pair('ipad.local', '1234'), /iPad address/);
    assert.throws(() => settings.pair('192.168.1.21', '12A4'), /pairing code/);
    settings.unpair('192.168.1.20');
    assert.deepEqual(new Settings(file).value.pairings, {});
    assert.equal(new Settings(file).value.selected, null);
    fs.writeFileSync(file, '{bad json');
    assert.equal(new Settings(file).value.accelerateDownloads, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('acceleration changes a running transfer and disabling drains to the normal limit', async () => {
  const value = processor();
  const pending = [];
  let calls = 0;
  value.one = () => { calls++; return new Promise((resolve) => pending.push(resolve)); };
  const job = value.start(request(500));
  await flush();
  assert.equal(calls, 24);
  value.setAccelerated(true);
  await flush();
  const acceleratedLimit = value.concurrency;
  assert.ok(acceleratedLimit >= 32 && acceleratedLimit <= 64);
  assert.ok(value.workerCount <= 4, 'acceleration must not launch excessive CPU workers');
  assert.equal(calls, acceleratedLimit);
  value.setAccelerated(false);
  pending.splice(0, acceleratedLimit - 24).forEach((resolve) => resolve());
  await flush();
  assert.equal(calls, acceleratedLimit);
  pending.shift()();
  await flush();
  assert.equal(calls, acceleratedLimit + 1);
  value.cancel(job.id);
  pending.splice(0).forEach((resolve) => resolve());
  await flush();
  assert.equal(calls, acceleratedLimit + 1);
  assert.equal(job.finished, true);
  assert.equal(job.chunksDone, acceleratedLimit + 1);
  assert.equal(job.failed.length, 500 - acceleratedLimit - 1);
  assert.equal(job.chunksDone + job.failed.length, job.total);
});

test('accelerated scheduler processes every chunk once and preserves failures for iDeck', async () => {
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const value = processor(() => { if ([...value.jobs.values()].some((job) => job.finished)) finish(); });
  value.setAccelerated(true);
  const seen = new Set();
  value.one = async (item) => {
    assert.equal(seen.has(item.chunk.sha), false);
    seen.add(item.chunk.sha);
    if (item.chunk.sha === '2') throw new Error('verification failed');
  };
  const job = value.start(request(100));
  await completed;
  assert.equal(seen.size, 100);
  assert.equal(job.chunksDone, 99);
  assert.equal(job.bytesDone, 990);
  assert.deepEqual(value.status(job.id).failed, ['2']);
  assert.equal(job.pump, undefined);
});

test('abandoned transfers stop instead of scheduling new chunks', async () => {
  const value = processor();
  const pending = [];
  let calls = 0;
  value.one = () => { calls++; return new Promise((resolve) => pending.push(resolve)); };
  const job = value.start(request(80));
  await flush();
  job.polled = Date.now() - 91000;
  pending.splice(0).forEach((resolve) => resolve());
  await flush();
  assert.equal(calls, 24);
  assert.equal(job.cancelled, true);
  assert.equal(job.finished, true);
  assert.equal(job.failed.length, 56);
});
