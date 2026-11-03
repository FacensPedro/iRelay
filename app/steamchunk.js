'use strict';
// One Steam chunk as a content server sends it -> the file bytes it stands
// for (the same pipeline as iDeck's ContentDecryptor): AES-256 (the IV is the
// first 16 bytes, ECB-decrypted; the rest is CBC with PKCS7), then one of
// Steam's containers: "VSZa" (zstd), "VZa" (LZMA), a one-entry PKZip, or
// stored. The result is checked against the manifest's size, Adler-32 (seeded
// with 0) and SHA-1. Runs in worker threads (process.js); `decoders` is
// app/vendor/decoders.js.

function adler32(data) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 3800, data.length);
    for (; i < end; i += 1) { a += data[i]; b += a; }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function lzma(props, body, size, decoders) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(size >>> 0, 0);
  return Buffer.from(decoders.lzmaDecompress(Buffer.concat([props, header, body])));
}

function decode(raw, keyHex, size, crc, sha, decoders) {
  const crypto = require('crypto');
  const zlib = require('zlib');
  const key = Buffer.from(keyHex, 'hex');
  if (raw.length < 32 || (raw.length - 16) % 16 !== 0) throw new Error('not an AES payload');
  const ecb = crypto.createDecipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const iv = Buffer.concat([ecb.update(raw.subarray(0, 16)), ecb.final()]);
  const cbc = crypto.createDecipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([cbc.update(raw.subarray(16)), cbc.final()]);
  let out;
  if (data.length > 23 && data[0] === 0x56 && data[1] === 0x53 && data[2] === 0x5a && data[3] === 0x61) {
    out = Buffer.from(decoders.zstdDecompress(data.subarray(8, data.length - 15)));
  } else if (data.length > 22 && data[0] === 0x56 && data[1] === 0x5a) {
    const footerSize = data.readUInt32LE(data.length - 6);
    out = lzma(data.subarray(7, 12), data.subarray(12, data.length - 10), footerSize, decoders);
  } else if (data.length >= 30 && data.readUInt32LE(0) === 0x04034b50) {
    const method = data.readUInt16LE(8);
    let compressed = data.readUInt32LE(18);
    const start = 30 + data.readUInt16LE(26) + data.readUInt16LE(28);
    if (!compressed) compressed = data.length - start;
    const body = data.subarray(start, start + compressed);
    if (method === 0) out = Buffer.from(body);
    else if (method === 8) out = zlib.inflateRawSync(body);
    else if (method === 14) {
      const propsSize = body.readUInt16LE(2);
      out = lzma(body.subarray(4, 4 + propsSize), body.subarray(4 + propsSize), size, decoders);
    } else throw new Error(`zip method ${method}`);
  } else if (data.length === size) {
    out = data;
  } else {
    throw new Error('unknown chunk format');
  }
  if (out.length !== size) throw new Error(`size ${out.length} != ${size}`);
  if (crc && adler32(out) !== crc) throw new Error('checksum mismatch');
  if (crypto.createHash('sha1').update(out).digest('hex') !== sha) throw new Error('SHA-1 mismatch');
  return out;
}

module.exports = { decode, adler32 };
