'use strict';

// Compare CDN hosts using a short HTTPS round-trip probe, not ICMP (which
// requires elevated privileges). Only official public CDN domains are tested.
// Full signed URLs and credentials are never sent in probes or written to logs.

const ALLOWED = {
  steam: ['steamcontent.com', 'steamstatic.com', 'akamaized.net'],
  gog: ['gog.com', 'gogcdn.net', 'gog-statics.com', 'akamaized.net', 'cloudfront.net'],
  epic: ['epicgames.com', 'akamaized.net', 'cloudfront.net', 'edgekey.net', 'fastly.net'],
};

class ServerSelector {
  constructor({ fetcher = globalThis.fetch, timeout = 1600, ttl = 300000 } = {}) {
    this.fetcher = fetcher;
    this.timeout = timeout;
    this.ttl = ttl;
    this.probes = new Map();
  }

  static origin(store, candidate) {
    if (!Object.hasOwn(ALLOWED, store)) return null;
    let url;
    try { url = new URL(candidate); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') ||
        /^\d+(\.\d+){3}$/.test(host)) return null;
    if (!ALLOWED[store].some((domain) => host === domain || host.endsWith('.' + domain))) return null;
    return 'https://' + host;
  }

  async latency(origin) {
    const cached = this.probes.get(origin);
    if (cached && cached.until > Date.now()) return cached.value;
    if (cached?.pending) return cached.pending;
    const pending = (async () => {
      const start = performance.now();
      try {
        // An authenticated CDN may return 403 or 404 at /, but a completed TLS
        // request still measures its network latency. A 5xx is not healthy.
        const response = await this.fetcher(origin + '/', {
          method: 'HEAD', redirect: 'manual', cache: 'no-store',
          signal: AbortSignal.timeout(this.timeout),
        });
        await response.body?.cancel?.();
        return response.status < 500 ? performance.now() - start : Infinity;
      } catch {
        return Infinity;
      }
    })();
    this.probes.set(origin, { pending, until: 0 });
    const value = await pending;
    this.probes.set(origin, { value, until: Date.now() + this.ttl });
    return value;
  }

  async rank(store, urls) {
    if (!Object.hasOwn(ALLOWED, store) || !Array.isArray(urls)) throw new TypeError('Invalid CDN selection request.');
    const input = urls.filter((url) => typeof url === 'string').slice(0, 24);
    const origins = input.map((url) => ServerSelector.origin(store, url));
    // Never contact arbitrary hosts or IPs, even if a device requests one.
    const unique = [...new Set(origins.filter(Boolean))];
    const timings = await Promise.all(unique.map(async (origin) => [origin, await this.latency(origin)]));
    const score = new Map(timings);
    // If every probe failed, keep the provider's own order.
    if (!timings.some(([, ms]) => Number.isFinite(ms))) return input;
    return input.map((url, index) => ({
      url, index, ms: score.get(origins[index]) ?? Infinity,
    })).sort((a, b) => a.ms - b.ms || a.index - b.index).map((item) => item.url);
  }
}

module.exports = ServerSelector;
