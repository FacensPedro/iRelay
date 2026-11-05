'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/ui/renderer.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'app/ui/styles.css'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main.js'), 'utf8');

test('Bugs toolbar has accessible icon buttons for copying and clearing', () => {
  assert.doesNotThrow(() => new Function(renderer));
  assert.match(renderer, /class="bug-action bug-action-copy" id="copy-bugs"/);
  assert.match(renderer, /class="bug-action bug-action-clear" id="clear-bugs"/);
  assert.match(renderer, /aria-hidden="true" viewBox="0 0 24 24"/);
  assert.match(renderer, /title="Copy issues and diagnostic log to clipboard"/);
  assert.match(renderer, /title="Clear diagnostic logs \(confirmation required\)"/);
  assert.match(styles, /\.bug-action:focus-visible/);
  assert.match(styles, /\.bug-action-copy:hover:not\(:disabled\)/);
  assert.match(styles, /\.bug-action-clear:hover:not\(:disabled\)/);
});

test('clearing diagnostics requires a second deliberate action', () => {
  const pos = renderer.indexOf('function renderBugs()');
  const end = renderer.indexOf('// MARK: Drawer', pos);
  const section = renderer.slice(pos, end);
  assert.match(section, /id="cancel-clear-bugs"/);
  assert.match(section, /id="confirm-clear-bugs"/);
  assert.match(section, /This cannot be undone/);
  assert.match(section, /on\('clear-bugs', \(\) => \{/);
  assert.match(section, /bugAction\.confirm = true/);
  assert.match(section, /on\('confirm-clear-bugs', async \(\) => \{/);
  assert.match(section, /bugAction\.busy = true/);
  assert.match(section, /if \(kind === 'bugs-irelay'\) await irelay\.clearIrelayBugs\(\)/);
  assert.match(section, /else await irelay\.clearIdeckBugs\(\)/);
});

test('clipboard status and clear failures are explicit', () => {
  assert.match(renderer, /await navigator\.clipboard\.writeText\(report\)/);
  assert.match(renderer, /Diagnostic report copied to clipboard/);
  assert.match(renderer, /Could not copy the report/);
  assert.match(renderer, /bug-feedback-error/);
  assert.match(renderer, /role="status" aria-live="polite"/);
  assert.match(renderer, /Could not clear/);
  const source = main.split("ipcMain.handle('clearIrelayBugs'")[1]
    .split("ipcMain.handle('clearIdeckBugs'")[0];
  assert.match(source, /fs\.writeFileSync/);
  assert.doesNotMatch(source, /catch \{ \/\* none \*\/ \}/);
  assert.match(source, /global\.irelayLogOffset = 0/);
});
