'use strict';
const fs = require('fs');
const path = require('path');
const lan = require('./lan');

/// iRelay's settings: download acceleration and the iPads paired over the local
/// network ({ address: pairing code }) with the one in use.
class Settings {
  constructor(file) {
    this.file = file;
    this.value = { accelerateDownloads: false, pairings: {}, selected: null };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value.accelerateDownloads = saved.accelerateDownloads === true;
      for (const [host, code] of Object.entries(saved.pairings || {})) {
        if (lan.isIPv4(host) && lan.normalizeCode(code)) this.value.pairings[host] = lan.normalizeCode(code);
      }
      if (Object.hasOwn(this.value.pairings, saved.selected)) this.value.selected = saved.selected;
    } catch { /* Defaults on first start or an unreadable settings file. */ }
  }

  save(next) {
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

  setDownloadAcceleration(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid download acceleration setting.');
    return this.save({ ...this.value, accelerateDownloads: enabled });
  }

  pair(host, code) {
    const normalized = lan.normalizeCode(code);
    if (!lan.isIPv4(host)) throw new Error('Enter the iPad address shown in iDeck > Settings > iRelay.');
    if (!normalized) throw new Error('Enter the 8-character pairing code shown in iDeck > Settings > iRelay.');
    return this.save({ ...this.value, pairings: { ...this.value.pairings, [host]: normalized }, selected: host });
  }

  unpair(host) {
    const pairings = { ...this.value.pairings };
    delete pairings[host];
    const selected = this.value.selected === host ? (Object.keys(pairings)[0] || null) : this.value.selected;
    return this.save({ ...this.value, pairings, selected });
  }

  select(host) {
    if (!Object.hasOwn(this.value.pairings, host)) throw new Error('Pair this iPad first.');
    return this.save({ ...this.value, selected: host });
  }
}

module.exports = Settings;
