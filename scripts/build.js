'use strict';
// Builds iRelay for Windows x64:
//   dist/iRelay-win32-x64/          the program folder (no installer)
//   dist/app-<version>.asar         the application archive used by updates
//   dist/app-<version>.asar.sha256  its checksum
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { packager } = require('@electron/packager');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const dist = path.join(root, 'dist');
const stage = path.join(dist, 'stage');

async function main() {
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.cpSync(path.join(root, 'shell'), path.join(stage, 'shell'), { recursive: true });
  fs.cpSync(path.join(root, 'app'), path.join(stage, 'app'), { recursive: true });
  const { devDependencies, scripts, ...manifest } = pkg;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));

  await packager({
    dir: stage,
    out: dist,
    name: 'iRelay',
    executableName: 'iRelay',
    platform: 'win32',
    arch: 'x64',
    asar: true,
    overwrite: true,
    prune: true,
    icon: path.join(root, 'assets', 'icon.ico'),
    appVersion: pkg.version,
    buildVersion: pkg.version,
    appCopyright: 'Copyright © FacensPedro',
    win32metadata: {
      CompanyName: 'FacensPedro',
      FileDescription: 'iRelay - copies PC games to iDeck over USB',
      ProductName: 'iRelay',
      InternalName: 'iRelay',
      OriginalFilename: 'iRelay.exe',
    },
  });

  const archive = path.join(dist, `app-${pkg.version}.asar`);
  await asar.createPackage(path.join(root, 'app'), archive);
  const sum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(`${archive}.sha256`, `${sum}  app-${pkg.version}.asar\n`);
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Built iRelay ${pkg.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
