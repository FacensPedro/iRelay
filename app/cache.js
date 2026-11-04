'use strict';
const path = require('path');
let fs;
try { fs = require('original-fs'); } catch { fs = require('fs'); }

function compare(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

async function clearUnusedCache({ session, userData, currentRoot }) {
  const result = { freedBytes: 0, removedFiles: 0, warnings: [] };
  try {
    const before = await session.getCacheSize();
    await session.clearCache();
    const after = await session.getCacheSize();
    result.freedBytes += Math.max(0, before - after);
  } catch {
    result.warnings.push('Some cached images could not be removed.');
  }

  const directory = path.join(userData, 'versions');
  let entries;
  try {
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return result;
    entries = fs.readdirSync(directory).flatMap((name) => {
      const match = /^app-(\d+\.\d+\.\d+)\.asar(\.part)?$/.exec(name);
      if (!match) return [];
      const file = path.join(directory, name);
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return [];
      return [{ file, version: match[1], partial: !!match[2], bytes: info.size }];
    });
  } catch (error) {
    if (error.code !== 'ENOENT') result.warnings.push('Some unused update files could not be inspected.');
    return result;
  }
  const newest = entries.filter((entry) => !entry.partial).sort((a, b) => compare(b.version, a.version))[0];
  const current = currentRoot ? path.resolve(currentRoot) : null;
  for (const entry of entries) {
    if (path.resolve(entry.file) === current || entry === newest) continue;
    try {
      fs.unlinkSync(entry.file);
      result.freedBytes += entry.bytes;
      result.removedFiles++;
    } catch {
      if (!result.warnings.includes('Some unused update files could not be removed.')) {
        result.warnings.push('Some unused update files could not be removed.');
      }
    }
  }
  return result;
}

module.exports = { clearUnusedCache };
