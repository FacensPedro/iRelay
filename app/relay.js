'use strict';
// The HTTP server iDeck reaches over the trusted USB cable. The Windows
// host no longer exposes its download control endpoints on loopback TCP:
// incoming usbmux sockets are handed directly to Node's HTTP parser.
// iRelay opens connections to iDeck's USB port 27091.
//
//   GET    /ping            name and version
//   POST   /process         a Steam download for this PC to process (process.js)
//   GET    /process/<id>    its progress; once finished, the chunks left to iDeck
//   DELETE /process/<id>    cancel
const http = require('http');
const os = require('os');
const usbmux = require('./usbmux');

const DEVICE_PORT = 27091;
// Three idle tunnels are enough for control messages. More idle USB sockets
// increase pressure on iDeck during a long transfer without improving throughput.
const IDLE = 3;
const MAX_RANK_REQUEST_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

async function readBody(req, limit) {
  const parts = [];
  let received = 0;
  for await (const part of req) {
    received += part.length;
    if (received > limit) {
      const error = new Error('Request body exceeds the permitted size');
      error.status = 413;
      throw error;
    }
    parts.push(part);
  }
  return Buffer.concat(parts, received).toString('utf8');
}

class Relay {
  constructor(processor, log) {
    this.processor = processor;
    this.log = log || (() => {});
    this.idle = new Map();
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(error.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }));
    this.server.headersTimeout = 15000;
    this.server.requestTimeout = 120000;
    this.server.keepAliveTimeout = 15000;
    this.server.on('error', (error) => this.log(`relay server: ${error.message}`));
    // Intentionally never listen() on a TCP port: only handed-off USB sockets
    // can reach /process, /servers/rank and the transfer control endpoints.
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && url.pathname === '/ping') {
      return json(200, { name: 'iRelay', version: 3, machine: os.hostname() });
    }
    if (req.method === 'POST' && url.pathname === '/servers/rank') {
      const body = await readBody(req, MAX_RANK_REQUEST_BYTES);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(400, { error: 'Invalid JSON' }); }
      if (!payload || !['steam', 'gog', 'epic'].includes(payload.store) ||
          !Array.isArray(payload.urls) || payload.urls.length > 24 ||
          !payload.urls.every((candidate) => typeof candidate === 'string' && candidate.length <= 512)) {
        return json(400, { error: 'Invalid server list' });
      }
      const ordered = await this.processor.rankServers(payload.store, payload.urls);
      return json(200, { urls: ordered });
    }
    if (req.method === 'POST' && url.pathname === '/process') {
      const body = await readBody(req, MAX_MANIFEST_BYTES);
      let manifest;
      try { manifest = JSON.parse(body); } catch { return json(400, { error: 'Invalid Steam manifest JSON' }); }
      if (!manifest || !Array.isArray(manifest.depots) || manifest.depots.length > 4096 ||
          !/^[0-9]+$/.test(String(manifest.appId ?? ''))) {
        return json(400, { error: 'Invalid Steam manifest' });
      }
      const job = this.processor.start(manifest);
      return json(200, { id: job.id, total: job.total });
    }
    const match = /^\/process\/([\w-]+)$/.exec(url.pathname);
    if (match && req.method === 'GET') {
      const status = this.processor.status(match[1]);
      return status ? json(200, status) : json(404, { error: 'unknown job' });
    }
    if (match && req.method === 'DELETE') {
      this.processor.cancel(match[1]);
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }

  /// Keeps a small number of cable connections available without starting
  /// overlapping usbmux connection bursts on successive 2-second polls.
  async tunnels(devices) {
    if (this.filling) return this.filling;
    this.filling = this.refill(devices);
    try { await this.filling; }
    finally { this.filling = null; }
  }

  async refill(devices) {
    for (const device of devices) {
      let idle = this.idle.get(device.id) || 0;
      while (idle < IDLE) {
        let socket;
        try { socket = await usbmux.connect(device.id, DEVICE_PORT); }
        catch { break; } // iDeck may be restarting or the USB port may be busy.
        idle += 1;
        this.idle.set(device.id, idle);
        this.serve(device.id, socket);
      }
    }
    for (const id of [...this.idle.keys()]) {
      if (!devices.some((device) => device.id === id)) this.idle.delete(id);
    }
  }

  serve(deviceId, socket) {
    let used = false;
    const release = () => {
      if (used) return;
      used = true;
      this.idle.set(deviceId, Math.max(0, (this.idle.get(deviceId) || 1) - 1));
    };
    socket.once('data', (first) => {
      release();
      socket.pause();
      if (!this.server) { socket.destroy(); return; }
      socket.unshift(first);
      this.server.emit('connection', socket);
      socket.resume();
    });
    socket.on('error', () => {});
    socket.on('close', release);
  }
}

module.exports = Relay;
