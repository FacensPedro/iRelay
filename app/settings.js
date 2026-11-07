'use strict';
const fs = require('fs');
const path = require('path');
const lan = require('./lan');

/// iRelay's settings: download acceleration and the iPads paired over the local
/// network ({ address: pairing code }) with the one in use.
class Settings {
  constructor(file) {
    this.file = file;
    this.value = { accelerateDownloads: false, pairings: {}, deviceIds: {}, selected: null };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.value.accelerateDownloads = saved.accelerateDownloads === true;
      for (const [host, code] of Object.entries(saved.pairings || {})) {
        if (lan.isIPv4(host) && lan.normalizeCode(code)) this.value.pairings[host] = lan.normalizeCode(code);
      }
      for (const [host, id] of Object.entries(saved.deviceIds || {})) {
        if (Object.hasOwn(this.value.pairings, host) && typeof id === 'string' && id) this.value.deviceIds[host] = id;
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
    const deviceIds = { ...(this.value.deviceIds || {}) };
    delete pairings[host];
    delete deviceIds[host];
    const selected = this.value.selected === host ? (Object.keys(pairings)[0] || null) : this.value.selected;
    return this.save({ ...this.value, pairings, deviceIds, selected });
  }

  /// Remembers the identifier iDeck reports for a paired address.
  setDeviceId(host, id) {
    if (!Object.hasOwn(this.value.pairings, host) || typeof id !== 'string' || !id) return { ...this.value };
    if ((this.value.deviceIds || {})[host] === id) return { ...this.value };
    return this.save({ ...this.value, deviceIds: { ...(this.value.deviceIds || {}), [host]: id } });
  }

  /// The paired iPad now answers at another address (a new DHCP lease):
  /// moves its pairing code and identifier there.
  move(from, to) {
    if (!Object.hasOwn(this.value.pairings, from) || !lan.isIPv4(to) || from === to) return { ...this.value };
    const pairings = { ...this.value.pairings };
    const deviceIds = { ...(this.value.deviceIds || {}) };
    pairings[to] = pairings[from];
    if (deviceIds[from]) deviceIds[to] = deviceIds[from];
    delete pairings[from];
    delete deviceIds[from];
    const selected = this.value.selected === from ? to : this.value.selected;
    return this.save({ ...this.value, pairings, deviceIds, selected });
  }

  select(host) {
    if (!Object.hasOwn(this.value.pairings, host)) throw new Error('Pair this iPad first.');
    return this.save({ ...this.value, selected: host });
  }
}

module.exports = Settings;
