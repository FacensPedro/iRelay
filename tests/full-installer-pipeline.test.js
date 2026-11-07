'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Processor = require('../app/process');

const root = path.join(__dirname, '..');
function code(name) { return fs.readFileSync(path.join(root, name), 'utf8'); }

test('the updater stages a verified full installer, not only an ASAR', () => {
  const updater = code('app/updater.js');
  const workflow = code('.github/workflows/build.yml');
  const main = code('app/main.js');
  const shell = code('shell/main.js');
  assert.match(updater, /iRelay-.*-win-x64\.zip/);
  assert.match(updater, /sha256/);
  assert.match(updater, /Readable\.fromWeb/);
  assert.match(updater, /pipeline\(/);
  assert.match(updater, /tar\.exe/);
  assert.match(updater, /iRelay-Setup\.exe/);
  assert.match(updater, /shell\.openPath\(file\)/);
  assert.doesNotMatch(updater, /app\.relaunch|\.asar\.part/);
  assert.match(main, /updater\.check\(INSTALLED_VERSION/);
  assert.match(main, /updater\.prepare\(/);
  assert.match(main, /updater\.install\(/);
  assert.match(main, /Finish or pause active transfers before updating/);
  assert.doesNotMatch(main, /updater\.restart\(/);
  assert.match(shell, /require\(path\.join\(bundledRoot, 'main\.js'\)\)/);
  assert.doesNotMatch(shell, /newestUpdate\(\)/);
  assert.match(workflow, /dist\/iRelay-\*-win-x64\.zip\.sha256/);
  assert.match(workflow, /Get-FileHash/);
  assert.match(workflow, /tar\.exe -xf/);
  assert.match(workflow, /"dist\/iRelay-\$VERSION-win-x64\.zip\.sha256"/);
});

test('congested delivery backs down decoded chunk buffering and restores full concurrency', () => {
  const notices = [];
  const proc = new Processor({ write: async () => {}, onChange() {}, log: (line) => notices.push(line) });
  const job = {
    name: 'Test Game', usbCongested: false, usbSlowStreak: 0,
    usbHealthyStreak: 0, usbCongestionEvents: 0,
  };
  for (let n = 0; n < 4; n += 1) proc.noteUSBDelivery(job, 2500);
  assert.equal(job.usbCongested, true);
  assert.equal(job.usbCongestionEvents, 1);
  for (let n = 0; n < 16; n += 1) proc.noteUSBDelivery(job, 100);
  assert.equal(job.usbCongested, false);
  assert.ok(notices.some((line) => /iDeck delivery congested/.test(line)));
  assert.ok(notices.some((line) => /iDeck delivery recovered/.test(line)));
  proc.noteUSBDelivery(job, 0, true);
  assert.equal(job.usbCongested, true);
  assert.equal(job.usbCongestionEvents, 2);
});

test('adaptive congestion does not disable concurrent downloads', async () => {
  const proc = new Processor({ write: async () => {}, onChange() {}, log() {} });
  proc.pool = { resize() {} };
  const outstanding = [];
  proc.one = async () => new Promise((resolve) => outstanding.push(resolve));
  const queue = Array.from({ length: 100 }, (_, i) => ({ sha: String(i), size: 128, compressed: 96 }));
  const job = proc.start({ appId: 10, name: 'Test', depots: [{ files: [{ chunks: queue }] }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outstanding.length, 24);
  job.usbCongested = true;
  // Once in-flight requests finish, the next round remains pipelined, capped
  // at four instead of downloading everything before sending it.
  const first = outstanding.splice(0, 24);
  for (const resolve of first) resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outstanding.length, 4);
  proc.cancel(job.id);
  outstanding.splice(0).forEach((resolve) => resolve());
  await job.completion;
  assert.equal(job.finished, true);
});
