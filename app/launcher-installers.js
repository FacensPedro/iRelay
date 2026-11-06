'use strict';

// Windows launcher installers are transferred only after explicit user selection.
// This validates the PE container and architecture, not the publisher's signature.
const fs = require('fs');

const targets = Object.freeze({
  ea: Object.freeze({ root: 'WindowsDownloads/Launchers/EA', name: 'EAappInstaller.exe' }),
  ubisoft: Object.freeze({ root: 'WindowsDownloads/Launchers/Ubisoft', name: 'UbisoftConnectInstaller.exe' }),
});

async function validateWindowsInstaller(local) {
  const stat = await fs.promises.stat(local);
  if (!stat.isFile() || stat.size < 1024 || stat.size > 500 * 1024 * 1024) {
    throw new Error('The installer must be a Windows executable smaller than 500 MB.');
  }
  const handle = await fs.promises.open(local, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== 64 ||
        dos[0] !== 0x4d || dos[1] !== 0x5a) {
      throw new Error('Selected file is not a Windows PE executable.');
    }
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > stat.size - 6) {
      throw new Error('Invalid Windows executable header.');
    }
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, 6, peOffset)).bytesRead !== 6 ||
        pe[0] !== 0x50 || pe[1] !== 0x45 || pe[2] !== 0 || pe[3] !== 0 ||
        ![0x014c, 0x8664].includes(pe.readUInt16LE(4))) {
      throw new Error('Unsupported Windows installer architecture.');
    }
  } finally {
    await handle.close();
  }
  return stat;
}

module.exports = { targets, validateWindowsInstaller };
