'use strict';
// lockdownd (port 62078 on the device), reached through usbmux, as iloader
// does (through jkcoxson's idevice crate): the device's name, model and iOS
// version. These values are answered before a session is started; the device
// must still trust this PC (usbmux keeps that pair record).
const usbmux = require('./usbmux');

const LOCKDOWN_PORT = 62078;

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function message(entries) {
  const body = Object.entries(entries).map(([key, value]) => `<key>${escape(key)}</key><string>${escape(value)}</string>`).join('');
  const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    + `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(xml.length, 0);
  return Buffer.concat([header, xml]);
}

function unescape(text) {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/// Asks lockdownd for several values on one connection.
async function values(deviceId, keys, timeout = 4000) {
  const socket = await usbmux.connect(deviceId, LOCKDOWN_PORT);
  return new Promise((resolve, reject) => {
    const result = {};
    let buffer = Buffer.alloc(0);
    let index = 0;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('lockdownd timeout')); }, timeout);
    const next = () => {
      if (index >= keys.length) {
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
        return;
      }
      socket.write(message({ Label: 'iRelay', Request: 'GetValue', Key: keys[index] }));
    };
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) return;
        const xml = buffer.subarray(4, 4 + length).toString('utf8');
        buffer = buffer.subarray(4 + length);
        const value = /<key>Value<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
        if (value) result[keys[index]] = unescape(value[1]);
        index += 1;
        next();
      }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    next();
  });
}

const MODELS = {
  iPad: 'iPad', iPhone: 'iPhone', iPod: 'iPod touch',
};

/// { name, model, productType, iosVersion } for a cabled device.
async function deviceInfo(deviceId) {
  const info = await values(deviceId, ['DeviceName', 'DeviceClass', 'ProductType', 'ProductVersion']);
  return {
    name: info.DeviceName || 'Device',
    model: MODELS[info.DeviceClass] || info.DeviceClass || 'Device',
    productType: info.ProductType || '',
    iosVersion: info.ProductVersion || '',
  };
}

module.exports = { deviceInfo, values };
