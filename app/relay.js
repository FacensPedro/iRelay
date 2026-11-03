'use strict';
// While iDeck downloads a Steam game itself, it sends iRelay the chunks it
// still needs; the PC downloads them from the same content servers (at the
// PC's speed) and iDeck takes each one over the cable as soon as it arrives.
// The bytes are kept exactly as the content server sent them: iDeck checks and
// decrypts them, so no Steam account is needed here.
//
// iOS gives apps no USB networking, so iRelay opens the connections: it keeps
// a few open to iDeck's port 27091 (iDeck hands each to one of its requests)
// and joins each to this HTTP server on 127.0.0.1.
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const usbmux = require('./usbmux');

const LOCAL_PORT = 27090;
const DEVICE_PORT = 27091;
const IDLE = 6;
const SHA = /^[0-9a-f]{40}$/;

class Relay {
  constructor(cacheDir, onChange) {
    this.cacheDir = cacheDir;
    this.onChange = onChange;
    this.jobs = [];
    this.servers = new Map();   // depot -> { hosts, auth }
    this.inflight = new Map();  // key -> Promise<path|null>
    this.chunkJob = new Map();  // key -> job
    this.counted = new Set();
    this.delivered = new Set();
    this.queue = [];
    this.active = 0;
    this.parallel = 24;
    this.idle = new Map();      // device -> idle tunnels
    this.bytes = 0;
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }));
    this.server.keepAliveTimeout = 60000;
    this.server.listen(LOCAL_PORT, '127.0.0.1');
  }

  key(depot, sha) { return `${depot}/${sha}`; }
  file(depot, sha) { return path.join(this.cacheDir, String(depot), sha); }

  async handle(req, res) {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name: 'iRelay', version: 2, machine: require('os').hostname() }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/jobs') {
      const body = await new Promise((resolve, reject) => {
        const parts = [];
        let size = 0;
        req.on('data', (part) => { size += part.length; if (size > 256 * 1024 * 1024) req.destroy(); parts.push(part); });
        req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
        req.on('error', reject);
      });
      const job = this.startJob(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: job.total }));
      return;
    }
    const chunk = /^\/depot\/(\d+)\/chunk\/([0-9a-fA-F]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && chunk) {
      const depot = Number(chunk[1]);
      const sha = chunk[2].toLowerCase();
      const file = await this.ensure(depot, sha, true);
      if (!file) { res.writeHead(404); res.end(); return; }
      let data;
      try { data = await fs.promises.readFile(file); } catch { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': data.length });
      res.end(data, () => this.delivered_(depot, sha, file));
      return;
    }
    res.writeHead(404);
    res.end();
  }

  startJob(request) {
    const depots = Array.isArray(request.depots) ? request.depots : [];
    const total = depots.reduce((sum, depot) => sum + (depot.chunks || []).length, 0);
    for (const old of this.jobs.filter((job) => job.appId === request.appId)) old.cancelled = true;
    this.jobs = this.jobs.filter((job) => job.appId !== request.appId);
    const job = {
      id: `${request.appId}-${Date.now()}`, appId: request.appId, name: request.name || `App ${request.appId}`,
      total, downloaded: 0, sent: 0, failed: 0, bytes: 0, cancelled: false, started: Date.now(),
    };
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 20);
    for (const depot of depots) {
      this.servers.set(depot.depotId, { hosts: depot.hosts || [], auth: depot.auth || {} });
      for (const raw of depot.chunks || []) {
        const sha = String(raw).toLowerCase();
        if (!SHA.test(sha)) { job.failed += 1; continue; }
        const key = this.key(depot.depotId, sha);
        this.chunkJob.set(key, job);
        this.counted.delete(key);
        this.delivered.delete(key);
        this.queue.push({ depot: depot.depotId, sha, job });
      }
    }
    this.pump();
    this.onChange();
    return job;
  }

  pump() {
    while (this.active < this.parallel && this.queue.length) {
      const item = this.queue.shift();
      if (item.job.cancelled) continue;
      const key = this.key(item.depot, item.sha);
      if (this.delivered.has(key)) continue;
      this.active += 1;
      this.ensure(item.depot, item.sha, false).finally(() => { this.active -= 1; this.pump(); });
    }
  }

  count(key, bytes) {
    const job = this.chunkJob.get(key);
    if (!job || this.counted.has(key)) return;
    this.counted.add(key);
    job.downloaded += 1;
    job.bytes += bytes;
  }

  ensure(depot, sha) {
    const key = this.key(depot, sha);
    const file = this.file(depot, sha);
    if (fs.existsSync(file)) { this.count(key, 0); return Promise.resolve(file); }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const promise = this.download(depot, sha, file).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  async download(depot, sha, file) {
    const key = this.key(depot, sha);
    const server = this.servers.get(depot);
    if (!server || !server.hosts.length) return null;
    const attempts = Math.max(3, server.hosts.length);
    const start = parseInt(sha.slice(0, 8), 16) % server.hosts.length;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const original = server.hosts[(start + attempt) % server.hosts.length];
      const host = original.replace(/\/+$/, '');
      const auth = server.auth[original] ?? server.auth[host] ?? '';
      try {
        const response = await fetch(`${host}/depot/${depot}/chunk/${sha}${auth}`, {
          headers: { 'User-Agent': 'Valve/Steam HTTP Client 1.0' }, signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(`${file}.part`, data);
        await fs.promises.rename(`${file}.part`, file);
        this.bytes += data.length;
        this.count(key, data.length);
        return file;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    const job = this.chunkJob.get(key);
    if (job && !this.counted.has(key)) job.failed += 1;
    return null;
  }

  delivered_(depot, sha, file) {
    const key = this.key(depot, sha);
    this.delivered.add(key);
    const job = this.chunkJob.get(key);
    if (job) {
      this.count(key, 0);
      job.sent += 1;
      this.chunkJob.delete(key);
    }
    fs.promises.unlink(file).catch(() => {});
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

  clearCache() {
    for (const job of this.jobs) job.cancelled = true;
    this.queue = [];
    fs.rmSync(this.cacheDir, { recursive: true, force: true });
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }
}

module.exports = Relay;
