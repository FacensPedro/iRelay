'use strict';
// Apple's usbmux on Windows (Apple Mobile Device Service, installed with the
// Apple Devices app or iTunes) on 127.0.0.1:27015. It lists the iPhones and
// iPads connected by cable that trust this PC and opens TCP connections to a
// port on one of them. iDeck listens on such ports; this is the only way
// iRelay talks to it.
const net = require('net');

const MUX_PORT = 27015;

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function plist(entries) {
  const body = Object.entries(entries).map(([key, value]) =>
    `<key>${escape(key)}</key>` + (typeof value === 'number' ? `<integer>${value}</integer>` : `<string>${escape(value)}</string>`)).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
    + `"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${body}</dict></plist>`;
}

function frame(entries, tag) {
  const payload = Buffer.from(plist({ ...entries, ClientVersionString: 'iRelay 2', ProgName: 'iRelay' }), 'utf8');
  const header = Buffer.alloc(16);
  header.writeUInt32LE(16 + payload.length, 0);
  header.writeUInt32LE(1, 4); // version: plist
  header.writeUInt32LE(8, 8); // message: plist
  header.writeUInt32LE(tag, 12);
  return Buffer.concat([header, payload]);
}

/// Connects to usbmux and exchanges one message; resolves with the socket
/// and the reply's XML text.
function exchange(entries, tag, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(MUX_PORT, '127.0.0.1');
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('usbmux timeout')); }, timeout);
    const onData = (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length < 16) return;
      const length = buffer.readUInt32LE(0);
      if (length < 16 || length > 16 * 1024 * 1024) { cleanup(); socket.destroy(); reject(new Error('usbmux: invalid reply')); return; }
      if (buffer.length < length) return;
      cleanup();
      const rest = buffer.subarray(length);
      if (rest.length) socket.unshift(rest);
      resolve({ socket, xml: buffer.subarray(16, length).toString('utf8') });
    };
    const onError = (error) => { cleanup(); reject(error); };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('connect', () => socket.write(frame(entries, tag)));
  });
}

/// The cabled devices: [{ id, serial }].
async function listDevices() {
  const { socket, xml } = await exchange({ MessageType: 'ListDevices' }, 1);
  socket.destroy();
  const devices = [];
  const entry = /<key>DeviceID<\/key>\s*<integer>(\d+)<\/integer>[\s\S]*?<key>Properties<\/key>\s*<dict>([\s\S]*?)<\/dict>/g;
  let match;
  while ((match = entry.exec(xml)) !== null) {
    const properties = match[2];
    const type = /<key>ConnectionType<\/key>\s*<string>([^<]*)<\/string>/.exec(properties);
    if (type && type[1] !== 'USB') continue;
    const serial = /<key>SerialNumber<\/key>\s*<string>([^<]*)<\/string>/.exec(properties);
    devices.push({ id: Number(match[1]), serial: serial ? serial[1] : '' });
  }
  return devices;
}

/// A raw TCP connection to `port` on the device, or an error when nothing listens there.
async function connect(deviceId, port) {
  const swapped = ((port & 0xff) << 8) | ((port >> 8) & 0xff); // network byte order
  const { socket, xml } = await exchange({ MessageType: 'Connect', DeviceID: deviceId, PortNumber: swapped }, 2);
  const number = /<key>Number<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
  if (!number || number[1] !== '0') {
    socket.destroy();
    const error = new Error(number && number[1] === '3' ? 'iDeck is not listening (open iDeck and turn on iRelay)' : 'usbmux refused the connection');
    error.code = 'EREFUSED';
    throw error;
  }
  socket.setNoDelay(true);
  return socket;
}

module.exports = { listDevices, connect };
