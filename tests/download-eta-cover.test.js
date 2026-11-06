'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const renderer = fs.readFileSync(path.join(__dirname, '../app/ui/renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../app/ui/styles.css'), 'utf8');

test('display remaining time only for active measured transfers', () => {
  assert.match(renderer, /function remainingLabel\(seconds\)/);
  assert.match(renderer, /Number\.isFinite\(value\)/);
  assert.match(renderer, /function transferETA\(item\)/);
  assert.match(renderer, /item\.phase === 'paused'/);
  assert.match(renderer, /job\.totalBytes > job\.bytes/);
  assert.match(renderer, /transferETA\(game\.download\)/);
});

test('download action is separate from clickable details and overlay blurs cover', () => {
  assert.match(renderer, /data-card data-store/);
  assert.match(renderer, /data-download data-store/);
  assert.match(renderer, /data-download\]/);
  assert.match(renderer, /await irelay\.install/);
  assert.match(renderer, /img\/download\.png/);
  assert.match(css, /\.cover-installable \.cover-details img/);
  assert.match(css, /filter: blur\(3px\)/);
  assert.match(css, /\.cover-download/);
  assert.ok(fs.statSync(path.join(__dirname, '../app/ui/img/download.png')).size > 100);
});
