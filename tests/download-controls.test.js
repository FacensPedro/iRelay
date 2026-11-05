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

test('settings show only control labels without explanatory paragraphs', () => {
  const renderer = read('app/ui/renderer.js');
  assert.match(renderer, /id="download-acceleration"/);
  assert.match(renderer, /aria-labelledby="acceleration-label"/);
  assert.match(renderer, /<h3 id="acceleration-label">Accelerate downloads<\/h3>/);
  assert.match(renderer, /<h3>Unused cache<\/h3>/);
  assert.match(renderer, /cacheBusy \? 'Clearing…' : 'Clear'/);
  assert.doesNotMatch(renderer, /acceleration-description/);
  assert.doesNotMatch(renderer, /No speed cap\. Uses more CPU and memory/);
  assert.doesNotMatch(renderer, /Remove cached images, incomplete updates/);
});

test('settings panels have vertical spacing between download acceleration and unused cache', () => {
  const styles = read('app/ui/styles.css');
  assert.match(styles, /\.settings > \.settings-panel \+ \.settings-panel \{ margin-top: 20px; \}/);
});

test('game size displays published minimum storage instead of silently hiding a missing Steam depot size', () => {
  const renderer = read('app/ui/renderer.js');
  assert.match(renderer, /sizeSource: game\.sizeSource \|\| 'metadata'/);
  assert.match(renderer, /requiredSpaceGB: game\.requiredSpaceGB \|\| 0/);
  assert.match(renderer, /game\.sizeSource === 'requirements' \? 'Minimum space' : 'Size'/);
  assert.match(renderer, /Number\(game\.requiredSpaceGB\)\.toFixed\(1\)/);
});
