'use strict';
// Builds iRelay for Windows x64:
//   dist/iRelay.exe                 one program file (no installer, nothing next to it)
//   dist/app-<version>.asar         the application archive used by updates
//   dist/app-<version>.asar.sha256  its checksum
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const builder = require('electron-builder');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const dist = path.join(root, 'dist');

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  await builder.build({ targets: builder.Platform.WINDOWS.createTarget(), publish: 'never' });
  const archive = path.join(dist, `app-${pkg.version}.asar`);
  await asar.createPackage(path.join(root, 'app'), archive);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sum}  app-${pkg.version}.asar\n`);
  console.log(`Built iRelay ${pkg.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
