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
// Use limited CPU workers and an in-flight byte budget instead of hundreds of
// concurrent decompression buffers. No download bandwidth throttle is applied.
const ACCELERATED_MIN_IN_FLIGHT = 32;
const ACCELERATED_MAX_IN_FLIGHT = 64;
const IN_FLIGHT_BYTE_BUDGET = 64 * 1024 * 1024;
const MAX_ENCRYPTED_CHUNK = 32 * 1024 * 1024;
function estimatedMemory(chunk) {
  const size = Number(chunk.size);
  const compressed = Number(chunk.compressed);
  const decoded = Number.isFinite(size) && size > 0 ? size : 1024 * 1024;
  const encoded = Number.isFinite(compressed) && compressed > 0 ? compressed : decoded;
  return Math.max(64 * 1024, decoded * 2 + encoded * 2);
}

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
// Give iDeck time to recover from temporary USB interruptions without
// discarding all the verified PC chunks. iDeck also retries job polling.
const ABANDON_MS = 90000;
const USB_WRITE_RETRY_WINDOW_MS = 90000;

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
  constructor({ write, onChange, log, accelerated = false, fetcher = globalThis.fetch }) {
    this.fetcher = fetcher;
    this.write = write;   // (root, path, offset, size, sha, data) -> Promise
    this.onChange = onChange;
    this.log = log;
    this.jobs = new Map();
    this.pool = null;
    this.accelerated = accelerated === true;
    this.servers = new ServerSelector();
    // Shared by concurrent Steam chunks: one overloaded CDN host should not
    // receive another burst of requests until its cooldown has expired.
    this.cdnCooldownUntil = new Map();
    this.cdnOutageLogged = false;
  }

  get concurrency() {
    if (!this.accelerated) return NORMAL_IN_FLIGHT;
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.min(ACCELERATED_MAX_IN_FLIGHT, Math.max(ACCELERATED_MIN_IN_FLIGHT, cpus * 4));
  }

  get workerCount() {
    const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(2, Math.min(this.accelerated ? 4 : 2, cpus - 1));
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
    job.completion = this.run(job, queue).catch((error) => {
      job.finished = true;
      this.log(`processing ${job.name} stopped: ${error.message}`);
    });
    this.onChange();
    return job;
  }

  async run(job, queue) {
    let next = 0;
    let active = 0;
    let activeBytes = 0;
    await new Promise((resolve) => {
      const pump = () => {
        if (Date.now() - job.polled > ABANDON_MS && !job.cancelled) {
          job.cancelled = true;
          this.log(`processing ${job.name} stopped: iDeck no longer follows it`);
        }
        while (next < queue.length && !job.cancelled && active < this.concurrency) {
          const item = queue[next];
          const bytes = estimatedMemory(item.chunk);
          // A single large chunk may exceed the budget, but never start a
          // second one until its memory has been released.
          if (active > 0 && activeBytes + bytes > IN_FLIGHT_BYTE_BUDGET) break;
          next += 1;
          active += 1;
          activeBytes += bytes;
          Promise.resolve().then(() => this.one(item, job)).then(() => {
            job.chunksDone += 1;
            job.bytesDone += item.chunk.size;
            job.compressedDone += item.chunk.compressed;
          }).catch((error) => {
            job.failed.push(item.chunk.sha);
            if (job.failed.length <= 5) this.log(`chunk ${item.chunk.sha.slice(0, 8)} of ${job.name}: ${error.message}`);
          }).finally(() => {
            active -= 1;
            activeBytes -= bytes;
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

  async one({ depot, file, chunk }, job) {
    if (job.cancelled) throw new Error('Transfer stopped');
    const raw = await this.download(depot, chunk.sha);
    if (job.cancelled) throw new Error('Transfer stopped');
    const data = await this.pool.decode({ raw, key: depot.key, size: chunk.size, crc: chunk.crc, sha: chunk.sha });
    // Keep the already-verified chunk in memory while the iPad's USB service
    // restarts. Limit the retry window and back off to prevent connect storms.
    const deadline = Date.now() + USB_WRITE_RETRY_WINDOW_MS;
    for (let attempt = 1; ; attempt += 1) {
      if (job.cancelled) throw new Error('Transfer stopped');
      try {
        await this.write(depot.root, file.path, chunk.offset, file.size, chunk.sha, data);
        if (job.usbFailureLogged && !job.usbRecoveryLogged) {
          job.usbRecoveryLogged = true;
          this.log(`USB transfer resumed for ${job.name}`);
        }
        return;
      } catch (error) {
        if (job.cancelled) throw new Error('Transfer stopped');
        // Integrity, invalid path and storage errors remain non-retryable.
        // A failed response can happen after a valid write: iDeck checks the
        // SHA-1 again, making writing the same chunk at the same offset safe.
        const message = String(error?.message || error);
        if (/SHA-1 mismatch|invalid transfer|invalid path|HTTP 400|HTTP 403|HTTP 409|HTTP 422|HTTP 507/i.test(message) ||
            Date.now() >= deadline) throw error;
        if (!job.usbFailureLogged) {
          job.usbFailureLogged = true;
          this.log(`USB interrupted while transferring ${job.name}; waiting for reconnection`);
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(4000, 500 * Math.min(attempt, 8))));
      }
    }
  }

  async download(depot, sha) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
      throw new Error('Invalid Steam chunk digest');
    }
    if (!/^[0-9]+$/.test(String(depot.depotId ?? ''))) {
      throw new Error('Invalid Steam depot ID');
    }
    const approved = (depot.hosts || []).filter((url) => ServerSelector.origin('steam', url) !== null);
    if (!approved.length) throw new Error('No verified HTTPS Steam content servers');
    const hosts = [...new Set(await this.servers.rank('steam', approved))];
    const maxAttempts = Math.min(24, Math.max(6, hosts.length * 3));
    let last;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const now = Date.now();
      const ready = hosts.filter((host) => (this.cdnCooldownUntil.get(host) || 0) <= now);
      if (!ready.length) {
        const until = Math.min(...hosts.map((host) => this.cdnCooldownUntil.get(host) || now));
        // All servers declined requests temporarily. Do not flood them with
        // simultaneous failed retries; honor the shortest capped cooldown.
        await new Promise((resolve) => setTimeout(resolve, Math.min(10000, Math.max(100, until - now))));
        continue;
      }
      const original = ready[attempt % ready.length];
      const origin = ServerSelector.origin('steam', original);
      const auth = (depot.auth || {})[original] ?? (depot.auth || {})[origin] ?? '';
      if (typeof auth !== 'string' || auth.length > 4096 || (auth && (!auth.startsWith('?') || /[\r\n]/.test(auth)))) {
        throw new Error('Invalid Steam content server authorization');
      }
      try {
        const response = await this.fetcher(`${origin}/depot/${depot.depotId}/chunk/${sha}${auth}`, {
          headers: { 'User-Agent': 'Valve/Steam HTTP Client 1.0' },
          redirect: 'error', // Do not redirect authenticated chunk URLs.
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) {
          await response.body?.cancel?.();
          if ([429, 500, 502, 503, 504].includes(response.status)) {
            const retryHeader = response.headers?.get?.('retry-after');
            const seconds = retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : 0;
            const delay = Math.min(10000, Math.max(800 * Math.min(attempt + 1, 5), seconds * 1000));
            this.cdnCooldownUntil.set(original, Date.now() + delay);
            if (response.status === 503 && !this.cdnOutageLogged) {
              this.cdnOutageLogged = true;
              this.log('Steam content server returned HTTP 503; rotating CDN hosts and retrying');
            }
          }
          throw new Error(`HTTP ${response.status}`);
        }
        this.cdnCooldownUntil.delete(original);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_ENCRYPTED_CHUNK) {
          await response.body?.cancel?.();
          throw new Error('Steam encrypted chunk exceeds the size limit');
        }
        if (!response.body) {
          const data = Buffer.from(await response.arrayBuffer());
          if (data.length > MAX_ENCRYPTED_CHUNK) throw new Error('Steam encrypted chunk exceeds the size limit');
          return data;
        }
        const parts = [];
        let received = 0;
        for await (const part of response.body) {
          received += part.length;
          if (received > MAX_ENCRYPTED_CHUNK) throw new Error('Steam encrypted chunk exceeds the size limit');
          parts.push(Buffer.from(part));
        }
        return Buffer.concat(parts, received);
      } catch (error) {
        last = error;
        if (attempt + 1 < maxAttempts && (this.cdnCooldownUntil.get(original) || 0) <= Date.now()) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * (attempt + 1))));
        }
      }
    }
    throw last || new Error('Steam CDN hosts remained unavailable after retrying');
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

  // Stop all PC-side work for the same Steam app and wait until writes have
  // settled before the device removes its owned partial install directory.
  async cancelApp(appId) {
    const matches = [...this.jobs.values()].filter((job) =>
      String(job.appId) === String(appId) && !job.finished);
    for (const job of matches) this.cancel(job.id);
    await Promise.all(matches.map((job) => job.completion));
    return matches.length;
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
