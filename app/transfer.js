'use strict';
// Copies an install folder on the PC into iDeck's install folder over the
// cable: only files iDeck does not have, or has with another size or date.
// Files only iDeck has (saves, settings) are left alone.
const fs = require('fs');
const path = require('path');
const device = require('./device');

async function walk(folder) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(path.join(folder, relative), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) {
        const stat = await fs.promises.stat(path.join(folder, child));
        files.push({ p: child, s: stat.size, m: Math.floor(stat.mtimeMs / 1000), full: path.join(folder, child) });
      }
    }
  }
  return files;
}

/// Sends `folder` to `root` on the device; `progress({ done, total, file })`.
/// Resolves with the relative paths that were sent.
async function sync(deviceId, root, folder, progress, cancelled) {
  progress({ phase: 'Comparing files', done: 0, total: 0 });
  const [local, remote] = await Promise.all([walk(folder), device.files(deviceId, root)]);
  const there = new Map((remote.files || []).map((file) => [file.p, file]));
  const todo = local.filter((file) => {
    const other = there.get(file.p);
    return !other || other.s !== file.s || Math.abs(other.m - file.m) > 2;
  });
  const total = todo.reduce((sum, file) => sum + file.s, 0);
  let done = 0;
  let next = 0;
  const sent = [];
  async function worker() {
    while (next < todo.length) {
      if (cancelled()) throw new Error('Cancelled');
      const file = todo[next];
      next += 1;
      let attempt = 0;
      for (;;) {
        try {
          await device.upload(deviceId, root, file.p, file.full, file.s, file.m);
          break;
        } catch (error) {
          attempt += 1;
          if (attempt >= 3 || /space|507/i.test(error.message)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
      done += file.s;
      sent.push(file.p);
      progress({ phase: 'Copying to iPad', done, total, file: file.p, files: sent.length, fileCount: todo.length });
    }
  }
  progress({ phase: 'Copying to iPad', done, total, files: 0, fileCount: todo.length });
  await Promise.all([worker(), worker(), worker(), worker()]);
  return sent;
}

module.exports = { sync };
