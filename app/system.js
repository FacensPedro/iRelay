'use strict';
const { execFile } = require('child_process');

/// Runs a Windows program and returns its standard output ('' on failure).
function run(file, args, timeout = 10000) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? '' : String(stdout || ''));
    });
  });
}

/// Whether a process with this image name is running.
async function isRunning(image) {
  const out = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH']);
  return out.toLowerCase().includes(`"${image.toLowerCase()}"`);
}

/// Values under a registry key: { keyPath: { name: value } } (reg.exe, read only).
async function registry(key, recursive = false) {
  const out = await run('reg.exe', ['query', key, ...(recursive ? ['/s'] : [])]);
  const result = {};
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      current = line.trim();
      result[current] = result[current] || {};
      continue;
    }
    const match = /^\s+(.+?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (match && current) result[current][match[1]] = match[3];
  }
  return result;
}

module.exports = { run, isRunning, registry };
