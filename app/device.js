'use strict';
// iDeck's service on the iPad (port 27093), reached through usbmux. One HTTP
// request per connection (Connection: close).
const fs = require('fs');
const usbmux = require('./usbmux');

const SERVICE_PORT = 27093;


const http = require('http');
const MAX_DEVICE_SOCKETS = 8;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const agents = new Map();
const gates = new Map();

// Agent sockets are opened asynchronously by usbmux. Node's socket counter
// cannot include a socket until the connect callback runs, so use an explicit
// request gate to cap concurrent USB connections even during their handshakes.
function acquire(deviceId) {
  let gate = gates.get(deviceId);
  if (!gate) {
    gate = { active: 0, pending: [] };
    gates.set(deviceId, gate);
  }
  return new Promise((resolve, reject) => {
    const release = () => {
      gate.active -= 1;
      if (gate.pending.length) {
        const waiting = gate.pending.shift();
        gate.active += 1;
        waiting.resolve(release);
      }
    };
    if (gate.active < MAX_DEVICE_SOCKETS) {
      gate.active += 1;
      resolve(release);
    } else {
      gate.pending.push({ resolve, reject });
    }
  });
}

// Reuse a bounded set of trusted usbmux sockets. iDeck's service already
// supports HTTP/1.1 keep-alive, so there is no need to pair/connect the USB
// transport for every Steam chunk. The native HTTP client applies backpressure.
function agentFor(deviceId) {
  let agent = agents.get(deviceId);
  if (!agent) {
    agent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: MAX_DEVICE_SOCKETS,
      maxFreeSockets: MAX_DEVICE_SOCKETS,
      scheduling: 'lifo',
    });
    agent.createConnection = (_options, callback) => {
      usbmux.connect(deviceId, SERVICE_PORT).then(
        (socket) => callback(null, socket),
        (error) => callback(error)
      );
    };
    agents.set(deviceId, agent);
  }
  return agent;
}

function closeOtherConnections(activeDeviceId) {
  for (const [id, gate] of gates) {
    if (id === activeDeviceId) continue;
    for (const waiting of gate.pending) waiting.reject(new Error('USB device disconnected'));
    gate.pending.length = 0;
    gates.delete(id);
  }
  for (const [id, agent] of agents) {
    if (id === activeDeviceId) continue;
    agent.destroy();
    agents.delete(id);
  }
}

async function request(deviceId, method, path, { json, file, size, data, timeout = 120000 } = {}) {
  let body = null;
  if (json !== undefined) body = Buffer.from(JSON.stringify(json), 'utf8');
  else if (data !== undefined && data !== null) body = data;
  const length = file ? size : (body ? body.length : 0);
  if (!Number.isSafeInteger(length) || length < 0) {
    return Promise.reject(new Error('Invalid transfer length'));
  }
  if (file && body) return Promise.reject(new Error('Cannot send a file and an in-memory body together'));

  const release = await acquire(deviceId);
  try {
    return await new Promise((resolve, reject) => {
    let completed = false;
    const finish = (error, result) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else {
        // The HTTP Agent marks the socket reusable immediately after 'end'.
        // Defer the next request by one event-loop turn to avoid racing the
        // socket's transition from busy to free after large streamed uploads.
        setImmediate(() => resolve(result));
      }
    };
    const req = http.request({
      hostname: 'ideck',
      port: SERVICE_PORT,
      method, path,
      agent: agentFor(deviceId),
      headers: {
        'Content-Length': length,
        'Content-Type': json !== undefined ? 'application/json' : 'application/octet-stream',
        Connection: 'keep-alive',
      },
    }, (res) => {
      const chunks = [];
      let received = 0;
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('iDeck response exceeded the size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.once('error', (error) => finish(error));
      res.once('aborted', () => finish(new Error('The cable connection closed during the response')));
      res.once('end', () => {
        let parsed = {};
        try {
          const text = Buffer.concat(chunks, received).toString('utf8');
          parsed = text ? JSON.parse(text) : {};
        } catch { /* Keep compatibility with empty/older device responses. */ }
        if (res.statusCode >= 200 && res.statusCode < 300) finish(null, parsed);
        else finish(new Error(parsed.error || 'iDeck answered HTTP ' + res.statusCode));
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('iDeck did not answer in time')), timeout);
    req.once('error', (error) => finish(error));
    req.once('close', () => {
      if (!completed) finish(new Error('The cable connection closed'));
    });
    if (file) {
      // Stream directly to the USB socket using HTTP backpressure; there is
      // no multi-megabyte buffer or per-chunk Buffer.concat in JavaScript.
      const stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
      stream.once('error', (error) => req.destroy(error));
      req.once('close', () => stream.destroy());
      stream.pipe(req);
    } else {
      req.end(body);
    }
    });
  } finally {
    release();
  }
}

function query(params) {
  return Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
}

module.exports = {
  closeOtherConnections,
  info: (id) => request(id, 'GET', '/info', { timeout: 8000 }),
  install: (id, body) => request(id, 'POST', '/install', { json: body, timeout: 60000 }),
  installs: (id) => request(id, 'GET', '/installs', { timeout: 10000 }),
  controlDownload: (id, body) => request(id, 'POST', '/downloads/control', { json: body, timeout: 30000 }),
  write: (id, root, relative, offset, size, sha, data) =>
    request(id, 'PUT', `/write?${query({ root, path: relative, offset, size, sha })}`, { data, timeout: 30000 }),
  uninstall: (id, body) => request(id, 'POST', '/uninstall', { json: body, timeout: 120000 }),
  clearLogs: (id) => request(id, 'DELETE', '/logs', { timeout: 15000 }),
  logs: (id) => request(id, 'GET', '/logs', { timeout: 30000 }),
  library: (id) => request(id, 'GET', '/library', { timeout: 120000 }),
  steamDLC: (id, appId) => request(id, 'POST', `/steam/dlc?app=${appId}`, { json: {}, timeout: 120000 }),
  files: (id, root) => request(id, 'GET', `/files?${query({ root })}`, { timeout: 120000 }),
  upload: (id, root, relative, file, size, mtime) =>
    request(id, 'PUT', `/file?${query({ root, path: relative, mtime })}`, { file, size, timeout: 600000 }),
  remove: (id, root, relative) => request(id, 'DELETE', `/file?${query({ root, path: relative })}`),
  finish: (id, payload) => request(id, 'POST', '/finish', { json: payload, timeout: 60000 }),
};
