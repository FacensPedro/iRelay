'use strict';
// iDeck on the local network (Wi-Fi or Ethernet). iDeck listens on:
//   27093  its HTTP service (device.js); every request but GET /info carries
//          the pairing code shown in iDeck > Settings > iRelay
//   27091  connections iRelay opens for iDeck's own requests (relay.js); each
//          starts with "IRELAY <code>\n"
// A device is identified by its IPv4 address. Nothing listens on this PC, so
// Windows Firewall needs no rule.
const net = require('net');
const http = require('http');
const os = require('os');

const SERVICE_PORT = 27093;
const CONNECT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 700;
const PROBE_CONCURRENCY = 64;

/// A TCP connection to `port` on the iPad at `host`.
function connect(host, port) {
  return new Promise((resolve, reject) => {
    if (!isIPv4(host)) { reject(new Error('Invalid iPad address')); return; }
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error('iDeck did not answer on the local network')), CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10000);
      // Later errors reach the HTTP client or relay as a closed socket.
      socket.on('error', () => {});
      resolve(socket);
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function isIPv4(value) {
  return typeof value === 'string' && net.isIPv4(value);
}

/// Private IPv4 networks of this PC's active adapters, as /24 prefixes.
function localPrefixes() {
  const prefixes = new Set();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const [a, b] = entry.address.split('.').map(Number);
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      if (isPrivate) prefixes.add(entry.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...prefixes];
}

/// iDeck's unauthenticated GET /info on one address, or null.
function probe(host, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: SERVICE_PORT, path: '/info', timeout, agent: false }, (res) => {
      const parts = [];
      let size = 0;
      res.on('data', (part) => { size += part.length; if (size > 64 * 1024) req.destroy(); else parts.push(part); });
      res.on('end', () => {
        try {
          const info = JSON.parse(Buffer.concat(parts).toString('utf8'));
          resolve(info && info.app === 'iDeck' ? { host, ...info } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/// Every iDeck answering on this PC's local networks, plus `extra` addresses.
async function discover(extra = []) {
  const hosts = new Set(extra.filter(isIPv4));
  for (const prefix of localPrefixes()) for (let i = 1; i < 255; i += 1) hosts.add(`${prefix}.${i}`);
  const queue = [...hosts];
  const found = [];
  await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const info = await probe(queue.shift());
      if (info) found.push(info);
    }
  }));
  return found.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

/// "abcd-efgh" or "ABCDEFGH" to the 8-character code iDeck compares.
function normalizeCode(code) {
  const value = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z2-9]{8}$/.test(value) ? value : null;
}

module.exports = { SERVICE_PORT, connect, discover, probe, isIPv4, normalizeCode, localPrefixes };
