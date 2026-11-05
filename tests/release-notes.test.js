'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const notes = fs.readFileSync(path.join(root, 'RELEASE_NOTES.md'), 'utf8').replace(/\r\n/g, '\n');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/build.yml'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('release notes use the current version and an English-only changelog', () => {
  assert.ok(notes.startsWith(`# iRelay ${version}\n\n## What's Changed\n`));
  assert.match(notes, /^- [A-Z][^\n]+\.$/m);
  assert.doesNotMatch(notes, /[^\x09\x0A\x0D\x20-\x7E]/);
  assert.doesNotMatch(notes, /\b(?:O que mudou|Adicionado|Alterações|Configurações|Corrigido|Atualização)\b/i);
  assert.doesNotMatch(notes, /(?:github\.com\/[^\s]+\/pull\/|\b(?:author|contributor|pull request)\b)/i);
});

test('release workflow uses reviewed English notes for new and existing releases', () => {
  assert.match(workflow, /gh release create "v\$VERSION"/);
  assert.match(workflow, /--title "iRelay \$VERSION" --notes-file RELEASE_NOTES\.md/);
  assert.match(workflow, /gh release edit "v\$VERSION" --title "iRelay \$VERSION" --notes-file RELEASE_NOTES\.md/);
  assert.doesNotMatch(workflow, /--generate-notes/);
});
