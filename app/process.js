'use strict';
// Steam downloads iDeck hands over (POST /process): for every chunk, the PC
// downloads it from Steam's content servers, decrypts, decompresses and checks
// it (steamchunk.js, in worker threads) and writes it into the game's file on
// the device (iDeck's PUT /write, which checks its SHA-1 again). iDeck follows
// GET /process/<id> and fetches whatever failed itself. Nothing is installed
// on Windows; chunks live only in memory.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');
const ServerSelector = require('./servers');

const NORMAL_IN_FLIGHT = 24;
// Acceleration has no byte-per-second limiter. Limit simultaneous buffers
// for reliability, not bandwidth; adapt parallel transfers to the PC.
const ACCELERATED_MIN_IN_FLIGHT = 64;
const ACCELERATED_MAX_IN_FLIGHT = 192;

// The worker's code: read here (it may live inside an asar archive, which
// worker threads cannot load from) and evaluated in each worker.
function workerSource() {
  const decoders = fs.readFileSync(path.join(__dirname, 'vendor', 'decoders.js'), 'utf8');
  const chunk = fs.readFileSync(path.join(__dirname, 'steamchunk.js'), 'utf8');
  return `
    const { parentPort } = require('worker_threads');
    function load(source) { const module = { exports: {} }; new Function('module', 'exports', 'require', source)(module, module.exports, require); return module.exports; }
    const decoders = load(${JSON.stringify(decoders)});
    const chunk = load(${JSON.stringify(chunk)});
    parentPort.on('message', ({ id, raw, key, size, crc, sha }) => {
      try {
        const out = chunk.decode(Buffer.from(raw), key, size, crc, sha, decoders);
        const copy = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
        parentPort.postMessage({ id, out: copy }, [copy]);
      } catch (error) {
        parentPort.postMessage({ id, error: String(error && error.message || error) });
      }
    });`;
}

/// A job iDeck has not asked about for this long is stopped.
const ABANDON_MS = 20000;

class Pool {
  constructor(size) {
    const source = workerSource();
    this.source = source;
    this.workers = [];
    this.pending = new Map();
    this.next = 0;
    this.resize(size);
  }

  resize(size) {
    this.size = size;
    while (this.workers.length < size) {
      const worker = new Worker(this.source, { eval: true });
      worker.busy = 0;
      worker.on('message', ({ id, out, error }) => {
        worker.busy -= 1;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (!pending) return;
        if (error) pending.reject(new Error(error)); else pending.resolve(Buffer.from(out));
      });
      this.workers.push(worker);
    }
  }

  decode(job) {
    const id = ++this.next;
    const worker = this.workers.slice(0, this.size).reduce((a, b) => (b.busy < a.busy ? b : a));
    worker.busy += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const raw = job.raw.buffer.slice(job.raw.byteOffset, job.raw.byteOffset + job.raw.length);
      worker.postMessage({ ...job, raw, id }, [raw]);
    });
  }
}

class Processor {
  constructor({ write, onChange, log, accelerated = false }) {
    this.write = write;   // (root, path, offset, size, sha, data) -> Promise
    this.onChange = onChange;
    this.log = log;
    this.jobs = new Map();
    this.pool = null;
    this.accelerated = accelerated === true;
    this.servers = new ServerSelector();
  }

  get concurrency() {
    if (!this.accelerated) return NORMAL_IN_FLIGHT;
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.min(ACCELERATED_MAX_IN_FLIGHT, Math.max(ACCELERATED_MIN_IN_FLIGHT, cpus * 12));
  }

  get workerCount() {
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(2, Math.min(this.accelerated ? 12 : 8, cpus - 1));
  }

  setAccelerated(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('Invalid download acceleration setting.');
    this.accelerated = enabled;
    if (this.pool) this.pool.resize(this.workerCount);
    for (const job of this.jobs.values()) if (job.pump) job.pump();
  }

