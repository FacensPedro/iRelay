'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('launcher installer transfers are gone and EA installs go to iDeck', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../app/ui/renderer.js'), 'utf8');
  assert.equal(fs.existsSync(path.join(__dirname, '../app/launcher-installers.js')), false);
  assert.doesNotMatch(main + renderer, /uploadLauncherInstaller|Transfer Windows installer/);
  assert.match(main, /else if \(request\.store === 'ea'\) body\.id = String\(request\.id \|\| ''\);/);
  assert.doesNotMatch(main, /ubisoft/i);
  assert.match(renderer, /if \(game\.store === 'ea'\) return \{ store: 'ea', id: game\.id, title: game\.title \};/);
});


test('EA app tab renders their game libraries instead of the About updater', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../app/ui/renderer.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../app/ui/index.html'), 'utf8');
  assert.match(html, /id="count-ea"/);
  assert.doesNotMatch(html + renderer, /ubisoft/i);
  assert.equal(fs.existsSync(path.join(__dirname, '../app/ubisoft.js')), false);
  assert.match(renderer, /const library = \['steam', 'epic', 'gog', 'ea'\]\.includes\(view\);/);
  assert.match(renderer, /if \(library\) renderLibrary\(\);/);
  assert.match(renderer, /for \(const store of \['steam', 'epic', 'gog', 'ea'\]\)/);
  assert.match(renderer, /else renderAbout\(\);/);
});
