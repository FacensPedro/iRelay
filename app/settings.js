'use strict';
const fs = require('fs');
const path = require('path');

class Settings {
  constructor(file) {
    this.file = file;
    this.value = { accelerateDownloads: false };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value.accelerateDownloads = saved.accelerateDownloads === true;
    } catch { /* Defaults on first start or an unreadable settings file. */ }
  }

  setDownloadAcceleration(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid download acceleration setting.');
    const next = { ...this.value, accelerateDownloads: enabled };
    const temporary = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* No temporary file. */ }
      throw new Error(`Could not save settings: ${error.message}`);
    }
    this.value = next;
    return { ...next };
  }
}

module.exports = Settings;