  start(request) {
    this.pool = this.pool || new Pool(this.workerCount);
    const id = `${request.appId}-${Date.now().toString(36)}`;
    const queue = [];
    for (const depot of request.depots || []) {
      for (const file of depot.files || []) {
        for (const chunk of file.chunks || []) queue.push({ depot, file, chunk });
      }
    }
    const job = {
      id, appId: request.appId, name: request.name || `App ${request.appId}`, total: queue.length,
      totalBytes: queue.reduce((sum, item) => sum + item.chunk.size, 0),
      chunksDone: 0, bytesDone: 0, compressedDone: 0, failed: [], finished: false, cancelled: false,
      started: Date.now(), polled: Date.now(),
    };
    this.jobs.set(id, job);
    this.log(`processing ${job.name}: ${job.total} chunks`);
    this.run(job, queue).catch((error) => this.log(`processing ${job.name} stopped: ${error.message}`));
    this.onChange();
    return job;
  }

  async run(job, queue) {
    let next = 0;
    let active = 0;
    await new Promise((resolve) => {
      const pump = () => {
        if (Date.now() - job.polled > ABANDON_MS && !job.cancelled) {
          job.cancelled = true;
          this.log(`processing ${job.name} stopped: iDeck no longer follows it`);
        }
        while (next < queue.length && !job.cancelled && active < this.concurrency) {
          const item = queue[next++];
          active += 1;
          Promise.resolve().then(() => this.one(item)).then(() => {
            job.chunksDone += 1;
            job.bytesDone += item.chunk.size;
            job.compressedDone += item.chunk.compressed;
          }).catch((error) => {
            job.failed.push(item.chunk.sha);
            if (job.failed.length <= 5) this.log(`chunk ${item.chunk.sha.slice(0, 8)} of ${job.name}: ${error.message}`);
          }).finally(() => {
            active -= 1;
            pump();
          });
        }
        if (!active && (job.cancelled || next >= queue.length)) {
          delete job.pump;
          resolve();
        }
      };
      job.pump = pump;
      pump();
    });
    // Chunks never tried (cancelled) count as failed: iDeck fetches them.
    for (let i = next; i < queue.length; i += 1) job.failed.push(queue[i].chunk.sha);
    job.finished = true;
    job.ended = Date.now();
    this.log(`processed ${job.name}: ${job.chunksDone}/${job.total} chunks, ${job.failed.length} left to iDeck`);
    this.onChange();
  }

  async one({ depot, file, chunk }) {
    const raw = await this.download(depot, chunk.sha);
    const data = await this.pool.decode({ raw, key: depot.key, size: chunk.size, crc: chunk.crc, sha: chunk.sha });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.write(depot.root, file.path, chunk.offset, file.size, chunk.sha, data);
        return;
      } catch (error) {
        if (attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  async download(depot, sha) {
    const hosts = await this.servers.rank('steam', depot.hosts || []);
    if (!hosts.length) throw new Error('no content servers');
    const start = 0; // Always try the lowest-latency healthy CDN first.
    let last;
    for (let attempt = 0; attempt < Math.max(3, hosts.length); attempt += 1) {
      const original = hosts[(start + attempt) % hosts.length];
      const host = original.replace(/\/+$/, '');
      const auth = (depot.auth || {})[original] ?? (depot.auth || {})[host] ?? '';
      try {
        const response = await fetch(`${host}/depot/${depot.depotId}/chunk/${sha}${auth}`, {
          headers: { 'User-Agent': 'Valve/Steam HTTP Client 1.0' }, signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        last = error;
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    throw last;
  }

  rankServers(store, urls) {
    return this.servers.rank(store, urls);
  }

  status(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.polled = Date.now();
    return { finished: job.finished, chunksDone: job.chunksDone, bytesDone: job.bytesDone,
      compressedDone: job.compressedDone, failed: job.finished ? job.failed : [] };
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job && !job.cancelled) {
      job.cancelled = true;
      if (job.pump) job.pump();
      this.log(`processing ${job.name} stopped by iDeck`);
      this.onChange();
    }
  }

  /// For the Transfers view.
  list() {
    return [...this.jobs.values()].slice(-20).reverse().map((job) => ({
      id: job.id, appId: job.appId, name: job.name, total: job.total, done: job.chunksDone, failed: job.failed.length,
      bytes: job.bytesDone, totalBytes: job.totalBytes, finished: job.finished,
      seconds: ((job.ended || Date.now()) - job.started) / 1000,
    }));
  }
}

module.exports = Processor;
