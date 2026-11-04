'use strict';
// The HTTP server iDeck reaches over the cable. iOS gives apps no USB
// networking, so iRelay opens the connections: it keeps a few open to iDeck's
// port 27091 (iDeck hands each to one of its requests) and joins each to this
// server on 127.0.0.1:27090.
//
//   GET    /ping            name and version
//   POST   /process         a Steam download for this PC to process (process.js)
//   GET    /process/<id>    its progress; once finished, the chunks left to iDeck
//   DELETE /process/<id>    cancel
const http = require('http');
const net = require('net');
const os = require('os');
const usbmux = require('./usbmux');

const LOCAL_PORT = 27090;
const DEVICE_PORT = 27091;
const IDLE = 6;

class Relay {
  constructor(processor, log) {
    this.processor = processor;
    this.log = log || (() => {});
    this.idle = new Map();
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((error) => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }));
    this.server.keepAliveTimeout = 60000;
    this.server.on('error', (error) => this.log(`relay server: ${error.message}`));
    this.server.listen(LOCAL_PORT, '127.0.0.1');
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
      const chunks = [];
      let received = 0;
      const body = await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          received += chunk.length;
          if (received > 16384) { reject(new Error('CDN selection request is too large')); req.destroy(); return; }
          chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
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
      const body = await new Promise((resolve, reject) => {
        const parts = [];
        let size = 0;
        req.on('data', (part) => { size += part.length; if (size > 512 * 1024 * 1024) req.destroy(); parts.push(part); });
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
      });
      const job = this.processor.start(JSON.parse(body));
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

  /// Keeps `IDLE` cable connections open to iDeck's port on each device.
  async tunnels(devices) {
    for (const device of devices) {
      let idle = this.idle.get(device.id) || 0;
      while (idle < IDLE) {
        let socket;
        try { socket = await usbmux.connect(device.id, DEVICE_PORT); } catch { break; }
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
      const local = net.connect(LOCAL_PORT, '127.0.0.1', () => {
        local.write(first);
        socket.pipe(local);
        local.pipe(socket);
        socket.resume();
      });
      local.on('error', () => socket.destroy());
      socket.on('close', () => local.destroy());
      local.on('close', () => socket.destroy());
    });
    socket.on('error', () => {});
    socket.on('close', release);
  }
}

module.exports = Relay;
