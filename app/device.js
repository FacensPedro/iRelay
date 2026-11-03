'use strict';
// iDeck's service on the iPad (port 27093), reached through usbmux. One HTTP
// request per connection (Connection: close).
const fs = require('fs');
const usbmux = require('./usbmux');

const SERVICE_PORT = 27093;

function request(deviceId, method, path, { json, file, size, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    usbmux.connect(deviceId, SERVICE_PORT).then((socket) => {
      let body = null;
      let length = 0;
      if (json !== undefined) {
        body = Buffer.from(JSON.stringify(json), 'utf8');
        length = body.length;
      } else if (file) {
        length = size;
      }
      const head = `${method} ${path} HTTP/1.1\r\nHost: ideck\r\nConnection: close\r\nContent-Length: ${length}\r\n`
        + (json !== undefined ? 'Content-Type: application/json\r\n' : '') + '\r\n';
      let response = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => fail(new Error('iDeck did not answer in time')), timeout);
      function fail(error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
      function check() {
        const end = response.indexOf('\r\n\r\n');
        if (end < 0) return;
        const header = response.subarray(0, end).toString('utf8');
        const status = Number((/^HTTP\/1\.1 (\d+)/.exec(header) || [])[1] || 0);
        const contentLength = Number((/content-length:\s*(\d+)/i.exec(header) || [])[1] || 0);
        if (response.length < end + 4 + contentLength) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        const text = response.subarray(end + 4, end + 4 + contentLength).toString('utf8');
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
        if (status >= 200 && status < 300) resolve(data);
        else reject(new Error(data.error || `iDeck answered HTTP ${status}`));
      }
      socket.on('data', (chunk) => { response = Buffer.concat([response, chunk]); check(); });
      socket.on('error', fail);
      socket.on('close', () => { if (!settled) fail(new Error('The cable connection closed')); });
      socket.write(head);
      if (body) socket.write(body);
      if (file) {
        const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
        stream.on('error', fail);
        stream.pipe(socket, { end: false });
      }
    }, reject);
  });
}

function query(params) {
  return Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

module.exports = {
  info: (id) => request(id, 'GET', '/info', { timeout: 8000 }),
  logs: (id) => request(id, 'GET', '/logs', { timeout: 30000 }),
  library: (id) => request(id, 'GET', '/library', { timeout: 120000 }),
  steamDLC: (id, appId) => request(id, 'POST', `/steam/dlc?app=${appId}`, { json: {}, timeout: 120000 }),
  files: (id, root) => request(id, 'GET', `/files?${query({ root })}`, { timeout: 120000 }),
  upload: (id, root, relative, file, size, mtime) =>
    request(id, 'PUT', `/file?${query({ root, path: relative, mtime })}`, { file, size, timeout: 600000 }),
  remove: (id, root, relative) => request(id, 'DELETE', `/file?${query({ root, path: relative })}`),
  finish: (id, payload) => request(id, 'POST', '/finish', { json: payload, timeout: 60000 }),
};
