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

const IN_FLIGHT = 24;

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

class Pool {
  constructor(size) {
    const source = workerSource();
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(source, { eval: true });
      worker.busy = 0;
      worker.on('message', ({ id, out, error }) => {
        worker.busy -= 1;
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (!pending) return;
        if (error) pending.reject(new Error(error)); else pending.resolve(Buffer.from(out));
      });
      return worker;
    });
    this.pending = new Map();
    this.next = 0;
  }

  decode(job) {
    const id = ++this.next;
    const worker = this.workers.reduce((a, b) => (b.busy < a.busy ? b : a));
    worker.busy += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const raw = job.raw.buffer.slice(job.raw.byteOffset, job.raw.byteOffset + job.raw.length);
      worker.postMessage({ ...job, raw, id }, [raw]);
    });
  }
}

class Processor {
  constructor({ write, onChange, log }) {
    this.write = write;   // (root, path, offset, size, sha, data) -> Promise
    this.onChange = onChange;
    this.log = log;
    this.jobs = new Map();
    this.pool = null;
  }

  start(request) {
    this.pool = this.pool || new Pool(Math.max(2, Math.min(8, os.cpus().length - 1)));
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
      started: Date.now(),
    };
    this.jobs.set(id, job);
    this.log(`processing ${job.name}: ${job.total} chunks`);
    this.run(job, queue).catch((error) => this.log(`processing ${job.name} stopped: ${error.message}`));
    this.onChange();
    return job;
  }

  async run(job, queue) {
    let next = 0;
    const worker = async () => {
      while (next < queue.length && !job.cancelled) {
        const item = queue[next];
        next += 1;
        try {
          await this.one(item);
          job.chunksDone += 1;
          job.bytesDone += item.chunk.size;
          job.compressedDone += item.chunk.compressed;
        } catch (error) {
          job.failed.push(item.chunk.sha);
          if (job.failed.length <= 5) this.log(`chunk ${item.chunk.sha.slice(0, 8)} of ${job.name}: ${error.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: IN_FLIGHT }, worker));
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
    const hosts = depot.hosts || [];
    if (!hosts.length) throw new Error('no content servers');
    const start = parseInt(sha.slice(0, 8), 16) % hosts.length;
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

  status(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return { finished: job.finished, chunksDone: job.chunksDone, bytesDone: job.bytesDone,
      compressedDone: job.compressedDone, failed: job.finished ? job.failed : [] };
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (job) job.cancelled = true;
  }

  /// For the Transfers view.
  list() {
    return [...this.jobs.values()].slice(-20).reverse().map((job) => ({
      id: job.id, name: job.name, total: job.total, done: job.chunksDone, failed: job.failed.length,
      bytes: job.bytesDone, totalBytes: job.totalBytes, finished: job.finished,
      seconds: ((job.ended || Date.now()) - job.started) / 1000,
    }));
  }
}

module.exports = Processor;
