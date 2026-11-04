'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('iRelay forwards pause, resume and stop to the device instead of discarding local progress', () => {
  const device = read('app/device.js');
  const main = read('app/main.js');
  const preload = read('app/preload.js');
  const renderer = read('app/ui/renderer.js');
  assert.match(device, /controlDownload:.*POST.*\/downloads\/control/);
  assert.match(preload, /controlDownload:.*invoke\('controlDownload'/);
  assert.match(main, /ipcMain\.handle\('controlDownload'/);
  assert.match(main, /device\.controlDownload\(deviceId, \{ store, id, action \}\)/);
  assert.match(renderer, /data-control="\$\{item\.phase === 'paused' \? 'resume' : 'pause'\}"/);
  assert.match(renderer, /data-control="stop"/);
  assert.match(renderer, /data-action="stop-download"/);
  assert.match(renderer, /irelay\.controlDownload\(/);
});

test('acceleration setting has concise explanatory text and retains its toggle', () => {
  const renderer = read('app/ui/renderer.js');
  assert.match(renderer, /Use all available bandwidth for Steam downloads\./);
  assert.match(renderer, /No speed cap\. Uses more CPU and memory\./);
  assert.match(renderer, /id="download-acceleration"/);
});
